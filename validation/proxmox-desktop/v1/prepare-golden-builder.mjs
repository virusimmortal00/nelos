#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, lstat, open, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonV1,
  sha256V1,
  validateGoldenImageReservationV1,
  validateVolumeMeasurementV1,
} from "./build-golden-image.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const MAC = /^02(?::[0-9A-F]{2}){5}$/u;
const SOURCE_TEMPLATE_VMID = 9024;
const BUILDER_VMID = 9026;
const OUTPUT_TEMPLATE_VMID = 9027;
const STORAGE = "local-lvm";
const BRIDGE = "nelosbld";
const BUILDER_MAC = "02:4E:45:4C:90:26";
const PROXMOX_SSH_HOST = "192.168.1.110";
const PROXMOX_SSH_FINGERPRINT = "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg";

export class GoldenBuilderPreparationError extends Error {
  constructor(code, message) { super(message); this.name = "GoldenBuilderPreparationError"; this.code = code; }
}

function fail(code, message) { throw new GoldenBuilderPreparationError(code, message); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${label} fields differ from the closed contract`);
  return value;
}
function text(value, label, pattern = ID, maximum = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail("INVALID_CONTRACT", `${label} is invalid`);
  return value;
}
function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("INVALID_CONTRACT", `${label} is invalid`);
  return value;
}
function openSshFingerprint(value) {
  const encoded = typeof value === "string" ? value.split(" ")[1] : "";
  let bytes;
  try { bytes = Buffer.from(encoded, "base64"); } catch { return null; }
  if (bytes.length < 32 || bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) return null;
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/u, "")}`;
}

function packageSourceArtifact(lock) {
  exact(lock, ["artifacts", "generatedAt", "lockId", "platform", "policy", "schemaVersion"], "packageLock");
  const base = lock.artifacts?.ubuntuBase;
  if (lock.schemaVersion !== 1 || !plain(base) || base.name !== "ubuntu-24.04-server-cloudimg-amd64.img" ||
      base.digest !== "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe" ||
      base.signatureIdentity?.scheme !== "openpgp-detached-sha256sums" ||
      base.signatureIdentity?.fingerprint !== "843938DF228D22F7B3742BC0D94AA3F0EFE21092") {
    fail("PACKAGE_LOCK_INVALID", "package lock does not contain the approved Ubuntu base identity");
  }
  return {
    name: base.name, digest: base.digest, signatureScheme: base.signatureIdentity.scheme,
    signatureFingerprint: base.signatureIdentity.fingerprint,
  };
}

function provisionalReservationFromRequest(request, { now = Date.now() } = {}) {
  exact(request, [
    "apiTlsCaDigest", "apiUrl", "attestorTokenId", "buildNonce", "buildTokenId", "cleanupExpiresAt", "expiresAt", "maxBuildMs", "networkAclPath", "node",
    "outputTemplate", "providerId", "reservationId", "schemaVersion", "sourceCommit", "sourceTemplateName", "storage", "volumeAttestor",
  ], "request");
  if (request.schemaVersion !== 1 || request.storage !== STORAGE || !plain(request.outputTemplate) || request.outputTemplate.vmId !== OUTPUT_TEMPLATE_VMID) {
    fail("INVALID_CONTRACT", "request must use the exact homelab source and storage identities");
  }
  if (request.volumeAttestor?.sshHost !== PROXMOX_SSH_HOST || request.volumeAttestor?.sshPort !== 22 ||
      request.volumeAttestor?.hostKeyFingerprint !== PROXMOX_SSH_FINGERPRINT) {
    fail("INVALID_CONTRACT", "volume attestor must use the literal console-pinned Proxmox SSH endpoint");
  }
  const provisional = {
    schemaVersion: 2, reservationId: request.reservationId, providerId: request.providerId, apiUrl: request.apiUrl,
    tlsCaDigest: request.apiTlsCaDigest, node: request.node, storage: STORAGE, networkAclPath: request.networkAclPath,
    sourceCommit: request.sourceCommit, buildNonce: request.buildNonce, buildTokenId: request.buildTokenId, attestorTokenId: request.attestorTokenId,
    expiresAt: request.expiresAt, cleanupExpiresAt: request.cleanupExpiresAt, maxBuildMs: request.maxBuildMs,
    sourceArtifact: {
      name: "ubuntu-24.04-server-cloudimg-amd64.img", digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe",
      signatureScheme: "openpgp-detached-sha256sums", signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
    },
    volumeAttestor: structuredClone(request.volumeAttestor),
    sourceTemplate: { vmId: SOURCE_TEMPLATE_VMID, name: request.sourceTemplateName, configDigest: `sha256:${"0".repeat(64)}`, volumeMeasurementDigest: `sha256:${"0".repeat(64)}` },
    outputTemplate: structuredClone(request.outputTemplate),
  };
  return validateGoldenImageReservationV1(provisional, { now });
}

