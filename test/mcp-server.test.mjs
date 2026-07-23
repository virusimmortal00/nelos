import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  listNelosMcpTools,
  startNelosMcpServer,
} from "../src/mcp-server.mjs";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

function validPlan() {
  return {
    schemaVersion: 1,
    objective: "demo objective",
    slices: [
      {
        id: "explore",
        title: "Explore",
        objective: "bounded exploration",
        deliverable: "notes",
        acceptanceCriteria: ["notes recorded"],
        dependsOn: [],
        lifecycle: "subagent",
        workspaceMode: "shared-read-only",
        taskShape: "everyday",
      },
    ],
  };
}

async function roundTrip(messages) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const exited = new Promise((resolve) => {
    startNelosMcpServer({
      input,
      output,
      serverVersion: "0.0.0-test",
      onExit: resolve,
    });
  });
  for (const message of messages) {
    input.write(`${JSON.stringify(message)}\n`);
  }
  input.end();
  assert.equal(await exited, 0);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function toolBody(response) {
  assert.equal(response.error, undefined);
  return {
    isError: response.result.isError,
    body: JSON.parse(response.result.content[0].text),
  };
}

test("initialize returns the tools capability and server identity", async () => {
  const [response] = await roundTrip([INITIALIZE]);
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(response.result.serverInfo, {
    name: "nelos",
    version: "0.0.0-test",
  });
});

test("tools/list exposes exactly the three socket-free read-only tools", async () => {
  const [, response] = await roundTrip([
    INITIALIZE,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const tools = response.result.tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "nelos_plan_slices",
      "nelos_intelligence_route",
      "nelos_intelligence_verify",
    ],
  );
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual(tools, listNelosMcpTools());

  const planner = tools.find(({ name }) => name === "nelos_plan_slices");
  const plan = planner.inputSchema.properties.plan;
  assert.equal(plan.properties.schemaVersion.const, 1);
  assert.deepEqual(plan.required, ["schemaVersion", "objective", "slices"]);
  assert.equal(plan.properties.slices.items.additionalProperties, false);
  assert.deepEqual(plan.properties.slices.items.properties.lifecycle.enum, [
    "spinoff",
    "subagent",
  ]);
});

test("nelos_plan_slices routes a valid plan into waves", async () => {
  const [, response] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "nelos_plan_slices", arguments: { plan: validPlan() } },
    },
  ]);
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.command, "plan slices");
  assert.equal(body.plan.schemaVersion, 1);
  assert.equal(body.plan.summary.slices, 1);
  assert.ok(Array.isArray(body.plan.waves));
  assert.equal(body.plan.waves.length, 1);
  assert.deepEqual(body.nextAction, {
    schemaVersion: 1,
    kind: "launch-wave",
    waveIndex: 1,
    members: [
      {
        sliceId: "explore",
        lifecycle: "subagent",
        title: "Explore",
        workspaceMode: "shared-read-only",
        nativeTask: { model: "gpt-5.6-terra", thinking: "low" },
        routeEnforcement: {
          mode: "exact",
          onUnavailable: "stop",
          verifyAfterLaunch: true,
        },
        prompt: body.nextAction.members[0].prompt,
      },
    ],
    settleBeforeWaveIndex: 2,
    remainingWaveCount: 0,
  });
  assert.match(body.nextAction.members[0].prompt, /Own only this slice/);
});

test("nelos_plan_slices reports invalid plans as tool errors", async () => {
  const [, response] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "nelos_plan_slices",
        arguments: { plan: { schemaVersion: 99 } },
      },
    },
  ]);
  const { isError, body } = toolBody(response);
  assert.equal(isError, true);
  assert.ok(body.error);
});

test("nelos_intelligence_route mirrors the CLI mapping", async () => {
  const [, routed, invalid] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "nelos_intelligence_route",
        arguments: { taskShape: "everyday" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "nelos_intelligence_route",
        arguments: { taskShape: "unsupported-shape" },
      },
    },
  ]);
  const success = toolBody(routed);
  assert.equal(success.isError, false);
  assert.equal(success.body.command, "intelligence route");
  assert.ok(success.body.route.taskShape);
  assert.equal(success.body.nextAction.kind, "attach-native-task-options");
  assert.deepEqual(
    success.body.nextAction.nativeTask,
    success.body.route.launch.nativeTask,
  );
  const failure = toolBody(invalid);
  assert.equal(failure.isError, true);
  assert.match(failure.body.error, /unsupported intelligence task shape/);
});

