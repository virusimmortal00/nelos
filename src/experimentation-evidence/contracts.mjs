import { canonicalBytes, canonicalDigest } from "../experimentation-contract/index.mjs";
import { evidenceFailure } from "./errors.mjs";

export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_STREAMS = Object.freeze(["measurement", "operational", "audit"]);
export const EVENT_CLASSIFICATIONS = Object.freeze(["public", "internal", "restricted", "quarantined"]);
export const TASK_WEB_ROLES = Object.freeze(["queen", "planner", "subagent", "spinoff", "grader"]);
export const TOKEN_CATEGORIES = Object.freeze(["input", "cachedInput", "output", "reasoningOutput"]);
export const MAX_EVENT_BYTES = 1024 * 1024;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EVENT_ID = /^evt:[A-Za-z0-9._:-]{1,192}$/u;
const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,191}$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion", "eventId", "eventType", "stream", "experimentId", "runId",
  "runGeneration", "taskId", "trialId", "attempt", "processId", "operationId",
  "modelRequestId", "toolCallId", "pluginInvocationId", "graderInvocationId",
  "artifactId", "threadId", "turnId", "rootTrialId", "writerId", "writerEpoch",
  "sequence", "previousEventDigest", "observedWallTime", "monotonicTimeNs", "clockId",
  "payloadSchema", "payload", "classification", "redaction", "eventDigest",
]);

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    evidenceFailure("INVALID_EVENT", `${label} must be a plain object`);
  }
}

function closedObject(value, fields, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    evidenceFailure("INVALID_EVENT", `${label} fields must match the closed schema`, { actual, expected });
  }
}

function identity(value, field, { nullable = true } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !ID.test(value)) {
    evidenceFailure("INVALID_EVENT", `${field} is invalid`);
  }
}

function integer(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) evidenceFailure("INVALID_EVENT", `${field} is invalid`);
}

export function eventDigest(event) {
  const material = { ...event };
  delete material.eventDigest;
  return canonicalDigest(material);
}

export function validateEvidenceEvent(event, { streamContracts = null } = {}) {
  closedObject(event, ENVELOPE_FIELDS, "event");
  if (event.schemaVersion !== EVIDENCE_SCHEMA_VERSION) evidenceFailure("INCOMPATIBLE_EVIDENCE", "unsupported event schema version");
  if (typeof event.eventId !== "string" || !EVENT_ID.test(event.eventId)) evidenceFailure("INVALID_EVENT", "eventId is invalid");
  identity(event.eventType, "eventType", { nullable: false });
  if (!EVIDENCE_STREAMS.includes(event.stream)) evidenceFailure("INVALID_EVENT", "stream is invalid");
  for (const field of [
    "experimentId", "runId", "taskId", "trialId", "processId", "operationId",
    "modelRequestId", "toolCallId", "pluginInvocationId", "graderInvocationId", "artifactId",
    "threadId", "turnId", "rootTrialId", "writerId", "clockId",
  ]) identity(event[field], field, { nullable: !["experimentId", "runId", "taskId", "trialId", "rootTrialId", "writerId", "clockId"].includes(field) });
  integer(event.runGeneration, "runGeneration", 1);
  integer(event.attempt, "attempt", 1);
  integer(event.writerEpoch, "writerEpoch", 1);
  integer(event.sequence, "sequence", 1);
  if (event.previousEventDigest !== null && !DIGEST.test(event.previousEventDigest)) evidenceFailure("INVALID_EVENT", "previousEventDigest is invalid");
  if (event.sequence === 1 && event.previousEventDigest !== null) evidenceFailure("BROKEN_CHAIN", "the first writer event cannot have a predecessor");
  if (event.sequence > 1 && event.previousEventDigest === null) evidenceFailure("BROKEN_CHAIN", "non-initial writer events require a predecessor");
  if (typeof event.observedWallTime !== "string" || !TIME.test(event.observedWallTime) || Number.isNaN(Date.parse(event.observedWallTime))) evidenceFailure("INVALID_EVENT", "observedWallTime must be RFC3339 UTC");
  if (typeof event.monotonicTimeNs !== "string" || !/^(?:0|[1-9]\d*)$/u.test(event.monotonicTimeNs)) evidenceFailure("INVALID_EVENT", "monotonicTimeNs must be a decimal string");
  if (typeof event.payloadSchema !== "string" || !/^nelos:\/\/events\/[A-Za-z0-9._-]+\/v1$/u.test(event.payloadSchema)) evidenceFailure("INVALID_EVENT", "payloadSchema is invalid");
  plainObject(event.payload, "payload");
  if (!EVENT_CLASSIFICATIONS.includes(event.classification)) evidenceFailure("INVALID_EVENT", "classification is invalid");
  closedObject(event.redaction, ["policyId", "status"], "redaction");
  identity(event.redaction.policyId, "redaction.policyId", { nullable: false });
  if (!["none", "redacted", "quarantined", "dropped"].includes(event.redaction.status)) evidenceFailure("INVALID_EVENT", "redaction status is invalid");
  if (!DIGEST.test(event.eventDigest) || event.eventDigest !== eventDigest(event)) evidenceFailure("ALTERED_EVENT", "event digest does not match its contents");
  if (canonicalBytes(event).byteLength > MAX_EVENT_BYTES) evidenceFailure("INVALID_EVENT", `event exceeds the ${MAX_EVENT_BYTES}-byte envelope limit`);

  const contract = streamContracts?.[event.payloadSchema];
  if (streamContracts && !contract) evidenceFailure("MISSING_MEASUREMENT_CONTRACT", "payload schema has no registered stream contract");
  if (contract && contract.stream !== event.stream) evidenceFailure("STREAM_CONTRACT_VIOLATION", "payload schema cannot enter this stream");
  if (contract?.validate) contract.validate(event.payload);
  return event;
}

