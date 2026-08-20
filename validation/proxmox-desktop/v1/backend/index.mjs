import { createHash } from "node:crypto";

export { ProxmoxVeDesktopAdapterV1 } from "./proxmox-ve-adapter.mjs";

export const PROXMOX_DESKTOP_BACKEND_VERSION = 1;
export const PROXMOX_DESKTOP_OPERATIONS_V1 = Object.freeze([
  "create", "start", "stop", "destroy", "quarantine",
]);
export const PROXMOX_DESKTOP_QGA_CONTROLS_V1 = Object.freeze([
  "guest-ping", "guest-get-osinfo", "guest-get-users", "guest-exec",
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const AMBIGUOUS_CODES = new Set(["AMBIGUOUS_MUTATION", "ETIMEDOUT", "TIMEOUT", "UPID_UNKNOWN"]);
const QGA_EXEC_ALLOWLIST = new Set([
  "/usr/bin/loginctl", "/usr/bin/systemctl", "/usr/bin/test", "/usr/bin/id", "/usr/libexec/nelos-bind-runtime",
]);

export class ProxmoxDesktopBackendError extends Error {
  constructor(code, message, path = "", details = null) {
    super(message);
    this.name = "ProxmoxDesktopBackendError";
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

function fail(code, message, path = "", details = null) {
  throw new ProxmoxDesktopBackendError(code, message, path, details);
}

function plain(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CONTRACT", "expected a plain object", path);
  }
  return value;
}

function closed(value, fields, path) {
  plain(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("INVALID_CONTRACT", "object fields do not match the closed contract", path);
  }
  return value;
}

function identity(value, path) {
  if (typeof value !== "string" || !ID.test(value)) fail("INVALID_IDENTITY", "invalid identity", path);
  return value;
}

function digest(value, path) {
  if (typeof value !== "string" || !SHA256.test(value)) fail("INVALID_IDENTITY", "invalid sha256 digest", path);
  return value;
}

function same(actual, expected, path, code = "IDENTITY_MISMATCH") {
  if (actual !== expected) fail(code, "identity does not match the owned resource", path);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function validateArtifact(artifact, path, extraFields = []) {
  closed(artifact, ["name", "source", "version", "digest", "signatureIdentity", ...extraFields], path);
  identity(artifact.name, `${path}/name`);
  if (typeof artifact.source !== "string" || !artifact.source.startsWith("https://")) {
    fail("INVALID_LOCK", "artifact source must be an immutable HTTPS source", `${path}/source`);
  }
  if (typeof artifact.version !== "string" || artifact.version.length === 0 || /\b(?:latest|stable|floating)\b/iu.test(artifact.version)) {
    fail("INVALID_LOCK", "artifact version must be exact", `${path}/version`);
  }
  digest(artifact.digest, `${path}/digest`);
  closed(artifact.signatureIdentity, ["scheme", "issuer", "subject", "fingerprint"], `${path}/signatureIdentity`);
  for (const field of ["scheme", "issuer", "subject", "fingerprint"]) {
    if (typeof artifact.signatureIdentity[field] !== "string" || artifact.signatureIdentity[field].length === 0) {
      fail("INVALID_LOCK", "signature identity must be complete", `${path}/signatureIdentity/${field}`);
    }
  }
}

export function validateProxmoxDesktopPackageLockV1(lock) {
  closed(lock, ["schemaVersion", "lockId", "generatedAt", "platform", "artifacts", "policy"], "");
  if (lock.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA", "unsupported package lock", "/schemaVersion");
  identity(lock.lockId, "/lockId");
  if (!ISO_TIMESTAMP.test(lock.generatedAt) || !Number.isFinite(Date.parse(lock.generatedAt))) {
    fail("INVALID_LOCK", "lock timestamp must be UTC ISO-8601", "/generatedAt");
  }
  closed(lock.platform, ["distribution", "release", "architecture"], "/platform");
  if (lock.platform.distribution !== "ubuntu" || lock.platform.release !== "24.04" || lock.platform.architecture !== "amd64") {
    fail("INVALID_LOCK", "backend lock supports only Ubuntu 24.04 amd64", "/platform");
  }
  closed(lock.artifacts, ["ubuntuBase", "qga", "graphicalSession", "chatgptDesktop", "signatureVerifier"], "/artifacts");
  validateArtifact(lock.artifacts.ubuntuBase, "/artifacts/ubuntuBase");
  validateArtifact(lock.artifacts.qga, "/artifacts/qga");
  if (!Array.isArray(lock.artifacts.graphicalSession) || lock.artifacts.graphicalSession.length < 3) {
    fail("INVALID_LOCK", "graphical session package set is incomplete", "/artifacts/graphicalSession");
  }
  lock.artifacts.graphicalSession.forEach((artifact, index) => validateArtifact(artifact, `/artifacts/graphicalSession/${index}`));
  validateArtifact(lock.artifacts.chatgptDesktop, "/artifacts/chatgptDesktop", [
    "bundledCodexVersion", "maturity", "officialDocumentation", "signingKeyDigest",
  ]);
  validateArtifact(lock.artifacts.signatureVerifier, "/artifacts/signatureVerifier");
  if (lock.artifacts.qga.name !== "qemu-guest-agent") fail("INVALID_LOCK", "QGA package is not locked", "/artifacts/qga/name");
  if (
    lock.artifacts.chatgptDesktop.name !== "chatgpt" ||
    lock.artifacts.chatgptDesktop.version !== "26.814.41957" ||
    lock.artifacts.chatgptDesktop.bundledCodexVersion !== "0.148.0-alpha.15" ||
    lock.artifacts.chatgptDesktop.maturity !== "preview" ||
    lock.artifacts.chatgptDesktop.officialDocumentation !== "https://learn.chatgpt.com/docs/linux/linux-app" ||
    lock.artifacts.chatgptDesktop.signatureIdentity.scheme !== "debsig-origin-openpgp" ||
    lock.artifacts.chatgptDesktop.signatureIdentity.subject !== "Codex Linux Repository" ||
    lock.artifacts.chatgptDesktop.signatureIdentity.fingerprint !== "3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4"
  ) {
    fail("INVALID_LOCK", "official Desktop preview identity is incomplete", "/artifacts/chatgptDesktop");
  }
  digest(lock.artifacts.chatgptDesktop.signingKeyDigest, "/artifacts/chatgptDesktop/signingKeyDigest");
  closed(lock.policy, ["allowFloatingVersions", "allowUnsignedArtifacts", "aptSnapshot"], "/policy");
  if (lock.policy.allowFloatingVersions !== false || lock.policy.allowUnsignedArtifacts !== false) {
    fail("INVALID_LOCK", "immutable lock must reject floating and unsigned artifacts", "/policy");
  }
  if (typeof lock.policy.aptSnapshot !== "string" || !/^\d{8}T\d{6}Z$/u.test(lock.policy.aptSnapshot)) {
    fail("INVALID_LOCK", "APT snapshot must be exact", "/policy/aptSnapshot");
  }
  return lock;
}

export function assertProxmoxDesktopPackageLockUsableV1(lock) {
  validateProxmoxDesktopPackageLockV1(lock);
  return lock;
}

function validateProvider(provider, path = "/provider") {
  closed(provider, ["providerId", "hostId", "vmId"], path);
  for (const field of ["providerId", "hostId", "vmId"]) identity(provider[field], `${path}/${field}`);
}

function validateLease(lease, path = "/lease") {
  closed(lease, ["leaseId", "holderId", "expiresAt", "fencingToken", "state"], path);
  for (const field of ["leaseId", "holderId", "fencingToken"]) identity(lease[field], `${path}/${field}`);
  if (lease.state !== "active" || !ISO_TIMESTAMP.test(lease.expiresAt)) fail("STALE_FENCING_TOKEN", "lease is not active", path);
}

function validateRequest(request) {
  closed(request, [
    "schemaVersion", "operationId", "operation", "runId", "provider", "goldenImage",
    "lease", "reservation", "automation",
  ], "");
  if (request.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA", "unsupported backend request", "/schemaVersion");
  identity(request.operationId, "/operationId");
  identity(request.runId, "/runId");
  if (!PROXMOX_DESKTOP_OPERATIONS_V1.includes(request.operation)) fail("INVALID_OPERATION", "operation is not allowlisted", "/operation");
  validateProvider(request.provider);
  closed(request.goldenImage, ["imageId", "digest", "templateVmId"], "/goldenImage");
  identity(request.goldenImage.imageId, "/goldenImage/imageId");
  digest(request.goldenImage.digest, "/goldenImage/digest");
  identity(request.goldenImage.templateVmId, "/goldenImage/templateVmId");
  validateLease(request.lease);
  closed(request.reservation, ["reservationId", "providerId", "hostId", "vmId", "leaseId", "fencingToken", "state"], "/reservation");
  for (const field of ["reservationId", "providerId", "hostId", "vmId", "leaseId", "fencingToken"]) identity(request.reservation[field], `/reservation/${field}`);
  if (request.reservation.state !== "reserved") fail("UNRESERVED_VMID", "VMID is not reserved", "/reservation/state");
  closed(request.automation, ["user", "uid", "home", "stateRoot", "credentialRefs"], "/automation");
  if (!USER.test(request.automation.user) || !Number.isSafeInteger(request.automation.uid) || request.automation.uid < 1000) {
    fail("INVALID_AUTOMATION_ACCOUNT", "dedicated automation account is invalid", "/automation");
  }
  const expectedHome = `/home/${request.automation.user}`;
  const expectedState = `/var/lib/nelos-desktop/runs/${request.runId}`;
  if (request.automation.home !== expectedHome || request.automation.stateRoot !== expectedState) {
    fail("WRITABLE_STATE_NOT_ISOLATED", "automation state is not isolated to this run", "/automation");
  }
  if (!Array.isArray(request.automation.credentialRefs) || request.automation.credentialRefs.length !== 0) {
    fail("BAKED_CREDENTIALS_FORBIDDEN", "golden image and clone requests cannot contain credentials", "/automation/credentialRefs");
  }
  return request;
}

function compareLease(actual, expected, path) {
  for (const field of ["leaseId", "holderId", "expiresAt", "fencingToken", "state"]) {
    same(actual[field], expected[field], `${path}/${field}`, "STALE_FENCING_TOKEN");
  }
}

function compareOwnedVm(actual, expected, path, code = "IDENTITY_MISMATCH") {
  for (const field of ["providerId", "hostId", "vmId"]) same(actual[field], expected[field], `${path}/${field}`, code);
}

export function admitProxmoxDesktopOperationV1(request, { ownership, currentLease, inventory, now = Date.now() } = {}) {
  validateRequest(request);
  validateProvider(ownership, "/ownership");
  compareOwnedVm(request.provider, ownership, "/provider");
  validateLease(currentLease, "/currentLease");
  compareLease(request.lease, currentLease, "/lease");
  if (Date.parse(currentLease.expiresAt) <= now) fail("STALE_FENCING_TOKEN", "lease is expired", "/lease/expiresAt");
  const binding = { ...request.provider, leaseId: request.lease.leaseId, fencingToken: request.lease.fencingToken };
  for (const field of ["providerId", "hostId", "vmId", "leaseId", "fencingToken"]) {
    same(request.reservation[field], binding[field], `/reservation/${field}`, "UNRESERVED_VMID");
  }
  if (request.goldenImage.templateVmId === request.provider.vmId) fail("VMID_CONFLICT", "clone VMID conflicts with its golden template", "/provider/vmId");
  if (request.operation === "create") {
    if (inventory !== null) fail("VMID_CONFLICT", "reserved VMID is already present", "/inventory");
  } else {
    if (inventory === null) fail("VM_NOT_FOUND", "owned VM is absent", "/inventory");
    closed(inventory, ["providerId", "hostId", "vmId", "leaseId", "fencingToken", "imageId", "state"], "/inventory");
    compareOwnedVm(inventory, request.provider, "/inventory");
    same(inventory.leaseId, request.lease.leaseId, "/inventory/leaseId");
    same(inventory.fencingToken, request.lease.fencingToken, "/inventory/fencingToken", "STALE_FENCING_TOKEN");
    same(inventory.imageId, request.goldenImage.imageId, "/inventory/imageId", "GOLDEN_IMAGE_MISMATCH");
  }
  return request;
}

function requireAdapter(adapter) {
  for (const method of [
    "inspectVm", "cloneVm", "configureVm", "startVm", "stopVm", "destroyVm",
    "quarantineVm", "waitForQga", "attestVmAbsent", "reconcileMutation", "commitReceipt",
  ]) {
    if (typeof adapter?.[method] !== "function") fail("INVALID_ADAPTER", `missing provider adapter method ${method}`, "/adapter");
  }
}

async function committedMutation(adapter, request, mutation, invoke) {
  let result;
  try {
    result = await invoke();
  } catch (error) {
    if (!AMBIGUOUS_CODES.has(error?.code)) throw error;
    result = { status: "ambiguous", providerOperationId: error.providerOperationId ?? null };
  }
  if (result?.status === "committed") return result;
  if (!result || !["ambiguous", "timed_out"].includes(result.status)) {
    fail("MUTATION_NOT_COMMITTED", `${mutation} mutation did not commit`, "/providerReceipt");
  }
  const reconciled = await adapter.reconcileMutation({
    binding: bindingOf(request), mutation, operationId: request.operationId,
    providerOperationId: result.providerOperationId ?? null,
  });
  if (reconciled?.status !== "committed") {
    fail("AMBIGUOUS_MUTATION", `${mutation} outcome remains ambiguous; mutation was not retried`, "/providerReceipt", {
      operationId: request.operationId,
      providerOperationId: result.providerOperationId ?? null,
    });
  }
  return reconciled;
}

function bindingOf(request) {
  return {
    ...request.provider,
    leaseId: request.lease.leaseId,
    fencingToken: request.lease.fencingToken,
  };
}

async function receipt(adapter, request, operation, facts) {
  const base = {
    receiptId: `${request.operationId}-${operation}-receipt`,
    ...bindingOf(request),
    operation,
    operationId: request.operationId,
    mutationStatus: "committed",
    attestationDigest: sha256({ binding: bindingOf(request), operation, operationId: request.operationId, facts }),
  };
  const commit = await adapter.commitReceipt(base);
  if (commit?.committed !== true || commit.receiptId !== base.receiptId || commit.attestationDigest !== base.attestationDigest) {
    fail("RECEIPT_NOT_COMMITTED", "identity-bound lifecycle receipt was not durably committed", "/receipt");
  }
  return Object.freeze({ ...base, ...facts });
}

function cloneConfiguration(request) {
  return Object.freeze({
    cloneMode: "linked",
    disposable: true,
    templateVmId: request.goldenImage.templateVmId,
    goldenImageId: request.goldenImage.imageId,
    goldenImageDigest: request.goldenImage.digest,
    qgaEnabled: true,
    graphicalTarget: "graphical.target",
    displayManager: "gdm3",
    automation: {
      user: request.automation.user,
      uid: request.automation.uid,
      home: request.automation.home,
      passwordLocked: true,
      sudo: false,
      sshAuthorizedKeys: [],
    },
    writableState: {
      root: request.automation.stateRoot,
      mountMode: "fresh-per-run",
      persistent: false,
    },
    credentialRefs: [],
  });
}

async function quarantine(adapter, request, reason, reconciliationOperationId = request.operationId) {
  await committedMutation(adapter, request, "quarantine", () => adapter.quarantineVm({
    binding: bindingOf(request), reason,
  }));
  const attested = await adapter.inspectVm({ ...request.provider });
  if (attested === null || attested.quarantined !== true) fail("QUARANTINE_NOT_ATTESTED", "VM quarantine is not attested", "/quarantine");
  const committed = await receipt(adapter, request, "quarantine", {
    quarantined: true,
    reconciliation: { operationId: reconciliationOperationId, ...bindingOf(request) },
  });
  return committed;
}

export async function runProxmoxDesktopOperationV1(request, adapter, { ownership, currentLease, now = Date.now() } = {}) {
  requireAdapter(adapter);
  const inventory = await adapter.inspectVm({ ...request.provider });
  const admitted = admitProxmoxDesktopOperationV1(request, { ownership, currentLease, inventory, now });
  const binding = bindingOf(admitted);

  if (admitted.operation === "create") {
    await committedMutation(adapter, admitted, "clone", () => adapter.cloneVm({
      binding, configuration: cloneConfiguration(admitted), goldenImage: admitted.goldenImage,
    }));
    await committedMutation(adapter, admitted, "configure", () => adapter.configureVm({
      binding, configuration: cloneConfiguration(admitted),
    }));
    await committedMutation(adapter, admitted, "start", () => adapter.startVm({ binding }));
    const qga = await adapter.waitForQga({
      binding,
      runtimeBinding: {
        ...binding, imageId: admitted.goldenImage.imageId, runId: admitted.runId,
        automationUser: admitted.automation.user, stateRoot: admitted.automation.stateRoot,
      },
      checks: ["guest-ping", "guest-get-osinfo", "guest-get-users"],
      expectedUser: admitted.automation.user,
      expectedSession: "graphical",
    });
    if (qga?.ready !== true || qga.user !== admitted.automation.user || qga.session !== "graphical") {
      const quarantineReceipt = await quarantine(adapter, admitted, "qga-readiness-failed");
      fail("QGA_NOT_READY", "clone did not establish the dedicated graphical QGA session", "/qga", { quarantineReceipt });
    }
    return receipt(adapter, admitted, "create", { created: true, qgaReady: true, state: "running" });
  }

  if (admitted.operation === "start") {
    await committedMutation(adapter, admitted, "start", () => adapter.startVm({ binding }));
    const qga = await adapter.waitForQga({ binding, checks: ["guest-ping"], expectedUser: admitted.automation.user, expectedSession: "graphical" });
    if (qga?.ready !== true) fail("QGA_NOT_READY", "QGA did not become ready after start", "/qga");
    return receipt(adapter, admitted, "start", { started: true, state: "running" });
  }

  if (admitted.operation === "stop") {
    await committedMutation(adapter, admitted, "stop", () => adapter.stopVm({ binding }));
    return receipt(adapter, admitted, "stop", { stopped: true, state: "stopped" });
  }

  if (admitted.operation === "quarantine") return quarantine(adapter, admitted, "controller-requested");

  await committedMutation(adapter, admitted, "destroy", () => adapter.destroyVm({ binding }));
  const absence = await adapter.attestVmAbsent({ ...binding });
  if (
    absence?.absent !== true || absence.providerId !== binding.providerId ||
    absence.hostId !== binding.hostId || absence.vmId !== binding.vmId ||
    absence.leaseId !== binding.leaseId || absence.fencingToken !== binding.fencingToken
  ) {
    return quarantine(adapter, admitted, "destruction-not-exactly-attested");
  }
  const committed = await receipt(adapter, admitted, "destroy", { destroyed: true });
  return Object.freeze({
    receiptId: committed.receiptId,
    providerId: committed.providerId,
    hostId: committed.hostId,
    vmId: committed.vmId,
    leaseId: committed.leaseId,
    fencingToken: committed.fencingToken,
    mutationStatus: "committed",
    destroyed: true,
    attestationDigest: committed.attestationDigest,
  });
}

export async function executeProxmoxQgaControlV1(request, adapter) {
  closed(request, ["control", "binding", "command", "arguments"], "");
  if (!PROXMOX_DESKTOP_QGA_CONTROLS_V1.includes(request.control)) fail("QGA_CONTROL_DENIED", "QGA control is not allowlisted", "/control");
  closed(request.binding, ["providerId", "hostId", "vmId", "leaseId", "fencingToken"], "/binding");
  for (const field of Object.keys(request.binding)) identity(request.binding[field], `/binding/${field}`);
  if (!Array.isArray(request.arguments) || request.arguments.some((value) => typeof value !== "string" || value.includes("\0"))) {
    fail("QGA_CONTROL_DENIED", "QGA arguments are invalid", "/arguments");
  }
  if (request.control === "guest-exec") {
    if (!QGA_EXEC_ALLOWLIST.has(request.command)) fail("QGA_CONTROL_DENIED", "QGA executable is not allowlisted", "/command");
  } else if (request.command !== null || request.arguments.length !== 0) {
    fail("QGA_CONTROL_DENIED", "non-exec QGA controls do not accept commands", "/command");
  }
  if (typeof adapter?.qgaControl !== "function") fail("INVALID_ADAPTER", "adapter has no QGA control boundary", "/adapter");
  return adapter.qgaControl(request);
}
