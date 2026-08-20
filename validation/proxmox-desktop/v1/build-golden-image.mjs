#!/usr/bin/node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { stageProductionDesktopCandidate } from "../../../scripts/stage-production-desktop-candidate.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const TOKEN_ID = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const MAC_ADDRESS = /^02(?::[0-9A-F]{2}){5}$/u;
const VOLUME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*:(?:base|vm)-[1-9][0-9]{2,8}-[A-Za-z0-9._-]+$/u;
const PROVIDER_ID = "proxmox-lab";
const SOURCE_TEMPLATE_VMID = 9024;
const OUTPUT_TEMPLATE_VMID = 9027;
const OUTPUT_NAME = "nelos-desktop-ubuntu-24-04-v1";
const OUTPUT_MAC_ADDRESS = "02:4E:45:4C:90:27";
const PROXMOX_API_URL = "https://192.168.1.110:8006/api2/json";
const PROXMOX_TLS_CA_DIGEST = "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d";
const PACKER_TARGET = "desktop.proxmox-clone.desktop";
const PACKER_BUILDER_ID = "proxmox.clone";
const MAX_MACHINE_OUTPUT = 67_108_864;
const FORBIDDEN_CONFIG_KEYS = new Set([
  "args", "cicustom", "cipassword", "hookscript", "ivshmem", "nameserver", "searchdomain", "sshkeys", "tpmstate0", "vmstate",
]);
const BUILD_PRIVILEGES = new Set([
  "Datastore.AllocateSpace", "Datastore.Audit", "Sys.Audit", "VM.Allocate", "VM.Audit", "VM.Clone",
  "VM.Config.CDROM", "VM.Config.Cloudinit", "VM.Config.CPU", "VM.Config.Disk", "VM.Config.HWType",
  "VM.Config.Memory", "VM.Config.Network", "VM.Config.Options", "VM.PowerMgmt", "SDN.Use",
]);
const ATTEST_PRIVILEGES = new Set(["Datastore.Audit", "Sys.Audit", "VM.Audit"]);
const MODULE_PATH = fileURLToPath(import.meta.url);
const V1_ROOT = dirname(MODULE_PATH);
const REPOSITORY_ROOT = resolve(V1_ROOT, "../../..");
const TOOLCHAIN_LOCK_PATH = resolve(REPOSITORY_ROOT, "validation/proxmox/toolchain.lock.json");
export const SEALED_SOURCE_PATHS_V1 = Object.freeze([
  "scripts/stage-production-desktop-candidate.mjs",
  "src/distribution-provenance.mjs",
  "validation/proxmox/toolchain.lock.json",
  "validation/proxmox-desktop/v1/build-golden-image.mjs",
  "validation/proxmox-desktop/v1/collect-golden-source-measurement.sh",
  "validation/proxmox-desktop/v1/golden-builder-lifecycle-identity.schema.json",
  "validation/proxmox-desktop/v1/golden-builder-lifecycle.mjs",
  "validation/proxmox-desktop/v1/golden-builder-request.schema.json",
  "validation/proxmox-desktop/v1/golden-image.pkr.hcl",
  "validation/proxmox-desktop/v1/golden-image-recovery.mjs",
  "validation/proxmox-desktop/v1/install-volume-attestor.sh",
  "validation/proxmox-desktop/v1/package-lock.json",
  "validation/proxmox-desktop/v1/prepare-golden-builder.mjs",
  "validation/proxmox-desktop/v1/provision-golden-image.sh",
  "validation/proxmox-desktop/v1/remove-volume-attestor.sh",
  "validation/proxmox-desktop/v1/run-golden-builder-controller.sh",
  "validation/proxmox-desktop/v1/ubuntu.sources",
  "validation/proxmox-desktop/v1/nelos-proxmox-volume-measure.py",
  "validation/proxmox/desktop/helpers/device-auth.sh",
  "validation/proxmox/desktop/helpers/nelos-archive-control",
  "validation/proxmox/desktop/helpers/nelos-atspi-control",
  "validation/proxmox/desktop/helpers/nelos-bind-runtime",
  "validation/proxmox/desktop/helpers/nelos-credential-boundary",
  "validation/proxmox/desktop/helpers/nelos-desktop-archive.mjs",
  "validation/proxmox/desktop/helpers/nelos-desktop-atspi.mjs",
  "validation/proxmox/desktop/helpers/nelos-device-auth-controller.mjs",
  "validation/proxmox/desktop/helpers/nelos-desktop-identity.py",
  "validation/proxmox/desktop/helpers/nelos-guest-task-control.mjs",
  "validation/proxmox/desktop/recipe-v1/check-gui-readiness.sh",
  "validation/proxmox/desktop/recipe-v1/nelos-accessibility.desktop",
  "validation/proxmox/desktop/recipe-v1/nelos-codex-desktop.service",
  "validation/proxmox/desktop/recipe-v1/nelos-desktop-session.service",
  "validation/proxmox/desktop/recipe-v1/nelos-device-auth.service",
]);

export class GoldenImageBuildError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "GoldenImageBuildError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) { throw new GoldenImageBuildError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, path) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${path} fields differ from the closed contract`);
  return value;
}
function integer(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("INVALID_CONTRACT", `${path} is outside its integer bound`);
  return value;
}
function boundedText(value, path, pattern, maximum = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail("INVALID_CONTRACT", `${path} is invalid`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  fail("INVALID_CONTRACT", "value cannot be represented canonically");
}

export function canonicalJsonV1(value) { return JSON.stringify(canonicalValue(value)); }
export function sha256V1(value) { return `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJsonV1(value)).digest("hex")}`; }

function validateApiUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("INVALID_RESERVATION", "reservation API URL is invalid"); }
  if (url.toString().replace(/\/$/u, "") !== PROXMOX_API_URL || value !== PROXMOX_API_URL) {
    fail("INVALID_RESERVATION", "reservation API must use the literal CA-pinned Proxmox endpoint");
  }
  return PROXMOX_API_URL;
}

export function validateGoldenImageReservationV1(value, { now = Date.now(), allowExpiredForCleanup = false } = {}) {
  if (typeof allowExpiredForCleanup !== "boolean") fail("INVALID_CONTRACT", "cleanup validation mode is invalid");
  exact(value, [
    "apiUrl", "attestorTokenId", "buildNonce", "buildTokenId", "cleanupExpiresAt", "expiresAt", "maxBuildMs", "networkAclPath", "node", "outputTemplate", "providerId",
    "reservationId", "schemaVersion", "sourceArtifact", "sourceCommit", "sourceTemplate", "storage", "tlsCaDigest", "volumeAttestor",
  ], "reservation");
  if (value.schemaVersion !== 2) fail("INVALID_RESERVATION", "reservation schema is unsupported");
  boundedText(value.reservationId, "reservation.reservationId", ID);
  boundedText(value.providerId, "reservation.providerId", ID);
  if (value.providerId !== PROVIDER_ID) fail("INVALID_RESERVATION", "reservation provider differs from the production Proxmox identity");
  boundedText(value.buildNonce, "reservation.buildNonce", NONCE, 32);
  boundedText(value.node, "reservation.node", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  boundedText(value.storage, "reservation.storage", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  boundedText(value.sourceCommit, "reservation.sourceCommit", GIT_OBJECT);
  boundedText(value.buildTokenId, "reservation.buildTokenId", TOKEN_ID);
  boundedText(value.attestorTokenId, "reservation.attestorTokenId", TOKEN_ID);
  if (value.buildTokenId === value.attestorTokenId || value.buildTokenId.split("!", 1)[0] === value.attestorTokenId.split("!", 1)[0]) {
    fail("INDEPENDENT_ATTESTOR_REQUIRED", "build and attestation users and token identities must differ");
  }
  const apiUrl = validateApiUrl(value.apiUrl);
  if (value.tlsCaDigest !== PROXMOX_TLS_CA_DIGEST) fail("INVALID_RESERVATION", "reservation TLS CA differs from the pinned Proxmox authority");
  if (value.networkAclPath !== "/sdn/zones/nelosbld/nelosbld") {
    fail("INVALID_RESERVATION", "reservation VNet ACL path differs from the observed Proxmox ACL identity");
  }
  exact(value.sourceArtifact, ["digest", "name", "signatureFingerprint", "signatureScheme"], "reservation.sourceArtifact");
  if (value.sourceArtifact.name !== "ubuntu-24.04-server-cloudimg-amd64.img" ||
      value.sourceArtifact.digest !== "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe" ||
      value.sourceArtifact.signatureScheme !== "openpgp-detached-sha256sums" ||
      value.sourceArtifact.signatureFingerprint !== "843938DF228D22F7B3742BC0D94AA3F0EFE21092") {
    fail("INVALID_RESERVATION", "source artifact differs from the immutable Ubuntu lock");
  }
  exact(value.volumeAttestor, ["helperDigest", "hostKeyFingerprint", "identityFingerprint", "sshHost", "sshPort", "sshUser"], "reservation.volumeAttestor");
  boundedText(value.volumeAttestor.sshHost, "reservation.volumeAttestor.sshHost", /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u, 253);
  boundedText(value.volumeAttestor.sshUser, "reservation.volumeAttestor.sshUser", /^[a-z_][a-z0-9_-]{0,31}$/u, 32);
  integer(value.volumeAttestor.sshPort, "reservation.volumeAttestor.sshPort", 1, 65_535);
  if (!SSH_FINGERPRINT.test(value.volumeAttestor.hostKeyFingerprint) || !SSH_FINGERPRINT.test(value.volumeAttestor.identityFingerprint) ||
      !SHA256.test(value.volumeAttestor.helperDigest)) fail("INVALID_RESERVATION", "volume attestor identity is invalid");
  exact(value.sourceTemplate, ["configDigest", "name", "vmId", "volumeMeasurementDigest"], "reservation.sourceTemplate");
  exact(value.outputTemplate, ["macAddress", "name", "vmId"], "reservation.outputTemplate");
  const sourceVmid = integer(value.sourceTemplate.vmId, "reservation.sourceTemplate.vmId", 100, 999_999_999);
  const outputVmid = integer(value.outputTemplate.vmId, "reservation.outputTemplate.vmId", 100, 999_999_999);
  if (sourceVmid !== SOURCE_TEMPLATE_VMID || outputVmid !== OUTPUT_TEMPLATE_VMID) {
    fail("INVALID_RESERVATION", "reservation must use fixed source 9024 and output 9027 VMIDs");
  }
  boundedText(value.sourceTemplate.name, "reservation.sourceTemplate.name", DNS_LABEL, 63);
  boundedText(value.outputTemplate.name, "reservation.outputTemplate.name", DNS_LABEL, 63);
  if (value.outputTemplate.name !== OUTPUT_NAME) fail("INVALID_RESERVATION", "output template name differs from the immutable HCL recipe");
  boundedText(value.outputTemplate.macAddress, "reservation.outputTemplate.macAddress", MAC_ADDRESS, 17);
  if (value.outputTemplate.macAddress !== OUTPUT_MAC_ADDRESS) fail("INVALID_RESERVATION", "output template MAC differs from the reserved production identity");
  if (!SHA256.test(value.sourceTemplate.configDigest)) fail("INVALID_RESERVATION", "source template configuration digest is invalid");
  if (!SHA256.test(value.sourceTemplate.volumeMeasurementDigest)) fail("INVALID_RESERVATION", "source template volume measurement digest is invalid");
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt) || (!allowExpiredForCleanup && expiresAt <= now) || expiresAt - now > 86_400_000) fail("EXPIRED_RESERVATION", "reservation must be fresh and bounded to 24 hours");
  const cleanupExpiresAt = Date.parse(value.cleanupExpiresAt);
  if (!Number.isFinite(cleanupExpiresAt) || cleanupExpiresAt <= expiresAt || cleanupExpiresAt - expiresAt > 3_600_000) {
    fail("EXPIRED_RESERVATION", "cleanup expiry must follow active build expiry by at most one hour");
  }
  if (allowExpiredForCleanup && now >= cleanupExpiresAt) fail("EXPIRED_RESERVATION", "cleanup authorization has expired");
  integer(value.maxBuildMs, "reservation.maxBuildMs", 300_000, 7_200_000);
  if (!allowExpiredForCleanup && expiresAt - now < value.maxBuildMs + 120_000) fail("EXPIRED_RESERVATION", "reservation must outlive the complete build budget and reconciliation margin");
  return structuredClone({ ...value, apiUrl });
}

function permissionEntries(value) {
  if (!plain(value)) fail("TOKEN_SCOPE_INVALID", "permission inventory is not an object");
  const entries = [];
  for (const [path, privileges] of Object.entries(value)) {
    if (!/^\/(?:[A-Za-z0-9._:-]+\/?)*$/u.test(path) || !plain(privileges)) fail("TOKEN_SCOPE_INVALID", "permission path or privilege map is invalid");
    for (const [privilege, granted] of Object.entries(privileges)) {
      if (granted !== 1 && granted !== true) fail("TOKEN_SCOPE_INVALID", "permission inventory contains a non-granted entry");
      entries.push({ path, privilege });
    }
  }
  return entries;
}

