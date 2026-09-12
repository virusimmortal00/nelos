import { setTimeout as delay } from "node:timers/promises";
import { ExecutorContractError, executorExact, executorText } from "./executor-contract.mjs";
const fail = (code) => { throw new ExecutorContractError(code); };
export function normalizeExecutorRequiredToolsV1(required) {
  if (!Array.isArray(required) || required.length > 16) fail("invalid-required-tools");
  const values = required.map((entry) => { executorExact(entry, ["server", "tool"]); return { server: executorText(entry.server, 256), tool: executorText(entry.tool, 256) }; });
  if (new Set(values.map((value) => JSON.stringify(value))).size !== values.length) fail("duplicate-required-tool");
  return values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
// Inspect only explicitly required tools on the newly owned thread. A global
// cached catalog is not proof that this thread's tool connection is ready.
export async function verifyExecutorRequiredToolsV1({ required, threadId, request, signal, timeoutMs = 8000 }) {
  const selected = normalizeExecutorRequiredToolsV1(required);
  if (!selected.length) return true;
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() < deadline) {
    const servers = [], cursors = new Set(); let cursor;
    for (let page = 0; page < 8; page++) {
      const result = await request("mcpServerStatus/list", { threadId, limit: 100, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) }, { signal });
      if (!Array.isArray(result?.data) || result.data.length > 100) fail("invalid-required-tool-inventory");
      servers.push(...result.data);
      if (result.nextCursor == null) { cursor = null; break; }
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) fail("invalid-required-tool-inventory");
      cursor = result.nextCursor; cursors.add(cursor);
    }
    if (cursor) fail("required-tool-inventory-limit");
    const ready = selected.every(({ server, tool }) => {
      const matches = servers.filter(({ name }) => name === server);
      if (matches.length > 1) fail("ambiguous-required-tool-server");
      const match = matches[0];
      return match?.runtimeStatus === "connected" && !match.toolsError && match.tools && Object.hasOwn(match.tools, tool) && match.tools[tool]?.name === tool;
    });
    if (ready) return true;
    if (selected.some(({ server }) => servers.some((entry) => entry.name === server && ["failed", "disabled", "cancelled", "authenticationRequired"].includes(entry.runtimeStatus)))) fail("required-worker-tool-unavailable");
    await delay(Math.min(200, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  fail("required-worker-tool-unavailable");
}
