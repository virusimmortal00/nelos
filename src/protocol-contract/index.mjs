import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const PROTOCOL_CONTRACT_SCHEMA_VERSION = 1;

const VERSION = { const: 1 };
const ID = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
};
const SHORT_ID = { ...ID, maxLength: 128 };
const TEXT = { type: "string", minLength: 1, maxLength: 8_192 };
const SHORT_TEXT = { type: "string", minLength: 1, maxLength: 1_000 };
const POSITIVE = { type: "integer", minimum: 1 };
const NULLABLE_ID = { anyOf: [{ type: "null" }, ID] };

function closed(properties, required = Object.keys(properties)) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function discriminated(field, value, properties = {}, required = Object.keys(properties)) {
  return closed(
    { schemaVersion: VERSION, [field]: { const: value }, ...properties },
    ["schemaVersion", field, ...required],
  );
}

const NATIVE_TASK = closed({
  model: { type: "string", minLength: 1, maxLength: 128 },
  thinking: { type: "string", minLength: 1, maxLength: 32 },
});
const TOOL_ARGUMENTS = {
  type: "object",
  minProperties: 1,
  maxProperties: 16,
  propertyNames: { maxLength: 64 },
  additionalProperties: {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "integer" },
      ID,
    ],
  },
};
const MEMBER_TARGET = closed({
  sliceId: SHORT_ID,
  lifecycle: { enum: ["subagent", "spinoff"] },
  memberKind: { enum: ["joined-subagent", "spinoff"] },
  controlSurface: { enum: ["collaboration", "codex-task"] },
  primaryId: { enum: ["agentPath", "threadId"] },
  threadId: ID,
  turnId: ID,
}, [
  "sliceId", "lifecycle", "memberKind", "controlSurface", "primaryId",
  "threadId", "turnId",
]);