export function validateTokenScopeV1(value, { kind, reservation }) {
  const allowed = kind === "build" ? BUILD_PRIVILEGES : kind === "attest" ? ATTEST_PRIVILEGES : null;
  if (!allowed) fail("TOKEN_SCOPE_INVALID", "token scope kind is invalid");
  const expectedPairs = kind === "build" ? new Map([
    [`/nodes/${reservation.node}`, new Set(["Sys.Audit"])],
    [`/storage/${reservation.storage}`, new Set(["Datastore.AllocateSpace", "Datastore.Audit"])],
    [`/vms/${reservation.sourceTemplate.vmId}`, new Set(["VM.Audit", "VM.Clone"])],
    [`/vms/${reservation.outputTemplate.vmId}`, new Set([...BUILD_PRIVILEGES].filter((item) => item.startsWith("VM.") && item !== "VM.Clone"))],
    [reservation.networkAclPath, new Set(["SDN.Use"])],
  ]) : new Map([
    [`/nodes/${reservation.node}`, new Set(["Sys.Audit"])],
    [`/storage/${reservation.storage}`, new Set(["Datastore.Audit"])],
    [`/vms/${reservation.sourceTemplate.vmId}`, new Set(["VM.Audit"])],
    [`/vms/${reservation.outputTemplate.vmId}`, new Set(["VM.Audit"])],
  ]);
  const entries = permissionEntries(value);
  if (entries.length === 0 || entries.some(({ path, privilege }) => !expectedPairs.get(path)?.has(privilege) || !allowed.has(privilege))) {
    fail("TOKEN_SCOPE_INVALID", `${kind} token has an unapproved path or privilege`);
  }
  const observedPairs = new Set(entries.map(({ path, privilege }) => `${path}\0${privilege}`));
  for (const [path, privileges] of expectedPairs) for (const privilege of privileges) {
    if (!observedPairs.has(`${path}\0${privilege}`)) fail("TOKEN_SCOPE_INVALID", `${kind} token lacks ${privilege} on ${path}`);
  }
  if (kind === "build" && !entries.some(({ path, privilege }) => path === reservation.networkAclPath && privilege === "SDN.Use")) {
    fail("TOKEN_SCOPE_INVALID", "build token lacks SDN.Use on the exact nelosbld VNet");
  }
  if (kind === "attest" && entries.some(({ path }) => path === reservation.networkAclPath)) fail("TOKEN_SCOPE_INVALID", "attestor token must not have VNet use permission");
  if (kind === "attest" && entries.some(({ privilege }) => !ATTEST_PRIVILEGES.has(privilege))) fail("TOKEN_SCOPE_INVALID", "attestor token is not read-only");
  return true;
}

function vmIdentity(resource) {
  return plain(resource) && Number.isSafeInteger(Number(resource.vmid)) ? {
    vmId: Number(resource.vmid), name: resource.name, node: resource.node, template: Number(resource.template ?? 0), type: resource.type,
  } : null;
}

function exactInventoryVm(inventory, expected, label) {
  if (!Array.isArray(inventory)) fail("PROVIDER_RESPONSE_INVALID", "cluster inventory is not an array");
  const matches = inventory.map(vmIdentity).filter(Boolean).filter(({ vmId }) => vmId === expected.vmId);
  if (matches.length !== 1 || matches[0].name !== expected.name || matches[0].node !== expected.node || matches[0].template !== 1 || matches[0].type !== "qemu") {
    fail("IDENTITY_MISMATCH", `${label} VMID, name, node, type, or template state differs`);
  }
  return matches[0];
}

function noOutputCollision(inventory, reservation) {
  if (!Array.isArray(inventory)) fail("PROVIDER_RESPONSE_INVALID", "cluster inventory is not an array");
  if (inventory.some((resource) => Number(resource?.vmid) === reservation.outputTemplate.vmId || resource?.name === reservation.outputTemplate.name)) {
    fail("OUTPUT_COLLISION", "reserved output VMID or name is already present cluster-wide");
  }
}

function validateSourceConfig(config, reservation) {
  if (!plain(config) || config.name !== reservation.sourceTemplate.name || Number(config.template) !== 1) fail("SOURCE_IDENTITY_MISMATCH", "source template configuration identity differs");
  if (sha256V1(config) !== reservation.sourceTemplate.configDigest) fail("SOURCE_IDENTITY_MISMATCH", "source template configuration digest differs from the reservation");
  for (const key of FORBIDDEN_CONFIG_KEYS) if (Object.hasOwn(config, key)) fail("SOURCE_IDENTITY_MISMATCH", `source template contains forbidden ${key}`);
  if ([config.scsi0, config.efidisk0].some((disk) => diskStorage(disk) !== reservation.storage)) {
    fail("SOURCE_IDENTITY_MISMATCH", "source persistent disks are not on the exact reserved node-local storage");
  }
}

function validateStorage(storageConfig, storageStatus, reservation) {
  if (!plain(storageConfig) || !["dir", "lvm", "lvmthin", "zfspool"].includes(storageConfig.type) || Number(storageConfig.shared ?? 0) !== 0 ||
      !String(storageConfig.content ?? "").split(",").includes("images") ||
      (storageConfig.nodes !== undefined && !String(storageConfig.nodes).split(",").includes(reservation.node))) {
    fail("STORAGE_IDENTITY_MISMATCH", "reserved storage type, locality, content, or node restriction differs");
  }
  if (!plain(storageStatus) || Number(storageStatus.active) !== 1 || Number(storageStatus.enabled) !== 1) fail("STORAGE_IDENTITY_MISMATCH", "reserved storage is not active and enabled");
}

function noOutputVolumes(storageContent, reservation) {
  if (!Array.isArray(storageContent)) fail("PROVIDER_RESPONSE_INVALID", "storage content inventory is not an array");
  const vmid = String(reservation.outputTemplate.vmId);
  if (storageContent.some((item) => Number(item?.vmid) === reservation.outputTemplate.vmId ||
      (typeof item?.volid === "string" && new RegExp(`(?:^|[:/])(?:base|vm)-${vmid}-`, "u").test(item.volid)))) {
    fail("OUTPUT_COLLISION", "reserved output VMID already has a volume on the reserved storage");
  }
}

export function validateGoldenImagePreflightV1(snapshot, reservation, { permissionKind = "build" } = {}) {
  exact(snapshot, ["buildPermissions", "inventory", "proxmoxVersion", "sourceConfig", "sourcePending", "sourceStatus", "storageConfig", "storageContent", "storageStatus"], "preflight");
  if (typeof snapshot.proxmoxVersion !== "string" || !/^8\.4\.[0-9]+/u.test(snapshot.proxmoxVersion)) fail("PROVIDER_VERSION_MISMATCH", "Proxmox VE must remain within the pinned 8.4 compatibility line");
  validateTokenScopeV1(snapshot.buildPermissions, { kind: permissionKind, reservation });
  exactInventoryVm(snapshot.inventory, { ...reservation.sourceTemplate, node: reservation.node }, "source template");
  if (snapshot.inventory.filter((item) => item?.name === reservation.sourceTemplate.name).length !== 1) fail("SOURCE_IDENTITY_MISMATCH", "source template name is not unique cluster-wide");
  noOutputCollision(snapshot.inventory, reservation);
  noOutputVolumes(snapshot.storageContent, reservation);
  validateSourceConfig(snapshot.sourceConfig, reservation);
  if (!plain(snapshot.sourceStatus) || snapshot.sourceStatus.status !== "stopped") fail("SOURCE_IDENTITY_MISMATCH", "source template must be stopped");
  if (!Array.isArray(snapshot.sourcePending) || snapshot.sourcePending.some((entry) => plain(entry) && (Object.hasOwn(entry, "pending") || Object.hasOwn(entry, "delete")))) {
    fail("SOURCE_IDENTITY_MISMATCH", "source template has pending configuration changes");
  }
  validateStorage(snapshot.storageConfig, snapshot.storageStatus, reservation);
  return true;
}

function splitOptions(value) { return typeof value === "string" ? value.split(",") : []; }
function splitTags(value) { return typeof value === "string" ? value.split(";").filter(Boolean) : []; }
function fixedNumber(value, expected) { return Number(value) === expected; }
export function goldenOwnershipV1(reservation) { return `nelos-golden-v1:${reservation.buildNonce}`; }

function diskStorage(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*:[^,\s]+(?:,[^\r\n]*)?$/u.test(value)) return null;
  return value.slice(0, value.indexOf(":"));
}

function persistentVolumes(config) {
  if (!plain(config)) fail("VOLUME_MEASUREMENT_INVALID", "VM configuration is unavailable for volume measurement");
  const entries = Object.entries(config)
    .filter(([key]) => /^(?:efidisk|ide|sata|scsi|virtio)[0-9]+$/u.test(key))
    .map(([diskKey, value]) => ({ diskKey, volumeId: typeof value === "string" ? value.split(",", 1)[0] : null }))
    .filter(({ volumeId }) => volumeId && !volumeId.endsWith(":cloudinit"))
    .sort((left, right) => left.diskKey < right.diskKey ? -1 : left.diskKey > right.diskKey ? 1 : 0);
  if (entries.length < 1 || entries.some(({ volumeId }) => !VOLUME_ID.test(volumeId))) {
    fail("VOLUME_MEASUREMENT_INVALID", "VM persistent volume assignments are missing or unsupported");
  }
  if (new Set(entries.map(({ volumeId }) => volumeId)).size !== entries.length) fail("VOLUME_MEASUREMENT_INVALID", "VM persistent volume assignments are ambiguous");
  return entries;
}

function volumeMeasurementContent(value) {
  return canonicalValue({
    schemaVersion: value.schemaVersion,
    providerId: value.providerId,
    node: value.node,
    storage: value.storage,
    vmId: value.vmId,
    name: value.name,
    role: value.role,
    status: value.status,
    configDigest: value.configDigest,
    helperDigest: value.helperDigest,
    attestorFingerprint: value.attestorFingerprint,
    volumes: value.volumes,
  });
}

export function validateVolumeMeasurementV1(value, reservation, { role, config }) {
  exact(value, [
    "attestorFingerprint", "configDigest", "contentDigest", "helperDigest", "measuredAt", "name", "node", "providerId", "role", "schemaVersion",
    "status", "storage", "vmId", "volumes",
  ], "volumeMeasurement");
  if (value.schemaVersion !== 1 || value.role !== role || value.status !== "stopped" || value.providerId !== reservation.providerId ||
      value.node !== reservation.node || value.storage !== reservation.storage || value.vmId !== (role === "source" ? reservation.sourceTemplate.vmId : reservation.outputTemplate.vmId) ||
      value.name !== (role === "source" ? reservation.sourceTemplate.name : reservation.outputTemplate.name) || value.configDigest !== sha256V1(config) ||
      value.helperDigest !== reservation.volumeAttestor.helperDigest || value.attestorFingerprint !== reservation.volumeAttestor.identityFingerprint ||
      !Number.isFinite(Date.parse(value.measuredAt))) fail("VOLUME_MEASUREMENT_INVALID", `${role} volume measurement identity differs`);
  const expected = persistentVolumes(config);
  if (!Array.isArray(value.volumes) || value.volumes.length !== expected.length) fail("VOLUME_MEASUREMENT_INVALID", `${role} volume measurement set differs`);
  for (let index = 0; index < expected.length; index += 1) {
    const volume = value.volumes[index];
    exact(volume, ["byteLength", "digest", "diskKey", "volumeId"], `volumeMeasurement.volumes[${index}]`);
    if (volume.diskKey !== expected[index].diskKey || volume.volumeId !== expected[index].volumeId || !SHA256.test(volume.digest) ||
        !Number.isSafeInteger(volume.byteLength) || volume.byteLength < 1 || volume.byteLength > 274_877_906_944) {
      fail("VOLUME_MEASUREMENT_INVALID", `${role} volume measurement entry differs`);
    }
  }
  const contentDigest = sha256V1(volumeMeasurementContent(value));
  if (value.contentDigest !== contentDigest) fail("VOLUME_MEASUREMENT_INVALID", `${role} volume measurement content digest differs`);
  if (role === "source" && value.contentDigest !== reservation.sourceTemplate.volumeMeasurementDigest) {
    fail("SOURCE_VOLUME_MISMATCH", "source volume bytes differ from the reserved measurement");
  }
  return canonicalValue(value);
}

