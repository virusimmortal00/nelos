import { appendJsonPointer, canonicalize, parseCanonicalJsonV1 } from "./canonical-json.mjs";
import { contractFailure } from "./errors.mjs";
import { canonicalDigest, sha256Bytes } from "./identity.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { reviseRecord, sealRecord, verifyRevision } from "./revision.mjs";
import { isSemanticVersion } from "./semantic-version.mjs";
import {
  assertArray,
  assertClosedObject,
  assertDigest,
  assertEnum,
  assertInteger,
  assertRequired,
  assertString,
  assertUniqueIdentities,
  createVersionDispatcher,
} from "./validation.mjs";

export const TASK_SCHEMA_VERSION = 1;
export const TASK_LIFECYCLE_STATES_V1 = Object.freeze([
  "draft", "reviewed", "sealed", "retired", "invalidated",
]);

const TASK_FIELDS = [
  "schemaVersion", "taskId", "specRevision", "previousDigest", "digest",
  "state", "prompt", "fixture", "baseline", "inputs", "determinism",
  "permissions", "tools", "network", "environment", "limits", "outputs",
  "artifacts", "grader", "visibility", "partialCredit",
];
const REQUIRED_TASK_FIELDS = TASK_FIELDS;
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const TASK_ID = /^task:[0-9a-f]{64}$/u;
const UTC_SECOND = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const SECRET_NAME = /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL|AUTH)/u;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|xox[baprs])[_-][-A-Za-z0-9_]{12,}\b)/u;
const OPAQUE_SECRET_VALUE = /^(?:[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9_-]{40,})$/u;
const IMMUTABLE_REFERENCE_VALUE = /^(?:[0-9a-f]{40,128}|(?:artifact|build|commit|digest|revision|sha256)[._:-][A-Za-z0-9._:-]{1,255})$/u;

function options(path) {
  return { path, contractKind: "Task", schemaVersion: 1 };
}

function closed(value, fields, required, path) {
  assertClosedObject(value, fields, options(path));
  assertRequired(value, required, options(path));
}

function string(value, path, extra = {}) {
  return assertString(value, { minLength: 1, maxLength: 4096, ...extra, ...options(path) });
}

function nullableDigest(value, path) {
  if (value !== null) assertDigest(value, options(path));
}

function semanticVersion(value, path) {
  string(value, path, { maxLength: 64 });
  if (!isSemanticVersion(value)) {
    contractFailure("INVALID_FORMAT", "value must be a semantic version", options(path));
  }
}

function utcSecond(value, path) {
  string(value, path, { maxLength: 20, pattern: UTC_SECOND });
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== `${value.slice(0, -1)}.000Z`
  ) {
    contractFailure("INVALID_FORMAT", "value must be a real UTC instant", options(path));
  }
}

function validatePrompt(value) {
  closed(value, ["kind", "encoding", "text", "digest"], ["kind", "encoding", "text", "digest"], "/prompt");
  assertEnum(value.kind, ["prompt", "objective"], options("/prompt/kind"));
  assertEnum(value.encoding, ["utf-8"], options("/prompt/encoding"));
  assertString(value.text, { minLength: 1, maxLength: 262144, ...options("/prompt/text") });
  assertDigest(value.digest, options("/prompt/digest"));
  if (value.digest !== sha256Bytes(Buffer.from(value.text, "utf8"))) {
    contractFailure("INVALID_DIGEST", "prompt digest does not bind the exact UTF-8 bytes", options("/prompt/digest"));
  }
}

function validateFixture(value, path, baseline = false) {
  const fields = baseline ? ["format", "digest"] : ["format", "version", "digest"];
  closed(value, fields, fields, path);
  assertEnum(value.format, ["directory-tar", "json", "jsonl", "text", "binary"], options(`${path}/format`));
  if (!baseline) semanticVersion(value.version, `${path}/version`);
  assertDigest(value.digest, options(`${path}/digest`));
}

function validateInputs(values) {
  assertArray(values, { minItems: 0, maxItems: 256, ...options("/inputs") });
  assertUniqueIdentities(values, ({ id }) => id, options("/inputs"));
  values.forEach((value, index) => {
    const path = `/inputs/${index}`;
    closed(value, ["id", "kind", "digest", "canonicalization", "required"], ["id", "kind", "digest", "canonicalization", "required"], path);
    string(value.id, `${path}/id`, { maxLength: 64, pattern: ID });
    assertEnum(value.kind, ["file", "json", "text", "binary"], options(`${path}/kind`));
    assertDigest(value.digest, options(`${path}/digest`));
    assertEnum(value.canonicalization, ["raw-bytes", "canonical-json-v1", "utf8-nfc"], options(`${path}/canonicalization`));
    if (typeof value.required !== "boolean") contractFailure("INVALID_TYPE", "value must be a boolean", options(`${path}/required`));
  });
}

