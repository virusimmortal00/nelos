import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  canonicalBytes,
  canonicalDigest,
  parseCanonicalJsonV1,
  sha256Bytes,
} from "./experimentation-contract/index.mjs";
import { validateEvidenceEvent } from "./experimentation-evidence/contracts.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";

export const FLEET_SCHEMA_VERSION = 1;
export const WORKER_HEALTH_STATES = Object.freeze(["ready", "leased", "draining", "quarantined"]);
const RUNTIME_CLASSES = Object.freeze(["headless-oci", "desktop-macos"]);
const JOB_STATES = Object.freeze(["queued", "leased", "reconciling", "completed", "failed"]);

export class ExperimentFleetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExperimentFleetError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new ExperimentFleetError(code, message, details);
}

function plainObject(value, label) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    fail("INVALID_CONTRACT", `${label} must be a plain object`);
  }
  return value;
}

function exactFields(value, fields, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("INVALID_CONTRACT", `${label} fields must match the closed schema`, { actual, expected });
  }
  return value;
}

function identity(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value)) {
    fail("INVALID_CONTRACT", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value, label, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) fail("INVALID_CONTRACT", `${label} must be a ${zero ? "non-negative" : "positive"} safe integer`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) fail("INVALID_CONTRACT", `${label} must be a SHA-256 digest`);
  return value;
}

function canonicalEqual(left, right) {
  return canonicalDigest(left) === canonicalDigest(right);
}

function sortedUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) fail("INVALID_CONTRACT", `${label} must be a string array`);
  const sorted = [...new Set(values)].sort();
  if (sorted.length !== values.length || sorted.some((value, index) => value !== values[index])) fail("INVALID_CONTRACT", `${label} must be sorted and unique`);
  return values;
}

function validateResources(resources, label) {
  plainObject(resources, label);
  const keys = Object.keys(resources).sort();
  if (keys.length === 0) fail("INVALID_CONTRACT", `${label} cannot be empty`);
  for (const key of keys) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/u.test(key)) fail("INVALID_CONTRACT", `${label}.${key} has an invalid resource name`);
    positiveInteger(resources[key], `${label}.${key}`);
  }
  return resources;
}

function resourcesFit(required, available) {
  const requiredKeys = Object.keys(required).sort();
  const availableKeys = Object.keys(available).sort();
  return requiredKeys.length === availableKeys.length
    && requiredKeys.every((key, index) => key === availableKeys[index] && required[key] <= available[key]);
}

function addResources(left, right) {
  const result = { ...left };
  for (const [name, amount] of Object.entries(right)) result[name] = (result[name] ?? 0) + amount;
  return result;
}

function withinQuota(used, required, quota) {
  return Object.entries(required).every(([name, amount]) => Object.hasOwn(quota, name) && (used[name] ?? 0) + amount <= quota[name]);
}

function defaultState({ maxQueued }) {
  return {
    schemaVersion: FLEET_SCHEMA_VERSION,
    revision: 1,
    sequence: 0,
    maxQueued,
    sinkReady: true,
    schedulerVersion: "fleet-v1",
    tenants: {},
    workers: {},
    jobs: {},
    leases: {},
    fenceCounters: {},
    audit: [],
  };
}

function clone(value) {
  // State contracts are JSON-only. JSON round-tripping deliberately breaks
  // shared references so callers cannot make canonical persistence ambiguous.
  return JSON.parse(JSON.stringify(value));
}

function validateState(state) {
  exactFields(state, ["schemaVersion", "revision", "sequence", "maxQueued", "sinkReady", "schedulerVersion", "tenants", "workers", "jobs", "leases", "fenceCounters", "audit"], "fleet state");
  if (state.schemaVersion !== FLEET_SCHEMA_VERSION) fail("INCOMPATIBLE_STATE", "unsupported fleet schema version");
  positiveInteger(state.revision, "state.revision");
  positiveInteger(state.sequence, "state.sequence", { zero: true });
  positiveInteger(state.maxQueued, "state.maxQueued");
  if (typeof state.sinkReady !== "boolean" || state.schedulerVersion !== "fleet-v1") fail("INVALID_CONTRACT", "fleet scheduler metadata is invalid");
  for (const field of ["tenants", "workers", "jobs", "leases", "fenceCounters"]) plainObject(state[field], `state.${field}`);
  if (!Array.isArray(state.audit)) fail("INVALID_CONTRACT", "state.audit must be an array");
  return state;
}

export class MemoryFleetStateBackend {
  #state = null;

