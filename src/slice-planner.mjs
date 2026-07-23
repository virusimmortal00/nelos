import { INTELLIGENCE_PROFILE_CATALOG } from "./intelligence-profile-catalog.mjs";
import {
  INTELLIGENCE_TASK_SHAPES,
  routeIntelligenceProfile,
} from "./intelligence-profile-router.mjs";

export const SLICE_PLAN_SCHEMA_VERSION = 1;
export const MAX_PLAN_SLICES = 32;
export const MAX_PARALLEL_SLICES = 8;

export const MAX_PLAN_BYTES = 64 * 1024;
const MAX_OBJECTIVE_CHARACTERS = 2_000;
const MAX_TITLE_CHARACTERS = 160;
const MAX_DELIVERABLE_CHARACTERS = 1_000;
const MAX_CRITERIA = 8;
const MAX_CRITERION_CHARACTERS = 500;
const SLICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLAN_FIELDS = new Set(["schemaVersion", "objective", "maxParallel", "slices"]);
const SLICE_FIELDS = new Set([
  "id",
  "title",
  "objective",
  "deliverable",
  "acceptanceCriteria",
  "dependsOn",
  "lifecycle",
  "workspaceMode",
  "taskShape",
  "routing",
]);
const ROUTING_FIELDS = new Set([
  "profile",
  "model",
  "effort",
  "nativeFanoutAllowed",
]);
const LIFECYCLES = Object.freeze(["spinoff", "subagent"]);
const WORKSPACE_MODES = Object.freeze(["shared-read-only", "isolated-write"]);
const INTELLIGENCE_PROFILES = Object.freeze(
  Object.keys(INTELLIGENCE_PROFILE_CATALOG.profiles),
);
const INTELLIGENCE_MODELS = Object.freeze(
  Object.values(INTELLIGENCE_PROFILE_CATALOG.profiles).map(
    ({ requestedModel }) => requestedModel,
  ),
);
const INTELLIGENCE_EFFORTS = Object.freeze(
  [...new Set(
    Object.values(INTELLIGENCE_PROFILE_CATALOG.profiles).flatMap(
      ({ supportedEfforts }) => supportedEfforts,
    ),
  )],
);

