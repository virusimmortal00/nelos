import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { openAppServerClient } from "../src/app-server-client.mjs";
import { CodexAppServerBridgeV1 } from "../src/mcp-app-server-bridge.mjs";
import { probeAppServerExecutionV1 } from "../src/app-server-execution-profile.mjs";
import { mockStdioAppServer } from "./support/mock-stdio-app-server.mjs";
import { startMockAppServer } from "./support/mock-app-server.mjs";
import { executionProbeResponses, probeSelection } from "./support/execution-probe-fixture.mjs";

const identity = { userAgent: "codex-cli/0.152.0", codexHome: "/private/codex-home", platformFamily: "unix", platformOs: "linux" };
const initialize = (handler) => (message, wire) => message.method === "initialize" ? identity : handler(message, wire);

function nextReply(server) {
  return new Promise((resolve) => {
    const listener = (message) => {
      if (Object.hasOwn(message, "method")) return;
      server.messages.removeListener("message", listener);
      resolve(message);
    };
    server.messages.on("message", listener);
  });
}

for (const transport of ["stdio", "unix-websocket"]) {
  test(`${transport}: live discovery, events and colliding approval IDs use distinct dispatch paths`, { timeout: 2000 }, async (t) => {
    const responses = executionProbeResponses();
    const events = [];
    const approvals = [];
    const dispatcherOptions = {
      onNotification: (event) => events.push(event.method),
      onServerRequest: (request) => {
        approvals.push(request.id);
        return { decision: "decline" };
      },
    };
    const handler = initialize((message, { send }) => {
      if (message.method === "model/list") {
        send({ method: "item/started", params: { threadId: "owned-task" } });
        send({ id: message.id, method: "item/commandExecution/requestApproval", params: { threadId: "owned-task" } });
      }
      return responses[message.method];
    });
    let server;
    let runProbe;
    if (transport === "stdio") {
      server = mockStdioAppServer(handler);
      const bridge = new CodexAppServerBridgeV1({ spawnProcess: server.spawnProcess, dispatcherOptions });
      t.after(() => bridge.close());
      runProbe = () => bridge.probeExecution(probeSelection);
    } else {
      const root = await mkdtemp(join(tmpdir(), "nelos-bidir-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      server = await startMockAppServer(join(root, "app.sock"), handler);
      t.after(() => server.close());
      const client = await openAppServerClient({ socketPath: join(root, "app.sock"), clientName: "test", clientTitle: "test", dispatcherOptions });
      t.after(() => client.close());
      runProbe = () => probeAppServerExecutionV1({ observedVersion: "0.152.0", options: probeSelection,
        request: (method, params, context) => client.request(method, params, context) });
    }
    const replyPromise = nextReply(server);
    const result = await runProbe();
    const reply = await replyPromise;
    assert.equal(result.state, "discovery-complete");
    assert.equal(result.executionAuthorized, false);
    assert.deepEqual(events, ["item/started"]);
    assert.equal(approvals[0], server.requests.find(({ method }) => method === "model/list").id);
    assert.deepEqual(reply, { id: approvals[0], result: { decision: "decline" } });
    assert.ok(server.requests.every(({ method }) => !["thread/start", "turn/start"].includes(method)));
  });
}

test("a stdio probe never combines successful reads from different child processes", async (t) => {
  const responses = executionProbeResponses();
  const server = mockStdioAppServer(initialize((message, { child }) => {
    if (message.method === "permissionProfile/list") child.emit("exit", 1);
    return responses[message.method];
  }));
  const bridge = new CodexAppServerBridgeV1({ spawnProcess: server.spawnProcess });
  t.after(() => bridge.close());
  const result = await bridge.probeExecution(probeSelection);
  assert.equal(result.state, "unavailable");
  assert.equal(server.children.length, 1);
  assert.ok(result.blockers.some(({ code }) => code === "probe-connection-changed"));
  assert.equal((await bridge.health()).mutationAttempts, 0);
});

test("closing and reconnecting stdio invalidates pending approval replies", { timeout: 2000 }, async (t) => {
  let answer;
  let signal;
  let entered;
  const entry = new Promise((resolve) => { entered = resolve; });
  const responses = executionProbeResponses();
  const server = mockStdioAppServer(initialize((message, { send }) => {
    if (message.method === "model/list" && server.children.length === 1) {
      send({ id: "old-approval", method: "approval" });
    }
    return responses[message.method];
  }));
  const bridge = new CodexAppServerBridgeV1({ spawnProcess: server.spawnProcess,
    dispatcherOptions: { onServerRequest: (request) => {
      signal = request.signal;
      entered();
      return new Promise((resolve) => { answer = resolve; });
    } },
  });
  t.after(() => bridge.close());
  await bridge.probeExecution(probeSelection);
  await entry;
  server.children[0].emit("exit", 1);
  await bridge.health({ probe: true });
  assert.equal(server.children.length, 2);
  assert.equal(signal.aborted, true);
  answer({ decision: "accept" });
  await tick();
  assert.ok(!server.requests.some(({ id }) => id === "old-approval"));
});

test("malformed probe selection is rejected before a process is spawned", async () => {
  let spawned = false;
  const bridge = new CodexAppServerBridgeV1({ spawnProcess: () => { spawned = true; } });
  await assert.rejects(bridge.probeExecution({ ...probeSelection, launcherAvailable: true }));
  assert.equal(spawned, false);
  await bridge.close();
});

test("stdio preserves unsupported-method errors for preflight without surfacing arbitrary error text", async (t) => {
  const responses = executionProbeResponses();
  const server = mockStdioAppServer(initialize((message) => {
    if (message.method === "permissionProfile/list") throw Object.assign(new Error("private secret"), { rpcCode: -32601 });
    return responses[message.method];
  }));
  const bridge = new CodexAppServerBridgeV1({ spawnProcess: server.spawnProcess });
  t.after(() => bridge.close());
  const result = await bridge.probeExecution(probeSelection);
  assert.deepEqual(result.blockers, [{ code: "probe-method-unsupported", method: "permissionProfile/list", rpcCode: -32601 }]);
  assert.doesNotMatch(JSON.stringify(result), /private secret/);
});

test("stdio bounds each JSONL message, allowing several valid messages in one chunk", async (t) => {
  const responses = executionProbeResponses();
  const server = mockStdioAppServer(initialize((message, { child }) => {
    if (message.method === "model/list") {
      const event = `${JSON.stringify({ method: "item/outputDelta", params: "x".repeat(2 * 1024 * 1024) })}\n`;
      child.stdout.write(event + event);
    }
    return responses[message.method];
  }));
  const bridge = new CodexAppServerBridgeV1({ spawnProcess: server.spawnProcess });
  t.after(() => bridge.close());
  assert.equal((await bridge.probeExecution(probeSelection)).state, "discovery-complete");
});

test("an oversized incomplete stdio message ends discovery without reconnecting", async (t) => {
  const responses = executionProbeResponses();
  const server = mockStdioAppServer(initialize((message, { child }) => {
    if (message.method === "model/list") child.stdout.write("x".repeat(4 * 1024 * 1024 + 1));
    return responses[message.method];
  }));
  const bridge = new CodexAppServerBridgeV1({ spawnProcess: server.spawnProcess });
  t.after(() => bridge.close());
  assert.equal((await bridge.probeExecution(probeSelection)).state, "unavailable");
  assert.equal(server.children.length, 1);
  assert.equal((await bridge.health()).lastFailure.code, "response-too-large");
});

test("a backpressured stdio approval response fails the connection instead of accumulating writes", async (t) => {
  const responses = executionProbeResponses();
  const server = mockStdioAppServer(initialize((message, { child, send }) => {
    if (message.method === "model/list") {
      Object.defineProperty(child.stdin, "writableLength", { get: () => 4 * 1024 * 1024 });
      send({ id: "approval", method: "item/commandExecution/requestApproval" });
    }
    return responses[message.method];
  }));
  const bridge = new CodexAppServerBridgeV1({ spawnProcess: server.spawnProcess });
  t.after(() => bridge.close());
  assert.equal((await bridge.probeExecution(probeSelection)).state, "unavailable");
  assert.ok(!server.requests.some(({ id }) => id === "approval"));
  assert.equal(server.children.length, 1);
});
