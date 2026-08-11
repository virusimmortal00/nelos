import { readFileSync } from "node:fs";

import {
  MCP_PROTOCOL_TOOL_OUTPUT_SCHEMAS_V1,
  PROTOCOL_ACTION_SCHEMA_V1,
} from "./protocol-contract/index.mjs";
import { assertWebId, titleLineageId } from "./task-web.mjs";

export const EXECUTION_MAP_SCHEMA_VERSION = 1;
export const EXECUTION_MAP_RESOURCE_URI =
  "ui://nelos/execution-map-v15.html";
export const EXECUTION_MAP_RESOURCE_MIME_TYPE =
  "text/html;profile=mcp-app";
export const PLAN_SUMMARY_RESOURCE_URI =
  "ui://nelos/plan-summary-v1.html";
export const ACTION_RECEIPT_RESOURCE_URI =
  "ui://nelos/action-receipt-v2.html";

export const EXECUTION_MAP_STATUSES = Object.freeze([
  "planning",
  "planned",
  "authorization-required",
  "launch-pending",
  "created",
  "unknown",
  "running",
  "attention",
  "complete",
  "accepted",
  "archiving",
  "archived",
  "kept",
]);

export const EXECUTION_MAP_TOOL_NAMES = Object.freeze(new Set([
  "nelos_plan_bootstrap",
  "nelos_plan_lifecycle",
  "nelos_plan_replan",
  "nelos_plan_slices",
  "nelos_orchestrate_create",
  "nelos_orchestrate_advance",
  "nelos_launch_verify_batch",
  "nelos_queen_decide",
  "nelos_spinoff_complete",
  "nelos_spinoff_cleanup",
  "nelos_execution_map_refresh",
  "nelos_execution_map_history",
]));

export const PLAN_SUMMARY_TOOL_NAMES = Object.freeze(new Set([
  "nelos_plan_bootstrap",
  "nelos_plan_lifecycle",
  "nelos_plan_replan",
  "nelos_plan_slices",
]));

export const ACTION_RECEIPT_TOOL_NAMES = Object.freeze(new Set([
  "nelos_queen_decide",
  "nelos_spinoff_complete",
  "nelos_spinoff_cleanup",
]));

const EXECUTION_MAP_PHASE_SCHEMA = Object.freeze({
  enum: EXECUTION_MAP_STATUSES,
});

const MEMBER_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    id: { type: "string" },
    task: { type: "string" },
    lifecycle: { enum: ["spinoff", "subagent"] },
    model: { type: "string" },
    reasoning: { type: "string" },
    status: EXECUTION_MAP_PHASE_SCHEMA,
    threadId: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
  },
  required: [
    "id",
    "task",
    "lifecycle",
    "model",
    "reasoning",
    "status",
    "threadId",
  ],
  additionalProperties: false,
});

const ACTION_RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    nextAction: PROTOCOL_ACTION_SCHEMA_V1,
  },
  required: ["nextAction"],
  additionalProperties: true,
});

const REFRESH_MEMBER_PROPERTIES = Object.freeze({
  id: { type: "string", minLength: 1, maxLength: 128 },
  task: { type: "string", minLength: 1, maxLength: 500 },
  lifecycle: { enum: ["spinoff", "subagent"] },
  model: { type: "string", minLength: 1, maxLength: 128 },
  reasoning: { type: "string", minLength: 1, maxLength: 64 },
  threadId: { type: "string", minLength: 1, maxLength: 512 },
  turnId: { type: "string", minLength: 1, maxLength: 512 },
});

const REFRESH_MEMBER_REQUIRED = Object.freeze(
  Object.keys(REFRESH_MEMBER_PROPERTIES),
);

const REFRESH_INPUT_FIELDS = Object.freeze(new Set(["task", "members"]));
const REFRESH_MEMBER_FIELDS = Object.freeze(
  new Set(REFRESH_MEMBER_REQUIRED),
);

export const EXECUTION_MAP_REFRESH_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    task: { type: "string", minLength: 1, maxLength: 1_000 },
    members: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        properties: REFRESH_MEMBER_PROPERTIES,
        required: REFRESH_MEMBER_REQUIRED,
        additionalProperties: false,
      },
    },
  },
  required: ["task", "members"],
  additionalProperties: false,
});

const REFRESH_RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    command: { const: "execution map refresh" },
    task: { type: "string" },
    members: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ...REFRESH_MEMBER_PROPERTIES,
          status: {
            enum: ["running", "complete", "attention"],
          },
          observedTurnId: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
          observedTurnStatus: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
        },
        required: [
          ...REFRESH_MEMBER_REQUIRED,
          "status",
          "observedTurnId",
          "observedTurnStatus",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["command", "task", "members"],
  additionalProperties: false,
});

export const EXECUTION_MAP_HISTORY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    schemaVersion: { const: EXECUTION_MAP_SCHEMA_VERSION },
    webId: {
      type: "string",
      pattern:
        "^(?:[1-9A-Fa-f][0-9A-Fa-f]*|[A-Za-z][1-9]\\d*)(?:\\.[1-9]\\d*)*$",
    },
    queenThreadId: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["schemaVersion", "webId", "queenThreadId"],
  additionalProperties: false,
});

