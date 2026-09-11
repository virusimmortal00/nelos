import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutorServiceRuntimeV1 } from "../src/executor-service-runtime.mjs";
import { ExecutorLaunchJournalV1 } from "../src/executor-launch-journal.mjs";
import { ExecutorGrantAuthorityV1 } from "../src/executor-grants.mjs";
import { ExecutionStoreV1, createWorkUnitSpecV1 } from "../src/execution-store.mjs";
import { executorDigest } from "../src/executor-contract.mjs";
import { classifyWorkResult } from "../src/work-result.mjs";
import { executorWave, executorProviders } from "./support/executor-fixture.mjs";
import { mockStdioAppServer } from "./support/mock-stdio-app-server.mjs";

async function fixture(t, { phase = "prepared", cached = false, foreign = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "nelos-startup-recovery-"));
  const wave = executorWave();
  if (foreign) wave.members[0].target.hostId = "another-host";
  const authority = new ExecutorGrantAuthorityV1(executorProviders());
  const grant = await authority.issue({ wave });
  const { context } = await authority.validate({ wave, executionGrantId: grant.executionGrantId });
  authority.close();
  const journal = new ExecutorLaunchJournalV1({ directory: join(directory, "journal") });
  const store = new ExecutionStoreV1({ directory: join(directory, "units") });
  await store.create(createWorkUnitSpecV1({ webId: "A1", queenThreadId: "queen", workUnitId: "unit-1",
    specRevision: 1, attempt: 1, memberKind: "spinoff", capabilities: ["observe", "read-result"], title: "Worker",
    objectiveSummary: "Implement the requested change.", deliverable: "Patch", acceptanceCriteria: ["Pass tests"],
    dependencies: [], required: true, policy: { maxAttempts: 3, onBlocked: "queen-review", onFailure: "queen-review" } }));
  let record = await journal.prepare({ wave, sliceId: "worker", executionGrantId: grant.executionGrantId,
    context, prompt: "Implement the requested change." });
  const operationId = record.operations[0].operationId;
  await store.markLaunchPending({ workUnitId: "unit-1", specRevision: 1, launchActionId: operationId });
  for (const event of [
    { type: "create-dispatched" }, { type: "thread-bound", threadId: "old-thread" },
    { type: "turn-dispatched" }, { type: "running", turnId: "old-turn" }, { type: "terminal", status: "completed" },
  ]) {
    if (record.operations[0].phase === phase) break;
    record = await journal.transition({ workUnitId: "unit-1", operationId, expectedRevision: record.revision, event });
  }
  if (cached) {
    record = await journal.transition({ workUnitId: "unit-1", operationId, expectedRevision: record.revision,
      event: { type: "result-collected", evidence: { threadId: "old-thread", turnId: "old-turn", terminal: true,
        status: "completed", result: classifyWorkResult({ latestTurn: { id: "old-turn", status: "completed", items: [] } }) } } });
  }
  const server = mockStdioAppServer(({ method }) => {
    assert.equal(method, "initialize", "startup must not issue upstream recovery or replay calls");
    return { userAgent: "codex-cli/0.154.0", codexHome: "/codex", platformFamily: "unix", platformOs: "macos" };
  });
  const runtime = new ExecutorServiceRuntimeV1({ directory,
    scope: { hostId: "remote-fixture", codexHomeId: "c".repeat(64), authDomainId: "a".repeat(64) },
    runtimeGeneration: "b".repeat(64), validateTarget: async () => true,
    sessionOptions: { command: "/bin/codex", cwd: "/workspace", codexHome: "/codex", spawnProcess: server.spawnProcess },
  });
  t.after(async () => {
    server.children[0]?.emit("exit", 0);
    await runtime.stopped;
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, journal, store, record, operationId, runtime, server, wave };
}

