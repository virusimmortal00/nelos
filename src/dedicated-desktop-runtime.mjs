import { timingSafeEqual } from "node:crypto";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ABSOLUTE_PATH = /^\/(?:[^/\0]+\/)*[^/\0]*$/u;

export const DEDICATED_DESKTOP_SCHEMA_VERSION = 1;
export const DEDICATED_DESKTOP_MARKER = "nelos-dedicated-desktop-worker";
export const DEDICATED_DESKTOP_ACTIONS = Object.freeze([
  "install",
  "restart",
  "upgrade",
  "cancel",
  "crash-recovery",
  "cleanup",
  "rollback",
  "reimage",
]);

const QUARANTINE_CODES = new Set([
  "AMBIGUOUS_MUTATION",
  "CLEANUP_FAILED",
  "CRASH_LOOP",
  "GOLDEN_IMAGE_MISMATCH",
  "PLUGIN_DRIFT",
  "PROFILE_DRIFT",
  "SOCKET_MISMATCH",
  "UNEXPECTED_TASK",
]);

export class DedicatedDesktopRuntimeError extends Error {
  constructor(code, message, { path = "", quarantine = false, cause } = {}) {
    super(message, { cause });
    this.name = "DedicatedDesktopRuntimeError";
    this.code = code;
    this.path = path;
    this.quarantine = quarantine || QUARANTINE_CODES.has(code);
  }
}

function fail(code, message, path = "", quarantine = false) {
  throw new DedicatedDesktopRuntimeError(code, message, { path, quarantine });
}

function record(value, required, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CONTRACT", "expected an object", path);
  }
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("INVALID_CONTRACT", "object fields do not match the closed contract", path);
  }
  return value;
}

function string(value, path, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("INVALID_CONTRACT", "invalid string identity", path);
  }
  return value;
}

function integer(value, path, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("INVALID_CONTRACT", "invalid integer identity", path);
  }
  return value;
}

function exactEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function validateTarget(target, path = "/target") {
  record(target, [
    "appPid", "backendPid", "bundleId", "bundlePath", "socketOwnerPid", "socketPath",
  ], path);
  string(target.bundleId, `${path}/bundleId`);
  string(target.bundlePath, `${path}/bundlePath`, ABSOLUTE_PATH);
  integer(target.appPid, `${path}/appPid`);
  integer(target.backendPid, `${path}/backendPid`);
  string(target.socketPath, `${path}/socketPath`, ABSOLUTE_PATH);
  integer(target.socketOwnerPid, `${path}/socketOwnerPid`);
  if (target.socketOwnerPid !== target.backendPid) {
    fail("SOCKET_MISMATCH", "socket owner is not the leased backend", `${path}/socketOwnerPid`);
  }
  return target;
}

function validatePluginLock(plugin, path = "/plugin") {
  record(plugin, ["artifactDigest", "lockDigest", "pluginId", "version"], path);
  string(plugin.pluginId, `${path}/pluginId`);
  string(plugin.version, `${path}/version`, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u);
  string(plugin.artifactDigest, `${path}/artifactDigest`, SHA256);
  string(plugin.lockDigest, `${path}/lockDigest`, SHA256);
  return plugin;
}

function validateLease(lease, path = "/lease") {
  record(lease, [
    "action", "appPid", "backendPid", "bundleId", "bundlePath", "expiresAt", "fencingToken",
    "hostId", "leaseId", "mutating", "runtimeLockDigest", "socketOwnerPid", "socketPath", "state",
  ], path);
  string(lease.leaseId, `${path}/leaseId`);
  string(lease.hostId, `${path}/hostId`);
  string(lease.fencingToken, `${path}/fencingToken`);
  string(lease.runtimeLockDigest, `${path}/runtimeLockDigest`, SHA256);
  if (!DEDICATED_DESKTOP_ACTIONS.includes(lease.action)) fail("INVALID_ACTION", "unsupported lease action", `${path}/action`);
  if (lease.mutating !== true || lease.state !== "active") fail("LEASE_NOT_CURRENT", "lease is not an active mutating lease", path);
  string(lease.bundleId, `${path}/bundleId`);
  string(lease.bundlePath, `${path}/bundlePath`, ABSOLUTE_PATH);
  integer(lease.appPid, `${path}/appPid`);
  integer(lease.backendPid, `${path}/backendPid`);
  string(lease.socketPath, `${path}/socketPath`, ABSOLUTE_PATH);
  integer(lease.socketOwnerPid, `${path}/socketOwnerPid`);
  if (lease.socketOwnerPid !== lease.backendPid) fail("SOCKET_MISMATCH", "leased socket owner is not the leased backend", `${path}/socketOwnerPid`);
  if (typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt))) {
    fail("INVALID_CONTRACT", "lease expiration must be an ISO timestamp", `${path}/expiresAt`);
  }
  return lease;
}

