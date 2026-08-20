#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256V1 } from "../../validation/proxmox-desktop/v1/build-golden-image.mjs";
import { createGoldenBuilderGatewayPolicyBindingV1 } from "../../validation/proxmox-desktop/v1/golden-builder-gateway-policy.mjs";
import { GoldenBuilderProductionRunnerV1 } from "../../validation/proxmox-desktop/v1/golden-builder-production-runner.mjs";
import { createGoldenBuilderLifecycleBindingV1 } from "../../validation/proxmox-desktop/v1/prepare-golden-builder.mjs";

const HOST_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm";
const HOST_FINGERPRINT = "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg";

async function atomic(path, value) { const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temporary, path); }
async function load(path) { return JSON.parse(await readFile(path, "utf8")); }

function contracts(now) {
  const sourceConfig = { name: "nelos-ubuntu-24-04-source", template: 1, scsi0: "local-lvm:base-9024-disk-0,size=64G" };
  const reservation = {
    schemaVersion: 2, reservationId: "fresh-process-orchestrator", providerId: "proxmox-lab", apiUrl: "https://192.168.1.110:8006/api2/json",
    tlsCaDigest: "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d", node: "prox2", storage: "local-lvm",
    networkAclPath: "/sdn/zones/nelosbld/nelosbld", sourceCommit: "a".repeat(40), buildNonce: "c".repeat(32),
    buildTokenId: "nelosgoldbuild@pve!build-cccccccccccc", attestorTokenId: "nelosgoldattest@pve!attest-cccccccccccc",
    expiresAt: new Date(now + 7_200_000).toISOString(), cleanupExpiresAt: new Date(now + 10_800_000).toISOString(), maxBuildMs: 1_800_000,
    sourceArtifact: { name: "ubuntu-24.04-server-cloudimg-amd64.img", digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe", signatureScheme: "openpgp-detached-sha256sums", signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092" },
    volumeAttestor: { sshHost: "192.168.1.110", sshPort: 22, sshUser: "nelosmeasure", hostKeyFingerprint: HOST_FINGERPRINT, identityFingerprint: `SHA256:${"V".repeat(43)}`, helperDigest: `sha256:${"d".repeat(64)}` },
    sourceTemplate: { vmId: 9024, name: sourceConfig.name, configDigest: sha256V1(sourceConfig), volumeMeasurementDigest: `sha256:${"e".repeat(64)}` },
    outputTemplate: { vmId: 9027, name: "nelos-desktop-ubuntu-24-04-v1", macAddress: "02:4E:45:4C:90:27" },
  };
  const lifecycleBinding = createGoldenBuilderLifecycleBindingV1({ reservation, builder: {
    vmId: 9026, name: "nelos-golden-builder-0123456789ab", mac: "02:4E:45:4C:90:26", sshUser: "codex", ownershipNonce: "0123456789abcdef0123456789abcdef",
    sshPublicKey: HOST_PUBLIC_KEY, sshPublicKeyFingerprint: HOST_FINGERPRINT,
  } }, { now });
  const destinations = [
    { host: "persistent.oaistatic.com", addresses: ["104.18.1.10"], resolvedAt: new Date(now).toISOString(), ttlSeconds: 300, expiresAt: new Date(now + 300_000).toISOString() },
    { host: "snapshot.ubuntu.com", addresses: ["185.125.190.36"], resolvedAt: new Date(now).toISOString(), ttlSeconds: 300, expiresAt: new Date(now + 300_000).toISOString() },
  ];
  const gatewayPolicyBinding = createGoldenBuilderGatewayPolicyBindingV1({ reservation, originalRulesetDigest: `sha256:${"1".repeat(64)}`, helperDigest: `sha256:${"2".repeat(64)}`, gatewayConfigDigest: `sha256:${"3".repeat(64)}`, destinations }, { now });
  return { reservation, lifecycleBinding, gatewayPolicyBinding, toolchainLockDigest: `sha256:${"f".repeat(64)}`, sourceConfig };
}