const NEXT_ACTION_MEMBERS = [
  discriminated("kind", "launch-planner", {
    member: {
      type: "object",
      minProperties: 8,
      maxProperties: 24,
      additionalProperties: true,
    },
  }),
  discriminated("kind", "reconcile-planner-launch", {
    actionId: ID,
    createActionId: ID,
    policy: closed({
      onFound: { const: "return-native-planner-created-receipt" },
      onAbsent: { const: "return-attention-before-retry" },
      onAmbiguous: { const: "return-attention" },
    }),
  }),
  discriminated("kind", "native-wait-subagent", {
    actionId: ID,
    agentPath: ID,
    threadId: ID,
    turnId: NULLABLE_ID,
    after: { const: "repeat-planner-launch-receipt" },
    reconciliation: {
      type: "object",
      minProperties: 6,
      maxProperties: 6,
      additionalProperties: true,
    },
  }, ["actionId", "agentPath", "threadId", "turnId", "after"]),
  discriminated("kind", "native-read-subagent-result", {
    actionId: ID,
    agentPath: ID,
    threadId: ID,
    turnId: ID,
    purpose: { const: "read-planner-result" },
  }),
  discriminated("kind", "launch-wave", {
    waveIndex: POSITIVE,
    members: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        minProperties: 14,
        maxProperties: 24,
        additionalProperties: true,
      },
    },
    verification: closed({
      planRunId: ID,
      waveIndex: POSITIVE,
      waveDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }),
    settleBeforeWaveIndex: { type: "integer", minimum: 2 },
    remainingWaveCount: { type: "integer", minimum: 0, maximum: 1_000 },
  }),
  discriminated("kind", "native-wait-wave", {
    targets: { type: "array", minItems: 1, maxItems: 16, items: MEMBER_TARGET },
    after: { const: "read-results" },
  }),
  discriminated("kind", "native-wait", {
    threadIds: {
      type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: ID,
    },
    turnIds: {
      type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: ID,
    },
    after: { enum: ["read-result", "web-collect", "worktree-integration"] },
    webId: ID,
  }, ["threadIds", "after"]),
  discriminated("kind", "native-read", {
    threadId: ID,
    turnId: ID,
    purpose: { const: "read-result" },
  }, ["threadId", "purpose"]),
  discriminated("kind", "native-follow-up", {
    members: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: closed({ threadId: ID, prompt: TEXT }),
    },
    after: { const: "web-collect" },
    webId: ID,
  }),
  discriminated("kind", "native-set-title", {
    actionId: ID,
    threadId: ID,
    title: { type: "string", minLength: 1, maxLength: 512 },
    verify: { const: true },
    after: {
      enum: ["repeat-plan-slices", "repeat-launch-verify-batch"],
    },
  }, ["threadId", "title", "verify"]),
  discriminated("kind", "verify-route", {
    tool: { const: "nelos_intelligence_verify" },
    arguments: TOOL_ARGUMENTS,
  }),
  discriminated("kind", "attach-native-task-options", {
    nativeTask: NATIVE_TASK,
    routeEnforcement: closed({
      mode: { const: "exact" },
      onUnavailable: { const: "stop" },
      verifyAfterLaunch: { const: true },
    }),
  }),
  discriminated("kind", "decide", {
    operation: { enum: ["author-slice-plan", "accept-current-results"] },
    webId: ID,
    members: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        minProperties: 4,
        maxProperties: 4,
        additionalProperties: true,
      },
    },
  }, ["operation"]),
  discriminated("kind", "advance-orchestration", {
    tool: { const: "nelos_orchestrate_advance" },
    arguments: closed({ webId: ID, queenThreadId: ID, receipt: { type: "null" } }),
  }),
  discriminated("kind", "cleanup-spinoffs", {
    tool: { const: "nelos_spinoff_cleanup" },
    arguments: closed({ webId: ID, queenThreadId: ID }),
  }),
  discriminated("kind", "execute-cli", {
    command: { const: "worktree provision" },
    actionId: ID,
    worktreePath: TEXT,
    branch: { type: "string", minLength: 1, maxLength: 255 },
    requiredInputs: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      uniqueItems: true,
      items: { enum: ["sourcePath", "baseRevision", "ownerTaskId"] },
    },
  }),
  discriminated("kind", "attention", {
    reason: SHORT_TEXT,
    retryable: { type: "boolean" },
    actionId: ID,
    threadId: ID,
    turnId: ID,
    bootstrapId: ID,
    confidence: { enum: ["low", "medium", "high"] },
    webId: ID,
    planRunId: ID,
    nextWaveIndex: POSITIVE,
    sliceIds: { type: "array", maxItems: 16, uniqueItems: true, items: SHORT_ID },
    workUnitIds: { type: "array", maxItems: 100, uniqueItems: true, items: SHORT_ID },
    members: { type: "array", maxItems: 100, uniqueItems: true, items: ID },
    classificationEvidence: {
      type: "array", maxItems: 16, items: SHORT_TEXT,
    },
  }, ["reason"]),
  discriminated("kind", "complete", {
    state: { type: "string", minLength: 1, maxLength: 128 },
    webId: { anyOf: [{ type: "null" }, ID] },
    threadId: ID,
    turnIds: { type: "array", maxItems: 100, uniqueItems: true, items: ID },
    workUnitIds: { type: "array", maxItems: 100, uniqueItems: true, items: SHORT_ID },
  }, []),
];

export const PROTOCOL_ACTION_SCHEMA_V1 = { oneOf: NEXT_ACTION_MEMBERS };

const EFFECT_IDENTITY = {
  actionId: ID,
  workUnitId: SHORT_ID,
  specRevision: POSITIVE,
  attempt: POSITIVE,
};
const OBSERVATION_IDENTITY = {
  ...EFFECT_IDENTITY,
  bindingGeneration: POSITIVE,
  memberThreadId: ID,
};
const RECONCILE_POLICY = closed({
  onFound: { type: "string", minLength: 1, maxLength: 64 },
  onAbsent: { const: "return-attention-before-retry" },
  onAmbiguous: { const: "return-attention" },
});