export function validateGoldenImageOutputV1(snapshot, reservation) {
  exact(snapshot, ["config", "inventory", "pending", "status"], "output");
  exactInventoryVm(snapshot.inventory, { ...reservation.outputTemplate, node: reservation.node }, "output template");
  const config = snapshot.config;
  if (!plain(config)) fail("OUTPUT_ATTESTATION_FAILED", "output configuration is not an object");
  for (const key of FORBIDDEN_CONFIG_KEYS) if (Object.hasOwn(config, key)) fail("OUTPUT_ATTESTATION_FAILED", `output contains forbidden ${key}`);
  const networkKeys = Object.keys(config).filter((key) => /^net[0-9]+$/u.test(key)).sort();
  const ipConfigKeys = Object.keys(config).filter((key) => /^ipconfig[0-9]+$/u.test(key)).sort();
  const diskKeys = Object.keys(config).filter((key) => /^(?:efidisk|ide|sata|scsi|virtio)[0-9]+$/u.test(key)).sort();
  const network = splitOptions(config.net0);
  const cloudInit = splitOptions(config.ide2);
  const macs = network.filter((item) => /^virtio=[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/u.test(item));
  if (!/^[0-9a-f]{40}$/u.test(config.digest) || config.name !== reservation.outputTemplate.name || Number(config.template) !== 1 ||
      !fixedNumber(config.cores, 4) || !fixedNumber(config.sockets, 1) ||
      !fixedNumber(config.memory, 8192) || !["x86-64-v2-AES", "cputype=x86-64-v2-AES"].includes(config.cpu) || config.machine !== "q35" ||
      config.bios !== "ovmf" || config.scsihw !== "virtio-scsi-single" || config.vga !== "virtio" ||
      (config.onboot !== undefined && Number(config.onboot) !== 0) || (config.protection !== undefined && Number(config.protection) !== 0) ||
      !splitOptions(config.agent).includes("enabled=1") || config.ciuser !== "ubuntu" || config.ipconfig0 !== "ip=dhcp" ||
      config.description !== goldenOwnershipV1(reservation) ||
      splitTags(config.tags).sort().join("\0") !== ["nelos-golden", `nelos-build-${reservation.buildNonce}`].sort().join("\0") ||
      networkKeys.join("\0") !== "net0" || ipConfigKeys.join("\0") !== "ipconfig0" || network.length < 3 || macs.length !== 1 ||
      !network.includes(`virtio=${reservation.outputTemplate.macAddress}`) ||
      !network.includes("bridge=nelosbld") || !network.includes("firewall=1") || cloudInit[0]?.split(":")[0] !== reservation.storage || !cloudInit.includes("media=cdrom") ||
      !diskKeys.includes("scsi0") || !diskKeys.includes("efidisk0") || !diskKeys.includes("ide2") ||
      [config.scsi0, config.efidisk0, config.ide2].some((disk) => diskStorage(disk) !== reservation.storage) ||
      diskKeys.some((key) => !["efidisk0", "ide2", "scsi0"].includes(key))) {
    fail("OUTPUT_ATTESTATION_FAILED", "output configuration differs from the immutable Desktop recipe");
  }
  if (!plain(snapshot.status) || snapshot.status.status !== "stopped") fail("OUTPUT_ATTESTATION_FAILED", "output template is not stopped");
  if (!Array.isArray(snapshot.pending) || snapshot.pending.some((entry) => plain(entry) && (Object.hasOwn(entry, "pending") || Object.hasOwn(entry, "delete")))) {
    fail("OUTPUT_ATTESTATION_FAILED", "output template has pending configuration changes");
  }
  return true;
}

function decodePackerField(value) { return value.replaceAll("%!(PACKER_COMMA)", ",").replaceAll("\\n", "\n").replaceAll("\\r", "\r"); }

export function parsePackerArtifactV1(text, reservation) {
  if (typeof text !== "string" || Buffer.byteLength(text) < 1 || Buffer.byteLength(text) > MAX_MACHINE_OUTPUT || text.includes("\0")) fail("PACKER_RECEIPT_INVALID", "Packer machine output is missing or oversized");
  const records = [];
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const fields = line.split(",").map(decodePackerField);
    if (fields.length < 3 || !/^[0-9]{9,12}$/u.test(fields[0])) fail("PACKER_RECEIPT_INVALID", "Packer machine output framing is invalid");
    records.push({ target: fields[1], type: fields[2], data: fields.slice(3) });
  }
  const count = records.filter(({ type }) => type === "artifact-count");
  const allArtifacts = records.filter(({ type }) => type === "artifact");
  const artifacts = allArtifacts.filter(({ target, data }) => target === PACKER_TARGET && data[0] === "0");
  const field = (key) => artifacts.filter(({ data }) => data[1] === key).map(({ data }) => data[2]);
  const builderIds = field("builder-id"); const ids = field("id"); const filesCounts = field("files-count");
  const ends = artifacts.filter(({ data }) => data.length === 2 && data[1] === "end");
  if (count.length !== 1 || count[0].target !== PACKER_TARGET || count[0].data.length !== 1 || count[0].data[0] !== "1" ||
      allArtifacts.length !== artifacts.length || artifacts.some(({ data }) => data.length < 2 || !["builder-id", "end", "files-count", "id", "string"].includes(data[1])) ||
      builderIds.length !== 1 || builderIds[0] !== PACKER_BUILDER_ID || filesCounts.length !== 1 || filesCounts[0] !== "0" ||
      ids.length !== 1 || ids[0] !== String(reservation.outputTemplate.vmId) || ends.length !== 1) {
    fail("PACKER_RECEIPT_INVALID", "Packer did not emit one exact Proxmox clone artifact");
  }
  return { target: PACKER_TARGET, builderId: PACKER_BUILDER_ID, artifactId: ids[0], machineOutputDigest: sha256V1(text) };
}

export function proveExactBuildOwnershipV1({ artifact, snapshot, reservation }) {
  try {
    if (artifact?.target !== PACKER_TARGET || artifact?.builderId !== PACKER_BUILDER_ID || artifact?.artifactId !== String(reservation.outputTemplate.vmId)) return false;
    const identity = exactInventoryVm(snapshot?.inventory, { ...reservation.outputTemplate, node: reservation.node }, "cleanup output");
    return identity.vmId === reservation.outputTemplate.vmId && snapshot?.config?.name === reservation.outputTemplate.name &&
      Number(snapshot?.config?.template) === 1 && snapshot?.config?.description === goldenOwnershipV1(reservation) &&
      splitTags(snapshot?.config?.tags).includes(`nelos-build-${reservation.buildNonce}`);
  } catch { return false; }
}

export function createGoldenImageAttestationV1({ reservation, immutableInputs, builderOutput, attestorOutput, sourceConfig, sourceVolumeMeasurement, outputVolumeMeasurement, artifact, observedAt }) {
  validateGoldenImageOutputV1(builderOutput, reservation);
  validateGoldenImageOutputV1(attestorOutput, reservation);
  if (canonicalJsonV1(builderOutput) !== canonicalJsonV1(attestorOutput)) fail("INDEPENDENT_ATTESTATION_FAILED", "builder and independent attestor observed different output state");
  const sourceMeasurement = validateVolumeMeasurementV1(sourceVolumeMeasurement, reservation, { role: "source", config: sourceConfig });
  const outputMeasurement = validateVolumeMeasurementV1(outputVolumeMeasurement, reservation, { role: "output", config: attestorOutput.config });
  exact(immutableInputs, ["candidateArchiveDigest", "candidateDigest", "packageLockDigest", "packerHclDigest", "recipeDigest", "sourceCommit", "sourceInputsDigest", "toolchainLockDigest", "wrapperDigest"], "immutableInputs");
  for (const [key, digest] of Object.entries(immutableInputs)) {
    if (key === "sourceCommit") { if (digest !== reservation.sourceCommit) fail("SOURCE_REVISION_MISMATCH", "attested source commit differs from the reservation"); }
    else if (!SHA256.test(digest)) fail("INVALID_CONTRACT", `${key} is not a SHA-256 digest`);
  }
  if (!Number.isFinite(Date.parse(observedAt))) fail("INVALID_CONTRACT", "attestation timestamp is invalid");
  const stableOutputConfig = Object.fromEntries(Object.entries(attestorOutput.config).filter(([key]) => key !== "digest"));
  const contentAddress = {
    schemaVersion: 2,
    domain: "nelos-proxmox-desktop-volume-recipe-config-v2",
    immutableInputs: structuredClone(immutableInputs),
    sourceArtifact: structuredClone(reservation.sourceArtifact),
    sourceTemplate: structuredClone(reservation.sourceTemplate),
    sourceVolumes: volumeMeasurementContent(sourceMeasurement),
    outputConfig: canonicalValue(stableOutputConfig),
    outputVolumes: volumeMeasurementContent(outputMeasurement),
  };
  const content = {
    schemaVersion: 2,
    kind: "nelos-proxmox-desktop-golden-image-v2",
    reservation: {
      reservationId: reservation.reservationId, providerId: reservation.providerId, apiUrl: reservation.apiUrl, node: reservation.node, storage: reservation.storage,
      networkAclPath: reservation.networkAclPath, tlsCaDigest: reservation.tlsCaDigest, sourceArtifact: reservation.sourceArtifact,
      sourceTemplate: reservation.sourceTemplate, outputTemplate: reservation.outputTemplate, volumeAttestor: reservation.volumeAttestor,
    },
    immutableInputs: structuredClone(immutableInputs),
    buildArtifact: structuredClone(artifact),
    output: {
      config: canonicalValue(stableOutputConfig),
      configDigest: sha256V1(stableOutputConfig),
      providerConfigDigest: attestorOutput.config.digest ?? null,
      status: "stopped",
      template: true,
    },
    volumeAttestation: {
      source: sourceMeasurement,
      output: outputMeasurement,
    },
  };
  const goldenImageDigest = sha256V1(contentAddress);
  const unsigned = {
    ...content,
    goldenImage: {
      algorithm: "nelos-proxmox-desktop-volume-recipe-config-v2", imageId: reservation.outputTemplate.name,
      templateVmId: String(reservation.outputTemplate.vmId), digest: goldenImageDigest,
    },
    independentAttestation: { tokenId: reservation.attestorTokenId, volumeAttestorFingerprint: reservation.volumeAttestor.identityFingerprint, observedAt },
  };
  return { ...unsigned, attestationDigest: sha256V1(unsigned) };
}

async function readBuildSnapshot(api, reservation, { includePermissions = false } = {}) {
  const [version, inventory, sourceConfig, sourceStatus, sourcePending, storageConfig, storageStatus, storageContent, buildPermissions] = await Promise.all([
    api.version(), api.inventory(), api.config(reservation.sourceTemplate.vmId), api.status(reservation.sourceTemplate.vmId),
    api.pending(reservation.sourceTemplate.vmId), api.storageConfig(), api.storageStatus(), api.storageContent(),
    includePermissions ? api.permissions() : Promise.resolve(null),
  ]);
  return { proxmoxVersion: version, inventory, sourceConfig, sourcePending, sourceStatus, storageConfig, storageContent, storageStatus, buildPermissions };
}

async function readOutputSnapshot(api, reservation) {
  const [inventory, config, status, pending] = await Promise.all([
    api.inventory(), api.config(reservation.outputTemplate.vmId), api.status(reservation.outputTemplate.vmId), api.pending(reservation.outputTemplate.vmId),
  ]);
  return { inventory, config, status, pending };
}