function validateDeterminism(value) {
  const fields = ["seed", "clock", "timezone", "locale"];
  closed(value, fields, fields, "/determinism");
  assertInteger(value.seed, { minimum: 0, maximum: 0xffffffff, ...options("/determinism/seed") });
  utcSecond(value.clock, "/determinism/clock");
  assertEnum(value.timezone, ["UTC"], options("/determinism/timezone"));
  string(value.locale, "/determinism/locale", { maxLength: 32, pattern: /^[a-z]{2,3}(?:-[A-Z]{2})?$/u });
}

function validatePermissions(value) {
  const fields = ["filesystem", "subprocess", "systemClock"];
  closed(value, fields, fields, "/permissions");
  assertEnum(value.filesystem, ["none", "read-only", "workspace-write"], options("/permissions/filesystem"));
  for (const field of ["subprocess", "systemClock"]) {
    if (typeof value[field] !== "boolean") contractFailure("INVALID_TYPE", "value must be a boolean", options(`/permissions/${field}`));
  }
}

function validateTools(values) {
  assertArray(values, { minItems: 0, maxItems: 128, ...options("/tools") });
  assertUniqueIdentities(values, ({ id }) => id, options("/tools"));
  values.forEach((value, index) => {
    const path = `/tools/${index}`;
    closed(value, ["id", "version", "digest"], ["id", "version", "digest"], path);
    string(value.id, `${path}/id`, { maxLength: 64, pattern: ID });
    semanticVersion(value.version, `${path}/version`);
    assertDigest(value.digest, options(`${path}/digest`));
  });
}

function validateNetwork(value) {
  closed(value, ["mode", "allowHosts"], ["mode", "allowHosts"], "/network");
  assertEnum(value.mode, ["none", "allowlist"], options("/network/mode"));
  assertArray(value.allowHosts, { minItems: value.mode === "allowlist" ? 1 : 0, maxItems: value.mode === "allowlist" ? 128 : 0, ...options("/network/allowHosts") });
  assertUniqueIdentities(value.allowHosts, (host) => host, options("/network/allowHosts"));
  value.allowHosts.forEach((host, index) => string(host, `/network/allowHosts/${index}`, { maxLength: 253, pattern: HOST }));
}

function validateEnvironment(values) {
  assertArray(values, { minItems: 0, maxItems: 128, ...options("/environment") });
  assertUniqueIdentities(values, ({ name }) => name, options("/environment"));
  values.forEach((value, index) => {
    const path = `/environment/${index}`;
    closed(value, ["name", "value"], ["name", "value"], path);
    string(value.name, `${path}/name`, { maxLength: 64, pattern: ENV_NAME });
    assertString(value.value, { minLength: 0, maxLength: 4096, ...options(`${path}/value`) });
    if (SECRET_NAME.test(value.name)) contractFailure("INVALID_FORMAT", "environment variable name is secret-bearing", options(`${path}/name`));
    if (
      SECRET_VALUE.test(value.value) ||
      (
        OPAQUE_SECRET_VALUE.test(value.value) &&
        !IMMUTABLE_REFERENCE_VALUE.test(value.value)
      )
    ) {
      contractFailure("INVALID_FORMAT", "environment variable value appears secret-bearing", options(`${path}/value`));
    }
  });
}

function validateLimits(value) {
  const bounds = {
    wallClockSeconds: [1, 604800], tokenBudget: [1, 1000000000], toolCalls: [0, 1000000],
    diskBytes: [1, Number.MAX_SAFE_INTEGER], processes: [1, 65536], networkRequests: [0, 1000000],
  };
  const fields = Object.keys(bounds);
  closed(value, fields, fields, "/limits");
  for (const [field, [minimum, maximum]] of Object.entries(bounds)) {
    assertInteger(value[field], { minimum, maximum, ...options(`/limits/${field}`) });
  }
}

function validateOutputs(values) {
  assertArray(values, { minItems: 1, maxItems: 128, ...options("/outputs") });
  assertUniqueIdentities(values, ({ id }) => id, options("/outputs"));
  values.forEach((value, index) => {
    const path = `/outputs/${index}`;
    closed(value, ["id", "kind", "required", "maxBytes", "shapeDigest"], ["id", "kind", "required", "maxBytes", "shapeDigest"], path);
    string(value.id, `${path}/id`, { maxLength: 64, pattern: ID });
    assertEnum(value.kind, ["json", "text", "binary"], options(`${path}/kind`));
    if (typeof value.required !== "boolean") contractFailure("INVALID_TYPE", "value must be a boolean", options(`${path}/required`));
    assertInteger(value.maxBytes, { minimum: 1, maximum: 1073741824, ...options(`${path}/maxBytes`) });
    assertDigest(value.shapeDigest, options(`${path}/shapeDigest`));
  });
}

