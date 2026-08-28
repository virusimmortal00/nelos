import { createHash } from "node:crypto";

import { canonicalBytes } from "./experimentation-contract/index.mjs";

export const DESKTOP_CERTIFICATION_SCHEMA_VERSION = 1;
export const DESKTOP_CERTIFICATION_FORMAT_V1 = "nelos-desktop-certification-v1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export class DesktopCertificationContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DesktopCertificationContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DesktopCertificationContractError(code, message);
}

function closed(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CERTIFICATION_CONTRACT", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("UNEXPECTED_CERTIFICATION_FIELD", `${label} has an unsupported shape`);
  }
}

function string(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("INVALID_CERTIFICATION_IDENTITY", `${label} is invalid`);
  }
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("INCONSISTENT_CERTIFICATION_TOTALS", `${label} must be a non-negative integer`);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

export function validateDesktopCertificationScenarioV1(value) {
  closed(value, ["scenarioId", "outcome", "assertionTotals"], "scenario result");
  string(value.scenarioId, "scenarioId", ID);
  if (!["passed", "failed"].includes(value.outcome)) {
    fail("INVALID_CERTIFICATION_CONTRACT", "scenario outcome is invalid");
  }
  closed(value.assertionTotals, ["total", "passed", "failed"], "scenario assertion totals");
  for (const [field, amount] of Object.entries(value.assertionTotals)) count(amount, `scenario assertionTotals.${field}`);
  if (value.assertionTotals.total !== value.assertionTotals.passed + value.assertionTotals.failed) {
    fail("INCONSISTENT_CERTIFICATION_TOTALS", "scenario assertion totals do not balance");
  }
  if ((value.outcome === "passed") !== (value.assertionTotals.failed === 0)) {
    fail("INCONSISTENT_CERTIFICATION_TOTALS", "scenario outcome conflicts with its assertion totals");
  }
  return clone(value);
}

export function validateDesktopCertificationAssertionV1(value) {
  closed(value, ["assertionId", "scenarioId", "outcome", "code"], "assertion result");
  string(value.assertionId, "assertionId", ID);
  string(value.scenarioId, "assertion scenarioId", ID);
  string(value.code, "assertion code", ID);
  if (!["passed", "failed"].includes(value.outcome)) {
    fail("INVALID_CERTIFICATION_CONTRACT", "assertion outcome is invalid");
  }
  return clone(value);
}

function validateTotals(value, label) {
  closed(value, ["total", "passed", "failed"], label);
  for (const [field, amount] of Object.entries(value)) count(amount, `${label}.${field}`);
  if (value.total !== value.passed + value.failed) {
    fail("INCONSISTENT_CERTIFICATION_TOTALS", `${label} do not balance`);
  }
  return clone(value);
}

function validateCleanup(value) {
  closed(value, ["state", "destroyed", "absent", "independentlyVerified"], "cleanup");
  if (value.state !== "verified" || value.destroyed !== true || value.absent !== true || value.independentlyVerified !== true) {
    fail("CLEANUP_NOT_VERIFIED", "cleanup must be destroyed, absent, and independently verified");
  }
  return clone(value);
}

