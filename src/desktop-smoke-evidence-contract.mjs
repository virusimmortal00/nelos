import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalBytes, canonicalDigest } from "./experimentation-contract/index.mjs";

export const DESKTOP_SMOKE_EVIDENCE_SCHEMA_VERSION = 1;
export const DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 = Object.freeze({
  maxFileBytes: 64 * 1024,
  maxFilesPerScenario: 64,
  maxBytesPerScenario: 1024 * 1024,
  maxFilesPerRun: 512,
  maxBytesPerRun: 8 * 1024 * 1024,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const FORBIDDEN_FIELD = /(?:prompt|response|transcript|sealed|credential|token|cookie|environment|envdump|secret|authorization|rawpixels|unsanitized)/iu;
const FORBIDDEN_TEXT = /\b(?:prompt|response|transcript|sealed[ _-]?value|credential|token|cookie|environment[ _-]?dump|secret|authorization)\b/iu;
const DIAGNOSTIC_FIELDS = new Set([
  "actionId", "assertionId", "checkpointId", "component", "elapsedMs",
  "expectedCode", "observedCode", "operation", "retryCount", "status",
]);
const CHECKPOINT_TYPES = new Set(["accessibility_tree", "screenshot", "window_state"]);
const ARTIFACT_KINDS = new Set(["accessibility-tree", "diagnostic", "screenshot", "window-state"]);
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class DesktopSmokeEvidenceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "DesktopSmokeEvidenceError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new DesktopSmokeEvidenceError(code, message, details);
}

function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("INVALID_EVIDENCE_CONTRACT", `${label} must be a plain object`);
  }
}

function closed(value, fields, label) {
  plain(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("INVALID_EVIDENCE_CONTRACT", `${label} fields must match the closed schema`, { actual, expected });
  }
}

function version(value, label) {
  if (value?.schemaVersion !== DESKTOP_SMOKE_EVIDENCE_SCHEMA_VERSION) fail("INCOMPATIBLE_EVIDENCE_CONTRACT", `${label}.schemaVersion must be 1`);
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("INVALID_EVIDENCE_CONTRACT", `${label} is invalid`);
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("INVALID_EVIDENCE_CONTRACT", `${label} is invalid`);
}

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("INVALID_EVIDENCE_CONTRACT", `${label} is invalid`);
}

function timestamp(value, label) {
  if (typeof value !== "string" || !TIME.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("INVALID_EVIDENCE_CONTRACT", `${label} must be a normalized UTC timestamp`);
  }
}

function unique(records, field, label) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record[field])) fail("DUPLICATE_EVIDENCE_IDENTIFIER", `${label} ${field} values must be unique`);
    seen.add(record[field]);
  }
}

