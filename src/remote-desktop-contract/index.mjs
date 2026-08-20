import { REMOTE_DESKTOP_SCHEMAS_V1, REMOTE_DESKTOP_SCHEMA_VERSION } from "./schemas.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAC_ADDRESS = /^02(?::[0-9A-F]{2}){5}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const PRODUCTION_PROXMOX_LANE_V1 = Object.freeze({
  gatewayId: "9023",
  hostId: "prox2",
  networkId: "nelosbld",
  providerId: "proxmox-lab",
});

export { REMOTE_DESKTOP_SCHEMAS_V1, REMOTE_DESKTOP_SCHEMA_VERSION };

export const REMOTE_DESKTOP_ACTION_TYPES_V1 = Object.freeze([
  "click", "keypress", "scroll", "select_menu", "type_text_ref", "wait_for",
]);
export const REMOTE_DESKTOP_CHECKPOINT_TYPES_V1 = Object.freeze([
  "accessibility_tree", "screenshot", "window_state",
]);
export const REMOTE_DESKTOP_ASSERTION_TYPES_V1 = Object.freeze([
  "element_absent", "element_present", "task_state", "text_ref_present", "window_count",
]);
export const REMOTE_DESKTOP_FAILURE_CAPTURE_TRIGGERS_V1 = Object.freeze([
  "action_error", "assertion_failure", "deadline_exceeded", "desktop_crash", "task_stalled",
]);
export const REMOTE_DESKTOP_RUN_STATES_V1 = Object.freeze([
  "draft", "admitted", "running", "capturing_failure", "cleaning", "succeeded", "failed", "quarantined",
]);
export const REMOTE_DESKTOP_TERMINAL_STATES_V1 = Object.freeze(["succeeded", "failed", "quarantined"]);
export const REMOTE_DESKTOP_EVIDENCE_CLASSES_V1 = Object.freeze([
  "scenario_metadata", "non_secret_identity", "sanitized_screenshot", "sanitized_recording",
  "bounded_diagnostic", "action_timeline", "assertion_outcome", "cleanup_attestation",
]);
export const REMOTE_DESKTOP_FORBIDDEN_EVIDENCE_CLASSES_V1 = Object.freeze([
  "prompt", "model_response", "token", "cookie", "session_database", "environment_dump", "credential",
]);

const TRANSITIONS = Object.freeze({
  draft: ["admitted"],
  admitted: ["running", "cleaning"],
  running: ["capturing_failure", "cleaning"],
  capturing_failure: ["cleaning"],
  cleaning: ["succeeded", "failed", "quarantined"],
  succeeded: [],
  failed: [],
  quarantined: [],
});

export class RemoteDesktopContractError extends Error {
  constructor(code, message, path = "") {
    super(message);
    this.name = "RemoteDesktopContractError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "") {
  throw new RemoteDesktopContractError(code, message, path);
}

function closed(value, fields, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CONTRACT", "expected a plain object", path);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("INVALID_CONTRACT", "object fields do not match the closed contract", path);
  }
  return value;
}

function array(value, path, { min = 0, max = 10_000 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail("INVALID_CONTRACT", "array length is outside the contract", path);
  }
  return value;
}

function identity(value, path) {
  if (typeof value !== "string" || !ID.test(value)) fail("INVALID_IDENTITY", "invalid identity", path);
  return value;
}

function macAddress(value, path) {
  if (typeof value !== "string" || !MAC_ADDRESS.test(value)) fail("INVALID_IDENTITY", "invalid locally administered MAC address", path);
  return value;
}

function digest(value, path) {
  if (typeof value !== "string" || !SHA256.test(value)) fail("INVALID_IDENTITY", "invalid immutable digest", path);
  return value;
}

function positiveInteger(value, path, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) fail("INVALID_BUDGET", "limit must be a bounded integer", path);
  return value;
}

function positiveNumber(value, path, { zero = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < (zero ? 0 : Number.MIN_VALUE)) {
    fail("INVALID_BUDGET", "limit must be a bounded number", path);
  }
  return value;
}

function timestamp(value, path) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("INVALID_CONTRACT", "timestamp must be UTC ISO-8601", path);
  }
  return value;
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) fail("INVALID_CONTRACT", "value is not allowlisted", path);
  return value;
}

