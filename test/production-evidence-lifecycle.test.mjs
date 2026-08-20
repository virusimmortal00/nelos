import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ResumableRemoteDesktopRunnerV1, contentDigest } from "nelos/remote-desktop-runner";
import { createRemoteDesktopEvidenceBundleV1, encodePngRgba, verifyRemoteDesktopEvidenceBundleV1 } from "nelos/remote-desktop-evidence";
import { GuestProductionTaskPreparerV1, ProductionEvidenceGuardV1, ProductionGuiDriverV1 } from "nelos/homelab-desktop-runtime";
import { ProducerTaskSurfaceObserverV1 } from "../src/production-task-surface-observer.mjs";
import { sha256 } from "nelos/proxmox-desktop-runtime";
import { PRODUCTION_GUEST_CODEX_IDENTITY_V1, createProductionGuestTaskIntentV1, productionGuestTaskDigestV1 } from "nelos/production-guest-task";
import { FIXTURE_NETWORK_POLICY_ADDRESS_DIGEST_V1, FIXTURE_NETWORK_POLICY_RULESET_DIGEST_V1, currentLeaseFor, validRemoteDesktopRunV1, validRemoteDesktopTerminalOutcomeV1 } from "./fixtures/remote-desktop-contract-v1.mjs";

const zero = () => ({ taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 0, screenshotCount: 0, screenshotBytes: 0, recordingDurationMs: 0, recordingBytes: 0, diagnosticLogCount: 0, diagnosticLogBytes: 0 });

function maskedSurfacePng(width, height, regions) {
  const rgba = Buffer.alloc(width * height * 4);
  try {
    for (let pixel = 0; pixel < width * height; pixel += 1) rgba[pixel * 4 + 3] = 255;
    for (const [index, region] of regions.entries()) {
      for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) {
        const offset = (y * width + x) * 4;
        rgba[offset] = 45 + index * 30; rgba[offset + 1] = 100; rgba[offset + 2] = 190;
      }
    }
    return encodePngRgba({ width, height, rgba });
  } finally { rgba.fill(0); }
}

function installedDesktopIdentity() {
  return {
    appServer: { platformFamily: "unix", platformOs: "linux", userAgent: "Codex Desktop/0.148.0-alpha.15" },
    bakeReceiptDigest: `sha256:${"b".repeat(64)}`,
    bundledCodex: { digest: "sha256:f13176129580681cf3024192f1ad43535c9933b24b7eca89e90fa57b3f4855fc", gid: 0, mode: "0755", path: "/usr/lib/chatgpt/resources/codex", uid: 0, version: "0.148.0-alpha.15" },
    bundledNode: { digest: "sha256:bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12", gid: 0, mode: "0755", path: "/usr/lib/chatgpt/resources/cua_node/bin/node", uid: 0, version: "24.19.0" },
    desktopPackage: { architecture: "amd64", digest: "sha256:4778b26a7abd08647214d5b05c17bd3ebe2d9688d146dabf017c1a2faf93ac7d", name: "chatgpt", version: "26.814.41957" },
    kind: "nelos-desktop-installed-identity", lockId: "nelos-proxmox-desktop-ubuntu-24.04-amd64-20260819",
    packageLockDigest: "sha256:9925b56c881ae22ffe6a3d22f8a2066b7ae2b4a4613029c2f79cb024a0398e93", schemaVersion: 1, verified: true,
  };
}

function provisionReceipt(run) {
  const desktopIdentity = installedDesktopIdentity();
  return {
    receiptId: "create", operation: "create", operationId: `${run.runId}:provision`, ...run.provider,
    leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, mutationStatus: "committed",
    attestationDigest: `sha256:${"d".repeat(64)}`, created: true, desktopIdentity,
    desktopIdentityDigest: sha256(desktopIdentity), qgaReady: true, state: "running",
  };
}

function admissionVerification(packetDigest) {
  const verificationReceipt = { schemaVersion: 1, type: "fixture-production-admission", packetDigest };
  return { verificationReceipt, verificationReceiptDigest: sha256(verificationReceipt) };
}

function leaseAuthorityAdmission() {
  return {
    leaseAuthority: {
      binding: {
        authorityId: "nelos-desktop-lease-authority-01",
        epoch: 1,
        issuedRecordDigest: `sha256:${"a".repeat(64)}`,
        issuedRecordFileDigest: `sha256:${"b".repeat(64)}`,
        issuedRevision: 1,
        trustDigest: `sha256:${"c".repeat(64)}`,
      },
      issuedObservationDigest: `sha256:${"d".repeat(64)}`,
    },
  };
}

