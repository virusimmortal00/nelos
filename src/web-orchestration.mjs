import { createHash } from "node:crypto";

import {
  formatResultEnvelope,
  parseResultEnvelope,
} from "./work-result.mjs";

export const WEB_ORCHESTRATION_SCHEMA_VERSION = 1;
export const WORK_UNIT_SPEC_SCHEMA_VERSION = 1;
export const TASK_BINDING_SCHEMA_VERSION = 1;
export const LIVE_OBSERVATION_SCHEMA_VERSION = 1;
export const ACTION_RECEIPT_SCHEMA_VERSION = 1;

export const ORCHESTRATION_PHASES = Object.freeze([
  "pending",
  "ready",
  "active",
  "attention",
  "settled",
]);
export const ORCHESTRATION_ACTION_TYPES = Object.freeze([
  "launch",
  "inspect-result",
  "follow-up",
  "escalate",
]);

const WORK_UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ACTION_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const MAX_ACTION_RECEIPTS = 100;
const MAX_ATTEMPTS = 10;
const MAX_CAPABILITIES = 8;
const MEMBER_KINDS = new Set(["spinoff", "joined-subagent"]);
const CAPABILITIES = new Set([
  "observe",
  "read-result",
  "follow-up",
  "archive",
]);
const BINDING_STATES = new Set(["unbound", "launch-pending", "bound"]);
const LIFECYCLES = new Set([
  "running",
  "waiting",
  "completed",
  "failed",
  "unavailable",
  "archived",
]);
const RECOVERY_POLICIES = new Set(["queen-review", "follow-up"]);
const TASK_SCOPED_ACTIONS = new Set(["inspect-result", "follow-up"]);

const INPUT_FIELDS = new Set([
  "schemaVersion",
  "spec",
  "binding",
  "observation",
  "resultEnvelope",
  "actionReceipts",
]);
const SPEC_FIELDS = new Set([
  "schemaVersion",
  "workUnitId",
  "specRevision",
  "attempt",
  "memberKind",
  "capabilities",
  "policy",
]);
const POLICY_FIELDS = new Set([
  "maxAttempts",
  "onBlocked",
  "onFailure",
]);
const BINDING_FIELDS = new Set([
  "schemaVersion",
  "workUnitId",
  "specRevision",
  "state",
  "memberThreadId",
  "launchActionId",
]);
const OBSERVATION_FIELDS = new Set([
  "schemaVersion",
  "workUnitId",
  "specRevision",
  "memberThreadId",
  "lifecycle",
  "latestTurnId",
  "sourceTurnId",
]);
const RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "actionId",
  "actionType",
  "workUnitId",
  "specRevision",
  "attempt",
  "memberThreadId",
  "sourceTurnId",
]);

class ContractError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function reject(reason) {
  throw new ContractError(reason);
}

function assertRecord(value, fields, reason) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(reason);
  const keys = Object.keys(value);
  if (
    keys.some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))
  ) {
    reject(reason);
  }
  return value;
}

function assertPositiveInteger(value, reason, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) reject(reason);
  return value;
}

function assertIdentifier(value, pattern, reason) {
  if (typeof value !== "string" || !pattern.test(value)) reject(reason);
  return value;
}

function assertNullableIdentifier(value, pattern, reason) {
  return value === null ? null : assertIdentifier(value, pattern, reason);
}

