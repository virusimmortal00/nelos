import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import {
  SEMANTIC_ADVISORY_POLICY_V1,
  runSemanticAdvisoryV1,
  semanticAdvisoryEvidenceDigestV1,
} from "../src/semantic-advisory-runner.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(
  new URL("../bin/nelos-semantic-advisory", import.meta.url),
);
const fixedNow = () => "2026-07-29T12:00:00.000Z";

function registry() {
  return {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    supportedCodexReleases: [],
    checks: [
      {
        id: "repo.contract-check",
        evidenceKind: "deterministic-repo",
        command: "run bounded contract check",
        source: "test/contract.test.mjs",
      },
      {
        id: "advisory.contract-review",
        evidenceKind: "semantic-advisory",
        command: "explicit semantic review",
        source: "semantic-review:injected-provider",
      },
    ],
    capabilities: [{
      id: "contract.one",
      title: "Contract one",
      dependsOn: [],
      globalInvariant: true,
      supportedCodexReleases: [],
      mappings: {
        owned: ["src/contract.mjs"],
        shared: [],
        test: ["test/contract.test.mjs"],
        documentation: [],
        generatedSchema: [],
        upstreamDocumentation: [],
        upstreamSource: [],
        runtime: [],
        checks: ["repo.contract-check", "advisory.contract-review"],
      },
    }],
  };
}

function deterministicReport(overallStatus = "unverified") {
  return {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    overallStatus,
    capabilities: [{
      capabilityId: "contract.one",
      status: overallStatus,
      evidence: [
        {
          checkId: "repo.contract-check",
          kind: "deterministic-repo",
          outcome: "passed",
          countsForCompatibility: true,
          source: "test/contract.test.mjs",
          summary: "bounded deterministic check passed",
        },
        {
          checkId: "advisory.contract-review",
          kind: "semantic-advisory",
          outcome: overallStatus === "compatible" ? "passed" : "unavailable",
          countsForCompatibility: overallStatus === "compatible",
          source: "semantic-review:injected-provider",
          summary: "semantic review is outside the deterministic lane",
        },
      ],
    }],
  };
}

function evidence(content = "expected: thread/read\nobserved: thread/read") {
  return [{
    contractId: "contract.one",
    checkId: "repo.contract-check",
    digest: semanticAdvisoryEvidenceDigestV1(content),
    content,
  }];
}

function configuration(overrides = {}) {
  return {
    providerId: "trusted.test",
    model: "fake-semantic-v1",
    credentialId: "test-only-credential",
    timeoutMs: 100,
    ...overrides,
  };
}

test("explicit opt-in is required before provider configuration or calls", async () => {
  let calls = 0;
  const report = await runSemanticAdvisoryV1({
    optIn: false,
    provider: { compare: async () => { calls += 1; } },
    providerConfiguration: configuration(),
    deterministicReport: deterministicReport(),
    selectedEvidence: evidence(),
    registry: registry(),
    now: fixedNow,
  });
  assert.equal(calls, 0);
  assert.equal(report.invoked, false);
  assert.equal(report.status, "infrastructure-failure");
  assert.equal(report.infrastructure.code, "explicit-opt-in-required");
  assert.equal(report.countsForCompatibility, false);
});

test("semantic advisory runner is available through its public package subpath", async () => {
  const publicRunner = await import("nelos/semantic-advisory-runner");
  assert.equal(typeof publicRunner.runSemanticAdvisoryV1, "function");
  assert.equal(publicRunner.SEMANTIC_ADVISORY_POLICY_V1.maximumEvidenceItems, 8);
});

