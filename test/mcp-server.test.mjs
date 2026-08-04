import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  listNelosMcpTools,
  MCP_MAX_MESSAGE_BYTES,
  startNelosMcpServer,
} from "../src/mcp-server.mjs";
import { ExecutionStoreV1 } from "../src/execution-store.mjs";
import {
  EXECUTION_MAP_RESOURCE_MIME_TYPE,
  EXECUTION_MAP_RESOURCE_URI,
} from "../src/execution-map.mjs";
import { McpOrchestrationAdapterV1 } from "../src/mcp-orchestration.mjs";
import { McpJoinAdapterV1 } from "../src/mcp-observation.mjs";
import { McpQueenDecisionAdapterV1 } from "../src/mcp-queen-decision.mjs";
import { OrchestrationCheckpointStoreV1 } from "../src/orchestration-checkpoint-store.mjs";
import { workUnitFromPlanSliceV1 } from "../src/plan-orchestration-bridge.mjs";
import {
  createPlanRunV1,
  PlanRunStoreV1,
} from "../src/plan-run-store.mjs";
import { PlanningLifecycleProtocolError } from "../src/planning-lifecycle.mjs";
import {
  NelosConfigStoreV1,
  NelosConfigurationV1,
} from "../src/nelos-configuration.mjs";
import { QueenAcceptanceStoreV1 } from "../src/queen-acceptance.mjs";
import {
  SpinoffLifecycleAdapterV1,
  SpinoffLifecycleStoreV1,
} from "../src/spinoff-lifecycle.mjs";
import { derivePlanWaveActionV1 } from "../src/next-action.mjs";
import {
  MCP_PROTOCOL_TOOL_OUTPUT_SCHEMAS_V1,
  protocolCompatibilityEnvelopeV1,
} from "../src/protocol-contract/index.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

