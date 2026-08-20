import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArchiveProjectionLaneV1 } from "nelos/archive-projection-lane";
import {
  AtomicProviderReceiptStoreV1,
  BoundedJsonProcessV1,
  HomelabEvidenceCollectorV1,
  HomelabArchiveAdapterV1,
  HomelabProviderReconcilerV1,
  ProxmoxQgaHelperClientV1,
  PROXMOX_SSH_TRANSPORT_EXECUTABLE_V1,
  ProductionGuiDriverV1,
  HomelabProxmoxTransportV1,
  createHomelabRemoteDesktopRuntimeV1,
} from "nelos/homelab-desktop-runtime";
import { AtomicRemoteDesktopJournal, ProxmoxDesktopControllerV1, ResumableRemoteDesktopRunnerV1 } from "nelos/remote-desktop-runner";
import { sha256 } from "nelos/proxmox-desktop-runtime";
import { createProductionGuestTaskIntentV1, productionGuestTaskDigestV1 } from "nelos/production-guest-task";
import { createCredentialTerminalDispositionV1, ProxmoxVeDesktopAdapterV1 } from "../validation/proxmox-desktop/v1/backend/index.mjs";
import { canonicalLeaseAuthorityBytesV1, leaseAuthoritySha256V1 } from "../src/proxmox-lease-authority.mjs";
import { FIXTURE_NETWORK_POLICY_ADDRESS_DIGEST_V1, FIXTURE_NETWORK_POLICY_RULESET_DIGEST_V1, currentLeaseFor, validRemoteDesktopRunV1 } from "./fixtures/remote-desktop-contract-v1.mjs";
import { createLeaseAuthorityIssueFixtureV1 } from "./support/fake-proxmox-lease-authority.mjs";

const zero = () => ({ taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 0, screenshotCount: 0, screenshotBytes: 0, recordingDurationMs: 0, recordingBytes: 0, diagnosticLogCount: 0, diagnosticLogBytes: 0 });
const accountBindingDigest = `sha256:${"9".repeat(64)}`;
const installedDesktopIdentity = () => ({
  appServer: { platformFamily: "unix", platformOs: "linux", userAgent: "Codex Desktop/0.148.0-alpha.15" },
  bakeReceiptDigest: `sha256:${"b".repeat(64)}`,
  bundledCodex: { digest: "sha256:f13176129580681cf3024192f1ad43535c9933b24b7eca89e90fa57b3f4855fc", gid: 0, mode: "0755", path: "/usr/lib/chatgpt/resources/codex", uid: 0, version: "0.148.0-alpha.15" },
  bundledNode: { digest: "sha256:bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12", gid: 0, mode: "0755", path: "/usr/lib/chatgpt/resources/cua_node/bin/node", uid: 0, version: "24.19.0" },
  desktopPackage: { architecture: "amd64", digest: "sha256:4778b26a7abd08647214d5b05c17bd3ebe2d9688d146dabf017c1a2faf93ac7d", name: "chatgpt", version: "26.814.41957" },
  kind: "nelos-desktop-installed-identity", lockId: "nelos-proxmox-desktop-ubuntu-24.04-amd64-20260819",
  packageLockDigest: "sha256:9925b56c881ae22ffe6a3d22f8a2066b7ae2b4a4613029c2f79cb024a0398e93", schemaVersion: 1, verified: true,
});
const canonicalJson = (value) => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);

function credentialBoundaryFor(config) {
  const unsigned = {
    schemaVersion: 1, type: "nelos.credential-volatility.v1", runId: config.run.runId,
    fencingToken: config.run.lease.fencingToken, vmId: config.run.provider.vmId, imageId: config.run.goldenImage.imageId,
    codexHome: "/home/nelosauto/.codex", filesystemType: "tmpfs", mountOptions: ["nodev", "noexec", "nosuid", "rw"],
    swapActive: false, volatile: true, bootIdDigest: `sha256:${"6".repeat(64)}`, secretBytesIncluded: false,
  };
  return { ...unsigned, attestationDigest: `sha256:${createHash("sha256").update(`${canonicalJson(unsigned)}\n`).digest("hex")}` };
}

function liveAuth(config, observedAt = new Date().toISOString(), digest = accountBindingDigest) {
  const base = {
    schemaVersion: 1, type: "live-device-auth-attestation", source: "codex-app-server-account-read",
    runId: config.run.runId, fencingToken: config.run.lease.fencingToken, automationUser: config.plan.automation.user,
    authenticated: true, accountType: "chatgpt", authMethod: "chatgptDeviceCode", credentialStore: "file",
    developerSessionImported: false, accountBindingDigest: digest, authReceiptDigest: `sha256:${"8".repeat(64)}`, observedAt,
  };
  return { ...base, attestationDigest: sha256(base) };
}

function networkPolicyObservation(run, now = Date.now()) {
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

function runHelper(executable, operation, input, env = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const runtime = executable.endsWith(".py") ? "/usr/bin/python3" : process.execPath;
    const child = spawn(runtime, [executable, operation], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => code === 0 ? resolvePromise(JSON.parse(Buffer.concat(stdout))) : rejectPromise(Object.assign(new Error(Buffer.concat(stderr).toString("utf8")), { exitCode: code })));
    child.stdin.end(input);
  });
}

async function configFixture() {
  const run = validRemoteDesktopRunV1(); run.scenarios = [run.scenarios[0]];
  const base = await realpath(await mkdtemp(join(tmpdir(), "nelos-homelab-runtime-")));
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
      guiBindings: { "task-composer": { role: "textbox" }, "submit-key": { role: "textbox", key: "ENTER" }, "active-task": { role: "document" }, "task-complete": { state: "complete" } },
      deadlines: { providerMs: 1_000, qgaMs: 1_000, archiveMs: 30_000 },
      outputLimits: { providerBytes: 1_048_576, qgaBytes: 1_048_576, archiveReportBytes: 1_048_576 },
    },
  };
}