function sameIdentity(actual, expected, path, code = "IDENTITY_MISMATCH") {
  if (actual !== expected) fail(code, "identity does not match the admitted run", path);
}

function validateProductionProxmoxLane(provider, path = "/provider") {
  const selected = Object.entries(PRODUCTION_PROXMOX_LANE_V1)
    .some(([field, expected]) => provider[field] === expected);
  const mismatch = selected && Object.entries(PRODUCTION_PROXMOX_LANE_V1).find(([field, expected]) => provider[field] !== expected);
  if (mismatch) {
    fail("INVALID_PROVIDER_IDENTITY", "the production prox2 lane requires its fixed provider, host, gateway VM, and nelosbld VNet identity", `${path}/${mismatch[0]}`);
  }
}

function validatePolicy(policy, path = "/policy") {
  closed(policy, [
    "maxTaskCount", "maxModelTurnCount", "maxSpendUsd", "reservedSpendUsd", "maxWallTimeMs",
    "screenshots", "recording", "diagnostics",
  ], path);
  positiveInteger(policy.maxTaskCount, `${path}/maxTaskCount`);
  positiveInteger(policy.maxModelTurnCount, `${path}/maxModelTurnCount`);
  positiveNumber(policy.maxSpendUsd, `${path}/maxSpendUsd`);
  positiveNumber(policy.reservedSpendUsd, `${path}/reservedSpendUsd`);
  if (policy.reservedSpendUsd < policy.maxSpendUsd) {
    fail("SPEND_NOT_RESERVED", "reserved spend must pessimistically cover the admitted spend ceiling", `${path}/reservedSpendUsd`);
  }
  positiveInteger(policy.maxWallTimeMs, `${path}/maxWallTimeMs`);
  closed(policy.screenshots, ["maxCount", "maxBytes"], `${path}/screenshots`);
  positiveInteger(policy.screenshots.maxCount, `${path}/screenshots/maxCount`);
  positiveInteger(policy.screenshots.maxBytes, `${path}/screenshots/maxBytes`);
  closed(policy.recording, ["enabled", "maxDurationMs", "maxBytes"], `${path}/recording`);
  if (typeof policy.recording.enabled !== "boolean") fail("INVALID_BUDGET", "recording enabled must be boolean", `${path}/recording/enabled`);
  positiveInteger(policy.recording.maxDurationMs, `${path}/recording/maxDurationMs`, { zero: !policy.recording.enabled });
  positiveInteger(policy.recording.maxBytes, `${path}/recording/maxBytes`, { zero: !policy.recording.enabled });
  if (!policy.recording.enabled && (policy.recording.maxDurationMs !== 0 || policy.recording.maxBytes !== 0)) {
    fail("INVALID_BUDGET", "disabled recording must reserve zero duration and bytes", `${path}/recording`);
  }
  if (policy.recording.enabled && (policy.recording.maxDurationMs === 0 || policy.recording.maxBytes === 0)) {
    fail("INVALID_BUDGET", "enabled recording requires explicit positive duration and byte limits", `${path}/recording`);
  }
  closed(policy.diagnostics, ["maxCount", "maxBytes"], `${path}/diagnostics`);
  positiveInteger(policy.diagnostics.maxCount, `${path}/diagnostics/maxCount`);
  positiveInteger(policy.diagnostics.maxBytes, `${path}/diagnostics/maxBytes`);
  return policy;
}

function validateAction(action, path) {
  closed(action, ["actionId", "type", "targetRef", "valueRef", "timeoutMs"], path);
  identity(action.actionId, `${path}/actionId`);
  enumValue(action.type, REMOTE_DESKTOP_ACTION_TYPES_V1, `${path}/type`);
  identity(action.targetRef, `${path}/targetRef`);
  if (action.valueRef !== null) identity(action.valueRef, `${path}/valueRef`);
  if (action.type === "type_text_ref" && action.valueRef === null) fail("INVALID_SCENARIO", "type_text_ref requires an opaque value reference", `${path}/valueRef`);
  if (action.type !== "type_text_ref" && action.valueRef !== null) fail("INVALID_SCENARIO", "only type_text_ref accepts a value reference", `${path}/valueRef`);
  positiveInteger(action.timeoutMs, `${path}/timeoutMs`);
}