function preflight(value) {
  const scannedVms = [{ node: "prox2", vmId: 9024, configDigest: sha256V1(value.sourceConfig), macAddresses: [] }];
  return { inventory: [{ vmid: 9024, name: "nelos-ubuntu-24-04-source", node: "prox2", template: 1, type: "qemu" }], networkInventory: { complete: true, scannedVms, digest: sha256V1({ complete: true, scannedVms }) }, sourceConfig: value.sourceConfig, sourceStatus: { status: "stopped" }, storage: { storage: "local-lvm", node: "prox2", type: "lvmthin", shared: false, active: true, enabled: true }, storageContent: [], vnet: { vnet: "nelosbld", zone: "nelosbld", aclPath: "/sdn/zones/nelosbld/nelosbld", active: true } };
}
function observation(value, world) {
  if (!world.builderPresent) return { config: null, guest: null, status: "absent" };
  return { config: { name: value.lifecycleBinding.builderVm.name, description: value.lifecycleBinding.builderVm.ownership, tags: `disposable;nelos-golden-builder;nelos-builder-${value.lifecycleBinding.builderVm.ownership.slice(-32)}`, template: 0, onboot: 0, protection: 0, ciuser: "codex", net0: "virtio=02:4E:45:4C:90:26,bridge=nelosbld,firewall=1" }, guest: { architecture: "x86_64", cloudInitStatus: "done", hostKeyFingerprint: HOST_FINGERPRINT, hostPublicKey: HOST_PUBLIC_KEY, operatingSystem: "linux", qga: true, release: "24.04", sshAddress: "10.77.77.26" }, status: world.builderStatus };
}

