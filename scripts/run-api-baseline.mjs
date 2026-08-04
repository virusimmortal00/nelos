#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalBytes, canonicalDigest } from "../src/experimentation-contract/index.mjs";
import { API_BASELINE_RUN_PREFIX, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";
import { writeApiBaselineResearchPacket } from "../src/api-baseline-research-packet.mjs";
import { readApiProviderExchanges } from "../src/api-baseline-runtime.mjs";
import { expandExperimentPlan } from "../src/experiment-runner.mjs";

function options(argv) { const value = {}; for (let index = 0; index < argv.length; index += 2) value[argv[index]?.slice(2)] = argv[index + 1]; return value; }
function invoke(command, args, request, operationLedgerRoot, exchangeLedgerRoot) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", NELOS_API_OPERATION_LEDGER: operationLedgerRoot, NELOS_API_EXCHANGE_LEDGER: exchangeLedgerRoot }, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = []; let stderrBytes = 0; child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.byteLength; if (stderrBytes <= 1024 * 1024) stderr.push(chunk); });
    child.once("error", () => reject(new Error("ADAPTER_LAUNCH_FAILED")));
    child.once("close", (code) => {
      if (code === 0) return resolveRun(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      const safeCodes = Buffer.concat(stderr).toString("utf8").split(/\r?\n/u).flatMap((line) => { try { const value = JSON.parse(line); return /^[A-Z][A-Z0-9_]+$/u.test(value?.error) ? [value.error] : []; } catch { return []; } });
      reject(new Error(safeCodes.length === 1 ? safeCodes[0] : "ADAPTER_ATTEMPT_FAILED"));
    });
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
const operationLedger = resolve(store, "operations");
const exchangeLedger = resolve(store, "provider-exchanges");
const startedAt = new Date().toISOString(); let finishedAt; let summary; let terminalError = null; let status = "aborted";
try {
  for (const block of bundle.executionSchedule.blocks) {
    for (const trialId of block.trialIds) {
      if (results.length >= bundle.controls.sealedTrialCount) throw new Error("SEALED_PLAN_EXPANSION_REJECTED");
      const trial = byId.get(trialId); const attempt = 1; const operationId = `op:${canonicalDigest({ runId: input["run-id"], trialId, attempt }).slice(7)}`; const leaseId = `lease:${operationId.slice(3)}`;
      const requestedRoute = { candidateId: trial.candidateId, adapter: trial.adapter, modelId: trial.candidateProvenance.model.id, modelRevision: trial.candidateProvenance.model.revision, reasoningEffort: trial.candidateProvenance.model.reasoningEffort, pluginDigest: canonicalDigest(trial.candidateProvenance.plugins) };
      const request = { schemaVersion: 1, runId: input["run-id"], runGeneration: 1, trialId, attempt, operationId, lease: { leaseId, owner: `controller:${input["run-id"]}`, fencingToken: canonicalDigest({ runId: input["run-id"], trialId, attempt, operationId, leaseId }), acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + bundle.runnerManifest.policy.leaseMs).toISOString() }, seed: trial.seed, componentSeeds: trial.componentSeeds, declaredInputs: trial.declaredInputs, declaredInputsDigest: trial.declaredInputsDigest, budget: trial.budget, requestedRoute, runtimeProvenance: bundle.identity.runtimeProvenance, pricingSnapshot: bundle.identity.pricingSnapshot, exposureCeilings: bundle.controls.ceilings };
      const response = await invoke(declaration.command[0], declaration.command.slice(1), request, operationLedger, exchangeLedger);
      const metrics = Object.fromEntries(response.measurements.map(({ metricId, value }) => [metricId, value]));
      const routeMatches = Object.entries(requestedRoute).every(([field, value]) => response.observedRoute?.[field] === value);
      const observedCost = metrics.estimated_cost_usd;
      if (response.operationId !== operationId || !routeMatches || metrics.provider_executions !== 1 || metrics.provider_retries !== 0 || metrics.provider_requests > bundle.controls.ceilings.providerRequestsPerTrial || !Number.isFinite(observedCost) || observedCost > bundle.controls.ceilings.maxEstimatedCostUsdPerTrial) throw new Error("ATTEMPT_CONTROL_VIOLATION");
      results.push({ blockId: block.blockId, trialId, candidateId: trial.candidateId, outcome: response.outcome, observedRoute: response.observedRoute, output: response.outputs[0], artifacts: response.artifacts, measurements: response.measurements });
      await writeFile(resolve(store, `${String(results.length).padStart(3, "0")}-${trialId.slice(-16)}.json`), canonicalBytes(results.at(-1)), { mode: 0o400, flag: "wx" });
    }
  }
  if (results.length !== bundle.controls.sealedTrialCount) throw new Error("SEALED_PLAN_INCOMPLETE");
  const totals = results.flatMap(({ measurements }) => measurements).reduce((value, { metricId, value: measurement }) => { if (Number.isFinite(measurement)) value[metricId] = (value[metricId] ?? 0) + measurement; return value; }, {});
  if ((totals.provider_executions ?? 0) > bundle.controls.ceilings.maxTotalProviderExecutions || (totals.provider_retries ?? 0) > bundle.controls.ceilings.maxTotalProviderRetries || (totals.provider_requests ?? 0) > bundle.controls.ceilings.maxTotalProviderRequests || (totals.output_tokens ?? 0) > bundle.controls.ceilings.maxTotalOutputTokens || (totals.estimated_cost_usd ?? 0) > bundle.controls.ceilings.maxTotalEstimatedCostUsd || (totals.estimated_cost_usd ?? 0) + bundle.controls.ceilings.reservedPriorExposureUsd > bundle.controls.ceilings.pilotAggregateCostCeilingUsd) throw new Error("TOTAL_EXPOSURE_CEILING_EXCEEDED");
  summary = { schemaVersion: 1, runId: input["run-id"], bundleDigest: bundle.bundleDigest, scheduleDigest: bundle.executionSchedule.scheduleDigest, trialCount: results.length, resultDigest: canonicalDigest(results) };
  await writeFile(resolve(store, "api-baseline-run.json"), canonicalBytes(summary), { mode: 0o400, flag: "wx" });
  status = "completed";
} catch (error) { terminalError = error; }
finishedAt = new Date().toISOString();
const errorCode = terminalError && /^[A-Z][A-Z0-9_]+$/u.test(terminalError.message) ? terminalError.message : terminalError ? "API_BASELINE_RUN_ABORTED" : null;
let providerExchanges = [];
try { providerExchanges = await readApiProviderExchanges({ ledgerRoot: exchangeLedger }); } catch (error) { terminalError ??= error; }
try { await writeApiBaselineResearchPacket({ store, bundle, runId: input["run-id"], results, providerExchanges, status, errorCode, startedAt, finishedAt }); } catch (error) { terminalError ??= error; }
if (terminalError) throw terminalError;
process.stdout.write(`${JSON.stringify(summary)}\n`);
