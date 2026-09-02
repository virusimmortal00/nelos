import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { ExecutorLaunchCoordinatorV1 } from "../src/executor-launch-coordinator.mjs";
import { ExecutorLaunchJournalV1 } from "../src/executor-launch-journal.mjs";
import { ExecutorGrantAuthorityV1 } from "../src/executor-grants.mjs";
import { ExecutionStoreV1, createWorkUnitSpecV1 } from "../src/execution-store.mjs";
import { withExecutorJournalLock } from "../src/task-state.mjs";
import { executorProviders, executorWave } from "./support/executor-fixture.mjs";

function workUnit(member) {
  return { webId: "A1", queenThreadId: "queen", workUnitId: member.workUnitId, specRevision: 1,
    attempt: 1, memberKind: "spinoff", capabilities: ["observe", "read-result"], title: member.title,
    objectiveSummary: "Implement the requested change.", deliverable: "Patch", acceptanceCriteria: ["Pass tests"],
    dependencies: [], required: true, policy: { maxAttempts: 3, onBlocked: "queen-review", onFailure: "queen-review" } };
}

async function fixture(t, { providers = executorProviders(), effects: overrides = {}, timeoutMs = 1000, wave = executorWave() } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nelos-launch-coordinator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ExecutionStoreV1({ directory: join(root, "units") });
  const journal = new ExecutorLaunchJournalV1({ directory: join(root, "journal") });
  const authority = new ExecutorGrantAuthorityV1(providers);
  t.after(() => authority.close());
  const calls = [];
  const effects = {
    async createThread({ member, operationId }) {
      const op = (await journal.read(member.workUnitId)).operations.at(-1);
      assert.equal(op.phase, "create-dispatched");
      assert.equal(op.operationId, operationId);
      calls.push(["create", member.workUnitId]);
      return { threadId: `task-${member.workUnitId}`, model: member.model, cwd: member.target.cwd,
        permissionProfile: member.permissionProfile, approvalPolicy: member.approvalPolicy };
    },
    async setTitle({ threadId, title }) {
      calls.push(["title", threadId]); return { observedTitle: title };
    },
    async startTurn({ threadId, member, clientUserMessageId }) {
      const op = (await journal.read(member.workUnitId)).operations.at(-1);
      assert.equal(op.phase, "turn-dispatched");
      assert.equal(clientUserMessageId, `nelos:${op.operationId}`);
      const unit = await store.read(member.workUnitId);
      assert.equal(unit.binding.memberThreadId, threadId);
      calls.push(["start", threadId]); return { turnId: `turn-${member.workUnitId}` };
    },
    ...overrides,
  };
  const withLock = (id, callback) => withExecutorJournalLock(join(root, "control-locks"), id, callback);
  const coordinator = new ExecutorLaunchCoordinatorV1({ authority, journal, store, effects, withLock, timeoutMs });
  const grant = await authority.issue({ wave });
  const input = { wave, executionGrantId: grant.executionGrantId ?? null,
    workUnits: wave.members.map(workUnit), prompts: wave.members.map(({ sliceId }) => ({ sliceId, text: "Implement the requested change." })) };
  return { coordinator, authority, journal, store, calls, input, providers, effects, withLock };
}

test("a two-member wave persists intent, binds before starting, and never duplicates a repeated launch", async (t) => {
  const wave = executorWave();
  wave.members.push({ ...structuredClone(wave.members[0]), sliceId: "second", workUnitId: "unit-2" });
  const f = await fixture(t, { wave });
  const result = await f.coordinator.launchWave(f.input);
  assert.equal(result.kind, "wave-started");
  assert.equal(result.members.length, 2);
  assert.deepEqual(f.calls.map(([kind]) => kind), ["create", "title", "start", "create", "title", "start"]);
  assert.equal((await f.coordinator.launchWave(f.input)).kind, "wave-started");
  assert.equal(f.calls.length, 6);
  assert.doesNotMatch(JSON.stringify(result), /Implement the requested|accountFingerprint|configFingerprint/);
});

test("result collection rechecks the binding after a read and cannot complete a superseded attempt", async (t) => {
  const f = await fixture(t);
  await f.coordinator.launchWave(f.input);
  f.effects.readResult = async ({ threadId, turnId }) => {
    await f.store.advanceAttempt({ workUnitId: "unit-1", specRevision: 1, attempt: 1 });
    return { threadId, turnId, status: "completed", terminal: true, result: { result: null } };
  };
  await assert.rejects(f.coordinator.collectResult("unit-1"), { code: "result-binding-mismatch" });
  assert.equal((await f.journal.read("unit-1")).operations.at(-1).phase, "running");
});

test("a result read cannot turn an uncertain launch into a completed worker", async (t) => {
  let reads = 0;
  const f = await fixture(t, { effects: { createThread: async () => { throw new Error("lost"); },
    readResult: async () => { reads += 1; } } });
  await f.coordinator.launchWave(f.input);
  await assert.rejects(f.coordinator.collectResult("unit-1"), { code: "result-reconciliation-required" });
  assert.equal(reads, 0);
});

test("invalid grants, mismatched inputs, and foreign pending bindings stop before creation", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.coordinator.launchWave({ ...f.input, executionGrantId: "forged" })).kind, "authorization-required");
  assert.equal(await f.store.read("unit-1"), null);
  await assert.rejects(f.coordinator.launchWave({ ...f.input, prompts: [{ sliceId: "worker", text: "changed" }] }), /work-unit-scope-mismatch/);
  await f.store.create(createWorkUnitSpecV1(f.input.workUnits[0]));
  await f.store.markLaunchPending({ workUnitId: "unit-1", specRevision: 1, launchActionId: "native-create:old" });
  const result = await f.coordinator.launchWave(f.input);
  assert.equal(result.reason, "foreign-or-legacy-binding");
  assert.equal((await f.coordinator.recover("unit-1")).reason, "no-owned-launch-evidence");
  assert.deepEqual(f.calls, []);
});

