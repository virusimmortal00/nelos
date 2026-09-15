import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { ExecutorAppServerSessionV1 } from "../src/executor-app-server-session.mjs";
import { mockStdioAppServer } from "./support/mock-stdio-app-server.mjs";

const identity = { userAgent: "codex-cli/0.152.0", codexHome: "/codex-home", platformFamily: "unix", platformOs: "linux" };
function fixture(t, handler = () => ({}), options = {}, initialize = identity) {
  const server = mockStdioAppServer((message, wire) => message.method === "initialize" ? initialize : handler(message, wire));
  const session = new ExecutorAppServerSessionV1({ command: "/bin/codex", cwd: "/workspace", codexHome: "/codex-home",
    spawnProcess: server.spawnProcess, ...options });
  t.after(() => session.close());
  return { session, server };
}

test("one owned connection initializes once and preserves explicit host placement", async (t) => {
  let placement;
  const server = mockStdioAppServer(() => identity);
  const session = new ExecutorAppServerSessionV1({ command: "/bin/codex", cwd: "/remote/repo", codexHome: "/codex-home",
    spawnProcess: (...args) => { placement = args; return server.spawnProcess(); } });
  t.after(() => session.close());
  await Promise.all([session.open(), session.open()]);
  assert.equal(server.children.length, 1);
  assert.deepEqual(placement.slice(0, 2), ["/bin/codex", ["app-server", "--stdio"]]);
  assert.equal(placement[2].cwd, "/remote/repo");
  assert.equal(placement[2].env.CODEX_HOME, "/codex-home");
  assert.deepEqual(server.requests.map(({ method }) => method), ["initialize", "initialized"]);
  assert.equal(session.status().runtimeCertified, false);
  assert.equal(session.status().observedVersion, "0.152.0");
});

test("exit rejects pending effects and never reconnects on requests or open", async (t) => {
  const { session, server } = fixture(t, () => new Promise(() => {}));
  await session.open();
  const request = session.request("turn/start", {});
  server.children[0].emit("exit", 1);
  await assert.rejects(request, { code: "session-unavailable" });
  await assert.rejects(session.open(), { code: "session-unavailable" });
  await assert.rejects(session.request("thread/read", {}), { code: "session-unavailable" });
  assert.equal(server.children.length, 1);
  assert.equal(session.signal.aborted, true);
});

test("timeout and cancellation do not replay a mutation or shut down other owned work", async (t) => {
  let reply;
  const { session, server } = fixture(t, () => new Promise((resolve) => { reply = resolve; }));
  await session.open();
  await assert.rejects(session.request("thread/start", {}, { timeoutMs: 10 }), { code: "session-request-timeout" });
  reply({ thread: { id: "late-task" } });
  await tick();
  const controller = new AbortController();
  const pending = session.request("turn/start", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "session-request-aborted" });
  assert.equal(server.requests.filter(({ method }) => method === "thread/start").length, 1);
  assert.equal(session.status().state, "ready");
  assert.equal(session.status().pendingRequests, 0);
});

test("server requests remain independent and close cancels late approval replies", async (t) => {
  let complete;
  let approvalSignal;
  let entered;
  const called = new Promise((resolve) => { entered = resolve; });
  const { session, server } = fixture(t, ({ id }, { send }) => {
    send({ id, method: "item/commandExecution/requestApproval", params: { threadId: "task" } });
    return { ok: true };
  }, { dispatcherOptions: { onServerRequest: ({ signal }) => {
    approvalSignal = signal; entered(); return new Promise((resolve) => { complete = resolve; });
  } } });
  await session.open();
  assert.deepEqual(await session.request("turn/start", {}), { ok: true });
  await called;
  session.close();
  assert.equal(approvalSignal.aborted, true);
  complete({ decision: "accept" });
  await tick();
  assert.ok(server.requests.every((message) => Object.hasOwn(message, "method")));
});

