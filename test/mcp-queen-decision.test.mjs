import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionStoreV1,
  createWorkUnitSpecV1,
  executionRecordFileNameV1,
  serializeWorkUnitSpecV1,
  validateWorkUnitSpecV1,
} from "../src/execution-store.mjs";
import { McpJoinAdapterV1 } from "../src/mcp-observation.mjs";
import { McpQueenDecisionAdapterV1 } from "../src/mcp-queen-decision.mjs";
import { OrchestrationCheckpointStoreV1 } from "../src/orchestration-checkpoint-store.mjs";
import {
  QueenAcceptanceStoreV1,
  createQueenAcceptanceV1,
  queenAcceptanceIdV1,
} from "../src/queen-acceptance.mjs";
import {
  SpinoffLifecycleAdapterV1,
  SpinoffLifecycleStoreV1,
} from "../src/spinoff-lifecycle.mjs";

function workUnit(overrides = {}) {
  const base = {
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result", "follow-up", "archive"],
    title: "Alpha",
    objectiveSummary: "Produce a bounded result.",
    deliverable: "A current result envelope.",
    acceptanceCriteria: ["The queen accepts the exact current result."],
    dependencies: [],
    required: true,
    policy: {
      maxAttempts: 2,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    },
  };
  return createWorkUnitSpecV1({
    ...base,
    ...overrides,
    policy: { ...base.policy, ...overrides.policy },
  });
}

function resultEnvelope(outcome = "succeeded", attempt = 1) {
  return {
    schemaVersion: 1,
    workUnitId: "alpha",
    specRevision: 1,
    attempt,
    outcome,
    summary: `${outcome} result`,
    artifacts: [],
    verification: outcome === "succeeded" ? ["focused fixture"] : [],
    blockers: outcome === "succeeded" ? [] : ["fixture blocker"],
    recoveryHint: outcome === "succeeded" ? null : "Resolve the fixture blocker.",
  };
}

async function fixture(
  t,
  outcome = "succeeded",
  { legacyObserver = false, workUnitOverrides = {} } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "nelos-mcp-decision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executionStore = new ExecutionStoreV1({
    directory: join(root, "executions"),
  });
  const acceptanceStore = new QueenAcceptanceStoreV1({
    directory: join(root, "acceptances"),
  });
  const checkpointStore = new OrchestrationCheckpointStoreV1({
    directory: join(root, "checkpoints"),
  });
  const lifecycleStore = new SpinoffLifecycleStoreV1({
    directory: join(root, "lifecycle"),
    preferencePath: join(root, "cleanup-preference.json"),
  });
  await executionStore.create(workUnit(workUnitOverrides));
  await executionStore.markLaunchPending({
    workUnitId: "alpha",
    specRevision: 1,
    launchActionId: "launch-alpha",
  });
  await executionStore.bind({
    workUnitId: "alpha",
    specRevision: 1,
    launchActionId: "launch-alpha",
    memberThreadId: "thread-alpha",
  });
  if (legacyObserver) {
    // Simulate a record persisted before create-time result-capability guards.
    const observer = validateWorkUnitSpecV1({
      ...workUnit(),
      workUnitId: "observer",
      capabilities: ["observe"],
      title: "Legacy observer",
      binding: {
        state: "unbound",
        memberThreadId: null,
        launchActionId: null,
        generation: 1,
      },
      replacementHistory: [],
    });
    await mkdir(executionStore.directory, { recursive: true });
    await writeFile(
      join(executionStore.directory, executionRecordFileNameV1(observer.workUnitId)),
      serializeWorkUnitSpecV1(observer),
    );
    await executionStore.markLaunchPending({
      workUnitId: "observer",
      specRevision: 1,
      launchActionId: "launch-observer",
    });
    await executionStore.bind({
      workUnitId: "observer",
      specRevision: 1,
      launchActionId: "launch-observer",
      memberThreadId: "thread-observer",
    });
  }

  const joinAdapter = new McpJoinAdapterV1({
    executionStore,
    checkpointStore,
    acceptanceStore,
    planRunStore: {
      async listForWeb() {
        return [];
      },
    },
  });
  const initial = await joinAdapter.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const wait = initial.join.effects.find(({ type }) => type === "native-wait");
  const terminal = await joinAdapter.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-wait",
      actionId: wait.actionId,
      webId: "A1",
      queenThreadId: "queen",
      status: "event",
      targets: wait.targets.map((target) => ({
        ...target,
        nextCursor: "cursor-alpha",
        lifecycle: "completed",
        latestTurnId: "turn-alpha",
        attentionRequired: false,
      })),
    },
  });
  const read = terminal.join.effects.find(
    ({ type }) => type === "native-read-result",
  );
  const receipt = {
    schemaVersion: 1,
    type: "native-result-read",
    actionId: read.actionId,
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    bindingGeneration: 1,
    memberThreadId: "thread-alpha",
    requestedTurnId: "turn-alpha",
    sourceTurnId: "turn-alpha",
    resultEnvelope: resultEnvelope(outcome),
  };
  await joinAdapter.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt,
  });
  const adapterOptions = {
    executionStore,
    acceptanceStore,
    checkpointStore,
  };
  return {
    root,
    executionStore,
    acceptanceStore,
    checkpointStore,
    joinAdapter,
    lifecycle: new SpinoffLifecycleAdapterV1({
      executionStore,
      acceptanceStore,
      store: lifecycleStore,
    }),
    receipt,
    adapterOptions,
  };
}