export function createEvidenceEvent(fields, options = {}) {
  const candidate = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    eventId: fields.eventId,
    eventType: fields.eventType,
    stream: fields.stream,
    experimentId: fields.experimentId,
    runId: fields.runId,
    runGeneration: fields.runGeneration,
    taskId: fields.taskId,
    trialId: fields.trialId,
    attempt: fields.attempt,
    processId: fields.processId ?? null,
    operationId: fields.operationId ?? null,
    modelRequestId: fields.modelRequestId ?? null,
    toolCallId: fields.toolCallId ?? null,
    pluginInvocationId: fields.pluginInvocationId ?? null,
    graderInvocationId: fields.graderInvocationId ?? null,
    artifactId: fields.artifactId ?? null,
    threadId: fields.threadId ?? null,
    turnId: fields.turnId ?? null,
    rootTrialId: fields.rootTrialId,
    writerId: fields.writerId,
    writerEpoch: fields.writerEpoch,
    sequence: fields.sequence,
    previousEventDigest: fields.previousEventDigest ?? null,
    observedWallTime: fields.observedWallTime,
    monotonicTimeNs: fields.monotonicTimeNs,
    clockId: fields.clockId,
    payloadSchema: fields.payloadSchema,
    payload: fields.payload,
    classification: fields.classification ?? "internal",
    redaction: fields.redaction ?? { policyId: "privacy-v1", status: "none" },
    eventDigest: null,
  };
  candidate.eventDigest = eventDigest(candidate);
  validateEvidenceEvent(candidate, options);
  return Object.freeze(candidate);
}

export function createStreamContractRegistry(contracts) {
  const registry = Object.create(null);
  for (const contract of contracts) {
    closedObject(contract, ["payloadSchema", "stream", "version", "validate"], "stream contract");
    if (contract.version !== 1 || !EVIDENCE_STREAMS.includes(contract.stream) || typeof contract.validate !== "function") evidenceFailure("INVALID_STREAM_CONTRACT", "stream contract is invalid");
    if (registry[contract.payloadSchema]) evidenceFailure("DUPLICATE_EVIDENCE", "payload schemas must be unique");
    registry[contract.payloadSchema] = Object.freeze({ ...contract });
  }
  return Object.freeze(registry);
}

export function assertTokenMeasures(value) {
  closedObject(value, TOKEN_CATEGORIES, "measuredTokens");
  for (const category of TOKEN_CATEGORIES) {
    const amount = value[category];
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) evidenceFailure("INVALID_MEASUREMENT", `token category ${category} is invalid`);
  }
  return value;
}
