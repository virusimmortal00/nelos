import { createHash } from "node:crypto";

import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
  validateCompatibilityRegistryV1,
  validateCompatibilityReportV1,
} from "./compatibility-contract-registry.mjs";

export const SEMANTIC_ADVISORY_REPORT_SCHEMA_VERSION = 1;
export const SEMANTIC_ADVISORY_POLICY_V1 = Object.freeze({
  maximumContracts: 4,
  maximumEvidenceItems: 8,
  maximumEvidenceBytes: 8_192,
  maximumTotalEvidenceBytes: 32_768,
  maximumFindings: 16,
  maximumFindingSummaryBytes: 1_000,
  minimumTimeoutMs: 1,
  maximumTimeoutMs: 60_000,
  evidenceFields: Object.freeze([
    "contractId",
    "checkId",
    "digest",
    "content",
  ]),
  providerResponseFields: Object.freeze(["schemaVersion", "findings"]),
  providerFindingFields: Object.freeze([
    "contractId",
    "evidenceRefs",
    "severity",
    "summary",
  ]),
});

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/u,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+\S+/iu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*\S+/iu,
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/u;
const SEVERITIES = new Set(["info", "warning"]);

export class SemanticAdvisoryInfrastructureError extends Error {
  constructor(message, { code = "infrastructure-failure", cause } = {}) {
    super(message, { cause });
    this.name = "SemanticAdvisoryInfrastructureError";
    this.code = code;
  }
}

function fail(message, code = "invalid-input") {
  throw new SemanticAdvisoryInfrastructureError(
    `semantic advisory: ${message}`,
    { code },
  );
}

function assertClosedObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) fail(`${label}.${field} is not allowed`);
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function assertString(value, label, { maximumBytes, pattern } = {}) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    (maximumBytes !== undefined && byteLength(value) > maximumBytes) ||
    (pattern && !pattern.test(value))
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function frozenDeterministicStatus(report) {
  return Object.freeze({
    schemaVersion: report.schemaVersion,
    registryVersion: report.registryVersion,
    overallStatus: report.overallStatus,
    capabilities: Object.freeze(
      report.capabilities.map(({ capabilityId, status }) =>
        Object.freeze({ capabilityId, status })),
    ),
  });
}

function infrastructureReport({
  deterministicStatus,
  invoked,
  code,
  summary,
  now,
}) {
  return Object.freeze({
    schemaVersion: SEMANTIC_ADVISORY_REPORT_SCHEMA_VERSION,
    section: "semantic-advisory",
    authority: "advisory-only",
    countsForCompatibility: false,
    invoked,
    status: "infrastructure-failure",
    observedAt: now(),
    deterministicStatus,
    provider: null,
    evidence: Object.freeze([]),
    findings: Object.freeze([]),
    infrastructure: Object.freeze({ code, summary }),
  });
}

function validateProviderConfiguration(configuration) {
  assertClosedObject(configuration, "providerConfiguration", [
    "providerId",
    "model",
    "credentialId",
    "timeoutMs",
  ]);
  assertString(configuration.providerId, "providerConfiguration.providerId", {
    maximumBytes: 100,
    pattern: ID_PATTERN,
  });
  assertString(configuration.model, "providerConfiguration.model", {
    maximumBytes: 200,
  });
  assertString(configuration.credentialId, "providerConfiguration.credentialId", {
    maximumBytes: 200,
    pattern: ID_PATTERN,
  });
  if (
    !Number.isInteger(configuration.timeoutMs) ||
    configuration.timeoutMs < SEMANTIC_ADVISORY_POLICY_V1.minimumTimeoutMs ||
    configuration.timeoutMs > SEMANTIC_ADVISORY_POLICY_V1.maximumTimeoutMs
  ) {
    fail(
      `providerConfiguration.timeoutMs must be an integer from ${SEMANTIC_ADVISORY_POLICY_V1.minimumTimeoutMs} through ${SEMANTIC_ADVISORY_POLICY_V1.maximumTimeoutMs}`,
    );
  }
}

