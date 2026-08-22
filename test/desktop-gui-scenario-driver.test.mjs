import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopGuiDriverError, DesktopGuiScenarioDriver, SealedValueResolver } from "nelos/desktop-gui-scenario-driver";
import { desktopGuiBindings, desktopGuiScenario } from "./fixtures/desktop-gui-driver-scenarios.mjs";

class GraphicalFixture {
  constructor({ actionError = false, activeTaskDrifts = false, activeTaskTimeout = false, assertionFailure = false, crash = false, missingGeometry = false, stalled = false, timeout = false, afterType = null } = {}) {
    this.calls = [];
    this.tasks = ["desktop-task-driver-1"];
    this.crash = crash;
    this.actionError = actionError;
    this.activeTaskDrifts = activeTaskDrifts;
    this.activeTaskTimeout = activeTaskTimeout;
    this.activeTaskReads = 0;
    this.assertionFailure = assertionFailure;
    this.missingGeometry = missingGeometry;
    this.stalled = stalled;
    this.timeout = timeout;
    this.afterType = afterType;
  }

  async listTasks() { return [...this.tasks]; }
  async activateExpectedTask({ scenarioId, taskId }) { return { taskId, createdForScenario: scenarioId, fresh: true }; }
  async activeTask({ signal } = {}) {
    this.activeTaskReads += 1;
    if (this.activeTaskTimeout && this.activeTaskReads > 1) {
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" })), { once: true }));
    }
    return { taskId: this.activeTaskDrifts && this.activeTaskReads > 1 ? "unexpected-task" : this.tasks.at(-1) };
  }
  async click(value) { this.calls.push(["click", value.target]); }
  async keypress(value) { this.calls.push(["keypress", value.key]); }
  async scroll(value) { this.calls.push(["scroll", value.direction, value.amount]); }
  async selectMenu(value) { this.calls.push(["select_menu", value.menuPath]); if (this.actionError) throw new Error("fixture action failed"); }
  async typeText(value) { this.borrowedBytes = value.bytes; this.calls.push(["type_text_ref", Buffer.from(value.bytes)]); if (this.afterType) await this.afterType(); }
  async waitFor({ signal }) {
    this.calls.push(["wait_for"]);
    if (!this.timeout) return { matched: true };
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" })), { once: true }));
  }
  async accessibilityTree() { return { role: "application", name: "Codex", children: [{ role: "text", text: "sensitive GUI text" }] }; }
  async windowState() { return { windows: [{ title: "Codex", focused: true }] }; }
  async queryElement() { return true; }
  async taskState() { return !this.assertionFailure; }
  async textPresent() { return true; }
  async windowCount() { return 1; }
  async protectedCaptureRegions() {
    return {
      schemaVersion: 1,
      conversation: { kind: "conversation", x: 10, y: 10, width: 500, height: 400 },
      credentialInventory: { complete: true, count: 0, regions: [] },
      traversal: { complete: !this.missingGeometry, scannedNodes: 42, maximumNodes: 10_000 },
    };
  }
  async captureScreenshot({ exclude }) { this.calls.push(["screenshot", exclude]); return Buffer.from("masked graphical fixture"); }
  async health() { return { crashed: this.crash, stalled: this.stalled }; }
}

async function harness(options = {}, clock = Date) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nelos-sealed-values-"));
  const secret = "benchmark prompt that must never be logged";
  await writeFile(path.join(root, "prompt-one.sealed"), secret, { mode: 0o400 });
  const boundary = new GraphicalFixture(options);
  const driver = new DesktopGuiScenarioDriver({ boundary, sealedValueResolver: new SealedValueResolver({ root }), bindings: desktopGuiBindings, clock });
  return { boundary, driver, root, secret };
}

