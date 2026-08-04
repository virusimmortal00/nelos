#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalBytes } from "../src/experimentation-contract/index.mjs";
import { createStarterTaskPackage } from "../src/experimentation-corpus/index.mjs";
import {
  createDefaultAnalysisPolicy,
  generateExperimentReport,
  renderExperimentReport,
  sealAnalysisPolicy,
} from "../src/experimentation-reporting/index.mjs";
import { ExperimentRunStore } from "../src/experiment-runner.mjs";
import { PILOT_FAMILIES } from "./build-signed-in-pilot.mjs";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`invalid option: ${name ?? "<missing>"}`);
    values[name.slice(2)] = argv[index + 1];
  }
  return values;
}

function pilotPolicy(experiment) {
  const taskFamilies = new Map(PILOT_FAMILIES.map((family) => [createStarterTaskPackage(family).task.taskId, family]));
  const base = createDefaultAnalysisPolicy({
    baselineCandidateId: experiment.candidates[0].candidateId,
    candidateId: experiment.candidates[1].candidateId,
    criticalStrata: PILOT_FAMILIES,
    stratumAssignments: [...taskFamilies].map(([taskId, family]) => ({ taskId, strata: [family] })),
    bootstrapSamples: 2000,
    permutationSamples: 4096,
  });
  const candidate = structuredClone(base);
  delete candidate.digest;
  for (const metric of candidate.metricDefinitions) {
    if (["network_bytes", "estimated_standard_credits", "observed_billing_credits", "observed_currency_cost"].includes(metric.metricId)) {
      metric.missingRule = "report-missing";
    }
  }
  return sealAnalysisPolicy(candidate);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.store || !options["run-id"] || !options.generation || !options.out) {
    throw new Error("usage: report-signed-in-pilot --store DIR --run-id ID --generation N --out DIR");
  }
  const generation = Number(options.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("generation must be a positive integer");
  const store = await ExperimentRunStore.open(resolve(options.store));
  const finalDigest = await store.readGenerationRef(options["run-id"], generation, "final");
  const manifestDigest = await store.readGenerationRef(options["run-id"], generation, "manifest");
  const planDigest = await store.readGenerationRef(options["run-id"], generation, "plan");
  if (!finalDigest || !manifestDigest || !planDigest) throw new Error("run generation is incomplete");
  const [final, manifest, plan] = await Promise.all([store.read(finalDigest), store.read(manifestDigest), store.read(planDigest)]);
  const attempts = await Promise.all(final.attempts.map(({ objectDigest }) => store.read(objectDigest)));
  const input = {
    schemaVersion: 1,
    experiment: manifest.experiment,
    plan,
    analysisPolicy: pilotPolicy(manifest.experiment),
    attempts,
  };
  const report = generateExperimentReport(input);
  const limitations = [
    "## Interpretation limits",
    "",
    "- This is diagnostic pipeline calibration over five synthetic starter tasks, not confirmatory evidence about real repository work or Nelos efficiency.",
    "- Both candidates are intentionally identical direct-Codex repeat arms; there is no Nelos arm and therefore no task-web accounting in this stage.",
    "- The signed-in product route does not expose a stable concrete model revision in Codex JSONL, so provenance records `model:product-default` with revision `unavailable`.",
    "- ChatGPT product authentication exposes token and runtime telemetry but not API billing credits, currency cost, or a defensible standard-credit conversion; those fields remain explicitly missing.",
    "- Network access is used by the Codex control plane. Candidate shell commands remain under the workspace-write sandbox and the sealed tasks declare no task network access.",
    "- The subsequent route-controlled API study must use a separately provisioned API key, followed by the direct-versus-Nelos confirmatory comparison.",
    "",
  ].join("\n");
  const out = resolve(options.out);
  await mkdir(out, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(resolve(out, "accepted-input.json"), canonicalBytes(input), { mode: 0o600 }),
    writeFile(resolve(out, "report.json"), canonicalBytes(report), { mode: 0o600 }),
    writeFile(resolve(out, "report.md"), `${renderExperimentReport(report)}\n${limitations}`, { mode: 0o600 }),
  ]);
  process.stdout.write(`${JSON.stringify({ outcome: report.decision.outcome, reportDigest: report.reportDigest, out })}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
