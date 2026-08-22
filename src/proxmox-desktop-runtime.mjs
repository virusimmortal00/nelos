import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeDistributionIntegrity,
  pluginCacheIdentity,
  readRequiredProvenance,
  SOURCE_REPOSITORY,
} from "./distribution-provenance.mjs";
import { readProductionGuestTaskIntentV1 } from "./production-guest-task.mjs";
import {
  expectedLeaseAuthorityIdentityV1,
  leaseAuthorityBindingFromObservationV1,
  validateLeaseAuthorityObservationV1,
} from "./proxmox-lease-authority.mjs";
import { SEALED_SOURCE_PATHS_V1 } from "../validation/proxmox-desktop/v1/build-golden-image.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAC_ADDRESS = /^02(?::[0-9A-F]{2}){5}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TERMINAL_TASK_STATES = new Set(["stopped", "completed", "failed"]);
const ALLOWED_GUEST_OPERATIONS = new Set(["auth-status", "gui-ready", "capture", "diagnostics"]);
const ALLOWED_HOST_OPERATIONS = new Set(["read", "clone", "start", "stop", "destroy"]);
const INSTALLED_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_ALGORITHM_V2 = "nelos-proxmox-desktop-volume-recipe-config-v2";
const GOLDEN_IMAGE_ID_V1 = "nelos-desktop-ubuntu-24-04-v1";
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const PVE_CONFIG_DIGEST = /^[0-9a-f]{40}$/u;
const VOLUME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*:(?:base|vm)-[1-9][0-9]{2,8}-[A-Za-z0-9._-]+$/u;
const FORBIDDEN_GOLDEN_CONFIG_KEYS = new Set([
  "args", "cicustom", "cipassword", "hookscript", "ivshmem", "nameserver", "searchdomain", "sshkeys", "tpmstate0", "vmstate",
]);
const PRODUCTION_PROXMOX_LANE_V1 = Object.freeze({ gatewayId: "9023", hostId: "prox2", networkId: "nelosbld", providerId: "proxmox-lab" });

export class ProxmoxDesktopError extends Error {
  constructor(code, message, path = "") {
    super(message);
    this.name = "ProxmoxDesktopError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "") {
  throw new ProxmoxDesktopError(code, message, path);
}

function object(value, fields, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_CONTRACT", "expected object", path);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("INVALID_CONTRACT", "object fields do not match closed contract", path);
  }
  return value;
}

function string(value, path, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) fail("INVALID_CONTRACT", "invalid string", path);
  return value;
}

function integer(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("INVALID_CONTRACT", "invalid integer", path);
  return value;
}

function exact(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : canonical(value));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function computeInstalledGoldenBuildInputsV1(root, sourceCommit, candidateDigest) {
  const hashes = {};
  for (const sourcePath of SEALED_SOURCE_PATHS_V1) {
    try { hashes[sourcePath] = sha256(await readFile(join(root, sourcePath))); }
    catch { fail("CANDIDATE_INTEGRITY_MISMATCH", "installed candidate lacks an exact golden-image build input", `/candidate/${sourcePath}`); }
  }
  const recipeEntries = Object.entries(hashes).filter(([path]) => path.includes("/desktop/helpers/") || path.includes("/desktop/recipe-v1/") ||
    path.endsWith("provision-golden-image.sh") || path.endsWith("ubuntu.sources") || path.endsWith("nelos-proxmox-volume-measure.py"));
  return Object.freeze({
    candidateDigest,
    packageLockDigest: hashes["validation/proxmox-desktop/v1/package-lock.json"],
    packerHclDigest: hashes["validation/proxmox-desktop/v1/golden-image.pkr.hcl"],
    recipeDigest: sha256(Object.fromEntries(recipeEntries)),
    sourceCommit,
    sourceInputsDigest: sha256(hashes),
    toolchainLockDigest: hashes["validation/proxmox/toolchain.lock.json"],
    wrapperDigest: hashes["validation/proxmox-desktop/v1/build-golden-image.mjs"],
  });
}

export async function verifyInstalledNelosCandidateV1(expectedDigest, { packageRoot = INSTALLED_PACKAGE_ROOT } = {}) {
  if (!SHA256.test(expectedDigest ?? "")) fail("CANDIDATE_INTEGRITY_MISMATCH", "admitted candidate digest is invalid", "/candidateDigest");
  if (!isAbsolute(packageRoot ?? "") || resolve(packageRoot) === "/") fail("CANDIDATE_INTEGRITY_MISMATCH", "installed candidate root is invalid", "/candidate");
  const root = resolve(packageRoot);
  let rootInfo; let canonicalRoot;
  try { rootInfo = await lstat(root); canonicalRoot = await realpath(root); }
  catch { fail("CANDIDATE_INTEGRITY_MISMATCH", "installed candidate root is unavailable", "/candidate"); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || canonicalRoot !== root) fail("CANDIDATE_INTEGRITY_MISMATCH", "installed candidate root is not one canonical directory", "/candidate");
  let provenance; let actualIntegrity; let packageManifest;
  try {
    provenance = await readRequiredProvenance(join(root, "distribution-provenance.json"));
    actualIntegrity = await computeDistributionIntegrity(root);
    packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    fail("CANDIDATE_INTEGRITY_MISMATCH", "installed candidate provenance or bytes are unverifiable", "/candidate");
  }
  if (provenance.sourceRevisionType !== "git" || !GIT_COMMIT.test(provenance.sourceRevision ?? "") || !SHA256.test(provenance.integrity ?? "") ||
      provenance.sourceRepository !== SOURCE_REPOSITORY || provenance.cacheIdentity !== pluginCacheIdentity({ version: provenance.revision }) ||
      packageManifest?.name !== "nelos" || packageManifest?.version !== provenance.revision ||
      !exact(actualIntegrity, provenance.integrity) || !exact(actualIntegrity, expectedDigest)) {
    fail("CANDIDATE_INTEGRITY_MISMATCH", "installed candidate bytes, provenance, source revision, and admitted digest do not match", "/candidate");
  }
  const goldenImageInputs = await computeInstalledGoldenBuildInputsV1(root, provenance.sourceRevision, actualIntegrity);
  return Object.freeze({
    candidateDigest: actualIntegrity,
    goldenImageInputs,
    sourceCommit: provenance.sourceRevision,
    provenanceDigest: sha256(provenance),
    revision: provenance.revision,
  });
}

function splitConfigOptions(value, delimiter = ",") {
  return typeof value === "string" ? value.split(delimiter).filter(Boolean) : [];
}

function goldenDiskStorage(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*:[^,\s]+(?:,[^\r\n]*)?$/u.test(value)) return null;
  return value.slice(0, value.indexOf(":"));
}

