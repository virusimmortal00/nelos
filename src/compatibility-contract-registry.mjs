export const COMPATIBILITY_CONTRACT_REGISTRY_SCHEMA_VERSION = 1;
export const COMPATIBILITY_REPORT_SCHEMA_VERSION = 1;
export const UPSTREAM_SOURCE_OBSERVATION_SCHEMA_VERSION = 1;

export const COMPATIBILITY_EVIDENCE_KINDS = Object.freeze([
  "deterministic-repo",
  "upstream-docs",
  "upstream-open-source",
  "generated-schema",
  "runtime-transport",
  "runtime-live",
  "semantic-advisory",
]);

export const COMPATIBILITY_EVIDENCE_OUTCOMES = Object.freeze([
  "passed",
  "failed",
  "unavailable",
  "infrastructure-failure",
]);

const EVIDENCE_KIND_SET = new Set(COMPATIBILITY_EVIDENCE_KINDS);
const EVIDENCE_OUTCOME_SET = new Set(COMPATIBILITY_EVIDENCE_OUTCOMES);
const ID_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/u;
const RELEASE_ID_PATTERN = /^codex@[0-9]+\.[0-9]+\.[0-9]+$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const REPOSITORY_PATH_KEYS = Object.freeze([
  "owned",
  "shared",
  "test",
  "documentation",
  "generatedSchema",
]);
const MAPPING_KEYS = Object.freeze([
  ...REPOSITORY_PATH_KEYS,
  "upstreamDocumentation",
  "upstreamSource",
  "runtime",
  "checks",
]);
const BROAD_PATH_SCOPES = new Set([
  ".",
  "./",
  "*",
  "**",
  "**/*",
  "src",
  "src/**",
  "test",
  "test/**",
  "docs",
  "docs/**",
  "scripts",
  "scripts/**",
]);

function fail(message) {
  throw new Error(`compatibility contract registry: ${message}`);
}