test("startup closes admission until inventory finishes and safely releases proven non-dispatch", async (t) => {
  const f = await fixture(t);
  const starting = f.runtime.start();
  assert.equal(f.runtime.start(), starting);
  assert.throws(() => f.runtime.attach(), { code: "startup-reconciliation-required" });
  assert.throws(() => f.runtime.drain(), { code: "startup-reconciliation-required" });
  const state = await starting;
  assert.equal(state.acceptingLaunches, true);
  assert.deepEqual(state.recovery, { state: "complete", pending: 0, reason: null });
  assert.equal((await f.journal.read("unit-1")).operations[0].phase, "not-executed");
  assert.equal((await f.store.read("unit-1")).binding.state, "unbound");
  assert.equal(f.runtime.status().activities, 0);
  f.runtime.drain();
  await f.runtime.stopped;
  await assert.rejects(f.runtime.start(), { code: "supervisor-unavailable" });
});

test("dispatched, bound, running and uncollected terminal records quarantine a replacement owner", async (t) => {
  for (const phase of ["create-dispatched", "thread-bound", "turn-dispatched", "running", "terminal"]) {
    const f = await fixture(t, { phase });
    const state = await f.runtime.start();
    const client = f.runtime.attach();
    assert.equal(state.acceptingLaunches, false, phase);
    assert.equal(state.recovery.state, "attention", phase);
    assert.equal(state.recovery.pending, 1);
    assert.equal(state.activities, 1);
    assert.throws(() => f.runtime.requestGrant(client, { wave: f.wave }), { code: "startup-reconciliation-required" });
    await assert.rejects(f.runtime.launchWave(client, {}), { code: "startup-reconciliation-required" });
    await f.runtime.recover(client, "unit-1");
    f.runtime.detach(client);
    assert.equal(f.runtime.drain().activities, 1);
    assert.equal(f.server.children[0].stdin.destroyed, false);
    assert.deepEqual(f.server.requests.map(({ method }) => method), ["initialize", "initialized"]);
  }
});

test("restart rebinds and replays cached terminal evidence without adopting old thread ownership", async (t) => {
  const f = await fixture(t, { phase: "terminal", cached: true });
  const state = await f.runtime.start();
  assert.equal(state.acceptingLaunches, true);
  const result = await f.runtime.collectResult(f.runtime.attach(), "unit-1");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result, f.record.operations[0].completion.result);
  assert.equal((await f.store.read("unit-1")).binding.memberThreadId, "old-thread");
  assert.equal(f.runtime.status().activities, 0);
  assert.deepEqual(f.server.requests.map(({ method }) => method), ["initialize", "initialized"]);
});

test("a contradictory saved binding retains startup attention even with terminal evidence", async (t) => {
  const f = await fixture(t, { phase: "terminal", cached: true });
  await f.store.bind({ workUnitId: "unit-1", specRevision: 1, launchActionId: f.operationId, memberThreadId: "different-thread" });
  const state = await f.runtime.start();
  assert.equal(state.recovery.state, "attention");
  assert.equal(state.activities, 1);
  await assert.rejects(f.runtime.collectResult(f.runtime.attach(), "unit-1"), { code: "result-binding-mismatch" });
  assert.equal(f.runtime.status().acceptingLaunches, false);
});

test("corrupt inventory and wrong work-host scope fail startup without upstream mutations", async (t) => {
  for (const mode of ["corrupt", "foreign"]) {
    const f = await fixture(t, { foreign: mode === "foreign" });
    if (mode === "corrupt") await writeFile(join(f.directory, "journal", `${executorDigest("unit-1")}.json`), "{bad", { mode: 0o600 });
    await assert.rejects(f.runtime.start(), { code: mode === "foreign" ? "startup-journal-scope-mismatch" : "journal-unreadable" });
    assert.equal(f.runtime.status().recovery.state, "failed");
    assert.equal(f.runtime.status().acceptingLaunches, false);
    assert.throws(() => f.runtime.attach(), { code: "startup-reconciliation-required" });
    assert.deepEqual(f.server.requests.map(({ method }) => method), ["initialize", "initialized"]);
  }
});
