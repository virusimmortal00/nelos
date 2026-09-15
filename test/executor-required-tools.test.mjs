import assert from "node:assert/strict";
import test from "node:test";
import { verifyExecutorRequiredToolsV1, normalizeExecutorRequiredToolsV1 } from "../src/executor-required-tools.mjs";
const required = [{ server: "files", tool: "read" }];
test("optional tool checks impose no new operation requirement when unconfigured", async () => {
  assert.equal(await verifyExecutorRequiredToolsV1({ required: [], request: () => assert.fail("unexpected discovery") }), true);
  assert.throws(() => normalizeExecutorRequiredToolsV1([...required, ...required]), /duplicate-required-tool/);
});
test("thread tool discovery waits through startup and pages to the exact required server", async () => {
  let attempts = 0;
  const result = await verifyExecutorRequiredToolsV1({ required, threadId: "owned", request: async (method, params) => {
    assert.equal(method, "mcpServerStatus/list"); assert.equal(params.threadId, "owned");
    if (!params.cursor) return { data: [{ name: "optional", runtimeStatus: "failed", tools: {} }], nextCursor: "page-2" };
    return { data: [{ name: "files", runtimeStatus: ++attempts === 1 ? "starting" : "connected", tools: { read: { name: "read" } } }], nextCursor: null };
  } });
  assert.equal(result, true); assert.equal(attempts, 2);
});
test("cached catalogs, failed connections, cursor loops and ambiguous servers never satisfy required tools", async () => {
  for (const result of [
    { data: [{ name: "files", runtimeStatus: null, tools: { read: { name: "read" } } }] },
    { data: [{ name: "files", runtimeStatus: "failed", tools: { read: { name: "read" } } }] },
    { data: [], nextCursor: "loop" },
    { data: [{ name: "files" }, { name: "files" }] },
  ]) await assert.rejects(verifyExecutorRequiredToolsV1({ required, threadId: "owned", timeoutMs: 5, request: async () => result }));
});
