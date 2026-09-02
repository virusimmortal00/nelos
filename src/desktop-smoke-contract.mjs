const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const DESKTOP_SMOKE_ACTION_TYPES_V1 = Object.freeze([
  "click", "keypress", "scroll", "select_menu", "type_text_ref", "wait_for",
]);
export const DESKTOP_SMOKE_CHECKPOINT_TYPES_V1 = Object.freeze([
  "accessibility_tree", "window_state",
]);
export const DESKTOP_SMOKE_ASSERTION_TYPES_V1 = Object.freeze([
  "element_absent", "element_present", "task_state", "text_ref_present", "window_count",
]);
function fail(message) { throw new TypeError(message); }
function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has an unsupported shape`);
}
function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`);
}
function unique(items, key, label) {
  if (new Set(items.map((item) => item[key])).size !== items.length) fail(`${label} identifiers must be unique`);
}

export function validateDesktopSmokeScenarioV1(value) {
  exact(value, ["schemaVersion", "scenarioId", "task", "actions", "checkpoints", "assertions", "deadlineMs"], "scenario");
  if (value.schemaVersion !== 1) fail("scenario schemaVersion must be 1");
  identifier(value.scenarioId, "scenarioId");
  exact(value.task, ["taskId", "createdForScenario", "fresh"], "scenario task");
  identifier(value.task.taskId, "taskId");
  if (value.task.createdForScenario !== value.scenarioId || value.task.fresh !== true) fail("scenario task must be fresh and scenario-bound");
  if (!Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 1 || value.deadlineMs > 30 * 60 * 1_000) fail("scenario deadline is invalid");
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 100) fail("scenario actions are invalid");
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length < 1 || value.checkpoints.length > 100) fail("scenario checkpoints are invalid");
  if (!Array.isArray(value.assertions) || value.assertions.length > 100) fail("scenario assertions are invalid");
  const actions = new Set(DESKTOP_SMOKE_ACTION_TYPES_V1);
  for (const action of value.actions) {
    exact(action, ["actionId", "type", "targetRef", "valueRef", "timeoutMs"], "scenario action");
    identifier(action.actionId, "actionId"); identifier(action.targetRef, "targetRef");
    if (!actions.has(action.type)) fail("scenario action is not allowlisted");
    if (action.valueRef !== null) identifier(action.valueRef, "valueRef");
    if (action.type === "type_text_ref" ? action.valueRef === null : action.valueRef !== null) fail("only type_text_ref may carry a valueRef");
    if (!Number.isSafeInteger(action.timeoutMs) || action.timeoutMs < 1 || action.timeoutMs > 5 * 60 * 1_000) fail("action timeout is invalid");
  }
  unique(value.actions, "actionId", "action");
  const actionIds = new Set(value.actions.map(({ actionId }) => actionId));
  const checkpoints = new Set(DESKTOP_SMOKE_CHECKPOINT_TYPES_V1);
  for (const checkpoint of value.checkpoints) {
    exact(checkpoint, ["checkpointId", "type", "afterActionId", "failureOnly"], "scenario checkpoint");
    identifier(checkpoint.checkpointId, "checkpointId"); identifier(checkpoint.afterActionId, "afterActionId");
    if (!checkpoints.has(checkpoint.type) || !actionIds.has(checkpoint.afterActionId) || typeof checkpoint.failureOnly !== "boolean") fail("scenario checkpoint is invalid");
  }
  unique(value.checkpoints, "checkpointId", "checkpoint");
  const checkpointIds = new Set(value.checkpoints.map(({ checkpointId }) => checkpointId));
  const checkpointById = new Map(value.checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint]));
  const assertions = new Set(DESKTOP_SMOKE_ASSERTION_TYPES_V1);
  for (const assertion of value.assertions) {
    exact(assertion, ["assertionId", "type", "targetRef", "expectedRef", "checkpointId"], "scenario assertion");
    identifier(assertion.assertionId, "assertionId"); identifier(assertion.targetRef, "targetRef"); identifier(assertion.checkpointId, "checkpointId");
    if (!assertions.has(assertion.type) || !checkpointIds.has(assertion.checkpointId) || checkpointById.get(assertion.checkpointId).failureOnly) fail("scenario assertion is invalid or attached to a failure-only checkpoint");
    if (assertion.expectedRef !== null) identifier(assertion.expectedRef, "expectedRef");
  }
  unique(value.assertions, "assertionId", "assertion");
  return structuredClone(value);
}

