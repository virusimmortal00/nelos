#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalBytes, canonicalDigest } from "../src/experimentation-contract/index.mjs";
import { API_BASELINE_RUN_PREFIX, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";
import { expandExperimentPlan } from "../src/experiment-runner.mjs";

function options(argv) { const value = {}; for (let index = 0; index < argv.length; index += 2) value[argv[index]?.slice(2)] = argv[index + 1]; return value; }
function invoke(command, args, request) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.once("error", () => reject(new Error("ADAPTER_LAUNCH_FAILED")));
    child.once("close", (code) => code === 0 ? resolveRun(JSON.parse(Buffer.concat(stdout).toString("utf8"))) : reject(new Error("ADAPTER_ATTEMPT_FAILED")));
    child.stdin.end(canonicalBytes(request));
  });
}

const input = options(process.argv.slice(2));
if (!input.bundle || !input.store || !input["run-id"]?.startsWith(API_BASELINE_RUN_PREFIX)) throw new Error("usage: run-api-baseline --bundle FILE --store DIR --run-id run:api-baseline-ID");
const bundle = validateApiBaselineBundle(JSON.parse(await readFile(resolve(input.bundle), "utf8")));
const store = resolve(input.store);
await mkdir(store, { recursive: false, mode: 0o700 });
const plan = expandExperimentPlan(bundle.runnerManifest);
const byId = new Map(plan.trials.map((trial) => [trial.trialId, trial]));
const declaration = bundle.runnerManifest.adapters["direct-codex"];
const results = [];
for (const block of bundle.executionSchedule.blocks) {
  for (const trialId of block.trialIds) {
    if (results.length >= bundle.controls.sealedTrialCount) throw new Error("SEALED_PLAN_EXPANSION_REJECTED");
    const trial = byId.get(trialId); const attempt = 1; const operationId = `op:${canonicalDigest({ runId: input["run-id"], trialId, attempt }).slice(7)}`;
    const requestedRoute = { candidateId: trial.candidateId, adapter: trial.adapter, modelId: trial.candidateProvenance.model.id, modelRevision: trial.candidateProvenance.model.revision, reasoningEffort: trial.candidateProvenance.model.reasoningEffort, pluginDigest: canonicalDigest(trial.candidateProvenance.plugins) };
    const request = { schemaVersion: 1, runId: input["run-id"], runGeneration: 1, trialId, attempt, operationId, lease: { leaseId: `lease:${operationId.slice(3)}`, owner: `controller:${input["run-id"]}`, fencingToken: canonicalDigest({ operationId, trialId }), acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + bundle.runnerManifest.policy.leaseMs).toISOString() }, seed: trial.seed, componentSeeds: trial.componentSeeds, declaredInputs: trial.declaredInputs, declaredInputsDigest: trial.declaredInputsDigest, budget: trial.budget, requestedRoute };
    const response = await invoke(declaration.command[0], declaration.command.slice(1), request);
    if (canonicalDigest(response.observedRoute) !== canonicalDigest(requestedRoute) || trial.budget.networkRequests > bundle.controls.ceilings.candidateNetworkRequestsPerTrial || response.measurements.find(({ metricId }) => metricId === "provider_executions")?.value > bundle.controls.ceilings.providerExecutionsPerTrial) throw new Error("ATTEMPT_CONTROL_VIOLATION");
    results.push({ blockId: block.blockId, trialId, candidateId: trial.candidateId, outcome: response.outcome, output: response.outputs[0], measurements: response.measurements });
    await writeFile(resolve(store, `${String(results.length).padStart(3, "0")}-${trialId.slice(-16)}.json`), canonicalBytes(results.at(-1)), { mode: 0o400, flag: "wx" });
  }
}
if (results.length !== bundle.controls.sealedTrialCount) throw new Error("SEALED_PLAN_INCOMPLETE");
const summary = { schemaVersion: 1, runId: input["run-id"], bundleDigest: bundle.bundleDigest, scheduleDigest: bundle.executionSchedule.scheduleDigest, trialCount: results.length, resultDigest: canonicalDigest(results) };
await writeFile(resolve(store, "api-baseline-run.json"), canonicalBytes(summary), { mode: 0o400, flag: "wx" });
process.stdout.write(`${JSON.stringify(summary)}\n`);
