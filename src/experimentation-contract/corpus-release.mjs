import {
  MAX_CANONICAL_JSON_BYTES,
  appendJsonPointer,
  canonicalBytes,
  parseCanonicalJsonV1,
} from "./canonical-json.mjs";
import { contractFailure } from "./errors.mjs";
import { canonicalDigest, deriveIdentity } from "./identity.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { reviseRecord, sealRecord, verifyRevision } from "./revision.mjs";
import {
  compareSemanticVersions,
  isSemanticVersion,
} from "./semantic-version.mjs";
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

export const CORPUS_RELEASE_SCHEMA_VERSION = 1;
export const CORPUS_RELEASE_VISIBILITIES = Object.freeze([
  "public",
  "development",
  "private-test",
  "challenge",
]);
export const CORPUS_RELEASE_STATES = Object.freeze([
  "draft",
  "reviewed",
  "sealed",
  "published",
  "superseded",
  "invalidated",
]);

const CONTRACT_KIND = "CorpusRelease";
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const TASK_ID_PATTERN = /^task:[0-9a-f]{64}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const SPDX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u;
const UTC_PATTERN = /^(?:19|20|21)[0-9]{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/u;
const CHANGE_KINDS = Object.freeze([
  "initial",
  "task-added",
  "task-revised",
  "task-excluded",
  "asset-revised",
  "grader-revised",
  "metadata-revised",
]);
const EXCLUSION_REASONS = Object.freeze([
  "contamination",
  "duplicate",
  "invalid-fixture",
  "invalid-grader",
  "license",
  "policy",
  "superseded",
  "other",
]);

function options(path = "") {
  return {
    path,
    contractKind: CONTRACT_KIND,
    schemaVersion: 1,
    maxBytes: MAX_CANONICAL_JSON_BYTES,
  };
}

function fail(code, message, path) {
  contractFailure(code, message, options(path));
}

function fieldPath(path, field) {
  return appendJsonPointer(path, field);
}

function closed(value, fields, path) {
  assertClosedObject(value, fields, options(path));
  assertRequired(value, fields, options(path));
}

function string(value, path, settings = {}) {
  return assertString(value, { minLength: 1, maxLength: 256, ...settings, ...options(path) });
}

function id(value, path) {
  return string(value, path, { maxLength: 128, pattern: ID_PATTERN });
}

function taskId(value, path) {
  return string(value, path, {
    minLength: 69,
    maxLength: 69,
    pattern: TASK_ID_PATTERN,
  });
}

function semanticVersion(value, path) {
  string(value, path, { maxLength: 128 });
  if (!isSemanticVersion(value)) {
    fail("invalid_format", "string does not match the required format", path);
  }
}

function timestamp(value, path) {
  string(value, path, { minLength: 20, maxLength: 20, pattern: UTC_PATTERN });
  const instant = new Date(value);
  const canonicalInstant = `${value.slice(0, -1)}.000Z`;
  if (Number.isNaN(instant.valueOf()) || instant.toISOString() !== canonicalInstant) {
    fail("invalid_format", "timestamp must be a real UTC instant", path);
  }
}

function validateSortedUnique(values, identity, path) {
  assertUniqueIdentities(values, identity, options(path));
  for (let index = 1; index < values.length; index += 1) {
    if (identity(values[index - 1]) >= identity(values[index])) {
      fail("invalid_format", "collection must be strictly ordered by identity", fieldPath(path, index));
    }
  }
}

function validateStringSet(values, path, { minItems = 0, maxItems = 128 } = {}) {
  assertArray(values, { minItems, maxItems, ...options(path) });
  values.forEach((value, index) => id(value, fieldPath(path, index)));
  validateSortedUnique(values, (value) => value, path);
}

function validateTaskIdSet(values, path, { minItems = 0, maxItems = 128 } = {}) {
  assertArray(values, { minItems, maxItems, ...options(path) });
  values.forEach((value, index) => taskId(value, fieldPath(path, index)));
  validateSortedUnique(values, (value) => value, path);
}

function validateParent(parent, path) {
  if (parent === null) return;
  closed(parent, ["releaseId", "version", "digest"], path);
  string(parent.releaseId, fieldPath(path, "releaseId"), {
    minLength: 71,
    maxLength: 71,
    pattern: /^corpus:[0-9a-f]{64}$/u,
  });
  semanticVersion(parent.version, fieldPath(path, "version"));
  assertDigest(parent.digest, options(fieldPath(path, "digest")));
}

function validateChangelog(entries, path) {
  assertArray(entries, { minItems: 1, maxItems: 256, ...options(path) });
  entries.forEach((entry, index) => {
    const itemPath = fieldPath(path, index);
    closed(entry, ["changeId", "kind", "summary", "taskIds"], itemPath);
    id(entry.changeId, fieldPath(itemPath, "changeId"));
    assertEnum(entry.kind, CHANGE_KINDS, options(fieldPath(itemPath, "kind")));
    string(entry.summary, fieldPath(itemPath, "summary"), { maxLength: 1024 });
    validateTaskIdSet(entry.taskIds, fieldPath(itemPath, "taskIds"), { maxItems: 1024 });
  });
  validateSortedUnique(entries, (entry) => entry.changeId, path);
}

function validateStratumCatalog(entries, path) {
  assertArray(entries, { minItems: 1, maxItems: 64, ...options(path) });
  entries.forEach((entry, index) => {
    const itemPath = fieldPath(path, index);
    closed(entry, ["id", "label", "weight"], itemPath);
    id(entry.id, fieldPath(itemPath, "id"));
    string(entry.label, fieldPath(itemPath, "label"), { maxLength: 128 });
    assertNumber(entry.weight, { minimum: 0.000001, maximum: 1, ...options(fieldPath(itemPath, "weight")) });
  });
  validateSortedUnique(entries, (entry) => entry.id, path);
  const totalWeight = entries.reduce((total, entry) => total + entry.weight, 0);
  if (Math.abs(totalWeight - 1) > Number.EPSILON * entries.length) {
    fail("out_of_bounds", "stratum weights must sum to one", path);
  }
}

function validateStrata(strata, path) {
  const dimensions = ["categories", "risks", "sizes", "decomposabilities"];
  closed(strata, dimensions, path);
  dimensions.forEach((dimension) => validateStratumCatalog(strata[dimension], fieldPath(path, dimension)));
}

function validateTaskStrata(strata, path, catalogs) {
  const fields = ["category", "risk", "size", "decomposability"];
  closed(strata, fields, path);
  const catalogFields = ["categories", "risks", "sizes", "decomposabilities"];
  fields.forEach((field, index) => {
    id(strata[field], fieldPath(path, field));
    if (!catalogs[catalogFields[index]].some((entry) => entry.id === strata[field])) {
      fail("invalid_enum", "stratum must reference a declared catalog identity", fieldPath(path, field));
    }
  });
}

function validateTasks(tasks, path, catalogs) {
  assertArray(tasks, { minItems: 1, maxItems: 100000, ...options(path) });
  tasks.forEach((task, index) => {
    const itemPath = fieldPath(path, index);
    closed(task, ["taskId", "revision", "digest", "assetDigests", "strata"], itemPath);
    taskId(task.taskId, fieldPath(itemPath, "taskId"));
    assertInteger(task.revision, { minimum: 1, maximum: 1000000, ...options(fieldPath(itemPath, "revision")) });
    assertDigest(task.digest, options(fieldPath(itemPath, "digest")));
    assertArray(task.assetDigests, { maxItems: 256, ...options(fieldPath(itemPath, "assetDigests")) });
    task.assetDigests.forEach((digest, digestIndex) => assertDigest(digest, options(fieldPath(fieldPath(itemPath, "assetDigests"), digestIndex))));
    validateSortedUnique(task.assetDigests, (digest) => digest, fieldPath(itemPath, "assetDigests"));
    validateTaskStrata(task.strata, fieldPath(itemPath, "strata"), catalogs);
  });
  validateSortedUnique(tasks, (task) => task.taskId, path);
}

function validateAssets(assets, path) {
  assertArray(assets, { maxItems: 100000, ...options(path) });
  assets.forEach((asset, index) => {
    const itemPath = fieldPath(path, index);
    closed(asset, ["assetId", "digest", "mediaType", "bytes"], itemPath);
    id(asset.assetId, fieldPath(itemPath, "assetId"));
    assertDigest(asset.digest, options(fieldPath(itemPath, "digest")));
    string(asset.mediaType, fieldPath(itemPath, "mediaType"), { maxLength: 128, pattern: MEDIA_TYPE_PATTERN });
    assertInteger(asset.bytes, { minimum: 0, maximum: 1099511627776, ...options(fieldPath(itemPath, "bytes")) });
  });
  validateSortedUnique(assets, (asset) => asset.assetId, path);
}

function validateCutoff(cutoff, path) {
  closed(cutoff, ["createdAt", "sourceCutoffAt", "policy"], path);
  timestamp(cutoff.createdAt, fieldPath(path, "createdAt"));
  timestamp(cutoff.sourceCutoffAt, fieldPath(path, "sourceCutoffAt"));
  assertEnum(cutoff.policy, ["strict", "declared-exceptions"], options(fieldPath(path, "policy")));
  if (cutoff.sourceCutoffAt > cutoff.createdAt) {
    fail("invalid_lineage", "source cutoff cannot follow release creation", fieldPath(path, "sourceCutoffAt"));
  }
}

function validateProvenance(provenance, path) {
  closed(provenance, ["method", "sourceUri", "sourceDigest", "curators"], path);
  assertEnum(provenance.method, ["authored", "imported", "mixed"], options(fieldPath(path, "method")));
  string(provenance.sourceUri, fieldPath(path, "sourceUri"), { maxLength: 2048, pattern: /^(?:https:\/\/|urn:)[^\s]+$/u });
  assertDigest(provenance.sourceDigest, options(fieldPath(path, "sourceDigest")));
  validateStringSet(provenance.curators, fieldPath(path, "curators"), { minItems: 1, maxItems: 64 });
}

function validateLicense(license, path) {
  closed(license, ["spdxId", "textDigest", "attribution"], path);
  string(license.spdxId, fieldPath(path, "spdxId"), { maxLength: 64, pattern: SPDX_PATTERN });
  assertDigest(license.textDigest, options(fieldPath(path, "textDigest")));
  string(license.attribution, fieldPath(path, "attribution"), { maxLength: 2048 });
}

function validateDuplicateGroups(groups, path, near) {
  assertArray(groups, { maxItems: 10000, ...options(path) });
  groups.forEach((group, index) => {
    const itemPath = fieldPath(path, index);
    const fields = near ? ["groupId", "taskIds", "maximumSimilarity"] : ["groupId", "taskIds"];
    closed(group, fields, itemPath);
    id(group.groupId, fieldPath(itemPath, "groupId"));
    validateTaskIdSet(group.taskIds, fieldPath(itemPath, "taskIds"), { minItems: 2, maxItems: 1000 });
    if (near) assertNumber(group.maximumSimilarity, { minimum: 0, maximum: 1, ...options(fieldPath(itemPath, "maximumSimilarity")) });
  });
  validateSortedUnique(groups, (group) => group.groupId, path);
}

function validateDuplicateAnalysis(analysis, path) {
  closed(analysis, ["method", "toolDigest", "nearThreshold", "exactGroups", "nearGroups"], path);
  string(analysis.method, fieldPath(path, "method"), { maxLength: 128 });
  assertDigest(analysis.toolDigest, options(fieldPath(path, "toolDigest")));
  assertNumber(analysis.nearThreshold, { minimum: 0, maximum: 1, ...options(fieldPath(path, "nearThreshold")) });
  validateDuplicateGroups(analysis.exactGroups, fieldPath(path, "exactGroups"), false);
  validateDuplicateGroups(analysis.nearGroups, fieldPath(path, "nearGroups"), true);
  analysis.nearGroups.forEach((group, index) => {
    if (group.maximumSimilarity < analysis.nearThreshold) {
      fail("out_of_bounds", "near-duplicate similarity must meet the declared threshold", fieldPath(fieldPath(fieldPath(path, "nearGroups"), index), "maximumSimilarity"));
    }
  });
}

function validateGraderBundles(bundles, path) {
  assertArray(bundles, { minItems: 1, maxItems: 1024, ...options(path) });
  bundles.forEach((bundle, index) => {
    const itemPath = fieldPath(path, index);
    closed(bundle, ["graderBundleId", "version", "digest"], itemPath);
    id(bundle.graderBundleId, fieldPath(itemPath, "graderBundleId"));
    semanticVersion(bundle.version, fieldPath(itemPath, "version"));
    assertDigest(bundle.digest, options(fieldPath(itemPath, "digest")));
  });
  validateSortedUnique(bundles, (bundle) => bundle.graderBundleId, path);
}

function validateExclusions(exclusions, path) {
  assertArray(exclusions, { maxItems: 100000, ...options(path) });
  exclusions.forEach((exclusion, index) => {
    const itemPath = fieldPath(path, index);
    closed(exclusion, ["taskId", "reasonCode", "reason"], itemPath);
    taskId(exclusion.taskId, fieldPath(itemPath, "taskId"));
    assertEnum(exclusion.reasonCode, EXCLUSION_REASONS, options(fieldPath(itemPath, "reasonCode")));
    string(exclusion.reason, fieldPath(itemPath, "reason"), { maxLength: 1024 });
  });
  validateSortedUnique(exclusions, (exclusion) => exclusion.taskId, path);
}

function validateReferences(release) {
  const assetDigests = new Set(release.assets.map((asset) => asset.digest));
  release.tasks.forEach((task, taskIndex) => task.assetDigests.forEach((digest, digestIndex) => {
    if (!assetDigests.has(digest)) fail("invalid_lineage", "task asset digest must reference a declared asset", `/tasks/${taskIndex}/assetDigests/${digestIndex}`);
  }));
  const taskIds = new Set(release.tasks.map((task) => task.taskId));
  const excluded = new Set(release.retainedExclusions.map((entry) => entry.taskId));
  release.retainedExclusions.forEach((entry, index) => {
    if (taskIds.has(entry.taskId)) fail("duplicate_identity", "excluded task cannot remain active", `/retainedExclusions/${index}/taskId`);
  });
  release.changelog.forEach((entry, entryIndex) => entry.taskIds.forEach((taskId, taskIndex) => {
    if (!taskIds.has(taskId) && !excluded.has(taskId)) fail("invalid_lineage", "changelog must reference a retained task identity", `/changelog/${entryIndex}/taskIds/${taskIndex}`);
  }));
  for (const [groupField, groups] of [["exactGroups", release.duplicateAnalysis.exactGroups], ["nearGroups", release.duplicateAnalysis.nearGroups]]) {
    groups.forEach((group, groupIndex) => group.taskIds.forEach((taskId, taskIndex) => {
      if (!taskIds.has(taskId) && !excluded.has(taskId)) fail("invalid_lineage", "duplicate analysis must reference a retained task identity", `/duplicateAnalysis/${groupField}/${groupIndex}/taskIds/${taskIndex}`);
    }));
  }
}

function validateSuccessorTaskAudit(previous, next) {
  const previousTaskIds = new Set(previous.tasks.map((task) => task.taskId));
  const nextTaskIds = new Set(next.tasks.map((task) => task.taskId));
  const nextExclusionIds = new Set(
    next.retainedExclusions.map((exclusion) => exclusion.taskId),
  );
  const removedTaskIds = new Set(
    [...previousTaskIds].filter((taskIdentity) => !nextTaskIds.has(taskIdentity)),
  );

  for (const exclusion of previous.retainedExclusions) {
    if (!nextExclusionIds.has(exclusion.taskId)) {
      fail(
        "invalid_lineage",
        "successor must retain prior task exclusion evidence",
        "/retainedExclusions",
      );
    }
  }
  for (const removedTaskId of removedTaskIds) {
    if (!nextExclusionIds.has(removedTaskId)) {
      fail(
        "invalid_lineage",
        "removed task must remain listed as a retained exclusion",
        "/retainedExclusions",
      );
    }
  }

  const auditedTaskIds = new Set();
  next.changelog.forEach((entry, entryIndex) => {
    if (entry.kind !== "task-excluded") return;
    entry.taskIds.forEach((taskIdentity, taskIndex) => {
      if (!removedTaskIds.has(taskIdentity)) {
        fail(
          "invalid_lineage",
          "task-excluded changelog entries must identify tasks removed from the predecessor",
          `/changelog/${entryIndex}/taskIds/${taskIndex}`,
        );
      }
      auditedTaskIds.add(taskIdentity);
    });
  });
  for (const removedTaskId of removedTaskIds) {
    if (!auditedTaskIds.has(removedTaskId)) {
      fail(
        "invalid_lineage",
        "removed task requires a task-excluded changelog entry",
        "/changelog",
      );
    }
  }
}

const TOP_LEVEL_FIELDS = Object.freeze([
  "schemaVersion", "releaseId", "revision", "version", "parent", "previousDigest",
  "changelog", "tasks", "assets", "strata", "cutoff", "provenance", "license",
  "duplicateAnalysis", "graderBundles", "visibility", "retainedExclusions", "state", "digest",
]);

function validateV1(release) {
  closed(release, TOP_LEVEL_FIELDS, "");
  assertInteger(release.schemaVersion, { minimum: 1, maximum: 1, ...options("/schemaVersion") });
  string(release.releaseId, "/releaseId", { minLength: 71, maxLength: 71, pattern: /^corpus:[0-9a-f]{64}$/u });
  assertInteger(release.revision, { minimum: 1, maximum: 1000000, ...options("/revision") });
  semanticVersion(release.version, "/version");
  validateParent(release.parent, "/parent");
  if (release.previousDigest !== null) assertDigest(release.previousDigest, options("/previousDigest"));
  validateChangelog(release.changelog, "/changelog");
  validateStrata(release.strata, "/strata");
  validateTasks(release.tasks, "/tasks", release.strata);
  validateAssets(release.assets, "/assets");
  validateCutoff(release.cutoff, "/cutoff");
  validateProvenance(release.provenance, "/provenance");
  validateLicense(release.license, "/license");
  validateDuplicateAnalysis(release.duplicateAnalysis, "/duplicateAnalysis");
  validateGraderBundles(release.graderBundles, "/graderBundles");
  assertEnum(release.visibility, CORPUS_RELEASE_VISIBILITIES, options("/visibility"));
  validateExclusions(release.retainedExclusions, "/retainedExclusions");
  assertEnum(release.state, CORPUS_RELEASE_STATES, options("/state"));
  assertDigest(release.digest, options("/digest"));
  if (release.revision === 1 && release.previousDigest !== null) fail("invalid_lineage", "initial revision cannot have a previous digest", "/previousDigest");
  if (release.revision > 1 && release.previousDigest === null) fail("invalid_lineage", "successor revision requires a previous digest", "/previousDigest");
  if (release.revision === 1 && release.parent !== null) fail("invalid_lineage", "initial revision cannot declare a parent release", "/parent");
  if (release.revision > 1 && release.parent === null) fail("invalid_lineage", "successor revision requires a parent release", "/parent");
  if (release.parent !== null && release.parent.digest !== release.previousDigest) fail("invalid_lineage", "parent and revision lineage digests must agree", "/parent/digest");
  if (release.parent === null && release.changelog.some((entry) => entry.kind !== "initial")) fail("invalid_lineage", "an initial release may contain only initial changelog entries", "/changelog/0/kind");
  if (release.parent !== null && release.changelog.some((entry) => entry.kind === "initial")) fail("invalid_lineage", "a successor release cannot contain an initial changelog entry", "/changelog/0/kind");
  validateReferences(release);
  return release;
}

export const validateCorpusRelease = createVersionDispatcher({
  contractKind: CONTRACT_KIND,
  versions: { 1: validateV1 },
});

export function corpusReleaseIdentityMaterial(release) {
  const material = { ...release };
  delete material.releaseId;
  delete material.revision;
  delete material.previousDigest;
  delete material.state;
  delete material.digest;
  return material;
}

function corpusReleaseRevisionMaterial(release) {
  const material = { ...release };
  delete material.revision;
  delete material.previousDigest;
  delete material.digest;
  return material;
}

export function deriveCorpusReleaseId(release) {
  return `corpus:${deriveIdentity(release, corpusReleaseIdentityMaterial, options()).slice("sha256:".length)}`;
}

export function deriveCorpusReleaseDigest(release) {
  return canonicalDigest(corpusReleaseRevisionMaterial(release), options());
}

export function verifyCorpusReleaseIdentity(release) {
  if (release.releaseId !== deriveCorpusReleaseId(release)) fail("invalid_lineage", "release identity does not match semantic material", "/releaseId");
  return release;
}

export function verifyCorpusReleaseDigest(release) {
  if (release.digest !== deriveCorpusReleaseDigest(release)) fail("revision_digest_mismatch", "release digest does not match record material", "/digest");
  return release;
}

export function sealCorpusRelease(release) {
  validateCorpusRelease(release);
  verifyCorpusReleaseIdentity(release);
  verifyCorpusReleaseDigest(release);
  return sealRecord(release, options());
}

export function createCorpusRelease(material) {
  const candidate = structuredClone(material);
  candidate.schemaVersion ??= 1;
  candidate.revision ??= 1;
  candidate.parent ??= null;
  candidate.previousDigest ??= null;
  candidate.state ??= "draft";
  candidate.releaseId = deriveCorpusReleaseId(candidate);
  candidate.digest = deriveCorpusReleaseDigest(candidate);
  return sealCorpusRelease(candidate);
}

export function reviseCorpusRelease(previous, changes) {
  sealCorpusRelease(previous);
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) fail("invalid_revision", "release changes must be an object", "");
  if (!Object.hasOwn(changes, "version")) fail("required_field", "a successor release requires a semantic version", "/version");
  if (!isSemanticVersion(changes.version)) fail("invalid_format", "semantic version is invalid", "/version");
  if (compareSemanticVersions(changes.version, previous.version) <= 0) fail("invalid_revision", "successor semantic version must increase", "/version");
  const update = {
    ...structuredClone(changes),
    parent: { releaseId: previous.releaseId, version: previous.version, digest: previous.digest },
    state: "draft",
  };
  const identityCandidate = { ...structuredClone(previous), ...update };
  update.releaseId = deriveCorpusReleaseId(identityCandidate);
  const revised = reviseRecord(previous, update, {
    identityProjection: corpusReleaseIdentityMaterial,
    contractKind: CONTRACT_KIND,
    schemaVersion: 1,
  });
  const sealed = sealCorpusRelease(revised);
  validateSuccessorTaskAudit(previous, sealed);
  return sealed;
}