export function validateDedicatedDesktopWorker(worker) {
  record(worker, [
    "automation", "currentLease", "goldenImage", "hostId", "isolation", "marker",
    "pluginLock", "runtimeClass", "schemaVersion", "state", "target",
  ], "/worker");
  if (worker.schemaVersion !== DEDICATED_DESKTOP_SCHEMA_VERSION) fail("INVALID_CONTRACT", "unsupported worker schema", "/worker/schemaVersion");
  if (worker.runtimeClass !== "desktop-macos") fail("HEADLESS_EVIDENCE", "Desktop gates require the desktop-macos runtime", "/worker/runtimeClass");
  string(worker.hostId, "/worker/hostId");
  if (!["ready", "leased", "draining", "quarantined"].includes(worker.state)) fail("INVALID_CONTRACT", "invalid worker state", "/worker/state");

  record(worker.marker, ["dedicated", "issuedAt", "kind", "signatureDigest", "workerId"], "/worker/marker");
  if (worker.marker.kind !== DEDICATED_DESKTOP_MARKER || worker.marker.dedicated !== true || worker.marker.workerId !== worker.hostId) {
    fail("DEDICATED_MARKER_REQUIRED", "dedicated-worker marker does not identify this host", "/worker/marker");
  }
  string(worker.marker.signatureDigest, "/worker/marker/signatureDigest", SHA256);
  if (!Number.isFinite(Date.parse(worker.marker.issuedAt))) fail("INVALID_CONTRACT", "marker issuance is invalid", "/worker/marker/issuedAt");

  record(worker.goldenImage, ["digest", "generation", "imageId", "signatureDigest"], "/worker/goldenImage");
  string(worker.goldenImage.imageId, "/worker/goldenImage/imageId");
  string(worker.goldenImage.digest, "/worker/goldenImage/digest", SHA256);
  string(worker.goldenImage.signatureDigest, "/worker/goldenImage/signatureDigest", SHA256);
  integer(worker.goldenImage.generation, "/worker/goldenImage/generation");

  record(worker.automation, ["codexHome", "credentialRef", "home", "uid", "user"], "/worker/automation");
  string(worker.automation.user, "/worker/automation/user", /^[a-z_][a-z0-9_-]{0,31}$/u);
  integer(worker.automation.uid, "/worker/automation/uid", 501);
  string(worker.automation.home, "/worker/automation/home", ABSOLUTE_PATH);
  string(worker.automation.codexHome, "/worker/automation/codexHome", ABSOLUTE_PATH);
  if (worker.automation.home !== `/Users/${worker.automation.user}` || !isWithin(worker.automation.codexHome, worker.automation.home)) {
    fail("DEVELOPMENT_STATE_REACHABLE", "automation homes must be rooted in the dedicated OS account", "/worker/automation");
  }
  if (worker.automation.credentialRef !== `keychain://${worker.automation.user}/nelos-benchmark`) {
    fail("DEVELOPMENT_STATE_REACHABLE", "benchmark credentials must use the dedicated keychain identity", "/worker/automation/credentialRef");
  }

  record(worker.isolation, [
    "addressableHomes", "developmentStateReachable", "fastUserSwitching", "interactiveHumanUse", "mountedWritableRoots",
  ], "/worker/isolation");
  if (
    worker.isolation.developmentStateReachable !== false ||
    worker.isolation.fastUserSwitching !== false ||
    worker.isolation.interactiveHumanUse !== false ||
    !Array.isArray(worker.isolation.addressableHomes) ||
    worker.isolation.addressableHomes.length !== 1 ||
    worker.isolation.addressableHomes[0] !== worker.automation.home ||
    !Array.isArray(worker.isolation.mountedWritableRoots) ||
    worker.isolation.mountedWritableRoots.length !== 1 ||
    worker.isolation.mountedWritableRoots[0] !== worker.automation.home
  ) {
    fail("DEVELOPMENT_STATE_REACHABLE", "development homes or profiles are addressable", "/worker/isolation");
  }

  validateTarget(worker.target, "/worker/target");
  if (!isWithin(worker.target.bundlePath, worker.automation.home) || !isWithin(worker.target.socketPath, worker.automation.home)) {
    fail("DEVELOPMENT_STATE_REACHABLE", "Desktop target escapes the automation home", "/worker/target");
  }
  validatePluginLock(worker.pluginLock, "/worker/pluginLock");
  validateLease(worker.currentLease, "/worker/currentLease");
  return worker;
}

