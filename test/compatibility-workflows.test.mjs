import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveRequiredCompatibilityRange,
} from "../scripts/run-required-compatibility.mjs";
import {
  parseRuntimeTransportArgs,
} from "../scripts/collect-runtime-transport.mjs";
import {
  main as verifyReleaseEvidence,
} from "../scripts/verify-release-compatibility-evidence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

async function text(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("required compatibility script resolves the real merge base", async () => {
  const calls = [];
  const range = await resolveRequiredCompatibilityRange({
    baseRef: "origin/review-base",
    head: "review-head",
    cwd: root,
    runGit: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: `${"a".repeat(40)}\n` };
    },
  });
  assert.deepEqual(range, {
    base: "a".repeat(40),
    baseRef: "origin/review-base",
    head: "review-head",
  });
  assert.deepEqual(calls[0].args, [
    "merge-base",
    "--",
    "origin/review-base",
    "review-head",
  ]);
});

test("required PR job is token-free, offline, and isolated from advisory lanes", async () => {
  const workflow = await text("../.github/workflows/verify.yml");
  const packageJson = JSON.parse(await text("../package.json"));
  assert.match(workflow, /pull_request:/u);
  assert.match(
    workflow,
    /name: Compatibility \/ required offline deterministic/u,
  );
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(
    workflow,
    /env -u OPENAI_API_KEY npm run compatibility:required/u,
  );
  assert.equal(
    packageJson.scripts["compatibility:required"],
    "NODE_OPTIONS=--require=./scripts/offline-network-blocker.cjs node scripts/run-required-compatibility.mjs",
  );
  assert.equal(packageJson.scripts.compatibility, "npm run compatibility:required");
  const requiredJob = workflow.slice(
    workflow.indexOf("  compatibility-required:"),
    workflow.indexOf("\n  node:"),
  );
  for (const forbidden of [
    "OPENAI_API_KEY:",
    "semantic",
    "verify:app-server:live",
    "collect-runtime-transport",
    "collect-compatibility-evidence",
    "curl ",
    "npx ",
  ]) {
    assert.equal(requiredJob.includes(forbidden), false, forbidden);
  }
});

test("drift lanes are scheduled/manual, bounded, and preserve unavailable reports", async () => {
  const workflow = await text("../.github/workflows/compatibility-drift.yml");
  assert.match(workflow, /schedule:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /\n  push:/u);
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /compatibility:drift:docs/u);
  assert.match(workflow, /compatibility:drift:source/u);
  assert.match(workflow, /--lane source-release/u);
  assert.match(workflow, /--lane schema/u);
  assert.match(workflow, /collect-runtime-transport\.mjs/u);
  assert.match(workflow, /--expected-version/u);
  assert.ok((workflow.match(/continue-on-error: true/gu) ?? []).length >= 5);
  assert.ok((workflow.match(/if: always\(\)/gu) ?? []).length >= 2);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/u);
});

test("release evidence binds exact source, schema, and runtime identities", async () => {
  const workflow = await text("../.github/workflows/release.yml");
  assert.match(workflow, /compatibility-exact:/u);
  assert.match(workflow, /codex: \["0\.144\.5", "0\.144\.6"\]/u);
  assert.match(workflow, /--lane source-release/u);
  assert.match(workflow, /--lane schema/u);
  assert.match(workflow, /--expected-version/u);
  assert.match(workflow, /verify-release-compatibility-evidence\.mjs/u);
  assert.match(workflow, /needs: \[verify, compatibility-exact\]/u);
  assert.match(workflow, /Upload exact release evidence[\s\S]*if: always\(\)/u);
});

test("live and semantic work is manual, optional, trusted, and advisory-only", async () => {
  const advisory = await text(
    "../.github/workflows/compatibility-advisory.yml",
  );
  assert.match(advisory, /workflow_dispatch:/u);
  assert.doesNotMatch(advisory, /pull_request:|schedule:|\n  push:/u);
  assert.match(advisory, /if: inputs\.run_live/u);
  assert.match(advisory, /if: inputs\.run_semantic/u);
  assert.equal(
    (advisory.match(/environment: compatibility-advisory/gu) ?? []).length,
    2,
  );
  assert.equal(
    (advisory.match(/continue-on-error: true/gu) ?? []).length,
    2,
  );
  assert.match(advisory, /npm run verify:app-server:live/u);
  assert.match(advisory, /compatibility:semantic-advisory/u);
  assert.doesNotMatch(advisory, /compatibility:required/u);
});

test("compatibility workflows never edit checked-in claims or source", async () => {
  const workflows = await Promise.all([
    text("../.github/workflows/verify.yml"),
    text("../.github/workflows/compatibility-drift.yml"),
    text("../.github/workflows/compatibility-advisory.yml"),
    text("../.github/workflows/release.yml"),
  ]);
  const compatibilityCommands = workflows.join("\n");
  for (const forbidden of [
    "git commit",
    "git push",
    "git add",
    "sed -i",
    "supportedCodexReleases.push",
    "test/fixtures/mcp-app-server-protocol-v0.144.x.json >",
  ]) {
    assert.equal(compatibilityCommands.includes(forbidden), false, forbidden);
  }
});

test("runtime collector accepts one exact expected version", () => {
  const options = parseRuntimeTransportArgs([
    "--codex",
    "/tmp/codex",
    "--expected-version",
    "0.144.6",
  ]);
  assert.equal(options.expectedVersion, "0.144.6");
  assert.throws(
    () => parseRuntimeTransportArgs(["--expected-version", "main"]),
    /exact stable version/u,
  );
});

test("release verifier rejects a mismatched exact ref", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nelos-release-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.json");
  const schemaPath = join(directory, "schema.json");
  const runtimePath = join(directory, "runtime.json");
  const outputPath = join(directory, "bundle.json");
  const source = {
    releaseId: "codex@0.144.5",
    countsForCompatibility: true,
    reports: [{
      outcome: "evidence",
      requestedRef: "refs/tags/rust-v0.144.5",
      commitSha: "87db9bc18ba5bc82c1cb4e4381b44f693ee35623",
    }],
  };
  const schema = {
    releaseId: "codex@0.144.5",
    outcome: "passed",
    observedCodexIdentity: { version: "0.144.5" },
  };
  const runtime = {
    outcome: "passed",
    expectedCodexIdentities: [{ version: "0.144.5" }],
    observedCodexIdentity: { version: "0.144.5" },
  };
  await Promise.all([
    writeFile(sourcePath, JSON.stringify(source)),
    writeFile(schemaPath, JSON.stringify(schema)),
    writeFile(runtimePath, JSON.stringify(runtime)),
  ]);
  await verifyReleaseEvidence([
    "--release-id",
    "codex@0.144.5",
    "--source",
    sourcePath,
    "--schema",
    schemaPath,
    "--runtime",
    runtimePath,
    "--out",
    outputPath,
  ]);
  const bundle = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(bundle.countsForCompatibility, true);
  source.reports[0].commitSha = "1".repeat(40);
  await writeFile(sourcePath, JSON.stringify(source));
  await assert.rejects(
    verifyReleaseEvidence([
      "--release-id",
      "codex@0.144.5",
      "--source",
      sourcePath,
      "--schema",
      schemaPath,
      "--runtime",
      runtimePath,
      "--out",
      outputPath,
    ]),
    /unresolved, mismatched, or unavailable/u,
  );
});
