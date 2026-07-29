import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
  COMPATIBILITY_EVIDENCE_KINDS,
  selectImpactedCompatibilityContractsV1,
  validateCompatibilityRegistryV1,
  validateCompatibilityReportV1,
} from "../src/compatibility-contract-registry.mjs";
import { adaptUpstreamDocumentationObservationV1 } from "../src/upstream-documentation-evidence.mjs";

function clone(value = COMPATIBILITY_CONTRACT_REGISTRY_V1) {
  return structuredClone(value);
}

function evidence(checkId, kind, source, outcome = "passed") {
  return {
    checkId,
    kind,
    outcome,
    countsForCompatibility: outcome === "passed",
    source,
    summary: `${checkId} ${outcome}`,
  };
}

test("representative compatibility registry is valid and publicly importable", async () => {
  assert.equal(
    validateCompatibilityRegistryV1(COMPATIBILITY_CONTRACT_REGISTRY_V1),
    COMPATIBILITY_CONTRACT_REGISTRY_V1,
  );
  assert.deepEqual(COMPATIBILITY_EVIDENCE_KINDS, [
    "deterministic-repo",
    "upstream-docs",
    "upstream-open-source",
    "generated-schema",
    "runtime-transport",
    "runtime-live",
    "semantic-advisory",
  ]);
  const publicContract = await import("nelos/compatibility-contract-registry");
  assert.equal(publicContract.COMPATIBILITY_CONTRACT_REGISTRY_V1.registryVersion, "1.0.0");
});

test("registry rejects duplicates, unknown dependencies, bad checks, and releases", () => {
  const duplicate = clone();
  duplicate.capabilities.push(clone().capabilities[0]);
  assert.throws(() => validateCompatibilityRegistryV1(duplicate), /duplicate capability ID/u);

  const dependency = clone();
  dependency.capabilities[0].dependsOn.push("unknown.capability");
  assert.throws(() => validateCompatibilityRegistryV1(dependency), /unknown capability/u);

  const check = clone();
  check.capabilities[0].mappings.checks.push("unknown.check");
  assert.throws(() => validateCompatibilityRegistryV1(check), /unknown check/u);

  const evidenceKind = clone();
  evidenceKind.checks[0].evidenceKind = "guess";
  assert.throws(() => validateCompatibilityRegistryV1(evidenceKind), /evidenceKind is unknown/u);

  const release = clone();
  release.capabilities[0].supportedCodexReleases.push("codex@0.145.0");
  assert.throws(() => validateCompatibilityRegistryV1(release), /unresolved supported Codex release/u);
});

test("registry rejects malformed scopes and broad upstream source declarations", () => {
  const malformedPath = clone();
  malformedPath.capabilities[0].mappings.owned = ["/absolute/path"];
  assert.throws(() => validateCompatibilityRegistryV1(malformedPath), /normalized repository-relative/u);

  const malformedUrl = clone();
  malformedUrl.capabilities[0].mappings.upstreamDocumentation = ["http://example.test/*"];
  assert.throws(() => validateCompatibilityRegistryV1(malformedUrl), /bounded absolute HTTPS URL/u);

  const lookalikeRepository = clone();
  lookalikeRepository.capabilities[0].mappings.upstreamSource[0].repository =
    "https://evilgithub.com/openai/codex";
  assert.throws(
    () => validateCompatibilityRegistryV1(lookalikeRepository),
    /upstream source repository/u,
  );

  const broadSource = clone();
  broadSource.capabilities[0].mappings.upstreamSource[0].paths = ["codex-rs/**"];
  assert.throws(() => validateCompatibilityRegistryV1(broadSource), /too broad for upstream-source/u);

  const movingReleaseBranch = clone();
  movingReleaseBranch.supportedCodexReleases[0].upstreamSourceRefs[0].requestedRef =
    "refs/heads/release";
  assert.throws(
    () => validateCompatibilityRegistryV1(movingReleaseBranch),
    /requestedRef is invalid/u,
  );

  const mismatchedCommit = clone();
  mismatchedCommit.supportedCodexReleases[0].upstreamSourceRefs[0] = {
    repository: "https://github.com/openai/codex",
    requestedRef: "1111111111111111111111111111111111111111",
    commitSha: "2222222222222222222222222222222222222222",
  };
  assert.throws(
    () => validateCompatibilityRegistryV1(mismatchedCommit),
    /requestedRef commit must match commitSha/u,
  );
});

