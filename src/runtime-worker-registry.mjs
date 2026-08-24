import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createBoundedProcessIdentityLookup,
  normalizedProcessIdentity,
  processMayOwnLease,
  readProcessIdentity,
} from "./process-liveness.mjs";
import {
  taskStateDirectory,
  withRuntimeWorkerRegistryLock,
} from "./task-state.mjs";
import { commitRuntimeMutationV1 } from "./runtime-mutation-fence.mjs";

export const RUNTIME_WORKER_LEASE_SCHEMA_VERSION = 1;
export const RUNTIME_WORKER_LEASE_STATES = Object.freeze([
  "active",
  "draining",
  "stale",
]);
export const DEFAULT_RUNTIME_WORKER_LEASE_MS = 30_000;
export const DEFAULT_RUNTIME_WORKER_HEARTBEAT_MS = 10_000;

const MAX_LEASE_BYTES = 64 * 1024;
const STRONG_IDENTITY_KINDS = new Set(["linux-start", "proc-inode", "ps-start"]);

function iso(value, field) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) throw new Error(`runtime worker lease ${field} is invalid`);
  return value;
}

function strongIdentity(value, field) {
  const identity = normalizedProcessIdentity(value);
  if (![...STRONG_IDENTITY_KINDS].some((kind) => typeof identity[kind] === "string" && identity[kind])) {
    throw new Error(`runtime worker lease ${field} lacks a strong process-start identity`);
  }
  return identity;
}

function boundedString(value, field, { nullable = false, pattern = null } = {}) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" || !value || value.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value) || (pattern && !pattern.test(value))
  ) throw new Error(`runtime worker lease ${field} is invalid`);
  return value;
}

export function projectRuntimeIdentityV1(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("runtime worker lease identity is missing");
  }
  return Object.freeze({
    version: boundedString(identity.version, "identity.version"),
    sourceRevision: boundedString(identity.sourceRevision, "identity.sourceRevision", { nullable: true }),
    cacheIdentity: boundedString(identity.cacheIdentity, "identity.cacheIdentity", { nullable: true }),
    integrity: boundedString(identity.integrity, "identity.integrity", { nullable: true }),
    modulePath: boundedString(identity.modulePath, "identity.modulePath"),
    buildIdentity: boundedString(identity.buildIdentity, "identity.buildIdentity"),
  });
}

export function runtimeGenerationKeyV1(identity) {
  const projected = projectRuntimeIdentityV1(identity);
  return createHash("sha256").update(JSON.stringify([
    projected.version,
    projected.sourceRevision,
    projected.cacheIdentity,
    projected.integrity,
    projected.modulePath,
    projected.buildIdentity,
  ])).digest("hex");
}

export function validateRuntimeWorkerLeaseV1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime worker lease is malformed");
  }
  const expected = [
    "schemaVersion", "workerId", "launchNonce", "pid", "processIdentity",
    "parentPid", "parentIdentity", "runtimeIdentity", "generationKey",
    "startedAt", "heartbeatAt", "expiresAt", "state",
  ];
  if (Object.keys(value).length !== expected.length || Object.keys(value).some((key) => !expected.includes(key))) {
    throw new Error("runtime worker lease has an incompatible shape");
  }
  if (value.schemaVersion !== RUNTIME_WORKER_LEASE_SCHEMA_VERSION) {
    throw new Error("runtime worker lease schema version is unsupported");
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.parentPid) || value.parentPid <= 0) {
    throw new Error("runtime worker lease process identifiers are invalid");
  }
  const runtimeIdentity = projectRuntimeIdentityV1(value.runtimeIdentity);
  const record = {
    schemaVersion: RUNTIME_WORKER_LEASE_SCHEMA_VERSION,
    workerId: boundedString(value.workerId, "workerId", { pattern: /^worker:[a-f0-9]{64}$/u }),
    launchNonce: boundedString(value.launchNonce, "launchNonce", { pattern: /^[0-9a-f-]{36}$/u }),
    pid: value.pid,
    processIdentity: strongIdentity(value.processIdentity, "processIdentity"),
    parentPid: value.parentPid,
    parentIdentity: strongIdentity(value.parentIdentity, "parentIdentity"),
    runtimeIdentity,
    generationKey: boundedString(value.generationKey, "generationKey", { pattern: /^[a-f0-9]{64}$/u }),
    startedAt: iso(value.startedAt, "startedAt"),
    heartbeatAt: iso(value.heartbeatAt, "heartbeatAt"),
    expiresAt: iso(value.expiresAt, "expiresAt"),
    state: value.state,
  };
  if (!RUNTIME_WORKER_LEASE_STATES.includes(record.state)) throw new Error("runtime worker lease state is invalid");
  if (record.generationKey !== runtimeGenerationKeyV1(runtimeIdentity)) throw new Error("runtime worker lease generation key disagrees");
  if (Date.parse(record.heartbeatAt) < Date.parse(record.startedAt) || Date.parse(record.expiresAt) <= Date.parse(record.heartbeatAt)) {
    throw new Error("runtime worker lease timestamps are inconsistent");
  }
  return record;
}

