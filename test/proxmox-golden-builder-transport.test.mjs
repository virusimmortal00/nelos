import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { canonicalJsonV1, sha256V1 } from "../validation/proxmox-desktop/v1/build-golden-image.mjs";
import { createGoldenBuilderLifecycleBindingV1 } from "../validation/proxmox-desktop/v1/prepare-golden-builder.mjs";
import {
  createGoldenBuilderHostBindingV1,
  createGoldenBuilderHostInstallPlanV1,
  createGoldenBuilderSshTransportsV1,
  ProxmoxGoldenBuilderAdapterV1,
  validateGoldenBuilderTransportAccessV1,
} from "../validation/proxmox-desktop/v1/golden-builder-proxmox-transport.mjs";
import { prepareGoldenBuilderTransportV1 } from "../validation/proxmox-desktop/v1/prepare-golden-builder-transport.mjs";
import { runGoldenBuilderControlV1 } from "../validation/proxmox-desktop/v1/golden-builder-control.mjs";
import { runDisposableGoldenBuilderV1 } from "../validation/proxmox-desktop/v1/golden-builder-lifecycle.mjs";

const exec = promisify(execFile);
const HOST_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm";
const HOST_FINGERPRINT = "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg";

async function key(root, name) {
  const path = join(root, name);
  await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path]);
  const publicKey = (await readFile(`${path}.pub`, "utf8")).trim();
  const { stdout } = await exec("/usr/bin/ssh-keygen", ["-lf", path, "-E", "sha256"]);
  return { path, publicKey, fingerprint: stdout.trim().split(/\s+/u)[1] };
}

