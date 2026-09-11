import { isAbsolute } from "node:path";
import { ExecutorServiceClientV1 } from "./executor-service-channel.mjs";

// Explicit parent-side attachment only. An unavailable endpoint never prevents
// MCP initialization or disables ordinary tools. Only a subsequent explicit
// call reconnects; a failed request is never replayed by the adapter.
export function executorMcpClientV1(descriptorPath) {
  if (!isAbsolute(descriptorPath)) throw new Error("executor endpoint must be absolute");
  let connecting = null;
  return {
    async request(method, params) {
      const current = connecting ??= ExecutorServiceClientV1.connect(descriptorPath);
      try { return await (await current).request(method, params); }
      catch (error) {
        if (connecting === current) connecting = null;
        current.then((client) => client.close(), () => {});
        throw error;
      }
    },
    async close() {
      const current = connecting; connecting = null;
      if (current) await current.then((client) => client.close(), () => {});
    },
  };
}

export function executorMcpToolsV1(client) {
  if (client == null) return [];
  if (typeof client.request !== "function") throw new Error("invalid owned executor client");
  return [
    ["status", "Inspect the explicitly attached worker service and its recovery state."],
    ["launch", "Start the one worker job already authorized by the service operator. No target, prompt, model, or permission changes are accepted."],
    ["collect", "Collect the attached worker's validated result. Reconnects do not recreate a worker or repeat its turn."],
    ["retry", "Request the separately preauthorized next attempt after a confirmed interruption. expectedAttempt names the attempt being replaced; replaying it never advances again."],
    ["join", "Record the parent's explicit acceptance or rejection after reviewing the collected evidence. Completion alone is not acceptance."],
  ].map(([method, description]) => ({
    name: `nelos_owned_${method}`, description,
    annotations: { readOnlyHint: method === "status", destructiveHint: false, idempotentHint: true,
      openWorldHint: ["launch", "retry"].includes(method) },
    inputSchema: { type: "object", properties: method === "join" ? {
      expectedAttempt: { type: "integer", minimum: 1, maximum: 3 },
      decision: { type: "string", enum: ["accepted", "rejected"] },
      decisionSummary: { type: "string", minLength: 1, maxLength: 1000 },
    } : method === "retry" ? { expectedAttempt: { type: "integer", minimum: 1, maximum: 3 } } : {},
    ...(method === "retry" ? { required: ["expectedAttempt"] } : {}), ...(method === "join" ? { required: ["decision", "decisionSummary"] } : {}), additionalProperties: false },
    async run(args) { return { command: `owned ${method}`, result: await client.request(method, args) }; },
  }));
}