function safeRelativePath(value, label = "relativePath") {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || isAbsolute(value) || value.includes("\\") || value.includes("\0")) {
    fail("UNSAFE_EVIDENCE_PATH", `${label} must be a stable relative POSIX path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || segments.join("/") !== value) {
    fail("UNSAFE_EVIDENCE_PATH", `${label} contains traversal or non-canonical segments`);
  }
  return value;
}

function scanForbiddenFields(value, label = "record") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenFields(item, `${label}[${index}]`));
    return;
  }
  if (typeof value === "string" && FORBIDDEN_TEXT.test(value)) fail("FORBIDDEN_SENSITIVE_EVIDENCE", `${label} contains a forbidden sensitive-data class`);
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) fail("FORBIDDEN_SENSITIVE_EVIDENCE", `${label}.${key} is forbidden from evidence bundles`);
    scanForbiddenFields(item, `${label}.${key}`);
  }
}

function clone(value) {
  return structuredClone(value);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateDesktopSmokeEvidenceRunV1(value) {
  closed(value, [
    "schemaVersion", "runId", "scenarioSetId", "candidate", "startedAt", "finishedAt",
    "outcome", "scenarioIds", "diagnosticLimits",
  ], "run");
  version(value, "run");
  id(value.runId, "run.runId");
  id(value.scenarioSetId, "run.scenarioSetId");
  closed(value.candidate, ["version", "digest", "sourceRevision"], "run.candidate");
  if (typeof value.candidate.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.candidate.version)) fail("INVALID_EVIDENCE_CONTRACT", "run.candidate.version is invalid");
  digest(value.candidate.digest, "run.candidate.digest");
  if (typeof value.candidate.sourceRevision !== "string" || !/^[0-9a-f]{40}$/u.test(value.candidate.sourceRevision)) fail("INVALID_EVIDENCE_CONTRACT", "run.candidate.sourceRevision is invalid");
  timestamp(value.startedAt, "run.startedAt");
  timestamp(value.finishedAt, "run.finishedAt");
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) fail("INVALID_EVIDENCE_CONTRACT", "run timestamps are out of order");
  if (!["passed", "failed"].includes(value.outcome)) fail("INVALID_EVIDENCE_CONTRACT", "run.outcome is invalid");
  if (!Array.isArray(value.scenarioIds) || value.scenarioIds.length < 1 || value.scenarioIds.length > 100) fail("INVALID_EVIDENCE_CONTRACT", "run.scenarioIds is invalid");
  value.scenarioIds.forEach((scenarioId) => id(scenarioId, "run.scenarioIds[]"));
  if (new Set(value.scenarioIds).size !== value.scenarioIds.length || [...value.scenarioIds].sort().some((item, index) => item !== value.scenarioIds[index])) fail("INVALID_EVIDENCE_CONTRACT", "run.scenarioIds must be unique and sorted");
  closed(value.diagnosticLimits, Object.keys(DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1), "run.diagnosticLimits");
  if (Object.entries(DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1).some(([key, expected]) => value.diagnosticLimits[key] !== expected)) fail("INVALID_EVIDENCE_CONTRACT", "run.diagnosticLimits must use the V1 ceilings");
  scanForbiddenFields(value, "run");
  return clone(value);
}

export function validateDesktopSmokeCheckpointV1(value) {
  closed(value, ["schemaVersion", "checkpointId", "runId", "scenarioId", "type", "outcome", "artifactIds"], "checkpoint");
  version(value, "checkpoint");
  id(value.checkpointId, "checkpoint.checkpointId");
  id(value.runId, "checkpoint.runId");
  id(value.scenarioId, "checkpoint.scenarioId");
  if (!CHECKPOINT_TYPES.has(value.type) || !["captured", "failed", "skipped"].includes(value.outcome)) fail("INVALID_EVIDENCE_CONTRACT", "checkpoint type or outcome is invalid");
  if (!Array.isArray(value.artifactIds) || value.artifactIds.length > 64) fail("INVALID_EVIDENCE_CONTRACT", "checkpoint.artifactIds is invalid");
  value.artifactIds.forEach((artifactId) => id(artifactId, "checkpoint.artifactIds[]"));
  if (new Set(value.artifactIds).size !== value.artifactIds.length || [...value.artifactIds].sort().some((item, index) => item !== value.artifactIds[index])) fail("INVALID_EVIDENCE_CONTRACT", "checkpoint.artifactIds must be unique and sorted");
  if (value.outcome === "captured" && value.artifactIds.length < 1) fail("INVALID_EVIDENCE_CONTRACT", "captured checkpoints require an artifact");
  scanForbiddenFields(value, "checkpoint");
  return clone(value);
}

function validateProtectionAttestation(value, label) {
  closed(value, [
    "policyId", "attested", "traversalComplete", "inventoryComplete", "regionsDetected",
    "regionsProcessed", "outputSanitized", "sourcePixelsRetained",
  ], label);
  id(value.policyId, `${label}.policyId`);
  integer(value.regionsDetected, `${label}.regionsDetected`);
  integer(value.regionsProcessed, `${label}.regionsProcessed`);
  if (value.attested !== true || value.traversalComplete !== true || value.inventoryComplete !== true || value.outputSanitized !== true || value.sourcePixelsRetained !== false || value.regionsProcessed !== value.regionsDetected) {
    fail("INCOMPLETE_REDACTION_ATTESTATION", `${label} does not prove complete protected-region processing`);
  }
}

export function validateDesktopSmokeArtifactV1(value) {
  closed(value, [
    "schemaVersion", "artifactId", "runId", "scenarioId", "checkpointId", "kind",
    "relativePath", "mediaType", "byteLength", "digest", "viewable", "protection",
  ], "artifact");
  version(value, "artifact");
  id(value.artifactId, "artifact.artifactId");
  id(value.runId, "artifact.runId");
  id(value.scenarioId, "artifact.scenarioId");
  id(value.checkpointId, "artifact.checkpointId");
  if (!ARTIFACT_KINDS.has(value.kind)) fail("INVALID_EVIDENCE_CONTRACT", "artifact.kind is invalid");
  safeRelativePath(value.relativePath, "artifact.relativePath");
  if (typeof value.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(value.mediaType)) fail("INVALID_EVIDENCE_CONTRACT", "artifact.mediaType is invalid");
  integer(value.byteLength, "artifact.byteLength", { minimum: 1, maximum: 16 * 1024 * 1024 });
  digest(value.digest, "artifact.digest");
  if (typeof value.viewable !== "boolean") fail("INVALID_EVIDENCE_CONTRACT", "artifact.viewable must be boolean");
  if (value.kind === "screenshot") {
    if (!IMAGE_MEDIA_TYPES.has(value.mediaType) || value.viewable !== true || value.protection === null) fail("UNSAFE_SCREENSHOT_EVIDENCE", "screenshots must be viewable sanitized images with an attestation");
    validateProtectionAttestation(value.protection, "artifact.protection");
  } else if (value.protection !== null || value.viewable !== false || IMAGE_MEDIA_TYPES.has(value.mediaType)) {
    fail("INVALID_EVIDENCE_CONTRACT", "only screenshot artifacts may be viewable or carry protected-region attestations");
  }
  scanForbiddenFields(value, "artifact");
  return clone(value);
}

export function validateDesktopSmokeAssertionResultV1(value) {
  closed(value, ["schemaVersion", "assertionId", "runId", "scenarioId", "checkpointId", "outcome", "code"], "assertion result");
  version(value, "assertion result");
  for (const field of ["assertionId", "runId", "scenarioId", "checkpointId", "code"]) id(value[field], `assertion result.${field}`);
  if (!["passed", "failed"].includes(value.outcome)) fail("INVALID_EVIDENCE_CONTRACT", "assertion result.outcome is invalid");
  scanForbiddenFields(value, "assertion result");
  return clone(value);
}

export function validateDesktopSmokeDiagnosticV1(value) {
  closed(value, ["schemaVersion", "diagnosticId", "runId", "scenarioId", "code", "severity", "fields", "text", "byteLength", "digest"], "diagnostic");
  version(value, "diagnostic");
  for (const field of ["diagnosticId", "runId", "scenarioId", "code"]) id(value[field], `diagnostic.${field}`);
  if (!["error", "info", "warning"].includes(value.severity)) fail("INVALID_EVIDENCE_CONTRACT", "diagnostic.severity is invalid");
  plain(value.fields, "diagnostic.fields");
  for (const [field, item] of Object.entries(value.fields)) {
    if (!DIAGNOSTIC_FIELDS.has(field)) fail("FORBIDDEN_DIAGNOSTIC_FIELD", `diagnostic.fields.${field} is not allowlisted`);
    if (!((typeof item === "string" && item.length <= 256) || typeof item === "boolean" || (Number.isSafeInteger(item) && item >= 0))) fail("INVALID_EVIDENCE_CONTRACT", `diagnostic.fields.${field} is invalid`);
  }
  if (value.text !== null) {
    closed(value.text, ["value", "redacted", "policyId"], "diagnostic.text");
    if (typeof value.text.value !== "string" || value.text.value.length > 8192 || value.text.redacted !== true) fail("UNREDACTED_DIAGNOSTIC_TEXT", "diagnostic text must be bounded and explicitly redacted");
    id(value.text.policyId, "diagnostic.text.policyId");
  }
  integer(value.byteLength, "diagnostic.byteLength", { maximum: DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1.maxFileBytes });
  digest(value.digest, "diagnostic.digest");
  const payloadBytes = canonicalBytes({ code: value.code, severity: value.severity, fields: value.fields, text: value.text });
  if (value.byteLength !== payloadBytes.byteLength || value.digest !== sha256(payloadBytes)) fail("EVIDENCE_DIGEST_MISMATCH", `diagnostic ${value.diagnosticId} digest or byteLength does not match its retained payload`);
  scanForbiddenFields(value, "diagnostic");
  return clone(value);
}

function enforceDiagnosticCeilings(diagnostics) {
  const scenarios = new Map();
  let runBytes = 0;
  for (const item of diagnostics) {
    runBytes += item.byteLength;
    const aggregate = scenarios.get(item.scenarioId) ?? { count: 0, bytes: 0 };
    aggregate.count += 1;
    aggregate.bytes += item.byteLength;
    scenarios.set(item.scenarioId, aggregate);
    if (aggregate.count > DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1.maxFilesPerScenario || aggregate.bytes > DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1.maxBytesPerScenario) fail("OVERSIZED_DIAGNOSTIC_EVIDENCE", `diagnostics exceed the per-scenario ceiling for ${item.scenarioId}`);
  }
  if (diagnostics.length > DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1.maxFilesPerRun || runBytes > DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1.maxBytesPerRun) fail("OVERSIZED_DIAGNOSTIC_EVIDENCE", "diagnostics exceed the per-run ceiling");
}

function withoutDigest(value, field) {
  const copy = clone(value);
  delete copy[field];
  return copy;
}

export function desktopSmokeBundleManifestDigestV1(manifest) {
  return canonicalDigest(withoutDigest(manifest, "bundleDigest"));
}

export function validateDesktopSmokeBundleManifestV1(value) {
  closed(value, ["schemaVersion", "bundleId", "runId", "format", "records", "files", "totals", "bundleDigest"], "bundle manifest");
  version(value, "bundle manifest");
  id(value.bundleId, "bundle manifest.bundleId");
  id(value.runId, "bundle manifest.runId");
  if (value.format !== "nelos-desktop-smoke-evidence-v1") fail("INCOMPATIBLE_EVIDENCE_CONTRACT", "bundle manifest.format is unsupported");
  if (!Array.isArray(value.records) || !Array.isArray(value.files)) fail("INVALID_EVIDENCE_CONTRACT", "bundle manifest records and files must be arrays");
  for (const record of value.records) {
    closed(record, ["recordType", "recordId", "relativePath", "digest", "byteLength"], "bundle manifest record");
    if (!["artifact", "assertion-result", "checkpoint", "diagnostic", "run"].includes(record.recordType)) fail("INVALID_EVIDENCE_CONTRACT", "bundle manifest recordType is invalid");
    id(record.recordId, "bundle manifest record.recordId");
    safeRelativePath(record.relativePath, "bundle manifest record.relativePath");
    digest(record.digest, "bundle manifest record.digest");
    integer(record.byteLength, "bundle manifest record.byteLength", { minimum: 1 });
  }
  for (const file of value.files) {
    closed(file, ["artifactId", "relativePath", "mediaType", "digest", "byteLength"], "bundle manifest file");
    id(file.artifactId, "bundle manifest file.artifactId");
    safeRelativePath(file.relativePath, "bundle manifest file.relativePath");
    if (typeof file.mediaType !== "string") fail("INVALID_EVIDENCE_CONTRACT", "bundle manifest file.mediaType is invalid");
    digest(file.digest, "bundle manifest file.digest");
    integer(file.byteLength, "bundle manifest file.byteLength", { minimum: 1 });
  }
  unique(value.records, "relativePath", "bundle manifest records");
  unique(value.files, "relativePath", "bundle manifest files");
  unique(value.files, "artifactId", "bundle manifest files");
  const orderedRecords = [...value.records].sort((left, right) => compareText(left.relativePath, right.relativePath));
  const orderedFiles = [...value.files].sort((left, right) => compareText(left.relativePath, right.relativePath));
  if (orderedRecords.some((item, index) => item.relativePath !== value.records[index].relativePath) || orderedFiles.some((item, index) => item.relativePath !== value.files[index].relativePath)) fail("NON_CANONICAL_EVIDENCE_ORDER", "bundle manifest entries must be sorted by relativePath");
  const allPaths = [...value.records, ...value.files].map(({ relativePath }) => relativePath);
  if (new Set(allPaths).size !== allPaths.length) fail("DUPLICATE_EVIDENCE_IDENTIFIER", "bundle paths must be unique");
  closed(value.totals, ["recordCount", "fileCount", "fileBytes", "diagnosticCount", "diagnosticBytes"], "bundle manifest.totals");
  for (const field of Object.keys(value.totals)) integer(value.totals[field], `bundle manifest.totals.${field}`);
  if (value.totals.recordCount !== value.records.length || value.totals.fileCount !== value.files.length || value.totals.fileBytes !== value.files.reduce((sum, file) => sum + file.byteLength, 0)) fail("INVALID_EVIDENCE_CONTRACT", "bundle manifest totals do not match its entries");
  if (value.totals.diagnosticCount !== value.records.filter(({ recordType }) => recordType === "diagnostic").length) fail("INVALID_EVIDENCE_CONTRACT", "bundle manifest diagnostic count does not match its records");
  digest(value.bundleDigest, "bundle manifest.bundleDigest");
  if (value.bundleDigest !== desktopSmokeBundleManifestDigestV1(value)) fail("EVIDENCE_DIGEST_MISMATCH", "bundle manifest digest does not match its contents");
  scanForbiddenFields(value, "bundle manifest");
  return clone(value);
}

export function validateDesktopSmokeReviewResultV1(value) {
  closed(value, ["schemaVersion", "reviewId", "runId", "bundleId", "bundleDigest", "outcome", "assertionSummary", "evidenceSummary", "reasonCodes"], "review result");
  version(value, "review result");
  for (const field of ["reviewId", "runId", "bundleId"]) id(value[field], `review result.${field}`);
  digest(value.bundleDigest, "review result.bundleDigest");
  if (!["approved", "rejected"].includes(value.outcome)) fail("INVALID_EVIDENCE_CONTRACT", "review result.outcome is invalid");
  closed(value.assertionSummary, ["total", "passed", "failed"], "review result.assertionSummary");
  closed(value.evidenceSummary, ["checkpoints", "artifacts", "diagnostics", "bytes"], "review result.evidenceSummary");
  for (const [field, amount] of [...Object.entries(value.assertionSummary), ...Object.entries(value.evidenceSummary)]) integer(amount, `review result summary.${field}`);
  if (value.assertionSummary.total !== value.assertionSummary.passed + value.assertionSummary.failed) fail("INVALID_EVIDENCE_CONTRACT", "review assertion totals do not balance");
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.length > 64) fail("INVALID_EVIDENCE_CONTRACT", "review result.reasonCodes is invalid");
  value.reasonCodes.forEach((code) => id(code, "review result.reasonCodes[]"));
  if (new Set(value.reasonCodes).size !== value.reasonCodes.length || [...value.reasonCodes].sort().some((item, index) => item !== value.reasonCodes[index])) fail("INVALID_EVIDENCE_CONTRACT", "review reason codes must be unique and sorted");
  if ((value.outcome === "approved") !== (value.assertionSummary.failed === 0 && value.reasonCodes.length === 0)) fail("INVALID_EVIDENCE_CONTRACT", "review outcome is inconsistent with its results");
  if (value.reviewId !== `review:${value.bundleId}`) fail("INVALID_EVIDENCE_RELATIONSHIP", "reviewId must be derived from bundleId");
  scanForbiddenFields(value, "review result");
  return clone(value);
}

function recordEntry(recordType, recordId, record) {
  const bytes = canonicalBytes(record);
  return {
    manifest: {
      recordType,
      recordId,
      relativePath: `records/${recordType}/${recordId}.json`,
      digest: sha256(bytes),
      byteLength: bytes.byteLength,
    },
    payload: { relativePath: `records/${recordType}/${recordId}.json`, mediaType: "application/json", bytes },
  };
}

function normalizedFile(file, artifactById) {
  closed(file, ["artifactId", "bytes"], "bundle file");
  id(file.artifactId, "bundle file.artifactId");
  const artifact = artifactById.get(file.artifactId);
  if (!artifact) fail("INVALID_EVIDENCE_CONTRACT", `bundle file references unknown artifact ${file.artifactId}`);
  const bytes = Buffer.isBuffer(file.bytes) ? Buffer.from(file.bytes) : file.bytes instanceof Uint8Array ? Buffer.from(file.bytes) : fail("INVALID_EVIDENCE_CONTRACT", "bundle file.bytes must be bytes");
  if (bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.digest) fail("EVIDENCE_DIGEST_MISMATCH", `artifact bytes do not match ${file.artifactId}`);
  if (artifact.kind !== "screenshot") {
    if (artifact.mediaType !== "application/json") fail("INVALID_EVIDENCE_CONTRACT", "non-screenshot artifacts must use canonical JSON");
    let payload;
    try { payload = JSON.parse(bytes.toString("utf8")); }
    catch { fail("INVALID_EVIDENCE_CONTRACT", `artifact ${file.artifactId} is not JSON`); }
    if (!canonicalBytes(payload).equals(bytes)) fail("NON_CANONICAL_EVIDENCE_BUNDLE", `artifact ${file.artifactId} is not canonical JSON`);
    scanForbiddenFields(payload, `artifact ${file.artifactId}`);
  }
  return { artifactId: file.artifactId, relativePath: artifact.relativePath, mediaType: artifact.mediaType, digest: artifact.digest, byteLength: artifact.byteLength, bytes };
}

export function createDesktopSmokeEvidenceBundleV1({ run, checkpoints, artifacts, assertionResults, diagnostics, files }) {
  const normalizedRun = validateDesktopSmokeEvidenceRunV1(run);
  if (![checkpoints, artifacts, assertionResults, diagnostics, files].every(Array.isArray)) fail("INVALID_EVIDENCE_CONTRACT", "bundle inputs must be arrays");
  if (checkpoints.length > 10_000 || artifacts.length > 10_000 || assertionResults.length > 10_000 || diagnostics.length > DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1.maxFilesPerRun || files.length > 10_000) fail("OVERSIZED_EVIDENCE_BUNDLE", "bundle record counts exceed the V1 ceilings");
  const normalizedCheckpoints = checkpoints.map(validateDesktopSmokeCheckpointV1);
  const normalizedArtifacts = artifacts.map(validateDesktopSmokeArtifactV1);
  const normalizedAssertions = assertionResults.map(validateDesktopSmokeAssertionResultV1);
  const normalizedDiagnostics = diagnostics.map(validateDesktopSmokeDiagnosticV1);
  for (const [records, field, label] of [
    [normalizedCheckpoints, "checkpointId", "checkpoints"], [normalizedArtifacts, "artifactId", "artifacts"],
    [normalizedAssertions, "assertionId", "assertions"], [normalizedDiagnostics, "diagnosticId", "diagnostics"],
  ]) unique(records, field, label);
  enforceDiagnosticCeilings(normalizedDiagnostics);
  const scenarioIds = new Set(normalizedRun.scenarioIds);
  const checkpointById = new Map(normalizedCheckpoints.map((item) => [item.checkpointId, item]));
  const artifactById = new Map(normalizedArtifacts.map((item) => [item.artifactId, item]));
  for (const record of [...normalizedCheckpoints, ...normalizedArtifacts, ...normalizedAssertions, ...normalizedDiagnostics]) {
    if (record.runId !== normalizedRun.runId || !scenarioIds.has(record.scenarioId)) fail("INVALID_EVIDENCE_RELATIONSHIP", "bundle record does not belong to its run and scenario set");
  }
  for (const artifact of normalizedArtifacts) {
    const checkpoint = checkpointById.get(artifact.checkpointId);
    if (!checkpoint || checkpoint.scenarioId !== artifact.scenarioId || !checkpoint.artifactIds.includes(artifact.artifactId)) fail("INVALID_EVIDENCE_RELATIONSHIP", `artifact ${artifact.artifactId} is not bound to its checkpoint`);
  }
  for (const checkpoint of normalizedCheckpoints) {
    for (const artifactId of checkpoint.artifactIds) if (!artifactById.has(artifactId)) fail("INVALID_EVIDENCE_RELATIONSHIP", `checkpoint ${checkpoint.checkpointId} references a missing artifact`);
  }
  for (const assertion of normalizedAssertions) {
    const checkpoint = checkpointById.get(assertion.checkpointId);
    if (!checkpoint || checkpoint.scenarioId !== assertion.scenarioId) fail("INVALID_EVIDENCE_RELATIONSHIP", `assertion ${assertion.assertionId} is not bound to its checkpoint`);
  }
  const normalizedFiles = files.map((file) => normalizedFile(file, artifactById));
  unique(normalizedFiles, "artifactId", "bundle files");
  if (normalizedFiles.length !== normalizedArtifacts.length) fail("INVALID_EVIDENCE_RELATIONSHIP", "every artifact must have exactly one bundle file");

  const records = [
    recordEntry("run", normalizedRun.runId, normalizedRun),
    ...normalizedCheckpoints.map((item) => recordEntry("checkpoint", item.checkpointId, item)),
    ...normalizedArtifacts.map((item) => recordEntry("artifact", item.artifactId, item)),
    ...normalizedAssertions.map((item) => recordEntry("assertion-result", item.assertionId, item)),
    ...normalizedDiagnostics.map((item) => recordEntry("diagnostic", item.diagnosticId, item)),
  ].sort((left, right) => compareText(left.manifest.relativePath, right.manifest.relativePath));
  const orderedFiles = normalizedFiles.sort((left, right) => compareText(left.relativePath, right.relativePath));
  const bundleId = `bundle:${normalizedRun.runId}`;
  const manifest = {
    schemaVersion: 1,
    bundleId,
    runId: normalizedRun.runId,
    format: "nelos-desktop-smoke-evidence-v1",
    records: records.map(({ manifest: item }) => item),
    files: orderedFiles.map(({ bytes: ignored, ...item }) => item),
    totals: {
      recordCount: records.length,
      fileCount: orderedFiles.length,
      fileBytes: orderedFiles.reduce((sum, item) => sum + item.byteLength, 0),
      diagnosticCount: normalizedDiagnostics.length,
      diagnosticBytes: normalizedDiagnostics.reduce((sum, item) => sum + item.byteLength, 0),
    },
    bundleDigest: null,
  };
  manifest.bundleDigest = desktopSmokeBundleManifestDigestV1(manifest);
  validateDesktopSmokeBundleManifestV1(manifest);
  const entries = [
    ...records.map(({ payload }) => ({ ...payload, encoding: "base64", data: Buffer.from(payload.bytes).toString("base64") })),
    ...orderedFiles.map((item) => ({ relativePath: item.relativePath, mediaType: item.mediaType, bytes: item.bytes, encoding: "base64", data: item.bytes.toString("base64") })),
  ].map(({ bytes: ignored, ...item }) => item).sort((left, right) => compareText(left.relativePath, right.relativePath));
  const bytes = canonicalBytes({ schemaVersion: 1, manifest, entries });
  return Object.freeze({ manifest: Object.freeze(clone(manifest)), bytes: Buffer.from(bytes) });
}

export function validateDesktopSmokeEvidenceBundleV1(value) {
  const bytes = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : fail("INVALID_EVIDENCE_BUNDLE", "bundle must be bytes");
  let bundle;
  try { bundle = JSON.parse(bytes.toString("utf8")); }
  catch { fail("INVALID_EVIDENCE_BUNDLE", "bundle is not canonical JSON"); }
  if (!canonicalBytes(bundle).equals(bytes)) fail("NON_CANONICAL_EVIDENCE_BUNDLE", "bundle bytes are not canonical JSON");
  closed(bundle, ["schemaVersion", "manifest", "entries"], "bundle");
  version(bundle, "bundle");
  const manifest = validateDesktopSmokeBundleManifestV1(bundle.manifest);
  if (!Array.isArray(bundle.entries)) fail("INVALID_EVIDENCE_BUNDLE", "bundle.entries must be an array");
  const expected = [...manifest.records, ...manifest.files].sort((left, right) => compareText(left.relativePath, right.relativePath));
  if (bundle.entries.length !== expected.length) fail("INVALID_EVIDENCE_BUNDLE", "bundle entry count does not match its manifest");
  const seen = new Set();
  for (const [index, entry] of bundle.entries.entries()) {
    closed(entry, ["relativePath", "mediaType", "encoding", "data"], "bundle entry");
    safeRelativePath(entry.relativePath, "bundle entry.relativePath");
    if (entry.relativePath !== expected[index].relativePath || seen.has(entry.relativePath)) fail("NON_CANONICAL_EVIDENCE_ORDER", "bundle entries must be unique and sorted like the manifest");
    seen.add(entry.relativePath);
    if (entry.encoding !== "base64" || typeof entry.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(entry.data)) fail("INVALID_EVIDENCE_BUNDLE", "bundle entry encoding is invalid");
    const payload = Buffer.from(entry.data, "base64");
    if (payload.byteLength !== expected[index].byteLength || sha256(payload) !== expected[index].digest || entry.mediaType !== (expected[index].mediaType ?? "application/json")) fail("EVIDENCE_DIGEST_MISMATCH", `bundle entry ${entry.relativePath} does not match its manifest`);
    if (expected[index].recordType) {
      let record;
      try { record = JSON.parse(payload.toString("utf8")); }
      catch { fail("INVALID_EVIDENCE_BUNDLE", `record ${entry.relativePath} is not JSON`); }
      if (!canonicalBytes(record).equals(payload)) fail("NON_CANONICAL_EVIDENCE_BUNDLE", `record ${entry.relativePath} is not canonical JSON`);
      scanForbiddenFields(record, entry.relativePath);
    }
  }
  return Object.freeze({ manifest: Object.freeze(manifest), bytes: Buffer.from(bytes) });
}

export function deriveDesktopSmokeReviewResultV1({ manifest, run, checkpoints, artifacts, assertionResults, diagnostics }) {
  const normalizedManifest = validateDesktopSmokeBundleManifestV1(manifest);
  const normalizedRun = validateDesktopSmokeEvidenceRunV1(run);
  const normalizedCheckpoints = checkpoints.map(validateDesktopSmokeCheckpointV1);
  const normalizedArtifacts = artifacts.map(validateDesktopSmokeArtifactV1);
  const normalizedAssertions = assertionResults.map(validateDesktopSmokeAssertionResultV1);
  const normalizedDiagnostics = diagnostics.map(validateDesktopSmokeDiagnosticV1);
  enforceDiagnosticCeilings(normalizedDiagnostics);
  if (normalizedManifest.runId !== normalizedRun.runId) fail("INVALID_EVIDENCE_RELATIONSHIP", "review manifest and run do not match");
  const expectedRecords = [
    ["run", normalizedRun.runId],
    ...normalizedCheckpoints.map(({ checkpointId }) => ["checkpoint", checkpointId]),
    ...normalizedArtifacts.map(({ artifactId }) => ["artifact", artifactId]),
    ...normalizedAssertions.map(({ assertionId }) => ["assertion-result", assertionId]),
    ...normalizedDiagnostics.map(({ diagnosticId }) => ["diagnostic", diagnosticId]),
  ].map(([type, identifier]) => `${type}:${identifier}`).sort();
  const manifestRecords = normalizedManifest.records.map(({ recordType, recordId }) => `${recordType}:${recordId}`).sort();
  const expectedArtifacts = normalizedArtifacts.map(({ artifactId }) => artifactId).sort();
  const manifestArtifacts = normalizedManifest.files.map(({ artifactId }) => artifactId).sort();
  if (expectedRecords.length !== manifestRecords.length || expectedRecords.some((item, index) => item !== manifestRecords[index]) || expectedArtifacts.length !== manifestArtifacts.length || expectedArtifacts.some((item, index) => item !== manifestArtifacts[index])) fail("INVALID_EVIDENCE_RELATIONSHIP", "review inputs do not reproduce the bundle manifest inventory");
  const failed = normalizedAssertions.filter(({ outcome }) => outcome === "failed").length;
  const reasons = [];
  if (normalizedRun.outcome !== "passed") reasons.push("RUN_FAILED");
  if (failed > 0) reasons.push("ASSERTION_FAILED");
  if (normalizedCheckpoints.some(({ outcome }) => outcome !== "captured")) reasons.push("CHECKPOINT_INCOMPLETE");
  const result = {
    schemaVersion: 1,
    reviewId: `review:${normalizedManifest.bundleId}`,
    runId: normalizedRun.runId,
    bundleId: normalizedManifest.bundleId,
    bundleDigest: normalizedManifest.bundleDigest,
    outcome: reasons.length === 0 ? "approved" : "rejected",
    assertionSummary: { total: normalizedAssertions.length, passed: normalizedAssertions.length - failed, failed },
    evidenceSummary: {
      checkpoints: normalizedCheckpoints.length,
      artifacts: normalizedArtifacts.length,
      diagnostics: normalizedDiagnostics.length,
      bytes: normalizedManifest.totals.fileBytes,
    },
    reasonCodes: reasons.sort(),
  };
  return Object.freeze(validateDesktopSmokeReviewResultV1(result));
}

export async function readDesktopSmokeEvidenceFilesV1(rootDirectory, artifacts) {
  if (typeof rootDirectory !== "string" || !isAbsolute(rootDirectory)) fail("UNSAFE_EVIDENCE_PATH", "evidence root must be absolute");
  const rootInfo = await lstat(rootDirectory).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) fail("UNSAFE_EVIDENCE_PATH", "evidence root must be a real directory");
  const root = await realpath(resolve(rootDirectory));
  const normalizedArtifacts = artifacts.map(validateDesktopSmokeArtifactV1);
  const files = [];
  for (const artifact of normalizedArtifacts) {
    const path = resolve(root, artifact.relativePath);
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`)) fail("UNSAFE_EVIDENCE_PATH", "artifact escapes the evidence root");
    let cursor = root;
    for (const segment of artifact.relativePath.split("/")) {
      cursor = join(cursor, segment);
      const component = await lstat(cursor).catch(() => null);
      if (!component || component.isSymbolicLink()) fail("UNSAFE_EVIDENCE_PATH", `artifact ${artifact.artifactId} path must not contain symlinks`);
    }
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) fail("UNSAFE_EVIDENCE_PATH", `artifact ${artifact.artifactId} must be a regular non-symlink file`);
    const bytes = await readFile(path);
    if (bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.digest) fail("EVIDENCE_DIGEST_MISMATCH", `artifact ${artifact.artifactId} does not match its contract`);
    files.push({ artifactId: artifact.artifactId, bytes });
  }
  return files.sort((left, right) => compareText(left.artifactId, right.artifactId));
}
