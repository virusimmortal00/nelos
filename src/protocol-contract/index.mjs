import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  MAX_PLANNING_CONTEXT_CHARACTERS,
  MAX_PLANNING_OBJECTIVE_CHARACTERS,
  MAX_PLANNING_RESPONSE_CHARACTERS,
} from "../planning-bootstrap.mjs";

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
const PLANNER_PROMPT = {
  type: "string",
  minLength: 1,
  maxLength:
    MAX_PLANNING_OBJECTIVE_CHARACTERS +
    (2 * MAX_PLANNING_CONTEXT_CHARACTERS) +
    8_000,
};
const PLANNER_RESPONSE = {
  type: "string",
  minLength: 1,
  maxLength: MAX_PLANNING_RESPONSE_CHARACTERS,
};
const NATIVE_CREATE_PROMPT = {
  type: "string",
  minLength: 1,
  maxLength: 12_000,
};
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
const ROUTE_ENFORCEMENT = closed({
  mode: { const: "exact" },
  onUnavailable: { const: "stop" },
  verifyAfterLaunch: { const: true },
});
const ROUTE_EXPECTATION = closed({
  model: { type: "string", minLength: 1, maxLength: 128 },
  effort: { type: "string", minLength: 1, maxLength: 32 },
});
const ROUTE_OBSERVATION = closed({
  turnId: ID,
  model: { type: "string", minLength: 1, maxLength: 128 },
  effort: { type: "string", minLength: 1, maxLength: 32 },
  matches: { type: "boolean" },
});
const PLANNER_MEMBER_PROPERTIES = {
  bootstrapId: ID,
  agentTaskName: SHORT_ID,
  lifecycle: { const: "subagent" },
  memberKind: { const: "joined-subagent" },
  launcher: { const: "spawn-subagent" },
  title: { type: "string", minLength: 1, maxLength: 512 },
  titlePolicy: closed({
    mode: { const: "prompt-seeded" },
    recommendedMaxCharacters: { type: "integer", minimum: 1, maximum: 512 },
    verifyAfterLaunch: { const: false },
    evidence: { const: "agent-path" },
    onMismatch: { const: "attention" },
  }),
  workspaceMode: { const: "shared-read-only" },
  forkTurns: { const: "none" },
  nativeTask: NATIVE_TASK,
  routeEnforcement: ROUTE_ENFORCEMENT,
  threadIdentity: closed({
    required: { const: true },
    onMissing: { const: "attention" },
    resolver: { const: "nelos_intelligence_resolve_subagent" },
    parentThreadIdSource: { const: "current-task" },
    agentPathSource: { const: "launcher-result" },
    turnIdSource: { const: "resolved-native-session" },
  }),
  identityContract: closed({
    lifecycle: { const: "subagent" },
    memberKind: { const: "joined-subagent" },
    primaryId: { const: "agentPath" },
    controlSurface: { const: "collaboration" },
    nativeThreadIdUse: { const: "verification-only" },
    nativeTitleControl: { const: false },
  }),
  prompt: PLANNER_PROMPT,
  resultContract: closed({
    fence: { const: "nelos-plan" },
    bootstrapId: ID,
    nextTool: { const: "nelos_plan_bootstrap" },
    responseArgument: { const: "response" },
    reuseRequest: { const: true },
    onInvalid: { const: "attention" },
  }),
  continuation: closed({
    verify: closed({
      tool: { const: "nelos_intelligence_verify" },
      model: { type: "string", minLength: 1, maxLength: 128 },
      effort: { type: "string", minLength: 1, maxLength: 32 },
      beforeRead: { const: true },
    }),
    wait: closed({ action: { const: "native-wait-subagent" } }),
    read: closed({ action: { const: "native-read-subagent-result" } }),
    finalize: closed({
      tool: { const: "nelos_plan_bootstrap" },
      reuseRequest: { const: true },
      responseArgument: { const: "response" },
    }),
  }),
};
const PLANNER_LIFECYCLE_PRECONDITIONS = closed({
  bootstrapId: ID,
  expectedPhase: { const: "launch-pending" },
  expectedParentThreadId: ID,
});
const PLANNER_MEMBER = {
  oneOf: [
    closed(PLANNER_MEMBER_PROPERTIES),
    closed({
      ...PLANNER_MEMBER_PROPERTIES,
      actionId: ID,
      preconditions: PLANNER_LIFECYCLE_PRECONDITIONS,
    }),
  ],
};
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
const MEMBER_TARGET_IDENTITY = {
  sliceId: SHORT_ID,
  threadId: ID,
  turnId: ID,
};
const MEMBER_TARGET = {
  oneOf: [
    closed({
      ...MEMBER_TARGET_IDENTITY,
      lifecycle: { const: "subagent" },
      memberKind: { const: "joined-subagent" },
      controlSurface: { const: "collaboration" },
      primaryId: { const: "agentPath" },
      agentPath: ID,
    }),
    closed({
      ...MEMBER_TARGET_IDENTITY,
      lifecycle: { const: "spinoff" },
      memberKind: { const: "spinoff" },
      controlSurface: { const: "codex-task" },
      primaryId: { const: "threadId" },
    }),
  ],
};
const LAUNCH_MEMBER_TEXT = {
  type: "string",
  minLength: 1,
  maxLength: 2_000,
  pattern: "[^\\s\\u0000-\\u001f\\u007f]",
};
const LAUNCH_MEMBER_TEXT_LIST = {
  type: "array",
  maxItems: 16,
  items: { ...LAUNCH_MEMBER_TEXT, maxLength: 1_000 },
};
const LAUNCH_MEMBER_BASE = {
  sliceId: SHORT_ID,
  title: { ...LAUNCH_MEMBER_TEXT, maxLength: 512 },
  objective: LAUNCH_MEMBER_TEXT,
  deliverable: LAUNCH_MEMBER_TEXT,
  acceptanceCriteria: { ...LAUNCH_MEMBER_TEXT_LIST, minItems: 1 },
  dependsOn: {
    type: "array",
    maxItems: 100,
    uniqueItems: true,
    items: SHORT_ID,
  },
  nativeTask: NATIVE_TASK,
  routeEnforcement: ROUTE_ENFORCEMENT,
  prompt: TEXT,
};
const SUBAGENT_LAUNCH_MEMBER = closed({
  ...LAUNCH_MEMBER_BASE,
  lifecycle: { const: "subagent" },
  memberKind: { const: "joined-subagent" },
  launcher: { const: "spawn-subagent" },
  titlePolicy: closed({
    mode: { const: "prompt-seeded" },
    recommendedMaxCharacters: POSITIVE,
    verifyAfterLaunch: { const: false },
    evidence: { const: "agent-path" },
    onMismatch: { const: "attention" },
  }),
  agentTaskName: SHORT_ID,
  identityContract: closed({
    lifecycle: { const: "subagent" },
    memberKind: { const: "joined-subagent" },
    primaryId: { const: "agentPath" },
    controlSurface: { const: "collaboration" },
    nativeThreadIdUse: { const: "verification-only" },
    nativeTitleControl: { const: false },
  }),
  workspaceMode: { const: "shared-read-only" },
});
const SPINOFF_WORK_UNIT = closed({
  schemaVersion: VERSION,
  webId: ID,
  queenThreadId: ID,
  workUnitId: SHORT_ID,
  specRevision: POSITIVE,
  attempt: POSITIVE,
  memberKind: { const: "spinoff" },
  capabilities: {
    type: "array",
    minItems: 3,
    maxItems: 4,
    uniqueItems: true,
    items: { enum: ["observe", "read-result", "follow-up", "archive"] },
  },
  launch: closed({
    schemaVersion: VERSION,
    launcher: { const: "create-thread" },
    workspaceMode: { const: "isolated-write" },
    nativeTask: NATIVE_TASK,
    requiresThreadId: { const: true },
    onMissingThreadId: { const: "attention" },
  }),
  title: { ...LAUNCH_MEMBER_TEXT, maxLength: 512 },
  objectiveSummary: LAUNCH_MEMBER_TEXT,
  deliverable: LAUNCH_MEMBER_TEXT,
  acceptanceCriteria: { ...LAUNCH_MEMBER_TEXT_LIST, minItems: 1 },
  dependencies: {
    type: "array",
    maxItems: 100,
    uniqueItems: true,
    items: SHORT_ID,
  },
  required: { type: "boolean" },
  policy: closed({
    maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
    onBlocked: { const: "queen-review" },
    onFailure: { const: "queen-review" },
  }),
});
const SPINOFF_LAUNCH_MEMBER = closed({
  ...LAUNCH_MEMBER_BASE,
  lifecycle: { const: "spinoff" },
  memberKind: { const: "spinoff" },
  launcher: { const: "create-thread" },
  titlePolicy: closed({
    mode: { const: "post-bind-read-set-verify" },
    recommendedMaxCharacters: POSITIVE,
    verifyAfterLaunch: { const: true },
    creationTitleSupported: { const: false },
    promptSeedAuthoritative: { const: false },
    onMismatch: { const: "native-set-title" },
  }),
  identityContract: closed({
    lifecycle: { const: "spinoff" },
    memberKind: { const: "spinoff" },
    primaryId: { const: "threadId" },
    controlSurface: { const: "codex-task" },
    nativeThreadIdUse: { const: "control-and-verification" },
    nativeTitleControl: { const: true },
  }),
  workspaceMode: { const: "isolated-write" },
  orchestration: closed({
    tool: { const: "nelos_orchestrate_create" },
    arguments: closed({
      workUnit: SPINOFF_WORK_UNIT,
      receipt: { type: "null" },
    }),
    bindReceiptType: { const: "native-create" },
  }),
  actionId: ID,
});
const LAUNCH_WAVE_MEMBER = {
  oneOf: [SUBAGENT_LAUNCH_MEMBER, SPINOFF_LAUNCH_MEMBER],
};
const RESULT_LIST = {
  type: "array",
  maxItems: 8,
  items: {
    type: "string",
    minLength: 1,
    maxLength: 500,
    pattern: "[^\\s\\u0000-\\u001f\\u007f]",
  },
};

