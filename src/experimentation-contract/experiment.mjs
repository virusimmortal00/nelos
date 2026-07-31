import {
  canonicalDigest,
  deriveIdentity,
} from "./identity.mjs";
import {
  canonicalize,
  parseCanonicalJsonV1,
} from "./canonical-json.mjs";
import { contractFailure } from "./errors.mjs";
import {
  assertArray,
  assertClosedObject,
  assertDigest,
  assertEnum,
  assertInteger,
  assertNumber,
  assertRequired,
  assertString,
  assertUniqueIdentities,
  createVersionDispatcher,
} from "./validation.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { reviseRecord, sealRecord, verifyRevision } from "./revision.mjs";

export const EXPERIMENT_SCHEMA_VERSION = 1;
export const EXPERIMENT_STATES_V1 = Object.freeze([
  "draft", "reviewed", "sealed", "running", "stopped", "completed",
  "reported", "archived", "invalidated",
]);

const ID = /^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9._-]{1,128}$/u;
const EXPERIMENT_ID = /^exp:[0-9a-f]{64}$/u;
const NAME = /^[a-z][a-z0-9_.-]{0,63}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ctx = (path) => ({ path, contractKind: "Experiment", schemaVersion: 1 });

function object(value, fields, required, path) {
  assertClosedObject(value, fields, ctx(path));
  assertRequired(value, required, ctx(path));
  return value;
}

function string(value, path, minLength = 1, maxLength = 256, pattern) {
  return assertString(value, { minLength, maxLength, pattern, ...ctx(path) });
}

function enumeration(value, allowed, path) {
  return assertEnum(value, allowed, ctx(path));
}

function array(value, path, minItems = 0, maxItems = 64) {
  return assertArray(value, { minItems, maxItems, ...ctx(path) });
}

function unique(values, path, identity) {
  return assertUniqueIdentities(values, identity, { path, contractKind: "Experiment", schemaVersion: 1 });
}

function validateSource(value, path) {
  object(value, ["commit", "digest"], ["commit", "digest"], path);
  string(value.commit, `${path}/commit`, 40, 40, COMMIT);
  assertDigest(value.digest, ctx(`${path}/digest`));
}

function validateModel(value, path) {
  object(value, ["id", "revision", "reasoningEffort"], ["id", "revision", "reasoningEffort"], path);
  string(value.id, `${path}/id`, 1, 128, ID);
  string(value.revision, `${path}/revision`, 1, 128);
  enumeration(value.reasoningEffort, ["low", "medium", "high", "xhigh", "max", "ultra"], `${path}/reasoningEffort`);
}

function validatePlugins(value, path) {
  array(value, path, 0, 32);
  unique(value, path, (item) => item.id);
  value.forEach((item, index) => {
    const itemPath = `${path}/${index}`;
    object(item, ["id", "version", "digest"], ["id", "version", "digest"], itemPath);
    string(item.id, `${itemPath}/id`, 1, 128, ID);
    string(item.version, `${itemPath}/version`, 1, 64);
    assertDigest(item.digest, ctx(`${itemPath}/digest`));
  });
}

function validateConfiguration(value, path) {
  array(value, path, 0, 64);
  unique(value, path, (item) => item.name);
  value.forEach((item, index) => {
    const itemPath = `${path}/${index}`;
    object(item, ["name", "value"], ["name", "value"], itemPath);
    string(item.name, `${itemPath}/name`, 1, 64, NAME);
    string(item.value, `${itemPath}/value`, 0, 512);
  });
}

function validateCandidate(value, path) {
  object(value, ["candidateId", "adapter", "source", "model", "plugins", "configuration"],
    ["candidateId", "adapter", "source", "model", "plugins", "configuration"], path);
  string(value.candidateId, `${path}/candidateId`, 1, 160, ID);
  enumeration(value.adapter, ["direct-codex", "nelos"], `${path}/adapter`);
  validateSource(value.source, `${path}/source`);
  validateModel(value.model, `${path}/model`);
  validatePlugins(value.plugins, `${path}/plugins`);
  validateConfiguration(value.configuration, `${path}/configuration`);
}

