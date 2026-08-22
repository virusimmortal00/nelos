import { createHash } from "node:crypto";

import {
  sha256V1,
  validateGoldenImageReservationV1,
} from "./build-golden-image.mjs";
import {
  createGoldenBuilderControllerIdentityV1,
  createGoldenBuilderPacketV1,
  createVolumeMeasurementBindingV1,
  validateGoldenBuilderLifecycleBindingV1,
  validateGoldenBuilderTerminalReceiptV1,
} from "./prepare-golden-builder.mjs";

export class GoldenBuilderLifecycleError extends Error {
  constructor(code, message, details = null) { super(message); this.name = "GoldenBuilderLifecycleError"; this.code = code; this.details = details; }
}

function fail(code, message, details = null) { throw new GoldenBuilderLifecycleError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${label} fields differ`);
  return value;
}
function networkOptions(value) { return typeof value === "string" ? value.split(",") : []; }
function tags(value) { return typeof value === "string" ? value.split(";").filter(Boolean) : []; }
const MAC_ADDRESS = /^02(?::[0-9A-F]{2}){5}$/u;
function hostKeyFingerprint(value) {
  const fields = typeof value === "string" ? value.split(" ") : [];
  if (fields.length !== 2 || fields[0] !== "ssh-ed25519") return null;
  let bytes;
  try { bytes = Buffer.from(fields[1], "base64"); } catch { return null; }
  if (bytes.length !== 51 || bytes.toString("base64") !== fields[1]) return null;
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/u, "")}`;
}

function validateNetworkInventory(value, inventory, binding) {
  exact(value, ["complete", "digest", "scannedVms"], "builderPreflight.networkInventory");
  if (value.complete !== true || !Array.isArray(value.scannedVms) || value.digest !== sha256V1({ complete: true, scannedVms: value.scannedVms })) {
    fail("PREFLIGHT_INVALID", "builder preflight network inventory is incomplete or has an invalid digest");
  }
  const expected = inventory.filter((item) => item?.type === "qemu").map((item) => `${item.node}\0${Number(item.vmid)}`).sort();
  const observed = []; const macs = [];
  for (const [index, item] of value.scannedVms.entries()) {
    exact(item, ["configDigest", "macAddresses", "node", "vmId"], `builderPreflight.networkInventory.scannedVms[${index}]`);
    if (typeof item.node !== "string" || !Number.isSafeInteger(item.vmId) || !/^sha256:[0-9a-f]{64}$/u.test(item.configDigest ?? "") || !Array.isArray(item.macAddresses) ||
        item.macAddresses.some((mac) => !MAC_ADDRESS.test(mac)) || item.macAddresses.join("\0") !== [...item.macAddresses].sort().join("\0") || new Set(item.macAddresses).size !== item.macAddresses.length) {
      fail("PREFLIGHT_INVALID", "builder preflight network inventory entry is malformed");
    }
    observed.push(`${item.node}\0${item.vmId}`); macs.push(...item.macAddresses);
  }
  if (observed.sort().join("\0") !== expected.join("\0") || new Set(observed).size !== observed.length) {
    fail("PREFLIGHT_INVALID", "builder preflight network inventory does not cover every QEMU VM exactly once");
  }
  if (macs.includes(binding.builderVm.mac) || macs.includes(binding.outputTemplateMacAddress)) {
    fail("RESOURCE_COLLISION", "builder or output MAC is already present cluster-wide");
  }
}

