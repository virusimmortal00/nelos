import assert from "node:assert/strict";
import test from "node:test";

import {
  ExceptionReplanningCoordinatorV1,
  EXCEPTION_REPLAN_TRIGGER_TYPES,
} from "../src/exception-replanning.mjs";
import {
  createPlanRunV1,
} from "../src/plan-run-store.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";

function slice(id, overrides = {}) {
  return {
    id,
    title: `${id} title`,
    objective: `Complete ${id}`,
    deliverable: `${id} deliverable`,
    acceptanceCriteria: [`${id} is verified`],
    dependsOn: [],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
    taskShape: "everyday",
    ...overrides,
  };
}

function basePlan() {
  return {
    schemaVersion: 1,
    objective: "Ship the feature",
    maxParallel: 2,
    slices: [
      slice("accepted"),
      slice("failed", { dependsOn: ["accepted"] }),
      slice("followup", { dependsOn: ["failed"] }),
    ],
  };
}

function input(overrides = {}) {
  const planned = planWorkSlices(overrides.basePlan ?? basePlan());
  const run = createPlanRunV1(planned, { sourceId: "test-base-plan" });
  return {
    schemaVersion: 1,
    idempotencyKey: "failure-event-1",
    queenThreadId: "queen-1",
    basePlanRunId: run.planRunId,
    basePlanDigest: run.planDigest,
    basePlan: basePlan(),
    trigger: {
      type: "execution-failed",
      eventId: "event-1",
      summary: "The implementation failed its integration test",
      affectedSliceIds: ["failed"],
      completedSliceIds: ["accepted"],
      evidence: ["The current result reports a terminal failed outcome."],
    },
    generation: 1,
    receipt: null,
    ...overrides,
  };
}

function coordinatorReturning(result, calls = [], basePlanValue = basePlan()) {
  const planned = planWorkSlices(basePlanValue);
  const run = createPlanRunV1(planned, { sourceId: "test-base-plan" });
  return new ExceptionReplanningCoordinatorV1({
    planningLifecycle: {
      async advance(value, context) {
        calls.push({ value, context });
        return result;
      },
    },
    planRunStore: {
      async read(planRunId) {
        return planRunId === run.planRunId ? run : null;
      },
    },
  });
}

