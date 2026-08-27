import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDesktopSmokeEvidenceBundleV1, DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 } from "nelos/desktop-smoke-evidence-contract";
import { DesktopSmokeError } from "nelos/disposable-desktop-smoke";
import { createFreshVmPublicBundleV1, runFreshVmDesktopWorkflowsV1, validateFreshVmPublicBundleV1 } from "nelos/fresh-vm-desktop-runner";
import { desktopGuiScenario } from "./fixtures/desktop-gui-driver-scenarios.mjs";

const identity = Object.freeze({ version: "0.12.20", digest: `sha256:${"a".repeat(64)}`, sourceRevision: "b".repeat(40) });
const runId = "run-e2e-1";

function evidence(scenarioIds = ["scenario-driver-1"], outcome = "passed") {
  return createDesktopSmokeEvidenceBundleV1({
    run: {
      schemaVersion: 1, runId, scenarioSetId: "release", candidate: identity,
      startedAt: "2026-08-27T12:00:00.000Z", finishedAt: "2026-08-27T12:00:01.000Z",
      outcome, scenarioIds: [...scenarioIds].sort(), diagnosticLimits: { ...DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 },
    },
    checkpoints: [], artifacts: [], assertionResults: [], diagnostics: [], files: [],
  }).bytes;
}

async function fixture(t, { scenarioCount = 2, overrides = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nelos-fresh-vm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scenarios = Array.from({ length: scenarioCount }, (_, index) => {
    const scenario = desktopGuiScenario();
    scenario.scenarioId = `scenario-${index + 1}`;
    scenario.task.taskId = `task-${index + 1}`;
    scenario.task.createdForScenario = scenario.scenarioId;
    return scenario;
  });
  const calls = [];
  const clone = { cloneId: `clone-${runId}`, templateRef: "maintained-clean-v7", accountId: `account-${runId}`, guestCodexHome: `/var/lib/nelos/${runId}/.codex`, runId, fresh: true, templateMaintained: true, templateClean: true };
  const adapter = {
    async cloneTemplate(payload) { calls.push(["clone", payload.operationId]); return clone; },
    async installCandidate(payload) { calls.push(["install", payload.operationId]); return { identity, digestVerified: true, exclusive: true }; },
    async readLoadedIdentity(payload) { calls.push(["identity", payload.operationId]); return identity; },
    async executeScenario(payload) {
      calls.push(["scenario", payload.operationId]);
      return {
        scenarioId: payload.scenario.scenarioId, operationId: payload.operationId, outcome: "passed", failure: null,
        assertionResults: [], actionReceipts: payload.scenario.actions.map(({ actionId }) => ({ actionId, outcome: "completed", attempts: 1, submissionState: "not_applicable" })),
      };
    },
    async packageEvidence(payload) { calls.push(["package", payload.operationId]); return { runId, bundle: evidence(scenarios.map(({ scenarioId }) => scenarioId)), sanitized: true, rawCapturesRemoved: true, temporaryMaterialRemoved: true }; },
    async destroyClone(payload) { calls.push(["destroy", payload.operationId]); return { cloneId: clone.cloneId, destroyed: true }; },
    async verifyAbsent(payload) { calls.push(["absent", payload.operationId]); return { cloneId: clone.cloneId, absent: true, independent: true }; },
    ...overrides,
  };
  return { root, scenarios, calls, clone, adapter };
}

async function run(state, options = {}) {
  return runFreshVmDesktopWorkflowsV1({
    runId, candidate: { ...identity, packagePath: state.root }, scenarioSet: { schemaVersion: 1, scenarioSetId: "release", scenarios: state.scenarios },
    adapter: state.adapter, controllerCodexHome: "/controller/.codex", ...options,
  });
}

test("fresh VM runner executes a multi-scenario library, packages canonical evidence, and independently proves absence", async (t) => {
  const state = await fixture(t);
  const result = await run(state);
  assert.equal(result.outcome, "passed");
  assert.deepEqual(result.scenarios.map(({ scenarioId }) => scenarioId), ["scenario-1", "scenario-2"]);
  assert.deepEqual(state.calls.slice(-2).map(([name]) => name), ["destroy", "absent"]);
  assert.equal(result.cleanup.independentlyVerified, true);
  const first = createFreshVmPublicBundleV1(result);
  const second = createFreshVmPublicBundleV1(result);
  assert.deepEqual(first, second);
  assert.equal(validateFreshVmPublicBundleV1(first).manifest.runId, runId);
  assert.deepEqual(JSON.parse(first).manifest.entries.map(({ relativePath }) => relativePath), ["evidence/desktop-smoke-v1.json", "receipts/run.json"]);
});

test("partial failure and crash outcomes remain packaged and cleanup-proven", async (t) => {
  let invocation = 0;
  const state = await fixture(t, { overrides: {
    async executeScenario(payload) {
      invocation += 1;
      return { scenarioId: payload.scenario.scenarioId, operationId: payload.operationId, outcome: invocation === 1 ? "failed" : "crashed", failure: { code: invocation === 1 ? "ASSERTION_FAILURE" : "DESKTOP_CRASH" }, assertionResults: [], actionReceipts: payload.scenario.actions.map(({ actionId }) => ({ actionId, outcome: "failed", attempts: 1, submissionState: "not_applicable" })) };
    },
    async packageEvidence() { return { runId, bundle: evidence(["scenario-1", "scenario-2"], "failed"), sanitized: true, rawCapturesRemoved: true, temporaryMaterialRemoved: true }; },
  } });
  const result = await run(state);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.scenarios.map(({ outcome }) => outcome), ["failed", "crashed"]);
  assert.ok(result.bundle);
  assert.equal(result.cleanup.absent, true);
});

