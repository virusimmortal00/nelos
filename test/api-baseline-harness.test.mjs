import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { canonicalDigest, deriveTaskDigest, deriveTaskIdentity, reviseTask, sealTask, sha256Bytes } from "../src/experimentation-contract/index.mjs";
import { bundleDigest, createStarterDevelopmentRelease, createTaskPackage } from "../src/experimentation-corpus/index.mjs";
import { expandExperimentPlan } from "../src/experiment-runner.mjs";
import { executeApiBaselineAttempt } from "../src/api-baseline-adapter.mjs";
import { startApiReceiptProxy } from "../src/api-baseline-receipt-proxy.mjs";
import { writeApiBaselineResearchPacket } from "../src/api-baseline-research-packet.mjs";
import { normalizeApiBaselineVarianceEvidence } from "../src/api-baseline-variance-evidence.mjs";
import { CALIBRATION_TRANCHE_POLICY, createCalibrationTrancheRequirement } from "../src/api-baseline-calibration-plan.mjs";
import { createSignedInPilotManifest } from "../scripts/build-signed-in-pilot.mjs";
import { API_BASELINE_CANDIDATES, API_BASELINE_FAMILIES, API_BASELINE_RUN_PREFIX, CANARY_CEILINGS, createApiBaselineBundle, createAuthorizedConfirmatoryPlan, evaluateConfirmatoryAuthorization, measureRuntimeProvenance, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";
import { readApiProviderExchanges, recordApiProviderExchange, safeApiRuntimeError } from "../src/api-baseline-runtime.mjs";
import { validatePluginReleaseChange } from "../scripts/validate-plugin-release.mjs";
import {
  COMMITTED_ARTIFACT_ROOT,
  REPOSITORY_ROOT,
  buildCalibrationRelease,
  loadPrivateMaterial,
  publicProjectionFiles,
  resolvePrivateRoot,
} from "../experiments/api-baseline/calibration-tranche-1/build-release.mjs";
import {
  CALIBRATION_CONCEPTS,
  CALIBRATION_REQUIREMENT_DIGEST,
  CALIBRATION_STRATA,
  createCalibrationTrancheRelease,
} from "../experiments/api-baseline/calibration-tranche-1/lib/release.mjs";

const executeFile = promisify(execFile);
const executableBytes = Buffer.from("offline-fake-codex-executable-v2", "utf8");
const executablePath = "/offline/runtime/codex";
const runtimeProvenance = await measureRuntimeProvenance({ executablePath, backend: "oci-headless", platform: "linux-arm64", read: async () => Buffer.from(executableBytes), resolvePath: async () => executablePath });
const requestedModel = { id: "model:gpt-5.6-sol", revision: "gpt-5.6-sol", reasoningEffort: "medium" };
const pricingSnapshot = { schemaVersion: 1, provider: "openai", capturedAt: "2026-08-04T00:00:00.000Z", sourceUrl: "https://developers.openai.com/api/docs/pricing", modelId: requestedModel.id, currency: "USD", serviceTier: "default", longContextThresholdTokens: 272000, inputUsdPerMillionTokens: 5, cachedInputUsdPerMillionTokens: 0.5, cacheWriteUsdPerMillionTokens: 6.25, outputUsdPerMillionTokens: 30, longContextInputUsdPerMillionTokens: 10, longContextCachedInputUsdPerMillionTokens: 1, longContextCacheWriteUsdPerMillionTokens: 12.5, longContextOutputUsdPerMillionTokens: 45 };
const sourceCommit = "b".repeat(40);
const bundle = () => createApiBaselineBundle({ sourceCommit, requestedModel, runtimeProvenance, pricingSnapshot });

function requestFor(input, ordinal = 0) {
  const trial = expandExperimentPlan(input.runnerManifest).trials.find(({ trialId }) => trialId === input.executionSchedule.blocks.flatMap(({ trialIds }) => trialIds)[ordinal]);
  const runId = `${API_BASELINE_RUN_PREFIX}test`; const attempt = 1; const operationId = `op:${canonicalDigest({ runId, trialId: trial.trialId, attempt }).slice(7)}`; const leaseId = `lease:${operationId.slice(3)}`;
  return { schemaVersion: 1, runId, runGeneration: 1, trialId: trial.trialId, attempt, operationId, lease: { leaseId, owner: `controller:${runId}`, fencingToken: canonicalDigest({ runId, trialId: trial.trialId, attempt, operationId, leaseId }), acquiredAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }, seed: trial.seed, componentSeeds: trial.componentSeeds, declaredInputs: trial.declaredInputs, declaredInputsDigest: trial.declaredInputsDigest, budget: trial.budget, requestedRoute: { candidateId: trial.candidateId, adapter: trial.adapter, modelId: trial.candidateProvenance.model.id, modelRevision: trial.candidateProvenance.model.revision, reasoningEffort: trial.candidateProvenance.model.reasoningEffort, pluginDigest: canonicalDigest(trial.candidateProvenance.plugins) }, runtimeProvenance: input.identity.runtimeProvenance, pricingSnapshot: input.identity.pricingSnapshot, exposureCeilings: input.controls.ceilings };
}

function receipt(request, overrides = {}) {
  const usage = { inputTokens: 11, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 14 };
  const material = { schemaVersion: 1, operationId: request.operationId, trialId: request.trialId, attempt: request.attempt, exchangeOrdinal: 1, requestId: "req_offline", responseId: "resp_offline", observedModelRevision: requestedModel.revision, serviceTier: "default", usage, estimatedCostUsd: 0.00013725, pricingSnapshotDigest: canonicalDigest(request.pricingSnapshot) };
  const exchange = { ...material, exchangeDigest: canonicalDigest(material) };
  return { schemaVersion: 1, operationId: request.operationId, leaseId: request.lease.leaseId, fencingToken: request.lease.fencingToken, attempt: request.attempt, route: { ...request.requestedRoute, observedModelId: requestedModel.id, observedModelRevision: requestedModel.revision, forwardedReasoningEffort: requestedModel.reasoningEffort, forwardedServiceTier: "default" }, provider: { executionCount: 1, retryCount: 0, requestCount: 1, logicalTurnCount: 1, estimatedCostUsd: 0.00013725, costStatus: "computed-from-snapshot", pricingSnapshotDigest: canonicalDigest(request.pricingSnapshot), exchanges: [exchange], usage: { ...usage } }, executable: { digest: sha256Bytes(executableBytes), byteLength: executableBytes.byteLength }, ...overrides };
}

function receiptProxy(request, value = () => receipt(request), observe = () => {}) {
  return async (options) => {
    observe(options);
    return { baseUrl: "http://127.0.0.1:12345/v1", abort: async () => {}, finish: async () => value() };
  };
}

test("canary is exactly four trials in predetermined opposite AB/BA blocks", () => {
  const input = bundle(); validateApiBaselineBundle(input);
  assert.equal(input.runnerManifest.tasks.length, 1); assert.equal(input.executionSchedule.trialCount, 4); assert.equal(input.executionSchedule.blocks.length, 2);
  assert.deepEqual(input.executionSchedule.blocks.map(({ candidateOrder }) => candidateOrder), [[...API_BASELINE_CANDIDATES], [...API_BASELINE_CANDIDATES].reverse()]);
  assert.deepEqual(input.controls.ceilings, CANARY_CEILINGS);
  assert.equal(input.runnerManifest.policy.maxConcurrency, 1); assert.equal(input.runnerManifest.policy.maxAttempts, 1); assert.equal(input.controls.confirmatoryAuthorization, "not-granted");
  assert.throws(() => createApiBaselineBundle({ mode: "confirmatory", sourceCommit, requestedModel, runtimeProvenance, pricingSnapshot }), { code: "CONFIRMATORY_POWER_AUTHORIZATION_REQUIRED" });
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
  const input = bundle(); const request = requestFor(input); const processCaptures = []; let credentialObserved = false; let proxyCredentialObserved = false; let codexHomeObserved = false; let attemptRoot;
  const response = await executeApiBaselineAttempt({
    request,
    loadCredential: async () => sentinel,
    claimOperation: async () => {},
    executableResolver: async (sealedPath) => { assert.equal(sealedPath, executablePath); return executablePath; },
    executableReader: async () => Buffer.from(executableBytes),
    receiptProxyFactory: receiptProxy(request, () => receipt(request), ({ apiKey }) => { proxyCredentialObserved = apiKey === sentinel; }),
    processRunner: async (command, args, options) => {
      processCaptures.push({ command, args, environmentNames: Object.keys(options.env).sort(), stdoutDigest: command === "git" ? null : "captured-by-digest", stderrDigest: command === "git" ? null : "captured-by-digest" });
      attemptRoot = options.cwd.split("/workspace")[0];
      if (command === "git") return { code: 0, timedOut: false, stdout: "", stderr: "" };
      credentialObserved = options.env.OPENAI_API_KEY === sentinel;
      codexHomeObserved = (await stat(options.env.CODEX_HOME)).isDirectory();
      await writeFile(options.outputPath, JSON.stringify({ answer: "localized-repair:verified", family: "localized-repair" }));
      return { code: 0, timedOut: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 3 } })}\n`, stderr: `untrusted provider text ${sentinel}` };
    },
  });
  assert.equal(credentialObserved, true); assert.equal(proxyCredentialObserved, true); assert.equal(codexHomeObserved, true);
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
  const base = { request, loadCredential: async () => ["sk", "fake", "1234567890123456"].join("-"), executableResolver: async () => executablePath, executableReader: async () => Buffer.from(executableBytes), receiptProxyFactory: receiptProxy(request), claimOperation: async (value) => { if (claims.has(value.operationId)) throw Object.assign(new Error("ATTEMPT_REPLAY_REJECTED"), { code: "ATTEMPT_REPLAY_REJECTED" }); claims.add(value.operationId); }, processRunner: async (command, args, options) => { if (command === "git") return { code: 0, stdout: "", stderr: "" }; await writeFile(options.outputPath, "{}"); return { code: 0, stdout: "", stderr: "" }; } };
  const result = await executeApiBaselineAttempt(base); assert.equal(result.observedRoute.modelRevision, requestedModel.revision); assert.equal(result.measurements.find(({ metricId }) => metricId === "provider_retries").value, 0);
  assert.equal(result.observedRoute.observedModelRevision, requestedModel.revision); assert.deepEqual(result.artifacts.map(({ id }) => id), ["runtime-provider-receipt", "machine-grade"]);
  await assert.rejects(() => executeApiBaselineAttempt(base), { code: "ATTEMPT_REPLAY_REJECTED" });
  const missing = { ...base, claimOperation: async () => {}, receiptProxyFactory: receiptProxy(request, () => { throw Object.assign(new Error("PROXY_RECEIPT_INCOMPLETE"), { code: "PROXY_RECEIPT_INCOMPLETE" }); }) };
  await assert.rejects(() => executeApiBaselineAttempt(missing), { code: "PROXY_RECEIPT_INCOMPLETE" });
  const mismatched = { ...base, claimOperation: async () => {}, receiptProxyFactory: receiptProxy(request, () => { const bad = receipt(request); bad.route.modelRevision = "wrong"; return bad; }) };
  await assert.rejects(() => executeApiBaselineAttempt(mismatched), { code: "RUNTIME_ROUTE_MISMATCH" });
  const overCeiling = { ...base, claimOperation: async () => {}, receiptProxyFactory: receiptProxy(request, () => { const over = receipt(request); over.provider.retryCount = 1; return over; }) };
  await assert.rejects(() => executeApiBaselineAttempt(overCeiling), { code: "PROVIDER_EXPOSURE_EXCEEDED" });
  const wrongBytes = { ...base, claimOperation: async () => {}, executableReader: async () => Buffer.from("different executable") };
  await assert.rejects(() => executeApiBaselineAttempt(wrongBytes), { code: "RUNTIME_PROVENANCE_MISMATCH" });
  const expired = structuredClone(request); expired.lease.expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(() => executeApiBaselineAttempt({ ...base, request: expired, claimOperation: async () => {} }), { code: "ATTEMPT_CONTROL_INVALID" });
});

test("localhost receipt proxy forwards one exact Responses request and seals provider evidence", async (t) => {
  const input = bundle(); const request = requestFor(input); const key = ["sk", "proxy", "1234567890123456"].join("-"); let authorization; let upstreamBody; const recorded = [];
  const upstream = createServer(async (incoming, response) => {
    authorization = incoming.headers.authorization;
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk); upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_live_fake" });
    response.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_live_fake", status: "in_progress", model: "gpt-5.6-sol" } })}\n\n`);
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_live_fake", status: "completed", model: "gpt-5.6-sol", service_tier: "default", usage: { input_tokens: 17, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 22 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => upstream.close(resolveClose)));
  const address = upstream.address();
  const proxy = await startApiReceiptProxy({ apiKey: key, request, executable: { digest: sha256Bytes(executableBytes), byteLength: executableBytes.byteLength }, recordExchange: async (exchange) => recorded.push(exchange), upstreamBaseUrl: `http://127.0.0.1:${address.port}` });
  const providerResponse = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", reasoning: { effort: "medium" }, stream: true, input: "offline fixture" }) });
  assert.equal(providerResponse.status, 200); assert.match(await providerResponse.text(), /response\.completed/u);
  const sealed = await proxy.finish();
  assert.equal(authorization, `Bearer ${key}`); assert.equal(upstreamBody.model, "gpt-5.6-sol"); assert.equal(upstreamBody.reasoning.effort, "medium"); assert.equal(upstreamBody.service_tier, "default"); assert.equal(upstreamBody.max_output_tokens, 4000);
  assert.equal(sealed.provider.exchanges[0].responseId, "resp_live_fake"); assert.equal(sealed.provider.exchanges[0].requestId, "req_live_fake"); assert.equal(sealed.provider.usage.cachedInputTokens, 4); assert.equal(sealed.provider.usage.cacheWriteInputTokens, 3); assert.equal(sealed.route.observedModelRevision, "gpt-5.6-sol"); assert.deepEqual(recorded, sealed.provider.exchanges);
  assert.doesNotMatch(JSON.stringify(sealed), new RegExp(key, "u"));
});

