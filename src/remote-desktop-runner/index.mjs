import {
  admitRemoteDesktopRun,
  emptyRemoteDesktopUsage,
  transitionRemoteDesktopRun,
  validateRemoteDesktopRunV1,
  validateRemoteDesktopTerminalOutcomeV1,
  validateRemoteDesktopUsage,
} from "nelos/remote-desktop-contract";
import {
  assertProposedRemoteDesktopUsageV1,
  createRemoteDesktopEvidenceBundleV1,
  verifyRemoteDesktopEvidenceBundleV1,
} from "nelos/remote-desktop-evidence";
import { isAbsolute } from "node:path";
import { admitProxmoxDesktopOperationV1, runProxmoxDesktopOperationV1 } from "../../validation/proxmox-desktop/v1/backend/index.mjs";
import { AtomicRemoteDesktopJournal, contentDigest } from "./journal.mjs";

const USAGE_FIELDS = Object.freeze(Object.keys(emptyRemoteDesktopUsage()));
const ZERO = () => emptyRemoteDesktopUsage();
const PROVIDER_EFFECTS = new Set(["provision", "destroy", "quarantine"]);

export { AtomicRemoteDesktopJournal, RemoteDesktopJournalError, canonicalJson, contentDigest } from "./journal.mjs";

export class RemoteDesktopRunnerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "RemoteDesktopRunnerError";
    this.code = code;
    this.details = details;
  }
}

function assertClosed(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new RemoteDesktopRunnerError("INVALID_RUNNER_INPUT", `${label} fields do not match the closed runner contract`);
  }
}

function usage(value, label) {
  assertClosed(value, USAGE_FIELDS, label);
  for (const field of USAGE_FIELDS) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0 || (field !== "spendUsd" && !Number.isSafeInteger(value[field]))) {
      throw new RemoteDesktopRunnerError("INVALID_RUNNER_INPUT", `${label}.${field} is not a finite usage bound`);
    }
  }
  return structuredClone(value);
}

function evidencePlannedUsage(evidence) {
  assertClosed(evidence.proposedOperationalUsage, ["taskCount", "modelTurnCount", "spendUsd", "wallTimeMs"], "plan.evidence.proposedOperationalUsage");
  const delta = { ...ZERO(), ...evidence.proposedOperationalUsage };
  delta.screenshotCount = evidence.screenshots.length;
  delta.screenshotBytes = evidence.screenshots.reduce((total, item) => total + item.maxOutputBytes, 0);
  delta.recordingDurationMs = evidence.recordings.reduce((total, item) => total + item.durationMs, 0);
  delta.recordingBytes = evidence.recordings.reduce((total, item) => total + item.maxOutputBytes, 0);
  delta.diagnosticLogCount = evidence.diagnostics.length;
  delta.diagnosticLogBytes = evidence.diagnostics.reduce((total, item) => total + Buffer.byteLength(`${JSON.stringify({ schemaVersion: 1, source: item.source, code: item.code, occurredAt: item.occurredAt, fields: item.fields })}\n`), 0);
  return usage(delta, "plan.evidence.bound");
}

function productionAdmissionIdentity(value) {
  if (value === null || value === undefined) return null;
  const authority = value.leaseAuthority;
  assertClosed(authority, ["binding", "issuedObservationDigest"], "productionAdmission.leaseAuthority");
  assertClosed(authority.binding, ["authorityId", "epoch", "issuedRecordDigest", "issuedRecordFileDigest", "issuedRevision", "trustDigest"], "productionAdmission.leaseAuthority.binding");
  if (typeof authority.binding.authorityId !== "string" || !Number.isSafeInteger(authority.binding.epoch) || authority.binding.epoch < 1 ||
      !Number.isSafeInteger(authority.binding.issuedRevision) || authority.binding.issuedRevision < 1 ||
      [authority.binding.issuedRecordDigest, authority.binding.issuedRecordFileDigest, authority.binding.trustDigest, authority.issuedObservationDigest]
        .some((digest) => !/^sha256:[0-9a-f]{64}$/u.test(digest ?? ""))) {
    throw new RemoteDesktopRunnerError("INVALID_RUNNER_INPUT", "production admission lease authority is invalid");
  }
  return {
    packetDigest: value.packetDigest,
    gateReceiptDigest: value.gateReceiptDigest,
    configDigest: value.configDigest,
    runDeadlineAt: value.runDeadlineAt ?? null,
    leaseAuthority: structuredClone(authority),
    verificationReceiptDigest: value.verificationReceiptDigest,
  };
}

function recoveryAdmission(value, operation) {
  if (value === null || value === undefined) return null;
  const observation = value.currentLeaseObservation;
  if (!observation || value.currentLeaseObservationDigest !== observation.observationDigest ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.currentLeaseObservationDigest ?? "") ||
      !["continue", "cleanup-only"].includes(value.recoveryMode) ||
      (operation === "cancel" && value.recoveryMode !== "cleanup-only")) {
    throw new RemoteDesktopRunnerError("RECOVERY_ADMISSION_REQUIRED", "production recovery requires one fresh current-lease observation and an exact recovery disposition");
  }
  return Object.freeze({
    schemaVersion: 1,
    operation,
    recoveryMode: value.recoveryMode,
    currentLeaseObservation: structuredClone(observation),
    currentLeaseObservationDigest: value.currentLeaseObservationDigest,
  });
}

function bindingOf(run) {
  return { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken };
}

function independentPreProvisionAbsence(value, run, now) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteDesktopRunnerError("PRE_PROVISION_RESERVATION_ATTESTATION_REQUIRED", "pre-provision cancellation requires a fresh independent reservation observation");
  }
  assertClosed(value, ["binding", "observationDigest", "observedAt", "schemaVersion", "state", "type"], "initialReservationObservation");
  const expected = bindingOf(run);
  assertClosed(value.binding, Object.keys(expected), "initialReservationObservation.binding");
  const observedAt = Date.parse(value.observedAt);
  if (value.schemaVersion !== 1 || value.type !== "independent-pre-mutation-vm-observation" || value.state !== "absent" ||
      !Number.isFinite(observedAt) || observedAt > now + 5_000 || now - observedAt > 30_000 ||
      Object.entries(expected).some(([field, expectedValue]) => value.binding[field] !== expectedValue)) {
    throw new RemoteDesktopRunnerError("PRE_PROVISION_RESERVATION_ATTESTATION_REQUIRED", "independent reservation observation is not an exact absence proof for this run");
  }
  const { observationDigest, ...unsigned } = value;
  if (!/^sha256:[0-9a-f]{64}$/u.test(observationDigest ?? "") || contentDigest(unsigned) !== observationDigest) {
    throw new RemoteDesktopRunnerError("PRE_PROVISION_RESERVATION_ATTESTATION_REQUIRED", "independent reservation observation digest differs");
  }
  return Object.freeze(structuredClone(value));
}

