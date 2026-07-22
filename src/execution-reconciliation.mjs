import { validateWorkUnitSpecV1 } from "./execution-store.mjs";
import {
  ACTION_RECEIPT_SCHEMA_VERSION,
  LIVE_OBSERVATION_SCHEMA_VERSION,
  TASK_BINDING_SCHEMA_VERSION,
  WEB_ORCHESTRATION_SCHEMA_VERSION,
  WORK_UNIT_SPEC_SCHEMA_VERSION,
  reduceWebOrchestration,
} from "./web-orchestration.mjs";

export const EXECUTION_RECONCILIATION_SCHEMA_VERSION = 1;

/**
 * Project one validated private execution record into the pure reducer contract.
 * Live observations, result envelopes, and receipts remain explicit inputs; this
 * function performs no app-server request or filesystem mutation.
 */
export function reconcileExecutionRecord(
  executionRecord,
  {
    observation = null,
    resultEnvelope = null,
    actionReceipts = [],
  } = {},
) {
  const record = validateWorkUnitSpecV1(executionRecord);
  return reduceWebOrchestration({
    schemaVersion: WEB_ORCHESTRATION_SCHEMA_VERSION,
    spec: {
      schemaVersion: WORK_UNIT_SPEC_SCHEMA_VERSION,
      workUnitId: record.workUnitId,
      specRevision: record.specRevision,
      attempt: record.attempt,
      memberKind: record.memberKind,
      capabilities: [...record.capabilities],
      policy: { ...record.policy },
    },
    binding: {
      schemaVersion: TASK_BINDING_SCHEMA_VERSION,
      workUnitId: record.workUnitId,
      specRevision: record.specRevision,
      state: record.binding.state,
      memberThreadId: record.binding.memberThreadId,
      launchActionId: record.binding.launchActionId,
    },
    observation,
    resultEnvelope,
    actionReceipts: actionReceipts.map((receipt) => ({
      ...receipt,
      schemaVersion:
        receipt?.schemaVersion ?? ACTION_RECEIPT_SCHEMA_VERSION,
    })),
  });
}

export function executionObservation(value) {
  return {
    ...value,
    schemaVersion:
      value?.schemaVersion ?? LIVE_OBSERVATION_SCHEMA_VERSION,
  };
}
