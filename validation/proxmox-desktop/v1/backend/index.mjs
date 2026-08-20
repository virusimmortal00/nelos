import { createHash } from "node:crypto";

export { ProxmoxVeDesktopAdapterV1 } from "./proxmox-ve-adapter.mjs";

export const PROXMOX_DESKTOP_BACKEND_VERSION = 1;
export const PROXMOX_DESKTOP_OPERATIONS_V1 = Object.freeze([
  "create", "start", "stop", "destroy", "quarantine",
]);
export const PROXMOX_DESKTOP_QGA_CONTROLS_V1 = Object.freeze([
  "guest-ping", "guest-get-osinfo", "guest-get-users", "guest-exec", "installed-desktop-identity",
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAC_ADDRESS = /^02(?::[0-9A-F]{2}){5}$/u;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const AMBIGUOUS_CODES = new Set(["AMBIGUOUS_MUTATION", "ETIMEDOUT", "TIMEOUT", "UPID_UNKNOWN"]);
const ACTIVE_WORK_CLEANUP_MARGIN_MS = 120_000;
const PRODUCTION_PROXMOX_LANE_V1 = Object.freeze({ gatewayId: "9023", hostId: "prox2", networkId: "nelosbld", providerId: "proxmox-lab" });
const DESKTOP_IDENTITY_V1 = Object.freeze({
  bundleId: "chatgpt",
  version: "26.814.41957",
  digest: "sha256:4778b26a7abd08647214d5b05c17bd3ebe2d9688d146dabf017c1a2faf93ac7d",
  lockId: "nelos-proxmox-desktop-ubuntu-24.04-amd64-20260819",
  packageLockDigest: "sha256:9925b56c881ae22ffe6a3d22f8a2066b7ae2b4a4613029c2f79cb024a0398e93",
  codex: { path: "/usr/lib/chatgpt/resources/codex", version: "0.148.0-alpha.15", digest: "sha256:f13176129580681cf3024192f1ad43535c9933b24b7eca89e90fa57b3f4855fc" },
  node: { path: "/usr/lib/chatgpt/resources/cua_node/bin/node", version: "24.19.0", digest: "sha256:bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12" },
  userAgent: "Codex Desktop/0.148.0-alpha.15",
});
const QGA_EXEC_ALLOWLIST = new Set([
  "/usr/libexec/nelos-bind-runtime", "/usr/libexec/nelos-credential-boundary", "/usr/libexec/nelos-device-auth",
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

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

export function validateCredentialVolatilityAttestationV1(value, binding) {
  closed(value, [
    "attestationDigest", "bootIdDigest", "codexHome", "fencingToken", "filesystemType", "imageId", "mountOptions", "runId",
    "schemaVersion", "secretBytesIncluded", "swapActive", "type", "vmId", "volatile",
  ], "/credentialBoundary");
  if (value.schemaVersion !== 1 || value.type !== "nelos.credential-volatility.v1" || value.codexHome !== "/home/nelosauto/.codex" ||
      value.filesystemType !== "tmpfs" || JSON.stringify(value.mountOptions) !== JSON.stringify(["nodev", "noexec", "nosuid", "rw"]) ||
      value.swapActive !== false || value.volatile !== true || value.secretBytesIncluded !== false) {
    fail("CREDENTIAL_BOUNDARY_UNATTESTED", "credential storage is not a swap-free run-scoped tmpfs", "/credentialBoundary");
  }
  for (const field of ["runId", "fencingToken", "vmId", "imageId"]) same(value[field], binding[field], `/credentialBoundary/${field}`, "CREDENTIAL_BOUNDARY_UNATTESTED");
  digest(value.bootIdDigest, "/credentialBoundary/bootIdDigest");
  digest(value.attestationDigest, "/credentialBoundary/attestationDigest");
  const { attestationDigest, ...unsigned } = value;
  const expectedDigest = `sha256:${createHash("sha256").update(`${JSON.stringify(canonicalValue(unsigned))}\n`).digest("hex")}`;
  if (attestationDigest !== expectedDigest) fail("CREDENTIAL_BOUNDARY_UNATTESTED", "credential volatility attestation digest differs", "/credentialBoundary/attestationDigest");
  return Object.freeze(structuredClone(value));
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
    "bundledCodexPath", "bundledCodexVersion", "bundledCodexDigest", "bundledNodePath", "bundledNodeVersion", "bundledNodeDigest",
    "maturity", "officialDocumentation", "signingKeyDigest",
  ]);
  validateArtifact(lock.artifacts.signatureVerifier, "/artifacts/signatureVerifier");
  if (lock.artifacts.qga.name !== "qemu-guest-agent") fail("INVALID_LOCK", "QGA package is not locked", "/artifacts/qga/name");
  if (
    lock.artifacts.chatgptDesktop.name !== "chatgpt" ||
    lock.artifacts.chatgptDesktop.version !== "26.814.41957" ||
    lock.artifacts.chatgptDesktop.bundledCodexPath !== "/usr/lib/chatgpt/resources/codex" ||
    lock.artifacts.chatgptDesktop.bundledCodexDigest !== "sha256:f13176129580681cf3024192f1ad43535c9933b24b7eca89e90fa57b3f4855fc" ||
    lock.artifacts.chatgptDesktop.bundledCodexVersion !== "0.148.0-alpha.15" ||
    lock.artifacts.chatgptDesktop.bundledNodePath !== "/usr/lib/chatgpt/resources/cua_node/bin/node" ||
    lock.artifacts.chatgptDesktop.bundledNodeDigest !== "sha256:bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12" ||
    lock.artifacts.chatgptDesktop.bundledNodeVersion !== "24.19.0" ||
    lock.artifacts.chatgptDesktop.maturity !== "preview" ||
    lock.artifacts.chatgptDesktop.officialDocumentation !== "https://learn.chatgpt.com/docs/linux/linux-app" ||
    lock.artifacts.chatgptDesktop.signatureIdentity.scheme !== "debsig-origin-openpgp" ||
    lock.artifacts.chatgptDesktop.signatureIdentity.subject !== "Codex Linux Repository" ||
    lock.artifacts.chatgptDesktop.signatureIdentity.fingerprint !== "3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4"
  ) {
    fail("INVALID_LOCK", "official Desktop preview identity is incomplete", "/artifacts/chatgptDesktop");
  }
  digest(lock.artifacts.chatgptDesktop.signingKeyDigest, "/artifacts/chatgptDesktop/signingKeyDigest");
  digest(lock.artifacts.chatgptDesktop.bundledCodexDigest, "/artifacts/chatgptDesktop/bundledCodexDigest");
  digest(lock.artifacts.chatgptDesktop.bundledNodeDigest, "/artifacts/chatgptDesktop/bundledNodeDigest");
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
  closed(provider, ["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest"], path);
  for (const field of ["providerId", "hostId", "vmId", "networkId", "gatewayId"]) identity(provider[field], `${path}/${field}`);
  if (typeof provider.macAddress !== "string" || !MAC_ADDRESS.test(provider.macAddress)) fail("INVALID_IDENTITY", "provider MAC address is invalid", `${path}/macAddress`);
  digest(provider.networkPolicyDigest, `${path}/networkPolicyDigest`);
  if (!/^[1-9][0-9]{2,8}$/u.test(provider.gatewayId) || provider.gatewayId === provider.vmId) fail("INVALID_IDENTITY", "provider gateway identity is invalid", `${path}/gatewayId`);
  const laneMismatch = Object.entries(PRODUCTION_PROXMOX_LANE_V1).find(([field, expected]) => provider[field] !== expected);
  if (laneMismatch) {
    fail("INVALID_IDENTITY", "provider must use the fixed prox2 gateway VM 9023 and nelosbld VNet identity", `${path}/${laneMismatch[0]}`);
  }
}

function validateLease(lease, path = "/lease", { allowCleanupOnly = false } = {}) {
  closed(lease, ["leaseId", "holderId", "expiresAt", "fencingToken", "state"], path);
  for (const field of ["leaseId", "holderId", "fencingToken"]) identity(lease[field], `${path}/${field}`);
  if (!(lease.state === "active" || (allowCleanupOnly && lease.state === "cleanup-only")) || !ISO_TIMESTAMP.test(lease.expiresAt)) {
    fail("STALE_FENCING_TOKEN", "lease state is not admitted for this operation", path);
  }
}

function validateRuntimeRecord(value, expected, path) {
  closed(value, ["digest", "gid", "mode", "path", "uid", "version"], path);
  digest(value.digest, `${path}/digest`);
  if (value.path !== expected.path || value.version !== expected.version || value.digest !== expected.digest || value.mode !== "0755" ||
      value.uid !== 0 || value.gid !== 0) fail("DESKTOP_IDENTITY_MISMATCH", "installed runtime identity differs", path);
}

export function validateInstalledDesktopIdentityV1(value, desktopBundle) {
  closed(desktopBundle, ["bundleId", "digest", "version"], "/desktopBundle");
  if (desktopBundle.bundleId !== DESKTOP_IDENTITY_V1.bundleId || desktopBundle.version !== DESKTOP_IDENTITY_V1.version || desktopBundle.digest !== DESKTOP_IDENTITY_V1.digest) {
    fail("DESKTOP_IDENTITY_MISMATCH", "admitted Desktop bundle differs from the immutable package lock", "/desktopBundle");
  }
  closed(value, ["appServer", "bakeReceiptDigest", "bundledCodex", "bundledNode", "desktopPackage", "kind", "lockId", "packageLockDigest", "schemaVersion", "verified"], "/installedDesktopIdentity");
  if (value.schemaVersion !== 1 || value.kind !== "nelos-desktop-installed-identity" || value.verified !== true || value.lockId !== DESKTOP_IDENTITY_V1.lockId ||
      value.packageLockDigest !== DESKTOP_IDENTITY_V1.packageLockDigest) fail("DESKTOP_IDENTITY_MISMATCH", "installed Desktop receipt identity differs", "/installedDesktopIdentity");
  digest(value.bakeReceiptDigest, "/installedDesktopIdentity/bakeReceiptDigest");
  closed(value.appServer, ["platformFamily", "platformOs", "userAgent"], "/installedDesktopIdentity/appServer");
  if (value.appServer.platformFamily !== "unix" || value.appServer.platformOs !== "linux" || value.appServer.userAgent !== DESKTOP_IDENTITY_V1.userAgent) {
    fail("DESKTOP_IDENTITY_MISMATCH", "installed Desktop app-server identity differs", "/installedDesktopIdentity/appServer");
  }
  closed(value.desktopPackage, ["architecture", "digest", "name", "version"], "/installedDesktopIdentity/desktopPackage");
  if (value.desktopPackage.architecture !== "amd64" || value.desktopPackage.name !== desktopBundle.bundleId || value.desktopPackage.version !== desktopBundle.version || value.desktopPackage.digest !== desktopBundle.digest) {
    fail("DESKTOP_IDENTITY_MISMATCH", "installed Desktop package identity differs", "/installedDesktopIdentity/desktopPackage");
  }
  validateRuntimeRecord(value.bundledCodex, DESKTOP_IDENTITY_V1.codex, "/installedDesktopIdentity/bundledCodex");
  validateRuntimeRecord(value.bundledNode, DESKTOP_IDENTITY_V1.node, "/installedDesktopIdentity/bundledNode");
  return Object.freeze(structuredClone(value));
}

function validateRequest(request) {
  closed(request, [
    "schemaVersion", "operationId", "operation", "runId", "provider", "desktopBundle", "goldenImage",
    "lease", "reservation", "automation",
  ], "");
  if (request.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA", "unsupported backend request", "/schemaVersion");
  identity(request.operationId, "/operationId");
  identity(request.runId, "/runId");
  if (!PROXMOX_DESKTOP_OPERATIONS_V1.includes(request.operation)) fail("INVALID_OPERATION", "operation is not allowlisted", "/operation");
  validateProvider(request.provider);
  closed(request.desktopBundle, ["bundleId", "digest", "version"], "/desktopBundle");
  identity(request.desktopBundle.bundleId, "/desktopBundle/bundleId");
  identity(request.desktopBundle.version, "/desktopBundle/version");
  digest(request.desktopBundle.digest, "/desktopBundle/digest");
  closed(request.goldenImage, ["imageId", "digest", "templateVmId"], "/goldenImage");
  identity(request.goldenImage.imageId, "/goldenImage/imageId");
  digest(request.goldenImage.digest, "/goldenImage/digest");
  identity(request.goldenImage.templateVmId, "/goldenImage/templateVmId");
  validateLease(request.lease);
  closed(request.reservation, ["reservationId", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "state"], "/reservation");
  for (const field of ["reservationId", "providerId", "hostId", "vmId", "networkId", "gatewayId", "leaseId", "fencingToken"]) identity(request.reservation[field], `/reservation/${field}`);
  if (typeof request.reservation.macAddress !== "string" || !MAC_ADDRESS.test(request.reservation.macAddress)) fail("INVALID_IDENTITY", "reserved MAC address is invalid", "/reservation/macAddress");
  digest(request.reservation.networkPolicyDigest, "/reservation/networkPolicyDigest");
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
  for (const field of ["leaseId", "holderId", "fencingToken"]) {
    same(actual[field], expected[field], `${path}/${field}`, "STALE_FENCING_TOKEN");
  }
}

function compareOwnedVm(actual, expected, path, code = "IDENTITY_MISMATCH") {
  for (const field of ["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest"]) same(actual[field], expected[field], `${path}/${field}`, code);
}

export function admitProxmoxDesktopOperationV1(request, { ownership, currentLease, inventory, now = Date.now() } = {}) {
  validateRequest(request);
  validateProvider(ownership, "/ownership");
  compareOwnedVm(request.provider, ownership, "/provider");
  const cleanupOperation = ["stop", "destroy", "quarantine"].includes(request.operation);
  validateLease(currentLease, "/currentLease", { allowCleanupOnly: cleanupOperation });
  compareLease(request.lease, currentLease, "/lease");
  if (Date.parse(currentLease.expiresAt) <= now) fail("STALE_FENCING_TOKEN", "lease is expired", "/lease/expiresAt");
  const binding = { ...request.provider, leaseId: request.lease.leaseId, fencingToken: request.lease.fencingToken };
  for (const field of ["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken"]) {
    same(request.reservation[field], binding[field], `/reservation/${field}`, "UNRESERVED_VMID");
  }
  if ([request.provider.vmId, request.provider.gatewayId].includes(request.goldenImage.templateVmId)) fail("VMID_CONFLICT", "golden template conflicts with the disposable VM or gateway", "/provider/vmId");
  if (request.operation === "create") {
    if (inventory !== null) fail("VMID_CONFLICT", "reserved VMID is already present", "/inventory");
  } else {
    if (inventory === null) fail("VM_NOT_FOUND", "owned VM is absent", "/inventory");
    closed(inventory, ["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "imageId", "state"], "/inventory");
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
    "quarantineVm", "waitForQga", "attestVmStopped", "attestVmAbsent", "reconcileMutation", "commitReceipt",
  ]) {
    if (typeof adapter?.[method] !== "function") fail("INVALID_ADAPTER", `missing provider adapter method ${method}`, "/adapter");
  }
}

async function committedMutation(adapter, request, mutation, expected, invoke, beforeProviderMutation = null) {
  let result;
  try {
    if (beforeProviderMutation !== null) {
      await beforeProviderMutation(Object.freeze({
        binding: Object.freeze(bindingOf(request)),
        mode: ["clone", "configure", "start"].includes(mutation) ? "active" : "cleanup",
        mutation,
        operationId: request.operationId,
      }));
    }
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
    providerOperationId: result.providerOperationId ?? null, expected,
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

function runtimeBindingOf(request) {
  return {
    ...bindingOf(request),
    imageId: request.goldenImage.imageId,
    runId: request.runId,
    automationUser: request.automation.user,
    stateRoot: request.automation.stateRoot,
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
  const committedReceipt = { ...base, ...facts };
  const commit = await adapter.commitReceipt(committedReceipt);
  if (commit?.committed !== true || commit.receiptId !== base.receiptId || commit.attestationDigest !== base.attestationDigest) {
    fail("RECEIPT_NOT_COMMITTED", "identity-bound lifecycle receipt was not durably committed", "/receipt");
  }
  return Object.freeze({ ...base, ...facts });
}

export function validateCredentialTerminalDispositionV1(value, binding, method) {
  closed(value, [
    "attestationDigest", "codexHome", "filesystemType", "method", "powerState", "reusableCredentialsAbsent",
    "schemaVersion", "secretBytesIncluded", "swapPolicy", "type",
  ], "/credentialDisposition");
  if (value.schemaVersion !== 1 || value.type !== "nelos.credential-terminal-disposition.v1" || value.method !== method ||
      value.codexHome !== "/home/nelosauto/.codex" || value.filesystemType !== "tmpfs" ||
      value.swapPolicy !== "disabled-and-attested-before-auth" || value.powerState !== "stopped" ||
      value.reusableCredentialsAbsent !== true || value.secretBytesIncluded !== false) {
    fail("CREDENTIAL_POWER_OFF_UNATTESTED", "credential terminal disposition differs from the closed volatility contract", "/credentialDisposition");
  }
  digest(value.attestationDigest, "/credentialDisposition/attestationDigest");
  const { attestationDigest, ...unsigned } = value;
  if (attestationDigest !== sha256({ binding, ...unsigned })) {
    fail("CREDENTIAL_POWER_OFF_UNATTESTED", "credential terminal disposition digest differs", "/credentialDisposition/attestationDigest");
  }
  return Object.freeze(structuredClone(value));
}

export function createCredentialTerminalDispositionV1(request, powerObservation, method) {
  const binding = bindingOf(request);
  if (!plain(powerObservation, "/credentialDisposition/powerObservation") || powerObservation.poweredOff !== true || powerObservation.powerState !== "stopped") {
    fail("CREDENTIAL_POWER_OFF_UNATTESTED", "the exact disposable VM is not proven powered off", "/credentialDisposition/powerState");
  }
  for (const [field, expected] of Object.entries(binding)) same(powerObservation[field], expected, `/credentialDisposition/${field}`, "CREDENTIAL_POWER_OFF_UNATTESTED");
  const unsigned = {
    schemaVersion: 1,
    type: "nelos.credential-terminal-disposition.v1",
    method,
    codexHome: "/home/nelosauto/.codex",
    filesystemType: "tmpfs",
    swapPolicy: "disabled-and-attested-before-auth",
    powerState: "stopped",
    reusableCredentialsAbsent: true,
    secretBytesIncluded: false,
  };
  return validateCredentialTerminalDispositionV1({ ...unsigned, attestationDigest: sha256({ binding, ...unsigned }) }, binding, method);
}

async function ensureCredentialPowerOff(adapter, request, method, beforeProviderMutation = null) {
  const binding = bindingOf(request);
  let observation = await adapter.attestVmStopped(binding);
  if (observation?.poweredOff !== true) {
    await committedMutation(adapter, request, "stop", { state: "stopped" }, () => adapter.stopVm({ binding }), beforeProviderMutation);
    observation = await adapter.attestVmStopped(binding);
  }
  return createCredentialTerminalDispositionV1(request, observation, method);
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
    network: {
      interface: "net0",
      model: "virtio",
      macAddress: request.provider.macAddress,
      networkId: request.provider.networkId,
      gatewayId: request.provider.gatewayId,
      networkPolicyDigest: request.provider.networkPolicyDigest,
      firewall: true,
      exclusive: true,
    },
  });
}

async function quarantine(adapter, request, reason, beforeProviderMutation = null, reconciliationOperationId = request.operationId) {
  await ensureCredentialPowerOff(adapter, request, "powered-off-before-quarantine", beforeProviderMutation);
  await committedMutation(adapter, request, "quarantine", {
    imageId: request.goldenImage.imageId, reason, state: "quarantined",
  }, () => adapter.quarantineVm({
    binding: bindingOf(request), imageId: request.goldenImage.imageId, reason,
  }), beforeProviderMutation);
  const attested = await adapter.inspectVm({ ...request.provider });
  if (attested === null || attested.quarantined !== true) fail("QUARANTINE_NOT_ATTESTED", "VM quarantine is not attested", "/quarantine");
  const credentialDisposition = createCredentialTerminalDispositionV1(
    request,
    await adapter.attestVmStopped(bindingOf(request)),
    "powered-off-quarantine",
  );
  const committed = await receipt(adapter, request, "quarantine", {
    credentialDisposition,
    quarantined: true,
    reconciliation: { operationId: reconciliationOperationId, ...bindingOf(request) },
  });
  return committed;
}

function currentTime(now) {
  const value = typeof now === "function" ? now() : now;
  if (!Number.isFinite(value)) fail("INVALID_CONTRACT", "provider clock is invalid", "/now");
  return value;
}

function activeWorkWindow(request, runDeadlineAt, now) {
  if (!["create", "start"].includes(request.operation)) return null;
  const hardDeadlineAt = Date.parse(request.lease.expiresAt);
  const cleanupDeadlineAt = hardDeadlineAt - ACTIVE_WORK_CLEANUP_MARGIN_MS;
  let productionDeadlineAt = Number.MAX_SAFE_INTEGER;
  if (runDeadlineAt !== null && runDeadlineAt !== undefined) {
    if (typeof runDeadlineAt !== "string" || !ISO_TIMESTAMP.test(runDeadlineAt) || !Number.isFinite(Date.parse(runDeadlineAt))) {
      fail("INVALID_CONTRACT", "production run deadline must be an absolute UTC timestamp", "/runDeadlineAt");
    }
    productionDeadlineAt = Date.parse(runDeadlineAt);
  }
  const deadlineAt = Math.min(productionDeadlineAt, cleanupDeadlineAt);
  const runDeadlineIsBinding = productionDeadlineAt <= cleanupDeadlineAt;
  const window = Object.freeze({
    deadlineAt,
    hardDeadlineAt,
    code: runDeadlineIsBinding ? "RUN_DEADLINE_EXPIRED" : "STALE_FENCING_TOKEN",
    path: runDeadlineIsBinding ? "/runDeadlineAt" : "/lease/expiresAt",
    reason: runDeadlineIsBinding ? "run-deadline-expired" : "lease-cleanup-margin-reached",
  });
  if (deadlineAt <= now) {
    fail(window.code, runDeadlineIsBinding
      ? "production run deadline expired before graphical provider work"
      : "lease lacks the cleanup margin required for graphical provider work", window.path);
  }
  return window;
}

function assertActiveWorkWindow(window, now, stage) {
  if (window !== null && now >= window.deadlineAt) {
    fail(window.code, `active graphical provider deadline expired before ${stage}`, window.path);
  }
}

async function quarantineAfterExpiredActiveWork(adapter, request, window, now, stage, beforeProviderMutation = null) {
  if (window === null || now < window.deadlineAt) return;
  const quarantineReceipt = await quarantine(adapter, request, window.reason, beforeProviderMutation);
  fail(window.code, `active graphical provider deadline expired after ${stage}; the exact VM was quarantined`, window.path, { quarantineReceipt });
}

export async function runProxmoxDesktopOperationV1(request, adapter, { ownership, currentLease, now = () => Date.now(), runDeadlineAt = null, beforeProviderMutation = null } = {}) {
  validateRequest(request);
  if (beforeProviderMutation !== null && typeof beforeProviderMutation !== "function") fail("INVALID_CONTRACT", "provider mutation guard is invalid", "/beforeProviderMutation");
  const initialNow = currentTime(now);
  const initialWorkWindow = activeWorkWindow(request, runDeadlineAt, initialNow);
  requireAdapter(adapter);
  const inventory = await adapter.inspectVm({ ...request.provider });
  const admissionNow = currentTime(now);
  const admitted = admitProxmoxDesktopOperationV1(request, { ownership, currentLease, inventory, now: admissionNow });
  const binding = bindingOf(admitted);

  if (admitted.operation === "create") {
    const workWindow = initialWorkWindow;
    assertActiveWorkWindow(workWindow, currentTime(now), "clone");
    await committedMutation(adapter, admitted, "clone", {
      imageId: admitted.goldenImage.imageId, state: "created",
    }, () => adapter.cloneVm({
      binding, configuration: cloneConfiguration(admitted), goldenImage: admitted.goldenImage,
    }), beforeProviderMutation);
    await quarantineAfterExpiredActiveWork(adapter, admitted, workWindow, currentTime(now), "clone", beforeProviderMutation);
    assertActiveWorkWindow(workWindow, currentTime(now), "configuration");
    await committedMutation(adapter, admitted, "configure", {
      automationUser: admitted.automation.user,
      imageId: admitted.goldenImage.imageId,
      macAddress: admitted.provider.macAddress,
      networkId: admitted.provider.networkId,
      runId: admitted.runId,
      state: "configured",
      stateRoot: admitted.automation.stateRoot,
    }, () => adapter.configureVm({
      binding, configuration: cloneConfiguration(admitted),
    }), beforeProviderMutation);
    try {
      const configured = await adapter.inspectVm({ ...admitted.provider });
      if (configured === null || configured.state !== "configured") fail("NETWORK_IDENTITY_MISMATCH", "configured clone does not expose the exact sealed NIC identity", "/provider/network");
      compareOwnedVm(configured, admitted.provider, "/provider/network", "NETWORK_IDENTITY_MISMATCH");
      same(configured.leaseId, admitted.lease.leaseId, "/provider/network/leaseId", "NETWORK_IDENTITY_MISMATCH");
      same(configured.fencingToken, admitted.lease.fencingToken, "/provider/network/fencingToken", "NETWORK_IDENTITY_MISMATCH");
    } catch (error) {
      const quarantineReceipt = await quarantine(adapter, admitted, "network-identity-mismatch", beforeProviderMutation);
      fail("NETWORK_IDENTITY_MISMATCH", "configured clone did not prove the exact single sealed NIC; the VM was quarantined", "/provider/network", { quarantineReceipt, cause: error?.code ?? "NETWORK_OBSERVATION_UNAVAILABLE" });
    }
    await quarantineAfterExpiredActiveWork(adapter, admitted, workWindow, currentTime(now), "configuration", beforeProviderMutation);
    assertActiveWorkWindow(workWindow, currentTime(now), "start");
    await committedMutation(adapter, admitted, "start", { state: "running" }, () => adapter.startVm({ binding }), beforeProviderMutation);
    await quarantineAfterExpiredActiveWork(adapter, admitted, workWindow, currentTime(now), "start", beforeProviderMutation);
    let qga;
    try {
      qga = await adapter.waitForQga({
        binding,
        runtimeBinding: runtimeBindingOf(admitted),
        checks: ["guest-ping", "guest-get-osinfo", "guest-get-users"],
        expectedUser: admitted.automation.user,
        expectedSession: "graphical",
        deadlineAt: workWindow.deadlineAt,
        hardDeadlineAt: workWindow.hardDeadlineAt,
      });
    } catch (error) {
      await quarantineAfterExpiredActiveWork(adapter, admitted, workWindow, currentTime(now), "QGA readiness", beforeProviderMutation);
      const quarantineReceipt = await quarantine(adapter, admitted, "qga-readiness-failed", beforeProviderMutation);
      fail("QGA_NOT_READY", "clone did not establish the dedicated graphical QGA session", "/qga", { quarantineReceipt, cause: error?.code ?? "QGA_UNAVAILABLE" });
    }
    await quarantineAfterExpiredActiveWork(adapter, admitted, workWindow, currentTime(now), "QGA readiness", beforeProviderMutation);
    if (qga?.ready !== true || qga.user !== admitted.automation.user || qga.session !== "graphical") {
      const quarantineReceipt = await quarantine(adapter, admitted, "qga-readiness-failed", beforeProviderMutation);
      fail("QGA_NOT_READY", "clone did not establish the dedicated graphical QGA session", "/qga", { quarantineReceipt });
    }
    let desktopIdentity;
    try { desktopIdentity = validateInstalledDesktopIdentityV1(qga.installedDesktopIdentity, admitted.desktopBundle); }
    catch (error) {
      const quarantineReceipt = await quarantine(adapter, admitted, "desktop-identity-mismatch", beforeProviderMutation);
      fail("DESKTOP_IDENTITY_MISMATCH", "clone installed Desktop identity differs from the admitted bundle", "/qga/installedDesktopIdentity", { quarantineReceipt, cause: error?.code });
    }
    let credentialBoundary;
    try { credentialBoundary = validateCredentialVolatilityAttestationV1(qga.credentialBoundary, { ...binding, imageId: admitted.goldenImage.imageId, runId: admitted.runId }); }
    catch (error) {
      const quarantineReceipt = await quarantine(adapter, admitted, "credential-boundary-unattested", beforeProviderMutation);
      fail("CREDENTIAL_BOUNDARY_UNATTESTED", "clone credential volatility differs from the run-bound tmpfs policy", "/qga/credentialBoundary", { quarantineReceipt, cause: error?.code });
    }
    return receipt(adapter, admitted, "create", { created: true, credentialBoundary, desktopIdentity, desktopIdentityDigest: sha256(desktopIdentity), qgaReady: true, state: "running" });
  }

  if (admitted.operation === "start") {
    const workWindow = initialWorkWindow;
    assertActiveWorkWindow(workWindow, currentTime(now), "start");
    await committedMutation(adapter, admitted, "start", { state: "running" }, () => adapter.startVm({ binding }), beforeProviderMutation);
    await quarantineAfterExpiredActiveWork(adapter, admitted, workWindow, currentTime(now), "start", beforeProviderMutation);
    let qga;
    try {
      qga = await adapter.waitForQga({
        binding, runtimeBinding: runtimeBindingOf(admitted), checks: ["guest-ping"], expectedUser: admitted.automation.user, expectedSession: "graphical",
        deadlineAt: workWindow.deadlineAt, hardDeadlineAt: workWindow.hardDeadlineAt,
      });
    } catch (error) {
      await quarantineAfterExpiredActiveWork(adapter, admitted, workWindow, currentTime(now), "QGA readiness", beforeProviderMutation);
      const quarantineReceipt = await quarantine(adapter, admitted, "qga-readiness-failed", beforeProviderMutation);
      fail("QGA_NOT_READY", "QGA did not become ready after start", "/qga", { quarantineReceipt, cause: error?.code ?? "QGA_UNAVAILABLE" });
    }
    await quarantineAfterExpiredActiveWork(adapter, admitted, workWindow, currentTime(now), "QGA readiness", beforeProviderMutation);
    if (qga?.ready !== true) {
      const quarantineReceipt = await quarantine(adapter, admitted, "qga-readiness-failed", beforeProviderMutation);
      fail("QGA_NOT_READY", "QGA did not become ready after start", "/qga", { quarantineReceipt, cause: qga?.errorCode ?? "QGA_UNAVAILABLE" });
    }
    let desktopIdentity;
    try { desktopIdentity = validateInstalledDesktopIdentityV1(qga.installedDesktopIdentity, admitted.desktopBundle); }
    catch (error) {
      const quarantineReceipt = await quarantine(adapter, admitted, "desktop-identity-mismatch", beforeProviderMutation);
      fail("DESKTOP_IDENTITY_MISMATCH", "restarted clone installed Desktop identity differs from the admitted bundle", "/qga/installedDesktopIdentity", { quarantineReceipt, cause: error?.code });
    }
    let credentialBoundary;
    try { credentialBoundary = validateCredentialVolatilityAttestationV1(qga.credentialBoundary, { ...binding, imageId: admitted.goldenImage.imageId, runId: admitted.runId }); }
    catch (error) {
      const quarantineReceipt = await quarantine(adapter, admitted, "credential-boundary-unattested", beforeProviderMutation);
      fail("CREDENTIAL_BOUNDARY_UNATTESTED", "restarted clone credential volatility differs from the run-bound tmpfs policy", "/qga/credentialBoundary", { quarantineReceipt, cause: error?.code });
    }
    return receipt(adapter, admitted, "start", { started: true, credentialBoundary, desktopIdentity, desktopIdentityDigest: sha256(desktopIdentity), state: "running" });
  }

  if (admitted.operation === "stop") {
    await committedMutation(adapter, admitted, "stop", { state: "stopped" }, () => adapter.stopVm({ binding }), beforeProviderMutation);
    const credentialDisposition = createCredentialTerminalDispositionV1(admitted, await adapter.attestVmStopped(binding), "powered-off-by-stop");
    return receipt(adapter, admitted, "stop", { credentialDisposition, stopped: true, state: "stopped" });
  }

  if (admitted.operation === "quarantine") return quarantine(adapter, admitted, "controller-requested", beforeProviderMutation);

  const credentialDisposition = await ensureCredentialPowerOff(adapter, admitted, "powered-off-before-destroy", beforeProviderMutation);
  await committedMutation(adapter, admitted, "destroy", { state: "absent" }, () => adapter.destroyVm({ binding }), beforeProviderMutation);
  const absence = await adapter.attestVmAbsent({ ...binding });
  if (
    absence?.absent !== true || absence.macAbsent !== true || absence.networkInventoryComplete !== true || absence.providerId !== binding.providerId ||
    absence.hostId !== binding.hostId || absence.vmId !== binding.vmId ||
    absence.macAddress !== binding.macAddress || absence.networkId !== binding.networkId || absence.gatewayId !== binding.gatewayId ||
    absence.networkPolicyDigest !== binding.networkPolicyDigest ||
    absence.leaseId !== binding.leaseId || absence.fencingToken !== binding.fencingToken
  ) {
    return quarantine(adapter, admitted, "destruction-not-exactly-attested", beforeProviderMutation);
  }
  const committed = await receipt(adapter, admitted, "destroy", { credentialDisposition, destroyed: true, macAbsent: true, networkInventoryComplete: true });
  return Object.freeze({
    receiptId: committed.receiptId,
    providerId: committed.providerId,
    hostId: committed.hostId,
    vmId: committed.vmId,
    macAddress: committed.macAddress,
    networkId: committed.networkId,
    gatewayId: committed.gatewayId,
    networkPolicyDigest: committed.networkPolicyDigest,
    leaseId: committed.leaseId,
    fencingToken: committed.fencingToken,
    mutationStatus: "committed",
    credentialDisposition: committed.credentialDisposition,
    destroyed: true,
    macAbsent: true,
    networkInventoryComplete: true,
    attestationDigest: committed.attestationDigest,
  });
}

export async function executeProxmoxQgaControlV1(request, adapter) {
  plain(request, "");
  const installedIdentity = request.control === "installed-desktop-identity";
  closed(request, installedIdentity ? ["control", "binding"] : ["control", "binding", "command", "arguments"], "");
  if (!PROXMOX_DESKTOP_QGA_CONTROLS_V1.includes(request.control)) fail("QGA_CONTROL_DENIED", "QGA control is not allowlisted", "/control");
  closed(request.binding, ["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken"], "/binding");
  for (const field of ["providerId", "hostId", "vmId", "networkId", "gatewayId", "leaseId", "fencingToken"]) identity(request.binding[field], `/binding/${field}`);
  if (typeof request.binding.macAddress !== "string" || !MAC_ADDRESS.test(request.binding.macAddress)) fail("QGA_CONTROL_DENIED", "QGA binding MAC address is invalid", "/binding/macAddress");
  digest(request.binding.networkPolicyDigest, "/binding/networkPolicyDigest");
  if (typeof adapter?.qgaControl !== "function") fail("INVALID_ADAPTER", "adapter has no QGA control boundary", "/adapter");
  if (installedIdentity) {
    return adapter.qgaControl({
      arguments: [],
      binding: request.binding,
      command: "/usr/libexec/nelos-desktop-identity",
      control: "guest-exec",
    });
  }
  if (!Array.isArray(request.arguments) || request.arguments.some((value) => typeof value !== "string" || value.includes("\0"))) {
    fail("QGA_CONTROL_DENIED", "QGA arguments are invalid", "/arguments");
  }
  if (request.control === "guest-exec") {
    if (!QGA_EXEC_ALLOWLIST.has(request.command)) fail("QGA_CONTROL_DENIED", "QGA executable is not allowlisted", "/command");
  } else if (request.command !== null || request.arguments.length !== 0) {
    fail("QGA_CONTROL_DENIED", "non-exec QGA controls do not accept commands", "/command");
  }
  return adapter.qgaControl(request);
}