function validateImmutableGoldenOutputConfigV1(config, reservation) {
  const failConfig = () => fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image output differs from the immutable Desktop recipe", "/goldenImageReceipt/output/config");
  if (config === null || typeof config !== "object" || Array.isArray(config)) failConfig();
  for (const key of FORBIDDEN_GOLDEN_CONFIG_KEYS) if (Object.hasOwn(config, key)) failConfig();
  const networkKeys = Object.keys(config).filter((key) => /^net[0-9]+$/u.test(key)).sort();
  const ipConfigKeys = Object.keys(config).filter((key) => /^ipconfig[0-9]+$/u.test(key)).sort();
  const diskKeys = Object.keys(config).filter((key) => /^(?:efidisk|ide|sata|scsi|virtio)[0-9]+$/u.test(key)).sort();
  const network = splitConfigOptions(config.net0);
  const cloudInit = splitConfigOptions(config.ide2);
  const macs = network.filter((item) => /^virtio=[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/u.test(item));
  const ownership = /^nelos-golden-v1:([0-9a-f]{32})$/u.exec(config.description ?? "");
  const tags = splitConfigOptions(config.tags, ";").sort();
  if (reservation.outputTemplate.name !== GOLDEN_IMAGE_ID_V1 || reservation.outputTemplate.macAddress !== "02:4E:45:4C:90:27" || reservation.sourceTemplate.vmId === reservation.outputTemplate.vmId ||
      config.name !== GOLDEN_IMAGE_ID_V1 || Number(config.template) !== 1 || Number(config.cores) !== 4 || Number(config.sockets) !== 1 ||
      Number(config.memory) !== 8192 || !["x86-64-v2-AES", "cputype=x86-64-v2-AES"].includes(config.cpu) || config.machine !== "q35" ||
      config.bios !== "ovmf" || config.scsihw !== "virtio-scsi-single" || config.vga !== "virtio" ||
      (config.onboot !== undefined && Number(config.onboot) !== 0) || (config.protection !== undefined && Number(config.protection) !== 0) ||
      !splitConfigOptions(config.agent).includes("enabled=1") || config.ciuser !== "ubuntu" || config.ipconfig0 !== "ip=dhcp" ||
      !ownership || tags.join("\0") !== ["nelos-golden", `nelos-build-${ownership?.[1] ?? ""}`].sort().join("\0") ||
      networkKeys.join("\0") !== "net0" || ipConfigKeys.join("\0") !== "ipconfig0" || network.length < 3 || macs.length !== 1 ||
      !network.includes(`virtio=${reservation.outputTemplate.macAddress}`) ||
      !network.includes("bridge=nelosbld") || !network.includes("firewall=1") || cloudInit[0]?.split(":")[0] !== reservation.storage || !cloudInit.includes("media=cdrom") ||
      diskKeys.join("\0") !== ["efidisk0", "ide2", "scsi0"].sort().join("\0") ||
      [config.scsi0, config.efidisk0, config.ide2].some((disk) => goldenDiskStorage(disk) !== reservation.storage)) failConfig();
  return true;
}

function goldenPersistentVolumes(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return null;
  const volumes = Object.entries(config)
    .filter(([key]) => /^(?:efidisk|ide|sata|scsi|virtio)[0-9]+$/u.test(key))
    .map(([diskKey, value]) => ({ diskKey, volumeId: typeof value === "string" ? value.split(",", 1)[0] : null }))
    .filter(({ volumeId }) => volumeId && !volumeId.endsWith(":cloudinit"))
    .sort((left, right) => left.diskKey < right.diskKey ? -1 : left.diskKey > right.diskKey ? 1 : 0);
  return volumes.length > 0 && volumes.every(({ volumeId }) => VOLUME_ID.test(volumeId)) ? volumes : null;
}

function goldenVolumeMeasurementContent(value) {
  return {
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
  };
}

function validateGoldenVolumeMeasurementV2(value, { reservation, role, config: measuredConfig = null }) {
  const path = `/goldenImageReceipt/volumeAttestation/${role}`;
  object(value, [
    "attestorFingerprint", "configDigest", "contentDigest", "helperDigest", "measuredAt", "name", "node", "providerId", "role", "schemaVersion",
    "status", "storage", "vmId", "volumes",
  ], path);
  const template = role === "source" ? reservation.sourceTemplate : reservation.outputTemplate;
  if (value.schemaVersion !== 1 || value.role !== role || value.status !== "stopped" || value.providerId !== reservation.providerId ||
      value.node !== reservation.node || value.storage !== reservation.storage || value.vmId !== template.vmId || value.name !== template.name ||
      value.helperDigest !== reservation.volumeAttestor.helperDigest || value.attestorFingerprint !== reservation.volumeAttestor.identityFingerprint ||
      typeof value.measuredAt !== "string" || !Number.isFinite(Date.parse(value.measuredAt))) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", `${role} volume measurement identity differs`, path);
  }
  string(value.configDigest, `${path}/configDigest`, SHA256);
  string(value.contentDigest, `${path}/contentDigest`, SHA256);
  const expectedConfigDigest = role === "source" ? reservation.sourceTemplate.configDigest : sha256(measuredConfig);
  if (value.configDigest !== expectedConfigDigest || (role === "source" && value.contentDigest !== reservation.sourceTemplate.volumeMeasurementDigest)) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", `${role} volume measurement configuration or reservation binding differs`, path);
  }
  const expectedVolumes = measuredConfig ? goldenPersistentVolumes(measuredConfig) : null;
  if (!Array.isArray(value.volumes) || value.volumes.length < 1 || (expectedVolumes && value.volumes.length !== expectedVolumes.length)) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", `${role} persistent-volume measurement set differs`, `${path}/volumes`);
  }
  const volumeIds = new Set();
  for (let index = 0; index < value.volumes.length; index += 1) {
    const volume = value.volumes[index];
    object(volume, ["byteLength", "digest", "diskKey", "volumeId"], `${path}/volumes/${index}`);
    string(volume.diskKey, `${path}/volumes/${index}/diskKey`, /^(?:efidisk|ide|sata|scsi|virtio)[0-9]+$/u);
    string(volume.volumeId, `${path}/volumes/${index}/volumeId`, VOLUME_ID);
    string(volume.digest, `${path}/volumes/${index}/digest`, SHA256);
    integer(volume.byteLength, `${path}/volumes/${index}/byteLength`, 1, 274_877_906_944);
    if (!volume.volumeId.startsWith(`${reservation.storage}:`) || volumeIds.has(volume.volumeId) ||
        (expectedVolumes && (volume.diskKey !== expectedVolumes[index].diskKey || volume.volumeId !== expectedVolumes[index].volumeId))) {
      fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", `${role} persistent-volume identity differs`, `${path}/volumes/${index}`);
    }
    volumeIds.add(volume.volumeId);
  }
  if (value.contentDigest !== sha256(goldenVolumeMeasurementContent(value))) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", `${role} volume measurement content digest differs`, `${path}/contentDigest`);
  }
  return goldenVolumeMeasurementContent(value);
}

function validateGoldenImageAttestationV1(receipt, { config, candidateVerification }) {
  object(receipt, ["attestationDigest", "buildArtifact", "goldenImage", "immutableInputs", "independentAttestation", "kind", "output", "reservation", "schemaVersion", "volumeAttestation"], "/goldenImageReceipt");
  if (receipt.schemaVersion !== 2 || receipt.kind !== "nelos-proxmox-desktop-golden-image-v2") fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image receipt kind or schema differs", "/goldenImageReceipt");
  string(receipt.attestationDigest, "/goldenImageReceipt/attestationDigest", SHA256);

  object(receipt.reservation, ["apiUrl", "networkAclPath", "node", "outputTemplate", "providerId", "reservationId", "sourceArtifact", "sourceTemplate", "storage", "tlsCaDigest", "volumeAttestor"], "/goldenImageReceipt/reservation");
  for (const field of ["node", "providerId", "reservationId", "storage"]) string(receipt.reservation[field], `/goldenImageReceipt/reservation/${field}`);
  if (receipt.reservation.providerId !== "proxmox-lab") fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image provider differs from the production Proxmox identity", "/goldenImageReceipt/reservation/providerId");
  let apiUrl;
  try { apiUrl = new URL(receipt.reservation.apiUrl); } catch { fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image receipt API identity is invalid", "/goldenImageReceipt/reservation/apiUrl"); }
  if (apiUrl.protocol !== "https:" || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash || apiUrl.pathname !== "/api2/json") fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image receipt API identity is invalid", "/goldenImageReceipt/reservation/apiUrl");
  string(receipt.reservation.networkAclPath, "/goldenImageReceipt/reservation/networkAclPath", /^\/sdn\/zones\/nelosbld\/nelosbld$/u);
  string(receipt.reservation.tlsCaDigest, "/goldenImageReceipt/reservation/tlsCaDigest", SHA256);
  object(receipt.reservation.sourceArtifact, ["digest", "name", "signatureFingerprint", "signatureScheme"], "/goldenImageReceipt/reservation/sourceArtifact");
  if (receipt.reservation.sourceArtifact.name !== "ubuntu-24.04-server-cloudimg-amd64.img" ||
      receipt.reservation.sourceArtifact.digest !== "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe" ||
      receipt.reservation.sourceArtifact.signatureScheme !== "openpgp-detached-sha256sums" ||
      receipt.reservation.sourceArtifact.signatureFingerprint !== "843938DF228D22F7B3742BC0D94AA3F0EFE21092") {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image Ubuntu source artifact differs from the immutable lock", "/goldenImageReceipt/reservation/sourceArtifact");
  }
  object(receipt.reservation.volumeAttestor, ["helperDigest", "hostKeyFingerprint", "identityFingerprint", "sshHost", "sshPort", "sshUser"], "/goldenImageReceipt/reservation/volumeAttestor");
  string(receipt.reservation.volumeAttestor.helperDigest, "/goldenImageReceipt/reservation/volumeAttestor/helperDigest", SHA256);
  string(receipt.reservation.volumeAttestor.hostKeyFingerprint, "/goldenImageReceipt/reservation/volumeAttestor/hostKeyFingerprint", SSH_FINGERPRINT);
  string(receipt.reservation.volumeAttestor.identityFingerprint, "/goldenImageReceipt/reservation/volumeAttestor/identityFingerprint", SSH_FINGERPRINT);
  string(receipt.reservation.volumeAttestor.sshHost, "/goldenImageReceipt/reservation/volumeAttestor/sshHost", /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u);
  string(receipt.reservation.volumeAttestor.sshUser, "/goldenImageReceipt/reservation/volumeAttestor/sshUser", /^[a-z_][a-z0-9_-]{0,31}$/u);
  integer(receipt.reservation.volumeAttestor.sshPort, "/goldenImageReceipt/reservation/volumeAttestor/sshPort", 1, 65_535);
  object(receipt.reservation.sourceTemplate, ["configDigest", "name", "vmId", "volumeMeasurementDigest"], "/goldenImageReceipt/reservation/sourceTemplate");
  object(receipt.reservation.outputTemplate, ["macAddress", "name", "vmId"], "/goldenImageReceipt/reservation/outputTemplate");
  if (receipt.reservation.outputTemplate.macAddress !== "02:4E:45:4C:90:27") fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image output MAC differs", "/goldenImageReceipt/reservation/outputTemplate/macAddress");
  string(receipt.reservation.sourceTemplate.configDigest, "/goldenImageReceipt/reservation/sourceTemplate/configDigest", SHA256);
  string(receipt.reservation.sourceTemplate.volumeMeasurementDigest, "/goldenImageReceipt/reservation/sourceTemplate/volumeMeasurementDigest", SHA256);
  for (const [name, template] of Object.entries({ sourceTemplate: receipt.reservation.sourceTemplate, outputTemplate: receipt.reservation.outputTemplate })) {
    string(template.name, `/goldenImageReceipt/reservation/${name}/name`, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
    integer(template.vmId, `/goldenImageReceipt/reservation/${name}/vmId`, 100, 999_999_999);
  }

  object(receipt.immutableInputs, ["candidateArchiveDigest", "candidateDigest", "packageLockDigest", "packerHclDigest", "recipeDigest", "sourceCommit", "sourceInputsDigest", "toolchainLockDigest", "wrapperDigest"], "/goldenImageReceipt/immutableInputs");
  for (const field of ["candidateArchiveDigest", "candidateDigest", "packageLockDigest", "packerHclDigest", "recipeDigest", "sourceInputsDigest", "toolchainLockDigest", "wrapperDigest"]) string(receipt.immutableInputs[field], `/goldenImageReceipt/immutableInputs/${field}`, SHA256);
  string(receipt.immutableInputs.sourceCommit, "/goldenImageReceipt/immutableInputs/sourceCommit", GIT_COMMIT);
  for (const [field, expectedDigest] of Object.entries(candidateVerification.goldenImageInputs)) {
    if (receipt.immutableInputs[field] !== expectedDigest) fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image build input differs from the verified installed candidate", `/goldenImageReceipt/immutableInputs/${field}`);
  }

  object(receipt.buildArtifact, ["artifactId", "builderId", "machineOutputDigest", "target"], "/goldenImageReceipt/buildArtifact");
  if (receipt.buildArtifact.target !== "desktop.proxmox-clone.desktop" || receipt.buildArtifact.builderId !== "proxmox.clone" || receipt.buildArtifact.artifactId !== String(receipt.reservation.outputTemplate.vmId)) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image build artifact identity differs", "/goldenImageReceipt/buildArtifact");
  }
  string(receipt.buildArtifact.machineOutputDigest, "/goldenImageReceipt/buildArtifact/machineOutputDigest", SHA256);

  object(receipt.output, ["config", "configDigest", "providerConfigDigest", "status", "template"], "/goldenImageReceipt/output");
  if (receipt.output.config === null || typeof receipt.output.config !== "object" || Array.isArray(receipt.output.config) || Object.hasOwn(receipt.output.config, "digest") ||
      receipt.output.status !== "stopped" || receipt.output.template !== true || !SHA256.test(receipt.output.configDigest ?? "") ||
      (receipt.output.providerConfigDigest !== null && !PVE_CONFIG_DIGEST.test(receipt.output.providerConfigDigest ?? "")) || receipt.output.configDigest !== sha256(receipt.output.config)) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image output configuration attestation differs", "/goldenImageReceipt/output");
  }

  object(receipt.goldenImage, ["algorithm", "digest", "imageId", "templateVmId"], "/goldenImageReceipt/goldenImage");
  if (receipt.goldenImage.algorithm !== GOLDEN_ALGORITHM_V2) fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image digest algorithm differs", "/goldenImageReceipt/goldenImage/algorithm");
  string(receipt.goldenImage.digest, "/goldenImageReceipt/goldenImage/digest", SHA256);
  string(receipt.goldenImage.imageId, "/goldenImageReceipt/goldenImage/imageId");
  string(receipt.goldenImage.templateVmId, "/goldenImageReceipt/goldenImage/templateVmId", /^[1-9][0-9]{2,8}$/u);
  if (receipt.goldenImage.imageId !== receipt.reservation.outputTemplate.name || receipt.goldenImage.templateVmId !== String(receipt.reservation.outputTemplate.vmId) ||
      receipt.output.config.name !== receipt.goldenImage.imageId || Number(receipt.output.config.template) !== 1) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image output name, VMID, or template marker differs", "/goldenImageReceipt/goldenImage");
  }
  validateImmutableGoldenOutputConfigV1(receipt.output.config, receipt.reservation);

  const measuredOutputConfig = receipt.output.providerConfigDigest === null ? receipt.output.config : { ...receipt.output.config, digest: receipt.output.providerConfigDigest };
  object(receipt.volumeAttestation, ["output", "source"], "/goldenImageReceipt/volumeAttestation");
  const sourceVolumes = validateGoldenVolumeMeasurementV2(receipt.volumeAttestation.source, { reservation: receipt.reservation, role: "source" });
  const outputVolumes = validateGoldenVolumeMeasurementV2(receipt.volumeAttestation.output, { reservation: receipt.reservation, role: "output", config: measuredOutputConfig });

  object(receipt.independentAttestation, ["observedAt", "tokenId", "volumeAttestorFingerprint"], "/goldenImageReceipt/independentAttestation");
  if (typeof receipt.independentAttestation.tokenId !== "string" || receipt.independentAttestation.tokenId.length < 1 || receipt.independentAttestation.tokenId.length > 256 ||
      typeof receipt.independentAttestation.observedAt !== "string" || !Number.isFinite(Date.parse(receipt.independentAttestation.observedAt)) ||
      receipt.independentAttestation.volumeAttestorFingerprint !== receipt.reservation.volumeAttestor.identityFingerprint) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image independent attestation identity differs", "/goldenImageReceipt/independentAttestation");
  }

  const { attestationDigest, ...unsigned } = receipt;
  if (sha256(unsigned) !== attestationDigest) fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image attestation digest differs", "/goldenImageReceipt/attestationDigest");
  const expectedGoldenDigest = sha256({
    schemaVersion: 2,
    domain: GOLDEN_ALGORITHM_V2,
    immutableInputs: receipt.immutableInputs,
    sourceArtifact: receipt.reservation.sourceArtifact,
    sourceTemplate: receipt.reservation.sourceTemplate,
    outputConfig: receipt.output.config,
    sourceVolumes,
    outputVolumes,
  });
  if (receipt.goldenImage.digest !== expectedGoldenDigest) fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image volume/recipe/config digest differs", "/goldenImageReceipt/goldenImage/digest");

  const expected = {
    imageId: config.run.goldenImage.imageId,
    digest: config.run.goldenImage.digest,
    templateVmId: String(config.plan.goldenImageTemplateVmId),
    providerId: config.run.provider.providerId,
    node: config.run.provider.hostId,
    sourceCommit: candidateVerification.sourceCommit,
  };
  for (const [actual, wanted, path] of [
    [receipt.goldenImage.imageId, expected.imageId, "/goldenImageReceipt/goldenImage/imageId"],
    [receipt.goldenImage.digest, expected.digest, "/goldenImageReceipt/goldenImage/digest"],
    [receipt.goldenImage.templateVmId, expected.templateVmId, "/goldenImageReceipt/goldenImage/templateVmId"],
    [receipt.reservation.providerId, expected.providerId, "/goldenImageReceipt/reservation/providerId"],
    [receipt.reservation.node, expected.node, "/goldenImageReceipt/reservation/node"],
    [receipt.immutableInputs.sourceCommit, expected.sourceCommit, "/goldenImageReceipt/immutableInputs/sourceCommit"],
  ]) if (actual !== wanted) fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image receipt is not bound to the admitted run", path);

  return Object.freeze({
    attestationDigest,
    goldenImageDigest: receipt.goldenImage.digest,
    hostId: receipt.reservation.node,
    imageId: receipt.goldenImage.imageId,
    outputConfigDigest: receipt.output.configDigest,
    packageLockDigest: receipt.immutableInputs.packageLockDigest,
    providerId: receipt.reservation.providerId,
    sourceCommit: receipt.immutableInputs.sourceCommit,
    templateVmId: receipt.goldenImage.templateVmId,
  });
}