test("localhost receipt proxy fails closed on route substitution", async (t) => {
  const input = bundle(); const request = requestFor(input); const key = ["sk", "proxy", "1234567890123456"].join("-");
  const upstream = createServer((_incoming, response) => response.end());
  await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => upstream.close(resolveClose)));
  const address = upstream.address();
  const proxy = await startApiReceiptProxy({ apiKey: key, request, executable: { digest: sha256Bytes(executableBytes), byteLength: executableBytes.byteLength }, upstreamBaseUrl: `http://127.0.0.1:${address.port}` });
  const rejected = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "substituted-model", reasoning: { effort: "medium" }, stream: true }) });
  assert.equal(rejected.status, 400);
  await assert.rejects(() => proxy.finish(), { code: "PROXY_ROUTE_MISMATCH" });
});

test("localhost receipt proxy admits bounded sequential turns and rejects the ninth", async (t) => {
  const input = bundle(); const request = requestFor(input); const key = ["sk", "proxy", "1234567890123456"].join("-");
  let ordinal = 0;
  const upstream = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) void _chunk;
    ordinal += 1;
    response.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${ordinal}` });
    response.end(JSON.stringify({ id: `resp_${ordinal}`, status: "completed", model: "gpt-5.6-sol", service_tier: "default", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => upstream.close(resolveClose)));
  const address = upstream.address();
  const proxy = await startApiReceiptProxy({ apiKey: key, request, executable: { digest: sha256Bytes(executableBytes), byteLength: executableBytes.byteLength }, upstreamBaseUrl: `http://127.0.0.1:${address.port}` });
  const options = { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", reasoning: { effort: "medium" } }) };
  for (let index = 0; index < 8; index += 1) assert.equal((await fetch(`${proxy.baseUrl}/responses`, options)).status, 200);
  assert.equal((await fetch(`${proxy.baseUrl}/responses`, options)).status, 409);
  await assert.rejects(() => proxy.finish(), { code: "PROXY_REQUEST_LIMIT_EXCEEDED" });
});