export async function runGoldenImageBuildV1({ reservation: rawReservation, immutableInputs, builderApi, attestorApi, volumeAttestor, packer, receiptStore, journal, clock = Date }) {
  const reservation = validateGoldenImageReservationV1(rawReservation, { now: clock.now() });
  if (![builderApi, attestorApi].every((api) => api && ["version", "inventory", "config", "status", "pending", "storageConfig", "storageStatus", "storageContent", "permissions"].every((name) => typeof api[name] === "function")) ||
      typeof builderApi.destroyOwned !== "function" || typeof volumeAttestor?.measure !== "function" || typeof packer?.build !== "function" || typeof receiptStore?.commit !== "function" ||
      typeof journal?.record !== "function") fail("INVALID_ADAPTER", "golden-image adapters are incomplete");
  const preflight = await readBuildSnapshot(builderApi, reservation, { includePermissions: true });
  validateGoldenImagePreflightV1(preflight, reservation);
  const independentPreflight = await readBuildSnapshot(attestorApi, reservation, { includePermissions: true });
  validateGoldenImagePreflightV1(independentPreflight, reservation, { permissionKind: "attest" });
  const sourceVolumeMeasurement = validateVolumeMeasurementV1(await volumeAttestor.measure({
    role: "source", vmId: reservation.sourceTemplate.vmId, name: reservation.sourceTemplate.name, configDigest: sha256V1(preflight.sourceConfig),
  }), reservation, { role: "source", config: preflight.sourceConfig });
  await journal.record("preflighted", { reservationId: reservation.reservationId });
  const repeatedPreflight = await readBuildSnapshot(builderApi, reservation, { includePermissions: true });
  validateGoldenImagePreflightV1(repeatedPreflight, reservation);
  if (sha256V1(preflight) !== sha256V1(repeatedPreflight)) fail("PREFLIGHT_DRIFT", "source, storage, permissions, or cluster inventory changed before mutation");
  const repeatedSourceMeasurement = validateVolumeMeasurementV1(await volumeAttestor.measure({
    role: "source", vmId: reservation.sourceTemplate.vmId, name: reservation.sourceTemplate.name, configDigest: sha256V1(repeatedPreflight.sourceConfig),
  }), reservation, { role: "source", config: repeatedPreflight.sourceConfig });
  if (sourceVolumeMeasurement.contentDigest !== repeatedSourceMeasurement.contentDigest) fail("PREFLIGHT_DRIFT", "source volume bytes changed before mutation");
  validateGoldenImageReservationV1(reservation, { now: clock.now() });

  const attempt = Number.isSafeInteger(journal.attempt) && journal.attempt > 0 ? journal.attempt : 1;
  const operationId = sha256V1({ kind: "nelos-golden-packer-operation-v1", reservationDigest: sha256V1(reservation), attempt });
  let artifact = null; let ownedSnapshot = null; let mutationStarted = false; let attested = false; let receiptCommitted = false;
  try {
    await journal.record("mutation-started", {
      attempt, operationId, outputVmId: reservation.outputTemplate.vmId, ownership: goldenOwnershipV1(reservation), startedAt: new Date(clock.now()).toISOString(),
    });
    mutationStarted = true;
    const built = await packer.build({ reservation, immutableInputs, operationId });
    if (!plain(built) || typeof built.machineOutput !== "string" || !Number.isSafeInteger(built.exitCode)) fail("PACKER_BUILD_FAILED", "Packer build did not return a bounded result");
    try { artifact = parsePackerArtifactV1(built.machineOutput, reservation); } catch (error) {
      if (built.exitCode === 0) throw error;
    }
    await journal.record("packer-exited", {
      attempt, operationId, exitCode: built.exitCode, artifact: artifact ? structuredClone(artifact) : null,
      machineOutputDigest: sha256V1(built.machineOutput),
    });
    if (built.exitCode !== 0) fail("PACKER_BUILD_FAILED", "Packer build did not reach a successful bounded exit");
    if (!artifact) fail("PACKER_RECEIPT_INVALID", "successful Packer build did not emit its one exact artifact receipt");
    ownedSnapshot = await readOutputSnapshot(builderApi, reservation);
    if (!proveExactBuildOwnershipV1({ artifact, snapshot: ownedSnapshot, reservation })) fail("OWNERSHIP_UNPROVEN", "Packer artifact cannot be bound to the reserved output");
    validateGoldenImageOutputV1(ownedSnapshot, reservation);
    const attestorOutput = await readOutputSnapshot(attestorApi, reservation);
    validateGoldenImageOutputV1(attestorOutput, reservation);
    const [finalSourceMeasurement, outputVolumeMeasurement] = await Promise.all([
      volumeAttestor.measure({ role: "source", vmId: reservation.sourceTemplate.vmId, name: reservation.sourceTemplate.name, configDigest: sha256V1(preflight.sourceConfig) }),
      volumeAttestor.measure({ role: "output", vmId: reservation.outputTemplate.vmId, name: reservation.outputTemplate.name, configDigest: sha256V1(attestorOutput.config) }),
    ]);
    const validatedFinalSource = validateVolumeMeasurementV1(finalSourceMeasurement, reservation, { role: "source", config: preflight.sourceConfig });
    const validatedOutput = validateVolumeMeasurementV1(outputVolumeMeasurement, reservation, { role: "output", config: attestorOutput.config });
    if (validatedFinalSource.contentDigest !== sourceVolumeMeasurement.contentDigest) fail("SOURCE_VOLUME_MISMATCH", "source volume bytes changed during the build");
    const receipt = createGoldenImageAttestationV1({
      reservation, immutableInputs, builderOutput: ownedSnapshot, attestorOutput, sourceConfig: preflight.sourceConfig,
      sourceVolumeMeasurement: validatedFinalSource, outputVolumeMeasurement: validatedOutput, artifact, observedAt: new Date(clock.now()).toISOString(),
    });
    attested = true;
    await journal.record("attested", { attempt, operationId, receipt });
    await receiptStore.commit(receipt);
    receiptCommitted = true;
    await journal.record("committed", { attestationDigest: receipt.attestationDigest, goldenImageDigest: receipt.goldenImage.digest });
    return receipt;
  } catch (error) {
    if (!mutationStarted) throw error;
    if (receiptCommitted || attested) {
      await journal.record("reconciliation-required", { causeCode: error?.code ?? "BUILD_FAILED", preserved: true }).catch(() => {});
      throw new GoldenImageBuildError("RECONCILIATION_REQUIRED", "attested golden image was preserved because receipt finalization is uncertain", {
        causeCode: error?.code ?? "BUILD_FAILED",
      });
    }
    if (artifact && ownedSnapshot) {
      try {
        const freshIndependent = await readOutputSnapshot(attestorApi, reservation);
        if (!proveExactBuildOwnershipV1({ artifact, snapshot: freshIndependent, reservation }) ||
            canonicalJsonV1(freshIndependent) !== canonicalJsonV1(ownedSnapshot)) {
          fail("OWNERSHIP_UNPROVEN", "independent pre-cleanup state no longer matches the exact owned output");
        }
        await journal.record("cleanup-admitted", { outputVmId: reservation.outputTemplate.vmId, configDigest: sha256V1(freshIndependent.config) });
        const cleanup = await builderApi.destroyOwned(reservation.outputTemplate.vmId, artifact);
        if (!plain(cleanup) || cleanup.destroyed !== true || cleanup.absent !== true) fail("CLEANUP_UNPROVEN", "exact output cleanup did not prove terminal absence");
        const [independentInventory, independentStorageContent] = await Promise.all([attestorApi.inventory(), attestorApi.storageContent()]);
        noOutputCollision(independentInventory, reservation);
        noOutputVolumes(independentStorageContent, reservation);
        await journal.record("cleaned", { outputVmId: reservation.outputTemplate.vmId, providerOperationId: cleanup.providerOperationId ?? null });
      } catch (cleanupError) {
        await journal.record("quarantined", { causeCode: error?.code ?? "BUILD_FAILED", cleanupCode: cleanupError?.code ?? "CLEANUP_FAILED" }).catch(() => {});
        throw new GoldenImageBuildError("RECONCILIATION_REQUIRED", "golden-image build failed and exact owned cleanup is unproven", {
          causeCode: error?.code ?? "BUILD_FAILED", cleanupCode: cleanupError?.code ?? "CLEANUP_FAILED",
        });
      }
    } else {
      let observed = "unreadable";
      try {
        const [inventory, storageContent] = await Promise.all([attestorApi.inventory(), attestorApi.storageContent()]);
        noOutputCollision(inventory, reservation);
        noOutputVolumes(storageContent, reservation);
        observed = "absent-at-observation";
      } catch (absenceError) { observed = absenceError?.code ?? "OUTPUT_PRESENT_OR_UNREADABLE"; }
      await journal.record("quarantined", { causeCode: error?.code ?? "BUILD_FAILED", cleanupCode: "OWNERSHIP_UNPROVEN", observed }).catch(() => {});
      throw new GoldenImageBuildError("RECONCILIATION_REQUIRED", "Packer may have left a server-side operation in flight but exact ownership is unproven; no deletion was attempted", {
        causeCode: error?.code ?? "BUILD_FAILED", observation: observed,
      });
    }
    throw error;
  }
}

function cleanEnvironment(extra = {}) {
  return {
    PATH: "/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C", CHECKPOINT_DISABLE: "1", ...extra,
  };
}

function runProcess(executable, args, { input = null, env = cleanEnvironment(), timeoutMs = 30_000, maxOutputBytes = 8_388_608, allowFailure = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env, detached: true });
    const stdout = []; const stderr = []; let outputBytes = 0; let exceeded = false; let timedOut = false;
    const terminate = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { exceeded = true; terminate(); return; }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return rejectPromise(new GoldenImageBuildError("COMMAND_TIMEOUT", "bounded external command timed out"));
      if (exceeded) return rejectPromise(new GoldenImageBuildError("COMMAND_OUTPUT_LIMIT", "bounded external command exceeded its output limit"));
      const result = { exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (!allowFailure && code !== 0) return rejectPromise(new GoldenImageBuildError("COMMAND_FAILED", "bounded external command failed"));
      resolvePromise(result);
    });
    if (input === null) child.stdin.end(); else child.stdin.end(input);
  });
}

async function assertSafeAncestors(path, label, owner = process.getuid()) {
  let current = dirname(path);
  while (true) {
    const info = await lstat(current).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || !new Set([0, owner]).has(info.uid) || (info.mode & 0o022) !== 0 || await realpath(current) !== current) {
      fail("UNSAFE_CONTROLLER_PATH", `${label} ancestor ownership, mode, type, or canonical path differs: ${current}`);
    }
    if (current === "/") break;
    current = dirname(current);
  }
}

async function sealedFile(path, { label, modes, maximum = 67_108_864, owner = process.getuid(), outsideRepository = true } = {}) {
  if (!isAbsolute(path) || !/^\/[A-Za-z0-9._/-]+$/u.test(path)) fail("UNSAFE_CONTROLLER_PATH", `${label} must be a specific absolute path without whitespace`);
  const canonical = await realpath(path).catch(() => null); const info = await lstat(path).catch(() => null);
  if (!canonical || canonical !== path || !info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximum ||
      !modes.has(info.mode & 0o777) || !new Set([0, owner]).has(info.uid) || (info.mode & 0o022) !== 0) {
    fail("UNSAFE_CONTROLLER_PATH", `${label} ownership, mode, link count, type, size, or canonical path differs`);
  }
  if (outsideRepository && (canonical === REPOSITORY_ROOT || canonical.startsWith(`${REPOSITORY_ROOT}${sep}`))) fail("UNSAFE_CONTROLLER_PATH", `${label} must be outside the source checkout`);
  await assertSafeAncestors(canonical, label, owner);
  return canonical;
}

async function sealedDirectory(path, label, { create = false } = {}) {
  if (!isAbsolute(path) || !/^\/[A-Za-z0-9._/-]+$/u.test(path) || path === "/") fail("UNSAFE_CONTROLLER_PATH", `${label} must be a specific absolute path`);
  if (create) await mkdir(path, { recursive: false, mode: 0o700 }).catch((error) => { if (error?.code !== "EEXIST") throw error; });
  const canonical = await realpath(path).catch(() => null); const info = await lstat(path).catch(() => null);
  if (!canonical || canonical !== path || !info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 ||
      canonical === REPOSITORY_ROOT || canonical.startsWith(`${REPOSITORY_ROOT}${sep}`) || REPOSITORY_ROOT.startsWith(`${canonical}${sep}`)) {
    fail("UNSAFE_CONTROLLER_PATH", `${label} must be a private canonical controller-owned directory outside the source checkout`);
  }
  await assertSafeAncestors(canonical, label);
  return canonical;
}

async function git(args, options = {}) {
  return runProcess("/usr/bin/git", [
    "--no-replace-objects", "--literal-pathspecs", "--no-optional-locks", "-c", "core.useReplaceRefs=false", "-c", "core.attributesFile=/dev/null",
    "-c", "core.commitGraph=false", "-c", "core.multiPackIndex=false", "-c", "core.fsmonitor=false", "-C", REPOSITORY_ROOT, ...args,
  ], { ...options, env: cleanEnvironment({
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_GRAFT_FILE: "/dev/null",
    GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_REF_PARANOIA: "1",
  }) });
}

async function assertSourceRevision(reservation) {
  const top = (await git(["rev-parse", "--show-toplevel"])).stdout.toString("utf8").trim();
  if (await realpath(top) !== REPOSITORY_ROOT) fail("SOURCE_REVISION_MISMATCH", "wrapper path and Git worktree root differ");
  const revision = (await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.toString("utf8").trim();
  if (revision !== reservation.sourceCommit) fail("SOURCE_REVISION_MISMATCH", "worktree HEAD differs from the reservation");
  const commonDirectory = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.toString("utf8").trim();
  const commonInfo = await lstat(commonDirectory).catch(() => null);
  if (!isAbsolute(commonDirectory) || !commonInfo?.isDirectory() || commonInfo.isSymbolicLink() || await realpath(commonDirectory) !== commonDirectory) {
    fail("SOURCE_REVISION_MISMATCH", "Git common directory is not a canonical regular directory");
  }
  for (const control of [join(commonDirectory, "info/grafts"), join(commonDirectory, "objects/info/alternates")]) {
    const info = await lstat(control).catch(() => null);
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size !== 0)) fail("SOURCE_REVISION_MISMATCH", "Git grafts and object alternates are forbidden");
  }
  if ((await git(["for-each-ref", "--format=%(refname)", "refs/replace/"])).stdout.length !== 0) fail("SOURCE_REVISION_MISMATCH", "Git replacement refs are forbidden");
  const configuration = (await git(["config", "--includes", "--name-only", "--list"])).stdout.toString("utf8").toLowerCase();
  if (/^(?:extensions\.partialclone|remote\..*\.(?:promisor|partialclonefilter))$/mu.test(configuration)) {
    fail("SOURCE_REVISION_MISMATCH", "partial-clone and promisor Git configuration is forbidden");
  }
  const statusOutput = (await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout.toString("utf8");
  if (statusOutput) fail("DIRTY_SOURCE", "source checkout must be clean, including untracked files");
  const tree = (await git(["ls-tree", "-r", "-z", "--full-tree", revision, "--"], { maxOutputBytes: 67_108_864 })).stdout.toString("utf8");
  for (const record of tree.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t[^\0]+$/u.exec(record);
    if (!match) fail("SOURCE_REVISION_MISMATCH", "source candidate tree contains a symlink, gitlink, or non-regular tracked entry");
  }
  return revision;
}

async function writeExclusive(path, bytes, mode) {
  const handle = await open(path, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, mode);
}