const EFFECT_MEMBERS = [
  discriminated("type", "native-create", {
    ...EFFECT_IDENTITY,
    scope: { const: "work-unit" },
    memberKind: { enum: ["spinoff", "joined-subagent"] },
    launcher: { enum: ["create-thread", "spawn-subagent"] },
    launch: {
      anyOf: [
        { type: "null" },
        { type: "object", minProperties: 2, maxProperties: 8, additionalProperties: true },
      ],
    },
    title: { type: "string", minLength: 1, maxLength: 512 },
    prompt: TEXT,
    preconditions: closed({
      expectedSpecRevision: POSITIVE,
      expectedBindingState: { const: "unbound" },
      expectedMemberThreadId: { type: "null" },
      expectedSourceTurnId: { type: "null" },
    }),
  }),
  discriminated("type", "native-reconcile-create", {
    ...EFFECT_IDENTITY,
    scope: { const: "work-unit" },
    createActionId: ID,
    memberKind: { enum: ["spinoff", "joined-subagent"] },
    launcher: { enum: ["create-thread", "spawn-subagent"] },
    launch: {
      anyOf: [
        { type: "null" },
        { type: "object", minProperties: 2, maxProperties: 8, additionalProperties: true },
      ],
    },
    title: { type: "string", minLength: 1, maxLength: 512 },
    prompt: TEXT,
    policy: RECONCILE_POLICY,
  }),
  discriminated("type", "native-read-title", {
    ...OBSERVATION_IDENTITY,
    requestedTitle: { type: "string", minLength: 1, maxLength: 512 },
  }),
  discriminated("type", "native-set-title", {
    ...OBSERVATION_IDENTITY,
    requestedTitle: { type: "string", minLength: 1, maxLength: 512 },
  }),
  discriminated("type", "native-wait", {
    actionId: ID,
    webId: ID,
    queenThreadId: ID,
    targets: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: closed({
        workUnitId: SHORT_ID,
        specRevision: POSITIVE,
        attempt: POSITIVE,
        bindingGeneration: POSITIVE,
        memberThreadId: ID,
        hostId: NULLABLE_ID,
        afterCursor: NULLABLE_ID,
      }),
    },
  }),
  discriminated("type", "native-read-result", {
    ...OBSERVATION_IDENTITY,
    requestedTurnId: ID,
  }),
  discriminated("type", "native-send-message", {
    actionId: ID,
    threadId: ID,
    prompt: TEXT,
    preconditions: closed({
      expectedCallerThreadId: ID,
      expectedBoundMemberThreadId: ID,
    }),
  }),
  discriminated("type", "native-reconcile-send-message", {
    actionId: ID,
    originalActionId: ID,
    threadId: ID,
    policy: RECONCILE_POLICY,
  }),
  discriminated("type", "native-archive", {
    actionId: ID,
    threadId: ID,
    archived: { const: true },
    preconditions: closed({
      expectedQueenThreadId: ID,
      expectedAcceptedWorkUnitId: SHORT_ID,
    }),
  }),
  discriminated("type", "native-reconcile-archive", {
    actionId: ID,
    originalActionId: ID,
    threadId: ID,
    policy: RECONCILE_POLICY,
  }),
];

export const PROTOCOL_NATIVE_EFFECT_SCHEMA_V1 = { oneOf: EFFECT_MEMBERS };

const RECEIPT_MEMBERS = [
  discriminated("type", "native-planner-created", {
    actionId: ID,
    bootstrapId: ID,
    parentThreadId: ID,
    agentPath: ID,
  }),
  discriminated("type", "native-planner-result", {
    actionId: ID,
    bootstrapId: ID,
    threadId: ID,
    turnId: ID,
    response: TEXT,
  }),
  discriminated("type", "native-create", {
    ...EFFECT_IDENTITY,
    memberThreadId: ID,
  }),
  discriminated("type", "native-title-observed", {
    ...OBSERVATION_IDENTITY,
    requestedTitle: { type: "string", minLength: 1, maxLength: 512 },
    observedTitle: { type: "string", maxLength: 512 },
  }),
  discriminated("type", "native-wait", {
    actionId: ID,
    webId: ID,
    queenThreadId: ID,
    status: { enum: ["event", "timeout"] },
    targets: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        minProperties: 11,
        maxProperties: 11,
        additionalProperties: true,
      },
    },
  }),
  discriminated("type", "native-result-read", {
    ...OBSERVATION_IDENTITY,
    requestedTurnId: ID,
    sourceTurnId: ID,
    resultEnvelope: {
      type: "object",
      minProperties: 10,
      maxProperties: 10,
      additionalProperties: true,
    },
  }),
  closed({ threadId: ID }),
  discriminated("type", "native-archive", {
    actionId: ID,
    threadId: ID,
    archived: { const: true },
  }),
];

