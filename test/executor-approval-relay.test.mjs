import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { ExecutorApprovalRelayV1 } from "../src/executor-approval-relay.mjs";
import { executorAppServerFixture } from "./support/executor-app-server-fixture.mjs";

const command = "item/commandExecution/requestApproval";
const params = { threadId: "owned-task", turnId: "owned-turn", itemId: "command-1", startedAtMs: 1000,
  command: "git status", availableDecisions: ["accept", "decline", "cancel"] };
function fixture(t, options = {}) {
  const relay = new ExecutorApprovalRelayV1({ ownsTurn: async (scope) => scope.threadId === "owned-task" && scope.turnId === "owned-turn", ...options });
  const upstream = new AbortController(); const channel = new AbortController();
  t.after(() => relay.close());
  const attach = (request) => relay.attachChannel({ request, signal: channel.signal });
  const handle = (changes = {}) => relay.handle({ id: 1, method: command, params, signal: upstream.signal, ...changes });
  return { relay, upstream, channel, attach, handle };
}

test("only the trusted channel can answer a request on a live owned turn", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.handle(), { decision: "cancel" });
  const seen = [];
  f.attach(async (request) => { seen.push(request); return { requestToken: request.requestToken, response: { decision: "accept" } }; });
  assert.deepEqual(await f.handle(), { decision: "accept" });
  assert.deepEqual(await f.handle({ params: { ...params, turnId: "foreign" } }), { decision: "cancel" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].params.command, "git status");
  assert.deepEqual(seen[0].supportedDecisions, ["accept", "decline", "cancel"]);
  assert.doesNotMatch(JSON.stringify(f.relay.status()), /git status|owned-task/);
});

test("stale tokens, unoffered choices, session grants and policy amendments are canceled", async (t) => {
  const f = fixture(t);
  for (const response of [{ decision: "acceptForSession" }, { decision: { acceptWithExecpolicyAmendment: {} } },
    { decision: "accept", extra: true }]) {
    f.attach(async ({ requestToken }) => ({ requestToken, response }));
    assert.deepEqual(await f.handle(), { decision: "cancel" });
  }
  f.attach(async () => ({ requestToken: "old-request", response: { decision: "accept" } }));
  assert.deepEqual(await f.handle(), { decision: "cancel" });
  f.attach(async ({ requestToken }) => ({ requestToken, response: { decision: "accept" } }));
  assert.deepEqual(await f.handle({ params: { ...params, availableDecisions: ["decline", "cancel"] } }), { decision: "cancel" });
});

test("ownership is rechecked after the decision instead of approving a completed or replaced turn", async (t) => {
  let owned = true;
  const f = fixture(t, { ownsTurn: async () => owned });
  f.attach(async ({ requestToken }) => { owned = false; return { requestToken, response: { decision: "accept" } }; });
  assert.deepEqual(await f.handle(), { decision: "cancel" });
});

test("disconnect, request resolution and channel replacement abort a pending answer", async (t) => {
  for (const mode of ["disconnect", "resolved", "replace", "close"]) {
    const f = fixture(t);
    let complete; let signal;
    const detach = f.attach((request, context) => {
      signal = context.signal;
      return new Promise((resolve) => { complete = () => resolve({ requestToken: request.requestToken, response: { decision: "accept" } }); });
    });
    const pending = f.handle(); await tick();
    if (mode === "disconnect") detach();
    if (mode === "resolved") f.upstream.abort();
    if (mode === "replace") f.attach(async () => ({}));
    if (mode === "close") f.relay.close();
    assert.deepEqual(await pending, { decision: "cancel" });
    assert.equal(signal.aborted, true);
    complete(); await tick();
    assert.equal(f.relay.status().pending, 0);
  }
});

