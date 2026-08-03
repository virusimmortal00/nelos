import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  createExperimentShard,
  ExperimentFleetControlPlane,
  ExperimentFleetError,
  FileFleetStateBackend,
  FileObjectBackend,
  ImmutableFleetObjectStore,
  MemoryDerivedIndex,
  MemoryFleetStateBackend,
  MemoryObjectBackend,
  mergeExperimentShards,
  verifyFleetRecovery,
} from "../src/experiment-fleet.mjs";
import { canonicalDigest } from "../src/experimentation-contract/index.mjs";
import { createEvidenceEvent } from "../src/experimentation-evidence/index.mjs";

const sha = (value) => canonicalDigest({ value });
const platform = Object.freeze({ os: "linux", architecture: "arm64", imageDigest: sha("image") });
const permissions = Object.freeze({ sandbox: "workspace-write", subprocess: true });
const network = Object.freeze({ mode: "allowlist", allowHosts: ["api.openai.com"] });
const resources = Object.freeze({ cpuCores: 1, memoryBytes: 1024, diskBytes: 2048 });

function requirements(overrides = {}) {
  return {
    runtimeLockDigest: sha("runtime"), runtimeClass: "headless-oci", platform,
    capabilities: ["codex", "git"], permissions, network, resources, mutating: false,
    ...overrides,
  };
}

function worker(workerId, overrides = {}) {
  return {
    workerId, runtimeLockDigest: sha("runtime"), runtimeClass: "headless-oci", platform,
    capabilities: ["codex", "git"], permissions, network,
    slots: [{ slotId: `${workerId}:slot:1`, isolated: true, mutating: false, resources: { cpuCores: 2, memoryBytes: 4096, diskBytes: 8192 }, reservation: null }],
    healthEvidence: { identityVerified: true, clockHealthy: true, cleanState: true, syntheticProbe: true, observedAt: "2026-08-03T12:00:00Z" },
    ...overrides,
  };
}

function desktopWorker(workerId = "desktop:one", overrides = {}) {
  return worker(workerId, {
    runtimeClass: "desktop-macos",
    platform: { os: "macos", architecture: "arm64", imageDigest: sha("desktop-image") },
    capabilities: ["codex-desktop", "gui-session"],
    permissions: { sandbox: "danger-full-access", subprocess: true },
    network: { mode: "allowlist", allowHosts: ["api.openai.com"] },
    slots: [{ slotId: `${workerId}:mutation`, isolated: true, mutating: true, resources: { cpuCores: 4, memoryBytes: 8192, diskBytes: 16384 }, reservation: null }],
    ...overrides,
  });
}

function desktopRequirements(overrides = {}) {
  return requirements({
    runtimeClass: "desktop-macos",
    platform: { os: "macos", architecture: "arm64", imageDigest: sha("desktop-image") },
    capabilities: ["codex-desktop", "gui-session"],
    permissions: { sandbox: "danger-full-access", subprocess: true },
    network: { mode: "allowlist", allowHosts: ["api.openai.com"] },
    resources: { cpuCores: 2, memoryBytes: 4096, diskBytes: 8192 },
    mutating: true,
    ...overrides,
  });
}

async function fleet({ maxQueued = 100, clock = Date, backend } = {}) {
  const control = await ExperimentFleetControlPlane.open({ maxQueued, clock, backend });
  await control.configureTenant({ tenantId: "tenant:a", weight: 2, maxQueued: 50, maxActive: 10, resourceQuota: { cpuCores: 20, memoryBytes: 100_000, diskBytes: 200_000 } });
  await control.configureTenant({ tenantId: "tenant:b", weight: 1, maxQueued: 50, maxActive: 10, resourceQuota: { cpuCores: 20, memoryBytes: 100_000, diskBytes: 200_000 } });
  return control;
}

function errorCode(code) {
  return (error) => error instanceof ExperimentFleetError && error.code === code;
}

test("the fleet control plane is available through its public package subpath", async () => {
  const exported = await import("nelos/experiment-fleet");
  assert.equal(exported.ExperimentFleetControlPlane, ExperimentFleetControlPlane);
});