export function validateDesktopSmokeScenarioSetV1(value) {
  exact(value, ["schemaVersion", "scenarioSetId", "scenarios"], "scenario set");
  if (value.schemaVersion !== 1) fail("scenario set schemaVersion must be 1");
  identifier(value.scenarioSetId, "scenarioSetId");
  if (!Array.isArray(value.scenarios) || value.scenarios.length < 1 || value.scenarios.length > 100) fail("scenario set scenarios are invalid");
  const scenarios = value.scenarios.map((scenario) => validateDesktopSmokeScenarioV1(scenario));
  unique(scenarios, "scenarioId", "scenario");
  unique(scenarios.map(({ task }) => task), "taskId", "scenario task");
  return { schemaVersion: 1, scenarioSetId: value.scenarioSetId, scenarios };
}

export function validateDesktopSmokeCoverageMatrixV1(value, scenarioSets) {
  exact(value, ["schemaVersion", "libraryId", "coverage"], "coverage matrix");
  if (value.schemaVersion !== 1) fail("coverage matrix schemaVersion must be 1");
  identifier(value.libraryId, "libraryId");
  exact(scenarioSets, ["release", "routine"], "scenario libraries");
  const release = validateDesktopSmokeScenarioSetV1(scenarioSets.release);
  const routine = validateDesktopSmokeScenarioSetV1(scenarioSets.routine);
  if (release.scenarioSetId !== "release" || routine.scenarioSetId !== "routine") fail("scenario library identifiers are invalid");
  if (!Array.isArray(value.coverage) || value.coverage.length !== release.scenarios.length) fail("coverage matrix must describe every release scenario exactly once");
  const releaseById = new Map(release.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const routineIds = new Set(routine.scenarios.map(({ scenarioId }) => scenarioId));
  const capabilityIds = new Set();
  const scenarioIds = new Set();
  for (const row of value.coverage) {
    exact(row, ["scenarioId", "capabilityId", "expectedCheckpointIds", "release", "routine"], "coverage row");
    identifier(row.scenarioId, "coverage scenarioId");
    identifier(row.capabilityId, "capabilityId");
    if (scenarioIds.has(row.scenarioId) || capabilityIds.has(row.capabilityId)) fail("coverage rows must map distinct scenarios to distinct capabilities");
    scenarioIds.add(row.scenarioId); capabilityIds.add(row.capabilityId);
    const scenario = releaseById.get(row.scenarioId);
    if (!scenario || row.release !== true || row.routine !== routineIds.has(row.scenarioId)) fail("coverage row library membership is inconsistent");
    if (!Array.isArray(row.expectedCheckpointIds) || row.expectedCheckpointIds.length < 1 || new Set(row.expectedCheckpointIds).size !== row.expectedCheckpointIds.length) fail("coverage checkpoints are invalid");
    const reviewable = new Set(scenario.checkpoints.filter(({ failureOnly }) => !failureOnly).map(({ checkpointId }) => checkpointId));
    if (row.expectedCheckpointIds.some((checkpointId) => !reviewable.has(checkpointId))) fail("coverage checkpoint is not a normal state-transition checkpoint");
    if (scenario.assertions.some(({ type }) => type === "text_ref_present")) fail("library assertions must not inspect visible exchange text");
  }
  if (scenarioIds.size !== releaseById.size || routine.scenarios.some((scenario) => {
    const releaseScenario = releaseById.get(scenario.scenarioId);
    return !releaseScenario || JSON.stringify(scenario) !== JSON.stringify(releaseScenario);
  })) fail("routine scenarios must be identical release-library members");
  return { matrix: structuredClone(value), release, routine };
}
