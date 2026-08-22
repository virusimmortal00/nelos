import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { AtomicRemoteDesktopJournal } from "../../../src/remote-desktop-runner/journal.mjs";
import { canonicalJsonV1, sha256V1, validateGoldenImageReservationV1 } from "./build-golden-image.mjs";
import {
  cleanupOwnedGoldenBuilderV1,
  proveGoldenBuilderOwnershipV1,
  runDisposableGoldenBuilderV1,
} from "./golden-builder-lifecycle.mjs";
import {
  restoreGoldenBuilderGatewayPolicyV1,
  runGatewayProtectedGoldenBuilderV1,
  validateGoldenBuilderGatewayPolicyBindingV1,
} from "./golden-builder-gateway-policy.mjs";
import {
  createGoldenBuilderControllerIdentityV1,
  createGoldenBuilderPacketV1,
  createVolumeMeasurementBindingV1,
  validateGoldenBuilderLifecycleBindingV1,
  validateGoldenBuilderTerminalReceiptV1,
} from "./prepare-golden-builder.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const EVENT = /^[a-z][a-z0-9-]{0,63}$/u;
const TERMINAL_STATES = new Set(["canceled", "succeeded"]);

export class GoldenBuilderProductionRunnerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "GoldenBuilderProductionRunnerError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) { throw new GoldenBuilderProductionRunnerError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_RUN_CONTRACT", `${label} fields differ from the closed contract`);
  return value;
}
function validateCleanupTerminal(value, identity) {
  exact(value, ["cleanupDigest", "completedAt", "kind", "packetDigest", "reservationDigest", "result", "schemaVersion"], "builder cleanup terminal");
  const { cleanupDigest, ...unsigned } = value;
  if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-builder-cleanup-terminal" || value.result !== "cleaned" ||
      value.packetDigest !== identity.packet.packetDigest || value.reservationDigest !== identity.packet.reservationDigest ||
      !Number.isFinite(Date.parse(value.completedAt)) || cleanupDigest !== sha256V1(unsigned)) {
    fail("CONTROLLER_RESULT_AMBIGUOUS", "guest cleanup terminal identity or digest differs");
  }
  return value;
}
function assertMetadataOnly(value, path = "details") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertMetadataOnly(item, `${path}[${index}]`));
  if (!plain(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|private.?key|token.?value|credential|password|authorized.?key)/iu.test(key)) fail("SECRET_JOURNAL_FORBIDDEN", `${path}.${key} cannot be journaled`);
    assertMetadataOnly(child, `${path}.${key}`);
  }
}

function validateRuntimeIdentity({ reservation: input, lifecycleBinding, gatewayPolicyBinding, toolchainLockDigest }, now, { allowExpiredForCleanup = false } = {}) {
  const reservation = validateGoldenImageReservationV1(input, { now, allowExpiredForCleanup });
  const lifecycle = validateGoldenBuilderLifecycleBindingV1(lifecycleBinding, reservation, { now, allowExpiredForCleanup });
  const gateway = validateGoldenBuilderGatewayPolicyBindingV1(gatewayPolicyBinding, reservation, { now, allowExpired: allowExpiredForCleanup });
  if (!SHA256.test(toolchainLockDigest ?? "")) fail("INVALID_RUN_CONTRACT", "toolchain lock digest is invalid");
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-golden-builder-production-run",
    reservationDigest: sha256V1(reservation),
    lifecycleBindingDigest: lifecycle.bindingDigest,
    gatewayPolicyBindingDigest: gateway.bindingDigest,
    toolchainLockDigest,
  };
  return Object.freeze({ reservation, lifecycle, gateway, toolchainLockDigest, runDigest: sha256V1(unsigned) });
}

export class GoldenBuilderProductionJournalV1 {
  constructor(directory, { clock = Date, checkpoint = null } = {}) {
    if (!isAbsolute(directory) || resolve(directory) !== directory || typeof clock?.now !== "function" || (checkpoint !== null && typeof checkpoint !== "function")) {
      fail("INVALID_RUN_CONTRACT", "production journal boundary is invalid");
    }
    this.atomic = new AtomicRemoteDesktopJournal(directory);
    this.clock = clock;
    this.checkpoint = checkpoint;
  }

  async initialize(identity) {
    return this.atomic.initialize({
      schemaVersion: 1,
      kind: "nelos-golden-builder-production-journal",
      runDigest: identity.runDigest,
      state: "prepared",
      lastEvent: "prepared",
      events: [],
      builderPreflight: null,
      builderTerminal: null,
      builderResult: null,
      gatewayActive: false,
      gatewayRestored: false,
      failure: null,
      createdAt: new Date(this.clock.now()).toISOString(),
      updatedAt: new Date(this.clock.now()).toISOString(),
    });
  }