async function productionFactoryFixture() {
  const config = await configFixture();
  const now = Date.now();
  config.run.lease.expiresAt = new Date(now + 1_800_000).toISOString();
  config.currentLease.expiresAt = config.run.lease.expiresAt;
  config.run.provider.vmId = "9401";
  config.plan.reservation.vmId = "9401";
  config.currentLease.vmId = "9401";
  const base = await realpath(await mkdtemp(join(tmpdir(), "nelos-production-factory-")));
  const rootPaths = { evidence: join(base, "evidence"), packet: join(base, "packet"), recovery: join(base, "recovery"), staging: join(base, "staging") };
  const roots = {};
  for (const [name, path] of Object.entries(rootPaths)) {
    await mkdir(path, { mode: 0o700 });
    const info = await lstat(path);
    roots[name] = { gid: info.gid, mode: "0700", path, sealed: true, uid: info.uid };
  }
  config.plan.evidence.bundleDirectory = join(rootPaths.evidence, "bundle");
  config.homelab.sealedValueRoot = join(rootPaths.staging, "sealed-values");
  config.homelab.observationRoot = join(rootPaths.staging, "observations");
  await mkdir(config.homelab.sealedValueRoot, { mode: 0o700 });
  await mkdir(config.homelab.observationRoot, { mode: 0o700 });
  const scenario = config.run.scenarios[0];
  const taskIntent = createProductionGuestTaskIntentV1({
    runId: config.run.runId, fencingToken: config.run.lease.fencingToken,
    scenarioId: scenario.scenarioId, title: scenario.scenarioId,
  });
  scenario.task.taskId = taskIntent.taskSlotId;
  const leaseAuthority = createLeaseAuthorityIssueFixtureV1({ run: config.run, observedAt: new Date(now - 1_000).toISOString() });
  config.leaseAuthority = structuredClone(leaseAuthority.observation);
  const binding = {
    fencingToken: config.run.lease.fencingToken, gatewayId: config.run.provider.gatewayId, hostId: config.run.provider.hostId,
    leaseId: config.run.lease.leaseId, macAddress: config.run.provider.macAddress, networkId: config.run.provider.networkId,
    networkPolicyDigest: config.run.provider.networkPolicyDigest, providerId: config.run.provider.providerId,
    runId: config.run.runId, vmid: Number(config.run.provider.vmId),
  };
  const taskIntentDigest = productionGuestTaskDigestV1(taskIntent);
  const taskIntentPath = join(rootPaths.packet, `production-task-intent-${taskIntentDigest.slice(7)}.json`);
  await writeFile(taskIntentPath, `${canonicalJson(taskIntent)}\n`, { mode: 0o400 }); await chmod(taskIntentPath, 0o400);
  const buildId = "0123456789abcdef0123456789abcdef";
  const sourceTemplate = { vmId: 8001, name: "nelos-ubuntu-source", configDigest: sha256({ fixture: "source-template" }) };
  const immutableInputs = {
    packageLockDigest: sha256({ fixture: "package-lock" }), packerHclDigest: sha256({ fixture: "packer-hcl" }),
    recipeDigest: sha256({ fixture: "recipe" }), sourceCommit: "a".repeat(40), sourceInputsDigest: sha256({ fixture: "source-inputs" }),
    toolchainLockDigest: sha256({ fixture: "toolchain-lock" }), wrapperDigest: sha256({ fixture: "wrapper" }),
  };
  const outputConfig = { description: `nelos-golden-v1:${buildId}`, name: config.run.goldenImage.imageId, tags: `nelos-golden;nelos-build-${buildId}`, template: 1 };
  const goldenImageDigest = sha256({ schemaVersion: 1, domain: "nelos-proxmox-desktop-recipe-config-v1", immutableInputs, sourceTemplate, outputConfig });
  config.run.goldenImage.digest = goldenImageDigest;
  const goldenUnsigned = {
    schemaVersion: 1, kind: "nelos-proxmox-desktop-golden-image",
    reservation: {
      reservationId: "golden-reservation-fixture", providerId: config.run.provider.providerId, apiUrl: "https://prox2.example.test/api2/json",
      node: config.run.provider.hostId, storage: "local-lvm", sourceTemplate,
      outputTemplate: { vmId: config.plan.goldenImageTemplateVmId, name: config.run.goldenImage.imageId },
    },
    immutableInputs,
    buildArtifact: { target: "desktop.proxmox-clone.desktop", builderId: "proxmox.clone", artifactId: String(config.plan.goldenImageTemplateVmId), machineOutputDigest: sha256({ fixture: "machine-output" }) },
    output: { config: outputConfig, configDigest: sha256(outputConfig), providerConfigDigest: sha256({ fixture: "provider-config" }), status: "stopped", template: true },
    goldenImage: { algorithm: "nelos-proxmox-desktop-recipe-config-v1", imageId: config.run.goldenImage.imageId, templateVmId: String(config.plan.goldenImageTemplateVmId), digest: goldenImageDigest },
    independentAttestation: { tokenId: "fixture-attestor", observedAt: "2026-08-20T12:00:00.000Z" },
  };
  const goldenReceipt = { ...goldenUnsigned, attestationDigest: sha256(goldenUnsigned) };
  const goldenReceiptPath = join(rootPaths.packet, `golden-image-${goldenReceipt.attestationDigest.slice(7)}.json`);
  await writeFile(goldenReceiptPath, `${canonicalJson(goldenReceipt)}\n`, { mode: 0o400 }); await chmod(goldenReceiptPath, 0o400);
  const packet = {
    authorization: { gateId: "gate-production-factory", runId: config.run.runId, used: false },
    binding,
    budgets: { captureCount: 1, runDeadlineAt: new Date(Date.parse(config.run.lease.expiresAt) - 1_000).toISOString(), stepDeadlineMs: scenario.deadlineMs },
    capture: { height: 1080, protectedRegions: [], width: 1920 },
    expectedTask: { intentDigest: taskIntentDigest, intentPath: taskIntentPath, taskSlotId: taskIntent.taskSlotId, title: scenario.scenarioId },
    goldenImageReceipt: { attestationDigest: goldenReceipt.attestationDigest, path: goldenReceiptPath },
    lease: { active: true, binding, expiresAt: config.run.lease.expiresAt, observedAt: leaseAuthority.observation.observedAt },
    leaseAuthority: structuredClone(leaseAuthority.authorityBinding),
    roots,
    schemaVersion: 1,
  };
  config.runPacket = { digest: sha256(packet), packet };
  const gateReceipt = { schemaVersion: 1, gateId: packet.authorization.gateId, runId: config.run.runId, used: true };
  const currentLeaseUnsigned = {
    authorityObservation: structuredClone(leaseAuthority.observation),
    authorityObservationDigest: sha256(leaseAuthority.observation),
    kind: "nelos.proxmox-desktop.current-lease-observation.v2",
    schemaVersion: 2,
  };
  const currentLeaseObservation = { ...currentLeaseUnsigned, observationDigest: sha256(currentLeaseUnsigned) };
  const productionAdmission = {
    packetDigest: config.runPacket.digest,
    gateReceipt,
    gateReceiptDigest: sha256(gateReceipt),
    currentLeaseObservation,
    currentLeaseObservationDigest: currentLeaseObservation.observationDigest,
    leaseAuthority: {
      binding: structuredClone(packet.leaseAuthority),
      issuedObservationDigest: sha256(config.leaseAuthority),
    },
    runDeadlineAt: packet.budgets.runDeadlineAt,
    taskIntentReceipt: taskIntent,
    goldenImageVerification: {
      attestationDigest: goldenReceipt.attestationDigest,
      goldenImageDigest: goldenReceipt.goldenImage.digest,
      hostId: goldenReceipt.reservation.node,
      imageId: goldenReceipt.goldenImage.imageId,
      outputConfigDigest: goldenReceipt.output.configDigest,
      packageLockDigest: goldenReceipt.immutableInputs.packageLockDigest,
      providerId: goldenReceipt.reservation.providerId,
      sourceCommit: goldenReceipt.immutableInputs.sourceCommit,
      templateVmId: goldenReceipt.goldenImage.templateVmId,
    },
  };
  const goldenObservation = {
    providerId: goldenReceipt.reservation.providerId, hostId: goldenReceipt.reservation.node,
    templateVmId: goldenReceipt.goldenImage.templateVmId, config: structuredClone(goldenReceipt.output.config),
    status: goldenReceipt.output.status, template: goldenReceipt.output.template,
  };
  return { config, goldenObservation, productionAdmission };
}