const HISTORY_RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    command: { const: "execution map history" },
    webId: { type: "string" },
    queenThreadId: { type: "string" },
    phase: EXECUTION_MAP_PHASE_SCHEMA,
    task: { type: "string" },
    members: { type: "array", items: MEMBER_SCHEMA },
  },
  required: [
    "command",
    "webId",
    "queenThreadId",
    "phase",
    "task",
    "members",
  ],
  additionalProperties: false,
});

function protocolResultSchemaV1(toolName) {
  if (toolName === "nelos_execution_map_refresh") {
    return REFRESH_RESULT_SCHEMA;
  }
  if (toolName === "nelos_execution_map_history") {
    return HISTORY_RESULT_SCHEMA;
  }
  return MCP_PROTOCOL_TOOL_OUTPUT_SCHEMAS_V1[toolName] ??
    ACTION_RESULT_SCHEMA;
}

function protocolSchemaV1(toolName) {
  return {
    type: "object",
    properties: {
      schemaVersion: { const: 1 },
      tool: { const: toolName },
      result: protocolResultSchemaV1(toolName),
    },
    required: ["schemaVersion", "tool", "result"],
    additionalProperties: false,
  };
}

const EXECUTION_MAP_PROPERTIES = Object.freeze({
  schemaVersion: { const: EXECUTION_MAP_SCHEMA_VERSION },
  view: { const: "execution-map" },
  phase: EXECUTION_MAP_PHASE_SCHEMA,
  task: { type: "string" },
  summary: {
    type: "object",
    properties: {
      total: { type: "integer", minimum: 0 },
      spinoffs: { type: "integer", minimum: 0 },
      subagents: { type: "integer", minimum: 0 },
      created: { type: "integer", minimum: 0 },
      archived: { type: "integer", minimum: 0 },
      running: { type: "integer", minimum: 0 },
      attention: { type: "integer", minimum: 0 },
      complete: { type: "integer", minimum: 0 },
      accepted: { type: "integer", minimum: 0 },
    },
    required: ["total", "spinoffs", "subagents", "created"],
    additionalProperties: false,
  },
  members: {
    type: "array",
    items: MEMBER_SCHEMA,
  },
});

const EXECUTION_MAP_REQUIRED = Object.freeze([
  "schemaVersion",
  "view",
  "phase",
  "task",
  "summary",
  "members",
  "protocol",
]);

export function executionMapOutputSchemaForToolV1(toolName) {
  if (!EXECUTION_MAP_TOOL_NAMES.has(toolName)) return null;
  return {
    type: "object",
    properties: {
      ...EXECUTION_MAP_PROPERTIES,
      protocol: protocolSchemaV1(toolName),
    },
    required: [...EXECUTION_MAP_REQUIRED],
    additionalProperties: false,
  };
}

export const EXECUTION_MAP_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    ...EXECUTION_MAP_PROPERTIES,
    protocol: {
      oneOf: [...EXECUTION_MAP_TOOL_NAMES].map(protocolSchemaV1),
    },
  },
  required: [...EXECUTION_MAP_REQUIRED],
  additionalProperties: false,
});

function planSummaryOutputSchemaForToolV1(toolName) {
  return {
    type: "object",
    properties: {
      ...EXECUTION_MAP_PROPERTIES,
      view: { const: "plan-summary" },
      protocol: protocolSchemaV1(toolName),
    },
    required: [...EXECUTION_MAP_REQUIRED],
    additionalProperties: false,
  };
}

function actionReceiptOutputSchemaForToolV1(toolName) {
  return {
    type: "object",
    properties: {
      schemaVersion: { const: EXECUTION_MAP_SCHEMA_VERSION },
      view: { const: "action-receipt" },
      kind: { enum: ["decision", "completion", "cleanup"] },
      status: EXECUTION_MAP_PHASE_SCHEMA,
      title: { type: "string" },
      detail: { type: "string" },
      metrics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: {
              anyOf: [{ type: "string" }, { type: "integer" }],
            },
          },
          required: ["label", "value"],
          additionalProperties: false,
        },
      },
      protocol: protocolSchemaV1(toolName),
    },
    required: [
      "schemaVersion",
      "view",
      "kind",
      "status",
      "title",
      "detail",
      "metrics",
      "protocol",
    ],
    additionalProperties: false,
  };
}

export function mcpVisualOutputSchemaForToolV1(toolName) {
  if (PLAN_SUMMARY_TOOL_NAMES.has(toolName)) {
    return planSummaryOutputSchemaForToolV1(toolName);
  }
  if (ACTION_RECEIPT_TOOL_NAMES.has(toolName)) {
    return actionReceiptOutputSchemaForToolV1(toolName);
  }
  return executionMapOutputSchemaForToolV1(toolName);
}

const EXECUTION_MAP_HTML = readFileSync(
  new URL("../assets/execution-map.html", import.meta.url),
  "utf8",
);
const PLAN_SUMMARY_HTML = readFileSync(
  new URL("../assets/plan-summary.html", import.meta.url),
  "utf8",
);
const ACTION_RECEIPT_HTML = readFileSync(
  new URL("../assets/action-receipt.html", import.meta.url),
  "utf8",
);

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function route(nativeTask = null) {
  return {
    model: text(nativeTask?.model, "host-default"),
    reasoning: text(nativeTask?.thinking, "host-default"),
  };
}

