import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { canonicalJsonV1, sha256V1 } from "../validation/proxmox-desktop/v1/build-golden-image.mjs";
import {
  createGoldenBuilderPacketV1,
  createGoldenBuilderControllerIdentityV1,
  createGoldenBuilderLifecycleBindingV1,
  createGoldenImageReservationV2,
  createVolumeMeasurementBindingV1,
  createVolumeMeasurementBindingFromRequestV1,
  renderScopedAclCleanupV2,
  renderScopedAclBootstrapV2,
} from "../validation/proxmox-desktop/v1/prepare-golden-builder.mjs";
import {
  runDisposableGoldenBuilderV1,
} from "../validation/proxmox-desktop/v1/golden-builder-lifecycle.mjs";

const NOW = Date.parse("2026-08-20T16:00:00.000Z");
const helperUrl = new URL("../validation/proxmox-desktop/v1/nelos-proxmox-volume-measure.py", import.meta.url);
const lockUrl = new URL("../validation/proxmox-desktop/v1/package-lock.json", import.meta.url);
const requestSchemaUrl = new URL("../validation/proxmox-desktop/v1/golden-builder-request.schema.json", import.meta.url);
const lifecycleSchemaUrl = new URL("../validation/proxmox-desktop/v1/golden-builder-lifecycle-identity.schema.json", import.meta.url);
const generatorUrl = new URL("../validation/proxmox-desktop/v1/prepare-golden-builder.mjs", import.meta.url);
const execFileAsync = promisify(execFile);

function sourceConfig() {
  return {
    name: "nelos-ubuntu-24-04-source", template: 1,
    scsi0: "local-lvm:base-9024-disk-0,size=64G",
    efidisk0: "local-lvm:base-9024-disk-1,efitype=4m,size=4M",
  };
}

function request(helperDigest) {
  return {
    schemaVersion: 1,
    reservationId: "golden-20260820-001",
    providerId: "proxmox-lab",
    apiUrl: "https://192.168.1.110:8006/api2/json",
    apiTlsCaDigest: "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d",
    node: "prox2",
    storage: "local-lvm",
    networkAclPath: "/sdn/zones/nelosbld/nelosbld",
    sourceCommit: "b".repeat(40),
    sourceTemplateName: "nelos-ubuntu-24-04-source",
    outputTemplate: { vmId: 9027, name: "nelos-desktop-ubuntu-24-04-v1", macAddress: "02:4E:45:4C:90:27" },
    buildNonce: "c".repeat(32),
    buildTokenId: "nelos-build@pve!golden-001",
    attestorTokenId: "nelos-attest@pve!golden-001",
    expiresAt: "2026-08-20T17:00:00.000Z",
    cleanupExpiresAt: "2026-08-20T18:00:00.000Z",
    maxBuildMs: 1_800_000,
    volumeAttestor: {
      sshHost: "192.168.1.110", sshPort: 22, sshUser: "nelosmeasure",
      hostKeyFingerprint: "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg", identityFingerprint: `SHA256:${"A".repeat(43)}`, helperDigest,
    },
  };
}

function sourceMeasurement(requestValue, config) {
  const content = {
    schemaVersion: 1,
    providerId: requestValue.providerId,
    node: requestValue.node,
    storage: requestValue.storage,
    vmId: 9024,
    name: requestValue.sourceTemplateName,
    role: "source",
    status: "stopped",
    configDigest: sha256V1(config),
    helperDigest: requestValue.volumeAttestor.helperDigest,
    attestorFingerprint: requestValue.volumeAttestor.identityFingerprint,
    volumes: [
      { diskKey: "efidisk0", volumeId: "local-lvm:base-9024-disk-1", byteLength: 4_194_304, digest: `sha256:${"1".repeat(64)}` },
      { diskKey: "scsi0", volumeId: "local-lvm:base-9024-disk-0", byteLength: 68_719_476_736, digest: `sha256:${"2".repeat(64)}` },
    ],
  };
  return { ...content, measuredAt: "2026-08-20T15:58:00.000Z", contentDigest: sha256V1(content) };
}

