import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_MAP_OUTPUT_SCHEMA,
  EXECUTION_MAP_RESOURCE_MIME_TYPE,
  EXECUTION_MAP_RESOURCE_URI,
  executionMapForToolResultV1,
  projectExecutionMapForToolResultV1,
  executionMapOutputSchemaForToolV1,
  executionMapToolMetadataV1,
  listExecutionMapResourcesV1,
  readExecutionMapResourceV1,
  readExecutionMapHistoryV1,
  refreshExecutionMapStatusV1,
} from "../src/execution-map.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";

function plannedSlice(id, overrides = {}) {
  return {
    id,
    title: `${id} task`,
    objective: `Complete ${id}`,
    deliverable: `${id} result`,
    acceptanceCriteria: [`${id} is verified`],
    dependsOn: [],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
    taskShape: "everyday",
    ...overrides,
  };
}

test("planned task webs project exact task, route, lifecycle, and count data", () => {
  const plan = planWorkSlices({
    schemaVersion: 1,
    objective: "Ship the execution map",
    maxParallel: 2,
    slices: [
      plannedSlice("inspect", {
        lifecycle: "subagent",
        workspaceMode: "shared-read-only",
        taskShape: "complex/open-ended",
      }),
      plannedSlice("implement"),
    ],
  });
  const view = executionMapForToolResultV1(
    "nelos_plan_slices",
    { plan: {} },
    { command: "plan slices", plan },
  );

  assert.deepEqual(view.summary, {
    total: 2,
    spinoffs: 1,
    subagents: 1,
    created: 0,
    running: 0,
    attention: 0,
    complete: 0,
    accepted: 0,
    archived: 0,
  });
  assert.equal(view.phase, "planned");
  assert.equal(view.task, "Ship the execution map");
  assert.deepEqual(view.protocol, {
    schemaVersion: 1,
    tool: "nelos_plan_slices",
    result: { command: "plan slices", plan },
  });
  assert.deepEqual(
    view.members.map((member) => ({
      id: member.id,
      lifecycle: member.lifecycle,
      model: member.model,
      reasoning: member.reasoning,
      status: member.status,
    })),
    [
      {
        id: "inspect",
        lifecycle: "subagent",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        status: "planned",
      },
      {
        id: "implement",
        lifecycle: "spinoff",
        model: "gpt-5.6-terra",
        reasoning: "low",
        status: "planned",
      },
    ],
  );
  assert.equal(EXECUTION_MAP_OUTPUT_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    EXECUTION_MAP_OUTPUT_SCHEMA.required.includes("protocol"),
    true,
  );
  const lifecycleSchema = executionMapOutputSchemaForToolV1(
    "nelos_plan_lifecycle",
  );
  assert.equal(
    lifecycleSchema.properties.protocol.properties.tool.const,
    "nelos_plan_lifecycle",
  );
  assert.ok(
    lifecycleSchema.properties.protocol.properties.result.properties
      .nextAction.oneOf.length > 10,
  );
  const bootstrapSchema = executionMapOutputSchemaForToolV1(
    "nelos_plan_bootstrap",
  );
  assert.ok(
    bootstrapSchema.properties.protocol.properties.result.properties
      .nextAction.oneOf.length > 10,
  );
});

test("planning and durable creation remain visibly distinct", () => {
  const planning = executionMapForToolResultV1(
    "nelos_plan_lifecycle",
    { objective: "Ship history" },
    {
      lifecycle: { bootstrapId: "plan:123", phase: "launch-pending" },
      nextAction: { kind: "native-create-planner" },
    },
  );
  assert.equal(planning.phase, "planning");
  assert.equal(planning.summary.created, 0);
  assert.deepEqual(planning.members[0], {
    id: "plan:123",
    task: "Plan the work",
    lifecycle: "subagent",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    status: "planning",
    threadId: null,
  });

  const workUnit = {
    workUnitId: "implementation",
    memberKind: "spinoff",
    title: "Implement history",
    objectiveSummary: "Ship the history implementation.",
    launch: {
      nativeTask: { model: "gpt-5.6-luna", thinking: "high" },
    },
  };
  const pending = executionMapForToolResultV1(
    "nelos_orchestrate_create",
    { workUnit, receipt: null },
    {
      binding: { state: "launch-pending", memberThreadId: null },
    },
  );
  assert.equal(pending.phase, "launch-pending");
  assert.equal(pending.summary.created, 0);

  const created = executionMapForToolResultV1(
    "nelos_orchestrate_create",
    { workUnit, receipt: { type: "native-create" } },
    {
      binding: { state: "bound", memberThreadId: "thread-history" },
    },
  );
  assert.equal(created.phase, "created");
  assert.equal(created.summary.created, 1);
  assert.equal(created.members[0].threadId, "thread-history");
  assert.equal(created.members[0].model, "gpt-5.6-luna");
  assert.equal(created.members[0].reasoning, "high");
});