function refreshStatus(latestTurn, expectedTurnId) {
  if (!latestTurn || latestTurn.turnId !== expectedTurnId) {
    return "attention";
  }
  const status = String(latestTurn.status ?? "")
    .replaceAll(/[-_\s]/gu, "")
    .toLowerCase();
  if (["completed", "complete", "succeeded"].includes(status)) {
    return "complete";
  }
  if (["inprogress", "running", "active"].includes(status)) {
    return "running";
  }
  return "attention";
}

function validateRefreshString(value, schema, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > schema.maxLength) {
    throw new Error(`${label} exceeds ${schema.maxLength} characters`);
  }
}

function validateRefreshInput(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("execution-map refresh input must be an object");
  }
  const unknown = Object.keys(args).find(
    (field) => !REFRESH_INPUT_FIELDS.has(field),
  );
  if (unknown) {
    throw new Error(`execution-map refresh contains unknown field: ${unknown}`);
  }
  validateRefreshString(
    args.task,
    EXECUTION_MAP_REFRESH_INPUT_SCHEMA.properties.task,
    "execution-map refresh task",
  );
  if (
    !Array.isArray(args.members) ||
    args.members.length < 1 ||
    args.members.length > 16
  ) {
    throw new Error("execution-map refresh members must contain 1 to 16 items");
  }
  for (const [index, member] of args.members.entries()) {
    const label = `execution-map refresh members[${index}]`;
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw new Error(`${label} must be an object`);
    }
    const memberUnknown = Object.keys(member).find(
      (field) => !REFRESH_MEMBER_FIELDS.has(field),
    );
    if (memberUnknown) {
      throw new Error(`${label} contains unknown field: ${memberUnknown}`);
    }
    for (const field of REFRESH_MEMBER_REQUIRED) {
      const schema = REFRESH_MEMBER_PROPERTIES[field];
      if (schema.enum) {
        if (!schema.enum.includes(member[field])) {
          throw new Error(`${label}.${field} is invalid`);
        }
      } else {
        validateRefreshString(member[field], schema, `${label}.${field}`);
      }
    }
  }
}

export async function refreshExecutionMapStatusV1(
  args,
  { appServerBridge } = {},
) {
  validateRefreshInput(args);
  for (const field of ["id", "threadId", "turnId"]) {
    if (new Set(args.members.map((member) => member[field])).size !==
      args.members.length) {
      throw new Error(`execution-map refresh contains duplicate ${field}`);
    }
  }
  if (
    !appServerBridge ||
    typeof appServerBridge.latestTurn !== "function"
  ) {
    throw new Error("execution-map refresh requires app-server turn evidence");
  }
  const members = await Promise.all(args.members.map(async (member) => {
    let latestTurn = null;
    try {
      latestTurn = await appServerBridge.latestTurn({
        threadId: member.threadId,
      });
    } catch {
      // A bounded unavailable read is visible as attention, never completion.
    }
    return {
      ...member,
      status: refreshStatus(latestTurn, member.turnId),
      observedTurnId: text(latestTurn?.turnId, null),
      observedTurnStatus: text(latestTurn?.status, null),
    };
  }));
  return {
    command: "execution map refresh",
    task: args.task,
    members,
  };
}

function summary(members) {
  return {
    total: members.length,
    spinoffs: members.filter(({ lifecycle }) => lifecycle === "spinoff").length,
    subagents: members.filter(({ lifecycle }) => lifecycle === "subagent").length,
    created: members.filter(({ status }) => status === "created").length,
    running: members.filter(({ status }) => status === "running").length,
    attention: members.filter(({ status }) => status === "attention").length,
    complete: members.filter(({ status }) => status === "complete").length,
    accepted: members.filter(({ status }) => status === "accepted").length,
    archived: members.filter(({ status }) => status === "archived").length,
  };
}

function executionMap({ phase, task, members }) {
  return {
    schemaVersion: EXECUTION_MAP_SCHEMA_VERSION,
    view: "execution-map",
    phase,
    task,
    summary: summary(members),
    members,
  };
}

function withoutArchivedMembers(map) {
  const members = map.members.filter(({ status }) => status !== "archived");
  if (members.length === map.members.length) return map;
  return executionMap({
    phase: aggregatePhase(members),
    task: map.task,
    members,
  });
}

function visibleExecutionMapResponse(response) {
  if (!response) return response;
  const { protocol, ...map } = response;
  return { ...withoutArchivedMembers(map), protocol };
}

function plannedMap(result, args) {
  const plan = result?.plan;
  if (!plan || !Array.isArray(plan.waves)) return null;
  const persistedTitles = new Map(
    (result?.planRun?.waves ?? []).flatMap((wave) =>
      (wave.members ?? []).map((member) => [member.sliceId, member.title])
    ),
  );
  const phase =
    result?.nextAction?.kind === "authorization-required"
      ? "authorization-required"
      : result?.nextAction?.kind === "launch-wave"
        ? "launch-pending"
        : "planned";
  const members = plan.waves.flatMap((wave) =>
    wave.slices.map((slice) => ({
      id: text(slice.id, `wave-${wave.index}`),
      task: text(
        persistedTitles.get(slice.id),
        text(slice.title, slice.objective),
      ),
      lifecycle: slice.lifecycle === "spinoff" ? "spinoff" : "subagent",
      ...route(slice.route?.launch?.nativeTask),
      status: phase,
      threadId: null,
    })),
  );
  return executionMap({
    phase,
    task: text(plan.objective, args?.objective ?? "Planned task web"),
    members,
  });
}