function cleanupOnlyProductionAdmission(config, productionAdmission, observedAt) {
  const previous = productionAdmission.currentLeaseObservation.authorityObservation.record;
  const unsignedRecord = {
    ...structuredClone(previous),
    previousRecordDigest: previous.recordDigest,
    revision: previous.revision + 1,
    state: "cleanup-only",
    transition: { at: new Date(observedAt).toISOString(), operation: "cleanup-only", reason: "runtime cleanup-only recovery test" },
  };
  delete unsignedRecord.recordDigest;
  const record = { ...unsignedRecord, recordDigest: leaseAuthoritySha256V1(unsignedRecord) };
  const recordBytes = canonicalLeaseAuthorityBytesV1(record);
  const authorityObservation = {
    ...structuredClone(productionAdmission.currentLeaseObservation.authorityObservation),
    observedAt: new Date(observedAt).toISOString(),
    record,
    recordBytesBase64: recordBytes.toString("base64"),
    recordDigest: record.recordDigest,
    recordFileDigest: leaseAuthoritySha256V1(recordBytes),
  };
  const unsignedReceipt = {
    authorityObservation,
    authorityObservationDigest: sha256(authorityObservation),
    kind: "nelos.proxmox-desktop.current-lease-observation.v2",
    schemaVersion: 2,
  };
  const currentLeaseObservation = { ...unsignedReceipt, observationDigest: sha256(unsignedReceipt) };
  return {
    ...productionAdmission,
    currentLeaseObservation,
    currentLeaseObservationDigest: currentLeaseObservation.observationDigest,
    recoveryMode: "cleanup-only",
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

test("production factory proves independent attestor availability and exact VM absence before exposing mutation", async () => {
  const makeOptions = (config, productionAdmission, goldenObservation, providerAdapter, independentProviderAdapter) => ({
    productionAdmission,
    providerAdapter: { ...providerAdapter, inspectGoldenImage: providerAdapter.inspectGoldenImage ?? (async () => structuredClone(goldenObservation)) },
    independentProviderAdapter: {
      ...independentProviderAdapter,
      inspectGoldenImage: independentProviderAdapter.inspectGoldenImage ?? (async () => structuredClone(goldenObservation)),
      attestNetworkPolicy: independentProviderAdapter.attestNetworkPolicy ?? (async () => networkPolicyObservation(config.run)),
    },
    qgaClient: { invoke() { throw new Error("QGA must not run during factory preflight"); } },
    taskSurfaceObserver: { observeTask() { throw new Error("surface observation must not run during factory preflight"); } },
    archiveSurfaceObserver: { observeArchive() { throw new Error("archive observation must not run during factory preflight"); } },
  });

  {
    const { config, goldenObservation, productionAdmission } = await productionFactoryFixture();
    productionAdmission.leaseAuthority.issuedObservationDigest = `sha256:${"0".repeat(64)}`;
    let reads = 0;
    const adapter = { async inspectVm() { reads += 1; return null; } };
    await assert.rejects(
      createHomelabRemoteDesktopRuntimeV1(config, makeOptions(config, productionAdmission, goldenObservation, adapter, adapter)),
      (error) => error.code === "PRODUCTION_ADMISSION_REQUIRED",
    );
    assert.equal(reads, 0);
  }

  {
    const { config, goldenObservation, productionAdmission } = await productionFactoryFixture();
    productionAdmission.runDeadlineAt = new Date(Date.parse(config.runPacket.packet.budgets.runDeadlineAt) + 1_000).toISOString();
    let reads = 0;
    const adapter = { async inspectVm() { reads += 1; return null; } };
    await assert.rejects(
      createHomelabRemoteDesktopRuntimeV1(config, makeOptions(config, productionAdmission, goldenObservation, adapter, adapter)),
      (error) => error.code === "PRODUCTION_ADMISSION_REQUIRED",
    );
    assert.equal(reads, 0);
  }

  {
    const { config, goldenObservation, productionAdmission } = await productionFactoryFixture();
    let mutations = 0; let mutationReads = 0; let observed = null;
    const providerAdapter = { async inspectVm() { mutationReads += 1; return null; }, async cloneVm() { mutations += 1; } };
    const failure = Object.assign(new Error("independent SSH host verification failed"), { code: "SSH_HOST_KEY_MISMATCH" });
    const independentProviderAdapter = { async inspectVm(request) { observed = request; throw failure; }, async attestVmAbsent() { throw new Error("not reached"); } };
    await assert.rejects(createHomelabRemoteDesktopRuntimeV1(config, makeOptions(config, productionAdmission, goldenObservation, providerAdapter, independentProviderAdapter)), (error) => error === failure);
    assert.deepEqual(observed, config.run.provider);
    assert.equal(mutationReads, 0);
    assert.equal(mutations, 0);
  }

  {
    const { config, goldenObservation, productionAdmission } = await productionFactoryFixture();
    let mutations = 0; let mutationReads = 0;
    const providerAdapter = { async inspectVm() { mutationReads += 1; return null; }, async cloneVm() { mutations += 1; } };
    const independentProviderAdapter = { async inspectVm() { return { ...config.run.provider, state: "running" }; }, async attestVmAbsent() { throw new Error("not reached"); } };
    await assert.rejects(createHomelabRemoteDesktopRuntimeV1(config, makeOptions(config, productionAdmission, goldenObservation, providerAdapter, independentProviderAdapter)), (error) => error.code === "VM_RESERVATION_NOT_EMPTY");
    assert.equal(mutationReads, 0);
    assert.equal(mutations, 0);
  }

  {
    const { config, goldenObservation, productionAdmission } = await productionFactoryFixture();
    let mutations = 0; let probes = 0;
    const providerAdapter = { async inspectVm() { return null; }, async cloneVm() { mutations += 1; } };
    const independentProviderAdapter = { async inspectVm(request) { probes += 1; assert.deepEqual(request, config.run.provider); return null; }, async attestVmAbsent() { return { ...config.run.provider, absent: true }; } };
    const runtime = await createHomelabRemoteDesktopRuntimeV1(config, makeOptions(config, productionAdmission, goldenObservation, providerAdapter, independentProviderAdapter));
    assert.equal(typeof runtime.productionGuard.attestAfterDestroy, "function");
    assert.equal(runtime.providerController.runDeadlineAt, config.runPacket.packet.budgets.runDeadlineAt);
    assert.equal(probes, 1);
    assert.equal(mutations, 0);
  }

  {
    const { config, goldenObservation, productionAdmission } = await productionFactoryFixture();
    const observation = networkPolicyObservation(config.run);
    observation.expiresAt = new Date(Date.now() + 600_000).toISOString();
    observation.measurement.expiresAt = observation.expiresAt;
    const { measurementDigest: ignoredMeasurement, ...unsignedMeasurement } = observation.measurement;
    observation.measurement.measurementDigest = sha256(unsignedMeasurement);
    const { observationDigest: ignoredObservation, ...unsignedObservation } = observation;
    observation.observationDigest = sha256(unsignedObservation);
    let probes = 0;
    const providerAdapter = { async inspectVm() { probes += 1; return null; } };
    const independentProviderAdapter = { async inspectVm() { probes += 1; return null; }, async attestNetworkPolicy() { return observation; }, async attestVmAbsent() {} };
    await assert.rejects(
      createHomelabRemoteDesktopRuntimeV1(config, makeOptions(config, productionAdmission, goldenObservation, providerAdapter, independentProviderAdapter)),
      (error) => error.code === "NETWORK_POLICY_OBSERVATION_STALE",
    );
    assert.equal(probes, 0, "policy elements that expire before run plus cleanup must block every provider read");
  }

  for (const driftSide of ["primary", "independent"]) {
    const { config, goldenObservation, productionAdmission } = await productionFactoryFixture();
    let mutations = 0;
    const drifted = { ...goldenObservation, status: "running" };
    const providerAdapter = { async inspectVm() { return null; }, async cloneVm() { mutations += 1; }, ...(driftSide === "primary" ? { async inspectGoldenImage() { return drifted; } } : {}) };
    const independentProviderAdapter = { async inspectVm() { return null; }, async attestVmAbsent() { throw new Error("not reached"); }, ...(driftSide === "independent" ? { async inspectGoldenImage() { return drifted; } } : {}) };
    await assert.rejects(createHomelabRemoteDesktopRuntimeV1(config, makeOptions(config, productionAdmission, goldenObservation, providerAdapter, independentProviderAdapter)), (error) => error.code === "GOLDEN_IMAGE_ATTESTATION_MISMATCH");
    assert.equal(mutations, 0);
  }
});

test("fresh-process resume and cancel accept only the exact journal-consistent post-provision VM", async () => {
  for (const operationMode of ["resume", "cancel"]) {
    const { config, productionAdmission } = await productionFactoryFixture();
    productionAdmission.recoveryMode = operationMode === "resume" ? "continue" : "cleanup-only";
    const running = structuredClone(config.run); running.state = "running";
    await new AtomicRemoteDesktopJournal(config.journalDirectory).initialize({
      schemaVersion: 1, generation: 0, run: running, terminalOutcome: null,
      effects: [{ kind: "provision", status: "committed" }],
    });
    let mutationCalls = 0; let probes = 0;
    const providerAdapter = { async inspectVm() { throw new Error("mutation provider must not perform factory reads"); }, async cloneVm() { mutationCalls += 1; } };
    const owned = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, state: "running" };
    const independentProviderAdapter = { async inspectVm() { probes += 1; return owned; }, async attestNetworkPolicy() { return networkPolicyObservation(config.run); }, async attestVmAbsent() { throw new Error("not reached"); } };
    const runtime = await createHomelabRemoteDesktopRuntimeV1(config, {
      productionAdmission, providerAdapter, independentProviderAdapter, operationMode,
      qgaClient: { invoke() { throw new Error("not reached"); } }, taskSurfaceObserver: { observeTask() {} }, archiveSurfaceObserver: { observeArchive() {} },
    });
    assert.equal(typeof runtime.providerController.execute, "function");
    assert.equal(probes, 1);
    assert.equal(mutationCalls, 0);

    const foreign = { ...owned, fencingToken: "foreign-fence" };
    await assert.rejects(createHomelabRemoteDesktopRuntimeV1(config, {
      productionAdmission, providerAdapter, operationMode,
      independentProviderAdapter: { async inspectVm() { return foreign; }, async attestNetworkPolicy() { return networkPolicyObservation(config.run); }, async attestVmAbsent() {} },
      qgaClient: { invoke() {} }, taskSurfaceObserver: { observeTask() {} }, archiveSurfaceObserver: { observeArchive() {} },
    }), (error) => error.code === "RESUME_IDENTITY_MISMATCH");
    assert.equal(mutationCalls, 0);
  }
});

test("cleanup-only recovery remains constructible after the immutable active lease expires", async () => {
  const { config, goldenObservation, productionAdmission: initialAdmission } = await productionFactoryFixture();
  const activeExpiry = Date.parse(config.run.lease.expiresAt);
  const now = activeExpiry + 60_000;
  const productionAdmission = cleanupOnlyProductionAdmission(config, initialAdmission, now - 1_000);
  assert.ok(Date.parse(productionAdmission.currentLeaseObservation.authorityObservation.record.lease.cleanupExpiresAt) > now);

  const running = structuredClone(config.run); running.state = "running";
  await new AtomicRemoteDesktopJournal(config.journalDirectory).initialize({
    schemaVersion: 1, generation: 0, run: running, terminalOutcome: null,
    effects: [{ kind: "provision", status: "committed" }],
  });
  const owned = {
    ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken,
    imageId: config.run.goldenImage.imageId, state: "running",
  };
  const providerAdapter = { async inspectVm() { throw new Error("mutation provider must not perform factory reads"); } };
  const independentProviderAdapter = {
    async inspectVm() { return owned; },
    async inspectGoldenImage() { return structuredClone(goldenObservation); },
    async attestNetworkPolicy() { return networkPolicyObservation(config.run, now); },
    async attestVmAbsent() { throw new Error("not reached"); },
  };
  const runtime = await createHomelabRemoteDesktopRuntimeV1(config, {
    productionAdmission, providerAdapter, independentProviderAdapter, operationMode: "cancel", clock: { now: () => now },
    qgaClient: { invoke() { throw new Error("cleanup-only construction must not invoke QGA"); } },
    taskSurfaceObserver: { observeTask() { throw new Error("not reached"); } },
    archiveSurfaceObserver: { observeArchive() { throw new Error("not reached"); } },
  });
  assert.equal(runtime.providerController.currentLease.state, "cleanup-only");
  assert.equal(runtime.providerController.currentLease.expiresAt, productionAdmission.currentLeaseObservation.authorityObservation.record.lease.cleanupExpiresAt);
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

test("concurrent surface requests serialize exact QGA PIDs instead of overwriting reconciliation state", async () => {
  const config = await configFixture();
  const admitted = {
    run: config.run, plan: config.plan,
    binding: { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken },
    runtimeBinding: { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot },
  };
  let nextPid = 100; let maximumActive = 0; const active = new Set(); const posts = [];
  const adapter = {
    async inspectRuntimeBinding() { return admitted.runtimeBinding; },
    async call(method, path) {
      if (method === "POST") {
        const pid = ++nextPid; posts.push(pid); active.add(pid); maximumActive = Math.max(maximumActive, active.size);
        return { data: { pid } };
      }
      const pid = Number(new URL(`https://qga.invalid${path}`).searchParams.get("pid"));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      assert.equal(active.delete(pid), true, `status polled an unknown concurrent PID ${pid}`);
      return { data: { exited: true, exitcode: 0, "out-data": Buffer.from(JSON.stringify({ pid })).toString("base64") } };
    },
  };
  const client = new ProxmoxQgaHelperClientV1({ adapter, admitted, deadlineMs: 100, maxOutputBytes: 1_024 });
  const results = await Promise.all([
    client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }),
    client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }),
    client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }),
  ]);
  assert.deepEqual(results, [{ pid: 101 }, { pid: 102 }, { pid: 103 }]);
  assert.deepEqual(posts, [101, 102, 103]);
  assert.equal(maximumActive, 1);
  assert.equal(active.size, 0);
});

