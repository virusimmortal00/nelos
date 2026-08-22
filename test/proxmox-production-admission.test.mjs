import assert from "node:assert/strict";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { createCurrentLeaseObservationV1, prepareProductionAdmissionV1, sha256, validateProductionConfigBindingV1, verifyInstalledNelosCandidateV1 } from "nelos/proxmox-desktop-runtime";
import { DISTRIBUTION_ENTRIES, computeDistributionIntegrity } from "../src/distribution-provenance.mjs";
import { createProductionGuestTaskIntentV1 } from "../src/production-guest-task.mjs";
import { canonicalLeaseAuthorityBytesV1, leaseAuthoritySha256V1 } from "../src/proxmox-lease-authority.mjs";
import { currentLeaseFor, validRemoteDesktopRunV1 } from "./fixtures/remote-desktop-contract-v1.mjs";
import { createLeaseAuthorityIssueFixtureV1 } from "./support/fake-proxmox-lease-authority.mjs";

const zero = () => ({ taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 0, screenshotCount: 0, screenshotBytes: 0, recordingDurationMs: 0, recordingBytes: 0, diagnosticLogCount: 0, diagnosticLogBytes: 0 });
const errorCode = (code) => (error) => error?.code === code;
const sortDeep = (value) => Array.isArray(value)
  ? value.map(sortDeep)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]))
    : value;
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(sortDeep(value))}\n`, "utf8");
const directoryEntries = new Set([".codex-plugin", "assets", "bin", "completions", "corpus", "docs", "evals", "skills", "src", "validation"]);

async function candidateFixture(base) {
  const root = join(base, "candidate");
  await mkdir(root, { mode: 0o700 });
  for (const entry of DISTRIBUTION_ENTRIES) {
    const path = join(root, entry);
    if (entry === "validation") await cp(resolve("validation"), path, { recursive: true });
    else if (entry === "src") {
      await mkdir(path, { recursive: true });
      await cp(resolve("src/distribution-provenance.mjs"), join(path, "distribution-provenance.mjs"));
    }
    else if (entry.startsWith("scripts/")) {
      await mkdir(dirname(path), { recursive: true });
      await cp(resolve(entry), path);
    }
    else if (directoryEntries.has(entry)) await mkdir(path, { recursive: true });
    else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `fixture:${entry}\n`);
    }
  }
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "nelos", version: "fixture-candidate", type: "module" })}\n`);
  const integrity = await computeDistributionIntegrity(root);
  const sourceCommit = "a".repeat(40);
  await writeFile(join(root, "distribution-provenance.json"), `${JSON.stringify({
    schemaVersion: 1,
    distribution: "nelos",
    revision: "fixture-candidate",
    sourceRepository: "https://github.com/virusimmortal00/nelos.git",
    sourceRevision: sourceCommit,
    sourceRevisionType: "git",
    cacheIdentity: "https://github.com/virusimmortal00/nelos.git#nelos@fixture-candidate",
    integrity,
  })}\n`);
  const verification = await verifyInstalledNelosCandidateV1(integrity, { packageRoot: root });
  return { goldenImageInputs: verification.goldenImageInputs, integrity, root, sourceCommit };
}

function goldenOutputConfig(imageId, storage, buildId) {
  return {
    agent: "enabled=1,fstrim_cloned_disks=1",
    bios: "ovmf",
    ciuser: "ubuntu",
    cores: 4,
    cpu: "x86-64-v2-AES",
    description: `nelos-golden-v1:${buildId}`,
    efidisk0: `${storage}:vm-9001-disk-0,efitype=4m,size=4M`,
    ide2: `${storage}:cloudinit,media=cdrom`,
    ipconfig0: "ip=dhcp",
    machine: "q35",
    memory: 8192,
    name: imageId,
    net0: "virtio=02:4E:45:4C:90:27,bridge=nelosbld,firewall=1",
    onboot: 0,
    protection: 0,
    scsi0: `${storage}:vm-9001-disk-1,size=64G`,
    scsihw: "virtio-scsi-single",
    sockets: 1,
    tags: `nelos-golden;nelos-build-${buildId}`,
    template: 1,
    vga: "virtio",
  };
}

function goldenVolumeMeasurement(fields) {
  const content = { ...fields, schemaVersion: 1, status: "stopped" };
  return { ...content, measuredAt: "2026-08-20T12:00:00.000Z", contentDigest: sha256(content) };
}

function goldenVolumeContent(value) {
  const { measuredAt: _measuredAt, contentDigest: _contentDigest, ...content } = value;
  return content;
}