function terminalOutcome(run, receipt) {
  const outcome = receipt?.destroyed === true ? "destroyed" : receipt?.quarantined === true ? "quarantined" : null;
  if (outcome === null) throw new RemoteDesktopRunnerError("AMBIGUOUS_CLEANUP", "cleanup returned neither exact destruction nor attested quarantine");
  const value = {
    schemaVersion: 1, runId: run.runId, outcome, ownedVm: structuredClone(run.provider),
    leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken, receipt: structuredClone(receipt),
  };
  validateRemoteDesktopTerminalOutcomeV1(value, run);
  return value;
}

function cleanupAttestation(run, outcome) {
  return {
    evidenceClass: "cleanup_attestation", runId: run.runId, ...run.provider,
    leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken,
    terminalOutcomeDigest: contentDigest(outcome),
  };
}

function scenarioEvidence(results) {
  return {
    scenarioMetadata: results.map((result) => ({
      evidenceClass: "scenario_metadata", scenarioId: result.scenarioId, taskId: result.taskId,
      startedAt: result.startedAt, finishedAt: result.finishedAt, outcome: result.outcome,
    })),
    actionTimeline: results.flatMap((result) => result.actions.map((action) => ({
      evidenceClass: "action_timeline", scenarioId: result.scenarioId, ...action,
    }))),
    assertionOutcomes: results.flatMap((result) => result.assertions.map((assertion) => ({
      evidenceClass: "assertion_outcome", scenarioId: result.scenarioId, ...assertion,
    }))),
  };
}

function declaredSealedValueRefs(run) {
  const occurrences = run.scenarios.flatMap((scenario) => [
    ...scenario.actions.filter(({ type }) => type === "type_text_ref").map(({ valueRef }) => valueRef),
    ...scenario.assertions.filter(({ type }) => type === "text_ref_present").map(({ expectedRef }) => expectedRef),
  ]);
  if (occurrences.some((valueRef) => typeof valueRef !== "string") || new Set(occurrences).size !== occurrences.length) {
    throw new RemoteDesktopRunnerError("INVALID_RUNNER_INPUT", "one-shot sealed value references must be unique across the run");
  }
  return Object.freeze([...occurrences].sort());
}

function sealedValueCleanupReceipt(run, declaredValueRefs, value) {
  assertClosed(value, ["alreadyAbsentValueRefs", "declaredValueRefs", "kind", "remainingValueRefs", "removedValueRefs", "schemaVersion"], "sealedValueCleanup");
  for (const field of ["declaredValueRefs", "removedValueRefs", "alreadyAbsentValueRefs", "remainingValueRefs"]) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== "string") ||
        new Set(value[field]).size !== value[field].length || JSON.stringify([...value[field]].sort()) !== JSON.stringify(value[field])) {
      throw new RemoteDesktopRunnerError("SEALED_VALUE_CLEANUP_FAILED", "sealed value cleanup inventory is not exact and sorted");
    }
  }
  const removedAndAbsent = [...value.removedValueRefs, ...value.alreadyAbsentValueRefs].sort();
  if (value.schemaVersion !== 1 || value.kind !== "sealed-value-absence" || value.remainingValueRefs.length !== 0 ||
      JSON.stringify(value.declaredValueRefs) !== JSON.stringify(declaredValueRefs) ||
      JSON.stringify(removedAndAbsent) !== JSON.stringify(declaredValueRefs) ||
      new Set(removedAndAbsent).size !== removedAndAbsent.length) {
    throw new RemoteDesktopRunnerError("SEALED_VALUE_CLEANUP_FAILED", "sealed value cleanup did not attest exact declared-value absence");
  }
  const receipt = {
    schemaVersion: 1,
    type: "sealed-value-terminal-cleanup",
    runId: run.runId,
    inventoryDigest: contentDigest({ schemaVersion: 1, runId: run.runId, declaredValueRefs }),
    result: structuredClone(value),
  };
  return Object.freeze({ ...receipt, receiptDigest: contentDigest(receipt) });
}

function serializeEvidenceCollection(value) {
  return {
    screenshots: (value.screenshots ?? []).map((item) => ({ ...item, frame: { ...item.frame, rgba: Buffer.from(item.frame.rgba).toString("base64") } })),
    recordings: structuredClone(value.recordings ?? []),
    diagnostics: structuredClone(value.diagnostics ?? []),
    ...(value.authAttestation === undefined ? {} : { authAttestation: structuredClone(value.authAttestation) }),
  };
}

function deserializeEvidenceCollection(value) {
  return {
    screenshots: (value?.screenshots ?? []).map((item) => ({ ...item, frame: { ...item.frame, rgba: Buffer.from(item.frame.rgba, "base64") } })),
    recordings: structuredClone(value?.recordings ?? []),
    diagnostics: structuredClone(value?.diagnostics ?? []),
    ...(value?.authAttestation === undefined ? {} : { authAttestation: structuredClone(value.authAttestation) }),
  };
}

