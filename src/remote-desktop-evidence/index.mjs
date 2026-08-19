import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import {
  emptyRemoteDesktopUsage,
  validateRemoteDesktopEvidenceExportV1,
  validateRemoteDesktopRunV1,
  validateRemoteDesktopUsage,
} from "../remote-desktop-contract/index.mjs";
import { assertNoSymlinkComponents, ensureCanonicalDirectory, pathInfo } from "../path-safety.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_RELATIVE_PATH = /^(?:artifacts|exports)\/[0-9a-f]{64}\.(?:json|png|jpg|mp4)$/u;
const VISUAL_CLASSES = new Set(["conversation", "prompt", "response", "account", "sign_in", "credential"]);
const DIAGNOSTIC_SOURCES = Object.freeze(["desktop_runtime", "window_manager", "assertion_runner"]);
const DIAGNOSTIC_FIELDS = Object.freeze(["component", "event", "status", "outcome", "windowCount", "durationMs", "errorCode"]);
const FORBIDDEN_KEY = /(?:prompt|response|token|cookie|credential|password|passwd|secret|authorization|session|environment|stdout|stderr)/iu;
const FORBIDDEN_TEXT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/iu,
  /\b(?:sk|sk-proj|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|cookie|authorization)\s*[=:]\s*\S+/iu,
];
const USAGE_FIELDS = Object.freeze(Object.keys(emptyRemoteDesktopUsage()));

export const REMOTE_DESKTOP_DIAGNOSTIC_SOURCES_V1 = DIAGNOSTIC_SOURCES;
export const REMOTE_DESKTOP_DIAGNOSTIC_FIELDS_V1 = DIAGNOSTIC_FIELDS;
export const REMOTE_DESKTOP_VISUAL_PROTECTION_CLASSES_V1 = Object.freeze([...VISUAL_CLASSES]);

export class RemoteDesktopEvidenceError extends Error {
  constructor(code, message, path = "") {
    super(message);
    this.name = "RemoteDesktopEvidenceError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "") {
  throw new RemoteDesktopEvidenceError(code, message, path);
}

function plainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_EVIDENCE", "expected a plain object", path);
  return value;
}