function resultEnvelope(outcome, blockers) {
  return closed({
    schemaVersion: VERSION,
    workUnitId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    },
    specRevision: POSITIVE,
    attempt: POSITIVE,
    outcome: { const: outcome },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
      pattern: "[^\\s\\u0000-\\u001f\\u007f]",
    },
    artifacts: RESULT_LIST,
    verification: RESULT_LIST,
    blockers,
    recoveryHint: {
      anyOf: [
        { type: "null" },
        {
          type: "string",
          minLength: 1,
          maxLength: 1_000,
          pattern: "[^\\s\\u0000-\\u001f\\u007f]",
        },
      ],
    },
  });
}

export const PROTOCOL_RESULT_ENVELOPE_SCHEMA_V1 = {
  oneOf: [
    resultEnvelope("succeeded", { ...RESULT_LIST, maxItems: 0 }),
    resultEnvelope("blocked", { ...RESULT_LIST, minItems: 1 }),
    resultEnvelope("failed", RESULT_LIST),
  ],
};

const NEXT_ACTION_MEMBERS = [
  discriminated("kind", "launch-planner", {
    member: PLANNER_MEMBER,
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
    bootstrapId: ID,
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
      items: LAUNCH_WAVE_MEMBER,
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
    routeEnforcement: ROUTE_ENFORCEMENT,
  }),
  discriminated("kind", "decide", {
    operation: { const: "author-slice-plan" },
  }),
  discriminated("kind", "decide", {
    operation: { const: "accept-current-results" },
    webId: ID,
    members: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: closed({
        threadId: ID,
        sourceTurnId: NULLABLE_ID,
        workUnitId: { anyOf: [{ type: "null" }, SHORT_ID] },
        result: {
          anyOf: [
            { type: "null" },
            PROTOCOL_RESULT_ENVELOPE_SCHEMA_V1,
          ],
        },
      }),
    },
  }),
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
    expected: ROUTE_EXPECTATION,
    observed: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: ROUTE_OBSERVATION,
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
const OPTIONAL_NATIVE_TASK = closed({
  model: { type: "string", minLength: 1, maxLength: 128 },
  thinking: { type: "string", minLength: 1, maxLength: 32 },
}, []);