function networkPolicyObservation(run, now) {
  const expiresAt = new Date(now + 3_600_000).toISOString();
  const measurementUnsigned = {
    approvedAddressCount: 2, approvedAddressInventoryDigest: FIXTURE_NETWORK_POLICY_ADDRESS_DIGEST_V1, complete: true, expiresAt,
    forwardPolicy: "drop", helper: { digest: `sha256:${"8".repeat(64)}`, path: "/usr/libexec/nelos-network-policy-observer" },
    kind: "nelos.proxmox-desktop.gateway-policy-measurement.v1", networkId: run.provider.networkId,
    observedAt: new Date(now - 1_500).toISOString(), policyDigest: run.provider.networkPolicyDigest,
    rulesetBytes: 4096, rulesetDigest: FIXTURE_NETWORK_POLICY_RULESET_DIGEST_V1,
    schemaVersion: 1, unexpectedForwardAccepts: 0,
  };
  const measurement = { ...measurementUnsigned, measurementDigest: sha256(measurementUnsigned) };
  const unsigned = {
    complete: true,
    expiresAt,
    gateway: { configDigest: `sha256:${"6".repeat(64)}`, hostId: run.provider.hostId, providerId: run.provider.providerId, vmId: run.provider.gatewayId },
    installed: true,
    kind: "nelos.proxmox-desktop.network-policy-observation.v1",
    measurement,
    networkId: run.provider.networkId,
    networkPolicyDigest: run.provider.networkPolicyDigest,
    observedAt: new Date(now - 1_000).toISOString(),
    schemaVersion: 1,
  };
  return { ...unsigned, observationDigest: sha256(unsigned) };
}

function productionAdmissionBinding(run) {
  return {
    fencingToken: run.lease.fencingToken,
    gatewayId: run.provider.gatewayId,
    hostId: run.provider.hostId,
    leaseId: run.lease.leaseId,
    macAddress: run.provider.macAddress,
    networkId: run.provider.networkId,
    networkPolicyDigest: run.provider.networkPolicyDigest,
    providerId: run.provider.providerId,
    runId: run.runId,
    vmid: Number(run.provider.vmId),
  };
}

function productionTaskArtifacts(run, plan) {
  const scenario = run.scenarios[0];
  const intent = createProductionGuestTaskIntentV1({ runId: run.runId, fencingToken: run.lease.fencingToken, scenarioId: scenario.scenarioId, title: scenario.scenarioId });
  const receipt = {
    schemaVersion: 1, type: "nelos-production-guest-task-receipt",
    binding: { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, imageId: run.goldenImage.imageId, runId: run.runId, automationUser: plan.automation.user, stateRoot: plan.automation.stateRoot },
    intentDigest: productionGuestTaskDigestV1(intent), taskSlotId: intent.taskSlotId, taskId: scenario.task.taskId,
    title: scenario.scenarioId, createdAt: 1_786_000_001, codexIdentity: structuredClone(PRODUCTION_GUEST_CODEX_IDENTITY_V1),
    accountBindingDigest: `sha256:${"9".repeat(64)}`, initialTurnStarted: false,
    inventory: { beforeTaskIds: [], afterTaskIds: [scenario.task.taskId], complete: true, maximumTasks: 100 },
  };
  return { intent, receipt };
}

function liveAuthAttestation(run, plan, accountBindingDigest, observedAt = "2026-08-19T12:01:00.000Z") {
  const base = {
    schemaVersion: 1, type: "live-device-auth-attestation", source: "codex-app-server-account-read",
    runId: run.runId, fencingToken: run.lease.fencingToken, automationUser: plan.automation.user,
    authenticated: true, accountType: "chatgpt", authMethod: "chatgptDeviceCode", credentialStore: "file", developerSessionImported: false,
    accountBindingDigest, authReceiptDigest: `sha256:${"8".repeat(64)}`, observedAt,
  };
  return { ...base, attestationDigest: sha256(base) };
}

function sealedCleanupReceipt(run) {
  const declaredValueRefs = run.scenarios.flatMap((scenario) => [
    ...scenario.actions.filter(({ type }) => type === "type_text_ref").map(({ valueRef }) => valueRef),
    ...scenario.assertions.filter(({ type }) => type === "text_ref_present").map(({ expectedRef }) => expectedRef),
  ]).sort();
  const result = { schemaVersion: 1, kind: "sealed-value-absence", declaredValueRefs, removedValueRefs: [], alreadyAbsentValueRefs: declaredValueRefs, remainingValueRefs: [] };
  const receipt = { schemaVersion: 1, type: "sealed-value-terminal-cleanup", runId: run.runId, inventoryDigest: contentDigest({ schemaVersion: 1, runId: run.runId, declaredValueRefs }), result };
  return { ...receipt, receiptDigest: contentDigest(receipt) };
}