export function createVolumeMeasurementBindingFromRequestV1(request, { now = Date.now() } = {}) {
  return createVolumeMeasurementBindingV1(provisionalReservationFromRequest(request, { now }), { now });
}

export function createGoldenImageReservationV2({ request, sourceConfig, sourceMeasurement, packageLock }, { now = Date.now() } = {}) {
  provisionalReservationFromRequest(request, { now });
  if (!plain(sourceConfig) || sourceConfig.name !== request.sourceTemplateName || Number(sourceConfig.template) !== 1) fail("SOURCE_IDENTITY_MISMATCH", "source config is not the exact template");
  if (request.outputTemplate?.vmId !== OUTPUT_TEMPLATE_VMID) fail("INVALID_CONTRACT", "output VMID differs from fixed production output 9027");
  const provisional = {
    schemaVersion: 2,
    reservationId: request.reservationId,
    providerId: request.providerId,
    apiUrl: request.apiUrl,
    tlsCaDigest: request.apiTlsCaDigest,
    node: request.node,
    storage: STORAGE,
    networkAclPath: request.networkAclPath,
    sourceCommit: request.sourceCommit,
    buildNonce: request.buildNonce,
    buildTokenId: request.buildTokenId,
    attestorTokenId: request.attestorTokenId,
    expiresAt: request.expiresAt,
    cleanupExpiresAt: request.cleanupExpiresAt,
    maxBuildMs: request.maxBuildMs,
    sourceArtifact: packageSourceArtifact(packageLock),
    volumeAttestor: structuredClone(request.volumeAttestor),
    sourceTemplate: {
      vmId: SOURCE_TEMPLATE_VMID,
      name: request.sourceTemplateName,
      configDigest: sha256V1(sourceConfig),
      volumeMeasurementDigest: sourceMeasurement?.contentDigest,
    },
    outputTemplate: structuredClone(request.outputTemplate),
  };
  validateGoldenImageReservationV1(provisional, { now });
  validateVolumeMeasurementV1(sourceMeasurement, provisional, { role: "source", config: sourceConfig });
  return provisional;
}

export function createVolumeMeasurementBindingV1(reservation, { now = Date.now(), allowExpiredForCleanup = false } = {}) {
  validateGoldenImageReservationV1(reservation, { now, allowExpiredForCleanup });
  return {
    schemaVersion: 1,
    reservationId: reservation.reservationId,
    providerId: reservation.providerId,
    node: reservation.node,
    storage: reservation.storage,
    sourceTemplate: { vmId: reservation.sourceTemplate.vmId, name: reservation.sourceTemplate.name },
    outputTemplate: structuredClone(reservation.outputTemplate),
    buildNonce: reservation.buildNonce,
    expiresAt: reservation.expiresAt,
    helperDigest: reservation.volumeAttestor.helperDigest,
    volumeAttestorFingerprint: reservation.volumeAttestor.identityFingerprint,
  };
}

