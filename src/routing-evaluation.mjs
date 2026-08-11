import { INTELLIGENCE_PROFILE_CATALOG } from "./intelligence-profile-catalog.mjs";
import { INTELLIGENCE_TASK_SHAPES } from "./intelligence-profile-router.mjs";

export const ROUTING_EVALUATION_SCHEMA_VERSION = 1;
export const ROUTING_OBSERVATION_SCHEMA_VERSION = 1;

const SUITE_FIELDS = new Set([
  "schemaVersion",
  "suiteId",
  "description",
  "scenarios",
]);
const SCENARIO_FIELDS = new Set([
  "id",
  "title",
  "lane",
  "enabledByDefault",
  "prompt",
  "expectation",
]);
const EXPECTATION_FIELDS = new Set([
  "baseline",
  "terminalState",
  "minimumMembers",
  "maximumMembers",
  "requiredRoutes",
  "forbiddenRoutes",
  "requireExactRuntimeVerification",
  "routeSchemaVersion",
  "policyVersion",
  "catalogVersion",
]);
const ROUTE_EXPECTATION_FIELDS = new Set([
  "model",
  "effort",
  "lifecycle",
  "taskShape",
  "modelSelection",
  "effortSelection",
  "minimumCount",
]);
const OBSERVATION_FIELDS = new Set(["schemaVersion", "suiteId", "runs"]);
const RUN_FIELDS = new Set([
  "scenarioId",
  "queenTaskId",
  "orchestrationQueenTaskId",
  "workspaceId",
  "freshQueen",
  "terminalState",
  "members",
]);
const MEMBER_FIELDS = new Set([
  "sliceId",
  "lifecycle",
  "threadId",
  "turnId",
  "routeSchemaVersion",
  "policyVersion",
  "catalogVersion",
  "taskShape",
  "profile",
  "modelSelection",
  "effortSelection",
  "decisionEvidenceSource",
  "requestedModel",
  "requestedEffort",
  "observedModel",
  "observedEffort",
  "verified",
  "evidenceSource",
]);

const LANES = Object.freeze([
  "shape-recommendation",
  "explicit-route",
  "semantic-challenge",
]);
const BASELINES = Object.freeze(["must-pass", "known-gap"]);
const EXPECTED_TERMINAL_STATES = Object.freeze(["complete", "attention"]);
const OBSERVED_TERMINAL_STATES = Object.freeze([
  ...EXPECTED_TERMINAL_STATES,
  "launch-pending",
]);
const LIFECYCLES = Object.freeze(["subagent", "spinoff"]);
const EVIDENCE_SOURCES = Object.freeze(["runtime-intelligence-verification"]);
const DECISION_EVIDENCE_SOURCES = Object.freeze(["nelos-route-decision"]);
const SELECTION_SOURCES = Object.freeze(["inherit", "recommended", "override"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EFFORTS = Object.freeze([
  ...new Set(
    Object.values(INTELLIGENCE_PROFILE_CATALOG.profiles).flatMap(
      ({ supportedEfforts }) => supportedEfforts,
    ),
  ),
]);
const MODELS = Object.freeze(
  Object.values(INTELLIGENCE_PROFILE_CATALOG.profiles).map(
    ({ requestedModel }) => requestedModel,
  ),
);
const LIVE_PROMPT_PROTOCOL = `Live evaluation protocol:
- This current task is the fresh queen. Use its own native task/thread ID as both the scenario queen and the Nelos orchestration queen; a delegation source_thread_id is provenance only and must not replace the current queen identity.
- Use the Nelos task-management skill and its machine-generated actions exactly. If installed plugin tools are lazy, use available tool discovery to load the Nelos MCP tools before declaring them unavailable. Listing MCP resources is not plugin-tool discovery.
- Never substitute a CLI, generic launcher, model, effort, lifecycle, or workspace mode for an unavailable exact action.
- In the final response, include a compact Routing observation with the scenario queen task ID, orchestration queen task ID, isolated workspace ID/path, terminal state, and—only from exact Nelos/native evidence—for every worker: slice ID, lifecycle, thread ID, turn ID, route schema version, policy version, catalog version, task shape, profile, modelSelection, effortSelection, requested model/effort, observed model/effort, and runtime-verification result. Mark unavailable fields unavailable; never infer them.`;

function assertPlainObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
  return value;
}

function nonEmptyString(value, label, maximum = 16_384) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return value;
}