async function fixture() {
  const [helper, packageLock] = await Promise.all([readFile(helperUrl), readFile(lockUrl, "utf8").then(JSON.parse)]);
  const helperDigest = sha256V1(helper);
  const requestValue = request(helperDigest);
  const config = sourceConfig();
  const measurement = sourceMeasurement(requestValue, config);
  return { helperDigest, packageLock, requestValue, config, measurement };
}

function builderIdentity() {
  return {
    vmId: 9026,
    name: "nelos-golden-builder-0123456789ab",
    mac: "02:4E:45:4C:90:26",
    sshUser: "codex",
    sshHostFingerprint: `SHA256:${"C".repeat(43)}`,
    ownershipNonce: "0123456789abcdef0123456789abcdef",
  };
}

function builderLifecycleIdentity() {
  const builder = builderIdentity();
  return {
    vmId: builder.vmId,
    name: builder.name,
    mac: builder.mac,
    sshUser: builder.sshUser,
    ownershipNonce: builder.ownershipNonce,
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm",
    sshPublicKeyFingerprint: "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg",
  };
}

function preflightSnapshot(reservation, config) {
  const scannedVms = [{ node: reservation.node, vmId: 9024, configDigest: sha256V1(config), macAddresses: [] }];
  return {
    inventory: [{ vmid: 9024, name: reservation.sourceTemplate.name, node: reservation.node, template: 1, type: "qemu" }],
    networkInventory: { complete: true, scannedVms, digest: sha256V1({ complete: true, scannedVms }) },
    sourceConfig: structuredClone(config),
    sourceStatus: { status: "stopped" },
    storage: { storage: reservation.storage, node: reservation.node, type: "lvmthin", shared: false, active: true, enabled: true },
    storageContent: [],
    vnet: { vnet: "nelosbld", zone: "nelosbld", aclPath: "/sdn/zones/nelosbld/nelosbld", active: true },
  };
}

function builderObservation(binding, status = "running") {
  return {
    config: {
      name: binding.builderVm.name,
      description: binding.builderVm.ownership,
      tags: `disposable;nelos-builder-${binding.builderVm.ownership.slice(-32)};nelos-golden-builder`,
      template: 0,
      onboot: 0,
      protection: 0,
      ciuser: binding.builderVm.sshUser,
      net0: `virtio=${binding.builderVm.mac},bridge=${binding.bridge},firewall=1`,
    },
    guest: {
      architecture: "x86_64",
      cloudInitStatus: "done",
      hostKeyFingerprint: "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg",
      hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm",
      operatingSystem: "linux",
      qga: true,
      release: "24.04",
      sshAddress: "10.77.77.26",
    },
    status,
  };
}

function terminalReceipt(packet) {
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-golden-builder-terminal",
    result: "committed",
    packetDigest: packet.packetDigest,
    reservationDigest: packet.reservationDigest,
    attestationDigest: `sha256:${"3".repeat(64)}`,
    goldenImageDigest: `sha256:${"4".repeat(64)}`,
    completedAt: "2026-08-20T16:05:00.000Z",
  };
  return { ...unsigned, terminalDigest: sha256V1(unsigned) };
}

async function lifecycleFixture() {
  const value = await fixture();
  const reservation = createGoldenImageReservationV2({
    request: value.requestValue,
    sourceConfig: value.config,
    sourceMeasurement: value.measurement,
    packageLock: value.packageLock,
  }, { now: NOW });
  const lifecycleBinding = createGoldenBuilderLifecycleBindingV1({ reservation, builder: builderLifecycleIdentity() }, { now: NOW });
  const packet = createGoldenBuilderPacketV1({ reservation, builder: builderIdentity(), toolchainLockDigest: `sha256:${"d".repeat(64)}` }, { now: NOW });
  const bundle = { schemaVersion: 1, reservation, builderPacket: packet, volumeMeasurementBinding: createVolumeMeasurementBindingV1(reservation, { now: NOW }) };
  return { ...value, reservation, lifecycleBinding, packet, bundle };
}