export function createGoldenBuilderPacketV1({ reservation, builder, toolchainLockDigest }, { now = Date.now(), allowExpiredForCleanup = false } = {}) {
  validateGoldenImageReservationV1(reservation, { now, allowExpiredForCleanup });
  exact(builder, ["mac", "name", "ownershipNonce", "sshHostFingerprint", "sshUser", "vmId"], "builder");
  integer(builder.vmId, "builder.vmId", 100, 999_999_999);
  text(builder.name, "builder.name", /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u, 63);
  text(builder.ownershipNonce, "builder.ownershipNonce", /^[0-9a-f]{32}$/u, 32);
  text(builder.sshHostFingerprint, "builder.sshHostFingerprint", SSH_FINGERPRINT, 51);
  text(builder.sshUser, "builder.sshUser", /^[a-z_][a-z0-9_-]{0,31}$/u, 32);
  if (!MAC.test(builder.mac) || builder.mac !== BUILDER_MAC || builder.vmId !== BUILDER_VMID || reservation.outputTemplate.vmId !== OUTPUT_TEMPLATE_VMID ||
      builder.name !== `nelos-golden-builder-${builder.ownershipNonce.slice(0, 12)}` || !SHA256.test(toolchainLockDigest)) {
    fail("INVALID_CONTRACT", "builder VM identity, MAC, name, or toolchain digest differs");
  }
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-proxmox-golden-builder",
    reservationDigest: sha256V1(reservation),
    sourceCommit: reservation.sourceCommit,
    providerId: reservation.providerId,
    hostId: reservation.node,
    sourceTemplateVmId: SOURCE_TEMPLATE_VMID,
    outputTemplateVmId: reservation.outputTemplate.vmId,
    storage: STORAGE,
    bridge: BRIDGE,
    builderVm: {
      vmId: builder.vmId, name: builder.name, mac: builder.mac, sshUser: builder.sshUser,
      sshHostFingerprint: builder.sshHostFingerprint, ownership: `nelos-golden-builder-v1:${builder.ownershipNonce}`,
    },
    controller: { operatingSystem: "linux", distribution: "ubuntu", release: "24.04", architecture: "x86_64", nodeVersion: "24.18.0" },
    toolchainLockDigest,
    expiresAt: reservation.expiresAt,
  };
  return { ...unsigned, packetDigest: sha256V1(unsigned) };
}

export function createGoldenBuilderLifecycleBindingV1({ reservation, builder }, { now = Date.now(), allowExpiredForCleanup = false } = {}) {
  validateGoldenImageReservationV1(reservation, { now, allowExpiredForCleanup });
  exact(builder, ["mac", "name", "ownershipNonce", "sshPublicKey", "sshPublicKeyFingerprint", "sshUser", "vmId"], "builderLifecycle");
  integer(builder.vmId, "builderLifecycle.vmId", 100, 999_999_999);
  text(builder.name, "builderLifecycle.name", /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u, 63);
  text(builder.ownershipNonce, "builderLifecycle.ownershipNonce", /^[0-9a-f]{32}$/u, 32);
  text(builder.sshUser, "builderLifecycle.sshUser", /^[a-z_][a-z0-9_-]{0,31}$/u, 32);
  text(builder.sshPublicKeyFingerprint, "builderLifecycle.sshPublicKeyFingerprint", SSH_FINGERPRINT, 51);
  if (!MAC.test(builder.mac) || builder.mac !== BUILDER_MAC || builder.vmId !== BUILDER_VMID || reservation.outputTemplate.vmId !== OUTPUT_TEMPLATE_VMID ||
      builder.name !== `nelos-golden-builder-${builder.ownershipNonce.slice(0, 12)}` ||
      typeof builder.sshPublicKey !== "string" || !/^ssh-ed25519 [A-Za-z0-9+/]{40,120}={0,2}$/u.test(builder.sshPublicKey) ||
      openSshFingerprint(builder.sshPublicKey) !== builder.sshPublicKeyFingerprint) {
    fail("INVALID_CONTRACT", "builder lifecycle identity, public key, MAC, or name differs");
  }
  const unsigned = {
    schemaVersion: 1, kind: "nelos-golden-builder-lifecycle", reservationDigest: sha256V1(reservation), providerId: reservation.providerId,
    hostId: reservation.node, sourceTemplate: structuredClone(reservation.sourceTemplate), outputTemplateVmId: reservation.outputTemplate.vmId,
    outputTemplateName: reservation.outputTemplate.name, outputTemplateMacAddress: reservation.outputTemplate.macAddress,
    storage: STORAGE, bridge: BRIDGE, networkAclPath: reservation.networkAclPath, expiresAt: reservation.expiresAt,
    cleanupExpiresAt: reservation.cleanupExpiresAt,
    builderVm: {
      vmId: builder.vmId, name: builder.name, mac: builder.mac, sshUser: builder.sshUser, sshPublicKey: builder.sshPublicKey,
      sshPublicKeyFingerprint: builder.sshPublicKeyFingerprint, ownership: `nelos-golden-builder-v1:${builder.ownershipNonce}`,
    },
  };
  return { ...unsigned, bindingDigest: sha256V1(unsigned) };
}