  async load() { return this.#state === null ? null : clone(this.#state); }
  async save(state) { validateState(state); this.#state = clone(state); }
}

export class FileFleetStateBackend {
  #path;

  constructor(path) { this.#path = path; }

  static async open(path) {
    const root = await ensureCanonicalDirectory(dirname(path), "fleet state directory", { mode: 0o700, enforceMode: true });
    return new FileFleetStateBackend(resolve(root, path.split("/").at(-1)));
  }

  async load() {
    try {
      return validateState(parseCanonicalJsonV1(await readFile(this.#path), { contractKind: "ExperimentFleetState", schemaVersion: 1 }));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state) {
    validateState(state);
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(canonicalBytes(state)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.#path);
  }
}

function validateTenant(config) {
  exactFields(config, ["tenantId", "weight", "maxQueued", "maxActive", "resourceQuota"], "tenant");
  identity(config.tenantId, "tenant.tenantId");
  positiveInteger(config.weight, "tenant.weight");
  positiveInteger(config.maxQueued, "tenant.maxQueued");
  positiveInteger(config.maxActive, "tenant.maxActive");
  validateResources(config.resourceQuota, "tenant.resourceQuota");
  return config;
}

function validateSlot(slot, runtimeClass, label) {
  exactFields(slot, ["slotId", "isolated", "mutating", "resources", "reservation"], label);
  identity(slot.slotId, `${label}.slotId`);
  if (typeof slot.isolated !== "boolean" || typeof slot.mutating !== "boolean") fail("INVALID_CONTRACT", `${label} isolation flags are invalid`);
  validateResources(slot.resources, `${label}.resources`);
  if (slot.reservation !== null) fail("INVALID_CONTRACT", `${label}.reservation must be null at admission`);
  if (!slot.isolated) fail("ISOLATION_VIOLATION", "every fleet slot must provide an isolated writable boundary");
  if (runtimeClass === "headless-oci" && slot.mutating) fail("ISOLATION_VIOLATION", "headless slots cannot expose Desktop mutation authority");
  if (runtimeClass === "desktop-macos" && !slot.mutating) fail("MUTATION_LIMIT_VIOLATION", "the Desktop slot must be mutating");
  return slot;
}

function validateWorker(worker) {
  exactFields(worker, ["workerId", "runtimeLockDigest", "runtimeClass", "platform", "capabilities", "permissions", "network", "slots", "healthEvidence"], "worker");
  identity(worker.workerId, "worker.workerId");
  digest(worker.runtimeLockDigest, "worker.runtimeLockDigest");
  if (!RUNTIME_CLASSES.includes(worker.runtimeClass)) fail("INVALID_CONTRACT", "worker.runtimeClass is unsupported");
  plainObject(worker.platform, "worker.platform");
  sortedUniqueStrings(worker.capabilities, "worker.capabilities");
  plainObject(worker.permissions, "worker.permissions");
  plainObject(worker.network, "worker.network");
  exactFields(worker.healthEvidence, ["identityVerified", "clockHealthy", "cleanState", "syntheticProbe", "observedAt"], "worker.healthEvidence");
  if (["identityVerified", "clockHealthy", "cleanState", "syntheticProbe"].some((field) => worker.healthEvidence[field] !== true)) {
    fail("WORKER_NOT_READY", "worker readiness evidence must pass fail-closed");
  }
  if (!Number.isFinite(Date.parse(worker.healthEvidence.observedAt))) fail("INVALID_CONTRACT", "worker health observation time is invalid");
  if (!Array.isArray(worker.slots) || worker.slots.length === 0) fail("INVALID_CONTRACT", "worker must advertise at least one resource slot");
  worker.slots.forEach((slot, index) => validateSlot(slot, worker.runtimeClass, `worker.slots[${index}]`));
  if (new Set(worker.slots.map(({ slotId }) => slotId)).size !== worker.slots.length) fail("INVALID_CONTRACT", "worker slot IDs must be unique");
  if (worker.runtimeClass === "desktop-macos" && worker.slots.length !== 1) fail("MUTATION_LIMIT_VIOLATION", "Desktop workers expose exactly one mutating slot");
  return worker;
}

function validateRequirements(requirements) {
  exactFields(requirements, ["runtimeLockDigest", "runtimeClass", "platform", "capabilities", "permissions", "network", "resources", "mutating"], "job.requirements");
  digest(requirements.runtimeLockDigest, "job.requirements.runtimeLockDigest");
  if (!RUNTIME_CLASSES.includes(requirements.runtimeClass)) fail("INVALID_CONTRACT", "job runtime class is unsupported");
  plainObject(requirements.platform, "job.requirements.platform");
  sortedUniqueStrings(requirements.capabilities, "job.requirements.capabilities");
  plainObject(requirements.permissions, "job.requirements.permissions");
  plainObject(requirements.network, "job.requirements.network");
  validateResources(requirements.resources, "job.requirements.resources");
  if (typeof requirements.mutating !== "boolean") fail("INVALID_CONTRACT", "job mutation requirement is invalid");
  if (requirements.runtimeClass === "desktop-macos" && !requirements.mutating) fail("MUTATION_LIMIT_VIOLATION", "Desktop jobs must declare mutation authority");
  if (requirements.runtimeClass === "headless-oci" && requirements.mutating) fail("MUTATION_LIMIT_VIOLATION", "headless jobs cannot request Desktop mutation authority");
  return requirements;
}

function admissionMatches(worker, slot, requirements) {
  return worker.runtimeLockDigest === requirements.runtimeLockDigest
    && worker.runtimeClass === requirements.runtimeClass
    && canonicalEqual(worker.platform, requirements.platform)
    && canonicalEqual(worker.capabilities, requirements.capabilities)
    && canonicalEqual(worker.permissions, requirements.permissions)
    && canonicalEqual(worker.network, requirements.network)
    && slot.mutating === requirements.mutating
    && resourcesFit(requirements.resources, slot.resources);
}

function activeTenantUsage(state, tenantId) {
  const leases = Object.values(state.leases).filter((lease) => lease.state === "active" && state.jobs[lease.jobId]?.tenantId === tenantId);
  return {
    active: leases.length,
    resources: leases.reduce((used, lease) => addResources(used, lease.reservation.resources), {}),
  };
}

export class ExperimentFleetControlPlane {
  #backend;
  #state;
  #clock;
  #mutex = Promise.resolve();

  constructor(backend, state, clock) {
    this.#backend = backend;
    this.#state = state;
    this.#clock = clock;
  }

  static async open({ backend = new MemoryFleetStateBackend(), maxQueued = 10_000, clock = Date } = {}) {
    positiveInteger(maxQueued, "maxQueued");
    const state = (await backend.load()) ?? defaultState({ maxQueued });
    validateState(state);
    return new ExperimentFleetControlPlane(backend, state, clock);
  }

  snapshot() { return clone(this.#state); }

  async #mutate(effect) {
    const operation = this.#mutex.then(async () => {
      const candidate = clone(this.#state);
      const result = await effect(candidate);
      candidate.revision += 1;
      validateState(candidate);
      await this.#backend.save(candidate);
      this.#state = candidate;
      return clone(result);
    });
    this.#mutex = operation.catch(() => {});
    return operation;
  }

  #now() { return this.#clock.now(); }

  async configureTenant(config) {
    validateTenant(config);
    return this.#mutate((state) => {
      const current = state.tenants[config.tenantId];
      state.tenants[config.tenantId] = { ...clone(config), dispatched: current?.dispatched ?? 0 };
      return state.tenants[config.tenantId];
    });
  }

  async registerWorker(worker) {
    validateWorker(worker);
    return this.#mutate((state) => {
      if (state.workers[worker.workerId]) fail("DUPLICATE_WORKER", "worker ID is already registered", { workerId: worker.workerId });
      state.workers[worker.workerId] = { ...clone(worker), state: "ready", quarantineReason: null, lastClock: null };
      return state.workers[worker.workerId];
    });
  }

  async enqueue({ jobId, tenantId, payloadDigest, requirements, priority = 0 }) {
    identity(jobId, "job.jobId");
    identity(tenantId, "job.tenantId");
    digest(payloadDigest, "job.payloadDigest");
    validateRequirements(requirements);
    if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) fail("INVALID_CONTRACT", "job.priority is out of bounds");
    return this.#mutate((state) => {
      const tenant = state.tenants[tenantId];
      if (!tenant) fail("UNKNOWN_TENANT", "tenant is not configured", { tenantId });
      if (state.jobs[jobId]) fail("DUPLICATE_JOB", "job ID is already present", { jobId });
      const queued = Object.values(state.jobs).filter((job) => job.state === "queued");
      const tenantQueued = queued.filter((job) => job.tenantId === tenantId).length;
      if (queued.length >= state.maxQueued || tenantQueued >= tenant.maxQueued) {
        fail("BACKPRESSURE", "bounded queue capacity has been reached", { tenantId, queued: queued.length });
      }
      state.sequence += 1;
      state.jobs[jobId] = {
        schemaVersion: 1, jobId, tenantId, payloadDigest, requirements: clone(requirements), priority,
        sequence: state.sequence, state: "queued", attempt: 0, leaseId: null, resultDigest: null,
        ambiguity: null, enqueuedAt: new Date(this.#now()).toISOString(),
      };
      return state.jobs[jobId];
    });
  }

  async setSinkHealth(ready) {
    if (typeof ready !== "boolean") fail("INVALID_CONTRACT", "sink readiness must be boolean");
    return this.#mutate((state) => { state.sinkReady = ready; return { ready }; });
  }

  async acquire(workerId, { leaseMs = 300_000 } = {}) {
    identity(workerId, "workerId");
    positiveInteger(leaseMs, "leaseMs");
    return this.#mutate((state) => {
      if (!state.sinkReady) return null;
      const worker = state.workers[workerId];
      if (!worker) fail("UNKNOWN_WORKER", "worker is not registered", { workerId });
      if (worker.state !== "ready" && worker.state !== "leased") return null;
      const availableSlots = worker.slots.filter(({ reservation }) => reservation === null);
      const candidates = [];
      for (const job of Object.values(state.jobs)) {
        if (job.state !== "queued") continue;
        const tenant = state.tenants[job.tenantId];
        const usage = activeTenantUsage(state, job.tenantId);
        if (usage.active >= tenant.maxActive || !withinQuota(usage.resources, job.requirements.resources, tenant.resourceQuota)) continue;
        const slot = availableSlots.find((entry) => admissionMatches(worker, entry, job.requirements));
        if (slot) candidates.push({ job, tenant, slot });
      }
      candidates.sort((left, right) => (
        (left.tenant.dispatched / left.tenant.weight) - (right.tenant.dispatched / right.tenant.weight)
        || right.job.priority - left.job.priority
        || left.job.sequence - right.job.sequence
        || left.job.jobId.localeCompare(right.job.jobId)
      ));
      const selected = candidates[0];
      if (!selected) return null;
      const { job, tenant, slot } = selected;
      const fence = (state.fenceCounters[job.jobId] ?? 0) + 1;
      state.fenceCounters[job.jobId] = fence;
      const leaseId = `lease:${job.jobId}:${fence}`;
      const now = this.#now();
      const reservation = { workerId, slotId: slot.slotId, resources: clone(job.requirements.resources), mutating: job.requirements.mutating };
      const lease = {
        schemaVersion: 1, leaseId, jobId: job.jobId, workerId, slotId: slot.slotId,
        fence, fencingToken: canonicalDigest({ jobId: job.jobId, fence, workerId, slotId: slot.slotId }),
        acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + leaseMs).toISOString(),
        state: "active", reservation, effects: {}, mutationState: "none", ambiguity: null,
      };
      slot.reservation = clone(reservation);
      job.state = "leased";
      job.attempt += 1;
      job.leaseId = leaseId;
      state.leases[leaseId] = lease;
      tenant.dispatched += 1;
      worker.state = "leased";
      return { lease: clone(lease), job: clone(job) };
    });
  }

  #currentLease(state, leaseId, fencingToken, { allowExpired = false } = {}) {
    const lease = state.leases[leaseId];
    if (!lease || lease.fencingToken !== fencingToken || state.jobs[lease.jobId]?.leaseId !== leaseId || state.fenceCounters[lease.jobId] !== lease.fence) {
      fail("FENCE_REJECTED", "lease is not the current fenced owner", { leaseId });
    }
    if (lease.state !== "active") fail("LEASE_LOST", "lease is no longer active", { leaseId, state: lease.state });
    if (!allowExpired && this.#now() > Date.parse(lease.expiresAt)) fail("LEASE_LOST", "lease has expired", { leaseId });
    return lease;
  }

  async renewLease(leaseId, fencingToken, leaseMs = 300_000) {
    positiveInteger(leaseMs, "leaseMs");
    return this.#mutate((state) => {
      const lease = this.#currentLease(state, leaseId, fencingToken);
      lease.expiresAt = new Date(this.#now() + leaseMs).toISOString();
      return lease;
    });
  }

  async authorizeEffect(leaseId, fencingToken, { effectId, mutation = false }) {
    identity(effectId, "effect.effectId");
    if (typeof mutation !== "boolean") fail("INVALID_CONTRACT", "effect mutation flag is invalid");
    return this.#mutate((state) => {
      const lease = this.#currentLease(state, leaseId, fencingToken);
      if (lease.effects[effectId]) return lease.effects[effectId];
      if (mutation && !lease.reservation.mutating) fail("MUTATION_NOT_ADMITTED", "lease has no mutation authority");
      if (lease.mutationState === "ambiguous") fail("RECONCILIATION_REQUIRED", "ambiguous mutation must reconcile before any new effect");
      const receipt = { effectId, mutation, state: "authorized", fencingToken, authorizedAt: new Date(this.#now()).toISOString(), resultDigest: null };
      lease.effects[effectId] = receipt;
      if (mutation) lease.mutationState = "authorized";
      return receipt;
    });
  }

  async recordEffect(leaseId, fencingToken, { effectId, outcome, resultDigest = null }) {
    identity(effectId, "effect.effectId");
    if (!["committed", "failed", "ambiguous"].includes(outcome)) fail("INVALID_CONTRACT", "effect outcome is invalid");
    if (resultDigest !== null) digest(resultDigest, "effect.resultDigest");
    return this.#mutate((state) => {
      const lease = this.#currentLease(state, leaseId, fencingToken, { allowExpired: outcome === "ambiguous" });
      const effect = lease.effects[effectId];
      if (!effect) fail("EFFECT_NOT_AUTHORIZED", "effect must be authorized by the current lease");
      if (effect.state !== "authorized") {
        if (effect.state === outcome && effect.resultDigest === resultDigest) return effect;
        fail("EFFECT_CONFLICT", "effect already has a different terminal receipt");
      }
      effect.state = outcome;
      effect.resultDigest = resultDigest;
      if (effect.mutation) lease.mutationState = outcome === "ambiguous" ? "ambiguous" : outcome;
      if (outcome === "ambiguous") lease.ambiguity = { effectId, resultDigest };
      return effect;
    });
  }

  async loseLease(leaseId, reason = "worker-loss") {
    return this.#mutate((state) => this.#loseLease(state, leaseId, reason));
  }

  #loseLease(state, leaseId, reason) {
    const lease = state.leases[leaseId];
    if (!lease || lease.state !== "active") return lease ?? null;
    lease.state = "lost";
    lease.lostReason = reason;
    const job = state.jobs[lease.jobId];
    const ambiguous = lease.mutationState === "authorized" || lease.mutationState === "ambiguous";
    job.state = ambiguous ? "reconciling" : "queued";
    job.ambiguity = ambiguous ? { leaseId, effect: lease.ambiguity, reason } : null;
    job.leaseId = ambiguous ? leaseId : null;
    const worker = state.workers[lease.workerId];
    const slot = worker?.slots.find(({ slotId }) => slotId === lease.slotId);
    if (slot) slot.reservation = null;
    if (worker && worker.state === "leased") worker.state = worker.slots.some(({ reservation }) => reservation !== null) ? "leased" : "ready";
    return lease;
  }

  async sweepExpiredLeases() {
    return this.#mutate((state) => {
      const lost = [];
      for (const lease of Object.values(state.leases)) {
        if (lease.state === "active" && this.#now() > Date.parse(lease.expiresAt)) {
          this.#loseLease(state, lease.leaseId, "lease-expired");
          lost.push(lease.leaseId);
        }
      }
      return lost.sort();
    });
  }

  async reconcileAmbiguous(jobId, { disposition, resultDigest = null }) {
    identity(jobId, "jobId");
    if (!["committed", "not-applied", "failed"].includes(disposition)) fail("INVALID_CONTRACT", "reconciliation disposition is invalid");
    if (resultDigest !== null) digest(resultDigest, "resultDigest");
    return this.#mutate((state) => {
      const job = state.jobs[jobId];
      if (!job || job.state !== "reconciling") fail("RECONCILIATION_NOT_REQUIRED", "job has no ambiguous mutation to reconcile");
      const lease = state.leases[job.leaseId];
      lease.state = "reconciled";
      lease.reconciliation = { disposition, resultDigest, reconciledAt: new Date(this.#now()).toISOString() };
      job.ambiguity = null;
      if (disposition === "not-applied") {
        job.state = "queued";
        job.leaseId = null;
      } else {
        job.state = disposition === "committed" ? "completed" : "failed";
        job.resultDigest = resultDigest;
      }
      return job;
    });
  }

  async completeLease(leaseId, fencingToken, { outcome, resultDigest }) {
    if (!["completed", "failed"].includes(outcome)) fail("INVALID_CONTRACT", "lease completion outcome is invalid");
    digest(resultDigest, "resultDigest");
    return this.#mutate((state) => {
      const lease = this.#currentLease(state, leaseId, fencingToken);
      if (lease.mutationState === "authorized" || lease.mutationState === "ambiguous") fail("RECONCILIATION_REQUIRED", "mutation must have a terminal receipt before lease completion");
      lease.state = outcome;
      const job = state.jobs[lease.jobId];
      job.state = outcome;
      job.resultDigest = resultDigest;
      const worker = state.workers[lease.workerId];
      const slot = worker.slots.find(({ slotId }) => slotId === lease.slotId);
      slot.reservation = null;
      worker.state = worker.slots.some(({ reservation }) => reservation !== null) ? "leased" : worker.state === "draining" ? "draining" : "ready";
      return job;
    });
  }

  async transitionWorker(workerId, nextState, { reason = null, recoveryEvidence = null } = {}) {
    if (!WORKER_HEALTH_STATES.includes(nextState)) fail("INVALID_CONTRACT", "worker health state is invalid");
    return this.#mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker) fail("UNKNOWN_WORKER", "worker is not registered", { workerId });
      const current = worker.state;
      const allowed = {
        ready: ["draining", "quarantined"],
        leased: ["draining", "quarantined"],
        draining: ["ready", "quarantined"],
        quarantined: ["ready"],
      };
      if (current !== nextState && !allowed[current]?.includes(nextState)) fail("INVALID_HEALTH_TRANSITION", `cannot transition worker from ${current} to ${nextState}`);
      if (nextState === "quarantined" && (typeof reason !== "string" || reason.length === 0)) fail("INVALID_HEALTH_TRANSITION", "quarantine requires a reason");
      if (nextState === "ready") {
        if (worker.slots.some(({ reservation }) => reservation !== null)) fail("WORKER_BUSY", "worker cannot become ready with active reservations");
        if (current === "quarantined") {
          exactFields(recoveryEvidence, ["identityVerified", "clockHealthy", "cleanState", "syntheticProbe"], "recoveryEvidence");
          if (Object.values(recoveryEvidence).some((value) => value !== true)) fail("RECOVERY_FAILED", "all recovery checks must pass");
        }
      }
      if (nextState === "quarantined") {
        for (const lease of Object.values(state.leases)) if (lease.workerId === workerId && lease.state === "active") this.#loseLease(state, lease.leaseId, `worker-quarantined:${reason}`);
        worker.quarantineReason = reason;
      } else if (nextState === "ready") worker.quarantineReason = null;
      worker.state = nextState;
      return worker;
    });
  }

  async observeClock(workerId, { wallTimeMs, monotonicTimeNs, maxWallRegressionMs = 1_000 }) {
    if (!Number.isFinite(wallTimeMs) || !/^(?:0|[1-9]\d*)$/u.test(monotonicTimeNs)) fail("INVALID_CONTRACT", "clock observation is invalid");
    positiveInteger(maxWallRegressionMs, "maxWallRegressionMs", { zero: true });
    return this.#mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker) fail("UNKNOWN_WORKER", "worker is not registered", { workerId });
      const previous = worker.lastClock;
      const anomaly = previous && (BigInt(monotonicTimeNs) <= BigInt(previous.monotonicTimeNs) || wallTimeMs < previous.wallTimeMs - maxWallRegressionMs);
      worker.lastClock = { wallTimeMs, monotonicTimeNs };
      if (anomaly) {
        for (const lease of Object.values(state.leases)) if (lease.workerId === workerId && lease.state === "active") this.#loseLease(state, lease.leaseId, "clock-anomaly");
        worker.state = "quarantined";
        worker.quarantineReason = "clock-anomaly";
      }
      return { healthy: !anomaly, state: worker.state };
    });
  }

  async backup() {
    const state = this.snapshot();
    const unsigned = { schemaVersion: 1, schedulerVersion: state.schedulerVersion, state };
    return Object.freeze({ ...unsigned, backupDigest: canonicalDigest(unsigned) });
  }

  static async restore({ backend = new MemoryFleetStateBackend(), backup, clock = Date }) {
    exactFields(backup, ["schemaVersion", "schedulerVersion", "state", "backupDigest"], "backup");
    const unsigned = { schemaVersion: backup.schemaVersion, schedulerVersion: backup.schedulerVersion, state: backup.state };
    if (backup.schemaVersion !== 1 || backup.schedulerVersion !== "fleet-v1" || canonicalDigest(unsigned) !== backup.backupDigest) fail("INVALID_BACKUP", "backup digest or scheduler version is invalid");
    const state = clone(validateState(backup.state));
    for (const lease of Object.values(state.leases)) {
      if (lease.state !== "active") continue;
      lease.state = "lost";
      lease.lostReason = "control-plane-restore";
      const job = state.jobs[lease.jobId];
      job.state = "reconciling";
      job.ambiguity = { leaseId: lease.leaseId, effect: lease.ambiguity, reason: "control-plane-restore" };
    }
    for (const worker of Object.values(state.workers)) {
      worker.slots.forEach((slot) => { slot.reservation = null; });
      if (worker.state === "leased") worker.state = "draining";
    }
    state.revision += 1;
    await backend.save(state);
    return new ExperimentFleetControlPlane(backend, state, clock);
  }
}