function identifier(value, label) {
  nonEmptyString(value, label, 256);
  if (!IDENTIFIER.test(value)) throw new Error(`${label} has an invalid format`);
  return value;
}

function enumeration(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function modelEffort(modelValue, effortValue, label) {
  const model = enumeration(modelValue, MODELS, `${label}.model`);
  const effort = enumeration(effortValue, EFFORTS, `${label}.effort`);
  const profile = Object.values(INTELLIGENCE_PROFILE_CATALOG.profiles).find(
    ({ requestedModel }) => requestedModel === model,
  );
  if (!profile.supportedEfforts.includes(effort)) {
    throw new Error(`${label} selects an unsupported route`);
  }
  return { model, effort };
}

function validateRouteExpectation(value, label) {
  assertPlainObject(value, label, ROUTE_EXPECTATION_FIELDS);
  const { model, effort } = modelEffort(value.model, value.effort, label);
  return Object.freeze({
    model,
    effort,
    lifecycle: enumeration(value.lifecycle, LIFECYCLES, `${label}.lifecycle`),
    taskShape: enumeration(value.taskShape, INTELLIGENCE_TASK_SHAPES, `${label}.taskShape`),
    modelSelection: enumeration(
      value.modelSelection,
      SELECTION_SOURCES,
      `${label}.modelSelection`,
    ),
    effortSelection: enumeration(
      value.effortSelection,
      SELECTION_SOURCES,
      `${label}.effortSelection`,
    ),
    minimumCount: boundedInteger(
      value.minimumCount,
      `${label}.minimumCount`,
      1,
      32,
    ),
  });
}

function routeKey({ model, effort }) {
  return `${model}/${effort}`;
}

function memberRouteKey({ lifecycle, model, effort }) {
  return `${lifecycle}:${routeKey({ model, effort })}`;
}

function decisionKey(route) {
  return [
    memberRouteKey(route),
    route.taskShape,
    route.modelSelection,
    route.effortSelection,
  ].join(":");
}

function validateScenario(value, index) {
  const label = `scenarios[${index}]`;
  assertPlainObject(value, label, SCENARIO_FIELDS);
  const expectationLabel = `${label}.expectation`;
  assertPlainObject(value.expectation, expectationLabel, EXPECTATION_FIELDS);
  if (typeof value.enabledByDefault !== "boolean") {
    throw new Error(`${label}.enabledByDefault must be a boolean`);
  }
  const minimumMembers = boundedInteger(
    value.expectation.minimumMembers,
    `${expectationLabel}.minimumMembers`,
    1,
    32,
  );
  const maximumMembers = boundedInteger(
    value.expectation.maximumMembers,
    `${expectationLabel}.maximumMembers`,
    minimumMembers,
    32,
  );
  if (!Array.isArray(value.expectation.requiredRoutes) || value.expectation.requiredRoutes.length === 0) {
    throw new Error(`${expectationLabel}.requiredRoutes must be a non-empty array`);
  }
  if (!Array.isArray(value.expectation.forbiddenRoutes)) {
    throw new Error(`${expectationLabel}.forbiddenRoutes must be an array`);
  }
  if (value.expectation.requireExactRuntimeVerification !== true) {
    throw new Error(`${expectationLabel}.requireExactRuntimeVerification must be true`);
  }
  const routeSchemaVersion = boundedInteger(
    value.expectation.routeSchemaVersion,
    `${expectationLabel}.routeSchemaVersion`,
    1,
    100,
  );
  const policyVersion = boundedInteger(
    value.expectation.policyVersion,
    `${expectationLabel}.policyVersion`,
    1,
    1_000_000,
  );
  const catalogVersion = nonEmptyString(
    value.expectation.catalogVersion,
    `${expectationLabel}.catalogVersion`,
    128,
  );
  const requiredRoutes = value.expectation.requiredRoutes.map((route, routeIndex) =>
    validateRouteExpectation(route, `${expectationLabel}.requiredRoutes[${routeIndex}]`),
  );
  const forbiddenRoutes = value.expectation.forbiddenRoutes.map((route, routeIndex) =>
    validateRouteExpectation(route, `${expectationLabel}.forbiddenRoutes[${routeIndex}]`),
  );
  const requiredKeys = requiredRoutes.map(decisionKey);
  if (new Set(requiredKeys).size !== requiredKeys.length) {
    throw new Error(`${expectationLabel}.requiredRoutes contains duplicate routes`);
  }
  const forbiddenKeys = forbiddenRoutes.map(decisionKey);
  if (new Set(forbiddenKeys).size !== forbiddenKeys.length) {
    throw new Error(`${expectationLabel}.forbiddenRoutes contains duplicate routes`);
  }
  const overlap = requiredKeys.find((key) => forbiddenKeys.includes(key));
  if (overlap) throw new Error(`${expectationLabel} both requires and forbids ${overlap}`);
  return Object.freeze({
    id: identifier(value.id, `${label}.id`),
    title: nonEmptyString(value.title, `${label}.title`, 160),
    lane: enumeration(value.lane, LANES, `${label}.lane`),
    enabledByDefault: value.enabledByDefault,
    prompt: nonEmptyString(value.prompt, `${label}.prompt`, 64 * 1024),
    expectation: Object.freeze({
      baseline: enumeration(value.expectation.baseline, BASELINES, `${expectationLabel}.baseline`),
      terminalState: enumeration(
        value.expectation.terminalState,
        EXPECTED_TERMINAL_STATES,
        `${expectationLabel}.terminalState`,
      ),
      minimumMembers,
      maximumMembers,
      requiredRoutes: Object.freeze(requiredRoutes),
      forbiddenRoutes: Object.freeze(forbiddenRoutes),
      requireExactRuntimeVerification: true,
      routeSchemaVersion,
      policyVersion,
      catalogVersion,
    }),
  });
}

export function validateRoutingEvalSuiteV1(value) {
  assertPlainObject(value, "routing evaluation suite", SUITE_FIELDS);
  if (value.schemaVersion !== ROUTING_EVALUATION_SCHEMA_VERSION) {
    throw new Error(`routing evaluation schemaVersion must be ${ROUTING_EVALUATION_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0 || value.scenarios.length > 64) {
    throw new Error("routing evaluation scenarios must contain between 1 and 64 entries");
  }
  const scenarios = value.scenarios.map(validateScenario);
  if (new Set(scenarios.map(({ id }) => id)).size !== scenarios.length) {
    throw new Error("routing evaluation scenario IDs must be unique");
  }
  if (!scenarios.some(({ expectation }) => expectation.baseline === "must-pass")) {
    throw new Error("routing evaluation suite requires at least one must-pass scenario");
  }
  if (!scenarios.some(({ expectation }) => expectation.baseline === "known-gap")) {
    throw new Error("routing evaluation suite requires at least one known-gap challenge");
  }
  return Object.freeze({
    schemaVersion: ROUTING_EVALUATION_SCHEMA_VERSION,
    suiteId: identifier(value.suiteId, "routing evaluation suiteId"),
    description: nonEmptyString(value.description, "routing evaluation description", 2_000),
    scenarios: Object.freeze(scenarios),
  });
}

function validateMember(value, label) {
  assertPlainObject(value, label, MEMBER_FIELDS);
  for (const field of ["verified"]) {
    if (typeof value[field] !== "boolean") throw new Error(`${label}.${field} must be a boolean`);
  }
  const requested = modelEffort(
    value.requestedModel,
    value.requestedEffort,
    `${label}.requested`,
  );
  const observedUnavailable =
    value.observedModel === null && value.observedEffort === null;
  if (
    (value.observedModel === null) !== (value.observedEffort === null)
  ) {
    throw new Error(
      `${label}.observedModel and ${label}.observedEffort must both be null or both be populated`,
    );
  }
  if (value.verified && observedUnavailable) {
    throw new Error(`${label}.verified members require an observed runtime route`);
  }
  const observed = observedUnavailable
    ? { model: null, effort: null }
    : modelEffort(
        value.observedModel,
        value.observedEffort,
        `${label}.observed`,
      );
  const profile = Object.values(INTELLIGENCE_PROFILE_CATALOG.profiles).find(
    ({ requestedModel }) => requestedModel === requested.model,
  );
  if (value.profile !== profile.id) {
    throw new Error(`${label}.profile does not match requestedModel`);
  }
  return Object.freeze({
    sliceId: identifier(value.sliceId, `${label}.sliceId`),
    lifecycle: enumeration(value.lifecycle, LIFECYCLES, `${label}.lifecycle`),
    threadId: identifier(value.threadId, `${label}.threadId`),
    turnId: identifier(value.turnId, `${label}.turnId`),
    routeSchemaVersion: boundedInteger(
      value.routeSchemaVersion,
      `${label}.routeSchemaVersion`,
      1,
      100,
    ),
    policyVersion: boundedInteger(
      value.policyVersion,
      `${label}.policyVersion`,
      1,
      1_000_000,
    ),
    catalogVersion: nonEmptyString(value.catalogVersion, `${label}.catalogVersion`, 128),
    taskShape: enumeration(value.taskShape, INTELLIGENCE_TASK_SHAPES, `${label}.taskShape`),
    profile: value.profile,
    modelSelection: enumeration(
      value.modelSelection,
      SELECTION_SOURCES,
      `${label}.modelSelection`,
    ),
    effortSelection: enumeration(
      value.effortSelection,
      SELECTION_SOURCES,
      `${label}.effortSelection`,
    ),
    decisionEvidenceSource: enumeration(
      value.decisionEvidenceSource,
      DECISION_EVIDENCE_SOURCES,
      `${label}.decisionEvidenceSource`,
    ),
    requestedModel: requested.model,
    requestedEffort: requested.effort,
    observedModel: observed.model,
    observedEffort: observed.effort,
    verified: value.verified,
    evidenceSource: enumeration(
      value.evidenceSource,
      EVIDENCE_SOURCES,
      `${label}.evidenceSource`,
    ),
  });
}

function validateRun(value, index) {
  const label = `runs[${index}]`;
  assertPlainObject(value, label, RUN_FIELDS);
  if (value.freshQueen !== true) throw new Error(`${label}.freshQueen must be true`);
  const terminalState = enumeration(
    value.terminalState,
    OBSERVED_TERMINAL_STATES,
    `${label}.terminalState`,
  );
  if (!Array.isArray(value.members) || value.members.length > 32) {
    throw new Error(`${label}.members must contain between 0 and 32 entries`);
  }
  if (value.members.length === 0 && terminalState === "complete") {
    throw new Error(`${label}.complete runs require at least one member`);
  }
  const members = value.members.map((member, memberIndex) =>
    validateMember(member, `${label}.members[${memberIndex}]`),
  );
  const orchestrationQueenTaskId = value.orchestrationQueenTaskId === null
    ? null
    : identifier(value.orchestrationQueenTaskId, `${label}.orchestrationQueenTaskId`);
  if (members.length > 0 && orchestrationQueenTaskId === null) {
    throw new Error(`${label}.orchestrationQueenTaskId is required when workers launched`);
  }
  if (new Set(members.map(({ sliceId }) => sliceId)).size !== members.length) {
    throw new Error(`${label}.members contains duplicate sliceId`);
  }
  for (const [field, identityLabel] of [["threadId", "threadId"], ["turnId", "turnId"]]) {
    if (new Set(members.map((member) => member[field])).size !== members.length) {
      throw new Error(`${label}.members contains duplicate ${identityLabel}`);
    }
  }
  return Object.freeze({
    scenarioId: identifier(value.scenarioId, `${label}.scenarioId`),
    queenTaskId: identifier(value.queenTaskId, `${label}.queenTaskId`),
    orchestrationQueenTaskId,
    workspaceId: identifier(value.workspaceId, `${label}.workspaceId`),
    freshQueen: true,
    terminalState,
    members: Object.freeze(members),
  });
}

export function validateRoutingObservationV1(value, suiteValue) {
  const suite = validateRoutingEvalSuiteV1(suiteValue);
  assertPlainObject(value, "routing observation", OBSERVATION_FIELDS);
  if (value.schemaVersion !== ROUTING_OBSERVATION_SCHEMA_VERSION) {
    throw new Error(`routing observation schemaVersion must be ${ROUTING_OBSERVATION_SCHEMA_VERSION}`);
  }
  if (value.suiteId !== suite.suiteId) {
    throw new Error("routing observation suiteId does not match the evaluation suite");
  }
  if (!Array.isArray(value.runs) || value.runs.length === 0 || value.runs.length > suite.scenarios.length) {
    throw new Error("routing observation runs must be a non-empty scenario subset");
  }
  const runs = value.runs.map(validateRun);
  const scenarioIds = new Set(suite.scenarios.map(({ id }) => id));
  for (const run of runs) {
    if (!scenarioIds.has(run.scenarioId)) {
      throw new Error(`routing observation references unknown scenario: ${run.scenarioId}`);
    }
  }
  for (const [field, label] of [
    ["scenarioId", "scenario"],
    ["queenTaskId", "queen task"],
    ["workspaceId", "workspace"],
  ]) {
    if (new Set(runs.map((run) => run[field])).size !== runs.length) {
      throw new Error(`routing observation must use a unique ${label} for every run`);
    }
  }
  const memberThreadIds = runs.flatMap((run) => run.members.map(({ threadId }) => threadId));
  if (new Set(memberThreadIds).size !== memberThreadIds.length) {
    throw new Error("routing observation must use a unique worker thread for every member");
  }
  const queenTaskIds = new Set(runs.map(({ queenTaskId }) => queenTaskId));
  if (memberThreadIds.some((threadId) => queenTaskIds.has(threadId))) {
    throw new Error("routing observation worker thread must not equal a queen task ID");
  }
  return Object.freeze({
    schemaVersion: ROUTING_OBSERVATION_SCHEMA_VERSION,
    suiteId: suite.suiteId,
    runs: Object.freeze(runs),
  });
}

function evaluateRun(run, scenario) {
  const hardFailures = [];
  const policyFailures = [];
  const { expectation } = scenario;
  if (run.terminalState !== expectation.terminalState) {
    hardFailures.push(`terminal state ${run.terminalState} != ${expectation.terminalState}`);
  }
  if (run.orchestrationQueenTaskId !== null && run.orchestrationQueenTaskId !== run.queenTaskId) {
    hardFailures.push(
      `orchestration queen ${run.orchestrationQueenTaskId} != isolated queen ${run.queenTaskId}`,
    );
  }
  if (run.members.length < expectation.minimumMembers || run.members.length > expectation.maximumMembers) {
    hardFailures.push(
      `member count ${run.members.length} is outside ${expectation.minimumMembers}-${expectation.maximumMembers}`,
    );
  }
  for (const member of run.members) {
    if (member.routeSchemaVersion !== expectation.routeSchemaVersion) {
      hardFailures.push(
        `${member.sliceId} route schema ${member.routeSchemaVersion} != ${expectation.routeSchemaVersion}`,
      );
    }
    if (member.policyVersion !== expectation.policyVersion) {
      hardFailures.push(
        `${member.sliceId} policy ${member.policyVersion} != ${expectation.policyVersion}`,
      );
    }
    if (member.catalogVersion !== expectation.catalogVersion) {
      hardFailures.push(
        `${member.sliceId} catalog ${member.catalogVersion} != ${expectation.catalogVersion}`,
      );
    }
    if (!member.verified) hardFailures.push(`${member.sliceId} has no verified runtime route`);
    if (member.observedModel === null) {
      hardFailures.push(`${member.sliceId} observed runtime route is unavailable`);
    } else if (
      member.requestedModel !== member.observedModel ||
      member.requestedEffort !== member.observedEffort
    ) {
      hardFailures.push(
        `${member.sliceId} observed ${member.observedModel}/${member.observedEffort} instead of ${member.requestedModel}/${member.requestedEffort}`,
      );
    }
  }
  const routeCounts = new Map();
  for (const member of run.members) {
    const key = decisionKey({
      lifecycle: member.lifecycle,
      model: member.requestedModel,
      effort: member.requestedEffort,
      taskShape: member.taskShape,
      modelSelection: member.modelSelection,
      effortSelection: member.effortSelection,
    });
    routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
  }
  for (const route of expectation.requiredRoutes) {
    const count = routeCounts.get(decisionKey(route)) ?? 0;
    if (count < route.minimumCount) {
      policyFailures.push(
        `required decision ${decisionKey(route)} appeared ${count} time(s), expected at least ${route.minimumCount}`,
      );
    }
  }
  for (const route of expectation.forbiddenRoutes) {
    const count = routeCounts.get(decisionKey(route)) ?? 0;
    if (count >= route.minimumCount) {
      policyFailures.push(
        `forbidden decision ${decisionKey(route)} appeared ${count} time(s)`,
      );
    }
  }
  const failures = [...hardFailures, ...policyFailures];
  const status = hardFailures.length > 0
    ? "fail"
    : expectation.baseline === "known-gap"
      ? policyFailures.length === 0 ? "unexpected-pass" : "known-gap-reproduced"
      : policyFailures.length === 0 ? "pass" : "fail";
  return Object.freeze({
    scenarioId: scenario.id,
    baseline: expectation.baseline,
    status,
    failures: Object.freeze(failures),
  });
}

export function gradeRoutingEvalSuiteV1(suiteValue, observationValue, { requireComplete = true } = {}) {
  const suite = validateRoutingEvalSuiteV1(suiteValue);
  const observation = validateRoutingObservationV1(observationValue, suite);
  const runByScenario = new Map(observation.runs.map((run) => [run.scenarioId, run]));
  const selectedScenarios = requireComplete
    ? suite.scenarios.filter(({ enabledByDefault }) => enabledByDefault)
    : suite.scenarios.filter(({ id }) => runByScenario.has(id));
  const missing = selectedScenarios
    .filter(({ id }) => !runByScenario.has(id))
    .map(({ id }) => id);
  const results = selectedScenarios
    .filter(({ id }) => runByScenario.has(id))
    .map((scenario) => evaluateRun(runByScenario.get(scenario.id), scenario));
  const gatingFailures = [
    ...missing,
    ...results.filter(({ status }) => status === "fail").map(({ scenarioId }) => scenarioId),
  ];
  return Object.freeze({
    schemaVersion: 1,
    suiteId: suite.suiteId,
    passed: gatingFailures.length === 0,
    complete: missing.length === 0,
    missing: Object.freeze(missing),
    results: Object.freeze(results),
    summary: Object.freeze({
      pass: results.filter(({ status }) => status === "pass").length,
      fail: results.filter(({ status }) => status === "fail").length,
      knownGapReproduced: results.filter(({ status }) => status === "known-gap-reproduced").length,
      unexpectedPass: results.filter(({ status }) => status === "unexpected-pass").length,
    }),
  });
}

export function routingEvalCoverageV1(suiteValue) {
  const suite = validateRoutingEvalSuiteV1(suiteValue);
  const routes = new Set();
  const models = new Set();
  const efforts = new Set();
  const taskShapes = new Set();
  for (const scenario of suite.scenarios) {
    for (const route of scenario.expectation.requiredRoutes) {
      routes.add(memberRouteKey(route));
      models.add(route.model);
      efforts.add(route.effort);
      taskShapes.add(route.taskShape);
    }
  }
  return Object.freeze({
    scenarios: suite.scenarios.length,
    enabledByDefault: suite.scenarios.filter(({ enabledByDefault }) => enabledByDefault).length,
    knownGaps: suite.scenarios.filter(({ expectation }) => expectation.baseline === "known-gap").length,
    models: Object.freeze([...models].sort()),
    efforts: Object.freeze([...efforts].sort()),
    taskShapes: Object.freeze([...taskShapes].sort()),
    routes: Object.freeze([...routes].sort()),
  });
}

export function createRoutingObservationTemplateV1(suiteValue, scenarioIds = null) {
  const suite = validateRoutingEvalSuiteV1(suiteValue);
  if (scenarioIds !== null && new Set(scenarioIds).size !== scenarioIds.length) {
    throw new Error("routing observation template scenario IDs must be unique");
  }
  const selected = scenarioIds === null
    ? suite.scenarios.filter(({ enabledByDefault }) => enabledByDefault)
    : scenarioIds.map((scenarioId) => {
        const scenario = suite.scenarios.find(({ id }) => id === scenarioId);
        if (!scenario) throw new Error(`unknown routing scenario: ${scenarioId}`);
        return scenario;
      });
  return {
    schemaVersion: ROUTING_OBSERVATION_SCHEMA_VERSION,
    suiteId: suite.suiteId,
    runs: selected.map((scenario) => ({
      scenarioId: scenario.id,
      queenTaskId: `replace-queen-${scenario.id}`,
      orchestrationQueenTaskId: `replace-queen-${scenario.id}`,
      workspaceId: `replace-workspace-${scenario.id}`,
      freshQueen: true,
      terminalState: scenario.expectation.terminalState,
      members: scenario.expectation.requiredRoutes.flatMap((route, routeIndex) =>
        Array.from({ length: route.minimumCount }, (_, countIndex) => ({
          sliceId: `replace-slice-${routeIndex + 1}-${countIndex + 1}`,
          lifecycle: route.lifecycle,
          threadId: `replace-worker-${routeIndex + 1}-${countIndex + 1}`,
          turnId: `replace-turn-${routeIndex + 1}-${countIndex + 1}`,
          routeSchemaVersion: scenario.expectation.routeSchemaVersion,
          policyVersion: scenario.expectation.policyVersion,
          catalogVersion: scenario.expectation.catalogVersion,
          taskShape: route.taskShape,
          profile: Object.values(INTELLIGENCE_PROFILE_CATALOG.profiles).find(
            ({ requestedModel }) => requestedModel === route.model,
          ).id,
          modelSelection: route.modelSelection,
          effortSelection: route.effortSelection,
          decisionEvidenceSource: "nelos-route-decision",
          requestedModel: route.model,
          requestedEffort: route.effort,
          observedModel: route.model,
          observedEffort: route.effort,
          verified: false,
          evidenceSource: "runtime-intelligence-verification",
        })),
      ),
    })),
  };
}

function scopeRoutingScenarioPromptV1(prompt, runId) {
  if (
    typeof runId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$/u.test(runId)
  ) {
    throw new Error("routing prompt runId has an invalid format");
  }
  const planStart = prompt.indexOf("\n\n{");
  if (planStart === -1) {
    throw new Error("routing scenario prompt has no structured plan");
  }
  let plan;
  try {
    plan = JSON.parse(prompt.slice(planStart + 2));
  } catch (error) {
    throw new Error(`routing scenario prompt plan is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(plan.slices) || plan.slices.length === 0) {
    throw new Error("routing scenario prompt plan has no slices");
  }
  const scopedIds = new Map(
    plan.slices.map(({ id }) => [id, `${id}--${runId}`]),
  );
  for (const scopedId of scopedIds.values()) {
    if (scopedId.length > 128) {
      throw new Error("routing prompt scoped slice ID exceeds 128 characters");
    }
    identifier(scopedId, "routing prompt scoped slice ID");
  }
  plan.slices = plan.slices.map((slice) => ({
    ...slice,
    id: scopedIds.get(slice.id),
    dependsOn: slice.dependsOn.map((dependency) => {
      const scoped = scopedIds.get(dependency);
      if (!scoped) {
        throw new Error(`routing scenario prompt has unknown dependency: ${dependency}`);
      }
      return scoped;
    }),
  }));
  return `${prompt.slice(0, planStart + 2)}${JSON.stringify(plan, null, 2)}`;
}

export function createRoutingLivePromptV1(
  suiteValue,
  scenarioId,
  { runId = null } = {},
) {
  const suite = validateRoutingEvalSuiteV1(suiteValue);
  const scenario = suite.scenarios.find(({ id }) => id === scenarioId);
  if (!scenario) throw new Error(`unknown routing scenario: ${scenarioId}`);
  const prompt = runId === null
    ? scenario.prompt
    : scopeRoutingScenarioPromptV1(scenario.prompt, runId);
  return `${prompt}\n\n${LIVE_PROMPT_PROTOCOL}`;
}