export function validateGoldenBuilderLifecycleBindingV1(binding, reservation, { now = Date.now(), allowExpiredForCleanup = false } = {}) {
  exact(binding, [
    "bindingDigest", "bridge", "builderVm", "cleanupExpiresAt", "expiresAt", "hostId", "kind", "networkAclPath", "outputTemplateMacAddress", "outputTemplateName", "outputTemplateVmId", "providerId", "reservationDigest", "schemaVersion",
    "sourceTemplate", "storage",
  ], "builderLifecycleBinding");
  exact(binding.builderVm, ["mac", "name", "ownership", "sshPublicKey", "sshPublicKeyFingerprint", "sshUser", "vmId"], "builderLifecycleBinding.builderVm");
  const ownership = /^nelos-golden-builder-v1:([0-9a-f]{32})$/u.exec(binding.builderVm.ownership ?? "");
  if (!ownership) fail("INVALID_CONTRACT", "builder lifecycle ownership marker is invalid");
  const recreated = createGoldenBuilderLifecycleBindingV1({
    reservation,
    builder: {
      vmId: binding.builderVm.vmId, name: binding.builderVm.name, mac: binding.builderVm.mac, sshUser: binding.builderVm.sshUser,
      sshPublicKey: binding.builderVm.sshPublicKey, sshPublicKeyFingerprint: binding.builderVm.sshPublicKeyFingerprint, ownershipNonce: ownership[1],
    },
  }, { now, allowExpiredForCleanup });
  if (canonicalJsonV1(recreated) !== canonicalJsonV1(binding)) fail("INVALID_CONTRACT", "builder lifecycle binding digest or identity differs");
  return binding;
}

export function validateGoldenBuilderPacketV1(packet, reservation, { now = Date.now(), allowExpiredForCleanup = false } = {}) {
  exact(packet, [
    "bridge", "builderVm", "controller", "expiresAt", "hostId", "kind", "outputTemplateVmId", "packetDigest", "providerId", "reservationDigest",
    "schemaVersion", "sourceCommit", "sourceTemplateVmId", "storage", "toolchainLockDigest",
  ], "builderPacket");
  exact(packet.builderVm, ["mac", "name", "ownership", "sshHostFingerprint", "sshUser", "vmId"], "builderPacket.builderVm");
  const ownership = /^nelos-golden-builder-v1:([0-9a-f]{32})$/u.exec(packet.builderVm.ownership ?? "");
  if (!ownership) fail("INVALID_CONTRACT", "builder packet ownership marker is invalid");
  const recreated = createGoldenBuilderPacketV1({
    reservation,
    builder: {
      vmId: packet.builderVm.vmId, name: packet.builderVm.name, mac: packet.builderVm.mac, sshUser: packet.builderVm.sshUser,
      sshHostFingerprint: packet.builderVm.sshHostFingerprint, ownershipNonce: ownership[1],
    },
    toolchainLockDigest: packet.toolchainLockDigest,
  }, { now, allowExpiredForCleanup });
  if (canonicalJsonV1(recreated) !== canonicalJsonV1(packet)) fail("INVALID_CONTRACT", "builder packet content address or binding differs");
  return packet;
}

export function createGoldenBuilderControllerIdentityV1(packet, reservation, { now = Date.now(), allowExpiredForCleanup = false } = {}) {
  validateGoldenBuilderPacketV1(packet, reservation, { now, allowExpiredForCleanup });
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-golden-builder-controller-identity",
    packetDigest: packet.packetDigest,
    providerId: packet.providerId,
    hostId: packet.hostId,
    vmId: packet.builderVm.vmId,
    name: packet.builderVm.name,
    mac: packet.builderVm.mac,
    ownership: packet.builderVm.ownership,
    sshHostFingerprint: packet.builderVm.sshHostFingerprint,
  };
  return { ...unsigned, identityDigest: sha256V1(unsigned) };
}