test("planned task webs expose authorization and authorized launch phases", () => {
  const plan = planWorkSlices({
    schemaVersion: 1,
    objective: "Launch the visible task web",
    slices: [plannedSlice("launch")],
  });
  const authorizationRequired = executionMapForToolResultV1(
    "nelos_plan_slices",
    { plan: {} },
    {
      plan,
      nextAction: { kind: "authorization-required" },
    },
  );
  assert.equal(authorizationRequired.phase, "authorization-required");
  assert.equal(
    authorizationRequired.members[0].status,
    "authorization-required",
  );
  assert.equal(authorizationRequired.summary.created, 0);

  const launchPending = executionMapForToolResultV1(
    "nelos_plan_slices",
    { plan: {} },
    {
      plan,
      nextAction: { kind: "launch-wave" },
    },
  );
  assert.equal(launchPending.phase, "launch-pending");
  assert.equal(launchPending.members[0].status, "launch-pending");
  assert.equal(launchPending.summary.created, 0);
});

test("ordinary receipts hide archived spin-offs without losing the protocol receipt", () => {
  const archived = executionMapForToolResultV1(
    "nelos_spinoff_cleanup",
    { webId: "B4", queenThreadId: "queen-thread" },
    {
      schemaVersion: 1,
      policy: "auto",
      state: "complete",
      results: [{
        workUnitId: "inspect-next-action",
        threadId: "thread-archive",
        title: "Inspect nextAction protocol visibility",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        state: "archived",
        replayed: false,
      }],
      effects: [],
    },
  );

  assert.equal(archived.phase, "complete");
  assert.equal(archived.summary.archived, 0);
  assert.equal(archived.summary.created, 0);
  assert.deepEqual(archived.members, []);
  assert.equal(
    archived.protocol.result.results[0].state,
    "archived",
  );
});

test("ordinary projection stays filtered when no persisted web identity resolves", async () => {
  const projected = await projectExecutionMapForToolResultV1(
    "nelos_spinoff_cleanup",
    {},
    {
      state: "complete",
      results: [{
        workUnitId: "old",
        threadId: "thread-old",
        title: "🕷️B4.1 · Old worker",
        state: "archived",
      }],
    },
    { webRegistry: memoryWebRegistry() },
  );
  assert.deepEqual(projected.members, []);
  assert.equal(projected.summary.archived, 0);
});

test("planned receipts use persisted spider titles and never regress them", async () => {
  const plan = planWorkSlices({
    schemaVersion: 1,
    objective: "Keep task names canonical",
    slices: [plannedSlice("canonical", { title: "Canonical worker" })],
  });
  const result = {
    plan,
    planRun: {
      waves: [{
        members: [{
          sliceId: "canonical",
          title: "🕷️B6.1 · Canonical worker",
        }],
      }],
    },
  };
  const planned = executionMapForToolResultV1(
    "nelos_plan_slices",
    {},
    result,
  );
  assert.equal(planned.members[0].task, "🕷️B6.1 · Canonical worker");

  const webRegistry = memoryWebRegistry();
  await projectExecutionMapForToolResultV1(
    "nelos_orchestrate_create",
    {
      workUnit: {
        webId: "B6",
        queenThreadId: "queen-b6",
        workUnitId: "canonical",
        specRevision: 1,
        attempt: 1,
        memberKind: "spinoff",
        title: "🕷️B6.1 · Canonical worker",
        objectiveSummary: "Canonical worker",
      },
    },
    { binding: { state: "bound", memberThreadId: "thread-canonical" } },
    { webRegistry },
  );
  const laterPlainPlan = await projectExecutionMapForToolResultV1(
    "nelos_plan_slices",
    { queenThreadId: "queen-b6" },
    { plan },
    { webRegistry },
  );
  assert.equal(
    laterPlainPlan.members[0].task,
    "🕷️B6.1 · Canonical worker",
  );
});

