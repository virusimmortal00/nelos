import { readFileSync } from "node:fs";

import {
  MCP_PROTOCOL_TOOL_OUTPUT_SCHEMAS_V1,
  PROTOCOL_ACTION_SCHEMA_V1,
} from "./protocol-contract/index.mjs";

export const EXECUTION_MAP_SCHEMA_VERSION = 1;
export const EXECUTION_MAP_RESOURCE_URI =
  "ui://nelos/execution-map-v7.html";
export const EXECUTION_MAP_RESOURCE_MIME_TYPE =
  "text/html;profile=mcp-app";

export const EXECUTION_MAP_TOOL_NAMES = Object.freeze(new Set([
  "nelos_plan_bootstrap",
  "nelos_plan_lifecycle",
  "nelos_plan_replan",
  "nelos_plan_slices",
  "nelos_orchestrate_create",
  "nelos_spinoff_cleanup",
  "nelos_execution_map_refresh",
]));

const MEMBER_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    id: { type: "string" },
    task: { type: "string" },
    lifecycle: { enum: ["spinoff", "subagent"] },
    model: { type: "string" },
    reasoning: { type: "string" },
    status: {
      enum: [
        "planning",
        "planned",
        "authorization-required",
        "launch-pending",
        "running",
        "created",
        "archiving",
        "archived",
        "kept",
        "complete",
        "attention",
      ],
    },
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

function protocolResultSchemaV1(toolName) {
  if (toolName === "nelos_execution_map_refresh") {
    return REFRESH_RESULT_SCHEMA;
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
  phase: {
    enum: [
      "planning",
      "planned",
      "authorization-required",
      "launch-pending",
      "running",
      "created",
      "archiving",
      "archived",
      "kept",
      "complete",
      "attention",
    ],
  },
  task: { type: "string" },
  summary: {
    type: "object",
    properties: {
      total: { type: "integer", minimum: 0 },
      spinoffs: { type: "integer", minimum: 0 },
      subagents: { type: "integer", minimum: 0 },
      created: { type: "integer", minimum: 0 },
      archived: { type: "integer", minimum: 0 },
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

const EXECUTION_MAP_HTML = readFileSync(
  new URL("../assets/execution-map.html", import.meta.url),
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

function plannedMap(result, args) {
  const plan = result?.plan;
  if (!plan || !Array.isArray(plan.waves)) return null;
  const phase =
    result?.nextAction?.kind === "authorization-required"
      ? "authorization-required"
      : result?.nextAction?.kind === "launch-wave"
        ? "launch-pending"
        : "planned";
  const members = plan.waves.flatMap((wave) =>
    wave.slices.map((slice) => ({
      id: text(slice.id, `wave-${wave.index}`),
      task: text(slice.title, slice.objective),
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
  const status = bound ? "created" : "launch-pending";
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

export function executionMapForToolResultV1(toolName, args, result) {
  if (!EXECUTION_MAP_TOOL_NAMES.has(toolName)) return null;
  const planned = plannedMap(result, args);
  const map = planned ??
    (toolName === "nelos_execution_map_refresh"
      ? refreshedMap(result)
      : toolName === "nelos_orchestrate_create"
      ? orchestrationMap(result, args)
      : toolName === "nelos_spinoff_cleanup"
        ? cleanupMap(result, args)
        : plannerMap(result, args, {
            replan: toolName === "nelos_plan_replan",
          }));
  if (!map) return null;
  return {
    ...map,
    protocol: {
      schemaVersion: 1,
      tool: toolName,
      result: structuredClone(result),
    },
  };
}

export function executionMapToolMetadataV1(toolName) {
  if (!EXECUTION_MAP_TOOL_NAMES.has(toolName)) return null;
  const dispatch = toolName === "nelos_orchestrate_create";
  const cleanup = toolName === "nelos_spinoff_cleanup";
  const refresh = toolName === "nelos_execution_map_refresh";
  return {
    ui: { resourceUri: EXECUTION_MAP_RESOURCE_URI },
    "openai/outputTemplate": EXECUTION_MAP_RESOURCE_URI,
    "openai/toolInvocation/invoking": refresh
      ? "Refreshing worker status…"
      : cleanup
      ? "Cleaning up spin-offs…"
      : dispatch
        ? "Dispatching task…"
        : "Planning task web…",
    "openai/toolInvocation/invoked": refresh
      ? "Worker status updated"
      : cleanup
      ? "Cleanup receipt ready"
      : dispatch
        ? "Dispatch receipt ready"
        : "Plan receipt ready",
  };
}

export function listExecutionMapResourcesV1() {
  return [{
    uri: EXECUTION_MAP_RESOURCE_URI,
    name: "nelos-execution-map",
    title: "Nelos execution map",
    description:
      "Inline receipt for planned, active, completed, and archived Nelos task-web members.",
    mimeType: EXECUTION_MAP_RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: true,
        csp: {
          connectDomains: [],
          resourceDomains: [],
        },
      },
      "openai/widgetDescription":
        "Shows each Nelos task member's model, reasoning level, lifecycle, and current status.",
    },
  }];
}

export function readExecutionMapResourceV1(uri) {
  if (uri !== EXECUTION_MAP_RESOURCE_URI) {
    throw new Error(`unknown resource: ${uri}`);
  }
  const [resource] = listExecutionMapResourcesV1();
  return {
    contents: [{
      uri,
      mimeType: EXECUTION_MAP_RESOURCE_MIME_TYPE,
      text: EXECUTION_MAP_HTML,
      _meta: resource._meta,
    }],
  };
}