export function validateGoldenBuilderTerminalReceiptV1(value, { packet, reservation, now = Date.now(), allowExpiredForCleanup = false } = {}) {
  validateGoldenBuilderPacketV1(packet, reservation, { now, allowExpiredForCleanup });
  exact(value, ["attestationDigest", "completedAt", "goldenImageDigest", "kind", "packetDigest", "reservationDigest", "result", "schemaVersion", "terminalDigest"], "builderTerminalReceipt");
  if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-builder-terminal" || value.result !== "committed" ||
      value.packetDigest !== packet.packetDigest || value.reservationDigest !== packet.reservationDigest || !SHA256.test(value.attestationDigest ?? "") ||
      !SHA256.test(value.goldenImageDigest ?? "") || !Number.isFinite(Date.parse(value.completedAt))) {
    fail("INVALID_CONTRACT", "builder terminal receipt identity or result differs");
  }
  const { terminalDigest, ...unsigned } = value;
  if (terminalDigest !== sha256V1(unsigned)) fail("INVALID_CONTRACT", "builder terminal receipt digest differs");
  return value;
}

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function renderRootProgram(commands) {
  return `#!/bin/sh\nset -eu\numask 077\nPATH=/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\n${commands.map((parts) => parts.map(quote).join(" ")).join("\n")}\n`;
}

function scopedAclIdentities(reservation) {
  const suffix = reservation.buildNonce.slice(0, 12);
  return Object.freeze({
    nodeAudit: `NelosGoldenNodeAudit-${suffix}`,
    storageBuild: `NelosGoldenStorageBuild-${suffix}`,
    storageAudit: `NelosGoldenStorageAudit-${suffix}`,
    sourceClone: `NelosGoldenSourceClone-${suffix}`,
    vmAudit: `NelosGoldenVmAudit-${suffix}`,
    outputBuild: `NelosGoldenOutputBuild-${suffix}`,
    vnetUse: `NelosGoldenVnetUse-${suffix}`,
  });
}

function scopedAclCleanupCommandsV2(reservation) {
  const buildUser = reservation.buildTokenId.split("!", 1)[0];
  const attestUser = reservation.attestorTokenId.split("!", 1)[0];
  const buildToken = reservation.buildTokenId.slice(reservation.buildTokenId.indexOf("!") + 1);
  const attestToken = reservation.attestorTokenId.slice(reservation.attestorTokenId.indexOf("!") + 1);
  const role = scopedAclIdentities(reservation);
  const grants = [
    [reservation.networkAclPath, buildUser, role.vnetUse],
    [`/vms/${reservation.outputTemplate.vmId}`, attestUser, role.vmAudit],
    [`/vms/${reservation.sourceTemplate.vmId}`, attestUser, role.vmAudit],
    [`/storage/${reservation.storage}`, attestUser, role.storageAudit],
    [`/nodes/${reservation.node}`, attestUser, role.nodeAudit],
    [`/vms/${reservation.outputTemplate.vmId}`, buildUser, role.outputBuild],
    [`/vms/${reservation.sourceTemplate.vmId}`, buildUser, role.sourceClone],
    [`/storage/${reservation.storage}`, buildUser, role.storageBuild],
    [`/nodes/${reservation.node}`, buildUser, role.nodeAudit],
  ];
  return [
    ["/usr/sbin/pveum", "user", "token", "remove", buildUser, buildToken],
    ["/usr/sbin/pveum", "user", "token", "remove", attestUser, attestToken],
    ...grants.map(([path, user, roleName]) => ["/usr/sbin/pveum", "acl", "delete", path, "--users", user, "--roles", roleName]),
    ["/usr/sbin/pveum", "user", "delete", buildUser],
    ["/usr/sbin/pveum", "user", "delete", attestUser],
    ...Object.values(role).reverse().map((roleName) => ["/usr/sbin/pveum", "role", "delete", roleName]),
  ];
}

