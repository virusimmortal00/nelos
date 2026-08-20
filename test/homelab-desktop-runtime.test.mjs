import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArchiveProjectionLaneV1 } from "nelos/archive-projection-lane";
import { DesktopGuiScenarioDriver } from "nelos/desktop-gui-scenario-driver";
import {
  AtomicProviderReceiptStoreV1,
  BoundedJsonProcessV1,
  HomelabEvidenceCollectorV1,
  HomelabProviderReconcilerV1,
  ProxmoxQgaHelperClientV1,
  createHomelabRemoteDesktopRuntimeV1,
} from "nelos/homelab-desktop-runtime";
import { ProxmoxDesktopControllerV1 } from "nelos/remote-desktop-runner";
import { ProxmoxVeDesktopAdapterV1 } from "../validation/proxmox-desktop/v1/backend/index.mjs";
import { currentLeaseFor, validRemoteDesktopRunV1 } from "./fixtures/remote-desktop-contract-v1.mjs";

const zero = () => ({ taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 0, screenshotCount: 0, screenshotBytes: 0, recordingDurationMs: 0, recordingBytes: 0, diagnosticLogCount: 0, diagnosticLogBytes: 0 });

async function configFixture() {
  const run = validRemoteDesktopRunV1(); run.scenarios = [run.scenarios[0]];
  const base = await mkdtemp(join(tmpdir(), "nelos-homelab-runtime-"));
  const stateRoot = join(base, run.runId); const sealedValueRoot = join(base, "sealed", run.runId);
  await mkdir(sealedValueRoot, { recursive: true, mode: 0o700 });
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
      schemaVersion: 1, stateRoot, sealedValueRoot,
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
  assert.ok(runtime.guiDriver instanceof DesktopGuiScenarioDriver);
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