function nativeLaunchSchema(memberKind, launcher, workspaceMode) {
  return {
    anyOf: [
      { type: "null" },
      closed({
        schemaVersion: VERSION,
        launcher: { const: launcher },
        workspaceMode: { const: workspaceMode },
        nativeTask: OPTIONAL_NATIVE_TASK,
        requiresThreadId: { const: true },
        onMissingThreadId: { const: "attention" },
      }),
    ],
  };
}

function nativeCreateMember(memberKind, launcher, workspaceMode) {
  return discriminated("type", "native-create", {
    ...EFFECT_IDENTITY,
    scope: { const: "work-unit" },
    memberKind: { const: memberKind },
    launcher: { const: launcher },
    launch: nativeLaunchSchema(memberKind, launcher, workspaceMode),
    title: { type: "string", minLength: 1, maxLength: 512 },
    prompt: NATIVE_CREATE_PROMPT,
    preconditions: closed({
      expectedSpecRevision: POSITIVE,
      expectedBindingState: { const: "unbound" },
      expectedMemberThreadId: { type: "null" },
      expectedSourceTurnId: { type: "null" },
    }),
  });
}

function nativeReconcileCreateMember(memberKind, launcher, workspaceMode) {
  return discriminated("type", "native-reconcile-create", {
    ...EFFECT_IDENTITY,
    scope: { const: "work-unit" },
    createActionId: ID,
    memberKind: { const: memberKind },
    launcher: { const: launcher },
    launch: nativeLaunchSchema(memberKind, launcher, workspaceMode),
    title: { type: "string", minLength: 1, maxLength: 512 },
    prompt: NATIVE_CREATE_PROMPT,
    policy: RECONCILE_POLICY,
  });
}