test("admission exactly binds runtime lock, platform, capabilities, permissions, network, mutation lane, and resources", async () => {
  const control = await fleet();
  const mismatches = [
    worker("worker:runtime", { runtimeLockDigest: sha("other-runtime") }),
    worker("worker:platform", { platform: { ...platform, architecture: "x64" } }),
    worker("worker:capability", { capabilities: ["codex"] }),
    worker("worker:permission", { permissions: { sandbox: "read-only", subprocess: true } }),
    worker("worker:network", { network: { mode: "none", allowHosts: [] } }),
    worker("worker:resource", { slots: [{ slotId: "worker:resource:slot", isolated: true, mutating: false, resources: { cpuCores: 1, memoryBytes: 512, diskBytes: 2048 }, reservation: null }] }),
  ];
  for (const entry of mismatches) await control.registerWorker(entry);
  await control.registerWorker(worker("worker:exact"));
  await control.enqueue({ jobId: "job:exact", tenantId: "tenant:a", payloadDigest: sha("payload"), requirements: requirements() });

  for (const entry of mismatches) assert.equal(await control.acquire(entry.workerId), null, entry.workerId);
  const assignment = await control.acquire("worker:exact");
  assert.equal(assignment.job.jobId, "job:exact");
  assert.deepEqual(assignment.lease.reservation.resources, resources);

  await assert.rejects(control.registerWorker(worker("worker:unsafe", { slots: [{ slotId: "unsafe", isolated: false, mutating: false, resources, reservation: null }] })), errorCode("ISOLATION_VIOLATION"));
  await assert.rejects(control.registerWorker(desktopWorker("desktop:wide", { slots: [desktopWorker().slots[0], { ...desktopWorker().slots[0], slotId: "desktop:wide:two" }] })), errorCode("MUTATION_LIMIT_VIOLATION"));
});

test("bounded weighted-fair queues reserve exact capacity and enforce tenant quotas", async () => {
  const control = await fleet({ maxQueued: 4 });
  await control.registerWorker(worker("worker:slots", {
    slots: [1, 2, 3].map((number) => ({ slotId: `slot:${number}`, isolated: true, mutating: false, resources: { cpuCores: 2, memoryBytes: 4096, diskBytes: 8192 }, reservation: null })),
  }));
  for (const [jobId, tenantId] of [["job:a1", "tenant:a"], ["job:a2", "tenant:a"], ["job:b1", "tenant:b"], ["job:b2", "tenant:b"]]) {
    await control.enqueue({ jobId, tenantId, payloadDigest: sha(jobId), requirements: requirements() });
  }
  await assert.rejects(control.enqueue({ jobId: "job:overflow", tenantId: "tenant:a", payloadDigest: sha("overflow"), requirements: requirements() }), errorCode("BACKPRESSURE"));

  const assignments = [];
  for (let index = 0; index < 3; index += 1) assignments.push(await control.acquire("worker:slots"));
  assert.deepEqual(assignments.map(({ job }) => job.tenantId), ["tenant:a", "tenant:b", "tenant:a"]);
  assert.equal(new Set(assignments.map(({ job }) => job.jobId)).size, 3);
  assert.deepEqual(assignments[0].lease.reservation.resources, resources);

  const quota = await ExperimentFleetControlPlane.open();
  await quota.configureTenant({ tenantId: "tenant:q", weight: 1, maxQueued: 5, maxActive: 1, resourceQuota: resources });
  await quota.registerWorker(worker("worker:q", { slots: [1, 2].map((number) => ({ slotId: `q:${number}`, isolated: true, mutating: false, resources, reservation: null })) }));
  for (const jobId of ["job:q1", "job:q2"]) await quota.enqueue({ jobId, tenantId: "tenant:q", payloadDigest: sha(jobId), requirements: requirements() });
  assert.ok(await quota.acquire("worker:q"));
  assert.equal(await quota.acquire("worker:q"), null);
});

test("serialized acquisition, durable restart, and fencing prevent duplicate ownership", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nelos-fleet-state-"));
  const backend = await FileFleetStateBackend.open(resolve(root, "fleet.json"));
  const control = await fleet({ backend });
  await control.registerWorker(worker("worker:parallel", {
    slots: [1, 2, 3, 4].map((number) => ({ slotId: `parallel:${number}`, isolated: true, mutating: false, resources, reservation: null })),
  }));
  for (let index = 0; index < 40; index += 1) await control.enqueue({ jobId: `job:scale:${index}`, tenantId: "tenant:a", payloadDigest: sha(index), requirements: requirements() });
  const wave = await Promise.all(Array.from({ length: 16 }, () => control.acquire("worker:parallel")));
  const assigned = wave.filter(Boolean);
  assert.equal(assigned.length, 4);
  assert.equal(new Set(assigned.map(({ job }) => job.jobId)).size, 4);

  const restarted = await ExperimentFleetControlPlane.open({ backend });
  assert.equal(Object.values(restarted.snapshot().leases).filter(({ state }) => state === "active").length, 4);
  const first = assigned[0].lease;
  await restarted.loseLease(first.leaseId, "worker-restart");
  const replacement = await restarted.acquire("worker:parallel");
  assert.ok(replacement);
  if (replacement.job.jobId === first.jobId) assert.ok(replacement.lease.fence > first.fence);
  await assert.rejects(restarted.authorizeEffect(first.leaseId, first.fencingToken, { effectId: "effect:stale" }), errorCode("FENCE_REJECTED"));
});

