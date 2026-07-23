import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionStoreV1,
  createWorkUnitSpecV1,
} from "../src/execution-store.mjs";
import {
  executionObservation,
  reconcileExecutionRecord,
} from "../src/execution-reconciliation.mjs";

function workUnit(overrides = {}) {
  return createWorkUnitSpecV1({
    webId: "A1",
    queenThreadId: "queen-a",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result", "follow-up"],
    title: "Member A",
    objectiveSummary: "Produce one bounded result.",
    deliverable: "A verified result envelope.",
    acceptanceCriteria: ["The current attempt succeeds."],
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

test("a durable execution record reconciles from launch through settlement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nelos-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExecutionStoreV1({ directory });

  const created = await store.create(workUnit());
  const ready = reconcileExecutionRecord(created);
  assert.equal(ready.orchestrationPhase, "ready");
  assert.equal(ready.proposedActions[0].type, "launch");

  const launchActionId = ready.proposedActions[0].actionId;
  await store.markLaunchPending({
    workUnitId: "member-a",
    specRevision: 1,
    launchActionId,
  });
  const bound = await store.bind({
    workUnitId: "member-a",
    specRevision: 1,
    launchActionId,
    memberThreadId: "task-a",
  });
  const running = reconcileExecutionRecord(bound, {
    observation: executionObservation({
      workUnitId: "member-a",
      specRevision: 1,
      memberThreadId: "task-a",
      lifecycle: "running",
      latestTurnId: "turn-a1",
      sourceTurnId: null,
    }),
  });
  assert.equal(running.orchestrationPhase, "active");
  assert.deepEqual(running.proposedActions, []);

  const settled = reconcileExecutionRecord(bound, {
    observation: executionObservation({
      workUnitId: "member-a",
      specRevision: 1,
      memberThreadId: "task-a",
      lifecycle: "completed",
      latestTurnId: "turn-a1",
      sourceTurnId: "turn-a1",
    }),
    resultEnvelope: {
      schemaVersion: 1,
      workUnitId: "member-a",
      specRevision: 1,
      attempt: 1,
      outcome: "succeeded",
      summary: "Member A completed.",
      artifacts: [],
      verification: ["integration fixture"],
      blockers: [],
      recoveryHint: null,
    },
  });
  assert.equal(settled.workOutcome, "succeeded");
  assert.equal(settled.orchestrationPhase, "settled");
  assert.deepEqual(settled.proposedActions, []);
});

test("store and reducer enforce the same bounded attempt contract", () => {
  assert.throws(
    () => workUnit({ policy: {
      maxAttempts: 11,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    } }),
    /must not exceed 10/,
  );
});
