import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutorLaunchJournalV1, validateExecutorJournalV1 } from "../src/executor-launch-journal.mjs";
import { ExecutionStoreV1, createWorkUnitSpecV1 } from "../src/execution-store.mjs";
import { ExecutorGrantAuthorityV1 } from "../src/executor-grants.mjs";
import { executorDigest } from "../src/executor-contract.mjs";
import { RuntimeMutationBoundaryV1 } from "../src/runtime-mutation-fence.mjs";
import { executorProviders, executorWave } from "./support/executor-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-launch-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "journal");
  const journal = new ExecutorLaunchJournalV1({ directory });
  const authority = new ExecutorGrantAuthorityV1(executorProviders());
  t.after(() => authority.close());
  const wave = executorWave();
  const issued = await authority.issue({ wave });
  const admitted = await authority.validate({ wave, executionGrantId: issued.executionGrantId });
  const input = { wave, sliceId: "worker", executionGrantId: issued.executionGrantId,
    context: admitted.context, prompt: "Implement the requested change." };
  return { root, directory, journal, authority, input,
    store: new ExecutionStoreV1({ directory: join(root, "units") }) };
}

async function move(journal, record, event) {
  return journal.transition({ workUnitId: record.workUnitId, operationId: record.operations.at(-1).operationId,
    expectedRevision: record.revision, event });
}

function unit() {
  return createWorkUnitSpecV1({ webId: "A1", queenThreadId: "queen", workUnitId: "unit-1", specRevision: 1,
    attempt: 1, memberKind: "spinoff", capabilities: ["observe", "read-result"], title: "Worker",
    objectiveSummary: "Implement the requested change.", deliverable: "Patch", acceptanceCriteria: ["Pass tests"],
    dependencies: [], required: true, policy: { maxAttempts: 3, onBlocked: "queen-review", onFailure: "queen-review" } });
}

test("the journal persists creation and turn identities separately across reopen", async (t) => {
  const f = await fixture(t);
  let record = await f.journal.prepare(f.input);
  const operationId = record.operations[0].operationId;
  record = await move(f.journal, record, { type: "create-dispatched" });
  record = await move(f.journal, record, { type: "thread-bound", threadId: "task-real" });
  assert.equal(record.operations[0].turnId, null);
  record = await move(f.journal, record, { type: "turn-dispatched" });
  record = await move(f.journal, record, { type: "running", turnId: "turn-real" });
  record = await move(f.journal, record, { type: "terminal", status: "completed" });
  const reopened = new ExecutorLaunchJournalV1({ directory: f.directory });
  assert.deepEqual(await reopened.read("unit-1"), record);
  assert.equal(record.operations[0].operationId, operationId);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, `${executorDigest("unit-1")}.json`))).mode & 0o777, 0o600);
});