function validPlan(sliceId = "explore") {
  return {
    schemaVersion: 1,
    objective: "demo objective",
    slices: [
      {
        id: sliceId,
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

async function roundTrip(messages, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const exited = new Promise((resolve) => {
    const webRecords = new Map();
    const webRegistry = {
      async withLock(callback) {
        return callback();
      },
      async read(threadId) {
        return webRecords.get(threadId) ?? null;
      },
      async list() {
        return [...webRecords.values()];
      },
      async write(record) {
        webRecords.set(record.threadId, structuredClone(record));
      },
    };
    const planRuns = new Map();
    const planRunStore = {
      async read(planRunId) {
        return planRuns.get(planRunId) ?? null;
      },
      async create(record) {
        const existing = planRuns.get(record.planRunId);
        if (
          existing &&
          JSON.stringify(existing) !== JSON.stringify(record)
        ) {
          throw new Error("plan run identity conflicts with persisted intent");
        }
        planRuns.set(record.planRunId, structuredClone(record));
        return structuredClone(record);
      },
      async requireWave({
        planRunId,
        queenThreadId,
        waveIndex,
        waveDigest,
      }) {
        const record = planRuns.get(planRunId);
        if (!record) throw new Error("launch batch references an unknown plan run");
        if (record.queenThreadId !== queenThreadId) {
          throw new Error("plan run belongs to a different queen");
        }
        const wave = record.waves.find(
          (candidate) =>
            candidate.waveIndex === waveIndex &&
            candidate.waveDigest === waveDigest,
        );
        if (!wave) {
          throw new Error(
            "launch batch conflicts with its persisted wave contract",
          );
        }
        return { record, wave };
      },
      async markWaveVerified({
        planRunId,
        queenThreadId,
        waveIndex,
        waveDigest,
      }) {
        const { record } = await this.requireWave({
          planRunId,
          queenThreadId,
          waveIndex,
          waveDigest,
        });
        if (!record.verifiedWaveIndexes.includes(waveIndex)) {
          record.verifiedWaveIndexes.push(waveIndex);
        }
        return structuredClone(record);
      },
    };
    startNelosMcpServer({
      input,
      output,
      serverVersion: "0.0.0-test",
      onExit: resolve,
      currentThreadId: () => "queen-1",
      planRunStore,
      webRegistry,
      ...options,
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

async function rawRoundTrip(chunks, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks = [];
  output.on("data", (chunk) => outputChunks.push(chunk));
  const exited = new Promise((resolve) => {
    startNelosMcpServer({
      input,
      output,
      serverVersion: "0.0.0-test",
      onExit: (code) => resolve(code),
      ...options,
    });
  });
  for (const chunk of chunks) input.write(chunk);
  input.end();
  const exitCode = await exited;
  const responses = Buffer.concat(outputChunks)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return { exitCode, responses };
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
  assert.deepEqual(response.result.capabilities, {
    tools: { listChanged: false },
    resources: { listChanged: false, subscribe: false },
  });
  assert.deepEqual(response.result.serverInfo, {
    name: "nelos",
    version: "0.0.0-test",
  });
});

test("initialize negotiates only supported protocol revisions", async () => {
  for (const [requested, expected] of [
    ["2025-11-25", "2025-11-25"],
    ["2025-06-18", "2025-06-18"],
    ["2099-01-01", "2025-11-25"],
  ]) {
    const [response] = await roundTrip([{
      ...INITIALIZE,
      params: { ...INITIALIZE.params, protocolVersion: requested },
    }]);
    assert.equal(response.result.protocolVersion, expected);
  }
});

test("initialize validates its contract and normal requests require initialization", async () => {
  const invalid = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  };
  const { exitCode, responses } = await rawRoundTrip([
    `${JSON.stringify({ ...invalid, id: undefined })}\n`,
    `${JSON.stringify(invalid)}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(responses.map(({ error }) => error.code), [-32602, -32002]);
});

test("stdio separates fragmented and coalesced UTF-8 frames", async () => {
  const initialize = JSON.stringify({
    ...INITIALIZE,
    params: {
      ...INITIALIZE.params,
      protocolVersion: "2025-11-25",
      clientInfo: { name: "tést", version: "0" },
    },
  });
  const wire = Buffer.from(
    `${initialize}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`,
    "utf8",
  );
  const splitAt = wire.indexOf(Buffer.from("é")) + 1;
  const { exitCode, responses } = await rawRoundTrip([
    wire.subarray(0, splitAt),
    wire.subarray(splitAt),
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(responses.map(({ id }) => id), [1, 2]);
  assert.equal(responses[0].result.protocolVersion, "2025-11-25");
  assert.deepEqual(responses[1].result, {});
});

test("malformed, oversized, and interrupted frames fail deterministically and recover", async () => {
  const initialize = `${JSON.stringify(INITIALIZE)}\n`;
  const ping = `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`;
  const oversizedPrefix = "x".repeat(MCP_MAX_MESSAGE_BYTES + 1);
  const oversizedTail = "y".repeat(MCP_MAX_MESSAGE_BYTES + 1);
  const { exitCode, responses } = await rawRoundTrip([
    initialize,
    "{bad json}\n",
    Buffer.from([0xff, 0x0a]),
    ping,
    oversizedPrefix,
    oversizedTail,
    `\n${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`,
    '{"jsonrpc":"2.0","id":4,"method":"ping"',
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(
    responses.map((response) => response.id ?? response.error.code),
    [1, -32700, -32700, 2, -32600, 3, -32700],
  );
  assert.equal(responses[2].error.message, "invalid UTF-8 in stdio frame");
  assert.match(responses[4].error.message, /exceeds/u);
  assert.equal(responses[6].error.message, "incomplete stdio frame");
});

test("stdio enforces the limit per message rather than per input chunk", async () => {
  const padding = "x".repeat(Math.floor(MCP_MAX_MESSAGE_BYTES * 0.55));
  const notifications = [1, 2].map((sequence) => JSON.stringify({
    jsonrpc: "2.0",
    method: `notifications/test_${sequence}`,
    params: { padding },
  }));
  const { exitCode, responses } = await rawRoundTrip([
    `${JSON.stringify(INITIALIZE)}\n${notifications.join("\n")}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`,
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(responses.map(({ id }) => id), [1, 2]);
});

test("tools/list honestly annotates planning, app-server, and orchestration effects", async () => {
  const [, response] = await roundTrip([
    INITIALIZE,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const tools = response.result.tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "nelos_plan_bootstrap",
      "nelos_plan_lifecycle",
      "nelos_plan_replan",
      "nelos_plan_slices",
      "nelos_launch_authorize",
      "nelos_launch_verify_batch",
      "nelos_execution_map_refresh",
      "nelos_thread_inspect",
      "nelos_thread_inventory",
      "nelos_web_inspect",
      "nelos_thread_wait",
      "nelos_app_server_health",
      "nelos_intelligence_route",
      "nelos_intelligence_verify",
      "nelos_intelligence_resolve_subagent",
      "nelos_orchestrate_create",
      "nelos_orchestrate_advance",
      "nelos_queen_decide",
      "nelos_config_get",
      "nelos_config_set",
      "nelos_config_reset",
      "nelos_spinoff_complete",
      "nelos_spinoff_cleanup",
    ],
  );
  for (const tool of tools.filter(({ name }) =>
    [
      "nelos_execution_map_refresh",
      "nelos_thread_inspect",
      "nelos_thread_inventory",
      "nelos_web_inspect",
      "nelos_thread_wait",
      "nelos_app_server_health",
      "nelos_intelligence_route",
      "nelos_intelligence_verify",
      "nelos_intelligence_resolve_subagent",
    ].includes(name),
  )) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  for (const planningTool of tools.filter(({ name }) =>
    [
      "nelos_plan_bootstrap",
      "nelos_plan_lifecycle",
      "nelos_plan_replan",
      "nelos_plan_slices",
    ].includes(name),
  )) {
    assert.deepEqual(planningTool.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  const orchestration = tools.find(
    ({ name }) => name === "nelos_orchestrate_create",
  );
  assert.deepEqual(orchestration.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const launchVerification = tools.find(
    ({ name }) => name === "nelos_launch_verify_batch",
  );
  assert.deepEqual(launchVerification.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(orchestration.inputSchema.required, ["workUnit", "receipt"]);
  const launchAuthorization = tools.find(
    ({ name }) => name === "nelos_launch_authorize",
  );
  assert.deepEqual(launchAuthorization.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(launchAuthorization.inputSchema.required, [
    "request",
    "capabilities",
    "userIntentConfirmed",
  ]);
  assert.equal(
    orchestration.inputSchema.properties.receipt.anyOf[1].additionalProperties,
    false,
  );
  const advance = tools.find(
    ({ name }) => name === "nelos_orchestrate_advance",
  );
  assert.deepEqual(advance.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(advance.inputSchema.additionalProperties, false);
  assert.equal(advance.inputSchema.properties.receipt.anyOf.length, 6);
  assert.deepEqual(
    advance.inputSchema.properties.receipt.anyOf
      .map((schema) => schema.properties?.type?.const)
      .filter(Boolean),
    [
      "native-title-observed",
      "native-wait",
      "native-result-read",
      "native-follow-up-delivered",
      "orchestration-member-repaired",
    ],
  );
  const queenDecision = tools.find(
    ({ name }) => name === "nelos_queen_decide",
  );
  assert.deepEqual(queenDecision.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(queenDecision.inputSchema.required, [
    "schemaVersion",
    "webId",
    "queenThreadId",
    "decision",
    "decisionSummary",
    "receipt",
  ]);
  assert.equal(queenDecision.inputSchema.properties.schemaVersion.const, 1);
  assert.deepEqual(
    queenDecision.inputSchema.properties.decision.enum,
    ["accepted", "rejected"],
  );
  assert.equal(
    queenDecision.inputSchema.properties.receipt.additionalProperties,
    false,
  );
  assert.equal(
    queenDecision.inputSchema.properties.receipt.properties.resultEnvelope
      .additionalProperties,
    false,
  );
  const complete = tools.find(
    ({ name }) => name === "nelos_spinoff_complete",
  );
  const configSet = tools.find(({ name }) => name === "nelos_config_set");
  const configReset = tools.find(({ name }) => name === "nelos_config_reset");
  const configGet = tools.find(({ name }) => name === "nelos_config_get");
  for (const tool of [configGet, configSet]) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  assert.deepEqual(configReset.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
  for (const tool of [configSet, configReset]) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(
      tool.inputSchema.properties.key.enum,
      ["spinoffs.cleanup_policy"],
    );
    assert.equal(tool.inputSchema.properties.userIntentConfirmed.const, true);
    assert.ok(tool.inputSchema.required.includes("userIntentConfirmed"));
  }
  assert.deepEqual(complete.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(
    complete.inputSchema.properties.receipt.anyOf[1],
    {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1, maxLength: 512 },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  );
  const cleanup = tools.find(
    ({ name }) => name === "nelos_spinoff_cleanup",
  );
  assert.deepEqual(cleanup.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(
    cleanup.inputSchema.properties.userIntentConfirmed.const,
    true,
  );
  assert.equal(cleanup.inputSchema.additionalProperties, false);
  assert.deepEqual(tools, listNelosMcpTools());

  const planner = tools.find(({ name }) => name === "nelos_plan_slices");
  for (const visualTool of tools.filter(({ name }) =>
    [
      "nelos_plan_bootstrap",
      "nelos_plan_lifecycle",
      "nelos_plan_replan",
      "nelos_plan_slices",
      "nelos_orchestrate_create",
      "nelos_spinoff_cleanup",
    ].includes(name),
  )) {
    assert.equal(
      visualTool._meta.ui.resourceUri,
      EXECUTION_MAP_RESOURCE_URI,
    );
    assert.equal(
      visualTool._meta["openai/outputTemplate"],
      EXECUTION_MAP_RESOURCE_URI,
    );
    assert.equal(visualTool.outputSchema.additionalProperties, false);
    assert.equal(
      visualTool.outputSchema.properties.view.const,
      "execution-map",
    );
  }
  for (const name of Object.keys(MCP_PROTOCOL_TOOL_OUTPUT_SCHEMAS_V1)) {
    assert.ok(
      tools.find((tool) => tool.name === name)?.outputSchema,
      `${name} must advertise its structured output schema`,
    );
  }
  const lifecycle = tools.find(
    ({ name }) => name === "nelos_plan_lifecycle",
  );
  assert.ok(
    lifecycle.outputSchema.properties.protocol.properties.result.properties
      .nextAction.oneOf.length > 10,
  );
  const advanceOutput = tools.find(
    ({ name }) => name === "nelos_orchestrate_advance",
  ).outputSchema;
  assert.ok(
    advanceOutput.properties.protocol.properties.result.properties
      .nextAction.oneOf.length > 10,
  );
  const plan = planner.inputSchema.properties.plan;
  assert.equal(plan.properties.schemaVersion.const, 1);
  assert.deepEqual(plan.required, ["schemaVersion", "objective", "slices"]);
  assert.equal(plan.properties.slices.items.additionalProperties, false);
  assert.deepEqual(plan.properties.slices.items.properties.lifecycle.enum, [
    "spinoff",
    "subagent",
  ]);
});

test("MCP configuration tools get, set, and reset the shared TOML state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-mcp-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.toml");
  const configuration = new NelosConfigurationV1({
    store: new NelosConfigStoreV1({ path: configPath }),
    legacyPreferencePath: join(root, "legacy-preference.json"),
  });
  const key = "spinoffs.cleanup_policy";
  const [, initial, set, current, reset, replay] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "nelos_config_get", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "nelos_config_set",
          arguments: {
            key,
            value: "ask",
            userIntentConfirmed: true,
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "nelos_config_get", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "nelos_config_reset",
          arguments: { key, userIntentConfirmed: true },
        },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "nelos_config_reset",
          arguments: { key, userIntentConfirmed: true },
        },
      },
    ],
    { configuration },
  );
  assert.deepEqual(toolBody(initial).body.setting, {
    key,
    value: "auto",
    source: "default",
  });
  assert.deepEqual(toolBody(set).body.setting, {
    key,
    value: "ask",
    source: "toml",
  });
  assert.deepEqual(toolBody(current).body.setting, toolBody(set).body.setting);
  assert.deepEqual(toolBody(reset).body.setting, {
    key,
    value: "auto",
    source: "default",
  });
  assert.deepEqual(toolBody(replay).body, toolBody(reset).body);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /cleanup_policy/u);
});

test("MCP configuration tools reject invalid inputs and malformed TOML", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-mcp-config-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.toml");
  const configuration = new NelosConfigurationV1({
    store: new NelosConfigStoreV1({ path: configPath }),
    legacyPreferencePath: join(root, "legacy-preference.json"),
  });
  const [, invalidValue, missingIntent] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_config_set",
          arguments: {
            key: "spinoffs.cleanup_policy",
            value: "sometimes",
            userIntentConfirmed: true,
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "nelos_config_reset",
          arguments: { key: "spinoffs.cleanup_policy" },
        },
      },
    ],
    { configuration },
  );
  assert.equal(toolBody(invalidValue).isError, true);
  assert.match(toolBody(invalidValue).body.error, /auto, ask, or keep/u);
  assert.equal(toolBody(missingIntent).isError, true);
  assert.match(
    toolBody(missingIntent).body.error,
    /requires argument userIntentConfirmed/u,
  );

  await writeFile(
    configPath,
    "schema_version = 1\n[spinoffs]\nunsupported = true\n",
    { mode: 0o600 },
  );
  const [, malformed] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "nelos_config_get", arguments: {} },
      },
    ],
    { configuration },
  );
  assert.equal(toolBody(malformed).isError, true);
  assert.match(
    toolBody(malformed).body.error,
    /invalid Nelos configuration.*unsupported spinoffs key/u,
  );
});

test("nelos_plan_bootstrap returns an exact Sol planning launch", async () => {
  const [, response] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "nelos_plan_bootstrap",
        arguments: {
          objective: "Design and ship a task-history view",
          maxParallel: 2,
        },
      },
    },
  ]);
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.command, "plan bootstrap");
  assert.deepEqual(body.bootstrap.planner.nativeTask, {
    model: "gpt-5.6-sol",
    thinking: "medium",
  });
  assert.equal(body.nextAction.kind, "launch-planner");
  assert.deepEqual(
    body.nextAction.member,
    body.bootstrap.planner,
  );
  assert.deepEqual(response.result.structuredContent.summary, {
    total: 1,
    spinoffs: 0,
    subagents: 1,
    created: 0,
    running: 0,
    attention: 0,
    complete: 0,
    accepted: 0,
    archived: 0,
  });
  assert.equal(response.result.structuredContent.phase, "planning");
  assert.equal(
    response.result.structuredContent.members[0].model,
    "gpt-5.6-sol",
  );
  assert.equal(
    response.result.structuredContent.members[0].reasoning,
    "medium",
  );
  assert.deepEqual(response.result.structuredContent.protocol, {
    schemaVersion: 1,
    tool: "nelos_plan_bootstrap",
    result: body,
  });
});

test("nelos_plan_bootstrap validates the planner response before launching slices", async () => {
  const request = {
    objective: "Design and ship a task-history view",
    maxParallel: 2,
  };
  const bootstrapId = (await import("../src/planning-bootstrap.mjs"))
    .createPlanningBootstrapV1(request).bootstrapId;
  const responseText = [
    "```nelos-plan",
    JSON.stringify({
      schemaVersion: 1,
      bootstrapId,
      confidence: "high",
      classificationEvidence: ["The bounded exploration is ordinary work."],
      plan: validPlan(`explore-${bootstrapId.slice(5, 17)}`),
    }),
    "```",
  ].join("\n");
  const [, response] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "nelos_plan_bootstrap",
        arguments: {
          ...request,
          queenThreadId: "queen-1",
          bootstrapId,
          response: responseText,
        },
      },
    },
  ]);
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.command, "plan slices");
  assert.equal(body.planning.bootstrapId, bootstrapId);
  assert.equal(body.nextAction.kind, "authorization-required");
});

test("nelos_plan_bootstrap returns a host-owned queen-title effect for a planned spinoff", async () => {
  const request = { objective: "Ship an isolated implementation" };
  const bootstrapId = (await import("../src/planning-bootstrap.mjs"))
    .createPlanningBootstrapV1(request).bootstrapId;
  const plan = validPlan(`explore-${bootstrapId.slice(5, 17)}`);
  plan.slices[0] = {
    ...plan.slices[0],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
  };
  const responseText = [
    "```nelos-plan",
    JSON.stringify({
      schemaVersion: 1,
      bootstrapId,
      confidence: "high",
      classificationEvidence: ["The implementation requires an isolated workspace."],
      plan,
    }),
    "```",
  ].join("\n");
  const calls = [];
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_plan_bootstrap",
          arguments: {
            ...request,
            queenThreadId: "queen-1",
            bootstrapId,
            response: responseText,
          },
        },
      },
    ],
    {
      appServerBridge: {
        async inspect({ threadId }) {
          calls.push(["inspect", threadId]);
          return {
            schemaVersion: 1,
            threadId: "queen-1",
            title: "Release",
            status: "idle",
          };
        },
        async close() {
          calls.push("close");
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.nextAction.kind, "native-set-title");
  assert.equal(body.queenTitleSync.verified, false);
  assert.deepEqual(calls, [
    ["inspect", "queen-1"],
    ["inspect", "queen-1"],
    "close",
  ]);
});

test("nelos_plan_lifecycle forwards exact receipts and gates a planned launch wave", async () => {
  const args = {
    schemaVersion: 1,
    idempotencyKey: "history-view",
    queenThreadId: "queen-1",
    objective: "Ship the history view",
    receipt: null,
  };
  const calls = [];
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "nelos_plan_lifecycle", arguments: args },
      },
    ],
    {
      planningLifecycle: {
        async advance(value, context) {
          calls.push({ value, context });
          return {
            lifecycle: {
              bootstrapId: "plan:1234567890abcdef12345678",
              revision: 4,
              phase: "completed",
              plannerThreadId: "planner-1",
            },
            bootstrap: { bootstrapId: "plan:1234567890abcdef12345678" },
            planning: {
              bootstrapId: "plan:1234567890abcdef12345678",
              confidence: "high",
              classificationEvidence: ["bounded"],
            },
            plan: (await import("../src/slice-planner.mjs")).planWorkSlices(
              validPlan(),
            ),
          };
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.command, "plan slices");
  assert.equal(body.lifecycle.phase, "completed");
  assert.equal(body.nextAction.kind, "authorization-required");
  assert.equal(
    response.result.structuredContent.protocol.result.nextAction.kind,
    "authorization-required",
  );
  assert.deepEqual(
    response.result.structuredContent.protocol.result,
    body,
  );
  assert.deepEqual(
    protocolCompatibilityEnvelopeV1("nelos_plan_lifecycle", body).value,
    body,
  );
  assert.deepEqual(calls[0].value, args);
  assert.equal(typeof calls[0].context.appServerBridge.inspect, "function");
});

test("nelos_plan_lifecycle returns structured recovery for an early planner result", async () => {
  const message =
    "planner result is not authorized yet; replay the verified launch receipt until Nelos returns native-read-subagent-result, then copy that actionId unchanged";
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_plan_lifecycle",
          arguments: {
            schemaVersion: 1,
            idempotencyKey: "history-view",
            queenThreadId: "queen-1",
            objective: "Ship the history view",
            receipt: null,
          },
        },
      },
    ],
    {
      planningLifecycle: {
        async advance() {
          throw new PlanningLifecycleProtocolError(
            "planner.result-not-yet-authorized",
            message,
          );
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, true);
  assert.deepEqual(body, {
    error: message,
    code: "planner.result-not-yet-authorized",
    retryable: true,
    recoveryCommand: "repeat-planner-launch-receipt",
    protocolError: {
      schemaVersion: 1,
      code: "planner.result-not-yet-authorized",
      category: "retryable-attention",
      message,
      recoveryCommand: "repeat-planner-launch-receipt",
    },
  });
});

test("planning lifecycle protocol errors require an owned registry code", () => {
  assert.throws(
    () => new PlanningLifecycleProtocolError("constructor", "Invalid."),
    /unknown planning lifecycle protocol code/,
  );
  assert.throws(
    () => new PlanningLifecycleProtocolError("toString", "Invalid."),
    /unknown planning lifecycle protocol code/,
  );
});

test("nelos_plan_replan forwards typed exceptions and excludes completed work from the launch wave", async () => {
  const args = {
    schemaVersion: 1,
    idempotencyKey: "failure-1",
    queenThreadId: "queen-1",
    basePlanRunId: "run:1234567890abcdef1234567890abcdef12345678",
    basePlanDigest: "b".repeat(64),
    basePlan: validPlan(),
    trigger: {
      type: "execution-failed",
      eventId: "failure-1",
      summary: "The current result failed verification",
      affectedSliceIds: ["explore"],
      completedSliceIds: [],
      evidence: ["A terminal current result reports failure."],
    },
    generation: 1,
    receipt: null,
  };
  let createdPlanRun = null;
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "nelos_plan_replan", arguments: args },
      },
    ],
    {
      exceptionReplanning: {
        async advance(value) {
          assert.deepEqual(value, args);
          return {
            lifecycle: {
              bootstrapId: "plan:1234567890abcdef12345678",
              revision: 4,
              phase: "completed",
              plannerThreadId: "planner-1",
            },
            bootstrap: {},
            planning: { confidence: "high" },
            replanning: {
              generation: 1,
              basePlanRunId: "run:1234567890abcdef1234567890abcdef12345678",
              completedSliceIds: [],
              executionComplete: false,
            },
            plan: (await import("../src/slice-planner.mjs")).planWorkSlices(
              validPlan(),
            ),
          };
        },
      },
      planRunStore: {
        async read() {
          return {
            planRunId: "run:1234567890abcdef1234567890abcdef12345678",
            queenThreadId: "queen-1",
            rootPlanRunId: "run:1234567890abcdef1234567890abcdef12345678",
            replanGeneration: 0,
            cleanupIntended: false,
            webIdentity: null,
          };
        },
        async create(record) {
          createdPlanRun = structuredClone(record);
          return record;
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.command, "plan slices");
  assert.equal(body.replanning.generation, 1);
  assert.equal(body.nextAction.kind, "authorization-required");
  assert.equal(body.nextAction.members[0].launcher, "spawn-subagent");
  assert.equal(
    body.nextAction.members.some(({ launcher }) => launcher === "followup-task"),
    false,
  );
  assert.equal(createdPlanRun.cleanupIntended, false);
});

