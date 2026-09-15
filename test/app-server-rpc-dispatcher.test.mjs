import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import {
  AppServerRpcDispatcher,
  appServerResponseError,
} from "../src/app-server-rpc-dispatcher.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(t, options = {}) {
  const responses = [];
  const sent = [];
  const errors = [];
  const dispatcher = new AppServerRpcDispatcher({
    sendResponse: (message) => sent.push(message),
    onResponse: (message) => responses.push(message),
    onError: (error) => errors.push(error),
    ...options,
  });
  t.after(() => dispatcher.close());
  return { dispatcher, responses, sent, errors };
}

test("colliding server IDs, slow event consumers, and responses stay independent", async (t) => {
  const eventGate = deferred();
  const approvalGate = deferred();
  const events = [];
  const approvals = [];
  const h = harness(t, {
    onNotification: async ({ params }) => {
      events.push(params.ordinal);
      if (params.ordinal === 1) await eventGate.promise;
    },
    onServerRequest: async (request) => {
      approvals.push(request);
      await approvalGate.promise;
      return { decision: "decline" };
    },
  });
  h.dispatcher.receive({ method: "item/started", params: { ordinal: 1 } });
  h.dispatcher.receive({ id: 7, method: "item/commandExecution/requestApproval", params: {} });
  h.dispatcher.receive({ id: 7, result: { thread: { id: "created-task" } } });
  h.dispatcher.receive({ method: "turn/completed", params: { ordinal: 2 } });
  await tick();
  assert.equal(h.responses[0].result.thread.id, "created-task");
  assert.deepEqual(events, [1]);
  assert.equal(approvals.length, 1);
  assert.deepEqual(h.sent, []);
  approvalGate.resolve();
  await tick();
  assert.deepEqual(h.sent, [{ id: 7, result: { decision: "decline" } }]);
  eventGate.resolve();
  await tick();
  assert.deepEqual(events, [1, 2]);
  assert.deepEqual(h.errors, []);
});

test("an absent handler returns method-not-found and never grants approval", (t) => {
  const h = harness(t);
  h.dispatcher.receive({ id: "approval", method: "item/permissions/requestApproval", params: {} });
  assert.deepEqual(h.sent, [{
    id: "approval", error: { code: -32601, message: "Method not supported" },
  }]);
  assert.deepEqual(h.responses, []);
});

test("pending approvals are bounded and time out without fabricating a decision", async (t) => {
  const gate = deferred();
  const entered = deferred();
  const answered = deferred();
  let signal;
  const h = harness(t, {
    serverRequestTimeoutMs: 20,
    maxServerRequests: 1,
    onServerRequest: (request) => {
      signal = request.signal;
      entered.resolve();
      return gate.promise;
    },
    sendResponse: (reply) => { if (reply.id === 1) answered.resolve(reply); },
  });
  h.dispatcher.receive({ id: 1, method: "approval" });
  await entered.promise;
  h.dispatcher.receive({ id: 2, method: "approval" });
  const reply = await answered.promise;
  assert.equal(reply.error.code, -32000);
  assert.equal(signal.aborted, true);
  gate.resolve({ decision: "accept" });
  await tick();
  assert.deepEqual(h.errors, []);
});

test("excess requests receive a bounded error while the first handler stays pending", async (t) => {
  const h = harness(t, { maxServerRequests: 1, onServerRequest: () => new Promise(() => {}) });
  h.dispatcher.receive({ id: 1, method: "approval" });
  h.dispatcher.receive({ id: 2, method: "approval" });
  assert.equal(h.sent[0].id, 2);
  assert.equal(h.sent[0].error.code, -32000);
  h.dispatcher.close();
  await tick();
});

test("closing a connection aborts handlers and drops their late replies", async (t) => {
  const gate = deferred();
  let signal;
  const h = harness(t, { onServerRequest: (request) => {
    signal = request.signal;
    return gate.promise;
  } });
  h.dispatcher.receive({ id: "same-id", method: "approval" });
  await tick();
  h.dispatcher.close();
  gate.resolve({ decision: "accept" });
  await tick();
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.sent, []);
});