function input(receipt, decision = "accepted") {
  return {
    schemaVersion: 1,
    webId: "A1",
    queenThreadId: "queen",
    decision,
    decisionSummary:
      decision === "accepted"
        ? "Queen verified the exact current result."
        : "Queen rejected the exact current result.",
    receipt,
  };
}

const currentBridge = {
  async latestTurn() {
    return { turnId: "turn-alpha", status: "completed" };
  },
};

test("queen decision persists exact provenance, advances observation, and gates cleanup", async (t) => {
  const current = await fixture(t);
  const before = await current.lifecycle.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  });
  assert.equal(before.state, "not-ready");
  assert.equal(before.effects, undefined);

  const adapter = new McpQueenDecisionAdapterV1({
    ...current.adapterOptions,
    now: () => "2026-07-27T12:00:00.000Z",
  });
  const accepted = await adapter.decide(input(current.receipt), {
    appServerBridge: currentBridge,
  });
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.decision.decision, "accepted");
  assert.equal(accepted.decision.sourceTurnId, "turn-alpha");
  assert.equal(accepted.readiness.entries[0].accepted, true);
  assert.deepEqual(accepted.nextAction, {
    schemaVersion: 1,
    kind: "advance-orchestration",
    tool: "nelos_orchestrate_advance",
    arguments: { webId: "A1", queenThreadId: "queen", receipt: null },
  });

  const observed = await current.joinAdapter.advance(
    accepted.nextAction.arguments,
  );
  assert.equal(observed.checkpoint.members[0].coordination.state, "accepted");
  assert.deepEqual(observed.join.boundary, {
    type: "continue",
    reason: "all-required-results-accepted",
    automaticWake: false,
  });
  assert.deepEqual(observed.nextAction, {
    schemaVersion: 1,
    kind: "cleanup-spinoffs",
    tool: "nelos_spinoff_cleanup",
    arguments: {
      webId: "A1",
      queenThreadId: "queen",
    },
  });

  const cleanup = await current.lifecycle.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "ask",
  });
  assert.equal(cleanup.state, "confirmation-required");
  assert.deepEqual(cleanup.candidates, [{
    workUnitId: "alpha",
    threadId: "thread-alpha",
    title: "Alpha",
    model: "host-default",
    reasoning: "host-default",
  }]);
});

test("exact restart replay is idempotent and conflicting reuse is rejected", async (t) => {
  const current = await fixture(t);
  const first = new McpQueenDecisionAdapterV1({
    ...current.adapterOptions,
    now: () => "2026-07-27T12:00:00.000Z",
  });
  const recorded = await first.decide(input(current.receipt), {
    appServerBridge: currentBridge,
  });
  const restarted = new McpQueenDecisionAdapterV1({
    ...current.adapterOptions,
    now: () => "2026-07-27T13:00:00.000Z",
  });
  const replayed = await restarted.decide(input(current.receipt), {
    appServerBridge: {
      async latestTurn() {
        throw new Error("an exact persisted replay must not need live state");
      },
    },
  });
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.decision, recorded.decision);
  await assert.rejects(
    restarted.decide(input(current.receipt, "rejected"), {
      appServerBridge: currentBridge,
    }),
    /different decision/u,
  );
});

test("unknown dependencies reject a queen decision without mutating durable state", async (t) => {
  const current = await fixture(t, "succeeded", {
    workUnitOverrides: { dependencies: ["missing-review"] },
  });
  const beforeCheckpoint = await current.checkpointStore.read("A1", "queen");

  await assert.rejects(
    new McpQueenDecisionAdapterV1(current.adapterOptions).decide(
      input(current.receipt),
      { appServerBridge: currentBridge },
    ),
    /unknown dependency missing-review for alpha/u,
  );

  assert.deepEqual(await current.acceptanceStore.list(), []);
  assert.deepEqual(
    await current.checkpointStore.read("A1", "queen"),
    beforeCheckpoint,
  );
  assert.equal(beforeCheckpoint.members[0].coordination.state, "collected");
});

