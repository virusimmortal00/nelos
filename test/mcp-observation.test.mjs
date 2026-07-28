import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionStoreV1,
  createWorkUnitSpecV1,
} from "../src/execution-store.mjs";
import { McpJoinAdapterV1 } from "../src/mcp-observation.mjs";
import { OrchestrationCheckpointStoreV1 } from "../src/orchestration-checkpoint-store.mjs";
import {
  createPlanRunV1,
  PlanRunStoreV1,
} from "../src/plan-run-store.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";

function workUnit(overrides = {}) {
  return createWorkUnitSpecV1({
    schemaVersion: 1,
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result"],
    title: "🕷️ A1 · Alpha",
    objectiveSummary: "Implement alpha.",
    deliverable: "Source and tests.",
    acceptanceCriteria: ["Tests pass"],
    dependencies: [],
    required: true,
    policy: {
      maxAttempts: 3,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    },
    ...overrides,
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-mcp-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executionStore = new ExecutionStoreV1({
    directory: join(root, "executions"),
  });
  const checkpointStore = new OrchestrationCheckpointStoreV1({
    directory: join(root, "checkpoints"),
  });
  const acceptanceStore = {
    decisions: [],
    async list() {
      return this.decisions;
    },
  };
  const planRunStore = new PlanRunStoreV1({
    directory: join(root, "plan-runs"),
  });
  return {
    root,
    executionStore,
    checkpointStore,
    acceptanceStore,
    planRunStore,
    adapter: () =>
      new McpJoinAdapterV1({
        executionStore,
        checkpointStore,
        acceptanceStore,
        planRunStore,
      }),
  };
}

async function bind(store, record, memberThreadId = "thread-alpha") {
  await store.create(record);
  await store.markLaunchPending({
    workUnitId: record.workUnitId,
    specRevision: record.specRevision,
    launchActionId: "launch-alpha",
  });
  await store.bind({
    workUnitId: record.workUnitId,
    specRevision: record.specRevision,
    launchActionId: "launch-alpha",
    memberThreadId,
  });
}

test("lazy migration ignores unbound/pending records and never rewrites execution files", async (t) => {
  const current = await fixture(t);
  const unbound = workUnit();
  await current.executionStore.create(unbound);
  const before = await readFile(join(current.root, "executions", "alpha.json"), "utf8");
  let advanced = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(advanced.checkpoint.members, []);
  assert.deepEqual(advanced.join.effects, []);
  assert.deepEqual(advanced.join.boundary, {
    type: "waiting",
    reason: "required-members-unbound",
  });

  await current.executionStore.markLaunchPending({
    workUnitId: "alpha",
    specRevision: 1,
    launchActionId: "launch-alpha",
  });
  advanced = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(advanced.checkpoint.members, []);
  assert.deepEqual(advanced.join.boundary, {
    type: "waiting",
    reason: "required-members-unbound",
  });
  assert.notEqual(
    await readFile(join(current.root, "executions", "alpha.json"), "utf8"),
    before,
    "only the legacy store's own transition changes its file",
  );
  const pending = await readFile(join(current.root, "executions", "alpha.json"), "utf8");
  await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.equal(
    await readFile(join(current.root, "executions", "alpha.json"), "utf8"),
    pending,
    "checkpoint migration never rewrites ExecutionStoreV1",
  );
});

test("unknown webs fail closed instead of implying parent continuation", async (t) => {
  const current = await fixture(t);
  await assert.rejects(
    current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: null,
    }),
    /found no execution work units/,
  );
});

test("malformed records from another orchestration do not block advance", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  await writeFile(
    join(current.root, "executions", "unrelated.json"),
    "{not-json\n",
  );
  const advanced = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.equal(advanced.checkpoint.members[0].workUnitId, "alpha");
});

test("bound v1 records migrate lazily and reconstruct byte-stable effects after restart", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  const first = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(first.join.effects.map(({ type }) => type), [
    "native-read-title",
    "native-wait",
  ]);
  const restarted = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(restarted, first);
  assert.equal(restarted.checkpoint.members[0].title.state, "pending");
  assert.equal(restarted.checkpoint.members[0].execution.state, "unknown");
  assert.equal(restarted.checkpoint.members[0].result.state, "absent");
  assert.equal(restarted.checkpoint.members[0].coordination.state, "unjoined");
});