  async load(identity) {
    const value = await this.atomic.load();
    if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-builder-production-journal" || value.runDigest !== identity.runDigest || !Array.isArray(value.events)) {
      fail("RUN_IDENTITY_MISMATCH", "journal does not belong to the exact production run identity");
    }
    return value;
  }

  async update(identity, event, details, mutate = null) {
    if (!EVENT.test(event) || !plain(details)) fail("INVALID_RUN_EVENT", "production checkpoint is invalid");
    assertMetadataOnly(details);
    const result = await this.atomic.update((current) => {
      if (current.runDigest !== identity.runDigest || TERMINAL_STATES.has(current.state)) fail("RUN_TERMINAL", "terminal production journal cannot be changed");
      const next = mutate ? mutate(current) : current;
      next.lastEvent = event;
      next.updatedAt = new Date(this.clock.now()).toISOString();
      next.events.push({ event, details: structuredClone(details), detailsDigest: sha256V1(details), recordedAt: next.updatedAt });
      if (next.events.length > 256) fail("JOURNAL_LIMIT", "production journal event bound exceeded");
      return next;
    });
    if (this.checkpoint) await this.checkpoint(event, Object.freeze(structuredClone(details)));
    return result.value;
  }

  async record(identity, event, details = {}) {
    return this.update(identity, event, details, (current) => {
      if (event === "gateway-policy-active") current.gatewayActive = true;
      if (event === "gateway-policy-restored") { current.gatewayActive = false; current.gatewayRestored = true; }
      return current;
    });
  }
}

export class GoldenBuilderArtifactStoreV1 {
  constructor(directory) {
    if (!isAbsolute(directory) || resolve(directory) !== directory) fail("INVALID_RUN_CONTRACT", "artifact directory must be absolute and canonical");
    this.directory = directory;
  }

  async commit(value) {
    assertMetadataOnly(value);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const bytes = Buffer.from(`${canonicalJsonV1(value)}\n`);
    const digest = sha256V1(value);
    const path = join(this.directory, `${digest.slice(7)}.json`);
    try {
      const handle = await open(path, "wx", 0o400);
      try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(0o400); } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== "EEXIST" || !(await readFile(path)).equals(bytes)) throw error;
    }
    return Object.freeze({ digest, path });
  }
}

function requireBoundary(value, methods, label) {
  if (!plain(value) || methods.some((method) => typeof value[method] !== "function")) fail("INVALID_RUN_BOUNDARY", `${label} boundary is incomplete`);
}

function operationIds(events) {
  const ids = {};
  for (const item of events) if (typeof item?.event === "string" && typeof item?.details?.providerOperationId === "string") ids[item.event] = item.details.providerOperationId;
  return ids;
}

export class GoldenBuilderProductionRunnerV1 {
  constructor({
    journalDirectory, reservation, lifecycleBinding, gatewayPolicyBinding, toolchainLockDigest,
    gatewayAdapter, builderAdapter, executeController, bundleStore, terminalStore,
    clock = Date, checkpoint = null, allowExpiredForCleanup = false,
  }) {
    const identity = validateRuntimeIdentity({ reservation, lifecycleBinding, gatewayPolicyBinding, toolchainLockDigest }, clock.now(), { allowExpiredForCleanup });
    requireBoundary(gatewayAdapter, ["preflight", "apply", "observe", "restore", "confirmRestored"], "gateway adapter");
    requireBoundary(builderAdapter, ["preflight", "provision", "observe", "stop", "destroy", "confirmAbsent"], "builder adapter");
    requireBoundary(bundleStore, ["commit"], "bundle store");
    requireBoundary(terminalStore, ["commit"], "terminal store");
    if (typeof executeController !== "function") fail("INVALID_RUN_BOUNDARY", "guest controller boundary is unavailable");
    this.identity = identity;
    this.gatewayAdapter = gatewayAdapter;
    this.builderAdapter = builderAdapter;
    this.executeController = executeController;
    this.bundleStore = bundleStore;
    this.terminalStore = terminalStore;
    this.clock = clock;
    this.journal = new GoldenBuilderProductionJournalV1(journalDirectory, { clock, checkpoint });
  }

  async inspect() { return this.journal.load(this.identity); }

  async start({ authorizeRun } = {}) {
    if (authorizeRun !== this.identity.runDigest) fail("MUTATION_AUTHORIZATION_REQUIRED", "first production run requires its exact run digest");
    return this.journal.atomic.withRunLock(async () => {
      await this.journal.initialize(this.identity);
      return this.#drive();
    });
  }

