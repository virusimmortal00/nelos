import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  selectImpactedCompatibilityContractsV1,
  validateCompatibilityRegistryV1,
  validateCompatibilityReportV1,
} from "../src/compatibility-contract-registry.mjs";
import {
  runOfflineCompatibilityGate,
} from "../src/offline-compatibility-gate.mjs";
import {
  runSemanticAdvisoryV1,
  semanticAdvisoryEvidenceDigestV1,
} from "../src/semantic-advisory-runner.mjs";
import {
  adaptUpstreamDocumentationObservationV1,
  collectUpstreamDocumentationEvidenceV1,
} from "../src/upstream-documentation-evidence.mjs";
import {
  collectUpstreamSourceEvidenceV1,
} from "../src/upstream-source-collector.mjs";
import {
  collectGeneratedSchemaEvidenceV1,
  collectRuntimeLiveEvidenceV1,
  collectRuntimeTransportEvidenceV1,
  concludeWireCompatibilityV1,
} from "../src/wire-compatibility-collector.mjs";

const execFileAsync = promisify(execFile);
const OBSERVED_AT = "2026-07-29T12:00:00.000Z";
const UPSTREAM_URL = "https://github.com/example/codex-fixture";
const UPSTREAM_PATH = "protocol/app-server.json";

async function git(args, options = {}) {
  return execFileAsync("git", args, {
    ...options,
    encoding: options.encoding ?? "utf8",
  });
}

function mappings({
  owned = [],
  shared = [],
  tests = [],
  documentation = [],
  generatedSchema = [],
  upstreamDocumentation = [],
  upstreamSource = [],
  runtime = [],
  checks = [],
} = {}) {
  return {
    owned,
    shared,
    test: tests,
    documentation,
    generatedSchema,
    upstreamDocumentation,
    upstreamSource,
    runtime,
    checks,
  };
}

async function createFakeUpstream(root) {
  const work = join(root, "upstream-work");
  const remote = join(root, "upstream.git");
  await mkdir(join(work, "protocol"), { recursive: true });
  await git(["init", "--quiet", "-b", "main", work]);
  await git(["-C", work, "config", "user.name", "Compatibility Fixture"]);
  await git([
    "-C",
    work,
    "config",
    "user.email",
    "compatibility@example.test",
  ]);
  await writeFile(
    join(work, UPSTREAM_PATH),
    `${JSON.stringify({ method: "thread/list", stable: true })}\n`,
  );
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "--quiet", "-m", "exact release"]);
  const releaseSha = (
    await git(["-C", work, "rev-parse", "HEAD"])
  ).stdout.trim();
  await git(["-C", work, "tag", "-a", "v9.8.7", "-m", "exact release"]);
  await writeFile(
    join(work, UPSTREAM_PATH),
    `${JSON.stringify({ method: "thread/list", stable: false })}\n`,
  );
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "--quiet", "-m", "floating drift"]);
  await git(["init", "--quiet", "--bare", remote]);
  await git(["-C", work, "remote", "add", "fixture", remote]);
  await git(["-C", work, "push", "--quiet", "fixture", "main", "v9.8.7"]);
  return { releaseSha, remote };
}

