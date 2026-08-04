import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { canonicalDigest, sha256Bytes } from "../src/experimentation-contract/index.mjs";
import { expandExperimentPlan } from "../src/experiment-runner.mjs";
import { executeApiBaselineAttempt } from "../src/api-baseline-adapter.mjs";
import { startApiReceiptProxy } from "../src/api-baseline-receipt-proxy.mjs";
import { writeApiBaselineResearchPacket } from "../src/api-baseline-research-packet.mjs";
import { createSignedInPilotManifest } from "../scripts/build-signed-in-pilot.mjs";
import { API_BASELINE_CANDIDATES, API_BASELINE_FAMILIES, API_BASELINE_RUN_PREFIX, CANARY_CEILINGS, createApiBaselineBundle, createAuthorizedConfirmatoryPlan, evaluateConfirmatoryAuthorization, measureRuntimeProvenance, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";
import { readApiProviderExchanges, recordApiProviderExchange, safeApiRuntimeError } from "../src/api-baseline-runtime.mjs";

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
    executableResolver: async () => executablePath,
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
});

test("Nelos candidates and sealed canary expansion remain rejected", () => {
  const input = structuredClone(bundle()); input.runnerManifest.experiment.candidates[0].candidateId = "candidate:nelos-forbidden";
  assert.throws(() => validateApiBaselineBundle(input), { code: "INVALID_API_BASELINE_ARM" });
  const expanded = structuredClone(bundle()); expanded.controls.sealedTrialCount = 6; const material = { ...expanded }; delete material.bundleDigest; expanded.bundleDigest = canonicalDigest(material);
  assert.throws(() => validateApiBaselineBundle(expanded), { code: "API_BASELINE_CEILING_EXCEEDED" });
});
