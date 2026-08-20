import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArchiveProjectionLaneV1 } from "nelos/archive-projection-lane";
import {
  AtomicProviderReceiptStoreV1,
  BoundedJsonProcessV1,
  HomelabEvidenceCollectorV1,
  HomelabProviderReconcilerV1,
  ProxmoxQgaHelperClientV1,
  ProductionGuiDriverV1,
  HomelabProxmoxTransportV1,
  createHomelabRemoteDesktopRuntimeV1,
} from "nelos/homelab-desktop-runtime";
import { ProxmoxDesktopControllerV1, ResumableRemoteDesktopRunnerV1 } from "nelos/remote-desktop-runner";
import { ProxmoxVeDesktopAdapterV1 } from "../validation/proxmox-desktop/v1/backend/index.mjs";
import { currentLeaseFor, validRemoteDesktopRunV1 } from "./fixtures/remote-desktop-contract-v1.mjs";

const zero = () => ({ taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 0, screenshotCount: 0, screenshotBytes: 0, recordingDurationMs: 0, recordingBytes: 0, diagnosticLogCount: 0, diagnosticLogBytes: 0 });

function runHelper(executable, operation, input, env = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [executable, operation], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => code === 0 ? resolvePromise(JSON.parse(Buffer.concat(stdout))) : rejectPromise(Object.assign(new Error(Buffer.concat(stderr).toString("utf8")), { exitCode: code })));
    child.stdin.end(input);
  });
}

async function configFixture() {
  const run = validRemoteDesktopRunV1(); run.scenarios = [run.scenarios[0]];
  const base = await mkdtemp(join(tmpdir(), "nelos-homelab-runtime-"));
  const stateRoot = join(base, run.runId); const sealedValueRoot = join(base, "sealed", run.runId);
  const observationRoot = join(stateRoot, "observations");
  await mkdir(sealedValueRoot, { recursive: true, mode: 0o700 }); await mkdir(observationRoot, { recursive: true, mode: 0o700 });
  const plan = {
    goldenImageTemplateVmId: "9001",
    reservation: { reservationId: "reservation-9401", ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, state: "reserved" },
    automation: { user: "nelosauto", uid: 2401, home: "/home/nelosauto", stateRoot: `/var/lib/nelos-desktop/runs/${run.runId}`, credentialRefs: [] },
    operationUsage: { provision: zero(), cleanup: zero(), quarantine: zero() }, scenarioUsage: { [run.scenarios[0].scenarioId]: zero() },
    archiveConvergence: { policy: { maxConvergenceMs: 30_000, requireArchiveReceipts: true, requireRestartCheckpoint: true, requiredConsecutiveAbsent: 2 }, operationUsage: zero() },
    evidence: { bundleDirectory: join(stateRoot, "evidence"), proposedOperationalUsage: { taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 1 }, screenshots: [], recordings: [], diagnostics: [] },
  };
  return {
    run, plan, candidateDigest: run.candidate.digest, currentLease: currentLeaseFor(run), journalDirectory: join(stateRoot, "journal"),
    homelab: {
      schemaVersion: 1, stateRoot, sealedValueRoot, observationRoot,
      guiBindings: { "new-task-button": { role: "button", name: "New task" }, "task-composer": { role: "textbox" }, "active-task": { role: "document" }, "task-complete": { state: "complete" } },
      deadlines: { providerMs: 1_000, qgaMs: 1_000, archiveMs: 30_000 },
      outputLimits: { providerBytes: 1_048_576, qgaBytes: 1_048_576, archiveReportBytes: 1_048_576 },
    },
  };
}

test("production entrypoint wires the exact runner interfaces through the Proxmox controller and adapter", async () => {
  const config = await configFixture();
  const runtime = await createHomelabRemoteDesktopRuntimeV1(config, { providerTransport: { async request() { throw new Error("offline fixture should not contact a provider"); } } });
  assert.deepEqual(Object.keys(runtime).sort(), ["archiveProjectionController", "evidenceCollector", "guiDriver", "providerController"]);
  assert.ok(runtime.providerController instanceof ProxmoxDesktopControllerV1);
  assert.ok(runtime.providerController.adapter instanceof ProxmoxVeDesktopAdapterV1);
  assert.ok(runtime.guiDriver instanceof ProductionGuiDriverV1);
  assert.ok(runtime.archiveProjectionController instanceof ArchiveProjectionLaneV1);
  assert.equal(typeof runtime.evidenceCollector.collect, "function");
});

