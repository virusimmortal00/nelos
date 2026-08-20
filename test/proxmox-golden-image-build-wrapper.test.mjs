import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GoldenImageBuildError,
  canonicalJsonV1,
  createGoldenImageAttestationV1,
  goldenOwnershipV1,
  parsePackerArtifactV1,
  proveExactBuildOwnershipV1,
  runGoldenImageBuildV1,
  sha256V1,
  validateGoldenImageOutputV1,
  validateGoldenImagePreflightV1,
  validateGoldenImageReservationV1,
  validatePackerSourceV1,
  validateTokenScopeV1,
  validateVolumeMeasurementV1,
} from "../validation/proxmox-desktop/v1/build-golden-image.mjs";

const NOW = Date.parse("2026-08-20T16:00:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;
const BUILD_PRIVILEGES = [
  "Datastore.AllocateSpace", "Datastore.Audit", "Sys.Audit", "VM.Allocate", "VM.Audit", "VM.Clone",
  "VM.Config.CDROM", "VM.Config.Cloudinit", "VM.Config.CPU", "VM.Config.Disk", "VM.Config.HWType",
  "VM.Config.Memory", "VM.Config.Network", "VM.Config.Options", "VM.PowerMgmt", "SDN.Use",
];

function granted(...privileges) { return Object.fromEntries(privileges.map((privilege) => [privilege, 1])); }

function sourceConfig() {
  return {
    name: "nelos-ubuntu-24-04-source", template: 1,
    scsi0: "local-lvm:base-9024-disk-0,size=64G",
    efidisk0: "local-lvm:base-9024-disk-1,efitype=4m,size=4M",
  };
}

const VOLUME_HELPER_DIGEST = `sha256:${"e".repeat(64)}`;
const VOLUME_IDENTITY = `SHA256:${"A".repeat(43)}`;

function measurementContent(value, role, config) {
  const vmId = role === "source" ? value.sourceTemplate.vmId : value.outputTemplate.vmId;
  const name = role === "source" ? value.sourceTemplate.name : value.outputTemplate.name;
  const volumes = Object.entries(config).filter(([key]) => /^(?:efidisk|ide|sata|scsi|virtio)[0-9]+$/u.test(key))
    .map(([diskKey, encoded]) => ({ diskKey, volumeId: encoded.split(",", 1)[0] }))
    .filter(({ volumeId }) => !volumeId.endsWith(":cloudinit"))
    .sort((left, right) => left.diskKey.localeCompare(right.diskKey))
    .map((item, index) => ({ ...item, byteLength: index === 0 ? 4_194_304 : 68_719_476_736, digest: `sha256:${(role === "source" ? "1" : "2").repeat(64)}` }));
  return {
    schemaVersion: 1, providerId: value.providerId, node: value.node, storage: value.storage, vmId, name, role, status: "stopped",
    configDigest: sha256V1(config), helperDigest: VOLUME_HELPER_DIGEST, attestorFingerprint: VOLUME_IDENTITY, volumes,
  };
}

function volumeMeasurement(value, role, config, measuredAt = "2026-08-20T16:05:00.000Z") {
  const content = measurementContent(value, role, config);
  return { ...content, measuredAt, contentDigest: sha256V1(content) };
}

function reservation(overrides = {}) {
  const source = sourceConfig();
  const value = {
    schemaVersion: 2,
    reservationId: "golden-20260820-001",
    providerId: "proxmox-lab",
    apiUrl: "https://192.168.1.110:8006/api2/json",
    tlsCaDigest: "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d",
    node: "prox2",
    storage: "local-lvm",
    networkAclPath: "/sdn/zones/nelosbld/nelosbld",
    sourceCommit: "b".repeat(40),
    buildNonce: "c".repeat(32),
    buildTokenId: "nelos-build@pve!golden-001",
    attestorTokenId: "nelos-attest@pve!golden-001",
    expiresAt: "2026-08-20T17:00:00.000Z",
    cleanupExpiresAt: "2026-08-20T18:00:00.000Z",
    maxBuildMs: 1_800_000,
    sourceArtifact: {
      name: "ubuntu-24.04-server-cloudimg-amd64.img", digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe",
      signatureScheme: "openpgp-detached-sha256sums", signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
    },
    volumeAttestor: {
      sshHost: "192.168.1.110", sshPort: 22, sshUser: "nelosmeasure", hostKeyFingerprint: "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg",
      identityFingerprint: VOLUME_IDENTITY, helperDigest: VOLUME_HELPER_DIGEST,
    },
    sourceTemplate: { vmId: 9024, name: source.name, configDigest: sha256V1(source), volumeMeasurementDigest: "pending" },
    outputTemplate: { vmId: 9027, name: "nelos-desktop-ubuntu-24-04-v1", macAddress: "02:4E:45:4C:90:27" },
    ...overrides,
  };
  if (value.sourceTemplate.volumeMeasurementDigest === "pending") value.sourceTemplate.volumeMeasurementDigest = sha256V1(measurementContent(value, "source", source));
  return value;
}

function buildPermissions(value = reservation()) {
  return {
    [`/nodes/${value.node}`]: granted("Sys.Audit"),
    [`/storage/${value.storage}`]: granted("Datastore.AllocateSpace", "Datastore.Audit"),
    [`/vms/${value.sourceTemplate.vmId}`]: granted("VM.Audit", "VM.Clone"),
    [`/vms/${value.outputTemplate.vmId}`]: granted(...BUILD_PRIVILEGES.filter((item) => !["Datastore.AllocateSpace", "Datastore.Audit", "Sys.Audit", "VM.Clone", "SDN.Use"].includes(item))),
    [value.networkAclPath]: granted("SDN.Use"),
  };
}

function attestPermissions(value = reservation()) {
  return {
    [`/nodes/${value.node}`]: granted("Sys.Audit"),
    [`/storage/${value.storage}`]: granted("Datastore.Audit"),
    [`/vms/${value.sourceTemplate.vmId}`]: granted("VM.Audit"),
    [`/vms/${value.outputTemplate.vmId}`]: granted("VM.Audit"),
  };
}

function sourceInventory(value = reservation()) {
  return [{ vmid: value.sourceTemplate.vmId, name: value.sourceTemplate.name, node: value.node, template: 1, type: "qemu" }];
}

function preflight(value = reservation(), { permissions = buildPermissions(value), inventory = sourceInventory(value), storageContent = [] } = {}) {
  return {
    proxmoxVersion: "8.4.2",
    inventory,
    sourceConfig: sourceConfig(),
    sourceStatus: { status: "stopped" },
    sourcePending: [],
    storageConfig: { type: "lvmthin", shared: 0, content: "images,rootdir", nodes: value.node },
    storageStatus: { active: 1, enabled: 1 },
    storageContent,
    buildPermissions: permissions,
  };
}

function outputConfig(value = reservation(), overrides = {}) {
  return {
    name: value.outputTemplate.name,
    template: 1,
    digest: "d".repeat(40),
    cores: 4,
    sockets: 1,
    memory: 8192,
    cpu: "x86-64-v2-AES",
    machine: "q35",
    bios: "ovmf",
    scsihw: "virtio-scsi-single",
    vga: "virtio",
    onboot: 0,
    protection: 0,
    agent: "enabled=1,fstrim_cloned_disks=1",
    ciuser: "ubuntu",
    ipconfig0: "ip=dhcp",
    description: goldenOwnershipV1(value),
    tags: `nelos-golden;nelos-build-${value.buildNonce}`,
    net0: `virtio=${value.outputTemplate.macAddress},bridge=nelosbld,firewall=1`,
    ide2: `${value.storage}:vm-${value.outputTemplate.vmId}-cloudinit,media=cdrom,size=4M`,
    scsi0: `${value.storage}:vm-${value.outputTemplate.vmId}-disk-0,size=64G`,
    efidisk0: `${value.storage}:vm-${value.outputTemplate.vmId}-disk-1,efitype=4m,size=4M`,
    ...overrides,
  };
}

function outputSnapshot(value = reservation(), overrides = {}) {
  return {
    inventory: [...sourceInventory(value), { vmid: value.outputTemplate.vmId, name: value.outputTemplate.name, node: value.node, template: 1, type: "qemu" }],
    config: outputConfig(value),
    status: { status: "stopped" },
    pending: [],
    ...overrides,
  };
}

function machineOutput(value = reservation(), overrides = {}) {
  const target = overrides.target ?? "desktop.proxmox-clone.desktop";
  const vmid = overrides.vmid ?? value.outputTemplate.vmId;
  const builder = overrides.builder ?? "proxmox.clone";
  const count = overrides.count ?? 1;
  return [
    `1787241600,${target},artifact-count,${count}`,
    `1787241601,${target},artifact,0,builder-id,${builder}`,
    `1787241602,${target},artifact,0,id,${vmid}`,
    `1787241603,${target},artifact,0,files-count,0`,
    `1787241604,${target},artifact,0,string,VM%!(PACKER_COMMA) ${vmid}`,
    `1787241605,${target},artifact,0,end`,
    "",
  ].join("\n");
}

function immutableInputs(value = reservation()) {
  return {
    candidateArchiveDigest: DIGEST,
    candidateDigest: DIGEST,
    packageLockDigest: DIGEST,
    packerHclDigest: DIGEST,
    recipeDigest: DIGEST,
    sourceCommit: value.sourceCommit,
    sourceInputsDigest: DIGEST,
    toolchainLockDigest: DIGEST,
    wrapperDigest: DIGEST,
  };
}

function fakeRuntime({ value = reservation(), buildResult = null, builderOutput = null, attestorOutputs = null, cleanup = null } = {}) {
  const state = { outputPresent: false, destroyCalls: 0, packerCalls: 0 };
  const stableOutput = builderOutput ?? outputSnapshot(value);
  const volumeAttestor = { async measure({ role }) {
    return volumeMeasurement(value, role, role === "source" ? sourceConfig() : stableOutput.config);
  } };
  let attestorIndex = 0;
  const makeApi = (kind) => ({
    async version() { return "8.4.2"; },
    async permissions() { return kind === "builder" ? buildPermissions(value) : attestPermissions(value); },
    async inventory() { return state.outputPresent ? stableOutput.inventory : sourceInventory(value); },
    async config(vmid) {
      if (vmid === value.sourceTemplate.vmId) return sourceConfig();
      if (!state.outputPresent) throw new GoldenImageBuildError("NOT_FOUND", "output absent");
      if (kind === "attestor" && attestorOutputs) return (attestorOutputs[Math.min(attestorIndex, attestorOutputs.length - 1)] ?? stableOutput).config;
      return stableOutput.config;
    },
    async status(vmid) {
      if (vmid === value.sourceTemplate.vmId) return { status: "stopped" };
      if (kind === "attestor" && attestorOutputs) return (attestorOutputs[Math.min(attestorIndex, attestorOutputs.length - 1)] ?? stableOutput).status;
      return stableOutput.status;
    },
    async pending(vmid) {
      if (vmid === value.sourceTemplate.vmId) return [];
      const selected = kind === "attestor" && attestorOutputs ? (attestorOutputs[Math.min(attestorIndex, attestorOutputs.length - 1)] ?? stableOutput) : stableOutput;
      if (kind === "attestor" && attestorOutputs) attestorIndex += 1;
      return selected.pending;
    },
    async storageConfig() { return { type: "lvmthin", shared: 0, content: "images,rootdir", nodes: value.node }; },
    async storageStatus() { return { active: 1, enabled: 1 }; },
    async storageContent() {
      return state.outputPresent ? [
        { vmid: value.outputTemplate.vmId, volid: `${value.storage}:vm-${value.outputTemplate.vmId}-disk-0` },
        { vmid: value.outputTemplate.vmId, volid: `${value.storage}:vm-${value.outputTemplate.vmId}-disk-1` },
      ] : [];
    },
    async destroyOwned(vmid) {
      state.destroyCalls += 1;
      if (cleanup) return cleanup;
      assert.equal(vmid, value.outputTemplate.vmId);
      state.outputPresent = false;
      return { destroyed: true, absent: true, providerOperationId: "UPID:prox2:1:2:3:qmdelete:9027:validator@pve:" };
    },
  });
  const journalPhases = [];
  const receipts = [];
  return {
    state,
    builderApi: makeApi("builder"),
    attestorApi: makeApi("attestor"),
    volumeAttestor,
    packer: { async build() {
      state.packerCalls += 1;
      const result = buildResult ?? { exitCode: 0, machineOutput: machineOutput(value), createsOutput: true };
      state.outputPresent = result.createsOutput === true;
      return result;
    } },
    journal: { async record(phase) { journalPhases.push(phase); } },
    journalPhases,
    receiptStore: { async commit(receipt) { receipts.push(receipt); } },
    receipts,
  };
}

test("reservation and token contracts reject ambiguous endpoints and excess privilege", () => {
  const value = reservation();
  assert.deepEqual(validateGoldenImageReservationV1(value, { now: NOW }), value);
  assert.throws(() => validateGoldenImageReservationV1({ ...value, apiUrl: "https://prox2.sayers.io:8006/api2/json" }, { now: NOW }), { code: "INVALID_RESERVATION" });
  assert.throws(() => validateGoldenImageReservationV1({ ...value, tlsCaDigest: `sha256:${"0".repeat(64)}` }, { now: NOW }), { code: "INVALID_RESERVATION" });
  assert.throws(() => validateGoldenImageReservationV1({ ...value, providerId: "homelab-prox2" }, { now: NOW }), { code: "INVALID_RESERVATION" });
  assert.throws(() => validateGoldenImageReservationV1({ ...value, outputTemplate: { ...value.outputTemplate, macAddress: "02:4E:45:4C:90:28" } }, { now: NOW }), { code: "INVALID_RESERVATION" });
  assert.throws(() => validateGoldenImageReservationV1({ ...value, outputTemplate: { ...value.outputTemplate, vmId: 9028 } }, { now: NOW }), { code: "INVALID_RESERVATION" });
  assert.throws(() => validateGoldenImageReservationV1({ ...value, cleanupExpiresAt: "2026-08-20T18:00:00.001Z" }, { now: NOW }), { code: "EXPIRED_RESERVATION" });
  assert.throws(() => validateGoldenImageReservationV1({ ...value, buildNonce: "short" }, { now: NOW }), { code: "INVALID_CONTRACT" });
  assert.throws(() => validateGoldenImageReservationV1({ ...value, attestorTokenId: value.buildTokenId }, { now: NOW }), { code: "INDEPENDENT_ATTESTOR_REQUIRED" });
  assert.throws(() => validateGoldenImageReservationV1({ ...value, attestorTokenId: "nelos-build@pve!other" }, { now: NOW }), { code: "INDEPENDENT_ATTESTOR_REQUIRED" });
  assert.throws(() => validateGoldenImageReservationV1({ ...value, expiresAt: "2026-08-20T16:20:00.000Z" }, { now: NOW }), { code: "EXPIRED_RESERVATION" });
  assert.equal(validateTokenScopeV1(buildPermissions(value), { kind: "build", reservation: value }), true);
  assert.equal(validateTokenScopeV1(attestPermissions(value), { kind: "attest", reservation: value }), true);
  const broad = structuredClone(attestPermissions(value));
  broad["/"] = granted("VM.Audit");
  assert.throws(() => validateTokenScopeV1(broad, { kind: "attest", reservation: value }), { code: "TOKEN_SCOPE_INVALID" });
  const mutating = structuredClone(attestPermissions(value));
  mutating[`/vms/${value.outputTemplate.vmId}`]["VM.PowerMgmt"] = 1;
  assert.throws(() => validateTokenScopeV1(mutating, { kind: "attest", reservation: value }), { code: "TOKEN_SCOPE_INVALID" });
});

test("preflight binds source identity, stopped state, storage, and cluster-wide VM and volume absence", () => {
  const value = reservation();
  assert.equal(validateGoldenImagePreflightV1(preflight(value), value), true);
  assert.equal(validateGoldenImagePreflightV1(preflight(value, { permissions: attestPermissions(value) }), value, { permissionKind: "attest" }), true);
  assert.throws(() => validateGoldenImagePreflightV1(preflight(value, {
    inventory: [...sourceInventory(value), { vmid: 9999, name: value.outputTemplate.name, node: "prox1", template: 0, type: "qemu" }],
  }), value), { code: "OUTPUT_COLLISION" });
  assert.throws(() => validateGoldenImagePreflightV1(preflight(value, {
    storageContent: [{ volid: `${value.storage}:vm-${value.outputTemplate.vmId}-disk-0`, vmid: value.outputTemplate.vmId }],
  }), value), { code: "OUTPUT_COLLISION" });
});

test("output contract requires exact marker, recipe geometry, and reserved storage", () => {
  const value = reservation();
  const output = outputSnapshot(value);
  assert.equal(validateGoldenImageOutputV1(output, value), true);
  assert.equal(proveExactBuildOwnershipV1({ artifact: parsePackerArtifactV1(machineOutput(value), value), snapshot: output, reservation: value }), true);
  assert.throws(() => validateGoldenImageOutputV1(outputSnapshot(value, { config: outputConfig(value, { description: "unowned" }) }), value), { code: "OUTPUT_ATTESTATION_FAILED" });
  assert.throws(() => validateGoldenImageOutputV1(outputSnapshot(value, { config: outputConfig(value, { net0: "virtio=02:4E:45:4C:90:28,bridge=nelosbld,firewall=1" }) }), value), { code: "OUTPUT_ATTESTATION_FAILED" });
  assert.throws(() => validateGoldenImageOutputV1(outputSnapshot(value, { config: outputConfig(value, { scsi0: "other:vm-9027-disk-0,size=64G" }) }), value), { code: "OUTPUT_ATTESTATION_FAILED" });
});

test("Packer parser accepts one exact VMID-only artifact and rejects ambiguity", () => {
  const value = reservation();
  assert.deepEqual(parsePackerArtifactV1(machineOutput(value), value), {
    target: "desktop.proxmox-clone.desktop", builderId: "proxmox.clone", artifactId: "9027", machineOutputDigest: sha256V1(machineOutput(value)),
  });
  for (const hostile of [
    machineOutput(value, { vmid: 9031 }), machineOutput(value, { builder: "proxmox.iso" }), machineOutput(value, { count: 2 }),
    `${machineOutput(value)}1787241606,other.proxmox-clone.desktop,artifact,0,id,9027\n`,
    machineOutput(value).replace(",files-count,0", ",files-count,1"),
    machineOutput(value).replace(",artifact,0,end", ",artifact,0,end\n1787241606,desktop.proxmox-clone.desktop,artifact,0,end"),
  ]) assert.throws(() => parsePackerArtifactV1(hostile, value), { code: "PACKER_RECEIPT_INVALID" });
});

test("goldenImage digest is deterministic over stable config and immutable inputs while receipt binds observation", () => {
  const value = reservation();
  const artifact = parsePackerArtifactV1(machineOutput(value), value);
  const output = outputSnapshot(value);
  const sourceMeasurement = volumeMeasurement(value, "source", sourceConfig());
  const outputMeasurement = volumeMeasurement(value, "output", output.config);
  const first = createGoldenImageAttestationV1({ reservation: value, immutableInputs: immutableInputs(value), builderOutput: output, attestorOutput: output, sourceConfig: sourceConfig(), sourceVolumeMeasurement: sourceMeasurement, outputVolumeMeasurement: outputMeasurement, artifact, observedAt: "2026-08-20T16:10:00.000Z" });
  const reordered = structuredClone(output);
  reordered.config = Object.fromEntries(Object.entries(reordered.config).reverse());
  const second = createGoldenImageAttestationV1({ reservation: value, immutableInputs: immutableInputs(value), builderOutput: reordered, attestorOutput: reordered, sourceConfig: sourceConfig(), sourceVolumeMeasurement: sourceMeasurement, outputVolumeMeasurement: volumeMeasurement(value, "output", reordered.config), artifact, observedAt: "2026-08-20T16:11:00.000Z" });
  assert.equal(first.goldenImage.algorithm, "nelos-proxmox-desktop-volume-recipe-config-v2");
  assert.equal(first.goldenImage.digest, second.goldenImage.digest);
  assert.notEqual(first.attestationDigest, second.attestationDigest);
  const changed = createGoldenImageAttestationV1({
    reservation: value, immutableInputs: { ...immutableInputs(value), packageLockDigest: `sha256:${"e".repeat(64)}` },
    builderOutput: output, attestorOutput: output, sourceConfig: sourceConfig(), sourceVolumeMeasurement: sourceMeasurement, outputVolumeMeasurement: outputMeasurement,
    artifact, observedAt: "2026-08-20T16:10:00.000Z",
  });
  assert.notEqual(first.goldenImage.digest, changed.goldenImage.digest);
  assert.equal(canonicalJsonV1({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("source and output volume bytes are mandatory golden identity", () => {
  const value = reservation();
  const output = outputSnapshot(value);
  const source = volumeMeasurement(value, "source", sourceConfig());
  const measuredOutput = volumeMeasurement(value, "output", output.config);
  assert.doesNotThrow(() => validateVolumeMeasurementV1(source, value, { role: "source", config: sourceConfig() }));
  assert.throws(() => validateVolumeMeasurementV1({ ...source, volumes: source.volumes.map((entry, index) => index ? entry : { ...entry, digest: `sha256:${"9".repeat(64)}` }) }, value, { role: "source", config: sourceConfig() }), { code: "VOLUME_MEASUREMENT_INVALID" });
  const first = createGoldenImageAttestationV1({
    reservation: value, immutableInputs: immutableInputs(value), builderOutput: output, attestorOutput: output, sourceConfig: sourceConfig(),
    sourceVolumeMeasurement: source, outputVolumeMeasurement: measuredOutput, artifact: parsePackerArtifactV1(machineOutput(value), value), observedAt: "2026-08-20T16:10:00.000Z",
  });
  const changedContent = measurementContent(value, "output", output.config);
  changedContent.volumes[0].digest = `sha256:${"9".repeat(64)}`;
  const changedOutput = { ...changedContent, measuredAt: measuredOutput.measuredAt, contentDigest: sha256V1(changedContent) };
  const second = createGoldenImageAttestationV1({
    reservation: value, immutableInputs: immutableInputs(value), builderOutput: output, attestorOutput: output, sourceConfig: sourceConfig(),
    sourceVolumeMeasurement: source, outputVolumeMeasurement: changedOutput, artifact: parsePackerArtifactV1(machineOutput(value), value), observedAt: "2026-08-20T16:10:00.000Z",
  });
  assert.notEqual(first.goldenImage.digest, second.goldenImage.digest);
});

test("successful lifecycle repeats preflight, independently attests, journals, and commits", async () => {
  const value = reservation();
  const runtime = fakeRuntime({ value });
  const receipt = await runGoldenImageBuildV1({
    reservation: value, immutableInputs: immutableInputs(value), ...runtime, clock: { now: () => NOW },
  });
  assert.equal(receipt.goldenImage.digest, runtime.receipts[0].goldenImage.digest);
  assert.equal(runtime.state.packerCalls, 1);
  assert.equal(runtime.state.destroyCalls, 0);
  assert.deepEqual(runtime.journalPhases, ["preflighted", "mutation-started", "packer-exited", "attested", "committed"]);
});

test("valid but changed provider state between repeated preflights blocks Packer", async () => {
  const value = reservation();
  const runtime = fakeRuntime({ value });
  let reads = 0;
  runtime.builderApi.storageContent = async () => {
    reads += 1;
    return reads === 1 ? [] : [{ vmid: value.sourceTemplate.vmId, volid: `${value.storage}:base-${value.sourceTemplate.vmId}-disk-0` }];
  };
  await assert.rejects(runGoldenImageBuildV1({
    reservation: value, immutableInputs: immutableInputs(value), ...runtime, clock: { now: () => NOW },
  }), { code: "PREFLIGHT_DRIFT" });
  assert.equal(runtime.state.packerCalls, 0);
  assert.deepEqual(runtime.journalPhases, ["preflighted"]);
});

test("failed Packer run remains quarantined even when output is absent at the first observation", async () => {
  const value = reservation();
  const runtime = fakeRuntime({ value, buildResult: { exitCode: 1, machineOutput: "1787241600,,ui,error,failed\n", createsOutput: false } });
  await assert.rejects(runGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...runtime, clock: { now: () => NOW } }), { code: "RECONCILIATION_REQUIRED" });
  assert.equal(runtime.state.destroyCalls, 0);
  assert.equal(runtime.journalPhases.at(-1), "quarantined");
});

test("missing artifact with an output preserves it for reconciliation", async () => {
  const value = reservation();
  const runtime = fakeRuntime({ value, buildResult: { exitCode: 0, machineOutput: "1787241600,,ui,say,done\n", createsOutput: true } });
  await assert.rejects(runGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...runtime, clock: { now: () => NOW } }), { code: "RECONCILIATION_REQUIRED" });
  assert.equal(runtime.state.destroyCalls, 0);
  assert.equal(runtime.state.outputPresent, true);
  assert.equal(runtime.journalPhases.at(-1), "quarantined");
});

test("invalid recipe output is deleted only after an independent exact ownership reread", async () => {
  const value = reservation();
  const invalid = outputSnapshot(value, { config: outputConfig(value, { memory: 4096 }) });
  const runtime = fakeRuntime({ value, builderOutput: invalid });
  await assert.rejects(runGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...runtime, clock: { now: () => NOW } }), { code: "OUTPUT_ATTESTATION_FAILED" });
  assert.equal(runtime.state.destroyCalls, 1);
  assert.equal(runtime.state.outputPresent, false);
  assert.deepEqual(runtime.journalPhases.slice(-2), ["cleanup-admitted", "cleaned"]);
});

