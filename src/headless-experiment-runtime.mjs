import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import {
  validateRuntimeLock,
  verifyRuntimeLockDigest,
  verifyRuntimeLockIdentity,
} from "./experimentation-contract/runtime-lock.mjs";
import { canonicalDigest } from "./experimentation-contract/identity.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";

export const HEADLESS_RUNTIME_SCHEMA_VERSION = 1;
export const HEADLESS_BOUNDARIES = Object.freeze(["oci-container", "disposable-vm"]);

const DIRECTORY_NAMES = Object.freeze({
  home: "home",
  codexHome: "codex-home",
  codexSqliteHome: "codex-sqlite-home",
  workspace: "workspace",
  temporary: "tmp",
  state: "state",
  secrets: "secrets",
  output: "output",
  telemetry: "telemetry",
});

const DEFAULT_LIMITS = Object.freeze({
  processes: 64,
  cpuCores: 1,
  memoryBytes: 1024 * 1024 * 1024,
  diskBytes: 2 * 1024 * 1024 * 1024,
  fileDescriptors: 256,
  acquisitionTimeMs: 120_000,
  executionTimeMs: 300_000,
  cleanupTimeMs: 30_000,
  totalTimeMs: 480_000,
  cancellationGraceMs: 2_000,
});

export class HeadlessRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HeadlessRuntimeError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new HeadlessRuntimeError(code, message, details);
}

function assertClosedObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARGUMENT", `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) fail("UNKNOWN_FIELD", `${label}.${key} is not supported`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("INVALID_LIMIT", `${label} must be a positive safe integer`);
  }
}

function normalizeLimits(limits = {}) {
  assertClosedObject(limits, Object.keys(DEFAULT_LIMITS), "limits");
  const normalized = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
  for (const [name, value] of Object.entries(normalized)) assertPositiveInteger(value, `limits.${name}`);
  if (normalized.acquisitionTimeMs + normalized.executionTimeMs + normalized.cleanupTimeMs > normalized.totalTimeMs) {
    fail("INVALID_LIMIT", "phase time limits cannot exceed the total time limit");
  }
  return normalized;
}

function validateLease(lease) {
  assertClosedObject(
    lease,
    ["executionId", "workUnitId", "revision", "attempt", "workerId", "expiresAt", "controllerId", "fencingToken"],
    "lease",
  );
  for (const name of ["executionId", "workUnitId", "workerId", "controllerId", "fencingToken"]) {
    if (typeof lease[name] !== "string" || lease[name].length === 0) fail("INVALID_LEASE", `lease.${name} is required`);
  }
  assertPositiveInteger(lease.revision, "lease.revision");
  assertPositiveInteger(lease.attempt, "lease.attempt");
  if (typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt))) {
    fail("INVALID_LEASE", "lease.expiresAt must be an RFC3339 timestamp");
  }
  return Object.freeze({ ...lease });
}

function validateCommand(command, label) {
  if (!Array.isArray(command) || command.length === 0 || command.length > 256) {
    fail("INVALID_COMMAND", `${label} must be a non-empty argv array`);
  }
  for (const argument of command) {
    if (typeof argument !== "string" || argument.includes("\0") || argument.length > 16_384) {
      fail("INVALID_COMMAND", `${label} contains an invalid argument`);
    }
  }
  return Object.freeze([...command]);
}

function assertRuntimeAdmission(runtimeLock) {
  validateRuntimeLock(runtimeLock);
  verifyRuntimeLockIdentity(runtimeLock);
  verifyRuntimeLockDigest(runtimeLock);
  if (runtimeLock.runtimeClass !== "headless-oci") {
    fail("RUNTIME_NOT_ADMITTED", "worker lane requires a headless-oci RuntimeLock");
  }
  if (runtimeLock.state !== "active") {
    fail("RUNTIME_NOT_ADMITTED", "RuntimeLock must be active", { state: runtimeLock.state });
  }
  if (runtimeLock.platform.os !== "linux") fail("RUNTIME_NOT_ADMITTED", "headless workers require Linux");
  return runtimeLock;
}