function reservation(now) {
  const sourceConfig = {
    name: "nelos-ubuntu-24-04-source", template: 1,
    scsi0: "local-lvm:base-9024-disk-0,size=64G", efidisk0: "local-lvm:base-9024-disk-1,efitype=4m,size=4M",
  };
  return {
    schemaVersion: 2,
    reservationId: "golden-transport-test",
    providerId: "proxmox-lab",
    apiUrl: "https://192.168.1.110:8006/api2/json",
    tlsCaDigest: "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d",
    node: "prox2",
    storage: "local-lvm",
    networkAclPath: "/sdn/zones/nelosbld/nelosbld",
    sourceCommit: "b".repeat(40),
    buildNonce: "c".repeat(32),
    buildTokenId: "nelos-build@pve!transport-test",
    attestorTokenId: "nelos-attest@pve!transport-test",
    expiresAt: new Date(now + 3_600_000).toISOString(),
    cleanupExpiresAt: new Date(now + 7_200_000).toISOString(),
    maxBuildMs: 1_800_000,
    sourceArtifact: {
      name: "ubuntu-24.04-server-cloudimg-amd64.img",
      digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe",
      signatureScheme: "openpgp-detached-sha256sums",
      signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
    },
    volumeAttestor: {
      sshHost: "192.168.1.110", sshPort: 22, sshUser: "nelosmeasure", hostKeyFingerprint: HOST_FINGERPRINT,
      identityFingerprint: `SHA256:${"A".repeat(43)}`, helperDigest: `sha256:${"d".repeat(64)}`,
    },
    sourceTemplate: { vmId: 9024, name: sourceConfig.name, configDigest: sha256V1(sourceConfig), volumeMeasurementDigest: `sha256:${"e".repeat(64)}` },
    outputTemplate: { vmId: 9027, name: "nelos-desktop-ubuntu-24-04-v1", macAddress: "02:4E:45:4C:90:27" },
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nelos-golden-transport-")));
  await chmod(root, 0o700);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const [provider, attestor, builder] = await Promise.all([key(root, "provider"), key(root, "attestor"), key(root, "builder")]);
  const helperDigest = sha256V1(await readFile(resolve("validation/proxmox-desktop/v1/nelos-proxmox-golden-builder-helper.py")));
  const now = Date.now();
  const reservationValue = reservation(now);
  const builderPublicKey = builder.publicKey.split(/\s+/u).slice(0, 2).join(" ");
  const lifecycleBinding = createGoldenBuilderLifecycleBindingV1({
    reservation: reservationValue,
    builder: {
      vmId: 9026, name: "nelos-golden-builder-0123456789ab", mac: "02:4E:45:4C:90:26", sshUser: "codex",
      ownershipNonce: "0123456789abcdef0123456789abcdef", sshPublicKey: builderPublicKey, sshPublicKeyFingerprint: builder.fingerprint,
    },
  }, { now });
  const knownHosts = join(root, "known-hosts");
  await writeFile(knownHosts, `192.168.1.110 ${HOST_PUBLIC_KEY}\n`, { mode: 0o600 });
  await chmod(provider.path, 0o600); await chmod(attestor.path, 0o600); await chmod(knownHosts, 0o600);
  const access = {
    schemaVersion: 1, kind: "nelos-golden-builder-transport-access", helperDigest,
    host: { sshHost: "192.168.1.110", sshPort: 22, hostPublicKey: HOST_PUBLIC_KEY, hostFingerprint: HOST_FINGERPRINT, knownHostsFile: knownHosts },
    provider: { sshUser: "nelos-golden-provider", identityFile: provider.path, publicKey: provider.publicKey, publicKeyFingerprint: provider.fingerprint },
    attestor: { sshUser: "nelos-golden-attestor", identityFile: attestor.path, publicKey: attestor.publicKey, publicKeyFingerprint: attestor.fingerprint },
    limits: { operationTimeoutMs: 300_000, maxOutputBytes: 1_048_576, transportAttempts: 2 },
  };
  return { root, now, reservation: reservationValue, lifecycleBinding, access };
}

function observation(binding, status = "running") {
  return {
    config: {
      name: binding.builderVm.name, description: binding.builderVm.ownership,
      tags: `disposable;nelos-builder-${binding.builderVm.ownership.slice(-32)};nelos-golden-builder`, template: 0, onboot: 0, protection: 0,
      ciuser: binding.builderVm.sshUser, net0: `virtio=${binding.builderVm.mac},bridge=${binding.bridge},firewall=1`,
    },
    guest: { architecture: "x86_64", cloudInitStatus: "done", hostKeyFingerprint: HOST_FINGERPRINT, hostPublicKey: HOST_PUBLIC_KEY, operatingSystem: "linux", qga: true, release: "24.04", sshAddress: "10.77.77.26" },
    status,
  };
}

function preflight(value) {
  const config = {
    name: value.reservation.sourceTemplate.name, template: 1,
    scsi0: "local-lvm:base-9024-disk-0,size=64G", efidisk0: "local-lvm:base-9024-disk-1,efitype=4m,size=4M",
  };
  const inventory = [{ vmid: 9024, name: value.reservation.sourceTemplate.name, node: "prox2", template: 1, type: "qemu" }];
  const scannedVms = [{ node: "prox2", vmId: 9024, configDigest: sha256V1(config), macAddresses: [] }];
  return {
    inventory,
    networkInventory: { complete: true, scannedVms, digest: sha256V1({ complete: true, scannedVms }) },
    sourceConfig: config, sourceStatus: { status: "stopped" },
    storage: { storage: "local-lvm", node: "prox2", type: "lvmthin", shared: false, active: true, enabled: true }, storageContent: [],
    vnet: { vnet: "nelosbld", zone: "nelosbld", aclPath: "/sdn/zones/nelosbld/nelosbld", active: true },
  };
}

function receipt(envelope, payload, { status = "observed", providerOperationId = null, observedAt = new Date().toISOString(), extra = null } = {}) {
  const unsigned = {
    schemaVersion: 1, kind: "nelos-golden-builder-provider-receipt", role: envelope.role, operation: envelope.operation,
    operationId: envelope.operationId, bindingDigest: envelope.bindingDigest, status, providerOperationId, observedAt,
    payload, payloadDigest: sha256V1(payload),
  };
  const value = { ...unsigned, receiptDigest: sha256V1(unsigned) };
  return extra ? { ...value, ...extra } : value;
}

function transportsFor(value, behavior = {}) {
  const calls = [];
  const handle = (role) => ({
    identityFingerprint: role === "provider" ? value.access.provider.publicKeyFingerprint : value.access.attestor.publicKeyFingerprint,
    async request(envelope) {
      calls.push({ role, envelope: structuredClone(envelope) });
      if (behavior.request) return behavior.request({ role, envelope, calls });
      if (envelope.operation === "preflight") return receipt(envelope, preflight(value), { observedAt: envelope.requestedAt });
      if (envelope.operation === "observe") return receipt(envelope, observation(value.lifecycleBinding), { observedAt: envelope.requestedAt });
      if (envelope.operation === "confirm-absent") return receipt(envelope, {
        vmAbsent: true, nameAbsent: true, volumesAbsent: true,
        inventoryDigest: `sha256:${"1".repeat(64)}`, storageContentDigest: `sha256:${"2".repeat(64)}`,
      }, { observedAt: envelope.requestedAt });
      return receipt(envelope, {}, { status: envelope.operation === "quarantine" ? "quarantined" : "committed", providerOperationId: `UPID:${envelope.operation}`, observedAt: envelope.requestedAt });
    },
  });
  return { providerTransport: handle("provider"), attestorTransport: handle("attestor"), calls };
}

test("closed host binding and install plan pin literal prox2 trust and two forced one-run principals", async (t) => {
  const value = await fixture(t);
  const binding = createGoldenBuilderHostBindingV1({ lifecycleBinding: value.lifecycleBinding, reservation: value.reservation, access: value.access }, { now: value.now });
  const plan = createGoldenBuilderHostInstallPlanV1({ hostBinding: binding, access: value.access });
  assert.match(binding.hostBindingDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(plan.knownHostsLine, `192.168.1.110 ${HOST_PUBLIC_KEY}\n`);
  assert.match(plan.principals[0].authorizedKey, /^restrict,command="\/usr\/bin\/sudo -n -- \/usr\/libexec\/nelos-proxmox-golden-builder-helper provider request"/u);
  assert.match(plan.principals[1].authorizedKey, /attestor request/u);
  assert.notEqual(binding.providerKeyFingerprint, binding.attestorKeyFingerprint);
  assert.throws(() => validateGoldenBuilderTransportAccessV1({ ...value.access, host: { ...value.access.host, sshHost: "prox2.sayers.io" } }), { code: "INVALID_CONTRACT" });
  assert.throws(() => validateGoldenBuilderTransportAccessV1({ ...value.access, attestor: { ...value.access.provider, sshUser: "nelos-golden-attestor" } }), { code: "INDEPENDENT_ATTESTOR_REQUIRED" });
});

test("adapter independently attests preflight and uses the attestor for exact absence", async (t) => {
  const value = await fixture(t); const transport = transportsFor(value); const committed = [];
  const adapter = new ProxmoxGoldenBuilderAdapterV1({
    lifecycleBinding: value.lifecycleBinding, reservation: value.reservation, ...transport,
    receiptStore: { async commit(item) { committed.push(item); } }, clock: { now: () => value.now }, operationTimeoutMs: 300_000, transportAttempts: 2,
  });
  assert.deepEqual(await adapter.preflight(value.lifecycleBinding), preflight(value));
  assert.deepEqual(await adapter.provision(value.lifecycleBinding), { status: "committed", providerOperationId: "UPID:provision" });
  assert.deepEqual(await adapter.observe(value.lifecycleBinding), observation(value.lifecycleBinding));
  assert.deepEqual(await adapter.stop(value.lifecycleBinding), { status: "committed", providerOperationId: "UPID:stop" });
  assert.deepEqual(await adapter.quarantine(value.lifecycleBinding), { status: "committed", providerOperationId: "UPID:quarantine" });
  assert.deepEqual(await adapter.destroy(value.lifecycleBinding), { status: "committed", providerOperationId: "UPID:destroy" });
  assert.deepEqual(await adapter.confirmAbsent(value.lifecycleBinding), { vmAbsent: true, nameAbsent: true, volumesAbsent: true });
  assert.deepEqual(transport.calls.filter(({ role }) => role === "attestor").map(({ envelope }) => envelope.operation), ["preflight", "confirm-absent"]);
  assert.equal(committed.length, 8);
});

test("concrete adapter injects into the complete lifecycle and ends only after independent absence", async (t) => {
  const value = await fixture(t); let present = false; let vmStatus = "stopped"; const calls = [];
  const providerTransport = {
    identityFingerprint: value.access.provider.publicKeyFingerprint,
    async request(envelope) {
      calls.push(envelope.operation);
      if (envelope.operation === "preflight") return receipt(envelope, preflight(value), { observedAt: new Date(value.now).toISOString() });
      if (envelope.operation === "observe") return receipt(envelope, present ? observation(value.lifecycleBinding, vmStatus) : { config: null, guest: null, status: "absent" }, { observedAt: new Date(value.now).toISOString() });
      if (envelope.operation === "provision") { present = true; vmStatus = "running"; }
      if (envelope.operation === "stop") vmStatus = "stopped";
      if (envelope.operation === "destroy") present = false;
      return receipt(envelope, {}, { status: "committed", providerOperationId: `UPID:${envelope.operation}`, observedAt: new Date(value.now).toISOString() });
    },
  };
  const attestorTransport = {
    identityFingerprint: value.access.attestor.publicKeyFingerprint,
    async request(envelope) {
      calls.push(envelope.operation);
      if (envelope.operation === "preflight") return receipt(envelope, preflight(value), { observedAt: new Date(value.now).toISOString() });
      return receipt(envelope, {
        vmAbsent: !present, nameAbsent: !present, volumesAbsent: !present,
        inventoryDigest: `sha256:${"1".repeat(64)}`, storageContentDigest: `sha256:${"2".repeat(64)}`,
      }, { observedAt: new Date(value.now).toISOString() });
    },
  };
  const adapter = new ProxmoxGoldenBuilderAdapterV1({
    lifecycleBinding: value.lifecycleBinding, reservation: value.reservation, providerTransport, attestorTransport,
    receiptStore: { async commit() {} }, clock: { now: () => value.now },
  });
  const journal = [];
  const result = await runDisposableGoldenBuilderV1({
    reservation: value.reservation, lifecycleBinding: value.lifecycleBinding, toolchainLockDigest: `sha256:${"f".repeat(64)}`, adapter,
    executeController: async ({ packet }) => {
      const unsigned = {
        schemaVersion: 1, kind: "nelos-golden-builder-terminal", result: "committed", packetDigest: packet.packetDigest,
        reservationDigest: packet.reservationDigest, attestationDigest: `sha256:${"3".repeat(64)}`, goldenImageDigest: `sha256:${"4".repeat(64)}`,
        completedAt: new Date(value.now + 1_000).toISOString(),
      };
      return { ...unsigned, terminalDigest: sha256V1(unsigned) };
    },
    bundleStore: { async commit() {} }, receiptStore: { async commit() {} }, journal: { async record(event) { journal.push(event); } },
    clock: { now: () => value.now },
  });
  assert.equal(result.state, "destroyed");
  assert.deepEqual(calls, ["preflight", "preflight", "provision", "observe", "observe", "stop", "observe", "destroy", "confirm-absent"]);
  assert.equal(journal.at(-1), "builder-destroyed");
});

test("ambiguous transport crash reconciles with the same nonce-bound operation identity and never invents a repeat", async (t) => {
  const value = await fixture(t); let attempts = 0; const ids = [];
  const transport = transportsFor(value, {
    request({ envelope }) {
      ids.push(envelope.operationId); attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("connection closed after commit"), { code: "TRANSPORT_OUTCOME_UNKNOWN" });
      return receipt(envelope, { reconciled: true }, { status: "committed", providerOperationId: "UPID:clone:reconciled" });
    },
  });
  const adapter = new ProxmoxGoldenBuilderAdapterV1({
    lifecycleBinding: value.lifecycleBinding, reservation: value.reservation, ...transport, receiptStore: { async commit() {} },
    clock: { now: () => value.now }, operationTimeoutMs: 300_000, transportAttempts: 2,
  });
  assert.deepEqual(await adapter.provision(value.lifecycleBinding), { status: "committed", providerOperationId: "UPID:clone:reconciled" });
  assert.equal(attempts, 2);
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids[0], sha256V1({ schemaVersion: 1, kind: "nelos-golden-builder-operation", bindingDigest: value.lifecycleBinding.bindingDigest, operation: "provision" }));
});

