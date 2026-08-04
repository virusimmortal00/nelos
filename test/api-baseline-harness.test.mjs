import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import { canonicalDigest, sha256Bytes } from "../src/experimentation-contract/index.mjs";
import { expandExperimentPlan } from "../src/experiment-runner.mjs";
import { executeApiBaselineAttempt } from "../src/api-baseline-adapter.mjs";
import { createSignedInPilotManifest } from "../scripts/build-signed-in-pilot.mjs";
import { API_BASELINE_CANDIDATES, API_BASELINE_FAMILIES, API_BASELINE_RUN_PREFIX, CANARY_CEILINGS, createApiBaselineBundle, createAuthorizedConfirmatoryPlan, evaluateConfirmatoryAuthorization, measureRuntimeProvenance, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";
import { safeApiRuntimeError } from "../src/api-baseline-runtime.mjs";

const executeFile = promisify(execFile);
const executableBytes = Buffer.from("offline-fake-codex-executable-v2", "utf8");
const executablePath = "/offline/runtime/codex";
const runtimeProvenance = await measureRuntimeProvenance({ executablePath, backend: "oci-headless", platform: "linux-arm64", read: async () => Buffer.from(executableBytes), resolvePath: async () => executablePath });
const requestedModel = { id: "model:gpt-5.6-sol-2026-07-15", revision: "2026-07-15", reasoningEffort: "medium" };
const sourceCommit = "b".repeat(40);
const bundle = () => createApiBaselineBundle({ sourceCommit, requestedModel, runtimeProvenance });

function requestFor(input, ordinal = 0) {
  const trial = expandExperimentPlan(input.runnerManifest).trials.find(({ trialId }) => trialId === input.executionSchedule.blocks.flatMap(({ trialIds }) => trialIds)[ordinal]);
  const runId = `${API_BASELINE_RUN_PREFIX}test`; const attempt = 1; const operationId = `op:${canonicalDigest({ runId, trialId: trial.trialId, attempt }).slice(7)}`; const leaseId = `lease:${operationId.slice(3)}`;
  return { schemaVersion: 1, runId, runGeneration: 1, trialId: trial.trialId, attempt, operationId, lease: { leaseId, owner: `controller:${runId}`, fencingToken: canonicalDigest({ runId, trialId: trial.trialId, attempt, operationId, leaseId }), acquiredAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }, seed: trial.seed, componentSeeds: trial.componentSeeds, declaredInputs: trial.declaredInputs, declaredInputsDigest: trial.declaredInputsDigest, budget: trial.budget, requestedRoute: { candidateId: trial.candidateId, adapter: trial.adapter, modelId: trial.candidateProvenance.model.id, modelRevision: trial.candidateProvenance.model.revision, reasoningEffort: trial.candidateProvenance.model.reasoningEffort, pluginDigest: canonicalDigest(trial.candidateProvenance.plugins) }, runtimeProvenance: input.identity.runtimeProvenance, exposureCeilings: input.controls.ceilings };
}

function receipt(request, overrides = {}) {
  return { schemaVersion: 1, operationId: request.operationId, leaseId: request.lease.leaseId, fencingToken: request.lease.fencingToken, attempt: request.attempt, route: { ...request.requestedRoute }, provider: { executionCount: 1, retryCount: 0, requestCount: 1, estimatedCostUsd: 0.01 }, executable: { digest: sha256Bytes(executableBytes), byteLength: executableBytes.byteLength }, ...overrides };
}

test("canary is exactly four trials in predetermined opposite AB/BA blocks", () => {
  const input = bundle(); validateApiBaselineBundle(input);
  assert.equal(input.runnerManifest.tasks.length, 1); assert.equal(input.executionSchedule.trialCount, 4); assert.equal(input.executionSchedule.blocks.length, 2);
  assert.deepEqual(input.executionSchedule.blocks.map(({ candidateOrder }) => candidateOrder), [[...API_BASELINE_CANDIDATES], [...API_BASELINE_CANDIDATES].reverse()]);
  assert.deepEqual(input.controls.ceilings, CANARY_CEILINGS);
  assert.equal(input.runnerManifest.policy.maxConcurrency, 1); assert.equal(input.runnerManifest.policy.maxAttempts, 1); assert.equal(input.controls.confirmatoryAuthorization, "not-granted");
  assert.throws(() => createApiBaselineBundle({ mode: "confirmatory", sourceCommit, requestedModel, runtimeProvenance }), { code: "CONFIRMATORY_POWER_AUTHORIZATION_REQUIRED" });
});

test("API canary identities and route remain separate from the signed-in pilot", () => {
  const api = bundle();
  const pilot = createSignedInPilotManifest({ sourceCommit, imageDigest: `sha256:${"a".repeat(64)}`, image: "pilot:test", evidenceDirectory: "/tmp/pilot-evidence" });
  assert.notEqual(api.identity.phase, "signed-in-pilot"); assert.notEqual(api.identity.requestedRoute.modelId, pilot.experiment.candidates[0].model.id);
  assert.doesNotMatch(JSON.stringify(api), /run:signed-in|NELOS_PILOT|model:product-default/u);
});

test("runtime provenance is measured from bytes and rejects caller digest claims", async () => {
  assert.equal(runtimeProvenance.executableDigest, sha256Bytes(executableBytes));
  await assert.rejects(() => measureRuntimeProvenance({ executablePath, backend: "oci-headless", platform: "linux-arm64", expectedExecutableDigest: `sha256:${"0".repeat(64)}`, read: async () => Buffer.from(executableBytes), resolvePath: async () => executablePath }), { code: "RUNTIME_DIGEST_CLAIM_MISMATCH" });
  const changed = structuredClone(bundle()); changed.identity.runtimeProvenance.executableDigest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateApiBaselineBundle(changed), { code: "ALTERED_API_BASELINE_BUNDLE" });
});