export const PROTOCOL_RECEIPT_SCHEMA_V1 = { oneOf: RECEIPT_MEMBERS };

export const PROTOCOL_CONTINUATION_SCHEMA_V1 = closed({
  schemaVersion: VERSION,
  continuationId: ID,
  ordinal: { type: "integer", minimum: 0, maximum: 10_000 },
  state: { enum: ["pending", "consumed", "attention", "complete"] },
  nextAction: { anyOf: [{ type: "null" }, PROTOCOL_ACTION_SCHEMA_V1] },
});

export const RECOVERY_COMMANDS_V1 = Object.freeze([
  "retry-read",
  "reconcile-native-outcome",
  "request-semantic-input",
  "restart-current-action",
  "return-exact-receipt",
]);

function code(category, recoveryCommand, terminal = false) {
  return Object.freeze({ category, recoveryCommand, terminal });
}

export const PROTOCOL_CODE_REGISTRY_V1 = Object.freeze({
  "attention.retryable": code("retryable-attention", "retry-read"),
  "attention.terminal": code("terminal-attention", null, true),
  "protocol.malformed": code("protocol-error", null, true),
  "protocol.out-of-order-receipt": code("protocol-error", null, true),
  "receipt.stale": code("receipt-conflict", "restart-current-action"),
  "receipt.conflicting": code("receipt-conflict", null, true),
  "receipt.duplicate": code("receipt-conflict", null, true),
  "receipt.cross-action": code("receipt-conflict", null, true),
  "evidence.unavailable": code("evidence-unavailable", "retry-read"),
  "native.outcome-uncertain": code("native-outcome-uncertain", "reconcile-native-outcome"),
  "semantic.input-required": code("retryable-attention", "request-semantic-input"),
});

export const PROTOCOL_ERROR_SCHEMA_V1 = closed({
  schemaVersion: VERSION,
  code: { enum: Object.keys(PROTOCOL_CODE_REGISTRY_V1) },
  category: {
    enum: [
      "retryable-attention", "terminal-attention", "protocol-error",
      "receipt-conflict", "evidence-unavailable", "native-outcome-uncertain",
    ],
  },
  message: SHORT_TEXT,
  recoveryCommand: {
    anyOf: [{ type: "null" }, { enum: RECOVERY_COMMANDS_V1 }],
  },
});

export const PROTOCOL_ATTENTION_SCHEMA_V1 = closed({
  schemaVersion: VERSION,
  kind: { const: "attention" },
  code: { enum: Object.keys(PROTOCOL_CODE_REGISTRY_V1) },
  message: SHORT_TEXT,
  terminal: { type: "boolean" },
  recoveryCommand: {
    anyOf: [{ type: "null" }, { enum: RECOVERY_COMMANDS_V1 }],
  },
});