test("QGA helper timeouts reconcile the exact PID before any later guest operation", async () => {
  const config = await configFixture();
  const admitted = {
    run: config.run, plan: config.plan,
    binding: { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken },
    runtimeBinding: { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot },
  };
  let posts = 0; let statuses = 0; let second = false;
  const adapter = {
    async inspectRuntimeBinding() { return admitted.runtimeBinding; },
    async call(method) {
      if (method === "POST") { posts += 1; return { data: { pid: second ? 78 : 77 } }; }
      statuses += 1;
      if (!second && statuses === 1) return new Promise(() => {});
      return { data: { exited: true, exitcode: 0, "out-data": Buffer.from(JSON.stringify({ ok: true })).toString("base64") } };
    },
  };
  const client = new ProxmoxQgaHelperClientV1({ adapter, admitted, deadlineMs: 50, maxOutputBytes: 1_024 });
  await assert.rejects(client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }), (error) => error.code === "HELPER_DEADLINE");
  assert.equal(posts, 1); assert.equal(statuses, 2);
  second = true;
  assert.deepEqual(await client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }), { ok: true });
  assert.equal(posts, 2);
});

test("an unresolved or unknown QGA exec PID blocks every later guest mutation", async () => {
  const config = await configFixture();
  const admitted = {
    run: config.run, plan: config.plan,
    binding: { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken },
    runtimeBinding: { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot },
  };
  let posts = 0;
  const adapter = {
    async inspectRuntimeBinding() { return admitted.runtimeBinding; },
    async call(method) { if (method === "POST") { posts += 1; return { data: { pid: 91 } }; } return new Promise(() => {}); },
  };
  const client = new ProxmoxQgaHelperClientV1({ adapter, admitted, deadlineMs: 40, maxOutputBytes: 1_024 });
  await assert.rejects(client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }), (error) => error.code === "QGA_PROCESS_RECONCILIATION_REQUIRED");
  await assert.rejects(client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }), (error) => error.code === "QGA_PROCESS_RECONCILIATION_REQUIRED");
  assert.equal(posts, 1);

  let unknownPosts = 0;
  const unknown = new ProxmoxQgaHelperClientV1({
    admitted, deadlineMs: 40, maxOutputBytes: 1_024,
    adapter: { async inspectRuntimeBinding() { return admitted.runtimeBinding; }, async call(method) { if (method === "POST") { unknownPosts += 1; return new Promise(() => {}); } throw new Error("no status without a PID"); } },
  });
  await assert.rejects(unknown.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }), (error) => error.code === "QGA_PROCESS_RECONCILIATION_REQUIRED");
  await assert.rejects(unknown.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "health" }), (error) => error.code === "QGA_PROCESS_RECONCILIATION_REQUIRED");
  assert.equal(unknownPosts, 1);
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

test("fixed controller transport fails closed with no arbitrary command fallback", async () => {
  const boundary = new BoundedJsonProcessV1();
  await assert.rejects(boundary.invoke({ executable: PROXMOX_SSH_TRANSPORT_EXECUTABLE_V1, operation: "request", payload: {}, deadlineMs: 100, maxOutputBytes: 1_024 }), (error) => ["HELPER_FAILED", "UNAVAILABLE_HELPER"].includes(error.code));
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
  await assert.rejects(fake.invoke({ executable: PROXMOX_SSH_TRANSPORT_EXECUTABLE_V1, operation: "request", payload: {}, deadlineMs: 100, maxOutputBytes: 1_024 }), (error) => error.status === 404 && error.code === "PVE_NOT_FOUND");

  const binding = { providerId: "p", hostId: "h", vmId: "901", leaseId: "l", fencingToken: "f", imageId: "i", runId: "r", automationUser: "nelosauto", stateRoot: "/var/lib/nelos-desktop/runs/r" };
  let invoked;
  const transport = new HomelabProxmoxTransportV1({ processBoundary: { invoke(value) { invoked = value; return { data: null }; } }, binding, deadlineMs: 1_000, maxOutputBytes: 2_048, clock: { now: () => 1_000 } });
  await transport.request({ method: "GET", path: "/nodes/h/qemu/901/config" });
  assert.deepEqual(invoked.payload, { schemaVersion: 1, binding, deadlineAt: new Date(2_000).toISOString(), maxOutputBytes: 2_048, request: { method: "GET", path: "/nodes/h/qemu/901/config" } });
});