function validateSelectedEvidence(registry, report, selectedEvidence) {
  if (!Array.isArray(selectedEvidence) || selectedEvidence.length === 0) {
    fail("selectedEvidence must be a non-empty array");
  }
  if (selectedEvidence.length > SEMANTIC_ADVISORY_POLICY_V1.maximumEvidenceItems) {
    fail(
      `selectedEvidence exceeds the ${SEMANTIC_ADVISORY_POLICY_V1.maximumEvidenceItems}-item limit`,
      "evidence-policy",
    );
  }
  const reportCapabilities = new Set(
    report.capabilities.map(({ capabilityId }) => capabilityId),
  );
  const registryCapabilities = new Map(
    registry.capabilities.map((capability) => [capability.id, capability]),
  );
  const registryChecks = new Map(
    registry.checks.map((check) => [check.id, check]),
  );
  const seen = new Set();
  const contracts = new Set();
  let totalBytes = 0;
  const packaged = selectedEvidence.map((item, index) => {
    const label = `selectedEvidence[${index}]`;
    assertClosedObject(
      item,
      label,
      SEMANTIC_ADVISORY_POLICY_V1.evidenceFields,
    );
    assertString(item.contractId, `${label}.contractId`, {
      maximumBytes: 200,
      pattern: ID_PATTERN,
    });
    assertString(item.checkId, `${label}.checkId`, {
      maximumBytes: 200,
      pattern: ID_PATTERN,
    });
    assertString(item.digest, `${label}.digest`, {
      maximumBytes: 71,
      pattern: DIGEST_PATTERN,
    });
    assertString(item.content, `${label}.content`, {
      maximumBytes: SEMANTIC_ADVISORY_POLICY_V1.maximumEvidenceBytes,
    });
    if (semanticAdvisoryEvidenceDigestV1(item.content) !== item.digest) {
      fail(`${label}.digest does not match its content`, "evidence-policy");
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(item.content))) {
      fail(`${label}.content appears to contain credentials`, "sensitive-content");
    }
    const capability = registryCapabilities.get(item.contractId);
    if (!capability || !reportCapabilities.has(item.contractId)) {
      fail(`${label}.contractId is not a selected compatibility contract`);
    }
    if (!capability.mappings.checks.includes(item.checkId)) {
      fail(`${label}.checkId is not mapped to ${item.contractId}`);
    }
    const check = registryChecks.get(item.checkId);
    if (check.evidenceKind === "semantic-advisory") {
      fail(`${label}.checkId cannot select semantic-advisory output as input`);
    }
    const identity = `${item.contractId}\0${item.checkId}`;
    if (seen.has(identity)) fail(`${label} duplicates selected contract evidence`);
    seen.add(identity);
    contracts.add(item.contractId);
    const contentBytes = byteLength(item.content);
    totalBytes += contentBytes;
    if (totalBytes > SEMANTIC_ADVISORY_POLICY_V1.maximumTotalEvidenceBytes) {
      fail(
        `selectedEvidence exceeds the ${SEMANTIC_ADVISORY_POLICY_V1.maximumTotalEvidenceBytes}-byte total limit`,
        "evidence-policy",
      );
    }
    return Object.freeze({
      contractId: item.contractId,
      checkId: item.checkId,
      evidenceKind: check.evidenceKind,
      source: check.source,
      digest: item.digest,
      content: item.content,
      contentBytes,
    });
  });
  if (contracts.size > SEMANTIC_ADVISORY_POLICY_V1.maximumContracts) {
    fail(
      `selectedEvidence exceeds the ${SEMANTIC_ADVISORY_POLICY_V1.maximumContracts}-contract limit`,
      "evidence-policy",
    );
  }
  return Object.freeze(packaged);
}