test("localhost receipt proxy distinguishes a client that never sends a request", async () => {
  const input = bundle(); const request = requestFor(input); const key = ["sk", "proxy", "1234567890123456"].join("-");
  const proxy = await startApiReceiptProxy({ apiKey: key, request, executable: { digest: sha256Bytes(executableBytes), byteLength: executableBytes.byteLength } });
  await assert.rejects(() => proxy.finish(), { code: "PROXY_REQUEST_NOT_OBSERVED" });
});

test("completed provider exchanges persist create-only without secret-bearing material", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "nelos-provider-exchanges-")); t.after(() => rm(root, { recursive: true, force: true }));
  const exchange = receipt(requestFor(bundle())).provider.exchanges[0];
  await recordApiProviderExchange(exchange, { ledgerRoot: root });
  await assert.rejects(() => recordApiProviderExchange(exchange, { ledgerRoot: root }), { code: "PROVIDER_EXCHANGE_RECORD_FAILED" });
  const retained = await readApiProviderExchanges({ ledgerRoot: root });
  assert.deepEqual(retained, [exchange]); assert.doesNotMatch(JSON.stringify(retained), /OPENAI_API_KEY|authorization|sk-/iu);
  const metadata = await stat(resolve(root, `${exchange.operationId.slice(3)}-01.json`)); assert.equal(metadata.mode & 0o777, 0o400);
});

