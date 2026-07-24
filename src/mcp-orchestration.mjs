import {
  ExecutionStoreRecordError,
  ExecutionStoreV1,
  createWorkUnitSpecV1,
} from "./execution-store.mjs";
import { reconcileExecutionRecord } from "./execution-reconciliation.mjs";
import { nativeTitleEffectV1 } from "./orchestration-observation.mjs";
import { withExecutionOrchestrationLock } from "./task-state.mjs";
import {
  buildTaskLaunchPromptV1,
  createTaskResultTemplateV1,
} from "./task-launch-prompt.mjs";
import { launcherForMemberKind } from "./launch-contract.mjs";

export const MCP_ORCHESTRATION_SCHEMA_VERSION = 1;
export const HOST_CREATE_RECEIPT_SCHEMA_VERSION = 1;
export const NATIVE_CREATE_EFFECT_SCHEMA_VERSION = 1;
export const NATIVE_RECONCILE_CREATE_EFFECT_SCHEMA_VERSION = 1;

const RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "actionId",
  "type",
  "workUnitId",
  "specRevision",
  "attempt",
  "memberThreadId",
]);
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ACTION_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const DEFINITION_FIELDS = [
  "schemaVersion",
  "webId",
  "queenThreadId",
  "workUnitId",
  "specRevision",
  "attempt",
  "memberKind",
  "capabilities",
  "launch",
  "title",
  "objectiveSummary",
  "deliverable",
  "acceptanceCriteria",
  "dependencies",
  "required",
  "policy",
];
const REQUIRED_DEFINITION_FIELDS = DEFINITION_FIELDS.filter(
  (field) => field !== "launch",
);

function assertExactObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknown = Object.keys(value)
    .filter((field) => !fields.has(field))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field: ${unknown[0]}`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`${label} requires field ${field}`);
    }
  }
  return value;
}

function assertIdentifier(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

export function validateHostCreateReceiptV1(value) {
  if (value === null) return null;
  const receipt = assertExactObject(
    value,
    "host create receipt",
    RECEIPT_FIELDS,
  );
  if (receipt.schemaVersion !== HOST_CREATE_RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `host create receipt schemaVersion must be ${HOST_CREATE_RECEIPT_SCHEMA_VERSION}`,
    );
  }
  if (receipt.type !== "native-create") {
    throw new Error("host create receipt type must be native-create");
  }
  return {
    schemaVersion: HOST_CREATE_RECEIPT_SCHEMA_VERSION,
    actionId: assertIdentifier(
      receipt.actionId,
      ACTION_ID_PATTERN,
      "host create receipt actionId",
    ),
    type: "native-create",
    workUnitId: assertIdentifier(
      receipt.workUnitId,
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,
      "host create receipt workUnitId",
    ),
    specRevision: assertPositiveInteger(
      receipt.specRevision,
      "host create receipt specRevision",
    ),
    attempt: assertPositiveInteger(
      receipt.attempt,
      "host create receipt attempt",
    ),
    memberThreadId: assertIdentifier(
      receipt.memberThreadId,
      THREAD_ID_PATTERN,
      "host create receipt memberThreadId",
    ),
  };
}

function launchActionFor(record) {
  const reconciliation = reconcileExecutionRecord({
    ...record,
    binding: {
      state: "unbound",
      memberThreadId: null,
      launchActionId: null,
      generation: record.binding.generation,
    },
  });
  if (
    reconciliation.orchestrationPhase !== "ready" ||
    reconciliation.proposedActions.length !== 1 ||
    reconciliation.proposedActions[0].type !== "launch"
  ) {
    throw new Error(
      `work unit ${record.workUnitId} does not produce exactly one launch action`,
    );
  }
  return reconciliation.proposedActions[0];
}

function assertReceiptMatchesAction(receipt, action) {
  if (receipt === null) return;
  for (const field of ["actionId", "workUnitId", "specRevision", "attempt"]) {
    if (receipt[field] !== action[field]) {
      throw new Error(`host create receipt has stale or conflicting ${field}`);
    }
  }
}

function sameDefinition(left, right) {
  return DEFINITION_FIELDS.every(
    (field) => JSON.stringify(left[field]) === JSON.stringify(right[field]),
  );
}

function launchPromptFor(record) {
  return buildTaskLaunchPromptV1({
    title: record.title,
    objective: record.objectiveSummary,
    deliverable: record.deliverable,
    acceptanceCriteria: record.acceptanceCriteria,
    resultTemplate: createTaskResultTemplateV1(record),
    completionWake:
      record.memberKind === "spinoff"
        ? {
            webId: record.webId,
            queenThreadId: record.queenThreadId,
            workUnitId: record.workUnitId,
            specRevision: record.specRevision,
            attempt: record.attempt,
          }
        : null,
  });
}

function nativeCreateEffect(action, record) {
  return {
    schemaVersion: NATIVE_CREATE_EFFECT_SCHEMA_VERSION,
    actionId: action.actionId,
    type: "native-create",
    scope: "work-unit",
    workUnitId: action.workUnitId,
    specRevision: action.specRevision,
    attempt: action.attempt,
    memberKind: record.memberKind,
    launcher: launcherForMemberKind(record.memberKind),
    launch: record.launch,
    title: record.title,
    prompt: launchPromptFor(record),
    preconditions: { ...action.preconditions },
  };
}

function nativeReconcileCreateEffect(action, record) {
  return {
    schemaVersion: NATIVE_RECONCILE_CREATE_EFFECT_SCHEMA_VERSION,
    actionId: `${action.actionId}/reconcile`,
    type: "native-reconcile-create",
    scope: "work-unit",
    createActionId: action.actionId,
    workUnitId: action.workUnitId,
    specRevision: action.specRevision,
    attempt: action.attempt,
    memberKind: record.memberKind,
    launcher: launcherForMemberKind(record.memberKind),
    launch: record.launch,
    title: record.title,
    prompt: launchPromptFor(record),
    policy: {
      onFound: "return-native-create-receipt",
      onAbsent: "return-attention-before-retry",
      onAmbiguous: "return-attention",
    },
  };
}

function nativeReadTitleEffect(record) {
  return nativeTitleEffectV1({
    workUnitId: record.workUnitId,
    specRevision: record.specRevision,
    attempt: record.attempt,
    bindingGeneration: record.binding.generation,
    memberThreadId: record.binding.memberThreadId,
    title: {
      requestedTitle: record.title,
      retryOrdinal: 0,
    },
  });
}

function resultFor(record, effects) {
  return {
    schemaVersion: MCP_ORCHESTRATION_SCHEMA_VERSION,
    workUnitId: record.workUnitId,
    specRevision: record.specRevision,
    attempt: record.attempt,
    binding: { ...record.binding },
    effects,
  };
}

export class McpOrchestrationAdapterV1 {
  #store;

  constructor({ store = new ExecutionStoreV1() } = {}) {
    if (
      !store ||
      !["read", "create", "markLaunchPending", "bind"].every(
        (method) => typeof store[method] === "function",
      )
    ) {
      throw new Error("MCP orchestration store has an invalid interface");
    }
    this.#store = store;
  }

  async orchestrate({ workUnit, receipt = null } = {}) {
    const proposed = createWorkUnitSpecV1(workUnit);
    const normalizedReceipt = validateHostCreateReceiptV1(receipt);
    const action = launchActionFor(proposed);
    assertReceiptMatchesAction(normalizedReceipt, action);

    return withExecutionOrchestrationLock(proposed.workUnitId, async () => {
      let current = await this.#store.read(proposed.workUnitId);
      if (current === null) {
        try {
          current = await this.#store.create(proposed);
        } catch (error) {
          if (
            !(error instanceof ExecutionStoreRecordError) ||
            error.code !== "already_exists"
          ) {
            throw error;
          }
          current = await this.#store.read(proposed.workUnitId);
        }
      }
      if (!current || !sameDefinition(current, proposed)) {
        throw new Error(
          `work unit ${proposed.workUnitId} conflicts with its durable definition`,
        );
      }

      let newlyPending = false;
      if (current.binding.state === "unbound") {
        current = await this.#store.markLaunchPending({
          workUnitId: proposed.workUnitId,
          specRevision: proposed.specRevision,
          launchActionId: action.actionId,
        });
        newlyPending = true;
      } else if (current.binding.launchActionId !== action.actionId) {
        throw new Error(
          `work unit ${proposed.workUnitId} has a conflicting launch action`,
        );
      }

      if (normalizedReceipt !== null) {
        if (
          current.binding.state === "bound" &&
          current.binding.memberThreadId !== normalizedReceipt.memberThreadId
        ) {
          throw new Error(
            "host create receipt conflicts with the bound member thread",
          );
        }
        current = await this.#store.bind({
          workUnitId: proposed.workUnitId,
          specRevision: proposed.specRevision,
          launchActionId: action.actionId,
          memberThreadId: normalizedReceipt.memberThreadId,
        });
        return resultFor(current, [nativeReadTitleEffect(current)]);
      }

      if (current.binding.state === "bound") {
        return resultFor(current, [nativeReadTitleEffect(current)]);
      }
      return resultFor(current, [
        newlyPending
          ? nativeCreateEffect(action, current)
          : nativeReconcileCreateEffect(action, current),
      ]);
    });
  }
}

const STRING_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "string" },
};

export const MCP_ORCHESTRATE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    workUnit: {
      type: "object",
      properties: {
        schemaVersion: { const: 1 },
        webId: { type: "string" },
        queenThreadId: { type: "string" },
        workUnitId: { type: "string" },
        specRevision: { type: "integer", minimum: 1 },
        attempt: { type: "integer", minimum: 1 },
        memberKind: { enum: ["spinoff", "joined-subagent"] },
        capabilities: STRING_ARRAY_SCHEMA,
        launch: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                schemaVersion: { const: 1 },
                launcher: { enum: ["create-thread", "spawn-subagent"] },
                workspaceMode: {
                  enum: ["shared-read-only", "isolated-write"],
                },
                nativeTask: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    thinking: { type: "string" },
                  },
                  additionalProperties: false,
                },
                requiresThreadId: { const: true },
                onMissingThreadId: { const: "attention" },
              },
              required: ["workspaceMode", "nativeTask"],
              additionalProperties: false,
            },
          ],
        },
        title: { type: "string" },
        objectiveSummary: { type: "string" },
        deliverable: { type: "string" },
        acceptanceCriteria: STRING_ARRAY_SCHEMA,
        dependencies: STRING_ARRAY_SCHEMA,
        required: { type: "boolean" },
        policy: {
          type: "object",
          properties: {
            maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
            onBlocked: { const: "queen-review" },
            onFailure: { const: "queen-review" },
          },
          required: ["maxAttempts", "onBlocked", "onFailure"],
          additionalProperties: false,
        },
      },
      required: [...REQUIRED_DEFINITION_FIELDS],
      additionalProperties: false,
    },
    receipt: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            schemaVersion: { const: 1 },
            actionId: { type: "string" },
            type: { const: "native-create" },
            workUnitId: { type: "string" },
            specRevision: { type: "integer", minimum: 1 },
            attempt: { type: "integer", minimum: 1 },
            memberThreadId: { type: "string" },
          },
          required: [...RECEIPT_FIELDS],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["workUnit", "receipt"],
  additionalProperties: false,
});