function validateCheckpoint(checkpoint, path) {
  closed(checkpoint, ["checkpointId", "type", "afterActionId", "failureOnly"], path);
  identity(checkpoint.checkpointId, `${path}/checkpointId`);
  enumValue(checkpoint.type, REMOTE_DESKTOP_CHECKPOINT_TYPES_V1, `${path}/type`);
  identity(checkpoint.afterActionId, `${path}/afterActionId`);
  if (typeof checkpoint.failureOnly !== "boolean") fail("INVALID_SCENARIO", "failureOnly must be boolean", `${path}/failureOnly`);
}

function validateAssertion(assertion, path) {
  closed(assertion, ["assertionId", "type", "targetRef", "expectedRef", "checkpointId"], path);
  identity(assertion.assertionId, `${path}/assertionId`);
  enumValue(assertion.type, REMOTE_DESKTOP_ASSERTION_TYPES_V1, `${path}/type`);
  identity(assertion.targetRef, `${path}/targetRef`);
  if (assertion.expectedRef !== null) identity(assertion.expectedRef, `${path}/expectedRef`);
  identity(assertion.checkpointId, `${path}/checkpointId`);
}

export function validateRemoteDesktopScenarioV1(scenario) {
  const path = "/scenario";
  closed(scenario, ["schemaVersion", "scenarioId", "task", "actions", "checkpoints", "assertions", "deadlineMs", "failureCaptureTriggers"], path);
  if (scenario.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA", "unsupported scenario schema version", `${path}/schemaVersion`);
  identity(scenario.scenarioId, `${path}/scenarioId`);
  closed(scenario.task, ["taskId", "createdForScenario", "fresh"], `${path}/task`);
  identity(scenario.task.taskId, `${path}/task/taskId`);
  sameIdentity(scenario.task.createdForScenario, scenario.scenarioId, `${path}/task/createdForScenario`, "REUSED_TASK_IDENTITY");
  if (scenario.task.fresh !== true) fail("REUSED_TASK_IDENTITY", "every scenario requires a freshly created Desktop task", `${path}/task/fresh`);
  array(scenario.actions, `${path}/actions`, { min: 1, max: 500 }).forEach((item, index) => validateAction(item, `${path}/actions/${index}`));
  array(scenario.checkpoints, `${path}/checkpoints`, { min: 1, max: 500 }).forEach((item, index) => validateCheckpoint(item, `${path}/checkpoints/${index}`));
  array(scenario.assertions, `${path}/assertions`, { min: 1, max: 500 }).forEach((item, index) => validateAssertion(item, `${path}/assertions/${index}`));
  positiveInteger(scenario.deadlineMs, `${path}/deadlineMs`);
  array(scenario.failureCaptureTriggers, `${path}/failureCaptureTriggers`, { min: 1, max: REMOTE_DESKTOP_FAILURE_CAPTURE_TRIGGERS_V1.length });
  for (const [index, trigger] of scenario.failureCaptureTriggers.entries()) enumValue(trigger, REMOTE_DESKTOP_FAILURE_CAPTURE_TRIGGERS_V1, `${path}/failureCaptureTriggers/${index}`);
  if (new Set(scenario.failureCaptureTriggers).size !== scenario.failureCaptureTriggers.length) fail("INVALID_SCENARIO", "failure triggers must be unique", `${path}/failureCaptureTriggers`);
  const actionIds = new Set(scenario.actions.map(({ actionId }) => actionId));
  const checkpointIds = new Set(scenario.checkpoints.map(({ checkpointId }) => checkpointId));
  if (actionIds.size !== scenario.actions.length || checkpointIds.size !== scenario.checkpoints.length) fail("INVALID_SCENARIO", "action and checkpoint identities must be unique", path);
  for (const checkpoint of scenario.checkpoints) if (!actionIds.has(checkpoint.afterActionId)) fail("INVALID_SCENARIO", "checkpoint refers to an unknown action", `${path}/checkpoints`);
  for (const assertion of scenario.assertions) if (!checkpointIds.has(assertion.checkpointId)) fail("INVALID_SCENARIO", "assertion refers to an unknown checkpoint", `${path}/assertions`);
  return scenario;
}

function validateBindings(run) {
  closed(run.candidate, ["digest", "immutable"], "/candidate");
  digest(run.candidate.digest, "/candidate/digest");
  if (run.candidate.immutable !== true) fail("MUTABLE_CANDIDATE", "candidate identity must be an immutable digest", "/candidate/immutable");
  closed(run.desktopBundle, ["bundleId", "version", "digest"], "/desktopBundle");
  identity(run.desktopBundle.bundleId, "/desktopBundle/bundleId");
  identity(run.desktopBundle.version, "/desktopBundle/version");
  digest(run.desktopBundle.digest, "/desktopBundle/digest");
  closed(run.goldenImage, ["imageId", "digest"], "/goldenImage");
  identity(run.goldenImage.imageId, "/goldenImage/imageId");
  digest(run.goldenImage.digest, "/goldenImage/digest");
  closed(run.provider, ["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest"], "/provider");
  for (const field of ["providerId", "hostId", "vmId", "networkId", "gatewayId"]) identity(run.provider[field], `/provider/${field}`);
  macAddress(run.provider.macAddress, "/provider/macAddress");
  digest(run.provider.networkPolicyDigest, "/provider/networkPolicyDigest");
  if (!/^[1-9][0-9]{2,8}$/u.test(run.provider.gatewayId) || run.provider.gatewayId === run.provider.vmId) {
    fail("INVALID_PROVIDER_IDENTITY", "gateway must be a distinct exact provider VM identity", "/provider/gatewayId");
  }
  validateProductionProxmoxLane(run.provider);
  closed(run.lease, ["leaseId", "holderId", "expiresAt", "fencingToken", "state"], "/lease");
  for (const field of ["leaseId", "holderId", "fencingToken"]) identity(run.lease[field], `/lease/${field}`);
  timestamp(run.lease.expiresAt, "/lease/expiresAt");
  if (run.lease.state !== "active") fail("STALE_FENCING_TOKEN", "lease must be current and active", "/lease/state");
  for (const [name, value] of [["benchmarkProfile", run.benchmarkProfile], ["scenarioManifest", run.scenarioManifest]]) {
    const idField = name === "benchmarkProfile" ? "profileId" : "manifestId";
    closed(value, [idField, "digest"], `/${name}`);
    identity(value[idField], `/${name}/${idField}`);
    digest(value.digest, `/${name}/digest`);
  }
}

export function validateRemoteDesktopRunV1(run) {
  closed(run, ["schemaVersion", "runId", "candidate", "desktopBundle", "goldenImage", "provider", "lease", "benchmarkProfile", "scenarioManifest", "policy", "scenarios", "state"], "");
  if (run.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA", "unsupported run schema version", "/schemaVersion");
  identity(run.runId, "/runId");
  validateBindings(run);
  validatePolicy(run.policy);
  array(run.scenarios, "/scenarios", { min: 1, max: run.policy.maxTaskCount });
  const scenarioIds = new Set();
  const taskIds = new Set();
  for (const scenario of run.scenarios) {
    validateRemoteDesktopScenarioV1(scenario);
    if (scenarioIds.has(scenario.scenarioId)) fail("INVALID_SCENARIO", "scenario identity must be unique", "/scenarios");
    if (taskIds.has(scenario.task.taskId)) fail("REUSED_TASK_IDENTITY", "Desktop task identity is reused across scenarios", "/scenarios");
    scenarioIds.add(scenario.scenarioId);
    taskIds.add(scenario.task.taskId);
    if (scenario.deadlineMs > run.policy.maxWallTimeMs) fail("INVALID_BUDGET", "scenario deadline exceeds the run wall-time ceiling", "/scenarios");
  }
  if (run.policy.maxTaskCount < run.scenarios.length) fail("BUDGET_EXHAUSTED", "task budget cannot cover all scenarios", "/policy/maxTaskCount");
  enumValue(run.state, REMOTE_DESKTOP_RUN_STATES_V1, "/state");
  return run;
}

export function admitRemoteDesktopRun(run, { candidateDigest, currentLease, now = Date.now(), usage } = {}) {
  validateRemoteDesktopRunV1(run);
  if (!SHA256.test(candidateDigest ?? "") || run.candidate.digest !== candidateDigest) fail("MUTABLE_CANDIDATE", "run is not bound to the immutable candidate selected for admission", "/candidate/digest");
  if (currentLease === null || typeof currentLease !== "object") fail("STALE_FENCING_TOKEN", "current lease proof is required", "/lease");
  closed(currentLease, ["leaseId", "holderId", "expiresAt", "fencingToken", "state", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest"], "/currentLease");
  for (const field of ["leaseId", "holderId", "fencingToken", "state", "expiresAt"]) sameIdentity(run.lease[field], currentLease[field], `/lease/${field}`, "STALE_FENCING_TOKEN");
  for (const field of ["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest"]) sameIdentity(run.provider[field], currentLease[field], `/provider/${field}`, "STALE_FENCING_TOKEN");
  if (Date.parse(run.lease.expiresAt) <= now) fail("STALE_FENCING_TOKEN", "lease is expired", "/lease/expiresAt");
  if (run.state !== "draft") fail("INVALID_TRANSITION", "only draft runs may be admitted", "/state");
  validateRemoteDesktopUsage(usage ?? emptyRemoteDesktopUsage(), run.policy);
  return Object.freeze({ ...run, state: "admitted" });
}

export function emptyRemoteDesktopUsage() {
  return {
    taskCount: 0, modelTurnCount: 0, spendUsd: 0, wallTimeMs: 0,
    screenshotCount: 0, screenshotBytes: 0, recordingDurationMs: 0,
    recordingBytes: 0, diagnosticLogCount: 0, diagnosticLogBytes: 0,
  };
}

export function validateRemoteDesktopUsage(usage, policy) {
  closed(usage, ["taskCount", "modelTurnCount", "spendUsd", "wallTimeMs", "screenshotCount", "screenshotBytes", "recordingDurationMs", "recordingBytes", "diagnosticLogCount", "diagnosticLogBytes"], "/usage");
  const limits = {
    taskCount: policy.maxTaskCount,
    modelTurnCount: policy.maxModelTurnCount,
    spendUsd: policy.maxSpendUsd,
    wallTimeMs: policy.maxWallTimeMs,
    screenshotCount: policy.screenshots.maxCount,
    screenshotBytes: policy.screenshots.maxBytes,
    recordingDurationMs: policy.recording.maxDurationMs,
    recordingBytes: policy.recording.maxBytes,
    diagnosticLogCount: policy.diagnostics.maxCount,
    diagnosticLogBytes: policy.diagnostics.maxBytes,
  };
  for (const [field, limit] of Object.entries(limits)) {
    positiveNumber(usage[field], `/usage/${field}`, { zero: true });
    if (field !== "spendUsd" && !Number.isSafeInteger(usage[field])) fail("INVALID_BUDGET", "count and byte usage must be safe integers", `/usage/${field}`);
    if (usage[field] > limit || (limit > 0 && usage[field] === limit)) fail("BUDGET_EXHAUSTED", "budget is exhausted or exceeded", `/usage/${field}`);
  }
  return usage;
}

export function transitionRemoteDesktopRun(run, nextState, { terminalOutcome = null } = {}) {
  validateRemoteDesktopRunV1(run);
  enumValue(nextState, REMOTE_DESKTOP_RUN_STATES_V1, "/state");
  if (!TRANSITIONS[run.state].includes(nextState)) fail("INVALID_TRANSITION", "run state transition is not allowed", "/state");
  if (REMOTE_DESKTOP_TERMINAL_STATES_V1.includes(nextState)) {
    if (terminalOutcome === null) fail("TERMINAL_ATTESTATION_REQUIRED", "terminal transition requires an exact cleanup attestation", "/terminalOutcome");
    validateRemoteDesktopTerminalOutcomeV1(terminalOutcome, run);
    if (nextState === "succeeded" && terminalOutcome.outcome !== "destroyed") fail("AMBIGUOUS_MUTATION_RECEIPT", "success requires attested destruction of the exact owned VM", "/terminalOutcome/outcome");
    if (nextState === "quarantined" && terminalOutcome.outcome !== "quarantined") fail("TERMINAL_IDENTITY_MISMATCH", "quarantined state requires the exact quarantine receipt", "/terminalOutcome/outcome");
  } else if (terminalOutcome !== null) {
    fail("INVALID_TRANSITION", "nonterminal transitions do not accept cleanup attestations", "/terminalOutcome");
  }
  return Object.freeze({ ...run, state: nextState });
}

function validateExportIdentities(identities, run) {
  closed(identities, ["candidateDigest", "desktopBundleDigest", "goldenImageDigest", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "benchmarkProfileDigest", "scenarioManifestDigest"], "/identities");
  const expected = {
    candidateDigest: run.candidate.digest,
    desktopBundleDigest: run.desktopBundle.digest,
    goldenImageDigest: run.goldenImage.digest,
    providerId: run.provider.providerId,
    hostId: run.provider.hostId,
    vmId: run.provider.vmId,
    macAddress: run.provider.macAddress,
    networkId: run.provider.networkId,
    gatewayId: run.provider.gatewayId,
    networkPolicyDigest: run.provider.networkPolicyDigest,
    leaseId: run.lease.leaseId,
    fencingToken: run.lease.fencingToken,
    benchmarkProfileDigest: run.benchmarkProfile.digest,
    scenarioManifestDigest: run.scenarioManifest.digest,
  };
  for (const [field, expectedValue] of Object.entries(expected)) sameIdentity(identities[field], expectedValue, `/identities/${field}`);
}

export function validateRemoteDesktopEvidenceExportV1(value, run) {
  validateRemoteDesktopRunV1(run);
  closed(value, ["schemaVersion", "runId", "scenarioMetadata", "identities", "visualArtifacts", "diagnostics", "actionTimeline", "assertionOutcomes", "cleanupAttestation"], "");
  if (value.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA", "unsupported export schema version", "/schemaVersion");
  sameIdentity(value.runId, run.runId, "/runId");
  validateExportIdentities(value.identities, run);
  const scenariosById = new Map(run.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  array(value.scenarioMetadata, "/scenarioMetadata", { max: run.policy.maxTaskCount }).forEach((item, index) => {
    const path = `/scenarioMetadata/${index}`;
    closed(item, ["evidenceClass", "scenarioId", "taskId", "startedAt", "finishedAt", "outcome"], path);
    if (item.evidenceClass !== "scenario_metadata") fail("PROHIBITED_EVIDENCE_CLASS", "evidence class is not allowed in scenario metadata", `${path}/evidenceClass`);
    identity(item.scenarioId, `${path}/scenarioId`); identity(item.taskId, `${path}/taskId`); timestamp(item.startedAt, `${path}/startedAt`); timestamp(item.finishedAt, `${path}/finishedAt`);
    if (scenariosById.get(item.scenarioId)?.task.taskId !== item.taskId) fail("IDENTITY_MISMATCH", "scenario metadata is not bound to its fresh task", `${path}/taskId`);
    enumValue(item.outcome, ["passed", "failed", "timed_out"], `${path}/outcome`);
  });
  array(value.visualArtifacts, "/visualArtifacts", { max: run.policy.screenshots.maxCount + (run.policy.recording.enabled ? 1 : 0) }).forEach((item, index) => {
    const path = `/visualArtifacts/${index}`;
    closed(item, ["evidenceClass", "artifactId", "scenarioId", "digest", "mediaType", "byteLength", "durationMs", "sanitized"], path);
    enumValue(item.evidenceClass, ["sanitized_screenshot", "sanitized_recording"], `${path}/evidenceClass`);
    identity(item.artifactId, `${path}/artifactId`); identity(item.scenarioId, `${path}/scenarioId`); digest(item.digest, `${path}/digest`);
    enumValue(item.mediaType, item.evidenceClass === "sanitized_screenshot" ? ["image/png", "image/jpeg"] : ["video/mp4"], `${path}/mediaType`);
    positiveInteger(item.byteLength, `${path}/byteLength`);
    positiveInteger(item.durationMs, `${path}/durationMs`, { zero: item.evidenceClass === "sanitized_screenshot" });
    if (item.sanitized !== true) fail("PROHIBITED_EVIDENCE_CLASS", "visual artifacts must be sanitized", `${path}/sanitized`);
  });
  array(value.diagnostics, "/diagnostics", { max: run.policy.diagnostics.maxCount }).forEach((item, index) => {
    const path = `/diagnostics/${index}`;
    closed(item, ["evidenceClass", "diagnosticId", "scenarioId", "code", "occurredAt", "artifactDigest", "byteLength", "sanitized"], path);
    if (item.evidenceClass !== "bounded_diagnostic") fail("PROHIBITED_EVIDENCE_CLASS", "diagnostic evidence class is prohibited", `${path}/evidenceClass`);
    identity(item.diagnosticId, `${path}/diagnosticId`); identity(item.scenarioId, `${path}/scenarioId`); identity(item.code, `${path}/code`); timestamp(item.occurredAt, `${path}/occurredAt`); digest(item.artifactDigest, `${path}/artifactDigest`); positiveInteger(item.byteLength, `${path}/byteLength`);
    if (item.sanitized !== true) fail("PROHIBITED_EVIDENCE_CLASS", "diagnostics must be sanitized", `${path}/sanitized`);
  });
  array(value.actionTimeline, "/actionTimeline", { max: 10_000 }).forEach((item, index) => {
    const path = `/actionTimeline/${index}`;
    closed(item, ["evidenceClass", "scenarioId", "actionId", "actionType", "startedAt", "finishedAt", "outcome"], path);
    if (item.evidenceClass !== "action_timeline") fail("PROHIBITED_EVIDENCE_CLASS", "timeline evidence class is prohibited", `${path}/evidenceClass`);
    identity(item.scenarioId, `${path}/scenarioId`); identity(item.actionId, `${path}/actionId`); enumValue(item.actionType, REMOTE_DESKTOP_ACTION_TYPES_V1, `${path}/actionType`); timestamp(item.startedAt, `${path}/startedAt`); timestamp(item.finishedAt, `${path}/finishedAt`); enumValue(item.outcome, ["succeeded", "failed", "timed_out"], `${path}/outcome`);
  });
  array(value.assertionOutcomes, "/assertionOutcomes", { max: 10_000 }).forEach((item, index) => {
    const path = `/assertionOutcomes/${index}`;
    closed(item, ["evidenceClass", "scenarioId", "assertionId", "passed", "observedRef"], path);
    if (item.evidenceClass !== "assertion_outcome") fail("PROHIBITED_EVIDENCE_CLASS", "assertion evidence class is prohibited", `${path}/evidenceClass`);
    identity(item.scenarioId, `${path}/scenarioId`); identity(item.assertionId, `${path}/assertionId`); if (typeof item.passed !== "boolean") fail("INVALID_CONTRACT", "passed must be boolean", `${path}/passed`); if (item.observedRef !== null) identity(item.observedRef, `${path}/observedRef`);
  });
  closed(value.cleanupAttestation, ["evidenceClass", "runId", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "terminalOutcomeDigest"], "/cleanupAttestation");
  if (value.cleanupAttestation.evidenceClass !== "cleanup_attestation") fail("PROHIBITED_EVIDENCE_CLASS", "cleanup attestation evidence class is prohibited", "/cleanupAttestation/evidenceClass");
  const cleanupExpected = { runId: run.runId, ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken };
  for (const [field, expected] of Object.entries(cleanupExpected)) sameIdentity(value.cleanupAttestation[field], expected, `/cleanupAttestation/${field}`);
  digest(value.cleanupAttestation.terminalOutcomeDigest, "/cleanupAttestation/terminalOutcomeDigest");
  const screenshotBytes = value.visualArtifacts.filter(({ evidenceClass }) => evidenceClass === "sanitized_screenshot").reduce((sum, item) => sum + item.byteLength, 0);
  const screenshotCount = value.visualArtifacts.filter(({ evidenceClass }) => evidenceClass === "sanitized_screenshot").length;
  const recordingCount = value.visualArtifacts.filter(({ evidenceClass }) => evidenceClass === "sanitized_recording").length;
  const recordingBytes = value.visualArtifacts.filter(({ evidenceClass }) => evidenceClass === "sanitized_recording").reduce((sum, item) => sum + item.byteLength, 0);
  const recordingDuration = value.visualArtifacts.filter(({ evidenceClass }) => evidenceClass === "sanitized_recording").reduce((sum, item) => sum + item.durationMs, 0);
  const diagnosticBytes = value.diagnostics.reduce((sum, item) => sum + item.byteLength, 0);
  if (screenshotCount > run.policy.screenshots.maxCount || recordingCount > (run.policy.recording.enabled ? 1 : 0) || screenshotBytes > run.policy.screenshots.maxBytes || recordingBytes > run.policy.recording.maxBytes || recordingDuration > run.policy.recording.maxDurationMs || diagnosticBytes > run.policy.diagnostics.maxBytes) fail("BUDGET_EXHAUSTED", "exported evidence exceeds an admitted count, byte, or duration limit", "/visualArtifacts");
  return value;
}

export function validateRemoteDesktopTerminalOutcomeV1(value, run) {
  validateRemoteDesktopRunV1(run);
  closed(value, ["schemaVersion", "runId", "outcome", "ownedVm", "leaseId", "fencingToken", "receipt"], "");
  if (value.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA", "unsupported terminal outcome schema version", "/schemaVersion");
  sameIdentity(value.runId, run.runId, "/runId");
  enumValue(value.outcome, ["destroyed", "quarantined"], "/outcome");
  closed(value.ownedVm, ["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest"], "/ownedVm");
  for (const field of ["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest"]) sameIdentity(value.ownedVm[field], run.provider[field], `/ownedVm/${field}`, "TERMINAL_IDENTITY_MISMATCH");
  sameIdentity(value.leaseId, run.lease.leaseId, "/leaseId", "TERMINAL_IDENTITY_MISMATCH");
  sameIdentity(value.fencingToken, run.lease.fencingToken, "/fencingToken", "TERMINAL_IDENTITY_MISMATCH");
  const validateCredentialDisposition = (disposition, method) => {
    closed(disposition, [
      "attestationDigest", "codexHome", "filesystemType", "method", "powerState", "reusableCredentialsAbsent",
      "schemaVersion", "secretBytesIncluded", "swapPolicy", "type",
    ], "/receipt/credentialDisposition");
    if (disposition.schemaVersion !== 1 || disposition.type !== "nelos.credential-terminal-disposition.v1" || disposition.method !== method ||
        disposition.codexHome !== "/home/nelosauto/.codex" || disposition.filesystemType !== "tmpfs" ||
        disposition.swapPolicy !== "disabled-and-attested-before-auth" || disposition.powerState !== "stopped" ||
        disposition.reusableCredentialsAbsent !== true || disposition.secretBytesIncluded !== false) {
      fail("AMBIGUOUS_MUTATION_RECEIPT", "terminal receipt does not prove reusable credential loss", "/receipt/credentialDisposition");
    }
    digest(disposition.attestationDigest, "/receipt/credentialDisposition/attestationDigest");
  };
  if (value.outcome === "destroyed") {
    closed(value.receipt, ["receiptId", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "mutationStatus", "credentialDisposition", "destroyed", "macAbsent", "networkInventoryComplete", "attestationDigest"], "/receipt");
    if (value.receipt.destroyed !== true || value.receipt.macAbsent !== true || value.receipt.networkInventoryComplete !== true || value.receipt.mutationStatus !== "committed") fail("AMBIGUOUS_MUTATION_RECEIPT", "destruction must attest exact VM and MAC absence from a complete network inventory", "/receipt");
    validateCredentialDisposition(value.receipt.credentialDisposition, "powered-off-before-destroy");
  } else {
    closed(value.receipt, ["receiptId", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "mutationStatus", "credentialDisposition", "quarantined", "attestationDigest", "reconciliation"], "/receipt");
    if (value.receipt.quarantined !== true || value.receipt.mutationStatus !== "committed") fail("AMBIGUOUS_MUTATION_RECEIPT", "quarantine must be an attested committed mutation", "/receipt");
    validateCredentialDisposition(value.receipt.credentialDisposition, "powered-off-quarantine");
    closed(value.receipt.reconciliation, ["operationId", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken"], "/receipt/reconciliation");
    identity(value.receipt.reconciliation.operationId, "/receipt/reconciliation/operationId");
    const reconciliationExpected = { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken };
    for (const [field, expected] of Object.entries(reconciliationExpected)) sameIdentity(value.receipt.reconciliation[field], expected, `/receipt/reconciliation/${field}`, "TERMINAL_IDENTITY_MISMATCH");
  }
  identity(value.receipt.receiptId, "/receipt/receiptId");
  digest(value.receipt.attestationDigest, "/receipt/attestationDigest");
  const receiptExpected = { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken };
  for (const [field, expected] of Object.entries(receiptExpected)) sameIdentity(value.receipt[field], expected, `/receipt/${field}`, "TERMINAL_IDENTITY_MISMATCH");
  return value;
}
