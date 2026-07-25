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
import { ExecutionStoreV1 } from "../src/execution-store.mjs";
import { McpOrchestrationAdapterV1 } from "../src/mcp-orchestration.mjs";
import {
  createPlanRunV1,
  PlanRunStoreV1,
} from "../src/plan-run-store.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";

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

async function roundTrip(messages, options = {}) {
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
      currentThreadId: () => "queen-1",
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
      "nelos_launch_verify_batch",
      "nelos_thread_inspect",
      "nelos_thread_inventory",
      "nelos_thread_wait",
      "nelos_app_server_health",
      "nelos_intelligence_route",
      "nelos_intelligence_verify",
      "nelos_intelligence_resolve_subagent",
      "nelos_orchestrate_create",
      "nelos_orchestrate_advance",
      "nelos_spinoff_complete",
      "nelos_spinoff_cleanup",
    ],
  );
  for (const tool of tools.filter(({ name }) =>
    [
      "nelos_launch_verify_batch",
      "nelos_thread_inspect",
      "nelos_thread_inventory",
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
  assert.deepEqual(orchestration.inputSchema.required, ["workUnit", "receipt"]);
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
  assert.equal(advance.inputSchema.properties.receipt.anyOf.length, 4);
  const complete = tools.find(
    ({ name }) => name === "nelos_spinoff_complete",
  );
  assert.deepEqual(complete.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const cleanup = tools.find(
    ({ name }) => name === "nelos_spinoff_cleanup",
  );
  assert.deepEqual(cleanup.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
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
      plan: validPlan(),
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
  assert.equal(body.nextAction.kind, "launch-wave");
});

test("nelos_plan_bootstrap returns a host-owned queen-title effect for a planned spinoff", async () => {
  const request = { objective: "Ship an isolated implementation" };
  const bootstrapId = (await import("../src/planning-bootstrap.mjs"))
    .createPlanningBootstrapV1(request).bootstrapId;
  const plan = validPlan();
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

test("nelos_plan_lifecycle forwards exact receipts and emits a planned launch wave", async () => {
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
  assert.equal(body.nextAction.kind, "launch-wave");
  assert.deepEqual(calls[0].value, args);
  assert.equal(typeof calls[0].context.appServerBridge.inspect, "function");
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
          };
        },
        async create(record) {
          return record;
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.command, "plan slices");
  assert.equal(body.replanning.generation, 1);
  assert.equal(body.nextAction.kind, "launch-wave");
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
  }
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
          return { state: "delivered" };
        },
        async cleanup(value) {
          calls.push(["cleanup", value]);
          return { state: "complete" };
        },
      },
      appServerBridge: { async close() {} },
    },
  );
  assert.deepEqual(calls.map(([method, value]) => [method, value]), [
    ["complete", completion],
    ["cleanup", cleanup],
  ]);
  assert.equal(toolBody(completeResponse).body.state, "delivered");
  assert.equal(toolBody(cleanupResponse).body.state, "complete");
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
  const { prompt: launchPrompt, ...launchEffect } = initial.body.effects[0];
  assert.match(launchPrompt, /^Task title: Member A\n\n/u);
  assert.match(launchPrompt, /call `nelos_spinoff_complete`/u);
  assert.match(launchPrompt, /Set receipt to null/u);
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

test("nelos_plan_slices routes a valid plan into waves", async () => {
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
  assert.deepEqual(body.nextAction, {
    schemaVersion: 1,
    kind: "launch-wave",
    waveIndex: 1,
    members: [
      {
        sliceId: "explore",
        lifecycle: "subagent",
        memberKind: "joined-subagent",
        launcher: "spawn-subagent",
        title: "Explore",
        objective: "bounded exploration",
        deliverable: "notes",
        acceptanceCriteria: ["notes recorded"],
        dependsOn: [],
        titlePolicy: {
          mode: "prompt-seeded",
          recommendedMaxCharacters: 48,
          verifyAfterLaunch: false,
          evidence: "agent-path",
          onMismatch: "attention",
        },
        agentTaskName: "nelos_explore_6f281157",
        identityContract: {
          lifecycle: "subagent",
          memberKind: "joined-subagent",
          primaryId: "agentPath",
          controlSurface: "collaboration",
          nativeThreadIdUse: "verification-only",
          nativeTitleControl: false,
        },
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
    verification: {
      planRunId: body.planRun.planRunId,
      waveIndex: body.planRun.waves[0].waveIndex,
      waveDigest: body.planRun.waves[0].waveDigest,
    },
    settleBeforeWaveIndex: 2,
    remainingWaveCount: 0,
  });
  assert.match(body.nextAction.members[0].prompt, /^Task title: Explore\n\n/u);
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
          arguments: { plan, queenThreadId: "queen-1" },
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
    previousTitle: "Release",
    title: "👑 · Release",
    changed: true,
    verified: false,
  });
  assert.deepEqual(body.nextAction, {
    schemaVersion: 1,
    kind: "native-set-title",
    threadId: "queen-1",
    title: "👑 · Release",
    verify: true,
    after: "repeat-plan-slices",
  });
  assert.deepEqual(calls, [
    ["inspect", "queen-1"],
    ["inspect", "queen-1"],
    "close",
  ]);
});

test("nelos_plan_slices launches only after the host-owned title is observed", async () => {
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
          arguments: { plan, queenThreadId: "queen-1" },
        },
      },
    ],
    {
      appServerBridge: {
        async inspect() {
          return {
            schemaVersion: 1,
            threadId: "queen-1",
            title: "👑 · Release",
            status: "idle",
          };
        },
      },
    },
  );
  const { isError, body } = toolBody(response);
  assert.equal(isError, false);
  assert.equal(body.queenTitleSync.verified, true);
  assert.equal(body.nextAction.kind, "launch-wave");
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
  assert.deepEqual(responses.map(({ id }) => id), [1, 3, 4]);
  assert.deepEqual(responses[1].result, {});
  assert.equal(toolBody(responses[2]).body.wait.status, "timeout");
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
    })}\n`,
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
            model: "gpt-5.6-sol",
            effort: "medium",
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
        model: "gpt-5.6-sol",
        effort: "medium",
      },
    });

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
