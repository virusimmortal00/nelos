import assert from "node:assert/strict";
import test from "node:test";

import { canonicalDigest } from "../src/experimentation-contract/index.mjs";
import { createSignedInPilotManifest } from "../scripts/build-signed-in-pilot.mjs";
import { API_BASELINE_CANDIDATES, API_BASELINE_RUN_PREFIX, assertPowerDecisionReady, createApiBaselineBundle, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";
import { safeApiRuntimeError } from "../src/api-baseline-runtime.mjs";

const runtime = { backend: "oci-headless", platform: "linux-arm64", runtimeVersion: "codex-api-test-v1", runtimeDigest: `sha256:${"c".repeat(64)}` };
const requestedModel = { id: "model:gpt-5.6-sol-2026-07-15", revision: "2026-07-15", reasoningEffort: "medium" };
const sourceCommit = "b".repeat(40);
const bundle = (mode = "canary") => createApiBaselineBundle({ mode, sourceCommit, requestedModel, runtime });

test("API baseline deterministically seals balanced AB/BA task-seed blocks", () => {
  const first = bundle("confirmatory"); const second = bundle("confirmatory");
  assert.deepEqual(first, second); validateApiBaselineBundle(first);
  assert.equal(first.executionSchedule.trialCount, 100);
  for (const taskId of new Set(first.executionSchedule.blocks.map(({ taskId }) => taskId))) {
    const orders = first.executionSchedule.blocks.filter((block) => block.taskId === taskId).map(({ candidateOrder }) => candidateOrder.join(""));
    assert.equal(orders.filter((order) => order === API_BASELINE_CANDIDATES.join("")).length, 5);
    assert.equal(orders.filter((order) => order === [...API_BASELINE_CANDIDATES].reverse().join("")).length, 5);
  }
  const labelsByPosition = first.executionSchedule.blocks.flatMap(({ candidateOrder }) => candidateOrder.map((candidateId, index) => `${index}:${candidateId}`));
  assert.equal(new Set(labelsByPosition).size, 4);
});

test("API manifest is route explicit and separate from the signed-in pilot", () => {
  const api = bundle();
  const pilot = createSignedInPilotManifest({ sourceCommit, imageDigest: `sha256:${"a".repeat(64)}`, image: "pilot:test", evidenceDirectory: "/tmp/pilot" });
  assert.equal(api.identity.requestedRoute.modelId, requestedModel.id);
  assert.notEqual(api.identity.requestedRoute.modelId, pilot.experiment.candidates[0].model.id);
  assert.equal(api.identity.runIdPrefix, API_BASELINE_RUN_PREFIX);
  assert.doesNotMatch(JSON.stringify(api), /run:signed-in|NELOS_PILOT|model:product-default/u);
  assert.equal(api.runnerManifest.experiment.candidates.every(({ plugins, adapter }) => plugins.length === 0 && adapter === "direct-codex"), true);
});

test("canary construction is bounded and sealed-plan tampering is rejected", () => {
  const input = bundle();
  assert.deepEqual(input.controls.ceilings, { repetitions: 2, trials: 20, tokenBudget: 4000, wallClockSeconds: 180, maxConcurrency: 1, maxAttempts: 1, candidateNetworkRequestsPerTrial: 0, providerExecutionsPerTrial: 1 });
  const altered = structuredClone(input); altered.executionSchedule.blocks[0].candidateOrder.reverse();
  assert.throws(() => validateApiBaselineBundle(altered), { code: "ALTERED_API_BASELINE_BUNDLE" });
  const expanded = structuredClone(input); expanded.controls.ceilings.trials = 22; const material = { ...expanded }; delete material.bundleDigest; expanded.bundleDigest = canonicalDigest(material);
  assert.throws(() => validateApiBaselineBundle(expanded), { code: "API_BASELINE_CEILING_EXCEEDED" });
});

test("secret sentinels cannot enter manifests or runtime error text", () => {
  const sentinel = "sk-SENTINEL_NEVER_RETAIN_123456789";
  const input = bundle();
  assert.doesNotMatch(JSON.stringify(input), new RegExp(sentinel, "u"));
  const error = Object.assign(new Error(`provider rejected ${sentinel}`), { code: "UNTRUSTED_PROVIDER_TEXT" });
  assert.equal(safeApiRuntimeError(error), "API_BASELINE_ADAPTER_FAILED");
  assert.doesNotMatch(JSON.stringify({ error: safeApiRuntimeError(error) }), new RegExp(sentinel, "u"));
  assert.equal(Object.keys(input.runnerManifest.adapters["direct-codex"].environment).length, 0);
  assert.equal(input.runnerManifest.adapters["direct-codex"].command.some((part) => part.includes(sentinel)), false);
});

test("power decision requires ten complete pairs per critical stratum", () => {
  const input = bundle("confirmatory");
  const observations = input.executionSchedule.blocks.flatMap((block) => block.trialIds.map((trialId, index) => ({ stratum: input.decisionPolicy.criticalStrata.find((family) => block.taskId === input.runnerManifest.tasks.find((task) => task.prompt.text.toLowerCase().includes(family.replaceAll("-", " ")))?.taskId) ?? input.decisionPolicy.criticalStrata[input.runnerManifest.tasks.findIndex(({ taskId }) => taskId === block.taskId)], blockId: block.blockId, candidateId: block.candidateOrder[index], trialId })));
  assert.equal(assertPowerDecisionReady({ bundle: input, observations }).ready, true);
  const short = observations.filter((item) => !(item.stratum === input.decisionPolicy.criticalStrata[0] && input.executionSchedule.blocks.filter((block) => block.taskId === input.runnerManifest.tasks[0].taskId).at(-1).blockId === item.blockId));
  assert.throws(() => assertPowerDecisionReady({ bundle: input, observations: short }), { code: "INSUFFICIENT_PAIRED_SAMPLES" });
  const changedPolicy = structuredClone(input); changedPolicy.decisionPolicy.alpha = 0.1; const material = { ...changedPolicy }; delete material.bundleDigest; changedPolicy.bundleDigest = canonicalDigest(material);
  assert.throws(() => assertPowerDecisionReady({ bundle: changedPolicy, observations }), { code: "INVALID_POWER_POLICY" });
});

test("Nelos candidates are rejected from the API baseline phase", () => {
  const input = structuredClone(bundle()); input.runnerManifest.experiment.candidates[0].candidateId = "candidate:nelos-forbidden";
  assert.throws(() => validateApiBaselineBundle(input), { code: "INVALID_API_BASELINE_ARM" });
});