test("nelos_launch_verify_batch is an all-or-nothing wave gate", async () => {
  const args = {
    planRunId: "run:1234567890abcdef1234567890abcdef12345678",
    waveIndex: 1,
    waveDigest: "a".repeat(64),
    parentThreadId: "queen-1",
    members: [
      {
        sliceId: "explore",
        lifecycle: "spinoff",
        threadId: "member-1",
        turnId: "turn-1",
      },
    ],
  };
  const wave = {
    waveIndex: 1,
    waveDigest: "a".repeat(64),
    members: [
      {
        sliceId: "explore",
        lifecycle: "spinoff",
        title: "Explore",
        model: "gpt-5.6-terra",
        effort: "low",
      },
    ],
  };
  for (const allVerified of [true, false]) {
    const [, response] = await roundTrip(
      [
        INITIALIZE,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "nelos_launch_verify_batch", arguments: args },
        },
      ],
      {
        async launchBatchVerifier(value) {
          assert.deepEqual(value, args);
          return {
            schemaVersion: 1,
            parentThreadId: "queen-1",
            allVerified,
            members: [
              {
                sliceId: "explore",
                lifecycle: "spinoff",
                threadId: "member-1",
                checks: {
                  identity: "verified",
                  read: "verified",
                  topology: "verified",
                  title: "verified",
                  route: allVerified ? "verified" : "failed",
                },
                ...(allVerified
                  ? {}
                  : { attentionReason: "exact-route-mismatch" }),
                verified: allVerified,
              },
            ],
          };
        },
        planRunStore: {
          async read() {
            return null;
          },
          async requireWave(value) {
            assert.deepEqual(value, {
              planRunId: args.planRunId,
              queenThreadId: args.parentThreadId,
              waveIndex: args.waveIndex,
              waveDigest: args.waveDigest,
            });
            return { record: {}, wave };
          },
          async markWaveVerified(value) {
            assert.deepEqual(value, {
              planRunId: args.planRunId,
              queenThreadId: args.parentThreadId,
              waveIndex: args.waveIndex,
              waveDigest: args.waveDigest,
            });
          },
        },
        currentThreadId: () => "queen-1",
      },
    );
    const { isError, body } = toolBody(response);
    assert.equal(isError, false);
    assert.equal(
      body.nextAction.kind,
      allVerified ? "native-wait-wave" : "attention",
    );
    if (allVerified) {
      assert.deepEqual(body.nextAction.targets, [{
        sliceId: "explore",
        lifecycle: "spinoff",
        memberKind: "spinoff",
        controlSurface: "codex-task",
        primaryId: "threadId",
        threadId: "member-1",
        turnId: "turn-1",
      }]);
    }
    assert.deepEqual(
      protocolCompatibilityEnvelopeV1(
        "nelos_launch_verify_batch",
        body,
      ).value,
      body,
    );
  }
});

test("launch verification durably adopts and replays a joined member", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-joined-adoption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planRunStore = new PlanRunStoreV1({
    directory: join(root, "plan-runs"),
  });
  const executionStore = new ExecutionStoreV1({
    directory: join(root, "executions"),
  });
  const run = await planRunStore.create(createPlanRunV1(
    planWorkSlices(validPlan("review")),
    {
      queenThreadId: "queen-1",
      sourceId: "joined-adoption-test",
      webIdentity: {
        schemaVersion: 1,
        webId: "A1",
        queenThreadId: "queen-1",
        queenTitle: "👑 A1 · Queen",
      },
    },
  ));
  const args = {
    planRunId: run.planRunId,
    waveIndex: 1,
    waveDigest: run.waves[0].waveDigest,
    parentThreadId: "queen-1",
    members: [{
      sliceId: "review",
      lifecycle: "subagent",
      agentPath: "/root/review",
      turnId: "turn-review",
    }],
  };
  const messages = [INITIALIZE, ...[2, 3].map((id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "nelos_launch_verify_batch", arguments: args },
  }))];
  const responses = await roundTrip(messages, {
    planRunStore,
    orchestrationAdapter: new McpOrchestrationAdapterV1({
      store: executionStore,
    }),
    async launchBatchVerifier() {
      return {
        schemaVersion: 1,
        parentThreadId: "queen-1",
        allVerified: true,
        members: [{
          sliceId: "review",
          lifecycle: "subagent",
          threadId: "thread-review",
          checks: {
            identity: "verified",
            read: "verified",
            topology: "verified",
            title: "not-applicable",
            route: "verified",
          },
          verified: true,
        }],
      };
    },
  });

  assert.equal(toolBody(responses[1]).isError, false);
  assert.equal(toolBody(responses[2]).isError, false);
  const adopted = await executionStore.read("review");
  assert.equal(adopted.memberKind, "joined-subagent");
  assert.equal(adopted.binding.state, "bound");
  assert.equal(adopted.binding.memberThreadId, "thread-review");
  assert.deepEqual(
    (await planRunStore.read(run.planRunId)).verifiedWaveIndexes,
    [1],
  );
});

test("launch verification rejects a conflicting joined-member binding atomically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-joined-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planRunStore = new PlanRunStoreV1({
    directory: join(root, "plan-runs"),
  });
  const executionStore = new ExecutionStoreV1({
    directory: join(root, "executions"),
  });
  const run = await planRunStore.create(createPlanRunV1(
    planWorkSlices(validPlan("review")),
    {
      queenThreadId: "queen-1",
      sourceId: "joined-conflict-test",
      webIdentity: {
        schemaVersion: 1,
        webId: "A1",
        queenThreadId: "queen-1",
        queenTitle: "👑 A1 · Queen",
      },
    },
  ));
  const review = workUnitFromPlanSliceV1(
    run.plan.waves[0].slices[0],
    {
      webId: "A1",
      queenThreadId: "queen-1",
      cleanupIntended: true,
    },
  );
  const orchestrationAdapter = new McpOrchestrationAdapterV1({
    store: executionStore,
  });
  const { binding: _binding, replacementHistory: _history, ...definition } = review;
  const prepared = await orchestrationAdapter.orchestrate({
    workUnit: definition,
    receipt: null,
  });
  const launch = prepared.effects.find(({ type }) => type === "native-create");
  assert.ok(launch);
  await orchestrationAdapter.orchestrate({
    workUnit: definition,
    receipt: {
      schemaVersion: 1,
      actionId: launch.actionId,
      type: "native-create",
      workUnitId: review.workUnitId,
      specRevision: review.specRevision,
      attempt: 1,
      memberThreadId: "thread-review-existing",
    },
  });
  const args = {
    planRunId: run.planRunId,
    waveIndex: 1,
    waveDigest: run.waves[0].waveDigest,
    parentThreadId: "queen-1",
    members: [{
      sliceId: "review",
      lifecycle: "subagent",
      agentPath: "/root/review",
      turnId: "turn-review",
    }],
  };
  const [, response] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "nelos_launch_verify_batch", arguments: args },
    },
  ], {
    planRunStore,
    orchestrationAdapter,
    async launchBatchVerifier() {
      return {
        schemaVersion: 1,
        parentThreadId: "queen-1",
        allVerified: true,
        members: [{
          sliceId: "review",
          lifecycle: "subagent",
          threadId: "thread-review-conflict",
          checks: {
            identity: "verified",
            read: "verified",
            topology: "verified",
            title: "not-applicable",
            route: "verified",
          },
          verified: true,
        }],
      };
    },
  });

  const { isError, body } = toolBody(response);
  assert.equal(isError, true);
  assert.match(body.error, /conflicts with its durable binding/u);
  assert.deepEqual(
    (await planRunStore.read(run.planRunId)).verifiedWaveIndexes,
    [],
  );
  assert.equal(
    (await executionStore.read("review")).binding.memberThreadId,
    "thread-review-existing",
  );
});

