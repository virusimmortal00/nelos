import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  bindReleaseCanary,
  deterministicShard,
  EXPERIMENT_CI_LANES,
  regenerateEvidenceReport,
  runBudgetedShard,
  validateCacheEntries,
  verifyShardFamily,
} from "../src/experiment-ci-gates.mjs";

const exec = promisify(execFile);
const D = (character) => `sha256:${character.repeat(64)}`;

test("lane contracts bound PR smoke and reserve dedicated Desktop execution", () => {
  assert.deepEqual({ tasks: EXPERIMENT_CI_LANES.smoke.taskBudget, repetitions: EXPERIMENT_CI_LANES.smoke.repetitions, concurrency: EXPERIMENT_CI_LANES.smoke.maxConcurrency }, { tasks: 1, repetitions: 1, concurrency: 1 });
  assert.equal(EXPERIMENT_CI_LANES.smoke.isolatedHomes, true);
  assert.equal(EXPERIMENT_CI_LANES.offline.credentials, "none");
  assert.equal(EXPERIMENT_CI_LANES.offline.network, "none");
  assert.equal(EXPERIMENT_CI_LANES.desktop.maxConcurrency, 1);
});

test("nightly and powered shards are deterministic, disjoint, and identity complete", () => {
  const trials = Array.from({ length: 73 }, (_, index) => ({ trialId: `trial:${String(index).padStart(4, "0")}` }));
  for (const count of [EXPERIMENT_CI_LANES.regression.shardCount, EXPERIMENT_CI_LANES.powered.shardCount]) {
    const shards = Array.from({ length: count }, (_, index) => deterministicShard(trials, { index, count }));
    assert.deepEqual(Array.from({ length: count }, (_, index) => deterministicShard(trials, { index, count })), shards);
    assert.equal(verifyShardFamily(trials, shards).trialCount, trials.length);
  }
  assert.throws(() => deterministicShard([...trials, trials[0]], { index: 0, count: 2 }), /globally unique/u);
});

test("cache and release provenance contracts reject mutable or incomplete inputs", () => {
  assert.equal(validateCacheEntries([{ kind: "image", digest: D("a"), readOnly: true }]).length, 1);
  assert.throws(() => validateCacheEntries([{ kind: "trial-state", digest: D("a"), readOnly: true }]), /only digest-bound/u);
  const releaseEvidence = { codexVersion: "0.144.6", pluginVersion: "0.10.0", sourceCommit: "1".repeat(40), pluginDigest: D("1"), runtimeLockDigest: D("2"), schemaDigest: D("3"), compatibilityDigest: D("4") };
  const bound = bindReleaseCanary(releaseEvidence);
  assert.match(bound.canaryDigest, /^sha256:/u);
  assert.throws(() => bindReleaseCanary({ ...releaseEvidence, schemaDigest: "floating" }), /invalid schemaDigest/u);
});

test("budgets stop new starts while completed and interrupted evidence survives", async () => {
  const trials = [1, 2, 3].map((number) => ({ trialId: `trial:${number}` }));
  const completed = [{ trialId: "trial:1", outcome: "succeeded", cost: 1 }];
  const run = await runBudgetedShard({ trials, completed, budget: { maxStarts: 1, maxCost: 1 }, execute: async ({ trialId }) => ({ trialId, outcome: "interrupted", cost: 1 }) });
  assert.deepEqual(run.evidence.map(({ trialId }) => trialId), ["trial:1", "trial:2"]);
  assert.equal(run.stoppedReason, "interrupted");
  assert.deepEqual(run.pendingTrialIds, ["trial:3"]);
});

test("end-to-end offline fixtures cover terminal semantics and deterministic regeneration", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nelos-ci-gates-"));
  const script = resolve("scripts/run-experiment-ci-gate.mjs");
  const scenarios = ["success", "regression", "outage", "interruption", "incompatible-provenance", "report-regeneration"];
  for (const scenario of scenarios) {
    await exec(process.execPath, [script, "--lane", "smoke", "--scenario", scenario, "--out", root], {
      env: { ...process.env, NODE_OPTIONS: "--require=./scripts/offline-network-blocker.cjs", OPENAI_API_KEY: "" },
    });
    const record = JSON.parse(await readFile(resolve(root, `smoke-0-${scenario}.json`), "utf8"));
    if (scenario === "outage") assert.equal(record.report.productDecision, null);
    if (scenario === "regression") assert.equal(record.report.productDecision, "regression");
    if (scenario === "report-regeneration") assert.equal(regenerateEvidenceReport(record.execution.evidence).reportDigest, record.report.reportDigest);
  }
});

test("workflow family retains every terminal class and fences Desktop to labeled macOS workers", async () => {
  const workflow = await readFile(new URL("../.github/workflows/experiment-ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /runs-on: \[self-hosted, macOS, nelos-dedicated-desktop\]/u);
  assert.match(workflow, /NODE_OPTIONS: --require=.\/scripts\/offline-network-blocker\.cjs/u);
  assert.match(workflow, /CODEX_HOME: \$\{\{ runner\.temp \}\}\/nelos-codex-home-/u);
  assert.match(workflow, /retention-days: 30/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.doesNotMatch(workflow, /actions\/cache/u);
  for (const terminal of ["succeeded", "regression", "failed", "invalid", "inconclusive", "infrastructure-failure", "interrupted", "incompatible-provenance"]) assert.match(workflow, new RegExp(terminal, "u"));
});