const SEMANTIC_MEMBERS = [
  discriminated("type", "coordinated-work-selection", {
    suppliedBy: { enum: ["user", "queen"] },
    value: closed({
      coordinated: { type: "boolean" },
      rationale: SHORT_TEXT,
    }),
  }),
  discriminated("type", "genuine-user-supplied-plan-recognition", {
    suppliedBy: { const: "queen" },
    value: closed({
      recognized: { type: "boolean" },
      evidence: { type: "array", minItems: 1, maxItems: 8, items: SHORT_TEXT },
    }),
  }),
  discriminated("type", "result-acceptance-judgment", {
    suppliedBy: { const: "queen" },
    value: closed({
      decision: { enum: ["accepted", "rejected"] },
      summary: SHORT_TEXT,
    }),
  }),
  discriminated("type", "cleanup-consent-or-preference", {
    suppliedBy: { const: "user" },
    value: closed({
      choice: { enum: ["archive", "keep", "ask"] },
      threadIds: {
        type: "array", maxItems: 100, uniqueItems: true, items: ID,
      },
      rememberPolicy: { type: "boolean" },
    }),
  }),
  discriminated("type", "user-facing-communication", {
    suppliedBy: { const: "queen" },
    value: closed({ message: TEXT }),
  }),
];

export const PROTOCOL_SEMANTIC_INPUT_SCHEMA_V1 = { oneOf: SEMANTIC_MEMBERS };
export const SEMANTIC_INPUTS_V1 = Object.freeze({
  coordinatedWorkSelection: "queen-or-user",
  genuineUserSuppliedPlanRecognition: "queen",
  resultAcceptanceJudgment: "queen",
  cleanupConsentOrPreference: "user",
  userFacingCommunication: "queen",
});

const BOUNDED_RECORD = {
  type: "object",
  minProperties: 1,
  maxProperties: 64,
  additionalProperties: true,
};

function producerOutput(producer, properties, required = Object.keys(properties)) {
  return closed({
    schemaVersion: VERSION,
    producer: { const: producer },
    value: closed(properties, required),
  });
}

const COMPATIBILITY_MEMBERS = [
  producerOutput("nelos_plan_lifecycle", {
    schemaVersion: VERSION,
    command: { enum: ["plan lifecycle", "plan slices"] },
    lifecycle: BOUNDED_RECORD,
    bootstrap: BOUNDED_RECORD,
    planning: BOUNDED_RECORD,
    plan: BOUNDED_RECORD,
    planRun: BOUNDED_RECORD,
    cleanupIntended: { type: "boolean" },
    nextAction: PROTOCOL_ACTION_SCHEMA_V1,
  }, ["command", "lifecycle", "bootstrap", "nextAction"]),
  producerOutput("nelos_launch_verify_batch", {
    command: { const: "launch verify batch" },
    verification: BOUNDED_RECORD,
    nextAction: PROTOCOL_ACTION_SCHEMA_V1,
  }),
  producerOutput("nelos_orchestrate_create", {
    schemaVersion: VERSION,
    workUnitId: SHORT_ID,
    specRevision: POSITIVE,
    attempt: POSITIVE,
    binding: BOUNDED_RECORD,
    effects: {
      type: "array", minItems: 1, maxItems: 4, items: PROTOCOL_NATIVE_EFFECT_SCHEMA_V1,
    },
  }),
  producerOutput("nelos_orchestrate_advance", {
    schemaVersion: VERSION,
    webId: ID,
    queenThreadId: ID,
    checkpoint: BOUNDED_RECORD,
    join: BOUNDED_RECORD,
    nextAction: PROTOCOL_ACTION_SCHEMA_V1,
  }, ["schemaVersion", "webId", "queenThreadId", "checkpoint", "join"]),
  producerOutput("nelos_queen_decide", {
    schemaVersion: VERSION,
    replayed: { type: "boolean" },
    decision: BOUNDED_RECORD,
    readiness: BOUNDED_RECORD,
    nextAction: PROTOCOL_ACTION_SCHEMA_V1,
  }),
  producerOutput("nelos_spinoff_complete", {
    schemaVersion: VERSION,
    replayed: { type: "boolean" },
    record: BOUNDED_RECORD,
    effects: {
      type: "array", maxItems: 1, items: PROTOCOL_NATIVE_EFFECT_SCHEMA_V1,
    },
  }, ["schemaVersion", "replayed", "record"]),
  producerOutput("nelos_spinoff_cleanup", {
    schemaVersion: VERSION,
    policy: { enum: ["ask", "auto", "keep"] },
    state: {
      enum: ["not-ready", "confirmation-required", "effects-required", "attention", "complete"],
    },
    pending: { type: "array", maxItems: 100, items: BOUNDED_RECORD },
    candidates: { type: "array", maxItems: 100, items: BOUNDED_RECORD },
    results: { type: "array", maxItems: 100, items: BOUNDED_RECORD },
    effects: {
      type: "array", maxItems: 100, items: PROTOCOL_NATIVE_EFFECT_SCHEMA_V1,
    },
  }, ["schemaVersion", "policy", "state"]),
];

