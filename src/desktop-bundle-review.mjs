import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { canonicalBytes, canonicalDigest } from "./experimentation-contract/index.mjs";
import { validateDesktopSmokeEvidenceBundleV1 } from "./desktop-smoke-evidence-contract.mjs";

export const DESKTOP_BUNDLE_REVIEW_LIMITS_V1 = Object.freeze({
  maxFindings: 32,
  maxObservationCharacters: 240,
  maxScreenshots: 512,
  maxScreenshotBytes: 16 * 1024 * 1024,
  maxTotalScreenshotBytes: 64 * 1024 * 1024,
  maxBundleBytes: 96 * 1024 * 1024,
  maxImageDimension: 16_384,
  defaultReviewTimeoutMs: 5_000,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FINDING_CODES = new Set([
  "UNEXPECTED_BLANK_STATE", "UNEXPECTED_CLIPPED_STATE", "UNEXPECTED_OVERLAP",
  "UNEXPECTED_MODAL_OBSCURATION", "UNEXPECTED_LOADING_STUCK", "VISUAL_INCONSISTENCY",
  "UNEXPECTED_BEHAVIORAL_STATE", "OTHER_VISUAL_ANOMALY",
]);
const SEVERITIES = new Set(["info", "warning", "error", "critical"]);
const INVARIANTS = new Set([
  "all_scenarios_declared", "all_checkpoints_captured", "all_assertions_passed",
  "screenshots_sanitized", "cleanup_proven",
]);
const SENSITIVE = /(?:sealed|transcript|credential|cookie|authorization|raw[ _-]?guest|unsanitized|secret|token)/iu;

export class DesktopBundleReviewError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "DesktopBundleReviewError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new DesktopBundleReviewError(code, message, details);
}

function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("INVALID_REVIEW_INPUT", `${label} must be a plain object`);
}

function exact(value, fields, label) {
  plain(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail("INVALID_REVIEW_INPUT", `${label} fields must match the closed schema`, { actual, expected });
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("INVALID_REVIEW_INPUT", `${label} is invalid`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("INVALID_REVIEW_INPUT", `${label} is invalid`);
  return value;
}

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function entryPayloads(bundleBytes) {
  const verified = validateDesktopSmokeEvidenceBundleV1(bundleBytes);
  const bundle = JSON.parse(verified.bytes.toString("utf8"));
  const entries = new Map(bundle.entries.map((entry) => [entry.relativePath, Buffer.from(entry.data, "base64")]));
  const records = { run: null, checkpoints: [], artifacts: [], assertions: [], diagnostics: [] };
  for (const record of verified.manifest.records) {
    const payload = JSON.parse(entries.get(record.relativePath).toString("utf8"));
    if (record.recordType === "run") records.run = payload;
    else if (record.recordType === "checkpoint") records.checkpoints.push(payload);
    else if (record.recordType === "artifact") records.artifacts.push(payload);
    else if (record.recordType === "assertion-result") records.assertions.push(payload);
    else records.diagnostics.push(payload);
  }
  return { verified, entries, records };
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.byteLength < 33 || !bytes.subarray(0, 8).equals(signature)) fail("SCREENSHOT_DECODE_FAILED", "PNG signature is invalid");
  let offset = 8; let width = null; let height = null; let bitDepth; let colorType; let interlace; const data = []; let ended = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.byteLength - offset - 12) fail("SCREENSHOT_DECODE_FAILED", "PNG chunk exceeds its file bounds");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) fail("SCREENSHOT_DECODE_FAILED", "PNG chunk checksum is invalid");
    if (type === "IHDR") {
      if (width !== null || length !== 13) fail("SCREENSHOT_DECODE_FAILED", "PNG IHDR is invalid");
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); bitDepth = chunk[8]; colorType = chunk[9]; interlace = chunk[12];
    } else if (type === "IDAT") data.push(chunk);
    else if (type === "IEND") { ended = true; offset += length + 12; break; }
    offset += length + 12;
  }
  const channels = new Map([[0, 1], [2, 3], [4, 2], [6, 4]]).get(colorType);
  if (!ended || offset !== bytes.byteLength || width === null || data.length === 0 || bitDepth !== 8 || !channels || interlace !== 0) fail("SCREENSHOT_DECODE_FAILED", "PNG encoding is unsupported or incomplete");
  imageBounds(width, height);
  let inflated;
  try { inflated = inflateSync(Buffer.concat(data), { maxOutputLength: Math.min((width * channels + 1) * height, DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxScreenshotBytes * 8) }); }
  catch { fail("SCREENSHOT_DECODE_FAILED", "PNG pixel stream cannot be decoded"); }
  const stride = width * channels;
  if (inflated.byteLength !== (stride + 1) * height) fail("SCREENSHOT_DECODE_FAILED", "PNG pixel stream has unexpected dimensions");
  const decoded = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const source = row * (stride + 1); const target = row * stride; const filter = inflated[source];
    if (filter > 4) fail("SCREENSHOT_DECODE_FAILED", "PNG filter is invalid");
    for (let column = 0; column < stride; column += 1) {
      const raw = inflated[source + 1 + column]; const left = column >= channels ? decoded[target + column - channels] : 0;
      const above = row > 0 ? decoded[target + column - stride] : 0;
      const upperLeft = row > 0 && column >= channels ? decoded[target + column - stride - channels] : 0;
      decoded[target + column] = filter === 0 ? raw : filter === 1 ? raw + left : filter === 2 ? raw + above : filter === 3 ? raw + Math.floor((left + above) / 2) : raw + paeth(left, above, upperLeft);
    }
  }
  return { width, height };
}