export function mergeExperimentShards(shards, { expectedTrialIds = null } = {}) {
  if (!Array.isArray(shards) || shards.length === 0) fail("INVALID_SHARD", "at least one shard is required");
  const provenanceFields = ["experimentDigest", "corpusDigest", "runtimePolicyDigest", "collectorDigest", "graderDigest", "planDigest"];
  const seenShardIds = new Set();
  const seenTrials = new Set();
  let expectedProvenance = null;
  const results = [];
  for (const shard of shards) {
    exactFields(shard, ["schemaVersion", "shardId", "provenance", "results", "shardDigest"], "shard");
    if (shard.schemaVersion !== 1) fail("INCOMPATIBLE_SHARD", "shard schema is unsupported");
    identity(shard.shardId, "shard.shardId");
    if (seenShardIds.has(shard.shardId)) fail("SHARD_OVERLAP", "duplicate shard identity");
    seenShardIds.add(shard.shardId);
    exactFields(shard.provenance, provenanceFields, "shard.provenance");
    provenanceFields.forEach((field) => digest(shard.provenance[field], `shard.provenance.${field}`));
    if (expectedProvenance === null) expectedProvenance = shard.provenance;
    else for (const field of provenanceFields) if (shard.provenance[field] !== expectedProvenance[field]) fail("INCOMPATIBLE_SHARD", `shard ${field} does not match`, { field, shardId: shard.shardId });
    const material = { schemaVersion: shard.schemaVersion, shardId: shard.shardId, provenance: shard.provenance, results: shard.results };
    if (shard.shardDigest !== canonicalDigest(material)) fail("ALTERED_SHARD", "shard digest does not match its contents", { shardId: shard.shardId });
    if (!Array.isArray(shard.results)) fail("INVALID_SHARD", "shard results must be an array");
    for (const result of shard.results) {
      exactFields(result, ["trialId", "attemptDigest", "resultDigest"], "shard result");
      identity(result.trialId, "shard result.trialId");
      digest(result.attemptDigest, "shard result.attemptDigest");
      digest(result.resultDigest, "shard result.resultDigest");
      if (seenTrials.has(result.trialId)) fail("SHARD_OVERLAP", "trial appears in more than one shard", { trialId: result.trialId });
      seenTrials.add(result.trialId);
      results.push(clone(result));
    }
  }
  if (expectedTrialIds !== null) {
    sortedUniqueStrings(expectedTrialIds, "expectedTrialIds");
    const actual = [...seenTrials].sort();
    if (!canonicalEqual(actual, expectedTrialIds)) fail("SHARD_COVERAGE_MISMATCH", "merged shards do not exactly cover the plan", { actual, expected: expectedTrialIds });
  }
  results.sort((left, right) => left.trialId.localeCompare(right.trialId));
  const unsigned = { schemaVersion: 1, provenance: clone(expectedProvenance), shardIds: [...seenShardIds].sort(), results };
  return Object.freeze({ ...unsigned, mergeDigest: canonicalDigest(unsigned) });
}