function fakeLifecycleAdapter(value, { provisionFailure = null, ownershipDrift = false } = {}) {
  let present = false;
  let status = "stopped";
  const calls = [];
  const adapter = {
    async preflight() { calls.push("preflight"); return preflightSnapshot(value.reservation, value.config); },
    async provision() {
      calls.push("provision"); present = true; status = "running";
      if (provisionFailure) throw Object.assign(new Error("simulated ambiguous provision"), { code: provisionFailure });
      return { status: "committed", providerOperationId: "UPID:create" };
    },
    async observe() {
      calls.push("observe");
      if (!present) return { config: null, guest: null, status: "absent" };
      const observed = builderObservation(value.lifecycleBinding, status);
      if (ownershipDrift) observed.config.description = "foreign-owner";
      return observed;
    },
    async stop() { calls.push("stop"); status = "stopped"; return { status: "committed", providerOperationId: "UPID:stop" }; },
    async destroy() { calls.push("destroy"); present = false; return { status: "committed", providerOperationId: "UPID:destroy" }; },
    async confirmAbsent() { calls.push("confirmAbsent"); return { vmAbsent: !present, nameAbsent: !present, volumesAbsent: !present }; },
  };
  return { adapter, calls };
}

test("deterministic generator derives the closed 9024 reservation and volume binding", async () => {
  const value = await fixture();
  const reservation = createGoldenImageReservationV2({
    request: value.requestValue, sourceConfig: value.config, sourceMeasurement: value.measurement, packageLock: value.packageLock,
  }, { now: NOW });
  assert.equal(reservation.schemaVersion, 2);
  assert.equal(reservation.sourceTemplate.vmId, 9024);
  assert.equal(reservation.sourceTemplate.volumeMeasurementDigest, value.measurement.contentDigest);
  assert.equal(reservation.sourceArtifact.digest, value.packageLock.artifacts.ubuntuBase.digest);
  const binding = createVolumeMeasurementBindingV1(reservation, { now: NOW });
  assert.deepEqual(createVolumeMeasurementBindingFromRequestV1(value.requestValue, { now: NOW }), binding);
  assert.deepEqual(binding.sourceTemplate, { vmId: 9024, name: "nelos-ubuntu-24-04-source" });
  assert.equal(binding.helperDigest, value.helperDigest);
  assert.equal(binding.volumeAttestorFingerprint, value.requestValue.volumeAttestor.identityFingerprint);
  assert.equal(canonicalJsonV1(binding), canonicalJsonV1(structuredClone(binding)));
});

test("checked operator schemas enumerate every closed request and builder identity field", async () => {
  const [requestSchema, lifecycleSchema] = await Promise.all([
    readFile(requestSchemaUrl, "utf8").then(JSON.parse),
    readFile(lifecycleSchemaUrl, "utf8").then(JSON.parse),
  ]);
  assert.equal(requestSchema.additionalProperties, false);
  assert.deepEqual([...requestSchema.required].sort(), Object.keys(requestSchema.properties).sort());
  assert.equal(requestSchema.properties.node.const, "prox2");
  assert.equal(requestSchema.properties.apiUrl.const, "https://192.168.1.110:8006/api2/json");
  assert.equal(requestSchema.properties.apiTlsCaDigest.const, "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d");
  assert.equal(requestSchema.properties.volumeAttestor.properties.sshHost.const, "192.168.1.110");
  assert.equal(requestSchema.properties.volumeAttestor.properties.hostKeyFingerprint.const, "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg");
  assert.equal(requestSchema.properties.storage.const, "local-lvm");
  assert.equal(requestSchema.properties.sourceTemplateName.const, "nelos-ubuntu-24-04-source");
  assert.equal(requestSchema.properties.providerId.const, "proxmox-lab");
  assert.equal(requestSchema.properties.outputTemplate.properties.name.const, "nelos-desktop-ubuntu-24-04-v1");
  assert.equal(requestSchema.properties.outputTemplate.properties.macAddress.const, "02:4E:45:4C:90:27");
  assert.equal(requestSchema.properties.outputTemplate.properties.vmId.const, 9027);
  assert.equal(lifecycleSchema.properties.vmId.const, 9026);
  assert.equal(lifecycleSchema.additionalProperties, false);
  assert.deepEqual([...lifecycleSchema.required].sort(), Object.keys(lifecycleSchema.properties).sort());
  assert.equal(lifecycleSchema.properties.sshUser.const, "codex");
  assert.equal(lifecycleSchema.properties.mac.const, "02:4E:45:4C:90:26");
});