test("changed paths select direct contracts and transitive dependents", () => {
  const selection = selectImpactedCompatibilityContractsV1(
    COMPATIBILITY_CONTRACT_REGISTRY_V1,
    ["src/protocol-contract/index.mjs"],
  );
  assert.equal(selection.ok, true);
  assert.deepEqual(selection.selectedCapabilityIds, [
    "app-server.protocol-shapes",
    "app-server.strict-bridge",
    "nelos.lifecycle-invariants",
  ]);
  assert.deepEqual(selection.pathSelections[0].capabilityIds, [
    "app-server.protocol-shapes",
  ]);
});

test("installed configuration surfaces belong to lifecycle invariants", () => {
  const paths = [
    ".codex-plugin/plugin.json",
    "docs/configuration.md",
    "docs/observation-join.md",
    "docs/slice-planning.md",
    "src/mcp-server.mjs",
    "src/nelos-configuration.mjs",
    "src/planning-lifecycle.mjs",
    "src/vendor/smol-toml-1.6.0.LICENSE",
    "src/vendor/smol-toml-1.6.0.cjs",
    "test/durable-spinoff-composition.test.mjs",
    "test/manage-nelos-tasks-skill.test.mjs",
    "test/mcp-config.test.mjs",
    "test/mcp-server.test.mjs",
    "test/nelos-configuration.test.mjs",
    "test/plugin-marketplace.test.mjs",
  ];
  const selection = selectImpactedCompatibilityContractsV1(
    COMPATIBILITY_CONTRACT_REGISTRY_V1,
    paths.map((path) => ({ status: "modified", path })),
  );
  assert.equal(selection.ok, true);
  assert.deepEqual(selection.unmappedSensitivePaths, []);
  assert.ok(selection.pathSelections.every(({ capabilityIds }) =>
    capabilityIds.includes("nelos.lifecycle-invariants")));
});

test("global invariants are selected even when no paths change", () => {
  const selection = selectImpactedCompatibilityContractsV1(
    COMPATIBILITY_CONTRACT_REGISTRY_V1,
    [],
  );
  assert.deepEqual(selection.selectedCapabilityIds, [
    "nelos.lifecycle-invariants",
  ]);
});

test("renames inspect old and new paths and deletions retain their old mapping", () => {
  const rename = selectImpactedCompatibilityContractsV1(
    COMPATIBILITY_CONTRACT_REGISTRY_V1,
    [{
      status: "renamed",
      oldPath: "src/protocol-contract/index.mjs",
      newPath: "src/mcp-app-server-bridge.mjs",
    }],
  );
  assert.equal(rename.ok, true);
  assert.deepEqual(rename.pathSelections.map(({ path }) => path), [
    "src/protocol-contract/index.mjs",
    "src/mcp-app-server-bridge.mjs",
  ]);
  assert.deepEqual(rename.directCapabilityIds, [
    "app-server.protocol-shapes",
    "app-server.strict-bridge",
    "nelos.lifecycle-invariants",
  ]);

  const deletion = selectImpactedCompatibilityContractsV1(
    COMPATIBILITY_CONTRACT_REGISTRY_V1,
    [{ status: "deleted", path: "test/mcp-app-server-bridge.test.mjs" }],
  );
  assert.equal(deletion.ok, true);
  assert.ok(deletion.selectedCapabilityIds.includes("app-server.strict-bridge"));
});

test("compatibility-sensitive unmapped files fail closed actionably", () => {
  const selection = selectImpactedCompatibilityContractsV1(
    COMPATIBILITY_CONTRACT_REGISTRY_V1,
    [{ status: "added", path: "src/new-app-server-adapter.mjs" }],
  );
  assert.equal(selection.ok, false);
  assert.deepEqual(selection.unmappedSensitivePaths, [
    "src/new-app-server-adapter.mjs",
  ]);
  assert.match(selection.action, /Add each compatibility-sensitive path/u);
  assert.deepEqual(selection.selectedCapabilityIds, [
    "nelos.lifecycle-invariants",
  ]);
});