test("installed guest helper protocol gates readiness and isolated auth without accepting staged task claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-installed-helper-"));
  const config = await configFixture();
  const binding = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot };
  await mkdir(join(root, "etc/nelos-desktop"), { recursive: true }); await mkdir(join(root, "var/lib/nelos-desktop/observations"), { recursive: true });
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(binding));
  await writeFile(join(root, "var/lib/nelos-desktop/gui-ready.json"), JSON.stringify({ schemaVersion: 1, binding, ready: true, accessibilityBus: true, captureReady: true, sessionUser: "nelosauto" }));
  const authReceipt = { schemaVersion: 1, binding, authenticated: true, accountType: "chatgpt", accountBindingDigest, authMethod: "chatgptDeviceCode", credentialStore: "file", developerSessionImported: false };
  await writeFile(join(root, "var/lib/nelos-desktop/device-auth.json"), JSON.stringify(authReceipt));
  const liveBase = {
    schemaVersion: 1, type: "live-device-auth-attestation", source: "codex-app-server-account-read",
    runId: config.run.runId, fencingToken: config.run.lease.fencingToken, automationUser: "nelosauto",
    authenticated: true, accountType: "chatgpt", authMethod: "chatgptDeviceCode", credentialStore: "file", developerSessionImported: false,
    accountBindingDigest, authReceiptDigest: `sha256:${createHash("sha256").update(canonicalJson(authReceipt)).digest("hex")}`, observedAt: new Date().toISOString(),
  };
  const live = { ...liveBase, attestationDigest: `sha256:${createHash("sha256").update(canonicalJson(liveBase)).digest("hex")}` };
  const guestTaskControl = join(root, "guest-task-control");
  await writeFile(guestTaskControl, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(live)}'\n`); await chmod(guestTaskControl, 0o755);
  const helper = new URL("../validation/proxmox/desktop/helpers/nelos-desktop-atspi.mjs", import.meta.url).pathname;
  const envelope = (operation, payload = {}) => `${JSON.stringify({ schemaVersion: 1, binding, operation, payload, byteLength: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 65_536 })}\n`;
  assert.equal((await runHelper(helper, "gui_ready", envelope("gui_ready"), { NELOS_DESKTOP_HELPER_ROOT: root })).ready, true);
  assert.deepEqual(await runHelper(helper, "auth_status", envelope("auth_status"), { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_GUEST_TASK_CONTROL: guestTaskControl }), live);
  const control = join(root, "atspi-visible-control");
  const expectedTask = { taskId: config.run.scenarios[0].task.taskId, title: config.run.scenarios[0].scenarioId };
  await writeFile(control, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ schemaVersion: 1, ...expectedTask, state: "visible", scan: { complete: true, scannedNodes: 42, maximumNodes: 10_000 } })}'\n`); await chmod(control, 0o755);
  assert.equal((await runHelper(helper, "expected_task_visible", envelope("expected_task_visible", expectedTask), { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_ATSPI_CONTROL: control })).state, "visible");
  await assert.rejects(runHelper(helper, "expected_task_visible", envelope("expected_task_visible", { ...expectedTask, title: "Wrong title" }), { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_ATSPI_CONTROL: control }), (error) => error.exitCode === 77);
  await assert.rejects(runHelper(helper, "compare_task_surfaces", envelope("compare_task_surfaces", { taskId: config.run.scenarios[0].task.taskId, title: "scenario-1", lifecycle: "active" }), { NELOS_DESKTOP_HELPER_ROOT: root }), (error) => error.exitCode === 77);
  const staleBinding = { ...binding, fencingToken: "stale-fence" };
  await assert.rejects(runHelper(helper, "gui_ready", `${JSON.stringify({ schemaVersion: 1, binding: staleBinding, operation: "gui_ready", payload: {}, byteLength: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 65_536 })}\n`, { NELOS_DESKTOP_HELPER_ROOT: root }), (error) => error.exitCode === 77);
  await writeFile(join(root, "var/lib/nelos-desktop/device-auth.json"), JSON.stringify({ schemaVersion: 1, binding: staleBinding, authenticated: true, accountType: "chatgpt", accountBindingDigest, authMethod: "chatgptDeviceCode", credentialStore: "file", developerSessionImported: false }));
  await assert.rejects(runHelper(helper, "auth_status", envelope("auth_status"), { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_GUEST_TASK_CONTROL: guestTaskControl }), (error) => error.exitCode === 77);
});

test("production helper routes expose no archive-observation staging or guest-authored checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-installed-archive-")); const config = await configFixture();
  const binding = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken, imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot };
  const canonicalBinding = Object.fromEntries(Object.entries(binding).sort(([left], [right]) => left.localeCompare(right)));
  await mkdir(join(root, "etc/nelos-desktop"), { recursive: true }); await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(canonicalBinding));
  const control = join(root, "archive-control.mjs");
  await writeFile(control, "#!/bin/sh\ncat >/dev/null\nprintf '{\"accepted\":true}'\n"); await chmod(control, 0o755);
  const helper = new URL("../validation/proxmox/desktop/helpers/nelos-desktop-archive.mjs", import.meta.url).pathname;
  const input = `${JSON.stringify({ schemaVersion: 1, binding, operation: "observe_checkpoint", payload: { sequence: 1 }, byteLength: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 65_536 })}\n`;
  await assert.rejects(runHelper(helper, "observe_checkpoint", input, { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_ARCHIVE_CONTROL: control }), (error) => error.exitCode === 77);
  const validInput = `${JSON.stringify({ schemaVersion: 1, binding, operation: "archive_tasks", payload: {}, byteLength: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 65_536 })}\n`;
  assert.equal((await runHelper(helper, "archive_tasks", validInput, { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_ARCHIVE_CONTROL: control })).accepted, true);
  const install = await readFile(new URL("../validation/proxmox/desktop/helpers/install-host-helper.sh", import.meta.url), "utf8");
  assert.doesNotMatch(install, /nelos-task-observation-stage/u);
  const atspi = await readFile(new URL("../validation/proxmox/desktop/helpers/nelos-atspi-control", import.meta.url), "utf8");
  const visibility = atspi.slice(atspi.indexOf("def expected_task_visibility"), atspi.indexOf("def overlaps", atspi.indexOf("def expected_task_visibility")));
  assert.match(visibility, /scanned,parents=complete_scan_index\(desktop\)/u);
  assert.doesNotMatch(visibility, /complete_scan\(/u);
  assert.doesNotMatch(visibility, /except Exception/u);
  assert.match(visibility, /if row_ids != \{expected_id\}: fail\("EXPECTED_TASK_IDENTITY_MISMATCH"\)/u);
});

test("production GUI wrapper makes readiness, auth, and cross-surface checks real execution gates", async () => {
  const config = await configFixture(); const operations = []; const observed = []; let readiness = 0; let visibility = 0; let now = 0;
  const client = { async invoke({ operation, payload }) {
    operations.push(operation);
    if (operation === "auth_status") return liveAuth(config, new Date(now).toISOString());
    if (operation === "gui_ready") { readiness += 1; return readiness === 1 ? { ready: false, accessibilityBus: false, captureReady: false } : { ready: true, accessibilityBus: true, captureReady: true }; }
    if (operation === "expected_task_visible") { visibility += 1; return { schemaVersion: 1, taskId: payload.taskId, title: payload.title, state: visibility === 1 ? "missing" : "visible", scan: { complete: true, scannedNodes: 40, maximumNodes: 10_000 } }; }
    throw new Error(`unexpected operation ${operation}`);
  } };
  const driver = { async runScenario(scenario, { beforeAction, afterAction }) {
    const submit = scenario.actions.find((action) => action.type === "keypress" && config.homelab.guiBindings[action.targetRef]?.key === "ENTER");
    await beforeAction({ action: submit });
    await afterAction({ action: submit });
    return { outcome: "passed", taskId: scenario.task.taskId };
  } };
  const surfaceObserver = { async observeTask(value) { observed.push(value); return {}; } };
  const wrapped = new ProductionGuiDriverV1({ driver, client, admitted: config, surfaceObserver, clock: { now: () => now }, sleep: async (ms) => { now += ms; }, syncTimeoutMs: 100, pollIntervalMs: 10 });
  await wrapped.runScenario(config.run.scenarios[0]);
  assert.deepEqual(operations, ["auth_status", "gui_ready", "gui_ready", "expected_task_visible", "expected_task_visible", "auth_status"]);
  assert.deepEqual(observed, [
    { taskId: config.run.scenarios[0].task.taskId, title: config.run.scenarios[0].scenarioId, lifecycle: "active" },
    { taskId: config.run.scenarios[0].task.taskId, title: config.run.scenarios[0].scenarioId, lifecycle: "completed" },
  ]);
});