function resealGoldenReceipt(receipt) {
  const next = structuredClone(receipt);
  delete next.attestationDigest;
  next.output.configDigest = sha256(next.output.config);
  next.goldenImage.digest = sha256({
    schemaVersion: 2,
    domain: next.goldenImage.algorithm,
    immutableInputs: next.immutableInputs,
    sourceArtifact: next.reservation.sourceArtifact,
    sourceTemplate: next.reservation.sourceTemplate,
    sourceVolumes: goldenVolumeContent(next.volumeAttestation.source),
    outputConfig: next.output.config,
    outputVolumes: goldenVolumeContent(next.volumeAttestation.output),
  });
  return { ...next, attestationDigest: sha256(next) };
}

async function installGoldenReceipt(value, mutate) {
  const receipt = structuredClone(value.goldenReceipt);
  mutate(receipt);
  const sealed = resealGoldenReceipt(receipt);
  const path = join(value.roots.packet.path, `golden-image-${sealed.attestationDigest.slice(7)}.json`);
  await writeFile(path, canonicalBytes(sealed), { mode: 0o400 });
  await chmod(path, 0o400);
  const config = structuredClone(value.config);
  config.runPacket.packet.goldenImageReceipt = { attestationDigest: sealed.attestationDigest, path };
  config.runPacket.digest = sha256(config.runPacket.packet);
  return { config, path, receipt: sealed };
}

const admit = (value, options) => prepareProductionAdmissionV1(value.config, { candidateRoot: value.candidateRoot, ...options });

async function currentLeaseObservation(value, observedAt, mutate = () => {}) {
  const authorityObservation = structuredClone(value.config.leaseAuthority);
  authorityObservation.observedAt = new Date(observedAt).toISOString();
  mutate(authorityObservation);
  const unsigned = {
    authorityObservation,
    authorityObservationDigest: sha256(authorityObservation),
    kind: "nelos.proxmox-desktop.current-lease-observation.v2",
    schemaVersion: 2,
  };
  const receipt = { ...unsigned, observationDigest: sha256(unsigned) };
  const path = join(value.roots.recovery.path, `current-lease-${receipt.observationDigest.slice(7)}.json`);
  await writeFile(path, canonicalBytes(receipt), { mode: 0o400 });
  await chmod(path, 0o400);
  return { path, receipt };
}

async function authorizeRun(value, { now = value.now, configPath = value.configPath } = {}) {
  const lease = await currentLeaseObservation(value, now);
  return admit(value, {
    mode: "run",
    configPath,
    currentLeaseObservationPath: lease.path,
    authorizeLive: true,
    now,
  });
}

async function transitionedCurrentLeaseObservation(value, observedAt, state) {
  const previous = value.config.leaseAuthority.record;
  const operation = state === "cleanup-only" ? "cleanup-only" : "revoke";
  const unsignedRecord = {
    ...structuredClone(previous),
    previousRecordDigest: previous.recordDigest,
    revision: previous.revision + 1,
    state,
    transition: { at: new Date(observedAt).toISOString(), operation, reason: `test ${operation}` },
  };
  delete unsignedRecord.recordDigest;
  const record = { ...unsignedRecord, recordDigest: leaseAuthoritySha256V1(unsignedRecord) };
  const recordBytes = canonicalLeaseAuthorityBytesV1(record);
  const authorityObservation = {
    ...structuredClone(value.config.leaseAuthority),
    observedAt: new Date(observedAt).toISOString(),
    record,
    recordBytesBase64: recordBytes.toString("base64"),
    recordDigest: record.recordDigest,
    recordFileDigest: leaseAuthoritySha256V1(recordBytes),
  };
  const unsigned = {
    authorityObservation,
    authorityObservationDigest: sha256(authorityObservation),
    kind: "nelos.proxmox-desktop.current-lease-observation.v2",
    schemaVersion: 2,
  };
  const receipt = { ...unsigned, observationDigest: sha256(unsigned) };
  const path = join(value.roots.recovery.path, `current-lease-${receipt.observationDigest.slice(7)}.json`);
  await writeFile(path, canonicalBytes(receipt), { mode: 0o400 });
  await chmod(path, 0o400);
  return { path, receipt };
}