test("not-ready cleanup preserves each pending spin-off route", () => {
  const notReady = executionMapForToolResultV1(
    "nelos_spinoff_cleanup",
    { webId: "B4", queenThreadId: "queen-thread" },
    {
      schemaVersion: 1,
      policy: "auto",
      state: "not-ready",
      pending: [{
        workUnitId: "pending-route",
        threadId: "thread-pending",
        title: "Pending routed spin-off",
        model: "gpt-5.6-luna",
        reasoning: "high",
      }],
    },
  );

  assert.equal(notReady.phase, "attention");
  assert.equal(notReady.members[0].model, "gpt-5.6-luna");
  assert.equal(notReady.members[0].reasoning, "high");
});

test("native turn refresh replaces launch-pending with current worker state", async () => {
  const calls = [];
  const result = await refreshExecutionMapStatusV1({
    task: "Verify execution-map status",
    members: [
      {
        id: "finished",
        task: "Finished worker",
        lifecycle: "subagent",
        model: "gpt-5.6-terra",
        reasoning: "low",
        threadId: "thread-finished",
        turnId: "turn-finished",
      },
      {
        id: "active",
        task: "Active worker",
        lifecycle: "spinoff",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        threadId: "thread-active",
        turnId: "turn-active",
      },
    ],
  }, {
    appServerBridge: {
      async latestTurn({ threadId }) {
        calls.push(threadId);
        return threadId === "thread-finished"
          ? { turnId: "turn-finished", status: "completed" }
          : { turnId: "turn-active", status: "inProgress" };
      },
    },
  });
  assert.deepEqual(calls.sort(), ["thread-active", "thread-finished"]);
  assert.deepEqual(
    result.members.map(({ status }) => status),
    ["complete", "running"],
  );

  const view = executionMapForToolResultV1(
    "nelos_execution_map_refresh",
    {},
    result,
  );
  assert.equal(view.phase, "running");
  assert.deepEqual(
    view.members.map(({ status }) => status),
    ["complete", "running"],
  );
  assert.equal(
    view.protocol.result.members[0].observedTurnStatus,
    "completed",
  );
});

test("native turn refresh validates every member before app-server reads", async () => {
  let reads = 0;
  const appServerBridge = {
    async latestTurn() {
      reads += 1;
      return null;
    },
  };
  const member = {
    id: "worker",
    task: "Validate refresh input",
    lifecycle: "subagent",
    model: "gpt-5.6-terra",
    reasoning: "low",
    threadId: "thread-worker",
    turnId: "turn-worker",
  };

  await assert.rejects(
    refreshExecutionMapStatusV1(
      { task: "Refresh", members: [] },
      { appServerBridge },
    ),
    /members must contain 1 to 16 items/u,
  );
  await assert.rejects(
    refreshExecutionMapStatusV1(
      { task: "Refresh", members: Array.from({ length: 17 }, () => member) },
      { appServerBridge },
    ),
    /members must contain 1 to 16 items/u,
  );
  await assert.rejects(
    refreshExecutionMapStatusV1(
      {
        task: "Refresh",
        members: [{ ...member, lifecycle: "durable" }],
      },
      { appServerBridge },
    ),
    /members\[0\]\.lifecycle is invalid/u,
  );
  assert.equal(reads, 0);
});

function memoryWebRegistry() {
  const records = new Map();
  return {
    async withLock(callback) { return callback(); },
    async read(threadId) { return structuredClone(records.get(threadId) ?? null); },
    async list() { return structuredClone([...records.values()]); },
    async write(record) { records.set(record.threadId, structuredClone(record)); },
  };
}