test("forged receipts and false absence fail closed while cleanup remains bounded after active expiry", async (t) => {
  const value = await fixture(t);
  for (const hostile of [
    ({ envelope }) => receipt(envelope, preflight(value), { extra: { unexpected: true } }),
    ({ envelope }) => ({ ...receipt(envelope, preflight(value)), payloadDigest: `sha256:${"0".repeat(64)}` }),
  ]) {
    const transport = transportsFor(value, { request: hostile });
    const adapter = new ProxmoxGoldenBuilderAdapterV1({ lifecycleBinding: value.lifecycleBinding, reservation: value.reservation, ...transport, receiptStore: { async commit() {} }, clock: { now: () => value.now } });
    await assert.rejects(() => adapter.preflight(value.lifecycleBinding), { code: "PROVIDER_RECEIPT_INVALID" });
  }
  const falseTransport = transportsFor(value, { request: ({ envelope }) => receipt(envelope, {
    vmAbsent: true, nameAbsent: true, volumesAbsent: false, inventoryDigest: `sha256:${"1".repeat(64)}`, storageContentDigest: `sha256:${"2".repeat(64)}`,
  }) });
  const falseAdapter = new ProxmoxGoldenBuilderAdapterV1({ lifecycleBinding: value.lifecycleBinding, reservation: value.reservation, ...falseTransport, receiptStore: { async commit() {} }, clock: { now: () => value.now } });
  assert.equal((await falseAdapter.confirmAbsent(value.lifecycleBinding)).volumesAbsent, false);
  let runtimeNow = value.now;
  const expiredAdapter = new ProxmoxGoldenBuilderAdapterV1({ lifecycleBinding: value.lifecycleBinding, reservation: value.reservation, ...transportsFor(value), receiptStore: { async commit() {} }, clock: { now: () => runtimeNow } });
  runtimeNow = Date.parse(value.lifecycleBinding.expiresAt);
  assert.deepEqual(await expiredAdapter.observe(value.lifecycleBinding), observation(value.lifecycleBinding));
  await assert.rejects(() => expiredAdapter.provision(value.lifecycleBinding), { code: "BUILDER_DEADLINE_EXPIRED" });
  runtimeNow = Date.parse(value.lifecycleBinding.cleanupExpiresAt);
  await assert.rejects(() => expiredAdapter.observe(value.lifecycleBinding), { code: "BUILDER_DEADLINE_EXPIRED" });
});