async function writeAtomicReplace(path, bytes, mode, root) {
  if (!path.startsWith(`${root}${sep}`) || !Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 67_108_864) fail("UNSAFE_CONTROLLER_PATH", "atomic controller output is outside its bounded root");
  const temporary = join(root, `.${randomBytes(16).toString("hex")}.tmp`);
  await writeExclusive(temporary, bytes, mode);
  try {
    await rename(temporary, path);
    const directory = await open(root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function materializeSource(revision, runRoot) {
  const hashes = {};
  for (const sourcePath of SEALED_SOURCE_PATHS_V1) {
    const destination = join(runRoot, "source", sourcePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const record = (await git(["ls-tree", revision, "--", sourcePath])).stdout.toString("utf8").trim();
    const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u.exec(record);
    if (!match || match[3] !== sourcePath) fail("SOURCE_REVISION_MISMATCH", `sealed input is not one exact regular tracked blob: ${sourcePath}`);
    const result = await git(["cat-file", "blob", match[2]], { maxOutputBytes: 33_554_432 });
    await writeExclusive(destination, result.stdout, sourcePath.endsWith(".sh") || sourcePath.endsWith("nelos-bind-runtime") || sourcePath.endsWith("nelos-atspi-control") || sourcePath.endsWith("nelos-archive-control") ? 0o500 : 0o400);
    const materializedObject = (await git(["hash-object", "--no-filters", "--", destination])).stdout.toString("utf8").trim();
    if (materializedObject !== match[2]) fail("SOURCE_REVISION_MISMATCH", `materialized sealed input differs from its Git blob: ${sourcePath}`);
    hashes[sourcePath] = sha256V1(result.stdout);
  }
  const candidateRoot = join(runRoot, "candidate-runtime");
  const candidateManifest = await stageProductionDesktopCandidate({ outputDirectory: candidateRoot, root: REPOSITORY_ROOT, environment: {} });
  if (candidateManifest.sourceRevision !== revision || !SHA256.test(candidateManifest.candidateDigest)) {
    fail("CANDIDATE_INTEGRITY_MISMATCH", "staged production candidate differs from the sealed source revision");
  }
  const candidateArchive = join(runRoot, "source/validation/proxmox-desktop/v1/candidate-runtime.tar");
  await runProcess("/usr/bin/tar", [
    "--sort=name", "--format=posix", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--pax-option=delete=atime,delete=ctime",
    "-C", candidateRoot, "-cf", candidateArchive, ".",
  ], { timeoutMs: 120_000, maxOutputBytes: 1_048_576 });
  const archiveInfo = await lstat(candidateArchive).catch(() => null);
  if (!archiveInfo?.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size < 1 || archiveInfo.size > 268_435_456) {
    fail("CANDIDATE_INTEGRITY_MISMATCH", "candidate runtime archive is missing or oversized");
  }
  const candidateArchiveDigest = sha256V1(await readFile(candidateArchive));
  await chmod(candidateArchive, 0o400);
  await writeExclusive(`${candidateArchive}.sha256`, Buffer.from(`${candidateArchiveDigest.slice(7)}  candidate-runtime.tar\n`), 0o400);
  const recipeEntries = Object.entries(hashes).filter(([path]) => path.includes("/desktop/helpers/") || path.includes("/desktop/recipe-v1/") ||
    path.endsWith("provision-golden-image.sh") || path.endsWith("ubuntu.sources") || path.endsWith("nelos-proxmox-volume-measure.py"));
  return {
    candidateArchiveDigest,
    candidateDigest: candidateManifest.candidateDigest,
    packageLockDigest: hashes["validation/proxmox-desktop/v1/package-lock.json"],
    packerHclDigest: hashes["validation/proxmox-desktop/v1/golden-image.pkr.hcl"],
    recipeDigest: sha256V1(Object.fromEntries(recipeEntries)),
    sourceCommit: revision,
    sourceInputsDigest: sha256V1(hashes),
    toolchainLockDigest: hashes["validation/proxmox/toolchain.lock.json"],
    wrapperDigest: hashes["validation/proxmox-desktop/v1/build-golden-image.mjs"],
  };
}

export function validatePackerSourceV1(text) {
  const required = [
    /required_version\s*=\s*"= 1\.15\.4"/u,
    /version\s*=\s*"= 1\.2\.4"/u,
    /source\s*=\s*"github\.com\/hashicorp\/proxmox"/u,
    /variable\s+"build_nonce"\s*\{\s*type\s*=\s*string\s*validation\s*\{\s*condition\s*=\s*can\(regex\("\^\[0-9a-f\]\{32\}\$",\s*var\.build_nonce\)\)\s*error_message\s*=\s*"build nonce must be exactly 32 lowercase hexadecimal characters"\s*\}\s*\}/su,
    /variable\s+"source_template_vmid"\s*\{[^}]*condition\s*=\s*var\.source_template_vmid\s*==\s*9024[^}]*\}/su,
    /variable\s+"output_template_vmid"\s*\{[^}]*condition\s*=\s*var\.output_template_vmid\s*==\s*9027[^}]*\}/su,
    /clone_vm_id\s*=\s*var\.source_template_vmid/u,
    /vm_id\s*=\s*var\.output_template_vmid/u,
    /variable\s+"output_template_mac"\s*\{[^}]*condition\s*=\s*var\.output_template_mac\s*==\s*"02:4E:45:4C:90:27"[^}]*\}/su,
    new RegExp(`vm_name\\s*=\\s*"${OUTPUT_NAME}"`, "u"),
    new RegExp(`template_name\\s*=\\s*"${OUTPUT_NAME}"`, "u"),
    /node\s*=\s*var\.proxmox_node/u,
    /cloud_init_storage_pool\s*=\s*var\.storage_pool/u,
    /bridge\s*=\s*"nelosbld"/u,
    /mac_address\s*=\s*var\.output_template_mac/u,
    /firewall\s*=\s*true/u,
    /insecure_skip_tls_verify\s*=\s*false/u,
    /ssh_clear_authorized_keys\s*=\s*true/u,
    /source\s*=\s*"\$\{path\.root\}\/ubuntu\.sources"/u,
    /destination\s*=\s*"\/tmp\/nelos-ubuntu\.sources"/u,
    /APT_SOURCES=\/tmp\/nelos-ubuntu\.sources/u,
    /source\s*=\s*"\$\{path\.root\}\/candidate-runtime\.tar"/u,
    /destination\s*=\s*"\/tmp\/candidate-runtime\.tar"/u,
    /CANDIDATE_RUNTIME_ARCHIVE=\/tmp\/candidate-runtime\.tar/u,
    /CANDIDATE_RUNTIME_SHA256=\/tmp\/candidate-runtime\.tar\.sha256/u,
    /template_description\s*=\s*"nelos-golden-v1:\$\{var\.build_nonce\}"/u,
    /tags\s*=\s*"nelos-golden;nelos-build-\$\{var\.build_nonce\}"/u,
    /task_timeout\s*=\s*"30m"/u,
    /ssh_username\s*=\s*"ubuntu"/u,
    /build\s*\{\s*name\s*=\s*"desktop"/su,
  ];
  if (typeof text !== "string" || required.some((pattern) => !pattern.test(text)) ||
      (text.match(/^source\s+"proxmox-clone"\s+"desktop"\s*\{/gmu) ?? []).length !== 1 ||
      (text.match(/^build\s*\{/gmu) ?? []).length !== 1 || /^\s*disks\s*\{/mu.test(text) ||
      /insecure_skip_tls_verify\s*=\s*true/u.test(text) || /ssh_username\s*=\s*var\./u.test(text) ||
      /ssh_(?:private_key_file|password|agent_auth)\s*=/u.test(text) ||
      /^\s*(?:password|proxmox_url|token|username)\s*=/mu.test(text) || /(?:^|\s)-force(?:\s|$)/u.test(text)) {
    fail("PACKER_SOURCE_INVALID", "sealed Packer source lacks the approved fixed identity, ownership marker, timeout, or Desktop recipe");
  }
}

async function readToken(path, label) {
  const bytes = await readFile(await sealedFile(path, { label, modes: new Set([0o400]), maximum: 1024 }));
  const text = bytes.toString("utf8").replace(/\n$/u, "");
  if (!/^[A-Za-z0-9._~-]{20,512}$/u.test(text) || text.includes("\n")) { bytes.fill(0); fail("INVALID_TOKEN", `${label} is malformed`); }
  return { bytes, value: () => bytes.toString("utf8").replace(/\n$/u, ""), erase: () => bytes.fill(0) };
}

async function sshKeyFingerprint(path, label) {
  const result = await runProcess("/usr/bin/ssh-keygen", ["-lf", path, "-E", "sha256"], { timeoutMs: 10_000, maxOutputBytes: 16_384 });
  const lines = result.stdout.toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
  const fields = lines.length === 1 ? lines[0].trim().split(/\s+/u) : [];
  if (fields.length < 4 || !SSH_FINGERPRINT.test(fields[1] ?? "")) fail("VOLUME_ATTESTOR_INVALID", `${label} fingerprint is invalid`);
  return fields[1];
}

class SshVolumeAttestorV1 {
  constructor({ reservation, knownHosts, identityFile }) {
    this.reservation = reservation; this.knownHosts = knownHosts; this.identityFile = identityFile;
  }
  async initialize() {
    const observedHost = await sshKeyFingerprint(this.knownHosts, "volume-attestor known-hosts");
    const observedIdentity = await sshKeyFingerprint(this.identityFile, "volume-attestor identity");
    if (observedHost !== this.reservation.volumeAttestor.hostKeyFingerprint || observedIdentity !== this.reservation.volumeAttestor.identityFingerprint) {
      fail("VOLUME_ATTESTOR_INVALID", "volume-attestor SSH host or principal differs from the reservation");
    }
  }
  async measure({ role, vmId, name, configDigest }) {
    const request = Buffer.from(`${canonicalJsonV1({
      schemaVersion: 1, providerId: this.reservation.providerId, node: this.reservation.node, storage: this.reservation.storage,
      reservationId: this.reservation.reservationId, buildNonce: this.reservation.buildNonce, role, vmId, name, configDigest,
      deadlineAt: new Date(Date.now() + this.reservation.maxBuildMs).toISOString(), maxBytes: 274_877_906_944,
    })}\n`);
    const attestor = this.reservation.volumeAttestor;
    const result = await runProcess("/usr/bin/ssh", [
      "-F", "/dev/null", "-T", "-p", String(attestor.sshPort),
      "-o", "BatchMode=yes", "-o", "CanonicalizeHostname=no", "-o", "CheckHostIP=no", "-o", "ClearAllForwardings=yes",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForwardAgent=no", "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "KbdInteractiveAuthentication=no", "-o", "NumberOfPasswordPrompts=0",
      "-o", "PasswordAuthentication=no", "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "RequestTTY=no",
      "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${this.knownHosts}`, "-i", this.identityFile, "--",
      `${attestor.sshUser}@${attestor.sshHost}`, "/usr/bin/sudo", "-n", "/usr/libexec/nelos-proxmox-volume-measure", "request",
    ], { input: request, timeoutMs: this.reservation.maxBuildMs, maxOutputBytes: 1_048_576 });
    let value;
    try { value = JSON.parse(result.stdout); } catch { fail("VOLUME_MEASUREMENT_INVALID", "volume attestor returned invalid JSON"); }
    return value;
  }
}

class CurlApiV1 {
  constructor({ apiUrl, tokenId, token, reservation, caFile }) { this.apiUrl = apiUrl; this.tokenId = tokenId; this.token = token; this.reservation = reservation; this.caFile = caFile; }
  async request(path, { method = "GET" } = {}) {
    if (!/^\/?[A-Za-z0-9?&=._:%/-]+$/u.test(path)) fail("INVALID_PROVIDER_PATH", "fixed API path is invalid");
    const config = Buffer.from(`header = "Authorization: PVEAPIToken=${this.tokenId}=${this.token.value()}"\n`);
    let result;
    try {
      result = await runProcess("/usr/bin/curl", [
        "--disable", "--fail-with-body", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", "--cacert", this.caFile, "--max-time", "30", "--config", "-", "--request", method,
        `${this.apiUrl}/${path.replace(/^\//u, "")}`,
      ], { input: config, env: cleanEnvironment(), timeoutMs: 35_000, maxOutputBytes: 8_388_608, allowFailure: true });
    } finally { config.fill(0); }
    if (result.exitCode !== 0) fail("PROVIDER_REQUEST_FAILED", "bounded Proxmox API request failed");
    let envelope;
    try { envelope = JSON.parse(result.stdout); } catch { fail("PROVIDER_RESPONSE_INVALID", "Proxmox API response is not JSON"); }
    if (!plain(envelope) || !Object.hasOwn(envelope, "data")) fail("PROVIDER_RESPONSE_INVALID", "Proxmox API response has no data field");
    return envelope.data;
  }
  async version() { return (await this.request("version"))?.version; }
  async permissions() { return this.request("access/permissions"); }
  async inventory() { return this.request("cluster/resources?type=vm"); }
  async config(vmid) { return this.request(`nodes/${this.reservation.node}/qemu/${vmid}/config?current=1`); }
  async status(vmid) { return this.request(`nodes/${this.reservation.node}/qemu/${vmid}/status/current`); }
  async pending(vmid) { return this.request(`nodes/${this.reservation.node}/qemu/${vmid}/pending`); }
  async storageConfig() { return this.request(`storage/${this.reservation.storage}`); }
  async storageStatus() { return this.request(`nodes/${this.reservation.node}/storage/${this.reservation.storage}/status`); }
  async storageContent() { return this.request(`nodes/${this.reservation.node}/storage/${this.reservation.storage}/content`); }
  async operationTasks({ startedAt }) {
    const started = Date.parse(startedAt);
    if (!Number.isFinite(started)) fail("PROVIDER_TASK_OBSERVATION_INVALID", "provider task query start time is invalid");
    const encodedUser = encodeURIComponent(this.reservation.buildTokenId).replaceAll("!", "%21");
    const rows = await this.request(`nodes/${this.reservation.node}/tasks?source=all&vmid=${this.reservation.outputTemplate.vmId}&userfilter=${encodedUser}&starttime=${Math.max(0, Math.floor(started / 1000) - 1)}&limit=101`);
    if (!Array.isArray(rows) || rows.length > 100) fail("PROVIDER_TASK_OBSERVATION_INVALID", "provider task query is malformed or truncated");
    const tasks = rows.map((row) => {
      const vmId = Number(row?.id ?? row?.vmid); const startSeconds = Number(row?.starttime); const endSeconds = row?.endtime === undefined ? null : Number(row.endtime);
      if (!plain(row) || !Number.isSafeInteger(vmId) || !Number.isFinite(startSeconds)) fail("PROVIDER_TASK_OBSERVATION_INVALID", "provider task entry is malformed");
      return {
        upid: row.upid,
        node: row.node,
        vmId,
        user: row.user,
        type: row.type,
        status: row.status,
        exitStatus: row.status === "stopped" ? row.exitstatus : null,
        startedAt: new Date(startSeconds * 1000).toISOString(),
        endedAt: row.status === "stopped" && Number.isFinite(endSeconds) ? new Date(endSeconds * 1000).toISOString() : null,
      };
    }).sort((left, right) => String(left.upid).localeCompare(String(right.upid)));
    const content = {
      complete: true,
      query: { startedAt, user: this.reservation.buildTokenId, vmId: this.reservation.outputTemplate.vmId },
      tasks,
    };
    return { ...content, digest: sha256V1(content) };
  }
  async destroyOwned(vmid, artifact) {
    if (artifact.artifactId !== String(vmid)) fail("OWNERSHIP_UNPROVEN", "cleanup artifact identity differs");
    const upid = await this.request(`nodes/${this.reservation.node}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`, { method: "DELETE" });
    if (typeof upid !== "string" || !/^UPID:[A-Za-z0-9:._-]{1,507}$/u.test(upid)) fail("CLEANUP_UNPROVEN", "cleanup mutation has no exact provider task identity");
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const task = await this.request(`nodes/${this.reservation.node}/tasks/${encodeURIComponent(upid)}/status`);
      if (task?.status === "stopped") {
        if (!new Set(["OK", "TASK OK"]).has(task.exitstatus)) fail("CLEANUP_UNPROVEN", "cleanup provider task failed");
        const [inventory, storageContent] = await Promise.all([this.inventory(), this.storageContent()]);
        const absent = Array.isArray(inventory) && !inventory.some((item) => Number(item?.vmid) === vmid || item?.name === this.reservation.outputTemplate.name) &&
          Array.isArray(storageContent) && !storageContent.some((item) => Number(item?.vmid) === vmid ||
            (typeof item?.volid === "string" && new RegExp(`(?:^|[:/])(?:base|vm)-${vmid}-`, "u").test(item.volid)));
        return { destroyed: absent, absent, providerOperationId: upid };
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
    fail("CLEANUP_UNPROVEN", "cleanup provider task did not reach a bounded terminal state");
  }
}

const PACKER_PROCESS_SCHEMA_VERSION = 2;
const PACKER_SUPERVISOR_MODE = "--internal-packer-supervisor-v1";
const PACKER_PROCESS_TERM_MS = 2_000;
const PACKER_PROCESS_KILL_MS = 2_000;

async function readLinuxProcessV1(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  const path = `/proc/${pid}`;
  const [statBytes, info] = await Promise.all([
    readFile(`${path}/stat`, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)),
    lstat(path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)),
  ]);
  if (statBytes === null || info === null) return null;
  const close = statBytes.lastIndexOf(")");
  const openIndex = statBytes.indexOf("(");
  const parsedPid = Number(statBytes.slice(0, openIndex).trim());
  const fields = close > openIndex ? statBytes.slice(close + 1).trim().split(/\s+/u) : [];
  const processGroupId = Number(fields[2]);
  const startTimeTicks = fields[19];
  if (parsedPid !== pid || !Number.isSafeInteger(processGroupId) || processGroupId < 2 || !/^[0-9]+$/u.test(startTimeTicks ?? "")) {
    fail("PACKER_PROCESS_INVALID", "Linux process metadata is malformed");
  }
  return Object.freeze({ pid, processGroupId, startTimeTicks, uid: info.uid });
}

async function linuxProcessGroupMembersV1(processGroupId) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 2) return [];
  const names = await readdir("/proc");
  const members = [];
  for (const name of names) {
    if (!/^[1-9][0-9]*$/u.test(name)) continue;
    const observed = await readLinuxProcessV1(Number(name)).catch(() => null);
    if (observed?.processGroupId === processGroupId) members.push(observed.pid);
  }
  return members.sort((left, right) => left - right);
}