const EFFECT_MEMBERS = [
  nativeCreateMember("spinoff", "create-thread", "isolated-write"),
  nativeCreateMember("joined-subagent", "spawn-subagent", "shared-read-only"),
  nativeReconcileCreateMember("spinoff", "create-thread", "isolated-write"),
  nativeReconcileCreateMember(
    "joined-subagent",
    "spawn-subagent",
    "shared-read-only",
  ),
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

function waitTarget(lifecycle, latestTurnId) {
  return closed({
    workUnitId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    },
    specRevision: POSITIVE,
    attempt: POSITIVE,
    bindingGeneration: POSITIVE,
    memberThreadId: ID,
    hostId: NULLABLE_ID,
    afterCursor: NULLABLE_ID,
    nextCursor: NULLABLE_ID,
    lifecycle: { const: lifecycle },
    latestTurnId,
    attentionRequired: { type: "boolean" },
  });
}

const WAIT_TARGET_SCHEMA = {
  oneOf: [
    waitTarget("waiting", NULLABLE_ID),
    waitTarget("running", NULLABLE_ID),
    waitTarget("completed", ID),
    waitTarget("failed", ID),
    waitTarget("unavailable", NULLABLE_ID),
  ],
};

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
    response: PLANNER_RESPONSE,
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
      items: WAIT_TARGET_SCHEMA,
    },
  }),
];

RECEIPT_MEMBERS.push(
  discriminated("type", "native-result-read", {
    ...OBSERVATION_IDENTITY,
    requestedTurnId: ID,
    sourceTurnId: ID,
    resultEnvelope: PROTOCOL_RESULT_ENVELOPE_SCHEMA_V1,
  }),
  closed({ threadId: ID }),
  discriminated("type", "native-archive", {
    actionId: ID,
    threadId: ID,
    archived: { const: true },
  }),
);

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
  "repeat-planner-launch-receipt",
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
  "planner.result-not-yet-authorized": code(
    "retryable-attention",
    "repeat-planner-launch-receipt",
  ),
  "semantic.input-required": code("retryable-attention", "request-semantic-input"),
});

export const PROTOCOL_ERROR_SCHEMA_V1 = {
  oneOf: Object.entries(PROTOCOL_CODE_REGISTRY_V1)
    .map(([errorCode, declaration]) =>
      closed({
        schemaVersion: VERSION,
        code: { const: errorCode },
        category: { const: declaration.category },
        message: SHORT_TEXT,
        recoveryCommand: { const: declaration.recoveryCommand },
      })),
};

export const PROTOCOL_ATTENTION_SCHEMA_V1 = {
  oneOf: Object.entries(PROTOCOL_CODE_REGISTRY_V1)
    .map(([attentionCode, declaration]) =>
      closed({
        schemaVersion: VERSION,
        kind: { const: "attention" },
        code: { const: attentionCode },
        message: SHORT_TEXT,
        terminal: { const: declaration.terminal },
        recoveryCommand: { const: declaration.recoveryCommand },
      })),
};

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
    identity: BOUNDED_RECORD,
    route: BOUNDED_RECORD,
    thread: BOUNDED_RECORD,
    latestTurn: { anyOf: [{ type: "null" }, BOUNDED_RECORD] },
    queenTitleSync: BOUNDED_RECORD,
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

