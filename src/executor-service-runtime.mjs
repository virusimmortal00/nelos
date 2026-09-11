import { join } from "node:path";
import { ExecutorAppServerSessionV1 } from "./executor-app-server-session.mjs";
import { ExecutorAppServerEffectsV1 } from "./executor-app-server-effects.mjs";
import { ExecutorApprovalRelayV1 } from "./executor-approval-relay.mjs";
import { ExecutorServiceSupervisorV1 } from "./executor-service-supervisor.mjs";
import { ExecutorGrantAuthorityV1 } from "./executor-grants.mjs";
import { ExecutorLaunchJournalV1 } from "./executor-launch-journal.mjs";
import { ExecutorLaunchCoordinatorV1 } from "./executor-launch-coordinator.mjs";
import { ExecutionStoreV1 } from "./execution-store.mjs";
import { ExecutorContractError, normalizeExecutorWaveV1 } from "./executor-contract.mjs";
import { withExecutorJournalLock } from "./task-state.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };

/** Compose the owned execution lifecycle in one work-host process. Construction
 * options and UI channels are service-installed dependencies, never frontend
 * JSON. This is not an IPC server or a production capability/policy provider.
 */
export class ExecutorServiceRuntimeV1 {
  #session;
  #supervisor;
  #effects;
  #relay;
  #authority;
  #journal;
  #coordinator;
  #work = new Map();
  #collections = new Map();
  #attention = new Map();
  #scope;
  #starting = null;
  #recoveryState = "not-started";
  #recoveryReason = null;
  #startupPending = new Set();
  #recoveryReadsEnabled;
  #onTerminal;