test("SSH transport verifies sealed distinct keys and emits a no-forwarding strict-host command", async (t) => {
  const value = await fixture(t); const captures = [];
  const runCommand = async (input) => {
    captures.push(input);
    const envelope = JSON.parse(input.input);
    const payload = envelope.operation === "confirm-absent" ? {
      vmAbsent: true, nameAbsent: true, volumesAbsent: true, inventoryDigest: `sha256:${"1".repeat(64)}`, storageContentDigest: `sha256:${"2".repeat(64)}`,
    } : preflight(value);
    return Buffer.from(`${canonicalJsonV1(receipt(envelope, payload))}\n`);
  };
  const ssh = await createGoldenBuilderSshTransportsV1({ access: value.access, runCommand, clock: { now: () => value.now } });
  const adapter = new ProxmoxGoldenBuilderAdapterV1({ lifecycleBinding: value.lifecycleBinding, reservation: value.reservation, ...ssh, receiptStore: { async commit() {} }, clock: { now: () => value.now } });
  await adapter.preflight(value.lifecycleBinding); await adapter.confirmAbsent(value.lifecycleBinding);
  assert.equal(captures.length, 3);
  for (const capture of captures) {
    const command = capture.args.join(" ");
    for (const option of ["StrictHostKeyChecking=yes", "ForwardAgent=no", "IdentitiesOnly=yes", "PasswordAuthentication=no", "ProxyCommand=none", "192.168.1.110"]) assert.match(command, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(command, /accept-new|StrictHostKeyChecking=no|ForwardAgent=yes/u);
  }
  assert.ok(captures[0].args.includes(value.access.provider.identityFile));
  assert.ok(captures[1].args.includes(value.access.attestor.identityFile));
  assert.ok(captures[2].args.includes(value.access.attestor.identityFile));
  assert.notEqual(value.access.provider.identityFile, value.access.attestor.identityFile);
});

test("operator preparation writes content-addressed host plan and exactly one literal known-host line", async (t) => {
  const value = await fixture(t);
  const lifecyclePath = join(value.root, "lifecycle.json"); const accessPath = join(value.root, "access.json");
  const hostBindingOutput = join(value.root, "host-binding.json"); const planOutput = join(value.root, "install-plan.json");
  await writeFile(lifecyclePath, `${canonicalJsonV1({ schemaVersion: 1, reservation: value.reservation, builderLifecycleBinding: value.lifecycleBinding })}\n`, { mode: 0o400 });
  await writeFile(accessPath, `${canonicalJsonV1(value.access)}\n`, { mode: 0o400 }); await chmod(lifecyclePath, 0o400); await chmod(accessPath, 0o400);
  await rm(value.access.host.knownHostsFile);
  const result = await prepareGoldenBuilderTransportV1({ lifecyclePath, accessPath, hostBindingOutput, planOutput, knownHostsOutput: value.access.host.knownHostsFile }, { now: value.now });
  assert.match(result.hostBindingDigest, /^sha256:/u);
  assert.equal(await readFile(value.access.host.knownHostsFile, "utf8"), `192.168.1.110 ${HOST_PUBLIC_KEY}\n`);
  assert.equal((await stat(hostBindingOutput)).mode & 0o777, 0o400);
  assert.equal((await stat(planOutput)).mode & 0o777, 0o400);
  assert.equal((await stat(value.access.host.knownHostsFile)).mode & 0o777, 0o600);
  await assert.rejects(() => prepareGoldenBuilderTransportV1({ lifecyclePath, accessPath, hostBindingOutput, planOutput, knownHostsOutput: value.access.host.knownHostsFile }, { now: value.now }), /EEXIST/u);
});

test("operator control entrypoint gates every mutation on the exact binding digest", async (t) => {
  const value = await fixture(t);
  const lifecyclePath = join(value.root, "control-lifecycle.json"); const accessPath = join(value.root, "control-access.json"); const receiptDir = join(value.root, "receipts");
  await writeFile(lifecyclePath, `${canonicalJsonV1({ schemaVersion: 1, reservation: value.reservation, builderLifecycleBinding: value.lifecycleBinding })}\n`, { mode: 0o400 });
  await writeFile(accessPath, `${canonicalJsonV1(value.access)}\n`, { mode: 0o400 });
  await mkdir(receiptDir, { mode: 0o700 }); await chmod(receiptDir, 0o700);
  const transport = transportsFor(value);
  const createTransports = async () => transport;
  const readOnly = await runGoldenBuilderControlV1({ lifecyclePath, accessPath, receiptDir, operation: "preflight" }, { createTransports, clock: { now: () => value.now } });
  assert.equal(readOnly.bindingDigest, value.lifecycleBinding.bindingDigest);
  await assert.rejects(() => runGoldenBuilderControlV1({ lifecyclePath, accessPath, receiptDir, operation: "provision" }, { createTransports, clock: { now: () => value.now } }), { code: "MUTATION_AUTHORIZATION_REQUIRED" });
  const provisioned = await runGoldenBuilderControlV1({ lifecyclePath, accessPath, receiptDir, operation: "provision", authorizeBinding: value.lifecycleBinding.bindingDigest }, { createTransports, clock: { now: () => value.now } });
  assert.deepEqual(provisioned.result, { status: "committed", providerOperationId: "UPID:provision" });
  assert.equal(transport.calls.filter(({ envelope }) => envelope.operation === "provision").length, 1);
  const receiptNames = await readdir(receiptDir);
  assert.equal(receiptNames.length, 3);
  for (const name of receiptNames) {
    assert.match(name, /^[0-9a-f]{64}\.json$/u);
    assert.equal((await stat(join(receiptDir, name))).mode & 0o777, 0o400);
    assert.equal(JSON.parse(await readFile(join(receiptDir, name), "utf8")).receiptDigest, `sha256:${name.slice(0, 64)}`);
  }
});

test("operator control admits only identity-authorized cleanup between active and cleanup expiry", async (t) => {
  const value = await fixture(t);
  const lifecyclePath = join(value.root, "late-lifecycle.json"); const accessPath = join(value.root, "late-access.json"); const receiptDir = join(value.root, "late-receipts");
  await writeFile(lifecyclePath, `${canonicalJsonV1({ schemaVersion: 1, reservation: value.reservation, builderLifecycleBinding: value.lifecycleBinding })}\n`, { mode: 0o400 });
  await writeFile(accessPath, `${canonicalJsonV1(value.access)}\n`, { mode: 0o400 });
  await mkdir(receiptDir, { mode: 0o700 });
  const transport = transportsFor(value); const createTransports = async () => transport;
  let lateNow = Date.parse(value.lifecycleBinding.expiresAt) + 1;
  const clock = { now: () => lateNow };
  await assert.rejects(() => runGoldenBuilderControlV1({ lifecyclePath, accessPath, receiptDir, operation: "destroy" }, { createTransports, clock }), { code: "MUTATION_AUTHORIZATION_REQUIRED" });
  const destroyed = await runGoldenBuilderControlV1({ lifecyclePath, accessPath, receiptDir, operation: "destroy", authorizeBinding: value.lifecycleBinding.bindingDigest }, { createTransports, clock });
  assert.equal(destroyed.result.providerOperationId, "UPID:destroy");
  await assert.rejects(() => runGoldenBuilderControlV1({ lifecyclePath, accessPath, receiptDir, operation: "provision", authorizeBinding: value.lifecycleBinding.bindingDigest }, { createTransports, clock }), { code: "EXPIRED_RESERVATION" });
  await assert.rejects(() => runGoldenBuilderControlV1({ lifecyclePath, accessPath, receiptDir, operation: "preflight" }, { createTransports, clock }), { code: "EXPIRED_RESERVATION" });
  lateNow = Date.parse(value.lifecycleBinding.cleanupExpiresAt);
  await assert.rejects(() => runGoldenBuilderControlV1({ lifecyclePath, accessPath, receiptDir, operation: "destroy", authorizeBinding: value.lifecycleBinding.bindingDigest }, { createTransports, clock }), { code: "EXPIRED_RESERVATION" });
});

test("schemas close every nested object and the forced helper has no shell or broad command surface", async () => {
  const [accessSchema, bindingSchema, helper] = await Promise.all([
    readFile(resolve("validation/proxmox-desktop/v1/golden-builder-transport-access.schema.json"), "utf8").then(JSON.parse),
    readFile(resolve("validation/proxmox-desktop/v1/golden-builder-host-binding.schema.json"), "utf8").then(JSON.parse),
    readFile(resolve("validation/proxmox-desktop/v1/nelos-proxmox-golden-builder-helper.py"), "utf8"),
  ]);
  assert.equal(accessSchema.additionalProperties, false);
  assert.deepEqual([...accessSchema.required].sort(), Object.keys(accessSchema.properties).sort());
  assert.equal(accessSchema.properties.host.additionalProperties, false);
  assert.equal(accessSchema.properties.limits.additionalProperties, false);
  assert.equal(bindingSchema.additionalProperties, false);
  assert.deepEqual([...bindingSchema.required].sort(), Object.keys(bindingSchema.properties).sort());
  assert.equal(bindingSchema.properties.lifecycleBinding.additionalProperties, false);
  for (const token of ["SUDO_USER", "confirm-absent", "/usr/bin/pvesh", "/usr/sbin/qm", "mutation intent", "destroy-unreferenced-disks"]) assert.match(helper, new RegExp(token, "u"));
  for (const identity of ["SOURCE_TEMPLATE_VMID = 9024", "BUILDER_VMID = 9026", "OUTPUT_TEMPLATE_VMID = 9027"]) assert.match(helper, new RegExp(identity, "u"));
  assert.match(helper, /value\["builderVm"\]\["vmId"\] != BUILDER_VMID[\s\S]*value\["outputTemplateVmId"\] != OUTPUT_TEMPLATE_VMID/u);
  assert.doesNotMatch(helper, /shell\s*=\s*True|os\.system|subprocess\.Popen/u);
  assert.ok(helper.indexOf("ensure_intent(intent_path, request)") < helper.indexOf('pvesh("create", f"/nodes/{node}/qemu/{lifecycle[\'sourceTemplate\'][\'vmId\']}/clone"'));
});