test("production driver boundary selects menus, verifies a fresh task, and erases sealed content", async () => {
  const { boundary, driver, root, secret } = await harness();
  const scenario = desktopGuiScenario();
  assert.doesNotMatch(JSON.stringify(scenario), new RegExp(secret, "u"));
  const result = await driver.runScenario(scenario);
  assert.equal(result.outcome, "passed");
  assert.deepEqual(boundary.calls[0], ["select_menu", ["View", "Details"]]);
  assert.equal(boundary.calls[1][0], "type_text_ref");
  assert.equal(boundary.calls[1][1].toString(), secret);
  assert.equal(boundary.borrowedBytes.every((byte) => byte === 0), true);
  await assert.rejects(stat(path.join(root, "prompt-one.sealed")), { code: "ENOENT" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
  assert.equal(result.checkpoints.find(({ type }) => type === "screenshot").observation.sanitized, true);
  assert.equal(result.assertions.every(({ passed }) => passed), true);
});

test("terminal cleanup removes unread one-shot values, syncs absence, and rejects unsafe or undeclared files", async () => {
  const completed = await harness();
  await writeFile(path.join(completed.root, "unused-one.sealed"), "must not be read", { mode: 0o400 });
  assert.equal((await completed.driver.runScenario(desktopGuiScenario())).outcome, "passed");
  const receipt = await completed.driver.cleanupSealedValues(["prompt-one", "unused-one"]);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    kind: "sealed-value-absence",
    declaredValueRefs: ["prompt-one", "unused-one"],
    removedValueRefs: ["unused-one"],
    alreadyAbsentValueRefs: ["prompt-one"],
    remainingValueRefs: [],
  });
  assert.doesNotMatch(JSON.stringify(receipt), /must not be read/u);
  await assert.rejects(stat(path.join(completed.root, "unused-one.sealed")), { code: "ENOENT" });

  const unsafe = await harness();
  await chmod(path.join(unsafe.root, "prompt-one.sealed"), 0o600);
  await assert.rejects(unsafe.driver.cleanupSealedValues(["prompt-one"]), (error) => error.code === "INVALID_SEALED_VALUE");

  const undeclared = await harness();
  await writeFile(path.join(undeclared.root, "other-value.sealed"), "other", { mode: 0o400 });
  await assert.rejects(undeclared.driver.cleanupSealedValues(["prompt-one"]), (error) => error.code === "UNDECLARED_SEALED_VALUE");
});

test("terminal sealed-value cleanup forwards its cancellation and deadline options", async () => {
  const boundary = new GraphicalFixture();
  let observedRefs = null;
  let observedOptions = null;
  const resolver = {
    async resolve() { throw new Error("not used"); },
    async cleanup(valueRefs, options) {
      observedRefs = valueRefs;
      observedOptions = options;
      return { remainingValueRefs: [] };
    },
  };
  const driver = new DesktopGuiScenarioDriver({ boundary, sealedValueResolver: resolver, bindings: desktopGuiBindings });
  const controller = new AbortController();
  const options = { signal: controller.signal, deadlineAt: 1234 };

  await driver.cleanupSealedValues(["unused-one"], options);

  assert.deepEqual(observedRefs, ["unused-one"]);
  assert.equal(observedOptions, options);
});

test("fresh Desktop task identities cannot be reused across scenarios", async () => {
  const { driver } = await harness();
  assert.equal((await driver.runScenario(desktopGuiScenario())).outcome, "passed");
  const second = await driver.runScenario(desktopGuiScenario({ scenarioId: "scenario-driver-2" }));
  assert.equal(second.outcome, "failed");
  assert.equal(second.failure.code, "REUSED_TASK_IDENTITY");
});

test("a missing expected task maps to reused task identity before Desktop activation", async () => {
  const { boundary, driver } = await harness();
  boundary.tasks = [];
  const result = await driver.runScenario(desktopGuiScenario());
  assert.equal(result.outcome, "failed");
  assert.equal(result.failure.code, "REUSED_TASK_IDENTITY");
});

test("model submit fails before Enter when Desktop switches away from the sealed task", async () => {
  const { boundary, driver } = await harness({ activeTaskDrifts: true });
  const scenario = desktopGuiScenario();
  scenario.actions.push({ actionId: "submit", type: "keypress", targetRef: "submit-key", valueRef: null, timeoutMs: 100 });
  const result = await driver.runScenario(scenario);
  assert.equal(result.outcome, "failed");
  assert.equal(result.failure.code, "TASK_IDENTITY_CHANGED");
  assert.equal(result.actions.at(-1).actionId, "submit");
  assert.equal(result.actions.at(-1).outcome, "failed");
  assert.equal(boundary.calls.some(([name]) => name === "keypress"), false);
});

test("model-submit identity verification and its active-surface hook share the action deadline and abort signal", async () => {
  const verifyHarness = await harness({ activeTaskTimeout: true });
  const verifyScenario = desktopGuiScenario();
  verifyScenario.actions.push({ actionId: "submit", type: "keypress", targetRef: "submit-key", valueRef: null, timeoutMs: 15 });
  const verifyResult = await verifyHarness.driver.runScenario(verifyScenario);
  assert.equal(verifyResult.outcome, "timed_out");
  assert.equal(verifyResult.failure.code, "ACTION_TIMEOUT");
  assert.equal(verifyHarness.boundary.calls.some(([name]) => name === "keypress"), false);

  const hookHarness = await harness(); let hookAborted = false;
  const hookScenario = desktopGuiScenario();
  hookScenario.actions.push({ actionId: "submit", type: "keypress", targetRef: "submit-key", valueRef: null, timeoutMs: 15 });
  const hookResult = await hookHarness.driver.runScenario(hookScenario, { afterAction: async ({ action, signal }) => {
    if (action.actionId !== "submit") return;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => {
      hookAborted = true; reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
    }, { once: true }));
  } });
  assert.equal(hookResult.outcome, "timed_out");
  assert.equal(hookResult.failure.code, "ACTION_TIMEOUT");
  assert.equal(hookResult.actions.at(-1).actionId, "submit");
  assert.equal(hookResult.actions.at(-1).outcome, "succeeded");
  assert.equal(hookAborted, true);
});

