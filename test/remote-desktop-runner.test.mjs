import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AtomicRemoteDesktopJournal, ResumableRemoteDesktopRunnerV1, preflightRemoteDesktopRunV1 } from "nelos/remote-desktop-runner";
import { currentLeaseFor, validRemoteDesktopRunV1, validRemoteDesktopTerminalOutcomeV1 } from "./fixtures/remote-desktop-contract-v1.mjs";

const zero = () => ({ taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 0, screenshotCount: 0, screenshotBytes: 0, recordingDurationMs: 0, recordingBytes: 0, diagnosticLogCount: 0, diagnosticLogBytes: 0 });

async function fixture({ crashAt = null, guiFailure = false, guiMidflightCrash = false, providerMidflightCrash = null, quarantine = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nelos-desktop-runner-"));
  const run = validRemoteDesktopRunV1();
  run.scenarios = [run.scenarios[0]];
  const scenarioDelta = { ...zero(), taskCount: 1, modelTurnCount: 1, spendUsd: 0.25, wallTimeMs: 120_001 };
  const plan = {
    goldenImageTemplateVmId: "9001",
    reservation: { reservationId: "reservation-9401", ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, state: "reserved" },
    automation: { user: "nelosauto", uid: 2401, home: "/home/nelosauto", stateRoot: `/var/lib/nelos-desktop/runs/${run.runId}`, credentialRefs: [] },
    operationUsage: { provision: { ...zero(), wallTimeMs: 1_000 }, cleanup: { ...zero(), wallTimeMs: 1_000 }, quarantine: { ...zero(), wallTimeMs: 1_000 } },
    scenarioUsage: { [run.scenarios[0].scenarioId]: scenarioDelta },
    evidence: { bundleDirectory: path.join(root, "evidence"), proposedOperationalUsage: { taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 1 }, screenshots: [], recordings: [], diagnostics: [] },
  };
  const calls = { create: 0, destroy: 0, quarantine: 0, reconcile: 0, gui: 0, collect: 0 };
  let present = false;
  let lastCleanup = null;
  let providerCrashThrown = false;
  const destroyed = () => structuredClone(validRemoteDesktopTerminalOutcomeV1(run, "destroyed").receipt);
  const quarantined = () => structuredClone(validRemoteDesktopTerminalOutcomeV1(run, "quarantined").receipt);
  const providerController = {
    async execute({ operation }) {
      calls[operation] += 1;
      if (operation === "create") {
        present = true;
        if (providerMidflightCrash === operation && !providerCrashThrown) { providerCrashThrown = true; throw Object.assign(new Error("injected after create request"), { code: "INJECTED_CRASH" }); }
        return { receiptId: "create-1", ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, mutationStatus: "committed", created: true, qgaReady: true, state: "running" };
      }
      if (operation === "destroy") {
        present = quarantine; lastCleanup = quarantine ? quarantined() : destroyed();
        if (providerMidflightCrash === operation && !providerCrashThrown) { providerCrashThrown = true; throw Object.assign(new Error("injected after destroy request"), { code: "INJECTED_CRASH" }); }
        return structuredClone(lastCleanup);
      }
      lastCleanup = quarantined(); present = true; return structuredClone(lastCleanup);
    },
    async reconcileEffect(effect) {
      calls.reconcile += 1;
      if (effect.kind === "provision") return present ? { receiptId: "create-1", ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, mutationStatus: "committed", created: true, qgaReady: true, state: "running" } : destroyed();
      return structuredClone(lastCleanup ?? (present ? quarantined() : destroyed()));
    },
  };
  let midflightThrown = false;
  const guiDriver = {
    async runScenario(scenario) {
      calls.gui += 1;
      if (guiMidflightCrash && !midflightThrown) { midflightThrown = true; throw Object.assign(new Error("injected inside GUI"), { code: "INJECTED_CRASH" }); }
      const outcome = guiFailure ? "failed" : "passed";
      return {
        scenarioId: scenario.scenarioId, taskId: scenario.task.taskId,
        startedAt: "2026-08-19T12:00:00.000Z", finishedAt: "2026-08-19T12:01:00.000Z", outcome,
        failure: guiFailure ? { code: "ASSERTION_FAILURE" } : null,
        actions: scenario.actions.map((action) => ({ actionId: action.actionId, actionType: action.type, startedAt: "2026-08-19T12:00:00.000Z", finishedAt: "2026-08-19T12:00:01.000Z", outcome: "succeeded" })),
        checkpoints: [], assertions: scenario.assertions.map((item) => ({ assertionId: item.assertionId, passed: !guiFailure, observedRef: guiFailure ? null : item.expectedRef })),
      };
    },
  };
  const evidenceCollector = { async collect() { calls.collect += 1; return { screenshots: [], recordings: [], diagnostics: [] }; } };
  let injected = false;
  const crashInjector = async (checkpoint) => {
    if (!injected && checkpoint === crashAt) { injected = true; throw Object.assign(new Error(`crash ${checkpoint}`), { code: "INJECTED_CRASH" }); }
  };
  const input = { run, plan, candidateDigest: run.candidate.digest, currentLease: currentLeaseFor(run), now: Date.parse("2026-08-19T12:00:00.000Z") };
  const runner = new ResumableRemoteDesktopRunnerV1({ journalDirectory: path.join(root, "journal"), providerController, guiDriver, evidenceCollector, crashInjector });
  return { root, run, plan, input, runner, calls };
}

test("preflight binds the immutable contract and rejects underdeclared scenario operations", async () => {
  const value = await fixture();
  const checked = preflightRemoteDesktopRunV1(value.input);
  assert.match(checked.identityDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(checked.admittedRun.state, "admitted");
  const bad = structuredClone(value.plan); bad.scenarioUsage["scenario-1"].modelTurnCount = 0;
  assert.throws(() => preflightRemoteDesktopRunV1({ ...value.input, plan: bad }), (error) => error.code === "UNDERDECLARED_OPERATION");
});

for (const [checkpoint, expectedState] of [
  ["after:provision", "succeeded"], ["after:gui", "succeeded"], ["after:destroy", "succeeded"],
  ["after:evidence", "succeeded"], ["after:quarantine", "quarantined"],
]) {
  test(`resumes deterministically after ${checkpoint} without duplicate mutations or paid turns`, async () => {
    const value = await fixture({ crashAt: checkpoint, quarantine: checkpoint === "after:quarantine" });
    await assert.rejects(value.runner.start(value.input), (error) => error.code === "INJECTED_CRASH");
    const result = await value.runner.resume(value.input);
    assert.equal(result.run.state, expectedState);
    assert.equal(value.calls.create, 1);
    assert.equal(value.calls.destroy, 1);
    assert.equal(value.calls.gui, 1);
    assert.equal(result.usage.modelTurnCount, 1);
    assert.equal(value.calls.collect, 1);
    assert.ok(result.effects.every(({ status }) => status === "committed"));
  });
}

test("an interrupted in-flight GUI effect is never repeated and still reaches exact cleanup", async () => {
  const value = await fixture({ guiMidflightCrash: true });
  await assert.rejects(value.runner.start(value.input), (error) => error.code === "INJECTED_CRASH");
  const result = await value.runner.resume(value.input);
  assert.equal(result.run.state, "failed");
  assert.equal(result.failure.code, "AMBIGUOUS_GUI_EFFECT");
  assert.equal(value.calls.gui, 1);
  assert.equal(value.calls.destroy, 1);
  assert.equal(result.terminalOutcome.outcome, "destroyed");
});

for (const operation of ["create", "destroy"]) {
  test(`an interrupted in-flight ${operation} request is reconciled and never repeated`, async () => {
    const value = await fixture({ providerMidflightCrash: operation });
    await assert.rejects(value.runner.start(value.input), (error) => error.code === "INJECTED_CRASH");
    const result = await value.runner.resume(value.input);
    assert.equal(result.run.state, "succeeded");
    assert.equal(value.calls[operation], 1);
    assert.equal(value.calls.reconcile, 1);
    assert.equal(value.calls.gui, 1);
  });
}

test("failed and cancelled paths enter cleanup and cannot report success", async () => {
  const failed = await fixture({ guiFailure: true });
  const failedResult = await failed.runner.start(failed.input);
  assert.equal(failedResult.run.state, "failed");
  assert.equal(failed.calls.destroy, 1);
  assert.equal(failedResult.terminalOutcome.outcome, "destroyed");

  const cancelled = await fixture({ crashAt: "after:provision" });
  await assert.rejects(cancelled.runner.start(cancelled.input), (error) => error.code === "INJECTED_CRASH");
  const cancelledResult = await cancelled.runner.cancel(cancelled.input);
  assert.equal(cancelledResult.run.state, "failed");
  assert.equal(cancelledResult.failure.code, "CANCELLED");
  assert.equal(cancelled.calls.gui, 0);
  assert.equal(cancelled.calls.destroy, 1);
});

test("journal is atomic, content-addressed, and rejects identity-mismatched resume", async () => {
  const value = await fixture();
  const result = await value.runner.start(value.input);
  const pointer = JSON.parse(await readFile(path.join(value.root, "journal", "CURRENT"), "utf8"));
  assert.equal(pointer.generation, result.generation);
  assert.match(pointer.digest, /^sha256:[0-9a-f]{64}$/u);
  const entry = await readFile(path.join(value.root, "journal", "entries", `${pointer.digest.slice(7)}.json`), "utf8");
  assert.equal(JSON.parse(entry).run.state, "succeeded");
  const mismatched = structuredClone(value.run); mismatched.candidate.digest = `sha256:${"f".repeat(64)}`;
  await assert.rejects(value.runner.resume({ run: mismatched, plan: value.plan }), (error) => error.code === "RESUME_IDENTITY_MISMATCH");
  assert.equal((await new AtomicRemoteDesktopJournal(path.join(value.root, "journal")).load()).run.state, "succeeded");
});
