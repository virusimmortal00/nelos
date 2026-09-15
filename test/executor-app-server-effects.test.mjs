import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { ExecutorLaunchCoordinatorV1 } from "../src/executor-launch-coordinator.mjs";
import { ExecutorLaunchJournalV1 } from "../src/executor-launch-journal.mjs";
import { ExecutorGrantAuthorityV1 } from "../src/executor-grants.mjs";
import { ExecutionStoreV1 } from "../src/execution-store.mjs";
import { withExecutorJournalLock } from "../src/task-state.mjs";
import { executorProviders } from "./support/executor-fixture.mjs";
import { formatResultEnvelope } from "../src/work-result.mjs";
import { executorAppServerFixture } from "./support/executor-app-server-fixture.mjs";

const turnIdentity = { threadId: "owned-task", turnId: "owned-turn" };

test("typed effects pin the exact route, profile, policy, environment and prompt on the wire", async (t) => {
  const f = await executorAppServerFixture(t);
  assert.equal((await f.create()).threadId, "owned-task");
  assert.deepEqual(await f.title(), { observedTitle: f.member.title });
  assert.deepEqual(await f.start(), { turnId: "owned-turn" });
  const creation = f.server.requests.find(({ method }) => method === "thread/start").params;
  assert.deepEqual(creation, { cwd: f.member.target.cwd, model: f.member.model, permissions: f.member.permissionProfile,
    approvalPolicy: f.member.approvalPolicy, ephemeral: false, serviceName: "nelos_executor", environments: [], allowProviderModelFallback: false });
  const start = f.server.requests.find(({ method }) => method === "turn/start").params;
  assert.deepEqual(start, { threadId: "owned-task", input: [{ type: "text", text: "Implement the requested change." }],
    clientUserMessageId: `nelos:${f.operationId}`, cwd: f.member.target.cwd, model: f.member.model,
    effort: f.member.reasoningEffort, permissions: f.member.permissionProfile, approvalPolicy: f.member.approvalPolicy, environments: [] });
});

test("no foreign task, altered prompt or duplicate start reaches the server", async (t) => {
  const f = await executorAppServerFixture(t);
  await assert.rejects(f.effects.setTitle({ threadId: "foreign", title: f.member.title }), { code: "foreign-executor-thread" });
  await f.create();
  await assert.rejects(f.create(), { code: "existing-effect-operation" });
  await assert.rejects(f.start(), { code: "turn-scope-mismatch" });
  await f.title();
  await assert.rejects(f.effects.startTurn({ member: f.member, threadId: "owned-task", prompt: "changed",
    clientUserMessageId: `nelos:${f.operationId}` }), { code: "turn-scope-mismatch" });
  await Promise.all([f.start(), assert.rejects(f.start(), { code: "turn-scope-mismatch" })]);
  await assert.rejects(f.effects.interrupt({ ...turnIdentity, turnId: "foreign" }));
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 1);
});

test("effective profile and contradictory cwd preserve creation identity but prevent a turn", async (t) => {
  for (const mismatch of ["profile", "cwd"]) {
    const f = await executorAppServerFixture(t, { overrides: { "thread/start": ({ params }) => ({
      thread: { id: "owned-task", cwd: mismatch === "cwd" ? "/elsewhere" : params.cwd },
      cwd: params.cwd, model: params.model, approvalPolicy: params.approvalPolicy,
      activePermissionProfile: { id: mismatch === "profile" ? "wrong" : params.permissions },
    }) } });
    assert.equal((await f.create()).threadId, "owned-task");
    await assert.rejects(f.title(), { code: "title-scope-mismatch" });
    assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 0);
  }
});

test("target verification runs before both creation and turn start", async (t) => {
  let valid = false;
  const f = await executorAppServerFixture(t, { validateTarget: () => valid });
  await assert.rejects(f.create(), { code: "execution-target-unverified" });
  assert.equal(f.server.requests.length, 2);
  valid = true;
  const next = await executorAppServerFixture(t, { validateTarget: () => valid });
  await next.create(); await next.title(); valid = false;
  await assert.rejects(next.start(), { code: "execution-target-unverified" });
  assert.equal(next.server.requests.filter(({ method }) => method === "turn/start").length, 0);
});

test("a title read must verify both identity and the actual title", async (t) => {
  for (const thread of [{ id: "other", name: "anything" }, { id: "owned-task", name: "wrong" }]) {
    const f = await executorAppServerFixture(t, { overrides: { "thread/read": () => ({ thread }) } });
    await f.create();
    if (thread.id === "other") await assert.rejects(f.title(), { code: "thread-read-identity-mismatch" });
    else assert.equal((await f.title()).observedTitle, "wrong");
    await assert.rejects(f.start());
  }
});

test("approval ownership waits for the returned turn identity and cancels on disconnect", async (t) => {
  let finish;
  const f = await executorAppServerFixture(t, { overrides: {
    "turn/start": () => new Promise((resolve) => { finish = resolve; }),
  } });
  await f.create(); await f.title();
  const starting = f.start(); await tick();
  let resolved = false;
  const owns = f.effects.ownsTurn(turnIdentity).then((value) => { resolved = true; return value; });
  await tick(); assert.equal(resolved, false);
  finish({ turn: { id: "owned-turn" } });
  await starting;
  assert.equal(await owns, true);
  assert.equal(await f.effects.ownsTurn({ ...turnIdentity, turnId: "foreign" }), false);
  f.session.close();
  assert.equal(await f.effects.ownsTurn(turnIdentity), false);
});