function validateSpec(value) {
  const spec = assertRecord(value, SPEC_FIELDS, "malformed_spec");
  if (spec.schemaVersion !== WORK_UNIT_SPEC_SCHEMA_VERSION) {
    reject("malformed_spec");
  }
  const workUnitId = assertIdentifier(
    spec.workUnitId,
    WORK_UNIT_ID_PATTERN,
    "malformed_spec",
  );
  const specRevision = assertPositiveInteger(
    spec.specRevision,
    "malformed_spec",
  );
  const attempt = assertPositiveInteger(
    spec.attempt,
    "malformed_spec",
    MAX_ATTEMPTS,
  );
  if (!MEMBER_KINDS.has(spec.memberKind)) reject("malformed_spec");
  if (
    !Array.isArray(spec.capabilities) ||
    spec.capabilities.length === 0 ||
    spec.capabilities.length > MAX_CAPABILITIES
  ) {
    reject("malformed_spec");
  }
  const capabilitySet = new Set();
  for (let index = 0; index < spec.capabilities.length; index += 1) {
    if (!Object.hasOwn(spec.capabilities, index)) reject("malformed_spec");
    const capability = spec.capabilities[index];
    if (!CAPABILITIES.has(capability) || capabilitySet.has(capability)) {
      reject("malformed_spec");
    }
    capabilitySet.add(capability);
  }
  if (!capabilitySet.has("observe")) reject("malformed_spec");
  if (
    spec.memberKind === "joined-subagent" &&
    (capabilitySet.size !== 1 || !capabilitySet.has("observe"))
  ) {
    reject("malformed_spec");
  }

  const policy = assertRecord(spec.policy, POLICY_FIELDS, "malformed_spec");
  const maxAttempts = assertPositiveInteger(
    policy.maxAttempts,
    "malformed_spec",
    MAX_ATTEMPTS,
  );
  if (
    attempt > maxAttempts ||
    !RECOVERY_POLICIES.has(policy.onBlocked) ||
    !RECOVERY_POLICIES.has(policy.onFailure)
  ) {
    reject("malformed_spec");
  }

  return {
    schemaVersion: WORK_UNIT_SPEC_SCHEMA_VERSION,
    workUnitId,
    specRevision,
    attempt,
    memberKind: spec.memberKind,
    capabilities: capabilitySet,
    policy: {
      maxAttempts,
      onBlocked: policy.onBlocked,
      onFailure: policy.onFailure,
    },
  };
}

function validateBinding(value) {
  const binding = assertRecord(value, BINDING_FIELDS, "malformed_binding");
  if (binding.schemaVersion !== TASK_BINDING_SCHEMA_VERSION) {
    reject("malformed_binding");
  }
  const normalized = {
    schemaVersion: TASK_BINDING_SCHEMA_VERSION,
    workUnitId: assertIdentifier(
      binding.workUnitId,
      WORK_UNIT_ID_PATTERN,
      "malformed_binding",
    ),
    specRevision: assertPositiveInteger(
      binding.specRevision,
      "malformed_binding",
    ),
    state: binding.state,
    memberThreadId: assertNullableIdentifier(
      binding.memberThreadId,
      TASK_ID_PATTERN,
      "malformed_binding",
    ),
    launchActionId: assertNullableIdentifier(
      binding.launchActionId,
      ACTION_ID_PATTERN,
      "malformed_binding",
    ),
  };
  if (!BINDING_STATES.has(normalized.state)) reject("malformed_binding");

  const validShape =
    (normalized.state === "unbound" &&
      normalized.memberThreadId === null &&
      normalized.launchActionId === null) ||
    (normalized.state === "launch-pending" &&
      normalized.memberThreadId === null &&
      normalized.launchActionId !== null) ||
    (normalized.state === "bound" &&
      normalized.memberThreadId !== null &&
      normalized.launchActionId !== null);
  if (!validShape) reject("malformed_binding");
  return normalized;
}

function validateObservation(value) {
  if (value === null) return null;
  const observation = assertRecord(
    value,
    OBSERVATION_FIELDS,
    "malformed_observation",
  );
  if (observation.schemaVersion !== LIVE_OBSERVATION_SCHEMA_VERSION) {
    reject("malformed_observation");
  }
  const normalized = {
    schemaVersion: LIVE_OBSERVATION_SCHEMA_VERSION,
    workUnitId: assertIdentifier(
      observation.workUnitId,
      WORK_UNIT_ID_PATTERN,
      "malformed_observation",
    ),
    specRevision: assertPositiveInteger(
      observation.specRevision,
      "malformed_observation",
    ),
    memberThreadId: assertIdentifier(
      observation.memberThreadId,
      TASK_ID_PATTERN,
      "malformed_observation",
    ),
    lifecycle: observation.lifecycle,
    latestTurnId: assertNullableIdentifier(
      observation.latestTurnId,
      TASK_ID_PATTERN,
      "malformed_observation",
    ),
    sourceTurnId: assertNullableIdentifier(
      observation.sourceTurnId,
      TASK_ID_PATTERN,
      "malformed_observation",
    ),
  };
  if (
    typeof normalized.lifecycle !== "string" ||
    !/^[a-z][a-z-]{0,31}$/u.test(normalized.lifecycle)
  ) {
    reject("malformed_observation");
  }
  if (normalized.sourceTurnId !== null && normalized.latestTurnId === null) {
    reject("malformed_observation");
  }
  if (
    ["completed", "failed", "running"].includes(normalized.lifecycle) &&
    normalized.latestTurnId === null
  ) {
    reject("malformed_observation");
  }
  if (
    normalized.lifecycle === "completed" &&
    normalized.sourceTurnId !== normalized.latestTurnId
  ) {
    reject("malformed_observation");
  }
  if (
    ["unavailable", "archived"].includes(normalized.lifecycle) &&
    (normalized.latestTurnId !== null || normalized.sourceTurnId !== null)
  ) {
    reject("malformed_observation");
  }
  return normalized;
}