test("stale fencing and host identity mismatches fail before provider or QGA mutation", async () => {
  const config = await configFixture(); const stale = structuredClone(config); stale.currentLease.fencingToken = "fence-stale-9";
  await assert.rejects(createHomelabRemoteDesktopRuntimeV1(stale, { providerTransport: { request() { throw new Error("must not call"); } } }), (error) => error.code === "STALE_FENCING_TOKEN");

  const calls = [];
  const admitted = { run: config.run, plan: config.plan, binding: { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken }, runtimeBinding: { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot } };
  const adapter = { async inspectRuntimeBinding() { return { ...admitted.runtimeBinding, hostId: "other-host" }; }, async call(...args) { calls.push(args); } };
  const client = new ProxmoxQgaHelperClientV1({ adapter, admitted, deadlineMs: 100, maxOutputBytes: 1_024 });
  await assert.rejects(client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }), (error) => error.code === "RUNTIME_IDENTITY_MISMATCH");
  assert.deepEqual(calls, []);
});

test("ambiguous provider effects reconcile through reads and are never replayed", async () => {
  const config = await configFixture(); const mutations = [];
  const admitted = { run: config.run, plan: config.plan, binding: { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken } };
  const adapter = { async inspectVm() { return null; }, async cloneVm(value) { mutations.push(value); } };
  const reconciler = new HomelabProviderReconcilerV1({ adapter, receiptStore: { async read() { return null; } }, admitted, clock: { now: () => Date.parse("2026-08-19T12:00:00.000Z") } });
  const effect = { kind: "provision", request: { operationId: `${config.run.runId}:provision`, runId: config.run.runId, provider: config.run.provider, lease: config.run.lease, automation: config.plan.automation, reservation: config.plan.reservation } };
  await assert.rejects(reconciler.reconcile(effect), (error) => ["RUNTIME_IDENTITY_MISMATCH", "RECONCILIATION_REQUIRED"].includes(error.code));
  assert.deepEqual(mutations, []);
});

test("missing fixed helpers fail closed with no command fallback", async () => {
  const boundary = new BoundedJsonProcessV1();
  await assert.rejects(boundary.invoke({ executable: "/usr/libexec/nelos-proxmox-transport", operation: "request", payload: {}, deadlineMs: 100, maxOutputBytes: 1_024 }), (error) => error.code === "UNAVAILABLE_HELPER");
  assert.throws(() => boundary.invoke({ executable: "/bin/sh", operation: "request", payload: {}, deadlineMs: 100, maxOutputBytes: 1_024 }), (error) => error.code === "UNAVAILABLE_HELPER");
});

test("provider process boundary preserves exit 44 and transport sends the exact bound protocol", async () => {
  const fake = new BoundedJsonProcessV1({ spawnProcess() {
    const listeners = new Map(); const stdoutListeners = new Map();
    return {
      once(name, callback) { listeners.set(name, callback); },
      stdout: { on(name, callback) { stdoutListeners.set(name, callback); } },
      stdin: { write() {}, end() { queueMicrotask(() => listeners.get("close")?.(44)); } },
    };
  } });
  await assert.rejects(fake.invoke({ executable: "/usr/libexec/nelos-proxmox-transport", operation: "request", payload: {}, deadlineMs: 100, maxOutputBytes: 1_024 }), (error) => error.status === 404 && error.code === "PVE_NOT_FOUND");

  const binding = { providerId: "p", hostId: "h", vmId: "901", leaseId: "l", fencingToken: "f", imageId: "i", runId: "r", automationUser: "nelosauto", stateRoot: "/var/lib/nelos-desktop/runs/r" };
  let invoked;
  const transport = new HomelabProxmoxTransportV1({ processBoundary: { invoke(value) { invoked = value; return { data: null }; } }, binding, deadlineMs: 1_000, maxOutputBytes: 2_048, clock: { now: () => 1_000 } });
  await transport.request({ method: "GET", path: "/nodes/h/qemu/901/config" });
  assert.deepEqual(invoked.payload, { schemaVersion: 1, binding, deadlineAt: new Date(2_000).toISOString(), maxOutputBytes: 2_048, request: { method: "GET", path: "/nodes/h/qemu/901/config" } });
});