export function classifyPackerProcessObservationV1(record, { leader, groupMembers }) {
  exact(record, ["pid", "processGroupId", "startTimeTicks", "uid"], "Packer process ownership");
  if (!Number.isSafeInteger(record.pid) || record.pid < 2 || record.processGroupId !== record.pid ||
      !/^[0-9]+$/u.test(record.startTimeTicks ?? "") || !Number.isSafeInteger(record.uid) || record.uid < 0 ||
      !Array.isArray(groupMembers) || groupMembers.some((pid) => !Number.isSafeInteger(pid) || pid < 2)) {
    fail("PACKER_PROCESS_INVALID", "Packer process ownership record is malformed");
  }
  if (leader === null) return groupMembers.length === 0 ? "absent" : "orphaned";
  exact(leader, ["pid", "processGroupId", "startTimeTicks", "uid"], "observed Packer process");
  if (leader.pid !== record.pid || leader.processGroupId !== record.processGroupId || leader.startTimeTicks !== record.startTimeTicks || leader.uid !== record.uid) return "identity-mismatch";
  if (!groupMembers.includes(record.pid)) return "identity-mismatch";
  return "running";
}

export function createDefaultPackerProcessControlV1() {
  return Object.freeze({
    spawnSupervisor({ statePath, outputPath }) {
      return spawn(process.execPath, [MODULE_PATH, PACKER_SUPERVISOR_MODE, statePath, outputPath], {
        shell: false, stdio: ["pipe", "ignore", "ignore"], env: cleanEnvironment(), detached: true,
      });
    },
    async observe(record) {
      const [leader, groupMembers] = await Promise.all([readLinuxProcessV1(record.pid), linuxProcessGroupMembersV1(record.processGroupId)]);
      return { leader, groupMembers };
    },
    signalGroup(processGroupId, signal) { process.kill(-processGroupId, signal); },
  });
}

async function observeOwnedPackerProcessV1(processControl, record) {
  const observation = await processControl.observe(record);
  if (!plain(observation) || !(observation.leader === null || plain(observation.leader)) || !Array.isArray(observation.groupMembers)) {
    fail("PACKER_PROCESS_INVALID", "Packer process observation boundary is malformed");
  }
  return { ...observation, state: classifyPackerProcessObservationV1(record, observation) };
}

async function waitForPackerProcessStateV1(processControl, record, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let observation;
  do {
    observation = await observeOwnedPackerProcessV1(processControl, record);
    if (expected.has(observation.state)) return observation;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  } while (Date.now() < deadline);
  return observation;
}

function validatePackerRunningStateV1(state, { operationId, reservation = null, reservationDigest = reservation === null ? null : sha256V1(reservation) }) {
  exact(state, ["kind", "operationId", "outputVmId", "process", "reservationDigest", "schemaVersion", "startedAt", "state", "supervisorModuleDigest"], "Packer running operation");
  if (state.schemaVersion !== PACKER_PROCESS_SCHEMA_VERSION || state.kind !== "nelos-golden-packer-operation" || state.state !== "running" ||
      state.operationId !== operationId || state.reservationDigest !== reservationDigest || !SHA256.test(reservationDigest ?? "") || state.outputVmId !== OUTPUT_TEMPLATE_VMID ||
      !Number.isFinite(Date.parse(state.startedAt)) || !SHA256.test(state.supervisorModuleDigest ?? "")) {
    fail("PACKER_OPERATION_INVALID", "Packer running operation identity differs");
  }
  classifyPackerProcessObservationV1(state.process, { leader: state.process, groupMembers: [state.process.pid] });
  return state;
}