function normalizeResultEnvelope(value) {
  if (value === null) return null;
  try {
    const parsed = parseResultEnvelope(formatResultEnvelope(value));
    if (parsed.format !== "envelope") reject("malformed_result");
    return parsed.result;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    reject("malformed_result");
  }
}

function encodeIdentity(value) {
  return encodeURIComponent(value);
}

function actionIdFor({
  actionType,
  workUnitId,
  specRevision,
  attempt,
  memberThreadId,
  sourceTurnId,
}) {
  const parts = [
    "web-orchestration-v1",
    encodeIdentity(workUnitId),
    `revision-${specRevision}`,
    `attempt-${attempt}`,
    actionType,
  ];
  if (memberThreadId !== null) {
    const context = createHash("sha256")
      .update(JSON.stringify([memberThreadId, sourceTurnId]), "utf8")
      .digest("base64url");
    parts.push(`context-${context}`);
  }
  return parts.join("/");
}

function validateReceipts(value) {
  if (!Array.isArray(value) || value.length > MAX_ACTION_RECEIPTS) {
    reject("malformed_receipt");
  }
  const actionIds = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) reject("malformed_receipt");
    const receipt = assertRecord(value[index], RECEIPT_FIELDS, "malformed_receipt");
    if (receipt.schemaVersion !== ACTION_RECEIPT_SCHEMA_VERSION) {
      reject("malformed_receipt");
    }
    const normalized = {
      actionType: receipt.actionType,
      workUnitId: assertIdentifier(
        receipt.workUnitId,
        WORK_UNIT_ID_PATTERN,
        "malformed_receipt",
      ),
      specRevision: assertPositiveInteger(
        receipt.specRevision,
        "malformed_receipt",
      ),
      attempt: assertPositiveInteger(
        receipt.attempt,
        "malformed_receipt",
        MAX_ATTEMPTS,
      ),
      memberThreadId: assertNullableIdentifier(
        receipt.memberThreadId,
        TASK_ID_PATTERN,
        "malformed_receipt",
      ),
      sourceTurnId: assertNullableIdentifier(
        receipt.sourceTurnId,
        TASK_ID_PATTERN,
        "malformed_receipt",
      ),
    };
    if (!ORCHESTRATION_ACTION_TYPES.includes(normalized.actionType)) {
      reject("malformed_receipt");
    }
    const taskContextRequired = normalized.actionType !== "launch";
    if (
      taskContextRequired !== (normalized.memberThreadId !== null) ||
      taskContextRequired !== (normalized.sourceTurnId !== null)
    ) {
      reject("malformed_receipt");
    }
    const expectedId = actionIdFor(normalized);
    if (
      assertIdentifier(receipt.actionId, ACTION_ID_PATTERN, "malformed_receipt") !==
        expectedId ||
      actionIds.has(expectedId)
    ) {
      reject("malformed_receipt");
    }
    actionIds.add(expectedId);
  }
  return actionIds;
}

function identityFromInput(input) {
  const spec = input?.spec;
  return {
    workUnitId:
      typeof spec?.workUnitId === "string" &&
      WORK_UNIT_ID_PATTERN.test(spec.workUnitId)
        ? spec.workUnitId
        : null,
    specRevision:
      Number.isSafeInteger(spec?.specRevision) && spec.specRevision > 0
        ? spec.specRevision
        : null,
    attempt:
      Number.isSafeInteger(spec?.attempt) && spec.attempt > 0
        ? spec.attempt
        : null,
  };
}