function validateHypothesis(value, path) {
  object(value, ["statement", "primaryMetric", "decisionRule"], ["statement", "primaryMetric", "decisionRule"], path);
  string(value.statement, `${path}/statement`, 1, 2048);
  string(value.primaryMetric, `${path}/primaryMetric`, 1, 64, NAME);
  enumeration(value.decisionRule, ["superiority", "noninferiority", "noninferior-quality-and-lower-credit-cost"], `${path}/decisionRule`);
}

function validateCorpus(value, path) {
  object(value, ["releaseId", "digest"], ["releaseId", "digest"], path);
  string(value.releaseId, `${path}/releaseId`, 1, 160, ID);
  assertDigest(value.digest, ctx(`${path}/digest`));
}

function validateDesign(value, path) {
  object(value, ["pairing", "repetitions", "seedRoot", "seedSchedule", "multiplicityFamily"],
    ["pairing", "repetitions", "seedRoot", "seedSchedule", "multiplicityFamily"], path);
  enumeration(value.pairing, ["unpaired", "task", "task-seed", "task-seed-time-block"], `${path}/pairing`);
  assertInteger(value.repetitions, { minimum: 1, maximum: 1000, ...ctx(`${path}/repetitions`) });
  string(value.seedRoot, `${path}/seedRoot`, 1, 128);
  string(value.multiplicityFamily, `${path}/multiplicityFamily`, 1, 64, NAME);
  array(value.seedSchedule, `${path}/seedSchedule`, 1, 1000);
  unique(value.seedSchedule, `${path}/seedSchedule`, (item) => item.replicate);
  value.seedSchedule.forEach((item, index) => {
    const itemPath = `${path}/seedSchedule/${index}`;
    object(item, ["replicate", "seed"], ["replicate", "seed"], itemPath);
    assertInteger(item.replicate, { minimum: 1, maximum: 1000, ...ctx(`${itemPath}/replicate`) });
    string(item.seed, `${itemPath}/seed`, 1, 128);
  });
}

function validateLimits(value, path) {
  const fields = ["wallClockSeconds", "tokenBudget", "toolCalls", "diskBytes", "processes", "networkRequests"];
  object(value, fields, fields, path);
  assertInteger(value.wallClockSeconds, { minimum: 1, maximum: 604800, ...ctx(`${path}/wallClockSeconds`) });
  assertInteger(value.tokenBudget, { minimum: 1, maximum: 1000000000, ...ctx(`${path}/tokenBudget`) });
  assertInteger(value.toolCalls, { minimum: 0, maximum: 1000000, ...ctx(`${path}/toolCalls`) });
  assertInteger(value.diskBytes, { minimum: 1, maximum: Number.MAX_SAFE_INTEGER, ...ctx(`${path}/diskBytes`) });
  assertInteger(value.processes, { minimum: 1, maximum: 65536, ...ctx(`${path}/processes`) });
  assertInteger(value.networkRequests, { minimum: 0, maximum: 1000000, ...ctx(`${path}/networkRequests`) });
}

function validateRuntimeMatrix(value, path, candidateIds) {
  array(value, path, 1, 64);
  unique(value, path, (item) => item.runtimeLockId);
  value.forEach((item, index) => {
    const itemPath = `${path}/${index}`;
    object(item, ["runtimeLockId", "digest", "backend", "platform", "eligibleCandidateIds", "requiredCapabilities"],
      ["runtimeLockId", "digest", "backend", "platform", "eligibleCandidateIds", "requiredCapabilities"], itemPath);
    string(item.runtimeLockId, `${itemPath}/runtimeLockId`, 1, 160, ID);
    assertDigest(item.digest, ctx(`${itemPath}/digest`));
    enumeration(item.backend, ["oci-headless", "dedicated-desktop"], `${itemPath}/backend`);
    enumeration(item.platform, ["linux-amd64", "linux-arm64", "macos-arm64"], `${itemPath}/platform`);
    array(item.eligibleCandidateIds, `${itemPath}/eligibleCandidateIds`, 1, 64);
    unique(item.eligibleCandidateIds, `${itemPath}/eligibleCandidateIds`, (id) => id);
    item.eligibleCandidateIds.forEach((id, candidateIndex) => {
      string(id, `${itemPath}/eligibleCandidateIds/${candidateIndex}`, 1, 160, ID);
      if (!candidateIds.has(id)) contractFailure("invalid_format", "runtime eligibility must reference a declared candidate", ctx(`${itemPath}/eligibleCandidateIds/${candidateIndex}`));
    });
    array(item.requiredCapabilities, `${itemPath}/requiredCapabilities`, 0, 64);
    unique(item.requiredCapabilities, `${itemPath}/requiredCapabilities`, (capability) => capability);
    item.requiredCapabilities.forEach((capability, capabilityIndex) => string(capability, `${itemPath}/requiredCapabilities/${capabilityIndex}`, 1, 64, NAME));
  });
}