export function runtimeWorkerDirectory() {
  return resolve(taskStateDirectory(), "runtime-workers");
}

function leasePath(directory, workerId) {
  return join(directory, `${workerId.slice("worker:".length)}.json`);
}

async function writeLease(directory, lease) {
  const value = validateRuntimeWorkerLeaseV1(lease);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = leasePath(directory, value.workerId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await commitRuntimeMutationV1(() => rename(temporary, target));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return value;
}

async function readLeases(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const leases = [];
  for (const entry of entries.filter((item) => /^[a-f0-9]{64}\.json$/u.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      if (!entry.isFile()) throw new Error("lease is not a regular file");
      const path = join(directory, entry.name);
      const source = await readFile(path, "utf8");
      if (Buffer.byteLength(source) > MAX_LEASE_BYTES) throw new Error("lease is oversized");
      const lease = validateRuntimeWorkerLeaseV1(JSON.parse(source));
      if (leasePath(directory, lease.workerId) !== path) throw new Error("lease path disagrees");
      leases.push(lease);
    } catch {
      // Corrupt protected state cannot authorize process effects, but it also
      // cannot be ignored without potentially hiding a mixed generation.
      throw new Error("runtime worker registry contains an invalid lease");
    }
  }
  return leases;
}

export class RuntimeWorkerRegistryV1 {
  #directory;
  #now;
  #pid;
  #parentPid;
  #readIdentity;
  #readActiveIdentity;
  #withLock;
  #leaseMs;
  #heartbeatMs;
  #setInterval;
  #clearInterval;

  constructor({
    directory = runtimeWorkerDirectory(),
    now = Date.now,
    pid = process.pid,
    parentPid = process.ppid,
    readIdentity = readProcessIdentity,
    readActiveIdentity = createBoundedProcessIdentityLookup(),
    withLock = withRuntimeWorkerRegistryLock,
    leaseMs = DEFAULT_RUNTIME_WORKER_LEASE_MS,
    heartbeatMs = DEFAULT_RUNTIME_WORKER_HEARTBEAT_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error("runtime worker registry requires valid process identifiers");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0 || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= leaseMs) throw new Error("runtime worker registry heartbeat bounds are invalid");
    this.#directory = resolve(directory);
    this.#now = now;
    this.#pid = pid;
    this.#parentPid = parentPid;
    this.#readIdentity = readIdentity;
    this.#readActiveIdentity = readActiveIdentity;
    this.#withLock = withLock;
    this.#leaseMs = leaseMs;
    this.#heartbeatMs = heartbeatMs;
    this.#setInterval = setIntervalFn;
    this.#clearInterval = clearIntervalFn;
  }

  async #reconcileUnlocked() {
    const current = this.#now();
    const leases = await readLeases(this.#directory);
    const live = [];
    const recovered = [];
    for (const lease of leases) {
      const activeIdentity = await this.#readActiveIdentity(lease.pid);
      const fresh = Date.parse(lease.expiresAt) > current;
      if (lease.state !== "stale" && processMayOwnLease(lease.processIdentity, activeIdentity, fresh)) {
        live.push(lease);
        continue;
      }
      // Never signal this PID. The cooperative record is reclaimed only after
      // liveness/strong-start evidence proves the recorded owner cannot own it.
      await rm(leasePath(this.#directory, lease.workerId), { force: true });
      recovered.push({ ...lease, state: "stale" });
    }
    return { live, recovered };
  }

  async register(runtimeIdentity) {
    const [processIdentity, parentIdentity] = await Promise.all([
      this.#readIdentity(this.#pid),
      this.#readIdentity(this.#parentPid),
    ]);
    const strongProcessIdentity = strongIdentity(processIdentity, "processIdentity");
    const strongParentIdentity = strongIdentity(parentIdentity, "parentIdentity");
    const launchNonce = randomUUID();
    const startedAtMs = this.#now();
    const projected = projectRuntimeIdentityV1(runtimeIdentity);
    const workerId = `worker:${createHash("sha256").update(JSON.stringify([
      this.#pid, strongProcessIdentity, launchNonce, projected.buildIdentity,
    ])).digest("hex")}`;
    let lease = {
      schemaVersion: RUNTIME_WORKER_LEASE_SCHEMA_VERSION,
      workerId,
      launchNonce,
      pid: this.#pid,
      processIdentity: strongProcessIdentity,
      parentPid: this.#parentPid,
      parentIdentity: strongParentIdentity,
      runtimeIdentity: projected,
      generationKey: runtimeGenerationKeyV1(projected),
      startedAt: new Date(startedAtMs).toISOString(),
      heartbeatAt: new Date(startedAtMs).toISOString(),
      expiresAt: new Date(startedAtMs + this.#leaseMs).toISOString(),
      state: "active",
    };
    await this.#withLock(async () => {
      await this.#reconcileUnlocked();
      lease = await writeLease(this.#directory, lease);
    });
    const timer = this.#setInterval(() => {
      void this.heartbeat(lease.workerId).catch(() => {
        // Health/reconciliation reports a lost lease. A timer callback must
        // never turn a transient protected-state failure into an unhandled
        // rejection that terminates the worker before bounded shutdown.
      });
    }, this.#heartbeatMs);
    timer?.unref?.();
    let removed = false;
    return Object.freeze({
      get workerId() { return lease.workerId; },
      get lease() { return lease; },
      heartbeat: () => this.heartbeat(lease.workerId).then((updated) => { lease = updated ?? lease; return lease; }),
      drain: () => this.transition(lease.workerId, "draining").then((updated) => { lease = updated ?? lease; return lease; }),
      remove: async () => {
        if (removed) return false;
        removed = true;
        this.#clearInterval(timer);
        return this.remove(lease.workerId, launchNonce);
      },
    });
  }

  async heartbeat(workerId) {
    return this.#withLock(async () => {
      const { live } = await this.#reconcileUnlocked();
      const lease = live.find((candidate) => candidate.workerId === workerId);
      if (!lease) return null;
      const at = this.#now();
      return writeLease(this.#directory, {
        ...lease,
        heartbeatAt: new Date(at).toISOString(),
        expiresAt: new Date(at + this.#leaseMs).toISOString(),
      });
    });
  }

  async transition(workerId, state) {
    if (!RUNTIME_WORKER_LEASE_STATES.includes(state)) throw new Error("runtime worker transition is invalid");
    return this.#withLock(async () => {
      const { live } = await this.#reconcileUnlocked();
      const lease = live.find((candidate) => candidate.workerId === workerId);
      return lease ? writeLease(this.#directory, { ...lease, state }) : null;
    });
  }

  async remove(workerId, launchNonce) {
    return this.#withLock(async () => {
      const path = leasePath(this.#directory, workerId);
      const lease = await readFile(path, "utf8").then((source) => validateRuntimeWorkerLeaseV1(JSON.parse(source))).catch(() => null);
      if (!lease || lease.launchNonce !== launchNonce || lease.pid !== this.#pid) return false;
      await rm(path, { force: true });
      return true;
    });
  }

  async #inspectUnlocked() {
    const { live, recovered } = await this.#reconcileUnlocked();
    const generations = new Map();
    for (const lease of live) {
      const group = generations.get(lease.generationKey) ?? {
        generationKey: lease.generationKey,
        identity: lease.runtimeIdentity,
        workers: [],
      };
      group.workers.push({ workerId: lease.workerId, pid: lease.pid, state: lease.state, heartbeatAt: lease.heartbeatAt });
      generations.set(lease.generationKey, group);
    }
    const activeGenerations = [...generations.values()].sort((a, b) => a.generationKey.localeCompare(b.generationKey));
    return {
      state: activeGenerations.length > 1 ? "mixed-generations" : activeGenerations.length === 1 ? "single-generation" : "empty",
      mutationAllowed: activeGenerations.length <= 1,
      activeGenerations,
      liveWorkerCount: live.length,
      recoveredWorkerIds: recovered.map(({ workerId }) => workerId).sort(),
    };
  }

  async inspect() {
    return this.#withLock(() => this.#inspectUnlocked());
  }

  async withRegistrationExclusion(callback) {
    if (typeof callback !== "function") throw new Error("runtime worker exclusion requires a callback");
    return this.#withLock(async () => callback(await this.#inspectUnlocked()));
  }
}
