import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { canonicalDigest } from "./experimentation-contract/index.mjs";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "content-length", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function safeEqual(left, right) {
  const a = Buffer.from(left ?? "", "utf8");
  const b = Buffer.from(right ?? "", "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
function modelSlug(request) {
  const value = request?.requestedRoute?.modelId;
  if (typeof value !== "string" || !value.startsWith("model:")) fail("PROXY_ROUTE_INVALID");
  return value.slice("model:".length);
}
function observedModelMatches(requested, observed) {
  return observed === requested || observed.startsWith(`${requested}-`);
}
function responseDetails(value) {
  const response = value?.response && typeof value.response === "object" ? value.response : value;
  if (!response || typeof response !== "object") return null;
  if (typeof response.id !== "string" || typeof response.model !== "string" || !response.usage || typeof response.usage !== "object") return null;
  return response;
}
function publicUsage(usage) {
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  const total = Number(usage.total_tokens);
  if (![input, output, total].every((value) => Number.isSafeInteger(value) && value >= 0)) fail("PROXY_RECEIPT_INCOMPLETE");
  const cached = Number(usage.input_tokens_details?.cached_tokens ?? 0);
  const cacheWrite = Number(usage.input_tokens_details?.cache_write_tokens ?? 0);
  const reasoning = Number(usage.output_tokens_details?.reasoning_tokens ?? 0);
  if (![cached, cacheWrite, reasoning].every((value) => Number.isSafeInteger(value) && value >= 0) || cached + cacheWrite > input || reasoning > output || total !== input + output) fail("PROXY_RECEIPT_INCOMPLETE");
  return Object.freeze({ inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: cacheWrite, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: total });
}
function estimatedCost(usage, snapshot) {
  const long = usage.inputTokens > snapshot.longContextThresholdTokens;
  const uncached = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  const inputRate = long ? snapshot.longContextInputUsdPerMillionTokens : snapshot.inputUsdPerMillionTokens;
  const cachedRate = long ? snapshot.longContextCachedInputUsdPerMillionTokens : snapshot.cachedInputUsdPerMillionTokens;
  const writeRate = long ? snapshot.longContextCacheWriteUsdPerMillionTokens : snapshot.cacheWriteUsdPerMillionTokens;
  const outputRate = long ? snapshot.longContextOutputUsdPerMillionTokens : snapshot.outputUsdPerMillionTokens;
  const value = (uncached * inputRate + usage.cachedInputTokens * cachedRate + usage.cacheWriteInputTokens * writeRate + usage.outputTokens * outputRate) / 1_000_000;
  return Number(value.toFixed(12));
}
function parseSseChunk(state, chunk) {
  state.buffer += chunk;
  const records = state.buffer.split(/\r?\n\r?\n/u);
  state.buffer = records.pop() ?? "";
  for (const record of records) {
    const data = record.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    let event; try { event = JSON.parse(data); } catch { fail("PROXY_UPSTREAM_RESPONSE_INVALID"); }
    if (event.type === "response.completed") state.completed = responseDetails(event);
  }
}
function forwardedHeaders(headers, credential, byteLength) {
  const result = { authorization: `Bearer ${credential}`, "content-length": String(byteLength), "accept-encoding": "identity" };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "authorization" || lower === "accept-encoding" || value === undefined) continue;
    result[lower] = value;
  }
  return result;
}
function downstreamHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "set-cookie" || value === undefined) continue;
    result[lower] = value;
  }
  return result;
}
async function readBounded(stream) {
  const chunks = []; let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > MAX_REQUEST_BYTES) fail("PROXY_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startApiReceiptProxy({ apiKey, request, executable, recordExchange = async () => {}, upstreamBaseUrl = "https://api.openai.com", host = "127.0.0.1" }) {
  if (host !== "127.0.0.1" || typeof apiKey !== "string" || !apiKey) fail("PROXY_CONFIGURATION_INVALID");
  const requestedModel = modelSlug(request);
  const requestedEffort = request.requestedRoute.reasoningEffort;
  const maximumRequests = request.exposureCeilings?.providerRequestsPerTrial;
  const maximumOutputTokens = request.exposureCeilings?.outputTokenBudgetPerTrial;
  if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1 || !Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 1 || typeof recordExchange !== "function") fail("PROXY_CONFIGURATION_INVALID");
  const upstream = new URL(upstreamBaseUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) fail("PROXY_CONFIGURATION_INVALID");
  let credential = apiKey;
  let inboundCount = 0;
  let upstreamCount = 0;
  const exchanges = [];
  let failureCode = null;
  let activeUpstream = null;
  let requestActive = false;

  const server = createServer(async (incoming, downstream) => {
    inboundCount += 1;
    try {
      if (failureCode) fail(failureCode);
      if (requestActive) fail("PROXY_CONCURRENT_REQUESTS");
      if (inboundCount > maximumRequests) fail("PROXY_REQUEST_LIMIT_EXCEEDED");
      requestActive = true;
      if (incoming.method !== "POST" || incoming.url !== "/v1/responses") fail("PROXY_REQUEST_REJECTED");
      if (!safeEqual(incoming.headers.authorization, `Bearer ${credential}`)) fail("PROXY_AUTH_REJECTED");
      const body = await readBounded(incoming);
      let payload; try { payload = JSON.parse(body.toString("utf8")); } catch { fail("PROXY_REQUEST_INVALID"); }
      if (payload.model !== requestedModel || payload.reasoning?.effort !== requestedEffort) fail("PROXY_ROUTE_MISMATCH");
      if (payload.service_tier !== undefined && payload.service_tier !== "default") fail("PROXY_ROUTE_MISMATCH");
      const usedOutputTokens = exchanges.reduce((sum, exchange) => sum + exchange.usage.outputTokens, 0);
      const remainingOutputTokens = maximumOutputTokens - usedOutputTokens;
      if (remainingOutputTokens < 1) fail("PROVIDER_EXPOSURE_EXCEEDED");
      payload.service_tier = "default";
      if (!Number.isSafeInteger(payload.max_output_tokens) || payload.max_output_tokens < 1 || payload.max_output_tokens > remainingOutputTokens) payload.max_output_tokens = remainingOutputTokens;
      const forwardBody = Buffer.from(JSON.stringify(payload), "utf8");
      if (forwardBody.byteLength > MAX_REQUEST_BYTES) fail("PROXY_REQUEST_TOO_LARGE");
      upstreamCount += 1;
      const target = new URL(`${upstream.pathname.replace(/\/$/u, "")}/v1/responses`, upstream);
      const state = { buffer: "", completed: null, responseBytes: 0, parseError: null };
      const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
      await new Promise((resolveForward, rejectForward) => {
        const forwarded = transport(target, { method: "POST", headers: forwardedHeaders(incoming.headers, credential, forwardBody.byteLength) }, (provider) => {
          const responseStatus = provider.statusCode ?? 0;
          const requestId = typeof provider.headers["x-request-id"] === "string" ? provider.headers["x-request-id"] : null;
          const responseChunks = [];
          provider.on("data", (chunk) => {
            state.responseBytes += chunk.byteLength;
            if (state.responseBytes > MAX_RESPONSE_BYTES) {
              state.parseError = Object.assign(new Error("PROXY_UPSTREAM_RESPONSE_TOO_LARGE"), { code: "PROXY_UPSTREAM_RESPONSE_TOO_LARGE" });
              provider.destroy(state.parseError);
              return;
            }
            responseChunks.push(chunk);
            if (String(provider.headers["content-type"] ?? "").includes("text/event-stream")) {
              try { parseSseChunk(state, chunk.toString("utf8")); } catch (error) { state.parseError = error; }
            }
          });
          provider.once("end", async () => {
            try {
              if (state.parseError) throw state.parseError;
              if (state.buffer.trim()) parseSseChunk(state, "\n\n");
              if (!String(provider.headers["content-type"] ?? "").includes("text/event-stream")) {
                let value; try { value = JSON.parse(Buffer.concat(responseChunks).toString("utf8")); } catch { fail("PROXY_UPSTREAM_RESPONSE_INVALID"); }
                state.completed = responseDetails(value);
              }
              const completed = state.completed;
              if (responseStatus < 200 || responseStatus >= 300) fail("PROXY_UPSTREAM_REJECTED");
              if (!completed || completed.status !== "completed" || completed.service_tier !== "default" || !requestId) fail("PROXY_RECEIPT_INCOMPLETE");
              if (!observedModelMatches(requestedModel, completed.model)) fail("PROXY_OBSERVED_MODEL_MISMATCH");
              if (exchanges.some((exchange) => exchange.requestId === requestId || exchange.responseId === completed.id)) fail("PROXY_RECEIPT_INCOMPLETE");
              const usage = publicUsage(completed.usage);
              const exchangeMaterial = {
                schemaVersion: 1,
                operationId: request.operationId,
                trialId: request.trialId,
                attempt: request.attempt,
                exchangeOrdinal: exchanges.length + 1,
                requestId,
                responseId: completed.id,
                observedModelRevision: completed.model,
                serviceTier: completed.service_tier,
                usage,
                estimatedCostUsd: estimatedCost(usage, request.pricingSnapshot),
                pricingSnapshotDigest: canonicalDigest(request.pricingSnapshot),
              };
              const exchange = Object.freeze({ ...exchangeMaterial, exchangeDigest: canonicalDigest(exchangeMaterial) });
              await recordExchange(exchange);
              exchanges.push(exchange);
              const aggregateOutput = exchanges.reduce((sum, item) => sum + item.usage.outputTokens, 0);
              const aggregateCost = Number(exchanges.reduce((sum, item) => sum + item.estimatedCostUsd, 0).toFixed(12));
              if (aggregateOutput > maximumOutputTokens || aggregateCost > request.exposureCeilings.maxEstimatedCostUsdPerTrial) fail("PROVIDER_EXPOSURE_EXCEEDED");
              downstream.writeHead(responseStatus, downstreamHeaders(provider.headers));
              downstream.end(Buffer.concat(responseChunks));
              resolveForward();
            } catch (error) { rejectForward(error); }
          });
          provider.once("error", rejectForward);
        });
        activeUpstream = forwarded;
        forwarded.once("error", rejectForward);
        forwarded.end(forwardBody);
      });
    } catch (error) {
      failureCode = error?.code ?? "PROXY_FORWARD_FAILED";
      if (!downstream.headersSent) downstream.writeHead(["PROXY_REQUEST_LIMIT_EXCEEDED", "PROXY_CONCURRENT_REQUESTS"].includes(failureCode) ? 409 : 400, { "content-type": "application/json" });
      if (!downstream.writableEnded) downstream.end(JSON.stringify({ error: "request rejected" }));
    } finally { activeUpstream = null; requestActive = false; }
  });
  server.on("clientError", (error, socket) => { failureCode = error?.code ?? "PROXY_REQUEST_INVALID"; socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, () => { server.off("error", rejectListen); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== host) { server.close(); fail("PROXY_CONFIGURATION_INVALID"); }

  return Object.freeze({
    baseUrl: `http://${host}:${address.port}/v1`,
    async abort() {
      activeUpstream?.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
      credential = "";
    },
    async finish() {
      await new Promise((resolveClose) => server.close(resolveClose));
      credential = "";
      if (failureCode) fail(failureCode);
      if (inboundCount === 0) fail("PROXY_REQUEST_NOT_OBSERVED");
      if (upstreamCount === 0) fail("PROXY_UPSTREAM_NOT_OBSERVED");
      if (inboundCount !== upstreamCount || upstreamCount !== exchanges.length || exchanges.length > maximumRequests) fail("PROXY_RECEIPT_INCOMPLETE");
      const revisions = new Set(exchanges.map(({ observedModelRevision }) => observedModelRevision));
      if (revisions.size !== 1) fail("PROXY_OBSERVED_MODEL_MISMATCH");
      const usage = Object.freeze(exchanges.reduce((sum, exchange) => {
        for (const field of Object.keys(sum)) sum[field] += exchange.usage[field];
        return sum;
      }, { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }));
      const observedModelRevision = exchanges[0].observedModelRevision;
      const pricingSnapshotDigest = canonicalDigest(request.pricingSnapshot);
      return Object.freeze({
        schemaVersion: 1,
        operationId: request.operationId,
        leaseId: request.lease.leaseId,
        fencingToken: request.lease.fencingToken,
        attempt: request.attempt,
        route: Object.freeze({ ...request.requestedRoute, observedModelId: `model:${observedModelRevision}`, observedModelRevision, forwardedReasoningEffort: requestedEffort, forwardedServiceTier: "default" }),
        provider: Object.freeze({ executionCount: 1, retryCount: 0, requestCount: exchanges.length, logicalTurnCount: exchanges.length, estimatedCostUsd: Number(exchanges.reduce((sum, exchange) => sum + exchange.estimatedCostUsd, 0).toFixed(12)), costStatus: "computed-from-snapshot", pricingSnapshotDigest, exchanges: Object.freeze([...exchanges]), usage }),
        executable: Object.freeze({ digest: executable.digest, byteLength: executable.byteLength }),
      });
    },
  });
}