export const PROTOCOL_COMPATIBILITY_ENVELOPE_SCHEMA_V1 = {
  oneOf: COMPATIBILITY_MEMBERS,
};

export const PROTOCOL_CONTRACTS_V1 = Object.freeze({
  action: PROTOCOL_ACTION_SCHEMA_V1,
  effect: PROTOCOL_NATIVE_EFFECT_SCHEMA_V1,
  receipt: PROTOCOL_RECEIPT_SCHEMA_V1,
  continuation: PROTOCOL_CONTINUATION_SCHEMA_V1,
  attention: PROTOCOL_ATTENTION_SCHEMA_V1,
  error: PROTOCOL_ERROR_SCHEMA_V1,
  semanticInput: PROTOCOL_SEMANTIC_INPUT_SCHEMA_V1,
  compatibilityEnvelope: PROTOCOL_COMPATIBILITY_ENVELOPE_SCHEMA_V1,
});

const VALUE_ENVELOPE_MEMBERS = Object.entries(PROTOCOL_CONTRACTS_V1)
  .filter(([contract]) => contract !== "compatibilityEnvelope")
  .map(([contract, schema]) =>
    closed({
      schemaVersion: VERSION,
      contract: { const: contract },
      value: schema,
    }));

export const PROTOCOL_VALUE_ENVELOPE_SCHEMA_V1 = {
  oneOf: VALUE_ENVELOPE_MEMBERS,
};

