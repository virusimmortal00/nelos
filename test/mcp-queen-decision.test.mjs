import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionStoreV1,
  createWorkUnitSpecV1,
} from "../src/execution-store.mjs";
import { McpJoinAdapterV1 } from "../src/mcp-observation.mjs";
import { McpQueenDecisionAdapterV1 } from "../src/mcp-queen-decision.mjs";
import { OrchestrationCheckpointStoreV1 } from "../src/orchestration-checkpoint-store.mjs";
import { QueenAcceptanceStoreV1 } from "../src/queen-acceptance.mjs";
import {
  SpinoffLifecycleAdapterV1,
  SpinoffLifecycleStoreV1,
} from "../src/spinoff-lifecycle.mjs";

function workUnit() {
  return createWorkUnitSpecV1({
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result", "archive"],
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
  });
}

function resultEnvelope(outcome = "succeeded") {
  return {
    schemaVersion: 1,
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    outcome,
    summary: `${outcome} result`,
    artifacts: [],
    verification: outcome === "succeeded" ? ["focused fixture"] : [],
    blockers: outcome === "succeeded" ? [] : ["fixture blocker"],
    recoveryHint: outcome === "succeeded" ? null : "Resolve the fixture blocker.",
  };
}

async function fixture(t, outcome = "succeeded") {
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
  await executionStore.create(workUnit());
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

test("a current rejected decision persists but never changes cleanup eligibility", async (t) => {
  const current = await fixture(t);
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
  assert.equal(observed.checkpoint.members[0].coordination.state, "collected");
  assert.equal(observed.join.boundary.type, "decide");
  const cleanup = await current.lifecycle.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  });
  assert.equal(cleanup.state, "not-ready");
  assert.equal(cleanup.effects, undefined);
});
