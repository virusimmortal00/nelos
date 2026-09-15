import { randomUUID } from "node:crypto";
import {
  ExecutorContractError, executorExact, executorDigest, executorInteger, executorText,
  normalizeExecutorWaveV1, normalizeExecutorContextV1, executorContextFingerprintV1,
} from "./executor-contract.mjs";

const REQUIRED_OPERATIONS = Object.freeze(["create", "start", "observe", "read-result", "interrupt"]);
const GRANT_ID = /^grant:[a-f0-9-]{36}$/u;
const deny = (kind, reason) => ({ schemaVersion: 1, kind, reason });

/** Service-side authority only. Its dependencies are installed by the service,
 * never deserialized from an MCP call. No production authorizer is implied.
 * Restarting an authority invalidates every old grant; grants are not receipts.
 */
export class ExecutorGrantAuthorityV1 {
  #evaluate;
  #authorize;
  #now;
  #maximumGrants;
  #timeoutMs;
  #ttlMs;
  #grants = new Map();
  #closed = false;
  #inFlight = 0;
  #controllers = new Set();

  constructor({ evaluate = null, authorize = null, now = Date.now,
    maximumGrants = 128, timeoutMs = 10_000, ttlMs = 60_000 } = {}) {
    for (const callback of [evaluate, authorize]) {
      if (callback !== null && typeof callback !== "function") throw new ExecutorContractError("invalid-provider");
    }
    if (typeof now !== "function") throw new ExecutorContractError("invalid-clock");
    executorInteger(maximumGrants); executorInteger(timeoutMs); executorInteger(ttlMs);
    if (maximumGrants > 4096 || timeoutMs > 30_000 || ttlMs > 300_000) throw new ExecutorContractError("invalid-limits");
    this.#evaluate = evaluate;
    this.#authorize = authorize;
    this.#now = now;
    this.#maximumGrants = maximumGrants;
    this.#timeoutMs = timeoutMs;
    this.#ttlMs = ttlMs;
  }

  #prune() {
    const now = this.#now();
    for (const [id, grant] of this.#grants) if (grant.expiresAt <= now) this.#grants.delete(id);
  }

