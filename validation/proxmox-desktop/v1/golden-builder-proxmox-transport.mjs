import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { canonicalJsonV1, sha256V1 } from "./build-golden-image.mjs";
import { validateGoldenBuilderLifecycleBindingV1 } from "./prepare-golden-builder.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4})$/u;
const PROVIDER_USER = "nelos-golden-provider";
const ATTESTOR_USER = "nelos-golden-attestor";
const PROXMOX_SSH_HOST = "192.168.1.110";
const PROXMOX_SSH_FINGERPRINT = "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg";
const PROVIDER_HELPER = "/usr/libexec/nelos-proxmox-golden-builder-helper provider request";
const ATTESTOR_HELPER = "/usr/libexec/nelos-proxmox-golden-builder-helper attestor request";
const OPERATIONS = new Set(["confirm-absent", "destroy", "observe", "preflight", "provision", "quarantine", "stop"]);
const MUTATIONS = new Set(["destroy", "provision", "quarantine", "stop"]);
const CLEANUP_OPERATIONS = new Set(["confirm-absent", "destroy", "observe", "quarantine", "stop"]);
const MAC_ADDRESS = /^02(?::[0-9A-F]{2}){5}$/u;

export class GoldenBuilderTransportError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "GoldenBuilderTransportError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) { throw new GoldenBuilderTransportError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${label} fields differ from the closed contract`);
  return value;
}
function text(value, pattern, label, maximum = 4_096) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail("INVALID_CONTRACT", `${label} is invalid`);
  return value;
}
function openSshFingerprint(publicKey) {
  const fields = typeof publicKey === "string" ? publicKey.trim().split(/\s+/u) : [];
  if (fields.length < 2 || fields[0] !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(fields[1])) return null;
  let bytes;
  try { bytes = Buffer.from(fields[1], "base64"); } catch { return null; }
  if (bytes.length !== 51 || bytes.toString("base64") !== fields[1]) return null;
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/u, "")}`;
}

export function validateGoldenBuilderTransportAccessV1(value) {
  exact(value, ["attestor", "helperDigest", "host", "kind", "limits", "provider", "schemaVersion"], "builderTransportAccess");
  if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-builder-transport-access" || !SHA256.test(value.helperDigest ?? "")) fail("INVALID_CONTRACT", "builder transport access identity is unsupported");
  exact(value.host, ["hostFingerprint", "hostPublicKey", "knownHostsFile", "sshHost", "sshPort"], "builderTransportAccess.host");
  exact(value.limits, ["maxOutputBytes", "operationTimeoutMs", "transportAttempts"], "builderTransportAccess.limits");
  for (const role of ["provider", "attestor"]) {
    exact(value[role], ["identityFile", "publicKey", "publicKeyFingerprint", "sshUser"], `builderTransportAccess.${role}`);
    const expectedUser = role === "provider" ? PROVIDER_USER : ATTESTOR_USER;
    if (value[role].sshUser !== expectedUser || !isAbsolute(value[role].identityFile) || resolve(value[role].identityFile) !== value[role].identityFile || /[\0\r\n]/u.test(value[role].identityFile) ||
        !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [\x20-\x7e]{1,256})?$/u.test(value[role].publicKey ?? "") ||
        openSshFingerprint(value[role].publicKey) !== value[role].publicKeyFingerprint || !SSH_FINGERPRINT.test(value[role].publicKeyFingerprint ?? "")) {
      fail("INVALID_CONTRACT", `${role} SSH identity differs from the closed transport contract`);
    }
  }
  if (!HOST.test(value.host.sshHost ?? "") || value.host.sshHost !== PROXMOX_SSH_HOST || value.host.sshPort !== 22 ||
      !isAbsolute(value.host.knownHostsFile) || resolve(value.host.knownHostsFile) !== value.host.knownHostsFile || /[\0\r\n]/u.test(value.host.knownHostsFile) ||
      openSshFingerprint(value.host.hostPublicKey) !== value.host.hostFingerprint || value.host.hostFingerprint !== PROXMOX_SSH_FINGERPRINT) {
    fail("INVALID_CONTRACT", "pinned Proxmox SSH host identity is invalid");
  }
  if (value.provider.identityFile === value.attestor.identityFile || value.provider.publicKeyFingerprint === value.attestor.publicKeyFingerprint ||
      new Set([value.provider.publicKeyFingerprint, value.attestor.publicKeyFingerprint]).has(value.host.hostFingerprint)) {
    fail("INDEPENDENT_ATTESTOR_REQUIRED", "provider, attestor, and host identities must be distinct");
  }
  if (!Number.isSafeInteger(value.limits.operationTimeoutMs) || value.limits.operationTimeoutMs < 1_000 || value.limits.operationTimeoutMs > 600_000 ||
      !Number.isSafeInteger(value.limits.maxOutputBytes) || value.limits.maxOutputBytes < 1_024 || value.limits.maxOutputBytes > 16_777_216 ||
      !Number.isSafeInteger(value.limits.transportAttempts) || value.limits.transportAttempts < 1 || value.limits.transportAttempts > 3) {
    fail("INVALID_CONTRACT", "builder transport limits are invalid");
  }
  return value;
}

export function createGoldenBuilderHostBindingV1({ lifecycleBinding, reservation, access }, { now = Date.now(), allowExpiredForCleanup = false } = {}) {
  const binding = validateGoldenBuilderLifecycleBindingV1(lifecycleBinding, reservation, { now, allowExpiredForCleanup });
  validateGoldenBuilderTransportAccessV1(access);
  if (new Set([access.provider.publicKeyFingerprint, access.attestor.publicKeyFingerprint, access.host.hostFingerprint]).has(binding.builderVm.sshPublicKeyFingerprint)) {
    fail("INVALID_CONTRACT", "builder guest, provider, attestor, and host SSH identities must be distinct");
  }
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-golden-builder-host-binding",
    lifecycleBinding: structuredClone(binding),
    helperDigest: access.helperDigest,
    providerPublicKey: access.provider.publicKey.trim(),
    providerKeyFingerprint: access.provider.publicKeyFingerprint,
    providerUser: PROVIDER_USER,
    attestorPublicKey: access.attestor.publicKey.trim(),
    attestorKeyFingerprint: access.attestor.publicKeyFingerprint,
    attestorUser: ATTESTOR_USER,
    expiresAt: binding.expiresAt,
    cleanupExpiresAt: binding.cleanupExpiresAt,
  };
  return { ...unsigned, hostBindingDigest: sha256V1(unsigned) };
}

export function validateGoldenBuilderHostBindingV1(value, { lifecycleBinding, reservation, access, now = Date.now(), allowExpiredForCleanup = false } = {}) {
  exact(value, ["attestorKeyFingerprint", "attestorPublicKey", "attestorUser", "cleanupExpiresAt", "expiresAt", "helperDigest", "hostBindingDigest", "kind", "lifecycleBinding", "providerKeyFingerprint", "providerPublicKey", "providerUser", "schemaVersion"], "builderHostBinding");
  const recreated = createGoldenBuilderHostBindingV1({ lifecycleBinding, reservation, access }, { now, allowExpiredForCleanup });
  if (canonicalJsonV1(value) !== canonicalJsonV1(recreated)) fail("INVALID_CONTRACT", "builder host binding digest or identity differs");
  return value;
}

export function createGoldenBuilderHostInstallPlanV1({ hostBinding, access }) {
  validateGoldenBuilderTransportAccessV1(access);
  if (!plain(hostBinding) || Object.keys(hostBinding).sort().join("\0") !== ["attestorKeyFingerprint", "attestorPublicKey", "attestorUser", "cleanupExpiresAt", "expiresAt", "helperDigest", "hostBindingDigest", "kind", "lifecycleBinding", "providerKeyFingerprint", "providerPublicKey", "providerUser", "schemaVersion"].sort().join("\0") ||
      hostBinding.hostBindingDigest !== sha256V1(Object.fromEntries(Object.entries(hostBinding).filter(([key]) => key !== "hostBindingDigest"))) ||
      hostBinding.providerPublicKey !== access.provider.publicKey.trim() || hostBinding.attestorPublicKey !== access.attestor.publicKey.trim() ||
      hostBinding.providerKeyFingerprint !== access.provider.publicKeyFingerprint || hostBinding.attestorKeyFingerprint !== access.attestor.publicKeyFingerprint ||
      hostBinding.helperDigest !== access.helperDigest) {
    fail("INVALID_CONTRACT", "builder host binding is invalid");
  }
  const hostName = access.host.sshPort === 22 ? access.host.sshHost : `[${access.host.sshHost}]:${access.host.sshPort}`;
  const forced = (role, helper) => `restrict,command="/usr/bin/sudo -n -- ${helper}" ${access[role].publicKey.trim()} nelos:${role}:${hostBinding.hostBindingDigest.slice(7, 23)}\n`;
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-golden-builder-host-install-plan",
    hostBindingDigest: hostBinding.hostBindingDigest,
    hostBindingPath: "/etc/nelos-golden/builder-host-binding.json",
    helperDigest: hostBinding.helperDigest,
    helperPath: "/usr/libexec/nelos-proxmox-golden-builder-helper",
    knownHostsLine: `${hostName} ${access.host.hostPublicKey.trim().split(/\s+/u).slice(0, 2).join(" ")}\n`,
    principals: [
      { role: "provider", user: PROVIDER_USER, home: "/var/lib/nelos-golden-provider", shell: "/bin/sh", authorizedKeysPath: "/var/lib/nelos-golden-provider/.ssh/authorized_keys", authorizedKey: forced("provider", PROVIDER_HELPER), sudoersPath: "/etc/sudoers.d/nelos-golden-builder-provider", sudoers: `${PROVIDER_USER} ALL=(root) NOPASSWD: /usr/libexec/nelos-proxmox-golden-builder-helper provider request\n` },
      { role: "attestor", user: ATTESTOR_USER, home: "/var/lib/nelos-golden-attestor", shell: "/bin/sh", authorizedKeysPath: "/var/lib/nelos-golden-attestor/.ssh/authorized_keys", authorizedKey: forced("attestor", ATTESTOR_HELPER), sudoersPath: "/etc/sudoers.d/nelos-golden-builder-attestor", sudoers: `${ATTESTOR_USER} ALL=(root) NOPASSWD: /usr/libexec/nelos-proxmox-golden-builder-helper attestor request\n` },
    ],
  };
  return { ...unsigned, planDigest: sha256V1(unsigned) };
}

function operationId(bindingDigest, operation) {
  return sha256V1({ schemaVersion: 1, kind: "nelos-golden-builder-operation", bindingDigest, operation });
}

function requestEnvelope(binding, role, operation, requestedAt, deadlineAt) {
  const bindingDigest = binding.bindingDigest;
  return {
    schemaVersion: 1,
    kind: "nelos-golden-builder-provider-request",
    role,
    operation,
    operationId: operationId(bindingDigest, operation),
    bindingDigest,
    requestedAt: new Date(requestedAt).toISOString(),
    deadlineAt: new Date(deadlineAt).toISOString(),
  };
}

function validateReceipt(value, envelope) {
  try { exact(value, ["bindingDigest", "kind", "observedAt", "operation", "operationId", "payload", "payloadDigest", "providerOperationId", "receiptDigest", "role", "schemaVersion", "status"], "builderProviderReceipt"); }
  catch { fail("PROVIDER_RECEIPT_INVALID", "builder provider receipt fields differ from the closed contract"); }
  const { receiptDigest, ...unsigned } = value;
  if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-builder-provider-receipt" || value.role !== envelope.role || value.operation !== envelope.operation ||
      value.operationId !== envelope.operationId || value.bindingDigest !== envelope.bindingDigest || !plain(value.payload) || value.payloadDigest !== sha256V1(value.payload) ||
      receiptDigest !== sha256V1(unsigned) || !SHA256.test(receiptDigest) || !Number.isFinite(Date.parse(value.observedAt))) {
    fail("PROVIDER_RECEIPT_INVALID", "builder provider receipt identity, payload, or digest differs");
  }
  const observedAt = Date.parse(value.observedAt);
  if ((!MUTATIONS.has(envelope.operation) && observedAt < Date.parse(envelope.requestedAt) - 1_000) || observedAt > Date.parse(envelope.deadlineAt) + 1_000) fail("PROVIDER_RECEIPT_INVALID", "builder provider receipt is outside the admitted request window");
  if (MUTATIONS.has(envelope.operation)) {
    if (!new Set(["ambiguous", "committed", "failed", "quarantined"]).has(value.status) ||
        (value.status === "committed" && (typeof value.providerOperationId !== "string" || value.providerOperationId.length < 1 || value.providerOperationId.length > 512))) {
      fail("PROVIDER_RECEIPT_INVALID", "builder mutation receipt state is invalid");
    }
  } else if (value.status !== "observed" || value.providerOperationId !== null) fail("PROVIDER_RECEIPT_INVALID", "builder observation receipt state is invalid");
  return value;
}

function validatePreflightPayload(payload, binding) {
  exact(payload, ["inventory", "networkInventory", "sourceConfig", "sourceStatus", "storage", "storageContent", "vnet"], "preflight payload");
  if (!Array.isArray(payload.inventory) || !plain(payload.sourceConfig) || !plain(payload.sourceStatus) || !plain(payload.storage) || !Array.isArray(payload.storageContent) || !plain(payload.vnet)) {
    fail("PROVIDER_RECEIPT_INVALID", "builder preflight payload is malformed");
  }
  exact(payload.networkInventory, ["complete", "digest", "scannedVms"], "preflight payload.networkInventory");
  if (payload.networkInventory.complete !== true || !Array.isArray(payload.networkInventory.scannedVms) ||
      payload.networkInventory.digest !== sha256V1({ complete: true, scannedVms: payload.networkInventory.scannedVms })) {
    fail("PROVIDER_RECEIPT_INVALID", "cluster network inventory is incomplete or has an invalid digest");
  }
  const expected = payload.inventory.filter((item) => item?.type === "qemu").map((item) => `${item.node}\0${Number(item.vmid)}`).sort();
  const observed = [];
  const macs = [];
  for (const [index, item] of payload.networkInventory.scannedVms.entries()) {
    exact(item, ["configDigest", "macAddresses", "node", "vmId"], `preflight payload.networkInventory.scannedVms[${index}]`);
    if (typeof item.node !== "string" || !Number.isSafeInteger(item.vmId) || !SHA256.test(item.configDigest ?? "") || !Array.isArray(item.macAddresses) ||
        item.macAddresses.some((mac) => !MAC_ADDRESS.test(mac)) || [...item.macAddresses].sort().join("\0") !== item.macAddresses.join("\0") || new Set(item.macAddresses).size !== item.macAddresses.length) {
      fail("PROVIDER_RECEIPT_INVALID", "cluster network inventory entry is malformed");
    }
    observed.push(`${item.node}\0${item.vmId}`); macs.push(...item.macAddresses);
  }
  if (observed.sort().join("\0") !== expected.join("\0") || new Set(observed).size !== observed.length) {
    fail("PROVIDER_RECEIPT_INVALID", "cluster network inventory does not cover every QEMU VM exactly once");
  }
  if (macs.includes(binding.builderVm.mac) || macs.includes(binding.outputTemplateMacAddress)) {
    fail("RESOURCE_COLLISION", "reserved builder or output MAC is already present cluster-wide");
  }
  return payload;
}

function validateObservationPayload(payload) {
  exact(payload, ["config", "guest", "status"], "observation payload");
  if (payload.status === "absent") {
    if (payload.config !== null || payload.guest !== null) fail("PROVIDER_RECEIPT_INVALID", "absent builder observation includes state");
    return payload;
  }
  if (!plain(payload.config) || !plain(payload.guest)) fail("PROVIDER_RECEIPT_INVALID", "builder observation is malformed");
  exact(payload.guest, ["architecture", "cloudInitStatus", "hostKeyFingerprint", "hostPublicKey", "operatingSystem", "qga", "release", "sshAddress"], "observation payload.guest");
  return payload;
}

function validateAbsencePayload(payload) {
  exact(payload, ["inventoryDigest", "nameAbsent", "storageContentDigest", "vmAbsent", "volumesAbsent"], "absence payload");
  if (![payload.vmAbsent, payload.nameAbsent, payload.volumesAbsent].every((item) => typeof item === "boolean") ||
      !SHA256.test(payload.inventoryDigest ?? "") || !SHA256.test(payload.storageContentDigest ?? "")) {
    fail("PROVIDER_RECEIPT_INVALID", "independent absence payload is malformed");
  }
  return payload;
}

export class ProxmoxGoldenBuilderAdapterV1 {
  constructor({ lifecycleBinding, reservation, providerTransport, attestorTransport, receiptStore, clock = Date, operationTimeoutMs = 300_000, transportAttempts = 2, allowExpiredForCleanup = false } = {}) {
    if (typeof allowExpiredForCleanup !== "boolean") fail("INVALID_ADAPTER", "builder cleanup validation mode is invalid");
    this.binding = validateGoldenBuilderLifecycleBindingV1(lifecycleBinding, reservation, { now: clock.now(), allowExpiredForCleanup });
    if (typeof providerTransport?.request !== "function" || typeof attestorTransport?.request !== "function" || providerTransport === attestorTransport ||
        !SSH_FINGERPRINT.test(providerTransport?.identityFingerprint ?? "") || !SSH_FINGERPRINT.test(attestorTransport?.identityFingerprint ?? "") ||
        providerTransport.identityFingerprint === attestorTransport.identityFingerprint) fail("INDEPENDENT_ATTESTOR_REQUIRED", "distinct identity-bound provider and attestor transports are required");
    if (typeof receiptStore?.commit !== "function" || typeof clock?.now !== "function" || !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1_000 || operationTimeoutMs > 600_000 || !Number.isSafeInteger(transportAttempts) || transportAttempts < 1 || transportAttempts > 3) fail("INVALID_ADAPTER", "builder adapter boundary or limits are invalid");
    this.providerTransport = providerTransport;
    this.attestorTransport = attestorTransport;
    this.receiptStore = receiptStore;
    this.clock = clock;
    this.operationTimeoutMs = operationTimeoutMs;
    this.transportAttempts = transportAttempts;
  }

  #deadline(operation) {
    const expiry = Date.parse(CLEANUP_OPERATIONS.has(operation) ? this.binding.cleanupExpiresAt : this.binding.expiresAt);
    const now = this.clock.now();
    if (!Number.isFinite(expiry) || now >= expiry) fail("BUILDER_DEADLINE_EXPIRED", CLEANUP_OPERATIONS.has(operation) ? "builder cleanup authorization has expired" : "builder lifecycle binding has expired");
    return Math.min(expiry, now + this.operationTimeoutMs);
  }

  async #invoke(role, operation) {
    const roleAllowed = role === "provider" ? operation !== "confirm-absent" : new Set(["confirm-absent", "preflight"]).has(operation);
    if (!OPERATIONS.has(operation) || !roleAllowed) fail("INVALID_OPERATION", "builder transport role cannot perform the requested operation");
    const requestedAt = this.clock.now();
    const envelope = requestEnvelope(this.binding, role, operation, requestedAt, this.#deadline(operation));
    const transport = role === "provider" ? this.providerTransport : this.attestorTransport;
    let lastError = null;
    for (let attempt = 0; attempt < this.transportAttempts; attempt += 1) {
      if (this.clock.now() >= Date.parse(envelope.deadlineAt)) fail("BUILDER_DEADLINE_EXPIRED", "builder transport deadline expired during reconciliation");
      try {
        const receipt = validateReceipt(await transport.request(envelope), envelope);
        await this.receiptStore.commit(receipt);
        if (MUTATIONS.has(operation) && new Set(["ambiguous", "failed"]).has(receipt.status) && attempt + 1 < this.transportAttempts) {
          lastError = new GoldenBuilderTransportError("BUILDER_MUTATION_UNCERTAIN", "builder mutation requires reconciliation", { receiptDigest: receipt.receiptDigest });
          continue;
        }
        return receipt;
      } catch (error) {
        if (error instanceof GoldenBuilderTransportError && ["PROVIDER_RECEIPT_INVALID", "INVALID_CONTRACT"].includes(error.code)) throw error;
        lastError = error;
        if (!MUTATIONS.has(operation) || attempt + 1 >= this.transportAttempts) break;
      }
    }
    throw new GoldenBuilderTransportError(MUTATIONS.has(operation) ? "BUILDER_MUTATION_UNCERTAIN" : "BUILDER_TRANSPORT_FAILED", "bounded builder transport did not return one verified receipt", { cause: lastError?.code ?? "TRANSPORT_FAILED", operation, operationId: envelope.operationId });
  }

  async preflight(binding) {
    this.#sameBinding(binding);
    const provider = validatePreflightPayload((await this.#invoke("provider", "preflight")).payload, this.binding);
    const attestor = validatePreflightPayload((await this.#invoke("attestor", "preflight")).payload, this.binding);
    if (canonicalJsonV1(provider) !== canonicalJsonV1(attestor)) fail("INDEPENDENT_ATTESTATION_FAILED", "provider and attestor observed different cluster preflight state");
    return structuredClone(provider);
  }

  async provision(binding) { this.#sameBinding(binding); return this.#mutation(await this.#invoke("provider", "provision"), "provision"); }
  async observe(binding) { this.#sameBinding(binding); return structuredClone(validateObservationPayload((await this.#invoke("provider", "observe")).payload)); }
  async stop(binding) { this.#sameBinding(binding); return this.#mutation(await this.#invoke("provider", "stop"), "stop"); }
  async quarantine(binding) { this.#sameBinding(binding); return this.#mutation(await this.#invoke("provider", "quarantine"), "quarantine"); }
  async destroy(binding) { this.#sameBinding(binding); return this.#mutation(await this.#invoke("provider", "destroy"), "destroy"); }

  async confirmAbsent(binding) {
    this.#sameBinding(binding);
    const payload = validateAbsencePayload((await this.#invoke("attestor", "confirm-absent")).payload);
    return { vmAbsent: payload.vmAbsent, nameAbsent: payload.nameAbsent, volumesAbsent: payload.volumesAbsent };
  }

  #mutation(receipt, operation) {
    const expected = operation === "quarantine" ? new Set(["committed", "quarantined"]) : new Set(["committed"]);
    if (!expected.has(receipt.status) || typeof receipt.providerOperationId !== "string") fail("BUILDER_MUTATION_UNCERTAIN", `${operation} did not reach one committed provider result`, { receiptDigest: receipt.receiptDigest });
    return { status: "committed", providerOperationId: receipt.providerOperationId };
  }

  #sameBinding(binding) {
    if (!plain(binding) || binding.bindingDigest !== this.binding.bindingDigest || canonicalJsonV1(binding) !== canonicalJsonV1(this.binding)) fail("BUILDER_BINDING_MISMATCH", "adapter call differs from its sealed lifecycle binding");
  }
}

async function sealedFile(path, label, modes) {
  if (!isAbsolute(path)) fail("CONTROLLER_CONFIG_INVALID", `${label} path is not absolute`);
  let info;
  try { info = await lstat(path); } catch { fail("CONTROLLER_CONFIG_INVALID", `${label} is unavailable`); }
  const canonicalPath = await realpath(path); const parentPath = await realpath(dirname(path)); const parentInfo = await lstat(parentPath);
  if (canonicalPath !== path || parentPath !== dirname(path) || !parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o777) !== 0o700 ||
      parentInfo.uid !== process.getuid() || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.uid !== process.getuid() || !modes.has(info.mode & 0o777)) fail("CONTROLLER_CONFIG_INVALID", `${label} is not a sealed caller-owned file in a private canonical directory`);
  return { path: canonicalPath, info };
}

function defaultRunCommand({ args, input, timeoutMs, maxOutputBytes }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/ssh", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    const stdout = []; let length = 0; let overflow = false; const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { length += chunk.length; if (length > maxOutputBytes) { overflow = true; child.kill("SIGKILL"); } else stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { if (Buffer.concat(stderr).length < 16_384) stderr.push(chunk.subarray(0, 16_384)); });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return rejectPromise(Object.assign(new Error("remote builder response exceeded its bound"), { code: "OUTPUT_LIMIT" }));
      if (code !== 0) return rejectPromise(Object.assign(new Error("pinned builder SSH request failed"), { code: signal ? "DEADLINE_EXPIRED" : "REMOTE_HELPER_FAILED" }));
      resolvePromise(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

async function fingerprint(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/ssh-keygen", ["-lf", path, "-E", "sha256"], { shell: false, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk)); child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code !== 0) return rejectPromise(new Error("ssh-keygen failed"));
      const lines = Buffer.concat(output).toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
      const values = lines.map((line) => line.trim().split(/\s+/u)[1]);
      if (values.length < 1 || values.some((item) => !SSH_FINGERPRINT.test(item ?? ""))) return rejectPromise(new Error("SSH fingerprint is invalid"));
      resolvePromise(values);
    });
  });
}

export async function createGoldenBuilderSshTransportsV1({ access: input, runCommand = defaultRunCommand, clock = Date } = {}) {
  const access = validateGoldenBuilderTransportAccessV1(input);
  if (typeof runCommand !== "function" || typeof clock?.now !== "function") fail("INVALID_ADAPTER", "SSH command or clock boundary is invalid");
  const [knownHosts, providerIdentity, attestorIdentity] = await Promise.all([
    sealedFile(access.host.knownHostsFile, "known-hosts", new Set([0o400, 0o440, 0o600, 0o640])),
    sealedFile(access.provider.identityFile, "provider identity", new Set([0o400, 0o600])),
    sealedFile(access.attestor.identityFile, "attestor identity", new Set([0o400, 0o600])),
  ]);
  if (providerIdentity.path === attestorIdentity.path || (providerIdentity.info.dev === attestorIdentity.info.dev && providerIdentity.info.ino === attestorIdentity.info.ino)) fail("INDEPENDENT_ATTESTOR_REQUIRED", "provider and attestor private keys are not distinct files");
  const [hostFingerprints, providerFingerprints, attestorFingerprints, knownHostsBytes] = await Promise.all([
    fingerprint(knownHosts.path), fingerprint(providerIdentity.path), fingerprint(attestorIdentity.path), readFile(knownHosts.path),
  ]);
  if (hostFingerprints.length !== 1 || hostFingerprints[0] !== access.host.hostFingerprint || providerFingerprints.length !== 1 || providerFingerprints[0] !== access.provider.publicKeyFingerprint ||
      attestorFingerprints.length !== 1 || attestorFingerprints[0] !== access.attestor.publicKeyFingerprint) fail("HOST_KEY_MISMATCH", "controller key files differ from the sealed transport access");
  const hostName = access.host.sshPort === 22 ? access.host.sshHost : `[${access.host.sshHost}]:${access.host.sshPort}`;
  const expectedKnownHosts = `${hostName} ${access.host.hostPublicKey.trim().split(/\s+/u).slice(0, 2).join(" ")}\n`;
  if (!knownHostsBytes.equals(Buffer.from(expectedKnownHosts))) fail("HOST_KEY_MISMATCH", "known-hosts must contain exactly one approved host key line");

  const transport = (role) => ({
    identityFingerprint: access[role].publicKeyFingerprint,
    async request(envelope) {
      exact(envelope, ["bindingDigest", "deadlineAt", "kind", "operation", "operationId", "requestedAt", "role", "schemaVersion"], "builderProviderRequest");
      const roleAllowed = role === "provider" ? envelope.operation !== "confirm-absent" : new Set(["confirm-absent", "preflight"]).has(envelope.operation);
      if (envelope.schemaVersion !== 1 || envelope.kind !== "nelos-golden-builder-provider-request" || envelope.role !== role || !OPERATIONS.has(envelope.operation) ||
          !roleAllowed || !SHA256.test(envelope.bindingDigest ?? "") || !SHA256.test(envelope.operationId ?? "")) fail("INVALID_CONTRACT", "builder provider request is invalid");
      const remaining = Date.parse(envelope.deadlineAt) - clock.now();
      const requestedAt = Date.parse(envelope.requestedAt);
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > access.limits.operationTimeoutMs + 1_000 || !Number.isFinite(requestedAt) || requestedAt > clock.now() + 1_000 || requestedAt >= Date.parse(envelope.deadlineAt)) fail("BUILDER_DEADLINE_EXPIRED", "builder provider request deadline is invalid");
      const helper = role === "provider" ? PROVIDER_HELPER : ATTESTOR_HELPER;
      const args = [
        "-F", "/dev/null", "-T", "-p", String(access.host.sshPort), "-o", "BatchMode=yes", "-o", "CanonicalizeHostname=no", "-o", "CheckHostIP=no",
        "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForwardAgent=no", "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "KbdInteractiveAuthentication=no", "-o", "NumberOfPasswordPrompts=0",
        "-o", "PasswordAuthentication=no", "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "RequestTTY=no",
        "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts.path}`, "-i", role === "provider" ? providerIdentity.path : attestorIdentity.path, "--", `${access[role].sshUser}@${access.host.sshHost}`,
        "/usr/bin/sudo", "-n", "--", ...helper.split(" "),
      ];
      const bytes = await runCommand({ args, input: Buffer.from(`${canonicalJsonV1(envelope)}\n`), timeoutMs: Math.min(remaining, access.limits.operationTimeoutMs), maxOutputBytes: access.limits.maxOutputBytes, role });
      if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > access.limits.maxOutputBytes) fail("REMOTE_HELPER_FAILED", "builder remote helper response is invalid");
      let value;
      try { value = JSON.parse(bytes); } catch { fail("REMOTE_HELPER_FAILED", "builder remote helper did not return JSON"); }
      return value;
    },
  });
  return Object.freeze({ providerTransport: transport("provider"), attestorTransport: transport("attestor") });
}

export const GOLDEN_BUILDER_TRANSPORT_CONSTANTS_V1 = Object.freeze({ PROVIDER_USER, ATTESTOR_USER, PROVIDER_HELPER, ATTESTOR_HELPER, PROXMOX_SSH_HOST, PROXMOX_SSH_FINGERPRINT });
