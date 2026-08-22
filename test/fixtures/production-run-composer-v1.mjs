import { execFile } from "node:child_process";
import {
  chmod,
  chown,
  cp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { computeDistributionIntegrity } from "../../src/distribution-provenance.mjs";
import { createProductionGuestTaskIntentV1 } from "../../src/production-guest-task.mjs";
import { canonicalLeaseAuthorityBytesV1, leaseAuthoritySha256V1 } from "../../src/proxmox-lease-authority.mjs";
import { sha256, verifyInstalledNelosCandidateV1 } from "../../src/proxmox-desktop-runtime.mjs";
import { canonicalProductionRunBytesV1 } from "../../validation/proxmox-desktop/v1/prepare-production-run.mjs";

const exec = promisify(execFile);

function zeroUsage() {
  return {
    taskCount: 0,
    modelTurnCount: 0,
    spendUsd: 0,
    wallTimeMs: 0,
    screenshotCount: 0,
    screenshotBytes: 0,
    recordingDurationMs: 0,
    recordingBytes: 0,
    diagnosticLogCount: 0,
    diagnosticLogBytes: 0,
  };
}

async function git(root, ...argumentsList) {
  return exec("/usr/bin/git", ["-C", root, ...argumentsList], {
    encoding: "utf8",
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      HOME: "/var/empty",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
  });
}

async function sealed(path, value) {
  await writeFile(path, canonicalProductionRunBytesV1(value), { flag: "wx", mode: 0o400 });
  await chown(path, process.getuid(), process.getgid());
  await chmod(path, 0o400);
  return path;
}

async function key(root, name) {
  const path = join(root, name);
  await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `nelos-composer-${name}`, "-f", path], {
    encoding: "utf8",
    env: { HOME: "/var/empty", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  const publicKey = (await readFile(`${path}.pub`, "utf8")).trim();
  const { stdout } = await exec("/usr/bin/ssh-keygen", ["-lf", `${path}.pub`, "-E", "sha256"], {
    encoding: "utf8",
    env: { HOME: "/var/empty", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  const fingerprint = /SHA256:[A-Za-z0-9+/]{43}/u.exec(stdout)?.[0];
  if (!fingerprint) throw new Error(`fixture ${name} fingerprint is unavailable`);
  return { fingerprint, path, publicKey };
}

function outputConfig(imageId, storage, buildId, templateVmId) {
  return {
    agent: "enabled=1,fstrim_cloned_disks=1",
    bios: "ovmf",
    ciuser: "ubuntu",
    cores: 4,
    cpu: "x86-64-v2-AES",
    description: `nelos-golden-v1:${buildId}`,
    efidisk0: `${storage}:vm-${templateVmId}-disk-0,efitype=4m,size=4M`,
    ide2: `${storage}:cloudinit,media=cdrom`,
    ipconfig0: "ip=dhcp",
    machine: "q35",
    memory: 8192,
    name: imageId,
    net0: "virtio=02:4E:45:4C:90:27,bridge=nelosbld,firewall=1",
    onboot: 0,
    protection: 0,
    scsi0: `${storage}:vm-${templateVmId}-disk-1,size=64G`,
    scsihw: "virtio-scsi-single",
    sockets: 1,
    tags: `nelos-golden;nelos-build-${buildId}`,
    template: 1,
    vga: "virtio",
  };
}

function goldenVolumeMeasurement({ providerId, node, storage, vmId, name, role, configDigest, helperDigest, attestorFingerprint, volumes, measuredAt }) {
  const content = {
    schemaVersion: 1, providerId, node, storage, vmId, name, role, status: "stopped", configDigest, helperDigest, attestorFingerprint, volumes,
  };
  return { ...content, measuredAt, contentDigest: sha256(content) };
}

function goldenReceipt({ candidateVerification, observedAt }) {
  const imageId = "nelos-desktop-ubuntu-24-04-v1";
  const templateVmId = 9025;
  const sourceConfigDigest = sha256({ fixture: "composer-source-template-9024" });
  const volumeAttestor = {
    helperDigest: sha256({ fixture: "composer-volume-helper" }),
    hostKeyFingerprint: `SHA256:${"H".repeat(43)}`,
    identityFingerprint: `SHA256:${"I".repeat(43)}`,
    sshHost: "prox2.sayers.io",
    sshPort: 22,
    sshUser: "nelosmeasure",
  };
  const sourceMeasurement = goldenVolumeMeasurement({
    providerId: "proxmox-lab", node: "prox2", storage: "local-lvm", vmId: 9024, name: "nelos-ubuntu-24-04-source", role: "source",
    configDigest: sourceConfigDigest, helperDigest: volumeAttestor.helperDigest, attestorFingerprint: volumeAttestor.identityFingerprint,
    volumes: [
      { byteLength: 4_194_304, digest: sha256({ fixture: "composer-source-efi" }), diskKey: "efidisk0", volumeId: "local-lvm:base-9024-disk-1" },
      { byteLength: 68_719_476_736, digest: sha256({ fixture: "composer-source-root" }), diskKey: "scsi0", volumeId: "local-lvm:base-9024-disk-0" },
    ], measuredAt: observedAt,
  });
  const sourceTemplate = {
    configDigest: sourceConfigDigest,
    name: "nelos-ubuntu-24-04-source",
    vmId: 9024,
    volumeMeasurementDigest: sourceMeasurement.contentDigest,
  };
  const storage = "local-lvm";
  const buildId = "0123456789abcdef0123456789abcdef";
  const config = outputConfig(imageId, storage, buildId, templateVmId);
  const immutableInputs = { ...candidateVerification.goldenImageInputs, candidateArchiveDigest: sha256({ fixture: "composer-candidate-archive" }) };
  const providerConfigDigest = "f".repeat(40);
  const outputMeasurement = goldenVolumeMeasurement({
    providerId: "proxmox-lab", node: "prox2", storage, vmId: templateVmId, name: imageId, role: "output",
    configDigest: sha256({ ...config, digest: providerConfigDigest }), helperDigest: volumeAttestor.helperDigest,
    attestorFingerprint: volumeAttestor.identityFingerprint,
    volumes: [
      { byteLength: 4_194_304, digest: sha256({ fixture: "composer-output-efi" }), diskKey: "efidisk0", volumeId: `${storage}:vm-${templateVmId}-disk-0` },
      { byteLength: 68_719_476_736, digest: sha256({ fixture: "composer-output-root" }), diskKey: "scsi0", volumeId: `${storage}:vm-${templateVmId}-disk-1` },
    ], measuredAt: observedAt,
  });
  const sourceArtifact = {
    digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe",
    name: "ubuntu-24.04-server-cloudimg-amd64.img",
    signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
    signatureScheme: "openpgp-detached-sha256sums",
  };
  const digest = sha256({
    schemaVersion: 2,
    domain: "nelos-proxmox-desktop-volume-recipe-config-v2",
    immutableInputs,
    sourceArtifact,
    sourceTemplate,
    sourceVolumes: goldenVolumeMeasurementContent(sourceMeasurement),
    outputConfig: config,
    outputVolumes: goldenVolumeMeasurementContent(outputMeasurement),
  });
  const unsigned = {
    schemaVersion: 2,
    kind: "nelos-proxmox-desktop-golden-image-v2",
    reservation: {
      apiUrl: "https://prox2.sayers.io/api2/json",
      networkAclPath: "/sdn/zones/nelosbld/nelosbld",
      node: "prox2",
      outputTemplate: { macAddress: "02:4E:45:4C:90:27", name: imageId, vmId: templateVmId },
      providerId: "proxmox-lab",
      reservationId: "golden-reservation-9025",
      sourceArtifact,
      sourceTemplate,
      storage,
      tlsCaDigest: sha256({ fixture: "composer-proxmox-ca" }),
      volumeAttestor,
    },
    immutableInputs,
    buildArtifact: {
      artifactId: String(templateVmId),
      builderId: "proxmox.clone",
      machineOutputDigest: sha256({ fixture: "composer-packer-output" }),
      target: "desktop.proxmox-clone.desktop",
    },
    output: {
      config,
      configDigest: sha256(config),
      providerConfigDigest,
      status: "stopped",
      template: true,
    },
    goldenImage: {
      algorithm: "nelos-proxmox-desktop-volume-recipe-config-v2",
      digest,
      imageId,
      templateVmId: String(templateVmId),
    },
    volumeAttestation: { source: sourceMeasurement, output: outputMeasurement },
    independentAttestation: { observedAt, tokenId: "composer-attestor@pve!readonly", volumeAttestorFingerprint: volumeAttestor.identityFingerprint },
  };
  return { ...unsigned, attestationDigest: sha256(unsigned) };
}

function goldenVolumeMeasurementContent(value) {
  const { measuredAt: _measuredAt, contentDigest: _contentDigest, ...content } = value;
  return content;
}

export async function stageComposerCandidateFixture({ repositoryRoot, suiteRoot }) {
  const sourceRoot = join(suiteRoot, "source");
  await cp(repositoryRoot, sourceRoot, {
    recursive: true,
    filter(source) {
      const name = basename(source);
      return ![".git", "node_modules", "dist"].includes(name) && !name.startsWith(".nelos-worktree-launch-");
    },
  });
  const provenancePath = join(sourceRoot, "distribution-provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.integrity = await computeDistributionIntegrity(sourceRoot);
  delete provenance.sourceRevision;
  delete provenance.sourceRevisionType;
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await git(sourceRoot, "init", "-b", "main");
  await git(sourceRoot, "config", "user.name", "Nelos Composer Test");
  await git(sourceRoot, "config", "user.email", "composer@example.invalid");
  await git(sourceRoot, "add", ".");
  await git(sourceRoot, "commit", "-m", "composer candidate fixture");

  const candidateRoot = join(suiteRoot, "candidate");
  const { stdout, stderr } = await exec(process.execPath, [join(sourceRoot, "scripts", "stage-production-desktop-candidate.mjs"), "--out-dir", candidateRoot], {
    encoding: "utf8",
    env: { HOME: "/var/empty", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (stderr !== "") throw new Error(`candidate stager wrote stderr: ${stderr}`);
  const manifest = JSON.parse(stdout);
  const manifestPath = join(suiteRoot, "candidate-manifest.json");
  await writeFile(manifestPath, stdout, { flag: "wx", mode: 0o400 });
  await chown(manifestPath, process.getuid(), process.getgid());
  await chmod(manifestPath, 0o400);
  const verification = await verifyInstalledNelosCandidateV1(manifest.candidateDigest, { packageRoot: candidateRoot });
  const keysRoot = join(suiteRoot, "keys");
  await mkdir(keysRoot, { mode: 0o700 });
  const [providerKey, attestorKey, hostKey] = await Promise.all([
    key(keysRoot, "provider"),
    key(keysRoot, "attestor"),
    key(keysRoot, "host"),
  ]);
  const knownHostsFile = join(keysRoot, "known-hosts");
  await writeFile(knownHostsFile, `192.168.1.110 ${hostKey.publicKey.split(/\s+/u).slice(0, 2).join(" ")}\n`, { mode: 0o600 });
  await chmod(knownHostsFile, 0o600);
  return {
    candidateRoot,
    manifest,
    manifestBytes: Buffer.from(stdout),
    manifestPath,
    verification,
    providerKey,
    attestorKey,
    hostKey,
    knownHostsFile,
  };
}

export async function createProductionRunComposerFixture({ suiteRoot, candidate, name, now = Date.now() }) {
  const runId = `desktop-run-${name}`;
  const scenarioId = `desktop-scenario-${name}`;
  const fencingToken = `fence-${name}`;
  const taskIntent = createProductionGuestTaskIntentV1({ runId, fencingToken, scenarioId, title: scenarioId });
  const taskId = taskIntent.taskSlotId;
  const inputRoot = join(suiteRoot, "inputs", runId);
  const outputParent = join(suiteRoot, "runs");
  await mkdir(inputRoot, { recursive: true, mode: 0o700 });
  await chown(inputRoot, process.getuid(), process.getgid());
  await chmod(inputRoot, 0o700);
  await mkdir(outputParent, { recursive: true, mode: 0o700 });
  await chown(outputParent, process.getuid(), process.getgid());
  await chmod(outputParent, 0o700);
  const outputRoot = join(outputParent, runId);
  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 900_000).toISOString();
  const cleanupExpiresAt = new Date(now + 1_200_000).toISOString();
  const scenario = {
    schemaVersion: 1,
    scenarioId,
    task: { taskId, createdForScenario: scenarioId, fresh: true },
    actions: [
      { actionId: `${name}-type`, type: "type_text_ref", targetRef: "task-composer", valueRef: `benchmark-${name}`, timeoutMs: 10_000 },
      { actionId: `${name}-submit`, type: "keypress", targetRef: "submit-key", valueRef: null, timeoutMs: 5_000 },
      { actionId: `${name}-wait`, type: "wait_for", targetRef: "task-complete-wait", valueRef: null, timeoutMs: 120_000 },
    ],
    checkpoints: [
      { checkpointId: `${name}-completed`, type: "screenshot", afterActionId: `${name}-wait`, failureOnly: false },
    ],
    assertions: [
      { assertionId: `${name}-task-state`, type: "task_state", targetRef: "active-task", expectedRef: "task-complete", checkpointId: `${name}-completed` },
    ],
    deadlineMs: 180_000,
    failureCaptureTriggers: ["action_error", "assertion_failure", "deadline_exceeded", "desktop_crash", "task_stalled"],
  };
  const scenarioInput = {
    schemaVersion: 1,
    benchmarkProfile: { profileId: "desktop-blackbox-standard", digest: sha256({ fixture: "benchmark-profile-v1" }) },
    scenarioManifest: { manifestId: `manifest-${name}`, digest: sha256({ schemaVersion: 1, scenarios: [scenario] }) },
    scenario,
  };
  const provider = {
    schemaVersion: 1,
    provider: {
      hostId: "prox2", providerId: "proxmox-lab", vmId: "9028",
      macAddress: "02:4E:45:4C:90:28", networkId: "nelosbld", gatewayId: "9023",
      networkPolicyDigest: sha256({ fixture: "nelosbld-validation-policy-v1" }),
    },
    access: { providerPublicKey: candidate.providerKey.publicKey, attestorPublicKey: candidate.attestorKey.publicKey },
    controller: {
      sshHost: "192.168.1.110",
      sshPort: 22,
      hostPublicKey: candidate.hostKey.publicKey,
      hostFingerprint: candidate.hostKey.fingerprint,
      knownHostsFile: candidate.knownHostsFile,
      providerIdentityFile: candidate.providerKey.path,
      attestorIdentityFile: candidate.attestorKey.path,
    },
  };
  const authorityId = "prox2-desktop-authority-v1";
  const trustDigest = leaseAuthoritySha256V1({ authorityId, fixture: "production-composer-authority-trust-v1" });
  const unsignedAuthorityRecord = {
    authority: { authorityId, trustDigest },
    epoch: 1,
    kind: "nelos.proxmox-desktop.lease-authority-record.v1",
    lease: {
      cleanupExpiresAt,
      expiresAt,
      fencingToken,
      holderId: "nelos-validator",
      issuedAt: observedAt,
      leaseId: `lease-${name}`,
      runId,
    },
    previousRecordDigest: null,
    resource: { hostId: provider.provider.hostId, providerId: provider.provider.providerId, vmid: provider.provider.vmId },
    revision: 1,
    schemaVersion: 1,
    state: "active",
    transition: { at: observedAt, operation: "issue", reason: `fixture lease ${name}` },
  };
  const authorityRecord = { ...unsignedAuthorityRecord, recordDigest: leaseAuthoritySha256V1(unsignedAuthorityRecord) };
  const authorityRecordBytes = canonicalLeaseAuthorityBytesV1(authorityRecord);
  const lease = {
    authorityId,
    kind: "nelos.proxmox-desktop.lease-authority-observation.v1",
    observedAt,
    record: authorityRecord,
    recordBytesBase64: authorityRecordBytes.toString("base64"),
    recordDigest: authorityRecord.recordDigest,
    recordFileDigest: leaseAuthoritySha256V1(authorityRecordBytes),
    resourceKey: leaseAuthoritySha256V1(authorityRecord.resource).slice(7),
    schemaVersion: 1,
    trustDigest,
  };
  const policy = {
    maxTaskCount: 2,
    maxModelTurnCount: 12,
    maxSpendUsd: 4,
    reservedSpendUsd: 5,
    maxWallTimeMs: 600_000,
    screenshots: { maxCount: 12, maxBytes: 12_000_000 },
    recording: { enabled: true, maxDurationMs: 180_000, maxBytes: 50_000_000 },
    diagnostics: { maxCount: 8, maxBytes: 2_000_000 },
  };
  const reservation = {
    schemaVersion: 1,
    authorizationGateId: `gate-${name}`,
    automationUid: 2401,
    reservationId: `reservation-${name}`,
    runId,
    packetBudgets: { captureCount: 8, runDeadlineAt: new Date(now + 480_000).toISOString(), stepDeadlineMs: 180_000 },
    capture: { width: 1920, height: 1080, protectedRegions: [{ name: "system-bar", x: 0, y: 0, width: 1920, height: 40 }] },
    operationUsage: { provision: zeroUsage(), cleanup: zeroUsage(), quarantine: zeroUsage() },
    scenarioUsage: { ...zeroUsage(), taskCount: 1, modelTurnCount: 1, spendUsd: 1, wallTimeMs: 180_000, screenshotCount: 1, screenshotBytes: 2_000_000 },
    archiveConvergence: {
      policy: { maxConvergenceMs: 30_000, requireArchiveReceipts: true, requireRestartCheckpoint: true, requiredConsecutiveAbsent: 2 },
      operationUsage: { ...zeroUsage(), wallTimeMs: 30_000, screenshotCount: 2, screenshotBytes: 2_000_000 },
    },
    evidence: {
      proposedOperationalUsage: { taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 1_000 },
      screenshots: [
        { artifactId: `${name}-active-surface`, scenarioId, maxOutputBytes: 2_000_000 },
        { artifactId: `${name}-completed-surface`, scenarioId, maxOutputBytes: 2_000_000 },
      ],
      recordings: [],
      diagnostics: [{ diagnosticId: `${name}-lifecycle`, scenarioId, code: "DESKTOP_LIFECYCLE_SURFACES" }],
    },
    homelab: {
      deadlines: { providerMs: 30_000, qgaMs: 20_000, archiveMs: 60_000 },
      outputLimits: { providerBytes: 8_388_608, qgaBytes: 8_388_608, archiveReportBytes: 10_485_760 },
      guiBindings: {
        "task-composer": { role: "textbox" },
        "submit-key": { role: "textbox", key: "ENTER" },
        "task-complete-wait": { condition: "task_complete" },
        "active-task": { role: "list item", state: "active" },
        "task-complete": { state: "completed" },
      },
    },
    policy,
  };
  const golden = goldenReceipt({ candidateVerification: candidate.verification, observedAt });
  const paths = {
    candidatePath: candidate.manifestPath,
    goldenReceiptPath: await sealed(join(inputRoot, "golden.json"), golden),
    taskIntentPath: await sealed(join(inputRoot, "task-intent.json"), taskIntent),
    providerPath: await sealed(join(inputRoot, "provider.json"), provider),
    leasePath: await sealed(join(inputRoot, "lease.json"), lease),
    reservationPath: await sealed(join(inputRoot, "reservation.json"), reservation),
    scenarioPath: await sealed(join(inputRoot, "scenario.json"), scenarioInput),
    outputRoot,
  };
  return { golden, inputRoot, lease, now, outputRoot, paths, provider, reservation, runId, scenario, scenarioInput, taskIntent };
}

export function composerCliArguments(paths) {
  return [
    "--candidate-manifest", paths.candidatePath,
    "--golden-receipt", paths.goldenReceiptPath,
    "--task-intent", paths.taskIntentPath,
    "--provider", paths.providerPath,
    "--lease", paths.leasePath,
    "--reservation", paths.reservationPath,
    "--scenario", paths.scenarioPath,
    "--output-root", paths.outputRoot,
  ];
}
