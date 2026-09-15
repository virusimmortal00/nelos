import { randomUUID } from "node:crypto";
import { ExecutorContractError, executorExact, executorInteger, executorText } from "./executor-contract.mjs";

const COMMAND = "item/commandExecution/requestApproval";
const FILE = "item/fileChange/requestApproval";
const INPUT = "item/tool/requestUserInput";
const MCP = "mcpServer/elicitation/request";
export const EXECUTOR_INTERACTION_METHODS_V1 = Object.freeze([COMMAND, FILE, INPUT, MCP]);
const cancel = (method) => method === INPUT ? { answers: {} } : method === MCP
  ? { action: "cancel", content: null } : { decision: "cancel" };
const fail = (code) => { throw new ExecutorContractError(code); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function responseFor(method, params, response) {
  if ([COMMAND, FILE].includes(method)) {
    executorExact(response, ["decision"]);
    // Persistent/session grants and policy amendments need a separate reviewed
    // UI contract. This first relay supports only a decision on this request.
    if (!["accept", "decline", "cancel"].includes(response.decision)) fail("unsupported-approval-decision");
    if (method === COMMAND && params.availableDecisions != null &&
        (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes(response.decision))) fail("unoffered-approval-decision");
    return { decision: response.decision };
  }
  if (method === INPUT) {
    executorExact(response, ["answers"]);
    if (!object(response.answers)) fail("invalid-user-answers");
    const questions = params.questions;
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 10) fail("invalid-user-questions");
    const ids = questions.map((question) => executorText(question.id, 256));
    if (new Set(ids).size !== ids.length) fail("invalid-user-questions");
    const answers = Object.create(null);
    for (const [id, value] of Object.entries(response.answers)) {
      if (!ids.includes(id)) fail("foreign-question-answer");
      executorExact(value, ["answers"]);
      if (!Array.isArray(value.answers) || value.answers.length > 16) fail("invalid-user-answers");
      answers[id] = { answers: value.answers.map((answer) => {
        if (typeof answer !== "string" || answer.length > 4096 || answer.includes("\0")) fail("invalid-user-answers");
        return answer;
      }) };
    }
    return { answers };
  }
  executorExact(response, ["action", "content"]);
  if (!["accept", "decline", "cancel"].includes(response.action)) fail("invalid-elicitation-action");
  if (response.action !== "accept") return { action: response.action, content: null };
  if (!["form", "url"].includes(params.mode) ||
      (params.mode === "form" && !object(response.content)) ||
      (params.mode === "url" && response.content !== null)) fail("unsupported-elicitation-response");
  return { action: response.action, content: structuredClone(response.content) };
}

/** A trusted UI/elicitation adapter installs the channel. Neither a model tool
 * argument nor an event payload can install it or impersonate its response.
 * Every answer is bound to one opaque callback token and a live owned turn.
 */
export class ExecutorApprovalRelayV1 {
  #ownsTurn;
  #timeoutMs;
  #maximumPending;
  #pending = 0;
  #channel = null;
  #lifetime = new AbortController();

  constructor({ ownsTurn, timeoutMs = 60_000, maximumPending = 16 }) {
    if (typeof ownsTurn !== "function") fail("approval-ownership-required");
    executorInteger(timeoutMs); executorInteger(maximumPending);
    if (timeoutMs > 300_000 || maximumPending > 64) fail("invalid-approval-limits");
    this.#ownsTurn = ownsTurn; this.#timeoutMs = timeoutMs; this.#maximumPending = maximumPending;
  }

  attachChannel({ request, signal }) {
    if (typeof request !== "function" || !signal || typeof signal.addEventListener !== "function" ||
        signal.aborted || this.#lifetime.signal.aborted) fail("invalid-approval-channel");
    this.#channel?.controller.abort();
    const channel = { request, signal, controller: new AbortController() };
    this.#channel = channel;
    return () => {
      channel.controller.abort();
      if (this.#channel === channel) this.#channel = null;
    };
  }

  status() {
    return { connected: Boolean(this.#channel && !this.#channel.signal.aborted && !this.#lifetime.signal.aborted),
      pending: this.#pending, methods: [...EXECUTOR_INTERACTION_METHODS_V1] };
  }

  async handle({ id, method, params, signal }) {
    if (!EXECUTOR_INTERACTION_METHODS_V1.includes(method)) fail("unsupported-server-request");
    const canceled = cancel(method);
    const channel = this.#channel;
    if (!channel || this.#lifetime.signal.aborted || this.#pending >= this.#maximumPending) return canceled;
    try {
      if (!(Number.isSafeInteger(id) || (typeof id === "string" && id.length > 0 && id.length <= 512)) ||
          !object(params) || !signal || Buffer.byteLength(JSON.stringify(params)) > 64 * 1024) return canceled;
      executorText(params.threadId, 256); executorText(params.turnId, 256);
      if (method !== MCP) executorText(params.itemId, 256);
    } catch { return canceled; }
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, channel.signal, channel.controller.signal, this.#lifetime.signal, controller.signal]);
    if (combined.aborted) return canceled;
    const requestToken = randomUUID();
    const scope = { threadId: params.threadId, turnId: params.turnId };
    const snapshot = structuredClone(params);
    this.#pending += 1;
    let timer; let abort;
    const action = Promise.resolve().then(async () => {
      if (combined.aborted || !await this.#ownsTurn(scope, { signal: combined }) || combined.aborted) return canceled;
      const answer = await channel.request({ requestToken, method, params: snapshot,
        supportedDecisions: [COMMAND, FILE].includes(method) ? ["accept", "decline", "cancel"].filter((choice) =>
          method !== COMMAND || params.availableDecisions == null || params.availableDecisions.includes(choice)) : null,
      }, { signal: combined });
      if (combined.aborted || this.#channel !== channel) return canceled;
      executorExact(answer, ["requestToken", "response"]);
      if (answer.requestToken !== requestToken || Buffer.byteLength(JSON.stringify(answer.response)) > 32 * 1024) return canceled;
      // Recheck after the user decision: the turn or connection may have ended.
      if (!await this.#ownsTurn(scope, { signal: combined }) || combined.aborted) return canceled;
      return responseFor(method, params, answer.response);
    }).catch(() => canceled).finally(() => { this.#pending -= 1; });
    try {
      return await Promise.race([action, new Promise((resolve) => {
        abort = () => resolve(canceled);
        combined.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      })]);
    } finally {
      clearTimeout(timer); combined.removeEventListener("abort", abort); controller.abort();
    }
  }

  close() {
    this.#lifetime.abort();
    this.#channel?.controller.abort();
    this.#channel = null;
  }
}