test("installed guest helper protocol gates readiness, isolated auth, and three task surfaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-installed-helper-"));
  const config = await configFixture();
  const binding = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot };
  await mkdir(join(root, "etc/nelos-desktop"), { recursive: true }); await mkdir(join(root, "var/lib/nelos-desktop/observations"), { recursive: true });
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(binding));
  await writeFile(join(root, "var/lib/nelos-desktop/gui-ready.json"), JSON.stringify({ ready: true, accessibilityBus: true, captureReady: true, sessionUser: "nelosauto", runId: binding.runId }));
  await writeFile(join(root, "var/lib/nelos-desktop/device-auth.json"), JSON.stringify({ accounts: [{ automation: true, subject: "automation-subject" }], binding, developerSessionImported: false, modelBacked: true, sessionId: "run-session" }));
  const surface = { schemaVersion: 1, taskId: config.run.scenarios[0].task.taskId, title: "scenario-1", lifecycle: "active", runId: binding.runId, fencingToken: binding.fencingToken, producer: "native-codex", observedAt: new Date().toISOString() };
  for (const [name, producer] of [["native", "native-codex"], ["mcp", "ordinary-nelos-mcp"], ["desktop", "visible-codex-desktop"]]) await writeFile(join(root, `var/lib/nelos-desktop/observations/${name}.json`), JSON.stringify({ ...surface, producer }));
  const helper = new URL("../validation/proxmox/desktop/helpers/nelos-desktop-atspi.mjs", import.meta.url).pathname;
  const envelope = (operation, payload = {}) => `${JSON.stringify({ schemaVersion: 1, binding, operation, payload, byteLength: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 65_536 })}\n`;
  assert.equal((await runHelper(helper, "gui_ready", envelope("gui_ready"), { NELOS_DESKTOP_HELPER_ROOT: root })).ready, true);
  assert.equal((await runHelper(helper, "auth_status", envelope("auth_status"), { NELOS_DESKTOP_HELPER_ROOT: root })).accountCount, 1);
  assert.equal((await runHelper(helper, "compare_task_surfaces", envelope("compare_task_surfaces", { taskId: surface.taskId, title: surface.title, lifecycle: surface.lifecycle }), { NELOS_DESKTOP_HELPER_ROOT: root })).matched, true);
});

test("host observation staging helper produces run- and fence-bound runtime inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-observation-stage-")); const config = await configFixture();
  const binding = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot };
  await mkdir(join(root, "etc/nelos-desktop"), { recursive: true }); const observationRoot = join(root, "staged-observations"); await mkdir(observationRoot, { mode: 0o700 });
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(binding)); await writeFile(join(root, "etc/nelos-desktop/observation-staging.json"), JSON.stringify({ runId: binding.runId, observationRoot }));
  const observation = { schemaVersion: 1, runId: binding.runId, fencingToken: binding.fencingToken, taskId: config.run.scenarios[0].task.taskId, title: "scenario-1", lifecycle: "active", observedAt: new Date().toISOString(), producer: "native-codex" };
  const input = `${JSON.stringify({ schemaVersion: 1, binding, kind: "task-native", phase: null, observation, deadlineAt: new Date(Date.now() + 30_000).toISOString() })}\n`;
  const helper = new URL("../validation/proxmox/desktop/helpers/nelos-task-observation-stage.mjs", import.meta.url).pathname;
  assert.equal((await runHelper(helper, "stage", input, { NELOS_DESKTOP_HELPER_ROOT: root })).staged, true);
  assert.deepEqual(JSON.parse(await readFile(join(observationRoot, "task/native.json"), "utf8")), observation);
});