export function validateGoldenBuilderPreflightV1(snapshot, binding) {
  exact(snapshot, ["inventory", "networkInventory", "sourceConfig", "sourceStatus", "storage", "storageContent", "vnet"], "builderPreflight");
  if (!Array.isArray(snapshot.inventory) || !plain(snapshot.networkInventory) || !plain(snapshot.sourceConfig) || !plain(snapshot.sourceStatus) || !plain(snapshot.storage) || !Array.isArray(snapshot.storageContent) || !plain(snapshot.vnet)) {
    fail("PREFLIGHT_INVALID", "builder preflight provider response is malformed");
  }
  validateNetworkInventory(snapshot.networkInventory, snapshot.inventory, binding);
  const sourceMatches = snapshot.inventory.filter((item) => Number(item?.vmid) === binding.sourceTemplate.vmId || item?.name === binding.sourceTemplate.name);
  if (sourceMatches.length !== 1 || Number(sourceMatches[0].vmid) !== binding.sourceTemplate.vmId || sourceMatches[0].name !== binding.sourceTemplate.name ||
      sourceMatches[0].node !== binding.hostId || Number(sourceMatches[0].template) !== 1 || sourceMatches[0].type !== "qemu" ||
      snapshot.sourceConfig.name !== binding.sourceTemplate.name || Number(snapshot.sourceConfig.template) !== 1 ||
      sha256V1(snapshot.sourceConfig) !== binding.sourceTemplate.configDigest || snapshot.sourceStatus.status !== "stopped") {
    fail("SOURCE_IDENTITY_MISMATCH", "builder source template identity, config, or state differs");
  }
  if (snapshot.inventory.some((item) => Number(item?.vmid) === binding.builderVm.vmId || item?.name === binding.builderVm.name ||
      Number(item?.vmid) === binding.outputTemplateVmId || item?.name === binding.outputTemplateName) || snapshot.storageContent.some((item) => Number(item?.vmid) === binding.builderVm.vmId ||
        Number(item?.vmid) === binding.outputTemplateVmId || new RegExp(`(?:base|vm)-(?:${binding.builderVm.vmId}|${binding.outputTemplateVmId})-`, "u").test(item?.volid ?? ""))) {
    fail("RESOURCE_COLLISION", "builder or reserved golden output identity is not cluster-wide free");
  }
  if (snapshot.storage.storage !== binding.storage || snapshot.storage.node !== binding.hostId || snapshot.storage.type !== "lvmthin" ||
      snapshot.storage.shared !== false || snapshot.storage.active !== true || snapshot.storage.enabled !== true ||
      snapshot.vnet.vnet !== binding.bridge || snapshot.vnet.zone !== "nelosbld" ||
      snapshot.vnet.aclPath !== binding.networkAclPath || snapshot.vnet.active !== true) {
    fail("INFRASTRUCTURE_IDENTITY_MISMATCH", "builder storage or VNet identity differs");
  }
  return true;
}

export function proveGoldenBuilderOwnershipV1(snapshot, binding, { requireRunning = false } = {}) {
  try {
    exact(snapshot, ["config", "guest", "status"], "builderObservation");
    exact(snapshot.guest, ["architecture", "cloudInitStatus", "hostKeyFingerprint", "hostPublicKey", "operatingSystem", "qga", "release", "sshAddress"], "builderObservation.guest");
    const config = snapshot.config;
    const network = networkOptions(config?.net0);
    const expectedTag = `nelos-builder-${binding.builderVm.ownership.slice(-32)}`;
    return plain(config) && config.name === binding.builderVm.name && config.description === binding.builderVm.ownership &&
      tags(config.tags).sort().join("\0") === ["disposable", "nelos-golden-builder", expectedTag].sort().join("\0") &&
      Number(config.template ?? 0) === 0 && Number(config.onboot ?? 0) === 0 && Number(config.protection ?? 0) === 0 &&
      config.ciuser === binding.builderVm.sshUser && network.includes(`virtio=${binding.builderVm.mac}`) &&
      network.includes(`bridge=${binding.bridge}`) && network.includes("firewall=1") && snapshot.guest.operatingSystem === "linux" &&
      snapshot.guest.release === "24.04" && snapshot.guest.architecture === "x86_64" && snapshot.guest.cloudInitStatus === "done" &&
      snapshot.guest.qga === true && /^SHA256:[A-Za-z0-9+/]{43}$/u.test(snapshot.guest.hostKeyFingerprint ?? "") &&
      /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/u.test(snapshot.guest.hostPublicKey ?? "") &&
      hostKeyFingerprint(snapshot.guest.hostPublicKey) === snapshot.guest.hostKeyFingerprint &&
      /^10\.77\.77\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/u.test(snapshot.guest.sshAddress ?? "") &&
      (!requireRunning || snapshot.status === "running");
  } catch { return false; }
}

