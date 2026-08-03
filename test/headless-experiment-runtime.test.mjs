import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  createHeadlessWorkerLane,
  HeadlessRuntimeError,
  resolveConfinedArtifact,
} from "../src/headless-experiment-runtime.mjs";
import {
  canonicalDigest,
  parseCanonicalRuntimeLock,
  transitionRuntimeLock,
} from "../src/experimentation-contract/index.mjs";

const FIXTURE = new URL("./fixtures/experimentation-contract/runtime-lock-v1.json", import.meta.url);

async function activeRuntimeLock({ network = null } = {}) {
  let lock = parseCanonicalRuntimeLock(await readFile(FIXTURE));
  if (network) {
    const value = structuredClone(lock);
    value.permissions.network = network;
    const { canonicalDigest } = await import("../src/experimentation-contract/index.mjs");
    const { deriveRuntimeIdentity, deriveRuntimeLockDigest, sealRuntimeLock } = await import("../src/experimentation-contract/index.mjs");
    value.permissionsDigest = canonicalDigest(value.permissions);
    value.runtimeId = deriveRuntimeIdentity(value);
    value.lockDigest = deriveRuntimeLockDigest(value);
    lock = sealRuntimeLock(value);
  }
  return transitionRuntimeLock(transitionRuntimeLock(transitionRuntimeLock(lock, "reviewed"), "sealed"), "active");
}