test("launch verification leaves a wave unverified when joined adoption cannot prepare", async (t) => {
  for (const scenario of [
    {
      name: "verified member is absent from the plan",
      verifiedSliceId: "missing-review",
      error: /absent from the persisted plan/u,
      orchestrationAdapter: undefined,
    },
    {
      name: "durable launch action is absent",
      verifiedSliceId: "review",
      error: /has no durable launch action/u,
      orchestrationAdapter: {
        async orchestrate() {
          return { binding: { state: "unbound" }, effects: [] };
        },
      },
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "nelos-joined-prepare-failure-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const planRunStore = new PlanRunStoreV1({
        directory: join(root, "plan-runs"),
      });
      const run = await planRunStore.create(createPlanRunV1(
        planWorkSlices(validPlan("review")),
        {
          queenThreadId: "queen-1",
          sourceId: "joined-prepare-failure-test",
          webIdentity: {
            schemaVersion: 1,
            webId: "A1",
            queenThreadId: "queen-1",
            queenTitle: "👑 A1 · Queen",
          },
        },
      ));
      const args = {
        planRunId: run.planRunId,
        waveIndex: 1,
        waveDigest: run.waves[0].waveDigest,
        parentThreadId: "queen-1",
        members: [{
          sliceId: "review",
          lifecycle: "subagent",
          agentPath: "/root/review",
          turnId: "turn-review",
        }],
      };
      const [, response] = await roundTrip([
        INITIALIZE,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "nelos_launch_verify_batch", arguments: args },
        },
      ], {
        planRunStore,
        ...(scenario.orchestrationAdapter
          ? { orchestrationAdapter: scenario.orchestrationAdapter }
          : {}),
        async launchBatchVerifier() {
          return {
            schemaVersion: 1,
            parentThreadId: "queen-1",
            allVerified: true,
            members: [{
              sliceId: scenario.verifiedSliceId,
              lifecycle: "subagent",
              threadId: "thread-review",
              checks: {
                identity: "verified",
                read: "verified",
                topology: "verified",
                title: "not-applicable",
                route: "verified",
              },
              verified: true,
            }],
          };
        },
      });

      const { isError, body } = toolBody(response);
      assert.equal(isError, true);
      assert.match(body.error, scenario.error);
      assert.deepEqual(
        (await planRunStore.read(run.planRunId)).verifiedWaveIndexes,
        [],
      );
    });
  }
});

test("launch verification keeps subagent-only plans lightweight", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-lightweight-subagent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planRunStore = new PlanRunStoreV1({
    directory: join(root, "plan-runs"),
  });
  const executionStore = new ExecutionStoreV1({
    directory: join(root, "executions"),
  });
  const run = await planRunStore.create(createPlanRunV1(
    planWorkSlices(validPlan("review-only")),
    { queenThreadId: "queen-1", sourceId: "lightweight-subagent-test" },
  ));
  const args = {
    planRunId: run.planRunId,
    waveIndex: 1,
    waveDigest: run.waves[0].waveDigest,
    parentThreadId: "queen-1",
    members: [{
      sliceId: "review-only",
      lifecycle: "subagent",
      agentPath: "/root/review_only",
      turnId: "turn-review",
    }],
  };
  const [, response] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "nelos_launch_verify_batch", arguments: args },
    },
  ], {
    planRunStore,
    orchestrationAdapter: new McpOrchestrationAdapterV1({
      store: executionStore,
    }),
    async launchBatchVerifier() {
      return {
        schemaVersion: 1,
        parentThreadId: "queen-1",
        allVerified: true,
        members: [{
          sliceId: "review-only",
          lifecycle: "subagent",
          threadId: "thread-review",
          checks: {
            identity: "verified",
            read: "verified",
            topology: "verified",
            title: "not-applicable",
            route: "verified",
          },
          verified: true,
        }],
      };
    },
  });

  assert.equal(toolBody(response).isError, false);
  assert.equal(await executionStore.read("review-only"), null);
  assert.deepEqual(
    (await planRunStore.read(run.planRunId)).verifiedWaveIndexes,
    [1],
  );
});

test("nelos_launch_verify_batch returns one replay-stable post-bind title synchronization", async () => {
  const args = {
    planRunId: "run:1234567890abcdef1234567890abcdef12345678",
    waveIndex: 1,
    waveDigest: "a".repeat(64),
    parentThreadId: "queen-1",
    members: [
      {
        sliceId: "explore",
        lifecycle: "spinoff",
        threadId: "member-1",
        turnId: "turn-1",
      },
    ],
  };
  const wave = {
    waveIndex: 1,
    waveDigest: "a".repeat(64),
    members: [
      {
        sliceId: "explore",
        lifecycle: "spinoff",
        title: "🕷️ A1 · Explore",
        model: "gpt-5.6-terra",
        effort: "low",
      },
    ],
  };
  const [, first, replay] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "nelos_launch_verify_batch", arguments: args },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "nelos_launch_verify_batch", arguments: args },
      },
    ],
    {
      async launchBatchVerifier() {
        return {
          schemaVersion: 1,
          parentThreadId: "queen-1",
          allVerified: false,
          members: [
            {
              sliceId: "explore",
              lifecycle: "spinoff",
              threadId: "member-1",
              checks: {
                identity: "verified",
                read: "verified",
                topology: "verified",
                title: "failed",
                route: "verified",
              },
              attentionReason: "title-mismatch",
              verified: false,
            },
          ],
        };
      },
      planRunStore: {
        async read() {
          return null;
        },
        async requireWave() {
          return { record: {}, wave };
        },
      },
    },
  );
  const firstAction = toolBody(first).body.nextAction;
  assert.deepEqual(firstAction, {
    schemaVersion: 1,
    kind: "native-set-title",
    actionId:
      "plan-title:1234567890abcdef1234567890abcdef12345678:" +
      "wave-1:explore",
    threadId: "member-1",
    title: "🕷️ A1 · Explore",
    verify: true,
    after: "repeat-launch-verify-batch",
  });
  assert.deepEqual(toolBody(replay).body.nextAction, firstAction);
});

test("nelos_launch_verify_batch relies on persisted queen ownership", async () => {
  const args = {
    planRunId: "run:1234567890abcdef1234567890abcdef12345678",
    waveIndex: 1,
    waveDigest: "a".repeat(64),
    parentThreadId: "other-queen",
    members: [
      {
        sliceId: "explore",
        lifecycle: "spinoff",
        threadId: "member-1",
        turnId: "turn-1",
      },
    ],
  };
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "nelos_launch_verify_batch", arguments: args },
      },
    ],
    {
      currentThreadId: () => "queen-1",
      planRunStore: {
        async read() {
          return null;
        },
        async requireWave() {
          throw new Error("must not read a foreign wave");
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, true);
  assert.match(body.error, /must not read a foreign wave/u);
});

test("nelos_launch_verify_batch rejects another queen's persisted run", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-mcp-plan-run-owner-"));
  try {
    const planRunStore = new PlanRunStoreV1({
      directory: join(root, "plan-runs"),
    });
    const run = await planRunStore.create(
      createPlanRunV1(planWorkSlices(validPlan()), {
        queenThreadId: "queen-1",
        sourceId: "cross-queen-wave",
      }),
    );
    const wave = run.waves[0];
    const [, response] = await roundTrip(
      [
        INITIALIZE,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "nelos_launch_verify_batch",
            arguments: {
              planRunId: run.planRunId,
              waveIndex: wave.waveIndex,
              waveDigest: wave.waveDigest,
              parentThreadId: "queen-2",
              members: [
                {
                  sliceId: "explore",
                  lifecycle: "subagent",
                  threadId: "member-1",
                  turnId: "turn-1",
                },
              ],
            },
          },
        },
      ],
      {
        currentThreadId: () => "queen-2",
        planRunStore,
        launchBatchVerifier() {
          throw new Error("foreign run must fail before host verification");
        },
      },
    );
    const { isError, body } = toolBody(response);
    assert.equal(isError, true);
    assert.match(body.error, /different queen/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nelos_orchestrate_advance is callback-only and forwards exact arguments", async () => {
  const calls = [];
  const args = { webId: "A1", queenThreadId: "queen", receipt: null };
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "nelos_orchestrate_advance", arguments: args },
      },
    ],
    {
      joinAdapter: {
        async advance(value) {
          calls.push(value);
          return {
            schemaVersion: 1,
            webId: "A1",
            queenThreadId: "queen",
            checkpoint: { checkpointRevision: 7 },
            join: {
              effects: [{ type: "native-wait", actionId: "wait-7" }],
              boundary: { type: "waiting" },
            },
          };
        },
      },
    },
  );
  assert.deepEqual(calls, [args]);
  const result = toolBody(response);
  assert.equal(result.isError, false);
  assert.equal(result.body.join.effects[0].type, "native-wait");
  assert.deepEqual(
    protocolCompatibilityEnvelopeV1(
      "nelos_orchestrate_advance",
      result.body,
    ).value,
    result.body,
  );
});