async function runtimeFixture({ collectorFailure = false, prepareFailure = false, verifyFailure = false, attestationFailure = false, cleanupFailure = false, crashAt = null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nelos-production-evidence-")));
  const run = validRemoteDesktopRunV1(); run.provider.vmId = "9401"; run.scenarios = [run.scenarios[0]];
  const plan = {
    goldenImageTemplateVmId: "9001",
    reservation: { reservationId: "reservation-9401", ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, state: "reserved" },
    automation: { user: "nelosauto", uid: 2401, home: "/home/nelosauto", stateRoot: `/var/lib/nelos-desktop/runs/${run.runId}`, credentialRefs: [] },
    operationUsage: {
      provision: { ...zero(), wallTimeMs: 1_000 }, cleanup: { ...zero(), wallTimeMs: 1_000 }, quarantine: { ...zero(), wallTimeMs: 1_000 },
    },
    scenarioUsage: { [run.scenarios[0].scenarioId]: { ...zero(), taskCount: 1, modelTurnCount: 1, spendUsd: 0.1, wallTimeMs: run.scenarios[0].deadlineMs } },
    archiveConvergence: {
      policy: { maxConvergenceMs: 30_000, requireArchiveReceipts: true, requireRestartCheckpoint: true, requiredConsecutiveAbsent: 2 },
      operationUsage: { ...zero(), wallTimeMs: 30_000, screenshotCount: 2, screenshotBytes: 2_048 },
    },
    evidence: { bundleDirectory: join(root, "bundle"), proposedOperationalUsage: { taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 1 }, screenshots: [], recordings: [], diagnostics: [] },
  };
  const counts = { create: 0, destroy: 0, quarantine: 0, collect: 0, sealedCleanup: 0, prepare: 0, verify: 0, post: 0, final: 0 };
  const events = [];
  const providerController = {
    async execute({ operation }) {
      counts[operation] += 1; events.push(operation);
      if (operation === "create") return { receiptId: "create-1", ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, mutationStatus: "committed", created: true, qgaReady: true, state: "running" };
      return structuredClone(validRemoteDesktopTerminalOutcomeV1(run, operation === "destroy" ? "destroyed" : "quarantined").receipt);
    },
    async reconcileEffect() { throw new Error("no provider effect should require reconciliation"); },
  };
  const guiDriver = {
    async runScenario(scenario) {
      events.push("gui");
      return {
        scenarioId: scenario.scenarioId, taskId: scenario.task.taskId,
        startedAt: "2026-08-19T12:00:00.000Z", finishedAt: "2026-08-19T12:01:00.000Z", outcome: "passed", failure: null,
        actions: scenario.actions.map((action) => ({ actionId: action.actionId, actionType: action.type, startedAt: "2026-08-19T12:00:00.000Z", finishedAt: "2026-08-19T12:00:01.000Z", outcome: "succeeded" })),
        checkpoints: [], assertions: scenario.assertions.map((assertion) => ({ assertionId: assertion.assertionId, passed: true, observedRef: assertion.expectedRef })),
      };
    },
    async cleanupSealedValues(valueRefs) {
      counts.sealedCleanup += 1; events.push("sealed-values:absent"); const declaredValueRefs = [...valueRefs].sort();
      if (cleanupFailure) throw Object.assign(new Error("sealed cleanup failed"), { code: "SEALED_VALUE_CLEANUP_FAILED" });
      return { schemaVersion: 1, kind: "sealed-value-absence", declaredValueRefs, removedValueRefs: [], alreadyAbsentValueRefs: declaredValueRefs, remainingValueRefs: [] };
    },
  };
  const archiveProjectionController = {
    async execute() { events.push("archive"); return { schemaVersion: 1, outcome: "passed" }; },
    async reconcileEffect() { throw new Error("archive should not require reconciliation"); },
  };
  const evidenceCollector = { async collect() {
    counts.collect += 1; events.push("collect");
    if (collectorFailure) throw Object.assign(new Error("capture failed"), { code: "CAPTURE_FAILED" });
    return { screenshots: [], recordings: [], diagnostics: [] };
  } };
  const productionGuard = {
    admission: {
      packetDigest: `sha256:${"1".repeat(64)}`, gateReceiptDigest: `sha256:${"2".repeat(64)}`,
      configDigest: `sha256:${"3".repeat(64)}`, runDeadlineAt: "2026-08-19T12:05:00.000Z",
      ...leaseAuthorityAdmission(),
      verificationReceiptDigest: `sha256:${"e".repeat(64)}`,
    },
    async prepareBeforeDestroy() {
      counts.prepare += 1; events.push("prepare");
      if (prepareFailure) throw Object.assign(new Error("draft failed"), { code: "DRAFT_FAILED" });
      return { type: "draft", digest: `sha256:${"4".repeat(64)}` };
    },
    async verifyBeforeDestroy() {
      counts.verify += 1; events.push("verify");
      if (verifyFailure) throw Object.assign(new Error("verification failed"), { code: "DRAFT_VERIFY_FAILED" });
      return { type: "verification", digest: `sha256:${"5".repeat(64)}` };
    },
    async attestAfterDestroy() {
      counts.post += 1; events.push("post-destroy-attest");
      if (attestationFailure) throw Object.assign(new Error("absence ambiguous"), { code: "POST_DESTROY_ATTESTATION_FAILED" });
      return { type: "post-destroy", digest: `sha256:${"6".repeat(64)}` };
    },
    async attestFinalEvidence() { counts.final += 1; events.push("final-attest"); return { type: "final", digest: `sha256:${"7".repeat(64)}` }; },
  };
  const taskPreparer = {
    intentDigest: `sha256:${"8".repeat(64)}`,
    async execute() { return { schemaVersion: 1, taskId: run.scenarios[0].task.taskId, initialTurnStarted: false }; },
    async reconcileEffect() { return { schemaVersion: 1, taskId: run.scenarios[0].task.taskId, initialTurnStarted: false }; },
    materialize(value) { return structuredClone(value); },
  };
  let crashed = false;
  const crashInjector = async (checkpoint) => {
    if (!crashed && checkpoint === crashAt) { crashed = true; throw Object.assign(new Error("injected crash"), { code: "INJECTED_CRASH" }); }
  };
  const input = { run, plan, candidateDigest: run.candidate.digest, currentLease: currentLeaseFor(run), now: Date.parse("2026-08-19T12:00:00.000Z") };
  const runner = new ResumableRemoteDesktopRunnerV1({ journalDirectory: join(root, "journal"), providerController, guiDriver, archiveProjectionController, evidenceCollector, productionGuard, taskPreparer, crashInjector, clock: { now: () => Date.parse("2026-08-19T12:01:00.000Z") } });
  return { runner, input, counts, events, productionGuard };
}

test("production cleanup is gated by a journaled evidence draft and independent post-destroy attestation", async () => {
  const value = await runtimeFixture();
  const result = await value.runner.start(value.input);
  assert.equal(result.run.state, "succeeded", JSON.stringify(result.failure));
  assert.ok(value.events.indexOf("collect") < value.events.indexOf("prepare"));
  assert.ok(value.events.indexOf("sealed-values:absent") < value.events.indexOf("archive"));
  assert.ok(value.events.indexOf("prepare") < value.events.indexOf("verify"));
  assert.ok(value.events.indexOf("verify") < value.events.indexOf("destroy"));
  assert.ok(value.events.indexOf("destroy") < value.events.indexOf("post-destroy-attest"));
  assert.ok(value.events.indexOf("post-destroy-attest") < value.events.indexOf("final-attest"));
  assert.ok(result.preDestroyInventoryDraft);
  assert.ok(result.preDestroyVerification);
  assert.ok(result.postDestroyAttestation);
  assert.ok(result.finalEvidenceAttestation);
  assert.ok(result.sealedValueCleanup);
});

for (const failure of ["collectorFailure", "prepareFailure", "verifyFailure"]) {
  test(`${failure} quarantines the VM without issuing destroy`, async () => {
    const value = await runtimeFixture({ [failure]: true });
    const result = await value.runner.start(value.input);
    assert.equal(result.run.state, "quarantined");
    assert.equal(value.counts.destroy, 0);
    assert.equal(value.counts.quarantine, 1);
    assert.ok(result.preDestroyEvidenceFailure);
    assert.equal(result.postDestroyAttestation, null);
  });
}

test("unattested sealed-value absence forces quarantine and prevents destructive cleanup", async () => {
  const value = await runtimeFixture({ cleanupFailure: true });
  const result = await value.runner.start(value.input);
  assert.equal(result.run.state, "quarantined");
  assert.equal(value.counts.sealedCleanup, 1);
  assert.equal(value.counts.destroy, 0);
  assert.equal(value.counts.quarantine, 1);
  assert.equal(result.sealedValueCleanup, null);
  assert.equal(result.preDestroyEvidenceFailure.code, "SEALED_VALUE_CLEANUP_FAILED");
});

test("independent absence failure can never produce production success", async () => {
  const value = await runtimeFixture({ attestationFailure: true });
  const result = await value.runner.start(value.input);
  assert.equal(value.counts.destroy, 1);
  assert.equal(value.counts.quarantine, 0);
  assert.equal(result.run.state, "failed");
  assert.equal(result.postDestroyAttestation, null);
  assert.equal(result.evidence, null);
});

for (const checkpoint of ["after:sealed-value-cleanup", "after:pre-destroy-evidence", "after:pre-destroy-verification", "after:post-destroy-attestation", "after:final-evidence-attestation"]) {
  test(`production evidence lifecycle resumes after ${checkpoint} without duplicate mutations`, async () => {
    const value = await runtimeFixture({ crashAt: checkpoint });
    await assert.rejects(value.runner.start(value.input), (error) => error.code === "INJECTED_CRASH");
    const observationDigest = `sha256:${"8".repeat(64)}`;
    Object.assign(value.productionGuard.admission, {
      currentLeaseObservation: { observationDigest }, currentLeaseObservationDigest: observationDigest, recoveryMode: "continue",
    });
    const result = await value.runner.resume(value.input);
    assert.equal(result.run.state, "succeeded", JSON.stringify(result.failure));
    assert.equal(value.counts.create, 1);
    assert.equal(value.counts.destroy, 1);
    assert.equal(value.counts.prepare, 1);
    assert.equal(value.counts.verify, 1);
    assert.equal(value.counts.post, 1);
    assert.equal(value.counts.final, 1);
    assert.equal(value.counts.sealedCleanup, 1);
  });
}

test("real production guard content-addresses sanitized artifacts, archive reports, and the independent final attestation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nelos-production-guard-")));
  const evidenceRoot = join(root, "evidence"); const archiveReportRoot = join(evidenceRoot, "archive-reports");
  const taskSurfaceEvidenceRoot = join(evidenceRoot, "task-surface-observations"); const archiveSurfaceEvidenceRoot = join(evidenceRoot, "archive-surface-observations");
  await mkdir(archiveReportRoot, { recursive: true, mode: 0o700 }); await mkdir(taskSurfaceEvidenceRoot, { recursive: true, mode: 0o700 }); await mkdir(archiveSurfaceEvidenceRoot, { recursive: true, mode: 0o700 });
  const taskSurfacePng = Buffer.from("masked-task-status-sidebar"); const taskSurfaceDigest = sha256(taskSurfacePng);
  const archiveSurfacePng = Buffer.from("masked-archive-sidebar"); const archiveSurfaceDigest = sha256(archiveSurfacePng);
  await writeFile(join(taskSurfaceEvidenceRoot, `${taskSurfaceDigest.slice(7)}.png`), taskSurfacePng, { mode: 0o400 });
  await writeFile(join(archiveSurfaceEvidenceRoot, `${archiveSurfaceDigest.slice(7)}.png`), archiveSurfacePng, { mode: 0o400 });
  const run = validRemoteDesktopRunV1(); run.provider.vmId = "9401"; run.scenarios = [run.scenarios[0]];
  const scenario = run.scenarios[0];
  const reportBytes = Buffer.from('{"schemaVersion":1,"kind":"nelos-developer-visual-state-validation"}\n');
  await writeFile(join(archiveReportRoot, "1-report.json"), reportBytes, { mode: 0o400 });
  const screenshot = {
    artifactId: "shot-1", scenarioId: scenario.scenarioId, width: 4, height: 2, maxOutputBytes: 50_000,
    frame: {
      rgba: Buffer.alloc(4 * 2 * 4, 255),
      sensitiveRegions: [
        { class: "conversation", region: { x: 0, y: 0, width: 2, height: 2 } },
        { class: "credential", region: { x: 2, y: 0, width: 2, height: 2 } },
      ],
      protection: { geometryCertain: true, inventoryComplete: true, mode: "mask", regions: [{ x: 0, y: 0, width: 2, height: 2 }, { x: 2, y: 0, width: 2, height: 2 }] },
    },
  };
  const diagnostic = { diagnosticId: "diag-1", scenarioId: scenario.scenarioId, source: "desktop_runtime", code: "DESKTOP_READY", occurredAt: "2026-08-19T12:01:00.000Z", fields: { component: "desktop", status: "ready" } };
  const result = {
    scenarioId: scenario.scenarioId, taskId: scenario.task.taskId,
    startedAt: "2026-08-19T12:00:00.000Z", finishedAt: "2026-08-19T12:01:00.000Z", outcome: "passed", failure: null,
    actions: scenario.actions.map((action) => ({ actionId: action.actionId, actionType: action.type, startedAt: "2026-08-19T12:00:00.000Z", finishedAt: "2026-08-19T12:00:01.000Z", outcome: "succeeded" })),
    checkpoints: [], assertions: scenario.assertions.map((assertion) => ({ assertionId: assertion.assertionId, passed: true, observedRef: assertion.expectedRef })),
  };
  const plan = {
    automation: { user: "nelosauto", stateRoot: `/var/lib/nelos-desktop/runs/${run.runId}` },
    evidence: {
      proposedOperationalUsage: { taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 1 },
      screenshots: [{ artifactId: screenshot.artifactId, scenarioId: screenshot.scenarioId, maxOutputBytes: screenshot.maxOutputBytes }],
      recordings: [],
      diagnostics: [{ diagnosticId: diagnostic.diagnosticId, scenarioId: diagnostic.scenarioId, code: diagnostic.code }],
    },
  };
  const packetDigest = `sha256:${"a".repeat(64)}`;
  const task = productionTaskArtifacts(run, plan); const sealedValueCleanup = sealedCleanupReceipt(run);
  const admission = { packetDigest, ...admissionVerification(packetDigest), taskIntentReceipt: task.intent, binding: productionAdmissionBinding(run) };
  let absenceReads = 0;
  const guard = new ProductionEvidenceGuardV1({
    admission, run, evidenceRoot, archiveReportRoot, taskSurfaceEvidenceRoot, archiveSurfaceEvidenceRoot,
    independentAttestor: { async attestVmAbsent(binding) { absenceReads += 1; return { ...binding, absent: true, macAbsent: true, networkInventoryComplete: true }; } },
    networkPolicyObservation: networkPolicyObservation(run, Date.parse("2026-08-19T12:01:00.000Z")),
    clock: { now: () => Date.parse("2026-08-19T12:01:00.000Z") },
  });
  const archiveConvergence = { report: { evidence: [{ visualReportDigest: sha256(reportBytes) }] } };
  const collection = { screenshots: [screenshot], recordings: [], diagnostics: [diagnostic], authAttestation: liveAuthAttestation(run, plan, task.receipt.accountBindingDigest) };
  const providerReceipt = provisionReceipt(run);
  const driftedCollection = { ...collection, authAttestation: liveAuthAttestation(run, plan, `sha256:${"7".repeat(64)}`) };
  await assert.rejects(
    guard.prepareBeforeDestroy({ run, currentUsage: zero(), plan, providerReceipt, taskPreparation: task.receipt, scenarioResults: [result], archiveConvergence, sealedValueCleanup, evidenceCollection: driftedCollection }),
    (error) => error.code === "AUTH_IDENTITY_MISMATCH",
  );
  const draft = await guard.prepareBeforeDestroy({ run, currentUsage: zero(), plan, providerReceipt, taskPreparation: task.receipt, scenarioResults: [result], archiveConvergence, sealedValueCleanup, evidenceCollection: collection });
  assert.match(draft.inventoryDigest, /^sha256:[0-9a-f]{64}$/u);
  const recoveredDraft = await guard.prepareBeforeDestroy({ run, currentUsage: zero(), plan, providerReceipt, taskPreparation: task.receipt, scenarioResults: [result], archiveConvergence, sealedValueCleanup, evidenceCollection: collection });
  assert.deepEqual(recoveredDraft, draft);
  const inventory = JSON.parse(await readFile(draft.inventoryPath, "utf8"));
  assert.deepEqual(new Set(inventory.files.map(({ role }) => role)), new Set(["checkpoint-screenshot", "diagnostics", "task-surface-screenshot", "archive-surface-screenshot", "archive-visual-report", "installed-desktop-identity", "production-admission-verification", "guest-task-receipt", "account-binding-attestation", "network-policy-attestation", "sealed-value-cleanup"]));
  assert.equal(inventory.files.find(({ role }) => role === "task-surface-screenshot").sha256, taskSurfaceDigest);
  const preDestroyVerification = await guard.verifyBeforeDestroy({ run, draft, archiveConvergence });
  assert.equal(preDestroyVerification.fileCount, 11);

  const terminalOutcome = validRemoteDesktopTerminalOutcomeV1(run, "destroyed");
  const postDestroyAttestation = await guard.attestAfterDestroy({ run, terminalOutcome, draft, preDestroyVerification });
  assert.equal(absenceReads, 1);
  assert.equal(postDestroyAttestation.absent, true);
  const mapped = {
    scenarioMetadata: [{ evidenceClass: "scenario_metadata", scenarioId: result.scenarioId, taskId: result.taskId, startedAt: result.startedAt, finishedAt: result.finishedAt, outcome: result.outcome }],
    actionTimeline: result.actions.map((action) => ({ evidenceClass: "action_timeline", scenarioId: result.scenarioId, ...action })),
    assertionOutcomes: result.assertions.map((assertion) => ({ evidenceClass: "assertion_outcome", scenarioId: result.scenarioId, ...assertion })),
  };
  const bundleDirectory = join(evidenceRoot, "bundle");
  const built = await createRemoteDesktopEvidenceBundleV1({
    bundleDirectory, run, currentUsage: zero(), proposedOperationalUsage: plan.evidence.proposedOperationalUsage,
    ...mapped, screenshots: [screenshot], recordings: [], diagnostics: [diagnostic],
    cleanupAttestation: { evidenceClass: "cleanup_attestation", runId: run.runId, ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, terminalOutcomeDigest: sha256(terminalOutcome) },
  });
  const verified = await verifyRemoteDesktopEvidenceBundleV1(bundleDirectory, run);
  const final = await guard.attestFinalEvidence({ run, evidence: { bundleDirectory: built.bundleDirectory, inventory: verified.inventory }, draft, postDestroyAttestation, sealedValueCleanup });
  assert.match(final.attestationDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(final.preDestroyInventoryDigest, draft.inventoryDigest);

  await writeFile(join(draft.artifactsRoot, "unreferenced.txt"), "altered");
  await assert.rejects(guard.verifyBeforeDestroy({ run, draft, archiveConvergence }), (error) => error.code === "EVIDENCE_UNREFERENCED_FILE");
});