function providerStatus(error) {
  return error?.status ?? error?.statusCode ?? error?.response?.status;
}

export async function readProxmoxVm(provider, binding) {
  if (typeof provider?.readVm !== "function") fail("HELPER_UNAVAILABLE", "provider read helper is unavailable", "/provider/readVm");
  validateBinding(binding);
  try {
    const vm = await provider.readVm(binding);
    if (vm === null || typeof vm !== "object" || Array.isArray(vm)) fail("AMBIGUOUS_EFFECT", "provider returned an ambiguous VM read");
    return vm;
  } catch (error) {
    if (providerStatus(error) === 404) return null;
    throw error;
  }
}

export async function mutateProxmoxVm(provider, operation, binding, {
  deadlineMs = 120_000,
  pollIntervalMs = 1_000,
  now = Date.now,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  if (!ALLOWED_HOST_OPERATIONS.has(operation) || operation === "read") fail("OPERATION_DENIED", "host operation is not allowlisted", "/operation");
  validateBinding(binding);
  if (typeof provider?.mutateVm !== "function" || typeof provider?.readTask !== "function") {
    fail("HELPER_UNAVAILABLE", "provider mutation helpers are unavailable", "/provider");
  }
  integer(deadlineMs, "/deadlineMs", 1, 600_000);
  integer(pollIntervalMs, "/pollIntervalMs", 1, deadlineMs);
  const started = now();
  const accepted = await provider.mutateVm(operation, binding);
  if (accepted === null || typeof accepted !== "object" || typeof accepted.taskId !== "string" || !ID.test(accepted.taskId)) {
    fail("AMBIGUOUS_EFFECT", "provider mutation did not return one task identity");
  }
  let polls = 0;
  while (now() - started <= deadlineMs) {
    const task = await provider.readTask({ ...binding, taskId: accepted.taskId });
    polls += 1;
    if (task === null || typeof task !== "object" || Array.isArray(task) || typeof task.state !== "string") {
      fail("AMBIGUOUS_EFFECT", "provider task observation is ambiguous");
    }
    if (TERMINAL_TASK_STATES.has(task.state)) {
      if ((task.state === "completed" || task.state === "stopped") && task.exitStatus === "OK") {
        return Object.freeze({ operation, taskId: accepted.taskId, terminalState: task.state, exitStatus: task.exitStatus ?? "OK", polls });
      }
      fail("PROVIDER_TASK_FAILED", `provider task ${accepted.taskId} ended in ${task.state}:${task.exitStatus ?? "unknown"}`);
    }
    await wait(pollIntervalMs);
  }
  fail("PROVIDER_TASK_TIMEOUT", `provider task ${accepted.taskId} did not reach a terminal result before its deadline`);
}

export function validateBinding(binding, path = "/binding") {
  object(binding, ["fencingToken", "gatewayId", "hostId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "vmid"], path);
  for (const field of ["runId", "providerId", "hostId", "leaseId", "fencingToken", "networkId"]) string(binding[field], `${path}/${field}`);
  string(binding.gatewayId, `${path}/gatewayId`, /^[1-9][0-9]{2,8}$/u);
  string(binding.macAddress, `${path}/macAddress`, MAC_ADDRESS);
  string(binding.networkPolicyDigest, `${path}/networkPolicyDigest`, SHA256);
  integer(binding.vmid, `${path}/vmid`, 100, 999_999_999);
  if (String(binding.vmid) === binding.gatewayId) fail("IDENTITY_MISMATCH", "gateway and disposable VM identities must differ", `${path}/gatewayId`);
  const laneMismatch = Object.entries(PRODUCTION_PROXMOX_LANE_V1).find(([field, expected]) => binding[field] !== expected);
  if (laneMismatch) {
    fail("IDENTITY_MISMATCH", "production binding must use the fixed prox2 gateway VM 9023 and nelosbld VNet identity", `${path}/${laneMismatch[0]}`);
  }
  return binding;
}

export function validateNetworkPolicyObservationV1(value, {
  binding,
  marginMs = 120_000,
  maxObservationAgeMs = 30_000,
  now = Date.now(),
} = {}) {
  object(value, ["complete", "expiresAt", "gateway", "installed", "kind", "measurement", "networkId", "networkPolicyDigest", "observationDigest", "observedAt", "schemaVersion"], "/networkPolicyObservation");
  if (value.schemaVersion !== 1 || value.kind !== "nelos.proxmox-desktop.network-policy-observation.v1" ||
      value.complete !== true || value.installed !== true) {
    fail("NETWORK_POLICY_NOT_INSTALLED", "network policy observation is not one complete installed-policy proof", "/networkPolicyObservation");
  }
  object(value.gateway, ["configDigest", "hostId", "providerId", "vmId"], "/networkPolicyObservation/gateway");
  for (const field of ["hostId", "providerId"]) string(value.gateway[field], `/networkPolicyObservation/gateway/${field}`);
  string(value.gateway.vmId, "/networkPolicyObservation/gateway/vmId", /^[1-9][0-9]{2,8}$/u);
  string(value.gateway.configDigest, "/networkPolicyObservation/gateway/configDigest", SHA256);
  string(value.networkId, "/networkPolicyObservation/networkId");
  string(value.networkPolicyDigest, "/networkPolicyObservation/networkPolicyDigest", SHA256);
  string(value.observationDigest, "/networkPolicyObservation/observationDigest", SHA256);
  object(value.measurement, ["approvedAddressCount", "approvedAddressInventoryDigest", "complete", "expiresAt", "forwardPolicy", "helper", "kind", "measurementDigest", "networkId", "observedAt", "policyDigest", "rulesetBytes", "rulesetDigest", "schemaVersion", "unexpectedForwardAccepts"], "/networkPolicyObservation/measurement");
  object(value.measurement.helper, ["digest", "path"], "/networkPolicyObservation/measurement/helper");
  if (value.measurement.schemaVersion !== 1 || value.measurement.kind !== "nelos.proxmox-desktop.gateway-policy-measurement.v1" ||
      value.measurement.complete !== true || value.measurement.forwardPolicy !== "drop" || value.measurement.unexpectedForwardAccepts !== 0 ||
      value.measurement.helper.path !== "/usr/libexec/nelos-network-policy-observer") {
    fail("NETWORK_POLICY_NOT_INSTALLED", "gateway measurement is not the fixed complete deny-by-default policy proof", "/networkPolicyObservation/measurement");
  }
  integer(value.measurement.approvedAddressCount, "/networkPolicyObservation/measurement/approvedAddressCount", 1, 64);
  integer(value.measurement.rulesetBytes, "/networkPolicyObservation/measurement/rulesetBytes", 1, 1_048_576);
  for (const field of ["approvedAddressInventoryDigest", "measurementDigest", "policyDigest", "rulesetDigest"]) string(value.measurement[field], `/networkPolicyObservation/measurement/${field}`, SHA256);
  string(value.measurement.helper.digest, "/networkPolicyObservation/measurement/helper/digest", SHA256);
  string(value.measurement.networkId, "/networkPolicyObservation/measurement/networkId");
  for (const field of ["observedAt", "expiresAt"]) string(value.measurement[field], `/networkPolicyObservation/measurement/${field}`, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  const { measurementDigest, ...unsignedMeasurement } = value.measurement;
  if (sha256(unsignedMeasurement) !== measurementDigest) fail("NETWORK_POLICY_DIGEST_MISMATCH", "gateway policy measurement digest differs", "/networkPolicyObservation/measurement/measurementDigest");
  const policyIdentity = {
    approvedAddressInventoryDigest: value.measurement.approvedAddressInventoryDigest,
    kind: "nelos.proxmox-desktop.gateway-policy-identity.v1",
    networkId: value.measurement.networkId,
    rulesetDigest: value.measurement.rulesetDigest,
    schemaVersion: 1,
  };
  if (sha256(policyIdentity) !== value.measurement.policyDigest) fail("NETWORK_POLICY_DIGEST_MISMATCH", "gateway policy identity digest differs", "/networkPolicyObservation/measurement/policyDigest");
  if (value.measurement.networkId !== value.networkId || value.measurement.policyDigest !== value.networkPolicyDigest || value.measurement.expiresAt !== value.expiresAt) {
    fail("NETWORK_POLICY_IDENTITY_MISMATCH", "gateway measurement differs from the admitted VNet, complete ruleset/address identity, or actual element expiry", "/networkPolicyObservation/measurement");
  }
  for (const field of ["observedAt", "expiresAt"]) string(value[field], `/networkPolicyObservation/${field}`, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(marginMs) || marginMs < 1 || !Number.isSafeInteger(maxObservationAgeMs) || maxObservationAgeMs < 0) {
    fail("INVALID_CONTRACT", "network-policy freshness bounds are invalid", "/networkPolicyObservation");
  }
  const observedAt = Date.parse(value.observedAt);
  const measuredAt = Date.parse(value.measurement.observedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(measuredAt) || !Number.isFinite(expiresAt) ||
      observedAt > now + 5_000 || measuredAt > now + 5_000 || now - observedAt > maxObservationAgeMs || now - measuredAt > maxObservationAgeMs ||
      expiresAt <= now + marginMs) {
    fail("NETWORK_POLICY_OBSERVATION_STALE", "network policy observation is stale or lacks cleanup margin", "/networkPolicyObservation");
  }
  const { observationDigest, ...unsigned } = value;
  if (sha256(unsigned) !== observationDigest) fail("NETWORK_POLICY_DIGEST_MISMATCH", "network policy observation digest differs", "/networkPolicyObservation/observationDigest");
  const expected = {
    hostId: binding?.hostId,
    providerId: binding?.providerId,
    vmId: binding?.gatewayId,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value.gateway[field] !== expectedValue) fail("NETWORK_POLICY_IDENTITY_MISMATCH", `network policy gateway differs at ${field}`, `/networkPolicyObservation/gateway/${field}`);
  }
  if (value.networkId !== binding?.networkId || value.networkPolicyDigest !== binding?.networkPolicyDigest) {
    fail("NETWORK_POLICY_IDENTITY_MISMATCH", "installed network policy differs from the admitted VNet or digest", "/networkPolicyObservation");
  }
  return Object.freeze(structuredClone(value));
}

function validateLeaseAuthorityBinding(binding, path = "/leaseAuthority") {
  object(binding, ["authorityId", "epoch", "issuedRecordDigest", "issuedRecordFileDigest", "issuedRevision", "trustDigest"], path);
  string(binding.authorityId, `${path}/authorityId`);
  integer(binding.epoch, `${path}/epoch`, 1);
  integer(binding.issuedRevision, `${path}/issuedRevision`, 1);
  for (const field of ["issuedRecordDigest", "issuedRecordFileDigest", "trustDigest"]) string(binding[field], `${path}/${field}`, SHA256);
  return binding;
}

export function validateHelperRequest(request, expected, { now = Date.now() } = {}) {
  object(request, ["binding", "deadlineAt", "maxOutputBytes", "operation"], "/request");
  validateBinding(request.binding, "/request/binding");
  validateBinding(expected, "/expected");
  if (![...ALLOWED_HOST_OPERATIONS, ...ALLOWED_GUEST_OPERATIONS].includes(request.operation)) fail("OPERATION_DENIED", "helper operation is not allowlisted", "/request/operation");
  integer(request.maxOutputBytes, "/request/maxOutputBytes", 1, 1_048_576);
  if (typeof request.deadlineAt !== "string" || !Number.isFinite(Date.parse(request.deadlineAt)) || Date.parse(request.deadlineAt) <= now) {
    fail("DEADLINE_EXPIRED", "helper deadline is invalid or expired", "/request/deadlineAt");
  }
  if (Date.parse(request.deadlineAt) - now > 600_000) fail("INVALID_CONTRACT", "helper deadline exceeds ten minutes", "/request/deadlineAt");
  for (const field of Object.keys(expected)) {
    if (request.binding[field] !== expected[field]) fail("IDENTITY_MISMATCH", `helper binding differs at ${field}`, `/request/binding/${field}`);
  }
  return request;
}

function validateLease(lease, binding, now, { requireFreshObservation = true } = {}) {
  object(lease, ["active", "binding", "expiresAt", "observedAt"], "/packet/lease");
  validateBinding(lease.binding, "/packet/lease/binding");
  if (lease.active !== true || Object.keys(binding).some((field) => lease.binding[field] !== binding[field])) {
    fail("LEASE_NOT_CURRENT", "packet lease or fencing token is not current", "/packet/lease");
  }
  const observed = Date.parse(lease.observedAt);
  const expires = Date.parse(lease.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now + 5_000 ||
      (requireFreshObservation && (now - observed > 30_000 || expires <= now)) || observed >= expires) {
    fail("STALE_OBSERVATION", "lease observation is stale or expired", "/packet/lease");
  }
}

export function validateRunPacket(envelope, { now = Date.now(), authorize, recovery = false } = {}) {
  object(envelope, ["digest", "packet"], "/envelope");
  string(envelope.digest, "/envelope/digest", SHA256);
  if (!exact(envelope.digest, sha256(envelope.packet))) fail("PACKET_DIGEST_MISMATCH", "run packet is not content-addressed", "/envelope/digest");
  const packet = envelope.packet;
  object(packet, ["authorization", "binding", "budgets", "capture", "expectedTask", "goldenImageReceipt", "lease", "leaseAuthority", "roots", "schemaVersion"], "/packet");
  if (packet.schemaVersion !== 1) fail("INVALID_CONTRACT", "unsupported run packet schema", "/packet/schemaVersion");
  validateBinding(packet.binding, "/packet/binding");
  validateLeaseAuthorityBinding(packet.leaseAuthority, "/packet/leaseAuthority");
  validateLease(packet.lease, packet.binding, now, { requireFreshObservation: recovery !== true });
  object(packet.expectedTask, ["intentDigest", "intentPath", "taskSlotId", "title"], "/packet/expectedTask");
  string(packet.expectedTask.taskSlotId, "/packet/expectedTask/taskSlotId", /^task-slot-[0-9a-f]{64}$/u);
  string(packet.expectedTask.title, "/packet/expectedTask/title", /^.{1,160}$/u);
  string(packet.expectedTask.intentDigest, "/packet/expectedTask/intentDigest", SHA256);
  string(packet.expectedTask.intentPath, "/packet/expectedTask/intentPath", /^\/(?:[^/\0]+\/)*[^/\0]+$/u);
  object(packet.goldenImageReceipt, ["attestationDigest", "path"], "/packet/goldenImageReceipt");
  string(packet.goldenImageReceipt.attestationDigest, "/packet/goldenImageReceipt/attestationDigest", SHA256);
  string(packet.goldenImageReceipt.path, "/packet/goldenImageReceipt/path", /^\/(?:[^/\0]+\/)*[^/\0]+$/u);
  object(packet.budgets, ["captureCount", "runDeadlineAt", "stepDeadlineMs"], "/packet/budgets");
  integer(packet.budgets.captureCount, "/packet/budgets/captureCount", 1, 100);
  integer(packet.budgets.stepDeadlineMs, "/packet/budgets/stepDeadlineMs", 1, 600_000);
  const runDeadline = Date.parse(packet.budgets.runDeadlineAt);
  if (!Number.isFinite(runDeadline) || (recovery !== true && runDeadline <= now)) fail("DEADLINE_EXPIRED", "run deadline is expired", "/packet/budgets/runDeadlineAt");
  object(packet.capture, ["height", "protectedRegions", "width"], "/packet/capture");
  integer(packet.capture.width, "/packet/capture/width", 640, 7680);
  integer(packet.capture.height, "/packet/capture/height", 480, 4320);
  if (!Array.isArray(packet.capture.protectedRegions)) fail("INVALID_CONTRACT", "protected regions must be an array", "/packet/capture/protectedRegions");
  for (const [index, region] of packet.capture.protectedRegions.entries()) validateRegion(region, packet.capture, `/packet/capture/protectedRegions/${index}`);
  object(packet.roots, ["evidence", "packet", "recovery", "staging"], "/packet/roots");
  for (const [name, root] of Object.entries(packet.roots)) {
    object(root, ["gid", "mode", "path", "sealed", "uid"], `/packet/roots/${name}`);
    string(root.path, `/packet/roots/${name}/path`, /^\/(?:[^/\0]+\/)*[^/\0]+$/u);
    integer(root.uid, `/packet/roots/${name}/uid`);
    integer(root.gid, `/packet/roots/${name}/gid`);
    if (root.sealed !== true || !["0500", "0550", "0700", "0750"].includes(root.mode)) fail("UNSEALED_ROOT", "run root is not sealed", `/packet/roots/${name}`);
  }
  object(packet.authorization, ["gateId", "runId", "used"], "/packet/authorization");
  string(packet.authorization.gateId, "/packet/authorization/gateId");
  if (packet.authorization.runId !== packet.binding.runId || packet.authorization.used !== false || typeof authorize !== "function" || authorize(packet.authorization) !== true) {
    fail("AUTHORIZATION_REQUIRED", "one-run authorization gate was not accepted", "/packet/authorization");
  }
  return packet;
}

function productionBindingFor(config) {
  const vmid = Number(config?.run?.provider?.vmId);
  if (!Number.isSafeInteger(vmid)) fail("IDENTITY_MISMATCH", "production VMID must be a numeric Proxmox identity", "/run/provider/vmId");
  return validateBinding({
    fencingToken: config.run.lease.fencingToken,
    gatewayId: config.run.provider.gatewayId,
    hostId: config.run.provider.hostId,
    leaseId: config.run.lease.leaseId,
    macAddress: config.run.provider.macAddress,
    networkId: config.run.provider.networkId,
    networkPolicyDigest: config.run.provider.networkPolicyDigest,
    providerId: config.run.provider.providerId,
    runId: config.run.runId,
    vmid,
  }, "/run/provider");
}

function recoveryAttestorBindingFor(config) {
  return {
    automationUser: config.plan.automation.user,
    fencingToken: config.run.lease.fencingToken,
    gatewayId: config.run.provider.gatewayId,
    hostId: config.run.provider.hostId,
    imageId: config.run.goldenImage.imageId,
    leaseId: config.run.lease.leaseId,
    macAddress: config.run.provider.macAddress,
    networkId: config.run.provider.networkId,
    networkPolicyDigest: config.run.provider.networkPolicyDigest,
    providerId: config.run.provider.providerId,
    runId: config.run.runId,
    stateRoot: config.plan.automation.stateRoot,
    vmId: config.run.provider.vmId,
  };
}

function sameIdentity(actual, expected, path) {
  for (const [field, value] of Object.entries(expected)) if (actual?.[field] !== value) fail("IDENTITY_MISMATCH", `${field} is not bound to the production run`, `${path}/${field}`);
}

function validateInitialLeaseAuthorityForConfig(config, packet) {
  let observation;
  try {
    validateLeaseAuthorityBinding(packet?.leaseAuthority, "/runPacket/packet/leaseAuthority");
    observation = validateLeaseAuthorityObservationV1(config?.leaseAuthority, {
      expected: expectedLeaseAuthorityIdentityV1({ authorityBinding: packet.leaseAuthority, run: config.run }),
      requireIssue: true,
      requireState: "active",
    });
  } catch (error) {
    fail(
      error?.code === "INVALID_CONTRACT" ? "LEASE_AUTHORITY_MISMATCH" : error?.code ?? "LEASE_AUTHORITY_MISMATCH",
      error?.message ?? "initial lease-authority observation is invalid",
      error?.path ?? "/leaseAuthority",
    );
  }
  const derived = leaseAuthorityBindingFromObservationV1(observation);
  if (!exact(sha256(derived), sha256(packet.leaseAuthority))) {
    fail("LEASE_AUTHORITY_MISMATCH", "packet authority binding differs from the immutable issued record", "/runPacket/packet/leaseAuthority");
  }
  const lease = observation.record.lease;
  if (packet.lease.observedAt !== observation.observedAt || packet.lease.expiresAt !== lease.expiresAt ||
      config.run.lease.state !== "active" || config.run.lease.leaseId !== lease.leaseId ||
      config.run.lease.holderId !== lease.holderId || config.run.lease.fencingToken !== lease.fencingToken ||
      config.run.lease.expiresAt !== lease.expiresAt) {
    fail("LEASE_AUTHORITY_MISMATCH", "run and packet lease fields differ from the authoritative issue record", "/leaseAuthority/record/lease");
  }
  return observation;
}

export function validateProductionConfigBindingV1(config, packet, { configPath = null } = {}) {
  const expectedBinding = productionBindingFor(config);
  sameIdentity(packet.binding, expectedBinding, "/runPacket/packet/binding");
  sameIdentity(packet.lease.binding, expectedBinding, "/runPacket/packet/lease/binding");
  if (packet.lease.expiresAt !== config.run.lease.expiresAt || packet.lease.active !== (config.run.lease.state === "active")) {
    fail("LEASE_NOT_CURRENT", "packet lease lifetime or state differs from the immutable run", "/runPacket/packet/lease");
  }
  const leaseAuthority = validateInitialLeaseAuthorityForConfig(config, packet);
  if (!Array.isArray(config.run.scenarios) || config.run.scenarios.length !== 1) fail("INVALID_CONTRACT", "production v1 requires exactly one pre-created scenario task", "/run/scenarios");
  const scenario = config.run.scenarios[0];
  if (packet.expectedTask.taskSlotId !== scenario.task.taskId || packet.expectedTask.title !== scenario.scenarioId || scenario.task.fresh !== true || scenario.task.createdForScenario !== scenario.scenarioId) {
    fail("TASK_SURFACE_MISMATCH", "packet expected task intent does not match the sole fresh scenario slot", "/runPacket/packet/expectedTask");
  }
  if (packet.authorization.runId !== config.run.runId) fail("AUTHORIZATION_REQUIRED", "authorization gate belongs to another run", "/runPacket/packet/authorization/runId");
  if (Date.parse(packet.budgets.runDeadlineAt) > Date.parse(config.run.lease.expiresAt)) fail("STALE_OBSERVATION", "run deadline exceeds the owned lease", "/runPacket/packet/budgets/runDeadlineAt");
  if (packet.budgets.stepDeadlineMs < Math.max(scenario.deadlineMs, ...scenario.actions.map(({ timeoutMs }) => timeoutMs))) fail("INVALID_CONTRACT", "packet step deadline underdeclares the scenario", "/runPacket/packet/budgets/stepDeadlineMs");
  const screenshots = config.plan?.evidence?.screenshots;
  if (!Array.isArray(screenshots) || packet.budgets.captureCount < screenshots.length || packet.budgets.captureCount > config.run.policy?.screenshots?.maxCount) fail("INVALID_CONTRACT", "packet capture count is not bound to the evidence policy", "/runPacket/packet/budgets/captureCount");
  const evidenceRoot = resolve(packet.roots.evidence.path);
  const packetRoot = resolve(packet.roots.packet.path);
  const recoveryRoot = resolve(packet.roots.recovery.path);
  const stagingRoot = resolve(packet.roots.staging.path);
  const expectedTaskIntentPath = join(packetRoot, `production-task-intent-${packet.expectedTask.intentDigest.slice(7)}.json`);
  if (resolve(packet.expectedTask.intentPath) !== expectedTaskIntentPath) fail("TASK_INTENT_BINDING_MISMATCH", "expected guest task intent is not content-addressed inside the packet root", "/runPacket/packet/expectedTask");
  const expectedGoldenReceiptPath = join(packetRoot, `golden-image-${packet.goldenImageReceipt.attestationDigest.slice(7)}.json`);
  if (resolve(packet.goldenImageReceipt.path) !== expectedGoldenReceiptPath) fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image receipt is not content-addressed inside the packet root", "/runPacket/packet/goldenImageReceipt");
  if (resolve(config.plan.evidence.bundleDirectory) !== join(evidenceRoot, "bundle")) fail("UNSEALED_ROOT", "evidence bundle is not below the declared evidence root", "/plan/evidence/bundleDirectory");
  for (const [path, label] of [[config.homelab?.sealedValueRoot, "sealed values"], [config.homelab?.observationRoot, "observations"]]) {
    if (!isAbsolute(path ?? "") || !resolve(path).startsWith(`${stagingRoot}${sep}`)) fail("UNSEALED_ROOT", `${label} are not below the declared staging root`, "/homelab");
  }
  if (!isAbsolute(config.journalDirectory ?? "") || dirname(resolve(config.journalDirectory)) !== resolve(config.homelab?.stateRoot ?? "")) fail("UNSEALED_ROOT", "journal is not below the isolated runtime state root", "/journalDirectory");
  if (configPath !== null && (!isAbsolute(configPath) || dirname(resolve(configPath)) !== packetRoot)) fail("UNSEALED_ROOT", "run config is not in the declared packet root", "/configPath");
  return Object.freeze({ binding: expectedBinding, evidenceRoot, leaseAuthority, packetRoot, recoveryRoot, stagingRoot });
}

function validateCurrentLeaseObservationV1(value, { config, packet, now }) {
  object(value, ["authorityObservation", "authorityObservationDigest", "kind", "observationDigest", "schemaVersion"], "/currentLeaseObservation");
  if (value.schemaVersion !== 2 || value.kind !== "nelos.proxmox-desktop.current-lease-observation.v2") {
    fail("LEASE_NOT_CURRENT", "external current-lease observation kind or schema differs", "/currentLeaseObservation");
  }
  string(value.authorityObservationDigest, "/currentLeaseObservation/authorityObservationDigest", SHA256);
  string(value.observationDigest, "/currentLeaseObservation/observationDigest", SHA256);
  const { observationDigest, ...unsigned } = value;
  if (sha256(unsigned) !== observationDigest) fail("LEASE_NOT_CURRENT", "external current-lease observation digest differs", "/currentLeaseObservation/observationDigest");
  if (sha256(value.authorityObservation) !== value.authorityObservationDigest) {
    fail("LEASE_NOT_CURRENT", "current authority observation digest differs", "/currentLeaseObservation/authorityObservationDigest");
  }
  let authorityObservation;
  try {
    authorityObservation = validateLeaseAuthorityObservationV1(value.authorityObservation, {
      expected: expectedLeaseAuthorityIdentityV1({ authorityBinding: packet.leaseAuthority, run: config.run }),
      maxObservationAgeMs: 30_000,
      marginMs: 0,
      now,
    });
  } catch (error) {
    fail(error?.code ?? "LEASE_NOT_CURRENT", error?.message ?? "authoritative current lease is invalid", error?.path ?? "/currentLeaseObservation/authorityObservation");
  }
  if (authorityObservation.record.revision < packet.leaseAuthority.issuedRevision ||
      authorityObservation.record.epoch !== packet.leaseAuthority.epoch ||
      authorityObservation.authorityId !== packet.leaseAuthority.authorityId ||
      authorityObservation.trustDigest !== packet.leaseAuthority.trustDigest) {
    fail("LEASE_SUPERSEDED", "current authority revision is not in the admitted lease epoch", "/currentLeaseObservation/authorityObservation/record");
  }
  if (authorityObservation.record.revision === packet.leaseAuthority.issuedRevision &&
      (authorityObservation.recordDigest !== packet.leaseAuthority.issuedRecordDigest ||
       authorityObservation.recordFileDigest !== packet.leaseAuthority.issuedRecordFileDigest)) {
    fail("LEASE_SUPERSEDED", "issued authority revision differs from the admitted immutable record", "/currentLeaseObservation/authorityObservation/record");
  }
  return Object.freeze(structuredClone(value));
}

async function readCurrentLeaseObservation(path, root, context) {
  if (!isAbsolute(path ?? "")) fail("LEASE_NOT_CURRENT", "an absolute external current-lease observation path is required", "/currentLeaseObservationPath");
  const target = resolve(path);
  const recoveryRoot = resolve(root.path);
  let canonicalRoot;
  try { canonicalRoot = await realpath(recoveryRoot); }
  catch { fail("LEASE_NOT_CURRENT", "trusted recovery root is unavailable", "/currentLeaseObservationPath"); }
  const nameMatch = /^current-lease-([0-9a-f]{64})\.json$/u.exec(basename(target));
  if (canonicalRoot !== recoveryRoot || target !== path || dirname(target) !== recoveryRoot || nameMatch === null) {
    fail("LEASE_NOT_CURRENT", "external current-lease observation is outside the canonical trusted recovery root", "/currentLeaseObservationPath");
  }
  let before; let handle;
  try {
    before = await lstat(target);
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    fail("LEASE_NOT_CURRENT", "external current-lease observation is unavailable", "/currentLeaseObservationPath");
  }
  let bytes; let storage;
  try {
    const info = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.dev !== info.dev || before.ino !== info.ino ||
        !info.isFile() || info.nlink !== 1 || info.uid !== root.uid || info.gid !== root.gid ||
        (info.mode & 0o777) !== 0o400 || info.size < 2 || info.size > 16_384) {
      fail("LEASE_NOT_CURRENT", "external current-lease observation ownership, mode, type, or path differs", "/currentLeaseObservationPath");
    }
    storage = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < storage.length) {
      const { bytesRead } = await handle.read(storage, offset, storage.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    bytes = storage.subarray(0, offset);
    const after = await handle.stat();
    const stableFields = ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeMs", "ctimeMs"];
    if (bytes.length !== info.size || stableFields.some((field) => info[field] !== after[field])) {
      fail("LEASE_NOT_CURRENT", "external current-lease observation changed while it was read", "/currentLeaseObservationPath");
    }
    let value;
    try { value = JSON.parse(bytes); }
    catch { fail("LEASE_NOT_CURRENT", "external current-lease observation is not valid JSON", "/currentLeaseObservationPath"); }
    const canonicalBytes = Buffer.from(`${canonical(value)}\n`);
    try {
      if (!bytes.equals(canonicalBytes)) fail("LEASE_NOT_CURRENT", "external current-lease observation encoding differs", "/currentLeaseObservationPath");
    } finally { canonicalBytes.fill(0); }
    if (`sha256:${nameMatch[1]}` !== value.observationDigest) fail("LEASE_NOT_CURRENT", "external current-lease observation filename and digest differ", "/currentLeaseObservationPath");
    return validateCurrentLeaseObservationV1(value, context);
  } finally {
    if (storage) storage.fill(0);
    await handle.close();
  }
}

export async function createCurrentLeaseObservationV1(config, { configPath, observeRootBinding, clock = Date } = {}) {
  if (!isAbsolute(configPath ?? "") || typeof observeRootBinding !== "function" || typeof clock?.now !== "function") {
    fail("INVALID_CONTRACT", "current-lease observation requires one absolute config path, independent attestor, and clock", "/currentLeaseObservation");
  }
  const startedAt = clock.now();
  const packet = validateRunPacket(config?.runPacket, { now: startedAt, recovery: true, authorize: () => true });
  const layout = validateProductionConfigBindingV1(config, packet, { configPath });
  await validateSealedRoots(packet.roots);
  await validatePacketConfigFile(configPath, packet.roots.packet, sha256(config));
  if (packet.roots.recovery.mode !== "0700") fail("UNSEALED_ROOT", "trusted recovery root must be mode 0700 before writing an observation", "/runPacket/packet/roots/recovery");
  const binding = recoveryAttestorBindingFor(config);
  const deadline = startedAt + 20_000;
  if (!Number.isFinite(startedAt)) fail("LEASE_NOT_CURRENT", "controller clock is invalid", "/currentLeaseObservation");
  const maxOutputBytes = Math.min(config.homelab?.outputLimits?.providerBytes ?? 0, 1_048_576);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) fail("INVALID_CONTRACT", "independent attestor output bound is invalid", "/homelab/outputLimits/providerBytes");
  const attested = await observeRootBinding(Object.freeze({
    binding: Object.freeze(structuredClone(binding)),
    deadlineAt: new Date(deadline).toISOString(),
    maxOutputBytes,
    request: Object.freeze({ method: "GET", path: "/nelos/lease-authority/current" }),
    schemaVersion: 1,
  }));
  const observedAtMs = clock.now();
  if (!Number.isFinite(observedAtMs) || observedAtMs < startedAt || observedAtMs - startedAt > 25_000) {
    fail("LEASE_NOT_CURRENT", "independent authority attestation completed outside its freshness window", "/currentLeaseObservation");
  }
  let authorityObservation;
  try {
    authorityObservation = validateLeaseAuthorityObservationV1(attested, {
      expected: expectedLeaseAuthorityIdentityV1({ authorityBinding: packet.leaseAuthority, run: config.run }),
      maxObservationAgeMs: 30_000,
      marginMs: 0,
      now: observedAtMs,
    });
  } catch (error) {
    fail(error?.code ?? "LEASE_NOT_CURRENT", error?.message ?? "independent authority observation is invalid", error?.path ?? "/attestorObservation");
  }
  const unsigned = {
    authorityObservation: structuredClone(authorityObservation),
    authorityObservationDigest: sha256(authorityObservation),
    kind: "nelos.proxmox-desktop.current-lease-observation.v2",
    schemaVersion: 2,
  };
  const receipt = Object.freeze({ ...unsigned, observationDigest: sha256(unsigned) });
  const target = join(layout.recoveryRoot, `current-lease-${receipt.observationDigest.slice(7)}.json`);
  const bytes = Buffer.from(`${canonical(receipt)}\n`);
  try {
    try {
      const handle = await open(target, "wx", 0o400);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const directory = await open(layout.recoveryRoot, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally { bytes.fill(0); }
  const observed = await readCurrentLeaseObservation(target, packet.roots.recovery, { config, packet, now: observedAtMs });
  return Object.freeze({ path: target, receipt: observed });
}

function authorizationReceiptFor(configDigest, packetDigest, packet) {
  return {
    schemaVersion: 1,
    type: "nelos-production-authorization-receipt",
    configDigest,
    gateId: packet.authorization.gateId,
    runId: packet.binding.runId,
    packetDigest,
    used: true,
  };
}

function admissionVerificationReceiptFor({ binding, candidateVerification, configDigest, goldenImageVerification, leaseAuthority, packetDigest }) {
  const unsigned = {
    schemaVersion: 1,
    type: "nelos-production-admission-verification",
    binding: structuredClone(binding),
    candidate: structuredClone(candidateVerification),
    configDigest,
    goldenImage: structuredClone(goldenImageVerification),
    leaseAuthority: structuredClone(leaseAuthority),
    packetDigest,
  };
  return Object.freeze({ ...unsigned, receiptDigest: sha256(unsigned) });
}

async function readAuthorizationReceipt(path, expected, root) {
  let info;
  try { info = await lstat(path); }
  catch { fail("AUTHORIZATION_REQUIRED", "authorization receipt is unavailable", "/authorizationReceipt"); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== root.uid || info.gid !== root.gid || (info.mode & 0o777) !== 0o400 || info.size > 16_384) fail("AUTHORIZATION_REQUIRED", "authorization receipt is not a sealed regular file", "/authorizationReceipt");
  let observed;
  try { observed = JSON.parse(await readFile(path, "utf8")); } catch { fail("AUTHORIZATION_REQUIRED", "authorization receipt is not valid JSON", "/authorizationReceipt"); }
  if (!exact(sha256(observed), sha256(expected))) fail("AUTHORIZATION_REQUIRED", "authorization receipt identity differs", "/authorizationReceipt");
  return observed;
}

async function validatePacketConfigFile(configPath, root, expectedConfigDigest) {
  if (configPath === null) return;
  const path = resolve(configPath);
  let info;
  try { info = await lstat(path); } catch { fail("UNSEALED_ROOT", "run config is unavailable", "/configPath"); }
  let canonicalPath;
  try { canonicalPath = await realpath(path); } catch { fail("UNSEALED_ROOT", "run config cannot be resolved", "/configPath"); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== root.uid || info.gid !== root.gid || canonicalPath !== path || (info.mode & 0o777) !== 0o400 || info.size > 1_048_576) {
    fail("UNSEALED_ROOT", "run config must be one sealed regular file owned by the packet root identity", "/configPath");
  }
  let observed;
  try { observed = JSON.parse(await readFile(path, "utf8")); } catch { fail("UNSEALED_ROOT", "run config is not valid JSON", "/configPath"); }
  if (!exact(sha256(observed), expectedConfigDigest)) fail("PACKET_DIGEST_MISMATCH", "in-memory run config differs from the sealed packet file", "/configPath");
}

async function readGoldenImageReceipt(path, expectedDigest, root, config, candidateVerification) {
  let info; let canonicalPath;
  try { info = await lstat(path); canonicalPath = await realpath(path); }
  catch { fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "sealed golden-image receipt is unavailable", "/runPacket/packet/goldenImageReceipt"); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== root.uid || info.gid !== root.gid ||
      (info.mode & 0o777) !== 0o400 || info.size < 2 || info.size > 1_048_576 || canonicalPath !== resolve(path) || dirname(canonicalPath) !== resolve(root.path)) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image receipt ownership, mode, type, or path differs", "/runPacket/packet/goldenImageReceipt");
  }
  const bytes = await readFile(canonicalPath);
  try {
    let receipt;
    try { receipt = JSON.parse(bytes); }
    catch { fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image receipt is not valid JSON", "/runPacket/packet/goldenImageReceipt"); }
    if (!bytes.equals(Buffer.from(`${canonical(receipt)}\n`)) || receipt.attestationDigest !== expectedDigest) {
      fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "golden-image receipt encoding or content address differs", "/runPacket/packet/goldenImageReceipt");
    }
    return validateGoldenImageAttestationV1(receipt, { config, candidateVerification });
  } finally { bytes.fill(0); }
}

export async function prepareProductionAdmissionV1(config, { mode = "preflight", configPath = null, currentLeaseObservationPath = null, authorizeLive = false, now = Date.now(), candidateRoot = INSTALLED_PACKAGE_ROOT } = {}) {
  if (!["preflight", "run", "resume", "cancel"].includes(mode)) fail("INVALID_CONTRACT", "production admission mode is invalid", "/mode");
  const candidateVerification = await verifyInstalledNelosCandidateV1(config?.candidateDigest, { packageRoot: candidateRoot });
  if (config?.run?.candidate?.digest !== candidateVerification.candidateDigest) fail("CANDIDATE_INTEGRITY_MISMATCH", "run candidate digest differs from the installed candidate", "/run/candidate/digest");
  const recovery = mode === "resume" || mode === "cancel";
  // The packet's issued lease observation is immutable identity evidence. A
  // separate, freshly attested authority observation gates every mutation.
  const packet = validateRunPacket(config?.runPacket, { now, recovery: true, authorize: () => mode !== "run" || authorizeLive === true });
  const layout = validateProductionConfigBindingV1(config, packet, { configPath });
  await validateSealedRoots(packet.roots);
  const configDigest = sha256(config);
  await validatePacketConfigFile(configPath, packet.roots.packet, configDigest);
  const goldenImageVerification = await readGoldenImageReceipt(
    packet.goldenImageReceipt.path,
    packet.goldenImageReceipt.attestationDigest,
    packet.roots.packet,
    config,
    candidateVerification,
  );
  let taskIntentReceipt;
  try {
    taskIntentReceipt = await readProductionGuestTaskIntentV1({
      path: packet.expectedTask.intentPath,
      digest: packet.expectedTask.intentDigest,
      root: packet.roots.packet,
    });
  } catch (error) {
    fail(error?.code ?? "INVALID_GUEST_TASK_INTENT", "sealed production guest task intent is unavailable or altered", "/runPacket/packet/expectedTask");
  }
  if (taskIntentReceipt.taskSlotId !== packet.expectedTask.taskSlotId || taskIntentReceipt.title !== packet.expectedTask.title ||
      taskIntentReceipt.runId !== config.run.runId || taskIntentReceipt.fencingToken !== config.run.lease.fencingToken ||
      taskIntentReceipt.initialTurnStarted !== false) {
    fail("TASK_INTENT_BINDING_MISMATCH", "production guest task intent differs from the immutable expected task slot", "/runPacket/packet/expectedTask");
  }
  if (mode === "run" && authorizeLive !== true) fail("AUTHORIZATION_REQUIRED", "live run requires the explicit packet-bound authorization gate", "/authorization");
  const mutation = mode !== "preflight";
  const currentLeaseObservation = mutation
    ? await readCurrentLeaseObservation(currentLeaseObservationPath, packet.roots.recovery, { config, packet, now })
    : null;
  const currentAuthorityState = currentLeaseObservation?.authorityObservation?.record?.state ?? null;
  if (mode === "run") {
    const currentLeaseExpiry = Date.parse(currentLeaseObservation.authorityObservation.record.lease.expiresAt);
    const runDeadline = Date.parse(packet.budgets.runDeadlineAt);
    if (currentAuthorityState !== "active" || !Number.isFinite(currentLeaseExpiry) || !Number.isFinite(runDeadline) || runDeadline <= now || currentLeaseExpiry <= runDeadline) {
      fail("LEASE_NOT_ACTIVE", "first-run authority must be active and outlive the immutable run deadline", "/currentLeaseObservation/authorityObservation/record");
    }
  }
  const recoveryMode = recovery
    ? (mode === "cancel" || currentAuthorityState === "cleanup-only" || Date.parse(packet.budgets.runDeadlineAt) <= now ? "cleanup-only" : "continue")
    : null;
  const expectedReceipt = authorizationReceiptFor(configDigest, config.runPacket.digest, packet);
  const receiptPath = join(layout.packetRoot, ".nelos-production-authorization.used.json");
  const verificationReceipt = admissionVerificationReceiptFor({
    binding: layout.binding,
    candidateVerification,
    configDigest,
    goldenImageVerification,
    leaseAuthority: {
      binding: structuredClone(packet.leaseAuthority),
      issuedObservationDigest: sha256(layout.leaseAuthority),
    },
    packetDigest: config.runPacket.digest,
  });
  const admissionBase = {
    binding: layout.binding,
    candidateVerification,
    configDigest,
    configPath: configPath === null ? null : resolve(configPath),
    goldenImageVerification,
    leaseAuthority: {
      binding: structuredClone(packet.leaseAuthority),
      issuedObservationDigest: sha256(layout.leaseAuthority),
    },
    packetDigest: config.runPacket.digest,
    receiptPath,
    runDeadlineAt: packet.budgets.runDeadlineAt,
    roots: packet.roots,
    taskIntentReceipt,
    verificationReceipt,
    verificationReceiptDigest: verificationReceipt.receiptDigest,
    ...(mutation ? {
      currentLeaseObservation,
      currentLeaseObservationDigest: currentLeaseObservation.observationDigest,
      ...(recovery ? { recoveryMode } : {}),
    } : {}),
  };
  if (mode === "preflight") return Object.freeze({ ...admissionBase, gateReceipt: null, gateReceiptDigest: null });
  let receipt;
  if (mode === "run") {
    const bytes = Buffer.from(`${JSON.stringify(expectedReceipt)}\n`);
    try {
      const handle = await open(receiptPath, "wx", 0o400);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const directory = await open(layout.packetRoot, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      receipt = expectedReceipt;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      receipt = await readAuthorizationReceipt(receiptPath, expectedReceipt, packet.roots.packet);
    } finally { bytes.fill(0); }
  } else receipt = await readAuthorizationReceipt(receiptPath, expectedReceipt, packet.roots.packet);
  return Object.freeze({ ...admissionBase, gateReceipt: Object.freeze(receipt), gateReceiptDigest: sha256(receipt) });
}

export async function validateSealedRoots(roots) {
  object(roots, ["evidence", "packet", "recovery", "staging"], "/roots");
  const resolved = [];
  for (const [name, root] of Object.entries(roots)) {
    object(root, ["gid", "mode", "path", "sealed", "uid"], `/roots/${name}`);
    const stat = await lstat(root.path);
    const canonicalPath = await realpath(root.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== root.uid || stat.gid !== root.gid ||
      canonicalPath !== resolve(root.path) || (stat.mode & 0o777).toString(8).padStart(4, "0") !== root.mode || root.sealed !== true) {
      fail("UNSEALED_ROOT", `${name} root ownership, mode, link, or type differs`, `/roots/${name}`);
    }
    resolved.push(resolve(root.path));
  }
  if (new Set(resolved).size !== resolved.length || resolved.some((left, index) => resolved.some((right, other) => index !== other && left.startsWith(`${right}${sep}`)))) {
    fail("UNSEALED_ROOT", "run roots must be distinct and non-nested", "/roots");
  }
  return true;
}

export function validateRegion(region, screen, path = "/region") {
  object(region, ["height", "name", "width", "x", "y"], path);
  string(region.name, `${path}/name`);
  for (const field of ["x", "y", "width", "height"]) integer(region[field], `${path}/${field}`, field === "width" || field === "height" ? 1 : 0);
  if (region.x + region.width > screen.width || region.y + region.height > screen.height) fail("UNSAFE_CAPTURE", "protected region escapes capture geometry", path);
  return region;
}

export function admitCapture({ screen, requested, protectedRegions }) {
  object(requested, ["height", "width", "x", "y"], "/capture/requested");
  const region = { name: "requested", ...requested };
  validateRegion(region, screen, "/capture/requested");
  for (const protectedRegion of protectedRegions) {
    validateRegion(protectedRegion, screen, "/capture/protectedRegions");
    const intersects = requested.x < protectedRegion.x + protectedRegion.width && requested.x + requested.width > protectedRegion.x &&
      requested.y < protectedRegion.y + protectedRegion.height && requested.y + requested.height > protectedRegion.y;
    if (intersects) fail("UNSAFE_CAPTURE", `capture intersects protected region ${protectedRegion.name}`, "/capture/requested");
  }
  return true;
}

export function verifyDeviceAuthIsolation(state, binding) {
  object(state, ["accountBindingDigest", "accountType", "authenticated", "authMethod", "binding", "credentialStore", "developerSessionImported", "schemaVersion"], "/auth");
  object(state.binding, Object.keys(binding), "/auth/binding");
  for (const field of Object.keys(binding)) if (state.binding[field] !== binding[field]) fail("IDENTITY_MISMATCH", `auth binding differs at ${field}`, `/auth/binding/${field}`);
  if (state.schemaVersion !== 1 || state.authenticated !== true || state.accountType !== "chatgpt" ||
      state.authMethod !== "chatgptDeviceCode" || state.credentialStore !== "file" || state.developerSessionImported !== false) {
    fail("AUTH_ISOLATION_FAILED", "device-auth receipt does not prove an isolated ChatGPT file-store login", "/auth");
  }
  string(state.accountBindingDigest, "/auth/accountBindingDigest", SHA256);
  return state;
}

export function validateSanitizedDiagnostics(diagnostics, binding) {
  object(diagnostics, ["binding", "checks", "capturedAt", "schemaVersion"], "/diagnostics");
  if (diagnostics.schemaVersion !== 1) fail("INVALID_CONTRACT", "unsupported diagnostic schema", "/diagnostics/schemaVersion");
  validateBinding(diagnostics.binding, "/diagnostics/binding");
  for (const field of Object.keys(binding)) if (diagnostics.binding[field] !== binding[field]) fail("IDENTITY_MISMATCH", `diagnostic binding differs at ${field}`, `/diagnostics/binding/${field}`);
  if (typeof diagnostics.capturedAt !== "string" || !Number.isFinite(Date.parse(diagnostics.capturedAt))) fail("INVALID_CONTRACT", "diagnostic timestamp is invalid", "/diagnostics/capturedAt");
  object(diagnostics.checks, ["accessibilityBus", "authIsolated", "desktopSession", "guestHelper"], "/diagnostics/checks");
  for (const [name, value] of Object.entries(diagnostics.checks)) if (value !== "ready") fail("DIAGNOSTIC_NOT_READY", `${name} is not ready`, `/diagnostics/checks/${name}`);
  return diagnostics;
}

export function compareTaskSurfaces(expected, surfaces) {
  object(expected, ["lifecycle", "taskId", "title"], "/expectedTask");
  if (!["active", "completed"].includes(expected.lifecycle)) fail("INVALID_CONTRACT", "expected lifecycle must be active or completed", "/expectedTask/lifecycle");
  object(surfaces, ["desktop", "mcp", "native"], "/surfaces");
  for (const [name, surface] of Object.entries(surfaces)) {
    object(surface, ["lifecycle", "taskId", "title"], `/surfaces/${name}`);
    if (surface.taskId !== expected.taskId || surface.title !== expected.title || surface.lifecycle !== expected.lifecycle) {
      fail("TASK_SURFACE_MISMATCH", `task identity or lifecycle differs on ${name}`, `/surfaces/${name}`);
    }
  }
  return true;
}

export function assertPreDestroyCollection(events) {
  if (!Array.isArray(events)) fail("INVALID_CONTRACT", "events must be an array", "/events");
  const destroy = events.indexOf("destroy");
  for (const required of ["checkpoint-screenshot", "diagnostics", "inventory-draft"]) {
    const index = events.indexOf(required);
    if (index === -1 || destroy === -1 || index > destroy) fail("CLEANUP_ORDER_VIOLATION", `${required} must precede destroy`, "/events");
  }
  return true;
}

async function walk(root, current = root) {
  const entries = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    if (entry.isSymbolicLink()) fail("EVIDENCE_LINK_FORBIDDEN", "evidence contains a symbolic link", `/${rel}`);
    if (entry.isDirectory()) entries.push(...await walk(root, path));
    else if (entry.isFile()) entries.push({ path, rel });
    else fail("EVIDENCE_TYPE_FORBIDDEN", "evidence contains a non-regular file", `/${rel}`);
  }
  return entries;
}

export async function attestEvidenceInventory(root, inventory, { expectedUid, expectedGid, expectedPacketDigest } = {}) {
  object(inventory, ["binding", "files", "manifestReferences", "packetDigest", "schemaVersion"], "/inventory");
  if (inventory.schemaVersion !== 1) fail("INVALID_CONTRACT", "unsupported inventory schema", "/inventory/schemaVersion");
  validateBinding(inventory.binding, "/inventory/binding");
  string(inventory.packetDigest, "/inventory/packetDigest", SHA256);
  string(expectedPacketDigest, "/expectedPacketDigest", SHA256);
  if (!exact(inventory.packetDigest, expectedPacketDigest)) fail("PACKET_DIGEST_MISMATCH", "inventory is not bound to the independently supplied packet", "/inventory/packetDigest");
  if (!Array.isArray(inventory.files)) fail("INVALID_CONTRACT", "inventory files must be an array", "/inventory/files");
  if (!Array.isArray(inventory.manifestReferences) || inventory.manifestReferences.some((path) => typeof path !== "string")) {
    fail("INVALID_CONTRACT", "manifest references must be a string array", "/inventory/manifestReferences");
  }
  const disk = await walk(root);
  const inventoryNames = new Set(inventory.files.map((file) => file.path));
  if (inventoryNames.size !== inventory.files.length) fail("EVIDENCE_INVENTORY_MISMATCH", "inventory contains duplicate references", "/inventory/files");
  for (const item of disk) {
    if (!inventoryNames.has(item.rel)) fail("EVIDENCE_UNREFERENCED_FILE", `unreferenced evidence file ${item.rel}`);
  }
  if (disk.length !== inventory.files.length) fail("EVIDENCE_INVENTORY_MISMATCH", "inventory references a missing file", "/inventory/files");
  const references = new Set(inventory.manifestReferences);
  if (references.size !== inventory.manifestReferences.length || references.size !== inventory.files.length || [...inventoryNames].some((path) => !references.has(path))) {
    fail("EVIDENCE_REFERENCE_MISMATCH", "manifest references do not bind every inventory file exactly once", "/inventory/manifestReferences");
  }
  const requiredRoles = new Set(["archive-visual-report", "checkpoint-screenshot", "diagnostics"]);
  for (const file of inventory.files) {
    object(file, ["length", "path", "role", "sha256"], "/inventory/files/*");
    string(file.path, "/inventory/files/*/path", /^(?!\/|.*(?:^|\/)\.\.(?:\/|$)).+$/u);
    string(file.role, "/inventory/files/*/role", /^[a-z][a-z0-9-]{0,63}$/u);
    requiredRoles.delete(file.role);
    string(file.sha256, "/inventory/files/*/sha256", SHA256);
    integer(file.length, "/inventory/files/*/length");
    const path = resolve(root, file.path);
    if (!path.startsWith(`${resolve(root)}${sep}`)) fail("EVIDENCE_PATH_ESCAPE", "inventory path escapes evidence root", "/inventory/files/*/path");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("EVIDENCE_LINK_FORBIDDEN", "inventory target is not a regular non-link file", `/${file.path}`);
    if (expectedUid !== undefined && stat.uid !== expectedUid) fail("EVIDENCE_OWNER_MISMATCH", "evidence UID differs", `/${file.path}`);
    if (expectedGid !== undefined && stat.gid !== expectedGid) fail("EVIDENCE_OWNER_MISMATCH", "evidence GID differs", `/${file.path}`);
    const bytes = await readFile(path);
    if (bytes.length !== file.length || !exact(sha256(bytes), file.sha256)) fail("EVIDENCE_HASH_MISMATCH", `evidence bytes differ for ${file.path}`);
  }
  if (requiredRoles.size > 0) fail("EVIDENCE_REQUIRED_ROLE_MISSING", `inventory lacks ${[...requiredRoles].join(",")}`, "/inventory/files");
  return Object.freeze({ files: disk.length, packetDigest: inventory.packetDigest, binding: inventory.binding });
}

export const PROXMOX_DESKTOP_ALLOWED_OPERATIONS = Object.freeze({
  guest: Object.freeze([...ALLOWED_GUEST_OPERATIONS]),
  host: Object.freeze([...ALLOWED_HOST_OPERATIONS]),
});