test("timed-out handlers retain capacity until they settle and cannot approve late", async (t) => {
  const f = fixture(t, { timeoutMs: 10, maximumPending: 1 });
  let complete; let calls = 0;
  f.attach((request) => {
    calls += 1; return new Promise((resolve) => { complete = () => resolve({ requestToken: request.requestToken, response: { decision: "accept" } }); });
  });
  assert.deepEqual(await f.handle(), { decision: "cancel" });
  assert.equal(f.relay.status().pending, 1);
  assert.deepEqual(await f.handle(), { decision: "cancel" });
  assert.equal(calls, 1);
  complete(); await tick(); assert.equal(f.relay.status().pending, 0);
});

test("user answers remain scoped to supplied question IDs and preserve multiline text", async (t) => {
  const f = fixture(t);
  const request = { method: "item/tool/requestUserInput", params: { ...params, isBlocking: true,
    questions: [{ id: "choice", header: "Choose", question: "What should happen?" }] } };
  f.attach(async ({ requestToken }) => ({ requestToken, response: { answers: { choice: { answers: ["First line\nSecond line"] } } } }));
  assert.equal((await f.handle(request)).answers.choice.answers[0], "First line\nSecond line");
  f.attach(async ({ requestToken }) => ({ requestToken, response: { answers: { foreign: { answers: ["yes"] } } } }));
  assert.deepEqual(await f.handle(request), { answers: {} });
});

test("elicitation requires a correlated owned turn and explicit user-provided content", async (t) => {
  const f = fixture(t);
  const request = { method: "mcpServer/elicitation/request", params: { ...params, mode: "form", serverName: "service",
    message: "Choose a value", requestedSchema: { type: "object" } } };
  f.attach(async ({ requestToken }) => ({ requestToken, response: { action: "accept", content: { choice: "selected" } } }));
  assert.deepEqual(await f.handle(request), { action: "accept", content: { choice: "selected" } });
  assert.deepEqual(await f.handle({ ...request, params: { ...request.params, turnId: null } }), { action: "cancel", content: null });
  await assert.rejects(f.handle({ method: "account/chatgptAuthTokens/refresh" }), { code: "unsupported-server-request" });
});

test("stdio launch can receive an approval before turn/start responds without granting foreign work", async (t) => {
  let effects;
  const relay = new ExecutorApprovalRelayV1({ ownsTurn: (...args) => effects.ownsTurn(...args) });
  t.after(() => relay.close());
  const channel = new AbortController();
  relay.attachChannel({ signal: channel.signal, request: async ({ requestToken }) => ({ requestToken, response: { decision: "decline" } }) });
  const f = await executorAppServerFixture(t, { dispatcherOptions: { onServerRequest: (request) => relay.handle(request) }, overrides: {
    "turn/start": ({ id }, { send }) => {
      send({ id, method: command, params });
      return { turn: { id: "owned-turn", items: [], status: "inProgress" } };
    },
  } });
  effects = f.effects;
  await f.create(); await f.title(); await f.start(); await tick();
  const reply = f.server.requests.find((message) => !message.method);
  assert.deepEqual(reply.result, { decision: "decline" });
  assert.equal(await effects.ownsTurn({ threadId: "owned-task", turnId: "owned-turn" }), true);
});

test("a completion event while the user decides makes a late accept ineligible", async (t) => {
  const f = await executorAppServerFixture(t);
  await f.create(); await f.title(); await f.start();
  const r = fixture(t, { ownsTurn: (...args) => f.effects.ownsTurn(...args) });
  let complete;
  r.attach(({ requestToken }) => new Promise((resolve) => { complete = () => resolve({ requestToken, response: { decision: "accept" } }); }));
  const pending = r.handle(); await tick();
  assert.equal(await f.effects.observeNotification({ method: "turn/completed",
    params: { threadId: "owned-task", turn: { id: "foreign", status: "completed" } } }), null);
  const event = await f.effects.observeNotification({ method: "turn/completed",
    params: { threadId: "owned-task", turn: { id: "owned-turn", status: "completed" } } });
  assert.equal(event.readResultRequired, true);
  complete();
  assert.deepEqual(await pending, { decision: "cancel" });
});