test("post-auth synchronization never activates a wrong or missing task and times out without paid work", async () => {
  const config = await configFixture(); const scenario = config.run.scenarios[0];
  const auth = liveAuth(config);
  const readiness = { ready: true, accessibilityBus: true, captureReady: true };
  const scan = { complete: true, scannedNodes: 25, maximumNodes: 10_000 };
  for (const mismatch of [{ taskId: "wrong-task-id", title: scenario.scenarioId }, { taskId: scenario.task.taskId, title: "Wrong title" }]) {
    let driverCalls = 0;
    const client = { async invoke({ operation }) {
      if (operation === "auth_status") return auth;
      if (operation === "gui_ready") return readiness;
      return { schemaVersion: 1, ...mismatch, state: "visible", scan };
    } };
    const wrapped = new ProductionGuiDriverV1({ driver: { async runScenario() { driverCalls += 1; } }, client, admitted: config, surfaceObserver: { async observeTask() {} }, syncTimeoutMs: 10, pollIntervalMs: 1 });
    await assert.rejects(wrapped.runScenario(scenario), (error) => error.code === "EXPECTED_TASK_VISIBILITY_MISMATCH");
    assert.equal(driverCalls, 0);
  }

  let now = 0; let driverCalls = 0; const operations = [];
  const absentClient = { async invoke({ operation, payload }) {
    operations.push(operation);
    if (operation === "auth_status") return liveAuth(config, new Date(now).toISOString());
    if (operation === "gui_ready") return readiness;
    return { schemaVersion: 1, taskId: payload.taskId, title: payload.title, state: "missing", scan };
  } };
  const absent = new ProductionGuiDriverV1({ driver: { async runScenario() { driverCalls += 1; } }, client: absentClient, admitted: config, surfaceObserver: { async observeTask() {} }, clock: { now: () => now }, sleep: async (ms) => { now += ms; }, syncTimeoutMs: 20, pollIntervalMs: 5 });
  await assert.rejects(absent.runScenario(scenario), (error) => error.code === "EXPECTED_TASK_VISIBILITY_TIMEOUT");
  assert.equal(driverCalls, 0);
  assert.equal(operations.includes("activate_expected_task"), false);
  assert.deepEqual(operations.slice(0, 2), ["auth_status", "gui_ready"]);
});

test("absolute run deadline aborts production GUI readiness before model work", async () => {
  const config = await configFixture(); const scenario = config.run.scenarios[0]; let now = 0; let driverCalls = 0;
  const auth = liveAuth(config, new Date(now).toISOString());
  const operations = [];
  const client = { async invoke({ operation }) {
    operations.push(operation);
    if (operation === "auth_status") return auth;
    if (operation === "gui_ready") { now = 11; return { ready: true, accessibilityBus: true, captureReady: true }; }
    throw new Error(`unexpected operation ${operation}`);
  } };
  const wrapped = new ProductionGuiDriverV1({
    driver: { async runScenario() { driverCalls += 1; } }, client, admitted: config,
    surfaceObserver: { async observeTask() {} }, clock: { now: () => now }, sleep: async (ms) => { now += ms; }, syncTimeoutMs: 100, pollIntervalMs: 10,
  });
  await assert.rejects(
    wrapped.runScenario(scenario, { runDeadlineAt: new Date(10).toISOString() }),
    (error) => error.code === "RUN_DEADLINE_EXPIRED",
  );
  assert.equal(driverCalls, 0);
  assert.deepEqual(operations, ["auth_status", "gui_ready"]);
});

test("fabricated or stale device-auth metadata is rejected before GUI synchronization", async () => {
  const config = await configFixture(); const scenario = config.run.scenarios[0]; let driverCalls = 0; const operations = [];
  const client = { async invoke({ operation }) {
    operations.push(operation);
    return { ...liveAuth(config), runId: "stale-run", modelBacked: true };
  } };
  const wrapped = new ProductionGuiDriverV1({ driver: { async runScenario() { driverCalls += 1; } }, client, admitted: config, surfaceObserver: { async observeTask() {} }, syncTimeoutMs: 10, pollIntervalMs: 1 });
  await assert.rejects(wrapped.runScenario(scenario), (error) => error.code === "AUTH_IDENTITY_MISMATCH");
  assert.deepEqual(operations, ["auth_status"]);
  assert.equal(driverCalls, 0);
});

test("hung GUI probes and completed observations are aborted at their exact deadlines", async () => {
  const config = await configFixture(); const scenario = config.run.scenarios[0];
  {
    let driverCalls = 0;
    const client = { async invoke({ operation }) {
      if (operation === "auth_status") return liveAuth(config);
      if (operation === "gui_ready") return new Promise(() => {});
      throw new Error(`unexpected operation ${operation}`);
    } };
    const started = Date.now();
    const wrapped = new ProductionGuiDriverV1({ driver: { async runScenario() { driverCalls += 1; } }, client, admitted: config, surfaceObserver: { async observeTask() {} }, syncTimeoutMs: 25, pollIntervalMs: 5 });
    await assert.rejects(wrapped.runScenario(scenario), (error) => error.code === "GUI_READINESS_TIMEOUT");
    assert.ok(Date.now() - started < 500);
    assert.equal(driverCalls, 0);
  }
  {
    let observations = 0;
    const client = { async invoke({ operation, payload }) {
      if (operation === "auth_status") return liveAuth(config);
      if (operation === "gui_ready") return { ready: true, accessibilityBus: true, captureReady: true };
      if (operation === "expected_task_visible") return { schemaVersion: 1, taskId: payload.taskId, title: payload.title, state: "visible", scan: { complete: true, scannedNodes: 1, maximumNodes: 10_000 } };
      throw new Error(`unexpected operation ${operation}`);
    } };
    const driver = { async runScenario(value, { beforeAction, afterAction }) {
      const action = value.actions.find((candidate) => candidate.type === "keypress" && config.homelab.guiBindings[candidate.targetRef]?.key === "ENTER");
      await beforeAction({ action }); await afterAction({ action }); return { scenarioId: value.scenarioId, taskId: value.task.taskId, outcome: "passed" };
    } };
    const surfaceObserver = { async observeTask() { observations += 1; return observations === 1 ? {} : new Promise(() => {}); } };
    const wrapped = new ProductionGuiDriverV1({ driver, client, admitted: config, surfaceObserver, syncTimeoutMs: 25, pollIntervalMs: 5 });
    const result = await wrapped.runScenario(scenario);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failure.code, "COMPLETED_SURFACE_TIMEOUT");
    assert.equal(observations, 2);
  }
});

test("live account binding is re-read before Enter and drift prevents model work", async () => {
  const config = await configFixture(); const scenario = config.run.scenarios[0]; let authReads = 0; let entered = false;
  const client = { async invoke({ operation, payload }) {
    if (operation === "auth_status") { authReads += 1; return liveAuth(config, new Date().toISOString(), authReads === 1 ? accountBindingDigest : `sha256:${"7".repeat(64)}`); }
    if (operation === "gui_ready") return { ready: true, accessibilityBus: true, captureReady: true };
    if (operation === "expected_task_visible") return { schemaVersion: 1, taskId: payload.taskId, title: payload.title, state: "visible", scan: { complete: true, scannedNodes: 1, maximumNodes: 10_000 } };
    throw new Error(`unexpected operation ${operation}`);
  } };
  const driver = { async runScenario(value, { beforeAction }) {
    const action = value.actions.find((candidate) => candidate.type === "keypress" && config.homelab.guiBindings[candidate.targetRef]?.key === "ENTER");
    await beforeAction({ action }); entered = true; return { outcome: "passed" };
  } };
  const wrapped = new ProductionGuiDriverV1({ driver, client, admitted: config, surfaceObserver: { async observeTask() { return {}; } }, syncTimeoutMs: 50, pollIntervalMs: 5 });
  await assert.rejects(wrapped.runScenario(scenario), (error) => error.code === "AUTH_IDENTITY_MISMATCH");
  assert.equal(authReads, 2);
  assert.equal(entered, false);
});

test("production visual aggregate validation fails closed without authoritative complete topology", async () => {
  const config = await configFixture(); const scenario = config.run.scenarios[0];
  const client = { async invoke({ operation, payload }) {
    if (operation === "auth_status") return liveAuth(config);
    if (operation === "gui_ready") return { ready: true, accessibilityBus: true, captureReady: true };
    if (operation === "expected_task_visible") return { schemaVersion: 1, taskId: payload.taskId, title: payload.title, state: "visible", scan: { complete: true, scannedNodes: 1, maximumNodes: 10_000 } };
    throw new Error(`unexpected operation ${operation}`);
  } };
  const driver = { async runScenario(value, { beforeAction, afterAction }) {
    const action = value.actions.find((candidate) => candidate.type === "keypress" && config.homelab.guiBindings[candidate.targetRef]?.key === "ENTER");
    await beforeAction({ action }); await afterAction({ action }); return { outcome: "passed" };
  } };
  const wrapped = new ProductionGuiDriverV1({ driver, client, admitted: config, surfaceObserver: { async observeTask() { return {}; } }, syncTimeoutMs: 50, pollIntervalMs: 5, requireAggregateTopology: true });
  const result = await wrapped.runScenario(scenario);
  assert.equal(result.outcome, "failed");
  assert.equal(result.failure.code, "AGGREGATE_TOPOLOGY_UNSUPPORTED");
});

