import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DesktopSmokeError, runDisposableDesktopSmokeV1 } from "nelos/disposable-desktop-smoke";
import { desktopGuiScenario } from "./fixtures/desktop-gui-driver-scenarios.mjs";

const identity = Object.freeze({
  version: "0.12.20",
  digest: `sha256:${"a".repeat(64)}`,
  sourceRevision: "b".repeat(40),
});

async function harness(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "nelos-smoke-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const clone = { cloneId: "clone-1", templateRef: "maintained-desktop", accountId: "smoke-user", guestCodexHome: "/home/smoke/.codex" };
  const adapter = {
    async cloneTemplate() { calls.push("clone"); return clone; },
    async installCandidate() { calls.push("install"); return identity; },
    async launchDesktop() { calls.push("launch"); return { launched: true }; },
    async readLoadedIdentity() { calls.push("identity"); return identity; },
    async runScenario({ scenario }) { calls.push(`scenario:${scenario.scenarioId}`); return { scenarioId: scenario.scenarioId, outcome: "passed", failure: null, ignoredInternalDetail: "discarded" }; },
    async collectEvidence() { calls.push("evidence"); return { screenshots: [{ scenarioId: "scenario-driver-1", digest: `sha256:${"c".repeat(64)}`, byteLength: 100, mediaType: "image/png", sanitized: true }], diagnostics: [{ scenarioId: "scenario-driver-1", digest: `sha256:${"d".repeat(64)}`, byteLength: 20, code: "clean", sanitized: true }] }; },
    async destroyClone() { calls.push("destroy"); return { cloneId: clone.cloneId, destroyed: true }; },
    async verifyAbsent() { calls.push("absent"); return { cloneId: clone.cloneId, absent: true }; },
    ...overrides,
  };
  return { root, calls, adapter };
}

test("smoke lane verifies exact loaded identity, reports bounded evidence, and proves clone absence", async (t) => {
  const { root, calls, adapter } = await harness(t);
  const result = await runDisposableDesktopSmokeV1({
    candidate: { ...identity, packagePath: root },
    scenarioSet: { schemaVersion: 1, scenarioSetId: "release", scenarios: [desktopGuiScenario()] },
    adapter,
    controllerCodexHome: "/controller/.codex",
  });
  assert.equal(result.outcome, "passed");
  assert.deepEqual(result.summary, { total: 1, passed: 1, failed: 0 });
  assert.deepEqual(result.results, [{ scenarioId: "scenario-driver-1", outcome: "passed", failure: null }]);
  assert.deepEqual(result.cleanup, { cloneId: "clone-1", destroyed: true, absent: true });
  assert.deepEqual(calls.slice(-2), ["destroy", "absent"]);
});

test("identity mismatch still destroys the clone and independently verifies absence", async (t) => {
  const { root, calls, adapter } = await harness(t, { async readLoadedIdentity() { calls.push("identity"); return { ...identity, version: "0.12.19" }; } });
  await assert.rejects(runDisposableDesktopSmokeV1({
    candidate: { ...identity, packagePath: root },
    scenarioSet: { schemaVersion: 1, scenarioSetId: "release", scenarios: [desktopGuiScenario()] },
    adapter,
    controllerCodexHome: "/controller/.codex",
  }), (error) => error instanceof DesktopSmokeError && error.code === "CANDIDATE_IDENTITY_MISMATCH");
  assert.deepEqual(calls.slice(-2), ["destroy", "absent"]);
});

test("ambiguous absence overrides a scenario failure and fails closed", async (t) => {
  const { root, adapter } = await harness(t, {
    async runScenario({ scenario }) { return { scenarioId: scenario.scenarioId, outcome: "failed", failure: { code: "ASSERTION_FAILURE" } }; },
    async verifyAbsent() { return { cloneId: "clone-1", absent: false }; },
  });
  await assert.rejects(runDisposableDesktopSmokeV1({
    candidate: { ...identity, packagePath: root },
    scenarioSet: { schemaVersion: 1, scenarioSetId: "release", scenarios: [desktopGuiScenario()] },
    adapter,
    controllerCodexHome: "/controller/.codex",
  }), (error) => error.code === "CLEANUP_NOT_PROVEN");
});

test("clone CODEX_HOME cannot be nested under the controller home", async (t) => {
  const { root, calls, adapter } = await harness(t, {
    async cloneTemplate() {
      calls.push("clone");
      return { cloneId: "clone-1", templateRef: "maintained-desktop", accountId: "smoke-user", guestCodexHome: "/controller/.codex/guest" };
    },
  });
  await assert.rejects(runDisposableDesktopSmokeV1({
    candidate: { ...identity, packagePath: root },
    scenarioSet: { schemaVersion: 1, scenarioSetId: "release", scenarios: [desktopGuiScenario()] },
    adapter,
    controllerCodexHome: "/controller/.codex",
  }), (error) => error.code === "INVALID_CLONE_ISOLATION");
  assert.deepEqual(calls.slice(-2), ["destroy", "absent"]);
});

test("absence is still checked when destruction reports an error", async (t) => {
  const { root, calls, adapter } = await harness(t, {
    async destroyClone() { calls.push("destroy"); throw Object.assign(new Error("failed"), { code: "DESTROY_FAILED" }); },
  });
  await assert.rejects(runDisposableDesktopSmokeV1({
    candidate: { ...identity, packagePath: root },
    scenarioSet: { schemaVersion: 1, scenarioSetId: "release", scenarios: [desktopGuiScenario()] },
    adapter,
    controllerCodexHome: "/controller/.codex",
  }), (error) => error.code === "CLEANUP_NOT_PROVEN" && error.details.destroyCode === "DESTROY_FAILED");
  assert.deepEqual(calls.slice(-2), ["destroy", "absent"]);
});