test("installed archive helper validates the bound operation and visual report digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-installed-archive-")); const config = await configFixture();
  const binding = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot };
  await mkdir(join(root, "etc/nelos-desktop"), { recursive: true }); await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(binding));
  const report = Buffer.from('{"schemaVersion":1,"kind":"nelos-developer-visual-state-validation"}\n'); const digest = `sha256:${createHash("sha256").update(report).digest("hex")}`;
  const control = join(root, "archive-control.mjs");
  const controlOutput = JSON.stringify({ visualEvidence: { reportBytesBase64: report.toString("base64"), reportDigest: digest, sidebarThreadIds: [], createdTasksThreadIds: [], mcpVisualThreadIds: [] } });
  await writeFile(control, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${controlOutput}'\n`); await chmod(control, 0o755);
  const helper = new URL("../validation/proxmox/desktop/helpers/nelos-desktop-archive.mjs", import.meta.url).pathname;
  const input = `${JSON.stringify({ schemaVersion: 1, binding, operation: "observe_checkpoint", payload: { sequence: 1 }, byteLength: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 65_536 })}\n`;
  const result = await runHelper(helper, "observe_checkpoint", input, { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_ARCHIVE_CONTROL: control });
  assert.equal(result.visualEvidence.reportDigest, digest);
});

test("production GUI wrapper makes readiness, auth, and cross-surface checks real execution gates", async () => {
  const config = await configFixture(); const operations = [];
  const client = { async invoke({ operation, payload }) { operations.push(operation); if (operation === "gui_ready") return { ready: true, accessibilityBus: true, captureReady: true }; if (operation === "auth_status") return { modelBacked: true, developerSessionImported: false, automationUser: "nelosauto", runId: config.run.runId, accountCount: 1 }; return { matched: true, taskId: payload.taskId, lifecycle: payload.lifecycle }; } };
  const driver = { async runScenario(scenario) { return { outcome: "passed", taskId: scenario.task.taskId }; } };
  const surfaceObserver = { async observeTask({ taskId, title, lifecycle }) { return { native: { taskId, title, lifecycle }, mcp: { taskId, title, lifecycle }, desktop: { taskId, title, lifecycle } }; } };
  const wrapped = new ProductionGuiDriverV1({ driver, client, admitted: { run: config.run, plan: config.plan }, surfaceObserver });
  await wrapped.runScenario(config.run.scenarios[0]);
  assert.deepEqual(operations, ["gui_ready", "auth_status", "stage_task_surfaces", "compare_task_surfaces"]);
});

