import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkUnitSpecV1 } from "../src/execution-store.mjs";
import {
  QueenAcceptanceStoreV1,
  createQueenAcceptanceV1,
  deriveWebReadinessV1,
  queenAcceptanceIdV1,
} from "../src/queen-acceptance.mjs";

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
    objectiveSummary: "Produce a bounded result.",
    deliverable: "A result envelope.",
    acceptanceCriteria: ["A queen can verify the output."],
    dependencies: [],
    required: true,
    policy: { maxAttempts: 2, onBlocked: "queen-review", onFailure: "queen-review" },
    ...overrides,
  });
}

function boundWorkUnit(overrides = {}) {
  const unit = workUnit(overrides);
  return {
    ...unit,
    binding: {
      state: "bound",
      memberThreadId: overrides.memberThreadId ?? "task-a",
      launchActionId: "launch-a",
      generation: 1,
    },
  };
}

function decision({ workUnit = boundWorkUnit(), decision = "accepted", sourceTurnId = "turn-a1" } = {}) {
  const result = {
    schemaVersion: 1,
    workUnitId: workUnit.workUnitId,
    specRevision: workUnit.specRevision,
    attempt: workUnit.attempt,
    outcome: decision === "accepted" ? "succeeded" : "failed",
    summary: "Current bounded result.",
    artifacts: [],
    verification: ["fixture"],
    blockers: decision === "accepted" ? [] : ["fixture failed"],
    recoveryHint: decision === "accepted" ? null : "Fix the fixture.",
  };
  const identity = {
    webId: workUnit.webId,
    workUnitId: workUnit.workUnitId,
    specRevision: workUnit.specRevision,
    attempt: workUnit.attempt,
    memberThreadId: workUnit.binding.memberThreadId,
    sourceTurnId,
  };
  return {
    schemaVersion: 1,
    decisionId: queenAcceptanceIdV1(identity),
    webId: workUnit.webId,
    queenThreadId: workUnit.queenThreadId,
    workUnitId: workUnit.workUnitId,
    specRevision: workUnit.specRevision,
    attempt: workUnit.attempt,
    memberThreadId: workUnit.binding.memberThreadId,
    sourceTurnId,
    decision,
    decisionSummary: decision === "accepted" ? "Queen verified the output." : "Queen rejected the output.",
    result,
    recordedAt: "2026-07-21T12:00:00.000Z",
  };
}

test("completion stays distinct from queen acceptance and dependency readiness", () => {
  const upstream = boundWorkUnit();
  const dependent = workUnit({
    workUnitId: "member-b",
    title: "Member B",
    dependencies: ["member-a"],
  });

  const before = deriveWebReadinessV1({ workUnits: [upstream, dependent] });
  assert.deepEqual(before.readyWorkUnitIds, []);
  assert.deepEqual(before.entries.find((entry) => entry.workUnitId === "member-b"), {
    workUnitId: "member-b",
    bindingState: "unbound",
    accepted: false,
    acceptedDecisionId: null,
    ready: false,
    reason: "blocked_by_unaccepted_dependencies",
    unacceptedDependencies: ["member-a"],
  });

  const accepted = createQueenAcceptanceV1(decision({ workUnit: upstream }));
  const after = deriveWebReadinessV1({
    workUnits: [upstream, dependent],
    decisions: [accepted],
  });
  assert.deepEqual(after.readyWorkUnitIds, ["member-b"]);
  assert.equal(after.entries.find((entry) => entry.workUnitId === "member-a").accepted, true);
});

test("acceptance is durable, exact-provenance idempotent, and restart-safe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fraktik-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = boundWorkUnit();
  const accepted = createQueenAcceptanceV1(decision({ workUnit: upstream }));
  const first = new QueenAcceptanceStoreV1({ directory: root });

  assert.deepEqual(await first.record(accepted), accepted);
  assert.deepEqual(await first.record(accepted), accepted);

  const restarted = new QueenAcceptanceStoreV1({ directory: root });
  assert.deepEqual(await restarted.list(), [accepted]);
  const dependent = workUnit({
    workUnitId: "member-b",
    title: "Member B",
    dependencies: ["member-a"],
  });
  const readiness = deriveWebReadinessV1({
    workUnits: [upstream, dependent],
    decisions: await restarted.list(),
  });
  assert.deepEqual(readiness.readyWorkUnitIds, ["member-b"]);
});

test("stale attempts, rejected decisions, missing dependencies, and cycles fail closed", () => {
  const upstream = boundWorkUnit({ attempt: 2 });
  const dependent = workUnit({
    workUnitId: "member-b",
    title: "Member B",
    dependencies: ["member-a"],
  });
  const stale = decision({ workUnit: boundWorkUnit({ attempt: 1 }) });
  assert.deepEqual(
    deriveWebReadinessV1({ workUnits: [upstream, dependent], decisions: [stale] }).readyWorkUnitIds,
    [],
  );
  assert.throws(
    () => deriveWebReadinessV1({ workUnits: [workUnit({ dependencies: ["missing"] })] }),
    /unknown dependency/,
  );
  assert.throws(
    () => deriveWebReadinessV1({
      workUnits: [
        workUnit({ workUnitId: "a", dependencies: ["b"] }),
        workUnit({ workUnitId: "b", title: "Member B", dependencies: ["a"] }),
      ],
    }),
    /contain a cycle/,
  );
});
