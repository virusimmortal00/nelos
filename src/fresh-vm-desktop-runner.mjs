import { createHash } from "node:crypto";

import { validateDesktopSmokeScenarioSetV1 } from "./desktop-smoke-contract.mjs";
import { validateDesktopSmokeCandidateV1, DesktopSmokeError } from "./disposable-desktop-smoke.mjs";
import { validateDesktopSmokeEvidenceBundleV1 } from "./desktop-smoke-evidence-contract.mjs";
import { canonicalBytes } from "./experimentation-contract/index.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const METHODS = Object.freeze([
  "cloneTemplate", "installCandidate", "readLoadedIdentity", "executeScenario",
  "packageEvidence", "destroyClone", "verifyAbsent",
]);

export const FRESH_VM_DEADLINES_V1 = Object.freeze({
  runMs: 90 * 60_000,
  installMs: 10 * 60_000,
  identityMs: 60_000,
  scenarioMs: 30 * 60_000,
  actionMs: 5 * 60_000,
  evidenceMs: 5 * 60_000,
  destroyMs: 5 * 60_000,
  absenceMs: 2 * 60_000,
});
export const MAX_FRESH_VM_BUNDLE_BYTES_V1 = 24 * 1024 * 1024;

function fail(code, message, details = null) { throw new DesktopSmokeError(code, message, details); }
function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_FRESH_VM_RECEIPT", `${label} must be an object`);
}
function exact(value, fields, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail("INVALID_FRESH_VM_RECEIPT", `${label} has an unsupported shape`);
}
function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("INVALID_FRESH_VM_REQUEST", `${label} is invalid`);
}
function operationId(runId, stage, scenarioId = null) {
  return ["op", runId, stage, scenarioId].filter(Boolean).join(":");
}
function errorCode(error) { return typeof error?.code === "string" && ID.test(error.code) ? error.code : "FRESH_VM_OPERATION_FAILED"; }
function sameIdentity(actual, candidate, stage) {
  exact(actual, ["version", "digest", "sourceRevision"], `${stage} identity`);
  if (["version", "digest", "sourceRevision"].some((field) => actual[field] !== candidate[field])) fail("CANDIDATE_IDENTITY_MISMATCH", `${stage} identity does not match the digest-verified candidate`);
}
function validateDeadlineOptions(deadlines) {
  exact(deadlines, Object.keys(FRESH_VM_DEADLINES_V1), "fresh VM deadlines");
  for (const [field, value] of Object.entries(deadlines)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > FRESH_VM_DEADLINES_V1.runMs) fail("INVALID_FRESH_VM_REQUEST", `${field} is invalid`);
  }
  if (deadlines.actionMs > deadlines.scenarioMs || deadlines.scenarioMs > deadlines.runMs) fail("INVALID_FRESH_VM_REQUEST", "action, scenario, and run deadlines are inconsistent");
  return Object.freeze({ ...deadlines });
}

async function bounded(operation, deadlineMs, stage) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new DesktopSmokeError("FRESH_VM_DEADLINE_EXCEEDED", `${stage} exceeded its deadline`, { stage })), deadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function invoke(adapter, method, payload, { deadlineMs, retries, stage }) {
  let attempt = 0;
  while (true) {
    try { return await bounded(() => adapter[method](structuredClone(payload)), deadlineMs, stage); }
    catch (error) {
      const safe = error?.details?.retryDisposition === "safe_before_dispatch";
      if (!safe || attempt >= retries) throw error;
      attempt += 1;
    }
  }
}

function validateClone(clone, runId) {
  exact(clone, ["cloneId", "templateRef", "accountId", "guestCodexHome", "runId", "fresh", "templateMaintained", "templateClean"], "clone receipt");
  for (const field of ["cloneId", "templateRef", "accountId"]) identifier(clone[field], `clone.${field}`);
  if (clone.runId !== runId || clone.fresh !== true || clone.templateMaintained !== true || clone.templateClean !== true || typeof clone.guestCodexHome !== "string" || !clone.guestCodexHome.startsWith("/")) fail("INVALID_CLONE_ISOLATION", "clone is not a fresh run-isolated copy of a maintained clean template");
  if (!clone.cloneId.includes(runId) || !clone.accountId.includes(runId) || !clone.guestCodexHome.includes(runId)) fail("INVALID_CLONE_ISOLATION", "clone, account, and guest CODEX_HOME must be unique to the run");
}

