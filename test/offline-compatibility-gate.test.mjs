import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  OfflineCompatibilityCheckFailure,
  deriveCompatibilityChanges,
  runOfflineCompatibilityGate,
} from "../src/offline-compatibility-gate.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(
  new URL("../bin/nelos-compatibility", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function mappings({
  owned = [],
  testPaths = [],
  checks = [],
} = {}) {
  return {
    owned,
    shared: [],
    test: testPaths,
    documentation: [],
    generatedSchema: [],
    upstreamDocumentation: [],
    upstreamSource: [],
    runtime: [],
    checks,
  };
}

function testRegistry() {
  return {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    supportedCodexReleases: [],
    checks: [
      {
        id: "check.base",
        evidenceKind: "deterministic-repo",
        command: "base fixture check",
        source: "test/base.test.mjs",
      },
      {
        id: "check.dependent",
        evidenceKind: "deterministic-repo",
        command: "dependent fixture check",
        source: "test/dependent.test.mjs",
      },
      {
        id: "check.global",
        evidenceKind: "deterministic-repo",
        command: "global fixture check",
        source: "test/global.test.mjs",
      },
    ],
    capabilities: [
      {
        id: "base",
        title: "Base",
        dependsOn: [],
        globalInvariant: false,
        supportedCodexReleases: [],
        mappings: mappings({
          owned: ["src/base.mjs", "src/legacy.mjs"],
          checks: ["check.base"],
        }),
      },
      {
        id: "dependent",
        title: "Dependent",
        dependsOn: ["base"],
        globalInvariant: false,
        supportedCodexReleases: [],
        mappings: mappings({
          owned: ["src/dependent.mjs"],
          checks: ["check.dependent"],
        }),
      },
      {
        id: "global",
        title: "Global",
        dependsOn: [],
        globalInvariant: true,
        supportedCodexReleases: [],
        mappings: mappings({ checks: ["check.global"] }),
      },
    ],
  };
}

function passingRunners(observed = []) {
  return new Map(
    ["check.base", "check.dependent", "check.global"].map((checkId) => [
      checkId,
      async () => {
        observed.push(checkId);
        return `${checkId} passed`;
      },
    ]),
  );
}

test("empty changes run only global invariants", async () => {
  const observed = [];
  const result = await runOfflineCompatibilityGate({
    root: "/fixture",
    registry: testRegistry(),
    changes: [],
    checkRunners: passingRunners(observed),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.selection.selectedCapabilityIds, ["global"]);
  assert.deepEqual(observed, ["check.global"]);
  assert.equal(result.report.overallStatus, "compatible");
});

test("direct changes select transitive dependents plus globals deterministically", async () => {
  const observed = [];
  const result = await runOfflineCompatibilityGate({
    root: "/fixture",
    registry: testRegistry(),
    changes: [{ status: "modified", path: "src/base.mjs" }],
    checkRunners: passingRunners(observed),
  });
  assert.deepEqual(result.selection.selectedCapabilityIds, [
    "base",
    "dependent",
    "global",
  ]);
  assert.deepEqual(observed, [
    "check.base",
    "check.dependent",
    "check.global",
  ]);
  assert.deepEqual(
    result.report.capabilities.map(({ capabilityId }) => capabilityId),
    ["base", "dependent", "global"],
  );
});

test("rename and deletion records preserve old-path selection", async () => {
  const rename = await deriveCompatibilityChanges({
    root: "/fixture",
    execGit: async () => ({
      stdout: "R100\0src/legacy.mjs\0src/base.mjs\0D\0src/dependent.mjs\0",
    }),
  });
  assert.deepEqual(rename, [
    {
      status: "renamed",
      oldPath: "src/legacy.mjs",
      newPath: "src/base.mjs",
    },
    { status: "deleted", path: "src/dependent.mjs" },
  ]);
  const result = await runOfflineCompatibilityGate({
    root: "/fixture",
    registry: testRegistry(),
    changes: rename,
    checkRunners: passingRunners(),
  });
  assert.deepEqual(result.selection.selectedCapabilityIds, [
    "base",
    "dependent",
    "global",
  ]);
});

test("unmapped sensitive paths and deterministic failures propagate stable exit status", async () => {
  const registry = testRegistry();
  const failing = passingRunners();
  failing.set("check.global", async () => {
    throw new OfflineCompatibilityCheckFailure("fixture mismatch");
  });
  const result = await runOfflineCompatibilityGate({
    root: "/fixture",
    registry,
    changes: [{ status: "added", path: "src/unmapped.mjs" }],
    checkRunners: failing,
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.selection.unmappedSensitivePaths, ["src/unmapped.mjs"]);
  assert.equal(result.report.overallStatus, "incompatible");
  assert.equal(
    result.report.capabilities[0].evidence[0].countsForCompatibility,
    false,
  );
});

test("runner infrastructure failures are unavailable evidence and exit 2", async () => {
  const runners = passingRunners();
  runners.set("check.global", async () => {
    throw new Error("fixture infrastructure unavailable");
  });
  const result = await runOfflineCompatibilityGate({
    root: "/fixture",
    registry: testRegistry(),
    changes: [],
    checkRunners: runners,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.overallStatus, "unverified");
  assert.equal(
    result.report.capabilities[0].evidence[0].outcome,
    "infrastructure-failure",
  );
  assert.equal(
    result.report.capabilities[0].evidence[0].countsForCompatibility,
    false,
  );
});

test("an empty capability selection is unverified", async () => {
  const registry = testRegistry();
  for (const capability of registry.capabilities) {
    capability.globalInvariant = false;
  }
  const result = await runOfflineCompatibilityGate({
    root: "/fixture",
    registry,
    changes: [],
    checkRunners: passingRunners(),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.overallStatus, "unverified");
  assert.deepEqual(result.report.capabilities, []);
});

test("invalid generated reports fail closed as infrastructure errors", async () => {
  const runners = passingRunners();
  runners.set("check.global", async () => ({ invalid: "summary" }));
  await assert.rejects(
    runOfflineCompatibilityGate({
      root: "/fixture",
      registry: testRegistry(),
      changes: [],
      checkRunners: runners,
    }),
    (error) => {
      assert.equal(error.code, "invalid-report");
      assert.match(error.message, /generated compatibility report is invalid/u);
      return true;
    },
  );
});

test("the default offline gate executes the experimentation contract evidence", async () => {
  const result = await runOfflineCompatibilityGate({
    root: repositoryRoot,
    changes: [{
      status: "added",
      path: "src/experimentation-contract/semantic-version.mjs",
    }],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.selection.ok, true);
  assert.deepEqual(result.selection.selectedCapabilityIds, [
    "nelos.experimentation-contracts",
    "nelos.lifecycle-invariants",
  ]);
  const experimentation = result.report.capabilities.find(
    ({ capabilityId }) => capabilityId === "nelos.experimentation-contracts",
  );
  assert.equal(experimentation.status, "compatible");
  assert.deepEqual(
    experimentation.evidence.map(({ checkId, outcome }) => ({ checkId, outcome })),
    [{ checkId: "repo.experimentation-contracts", outcome: "passed" }],
  );
});

test("retired Desktop code selects executable provider-neutral certification evidence", async () => {
  const result = await runOfflineCompatibilityGate({
    root: repositoryRoot,
    changes: [{ status: "deleted", path: "src/disposable-desktop-smoke.mjs" }],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.selection.ok, true);
  const certification = result.report.capabilities.find(
    ({ capabilityId }) => capabilityId === "nelos.desktop-certification",
  );
  assert.equal(certification.status, "compatible");
  assert.deepEqual(certification.evidence.map(({ checkId, outcome }) => ({ checkId, outcome })),
    [{ checkId: "repo.desktop-certification", outcome: "passed" }]);
});

test("CLI uses temporary registry fixtures and emits stable JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-offline-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    supportedCodexReleases: [],
    checks: [{
      id: "repo.registry-integrity",
      evidenceKind: "deterministic-repo",
      command: "validate fixture registry",
      source: "test/registry.json",
    }],
    capabilities: [{
      id: "global",
      title: "Global",
      dependsOn: [],
      globalInvariant: true,
      supportedCodexReleases: [],
      mappings: mappings({ checks: ["repo.registry-integrity"] }),
    }],
  };
  const registryPath = join(root, "registry.json");
  await writeFile(registryPath, `${JSON.stringify(registry)}\n`);

  const run = () => execFileAsync(
    process.execPath,
    [
      cliPath,
      "--root",
      root,
      "--registry",
      registryPath,
      "--file",
      "notes.txt",
    ],
    {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    },
  );
  const first = await run();
  const second = await run();
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.overallStatus, "compatible");
  assert.deepEqual(
    report.capabilities.map(({ capabilityId }) => capabilityId),
    ["global"],
  );
});

test("CLI malformed registry fixtures fail closed without compatibility evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-offline-gate-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryPath = join(root, "registry.json");
  await writeFile(registryPath, "{not-json\n");
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [cliPath, "--root", root, "--registry", registryPath, "--file", "notes.txt"],
      { encoding: "utf8", env: { LANG: "C", LC_ALL: "C", TZ: "UTC" } },
    ),
    (error) => {
      assert.equal(error.code, 2);
      const document = JSON.parse(error.stdout);
      assert.equal(document.status, "infrastructure-error");
      assert.equal(document.error.code, "malformed-registry");
      assert.equal(Object.hasOwn(document, "capabilities"), false);
      return true;
    },
  );
});
