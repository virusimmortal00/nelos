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
  const reasoning = Number(usage.output_tokens_details?.reasoning_tokens ?? 0);
  if (![cached, reasoning].every((value) => Number.isSafeInteger(value) && value >= 0) || cached > input || reasoning > output || total !== input + output) fail("PROXY_RECEIPT_INCOMPLETE");
  return Object.freeze({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: total });
}
function estimatedCost(usage, snapshot) {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const value = (uncached * snapshot.inputUsdPerMillionTokens + usage.cachedInputTokens * snapshot.cachedInputUsdPerMillionTokens + usage.outputTokens * snapshot.outputUsdPerMillionTokens) / 1_000_000;
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

export async function startApiReceiptProxy({ apiKey, request, executable, upstreamBaseUrl = "https://api.openai.com", host = "127.0.0.1" }) {
  if (host !== "127.0.0.1" || typeof apiKey !== "string" || !apiKey) fail("PROXY_CONFIGURATION_INVALID");
  const requestedModel = modelSlug(request);
  const requestedEffort = request.requestedRoute.reasoningEffort;
  const upstream = new URL(upstreamBaseUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) fail("PROXY_CONFIGURATION_INVALID");
  let credential = apiKey;
  let inboundCount = 0;
  let upstreamCount = 0;
  let completed = null;
  let requestId = null;
  let responseStatus = null;
  let failureCode = null;
  let activeUpstream = null;

  const server = createServer(async (incoming, downstream) => {
    inboundCount += 1;
    try {
      if (inboundCount !== 1) fail("PROXY_MULTIPLE_REQUESTS");
      if (incoming.method !== "POST" || incoming.url !== "/v1/responses") fail("PROXY_REQUEST_REJECTED");
      if (!safeEqual(incoming.headers.authorization, `Bearer ${credential}`)) fail("PROXY_AUTH_REJECTED");
      const body = await readBounded(incoming);
      let payload; try { payload = JSON.parse(body.toString("utf8")); } catch { fail("PROXY_REQUEST_INVALID"); }
      if (payload.model !== requestedModel || payload.reasoning?.effort !== requestedEffort) fail("PROXY_ROUTE_MISMATCH");
      upstreamCount += 1;
      const target = new URL(`${upstream.pathname.replace(/\/$/u, "")}/v1/responses`, upstream);
      const state = { buffer: "", completed: null, responseBytes: 0, parseError: null };
      const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
      await new Promise((resolveForward, rejectForward) => {
        const forwarded = transport(target, { method: "POST", headers: forwardedHeaders(incoming.headers, credential, body.byteLength) }, (provider) => {
          responseStatus = provider.statusCode ?? 0;
          requestId = typeof provider.headers["x-request-id"] === "string" ? provider.headers["x-request-id"] : null;
          downstream.writeHead(responseStatus, downstreamHeaders(provider.headers));
          const responseChunks = [];
          provider.on("data", (chunk) => {
            state.responseBytes += chunk.byteLength;
            if (state.responseBytes > MAX_RESPONSE_BYTES) {
              state.parseError = Object.assign(new Error("PROXY_UPSTREAM_RESPONSE_TOO_LARGE"), { code: "PROXY_UPSTREAM_RESPONSE_TOO_LARGE" });
              provider.destroy(state.parseError);
              return;
            }
            downstream.write(chunk);
            if (String(provider.headers["content-type"] ?? "").includes("text/event-stream")) {
              try { parseSseChunk(state, chunk.toString("utf8")); } catch (error) { state.parseError = error; }
            }
            else responseChunks.push(chunk);
          });
          provider.once("end", () => {
            downstream.end();
            try {
              if (state.parseError) throw state.parseError;
              if (state.buffer.trim()) parseSseChunk(state, "\n\n");
              if (!String(provider.headers["content-type"] ?? "").includes("text/event-stream")) {
                let value; try { value = JSON.parse(Buffer.concat(responseChunks).toString("utf8")); } catch { fail("PROXY_UPSTREAM_RESPONSE_INVALID"); }
                state.completed = responseDetails(value);
              }
              completed = state.completed;
              resolveForward();
            } catch (error) { rejectForward(error); }
          });
          provider.once("error", rejectForward);
        });
        activeUpstream = forwarded;
        forwarded.once("error", rejectForward);
        forwarded.end(body);
      });
    } catch (error) {
      failureCode = error?.code ?? "PROXY_FORWARD_FAILED";
      if (!downstream.headersSent) downstream.writeHead(failureCode === "PROXY_MULTIPLE_REQUESTS" ? 409 : 400, { "content-type": "application/json" });
      if (!downstream.writableEnded) downstream.end(JSON.stringify({ error: "request rejected" }));
    } finally { activeUpstream = null; }
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
      if (inboundCount !== 1 || upstreamCount !== 1) fail("PROXY_RECEIPT_INCOMPLETE");
      if (!Number.isInteger(responseStatus) || responseStatus < 200 || responseStatus >= 300 || !completed || completed.status !== "completed" || !requestId) fail("PROXY_RECEIPT_INCOMPLETE");
      if (!observedModelMatches(requestedModel, completed.model)) fail("PROXY_OBSERVED_MODEL_MISMATCH");
      const usage = publicUsage(completed.usage);
      const pricingSnapshotDigest = canonicalDigest(request.pricingSnapshot);
      return Object.freeze({
        schemaVersion: 1,
        operationId: request.operationId,
        leaseId: request.lease.leaseId,
        fencingToken: request.lease.fencingToken,
        attempt: request.attempt,
        route: Object.freeze({ ...request.requestedRoute, observedModelId: `model:${completed.model}`, observedModelRevision: completed.model, forwardedReasoningEffort: requestedEffort }),
        provider: Object.freeze({ executionCount: 1, retryCount: 0, requestCount: 1, estimatedCostUsd: estimatedCost(usage, request.pricingSnapshot), costStatus: "computed-from-snapshot", pricingSnapshotDigest, responseId: completed.id, requestId, usage }),
        executable: Object.freeze({ digest: executable.digest, byteLength: executable.byteLength }),
      });
    },
  });
}
