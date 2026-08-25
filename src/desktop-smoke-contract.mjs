const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const DESKTOP_SMOKE_ACTION_TYPES_V1 = Object.freeze([
  "click", "keypress", "scroll", "select_menu", "type_text_ref", "wait_for",
]);
export const DESKTOP_SMOKE_CHECKPOINT_TYPES_V1 = Object.freeze([
  "accessibility_tree", "screenshot", "window_state",
]);
export const DESKTOP_SMOKE_ASSERTION_TYPES_V1 = Object.freeze([
  "element_absent", "element_present", "task_state", "text_ref_present", "window_count",
]);
export const DESKTOP_SMOKE_FAILURE_TRIGGERS_V1 = Object.freeze([
  "action_error", "assertion_failure", "deadline_exceeded", "desktop_crash", "task_stalled",
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
  exact(value, ["schemaVersion", "scenarioId", "task", "actions", "checkpoints", "assertions", "deadlineMs", "failureCaptureTriggers"], "scenario");
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
  const assertions = new Set(DESKTOP_SMOKE_ASSERTION_TYPES_V1);
  for (const assertion of value.assertions) {
    exact(assertion, ["assertionId", "type", "targetRef", "expectedRef", "checkpointId"], "scenario assertion");
    identifier(assertion.assertionId, "assertionId"); identifier(assertion.targetRef, "targetRef"); identifier(assertion.checkpointId, "checkpointId");
    if (!assertions.has(assertion.type) || !checkpointIds.has(assertion.checkpointId)) fail("scenario assertion is invalid");
    if (assertion.expectedRef !== null) identifier(assertion.expectedRef, "expectedRef");
  }
  unique(value.assertions, "assertionId", "assertion");
  if (!Array.isArray(value.failureCaptureTriggers) || new Set(value.failureCaptureTriggers).size !== value.failureCaptureTriggers.length || value.failureCaptureTriggers.some((item) => !DESKTOP_SMOKE_FAILURE_TRIGGERS_V1.includes(item))) fail("failure capture triggers are invalid");
  return structuredClone(value);
}

export function validateDesktopSmokeCaptureRegionsV1(value) {
  exact(value, ["schemaVersion", "conversation", "credentialInventory", "traversal"], "capture regions");
  if (value.schemaVersion !== 1 || value.traversal?.complete !== true || !Number.isSafeInteger(value.traversal.scannedNodes) || !Number.isSafeInteger(value.traversal.maximumNodes) || value.traversal.scannedNodes < 0 || value.traversal.scannedNodes > value.traversal.maximumNodes) fail("capture-region traversal is incomplete");
  if (value.credentialInventory?.complete !== true || !Array.isArray(value.credentialInventory.regions) || value.credentialInventory.count !== value.credentialInventory.regions.length) fail("credential-region inventory is incomplete");
  const regions = [value.conversation, ...value.credentialInventory.regions];
  for (const region of regions) {
    exact(region, ["kind", "x", "y", "width", "height"], "capture region");
    if (!["conversation", "credential"].includes(region.kind) || ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) fail("capture region geometry is invalid");
  }
  if (value.conversation.kind !== "conversation") fail("conversation capture region is missing");
  return structuredClone(regions);
}