function validateExclusions(value, path) {
  array(value, path, 0, 256);
  unique(value, path, (item) => item.exclusionId);
  value.forEach((item, index) => {
    const itemPath = `${path}/${index}`;
    object(item, ["exclusionId", "scope", "subjectId", "reasonCode"], ["exclusionId", "scope", "subjectId", "reasonCode"], itemPath);
    string(item.exclusionId, `${itemPath}/exclusionId`, 1, 160, ID);
    enumeration(item.scope, ["task", "category", "candidate", "runtime"], `${itemPath}/scope`);
    string(item.subjectId, `${itemPath}/subjectId`, 1, 160, ID);
    string(item.reasonCode, `${itemPath}/reasonCode`, 1, 64, NAME);
  });
}

function validateMetric(value, path) {
  object(value, ["metricId", "direction", "aggregation"], ["metricId", "direction", "aggregation"], path);
  string(value.metricId, `${path}/metricId`, 1, 64, NAME);
  enumeration(value.direction, ["higher", "lower"], `${path}/direction`);
  enumeration(value.aggregation, ["mean", "median", "rate", "quantile"], `${path}/aggregation`);
}

function validateMetrics(value, path, primaryMetric) {
  object(value, ["primary", "secondary", "minimumDetectableEffect"], ["primary", "secondary", "minimumDetectableEffect"], path);
  validateMetric(value.primary, `${path}/primary`);
  if (value.primary.metricId !== primaryMetric) contractFailure("invalid_format", "primary metric must match the hypothesis", ctx(`${path}/primary/metricId`));
  array(value.secondary, `${path}/secondary`, 0, 32);
  unique(value.secondary, `${path}/secondary`, (item) => item.metricId);
  value.secondary.forEach((item, index) => validateMetric(item, `${path}/secondary/${index}`));
  const mde = value.minimumDetectableEffect;
  object(mde, ["metricId", "absolute", "power", "alpha"], ["metricId", "absolute", "power", "alpha"], `${path}/minimumDetectableEffect`);
  string(mde.metricId, `${path}/minimumDetectableEffect/metricId`, 1, 64, NAME);
  if (mde.metricId !== primaryMetric) contractFailure("invalid_format", "minimum detectable effect must target the primary metric", ctx(`${path}/minimumDetectableEffect/metricId`));
  assertNumber(mde.absolute, { minimum: 0.000001, maximum: 1, ...ctx(`${path}/minimumDetectableEffect/absolute`) });
  assertNumber(mde.power, { minimum: 0.5, maximum: 0.999999, ...ctx(`${path}/minimumDetectableEffect/power`) });
  assertNumber(mde.alpha, { minimum: 0.000001, maximum: 0.5, ...ctx(`${path}/minimumDetectableEffect/alpha`) });
}

function validateRule(value, path, kinds) {
  object(value, ["kind", "metricId", "threshold", "minimumSamples"], ["kind", "metricId", "threshold", "minimumSamples"], path);
  enumeration(value.kind, kinds, `${path}/kind`);
  string(value.metricId, `${path}/metricId`, 1, 64, NAME);
  assertNumber(value.threshold, { minimum: 0, maximum: 1000000000, ...ctx(`${path}/threshold`) });
  assertInteger(value.minimumSamples, { minimum: 1, maximum: 1000000, ...ctx(`${path}/minimumSamples`) });
}