test("independent drift or unproven deletion quarantines without a broad cleanup claim", async () => {
  const value = reservation();
  const drift = outputSnapshot(value, { config: outputConfig(value, { memory: 4096 }) });
  const runtime = fakeRuntime({ value, attestorOutputs: [drift, drift] });
  await assert.rejects(runGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...runtime, clock: { now: () => NOW } }), { code: "RECONCILIATION_REQUIRED" });
  assert.equal(runtime.state.destroyCalls, 0);
  assert.equal(runtime.state.outputPresent, true);

  const invalid = outputSnapshot(value, { config: outputConfig(value, { memory: 4096 }) });
  const cleanupFailure = fakeRuntime({ value, builderOutput: invalid, cleanup: { destroyed: false, absent: false } });
  await assert.rejects(runGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...cleanupFailure, clock: { now: () => NOW } }), { code: "RECONCILIATION_REQUIRED" });
  assert.equal(cleanupFailure.state.destroyCalls, 1);
  assert.equal(cleanupFailure.journalPhases.at(-1), "quarantined");
});

test("current formatted HCL satisfies the guarded identity contract and one-field drift fails", async () => {
  const current = await readFile(new URL("../validation/proxmox-desktop/v1/golden-image.pkr.hcl", import.meta.url), "utf8");
  assert.doesNotThrow(() => validatePackerSourceV1(current));
  for (const changed of [
    current.replace(/name\s*=\s*"desktop"/u, 'name = "other"'),
    current.replace(/task_timeout\s*=\s*"30m"/u, 'task_timeout = "1m"'),
    current.replace(/ssh_username\s*=\s*"ubuntu"/u, "ssh_username = var.ssh_username"),
    current.replace(/template_description\s*=\s*"nelos-golden-v1:\$\{var\.build_nonce\}"/u, 'template_description = "unowned"'),
    current.replace(/tags\s*=\s*"nelos-golden;nelos-build-\$\{var\.build_nonce\}"/u, 'tags = "nelos-golden"'),
    current.replace(/mac_address\s*=\s*var\.output_template_mac/u, 'mac_address = "02:4E:45:4C:90:28"'),
    current.replace(/var\.output_template_vmid\s*==\s*9027/u, "var.output_template_vmid == 9028"),
    current.replace(/\^\[0-9a-f\]\{32\}\$/u, "^[0-9a-f]{31}$"),
    current.replace(/insecure_skip_tls_verify\s*=\s*false/u, "insecure_skip_tls_verify = true"),
  ]) {
    assert.notEqual(changed, current);
    assert.throws(() => validatePackerSourceV1(changed), { code: "PACKER_SOURCE_INVALID" });
  }
  assert.match(current, /cloud_init_storage_pool\s*=\s*var\.storage_pool/u);
  assert.doesNotMatch(current, /^\s*disks\s*\{/mu);
});