function validatePlan(plan, run) {
  assertClosed(plan, ["goldenImageTemplateVmId", "reservation", "automation", "operationUsage", "scenarioUsage", "archiveConvergence", "evidence"], "plan");
  assertClosed(plan.operationUsage, ["provision", "cleanup", "quarantine"], "plan.operationUsage");
  for (const name of ["provision", "cleanup", "quarantine"]) usage(plan.operationUsage[name], `plan.operationUsage.${name}`);
  assertClosed(plan.scenarioUsage, run.scenarios.map(({ scenarioId }) => scenarioId), "plan.scenarioUsage");
  let projected = ZERO();
  projected = assertProposedRemoteDesktopUsageV1(projected, plan.operationUsage.provision, run.policy);
  for (const scenario of run.scenarios) {
    const delta = usage(plan.scenarioUsage[scenario.scenarioId], `plan.scenarioUsage.${scenario.scenarioId}`);
    if (delta.taskCount < 1 || delta.modelTurnCount < 1 || delta.wallTimeMs < scenario.deadlineMs) {
      throw new RemoteDesktopRunnerError("UNDERDECLARED_OPERATION", `scenario ${scenario.scenarioId} lacks explicit task, turn, or wall-time coverage`);
    }
    projected = assertProposedRemoteDesktopUsageV1(projected, delta, run.policy);
  }
  assertClosed(plan.archiveConvergence, ["operationUsage", "policy"], "plan.archiveConvergence");
  assertClosed(plan.archiveConvergence.policy, ["maxConvergenceMs", "requireArchiveReceipts", "requireRestartCheckpoint", "requiredConsecutiveAbsent"], "plan.archiveConvergence.policy");
  const convergencePolicy = plan.archiveConvergence.policy;
  if (!Number.isSafeInteger(convergencePolicy.maxConvergenceMs) || convergencePolicy.maxConvergenceMs < 1 || convergencePolicy.maxConvergenceMs > 3_600_000 ||
      convergencePolicy.requireArchiveReceipts !== true || convergencePolicy.requireRestartCheckpoint !== true ||
      !Number.isSafeInteger(convergencePolicy.requiredConsecutiveAbsent) || convergencePolicy.requiredConsecutiveAbsent < 2 || convergencePolicy.requiredConsecutiveAbsent > 10) {
    throw new RemoteDesktopRunnerError("INVALID_ARCHIVE_CONVERGENCE_POLICY", "live Desktop validation requires archive receipts, an app restart, and at least two clean checkpoints");
  }
  const convergenceUsage = usage(plan.archiveConvergence.operationUsage, "plan.archiveConvergence.operationUsage");
  if (convergenceUsage.wallTimeMs < convergencePolicy.maxConvergenceMs || convergenceUsage.screenshotCount < 2) {
    throw new RemoteDesktopRunnerError("UNDERDECLARED_OPERATION", "archive convergence lacks wall-time or two-checkpoint screenshot coverage");
  }
  projected = assertProposedRemoteDesktopUsageV1(projected, convergenceUsage, run.policy);
  projected = assertProposedRemoteDesktopUsageV1(projected, plan.operationUsage.cleanup, run.policy);
  assertClosed(plan.evidence, ["bundleDirectory", "proposedOperationalUsage", "screenshots", "recordings", "diagnostics"], "plan.evidence");
  if (!isAbsolute(plan.evidence.bundleDirectory)) throw new RemoteDesktopRunnerError("INVALID_RUNNER_INPUT", "evidence bundle directory must be absolute");
  if (!Array.isArray(plan.evidence.screenshots) || !Array.isArray(plan.evidence.recordings) || !Array.isArray(plan.evidence.diagnostics)) {
    throw new RemoteDesktopRunnerError("INVALID_RUNNER_INPUT", "evidence collections must be arrays");
  }
  assertProposedRemoteDesktopUsageV1(projected, evidencePlannedUsage(plan.evidence), run.policy);
  return projected;
}

function identityFor(run, plan, productionAdmission = null) {
  return contentDigest({
    schemaVersion: run.schemaVersion, runId: run.runId, candidate: run.candidate, desktopBundle: run.desktopBundle,
    goldenImage: run.goldenImage, provider: run.provider, lease: run.lease, benchmarkProfile: run.benchmarkProfile,
    scenarioManifest: run.scenarioManifest, policy: run.policy, scenarios: run.scenarios,
    goldenImageTemplateVmId: plan.goldenImageTemplateVmId, reservation: plan.reservation,
    automation: plan.automation, operationUsage: plan.operationUsage, scenarioUsage: plan.scenarioUsage,
    archiveConvergence: plan.archiveConvergence,
    evidenceBounds: {
      bundleDirectory: plan.evidence.bundleDirectory, proposedOperationalUsage: plan.evidence.proposedOperationalUsage,
      screenshots: plan.evidence.screenshots.map(({ maxOutputBytes, scenarioId, artifactId }) => ({ maxOutputBytes, scenarioId, artifactId })),
      recordings: plan.evidence.recordings.map(({ maxOutputBytes, durationMs, scenarioId, artifactId }) => ({ maxOutputBytes, durationMs, scenarioId, artifactId })),
      diagnostics: plan.evidence.diagnostics.map(({ diagnosticId, scenarioId, code }) => ({ diagnosticId, scenarioId, code })),
    },
    productionAdmission: productionAdmissionIdentity(productionAdmission),
  });
}

export function preflightRemoteDesktopRunV1({ run, plan, candidateDigest, currentLease, productionAdmission = null, now = Date.now() }) {
  validateRemoteDesktopRunV1(run);
  declaredSealedValueRefs(run);
  validatePlan(plan, run);
  const admitted = admitRemoteDesktopRun(structuredClone(run), { candidateDigest, currentLease, now, usage: ZERO() });
  admitProxmoxDesktopOperationV1(backendRequest(run, plan, "create", `${run.runId}:preflight`), {
    ownership: run.provider, currentLease: run.lease, inventory: null, now,
  });
  return Object.freeze({ admittedRun: admitted, identityDigest: identityFor(run, plan, productionAdmission), projectedUsage: validatePlan(plan, run), productionAdmission });
}

export class ProxmoxDesktopControllerV1 {
  constructor({ adapter, ownership, currentLease, now = () => Date.now(), runDeadlineAt = null, beforeProviderMutation = null, reconcileEffect }) {
    if (typeof now !== "function" || (runDeadlineAt !== null && !Number.isFinite(Date.parse(runDeadlineAt))) ||
        (beforeProviderMutation !== null && typeof beforeProviderMutation !== "function")) {
      throw new RemoteDesktopRunnerError("INVALID_PROVIDER_CONTROLLER", "provider controller clock or production run deadline is invalid");
    }
    this.adapter = adapter; this.ownership = ownership; this.currentLease = currentLease; this.now = now; this.runDeadlineAt = runDeadlineAt;
    this.beforeProviderMutation = beforeProviderMutation; this.reconcile = reconcileEffect;
  }
  async execute({ operation, request }) {
    return runProxmoxDesktopOperationV1(request, this.adapter, {
      ownership: this.ownership,
      currentLease: this.currentLease,
      now: this.now,
      runDeadlineAt: this.runDeadlineAt,
      beforeProviderMutation: this.beforeProviderMutation,
    });
  }
  async reconcileEffect(effect, options = {}) {
    if (typeof this.reconcile !== "function") throw new RemoteDesktopRunnerError("RECONCILIATION_REQUIRED", `pending ${effect.kind} requires an explicit provider reconciliation boundary`);
    return this.reconcile(structuredClone(effect), structuredClone(options));
  }
}

function backendRequest(run, plan, operation, effectId) {
  return {
    schemaVersion: 1, operationId: effectId, operation, runId: run.runId,
    provider: structuredClone(run.provider),
    desktopBundle: structuredClone(run.desktopBundle),
    goldenImage: { ...structuredClone(run.goldenImage), templateVmId: plan.goldenImageTemplateVmId },
    lease: structuredClone(run.lease), reservation: structuredClone(plan.reservation), automation: structuredClone(plan.automation),
  };
}