test("fake provider receives only bounded selected contract evidence", async () => {
  const requests = [];
  const contexts = [];
  const deterministic = deterministicReport();
  const report = await runSemanticAdvisoryV1({
    optIn: true,
    provider: {
      async compare(request, context) {
        requests.push(request);
        contexts.push(context);
        return {
          schemaVersion: 1,
          findings: [{
            contractId: "contract.one",
            evidenceRefs: ["repo.contract-check"],
            severity: "warning",
            summary: "Possible semantic drift in the selected method contract.",
          }],
        };
      },
    },
    providerConfiguration: configuration(),
    deterministicReport: deterministic,
    selectedEvidence: evidence(),
    registry: registry(),
    now: fixedNow,
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0]).sort(), [
    "constraints",
    "contracts",
    "schemaVersion",
    "task",
  ]);
  assert.deepEqual(Object.keys(requests[0].contracts[0].evidence[0]).sort(), [
    "checkId",
    "content",
    "digest",
    "evidenceKind",
    "source",
  ]);
  assert.equal(JSON.stringify(requests[0]).includes("test-only-credential"), false);
  assert.equal(contexts[0].credentialId, "test-only-credential");
  assert.equal(report.status, "completed");
  assert.equal(report.section, "semantic-advisory");
  assert.equal(report.authority, "advisory-only");
  assert.equal(report.countsForCompatibility, false);
  assert.equal(report.findings[0].label, "semantic-advisory");
  assert.equal(report.findings[0].countsForCompatibility, false);
  assert.deepEqual(report.deterministicStatus, {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    overallStatus: "unverified",
    capabilities: [{ capabilityId: "contract.one", status: "unverified" }],
  });
  assert.equal(deterministic.overallStatus, "unverified");
});

test("field, mapping, count, size, and sensitive-content policy runs before provider call", async () => {
  const cases = [
    [{ ...evidence()[0], path: "src/unrelated.mjs" }, "not allowed"],
    [{ ...evidence()[0], checkId: "advisory.contract-review" }, "cannot select"],
    [{
      ...evidence()[0],
      content: "x".repeat(SEMANTIC_ADVISORY_POLICY_V1.maximumEvidenceBytes + 1),
    }, "content is invalid"],
    [evidence("authorization: Bearer secret-token-value")[0], "credentials"],
    [{
      ...evidence()[0],
      content: "content changed after digest selection",
    }, "digest does not match"],
  ];
  for (const [selected, message] of cases) {
    let calls = 0;
    const report = await runSemanticAdvisoryV1({
      optIn: true,
      provider: { compare: async () => { calls += 1; } },
      providerConfiguration: configuration(),
      deterministicReport: deterministicReport(),
      selectedEvidence: [selected],
      registry: registry(),
      now: fixedNow,
    });
    assert.equal(calls, 0, message);
    assert.equal(report.invoked, false, message);
    assert.equal(report.status, "infrastructure-failure", message);
    assert.match(report.infrastructure.summary, new RegExp(message, "u"));
  }
});

test("missing credentials, provider failure, malformed response, and timeout are infrastructure outcomes", async () => {
  const cases = [
    {
      configuration: configuration({ credentialId: "" }),
      provider: { compare: async () => ({ schemaVersion: 1, findings: [] }) },
      code: "invalid-input",
      invoked: false,
    },
    {
      configuration: configuration(),
      provider: { compare: async () => { throw new Error("credential must not echo"); } },
      code: "provider-failure",
      invoked: true,
    },
    {
      configuration: configuration(),
      provider: { compare: async () => ({ schemaVersion: 1, findings: "bad" }) },
      code: "malformed-response",
      invoked: true,
    },
    {
      configuration: configuration({ timeoutMs: 5 }),
      provider: { compare: async () => new Promise(() => {}) },
      code: "timeout",
      invoked: true,
    },
  ];
  for (const item of cases) {
    const report = await runSemanticAdvisoryV1({
      optIn: true,
      provider: item.provider,
      providerConfiguration: item.configuration,
      deterministicReport: deterministicReport(),
      selectedEvidence: evidence(),
      registry: registry(),
      now: fixedNow,
    });
    assert.equal(report.status, "infrastructure-failure", item.code);
    assert.equal(report.infrastructure.code, item.code);
    assert.equal(report.invoked, item.invoked);
    assert.equal(report.countsForCompatibility, false);
    assert.deepEqual(report.findings, []);
    assert.equal(report.deterministicStatus.overallStatus, "unverified");
  }
});

test("semantic command does not load a provider without explicit opt-in", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      "--provider",
      "/definitely/not/a/provider.mjs",
      "--provider-config",
      "/definitely/not/provider-config.json",
      "--input",
      "/definitely/not/input.json",
    ], { encoding: "utf8" }),
    (error) => {
      assert.equal(error.code, 2);
      const report = JSON.parse(error.stdout);
      assert.equal(report.infrastructure.code, "explicit-opt-in-required");
      assert.equal(report.invoked, false);
      assert.equal(report.observedAt, null);
      assert.equal(report.deterministicStatus, null);
      assert.equal(report.provider, null);
      assert.deepEqual(report.evidence, []);
      assert.deepEqual(report.findings, []);
      assert.equal(error.stderr, "");
      return true;
    },
  );
});