test("server-side resolution cancels a pending approval before a blocked event consumer catches up", async (t) => {
  const gate = deferred();
  let signal;
  const h = harness(t, {
    onNotification: () => new Promise(() => {}),
    onServerRequest: (request) => { signal = request.signal; return gate.promise; },
  });
  h.dispatcher.receive({ method: "item/started" });
  h.dispatcher.receive({ id: 9, method: "approval", params: { threadId: "worker" } });
  await tick();
  h.dispatcher.receive({ method: "serverRequest/resolved", params: { requestId: 9, threadId: "different-worker" } });
  assert.equal(signal.aborted, false);
  h.dispatcher.receive({ method: "serverRequest/resolved", params: { requestId: 9, threadId: "worker" } });
  assert.equal(signal.aborted, true);
  gate.resolve({ decision: "accept" });
  await tick();
  assert.deepEqual(h.sent, []);
});

test("notification count and byte overflow invalidate the connection instead of losing events", async (t) => {
  for (const options of [{ maxPendingNotifications: 1 }, { maxNotificationBytes: 90 }]) {
    const h = harness(t, {
      ...options,
      onNotification: () => new Promise(() => {}),
    });
    h.dispatcher.receive({ method: "event", params: "x".repeat(25) });
    h.dispatcher.receive({ method: "event", params: "x".repeat(25) });
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0].code, "notification-overflow");
    h.dispatcher.receive({ id: 1, result: {} });
    assert.deepEqual(h.responses, []);
  }
  await tick();
});

test("duplicate incoming IDs and malformed envelopes cannot resolve outgoing requests", (t) => {
  for (const message of [null, [], {}, { id: null, result: {} },
    { id: 1, method: "approval", result: {} }, { id: 1, error: null },
    { id: 1, result: {}, error: {} }, { method: "" }]) {
    const h = harness(t);
    h.dispatcher.receive(message);
    assert.equal(h.errors.length, 1);
    assert.deepEqual(h.responses, []);
  }
  const h = harness(t, { onServerRequest: () => new Promise(() => {}) });
  h.dispatcher.receive({ id: 1, method: "approval" });
  h.dispatcher.receive({ id: 1, method: "approval" });
  assert.match(h.errors[0].message, /Duplicate pending/);
});

test("callback failures, invalid results, and write failures do not leak exception data", async (t) => {
  const h = harness(t, { onServerRequest: () => { throw new Error("secret prompt"); } });
  h.dispatcher.receive({ id: 1, method: "approval" });
  await tick();
  assert.equal(h.sent[0].error.code, -32603);
  assert.doesNotMatch(JSON.stringify(h.sent), /secret/);
  for (const result of [undefined, 1n, { toJSON() { throw new Error("secret"); } }]) {
    const invalid = harness(t, { onServerRequest: () => result });
    invalid.dispatcher.receive({ id: 2, method: "approval" });
    await tick();
    assert.equal(invalid.errors.length, 1);
    assert.deepEqual(invalid.sent, []);
    assert.doesNotMatch(invalid.errors[0].message, /secret/);
  }
  const broken = harness(t, { sendResponse: () => { throw new Error("secret write"); } });
  broken.dispatcher.receive({ id: 3, method: "unknown" });
  assert.equal(broken.errors.length, 1);
  assert.doesNotMatch(broken.errors[0].message, /secret/);
});

test("event handler failure aborts the subscription and preserves structured response errors", async (t) => {
  const h = harness(t, { onNotification: () => { throw new Error("secret event"); } });
  h.dispatcher.receive({ method: "event" });
  await tick();
  assert.equal(h.errors[0].code, "notification-handler-failed");
  const error = appServerResponseError({ code: -32601, message: "secret", data: "secret" });
  assert.equal(error.rpcCode, -32601);
  assert.equal(error.code, "request-rejected");
  assert.doesNotMatch(JSON.stringify(error), /secret/);
});

test("invalid dispatcher limits fail before connecting", () => {
  for (const options of [{ maxServerRequests: 0 }, { serverRequestTimeoutMs: Infinity },
    { maxNotificationBytes: -1 }, { maxPendingNotifications: 0 }, { onNotification: true }]) {
    assert.throws(() => new AppServerRpcDispatcher({
      sendResponse() {}, onResponse() {}, onError() {}, ...options,
    }));
  }
});