function assertClosedObject(value, label, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${label}.${key} is not allowed`);
  }
}

function assertString(value, label, { pattern, maximum = 2_000 } = {}) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0") ||
    (pattern && !pattern.test(value))
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function assertUniqueStrings(value, label, validator = undefined) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    assertString(item, `${label}[${index}]`);
    if (seen.has(item)) fail(`${label} contains duplicate value ${item}`);
    seen.add(item);
    validator?.(item, `${label}[${index}]`);
  }
  return value;
}

function normalizeRepositoryPath(path, label, { upstream = false } = {}) {
  assertString(path, label, { maximum: 1_000 });
  if (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    path.includes("//") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    /(^|\/)\*(?!\*$)/u.test(path) ||
    (path.includes("**") && !path.endsWith("/**"))
  ) {
    fail(`${label} must be a normalized repository-relative path or /** scope`);
  }
  if (upstream && (BROAD_PATH_SCOPES.has(path) || path.endsWith("/**"))) {
    fail(`${label} is too broad for upstream-source evidence`);
  }
  return path;
}

function assertUrl(value, label, { repository = false } = {}) {
  assertString(value, label, { maximum: 2_000 });
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    value.includes("*")
  ) {
    fail(`${label} must be a bounded absolute HTTPS URL`);
  }
  if (repository && !/^(?:www\.)?github\.com$/iu.test(url.hostname)) {
    fail(`${label} must identify an upstream source repository`);
  }
  return value;
}

function assertSourceForEvidenceKind(source, kind, label) {
  if (kind === "upstream-docs") return assertUrl(source, label);
  if (kind === "upstream-open-source") {
    const separator = source.indexOf("#");
    if (separator < 1) fail(`${label} must be repository-url#path`);
    assertUrl(source.slice(0, separator), label, { repository: true });
    return normalizeRepositoryPath(source.slice(separator + 1), label, {
      upstream: true,
    });
  }
  if (
    kind === "deterministic-repo" ||
    kind === "generated-schema"
  ) {
    return normalizeRepositoryPath(source, label);
  }
  return assertString(source, label, { maximum: 2_000 });
}

function validateUpstreamSource(value, label) {
  assertClosedObject(value, label, [
    "repository",
    "paths",
    "artifacts",
    "advisoryRef",
  ]);
  assertUrl(value.repository, `${label}.repository`, { repository: true });
  assertUniqueStrings(
    value.paths,
    `${label}.paths`,
    (path, pathLabel) => normalizeRepositoryPath(path, pathLabel, {
      upstream: true,
    }),
  );
  assertUniqueStrings(
    value.artifacts,
    `${label}.artifacts`,
    (artifact, artifactLabel) => {
      normalizeRepositoryPath(artifact, artifactLabel, { upstream: true });
      if (artifact.includes("*")) {
        fail(`${artifactLabel} must name a bounded generated artifact`);
      }
    },
  );
  if (value.paths.length + value.artifacts.length === 0) {
    fail(`${label} must declare at least one relevant path or artifact`);
  }
  if (value.advisoryRef !== undefined) {
    assertString(value.advisoryRef, `${label}.advisoryRef`, {
      pattern: /^refs\/heads\/[A-Za-z0-9._/-]+$/u,
      maximum: 1_000,
    });
  }
}

function validateRegistryShape(registry) {
  assertClosedObject(registry, "registry", [
    "schemaVersion",
    "registryVersion",
    "supportedCodexReleases",
    "checks",
    "capabilities",
  ]);
  if (registry.schemaVersion !== COMPATIBILITY_CONTRACT_REGISTRY_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${COMPATIBILITY_CONTRACT_REGISTRY_SCHEMA_VERSION}`);
  }
  assertString(registry.registryVersion, "registry.registryVersion", {
    pattern: VERSION_PATTERN,
  });
  if (!Array.isArray(registry.supportedCodexReleases)) {
    fail("registry.supportedCodexReleases must be an array");
  }
  if (!Array.isArray(registry.checks)) fail("registry.checks must be an array");
  if (!Array.isArray(registry.capabilities) || registry.capabilities.length === 0) {
    fail("registry.capabilities must be a non-empty array");
  }
}

export function validateCompatibilityRegistryV1(registry) {
  validateRegistryShape(registry);
  const releaseIds = new Set();
  for (const [index, release] of registry.supportedCodexReleases.entries()) {
    const label = `registry.supportedCodexReleases[${index}]`;
    assertClosedObject(release, label, [
      "id",
      "version",
      "fixture",
      "upstreamSourceRefs",
    ]);
    assertString(release.id, `${label}.id`, { pattern: RELEASE_ID_PATTERN });
    assertString(release.version, `${label}.version`, {
      pattern: VERSION_PATTERN,
    });
    if (release.id !== `codex@${release.version}`) {
      fail(`${label}.id must resolve to its exact version`);
    }
    normalizeRepositoryPath(release.fixture, `${label}.fixture`);
    if (!Array.isArray(release.upstreamSourceRefs)) {
      fail(`${label}.upstreamSourceRefs must be an array`);
    }
    const sourceRepositories = new Set();
    release.upstreamSourceRefs.forEach((source, sourceIndex) => {
      const sourceLabel = `${label}.upstreamSourceRefs[${sourceIndex}]`;
      assertClosedObject(source, sourceLabel, [
        "repository",
        "requestedRef",
        "commitSha",
      ]);
      assertUrl(source.repository, `${sourceLabel}.repository`, {
        repository: true,
      });
      assertString(source.requestedRef, `${sourceLabel}.requestedRef`, {
        pattern: /^(?:refs\/tags\/[A-Za-z0-9._/-]+|[a-f0-9]{40})$/u,
        maximum: 1_000,
      });
      if (
        source.requestedRef.includes("//") ||
        source.requestedRef.split("/").includes("..")
      ) {
        fail(`${sourceLabel}.requestedRef is invalid`);
      }
      assertString(source.commitSha, `${sourceLabel}.commitSha`, {
        pattern: /^[a-f0-9]{40}$/u,
        maximum: 40,
      });
      if (
        /^[a-f0-9]{40}$/u.test(source.requestedRef) &&
        source.requestedRef !== source.commitSha
      ) {
        fail(`${sourceLabel}.requestedRef commit must match commitSha`);
      }
      if (sourceRepositories.has(source.repository)) {
        fail(`${sourceLabel}.repository is duplicated`);
      }
      sourceRepositories.add(source.repository);
    });
    if (releaseIds.has(release.id)) fail(`duplicate release ID ${release.id}`);
    releaseIds.add(release.id);
  }

  const checks = new Map();
  for (const [index, check] of registry.checks.entries()) {
    const label = `registry.checks[${index}]`;
    assertClosedObject(check, label, [
      "id",
      "evidenceKind",
      "command",
      "source",
    ]);
    assertString(check.id, `${label}.id`, { pattern: ID_PATTERN });
    if (checks.has(check.id)) fail(`duplicate check ID ${check.id}`);
    if (!EVIDENCE_KIND_SET.has(check.evidenceKind)) {
      fail(`${label}.evidenceKind is unknown`);
    }
    assertString(check.command, `${label}.command`, { maximum: 4_000 });
    assertSourceForEvidenceKind(check.source, check.evidenceKind, `${label}.source`);
    checks.set(check.id, check);
  }

  const capabilities = new Map();
  for (const [index, capability] of registry.capabilities.entries()) {
    const label = `registry.capabilities[${index}]`;
    assertClosedObject(capability, label, [
      "id",
      "title",
      "dependsOn",
      "globalInvariant",
      "supportedCodexReleases",
      "mappings",
    ]);
    assertString(capability.id, `${label}.id`, { pattern: ID_PATTERN });
    if (capabilities.has(capability.id)) {
      fail(`duplicate capability ID ${capability.id}`);
    }
    assertString(capability.title, `${label}.title`, { maximum: 200 });
    assertUniqueStrings(capability.dependsOn, `${label}.dependsOn`);
    if (typeof capability.globalInvariant !== "boolean") {
      fail(`${label}.globalInvariant must be boolean`);
    }
    assertUniqueStrings(
      capability.supportedCodexReleases,
      `${label}.supportedCodexReleases`,
      (releaseId, releaseLabel) => {
        if (!releaseIds.has(releaseId)) {
          fail(`${releaseLabel} is an unresolved supported Codex release`);
        }
      },
    );
    assertClosedObject(capability.mappings, `${label}.mappings`, MAPPING_KEYS);
    for (const key of MAPPING_KEYS) {
      if (!Object.hasOwn(capability.mappings, key)) {
        fail(`${label}.mappings.${key} must be declared (use [] when inapplicable)`);
      }
    }
    for (const key of REPOSITORY_PATH_KEYS) {
      assertUniqueStrings(
        capability.mappings[key],
        `${label}.mappings.${key}`,
        (path, pathLabel) => normalizeRepositoryPath(path, pathLabel),
      );
    }
    assertUniqueStrings(
      capability.mappings.upstreamDocumentation,
      `${label}.mappings.upstreamDocumentation`,
      (url, urlLabel) => assertUrl(url, urlLabel),
    );
    if (!Array.isArray(capability.mappings.upstreamSource)) {
      fail(`${label}.mappings.upstreamSource must be an array`);
    }
    capability.mappings.upstreamSource.forEach((source, sourceIndex) => {
      validateUpstreamSource(
        source,
        `${label}.mappings.upstreamSource[${sourceIndex}]`,
      );
    });
    assertUniqueStrings(
      capability.mappings.runtime,
      `${label}.mappings.runtime`,
      (runtime, runtimeLabel) => {
        if (!ID_PATTERN.test(runtime)) fail(`${runtimeLabel} is invalid`);
      },
    );
    assertUniqueStrings(
      capability.mappings.checks,
      `${label}.mappings.checks`,
      (checkId, checkLabel) => {
        if (!checks.has(checkId)) fail(`${checkLabel} references unknown check ${checkId}`);
      },
    );
    if (capability.mappings.checks.length === 0) {
      fail(`${label} must map at least one compatibility check`);
    }
    capabilities.set(capability.id, capability);
  }
  for (const capability of capabilities.values()) {
    for (const dependencyId of capability.dependsOn) {
      if (!capabilities.has(dependencyId)) {
        fail(`${capability.id} depends on unknown capability ${dependencyId}`);
      }
      if (dependencyId === capability.id) {
        fail(`${capability.id} cannot depend on itself`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(capabilityId) {
    if (visiting.has(capabilityId)) {
      fail(`dependency cycle includes ${capabilityId}`);
    }
    if (visited.has(capabilityId)) return;
    visiting.add(capabilityId);
    for (const dependencyId of capabilities.get(capabilityId).dependsOn) {
      visit(dependencyId);
    }
    visiting.delete(capabilityId);
    visited.add(capabilityId);
  }
  for (const capabilityId of capabilities.keys()) visit(capabilityId);
  return registry;
}

function matchesPath(scope, changedPath) {
  return scope.endsWith("/**")
    ? changedPath === scope.slice(0, -3) ||
      changedPath.startsWith(scope.slice(0, -2))
    : scope === changedPath;
}

function changedPathMappings(capability) {
  return REPOSITORY_PATH_KEYS.flatMap((key) => capability.mappings[key]);
}

function normalizeChange(change, index) {
  if (typeof change === "string") {
    return {
      status: "modified",
      paths: [normalizeRepositoryPath(change, `changes[${index}]`)],
    };
  }
  assertClosedObject(change, `changes[${index}]`, [
    "status",
    "path",
    "oldPath",
    "newPath",
  ]);
  if (!["modified", "added", "deleted", "renamed"].includes(change.status)) {
    fail(`changes[${index}].status is invalid`);
  }
  if (change.status === "renamed") {
    return {
      status: change.status,
      paths: [
        normalizeRepositoryPath(change.oldPath, `changes[${index}].oldPath`),
        normalizeRepositoryPath(change.newPath, `changes[${index}].newPath`),
      ],
    };
  }
  if (change.oldPath !== undefined || change.newPath !== undefined) {
    fail(`changes[${index}] uses oldPath/newPath only for renamed changes`);
  }
  return {
    status: change.status,
    paths: [normalizeRepositoryPath(change.path, `changes[${index}].path`)],
  };
}

function isCompatibilitySensitive(path) {
  if (path.startsWith("docs/assets/")) return false;
  return /^(?:src|bin|scripts|test|docs)\//u.test(path) ||
    [
      "package.json",
      "package-lock.json",
      "distribution-provenance.json",
      ".mcp.json",
      ".codex-plugin/plugin.json",
    ].includes(path);
}

export function traverseCompatibilityDependentsV1(registry, capabilityIds) {
  validateCompatibilityRegistryV1(registry);
  const capabilities = new Map(
    registry.capabilities.map((capability) => [capability.id, capability]),
  );
  const selected = new Set();
  for (const capabilityId of capabilityIds) {
    if (!capabilities.has(capabilityId)) {
      fail(`cannot traverse unknown capability ${capabilityId}`);
    }
    selected.add(capabilityId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const capability of capabilities.values()) {
      if (
        !selected.has(capability.id) &&
        capability.dependsOn.some((dependencyId) => selected.has(dependencyId))
      ) {
        selected.add(capability.id);
        changed = true;
      }
    }
  }
  return registry.capabilities
    .map(({ id }) => id)
    .filter((id) => selected.has(id));
}

export function selectImpactedCompatibilityContractsV1(registry, changes) {
  validateCompatibilityRegistryV1(registry);
  if (!Array.isArray(changes)) fail("changes must be an array");
  const normalized = changes.map(normalizeChange);
  const direct = new Set(
    registry.capabilities
      .filter(({ globalInvariant }) => globalInvariant)
      .map(({ id }) => id),
  );
  const pathSelections = [];
  const unmappedSensitivePaths = [];
  for (const change of normalized) {
    for (const path of change.paths) {
      const mapped = registry.capabilities
        .filter((capability) =>
          changedPathMappings(capability).some((scope) => matchesPath(scope, path)))
        .map(({ id }) => id);
      mapped.forEach((id) => direct.add(id));
      pathSelections.push(Object.freeze({ path, capabilityIds: mapped }));
      if (mapped.length === 0 && isCompatibilitySensitive(path)) {
        unmappedSensitivePaths.push(path);
      }
    }
  }
  const selectedCapabilityIds = traverseCompatibilityDependentsV1(
    registry,
    direct,
  );
  const uniqueUnmapped = [...new Set(unmappedSensitivePaths)].sort();
  return Object.freeze({
    schemaVersion: COMPATIBILITY_CONTRACT_REGISTRY_SCHEMA_VERSION,
    ok: uniqueUnmapped.length === 0,
    selectedCapabilityIds,
    directCapabilityIds: registry.capabilities
      .map(({ id }) => id)
      .filter((id) => direct.has(id)),
    pathSelections: Object.freeze(pathSelections),
    unmappedSensitivePaths: Object.freeze(uniqueUnmapped),
    action:
      uniqueUnmapped.length === 0
        ? null
        : "Add each compatibility-sensitive path to a capability mapping, or explicitly exclude it outside this selector before compatibility checks run.",
  });
}

function evidenceCounts(outcome) {
  return outcome === "passed";
}

function validateUpstreamDocumentationReportMetadata(value, label, evidence) {
  assertClosedObject(value, label, [
    "requestedUrl",
    "selected",
    "digest",
    "observedAt",
    "status",
    "evidenceKind",
    "failureKind",
  ]);
  assertUrl(value.requestedUrl, `${label}.requestedUrl`);
  if (value.requestedUrl !== evidence.source) {
    fail(`${label}.requestedUrl must match the evidence source`);
  }
  assertClosedObject(value.selected, `${label}.selected`, ["kind", "name"]);
  if (!["artifact", "section"].includes(value.selected.kind)) {
    fail(`${label}.selected.kind is invalid`);
  }
  assertString(value.selected.name, `${label}.selected.name`, { maximum: 200 });
  if (
    value.digest !== null &&
    (typeof value.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.digest))
  ) {
    fail(`${label}.digest must be null or a SHA-256 digest`);
  }
  assertString(value.observedAt, `${label}.observedAt`, { maximum: 100 });
  if (!Number.isFinite(Date.parse(value.observedAt))) {
    fail(`${label}.observedAt must be an observation time`);
  }
  if (!["available", "unavailable"].includes(value.status)) {
    fail(`${label}.status is invalid`);
  }
  if (value.evidenceKind !== "upstream-docs") {
    fail(`${label}.evidenceKind must be upstream-docs`);
  }
  if (
    value.failureKind !== null &&
    !["network", "parsing", "missing-section", "redirect-policy", "timeout"]
      .includes(value.failureKind)
  ) {
    fail(`${label}.failureKind is invalid`);
  }
  if (
    (value.status === "available" &&
      (value.digest === null || value.failureKind !== null || evidence.outcome !== "passed")) ||
    (value.status === "unavailable" &&
      (value.digest !== null ||
        value.failureKind === null ||
        !["unavailable", "infrastructure-failure"].includes(evidence.outcome)))
  ) {
    fail(`${label} does not agree with the evidence outcome`);
  }
}

export function validateCompatibilityReportV1(
  registry,
  report,
  { selectedCapabilityIds = undefined } = {},
) {
  validateCompatibilityRegistryV1(registry);
  assertClosedObject(report, "report", [
    "schemaVersion",
    "registryVersion",
    "overallStatus",
    "capabilities",
  ]);
  if (report.schemaVersion !== COMPATIBILITY_REPORT_SCHEMA_VERSION) {
    fail(`report.schemaVersion must be ${COMPATIBILITY_REPORT_SCHEMA_VERSION}`);
  }
  if (report.registryVersion !== registry.registryVersion) {
    fail("report.registryVersion does not match the validated registry");
  }
  if (!["compatible", "incompatible", "unverified"].includes(report.overallStatus)) {
    fail("report.overallStatus is invalid");
  }
  if (!Array.isArray(report.capabilities)) {
    fail("report.capabilities must be an array");
  }
  const capabilities = new Map(
    registry.capabilities.map((capability) => [capability.id, capability]),
  );
  const expected = new Set(
    selectedCapabilityIds ??
      report.capabilities.map(({ capabilityId }) => capabilityId),
  );
  for (const capabilityId of expected) {
    if (!capabilities.has(capabilityId)) {
      fail(`report selection contains unknown capability ${capabilityId}`);
    }
  }
  const reported = new Set();
  const derivedStatuses = [];
  for (const [index, result] of report.capabilities.entries()) {
    const label = `report.capabilities[${index}]`;
    assertClosedObject(result, label, [
      "capabilityId",
      "status",
      "evidence",
    ]);
    if (!capabilities.has(result.capabilityId)) {
      fail(`${label}.capabilityId is unknown`);
    }
    if (!expected.has(result.capabilityId)) {
      fail(`${label}.capabilityId was not selected`);
    }
    if (reported.has(result.capabilityId)) {
      fail(`duplicate report capability ${result.capabilityId}`);
    }
    reported.add(result.capabilityId);
    if (!["compatible", "incompatible", "unverified"].includes(result.status)) {
      fail(`${label}.status is invalid`);
    }
    if (!Array.isArray(result.evidence)) fail(`${label}.evidence must be an array`);
    const capability = capabilities.get(result.capabilityId);
    const checkIds = new Set(capability.mappings.checks);
    const observedChecks = new Set();
    let failed = false;
    let nonEvidence = false;
    for (const [evidenceIndex, evidence] of result.evidence.entries()) {
      const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
      assertClosedObject(evidence, evidenceLabel, [
        "checkId",
        "kind",
        "outcome",
        "countsForCompatibility",
        "source",
        "summary",
        "upstreamDocumentation",
      ]);
      if (!checkIds.has(evidence.checkId)) {
        fail(`${evidenceLabel}.checkId is not mapped to ${result.capabilityId}`);
      }
      if (observedChecks.has(evidence.checkId)) {
        fail(`${evidenceLabel}.checkId is duplicated`);
      }
      observedChecks.add(evidence.checkId);
      const check = registry.checks.find(({ id }) => id === evidence.checkId);
      if (!EVIDENCE_KIND_SET.has(evidence.kind) || check.evidenceKind !== evidence.kind) {
        fail(`${evidenceLabel}.kind does not match its check mapping`);
      }
      if (!EVIDENCE_OUTCOME_SET.has(evidence.outcome)) {
        fail(`${evidenceLabel}.outcome is invalid`);
      }
      if (
        typeof evidence.countsForCompatibility !== "boolean" ||
        evidence.countsForCompatibility !== evidenceCounts(evidence.outcome)
      ) {
        fail(
          `${evidenceLabel}.countsForCompatibility must be true only for passed evidence`,
        );
      }
      assertSourceForEvidenceKind(
        evidence.source,
        evidence.kind,
        `${evidenceLabel}.source`,
      );
      assertString(evidence.summary, `${evidenceLabel}.summary`, {
        maximum: 2_000,
      });
      if (evidence.upstreamDocumentation !== undefined) {
        if (evidence.kind !== "upstream-docs") {
          fail(`${evidenceLabel}.upstreamDocumentation is only valid for upstream-docs`);
        }
        validateUpstreamDocumentationReportMetadata(
          evidence.upstreamDocumentation,
          `${evidenceLabel}.upstreamDocumentation`,
          evidence,
        );
      }
      failed ||= evidence.outcome === "failed";
      nonEvidence ||= [
        "unavailable",
        "infrastructure-failure",
      ].includes(evidence.outcome);
    }
    const complete = [...checkIds].every((checkId) => {
      const evidence = result.evidence.find((item) => item.checkId === checkId);
      return evidence?.outcome === "passed";
    });
    const derivedStatus = failed
      ? "incompatible"
      : complete && !nonEvidence
        ? "compatible"
        : "unverified";
    if (result.status !== derivedStatus) {
      fail(`${label}.status must be ${derivedStatus} for its evidence outcomes`);
    }
    derivedStatuses.push(derivedStatus);
  }
  const missing = [...expected].filter((capabilityId) => !reported.has(capabilityId));
  if (missing.length > 0) {
    fail(`report is missing selected capabilities: ${missing.join(", ")}`);
  }
  const derivedOverall = derivedStatuses.includes("incompatible")
    ? "incompatible"
    : derivedStatuses.length > 0 &&
        derivedStatuses.every((status) => status === "compatible")
      ? "compatible"
      : "unverified";
  if (report.overallStatus !== derivedOverall) {
    fail(`report.overallStatus must be ${derivedOverall}`);
  }
  return report;
}

export const COMPATIBILITY_CONTRACT_REGISTRY_V1 = Object.freeze({
  schemaVersion: 1,
  registryVersion: "1.0.0",
  supportedCodexReleases: Object.freeze([
    Object.freeze({
      id: "codex@0.144.5",
      version: "0.144.5",
      fixture: "test/fixtures/mcp-app-server-protocol-v0.144.x.json",
      upstreamSourceRefs: Object.freeze([
        Object.freeze({
          repository: "https://github.com/openai/codex",
          requestedRef: "refs/tags/rust-v0.144.5",
          commitSha: "87db9bc18ba5bc82c1cb4e4381b44f693ee35623",
        }),
      ]),
    }),
    Object.freeze({
      id: "codex@0.144.6",
      version: "0.144.6",
      fixture: "test/fixtures/mcp-app-server-protocol-v0.144.x.json",
      upstreamSourceRefs: Object.freeze([
        Object.freeze({
          repository: "https://github.com/openai/codex",
          requestedRef: "refs/tags/rust-v0.144.6",
          commitSha: "5d1fbf26c43abc65a203928b2e31561cb039e06d",
        }),
      ]),
    }),
  ]),
  checks: Object.freeze([
    Object.freeze({
      id: "repo.registry-integrity",
      evidenceKind: "deterministic-repo",
      command: "validate the checked-in compatibility registry",
      source: "src/compatibility-contract-registry.mjs",
    }),
    Object.freeze({
      id: "repo.checked-in-claims",
      evidenceKind: "deterministic-repo",
      command: "validate checked-in compatibility claims and fixtures",
      source: "docs/app-server-compatibility-contract.md",
    }),
    Object.freeze({
      id: "repo.supported-version-consistency",
      evidenceKind: "deterministic-repo",
      command: "validate supported Codex versions across registry, bridge, fixture, and documentation",
      source: "src/mcp-app-server-bridge.mjs",
    }),
    Object.freeze({
      id: "repo.model-catalog-invariants",
      evidenceKind: "deterministic-repo",
      command: "node --test test/model-catalog-freshness.test.mjs test/check-model-catalog.test.mjs",
      source: "test/model-catalog-freshness.test.mjs",
    }),
    Object.freeze({
      id: "repo.app-server-invariants",
      evidenceKind: "deterministic-repo",
      command: "node --test test/mcp-app-server-bridge.test.mjs",
      source: "test/mcp-app-server-bridge.test.mjs",
    }),
    Object.freeze({
      id: "repo.protocol-contracts",
      evidenceKind: "deterministic-repo",
      command: "node --test test/protocol-contract.test.mjs",
      source: "test/protocol-contract.test.mjs",
    }),
    Object.freeze({
      id: "repo.experimentation-contracts",
      evidenceKind: "deterministic-repo",
      command: "node --test test/experimentation-contract-kernel.test.mjs test/experimentation-contract-experiment.test.mjs test/corpus-release-contract.test.mjs test/experimentation-task-contract.test.mjs test/experimentation-runtime-lock-contract.test.mjs test/experimentation-contract-export.test.mjs test/experimentation-contract-semver.test.mjs test/experimentation-corpus.test.mjs test/experimentation-evidence.test.mjs test/headless-experiment-runtime.test.mjs test/experiment-runner.test.mjs test/experiment-ci-gates.test.mjs test/experiment-fleet.test.mjs test/experimentation-reporting.test.mjs test/signed-in-pilot.test.mjs test/api-baseline-harness.test.mjs",
      source: "test/experimentation-contract-export.test.mjs",
    }),
    Object.freeze({
      id: "repo.routing-evaluation",
      evidenceKind: "deterministic-repo",
      command: "node --test test/routing-evaluation.test.mjs",
      source: "test/routing-evaluation.test.mjs",
    }),
    Object.freeze({
      id: "upstream.app-server-docs",
      evidenceKind: "upstream-docs",
      command: "review pinned App Server documentation scopes",
      source: "https://learn.chatgpt.com/docs/app-server",
    }),
    Object.freeze({
      id: "upstream.codex-app-server-source",
      evidenceKind: "upstream-open-source",
      command: "compare the declared App Server protocol source paths",
      source:
        "https://github.com/openai/codex#codex-rs/app-server-protocol/src/protocol/common.rs",
    }),
    Object.freeze({
      id: "schema.app-server-v0144x",
      evidenceKind: "generated-schema",
      command: "validate the reduced generated App Server schema fixture",
      source: "test/fixtures/mcp-app-server-protocol-v0.144.x.json",
    }),
    Object.freeze({
      id: "runtime.stdio-transport",
      evidenceKind: "runtime-transport",
      command: "npm run verify:app-server",
      source: "codex-app-server:stdio-jsonl",
    }),
    Object.freeze({
      id: "runtime.live-app-server",
      evidenceKind: "runtime-live",
      command: "npm run verify:app-server:live",
      source: "codex-app-server:live",
    }),
    Object.freeze({
      id: "advisory.compatibility-review",
      evidenceKind: "semantic-advisory",
      command: "review compatibility report for semantic drift",
      source: "compatibility-review:human-or-agent",
    }),
  ]),
  capabilities: Object.freeze([
    Object.freeze({
      id: "app-server.protocol-shapes",
      title: "Strict App Server protocol shapes",
      dependsOn: Object.freeze([]),
      globalInvariant: false,
      supportedCodexReleases: Object.freeze([
        "codex@0.144.5",
        "codex@0.144.6",
      ]),
      mappings: Object.freeze({
        owned: Object.freeze(["src/protocol-contract/**"]),
        shared: Object.freeze([
          "src/mcp-app-server-bridge.mjs",
          "src/wire-compatibility-collector.mjs",
        ]),
        test: Object.freeze([
          "test/protocol-contract.test.mjs",
          "test/mcp-app-server-bridge.test.mjs",
          "test/wire-compatibility-collector.test.mjs",
          "test/support/fake-wire-codex.mjs",
        ]),
        documentation: Object.freeze([
          "docs/app-server-compatibility-contract.md",
        ]),
        upstreamDocumentation: Object.freeze([
          "https://learn.chatgpt.com/docs/app-server",
        ]),
        upstreamSource: Object.freeze([
          Object.freeze({
            repository: "https://github.com/openai/codex",
            paths: Object.freeze([
              "codex-rs/app-server-protocol/src/protocol/common.rs",
              "codex-rs/app-server-protocol/src/protocol/v2/mod.rs",
            ]),
            artifacts: Object.freeze([]),
            advisoryRef: "refs/heads/main",
          }),
        ]),
        generatedSchema: Object.freeze([
          "test/fixtures/mcp-app-server-protocol-v0.144.x.json",
        ]),
        runtime: Object.freeze(["codex-app-server:stdio-jsonl"]),
        checks: Object.freeze([
          "repo.protocol-contracts",
          "upstream.app-server-docs",
          "upstream.codex-app-server-source",
          "schema.app-server-v0144x",
        ]),
      }),
    }),
    Object.freeze({
      id: "app-server.strict-bridge",
      title: "Strict MCP App Server bridge behavior",
      dependsOn: Object.freeze(["app-server.protocol-shapes"]),
      globalInvariant: false,
      supportedCodexReleases: Object.freeze([
        "codex@0.144.5",
        "codex@0.144.6",
      ]),
      mappings: Object.freeze({
        owned: Object.freeze(["src/mcp-app-server-bridge.mjs"]),
        shared: Object.freeze([
          "scripts/collect-runtime-transport.mjs",
          "src/app-server-client.mjs",
        ]),
        test: Object.freeze(["test/mcp-app-server-bridge.test.mjs"]),
        documentation: Object.freeze([
          "docs/app-server-compatibility-contract.md",
          "docs/development.md",
          "docs/mcp-tool-surface.md",
        ]),
        upstreamDocumentation: Object.freeze([
          "https://learn.chatgpt.com/docs/app-server",
        ]),
        upstreamSource: Object.freeze([
          Object.freeze({
            repository: "https://github.com/openai/codex",
            paths: Object.freeze([
              "codex-rs/app-server/src/message_processor.rs",
              "codex-rs/app-server/src/transport.rs",
            ]),
            artifacts: Object.freeze([]),
            advisoryRef: "refs/heads/main",
          }),
        ]),
        generatedSchema: Object.freeze([
          "test/fixtures/mcp-app-server-protocol-v0.144.x.json",
        ]),
        runtime: Object.freeze([
          "codex-app-server:stdio-jsonl",
          "codex-app-server:live",
        ]),
        checks: Object.freeze([
          "runtime.stdio-transport",
          "runtime.live-app-server",
        ]),
      }),
    }),
    Object.freeze({
      id: "nelos.experimentation-contracts",
      title: "Experimentation contracts, corpus, grading, and runtime lanes",
      dependsOn: Object.freeze([]),
      globalInvariant: false,
      supportedCodexReleases: Object.freeze([]),
      mappings: Object.freeze({
        owned: Object.freeze([
          ".github/workflows/experiment-ci.yml",
          "bin/nelos-experiment",
          "bin/nelos-verify-experiment-report",
          "scripts/bind-release-experiment-canary.mjs",
          "scripts/api-codex-adapter.mjs",
          "scripts/build-api-baseline.mjs",
          "scripts/build-api-baseline-variance-evidence.mjs",
          "scripts/plan-api-baseline-calibration.mjs",
          "scripts/build-signed-in-pilot.mjs",
          "scripts/decide-api-baseline.mjs",
          "scripts/report-signed-in-pilot.mjs",
          "scripts/run-signed-in-pilot-canary.mjs",
          "scripts/run-api-baseline.mjs",
          "scripts/run-experiment-ci-gate.mjs",
          "scripts/signed-in-codex-vm-adapter.mjs",
          "src/api-baseline-adapter.mjs",
          "src/api-baseline-calibration-plan.mjs",
          "src/api-baseline-harness.mjs",
          "src/api-baseline-receipt-proxy.mjs",
          "src/api-baseline-research-packet.mjs",
          "src/api-baseline-runtime.mjs",
          "src/api-baseline-variance-evidence.mjs",
          "src/experiment-ci-gates.mjs",
          "src/experiment-fleet.mjs",
          "src/experiment-runner.mjs",
          "src/runtime-lock-admission.mjs",
          "src/signed-in-pilot-telemetry.mjs",
          "src/experimentation-reporting/**",
          "src/headless-experiment-runtime.mjs",
          "src/experimentation-contract/**",
          "src/experimentation-corpus/**",
          "src/experimentation-evidence/**",
        ]),
        shared: Object.freeze([
          "corpus/starter/**",
          "package.json",
          "scripts/build-experiment-corpus.mjs",
          "scripts/test-support/fake-experiment-adapter.mjs",
        ]),
        test: Object.freeze([
          "test/corpus-release-contract.test.mjs",
          "test/api-baseline-harness.test.mjs",
          "test/experimentation-contract-experiment.test.mjs",
          "test/experimentation-contract-export.test.mjs",
          "test/experimentation-contract-kernel.test.mjs",
          "test/experimentation-contract-semver.test.mjs",
          "test/experimentation-corpus.test.mjs",
          "test/experimentation-evidence.test.mjs",
          "test/experiment-ci-gates.test.mjs",
          "test/experiment-fleet.test.mjs",
          "test/experiment-runner.test.mjs",
          "test/experimentation-reporting.test.mjs",
          "test/experimentation-runtime-lock-contract.test.mjs",
          "test/experimentation-task-contract.test.mjs",
          "test/headless-experiment-runtime.test.mjs",
          "test/runtime-lock-admission.test.mjs",
          "test/signed-in-pilot.test.mjs",
          "test/fixtures/experimentation-contract/**",
          "test/fixtures/experimentation-corpus/**",
          "test/fixtures/experimentation-reporting/**",
        ]),
        documentation: Object.freeze([
          "README.md",
          "docs/corpus-authoring.md",
          "docs/api-controlled-baseline.md",
          "docs/experimentation-evaluation.md",
          "docs/experimentation-framework.md",
          "docs/experimentation-operations.md",
          "docs/experimentation-roadmap.md",
          "docs/experimentation-runtime.md",
          "docs/issue-51-signed-in-pilot-result.md",
          "docs/signed-in-pilot.md",
        ]),
        upstreamDocumentation: Object.freeze([]),
        upstreamSource: Object.freeze([]),
        generatedSchema: Object.freeze([]),
        runtime: Object.freeze([]),
        checks: Object.freeze(["repo.experimentation-contracts"]),
      }),
    }),
    Object.freeze({
      id: "nelos.lifecycle-invariants",
      title: "Nelos lifecycle ownership and fail-closed semantics",
      dependsOn: Object.freeze(["app-server.strict-bridge"]),
      globalInvariant: true,
      supportedCodexReleases: Object.freeze([]),
      mappings: Object.freeze({
        owned: Object.freeze([
          ".mcp.json",
          ".github/workflows/promote-marketplace.yml",
          "bin/nelos",
          "bin/nelos-compatibility",
          "bin/nelos-mcp",
          "bin/nelos-semantic-advisory",
          "bin/nelos-title",
          "bin/nelos-uninstall-distribution",
          "evals/routing/**",
          "mcp.json",
          "plugin.json",
          "scripts/build-release-artifacts.mjs",
          "src/bundled-mcp-state.mjs",
          "src/exception-replanning.mjs",
          "src/execution-map.mjs",
          "src/execution-store.mjs",
          "src/distribution-doctor.mjs",
          "src/distribution-install.mjs",
          "src/distribution-provenance.mjs",
          "src/distribution-uninstall.mjs",
          "src/desktop-smoke-contract.mjs",
          "src/launch-batch-verification.mjs",
          "src/launch-execution-gate.mjs",
          "src/mcp-observation.mjs",
          "src/mcp-queen-decision.mjs",
          "src/native-launch-adapter.mjs",
          "src/next-action.mjs",
          "src/mcp-server.mjs",
          "src/nelos-configuration.mjs",
          "src/runtime-identity.mjs",
          "src/runtime-lifecycle.mjs",
          "src/runtime-mutation-fence.mjs",
          "src/runtime-worker-registry.mjs",
          "src/routing-evaluation.mjs",
          "src/offline-compatibility-gate.mjs",
          "src/orchestration-checkpoint-store.mjs",
          "src/orchestration-observation.mjs",
          "src/planning-bootstrap.mjs",
          "src/planning-lifecycle.mjs",
          "src/plan-orchestration-bridge.mjs",
          "src/plan-run-store.mjs",
          "src/semantic-advisory-runner.mjs",
          "src/spinoff-lifecycle.mjs",
          "src/task-web.mjs",
          "src/queen-acceptance.mjs",
          "src/vendor/smol-toml-1.6.0.LICENSE",
          "src/vendor/smol-toml-1.6.0.cjs",
          "scripts/collect-compatibility-evidence.mjs",
          "scripts/dev-mcp-app-ui.mjs",
          "scripts/generate-mcp-config.mjs",
          "scripts/evaluate-routing-scenarios.mjs",
          "scripts/mcp-app-fixture-server.mjs",
          "scripts/offline-network-blocker.cjs",
          "scripts/run-required-compatibility.mjs",
          "scripts/validate-marketplace-promotion.mjs",
          "scripts/validate-plugin-release.mjs",
          "scripts/verify-mcp-app.mjs",
          "scripts/verify-planning-lifecycle.mjs",
          "scripts/verify-plugin-marketplace-upgrade.mjs",
          "scripts/verify-release-compatibility-evidence.mjs",
          "skills/manage-nelos-tasks/SKILL.md",
        ]),
        shared: Object.freeze([
          ".codex-plugin/plugin.json",
          "distribution-provenance.json",
          "package-lock.json",
          "package.json",
          "scripts/check-model-catalog.mjs",
          "src/compatibility-contract-registry.mjs",
          "src/process-liveness.mjs",
          "src/task-state.mjs",
          "src/upstream-documentation-contracts.mjs",
          "src/upstream-documentation-evidence.mjs",
          "src/upstream-source-collector.mjs",
          "src/web-inspection.mjs",
          "src/work-result.mjs",
        ]),
        test: Object.freeze([
          "test/agent-plugin-layout.test.mjs",
          "test/check-model-catalog.test.mjs",
          "test/cli.test.mjs",
          "test/cli-completions.test.mjs",
          "test/compatibility-contract-registry.test.mjs",
          "test/compatibility-rollout-e2e.test.mjs",
          "test/compatibility-workflows.test.mjs",
          "test/durable-spinoff-composition.test.mjs",
          "test/distribution-doctor.test.mjs",
          "test/distribution-install.test.mjs",
          "test/distribution-provenance.test.mjs",
          "test/desktop-smoke-contract.test.mjs",
          "test/desktop-smoke-scenario-library.test.mjs",
          "test/execution-map.test.mjs",
          "test/execution-store.test.mjs",
          "test/manage-nelos-tasks-skill.test.mjs",
          "test/marketplace-promotion.test.mjs",
          "test/mcp-config.test.mjs",
          "test/nelos-configuration.test.mjs",
          "test/support/launch-authorization-helper.mjs",
          "test/launch-execution-gate.test.mjs",
          "test/launch-batch-verification.test.mjs",
          "test/mcp-app-fixtures.test.mjs",
          "test/mcp-observation.test.mjs",
          "test/mcp-server.test.mjs",
          "test/mcp-queen-decision.test.mjs",
          "test/mixed-wave-launch.integration.test.mjs",
          "test/next-action.test.mjs",
          "test/offline-compatibility-gate.test.mjs",
          "test/orchestration-observation.test.mjs",
          "test/exception-replanning.test.mjs",
          "test/planning-lifecycle.test.mjs",
          "test/planning-lifecycle-smoke.test.mjs",
          "test/plan-run-store.test.mjs",
          "test/plugin-marketplace-upgrade.test.mjs",
          "test/plugin-release-validation.test.mjs",
          "test/plugin-marketplace.test.mjs",
          "test/release-artifacts.test.mjs",
          "test/runtime-identity.test.mjs",
          "test/runtime-mutation-fence.test.mjs",
          "test/runtime-worker-registry.test.mjs",
          "test/routing-evaluation.test.mjs",
          "test/semantic-advisory-runner.test.mjs",
          "test/spinoff-lifecycle.test.mjs",
          "test/task-launch-prompt.test.mjs",
          "test/task-state.test.mjs",
          "test/task-web.test.mjs",
          "test/queen-acceptance.test.mjs",
          "test/upstream-documentation-evidence.test.mjs",
          "test/upstream-source-collector.test.mjs",
          "test/web-inspection.test.mjs",
        ]),
        documentation: Object.freeze([
          "CONTRIBUTING.md",
          "docs/backlog.md",
          "docs/compatibility-architecture.md",
          "docs/configuration.md",
          "docs/codex-capability-audit.md",
          "docs/installation.md",
          "docs/mcp-visual-evidence.md",
          "docs/mcp-web-ui.md",
          "docs/observation-join.md",
          "docs/mcp-tool-surface.md",
          "docs/release-policy.md",
          "docs/routing-evaluation.md",
          "docs/routing.md",
          "docs/slice-planning.md",
          "docs/task-orchestration.md",
          "docs/v0.5.0-integration-report.md",
          "docs/webs.md",
          "docs/app-server-compatibility-contract.md",
        ]),
        upstreamDocumentation: Object.freeze([]),
        upstreamSource: Object.freeze([]),
        generatedSchema: Object.freeze([]),
        runtime: Object.freeze([]),
        checks: Object.freeze([
          "repo.registry-integrity",
          "repo.checked-in-claims",
          "repo.supported-version-consistency",
          "repo.model-catalog-invariants",
          "repo.app-server-invariants",
          "repo.protocol-contracts",
          "repo.routing-evaluation",
          "advisory.compatibility-review",
        ]),
      }),
    }),
  ]),
});

validateCompatibilityRegistryV1(COMPATIBILITY_CONTRACT_REGISTRY_V1);