test("research packets retain completed and aborted evidence without comparative promotion", async (t) => {
  const input = bundle();
  for (const [status, resultCount, errorCode] of [["completed", 4, null], ["aborted", 1, "ADAPTER_ATTEMPT_FAILED"]]) {
    const store = await mkdtemp(resolve(tmpdir(), `nelos-research-${status}-`)); t.after(() => rm(store, { recursive: true, force: true }));
    const results = Array.from({ length: resultCount }, (_, index) => ({ blockId: `block:${index}`, trialId: `trial:${index}`, candidateId: API_BASELINE_CANDIDATES[index % 2], outcome: "succeeded", observedRoute: { ...requestFor(input).requestedRoute }, output: { id: "result", digest: `sha256:${"a".repeat(64)}`, byteLength: 1 }, artifacts: [{ id: "runtime-provider-receipt", digest: `sha256:${"b".repeat(64)}`, byteLength: 1 }], measurements: [{ metricId: "strict_pass_rate", value: 1 }, { metricId: "estimated_cost_usd", value: 0.001 }] }));
    const exchange = receipt(requestFor(input)).provider.exchanges[0];
    await writeApiBaselineResearchPacket({ store, bundle: input, runId: `${API_BASELINE_RUN_PREFIX}${status}`, results, providerExchanges: [exchange], status, errorCode, startedAt: "2026-08-04T00:00:00.000Z", finishedAt: "2026-08-04T00:01:00.000Z" });
    const summary = JSON.parse(await readFile(resolve(store, "research-packet", "run-summary.json"), "utf8"));
    const claims = JSON.parse(await readFile(resolve(store, "research-packet", "claim-ledger.json"), "utf8"));
    const protocol = JSON.parse(await readFile(resolve(store, "research-packet", "protocol.json"), "utf8"));
    const exchanges = await readFile(resolve(store, "research-packet", "provider-exchanges.jsonl"), "utf8");
    assert.equal(summary.status, status); assert.equal(summary.evidenceHealth.complete, status === "completed"); assert.equal(summary.evidenceHealth.completedProviderExchangeCount, 1); assert.equal(protocol.identities.pricingSnapshot.capturedAt, pricingSnapshot.capturedAt); assert.match(exchanges, /req_offline/u);
    assert.equal(claims.claims.find(({ claimId }) => claimId === "claim:comparative-performance").status, "untested");
    assert.deepEqual(claims.claims.find(({ claimId }) => claimId === "claim:comparative-performance").supportingRuns, []);
    assert.doesNotMatch(JSON.stringify({ summary, claims, protocol }), /OPENAI_API_KEY|sk-(?:proj|proxy|offline|fake)-/u);
  }
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
  const expanded = structuredClone(taskIdsByStratum); expanded[API_BASELINE_FAMILIES[0]].push(`task:${API_BASELINE_FAMILIES[0]}:extra`);
  assert.throws(() => createAuthorizedConfirmatoryPlan({ authorization, taskIdsByStratum: expanded }), { code: "CONFIRMATORY_AUTHORIZED_TASK_COUNT_MISMATCH" });
});

test("staged calibration produces a bounded non-executable corpus requirement", () => {
  const input = bundle();
  const repeated = API_BASELINE_FAMILIES.flatMap((stratum) => evidenceFor(stratum, `task:${stratum}:existing`, `block:${stratum}`, "api-canary"));
  const signed = API_BASELINE_FAMILIES.flatMap((stratum) => evidenceFor(stratum, `task:${stratum}:existing`, `signed:${stratum}`, "signed-in-pilot"));
  const observations = [...repeated, ...signed];
  const decision = evaluateConfirmatoryAuthorization({ varianceEvidence: observations });
  const requirement = createCalibrationTrancheRequirement({ apiBundle: input, confirmatoryDecision: decision, varianceEvidence: observations });
  assert.equal(requirement.status, "corpus-required");
  assert.equal(requirement.executable, false);
  assert.equal(requirement.scheduleRequirement.trialCount, 20);
  assert.equal(requirement.ceilings.maxTotalEstimatedCostUsd, 3.75);
  assert.equal(requirement.hardBounds.maxTranches, 5);
  assert.equal(requirement.hardBounds.maxCumulativeEstimatedCostUsd, 18.75);
  assert.equal(requirement.authorizationBoundary.zeroProviderCallsUntilSeparateAuthorization, true);
  assert.equal(requirement.authorizationBoundary.thisArtifactCanAuthorizeCalls, false);
  assert.equal(requirement.authorizationBoundary.thisArtifactCanAuthorizeConfirmatoryWork, false);
  assert.equal(requirement.authorizationBoundary.thisArtifactCanAuthorizeNelosArm, false);
  assert.equal(requirement.claimPolicy.comparativePerformanceClaims, "prohibited");
  assert.equal(requirement.currentEvidence.every(({ independentPairedTasks, existingTaskIds }) => independentPairedTasks === 1 && existingTaskIds.length === 1), true);
  assert.equal(requirement.corpusRequirement.newIndependentTasksPerStratum, CALIBRATION_TRANCHE_POLICY.newIndependentTasksPerStratum);
  assert.equal(requirement.requirementDigest, canonicalDigest(Object.fromEntries(Object.entries(requirement).filter(([key]) => key !== "requirementDigest"))));
  assert.deepEqual(requirement, createCalibrationTrancheRequirement({ apiBundle: input, confirmatoryDecision: decision, varianceEvidence: observations }));
});

