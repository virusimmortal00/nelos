import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OrchestrationCheckpointStoreV1,
  MAX_CONSUMED_OBSERVATION_RECEIPTS,
} from "../src/orchestration-checkpoint-store.mjs";
import {
  applyObservationReceiptV1,
  reduceObservationJoinV1,
} from "../src/orchestration-observation.mjs";

function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    outcome: "succeeded",
    summary: "done",
    artifacts: [],
    verification: ["tests pass"],
    blockers: [],
    recoveryHint: null,
    ...overrides,
  };
}

function member(overrides = {}) {
  const base = {
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    bindingGeneration: 1,
    memberThreadId: "thread-alpha",
    required: true,
    title: {
      state: "pending",
      requestedTitle: "🕸️ A1 · Alpha",
      observedTitle: null,
      retryOrdinal: 0,
    },
    execution: {
      state: "unknown",
      hostId: null,
      cursor: null,
      latestTurnId: null,
      attentionRequired: false,
    },
    result: {
      state: "absent",
      sourceTurnId: null,
      envelope: null,
      errorCode: null,
    },
    coordination: { state: "unjoined" },
  };
  return {
    ...base,
    ...overrides,
    title: { ...base.title, ...overrides.title },
    execution: { ...base.execution, ...overrides.execution },
    result: { ...base.result, ...overrides.result },
    coordination: { ...base.coordination, ...overrides.coordination },
  };
}

function checkpoint(members = [member()], overrides = {}) {
  return {
    schemaVersion: 1,
    webId: "A1",
    queenThreadId: "queen",
    checkpointRevision: 1,
    waitGeneration: 0,
    members,
    consumedReceipts: [],
    ...overrides,
  };
}

function titleReceipt(effect, observedTitle = effect.requestedTitle) {
  return {
    schemaVersion: 1,
    type: "native-title-observed",
    actionId: effect.actionId,
    workUnitId: effect.workUnitId,
    specRevision: effect.specRevision,
    attempt: effect.attempt,
    bindingGeneration: effect.bindingGeneration,
    memberThreadId: effect.memberThreadId,
    requestedTitle: effect.requestedTitle,
    observedTitle,
  };
}

function waitReceipt(effect, overrides = {}) {
  return {
    schemaVersion: 1,
    type: "native-wait",
    actionId: effect.actionId,
    webId: effect.webId,
    queenThreadId: effect.queenThreadId,
    status: "timeout",
    targets: effect.targets.map((target) => ({
      ...target,
      nextCursor: target.afterCursor,
      lifecycle: "running",
      latestTurnId: "turn-1",
      attentionRequired: false,
      ...overrides,
    })),
  };
}

function resultReceipt(effect, resultEnvelope = envelope(), overrides = {}) {
  return {
    schemaVersion: 1,
    type: "native-result-read",
    actionId: effect.actionId,
    workUnitId: effect.workUnitId,
    specRevision: effect.specRevision,
    attempt: effect.attempt,
    bindingGeneration: effect.bindingGeneration,
    memberThreadId: effect.memberThreadId,
    requestedTurnId: effect.requestedTurnId,
    sourceTurnId: effect.requestedTurnId,
    resultEnvelope,
    ...overrides,
  };
}

test("join reducer emits independent title work, one batched wait, and no wake claim", () => {
  const input = checkpoint([
    member(),
    member({
      workUnitId: "beta",
      memberThreadId: "thread-beta",
      title: { requestedTitle: "Beta", state: "verified" },
    }),
    member({
      workUnitId: "detached",
      memberThreadId: "thread-detached",
      required: false,
      coordination: { state: "detached" },
    }),
  ]);
  const reduced = reduceObservationJoinV1(input);
  assert.deepEqual(reduced.effects.map(({ type }) => type), [
    "native-read-title",
    "native-read-title",
    "native-wait",
  ]);
  assert.equal(reduced.effects.filter(({ type }) => type === "native-wait").length, 1);
  assert.deepEqual(
    reduced.effects.find(({ type }) => type === "native-wait").targets.map(({ workUnitId }) => workUnitId),
    ["alpha", "beta"],
  );
  assert.deepEqual(reduced.boundary, {
    type: "waiting",
    reason: "required-members-outstanding",
  });

  const accepted = checkpoint([
    member({
      title: { state: "verified" },
      execution: { state: "terminal", latestTurnId: "turn-1" },
      result: { state: "current", sourceTurnId: "turn-1", envelope: envelope() },
      coordination: { state: "accepted" },
    }),
  ]);
  assert.deepEqual(reduceObservationJoinV1(accepted).boundary, {
    type: "continue",
    reason: "all-required-results-accepted",
    automaticWake: false,
  });
});