function validateObservation(observed, worker) {
  record(observed, [
    "crashCount", "expectedProfileDigest", "expectedTaskIds", "pluginArtifactDigest", "pluginCopies",
    "pluginId", "pluginLockDigest", "pluginVersion", "profileDigest", "socketOwnerPid", "taskIds",
  ], "/observed");
  if (!Array.isArray(observed.taskIds) || !Array.isArray(observed.expectedTaskIds)) fail("INVALID_CONTRACT", "task inventories must be arrays", "/observed/taskIds");
  const expectedTasks = new Set(observed.expectedTaskIds);
  if (observed.taskIds.some((taskId) => !expectedTasks.has(taskId))) fail("UNEXPECTED_TASK", "unexpected Desktop task is present", "/observed/taskIds");
  string(observed.profileDigest, "/observed/profileDigest", SHA256);
  string(observed.expectedProfileDigest, "/observed/expectedProfileDigest", SHA256);
  if (!exactEqual(observed.profileDigest, observed.expectedProfileDigest)) fail("PROFILE_DRIFT", "Desktop profile digest drifted", "/observed/profileDigest");
  if (!Number.isSafeInteger(observed.pluginCopies) || observed.pluginCopies !== 1) fail("PLUGIN_DRIFT", "exactly one plugin copy must be discoverable", "/observed/pluginCopies");
  if (
    observed.pluginId !== worker.pluginLock.pluginId ||
    observed.pluginVersion !== worker.pluginLock.version ||
    observed.pluginArtifactDigest !== worker.pluginLock.artifactDigest ||
    observed.pluginLockDigest !== worker.pluginLock.lockDigest
  ) {
    fail("PLUGIN_DRIFT", "installed plugin does not match the worker lock", "/observed/pluginId");
  }
  if (observed.socketOwnerPid !== worker.target.backendPid) fail("SOCKET_MISMATCH", "observed socket owner is not the leased backend", "/observed/socketOwnerPid");
  if (!Number.isSafeInteger(observed.crashCount) || observed.crashCount < 0) fail("INVALID_CONTRACT", "invalid crash count", "/observed/crashCount");
  if (observed.crashCount >= 3) fail("CRASH_LOOP", "Desktop target entered a crash loop", "/observed/crashCount");
}