function validateArtifacts(values) {
  assertArray(values, { minItems: 0, maxItems: 128, ...options("/artifacts") });
  assertUniqueIdentities(values, ({ id }) => id, options("/artifacts"));
  values.forEach((value, index) => {
    const path = `/artifacts/${index}`;
    closed(value, ["id", "mediaType", "required", "maxBytes", "shapeDigest"], ["id", "mediaType", "required", "maxBytes", "shapeDigest"], path);
    string(value.id, `${path}/id`, { maxLength: 64, pattern: ID });
    string(value.mediaType, `${path}/mediaType`, { maxLength: 127, pattern: MEDIA_TYPE });
    if (typeof value.required !== "boolean") contractFailure("INVALID_TYPE", "value must be a boolean", options(`${path}/required`));
    assertInteger(value.maxBytes, { minimum: 1, maximum: 10737418240, ...options(`${path}/maxBytes`) });
    assertDigest(value.shapeDigest, options(`${path}/shapeDigest`));
  });
}

function validateGrader(value) {
  closed(value, ["id", "version", "digest", "rubricDigest", "inputVisibility", "oracle"], ["id", "version", "digest", "rubricDigest", "inputVisibility", "oracle"], "/grader");
  string(value.id, "/grader/id", { maxLength: 64, pattern: ID });
  semanticVersion(value.version, "/grader/version");
  assertDigest(value.digest, options("/grader/digest"));
  assertDigest(value.rubricDigest, options("/grader/rubricDigest"));
  assertEnum(value.inputVisibility, ["hidden", "public"], options("/grader/inputVisibility"));
  closed(value.oracle, ["kind", "version", "digest"], ["kind", "version", "digest"], "/grader/oracle");
  assertEnum(value.oracle.kind, ["exact", "program", "human"], options("/grader/oracle/kind"));
  semanticVersion(value.oracle.version, "/grader/oracle/version");
  assertDigest(value.oracle.digest, options("/grader/oracle/digest"));
}

function validatePartialCredit(value) {
  closed(value, ["mode", "criteria"], ["mode", "criteria"], "/partialCredit");
  assertEnum(value.mode, ["none", "weighted"], options("/partialCredit/mode"));
  assertArray(value.criteria, { minItems: value.mode === "weighted" ? 1 : 0, maxItems: value.mode === "weighted" ? 128 : 0, ...options("/partialCredit/criteria") });
  assertUniqueIdentities(value.criteria, ({ id }) => id, options("/partialCredit/criteria"));
  let total = 0;
  value.criteria.forEach((criterion, index) => {
    const path = `/partialCredit/criteria/${index}`;
    closed(criterion, ["id", "weightBasisPoints"], ["id", "weightBasisPoints"], path);
    string(criterion.id, `${path}/id`, { maxLength: 64, pattern: ID });
    assertInteger(criterion.weightBasisPoints, { minimum: 1, maximum: 10000, ...options(`${path}/weightBasisPoints`) });
    total += criterion.weightBasisPoints;
  });
  if (value.mode === "weighted" && total !== 10000) {
    contractFailure("OUT_OF_BOUNDS", "partial-credit weights must total 10000 basis points", options("/partialCredit/criteria"));
  }
}

function validateTaskV1(value) {
  closed(value, TASK_FIELDS, REQUIRED_TASK_FIELDS, "");
  assertInteger(value.schemaVersion, { minimum: 1, maximum: 1, ...options("/schemaVersion") });
  string(value.taskId, "/taskId", { minLength: 69, maxLength: 69, pattern: TASK_ID });
  assertInteger(value.specRevision, { minimum: 1, maximum: 1000000, ...options("/specRevision") });
  nullableDigest(value.previousDigest, "/previousDigest");
  if (value.specRevision === 1 && value.previousDigest !== null) contractFailure("INVALID_LINEAGE", "initial revision must not have a predecessor", options("/previousDigest"));
  if (value.specRevision > 1 && value.previousDigest === null) contractFailure("INVALID_LINEAGE", "successor revision must reference its predecessor", options("/previousDigest"));
  assertDigest(value.digest, options("/digest"));
  assertEnum(value.state, TASK_LIFECYCLE_STATES_V1, options("/state"));
  validatePrompt(value.prompt);
  validateFixture(value.fixture, "/fixture");
  validateFixture(value.baseline, "/baseline", true);
  validateInputs(value.inputs);
  validateDeterminism(value.determinism);
  validatePermissions(value.permissions);
  validateTools(value.tools);
  validateNetwork(value.network);
  validateEnvironment(value.environment);
  validateLimits(value.limits);
  if ((value.network.mode === "none") !== (value.limits.networkRequests === 0)) {
    contractFailure("INVALID_FORMAT", "network request limit must agree with the network policy", options("/limits/networkRequests"));
  }
  validateOutputs(value.outputs);
  validateArtifacts(value.artifacts);
  validateGrader(value.grader);
  assertEnum(value.visibility, ["private", "team", "public"], options("/visibility"));
  validatePartialCredit(value.partialCredit);
  return value;
}