test("public MCP cleanup authorization replay launches and verifies wave 2", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-multi-wave-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planRunStore = new PlanRunStoreV1({
    directory: join(root, "plan-runs"),
  });
  const executionStore = new ExecutionStoreV1({
    directory: join(root, "executions"),
  });
  const checkpointStore = new OrchestrationCheckpointStoreV1({
    directory: join(root, "checkpoints"),
  });
  const acceptanceStore = new QueenAcceptanceStoreV1({
    directory: join(root, "acceptances"),
  });
  const configuration = new NelosConfigurationV1({
    store: new NelosConfigStoreV1({ path: join(root, "config.toml") }),
    legacyPreferencePath: join(root, "legacy-cleanup.json"),
  });
  const orchestrationAdapter = new McpOrchestrationAdapterV1({
    store: executionStore,
  });
  const joinAdapter = new McpJoinAdapterV1({
    executionStore,
    checkpointStore,
    acceptanceStore,
    planRunStore,
  });
  const queenDecisionAdapter = new McpQueenDecisionAdapterV1({
    executionStore,
    checkpointStore,
    acceptanceStore,
    now: () => "2026-08-03T12:00:00.000Z",
  });
  const lifecycleAdapter = new SpinoffLifecycleAdapterV1({
    executionStore,
    acceptanceStore,
    planRunStore,
    configuration,
    store: new SpinoffLifecycleStoreV1({
      directory: join(root, "spinoff-lifecycle"),
    }),
    now: () => "2026-08-03T12:00:00.000Z",
  });
  const latestTurns = new Map();
  const appServerBridge = {
    async latestTurn({ threadId }) {
      return latestTurns.get(threadId) ?? null;
    },
    async close() {},
  };
  const options = {
    planRunStore,
    orchestrationAdapter,
    joinAdapter,
    queenDecisionAdapter,
    lifecycleAdapter,
    configuration,
    appServerBridge,
    async launchBatchVerifier(args) {
      return {
        schemaVersion: 1,
        parentThreadId: args.parentThreadId,
        allVerified: true,
        members: args.members.map((member) => ({
          sliceId: member.sliceId,
          lifecycle: member.lifecycle,
          threadId: member.threadId,
          checks: {
            identity: "verified",
            read: "verified",
            topology: "verified",
            title: "verified",
            route: "verified",
          },
          verified: true,
        })),
      };
    },
  };
  let requestId = 10;
  const call = async (name, args) => {
    const responses = await roundTrip([
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: requestId++,
        method: "tools/call",
        params: { name, arguments: args },
      },
    ], options);
    const result = toolBody(responses[1]);
    assert.equal(result.isError, false, result.body.error);
    return result.body;
  };
  const plan = planWorkSlices({
    schemaVersion: 1,
    objective: "Exercise two dependency-ordered durable waves",
    slices: [
      {
        id: "alpha",
        title: "Alpha",
        objective: "Complete the prerequisite",
        deliverable: "Alpha result",
        acceptanceCriteria: ["Alpha is accepted"],
        dependsOn: [],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
      {
        id: "beta",
        title: "Beta",
        objective: "Complete the dependent work",
        deliverable: "Beta result",
        acceptanceCriteria: ["Beta is verified"],
        dependsOn: ["alpha"],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
    ],
  });
  const run = await planRunStore.create(createPlanRunV1(plan, {
    queenThreadId: "queen-1",
    sourceId: "multi-wave-public-mcp",
    webIdentity: {
      schemaVersion: 1,
      webId: "A1",
      queenThreadId: "queen-1",
      queenTitle: "👑 A1 · Queen",
    },
  }));
  const capabilitiesFor = (proposal) => ({
    source: "native-host-tool-registry",
    launchers: proposal.members.map((member) => ({
      launcher: member.launcher,
      memberKinds: [member.memberKind],
      workspaceModes: [member.workspaceMode],
      routes: [{
        model: member.nativeTask.model,
        reasoningEfforts: [member.nativeTask.thinking],
      }],
    })),
  });
  const authorize = async (proposal) => (await call(
    "nelos_launch_authorize",
    {
      request: proposal.authorizationEffect.arguments.request,
      capabilities: capabilitiesFor(proposal),
      userIntentConfirmed: true,
    },
  )).receipt;
  const bindLaunchMember = async (member, threadId) => {
    const prepared = await call(
      member.orchestration.tool,
      member.orchestration.arguments,
    );
    const effect = prepared.effects.find(({ type }) => type === "native-create");
    assert.ok(effect);
    await call(member.orchestration.tool, {
      workUnit: member.orchestration.arguments.workUnit,
      receipt: {
        schemaVersion: 1,
        actionId: effect.actionId,
        type: "native-create",
        workUnitId: effect.workUnitId,
        specRevision: effect.specRevision,
        attempt: effect.attempt,
        memberThreadId: threadId,
      },
    });
  };
  const verifyWave = (action, threadId, turnId) => call(
    "nelos_launch_verify_batch",
    {
      ...action.verification,
      parentThreadId: "queen-1",
      members: action.members.map((member) => ({
        sliceId: member.sliceId,
        lifecycle: member.lifecycle,
        threadId,
        turnId,
      })),
    },
  );

  const firstProposal = derivePlanWaveActionV1(plan, run, 1, true, null);
  const firstAction = derivePlanWaveActionV1(
    plan,
    run,
    1,
    true,
    await authorize(firstProposal),
  );
  await bindLaunchMember(firstAction.members[0], "thread-alpha");
  await verifyWave(firstAction, "thread-alpha", "turn-alpha");

  let observed = await call("nelos_orchestrate_advance", {
    webId: "A1",
    queenThreadId: "queen-1",
    receipt: null,
  });
  const titleEffect = observed.join.effects.find(
    ({ type }) => type === "native-read-title",
  );
  observed = await call("nelos_orchestrate_advance", {
    webId: "A1",
    queenThreadId: "queen-1",
    receipt: {
      schemaVersion: 1,
      type: "native-title-observed",
      actionId: titleEffect.actionId,
      workUnitId: titleEffect.workUnitId,
      specRevision: titleEffect.specRevision,
      attempt: titleEffect.attempt,
      bindingGeneration: titleEffect.bindingGeneration,
      memberThreadId: titleEffect.memberThreadId,
      requestedTitle: titleEffect.requestedTitle,
      observedTitle: titleEffect.requestedTitle,
    },
  });
  const waitEffect = observed.join.effects.find(
    ({ type }) => type === "native-wait",
  );
  observed = await call("nelos_orchestrate_advance", {
    webId: "A1",
    queenThreadId: "queen-1",
    receipt: {
      schemaVersion: 1,
      type: "native-wait",
      actionId: waitEffect.actionId,
      webId: "A1",
      queenThreadId: "queen-1",
      status: "event",
      targets: waitEffect.targets.map((target) => ({
        ...target,
        nextCursor: "cursor-alpha",
        lifecycle: "completed",
        latestTurnId: "turn-alpha",
        attentionRequired: false,
      })),
    },
  });
  const readEffect = observed.join.effects.find(
    ({ type }) => type === "native-read-result",
  );
  const resultReceipt = {
    schemaVersion: 1,
    type: "native-result-read",
    actionId: readEffect.actionId,
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    bindingGeneration: 1,
    memberThreadId: "thread-alpha",
    requestedTurnId: "turn-alpha",
    sourceTurnId: "turn-alpha",
    resultEnvelope: {
      schemaVersion: 1,
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
      outcome: "succeeded",
      summary: "Alpha completed",
      artifacts: [],
      verification: ["focused fixture"],
      blockers: [],
      recoveryHint: null,
    },
  };
  await call("nelos_orchestrate_advance", {
    webId: "A1",
    queenThreadId: "queen-1",
    receipt: resultReceipt,
  });
  latestTurns.set("thread-alpha", {
    turnId: "turn-alpha",
    status: "completed",
  });
  await call("nelos_queen_decide", {
    schemaVersion: 1,
    webId: "A1",
    queenThreadId: "queen-1",
    decision: "accepted",
    decisionSummary: "Alpha meets the recorded criteria.",
    receipt: resultReceipt,
  });
  const advanced = await call("nelos_orchestrate_advance", {
    webId: "A1",
    queenThreadId: "queen-1",
    receipt: null,
  });
  assert.equal(advanced.nextAction.kind, "cleanup-spinoffs");

  const cleanupArguments = advanced.nextAction.arguments;
  const cleaning = await call("nelos_spinoff_cleanup", cleanupArguments);
  const archive = cleaning.effects.find(({ type }) => type === "native-archive");
  const settled = await call("nelos_spinoff_cleanup", {
    ...cleanupArguments,
    archiveReceipts: [{
      schemaVersion: 1,
      actionId: archive.actionId,
      type: "native-archive",
      threadId: archive.threadId,
      archived: true,
    }],
  });
  assert.equal(settled.nextAction.kind, "authorization-required");
  assert.deepEqual(
    (await planRunStore.read(run.planRunId)).cleanedWaveIndexes,
    [1],
  );
  const resumed = await call("nelos_orchestrate_advance", {
    webId: "A1",
    queenThreadId: "queen-1",
    receipt: null,
  });
  assert.equal(resumed.nextAction.kind, "authorization-required");
  assert.equal(resumed.nextAction.verification.waveIndex, 2);

  const secondAuthorization = await authorize(settled.nextAction);
  const secondAction = (await call("nelos_spinoff_cleanup", {
    ...cleanupArguments,
    launchAuthorization: secondAuthorization,
  })).nextAction;
  assert.equal(secondAction.kind, "launch-wave");
  assert.equal(secondAction.waveIndex, 2);
  assert.deepEqual(
    (await call("nelos_spinoff_cleanup", {
      ...cleanupArguments,
      launchAuthorization: secondAuthorization,
    })).nextAction,
    secondAction,
  );
  await bindLaunchMember(secondAction.members[0], "thread-beta");
  await verifyWave(secondAction, "thread-beta", "turn-beta");
  const completedRun = await planRunStore.read(run.planRunId);
  assert.deepEqual(completedRun.verifiedWaveIndexes, [1, 2]);
  assert.deepEqual(completedRun.cleanedWaveIndexes, [1]);
});

test("nelos_queen_decide forwards the strict versioned decision lifecycle", async () => {
  const calls = [];
  const args = {
    schemaVersion: 1,
    webId: "A1",
    queenThreadId: "queen",
    decision: "accepted",
    decisionSummary: "Queen verified the result.",
    receipt: {
      schemaVersion: 1,
      type: "native-result-read",
      actionId: "result-action",
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
      bindingGeneration: 1,
      memberThreadId: "thread-alpha",
      requestedTurnId: "turn-alpha",
      sourceTurnId: "turn-alpha",
      resultEnvelope: {},
    },
  };
  const appServerBridge = { marker: "bridge", close() {} };
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "nelos_queen_decide", arguments: args },
      },
    ],
    {
      appServerBridge,
      queenDecisionAdapter: {
        async decide(value, context) {
          calls.push({ value, context });
          return {
            schemaVersion: 1,
            replayed: false,
            decision: { decisionId: "queen-acceptance-v1/example" },
            readiness: { readyWorkUnitIds: [], settledWorkUnitIds: ["alpha"] },
            nextAction: {
              schemaVersion: 1,
              kind: "advance-orchestration",
              tool: "nelos_orchestrate_advance",
              arguments: {
                webId: "A1",
                queenThreadId: "queen",
                receipt: null,
              },
            },
          };
        },
      },
    },
  );
  assert.deepEqual(calls, [{
    value: args,
    context: { appServerBridge },
  }]);
  const result = toolBody(response);
  assert.equal(result.isError, false);
  assert.equal(
    result.body.decision.decisionId,
    "queen-acceptance-v1/example",
  );
  assert.deepEqual(
    protocolCompatibilityEnvelopeV1("nelos_queen_decide", result.body).value,
    result.body,
  );
});

test("spin-off lifecycle tools forward exact bounded arguments", async () => {
  const calls = [];
  const completion = {
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "member",
    outcome: "succeeded",
    summary: "Verified result.",
    receipt: null,
  };
  const cleanup = {
    webId: "A1",
    queenThreadId: "queen",
    policy: "ask",
    confirmedThreadIds: ["member"],
  };
  const [, completeResponse, cleanupResponse] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "nelos_spinoff_complete", arguments: completion },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "nelos_spinoff_cleanup", arguments: cleanup },
      },
    ],
    {
      lifecycleAdapter: {
        async complete(value) {
          calls.push(["complete", value]);
          return {
            schemaVersion: 1,
            replayed: false,
            record: { wakeId: "wake-1", wakeState: "delivering" },
            effects: [{
              schemaVersion: 1,
              actionId: "wake-1",
              type: "native-send-message",
              threadId: "queen",
              prompt: "Member completed.",
              preconditions: {
                expectedCallerThreadId: "member",
                expectedBoundMemberThreadId: "member",
              },
            }],
          };
        },
        async cleanup(value) {
          calls.push(["cleanup", value]);
          return {
            schemaVersion: 1,
            policy: "ask",
            state: "complete",
            results: [{
              workUnitId: "member-a",
              threadId: "member",
              title: "Member A",
              model: "gpt-5.6-sol",
              reasoning: "medium",
              state: "archived",
              replayed: false,
            }],
            effects: [],
          };
        },
      },
      appServerBridge: { async close() {} },
    },
  );
  assert.deepEqual(calls.map(([method, value]) => [method, value]), [
    ["complete", completion],
    ["cleanup", cleanup],
  ]);
  const completed = toolBody(completeResponse).body;
  const cleaned = toolBody(cleanupResponse).body;
  assert.equal(completed.record.wakeState, "delivering");
  assert.equal(cleaned.state, "complete");
  assert.equal(completeResponse.result.structuredContent.phase, "complete");
  assert.equal(
    completeResponse.result.structuredContent.members[0].status,
    "complete",
  );
  assert.deepEqual(
    completeResponse.result.structuredContent.protocol.result,
    completed,
  );
  assert.equal(cleanupResponse.result.structuredContent.phase, "archived");
  assert.equal(
    cleanupResponse.result.structuredContent.summary.archived,
    1,
  );
  assert.equal(
    cleanupResponse.result.structuredContent.members[0].status,
    "archived",
  );
  assert.deepEqual(
    cleanupResponse.result.structuredContent.protocol.result,
    cleaned,
  );
  assert.deepEqual(
    protocolCompatibilityEnvelopeV1(
      "nelos_spinoff_complete",
      completed,
    ).value,
    completed,
  );
  assert.deepEqual(
    protocolCompatibilityEnvelopeV1(
      "nelos_spinoff_cleanup",
      cleaned,
    ).value,
    cleaned,
  );
});