function validateJson(schema, value, path = "$") {
  if (schema.oneOf) {
    const count = schema.oneOf.filter((candidate) => {
      try { validateJson(candidate, value, path); return true; } catch { return false; }
    }).length;
    if (count !== 1) throw new Error(`${path} must match exactly one union member`);
    return value;
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((candidate) => {
      try { validateJson(candidate, value, path); return true; } catch { return false; }
    })) throw new Error(`${path} does not match an allowed shape`);
    return value;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    throw new Error(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} is not allowed`);
  if (schema.type === "null" && value !== null) throw new Error(`${path} must be null`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) throw new Error(`${path} has an invalid format`);
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
  }
  if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} must be an integer`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} is too small`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} is too large`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be boolean`);
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path} has too many items`);
    if (schema.uniqueItems && new Set(value.map(JSON.stringify)).size !== value.length) throw new Error(`${path} must contain unique items`);
    value.forEach((item, index) => validateJson(schema.items, item, `${path}[${index}]`));
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) throw new Error(`${path} has too few properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) throw new Error(`${path} has too many properties`);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) throw new Error(`${path}.${required} is required`);
    }
    if (schema.propertyNames) {
      for (const key of keys) {
        validateJson(schema.propertyNames, key, `${path} property name`);
      }
    }
    if (schema.additionalProperties === false) {
      const unexpected = keys.find((key) => !Object.hasOwn(schema.properties, key));
      if (unexpected) throw new Error(`${path}.${unexpected} is not allowed`);
    } else if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      for (const key of keys) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          validateJson(
            schema.additionalProperties,
            value[key],
            `${path}.${key}`,
          );
        }
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateJson(child, value[key], `${path}.${key}`);
    }
  }
  return value;
}

export function validateProtocolContractV1(contract, value) {
  const schema = typeof contract === "string"
    ? PROTOCOL_CONTRACTS_V1[contract]
    : contract;
  if (!schema) throw new Error(`unknown protocol contract ${contract}`);
  validateJson(schema, value);
  return structuredClone(value);
}

export function protocolCompatibilityEnvelopeV1(producer, value) {
  return validateProtocolContractV1("compatibilityEnvelope", {
    schemaVersion: 1,
    producer,
    value,
  });
}

export function protocolValueEnvelopeV1(contract, value) {
  return validateProtocolContractV1(PROTOCOL_VALUE_ENVELOPE_SCHEMA_V1, {
    schemaVersion: 1,
    contract,
    value,
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function protocolReceiptDigestV1(receipt) {
  const normalized = validateProtocolContractV1("receipt", receipt);
  return createHash("sha256").update(canonical(normalized), "utf8").digest("base64url");
}

function transitionError(code, message) {
  const declaration = PROTOCOL_CODE_REGISTRY_V1[code];
  return {
    accepted: false,
    replayed: false,
    state: null,
    error: {
      schemaVersion: 1,
      code,
      category: declaration.category,
      message,
      recoveryCommand: declaration.recoveryCommand,
    },
  };
}

function validateExecutable(value) {
  let action = null;
  try {
    action = validateProtocolContractV1("action", value);
  } catch {
    // Fall through to the native-effect union.
  }
  if (action) {
    if (action.kind === "native-read-subagent-result") {
      return { contract: "action", value: action };
    }
    throw new Error(
      `nextAction ${action.kind} is not a receipt-consuming transition executable`,
    );
  }
  const effect = validateProtocolContractV1("effect", value);
  if (![
    "native-create",
    "native-read-title",
    "native-set-title",
    "native-wait",
    "native-read-result",
    "native-send-message",
    "native-archive",
  ].includes(effect.type)) {
    throw new Error(
      `effect ${effect.type} is not a receipt-consuming transition executable`,
    );
  }
  return { contract: "effect", value: effect };
}

export function initialProtocolTransitionStateV1(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("transition state requires actions");
  }
  const normalized = actions.map(validateExecutable);
  const ids = normalized.map(({ value }) => value.actionId).filter(Boolean);
  if (ids.length !== normalized.length || new Set(ids).size !== ids.length) {
    throw new Error("transition actions require unique actionId values");
  }
  return {
    schemaVersion: 1,
    revision: 0,
    cursor: 0,
    actions: normalized,
    consumedReceipts: [],
  };
}

function assertReceiptIdentity(executable, receipt) {
  const action = executable.value;
  if (receipt.actionId !== undefined && receipt.actionId !== action.actionId) {
    return "receipt.cross-action";
  }
  const direct = [
    "workUnitId", "specRevision", "attempt", "bindingGeneration",
    "memberThreadId", "threadId", "webId", "queenThreadId",
  ];
  for (const field of direct) {
    if (
      action[field] !== undefined &&
      receipt[field] !== undefined &&
      !isDeepStrictEqual(action[field], receipt[field])
    ) return "receipt.conflicting";
  }
  const requiredType = {
    "native-read-subagent-result": "native-planner-result",
    "native-create": "native-create",
    "native-read-title": "native-title-observed",
    "native-set-title": "native-title-observed",
    "native-wait": "native-wait",
    "native-read-result": "native-result-read",
    "native-send-message": undefined,
    "native-archive": "native-archive",
  }[action.kind ?? action.type];
  const hostWake = action.type === "native-send-message" &&
    Object.keys(receipt).length === 1;
  if (!hostWake && requiredType !== receipt.type) return "receipt.conflicting";
  if (
    action.type === "native-send-message" &&
    receipt.threadId !== action.threadId
  ) return "receipt.conflicting";
  if (
    action.type === "native-read-result" &&
    (receipt.requestedTurnId !== action.requestedTurnId ||
      receipt.sourceTurnId !== action.requestedTurnId)
  ) return "receipt.conflicting";
  if (
    ["native-read-title", "native-set-title"].includes(action.type) &&
    receipt.requestedTitle !== action.requestedTitle
  ) return "receipt.conflicting";
  if (action.type === "native-wait") {
    if (
      receipt.targets.length !== action.targets.length ||
      action.targets.some((expected) => {
        const actual = receipt.targets.find(
          ({ workUnitId }) => workUnitId === expected.workUnitId,
        );
        return !actual || [
          "workUnitId", "specRevision", "attempt", "bindingGeneration",
          "memberThreadId", "hostId", "afterCursor",
        ].some((field) => !isDeepStrictEqual(expected[field], actual[field]));
      })
    ) return "receipt.conflicting";
  }
  if (
    action.kind === "native-read-subagent-result" &&
    (receipt.threadId !== action.threadId || receipt.turnId !== action.turnId)
  ) return "receipt.conflicting";
  return null;
}

export function reduceProtocolTransitionV1(state, action, receipt) {
  let executable;
  let normalizedReceipt;
  try {
    executable = validateExecutable(action);
    normalizedReceipt = validateProtocolContractV1("receipt", receipt);
  } catch (error) {
    return transitionError("protocol.malformed", error.message);
  }
  const expected = state.actions[state.cursor];
  const digest = protocolReceiptDigestV1(normalizedReceipt);
  const replay = state.consumedReceipts.find(({ digest: value }) => value === digest);
  if (replay) {
    const original = state.actions.find(
      ({ value }) => value.actionId === replay.actionId,
    );
    if (
      original &&
      replay.actionId === executable.value.actionId &&
      original.contract === executable.contract &&
      isDeepStrictEqual(original.value, executable.value)
    ) {
      return { accepted: true, replayed: true, state: structuredClone(state), error: null };
    }
    return transitionError(
      replay.actionId === executable.value.actionId
        ? "receipt.conflicting"
        : "receipt.duplicate",
      "replayed receipt does not match its original persisted executable",
    );
  }
  if (!expected) {
    return transitionError("protocol.out-of-order-receipt", "transition is complete");
  }
  if (executable.value.actionId !== expected.value.actionId) {
    const index = state.actions.findIndex(
      ({ value }) => value.actionId === executable.value.actionId,
    );
    return transitionError(
      index < state.cursor ? "receipt.stale" :
        index > state.cursor ? "protocol.out-of-order-receipt" :
          "receipt.cross-action",
      "action is not current",
    );
  }
  if (
    executable.contract !== expected.contract ||
    !isDeepStrictEqual(executable.value, expected.value)
  ) {
    return transitionError("receipt.conflicting", "action differs from persisted current action");
  }
  const identityError = assertReceiptIdentity(executable, normalizedReceipt);
  if (identityError) {
    return transitionError(identityError, "receipt identity conflicts with current action");
  }
  const next = {
    ...structuredClone(state),
    revision: state.revision + 1,
    cursor: state.cursor + 1,
    consumedReceipts: [
      ...state.consumedReceipts,
      { actionId: expected.value.actionId, digest, receipt: normalizedReceipt },
    ],
  };
  return { accepted: true, replayed: false, state: next, error: null };
}

export function validateRecoveryTransitionV1(error, command) {
  const normalized = validateProtocolContractV1("error", error);
  const declaration = PROTOCOL_CODE_REGISTRY_V1[normalized.code];
  if (!RECOVERY_COMMANDS_V1.includes(command)) {
    return transitionError("protocol.malformed", "unknown recovery command");
  }
  if (
    declaration.category !== normalized.category ||
    declaration.recoveryCommand !== command ||
    normalized.recoveryCommand !== command
  ) {
    return transitionError(
      declaration.recoveryCommand === null
        ? "attention.terminal"
        : "receipt.conflicting",
      "recovery command is forbidden",
    );
  }
  return { accepted: true, replayed: false, command, error: null };
}

export const MCP_PROTOCOL_TOOL_CONTRACTS_V1 = Object.freeze(
  Object.fromEntries(
    COMPATIBILITY_MEMBERS.map(({ properties }) => [
      properties.producer.const,
      Object.freeze({
        schemaVersion: 1,
        compatibilityEnvelope: "ProtocolCompatibilityEnvelopeV1",
      }),
    ]),
  ),
);