test("offline injected sentinel and fake Codex leave every prohibited sink clean", async () => {
  const sentinel = ["sk", "offline", randomUUID().replaceAll("-", "")].join("-");
  const input = bundle(); const request = requestFor(input); const processCaptures = []; let credentialObserved = false; let attemptRoot;
  const response = await executeApiBaselineAttempt({
    request,
    loadCredential: async () => sentinel,
    claimOperation: async () => {},
    executableResolver: async () => executablePath,
    executableReader: async () => Buffer.from(executableBytes),
    processRunner: async (command, args, options) => {
      processCaptures.push({ command, args, environmentNames: Object.keys(options.env).sort(), stdoutDigest: command === "git" ? null : "captured-by-digest", stderrDigest: command === "git" ? null : "captured-by-digest" });
      attemptRoot = options.cwd.split("/workspace")[0];
      if (command === "git") return { code: 0, timedOut: false, stdout: "", stderr: "" };
      credentialObserved = options.env.OPENAI_API_KEY === sentinel;
      await writeFile(options.outputPath, JSON.stringify({ answer: "localized-repair:verified", family: "localized-repair" }));
      return { code: 0, timedOut: false, stdout: `${JSON.stringify({ type: "api.runtime_receipt", receipt: receipt(request) })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 3 } })}\n`, stderr: `untrusted provider text ${sentinel}` };
    },
  });
  assert.equal(credentialObserved, true);
  await assert.rejects(() => stat(attemptRoot), { code: "ENOENT" });
  const { stdout: tracked } = await executeFile("git", ["ls-files"], { cwd: new URL("..", import.meta.url).pathname });
  const trackedText = (await Promise.all(tracked.trim().split("\n").map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8").catch(() => "")))).join("\n");
  const sinks = {
    argvAndProcessCaptures: processCaptures,
    manifests: input,
    stdout: JSON.stringify(response),
    stderr: JSON.stringify({ error: safeApiRuntimeError(Object.assign(new Error(`provider ${sentinel}`), { code: "UNTRUSTED" })) }),
    logs: [],
    telemetry: response.measurements,
    reports: { outcome: response.outcome, measurements: response.measurements },
    contentAddressedEvidence: response.outputs,
    retainedArtifacts: response.artifacts,
    trackedFiles: trackedText,
  };
  for (const [name, value] of Object.entries(sinks)) assert.doesNotMatch(JSON.stringify(value), new RegExp(sentinel, "u"), name);
  assert.equal(input.runnerManifest.adapters["direct-codex"].command.some((part) => part.includes(sentinel)), false);
});

test("runtime receipts independently bind route, provider counts, and replay controls", async () => {
  const input = bundle(); const request = requestFor(input); const claims = new Set();
  const base = { request, loadCredential: async () => ["sk", "fake", "1234567890123456"].join("-"), executableResolver: async () => executablePath, executableReader: async () => Buffer.from(executableBytes), claimOperation: async (value) => { if (claims.has(value.operationId)) throw Object.assign(new Error("ATTEMPT_REPLAY_REJECTED"), { code: "ATTEMPT_REPLAY_REJECTED" }); claims.add(value.operationId); }, processRunner: async (command, args, options) => { if (command === "git") return { code: 0, stdout: "", stderr: "" }; await writeFile(options.outputPath, "{}"); return { code: 0, stdout: `${JSON.stringify({ type: "api.runtime_receipt", receipt: receipt(request) })}\n`, stderr: "" }; } };
  const result = await executeApiBaselineAttempt(base); assert.equal(result.observedRoute.modelRevision, requestedModel.revision); assert.equal(result.measurements.find(({ metricId }) => metricId === "provider_retries").value, 0);
  await assert.rejects(() => executeApiBaselineAttempt(base), { code: "ATTEMPT_REPLAY_REJECTED" });
  const missing = { ...base, claimOperation: async () => {}, processRunner: async (command, args, options) => { if (command === "git") return { code: 0, stdout: "", stderr: "" }; await writeFile(options.outputPath, "{}"); return { code: 0, stdout: "{}\n", stderr: "" }; } };
  await assert.rejects(() => executeApiBaselineAttempt(missing), { code: "RUNTIME_RECEIPT_MISSING" });
  const mismatched = { ...base, claimOperation: async () => {}, processRunner: async (command, args, options) => { if (command === "git") return { code: 0, stdout: "", stderr: "" }; await writeFile(options.outputPath, "{}"); const bad = receipt(request); bad.route.modelRevision = "wrong"; return { code: 0, stdout: `${JSON.stringify({ type: "api.runtime_receipt", receipt: bad })}\n`, stderr: "" }; } };
  await assert.rejects(() => executeApiBaselineAttempt(mismatched), { code: "RUNTIME_ROUTE_MISMATCH" });
  const overCeiling = { ...base, claimOperation: async () => {}, processRunner: async (command, args, options) => { if (command === "git") return { code: 0, stdout: "", stderr: "" }; await writeFile(options.outputPath, "{}"); const over = receipt(request); over.provider.retryCount = 1; return { code: 0, stdout: `${JSON.stringify({ type: "api.runtime_receipt", receipt: over })}\n`, stderr: "" }; } };
  await assert.rejects(() => executeApiBaselineAttempt(overCeiling), { code: "PROVIDER_EXPOSURE_EXCEEDED" });
  const wrongBytes = { ...base, claimOperation: async () => {}, executableReader: async () => Buffer.from("different executable") };
  await assert.rejects(() => executeApiBaselineAttempt(wrongBytes), { code: "RUNTIME_PROVENANCE_MISMATCH" });
  const expired = structuredClone(request); expired.lease.expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(() => executeApiBaselineAttempt({ ...base, request: expired, claimOperation: async () => {} }), { code: "ATTEMPT_CONTROL_INVALID" });
});

function evidenceFor(stratum, taskId, blockId, phase = "signed-in-pilot") {
  return ["a", "b"].map((arm) => ({ phase, stratum, taskId, blockId, arm, value: 1 }));
}

test("power authorization counts independent paired tasks, not repeated seeds", () => {
  const repeated = API_BASELINE_FAMILIES.flatMap((stratum) => Array.from({ length: 10 }, (_, index) => evidenceFor(stratum, `task:${stratum}:one`, `block:${index}`, index % 2 ? "api-canary" : "signed-in-pilot")).flat());
  const noGo = evaluateConfirmatoryAuthorization({ varianceEvidence: repeated });
  assert.equal(noGo.status, "no-go"); assert.equal(noGo.zeroFurtherCalls, true); assert.equal(noGo.strata.every(({ independentPairedTasks }) => independentPairedTasks === 1), true);
  assert.throws(() => createAuthorizedConfirmatoryPlan({ authorization: noGo, taskIdsByStratum: {} }), { code: "CONFIRMATORY_POWER_AUTHORIZATION_REQUIRED" });
  const independent = API_BASELINE_FAMILIES.flatMap((stratum) => Array.from({ length: 10 }, (_, index) => evidenceFor(stratum, `task:${stratum}:${index}`, `block:${index}`, index % 2 ? "api-canary" : "signed-in-pilot")).flat());
  const authorization = evaluateConfirmatoryAuthorization({ varianceEvidence: independent });
  assert.equal(authorization.status, "authorized"); assert.equal(authorization.strata.every(({ independentPairedTasks, authorizedTasks }) => independentPairedTasks === 10 && authorizedTasks === 10), true);
  const taskIdsByStratum = Object.fromEntries(API_BASELINE_FAMILIES.map((stratum) => [stratum, Array.from({ length: 10 }, (_, index) => `task:${stratum}:${index}`)]));
  const plan = createAuthorizedConfirmatoryPlan({ authorization, taskIdsByStratum }); assert.equal(plan.ceilings.trials, 100); assert.equal(plan.blocks.length, 50);
});

test("Nelos candidates and sealed canary expansion remain rejected", () => {
  const input = structuredClone(bundle()); input.runnerManifest.experiment.candidates[0].candidateId = "candidate:nelos-forbidden";
  assert.throws(() => validateApiBaselineBundle(input), { code: "INVALID_API_BASELINE_ARM" });
  const expanded = structuredClone(bundle()); expanded.controls.sealedTrialCount = 6; const material = { ...expanded }; delete material.bundleDigest; expanded.bundleDigest = canonicalDigest(material);
  assert.throws(() => validateApiBaselineBundle(expanded), { code: "API_BASELINE_CEILING_EXCEEDED" });
});
