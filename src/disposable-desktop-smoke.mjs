import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { validateDesktopSmokeScenarioV1 } from "./desktop-smoke-contract.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FORBIDDEN_EVIDENCE_KEYS = /(?:prompt|response|transcript|rawpixels|cookie|token|credential|secret|environment|sealed|authorization)/iu;
const ADAPTER_METHODS = Object.freeze([
  "cloneTemplate", "installCandidate", "launchDesktop", "readLoadedIdentity",
  "runScenario", "collectEvidence", "destroyClone", "verifyAbsent",
]);

export class DesktopSmokeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "DesktopSmokeError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) { throw new DesktopSmokeError(code, message, details); }
function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SMOKE_RECEIPT", `${label} must be an object`);
}
function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("INVALID_SMOKE_REQUEST", `${label} is invalid`);
}
function sameIdentity(actual, candidate, stage) {
  object(actual, `${stage} identity`);
  for (const key of ["version", "digest", "sourceRevision"]) {
    if (actual[key] !== candidate[key]) fail("CANDIDATE_IDENTITY_MISMATCH", `${stage} ${key} does not match the candidate`);
  }
}
function containsPath(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}
function scanEvidence(value, path = "evidence") {
  if (Array.isArray(value)) { value.forEach((item, index) => scanEvidence(item, `${path}[${index}]`)); return; }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_EVIDENCE_KEYS.test(key)) fail("UNSAFE_SMOKE_EVIDENCE", `${path}.${key} is forbidden`);
    scanEvidence(item, `${path}.${key}`);
  }
}
function validateEvidenceItem(item, scenarioIds, kind) {
  object(item, `${kind} evidence`);
  identifier(item.scenarioId, "evidence scenarioId");
  if (!scenarioIds.has(item.scenarioId) || !DIGEST.test(item.digest) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || item.sanitized !== true) fail("INVALID_SMOKE_EVIDENCE", `${kind} evidence is invalid`);
  const allowed = kind === "screenshot" ? new Set(["scenarioId", "digest", "byteLength", "mediaType", "sanitized"]) : new Set(["scenarioId", "digest", "byteLength", "code", "sanitized"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) fail("INVALID_SMOKE_EVIDENCE", `${kind} evidence contains unsupported data`);
  if (kind === "screenshot" && !["image/png", "image/jpeg"].includes(item.mediaType)) fail("INVALID_SMOKE_EVIDENCE", "screenshot media type is invalid");
  if (kind === "diagnostic") identifier(item.code, "diagnostic code");
  return structuredClone(item);
}

export async function validateDesktopSmokeCandidateV1(candidate, { controllerCodexHome = process.env.CODEX_HOME } = {}) {
  object(candidate, "candidate");
  if (Object.keys(candidate).sort().join(",") !== ["digest", "packagePath", "sourceRevision", "version"].sort().join(",")) fail("INVALID_SMOKE_REQUEST", "candidate has an unsupported shape");
  if (!isAbsolute(candidate.packagePath) || !DIGEST.test(candidate.digest) || !REVISION.test(candidate.sourceRevision) || typeof candidate.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(candidate.version)) fail("INVALID_SMOKE_REQUEST", "candidate identity is invalid");
  const packagePath = await realpath(resolve(candidate.packagePath));
  if (controllerCodexHome) {
    const home = await realpath(resolve(controllerCodexHome)).catch(() => resolve(controllerCodexHome));
    if (containsPath(home, packagePath)) fail("CONTROLLER_CACHE_CONTAMINATION", "candidate package must be outside the controller CODEX_HOME");
  }
  return Object.freeze({ ...structuredClone(candidate), packagePath });
}

export async function runDisposableDesktopSmokeV1({ candidate, scenarioSet, adapter, controllerCodexHome, clock = Date }) {
  const immutableCandidate = await validateDesktopSmokeCandidateV1(candidate, { controllerCodexHome });
  object(scenarioSet, "scenario set");
  identifier(scenarioSet.scenarioSetId, "scenarioSetId");
  if (scenarioSet.schemaVersion !== 1 || !Array.isArray(scenarioSet.scenarios) || scenarioSet.scenarios.length < 1 || scenarioSet.scenarios.length > 100) fail("INVALID_SMOKE_REQUEST", "scenario set is invalid");
  if (Object.keys(scenarioSet).sort().join(",") !== ["schemaVersion", "scenarioSetId", "scenarios"].sort().join(",")) fail("INVALID_SMOKE_REQUEST", "scenario set has an unsupported shape");
  const scenarios = scenarioSet.scenarios.map((scenario) => validateDesktopSmokeScenarioV1(structuredClone(scenario)));
  if (new Set(scenarios.map(({ scenarioId }) => scenarioId)).size !== scenarios.length) fail("INVALID_SMOKE_REQUEST", "scenario IDs must be unique");
  for (const method of ADAPTER_METHODS) if (typeof adapter?.[method] !== "function") fail("INVALID_SMOKE_ADAPTER", `adapter is missing ${method}`);

  const startedAt = new Date(clock.now()).toISOString();
  let clone = null;
  let primaryError = null;
  let cleanup = null;
  const results = [];
  let evidence = null;
  try {
    clone = await adapter.cloneTemplate({ candidate: immutableCandidate, scenarioSetId: scenarioSet.scenarioSetId });
    object(clone, "clone receipt");
    for (const key of ["cloneId", "templateRef", "accountId"]) identifier(clone[key], key);
    if (Object.keys(clone).sort().join(",") !== "accountId,cloneId,guestCodexHome,templateRef" || typeof clone.guestCodexHome !== "string") fail("INVALID_CLONE_ISOLATION", "clone receipt has an unsupported shape");
    if (!isAbsolute(clone.guestCodexHome)) fail("INVALID_CLONE_ISOLATION", "clone must use a separate absolute CODEX_HOME");
    if (controllerCodexHome) {
      const controllerHome = await realpath(resolve(controllerCodexHome)).catch(() => resolve(controllerCodexHome));
      const guestHome = await realpath(resolve(clone.guestCodexHome)).catch(() => resolve(clone.guestCodexHome));
      if (containsPath(controllerHome, guestHome)) fail("INVALID_CLONE_ISOLATION", "clone CODEX_HOME must be outside the controller CODEX_HOME");
    }
    const installed = await adapter.installCandidate({ clone: structuredClone(clone), candidate: immutableCandidate });
    sameIdentity(installed, immutableCandidate, "installed");
    await adapter.launchDesktop({ clone: structuredClone(clone) });
    const loaded = await adapter.readLoadedIdentity({ clone: structuredClone(clone) });
    sameIdentity(loaded, immutableCandidate, "loaded");
    for (const scenario of scenarios) {
      const result = await adapter.runScenario({ clone: structuredClone(clone), scenario: structuredClone(scenario) });
      object(result, "scenario result");
      if (result.scenarioId !== scenario.scenarioId || !["passed", "failed", "timed_out"].includes(result.outcome)) fail("INVALID_SMOKE_RECEIPT", "scenario result is invalid");
      const failure = result.failure === null || result.failure === undefined
        ? null
        : (typeof result.failure?.code === "string" && ID.test(result.failure.code)
          ? { code: result.failure.code }
          : fail("INVALID_SMOKE_RECEIPT", "scenario failure receipt is invalid"));
      results.push({ scenarioId: result.scenarioId, outcome: result.outcome, failure });
    }
    evidence = await adapter.collectEvidence({ clone: structuredClone(clone), scenarioIds: scenarios.map(({ scenarioId }) => scenarioId) });
    object(evidence, "evidence receipt"); scanEvidence(evidence);
    if (Object.keys(evidence).sort().join(",") !== "diagnostics,screenshots" || !Array.isArray(evidence.screenshots) || !Array.isArray(evidence.diagnostics)) fail("INVALID_SMOKE_EVIDENCE", "evidence receipt is invalid");
    const scenarioIds = new Set(scenarios.map(({ scenarioId }) => scenarioId));
    evidence = {
      screenshots: evidence.screenshots.map((item) => validateEvidenceItem(item, scenarioIds, "screenshot")),
      diagnostics: evidence.diagnostics.map((item) => validateEvidenceItem(item, scenarioIds, "diagnostic")),
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (clone !== null) {
      let destroyed = null; let absent = null; let destroyError = null; let absenceError = null;
      try { destroyed = await adapter.destroyClone({ clone: structuredClone(clone) }); }
      catch (error) { destroyError = error; }
      try { absent = await adapter.verifyAbsent({ clone: structuredClone(clone) }); }
      catch (error) { absenceError = error; }
      if (destroyError || absenceError || destroyed?.cloneId !== clone.cloneId || destroyed?.destroyed !== true || absent?.cloneId !== clone.cloneId || absent?.absent !== true) {
        throw new DesktopSmokeError("CLEANUP_NOT_PROVEN", "disposable Desktop clone cleanup failed closed", { primaryCode: primaryError?.code ?? null, destroyCode: destroyError?.code ?? null, absenceCode: absenceError?.code ?? null });
      }
      cleanup = { cloneId: clone.cloneId, destroyed: true, absent: true };
    }
  }
  if (primaryError) throw primaryError;
  const passed = results.filter(({ outcome }) => outcome === "passed").length;
  return Object.freeze({
    schemaVersion: 1,
    candidate: immutableCandidate,
    scenarioSetId: scenarioSet.scenarioSetId,
    startedAt,
    finishedAt: new Date(clock.now()).toISOString(),
    outcome: passed === results.length ? "passed" : "failed",
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
    evidence,
    cleanup,
  });
}