test("concurrent journal instances prepare exactly one operation and revision checks fence stale updates", async (t) => {
  const f = await fixture(t);
  const second = new ExecutorLaunchJournalV1({ directory: f.directory });
  const [a, b] = await Promise.all([f.journal.prepare(f.input), second.prepare(f.input)]);
  assert.deepEqual(a, b);
  const outcomes = await Promise.allSettled([
    move(f.journal, a, { type: "create-dispatched" }), move(second, b, { type: "not-executed" }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.find(({ status }) => status === "rejected").reason.code, "journal-revision-conflict");
});

test("a changed launch contract cannot reuse an operation or skip its sequence", async (t) => {
  const f = await fixture(t);
  await f.journal.prepare(f.input);
  const changed = structuredClone(f.input);
  changed.wave.members[0].target.cwd = "/different";
  changed.context.scopeDigest = executorDigest(changed.wave);
  await assert.rejects(f.journal.prepare(changed), /launch-sequence-conflict/);
  changed.wave.members[0].launchSequence = 3;
  changed.context.scopeDigest = executorDigest(changed.wave);
  await assert.rejects(f.journal.prepare(changed), /launch-sequence-conflict/);
  await assert.rejects(f.journal.prepare({ ...f.input, prompt: "Changed payload" }), /invalid-journal-record/);
});

test("dispatch loss remains unknown and cannot produce non-dispatch evidence or a new launch", async (t) => {
  const f = await fixture(t);
  let record = await f.journal.prepare(f.input);
  record = await move(f.journal, record, { type: "create-dispatched" });
  await assert.rejects(move(f.journal, record, { type: "not-executed" }), /non-dispatch-not-proven/);
  record = await move(f.journal, record, { type: "outcome-unknown" });
  assert.equal(record.operations[0].uncertainStage, "create");
  await assert.rejects(f.journal.proveNotExecuted({ workUnitId: "unit-1", operationId: record.operations[0].operationId }), /non-dispatch-not-proven/);
  const next = structuredClone(f.input);
  next.wave.members[0].launchSequence = 2;
  next.context.scopeDigest = executorDigest(next.wave);
  await assert.rejects(f.journal.prepare(next), /launch-reconciliation-required/);
  record = await move(f.journal, record, { type: "thread-bound", threadId: "reconciled-thread" });
  record = await move(f.journal, record, { type: "turn-dispatched" });
  record = await move(f.journal, record, { type: "outcome-unknown" });
  assert.equal(record.operations[0].threadId, "reconciled-thread");
  assert.equal(record.operations[0].uncertainStage, "turn");
});

test("proven non-dispatch recovers a pending work unit; stale receipts cannot bind the next operation", async (t) => {
  const f = await fixture(t);
  await f.store.create(unit());
  let record = await f.journal.prepare(f.input);
  const oldId = record.operations[0].operationId;
  await f.store.markLaunchPending({ workUnitId: "unit-1", specRevision: 1, launchActionId: oldId });
  await assert.rejects(f.store.releaseUndispatchedLaunch({ workUnitId: "unit-1", launchActionId: oldId }), /invalid-non-dispatch-proof/);
  record = await move(f.journal, record, { type: "not-executed" });
  // Simulate restart between committing journal evidence and resetting the store.
  const reopened = new ExecutorLaunchJournalV1({ directory: f.directory });
  const proof = await reopened.proveNotExecuted({ workUnitId: "unit-1", operationId: oldId });
  assert.equal((await f.store.releaseUndispatchedLaunch(proof)).binding.state, "unbound");
  assert.equal((await f.store.releaseUndispatchedLaunch(proof)).binding.state, "unbound");
  const next = structuredClone(f.input);
  next.wave.members[0].launchSequence = 2;
  const grant = await f.authority.issue({ wave: next.wave });
  next.executionGrantId = grant.executionGrantId;
  next.context = (await f.authority.validate({ wave: next.wave, executionGrantId: grant.executionGrantId })).context;
  record = await reopened.prepare(next);
  await assert.rejects(reopened.prepare(f.input), /stale-launch-operation/);
  const newId = record.operations.at(-1).operationId;
  assert.notEqual(newId, oldId);
  await f.store.markLaunchPending({ workUnitId: "unit-1", specRevision: 1, launchActionId: newId });
  await assert.rejects(f.store.bind({ workUnitId: "unit-1", specRevision: 1, launchActionId: oldId, memberThreadId: "late-thread" }), /matching launch-pending/);
  await assert.rejects(f.store.releaseUndispatchedLaunch(proof), /exact initial pending/);
  await assert.rejects(move(reopened, record, { type: "thread-bound", threadId: "invented" }), /invalid-launch-transition/);
});

test("non-dispatch recovery cannot reset a bound work unit or authorize a legacy pending launch", async (t) => {
  const f = await fixture(t);
  await f.store.create(unit());
  let record = await f.journal.prepare(f.input);
  const id = record.operations[0].operationId;
  record = await move(f.journal, record, { type: "not-executed" });
  const proof = await f.journal.proveNotExecuted({ workUnitId: "unit-1", operationId: id });
  await f.store.markLaunchPending({ workUnitId: "unit-1", specRevision: 1, launchActionId: "legacy-native-action" });
  await assert.rejects(f.store.releaseUndispatchedLaunch(proof), /exact initial pending/);
  await f.store.bind({ workUnitId: "unit-1", specRevision: 1, launchActionId: "legacy-native-action", memberThreadId: "existing-task" });
  await assert.rejects(f.store.releaseUndispatchedLaunch(proof), /exact initial pending/);
});

test("runtime fencing can reject a journal commit without changing durable dispatch state", async (t) => {
  const f = await fixture(t);
  const record = await f.journal.prepare(f.input);
  let allowed = true;
  const boundary = new RuntimeMutationBoundaryV1({ health: async () => ({ mutationAllowed: allowed, state: "restart-required" }) });
  await assert.rejects(boundary.run({}, async () => {
    allowed = false;
    await move(f.journal, record, { type: "create-dispatched" });
  }), /STALE_RUNTIME/);
  assert.deepEqual(await f.journal.read("unit-1"), record);
});

test("malformed, oversized, public, and symlinked journals fail closed", async (t) => {
  const f = await fixture(t);
  const record = await f.journal.prepare(f.input);
  const path = join(f.directory, `${executorDigest("unit-1")}.json`);
  const original = await readFile(path, "utf8");
  for (const contents of ["private malformed payload", "x".repeat(512 * 1024 + 1)]) {
    await writeFile(path, contents);
    await assert.rejects(f.journal.read("unit-1"));
  }
  await writeFile(path, original);
  await chmod(path, 0o644);
  await assert.rejects(f.journal.read("unit-1"), /invalid-journal-file/);
  await rm(path);
  const outside = join(f.root, "outside.json"); await writeFile(outside, original, { mode: 0o600 });
  await symlink(outside, path);
  await assert.rejects(f.journal.read("unit-1"), /journal-unreadable/);
  assert.equal(await readFile(outside, "utf8"), original);
  const invalid = structuredClone(record); invalid.operations[0].turnId = "invented-turn";
  assert.throws(() => validateExecutorJournalV1(invalid), /invalid-journal-record/);
});
