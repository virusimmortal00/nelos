import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { canonicalJsonV1, sha256V1 } from "./build-golden-image.mjs";
import { validateGoldenBuilderGatewayPolicyBindingV1 } from "./golden-builder-gateway-policy.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const HOST = "192.168.1.110";
const HOST_FINGERPRINT = "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg";
const PROVIDER_USER = "nelos-golden-gateway-provider";
const ATTESTOR_USER = "nelos-golden-gateway-attestor";
const HELPER_PATH = "/usr/libexec/nelos-proxmox-golden-gateway-transport";

export class GoldenBuilderGatewayTransportError extends Error {
  constructor(code, message, details = null) { super(message); this.name = "GoldenBuilderGatewayTransportError"; this.code = code; this.details = details; }
}

function fail(code, message, details = null) { throw new GoldenBuilderGatewayTransportError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${label} fields differ from the closed contract`);
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

export function validateGoldenBuilderGatewayTransportAccessV1(value) {
  exact(value, ["attestor", "host", "hostHelperDigest", "kind", "limits", "provider", "schemaVersion"], "gateway transport access");
  exact(value.host, ["hostFingerprint", "hostPublicKey", "knownHostsFile", "sshHost", "sshPort"], "gateway transport host");
  exact(value.limits, ["maxOutputBytes", "operationTimeoutMs", "transportAttempts"], "gateway transport limits");
  if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-builder-gateway-transport-access" || !SHA256.test(value.hostHelperDigest ?? "") ||
      value.host.sshHost !== HOST || value.host.sshPort !== 22 || value.host.hostFingerprint !== HOST_FINGERPRINT ||
      openSshFingerprint(value.host.hostPublicKey) !== value.host.hostFingerprint || !isAbsolute(value.host.knownHostsFile) || resolve(value.host.knownHostsFile) !== value.host.knownHostsFile) {
    fail("INVALID_CONTRACT", "gateway transport host or helper identity differs");
  }
  for (const role of ["provider", "attestor"]) {
    exact(value[role], ["identityFile", "publicKey", "publicKeyFingerprint", "sshUser"], `gateway transport ${role}`);
    const expectedUser = role === "provider" ? PROVIDER_USER : ATTESTOR_USER;
    if (value[role].sshUser !== expectedUser || !isAbsolute(value[role].identityFile) || resolve(value[role].identityFile) !== value[role].identityFile ||
        openSshFingerprint(value[role].publicKey) !== value[role].publicKeyFingerprint || !SSH_FINGERPRINT.test(value[role].publicKeyFingerprint ?? "")) {
      fail("INVALID_CONTRACT", `gateway ${role} SSH identity differs`);
    }
  }
  if (value.provider.identityFile === value.attestor.identityFile || value.provider.publicKeyFingerprint === value.attestor.publicKeyFingerprint ||
      new Set([value.provider.publicKeyFingerprint, value.attestor.publicKeyFingerprint]).has(value.host.hostFingerprint)) fail("INDEPENDENT_ATTESTOR_REQUIRED", "gateway SSH identities must be distinct");
  if (!Number.isSafeInteger(value.limits.operationTimeoutMs) || value.limits.operationTimeoutMs < 1_000 || value.limits.operationTimeoutMs > 300_000 ||
      !Number.isSafeInteger(value.limits.maxOutputBytes) || value.limits.maxOutputBytes < 1_024 || value.limits.maxOutputBytes > 1_048_576 ||
      !Number.isSafeInteger(value.limits.transportAttempts) || value.limits.transportAttempts < 1 || value.limits.transportAttempts > 3) fail("INVALID_CONTRACT", "gateway transport limits differ");
  return value;
}

export function createGoldenBuilderGatewayHostBindingV1({ policyBinding, reservation, access: inputAccess }, { now = Date.now() } = {}) {
  const access = validateGoldenBuilderGatewayTransportAccessV1(inputAccess);
  const policy = validateGoldenBuilderGatewayPolicyBindingV1(policyBinding, reservation, { now });
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-golden-builder-gateway-host-binding",
    policyBinding: structuredClone(policy),
    hostHelperDigest: access.hostHelperDigest,
    providerUser: PROVIDER_USER,
    providerPublicKey: access.provider.publicKey.trim(),
    providerKeyFingerprint: access.provider.publicKeyFingerprint,
    attestorUser: ATTESTOR_USER,
    attestorPublicKey: access.attestor.publicKey.trim(),
    attestorKeyFingerprint: access.attestor.publicKeyFingerprint,
    expiresAt: policy.expiresAt,
  };
  return { ...unsigned, hostBindingDigest: sha256V1(unsigned) };
}

export function createGoldenBuilderGatewayHostInstallPlanV1({ hostBinding, access: inputAccess }) {
  const access = validateGoldenBuilderGatewayTransportAccessV1(inputAccess);
  exact(hostBinding, ["attestorKeyFingerprint", "attestorPublicKey", "attestorUser", "expiresAt", "hostBindingDigest", "hostHelperDigest", "kind", "policyBinding", "providerKeyFingerprint", "providerPublicKey", "providerUser", "schemaVersion"], "gateway host binding");
  const { hostBindingDigest, ...unsignedBinding } = hostBinding;
  if (hostBinding.schemaVersion !== 1 || hostBinding.kind !== "nelos-golden-builder-gateway-host-binding" || hostBindingDigest !== sha256V1(unsignedBinding) ||
      hostBinding.hostHelperDigest !== access.hostHelperDigest || hostBinding.providerPublicKey !== access.provider.publicKey.trim() ||
      hostBinding.attestorPublicKey !== access.attestor.publicKey.trim() || hostBinding.providerKeyFingerprint !== access.provider.publicKeyFingerprint ||
      hostBinding.attestorKeyFingerprint !== access.attestor.publicKeyFingerprint) fail("INVALID_CONTRACT", "gateway host binding differs from transport access");
  const forced = (role) => `restrict,command="/usr/bin/sudo -n -- ${HELPER_PATH} ${role} request" ${access[role].publicKey.trim()} nelos:gateway:${role}:${hostBindingDigest.slice(7, 23)}\n`;
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-golden-builder-gateway-host-install-plan",
    hostBindingDigest,
    hostBindingPath: "/etc/nelos-golden/gateway-transport-binding.json",
    hostHelperDigest: access.hostHelperDigest,
    hostHelperPath: HELPER_PATH,
    guestHelperDigest: hostBinding.policyBinding.helper.digest,
    guestHelperPath: hostBinding.policyBinding.helper.path,
    guestVmId: 9023,
    knownHostsLine: `${HOST} ${access.host.hostPublicKey.trim().split(/\s+/u).slice(0, 2).join(" ")}\n`,
    principals: [
      { role: "provider", user: PROVIDER_USER, home: "/var/lib/nelos-golden-gateway-provider", shell: "/bin/sh", authorizedKeysPath: "/var/lib/nelos-golden-gateway-provider/.ssh/authorized_keys", authorizedKey: forced("provider"), sudoersPath: "/etc/sudoers.d/nelos-golden-gateway-provider", sudoers: `${PROVIDER_USER} ALL=(root) NOPASSWD: ${HELPER_PATH} provider request\n` },
      { role: "attestor", user: ATTESTOR_USER, home: "/var/lib/nelos-golden-gateway-attestor", shell: "/bin/sh", authorizedKeysPath: "/var/lib/nelos-golden-gateway-attestor/.ssh/authorized_keys", authorizedKey: forced("attestor"), sudoersPath: "/etc/sudoers.d/nelos-golden-gateway-attestor", sudoers: `${ATTESTOR_USER} ALL=(root) NOPASSWD: ${HELPER_PATH} attestor request\n` },
    ],
  };
  return { ...unsigned, planDigest: sha256V1(unsigned) };
}

async function sealedFile(path, label, modes) {
  if (!isAbsolute(path)) fail("CONTROLLER_CONFIG_INVALID", `${label} path is not absolute`);
  const info = await lstat(path).catch(() => null); const canonical = info ? await realpath(path).catch(() => null) : null;
  const parent = canonical ? await realpath(dirname(path)).catch(() => null) : null; const parentInfo = parent ? await lstat(parent).catch(() => null) : null;
  if (!info || canonical !== path || parent !== dirname(path) || !parentInfo?.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid() || (parentInfo.mode & 0o777) !== 0o700 ||
      !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || !modes.has(info.mode & 0o777)) fail("CONTROLLER_CONFIG_INVALID", `${label} is not a sealed caller-owned file`);
  return { path: canonical, info };
}

function defaultRunCommand({ args, input, timeoutMs, maxOutputBytes }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/ssh", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    const stdout = []; let length = 0; let overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => { length += chunk.length; if (length > maxOutputBytes) { overflow = true; child.kill("SIGKILL"); } else stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { length += chunk.length; if (length > maxOutputBytes) { overflow = true; child.kill("SIGKILL"); } });
    child.once("error", () => { clearTimeout(timer); rejectPromise(new GoldenBuilderGatewayTransportError("SSH_FAILED", "pinned gateway SSH transport could not start")); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return rejectPromise(new GoldenBuilderGatewayTransportError("OUTPUT_LIMIT", "gateway SSH transport exceeded its output bound"));
      if (code !== 0) return rejectPromise(new GoldenBuilderGatewayTransportError(signal ? "DEADLINE_EXPIRED" : "REMOTE_HELPER_FAILED", "pinned gateway SSH transport failed"));
      resolvePromise(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

async function keyFingerprints(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/ssh-keygen", ["-lf", path, "-E", "sha256"], { shell: false, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk)); child.once("error", rejectPromise);
    child.once("close", (code) => {
      const values = Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => line.trim().split(/\s+/u)[1]);
      if (code !== 0 || values.length < 1 || values.some((item) => !SSH_FINGERPRINT.test(item ?? ""))) return rejectPromise(new Error("SSH fingerprint unavailable"));
      resolvePromise(values);
    });
  });
}

export async function createGoldenBuilderGatewaySshTransportsV1({ access: inputAccess, policyBinding, reservation, runCommand = defaultRunCommand, clock = Date, allowExpiredBinding = false } = {}) {
  const access = validateGoldenBuilderGatewayTransportAccessV1(inputAccess);
  const policy = validateGoldenBuilderGatewayPolicyBindingV1(policyBinding, reservation, { now: clock.now(), allowExpired: allowExpiredBinding });
  const [knownHosts, providerKey, attestorKey] = await Promise.all([
    sealedFile(access.host.knownHostsFile, "gateway known-hosts", new Set([0o400, 0o440, 0o600, 0o640])),
    sealedFile(access.provider.identityFile, "gateway provider key", new Set([0o400, 0o600])),
    sealedFile(access.attestor.identityFile, "gateway attestor key", new Set([0o400, 0o600])),
  ]);
  if (providerKey.path === attestorKey.path || (providerKey.info.dev === attestorKey.info.dev && providerKey.info.ino === attestorKey.info.ino)) fail("INDEPENDENT_ATTESTOR_REQUIRED", "gateway provider and attestor keys are the same file");
  const [hostFps, providerFps, attestorFps, knownHostsBytes] = await Promise.all([keyFingerprints(knownHosts.path), keyFingerprints(providerKey.path), keyFingerprints(attestorKey.path), readFile(knownHosts.path)]);
  if (hostFps.length !== 1 || hostFps[0] !== access.host.hostFingerprint || providerFps.length !== 1 || providerFps[0] !== access.provider.publicKeyFingerprint ||
      attestorFps.length !== 1 || attestorFps[0] !== access.attestor.publicKeyFingerprint || !knownHostsBytes.equals(Buffer.from(`${HOST} ${access.host.hostPublicKey.trim().split(/\s+/u).slice(0, 2).join(" ")}\n`))) {
    fail("HOST_KEY_MISMATCH", "gateway controller key material differs from the sealed access binding");
  }
  const make = (role) => ({
    identityFingerprint: access[role].publicKeyFingerprint,
    async invoke(request) {
      exact(request, ["binding", "deadlineAt", "kind", "operation", "operationId", "requestedAt", "role", "schemaVersion"], "gateway transport request");
      if (request.role !== role || canonicalJsonV1(request.binding) !== canonicalJsonV1(policy)) fail("INVALID_CONTRACT", "gateway request differs from the sealed transport role or policy");
      const remaining = Date.parse(request.deadlineAt) - clock.now();
      if (!Number.isFinite(remaining) || remaining < 1 || remaining > access.limits.operationTimeoutMs + 1_000) fail("DEADLINE_EXPIRED", "gateway request deadline differs from the transport budget");
      const args = [
        "-F", "/dev/null", "-T", "-p", "22", "-o", "BatchMode=yes", "-o", "CanonicalizeHostname=no", "-o", "CheckHostIP=no",
        "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForwardAgent=no", "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "KbdInteractiveAuthentication=no", "-o", "NumberOfPasswordPrompts=0", "-o", "PasswordAuthentication=no",
        "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "RequestTTY=no", "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${knownHosts.path}`, "-i", role === "provider" ? providerKey.path : attestorKey.path, "--", `${access[role].sshUser}@${HOST}`,
        "/usr/bin/sudo", "-n", "--", HELPER_PATH, role, "request",
      ];
      const bytes = await runCommand({ args, input: Buffer.from(`${canonicalJsonV1(request)}\n`), timeoutMs: Math.min(remaining, access.limits.operationTimeoutMs), maxOutputBytes: access.limits.maxOutputBytes, role });
      if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > access.limits.maxOutputBytes) fail("REMOTE_HELPER_FAILED", "gateway helper response is invalid");
      try { return JSON.parse(bytes); } catch { fail("REMOTE_HELPER_FAILED", "gateway helper response is not JSON"); }
    },
  });
  return Object.freeze({ providerTransport: make("provider"), attestorTransport: make("attestor") });
}

export const GOLDEN_BUILDER_GATEWAY_TRANSPORT_CONSTANTS_V1 = Object.freeze({ HOST, HOST_FINGERPRINT, PROVIDER_USER, ATTESTOR_USER, HELPER_PATH });