function closed(value, fields, path) {
  plainObject(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("INVALID_EVIDENCE", "object fields do not match the closed evidence schema", path);
  }
  return value;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function jsonBytes(value) {
  return Buffer.from(`${canonicalize(value)}\n`, "utf8");
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertFiniteUsage(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("INVALID_BUDGET", "usage delta must be finite and non-negative", path);
}

export function assertProposedRemoteDesktopUsageV1(current, proposedDelta, policy) {
  closed(current, USAGE_FIELDS, "/currentUsage");
  closed(proposedDelta, USAGE_FIELDS, "/proposedDelta");
  const projected = {};
  for (const field of USAGE_FIELDS) {
    assertFiniteUsage(current[field], `/currentUsage/${field}`);
    assertFiniteUsage(proposedDelta[field], `/proposedDelta/${field}`);
    projected[field] = current[field] + proposedDelta[field];
  }
  validateRemoteDesktopUsage(projected, policy);
  return Object.freeze(projected);
}

export function validateRemoteDesktopExportV1(value, run) {
  return validateRemoteDesktopEvidenceExportV1(value, run);
}

function rect(value, path, width, height) {
  closed(value, ["x", "y", "width", "height"], path);
  for (const field of ["x", "y", "width", "height"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < (field === "width" || field === "height" ? 1 : 0)) fail("UNCERTAIN_PROTECTION_GEOMETRY", "rectangle is invalid", `${path}/${field}`);
  }
  if (value.x + value.width > width || value.y + value.height > height) fail("UNCERTAIN_PROTECTION_GEOMETRY", "rectangle is outside the captured frame", path);
  return value;
}

function contains(outer, inner) {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

function intersects(left, right) {
  return left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height;
}

function sanitizeFrame(frame, width, height, path) {
  closed(frame, ["rgba", "sensitiveRegions", "protection"], path);
  const rgba = Buffer.isBuffer(frame.rgba) ? frame.rgba : Buffer.from(frame.rgba ?? []);
  if (rgba.byteLength !== width * height * 4) fail("INVALID_EVIDENCE", "RGBA frame byte length does not match its dimensions", `${path}/rgba`);
  if (!Array.isArray(frame.sensitiveRegions)) fail("UNCERTAIN_PROTECTION_GEOMETRY", "sensitive region inventory is required", `${path}/sensitiveRegions`);
  closed(frame.protection, ["geometryCertain", "inventoryComplete", "mode", "regions"], `${path}/protection`);
  if (frame.protection.geometryCertain !== true || frame.protection.inventoryComplete !== true) fail("UNCERTAIN_PROTECTION_GEOMETRY", "complete, certain protection geometry is required", `${path}/protection`);
  if (!Array.isArray(frame.protection.regions) || !["mask", "crop"].includes(frame.protection.mode)) fail("UNCERTAIN_PROTECTION_GEOMETRY", "protection mode and regions are invalid", `${path}/protection`);
  const sensitive = frame.sensitiveRegions.map((item, index) => {
    closed(item, ["class", "region"], `${path}/sensitiveRegions/${index}`);
    if (!VISUAL_CLASSES.has(item.class)) fail("UNCERTAIN_PROTECTION_GEOMETRY", "sensitive region class is not recognized", `${path}/sensitiveRegions/${index}/class`);
    return { ...item, region: rect(item.region, `${path}/sensitiveRegions/${index}/region`, width, height) };
  });
  const protections = frame.protection.regions.map((item, index) => rect(item, `${path}/protection/regions/${index}`, width, height));
  if (frame.protection.mode === "mask") {
    if (sensitive.some(({ region }) => !protections.some((protection) => contains(protection, region)))) fail("UNCERTAIN_PROTECTION_GEOMETRY", "a sensitive region is not fully masked", `${path}/protection/regions`);
    const output = Buffer.from(rgba);
    for (const protection of protections) {
      for (let y = protection.y; y < protection.y + protection.height; y += 1) {
        for (let x = protection.x; x < protection.x + protection.width; x += 1) {
          const offset = (y * width + x) * 4;
          output[offset] = 0; output[offset + 1] = 0; output[offset + 2] = 0; output[offset + 3] = 255;
        }
      }
    }
    return { width, height, rgba: output };
  }
  if (protections.length !== 1) fail("UNCERTAIN_PROTECTION_GEOMETRY", "crop protection requires exactly one retained rectangle", `${path}/protection/regions`);
  const retained = protections[0];
  if (sensitive.some(({ region }) => intersects(retained, region))) fail("UNCERTAIN_PROTECTION_GEOMETRY", "retained crop intersects a sensitive region", `${path}/protection/regions/0`);
  const output = Buffer.alloc(retained.width * retained.height * 4);
  for (let y = 0; y < retained.height; y += 1) {
    rgba.copy(output, y * retained.width * 4, ((retained.y + y) * width + retained.x) * 4, ((retained.y + y) * width + retained.x + retained.width) * 4);
  }
  return { width: retained.width, height: retained.height, rgba: output };
}

let crcTable;
function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, number) => {
    let value = number;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const size = Buffer.alloc(4); size.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

export function encodePngRgba({ width, height, rgba }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || rgba.byteLength !== width * height * 4) fail("INVALID_EVIDENCE", "PNG frame is invalid");
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const target = y * (1 + width * 4); rows[target] = 0; rgba.copy(rows, target + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

export function decodePngRgba(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes ?? []);
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) fail("INVALID_EVIDENCE", "PNG signature is invalid");
  let offset = 8; let width; let height; const compressed = [];
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (offset + 12 + length > bytes.byteLength) fail("INVALID_EVIDENCE", "PNG chunk is truncated");
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) !== bytes.readUInt32BE(offset + 8 + length)) fail("INVALID_EVIDENCE", "PNG chunk checksum is invalid");
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 6) fail("INVALID_EVIDENCE", "PNG must be 8-bit RGBA"); }
    if (type === "IDAT") compressed.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  if (!width || !height || compressed.length === 0) fail("INVALID_EVIDENCE", "PNG lacks required chunks");
  const rows = inflateSync(Buffer.concat(compressed));
  if (rows.byteLength !== height * (1 + width * 4)) fail("INVALID_EVIDENCE", "PNG pixel data length is invalid");
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const source = y * (1 + width * 4);
    if (rows[source] !== 0) fail("INVALID_EVIDENCE", "PNG uses an unsupported row filter");
    rows.copy(rgba, y * width * 4, source + 1, source + 1 + width * 4);
  }
  return { width, height, rgba };
}