export class PackerBoundaryV1 {
  constructor({ packerBin, pluginBin, runRoot, operationRoot, sourceRoot, token, reservation, varFile, caFile, processControl = createDefaultPackerProcessControlV1() }) {
    this.packerBin = packerBin; this.pluginBin = pluginBin; this.runRoot = runRoot; this.operationRoot = operationRoot; this.sourceRoot = sourceRoot; this.token = token; this.reservation = reservation; this.varFile = varFile; this.caFile = caFile;
    if (!plain(processControl) || typeof processControl.spawnSupervisor !== "function" || typeof processControl.observe !== "function" || typeof processControl.signalGroup !== "function") {
      fail("INVALID_ADAPTER", "Packer process-control boundary is incomplete");
    }
    this.processControl = processControl;
  }
  environment({ synthetic = false, offline = false } = {}) {
    const proxy = "http://127.0.0.1:9";
    return cleanEnvironment({
      HOME: join(this.runRoot, "home"), TMPDIR: join(this.runRoot, "tmp"), XDG_CACHE_HOME: join(this.runRoot, "xdg-cache"), XDG_CONFIG_HOME: join(this.runRoot, "xdg-config"), XDG_DATA_HOME: join(this.runRoot, "xdg-data"),
      PACKER_CACHE_DIR: join(this.runRoot, "cache"), PACKER_CONFIG_DIR: join(this.runRoot, "config"), PACKER_PLUGIN_PATH: join(this.runRoot, "plugins"), PACKER_CONFIG: join(this.runRoot, "config/packer.json"),
      PROXMOX_URL: synthetic ? "https://proxmox.invalid:8006/api2/json" : this.reservation.apiUrl,
      PROXMOX_USERNAME: synthetic ? "validator@pve!synthetic" : this.reservation.buildTokenId,
      PROXMOX_TOKEN: synthetic ? "synthetic-token-value" : this.token.value(),
      SSL_CERT_FILE: this.caFile,
      ...(offline ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: "", no_proxy: "" } : {}),
    });
  }
  async initialize() {
    await runProcess(this.packerBin, ["plugins", "install", "--path", this.pluginBin, "github.com/hashicorp/proxmox"], { env: this.environment({ synthetic: true, offline: true }), timeoutMs: 60_000 });
    await runProcess(this.packerBin, ["init", this.sourceRoot], { env: this.environment({ synthetic: true, offline: true }), timeoutMs: 60_000 });
    await runProcess(this.packerBin, ["fmt", "-check", this.sourceRoot], { env: this.environment({ synthetic: true, offline: true }) });
    await runProcess(this.packerBin, ["validate", "-var-file", this.varFile, this.sourceRoot], { env: this.environment({ synthetic: true, offline: true }), timeoutMs: 60_000 });
  }
  operationPaths(operationId) {
    if (!SHA256.test(operationId ?? "")) fail("PACKER_OPERATION_INVALID", "Packer operation identity is invalid");
    const key = operationId.slice(7);
    return { state: join(this.operationRoot, `${key}.packer-operation.json`), output: join(this.operationRoot, `${key}.packer-machine-output.log`) };
  }
  async build({ operationId }) {
    const paths = this.operationPaths(operationId);
    if (await Promise.all(Object.values(paths).map((path) => lstat(path).then(() => true, () => false))).then((values) => values.some(Boolean))) {
      fail("PACKER_RECONCILIATION_REQUIRED", "a durable Packer operation already exists and must be reconciled");
    }
    const child = this.processControl.spawnSupervisor({ statePath: paths.state, outputPath: paths.output });
    if (!child || !Number.isSafeInteger(child.pid) || child.pid < 2 || typeof child.stdin?.end !== "function" || typeof child.once !== "function") {
      fail("PACKER_PROCESS_INVALID", "Packer supervisor did not expose one bounded process handle");
    }
    let launched = false;
    try {
      let leader = null;
      const deadline = Date.now() + 2_000;
      do {
        leader = await readLinuxProcessV1(child.pid).catch(() => null);
        if (leader) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      } while (Date.now() < deadline);
      if (!leader || leader.processGroupId !== child.pid || leader.uid !== process.getuid()) fail("PACKER_PROCESS_INVALID", "Packer supervisor process identity could not be sealed");
      const started = {
        schemaVersion: PACKER_PROCESS_SCHEMA_VERSION, kind: "nelos-golden-packer-operation", operationId, reservationDigest: sha256V1(this.reservation),
        outputVmId: OUTPUT_TEMPLATE_VMID, state: "running", startedAt: new Date().toISOString(),
        supervisorModuleDigest: sha256V1(await readFile(MODULE_PATH)), process: leader,
      };
      await writeExclusive(paths.state, Buffer.from(`${canonicalJsonV1(started)}\n`), 0o600);
      const stateDirectory = await open(this.operationRoot, "r");
      try { await stateDirectory.sync(); } finally { await stateDirectory.close(); }
      const control = {
        schemaVersion: 1, kind: "nelos-golden-packer-supervisor-control", operationId, reservationDigest: sha256V1(this.reservation),
        statePath: paths.state, outputPath: paths.output, executable: this.packerBin,
        args: ["build", "-machine-readable", "-color=false", "-on-error=abort", "-parallel-builds=1", `-only=${PACKER_TARGET}`, "-var-file", this.varFile, this.sourceRoot],
        environment: this.environment(), timeoutMs: this.reservation.maxBuildMs, maxOutputBytes: MAX_MACHINE_OUTPUT,
      };
      child.stdin.on("error", () => {});
      child.stdin.end(`${canonicalJsonV1(control)}\n`); launched = true;
      await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new GoldenImageBuildError("PACKER_SUPERVISOR_TIMEOUT", "Packer supervisor exceeded its bounded reconciliation margin")), this.reservation.maxBuildMs + 30_000);
        child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
        child.once("close", () => { clearTimeout(timer); resolvePromise(); });
      });
      const recovered = await this.recover({ operationId, reservation: this.reservation });
      if (recovered.state !== "completed") fail("PACKER_RECONCILIATION_REQUIRED", "Packer supervisor exited without one durable completion record", { processState: recovered.state });
      return { exitCode: recovered.exitCode, machineOutput: recovered.machineOutput };
    } catch (error) {
      if (!launched) child.stdin.destroy();
      throw error;
    }
  }
  async recover({ operationId, reservation }) {
    if (sha256V1(reservation) !== sha256V1(this.reservation)) fail("PACKER_OPERATION_INVALID", "Packer recovery reservation differs");
    const paths = this.operationPaths(operationId); const stateInfo = await lstat(paths.state).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!stateInfo) return { schemaVersion: 1, state: "absent", operationId };
    if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.nlink !== 1 || stateInfo.uid !== process.getuid() || (stateInfo.mode & 0o777) !== 0o600 || await realpath(paths.state) !== paths.state) {
      fail("PACKER_OPERATION_INVALID", "Packer operation state metadata differs");
    }
    const stateBytes = await readFile(paths.state); let state;
    try { state = JSON.parse(stateBytes); } catch { fail("PACKER_OPERATION_INVALID", "Packer operation state is malformed"); }
    if (!stateBytes.equals(Buffer.from(`${canonicalJsonV1(state)}\n`)) || state.schemaVersion !== PACKER_PROCESS_SCHEMA_VERSION || state.kind !== "nelos-golden-packer-operation" ||
        state.operationId !== operationId || state.reservationDigest !== sha256V1(reservation) || state.outputVmId !== reservation.outputTemplate.vmId ||
        !new Set(["running", "completed"]).has(state.state) || !Number.isFinite(Date.parse(state.startedAt))) fail("PACKER_OPERATION_INVALID", "Packer operation state identity differs");
    if (state.state === "running") {
      validatePackerRunningStateV1(state, { operationId, reservation });
      const observation = await observeOwnedPackerProcessV1(this.processControl, state.process);
      if (observation.state !== "running") {
        const latestBytes = await readFile(paths.state);
        if (!latestBytes.equals(stateBytes)) return this.recover({ operationId, reservation });
      }
      return { schemaVersion: PACKER_PROCESS_SCHEMA_VERSION, state: observation.state === "absent" ? "abandoned" : observation.state, operationId, process: structuredClone(state.process) };
    }
    exact(state, ["completedAt", "completionReason", "exitCode", "kind", "machineOutputBytes", "machineOutputDigest", "operationId", "outputVmId", "process", "reservationDigest", "schemaVersion", "startedAt", "state", "supervisorModuleDigest"], "Packer completed operation");
    classifyPackerProcessObservationV1(state.process, { leader: state.process, groupMembers: [state.process.pid] });
    const outputInfo = await lstat(paths.output).catch(() => null);
    if (!outputInfo?.isFile() || outputInfo.isSymbolicLink() || outputInfo.nlink !== 1 || outputInfo.uid !== process.getuid() || (outputInfo.mode & 0o777) !== 0o600 || await realpath(paths.output) !== paths.output ||
        !Number.isSafeInteger(state.exitCode) || !Number.isSafeInteger(state.machineOutputBytes) || state.machineOutputBytes < 0 || state.machineOutputBytes > MAX_MACHINE_OUTPUT ||
        !SHA256.test(state.machineOutputDigest ?? "") || !Number.isFinite(Date.parse(state.completedAt))) fail("PACKER_OPERATION_INVALID", "completed Packer operation metadata differs");
    const bytes = await readFile(paths.output); const actual = state.machineOutputBytes === 0 && bytes.equals(Buffer.from("\n")) ? Buffer.alloc(0) : bytes;
    if (actual.length !== state.machineOutputBytes || sha256V1(actual) !== state.machineOutputDigest) fail("PACKER_OPERATION_INVALID", "durable Packer machine output differs");
    if (!new Set(["exited", "output-limit", "timeout", "terminated"]).has(state.completionReason)) fail("PACKER_OPERATION_INVALID", "Packer completion reason differs");
    return { schemaVersion: PACKER_PROCESS_SCHEMA_VERSION, state: "completed", operationId, exitCode: state.exitCode, machineOutput: actual.toString("utf8"), machineOutputDigest: state.machineOutputDigest };
  }
  async terminate({ operationId, reservation }) {
    if (sha256V1(reservation) !== sha256V1(this.reservation)) fail("PACKER_OPERATION_INVALID", "Packer termination reservation differs");
    const current = await this.recover({ operationId, reservation });
    if (current.state === "completed") return { schemaVersion: 1, state: "completed", operationId };
    if (current.state !== "running") return { schemaVersion: 1, state: "quarantined", operationId, reason: current.state };
    const paths = this.operationPaths(operationId); let state; let stateBytes;
    try { stateBytes = await readFile(paths.state); state = JSON.parse(stateBytes); } catch { fail("PACKER_OPERATION_INVALID", "Packer operation state is unavailable for termination"); }
    if (!stateBytes.equals(Buffer.from(`${canonicalJsonV1(state)}\n`))) fail("PACKER_OPERATION_INVALID", "Packer operation state changed or is not canonical during termination");
    if (state.state === "completed") return { schemaVersion: 1, state: "completed", operationId };
    validatePackerRunningStateV1(state, { operationId, reservation });
    let observation = await observeOwnedPackerProcessV1(this.processControl, state.process);
    if (observation.state === "absent") return { schemaVersion: 1, state: "terminated", operationId, signal: null };
    if (observation.state !== "running") return { schemaVersion: 1, state: "quarantined", operationId, reason: observation.state };
    try { this.processControl.signalGroup(state.process.processGroupId, "SIGTERM"); }
    catch (error) {
      if (error?.code !== "ESRCH") return { schemaVersion: 1, state: "quarantined", operationId, reason: "term-failed" };
    }
    observation = await waitForPackerProcessStateV1(this.processControl, state.process, new Set(["absent"]), PACKER_PROCESS_TERM_MS);
    if (observation.state === "absent") return { schemaVersion: 1, state: "terminated", operationId, signal: "SIGTERM" };
    if (observation.state !== "running") return { schemaVersion: 1, state: "quarantined", operationId, reason: observation.state };
    try { this.processControl.signalGroup(state.process.processGroupId, "SIGKILL"); }
    catch (error) {
      if (error?.code !== "ESRCH") return { schemaVersion: 1, state: "quarantined", operationId, reason: "kill-failed" };
    }
    observation = await waitForPackerProcessStateV1(this.processControl, state.process, new Set(["absent"]), PACKER_PROCESS_KILL_MS);
    return observation.state === "absent" ? { schemaVersion: 1, state: "terminated", operationId, signal: "SIGKILL" } :
      { schemaVersion: 1, state: "quarantined", operationId, reason: observation.state === "running" ? "kill-unreaped" : observation.state };
  }
}

async function prepareToolchain({ toolchain, packerArchive, pluginArchive, runRoot }) {
  const packerPath = await sealedFile(packerArchive, { label: "Packer archive", modes: new Set([0o400, 0o440, 0o600, 0o640]), maximum: 268_435_456 });
  const pluginPath = await sealedFile(pluginArchive, { label: "Packer Proxmox plugin archive", modes: new Set([0o400, 0o440, 0o600, 0o640]), maximum: 268_435_456 });
  const [packerBytes, pluginBytes] = await Promise.all([readFile(packerPath), readFile(pluginPath)]);
  if (sha256V1(packerBytes) !== `sha256:${toolchain.artifacts.packer.sha256}` || sha256V1(pluginBytes) !== `sha256:${toolchain.artifacts.packerProxmoxPlugin.sha256}`) fail("TOOLCHAIN_MISMATCH", "Packer or plugin archive digest differs from the immutable toolchain lock");
  packerBytes.fill(0); pluginBytes.fill(0);
  const packerDir = join(runRoot, "packer-bin"); const pluginDir = join(runRoot, "plugin-bin");
  await mkdir(packerDir, { mode: 0o700 }); await mkdir(pluginDir, { mode: 0o700 });
  await runProcess("/usr/bin/unzip", ["-q", packerPath, "-d", packerDir], { timeoutMs: 60_000 });
  await runProcess("/usr/bin/unzip", ["-q", pluginPath, "-d", pluginDir], { timeoutMs: 60_000 });
  const packerBin = join(packerDir, "packer");
  const pluginBin = join(pluginDir, toolchain.artifacts.packerProxmoxPlugin.fileName.replace(/\.zip$/u, ""));
  for (const path of [packerBin, pluginBin]) {
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) fail("TOOLCHAIN_MISMATCH", "verified toolchain archive lacks its exact binary");
    await chmod(path, 0o500);
  }
  const version = (await runProcess(packerBin, ["version"], { timeoutMs: 10_000 })).stdout.toString("utf8").split(/\r?\n/u)[0];
  if (version !== `Packer v${toolchain.artifacts.packer.version}`) fail("TOOLCHAIN_MISMATCH", "Packer executable version differs from the immutable lock");
  return { packerBin, pluginBin };
}

async function readSupervisorControlV1() {
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 1_048_576) fail("PACKER_PROCESS_INVALID", "Packer supervisor control exceeded its bound");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks); let value;
  try { value = JSON.parse(bytes); } catch { fail("PACKER_PROCESS_INVALID", "Packer supervisor control is malformed"); }
  if (!bytes.equals(Buffer.from(`${canonicalJsonV1(value)}\n`))) fail("PACKER_PROCESS_INVALID", "Packer supervisor control is not canonical");
  exact(value, ["args", "environment", "executable", "kind", "maxOutputBytes", "operationId", "outputPath", "reservationDigest", "schemaVersion", "statePath", "timeoutMs"], "Packer supervisor control");
  if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-packer-supervisor-control" || !SHA256.test(value.operationId ?? "") ||
      !SHA256.test(value.reservationDigest ?? "") || !isAbsolute(value.executable ?? "") || resolve(value.executable) !== value.executable ||
      !Array.isArray(value.args) || value.args.length < 1 || value.args.length > 32 || value.args.some((item) => typeof item !== "string" || item.length > 4_096 || /[\0\r\n]/u.test(item)) ||
      !plain(value.environment) || Object.entries(value.environment).some(([name, item]) => !/^[A-Z_][A-Z0-9_]*$/u.test(name) || typeof item !== "string" || item.length > 65_536 || item.includes("\0")) ||
      !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 300_000 || value.timeoutMs > 7_200_000 ||
      value.maxOutputBytes !== MAX_MACHINE_OUTPUT) fail("PACKER_PROCESS_INVALID", "Packer supervisor control identity or bounds differ");
  return value;
}

async function terminateSupervisorGroupMembersV1(signal) {
  for (const pid of await linuxProcessGroupMembersV1(process.pid)) {
    if (pid === process.pid) continue;
    try { process.kill(pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
}

async function packerSupervisorCliV1(statePath, outputPath) {
  if (platform() !== "linux" || arch() !== "x64" || process.getuid() === undefined || process.pid < 2 || !isAbsolute(statePath ?? "") || !isAbsolute(outputPath ?? "") ||
      resolve(statePath) !== statePath || resolve(outputPath) !== outputPath || dirname(statePath) !== dirname(outputPath)) {
    fail("PACKER_PROCESS_INVALID", "Packer supervisor platform or operation paths differ");
  }
  const [stateInfo, operationRootInfo, canonicalState, canonicalRoot, outputInfo] = await Promise.all([
    lstat(statePath).catch(() => null), lstat(dirname(statePath)).catch(() => null), realpath(statePath).catch(() => null),
    realpath(dirname(statePath)).catch(() => null), lstat(outputPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)),
  ]);
  if (!stateInfo?.isFile() || stateInfo.isSymbolicLink() || stateInfo.nlink !== 1 || stateInfo.uid !== process.getuid() || (stateInfo.mode & 0o777) !== 0o600 ||
      canonicalState !== statePath || !operationRootInfo?.isDirectory() || operationRootInfo.isSymbolicLink() || operationRootInfo.uid !== process.getuid() ||
      (operationRootInfo.mode & 0o777) !== 0o700 || canonicalRoot !== dirname(statePath) || outputInfo !== null) {
    fail("PACKER_PROCESS_INVALID", "Packer supervisor operation storage is not one private caller-owned identity");
  }
  const control = await readSupervisorControlV1();
  if (control.statePath !== statePath || control.outputPath !== outputPath) fail("PACKER_PROCESS_INVALID", "Packer supervisor paths differ from its sealed control");
  const stateBytes = await readFile(statePath); let running;
  try { running = JSON.parse(stateBytes); } catch { fail("PACKER_PROCESS_INVALID", "Packer supervisor ownership record is malformed"); }
  if (!stateBytes.equals(Buffer.from(`${canonicalJsonV1(running)}\n`))) fail("PACKER_PROCESS_INVALID", "Packer supervisor ownership record is not canonical");
  validatePackerRunningStateV1(running, { operationId: control.operationId, reservationDigest: control.reservationDigest });
  if (running.reservationDigest !== control.reservationDigest || running.outputVmId !== OUTPUT_TEMPLATE_VMID ||
      running.supervisorModuleDigest !== sha256V1(await readFile(MODULE_PATH))) fail("PACKER_PROCESS_INVALID", "Packer supervisor immutable identity differs");
  const self = await readLinuxProcessV1(process.pid);
  if (!self || canonicalJsonV1(self) !== canonicalJsonV1(running.process) || self.processGroupId !== process.pid) {
    fail("PACKER_PROCESS_INVALID", "Packer supervisor PID, start time, process group, or owner differs");
  }
  const stdout = []; let outputBytes = 0; let completionReason = "exited"; let child = null; let finishing = false;
  const forwardTermination = () => {
    completionReason = "terminated";
    if (child && !finishing) child.kill("SIGTERM");
  };
  process.on("SIGTERM", forwardTermination);
  child = spawn(control.executable, control.args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: control.environment, detached: false });
  const stderr = []; let stderrBytes = 0;
  const timer = setTimeout(() => {
    completionReason = "timeout";
    child.kill("SIGTERM");
    setTimeout(() => terminateSupervisorGroupMembersV1("SIGKILL").catch(() => {}), 1_000).unref();
  }, control.timeoutMs);
  child.stdout.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > control.maxOutputBytes) {
      completionReason = "output-limit";
      child.kill("SIGTERM");
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes <= 1_048_576) stderr.push(chunk); });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  clearTimeout(timer); finishing = true;
  await terminateSupervisorGroupMembersV1("SIGTERM");
  const remainingDeadline = Date.now() + 1_000;
  while ((await linuxProcessGroupMembersV1(process.pid)).some((pid) => pid !== process.pid) && Date.now() < remainingDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  await terminateSupervisorGroupMembersV1("SIGKILL");
  const output = outputBytes > control.maxOutputBytes ? Buffer.alloc(0) : Buffer.concat(stdout);
  const durableOutput = output.length === 0 ? Buffer.from("\n") : output;
  await writeExclusive(outputPath, durableOutput, 0o600);
  const completed = {
    ...running, state: "completed", exitCode: Number.isSafeInteger(result.code) ? result.code : completionReason === "exited" ? 128 : 124,
    machineOutputBytes: output.length, machineOutputDigest: sha256V1(output), completionReason, completedAt: new Date().toISOString(),
  };
  await writeAtomicReplace(statePath, Buffer.from(`${canonicalJsonV1(completed)}\n`), 0o600, dirname(statePath));
  output.fill(0); durableOutput.fill(0); stderr.forEach((bytes) => bytes.fill(0));
}