test("explicit execution-map history returns archived members", async () => {
  const webRegistry = memoryWebRegistry();
  await webRegistry.write({
    threadId: "queen-history",
    outboundWebId: "C7",
    executionMapProjection: {
      task: "Historical task web",
      members: [
        {
          id: "current",
          task: "🕷️C7.1 · Current worker",
          lifecycle: "spinoff",
          model: "gpt-5.6-terra",
          reasoning: "low",
          status: "running",
          threadId: "thread-current",
        },
        {
          id: "old",
          task: "🕷️C7.2 · Old worker",
          lifecycle: "spinoff",
          model: "gpt-5.6-terra",
          reasoning: "low",
          status: "archived",
          threadId: "thread-old",
        },
      ],
    },
  });
  const result = await readExecutionMapHistoryV1(
    { schemaVersion: 1, webId: "c7", queenThreadId: "queen-history" },
    { webRegistry },
  );
  const history = executionMapForToolResultV1(
    "nelos_execution_map_history",
    {},
    result,
  );
  assert.equal(history.members.length, 2);
  assert.equal(history.phase, "running");
  assert.equal(history.summary.archived, 1);
  assert.equal(history.protocol.result.command, "execution map history");
});

test("web-wide projection survives restart and rejects stale member regressions", async () => {
  const webRegistry = memoryWebRegistry();
  const workUnit = (workUnitId, title, attempt = 1) => ({
    webId: "B6",
    queenThreadId: "queen-b6",
    workUnitId,
    specRevision: 1,
    attempt,
    memberKind: "spinoff",
    title,
    objectiveSummary: title,
  });
  for (const [id, title, threadId] of [
    ["alpha", "Alpha", "thread-alpha"],
    ["beta", "Beta", "thread-beta"],
    ["gamma", "Gamma", "thread-gamma"],
  ]) {
    const view = await projectExecutionMapForToolResultV1(
      "nelos_orchestrate_create",
      { workUnit: workUnit(id, title), receipt: {} },
      { binding: { state: "bound", memberThreadId: threadId } },
      { webRegistry },
    );
    assert.equal(view.members.length, ["alpha", "beta", "gamma"].indexOf(id) + 1);
  }

  const running = await projectExecutionMapForToolResultV1(
    "nelos_execution_map_refresh",
    {},
    {
      command: "execution map refresh",
      task: "B6 execution",
      members: [{
        id: "alpha",
        task: "Alpha",
        lifecycle: "spinoff",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        threadId: "thread-alpha",
        turnId: "turn-alpha",
        status: "running",
        observedTurnId: "turn-alpha",
        observedTurnStatus: "inProgress",
      }],
    },
    { webRegistry },
  );
  assert.equal(running.members.length, 3);
  assert.equal(running.members.find(({ id }) => id === "alpha").status, "running");

  const late = await projectExecutionMapForToolResultV1(
    "nelos_execution_map_refresh",
    {},
    {
      command: "execution map refresh",
      task: "B6 execution",
      members: [{
        id: "alpha",
        task: "Alpha",
        lifecycle: "spinoff",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        threadId: "thread-alpha",
        turnId: "turn-alpha",
        status: "attention",
        observedTurnId: "older-turn",
        observedTurnStatus: "completed",
      }],
    },
    { webRegistry },
  );
  assert.equal(late.members.find(({ id }) => id === "alpha").status, "running");

  // A fresh projector instance reads the same persisted registry after restart.
  const restarted = await projectExecutionMapForToolResultV1(
    "nelos_orchestrate_create",
    { workUnit: workUnit("beta", "Beta"), receipt: null },
    { binding: { state: "launch-pending", memberThreadId: null } },
    { webRegistry },
  );
  assert.equal(restarted.members.length, 3);
  assert.equal(restarted.members.find(({ id }) => id === "alpha").status, "running");
  assert.equal(restarted.members.find(({ id }) => id === "beta").status, "created");

  const terminal = await projectExecutionMapForToolResultV1(
    "nelos_spinoff_complete",
    {
      webId: "B6",
      queenThreadId: "queen-b6",
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
      memberThreadId: "thread-alpha",
      outcome: "succeeded",
    },
    {},
    { webRegistry },
  );
  assert.equal(terminal.members.find(({ id }) => id === "alpha").status, "complete");

  const stale = await projectExecutionMapForToolResultV1(
    "nelos_orchestrate_create",
    { workUnit: workUnit("alpha", "Alpha"), receipt: {} },
    { binding: { state: "bound", memberThreadId: "thread-alpha" } },
    { webRegistry },
  );
  assert.equal(stale.members.find(({ id }) => id === "alpha").status, "complete");
  assert.equal(stale.summary.total, 3);
  assert.equal(stale.summary.complete, 1);

  const correctedAttempt = await projectExecutionMapForToolResultV1(
    "nelos_orchestrate_create",
    { workUnit: workUnit("alpha", "Alpha correction", 2), receipt: {} },
    { binding: { state: "bound", memberThreadId: "thread-alpha" } },
    { webRegistry },
  );
  assert.equal(
    correctedAttempt.members.find(({ id }) => id === "alpha").status,
    "created",
  );
});