function workUnitInput(overrides = {}) {
  return {
    schemaVersion: 1,
    webId: "A1",
    queenThreadId: "queen-thread",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result", "follow-up"],
    title: "Member A",
    objectiveSummary: "Implement one bounded member task.",
    deliverable: "A verified change.",
    acceptanceCriteria: ["Focused tests pass."],
    dependencies: [],
    required: true,
    policy: {
      maxAttempts: 3,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    },
    ...overrides,
  };
}

function orchestrationCall(id, workUnit, receipt = null) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "nelos_orchestrate_create",
      arguments: { workUnit, receipt },
    },
  };
}

async function orchestrationFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "nelos-mcp-orchestration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExecutionStoreV1({ directory });
  return {
    store,
    options: {
      orchestrationAdapter: new McpOrchestrationAdapterV1({ store }),
    },
  };
}

test("stdio orchestration creates once, then requires reconciliation before any retry", async (t) => {
  const fixture = await orchestrationFixture(t);
  const [, first, retry] = await roundTrip(
    [
      INITIALIZE,
      orchestrationCall(2, workUnitInput()),
      orchestrationCall(3, workUnitInput()),
    ],
    fixture.options,
  );
  const initial = toolBody(first);
  const replay = toolBody(retry);

  assert.equal(initial.isError, false);
  assert.equal(initial.body.binding.state, "launch-pending");
  assert.equal(initial.body.effects.length, 1);
  assert.equal(first.result.structuredContent.phase, "launch-pending");
  assert.equal(first.result.structuredContent.summary.created, 0);
  assert.equal(first.result.structuredContent.members[0].task, "Member A");
  assert.deepEqual(
    protocolCompatibilityEnvelopeV1(
      "nelos_orchestrate_create",
      initial.body,
    ).value,
    initial.body,
  );
  const { prompt: launchPrompt, ...launchEffect } = initial.body.effects[0];
  assert.match(launchPrompt, /^Task title: Member A\n\n/u);
  assert.match(
    launchPrompt,
    /You are this durable spin-off\. Do not create or delegate another task\./u,
  );
  assert.match(launchPrompt, /call `nelos_spinoff_complete`/u);
  assert.match(launchPrompt, /Set receipt to null/u);
  assert.match(launchPrompt, /codex_app\.send_message_to_thread/u);
  assert.match(launchPrompt, /receipt: \{"threadId":"queen-thread"\}/u);
  assert.match(launchPrompt, /Do not add actionId, specRevision/u);
  assert.match(
    launchPrompt,
    /"queenThreadId":"queen-thread".*"workUnitId":"member-a"/u,
  );
  assert.deepEqual(launchEffect, {
    schemaVersion: 1,
    actionId:
      "web-orchestration-v1/member-a/revision-1/attempt-1/launch",
    type: "native-create",
    scope: "work-unit",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    launcher: "create-thread",
    launch: null,
    title: "Member A",
    preconditions: {
      expectedSpecRevision: 1,
      expectedBindingState: "unbound",
      expectedMemberThreadId: null,
      expectedSourceTurnId: null,
    },
  });
  const [{ prompt: reconcilePrompt, ...reconcileEffect }] = replay.body.effects;
  assert.equal(reconcilePrompt, launchPrompt);
  assert.deepEqual(reconcileEffect, {
      schemaVersion: 1,
      actionId:
        "web-orchestration-v1/member-a/revision-1/attempt-1/launch/reconcile",
      type: "native-reconcile-create",
      scope: "work-unit",
      createActionId:
        "web-orchestration-v1/member-a/revision-1/attempt-1/launch",
      workUnitId: "member-a",
      specRevision: 1,
      attempt: 1,
      memberKind: "spinoff",
      launcher: "create-thread",
      launch: null,
      title: "Member A",
      policy: {
        onFound: "return-native-create-receipt",
        onAbsent: "return-attention-before-retry",
        onAmbiguous: "return-attention",
      },
    },
  );
  assert.equal((await fixture.store.read("member-a")).binding.state, "launch-pending");
});

test("stdio orchestration advertises the maximum direct WorkUnitSpec launch prompt", async (t) => {
  const fixture = await orchestrationFixture(t);
  const workUnit = workUnitInput({
    title: "t".repeat(512),
    objectiveSummary: "o".repeat(2_000),
    deliverable: "d".repeat(2_000),
    acceptanceCriteria: Array.from(
      { length: 16 },
      () => "a".repeat(1_000),
    ),
  });
  const [, response] = await roundTrip(
    [INITIALIZE, orchestrationCall(2, workUnit)],
    fixture.options,
  );
  const result = toolBody(response);

  assert.equal(result.isError, false);
  assert.ok(result.body.effects[0].prompt.length > 12_000);
  assert.deepEqual(
    protocolCompatibilityEnvelopeV1(
      "nelos_orchestrate_create",
      result.body,
    ).value,
    result.body,
  );
});

test("stdio orchestration rejects Luna before returning a joined-subagent effect", async (t) => {
  const fixture = await orchestrationFixture(t);
  const workUnit = workUnitInput({
    memberKind: "joined-subagent",
    launch: {
      workspaceMode: "shared-read-only",
      nativeTask: { model: "gpt-5.6-luna", thinking: "low" },
    },
  });
  const [, response] = await roundTrip(
    [INITIALIZE, orchestrationCall(2, workUnit)],
    fixture.options,
  );
  const result = toolBody(response);

  assert.equal(result.isError, true);
  assert.match(
    result.body.error,
    /joined-subagent launches do not support gpt-5\.6-luna/,
  );
  assert.deepEqual(await fixture.store.list(), []);
});

test("stdio orchestration validates a host callback before binding and replays idempotently", async (t) => {
  const fixture = await orchestrationFixture(t);
  const actionId =
    "web-orchestration-v1/member-a/revision-1/attempt-1/launch";
  const receipt = {
    schemaVersion: 1,
    actionId,
    type: "native-create",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "thread-created-1",
  };
  const [, pending, bound, replay] = await roundTrip(
    [
      INITIALIZE,
      orchestrationCall(2, workUnitInput()),
      orchestrationCall(3, workUnitInput(), receipt),
      orchestrationCall(4, workUnitInput(), receipt),
    ],
    fixture.options,
  );

  assert.equal(toolBody(pending).body.effects.length, 1);
  const binding = toolBody(bound);
  assert.equal(binding.isError, false);
  assert.deepEqual(binding.body.binding, {
    state: "bound",
    memberThreadId: "thread-created-1",
    launchActionId: actionId,
    generation: 1,
  });
  assert.deepEqual(binding.body.effects, [
    {
      schemaVersion: 1,
      actionId: "observation-v1/title/member-a/r1/a1/b1/observe",
      type: "native-read-title",
      workUnitId: "member-a",
      specRevision: 1,
      attempt: 1,
      bindingGeneration: 1,
      memberThreadId: "thread-created-1",
      requestedTitle: "Member A",
    },
  ]);
  assert.equal(bound.result.structuredContent.phase, "created");
  assert.equal(bound.result.structuredContent.summary.created, 1);
  assert.equal(
    bound.result.structuredContent.members[0].threadId,
    "thread-created-1",
  );
  assert.deepEqual(toolBody(replay).body, binding.body);
});

test("independent adapters serialize conflicting host receipts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nelos-mcp-orchestration-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstStore = new ExecutionStoreV1({ directory });
  const secondStore = new ExecutionStoreV1({ directory });
  const firstAdapter = new McpOrchestrationAdapterV1({ store: firstStore });
  const secondAdapter = new McpOrchestrationAdapterV1({ store: secondStore });
  const workUnit = workUnitInput({ workUnitId: "receipt-race" });
  const actionId =
    "web-orchestration-v1/receipt-race/revision-1/attempt-1/launch";

  await firstAdapter.orchestrate({ workUnit });
  const outcomes = await Promise.allSettled([
    firstAdapter.orchestrate({
      workUnit,
      receipt: {
        schemaVersion: 1,
        actionId,
        type: "native-create",
        workUnitId: "receipt-race",
        specRevision: 1,
        attempt: 1,
        memberThreadId: "thread-race-a",
      },
    }),
    secondAdapter.orchestrate({
      workUnit,
      receipt: {
        schemaVersion: 1,
        actionId,
        type: "native-create",
        workUnitId: "receipt-race",
        specRevision: 1,
        attempt: 1,
        memberThreadId: "thread-race-b",
      },
    }),
  ]);

  assert.deepEqual(
    outcomes.map(({ status }) => status).sort(),
    ["fulfilled", "rejected"],
  );
  const stored = await firstStore.read("receipt-race");
  assert.equal(stored.binding.state, "bound");
  assert.ok(["thread-race-a", "thread-race-b"].includes(stored.binding.memberThreadId));
});

test("stdio orchestration rejects malformed, stale, and conflicting receipts without changing state", async (t) => {
  const fixture = await orchestrationFixture(t);
  const workUnit = workUnitInput();
  const actionId =
    "web-orchestration-v1/member-a/revision-1/attempt-1/launch";
  const baseReceipt = {
    schemaVersion: 1,
    actionId,
    type: "native-create",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "thread-created-1",
  };
  const [, malformed, stale] = await roundTrip(
    [
      INITIALIZE,
      orchestrationCall(2, workUnit, { ...baseReceipt, unexpected: true }),
      orchestrationCall(3, workUnit, { ...baseReceipt, specRevision: 2 }),
    ],
    fixture.options,
  );
  assert.equal(toolBody(malformed).isError, true);
  assert.match(toolBody(malformed).body.error, /unknown field: unexpected/);
  assert.equal(toolBody(stale).isError, true);
  assert.match(toolBody(stale).body.error, /stale or conflicting specRevision/);
  assert.equal(await fixture.store.read("member-a"), null);

  const [, bound, conflicting] = await roundTrip(
    [
      INITIALIZE,
      orchestrationCall(4, workUnit, baseReceipt),
      orchestrationCall(5, workUnit, {
        ...baseReceipt,
        memberThreadId: "thread-created-2",
      }),
    ],
    fixture.options,
  );
  assert.equal(toolBody(bound).isError, false);
  assert.equal(toolBody(conflicting).isError, true);
  assert.match(toolBody(conflicting).body.error, /conflicts with the bound/);
  assert.equal(
    (await fixture.store.read("member-a")).binding.memberThreadId,
    "thread-created-1",
  );
});

test("nelos_plan_slices routes a valid plan into an authorization proposal", async () => {
  const [, response] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "nelos_plan_slices",
        arguments: { plan: validPlan(), queenThreadId: "queen-1" },
      },
    },
  ]);
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.command, "plan slices");
  assert.equal(body.plan.schemaVersion, 1);
  assert.equal(body.plan.summary.slices, 1);
  assert.ok(Array.isArray(body.plan.waves));
  assert.equal(body.plan.waves.length, 1);
  assert.equal(body.nextAction.kind, "authorization-required");
  assert.equal(
    response.result.structuredContent.phase,
    "authorization-required",
  );
  assert.equal(
    response.result.structuredContent.members[0].status,
    "authorization-required",
  );
  assert.equal(body.nextAction.members[0].sliceId, "explore");
  assert.equal(body.nextAction.members[0].launcher, "spawn-subagent");
  assert.equal(
    body.nextAction.authorizationEffect.tool,
    "nelos_launch_authorize",
  );
  assert.deepEqual(body.nextAction.verification, {
    planRunId: body.planRun.planRunId,
    waveIndex: body.planRun.waves[0].waveIndex,
    waveDigest: body.planRun.waves[0].waveDigest,
  });
});