export function admitDedicatedDesktopAction(request, { now = Date.now() } = {}) {
  record(request, [
    "action", "actorUser", "evidenceLane", "expectedGoldenImageDigest", "lease", "nextGoldenImage", "observed", "plugin", "priorPlugin", "target", "worker",
  ], "");
  if (!DEDICATED_DESKTOP_ACTIONS.includes(request.action)) fail("INVALID_ACTION", "unsupported Desktop lifecycle action", "/action");
  validateDedicatedDesktopWorker(request.worker);
  validateLease(request.lease);
  validateTarget(request.target);
  validateObservation(request.observed, request.worker);
  if (request.evidenceLane !== "desktop") fail("HEADLESS_EVIDENCE", "headless evidence cannot satisfy a Desktop-only gate", "/evidenceLane");
  if (request.actorUser !== request.worker.automation.user) fail("AUTOMATION_USER_REQUIRED", "active user is not the automation user", "/actorUser");
  if (!exactEqual(request.expectedGoldenImageDigest, request.worker.goldenImage.digest)) fail("GOLDEN_IMAGE_MISMATCH", "golden-image identity does not match", "/expectedGoldenImageDigest");
  if (request.worker.state !== "leased") fail("LEASE_NOT_CURRENT", "worker is not exclusively leased", "/worker/state");
  if (Date.parse(request.lease.expiresAt) <= now) fail("LEASE_NOT_CURRENT", "lease expired", "/lease/expiresAt");
  for (const field of ["leaseId", "hostId", "fencingToken", "runtimeLockDigest", "action", "bundleId", "bundlePath", "appPid", "backendPid", "socketPath", "socketOwnerPid"]) {
    if (request.lease[field] !== request.worker.currentLease[field]) fail("LEASE_NOT_CURRENT", "lease does not match the host's exclusive lease", `/lease/${field}`);
  }
  if (request.lease.action !== request.action || request.lease.hostId !== request.worker.hostId) fail("LEASE_NOT_CURRENT", "lease is not bound to this action and host", "/lease");
  for (const field of ["bundleId", "bundlePath", "appPid", "backendPid", "socketPath", "socketOwnerPid"]) {
    if (request.target[field] !== request.lease[field] || request.target[field] !== request.worker.target[field]) {
      fail("TARGET_MISMATCH", "lifecycle target is not the exact leased app/backend", `/target/${field}`);
    }
  }
  if (["install", "upgrade"].includes(request.action)) validatePluginLock(request.plugin);
  else if (request.plugin !== null) fail("INVALID_CONTRACT", "plugin is not accepted for this action", "/plugin");
  if (request.action === "rollback") validatePluginLock(request.priorPlugin, "/priorPlugin");
  else if (request.priorPlugin !== null) fail("INVALID_CONTRACT", "priorPlugin is only accepted for rollback", "/priorPlugin");
  if (["reimage", "rollback"].includes(request.action)) {
    record(request.nextGoldenImage, ["digest", "generation", "imageId", "signatureDigest"], "/nextGoldenImage");
    string(request.nextGoldenImage.digest, "/nextGoldenImage/digest", SHA256);
    string(request.nextGoldenImage.signatureDigest, "/nextGoldenImage/signatureDigest", SHA256);
    string(request.nextGoldenImage.imageId, "/nextGoldenImage/imageId");
    integer(request.nextGoldenImage.generation, "/nextGoldenImage/generation");
    if (request.action === "rollback" && request.nextGoldenImage.generation >= request.worker.goldenImage.generation) {
      fail("INVALID_CONTRACT", "rollback must select an earlier signed golden generation", "/nextGoldenImage/generation");
    }
  } else if (request.nextGoldenImage !== null) {
    fail("INVALID_CONTRACT", "nextGoldenImage is only accepted for reimage or rollback", "/nextGoldenImage");
  }
  return request;
}
function requireAdapter(adapter) {
  const methods = [
    "cancelTarget", "cleanupLease", "createFreshTask", "discoverPlugin", "drainHost",
    "installPlugin", "quarantineHost", "reimageHost", "restartTarget", "verifyClean", "verifyReimage",
  ];
  for (const method of methods) {
    if (typeof adapter?.[method] !== "function") fail("INVALID_ADAPTER", `missing Desktop adapter method ${method}`, "/adapter");
  }
}

function exactTargetAfterRestart(previous, next) {
  validateTarget(next, "/restartReceipt/target");
  for (const field of ["bundleId", "bundlePath", "socketPath"]) {
    if (next[field] !== previous[field]) fail("AMBIGUOUS_MUTATION", "restart changed the leased target identity", `/restartReceipt/target/${field}`);
  }
  return next;
}

async function verifyFreshDiscovery(adapter, target, plugin, priorTaskIds) {
  const task = await adapter.createFreshTask({ target });
  if (task === null || typeof task !== "object" || typeof task.taskId !== "string" || priorTaskIds.includes(task.taskId)) {
    fail("AMBIGUOUS_MUTATION", "plugin discovery did not use a fresh task", "/freshTask");
  }
  const discovery = await adapter.discoverPlugin({ target, taskId: task.taskId });
  if (
    discovery === null ||
    typeof discovery !== "object" ||
    discovery.taskId !== task.taskId ||
    discovery.pluginId !== plugin.pluginId ||
    discovery.version !== plugin.version ||
    discovery.artifactDigest !== plugin.artifactDigest ||
    discovery.copyCount !== 1
  ) {
    fail("PLUGIN_DRIFT", "fresh task did not discover the exact plugin lock", "/freshTask/discovery");
  }
  return { taskId: task.taskId, discovery };
}