async function createFixture(t) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "nelos-compatibility-rollout-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repository = join(temporaryRoot, "repository");
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(join(repository, "test/fixtures"), { recursive: true });
  await mkdir(join(repository, "docs"), { recursive: true });
  await mkdir(join(repository, "bin"), { recursive: true });

  const generatedFixture = {
    codexIdentity: { version: "9.8.7", commitSha: null },
    methods: {
      "thread/read": { readOnly: true },
      "thread/turns/list": { readOnly: true },
    },
  };
  const fakeCodex = join(repository, "bin/fake-codex");
  await Promise.all([
    writeFile(join(repository, "src/contract.mjs"), "export const stable = true;\n"),
    writeFile(join(repository, "README.md"), "Supported Codex: 9.8.7\n"),
    writeFile(
      join(repository, "docs/contract.md"),
      "Compatibility contract for Codex 9.8.7\n",
    ),
    writeFile(
      join(repository, "docs/official-fixture.txt"),
      "Official fixture: thread/list is available.\n",
    ),
    writeFile(
      join(repository, "test/fixtures/generated.json"),
      `${JSON.stringify(generatedFixture)}\n`,
    ),
    writeFile(
      join(repository, "test/fixtures/claims.json"),
      `${JSON.stringify({
        testedCodexVersions: ["9.8.7"],
        initialize: { experimentalApi: true },
        methods: { "thread/list": {} },
      })}\n`,
    ),
    writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 9.8.7\\n");
  process.exit(0);
}
if (args.join(" ") === "app-server generate-json-schema --experimental") {
  process.stdout.write(${JSON.stringify(`${JSON.stringify(generatedFixture)}\n`)});
  process.exit(0);
}
if (args.join(" ") !== "app-server --stdio") process.exit(64);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const result = request.method === "initialize"
      ? { userAgent: "codex-cli/9.8.7" }
      : { data: [], nextCursor: null };
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  }
});
`,
    ),
  ]);
  await chmod(fakeCodex, 0o755);
  const upstream = await createFakeUpstream(temporaryRoot);

  const checks = [
    {
      id: "repo.contract",
      evidenceKind: "deterministic-repo",
      command: "validate fixture contract",
      source: "src/contract.mjs",
    },
    {
      id: "docs.official",
      evidenceKind: "upstream-docs",
      command: "collect local official documentation fixture",
      source: "https://docs.example.test/app-server",
    },
    {
      id: "source.exact",
      evidenceKind: "upstream-open-source",
      command: "collect exact source fixture",
      source: `${UPSTREAM_URL}#${UPSTREAM_PATH}`,
    },
    {
      id: "schema.generated",
      evidenceKind: "generated-schema",
      command: "collect generated schema fixture",
      source: "test/fixtures/generated.json",
    },
    {
      id: "runtime.transport",
      evidenceKind: "runtime-transport",
      command: "collect fake stdio transport",
      source: "fixture:stdio-jsonl",
    },
    {
      id: "runtime.live",
      evidenceKind: "runtime-live",
      command: "collect explicit mock live probe",
      source: "fixture:trusted-live",
    },
    {
      id: "semantic.review",
      evidenceKind: "semantic-advisory",
      command: "run fake semantic provider",
      source: "fixture:semantic-provider",
    },
  ];
  const registry = {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    supportedCodexReleases: [{
      id: "codex@9.8.7",
      version: "9.8.7",
      fixture: "test/fixtures/claims.json",
      upstreamSourceRefs: [{
        repository: UPSTREAM_URL,
        requestedRef: "refs/tags/v9.8.7",
        commitSha: upstream.releaseSha,
      }],
    }],
    checks,
    capabilities: [
      {
        id: "fixture.protocol",
        title: "Fixture protocol",
        dependsOn: [],
        globalInvariant: false,
        supportedCodexReleases: ["codex@9.8.7"],
        mappings: mappings({
          owned: ["src/contract.mjs"],
          tests: ["test/fixtures/generated.json"],
          documentation: ["docs/contract.md"],
          generatedSchema: ["test/fixtures/generated.json"],
          upstreamDocumentation: ["https://docs.example.test/app-server"],
          upstreamSource: [{
            repository: UPSTREAM_URL,
            paths: [UPSTREAM_PATH],
            artifacts: [],
            advisoryRef: "refs/heads/main",
          }],
          runtime: ["fixture:stdio-jsonl", "fixture:trusted-live"],
          checks: checks.map(({ id }) => id),
        }),
      },
      {
        id: "fixture.global",
        title: "Fixture global invariant",
        dependsOn: ["fixture.protocol"],
        globalInvariant: true,
        supportedCodexReleases: [],
        mappings: mappings({
          shared: ["src/contract.mjs"],
          checks: ["repo.contract"],
        }),
      },
    ],
  };
  validateCompatibilityRegistryV1(registry);

  await git(["init", "--quiet", "-b", "main", repository]);
  await git(["-C", repository, "config", "user.name", "Compatibility Fixture"]);
  await git([
    "-C",
    repository,
    "config",
    "user.email",
    "compatibility@example.test",
  ]);
  await git(["-C", repository, "add", "."]);
  await git(["-C", repository, "commit", "--quiet", "-m", "tracked claims"]);
  return { fakeCodex, registry, repository, ...upstream };
}

