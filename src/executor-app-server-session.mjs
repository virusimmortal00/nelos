import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { AppServerRpcDispatcher, appServerResponseError, validateAppServerDispatcherOptions } from "./app-server-rpc-dispatcher.mjs";
import { ExecutorContractError, executorInteger, executorText } from "./executor-contract.mjs";
import { EXECUTION_DISCOVERY_SCHEMA_VERSION } from "./app-server-execution-profile.mjs";

const MAX_BYTES = 4 * 1024 * 1024;
const error = (code) => new ExecutorContractError(code);

/** One service-owned stdio connection. Never reconnects or retries a request.
 * This is an internal transport, not an MCP-accessible RPC proxy. Only the
 * supervisor closes it; a frontend disconnect must not close this session.
 */
export class ExecutorAppServerSessionV1 {
  #options;
  #state = "new";
  #connectionId = randomUUID();
  #version = null;
  #failure = null;
  #child = null;
  #dispatcher = null;
  #opening = null;
  #buffer = "";
  #pending = new Map();
  #sequence = 0;
  #stopTimer = null;
  #lifetime = new AbortController();

  constructor({ command, cwd, codexHome, spawnProcess = spawn, timeoutMs = 10_000,
    stopGraceMs = 1000, dispatcherOptions = {} }) {
    for (const path of [command, cwd, codexHome]) {
      executorText(path, 4096);
      if (!isAbsolute(path)) throw error("absolute-executor-path-required");
    }
    executorInteger(timeoutMs); executorInteger(stopGraceMs);
    if (timeoutMs > 30_000 || stopGraceMs > 5000 || typeof spawnProcess !== "function") throw error("invalid-session-options");
    this.#options = { command, cwd, codexHome, spawnProcess, timeoutMs, stopGraceMs,
      dispatcherOptions: validateAppServerDispatcherOptions(dispatcherOptions) };
  }

  get signal() { return this.#lifetime.signal; }

  status() {
    return { state: this.#state, connectionId: this.#connectionId, observedVersion: this.#version,
      pendingRequests: this.#pending.size, reason: this.#failure, runtimeCertified: false };
  }

  open() {
    if (this.#state === "ready") return Promise.resolve(this.status());
    if (this.#state === "opening") return this.#opening;
    if (this.#state !== "new") return Promise.reject(error("session-unavailable"));
    this.#state = "opening";
    // Defer spawn so concurrent open calls share the complete initialization.
    this.#opening = Promise.resolve().then(() => this.#initialize());
    return this.#opening;
  }

  async #initialize() {
    try {
      if (this.#state !== "opening") throw error("session-unavailable");
      const { command, cwd, codexHome, spawnProcess, dispatcherOptions } = this.#options;
      const child = spawnProcess(command, ["app-server", "--stdio"], {
        cwd, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "pipe"],
      });
      this.#child = child;
      this.#dispatcher = new AppServerRpcDispatcher({ ...dispatcherOptions,
        sendResponse: (message) => this.#write(message),
        onResponse: (message) => {
          const pending = this.#pending.get(message.id);
          if (!pending) return; // A late response never causes another dispatch.
          if (Object.hasOwn(message, "error")) pending.finish(appServerResponseError(message.error));
          else pending.finish(null, message.result);
        },
        onError: () => this.#fail("session-protocol-failed"),
      });
      child.once("error", () => this.#fail("session-process-failed"));
      child.once("exit", () => {
        clearTimeout(this.#stopTimer);
        if (this.#child === child) this.#child = null;
        this.#fail("session-process-exited");
      });
      child.stdin.on("error", () => this.#fail("session-write-failed"));
      child.stdout.on("error", () => this.#fail("session-read-failed"));
      child.stdout.on("end", () => this.#fail("session-stream-ended"));
      child.stderr.on("error", () => this.#fail("session-stderr-failed"));
      child.stderr.resume(); // Never retain or expose credentials/prompts in stderr.
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.#consume(chunk));
      const identity = await this.#request("initialize", {
        clientInfo: { name: "nelos_executor", title: "Nelos executor", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      const version = typeof identity?.userAgent === "string"
        ? identity.userAgent.match(/\b(?:codex-cli|Codex Desktop)\/(\d+\.\d+\.\d+)(?![\w.+-])/u)?.[1] : null;
      if (version !== EXECUTION_DISCOVERY_SCHEMA_VERSION || identity.codexHome !== codexHome ||
          typeof identity.platformFamily !== "string" || !identity.platformFamily ||
          typeof identity.platformOs !== "string" || !identity.platformOs) throw error("session-identity-mismatch");
      if (this.#state !== "opening") throw error("session-unavailable");
      this.#write({ method: "initialized", params: {} });
      this.#version = version;
      this.#state = "ready";
      return this.status();
    } catch (cause) {
      this.#fail(cause instanceof ExecutorContractError ? cause.code : "session-initialize-failed");
      throw error(this.#failure ?? "session-unavailable");
    }
  }

  #consume(chunk) {
    if (!["opening", "ready"].includes(this.#state)) return;
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_BYTES) return this.#fail("session-message-too-large");
      if (!line.trim()) continue;
      try { this.#dispatcher.receive(JSON.parse(line)); }
      catch { return this.#fail("session-protocol-failed"); }
      if (!["opening", "ready"].includes(this.#state)) return;
    }
    if (Buffer.byteLength(this.#buffer) > MAX_BYTES) this.#fail("session-message-too-large");
  }

  #write(message) {
    if (!["opening", "ready"].includes(this.#state) || !this.#child) throw error("session-unavailable");
    const wire = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(wire) > MAX_BYTES ||
        this.#child.stdin.writableLength + Buffer.byteLength(wire) > MAX_BYTES) throw error("session-output-limit");
    this.#child.stdin.write(wire);
  }

  request(method, params, options = {}) {
    if (this.#state !== "ready") return Promise.reject(error("session-unavailable"));
    return this.#request(method, params, options);
  }

  #request(method, params, { signal, timeoutMs = this.#options.timeoutMs } = {}) {
    executorText(method, 256); executorInteger(timeoutMs);
    if (timeoutMs > 30_000) return Promise.reject(error("invalid-request-timeout"));
    if (signal?.aborted) return Promise.reject(error("session-request-aborted"));
    if (this.#pending.size >= 256) return Promise.reject(error("session-request-capacity"));
    const id = `${this.#connectionId}:${++this.#sequence}`;
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => finish(error("session-request-aborted"));
      const finish = (cause, result) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (cause) reject(cause); else resolve(result);
      };
      this.#pending.set(id, { finish });
      timer = setTimeout(() => finish(error("session-request-timeout")), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      try { this.#write({ id, method, params }); }
      catch { this.#fail("session-write-failed"); }
    });
  }

  #fail(reason) {
    if (["failed", "closed"].includes(this.#state)) return;
    this.#failure = reason;
    this.#state = "failed";
    this.#stop();
  }

  #stop() {
    this.#dispatcher?.close();
    this.#lifetime.abort();
    this.#buffer = "";
    for (const pending of this.#pending.values()) pending.finish(error("session-unavailable"));
    const child = this.#child;
    if (!child) return;
    child.stdin.destroy();
    // Keep the actual ChildProcess handle, never signal a PID from a state file.
    child.kill("SIGTERM");
    if (this.#child !== child) return;
    this.#stopTimer = setTimeout(() => {
      if (this.#child === child) child.kill("SIGKILL");
    }, this.#options.stopGraceMs);
    this.#stopTimer.unref();
  }

  close() {
    if (["closed", "failed"].includes(this.#state)) return;
    this.#state = "closed";
    this.#stop();
  }
}