  constructor({ directory, scope, runtimeGeneration, sessionOptions, validateTarget,
    evaluate = null, authorize = null, grantOptions = {}, validateRecovery = null, onTerminal = null }) {
    if (evaluate !== null && typeof evaluate !== "function") fail("invalid-provider");
    if (onTerminal !== null && typeof onTerminal !== "function") fail("invalid-provider");
    this.#onTerminal = onTerminal;
    this.#session = new ExecutorAppServerSessionV1({ ...sessionOptions, dispatcherOptions: {
      ...sessionOptions?.dispatcherOptions,
      onNotification: (event) => this.#observe(event),
      onServerRequest: (request) => this.#interact(request),
    } });
    this.#supervisor = new ExecutorServiceSupervisorV1({ session: this.#session, directory, scope, runtimeGeneration });
    this.#scope = structuredClone(scope);
    this.#effects = new ExecutorAppServerEffectsV1({ session: this.#session, validateTarget, validateRecovery });
    this.#recoveryReadsEnabled = validateRecovery !== null;
    this.#relay = new ExecutorApprovalRelayV1({ ownsTurn: (input, options) => this.#effects.ownsTurn(input, options) });
    this.#authority = new ExecutorGrantAuthorityV1({ ...grantOptions, authorize, evaluate: evaluate && (async (wave, options) => {
      const owner = this.#supervisor.status();
      if (!["ready", "draining"].includes(owner.state)) fail("executor-owner-unavailable");
      if (wave.members.some((member) => member.target.hostId !== scope.hostId ||
          member.target.codexHomeId !== scope.codexHomeId)) fail("execution-host-mismatch");
      const evaluated = await evaluate(wave, { ...options, owner,
        observedVersion: this.#session.status().observedVersion,
        request: (...args) => this.#session.request(...args) });
      if (evaluated?.context?.ownerEpoch !== owner.ownerEpoch ||
          evaluated?.context?.runtimeGeneration !== owner.runtimeGeneration ||
          this.#session.signal.aborted) fail("stale-execution-context");
      if (evaluated.interaction === "interactive" && !this.#relay.status().connected) fail("approval-channel-unavailable");
      return evaluated;
    }) });
    this.#journal = new ExecutorLaunchJournalV1({ directory: join(directory, "journal") });
    this.#coordinator = new ExecutorLaunchCoordinatorV1({ authority: this.#authority, journal: this.#journal,
      store: new ExecutionStoreV1({ directory: join(directory, "units") }), effects: this.#effects,
      withLock: (id, callback) => withExecutorJournalLock(join(directory, "operation-locks"), id, callback) });
    this.#session.signal.addEventListener("abort", () => {
      this.#authority.close(); this.#relay.close();
    }, { once: true });
  }

  start() {
    if (this.#starting) {
      if (this.#recoveryState === "scanning") return this.#starting;
      if (this.#supervisor.status().state !== "ready") return Promise.reject(new ExecutorContractError("supervisor-unavailable"));
      return Promise.resolve(this.status());
    }
    this.#recoveryState = "scanning";
    this.#starting = this.#startAndReconcile();
    return this.#starting;
  }

  async #startAndReconcile() {
    try {
      // The supervisor holds the owner election throughout inventory and all
      // reconciliation. Public attachments/admission remain closed meanwhile.
      await this.#supervisor.start();
      const ids = await this.#journal.listWorkUnitIds();
      for (const id of ids) {
        const record = await this.#journal.read(id);
        if (!record || record.operations.some(({ member }) =>
          member.target.hostId !== this.#scope.hostId || member.target.codexHomeId !== this.#scope.codexHomeId)) {
          fail("startup-journal-scope-mismatch");
        }
        const hold = this.#supervisor.hold({ kind: "work", operationId: `unit:${id}` });
        this.#work.set(id, { hold, users: 0, generation: 0 });
        this.#startupPending.add(id);
      }
      for (const id of ids) {
        try {
          await this.#coordinator.recover(id);
          const record = await this.#journal.read(id);
          // Cached terminal evidence is revalidated against its durable unit
          // binding. No old thread is adopted into the new connection.
          const operation = record?.operations.at(-1);
          if (operation?.completion || (this.#recoveryReadsEnabled && ["running", "terminal"].includes(operation?.phase))) {
            await this.#coordinator.collectResult(id, { recover: this.#recoveryReadsEnabled });
          }
          await this.#settle(id);
          if (this.#startupPending.has(id)) this.#attention.set(id, "startup-upstream-reconciliation-required");
        } catch (error) {
          this.#attention.set(id, error instanceof ExecutorContractError ? error.code : "startup-reconciliation-unavailable");
        }
      }
      if (this.#session.signal.aborted) fail("startup-session-lost");
      this.#recoveryState = this.#startupPending.size ? "attention" : "complete";
      return this.status();
    } catch (error) {
      this.#recoveryState = "failed";
      this.#recoveryReason = error instanceof ExecutorContractError ? error.code : "startup-inventory-unavailable";
      this.#session.close();
      await this.#session.stopped;
      throw new ExecutorContractError(this.#recoveryReason);
    }
  }

  attach() {
    if (!["attention", "complete"].includes(this.#recoveryState)) fail("startup-reconciliation-required");
    return this.#supervisor.attach();
  }
  detach(client) { this.#supervisor.detach(client); }
  assertClient(client) { this.#client(client); }
  get stopped() { return this.#supervisor.stopped; }
  status() {
    return { ...this.#supervisor.status(), approval: this.#relay.status(),
      acceptingLaunches: this.#supervisor.status().state === "ready" && this.#recoveryState === "complete",
      recovery: { state: this.#recoveryState, pending: this.#startupPending.size, reason: this.#recoveryReason },
      pendingCollections: this.#collections.size,
      attention: [...this.#attention].map(([workUnitId, reason]) => ({ workUnitId, reason })) };
  }

  #client(client, { launch = false } = {}) {
    if (!this.#supervisor.isAttached(client)) fail("unknown-service-client");
    if (launch && this.#supervisor.status().state !== "ready") fail("supervisor-not-accepting");
    if (launch && this.#recoveryState !== "complete") fail("startup-reconciliation-required");
  }

  // The eventual authenticated UI adapter owns this channel. An attachment
  // token or a launch argument cannot install a user-answer callback.
  attachApprovalChannel(channel) { return this.#relay.attachChannel(channel); }

  requestGrant(client, input) {
    this.#client(client, { launch: true });
    return this.#authority.issue(input);
  }

  async launchWave(client, input) {
    this.#client(client, { launch: true });
    const wave = normalizeExecutorWaveV1(input.wave);
    const reserved = [];
    try {
      // Reserve before the first await so drain cannot close the child between
      // admission and durable launch intent. Concurrent calls share holds.
      for (const member of wave.members) {
        let entry = this.#work.get(member.workUnitId);
        if (!entry) {
          const hold = this.#supervisor.hold({ kind: "work", operationId: `unit:${member.workUnitId}` });
          entry = { hold, users: 0, generation: 0 };
          this.#work.set(member.workUnitId, entry);
        }
        entry.users += 1;
        entry.generation += 1;
        reserved.push(member.workUnitId);
      }
      return await this.#coordinator.launchWave(input);
    } finally {
      for (const id of reserved) this.#work.get(id).users -= 1;
      await Promise.all(reserved.map((id) => this.#settle(id)));
    }
  }

  async #settle(workUnitId) {
    const entry = this.#work.get(workUnitId);
    if (!entry || entry.users) return;
    const generation = entry.generation;
    try {
      const op = (await this.#journal.read(workUnitId))?.operations.at(-1);
      if (!op && this.#startupPending.has(workUnitId)) fail("startup-journal-entry-missing");
      // A lost response, an unreadable record, or terminal status without saved
      // evidence cannot release the owner's work hold.
      if (op && op.phase !== "not-executed" && !op.completion) return;
      // Finish the service-installed durable handoff before releasing the work
      // hold. Projection failure remains recoverable from the terminal journal.
      if (op?.completion) await this.#onTerminal?.(workUnitId);
      if (this.#work.get(workUnitId) !== entry || entry.users || entry.generation !== generation) return;
      this.#work.delete(workUnitId);
      this.#supervisor.release(entry.hold);
      this.#attention.delete(workUnitId);
      this.#startupPending.delete(workUnitId);
      if (this.#recoveryState === "attention" && !this.#startupPending.size) this.#recoveryState = "complete";
    } catch (error) {
      const missing = error instanceof ExecutorContractError && error.code === "startup-journal-entry-missing";
      this.#attention.set(workUnitId, missing ? error.code : "durable-state-unavailable");
      if (missing) throw error;
    }
  }

  async #collect(workUnitId) {
    if (this.#collections.has(workUnitId)) return this.#collections.get(workUnitId);
    if (this.#collections.size >= 16) fail("result-collection-capacity");
    const collection = this.#coordinator.collectResult(workUnitId, {
      recover: this.#recoveryReadsEnabled && this.#startupPending.has(workUnitId),
    }).then(async (result) => {
      this.#attention.delete(workUnitId);
      await this.#settle(workUnitId);
      return result;
    }).catch((error) => {
      if (this.#work.has(workUnitId)) this.#attention.set(workUnitId,
        error instanceof ExecutorContractError ? error.code : "result-collection-unavailable");
      throw error;
    }).finally(() => this.#collections.delete(workUnitId));
    this.#collections.set(workUnitId, collection);
    return collection;
  }

  collectResult(client, workUnitId) {
    this.#client(client);
    return this.#collect(workUnitId);
  }

  async #observe(event) {
    const hint = await this.#effects.observeNotification(event, { signal: event.signal });
    if (hint?.readResultRequired) {
      // Keep draining notifications while durable collection waits on a launch
      // lock or a read response. Errors retain the hold and become attention.
      void this.#collect(hint.workUnitId).catch((error) => {
        if (this.#work.has(hint.workUnitId)) this.#attention.set(hint.workUnitId,
          error instanceof ExecutorContractError ? error.code : "result-collection-unavailable");
      });
    }
  }

  async #interact(request) {
    const owned = await this.#effects.describeOwnedTurn(request.params ?? {}, { signal: request.signal });
    if (!owned || !this.#work.has(owned.workUnitId)) return this.#relay.handle(request);
    const hold = this.#supervisor.hold({ kind: "approval", operationId: `unit:${owned.workUnitId}` });
    try { return await this.#relay.handle(request); }
    finally { this.#supervisor.release(hold); }
  }

  async recover(client, workUnitId) {
    this.#client(client);
    const result = await this.#coordinator.recover(workUnitId);
    if (this.#recoveryReadsEnabled && ["running", "terminal"].includes(result.phase)) return this.#collect(workUnitId);
    await this.#settle(workUnitId);
    return result;
  }

  drain() {
    if (this.#recoveryState === "scanning") fail("startup-reconciliation-required");
    return this.#supervisor.drain();
  }
}