test("staged calibration cannot override stale, authorized, or incomplete power decisions", () => {
  const input = bundle();
  const observations = API_BASELINE_FAMILIES.flatMap((stratum) => [
    ...evidenceFor(stratum, `task:${stratum}:existing`, `api:${stratum}`, "api-canary"),
    ...evidenceFor(stratum, `task:${stratum}:existing`, `signed:${stratum}`, "signed-in-pilot"),
  ]);
  const decision = evaluateConfirmatoryAuthorization({ varianceEvidence: observations });
  const stale = structuredClone(decision); stale.zeroFurtherCalls = false;
  assert.throws(() => createCalibrationTrancheRequirement({ apiBundle: input, confirmatoryDecision: stale, varianceEvidence: observations }), { code: "CALIBRATION_STALE_POWER_DECISION" });
  const independent = API_BASELINE_FAMILIES.flatMap((stratum) => Array.from({ length: 10 }, (_, index) => evidenceFor(stratum, `task:${stratum}:${index}`, `block:${index}`, index % 2 ? "api-canary" : "signed-in-pilot")).flat());
  const authorized = evaluateConfirmatoryAuthorization({ varianceEvidence: independent });
  assert.throws(() => createCalibrationTrancheRequirement({ apiBundle: input, confirmatoryDecision: authorized, varianceEvidence: independent }), { code: "CALIBRATION_NOT_APPLICABLE" });
  const missingPhase = observations.filter(({ phase }) => phase === "api-canary");
  const missingDecision = evaluateConfirmatoryAuthorization({ varianceEvidence: missingPhase });
  assert.throws(() => createCalibrationTrancheRequirement({ apiBundle: input, confirmatoryDecision: missingDecision, varianceEvidence: missingPhase }), { code: "CALIBRATION_NOT_APPLICABLE" });
});

test("retained signed-in and API evidence normalize into paired task clusters", () => {
  const api = bundle(); const taskId = api.runnerManifest.tasks[0].taskId;
  const signedCandidates = [
    { candidateId: "candidate:signed-repeat-a", configuration: [{ name: "repeat-arm", value: "a" }] },
    { candidateId: "candidate:signed-repeat-b", configuration: [{ name: "repeat-arm", value: "b" }] },
  ];
  const signedTrials = signedCandidates.map(({ candidateId }, index) => ({ trialId: `trial:signed:${index}`, taskId, candidateId, seed: "signed-block-one", replicate: 1 }));
  const signedInInput = {
    schemaVersion: 1,
    experiment: { candidates: signedCandidates },
    plan: { trials: signedTrials },
    analysisPolicy: { stratumAssignments: [{ taskId, strata: ["localized-repair"] }] },
    attempts: signedTrials.map((trial) => ({ trialId: trial.trialId, candidateId: trial.candidateId, authoritative: true, evidenceComplete: true, routeMatch: true, measurements: [{ metricId: "strict_pass_rate", value: 1 }] })),
  };
  const apiResults = api.executionSchedule.blocks.flatMap((block) => block.trialIds.map((trialId, index) => ({
    trialId, blockId: block.blockId, candidateId: block.candidateOrder[index], observedRoute: { ...api.identity.requestedRoute }, artifacts: [{ id: "runtime-provider-receipt" }], measurements: [{ metricId: "strict_pass_rate", value: 1 }],
  })));
  const observations = normalizeApiBaselineVarianceEvidence({ signedInInput, apiBundle: api, apiResults });
  assert.equal(observations.length, 6); assert.deepEqual([...new Set(observations.map(({ phase }) => phase))], ["api-canary", "signed-in-pilot"]);
  const decision = evaluateConfirmatoryAuthorization({ varianceEvidence: observations });
  assert.equal(decision.status, "no-go"); assert.equal(decision.decision, "inconclusive-insufficient-independent-task-clusters"); assert.equal(decision.zeroFurtherCalls, true);
  assert.equal(decision.strata.find(({ stratum }) => stratum === "localized-repair").independentPairedTasks, 1);
  assert.equal(decision.strata.filter(({ stratum }) => stratum !== "localized-repair").every(({ independentPairedTasks }) => independentPairedTasks === 0), true);
  const mismatched = structuredClone(apiResults); mismatched[0].observedRoute.modelRevision = "substituted";
  assert.throws(() => normalizeApiBaselineVarianceEvidence({ signedInInput, apiBundle: api, apiResults: mismatched }), { code: "INVALID_API_VARIANCE_ROUTE" });
});

test("Nelos candidates and sealed canary expansion remain rejected", () => {
  const input = structuredClone(bundle()); input.runnerManifest.experiment.candidates[0].candidateId = "candidate:nelos-forbidden";
  assert.throws(() => validateApiBaselineBundle(input), { code: "INVALID_API_BASELINE_ARM" });
  const expanded = structuredClone(bundle()); expanded.controls.sealedTrialCount = 6; const material = { ...expanded }; delete material.bundleDigest; expanded.bundleDigest = canonicalDigest(material);
  assert.throws(() => validateApiBaselineBundle(expanded), { code: "API_BASELINE_CEILING_EXCEEDED" });
});

