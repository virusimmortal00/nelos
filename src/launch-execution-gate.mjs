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
const REQUEST_FIELDS = new Set([
  "schemaVersion",
  "type",
  "actionId",
  "verification",
  "members",
]);
const VERIFICATION_FIELDS = new Set([
  "planRunId",
  "waveIndex",
  "waveDigest",
]);
const CAPABILITIES_FIELDS = new Set(["source", "launchers"]);
const LAUNCHER_CAPABILITY_FIELDS = new Set([
  "launcher",
  "memberKinds",
  "workspaceModes",
  "routes",
]);
const ROUTE_CAPABILITY_FIELDS = new Set([
  "model",
  "reasoningEfforts",
]);
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

function enumValue(value, field, allowed) {
  const normalized = identifier(value, field);
  if (!allowed.has(normalized)) {
    throw new Error(`${field} is unsupported`);
  }
  return normalized;
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

function requirementMember(value, index) {
  const field = `launch authorization request members[${index}]`;
  exactObject(value, field, new Set([
    "sliceId",
    "lifecycle",
    "memberKind",
    "launcher",
    "workspaceMode",
    "nativeTask",
  ]));
  return {
    sliceId: identifier(value.sliceId, `${field}.sliceId`),
    lifecycle: enumValue(
      value.lifecycle,
      `${field}.lifecycle`,
      new Set(["spinoff", "subagent"]),
    ),
    memberKind: enumValue(
      value.memberKind,
      `${field}.memberKind`,
      new Set(["spinoff", "joined-subagent"]),
    ),
    launcher: enumValue(
      value.launcher,
      `${field}.launcher`,
      new Set(["create-thread", "spawn-subagent"]),
    ),
    workspaceMode: enumValue(
      value.workspaceMode,
      `${field}.workspaceMode`,
      new Set(["isolated-write", "shared-read-only"]),
    ),
    nativeTask: nativeTask(value.nativeTask, `${field}.nativeTask`),
  };
}

function normalizeVerification(value, field) {
  exactObject(value, field, VERIFICATION_FIELDS);
  if (!Number.isSafeInteger(value.waveIndex) || value.waveIndex < 1) {
    throw new Error(`${field}.waveIndex must be positive`);
  }
  return {
    planRunId: identifier(
      value.planRunId,
      `${field}.planRunId`,
      PLAN_RUN_ID,
    ),
    waveIndex: value.waveIndex,
    waveDigest: identifier(
      value.waveDigest,
      `${field}.waveDigest`,
      DIGEST,
    ),
  };
}

function normalizeAuthorizationRequest(value) {
  exactObject(value, "launch authorization request", REQUEST_FIELDS);
  if (value.schemaVersion !== LAUNCH_EXECUTION_GATE_SCHEMA_VERSION) {
    throw new Error(
      `launch authorization request schemaVersion must be ${LAUNCH_EXECUTION_GATE_SCHEMA_VERSION}`,
    );
  }
  if (value.type !== "native-authorize-launch") {
    throw new Error("launch authorization request type is unsupported");
  }
  if (
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 16
  ) {
    throw new Error(
      "launch authorization request must contain between 1 and 16 members",
    );
  }
  const verification = normalizeVerification(
    value.verification,
    "launch authorization request verification",
  );
  const members = value.members.map(requirementMember);
  if (new Set(members.map(({ sliceId }) => sliceId)).size !== members.length) {
    throw new Error(
      "launch authorization request member slice IDs must be unique",
    );
  }
  const actionId = identifier(
    value.actionId,
    "launch authorization request actionId",
  );
  if (
    actionId !== launchAuthorizationActionIdV1(verification)
  ) {
    throw new Error("launch authorization request actionId is not canonical");
  }
  return {
    schemaVersion: LAUNCH_EXECUTION_GATE_SCHEMA_VERSION,
    type: "native-authorize-launch",
    actionId,
    verification,
    members,
  };
}

function stringList(value, field, maximum, allowed = null) {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${field} must be a bounded unique array`);
  }
  return value.map((item, index) => {
    const normalized = identifier(item, `${field}[${index}]`);
    if (allowed && !allowed.has(normalized)) {
      throw new Error(`${field}[${index}] is unsupported`);
    }
    return normalized;
  });
}

function routeCapability(value, launcherIndex, routeIndex) {
  const field =
    `native host launchers[${launcherIndex}].routes[${routeIndex}]`;
  exactObject(value, field, ROUTE_CAPABILITY_FIELDS);
  return {
    model: identifier(value.model, `${field}.model`),
    reasoningEfforts: stringList(
      value.reasoningEfforts,
      `${field}.reasoningEfforts`,
      16,
    ),
  };
}

function launcherCapability(value, index) {
  const field = `native host launchers[${index}]`;
  exactObject(value, field, LAUNCHER_CAPABILITY_FIELDS);
  if (
    !Array.isArray(value.routes) ||
    value.routes.length > 32
  ) {
    throw new Error(`${field}.routes must be a bounded array`);
  }
  const routes = value.routes.map((route, routeIndex) =>
    routeCapability(route, index, routeIndex));
  const routeKeys = routes.map(({ model }) => model);
  if (new Set(routeKeys).size !== routeKeys.length) {
    throw new Error(`${field}.routes must be unique`);
  }
  return {
    launcher: enumValue(
      value.launcher,
      `${field}.launcher`,
      new Set(["create-thread", "spawn-subagent"]),
    ),
    memberKinds: stringList(
      value.memberKinds,
      `${field}.memberKinds`,
      8,
      new Set(["spinoff", "joined-subagent"]),
    ),
    workspaceModes: stringList(
      value.workspaceModes,
      `${field}.workspaceModes`,
      8,
      new Set(["isolated-write", "shared-read-only"]),
    ),
    routes,
  };
}

function normalizeHostCapabilities(value) {
  exactObject(value, "native host capabilities", CAPABILITIES_FIELDS);
  if (value.source !== "native-host-tool-registry") {
    throw new Error(
      "native host capability source must be native-host-tool-registry",
    );
  }
  if (
    !Array.isArray(value.launchers) ||
    value.launchers.length > 8
  ) {
    throw new Error("native host launchers must be a bounded array");
  }
  const launchers = value.launchers.map(launcherCapability);
  if (
    new Set(launchers.map(({ launcher }) => launcher)).size !== launchers.length
  ) {
    throw new Error("native host launchers must be unique");
  }
  return {
    source: "native-host-tool-registry",
    launchers,
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

function authorizationRequestFor(proposal) {
  return {
    schemaVersion: LAUNCH_EXECUTION_GATE_SCHEMA_VERSION,
    type: "native-authorize-launch",
    actionId: proposal.actionId,
    verification: { ...proposal.verification },
    members: proposal.members.map((member) => ({
      ...member,
      nativeTask: { ...member.nativeTask },
    })),
  };
}

function authorizationEffectFor(proposal) {
  return {
    schemaVersion: LAUNCH_EXECUTION_GATE_SCHEMA_VERSION,
    type: "native-authorize-launch",
    actionId: proposal.actionId,
    tool: "nelos_launch_authorize",
    arguments: {
      request: authorizationRequestFor(proposal),
    },
    requiredHostInputs: ["capabilities", "userIntentConfirmed"],
    receiptType: LAUNCH_AUTHORIZATION_RECEIPT_TYPE,
  };
}

function proposalFor(action) {
  return {
    actionId: launchAuthorizationActionIdV1(action.verification),
    verification: { ...action.verification },
    members: action.members.map(requirement),
  };
}

/**
 * Produce the exact receipt expected by the execution gate from bounded
 * capability metadata supplied by the native host tool registry. Calling the
 * MCP tool that wraps this producer is the explicit user-authorization step.
 */
export function createLaunchAuthorizationReceiptV1({
  request,
  capabilities,
  userIntentConfirmed,
}) {
  const normalizedRequest = normalizeAuthorizationRequest(request);
  const normalizedCapabilities = normalizeHostCapabilities(capabilities);
  if (typeof userIntentConfirmed !== "boolean") {
    throw new Error("userIntentConfirmed must be a boolean");
  }
  return {
    schemaVersion: LAUNCH_EXECUTION_GATE_SCHEMA_VERSION,
    type: LAUNCH_AUTHORIZATION_RECEIPT_TYPE,
    source: "native-host",
    actionId: normalizedRequest.actionId,
    planRunId: normalizedRequest.verification.planRunId,
    waveIndex: normalizedRequest.verification.waveIndex,
    waveDigest: normalizedRequest.verification.waveDigest,
    members: normalizedRequest.members.map((member) => {
      const launcher = normalizedCapabilities.launchers.find(
        (candidate) => candidate.launcher === member.launcher,
      );
      const model = launcher?.routes.find(
        (candidate) => candidate.model === member.nativeTask.model,
      );
      return {
        ...member,
        launcherAvailable: launcher !== undefined,
        taskKindSupported:
          launcher?.memberKinds.includes(member.memberKind) ?? false,
        workspaceModeSupported:
          launcher?.workspaceModes.includes(member.workspaceMode) ?? false,
        modelSupported: model !== undefined,
        reasoningSupported:
          model?.reasoningEfforts.includes(member.nativeTask.thinking) ?? false,
        creationAuthorized: userIntentConfirmed,
      };
    }),
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
      authorizationEffect: authorizationEffectFor(proposal),
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
      authorizationEffect: authorizationEffectFor(proposal),
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

const AUTHORIZATION_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: {
      const: LAUNCH_EXECUTION_GATE_SCHEMA_VERSION,
    },
    type: { const: "native-authorize-launch" },
    actionId: { type: "string" },
    verification: {
      type: "object",
      properties: {
        planRunId: { type: "string", pattern: "^run:[a-f0-9]{40}$" },
        waveIndex: { type: "integer", minimum: 1 },
        waveDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["planRunId", "waveIndex", "waveDigest"],
      additionalProperties: false,
    },
    members: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(RECEIPT_MEMBER_PROPERTIES).filter(
            ([field]) => ![
              "launcherAvailable",
              "taskKindSupported",
              "workspaceModeSupported",
              "modelSupported",
              "reasoningSupported",
              "creationAuthorized",
            ].includes(field),
          ),
        ),
        required: [
          "sliceId",
          "lifecycle",
          "memberKind",
          "launcher",
          "workspaceMode",
          "nativeTask",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "schemaVersion",
    "type",
    "actionId",
    "verification",
    "members",
  ],
  additionalProperties: false,
};

export const LAUNCH_AUTHORIZATION_PRODUCER_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    request: AUTHORIZATION_REQUEST_SCHEMA,
    capabilities: {
      type: "object",
      properties: {
        source: { const: "native-host-tool-registry" },
        launchers: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              launcher: {
                enum: ["create-thread", "spawn-subagent"],
              },
              memberKinds: {
                type: "array",
                maxItems: 8,
                uniqueItems: true,
                items: {
                  enum: ["spinoff", "joined-subagent"],
                },
              },
              workspaceModes: {
                type: "array",
                maxItems: 8,
                uniqueItems: true,
                items: {
                  enum: ["isolated-write", "shared-read-only"],
                },
              },
              routes: {
                type: "array",
                maxItems: 32,
                items: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    reasoningEfforts: {
                      type: "array",
                      maxItems: 16,
                      uniqueItems: true,
                      items: { type: "string" },
                    },
                  },
                  required: ["model", "reasoningEfforts"],
                  additionalProperties: false,
                },
              },
            },
            required: [
              "launcher",
              "memberKinds",
              "workspaceModes",
              "routes",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["source", "launchers"],
      additionalProperties: false,
    },
    userIntentConfirmed: { type: "boolean" },
  },
  required: ["request", "capabilities", "userIntentConfirmed"],
  additionalProperties: false,
});
