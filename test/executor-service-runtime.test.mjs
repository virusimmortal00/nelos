import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutorServiceRuntimeV1 } from "../src/executor-service-runtime.mjs";
import { ExecutorLaunchJournalV1 } from "../src/executor-launch-journal.mjs";
import { formatResultEnvelope } from "../src/work-result.mjs";
import { executorProviders, executorWave } from "./support/executor-fixture.mjs";
import { mockStdioAppServer } from "./support/mock-stdio-app-server.mjs";

async function until(predicate) {
  for (let i = 0; i < 400; i += 1) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail("condition did not settle");
}

async function fixture(t, { overrides = {}, channel = null, evaluate = undefined, wave = executorWave() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "nelos-service-runtime-"));
  const states = new Map();
  let wire;
  const handlers = {
    initialize: () => ({ userAgent: "codex-cli/0.152.0", codexHome: "/codex", platformFamily: "unix", platformOs: "linux" }),
    "thread/start": ({ params }) => {
      const id = `task-${states.size + 1}`;
      states.set(id, { name: null, turns: [] });
      return { thread: { id, cwd: params.cwd }, cwd: params.cwd, model: params.model,
        activePermissionProfile: { id: params.permissions }, approvalPolicy: params.approvalPolicy };
    },
    "thread/name/set": ({ params }) => { states.get(params.threadId).name = params.name; return {}; },
    "thread/read": ({ params }) => ({ thread: { id: params.threadId, ...states.get(params.threadId) } }),
    "turn/start": ({ params }) => {
      const turn = { id: `turn-${params.threadId}`, status: "inProgress", items: [] };
      states.get(params.threadId).turns = [turn];
      return { turn };
    },
    ...overrides,
  };
  const server = mockStdioAppServer((message, value) => { wire = value; return handlers[message.method](message, value); });
  const providers = executorProviders();
  const runtime = new ExecutorServiceRuntimeV1({ directory,
    scope: { hostId: "remote-fixture", codexHomeId: "c".repeat(64), authDomainId: "a".repeat(64) },
    runtimeGeneration: "b".repeat(64), sessionOptions: { command: "/bin/codex", cwd: "/workspace",
      codexHome: "/codex", spawnProcess: server.spawnProcess }, validateTarget: async () => true,
    grantOptions: { now: providers.now }, authorize: providers.authorize,
    evaluate: evaluate === undefined ? async (scope, { owner }) => {
      const result = await providers.evaluate(scope);
      result.context.ownerEpoch = owner.ownerEpoch;
      result.context.runtimeGeneration = owner.runtimeGeneration;
      return result;
    } : evaluate,
  });
  t.after(async () => {
    if (!["stopped", "failed"].includes(runtime.status().state)) server.children[0]?.emit("exit", 0);
    await runtime.stopped;
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.start();
  const client = runtime.attach();
  const ui = new AbortController();
  runtime.attachApprovalChannel({ signal: ui.signal, request: channel ?? (async ({ requestToken }) =>
    ({ requestToken, response: { decision: "decline" } })) });
  const grant = await runtime.requestGrant(client, { wave });
  const input = { wave, executionGrantId: grant.executionGrantId ?? null,
    prompts: wave.members.map(({ sliceId }) => ({ sliceId, text: "Implement the requested change." })),
    workUnits: wave.members.map((member) => ({ webId: "A1", queenThreadId: "queen", workUnitId: member.workUnitId,
      specRevision: 1, attempt: 1, memberKind: "spinoff", capabilities: ["observe", "read-result"], title: member.title,
      objectiveSummary: "Implement the requested change.", deliverable: "Patch", acceptanceCriteria: ["Tests pass"],
      dependencies: [], required: true, policy: { maxAttempts: 3, onBlocked: "queen-review", onFailure: "queen-review" } })),
  };
  const finish = (threadId = "task-1", member = wave.members[0]) => {
    const turn = { id: `turn-${threadId}`, status: "completed", items: [{ type: "agentMessage", phase: "final_answer",
      text: formatResultEnvelope({ schemaVersion: 1, workUnitId: member.workUnitId, specRevision: 1, attempt: 1,
        outcome: "succeeded", summary: "Completed fixture work", artifacts: [], verification: ["Fixture passed"],
        blockers: [], recoveryHint: null }) }] };
    states.get(threadId).turns = [turn];
    wire.send({ method: "turn/completed", params: { threadId, turn } });
  };
  return { runtime, client, input, grant, states, server, finish, ui,
    send: (message) => wire.send(message), journal: new ExecutorLaunchJournalV1({ directory: join(directory, "journal") }) };
}

test("frontend detach and drain preserve a worker until validated completion is durable", async (t) => {
  const f = await fixture(t);
  const second = f.runtime.attach();
  assert.equal((await f.runtime.launchWave(f.client, f.input)).kind, "wave-started");
  f.runtime.detach(f.client); f.runtime.detach(second);
  assert.equal(f.runtime.status().activities, 1);
  assert.equal(f.runtime.drain().state, "draining");
  const returning = f.runtime.attach();
  await assert.rejects(f.runtime.launchWave(returning, f.input), { code: "supervisor-not-accepting" });
  f.finish();
  assert.equal((await f.runtime.stopped).state, "stopped");
  assert.equal(f.runtime.status().activities, 0);
  const op = (await f.journal.read("unit-1")).operations.at(-1);
  assert.equal(op.completion.result.workOutcome, "succeeded");
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 1);
});