function validateDecisionRules(value, path) {
  object(value, ["promotion", "regression", "stop", "invalidation"], ["promotion", "regression", "stop", "invalidation"], path);
  validateRule(value.promotion, `${path}/promotion`, ["superiority", "noninferiority"]);
  validateRule(value.regression, `${path}/regression`, ["absolute", "relative"]);
  validateRule(value.stop, `${path}/stop`, ["fixed-sample", "futility", "safety"]);
  const invalidation = value.invalidation;
  object(invalidation, ["maxInvalidFraction", "asymmetricInvalidity", "reasonCodes"], ["maxInvalidFraction", "asymmetricInvalidity", "reasonCodes"], `${path}/invalidation`);
  assertNumber(invalidation.maxInvalidFraction, { minimum: 0, maximum: 1, ...ctx(`${path}/invalidation/maxInvalidFraction`) });
  enumeration(invalidation.asymmetricInvalidity, ["invalidate-comparison", "report-only"], `${path}/invalidation/asymmetricInvalidity`);
  array(invalidation.reasonCodes, `${path}/invalidation/reasonCodes`, 1, 64);
  unique(invalidation.reasonCodes, `${path}/invalidation/reasonCodes`, (code) => code);
  invalidation.reasonCodes.forEach((code, index) => string(code, `${path}/invalidation/reasonCodes/${index}`, 1, 64, NAME));
}

function validateV1(value) {
  const fields = ["schemaVersion", "experimentId", "specRevision", "previousDigest", "digest", "state", "name", "description", "hypothesis", "candidates", "corpus", "design", "limits", "runtimeMatrix", "graderBundle", "exclusions", "metrics", "decisionRules"];
  object(value, fields, fields, "");
  assertInteger(value.schemaVersion, { minimum: 1, maximum: 1, ...ctx("/schemaVersion") });
  string(value.experimentId, "/experimentId", 68, 68, EXPERIMENT_ID);
  assertInteger(value.specRevision, { minimum: 1, maximum: 1000000, ...ctx("/specRevision") });
  if (value.previousDigest !== null) assertDigest(value.previousDigest, ctx("/previousDigest"));
  assertDigest(value.digest, ctx("/digest"));
  enumeration(value.state, EXPERIMENT_STATES_V1, "/state");
  string(value.name, "/name", 1, 128);
  string(value.description, "/description", 0, 4096);
  validateHypothesis(value.hypothesis, "/hypothesis");
  array(value.candidates, "/candidates", 2, 32);
  unique(value.candidates, "/candidates", (candidate) => candidate.candidateId);
  value.candidates.forEach((candidate, index) => validateCandidate(candidate, `/candidates/${index}`));
  validateCorpus(value.corpus, "/corpus");
  validateDesign(value.design, "/design");
  if (value.design.seedSchedule.length !== value.design.repetitions) contractFailure("out_of_bounds", "seed schedule length must equal repetitions", ctx("/design/seedSchedule"));
  validateLimits(value.limits, "/limits");
  validateRuntimeMatrix(value.runtimeMatrix, "/runtimeMatrix", new Set(value.candidates.map((candidate) => candidate.candidateId)));
  object(value.graderBundle, ["id", "digest"], ["id", "digest"], "/graderBundle");
  string(value.graderBundle.id, "/graderBundle/id", 1, 160, ID);
  assertDigest(value.graderBundle.digest, ctx("/graderBundle/digest"));
  validateExclusions(value.exclusions, "/exclusions");
  validateMetrics(value.metrics, "/metrics", value.hypothesis.primaryMetric);
  validateDecisionRules(value.decisionRules, "/decisionRules");
  if (value.specRevision === 1 && value.previousDigest !== null) contractFailure("invalid_lineage", "initial revision cannot have a previous digest", ctx("/previousDigest"));
  if (value.specRevision > 1 && value.previousDigest === null) contractFailure("invalid_lineage", "successor revision requires a previous digest", ctx("/previousDigest"));
  return value;
}