test("lease loss stops effects and ambiguous Desktop mutations reconcile before retry", async () => {
  const control = await fleet();
  await control.registerWorker(desktopWorker());
  await control.enqueue({ jobId: "job:desktop", tenantId: "tenant:a", payloadDigest: sha("desktop"), requirements: desktopRequirements() });
  const { lease } = await control.acquire("desktop:one");
  await control.authorizeEffect(lease.leaseId, lease.fencingToken, { effectId: "effect:install", mutation: true });
  await control.loseLease(lease.leaseId, "desktop-disconnected");
  assert.equal(control.snapshot().jobs["job:desktop"].state, "reconciling");
  assert.equal(await control.acquire("desktop:one"), null);
  await assert.rejects(control.authorizeEffect(lease.leaseId, lease.fencingToken, { effectId: "effect:again", mutation: true }), errorCode("LEASE_LOST"));

  await control.reconcileAmbiguous("job:desktop", { disposition: "not-applied" });
  const retry = await control.acquire("desktop:one");
  assert.equal(retry.job.jobId, "job:desktop");
  assert.equal(retry.lease.fence, lease.fence + 1);
  await control.authorizeEffect(retry.lease.leaseId, retry.lease.fencingToken, { effectId: "effect:install", mutation: true });
  await control.recordEffect(retry.lease.leaseId, retry.lease.fencingToken, { effectId: "effect:install", outcome: "committed", resultDigest: sha("receipt") });
  await control.completeLease(retry.lease.leaseId, retry.lease.fencingToken, { outcome: "completed", resultDigest: sha("result") });
});

test("sink outage, worker loss, health recovery, clock anomalies, and contamination fail closed", async () => {
  let now = Date.parse("2026-08-03T12:00:00Z");
  const control = await fleet({ clock: { now: () => now } });
  await control.registerWorker(worker("worker:health"));
  await control.enqueue({ jobId: "job:health", tenantId: "tenant:a", payloadDigest: sha("health"), requirements: requirements() });
  await control.setSinkHealth(false);
  assert.equal(await control.acquire("worker:health"), null);
  await control.setSinkHealth(true);
  const assignment = await control.acquire("worker:health", { leaseMs: 10 });
  now += 11;
  assert.deepEqual(await control.sweepExpiredLeases(), [assignment.lease.leaseId]);
  assert.equal(control.snapshot().jobs["job:health"].state, "queued");

  await control.transitionWorker("worker:health", "quarantined", { reason: "contamination" });
  assert.equal(await control.acquire("worker:health"), null);
  await assert.rejects(control.transitionWorker("worker:health", "ready", { recoveryEvidence: { identityVerified: true, clockHealthy: true, cleanState: false, syntheticProbe: true } }), errorCode("RECOVERY_FAILED"));
  await control.transitionWorker("worker:health", "ready", { recoveryEvidence: { identityVerified: true, clockHealthy: true, cleanState: true, syntheticProbe: true } });
  await control.transitionWorker("worker:health", "draining");
  assert.equal(await control.acquire("worker:health"), null);
  await control.transitionWorker("worker:health", "ready");
  await control.observeClock("worker:health", { wallTimeMs: now, monotonicTimeNs: "100" });
  const anomaly = await control.observeClock("worker:health", { wallTimeMs: now - 5_000, monotonicTimeNs: "99" });
  assert.deepEqual(anomaly, { healthy: false, state: "quarantined" });
});

function provenance(overrides = {}) {
  return {
    experimentDigest: sha("experiment"), corpusDigest: sha("corpus"), runtimePolicyDigest: sha("runtime-policy"),
    collectorDigest: sha("collector"), graderDigest: sha("grader"), planDigest: sha("plan"), ...overrides,
  };
}

function shard(shardId, trialIds, overrides = {}) {
  return createExperimentShard({
    shardId,
    provenance: provenance(overrides),
    results: trialIds.map((trialId) => ({ trialId, attemptDigest: sha(`attempt:${trialId}`), resultDigest: sha(`result:${trialId}`) })),
  });
}