test("early terminal notifications wait for launch binding and automatically collect", async (t) => {
  let finish;
  const f = await fixture(t, { overrides: { "turn/start": ({ params }) => {
    finish(params.threadId);
    return { turn: { id: `turn-${params.threadId}`, status: "inProgress", items: [] } };
  } } });
  finish = f.finish;
  assert.equal((await f.runtime.launchWave(f.client, f.input)).kind, "wave-started");
  await until(() => f.runtime.status().activities === 0);
  const result = await f.runtime.collectResult(f.client, "unit-1");
  assert.equal(result.phase, "terminal");
  assert.equal(result.result.workOutcome, "succeeded");
});

test("a failed automatic result read retains the work hold until explicit collection succeeds", async (t) => {
  let failed = true;
  let states;
  const f = await fixture(t, { overrides: { "thread/read": ({ params }) => {
    if (params.includeTurns && failed) throw new Error("result read failed");
    return { thread: { id: params.threadId, ...states.get(params.threadId) } };
  } } });
  states = f.states;
  await f.runtime.launchWave(f.client, f.input);
  f.finish();
  await until(() => f.runtime.status().attention.length === 1);
  assert.equal(f.runtime.status().activities, 1);
  assert.equal((await f.journal.read("unit-1")).operations.at(-1).completion, null);
  failed = false;
  assert.equal((await f.runtime.collectResult(f.client, "unit-1")).phase, "terminal");
  assert.equal(f.runtime.status().activities, 0);
  assert.deepEqual(f.runtime.status().attention, []);
});

test("draining holds a pending approval through a concurrent terminal collection", async (t) => {
  let answer;
  const f = await fixture(t, { channel: ({ requestToken }) => new Promise((resolve) => {
    answer = () => resolve({ requestToken, response: { decision: "accept" } });
  }) });
  await f.runtime.launchWave(f.client, f.input);
  f.runtime.drain();
  f.send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {
    threadId: "task-1", turnId: "turn-task-1", itemId: "command-1", command: "git status",
    availableDecisions: ["accept", "decline", "cancel"],
  } });
  await until(() => typeof answer === "function");
  assert.equal(f.runtime.status().activities, 2);
  f.finish();
  await until(() => f.runtime.status().activities === 1);
  assert.equal(f.runtime.status().state, "draining");
  answer();
  await f.runtime.stopped;
  assert.equal(f.runtime.status().activities, 0);
  // Completion revokes eligibility; the late accept never reaches App Server.
  assert.ok(!f.server.requests.some((message) => message.id === "approval-1" && message.result?.decision === "accept"));
});

test("concurrent wave calls share holds and a lost launch response cannot release them", async (t) => {
  const f = await fixture(t);
  const outcomes = await Promise.all([f.runtime.launchWave(f.client, f.input), f.runtime.launchWave(f.client, f.input)]);
  assert.ok(outcomes.every(({ kind }) => ["wave-started", "reconciliation-required"].includes(kind)));
  assert.equal(f.runtime.status().activities, 1);
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 1);
  f.finish(); await until(() => f.runtime.status().activities === 0);
  const lost = await fixture(t, { overrides: { "thread/start": () => { throw new Error("unknown creation outcome"); } } });
  assert.equal((await lost.runtime.launchWave(lost.client, lost.input)).members[0].phase, "outcome-unknown");
  assert.equal(lost.runtime.status().activities, 1);
  assert.equal((await lost.runtime.recover(lost.client, "unit-1")).phase, "outcome-unknown");
  assert.equal(lost.runtime.drain().state, "draining");
});

test("missing providers, foreign hosts and disconnected approval channels cannot admit execution", async (t) => {
  const missing = await fixture(t, { evaluate: null });
  assert.notEqual(missing.grant.kind, "execution-granted");
  assert.notEqual((await missing.runtime.launchWave(missing.client, missing.input)).kind, "wave-started");
  assert.equal(missing.runtime.status().activities, 0);
  assert.equal(missing.server.requests.filter(({ method }) => method === "thread/start").length, 0);
  const foreignWave = executorWave(); foreignWave.members[0].target.hostId = "foreign";
  const foreign = await fixture(t, { wave: foreignWave });
  assert.equal(foreign.grant.reason, "execution-host-mismatch");
  const f = await fixture(t);
  assert.throws(() => f.runtime.requestGrant({}, { wave: f.input.wave }), { code: "unknown-service-client" });
  f.ui.abort();
  assert.equal((await f.runtime.launchWave(f.client, f.input)).reason, "approval-channel-unavailable");
  assert.equal(f.runtime.status().activities, 0);
});

test("partial waves keep the uncertain member held after the completed member is collected", async (t) => {
  const wave = executorWave();
  wave.members.push({ ...structuredClone(wave.members[0]), sliceId: "z-second", workUnitId: "unit-2",
    target: { ...wave.members[0].target, cwd: "/workspace/second" } });
  let first = true;
  const f = await fixture(t, { wave, overrides: { "thread/start": ({ params }) => {
    if (!first) throw new Error("second creation outcome lost");
    first = false;
    return { thread: { id: "task-1", cwd: params.cwd }, cwd: params.cwd, model: params.model,
      activePermissionProfile: { id: params.permissions }, approvalPolicy: params.approvalPolicy };
  } } });
  f.states.set("task-1", { name: null, turns: [] });
  const result = await f.runtime.launchWave(f.client, f.input);
  assert.deepEqual(result.members.map(({ phase }) => phase), ["running", "outcome-unknown"]);
  assert.equal(f.runtime.status().activities, 2);
  f.runtime.drain();
  f.finish();
  await until(() => f.runtime.status().activities === 1);
  assert.equal((await f.journal.read("unit-1")).operations.at(-1).completion.result.workOutcome, "succeeded");
  assert.equal((await f.journal.read("unit-2")).operations.at(-1).phase, "outcome-unknown");
  assert.equal(f.runtime.status().state, "draining");
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 2);
});
