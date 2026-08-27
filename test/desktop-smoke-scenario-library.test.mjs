import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateDesktopSmokeCoverageMatrixV1 } from "nelos/desktop-smoke-contract";
import { DesktopGuiScenarioDriver } from "nelos/desktop-gui-scenario-driver";

const fixtureRoot = new URL("../validation/desktop-smoke/", import.meta.url);
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ...Array(17).fill(0),
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0x00, 0x00, 0x00, 0x00,
]);

async function fixture(path) {
  return JSON.parse(await readFile(new URL(path, fixtureRoot), "utf8"));
}

class ScenarioBoundary {
  constructor(taskId, { identityChanges = false, protectedGeometryFails = false, timeout = false, unexpectedWindows = false } = {}) {
    this.taskId = taskId;
    this.identityChanges = identityChanges;
    this.protectedGeometryFails = protectedGeometryFails;
    this.timeout = timeout;
    this.unexpectedWindows = unexpectedWindows;
    this.activeReads = 0;
    this.calls = [];
  }

  async listTasks() { return [this.taskId]; }
  async activateExpectedTask({ scenarioId, taskId }) { return { scenarioId, taskId, createdForScenario: scenarioId, fresh: true }; }
  async activeTask() {
    this.activeReads += 1;
    return { taskId: this.identityChanges && this.activeReads > 1 ? "changed-task" : this.taskId };
  }
  async click({ target }) { this.calls.push(["click", target.role]); }
  async keypress({ key }) { this.calls.push(["keypress", key]); }
  async scroll({ direction, amount }) { this.calls.push(["scroll", direction, amount]); }
  async selectMenu({ menuPath }) { this.calls.push(["select_menu", menuPath]); }
  async typeText({ bytes }) { this.calls.push(["type_text_ref", bytes.length]); }
  async waitFor({ signal }) {
    this.calls.push(["wait_for"]);
    if (!this.timeout) return { matched: true };
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" })), { once: true }));
  }
  async accessibilityTree() { return { role: "application", children: [{ role: "group" }] }; }
  async windowState() { return { windowCount: this.unexpectedWindows ? 2 : 1, focused: true }; }
  async queryElement() { return true; }
  async taskState() { return true; }
  async textPresent() { throw new Error("library assertions must not inspect exchange text"); }
  async windowCount() { return this.unexpectedWindows ? 2 : 1; }
  async protectedCaptureRegions() {
    return {
      schemaVersion: 1,
      conversation: { kind: "conversation", x: 1, y: 1, width: 100, height: 100 },
      credentialInventory: { complete: true, count: 0, regions: [] },
      traversal: { complete: !this.protectedGeometryFails, scannedNodes: 12, maximumNodes: 1000 },
    };
  }
  async captureScreenshot({ expectedTask }) { this.calls.push(["screenshot", expectedTask.taskId]); return Buffer.from(png); }
  async health() { return { crashed: false, stalled: false }; }
}

function resolver() {
  return {
    async resolve() {
      const bytes = Buffer.from("sealed fixture bytes");
      return { bytes, dispose: () => bytes.fill(0) };
    },
  };
}

function driverFor(scenario, bindings, options = {}) {
  const boundary = new ScenarioBoundary(scenario.task.taskId, options);
  return { boundary, driver: new DesktopGuiScenarioDriver({ boundary, sealedValueResolver: resolver(), bindings }) };
}