function derivedState(
  { workUnitId, specRevision, attempt },
  {
    workOutcome = "unknown",
    orchestrationPhase,
    attentionReason = null,
    proposedActions = [],
  },
) {
  return {
    schemaVersion: WEB_ORCHESTRATION_SCHEMA_VERSION,
    workUnitId,
    specRevision,
    attempt,
    workOutcome,
    orchestrationPhase,
    attentionRequired: attentionReason !== null,
    attentionReason,
    proposedActions,
  };
}

function closedState(identity, attentionReason) {
  return derivedState(identity, {
    orchestrationPhase: "attention",
    attentionReason,
  });
}

function closedOutcomeState(identity, workOutcome, attentionReason) {
  return derivedState(identity, {
    workOutcome,
    orchestrationPhase: "attention",
    attentionReason,
  });
}

function proposedAction(spec, binding, observation, actionType) {
  const taskScoped = TASK_SCOPED_ACTIONS.has(actionType);
  const hasTaskContext = actionType !== "launch";
  const memberThreadId = hasTaskContext ? binding.memberThreadId : null;
  const sourceTurnId = hasTaskContext ? observation.latestTurnId : null;
  if (taskScoped && (memberThreadId === null || sourceTurnId === null)) {
    return null;
  }
  const actionId = actionIdFor({
    actionType,
    workUnitId: spec.workUnitId,
    specRevision: spec.specRevision,
    attempt: spec.attempt,
    memberThreadId,
    sourceTurnId,
  });
  return {
    schemaVersion: WEB_ORCHESTRATION_SCHEMA_VERSION,
    actionId,
    type: actionType,
    scope: taskScoped ? "task" : actionType === "launch" ? "work-unit" : "queen",
    workUnitId: spec.workUnitId,
    specRevision: spec.specRevision,
    attempt: spec.attempt,
    requiredCapability:
      actionType === "inspect-result"
        ? "read-result"
        : actionType === "follow-up"
          ? "follow-up"
          : null,
    preconditions: {
      expectedSpecRevision: spec.specRevision,
      expectedBindingState: actionType === "launch" ? "unbound" : "bound",
      expectedMemberThreadId: memberThreadId,
      expectedSourceTurnId: sourceTurnId,
    },
  };
}

function actionUnlessReceived(spec, binding, observation, actionType, receiptIds) {
  const action = proposedAction(spec, binding, observation, actionType);
  return action && !receiptIds.has(action.actionId) ? [action] : [];
}

function attentionWithRecovery(
  identity,
  spec,
  binding,
  observation,
  receiptIds,
  workOutcome,
  attentionReason,
  policy,
) {
  if (policy === "follow-up" && spec.attempt < spec.policy.maxAttempts) {
    if (!spec.capabilities.has("follow-up")) {
      return closedOutcomeState(
        identity,
        workOutcome,
        "unsupported_capability",
      );
    }
    const actions = actionUnlessReceived(
      spec,
      binding,
      observation,
      "follow-up",
      receiptIds,
    );
    if (actions.length === 0 && observation.latestTurnId === null) {
      return closedState(identity, "unbound_task");
    }
    return derivedState(identity, {
      workOutcome,
      orchestrationPhase: "attention",
      attentionReason,
      proposedActions: actions,
    });
  }

  const exhausted = policy === "follow-up" && spec.attempt >= spec.policy.maxAttempts;
  return derivedState(identity, {
    workOutcome,
    orchestrationPhase: "attention",
    attentionReason: exhausted ? "attempts_exhausted" : attentionReason,
    proposedActions: actionUnlessReceived(
      spec,
      binding,
      observation,
      "escalate",
      receiptIds,
    ),
  });
}

/**
 * Reconcile one WorkUnitSpecV1 projection. The input must contain exactly:
 * `{schemaVersion, spec, binding, observation, resultEnvelope, actionReceipts}`.
 * Null is explicit for an absent observation/result. Contract errors become a
 * deterministic attention state and never produce an action.
 */