function validateScenarioReceipt(receipt, scenario) {
  exact(receipt, ["scenarioId", "operationId", "outcome", "failure", "assertionResults", "actionReceipts"], "scenario receipt");
  if (receipt.scenarioId !== scenario.scenarioId || !["passed", "failed", "timed_out", "crashed"].includes(receipt.outcome)) fail("INVALID_FRESH_VM_RECEIPT", "scenario outcome is invalid");
  if (!Array.isArray(receipt.assertionResults) || !Array.isArray(receipt.actionReceipts)) fail("INVALID_FRESH_VM_RECEIPT", "scenario result collections are invalid");
  const expectedAssertions = new Set(scenario.assertions.map(({ assertionId }) => assertionId));
  const assertionIds = new Set();
  for (const assertion of receipt.assertionResults) {
    exact(assertion, ["assertionId", "outcome", "code"], "scenario assertion receipt");
    if (!expectedAssertions.has(assertion.assertionId) || assertionIds.has(assertion.assertionId) || !["passed", "failed"].includes(assertion.outcome)) fail("INVALID_FRESH_VM_RECEIPT", "scenario assertion receipt is invalid");
    identifier(assertion.code, "scenario assertion code");
    assertionIds.add(assertion.assertionId);
  }
  const expectedActions = new Map(scenario.actions.map((action) => [action.actionId, action]));
  const seen = new Set();
  for (const action of receipt.actionReceipts) {
    exact(action, ["actionId", "outcome", "attempts", "submissionState"], "action receipt");
    if (!expectedActions.has(action.actionId) || seen.has(action.actionId) || !["completed", "failed", "timed_out", "skipped"].includes(action.outcome) || !Number.isSafeInteger(action.attempts) || action.attempts < 1 || action.attempts > 2 || !["not_applicable", "not_submitted", "submitted"].includes(action.submissionState)) fail("INVALID_FRESH_VM_RECEIPT", "action receipt is invalid or ambiguous");
    seen.add(action.actionId);
  }
  if (receipt.failure !== null) {
    exact(receipt.failure, ["code"], "scenario failure");
    identifier(receipt.failure.code, "scenario failure code");
  }
  return {
    scenarioId: receipt.scenarioId,
    outcome: receipt.outcome,
    failure: receipt.failure,
    assertionResults: structuredClone(receipt.assertionResults),
  };
}

function validatePackage(receipt, runId) {
  exact(receipt, ["runId", "bundle", "sanitized", "rawCapturesRemoved", "temporaryMaterialRemoved"], "package receipt");
  if (receipt.runId !== runId || receipt.sanitized !== true || receipt.rawCapturesRemoved !== true || receipt.temporaryMaterialRemoved !== true) fail("UNSAFE_FRESH_VM_EVIDENCE", "guest packaging did not prove sanitization and source removal");
  const bytes = Buffer.isBuffer(receipt.bundle) ? receipt.bundle : receipt.bundle instanceof Uint8Array ? Buffer.from(receipt.bundle) : fail("INVALID_FRESH_VM_RECEIPT", "guest package must be bundle bytes");
  if (bytes.byteLength > MAX_FRESH_VM_BUNDLE_BYTES_V1) fail("OVERSIZED_FRESH_VM_OUTPUT", "guest package exceeds the public adapter ceiling");
  return validateDesktopSmokeEvidenceBundleV1(bytes);
}

function diagnostic(error, stage) {
  return Object.freeze({ code: errorCode(error), stage });
}