test("factory runtime drives the real resumable runner through bound GUI, archive, evidence, and cleanup paths", async () => {
  const config = await configFixture(); const scenario = config.run.scenarios[0]; const events = [];
  config.plan.operationUsage.provision = { ...zero(), wallTimeMs: 1_000 };
  config.plan.operationUsage.cleanup = { ...zero(), wallTimeMs: 1_000 };
  config.plan.operationUsage.quarantine = { ...zero(), wallTimeMs: 1_000 };
  config.plan.scenarioUsage[scenario.scenarioId] = { ...zero(), taskCount: 1, modelTurnCount: 1, spendUsd: 0.1, wallTimeMs: scenario.deadlineMs };
  config.plan.archiveConvergence.operationUsage = { ...zero(), wallTimeMs: 30_000, screenshotCount: 2, screenshotBytes: 2_048 };
  await writeFile(join(config.homelab.sealedValueRoot, "benchmark-input-1.sealed"), "bounded-input", { mode: 0o400 });
  const binding = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken };
  let providerState = null;
  const providerAdapter = {
    async inspectVm() { return providerState === null ? null : { ...binding, imageId: config.run.goldenImage.imageId, state: providerState, ...(providerState === "quarantined" ? { quarantined: true } : {}) }; },
    async cloneVm() { events.push("provider:clone"); providerState = "created"; return { status: "committed", providerOperationId: "clone" }; },
    async configureVm() { providerState = "configured"; return { status: "committed", providerOperationId: "configure" }; },
    async startVm() { providerState = "running"; return { status: "committed", providerOperationId: "start" }; },
    async stopVm() { providerState = "stopped"; return { status: "committed", providerOperationId: "stop" }; },
    async attestVmStopped() { return { ...binding, poweredOff: ["stopped", "quarantined"].includes(providerState), powerState: ["stopped", "quarantined"].includes(providerState) ? "stopped" : "running" }; },
    async destroyVm() { events.push("provider:destroy"); providerState = null; return { status: "committed", providerOperationId: "destroy" }; },
    async quarantineVm() { providerState = "quarantined"; return { status: "committed", providerOperationId: "quarantine" }; },
    async waitForQga() { return { ready: true, credentialBoundary: credentialBoundaryFor(config), installedDesktopIdentity: installedDesktopIdentity(), user: "nelosauto", session: "graphical" }; },
    async attestVmAbsent() { return { ...binding, absent: providerState === null, macAbsent: providerState === null, networkInventoryComplete: true }; },
    async reconcileMutation() { return { status: "committed" }; },
    async commitReceipt(receipt) { return { committed: true, receiptId: receipt.receiptId, attestationDigest: receipt.attestationDigest }; },
  };
  const tasks = [scenario.task.taskId];
  const visualBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: "nelos-developer-visual-state-validation", capture: { digest: `sha256:${"a".repeat(64)}` }, outcome: "passed", counts: {}, findings: [] })}\n`);
  const visualDigest = `sha256:${createHash("sha256").update(visualBytes).digest("hex")}`;
  const qgaClient = { admitted: config, maxOutputBytes: 1_048_576, async invoke({ operation, payload }) {
    events.push(`helper:${operation}`);
    if (operation === "gui_ready") return { ready: true, accessibilityBus: true, captureReady: true };
    if (operation === "auth_status") return liveAuth(config, new Date(clock.now()).toISOString());
    if (operation === "expected_task_visible") return { schemaVersion: 1, taskId: payload.taskId, title: payload.title, state: "visible", scan: { complete: true, scannedNodes: 30, maximumNodes: 10_000 } };
    if (operation === "list_tasks") return [...tasks];
    if (operation === "activate_expected_task") return { taskId: payload.taskId, createdForScenario: payload.scenarioId, fresh: true };
    if (operation === "active_task") return { taskId: tasks.at(-1) };
    if (["click", "keypress", "type_text"].includes(operation)) return { ok: true };
    if (operation === "protected_capture_regions") return { schemaVersion: 1, conversation: { kind: "conversation", x: 0, y: 0, width: 2, height: 2 }, credentialInventory: { complete: true, count: 0, regions: [] }, traversal: { complete: true, scannedNodes: 10, maximumNodes: 10_000 } };
    if (operation === "capture_evidence") {
      const protectedInventory = { schemaVersion: 1, conversation: { kind: "conversation", x: 0, y: 0, width: 2, height: 2 }, credentialInventory: { complete: true, count: 0, regions: [] }, traversal: { complete: true, scannedNodes: 10, maximumNodes: 10_000 } };
      const lifecycleEvidence = { kind: "complete-absence", value: "no-running-approval-or-input-indicator", scan: { complete: true, scannedNodes: 4, maximumNodes: 2_000 } };
      const rgba = Buffer.alloc(32); for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255; rgba[8] = 200;
      return {
        width: 4, height: 2, rgbaBase64: rgba.toString("base64"), renderedLifecycle: "idle", lifecycleEvidence,
        protectedInventory, protectedRegions: [protectedInventory.conversation],
        privacy: { schemaVersion: 1, classificationComplete: true, maskedBase: "full-frame-black", mode: "expected-task-evidence-only", rawPixelsPersisted: false, traversal: { ...protectedInventory.traversal }, preservedRegions: [
          { kind: "expected-task-title", taskId: payload.expectedTask.taskId, textDigest: `sha256:${createHash("sha256").update(payload.expectedTask.title).digest("hex")}`, x: 2, y: 0, width: 1, height: 1 },
        ] },
      };
    }
    if (operation === "task_state") return true;
    if (operation === "health") return { crashed: false, stalled: false };
    if (operation === "archive_tasks") return payload.expectedThreads.map(({ threadId }, index) => ({ schemaVersion: 1, type: "native-archive", actionId: `archive-${index}`, threadId, archived: true }));
    if (operation === "restart_desktop") return { schemaVersion: 1, type: "desktop-restart", previousAppInstanceId: payload.previousAppInstanceId, newAppInstanceId: "desktop-app-2", restarted: true };
    throw new Error(`unexpected helper operation ${operation}`);
  } };
  const taskSurfaceObserver = { async observeTask() { events.push("observer:three-surfaces"); return {}; } };
  const archiveSurfaceObserver = { async observeArchive(payload) {
    events.push("observer:archive-producers");
    const appInstanceId = payload.phase === "afterRestart" ? "desktop-app-2" : "desktop-app-1";
    return { sequence: payload.sequence, observedAt: `2026-08-19T12:01:0${payload.sequence}.000Z`, phase: payload.phase, appInstanceId, cleanupState: "complete", nelosWorkers: [{ workerId: "worker-1", archivedThreadIds: [scenario.task.taskId] }], ordinaryMapThreadIds: [], nativeVisibleThreadIds: [], visualEvidence: { reportBytesBase64: visualBytes.toString("base64"), reportDigest: visualDigest, sidebarThreadIds: [], createdTasksThreadIds: [], mcpVisualThreadIds: [] } };
  } };
  const clock = { now: () => Date.parse("2026-08-19T12:01:00.000Z") };
  const runtime = await createHomelabRemoteDesktopRuntimeV1(config, { providerAdapter, qgaClient, taskSurfaceObserver, archiveSurfaceObserver, clock });
  const runner = new ResumableRemoteDesktopRunnerV1({ journalDirectory: config.journalDirectory, ...runtime, clock });
  const result = await runner.start({ run: config.run, plan: config.plan, candidateDigest: config.candidateDigest, currentLease: config.currentLease, now: Date.parse("2026-08-19T12:00:00.000Z") });
  assert.equal(result.run.state, "succeeded", JSON.stringify({ failure: result.failure, events }));
  assert.ok(events.indexOf("observer:three-surfaces") < events.indexOf("provider:destroy"));
  assert.ok(events.indexOf("observer:archive-producers") < events.indexOf("provider:destroy"));
  assert.equal(result.terminalOutcome.outcome, "destroyed");
  assert.ok(result.evidence?.inventory);
});

test("evidence capture requires complete protected geometry before requesting pixels", async () => {
  const config = await configFixture(); config.plan.evidence.screenshots = [{ artifactId: "shot-1", scenarioId: "scenario-1", maxOutputBytes: 50_000 }];
  const operations = [];
  const client = {
    admitted: config, maxOutputBytes: 1_048_576,
    async invoke({ operation }) { operations.push(operation); return {
      width: 4, height: 2, rgbaBase64: Buffer.alloc(32).toString("base64"), renderedLifecycle: "idle",
      lifecycleEvidence: { kind: "complete-absence", value: "no-running-approval-or-input-indicator", scan: { complete: true, scannedNodes: 10, maximumNodes: 2_000 } },
      protectedInventory: { schemaVersion: 1, conversation: { kind: "conversation", x: 0, y: 0, width: 2, height: 2 }, credentialInventory: { complete: true, count: 0, regions: [] }, traversal: { complete: false, scannedNodes: 10, maximumNodes: 10_000 } },
      protectedRegions: [{ kind: "conversation", x: 0, y: 0, width: 2, height: 2 }],
      privacy: { schemaVersion: 1, classificationComplete: true, maskedBase: "full-frame-black", mode: "expected-task-evidence-only", preservedRegions: [], rawPixelsPersisted: false, traversal: { complete: false, scannedNodes: 10, maximumNodes: 10_000 } },
    }; },
  };
  const collector = new HomelabEvidenceCollectorV1({ client, plan: config.plan });
  await assert.rejects(collector.collect({ run: config.run, scenarioResults: [{ scenarioId: "scenario-1" }] }), (error) => error.code === "PROTECTED_GEOMETRY_UNAVAILABLE");
  assert.deepEqual(operations, ["capture_evidence"]);
});

test("evidence capture accepts an explicit complete zero-credential inventory while preserving conversation masking", async () => {
  const config = await configFixture(); config.plan.evidence.screenshots = [{ artifactId: "shot-1", scenarioId: "scenario-1", maxOutputBytes: 50_000 }];
  const scenario = config.run.scenarios[0];
  const proof = { schemaVersion: 1, conversation: { kind: "conversation", x: 0, y: 0, width: 2, height: 2 }, credentialInventory: { complete: true, count: 0, regions: [] }, traversal: { complete: true, scannedNodes: 12, maximumNodes: 10_000 } };
  const lifecycleEvidence = { kind: "complete-absence", value: "no-running-approval-or-input-indicator", scan: { complete: true, scannedNodes: 4, maximumNodes: 2_000 } };
  const privacy = { schemaVersion: 1, classificationComplete: true, maskedBase: "full-frame-black", mode: "expected-task-evidence-only", rawPixelsPersisted: false, traversal: { ...proof.traversal }, preservedRegions: [
    { kind: "expected-task-title", taskId: scenario.task.taskId, textDigest: `sha256:${createHash("sha256").update(scenario.scenarioId).digest("hex")}`, x: 2, y: 0, width: 1, height: 1 },
  ] };
  const rgba = Buffer.alloc(32); for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255; rgba[8] = 200;
  const client = {
    admitted: config, maxOutputBytes: 1_048_576,
    async invoke({ operation, payload }) {
      if (operation === "auth_status") return liveAuth(config);
      assert.equal(operation, "capture_evidence"); assert.deepEqual(payload, { expectedTask: { taskId: scenario.task.taskId, title: scenario.scenarioId } });
      return { width: 4, height: 2, rgbaBase64: rgba.toString("base64"), renderedLifecycle: "idle", lifecycleEvidence, privacy, protectedInventory: proof, protectedRegions: [proof.conversation] };
    },
  };
  const collected = await new HomelabEvidenceCollectorV1({ client, plan: config.plan }).collect({ run: config.run, scenarioResults: [{ scenarioId: "scenario-1" }] });
  assert.equal(collected.screenshots.length, 1);
  assert.equal(collected.authAttestation.accountBindingDigest, accountBindingDigest);
  assert.deepEqual(collected.screenshots[0].frame.sensitiveRegions, [{ class: "conversation", region: { x: 0, y: 0, width: 2, height: 2 } }]);
});

test("evidence collector rejects a single unrelated desktop pixel despite valid privacy metadata", async () => {
  const config = await configFixture(); config.plan.evidence.screenshots = [{ artifactId: "shot-1", scenarioId: "scenario-1", maxOutputBytes: 50_000 }];
  const scenario = config.run.scenarios[0];
  const protectedInventory = { schemaVersion: 1, conversation: { kind: "conversation", x: 0, y: 0, width: 2, height: 2 }, credentialInventory: { complete: true, count: 0, regions: [] }, traversal: { complete: true, scannedNodes: 12, maximumNodes: 10_000 } };
  const lifecycleEvidence = { kind: "complete-absence", value: "no-running-approval-or-input-indicator", scan: { complete: true, scannedNodes: 4, maximumNodes: 2_000 } };
  const privacy = { schemaVersion: 1, classificationComplete: true, maskedBase: "full-frame-black", mode: "expected-task-evidence-only", rawPixelsPersisted: false, traversal: { ...protectedInventory.traversal }, preservedRegions: [
    { kind: "expected-task-title", taskId: scenario.task.taskId, textDigest: `sha256:${createHash("sha256").update(scenario.scenarioId).digest("hex")}`, x: 2, y: 0, width: 1, height: 1 },
  ] };
  const rgba = Buffer.alloc(32); for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
  rgba[8] = 200; rgba[12] = 255;
  const client = { admitted: config, maxOutputBytes: 1_048_576, async invoke({ operation }) {
    assert.equal(operation, "capture_evidence");
    return { width: 4, height: 2, rgbaBase64: rgba.toString("base64"), renderedLifecycle: "idle", lifecycleEvidence, privacy, protectedInventory, protectedRegions: [protectedInventory.conversation] };
  } };
  await assert.rejects(
    new HomelabEvidenceCollectorV1({ client, plan: config.plan }).collect({ run: config.run, scenarioResults: [{ scenarioId: scenario.scenarioId }] }),
    (error) => error.code === "UNSAFE_CAPTURE",
  );
});

test("archive evidence rejects unbounded sequences and writes only below its report root", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "nelos-archive-report-root-")));
  const reportRoot = join(stateRoot, "reports");
  const reportBytes = Buffer.from("{\"kind\":\"archive-proof\"}\n");
  const reportDigest = `sha256:${createHash("sha256").update(reportBytes).digest("hex")}`;
  let observations = 0;
  const adapter = new HomelabArchiveAdapterV1({
    client: { async invoke() { throw new Error("not used"); } },
    stateRoot,
    reportRoot,
    maxReportBytes: 16_384,
    surfaceObserver: { async observeArchive() {
      observations += 1;
      return { visualEvidence: { reportBytesBase64: reportBytes.toString("base64"), reportDigest } };
    } },
  });

  await assert.rejects(
    adapter.observeCheckpoint({ sequence: "../sibling" }),
    (error) => error.code === "INVALID_ARCHIVE_SEQUENCE",
  );
  assert.equal(observations, 0);
  const observed = await adapter.observeCheckpoint({ sequence: 1 });
  assert.equal(observations, 1);
  assert.ok(observed.visualEvidence.report.path.startsWith(`${reportRoot}/`));
  assert.equal((await readFile(observed.visualEvidence.report.path)).equals(reportBytes), true);
});

test("receipt persistence rejects altered bytes and reconciliation rejects altered attestations", async () => {
  const config = await configFixture(); const store = new AtomicProviderReceiptStoreV1(join(config.homelab.stateRoot, "receipts-test"));
  const first = { receiptId: "receipt-1", attestationDigest: `sha256:${"a".repeat(64)}` };
  await store.commit(first);
  await assert.rejects(store.commit({ ...first, attestationDigest: `sha256:${"b".repeat(64)}` }), (error) => error.code === "ALTERED_RECEIPT");

  const binding = { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken };
  const admitted = { run: config.run, plan: config.plan, binding };
  const effect = { kind: "destroy", request: { operationId: "op-destroy", runId: config.run.runId, provider: config.run.provider, lease: config.run.lease, automation: config.plan.automation, reservation: config.plan.reservation } };
  const credentialDisposition = createCredentialTerminalDispositionV1(effect.request, { ...binding, poweredOff: true, powerState: "stopped" }, "powered-off-before-destroy");
  const reconciler = new HomelabProviderReconcilerV1({ adapter: {}, receiptStore: { async read(receiptId) { return { receiptId, ...binding, operation: "destroy", operationId: "op-destroy", mutationStatus: "committed", credentialDisposition, destroyed: true, macAbsent: true, networkInventoryComplete: true, attestationDigest: `sha256:${"f".repeat(64)}` }; } }, admitted, clock: { now: () => Date.parse("2026-08-19T12:00:00.000Z") } });
  await assert.rejects(reconciler.reconcile(effect), (error) => error.code === "ALTERED_RECEIPT");
});
