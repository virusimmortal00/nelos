import { AsyncLocalStorage } from "node:async_hooks";

const mutationContext = new AsyncLocalStorage();

const ERROR_CODE_BY_STATE = Object.freeze({
  "restart-required": "STALE_RUNTIME",
  "ambiguous-install": "AMBIGUOUS_RUNTIME_INSTALL",
  "integrity-failure": "RUNTIME_INTEGRITY_FAILURE",
});

function mutationTool(annotations) {
  return annotations?.readOnlyHint !== true;
}

export class RuntimeMutationFenceError extends Error {
  constructor(health, phase) {
    const code = ERROR_CODE_BY_STATE[health.state] ?? "RUNTIME_MUTATION_DENIED";
    super(`${code}: ${health.detail ?? "the loaded runtime cannot safely mutate durable state"}`);
    this.name = "RuntimeMutationFenceError";
    this.code = code;
    this.state = health.state;
    this.phase = phase;
    this.loaded = health.loaded ?? null;
    this.installed = health.installed ?? null;
    this.installedIdentities = health.installedIdentities ?? (
      health.installed ? [health.installed] : []
    );
    this.recoveryAction = health.recovery;
  }
}

/**
 * Central admission and durable-commit fence for one loaded MCP generation.
 *
 * Tool annotations decide whether admission is required. Durable stores use
 * `commitRuntimeMutationV1` below, which finds this boundary through async
 * context without coupling every store constructor to the MCP server.
 */
export class RuntimeMutationBoundaryV1 {
  #health;

  constructor({ health }) {
    if (typeof health !== "function") {
      throw new Error("runtime mutation boundary requires a health resolver");
    }
    this.#health = health;
  }

  async #assertAllowed(phase) {
    const health = await this.#health({ verifyIntegrity: true });
    if (health.mutationAllowed !== true) {
      throw new RuntimeMutationFenceError(health, phase);
    }
  }

  async run(annotations, callback) {
    if (!mutationTool(annotations)) return callback();
    await this.#assertAllowed("admission");
    return mutationContext.run(this, callback);
  }

  async commit(callback) {
    await this.#assertAllowed("pre-commit");
    // The health decision is made exactly once before entering the commit.
    // Once entered, the callback drains even if installation state changes.
    return callback();
  }
}

/**
 * Revalidate an admitted MCP mutation immediately before its durable rename.
 * Calls outside an admitted MCP mutation retain the store's existing behavior.
 */
export async function commitRuntimeMutationV1(callback) {
  const boundary = mutationContext.getStore();
  return boundary ? boundary.commit(callback) : callback();
}