test("exception replanning accepts only typed exceptional triggers and launches through the planning lifecycle", async () => {
  const calls = [];
  const coordinator = coordinatorReturning(
    {
      schemaVersion: 1,
      command: "plan lifecycle",
      lifecycle: {
        bootstrapId: "plan:1234567890abcdef12345678",
        revision: 1,
        phase: "launch-pending",
        plannerThreadId: null,
      },
      bootstrap: {},
      nextAction: { schemaVersion: 1, kind: "launch-planner" },
    },
    calls,
  );
  const result = await coordinator.advance(input(), {
    appServerBridge: { name: "bridge" },
  });
  assert.equal(result.command, "plan exception replan");
  assert.equal(result.replanning.generation, 1);
  assert.equal(result.replanning.trigger.type, "execution-failed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value.schemaVersion, 1);
  assert.equal(calls[0].value.queenThreadId, "queen-1");
  assert.match(calls[0].value.idempotencyKey, /^replan-[a-f0-9]{48}$/u);
  assert.match(calls[0].value.objective, /^Revise the execution plan after execution-failed:/u);
  const context = JSON.parse(calls[0].value.context);
  assert.equal(context.mode, "exception-replan");
  assert.equal(context.policy.preserveCompletedSlicesExactly, true);
  assert.deepEqual(context.trigger.completedSliceIds, ["accepted"]);
  assert.deepEqual(EXCEPTION_REPLAN_TRIGGER_TYPES, [
    "execution-failed",
    "execution-blocked",
    "requirements-changed",
    "confidence-insufficient",
  ]);
});

test("exception replanning preserves completed slices and schedules only pending revised work", async () => {
  const revisedInput = basePlan();
  revisedInput.slices = [
    slice("accepted"),
    slice("replacement", { dependsOn: ["accepted"] }),
    slice("followup", { dependsOn: ["replacement"] }),
  ];
  const revisedPlan = planWorkSlices(revisedInput);
  const coordinator = coordinatorReturning({
    schemaVersion: 1,
    command: "plan lifecycle",
    lifecycle: {
      bootstrapId: "plan:1234567890abcdef12345678",
      revision: 4,
      phase: "completed",
      plannerThreadId: "planner-1",
    },
    bootstrap: {},
    planning: { confidence: "high" },
    plan: revisedPlan,
    nextAction: null,
  });
  const result = await coordinator.advance(input(), {
    appServerBridge: {},
  });
  assert.equal(result.replanning.executionComplete, false);
  assert.deepEqual(result.replanning.completedSliceIds, ["accepted"]);
  assert.deepEqual(
    result.plan.waves.flatMap((wave) => wave.slices.map(({ id }) => id)),
    ["replacement", "followup"],
  );
  assert.deepEqual(result.plan.waves[0].slices[0].dependsOn, []);
  assert.deepEqual(result.plan.waves[1].slices[0].dependsOn, ["replacement"]);
});

test("exception replanning rejects changed completed slices, normal outcomes, stale slices, and autonomous loops", async (t) => {
  await t.test("completed slice changed", async () => {
    const revised = basePlan();
    revised.slices[0] = slice("accepted", { title: "Changed accepted work" });
    const coordinator = coordinatorReturning({
      plan: planWorkSlices(revised),
      lifecycle: {},
      bootstrap: {},
      planning: {},
      nextAction: null,
    });
    await assert.rejects(
      coordinator.advance(input(), { appServerBridge: {} }),
      /changed completed slice accepted/u,
    );
  });

  await t.test("normal success is not a trigger", async () => {
    const coordinator = coordinatorReturning({});
    await assert.rejects(
      coordinator.advance(
        input({ trigger: { ...input().trigger, type: "execution-succeeded" } }),
        {},
      ),
      /requires a failed, blocked, changed-requirements, or insufficient-confidence trigger/u,
    );
  });

  await t.test("unknown affected slice", async () => {
    const coordinator = coordinatorReturning({});
    await assert.rejects(
      coordinator.advance(
        input({
          trigger: {
            ...input().trigger,
            affectedSliceIds: ["missing"],
          },
        }),
        {},
      ),
      /unknown slice missing/u,
    );
  });

  await t.test("second autonomous generation", async () => {
    const coordinator = coordinatorReturning({});
    await assert.rejects(
      coordinator.advance(input({ generation: 2 }), {}),
      /bounded to one generation/u,
    );
  });
});

test("exception replanning returns completion when every revised slice was already accepted", async () => {
  const onlyAccepted = {
    schemaVersion: 1,
    objective: "Already complete",
    maxParallel: 1,
    slices: [slice("accepted")],
  };
  const coordinator = coordinatorReturning(
    {
      plan: planWorkSlices(onlyAccepted),
      lifecycle: {},
      bootstrap: {},
      planning: {},
      nextAction: null,
    },
    [],
    onlyAccepted,
  );
  const result = await coordinator.advance(
    input({
      basePlan: onlyAccepted,
      trigger: {
        type: "requirements-changed",
        eventId: "event-2",
        summary: "The user confirmed no implementation change is needed",
        affectedSliceIds: [],
        completedSliceIds: ["accepted"],
        evidence: ["The accepted slice already satisfies the clarified requirement."],
      },
    }),
    {},
  );
  assert.equal(result.plan, null);
  assert.equal(result.replanning.executionComplete, true);
});

test("exception replanning rejects a caller plan or digest that differs from the persisted base run", async () => {
  const coordinator = coordinatorReturning({});
  await assert.rejects(
    coordinator.advance(
      input({ basePlanDigest: "0".repeat(64) }),
      { appServerBridge: {} },
    ),
    /conflicts with its persisted run/u,
  );
  const altered = basePlan();
  altered.objective = "A caller-altered objective";
  const original = input();
  await assert.rejects(
    coordinator.advance(
      {
        ...original,
        basePlan: altered,
      },
      { appServerBridge: {} },
    ),
    /conflicts with its persisted run/u,
  );
});