async function cli() {
  if (process.argv.length !== 2) fail("INVALID_OPERATION", "arguments are disabled; the sealed reservation supplies every build input");
  if (platform() !== "linux" || arch() !== "x64") fail("CONTROLLER_PLATFORM_INVALID", "golden-image builds require a dedicated Linux x86_64 controller");
  if (await lstat("/etc/pve").then(() => true, () => false)) fail("CONTROLLER_PLATFORM_INVALID", "golden-image wrapper must not run on a Proxmox hypervisor");
  for (const name of ["PACKER_LOG", "PACKER_LOG_PATH", "PROXMOX_PASSWORD", "PROXMOX_URL", "PROXMOX_USERNAME", "PROXMOX_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_OPTIONS", "NODE_PATH", "SSH_AGENT_PID", "SSH_AUTH_SOCK"]) {
    if (Object.hasOwn(process.env, name)) fail("AMBIENT_ENVIRONMENT_REJECTED", `${name} must be unset`);
  }
  for (const name of Object.keys(process.env)) if (/^(?:PACKER_|PKR_VAR_|HCP_)/u.test(name)) fail("AMBIENT_ENVIRONMENT_REJECTED", `ambient ${name} is forbidden`);
  for (const executable of ["/usr/bin/curl", "/usr/bin/git", "/usr/bin/unzip", "/usr/bin/ssh", "/usr/bin/ssh-keygen", "/usr/bin/tar"]) {
    const info = await lstat(executable).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) fail("CONTROLLER_TOOL_INVALID", `fixed controller tool is unavailable: ${executable}`);
  }
  const required = [
    "NELOS_GOLDEN_RESERVATION_FILE", "NELOS_GOLDEN_BUILD_TOKEN_FILE", "NELOS_GOLDEN_ATTEST_TOKEN_FILE", "NELOS_GOLDEN_STATE_DIR",
    "NELOS_GOLDEN_ATTESTATION_DIR", "NELOS_GOLDEN_PACKER_ARCHIVE", "NELOS_GOLDEN_PLUGIN_ARCHIVE", "NELOS_GOLDEN_TLS_CA_FILE",
    "NELOS_GOLDEN_VOLUME_KNOWN_HOSTS", "NELOS_GOLDEN_VOLUME_IDENTITY_FILE",
  ];
  const optional = ["NELOS_GOLDEN_CLEANUP_ONLY"];
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("NELOS_GOLDEN_") && !required.includes(name) && !optional.includes(name)) fail("AMBIENT_ENVIRONMENT_REJECTED", `unsupported ${name} override is forbidden`);
  }
  for (const name of required) if (!process.env[name]) fail("CONTROLLER_CONFIG_REQUIRED", `${name} is required`);
  const cleanupOnly = process.env.NELOS_GOLDEN_CLEANUP_ONLY === "1";
  if (process.env.NELOS_GOLDEN_CLEANUP_ONLY !== undefined && !cleanupOnly) fail("CONTROLLER_CONFIG_REQUIRED", "NELOS_GOLDEN_CLEANUP_ONLY must equal 1 when present");
  const reservationPath = await sealedFile(process.env.NELOS_GOLDEN_RESERVATION_FILE, { label: "golden-image reservation", modes: new Set([0o400, 0o600]), maximum: 16_384 });
  const reservation = validateGoldenImageReservationV1(JSON.parse(await readFile(reservationPath, "utf8")), { allowExpiredForCleanup: true });
  const caFile = await sealedFile(process.env.NELOS_GOLDEN_TLS_CA_FILE, { label: "Proxmox TLS CA", modes: new Set([0o400, 0o440, 0o600, 0o640]), maximum: 1_048_576 });
  if (sha256V1(await readFile(caFile)) !== reservation.tlsCaDigest) fail("TLS_TRUST_MISMATCH", "Proxmox TLS CA differs from the reservation");
  const volumeKnownHosts = await sealedFile(process.env.NELOS_GOLDEN_VOLUME_KNOWN_HOSTS, { label: "volume-attestor known-hosts", modes: new Set([0o400, 0o440, 0o600, 0o640]), maximum: 1_048_576 });
  const volumeIdentity = await sealedFile(process.env.NELOS_GOLDEN_VOLUME_IDENTITY_FILE, { label: "volume-attestor identity", modes: new Set([0o400, 0o600]), maximum: 65_536 });
  const stateRoot = await sealedDirectory(process.env.NELOS_GOLDEN_STATE_DIR, "golden-image state root", { create: true });
  const attestationRoot = await sealedDirectory(process.env.NELOS_GOLDEN_ATTESTATION_DIR, "golden-image attestation root", { create: true });
  const [buildToken, attestToken] = await Promise.all([
    readToken(process.env.NELOS_GOLDEN_BUILD_TOKEN_FILE, "build API token"), readToken(process.env.NELOS_GOLDEN_ATTEST_TOKEN_FILE, "attestation API token"),
  ]);
  if (buildToken.value() === attestToken.value()) { buildToken.erase(); attestToken.erase(); fail("INDEPENDENT_ATTESTOR_REQUIRED", "build and attestation token secrets must differ"); }
  let runRoot = null;
  try {
    const toolchain = JSON.parse(await readFile(TOOLCHAIN_LOCK_PATH, "utf8"));
    exact(toolchain, ["artifacts", "contractVersion", "platform", "policy", "schemaVersion"], "toolchainLock");
    if (toolchain.schemaVersion !== 1 || toolchain.artifacts?.packer?.version !== "1.15.4" || toolchain.artifacts?.packerProxmoxPlugin?.version !== "1.2.4" ||
        toolchain.artifacts?.node?.version !== "24.18.0" || process.version !== "v24.18.0") fail("TOOLCHAIN_MISMATCH", "controller Node, Packer, or plugin version differs from the immutable lock");
    await assertSourceRevision(reservation);
    runRoot = await mkdtemp(join(stateRoot, "nelos-golden-run."));
    await chmod(runRoot, 0o700);
    for (const directory of ["cache", "config", "home", "plugins", "tmp", "xdg-cache", "xdg-config", "xdg-data"]) await mkdir(join(runRoot, directory), { mode: 0o700 });
    await writeExclusive(join(runRoot, "config/packer.json"), Buffer.from("{}\n"), 0o600);
    const immutableInputs = await materializeSource(reservation.sourceCommit, runRoot);
    const sealedV1Root = join(runRoot, "source/validation/proxmox-desktop/v1");
    const hcl = await readFile(join(sealedV1Root, "golden-image.pkr.hcl"), "utf8");
    validatePackerSourceV1(hcl);
    const { packerBin, pluginBin } = await prepareToolchain({
      toolchain, packerArchive: process.env.NELOS_GOLDEN_PACKER_ARCHIVE, pluginArchive: process.env.NELOS_GOLDEN_PLUGIN_ARCHIVE, runRoot,
    });
    const varFile = join(runRoot, "sealed.pkrvars.json");
    await writeExclusive(varFile, Buffer.from(`${canonicalJsonV1({
      source_template_vmid: reservation.sourceTemplate.vmId, output_template_vmid: reservation.outputTemplate.vmId,
      output_template_mac: reservation.outputTemplate.macAddress,
      proxmox_node: reservation.node, storage_pool: reservation.storage, build_nonce: reservation.buildNonce,
    })}\n`), 0o600);
    const builderApi = new CurlApiV1({ apiUrl: reservation.apiUrl, tokenId: reservation.buildTokenId, token: buildToken, reservation, caFile });
    const attestorApi = new CurlApiV1({ apiUrl: reservation.apiUrl, tokenId: reservation.attestorTokenId, token: attestToken, reservation, caFile });
    const volumeAttestor = new SshVolumeAttestorV1({ reservation, knownHosts: volumeKnownHosts, identityFile: volumeIdentity });
    await volumeAttestor.initialize();
    const packer = new PackerBoundaryV1({ packerBin, pluginBin, runRoot, operationRoot: stateRoot, sourceRoot: sealedV1Root, token: buildToken, reservation, varFile, caFile });
    const { openGoldenImageJournalV1, reconcileGoldenImageBuildV1 } = await import("./golden-image-recovery.mjs");
    const journal = await openGoldenImageJournalV1(stateRoot, reservation);
    const receiptStore = { async commit(receipt) {
      if (!SHA256.test(receipt.attestationDigest) || !SHA256.test(receipt.goldenImage?.digest)) fail("INVALID_ATTESTATION", "content-addressed receipt digests are invalid");
      const path = join(attestationRoot, `${receipt.attestationDigest.slice(7)}.json`);
      const bytes = Buffer.from(`${canonicalJsonV1(receipt)}\n`); const existing = await lstat(path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.uid !== process.getuid() || (existing.mode & 0o777) !== 0o400 || await realpath(path) !== path || !(await readFile(path)).equals(bytes)) {
          fail("INVALID_ATTESTATION", "existing content-addressed receipt differs");
        }
      } else await writeExclusive(path, bytes, 0o400);
      return path;
    }, async read(attestationDigest) {
      if (!SHA256.test(attestationDigest ?? "")) fail("INVALID_ATTESTATION", "receipt lookup digest is invalid");
      const path = join(attestationRoot, `${attestationDigest.slice(7)}.json`); const info = await lstat(path).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o400 || await realpath(path) !== path) fail("INVALID_ATTESTATION", "content-addressed receipt is unavailable or unsafe");
      let value; try { value = JSON.parse(await readFile(path, "utf8")); } catch { fail("INVALID_ATTESTATION", "content-addressed receipt is malformed"); }
      if (value.attestationDigest !== attestationDigest || !Buffer.from(`${canonicalJsonV1(value)}\n`).equals(await readFile(path))) fail("INVALID_ATTESTATION", "content-addressed receipt bytes or digest differ");
      return value;
    } };
    let committedReceipt = null;
    if (journal.mode === "created" && !cleanupOnly) {
      validateGoldenImageReservationV1(reservation);
      await packer.initialize();
      committedReceipt = await runGoldenImageBuildV1({ reservation, immutableInputs, builderApi, attestorApi, volumeAttestor, packer, receiptStore, journal });
    } else {
      const outcome = await reconcileGoldenImageBuildV1({ reservation, immutableInputs, builderApi, attestorApi, volumeAttestor, packer, receiptStore, journal }, { cleanupOnly });
      if (outcome.state === "retry-admitted" && !cleanupOnly) {
        validateGoldenImageReservationV1(reservation);
        await packer.initialize();
        committedReceipt = await runGoldenImageBuildV1({ reservation, immutableInputs, builderApi, attestorApi, volumeAttestor, packer, receiptStore, journal });
      } else if (outcome.state === "committed") committedReceipt = outcome.receipt;
      else process.stdout.write(`${canonicalJsonV1(outcome)}\n`);
    }
    if (committedReceipt) {
      const path = join(attestationRoot, `${committedReceipt.attestationDigest.slice(7)}.json`);
      process.stdout.write(`${canonicalJsonV1({ goldenImage: committedReceipt.goldenImage, attestationDigest: committedReceipt.attestationDigest, path })}\n`);
    }
  } finally {
    buildToken.erase(); attestToken.erase();
    if (runRoot && runRoot.startsWith(`${stateRoot}${sep}nelos-golden-run.`)) {
      const info = await lstat(runRoot).catch(() => null);
      if (info?.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid()) await rm(runRoot, { recursive: true, force: false, maxRetries: 0 });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  const entry = process.argv[2] === PACKER_SUPERVISOR_MODE && process.argv.length === 5 ?
    packerSupervisorCliV1(process.argv[3], process.argv[4]) : cli();
  entry.catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error?.code ?? "GOLDEN_IMAGE_BUILD_FAILED", message: error?.message ?? "golden-image build failed", details: error?.details ?? null })}\n`);
    process.exitCode = 1;
  });
}
