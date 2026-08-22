import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chown, chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJsonV1, sha256V1 } from "./build-golden-image.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PLAN_KINDS = new Set(["nelos-golden-builder-host-install-plan", "nelos-golden-builder-gateway-host-install-plan", "nelos-golden-volume-attestor-host-install-plan"]);
const INTENT_ROOT = "/var/lib/nelos-golden-host-installer";
const COMMAND_TIMEOUT_MS = 30_000;

export class GoldenBuilderHostInstallerError extends Error {
  constructor(code, message, details = null) { super(message); this.name = "GoldenBuilderHostInstallerError"; this.code = code; this.details = details; }
}

function fail(code, message, details = null) { throw new GoldenBuilderHostInstallerError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_INSTALL_PLAN", `${label} fields differ from the closed contract`);
  return value;
}
function safeAbsolute(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/u.test(value); }
async function optionalLstat(path) { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }

function publicKeyFingerprint(value) {
  const match = /(?:^|\s)ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?:\s|$)/u.exec(value ?? "");
  if (!match) fail("INVALID_INSTALL_PLAN", "principal key is not one canonical ED25519 key");
  const blob = Buffer.from(match[1], "base64");
  if (blob.toString("base64") !== match[1] || blob.length !== 51 || blob.readUInt32BE(0) !== 11 || blob.subarray(4, 15).toString("ascii") !== "ssh-ed25519" || blob.readUInt32BE(15) !== 32) {
    fail("INVALID_INSTALL_PLAN", "principal key has invalid ED25519 wire encoding");
  }
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`;
}

function validatePrincipal(value, expected) {
  exact(value, ["authorizedKey", "authorizedKeysPath", "home", "role", "shell", "sudoers", "sudoersPath", "user"], `installPlan.principals.${expected.role}`);
  if (value.role !== expected.role || value.user !== expected.user || value.home !== expected.home || value.authorizedKeysPath !== `${expected.home}/.ssh/authorized_keys` ||
      value.sudoersPath !== expected.sudoersPath || value.shell !== "/bin/sh" || !safeAbsolute(value.home) || !safeAbsolute(value.authorizedKeysPath) || !safeAbsolute(value.sudoersPath) ||
      typeof value.authorizedKey !== "string" || value.authorizedKey.length > 8_192 || !value.authorizedKey.endsWith("\n") ||
      !value.authorizedKey.startsWith(`restrict,command="/usr/bin/sudo -n -- ${expected.command}" ssh-ed25519 `) ||
      value.sudoers !== `${value.user} ALL=(root) NOPASSWD: ${expected.command}\n`) {
    fail("INVALID_INSTALL_PLAN", `${expected.role} principal authority differs from the fixed command`);
  }
  return value;
}

export function validateGoldenBuilderHostInstallPlanV1(value) {
  if (!plain(value) || !PLAN_KINDS.has(value.kind)) fail("INVALID_INSTALL_PLAN", "host install plan kind is unsupported");
  const gateway = value.kind === "nelos-golden-builder-gateway-host-install-plan";
  const volume = value.kind === "nelos-golden-volume-attestor-host-install-plan";
  const fields = gateway
    ? ["guestHelperDigest", "guestHelperPath", "guestVmId", "hostBindingDigest", "hostBindingPath", "hostHelperDigest", "hostHelperPath", "kind", "knownHostsLine", "planDigest", "principals", "schemaVersion"]
    : ["helperDigest", "helperPath", "hostBindingDigest", "hostBindingPath", "kind", ...(volume ? [] : ["knownHostsLine"]), "planDigest", "principals", "schemaVersion"];
  exact(value, fields, "hostInstallPlan");
  const { planDigest, ...unsigned } = value;
  if (value.schemaVersion !== 1 || planDigest !== sha256V1(unsigned) || !SHA256.test(value.hostBindingDigest ?? "") ||
      (!volume && (typeof value.knownHostsLine !== "string" || !/^192\.168\.1\.110 ssh-ed25519 [A-Za-z0-9+/]+={0,2}\n$/u.test(value.knownHostsLine))) ||
      !Array.isArray(value.principals) || value.principals.length !== (volume ? 1 : 2)) fail("INVALID_INSTALL_PLAN", "host install plan digest or trust identity differs");
  if (gateway) {
    if (value.hostBindingPath !== "/etc/nelos-golden/gateway-transport-binding.json" || value.hostHelperPath !== "/usr/libexec/nelos-proxmox-golden-gateway-transport" ||
        value.guestHelperPath !== "/usr/libexec/nelos-golden-gateway-policy" || value.guestVmId !== 9023 ||
        !SHA256.test(value.hostHelperDigest ?? "") || !SHA256.test(value.guestHelperDigest ?? "")) fail("INVALID_INSTALL_PLAN", "gateway helper targets differ");
    validatePrincipal(value.principals[0], { role: "provider", user: "nelos-golden-gateway-provider", home: "/var/lib/nelos-golden-gateway-provider", sudoersPath: "/etc/sudoers.d/nelos-golden-gateway-provider", command: `${value.hostHelperPath} provider request` });
    validatePrincipal(value.principals[1], { role: "attestor", user: "nelos-golden-gateway-attestor", home: "/var/lib/nelos-golden-gateway-attestor", sudoersPath: "/etc/sudoers.d/nelos-golden-gateway-attestor", command: `${value.hostHelperPath} attestor request` });
  } else if (!volume) {
    if (value.hostBindingPath !== "/etc/nelos-golden/builder-host-binding.json" || value.helperPath !== "/usr/libexec/nelos-proxmox-golden-builder-helper" || !SHA256.test(value.helperDigest ?? "")) fail("INVALID_INSTALL_PLAN", "builder helper targets differ");
    validatePrincipal(value.principals[0], { role: "provider", user: "nelos-golden-provider", home: "/var/lib/nelos-golden-provider", sudoersPath: "/etc/sudoers.d/nelos-golden-builder-provider", command: `${value.helperPath} provider request` });
    validatePrincipal(value.principals[1], { role: "attestor", user: "nelos-golden-attestor", home: "/var/lib/nelos-golden-attestor", sudoersPath: "/etc/sudoers.d/nelos-golden-builder-attestor", command: `${value.helperPath} attestor request` });
  } else {
    if (value.hostBindingPath !== "/etc/nelos-golden/volume-measurement-binding.json" || value.helperPath !== "/usr/libexec/nelos-proxmox-volume-measure" || !SHA256.test(value.helperDigest ?? "")) fail("INVALID_INSTALL_PLAN", "volume-attestor helper targets differ");
    validatePrincipal(value.principals[0], { role: "attestor", user: "nelosmeasure", home: "/var/lib/nelos-volume-attestor", sudoersPath: "/etc/sudoers.d/nelos-volume-attestor", command: `${value.helperPath} request` });
  }
  return value;
}

function validateMaterials(plan, { hostBinding, hostHelperBytes, guestHelperBytes = null }) {
  const gateway = plan.kind.endsWith("gateway-host-install-plan");
  const volume = plan.kind === "nelos-golden-volume-attestor-host-install-plan";
  const bindingFields = volume
    ? ["buildNonce", "expiresAt", "helperDigest", "node", "outputTemplate", "providerId", "reservationId", "schemaVersion", "sourceTemplate", "storage", "volumeAttestorFingerprint"]
    : gateway
    ? ["attestorKeyFingerprint", "attestorPublicKey", "attestorUser", "expiresAt", "hostBindingDigest", "hostHelperDigest", "kind", "policyBinding", "providerKeyFingerprint", "providerPublicKey", "providerUser", "schemaVersion"]
    : ["attestorKeyFingerprint", "attestorPublicKey", "attestorUser", "cleanupExpiresAt", "expiresAt", "helperDigest", "hostBindingDigest", "kind", "lifecycleBinding", "providerKeyFingerprint", "providerPublicKey", "providerUser", "schemaVersion"];
  exact(hostBinding, bindingFields, "hostBinding");
  if (volume) {
    exact(hostBinding.sourceTemplate, ["name", "vmId"], "hostBinding.sourceTemplate");
    exact(hostBinding.outputTemplate, ["macAddress", "name", "vmId"], "hostBinding.outputTemplate");
    if (hostBinding.schemaVersion !== 1 || hostBinding.providerId !== "proxmox-lab" || hostBinding.node !== "prox2" || hostBinding.storage !== "local-lvm" ||
        hostBinding.helperDigest !== plan.helperDigest || hostBinding.outputTemplate?.vmId !== 9027 || hostBinding.outputTemplate?.macAddress !== "02:4E:45:4C:90:27" ||
        typeof hostBinding.outputTemplate.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u.test(hostBinding.outputTemplate.name) ||
        hostBinding.sourceTemplate?.vmId !== 9024 || typeof hostBinding.sourceTemplate.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u.test(hostBinding.sourceTemplate.name) ||
        typeof hostBinding.reservationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(hostBinding.reservationId) ||
        typeof hostBinding.buildNonce !== "string" || !/^[0-9a-f]{32}$/u.test(hostBinding.buildNonce) || !Number.isFinite(Date.parse(hostBinding.expiresAt)) ||
        hostBinding.volumeAttestorFingerprint !== publicKeyFingerprint(plan.principals[0].authorizedKey) ||
        sha256V1(Buffer.from(`${canonicalJsonV1(hostBinding)}\n`)) !== plan.hostBindingDigest) fail("INSTALL_MATERIAL_MISMATCH", "volume-attestor binding differs from the fixed plan");
  } else if (hostBinding.schemaVersion !== 1 || hostBinding.kind !== (gateway ? "nelos-golden-builder-gateway-host-binding" : "nelos-golden-builder-host-binding") ||
      hostBinding.hostBindingDigest !== plan.hostBindingDigest || (hostBinding.helperDigest ?? hostBinding.hostHelperDigest) !== (plan.helperDigest ?? plan.hostHelperDigest) ||
      hostBinding.providerUser !== plan.principals[0].user || hostBinding.attestorUser !== plan.principals[1].user ||
      !plan.principals[0].authorizedKey.includes(` ${hostBinding.providerPublicKey} nelos:`) || !plan.principals[1].authorizedKey.includes(` ${hostBinding.attestorPublicKey} nelos:`) ||
      (gateway && hostBinding.policyBinding?.helper?.digest !== plan.guestHelperDigest)) fail("INSTALL_MATERIAL_MISMATCH", "host binding differs from the plan");
  if (!volume) { const { hostBindingDigest, ...unsigned } = hostBinding; if (hostBindingDigest !== sha256V1(unsigned)) fail("INSTALL_MATERIAL_MISMATCH", "host binding self-digest differs"); }
  if (!Buffer.isBuffer(hostHelperBytes) || sha256V1(hostHelperBytes) !== (plan.helperDigest ?? plan.hostHelperDigest)) fail("INSTALL_MATERIAL_MISMATCH", "host helper bytes differ from the plan");
  if (plan.kind.endsWith("gateway-host-install-plan") && (!Buffer.isBuffer(guestHelperBytes) || sha256V1(guestHelperBytes) !== plan.guestHelperDigest)) fail("INSTALL_MATERIAL_MISMATCH", "gateway guest helper bytes differ from the plan");
  if (!plan.kind.endsWith("gateway-host-install-plan") && guestHelperBytes !== null) fail("INSTALL_MATERIAL_MISMATCH", "builder-only plan cannot install a guest helper");
  return Object.freeze({
    hostBindingBytes: Buffer.from(`${canonicalJsonV1(hostBinding)}\n`),
    hostHelperBytes: Buffer.from(hostHelperBytes),
    guestHelperBytes: guestHelperBytes === null ? null : Buffer.from(guestHelperBytes),
  });
}

export function createVolumeAttestorHostInstallPlanV1({ hostBinding, helperBytes, publicKey }) {
  if (!Buffer.isBuffer(helperBytes) || !plain(hostBinding) || typeof publicKey !== "string" || /[\r\n]/u.test(publicKey.trim())) fail("INVALID_INSTALL_PLAN", "volume-attestor installation materials are invalid");
  const canonicalPublicKey = publicKey.trim().split(/\s+/u).slice(0, 2).join(" ");
  const helperPath = "/usr/libexec/nelos-proxmox-volume-measure"; const user = "nelosmeasure"; const home = "/var/lib/nelos-volume-attestor";
  const principal = {
    role: "attestor", user, home, shell: "/bin/sh", authorizedKeysPath: `${home}/.ssh/authorized_keys`,
    authorizedKey: `restrict,command="/usr/bin/sudo -n -- ${helperPath} request" ${canonicalPublicKey} nelos:volume-attestor:${hostBinding.reservationId}\n`,
    sudoersPath: "/etc/sudoers.d/nelos-volume-attestor", sudoers: `${user} ALL=(root) NOPASSWD: ${helperPath} request\n`,
  };
  const unsigned = {
    schemaVersion: 1, kind: "nelos-golden-volume-attestor-host-install-plan",
    hostBindingDigest: sha256V1(Buffer.from(`${canonicalJsonV1(hostBinding)}\n`)), hostBindingPath: "/etc/nelos-golden/volume-measurement-binding.json",
    helperDigest: sha256V1(helperBytes), helperPath, principals: [principal],
  };
  const plan = Object.freeze({ ...unsigned, planDigest: sha256V1(unsigned) });
  validateGoldenBuilderHostInstallPlanV1(plan);
  validateMaterials(plan, { hostBinding, hostHelperBytes: helperBytes });
  return plan;
}

function requireRoot(euid) { if (euid() !== 0) fail("ROOT_REQUIRED", "trusted-console host installation requires effective uid 0"); }
function requireBoundary(boundary) {
  const methods = ["beginIntent", "bindPrincipalIdentity", "clearIntent", "installGuestFile", "installHostFile", "installPrincipal", "readIntent", "recordEffect", "removeGuestFile", "removeHostFile", "removePrincipal", "verify"];
  if (!plain(boundary) || methods.some((method) => typeof boundary[method] !== "function")) fail("INVALID_INSTALL_BOUNDARY", "trusted-console boundary is incomplete");
}

function targetIdentity(plan) {
  const gateway = plan.kind.endsWith("gateway-host-install-plan");
  return {
    schemaVersion: 1,
    hostBinding: { path: plan.hostBindingPath, digest: plan.hostBindingDigest, mode: "0400", owner: "root:root" },
    hostHelper: { path: plan.helperPath ?? plan.hostHelperPath, digest: plan.helperDigest ?? plan.hostHelperDigest, mode: "0755", owner: "root:root" },
    guestHelper: gateway ? { vmId: plan.guestVmId, path: plan.guestHelperPath, digest: plan.guestHelperDigest, mode: "0755", owner: "root:root" } : null,
    principals: plan.principals.map(({ role, user, home, authorizedKeysPath, sudoersPath }) => ({ role, user, home, authorizedKeysPath, sudoersPath, locked: true })),
  };
}

function validatePrincipalIdentities(value, plan, { allowPartial = false, label = "principalIdentities" } = {}) {
  if (!Array.isArray(value) || value.length > plan.principals.length) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", `${label} is not a bounded principal identity list`);
  const expected = new Map(plan.principals.map((principal, index) => [principal.role, { ...principal, index }]));
  const seen = new Set(); let previous = -1;
  for (const identity of value) {
    exact(identity, ["gid", "role", "uid", "user"], label);
    const principal = expected.get(identity.role);
    if (!principal || identity.user !== principal.user || seen.has(identity.role) || principal.index <= previous ||
        !Number.isSafeInteger(identity.uid) || identity.uid < 1 || !Number.isSafeInteger(identity.gid) || identity.gid < 1) {
      fail("HOST_INSTALL_RECONCILIATION_REQUIRED", `${label} differs from the exact allocated account identities`);
    }
    seen.add(identity.role); previous = principal.index;
  }
  if (!allowPartial && value.length !== plan.principals.length) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", `${label} does not bind every allocated account identity`);
  return value;
}

async function writeReceipt(path, value) {
  if (!safeAbsolute(path)) fail("UNSAFE_RECEIPT_PATH", "receipt path must be explicit, absolute, and canonical");
  const parentPath = dirname(path); const canonicalParent = await realpath(parentPath).catch(() => null); const parent = await lstat(parentPath).catch(() => null);
  const uid = process.geteuid(); const gid = process.getegid();
  if (canonicalParent !== parentPath || !parent?.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077) !== 0) fail("UNSAFE_RECEIPT_PATH", "receipt parent must be private, process-owned, and canonical");
  const bytes = Buffer.from(`${canonicalJsonV1(value)}\n`);
  await atomicRootFile(path, bytes, 0o400, { uid, gid, rootOwnedParentChain: false });
}

function receipt(plan, action, result, targetsDigest, principalIdentities, now) {
  validatePrincipalIdentities(principalIdentities, plan);
  const unsigned = { schemaVersion: 1, kind: "nelos-golden-builder-host-install-receipt", action, result, planDigest: plan.planDigest, hostBindingDigest: plan.hostBindingDigest, targetsDigest, principalIdentities, completedAt: new Date(now).toISOString() };
  return Object.freeze({ ...unsigned, receiptDigest: sha256V1(unsigned) });
}

function effectIds(plan, action) {
  const host = [
    `host-file:${plan.helperPath ?? plan.hostHelperPath}`,
    `host-file:${plan.hostBindingPath}`,
    ...(plan.guestHelperPath ? [`guest-file:${plan.guestVmId}:${plan.guestHelperPath}`] : []),
  ];
  const principal = plan.principals.flatMap(({ role }) => ["user", "lock", "home", "ssh", "authorized-key", "sudoers", "visudo"].map((part) => `principal:${role}:${part}`));
  if (action === "install") return [...host, ...principal, "receipt"];
  const principalRemoval = [...plan.principals].reverse().flatMap(({ role }) => ["authorized-key", "sudoers", "ssh", "home", "lock", "user"].map((part) => `principal:${role}:${part}`));
  return [...principalRemoval, ...host.reverse(), "receipt"];
}

function validateIntent(intent, plan) {
  exact(intent, ["action", "completedEffects", "hostBindingDigest", "kind", "planDigest", "principalIdentities", "schemaVersion", "targetsDigest"], "hostInstallIntent");
  if (intent.schemaVersion !== 1 || intent.kind !== "nelos-golden-builder-host-install-intent" || intent.planDigest !== plan.planDigest ||
      intent.hostBindingDigest !== plan.hostBindingDigest || !new Set(["install", "remove"]).has(intent.action) || !SHA256.test(intent.targetsDigest ?? "") ||
      !Array.isArray(intent.completedEffects) || new Set(intent.completedEffects).size !== intent.completedEffects.length ||
      intent.completedEffects.some((item) => typeof item !== "string" || !effectIds(plan, intent.action).includes(item))) {
    fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "host installation intent differs from the exact plan or effect graph");
  }
  validatePrincipalIdentities(intent.principalIdentities, plan, { allowPartial: true, label: "hostInstallIntent.principalIdentities" });
  return intent;
}

async function readAdoptableReceipt(path, plan, action, result, targetsDigest, principalIdentities) {
  let info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  const bytes = await readFile(path);
  await recoverAtomicHardlink(path, bytes, 0o400, process.geteuid(), process.getegid(), { rootOwnedParentChain: false });
  info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.geteuid() || info.gid !== process.getegid() || (info.mode & 0o777) !== 0o400 || info.size > 16_384) {
    fail("HOST_RECEIPT_COLLISION", "existing receipt is not one sealed regular file");
  }
  let value;
  try { value = JSON.parse(bytes); } catch { fail("HOST_RECEIPT_COLLISION", "existing receipt is not valid JSON"); }
  exact(value, ["action", "completedAt", "hostBindingDigest", "kind", "planDigest", "principalIdentities", "receiptDigest", "result", "schemaVersion", "targetsDigest"], "hostInstallReceipt");
  validatePrincipalIdentities(value.principalIdentities, plan, { label: "hostInstallReceipt.principalIdentities" });
  const { receiptDigest, ...unsigned } = value;
  if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-builder-host-install-receipt" || value.action !== action || value.result !== result ||
      value.planDigest !== plan.planDigest || value.hostBindingDigest !== plan.hostBindingDigest || value.targetsDigest !== targetsDigest ||
      (principalIdentities !== null && canonicalJsonV1(value.principalIdentities) !== canonicalJsonV1(principalIdentities)) ||
      receiptDigest !== sha256V1(unsigned) || !Number.isFinite(Date.parse(value.completedAt)) ||
      !(await readFile(path)).equals(Buffer.from(`${canonicalJsonV1(value)}\n`))) {
    fail("HOST_RECEIPT_COLLISION", "existing receipt differs from the exact completed operation");
  }
  return Object.freeze(value);
}

async function record(boundary, plan, effect) {
  await boundary.recordEffect({ plan, effect });
}

export async function installGoldenBuilderHostV1({ plan: inputPlan, hostBinding, hostHelperBytes, guestHelperBytes = null, authorizePlan, receiptPath }, { boundary, clock = Date, euid = () => process.geteuid() } = {}) {
  requireRoot(euid); requireBoundary(boundary);
  const plan = validateGoldenBuilderHostInstallPlanV1(inputPlan); const materials = validateMaterials(plan, { hostBinding, hostHelperBytes, guestHelperBytes });
  if (authorizePlan !== plan.planDigest) fail("MUTATION_AUTHORIZATION_REQUIRED", "host installation requires the exact plan digest");
  let intent = await boundary.readIntent({ plan });
  if (intent) intent = validateIntent(intent, plan);
  if (intent && intent.action !== "install") fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "a removal intent must be reconciled before installation");
  const baseline = await boundary.verify({ plan, materials, expectedState: "partial-or-installed" });
  if (!plain(baseline) || baseline.exactOwned !== true) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "host targets cannot be proven as exact plan-owned state");
  if (baseline.state === "installed") {
    const existing = await readAdoptableReceipt(receiptPath, plan, "install", "installed", baseline.targetsDigest, baseline.principalIdentities);
    if (existing) { if (intent) await boundary.clearIntent({ plan }); return existing; }
    if (!intent) fail("HOST_TARGET_COLLISION", "installed host targets have no exact intent or receipt");
  } else if (baseline.state !== "absent" && !intent) {
    fail("HOST_TARGET_COLLISION", "partial host targets have no exact resumable intent");
  }
  if (!intent) {
    await boundary.beginIntent({ plan, targetsDigest: sha256V1(targetIdentity(plan)), action: "install", principalIdentities: [] });
    intent = validateIntent(await boundary.readIntent({ plan }), plan);
  }
  await boundary.installHostFile({ plan, path: plan.helperPath ?? plan.hostHelperPath, bytes: materials.hostHelperBytes, mode: 0o755 });
  await record(boundary, plan, `host-file:${plan.helperPath ?? plan.hostHelperPath}`);
  await boundary.installHostFile({ plan, path: plan.hostBindingPath, bytes: materials.hostBindingBytes, mode: 0o400 });
  await record(boundary, plan, `host-file:${plan.hostBindingPath}`);
  if (materials.guestHelperBytes) {
    await boundary.installGuestFile({ plan, path: plan.guestHelperPath, vmId: plan.guestVmId, bytes: materials.guestHelperBytes, mode: 0o755 });
    await record(boundary, plan, `guest-file:${plan.guestVmId}:${plan.guestHelperPath}`);
  }
  for (const principal of plan.principals) await boundary.installPrincipal({ plan, principal });
  const installed = await boundary.verify({ plan, materials, expectedState: "installed" });
  if (installed?.state !== "installed" || !SHA256.test(installed.targetsDigest ?? "")) fail("HOST_INSTALL_UNPROVEN", "host installation did not verify exactly");
  const existing = await readAdoptableReceipt(receiptPath, plan, "install", "installed", installed.targetsDigest, installed.principalIdentities);
  const value = existing ?? receipt(plan, "install", "installed", installed.targetsDigest, installed.principalIdentities, clock.now());
  if (!existing) await writeReceipt(receiptPath, value);
  await record(boundary, plan, "receipt");
  await boundary.clearIntent({ plan });
  return value;
}

export async function verifyGoldenBuilderHostV1({ plan: inputPlan, hostBinding, hostHelperBytes, guestHelperBytes = null, receiptPath }, { boundary, clock = Date, euid = () => process.geteuid() } = {}) {
  requireRoot(euid); requireBoundary(boundary);
  const plan = validateGoldenBuilderHostInstallPlanV1(inputPlan); const materials = validateMaterials(plan, { hostBinding, hostHelperBytes, guestHelperBytes });
  const installed = await boundary.verify({ plan, materials, expectedState: "installed" });
  if (installed?.state !== "installed" || !SHA256.test(installed.targetsDigest ?? "")) fail("HOST_INSTALL_UNPROVEN", "host installation is not exact");
  const existing = await readAdoptableReceipt(receiptPath, plan, "verify", "installed", installed.targetsDigest, installed.principalIdentities);
  if (existing) return existing;
  const value = receipt(plan, "verify", "installed", installed.targetsDigest, installed.principalIdentities, clock.now()); await writeReceipt(receiptPath, value); return value;
}

export async function removeGoldenBuilderHostV1({ plan: inputPlan, hostBinding, hostHelperBytes, guestHelperBytes = null, authorizePlan, receiptPath }, { boundary, clock = Date, euid = () => process.geteuid() } = {}) {
  requireRoot(euid); requireBoundary(boundary);
  const plan = validateGoldenBuilderHostInstallPlanV1(inputPlan); const materials = validateMaterials(plan, { hostBinding, hostHelperBytes, guestHelperBytes });
  if (authorizePlan !== plan.planDigest) fail("MUTATION_AUTHORIZATION_REQUIRED", "host removal requires the exact plan digest");
  let intent = await boundary.readIntent({ plan });
  if (intent) intent = validateIntent(intent, plan);
  if (intent && intent.action !== "remove") fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "an installation intent must be reconciled before removal");
  const observed = await boundary.verify({ plan, materials, expectedState: "partial-or-installed" });
  if (!plain(observed) || observed.exactOwned !== true) fail("HOST_REMOVAL_UNPROVEN", "host targets cannot be proven as exact plan-owned state");
  if (observed.state === "absent") {
    const existing = await readAdoptableReceipt(receiptPath, plan, "remove", "absent", observed.targetsDigest, intent?.principalIdentities ?? null);
    if (existing) { if (intent) await boundary.clearIntent({ plan }); return existing; }
    if (!intent) fail("HOST_REMOVAL_UNPROVEN", "absent host targets have no exact removal intent or receipt");
  } else if (observed.state !== "installed" && !intent) {
    fail("HOST_REMOVAL_UNPROVEN", "partial host targets have no exact resumable removal intent");
  }
  if (!intent) {
    await boundary.beginIntent({ plan, targetsDigest: observed.targetsDigest, action: "remove", principalIdentities: observed.principalIdentities });
    intent = validateIntent(await boundary.readIntent({ plan }), plan);
  }
  for (const principal of [...plan.principals].reverse()) await boundary.removePrincipal({ plan, principal });
  if (materials.guestHelperBytes) {
    await boundary.removeGuestFile({ plan, path: plan.guestHelperPath, vmId: plan.guestVmId, bytes: materials.guestHelperBytes });
    await record(boundary, plan, `guest-file:${plan.guestVmId}:${plan.guestHelperPath}`);
  }
  await boundary.removeHostFile({ plan, path: plan.hostBindingPath, bytes: materials.hostBindingBytes, mode: 0o400 });
  await record(boundary, plan, `host-file:${plan.hostBindingPath}`);
  await boundary.removeHostFile({ plan, path: plan.helperPath ?? plan.hostHelperPath, bytes: materials.hostHelperBytes, mode: 0o755 });
  await record(boundary, plan, `host-file:${plan.helperPath ?? plan.hostHelperPath}`);
  const absent = await boundary.verify({ plan, materials, expectedState: "absent" });
  if (!plain(absent) || absent.state !== "absent" || !SHA256.test(absent.targetsDigest ?? "")) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "exact host target absence is unproven");
  const existing = await readAdoptableReceipt(receiptPath, plan, "remove", "absent", absent.targetsDigest, intent.principalIdentities);
  const value = existing ?? receipt(plan, "remove", "absent", absent.targetsDigest, intent.principalIdentities, clock.now());
  if (!existing) await writeReceipt(receiptPath, value);
  await record(boundary, plan, "receipt");
  await boundary.clearIntent({ plan });
  return value;
}

export async function reconcileGoldenBuilderHostV1({ plan: inputPlan, hostBinding, hostHelperBytes, guestHelperBytes = null, authorizePlan, receiptPath }, { boundary, clock = Date, euid = () => process.geteuid() } = {}) {
  requireRoot(euid); requireBoundary(boundary);
  const plan = validateGoldenBuilderHostInstallPlanV1(inputPlan); const materials = validateMaterials(plan, { hostBinding, hostHelperBytes, guestHelperBytes });
  if (authorizePlan !== plan.planDigest) fail("MUTATION_AUTHORIZATION_REQUIRED", "host reconciliation requires the exact plan digest");
  const pending = await boundary.readIntent({ plan });
  if (!pending) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "host reconciliation requires one exact pending intent");
  const intent = validateIntent(pending, plan);
  const input = { plan, hostBinding, hostHelperBytes, guestHelperBytes, authorizePlan, receiptPath };
  return intent.action === "install"
    ? installGoldenBuilderHostV1(input, { boundary, clock, euid })
    : removeGoldenBuilderHostV1(input, { boundary, clock, euid });
}

function run(command, args, { input = null, allowFailure = false, maxOutputBytes = 1_048_576, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } });
    const stdout = []; const stderr = []; let length = 0; let timedOut = false; let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const collect = (target) => (chunk) => { length += chunk.length; if (length <= maxOutputBytes) target.push(chunk); else child.kill("SIGKILL"); };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr)); child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); rejectPromise(error); } });
    child.once("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if ((code !== 0 || length > maxOutputBytes || timedOut) && !allowFailure) return rejectPromise(Object.assign(new Error("trusted-console command failed"), { code: timedOut ? "COMMAND_TIMEOUT" : length > maxOutputBytes ? "OUTPUT_LIMIT" : "HOST_COMMAND_FAILED" }));
      resolvePromise(result);
    });
    child.stdin.end(input ?? undefined);
  });
}

async function requireRootOwnedDirectoryChain(path, { createLeaf = false, leafMode = 0o755, exactLeafMode = null } = {}) {
  if (!safeAbsolute(path)) fail("HOST_TARGET_COLLISION", `${path} is not one canonical absolute directory`);
  const parts = path.split("/").filter(Boolean); let current = "/";
  for (const [index, part] of parts.entries()) {
    current = join(current, part); let info = await optionalLstat(current); const leaf = index === parts.length - 1;
    if (!info && createLeaf && leaf) {
      await mkdir(current, { mode: leafMode }); await chmod(current, leafMode); await chown(current, 0, 0); info = await lstat(current);
      await fsyncDirectory(dirname(current));
    }
    if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022) !== 0 ||
        (leaf && exactLeafMode !== null && (info.mode & 0o777) !== exactLeafMode)) {
      fail("HOST_TARGET_COLLISION", `${current} is not an exact root-owned, non-writable directory`);
    }
  }
}

async function requirePrivateOwnedParent(path, uid, gid) {
  const canonicalParent = await realpath(path).catch(() => null); const info = await optionalLstat(path);
  if (canonicalParent !== path || !info?.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.gid !== gid || (info.mode & 0o077) !== 0) {
    fail("HOST_TARGET_COLLISION", `${path} is not one private, exact-owned canonical directory`);
  }
}

async function atomicRootFile(path, bytes, mode, { uid = 0, gid = 0, rootOwnedParentChain = true } = {}) {
  const parent = dirname(path);
  if (rootOwnedParentChain) await requireRootOwnedDirectoryChain(parent, { createLeaf: true });
  else await requirePrivateOwnedParent(parent, uid, gid);
  const temporary = join(parent, `.${basename(path)}.${sha256V1(bytes).slice(7, 23)}.nelos-tmp`);
  const exactEntry = async (candidate, allowedLinks) => {
    const info = await optionalLstat(candidate);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || !allowedLinks.has(info.nlink) || info.uid !== uid || info.gid !== gid ||
        (info.mode & 0o777) !== mode || !(await readFile(candidate)).equals(bytes)) fail("HOST_TARGET_COLLISION", `${candidate} differs from the exact atomic publication`);
    return info;
  };
  let targetInfo = await exactEntry(path, new Set([1, 2])); let temporaryInfo = await exactEntry(temporary, new Set([1, 2]));
  if (targetInfo) {
    if (targetInfo.nlink === 2 && (!temporaryInfo || temporaryInfo.dev !== targetInfo.dev || temporaryInfo.ino !== targetInfo.ino)) fail("HOST_TARGET_COLLISION", `${path} has an unowned hard-link identity`);
    if (targetInfo.nlink === 1 && temporaryInfo && temporaryInfo.nlink !== 1) fail("HOST_TARGET_COLLISION", `${temporary} has an unowned hard-link identity`);
    if (temporaryInfo) await unlinkDurable(temporary);
    targetInfo = await exactEntry(path, new Set([1]));
    if (!targetInfo) fail("HOST_INSTALL_UNPROVEN", `${path} atomic publication did not converge`);
    return;
  }
  if (temporaryInfo && temporaryInfo.nlink !== 1) fail("HOST_TARGET_COLLISION", `${temporary} has an unowned hard-link identity`);
  if (!temporaryInfo) {
    const handle = await open(temporary, "wx", mode);
    try { await handle.writeFile(bytes); await handle.sync(); await handle.chown(uid, gid); await handle.chmod(mode); }
    catch (error) { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
    finally { await handle.close().catch(() => {}); }
  }
  try { await link(temporary, path); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  targetInfo = await exactEntry(path, new Set([1, 2])); temporaryInfo = await exactEntry(temporary, new Set([1, 2]));
  if (!targetInfo || !temporaryInfo || (targetInfo.nlink === 2 && (temporaryInfo.dev !== targetInfo.dev || temporaryInfo.ino !== targetInfo.ino))) {
    fail("HOST_TARGET_COLLISION", `${path} could not adopt its exact atomic publication`);
  }
  await unlinkDurable(temporary);
  if (!(await exactEntry(path, new Set([1])))) fail("HOST_INSTALL_UNPROVEN", `${path} atomic publication did not converge`);
}

async function recoverAtomicHardlink(path, bytes, mode, uid, gid, { rootOwnedParentChain = true } = {}) {
  let info = await optionalLstat(path);
  if (!info || info.nlink !== 2) return;
  const parent = dirname(path);
  if (rootOwnedParentChain) await requireRootOwnedDirectoryChain(parent);
  else await requirePrivateOwnedParent(parent, uid, gid);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.gid !== gid || (info.mode & 0o777) !== mode || !(await readFile(path)).equals(bytes)) {
    fail("HOST_TARGET_COLLISION", `${path} cannot reconcile an unsafe atomic publication`);
  }
  const temporary = join(parent, `.${basename(path)}.${sha256V1(bytes).slice(7, 23)}.nelos-tmp`); const temporaryInfo = await optionalLstat(temporary);
  if (!temporaryInfo?.isFile() || temporaryInfo.isSymbolicLink() || temporaryInfo.nlink !== 2 || temporaryInfo.uid !== uid || temporaryInfo.gid !== gid ||
      (temporaryInfo.mode & 0o777) !== mode || temporaryInfo.dev !== info.dev || temporaryInfo.ino !== info.ino) {
    fail("HOST_TARGET_COLLISION", `${path} has an unowned hard-link identity`);
  }
  await unlinkDurable(temporary); info = await lstat(path);
  if (info.nlink !== 1) fail("HOST_INSTALL_UNPROVEN", `${path} atomic hard-link recovery did not converge`);
}

async function fsyncDirectory(path) {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function unlinkDurable(path) {
  await unlink(path);
  await fsyncDirectory(dirname(path));
}

async function rmdirDurable(path) {
  const parent = dirname(path);
  await rmdir(path);
  await fsyncDirectory(parent);
}

async function replaceRootFile(path, bytes, mode) {
  const parent = dirname(path); await requireRootOwnedDirectoryChain(parent);
  const temporary = join(parent, `.${sha256V1(bytes).slice(7, 23)}.${process.pid}.replace`);
  const handle = await open(temporary, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chown(0, 0); await handle.chmod(mode); } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(parent, "r"); try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function exactFile(path, bytes, mode, { uid = 0, gid = 0 } = {}) {
  const info = await optionalLstat(path); const parent = dirname(path);
  if (!info && !(await optionalLstat(parent))) return false;
  if (uid === 0 && gid === 0) await requireRootOwnedDirectoryChain(parent);
  else await requirePrivateOwnedParent(parent, uid, gid);
  return Boolean(info?.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === uid && info.gid === gid && (info.mode & 0o777) === mode && (await readFile(path)).equals(bytes));
}

async function userRecord(user) {
  const result = await run("/usr/bin/getent", ["passwd", user], { allowFailure: true, maxOutputBytes: 4_096 });
  if (result.code === 2 && result.stdout.length === 0 && result.stderr.length === 0) return null;
  if (result.code !== 0 || result.stderr.length !== 0) fail("HOST_OBSERVATION_AMBIGUOUS", `account ${user} could not be observed exactly`);
  const fields = result.stdout.toString("utf8").trim().split(":");
  if (fields.length !== 7 || fields[0] !== user) fail("HOST_OBSERVATION_AMBIGUOUS", `account ${user} record is malformed`);
  return fields;
}

async function groupRecord(group) {
  const result = await run("/usr/bin/getent", ["group", group], { allowFailure: true, maxOutputBytes: 4_096 });
  if (result.code === 2 && result.stdout.length === 0 && result.stderr.length === 0) return null;
  if (result.code !== 0 || result.stderr.length !== 0) fail("HOST_OBSERVATION_AMBIGUOUS", `group ${group} could not be observed exactly`);
  const fields = result.stdout.toString("utf8").trim().split(":");
  if (fields.length !== 4 || fields[0] !== group) fail("HOST_OBSERVATION_AMBIGUOUS", `group ${group} record is malformed`);
  return fields;
}

async function userPasswordLocked(user) {
  const result = await run("/usr/bin/passwd", ["-S", user], { allowFailure: true, maxOutputBytes: 4_096 });
  const fields = result.stdout.toString("utf8").trim().split(/\s+/u);
  if (result.code !== 0 || result.stderr.length !== 0 || fields[0] !== user || !fields[1]) fail("HOST_OBSERVATION_AMBIGUOUS", `password state for ${user} could not be observed exactly`);
  return new Set(["L", "LK"]).has(fields[1]);
}

async function requireNoSupplementaryGroups(user, primaryGid) {
  const result = await run("/usr/bin/id", ["-G", user], { allowFailure: true, maxOutputBytes: 4_096 });
  const fields = result.stdout.toString("utf8").trim().split(/\s+/u).filter(Boolean);
  const gids = fields.map((value) => Number(value));
  if (result.code !== 0 || result.stderr.length !== 0 || gids.length < 1 || gids.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      new Set(gids).size !== 1 || gids[0] !== primaryGid) fail("HOST_OBSERVATION_AMBIGUOUS", `supplementary groups for ${user} differ or cannot be observed exactly`);
}

async function requireNoOwnedProcesses(user) {
  const result = await run("/usr/bin/pgrep", ["-u", user], { allowFailure: true, maxOutputBytes: 65_536 });
  if (result.code === 1 && result.stdout.length === 0 && result.stderr.length === 0) return;
  if (result.code === 0) fail("HOST_REMOVAL_UNPROVEN", `${user} still owns one or more processes`);
  fail("HOST_OBSERVATION_AMBIGUOUS", `process ownership for ${user} cannot be observed exactly`);
}

function parseQgaExecution(result, label) {
  if (result.code !== 0 || result.stderr.length !== 0) fail("GATEWAY_GUEST_OBSERVATION_AMBIGUOUS", `${label} failed at the Proxmox/QGA transport boundary`);
  let value;
  try { value = JSON.parse(result.stdout); } catch { fail("GATEWAY_GUEST_OBSERVATION_AMBIGUOUS", `${label} returned malformed Proxmox/QGA JSON`); }
  const allowed = new Set(["err-data", "exitcode", "exited", "out-data"]);
  if (!plain(value) || Object.keys(value).some((key) => !allowed.has(key)) || value.exited !== 1 || !Number.isSafeInteger(value.exitcode) ||
      (value["out-data"] !== undefined && typeof value["out-data"] !== "string") || (value["err-data"] !== undefined && typeof value["err-data"] !== "string") ||
      Buffer.byteLength(value["out-data"] ?? "") + Buffer.byteLength(value["err-data"] ?? "") > 65_536) {
    fail("GATEWAY_GUEST_OBSERVATION_AMBIGUOUS", `${label} returned an ambiguous Proxmox/QGA result`);
  }
  if (value.exitcode !== 0 || (value["err-data"] ?? "") !== "") fail("GATEWAY_GUEST_OBSERVATION_AMBIGUOUS", `${label} did not complete exactly inside the gateway guest`);
  return value["out-data"] ?? "";
}

async function guestObservation(vmId, path, mode = 0o755, runCommand = run) {
  const script = [
    "import hashlib,json,os,pathlib,stat,sys",
    "p=pathlib.Path(sys.argv[1])",
    "q=p.parent",
    "while True:",
    " s=q.lstat()",
    " if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)&0o022: raise RuntimeError('unsafe parent chain')",
    " if q.parent==q: break",
    " q=q.parent",
    "try:",
    " s=p.lstat()",
    "except FileNotFoundError:",
    " print(json.dumps({'state':'absent'},sort_keys=True,separators=(',',':')));sys.exit(0)",
    "if not stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode): raise RuntimeError('unsafe target type')",
    "d=hashlib.sha256(p.read_bytes()).hexdigest()",
    "print(json.dumps({'digest':'sha256:'+d,'gid':s.st_gid,'mode':format(stat.S_IMODE(s.st_mode),'04o'),'nlink':s.st_nlink,'state':'present','uid':s.st_uid},sort_keys=True,separators=(',',':')))",
  ].join("\n");
  const result = await runCommand("/usr/sbin/qm", ["guest", "exec", String(vmId), "--", "/usr/bin/python3", "-c", script, path], { allowFailure: true, timeoutMs: 60_000 });
  const output = parseQgaExecution(result, "gateway guest helper observation");
  let value;
  try { value = JSON.parse(output); } catch { fail("GATEWAY_GUEST_OBSERVATION_AMBIGUOUS", "gateway guest helper observation output is malformed"); }
  if (value?.state === "absent" && Object.keys(value).length === 1 && output === `${canonicalJsonV1(value)}\n`) return Object.freeze({ state: "absent", exact: true });
  if (plain(value) && Object.keys(value).sort().join("\0") === ["digest", "gid", "mode", "nlink", "state", "uid"].sort().join("\0") && value.state === "present" &&
      SHA256.test(value.digest ?? "") && value.uid === 0 && value.gid === 0 && value.nlink === 1 && value.mode === mode.toString(8).padStart(4, "0") &&
      output === `${canonicalJsonV1(value)}\n`) return Object.freeze({ ...value, exact: true });
  fail("GATEWAY_GUEST_OBSERVATION_AMBIGUOUS", "gateway guest helper observation is neither exact absence nor one safe regular file");
}

export async function observeGoldenGatewayGuestHelperV1({ vmId, path, mode = 0o755 }, { runCommand } = {}) {
  if (vmId !== 9023 || path !== "/usr/libexec/nelos-golden-gateway-policy" || mode !== 0o755 || (runCommand !== undefined && typeof runCommand !== "function")) {
    fail("INVALID_INSTALL_PLAN", "gateway guest observation target differs from the fixed helper identity");
  }
  return guestObservation(vmId, path, mode, runCommand ?? run);
}

export class LocalGoldenBuilderHostBoundaryV1 {
  constructor({ runCommand = run } = {}) { if (typeof runCommand !== "function") fail("INVALID_INSTALL_BOUNDARY", "trusted-console command boundary is invalid"); this.runCommand = runCommand; }
  #intent(plan) { return join(INTENT_ROOT, `${plan.planDigest.slice(7)}.intent.json`); }
  async beginIntent({ plan, targetsDigest, action, principalIdentities }) {
    await requireRootOwnedDirectoryChain(INTENT_ROOT, { createLeaf: true, leafMode: 0o700, exactLeafMode: 0o700 });
    validatePrincipalIdentities(principalIdentities, plan, { allowPartial: true, label: "new host intent principalIdentities" });
    const path = this.#intent(plan); const value = { schemaVersion: 1, kind: "nelos-golden-builder-host-install-intent", action, completedEffects: [], planDigest: plan.planDigest, hostBindingDigest: plan.hostBindingDigest, principalIdentities, targetsDigest };
    const bytes = Buffer.from(`${canonicalJsonV1(value)}\n`);
    await atomicRootFile(path, bytes, 0o400);
    validateIntent(await this.readIntent({ plan }), plan);
  }
  async readIntent({ plan }) {
    let bytes;
    try { bytes = await readFile(this.#intent(plan)); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    await recoverAtomicHardlink(this.#intent(plan), bytes, 0o400, 0, 0);
    const info = await lstat(this.#intent(plan));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o777) !== 0o400 || bytes.length > 65_536) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "host installation intent is not sealed");
    try { return validateIntent(JSON.parse(bytes), plan); } catch (error) { if (error instanceof GoldenBuilderHostInstallerError) throw error; fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "host installation intent is malformed"); }
  }
  async recordEffect({ plan, effect }) {
    const intent = validateIntent(await this.readIntent({ plan }), plan); const order = effectIds(plan, intent.action);
    if (!order.includes(effect)) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", `effect ${effect} is not in the sealed operation graph`);
    if (intent.completedEffects.includes(effect)) return;
    const index = order.indexOf(effect); const completedIndexes = intent.completedEffects.map((item) => order.indexOf(item));
    if (completedIndexes.some((item) => item > index)) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "host effect journal order is inconsistent");
    const next = { ...intent, completedEffects: [...intent.completedEffects, effect] };
    await replaceRootFile(this.#intent(plan), Buffer.from(`${canonicalJsonV1(next)}\n`), 0o400);
  }
  async bindPrincipalIdentity({ plan, principal, uid, gid }) {
    const intent = validateIntent(await this.readIntent({ plan }), plan);
    if (intent.action !== "install") fail("HOST_INSTALL_RECONCILIATION_REQUIRED", "principal allocation can only be bound during installation");
    const identity = { role: principal.role, user: principal.user, uid, gid };
    validatePrincipalIdentities([identity], plan, { allowPartial: true, label: "allocated principal identity" });
    const existing = intent.principalIdentities.find((item) => item.role === principal.role);
    if (existing) {
      if (canonicalJsonV1(existing) !== canonicalJsonV1(identity)) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", `${principal.user} allocated uid/gid differs from its sealed intent`);
      return;
    }
    const expectedIndex = plan.principals.findIndex((item) => item.role === principal.role);
    if (intent.principalIdentities.length !== expectedIndex) fail("HOST_INSTALL_RECONCILIATION_REQUIRED", `${principal.user} allocation is out of sealed principal order`);
    const next = { ...intent, principalIdentities: [...intent.principalIdentities, identity] };
    await replaceRootFile(this.#intent(plan), Buffer.from(`${canonicalJsonV1(next)}\n`), 0o400);
  }
  async clearIntent({ plan }) {
    await unlink(this.#intent(plan)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    const info = await optionalLstat(INTENT_ROOT); if (info?.isDirectory()) { const directory = await open(INTENT_ROOT, "r"); try { await directory.sync(); } finally { await directory.close(); } }
  }
  async installHostFile({ path, bytes, mode }) {
    await atomicRootFile(path, bytes, mode);
    if (!(await exactFile(path, bytes, mode))) fail("HOST_INSTALL_UNPROVEN", `${path} atomic installation is unproven`);
  }
  async removeHostFile({ path, bytes, mode }) {
    const info = await lstat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (!(await exactFile(path, bytes, mode))) fail("HOST_REMOVAL_UNPROVEN", `${path} differs before removal`);
    await unlinkDurable(path);
  }
  async installPrincipal({ plan, principal }) {
    const prefix = `principal:${principal.role}`;
    let recordValue = await userRecord(principal.user); let groupValue = await groupRecord(principal.user);
    if (!recordValue && !groupValue) {
      await run("/usr/sbin/useradd", ["--system", "--user-group", "--no-create-home", "--home-dir", principal.home, "--shell", principal.shell, principal.user]);
      recordValue = await userRecord(principal.user); groupValue = await groupRecord(principal.user);
    }
    let uid = Number(recordValue?.[2]); let gid = Number(recordValue?.[3]);
    if (!recordValue || !groupValue || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || recordValue[5] !== principal.home || recordValue[6] !== principal.shell ||
        Number(groupValue[2]) !== gid || groupValue[3] !== "") fail("HOST_TARGET_COLLISION", `${principal.user} account or private group differs`);
    await requireNoSupplementaryGroups(principal.user, gid);
    await this.bindPrincipalIdentity({ plan, principal, uid, gid });
    await this.recordEffect({ plan, effect: `${prefix}:user` });
    if (!(await userPasswordLocked(principal.user))) await run("/usr/sbin/usermod", ["--lock", principal.user]);
    if (!(await userPasswordLocked(principal.user))) fail("HOST_INSTALL_UNPROVEN", `${principal.user} locked identity is unproven`);
    await this.recordEffect({ plan, effect: `${prefix}:lock` });
    const homeInfo = await lstat(principal.home).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!homeInfo) { await mkdir(principal.home, { mode: 0o700 }); await chmod(principal.home, 0o700); await chown(principal.home, uid, gid); }
    else if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink() || homeInfo.uid !== uid || homeInfo.gid !== gid || (homeInfo.mode & 0o777) !== 0o700) fail("HOST_TARGET_COLLISION", `${principal.home} differs`);
    await this.recordEffect({ plan, effect: `${prefix}:home` });
    const sshDir = dirname(principal.authorizedKeysPath); const sshInfo = await lstat(sshDir).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!sshInfo) { await mkdir(sshDir, { mode: 0o700 }); await chmod(sshDir, 0o700); await chown(sshDir, uid, gid); }
    else if (!sshInfo.isDirectory() || sshInfo.isSymbolicLink() || sshInfo.uid !== uid || sshInfo.gid !== gid || (sshInfo.mode & 0o777) !== 0o700) fail("HOST_TARGET_COLLISION", `${sshDir} differs`);
    await this.recordEffect({ plan, effect: `${prefix}:ssh` });
    const authorizedBytes = Buffer.from(principal.authorizedKey); await atomicRootFile(principal.authorizedKeysPath, authorizedBytes, 0o600, { uid, gid, rootOwnedParentChain: false });
    if (!(await exactFile(principal.authorizedKeysPath, authorizedBytes, 0o600, { uid, gid }))) fail("HOST_INSTALL_UNPROVEN", `${principal.authorizedKeysPath} atomic installation is unproven`);
    await this.recordEffect({ plan, effect: `${prefix}:authorized-key` });
    const sudoersBytes = Buffer.from(principal.sudoers); await atomicRootFile(principal.sudoersPath, sudoersBytes, 0o440);
    if (!(await exactFile(principal.sudoersPath, sudoersBytes, 0o440))) fail("HOST_INSTALL_UNPROVEN", `${principal.sudoersPath} atomic installation is unproven`);
    await this.recordEffect({ plan, effect: `${prefix}:sudoers` });
    await run("/usr/sbin/visudo", ["-cf", principal.sudoersPath]);
    await this.recordEffect({ plan, effect: `${prefix}:visudo` });
  }
  async removePrincipal({ plan, principal }) {
    const prefix = `principal:${principal.role}`;
    let recordValue = await userRecord(principal.user); let groupValue = await groupRecord(principal.user);
    const uid = Number(recordValue?.[2]); const gid = Number(recordValue?.[3]);
    if (recordValue && (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || recordValue[5] !== principal.home || recordValue[6] !== principal.shell || !(await userPasswordLocked(principal.user)))) fail("HOST_REMOVAL_UNPROVEN", `${principal.user} account differs before removal`);
    if (groupValue && (groupValue[0] !== principal.user || groupValue[3] !== "" || (recordValue && Number(groupValue[2]) !== gid))) fail("HOST_REMOVAL_UNPROVEN", `${principal.user} private group differs before removal`);
    if (recordValue) await requireNoSupplementaryGroups(principal.user, gid);
    const home = await lstat(principal.home).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const sshDir = dirname(principal.authorizedKeysPath); const ssh = await lstat(sshDir).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const auth = await lstat(principal.authorizedKeysPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const sudo = await lstat(principal.sudoersPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if ((home && (!recordValue || !home.isDirectory() || home.isSymbolicLink() || home.uid !== uid || home.gid !== gid || (home.mode & 0o777) !== 0o700)) ||
        (ssh && (!recordValue || !ssh.isDirectory() || ssh.isSymbolicLink() || ssh.uid !== uid || ssh.gid !== gid || (ssh.mode & 0o777) !== 0o700)) ||
        (auth && (!recordValue || !(await exactFile(principal.authorizedKeysPath, Buffer.from(principal.authorizedKey), 0o600, { uid, gid })))) ||
        (sudo && !(await exactFile(principal.sudoersPath, Buffer.from(principal.sudoers), 0o440)))) fail("HOST_REMOVAL_UNPROVEN", `${principal.user} authority differs before removal`);
    if (home) {
      const allowed = new Set([".ssh"]); const homeNames = new Set(await readdir(principal.home));
      if ([...homeNames].some((name) => !allowed.has(name))) fail("HOST_REMOVAL_UNPROVEN", `${principal.home} contains unowned content`);
    }
    if (ssh) {
      const allowed = new Set(auth ? ["authorized_keys"] : []); const sshNames = new Set(await readdir(sshDir));
      if (sshNames.size !== allowed.size || [...sshNames].some((name) => !allowed.has(name))) fail("HOST_REMOVAL_UNPROVEN", `${sshDir} contains unowned content`);
    }
    if (auth) await unlinkDurable(principal.authorizedKeysPath);
    await this.recordEffect({ plan, effect: `${prefix}:authorized-key` });
    if (sudo) await unlinkDurable(principal.sudoersPath);
    await this.recordEffect({ plan, effect: `${prefix}:sudoers` });
    if (ssh) await rmdirDurable(sshDir);
    await this.recordEffect({ plan, effect: `${prefix}:ssh` });
    if (home) await rmdirDurable(principal.home);
    await this.recordEffect({ plan, effect: `${prefix}:home` });
    await this.recordEffect({ plan, effect: `${prefix}:lock` });
    if (recordValue) { await requireNoOwnedProcesses(principal.user); await run("/usr/sbin/userdel", [principal.user]); }
    recordValue = await userRecord(principal.user); groupValue = await groupRecord(principal.user);
    if (recordValue) fail("HOST_REMOVAL_UNPROVEN", `${principal.user} account remains after deletion`);
    if (groupValue) { if (groupValue[3] !== "") fail("HOST_REMOVAL_UNPROVEN", `${principal.user} group gained members during cleanup`); await run("/usr/sbin/groupdel", [principal.user]); }
    if (await groupRecord(principal.user)) fail("HOST_REMOVAL_UNPROVEN", `${principal.user} private group remains after deletion`);
    await this.recordEffect({ plan, effect: `${prefix}:user` });
  }
  async installGuestFile({ vmId, path, bytes, mode }) {
    const before = await guestObservation(vmId, path, mode, this.runCommand);
    if (before.state === "present") { if (before.digest === sha256V1(bytes)) return; fail("HOST_TARGET_COLLISION", "gateway guest helper already exists with different identity"); }
    const script = "import base64,hashlib,os,pathlib,sys,tempfile;p=pathlib.Path(sys.argv[1]);b=base64.b64decode(sys.argv[2],validate=True);d=sys.argv[3];assert 'sha256:'+hashlib.sha256(b).hexdigest()==d;p.parent.mkdir(parents=True,exist_ok=True);fd,t=tempfile.mkstemp(prefix='.'+p.name+'.',dir=p.parent);f=os.fdopen(fd,'wb');f.write(b);f.flush();os.fsync(f.fileno());os.fchmod(f.fileno(),int(sys.argv[4],8));os.fchown(f.fileno(),0,0);f.close();os.replace(t,p);q=os.open(p.parent,os.O_RDONLY);os.fsync(q);os.close(q);print('{\"installed\":true}')";
    const result = await this.runCommand("/usr/sbin/qm", ["guest", "exec", String(vmId), "--", "/usr/bin/python3", "-c", script, path, bytes.toString("base64"), sha256V1(bytes), mode.toString(8)], { allowFailure: true, timeoutMs: 60_000 });
    if (parseQgaExecution(result, "gateway guest helper installation") !== "{\"installed\":true}\n") fail("GATEWAY_GUEST_OBSERVATION_AMBIGUOUS", "gateway guest helper install acknowledgment differs");
    const after = await guestObservation(vmId, path, mode, this.runCommand);
    if (after.state !== "present" || after.digest !== sha256V1(bytes)) fail("HOST_INSTALL_UNPROVEN", "gateway guest helper installation is unproven");
  }
  async removeGuestFile({ vmId, path, bytes }) {
    const before = await guestObservation(vmId, path, 0o755, this.runCommand);
    if (before.state === "absent") return;
    if (before.digest !== sha256V1(bytes)) fail("HOST_REMOVAL_UNPROVEN", "gateway guest helper differs before removal");
    const script = "import json,os,pathlib,stat,sys;p=pathlib.Path(sys.argv[1]);s=p.lstat();assert stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and s.st_gid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o755;p.unlink();q=os.open(p.parent,os.O_RDONLY);os.fsync(q);os.close(q);print('{\"removed\":true}')";
    const result = await this.runCommand("/usr/sbin/qm", ["guest", "exec", String(vmId), "--", "/usr/bin/python3", "-c", script, path], { allowFailure: true, timeoutMs: 60_000 });
    if (parseQgaExecution(result, "gateway guest helper removal") !== "{\"removed\":true}\n") fail("GATEWAY_GUEST_OBSERVATION_AMBIGUOUS", "gateway guest helper removal acknowledgment differs");
    const after = await guestObservation(vmId, path, 0o755, this.runCommand);
    if (after.state !== "absent") fail("HOST_REMOVAL_UNPROVEN", "gateway guest helper exact post-removal absence is unproven");
  }
  async verify({ plan, materials, expectedState }) {
    const hostItems = [
      [plan.helperPath ?? plan.hostHelperPath, materials.hostHelperBytes, 0o755],
      [plan.hostBindingPath, materials.hostBindingBytes, 0o400],
    ];
    const fileStates = await Promise.all(hostItems.map(async ([path, bytes, mode]) => ({ path, exists: Boolean(await optionalLstat(path)), exact: await exactFile(path, bytes, mode) })));
    const principalStates = await Promise.all(plan.principals.map(async (principal) => {
      const record = await userRecord(principal.user); const group = await groupRecord(principal.user); const homeInfo = await optionalLstat(principal.home); const sshInfo = await optionalLstat(dirname(principal.authorizedKeysPath)); const authInfo = await optionalLstat(principal.authorizedKeysPath); const sudoInfo = await optionalLstat(principal.sudoersPath);
      const uid = record ? Number(record[2]) : 0; const gid = record ? Number(record[3]) : 0;
      const locked = record ? await userPasswordLocked(principal.user) : false;
      let groupsExact = false;
      if (record && group && Number.isSafeInteger(gid)) { try { await requireNoSupplementaryGroups(principal.user, gid); groupsExact = true; } catch (error) { if (!(error instanceof GoldenBuilderHostInstallerError)) throw error; } }
      const identityExact = !record && !group || Boolean(record && group && Number.isSafeInteger(uid) && Number.isSafeInteger(gid) && record[5] === principal.home && record[6] === principal.shell && locked && Number(group[2]) === gid && group[3] === "" && groupsExact);
      const homeExact = !homeInfo || Boolean(record && homeInfo.isDirectory() && !homeInfo.isSymbolicLink() && homeInfo.uid === uid && homeInfo.gid === gid && (homeInfo.mode & 0o777) === 0o700);
      const sshExact = !sshInfo || Boolean(record && sshInfo.isDirectory() && !sshInfo.isSymbolicLink() && sshInfo.uid === uid && sshInfo.gid === gid && (sshInfo.mode & 0o777) === 0o700);
      const authExact = !authInfo || await exactFile(principal.authorizedKeysPath, Buffer.from(principal.authorizedKey), 0o600, { uid, gid });
      const sudoExact = !sudoInfo || await exactFile(principal.sudoersPath, Buffer.from(principal.sudoers), 0o440);
      return { role: principal.role, user: principal.user, uid: record ? uid : null, gid: record ? gid : null, exists: Boolean(record || group || homeInfo || sshInfo || authInfo || sudoInfo), exact: Boolean(identityExact && homeExact && sshExact && authExact && sudoExact), complete: Boolean(record && group && locked && homeInfo && sshInfo && authInfo && sudoInfo && identityExact && homeExact && sshExact && authExact && sudoExact) };
    }));
    const guest = materials.guestHelperBytes ? await guestObservation(plan.guestVmId, plan.guestHelperPath, 0o755, this.runCommand) : null;
    const present = [...fileStates.map(({ exists }) => exists), ...principalStates.map(({ exists }) => exists), ...(materials.guestHelperBytes ? [guest.state === "present"] : [])];
    const exacts = [...fileStates.map(({ exact: value }) => value), ...principalStates.map(({ exact: value }) => value), ...(materials.guestHelperBytes ? [guest.state === "absent" || guest.digest === plan.guestHelperDigest] : [])];
    const state = present.every((value) => !value) ? "absent" : fileStates.every(({ exact: value }) => value) && principalStates.every(({ complete }) => complete) && (!materials.guestHelperBytes || guest.state === "present" && guest.digest === plan.guestHelperDigest) ? "installed" : "partial";
    const exactOwned = present.every((value, index) => !value || exacts[index]);
    if (expectedState === "absent" && state !== "absent" || expectedState === "installed" && state !== "installed" || expectedState === "partial-or-installed" && !exactOwned) fail("HOST_STATE_MISMATCH", `host state is ${state}, expected ${expectedState}`);
    const principalIdentities = principalStates.filter(({ uid, gid }) => Number.isSafeInteger(uid) && Number.isSafeInteger(gid)).map(({ role, user, uid, gid }) => ({ role, user, uid, gid }));
    if (state === "installed") validatePrincipalIdentities(principalIdentities, plan);
    return { state, exactOwned, principalIdentities, targetsDigest: sha256V1({ schemaVersion: 1, state, targets: targetIdentity(plan), principalIdentities }) };
  }
}