export function reduceWebOrchestration(input = null) {
  const fallbackIdentity = identityFromInput(input);
  let spec;
  let binding;
  let observation;
  let resultEnvelope;
  let receiptIds;
  try {
    const contract = assertRecord(input, INPUT_FIELDS, "malformed_input");
    if (contract.schemaVersion !== WEB_ORCHESTRATION_SCHEMA_VERSION) {
      reject("malformed_input");
    }
    spec = validateSpec(contract.spec);
    binding = validateBinding(contract.binding);
    observation = validateObservation(contract.observation);
    resultEnvelope = normalizeResultEnvelope(contract.resultEnvelope);
    receiptIds = validateReceipts(contract.actionReceipts);
  } catch (error) {
    return closedState(
      fallbackIdentity,
      error instanceof ContractError ? error.reason : "malformed_input",
    );
  }

  const identity = {
    workUnitId: spec.workUnitId,
    specRevision: spec.specRevision,
    attempt: spec.attempt,
  };
  if (
    binding.workUnitId !== spec.workUnitId ||
    binding.specRevision !== spec.specRevision
  ) {
    return closedState(identity, "stale_binding");
  }

  if (binding.state === "unbound") {
    if (observation !== null) return closedState(identity, "stale_observation");
    if (resultEnvelope !== null) return closedState(identity, "stale_result");
    const actions = actionUnlessReceived(
      spec,
      binding,
      observation,
      "launch",
      receiptIds,
    );
    return actions.length > 0
      ? derivedState(identity, {
          orchestrationPhase: "ready",
          proposedActions: actions,
        })
      : closedState(identity, "launch_receipt_unreconciled");
  }

  if (binding.state === "launch-pending") {
    return closedState(identity, "ambiguous_launch");
  }

  if (observation === null) return closedState(identity, "unavailable");
  if (
    observation.workUnitId !== spec.workUnitId ||
    observation.specRevision !== spec.specRevision ||
    observation.memberThreadId !== binding.memberThreadId
  ) {
    return closedState(identity, "stale_observation");
  }

  if (resultEnvelope !== null) {
    if (
      resultEnvelope.workUnitId !== spec.workUnitId ||
      resultEnvelope.specRevision !== spec.specRevision ||
      resultEnvelope.attempt !== spec.attempt ||
      observation.sourceTurnId === null
    ) {
      return closedState(identity, "stale_result");
    }
  }

  if (!LIFECYCLES.has(observation.lifecycle)) {
    return closedState(identity, "unknown_lifecycle");
  }
  if (observation.lifecycle === "unavailable") {
    return closedState(identity, "unavailable");
  }
  if (observation.lifecycle === "archived") {
    return closedState(identity, "archived");
  }
  if (observation.lifecycle === "running") {
    if (resultEnvelope !== null) return closedState(identity, "stale_result");
    return derivedState(identity, { orchestrationPhase: "active" });
  }
  if (observation.lifecycle === "waiting") {
    if (resultEnvelope !== null) return closedState(identity, "stale_result");
    return derivedState(identity, { orchestrationPhase: "pending" });
  }
  if (observation.lifecycle === "failed") {
    return attentionWithRecovery(
      identity,
      spec,
      binding,
      observation,
      receiptIds,
      "unknown",
      "turn_failed",
      spec.policy.onFailure,
    );
  }

  if (resultEnvelope === null) {
    if (!spec.capabilities.has("read-result")) {
      return closedState(identity, "unsupported_capability");
    }
    return derivedState(identity, {
      orchestrationPhase: "attention",
      attentionReason: "missing_result",
      proposedActions: actionUnlessReceived(
        spec,
        binding,
        observation,
        "inspect-result",
        receiptIds,
      ),
    });
  }

  if (resultEnvelope.outcome === "succeeded") {
    return derivedState(identity, {
      workOutcome: "succeeded",
      orchestrationPhase: "settled",
    });
  }
  const blocked = resultEnvelope.outcome === "blocked";
  return attentionWithRecovery(
    identity,
    spec,
    binding,
    observation,
    receiptIds,
    resultEnvelope.outcome,
    resultEnvelope.outcome,
    blocked ? spec.policy.onBlocked : spec.policy.onFailure,
  );
}

export const reconcileWorkUnit = reduceWebOrchestration;