test("a persisted accepted joined review satisfies a dependent decision after restart", async (t) => {
  const current = await fixture(t, "succeeded", {
    workUnitOverrides: { dependencies: ["review"] },
  });
  const review = workUnit({
    workUnitId: "review",
    memberKind: "joined-subagent",
    capabilities: ["observe", "read-result", "follow-up"],
    title: "Review",
    dependencies: [],
  });
  await current.executionStore.create(review);
  await current.executionStore.markLaunchPending({
    workUnitId: "review",
    specRevision: 1,
    launchActionId: "launch-review",
  });
  await current.executionStore.bind({
    workUnitId: "review",
    specRevision: 1,
    launchActionId: "launch-review",
    memberThreadId: "thread-review",
  });
  await current.acceptanceStore.record(createQueenAcceptanceV1({
    schemaVersion: 1,
    decisionId: queenAcceptanceIdV1({
      webId: "A1",
      workUnitId: "review",
      specRevision: 1,
      attempt: 1,
      memberThreadId: "thread-review",
      sourceTurnId: "turn-review",
    }),
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "review",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "thread-review",
    sourceTurnId: "turn-review",
    decision: "accepted",
    decisionSummary: "The independent joined review passed.",
    result: {
      schemaVersion: 1,
      workUnitId: "review",
      specRevision: 1,
      attempt: 1,
      outcome: "succeeded",
      summary: "review passed",
      artifacts: [],
      verification: ["independent review"],
      blockers: [],
      recoveryHint: null,
    },
    recordedAt: "2026-08-03T12:00:00.000Z",
  }));

  const accepted = await new McpQueenDecisionAdapterV1(
    current.adapterOptions,
  ).decide(input(current.receipt), {
    appServerBridge: currentBridge,
  });

  assert.equal(accepted.decision.decision, "accepted");
  assert.equal(
    accepted.readiness.entries.find(
      ({ workUnitId }) => workUnitId === "alpha",
    ).unacceptedDependencies.length,
    0,
  );
});

test("stale, mismatched, failed, and cross-queen acceptance fails closed", async (t) => {
  const current = await fixture(t);
  const adapter = new McpQueenDecisionAdapterV1(current.adapterOptions);
  await assert.rejects(
    adapter.decide(
      input({ ...current.receipt, sourceTurnId: "stale-turn" }),
      { appServerBridge: currentBridge },
    ),
    /current durable binding|consumed by orchestration/u,
  );
  await assert.rejects(
    adapter.decide(
      input({ ...current.receipt, memberThreadId: "other-member" }),
      { appServerBridge: currentBridge },
    ),
    /current durable binding/u,
  );
  await assert.rejects(
    adapter.decide(
      {
        ...input(current.receipt),
        queenThreadId: "other-queen",
      },
      { appServerBridge: currentBridge },
    ),
    /current durable binding/u,
  );
  assert.deepEqual(await current.acceptanceStore.list(), []);

  for (const outcome of ["failed", "blocked"]) {
    const nonSuccess = await fixture(t, outcome);
    await assert.rejects(
      new McpQueenDecisionAdapterV1(nonSuccess.adapterOptions).decide(
        input(nonSuccess.receipt),
        { appServerBridge: currentBridge },
      ),
      /only succeeded results may be accepted/u,
    );
    assert.deepEqual(await nonSuccess.acceptanceStore.list(), []);
    const cleanup = await nonSuccess.lifecycle.cleanup({
      webId: "A1",
      queenThreadId: "queen",
      policy: "auto",
    });
    assert.equal(cleanup.state, "not-ready");
    assert.equal(cleanup.effects, undefined);
  }
});