test("absolute production deadline stops before Enter and starts no post-deadline capture", async () => {
  const startedAt = Date.parse("2026-08-20T12:00:00.000Z"); let now = startedAt;
  const { boundary, driver } = await harness({ afterType: async () => { now = startedAt + 11; } }, { now: () => now });
  const scenario = desktopGuiScenario();
  scenario.actions.splice(2, 0, { actionId: "submit", type: "keypress", targetRef: "submit-key", valueRef: null, timeoutMs: 100 });
  const result = await driver.runScenario(scenario, { hardDeadlineAt: new Date(startedAt + 10).toISOString() });
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.failure.code, "RUN_DEADLINE_EXPIRED");
  assert.equal(boundary.calls.some(([name]) => name === "keypress"), false);
  assert.equal(boundary.calls.some(([name]) => name === "screenshot"), false);
});

test("action timeouts are deterministic and abort a stalled accessibility operation", async () => {
  const { driver } = await harness({ timeout: true });
  const scenario = desktopGuiScenario();
  scenario.actions[2].timeoutMs = 15;
  const result = await driver.runScenario(scenario);
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.failure.code, "ACTION_TIMEOUT");
  assert.equal(result.actions.at(-1).outcome, "timed_out");
});

test("Desktop crashes become deterministic terminal failures", async () => {
  const { driver } = await harness({ crash: true });
  const result = await driver.runScenario(desktopGuiScenario());
  assert.equal(result.outcome, "failed");
  assert.equal(result.failure.code, "DESKTOP_CRASH");
});

test("action errors, assertion failures, stalls, and scenario deadlines have stable codes", async () => {
  const cases = [
    [{ actionError: true }, desktopGuiScenario(), "ACTION_ERROR", "failed"],
    [{ assertionFailure: true }, desktopGuiScenario(), "ASSERTION_FAILURE", "failed"],
    [{ stalled: true }, desktopGuiScenario(), "TASK_STALLED", "failed"],
    [{ timeout: true }, desktopGuiScenario({ deadlineMs: 25 }), "SCENARIO_DEADLINE", "timed_out"],
  ];
  for (const [options, scenario, code, outcome] of cases) {
    const { driver } = await harness(options);
    const result = await driver.runScenario(scenario);
    assert.equal(result.failure.code, code);
    assert.equal(result.outcome, outcome);
  }
});

test("screenshots accept a complete zero-credential inventory and fail closed when traversal completeness is unproven", async () => {
  const accepted = await harness();
  assert.equal((await accepted.driver.runScenario(desktopGuiScenario())).outcome, "passed");
  assert.deepEqual(accepted.boundary.calls.find(([name]) => name === "screenshot")[1], [{ kind: "conversation", x: 10, y: 10, width: 500, height: 400 }]);
  const { boundary, driver } = await harness({ missingGeometry: true });
  const result = await driver.runScenario(desktopGuiScenario());
  assert.equal(result.outcome, "failed");
  assert.equal(result.failure.code, "PROTECTED_GEOMETRY_UNAVAILABLE");
  assert.equal(boundary.calls.some(([name]) => name === "screenshot"), false);
});

test("forbidden actions are rejected before touching the graphical boundary", async () => {
  const { boundary, driver } = await harness();
  const scenario = desktopGuiScenario();
  scenario.actions[0].type = "shell";
  await assert.rejects(driver.runScenario(scenario), (error) => error instanceof DesktopGuiDriverError && error.code === "FORBIDDEN_ACTION");
  assert.deepEqual(boundary.calls, []);
});

test("package imports the public contract and executable exposes no command escape hatch", async () => {
  const source = await readFile(new URL("../src/desktop-gui-scenario-driver/index.mjs", import.meta.url), "utf8");
  const cli = await readFile(new URL("../bin/nelos-desktop-gui-driver", import.meta.url), "utf8");
  assert.match(source, /from "nelos\/remote-desktop-contract"/u);
  assert.deepEqual([...source.matchAll(/case "([a-z_]+)"/gu)].map((match) => match[1]).filter((name) => ["click", "keypress", "scroll", "select_menu", "type_text_ref", "wait_for"].includes(name)).sort(), ["click", "keypress", "scroll", "select_menu", "type_text_ref", "wait_for"]);
  assert.doesNotMatch(cli, /--(?:command|shell|script|ipc|dom|eval)/u);
});