test("the execution map is a self-contained MCP Apps resource", () => {
  const [listed] = listExecutionMapResourcesV1();
  assert.equal(listed.uri, EXECUTION_MAP_RESOURCE_URI);
  assert.equal(listed.mimeType, EXECUTION_MAP_RESOURCE_MIME_TYPE);
  assert.deepEqual(listed._meta.ui.csp, {
    connectDomains: [],
    resourceDomains: [],
  });

  const resource = readExecutionMapResourceV1(EXECUTION_MAP_RESOURCE_URI);
  assert.equal(resource.contents[0].mimeType, EXECUTION_MAP_RESOURCE_MIME_TYPE);
  assert.match(resource.contents[0].text, /ui\/initialize/u);
  assert.match(
    resource.contents[0].text,
    /ui\/notifications\/tool-result/u,
  );
  assert.match(resource.contents[0].text, /structuredContent/u);
  assert.match(resource.contents[0].text, /authorization-required/u);
  assert.match(resource.contents[0].text, /--archived/u);
  assert.match(resource.contents[0].text, /member\.status/u);
  assert.match(resource.contents[0].text, /className = "member-heading"/u);
  assert.match(resource.contents[0].text, /document\.createElement\("details"\)/u);
  assert.match(resource.contents[0].text, /Archived history/u);
  assert.match(resource.contents[0].text, /"Sub-agent"/u);
  assert.match(resource.contents[0].text, /prefers-reduced-motion: reduce/u);
  assert.match(resource.contents[0].text, /@keyframes status-pulse/u);
  assert.doesNotMatch(resource.contents[0].text, /"Joined subagent"/u);
  assert.doesNotMatch(resource.contents[0].text, /--danger/u);
  assert.doesNotMatch(resource.contents[0].text, /<header>/u);
  assert.doesNotMatch(resource.contents[0].text, /class="eyebrow"/u);
  assert.doesNotMatch(resource.contents[0].text, /id="phase"/u);
  assert.doesNotMatch(resource.contents[0].text, /phaseElement/u);
  assert.doesNotMatch(resource.contents[0].text, /id="summary"/u);
  assert.doesNotMatch(resource.contents[0].text, /className = "metric"/u);
  assert.doesNotMatch(resource.contents[0].text, /id="task"/u);
  assert.doesNotMatch(resource.contents[0].text, /taskElement/u);
  assert.doesNotMatch(resource.contents[0].text, /https?:\/\//u);
  assert.throws(
    () => readExecutionMapResourceV1("ui://nelos/unknown.html"),
    /unknown resource/u,
  );

  assert.deepEqual(executionMapToolMetadataV1("nelos_plan_slices").ui, {
    resourceUri: EXECUTION_MAP_RESOURCE_URI,
  });
  assert.deepEqual(
    executionMapToolMetadataV1("nelos_spinoff_cleanup").ui,
    { resourceUri: EXECUTION_MAP_RESOURCE_URI },
  );
  assert.deepEqual(
    executionMapToolMetadataV1("nelos_execution_map_refresh").ui,
    { resourceUri: EXECUTION_MAP_RESOURCE_URI },
  );
  assert.deepEqual(
    executionMapToolMetadataV1("nelos_execution_map_history").ui,
    { resourceUri: EXECUTION_MAP_RESOURCE_URI },
  );
  assert.equal(executionMapToolMetadataV1("nelos_thread_inspect"), null);
});