export function validateDesktopCertificationReceiptV1(value) {
  closed(value, [
    "schemaVersion", "format", "nelosCommitSha", "candidateDigest", "harnessCommitSha",
    "harnessVersion", "templateIdentity", "scenarioTotals", "assertionTotals", "scenarios",
    "assertions", "cleanup",
  ], "certification receipt");
  if (value.schemaVersion !== DESKTOP_CERTIFICATION_SCHEMA_VERSION || value.format !== DESKTOP_CERTIFICATION_FORMAT_V1) {
    fail("UNSUPPORTED_CERTIFICATION_VERSION", "certification receipt version is unsupported");
  }
  string(value.nelosCommitSha, "nelosCommitSha", COMMIT_SHA);
  string(value.candidateDigest, "candidateDigest", DIGEST);
  string(value.harnessCommitSha, "harnessCommitSha", COMMIT_SHA);
  string(value.harnessVersion, "harnessVersion", VERSION);
  string(value.templateIdentity, "templateIdentity", DIGEST);
  const scenarioTotals = validateTotals(value.scenarioTotals, "scenarioTotals");
  const assertionTotals = validateTotals(value.assertionTotals, "assertionTotals");
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0 || !Array.isArray(value.assertions)) {
    fail("INVALID_CERTIFICATION_CONTRACT", "certification scenarios and assertions are invalid");
  }
  const scenarios = value.scenarios.map(validateDesktopCertificationScenarioV1);
  const assertions = value.assertions.map(validateDesktopCertificationAssertionV1);
  if (new Set(scenarios.map(({ scenarioId }) => scenarioId)).size !== scenarios.length ||
      new Set(assertions.map(({ assertionId }) => assertionId)).size !== assertions.length) {
    fail("DUPLICATE_CERTIFICATION_ID", "scenario and assertion identities must be unique");
  }
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  for (const assertion of assertions) {
    if (!scenarioById.has(assertion.scenarioId)) {
      fail("INVALID_CERTIFICATION_RELATIONSHIP", `assertion ${assertion.assertionId} references an unknown scenario`);
    }
  }
  const actualScenarioTotals = {
    total: scenarios.length,
    passed: scenarios.filter(({ outcome }) => outcome === "passed").length,
    failed: scenarios.filter(({ outcome }) => outcome === "failed").length,
  };
  const actualAssertionTotals = {
    total: assertions.length,
    passed: assertions.filter(({ outcome }) => outcome === "passed").length,
    failed: assertions.filter(({ outcome }) => outcome === "failed").length,
  };
  if (Object.keys(actualScenarioTotals).some((field) => actualScenarioTotals[field] !== scenarioTotals[field]) ||
      Object.keys(actualAssertionTotals).some((field) => actualAssertionTotals[field] !== assertionTotals[field])) {
    fail("INCONSISTENT_CERTIFICATION_TOTALS", "receipt totals do not match its result collections");
  }
  for (const scenario of scenarios) {
    const scenarioAssertions = assertions.filter(({ scenarioId }) => scenarioId === scenario.scenarioId);
    const totals = {
      total: scenarioAssertions.length,
      passed: scenarioAssertions.filter(({ outcome }) => outcome === "passed").length,
      failed: scenarioAssertions.filter(({ outcome }) => outcome === "failed").length,
    };
    if (Object.keys(totals).some((field) => totals[field] !== scenario.assertionTotals[field])) {
      fail("INCONSISTENT_CERTIFICATION_TOTALS", `scenario ${scenario.scenarioId} totals do not match its assertions`);
    }
  }
  if (scenarioTotals.failed !== 0 || assertionTotals.failed !== 0) {
    fail("CERTIFICATION_FAILED", "a certification receipt may contain only passing results");
  }
  const cleanup = validateCleanup(value.cleanup);
  return Object.freeze({ ...clone(value), scenarioTotals, assertionTotals, scenarios, assertions, cleanup });
}

export function verifyDesktopCertificationReceiptV1({ receipt, expected } = {}) {
  closed(expected, ["nelosCommitSha", "candidateDigest", "harnessCommitSha", "harnessVersion", "templateIdentity"], "verification expectation");
  string(expected.nelosCommitSha, "expected nelosCommitSha", COMMIT_SHA);
  string(expected.candidateDigest, "expected candidateDigest", DIGEST);
  string(expected.harnessCommitSha, "expected harnessCommitSha", COMMIT_SHA);
  string(expected.harnessVersion, "expected harnessVersion", VERSION);
  string(expected.templateIdentity, "expected templateIdentity", DIGEST);
  const normalized = validateDesktopCertificationReceiptV1(receipt);
  for (const field of Object.keys(expected)) {
    if (normalized[field] !== expected[field]) {
      fail("CERTIFICATION_IDENTITY_MISMATCH", `${field} does not match the expected certification identity`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    outcome: "verified",
    receiptDigest: `sha256:${createHash("sha256").update(canonicalBytes(normalized)).digest("hex")}`,
  });
}
