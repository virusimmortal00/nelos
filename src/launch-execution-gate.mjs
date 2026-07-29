import { createHash } from "node:crypto";

export const LAUNCH_EXECUTION_GATE_SCHEMA_VERSION = 1;
export const LAUNCH_AUTHORIZATION_RECEIPT_TYPE =
  "native-launch-authorization";

const RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "type",
  "source",
  "actionId",
  "planRunId",
  "waveIndex",
  "waveDigest",
  "members",
]);
const MEMBER_FIELDS = new Set([
  "sliceId",
  "lifecycle",
  "memberKind",
  "launcher",
  "workspaceMode",
  "nativeTask",
  "launcherAvailable",
  "taskKindSupported",
  "workspaceModeSupported",
  "modelSupported",
  "reasoningSupported",
  "creationAuthorized",
]);
const NATIVE_TASK_FIELDS = new Set(["model", "thinking"]);
const IDENTIFIER = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const PLAN_RUN_ID = /^run:[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function exactObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
  return value;
}

function identifier(value, field, pattern = IDENTIFIER) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function boolean(value, field) {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function nativeTask(value, field) {
  exactObject(value, field, NATIVE_TASK_FIELDS);
  return {
    model: identifier(value.model, `${field}.model`),
    thinking: identifier(value.thinking, `${field}.thinking`),
  };
}

function requirement(member) {
  return {
    sliceId: member.sliceId,
    lifecycle: member.lifecycle,
    memberKind: member.memberKind,
    launcher: member.launcher,
    workspaceMode: member.workspaceMode,
    nativeTask: { ...member.nativeTask },
  };
}

function receiptMember(value, index) {
  const field = `launch authorization members[${index}]`;
  exactObject(value, field, MEMBER_FIELDS);
  return {
    sliceId: identifier(value.sliceId, `${field}.sliceId`),
    lifecycle: identifier(value.lifecycle, `${field}.lifecycle`),
    memberKind: identifier(value.memberKind, `${field}.memberKind`),
    launcher: identifier(value.launcher, `${field}.launcher`),
    workspaceMode: identifier(value.workspaceMode, `${field}.workspaceMode`),
    nativeTask: nativeTask(value.nativeTask, `${field}.nativeTask`),
    launcherAvailable: boolean(
      value.launcherAvailable,
      `${field}.launcherAvailable`,
    ),
    taskKindSupported: boolean(
      value.taskKindSupported,
      `${field}.taskKindSupported`,
    ),
    workspaceModeSupported: boolean(
      value.workspaceModeSupported,
      `${field}.workspaceModeSupported`,
    ),
    modelSupported: boolean(value.modelSupported, `${field}.modelSupported`),
    reasoningSupported: boolean(
      value.reasoningSupported,
      `${field}.reasoningSupported`,
    ),
    creationAuthorized: boolean(
      value.creationAuthorized,
      `${field}.creationAuthorized`,
    ),
  };
}

function normalizeReceipt(value) {
  exactObject(value, "launch authorization receipt", RECEIPT_FIELDS);
  if (value.schemaVersion !== LAUNCH_EXECUTION_GATE_SCHEMA_VERSION) {
    throw new Error(
      `launch authorization schemaVersion must be ${LAUNCH_EXECUTION_GATE_SCHEMA_VERSION}`,
    );
  }
  if (value.type !== LAUNCH_AUTHORIZATION_RECEIPT_TYPE) {
    throw new Error("launch authorization receipt type is unsupported");
  }
  if (value.source !== "native-host") {
    throw new Error("launch authorization receipt source must be native-host");
  }
  if (!Number.isSafeInteger(value.waveIndex) || value.waveIndex < 1) {
    throw new Error("launch authorization waveIndex must be positive");
  }
  if (
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 16
  ) {
    throw new Error("launch authorization must contain between 1 and 16 members");
  }
  const members = value.members.map(receiptMember);
  if (new Set(members.map(({ sliceId }) => sliceId)).size !== members.length) {
    throw new Error("launch authorization member slice IDs must be unique");
  }
  return {
    schemaVersion: LAUNCH_EXECUTION_GATE_SCHEMA_VERSION,
    type: LAUNCH_AUTHORIZATION_RECEIPT_TYPE,
    source: "native-host",
    actionId: identifier(value.actionId, "launch authorization actionId"),
    planRunId: identifier(
      value.planRunId,
      "launch authorization planRunId",
      PLAN_RUN_ID,
    ),
    waveIndex: value.waveIndex,
    waveDigest: identifier(
      value.waveDigest,
      "launch authorization waveDigest",
      DIGEST,
    ),
    members,
  };
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function launchAuthorizationActionIdV1(verification) {
  return [
    "launch-authorization",
    verification.planRunId.slice("run:".length),
    verification.waveIndex,
    verification.waveDigest.slice(0, 16),
  ].join(":");
}

function proposalFor(action) {
  return {
    actionId: launchAuthorizationActionIdV1(action.verification),
    verification: { ...action.verification },
    members: action.members.map(requirement),
  };
}

function attention(reason, proposal, fields = {}) {
  return {
    schemaVersion: 1,
    kind: "attention",
    reason,
    actionId: proposal.actionId,
    ...fields,
  };
}

/**
 * Convert a proposed launch wave into an executable action only after one
 * exact, wave-bound receipt from the native host attests every member.
 */
export function gateLaunchWaveActionV1(action, receipt = null) {
  if (action?.kind !== "launch-wave" || !Array.isArray(action.members)) {
    throw new Error("launch execution gate requires a proposed launch-wave");
  }
  const proposal = proposalFor(action);
  if (receipt === null || receipt === undefined) {
    return {
      schemaVersion: 1,
      kind: "authorization-required",
      reason: "launch-authorization-evidence-required",
      actionId: proposal.actionId,
      receiptType: LAUNCH_AUTHORIZATION_RECEIPT_TYPE,
      source: "native-host",
      verification: proposal.verification,
      members: proposal.members,
    };
  }

  let evidence;
  try {
    evidence = normalizeReceipt(receipt);
  } catch {
    return attention("invalid-launch-authorization", proposal);
  }
  if (
    evidence.actionId !== proposal.actionId ||
    evidence.planRunId !== proposal.verification.planRunId ||
    evidence.waveIndex !== proposal.verification.waveIndex ||
    evidence.waveDigest !== proposal.verification.waveDigest
  ) {
    return attention("stale-launch-authorization", proposal);
  }
  if (evidence.members.length !== proposal.members.length) {
    return attention("launch-authorization-member-mismatch", proposal);
  }

  for (const expected of proposal.members) {
    const observed = evidence.members.find(
      ({ sliceId }) => sliceId === expected.sliceId,
    );
    if (
      !observed ||
      observed.lifecycle !== expected.lifecycle ||
      observed.memberKind !== expected.memberKind ||
      observed.launcher !== expected.launcher ||
      observed.workspaceMode !== expected.workspaceMode ||
      observed.nativeTask.model !== expected.nativeTask.model ||
      observed.nativeTask.thinking !== expected.nativeTask.thinking
    ) {
      return attention("launch-authorization-member-mismatch", proposal, {
        sliceIds: [expected.sliceId],
      });
    }
  }

  const availabilityChecks = [
    ["launcherAvailable", "launcher"],
    ["taskKindSupported", "task-kind"],
    ["workspaceModeSupported", "workspace-mode"],
    ["modelSupported", "model"],
    ["reasoningSupported", "reasoning-route"],
  ];
  for (const expected of proposal.members) {
    const observed = evidence.members.find(
      ({ sliceId }) => sliceId === expected.sliceId,
    );
    for (const [field, capability] of availabilityChecks) {
      if (!observed[field]) {
        return {
          schemaVersion: 1,
          kind: "execution-unavailable",
          reason: "launch-capability-unavailable",
          actionId: proposal.actionId,
          sliceId: expected.sliceId,
          launcher: expected.launcher,
          capability,
        };
      }
    }
  }
  const unauthorized = proposal.members.find((expected) => {
    const observed = evidence.members.find(
      ({ sliceId }) => sliceId === expected.sliceId,
    );
    return observed.creationAuthorized !== true;
  });
  if (unauthorized) {
    return {
      schemaVersion: 1,
      kind: "authorization-required",
      reason: "task-creation-not-authorized",
      actionId: proposal.actionId,
      receiptType: LAUNCH_AUTHORIZATION_RECEIPT_TYPE,
      source: "native-host",
      verification: proposal.verification,
      members: proposal.members,
      sliceId: unauthorized.sliceId,
      launcher: unauthorized.launcher,
    };
  }

  return {
    ...action,
    executionGate: {
      schemaVersion: LAUNCH_EXECUTION_GATE_SCHEMA_VERSION,
      actionId: proposal.actionId,
      evidenceDigest: digest(evidence),
    },
  };
}

const RECEIPT_MEMBER_PROPERTIES = {
  sliceId: { type: "string" },
  lifecycle: { enum: ["spinoff", "subagent"] },
  memberKind: { enum: ["spinoff", "joined-subagent"] },
  launcher: { enum: ["create-thread", "spawn-subagent"] },
  workspaceMode: { enum: ["isolated-write", "shared-read-only"] },
  nativeTask: {
    type: "object",
    properties: {
      model: { type: "string" },
      thinking: { type: "string" },
    },
    required: ["model", "thinking"],
    additionalProperties: false,
  },
  launcherAvailable: { type: "boolean" },
  taskKindSupported: { type: "boolean" },
  workspaceModeSupported: { type: "boolean" },
  modelSupported: { type: "boolean" },
  reasoningSupported: { type: "boolean" },
  creationAuthorized: { type: "boolean" },
};

export const LAUNCH_AUTHORIZATION_RECEIPT_SCHEMA = Object.freeze({
  anyOf: [
    { type: "null" },
    {
      type: "object",
      properties: {
        schemaVersion: { const: LAUNCH_EXECUTION_GATE_SCHEMA_VERSION },
        type: { const: LAUNCH_AUTHORIZATION_RECEIPT_TYPE },
        source: { const: "native-host" },
        actionId: { type: "string" },
        planRunId: { type: "string", pattern: "^run:[a-f0-9]{40}$" },
        waveIndex: { type: "integer", minimum: 1 },
        waveDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        members: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            properties: RECEIPT_MEMBER_PROPERTIES,
            required: Object.keys(RECEIPT_MEMBER_PROPERTIES),
            additionalProperties: false,
          },
        },
      },
      required: [
        "schemaVersion",
        "type",
        "source",
        "actionId",
        "planRunId",
        "waveIndex",
        "waveDigest",
        "members",
      ],
      additionalProperties: false,
    },
  ],
});