export function createScopedAclBootstrapPlanV2(reservation, { now = Date.now() } = {}) {
  validateGoldenImageReservationV1(reservation, { now });
  const buildUser = reservation.buildTokenId.split("!", 1)[0];
  const attestUser = reservation.attestorTokenId.split("!", 1)[0];
  const buildToken = reservation.buildTokenId.slice(reservation.buildTokenId.indexOf("!") + 1);
  const attestToken = reservation.attestorTokenId.slice(reservation.attestorTokenId.indexOf("!") + 1);
  const role = scopedAclIdentities(reservation);
  const setupCommands = [
    ["/usr/sbin/pveum", "user", "add", buildUser],
    ["/usr/sbin/pveum", "user", "add", attestUser],
    ["/usr/sbin/pveum", "role", "add", role.nodeAudit, "--privs", "Sys.Audit"],
    ["/usr/sbin/pveum", "role", "add", role.storageBuild, "--privs", "Datastore.AllocateSpace Datastore.Audit"],
    ["/usr/sbin/pveum", "role", "add", role.storageAudit, "--privs", "Datastore.Audit"],
    ["/usr/sbin/pveum", "role", "add", role.sourceClone, "--privs", "VM.Audit VM.Clone"],
    ["/usr/sbin/pveum", "role", "add", role.vmAudit, "--privs", "VM.Audit"],
    ["/usr/sbin/pveum", "role", "add", role.outputBuild, "--privs", "VM.Allocate VM.Audit VM.Config.CDROM VM.Config.Cloudinit VM.Config.CPU VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Network VM.Config.Options VM.PowerMgmt"],
    ["/usr/sbin/pveum", "role", "add", role.vnetUse, "--privs", "SDN.Use"],
    ["/usr/sbin/pveum", "acl", "modify", `/nodes/${reservation.node}`, "--users", buildUser, "--roles", role.nodeAudit, "--propagate", "0"],
    ["/usr/sbin/pveum", "acl", "modify", `/storage/${reservation.storage}`, "--users", buildUser, "--roles", role.storageBuild, "--propagate", "0"],
    ["/usr/sbin/pveum", "acl", "modify", `/vms/${reservation.sourceTemplate.vmId}`, "--users", buildUser, "--roles", role.sourceClone, "--propagate", "0"],
    ["/usr/sbin/pveum", "acl", "modify", `/vms/${reservation.outputTemplate.vmId}`, "--users", buildUser, "--roles", role.outputBuild, "--propagate", "0"],
    ["/usr/sbin/pveum", "acl", "modify", reservation.networkAclPath, "--users", buildUser, "--roles", role.vnetUse, "--propagate", "0"],
    ["/usr/sbin/pveum", "acl", "modify", `/nodes/${reservation.node}`, "--users", attestUser, "--roles", role.nodeAudit, "--propagate", "0"],
    ["/usr/sbin/pveum", "acl", "modify", `/storage/${reservation.storage}`, "--users", attestUser, "--roles", role.storageAudit, "--propagate", "0"],
    ["/usr/sbin/pveum", "acl", "modify", `/vms/${reservation.sourceTemplate.vmId}`, "--users", attestUser, "--roles", role.vmAudit, "--propagate", "0"],
    ["/usr/sbin/pveum", "acl", "modify", `/vms/${reservation.outputTemplate.vmId}`, "--users", attestUser, "--roles", role.vmAudit, "--propagate", "0"],
  ];
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-golden-builder-acl-bootstrap-plan",
    reservationDigest: sha256V1(reservation),
    reservationId: reservation.reservationId,
    buildNonce: reservation.buildNonce,
    expiresAt: reservation.expiresAt,
    network: { vnet: "nelosbld", zone: "nelosbld", aclPath: reservation.networkAclPath },
    setupCommands,
    tokenRequests: [
      { kind: "build", tokenId: reservation.buildTokenId, user: buildUser, tokenName: buildToken, outputName: "build-token" },
      { kind: "attestor", tokenId: reservation.attestorTokenId, user: attestUser, tokenName: attestToken, outputName: "attestor-token" },
    ],
    rollbackCommands: scopedAclCleanupCommandsV2(reservation),
  };
  return { ...unsigned, planDigest: sha256V1(unsigned) };
}

export function renderScopedAclBootstrapV2(reservation, options = {}) {
  return `${canonicalJsonV1(createScopedAclBootstrapPlanV2(reservation, options))}\n`;
}

export function renderScopedAclCleanupV2(reservation, { now = Date.now() } = {}) {
  validateGoldenImageReservationV1(reservation, { now });
  return renderRootProgram(scopedAclCleanupCommandsV2(reservation));
}

async function sealedJson(path, label) {
  if (!isAbsolute(path)) fail("UNSAFE_PATH", `${label} must be absolute`);
  const canonical = await realpath(path).catch(() => null); const info = await lstat(path).catch(() => null);
  if (!canonical || canonical !== path || !info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 1_048_576 || (info.mode & 0o022) !== 0) {
    fail("UNSAFE_PATH", `${label} is not a sealed regular file`);
  }
  try { return JSON.parse(await readFile(canonical, "utf8")); } catch { fail("INVALID_CONTRACT", `${label} is invalid JSON`); }
}