function plannerMap(result, args, { replan = false } = {}) {
  const member =
    result?.nextAction?.member ??
    result?.bootstrap?.planner ??
    result?.lifecycle?.planner ??
    null;
  const needsAttention =
    result?.nextAction?.kind === "attention" ||
    result?.bootstrap?.ready === false;
  const nativeTask = member?.nativeTask ?? {
    model: "gpt-5.6-sol",
    thinking: "medium",
  };
  const status = needsAttention ? "attention" : "planning";
  const task = text(
    args?.objective,
    replan ? "Revise the task web" : "Plan the task web",
  );
  return executionMap({
    phase: status,
    task,
    members: [{
      id: text(
        member?.bootstrapId ?? result?.lifecycle?.bootstrapId,
        replan ? "exception-replan" : "planner",
      ),
      task: text(member?.title, replan ? "Revise the plan" : "Plan the work"),
      lifecycle: "subagent",
      ...route(nativeTask),
      status,
      threadId: text(
        result?.lifecycle?.plannerThreadId,
        null,
      ),
    }],
  });
}

function orchestrationMap(result, args) {
  const workUnit = args?.workUnit;
  if (!workUnit || typeof workUnit !== "object") return null;
  const bound = result?.binding?.state === "bound";
  // A bound native-create receipt means the host dispatched the task's initial
  // turn. "Created" remains readable for persisted legacy projections, but a
  // newly bound worker is active work and should be presented as running.
  const status = bound ? "running" : "launch-pending";
  return executionMap({
    phase: status,
    task: text(workUnit.objectiveSummary, workUnit.title),
    members: [{
      id: text(workUnit.workUnitId, "work-unit"),
      task: text(workUnit.title, workUnit.objectiveSummary),
      lifecycle:
        workUnit.memberKind === "spinoff" ? "spinoff" : "subagent",
      ...route(workUnit.launch?.nativeTask),
      status,
      threadId: bound
        ? text(result?.binding?.memberThreadId, null)
        : null,
    }],
  });
}

function refreshedMap(result) {
  if (
    result?.command !== "execution map refresh" ||
    !Array.isArray(result.members)
  ) {
    return null;
  }
  const members = result.members.map((member) => ({
    id: member.id,
    task: member.task,
    lifecycle: member.lifecycle,
    model: member.model,
    reasoning: member.reasoning,
    status: member.status,
    threadId: member.threadId,
  }));
  const phase = members.some(({ status }) => status === "attention")
    ? "attention"
    : members.every(({ status }) => status === "complete")
      ? "complete"
      : "running";
  return executionMap({
    phase,
    task: result.task,
    members,
  });
}

function cleanupMap(result, args) {
  const records = Array.isArray(result?.results)
    ? result.results
    : Array.isArray(result?.candidates)
      ? result.candidates
      : Array.isArray(result?.pending)
        ? result.pending
        : [];
  const phase =
    result?.state === "effects-required"
      ? "archiving"
      : result?.state === "confirmation-required"
        ? "authorization-required"
        : result?.state === "attention" || result?.state === "not-ready"
          ? "attention"
          : records.some(({ state }) => state === "archived")
            ? "archived"
            : records.some(({ state }) => state === "kept")
              ? "kept"
              : "complete";
  const members = records.map((record, index) => {
    const status = [
      "archiving",
      "archived",
      "kept",
      "attention",
    ].includes(record?.state)
      ? record.state
      : phase;
    return {
      id: text(record?.workUnitId, `cleanup-${index + 1}`),
      task: text(
        record?.title,
        record?.threadId
          ? `Spin-off ${record.threadId}`
          : "Accepted spin-off",
      ),
      lifecycle: "spinoff",
      model: text(record?.model, "host-default"),
      reasoning: text(record?.reasoning, "host-default"),
      status,
      threadId: text(record?.threadId, null),
    };
  });
  const map = executionMap({
    phase,
    task: args?.webId
      ? `Clean up accepted spin-offs for ${args.webId}`
      : "Clean up accepted spin-offs",
    members,
  });
  return {
    ...map,
    summary: {
      ...map.summary,
      archived: members.filter(({ status }) => status === "archived").length,
    },
  };
}

function verificationMap(result) {
  const verification = result?.verification;
  if (!verification || !Array.isArray(verification.members)) return null;
  const members = verification.members.map((member) => ({
    id: member.sliceId,
    task: member.sliceId,
    lifecycle: member.lifecycle,
    model: "host-default",
    reasoning: "host-default",
    status: member.verified ? "running" : "attention",
    threadId: text(member.threadId, null),
  }));
  return executionMap({
    phase: verification.allVerified ? "running" : "attention",
    task: "Execute the planned task web",
    members,
  });
}