test("title observations are strict, retry-bounded, idempotent, and orthogonal", () => {
  let state = checkpoint([
    member({
      execution: { state: "terminal", latestTurnId: "turn-1" },
      result: { state: "current", sourceTurnId: "turn-1", envelope: envelope() },
      coordination: { state: "collected" },
    }),
  ]);
  const titleActionTypes = [];
  for (let ordinal = 0; ordinal < 3; ordinal += 1) {
    const effect = reduceObservationJoinV1(state).effects.find(
      ({ type }) => ["native-read-title", "native-set-title"].includes(type),
    );
    titleActionTypes.push(effect.type);
    state = applyObservationReceiptV1(state, titleReceipt(effect, "Wrong title")).checkpoint;
  }
  assert.deepEqual(titleActionTypes, [
    "native-read-title",
    "native-set-title",
    "native-set-title",
  ]);
  assert.equal(state.members[0].title.state, "attention");
  assert.equal(state.members[0].execution.state, "terminal");
  assert.equal(state.members[0].result.state, "current");
  assert.equal(state.members[0].coordination.state, "collected");
  assert.deepEqual(reduceObservationJoinV1(state).boundary, {
    type: "attention",
    reason: "member-evidence-requires-review",
  });

  const first = checkpoint();
  const effect = reduceObservationJoinV1(first).effects[0];
  const applied = applyObservationReceiptV1(first, titleReceipt(effect));
  const replay = applyObservationReceiptV1(applied.checkpoint, titleReceipt(effect));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.checkpoint, applied.checkpoint);
  assert.throws(
    () => applyObservationReceiptV1(applied.checkpoint, titleReceipt(effect, "conflict")),
    /conflicts with a consumed actionId/,
  );
});

test("wait receipts are cursor-safe across timeouts, order, and conflicts", () => {
  const first = checkpoint([
    member({ title: { state: "verified" } }),
    member({
      workUnitId: "beta",
      memberThreadId: "thread-beta",
      title: { state: "verified", requestedTitle: "Beta" },
    }),
  ]);
  const effect = reduceObservationJoinV1(first).effects[0];
  const receipt = waitReceipt(effect);
  receipt.targets.reverse();
  const applied = applyObservationReceiptV1(first, receipt).checkpoint;
  assert.equal(applied.waitGeneration, 1);
  assert.equal(applied.members[0].execution.state, "running");
  const nextWait = reduceObservationJoinV1(applied).effects[0];
  assert.notEqual(nextWait.actionId, effect.actionId);

  const stale = waitReceipt(nextWait);
  stale.targets[0].afterCursor = "old-cursor";
  assert.throws(
    () => applyObservationReceiptV1(applied, stale),
    /stale or conflicting cursor target/,
  );
  const replay = applyObservationReceiptV1(applied, receipt);
  assert.equal(replay.replayed, true);
  const conflict = structuredClone(receipt);
  conflict.status = "event";
  assert.throws(
    () => applyObservationReceiptV1(applied, conflict),
    /conflicts with a consumed actionId/,
  );
});

test("terminal wait targets require turn identity and failed turns force attention", () => {
  const first = checkpoint([
    member({ title: { state: "verified" } }),
  ]);
  const effect = reduceObservationJoinV1(first).effects[0];
  assert.throws(
    () =>
      applyObservationReceiptV1(
        first,
        waitReceipt(effect, {
          lifecycle: "completed",
          latestTurnId: null,
        }),
      ),
    /terminal lifecycle requires latestTurnId/,
  );

  const failed = applyObservationReceiptV1(
    first,
    waitReceipt(effect, {
      lifecycle: "failed",
      latestTurnId: "turn-failed",
      attentionRequired: false,
    }),
  ).checkpoint;
  assert.equal(failed.members[0].execution.state, "attention");
  assert.equal(failed.members[0].execution.attentionRequired, true);
  assert.deepEqual(reduceObservationJoinV1(failed).boundary, {
    type: "attention",
    reason: "member-evidence-requires-review",
  });
});