test("deterministic shard merge rejects overlap, gaps, alteration, and incompatible provenance", () => {
  const left = shard("shard:a", ["trial:1", "trial:3"]);
  const right = shard("shard:b", ["trial:2"]);
  const merged = mergeExperimentShards([right, left], { expectedTrialIds: ["trial:1", "trial:2", "trial:3"] });
  const reverse = mergeExperimentShards([left, right], { expectedTrialIds: ["trial:1", "trial:2", "trial:3"] });
  assert.equal(merged.mergeDigest, reverse.mergeDigest);
  assert.deepEqual(merged.results.map(({ trialId }) => trialId), ["trial:1", "trial:2", "trial:3"]);
  assert.throws(() => mergeExperimentShards([left, shard("shard:overlap", ["trial:3"])]), errorCode("SHARD_OVERLAP"));
  assert.throws(() => mergeExperimentShards([left], { expectedTrialIds: ["trial:1", "trial:2", "trial:3"] }), errorCode("SHARD_COVERAGE_MISMATCH"));
  assert.throws(() => mergeExperimentShards([left, shard("shard:foreign", ["trial:2"], { graderDigest: sha("other-grader") })]), errorCode("INCOMPATIBLE_SHARD"));
  assert.throws(() => mergeExperimentShards([{ ...left, results: [] }]), errorCode("ALTERED_SHARD"));
});

function eventChain() {
  const first = createEvidenceEvent({
    eventId: "evt:restore:1", eventType: "trial.started", stream: "operational", experimentId: "exp:restore", runId: "run:restore", runGeneration: 1,
    taskId: "task:restore", trialId: "trial:restore", attempt: 1, rootTrialId: "trial:restore", writerId: "writer:restore", writerEpoch: 1,
    sequence: 1, previousEventDigest: null, observedWallTime: "2026-08-03T12:00:00Z", monotonicTimeNs: "1", clockId: "clock:restore",
    payloadSchema: "nelos://events/trial.started/v1", payload: {},
  });
  const second = createEvidenceEvent({ ...first, eventId: "evt:restore:2", eventType: "trial.finished", sequence: 2, previousEventDigest: first.eventDigest, monotonicTimeNs: "2", payloadSchema: "nelos://events/trial.finished/v1", eventDigest: undefined });
  return [first, second];
}

test("replaceable object storage and derived indexes preserve bytes and recovery verifies chains, reachability, fencing, and reports", async () => {
  const bytes = Buffer.from('{"immutable":"artifact-event-format"}\n');
  for (const backend of [new MemoryObjectBackend(), await FileObjectBackend.open(await mkdtemp(resolve(tmpdir(), "nelos-fleet-objects-")))]) {
    const store = new ImmutableFleetObjectStore(backend);
    const manifest = await store.put(bytes, { kind: "evidence-stream", classification: "internal", format: "jsonl-v1" });
    assert.deepEqual(await store.get(manifest), bytes);
    const repeated = await store.put(bytes, { kind: "evidence-stream", classification: "internal", format: "jsonl-v1" });
    assert.equal(repeated.manifestDigest, manifest.manifestDigest);
  }

  const objectStore = new ImmutableFleetObjectStore(new MemoryObjectBackend());
  const artifact = await objectStore.put(bytes, { kind: "artifact", classification: "restricted", format: "artifact-v1" });
  const index = new MemoryDerivedIndex();
  const generation = await index.replace([{ runId: "run:z" }, { runId: "run:a" }]);
  assert.equal(generation.sourceDigest, (await index.read()).sourceDigest);

  const control = await fleet();
  await control.registerWorker(worker("worker:backup"));
  await control.enqueue({ jobId: "job:backup", tenantId: "tenant:a", payloadDigest: sha("backup"), requirements: requirements() });
  const assignment = await control.acquire("worker:backup");
  const backup = await control.backup();
  const verification = await verifyFleetRecovery({
    backup, events: eventChain(), artifactManifests: [artifact], objectStore,
    recomputeReport: async () => ({ runId: "run:restore", result: "stable" }),
  });
  assert.equal(verification.eventCount, 2);
  assert.equal(verification.artifactCount, 1);
  assert.equal(verification.fenceDigest, canonicalDigest({ "job:backup": assignment.lease.fence }));

  const restored = await ExperimentFleetControlPlane.restore({ backup });
  assert.equal(restored.snapshot().jobs["job:backup"].state, "reconciling");
  await restored.reconcileAmbiguous("job:backup", { disposition: "not-applied" });
  await restored.transitionWorker("worker:backup", "ready");
  const retry = await restored.acquire("worker:backup");
  assert.equal(retry.lease.fence, assignment.lease.fence + 1);

  const broken = eventChain();
  broken[1] = createEvidenceEvent({ ...broken[1], sequence: 3, eventDigest: undefined });
  await assert.rejects(verifyFleetRecovery({ backup, events: broken, objectStore }), errorCode("BROKEN_EVENT_CHAIN"));
  const missingStore = new ImmutableFleetObjectStore(new MemoryObjectBackend());
  await assert.rejects(verifyFleetRecovery({ backup, artifactManifests: [artifact], objectStore: missingStore }), errorCode("MISSING_ARTIFACT"));
});