async function fixture(t) {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const base = await realpath(await mkdtemp(join(tmpdir(), "nelos-production-admission-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const candidate = await candidateFixture(base);
  const rootPaths = Object.fromEntries(["evidence", "packet", "recovery", "staging"].map((name) => [name, join(base, name)]));
  for (const path of Object.values(rootPaths)) await mkdir(path, { recursive: true, mode: 0o700 });
  const roots = {};
  for (const [name, path] of Object.entries(rootPaths)) {
    const info = await lstat(path);
    roots[name] = { gid: info.gid, mode: "0700", path, sealed: true, uid: info.uid };
  }
  const run = validRemoteDesktopRunV1();
  run.runId = "production-run-319";
  run.provider = {
    providerId: "proxmox-lab", hostId: "prox2", vmId: "319", macAddress: "02:4E:45:4C:03:19",
    networkId: "nelosbld", gatewayId: "9023", networkPolicyDigest: `sha256:${"9".repeat(64)}`,
  };
  run.lease = { ...run.lease, leaseId: "lease-319", fencingToken: "fence-319", expiresAt: new Date(now + 600_000).toISOString() };
  run.scenarios = [run.scenarios[0]];
  run.candidate.digest = candidate.integrity;
  run.goldenImage.imageId = "nelos-desktop-ubuntu-24-04-v1";
  const scenario = run.scenarios[0];
  const taskIntent = createProductionGuestTaskIntentV1({
    runId: run.runId,
    fencingToken: run.lease.fencingToken,
    scenarioId: scenario.scenarioId,
    title: scenario.scenarioId,
  });
  scenario.task.taskId = taskIntent.taskSlotId;
  const stateRoot = join(base, "state", run.runId);
  const sealedValueRoot = join(rootPaths.staging, "sealed-values");
  const observationRoot = join(rootPaths.staging, "observations");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(sealedValueRoot, { mode: 0o700 });
  await mkdir(observationRoot, { mode: 0o700 });
  const plan = {
    goldenImageTemplateVmId: "9001",
    reservation: { reservationId: "reservation-319", ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, state: "reserved" },
    automation: { user: "nelosauto", uid: 2401, home: "/home/nelosauto", stateRoot: `/var/lib/nelos-desktop/runs/${run.runId}`, credentialRefs: [] },
    operationUsage: { provision: zero(), cleanup: zero(), quarantine: zero() },
    scenarioUsage: { [scenario.scenarioId]: { ...zero(), taskCount: 1, modelTurnCount: 1, wallTimeMs: scenario.deadlineMs } },
    archiveConvergence: { policy: { maxConvergenceMs: 30_000, requireArchiveReceipts: true, requireRestartCheckpoint: true, requiredConsecutiveAbsent: 2 }, operationUsage: { ...zero(), wallTimeMs: 30_000, screenshotCount: 2, screenshotBytes: 2_048 } },
    evidence: { bundleDirectory: join(rootPaths.evidence, "bundle"), proposedOperationalUsage: { taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 1 }, screenshots: [], recordings: [], diagnostics: [] },
  };
  const binding = {
    fencingToken: run.lease.fencingToken, gatewayId: run.provider.gatewayId, hostId: run.provider.hostId,
    leaseId: run.lease.leaseId, macAddress: run.provider.macAddress, networkId: run.provider.networkId,
    networkPolicyDigest: run.provider.networkPolicyDigest, providerId: run.provider.providerId, runId: run.runId, vmid: 319,
  };
  const leaseAuthority = createLeaseAuthorityIssueFixtureV1({
    run,
    observedAt: new Date(now - 1_000).toISOString(),
    cleanupExpiresAt: new Date(now + 1_200_000).toISOString(),
  });
  const taskIntentBytes = canonicalBytes(taskIntent);
  const taskIntentDigest = sha256(taskIntentBytes);
  const taskIntentPath = join(rootPaths.packet, `production-task-intent-${taskIntentDigest.slice(7)}.json`);
  await writeFile(taskIntentPath, taskIntentBytes, { mode: 0o400 });
  await chmod(taskIntentPath, 0o400);
  const buildId = "0123456789abcdef0123456789abcdef";
  const storage = "local-lvm";
  const volumeAttestor = {
    helperDigest: sha256({ fixture: "volume-helper" }), hostKeyFingerprint: `SHA256:${"H".repeat(43)}`,
    identityFingerprint: `SHA256:${"I".repeat(43)}`, sshHost: "pve-1.example.invalid", sshPort: 22, sshUser: "nelosmeasure",
  };
  const sourceMeasurement = goldenVolumeMeasurement({
    providerId: run.provider.providerId, node: run.provider.hostId, storage, vmId: 8001, name: "nelos-ubuntu-source", role: "source",
    configDigest: sha256({ fixture: "source-template" }), helperDigest: volumeAttestor.helperDigest, attestorFingerprint: volumeAttestor.identityFingerprint,
    volumes: [{ byteLength: 68_719_476_736, digest: sha256({ fixture: "source-root" }), diskKey: "scsi0", volumeId: `${storage}:base-8001-disk-0` }],
  });
  const sourceTemplate = {
    configDigest: sourceMeasurement.configDigest, name: "nelos-ubuntu-source", vmId: 8001,
    volumeMeasurementDigest: sourceMeasurement.contentDigest,
  };
  const immutableInputs = { ...candidate.goldenImageInputs, candidateArchiveDigest: sha256({ fixture: "candidate-archive" }) };
  const outputConfig = goldenOutputConfig(run.goldenImage.imageId, storage, buildId);
  const providerConfigDigest = "f".repeat(40);
  const outputMeasurement = goldenVolumeMeasurement({
    providerId: run.provider.providerId, node: run.provider.hostId, storage, vmId: Number(plan.goldenImageTemplateVmId), name: run.goldenImage.imageId, role: "output",
    configDigest: sha256({ ...outputConfig, digest: providerConfigDigest }), helperDigest: volumeAttestor.helperDigest,
    attestorFingerprint: volumeAttestor.identityFingerprint,
    volumes: [
      { byteLength: 4_194_304, digest: sha256({ fixture: "output-efi" }), diskKey: "efidisk0", volumeId: `${storage}:vm-9001-disk-0` },
      { byteLength: 68_719_476_736, digest: sha256({ fixture: "output-root" }), diskKey: "scsi0", volumeId: `${storage}:vm-9001-disk-1` },
    ],
  });
  const sourceArtifact = {
    digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe",
    name: "ubuntu-24.04-server-cloudimg-amd64.img", signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
    signatureScheme: "openpgp-detached-sha256sums",
  };
  const goldenReceipt = resealGoldenReceipt({
    schemaVersion: 2,
    kind: "nelos-proxmox-desktop-golden-image-v2",
    reservation: {
      apiUrl: "https://pve-1.example.invalid/api2/json",
      networkAclPath: "/sdn/zones/nelosbld/nelosbld",
      node: run.provider.hostId,
      outputTemplate: { macAddress: "02:4E:45:4C:90:27", name: run.goldenImage.imageId, vmId: Number(plan.goldenImageTemplateVmId) },
      providerId: run.provider.providerId,
      reservationId: "golden-reservation-319",
      sourceArtifact,
      sourceTemplate,
      storage,
      tlsCaDigest: sha256({ fixture: "pve-ca" }),
      volumeAttestor,
    },
    immutableInputs,
    buildArtifact: {
      artifactId: String(plan.goldenImageTemplateVmId),
      builderId: "proxmox.clone",
      machineOutputDigest: sha256({ fixture: "machine-output" }),
      target: "desktop.proxmox-clone.desktop",
    },
    output: {
      config: outputConfig,
      configDigest: sha256(outputConfig),
      providerConfigDigest,
      status: "stopped",
      template: true,
    },
    goldenImage: {
      algorithm: "nelos-proxmox-desktop-volume-recipe-config-v2",
      digest: sha256({ fixture: "replaced-by-reseal" }),
      imageId: run.goldenImage.imageId,
      templateVmId: String(plan.goldenImageTemplateVmId),
    },
    volumeAttestation: { source: sourceMeasurement, output: outputMeasurement },
    independentAttestation: {
      observedAt: "2026-08-20T12:00:00.000Z", tokenId: "fixture@pve!attestor", volumeAttestorFingerprint: volumeAttestor.identityFingerprint,
    },
  });
  run.goldenImage.digest = goldenReceipt.goldenImage.digest;
  const goldenReceiptPath = join(rootPaths.packet, `golden-image-${goldenReceipt.attestationDigest.slice(7)}.json`);
  await writeFile(goldenReceiptPath, canonicalBytes(goldenReceipt), { mode: 0o400 });
  await chmod(goldenReceiptPath, 0o400);
  const packet = {
    authorization: { gateId: "gate-319", runId: run.runId, used: false },
    binding,
    budgets: { captureCount: 1, runDeadlineAt: new Date(now + 300_000).toISOString(), stepDeadlineMs: scenario.deadlineMs },
    capture: { height: 1080, protectedRegions: [{ height: 40, name: "system-bar", width: 1920, x: 0, y: 0 }], width: 1920 },
    expectedTask: { intentDigest: taskIntentDigest, intentPath: taskIntentPath, taskSlotId: scenario.task.taskId, title: scenario.scenarioId },
    goldenImageReceipt: { attestationDigest: goldenReceipt.attestationDigest, path: goldenReceiptPath },
    lease: { active: true, binding, expiresAt: run.lease.expiresAt, observedAt: leaseAuthority.observation.observedAt },
    leaseAuthority: leaseAuthority.authorityBinding,
    roots,
    schemaVersion: 1,
  };
  const config = {
    run,
    plan,
    candidateDigest: candidate.integrity,
    currentLease: currentLeaseFor(run),
    journalDirectory: join(stateRoot, "journal"),
    leaseAuthority: leaseAuthority.observation,
    runtimeModule: "nelos/homelab-desktop-runtime",
    homelab: {
      schemaVersion: 1, stateRoot, sealedValueRoot, observationRoot,
      guiBindings: {}, deadlines: { providerMs: 1_000, qgaMs: 1_000, archiveMs: 30_000 },
      outputLimits: { providerBytes: 1_048_576, qgaBytes: 1_048_576, archiveReportBytes: 1_048_576 },
    },
    now,
    runPacket: { digest: sha256(packet), packet },
  };
  const configPath = join(rootPaths.packet, "run.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o400 });
  await chmod(configPath, 0o400);
  return { candidateRoot: candidate.root, config, configPath, goldenReceipt, goldenReceiptPath, now, taskIntentPath, roots };
}

test("production admission preflight is read-only and the first run consumes one immutable gate", async (t) => {
  const value = await fixture(t);
  const preflight = await admit(value, { mode: "preflight", configPath: value.configPath, now: value.now });
  assert.equal(preflight.gateReceipt, null);
  const { receiptDigest, ...unsignedVerification } = preflight.verificationReceipt;
  assert.equal(receiptDigest, sha256(unsignedVerification));
  assert.equal(preflight.verificationReceiptDigest, receiptDigest);
  assert.equal(preflight.verificationReceipt.candidate.goldenImageInputs.sourceInputsDigest, value.goldenReceipt.immutableInputs.sourceInputsDigest);
  await assert.rejects(access(preflight.receiptPath));
  await assert.rejects(admit(value, { mode: "run", configPath: value.configPath, now: value.now }), errorCode("AUTHORIZATION_REQUIRED"));
  await assert.rejects(admit(value, {
    mode: "run", configPath: value.configPath, authorizeLive: true, now: value.now,
  }), errorCode("LEASE_NOT_CURRENT"));

  const lease = await currentLeaseObservation(value, value.now + 1);
  const first = await admit(value, { mode: "run", configPath: value.configPath, currentLeaseObservationPath: lease.path, authorizeLive: true, now: value.now });
  const adopted = await admit(value, { mode: "run", configPath: value.configPath, currentLeaseObservationPath: lease.path, authorizeLive: true, now: value.now });
  const resumed = await admit(value, { mode: "resume", configPath: value.configPath, currentLeaseObservationPath: lease.path, now: value.now });
  assert.equal(first.gateReceiptDigest, adopted.gateReceiptDigest);
  assert.equal(first.gateReceiptDigest, resumed.gateReceiptDigest);
  assert.equal(first.configDigest, sha256(value.config));
  assert.equal((await lstat(first.receiptPath)).mode & 0o777, 0o400);
});

test("packaged recovery observation writer derives its receipt only from the independent root-bound attestor", async (t) => {
  const value = await fixture(t);
  let envelope = null;
  const written = await createCurrentLeaseObservationV1(value.config, {
    configPath: value.configPath,
    clock: { now: () => value.now },
    observeRootBinding: async (request) => {
      envelope = structuredClone(request);
      return { ...structuredClone(value.config.leaseAuthority), observedAt: new Date(value.now).toISOString() };
    },
  });
  await admit(value, { mode: "run", configPath: value.configPath, currentLeaseObservationPath: written.path, authorizeLive: true, now: value.now });
  assert.deepEqual(envelope.request, { method: "GET", path: "/nelos/lease-authority/current" });
  assert.equal(envelope.binding.fencingToken, value.config.run.lease.fencingToken);
  assert.equal(envelope.binding.leaseId, value.config.run.lease.leaseId);
  assert.equal(envelope.binding.runId, value.config.run.runId);
  assert.equal(written.receipt.authorityObservation.recordDigest, value.config.leaseAuthority.recordDigest);
  assert.equal(written.receipt.authorityObservationDigest, sha256(written.receipt.authorityObservation));
  assert.equal(written.path, join(value.roots.recovery.path, `current-lease-${written.receipt.observationDigest.slice(7)}.json`));
  assert.equal((await lstat(written.path)).mode & 0o777, 0o400);
  const resumed = await admit(value, { mode: "resume", configPath: value.configPath, currentLeaseObservationPath: written.path, now: value.now });
  assert.equal(resumed.currentLeaseObservationDigest, written.receipt.observationDigest);
  const source = await readFile(resolve("bin/nelos-observe-current-lease"), "utf8");
  assert.match(source, /nelos-proxmox-attest-transport/u);
  assert.doesNotMatch(source, /"nelos-proxmox-transport"/u);
});

test("recovery uses a fresh external lease observation and keeps cleanup available after the run deadline", async (t) => {
  const value = await fixture(t);
  await authorizeRun(value);

  const afterPacketFreshness = value.now + 31_000;
  const paidLease = await currentLeaseObservation(value, afterPacketFreshness - 1_000);
  const resumed = await admit(value, {
    mode: "resume", configPath: value.configPath, currentLeaseObservationPath: paidLease.path, now: afterPacketFreshness,
  });
  assert.equal(resumed.recoveryMode, "continue");
  assert.equal(resumed.currentLeaseObservationDigest, paidLease.receipt.observationDigest);

  const authorityCleanupOnly = await transitionedCurrentLeaseObservation(value, afterPacketFreshness, "cleanup-only");
  const cleanupOnlyResume = await admit(value, {
    mode: "resume", configPath: value.configPath, currentLeaseObservationPath: authorityCleanupOnly.path, now: afterPacketFreshness,
  });
  assert.equal(cleanupOnlyResume.recoveryMode, "cleanup-only");
  const revoked = await transitionedCurrentLeaseObservation(value, afterPacketFreshness, "revoked");
  await assert.rejects(admit(value, {
    mode: "resume", configPath: value.configPath, currentLeaseObservationPath: revoked.path, now: afterPacketFreshness,
  }), errorCode("LEASE_MANUAL_RECONCILIATION_REQUIRED"));

  await assert.rejects(admit(value, {
    mode: "resume", configPath: value.configPath, now: afterPacketFreshness,
  }), errorCode("LEASE_NOT_CURRENT"));
  const staleLease = await currentLeaseObservation(value, value.now - 1_000);
  await assert.rejects(admit(value, {
    mode: "resume", configPath: value.configPath, currentLeaseObservationPath: staleLease.path, now: afterPacketFreshness,
  }), errorCode("STALE_LEASE_AUTHORITY_OBSERVATION"));
  const wrongFence = await currentLeaseObservation(value, afterPacketFreshness, (observation) => { observation.record.lease.fencingToken = "fence-other"; });
  await assert.rejects(admit(value, {
    mode: "resume", configPath: value.configPath, currentLeaseObservationPath: wrongFence.path, now: afterPacketFreshness,
  }), errorCode("LEASE_AUTHORITY_DIGEST_MISMATCH"));

  const afterRunDeadline = value.now + 301_000;
  const cleanupLease = await currentLeaseObservation(value, afterRunDeadline - 1_000);
  const cleanup = await admit(value, {
    mode: "resume", configPath: value.configPath, currentLeaseObservationPath: cleanupLease.path, now: afterRunDeadline,
  });
  assert.equal(cleanup.recoveryMode, "cleanup-only");
  const cancelled = await admit(value, {
    mode: "cancel", configPath: value.configPath, currentLeaseObservationPath: cleanupLease.path, now: afterRunDeadline,
  });
  assert.equal(cancelled.recoveryMode, "cleanup-only");
});

test("recovery lease proof is same-file read from the canonical content-addressed recovery root", async (t) => {
  const value = await fixture(t);
  await authorizeRun(value);
  const lease = await currentLeaseObservation(value, value.now + 1);

  const outside = join(dirname(value.roots.recovery.path), `current-lease-${lease.receipt.observationDigest.slice(7)}.json`);
  await writeFile(outside, canonicalBytes(lease.receipt), { mode: 0o400 });
  await chmod(outside, 0o400);
  await assert.rejects(admit(value, {
    mode: "resume", configPath: value.configPath, currentLeaseObservationPath: outside, now: value.now,
  }), errorCode("LEASE_NOT_CURRENT"));

  const forgedName = join(value.roots.recovery.path, `current-lease-${"0".repeat(64)}.json`);
  await writeFile(forgedName, canonicalBytes(lease.receipt), { mode: 0o400 });
  await chmod(forgedName, 0o400);
  await assert.rejects(admit(value, {
    mode: "resume", configPath: value.configPath, currentLeaseObservationPath: forgedName, now: value.now,
  }), errorCode("LEASE_NOT_CURRENT"));

  const linkedName = join(value.roots.recovery.path, `current-lease-${"1".repeat(64)}.json`);
  await symlink(lease.path, linkedName);
  await assert.rejects(admit(value, {
    mode: "resume", configPath: value.configPath, currentLeaseObservationPath: linkedName, now: value.now,
  }), errorCode("LEASE_NOT_CURRENT"));

  const runtimeSource = await readFile(resolve("src/proxmox-desktop-runtime.mjs"), "utf8");
  assert.match(runtimeSource, /const after = await handle\.stat\(\)/u);
  for (const field of ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeMs", "ctimeMs"]) {
    assert.match(runtimeSource, new RegExp(`stableFields[^;]+"${field}"`, "u"));
  }
});

test("a changed packet, gate, or sealed config cannot reuse an already consumed run authorization", async (t) => {
  const value = await fixture(t);
  await authorizeRun(value);
  const changed = structuredClone(value.config);
  changed.runPacket.packet.authorization.gateId = "gate-other";
  changed.runPacket.digest = sha256(changed.runPacket.packet);
  await chmod(value.configPath, 0o600);
  await writeFile(value.configPath, `${JSON.stringify(changed)}\n`);
  await chmod(value.configPath, 0o400);
  const lease = await currentLeaseObservation(value, value.now + 1);
  await assert.rejects(prepareProductionAdmissionV1(changed, { candidateRoot: value.candidateRoot, mode: "run", configPath: value.configPath, currentLeaseObservationPath: lease.path, authorizeLive: true, now: value.now }), errorCode("AUTHORIZATION_REQUIRED"));

  await chmod(value.configPath, 0o600);
  await assert.rejects(prepareProductionAdmissionV1(changed, { candidateRoot: value.candidateRoot, mode: "preflight", configPath: value.configPath, now: value.now }), errorCode("UNSEALED_ROOT"));
});

test("production admission validates the bound guest task intent before any live authorization", async (t) => {
  const value = await fixture(t);
  await chmod(value.taskIntentPath, 0o600);
  await writeFile(value.taskIntentPath, "{}\n");
  await chmod(value.taskIntentPath, 0o400);
  await assert.rejects(
    admit(value, { mode: "preflight", configPath: value.configPath, now: value.now }),
    errorCode("UNTRUSTED_GUEST_TASK_INTENT"),
  );
});

test("production admission rejects a packet task slot that its guest intent does not prove", async (t) => {
  const value = await fixture(t);
  const changed = structuredClone(value.config);
  changed.run.scenarios[0].task.taskId = "packet-only-task";
  changed.runPacket.packet.expectedTask.taskSlotId = "task-slot-" + "b".repeat(64);
  changed.runPacket.digest = sha256(changed.runPacket.packet);
  await assert.rejects(
    prepareProductionAdmissionV1(changed, { candidateRoot: value.candidateRoot, mode: "preflight", now: value.now }),
    errorCode("TASK_SURFACE_MISMATCH"),
  );
});

test("production authorization recomputes the installed candidate and rejects caller lies or byte tampering first", async (t) => {
  const value = await fixture(t);
  const verified = await verifyInstalledNelosCandidateV1(value.config.candidateDigest, { packageRoot: value.candidateRoot });
  assert.equal(verified.candidateDigest, value.config.run.candidate.digest);
  assert.equal(verified.sourceCommit, "a".repeat(40));
  const authorizationReceiptPath = join(value.roots.packet.path, ".nelos-production-authorization.used.json");

  const lied = structuredClone(value.config);
  lied.candidateDigest = `sha256:${"f".repeat(64)}`;
  lied.run.candidate.digest = lied.candidateDigest;
  await assert.rejects(
    prepareProductionAdmissionV1(lied, { candidateRoot: value.candidateRoot, mode: "run", authorizeLive: true, now: value.now }),
    errorCode("CANDIDATE_INTEGRITY_MISMATCH"),
  );
  await assert.rejects(access(authorizationReceiptPath));

  const provenancePath = join(value.candidateRoot, "distribution-provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  const incompleteProvenance = structuredClone(provenance);
  delete incompleteProvenance.sourceRepository;
  await writeFile(provenancePath, `${JSON.stringify(incompleteProvenance)}\n`);
  await assert.rejects(
    admit(value, { mode: "run", authorizeLive: true, now: value.now }),
    errorCode("CANDIDATE_INTEGRITY_MISMATCH"),
  );
  await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`);
  await assert.rejects(access(authorizationReceiptPath));

  await writeFile(join(value.candidateRoot, "README.md"), "tampered candidate bytes\n");
  await assert.rejects(
    admit(value, { mode: "run", authorizeLive: true, now: value.now }),
    errorCode("CANDIDATE_INTEGRITY_MISMATCH"),
  );
  await assert.rejects(access(authorizationReceiptPath));
});

test("production authorization rejects altered or cross-run golden attestations before consuming the gate", async (t) => {
  const value = await fixture(t);
  const authorizationReceiptPath = join(value.roots.packet.path, ".nelos-production-authorization.used.json");
  await chmod(value.goldenReceiptPath, 0o600);
  await writeFile(value.goldenReceiptPath, Buffer.concat([canonicalBytes(value.goldenReceipt), Buffer.from("\n")]));
  await chmod(value.goldenReceiptPath, 0o400);
  await assert.rejects(
    admit(value, { mode: "run", configPath: value.configPath, authorizeLive: true, now: value.now }),
    errorCode("GOLDEN_IMAGE_ATTESTATION_MISMATCH"),
  );
  await assert.rejects(access(authorizationReceiptPath));

  const digestDrift = structuredClone(value.config);
  digestDrift.runPacket.packet.goldenImageReceipt.attestationDigest = `sha256:${"c".repeat(64)}`;
  digestDrift.runPacket.digest = sha256(digestDrift.runPacket.packet);
  await assert.rejects(
    prepareProductionAdmissionV1(digestDrift, { candidateRoot: value.candidateRoot, mode: "run", authorizeLive: true, now: value.now }),
    errorCode("GOLDEN_IMAGE_ATTESTATION_MISMATCH"),
  );
  await assert.rejects(access(authorizationReceiptPath));

  const cases = [
    {
      label: "template VMID",
      mutate(receipt) {
        receipt.reservation.outputTemplate.vmId = 9002;
        receipt.buildArtifact.artifactId = "9002";
        receipt.goldenImage.templateVmId = "9002";
      },
    },
    {
      label: "immutable image name",
      mutate(receipt) {
        receipt.reservation.outputTemplate.name = "forged-desktop-image";
        receipt.output.config.name = "forged-desktop-image";
        receipt.goldenImage.imageId = "forged-desktop-image";
      },
      bindCaller(config, receipt) {
        config.run.goldenImage.imageId = receipt.goldenImage.imageId;
        config.run.goldenImage.digest = receipt.goldenImage.digest;
      },
    },
    { label: "provider", mutate(receipt) { receipt.reservation.providerId = "other-provider"; } },
    { label: "node", mutate(receipt) { receipt.reservation.node = "other-node"; } },
    { label: "recipe config", mutate(receipt) { receipt.output.config.memory = 4096; } },
    {
      label: "fabricated sealed build inputs",
      mutate(receipt) {
        receipt.immutableInputs.packageLockDigest = `sha256:${"d".repeat(64)}`;
        receipt.immutableInputs.sourceInputsDigest = `sha256:${"e".repeat(64)}`;
      },
      bindCaller(config, receipt) { config.run.goldenImage.digest = receipt.goldenImage.digest; },
    },
    {
      label: "candidate source commit",
      mutate(receipt) { receipt.immutableInputs.sourceCommit = "b".repeat(40); },
      bindCaller(config, receipt) { config.run.goldenImage.digest = receipt.goldenImage.digest; },
    },
  ];
  for (const entry of cases) {
    const installed = await installGoldenReceipt(value, entry.mutate);
    entry.bindCaller?.(installed.config, installed.receipt);
    await assert.rejects(
      prepareProductionAdmissionV1(installed.config, { candidateRoot: value.candidateRoot, mode: "run", authorizeLive: true, now: value.now }),
      errorCode("GOLDEN_IMAGE_ATTESTATION_MISMATCH"),
      entry.label,
    );
    await assert.rejects(access(authorizationReceiptPath));
  }
});

test("production packet cross-binding rejects VM, lease, task, budget, and root drift", async (t) => {
  const value = await fixture(t);
  const cases = [
    (config) => { config.run.provider.vmId = "320"; },
    (config) => { config.run.lease.fencingToken = "different-fence"; },
    (config) => { config.run.scenarios[0].task.taskId = "different-task"; },
    (config) => { config.runPacket.packet.budgets.stepDeadlineMs = 1; },
    (config) => { config.plan.evidence.bundleDirectory = join(value.roots.staging.path, "bundle"); },
    (config) => { config.runPacket.packet.expectedTask.intentDigest = `sha256:${"b".repeat(64)}`; },
  ];
  for (const mutate of cases) {
    const changed = structuredClone(value.config);
    mutate(changed);
    assert.throws(() => validateProductionConfigBindingV1(changed, changed.runPacket.packet, { configPath: value.configPath }), (error) => ["IDENTITY_MISMATCH", "TASK_SURFACE_MISMATCH", "INVALID_CONTRACT", "UNSEALED_ROOT", "TASK_INTENT_BINDING_MISMATCH"].includes(error.code));
  }
});

test("production CLI never accepts a packet-controlled clock", async () => {
  const source = await readFile(new URL("../bin/nelos-desktop-runner", import.meta.url), "utf8");
  assert.match(source, /production run configs cannot override the controller clock/u);
  assert.match(source, /const admissionNow = liveRuntime && !offline \? Date\.now\(\) : config\.now/u);
  assert.doesNotMatch(source, /prepareProductionAdmissionV1\([^\n]+now: config\.now/u);
});