export function verifyCorpusReleaseLineage(previous, next) {
  sealCorpusRelease(previous);
  sealCorpusRelease(next);
  verifyRevision(previous, next, {
    identityProjection: corpusReleaseIdentityMaterial,
    contractKind: CONTRACT_KIND,
    schemaVersion: 1,
  });
  if (next.parent.releaseId !== previous.releaseId) fail("invalid_lineage", "parent release identity does not match predecessor", "/parent/releaseId");
  if (next.parent.version !== previous.version) fail("invalid_lineage", "parent version does not match predecessor", "/parent/version");
  if (next.parent.digest !== previous.digest) fail("invalid_lineage", "parent digest does not match predecessor", "/parent/digest");
  if (compareSemanticVersions(next.version, previous.version) <= 0) fail("invalid_revision", "successor semantic version must increase", "/version");
  validateSuccessorTaskAudit(previous, next);
  return next;
}

const releaseLifecycle = createLifecycle({
  contractKind: CONTRACT_KIND,
  transitions: {
    draft: ["reviewed", "invalidated"],
    reviewed: ["sealed", "invalidated"],
    sealed: ["published", "invalidated"],
    published: ["superseded", "invalidated"],
  },
  terminalStates: ["superseded", "invalidated"],
});

export function transitionCorpusRelease(release, nextState) {
  sealCorpusRelease(release);
  const transitioned = releaseLifecycle(release, nextState, options());
  const candidate = { ...transitioned };
  candidate.digest = deriveCorpusReleaseDigest(candidate);
  return sealCorpusRelease(candidate);
}

export function parseCorpusRelease(bytes) {
  return sealCorpusRelease(parseCanonicalJsonV1(bytes, options()));
}

export function canonicalCorpusReleaseBytes(release) {
  return canonicalBytes(sealCorpusRelease(release), options());
}