export class ResumableRemoteDesktopRunnerV1 {
  constructor({ journalDirectory, providerController, guiDriver, archiveProjectionController, evidenceCollector = null, productionGuard = null, taskPreparer = null, crashInjector = null, clock = Date }) {
    if (typeof archiveProjectionController?.execute !== "function" || typeof archiveProjectionController?.reconcileEffect !== "function") {
      throw new RemoteDesktopRunnerError("INVALID_ARCHIVE_CONVERGENCE_CONTROLLER", "archive projection controller must execute and reconcile the mandatory live convergence lane");
    }
    this.journal = new AtomicRemoteDesktopJournal(journalDirectory);
    this.provider = providerController; this.gui = guiDriver; this.collector = evidenceCollector;
    this.archiveProjection = archiveProjectionController;
    this.productionGuard = productionGuard;
    this.taskPreparer = taskPreparer;
    if (productionGuard !== null) {
      for (const method of ["prepareBeforeDestroy", "verifyBeforeDestroy", "attestAfterDestroy", "attestFinalEvidence"]) {
        if (typeof productionGuard?.[method] !== "function") throw new RemoteDesktopRunnerError("INVALID_PRODUCTION_GUARD", `production guard must implement ${method}`);
      }
      if (!Number.isFinite(Date.parse(productionGuard?.admission?.runDeadlineAt ?? ""))) {
        throw new RemoteDesktopRunnerError("INVALID_PRODUCTION_GUARD", "production guard must retain the immutable packet run deadline");
      }
      for (const method of ["execute", "reconcileEffect", "materialize"]) {
        if (typeof taskPreparer?.[method] !== "function") throw new RemoteDesktopRunnerError("INVALID_TASK_PREPARER", `production guest task preparer must implement ${method}`);
      }
      if (typeof guiDriver?.cleanupSealedValues !== "function") {
        throw new RemoteDesktopRunnerError("INVALID_SEALED_RESOLVER", "production GUI must support terminal sealed-value absence attestation");
      }
    }
    this.crashInjector = crashInjector; this.clock = clock;
  }

  async preflight(input) { return preflightRemoteDesktopRunV1({ ...input, productionAdmission: this.productionGuard?.admission ?? null, now: input.now ?? this.clock.now() }); }

  async start(input) {
    return this.journal.withRunLock(async () => {
      const checked = await this.preflight(input);
      const state = {
        schemaVersion: 1, generation: 0, identityDigest: checked.identityDigest,
        run: structuredClone(checked.admittedRun), usage: ZERO(), effects: [], receipts: [],
        scenarioResults: [], taskPreparation: null, archiveConvergence: null, evidenceCollection: null, preDestroyInventoryDraft: null,
        preDestroyVerification: null, preDestroyEvidenceFailure: null, postDestroyAttestation: null,
        evidence: null, finalEvidenceAttestation: null, failure: null, cancelRequested: false, terminalOutcome: null,
        preProvisionAbort: null,
        sealedValueInventory: declaredSealedValueRefs(checked.admittedRun),
        sealedValueCleanup: null,
        recoveryAdmissions: [],
        productionAdmission: checked.productionAdmission, planDigest: contentDigest(input.plan), createdAt: new Date(this.clock.now()).toISOString(),
      };
      await this.journal.initialize(state);
      await this.#checkpoint("after:journal-initialize");
      return this.#drive(input.run, input.plan);
    });
  }

  async resume({ run, plan }) {
    return this.journal.withRunLock(async () => {
      const current = await this.journal.load();
      if (current.identityDigest !== identityFor(run, plan, this.productionGuard?.admission ?? null) || current.planDigest !== contentDigest(plan) ||
          contentDigest(productionAdmissionIdentity(current.productionAdmission)) !== contentDigest(productionAdmissionIdentity(this.productionGuard?.admission ?? null))) {
        throw new RemoteDesktopRunnerError("RESUME_IDENTITY_MISMATCH", "resume inputs do not exactly match the committed immutable run identity");
      }
      const recovery = recoveryAdmission(this.productionGuard?.admission ?? null, "resume");
      if (recovery !== null) {
        await this.journal.update((value) => ({
          ...value,
          recoveryAdmissions: (value.recoveryAdmissions ?? []).some(({ operation, currentLeaseObservationDigest }) => operation === recovery.operation && currentLeaseObservationDigest === recovery.currentLeaseObservationDigest)
            ? value.recoveryAdmissions : [...(value.recoveryAdmissions ?? []), recovery],
          ...(recovery.recoveryMode === "cleanup-only" ? { cancelRequested: true, failure: value.failure ?? { code: "RUN_DEADLINE_EXPIRED" } } : {}),
        }));
      }
      return this.#drive(run, plan);
    });
  }

  async cancel({ run, plan }) {
    return this.journal.withRunLock(async () => {
      const current = await this.journal.load();
      if (current.identityDigest !== identityFor(run, plan, this.productionGuard?.admission ?? null) ||
          contentDigest(productionAdmissionIdentity(current.productionAdmission)) !== contentDigest(productionAdmissionIdentity(this.productionGuard?.admission ?? null))) throw new RemoteDesktopRunnerError("RESUME_IDENTITY_MISMATCH", "cancel inputs do not match the journal");
      const recovery = recoveryAdmission(this.productionGuard?.admission ?? null, "cancel");
      await this.journal.update((value) => ({
        ...value,
        cancelRequested: true,
        failure: value.failure ?? { code: "CANCELLED" },
        ...(recovery === null ? {} : {
          recoveryAdmissions: (value.recoveryAdmissions ?? []).some(({ operation, currentLeaseObservationDigest }) => operation === recovery.operation && currentLeaseObservationDigest === recovery.currentLeaseObservationDigest)
            ? value.recoveryAdmissions : [...(value.recoveryAdmissions ?? []), recovery],
        }),
      }));
      return this.#drive(run, plan);
    });
  }

  async #checkpoint(name) { if (this.crashInjector) await this.crashInjector(name); }