export function createExperimentShard({ shardId, provenance, results }) {
  const material = { schemaVersion: 1, shardId, provenance: clone(provenance), results: clone(results) };
  return Object.freeze({ ...material, shardDigest: canonicalDigest(material) });
}

export class MemoryObjectBackend {
  #objects = new Map();

  async putIfAbsent(key, bytes) {
    const existing = this.#objects.get(key);
    if (existing && !existing.equals(bytes)) fail("IMMUTABLE_CONFLICT", "object key already contains different bytes", { key });
    if (!existing) this.#objects.set(key, Buffer.from(bytes));
  }
  async get(key) { return this.#objects.has(key) ? Buffer.from(this.#objects.get(key)) : null; }
  async keys() { return [...this.#objects.keys()].sort(); }
}

export class FileObjectBackend {
  #root;

  constructor(root) { this.#root = root; }
  static async open(root) { return new FileObjectBackend(await ensureCanonicalDirectory(root, "fleet object backend", { mode: 0o700, enforceMode: true })); }
  async putIfAbsent(key, bytes) {
    if (!/^[0-9a-f]{64}$/u.test(key)) fail("INVALID_CONTRACT", "object key is invalid");
    const path = resolve(this.#root, key.slice(0, 2), key.slice(2));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(path, "wx", 0o400);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await readFile(path)).equals(bytes)) fail("IMMUTABLE_CONFLICT", "object key already contains different bytes", { key });
    }
  }
  async get(key) {
    try { return await readFile(resolve(this.#root, key.slice(0, 2), key.slice(2))); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async keys() { fail("UNSUPPORTED_OPERATION", "filesystem key enumeration is intentionally not part of the immutable object contract"); }
}

export class ImmutableFleetObjectStore {
  #backend;

  constructor(backend) { this.#backend = backend; }

  async put(bytes, { kind, classification, format }) {
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    identity(kind, "object.kind");
    identity(classification, "object.classification");
    identity(format, "object.format");
    const contentDigest = sha256Bytes(bytes);
    await this.#backend.putIfAbsent(contentDigest.slice(7), bytes);
    const unsigned = { schemaVersion: 1, contentDigest, byteLength: bytes.byteLength, kind, classification, format };
    return Object.freeze({ ...unsigned, manifestDigest: canonicalDigest(unsigned) });
  }

  async get(manifest) {
    exactFields(manifest, ["schemaVersion", "contentDigest", "byteLength", "kind", "classification", "format", "manifestDigest"], "object manifest");
    digest(manifest.contentDigest, "object manifest.contentDigest");
    positiveInteger(manifest.byteLength, "object manifest.byteLength", { zero: true });
    identity(manifest.kind, "object manifest.kind");
    identity(manifest.classification, "object manifest.classification");
    identity(manifest.format, "object manifest.format");
    digest(manifest.manifestDigest, "object manifest.manifestDigest");
    const unsigned = { schemaVersion: manifest.schemaVersion, contentDigest: manifest.contentDigest, byteLength: manifest.byteLength, kind: manifest.kind, classification: manifest.classification, format: manifest.format };
    if (manifest.schemaVersion !== 1 || canonicalDigest(unsigned) !== manifest.manifestDigest) fail("ALTERED_MANIFEST", "object manifest digest is invalid");
    const bytes = await this.#backend.get(manifest.contentDigest.slice(7));
    if (bytes === null) fail("MISSING_ARTIFACT", "referenced immutable object is missing", { contentDigest: manifest.contentDigest });
    if (bytes.byteLength !== manifest.byteLength || sha256Bytes(bytes) !== manifest.contentDigest) fail("ALTERED_ARTIFACT", "immutable object does not match its manifest");
    return bytes;
  }

  async reachable(manifest) { try { await this.get(manifest); return true; } catch (error) { if (error.code === "MISSING_ARTIFACT") return false; throw error; } }
}

export class MemoryDerivedIndex {
  #generation = null;
  async replace(rows) {
    if (!Array.isArray(rows)) fail("INVALID_CONTRACT", "index rows must be an array");
    const sorted = clone(rows).sort((left, right) => canonicalDigest(left).localeCompare(canonicalDigest(right)));
    this.#generation = Object.freeze({ schemaVersion: 1, rows: sorted, sourceDigest: canonicalDigest(sorted) });
    return this.#generation;
  }
  async read() { return this.#generation === null ? null : clone(this.#generation); }
}

export async function verifyFleetRecovery({ backup, events = [], artifactManifests = [], objectStore, recomputeReport = null }) {
  exactFields(backup, ["schemaVersion", "schedulerVersion", "state", "backupDigest"], "backup");
  const backupUnsigned = { schemaVersion: backup.schemaVersion, schedulerVersion: backup.schedulerVersion, state: backup.state };
  if (canonicalDigest(backupUnsigned) !== backup.backupDigest) fail("INVALID_BACKUP", "backup digest is invalid");
  validateState(backup.state);
  const heads = new Map();
  const ordered = clone(events).sort((left, right) => left.writerId.localeCompare(right.writerId) || left.writerEpoch - right.writerEpoch || left.sequence - right.sequence);
  for (const event of ordered) {
    validateEvidenceEvent(event);
    const key = `${event.writerId}:${event.writerEpoch}`;
    const head = heads.get(key);
    if ((!head && (event.sequence !== 1 || event.previousEventDigest !== null)) || (head && (event.sequence !== head.sequence + 1 || event.previousEventDigest !== head.eventDigest))) {
      fail("BROKEN_EVENT_CHAIN", "event chain is not contiguous", { writer: key, eventId: event.eventId });
    }
    heads.set(key, event);
  }
  if (artifactManifests.length > 0 && !(objectStore instanceof ImmutableFleetObjectStore)) fail("INVALID_STORE", "artifact verification requires an immutable object store");
  for (const manifest of artifactManifests) if (!(await objectStore.reachable(manifest))) fail("MISSING_ARTIFACT", "artifact is not reachable", { contentDigest: manifest.contentDigest });
  let reportDigest = null;
  if (recomputeReport !== null) {
    if (typeof recomputeReport !== "function") fail("INVALID_CONTRACT", "recomputeReport must be a function");
    const first = await recomputeReport();
    const second = await recomputeReport();
    if (!canonicalEqual(first, second)) fail("NONDETERMINISTIC_REPORT", "report recomputation is not deterministic");
    reportDigest = canonicalDigest(first);
  }
  const fenceDigest = canonicalDigest(backup.state.fenceCounters);
  const unsigned = { schemaVersion: 1, backupDigest: backup.backupDigest, eventCount: events.length, chainCount: heads.size, artifactCount: artifactManifests.length, fenceDigest, reportDigest };
  return Object.freeze({ ...unsigned, verificationDigest: canonicalDigest(unsigned) });
}
