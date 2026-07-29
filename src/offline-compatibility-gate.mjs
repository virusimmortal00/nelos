import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
  selectImpactedCompatibilityContractsV1,
  validateCompatibilityRegistryV1,
  validateCompatibilityReportV1,
} from "./compatibility-contract-registry.mjs";
import {
  collectGeneratedSchemaEvidenceV1,
  WireCompatibilityMismatch,
} from "./wire-compatibility-collector.mjs";

const execFileAsync = promisify(execFile);
const DETERMINISTIC_KINDS = new Set([
  "deterministic-repo",
  "generated-schema",
]);
const DEFAULT_BASE = "HEAD^";
const DEFAULT_HEAD = "HEAD";

export class OfflineCompatibilityGateError extends Error {
  constructor(message, { code = "infrastructure-error", cause } = {}) {
    super(message, { cause });
    this.name = "OfflineCompatibilityGateError";
    this.code = code;
  }
}

export class OfflineCompatibilityCheckFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "OfflineCompatibilityCheckFailure";
  }
}

function check(condition, message) {
  if (!condition) throw new OfflineCompatibilityCheckFailure(message);
}

function stableUnique(values) {
  return [...new Set(values)].sort();
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new OfflineCompatibilityGateError(
      `${label} could not be read: ${error.message}`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OfflineCompatibilityCheckFailure(`${label} is not valid JSON`);
  }
}

function parseNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const statusToken = fields[index++];
    const code = statusToken?.[0];
    if (code === "R" || code === "C") {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (!oldPath || !newPath) {
        throw new OfflineCompatibilityGateError(
          "git diff returned a malformed rename record",
          { code: "git-diff-error" },
        );
      }
      changes.push({ status: "renamed", oldPath, newPath });
      continue;
    }
    const path = fields[index++];
    if (!path || !["A", "D", "M", "T"].includes(code)) {
      throw new OfflineCompatibilityGateError(
        `git diff returned unsupported status ${statusToken ?? "<missing>"}`,
        { code: "git-diff-error" },
      );
    }
    changes.push({
      status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      path,
    });
  }
  return changes;
}