test("adapter persists receipts before returning the deterministic next action", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  const initial = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const title = initial.join.effects.find(({ type }) => type === "native-read-title");
  const receipt = {
    schemaVersion: 1,
    type: "native-title-observed",
    actionId: title.actionId,
    workUnitId: title.workUnitId,
    specRevision: title.specRevision,
    attempt: title.attempt,
    bindingGeneration: title.bindingGeneration,
    memberThreadId: title.memberThreadId,
    requestedTitle: title.requestedTitle,
    observedTitle: title.requestedTitle,
  };
  const observed = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt,
  });
  assert.equal(observed.checkpoint.members[0].title.state, "verified");
  assert.deepEqual(observed.join.effects.map(({ type }) => type), ["native-wait"]);
  const replay = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt,
  });
  assert.deepEqual(replay, observed);
  await assert.rejects(
    current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: { ...receipt, observedTitle: "conflict" },
    }),
    /conflicts with a consumed actionId/,
  );
});

test("independent adapters serialize a conflicting receipt race", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  const initial = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const title = initial.join.effects.find(({ type }) => type === "native-read-title");
  const base = {
    schemaVersion: 1,
    type: "native-title-observed",
    actionId: title.actionId,
    workUnitId: title.workUnitId,
    specRevision: title.specRevision,
    attempt: title.attempt,
    bindingGeneration: title.bindingGeneration,
    memberThreadId: title.memberThreadId,
    requestedTitle: title.requestedTitle,
  };
  const results = await Promise.allSettled([
    current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: { ...base, observedTitle: title.requestedTitle },
    }),
    current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: { ...base, observedTitle: "conflict" },
    }),
  ]);
  assert.deepEqual(
    results.map(({ status }) => status).sort(),
    ["fulfilled", "rejected"],
  );
});

test("acceptance advances collection to continuation without claiming Desktop wakeup", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  const initial = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const wait = initial.join.effects.find(({ type }) => type === "native-wait");
  const waitReceipt = {
    schemaVersion: 1,
    type: "native-wait",
    actionId: wait.actionId,
    webId: "A1",
    queenThreadId: "queen",
    status: "event",
    targets: wait.targets.map((target) => ({
      ...target,
      nextCursor: "cursor-1",
      lifecycle: "completed",
      latestTurnId: "turn-1",
      attentionRequired: false,
    })),
  };
  const terminal = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: waitReceipt,
  });
  const read = terminal.join.effects.find(({ type }) => type === "native-read-result");
  const result = {
    schemaVersion: 1,
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    outcome: "succeeded",
    summary: "done",
    artifacts: [],
    verification: [],
    blockers: [],
    recoveryHint: null,
  };
  const collected = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-result-read",
      actionId: read.actionId,
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
      bindingGeneration: 1,
      memberThreadId: "thread-alpha",
      requestedTurnId: "turn-1",
      sourceTurnId: "turn-1",
      resultEnvelope: result,
    },
  });
  assert.equal(collected.join.boundary.type, "decide");
  current.acceptanceStore.decisions.push({
    decision: "accepted",
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "thread-alpha",
    sourceTurnId: "turn-1",
  });
  const continued = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(continued.join.boundary, {
    type: "continue",
    reason: "all-required-results-accepted",
    automaticWake: false,
  });
  assert.deepEqual(continued.nextAction, {
    schemaVersion: 1,
    kind: "cleanup-spinoffs",
    tool: "nelos_spinoff_cleanup",
    arguments: {
      webId: "A1",
      queenThreadId: "queen",
    },
  });
});

