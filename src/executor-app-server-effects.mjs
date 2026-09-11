import { ExecutorAppServerSessionV1 } from "./executor-app-server-session.mjs";
import { ExecutorContractError, executorDigest, executorExact, executorText, normalizeExecutorMemberV1 } from "./executor-contract.mjs";
import { classifyWorkResult } from "./work-result.mjs";
import { commitRuntimeMutationV1 } from "./runtime-mutation-fence.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };
const TERMINAL = new Set(["completed", "failed", "interrupted"]);

/** Typed, service-installed effects for the launch coordinator. Ownership comes
 * only from this connection's creation replies, never a frontend-supplied ID.
 * Restoring ownership after process loss requires a separate recovery protocol.
 */
export class ExecutorAppServerEffectsV1 {
  #session;
  #validateTarget;
  #validateRecovery;
  #operations = new Map();
  #threads = new Map();

  constructor({ session, validateTarget, validateRecovery = null }) {
    if (!(session instanceof ExecutorAppServerSessionV1) || typeof validateTarget !== "function" ||
        (validateRecovery !== null && typeof validateRecovery !== "function")) fail("invalid-effect-dependencies");
    this.#session = session;
    this.#validateTarget = validateTarget;
    this.#validateRecovery = validateRecovery;
  }

  #ready(signal) {
    if (signal?.aborted) fail("effect-aborted");
    if (this.#session.status().state !== "ready") fail("session-unavailable");
  }

  async #target(member, signal) {
    this.#ready(signal);
    // This callback belongs to the work-host service, never an MCP argument.
    if (await this.#validateTarget(structuredClone(member), { signal }) !== true) fail("execution-target-unverified");
    this.#ready(signal);
  }