export const validateExperiment = createVersionDispatcher({ contractKind: "Experiment", versions: { 1: validateV1 } });

export function experimentIdentityProjection(value) {
  return {
    schemaVersion: value.schemaVersion,
    hypothesis: value.hypothesis,
    candidates: value.candidates,
    corpus: value.corpus,
    design: value.design,
    limits: value.limits,
    runtimeMatrix: value.runtimeMatrix,
    graderBundle: value.graderBundle,
    exclusions: value.exclusions,
    metrics: value.metrics,
    decisionRules: value.decisionRules,
  };
}

export function deriveExperimentIdentity(value) {
  return `exp:${deriveIdentity(value, experimentIdentityProjection, ctx("")).slice(7)}`;
}

function digestMaterial(value) {
  const material = { ...value };
  delete material.specRevision;
  delete material.digest;
  delete material.previousDigest;
  return material;
}

export function deriveExperimentDigest(value) {
  return canonicalDigest(digestMaterial(value), ctx(""));
}

export function verifyExperimentIdentity(value) {
  validateExperiment(value);
  if (value.experimentId !== deriveExperimentIdentity(value)) contractFailure("invalid_digest", "experiment identity does not match its identity projection", ctx("/experimentId"));
  return value;
}

export function verifyExperimentDigest(value) {
  validateExperiment(value);
  if (value.digest !== deriveExperimentDigest(value)) contractFailure("revision_digest_mismatch", "experiment digest is invalid", ctx("/digest"));
  return value;
}

export function sealExperiment(value) {
  verifyExperimentIdentity(value);
  verifyExperimentDigest(value);
  return sealRecord(value, ctx(""));
}

export function canonicalizeExperiment(value) {
  validateExperiment(value);
  return canonicalize(value, ctx(""));
}

export function parseCanonicalExperiment(bytes) {
  const value = parseCanonicalJsonV1(bytes, ctx(""));
  return sealExperiment(value);
}

export function reviseExperiment(previous, changes) {
  sealExperiment(previous);
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) contractFailure("invalid_revision", "experiment revision update must be an object", ctx(""));
  for (const field of ["schemaVersion", "specRevision", "previousDigest", "digest", "experimentId", "state"]) {
    if (Object.hasOwn(changes, field)) contractFailure("unknown_field", "revision field is managed by the Experiment contract", ctx(`/${field}`));
  }
  const semanticCandidate = { ...structuredClone(previous), ...structuredClone(changes) };
  semanticCandidate.experimentId = deriveExperimentIdentity(semanticCandidate);
  const next = reviseRecord(previous, { ...changes, experimentId: semanticCandidate.experimentId }, {
    revisionField: "specRevision", digestField: "digest", previousDigestField: "previousDigest",
    identityProjection: experimentIdentityProjection, contractKind: "Experiment", schemaVersion: 1,
  });
  validateExperiment(next);
  verifyExperimentIdentity(next);
  return next;
}

export function verifyExperimentRevision(previous, next) {
  sealExperiment(previous);
  sealExperiment(next);
  verifyRevision(previous, next, {
    revisionField: "specRevision", digestField: "digest", previousDigestField: "previousDigest",
    identityProjection: experimentIdentityProjection, contractKind: "Experiment", schemaVersion: 1,
  });
  verifyExperimentIdentity(next);
  return next;
}

const lifecycle = createLifecycle({
  contractKind: "Experiment",
  transitions: {
    draft: ["reviewed", "invalidated"], reviewed: ["sealed", "invalidated"],
    sealed: ["running", "invalidated"], running: ["stopped", "completed", "invalidated"],
    completed: ["reported"], reported: ["archived"],
  },
  terminalStates: ["stopped", "archived", "invalidated"],
});

export function transitionExperiment(record, nextState) {
  sealExperiment(record);
  const transitioned = structuredClone(lifecycle(record, nextState, ctx("")));
  transitioned.digest = deriveExperimentDigest(transitioned);
  return sealExperiment(transitioned);
}
