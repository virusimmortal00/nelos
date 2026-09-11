import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  AppServerRpcDispatcher,
  validateAppServerDispatcherOptions,
} from "./app-server-rpc-dispatcher.mjs";
import {
  normalizeExecutionProbeOptionsV1,
  probeAppServerExecutionV1,
} from "./app-server-execution-profile.mjs";

import { appServerVersionFromUserAgent } from "./app-server-version.mjs";
import { isSemanticVersion } from "./experimentation-contract/semantic-version.mjs";
import { renderQueenTitle } from "./task-launch-prompt.mjs";

export const MCP_APP_SERVER_BRIDGE_SCHEMA_VERSION = 1;
export const TESTED_CODEX_APP_SERVER_VERSIONS = Object.freeze([
  "0.144.5",
  "0.144.6",
]);
// Deprecated schema-v1 export: CLI versions no longer impose a runtime floor.
export const MINIMUM_CODEX_APP_SERVER_VERSION = null;
// Backward-compatible package export. These are the versions Nelos has tested,
// not an exhaustive allowlist of versions that may use the bridge.
export const SUPPORTED_CODEX_APP_SERVER_VERSIONS =
  TESTED_CODEX_APP_SERVER_VERSIONS;
export const REQUIRED_CODEX_APP_SERVER_INITIALIZE_FIELDS = Object.freeze([
  "codexHome",
  "platformFamily",
  "platformOs",
  "userAgent",
]);
export const REQUIRED_CODEX_APP_SERVER_METHODS = Object.freeze([
  "thread/read",
  "thread/name/set",
  "thread/resume",
  "thread/turns/list",
  "turn/start",
  "turn/steer",
  "thread/archive",
]);
export const SUPPORTED_CODEX_APP_SERVER_THREAD_STATUSES = Object.freeze([
  "notLoaded",
  "idle",
  "systemError",
  "active",
]);
export const SUPPORTED_CODEX_APP_SERVER_ACTIVE_FLAGS = Object.freeze([
  "waitingOnApproval",
  "waitingOnUserInput",
]);
export const MCP_APP_SERVER_MAX_BATCH_THREADS = 16;
export const MCP_APP_SERVER_MAX_WAIT_THREADS = 8;
export const MCP_APP_SERVER_MAX_WAIT_MS = 30_000;
export const MCP_APP_SERVER_TITLE_SYNC_TIMEOUT_MS = 30_000;

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_IDENTIFIER_CHARACTERS = 512;
const MAX_TITLE_CHARACTERS = 512;
const MAX_PATH_CHARACTERS = 4096;
const MAX_USER_AGENT_CHARACTERS = 512;
const MAX_WAKE_MESSAGE_CHARACTERS = 4_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 250;
const MIN_WAIT_POLL_INTERVAL_MS = 50;
const WAIT_INITIAL_INSPECTION_ALLOWANCE_MS = 5_000;
const BATCH_CONCURRENCY = 4;
const THREAD_STATUS_TYPES = new Set(
  SUPPORTED_CODEX_APP_SERVER_THREAD_STATUSES,
);
const ACTIVE_FLAG_TYPES = new Set(SUPPORTED_CODEX_APP_SERVER_ACTIVE_FLAGS);
const COLLAB_AGENT_STATUSES = new Set([
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
]);

class AppServerBridgeError extends Error {
  constructor(message, { code, retriable = false } = {}) {
    super(message);
    this.name = "AppServerBridgeError";
    this.bridgeCode = code ?? "unknown";
    this.retriable = retriable;
  }
}

function bridgeError(message, code, { retriable = false } = {}) {
  return new AppServerBridgeError(message, { code, retriable });
}

function boundedText(value, field, maximum, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`app-server ${field} is invalid`);
  }
  return value;
}

function boundedMultilineText(value, field, maximum) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`app-server ${field} is invalid`);
  }
  return value;
}

function threadId(value) {
  return boundedText(value, "thread ID", MAX_IDENTIFIER_CHARACTERS);
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function publicStatus(value) {
  const type = typeof value === "string" ? value : value?.type;
  if (!THREAD_STATUS_TYPES.has(type)) {
    throw bridgeError(
      "Codex app-server returned an incompatible thread status",
      "invalid-response",
    );
  }
  if (type !== "active") return { status: type };
  if (!Array.isArray(value?.activeFlags)) {
    throw bridgeError(
      "Codex app-server returned invalid active thread flags",
      "invalid-response",
    );
  }
  const activeFlags = [...new Set(value.activeFlags)].sort();
  if (activeFlags.some((flag) => !ACTIVE_FLAG_TYPES.has(flag))) {
    throw bridgeError(
      "Codex app-server returned an incompatible active thread flag",
      "invalid-response",
    );
  }
  return { status: type, activeFlags };
}

function publicThread(thread, expectedThreadId) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
    throw bridgeError(
      "Codex app-server thread/read returned no thread",
      "invalid-response",
    );
  }
  const observedThreadId = threadId(thread.id);
  if (observedThreadId !== expectedThreadId) {
    throw bridgeError(
      "Codex app-server thread/read returned a different thread",
      "invalid-response",
    );
  }
  const status = publicStatus(thread.status);
  return {
    schemaVersion: MCP_APP_SERVER_BRIDGE_SCHEMA_VERSION,
    threadId: observedThreadId,
    title: boundedText(thread.name, "thread title", MAX_TITLE_CHARACTERS, {
      nullable: true,
    }),
    ...status,
    cwd: boundedText(thread.cwd, "thread cwd", MAX_PATH_CHARACTERS, {
      nullable: true,
    }),
    parentThreadId: boundedText(
      thread.parentThreadId,
      "parent thread ID",
      MAX_IDENTIFIER_CHARACTERS,
      { nullable: true },
    ),
    createdAt: integerOrNull(thread.createdAt),
    updatedAt: integerOrNull(thread.updatedAt),
  };
}