test("collection reads the exact owned turn and keeps transport completion separate from success", async (t) => {
  const f = await executorAppServerFixture(t);
  await f.create(); await f.title(); await f.start();
  await f.effects.interrupt(turnIdentity);
  assert.deepEqual(f.server.requests.at(-1).params, turnIdentity);
  f.state.turns = [{ id: "owned-turn", status: "completed", items: [
    { id: "final", type: "agentMessage", phase: "final_answer", text: "Finished the patch." },
  ] }, { id: "unrelated-later-turn", status: "failed", items: [] }];
  const result = await f.effects.readResult(turnIdentity);
  assert.equal(result.terminal, true);
  assert.equal(result.status, "completed");
  assert.equal(result.result.workOutcome, "unknown");
  assert.equal(result.result.attentionRequired, true);
  assert.doesNotMatch(JSON.stringify(result), /unrelated-later-turn/);
  await assert.rejects(f.effects.interrupt(turnIdentity), { code: "foreign-or-inactive-executor-turn" });
});

test("collection rejects missing, duplicate, partial and oversized results without latest-turn fallback", async (t) => {
  const f = await executorAppServerFixture(t);
  await f.create(); await f.title(); await f.start();
  const turn = { id: "owned-turn", status: "completed", items: [] };
  for (const turns of [[], [turn, turn], [{ ...turn, itemsView: "summary" }], [{ ...turn, items: [
    { type: "agentMessage", text: "x".repeat(64 * 1024 + 1) },
  ] }]]) {
    f.state.turns = turns;
    await assert.rejects(f.effects.readResult(turnIdentity));
  }
});

test("coordinator, journal, store and typed stdio effects complete one launch without replay", async (t) => {
  const f = await executorAppServerFixture(t);
  const root = await mkdtemp(join(tmpdir(), "nelos-owned-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new ExecutorLaunchJournalV1({ directory: join(root, "journal") });
  const store = new ExecutionStoreV1({ directory: join(root, "units") });
  const authority = new ExecutorGrantAuthorityV1(executorProviders());
  t.after(() => authority.close());
  const coordinator = new ExecutorLaunchCoordinatorV1({ authority, journal, store, effects: f.effects,
    withLock: (id, callback) => withExecutorJournalLock(join(root, "locks"), id, callback) });
  const grant = await authority.issue({ wave: f.wave });
  const input = { wave: f.wave, executionGrantId: grant.executionGrantId,
    prompts: [{ sliceId: f.member.sliceId, text: "Implement the requested change." }], workUnits: [{
      webId: "A1", queenThreadId: "queen", workUnitId: f.member.workUnitId, specRevision: 1, attempt: 1,
      memberKind: "spinoff", capabilities: ["observe", "read-result"], title: f.member.title,
      objectiveSummary: "Implement the requested change.", deliverable: "Patch", acceptanceCriteria: ["Pass tests"],
      dependencies: [], required: true, policy: { maxAttempts: 3, onBlocked: "queen-review", onFailure: "queen-review" },
    }] };
  assert.equal((await coordinator.launchWave(input)).kind, "wave-started");
  assert.equal((await journal.read(f.member.workUnitId)).operations.at(-1).turnId, "owned-turn");
  assert.equal((await store.read(f.member.workUnitId)).binding.memberThreadId, "owned-task");
  assert.equal((await coordinator.launchWave(input)).kind, "wave-started");
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 1);
  f.state.turns = [{ id: "owned-turn", status: "completed", items: [{ type: "agentMessage", phase: "final_answer",
    text: formatResultEnvelope({ schemaVersion: 1, workUnitId: f.member.workUnitId, specRevision: 1, attempt: 1,
      outcome: "succeeded", summary: "Implemented the change", artifacts: [], verification: ["Fixture assertion"], blockers: [], recoveryHint: null }),
  }] }];
  const collected = await coordinator.collectResult(f.member.workUnitId);
  assert.equal(collected.phase, "terminal");
  assert.equal(collected.result.workOutcome, "succeeded");
  assert.equal((await journal.read(f.member.workUnitId)).operations.at(-1).terminalStatus, "completed");
  assert.equal((await coordinator.collectResult(f.member.workUnitId)).phase, "terminal");
});

test("an envelope for another work-unit revision is never accepted as this worker's result", async (t) => {
  const f = await executorAppServerFixture(t);
  await f.create(); await f.title(); await f.start();
  f.state.turns = [{ id: "owned-turn", status: "completed", items: [{ type: "agentMessage", phase: "final_answer",
    text: formatResultEnvelope({ schemaVersion: 1, workUnitId: f.member.workUnitId, specRevision: 2, attempt: 1,
      outcome: "succeeded", summary: "Wrong revision", artifacts: [], verification: [], blockers: [], recoveryHint: null }),
  }] }];
  await assert.rejects(f.effects.readResult(turnIdentity), { code: "result-scope-mismatch" });
});

test("recorded result observation never grants live turn ownership or mutation rights", async (t) => {
  const f = await executorAppServerFixture(t, { validateRecovery: async () => true });
  f.state.turns = [{ id: "old-turn", status: "inProgress", items: [] }];
  const operation = { phase: "running", member: f.member, threadId: "owned-task", turnId: "old-turn" };
  assert.equal((await f.effects.readRecordedResult({ operation })).status, "inProgress");
  assert.equal(await f.effects.ownsTurn({ threadId: "owned-task", turnId: "old-turn" }), false);
  await assert.rejects(f.effects.interrupt({ threadId: "owned-task", turnId: "old-turn" }), { code: "foreign-or-inactive-executor-turn" });
  assert.deepEqual(f.server.requests.filter(({ method }) => !["initialize", "initialized"].includes(method)).map(({ method }) => method), ["thread/read"]);
});