function checkpointStatus(member) {
  if (member?.coordination?.state === "accepted") return "accepted";
  if (
    member?.title?.state === "attention" ||
    member?.execution?.state === "attention" ||
    member?.execution?.attentionRequired === true ||
    ["stale", "malformed"].includes(member?.result?.state)
  ) return "attention";
  if (
    member?.execution?.state === "terminal" ||
    member?.result?.state === "current"
  ) return "complete";
  if (member?.execution?.state === "running") return "running";
  return "unknown";
}

function checkpointMap(result) {
  if (!Array.isArray(result?.checkpoint?.members)) return null;
  const members = result.checkpoint.members.map((member) => ({
    id: member.workUnitId,
    task: text(member?.title?.requestedTitle, member.workUnitId),
    lifecycle: "spinoff",
    model: "host-default",
    reasoning: "host-default",
    status: checkpointStatus(member),
    threadId: text(member.memberThreadId, null),
  }));
  return executionMap({
    phase: aggregatePhase(members),
    task: "Execute the planned task web",
    members,
  });
}

function decisionMap(result) {
  const decision = result?.decision;
  if (!decision?.workUnitId) return null;
  const accepted = decision.decision === "accepted";
  return executionMap({
    phase: accepted ? "accepted" : "attention",
    task: "Review task-web results",
    members: [{
      id: decision.workUnitId,
      task: decision.workUnitId,
      lifecycle: "spinoff",
      model: "host-default",
      reasoning: "host-default",
      status: accepted ? "accepted" : "attention",
      threadId: text(decision.memberThreadId, null),
    }],
  });
}

function completionMap(args) {
  if (!args?.workUnitId) return null;
  const succeeded = args.outcome === "succeeded";
  return executionMap({
    phase: succeeded ? "complete" : "attention",
    task: "Collect task-web results",
    members: [{
      id: args.workUnitId,
      task: args.workUnitId,
      lifecycle: "spinoff",
      model: "host-default",
      reasoning: "host-default",
      status: succeeded ? "complete" : "attention",
      threadId: text(args.memberThreadId, null),
    }],
  });
}

function historyMap(result) {
  if (
    result?.command !== "execution map history" ||
    !Array.isArray(result.members)
  ) {
    return null;
  }
  return executionMap({
    phase: result.phase,
    task: result.task,
    members: result.members,
  });
}

const STATUS_RANK = Object.freeze({
  planning: 0,
  planned: 1,
  "authorization-required": 2,
  "launch-pending": 3,
  created: 4,
  unknown: 5,
  running: 6,
  attention: 7,
  complete: 8,
  accepted: 9,
  archiving: 10,
  archived: 11,
  kept: 11,
});

function aggregatePhase(members) {
  if (members.length === 0) return "complete";
  const currentMembers = members.filter(
    ({ status }) => !["archived", "kept"].includes(status),
  );
  const statuses = (currentMembers.length > 0 ? currentMembers : members)
    .map(({ status }) => status);
  if (statuses.includes("archiving")) return "archiving";
  if (statuses.every((status) => status === "archived")) return "archived";
  if (statuses.every((status) => status === "kept")) return "kept";
  if (statuses.every((status) => status === "accepted")) return "accepted";
  if (statuses.includes("attention")) return "attention";
  if (statuses.every((status) => ["complete", "accepted", "archived", "kept"].includes(status))) {
    return "complete";
  }
  return statuses.reduce((phase, status) =>
    (STATUS_RANK[status] ?? -1) > (STATUS_RANK[phase] ?? -1) ? status : phase,
  statuses[0]);
}