function initializeCompatibility(result, testedVersions) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw bridgeError(
      "Codex app-server initialize response is incompatible",
      "incompatible-initialize",
    );
  }
  let userAgent;
  let platformFamily;
  let platformOs;
  try {
    for (const field of REQUIRED_CODEX_APP_SERVER_INITIALIZE_FIELDS) {
      if (!(field in result)) {
        throw new Error(`missing initialize field ${field}`);
      }
    }
    userAgent = boundedText(
      result.userAgent,
      "user agent",
      MAX_USER_AGENT_CHARACTERS,
    );
    boundedText(result.codexHome, "Codex home", MAX_PATH_CHARACTERS);
    platformFamily = boundedText(result.platformFamily, "platform family", 64);
    platformOs = boundedText(result.platformOs, "platform OS", 64);
  } catch {
    throw bridgeError(
      "Codex app-server initialize response is incompatible",
      "incompatible-initialize",
    );
  }
  const version = appServerVersionFromUserAgent(userAgent);
  return {
    version,
    versionTested: testedVersions.includes(version),
    platformFamily,
    platformOs,
  };
}

function boundedThreadIds(values, maximum, field = "threadIds") {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > maximum
  ) {
    throw new Error(
      `${field} must contain between 1 and ${maximum} thread IDs`,
    );
  }
  const resolved = values.map((value) => threadId(value));
  if (new Set(resolved).size !== resolved.length) {
    throw new Error(`${field} must not contain duplicate thread IDs`);
  }
  return resolved;
}

function boundedCursor(value, field) {
  if (value === null || value === undefined) return null;
  return boundedText(value, field, MAX_IDENTIFIER_CHARACTERS);
}

function snapshotCursor(thread) {
  const canonical = JSON.stringify({
    threadId: thread.threadId,
    status: thread.status,
    activeFlags: thread.activeFlags ?? [],
    updatedAt: thread.updatedAt,
  });
  return `snapshot-v1:${createHash("sha256")
    .update(canonical)
    .digest("base64url")}`;
}

function attentionRequired(thread) {
  return (
    thread.status === "systemError" ||
    (thread.status === "active" && (thread.activeFlags?.length ?? 0) > 0)
  );
}

function publicFailure(error) {
  const code =
    typeof error?.bridgeCode === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(error.bridgeCode)
      ? error.bridgeCode
      : "invalid-response";
  return {
    code,
    retriable: error?.retriable === true,
  };
}

const CERTAINLY_UNAPPLIED_MUTATION_CODES = new Set([
  "request-rejected",
  "method-unsupported",
  "bridge-closed",
  "input-unavailable",
]);

function mutationFailure(error) {
  return {
    ...publicFailure(error),
    uncertain: !CERTAINLY_UNAPPLIED_MUTATION_CODES.has(error?.bridgeCode),
  };
}

function buildTopology(items) {
  const ready = items.filter((item) => item.state === "ready");
  const readyIds = new Set(ready.map((item) => item.thread.threadId));
  const nodes = ready.map((item) => item.thread);
  const edges = [];
  const externalParents = [];
  for (const item of ready) {
    const { parentThreadId, threadId: childThreadId } = item.thread;
    if (!parentThreadId) continue;
    if (readyIds.has(parentThreadId)) {
      edges.push({ parentThreadId, childThreadId });
    } else {
      externalParents.push({ threadId: childThreadId, parentThreadId });
    }
  }
  return {
    schemaVersion: MCP_APP_SERVER_BRIDGE_SCHEMA_VERSION,
    nodes,
    edges,
    externalParents,
  };
}

function positiveInteger(value, field, { minimum = 1, maximum } = {}) {
  if (!Number.isSafeInteger(minimum) || minimum < 0) {
    throw new Error(`${field} minimum bound is invalid`);
  }
  const hasMaximum = maximum !== undefined;
  if (
    hasMaximum &&
    (!Number.isSafeInteger(maximum) || maximum < minimum)
  ) {
    throw new Error(`${field} maximum bound is invalid`);
  }
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    (hasMaximum && value > maximum)
  ) {
    const range = hasMaximum
      ? `between ${minimum} and ${maximum}`
      : `of at least ${minimum}`;
    throw new Error(`${field} must be an integer ${range}`);
  }
  return value;
}