test("timeouts return bounded diagnostics while cleanup still runs", async (t) => {
  const state = await fixture(t, { overrides: { async installCandidate() { return new Promise(() => {}); } } });
  const deadlines = { runMs: 100, installMs: 10, identityMs: 10, scenarioMs: 50, actionMs: 10, evidenceMs: 10, destroyMs: 10, absenceMs: 10 };
  const result = await run(state, { deadlines });
  assert.deepEqual(result.diagnostic, { code: "FRESH_VM_DEADLINE_EXCEEDED", stage: "install" });
  assert.deepEqual(state.calls.slice(-2).map(([name]) => name), ["destroy", "absent"]);
});

test("malformed driver data and bundle verification failure become diagnostic results", async (t) => {
  const malformed = await fixture(t, { scenarioCount: 1, overrides: { async executeScenario() { return { outcome: "passed" }; } } });
  assert.equal((await run(malformed)).diagnostic.code, "INVALID_FRESH_VM_RECEIPT");

  const invalidBundle = await fixture(t, { scenarioCount: 1, overrides: { async packageEvidence() { return { runId, bundle: Buffer.from("{}"), sanitized: true, rawCapturesRemoved: true, temporaryMaterialRemoved: true }; } } });
  assert.equal((await run(invalidBundle)).diagnostic.code, "INVALID_EVIDENCE_CONTRACT");
});

test("lost scenario operations are never retried ambiguously", async (t) => {
  let attempts = 0;
  const state = await fixture(t, { scenarioCount: 1, overrides: {
    async executeScenario() { attempts += 1; throw new DesktopSmokeError("OPERATION_LOST", "lost after dispatch", { retryDisposition: "ambiguous_after_dispatch" }); },
  } });
  const result = await run(state, { retries: 2 });
  assert.equal(attempts, 1);
  assert.equal(result.diagnostic.code, "OPERATION_LOST");
  assert.equal(result.cleanup.absent, true);
});

test("safe pre-dispatch retries reuse one operation identity", async (t) => {
  let attempts = 0;
  const operationIds = [];
  const state = await fixture(t, { scenarioCount: 1, overrides: {
    async installCandidate(payload) {
      attempts += 1; operationIds.push(payload.operationId);
      if (attempts === 1) throw new DesktopSmokeError("DRIVER_NOT_STARTED", "safe", { retryDisposition: "safe_before_dispatch" });
      return { identity, digestVerified: true, exclusive: true };
    },
  } });
  assert.equal((await run(state)).outcome, "passed");
  assert.equal(attempts, 2);
  assert.equal(new Set(operationIds).size, 1);
});

test("unsafe packaging attestations and oversized public adapter material fail closed", async (t) => {
  const unsafe = await fixture(t, { scenarioCount: 1, overrides: { async packageEvidence() { return { runId, bundle: evidence(["scenario-1"]), sanitized: true, rawCapturesRemoved: false, temporaryMaterialRemoved: true }; } } });
  assert.equal((await run(unsafe)).diagnostic.code, "UNSAFE_FRESH_VM_EVIDENCE");
  const oversized = await fixture(t, { scenarioCount: 1, overrides: { async packageEvidence() { return { runId, bundle: Buffer.alloc(24 * 1024 * 1024 + 1), sanitized: true, rawCapturesRemoved: true, temporaryMaterialRemoved: true }; } } });
  assert.equal((await run(oversized)).diagnostic.code, "OVERSIZED_FRESH_VM_OUTPUT");
  const result = await run(await fixture(t, { scenarioCount: 1 }));
  const altered = JSON.parse(createFreshVmPublicBundleV1(result));
  altered.entries[0].data += "AAAA";
  assert.throws(() => validateFreshVmPublicBundleV1(Buffer.from(JSON.stringify(altered))), /canonical|digest|match/iu);
});

test("uncertain destruction or independently unproven absence dominates earlier failures", async (t) => {
  const state = await fixture(t, { scenarioCount: 1, overrides: {
    async executeScenario() { throw new DesktopSmokeError("DESKTOP_CRASH", "crashed"); },
    async verifyAbsent(payload) { return { cloneId: payload.clone.cloneId, absent: true, independent: false }; },
  } });
  await assert.rejects(run(state), (error) => error.code === "CLEANUP_NOT_PROVEN" && error.details.primaryCode === "DESKTOP_CRASH");
});