function compareVersion(left, right) {
  if (!left && !right) return 0;
  if (!left) return 0;
  if (!right) return 1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function memberVersions(toolName, args, result) {
  const versions = {};
  const workUnit = args?.workUnit;
  if (workUnit?.workUnitId) {
    versions[workUnit.workUnitId] = [
      workUnit.specRevision ?? 0,
      workUnit.attempt ?? 0,
    ];
  }
  for (const member of result?.checkpoint?.members ?? []) {
    versions[member.workUnitId] = [
      member.specRevision,
      member.attempt,
    ];
  }
  const decision = result?.decision;
  if (decision?.workUnitId) {
    versions[decision.workUnitId] = [
      decision.specRevision ?? 0,
      decision.attempt ?? 0,
    ];
  }
  if (toolName === "nelos_spinoff_complete" && args?.workUnitId) {
    versions[args.workUnitId] = [
      args.specRevision ?? 0,
      args.attempt ?? 0,
    ];
  }
  return versions;
}

function mergeMaps(
  current,
  incoming,
  { currentVersions = {}, incomingVersions = {}, ignoredStatusIds = new Set() } = {},
) {
  if (!current) return { map: incoming, versions: incomingVersions };
  const members = new Map(current.members.map((member) => [member.id, member]));
  const versions = { ...currentVersions };
  for (const candidate of incoming.members) {
    const prior = members.get(candidate.id);
    if (!prior) {
      members.set(candidate.id, candidate);
      if (incomingVersions[candidate.id]) {
        versions[candidate.id] = incomingVersions[candidate.id];
      }
      continue;
    }
    const versionOrder = compareVersion(
      incomingVersions[candidate.id],
      currentVersions[candidate.id],
    );
    const status = ignoredStatusIds.has(candidate.id) || versionOrder < 0
      ? prior.status
      : versionOrder > 0
      ? candidate.status
      : (STATUS_RANK[candidate.status] ?? -1) >=
        (STATUS_RANK[prior.status] ?? -1)
      ? candidate.status
      : prior.status;
    const priorLineageId = safeTitleLineageId(prior.task);
    const candidateLineageId = safeTitleLineageId(candidate.task);
    const task = candidate.task === candidate.id ||
        (priorLineageId !== null && candidateLineageId !== priorLineageId)
      ? prior.task
      : candidate.task;
    members.set(candidate.id, {
      ...prior,
      task,
      lifecycle: prior.lifecycle,
      model: candidate.model === "host-default" ? prior.model : candidate.model,
      reasoning: candidate.reasoning === "host-default"
        ? prior.reasoning
        : candidate.reasoning,
      status,
      threadId: candidate.threadId ?? prior.threadId,
    });
    if (versionOrder > 0) versions[candidate.id] = incomingVersions[candidate.id];
  }
  const mergedMembers = [...members.values()];
  return {
    map: executionMap({
      phase: aggregatePhase(mergedMembers),
      task: current.task || incoming.task,
      members: mergedMembers,
    }),
    versions,
  };
}

function safeTitleLineageId(title) {
  try {
    return titleLineageId(title);
  } catch {
    return null;
  }
}

function observationMap(toolName, args, result) {
  if (toolName === "nelos_execution_map_history") return historyMap(result);
  const planned = plannedMap(result, args);
  if (planned) return planned;
  if (toolName === "nelos_execution_map_refresh") return refreshedMap(result);
  if (toolName === "nelos_orchestrate_create") return orchestrationMap(result, args);
  if (toolName === "nelos_orchestrate_advance") return checkpointMap(result);
  if (toolName === "nelos_launch_verify_batch") return verificationMap(result);
  if (toolName === "nelos_queen_decide") return decisionMap(result);
  if (toolName === "nelos_spinoff_complete") return completionMap(args);
  if (toolName === "nelos_spinoff_cleanup") return cleanupMap(result, args);
  return plannerMap(result, args, {
    replan: toolName === "nelos_plan_replan",
  });
}

export function executionMapForToolResultV1(toolName, args, result) {
  if (!EXECUTION_MAP_TOOL_NAMES.has(toolName)) return null;
  const map = observationMap(toolName, args, result);
  if (!map) return null;
  const response = {
    ...map,
    protocol: {
      schemaVersion: 1,
      tool: toolName,
      result: structuredClone(result),
    },
  };
  return toolName === "nelos_execution_map_history"
    ? response
    : visibleExecutionMapResponse(response);
}

function validateHistoryInput(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("execution-map history input must be an object");
  }
  const fields = ["schemaVersion", "webId", "queenThreadId"];
  const unknown = Object.keys(args).find((field) => !fields.includes(field));
  if (unknown) {
    throw new Error(`execution-map history contains unknown field: ${unknown}`);
  }
  if (args.schemaVersion !== EXECUTION_MAP_SCHEMA_VERSION) {
    throw new Error(
      `execution-map history schemaVersion must be ${EXECUTION_MAP_SCHEMA_VERSION}`,
    );
  }
  const webId = assertWebId(args.webId);
  if (
    typeof args.queenThreadId !== "string" ||
    !args.queenThreadId.trim() ||
    args.queenThreadId.length > 256
  ) {
    throw new Error("execution-map history queenThreadId is invalid");
  }
  return { webId, queenThreadId: args.queenThreadId };
}

export async function readExecutionMapHistoryV1(args, { webRegistry } = {}) {
  const request = validateHistoryInput(args);
  if (typeof webRegistry?.read !== "function") {
    throw new Error("execution-map history requires a web registry");
  }
  const record = await webRegistry.read(request.queenThreadId);
  if (record?.outboundWebId !== request.webId) {
    throw new Error("execution-map history identity is not persisted");
  }
  const projection = record.executionMapProjection;
  const members = Array.isArray(projection?.members)
    ? structuredClone(projection.members)
    : [];
  return {
    command: "execution map history",
    webId: request.webId,
    queenThreadId: request.queenThreadId,
    phase: members.length > 0
      ? aggregatePhase(members)
      : "complete",
    task: text(projection?.task, `Task web ${request.webId}`),
    members,
  };
}

async function projectionIdentity(toolName, args, result, webRegistry) {
  const direct = args?.workUnit ?? args;
  if (direct?.webId && direct?.queenThreadId) {
    return { webId: direct.webId, queenThreadId: direct.queenThreadId };
  }
  const webIdentity = result?.planRun?.webIdentity;
  if (webIdentity?.webId && webIdentity?.queenThreadId) return webIdentity;
  const queenThreadId = args?.parentThreadId ?? args?.queenThreadId ?? null;
  if (queenThreadId) {
    const record = await webRegistry.read(queenThreadId);
    const webId = record?.outboundWebId ?? record?.executionMapProjection?.webId;
    if (webId) return { webId, queenThreadId };
  }
  if (toolName === "nelos_execution_map_refresh") {
    const threadIds = new Set(
      (args?.members ?? result?.members ?? []).map(({ threadId }) => threadId),
    );
    const matches = (await webRegistry.list()).filter((record) =>
      record.executionMapProjection?.members?.some(({ threadId }) =>
        threadId && threadIds.has(threadId))
    );
    if (matches.length === 1) {
      return {
        webId: matches[0].executionMapProjection.webId,
        queenThreadId: matches[0].threadId,
      };
    }
  }
  return null;
}