  async resume() {
    return this.journal.atomic.withRunLock(async () => {
      await this.journal.load(this.identity);
      return this.clock.now() >= Date.parse(this.identity.reservation.expiresAt) ? this.#cleanupOnly("expired-resume") : this.#drive();
    });
  }

  async cancel() {
    return this.journal.atomic.withRunLock(async () => {
      await this.journal.load(this.identity);
      return this.#cleanupOnly("cancel-requested");
    });
  }

  #cleanupControllerIdentity(observation) {
    const ownership = /^nelos-golden-builder-v1:([0-9a-f]{32})$/u.exec(this.identity.lifecycle.builderVm.ownership);
    if (!ownership || !proveGoldenBuilderOwnershipV1(observation, this.identity.lifecycle, { requireRunning: true })) {
      fail("BUILDER_OWNERSHIP_UNPROVEN", "cleanup-only controller reconciliation requires the exact running builder");
    }
    const cleanupValidation = { now: this.clock.now(), allowExpiredForCleanup: true };
    const packet = createGoldenBuilderPacketV1({
      reservation: this.identity.reservation,
      builder: {
        vmId: this.identity.lifecycle.builderVm.vmId, name: this.identity.lifecycle.builderVm.name, mac: this.identity.lifecycle.builderVm.mac,
        sshUser: this.identity.lifecycle.builderVm.sshUser, sshHostFingerprint: observation.guest.hostKeyFingerprint, ownershipNonce: ownership[1],
      },
      toolchainLockDigest: this.identity.toolchainLockDigest,
    }, cleanupValidation);
    const bundle = Object.freeze({
      schemaVersion: 1, reservation: this.identity.reservation, builderPacket: packet,
      volumeMeasurementBinding: createVolumeMeasurementBindingV1(this.identity.reservation, cleanupValidation),
    });
    const controllerIdentity = createGoldenBuilderControllerIdentityV1(packet, this.identity.reservation, cleanupValidation);
    return { packet, bundle, controllerIdentity };
  }

  async #cleanupOnly(reason) {
    let state = await this.journal.load(this.identity);
    if (TERMINAL_STATES.has(state.state)) return state;
    state = await this.journal.update(this.identity, reason, {}, (current) => { current.state = "canceling"; return current; });
    let observed = await this.builderAdapter.observe(this.identity.lifecycle);
    if (observed.status !== "absent" && !proveGoldenBuilderOwnershipV1(observed, this.identity.lifecycle)) {
      await this.#ensureGatewayRestored();
      fail("BUILDER_OWNERSHIP_UNPROVEN", "cleanup-only reconciliation observed a different builder identity");
    }
    const controllerMayOwnOutput = !state.builderTerminal && state.events.some(({ event }) => new Set([
      "builder-bundle-committed", "builder-controller-reconciliation-required", "builder-identity-proven",
    ]).has(event));
    if (observed.status !== "absent" && controllerMayOwnOutput) {
      try {
        const nested = this.#cleanupControllerIdentity(observed);
        const result = await this.executeController({ binding: this.identity.lifecycle, reservation: this.identity.reservation, observation: observed, ...nested, cleanupOnly: true });
        if (result?.kind === "nelos-golden-builder-terminal") {
          const terminal = validateGoldenBuilderTerminalReceiptV1(result, {
            packet: nested.packet, reservation: this.identity.reservation, now: this.clock.now(), allowExpiredForCleanup: true,
          });
          await this.terminalStore.commit(terminal);
          await this.journal.update(this.identity, "builder-terminal-stored", { terminalDigest: terminal.terminalDigest }, (current) => { current.builderTerminal = structuredClone(terminal); return current; });
        } else {
          const cleanup = validateCleanupTerminal(result, nested);
          await this.journal.record(this.identity, "builder-controller-cleaned", { cleanupDigest: cleanup.cleanupDigest });
        }
      } catch (error) {
        let quarantine = null;
        if (typeof this.builderAdapter.quarantine === "function") {
          try {
            observed = await this.builderAdapter.observe(this.identity.lifecycle);
            if (proveGoldenBuilderOwnershipV1(observed, this.identity.lifecycle)) quarantine = await this.builderAdapter.quarantine(this.identity.lifecycle);
          } catch { quarantine = null; }
        }
        await this.journal.record(this.identity, "builder-controller-cleanup-quarantined", { causeCode: error?.code ?? "CONTROLLER_CLEANUP_FAILED", quarantineOperationId: quarantine?.providerOperationId ?? null });
        await this.#ensureGatewayRestored();
        fail("BUILDER_CONTROLLER_RECONCILIATION_REQUIRED", "cleanup-only nested controller reconciliation is not terminal; the exact builder remains quarantined", { causeCode: error?.code ?? error?.name ?? "CONTROLLER_CLEANUP_FAILED" });
      }
    }
    observed = await this.builderAdapter.observe(this.identity.lifecycle);
    if (observed.status === "absent") await this.#proveBuilderAbsent();
    else {
      if (!proveGoldenBuilderOwnershipV1(observed, this.identity.lifecycle)) fail("BUILDER_OWNERSHIP_UNPROVEN", "builder identity changed before cleanup-only destruction");
      await cleanupOwnedGoldenBuilderV1({ adapter: this.builderAdapter, binding: this.identity.lifecycle, journal: this.#eventJournal() });
    }
    await this.#ensureGatewayRestored();
    return this.journal.update(this.identity, "run-canceled", {}, (current) => { current.state = "canceled"; current.gatewayActive = false; current.gatewayRestored = true; return current; });
  }

  #eventJournal() {
    return { record: (event, details = {}) => this.journal.record(this.identity, event, details) };
  }

  async #proveBuilderAbsent() {
    const absent = await this.builderAdapter.confirmAbsent(this.identity.lifecycle);
    if (!plain(absent) || absent.vmAbsent !== true || absent.nameAbsent !== true || absent.volumesAbsent !== true) fail("BUILDER_CLEANUP_UNPROVEN", "independent builder absence is not exact");
    return absent;
  }

  async #ensureGatewayRestored() {
    try {
      const restored = await this.gatewayAdapter.confirmRestored(this.identity.gateway);
      await this.journal.record(this.identity, "gateway-policy-restored", {
        bindingDigest: this.identity.gateway.bindingDigest,
        originalRulesetDigest: restored.rulesetDigest,
        independentInventoryDigest: restored.independentInventoryDigest,
        providerOperationId: "already-restored",
      });
      return restored;
    } catch (error) {
      if (!["GATEWAY_RESTORE_UNPROVEN", "GATEWAY_TRANSPORT_FAILED"].includes(error?.code)) throw error;
      return restoreGoldenBuilderGatewayPolicyV1({ binding: this.identity.gateway, adapter: this.gatewayAdapter, journal: this.#eventJournal() });
    }
  }

  async #completedBuilderResult(state) {
    if (!state.builderTerminal) return null;
    const observed = await this.builderAdapter.observe(this.identity.lifecycle);
    if (observed.status !== "absent") return null;
    const absent = await this.#proveBuilderAbsent();
    const ids = operationIds(state.events);
    return Object.freeze({
      schemaVersion: 1,
      state: "destroyed",
      packetDigest: state.builderTerminal.packetDigest,
      terminalDigest: state.builderTerminal.terminalDigest,
      goldenImageDigest: state.builderTerminal.goldenImageDigest,
      cleanup: {
        stopOperationId: ids["builder-stopped"] ?? null,
        destroyOperationId: ids["builder-destroyed"] ?? "reconciled-existing-destroy",
        absenceDigest: sha256V1(absent),
      },
    });
  }

  #gatewayFacade() {
    const runner = this;
    return {
      async preflight(binding) {
        const state = await runner.journal.load(runner.identity);
        if (state.gatewayActive) { await runner.gatewayAdapter.observe(binding); return {}; }
        if (state.lastEvent === "gateway-policy-preflighted") {
          try {
            await runner.gatewayAdapter.confirmRestored(binding);
          } catch (error) {
            if (!["GATEWAY_RESTORE_UNPROVEN", "GATEWAY_TRANSPORT_FAILED"].includes(error?.code)) throw error;
            const active = await runner.gatewayAdapter.observe(binding);
            await runner.journal.record(runner.identity, "gateway-policy-active", { bindingDigest: binding.bindingDigest, providerOperationId: "reconciled-active-policy", rulesetDigest: active.rulesetDigest });
            return {};
          }
        }
        return runner.gatewayAdapter.preflight(binding);
      },
      async apply(binding) {
        const state = await runner.journal.load(runner.identity);
        if (state.gatewayActive) { await runner.gatewayAdapter.observe(binding); return { providerOperationId: "reconciled-active-policy" }; }
        return runner.gatewayAdapter.apply(binding);
      },
      observe: (binding) => runner.gatewayAdapter.observe(binding),
      restore: (binding) => runner.gatewayAdapter.restore(binding),
      confirmRestored: (binding) => runner.gatewayAdapter.confirmRestored(binding),
    };
  }

  #builderFacade() {
    const runner = this;
    return {
      async preflight(binding) {
        const state = await runner.journal.load(runner.identity);
        if (state.builderPreflight) {
          const observed = await runner.builderAdapter.observe(binding);
          if (observed.status !== "absent" && !proveGoldenBuilderOwnershipV1(observed, binding)) fail("BUILDER_OWNERSHIP_UNPROVEN", "resume observed a different builder identity");
          return structuredClone(state.builderPreflight);
        }
        const snapshot = await runner.builderAdapter.preflight(binding);
        await runner.journal.update(runner.identity, "builder-preflight-snapshot", { snapshotDigest: sha256V1(snapshot) }, (current) => { current.builderPreflight = structuredClone(snapshot); return current; });
        return snapshot;
      },
      async provision(binding) {
        const state = await runner.journal.load(runner.identity);
        if (state.events.some(({ event }) => event === "builder-provisioned")) {
          const observed = await runner.builderAdapter.observe(binding);
          if (!proveGoldenBuilderOwnershipV1(observed, binding, { requireRunning: true })) fail("BUILDER_OWNERSHIP_UNPROVEN", "journaled builder provision is not freshly proven");
          return { status: "committed", providerOperationId: "reconciled-existing-builder" };
        }
        return runner.builderAdapter.provision(binding);
      },
      observe: (binding) => runner.builderAdapter.observe(binding),
      stop: (binding) => runner.builderAdapter.stop(binding),
      destroy: (binding) => runner.builderAdapter.destroy(binding),
      confirmAbsent: (binding) => runner.builderAdapter.confirmAbsent(binding),
      ...(typeof runner.builderAdapter.quarantine === "function" ? { quarantine: (binding) => runner.builderAdapter.quarantine(binding) } : {}),
    };
  }

  async #runBuilder() {
    return runDisposableGoldenBuilderV1({
      reservation: this.identity.reservation,
      lifecycleBinding: this.identity.lifecycle,
      toolchainLockDigest: this.identity.toolchainLockDigest,
      adapter: this.#builderFacade(),
      executeController: async (input) => {
        const state = await this.journal.load(this.identity);
        if (state.builderTerminal) return structuredClone(state.builderTerminal);
        // Raw controller output is not durable authority. Only the receiptStore
        // callback below runs after lifecycle validation and may make a terminal
        // reusable across processes.
        return this.executeController(input);
      },
      bundleStore: this.bundleStore,
      receiptStore: {
        commit: async (terminal) => {
          await this.terminalStore.commit(terminal);
          await this.journal.update(this.identity, "builder-terminal-stored", { terminalDigest: terminal.terminalDigest }, (current) => { current.builderTerminal = structuredClone(terminal); return current; });
        },
      },
      journal: this.#eventJournal(),
      clock: this.clock,
    });
  }

  async #drive() {
    let state = await this.journal.load(this.identity);
    if (TERMINAL_STATES.has(state.state)) return state;
    if (state.state === "canceling") fail("CANCEL_IN_PROGRESS", "resume cancel with cancel, not run");
    try {
      let result = state.builderResult ?? await this.#completedBuilderResult(state);
      if (result) {
        if (!state.builderResult) await this.journal.update(this.identity, "builder-result-reconciled", { terminalDigest: result.terminalDigest }, (current) => { current.builderResult = structuredClone(result); return current; });
        await this.#ensureGatewayRestored();
      } else {
        result = await runGatewayProtectedGoldenBuilderV1({
          binding: this.identity.gateway,
          adapter: this.#gatewayFacade(),
          journal: this.#eventJournal(),
          runBuilder: () => this.#runBuilder(),
        });
        await this.journal.update(this.identity, "builder-result-committed", { terminalDigest: result.terminalDigest }, (current) => { current.builderResult = structuredClone(result); return current; });
      }
      state = await this.journal.update(this.identity, "run-succeeded", { terminalDigest: result.terminalDigest, goldenImageDigest: result.goldenImageDigest }, (current) => {
        current.state = "succeeded";
        current.gatewayActive = false;
        current.gatewayRestored = true;
        current.builderResult = structuredClone(result);
        return current;
      });
      return state;
    } catch (error) {
      await this.journal.update(this.identity, "run-interrupted", { errorCode: error?.code ?? "GOLDEN_RUN_FAILED" }, (current) => {
        current.state = "interrupted";
        current.failure = { code: error?.code ?? "GOLDEN_RUN_FAILED" };
        return current;
      }).catch(() => {});
      throw error;
    }
  }
}

export function createGoldenBuilderProductionRunIdentityV1(input, { now = Date.now(), allowExpiredForCleanup = false } = {}) {
  return validateRuntimeIdentity(input, now, { allowExpiredForCleanup });
}