function createProviderRequest(registry, evidence) {
  const contracts = [...new Set(evidence.map(({ contractId }) => contractId))]
    .map((contractId) => {
      const capability = registry.capabilities.find(({ id }) => id === contractId);
      return Object.freeze({
        contractId,
        title: capability.title,
        evidence: Object.freeze(
          evidence
            .filter((item) => item.contractId === contractId)
            .map(({
              checkId,
              evidenceKind,
              source,
              digest,
              content,
            }) => Object.freeze({
              checkId,
              evidenceKind,
              source,
              digest,
              content,
            })),
        ),
      });
    });
  return Object.freeze({
    schemaVersion: 1,
    task: "semantic-advisory",
    constraints: Object.freeze({
      authority: "advisory-only",
      label: "semantic-advisory",
      liveMutations: false,
    }),
    contracts: Object.freeze(contracts),
  });
}

function validateProviderResponse(response, evidence) {
  assertClosedObject(
    response,
    "providerResponse",
    SEMANTIC_ADVISORY_POLICY_V1.providerResponseFields,
  );
  if (response.schemaVersion !== 1) fail("providerResponse.schemaVersion must be 1", "malformed-response");
  if (!Array.isArray(response.findings)) {
    fail("providerResponse.findings must be an array", "malformed-response");
  }
  if (response.findings.length > SEMANTIC_ADVISORY_POLICY_V1.maximumFindings) {
    fail(
      `providerResponse.findings exceeds the ${SEMANTIC_ADVISORY_POLICY_V1.maximumFindings}-finding limit`,
      "malformed-response",
    );
  }
  const selected = new Map();
  for (const item of evidence) {
    if (!selected.has(item.contractId)) selected.set(item.contractId, new Set());
    selected.get(item.contractId).add(item.checkId);
  }
  return Object.freeze(response.findings.map((finding, index) => {
    const label = `providerResponse.findings[${index}]`;
    assertClosedObject(
      finding,
      label,
      SEMANTIC_ADVISORY_POLICY_V1.providerFindingFields,
    );
    assertString(finding.contractId, `${label}.contractId`, {
      maximumBytes: 200,
      pattern: ID_PATTERN,
    });
    if (!selected.has(finding.contractId)) {
      fail(`${label}.contractId was not supplied`, "malformed-response");
    }
    if (!Array.isArray(finding.evidenceRefs) || finding.evidenceRefs.length === 0) {
      fail(`${label}.evidenceRefs must be a non-empty array`, "malformed-response");
    }
    const uniqueRefs = new Set();
    for (const [refIndex, checkId] of finding.evidenceRefs.entries()) {
      assertString(checkId, `${label}.evidenceRefs[${refIndex}]`, {
        maximumBytes: 200,
        pattern: ID_PATTERN,
      });
      if (!selected.get(finding.contractId).has(checkId)) {
        fail(`${label}.evidenceRefs[${refIndex}] was not supplied`, "malformed-response");
      }
      if (uniqueRefs.has(checkId)) {
        fail(`${label}.evidenceRefs contains a duplicate`, "malformed-response");
      }
      uniqueRefs.add(checkId);
    }
    if (!SEVERITIES.has(finding.severity)) {
      fail(`${label}.severity must be info or warning`, "malformed-response");
    }
    assertString(finding.summary, `${label}.summary`, {
      maximumBytes: SEMANTIC_ADVISORY_POLICY_V1.maximumFindingSummaryBytes,
    });
    if (SECRET_PATTERNS.some((pattern) => pattern.test(finding.summary))) {
      fail(`${label}.summary appears to contain credentials`, "malformed-response");
    }
    return Object.freeze({
      label: "semantic-advisory",
      authority: "advisory-only",
      countsForCompatibility: false,
      contractId: finding.contractId,
      evidenceRefs: Object.freeze([...finding.evidenceRefs]),
      severity: finding.severity,
      summary: finding.summary,
    });
  }));
}