export async function projectExecutionMapForToolResultV1(
  toolName,
  args,
  result,
  { webRegistry } = {},
) {
  const visibleResponse = executionMapForToolResultV1(toolName, args, result);
  if (!visibleResponse || toolName === "nelos_execution_map_history") {
    return visibleResponse;
  }
  const currentMap = observationMap(toolName, args, result);
  const currentResponse = {
    ...currentMap,
    protocol: visibleResponse.protocol,
  };
  if (!webRegistry) return visibleResponse;
  const identity = await projectionIdentity(toolName, args, result, webRegistry);
  if (!identity) return visibleResponse;
  return webRegistry.withLock(async () => {
    const record = await webRegistry.read(identity.queenThreadId);
    const { protocol: _priorProtocol, ...priorMap } =
      record?.executionMapProjection ?? {};
    const { protocol, ...incomingMap } = currentResponse;
    const ignoredStatusIds = new Set(
      toolName === "nelos_execution_map_refresh"
        ? (result?.members ?? [])
          .filter((member) =>
            member.observedTurnId === null ||
            member.observedTurnId !== member.turnId
          )
          .map(({ id }) => id)
        : [],
    );
    const { map: merged, versions } = mergeMaps(
      Array.isArray(priorMap.members) ? priorMap : null,
      incomingMap,
      {
        currentVersions: record?.executionMapProjectionVersions ?? {},
        incomingVersions: memberVersions(toolName, args, result),
        ignoredStatusIds,
      },
    );
    const persistedProjection = {
      ...merged,
      webId: identity.webId,
      queenThreadId: identity.queenThreadId,
    };
    if (
      !record ||
      record.outboundWebId !== identity.webId ||
      JSON.stringify(record.executionMapProjection) !==
        JSON.stringify(persistedProjection) ||
      JSON.stringify(record.executionMapProjectionVersions ?? {}) !==
        JSON.stringify(versions)
    ) {
      await webRegistry.write({
        ...(record ?? {
          threadId: identity.queenThreadId,
          createdAt: new Date().toISOString(),
        }),
        outboundWebId: identity.webId,
        updatedAt: new Date().toISOString(),
        executionMapProjection: persistedProjection,
        executionMapProjectionVersions: versions,
      });
    }
    return visibleExecutionMapResponse({ ...merged, protocol });
  });
}

function planSummary(map) {
  if (!map) return null;
  return {
    ...map,
    view: "plan-summary",
  };
}

function metric(label, value) {
  return { label, value };
}