function privateCalibrationPackages() {
  return createStarterDevelopmentRelease().packages.map((original, index) => {
    const text = `Synthetic private fixture ${CALIBRATION_CONCEPTS[index].key}`;
    const revised = reviseTask(original.task, {
      prompt: { ...original.task.prompt, text, digest: sha256Bytes(Buffer.from(text, "utf8")) },
      determinism: { ...original.task.determinism, seed: 9100 + index },
      visibility: "private",
    });
    const task = initialCalibrationTask(revised);
    return createTaskPackage({
      task,
      graderBundle: original.graderBundle,
      assets: original.assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes, "base64") })),
    });
  });
}

function initialCalibrationTask(source, changes = {}) {
  const task = {
    ...structuredClone(source),
    ...structuredClone(changes),
    taskId: `task:${"0".repeat(64)}`,
    specRevision: 1,
    previousDigest: null,
    digest: `sha256:${"0".repeat(64)}`,
    state: "sealed",
  };
  task.taskId = deriveTaskIdentity(task);
  task.digest = deriveTaskDigest(task);
  return sealTask(task);
}

function privateCalibrationEvidence(packages) {
  const accessMaterial = {
    schemaVersion: 1,
    requirementDigest: CALIBRATION_REQUIREMENT_DIGEST,
    recordedAt: "2026-08-05T13:10:00Z",
    entries: packages.map(({ task }, index) => ({ actor: "agent:offline-test-fixture", role: "evaluator", taskId: task.taskId, at: `2026-08-05T13:${String(index).padStart(2, "0")}:00Z` })),
  };
  const accessEvidence = { ...accessMaterial, digest: canonicalDigest(accessMaterial) };
  const predecessor = createStarterDevelopmentRelease();
  const priorEvidencePackages = CALIBRATION_STRATA.map((stratum) => predecessor.packages.find((taskPackage) => predecessor.release.tasks.find(({ taskId }) => taskId === taskPackage.task.taskId)?.strata.category === stratum));
  const reviewPackages = [...packages, ...priorEvidencePackages];
  const pairs = [];
  for (let left = 0; left < reviewPackages.length; left += 1) {
    for (let right = left + 1; right < reviewPackages.length; right += 1) {
      const [leftTaskId, rightTaskId] = [reviewPackages[left].task.taskId, reviewPackages[right].task.taskId].sort();
      pairs.push({ leftTaskId, rightTaskId, disposition: "independent" });
    }
  }
  pairs.sort((left, right) => `${left.leftTaskId}:${left.rightTaskId}`.localeCompare(`${right.leftTaskId}:${right.rightTaskId}`));
  const reviewMaterial = { schemaVersion: 1, requirementDigest: CALIBRATION_REQUIREMENT_DIGEST, reviewer: "agent:offline-test-fixture", reviewedAt: "2026-08-05T13:15:00Z", pairs };
  const semanticReview = { ...reviewMaterial, digest: canonicalDigest(reviewMaterial) };
  return { accessEvidence, semanticReview };
}

async function writePrivateCalibrationRoot(root, packages = privateCalibrationPackages()) {
  await mkdir(resolve(root, "packages"), { recursive: true });
  const concepts = CALIBRATION_CONCEPTS.map((concept, index) => ({
    ...concept,
    taskId: packages[index].task.taskId,
    packageDigest: packages[index].digest,
  }));
  const { accessEvidence, semanticReview } = privateCalibrationEvidence(packages);
  const evidence = {
    access: { file: "access-evidence.json", digest: canonicalDigest(accessEvidence) },
    semanticReview: { file: "semantic-pair-review.json", digest: canonicalDigest(semanticReview) },
  };
  await writeFile(resolve(root, "private-manifest.json"), JSON.stringify({ schemaVersion: 1, concepts, evidence }));
  await writeFile(resolve(root, "access-evidence.json"), JSON.stringify(accessEvidence));
  await writeFile(resolve(root, "semantic-pair-review.json"), JSON.stringify(semanticReview));
  await Promise.all(packages.map((taskPackage) => writeFile(resolve(root, "packages", `${taskPackage.task.taskId.slice(5)}.json`), JSON.stringify(taskPackage))));
  return { concepts, packages, accessEvidence, semanticReview };
}

function calibrationPackageWithGrader(taskPackage, overrides) {
  const material = { ...taskPackage.graderBundle, ...overrides };
  delete material.digest;
  const graderBundle = { ...material, digest: bundleDigest(material) };
  const task = initialCalibrationTask(taskPackage.task, { grader: { ...taskPackage.task.grader, id: graderBundle.graderBundleId.slice("grader:".length), version: graderBundle.version, digest: graderBundle.digest } });
  return createTaskPackage({
    task,
    graderBundle,
    assets: taskPackage.assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes, "base64") })),
  });
}