function beforeDeadline(promise, deadlineAt, method) {
  if (deadlineAt === null) return promise;
  const remainingMs = Math.floor(deadlineAt - Date.now());
  if (remainingMs <= 0) {
    return Promise.reject(
      bridgeError(`Codex app-server ${method} timed out`, "timeout"),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          bridgeError(`Codex app-server ${method} timed out`, "timeout"),
        ),
      remainingMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class CodexAppServerBridgeV1 {
  #batchItemsFailed = 0;
  #batchItemsRequested = 0;
  #batchItemsSucceeded = 0;
  #batchRequests = 0;
  #child = null;
  #closed = false;
  #command;
  #compatibility = {
    state: "idle",
    version: null,
    platformFamily: null,
    platformOs: null,
  };
  #connectionAttempts = 0;
  #dispatcher = null;
  #dispatcherOptions;
  #failureSequence = 0;
  #lastFailure = null;
  #mutationAttempts = 0;
  #nextId = 1;
  #partialBatches = 0;
  #pending = new Map();
  #readRetries = 0;
  #ready = null;
  #requestsFailed = 0;
  #requestsSucceeded = 0;
  #requestTimeoutMs;
  #spawnProcess;
  #stdoutBuffer = "";
  #testedVersions;
  #topologyProjections = 0;
  #waitEvents = 0;
  #waitInitialInspectionAllowanceMs;
  #waitPolls = 0;
  #waitRequests = 0;
  #waitTimeouts = 0;

  constructor({
    command = "codex",
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    spawnProcess = spawn,
    supportedVersions,
    testedVersions = supportedVersions ?? TESTED_CODEX_APP_SERVER_VERSIONS,
    waitInitialInspectionAllowanceMs = WAIT_INITIAL_INSPECTION_ALLOWANCE_MS,
    dispatcherOptions = {},
  } = {}) {
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("app-server command must be a non-empty string");
    }
    positiveInteger(requestTimeoutMs, "app-server request timeout");
    if (typeof spawnProcess !== "function") {
      throw new Error("app-server spawnProcess must be a function");
    }
    if (
      !Number.isSafeInteger(waitInitialInspectionAllowanceMs) ||
      waitInitialInspectionAllowanceMs <= 0 ||
      waitInitialInspectionAllowanceMs > WAIT_INITIAL_INSPECTION_ALLOWANCE_MS
    ) {
      throw new Error(
        "wait initial inspection allowance must be an integer between 1 and 5000",
      );
    }
    if (
      !Array.isArray(testedVersions) ||
      testedVersions.some(
        (version) =>
          typeof version !== "string" ||
          !isSemanticVersion(version),
      )
    ) {
      throw new Error(
        "app-server testedVersions must contain semantic versions",
      );
    }
    this.#command = command;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#spawnProcess = spawnProcess;
    this.#testedVersions = Object.freeze([...new Set(testedVersions)]);
    this.#waitInitialInspectionAllowanceMs =
      waitInitialInspectionAllowanceMs;
    this.#dispatcherOptions = validateAppServerDispatcherOptions(dispatcherOptions);
  }

  async #connect({ deadlineAt = null } = {}) {
    if (this.#closed) {
      throw bridgeError("Codex app-server bridge is closed", "bridge-closed");
    }
    if (this.#ready) {
      return beforeDeadline(this.#ready, deadlineAt, "initialize");
    }
    this.#connectionAttempts += 1;
    this.#stdoutBuffer = "";
    this.#compatibility = {
      state: "connecting",
      version: this.#compatibility.version,
      platformFamily: this.#compatibility.platformFamily,
      platformOs: this.#compatibility.platformOs,
    };
    let child;
    this.#ready = (async () => {
      child = this.#spawnProcess(this.#command, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#child = child;
      this.#dispatcher = new AppServerRpcDispatcher({
        ...this.#dispatcherOptions,
        sendResponse: (message) => {
          if (child !== this.#child) return;
          this.#write(message);
        },
        onResponse: (message) => this.#response(message),
        onError: (error) => this.#fail(
          bridgeError("Codex app-server dispatch failed", error.code), child,
        ),
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.#consume(chunk, child));
      child.once("error", (error) => this.#fail(error, child));
      child.once("exit", (code, signal) => {
        this.#fail(
          new Error(
            `Codex app-server exited unexpectedly (${signal || code || "unknown"})`,
          ),
          child,
        );
      });
      child.stderr?.resume();

      const initialized = await this.#request(
        "initialize",
        {
          clientInfo: {
            name: "nelos_mcp",
            title: "Nelos MCP",
            version: "1.0.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
        { deadlineAt, skipConnect: true },
      );
      const compatibility = initializeCompatibility(
        initialized,
        this.#testedVersions,
      );
      this.#compatibility = {
        state: "ready",
        ...compatibility,
      };
      this.#notify("initialized", {});
    })();
    try {
      await beforeDeadline(this.#ready, deadlineAt, "initialize");
    } catch (error) {
      const normalized =
        error instanceof AppServerBridgeError
          ? error
          : bridgeError(
              "Codex app-server initialization failed",
              "initialize-failed",
              { retriable: true },
            );
      if (!child || child === this.#child) {
        this.#fail(
          normalized,
          child ?? this.#child,
          normalized.bridgeCode,
        );
      }
      throw normalized;
    }
  }

  #recordFailure(code, method = null) {
    this.#failureSequence += 1;
    this.#lastFailure = {
      sequence: this.#failureSequence,
      code,
      method,
    };
  }

  #consume(chunk, sourceChild) {
    if (sourceChild !== this.#child) return;
    this.#stdoutBuffer += chunk;
    let newline;
    while ((newline = this.#stdoutBuffer.indexOf("\n")) !== -1) {
      const rawLine = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine, "utf8") > MAX_MESSAGE_BYTES) {
        this.#fail(bridgeError("Codex app-server message exceeded the size limit", "response-too-large"), sourceChild);
        return;
      }
      const line = rawLine.trim();
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail(
          bridgeError(
            "Codex app-server returned malformed JSON",
            "malformed-json",
            { retriable: true },
          ),
          sourceChild,
        );
        return;
      }
      this.#dispatcher.receive(message);
      if (sourceChild !== this.#child) return;
    }
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > MAX_MESSAGE_BYTES) {
      this.#fail(bridgeError("Codex app-server message exceeded the size limit", "response-too-large"), sourceChild);
    }
  }

  #response(message) {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      this.#requestsFailed += 1;
      const unsupported = message.error.code === -32601;
      const code = unsupported ? "method-unsupported" : "request-rejected";
      this.#recordFailure(code, pending.method);
      const error = bridgeError(unsupported
        ? `Codex app-server does not support ${pending.method}`
        : "Codex app-server request failed", code);
      error.rpcCode = Number.isSafeInteger(message.error.code) ? message.error.code : null;
      pending.reject(error);
    } else {
      this.#requestsSucceeded += 1;
      pending.resolve(message.result);
    }
  }

  #fail(error, sourceChild = this.#child, fallbackCode = "transport-failure") {
    if (sourceChild && sourceChild !== this.#child) return;
    const normalized =
      error instanceof AppServerBridgeError
        ? error
        : bridgeError("Codex app-server transport failed", fallbackCode, {
            retriable: true,
          });
    const child = this.#child;
    this.#dispatcher?.close();
    this.#dispatcher = null;
    this.#child = null;
    this.#ready = null;
    this.#stdoutBuffer = "";
    if (normalized.bridgeCode.startsWith("incompatible-")) {
      this.#compatibility = {
        ...this.#compatibility,
        state: "incompatible",
      };
    } else {
      this.#compatibility = {
        ...this.#compatibility,
        state: "unavailable",
      };
    }
    let recorded = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      this.#requestsFailed += 1;
      this.#recordFailure(normalized.bridgeCode, pending.method);
      recorded = true;
      pending.reject(normalized);
    }
    if (!recorded) this.#recordFailure(normalized.bridgeCode);
    this.#pending.clear();
    child?.stdin?.destroy();
    child?.kill?.("SIGTERM");
  }

  #write(message) {
    if (!this.#child?.stdin?.writable) {
      throw bridgeError(
        "Codex app-server input is unavailable",
        "input-unavailable",
        { retriable: true },
      );
    }
    const payload = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(payload) + (this.#child.stdin.writableLength ?? 0) > MAX_MESSAGE_BYTES) {
      throw bridgeError("Codex app-server output capacity exceeded", "output-overflow");
    }
    this.#child.stdin.write(payload);
  }

  #notify(method, params) {
    this.#write({ method, params });
  }

  async #request(
    method,
    params,
    {
      deadlineAt = null,
      skipConnect = false,
      mutation = false,
    } = {},
  ) {
    if (!skipConnect) await this.#connect({ deadlineAt });
    if (this.#pending.size >= 256) {
      throw bridgeError("Codex app-server request capacity exceeded", "request-overflow");
    }
    if (mutation) this.#mutationAttempts += 1;
    let timeoutMs = this.#requestTimeoutMs;
    if (deadlineAt !== null) {
      if (!Number.isFinite(deadlineAt)) {
        throw new Error("app-server request deadline must be finite");
      }
      const remainingMs = Math.floor(deadlineAt - Date.now());
      if (remainingMs <= 0) {
        throw bridgeError(
          `Codex app-server ${method} timed out`,
          "timeout",
        );
      }
      timeoutMs = Math.min(timeoutMs, remainingMs);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeoutError = bridgeError(
          `Codex app-server ${method} timed out`,
          "timeout",
          { retriable: deadlineAt === null && !mutation },
        );
        if (deadlineAt !== null && !mutation) {
          const pending = this.#pending.get(id);
          if (!pending) return;
          this.#pending.delete(id);
          this.#requestsFailed += 1;
          this.#recordFailure("timeout", method);
          pending.reject(timeoutError);
          return;
        }
        this.#fail(timeoutError);
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method, mutation });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        this.#fail(error);
      }
    });
  }

  async #readRequest(method, params, { deadlineAt = null } = {}) {
    try {
      return await this.#request(method, params, { deadlineAt });
    } catch (error) {
      if (error?.retriable !== true) throw error;
      this.#readRetries += 1;
      return this.#request(method, params, { deadlineAt });
    }
  }

  async probeExecution(options) {
    const selected = normalizeExecutionProbeOptionsV1(options);
    const deadlineAt = Date.now() + selected.timeoutMs;
    await this.#connect({ deadlineAt });
    const child = this.#child;
    const epoch = this.#connectionAttempts;
    const requireSameConnection = () => {
      if (!child || child !== this.#child || epoch !== this.#connectionAttempts || this.#closed) {
        throw bridgeError("Codex app-server probe connection changed", "probe-connection-changed");
      }
    };
    const result = await probeAppServerExecutionV1({
      observedVersion: this.#compatibility.version,
      options: { ...selected, timeoutMs: Math.max(1, deadlineAt - Date.now()) },
      request: async (method, params) => {
        requireSameConnection();
        // Discovery never retries or reconnects: all observations belong to one process.
        const response = await this.#request(method, params, { deadlineAt, skipConnect: true });
        requireSameConnection();
        return response;
      },
    });
    if (child !== this.#child || epoch !== this.#connectionAttempts || this.#closed) {
      result.state = "unavailable";
      result.blockers.push({ code: "probe-connection-changed", method: null, rpcCode: null });
    }
    return result;
  }

  async health({ probe = false } = {}) {
    if (
      probe &&
      ["idle", "unavailable", "incompatible"].includes(this.#compatibility.state)
    ) {
      try {
        await this.#connect();
      } catch {
        // Health reports the bounded compatibility state instead of echoing
        // arbitrary process or protocol errors.
      }
    }
    return {
      schemaVersion: MCP_APP_SERVER_BRIDGE_SCHEMA_VERSION,
      state: this.#compatibility.state,
      compatible: this.#compatibility.state === "ready",
      version: this.#compatibility.version,
      versionTested:
        this.#compatibility.version === null
          ? null
          : this.#testedVersions.includes(this.#compatibility.version),
      platformFamily: this.#compatibility.platformFamily,
      platformOs: this.#compatibility.platformOs,
      minimumVersion: null,
      testedVersions: [...this.#testedVersions],
      // Retained for schema-v1 consumers. New integrations should use
      // testedVersions; no CLI version is blocked.
      supportedVersions: [...this.#testedVersions],
      requiredMethods: [...REQUIRED_CODEX_APP_SERVER_METHODS],
      connectionAttempts: this.#connectionAttempts,
      reconnects: Math.max(0, this.#connectionAttempts - 1),
      requestsSucceeded: this.#requestsSucceeded,
      requestsFailed: this.#requestsFailed,
      readRetries: this.#readRetries,
      mutationAttempts: this.#mutationAttempts,
      batchRequests: this.#batchRequests,
      batchItemsRequested: this.#batchItemsRequested,
      batchItemsSucceeded: this.#batchItemsSucceeded,
      batchItemsFailed: this.#batchItemsFailed,
      partialBatches: this.#partialBatches,
      topologyProjections: this.#topologyProjections,
      waitRequests: this.#waitRequests,
      waitPolls: this.#waitPolls,
      waitEvents: this.#waitEvents,
      waitTimeouts: this.#waitTimeouts,
      lastFailure: this.#lastFailure ? { ...this.#lastFailure } : null,
    };
  }

  async inspect({
    threadId: requestedThreadId = process.env.CODEX_THREAD_ID,
    deadlineAt = null,
  } = {}) {
    const resolvedThreadId = threadId(requestedThreadId);
    const result = await this.#readRequest("thread/read", {
      threadId: resolvedThreadId,
      includeTurns: false,
    }, { deadlineAt });
    return publicThread(result?.thread, resolvedThreadId);
  }

  async inspectMany({
    threadIds,
    includeTopology = true,
    deadlineAt = null,
  } = {}) {
    const resolvedThreadIds = boundedThreadIds(
      threadIds,
      MCP_APP_SERVER_MAX_BATCH_THREADS,
    );
    if (typeof includeTopology !== "boolean") {
      throw new Error("includeTopology must be a boolean");
    }
    this.#batchRequests += 1;
    this.#batchItemsRequested += resolvedThreadIds.length;
    const items = new Array(resolvedThreadIds.length);
    let fatalError = null;
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < resolvedThreadIds.length) {
        const index = nextIndex;
        nextIndex += 1;
        const resolvedThreadId = resolvedThreadIds[index];
        try {
          items[index] = {
            threadId: resolvedThreadId,
            state: "ready",
            thread: await this.inspect({
              threadId: resolvedThreadId,
              deadlineAt,
            }),
          };
          this.#batchItemsSucceeded += 1;
        } catch (error) {
          if (
            error?.bridgeCode?.startsWith("incompatible-") ||
            error?.bridgeCode === "bridge-closed"
          ) {
            fatalError ??= error;
          }
          items[index] = {
            threadId: resolvedThreadId,
            state: "failed",
            error: publicFailure(error),
          };
          this.#batchItemsFailed += 1;
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(BATCH_CONCURRENCY, resolvedThreadIds.length) },
        () => worker(),
      ),
    );
    if (fatalError) throw fatalError;
    const succeeded = items.filter((item) => item.state === "ready").length;
    const failed = items.length - succeeded;
    if (succeeded > 0 && failed > 0) this.#partialBatches += 1;
    const inventory = {
      schemaVersion: MCP_APP_SERVER_BRIDGE_SCHEMA_VERSION,
      requested: resolvedThreadIds.length,
      succeeded,
      failed,
      items,
    };
    if (includeTopology) {
      this.#topologyProjections += 1;
      inventory.topology = buildTopology(items);
    }
    return inventory;
  }

  async waitForThreads({
    targets,
    timeoutMs = 0,
    pollIntervalMs = DEFAULT_WAIT_POLL_INTERVAL_MS,
  } = {}) {
    if (
      !Array.isArray(targets) ||
      targets.length === 0 ||
      targets.length > MCP_APP_SERVER_MAX_WAIT_THREADS
    ) {
      throw new Error(
        `targets must contain between 1 and ${MCP_APP_SERVER_MAX_WAIT_THREADS} entries`,
      );
    }
    const allowedTargetFields = new Set(["threadId", "afterCursor"]);
    for (const target of targets) {
      if (
        !target ||
        typeof target !== "object" ||
        Array.isArray(target) ||
        Object.keys(target).some((key) => !allowedTargetFields.has(key))
      ) {
        throw new Error("each wait target must contain only threadId and afterCursor");
      }
    }
    const resolvedThreadIds = boundedThreadIds(
      targets.map((target) => target.threadId),
      MCP_APP_SERVER_MAX_WAIT_THREADS,
      "targets",
    );
    const resolvedTargets = targets.map((target, index) => ({
      threadId: resolvedThreadIds[index],
      afterCursor: boundedCursor(
        target.afterCursor,
        "wait target afterCursor",
      ),
    }));
    const resolvedTimeoutMs = positiveInteger(timeoutMs, "timeoutMs", {
      minimum: 0,
      maximum: MCP_APP_SERVER_MAX_WAIT_MS,
    });
    const resolvedPollIntervalMs = positiveInteger(
      pollIntervalMs,
      "pollIntervalMs",
      {
        minimum: MIN_WAIT_POLL_INTERVAL_MS,
        maximum: 5_000,
      },
    );
    this.#waitRequests += 1;
    const startedAt = Date.now();
    const hardDeadlineAt =
      startedAt +
      Math.min(
        MCP_APP_SERVER_MAX_WAIT_MS,
        Math.max(
          1,
          resolvedTimeoutMs + this.#waitInitialInspectionAllowanceMs,
        ),
      );
    while (true) {
      this.#waitPolls += 1;
      const inventory = await this.inspectMany({
        threadIds: resolvedThreadIds,
        includeTopology: false,
        deadlineAt: hardDeadlineAt,
      });
      const snapshots = inventory.items.map((item, index) => {
        const target = resolvedTargets[index];
        if (item.state === "failed") {
          return {
            threadId: target.threadId,
            state: "failed",
            error: item.error,
            cursor: null,
            changed: true,
            attentionRequired: true,
          };
        }
        const cursor = snapshotCursor(item.thread);
        return {
          threadId: target.threadId,
          state: "ready",
          thread: item.thread,
          cursor,
          changed: target.afterCursor !== cursor,
          attentionRequired: attentionRequired(item.thread),
        };
      });
      if (
        snapshots.some(
          (snapshot) =>
            snapshot.state === "failed" &&
            snapshot.error.code === "timeout",
        )
      ) {
        this.#waitTimeouts += 1;
        return {
          schemaVersion: MCP_APP_SERVER_BRIDGE_SCHEMA_VERSION,
          status: "timeout",
          snapshots,
        };
      }
      if (
        snapshots.some(
          (snapshot) => snapshot.changed || snapshot.attentionRequired,
        )
      ) {
        this.#waitEvents += 1;
        return {
          schemaVersion: MCP_APP_SERVER_BRIDGE_SCHEMA_VERSION,
          status: "event",
          snapshots,
        };
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= resolvedTimeoutMs) {
        this.#waitTimeouts += 1;
        return {
          schemaVersion: MCP_APP_SERVER_BRIDGE_SCHEMA_VERSION,
          status: "timeout",
          snapshots,
        };
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            resolvedPollIntervalMs,
            resolvedTimeoutMs - elapsedMs,
            hardDeadlineAt - Date.now(),
          ),
        ),
      );
    }
  }

  async findTurnByClientMessageId({
    threadId: requestedThreadId,
    clientUserMessageId,
  } = {}) {
    const resolvedThreadId = threadId(requestedThreadId);
    const resolvedClientId = boundedText(
      clientUserMessageId,
      "client user message ID",
      MAX_IDENTIFIER_CHARACTERS,
    );
    const result = await this.#readRequest("thread/turns/list", {
      threadId: resolvedThreadId,
      limit: 20,
      sortDirection: "desc",
      itemsView: "full",
    });
    if (
      !Array.isArray(result?.data) ||
      result.data.length > 20 ||
      !(
        result.nextCursor === null ||
        (
          typeof result.nextCursor === "string" &&
          result.nextCursor.length > 0 &&
          result.nextCursor.length <= MAX_IDENTIFIER_CHARACTERS
        )
      )
    ) {
      throw bridgeError(
        "Codex app-server returned an incompatible turn page",
        "invalid-response",
      );
    }
    for (const turn of result.data) {
      if (
        typeof turn?.id !== "string" ||
        !Array.isArray(turn.items)
      ) {
        throw bridgeError(
          "Codex app-server returned an incompatible turn",
          "invalid-response",
        );
      }
      if (
        turn.items.some(
          (item) =>
            item?.type === "userMessage" &&
            item.clientId === resolvedClientId,
        )
      ) {
        return { found: true, turnId: turn.id, searchComplete: true };
      }
    }
    return {
      found: false,
      turnId: null,
      searchComplete: result.nextCursor === null,
    };
  }

  async latestActiveTurnId({ threadId: requestedThreadId } = {}) {
    const resolvedThreadId = threadId(requestedThreadId);
    const result = await this.#readRequest("thread/turns/list", {
      threadId: resolvedThreadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    });
    if (!Array.isArray(result?.data) || result.data.length > 1) {
      throw bridgeError(
        "Codex app-server returned an incompatible active turn page",
        "invalid-response",
      );
    }
    const turn = result.data[0];
    if (!turn || turn.status !== "inProgress") return null;
    return threadId(turn.id);
  }

  async latestTurn({ threadId: requestedThreadId } = {}) {
    const resolvedThreadId = threadId(requestedThreadId);
    const result = await this.#readRequest("thread/turns/list", {
      threadId: resolvedThreadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    });
    if (!Array.isArray(result?.data) || result.data.length > 1) {
      throw bridgeError(
        "Codex app-server returned an incompatible latest turn page",
        "invalid-response",
      );
    }
    const turn = result.data[0];
    if (!turn) return null;
    if (typeof turn.status !== "string" || !turn.status) {
      throw bridgeError(
        "Codex app-server returned an incompatible latest turn",
        "invalid-response",
      );
    }
    return {
      turnId: threadId(turn.id),
      status: turn.status,
    };
  }

  async collaborationAgentStatus({
    parentThreadId: requestedParentThreadId,
    agentThreadId: requestedAgentThreadId,
  } = {}) {
    const parentThreadId = threadId(requestedParentThreadId);
    const agentThreadId = threadId(requestedAgentThreadId);
    const result = await this.#readRequest("thread/turns/list", {
      threadId: parentThreadId,
      limit: 20,
      sortDirection: "desc",
      itemsView: "full",
    });
    if (
      !Array.isArray(result?.data) ||
      result.data.length > 20 ||
      !(
        result.nextCursor === null ||
        (typeof result.nextCursor === "string" &&
          result.nextCursor.length > 0 &&
          result.nextCursor.length <= MAX_IDENTIFIER_CHARACTERS)
      )
    ) {
      throw bridgeError(
        "Codex app-server returned an incompatible collaboration turn page",
        "invalid-response",
      );
    }
    for (const turn of result.data) {
      if (typeof turn?.id !== "string" || !Array.isArray(turn.items)) {
        throw bridgeError(
          "Codex app-server returned an incompatible collaboration turn",
          "invalid-response",
        );
      }
      for (const item of [...turn.items].reverse()) {
        if (
          item?.type !== "collabAgentToolCall" ||
          item.senderThreadId !== parentThreadId ||
          !Array.isArray(item.receiverThreadIds) ||
          !item.receiverThreadIds.includes(agentThreadId) ||
          !item.agentsStates ||
          typeof item.agentsStates !== "object" ||
          Array.isArray(item.agentsStates) ||
          !Object.hasOwn(item.agentsStates, agentThreadId)
        ) {
          continue;
        }
        const status = item.agentsStates[agentThreadId]?.status;
        if (!COLLAB_AGENT_STATUSES.has(status)) {
          throw bridgeError(
            "Codex app-server returned an incompatible collaboration agent status",
            "invalid-response",
          );
        }
        return {
          status,
          parentTurnId: threadId(turn.id),
          toolCallId: boundedText(
            item.id,
            "collaboration tool call ID",
            MAX_IDENTIFIER_CHARACTERS,
          ),
        };
      }
    }
    return {
      status: "unavailable",
      parentTurnId: null,
      toolCallId: null,
    };
  }

  async deliverParentWake({
    queenThreadId,
    clientUserMessageId,
    message,
    reconciliationRequired = false,
  } = {}) {
    if (typeof reconciliationRequired !== "boolean") {
      throw new Error("app-server reconciliationRequired must be a boolean");
    }
    const resolvedQueenThreadId = threadId(queenThreadId);
    const resolvedClientId = boundedText(
      clientUserMessageId,
      "client user message ID",
      MAX_IDENTIFIER_CHARACTERS,
    );
    const resolvedMessage = boundedMultilineText(
      message,
      "parent wake message",
      MAX_WAKE_MESSAGE_CHARACTERS,
    );
    const existing = await this.findTurnByClientMessageId({
      threadId: resolvedQueenThreadId,
      clientUserMessageId: resolvedClientId,
    });
    if (existing.found) {
      return {
        delivered: true,
        replayed: true,
        deferred: false,
        reason: null,
        queenTurnId: existing.turnId,
        deliveryMode: "replay",
      };
    }
    if (reconciliationRequired && !existing.searchComplete) {
      const error = bridgeError(
        "Codex app-server wake reconciliation exceeded its bounded history",
        "wake-history-truncated",
      );
      error.mutationUncertain = true;
      throw error;
    }

    let queen = await this.inspect({ threadId: resolvedQueenThreadId });
    if (queen.status === "active") {
      const activeTurnId = await this.latestActiveTurnId({
        threadId: resolvedQueenThreadId,
      });
      if (activeTurnId === null) {
        return {
          delivered: false,
          replayed: false,
          deferred: true,
          reason: "queen-active-turn-unknown",
          queenTurnId: null,
        };
      }
      try {
        const result = await this.#request(
          "turn/steer",
          {
            threadId: resolvedQueenThreadId,
            expectedTurnId: activeTurnId,
            clientUserMessageId: resolvedClientId,
            input: [{ type: "text", text: resolvedMessage }],
          },
          { mutation: true },
        );
        const queenTurnId = threadId(result?.turnId);
        if (queenTurnId !== activeTurnId) {
          throw bridgeError(
            "Codex app-server steered a different queen turn",
            "invalid-response",
          );
        }
        return {
          delivered: true,
          replayed: false,
          deferred: false,
          reason: null,
          queenTurnId,
          deliveryMode: "steer",
        };
      } catch (error) {
        const failure = mutationFailure(error);
        const wrapped = bridgeError(
          "Codex app-server active parent wake delivery failed",
          failure.code,
          { retriable: !failure.uncertain },
        );
        wrapped.mutationUncertain = failure.uncertain;
        throw wrapped;
      }
    }
    if (queen.status === "systemError") {
      return {
        delivered: false,
        replayed: false,
        deferred: true,
        reason: "queen-system-error",
        queenTurnId: null,
      };
    }
    if (queen.status === "notLoaded") {
      await this.#request(
        "thread/resume",
        { threadId: resolvedQueenThreadId, excludeTurns: true },
        { mutation: true },
      );
      queen = await this.inspect({ threadId: resolvedQueenThreadId });
    }
    if (queen.status !== "idle") {
      return {
        delivered: false,
        replayed: false,
        deferred: true,
        reason: `queen-${queen.status}`,
        queenTurnId: null,
      };
    }
    try {
      const result = await this.#request(
        "turn/start",
        {
          threadId: resolvedQueenThreadId,
          clientUserMessageId: resolvedClientId,
          input: [{ type: "text", text: resolvedMessage }],
        },
        { mutation: true },
      );
      const queenTurnId = threadId(result?.turn?.id);
      return {
        delivered: true,
        replayed: false,
        deferred: false,
        reason: null,
        queenTurnId,
        deliveryMode: "start",
      };
    } catch (error) {
      const failure = mutationFailure(error);
      const wrapped = bridgeError(
        "Codex app-server parent wake delivery failed",
        failure.code,
        { retriable: !failure.uncertain },
      );
      wrapped.mutationUncertain = failure.uncertain;
      throw wrapped;
    }
  }

  async archiveThread({ threadId: requestedThreadId } = {}) {
    const resolvedThreadId = threadId(requestedThreadId);
    try {
      await this.#request(
        "thread/archive",
        { threadId: resolvedThreadId },
        { mutation: true },
      );
      return { archived: true, threadId: resolvedThreadId };
    } catch (error) {
      const failure = mutationFailure(error);
      const wrapped = bridgeError(
        "Codex app-server archive failed",
        failure.code,
        { retriable: !failure.uncertain },
      );
      wrapped.mutationUncertain = failure.uncertain;
      throw wrapped;
    }
  }

  async synchronizeQueenTitle({
    threadId: requestedThreadId = process.env.CODEX_THREAD_ID,
    deadlineAt: requestedDeadlineAt = null,
  } = {}) {
    const deadlineAt =
      requestedDeadlineAt ??
      Date.now() + MCP_APP_SERVER_TITLE_SYNC_TIMEOUT_MS;
    if (!Number.isFinite(deadlineAt)) {
      throw new Error("queen title synchronization deadline must be finite");
    }
    const before = await this.inspect({
      threadId: requestedThreadId,
      deadlineAt,
    });
    if (!before.title) {
      throw new Error("current queen task has no settled title");
    }
    const preflight = await this.inspect({
      threadId: before.threadId,
      deadlineAt,
    });
    if (preflight.title !== before.title) {
      throw bridgeError(
        "queen title changed during synchronization",
        "concurrent-title-change",
      );
    }
    // Codex 0.144.x has no title CAS or revision precondition. This second
    // read detects an already-visible competing write; the documented
    // operational contract excludes a manual Desktop rename in the remaining
    // read-to-set window.
    const requestedTitle = renderQueenTitle(preflight.title);
    if (requestedTitle.length > MAX_TITLE_CHARACTERS) {
      throw new Error("queen title exceeds the app-server title limit");
    }
    if (requestedTitle !== before.title) {
      await this.#request(
        "thread/name/set",
        {
          threadId: before.threadId,
          name: requestedTitle,
        },
        { deadlineAt, mutation: true },
      );
    }
    const after = await this.inspect({
      threadId: before.threadId,
      deadlineAt,
    });
    if (after.title !== requestedTitle) {
      throw new Error("queen title verification failed");
    }
    return {
      schemaVersion: MCP_APP_SERVER_BRIDGE_SCHEMA_VERSION,
      threadId: before.threadId,
      previousTitle: before.title,
      title: requestedTitle,
      changed: before.title !== requestedTitle,
      verified: true,
    };
  }

  async close() {
    const child = this.#child;
    this.#dispatcher?.close();
    this.#dispatcher = null;
    this.#child = null;
    this.#ready = null;
    this.#closed = true;
    this.#compatibility = {
      ...this.#compatibility,
      state: "idle",
    };
    if (!child) return;
    const closeError = bridgeError(
      "Codex app-server bridge closed",
      "bridge-closed",
    );
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(closeError);
    }
    this.#pending.clear();
    child.stdin?.end();
    child.kill?.("SIGTERM");
  }
}