test("documentation assets are outside the compatibility-sensitive selector", () => {
  const selection = selectImpactedCompatibilityContractsV1(
    COMPATIBILITY_CONTRACT_REGISTRY_V1,
    [{ status: "added", path: "docs/assets/showcase/example.png" }],
  );
  assert.equal(selection.ok, true);
  assert.deepEqual(selection.unmappedSensitivePaths, []);
  assert.deepEqual(selection.selectedCapabilityIds, [
    "nelos.lifecycle-invariants",
  ]);
});

test("report validation derives compatible status from complete passed evidence", () => {
  const report = {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    overallStatus: "compatible",
    capabilities: [{
      capabilityId: "app-server.strict-bridge",
      status: "compatible",
      evidence: [
        evidence(
          "runtime.stdio-transport",
          "runtime-transport",
          "codex-app-server:stdio-jsonl",
        ),
        evidence(
          "runtime.live-app-server",
          "runtime-live",
          "codex-app-server:live",
        ),
      ],
    }],
  };
  assert.equal(
    validateCompatibilityReportV1(
      COMPATIBILITY_CONTRACT_REGISTRY_V1,
      report,
      { selectedCapabilityIds: ["app-server.strict-bridge"] },
    ),
    report,
  );
});

test("unavailable and infrastructure failures cannot count as compatibility evidence", () => {
  for (const outcome of ["unavailable", "infrastructure-failure"]) {
    const report = {
      schemaVersion: 1,
      registryVersion: "1.0.0",
      overallStatus: "unverified",
      capabilities: [{
        capabilityId: "app-server.strict-bridge",
        status: "unverified",
        evidence: [
          evidence(
            "runtime.stdio-transport",
            "runtime-transport",
            "codex-app-server:stdio-jsonl",
            outcome,
          ),
        ],
      }],
    };
    assert.equal(
      validateCompatibilityReportV1(
        COMPATIBILITY_CONTRACT_REGISTRY_V1,
        report,
        { selectedCapabilityIds: ["app-server.strict-bridge"] },
      ),
      report,
    );
    report.capabilities[0].evidence[0].countsForCompatibility = true;
    assert.throws(
      () => validateCompatibilityReportV1(
        COMPATIBILITY_CONTRACT_REGISTRY_V1,
        report,
        { selectedCapabilityIds: ["app-server.strict-bridge"] },
      ),
      /true only for passed evidence/u,
    );
  }
});

test("upstream-documentation adapter metadata validates as unavailable infrastructure", () => {
  const adapted = adaptUpstreamDocumentationObservationV1({
    requestedUrl: "https://learn.chatgpt.com/docs/app-server",
    selected: { kind: "artifact", name: "app-server-document" },
    digest: null,
    observedAt: "2026-07-29T12:00:00.000Z",
    status: "unavailable",
    evidenceKind: "upstream-docs",
    failureKind: "timeout",
    detail: "timed out",
  }, { checkId: "upstream.app-server-docs" });
  const report = {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    overallStatus: "unverified",
    capabilities: [{
      capabilityId: "app-server.protocol-shapes",
      status: "unverified",
      evidence: [adapted],
    }],
  };
  assert.equal(
    validateCompatibilityReportV1(
      COMPATIBILITY_CONTRACT_REGISTRY_V1,
      report,
      { selectedCapabilityIds: ["app-server.protocol-shapes"] },
    ),
    report,
  );
});

test("report rejects invalid evidence mapping, source, and optimistic status", () => {
  const report = {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    overallStatus: "compatible",
    capabilities: [{
      capabilityId: "app-server.strict-bridge",
      status: "compatible",
      evidence: [
        evidence(
          "runtime.stdio-transport",
          "runtime-live",
          "codex-app-server:stdio-jsonl",
        ),
      ],
    }],
  };
  assert.throws(
    () => validateCompatibilityReportV1(
      COMPATIBILITY_CONTRACT_REGISTRY_V1,
      report,
      { selectedCapabilityIds: ["app-server.strict-bridge"] },
    ),
    /kind does not match/u,
  );

  report.capabilities[0].evidence[0].kind = "runtime-transport";
  assert.throws(
    () => validateCompatibilityReportV1(
      COMPATIBILITY_CONTRACT_REGISTRY_V1,
      report,
      { selectedCapabilityIds: ["app-server.strict-bridge"] },
    ),
    /status must be unverified/u,
  );
});