test("public calibration artifacts preserve the approved immutable release and inert schedule", async () => {
  const lock = JSON.parse(await readFile(resolve(COMMITTED_ARTIFACT_ROOT, "release-lock.json"), "utf8"));
  const schedule = JSON.parse(await readFile(resolve(COMMITTED_ARTIFACT_ROOT, "schedule.json"), "utf8"));
  const independence = JSON.parse(await readFile(resolve(COMMITTED_ARTIFACT_ROOT, "independence-summary.json"), "utf8"));
  assert.equal(lock.requirementDigest, CALIBRATION_REQUIREMENT_DIGEST);
  assert.deepEqual(lock.predecessor, { version: "1.0.0", releaseId: "corpus:355bf16738a0d874d3c265d85bc148ad9d61fd3ca1e852c36b3a60c7feb8cf7f", digest: "sha256:64fbee81daaea1c0869cf54f8ef7f36c76d2c7af62ec85995112328f2ad13a89" });
  assert.equal(lock.release.version, "1.1.0");
  assert.equal(lock.release.revision, 2);
  assert.equal(lock.release.state, "published");
  assert.deepEqual(lock.concepts.map(({ key, stratum }) => ({ key, stratum })), CALIBRATION_CONCEPTS);
  assert.equal(new Set(lock.concepts.map(({ taskId }) => taskId)).size, 10);
  assert.equal(independence.comparisonCount, 105);
  assert.equal(independence.pairs.length, 105);
  assert.equal(schedule.executable, false);
  assert.equal(schedule.status, "prepared-unauthorized");
  assert.equal(schedule.trialCount, 20);
  assert.equal(schedule.maxConcurrency, 1);
  assert.equal(schedule.maxAttempts, 1);
  assert.equal(schedule.providerRetriesPerTrial, 0);
  assert.equal(schedule.maxEstimatedCostUsd, 3.75);
  assert.equal(schedule.authorization.confirmatoryNoGoPreserved, true);
  assert.equal(schedule.authorization.freshExactUserAuthorizationRequiredBeforeAnyTrancheCall, true);
  assert.equal(schedule.authorization.providerCallsMadeDuringConstruction, 0);
  assert.equal(schedule.authorization.credentialAccessesDuringConstruction, 0);
  const blocks = Array.from({ length: 10 }, (_, index) => schedule.trials.slice(index * 2, index * 2 + 2));
  assert.deepEqual(blocks.map(([trial]) => trial.taskId), blocks.map(([trial]) => trial.taskId).toSorted());
  assert.equal(blocks.filter(([first]) => first.arm.endsWith("-a")).length, 5);
  assert.equal(blocks.filter(([first]) => first.arm.endsWith("-b")).length, 5);
});

test("public calibration projections reproduce deterministically from external private packages", async () => {
  const privateRoot = await mkdtemp(resolve(tmpdir(), "nelos-calibration-private-"));
  await writePrivateCalibrationRoot(privateRoot);
  const first = await buildCalibrationRelease({ privateRoot });
  const second = createCalibrationTrancheRelease(await loadPrivateMaterial(privateRoot));
  const left = publicProjectionFiles(first.tranche);
  const right = publicProjectionFiles(second);
  assert.deepEqual([...left.keys()], [...right.keys()]);
  for (const [path, bytes] of left) assert.equal(bytes.equals(right.get(path)), true, path);
  assert.equal(first.tranche.packages.length, 10);
  assert.equal(first.tranche.semanticIndependence.comparisonCount, 105);
  assert.equal(first.tranche.schedule.trialCount, 20);
});

test("calibration release binds every unique grader bundle and rejects identity collisions", () => {
  const packages = privateCalibrationPackages();
  packages[1] = calibrationPackageWithGrader(packages[1], { graderBundleId: "grader:calibration-alternate" });
  const tranche = createCalibrationTrancheRelease({ packages, concepts: CALIBRATION_CONCEPTS, ...privateCalibrationEvidence(packages) });
  assert.deepEqual(tranche.release.graderBundles.map(({ graderBundleId }) => graderBundleId), ["grader:calibration-alternate", "grader:starter-exact"]);

  const collision = [...packages];
  collision[2] = calibrationPackageWithGrader(collision[2], { version: "1.0.1" });
  assert.throws(() => createCalibrationTrancheRelease({ packages: collision, concepts: CALIBRATION_CONCEPTS, ...privateCalibrationEvidence(collision) }), { code: "GRADER_IDENTITY_COLLISION" });
});

test("calibration publication rejects manufactured, incomplete, or stale external evidence", () => {
  const packages = privateCalibrationPackages();
  const evidence = privateCalibrationEvidence(packages);
  const incompleteMaterial = { ...evidence.semanticReview, pairs: evidence.semanticReview.pairs.slice(1) };
  delete incompleteMaterial.digest;
  const incompleteReview = { ...incompleteMaterial, digest: canonicalDigest(incompleteMaterial) };
  assert.throws(() => createCalibrationTrancheRelease({ packages, concepts: CALIBRATION_CONCEPTS, accessEvidence: evidence.accessEvidence, semanticReview: incompleteReview }), { code: "SEMANTIC_INDEPENDENCE_REVIEW_FAILED" });

  const staleMaterial = structuredClone(evidence.accessEvidence);
  staleMaterial.entries[0].at = "2026-08-05T12:00:00Z";
  delete staleMaterial.digest;
  const staleAccess = { ...staleMaterial, digest: canonicalDigest(staleMaterial) };
  assert.throws(() => createCalibrationTrancheRelease({ packages, concepts: CALIBRATION_CONCEPTS, accessEvidence: staleAccess, semanticReview: evidence.semanticReview }), { code: "INVALID_ACCESS_EVIDENCE" });

  const revisedPackages = [...packages];
  const revisedTask = reviseTask(revisedPackages[0].task, { determinism: { ...revisedPackages[0].task.determinism, seed: revisedPackages[0].task.determinism.seed + 1 } });
  revisedPackages[0] = createTaskPackage({ task: revisedTask, graderBundle: revisedPackages[0].graderBundle, assets: revisedPackages[0].assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes, "base64") })) });
  assert.throws(() => createCalibrationTrancheRelease({ packages: revisedPackages, concepts: CALIBRATION_CONCEPTS, ...privateCalibrationEvidence(revisedPackages) }), { code: "PRIOR_EVIDENCE_TASK_REUSE" });
});

