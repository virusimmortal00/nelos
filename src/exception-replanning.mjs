import { createHash } from "node:crypto";

import {
  PLANNING_LIFECYCLE_INPUT_SCHEMA,
  PLANNING_LIFECYCLE_SCHEMA_VERSION,
} from "./planning-lifecycle.mjs";
import {
  MAX_PLAN_SLICES,
  planWorkSlices,
  SLICE_PLAN_INPUT_SCHEMA,
} from "./slice-planner.mjs";
import { planDigestV1 } from "./plan-run-store.mjs";

export const EXCEPTION_REPLANNING_SCHEMA_VERSION = 1;
export const EXCEPTION_REPLAN_TRIGGER_TYPES = Object.freeze([
  "execution-failed",
  "execution-blocked",
  "requirements-changed",
  "confidence-insufficient",
]);

const MAX_TRIGGER_SUMMARY_CHARACTERS = 2_000;
const MAX_TRIGGER_EVIDENCE = 8;
const MAX_TRIGGER_EVIDENCE_CHARACTERS = 500;
const MAX_REPLAN_CONTEXT_BYTES = 16_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const INPUT_FIELDS = new Set([
  "schemaVersion",
  "idempotencyKey",
  "queenThreadId",
  "basePlanRunId",
  "basePlanDigest",
  "basePlan",
  "trigger",
  "generation",
  "bootstrapId",
  "receipt",
]);
const TRIGGER_FIELDS = new Set([
  "type",
  "eventId",
  "summary",
  "affectedSliceIds",
  "completedSliceIds",
  "evidence",
]);
const SEMANTIC_SLICE_FIELDS = [
  "id",
  "title",
  "objective",
  "deliverable",
  "acceptanceCriteria",
  "dependsOn",
  "lifecycle",
  "workspaceMode",
  "taskShape",
];

function exactObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
  return value;
}