function lease(attempt = 1) {
  return {
    executionId: "execution:test",
    workUnitId: "headless:test",
    revision: 1,
    attempt,
    workerId: `worker-slot:${attempt}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    controllerId: "controller:test",
    fencingToken: `fence:${attempt}`,
  };
}

class FakeEngine {
  constructor() {
    this.created = [];
    this.phases = [];
    this.cancelled = [];
    this.destroyed = [];
    this.quarantined = [];
    this.inspection = { runningProcesses: 0, foreignMounts: 0, writableCacheMounts: 0 };
  }

  async create(spec) {
    this.created.push(spec);
    return { workerId: spec.lease.workerId, policyDigest: spec.policyDigest };
  }

  async runPhase(workerId, spec) {
    this.phases.push({ workerId, spec });
    return { exitCode: 0, processGroupId: 4000 + this.phases.length, phasePolicyDigest: canonicalDigest(spec) };
  }

  async inspect() { return this.inspection; }
  async cancelProcessGroup(workerId, request) {
    this.cancelled.push({ workerId, request });
    return { cancelled: true, processGroupId: request.processGroupId, fencingToken: request.fencingToken };
  }
  async destroy(workerId, request) { this.destroyed.push({ workerId, request }); return { destroyed: true, workerId }; }
  async quarantine(workerId, request) { this.quarantined.push({ workerId, request }); }
}

async function fixtureLane(engine = new FakeEngine()) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "nelos-headless-lane-")));
  return { root, engine, lane: await createHeadlessWorkerLane({ root, engine }) };
}

function errorCode(code) {
  return (error) => error instanceof HeadlessRuntimeError && error.code === code;
}

test("attempts receive unique owned boundaries and a pinned unprivileged resource spec", async () => {
  const { lane, engine } = await fixtureLane();
  const lock = await activeRuntimeLock();
  const first = await lane.prepareAttempt({ runtimeLock: lock, lease: lease(1) });
  const second = await lane.prepareAttempt({ runtimeLock: lock, lease: lease(2), boundary: "disposable-vm" });

  for (const name of ["home", "codexHome", "codexSqliteHome", "workspace", "temporary", "state", "secrets", "output", "telemetry"]) {
    assert.notEqual(first.paths[name], second.paths[name]);
  }
  await writeFile(resolve(first.paths.state, "attempt-one"), "private");
  await assert.rejects(readFile(resolve(second.paths.state, "attempt-one")), { code: "ENOENT" });
  const [oci, vm] = engine.created;
  assert.equal(oci.image, lock.platform.imageDigest);
  assert.equal(oci.runtimeLockDigest, lock.lockDigest);
  assert.equal(oci.policyDigest, canonicalDigest(Object.fromEntries(Object.entries(oci).filter(([name]) => name !== "policyDigest"))));
  assert.equal(oci.user.privileged, false);
  assert.deepEqual(oci.isolation.capDrop, ["ALL"]);
  assert.equal(oci.isolation.privateProcessNamespace, true);
  assert.equal(oci.isolation.privateProcessGroup, true);
  assert.equal(oci.isolation.readOnlyRootFilesystem, true);
  assert.equal(oci.isolation.noNewPrivileges, true);
  assert.ok(oci.limits.processes > 0);
  assert.ok(oci.limits.cpuCores > 0);
  assert.ok(oci.limits.memoryBytes > 0);
  assert.ok(oci.limits.diskBytes > 0);
  assert.ok(oci.limits.fileDescriptors > 0);
  assert.ok(oci.limits.executionTimeMs > 0);
  assert.equal(vm.boundary, "disposable-vm");
  assert.ok(oci.mounts.every((mount) => mount.source.startsWith(first.paths.home.slice(0, first.paths.home.lastIndexOf("/")))));
  assert.deepEqual(oci.forbiddenMountClasses, [
    "developer-home", "developer-codex-state", "credentials", "sessions", "sockets",
    "worktrees", "mutable-cache", "container-engine-socket",
  ]);

  await first.cleanup();
  await second.cleanup();
});
test("deterministic execution proves network and API credentials are absent", async () => {
  const { lane, engine } = await fixtureLane();
  const attempt = await lane.prepareAttempt({ runtimeLock: await activeRuntimeLock(), lease: lease() });
  await attempt.execute(["node", "candidate.mjs"]);

  assert.equal(engine.phases.length, 1);
  assert.equal(engine.phases[0].spec.phase, "execution");
  assert.deepEqual(engine.phases[0].spec.network, { mode: "none", allowHosts: [] });
  assert.deepEqual(engine.phases[0].spec.credentials, []);
  assert.ok(!Object.keys(engine.phases[0].spec.environment).some((name) => /KEY|TOKEN|SECRET|CREDENTIAL/u.test(name)));
  await attempt.cleanup();
});

test("acquisition is allow-listed and scoped credentials are destroyed before execution", async () => {
  const { lane, engine } = await fixtureLane();
  const attempt = await lane.prepareAttempt({
    runtimeLock: await activeRuntimeLock(),
    lease: lease(),
    acquisitionNetwork: { mode: "allowlist", allowHosts: ["registry.npmjs.org"] },
    credentials: [{
      name: "NPM_TOKEN",
      value: "short-lived-test-value",
      audience: "registry.npmjs.org",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      phase: "acquisition",
    }],
  });
  await attempt.acquire(["npm", "ci", "--ignore-scripts"]);
  assert.equal(engine.phases[0].spec.network.mode, "allowlist");
  assert.equal(engine.phases[0].spec.credentials[0].audience, "registry.npmjs.org");
  await attempt.execute(["npm", "test"]);
  assert.deepEqual(engine.phases[1].spec.network, { mode: "none", allowHosts: [] });
  assert.deepEqual(engine.phases[1].spec.credentials, []);
  await assert.rejects(readFile(resolve(attempt.paths.secrets, "NPM_TOKEN")), { code: "ENOENT" });
  await attempt.cleanup();
});

test("cancellation is fenced to the leased process group and leaves unrelated sentinels untouched", async () => {
  const { lane, engine, root } = await fixtureLane();
  const sentinel = resolve(root, "unrelated-sentinel.sock");
  await writeFile(sentinel, "unrelated");
  const attempt = await lane.prepareAttempt({ runtimeLock: await activeRuntimeLock(), lease: lease() });
  await attempt.execute(["node", "long-running.mjs"]);
  await attempt.cancel();

  assert.deepEqual(engine.cancelled, [{
    workerId: "worker-slot:1",
    request: { processGroupId: 4001, fencingToken: "fence:1", graceMs: 2000 },
  }]);
  assert.equal(await readFile(sentinel, "utf8"), "unrelated");
  await attempt.cleanup();
  assert.equal(await readFile(sentinel, "utf8"), "unrelated");
});

test("artifact confinement rejects absolute paths, traversal, and escaping symlinks", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "nelos-artifacts-")));
  const output = resolve(root, "output");
  const outside = resolve(root, "outside");
  await mkdir(output);
  await mkdir(outside);
  await writeFile(resolve(output, "valid.txt"), "ok");
  await writeFile(resolve(outside, "secret.txt"), "no");
  await symlink(resolve(outside, "secret.txt"), resolve(output, "escape"));

  assert.equal(await resolveConfinedArtifact(output, "valid.txt"), resolve(output, "valid.txt"));
  await assert.rejects(resolveConfinedArtifact(output, resolve(output, "valid.txt")), errorCode("ARTIFACT_ESCAPE"));
  await assert.rejects(resolveConfinedArtifact(output, "../outside/secret.txt"), errorCode("ARTIFACT_ESCAPE"));
  await assert.rejects(resolveConfinedArtifact(output, "escape"), errorCode("ARTIFACT_ESCAPE"));
});

test("contamination quarantines instead of reusing or deleting evidence", async () => {
  const { lane, engine } = await fixtureLane();
  engine.inspection = { runningProcesses: 1, foreignMounts: 0, writableCacheMounts: 0 };
  const attempt = await lane.prepareAttempt({ runtimeLock: await activeRuntimeLock(), lease: lease() });
  await assert.rejects(attempt.cleanup(), errorCode("CONTAMINATION_DETECTED"));
  assert.equal(attempt.state, "quarantined");
  assert.equal(engine.destroyed.length, 0);
  assert.equal(engine.quarantined.length, 1);
  assert.equal(await readFile(new URL("../package.json", import.meta.url), "utf8").then(Boolean), true);
});

test("unverified destruction quarantines the worker and preserves its attempt root", async () => {
  const { lane, engine } = await fixtureLane();
  engine.destroy = async (workerId, request) => {
    engine.destroyed.push({ workerId, request });
    return { destroyed: false, workerId };
  };
  const attempt = await lane.prepareAttempt({ runtimeLock: await activeRuntimeLock(), lease: lease() });
  await assert.rejects(attempt.cleanup(), errorCode("CLEANUP_FAILED"));
  assert.equal(attempt.state, "quarantined");
  assert.equal(engine.quarantined.length, 1);
  await writeFile(resolve(attempt.paths.output, "quarantine-evidence"), "preserved");
  assert.equal(await readFile(resolve(attempt.paths.output, "quarantine-evidence"), "utf8"), "preserved");
});

test("admission fails closed for draft locks, expired leases, unsafe credentials, and invalid bounds", async () => {
  const { lane } = await fixtureLane();
  const draft = parseCanonicalRuntimeLock(await readFile(FIXTURE));
  await assert.rejects(lane.prepareAttempt({ runtimeLock: draft, lease: lease() }), errorCode("RUNTIME_NOT_ADMITTED"));
  await assert.rejects(lane.prepareAttempt({ runtimeLock: await activeRuntimeLock(), lease: { ...lease(), expiresAt: "2000-01-01T00:00:00Z" } }), errorCode("LEASE_EXPIRED"));
  await assert.rejects(lane.prepareAttempt({
    runtimeLock: await activeRuntimeLock(),
    lease: lease(),
    acquisitionNetwork: { mode: "none", allowHosts: [] },
    credentials: [{ name: "API_KEY", value: "x", audience: "api.example", expiresAt: new Date(Date.now() + 60_000).toISOString(), phase: "acquisition" }],
  }), errorCode("CREDENTIAL_SCOPE_VIOLATION"));
  await assert.rejects(lane.prepareAttempt({ runtimeLock: await activeRuntimeLock(), lease: lease(), limits: { processes: 0 } }), errorCode("INVALID_LIMIT"));
});

test("lane roots inside developer state are rejected before an engine is used", async () => {
  const developerRoot = await realpath(await mkdtemp(resolve(tmpdir(), "nelos-developer-state-")));
  const engine = new FakeEngine();
  await assert.rejects(createHeadlessWorkerLane({
    root: resolve(developerRoot, "workers"),
    engine,
    forbiddenHostRoots: [developerRoot],
  }), errorCode("UNSAFE_LANE_ROOT"));
  assert.equal(engine.created.length, 0);
});