test("wrong home, missing identity fields, and malformed streams fail closed", async (t) => {
  for (const initialize of [{ ...identity, codexHome: "/other" },
    { ...identity, platformFamily: "" }, { ...identity, platformOs: null }]) {
    const { session } = fixture(t, undefined, {}, initialize);
    await assert.rejects(session.open(), { code: "session-identity-mismatch" });
  }
  const { session, server } = fixture(t);
  await session.open();
  server.children[0].stdout.write("{bad-json}\n");
  assert.equal(session.status().state, "failed");
});

test("owned sessions accept working older, future, prerelease and unversioned runtimes", async (t) => {
  for (const [userAgent, expected] of [
    ["codex-cli/0.100.0", "0.100.0"],
    ["Codex Desktop/0.154.0-alpha.6.3 (test)", "0.154.0-alpha.6.3"],
    ["nelos_executor/6.0.0", "6.0.0"],
    ["Future Desktop/6.0.0+unreviewed", "6.0.0+unreviewed"],
    ["nelos_executor/dev-build", null],
    ["Codex Desktop/0.154.0/other", null],
    ["Codex preview build", null],
  ]) {
    const { session } = fixture(t, () => ({ ok: true }), {}, { ...identity, userAgent });
    assert.equal((await session.open()).observedVersion, expected);
    assert.deepEqual(await session.request("thread/read", { threadId: "task" }), { ok: true });
    assert.equal(session.status().runtimeCertified, false);
  }
});

test("standalone SSH identity uses the explicit initialization client name", async (t) => {
  for (const version of ["0.154.0", "0.154.0-alpha.6.2"]) {
    const { session, server } = fixture(t, undefined, {}, { ...identity,
      userAgent: `nelos_executor/${version} (Mac OS 26.5.2; arm64) unknown (nelos_executor; 1.0.0)` });
    assert.equal((await session.open()).observedVersion, version);
    assert.equal(server.requests[0].params.clientInfo.name, "nelos_executor");
  }
});

test("startup deadline and close-before-open do not leave a replacement process", async (t) => {
  const { session, server } = fixture(t, undefined, { timeoutMs: 10 }, new Promise(() => {}));
  await assert.rejects(session.open(), { code: "session-request-timeout" });
  assert.equal(session.signal.aborted, true);
  await assert.rejects(session.open());
  assert.equal(server.children.length, 1);
  const next = fixture(t);
  const opening = next.session.open();
  next.session.close();
  await assert.rejects(opening);
  assert.equal(next.server.children.length, 0);
});

test("inbound and outbound memory limits terminate the session", async (t) => {
  const { session, server } = fixture(t);
  await session.open();
  server.children[0].stdout.write("x".repeat(4 * 1024 * 1024 + 1));
  assert.equal(session.status().reason, "session-message-too-large");
  const next = fixture(t);
  await next.session.open();
  await assert.rejects(next.session.request("thread/start", { prompt: "x".repeat(4 * 1024 * 1024) }));
  assert.equal(next.server.requests.length, 2);
});

test("an absent interaction handler never accepts a server approval", async (t) => {
  const { session, server } = fixture(t, ({ id }, { send }) => {
    send({ id, method: "item/fileChange/requestApproval", params: {} });
    return {};
  });
  await session.open();
  await session.request("turn/start", {});
  assert.equal(server.requests.find((message) => !message.method).error.code, -32601);
});

test("spawn failure acknowledges shutdown even when the child emits close without exit", async (t) => {
  const session = new ExecutorAppServerSessionV1({ command: "/nelos-missing-executable-for-test",
    cwd: process.cwd(), codexHome: "/codex-home" });
  t.after(() => session.close());
  await assert.rejects(session.open(), { code: "session-process-failed" });
  await session.stopped;
  assert.equal(session.status().state, "failed");
});

test("shutdown escalates only its own child handle and stops after exit", async (t) => {
  const { session, server } = fixture(t, undefined, { stopGraceMs: 10 });
  await session.open();
  const signals = [];
  server.children[0].kill = (signal) => { signals.push(signal); return true; };
  session.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  server.children[0].emit("exit", 0);
});