function identifier(value, field) {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function text(value, field, maximum) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum
  ) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value
    .replaceAll(/[\u0000-\u001f\u007f]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function idList(value, field) {
  if (!Array.isArray(value) || value.length > MAX_PLAN_SLICES) {
    throw new Error(`${field} must contain at most ${MAX_PLAN_SLICES} slice IDs`);
  }
  const normalized = value.map((item, index) =>
    identifier(item, `${field}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return normalized;
}

function flatten(plan) {
  return plan.waves.flatMap((wave) => wave.slices);
}

function semanticSlice(slice) {
  return Object.fromEntries(
    SEMANTIC_SLICE_FIELDS.map((field) => [
      field,
      Array.isArray(slice[field]) ? [...slice[field]] : slice[field],
    ]),
  );
}

function canonicalBasePlan(plan) {
  return {
    schemaVersion: 1,
    objective: plan.objective,
    maxParallel: plan.maxParallel,
    slices: flatten(plan).map(semanticSlice),
  };
}

function normalizeTrigger(value, basePlan) {
  exactObject(value, "exception replan trigger", TRIGGER_FIELDS);
  if (!EXCEPTION_REPLAN_TRIGGER_TYPES.includes(value.type)) {
    throw new Error(
      "exception replanning requires a failed, blocked, changed-requirements, or insufficient-confidence trigger",
    );
  }
  const trigger = {
    type: value.type,
    eventId: identifier(value.eventId, "trigger.eventId"),
    summary: text(
      value.summary,
      "trigger.summary",
      MAX_TRIGGER_SUMMARY_CHARACTERS,
    ),
    affectedSliceIds: idList(
      value.affectedSliceIds,
      "trigger.affectedSliceIds",
    ),
    completedSliceIds: idList(
      value.completedSliceIds,
      "trigger.completedSliceIds",
    ),
    evidence: (() => {
      if (
        !Array.isArray(value.evidence) ||
        value.evidence.length === 0 ||
        value.evidence.length > MAX_TRIGGER_EVIDENCE
      ) {
        throw new Error(
          `trigger.evidence must contain between 1 and ${MAX_TRIGGER_EVIDENCE} entries`,
        );
      }
      return value.evidence.map((item, index) =>
        text(
          item,
          `trigger.evidence[${index}]`,
          MAX_TRIGGER_EVIDENCE_CHARACTERS,
        ),
      );
    })(),
  };
  const sliceIds = new Set(flatten(basePlan).map(({ id }) => id));
  for (const id of [...trigger.affectedSliceIds, ...trigger.completedSliceIds]) {
    if (!sliceIds.has(id)) {
      throw new Error(`exception replan trigger references unknown slice ${id}`);
    }
  }
  if (
    trigger.affectedSliceIds.some((id) =>
      trigger.completedSliceIds.includes(id),
    )
  ) {
    throw new Error("completed slices cannot also be affected slices");
  }
  if (
    ["execution-failed", "execution-blocked"].includes(trigger.type) &&
    trigger.affectedSliceIds.length === 0
  ) {
    throw new Error("execution exception triggers require an affected slice");
  }
  return trigger;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function lifecycleRequest(input, basePlan, trigger) {
  const base = canonicalBasePlan(basePlan);
  const context = JSON.stringify({
    mode: "exception-replan",
    policy: {
      preserveCompletedSlicesExactly: true,
      scheduleCompletedSlicesAgain: false,
      produceFullRevisedPlan: true,
    },
    trigger,
    basePlan: base,
  });
  if (Buffer.byteLength(context, "utf8") > MAX_REPLAN_CONTEXT_BYTES) {
    throw new Error(
      `exception replanning context exceeds ${MAX_REPLAN_CONTEXT_BYTES} bytes`,
    );
  }
  const scopedKey = `replan-${digest([
    input.idempotencyKey,
    input.queenThreadId,
    input.basePlanRunId,
    trigger.eventId,
  ]).slice(0, 48)}`;
  return {
    schemaVersion: PLANNING_LIFECYCLE_SCHEMA_VERSION,
    idempotencyKey: scopedKey,
    queenThreadId: input.queenThreadId,
    objective: `Revise the execution plan after ${trigger.type}: ${basePlan.objective}`,
    context,
    maxParallel: basePlan.maxParallel,
    ...(input.bootstrapId ? { bootstrapId: input.bootstrapId } : {}),
    receipt: input.receipt,
  };
}

function assertCompletedSlicesPreserved(basePlan, revisedPlan, completedSliceIds) {
  const base = new Map(
    flatten(basePlan).map((slice) => [slice.id, semanticSlice(slice)]),
  );
  const revised = new Map(
    flatten(revisedPlan).map((slice) => [slice.id, semanticSlice(slice)]),
  );
  for (const id of completedSliceIds) {
    if (
      !revised.has(id) ||
      JSON.stringify(revised.get(id)) !== JSON.stringify(base.get(id))
    ) {
      throw new Error(`exception replan changed completed slice ${id}`);
    }
  }
}

function pendingPlan(revisedPlan, completedSliceIds) {
  const completed = new Set(completedSliceIds);
  const pending = flatten(revisedPlan)
    .filter(({ id }) => !completed.has(id))
    .map((slice) => ({
      ...semanticSlice(slice),
      dependsOn: slice.dependsOn.filter((id) => !completed.has(id)),
    }));
  if (pending.length === 0) return null;
  return planWorkSlices({
    schemaVersion: 1,
    objective: revisedPlan.objective,
    maxParallel: revisedPlan.maxParallel,
    slices: pending,
  });
}

export class ExceptionReplanningCoordinatorV1 {
  #planningLifecycle;
  #planRunStore;

  constructor({ planningLifecycle, planRunStore }) {
    if (!planningLifecycle || typeof planningLifecycle.advance !== "function") {
      throw new Error("exception replanning requires a planning lifecycle coordinator");
    }
    if (!planRunStore || typeof planRunStore.read !== "function") {
      throw new Error("exception replanning requires a plan run store");
    }
    this.#planningLifecycle = planningLifecycle;
    this.#planRunStore = planRunStore;
  }

  async advance(value, context) {
    exactObject(value, "exception replanning input", INPUT_FIELDS);
    if (value.schemaVersion !== EXCEPTION_REPLANNING_SCHEMA_VERSION) {
      throw new Error(
        `exception replanning schemaVersion must be ${EXCEPTION_REPLANNING_SCHEMA_VERSION}`,
      );
    }
    if (value.generation !== 1) {
      throw new Error("exception replanning is bounded to one generation");
    }
    identifier(value.idempotencyKey, "idempotencyKey");
    identifier(value.queenThreadId, "queenThreadId");
    const basePlan = planWorkSlices(value.basePlan);
    const basePlanRun = await this.#planRunStore.read(value.basePlanRunId);
    if (!basePlanRun) {
      throw new Error("exception replanning references an unknown base plan run");
    }
    if (
      basePlanRun.replanGeneration !== 0 ||
      basePlanRun.rootPlanRunId !== basePlanRun.planRunId
    ) {
      throw new Error("exception replanning is bounded to one plan-run generation");
    }
    if (
      value.basePlanDigest !== basePlanRun.planDigest ||
      planDigestV1(basePlan) !== basePlanRun.planDigest
    ) {
      throw new Error("exception replanning base plan conflicts with its persisted run");
    }
    const trigger = normalizeTrigger(value.trigger, basePlan);
    const result = await this.#planningLifecycle.advance(
      lifecycleRequest(value, basePlan, trigger),
      context,
    );
    if (!result.plan) {
      return {
        ...result,
        command: "plan exception replan",
        replanning: {
          generation: 1,
          trigger,
          basePlanRunId: basePlanRun.planRunId,
          rootPlanRunId: basePlanRun.rootPlanRunId,
          basePlanDigest: basePlanRun.planDigest,
        },
      };
    }
    assertCompletedSlicesPreserved(
      basePlan,
      result.plan,
      trigger.completedSliceIds,
    );
    const executablePlan = pendingPlan(
      result.plan,
      trigger.completedSliceIds,
    );
    return {
      ...result,
      command: "plan exception replan",
      plan: executablePlan,
      replanning: {
        generation: 1,
        trigger,
        basePlanRunId: basePlanRun.planRunId,
        rootPlanRunId: basePlanRun.rootPlanRunId,
        basePlanDigest: basePlanRun.planDigest,
        revisedPlan: result.plan,
        completedSliceIds: trigger.completedSliceIds,
        executionComplete: executablePlan === null,
      },
    };
  }
}

const STRING_LIST_SCHEMA = {
  type: "array",
  items: { type: "string" },
  maxItems: MAX_PLAN_SLICES,
  uniqueItems: true,
};

export const EXCEPTION_REPLANNING_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    schemaVersion: { const: EXCEPTION_REPLANNING_SCHEMA_VERSION },
    idempotencyKey: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    },
    queenThreadId: { type: "string" },
    basePlanRunId: {
      type: "string",
      pattern: "^run:[a-f0-9]{40}$",
    },
    basePlanDigest: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    basePlan: SLICE_PLAN_INPUT_SCHEMA,
    trigger: {
      type: "object",
      properties: {
        type: { enum: EXCEPTION_REPLAN_TRIGGER_TYPES },
        eventId: { type: "string" },
        summary: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TRIGGER_SUMMARY_CHARACTERS,
        },
        affectedSliceIds: STRING_LIST_SCHEMA,
        completedSliceIds: STRING_LIST_SCHEMA,
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TRIGGER_EVIDENCE,
          items: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TRIGGER_EVIDENCE_CHARACTERS,
          },
        },
      },
      required: [...TRIGGER_FIELDS],
      additionalProperties: false,
    },
    generation: { const: 1 },
    bootstrapId: {
      type: "string",
      pattern: "^plan:[a-f0-9]{24}$",
    },
    receipt: PLANNING_LIFECYCLE_INPUT_SCHEMA.properties.receipt,
  },
  required: [
    "schemaVersion",
    "idempotencyKey",
    "queenThreadId",
    "basePlanRunId",
    "basePlanDigest",
    "basePlan",
    "trigger",
    "generation",
    "receipt",
  ],
  additionalProperties: false,
});