export async function cleanupOwnedGoldenBuilderV1({ adapter, binding, journal }) {
  const observed = await adapter.observe(binding);
  if (!proveGoldenBuilderOwnershipV1(observed, binding)) fail("BUILDER_OWNERSHIP_UNPROVEN", "fresh builder ownership cannot authorize cleanup");
  let stopOperationId = null;
  if (observed.status === "running") {
    const stopped = await adapter.stop(binding);
    if (!plain(stopped) || stopped.status !== "committed" || typeof stopped.providerOperationId !== "string") fail("BUILDER_CLEANUP_UNPROVEN", "builder stop did not commit exactly");
    stopOperationId = stopped.providerOperationId;
    await journal.record("builder-stopped", { providerOperationId: stopped.providerOperationId });
  } else if (observed.status !== "stopped") fail("BUILDER_CLEANUP_UNPROVEN", "builder state cannot authorize deletion");
  const beforeDestroy = await adapter.observe(binding);
  if (!proveGoldenBuilderOwnershipV1(beforeDestroy, binding) || beforeDestroy.status !== "stopped") fail("BUILDER_OWNERSHIP_UNPROVEN", "stopped builder identity changed before deletion");
  const destroyed = await adapter.destroy(binding);
  if (!plain(destroyed) || destroyed.status !== "committed" || typeof destroyed.providerOperationId !== "string") fail("BUILDER_CLEANUP_UNPROVEN", "builder deletion did not commit exactly");
  const absent = await adapter.confirmAbsent(binding);
  if (!plain(absent) || absent.vmAbsent !== true || absent.nameAbsent !== true || absent.volumesAbsent !== true) fail("BUILDER_CLEANUP_UNPROVEN", "builder VM, name, or volumes remain after deletion");
  await journal.record("builder-destroyed", { providerOperationId: destroyed.providerOperationId, absenceDigest: sha256V1(absent) });
  return { stopOperationId, destroyOperationId: destroyed.providerOperationId, absenceDigest: sha256V1(absent) };
}