test("factory runtime drives the real resumable runner through bound GUI, archive, evidence, and cleanup paths", async () => {
  const config = await configFixture(); const scenario = config.run.scenarios[0]; const events = [];
  config.plan.operationUsage.provision = { ...zero(), wallTimeMs: 1_000 };
  config.plan.operationUsage.cleanup = { ...zero(), wallTimeMs: 1_000 };
  config.plan.operationUsage.quarantine = { ...zero(), wallTimeMs: 1_000 };
  config.plan.scenarioUsage[scenario.scenarioId] = { ...zero(), taskCount: 1, modelTurnCount: 1, spendUsd: 0.1, wallTimeMs: scenario.deadlineMs };
  config.plan.archiveConvergence.operationUsage = { ...zero(), wallTimeMs: 30_000, screenshotCount: 2, screenshotBytes: 2_048 };
  await writeFile(join(config.homelab.sealedValueRoot, "benchmark-input-1.sealed"), "bounded-input", { mode: 0o600 });
  await mkdir(join(config.homelab.observationRoot, "task"), { recursive: true });
  await mkdir(join(config.homelab.observationRoot, "archive", "afterCleanup"), { recursive: true }); await mkdir(join(config.homelab.observationRoot, "archive", "afterRestart"), { recursive: true });
  const observedAt = "2026-08-19T12:01:00.000Z";
  for (const [name, producer] of [["native", "native-codex"], ["mcp", "ordinary-nelos-mcp"], ["desktop", "visible-codex-desktop"]]) await writeFile(join(config.homelab.observationRoot, "task", `${name}.json`), JSON.stringify({ schemaVersion: 1, runId: config.run.runId, fencingToken: config.run.lease.fencingToken, taskId: scenario.task.taskId, title: scenario.scenarioId, lifecycle: "active", observedAt, producer }));
  for (const phase of ["afterCleanup", "afterRestart"]) for (const name of ["native", "mcp", "desktop", "workers"]) await writeFile(join(config.homelab.observationRoot, "archive", phase, `${name}.json`), JSON.stringify({ schemaVersion: 1, runId: config.run.runId, fencingToken: config.run.lease.fencingToken, observedAt, phase, producer: name }));
  const binding = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken };
  let present = false;
  const providerAdapter = {
    async inspectVm() { return present ? { ...binding, imageId: config.run.goldenImage.imageId, state: "running" } : null; },
    async cloneVm() { events.push("provider:clone"); present = true; return { status: "committed", providerOperationId: "clone" }; },
    async configureVm() { return { status: "committed", providerOperationId: "configure" }; },
    async startVm() { return { status: "committed", providerOperationId: "start" }; },
    async stopVm() { return { status: "committed", providerOperationId: "stop" }; },
    async destroyVm() { events.push("provider:destroy"); present = false; return { status: "committed", providerOperationId: "destroy" }; },
    async quarantineVm() { return { status: "committed", providerOperationId: "quarantine" }; },
    async waitForQga() { return { ready: true, user: "nelosauto", session: "graphical" }; },
    async attestVmAbsent() { return { ...binding, absent: !present }; },
    async reconcileMutation() { return { status: "committed" }; },
    async commitReceipt(receipt) { return { committed: true, receiptId: receipt.receiptId, attestationDigest: receipt.attestationDigest }; },
  };
  const tasks = [scenario.task.taskId];
  const visualBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: "nelos-developer-visual-state-validation", capture: { digest: `sha256:${"a".repeat(64)}` }, outcome: "passed", counts: {}, findings: [] })}\n`);
  const visualDigest = `sha256:${createHash("sha256").update(visualBytes).digest("hex")}`;
  const qgaClient = { admitted: { run: config.run }, maxOutputBytes: 1_048_576, async invoke({ operation, payload }) {
    events.push(`helper:${operation}`);
    if (operation === "gui_ready") return { ready: true, accessibilityBus: true, captureReady: true };
    if (operation === "auth_status") return { modelBacked: true, developerSessionImported: false, automationUser: "nelosauto", runId: config.run.runId, accountCount: 1 };
    if (operation === "list_tasks") return [...tasks];
    if (operation === "activate_expected_task") return { taskId: payload.taskId, createdForScenario: payload.scenarioId, fresh: true };
    if (operation === "active_task") return { taskId: tasks.at(-1) };
    if (["click", "type_text"].includes(operation)) return { ok: true };
    if (operation === "protected_capture_regions") return [{ kind: "conversation", x: 0, y: 0, width: 2, height: 2 }, { kind: "credential", x: 2, y: 0, width: 2, height: 2 }];
    if (operation === "capture_screenshot") return Buffer.from("protected-checkpoint");
    if (operation === "task_state") return true;
    if (operation === "health") return { crashed: false, stalled: false };
    if (operation === "compare_task_surfaces") return { matched: true, taskId: payload.taskId, lifecycle: payload.lifecycle };
    if (["stage_task_surfaces", "stage_archive_observations"].includes(operation)) return { staged: true };
    if (operation === "archive_tasks") return payload.expectedThreads.map(({ threadId }, index) => ({ schemaVersion: 1, type: "native-archive", actionId: `archive-${index}`, threadId, archived: true }));
    if (operation === "observe_checkpoint") {
      const appInstanceId = payload.phase === "afterRestart" ? "desktop-app-2" : "desktop-app-1";
      return { sequence: payload.sequence, observedAt: `2026-08-19T12:01:0${payload.sequence}.000Z`, phase: payload.phase, appInstanceId, cleanupState: "complete", nelosWorkers: [{ workerId: "worker-1", archivedThreadIds: [scenario.task.taskId] }], ordinaryMapThreadIds: [], nativeVisibleThreadIds: [], visualEvidence: { reportBytesBase64: visualBytes.toString("base64"), reportDigest: visualDigest, sidebarThreadIds: [], createdTasksThreadIds: [], mcpVisualThreadIds: [] } };
    }
    if (operation === "restart_desktop") return { schemaVersion: 1, type: "desktop-restart", previousAppInstanceId: payload.previousAppInstanceId, newAppInstanceId: "desktop-app-2", restarted: true };
    throw new Error(`unexpected helper operation ${operation}`);
  } };
  const clock = { now: () => Date.parse("2026-08-19T12:01:00.000Z") };
  const runtime = await createHomelabRemoteDesktopRuntimeV1(config, { providerAdapter, qgaClient, clock });
  const runner = new ResumableRemoteDesktopRunnerV1({ journalDirectory: config.journalDirectory, ...runtime, clock });
  const result = await runner.start({ run: config.run, plan: config.plan, candidateDigest: config.candidateDigest, currentLease: config.currentLease, now: Date.parse("2026-08-19T12:00:00.000Z") });
  assert.equal(result.run.state, "succeeded", JSON.stringify(result.failure));
  assert.ok(events.indexOf("helper:compare_task_surfaces") < events.indexOf("provider:destroy"));
  assert.ok(events.indexOf("helper:observe_checkpoint") < events.indexOf("provider:destroy"));
  assert.equal(result.terminalOutcome.outcome, "destroyed");
  assert.ok(result.evidence?.inventory);
});

test("evidence capture requires complete protected geometry before requesting pixels", async () => {
  const config = await configFixture(); config.plan.evidence.screenshots = [{ artifactId: "shot-1", scenarioId: "scenario-1", maxOutputBytes: 50_000 }];
  const operations = [];
  const client = {
    admitted: { run: config.run }, maxOutputBytes: 1_048_576,
    async invoke({ operation }) { operations.push(operation); return [{ kind: "conversation", x: 0, y: 0, width: 10, height: 10 }]; },
  };
  const collector = new HomelabEvidenceCollectorV1({ client, plan: config.plan });
  await assert.rejects(collector.collect({ run: config.run, scenarioResults: [{ scenarioId: "scenario-1" }] }), (error) => error.code === "PROTECTED_GEOMETRY_UNAVAILABLE");
  assert.deepEqual(operations, ["protected_capture_regions"]);
});

test("receipt persistence rejects altered bytes and reconciliation rejects altered attestations", async () => {
  const config = await configFixture(); const store = new AtomicProviderReceiptStoreV1(join(config.homelab.stateRoot, "receipts-test"));
  const first = { receiptId: "receipt-1", attestationDigest: `sha256:${"a".repeat(64)}` };
  await store.commit(first);
  await assert.rejects(store.commit({ ...first, attestationDigest: `sha256:${"b".repeat(64)}` }), (error) => error.code === "ALTERED_RECEIPT");

  const binding = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken };
  const admitted = { run: config.run, plan: config.plan, binding };
  const reconciler = new HomelabProviderReconcilerV1({ adapter: {}, receiptStore: { async read(receiptId) { return { receiptId, ...binding, operation: "destroy", operationId: "op-destroy", mutationStatus: "committed", attestationDigest: `sha256:${"f".repeat(64)}` }; } }, admitted, clock: { now: () => Date.parse("2026-08-19T12:00:00.000Z") } });
  const effect = { kind: "destroy", request: { operationId: "op-destroy", runId: config.run.runId, provider: config.run.provider, lease: config.run.lease, automation: config.plan.automation, reservation: config.plan.reservation } };
  await assert.rejects(reconciler.reconcile(effect), (error) => error.code === "ALTERED_RECEIPT");
});
