import { lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutorJobServiceV1, normalizeExecutorJobV1 } from "./executor-job-service.mjs";
import { ExecutionStoreV1, workUnitDefinitionV1 } from "./execution-store.mjs";
import { ExecutorLaunchJournalV1 } from "./executor-launch-journal.mjs";
import { ExecutorContractError, executorDigest, executorExact } from "./executor-contract.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { readPrivateExecutorJsonV1 } from "./executor-service-channel.mjs";
import { withExecutorJournalLock } from "./task-state.mjs";
import { ExecutorCompletionOutboxV1 } from "./executor-completion-outbox.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };
const equal = (a, b) => executorDigest(a) === executorDigest(b);

export function normalizeExecutorRetryPolicyV1(value) {
  const automatic = Object.hasOwn(value ?? {}, "automaticRetry");
  executorExact(value, ["schemaVersion", "attempts", ...(automatic ? ["automaticRetry"] : [])]);
  if (automatic) {
    executorExact(value.automaticRetry, ["intervalMs"]);
    if (!Number.isSafeInteger(value.automaticRetry.intervalMs) || value.automaticRetry.intervalMs < 1000 ||
        value.automaticRetry.intervalMs > 60_000) fail("invalid-retry-interval");
  }
  if (value.schemaVersion !== 2 || !Array.isArray(value.attempts) || value.attempts.length < 2 || value.attempts.length > 3) fail("invalid-retry-policy");
  const attempts = value.attempts.map(normalizeExecutorJobV1), first = attempts[0];
  const definition = (job) => {
    const copy = structuredClone(job);
    copy.job.workUnits[0].attempt = 1;
    copy.job.wave.members[0].attempt = 1;
    // Prompts must explicitly name each result-envelope attempt. Their exact
    // bytes remain approved by each immutable job's prompt digest.
    delete copy.job.prompts; delete copy.job.wave.waveDigest;
    delete copy.job.wave.members[0].promptDigest;
    return copy;
  };
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.job.workUnits[0].attempt !== index + 1 || attempt.job.wave.members[0].launchSequence !== 1 ||
        attempt.job.workUnits[0].policy.maxAttempts !== attempts.length || !equal(definition(first), definition(attempt))) fail("retry-policy-scope-mismatch");
  }
  return { schemaVersion: 2, attempts, ...(automatic ? { automaticRetry: { intervalMs: value.automaticRetry.intervalMs } } : {}) };
}