function unionFailureScore(message) {
  const path = String(message).split(" ", 1)[0];
  return [...path].filter((character) =>
    character === "." || character === "[").length;
}

function mostRelevantUnionFailure(failures) {
  return failures.reduce((best, failure) =>
    unionFailureScore(failure) >= unionFailureScore(best)
      ? failure
      : best);
}

function validateJson(schema, value, path = "$") {
  if (schema.oneOf) {
    const failures = [];
    const count = schema.oneOf.filter((candidate) => {
      try {
        validateJson(candidate, value, path);
        return true;
      } catch (error) {
        failures.push(error.message);
        return false;
      }
    }).length;
    if (count !== 1) {
      const detail = count === 0
        ? `: ${mostRelevantUnionFailure(failures)}`
        : "";
      throw new Error(`${path} must match exactly one union member${detail}`);
    }
    return value;
  }
  if (schema.anyOf) {
    const failures = [];
    const matched = schema.anyOf.some((candidate) => {
      try {
        validateJson(candidate, value, path);
        return true;
      } catch (error) {
        failures.push(error.message);
        return false;
      }
    });
    if (!matched) {
      throw new Error(
        `${path} does not match an allowed shape: ${
          mostRelevantUnionFailure(failures)
        }`,
      );
    }
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
  if (
    (contract === "receipt" || schema === PROTOCOL_RECEIPT_SCHEMA_V1) &&
    value?.type === "native-result-read"
  ) {
    let serialized;
    try {
      serialized = JSON.stringify(value.resultEnvelope);
    } catch {
      throw new Error("$.resultEnvelope is not serializable");
    }
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > 16 * 1024
    ) {
      throw new Error("$.resultEnvelope exceeds 16384 bytes");
    }
  }
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
  const normalized = validateProtocolContractV1(contract, value);
  return validateProtocolContractV1(PROTOCOL_VALUE_ENVELOPE_SCHEMA_V1, {
    schemaVersion: 1,
    contract,
    value: normalized,
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
    "memberThreadId", "threadId", "webId", "queenThreadId", "bootstrapId",
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
      receipt.sourceTurnId !== action.requestedTurnId ||
      ["workUnitId", "specRevision", "attempt"].some(
        (field) => !isDeepStrictEqual(
          receipt.resultEnvelope[field],
          action[field],
        ),
      ))
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
        return !actual ||
          [
            "workUnitId", "specRevision", "attempt", "bindingGeneration",
            "memberThreadId", "afterCursor",
          ].some(
            (field) => !isDeepStrictEqual(expected[field], actual[field]),
          ) ||
          (
            expected.hostId !== null &&
            !isDeepStrictEqual(expected.hostId, actual.hostId)
          );
      })
    ) return "receipt.conflicting";
  }
  if (
    action.kind === "native-read-subagent-result" &&
    (receipt.bootstrapId !== action.bootstrapId ||
      receipt.threadId !== action.threadId ||
      receipt.turnId !== action.turnId)
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
  const replay = state.consumedReceipts.find(
    ({ actionId, digest: value }) =>
      actionId === executable.value.actionId && value === digest,
  );
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
      "receipt.conflicting",
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
  let normalized;
  try {
    normalized = validateProtocolContractV1("error", error);
  } catch (cause) {
    return {
      ...transitionError("protocol.malformed", cause.message),
      command: null,
    };
  }
  const declaration = PROTOCOL_CODE_REGISTRY_V1[normalized.code];
  if (!RECOVERY_COMMANDS_V1.includes(command)) {
    return {
      ...transitionError("protocol.malformed", "unknown recovery command"),
      command: null,
    };
  }
  if (
    declaration.category !== normalized.category ||
    declaration.recoveryCommand !== command ||
    normalized.recoveryCommand !== command
  ) {
    return {
      ...transitionError(
        declaration.recoveryCommand === null
          ? "attention.terminal"
          : "receipt.conflicting",
        "recovery command is forbidden",
      ),
      command: null,
    };
  }
  return {
    accepted: true,
    replayed: false,
    state: null,
    command,
    error: null,
  };
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