async function sessionsFixture(events) {
  const root = await mkdtemp(join(tmpdir(), "nelos-mcp-verify-"));
  const directory = join(root, "sessions", "2026", "07", "21");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "rollout-2026-07-21T18-29-33-thread-1.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return root;
}

function turnContext(turnId, model, effort) {
  return {
    type: "turn_context",
    payload: { turn_id: turnId, model, effort },
  };
}

async function withCodexHome(root, run) {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("nelos_intelligence_verify confirms an exact route", async () => {
  const root = await sessionsFixture([
    turnContext("turn-1", "gpt-5.6-terra", "low"),
  ]);
  await withCodexHome(root, async () => {
    const [, response] = await roundTrip([
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_intelligence_verify",
          arguments: { threadId: "thread-1", model: "gpt-5.6-terra", effort: "low" },
        },
      },
    ]);
    const { isError, body } = toolBody(response);
    assert.equal(isError, false);
    assert.equal(body.command, "intelligence verify");
    assert.equal(body.verified, true);
    assert.equal(body.nextAction.kind, "complete");
  });
});

test("nelos_intelligence_verify fails closed on any mismatch", async () => {
  const root = await sessionsFixture([
    turnContext("turn-1", "gpt-5.6-terra", "high"),
  ]);
  await withCodexHome(root, async () => {
    const [, mismatch, missing] = await roundTrip([
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_intelligence_verify",
          arguments: { threadId: "thread-1", model: "gpt-5.6-terra", effort: "low" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "nelos_intelligence_verify",
          arguments: { threadId: "no-such-thread", model: "gpt-5.6-terra", effort: "low" },
        },
      },
    ]);
    const mismatched = toolBody(mismatch);
    assert.equal(mismatched.isError, true);
    assert.equal(mismatched.body.verified, false);
    assert.equal(mismatched.body.nextAction.kind, "attention");
    const absent = toolBody(missing);
    assert.equal(absent.isError, true);
    assert.match(absent.body.error, /no local rollout/);
  });
});

test("unknown tools, unknown methods, and notifications behave per JSON-RPC", async () => {
  const responses = await roundTrip([
    INITIALIZE,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    },
    { jsonrpc: "2.0", id: 3, method: "resources/list" },
    { jsonrpc: "2.0", id: 4, method: "ping" },
  ]);
  assert.equal(responses.length, 4); // the notification earns no response
  assert.equal(responses[1].error.code, -32602);
  assert.equal(responses[2].error.code, -32601);
  assert.deepEqual(responses[3].result, {});
});

test("rejected and missing tool arguments are tool errors", async () => {
  const [, unexpected, missing] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "nelos_plan_slices",
        arguments: { plan: validPlan(), extra: true },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nelos_intelligence_verify", arguments: { threadId: "t" } },
    },
  ]);
  const extra = toolBody(unexpected);
  assert.equal(extra.isError, true);
  assert.match(extra.body.error, /does not accept argument extra/);
  const absent = toolBody(missing);
  assert.equal(absent.isError, true);
  assert.match(absent.body.error, /requires argument model/);
});

test("bin/nelos-mcp serves the same surface over real stdio", async () => {
  const binPath = fileURLToPath(new URL("../bin/nelos-mcp", import.meta.url));
  const child = spawn(process.execPath, [binPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  const gotTwo = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buffered.slice(0, index)));
        buffered = buffered.slice(index + 1);
      }
      if (lines.length >= 2) resolve();
    });
  });
  child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await gotTwo;
  child.stdin.end();
  await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(lines[0].result.serverInfo.name, "nelos");
  assert.deepEqual(
    lines[1].result.tools.map((tool) => tool.name),
    listNelosMcpTools().map((tool) => tool.name),
  );
});
