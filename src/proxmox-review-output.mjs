const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CODES = new Set(["UNEXPECTED_BLANK_STATE", "UNEXPECTED_CLIPPED_STATE", "UNEXPECTED_OVERLAP", "UNEXPECTED_MODAL_OBSCURATION", "UNEXPECTED_LOADING_STUCK", "VISUAL_INCONSISTENCY", "UNEXPECTED_BEHAVIORAL_STATE", "OTHER_VISUAL_ANOMALY"]);
const SEVERITIES = new Set(["info", "warning", "error", "critical"]);
const SENSITIVE = /(?:prompt|response|transcript|sealed|credential|cookie|authorization|raw[ _-]?guest|unsanitized|secret|token|environment)/iu;
function fail(message) { const error = new Error(message); error.code = "MALFORMED_REVIEW_OUTPUT"; throw error; }
function exact(value, fields) { if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("review output has an unsupported shape"); }
export function validateDesktopBundleReviewOutputV1(value, screenshots) {
  exact(value, ["schemaVersion", "outcome", "findings"]); if (value.schemaVersion !== 1 || !["clean", "findings"].includes(value.outcome) || !Array.isArray(value.findings) || value.findings.length > 32) fail("review output is invalid");
  const allowed = new Set(screenshots.map((item) => `${item.scenarioId}:${item.checkpointId}:${item.evidenceDigest}`)); const ids = new Set();
  const findings = value.findings.map((item) => { exact(item, ["findingId", "code", "severity", "scenarioId", "checkpointId", "observation", "evidenceDigest"]); const stableId = `finding:${String(item.code).toLowerCase()}:${item.scenarioId}:${item.checkpointId}:${String(item.evidenceDigest).slice(7, 19)}`; if (![item.findingId, item.scenarioId, item.checkpointId].every((field) => typeof field === "string" && ID.test(field)) || item.findingId !== stableId || ids.has(item.findingId) || !CODES.has(item.code) || !SEVERITIES.has(item.severity) || !DIGEST.test(item.evidenceDigest) || typeof item.observation !== "string" || item.observation.length < 1 || item.observation.length > 240 || SENSITIVE.test(item.observation) || !allowed.has(`${item.scenarioId}:${item.checkpointId}:${item.evidenceDigest}`)) fail("review finding is invalid or unsafe"); ids.add(item.findingId); return structuredClone(item); }).sort((a, b) => a.findingId.localeCompare(b.findingId));
  if ((value.outcome === "clean") !== (findings.length === 0)) fail("review outcome is inconsistent"); return { schemaVersion: 1, outcome: value.outcome, findings };
}
