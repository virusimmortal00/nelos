import { ExecutorContractError, executorExact } from "./executor-contract.mjs";
import { serveExecutorJobV1 } from "./executor-service-channel.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };

// Separate operator UI endpoint. Its credential is never put in the parent MCP
// tool surface. The runtime relay still validates the live turn and each answer.
export async function serveExecutorApprovalUiV1({ service, directory }) {
  let attached = null;
  const pending = new Map();
  const detach = (client) => {
    if (attached?.client !== client) return;
    attached.controller.abort(); attached.remove(); attached = null;
  };
  const endpoint = await serveExecutorJobV1({ directory, service: {
    status: () => ({ state: "ready" }),
    attach() {
      if (attached) fail("approval-ui-already-attached");
      const client = Object.freeze({}), controller = new AbortController();
      const remove = service.attachApprovalChannel({ signal: controller.signal,
        request(request, { signal }) {
          if (signal.aborted || controller.signal.aborted || pending.size >= 16 || pending.has(request.requestToken)) return Promise.reject(new ExecutorContractError("approval-ui-unavailable"));
          return new Promise((resolve, reject) => {
            const combined = AbortSignal.any([signal, controller.signal]);
            const finish = (answer, error = null) => {
              pending.delete(request.requestToken); combined.removeEventListener("abort", abort);
              if (error) reject(error); else resolve(answer);
            };
            const abort = () => finish(null, new ExecutorContractError("approval-ui-disconnected"));
            pending.set(request.requestToken, { request: structuredClone(request), finish });
            combined.addEventListener("abort", abort, { once: true });
            if (combined.aborted) abort();
          });
        },
      });
      attached = { client, controller, remove }; return client;
    },
    detach,
    request(client, method, params) {
      if (attached?.client !== client) fail("unknown-service-client");
      if (method === "poll") {
        executorExact(params, []);
        return { request: structuredClone(pending.values().next().value?.request ?? null) };
      }
      if (method !== "answer") fail("unsupported-service-method");
      executorExact(params, ["requestToken", "response"]);
      if (typeof params.requestToken !== "string" || params.requestToken.length > 128) fail("invalid-approval-token");
      const entry = pending.get(params.requestToken);
      if (!entry) return { state: "not-pending" };
      entry.finish(structuredClone(params)); return { state: "answered" };
    },
  } });
  return { descriptorPath: endpoint.descriptorPath, async close() { if (attached) detach(attached.client); await endpoint.close(); } };
}
