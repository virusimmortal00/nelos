import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopGuiDriverError, DesktopGuiScenarioDriver, SealedValueResolver } from "nelos/desktop-gui-scenario-driver";
import { desktopGuiBindings, desktopGuiScenario } from "./fixtures/desktop-gui-driver-scenarios.mjs";

class GraphicalFixture {
  constructor({ actionError = false, assertionFailure = false, crash = false, missingGeometry = false, stalled = false, timeout = false } = {}) {
    this.calls = [];
    this.tasks = ["desktop-task-driver-1"];
    this.crash = crash;
    this.actionError = actionError;
    this.assertionFailure = assertionFailure;
    this.missingGeometry = missingGeometry;
    this.stalled = stalled;
    this.timeout = timeout;
  }

  async listTasks() { return [...this.tasks]; }
  async activateExpectedTask({ scenarioId, taskId }) { return { taskId, createdForScenario: scenarioId, fresh: true }; }
  async activeTask() { return { taskId: this.tasks.at(-1) }; }
  async click(value) { this.calls.push(["click", value.target]); }
  async keypress(value) { this.calls.push(["keypress", value.key]); }
  async scroll(value) { this.calls.push(["scroll", value.direction, value.amount]); }
  async selectMenu(value) { this.calls.push(["select_menu", value.menuPath]); if (this.actionError) throw new Error("fixture action failed"); }
  async typeText(value) { this.borrowedBytes = value.bytes; this.calls.push(["type_text_ref", Buffer.from(value.bytes)]); }
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
    const regions = [{ kind: "conversation", x: 10, y: 10, width: 500, height: 400 }];
    if (!this.missingGeometry) regions.push({ kind: "credential", x: 900, y: 10, width: 100, height: 50 });
    return regions;
  }
  async captureScreenshot({ exclude }) { this.calls.push(["screenshot", exclude]); return Buffer.from("masked graphical fixture"); }
  async health() { return { crashed: this.crash, stalled: this.stalled }; }
}

async function harness(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nelos-sealed-values-"));
  const secret = "benchmark prompt that must never be logged";
  await writeFile(path.join(root, "prompt-one.sealed"), secret, { mode: 0o600 });
  const boundary = new GraphicalFixture(options);
  const driver = new DesktopGuiScenarioDriver({ boundary, sealedValueResolver: new SealedValueResolver({ root }), bindings: desktopGuiBindings });
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

test("fresh Desktop task identities cannot be reused across scenarios", async () => {
  const { driver } = await harness();
  assert.equal((await driver.runScenario(desktopGuiScenario())).outcome, "passed");
  const second = await driver.runScenario(desktopGuiScenario({ scenarioId: "scenario-driver-2" }));
  assert.equal(second.outcome, "failed");
  assert.equal(second.failure.code, "REUSED_TASK_IDENTITY");
});

test("expected task must already exist before Desktop activation", async () => {
  const { boundary, driver } = await harness();
  boundary.tasks = [];
  const result = await driver.runScenario(desktopGuiScenario());
  assert.equal(result.outcome, "failed");
  assert.equal(result.failure.code, "REUSED_TASK_IDENTITY");
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

test("screenshots fail closed without both conversation and credential geometry", async () => {
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