function imageBounds(width, height) {
  integer(width, "screenshot width", 1, DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxImageDimension);
  integer(height, "screenshot height", 1, DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxImageDimension);
}

function decodeJpeg(bytes) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) fail("SCREENSHOT_DECODE_FAILED", "JPEG boundaries are invalid");
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) fail("SCREENSHOT_DECODE_FAILED", "JPEG marker is invalid");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda) break;
    if (offset + 2 > bytes.byteLength) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) fail("SCREENSHOT_DECODE_FAILED", "JPEG segment exceeds its file bounds");
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = bytes.readUInt16BE(offset + 3); const width = bytes.readUInt16BE(offset + 5); imageBounds(width, height); return { width, height };
    }
    offset += length;
  }
  fail("SCREENSHOT_DECODE_FAILED", "JPEG has no decodable frame");
}

function decodeWebp(bytes) {
  if (bytes.byteLength < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") fail("SCREENSHOT_DECODE_FAILED", "WebP container is invalid");
  const type = bytes.toString("ascii", 12, 16); let width; let height;
  if (type === "VP8X") { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
  else if (type === "VP8L" && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
  else fail("SCREENSHOT_DECODE_FAILED", "WebP encoding is unsupported");
  imageBounds(width, height); return { width, height };
}

function decodeScreenshot(bytes, mediaType) {
  if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxScreenshotBytes) fail("EVIDENCE_BOUNDS_EXCEEDED", "screenshot byte length is outside review bounds");
  if (mediaType === "image/png") return decodePng(bytes);
  if (mediaType === "image/jpeg") return decodeJpeg(bytes);
  if (mediaType === "image/webp") return decodeWebp(bytes);
  fail("SCREENSHOT_DECODE_FAILED", "screenshot media type is unsupported");
}

function normalizeExpectations(value) {
  exact(value, ["schemaVersion", "requiredCheckpoints", "requiredAssertions", "scenarioOutcomes", "workflowInvariants"], "expectations");
  if (value.schemaVersion !== 1 || !Array.isArray(value.requiredCheckpoints) || !Array.isArray(value.requiredAssertions) || !Array.isArray(value.scenarioOutcomes) || !Array.isArray(value.workflowInvariants)) fail("INVALID_REVIEW_INPUT", "expectation collections are invalid");
  const requiredCheckpoints = value.requiredCheckpoints.map((item, index) => {
    exact(item, ["scenarioId", "checkpointId", "type", "minWidth", "minHeight", "maxWidth", "maxHeight"], `requiredCheckpoints[${index}]`);
    id(item.scenarioId, "required checkpoint scenarioId"); id(item.checkpointId, "required checkpoint checkpointId");
    if (!new Set(["accessibility_tree", "screenshot", "window_state"]).has(item.type)) fail("INVALID_REVIEW_INPUT", "required checkpoint type is invalid");
    for (const field of ["minWidth", "minHeight", "maxWidth", "maxHeight"]) integer(item[field], `required checkpoint ${field}`, 0, DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxImageDimension);
    if (item.minWidth > item.maxWidth || item.minHeight > item.maxHeight || (item.type === "screenshot" && (item.minWidth < 1 || item.minHeight < 1))) fail("INVALID_REVIEW_INPUT", "required checkpoint dimensions are invalid");
    return structuredClone(item);
  });
  const requiredAssertions = value.requiredAssertions.map((item, index) => {
    exact(item, ["scenarioId", "assertionId", "checkpointId", "outcome"], `requiredAssertions[${index}]`);
    for (const field of ["scenarioId", "assertionId", "checkpointId"]) id(item[field], `required assertion ${field}`);
    if (!["passed", "failed"].includes(item.outcome)) fail("INVALID_REVIEW_INPUT", "required assertion outcome is invalid");
    return structuredClone(item);
  });
  const scenarioOutcomes = value.scenarioOutcomes.map((item, index) => {
    exact(item, ["scenarioId", "outcome"], `scenarioOutcomes[${index}]`); id(item.scenarioId, "scenario outcome scenarioId");
    if (!["passed", "failed", "crashed"].includes(item.outcome)) fail("INVALID_REVIEW_INPUT", "expected scenario outcome is invalid");
    return structuredClone(item);
  });
  if (new Set(scenarioOutcomes.map(({ scenarioId }) => scenarioId)).size !== scenarioOutcomes.length) fail("INVALID_REVIEW_INPUT", "execution scenario outcomes must be unique");
  const workflowInvariants = value.workflowInvariants.map((item) => { if (!INVARIANTS.has(item)) fail("INVALID_REVIEW_INPUT", "workflow invariant is invalid"); return item; });
  for (const [items, key, label] of [[requiredCheckpoints, "checkpointId", "required checkpoints"], [requiredAssertions, "assertionId", "required assertions"], [scenarioOutcomes, "scenarioId", "scenario outcomes"]]) if (new Set(items.map((item) => item[key])).size !== items.length) fail("INVALID_REVIEW_INPUT", `${label} must be unique`);
  if (new Set(workflowInvariants).size !== workflowInvariants.length) fail("INVALID_REVIEW_INPUT", "workflow invariants must be unique");
  return { requiredCheckpoints, requiredAssertions, scenarioOutcomes, workflowInvariants: [...workflowInvariants].sort() };
}

function normalizeExecution(value) {
  exact(value, ["runId", "outcome", "scenarioOutcomes", "cleanup"], "execution receipt");
  id(value.runId, "execution runId");
  if (!["passed", "failed"].includes(value.outcome) || !Array.isArray(value.scenarioOutcomes)) fail("INVALID_REVIEW_INPUT", "execution status is invalid");
  const scenarioOutcomes = value.scenarioOutcomes.map((item, index) => {
    exact(item, ["scenarioId", "outcome"], `execution scenarioOutcomes[${index}]`); id(item.scenarioId, "execution scenarioId");
    if (!["passed", "failed", "crashed"].includes(item.outcome)) fail("INVALID_REVIEW_INPUT", "execution scenario outcome is invalid");
    return structuredClone(item);
  });
  exact(value.cleanup, ["cloneId", "destroyed", "absent", "independentlyVerified"], "cleanup proof"); id(value.cleanup.cloneId, "cleanup cloneId");
  return { runId: value.runId, outcome: value.outcome, scenarioOutcomes, cleanup: structuredClone(value.cleanup) };
}

function check(checkId, passed, code, location = null) { return { checkId, status: passed ? "passed" : "failed", code, location }; }

export function runDesktopBundleAssertionsV1({ bundle, expectations, execution }) {
  const bundleBytes = Buffer.isBuffer(bundle) ? Buffer.from(bundle) : bundle instanceof Uint8Array ? Buffer.from(bundle) : fail("INVALID_REVIEW_INPUT", "bundle must be bytes");
  const expected = normalizeExpectations(expectations); const executed = normalizeExecution(execution);
  if (bundleBytes.byteLength > DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxBundleBytes) {
    const bundleDigest = sha256(bundleBytes);
    return Object.freeze({ schemaVersion: 1, evaluatorId: "desktop-bundle-assertion-evaluator-v1", bundleId: null, bundleDigest, status: "failed", checks: [check("evidence-bounds", false, "EVIDENCE_BOUNDS_EXCEEDED")], screenshotInventory: [], receiptDigest: canonicalDigest({ error: "EVIDENCE_BOUNDS_EXCEEDED", bundleDigest }) });
  }
  let parsed;
  try { parsed = entryPayloads(bundleBytes); }
  catch (error) {
    return Object.freeze({ schemaVersion: 1, evaluatorId: "desktop-bundle-assertion-evaluator-v1", bundleId: null, bundleDigest: sha256(bundleBytes), status: "failed", checks: [check("manifest-integrity", false, error.code ?? "MANIFEST_INVALID")], screenshotInventory: [], receiptDigest: canonicalDigest({ error: error.code ?? "MANIFEST_INVALID", bundleDigest: sha256(bundleBytes) }) });
  }
  const { verified, entries, records } = parsed; const checks = [];
  checks.push(check("manifest-integrity", true, "MANIFEST_VERIFIED"));
  const identityMatches = executed.runId === verified.manifest.runId && records.run?.runId === executed.runId;
  checks.push(check("run-identity", identityMatches, identityMatches ? "RUN_IDENTITY_MATCH" : "RUN_IDENTITY_MISMATCH"));
  const executionStatusMatches = records.run?.outcome === executed.outcome;
  checks.push(check("execution-status", executionStatusMatches, executionStatusMatches ? "EXECUTION_STATUS_MATCH" : "EXECUTION_STATUS_MISMATCH"));
  const checkpoints = new Map(records.checkpoints.map((item) => [item.checkpointId, item]));
  const artifacts = new Map(records.artifacts.map((item) => [item.artifactId, item]));
  const screenshotInventory = []; let screenshotBytes = 0;
  const screenshotArtifacts = records.artifacts.filter(({ kind }) => kind === "screenshot");
  if (screenshotArtifacts.length > DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxScreenshots) checks.push(check("screenshot-count-bound", false, "EVIDENCE_BOUNDS_EXCEEDED"));
  for (const artifact of screenshotArtifacts.slice(0, DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxScreenshots)) {
    const bytes = entries.get(artifact.relativePath); let dimensions = null; let code = "SCREENSHOT_DECODED";
    try { dimensions = decodeScreenshot(bytes, artifact.mediaType); screenshotBytes += bytes.byteLength; }
    catch (error) { code = error.code ?? "SCREENSHOT_DECODE_FAILED"; }
    checks.push(check(`screenshot-decode:${artifact.artifactId}`, code === "SCREENSHOT_DECODED", code, { scenarioId: artifact.scenarioId, checkpointId: artifact.checkpointId }));
    if (dimensions) screenshotInventory.push({ artifactId: artifact.artifactId, scenarioId: artifact.scenarioId, checkpointId: artifact.checkpointId, evidenceDigest: artifact.digest, mediaType: artifact.mediaType, byteLength: artifact.byteLength, width: dimensions.width, height: dimensions.height });
  }
  const screenshotById = new Map(screenshotInventory.map((item) => [item.artifactId, item]));
  for (const requirement of expected.requiredCheckpoints) {
    const checkpoint = checkpoints.get(requirement.checkpointId);
    const matches = checkpoint?.scenarioId === requirement.scenarioId && checkpoint?.type === requirement.type && checkpoint?.outcome === "captured";
    checks.push(check(`checkpoint:${requirement.checkpointId}`, matches, matches ? "CHECKPOINT_VERIFIED" : "CHECKPOINT_MISSING_OR_INCOMPLETE", { scenarioId: requirement.scenarioId, checkpointId: requirement.checkpointId }));
    if (!matches || requirement.type !== "screenshot") continue;
    const screenshots = checkpoint.artifactIds.map((artifactId) => artifacts.get(artifactId)).filter((artifact) => artifact?.kind === "screenshot");
    if (screenshots.length !== 1) { checks.push(check(`screenshot:${requirement.checkpointId}`, false, "SCREENSHOT_CARDINALITY_INVALID", { scenarioId: requirement.scenarioId, checkpointId: requirement.checkpointId })); continue; }
    const artifact = screenshots[0]; const dimensions = screenshotById.get(artifact.artifactId); let code = dimensions ? "SCREENSHOT_VERIFIED" : "SCREENSHOT_DECODE_FAILED";
    if (dimensions && (dimensions.width < requirement.minWidth || dimensions.width > requirement.maxWidth || dimensions.height < requirement.minHeight || dimensions.height > requirement.maxHeight)) code = "SCREENSHOT_DIMENSIONS_OUT_OF_BOUNDS";
    const passed = code === "SCREENSHOT_VERIFIED";
    checks.push(check(`screenshot:${requirement.checkpointId}`, passed, code, { scenarioId: requirement.scenarioId, checkpointId: requirement.checkpointId }));
  }
  const actualScenarioOutcomes = new Map(executed.scenarioOutcomes.map((item) => [item.scenarioId, item.outcome]));
  for (const expectation of expected.scenarioOutcomes) {
    const matches = actualScenarioOutcomes.get(expectation.scenarioId) === expectation.outcome;
    checks.push(check(`scenario:${expectation.scenarioId}`, matches, matches ? "SCENARIO_OUTCOME_MATCH" : "SCENARIO_OUTCOME_MISMATCH", { scenarioId: expectation.scenarioId, checkpointId: null }));
  }
  const assertionById = new Map(records.assertions.map((item) => [item.assertionId, item]));
  const assertionInventoryMatches = records.assertions.length === expected.requiredAssertions.length && assertionById.size === expected.requiredAssertions.length && expected.requiredAssertions.every((item) => {
    const actual = assertionById.get(item.assertionId); return actual?.scenarioId === item.scenarioId && actual?.checkpointId === item.checkpointId && actual?.outcome === item.outcome;
  });
  checks.push(check("assertion-inventory", assertionInventoryMatches, assertionInventoryMatches ? "ASSERTION_INVENTORY_VERIFIED" : "ASSERTION_INVENTORY_MISMATCH"));
  checks.push(check("evidence-bounds", screenshotInventory.length <= DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxScreenshots && screenshotBytes <= DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxTotalScreenshotBytes, "EVIDENCE_WITHIN_BOUNDS"));
  const cleanupProven = executed.cleanup.destroyed === true && executed.cleanup.absent === true && executed.cleanup.independentlyVerified === true;
  const invariantResults = {
    all_scenarios_declared: records.run?.scenarioIds.length === expected.scenarioOutcomes.length && records.run.scenarioIds.every((scenarioId) => actualScenarioOutcomes.has(scenarioId)),
    all_checkpoints_captured: records.checkpoints.every(({ outcome }) => outcome === "captured"),
    all_assertions_passed: assertionInventoryMatches && expected.requiredAssertions.length > 0 && records.assertions.every(({ outcome }) => outcome === "passed"),
    screenshots_sanitized: records.artifacts.filter(({ kind }) => kind === "screenshot").every(({ protection }) => protection?.attested === true && protection?.outputSanitized === true && protection?.sourcePixelsRetained === false),
    cleanup_proven: cleanupProven,
  };
  checks.push(check("cleanup-proof", cleanupProven, cleanupProven ? "CLEANUP_PROVEN" : "CLEANUP_NOT_PROVEN"));
  for (const invariant of expected.workflowInvariants) checks.push(check(`invariant:${invariant}`, invariantResults[invariant], invariantResults[invariant] ? "INVARIANT_VERIFIED" : "INVARIANT_VIOLATED"));
  const body = { schemaVersion: 1, evaluatorId: "desktop-bundle-assertion-evaluator-v1", bundleId: verified.manifest.bundleId, bundleDigest: verified.manifest.bundleDigest, status: checks.every(({ status }) => status === "passed") ? "passed" : "failed", checks, screenshotInventory: screenshotInventory.sort((left, right) => compare(left.artifactId, right.artifactId)) };
  return Object.freeze({ ...body, receiptDigest: canonicalDigest(body) });
}

function stableFindingId(finding) {
  return `finding:${finding.code.toLowerCase()}:${finding.scenarioId}:${finding.checkpointId}:${finding.evidenceDigest.slice(7, 19)}`;
}

export function validateIndependentReviewOutputV1(value, allowedEvidence) {
  exact(value, ["schemaVersion", "outcome", "findings"], "independent review output");
  if (value.schemaVersion !== 1 || !["clean", "findings"].includes(value.outcome) || !Array.isArray(value.findings) || value.findings.length > DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxFindings) fail("MALFORMED_REVIEW_OUTPUT", "review output is invalid or exceeds its finding bound");
  const allowed = new Map(allowedEvidence.map((item) => [`${item.scenarioId}:${item.checkpointId}:${item.evidenceDigest}`, item]));
  const findings = value.findings.map((finding, index) => {
    exact(finding, ["findingId", "code", "severity", "scenarioId", "checkpointId", "observation", "evidenceDigest"], `finding[${index}]`);
    for (const field of ["findingId", "scenarioId", "checkpointId"]) id(finding[field], `finding.${field}`);
    if (!FINDING_CODES.has(finding.code) || !SEVERITIES.has(finding.severity) || !DIGEST.test(finding.evidenceDigest)) fail("MALFORMED_REVIEW_OUTPUT", "finding classification is invalid");
    if (typeof finding.observation !== "string" || finding.observation.length < 1 || finding.observation.length > DESKTOP_BUNDLE_REVIEW_LIMITS_V1.maxObservationCharacters || SENSITIVE.test(finding.observation)) fail("MALFORMED_REVIEW_OUTPUT", "finding observation is unsafe or unbounded");
    if (!allowed.has(`${finding.scenarioId}:${finding.checkpointId}:${finding.evidenceDigest}`)) fail("MALFORMED_REVIEW_OUTPUT", "finding evidence is not in the sanitized review context");
    if (finding.findingId !== stableFindingId(finding)) fail("MALFORMED_REVIEW_OUTPUT", "finding identifier is not stable");
    return structuredClone(finding);
  }).sort((left, right) => compare(left.findingId, right.findingId));
  if (new Set(findings.map(({ findingId }) => findingId)).size !== findings.length || (value.outcome === "clean") !== (findings.length === 0)) fail("MALFORMED_REVIEW_OUTPUT", "review outcome and findings are inconsistent");
  return { schemaVersion: 1, outcome: value.outcome, findings };
}

function reviewFailure(assertions, status, errorCode) {
  const body = { schemaVersion: 1, reviewerId: null, bundleId: assertions.bundleId, bundleDigest: assertions.bundleDigest, status, findings: [], errorCode };
  return Object.freeze({ ...body, receiptDigest: canonicalDigest(body) });
}

async function independentReview({ bundle, assertions, reviewer, timeoutMs }) {
  if (assertions.status !== "passed") return reviewFailure(assertions, "not_run", "ASSERTIONS_NOT_PASSED");
  if (reviewer === null || reviewer === undefined) return reviewFailure(assertions, "unavailable", "REVIEW_SERVICE_UNAVAILABLE");
  exact(reviewer, ["reviewerId", "review"], "reviewer"); id(reviewer.reviewerId, "reviewerId");
  if (reviewer.reviewerId === assertions.evaluatorId || typeof reviewer.review !== "function") return reviewFailure(assertions, "failed", "REVIEWER_NOT_INDEPENDENT");
  const { verified, entries, records } = entryPayloads(bundle);
  const inventoryById = new Map(assertions.screenshotInventory.map((item) => [item.artifactId, item]));
  const screenshots = records.artifacts.filter(({ artifactId }) => inventoryById.has(artifactId)).map((artifact) => ({ ...inventoryById.get(artifact.artifactId), bytes: Buffer.from(entries.get(artifact.relativePath)) }));
  const context = {
    schemaVersion: 1,
    manifestContext: { bundleId: verified.manifest.bundleId, runId: verified.manifest.runId, bundleDigest: verified.manifest.bundleDigest, format: verified.manifest.format, totals: structuredClone(verified.manifest.totals) },
    screenshots,
  };
  let output; let timer = null;
  try {
    output = await Promise.race([
      Promise.resolve().then(() => reviewer.review(context)),
      new Promise((resolve) => { timer = setTimeout(() => resolve(Symbol.for("review-timeout")), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (output === Symbol.for("review-timeout")) return reviewFailure(assertions, "timed_out", "REVIEW_TIMEOUT");
  } catch (error) {
    clearTimeout(timer);
    return reviewFailure(assertions, error?.code === "REVIEW_SERVICE_UNAVAILABLE" ? "unavailable" : "failed", error?.code === "REVIEW_SERVICE_UNAVAILABLE" ? "REVIEW_SERVICE_UNAVAILABLE" : "REVIEW_FAILED");
  }
  let normalized;
  try { normalized = validateIndependentReviewOutputV1(output, assertions.screenshotInventory); }
  catch { return reviewFailure(assertions, "malformed", "MALFORMED_REVIEW_OUTPUT"); }
  const body = { schemaVersion: 1, reviewerId: reviewer.reviewerId, bundleId: assertions.bundleId, bundleDigest: assertions.bundleDigest, status: normalized.findings.length === 0 ? "passed" : "findings", findings: normalized.findings, errorCode: null };
  return Object.freeze({ ...body, receiptDigest: canonicalDigest(body) });
}

export function renderDesktopBundleReviewSummaryV1({ execution, assertions, review }) {
  const findings = review.findings.map(({ findingId, severity, scenarioId, checkpointId, observation, evidenceDigest }) => ({ findingId, severity, scenarioId, checkpointId, observation, evidenceDigest }));
  const summary = { schemaVersion: 1, bundle: { bundleId: assertions.bundleId, bundleDigest: assertions.bundleDigest }, execution: { runId: execution.runId, status: execution.outcome }, assertions: { status: assertions.status, receiptDigest: assertions.receiptDigest }, review: { status: review.status, receiptDigest: review.receiptDigest, errorCode: review.errorCode }, findings, cleanup: structuredClone(execution.cleanup) };
  const findingText = findings.length === 0 ? "none" : findings.map((item) => `${item.findingId} [${item.severity}] ${item.scenarioId}/${item.checkpointId}: ${item.observation} (${item.evidenceDigest})`).join("\n");
  const text = [`Bundle: ${summary.bundle.bundleId ?? "unverified"} ${summary.bundle.bundleDigest}`, `Execution: ${summary.execution.status}`, `Assertions: ${summary.assertions.status}`, `Independent review: ${summary.review.status}${summary.review.errorCode ? ` (${summary.review.errorCode})` : ""}`, `Cleanup: destroyed=${summary.cleanup.destroyed} absent=${summary.cleanup.absent} independentlyVerified=${summary.cleanup.independentlyVerified}`, `Findings: ${findingText}`].join("\n");
  return Object.freeze({ json: Object.freeze(summary), text });
}

export async function runDesktopBundleReviewPipelineV1({ bundle, expectations, execution, reviewer, reviewTimeoutMs = DESKTOP_BUNDLE_REVIEW_LIMITS_V1.defaultReviewTimeoutMs }) {
  integer(reviewTimeoutMs, "reviewTimeoutMs", 1, 60_000);
  const normalizedExecution = normalizeExecution(execution);
  const assertions = runDesktopBundleAssertionsV1({ bundle, expectations, execution: normalizedExecution });
  const review = await independentReview({ bundle, assertions, reviewer, timeoutMs: reviewTimeoutMs });
  const report = renderDesktopBundleReviewSummaryV1({ execution: normalizedExecution, assertions, review });
  return Object.freeze({ schemaVersion: 1, assertions, review, report });
}

export function createDeterministicReviewerFixtureV1(findingsByEvidenceDigest = {}) {
  plain(findingsByEvidenceDigest, "fixture findings");
  return Object.freeze({
    reviewerId: "deterministic-sanitized-visual-reviewer-fixture-v1",
    async review(context) {
      exact(context, ["schemaVersion", "manifestContext", "screenshots"], "sanitized review context");
      const findings = [];
      for (const screenshot of context.screenshots) {
        const templates = findingsByEvidenceDigest[screenshot.evidenceDigest] ?? [];
        for (const template of templates) {
          exact(template, ["code", "severity", "observation"], "fixture finding");
          const finding = { code: template.code, severity: template.severity, scenarioId: screenshot.scenarioId, checkpointId: screenshot.checkpointId, observation: template.observation, evidenceDigest: screenshot.evidenceDigest };
          findings.push({ findingId: stableFindingId(finding), ...finding });
        }
      }
      return { schemaVersion: 1, outcome: findings.length === 0 ? "clean" : "findings", findings };
    },
  });
}
