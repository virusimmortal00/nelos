#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import {
  deterministicShard,
  EXPERIMENT_CI_LANES,
  laneContract,
  regenerateEvidenceReport,
  runBudgetedShard,
  validateCacheEntries,
  verifyShardFamily,
} from "../src/experiment-ci-gates.mjs";
import { canonicalBytes, canonicalDigest } from "../src/experimentation-contract/index.mjs";
import { parseCanonicalTask, transitionExperiment, transitionTask } from "../src/experimentation-contract/index.mjs";
import { expandExperimentPlan } from "../src/experiment-runner.mjs";
import { buildExperimentV1 } from "../test/fixtures/experimentation-contract/experiment-v1.mjs";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const lane = laneContract(option("--lane", "offline"));
const scenario = option("--scenario", "success");
const shardIndex = Number(option("--shard-index", "0"));
const shardCount = Number(option("--shard-count", String(lane.shardCount)));
const output = resolve(option("--out", "experiment-ci-evidence"));
let trials = [];
if (lane.name !== "offline") {
  const repetitions = Math.max(1, lane.repetitions);
  const experimentDraft = buildExperimentV1({
    design: {
      pairing: "task-seed-time-block",
      repetitions,
      seedRoot: `ci-${lane.name}-v1`,
      seedSchedule: Array.from({ length: repetitions }, (_, index) => ({ replicate: index + 1, seed: `ci-${lane.name}-${index + 1}` })),
      multiplicityFamily: "primary",
    },
  });
  const experiment = transitionExperiment(transitionExperiment(experimentDraft, "reviewed"), "sealed");
  const taskDraft = parseCanonicalTask(await readFile(resolve("test/fixtures/experimentation-contract/task-v1.json")));
  const task = transitionTask(transitionTask(taskDraft, "reviewed"), "sealed");
  const manifest = {
    schemaVersion: 1,
    experiment,
    tasks: [task],
    adapters: {
      "direct-codex": { command: ["ci-fixture-direct"], environment: {}, version: "ci-v1" },
      nelos: { command: ["ci-fixture-nelos"], environment: {}, version: "ci-v1" },
    },
    policy: { maxConcurrency: lane.maxConcurrency, perAdapterConcurrency: { "direct-codex": 1, nelos: 1 }, leaseMs: 60_000, timeoutMs: 60_000, maxAttempts: 1 },
  };
  trials = expandExperimentPlan(manifest).trials.map((trial) => ({ ...trial, ordinal: trial.ordinal }));
}
const shards = Array.from({ length: shardCount }, (_, index) => deterministicShard(trials, { index, count: shardCount }));
verifyShardFamily(trials, shards);
validateCacheEntries([{ kind: "fixture", digest: canonicalDigest({ lane: lane.name, fixture: "v1" }), readOnly: true }]);

const selected = shards[shardIndex] ?? (() => { throw new Error("shard index is outside the declared family"); })();
const outcomeFor = (ordinal) => {
  if (scenario === "success" || scenario === "report-regeneration") return "succeeded";
  if (scenario === "regression") return ordinal === 0 ? "regression" : "succeeded";
  if (scenario === "outage") return "infrastructure-failure";
  if (scenario === "interruption") return ordinal === 0 ? "succeeded" : "interrupted";
  if (scenario === "incompatible-provenance") return "incompatible-provenance";
  throw new Error(`unknown scenario: ${scenario}`);
};
const execution = await runBudgetedShard({
  trials: selected,
  budget: { maxStarts: lane.maxStarts, maxCost: lane.maxStarts },
  execute: async (trial) => ({ trialId: trial.trialId, outcome: outcomeFor(trial.ordinal), failureKind: scenario === "outage" ? "infrastructure" : null, cost: 1 }),
});
const report = regenerateEvidenceReport(execution.evidence);
if (scenario === "outage" && report.productDecision !== null) throw new Error("infrastructure outage was misreported as product evidence");
if (scenario === "report-regeneration" && regenerateEvidenceReport(execution.evidence).reportDigest !== report.reportDigest) throw new Error("report regeneration is not deterministic");
await mkdir(output, { recursive: true });
await writeFile(resolve(output, `${lane.name}-${shardIndex}-${scenario}.json`), canonicalBytes({ schemaVersion: 1, lane, shardIndex, shardCount, execution, report }));
process.stdout.write(`${JSON.stringify({ lane: lane.name, scenario, shardIndex, trialCount: selected.length, reportDigest: report.reportDigest })}\n`);

export { EXPERIMENT_CI_LANES };
