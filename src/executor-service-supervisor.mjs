import { lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { ExecutorAppServerSessionV1 } from "./executor-app-server-session.mjs";
import { ExecutorContractError, executorDigest, executorExact, executorHash, executorText } from "./executor-contract.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { withExecutorJournalLock } from "./task-state.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };

/** Local owner lifecycle. Holds the process-start-aware election lock until
 * the owned child actually exits. IPC/authentication are separate adapters;
 * opaque attachments here must never be reconstructed from frontend JSON.
 */
export class ExecutorServiceSupervisorV1 {
  #session;
  #directory;
  #scopeDigest;
  #runtimeGeneration;
  #epoch = randomUUID();
  #state = "new";
  #reason = null;
  #starting = null;
  #ownerTask = null;
  #clients = new Set();
  #activities = new Map();

  constructor({ session, directory, scope, runtimeGeneration }) {
    if (!(session instanceof ExecutorAppServerSessionV1) || session.status().state !== "new") fail("unowned-session-required");
    executorText(directory, 4096);
    if (!isAbsolute(directory)) fail("absolute-service-directory-required");
    executorExact(scope, ["hostId", "codexHomeId", "authDomainId"]);
    executorText(scope.hostId, 256); executorHash(scope.codexHomeId); executorHash(scope.authDomainId);
    executorHash(runtimeGeneration);
    this.#session = session; this.#directory = directory;
    this.#scopeDigest = executorDigest({ hostId: scope.hostId, codexHomeId: scope.codexHomeId, authDomainId: scope.authDomainId });
    this.#runtimeGeneration = runtimeGeneration;
    session.signal.addEventListener("abort", () => {
      this.#clients.clear();
      if (!["draining", "stopped", "failed"].includes(this.#state)) {
        this.#state = "failed";
        this.#reason = "owned-session-lost";
      }
    }, { once: true });
  }

  status() {
    return { state: this.#state, reason: this.#reason, ownerEpoch: this.#epoch,
      scopeDigest: this.#scopeDigest, runtimeGeneration: this.#runtimeGeneration,
      connectionId: this.#session.status().connectionId,
      clients: this.#clients.size, activities: this.#activities.size };
  }

  start() {
    if (this.#state === "starting") return this.#starting;
    if (this.#state === "ready") return Promise.resolve(this.status());
    if (this.#state !== "new") return Promise.reject(new ExecutorContractError("supervisor-unavailable"));
    this.#state = "starting";
    let ready; let failed;
    this.#starting = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    this.#ownerTask = (async () => {
      try {
        await ensureCanonicalDirectory(this.#directory, "executor service state");
        const info = await lstat(this.#directory);
        if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) fail("insecure-service-directory");
        await ensureCanonicalDirectory(join(this.#directory, "owner-locks"), "executor owner locks");
        await withExecutorJournalLock(join(this.#directory, "owner-locks"), this.#scopeDigest, async () => {
          if (this.#state !== "starting") fail("supervisor-unavailable");
          try {
            await this.#session.open();
            if (this.#state !== "starting") fail("supervisor-unavailable");
            this.#state = "ready";
            ready(this.status());
            // Detaching every frontend changes no ownership or child lifetime.
            await this.#session.stopped;
            if (this.#state !== "draining") {
              this.#reason = "owned-session-lost";
              this.#state = "failed";
            }
          } finally {
            this.#session.close();
            // SIGTERM and SIGKILL requests alone are not an exit acknowledgment.
            await this.#session.stopped;
          }
        });
        if (this.#state === "draining") this.#state = "stopped";
      } catch (cause) {
        this.#reason = cause instanceof ExecutorContractError ? cause.code : "service-owner-unavailable";
        this.#state = "failed";
        this.#session.close();
        failed(new ExecutorContractError(this.#reason));
      } finally {
        this.#clients.clear();
      }
      return this.status();
    })();
    return this.#starting;
  }

  attach() {
    if (!["ready", "draining"].includes(this.#state) || this.#session.signal.aborted) fail("supervisor-not-accepting");
    if (this.#clients.size >= 64) fail("service-client-capacity");
    const token = Object.freeze({});
    this.#clients.add(token);
    return token;
  }

  isAttached(token) {
    return ["ready", "draining"].includes(this.#state) && !this.#session.signal.aborted && this.#clients.has(token);
  }

  detach(token) { this.#clients.delete(token); }

  /** Service-owned holds span a whole worker, uncertain launch, or approval,
   * not just the frontend RPC that started it. Release only after durable
   * completion/reconciliation, never merely on client disconnection.
   */
  hold({ kind, operationId }) {
    const drainingApproval = this.#state === "draining" && kind === "approval" &&
      [...this.#activities.values()].some((entry) => entry.kind === "work" && entry.operationId === operationId);
    if ((this.#state !== "ready" && !drainingApproval) || this.#session.signal.aborted) fail("supervisor-not-accepting");
    if (!["work", "approval"].includes(kind)) fail("invalid-service-activity");
    executorText(operationId, 256);
    if (this.#activities.size >= 256) fail("service-activity-capacity");
    const token = Object.freeze({});
    this.#activities.set(token, { kind, operationId });
    return token;
  }

  release(token) {
    if (!this.#activities.delete(token)) fail("unknown-service-activity");
    this.#maybeStop();
  }

  #maybeStop() {
    if (this.#state === "draining" && this.#activities.size === 0) this.#session.close();
  }

  drain() {
    if (this.#state === "ready") { this.#state = "draining"; this.#maybeStop(); }
    else if (!["draining", "stopped", "failed"].includes(this.#state)) fail("supervisor-unavailable");
    return this.status();
  }

  get stopped() {
    if (!this.#ownerTask) return Promise.reject(new ExecutorContractError("supervisor-not-started"));
    return this.#ownerTask;
  }
}