test("acceptance launches the next persisted dependency wave before cleanup", async (t) => {
  const current = await fixture(t);
  const planned = planWorkSlices({
    schemaVersion: 1,
    objective: "Run dependency-ordered durable work",
    slices: [
      {
        id: "alpha",
        title: "Alpha",
        objective: "Complete alpha",
        deliverable: "Alpha result",
        acceptanceCriteria: ["Alpha passes"],
        dependsOn: [],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
      {
        id: "beta",
        title: "Beta",
        objective: "Complete beta",
        deliverable: "Beta result",
        acceptanceCriteria: ["Beta passes"],
        dependsOn: ["alpha"],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
    ],
  });
  const run = await current.planRunStore.create(
    createPlanRunV1(planned, {
      queenThreadId: "queen",
      sourceId: "multi-wave-observation",
      webIdentity: {
        schemaVersion: 1,
        webId: "A1",
        queenThreadId: "queen",
        queenTitle: "👑 A1 · Queen",
      },
    }),
  );
  await current.planRunStore.markWaveVerified({
    planRunId: run.planRunId,
    queenThreadId: "queen",
    waveIndex: 1,
    waveDigest: run.waves[0].waveDigest,
  });
  await bind(current.executionStore, workUnit());
  const waiting = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const waitEffect = waiting.join.effects.find(
    ({ type }) => type === "native-wait",
  );
  const reading = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-wait",
      actionId: waitEffect.actionId,
      webId: "A1",
      queenThreadId: "queen",
      status: "event",
      targets: waitEffect.targets.map((target) => ({
        ...target,
        nextCursor: "cursor-alpha",
        lifecycle: "completed",
        latestTurnId: "turn-1",
        attentionRequired: false,
      })),
    },
  });
  const readEffect = reading.join.effects.find(
    ({ type }) => type === "native-read-result",
  );
  await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-result-read",
      actionId: readEffect.actionId,
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
      bindingGeneration: 1,
      memberThreadId: "thread-alpha",
      requestedTurnId: "turn-1",
      sourceTurnId: "turn-1",
      resultEnvelope: {
        schemaVersion: 1,
        workUnitId: "alpha",
        specRevision: 1,
        attempt: 1,
        outcome: "succeeded",
        summary: "done",
        artifacts: [],
        verification: [],
        blockers: [],
        recoveryHint: null,
      },
    },
  });
  current.acceptanceStore.decisions.push({
    decision: "accepted",
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "thread-alpha",
    sourceTurnId: "turn-1",
  });
  const advanced = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.equal(advanced.join.boundary.type, "continue");
  assert.equal(advanced.nextAction.kind, "launch-wave");
  assert.equal(advanced.nextAction.waveIndex, 2);
  assert.equal(advanced.nextAction.members[0].sliceId, "beta");

  await current.planRunStore.markWaveVerified({
    planRunId: run.planRunId,
    queenThreadId: "queen",
    waveIndex: 2,
    waveDigest: run.waves[1].waveDigest,
  });
  await bind(
    current.executionStore,
    workUnit({
      workUnitId: "beta",
      title: "🕷️ A1 · Beta",
      dependencies: ["alpha"],
    }),
    "thread-beta",
  );
  const betaWaiting = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const betaWait = betaWaiting.join.effects.find(
    ({ type, targets }) =>
      type === "native-wait" &&
      targets.some(({ workUnitId }) => workUnitId === "beta"),
  );
  const betaReading = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-wait",
      actionId: betaWait.actionId,
      webId: "A1",
      queenThreadId: "queen",
      status: "event",
      targets: betaWait.targets.map((target) => ({
        ...target,
        nextCursor: "cursor-beta",
        lifecycle: "completed",
        latestTurnId: "turn-beta",
        attentionRequired: false,
      })),
    },
  });
  const betaRead = betaReading.join.effects.find(
    ({ type, workUnitId }) =>
      type === "native-read-result" && workUnitId === "beta",
  );
  await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-result-read",
      actionId: betaRead.actionId,
      workUnitId: "beta",
      specRevision: 1,
      attempt: 1,
      bindingGeneration: 1,
      memberThreadId: "thread-beta",
      requestedTurnId: "turn-beta",
      sourceTurnId: "turn-beta",
      resultEnvelope: {
        schemaVersion: 1,
        workUnitId: "beta",
        specRevision: 1,
        attempt: 1,
        outcome: "succeeded",
        summary: "done",
        artifacts: [],
        verification: [],
        blockers: [],
        recoveryHint: null,
      },
    },
  });
  current.acceptanceStore.decisions.push({
    decision: "accepted",
    workUnitId: "beta",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "thread-beta",
    sourceTurnId: "turn-beta",
  });
  const completed = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.equal(completed.nextAction.kind, "cleanup-spinoffs");
});

test("observation adapter has no app-server or process-control dependency", async () => {
  const source = await readFile(new URL("../src/mcp-observation.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /app-server-client|control-endpoint|child_process|spawn\s*\(/u);
});