test("capability loss before dispatch closes the operation and restores a resumable work unit", async (t) => {
  const f = await fixture(t);
  const original = f.store.markLaunchPending.bind(f.store);
  f.store.markLaunchPending = async (value) => {
    const result = await original(value);
    f.providers.state.config = "2".repeat(64);
    return result;
  };
  const result = await f.coordinator.launchWave(f.input);
  assert.equal(result.members[0].phase, "not-executed");
  assert.equal((await f.store.read("unit-1")).binding.state, "unbound");
  assert.deepEqual(f.calls, []);
  const recovered = await f.coordinator.recover("unit-1");
  assert.equal(recovered.reason, "fresh-grant-and-sequence-required");
});

test("missing creation response remains unknown, including RPC errors and late successes", async (t) => {
  for (const mode of ["reject", "timeout", "malformed"]) {
    let release;
    let creates = 0;
    const f = await fixture(t, { timeoutMs: 15, effects: { createThread: async () => {
      creates += 1;
      if (mode === "reject") throw Object.assign(new Error("private failure"), { rpcCode: -32601 });
      if (mode === "malformed") return {};
      return new Promise((resolve) => { release = () => resolve({ threadId: "late-task" }); });
    } } });
    const result = await f.coordinator.launchWave(f.input);
    assert.equal(result.members[0].phase, "outcome-unknown", mode);
    if (release) { release(); await tick(); }
    assert.equal((await f.coordinator.recover("unit-1")).phase, "outcome-unknown");
    assert.equal((await f.coordinator.launchWave(f.input)).kind, "reconciliation-required");
    assert.equal(creates, 1);
    assert.doesNotMatch(JSON.stringify(result), /private failure/);
  }
});

test("effective route or title mismatch preserves the created task and does not start a turn", async (t) => {
  for (const mode of ["route", "title"]) {
    const f = await fixture(t, { effects: mode === "title" ? {
      setTitle: async () => ({ observedTitle: "wrong title" }),
    } : {
      createThread: async () => ({ threadId: "created-task", model: "wrong-model" }),
    } });
    const result = await f.coordinator.launchWave(f.input);
    assert.equal(result.members[0].phase, "thread-bound");
    assert.equal((await f.store.read("unit-1")).binding.state, "bound");
    assert.ok(!f.calls.some(([kind]) => kind === "start"));
    assert.equal((await f.coordinator.launchWave(f.input)).kind, "reconciliation-required");
  }
});

test("turn response loss retains task identity and blocks replay", async (t) => {
  let starts = 0;
  const f = await fixture(t, { effects: { startTurn: async () => { starts += 1; throw new Error("disconnected"); } } });
  const result = await f.coordinator.launchWave(f.input);
  assert.equal(result.members[0].phase, "outcome-unknown");
  assert.equal(result.members[0].threadId, "task-unit-1");
  const op = (await f.journal.read("unit-1")).operations[0];
  assert.equal(op.uncertainStage, "turn");
  await f.coordinator.recover("unit-1");
  await f.coordinator.launchWave(f.input);
  assert.equal(starts, 1);
});

test("two coordinators serialize a shared work unit and send one creation", async (t) => {
  const f = await fixture(t);
  const second = new ExecutorLaunchCoordinatorV1({ authority: f.authority, journal: f.journal, store: f.store,
    effects: f.effects, withLock: f.withLock });
  const results = await Promise.all([f.coordinator.launchWave(f.input), second.launchWave(f.input)]);
  assert.ok(results.every(({ kind }) => ["wave-started", "reconciliation-required"].includes(kind)));
  assert.equal(f.calls.filter(([kind]) => kind === "create").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "start").length, 1);
});

test("recovery repairs a lost binding write from the journal without another upstream call", async (t) => {
  const f = await fixture(t);
  const original = f.store.bind.bind(f.store);
  f.store.bind = async () => { throw new Error("simulated store failure"); };
  const result = await f.coordinator.launchWave(f.input);
  assert.equal(result.members[0].phase, "thread-bound");
  assert.equal((await f.store.read("unit-1")).binding.state, "launch-pending");
  f.store.bind = original;
  const calls = f.calls.length;
  await f.coordinator.recover("unit-1");
  assert.equal((await f.store.read("unit-1")).binding.memberThreadId, "task-unit-1");
  assert.equal(f.calls.length, calls);
});

test("a later member failing after preflight leaves the started member recorded and stops the wave", async (t) => {
  const wave = executorWave();
  wave.members.push({ ...structuredClone(wave.members[0]), sliceId: "z-last", workUnitId: "unit-2" });
  const f = await fixture(t, { wave });
  const original = f.effects.createThread;
  f.effects.createThread = async (value) => {
    if (value.member.workUnitId === "unit-2") throw new Error("second creation uncertain");
    return original(value);
  };
  const result = await f.coordinator.launchWave(f.input);
  assert.equal(result.kind, "reconciliation-required");
  assert.deepEqual(result.members.map(({ phase }) => phase), ["running", "outcome-unknown"]);
  assert.equal((await f.store.read("unit-1")).binding.state, "bound");
  assert.equal((await f.store.read("unit-2")).binding.state, "launch-pending");
});