function actionReceipt(toolName, args, result) {
  const protocol = {
    schemaVersion: 1,
    tool: toolName,
    result: structuredClone(result),
  };
  if (toolName === "nelos_queen_decide") {
    const accepted = (result?.decision?.decision ?? args?.decision) ===
      "accepted";
    return {
      schemaVersion: EXECUTION_MAP_SCHEMA_VERSION,
      view: "action-receipt",
      kind: "decision",
      status: accepted ? "accepted" : "attention",
      title: accepted ? "Result accepted" : "Result rejected",
      detail: text(
        result?.decision?.workUnitId ?? args?.receipt?.workUnitId,
        "Queen review decision recorded",
      ),
      metrics: [],
      protocol,
    };
  }
  if (toolName === "nelos_spinoff_complete") {
    const succeeded = args?.outcome === "succeeded";
    return {
      schemaVersion: EXECUTION_MAP_SCHEMA_VERSION,
      view: "action-receipt",
      kind: "completion",
      status: succeeded ? "complete" : "attention",
      title: succeeded ? "Task completed" : "Task needs attention",
      detail: text(args?.workUnitId, "Spin-off completion recorded"),
      metrics: args?.outcome
        ? [metric("Outcome", String(args.outcome))]
        : [],
      protocol,
    };
  }
  if (toolName === "nelos_spinoff_cleanup") {
    const records = Array.isArray(result?.results)
      ? result.results
      : Array.isArray(result?.candidates)
        ? result.candidates
        : Array.isArray(result?.pending)
          ? result.pending
          : [];
    const counts = new Map();
    for (const record of records) {
      const state = text(record?.state, "pending");
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    const status = result?.state === "effects-required"
      ? "archiving"
      : result?.state === "confirmation-required"
        ? "authorization-required"
        : ["attention", "not-ready"].includes(result?.state)
          ? "attention"
          : "complete";
    const title = status === "archiving"
      ? "Cleanup in progress"
      : status === "authorization-required"
        ? "Cleanup confirmation required"
        : status === "attention"
          ? "Cleanup needs attention"
          : "Cleanup complete";
    const metrics = [...counts.entries()].map(([label, value]) =>
      metric(label, value)
    );
    return {
      schemaVersion: EXECUTION_MAP_SCHEMA_VERSION,
      view: "action-receipt",
      kind: "cleanup",
      status,
      title,
      detail: records.length === 1
        ? "1 spin-off in this receipt"
        : `${records.length} spin-offs in this receipt`,
      metrics,
      protocol,
    };
  }
  return null;
}

export async function projectMcpVisualForToolResultV1(
  toolName,
  args,
  result,
  options = {},
) {
  const map = await projectExecutionMapForToolResultV1(
    toolName,
    args,
    result,
    options,
  );
  if (PLAN_SUMMARY_TOOL_NAMES.has(toolName)) return planSummary(map);
  if (ACTION_RECEIPT_TOOL_NAMES.has(toolName)) {
    return actionReceipt(toolName, args, result);
  }
  return map;
}

export function executionMapToolMetadataV1(toolName) {
  return mcpVisualToolMetadataV1(toolName);
}

export function mcpVisualToolMetadataV1(toolName) {
  if (!EXECUTION_MAP_TOOL_NAMES.has(toolName)) return null;
  const plan = PLAN_SUMMARY_TOOL_NAMES.has(toolName);
  const action = ACTION_RECEIPT_TOOL_NAMES.has(toolName);
  const resourceUri = plan
    ? PLAN_SUMMARY_RESOURCE_URI
    : action
      ? ACTION_RECEIPT_RESOURCE_URI
      : EXECUTION_MAP_RESOURCE_URI;
  const dispatch = toolName === "nelos_orchestrate_create";
  const cleanup = toolName === "nelos_spinoff_cleanup";
  const decision = toolName === "nelos_queen_decide";
  const completion = toolName === "nelos_spinoff_complete";
  const verification = toolName === "nelos_launch_verify_batch";
  const advance = toolName === "nelos_orchestrate_advance";
  const refresh = toolName === "nelos_execution_map_refresh";
  const history = toolName === "nelos_execution_map_history";
  return {
    ui: { resourceUri },
    "openai/outputTemplate": resourceUri,
    "openai/toolInvocation/invoking": history
      ? "Loading full task-web history…"
      : refresh
      ? "Refreshing worker status…"
      : cleanup
      ? "Cleaning up spin-offs…"
      : decision
      ? "Recording queen decision…"
      : completion
      ? "Recording task completion…"
      : verification
      ? "Verifying launched workers…"
      : advance
      ? "Updating worker state…"
      : dispatch
        ? "Dispatching task…"
        : plan
          ? "Preparing task plan…"
          : "Loading worker state…",
    "openai/toolInvocation/invoked": history
      ? "Full task-web history ready"
      : refresh
      ? "Worker status updated"
      : cleanup
      ? "Cleanup result ready"
      : decision
      ? "Queen decision recorded"
      : completion
      ? "Task completion recorded"
      : verification
      ? "Worker launch verified"
      : advance
      ? "Worker state updated"
      : dispatch
        ? "Task dispatched"
        : plan
          ? "Task plan ready"
          : "Worker state ready",
  };
}

export function listExecutionMapResourcesV1() {
  return listMcpVisualResourcesV1();
}

export function listMcpVisualResourcesV1() {
  const resource = (uri, name, title, description, widgetDescription) => ({
    uri,
    name,
    title,
    description,
    mimeType: EXECUTION_MAP_RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: true,
        csp: {
          connectDomains: [],
          resourceDomains: [],
        },
      },
      "openai/widgetDescription": widgetDescription,
    },
  });
  return [
    resource(
      EXECUTION_MAP_RESOURCE_URI,
      "nelos-execution-map",
      "Nelos execution map",
      "Compact worker-state view for active Nelos task webs.",
      "Shows task members grouped by current execution status.",
    ),
    resource(
      PLAN_SUMMARY_RESOURCE_URI,
      "nelos-plan-summary",
      "Nelos plan summary",
      "Compact plan-oriented summary for Nelos planning actions.",
      "Summarizes a task plan, its phase, routes, and member count.",
    ),
    resource(
      ACTION_RECEIPT_RESOURCE_URI,
      "nelos-action-receipt",
      "Nelos action receipt",
      "Compact outcome receipt for Nelos decisions and lifecycle actions.",
      "Confirms a decision, completion, or cleanup outcome without showing a worker map.",
    ),
  ];
}

export function readExecutionMapResourceV1(uri) {
  return readMcpVisualResourceV1(uri);
}

export function readMcpVisualResourceV1(uri) {
  const html = new Map([
    [EXECUTION_MAP_RESOURCE_URI, EXECUTION_MAP_HTML],
    [PLAN_SUMMARY_RESOURCE_URI, PLAN_SUMMARY_HTML],
    [ACTION_RECEIPT_RESOURCE_URI, ACTION_RECEIPT_HTML],
  ]).get(uri);
  if (!html) {
    throw new Error(`unknown resource: ${uri}`);
  }
  const resource = listMcpVisualResourcesV1().find(
    (candidate) => candidate.uri === uri,
  );
  return {
    contents: [{
      uri,
      mimeType: EXECUTION_MAP_RESOURCE_MIME_TYPE,
      text: html,
      _meta: resource._meta,
    }],
  };
}