export async function runDisposableGoldenBuilderV1({
  reservation: reservationInput, lifecycleBinding, toolchainLockDigest, adapter, executeController, bundleStore, receiptStore, journal, clock = Date,
}) {
  const reservation = validateGoldenImageReservationV1(reservationInput, { now: clock.now() });
  const binding = validateGoldenBuilderLifecycleBindingV1(lifecycleBinding, reservation, { now: clock.now() });
  if (!/^sha256:[0-9a-f]{64}$/u.test(toolchainLockDigest ?? "")) fail("INVALID_CONTRACT", "toolchain lock digest is invalid");
  for (const [name, value] of Object.entries({ adapter, executeController, bundleStore, receiptStore, journal })) {
    if ((name === "executeController" && typeof value !== "function") || (name !== "executeController" && !plain(value))) fail("INVALID_ADAPTER", `${name} boundary is invalid`);
  }
  for (const method of ["preflight", "provision", "observe", "stop", "destroy", "confirmAbsent"]) if (typeof adapter[method] !== "function") fail("INVALID_ADAPTER", `adapter.${method} is unavailable`);
  if (typeof bundleStore.commit !== "function" || typeof receiptStore.commit !== "function" || typeof journal.record !== "function") fail("INVALID_ADAPTER", "bundle, receipt, or journal boundary is unavailable");

  validateGoldenBuilderPreflightV1(await adapter.preflight(binding), binding);
  await journal.record("builder-preflighted", { bindingDigest: binding.bindingDigest });
  let provisionAccepted = false;
  let controllerResultReturned = false;
  try {
    provisionAccepted = true;
    const provisioned = await adapter.provision(binding);
    if (!plain(provisioned) || provisioned.status !== "committed" || typeof provisioned.providerOperationId !== "string") {
      fail("BUILDER_PROVISION_UNCERTAIN", "builder provisioning did not reach one committed provider operation");
    }
    await journal.record("builder-provisioned", { providerOperationId: provisioned.providerOperationId });
    const observation = await adapter.observe(binding);
    if (!proveGoldenBuilderOwnershipV1(observation, binding, { requireRunning: true }) ||
        !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(observation.guest.hostKeyFingerprint ?? "")) {
      fail("BUILDER_IDENTITY_MISMATCH", "running Ubuntu builder or SSH host identity differs from the packet");
    }
    await journal.record("builder-identity-proven", { observationDigest: sha256V1(observation) });
    const ownership = /^nelos-golden-builder-v1:([0-9a-f]{32})$/u.exec(binding.builderVm.ownership);
    if (!ownership) fail("BUILDER_IDENTITY_MISMATCH", "builder ownership marker is not the exact nonce form");
    const packet = createGoldenBuilderPacketV1({
      reservation,
      builder: {
        vmId: binding.builderVm.vmId,
        name: binding.builderVm.name,
        mac: binding.builderVm.mac,
        sshUser: binding.builderVm.sshUser,
        sshHostFingerprint: observation.guest.hostKeyFingerprint,
        ownershipNonce: ownership[1],
      },
      toolchainLockDigest,
    }, { now: clock.now() });
    const bundle = Object.freeze({
      schemaVersion: 1,
      reservation,
      builderPacket: packet,
      volumeMeasurementBinding: createVolumeMeasurementBindingV1(reservation, { now: clock.now() }),
    });
    const controllerIdentity = createGoldenBuilderControllerIdentityV1(packet, reservation, { now: clock.now() });
    await bundleStore.commit({ bundle, controllerIdentity });
    await journal.record("builder-bundle-committed", { packetDigest: packet.packetDigest, controllerIdentityDigest: controllerIdentity.identityDigest });
    const controllerResult = await executeController({ binding, bundle, controllerIdentity, packet, reservation, observation });
    controllerResultReturned = true;
    let terminal;
    try {
      terminal = validateGoldenBuilderTerminalReceiptV1(controllerResult, { packet, reservation, now: clock.now() });
    } catch (error) {
      throw new GoldenBuilderLifecycleError("CONTROLLER_RESULT_AMBIGUOUS", "guest controller returned a terminal result whose exact identity is unproven", {
        causeCode: error?.code ?? "INVALID_CONTROLLER_RESULT",
      });
    }
    await receiptStore.commit(terminal);
    await journal.record("builder-terminal-committed", { terminalDigest: terminal.terminalDigest, attestationDigest: terminal.attestationDigest });
    controllerResultReturned = false;
    const cleanup = await cleanupOwnedGoldenBuilderV1({ adapter, binding, journal });
    return Object.freeze({ schemaVersion: 1, state: "destroyed", packetDigest: packet.packetDigest, terminalDigest: terminal.terminalDigest, goldenImageDigest: terminal.goldenImageDigest, cleanup });
  } catch (error) {
    if (!provisionAccepted) throw error;
    if (error?.code === "CONTROLLER_OUTCOME_AMBIGUOUS" || error?.code === "CONTROLLER_RESULT_AMBIGUOUS" || controllerResultReturned) {
      let observationDigest = null;
      let ownershipProven = false;
      try {
        const fresh = await adapter.observe(binding);
        ownershipProven = proveGoldenBuilderOwnershipV1(fresh, binding, { requireRunning: true });
        if (ownershipProven) observationDigest = sha256V1(fresh);
      } catch { /* Preserve an unreadable builder; no mutation is authorized by an ambiguous observation. */ }
      const causeCode = error?.code ?? "CONTROLLER_OUTCOME_AMBIGUOUS";
      await journal.record("builder-controller-reconciliation-required", { causeCode, observationDigest, ownershipProven }).catch(() => {});
      throw new GoldenBuilderLifecycleError("BUILDER_CONTROLLER_RECONCILIATION_REQUIRED", "guest controller outcome is ambiguous; preserve the exact builder and its recovery journal for resume", {
        causeCode, observationDigest, ownershipProven,
      });
    }
    try { await cleanupOwnedGoldenBuilderV1({ adapter, binding, journal }); }
    catch (cleanupError) {
      let quarantine = null;
      if (typeof adapter.quarantine === "function") {
        try {
          const fresh = await adapter.observe(binding);
          if (proveGoldenBuilderOwnershipV1(fresh, binding)) {
            const result = await adapter.quarantine(binding);
            if (!plain(result) || result.status !== "committed" || typeof result.providerOperationId !== "string") fail("BUILDER_QUARANTINE_UNPROVEN", "builder quarantine did not commit exactly");
            quarantine = { providerOperationId: result.providerOperationId };
            await journal.record("builder-quarantine-committed", quarantine);
          }
        } catch (quarantineError) {
          quarantine = { errorCode: quarantineError?.code ?? "BUILDER_QUARANTINE_FAILED" };
        }
      }
      await journal.record("builder-quarantined", { causeCode: error?.code ?? "BUILDER_FAILED", cleanupCode: cleanupError?.code ?? "BUILDER_CLEANUP_FAILED", quarantine }).catch(() => {});
      throw new GoldenBuilderLifecycleError("BUILDER_RECONCILIATION_REQUIRED", "builder failed and exact cleanup is unproven; preserve it for reconciliation", {
        causeCode: error?.code ?? "BUILDER_FAILED", cleanupCode: cleanupError?.code ?? "BUILDER_CLEANUP_FAILED", quarantine,
      });
    }
    throw error;
  }
}
