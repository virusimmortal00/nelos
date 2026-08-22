import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AtomicRemoteDesktopJournal, ResumableRemoteDesktopRunnerV1, contentDigest, preflightRemoteDesktopRunV1 } from "nelos/remote-desktop-runner";
import { ArchiveProjectionLaneV1 } from "nelos/archive-projection-lane";
import { currentLeaseFor, validRemoteDesktopRunV1, validRemoteDesktopTerminalOutcomeV1 } from "./fixtures/remote-desktop-contract-v1.mjs";

const zero = () => ({ taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 0, screenshotCount: 0, screenshotBytes: 0, recordingDurationMs: 0, recordingBytes: 0, diagnosticLogCount: 0, diagnosticLogBytes: 0 });
const fakeLeaseAuthorityAdmission = () => ({
  binding: {
    authorityId: "pve-1-desktop-authority-v1",
    epoch: 1,
    issuedRecordDigest: `sha256:${"5".repeat(64)}`,
    issuedRecordFileDigest: `sha256:${"6".repeat(64)}`,
    issuedRevision: 1,
    trustDigest: `sha256:${"7".repeat(64)}`,
  },
  issuedObservationDigest: `sha256:${"8".repeat(64)}`,
});

function runCli(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [path.resolve("bin/nelos-desktop-runner"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function fixture({ crashAt = null, guiFailure = false, guiMidflightCrash = false, providerMidflightCrash = null, quarantine = false, projectionStale = false, archiveMidflightCrash = false, productionAdmission = null, initialReservationObservation = null, runtimeClock = null, afterCreate = null, afterGui = null } = {}) {
  if (productionAdmission !== null && productionAdmission.leaseAuthority === undefined) productionAdmission.leaseAuthority = fakeLeaseAuthorityAdmission();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nelos-desktop-runner-")));
  const run = validRemoteDesktopRunV1();
  run.scenarios = [run.scenarios[0]];
  const scenarioDelta = { ...zero(), taskCount: 1, modelTurnCount: 1, spendUsd: 0.25, wallTimeMs: 120_001 };
  const plan = {
    goldenImageTemplateVmId: "9001",
    reservation: { reservationId: "reservation-9401", ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, state: "reserved" },
    automation: { user: "nelosauto", uid: 2401, home: "/home/nelosauto", stateRoot: `/var/lib/nelos-desktop/runs/${run.runId}`, credentialRefs: [] },
    operationUsage: { provision: { ...zero(), wallTimeMs: 1_000 }, cleanup: { ...zero(), wallTimeMs: 1_000 }, quarantine: { ...zero(), wallTimeMs: 1_000 } },
    scenarioUsage: { [run.scenarios[0].scenarioId]: scenarioDelta },
    archiveConvergence: {
      policy: { maxConvergenceMs: 30_000, requireArchiveReceipts: true, requireRestartCheckpoint: true, requiredConsecutiveAbsent: 2 },
      operationUsage: { ...zero(), wallTimeMs: 30_000, screenshotCount: 2, screenshotBytes: 2_048 },
    },
    evidence: { bundleDirectory: path.join(root, "evidence"), proposedOperationalUsage: { taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 1 }, screenshots: [], recordings: [], diagnostics: [] },
  };
  const calls = { create: 0, destroy: 0, quarantine: 0, reconcile: 0, gui: 0, sealedCleanup: 0, archiveConvergence: 0, archiveReconcile: 0, restart: 0, collect: 0 };
  const events = [];
  let present = false;
  let lastCleanup = null;
  let providerCrashThrown = false;
  const destroyed = () => structuredClone(validRemoteDesktopTerminalOutcomeV1(run, "destroyed").receipt);
  const quarantined = () => structuredClone(validRemoteDesktopTerminalOutcomeV1(run, "quarantined").receipt);
  const providerController = {
    async execute({ operation }) {
      events.push(`provider:${operation}`);
      calls[operation] += 1;
      if (operation === "create") {
        present = true;
        if (afterCreate) await afterCreate();
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
      const result = {
        scenarioId: scenario.scenarioId, taskId: scenario.task.taskId,
        startedAt: "2026-08-19T12:00:00.000Z", finishedAt: "2026-08-19T12:01:00.000Z", outcome,
        failure: guiFailure ? { code: "ASSERTION_FAILURE" } : null,
        actions: scenario.actions.map((action) => ({ actionId: action.actionId, actionType: action.type, startedAt: "2026-08-19T12:00:00.000Z", finishedAt: "2026-08-19T12:00:01.000Z", outcome: "succeeded" })),
        checkpoints: [], assertions: scenario.assertions.map((item) => ({ assertionId: item.assertionId, passed: !guiFailure, observedRef: guiFailure ? null : item.expectedRef })),
      };
      if (afterGui) await afterGui();
      return result;
    },
    async cleanupSealedValues(valueRefs) {
      calls.sealedCleanup += 1; events.push("sealed-values:absent");
      const declaredValueRefs = [...valueRefs].sort();
      return { schemaVersion: 1, kind: "sealed-value-absence", declaredValueRefs, removedValueRefs: [], alreadyAbsentValueRefs: declaredValueRefs, remainingValueRefs: [] };
    },
  };
  const evidenceCollector = { async collect() { calls.collect += 1; events.push("evidence:collect"); return { screenshots: [], recordings: [], diagnostics: [] }; } };
  const visualPath = path.join(root, "visual-report.json");
  const visualBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: "nelos-developer-visual-state-validation", capture: { digest: `sha256:${"a".repeat(64)}` }, outcome: projectionStale ? "failed" : "passed", counts: {}, findings: [] })}\n`);
  await writeFile(visualPath, visualBytes);
  const visualReport = { path: visualPath, digest: `sha256:${createHash("sha256").update(visualBytes).digest("hex")}` };
  const archivedIds = run.scenarios.map(({ task }) => task.taskId);
  const projectionAdapter = {
    async archiveTasks({ expectedThreads }) {
      return expectedThreads.map(({ threadId }, index) => ({ schemaVersion: 1, type: "native-archive", actionId: `archive-${index + 1}`, threadId, archived: true }));
    },
    async observeCheckpoint({ sequence, phase, expectedAppInstanceId }) {
      const appInstanceId = phase === "afterRestart" ? "desktop-app-2" : "desktop-app-1";
      assert.equal(expectedAppInstanceId ?? appInstanceId, appInstanceId);
      return {
        sequence, observedAt: `2026-08-19T12:01:${sequence}0.000Z`, phase, appInstanceId, cleanupState: "complete",
        nelosWorkers: [{ workerId: "worker-a", archivedThreadIds: archivedIds }], ordinaryMapThreadIds: [],
        nativeVisibleThreadIds: projectionStale ? [archivedIds[0]] : [],
        visualEvidence: { report: visualReport, sidebarThreadIds: projectionStale ? [archivedIds[0]] : [], createdTasksThreadIds: [], mcpVisualThreadIds: [] },
      };
    },
    async restartDesktop({ previousAppInstanceId }) {
      calls.restart += 1;
      return { schemaVersion: 1, type: "desktop-restart", previousAppInstanceId, newAppInstanceId: "desktop-app-2", restarted: true };
    },
    async reconcileEffect() {
      throw new Error("adapter reconciliation is wrapped below");
    },
  };
  const projectionLane = new ArchiveProjectionLaneV1({ adapter: projectionAdapter, clock: { now: () => Date.parse("2026-08-19T12:01:00.000Z") } });
  let lastProjectionReceipt = null;
  let archiveCrashThrown = false;
  const archiveProjectionController = {
    async execute(request) {
      calls.archiveConvergence += 1;
      lastProjectionReceipt = await projectionLane.execute(request);
      if (archiveMidflightCrash && !archiveCrashThrown) { archiveCrashThrown = true; throw Object.assign(new Error("injected after convergence sequence"), { code: "INJECTED_CRASH" }); }
      return structuredClone(lastProjectionReceipt);
    },
    async reconcileEffect() {
      calls.archiveReconcile += 1;
      if (!lastProjectionReceipt) throw new Error("archive convergence outcome is unavailable");
      return structuredClone(lastProjectionReceipt);
    },
  };
  let injected = false;
  const crashInjector = async (checkpoint) => {
    if (!injected && checkpoint === crashAt) { injected = true; throw Object.assign(new Error(`crash ${checkpoint}`), { code: "INJECTED_CRASH" }); }
  };
  const input = { run, plan, candidateDigest: run.candidate.digest, currentLease: currentLeaseFor(run), now: Date.parse("2026-08-19T12:00:00.000Z") };
  const productionGuard = productionAdmission === null ? null : {
    admission: productionAdmission,
    initialReservationObservation,
    async prepareBeforeDestroy() { throw new Error("not reached before injected crash"); },
    async verifyBeforeDestroy() { throw new Error("not reached before injected crash"); },
    async attestAfterDestroy() { throw new Error("not reached before injected crash"); },
    async attestFinalEvidence() { throw new Error("not reached before injected crash"); },
  };
  const taskPreparer = productionAdmission === null ? null : {
    intentDigest: `sha256:${"8".repeat(64)}`,
    async execute() { return { schemaVersion: 1, taskId: run.scenarios[0].task.taskId, initialTurnStarted: false }; },
    async reconcileEffect() { return { schemaVersion: 1, taskId: run.scenarios[0].task.taskId, initialTurnStarted: false }; },
    materialize(value) { return structuredClone(value); },
  };
  const runner = new ResumableRemoteDesktopRunnerV1({ journalDirectory: path.join(root, "journal"), providerController, guiDriver, archiveProjectionController, evidenceCollector, productionGuard, taskPreparer, crashInjector, clock: runtimeClock ?? { now: () => Date.parse("2026-08-19T12:01:00.000Z") } });
  return { root, run, plan, input, runner, calls, events, productionGuard };
}

function reservationAbsence(run, observedAt) {
  const unsigned = {
    schemaVersion: 1,
    type: "independent-pre-mutation-vm-observation",
    binding: { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken },
    state: "absent",
    observedAt: new Date(observedAt).toISOString(),
  };
  return { ...unsigned, observationDigest: contentDigest(unsigned) };
}

test("preflight binds the immutable contract and rejects underdeclared scenario operations", async () => {
  const value = await fixture();
  const checked = preflightRemoteDesktopRunV1(value.input);
  assert.match(checked.identityDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(checked.admittedRun.state, "admitted");
  const bad = structuredClone(value.plan); bad.scenarioUsage["scenario-1"].modelTurnCount = 0;
  assert.throws(() => preflightRemoteDesktopRunV1({ ...value.input, plan: bad }), (error) => error.code === "UNDERDECLARED_OPERATION");
  const noRestart = structuredClone(value.plan); noRestart.archiveConvergence.policy.requireRestartCheckpoint = false;
  assert.throws(() => preflightRemoteDesktopRunV1({ ...value.input, plan: noRestart }), (error) => error.code === "INVALID_ARCHIVE_CONVERGENCE_POLICY");
  const oneCapture = structuredClone(value.plan); oneCapture.archiveConvergence.operationUsage.screenshotCount = 1;
  assert.throws(() => preflightRemoteDesktopRunV1({ ...value.input, plan: oneCapture }), (error) => error.code === "UNDERDECLARED_OPERATION");
  const duplicateOneShot = structuredClone(value.run);
  duplicateOneShot.scenarios[0].actions.push({ actionId: "action-duplicate-ref", type: "type_text_ref", targetRef: "task-composer", valueRef: duplicateOneShot.scenarios[0].actions[0].valueRef, timeoutMs: 1_000 });
  assert.throws(() => preflightRemoteDesktopRunV1({ ...value.input, run: duplicateOneShot }), (error) => error.code === "INVALID_RUNNER_INPUT");
});

for (const [checkpoint, expectedState] of [
  ["after:provision", "succeeded"], ["after:gui", "succeeded"], ["after:evidence-collection", "succeeded"], ["after:destroy", "succeeded"],
  ["after:archive-convergence", "succeeded"], ["after:evidence", "succeeded"], ["after:quarantine", "quarantined"],
]) {
  test(`resumes deterministically after ${checkpoint} without duplicate mutations or paid turns`, async () => {
    const value = await fixture({ crashAt: checkpoint, quarantine: checkpoint === "after:quarantine" });
    await assert.rejects(value.runner.start(value.input), (error) => error.code === "INJECTED_CRASH");
    const result = await value.runner.resume(value.input);
    assert.equal(result.run.state, expectedState, JSON.stringify({ failure: result.failure, archiveConvergence: result.archiveConvergence, effects: result.effects }, null, 2));
    assert.equal(value.calls.create, 1);
    assert.equal(value.calls.destroy, 1);
    assert.equal(value.calls.gui, 1);
    assert.equal(value.calls.archiveConvergence, 1);
    assert.equal(value.calls.restart, 1);
    assert.equal(result.usage.modelTurnCount, 1);
    assert.equal(value.calls.collect, 1);
    assert.ok(value.events.indexOf("evidence:collect") < value.events.indexOf("provider:destroy"));
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

test("stale archive projections fail the product lane before exact VM destruction", async () => {
  const value = await fixture({ projectionStale: true });
  const result = await value.runner.start(value.input);
  assert.equal(result.run.state, "failed");
  assert.equal(result.failure.code, "ARCHIVE_PROJECTION_STALE");
  assert.equal(result.archiveConvergence.outcome, "failed");
  assert.ok(result.archiveConvergence.report.findings.some(({ code }) => code === "SIDEBAR_ARCHIVE_PROJECTION_STALE"));
  assert.equal(value.calls.destroy, 1);
  assert.equal(result.terminalOutcome.outcome, "destroyed");
});

test("an interrupted convergence sequence is reconciled and never replayed", async () => {
  const value = await fixture({ archiveMidflightCrash: true });
  await assert.rejects(value.runner.start(value.input), (error) => error.code === "INJECTED_CRASH");
  const result = await value.runner.resume(value.input);
  assert.equal(result.run.state, "succeeded");
  assert.equal(value.calls.archiveConvergence, 1);
  assert.equal(value.calls.archiveReconcile, 1);
  assert.equal(value.calls.restart, 1);
  assert.equal(result.archiveConvergence.outcome, "passed");
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

test("content-addressed production verification is part of the immutable identity and atomic journal", async () => {
  const productionAdmission = {
    packetDigest: `sha256:${"1".repeat(64)}`,
    gateReceiptDigest: `sha256:${"2".repeat(64)}`,
    configDigest: `sha256:${"3".repeat(64)}`,
    runDeadlineAt: "2098-12-31T23:59:00.000Z",
    verificationReceiptDigest: `sha256:${"4".repeat(64)}`,
    verificationReceipt: { schemaVersion: 1, type: "nelos-production-admission-verification", receiptDigest: `sha256:${"4".repeat(64)}` },
  };
  const value = await fixture({ crashAt: "after:provision", productionAdmission });
  await assert.rejects(value.runner.start(value.input), (error) => error.code === "INJECTED_CRASH");
  const journaled = await new AtomicRemoteDesktopJournal(path.join(value.root, "journal")).load();
  assert.deepEqual(journaled.productionAdmission, productionAdmission);

  const changed = structuredClone(productionAdmission);
  changed.verificationReceiptDigest = `sha256:${"5".repeat(64)}`;
  const originalIdentity = preflightRemoteDesktopRunV1({ ...value.input, productionAdmission }).identityDigest;
  const changedIdentity = preflightRemoteDesktopRunV1({ ...value.input, productionAdmission: changed }).identityDigest;
  assert.notEqual(originalIdentity, changedIdentity);
});

test("expired production deadline aborts an independently absent reservation before any mutation or paid work", async () => {
  const startedAt = Date.parse("2026-08-19T12:00:00.000Z");
  let now = startedAt + 61_000;
  const productionAdmission = {
    packetDigest: `sha256:${"1".repeat(64)}`, gateReceiptDigest: `sha256:${"2".repeat(64)}`,
    configDigest: `sha256:${"3".repeat(64)}`, runDeadlineAt: new Date(startedAt + 60_000).toISOString(),
    verificationReceiptDigest: `sha256:${"4".repeat(64)}`,
  };
  const value = await fixture({ productionAdmission, runtimeClock: { now: () => now } });
  value.productionGuard.initialReservationObservation = reservationAbsence(value.run, now);
  const result = await value.runner.start(value.input);
  assert.equal(result.run.state, "failed");
  assert.equal(result.failure.code, "RUN_DEADLINE_EXPIRED");
  assert.equal(result.preProvisionAbort.reason, "RUN_DEADLINE_EXPIRED");
  assert.equal(result.preProvisionAbort.reservationObservation.state, "absent");
  assert.ok(result.sealedValueCleanup);
  assert.equal(value.calls.sealedCleanup, 1);
  assert.equal(result.terminalOutcome, null);
  assert.deepEqual({ create: value.calls.create, destroy: value.calls.destroy, quarantine: value.calls.quarantine, gui: value.calls.gui, archive: value.calls.archiveConvergence, collect: value.calls.collect },
    { create: 0, destroy: 0, quarantine: 0, gui: 0, archive: 0, collect: 0 });
});

test("cancel after the consumed gate but before provision terminates on independent absence without cleanup mutation", async () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");
  const productionAdmission = {
    packetDigest: `sha256:${"1".repeat(64)}`, gateReceiptDigest: `sha256:${"2".repeat(64)}`,
    configDigest: `sha256:${"3".repeat(64)}`, runDeadlineAt: new Date(now + 60_000).toISOString(),
    verificationReceiptDigest: `sha256:${"4".repeat(64)}`,
  };
  const value = await fixture({ crashAt: "after:journal-initialize", productionAdmission, runtimeClock: { now: () => now } });
  value.productionGuard.initialReservationObservation = reservationAbsence(value.run, now);
  await assert.rejects(value.runner.start(value.input), (error) => error.code === "INJECTED_CRASH");
  const observationDigest = `sha256:${"9".repeat(64)}`;
  Object.assign(productionAdmission, {
    currentLeaseObservation: { observationDigest }, currentLeaseObservationDigest: observationDigest, recoveryMode: "cleanup-only",
  });
  const result = await value.runner.cancel(value.input);
  assert.equal(result.run.state, "failed");
  assert.equal(result.failure.code, "CANCELLED");
  assert.equal(result.preProvisionAbort.reason, "CANCELLED");
  assert.equal(result.effects.length, 0);
  assert.ok(result.sealedValueCleanup);
  assert.equal(value.calls.sealedCleanup, 1);
  assert.deepEqual({ create: value.calls.create, destroy: value.calls.destroy, quarantine: value.calls.quarantine, gui: value.calls.gui, archive: value.calls.archiveConvergence, collect: value.calls.collect },
    { create: 0, destroy: 0, quarantine: 0, gui: 0, archive: 0, collect: 0 });
});

for (const phase of ["before-gui", "before-archive"]) {
  test(`fake clock enforces the production deadline ${phase} and cleanup-only resume never duplicates paid work or mutation`, async () => {
    const startedAt = Date.parse("2026-08-19T12:00:00.000Z");
    let now = startedAt;
    const productionAdmission = {
      packetDigest: `sha256:${"1".repeat(64)}`, gateReceiptDigest: `sha256:${"2".repeat(64)}`,
      configDigest: `sha256:${"3".repeat(64)}`, runDeadlineAt: new Date(startedAt + 5_000).toISOString(),
      verificationReceiptDigest: `sha256:${"4".repeat(64)}`,
    };
    const value = await fixture({
      productionAdmission,
      runtimeClock: { now: () => now },
      ...(phase === "before-gui" ? { afterCreate: async () => { now = startedAt + 6_000; } } : { afterGui: async () => { now = startedAt + 6_000; } }),
    });
    const result = await value.runner.start(value.input);
    assert.equal(result.run.state, "quarantined");
    assert.equal(result.failure.code, "RUN_DEADLINE_EXPIRED");
    assert.equal(value.calls.create, 1);
    assert.equal(value.calls.gui, phase === "before-gui" ? 0 : 1);
    assert.equal(value.calls.archiveConvergence, 0);
    assert.equal(value.calls.collect, 0);
    assert.equal(value.calls.sealedCleanup, 1);
    assert.equal(value.calls.destroy, 0);
    assert.equal(value.calls.quarantine, 1);

    const observationDigest = `sha256:${"9".repeat(64)}`;
    Object.assign(productionAdmission, {
      currentLeaseObservation: { observationDigest }, currentLeaseObservationDigest: observationDigest, recoveryMode: "cleanup-only",
    });
    const resumed = await value.runner.resume(value.input);
    assert.equal(resumed.run.state, "quarantined");
    assert.equal(value.calls.create, 1);
    assert.equal(value.calls.gui, phase === "before-gui" ? 0 : 1);
    assert.equal(value.calls.quarantine, 1);
    assert.equal(value.calls.sealedCleanup, 1);
  });
}

test("fresh CLI processes recover more than 30 seconds after packet observation and perform cleanup only once after runDeadline", async () => {
  const startedAt = Date.parse("2026-08-19T12:00:00.000Z");
  const deadlineAt = new Date(startedAt + 20_000).toISOString();
  const admission = {
    packetDigest: `sha256:${"1".repeat(64)}`, gateReceiptDigest: `sha256:${"2".repeat(64)}`,
    configDigest: `sha256:${"3".repeat(64)}`, runDeadlineAt: deadlineAt,
    verificationReceiptDigest: `sha256:${"4".repeat(64)}`,
    leaseAuthority: fakeLeaseAuthorityAdmission(),
  };
  const value = await fixture();
  const configPath = path.join(value.root, "fresh-process-run.json");
  const statePath = path.join(value.root, "fresh-process-counts.json");
  const config = {
    ...value.input,
    journalDirectory: path.join(value.root, "fresh-process-journal"),
    runtimeModule: path.resolve("test/support/fake-resumable-desktop-runtime.mjs"),
    now: startedAt,
    testRuntime: { admission, crashAt: "after:provision", packetObservedAt: new Date(startedAt).toISOString(), statePath },
  };
  await writeFile(configPath, `${JSON.stringify(config)}\n`);

  const first = await runCli(["run", "--config", configPath, "--offline-adapter"]);
  assert.equal(first.code, 2, first.stderr);
  assert.match(first.stderr, /INJECTED_CRASH/u);

  const recoveredAt = startedAt + 31_000;
  const leaseObservationDigest = `sha256:${"9".repeat(64)}`;
  config.now = recoveredAt;
  config.testRuntime.crashAt = null;
  Object.assign(config.testRuntime.admission, {
    currentLeaseObservation: { observationDigest: leaseObservationDigest },
    currentLeaseObservationDigest: leaseObservationDigest,
    recoveryMode: "cleanup-only",
  });
  assert.ok(recoveredAt - Date.parse(config.testRuntime.packetObservedAt) > 30_000);
  assert.ok(recoveredAt > Date.parse(deadlineAt));
  await writeFile(configPath, `${JSON.stringify(config)}\n`);

  const resumed = await runCli(["resume", "--config", configPath, "--offline-adapter"]);
  assert.equal(resumed.code, 1, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).state, "quarantined");
  const afterFirstRecovery = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(afterFirstRecovery, { archive: 0, collect: 0, create: 1, destroy: 0, gui: 0, quarantine: 1 });

  const repeated = await runCli(["resume", "--config", configPath, "--offline-adapter"]);
  assert.equal(repeated.code, 1, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).state, "quarantined");
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), afterFirstRecovery);
});