test("routine and release workflow libraries have complete distinct coverage metadata", async () => {
  const [matrix, release, routine] = await Promise.all([
    fixture("coverage-matrix.json"),
    fixture("scenario-sets/release.json"),
    fixture("scenario-sets/routine.json"),
  ]);
  const validated = validateDesktopSmokeCoverageMatrixV1(matrix, { release, routine });
  assert.equal(validated.release.scenarios.length, 5);
  assert.deepEqual(validated.routine.scenarios.map(({ scenarioId }) => scenarioId), ["plugin-availability", "planning-lifecycle", "attention-recovery"]);
  const releaseById = new Map(validated.release.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  for (const scenario of validated.routine.scenarios) assert.deepEqual(scenario, releaseById.get(scenario.scenarioId));
  assert.doesNotMatch(JSON.stringify({ matrix, release, routine }), /"(?:prompt|response|transcript)"/iu);

  const missingFailureCapture = structuredClone(release);
  missingFailureCapture.scenarios[0].checkpoints = missingFailureCapture.scenarios[0].checkpoints.filter(({ checkpointId }) => checkpointId !== "failure-open-plugins");
  assert.throws(() => validateDesktopSmokeCoverageMatrixV1(matrix, { release: missingFailureCapture, routine }), /failure-only screenshot/u);

  const visibleExchangeAssertion = structuredClone(release);
  visibleExchangeAssertion.scenarios[0].assertions[0].type = "text_ref_present";
  visibleExchangeAssertion.scenarios[0].assertions[0].expectedRef = "sealed-visible-value";
  assert.throws(() => validateDesktopSmokeCoverageMatrixV1(matrix, { release: visibleExchangeAssertion, routine }), /visible exchange text/u);
});

test("every release workflow executes through deterministic accessibility and sealed-value boundaries", async () => {
  const [release, bindings] = await Promise.all([fixture("scenario-sets/release.json"), fixture("accessibility-bindings.json")]);
  for (const scenario of release.scenarios) {
    const { boundary, driver } = driverFor(scenario, bindings);
    const result = await driver.runScenario(scenario);
    assert.equal(result.outcome, "passed", scenario.scenarioId);
    assert.equal(result.taskId, scenario.task.taskId);
    assert.equal(result.assertions.length, scenario.assertions.length);
    assert.equal(result.checkpoints.length, scenario.checkpoints.filter(({ failureOnly }) => !failureOnly).length);
    assert.equal(boundary.calls.some(([operation]) => operation === "screenshot"), true);
    assert.doesNotMatch(JSON.stringify(result), /sealed fixture bytes/iu);
  }
});

test("library GUI fixtures fail deterministically for selector drift and unexpected windows", async () => {
  const [release, bindings] = await Promise.all([fixture("scenario-sets/release.json"), fixture("accessibility-bindings.json")]);
  const selectorDrift = structuredClone(release.scenarios[0]);
  selectorDrift.actions[0].targetRef = "drifted-selector";
  const driftResult = await driverFor(selectorDrift, bindings).driver.runScenario(selectorDrift);
  assert.equal(driftResult.failure.code, "UNKNOWN_TARGET_REF");

  const unexpected = structuredClone(release.scenarios[0]);
  const unexpectedResult = await driverFor(unexpected, bindings, { unexpectedWindows: true }).driver.runScenario(unexpected);
  assert.equal(unexpectedResult.failure.code, "ASSERTION_FAILURE");
});

test("library GUI fixtures fail before submission on identity change and close on timeout or protected geometry", async () => {
  const [release, bindings] = await Promise.all([fixture("scenario-sets/release.json"), fixture("accessibility-bindings.json")]);
  const planning = structuredClone(release.scenarios.find(({ scenarioId }) => scenarioId === "planning-lifecycle"));
  const changed = driverFor(planning, bindings, { identityChanges: true });
  const changedResult = await changed.driver.runScenario(planning);
  assert.equal(changedResult.failure.code, "TASK_IDENTITY_CHANGED");
  assert.equal(changed.boundary.calls.some(([operation]) => operation === "keypress"), false);

  const timeout = structuredClone(release.scenarios[0]);
  timeout.actions[1].timeoutMs = 10;
  const timeoutResult = await driverFor(timeout, bindings, { timeout: true }).driver.runScenario(timeout);
  assert.equal(timeoutResult.failure.code, "ACTION_TIMEOUT");

  const geometry = structuredClone(release.scenarios[0]);
  const geometryBoundary = driverFor(geometry, bindings, { protectedGeometryFails: true });
  const geometryResult = await geometryBoundary.driver.runScenario(geometry);
  assert.equal(geometryResult.failure.code, "PROTECTED_GEOMETRY_UNAVAILABLE");
  assert.equal(geometryBoundary.boundary.calls.some(([operation]) => operation === "screenshot"), false);
});