test("receipt replay history retains a bounded newest-first window", () => {
  const consumedReceipts = Array.from(
    { length: MAX_CONSUMED_OBSERVATION_RECEIPTS },
    (_, index) => ({
      actionId: `old-${index}`,
      digest: index.toString(16).padStart(64, "0"),
    }),
  );
  const first = checkpoint(undefined, { consumedReceipts });
  const effect = reduceObservationJoinV1(first).effects[0];
  const applied = applyObservationReceiptV1(first, titleReceipt(effect)).checkpoint;
  assert.equal(
    applied.consumedReceipts.length,
    MAX_CONSUMED_OBSERVATION_RECEIPTS,
  );
  assert.equal(applied.consumedReceipts[0].actionId, "old-1");
  assert.equal(
    applied.consumedReceipts.at(-1).actionId,
    effect.actionId,
  );
});

test("result provenance distinguishes current, stale, malformed, and corrective turns", () => {
  const terminal = checkpoint([
    member({
      title: { state: "verified" },
      execution: { state: "terminal", latestTurnId: "turn-2" },
    }),
  ]);
  const effect = reduceObservationJoinV1(terminal).effects[0];
  const stale = applyObservationReceiptV1(
    terminal,
    resultReceipt(effect, envelope(), { sourceTurnId: "turn-1" }),
  ).checkpoint;
  assert.equal(stale.members[0].result.state, "stale");
  assert.equal(stale.members[0].coordination.state, "waiting");

  const current = applyObservationReceiptV1(
    terminal,
    resultReceipt(effect),
  ).checkpoint;
  assert.equal(current.members[0].result.state, "current");
  assert.equal(current.members[0].coordination.state, "collected");
  assert.equal(reduceObservationJoinV1(current).boundary.type, "decide");

  const malformed = applyObservationReceiptV1(
    terminal,
    resultReceipt(effect, { schemaVersion: 1 }),
  ).checkpoint;
  assert.equal(malformed.members[0].result.state, "malformed");
  assert.equal(reduceObservationJoinV1(malformed).boundary.type, "attention");

  const corrected = checkpoint([
    {
      ...stale.members[0],
      execution: {
        ...stale.members[0].execution,
        latestTurnId: "turn-3",
      },
      result: {
        state: "stale",
        sourceTurnId: "turn-1",
        envelope: envelope(),
        errorCode: "source_turn_stale",
      },
    },
  ], { checkpointRevision: stale.checkpointRevision });
  const correctiveEffect = reduceObservationJoinV1(corrected).effects[0];
  const correctedResult = applyObservationReceiptV1(
    corrected,
    resultReceipt(correctiveEffect, envelope(), { sourceTurnId: "turn-3" }),
  ).checkpoint;
  assert.equal(correctedResult.members[0].result.state, "current");
});

test("checkpoint store survives restart and fails closed on revision races", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-observation-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OrchestrationCheckpointStoreV1({ directory: root });
  const initial = { ...checkpoint(), checkpointRevision: 1 };
  await store.write(initial, { expectedRevision: 0 });
  const restarted = new OrchestrationCheckpointStoreV1({ directory: root });
  assert.deepEqual(await restarted.read("A1", "queen"), initial);
  await assert.rejects(
    restarted.write({ ...initial, checkpointRevision: 2 }, { expectedRevision: 0 }),
    /revision conflict/,
  );
  await assert.rejects(
    restarted.write({ ...initial, checkpointRevision: 3 }, { expectedRevision: 1 }),
    /revision conflict/,
  );
});

test("malformed checkpoints and receipts fail closed", () => {
  assert.throws(
    () => reduceObservationJoinV1({ ...checkpoint(), unexpected: true }),
    /incompatible shape/,
  );
  const effect = reduceObservationJoinV1(checkpoint()).effects[0];
  assert.throws(
    () => applyObservationReceiptV1(checkpoint(), { ...titleReceipt(effect), extra: true }),
    /incompatible shape/,
  );
  assert.throws(
    () => applyObservationReceiptV1(checkpoint(), { ...titleReceipt(effect), specRevision: 2 }),
    /stale or unexpected|stale or conflicting/,
  );
});