test("nelos_launch_authorize produces the exact replay receipt", async () => {
  const [, planned] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "nelos_plan_slices",
        arguments: { plan: validPlan(), queenThreadId: "queen-1" },
      },
    },
  ]);
  const proposal = toolBody(planned).body.nextAction;
  const request = proposal.authorizationEffect.arguments.request;
  const [, authorized] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "nelos_launch_authorize",
        arguments: {
          request,
          capabilities: {
            source: "native-host-tool-registry",
            launchers: [{
              launcher: "spawn-subagent",
              memberKinds: ["joined-subagent"],
              workspaceModes: ["shared-read-only"],
              routes: [{
                model: proposal.members[0].nativeTask.model,
                reasoningEfforts: [
                  proposal.members[0].nativeTask.thinking,
                ],
              }],
            }],
          },
          userIntentConfirmed: true,
        },
      },
    },
  ]);
  const { isError, body } = toolBody(authorized);
  assert.equal(isError, false);
  assert.equal(body.command, "launch authorize");
  assert.equal(body.receipt.type, "native-launch-authorization");
  assert.equal(body.receipt.actionId, proposal.actionId);
  assert.equal(body.receipt.members[0].launcherAvailable, true);
  assert.equal(body.receipt.members[0].creationAuthorized, true);
  assert.deepEqual(
    protocolCompatibilityEnvelopeV1("nelos_launch_authorize", body).value,
    body,
  );
});

test("nelos_plan_slices returns a host-owned queen-title effect before a spinoff", async () => {
  const plan = validPlan();
  plan.slices[0] = {
    ...plan.slices[0],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
  };
  const calls = [];
  const appServerBridge = {
    async inspect({ threadId }) {
      calls.push(["inspect", threadId]);
      return {
        schemaVersion: 1,
        threadId: "queen-1",
        title: "Release",
        status: "idle",
      };
    },
    async close() {
      calls.push("close");
    },
  };
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_plan_slices",
          arguments: {
            plan,
            queenThreadId: "queen-1",
          },
        },
      },
    ],
    { appServerBridge },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.deepEqual(body.queenTitleSync, {
    schemaVersion: 1,
    threadId: "queen-1",
    webId: "1",
    previousTitle: "Release",
    title: "👑1 · Release",
    changed: true,
    verified: false,
  });
  assert.deepEqual(body.nextAction, {
    schemaVersion: 1,
    kind: "native-set-title",
    actionId: `plan-title:${body.planRun.planRunId.slice(4)}:queen`,
    threadId: "queen-1",
    title: "👑1 · Release",
    verify: true,
    after: "repeat-plan-slices",
  });
  assert.deepEqual(calls, [
    ["inspect", "queen-1"],
    ["inspect", "queen-1"],
    "close",
  ]);
});

test("nelos_plan_slices requests launch authorization after the host-owned title is observed", async () => {
  const plan = validPlan();
  plan.slices[0] = {
    ...plan.slices[0],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
  };
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_plan_slices",
          arguments: {
            plan,
            queenThreadId: "queen-1",
          },
        },
      },
    ],
    {
      appServerBridge: {
        async inspect() {
          return {
            schemaVersion: 1,
            threadId: "queen-1",
            title: "👑A1 · Release",
            status: "idle",
          };
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.queenTitleSync.verified, true);
  assert.equal(body.nextAction.kind, "authorization-required");
  assert.equal(body.planRun.webIdentity.webId, "A1");
  assert.equal(body.nextAction.members[0].launcher, "create-thread");
});

test("replayed durable planning reuses one identity and one queen-title effect", async () => {
  const plan = validPlan();
  plan.slices[0] = {
    ...plan.slices[0],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
  };
  let record = null;
  let writes = 0;
  const webRegistry = {
    async withLock(callback) {
      return callback();
    },
    async read() {
      return record;
    },
    async list() {
      return record ? [record] : [];
    },
    async write(value) {
      writes += 1;
      record = structuredClone(value);
    },
  };
  const call = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "nelos_plan_slices",
      arguments: { plan, queenThreadId: "queen-1" },
    },
  });
  const [, first, replay] = await roundTrip(
    [INITIALIZE, call(2), call(3)],
    {
      webRegistry,
      appServerBridge: {
        async inspect() {
          return {
            schemaVersion: 1,
            threadId: "queen-1",
            title: "Release",
            status: "idle",
          };
        },
      },
    },
  );
  const firstBody = toolBody(first).body;
  const replayBody = toolBody(replay).body;
  assert.equal(writes, 2);
  assert.equal(firstBody.planRun.webIdentity.webId, "1");
  assert.equal(replayBody.planRun.webIdentity.webId, "1");
  assert.deepEqual(replayBody.nextAction, firstBody.nextAction);
  assert.equal(
    replayBody.planRun.waves[0].members[0].title,
    "🕷️1.1 · Explore",
  );
});

test("an archived queen allocates a fresh web instead of trusting its stale title", async () => {
  const plan = validPlan();
  plan.slices[0] = {
    ...plan.slices[0],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
  };
  const records = new Map([
    ["queen-1", {
      threadId: "queen-1",
      baseTitle: "Release",
      inboundWebId: null,
      outboundWebId: "A1",
      queenThreadId: null,
      queenMarked: true,
      renderedTitle: "👑 A1 · Release",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T01:00:00.000Z",
      archivedAt: "2026-07-26T01:00:00.000Z",
    }],
    ["other-queen", {
      threadId: "other-queen",
      baseTitle: "Other",
      inboundWebId: null,
      outboundWebId: "A1",
      queenThreadId: null,
      queenMarked: true,
      renderedTitle: "👑 A1 · Other",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
      archivedAt: null,
    }],
  ]);
  const webRegistry = {
    async withLock(callback) {
      return callback();
    },
    async read(threadId) {
      return structuredClone(records.get(threadId) ?? null);
    },
    async list() {
      return [...records.values()].map((record) => structuredClone(record));
    },
    async write(record) {
      records.set(record.threadId, structuredClone(record));
    },
  };
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_plan_slices",
          arguments: { plan, queenThreadId: "queen-1" },
        },
      },
    ],
    {
      webRegistry,
      appServerBridge: {
        async inspect() {
          return {
            schemaVersion: 1,
            threadId: "queen-1",
            title: "👑 A1 · Release",
            status: "idle",
          };
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.planRun.webIdentity.webId, "A2");
  assert.equal(body.queenTitleSync.title, "👑A2 · Release");
  assert.equal(records.get("queen-1").outboundWebId, "A2");
  assert.equal(records.get("queen-1").archivedAt, null);
});

test("nelos_plan_slices requires an explicit queen ID", async () => {
  const plan = validPlan();
  plan.slices[0] = {
    ...plan.slices[0],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
  };
  const [, response] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "nelos_plan_slices", arguments: { plan } },
    },
  ]);
  const { isError, body } = toolBody(response);
  assert.equal(isError, true);
  assert.match(body.error, /requires argument queenThreadId/u);
});

test("nelos_thread_inspect returns only bridge-bounded metadata", async () => {
  const inspection = {
    schemaVersion: 1,
    threadId: "thread-1",
    title: "Worker",
    status: "active",
    cwd: "/workspace",
    parentThreadId: "queen-1",
    createdAt: 10,
    updatedAt: 20,
  };
  const calls = [];
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_thread_inspect",
          arguments: { threadId: "thread-1" },
        },
      },
    ],
    {
      appServerBridge: {
        async inspect(args) {
          calls.push(args);
          return inspection;
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.deepEqual(body, { command: "thread inspect", thread: inspection });
  assert.deepEqual(calls, [{ threadId: "thread-1" }]);
});

test("nelos_execution_map_refresh projects current native turn status", async () => {
  const calls = [];
  const args = {
    task: "Refresh the worker",
    members: [{
      id: "worker-a",
      task: "Inspect the widget",
      lifecycle: "subagent",
      model: "gpt-5.6-terra",
      reasoning: "low",
      threadId: "thread-a",
      turnId: "turn-a",
    }],
  };
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_execution_map_refresh",
          arguments: args,
        },
      },
    ],
    {
      appServerBridge: {
        async latestTurn(value) {
          calls.push(value);
          return { turnId: "turn-a", status: "completed" };
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.deepEqual(calls, [{ threadId: "thread-a" }]);
  assert.equal(body.members[0].status, "complete");
  assert.equal(response.result.structuredContent.phase, "complete");
  assert.equal(
    response.result.structuredContent.members[0].status,
    "complete",
  );
  assert.equal(
    response.result.structuredContent.protocol.result.command,
    "execution map refresh",
  );
});

test("nelos_execution_map_refresh rejects invalid members before reads", async () => {
  let reads = 0;
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_execution_map_refresh",
          arguments: { task: "Refresh the worker", members: [] },
        },
      },
    ],
    {
      appServerBridge: {
        async latestTurn() {
          reads += 1;
          return null;
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, true);
  assert.match(body.error, /members must contain 1 to 16 items/u);
  assert.equal(reads, 0);
});

test("post-negotiation execution maps retain a web across restart and stale updates", async () => {
  const records = new Map();
  const webRegistry = {
    async withLock(callback) { return callback(); },
    async read(threadId) { return structuredClone(records.get(threadId) ?? null); },
    async list() { return structuredClone([...records.values()]); },
    async write(record) { records.set(record.threadId, structuredClone(record)); },
  };
  const orchestrationAdapter = {
    async orchestrate({ workUnit }) {
      return {
        binding: {
          state: "bound",
          memberThreadId: `thread-${workUnit.workUnitId}`,
        },
      };
    },
  };
  const create = (id, workUnitId) => orchestrationCall(
    id,
    workUnitInput({ webId: "B6", workUnitId, title: `Member ${workUnitId}` }),
    {},
  );
  const [, alpha, beta, gamma] = await roundTrip(
    [INITIALIZE, create(2, "alpha"), create(3, "beta"), create(4, "gamma")],
    { webRegistry, orchestrationAdapter },
  );
  assert.equal(alpha.result.structuredContent.summary.total, 1);
  assert.equal(beta.result.structuredContent.summary.total, 2);
  assert.equal(gamma.result.structuredContent.summary.total, 3);

  const refreshMember = (id) => ({
    id,
    task: `Member ${id}`,
    lifecycle: "spinoff",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    threadId: `thread-${id}`,
    turnId: `turn-${id}`,
  });
  const [, refreshed] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_execution_map_refresh",
          arguments: {
            task: "B6 execution",
            members: ["alpha", "beta", "gamma"].map(refreshMember),
          },
        },
      },
    ],
    {
      webRegistry,
      appServerBridge: {
        async latestTurn({ threadId }) {
          const id = threadId.slice("thread-".length);
          return { turnId: `turn-${id}`, status: "inProgress" };
        },
        async close() {},
      },
    },
  );
  assert.equal(refreshed.result.structuredContent.summary.total, 3);
  assert.equal(refreshed.result.structuredContent.summary.running, 3);
  assert.deepEqual(
    refreshed.result.structuredContent.members.map(({ status }) => status),
    ["running", "running", "running"],
  );

  const [, stale] = await roundTrip(
    [INITIALIZE, create(2, "alpha")],
    { webRegistry, orchestrationAdapter },
  );
  assert.equal(stale.result.structuredContent.summary.total, 3);
  assert.equal(
    stale.result.structuredContent.members.find(({ id }) => id === "alpha").status,
    "running",
  );
});

