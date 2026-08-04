import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalBytes, canonicalDigest, sha256Bytes } from "./experimentation-contract/index.mjs";
import { candidateTaskEnvelope, createStarterTaskPackage, gradeTaskAttempt, STARTER_TASK_FAMILIES } from "./experimentation-corpus/index.mjs";
import { resolveExecutable, withDisposableApiAttempt } from "./api-baseline-runtime.mjs";
import { CANARY_CEILINGS } from "./api-baseline-harness.mjs";
import { startApiReceiptProxy } from "./api-baseline-receipt-proxy.mjs";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) fail(code);
}
function expectedCost(usage, snapshot) {
  const long = usage.inputTokens > snapshot.longContextThresholdTokens;
  const uncached = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  const inputRate = long ? snapshot.longContextInputUsdPerMillionTokens : snapshot.inputUsdPerMillionTokens;
  const cachedRate = long ? snapshot.longContextCachedInputUsdPerMillionTokens : snapshot.cachedInputUsdPerMillionTokens;
  const writeRate = long ? snapshot.longContextCacheWriteUsdPerMillionTokens : snapshot.cacheWriteUsdPerMillionTokens;
  const outputRate = long ? snapshot.longContextOutputUsdPerMillionTokens : snapshot.outputUsdPerMillionTokens;
  return Number(((uncached * inputRate + usage.cachedInputTokens * cachedRate + usage.cacheWriteInputTokens * writeRate + usage.outputTokens * outputRate) / 1_000_000).toFixed(12));
}
function validatePricingSnapshot(snapshot, request) {
  exact(snapshot, ["schemaVersion", "provider", "capturedAt", "sourceUrl", "modelId", "currency", "serviceTier", "longContextThresholdTokens", "inputUsdPerMillionTokens", "cachedInputUsdPerMillionTokens", "cacheWriteUsdPerMillionTokens", "outputUsdPerMillionTokens", "longContextInputUsdPerMillionTokens", "longContextCachedInputUsdPerMillionTokens", "longContextCacheWriteUsdPerMillionTokens", "longContextOutputUsdPerMillionTokens"], "ATTEMPT_CONTROL_INVALID");
  if (snapshot.schemaVersion !== 1 || snapshot.provider !== "openai" || snapshot.modelId !== request.requestedRoute.modelId || snapshot.currency !== "USD" || snapshot.serviceTier !== "default" || snapshot.longContextThresholdTokens !== 272000 || !Number.isFinite(Date.parse(snapshot.capturedAt)) || !/^https:\/\/(?:[^/]+\.)?openai\.com\//u.test(snapshot.sourceUrl)
    || [snapshot.inputUsdPerMillionTokens, snapshot.cachedInputUsdPerMillionTokens, snapshot.cacheWriteUsdPerMillionTokens, snapshot.outputUsdPerMillionTokens, snapshot.longContextInputUsdPerMillionTokens, snapshot.longContextCachedInputUsdPerMillionTokens, snapshot.longContextCacheWriteUsdPerMillionTokens, snapshot.longContextOutputUsdPerMillionTokens].some((value) => !Number.isFinite(value) || value < 0)) fail("ATTEMPT_CONTROL_INVALID");
}

function packageFor(taskId) {
  for (const family of STARTER_TASK_FAMILIES) { const value = createStarterTaskPackage(family.id); if (value.task.taskId === taskId) return value; }
  fail("UNKNOWN_SEALED_TASK");
}