// This is exported as the MCP tool schema so callers can construct valid plans
// before they reach the stricter semantic and dependency validation below.
export const SLICE_PLAN_INPUT_SCHEMA = Object.freeze({
  type: "object",
  description: "Dependency-aware Nelos slice plan.",
  properties: {
    schemaVersion: { type: "integer", const: SLICE_PLAN_SCHEMA_VERSION },
    objective: {
      type: "string",
      minLength: 1,
      maxLength: MAX_OBJECTIVE_CHARACTERS,
    },
    maxParallel: {
      type: "integer",
      minimum: 1,
      maximum: MAX_PARALLEL_SLICES,
    },
    slices: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PLAN_SLICES,
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
          },
          title: { type: "string", minLength: 1, maxLength: MAX_TITLE_CHARACTERS },
          objective: {
            type: "string",
            minLength: 1,
            maxLength: MAX_OBJECTIVE_CHARACTERS,
          },
          deliverable: {
            type: "string",
            minLength: 1,
            maxLength: MAX_DELIVERABLE_CHARACTERS,
          },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CRITERIA,
            items: {
              type: "string",
              minLength: 1,
              maxLength: MAX_CRITERION_CHARACTERS,
            },
          },
          dependsOn: {
            type: "array",
            maxItems: MAX_PLAN_SLICES,
            uniqueItems: true,
            items: {
              type: "string",
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
            },
          },
          lifecycle: { type: "string", enum: LIFECYCLES },
          workspaceMode: { type: "string", enum: WORKSPACE_MODES },
          taskShape: { type: "string", enum: INTELLIGENCE_TASK_SHAPES },
          routing: {
            type: "object",
            properties: {
              profile: { type: "string", enum: INTELLIGENCE_PROFILES },
              model: { type: "string", enum: INTELLIGENCE_MODELS },
              effort: { type: "string", enum: INTELLIGENCE_EFFORTS },
              nativeFanoutAllowed: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        required: [
          "id",
          "title",
          "objective",
          "deliverable",
          "acceptanceCriteria",
          "dependsOn",
          "lifecycle",
          "workspaceMode",
          "taskShape",
        ],
        additionalProperties: false,
        allOf: [
          {
            if: {
              properties: { workspaceMode: { const: "isolated-write" } },
              required: ["workspaceMode"],
            },
            then: {
              properties: { lifecycle: { const: "spinoff" } },
              required: ["lifecycle"],
            },
          },
        ],
      },
    },
  },
  required: ["schemaVersion", "objective", "slices"],
  additionalProperties: false,
});

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPlainObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknown = Object.keys(value)
    .filter((field) => !fields.has(field))
    .sort(compareStrings);
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field: ${unknown[0]}`);
  }
  return value;
}

function normalizeText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!normalized) throw new Error(`${field} must contain visible text`);
  if (normalized.length > maximum) {
    throw new Error(`${field} exceeds ${maximum} characters`);
  }
  return normalized;
}

function normalizeSliceId(value, field = "slice.id") {
  if (typeof value !== "string" || !SLICE_ID_PATTERN.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function normalizeStringList(
  value,
  field,
  { maximumItems, itemMaximum, allowEmpty = false },
) {
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new Error(
      allowEmpty
        ? `${field} must contain at most ${maximumItems} strings`
        : `${field} must contain between 1 and ${maximumItems} strings`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(`${field} must not contain empty slots`);
    }
  }
  return value.map((item, index) =>
    normalizeText(item, `${field}[${index}]`, itemMaximum),
  );
}

function normalizeRouting(value, index, taskShape) {
  if (value === undefined) return routeIntelligenceProfile({ taskShape });
  assertPlainObject(value, `slices[${index}].routing`, ROUTING_FIELDS);
  const input = { taskShape };
  if (value.profile !== undefined) {
    input.profileOverride = normalizeText(
      value.profile,
      `slices[${index}].routing.profile`,
      32,
    ).toLowerCase();
  }
  if (value.model !== undefined) {
    input.modelOverride = normalizeText(
      value.model,
      `slices[${index}].routing.model`,
      128,
    );
  }
  if (value.effort !== undefined) {
    input.effortOverride = normalizeText(
      value.effort,
      `slices[${index}].routing.effort`,
      32,
    ).toLowerCase();
  }
  if (value.nativeFanoutAllowed !== undefined) {
    if (typeof value.nativeFanoutAllowed !== "boolean") {
      throw new Error(
        `slices[${index}].routing.nativeFanoutAllowed must be a boolean`,
      );
    }
    input.nativeFanoutAllowed = value.nativeFanoutAllowed;
  }
  return routeIntelligenceProfile(input);
}

function normalizeSlice(value, index) {
  assertPlainObject(value, `slices[${index}]`, SLICE_FIELDS);
  const id = normalizeSliceId(value.id, `slices[${index}].id`);
  const lifecycle = value.lifecycle;
  if (!LIFECYCLES.includes(lifecycle)) {
    throw new Error(`slices[${index}].lifecycle must be spinoff or subagent`);
  }
  const workspaceMode = value.workspaceMode;
  if (!WORKSPACE_MODES.includes(workspaceMode)) {
    throw new Error(
      `slices[${index}].workspaceMode must be shared-read-only or isolated-write`,
    );
  }
  if (workspaceMode === "isolated-write" && lifecycle !== "spinoff") {
    throw new Error(`slice ${id} must be a spinoff to use an isolated worktree`);
  }
  const dependsOn = normalizeStringList(value.dependsOn, `slices[${index}].dependsOn`, {
    maximumItems: MAX_PLAN_SLICES,
    itemMaximum: 128,
    allowEmpty: true,
  }).map((dependency, dependencyIndex) =>
    normalizeSliceId(dependency, `slices[${index}].dependsOn[${dependencyIndex}]`),
  );
  if (new Set(dependsOn).size !== dependsOn.length) {
    throw new Error(`slice ${id} dependencies must not contain duplicates`);
  }
  if (dependsOn.includes(id)) {
    throw new Error(`slice ${id} must not depend on itself`);
  }
  const taskShape = normalizeText(
    value.taskShape,
    `slices[${index}].taskShape`,
    32,
  );
  return {
    id,
    title: normalizeText(value.title, `slices[${index}].title`, MAX_TITLE_CHARACTERS),
    objective: normalizeText(
      value.objective,
      `slices[${index}].objective`,
      MAX_OBJECTIVE_CHARACTERS,
    ),
    deliverable: normalizeText(
      value.deliverable,
      `slices[${index}].deliverable`,
      MAX_DELIVERABLE_CHARACTERS,
    ),
    acceptanceCriteria: normalizeStringList(
      value.acceptanceCriteria,
      `slices[${index}].acceptanceCriteria`,
      {
        maximumItems: MAX_CRITERIA,
        itemMaximum: MAX_CRITERION_CHARACTERS,
      },
    ),
    dependsOn,
    lifecycle,
    workspaceMode,
    taskShape,
    route: normalizeRouting(value.routing, index, taskShape),
  };
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Validate a queen-authored semantic decomposition, route every slice through
 * the reviewed model catalog, and return deterministic dependency waves.
 */
export function planWorkSlices(value) {
  assertPlainObject(value, "slice plan", PLAN_FIELDS);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("slice plan must be JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PLAN_BYTES) {
    throw new Error(`slice plan exceeds ${MAX_PLAN_BYTES} bytes`);
  }
  if (value.schemaVersion !== SLICE_PLAN_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be the number ${SLICE_PLAN_SCHEMA_VERSION}`);
  }
  if (
    !Array.isArray(value.slices) ||
    value.slices.length === 0 ||
    value.slices.length > MAX_PLAN_SLICES
  ) {
    throw new Error(`slices must contain between 1 and ${MAX_PLAN_SLICES} entries`);
  }
  const maxParallel = value.maxParallel ?? 4;
  if (
    !Number.isSafeInteger(maxParallel) ||
    maxParallel < 1 ||
    maxParallel > MAX_PARALLEL_SLICES
  ) {
    throw new Error(`maxParallel must be between 1 and ${MAX_PARALLEL_SLICES}`);
  }

  const objective = normalizeText(value.objective, "objective", MAX_OBJECTIVE_CHARACTERS);
  const slices = value.slices.map(normalizeSlice);
  const ids = new Set();
  for (const slice of slices) {
    if (ids.has(slice.id)) throw new Error(`duplicate slice id: ${slice.id}`);
    ids.add(slice.id);
  }
  for (const slice of slices) {
    const unknown = slice.dependsOn.find((dependency) => !ids.has(dependency));
    if (unknown) throw new Error(`slice ${slice.id} has unknown dependency: ${unknown}`);
  }

  const remaining = [...slices];
  const completed = new Set();
  const waves = [];
  while (remaining.length > 0) {
    const ready = remaining.filter((slice) =>
      slice.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) throw new Error("slice dependencies contain a cycle");
    const waveSlices = ready.slice(0, maxParallel);
    const waveIds = new Set(waveSlices.map((slice) => slice.id));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (waveIds.has(remaining[index].id)) remaining.splice(index, 1);
    }
    for (const slice of waveSlices) completed.add(slice.id);
    waves.push({
      index: waves.length + 1,
      parallel: waveSlices.length > 1,
      slices: waveSlices,
    });
  }

  const models = {};
  const efforts = {};
  let spinoffs = 0;
  let subagents = 0;
  for (const slice of slices) {
    if (slice.lifecycle === "spinoff") spinoffs += 1;
    else subagents += 1;
    incrementCount(models, slice.route.requestedModel ?? "host-default");
    incrementCount(efforts, slice.route.requestedEffort ?? "host-default");
  }

  return Object.freeze({
    schemaVersion: SLICE_PLAN_SCHEMA_VERSION,
    objective,
    maxParallel,
    catalogVersion: slices[0].route.catalogVersion,
    summary: Object.freeze({
      slices: slices.length,
      waves: waves.length,
      spinoffs,
      subagents,
      models: Object.freeze(models),
      efforts: Object.freeze(efforts),
    }),
    waves: Object.freeze(
      waves.map((wave) =>
        Object.freeze({
          ...wave,
          slices: Object.freeze(wave.slices.map((slice) => Object.freeze(slice))),
        }),
      ),
    ),
  });
}