export async function runFreshVmDesktopWorkflowsV1({
  runId, candidate, scenarioSet, adapter, controllerCodexHome,
  deadlines = FRESH_VM_DEADLINES_V1, retries = 1,
}) {
  identifier(runId, "runId");
  const immutableCandidate = await validateDesktopSmokeCandidateV1(candidate, { controllerCodexHome });
  const library = validateDesktopSmokeScenarioSetV1(structuredClone(scenarioSet));
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 2) fail("INVALID_FRESH_VM_REQUEST", "retries must be between zero and two");
  const limits = validateDeadlineOptions(deadlines);
  for (const method of METHODS) if (typeof adapter?.[method] !== "function") fail("INVALID_SMOKE_ADAPTER", `adapter is missing ${method}`);

  const started = Date.now();
  const remaining = (stage, ceiling) => {
    const available = limits.runMs - (Date.now() - started);
    if (available <= 0) fail("FRESH_VM_DEADLINE_EXCEEDED", "run exceeded its deadline", { stage });
    return Math.min(available, ceiling);
  };
  let clone = null;
  let primary = null;
  let primaryStage = "clone";
  let packaged = null;
  const scenarios = [];
  try {
    clone = await invoke(adapter, "cloneTemplate", {
      operationId: operationId(runId, "clone"), runId, candidate: immutableCandidate, scenarioSetId: library.scenarioSetId,
    }, { deadlineMs: remaining("clone", limits.installMs), retries, stage: "clone" });
    validateClone(clone, runId);
    primaryStage = "install";
    const installed = await invoke(adapter, "installCandidate", {
      operationId: operationId(runId, "install"), clone, candidate: immutableCandidate,
    }, { deadlineMs: remaining("install", limits.installMs), retries, stage: "install" });
    exact(installed, ["identity", "digestVerified", "exclusive"], "installation receipt");
    if (installed.digestVerified !== true || installed.exclusive !== true) fail("CANDIDATE_IDENTITY_MISMATCH", "installation did not prove the candidate digest and exclusive package set");
    sameIdentity(installed.identity, immutableCandidate, "installed");
    primaryStage = "identity";
    const loaded = await invoke(adapter, "readLoadedIdentity", {
      operationId: operationId(runId, "identity"), clone,
    }, { deadlineMs: remaining("identity", limits.identityMs), retries, stage: "identity" });
    sameIdentity(loaded, immutableCandidate, "loaded");

    for (const scenario of library.scenarios) {
      primaryStage = `scenario:${scenario.scenarioId}`;
      const scenarioDeadline = remaining(primaryStage, Math.min(scenario.deadlineMs, limits.scenarioMs));
      const receipt = await invoke(adapter, "executeScenario", {
        operationId: operationId(runId, "scenario", scenario.scenarioId), clone, scenario,
        deadlines: { scenarioMs: scenarioDeadline, actionMs: Math.min(limits.actionMs, scenarioDeadline) },
        maxActionAttempts: retries + 1,
      }, { deadlineMs: scenarioDeadline, retries: 0, stage: primaryStage });
      scenarios.push(validateScenarioReceipt(receipt, scenario));
    }
    primaryStage = "packaging";
    const packageReceipt = await invoke(adapter, "packageEvidence", {
      operationId: operationId(runId, "package"), clone, runId,
      scenarioIds: library.scenarios.map(({ scenarioId }) => scenarioId),
    }, { deadlineMs: remaining("packaging", limits.evidenceMs), retries, stage: "packaging" });
    packaged = validatePackage(packageReceipt, runId);
  } catch (error) { primary = error; }

  let destroyed = null; let absent = null; let destroyError = null; let absenceError = null;
  if (clone !== null) {
    try {
      destroyed = await invoke(adapter, "destroyClone", { operationId: operationId(runId, "destroy"), clone }, { deadlineMs: limits.destroyMs, retries, stage: "destruction" });
    } catch (error) { destroyError = error; }
    try {
      absent = await invoke(adapter, "verifyAbsent", { operationId: operationId(runId, "absence"), clone }, { deadlineMs: limits.absenceMs, retries, stage: "absence-verification" });
    } catch (error) { absenceError = error; }
    if (destroyError || absenceError || destroyed?.cloneId !== clone.cloneId || destroyed?.destroyed !== true || absent?.cloneId !== clone.cloneId || absent?.absent !== true || absent?.independent !== true) {
      throw new DesktopSmokeError("CLEANUP_NOT_PROVEN", "fresh VM cleanup and independent absence were not both proven", {
        primaryCode: primary ? errorCode(primary) : null, destroyCode: destroyError ? errorCode(destroyError) : null, absenceCode: absenceError ? errorCode(absenceError) : null,
      });
    }
  }
  const cleanup = clone === null ? null : { cloneId: clone.cloneId, destroyed: true, absent: true, independentlyVerified: true };
  if (primary) return Object.freeze({ schemaVersion: 1, runId, outcome: "failed", diagnostic: diagnostic(primary, primaryStage), scenarios, bundle: null, bundleDigest: null, candidate: immutableCandidate, templateRef: clone?.templateRef ?? null, cleanup });
  return Object.freeze({ schemaVersion: 1, runId, outcome: scenarios.every(({ outcome }) => outcome === "passed") ? "passed" : "failed", diagnostic: null, scenarios, bundle: Buffer.from(packaged.bytes), bundleDigest: packaged.manifest.bundleDigest, candidate: immutableCandidate, templateRef: clone.templateRef, cleanup });
}