test("calibration artifact check rejects every entry outside the exact public projection set", async (context) => {
  const privateRoot = await mkdtemp(resolve(tmpdir(), "nelos-calibration-private-"));
  const artifactRoot = await mkdtemp(resolve(tmpdir(), "nelos-calibration-artifacts-"));
  context.after(async () => Promise.all([rm(privateRoot, { recursive: true, force: true }), rm(artifactRoot, { recursive: true, force: true })]));
  await writePrivateCalibrationRoot(privateRoot);
  const { files } = await buildCalibrationRelease({ privateRoot });
  await Promise.all([...files].map(([path, bytes]) => writeFile(resolve(artifactRoot, path), bytes)));
  await buildCalibrationRelease({ privateRoot, check: true, committedArtifactRoot: artifactRoot });
  await writeFile(resolve(artifactRoot, "operator-notes.txt"), "must not be accepted");
  await assert.rejects(() => buildCalibrationRelease({ privateRoot, check: true, committedArtifactRoot: artifactRoot }), { code: "PUBLIC_PROJECTION_MEMBERSHIP_MISMATCH" });
  await rm(resolve(artifactRoot, "operator-notes.txt"));
  await mkdir(resolve(artifactRoot, "private-material"));
  await assert.rejects(() => buildCalibrationRelease({ privateRoot, check: true, committedArtifactRoot: artifactRoot }), { code: "PUBLIC_PROJECTION_MEMBERSHIP_MISMATCH" });
});

test("private calibration material overlap and symlinks fail closed", async () => {
  await assert.rejects(() => resolvePrivateRoot(REPOSITORY_ROOT), { code: "PRIVATE_ROOT_OVERLAPS_REPOSITORY" });
  const realRoot = await mkdtemp(resolve(tmpdir(), "nelos-calibration-real-"));
  await writePrivateCalibrationRoot(realRoot);
  const linkRoot = `${realRoot}-link`;
  await symlink(realRoot, linkRoot, "dir");
  await assert.rejects(() => resolvePrivateRoot(linkRoot), { code: "UNSAFE_PRIVATE_ROOT" });

  const unsafeRoot = await mkdtemp(resolve(tmpdir(), "nelos-calibration-unsafe-"));
  const material = await loadPrivateMaterial(realRoot);
  await writeFile(resolve(unsafeRoot, "private-manifest.json"), await readFile(resolve(realRoot, "private-manifest.json")));
  await writeFile(resolve(unsafeRoot, "access-evidence.json"), await readFile(resolve(realRoot, "access-evidence.json")));
  await writeFile(resolve(unsafeRoot, "semantic-pair-review.json"), await readFile(resolve(realRoot, "semantic-pair-review.json")));
  await symlink(resolve(realRoot, "packages"), resolve(unsafeRoot, "packages"), "dir");
  await assert.rejects(() => loadPrivateMaterial(unsafeRoot), { code: "UNSAFE_PRIVATE_PACKAGES" });
});

test("tracked public calibration projections contain no hidden grading material", async () => {
  const paths = (await readdir(COMMITTED_ARTIFACT_ROOT)).filter((path) => path.endsWith(".json"));
  assert.deepEqual(paths.sort(), ["contamination-summary.json", "independence-summary.json", "release-lock.json", "schedule.json", "validation-summary.json"]);
  for (const path of paths) {
    const fileText = await readFile(resolve(COMMITTED_ARTIFACT_ROOT, path), "utf8");
    assert.doesNotMatch(fileText, /"(?:assets|bytes|graderBundle|implementationDigest|oracle|rubric)"\s*:/u, path);
    assert.doesNotMatch(fileText, /"encoding"\s*:\s*"base64"/u, path);
  }
  const tracked = (await executeFile("git", ["ls-files"], { cwd: REPOSITORY_ROOT })).stdout.split("\n");
  assert.equal(tracked.some((path) => /calibration-tranche-1\/(?:packages|candidate-envelopes|private-material)\//u.test(path)), false);
});

test("npm/plugin payload excludes calibration and keeps the 0.12.14 release invariant", async () => {
  const packageMetadata = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "package.json"), "utf8"));
  const plugin = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, ".codex-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, ".mcp.json"), "utf8"));
  assert.equal(packageMetadata.version, "0.12.14");
  assert.equal(plugin.version, "0.12.14");
  assert.equal(plugin.releaseBuildIdentity, "nelos-release-v1:0.12.14");
  assert.equal(mcp.mcpServers.nelos.env.NELOS_PLUGIN_VERSION, "0.12.14");
  assert.equal(mcp.mcpServers.nelos.env.NELOS_RELEASE_BUILD_IDENTITY, "nelos-release-v1:0.12.14");
  assert.equal(packageMetadata.files.some((path) => path.startsWith("experiments")), false);
  assert.equal(packageMetadata.scripts["calibration:build"], undefined);
  const packed = JSON.parse((await executeFile("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPOSITORY_ROOT })).stdout)[0];
  assert.equal(packed.files.some(({ path }) => path.startsWith("experiments/")), false);
  assert.equal(packed.files.some(({ path }) => path.includes("calibration-tranche-1")), false);
  assert.deepEqual(validatePluginReleaseChange({ baseVersion: "0.12.9", candidateVersion: "0.12.9", baseCacheIdentity: "same", candidateCacheIdentity: "same", payloadChanged: false }), { changed: false, version: "0.12.9", cacheIdentity: "same" });
  assert.throws(() => validatePluginReleaseChange({ baseVersion: "0.12.9", candidateVersion: "0.12.9", baseCacheIdentity: "same", candidateCacheIdentity: "same", payloadChanged: true }), /without a version bump/u);
});