  #owned(threadId) {
    executorText(threadId, 256);
    const entry = this.#threads.get(threadId);
    if (!entry) fail("foreign-executor-thread");
    return entry;
  }

  async createThread(input, { signal } = {}) {
    executorExact(input, ["member", "operationId"]);
    const member = normalizeExecutorMemberV1(input.member);
    executorText(input.operationId, 128);
    if (!/^launch:[0-9a-f-]{36}$/u.test(input.operationId)) fail("invalid-launch-operation");
    if (this.#operations.has(input.operationId)) fail("existing-effect-operation");
    if (this.#operations.size >= 128) fail("effect-ownership-capacity");
    const entry = { member, operationId: input.operationId, threadId: null, turnId: null,
      phase: "creating", verified: false, titled: false, turnReady: null, finishTurn: null };
    this.#operations.set(input.operationId, entry);
    try {
      await this.#target(member, signal);
      const result = await commitRuntimeMutationV1(() => {
        this.#ready(signal);
        return this.#session.request("thread/start", {
          cwd: member.target.cwd, model: member.model, permissions: member.permissionProfile,
          approvalPolicy: member.approvalPolicy, ephemeral: false, serviceName: "nelos_executor",
          // Explicit colocation: do not inherit a configured remote environment
          // or fall back to another model when this exact route is unavailable.
          environments: [], allowProviderModelFallback: false,
        }, { signal });
      });
      executorText(result?.thread?.id, 256);
      if (this.#threads.has(result.thread.id)) fail("duplicate-created-thread");
      entry.threadId = result.thread.id;
      entry.phase = "created";
      this.#threads.set(entry.threadId, entry);
      const projected = { threadId: entry.threadId, model: result.model ?? null, cwd: result.cwd ?? null,
        permissionProfile: result.activePermissionProfile?.id ?? null, approvalPolicy: result.approvalPolicy ?? null };
      entry.verified = projected.model === member.model && projected.cwd === member.target.cwd &&
        projected.permissionProfile === member.permissionProfile && projected.approvalPolicy === member.approvalPolicy &&
        result.thread.cwd === member.target.cwd;
      // Preserve the created identity even when the effective policy is wrong.
      // A contradictory nested cwd must also make the coordinator reject it.
      if (result.thread.cwd !== member.target.cwd) projected.cwd = null;
      return projected;
    } catch (cause) {
      entry.phase = "unknown";
      throw cause;
    }
  }

  async setTitle(input, { signal } = {}) {
    executorExact(input, ["threadId", "title"]);
    const entry = this.#owned(input.threadId);
    if (entry.phase !== "created" || !entry.verified || input.title !== entry.member.title) fail("title-scope-mismatch");
    entry.phase = "titling";
    try {
      await commitRuntimeMutationV1(() => {
        this.#ready(signal);
        return this.#session.request("thread/name/set", { threadId: input.threadId, name: input.title }, { signal });
      });
      this.#ready(signal);
      const observed = await this.#session.request("thread/read", { threadId: input.threadId, includeTurns: false }, { signal });
      if (observed?.thread?.id !== input.threadId) fail("thread-read-identity-mismatch");
      entry.titled = observed.thread.name === entry.member.title;
      return { observedTitle: observed.thread.name ?? null };
    } finally { entry.phase = "created"; }
  }

  async startTurn(input, { signal } = {}) {
    executorExact(input, ["member", "threadId", "prompt", "clientUserMessageId"]);
    const entry = this.#owned(input.threadId);
    const member = normalizeExecutorMemberV1(input.member);
    if (entry.phase !== "created" || !entry.verified || !entry.titled ||
        executorDigest(member) !== executorDigest(entry.member) ||
        typeof input.prompt !== "string" || Buffer.byteLength(input.prompt) > 32 * 1024 ||
        executorDigest(input.prompt) !== member.promptDigest ||
        input.clientUserMessageId !== `nelos:${entry.operationId}`) fail("turn-scope-mismatch");
    // Set before awaiting validation to exclude concurrent starts. Failure keeps
    // this operation unavailable for retry, even when its outcome is uncertain.
    entry.phase = "starting";
    entry.turnReady = new Promise((resolve) => { entry.finishTurn = resolve; });
    try {
      await this.#target(member, signal);
      const result = await commitRuntimeMutationV1(() => {
        this.#ready(signal);
        return this.#session.request("turn/start", { threadId: input.threadId,
          input: [{ type: "text", text: input.prompt }], clientUserMessageId: input.clientUserMessageId,
          cwd: member.target.cwd, model: member.model, effort: member.reasoningEffort,
          permissions: member.permissionProfile, approvalPolicy: member.approvalPolicy, environments: [],
        }, { signal });
      });
      executorText(result?.turn?.id, 256);
      entry.turnId = result.turn.id;
      entry.phase = "running";
      return { turnId: entry.turnId };
    } catch (cause) { entry.phase = "unknown"; throw cause; }
    finally { entry.finishTurn(); }
  }

  /** Requests/events may arrive before turn/start's response. Wait for the
   * response before deciding ownership; never infer it from event-supplied IDs.
   */
  async ownsTurn({ threadId, turnId }, { signal } = {}) {
    const entry = this.#threads.get(threadId);
    if (!entry || typeof turnId !== "string" || !turnId) return false;
    if (entry.phase === "starting") {
      const signals = [this.#session.signal, ...(signal ? [signal] : [])];
      const cancellation = AbortSignal.any(signals);
      if (cancellation.aborted) return false;
      let abort;
      try {
        await Promise.race([entry.turnReady, new Promise((resolve) => {
          abort = resolve; cancellation.addEventListener("abort", abort, { once: true });
        })]);
      } finally { cancellation.removeEventListener("abort", abort); }
    }
    return !signal?.aborted && this.#session.status().state === "ready" && entry.turnId === turnId && entry.phase === "running";
  }

  async interrupt(input, { signal } = {}) {
    executorExact(input, ["threadId", "turnId"]);
    if (!await this.ownsTurn(input, { signal })) fail("foreign-or-inactive-executor-turn");
    await commitRuntimeMutationV1(() => {
      this.#ready(signal);
      return this.#session.request("turn/interrupt", input, { signal });
    });
    // The acknowledgment is not proof of completion; read the exact turn.
    return { ...input, interruptRequested: true };
  }

  async describeOwnedTurn(input, options = {}) {
    if (!await this.ownsTurn(input, options)) return null;
    const entry = this.#owned(input.threadId);
    return { threadId: entry.threadId, turnId: entry.turnId,
      workUnitId: entry.member.workUnitId, operationId: entry.operationId };
  }

  async observeNotification({ method, params }, { signal } = {}) {
    if (method !== "turn/completed") return null;
    const turnId = params?.turn?.id;
    const scope = { threadId: params?.threadId, turnId };
    if (!await this.ownsTurn(scope, { signal })) return null;
    if (!TERMINAL.has(params.turn.status)) fail("invalid-terminal-notification");
    const entry = this.#owned(scope.threadId);
    entry.phase = "terminal";
    // Completion events revoke approval eligibility. They are a hint to read
    // the exact turn, not authoritative result or deliverable acceptance.
    return { ...scope, operationId: entry.operationId, workUnitId: entry.member.workUnitId,
      status: params.turn.status, readResultRequired: true };
  }

  async readResult(input, { signal } = {}) {
    executorExact(input, ["threadId", "turnId"]);
    const entry = this.#owned(input.threadId);
    if (!entry.turnId || input.turnId !== entry.turnId) fail("foreign-executor-turn");
    return this.#readResult(input, entry.member, { signal });
  }

  // Private journal evidence grants observation of an exact recorded turn,
  // never live ownership, approvals, interruption, resume, or another start.
  async readRecordedResult({ operation }, { signal } = {}) {
    if (!this.#validateRecovery) fail("recorded-result-reader-unavailable");
    if (!["running", "terminal"].includes(operation?.phase)) fail("recorded-turn-identity-required");
    executorText(operation.threadId, 256); executorText(operation.turnId, 256);
    const member = normalizeExecutorMemberV1(operation.member);
    const verify = async () => {
      await this.#target(member, signal);
      if (await this.#validateRecovery(structuredClone(operation), {
        signal, request: (...args) => this.#session.request(...args),
      }) !== true) fail("recorded-result-scope-unverified");
      this.#ready(signal);
    };
    await verify();
    const result = await this.#readResult({ threadId: operation.threadId, turnId: operation.turnId },
      member, { signal, recorded: true });
    await verify();
    return result;
  }

  async #readResult(input, member, { signal, recorded = false }) {
    this.#ready(signal);
    const response = await this.#session.request("thread/read", { threadId: input.threadId, includeTurns: true }, { signal });
    const thread = response?.thread;
    if (thread?.id !== input.threadId || !Array.isArray(thread.turns) || thread.turns.length > 256) fail("invalid-result-thread");
    if (recorded && thread.cwd !== member.target.cwd) fail("recorded-result-target-mismatch");
    const matches = thread.turns.filter((turn) => turn?.id === input.turnId);
    if (matches.length !== 1) fail("result-turn-unavailable");
    const turn = matches[0];
    if (!recorded && TERMINAL.has(turn.status)) this.#owned(input.threadId).phase = "terminal";
    if ((!TERMINAL.has(turn.status) && turn.status !== "inProgress") ||
        (turn.itemsView !== undefined && turn.itemsView !== "full") ||
        !Array.isArray(turn.items) || turn.items.length > 1024) fail("incomplete-result-turn");
    const items = turn.items.filter((item) => item?.type === "agentMessage");
    let bytes = 0;
    for (const item of items) {
      if (typeof item.text !== "string" || ![null, undefined, "commentary", "final_answer"].includes(item.phase)) fail("invalid-result-message");
      bytes += Buffer.byteLength(item.text);
      if (bytes > 64 * 1024) fail("result-too-large");
    }
    const result = classifyWorkResult({ latestTurn: { id: turn.id, status: turn.status,
      items: items.map(({ type, text, phase }) => ({ type, text, phase })) } });
    if (result.result && (result.result.workUnitId !== member.workUnitId ||
        result.result.specRevision !== member.specRevision || result.result.attempt !== member.attempt)) fail("result-scope-mismatch");
    // Transport completion and semantic acceptance remain separate.
    return { ...input, terminal: TERMINAL.has(turn.status), status: turn.status, result };
  }
}