async function stage(workspace, value) {
  const envelope = candidateTaskEnvelope(value);
  await mkdir(resolve(workspace, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(workspace, "candidate-task.json"), canonicalBytes(envelope), { mode: 0o600 });
  for (const asset of envelope.assets) await writeFile(resolve(workspace, "assets", `${asset.assetId.split(":").at(-1)}.json`), Buffer.from(asset.bytes, "base64"), { mode: 0o600 });
  await writeFile(resolve(workspace, "output-schema.json"), canonicalBytes({ type: "object", additionalProperties: false, required: ["answer", "family"], properties: { answer: { type: "string" }, family: { type: "string" } } }), { mode: 0o600 });
  await writeFile(resolve(workspace, "task-prompt.txt"), `${value.task.prompt.text}\nUse only candidate-task.json and assets/. Return only the required JSON object. Do not access paths outside this disposable workspace.\n`, { mode: 0o600 });
}

export function runCapturedProcess(command, args, { env, cwd, input, timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = []; let captured = 0; let timedOut = false;
    const capture = (target) => (chunk) => { captured += chunk.byteLength; if (captured > MAX_CAPTURE_BYTES) child.kill("SIGTERM"); else target.push(chunk); };
    child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
    child.once("error", () => reject(Object.assign(new Error("API_CODEX_PROCESS_FAILED"), { code: "API_CODEX_PROCESS_FAILED" })));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.once("close", (code) => { clearTimeout(timer); resolveRun({ code, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
    child.stdin.end(input);
  });
}

export function validateAttemptControl(request, now = Date.now()) {
  if (request?.schemaVersion !== 1 || request.attempt !== 1 || typeof request.runId !== "string" || typeof request.trialId !== "string" || typeof request.operationId !== "string") fail("ATTEMPT_CONTROL_INVALID");
  exact(request.lease, ["leaseId", "owner", "fencingToken", "acquiredAt", "expiresAt"], "ATTEMPT_CONTROL_INVALID");
  const expectedOperation = `op:${canonicalDigest({ runId: request.runId, trialId: request.trialId, attempt: request.attempt }).slice(7)}`;
  const expectedLeaseId = `lease:${expectedOperation.slice(3)}`;
  const expectedFence = canonicalDigest({ runId: request.runId, trialId: request.trialId, attempt: request.attempt, operationId: expectedOperation, leaseId: expectedLeaseId });
  const acquired = Date.parse(request.lease.acquiredAt); const expires = Date.parse(request.lease.expiresAt);
  if (request.operationId !== expectedOperation || request.lease.leaseId !== expectedLeaseId || request.lease.fencingToken !== expectedFence || request.lease.owner !== `controller:${request.runId}`
    || !Number.isFinite(acquired) || !Number.isFinite(expires) || acquired > now || expires <= now || expires <= acquired) fail("ATTEMPT_CONTROL_INVALID");
  return { expectedOperation, expectedLeaseId, expectedFence };
}

function validateReceipt(receipt, { request, executableDigest, executableBytes }) {
  exact(receipt, ["schemaVersion", "operationId", "leaseId", "fencingToken", "attempt", "route", "provider", "executable"], "RUNTIME_RECEIPT_INVALID");
  exact(receipt.route, ["candidateId", "adapter", "modelId", "modelRevision", "reasoningEffort", "pluginDigest", "observedModelId", "observedModelRevision", "forwardedReasoningEffort", "forwardedServiceTier"], "RUNTIME_RECEIPT_INVALID");
  exact(receipt.provider, ["executionCount", "retryCount", "requestCount", "logicalTurnCount", "estimatedCostUsd", "costStatus", "pricingSnapshotDigest", "exchanges", "usage"], "RUNTIME_RECEIPT_INVALID");
  exact(receipt.provider.usage, ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"], "RUNTIME_RECEIPT_INVALID");
  exact(receipt.executable, ["digest", "byteLength"], "RUNTIME_RECEIPT_INVALID");
  if (receipt.schemaVersion !== 1 || receipt.operationId !== request.operationId || receipt.leaseId !== request.lease.leaseId || receipt.fencingToken !== request.lease.fencingToken || receipt.attempt !== request.attempt) fail("RUNTIME_RECEIPT_INVALID");
  if (Object.entries(request.requestedRoute).some(([field, value]) => receipt.route[field] !== value)
    || receipt.route.forwardedReasoningEffort !== request.requestedRoute.reasoningEffort || receipt.route.forwardedServiceTier !== "default"
    || receipt.route.observedModelId !== `model:${receipt.route.observedModelRevision}`
    || (receipt.route.observedModelRevision !== request.requestedRoute.modelId.slice("model:".length) && !receipt.route.observedModelRevision.startsWith(`${request.requestedRoute.modelId.slice("model:".length)}-`))) fail("RUNTIME_ROUTE_MISMATCH");
  if (receipt.executable.digest !== executableDigest || receipt.executable.byteLength !== executableBytes) fail("RUNTIME_PROVENANCE_MISMATCH");
  const ceiling = request.exposureCeilings;
  if (!Array.isArray(receipt.provider.exchanges) || receipt.provider.exchanges.length === 0 || receipt.provider.exchanges.length !== receipt.provider.requestCount) fail("RUNTIME_RECEIPT_INVALID");
  const aggregateUsage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  let aggregateCost = 0;
  const requestIds = new Set(); const responseIds = new Set();
  for (const [index, exchange] of receipt.provider.exchanges.entries()) {
    exact(exchange, ["schemaVersion", "operationId", "trialId", "attempt", "exchangeOrdinal", "requestId", "responseId", "observedModelRevision", "serviceTier", "usage", "estimatedCostUsd", "pricingSnapshotDigest", "exchangeDigest"], "RUNTIME_RECEIPT_INVALID");
    exact(exchange.usage, ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"], "RUNTIME_RECEIPT_INVALID");
    const material = { ...exchange }; delete material.exchangeDigest;
    if (exchange.schemaVersion !== 1 || exchange.operationId !== request.operationId || exchange.trialId !== request.trialId || exchange.attempt !== request.attempt || exchange.exchangeOrdinal !== index + 1 || exchange.observedModelRevision !== receipt.route.observedModelRevision || exchange.serviceTier !== "default" || exchange.pricingSnapshotDigest !== canonicalDigest(request.pricingSnapshot) || canonicalDigest(material) !== exchange.exchangeDigest || requestIds.has(exchange.requestId) || responseIds.has(exchange.responseId) || typeof exchange.requestId !== "string" || !exchange.requestId || typeof exchange.responseId !== "string" || !exchange.responseId || exchange.estimatedCostUsd !== expectedCost(exchange.usage, request.pricingSnapshot)) fail("RUNTIME_RECEIPT_INVALID");
    requestIds.add(exchange.requestId); responseIds.add(exchange.responseId); aggregateCost += exchange.estimatedCostUsd;
    for (const field of Object.keys(aggregateUsage)) aggregateUsage[field] += exchange.usage[field];
  }
  aggregateCost = Number(aggregateCost.toFixed(12));
  if (receipt.provider.executionCount !== 1 || receipt.provider.executionCount > ceiling.providerExecutionsPerTrial || receipt.provider.retryCount !== 0 || receipt.provider.retryCount > ceiling.providerRetriesPerTrial || receipt.provider.requestCount > ceiling.providerRequestsPerTrial || receipt.provider.logicalTurnCount !== receipt.provider.requestCount
    || receipt.provider.estimatedCostUsd !== aggregateCost || receipt.provider.estimatedCostUsd > ceiling.maxEstimatedCostUsdPerTrial || receipt.provider.costStatus !== "computed-from-snapshot" || receipt.provider.pricingSnapshotDigest !== canonicalDigest(request.pricingSnapshot) || Object.keys(aggregateUsage).some((field) => receipt.provider.usage[field] !== aggregateUsage[field]) || receipt.provider.usage.outputTokens > ceiling.outputTokenBudgetPerTrial
    || Object.values(receipt.provider.usage).some((value) => !Number.isSafeInteger(value) || value < 0) || receipt.provider.usage.cachedInputTokens + receipt.provider.usage.cacheWriteInputTokens > receipt.provider.usage.inputTokens || receipt.provider.usage.reasoningOutputTokens > receipt.provider.usage.outputTokens || receipt.provider.usage.totalTokens !== receipt.provider.usage.inputTokens + receipt.provider.usage.outputTokens) fail("PROVIDER_EXPOSURE_EXCEEDED");
  return receipt;
}

export async function executeApiBaselineAttempt({
  request,
  loadCredential,
  claimOperation,
  processRunner = runCapturedProcess,
  attemptBoundary = withDisposableApiAttempt,
  executableResolver = resolveExecutable,
  executableReader = readFile,
  receiptProxyFactory = startApiReceiptProxy,
  recordProviderExchange = async () => {},
  now = () => Date.now(),
}) {
  validateAttemptControl(request, now());
  validatePricingSnapshot(request.pricingSnapshot, request);
  if (canonicalDigest(request.exposureCeilings) !== canonicalDigest(CANARY_CEILINGS) || request.budget.tokenBudget > CANARY_CEILINGS.outputTokenBudgetPerTrial || request.budget.wallClockSeconds > CANARY_CEILINGS.wallClockSecondsPerTrial) fail("PROVIDER_EXPOSURE_EXCEEDED");
  if (typeof claimOperation !== "function") fail("ATTEMPT_CONTROL_INVALID");
  await claimOperation(request);
  const sealed = packageFor(request.declaredInputs.taskId);
  if (sealed.task.digest !== request.declaredInputs.taskDigest || request.budget.networkRequests !== 0 || request.exposureCeilings.candidateNetworkRequestsPerTrial !== 0) fail("SEALED_REQUEST_MISMATCH");
  const executablePath = await executableResolver(request.runtimeProvenance.executablePath);
  const executable = await executableReader(executablePath); const executableDigest = sha256Bytes(executable); const executableBytes = executable.byteLength;
  const provenanceMaterial = { ...request.runtimeProvenance }; delete provenanceMaterial.receiptDigest;
  if (canonicalDigest(provenanceMaterial) !== request.runtimeProvenance.receiptDigest || request.runtimeProvenance.executablePath !== executablePath || request.runtimeProvenance.executableDigest !== executableDigest || request.runtimeProvenance.byteLength !== executableBytes) fail("RUNTIME_PROVENANCE_MISMATCH");
  return attemptBoundary({ loadCredential, execute: async ({ workspace, env }) => {
    await stage(workspace, sealed);
    await processRunner("git", ["init", "-q"], { env, cwd: workspace, input: "", timeoutMs: 10000, outputPath: null });
    const outputPath = resolve(workspace, "result.json"); const model = request.requestedRoute.modelId.slice("model:".length);
    const proxy = await receiptProxyFactory({ apiKey: env.OPENAI_API_KEY, request, executable: { digest: executableDigest, byteLength: executableBytes }, recordExchange: recordProviderExchange });
    const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", workspace, "-m", model,
      "-c", `model_reasoning_effort=${JSON.stringify(request.requestedRoute.reasoningEffort)}`,
      "-c", `model_provider=${JSON.stringify("nelos_proxy")}`,
      "-c", `model_providers.nelos_proxy.name=${JSON.stringify("Nelos receipt proxy")}`,
      "-c", `model_providers.nelos_proxy.base_url=${JSON.stringify(proxy.baseUrl)}`,
      "-c", `model_providers.nelos_proxy.env_key=${JSON.stringify("OPENAI_API_KEY")}`,
      "-c", `model_providers.nelos_proxy.wire_api=${JSON.stringify("responses")}`,
      "-c", "model_providers.nelos_proxy.request_max_retries=0",
      "-c", "model_providers.nelos_proxy.stream_max_retries=0",
      "-c", "model_providers.nelos_proxy.supports_websockets=false",
      "--output-schema", resolve(workspace, "output-schema.json"), "-o", outputPath, "-"];
    const started = now();
    let result; let unvalidatedReceipt;
    try {
      result = await processRunner(executablePath, args, { env, cwd: workspace, input: await readFile(resolve(workspace, "task-prompt.txt")), timeoutMs: request.budget.wallClockSeconds * 1000, outputPath, request });
      unvalidatedReceipt = await proxy.finish();
    } catch (error) { await proxy.abort?.().catch(() => {}); throw error; }
    const receipt = validateReceipt(unvalidatedReceipt, { request, executableDigest, executableBytes });
    let value = {}; try { value = JSON.parse(await readFile(outputPath, "utf8")); } catch {}
    const output = canonicalBytes(value);
    const grade = gradeTaskAttempt({ taskPackage: sealed, submission: { outputs: [{ id: "result", encoding: "base64", bytes: output.toString("base64") }] }, observation: { attemptId: `${request.operationId}:candidate`, contaminated: false, termination: result.timedOut ? "timeout" : "exited", exitCode: result.code ?? 1 }, attestation: { issuer: "nelos-host-runtime", candidateEnvironmentId: `disposable:${request.trialId}:${request.attempt}`, graderEnvironmentId: "host-grader:api-baseline" } });
    const receiptBytes = canonicalBytes(receipt);
    const gradeBytes = canonicalBytes(grade);
    return { outcome: result.code === 0 ? "succeeded" : "failed", observedRoute: { ...receipt.route }, operationId: receipt.operationId, outputs: [{ id: "result", digest: sha256Bytes(output), byteLength: output.byteLength }], artifacts: [{ id: "runtime-provider-receipt", mediaType: "application/json", encoding: "base64", bytes: receiptBytes.toString("base64"), digest: sha256Bytes(receiptBytes), byteLength: receiptBytes.byteLength }, { id: "machine-grade", mediaType: "application/json", encoding: "base64", bytes: gradeBytes.toString("base64"), digest: sha256Bytes(gradeBytes), byteLength: gradeBytes.byteLength }], measurements: [{ metricId: "strict_pass_rate", value: grade.strictPass ? 1 : 0 }, { metricId: "candidate_failure_rate", value: result.code === 0 ? 0 : 1 }, { metricId: "terminal_wall_ms", value: now() - started }, { metricId: "input_tokens", value: receipt.provider.usage.inputTokens }, { metricId: "cached_input_tokens", value: receipt.provider.usage.cachedInputTokens }, { metricId: "cache_write_input_tokens", value: receipt.provider.usage.cacheWriteInputTokens }, { metricId: "output_tokens", value: receipt.provider.usage.outputTokens }, { metricId: "reasoning_output_tokens", value: receipt.provider.usage.reasoningOutputTokens }, { metricId: "total_tokens", value: receipt.provider.usage.totalTokens }, { metricId: "provider_executions", value: receipt.provider.executionCount }, { metricId: "provider_retries", value: receipt.provider.retryCount }, { metricId: "provider_requests", value: receipt.provider.requestCount }, { metricId: "estimated_cost_usd", value: receipt.provider.estimatedCostUsd }, { metricId: "runtime_receipt_digest_numeric", value: Number.parseInt(canonicalDigest(receipt).slice(7, 19), 16) }], evidenceComplete: true, retryable: false };
  } });
}