function scanForbidden(value, path = "/diagnostic") {
  if (typeof value === "string") {
    if (FORBIDDEN_TEXT.some((pattern) => pattern.test(value))) fail("FORBIDDEN_DIAGNOSTIC", "diagnostic contains forbidden secret material", path);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) fail("FORBIDDEN_DIAGNOSTIC", "diagnostic contains a forbidden field class", `${path}/${key}`);
    scanForbidden(child, `${path}/${key}`);
  }
}

function diagnosticBytes(observation, path) {
  closed(observation, ["source", "diagnosticId", "scenarioId", "code", "occurredAt", "fields"], path);
  if (!DIAGNOSTIC_SOURCES.includes(observation.source)) fail("FORBIDDEN_DIAGNOSTIC", "diagnostic source is not allowlisted", `${path}/source`);
  plainObject(observation.fields, `${path}/fields`);
  for (const [key, value] of Object.entries(observation.fields)) {
    if (!DIAGNOSTIC_FIELDS.includes(key)) fail("FORBIDDEN_DIAGNOSTIC", "diagnostic field is not allowlisted", `${path}/fields/${key}`);
    if (!(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) fail("FORBIDDEN_DIAGNOSTIC", "diagnostic field value must be scalar", `${path}/fields/${key}`);
  }
  scanForbidden(observation);
  return jsonBytes({ schemaVersion: 1, source: observation.source, code: observation.code, occurredAt: observation.occurredAt, fields: observation.fields });
}

function identitiesFor(run) {
  return {
    candidateDigest: run.candidate.digest, desktopBundleDigest: run.desktopBundle.digest,
    goldenImageDigest: run.goldenImage.digest, providerId: run.provider.providerId,
    hostId: run.provider.hostId, vmId: run.provider.vmId, leaseId: run.lease.leaseId,
    fencingToken: run.lease.fencingToken, benchmarkProfileDigest: run.benchmarkProfile.digest,
    scenarioManifestDigest: run.scenarioManifest.digest,
  };
}

function assertExportBindings(evidenceExport, run) {
  const scenarios = new Map(run.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  for (const [index, item] of evidenceExport.visualArtifacts.entries()) {
    if (!scenarios.has(item.scenarioId)) fail("IDENTITY_MISMATCH", "visual artifact refers to an unknown scenario", `/visualArtifacts/${index}/scenarioId`);
  }
  for (const [index, item] of evidenceExport.diagnostics.entries()) {
    if (!scenarios.has(item.scenarioId)) fail("IDENTITY_MISMATCH", "diagnostic refers to an unknown scenario", `/diagnostics/${index}/scenarioId`);
  }
  for (const [index, item] of evidenceExport.actionTimeline.entries()) {
    const action = scenarios.get(item.scenarioId)?.actions.find(({ actionId }) => actionId === item.actionId);
    if (!action || action.type !== item.actionType) fail("IDENTITY_MISMATCH", "timeline action is not bound to its scenario", `/actionTimeline/${index}`);
  }
  for (const [index, item] of evidenceExport.assertionOutcomes.entries()) {
    if (!scenarios.get(item.scenarioId)?.assertions.some(({ assertionId }) => assertionId === item.assertionId)) fail("IDENTITY_MISMATCH", "assertion outcome is not bound to its scenario", `/assertionOutcomes/${index}`);
  }
}

function reference(bytes, mediaType, kind) {
  const contentDigest = digest(bytes);
  const extension = mediaType === "application/json" ? "json" : mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : "mp4";
  return { digest: contentDigest, byteLength: bytes.byteLength, mediaType, kind, relativePath: `${kind === "remote_desktop_export" ? "exports" : "artifacts"}/${contentDigest.slice(7)}.${extension}`, sanitizationPolicy: kind === "diagnostic" ? "closed-diagnostic-v1" : kind === "remote_desktop_export" ? "contract-metadata-v1" : "visual-geometry-v1" };
}

async function writeExclusive(root, ref, bytes) {
  const target = resolve(root, ref.relativePath);
  if (relative(root, target).startsWith(`..${sep}`) || target === root) fail("UNSAFE_PATH", "artifact path escapes the bundle", `/artifacts/${ref.relativePath}`);
  await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(resolve(target, ".."), "evidence namespace", { allowMissing: false });
  const handle = await open(target, "wx", 0o400);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function emptyDelta() { return emptyRemoteDesktopUsage(); }

export async function createRemoteDesktopEvidenceBundleV1({
  bundleDirectory, run, currentUsage = emptyRemoteDesktopUsage(), proposedOperationalUsage,
  scenarioMetadata, screenshots = [], recordings = [], diagnostics = [], actionTimeline,
  assertionOutcomes, cleanupAttestation,
}) {
  validateRemoteDesktopRunV1(run);
  if (!isAbsolute(bundleDirectory)) fail("UNSAFE_PATH", "bundle directory must be absolute", "/bundleDirectory");
  if (!Array.isArray(screenshots) || !Array.isArray(recordings) || !Array.isArray(diagnostics) || recordings.length > 1) fail("INVALID_EVIDENCE", "observation collections are invalid");
  closed(proposedOperationalUsage, ["taskCount", "modelTurnCount", "spendUsd", "wallTimeMs"], "/proposedOperationalUsage");
  const declared = emptyDelta();
  for (const field of ["taskCount", "modelTurnCount", "spendUsd", "wallTimeMs"]) declared[field] = proposedOperationalUsage[field];
  declared.screenshotCount = screenshots.length;
  declared.screenshotBytes = screenshots.reduce((sum, item) => sum + (Number.isSafeInteger(item.maxOutputBytes) ? item.maxOutputBytes : fail("INVALID_BUDGET", "screenshot maxOutputBytes is required before capture")), 0);
  declared.recordingDurationMs = recordings.reduce((sum, item) => sum + item.durationMs, 0);
  declared.recordingBytes = recordings.reduce((sum, item) => sum + (Number.isSafeInteger(item.maxOutputBytes) ? item.maxOutputBytes : fail("INVALID_BUDGET", "recording maxOutputBytes is required before capture")), 0);
  declared.diagnosticLogCount = diagnostics.length;
  const preparedDiagnostics = diagnostics.map((item, index) => ({ observation: item, bytes: diagnosticBytes(item, `/diagnostics/${index}`) }));
  declared.diagnosticLogBytes = preparedDiagnostics.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  assertProposedRemoteDesktopUsageV1(currentUsage, declared, run.policy);

  const payloads = [];
  const visualArtifacts = [];
  for (const [index, item] of screenshots.entries()) {
    closed(item, ["artifactId", "scenarioId", "width", "height", "frame", "maxOutputBytes"], `/screenshots/${index}`);
    const sanitized = sanitizeFrame(item.frame, item.width, item.height, `/screenshots/${index}/frame`);
    const bytes = encodePngRgba(sanitized);
    if (bytes.byteLength > item.maxOutputBytes) fail("BUDGET_EXHAUSTED", "sanitized screenshot exceeds its declared pre-capture bound", `/screenshots/${index}/maxOutputBytes`);
    const ref = reference(bytes, "image/png", "screenshot"); payloads.push({ ref, bytes });
    visualArtifacts.push({ evidenceClass: "sanitized_screenshot", artifactId: item.artifactId, scenarioId: item.scenarioId, digest: ref.digest, mediaType: "image/png", byteLength: ref.byteLength, durationMs: 0, sanitized: true });
  }
  for (const [index, item] of recordings.entries()) {
    closed(item, ["artifactId", "scenarioId", "width", "height", "frames", "durationMs", "maxOutputBytes", "encodeSanitizedFrames"], `/recordings/${index}`);
    if (!run.policy.recording.enabled || typeof item.encodeSanitizedFrames !== "function" || !Array.isArray(item.frames) || item.frames.length < 1) fail("INVALID_EVIDENCE", "recording capture is not enabled or encodable", `/recordings/${index}`);
    const frames = item.frames.map((frame, frameIndex) => sanitizeFrame(frame, item.width, item.height, `/recordings/${index}/frames/${frameIndex}`));
    if (frames.some((frame) => frame.width !== frames[0].width || frame.height !== frames[0].height)) fail("UNCERTAIN_PROTECTION_GEOMETRY", "recording frames do not retain consistent sanitized dimensions", `/recordings/${index}/frames`);
    const encoded = await item.encodeSanitizedFrames(Object.freeze({ width: frames[0].width, height: frames[0].height, frames: Object.freeze(frames.map((frame) => Object.freeze({ ...frame, rgba: Buffer.from(frame.rgba) }))) }));
    const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded ?? []);
    if (bytes.byteLength < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") fail("INVALID_EVIDENCE", "recording encoder did not return an MP4 payload", `/recordings/${index}/encodeSanitizedFrames`);
    if (bytes.byteLength > item.maxOutputBytes) fail("BUDGET_EXHAUSTED", "sanitized recording exceeds its declared pre-capture bound", `/recordings/${index}/maxOutputBytes`);
    const ref = reference(bytes, "video/mp4", "recording"); payloads.push({ ref, bytes });
    visualArtifacts.push({ evidenceClass: "sanitized_recording", artifactId: item.artifactId, scenarioId: item.scenarioId, digest: ref.digest, mediaType: "video/mp4", byteLength: ref.byteLength, durationMs: item.durationMs, sanitized: true });
  }
  const diagnosticExports = preparedDiagnostics.map(({ observation, bytes }) => {
    const ref = reference(bytes, "application/json", "diagnostic"); payloads.push({ ref, bytes });
    return { evidenceClass: "bounded_diagnostic", diagnosticId: observation.diagnosticId, scenarioId: observation.scenarioId, code: observation.code, occurredAt: observation.occurredAt, artifactDigest: ref.digest, byteLength: ref.byteLength, sanitized: true };
  });
  const exact = { ...declared,
    screenshotBytes: visualArtifacts.filter((item) => item.evidenceClass === "sanitized_screenshot").reduce((sum, item) => sum + item.byteLength, 0),
    recordingBytes: visualArtifacts.filter((item) => item.evidenceClass === "sanitized_recording").reduce((sum, item) => sum + item.byteLength, 0),
  };
  assertProposedRemoteDesktopUsageV1(currentUsage, exact, run.policy);
  const evidenceExport = { schemaVersion: 1, runId: run.runId, scenarioMetadata, identities: identitiesFor(run), visualArtifacts, diagnostics: diagnosticExports, actionTimeline, assertionOutcomes, cleanupAttestation };
  validateRemoteDesktopEvidenceExportV1(evidenceExport, run);
  assertExportBindings(evidenceExport, run);
  const exportBytes = jsonBytes(evidenceExport);
  const exportRef = reference(exportBytes, "application/json", "remote_desktop_export");
  const uniquePayloads = [...new Map(payloads.map((payload) => [payload.ref.digest, payload])).values()];
  const inventory = { schemaVersion: 1, bundleFormat: "remote_desktop_sanitized_evidence_v1", runId: run.runId, export: exportRef, artifacts: uniquePayloads.map(({ ref }) => ref).sort((left, right) => left.digest.localeCompare(right.digest)) };
  const inventoryBytes = jsonBytes(inventory);

  await assertNoSymlinkComponents(bundleDirectory, "evidence bundle", { allowMissing: true });
  if (await pathInfo(bundleDirectory)) fail("UNSAFE_PATH", "bundle directory must not already exist", "/bundleDirectory");
  await ensureCanonicalDirectory(bundleDirectory, "evidence bundle", { mode: 0o700, enforceMode: true });
  for (const payload of uniquePayloads) await writeExclusive(bundleDirectory, payload.ref, payload.bytes);
  await writeExclusive(bundleDirectory, exportRef, exportBytes);
  const inventoryHandle = await open(resolve(bundleDirectory, "inventory.json"), "wx", 0o400);
  try { await inventoryHandle.writeFile(inventoryBytes); await inventoryHandle.sync(); } finally { await inventoryHandle.close(); }
  return Object.freeze({ inventory, evidenceExport, bundleDirectory });
}

function validateReference(ref, path) {
  closed(ref, ["digest", "byteLength", "mediaType", "kind", "relativePath", "sanitizationPolicy"], path);
  if (!SHA256.test(ref.digest) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 1 || !SAFE_RELATIVE_PATH.test(ref.relativePath)) fail("INVALID_INVENTORY", "artifact reference is invalid", path);
  if (!ref.relativePath.includes(ref.digest.slice(7))) fail("INVALID_INVENTORY", "artifact path is not content addressed", `${path}/relativePath`);
  const expected = {
    remote_desktop_export: ["application/json", "contract-metadata-v1", "exports", "json"],
    diagnostic: ["application/json", "closed-diagnostic-v1", "artifacts", "json"],
    screenshot: ["image/png", "visual-geometry-v1", "artifacts", "png"],
    recording: ["video/mp4", "visual-geometry-v1", "artifacts", "mp4"],
  }[ref.kind];
  if (!expected || ref.mediaType !== expected[0] || ref.sanitizationPolicy !== expected[1] || ref.relativePath !== `${expected[2]}/${ref.digest.slice(7)}.${expected[3]}`) fail("INVALID_INVENTORY", "artifact reference kind, media, policy, and path disagree", path);
}

async function verifiedRead(root, ref, path) {
  validateReference(ref, path);
  const target = resolve(root, ref.relativePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail("UNSAFE_PATH", "artifact path escapes the bundle", `${path}/relativePath`);
  await assertNoSymlinkComponents(resolve(target, ".."), "bundle artifact namespace", { allowMissing: false });
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("UNSAFE_PATH", "bundle artifact must be a regular unlinked file", `${path}/relativePath`);
  const canonical = await realpath(target);
  if (!canonical.startsWith(`${root}${sep}`)) fail("UNSAFE_PATH", "artifact resolves outside the bundle", `${path}/relativePath`);
  const bytes = await readFile(canonical);
  if (bytes.byteLength !== ref.byteLength || digest(bytes) !== ref.digest) fail("DIGEST_MISMATCH", "artifact bytes do not match their reference", path);
  return bytes;
}

async function listedBundleFiles(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = resolve(current, entry.name);
    const rel = relative(root, absolute).split(sep).join("/");
    if (entry.isSymbolicLink()) fail("UNSAFE_PATH", "bundle contains a symlink", `/${rel}`);
    if (entry.isDirectory()) output.push(...await listedBundleFiles(root, absolute));
    else if (entry.isFile()) output.push(rel);
    else fail("UNSAFE_PATH", "bundle contains a non-regular filesystem entry", `/${rel}`);
  }
  return output.sort();
}

export async function verifyRemoteDesktopEvidenceBundleV1(bundleDirectory, run, { forbiddenBytes = [] } = {}) {
  validateRemoteDesktopRunV1(run);
  const root = await ensureCanonicalDirectory(bundleDirectory, "evidence bundle", { create: false });
  await access(resolve(root, "inventory.json"), fsConstants.R_OK);
  const inventoryInfo = await lstat(resolve(root, "inventory.json"));
  if (!inventoryInfo.isFile() || inventoryInfo.isSymbolicLink() || inventoryInfo.nlink !== 1) fail("UNSAFE_PATH", "inventory must be a regular unlinked file", "/inventory");
  const inventoryBytes = await readFile(resolve(root, "inventory.json"));
  let inventory;
  try { inventory = JSON.parse(inventoryBytes.toString("utf8")); } catch { fail("INVALID_INVENTORY", "inventory is not valid JSON", "/inventory"); }
  closed(inventory, ["schemaVersion", "bundleFormat", "runId", "export", "artifacts"], "/inventory");
  if (inventory.schemaVersion !== 1 || inventory.bundleFormat !== "remote_desktop_sanitized_evidence_v1" || inventory.runId !== run.runId || !Array.isArray(inventory.artifacts)) fail("INVALID_INVENTORY", "inventory identity is invalid", "/inventory");
  const seen = new Set();
  const allBytes = [inventoryBytes];
  for (const [index, ref] of inventory.artifacts.entries()) {
    if (seen.has(ref.digest)) fail("INVALID_INVENTORY", "duplicate artifact digest", `/inventory/artifacts/${index}`);
    seen.add(ref.digest);
    const bytes = await verifiedRead(root, ref, `/inventory/artifacts/${index}`);
    if (ref.kind === "diagnostic") {
      let payload;
      try { payload = JSON.parse(bytes.toString("utf8")); } catch { fail("FORBIDDEN_DIAGNOSTIC", "diagnostic payload is not JSON", `/inventory/artifacts/${index}`); }
      closed(payload, ["schemaVersion", "source", "code", "occurredAt", "fields"], `/inventory/artifacts/${index}`);
      if (payload.schemaVersion !== 1 || !DIAGNOSTIC_SOURCES.includes(payload.source)) fail("FORBIDDEN_DIAGNOSTIC", "diagnostic payload identity is invalid", `/inventory/artifacts/${index}`);
      plainObject(payload.fields, `/inventory/artifacts/${index}/fields`);
      for (const [key, value] of Object.entries(payload.fields)) {
        if (!DIAGNOSTIC_FIELDS.includes(key) || !(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) fail("FORBIDDEN_DIAGNOSTIC", "diagnostic payload violates the closed field allowlist", `/inventory/artifacts/${index}/fields/${key}`);
      }
      scanForbidden(payload, `/inventory/artifacts/${index}`);
    }
    allBytes.push(bytes);
  }
  const exportBytes = await verifiedRead(root, inventory.export, "/inventory/export"); allBytes.push(exportBytes);
  let evidenceExport;
  try { evidenceExport = JSON.parse(exportBytes.toString("utf8")); } catch { fail("INVALID_INVENTORY", "export is not valid JSON", "/export"); }
  validateRemoteDesktopEvidenceExportV1(evidenceExport, run);
  assertExportBindings(evidenceExport, run);
  const exported = new Map([
    ...evidenceExport.visualArtifacts.map((item) => [item.digest, {
      byteLength: item.byteLength,
      kind: item.evidenceClass === "sanitized_screenshot" ? "screenshot" : "recording",
      mediaType: item.mediaType,
      sanitizationPolicy: "visual-geometry-v1",
    }]),
    ...evidenceExport.diagnostics.map((item) => [item.artifactDigest, {
      byteLength: item.byteLength, kind: "diagnostic", mediaType: "application/json",
      sanitizationPolicy: "closed-diagnostic-v1",
    }]),
  ]);
  if (exported.size !== inventory.artifacts.length || inventory.artifacts.some((ref) => {
    const expected = exported.get(ref.digest);
    return !expected || Object.entries(expected).some(([field, value]) => ref[field] !== value);
  })) fail("INVALID_INVENTORY", "inventory and remote export artifact references differ", "/inventory/artifacts");
  for (const [index, ref] of inventory.artifacts.entries()) {
    const bytes = allBytes[index + 1];
    if (ref.kind === "screenshot") decodePngRgba(bytes);
    if (ref.kind === "recording" && (bytes.byteLength < 12 || bytes.toString("ascii", 4, 8) !== "ftyp")) fail("INVALID_EVIDENCE", "recording artifact is not an MP4 payload", `/inventory/artifacts/${index}`);
  }
  const expectedFiles = ["inventory.json", inventory.export.relativePath, ...inventory.artifacts.map(({ relativePath }) => relativePath)].sort();
  const actualFiles = await listedBundleFiles(root);
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) fail("INVALID_INVENTORY", "bundle contains missing or unreferenced files", "/inventory");
  for (const [index, needle] of forbiddenBytes.entries()) {
    const bytes = Buffer.isBuffer(needle) ? needle : Buffer.from(String(needle));
    if (bytes.byteLength > 0 && allBytes.some((payload) => payload.includes(bytes))) fail("FORBIDDEN_BYTES", "bundle contains forbidden synthetic bytes", `/forbiddenBytes/${index}`);
  }
  return Object.freeze({ inventory, evidenceExport, artifactCount: inventory.artifacts.length });
}