// A retry family owns one active job service at a time. Previous attempts keep
// immutable private stores; neither their binding nor their completion is erased.
export class ExecutorRetryServiceV1 {
  #policy; #options; #directory; #now; #job = null; #index = 0; #history = [];
  #clients = new Map(); #queue = Promise.resolve(); #starting; #owner;
  #done; #finish; #switching = false; #draining = false; #failure = null;
  #timer = null; #ended = false; #automaticClient; #automaticError = null; #backoff = 0; #nextCheckAt = null;
  constructor({ config, directory, now = Date.now, ...options }) {
    if (typeof now !== "function") fail("invalid-provider");
    this.#now = now;
    this.#policy = normalizeExecutorRetryPolicyV1(config);
    this.#options = options; this.#directory = directory;
    this.#done = new Promise((resolve) => { this.#finish = () => {
      this.#ended = true; this.#cancelTimer(); resolve();
    }; });
  }
  #attemptDirectory(index) { return join(this.#directory, `attempt-${index + 1}`); }
  #markerPath(index) { return join(this.#directory, `retry-${index + 1}.json`); }
  #journal(index) { return new ExecutorLaunchJournalV1({ directory: join(this.#attemptDirectory(index), "journal") }); }
  async #prior(index) {
    const job = this.#policy.attempts[index];
    const record = await this.#journal(index).read(job.job.workUnits[0].workUnitId);
    const op = record?.operations.at(-1);
    if (!op || op.phase !== "terminal" || op.completion?.status !== "interrupted" ||
        op.completion.result.workOutcome === "succeeded" || !equal(op.member, job.job.wave.members[0]) ||
        op.scopeDigest !== executorDigest(job.job.wave)) fail("confirmed-interruption-required");
    const unit = await new ExecutionStoreV1({ directory: join(this.#attemptDirectory(index), "units") }).read(op.member.workUnitId);
    if (!unit || !equal(workUnitDefinitionV1(unit), job.job.workUnits[0]) || unit.binding.state !== "bound" ||
        unit.binding.launchActionId !== op.operationId || unit.binding.memberThreadId !== op.threadId) fail("retry-binding-mismatch");
    return { fromAttempt: index + 1, operationId: op.operationId, threadId: op.threadId,
      turnId: op.turnId, evidenceDigest: executorDigest(op.completion),
      nextPolicyDigest: executorDigest(this.#policy.attempts[index + 1]) };
  }
  async #readMarker(index) {
    return readPrivateExecutorJsonV1(this.#markerPath(index)).catch((error) => {
      if (error.code === "ENOENT") return null; throw error;
    });
  }
  async #writeMarker(index, marker) {
    const existing = await this.#readMarker(index);
    if (existing && !equal(existing, marker)) fail("retry-evidence-mismatch");
    const temporary = join(this.#directory, `.retry-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(marker)); await file.sync(); }
    finally { await file.close(); }
    try {
      await rename(temporary, this.#markerPath(index));
      const directory = await open(this.#directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  start() {
    if (this.#starting) return this.#starting;
    let ready, rejected;
    this.#starting = new Promise((resolve, reject) => { ready = resolve; rejected = reject; });
    this.#owner = (async () => {
      try {
        await ensureCanonicalDirectory(this.#directory, "retry service state");
        const info = await lstat(this.#directory);
        if ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) fail("insecure-service-directory");
        const locks = join(this.#directory, "retry-owner-locks");
        await ensureCanonicalDirectory(locks, "retry owner locks");
        await withExecutorJournalLock(locks, "retry-family", async () => {
          const path = join(this.#directory, "retry-policy.json"), binding = { schemaVersion: 1, policyDigest: executorDigest(this.#policy) };
          try { await writeFile(path, JSON.stringify(binding), { mode: 0o600, flag: "wx" }); }
          catch (error) { if (error.code !== "EEXIST") throw error; }
          if (!equal(await readPrivateExecutorJsonV1(path), binding)) fail("service-job-policy-mismatch");
          let gap = false;
          for (let index = 1; index < this.#policy.attempts.length; index++) {
            const marker = await this.#readMarker(index);
            if (!marker) {
              gap = true;
              if ((await this.#journal(index).listWorkUnitIds()).length) fail("retry-authorization-missing");
              continue;
            }
            if (gap || !equal(marker, await this.#prior(index - 1))) fail("retry-evidence-mismatch");
            this.#index = index; this.#history.push(marker);
          }
          await this.#openJob();
          if (this.#policy.automaticRetry) { this.#automaticClient = this.attach(); this.#schedule(); }
          ready(this.status()); await this.#done;
        });
      } catch (error) { this.#failure = error.code ?? "retry-service-unavailable"; rejected(error); this.#finish(); }
      return this.status();
    })();
    return this.#starting;
  }
  async #openJob() {
    const job = new ExecutorJobServiceV1({ ...this.#options, config: this.#policy.attempts[this.#index], directory: this.#attemptDirectory(this.#index) });
    this.#job = job;
    await job.start();
    void job.stopped.then(() => { if (this.#job === job && !this.#switching) this.#finish(); });
  }
  attach() {
    if (!this.#job || this.#draining) fail("supervisor-not-accepting");
    const token = Object.freeze({}); this.#clients.set(token, null); return token;
  }
  detach(client) {
    const attachment = this.#clients.get(client);
    if (attachment) this.#job.detach(attachment);
    this.#clients.delete(client);
  }
  #client(client) {
    if (!this.#clients.has(client)) fail("unknown-service-client");
    let attachment = this.#clients.get(client);
    if (!attachment) { attachment = this.#job.attach(); this.#clients.set(client, attachment); }
    return attachment;
  }
  status() { return { ...(this.#job?.status() ?? { state: "new" }),
    ...(this.#draining ? { state: "draining", acceptingLaunches: false } : {}),
    ...(this.#failure ? { state: "failed", reason: this.#failure, acceptingLaunches: false } : {}),
    attempt: this.#index + 1, maxAttempts: this.#policy.attempts.length,
    previousAttempts: structuredClone(this.#history), retryConfigured: true, retryOn: ["interrupted"],
    automaticRetry: { enabled: Boolean(this.#policy.automaticRetry), nextCheckAt: this.#nextCheckAt, lastError: this.#automaticError } }; }
  #cancelTimer() { clearTimeout(this.#timer); this.#timer = null; this.#nextCheckAt = null; }
  #schedule() {
    if (!this.#policy.automaticRetry || this.#draining || this.#ended) return;
    const interval = Math.min(60_000, this.#policy.automaticRetry.intervalMs * 2 ** this.#backoff);
    this.#nextCheckAt = this.#now() + interval;
    this.#timer = setTimeout(() => {
      this.#timer = null; this.#nextCheckAt = null;
      // Share the parent-request queue so a timer and an explicit retry cannot
      // select different attempts or race a join decision.
      const next = this.#queue.catch(() => {}).then(async () => {
        if (this.#draining || this.#ended) return false;
        return this.#automaticStep();
      }).then((again) => {
        this.#automaticError = null; this.#backoff = 0;
        if (again) this.#schedule();
      }).catch((error) => {
        this.#automaticError = error.code ?? "automatic-retry-unavailable";
        this.#backoff = Math.min(6, this.#backoff + 1);
        if (this.#automaticError !== "retry-authorization-expired") this.#schedule();
      });
      this.#queue = next;
    }, interval);
  }
  async #automaticStep() {
    const config = this.#policy.attempts[this.#index];
    const read = async () => (await this.#journal(this.#index).read(config.job.workUnits[0].workUnitId))?.operations.at(-1);
    let operation = await read();
    if (this.#draining || this.#ended) return false;
    if (!operation) {
      // Startup alone never authorizes the first launch. A persisted transition
      // is sufficient to resume a selected but not yet dispatched retry.
      if (this.#index === 0) return true;
      if (this.#now() >= config.expiresAt) fail("retry-authorization-expired");
      const result = await this.#job.request(this.#client(this.#automaticClient), "launch", {});
      if (!["wave-started", "existing-operation"].includes(result.kind)) fail("automatic-retry-admission-unavailable");
      return true;
    }
    await this.#job.request(this.#client(this.#automaticClient), "collect", {});
    operation = await read();
    if (operation?.phase !== "terminal") return true;
    if (operation.completion?.status !== "interrupted" || operation.completion.result.workOutcome === "succeeded" ||
        this.#index + 1 >= this.#policy.attempts.length) return false;
    const result = await this.#retry(this.#automaticClient, { expectedAttempt: this.#index + 1 });
    if (!["wave-started", "existing-operation"].includes(result.kind)) fail("automatic-retry-admission-unavailable");
    return true;
  }
  get stopped() { return this.#owner ?? Promise.reject(new ExecutorContractError("supervisor-not-started")); }
  request(client, method, params) {
    const next = this.#queue.catch(() => {}).then(async () => {
      this.#client(client);
      if (method === "status") { executorExact(params, []); return this.status(); }
      if (method === "notifications") {
        executorExact(params, []);
        const notifications = [];
        for (let index = 0; index <= this.#index; index++) {
          notifications.push(...await new ExecutorCompletionOutboxV1({ config: this.#policy.attempts[index], directory: this.#attemptDirectory(index) }).list());
        }
        return { notifications, detachedWakeAvailable: false };
      }
      if (method === "acknowledge") {
        executorExact(params, ["notificationId", "expectedAttempt"]);
        if (!Number.isSafeInteger(params.expectedAttempt) || params.expectedAttempt < 1 || params.expectedAttempt > this.#index + 1) fail("invalid-notification-attempt");
        return new ExecutorCompletionOutboxV1({ config: this.#policy.attempts[params.expectedAttempt - 1], directory: this.#attemptDirectory(params.expectedAttempt - 1) }).acknowledge(params);
      }
      if (this.#draining && ["launch", "retry"].includes(method)) fail("supervisor-not-accepting");
      if (method === "retry") return this.#retry(client, params);
      if (method === "join") {
        executorExact(params, ["expectedAttempt", "decision", "decisionSummary"]);
        if (params.expectedAttempt !== this.#index + 1) fail("stale-attempt-decision");
        const { expectedAttempt, ...decision } = params;
        return this.#job.request(this.#client(client), method, decision);
      }
      return this.#job.request(this.#client(client), method, params);
    });
    this.#queue = next; return next;
  }
  async #retry(client, params) {
    executorExact(params, ["expectedAttempt"]);
    const expected = params.expectedAttempt;
    if (!Number.isSafeInteger(expected) || expected < 1) fail("invalid-retry-attempt");
    // A replay can only finish/report the same already-selected next attempt.
    if (this.#index === expected) return this.#job.request(this.#client(client), "launch", {});
    if (this.#index + 1 !== expected) fail("stale-retry-attempt");
    if (expected >= this.#policy.attempts.length) fail("retry-attempt-limit");
    if (this.#now() >= this.#policy.attempts[this.#index + 1].expiresAt) fail("retry-authorization-expired");
    await this.#job.request(this.#client(client), "collect", {});
    const marker = await this.#prior(this.#index);
    // A completed result can still retain a hold when durable handoff failed.
    // Do not enter an unbounded drain or select a retry before that is repaired.
    if (this.#job.status().activities !== 0) fail("retry-predecessor-not-settled");
    await this.#writeMarker(this.#index + 1, marker);
    // No turn is sent before the transition is durable. A process crash here
    // selects the same next job on restart; it cannot repeat the prior attempt.
    this.#switching = true;
    try {
      for (const attachment of this.#clients.values()) if (attachment) this.#job.detach(attachment);
      for (const token of this.#clients.keys()) this.#clients.set(token, null);
      this.#job.drain(); await this.#job.stopped;
      this.#index += 1; this.#history.push(marker);
      await this.#openJob();
    } catch (error) { this.#failure = error.code ?? "retry-service-unavailable"; this.#finish(); throw error; }
    finally {
      this.#switching = false;
      if (["failed", "stopped"].includes(this.#job?.status().state)) this.#finish();
    }
    if (this.#draining) fail("supervisor-not-accepting");
    return this.#job.request(this.#client(client), "launch", {});
  }
  drain() {
    this.#draining = true;
    this.#cancelTimer();
    if (!this.#job) { this.#finish(); return this.status(); }
    this.#queue = this.#queue.catch(() => {}).then(() => this.#job.drain()).catch(() => { this.#finish(); });
    return this.status();
  }
}