const dispatchTask = createVersionDispatcher({
  contractKind: "Task",
  versions: { 1: (value) => validateTaskV1(value) },
});

export function taskIdentityProjection(task) {
  const {
    schemaVersion, prompt, fixture, baseline, inputs, determinism, permissions,
    tools, network, environment, limits, outputs, artifacts, grader, visibility, partialCredit,
  } = task;
  return { schemaVersion, prompt, fixture, baseline, inputs, determinism, permissions, tools, network, environment, limits, outputs, artifacts, grader, visibility, partialCredit };
}

export function deriveTaskIdentity(task) {
  return `task:${canonicalDigest(taskIdentityProjection(task), options("")).slice(7)}`;
}

function taskRecordMaterial(task) {
  const material = { ...task };
  delete material.specRevision;
  delete material.digest;
  delete material.previousDigest;
  return material;
}

export function verifyTaskIdentity(task) {
  const expected = deriveTaskIdentity(task);
  if (task.taskId !== expected) contractFailure("INVALID_DIGEST", "task identity does not match its semantic projection", options("/taskId"));
  return task;
}

export function deriveTaskDigest(task) {
  return canonicalDigest(taskRecordMaterial(task), options(""));
}

export function verifyTaskDigest(task) {
  validateTask(task);
  if (task.digest !== deriveTaskDigest(task)) contractFailure("REVISION_DIGEST_MISMATCH", "task record digest is invalid", options("/digest"));
  return task;
}

export function validateTask(task) {
  dispatchTask(task);
  verifyTaskIdentity(task);
  const expected = deriveTaskDigest(task);
  if (task.digest !== expected) contractFailure("REVISION_DIGEST_MISMATCH", "task record digest is invalid", options("/digest"));
  return task;
}

export function parseCanonicalTask(bytes) {
  return sealTask(parseCanonicalJsonV1(bytes, { contractKind: "Task", schemaVersion: 1 }));
}

export function canonicalizeTask(task) {
  validateTask(task);
  return canonicalize(task, options(""));
}

export function sealTask(task) {
  validateTask(task);
  return sealRecord(task, options(""));
}

export function reviseTask(previous, update) {
  validateTask(previous);
  const changes = typeof update === "function" ? update(structuredClone(previous)) : update;
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) contractFailure("INVALID_REVISION", "revision update must be an object", options(""));
  for (const field of ["schemaVersion", "taskId", "specRevision", "previousDigest", "digest", "state"]) {
    if (Object.hasOwn(changes, field)) contractFailure("UNKNOWN_FIELD", "revision field is managed by the Task contract", options(`/${field}`));
  }
  const preview = { ...structuredClone(previous), ...structuredClone(changes) };
  preview.taskId = deriveTaskIdentity(preview);
  const next = reviseRecord(previous, { ...changes, taskId: preview.taskId }, {
    revisionField: "specRevision", identityProjection: taskIdentityProjection, contractKind: "Task", schemaVersion: 1,
  });
  validateTask(next);
  return next;
}

export function verifyTaskRevision(previous, next) {
  validateTask(previous);
  validateTask(next);
  return verifyRevision(previous, next, {
    revisionField: "specRevision", identityProjection: taskIdentityProjection, contractKind: "Task", schemaVersion: 1,
  });
}

const transitionTaskRecord = createLifecycle({
  contractKind: "Task",
  transitions: {
    draft: ["reviewed", "invalidated"], reviewed: ["sealed", "invalidated"],
    sealed: ["retired", "invalidated"],
  },
  terminalStates: ["retired", "invalidated"],
});

export function transitionTask(task, nextState) {
  validateTask(task);
  const transitioned = transitionTaskRecord(task, nextState, options(""));
  const candidate = { ...structuredClone(transitioned) };
  candidate.digest = deriveTaskDigest(candidate);
  return sealTask(candidate);
}