test("nelos_thread_inventory forwards bounded IDs and topology policy", async () => {
  const inventory = {
    schemaVersion: 1,
    requested: 2,
    succeeded: 2,
    failed: 0,
    items: [],
    topology: {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      externalParents: [],
    },
  };
  const calls = [];
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_thread_inventory",
          arguments: {
            threadIds: ["queen-1", "child-1"],
            includeTopology: true,
          },
        },
      },
    ],
    {
      appServerBridge: {
        async inspectMany(args) {
          calls.push(args);
          return inventory;
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.deepEqual(body, { command: "thread inventory", inventory });
  assert.deepEqual(calls, [
    {
      threadIds: ["queen-1", "child-1"],
      includeTopology: true,
    },
  ]);
});

test("nelos_web_inspect delegates the complete bounded workflow", async () => {
  const inspection = {
    schemaVersion: 1,
    web: { webId: "A1", queenThreadId: "queen-1" },
    page: {
      offset: 0,
      limit: 15,
      returned: 0,
      total: 0,
      nextOffset: null,
    },
  };
  const calls = [];
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_web_inspect",
          arguments: {
            schemaVersion: 1,
            webId: "A1",
            queenThreadId: "queen-1",
            probe: true,
          },
        },
      },
    ],
    {
      appServerBridge: { marker: "bridge" },
      webRegistry: { marker: "registry" },
      webInspector: {
        async inspect(args, options) {
          calls.push([args, options]);
          return inspection;
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.deepEqual(body, {
    command: "web inspect",
    inspection,
  });
  assert.deepEqual(calls, [
    [
      {
        schemaVersion: 1,
        webId: "A1",
        queenThreadId: "queen-1",
        probe: true,
      },
      {
        appServerBridge: { marker: "bridge" },
        webRegistry: { marker: "registry" },
      },
    ],
  ]);
});

test("nelos_thread_wait forwards snapshot cursors and polling bounds", async () => {
  const wait = {
    schemaVersion: 1,
    status: "timeout",
    snapshots: [],
  };
  const calls = [];
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_thread_wait",
          arguments: {
            targets: [{ threadId: "child-1", afterCursor: "snapshot-v1:x" }],
            timeoutMs: 1_000,
            pollIntervalMs: 100,
          },
        },
      },
    ],
    {
      appServerBridge: {
        async waitForThreads(args) {
          calls.push(args);
          return wait;
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.deepEqual(body, { command: "thread wait", wait });
  assert.deepEqual(calls, [
    {
      targets: [{ threadId: "child-1", afterCursor: "snapshot-v1:x" }],
      timeoutMs: 1_000,
      pollIntervalMs: 100,
    },
  ]);
});

test("thread waits serialize with each other without blocking later MCP requests", async () => {
  let activeWaits = 0;
  let maxConcurrentWaits = 0;
  const responses = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_thread_wait",
          arguments: { targets: [{ threadId: "child-1" }], timeoutMs: 1_000 },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "nelos_thread_wait",
          arguments: { targets: [{ threadId: "child-2" }], timeoutMs: 1_000 },
        },
      },
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ],
    {
      appServerBridge: {
        async waitForThreads() {
          activeWaits += 1;
          maxConcurrentWaits = Math.max(maxConcurrentWaits, activeWaits);
          await new Promise((resolve) => setTimeout(resolve, 25));
          activeWaits -= 1;
          return { schemaVersion: 1, status: "timeout", snapshots: [] };
        },
      },
    },
  );

  assert.deepEqual(responses.map(({ id }) => id), [1, 4, 2, 3]);
  assert.deepEqual(responses[1].result, {});
  assert.equal(toolBody(responses[2]).body.wait.status, "timeout");
  assert.equal(toolBody(responses[3]).body.wait.status, "timeout");
  assert.equal(maxConcurrentWaits, 1);
});

test("a failed non-wait response does not poison later requests or waits", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const write = output.write.bind(output);
  let writes = 0;
  output.write = (chunk, ...args) => {
    writes += 1;
    if (writes === 2) {
      throw new Error("simulated prior response failure");
    }
    return write(chunk, ...args);
  };
  let waitCalls = 0;
  const exited = new Promise((resolve) => {
    startNelosMcpServer({
      input,
      output,
      serverVersion: "0.0.0-test",
      onExit: resolve,
      appServerBridge: {
        async waitForThreads() {
          waitCalls += 1;
          return { schemaVersion: 1, status: "timeout", snapshots: [] };
        },
      },
    });
  });

  for (const message of [
    INITIALIZE,
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "nelos_thread_wait",
        arguments: { targets: [{ threadId: "child-1" }] },
      },
    },
  ]) {
    input.write(`${JSON.stringify(message)}\n`);
  }
  input.end();

  assert.equal(await exited, 0);
  const responses = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.deepEqual(responses.map(({ id }) => id), [1, 2, 3, 4]);
  assert.equal(responses[1].error.code, -32603);
  assert.deepEqual(responses[2].result, {});
  assert.equal(toolBody(responses[3]).body.wait.status, "timeout");
  assert.equal(waitCalls, 1);
});

test("nelos_app_server_health forwards the probe and bounded telemetry", async () => {
  const health = {
    schemaVersion: 1,
    state: "ready",
    compatible: true,
    version: "0.144.6",
    supportedVersions: ["0.144.5", "0.144.6"],
    requiredMethods: ["thread/read", "thread/name/set"],
  };
  const calls = [];
  const [, response] = await roundTrip(
    [
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_app_server_health",
          arguments: { probe: true },
        },
      },
    ],
    {
      appServerBridge: {
        async health(args) {
          calls.push(args);
          return health;
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.deepEqual(body, { command: "app-server health", health });
  assert.deepEqual(calls, [{ probe: true }]);
});

test("nelos_plan_slices reports invalid plans as tool errors", async () => {
  let synchronizationCalls = 0;
  const [, response] = await roundTrip(
    [
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
    ],
    {
      appServerBridge: {
        async synchronizeQueenTitle() {
          synchronizationCalls += 1;
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, true);
  assert.ok(body.error);
  assert.equal(synchronizationCalls, 0);
});

test("nelos_plan_slices never emits a Luna joined-subagent launch", async () => {
  const plan = validPlan();
  plan.slices[0].taskShape = "clear/repeatable";
  const [, recommended, rejected] = await roundTrip([
    INITIALIZE,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "nelos_plan_slices",
        arguments: { plan, queenThreadId: "queen-1" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "nelos_plan_slices",
        arguments: {
          plan: {
            ...plan,
            slices: [{
              ...plan.slices[0],
              routing: { model: "gpt-5.6-luna" },
            }],
          },
          queenThreadId: "queen-1",
        },
      },
    },
  ]);
  const recommendedBody = toolBody(recommended);
  assert.equal(recommendedBody.isError, false);
  assert.equal(
    recommendedBody.body.nextAction.members[0].nativeTask.model,
    "gpt-5.6-terra",
  );
  const rejectedBody = toolBody(rejected);
  assert.equal(rejectedBody.isError, true);
  assert.match(
    rejectedBody.body.error,
    /joined-subagent launches do not support gpt-5\.6-luna/,
  );
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
        arguments: { taskShape: "everyday", launchSurface: "durable-task" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "nelos_intelligence_route",
        arguments: { taskShape: "unsupported-shape", launchSurface: "durable-task" },
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

test("nelos_intelligence_resolve_subagent returns exact verification arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-mcp-subagent-"));
  const directory = join(root, "sessions", "2026", "07", "24");
  await mkdir(directory, { recursive: true });
  const childThreadId = "child-thread";
  await writeFile(
    join(directory, `rollout-2026-07-24T12-00-00-${childThreadId}.jsonl`),
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: childThreadId,
        parent_thread_id: "parent-thread",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "parent-thread",
              agent_path: "/root/nelos_planner_abc123",
            },
          },
        },
      },
    })}\n${JSON.stringify(turnContext("turn-older", "gpt-5.6-sol", "medium"))}\n${JSON.stringify(turnContext("turn-current", "gpt-5.6-terra", "high"))}\n`,
  );
  await withCodexHome(root, async () => {
    const [, response] = await roundTrip([
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_intelligence_resolve_subagent",
          arguments: {
            parentThreadId: "parent-thread",
            agentPath: "/root/nelos_planner_abc123",
            model: "gpt-5.6-terra",
            effort: "high",
          },
        },
      },
    ], { currentThreadId: () => "parent-thread" });
    const { isError, body } = toolBody(response);
    assert.equal(isError, false);
    assert.equal(body.threadId, childThreadId);
    assert.deepEqual(body.nextAction, {
      schemaVersion: 1,
      kind: "verify-route",
      tool: "nelos_intelligence_verify",
      arguments: {
        threadId: childThreadId,
        model: "gpt-5.6-terra",
        effort: "high",
        turnId: "turn-current",
      },
    });
    const [, verified] = await roundTrip([
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: body.nextAction.tool, arguments: body.nextAction.arguments },
      },
    ]);
    assert.equal(toolBody(verified).isError, false);
    assert.equal(toolBody(verified).body.verified, true);

    const [, rejected] = await roundTrip([
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "nelos_intelligence_resolve_subagent",
          arguments: {
            parentThreadId: "different-parent",
            agentPath: "/root/nelos_planner_abc123",
            model: "gpt-5.6-sol",
            effort: "medium",
          },
        },
      },
    ], { currentThreadId: () => "parent-thread" });
    assert.equal(toolBody(rejected).isError, true);
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

test("MCP Apps resources expose the self-contained execution map", async () => {
  const [, listed, read, templates] = await roundTrip([
    INITIALIZE,
    { jsonrpc: "2.0", id: 2, method: "resources/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: EXECUTION_MAP_RESOURCE_URI },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/templates/list",
    },
  ]);
  assert.deepEqual(
    listed.result.resources.map(({ uri, mimeType }) => ({ uri, mimeType })),
    [{
      uri: EXECUTION_MAP_RESOURCE_URI,
      mimeType: EXECUTION_MAP_RESOURCE_MIME_TYPE,
    }],
  );
  assert.equal(
    read.result.contents[0].mimeType,
    EXECUTION_MAP_RESOURCE_MIME_TYPE,
  );
  assert.match(read.result.contents[0].text, /Nelos execution map/u);
  assert.deepEqual(templates.result.resourceTemplates, []);
});

test("unknown tools, unknown resources, unknown methods, and notifications behave per JSON-RPC", async () => {
  const responses = await roundTrip([
    INITIALIZE,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "ui://nelos/unknown.html" },
    },
    { jsonrpc: "2.0", id: 4, method: "prompts/list" },
    { jsonrpc: "2.0", id: 5, method: "ping" },
  ]);
  assert.equal(responses.length, 5); // the notification earns no response
  assert.equal(responses[1].error.code, -32602);
  assert.equal(responses[2].error.code, -32602);
  assert.equal(responses[3].error.code, -32601);
  assert.deepEqual(responses[4].result, {});
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
  const gotFour = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buffered.slice(0, index)));
        buffered = buffered.slice(index + 1);
      }
      if (lines.length >= 4) resolve();
    });
  });
  const initialize = JSON.stringify({
    ...INITIALIZE,
    params: { ...INITIALIZE.params, protocolVersion: "2025-11-25" },
  });
  const splitAt = Math.floor(initialize.length / 2);
  child.stdin.write(initialize.slice(0, splitAt));
  child.stdin.write(
    initialize.slice(splitAt) +
      `\n{bad json}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`,
  );
  await gotFour;
  child.stdin.end();
  await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(lines[0].result.serverInfo.name, "nelos");
  assert.equal(lines[0].result.protocolVersion, "2025-11-25");
  assert.equal(lines[1].error.code, -32700);
  assert.deepEqual(lines[2].result, {});
  assert.deepEqual(
    lines[3].result.tools.map((tool) => tool.name),
    listNelosMcpTools().map((tool) => tool.name),
  );
});