async function main() {
  const [command, root, crashEvent = "none"] = process.argv.slice(2);
  const admittedAt = Date.parse("2026-08-20T12:00:00.000Z");
  const now = command === "resume-expired" ? admittedAt + 7_300_000 : command === "resume-cleanup-expired" ? admittedAt + 10_800_000 : admittedAt;
  const value = contracts(admittedAt);
  if (command === "invalid-output-identity") {
    value.reservation.outputTemplate.vmId = 9028;
    const reservationDigest = sha256V1(value.reservation);
    value.lifecycleBinding.outputTemplateVmId = 9028; value.lifecycleBinding.reservationDigest = reservationDigest;
    value.lifecycleBinding.bindingDigest = sha256V1(Object.fromEntries(Object.entries(value.lifecycleBinding).filter(([key]) => key !== "bindingDigest")));
    value.gatewayPolicyBinding.reservationDigest = reservationDigest;
    value.gatewayPolicyBinding.bindingDigest = sha256V1(Object.fromEntries(Object.entries(value.gatewayPolicyBinding).filter(([key]) => key !== "bindingDigest")));
  }
  if (command === "invalid-builder-identity") {
    value.lifecycleBinding.builderVm.vmId = 9025;
    value.lifecycleBinding.bindingDigest = sha256V1(Object.fromEntries(Object.entries(value.lifecycleBinding).filter(([key]) => key !== "bindingDigest")));
  }
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const statePath = join(root, "world.json");
  try { await readFile(statePath); } catch { await atomic(statePath, { gateway: "original", builderPresent: false, builderStatus: "stopped", effects: { apply: 0, controller: 0, destroy: 0, provision: 0, restore: 0, stop: 0 } }); }
  const mutate = async (callback) => { const world = await load(statePath); callback(world); await atomic(statePath, world); return world; };
  const gatewayAdapter = {
    async preflight() { const world = await load(statePath); if (world.gateway !== "original") throw Object.assign(new Error("not baseline"), { code: "GATEWAY_PREFLIGHT_MISMATCH" }); return {}; },
    async apply() { const world = await mutate((state) => { if (state.gateway === "original") { state.gateway = "active"; state.effects.apply += 1; } }); return { providerOperationId: "nft:apply", rulesetDigest: `sha256:${"4".repeat(64)}`, active: true }; },
    async observe() { const world = await load(statePath); if (world.gateway !== "active") throw Object.assign(new Error("not active"), { code: "GATEWAY_POLICY_MISMATCH" }); return { rulesetDigest: `sha256:${"4".repeat(64)}`, active: true }; },
    async restore() { await mutate((state) => { if (state.gateway !== "original") { state.gateway = "original"; state.effects.restore += 1; } }); return { providerOperationId: "nft:restore", restored: true, rulesetDigest: value.gatewayPolicyBinding.originalRulesetDigest }; },
    async confirmRestored() { const world = await load(statePath); if (world.gateway !== "original") throw Object.assign(new Error("not restored"), { code: "GATEWAY_RESTORE_UNPROVEN" }); return { restored: true, rulesetDigest: value.gatewayPolicyBinding.originalRulesetDigest, independentInventoryDigest: `sha256:${"5".repeat(64)}` }; },
  };
  const builderAdapter = {
    async preflight() { return preflight(value); },
    async provision() { await mutate((state) => { if (!state.builderPresent) { state.builderPresent = true; state.builderStatus = "running"; state.effects.provision += 1; } }); return { status: "committed", providerOperationId: "UPID:provision" }; },
    async observe() { return observation(value, await load(statePath)); },
    async stop() { await mutate((state) => { if (state.builderStatus === "running") { state.builderStatus = "stopped"; state.effects.stop += 1; } }); return { status: "committed", providerOperationId: "UPID:stop" }; },
    async destroy() { await mutate((state) => { if (state.builderPresent) { state.builderPresent = false; state.effects.destroy += 1; } }); return { status: "committed", providerOperationId: "UPID:destroy" }; },
    async confirmAbsent() { const world = await load(statePath); return { vmAbsent: !world.builderPresent, nameAbsent: !world.builderPresent, volumesAbsent: !world.builderPresent }; },
    async quarantine() { throw new Error("quarantine not expected"); },
  };
  const store = { async commit() {} };
  const runner = new GoldenBuilderProductionRunnerV1({ ...value, journalDirectory: join(root, "journal"), gatewayAdapter, builderAdapter, bundleStore: store, terminalStore: store, clock: { now: () => now }, allowExpiredForCleanup: command === "resume-expired", checkpoint: new Set(["none", "lost-controller-response", "partial-controller-terminal", "orphan-between-provider-tasks"]).has(crashEvent) ? null : async (event) => { if (event === crashEvent) process.exit(86); }, executeController: async ({ packet, cleanupOnly = false }) => {
    const unsigned = { schemaVersion: 1, kind: "nelos-golden-builder-terminal", result: "committed", packetDigest: packet.packetDigest, reservationDigest: packet.reservationDigest, attestationDigest: `sha256:${"6".repeat(64)}`, goldenImageDigest: `sha256:${"7".repeat(64)}`, completedAt: new Date(now).toISOString() };
    const terminal = { ...unsigned, terminalDigest: sha256V1(unsigned) };
    const current = await load(statePath);
    if (current.controllerPacketDigest && current.controllerPacketDigest !== packet.packetDigest) throw Object.assign(new Error("controller packet identity changed"), { code: "CONTROLLER_STAGING_UNPROVEN" });
    if (current.controllerTerminal) return structuredClone(current.controllerTerminal);
    if (cleanupOnly) {
      const unsignedCleanup = { schemaVersion: 1, kind: "nelos-golden-builder-cleanup-terminal", result: "cleaned", packetDigest: packet.packetDigest, reservationDigest: packet.reservationDigest, completedAt: new Date(now).toISOString() };
      return { ...unsignedCleanup, cleanupDigest: sha256V1(unsignedCleanup) };
    }
    if (current.controllerTerminalState === "partial") {
      await mutate((state) => { state.controllerTerminalState = "committed"; state.controllerTerminal = terminal; state.controllerTerminalDigest = terminal.terminalDigest; });
      return terminal;
    }
    await mutate((state) => {
      state.effects.controller += 1; state.controllerPacketDigest = packet.packetDigest; state.controllerTerminalDigest = terminal.terminalDigest;
      if (crashEvent === "partial-controller-terminal") state.controllerTerminalState = "partial";
      else if (crashEvent === "orphan-between-provider-tasks") state.controllerTerminalState = "orphaned";
      else { state.controllerTerminalState = "committed"; state.controllerTerminal = terminal; }
    });
    if (new Set(["lost-controller-response", "partial-controller-terminal", "orphan-between-provider-tasks"]).has(crashEvent)) {
      throw Object.assign(new Error("controller response was lost after durable guest state"), { code: "CONTROLLER_OUTCOME_AMBIGUOUS" });
    }
    return terminal;
  } });
  const result = command === "start" ? await runner.start({ authorizeRun: runner.identity.runDigest }) : command === "cancel" ? await runner.cancel() : await runner.resume();
  process.stdout.write(`${JSON.stringify({ state: result.state, generation: result.generation })}\n`);
}

if (process.argv.length > 2) {
  main().catch((error) => { process.stderr.write(`${error?.code ?? "ERROR"}: ${error?.message ?? error}${error?.details ? ` ${JSON.stringify(error.details)}` : ""}\n`); process.exitCode = 1; });
}