export function createFreshVmPublicBundleV1(result) {
  exact(result, ["schemaVersion", "runId", "outcome", "diagnostic", "scenarios", "bundle", "bundleDigest", "candidate", "templateRef", "cleanup"], "fresh VM result");
  if (!result.bundle || !result.cleanup) fail("INVALID_FRESH_VM_RECEIPT", "only packaged, cleanup-proven results can produce a public bundle");
  const verified = validateDesktopSmokeEvidenceBundleV1(result.bundle);
  if (verified.manifest.bundleDigest !== result.bundleDigest) fail("EVIDENCE_DIGEST_MISMATCH", "result bundle identity is inconsistent");
  const evidencePath = "evidence/desktop-smoke-v1.json";
  const receipt = {
    schemaVersion: 1, runId: result.runId, outcome: result.outcome,
    candidate: { version: result.candidate.version, digest: result.candidate.digest, sourceRevision: result.candidate.sourceRevision },
    templateRef: result.templateRef, scenarioOutcomes: result.scenarios.map(({ scenarioId, outcome, failure }) => ({ scenarioId, outcome, failure })), cleanup: result.cleanup,
  };
  const receiptBytes = canonicalBytes(receipt);
  const entries = [
    { relativePath: evidencePath, digest: `sha256:${createHash("sha256").update(result.bundle).digest("hex")}`, byteLength: result.bundle.byteLength, encoding: "base64", data: result.bundle.toString("base64") },
    { relativePath: "receipts/run.json", digest: `sha256:${createHash("sha256").update(receiptBytes).digest("hex")}`, byteLength: receiptBytes.byteLength, encoding: "base64", data: receiptBytes.toString("base64") },
  ];
  const manifest = { schemaVersion: 1, format: "nelos-fresh-vm-e2e-v1", runId: result.runId, entries: entries.map(({ data, encoding, ...item }) => item) };
  const manifestBytes = canonicalBytes(manifest);
  const bytes = Buffer.from(canonicalBytes({ schemaVersion: 1, manifest, entries, manifestDigest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}` }));
  validateFreshVmPublicBundleV1(bytes);
  return bytes;
}

export function validateFreshVmPublicBundleV1(value) {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : fail("INVALID_FRESH_VM_BUNDLE", "public bundle must be bytes");
  let bundle;
  try { bundle = JSON.parse(bytes.toString("utf8")); } catch { fail("INVALID_FRESH_VM_BUNDLE", "public bundle is not canonical JSON"); }
  if (!canonicalBytes(bundle).equals(bytes)) fail("INVALID_FRESH_VM_BUNDLE", "public bundle is not canonical JSON");
  exact(bundle, ["schemaVersion", "manifest", "entries", "manifestDigest"], "public bundle");
  exact(bundle.manifest, ["schemaVersion", "format", "runId", "entries"], "public bundle manifest");
  if (bundle.schemaVersion !== 1 || bundle.manifest.schemaVersion !== 1 || bundle.manifest.format !== "nelos-fresh-vm-e2e-v1") fail("INVALID_FRESH_VM_BUNDLE", "public bundle format is unsupported");
  identifier(bundle.manifest.runId, "public bundle runId");
  if (!Array.isArray(bundle.entries) || !Array.isArray(bundle.manifest.entries) || bundle.entries.length !== 2 || bundle.manifest.entries.length !== 2) fail("INVALID_FRESH_VM_BUNDLE", "public bundle inventory is invalid");
  const expectedPaths = ["evidence/desktop-smoke-v1.json", "receipts/run.json"];
  for (const [index, entry] of bundle.entries.entries()) {
    exact(entry, ["relativePath", "digest", "byteLength", "encoding", "data"], "public bundle entry");
    exact(bundle.manifest.entries[index], ["relativePath", "digest", "byteLength"], "public bundle manifest entry");
    if (entry.relativePath !== expectedPaths[index] || entry.encoding !== "base64" || typeof entry.data !== "string") fail("INVALID_FRESH_VM_BUNDLE", "public bundle paths or encoding are invalid");
    const payload = Buffer.from(entry.data, "base64");
    const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    const inventory = bundle.manifest.entries[index];
    if (payload.byteLength !== entry.byteLength || digest !== entry.digest || inventory.relativePath !== entry.relativePath || inventory.digest !== entry.digest || inventory.byteLength !== entry.byteLength) fail("FRESH_VM_BUNDLE_DIGEST_MISMATCH", "public bundle entry does not match its manifest");
    if (index === 0) validateDesktopSmokeEvidenceBundleV1(payload);
    else {
      let receipt;
      try { receipt = JSON.parse(payload.toString("utf8")); } catch { fail("INVALID_FRESH_VM_BUNDLE", "run receipt is invalid"); }
      if (!canonicalBytes(receipt).equals(payload) || receipt.runId !== bundle.manifest.runId || receipt.cleanup?.destroyed !== true || receipt.cleanup?.absent !== true || receipt.cleanup?.independentlyVerified !== true) fail("INVALID_FRESH_VM_BUNDLE", "run receipt does not prove cleanup");
    }
  }
  const manifestDigest = `sha256:${createHash("sha256").update(canonicalBytes(bundle.manifest)).digest("hex")}`;
  if (bundle.manifestDigest !== manifestDigest) fail("FRESH_VM_BUNDLE_DIGEST_MISMATCH", "public bundle manifest digest is invalid");
  return Object.freeze({ manifest: structuredClone(bundle.manifest), bytes });
}