test("packaged lifecycle generator atomically writes both binding and exact ACL bootstrap", async (t) => {
  const value = await fixture();
  const root = await realpath(await mkdtemp(join(tmpdir(), "nelos-golden-generator-")));
  await chmod(root, 0o700);
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const paths = Object.fromEntries(["request", "source-config", "source-measurement", "package-lock", "builder", "output", "acl-output", "acl-cleanup-output"].map((name) => [name, join(root, `${name}.json`)]));
  const liveNow = Date.now();
  const liveRequest = {
    ...value.requestValue,
    expiresAt: new Date(liveNow + 3_600_000).toISOString(),
    cleanupExpiresAt: new Date(liveNow + 7_200_000).toISOString(),
  };
  const inputs = {
    request: liveRequest,
    "source-config": value.config,
    "source-measurement": value.measurement,
    "package-lock": value.packageLock,
    builder: builderLifecycleIdentity(),
  };
  for (const [name, contents] of Object.entries(inputs)) {
    await writeFile(paths[name], `${JSON.stringify(contents)}\n`, { mode: 0o400 });
    await chmod(paths[name], 0o400);
  }
  await execFileAsync(process.execPath, [
    generatorUrl.pathname,
    "--prepare-builder-lifecycle",
    "--request", paths.request,
    "--source-config", paths["source-config"],
    "--source-measurement", paths["source-measurement"],
    "--package-lock", paths["package-lock"],
    "--builder", paths.builder,
    "--output", paths.output,
    "--acl-output", paths["acl-output"],
    "--acl-cleanup-output", paths["acl-cleanup-output"],
  ], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  const [generated, acl, cleanup] = await Promise.all([
    readFile(paths.output, "utf8").then(JSON.parse), readFile(paths["acl-output"], "utf8").then(JSON.parse), readFile(paths["acl-cleanup-output"], "utf8"),
  ]);
  assert.equal(generated.builderLifecycleBinding.builderVm.vmId, 9026);
  assert.equal(acl.network.aclPath, "/sdn/zones/nelosbld/nelosbld");
  assert.ok(acl.setupCommands.some((command) => command.includes("NelosGoldenVnetUse-cccccccccccc")));
  assert.ok(acl.setupCommands.every((command) => !command.includes("token")));
  assert.match(cleanup, /'\/usr\/sbin\/pveum' 'user' 'token' 'remove'/u);
});

test("builder packet fixes Linux controller, source, storage, VNet, ownership, and SSH trust", async () => {
  const value = await fixture();
  const reservation = createGoldenImageReservationV2({
    request: value.requestValue, sourceConfig: value.config, sourceMeasurement: value.measurement, packageLock: value.packageLock,
  }, { now: NOW });
  const builder = {
    vmId: 9026,
    name: "nelos-golden-builder-0123456789ab",
    mac: "02:4E:45:4C:90:26",
    sshUser: "codex",
    sshHostFingerprint: `SHA256:${"C".repeat(43)}`,
    ownershipNonce: "0123456789abcdef0123456789abcdef",
  };
  const packet = createGoldenBuilderPacketV1({ reservation, builder, toolchainLockDigest: `sha256:${"d".repeat(64)}` }, { now: NOW });
  assert.equal(packet.sourceTemplateVmId, 9024);
  assert.equal(packet.storage, "local-lvm");
  assert.equal(packet.bridge, "nelosbld");
  assert.deepEqual(packet.controller, { operatingSystem: "linux", distribution: "ubuntu", release: "24.04", architecture: "x86_64", nodeVersion: "24.18.0" });
  assert.equal(packet.builderVm.ownership, "nelos-golden-builder-v1:0123456789abcdef0123456789abcdef");
  assert.match(packet.packetDigest, /^sha256:[0-9a-f]{64}$/u);
  const identity = createGoldenBuilderControllerIdentityV1(packet, reservation, { now: NOW });
  assert.equal(identity.packetDigest, packet.packetDigest);
  assert.equal(identity.vmId, builder.vmId);
  assert.equal(identity.sshHostFingerprint, builder.sshHostFingerprint);
  assert.match(identity.identityDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.throws(() => createGoldenBuilderPacketV1({ reservation, builder: { ...builder, vmId: 9024 }, toolchainLockDigest: `sha256:${"d".repeat(64)}` }, { now: NOW }), { code: "INVALID_CONTRACT" });
  assert.throws(() => createGoldenBuilderPacketV1({ reservation, builder: { ...builder, vmId: 9025 }, toolchainLockDigest: `sha256:${"d".repeat(64)}` }, { now: NOW }), { code: "INVALID_CONTRACT" });
  const lifecycle = createGoldenBuilderLifecycleBindingV1({
    reservation,
    builder: {
      vmId: builder.vmId, name: builder.name, mac: builder.mac, sshUser: builder.sshUser, ownershipNonce: builder.ownershipNonce,
      sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm",
      sshPublicKeyFingerprint: "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg",
    },
  }, { now: NOW });
  assert.equal(lifecycle.builderVm.ownership, "nelos-golden-builder-v1:0123456789abcdef0123456789abcdef");
  assert.equal(lifecycle.sourceTemplate.vmId, 9024);
  assert.equal(lifecycle.networkAclPath, "/sdn/zones/nelosbld/nelosbld");
  assert.equal(lifecycle.outputTemplateMacAddress, "02:4E:45:4C:90:27");
  assert.match(lifecycle.bindingDigest, /^sha256:[0-9a-f]{64}$/u);
});

test("ACL bootstrap is exact, path-scoped, split-principal, and includes SDN.Use", async () => {
  const value = await fixture();
  const reservation = createGoldenImageReservationV2({
    request: value.requestValue, sourceConfig: value.config, sourceMeasurement: value.measurement, packageLock: value.packageLock,
  }, { now: NOW });
  const plan = JSON.parse(renderScopedAclBootstrapV2(reservation, { now: NOW }));
  assert.ok(plan.setupCommands.some((command) => command.includes("/vms/9024") && command.includes("NelosGoldenSourceClone-cccccccccccc")));
  assert.ok(plan.setupCommands.some((command) => command.includes("/vms/9027") && command.includes("NelosGoldenOutputBuild-cccccccccccc")));
  assert.ok(plan.setupCommands.some((command) => command.includes("/sdn/zones/nelosbld/nelosbld") && command.includes("NelosGoldenVnetUse-cccccccccccc")));
  assert.ok(plan.setupCommands.some((command) => command.includes("NelosGoldenVnetUse-cccccccccccc") && command.includes("SDN.Use")));
  assert.ok(plan.setupCommands.every((command) => !command.includes("token")));
  assert.deepEqual(plan.tokenRequests.map(({ tokenId, outputName }) => ({ tokenId, outputName })), [
    { tokenId: "nelos-build@pve!golden-001", outputName: "build-token" },
    { tokenId: "nelos-attest@pve!golden-001", outputName: "attestor-token" },
  ]);
  const cleanup = renderScopedAclCleanupV2(reservation, { now: NOW });
  assert.match(cleanup, /'\/usr\/sbin\/pveum' 'user' 'token' 'remove' 'nelos-build@pve' 'golden-001'/u);
  assert.match(cleanup, /'\/usr\/sbin\/pveum' 'acl' 'delete' '\/sdn\/zones\/nelosbld\/nelosbld'.*'NelosGoldenVnetUse-cccccccccccc'/u);
  assert.match(cleanup, /'\/usr\/sbin\/pveum' 'role' 'delete' 'NelosGoldenNodeAudit-cccccccccccc'/u);
  assert.doesNotMatch(cleanup, /'\/'/u);
});

test("generator rejects forged source bytes, wrong template identity, or unknown lock fields", async () => {
  const value = await fixture();
  const hostileMeasurement = structuredClone(value.measurement);
  hostileMeasurement.volumes[0].digest = `sha256:${"9".repeat(64)}`;
  assert.throws(() => createGoldenImageReservationV2({
    request: value.requestValue, sourceConfig: value.config, sourceMeasurement: hostileMeasurement, packageLock: value.packageLock,
  }, { now: NOW }), { code: "VOLUME_MEASUREMENT_INVALID" });
  assert.throws(() => createGoldenImageReservationV2({
    request: value.requestValue, sourceConfig: { ...value.config, name: "other" }, sourceMeasurement: value.measurement, packageLock: value.packageLock,
  }, { now: NOW }), { code: "SOURCE_IDENTITY_MISMATCH" });
  assert.throws(() => createGoldenImageReservationV2({
    request: { ...value.requestValue, extra: true }, sourceConfig: value.config, sourceMeasurement: value.measurement, packageLock: value.packageLock,
  }, { now: NOW }), { code: "INVALID_CONTRACT" });
});

test("PVE volume helper is root-only, fixed-command, bounded, config-reread, and hashes all persistent disks", async () => {
  const source = await readFile(helperUrl, "utf8");
  assert.match(source, /os\.geteuid\(\) != 0/u);
  assert.match(source, /sys\.argv\[1:\] != \["request"\]/u);
  assert.match(source, /\/etc\/nelos-golden\/volume-measurement-binding\.json/u);
  assert.match(source, /\/usr\/bin\/pvesh/u);
  assert.match(source, /\/usr\/sbin\/pvesm/u);
  assert.match(source, /hash_volume\(path, length, deadline\)/u);
  assert.match(source, /pvesh\(config_path\) != config/u);
  assert.doesNotMatch(source, /shell\s*=\s*True/u);
});

test("fake Proxmox lifecycle provisions one identity-bound Ubuntu builder and proves exact destruction", async () => {
  const value = await lifecycleFixture();
  const fake = fakeLifecycleAdapter(value);
  const journalEntries = [];
  const receipts = [];
  const result = await runDisposableGoldenBuilderV1({
    reservation: value.reservation,
    lifecycleBinding: value.lifecycleBinding,
    toolchainLockDigest: value.packet.toolchainLockDigest,
    adapter: fake.adapter,
    executeController: async ({ packet }) => terminalReceipt(packet),
    bundleStore: { async commit(value) { assert.equal(value.bundle.builderPacket.builderVm.sshHostFingerprint, "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg"); } },
    receiptStore: { async commit(receipt) { receipts.push(receipt); } },
    journal: { async record(event, details) { journalEntries.push({ event, details }); } },
    clock: { now: () => NOW },
  });
  assert.equal(result.state, "destroyed");
  assert.equal(result.terminalDigest, receipts[0].terminalDigest);
  assert.deepEqual(fake.calls, ["preflight", "provision", "observe", "observe", "stop", "observe", "destroy", "confirmAbsent"]);
  assert.deepEqual(journalEntries.map(({ event }) => event), [
    "builder-preflighted", "builder-provisioned", "builder-identity-proven", "builder-bundle-committed", "builder-terminal-committed", "builder-stopped", "builder-destroyed",
  ]);
});

test("ambiguous guest-controller outcome preserves the exact running builder and nested recovery journal", async () => {
  const value = await lifecycleFixture();
  const fake = fakeLifecycleAdapter(value); const events = [];
  await assert.rejects(() => runDisposableGoldenBuilderV1({
    reservation: value.reservation,
    lifecycleBinding: value.lifecycleBinding,
    toolchainLockDigest: value.packet.toolchainLockDigest,
    adapter: fake.adapter,
    executeController: async () => { throw Object.assign(new Error("SSH response was lost after durable staging"), { code: "CONTROLLER_OUTCOME_AMBIGUOUS" }); },
    bundleStore: { async commit() {} },
    receiptStore: { async commit() { throw new Error("terminal must not commit"); } },
    journal: { async record(event, details) { events.push({ event, details }); } },
    clock: { now: () => NOW },
  }), (error) => error?.code === "BUILDER_CONTROLLER_RECONCILIATION_REQUIRED" && error.details?.ownershipProven === true);
  assert.deepEqual(fake.calls, ["preflight", "provision", "observe", "observe"]);
  assert.equal(fake.calls.includes("stop"), false); assert.equal(fake.calls.includes("destroy"), false);
  assert.equal(events.at(-1).event, "builder-controller-reconciliation-required");
  assert.match(events.at(-1).details.observationDigest, /^sha256:[0-9a-f]{64}$/u);
});

test("invalid returned controller terminal is preserved for nested-journal reconciliation", async () => {
  const value = await lifecycleFixture();
  const fake = fakeLifecycleAdapter(value); const events = [];
  await assert.rejects(() => runDisposableGoldenBuilderV1({
    reservation: value.reservation, lifecycleBinding: value.lifecycleBinding, toolchainLockDigest: value.packet.toolchainLockDigest,
    adapter: fake.adapter, executeController: async () => ({ partial: true }), bundleStore: { async commit() {} }, receiptStore: { async commit() {} },
    journal: { async record(event) { events.push(event); } }, clock: { now: () => NOW },
  }), { code: "BUILDER_CONTROLLER_RECONCILIATION_REQUIRED" });
  assert.deepEqual(fake.calls, ["preflight", "provision", "observe", "observe"]);
  assert.equal(events.at(-1), "builder-controller-reconciliation-required");
});

test("deterministic controller rejection before an admitted guest effect still cleans the builder", async () => {
  const value = await lifecycleFixture();
  const fake = fakeLifecycleAdapter(value);
  await assert.rejects(() => runDisposableGoldenBuilderV1({
    reservation: value.reservation, lifecycleBinding: value.lifecycleBinding, toolchainLockDigest: value.packet.toolchainLockDigest,
    adapter: fake.adapter, executeController: async () => { throw Object.assign(new Error("sealed input rejected"), { code: "UNSEALED_CONTROLLER_INPUT" }); },
    bundleStore: { async commit() {} }, receiptStore: { async commit() {} }, journal: { async record() {} }, clock: { now: () => NOW },
  }), { code: "UNSEALED_CONTROLLER_INPUT" });
  assert.deepEqual(fake.calls, ["preflight", "provision", "observe", "observe", "stop", "observe", "destroy", "confirmAbsent"]);
});

test("ambiguous provision is cleaned only after fresh exact ownership proof", async () => {
  const value = await lifecycleFixture();
  const fake = fakeLifecycleAdapter(value, { provisionFailure: "PROVIDER_OUTCOME_UNKNOWN" });
  const events = [];
  await assert.rejects(() => runDisposableGoldenBuilderV1({
    reservation: value.reservation,
    lifecycleBinding: value.lifecycleBinding,
    toolchainLockDigest: value.packet.toolchainLockDigest,
    adapter: fake.adapter,
    executeController: async () => { throw new Error("controller must not start"); },
    bundleStore: { async commit() { throw new Error("bundle must not commit"); } },
    receiptStore: { async commit() { throw new Error("receipt must not commit"); } },
    journal: { async record(event) { events.push(event); } },
    clock: { now: () => NOW },
  }), { code: "PROVIDER_OUTCOME_UNKNOWN" });
  assert.deepEqual(fake.calls, ["preflight", "provision", "observe", "stop", "observe", "destroy", "confirmAbsent"]);
  assert.deepEqual(events, ["builder-preflighted", "builder-stopped", "builder-destroyed"]);
});

test("ownership drift quarantines an ambiguous builder and never stops or destroys it", async () => {
  const value = await lifecycleFixture();
  const fake = fakeLifecycleAdapter(value, { provisionFailure: "PROVIDER_OUTCOME_UNKNOWN", ownershipDrift: true });
  const events = [];
  await assert.rejects(() => runDisposableGoldenBuilderV1({
    reservation: value.reservation,
    lifecycleBinding: value.lifecycleBinding,
    toolchainLockDigest: value.packet.toolchainLockDigest,
    adapter: fake.adapter,
    executeController: async () => { throw new Error("controller must not start"); },
    bundleStore: { async commit() {} },
    receiptStore: { async commit() {} },
    journal: { async record(event) { events.push(event); } },
    clock: { now: () => NOW },
  }), { code: "BUILDER_RECONCILIATION_REQUIRED" });
  assert.deepEqual(fake.calls, ["preflight", "provision", "observe"]);
  assert.deepEqual(events, ["builder-preflighted", "builder-quarantined"]);
});

test("builder preflight rejects a source-disk config drift before any mutation", async () => {
  const value = await lifecycleFixture();
  const fake = fakeLifecycleAdapter(value);
  fake.adapter.preflight = async () => {
    fake.calls.push("preflight");
    const snapshot = preflightSnapshot(value.reservation, value.config);
    snapshot.sourceConfig.scsi0 = "local-lvm:base-9024-disk-9,size=64G";
    return snapshot;
  };
  await assert.rejects(() => runDisposableGoldenBuilderV1({
    reservation: value.reservation,
    lifecycleBinding: value.lifecycleBinding,
    toolchainLockDigest: value.packet.toolchainLockDigest,
    adapter: fake.adapter,
    executeController: async () => terminalReceipt(value.packet),
    bundleStore: { async commit() {} },
    receiptStore: { async commit() {} },
    journal: { async record() {} },
    clock: { now: () => NOW },
  }), { code: "SOURCE_IDENTITY_MISMATCH" });
  assert.deepEqual(fake.calls, ["preflight"]);
});

test("builder preflight rejects the stale VNet ACL path or wrong zone before provision", async () => {
  for (const vnet of [
    { vnet: "nelosbld", zone: "nelos", aclPath: "/sdn/zones/nelosbld/nelosbld", active: true },
    { vnet: "nelosbld", zone: "nelosbld", aclPath: "/sdn/zones/nelos/vnets/nelosbld", active: true },
  ]) {
    const value = await lifecycleFixture(); const fake = fakeLifecycleAdapter(value);
    fake.adapter.preflight = async () => ({ ...preflightSnapshot(value.reservation, value.config), vnet });
    await assert.rejects(() => runDisposableGoldenBuilderV1({
      reservation: value.reservation, lifecycleBinding: value.lifecycleBinding, toolchainLockDigest: value.packet.toolchainLockDigest,
      adapter: fake.adapter, executeController: async () => terminalReceipt(value.packet), bundleStore: { async commit() {} },
      receiptStore: { async commit() {} }, journal: { async record() {} }, clock: { now: () => NOW },
    }), { code: "INFRASTRUCTURE_IDENTITY_MISMATCH" });
    assert.equal(fake.calls.includes("provision"), false);
  }
});

test("builder preflight proves both reserved MACs absent from a complete cluster-wide scan", async () => {
  for (const reservedMac of ["02:4E:45:4C:90:26", "02:4E:45:4C:90:27"]) {
    const value = await lifecycleFixture(); const fake = fakeLifecycleAdapter(value);
    fake.adapter.preflight = async () => {
      fake.calls.push("preflight");
      const snapshot = preflightSnapshot(value.reservation, value.config);
      snapshot.networkInventory.scannedVms[0].macAddresses = [reservedMac];
      snapshot.networkInventory.digest = sha256V1({ complete: true, scannedVms: snapshot.networkInventory.scannedVms });
      return snapshot;
    };
    await assert.rejects(() => runDisposableGoldenBuilderV1({
      reservation: value.reservation, lifecycleBinding: value.lifecycleBinding, toolchainLockDigest: value.packet.toolchainLockDigest,
      adapter: fake.adapter, executeController: async () => terminalReceipt(value.packet), bundleStore: { async commit() {} },
      receiptStore: { async commit() {} }, journal: { async record() {} }, clock: { now: () => NOW },
    }), { code: "RESOURCE_COLLISION" });
    assert.deepEqual(fake.calls, ["preflight"]);
  }
});

test("unproven cleanup commits a bounded quarantine only after a fresh ownership reread", async () => {
  const value = await lifecycleFixture();
  const fake = fakeLifecycleAdapter(value);
  let quarantines = 0;
  fake.adapter.stop = async () => {
    fake.calls.push("stop");
    return { status: "ambiguous", providerOperationId: null };
  };
  fake.adapter.quarantine = async () => {
    fake.calls.push("quarantine"); quarantines += 1;
    return { status: "committed", providerOperationId: "UPID:quarantine" };
  };
  const events = [];
  await assert.rejects(() => runDisposableGoldenBuilderV1({
    reservation: value.reservation,
    lifecycleBinding: value.lifecycleBinding,
    toolchainLockDigest: value.packet.toolchainLockDigest,
    adapter: fake.adapter,
    executeController: async ({ packet }) => terminalReceipt(packet),
    bundleStore: { async commit() {} },
    receiptStore: { async commit() {} },
    journal: { async record(event, details) { events.push({ event, details }); } },
    clock: { now: () => NOW },
  }), (error) => error?.code === "BUILDER_RECONCILIATION_REQUIRED" && error.details?.quarantine?.providerOperationId === "UPID:quarantine");
  assert.equal(quarantines, 1);
  assert.ok(fake.calls.lastIndexOf("observe") < fake.calls.indexOf("quarantine"));
  assert.deepEqual(events.slice(-2).map(({ event }) => event), ["builder-quarantine-committed", "builder-quarantined"]);
});