function normalizedEvidence(check, outcome, summary, extra = {}) {
  return {
    checkId: check.id,
    kind: check.evidenceKind,
    outcome,
    countsForCompatibility: outcome === "passed",
    source: check.source,
    summary,
    ...extra,
  };
}

test("offline end-to-end rollout covers every evidence lane without mutating claims", async (t) => {
  const fixture = await createFixture(t);
  const before = (
    await git(["-C", fixture.repository, "status", "--porcelain=v1"])
  ).stdout;
  assert.equal(before, "");

  const selection = selectImpactedCompatibilityContractsV1(
    fixture.registry,
    [{ status: "renamed", oldPath: "src/contract.mjs", newPath: "src/next.mjs" }],
  );
  assert.equal(selection.ok, false);
  assert.deepEqual(selection.selectedCapabilityIds, [
    "fixture.protocol",
    "fixture.global",
  ]);
  assert.deepEqual(selection.unmappedSensitivePaths, ["src/next.mjs"]);
  assert.deepEqual(selection.pathSelections, [
    { path: "src/contract.mjs", capabilityIds: ["fixture.protocol", "fixture.global"] },
    { path: "src/next.mjs", capabilityIds: [] },
  ]);

  const checkById = new Map(
    fixture.registry.checks.map((check) => [check.id, check]),
  );
  const gate = await runOfflineCompatibilityGate({
    root: fixture.repository,
    registry: fixture.registry,
    changes: [{ status: "modified", path: "src/contract.mjs" }],
    checkRunners: new Map([
      ["repo.contract", async () => "tracked fixture contract passed"],
      ["schema.generated", async () => "tracked schema fixture passed"],
    ]),
  });
  assert.equal(gate.exitCode, 0);
  assert.equal(gate.report.overallStatus, "unverified");
  assert.equal(
    gate.report.capabilities
      .flatMap(({ evidence }) => evidence)
      .find(({ checkId }) => checkId === "docs.official").outcome,
    "unavailable",
  );

  const documentation = await collectUpstreamDocumentationEvidenceV1(
    {
      schemaVersion: 1,
      id: "docs.official",
      evidenceKind: "upstream-docs",
      official: true,
      requestedUrl: "https://docs.example.test/app-server",
      selection: {
        kind: "artifact",
        name: "local-official-fixture",
        maxBytes: 1_024,
        contentTypes: ["text/plain"],
      },
      timeoutMs: 100,
      redirectPolicy: "reject",
    },
    {
      now: () => OBSERVED_AT,
      fetchImpl: async (url) => {
        assert.equal(url, "https://docs.example.test/app-server");
        const body = await readFile(
          join(fixture.repository, "docs/official-fixture.txt"),
        );
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    },
  );
  const documentationEvidence = adaptUpstreamDocumentationObservationV1(
    documentation,
    { checkId: "docs.official" },
  );
  assert.equal(documentationEvidence.outcome, "passed");

  const exactSource = await collectUpstreamSourceEvidenceV1(
    fixture.registry,
    {
      capabilityId: "fixture.protocol",
      repositoryUrl: UPSTREAM_URL,
      evidenceRef: { kind: "supported-release", releaseId: "codex@9.8.7" },
      selectedPaths: [UPSTREAM_PATH],
      selectedArtifacts: [],
    },
    {
      now: () => new Date(OBSERVED_AT),
      resolveRemote: () => fixture.remote,
    },
  );
  assert.equal(exactSource.outcome, "evidence");
  assert.equal(exactSource.commitSha, fixture.releaseSha);

  const floatingSource = await collectUpstreamSourceEvidenceV1(
    fixture.registry,
    {
      capabilityId: "fixture.protocol",
      repositoryUrl: UPSTREAM_URL,
      evidenceRef: { kind: "floating-main" },
      selectedPaths: [UPSTREAM_PATH],
      selectedArtifacts: [],
    },
    {
      now: () => new Date(OBSERVED_AT),
      resolveRemote: () => fixture.remote,
    },
  );
  assert.equal(floatingSource.classification, "early-warning-advisory");
  assert.equal(floatingSource.countsForCompatibility, false);
  assert.match(floatingSource.limitations.join(" "), /Desktop/u);
  assert.match(floatingSource.limitations.join(" "), /rollout/u);

  const generated = await collectGeneratedSchemaEvidenceV1({
    root: fixture.repository,
    now: () => new Date(OBSERVED_AT),
    declaration: {
      checkId: "schema.generated",
      expectedCodexIdentities: [{ version: "9.8.7", commitSha: null }],
      identityCommand: { executable: fixture.fakeCodex, args: ["--version"] },
      command: {
        executable: fixture.fakeCodex,
        args: ["app-server", "generate-json-schema", "--experimental"],
      },
    },
  });
  assert.equal(generated.outcome, "passed");

  const runtime = await collectRuntimeTransportEvidenceV1({
    now: () => new Date(OBSERVED_AT),
    declaration: {
      checkId: "runtime.transport",
      executable: fixture.fakeCodex,
      transport: "stdio-jsonl",
      expectedCodexIdentities: [{ version: "9.8.7", commitSha: null }],
      operations: [{
        method: "thread/list",
        params: { archived: false, limit: 1 },
        readOnly: true,
      }],
    },
  });
  assert.equal(runtime.outcome, "passed");

  const mockMethods = [];
  const live = await collectRuntimeLiveEvidenceV1({
    enabled: true,
    now: () => new Date(OBSERVED_AT),
    declaration: {
      checkId: "runtime.live",
      transport: "stdio-jsonl",
      expectedCodexIdentities: [{ version: "9.8.7", commitSha: null }],
      operations: [{
        method: "thread/read",
        params: { threadId: "fixture-thread", includeTurns: false },
        readOnly: true,
      }],
    },
    transportFactory: async () => ({
      async request(method) {
        mockMethods.push(method);
        return method === "initialize"
          ? { userAgent: "codex-cli/9.8.7" }
          : { thread: { id: "fixture-thread" } };
      },
      async close() {},
    }),
  });
  assert.equal(live.outcome, "passed");
  assert.deepEqual(mockMethods, ["initialize", "thread/read"]);

  const evidence = [
    normalizedEvidence(
      checkById.get("repo.contract"),
      "passed",
      "tracked fixture contract passed",
    ),
    {
      ...documentationEvidence,
      source: checkById.get("docs.official").source,
    },
    normalizedEvidence(
      checkById.get("source.exact"),
      "passed",
      exactSource.reason ?? "exact-ref source evidence collected",
    ),
    normalizedEvidence(
      checkById.get("schema.generated"),
      generated.outcome,
      generated.summary,
    ),
    normalizedEvidence(
      checkById.get("runtime.transport"),
      runtime.outcome,
      runtime.summary,
    ),
    normalizedEvidence(
      checkById.get("runtime.live"),
      live.outcome,
      live.summary,
    ),
    normalizedEvidence(
      checkById.get("semantic.review"),
      "unavailable",
      "semantic findings are separate advisory output",
    ),
  ];
  const completeReport = {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    overallStatus: "unverified",
    capabilities: [
      {
        capabilityId: "fixture.protocol",
        status: "unverified",
        evidence,
      },
      {
        capabilityId: "fixture.global",
        status: "compatible",
        evidence: [evidence[0]],
      },
    ],
  };
  assert.equal(
    validateCompatibilityReportV1(fixture.registry, completeReport),
    completeReport,
  );
  assert.deepEqual(
    [...new Set(evidence.map(({ kind }) => kind))].sort(),
    [
      "deterministic-repo",
      "generated-schema",
      "runtime-live",
      "runtime-transport",
      "semantic-advisory",
      "upstream-docs",
      "upstream-open-source",
    ],
  );

  const deterministicRegistry = structuredClone(fixture.registry);
  deterministicRegistry.checks = [checkById.get("repo.contract")];
  deterministicRegistry.capabilities = [{
    id: "fixture.protocol",
    title: "Fixture protocol",
    dependsOn: [],
    globalInvariant: true,
    supportedCodexReleases: [],
    mappings: mappings({
      owned: ["src/contract.mjs"],
      checks: ["repo.contract"],
    }),
  }];
  const deterministicReport = {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    overallStatus: "compatible",
    capabilities: [{
      capabilityId: "fixture.protocol",
      status: "compatible",
      evidence: [evidence[0]],
    }],
  };
  const semanticContent = "Deterministic fixture says compatible.";
  const semantic = await runSemanticAdvisoryV1({
    optIn: true,
    registry: deterministicRegistry,
    deterministicReport,
    selectedEvidence: [{
      contractId: "fixture.protocol",
      checkId: "repo.contract",
      digest: semanticAdvisoryEvidenceDigestV1(semanticContent),
      content: semanticContent,
    }],
    providerConfiguration: {
      providerId: "fixture-provider",
      model: "fixture-model",
      credentialId: "fixture-credential",
      timeoutMs: 100,
    },
    provider: {
      async compare() {
        return {
          schemaVersion: 1,
          findings: [{
            contractId: "fixture.protocol",
            evidenceRefs: ["repo.contract"],
            severity: "warning",
            summary: "Advisory review disagrees with the deterministic status.",
          }],
        };
      },
    },
    now: () => OBSERVED_AT,
  });
  assert.equal(semantic.status, "completed");
  assert.equal(semantic.countsForCompatibility, false);
  assert.equal(semantic.deterministicStatus.overallStatus, "compatible");
  assert.equal(semantic.findings[0].authority, "advisory-only");

  const after = (
    await git(["-C", fixture.repository, "status", "--porcelain=v1"])
  ).stdout;
  assert.equal(
    after,
    before,
    "collectors must not modify tracked claims, fixtures, versions, code, or docs",
  );
});

test("collector infrastructure failures never become positive evidence", async (t) => {
  const fixture = await createFixture(t);
  const unavailableSchema = await collectGeneratedSchemaEvidenceV1({
    root: fixture.repository,
    now: () => new Date(OBSERVED_AT),
    declaration: {
      checkId: "schema.generated",
      expectedCodexIdentities: [{ version: "9.8.7", commitSha: null }],
      artifact: { path: "test/fixtures/missing.json" },
    },
  });
  const unavailableRuntime = await collectRuntimeTransportEvidenceV1({
    now: () => new Date(OBSERVED_AT),
    declaration: {
      checkId: "runtime.transport",
      transport: "stdio-jsonl",
      expectedCodexIdentities: [{ version: "9.8.7", commitSha: null }],
      operations: [],
    },
    transportFactory: async () => ({
      async request() {
        const error = new Error("fixture transport unavailable");
        error.code = "ECONNREFUSED";
        throw error;
      },
      async close() {},
    }),
  });
  for (const report of [unavailableSchema, unavailableRuntime]) {
    assert.equal(report.outcome, "infrastructure-failure");
    assert.equal(report.countsForCompatibility, false);
    assert.equal(report.digest, null);
  }

  const passed = {
    schemaVersion: 1,
    checkId: "schema.generated",
    evidenceKind: "generated-schema",
    outcome: "passed",
    countsForCompatibility: true,
    authority: "decisive-wire-evidence",
    expectedCodexIdentities: [{ version: "9.8.7", commitSha: null }],
    observedCodexIdentity: { version: "9.8.7", commitSha: null },
    provenance: { mode: "fixture" },
    digest: `sha256:${createHash("sha256").update("passed").digest("hex")}`,
    observedAt: OBSERVED_AT,
    observations: [],
    failure: null,
    limitations: [],
    summary: "fixture pass",
  };
  const conclusion = concludeWireCompatibilityV1({
    generatedSchema: [passed, unavailableSchema],
    runtimeTransport: [unavailableRuntime],
    implementationSource: [{ outcome: "advisory", countsForCompatibility: false }],
  });
  assert.equal(conclusion.status, "compatible");
  assert.equal(
    conclusion.decisiveEvidence.filter(({ countsForCompatibility }) =>
      countsForCompatibility).length,
    1,
  );
  assert.equal(
    conclusion.advisoryImplementationSource[0].countsForCompatibility,
    false,
  );
});
