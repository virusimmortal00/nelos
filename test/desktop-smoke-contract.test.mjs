import assert from "node:assert/strict";
import test from "node:test";

import { validateDesktopSmokeScenarioV1 } from "nelos/desktop-smoke-contract";

function scenario() {
  return {
    schemaVersion: 1,
    scenarioId: "provider-neutral-scenario",
    task: { taskId: "scenario-task", createdForScenario: "provider-neutral-scenario", fresh: true },
    actions: [{ actionId: "wait-ready", type: "wait_for", targetRef: "ready", valueRef: null, timeoutMs: 1000 }],
    checkpoints: [{ checkpointId: "ready-state", type: "accessibility_tree", afterActionId: "wait-ready", failureOnly: false }],
    assertions: [{ assertionId: "ready-present", type: "element_present", targetRef: "ready", expectedRef: null, checkpointId: "ready-state" }],
    deadlineMs: 2000,
  };
}

test("the public scenario contract accepts only provider-neutral definitions", () => {
  assert.deepEqual(validateDesktopSmokeScenarioV1(scenario()), scenario());
  for (const mutation of [
    (value) => { value.actions[0].type = "shell"; },
    (value) => { value.checkpoints[0].type = "screenshot"; },
    (value) => { value.provider = "private-provider"; },
  ]) {
    const value = scenario();
    mutation(value);
    assert.throws(() => validateDesktopSmokeScenarioV1(value));
  }
});

test("assertions cannot attach to failure-only checkpoints", () => {
  const value = scenario();
  value.checkpoints[0].failureOnly = true;
  assert.throws(() => validateDesktopSmokeScenarioV1(value), /failure-only checkpoint/u);
});