export async function deriveCompatibilityChanges({
  root,
  files,
  base = DEFAULT_BASE,
  head = DEFAULT_HEAD,
  execGit = execFileAsync,
} = {}) {
  if (!root) {
    throw new OfflineCompatibilityGateError("repository root is required", {
      code: "invalid-arguments",
    });
  }
  if (files !== undefined) {
    if (!Array.isArray(files)) {
      throw new OfflineCompatibilityGateError("files must be an array", {
        code: "invalid-arguments",
      });
    }
    return files.map((path) =>
      typeof path === "string" ? { status: "modified", path } : path);
  }
  try {
    const { stdout } = await execGit(
      "git",
      ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return parseNameStatus(stdout);
  } catch (error) {
    if (error instanceof OfflineCompatibilityGateError) throw error;
    throw new OfflineCompatibilityGateError(
      `git diff ${base}...${head} failed: ${error.message}`,
      { code: "git-diff-error", cause: error },
    );
  }
}

async function validateCheckedInClaims({ registry, root }) {
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  const contract = await readFile(
    resolve(root, "docs/app-server-compatibility-contract.md"),
    "utf8",
  );
  for (const release of registry.supportedCodexReleases) {
    check(
      readme.includes(release.version),
      `README.md does not name supported Codex ${release.version}`,
    );
    check(
      contract.includes(release.version),
      `compatibility contract does not name supported Codex ${release.version}`,
    );
    const fixture = await readJson(
      resolve(root, release.fixture),
      release.fixture,
    );
    check(
      Array.isArray(fixture.testedCodexVersions),
      `${release.fixture} must declare testedCodexVersions`,
    );
    check(
      fixture.testedCodexVersions.includes(release.version),
      `${release.fixture} does not attest Codex ${release.version}`,
    );
    check(
      fixture.initialize?.experimentalApi === true,
      `${release.fixture} must require experimentalApi`,
    );
    check(
      fixture.methods && typeof fixture.methods === "object",
      `${release.fixture} must declare method fixtures`,
    );
  }
  return "checked-in compatibility claims and fixtures are coherent";
}

async function validateSupportedVersionConsistency({ registry, root }) {
  const bridgeUrl = pathToFileURL(
    resolve(root, "src/mcp-app-server-bridge.mjs"),
  ).href;
  const bridge = await import(`${bridgeUrl}?offline-gate=1`);
  const registryVersions = stableUnique(
    registry.supportedCodexReleases.map(({ version }) => version),
  );
  const bridgeVersions = stableUnique(
    bridge.TESTED_CODEX_APP_SERVER_VERSIONS ?? [],
  );
  check(
    JSON.stringify(registryVersions) === JSON.stringify(bridgeVersions),
    `registry versions ${registryVersions.join(", ")} do not match bridge versions ${bridgeVersions.join(", ")}`,
  );
  const minimum = [...registryVersions].sort(compareVersions)[0];
  check(
    bridge.MINIMUM_CODEX_APP_SERVER_VERSION === minimum,
    `bridge minimum ${bridge.MINIMUM_CODEX_APP_SERVER_VERSION} does not match ${minimum}`,
  );
  for (const release of registry.supportedCodexReleases) {
    check(
      release.id === `codex@${release.version}`,
      `release ${release.id} is inconsistent with version ${release.version}`,
    );
  }
  return `supported Codex versions are consistent: ${registryVersions.join(", ")}`;
}

async function validateGeneratedSchema({ registry, root }) {
  const checkDefinition = registry.checks.find(
    ({ id }) => id === "schema.app-server-v0144x",
  );
  if (!checkDefinition) {
    throw new OfflineCompatibilityGateError(
      "generated-schema check declaration is missing",
      { code: "malformed-registry" },
    );
  }
  const report = await collectGeneratedSchemaEvidenceV1({
    root,
    declaration: {
      checkId: checkDefinition.id,
      expectedCodexIdentities: registry.supportedCodexReleases
        .map(({ version }) => ({ version, commitSha: null })),
      artifact: { path: checkDefinition.source },
    },
    validateSchema(fixture) {
      const requiredMethods = [
        "thread/read",
        "thread/name/set",
        "thread/resume",
        "thread/turns/list",
        "turn/start",
        "turn/steer",
        "thread/archive",
      ];
      if (!requiredMethods.every(
        (method) => Object.hasOwn(fixture.methods ?? {}, method),
      )) {
        throw new WireCompatibilityMismatch(
          `${checkDefinition.source} is missing a required App Server method fixture`,
        );
      }
      if (
        !Array.isArray(fixture.threadStatus?.types) ||
        fixture.threadStatus.types.length === 0
      ) {
        throw new WireCompatibilityMismatch(
          `${checkDefinition.source} is missing thread status fixtures`,
        );
      }
    },
  });
  if (report.outcome === "failed") {
    throw new OfflineCompatibilityCheckFailure(report.failure.message);
  }
  if (report.outcome !== "passed") {
    throw new OfflineCompatibilityGateError(
      `generated-schema evidence unavailable (${report.failure.kind}): ${report.failure.message}`,
      { code: report.failure.kind },
    );
  }
  return `generated App Server artifact ${report.digest} is valid for ${report.expectedCodexIdentities.map(({ version }) => version).join(", ")}`;
}

function offlineChildEnvironment() {
  const environment = {
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
  for (const name of ["TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  return environment;
}

async function runNodeTests(root, testPaths) {
  const blocker = resolve(root, "scripts/offline-network-blocker.cjs");
  try {
    await execFileAsync(
      process.execPath,
      ["--require", blocker, "--test", ...testPaths],
      {
        cwd: root,
        encoding: "utf8",
        env: offlineChildEnvironment(),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      },
    );
  } catch (error) {
    if (
      error.code === "ENOENT" ||
      error.killed ||
      error.signal ||
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ) {
      throw new OfflineCompatibilityGateError(
        `deterministic test infrastructure failed: ${error.message}`,
        { cause: error },
      );
    }
    const detail = String(error.stderr || error.stdout || error.message)
      .trim()
      .split("\n")
      .slice(-8)
      .join(" | ");
    throw new OfflineCompatibilityCheckFailure(
      `deterministic tests failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return `${testPaths.join(", ")} passed offline`;
}

function defaultCheckRunners() {
  return new Map([
    [
      "repo.registry-integrity",
      async ({ registry }) => {
        validateCompatibilityRegistryV1(registry);
        return "compatibility registry integrity passed";
      },
    ],
    ["repo.checked-in-claims", validateCheckedInClaims],
    ["repo.supported-version-consistency", validateSupportedVersionConsistency],
    [
      "repo.model-catalog-invariants",
      ({ root }) => runNodeTests(root, [
        "test/model-catalog-freshness.test.mjs",
        "test/check-model-catalog.test.mjs",
      ]),
    ],
    [
      "repo.app-server-invariants",
      ({ root }) => runNodeTests(root, [
        "test/mcp-app-server-bridge.test.mjs",
      ]),
    ],
    [
      "repo.protocol-contracts",
      ({ root }) => runNodeTests(root, ["test/protocol-contract.test.mjs"]),
    ],
    ["schema.app-server-v0144x", validateGeneratedSchema],
  ]);
}

function evidenceFor(checkDefinition, outcome, summary) {
  return Object.freeze({
    checkId: checkDefinition.id,
    kind: checkDefinition.evidenceKind,
    outcome,
    countsForCompatibility: outcome === "passed",
    source: checkDefinition.source,
    summary,
  });
}

function capabilityStatus(evidence, mappedCheckIds) {
  if (evidence.some(({ outcome }) => outcome === "failed")) return "incompatible";
  const complete = mappedCheckIds.every((checkId) =>
    evidence.some((item) => item.checkId === checkId && item.outcome === "passed"));
  return complete ? "compatible" : "unverified";
}

export async function runOfflineCompatibilityGate({
  root,
  registry = COMPATIBILITY_CONTRACT_REGISTRY_V1,
  changes,
  files,
  base = DEFAULT_BASE,
  head = DEFAULT_HEAD,
  checkRunners = defaultCheckRunners(),
  execGit,
} = {}) {
  try {
    validateCompatibilityRegistryV1(registry);
  } catch (error) {
    throw new OfflineCompatibilityGateError(error.message, {
      code: "malformed-registry",
      cause: error,
    });
  }
  const resolvedChanges = changes ?? await deriveCompatibilityChanges({
    root,
    files,
    base,
    head,
    execGit,
  });
  const selection = selectImpactedCompatibilityContractsV1(
    registry,
    resolvedChanges,
  );
  const selectedCapabilities = registry.capabilities.filter(({ id }) =>
    selection.selectedCapabilityIds.includes(id));
  const selectedCheckIds = stableUnique(
    selectedCapabilities.flatMap(({ mappings }) => mappings.checks),
  );
  const deterministicCheckIds = selectedCheckIds.filter((checkId) => {
    const definition = registry.checks.find(({ id }) => id === checkId);
    return DETERMINISTIC_KINDS.has(definition.evidenceKind);
  });
  const results = new Map();
  let infrastructureFailure = false;
  for (const checkId of deterministicCheckIds) {
    const definition = registry.checks.find(({ id }) => id === checkId);
    const runner = checkRunners.get(checkId);
    if (!runner) {
      infrastructureFailure = true;
      results.set(checkId, evidenceFor(
        definition,
        "infrastructure-failure",
        `no offline deterministic runner is registered for ${checkId}`,
      ));
      continue;
    }
    try {
      const summary = await runner({ registry, root, selection });
      results.set(
        checkId,
        evidenceFor(definition, "passed", summary || `${checkId} passed`),
      );
    } catch (error) {
      const isCheckFailure = error instanceof OfflineCompatibilityCheckFailure;
      infrastructureFailure ||= !isCheckFailure;
      results.set(checkId, evidenceFor(
        definition,
        isCheckFailure ? "failed" : "infrastructure-failure",
        `${checkId}: ${error.message}`,
      ));
    }
  }

  const capabilities = selectedCapabilities.map((capability) => {
    const evidence = capability.mappings.checks.map((checkId) => {
      if (results.has(checkId)) return results.get(checkId);
      const definition = registry.checks.find(({ id }) => id === checkId);
      return evidenceFor(
        definition,
        "unavailable",
        `${checkId} is outside the offline deterministic gate`,
      );
    });
    return Object.freeze({
      capabilityId: capability.id,
      status: capabilityStatus(evidence, capability.mappings.checks),
      evidence: Object.freeze(evidence),
    });
  });
  const statuses = capabilities.map(({ status }) => status);
  const report = Object.freeze({
    schemaVersion: 1,
    registryVersion: registry.registryVersion,
    overallStatus: statuses.includes("incompatible")
      ? "incompatible"
      : statuses.every((status) => status === "compatible")
        ? "compatible"
        : "unverified",
    capabilities: Object.freeze(capabilities),
  });
  try {
    validateCompatibilityReportV1(registry, report, {
      selectedCapabilityIds: selection.selectedCapabilityIds,
    });
  } catch (error) {
    throw new OfflineCompatibilityGateError(
      `generated compatibility report is invalid: ${error.message}`,
      { code: "invalid-report", cause: error },
    );
  }
  const deterministicFailure = [...results.values()]
    .some(({ outcome }) => outcome === "failed");
  return Object.freeze({
    changes: Object.freeze(resolvedChanges),
    selection,
    report,
    exitCode: infrastructureFailure
      ? 2
      : !selection.ok || deterministicFailure
        ? 1
        : 0,
  });
}

export const OFFLINE_COMPATIBILITY_DEFAULTS = Object.freeze({
  base: DEFAULT_BASE,
  head: DEFAULT_HEAD,
});