async function writeAtomic(path, bytes, mode) {
  if (!isAbsolute(path) || basename(path).startsWith(".")) fail("UNSAFE_PATH", "output path must be a specific absolute path");
  const parent = await realpath(dirname(path)).catch(() => null); const parentInfo = parent ? await lstat(parent).catch(() => null) : null;
  if (!parent || !parentInfo?.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o077) !== 0) fail("UNSAFE_PATH", "output parent must be a private canonical directory");
  const temporary = `${path}.${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(temporary, mode); await rename(temporary, path);
}

function parseArgs(argv) {
  const options = {}; let validateOnly = false; let validateBundle = false; let prepareVolumeBinding = false; let controllerIdentity = false; let prepareBuilderLifecycle = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--validate-only") { validateOnly = true; continue; }
    if (argv[index] === "--validate-bundle") { validateBundle = true; continue; }
    if (argv[index] === "--prepare-volume-binding") { prepareVolumeBinding = true; continue; }
    if (argv[index] === "--controller-identity") { controllerIdentity = true; continue; }
    if (argv[index] === "--prepare-builder-lifecycle") { prepareBuilderLifecycle = true; continue; }
    const value = argv[index + 1];
    if (!value || !new Set(["--request", "--source-config", "--source-measurement", "--package-lock", "--builder", "--toolchain-lock", "--output", "--acl-output", "--acl-cleanup-output"]).has(argv[index])) fail("INVALID_OPERATION", "prepare-golden-builder arguments are invalid");
    options[argv[index].slice(2)] = value; index += 1;
  }
  if ([validateOnly, validateBundle, prepareVolumeBinding, controllerIdentity, prepareBuilderLifecycle].filter(Boolean).length > 1) fail("INVALID_OPERATION", "validation and preparation modes are mutually exclusive");
  return { options, validateOnly, validateBundle, prepareVolumeBinding, controllerIdentity, prepareBuilderLifecycle };
}

async function cli() {
  const { options, validateOnly, validateBundle, prepareVolumeBinding, controllerIdentity, prepareBuilderLifecycle } = parseArgs(process.argv.slice(2));
  if (validateOnly) {
    if (Object.keys(options).sort().join("\0") !== "request") fail("INVALID_OPERATION", "--validate-only accepts only --request RESERVATION.json");
    const value = validateGoldenImageReservationV1(await sealedJson(resolve(options.request), "reservation"));
    process.stdout.write(`${canonicalJsonV1({ valid: true, reservationDigest: sha256V1(value) })}\n`); return;
  }
  if (validateBundle) {
    if (Object.keys(options).sort().join("\0") !== "request") fail("INVALID_OPERATION", "--validate-bundle accepts only --request BUNDLE.json");
    const bundle = await sealedJson(resolve(options.request), "builder bundle");
    exact(bundle, ["builderPacket", "reservation", "schemaVersion", "volumeMeasurementBinding"], "builderBundle");
    if (bundle.schemaVersion !== 1) fail("INVALID_CONTRACT", "builder bundle schema is unsupported");
    const reservation = validateGoldenImageReservationV1(bundle.reservation);
    validateGoldenBuilderPacketV1(bundle.builderPacket, reservation);
    if (canonicalJsonV1(bundle.volumeMeasurementBinding) !== canonicalJsonV1(createVolumeMeasurementBindingV1(reservation))) fail("INVALID_CONTRACT", "volume binding differs from the reservation");
    process.stdout.write(`${canonicalJsonV1({ valid: true, packetDigest: bundle.builderPacket.packetDigest, reservationDigest: sha256V1(reservation) })}\n`); return;
  }
  if (prepareVolumeBinding) {
    if (Object.keys(options).sort().join("\0") !== ["output", "request"].join("\0")) fail("INVALID_OPERATION", "--prepare-volume-binding requires only --request and --output");
    const binding = createVolumeMeasurementBindingFromRequestV1(await sealedJson(resolve(options.request), "request"));
    await writeAtomic(resolve(options.output), Buffer.from(`${canonicalJsonV1(binding)}\n`), 0o400);
    process.stdout.write(`${canonicalJsonV1({ bindingDigest: sha256V1(binding) })}\n`); return;
  }
  if (controllerIdentity) {
    if (Object.keys(options).sort().join("\0") !== ["output", "request"].join("\0")) fail("INVALID_OPERATION", "--controller-identity requires only --request BUNDLE.json and --output");
    const bundle = await sealedJson(resolve(options.request), "builder bundle");
    exact(bundle, ["builderPacket", "reservation", "schemaVersion", "volumeMeasurementBinding"], "builderBundle");
    if (bundle.schemaVersion !== 1) fail("INVALID_CONTRACT", "builder bundle schema is unsupported");
    const reservation = validateGoldenImageReservationV1(bundle.reservation);
    const identity = createGoldenBuilderControllerIdentityV1(bundle.builderPacket, reservation);
    await writeAtomic(resolve(options.output), Buffer.from(`${canonicalJsonV1(identity)}\n`), 0o400);
    process.stdout.write(`${canonicalJsonV1({ identityDigest: identity.identityDigest })}\n`); return;
  }
  if (prepareBuilderLifecycle) {
    const requiredLifecycle = ["acl-cleanup-output", "acl-output", "builder", "output", "package-lock", "request", "source-config", "source-measurement"];
    if (Object.keys(options).sort().join("\0") !== requiredLifecycle.sort().join("\0")) fail("INVALID_OPERATION", "--prepare-builder-lifecycle requires every closed identity input and output");
    const [request, sourceConfig, sourceMeasurement, packageLock, builder] = await Promise.all([
      sealedJson(resolve(options.request), "request"), sealedJson(resolve(options["source-config"]), "source config"),
      sealedJson(resolve(options["source-measurement"]), "source measurement"), sealedJson(resolve(options["package-lock"]), "package lock"),
      sealedJson(resolve(options.builder), "builder lifecycle identity"),
    ]);
    const reservation = createGoldenImageReservationV2({ request, sourceConfig, sourceMeasurement, packageLock });
    const binding = createGoldenBuilderLifecycleBindingV1({ reservation, builder });
    const value = { schemaVersion: 1, reservation, builderLifecycleBinding: binding };
    await writeAtomic(resolve(options.output), Buffer.from(`${canonicalJsonV1(value)}\n`), 0o400);
    await writeAtomic(resolve(options["acl-output"]), Buffer.from(renderScopedAclBootstrapV2(reservation)), 0o400);
    await writeAtomic(resolve(options["acl-cleanup-output"]), Buffer.from(renderScopedAclCleanupV2(reservation)), 0o400);
    process.stdout.write(`${canonicalJsonV1({ bindingDigest: binding.bindingDigest, reservationDigest: sha256V1(reservation) })}\n`); return;
  }
  const required = ["acl-cleanup-output", "acl-output", "builder", "output", "package-lock", "request", "source-config", "source-measurement", "toolchain-lock"];
  if (Object.keys(options).sort().join("\0") !== required.sort().join("\0")) fail("INVALID_OPERATION", "prepare-golden-builder requires every closed input and output");
  const [request, sourceConfig, sourceMeasurement, packageLock, builder, toolchainLock] = await Promise.all([
    sealedJson(resolve(options.request), "request"), sealedJson(resolve(options["source-config"]), "source config"),
    sealedJson(resolve(options["source-measurement"]), "source measurement"), sealedJson(resolve(options["package-lock"]), "package lock"),
    sealedJson(resolve(options.builder), "builder identity"), sealedJson(resolve(options["toolchain-lock"]), "toolchain lock"),
  ]);
  const reservation = createGoldenImageReservationV2({ request, sourceConfig, sourceMeasurement, packageLock });
  const packet = createGoldenBuilderPacketV1({ reservation, builder, toolchainLockDigest: sha256V1(await readFile(resolve(options["toolchain-lock"]))) });
  const result = { schemaVersion: 1, reservation, builderPacket: packet, volumeMeasurementBinding: createVolumeMeasurementBindingV1(reservation) };
  await writeAtomic(resolve(options.output), Buffer.from(`${canonicalJsonV1(result)}\n`), 0o400);
  await writeAtomic(resolve(options["acl-output"]), Buffer.from(renderScopedAclBootstrapV2(reservation)), 0o400);
  await writeAtomic(resolve(options["acl-cleanup-output"]), Buffer.from(renderScopedAclCleanupV2(reservation)), 0o400);
  process.stdout.write(`${canonicalJsonV1({ packetDigest: packet.packetDigest, reservationDigest: sha256V1(reservation) })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) cli().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error?.code ?? "GOLDEN_BUILDER_PREPARATION_FAILED", message: error?.message ?? "golden builder preparation failed" })}\n`);
  process.exitCode = 1;
});