  async #bounded(callback) {
    if (this.#closed) throw new ExecutorContractError("authority-closed");
    if (this.#inFlight >= 16) throw new ExecutorContractError("authority-busy");
    this.#inFlight += 1;
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timer;
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new ExecutorContractError("authority-closed");
      return callback(controller.signal);
    }).finally(() => {
      this.#inFlight -= 1;
      this.#controllers.delete(controller);
    });
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new ExecutorContractError("authority-unavailable")), { once: true });
        timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async #context(scope, signal) {
    if (!this.#evaluate) throw new ExecutorContractError("executor-unavailable");
    if (signal.aborted || this.#closed) throw new ExecutorContractError("authority-closed");
    const evaluated = await this.#evaluate(structuredClone(scope), { signal });
    if (signal.aborted || this.#closed) throw new ExecutorContractError("authority-closed");
    executorExact(evaluated, ["context", "operations", "interaction"]);
    const context = normalizeExecutorContextV1(evaluated.context);
    if (context.scopeDigest !== executorDigest(scope) || context.validUntil <= this.#now()) {
      throw new ExecutorContractError("stale-execution-context");
    }
    if (!Array.isArray(evaluated.operations) || evaluated.operations.length > 16 ||
        !REQUIRED_OPERATIONS.every((op) => evaluated.operations.includes(op)) ||
        !["interactive", "preauthorized-unattended"].includes(evaluated.interaction)) {
      throw new ExecutorContractError("executor-capability-unavailable");
    }
    if (evaluated.interaction !== "interactive" && scope.members.some((m) => m.approvalPolicy !== "never")) {
      throw new ExecutorContractError("approval-channel-unavailable");
    }
    return context;
  }

  async issue(input) {
    executorExact(input, ["wave"]);
    const { wave } = input;
    const scope = normalizeExecutorWaveV1(wave);
    this.#prune();
    if (!this.#authorize) return deny("authorization-required", "host-authorizer-unavailable");
    if (this.#grants.size >= this.#maximumGrants) return deny("execution-unavailable", "grant-capacity");
    try {
      return await this.#bounded(async (signal) => {
        const context = await this.#context(scope, signal);
        const authorization = await this.#authorize(structuredClone(scope), { context: structuredClone(context), signal });
        if (authorization?.decision !== "allow") return deny("authorization-required", "host-authorization-required");
        executorExact(authorization, ["decision", "decisionId", "scopeDigest", "contextFingerprint", "expiresAt"]);
        executorText(authorization.decisionId);
        executorInteger(authorization.expiresAt);
        if (authorization.scopeDigest !== executorDigest(scope) ||
            authorization.contextFingerprint !== executorContextFingerprintV1(context)) {
          throw new ExecutorContractError("authorization-scope-mismatch");
        }
        // The authorization UI may have been open while account/config/owner changed.
        const current = await this.#context(scope, signal);
        if (executorContextFingerprintV1(current) !== executorContextFingerprintV1(context)) {
          throw new ExecutorContractError("stale-execution-context");
        }
        const expiresAt = Math.min(this.#now() + this.#ttlMs, context.validUntil, current.validUntil, authorization.expiresAt);
        if (expiresAt <= this.#now()) throw new ExecutorContractError("expired-authorization");
        this.#prune();
        if (this.#grants.size >= this.#maximumGrants) throw new ExecutorContractError("grant-capacity");
        const executionGrantId = `grant:${randomUUID()}`;
        this.#grants.set(executionGrantId, { scope, context: current, expiresAt, decisionId: authorization.decisionId });
        return { schemaVersion: 1, kind: "execution-granted", executionGrantId,
          scopeDigest: executorDigest(scope), expiresAt };
      });
    } catch (error) {
      return deny("execution-unavailable", error instanceof ExecutorContractError ? error.code : "authority-unavailable");
    }
  }

  async validate(input) {
    executorExact(input, ["executionGrantId", "wave"]);
    const { executionGrantId, wave } = input;
    const scope = normalizeExecutorWaveV1(wave);
    if (typeof executionGrantId !== "string" || !GRANT_ID.test(executionGrantId)) {
      return deny("authorization-required", "unknown-execution-grant");
    }
    this.#prune();
    const grant = this.#grants.get(executionGrantId);
    if (!grant) return deny("authorization-required", "unknown-execution-grant");
    if (executorDigest(scope) !== executorDigest(grant.scope)) return deny("authorization-required", "execution-grant-scope-mismatch");
    try {
      return await this.#bounded(async (signal) => {
        const context = await this.#context(scope, signal);
        if (this.#grants.get(executionGrantId) !== grant || grant.expiresAt <= this.#now() ||
            executorContextFingerprintV1(context) !== executorContextFingerprintV1(grant.context)) {
          throw new ExecutorContractError("stale-execution-grant");
        }
        return { schemaVersion: 1, kind: "execution-admitted", executionGrantId,
          scopeDigest: executorDigest(scope), context: structuredClone(context), expiresAt: grant.expiresAt };
      });
    } catch (error) {
      const code = error instanceof ExecutorContractError ? error.code : "authority-unavailable";
      // A failed probe still denies this admission. Only evidence that the
      // grant is stale revokes it; capacity/timeouts/provider failures can be
      // retried through the same full context check before any mutation.
      if (["stale-execution-grant", "stale-execution-context", "approval-channel-unavailable",
        "executor-capability-unavailable"].includes(code)) this.#grants.delete(executionGrantId);
      return deny("execution-unavailable", code);
    }
  }

  revoke(executionGrantId) { this.#grants.delete(executionGrantId); }

  close() {
    this.#closed = true;
    this.#grants.clear();
    for (const controller of this.#controllers) controller.abort();
  }
}

export async function gateExecutorWaveV1({ authority, wave, executionGrantId = null }) {
  const scope = normalizeExecutorWaveV1(wave);
  if (!(authority instanceof ExecutorGrantAuthorityV1)) return deny("execution-unavailable", "executor-authority-unavailable");
  const result = await authority.validate({ executionGrantId, wave: scope });
  return result.kind === "execution-admitted" ? { ...result, wave: scope } : result;
}