test("rejection survives restart, repairs a legacy observer, and accepts a corrected turn", async (t) => {
  const current = await fixture(t, "succeeded", { legacyObserver: true });
  const rejected = await new McpQueenDecisionAdapterV1(
    current.adapterOptions,
  ).decide(input(current.receipt, "rejected"), {
    appServerBridge: currentBridge,
  });
  assert.equal(rejected.decision.decision, "rejected");
  assert.equal(rejected.readiness.entries[0].accepted, false);
  const observed = await current.joinAdapter.advance(
    rejected.nextAction.arguments,
  );
  assert.equal(
    observed.checkpoint.members.find(
      ({ workUnitId }) => workUnitId === "alpha",
    ).coordination.state,
    "correction-pending",
  );
  assert.deepEqual(observed.join.boundary.members, [{
    workUnitId: "observer",
    problem: "required-result-member-missing-read-result",
    missingCapabilities: ["read-result"],
    supportedActions: ["detach"],
  }]);

  const repair = observed.join.effects.find(
    ({ type }) => type === "orchestration-repair-member",
  );
  const repaired = await current.joinAdapter.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "orchestration-member-repaired",
      actionId: repair.actionId,
      workUnitId: repair.workUnitId,
      specRevision: repair.specRevision,
      attempt: repair.attempt,
      bindingGeneration: repair.bindingGeneration,
      memberThreadId: repair.memberThreadId,
      resolution: "detach",
    },
  });
  assert.equal(
    repaired.checkpoint.members.find(
      ({ workUnitId }) => workUnitId === "observer",
    ).coordination.state,
    "detached",
  );
  const followUp = repaired.join.effects.find(
    ({ type }) => type === "native-follow-up",
  );
  assert.equal(followUp.nextAttempt, 2);

  const restartedJoin = new McpJoinAdapterV1({
    executionStore: current.executionStore,
    checkpointStore: current.checkpointStore,
    acceptanceStore: current.acceptanceStore,
    planRunStore: {
      async listForWeb() {
        return [];
      },
    },
  });
  const followUpReceipt = {
    schemaVersion: 1,
    type: "native-follow-up-delivered",
    actionId: followUp.actionId,
    workUnitId: followUp.workUnitId,
    specRevision: followUp.specRevision,
    attempt: followUp.attempt,
    bindingGeneration: followUp.bindingGeneration,
    memberThreadId: followUp.memberThreadId,
    rejectedSourceTurnId: followUp.rejectedSourceTurnId,
    nextAttempt: followUp.nextAttempt,
  };
  await assert.rejects(
    restartedJoin.advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: {
        ...followUpReceipt,
        rejectedSourceTurnId: "different-rejected-turn",
      },
    }),
    /does not match the rejected result/,
  );
  const correctionWaiting = await restartedJoin.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: followUpReceipt,
  });
  assert.equal((await current.executionStore.read("alpha")).attempt, 2);
  assert.deepEqual(
    await restartedJoin.advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: followUpReceipt,
    }),
    correctionWaiting,
  );
  const wait = correctionWaiting.join.effects.find(
    ({ type }) => type === "native-wait",
  );
  const correctionTerminal = await restartedJoin.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-wait",
      actionId: wait.actionId,
      webId: "A1",
      queenThreadId: "queen",
      status: "event",
      targets: wait.targets.map((target) => ({
        ...target,
        nextCursor: "cursor-alpha-2",
        lifecycle: "completed",
        latestTurnId: "turn-alpha-2",
        attentionRequired: false,
      })),
    },
  });
  const read = correctionTerminal.join.effects.find(
    ({ type }) => type === "native-read-result",
  );
  const correctedReceipt = {
    schemaVersion: 1,
    type: "native-result-read",
    actionId: read.actionId,
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 2,
    bindingGeneration: 1,
    memberThreadId: "thread-alpha",
    requestedTurnId: "turn-alpha-2",
    sourceTurnId: "turn-alpha-2",
    resultEnvelope: resultEnvelope("succeeded", 2),
  };
  const corrected = await restartedJoin.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: correctedReceipt,
  });
  assert.equal(corrected.join.boundary.type, "decide");

  const accepted = await new McpQueenDecisionAdapterV1(
    current.adapterOptions,
  ).decide(input(correctedReceipt, "accepted"), {
    appServerBridge: {
      async latestTurn() {
        return { turnId: "turn-alpha-2", status: "completed" };
      },
    },
  });
  assert.equal(accepted.decision.attempt, 2);
  assert.equal(accepted.decision.sourceTurnId, "turn-alpha-2");
  const continued = await restartedJoin.advance(
    accepted.nextAction.arguments,
  );
  assert.deepEqual(continued.join.boundary, {
    type: "continue",
    reason: "all-required-results-accepted",
    automaticWake: false,
  });

  const cleanup = await current.lifecycle.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  });
  assert.equal(cleanup.state, "effects-required");
  assert.deepEqual(
    cleanup.effects.map(({ threadId }) => threadId),
    ["thread-alpha"],
  );
});

test("uncorrectable rejections surface attention without a follow-up effect", async (t) => {
  const scenarios = [
    {
      capabilities: ["observe", "read-result", "archive"],
    },
    {
      policy: { maxAttempts: 1 },
    },
  ];
  for (const workUnitOverrides of scenarios) {
    const current = await fixture(t, "succeeded", { workUnitOverrides });
    const rejected = await new McpQueenDecisionAdapterV1(
      current.adapterOptions,
    ).decide(input(current.receipt, "rejected"), {
      appServerBridge: currentBridge,
    });
    const observed = await current.joinAdapter.advance(
      rejected.nextAction.arguments,
    );
    assert.equal(observed.checkpoint.members[0].coordination.state, "collected");
    assert.equal(
      observed.checkpoint.members[0].execution.attentionRequired,
      true,
    );
    assert.equal(
      observed.join.effects.some(({ type }) => type === "native-follow-up"),
      false,
    );
    assert.deepEqual(observed.join.boundary, {
      type: "attention",
      reason: "member-evidence-requires-review",
    });
  }
});