function pathEscapes(root, candidate) {
  const rel = relative(root, candidate);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export async function resolveConfinedArtifact(outputRoot, artifactPath) {
  if (typeof artifactPath !== "string" || artifactPath.length === 0 || artifactPath.includes("\0")) {
    fail("INVALID_ARTIFACT_PATH", "artifact path must be a non-empty relative path");
  }
  if (isAbsolute(artifactPath)) fail("ARTIFACT_ESCAPE", "absolute artifact paths are forbidden", { artifactPath });
  const lexical = resolve(outputRoot, artifactPath);
  if (pathEscapes(resolve(outputRoot), lexical)) {
    fail("ARTIFACT_ESCAPE", "artifact traversal is forbidden", { artifactPath });
  }
  const canonicalRoot = await realpath(outputRoot);
  const parts = relative(outputRoot, lexical).split(sep).filter(Boolean);
  let cursor = canonicalRoot;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error.code === "ENOENT") fail("ARTIFACT_MISSING", "artifact does not exist", { artifactPath });
      throw error;
    }
    if (info.isSymbolicLink()) {
      const target = await realpath(cursor);
      if (pathEscapes(canonicalRoot, target)) {
        fail("ARTIFACT_ESCAPE", "artifact symlink escapes the output root", {
          artifactPath,
          linkTarget: await readlink(cursor),
        });
      }
      cursor = target;
    }
  }
  const canonical = await realpath(cursor);
  if (pathEscapes(canonicalRoot, canonical)) fail("ARTIFACT_ESCAPE", "artifact escapes the output root", { artifactPath });
  return canonical;
}

function validateCredentials(credentials, now, latestExpiry) {
  if (!Array.isArray(credentials) || credentials.length > 32) fail("INVALID_CREDENTIAL", "credentials must be an array");
  const names = new Set();
  return credentials.map((credential) => {
    assertClosedObject(credential, ["name", "value", "audience", "expiresAt", "phase"], "credential");
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(credential.name)) fail("INVALID_CREDENTIAL", "credential name is invalid");
    if (names.has(credential.name)) fail("INVALID_CREDENTIAL", "credential names must be unique");
    names.add(credential.name);
    if (typeof credential.value !== "string" || credential.value.length === 0) fail("INVALID_CREDENTIAL", "credential value is required");
    if (typeof credential.audience !== "string" || credential.audience.length === 0) fail("INVALID_CREDENTIAL", "credential audience is required");
    if (credential.phase !== "acquisition") fail("CREDENTIAL_SCOPE_VIOLATION", "credentials are acquisition-only");
    const expiry = Date.parse(credential.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now || expiry > latestExpiry) {
      fail("INVALID_CREDENTIAL", "credential must expire within the acquisition lease");
    }
    return Object.freeze({ ...credential });
  });
}

async function createBoundaries(root) {
  const paths = {};
  for (const [name, directory] of Object.entries(DIRECTORY_NAMES)) {
    const path = resolve(root, directory);
    await mkdir(path, { mode: 0o700 });
    paths[name] = await realpath(path);
  }
  return Object.freeze(paths);
}