  async #enforceRunDeadline() {
    const current = await this.journal.load();
    const deadlineAt = current.productionAdmission?.runDeadlineAt;
    if (deadlineAt === undefined || deadlineAt === null || ["succeeded", "failed", "quarantined"].includes(current.run.state)) return current;
    const deadline = Date.parse(deadlineAt);
    if (!Number.isFinite(deadline)) throw new RemoteDesktopRunnerError("INVALID_PRODUCTION_GUARD", "journaled production run deadline is invalid");
    if (this.clock.now() < deadline) return current;
    if (current.cancelRequested && current.failure) return current;
    await this.journal.update((value) => ({
      ...value,
      cancelRequested: true,
      failure: value.failure ?? { code: "RUN_DEADLINE_EXPIRED" },
    }));
    return this.journal.load();
  }

  async #abortBeforeProvisionIfAbsent() {
    const current = await this.journal.load();
    if (!this.productionGuard || current.run.state !== "admitted" || current.cancelRequested !== true ||
        current.effects.some(({ kind }) => kind === "provision")) return null;
    const observation = independentPreProvisionAbsence(this.productionGuard.initialReservationObservation ?? null, current.run, this.clock.now());
    await this.journal.update((value) => ({
      ...value,
      preProvisionAbort: {
        schemaVersion: 1,
        type: "pre-provision-run-abort",
        reason: value.failure?.code ?? "CANCELLED",
        reservationObservation: observation,
      },
      run: { ...value.run, state: "failed" },
    }));
    return this.journal.load();
  }

  async #setRun(nextRun, patch = {}) {
    await this.journal.update((value) => ({ ...value, ...patch, run: structuredClone(nextRun) }));
  }

  async #intent(kind, operation, proposedUsage, request = null) {
    const current = await this.journal.load();
    const id = `${current.run.runId}:${kind}:${current.effects.filter((effect) => effect.kind === kind).length + 1}`;
    assertProposedRemoteDesktopUsageV1(current.usage, proposedUsage, current.run.policy);
    const effect = { effectId: id, kind, operation, identityDigest: current.identityDigest, status: "intent", proposedUsage, request, receipt: null };
    await this.journal.update((value) => ({ ...value, effects: [...value.effects, effect] }));
    return effect;
  }

  async #commitEffect(effect, receipt, actualUsage = effect.proposedUsage) {
    const current = await this.journal.load();
    if (current.identityDigest !== effect.identityDigest) throw new RemoteDesktopRunnerError("EFFECT_IDENTITY_MISMATCH", "effect identity changed before commit");
    const projected = assertProposedRemoteDesktopUsageV1(current.usage, actualUsage, current.run.policy);
    await this.journal.update((value) => ({
      ...value, usage: projected, receipts: [...value.receipts, structuredClone(receipt)],
      effects: value.effects.map((item) => item.effectId === effect.effectId ? { ...item, status: "committed", receipt: structuredClone(receipt), actualUsage } : item),
    }));
    await this.#checkpoint(receipt?.quarantined === true ? "after:quarantine" : `after:${effect.kind}`);
    return receipt;
  }

  async #reconcilePending() {
    let current = await this.journal.load();
    const cleanupOnly = current.cancelRequested === true;
    for (const effect of current.effects.filter(({ status }) => status === "intent")) {
      if (effect.identityDigest !== current.identityDigest) throw new RemoteDesktopRunnerError("EFFECT_IDENTITY_MISMATCH", "pending effect belongs to another run identity");
      if (effect.kind === "gui") {
        await this.journal.update((value) => ({ ...value, failure: value.failure ?? { code: "AMBIGUOUS_GUI_EFFECT", effectId: effect.effectId }, effects: value.effects.map((item) => item.effectId === effect.effectId ? { ...item, status: "ambiguous" } : item) }));
        continue;
      }
      if (effect.kind === "evidence") {
        try {
          const verified = await verifyRemoteDesktopEvidenceBundleV1(effect.request.bundleDirectory, current.run);
          await this.#commitEffect(effect, { bundleDirectory: effect.request.bundleDirectory, inventory: verified.inventory }, effect.proposedUsage);
        } catch {
          await this.journal.update((value) => ({ ...value, failure: value.failure ?? { code: "AMBIGUOUS_EVIDENCE_EFFECT", effectId: effect.effectId }, effects: value.effects.map((item) => item.effectId === effect.effectId ? { ...item, status: "ambiguous" } : item) }));
        }
        continue;
      }
      if (effect.kind === "archive-convergence") {
        if (cleanupOnly) {
          await this.journal.update((value) => ({ ...value, failure: value.failure ?? { code: "RUN_DEADLINE_EXPIRED" }, effects: value.effects.map((item) => item.effectId === effect.effectId ? { ...item, status: "ambiguous" } : item) }));
          continue;
        }
        const receipt = await this.archiveProjection.reconcileEffect(structuredClone(effect));
        await this.#commitEffect(effect, receipt, effect.proposedUsage);
        current = await this.journal.load();
        continue;
      }
      if (effect.kind === "task-preparation") {
        const receipt = await this.taskPreparer.reconcileEffect(structuredClone(effect), { cleanupOnly });
        await this.#commitEffect(effect, receipt, effect.proposedUsage);
        current = await this.journal.load();
        continue;
      }
      if (!PROVIDER_EFFECTS.has(effect.kind)) throw new RemoteDesktopRunnerError("UNKNOWN_EFFECT", `cannot reconcile ${effect.kind}`);
      const receipt = await this.provider.reconcileEffect(effect, { cleanupOnly });
      await this.#commitEffect(effect, receipt, effect.proposedUsage);
      if (["destroy", "quarantine"].includes(effect.kind)) {
        const outcome = terminalOutcome(current.run, receipt);
        await this.journal.update((value) => ({ ...value, terminalOutcome: outcome }));
      }
      current = await this.journal.load();
    }
  }

  async #providerEffect(kind, operation, run, plan, delta) {
    const request = backendRequest(run, plan, operation, `${run.runId}:${kind}`);
    const effect = await this.#intent(kind, operation, delta, request);
    const receipt = await this.provider.execute({ operation, request });
    return this.#commitEffect(effect, receipt);
  }

  async #recordFailure(error) {
    if (error?.code === "INJECTED_CRASH") throw error;
    await this.journal.update((value) => ({ ...value, failure: value.failure ?? { code: error?.code ?? "RUNNER_FAILURE" } }));
  }

  async #recordPreDestroyEvidenceFailure(error) {
    await this.#recordFailure(error);
    await this.journal.update((value) => ({
      ...value,
      preDestroyEvidenceFailure: value.preDestroyEvidenceFailure ?? {
        code: error?.code ?? "PRE_DESTROY_EVIDENCE_FAILED",
      },
    }));
  }

  async #cleanupSealedValuesIfRequired() {
    if (!this.productionGuard) return this.journal.load();
    const current = await this.journal.load();
    if (current.sealedValueCleanup) return current;
    if (this.productionGuard && current.effects.some(({ kind, status }) => kind === "gui" && status === "ambiguous")) {
      await this.#recordPreDestroyEvidenceFailure(new RemoteDesktopRunnerError("GUEST_PROCESS_RECONCILIATION_REQUIRED", "a controller crash left the guest GUI process identity unavailable; no further guest operation is permitted before quarantine"));
      return this.journal.load();
    }
    const declaredValueRefs = declaredSealedValueRefs(current.run);
    if (JSON.stringify(current.sealedValueInventory) !== JSON.stringify(declaredValueRefs)) {
      const error = new RemoteDesktopRunnerError("SEALED_VALUE_INVENTORY_MISMATCH", "journaled sealed-value inventory differs from the admitted run");
      await this.#recordPreDestroyEvidenceFailure(error);
      return this.journal.load();
    }
    const scenarioWorkFinished = current.scenarioResults.length === current.run.scenarios.length;
    if (!current.cancelRequested && !current.failure && !current.terminalOutcome && !scenarioWorkFinished) return current;
    try {
      const result = await this.gui.cleanupSealedValues(structuredClone(declaredValueRefs));
      const receipt = sealedValueCleanupReceipt(current.run, declaredValueRefs, result);
      await this.journal.update((value) => ({ ...value, sealedValueCleanup: structuredClone(receipt), receipts: [...value.receipts, structuredClone(receipt)] }));
      await this.#checkpoint("after:sealed-value-cleanup");
    } catch (error) {
      if (error?.code === "INJECTED_CRASH") throw error;
      await this.#recordPreDestroyEvidenceFailure(error instanceof RemoteDesktopRunnerError ? error : new RemoteDesktopRunnerError("SEALED_VALUE_CLEANUP_FAILED", "terminal sealed-value absence could not be attested"));
    }
    return this.journal.load();
  }

  async #adoptCommittedEffects() {
    const current = await this.journal.load();
    let run = current.run;
    let terminal = current.terminalOutcome;
    let results = [...current.scenarioResults];
    let evidence = current.evidence;
    let archiveConvergence = current.archiveConvergence;
    let taskPreparation = current.taskPreparation ?? null;
    let failure = current.failure;
    for (const effect of current.effects.filter(({ status }) => status === "committed")) {
      if (effect.identityDigest !== current.identityDigest) throw new RemoteDesktopRunnerError("EFFECT_IDENTITY_MISMATCH", "committed effect belongs to another run identity");
      if (effect.kind === "gui" && !results.some(({ scenarioId }) => scenarioId === effect.receipt.scenarioId)) {
        results.push(structuredClone(effect.receipt));
        if (effect.receipt.outcome !== "passed") failure ??= { code: effect.receipt.failure?.code ?? "SCENARIO_FAILED", scenarioId: effect.receipt.scenarioId };
      }
      if (effect.kind === "evidence" && !evidence) evidence = structuredClone(effect.receipt);
      if (effect.kind === "archive-convergence" && !archiveConvergence) {
        archiveConvergence = structuredClone(effect.receipt);
        if (effect.receipt.outcome !== "passed") failure ??= { code: "ARCHIVE_PROJECTION_STALE" };
      }
      if (effect.kind === "task-preparation") {
        if (taskPreparation && contentDigest(taskPreparation) !== contentDigest(effect.receipt)) {
          throw new RemoteDesktopRunnerError("TASK_PREPARATION_RECEIPT_MISMATCH", "committed guest task receipt differs from the journaled preparation");
        }
        taskPreparation ??= structuredClone(effect.receipt);
        if (run.scenarios.some(({ task }) => /^task-slot-[0-9a-f]{64}$/u.test(task.taskId))) run = this.taskPreparer.materialize(run, effect.receipt);
      }
      if (["destroy", "quarantine"].includes(effect.kind) && !terminal) terminal = terminalOutcome(run, effect.receipt);
      if (effect.kind === "provision" && run.state === "admitted") {
        if (effect.receipt?.created === true) run = transitionRemoteDesktopRun(run, "running");
        else if (effect.receipt?.destroyed === true || effect.receipt?.quarantined === true) {
          run = transitionRemoteDesktopRun(run, "cleaning");
          terminal = terminalOutcome(run, effect.receipt);
        } else throw new RemoteDesktopRunnerError("RECONCILIATION_REQUIRED", "provision reconciliation did not prove creation, destruction, or quarantine");
      }
    }
    if (contentDigest({ run, terminal, results, taskPreparation, archiveConvergence, evidence, failure }) !== contentDigest({ run: current.run, terminal: current.terminalOutcome, results: current.scenarioResults, taskPreparation: current.taskPreparation ?? null, archiveConvergence: current.archiveConvergence, evidence: current.evidence, failure: current.failure })) {
      await this.journal.update((value) => ({ ...value, run, terminalOutcome: terminal, scenarioResults: results, taskPreparation, archiveConvergence, evidence, failure }));
    }
  }

  async #drive(_originalRun, plan) {
    await this.#enforceRunDeadline();
    try { await this.#reconcilePending(); } catch (error) { await this.#recordFailure(error); }
    await this.#adoptCommittedEffects();
    await this.#enforceRunDeadline();
    await this.#cleanupSealedValuesIfRequired();
    let current = await this.journal.load();
    if (["succeeded", "failed", "quarantined"].includes(current.run.state)) return current;
    const preProvisionAbort = await this.#abortBeforeProvisionIfAbsent();
    if (preProvisionAbort) {
      const cleaned = await this.#cleanupSealedValuesIfRequired();
      if (!cleaned.sealedValueCleanup) throw new RemoteDesktopRunnerError("SEALED_VALUE_CLEANUP_FAILED", "pre-provision abort did not attest sealed-value absence");
      return cleaned;
    }

    if (current.run.state === "admitted" && !current.failure && !current.cancelRequested && !current.effects.some(({ kind, status }) => kind === "provision" && status === "committed")) {
      try {
        await this.#enforceRunDeadline();
        current = await this.journal.load();
        if (current.failure || current.cancelRequested) {
          const aborted = await this.#abortBeforeProvisionIfAbsent();
          if (aborted) {
            const cleaned = await this.#cleanupSealedValuesIfRequired();
            if (!cleaned.sealedValueCleanup) throw new RemoteDesktopRunnerError("SEALED_VALUE_CLEANUP_FAILED", "pre-provision abort did not attest sealed-value absence");
            return cleaned;
          }
          return current;
        }
        await this.#providerEffect("provision", "create", current.run, plan, plan.operationUsage.provision);
        current = await this.journal.load();
        await this.#setRun(transitionRemoteDesktopRun(current.run, "running"));
      } catch (error) { await this.#recordFailure(error); }
    }

    const postProvisionAbort = await this.#abortBeforeProvisionIfAbsent();
    if (postProvisionAbort) {
      const cleaned = await this.#cleanupSealedValuesIfRequired();
      if (!cleaned.sealedValueCleanup) throw new RemoteDesktopRunnerError("SEALED_VALUE_CLEANUP_FAILED", "pre-provision abort did not attest sealed-value absence");
      return cleaned;
    }
    current = await this.journal.load();
    if (this.taskPreparer && current.run.state === "running" && !current.failure && !current.cancelRequested && !current.taskPreparation &&
        !current.effects.some(({ kind, status }) => kind === "task-preparation" && status === "committed")) {
      try {
        await this.#enforceRunDeadline();
        current = await this.journal.load();
        if (!current.failure && !current.cancelRequested) {
          const effect = await this.#intent("task-preparation", "guest-create-empty-task", ZERO(), { intentDigest: this.taskPreparer.intentDigest });
          const receipt = await this.taskPreparer.execute({ intentDigest: this.taskPreparer.intentDigest });
          await this.#commitEffect(effect, receipt, ZERO());
          await this.journal.update((value) => ({
            ...value,
            taskPreparation: structuredClone(receipt),
            run: this.taskPreparer.materialize(value.run, receipt),
          }));
          await this.#checkpoint("after:task-preparation");
        }
      } catch (error) { await this.#recordFailure(error); }
    }
    current = await this.journal.load();
    if (current.run.state === "running" && !current.failure && !current.cancelRequested) {
      for (const scenario of current.run.scenarios) {
        await this.#enforceRunDeadline();
        current = await this.journal.load();
        if (current.scenarioResults.some(({ scenarioId }) => scenarioId === scenario.scenarioId) || current.failure || current.cancelRequested) continue;
        try {
          const effect = await this.#intent("gui", `scenario:${scenario.scenarioId}`, plan.scenarioUsage[scenario.scenarioId], { scenarioId: scenario.scenarioId });
          const result = await this.gui.runScenario(structuredClone(scenario), { runDeadlineAt: current.productionAdmission?.runDeadlineAt ?? null });
          await this.#commitEffect(effect, result);
          await this.journal.update((value) => ({ ...value, scenarioResults: [...value.scenarioResults, structuredClone(result)], failure: result.outcome === "passed" ? value.failure : value.failure ?? { code: result.failure?.code ?? "SCENARIO_FAILED", scenarioId: result.scenarioId } }));
        } catch (error) { await this.#recordFailure(error); }
      }
    }

    await this.#enforceRunDeadline();
    await this.#cleanupSealedValuesIfRequired();
    current = await this.journal.load();
    if (current.run.state === "running" && !current.cancelRequested && current.scenarioResults.length === current.run.scenarios.length && !current.archiveConvergence && !current.effects.some(({ kind, status }) => kind === "archive-convergence" && status === "intent")) {
      try {
        const expectedThreads = current.run.scenarios.map((scenario) => ({ threadId: scenario.task.taskId, title: scenario.scenarioId }));
        const request = { schemaVersion: 1, runId: current.run.runId, startedAt: new Date(this.clock.now()).toISOString(), expectedThreads, policy: structuredClone(plan.archiveConvergence.policy) };
        const effect = await this.#intent("archive-convergence", "archive-restart-observe", plan.archiveConvergence.operationUsage, request);
        const archiveOptions = current.productionAdmission?.runDeadlineAt ? { hardDeadlineAt: current.productionAdmission.runDeadlineAt } : {};
        const receipt = await this.archiveProjection.execute(structuredClone(request), archiveOptions);
        await this.#commitEffect(effect, receipt);
        await this.journal.update((value) => ({ ...value, archiveConvergence: structuredClone(receipt), failure: receipt.outcome === "passed" ? value.failure : value.failure ?? { code: "ARCHIVE_PROJECTION_STALE" } }));
      } catch (error) { await this.#recordFailure(error); }
    }

    await this.#enforceRunDeadline();
    current = await this.journal.load();
    if (!current.evidenceCollection && !current.terminalOutcome) {
      if (this.productionGuard && (current.cancelRequested || current.preDestroyEvidenceFailure)) {
        if (!current.preDestroyEvidenceFailure) await this.#recordPreDestroyEvidenceFailure(new RemoteDesktopRunnerError("CLEANUP_ONLY_RECOVERY", "cleanup-only recovery cannot start new guest capture or diagnostic work"));
        current = await this.journal.load();
      } else {
      try {
        const collected = this.collector ? await this.collector.collect({ run: current.run, scenarioResults: current.scenarioResults, archiveConvergence: current.archiveConvergence }) : { screenshots: plan.evidence.screenshots, recordings: plan.evidence.recordings, diagnostics: plan.evidence.diagnostics };
        await this.journal.update((value) => ({ ...value, evidenceCollection: serializeEvidenceCollection(collected) }));
        await this.#checkpoint("after:evidence-collection");
      } catch (error) {
        if (this.productionGuard) await this.#recordPreDestroyEvidenceFailure(error);
        else await this.#recordFailure(error);
      }
      }
    }

    current = await this.journal.load();
    if (this.productionGuard && current.evidenceCollection && !current.preDestroyInventoryDraft && !current.preDestroyEvidenceFailure && !current.terminalOutcome) {
      try {
        const receipt = await this.productionGuard.prepareBeforeDestroy({
          run: current.run,
          currentUsage: current.usage,
          plan,
          providerReceipt: current.effects.find(({ kind, status }) => kind === "provision" && status === "committed")?.receipt ?? null,
          taskPreparation: current.taskPreparation,
          scenarioResults: current.scenarioResults,
          archiveConvergence: current.archiveConvergence,
          sealedValueCleanup: current.sealedValueCleanup,
          evidenceCollection: deserializeEvidenceCollection(current.evidenceCollection),
        });
        await this.journal.update((value) => ({ ...value, preDestroyInventoryDraft: structuredClone(receipt) }));
        await this.#checkpoint("after:pre-destroy-evidence");
      } catch (error) { await this.#recordPreDestroyEvidenceFailure(error); }
    }

    current = await this.journal.load();
    if (this.productionGuard && current.preDestroyInventoryDraft && !current.preDestroyVerification && !current.preDestroyEvidenceFailure && !current.terminalOutcome) {
      try {
        const receipt = await this.productionGuard.verifyBeforeDestroy({
          run: current.run,
          draft: current.preDestroyInventoryDraft,
          archiveConvergence: current.archiveConvergence,
        });
        await this.journal.update((value) => ({ ...value, preDestroyVerification: structuredClone(receipt) }));
        await this.#checkpoint("after:pre-destroy-verification");
      } catch (error) { await this.#recordPreDestroyEvidenceFailure(error); }
    }

    current = await this.journal.load();
    if (!["cleaning", "succeeded", "failed", "quarantined"].includes(current.run.state)) {
      await this.#setRun(transitionRemoteDesktopRun(current.run, "cleaning"));
    }

    current = await this.journal.load();
    if (!current.terminalOutcome) {
      const evidenceUnsafe = this.productionGuard && (
        current.preDestroyEvidenceFailure || !current.preDestroyInventoryDraft || !current.preDestroyVerification || !current.sealedValueCleanup
      );
      if (evidenceUnsafe) {
        try {
          const receipt = await this.#providerEffect("quarantine", "quarantine", current.run, plan, plan.operationUsage.quarantine);
          const outcome = terminalOutcome(current.run, receipt);
          await this.journal.update((value) => ({ ...value, terminalOutcome: outcome }));
        } catch (error) {
          await this.#recordFailure(error);
          throw new RemoteDesktopRunnerError("CLEANUP_UNATTESTED", "pre-destroy evidence failed and identity-preserving quarantine was not attested", { cause: error.code });
        }
      } else {
        try {
          const receipt = await this.#providerEffect("destroy", "destroy", current.run, plan, plan.operationUsage.cleanup);
          const outcome = terminalOutcome(current.run, receipt);
          await this.journal.update((value) => ({ ...value, terminalOutcome: outcome }));
        } catch (error) {
          await this.#recordFailure(error);
          current = await this.journal.load();
          if (!current.effects.some(({ kind, status }) => kind === "destroy" && status === "intent")) {
            try {
              const receipt = await this.#providerEffect("quarantine", "quarantine", current.run, plan, plan.operationUsage.quarantine);
              const outcome = terminalOutcome(current.run, receipt);
              await this.journal.update((value) => ({ ...value, terminalOutcome: outcome }));
            } catch (quarantineError) { throw new RemoteDesktopRunnerError("CLEANUP_UNATTESTED", "neither exact destruction nor identity-preserving quarantine was attested", { cause: quarantineError.code }); }
          }
        }
      }
    }

    current = await this.journal.load();
    if (!current.terminalOutcome) throw new RemoteDesktopRunnerError("CLEANUP_RECONCILIATION_REQUIRED", "cleanup remains ambiguous; resume with provider reconciliation");

    if (this.productionGuard && current.terminalOutcome.outcome === "destroyed" && !current.postDestroyAttestation) {
      try {
        const receipt = await this.productionGuard.attestAfterDestroy({
          run: current.run,
          terminalOutcome: current.terminalOutcome,
          draft: current.preDestroyInventoryDraft,
          preDestroyVerification: current.preDestroyVerification,
        });
        await this.journal.update((value) => ({ ...value, postDestroyAttestation: structuredClone(receipt) }));
        await this.#checkpoint("after:post-destroy-attestation");
      } catch (error) { await this.#recordFailure(error); }
    }

    current = await this.journal.load();
    const mayFinalizeEvidence = !this.productionGuard || current.terminalOutcome.outcome === "quarantined" || current.postDestroyAttestation;
    if (mayFinalizeEvidence && !current.evidence && !current.effects.some(({ kind, status }) => kind === "evidence" && status === "committed")) {
      try {
        if (!current.evidenceCollection) throw new RemoteDesktopRunnerError("EVIDENCE_NOT_COLLECTED", "checkpoint evidence was not collected before destructive cleanup");
        const collected = deserializeEvidenceCollection(current.evidenceCollection);
        const mapped = scenarioEvidence(current.scenarioResults);
        const evidenceInput = {
          bundleDirectory: plan.evidence.bundleDirectory, run: current.run, currentUsage: current.usage,
          proposedOperationalUsage: plan.evidence.proposedOperationalUsage,
          scenarioMetadata: mapped.scenarioMetadata, actionTimeline: mapped.actionTimeline,
          assertionOutcomes: mapped.assertionOutcomes, cleanupAttestation: cleanupAttestation(current.run, current.terminalOutcome),
          screenshots: collected.screenshots ?? plan.evidence.screenshots,
          recordings: collected.recordings ?? plan.evidence.recordings,
          diagnostics: collected.diagnostics ?? plan.evidence.diagnostics,
        };
        const delta = evidencePlannedUsage({ ...plan.evidence, screenshots: evidenceInput.screenshots, recordings: evidenceInput.recordings, diagnostics: evidenceInput.diagnostics });
        const effect = await this.#intent("evidence", "sanitize-and-finalize", delta, { bundleDirectory: plan.evidence.bundleDirectory });
        const built = await createRemoteDesktopEvidenceBundleV1(evidenceInput);
        const verified = await verifyRemoteDesktopEvidenceBundleV1(plan.evidence.bundleDirectory, current.run);
        await this.#commitEffect(effect, { bundleDirectory: built.bundleDirectory, inventory: verified.inventory });
        await this.journal.update((value) => ({ ...value, evidence: { bundleDirectory: built.bundleDirectory, inventory: verified.inventory } }));
      } catch (error) { await this.#recordFailure(error); }
    }

    current = await this.journal.load();
    if (this.productionGuard && current.terminalOutcome.outcome === "destroyed" && current.evidence && current.postDestroyAttestation && !current.finalEvidenceAttestation) {
      try {
        const receipt = await this.productionGuard.attestFinalEvidence({
          run: current.run,
          evidence: current.evidence,
          draft: current.preDestroyInventoryDraft,
          postDestroyAttestation: current.postDestroyAttestation,
          sealedValueCleanup: current.sealedValueCleanup,
        });
        await this.journal.update((value) => ({ ...value, finalEvidenceAttestation: structuredClone(receipt) }));
        await this.#checkpoint("after:final-evidence-attestation");
      } catch (error) { await this.#recordFailure(error); }
    }

    current = await this.journal.load();
    let terminalState;
    if (current.terminalOutcome.outcome === "quarantined") terminalState = "quarantined";
    else {
      const productionEvidenceComplete = !this.productionGuard || (
        current.preDestroyInventoryDraft && current.preDestroyVerification &&
        current.postDestroyAttestation && current.finalEvidenceAttestation && current.sealedValueCleanup
      );
      terminalState = !current.failure && current.evidence && productionEvidenceComplete && current.archiveConvergence?.outcome === "passed" && current.scenarioResults.length === current.run.scenarios.length && current.scenarioResults.every(({ outcome }) => outcome === "passed") ? "succeeded" : "failed";
    }
    const terminal = transitionRemoteDesktopRun(current.run, terminalState, { terminalOutcome: current.terminalOutcome });
    await this.#setRun(terminal);
    return this.journal.load();
  }
}