export async function runDedicatedDesktopAction(request, adapter, options = {}) {
  requireAdapter(adapter);
  let admitted;
  try {
    admitted = admitDedicatedDesktopAction(request, options);
    const common = { hostId: admitted.worker.hostId, lease: admitted.lease, target: admitted.target };
    let target = admitted.target;
    let freshTask = null;
    if (["install", "upgrade", "rollback", "reimage"].includes(admitted.action)) {
      const drained = await adapter.drainHost(common);
      if (drained?.hostId !== common.hostId || drained?.leaseId !== admitted.lease.leaseId || drained?.drained !== true) {
        fail("AMBIGUOUS_MUTATION", "host drain was not exact and complete", "/drainReceipt");
      }
    }
    if (["rollback", "reimage"].includes(admitted.action)) {
      const reimage = await adapter.reimageHost({ ...common, goldenImage: admitted.nextGoldenImage });
      if (reimage?.imageId !== admitted.nextGoldenImage.imageId || reimage?.digest !== admitted.nextGoldenImage.digest) {
        fail("AMBIGUOUS_MUTATION", "reimage receipt does not match the signed golden image", "/reimageReceipt");
      }
      target = exactTargetAfterRestart(admitted.target, reimage.target);
      const verified = await adapter.verifyReimage({ hostId: common.hostId, goldenImage: admitted.nextGoldenImage });
      if (verified?.markerKind !== DEDICATED_DESKTOP_MARKER || verified?.imageDigest !== admitted.nextGoldenImage.digest || verified?.developmentStateReachable !== false) {
        fail("PROFILE_DRIFT", "reimaged worker did not restore the dedicated boundary", "/reimageVerification");
      }
    }
    if (["install", "upgrade", "rollback"].includes(admitted.action)) {
      const plugin = admitted.action === "rollback" ? admitted.priorPlugin : admitted.plugin;
      const installed = await adapter.installPlugin({ ...common, target, plugin });
      if (installed?.artifactDigest !== plugin.artifactDigest || installed?.lockDigest !== plugin.lockDigest) {
        fail("AMBIGUOUS_MUTATION", "plugin mutation receipt is not bound to the exact lock", "/installReceipt");
      }
      target = exactTargetAfterRestart(target, await adapter.restartTarget({ ...common, target, reason: admitted.action }));
      freshTask = await verifyFreshDiscovery(adapter, target, plugin, admitted.observed.taskIds);
    } else if (admitted.action === "restart") {
      target = exactTargetAfterRestart(admitted.target, await adapter.restartTarget({ ...common, reason: "restart" }));
      freshTask = await verifyFreshDiscovery(adapter, target, admitted.worker.pluginLock, admitted.observed.taskIds);
    } else if (admitted.action === "cancel") {
      const cancellation = await adapter.cancelTarget(common);
      if (cancellation?.leaseId !== admitted.lease.leaseId || cancellation?.appPid !== admitted.target.appPid || cancellation?.backendPid !== admitted.target.backendPid) {
        fail("AMBIGUOUS_MUTATION", "cancellation did not target only the leased app and backend", "/cancellationReceipt");
      }
    } else if (admitted.action === "crash-recovery") {
      target = exactTargetAfterRestart(admitted.target, await adapter.restartTarget({ ...common, reason: "crash-recovery" }));
      freshTask = await verifyFreshDiscovery(adapter, target, admitted.worker.pluginLock, admitted.observed.taskIds);
    } else if (admitted.action === "cleanup") {
      const cleanup = await adapter.cleanupLease(common);
      if (cleanup?.leaseId !== admitted.lease.leaseId || cleanup?.complete !== true) fail("CLEANUP_FAILED", "lease cleanup failed", "/cleanupReceipt");
      const clean = await adapter.verifyClean(common);
      if (clean?.clean !== true || clean?.taskCount !== 0 || clean?.credentialCount !== 0 || clean?.writableStateCount !== 0) {
        fail("CLEANUP_FAILED", "post-cleanup state is not empty", "/cleanupVerification");
      }
    }
    return Object.freeze({
      action: admitted.action,
      evidenceLane: "desktop",
      freshTask,
      hostId: admitted.worker.hostId,
      leaseId: admitted.lease.leaseId,
      runtimeLockDigest: admitted.lease.runtimeLockDigest,
      status: "succeeded",
      target,
    });
  } catch (error) {
    if (error instanceof DedicatedDesktopRuntimeError && error.quarantine && request?.worker?.hostId && request?.lease?.leaseId) {
      try {
        await adapter.quarantineHost({
          hostId: request.worker.hostId,
          leaseId: request.lease.leaseId,
          reason: error.code,
        });
      } catch (quarantineError) {
        throw new DedicatedDesktopRuntimeError("QUARANTINE_FAILED", "host quarantine failed", { cause: quarantineError });
      }
    }
    throw error;
  }
}