async function callProvider(provider, request, configuration) {
  if (!provider || typeof provider.compare !== "function") {
    fail("provider.compare must be an injected function", "missing-provider");
  }
  const controller = new AbortController();
  let timeout;
  try {
    const providerPromise = Promise.resolve().then(() =>
      provider.compare(request, Object.freeze({
        providerId: configuration.providerId,
        model: configuration.model,
        credentialId: configuration.credentialId,
        signal: controller.signal,
      })));
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new SemanticAdvisoryInfrastructureError(
          `semantic advisory: provider timed out after ${configuration.timeoutMs}ms`,
          { code: "timeout" },
        ));
      }, configuration.timeoutMs);
    });
    return await Promise.race([providerPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof SemanticAdvisoryInfrastructureError) throw error;
    throw new SemanticAdvisoryInfrastructureError(
      "semantic advisory: configured provider failed",
      { code: "provider-failure", cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Explicit, read-only semantic comparison over already-selected evidence.
 *
 * This function performs no filesystem reads, source collection, environment
 * lookup, model selection, or mutation. Its closed schemas and exported policy
 * are the complete field, count, and byte allowlists applied before provider
 * invocation. The provider is always injected by the explicit caller.
 */
export async function runSemanticAdvisoryV1({
  optIn = false,
  provider,
  providerConfiguration,
  deterministicReport,
  selectedEvidence,
  registry = COMPATIBILITY_CONTRACT_REGISTRY_V1,
  now = () => new Date().toISOString(),
} = {}) {
  let deterministicStatus = null;
  try {
    validateCompatibilityRegistryV1(registry);
    validateCompatibilityReportV1(registry, deterministicReport);
    deterministicStatus = frozenDeterministicStatus(deterministicReport);
  } catch (error) {
    return infrastructureReport({
      deterministicStatus,
      invoked: false,
      code: "invalid-deterministic-report",
      summary: error.message,
      now,
    });
  }
  if (optIn !== true) {
    return infrastructureReport({
      deterministicStatus,
      invoked: false,
      code: "explicit-opt-in-required",
      summary: "No provider was called because semantic advisory requires explicit opt-in.",
      now,
    });
  }
  try {
    validateProviderConfiguration(providerConfiguration);
    const evidence = validateSelectedEvidence(
      registry,
      deterministicReport,
      selectedEvidence,
    );
    const request = createProviderRequest(registry, evidence);
    const response = await callProvider(provider, request, providerConfiguration);
    let findings;
    try {
      findings = validateProviderResponse(response, evidence);
    } catch (error) {
      throw new SemanticAdvisoryInfrastructureError(
        "semantic advisory: provider returned a malformed response",
        { code: "malformed-response", cause: error },
      );
    }
    return Object.freeze({
      schemaVersion: SEMANTIC_ADVISORY_REPORT_SCHEMA_VERSION,
      section: "semantic-advisory",
      authority: "advisory-only",
      countsForCompatibility: false,
      invoked: true,
      status: "completed",
      observedAt: now(),
      deterministicStatus,
      provider: Object.freeze({
        providerId: providerConfiguration.providerId,
        model: providerConfiguration.model,
      }),
      evidence: Object.freeze(evidence.map((item) => Object.freeze({
        contractId: item.contractId,
        checkId: item.checkId,
        evidenceKind: item.evidenceKind,
        source: item.source,
        digest: item.digest,
        contentBytes: item.contentBytes,
      }))),
      findings,
      infrastructure: null,
    });
  } catch (error) {
    const infrastructureError = error instanceof SemanticAdvisoryInfrastructureError
      ? error
      : new SemanticAdvisoryInfrastructureError(error.message, { cause: error });
    return infrastructureReport({
      deterministicStatus,
      invoked: infrastructureError.code !== "missing-provider" &&
        infrastructureError.code !== "invalid-input" &&
        infrastructureError.code !== "evidence-policy" &&
        infrastructureError.code !== "sensitive-content",
      code: infrastructureError.code,
      summary: infrastructureError.message,
      now,
    });
  }
}

export function semanticAdvisoryEvidenceDigestV1(content) {
  assertString(content, "content", {
    maximumBytes: SEMANTIC_ADVISORY_POLICY_V1.maximumEvidenceBytes,
  });
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