test("stale In-progress sidebar status preserves protected evidence and forces quarantine", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nelos-stale-sidebar-e2e-")));
  const evidenceRoot = join(root, "evidence"); const archiveReportRoot = join(evidenceRoot, "archive-reports");
  const taskSurfaceEvidenceRoot = join(evidenceRoot, "task-surface-observations"); const taskSurfaceDiagnosticRoot = join(evidenceRoot, "task-surface-diagnostics");
  const archiveSurfaceEvidenceRoot = join(evidenceRoot, "archive-surface-observations");
  await mkdir(archiveReportRoot, { recursive: true, mode: 0o700 }); await mkdir(archiveSurfaceEvidenceRoot, { recursive: true, mode: 0o700 });
  const run = validRemoteDesktopRunV1(); run.provider.vmId = "9401"; run.scenarios = [run.scenarios[0]];
  const scenario = run.scenarios[0]; const now = Date.parse("2026-08-20T12:00:00.000Z"); let guiNow = now;
  const binding = { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, imageId: run.goldenImage.imageId, runId: run.runId, automationUser: "nelosauto", stateRoot: `/var/lib/nelos-desktop/runs/${run.runId}` };
  const planAutomation = { user: "nelosauto", uid: 2401, home: "/home/nelosauto", stateRoot: binding.stateRoot, credentialRefs: [] };
  const task = productionTaskArtifacts(run, { automation: planAutomation }); const actualTaskId = task.receipt.taskId;
  scenario.task.taskId = task.intent.taskSlotId;
  const protectedInventory = { schemaVersion: 1, conversation: { kind: "conversation", x: 0, y: 0, width: 20, height: 20 }, credentialInventory: { complete: true, count: 0, regions: [] }, traversal: { complete: true, scannedNodes: 30, maximumNodes: 10_000 } };
  const privacy = {
    schemaVersion: 1, classificationComplete: true, maskedBase: "full-frame-black", mode: "expected-task-evidence-only", rawPixelsPersisted: false,
    traversal: { ...protectedInventory.traversal }, preservedRegions: [
      { kind: "expected-task-title", taskId: actualTaskId, textDigest: sha256(Buffer.from(scenario.scenarioId)), x: 25, y: 2, width: 20, height: 5 },
      { kind: "expected-task-status", taskId: actualTaskId, textDigest: sha256(Buffer.from("In progress")), x: 25, y: 8, width: 20, height: 5 },
    ],
  };
  const sidebarPng = maskedSurfacePng(100, 80, privacy.preservedRegions); const sidebarDigest = sha256(sidebarPng);
  const threadFor = (lifecycle, taskId) => lifecycle === "active"
    ? { schemaVersion: 1, threadId: taskId, title: scenario.scenarioId, status: "active", activeFlags: [], cwd: "/workspace", parentThreadId: null, createdAt: 1, updatedAt: 2 }
    : { schemaVersion: 1, threadId: taskId, title: scenario.scenarioId, status: "idle", cwd: "/workspace", parentThreadId: null, createdAt: 1, updatedAt: 2 };
  const producer = new ProducerTaskSurfaceObserverV1({
    binding, evidenceRoot: taskSurfaceEvidenceRoot, diagnosticRoot: taskSurfaceDiagnosticRoot, clock: { now: () => now },
    nativeObserver: { async observe(expected) { return { thread: threadFor(expected.lifecycle, expected.taskId), attestation: { loadState: expected.lifecycle === "active" ? "active" : "idle", activeFlags: [], latestTurn: expected.lifecycle === "completed" ? { turnId: "turn-completed", status: "completed" } : { turnId: "turn-active", status: "inProgress" }, aggregateTaskTopology: { schemaVersion: 1, source: "codex-app-server-parent-history-latest-turn", rootThreadId: expected.taskId, complete: true, descendantCount: 0, working: 0, completed: 0, interrupted: 0, terminal: 0, descendants: [], topologyDigest: sha256(Buffer.from("[]")) } } }; } },
    mcpObserver: { async observe(expected) { return { thread: threadFor(expected.lifecycle, expected.taskId), attestation: { loadState: expected.lifecycle === "active" ? "active" : "idle", activeFlags: [] } }; } },
    client: { async invoke({ payload }) { return {
      schemaVersion: 1, runId: run.runId, fencingToken: run.lease.fencingToken, taskId: payload.taskId, title: scenario.scenarioId,
      lifecycle: payload.lifecycle, observedAt: new Date(now).toISOString(), producer: "visible-codex-desktop",
      attestation: {
        accessibilityRole: "list item", aggregateTaskCounters: { schemaVersion: 1, source: "visible-codex-desktop-atspi", current: 0, done: 0, groups: { needsInput: 0, inProgress: 0, queued: 0 }, scan: { ...protectedInventory.traversal } }, descendantTasks: { schemaVersion: 1, sidebar: [], mcpVisual: [], observationPhases: [] }, renderedLifecycle: "running", lifecycleEvidence: { kind: "text", value: "In progress", scan: { complete: true, scannedNodes: 18, maximumNodes: 2_000 } }, selected: true,
        screenshot: { byteLength: sidebarPng.length, bytesBase64: sidebarPng.toString("base64"), digest: sidebarDigest, width: 100, height: 80, mediaType: "image/png", path: `${binding.stateRoot}/surface-observations/${sidebarDigest.slice(7)}.png`, privacy, protectedInventory, protectedRegions: [protectedInventory.conversation], protection: { geometryCertain: true, inventoryComplete: true, mode: "mask" } },
      },
    }; } },
  });
  const guiBindings = { "submit-key": { role: "textbox", key: "ENTER" } };
  const authClient = { async invoke({ operation, payload }) {
    if (operation === "auth_status") return liveAuthAttestation(run, { automation: planAutomation }, task.receipt.accountBindingDigest, new Date(guiNow).toISOString());
    if (operation === "gui_ready") return { ready: true, accessibilityBus: true, captureReady: true };
    if (operation === "expected_task_visible") return { schemaVersion: 1, taskId: payload.taskId, title: payload.title, state: "visible", scan: { complete: true, scannedNodes: 20, maximumNodes: 10_000 } };
    throw new Error(`unexpected operation ${operation}`);
  } };
  const passedResult = {
    scenarioId: scenario.scenarioId, taskId: scenario.task.taskId, startedAt: new Date(now).toISOString(), finishedAt: new Date(now + 1_000).toISOString(), outcome: "passed", failure: null,
    actions: scenario.actions.map((action) => ({ actionId: action.actionId, actionType: action.type, startedAt: new Date(now).toISOString(), finishedAt: new Date(now + 100).toISOString(), outcome: "succeeded" })), checkpoints: [], assertions: [],
  };
  const guiDriver = new ProductionGuiDriverV1({
    admitted: { run, plan: { automation: { user: "nelosauto" } }, homelab: { guiBindings } }, client: authClient, surfaceObserver: producer, syncTimeoutMs: 1_000, pollIntervalMs: 1,
    clock: { now: () => guiNow }, sleep: async (milliseconds) => { guiNow += milliseconds; },
    driver: { async runScenario(_scenario, { beforeAction, afterAction }) {
      const submit = scenario.actions.find((action) => action.type === "keypress" && guiBindings[action.targetRef]?.key === "ENTER");
      await beforeAction({ action: submit });
      await afterAction({ action: submit });
      return { ...passedResult, taskId: _scenario.task.taskId };
    }, async cleanupSealedValues(valueRefs) { return { schemaVersion: 1, kind: "sealed-value-absence", declaredValueRefs: [...valueRefs].sort(), removedValueRefs: [], alreadyAbsentValueRefs: [...valueRefs].sort(), remainingValueRefs: [] }; } },
  });

  const archivePng = Buffer.from("masked-archive-after-stale-status"); const archiveDigest = sha256(archivePng);
  await writeFile(join(archiveSurfaceEvidenceRoot, `${archiveDigest.slice(7)}.png`), archivePng, { mode: 0o400 });
  const reportBytes = Buffer.from('{"schemaVersion":1,"kind":"nelos-developer-visual-state-validation"}\n'); const reportDigest = sha256(reportBytes);
  await writeFile(join(archiveReportRoot, "1-report.json"), reportBytes, { mode: 0o400 });
  const plan = {
    goldenImageTemplateVmId: "9001", reservation: { reservationId: "reservation-9401", ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, state: "reserved" },
    automation: planAutomation,
    operationUsage: { provision: { ...zero(), wallTimeMs: 1_000 }, cleanup: { ...zero(), wallTimeMs: 1_000 }, quarantine: { ...zero(), wallTimeMs: 1_000 } },
    scenarioUsage: { [scenario.scenarioId]: { ...zero(), taskCount: 1, modelTurnCount: 1, spendUsd: 0.1, wallTimeMs: scenario.deadlineMs } },
    archiveConvergence: { policy: { maxConvergenceMs: 30_000, requireArchiveReceipts: true, requireRestartCheckpoint: true, requiredConsecutiveAbsent: 2 }, operationUsage: { ...zero(), wallTimeMs: 30_000, screenshotCount: 2, screenshotBytes: 2_048 } },
    evidence: { bundleDirectory: join(evidenceRoot, "bundle"), proposedOperationalUsage: { taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 1 }, screenshots: [], recordings: [], diagnostics: [] },
  };
  const packetDigest = `sha256:${"a".repeat(64)}`;
  const admission = { packetDigest, ...admissionVerification(packetDigest), ...leaseAuthorityAdmission(), taskIntentReceipt: task.intent, gateReceiptDigest: `sha256:${"b".repeat(64)}`, configDigest: `sha256:${"c".repeat(64)}`, runDeadlineAt: "2026-08-20T12:05:00.000Z", binding: productionAdmissionBinding(run) };
  const guard = new ProductionEvidenceGuardV1({ admission, run, evidenceRoot, archiveReportRoot, taskSurfaceEvidenceRoot, taskSurfaceDiagnosticRoot, archiveSurfaceEvidenceRoot, independentAttestor: { async attestVmAbsent(value) { return { ...value, absent: true, macAbsent: true, networkInventoryComplete: true }; } }, networkPolicyObservation: networkPolicyObservation(run, now), clock: { now: () => now } });
  const counts = { create: 0, destroy: 0, quarantine: 0 };
  const providerController = { async execute({ operation }) { counts[operation] += 1; if (operation === "create") return provisionReceipt(run); return structuredClone(validRemoteDesktopTerminalOutcomeV1(run, operation === "destroy" ? "destroyed" : "quarantined").receipt); }, async reconcileEffect() { throw new Error("not reached"); } };
  const taskPreparer = new GuestProductionTaskPreparerV1({ client: { async invoke() { return structuredClone(task.receipt); } }, admitted: { run, plan, runtimeBinding: binding }, intent: task.intent });
  const runner = new ResumableRemoteDesktopRunnerV1({
    journalDirectory: join(root, "journal"), providerController, guiDriver,
    archiveProjectionController: { async execute() { return { schemaVersion: 1, outcome: "passed", report: { evidence: [{ visualReportDigest: reportDigest }] } }; }, async reconcileEffect() { throw new Error("not reached"); } },
    evidenceCollector: { async collect() { return { screenshots: [], recordings: [], diagnostics: [], authAttestation: liveAuthAttestation(run, plan, task.receipt.accountBindingDigest, new Date(now).toISOString()) }; } }, productionGuard: guard, taskPreparer, clock: { now: () => now },
  });
  const result = await runner.start({ run, plan, candidateDigest: run.candidate.digest, currentLease: currentLeaseFor(run), now });
  assert.equal(result.run.state, "quarantined");
  assert.equal(result.failure.code, "THREE_SURFACE_IDENTITY_MISMATCH");
  assert.equal(counts.destroy, 0); assert.equal(counts.quarantine, 1);
  assert.deepEqual(await readFile(join(taskSurfaceEvidenceRoot, `${sidebarDigest.slice(7)}.png`)), sidebarPng);
  assert.ok(result.preDestroyInventoryDraft, JSON.stringify({ failure: result.failure, preDestroyEvidenceFailure: result.preDestroyEvidenceFailure, archiveConvergence: result.archiveConvergence }));
  const draftInventory = JSON.parse(await readFile(result.preDestroyInventoryDraft.inventoryPath, "utf8"));
  assert.ok(draftInventory.files.some(({ role, sha256: digest }) => role === "task-surface-screenshot" && digest === sidebarDigest));
  assert.ok(draftInventory.files.some(({ role }) => role === "task-surface-diagnostic"));
  assert.equal(result.preDestroyEvidenceFailure.code, "SCENARIO_EVIDENCE_REQUIRES_QUARANTINE");
});