async function writeCredentials(secretRoot, credentials) {
  const mounts = [];
  for (const credential of credentials) {
    const path = resolve(secretRoot, credential.name);
    const file = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await file.writeFile(credential.value, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(path, 0o600);
    mounts.push(Object.freeze({ name: credential.name, source: path, target: `/run/secrets/${credential.name}`, audience: credential.audience }));
  }
  return Object.freeze(mounts);
}

function environmentFor(paths) {
  return Object.freeze({
    HOME: "/attempt/home",
    CODEX_HOME: "/attempt/codex-home",
    CODEX_SQLITE_HOME: "/attempt/codex-sqlite-home",
    XDG_CONFIG_HOME: "/attempt/state/xdg-config",
    XDG_CACHE_HOME: "/attempt/state/xdg-cache",
    XDG_DATA_HOME: "/attempt/state/xdg-data",
    XDG_STATE_HOME: "/attempt/state/xdg-state",
    GIT_CONFIG_GLOBAL: "/attempt/state/gitconfig",
    NPM_CONFIG_USERCONFIG: "/attempt/state/npmrc",
    TMPDIR: "/attempt/tmp",
    NELOS_OUTPUT: "/attempt/output",
    NELOS_TELEMETRY: "/attempt/telemetry",
    NELOS_HOST_BOUNDARY_COUNT: String(Object.keys(paths).length),
  });
}

function workerSpec({ attemptId, boundary, runtimeLock, lease, paths, limits, acquisitionNetwork }) {
  const writableMounts = Object.entries(paths).map(([name, source]) => Object.freeze({
    source,
    target: `/attempt/${DIRECTORY_NAMES[name]}`,
    readOnly: false,
    purpose: name,
  }));
  const spec = {
    schemaVersion: HEADLESS_RUNTIME_SCHEMA_VERSION,
    attemptId,
    boundary,
    image: runtimeLock.platform.imageDigest,
    runtimeId: runtimeLock.runtimeId,
    runtimeLockDigest: runtimeLock.lockDigest,
    lease,
    user: Object.freeze({ uid: 65532, gid: 65532, privileged: false }),
    isolation: Object.freeze({
      privateProcessNamespace: true,
      privateProcessGroup: true,
      readOnlyRootFilesystem: true,
      noNewPrivileges: true,
      capDrop: Object.freeze(["ALL"]),
      seccomp: "runtime-default",
    }),
    limits,
    mounts: Object.freeze(writableMounts),
    forbiddenMountClasses: Object.freeze([
      "developer-home", "developer-codex-state", "credentials", "sessions", "sockets",
      "worktrees", "mutable-cache", "container-engine-socket",
    ]),
    phases: Object.freeze({
      acquisition: Object.freeze({ network: acquisitionNetwork }),
      execution: Object.freeze({ network: runtimeLock.permissions.network }),
    }),
    environment: environmentFor(paths),
  };
  return Object.freeze({ ...spec, policyDigest: canonicalDigest(spec) });
}

function verifyCreateReceipt(receipt, spec) {
  if (!receipt?.workerId || typeof receipt.workerId !== "string") {
    fail("INVALID_ENGINE_RECEIPT", "engine.create did not return a workerId");
  }
  if (receipt.policyDigest !== spec.policyDigest) {
    fail("ADMISSION_NOT_ENFORCED", "engine did not attest the exact admitted worker policy");
  }
  if (receipt.workerId !== spec.lease.workerId) {
    fail("LEASE_MISMATCH", "engine worker does not match the leased worker identity");
  }
  return receipt;
}

function verifyPhaseReceipt(receipt, phaseSpec) {
  if (!Number.isSafeInteger(receipt?.processGroupId) || receipt.processGroupId < 1) {
    fail("INVALID_ENGINE_RECEIPT", "phase did not identify its leased process group");
  }
  if (receipt.phasePolicyDigest !== canonicalDigest(phaseSpec)) {
    fail("ADMISSION_NOT_ENFORCED", "engine did not attest the exact phase policy");
  }
  return receipt;
}

function validateEngine(engine) {
  for (const method of ["create", "runPhase", "inspect", "cancelProcessGroup", "destroy", "quarantine"]) {
    if (typeof engine?.[method] !== "function") fail("INVALID_ENGINE", `engine.${method} is required`);
  }
  return engine;
}

export async function createHeadlessWorkerLane({
  root,
  engine,
  supportedBoundaries = HEADLESS_BOUNDARIES,
  forbiddenHostRoots = [process.env.HOME, process.env.CODEX_HOME, process.cwd()].filter(Boolean),
  clock = Date,
  uuid = randomUUID,
}) {
  const laneRoot = await ensureCanonicalDirectory(root, "headless worker lane root", { create: true, mode: 0o700, enforceMode: true });
  for (const forbiddenRoot of forbiddenHostRoots) {
    const normalized = resolve(forbiddenRoot);
    if (laneRoot === normalized || !pathEscapes(normalized, laneRoot)) {
      fail("UNSAFE_LANE_ROOT", "headless worker lane cannot live inside developer state", { laneRoot, forbiddenRoot: normalized });
    }
  }
  validateEngine(engine);
  const supported = new Set(supportedBoundaries);
  if (supported.size === 0 || [...supported].some((boundary) => !HEADLESS_BOUNDARIES.includes(boundary))) {
    fail("INVALID_BOUNDARY", "supportedBoundaries contains an unsupported isolation boundary");
  }

  return Object.freeze({
    async prepareAttempt({ runtimeLock, lease, boundary = "oci-container", limits, acquisitionNetwork = { mode: "none", allowHosts: [] }, credentials = [] }) {
      assertRuntimeAdmission(runtimeLock);
      const admittedLease = validateLease(lease);
      if (!supported.has(boundary)) fail("BOUNDARY_UNAVAILABLE", `isolation boundary is unavailable: ${boundary}`);
      if (boundary === "disposable-vm" && runtimeLock.runtimeClass !== "headless-oci") fail("RUNTIME_NOT_ADMITTED", "VM boundary still requires a headless lock");
      const bounded = normalizeLimits(limits);
      const now = clock.now();
      if (Date.parse(admittedLease.expiresAt) <= now) fail("LEASE_EXPIRED", "worker lease is already expired");
      if (!acquisitionNetwork || !["none", "allowlist"].includes(acquisitionNetwork.mode)) {
        fail("INVALID_NETWORK_POLICY", "acquisition network must be none or allowlist");
      }
      const hosts = acquisitionNetwork.allowHosts;
      if (!Array.isArray(hosts) || (acquisitionNetwork.mode === "none" && hosts.length !== 0) || (acquisitionNetwork.mode === "allowlist" && hosts.length === 0)) {
        fail("INVALID_NETWORK_POLICY", "acquisition allowHosts does not match its mode");
      }
      const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
      if (hosts.some((host) => typeof host !== "string" || !hostPattern.test(host)) || new Set(hosts).size !== hosts.length) {
        fail("INVALID_NETWORK_POLICY", "acquisition hosts must be unique lowercase DNS names");
      }
      const scopedCredentials = validateCredentials(
        credentials,
        now,
        Math.min(Date.parse(admittedLease.expiresAt), now + bounded.acquisitionTimeMs),
      );
      if (scopedCredentials.some((credential) => !hosts.includes(credential.audience))) {
        fail("CREDENTIAL_SCOPE_VIOLATION", "credential audience must be present in the acquisition allowlist");
      }
      if (scopedCredentials.length > 0 && acquisitionNetwork.mode === "none") {
        fail("CREDENTIAL_SCOPE_VIOLATION", "credentials cannot be attached to an offline acquisition phase");
      }

      const attemptId = `attempt:${uuid()}`;
      const attemptRoot = await mkdtemp(resolve(laneRoot, "attempt-"));
      await chmod(attemptRoot, 0o700);
      const paths = await createBoundaries(attemptRoot);
      const credentialMounts = await writeCredentials(paths.secrets, scopedCredentials);
      const spec = workerSpec({ attemptId, boundary, runtimeLock, lease: admittedLease, paths, limits: bounded, acquisitionNetwork: Object.freeze({ mode: acquisitionNetwork.mode, allowHosts: Object.freeze([...hosts]) }) });
      let worker;
      try {
        const receipt = await engine.create(spec);
        try {
          worker = verifyCreateReceipt(receipt, spec);
        } catch (error) {
          if (typeof receipt?.workerId === "string") {
            await engine.quarantine(receipt.workerId, { reason: error.code, fencingToken: admittedLease.fencingToken });
          }
          throw error;
        }
      } catch (error) {
        await rm(attemptRoot, { recursive: true, force: true });
        throw error;
      }
      let state = "prepared";
      let processGroupId = null;
      const totalDeadline = now + bounded.totalTimeMs;
      const assertCurrent = () => {
        if (clock.now() >= totalDeadline || clock.now() >= Date.parse(admittedLease.expiresAt)) fail("LEASE_EXPIRED", "attempt deadline or lease expired");
        if (["destroyed", "quarantined"].includes(state)) fail("ATTEMPT_TERMINAL", `attempt is ${state}`);
      };
      const runPhase = async (phase, command) => {
        assertCurrent();
        const expected = phase === "acquisition" ? "prepared" : "acquired";
        if (state !== expected) fail("INVALID_PHASE", `${phase} cannot start from ${state}`);
        if (phase === "execution" && (credentialMounts.length !== 0 && (await access(paths.secrets).then(() => true, () => false)))) {
          await rm(paths.secrets, { recursive: true, force: true });
          await mkdir(paths.secrets, { mode: 0o700 });
        }
        const phaseSpec = Object.freeze({
          phase,
          command: validateCommand(command, `${phase}.command`),
          network: spec.phases[phase].network,
          credentials: phase === "acquisition" ? credentialMounts : Object.freeze([]),
          environment: spec.environment,
          timeoutMs: phase === "acquisition" ? bounded.acquisitionTimeMs : bounded.executionTimeMs,
          lease: admittedLease,
        });
        state = `${phase}-running`;
        const receipt = verifyPhaseReceipt(await engine.runPhase(worker.workerId, phaseSpec), phaseSpec);
        processGroupId = receipt?.processGroupId ?? processGroupId;
        state = phase === "acquisition" ? "acquired" : "executed";
        return receipt;
      };

      return Object.freeze({
        attemptId,
        workerId: worker.workerId,
        boundary,
        paths,
        spec,
        get state() { return state; },
        acquire(command) { return runPhase("acquisition", command); },
        execute(command) {
          if (state === "prepared" && acquisitionNetwork.mode === "none" && credentialMounts.length === 0) state = "acquired";
          return runPhase("execution", command);
        },
        async cancel() {
          if (["destroyed", "quarantined"].includes(state)) return Object.freeze({ state, alreadyTerminal: true });
          if (!processGroupId) fail("NOT_RUNNING", "attempt has no leased process group to cancel");
          const request = {
            processGroupId,
            fencingToken: admittedLease.fencingToken,
            graceMs: bounded.cancellationGraceMs,
          };
          const receipt = await engine.cancelProcessGroup(worker.workerId, request);
          if (receipt?.processGroupId !== processGroupId || receipt?.fencingToken !== admittedLease.fencingToken || receipt?.cancelled !== true) {
            fail("CANCELLATION_UNVERIFIED", "engine did not verify cancellation of the leased process group");
          }
          state = "cancelled";
          return receipt;
        },
        async collectArtifacts(artifactPaths) {
          if (!Array.isArray(artifactPaths)) fail("INVALID_ARTIFACT_PATH", "artifact paths must be an array");
          return Promise.all(artifactPaths.map((path) => resolveConfinedArtifact(paths.output, path)));
        },
        async cleanup() {
          if (["destroyed", "quarantined"].includes(state)) return Object.freeze({ state, alreadyTerminal: true });
          try {
            const inspection = await engine.inspect(worker.workerId);
            if (!inspection || inspection.runningProcesses !== 0 || inspection.foreignMounts !== 0 || inspection.writableCacheMounts !== 0) {
              fail("CONTAMINATION_DETECTED", "worker inspection found residual or foreign state", { inspection });
            }
            const destroyReceipt = await engine.destroy(worker.workerId, { timeoutMs: bounded.cleanupTimeMs, fencingToken: admittedLease.fencingToken });
            if (destroyReceipt?.destroyed !== true || destroyReceipt?.workerId !== worker.workerId) {
              fail("CLEANUP_FAILED", "engine did not verify worker destruction");
            }
            await rm(attemptRoot, { recursive: true, force: false });
            try {
              await access(attemptRoot);
              fail("CLEANUP_FAILED", "attempt root still exists after cleanup");
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            state = "destroyed";
            return Object.freeze({ state, workerId: worker.workerId });
          } catch (error) {
            state = "quarantined";
            await engine.quarantine(worker.workerId, {
              reason: error.code ?? "CLEANUP_FAILED",
              fencingToken: admittedLease.fencingToken,
            });
            throw error;
          }
        },
      });
    },
  });
}
