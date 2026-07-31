import {
  appendJsonPointer,
  canonicalize,
  parseCanonicalJsonV1,
} from "./canonical-json.mjs";
import { contractFailure } from "./errors.mjs";
import { canonicalDigest, deriveIdentity } from "./identity.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { reviseRecord, sealRecord, verifyRevision } from "./revision.mjs";
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

export const RUNTIME_LOCK_SCHEMA_VERSION = 1;
export const RUNTIME_LOCK_MIGRATION_VERSION = 1;
export const RUNTIME_LOCK_STATES_V1 = Object.freeze([
  "draft",
  "reviewed",
  "sealed",
  "active",
  "superseded",
  "revoked",
  "invalidated",
]);
export const RUNTIME_LOCK_LIFECYCLE_STATES_V1 = RUNTIME_LOCK_STATES_V1;

const KIND = "RuntimeLock";
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const RUNTIME_ID = /^runtime:[0-9a-f]{64}$/u;
const PROFILE_ID = /^profile:[0-9a-f]{64}$/u;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*-20[0-9]{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/u;
const TIMEZONE = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/u;
const URI = /^(?:https:\/\/|ssh:\/\/|git\+https:\/\/|urn:)[^\s]+$/u;
const HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const SIGNER = /^[a-z][a-z0-9]*(?:[._:@-][a-z0-9]+)*$/u;

function ctx(path = "") {
  return { path, contractKind: KIND, schemaVersion: 1 };
}

function fail(code, message, path) {
  contractFailure(code, message, ctx(path));
}

function field(path, name) {
  return appendJsonPointer(path, name);
}

function closed(value, fields, path) {
  assertClosedObject(value, fields, ctx(path));
  assertRequired(value, fields, ctx(path));
  return value;
}

function string(value, path, settings = {}) {
  return assertString(value, {
    minLength: 1,
    maxLength: 256,
    ...settings,
    ...ctx(path),
  });
}

function exactVersion(value, path) {
  string(value, path, { maxLength: 128, pattern: SEMVER });
}

function commit(value, path) {
  string(value, path, { maxLength: 64, pattern: COMMIT });
}

function boolean(value, path) {
  if (typeof value !== "boolean") fail("invalid_type", "value must be a boolean", path);
}

function sortedUnique(values, identity, path) {
  assertUniqueIdentities(values, identity, ctx(path));
  for (let index = 1; index < values.length; index += 1) {
    if (identity(values[index - 1]) >= identity(values[index])) {
      fail("invalid_format", "collection must be strictly ordered by identity", field(path, index));
    }
  }
}

function validateContract(value, path) {
  closed(value, [
    "kind", "version", "migrationVersion", "canonicalization",
  ], path);
  assertEnum(value.kind, [KIND], ctx(field(path, "kind")));
  assertEnum(value.version, ["1.0.0"], ctx(field(path, "version")));
  assertInteger(value.migrationVersion, {
    minimum: RUNTIME_LOCK_MIGRATION_VERSION,
    maximum: RUNTIME_LOCK_MIGRATION_VERSION,
    ...ctx(field(path, "migrationVersion")),
  });
  assertEnum(value.canonicalization, ["canonical-json-v1"], ctx(field(path, "canonicalization")));
}

function validatePlatform(value, path) {
  closed(value, [
    "os", "architecture", "imageDigest", "libc", "locale", "timezone", "filesystem",
  ], path);
  assertEnum(value.os, ["linux", "macos", "windows"], ctx(field(path, "os")));
  assertEnum(value.architecture, ["x64", "arm64"], ctx(field(path, "architecture")));
  assertDigest(value.imageDigest, ctx(field(path, "imageDigest")));
  assertEnum(value.libc, ["glibc", "musl", "none"], ctx(field(path, "libc")));
  string(value.locale, field(path, "locale"), { maxLength: 32, pattern: LOCALE });
  string(value.timezone, field(path, "timezone"), { maxLength: 128, pattern: TIMEZONE });
  const fsPath = field(path, "filesystem");
  closed(value.filesystem, [
    "caseSensitivity", "pathSeparator", "unicodeNormalization",
    "symlinkBehavior", "timestampResolutionNanoseconds",
  ], fsPath);
  assertEnum(value.filesystem.caseSensitivity, ["sensitive", "insensitive"], ctx(field(fsPath, "caseSensitivity")));
  assertEnum(value.filesystem.pathSeparator, ["slash", "backslash"], ctx(field(fsPath, "pathSeparator")));
  assertEnum(value.filesystem.unicodeNormalization, ["none", "nfc", "nfd"], ctx(field(fsPath, "unicodeNormalization")));
  assertEnum(value.filesystem.symlinkBehavior, ["native", "emulated", "unsupported"], ctx(field(fsPath, "symlinkBehavior")));
  assertInteger(value.filesystem.timestampResolutionNanoseconds, {
    minimum: 1,
    maximum: 1_000_000_000,
    ...ctx(field(fsPath, "timestampResolutionNanoseconds")),
  });
}

function validateSource(value, path) {
  closed(value, ["repository", "commit", "treeDigest", "dirty", "submodules"], path);
  string(value.repository, field(path, "repository"), { maxLength: 2048, pattern: URI });
  commit(value.commit, field(path, "commit"));
  assertDigest(value.treeDigest, ctx(field(path, "treeDigest")));
  boolean(value.dirty, field(path, "dirty"));
  if (value.dirty) fail("invalid_format", "runtime source must be an immutable clean tree", field(path, "dirty"));
  const submodulesPath = field(path, "submodules");
  assertArray(value.submodules, { minItems: 0, maxItems: 256, ...ctx(submodulesPath) });
  value.submodules.forEach((entry, index) => {
    const itemPath = field(submodulesPath, index);
    closed(entry, ["path", "repository", "commit", "treeDigest"], itemPath);
    string(entry.path, field(itemPath, "path"), { maxLength: 1024, pattern: /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/u });
    string(entry.repository, field(itemPath, "repository"), { maxLength: 2048, pattern: URI });
    commit(entry.commit, field(itemPath, "commit"));
    assertDigest(entry.treeDigest, ctx(field(itemPath, "treeDigest")));
  });
  sortedUnique(value.submodules, (entry) => entry.path, submodulesPath);
}

function validateToolchain(value, path) {
  closed(value, [
    "nodeVersion", "nodeDigest", "npmVersion", "lockfileDigest",
    "builder", "sbom", "dependencies",
  ], path);
  exactVersion(value.nodeVersion, field(path, "nodeVersion"));
  assertDigest(value.nodeDigest, ctx(field(path, "nodeDigest")));
  exactVersion(value.npmVersion, field(path, "npmVersion"));
  assertDigest(value.lockfileDigest, ctx(field(path, "lockfileDigest")));
  const builderPath = field(path, "builder");
  closed(value.builder, ["id", "version", "digest"], builderPath);
  string(value.builder.id, field(builderPath, "id"), { maxLength: 128, pattern: ID });
  exactVersion(value.builder.version, field(builderPath, "version"));
  assertDigest(value.builder.digest, ctx(field(builderPath, "digest")));
  const sbomPath = field(path, "sbom");
  closed(value.sbom, ["format", "version", "digest"], sbomPath);
  assertEnum(value.sbom.format, ["cyclonedx-json", "spdx-json"], ctx(field(sbomPath, "format")));
  assertEnum(value.sbom.version, ["1.5", "1.6", "2.3"], ctx(field(sbomPath, "version")));
  assertDigest(value.sbom.digest, ctx(field(sbomPath, "digest")));
  const dependenciesPath = field(path, "dependencies");
  assertArray(value.dependencies, { minItems: 0, maxItems: 4096, ...ctx(dependenciesPath) });
  value.dependencies.forEach((dependency, index) => {
    const itemPath = field(dependenciesPath, index);
    closed(dependency, ["name", "version", "digest"], itemPath);
    string(dependency.name, field(itemPath, "name"), { maxLength: 214, pattern: PACKAGE });
    exactVersion(dependency.version, field(itemPath, "version"));
    assertDigest(dependency.digest, ctx(field(itemPath, "digest")));
  });
  sortedUnique(value.dependencies, (dependency) => `${dependency.name}@${dependency.version}`, dependenciesPath);
}

function validateCodex(value, path) {
  closed(value, [
    "product", "version", "commit", "artifactDigest", "appServerSchemaDigest",
    "compatibilityReleaseId", "modelId", "profileId", "protocolFixture",
  ], path);
  assertEnum(value.product, ["cli", "desktop"], ctx(field(path, "product")));
  exactVersion(value.version, field(path, "version"));
  commit(value.commit, field(path, "commit"));
  assertDigest(value.artifactDigest, ctx(field(path, "artifactDigest")));
  assertDigest(value.appServerSchemaDigest, ctx(field(path, "appServerSchemaDigest")));
  string(value.compatibilityReleaseId, field(path, "compatibilityReleaseId"), {
    maxLength: 140,
    pattern: /^codex@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u,
  });
  if (value.compatibilityReleaseId !== `codex@${value.version}`) {
    fail("invalid_lineage", "compatibility release must match the exact Codex version", field(path, "compatibilityReleaseId"));
  }
  string(value.modelId, field(path, "modelId"), { maxLength: 128, pattern: MODEL_ID });
  string(value.profileId, field(path, "profileId"), { minLength: 72, maxLength: 72, pattern: PROFILE_ID });
  const fixturePath = field(path, "protocolFixture");
  closed(value.protocolFixture, ["version", "digest"], fixturePath);
  exactVersion(value.protocolFixture.version, field(fixturePath, "version"));
  assertDigest(value.protocolFixture.digest, ctx(field(fixturePath, "digest")));
}

function validatePlugin(plugin, path) {
  if (plugin === null) return;
  closed(plugin, [
    "id", "version", "sourceCommit", "packageDigest", "manifestDigest",
    "skillDigests", "dependencies",
  ], path);
  string(plugin.id, field(path, "id"), { maxLength: 128, pattern: ID });
  exactVersion(plugin.version, field(path, "version"));
  commit(plugin.sourceCommit, field(path, "sourceCommit"));
  assertDigest(plugin.packageDigest, ctx(field(path, "packageDigest")));
  assertDigest(plugin.manifestDigest, ctx(field(path, "manifestDigest")));
  const skillsPath = field(path, "skillDigests");
  assertArray(plugin.skillDigests, { minItems: 0, maxItems: 256, ...ctx(skillsPath) });
  plugin.skillDigests.forEach((digest, index) => assertDigest(digest, ctx(field(skillsPath, index))));
  sortedUnique(plugin.skillDigests, (digest) => digest, skillsPath);

  const values = plugin.dependencies;
  const dependenciesPath = field(path, "dependencies");
  assertArray(values, { minItems: 0, maxItems: 1024, ...ctx(dependenciesPath) });
  values.forEach((dependency, index) => {
    const itemPath = field(dependenciesPath, index);
    closed(dependency, ["id", "version", "digest", "dependencies"], itemPath);
    string(dependency.id, field(itemPath, "id"), { maxLength: 214, pattern: PACKAGE });
    exactVersion(dependency.version, field(itemPath, "version"));
    assertDigest(dependency.digest, ctx(field(itemPath, "digest")));
    const edgesPath = field(itemPath, "dependencies");
    assertArray(dependency.dependencies, { minItems: 0, maxItems: 256, ...ctx(edgesPath) });
    dependency.dependencies.forEach((edge, edgeIndex) => {
      string(edge, field(edgesPath, edgeIndex), { maxLength: 214, pattern: PACKAGE });
      if (edge === dependency.id) fail("invalid_lineage", "plugin dependency cannot depend on itself", field(edgesPath, edgeIndex));
    });
    sortedUnique(dependency.dependencies, (edge) => edge, edgesPath);
  });
  sortedUnique(values, (dependency) => dependency.id, dependenciesPath);
  const byId = new Map(values.map((dependency) => [dependency.id, dependency]));
  values.forEach((dependency, index) => dependency.dependencies.forEach((edge, dependencyIndex) => {
    if (!byId.has(edge)) {
      fail("invalid_lineage", "plugin dependency must reference a locked dependency", `${dependenciesPath}/${index}/dependencies/${dependencyIndex}`);
    }
  }));
  const visiting = new Set();
  const visited = new Set();
  function visit(id, indexById) {
    if (visiting.has(id)) fail("invalid_lineage", "plugin dependency graph must be acyclic", `${dependenciesPath}/${indexById.get(id)}/dependencies`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency, indexById);
    visiting.delete(id);
    visited.add(id);
  }
  const indexById = new Map(values.map((dependency, index) => [dependency.id, index]));
  for (const dependency of values) visit(dependency.id, indexById);
}

function validatePermissions(value, path) {
  closed(value, ["sandbox", "filesystem", "network", "subprocess", "systemClock"], path);
  const sandboxPath = field(path, "sandbox");
  closed(value.sandbox, ["policy", "approvalPolicy"], sandboxPath);
  assertEnum(value.sandbox.policy, ["read-only", "workspace-write", "danger-full-access"], ctx(field(sandboxPath, "policy")));
  assertEnum(value.sandbox.approvalPolicy, ["never", "on-request", "on-failure", "untrusted"], ctx(field(sandboxPath, "approvalPolicy")));
  const filesystemPath = field(path, "filesystem");
  closed(value.filesystem, ["readRoots", "writeRoots", "followSymlinks"], filesystemPath);
  for (const name of ["readRoots", "writeRoots"]) {
    const rootsPath = field(filesystemPath, name);
    assertArray(value.filesystem[name], { minItems: 0, maxItems: 128, ...ctx(rootsPath) });
    value.filesystem[name].forEach((root, index) => string(root, field(rootsPath, index), {
      maxLength: 1024,
      pattern: /^(?:\/|[A-Za-z]:\\)[^\0]*$/u,
    }));
    sortedUnique(value.filesystem[name], (root) => root, rootsPath);
  }
  boolean(value.filesystem.followSymlinks, field(filesystemPath, "followSymlinks"));
  const networkPath = field(path, "network");
  closed(value.network, ["mode", "allowHosts"], networkPath);
  assertEnum(value.network.mode, ["none", "allowlist", "unrestricted"], ctx(field(networkPath, "mode")));
  const hostsPath = field(networkPath, "allowHosts");
  const minimum = value.network.mode === "allowlist" ? 1 : 0;
  const maximum = value.network.mode === "allowlist" ? 256 : 0;
  assertArray(value.network.allowHosts, { minItems: minimum, maxItems: maximum, ...ctx(hostsPath) });
  value.network.allowHosts.forEach((host, index) => string(host, field(hostsPath, index), { maxLength: 253, pattern: HOST }));
  sortedUnique(value.network.allowHosts, (host) => host, hostsPath);
  boolean(value.subprocess, field(path, "subprocess"));
  boolean(value.systemClock, field(path, "systemClock"));
  if (value.sandbox.policy === "read-only" && value.filesystem.writeRoots.length !== 0) {
    fail("invalid_format", "read-only sandbox cannot declare writable roots", field(filesystemPath, "writeRoots"));
  }
}

function validateSignatures(values, path) {
  assertArray(values, { minItems: 1, maxItems: 32, ...ctx(path) });
  values.forEach((signature, index) => {
    const itemPath = field(path, index);
    closed(signature, ["signerId", "algorithm", "keyDigest", "signatureDigest"], itemPath);
    string(signature.signerId, field(itemPath, "signerId"), { maxLength: 128, pattern: SIGNER });
    assertEnum(signature.algorithm, ["ed25519", "ecdsa-p256", "rsa-pss-sha256", "sigstore-bundle-v0.3"], ctx(field(itemPath, "algorithm")));
    assertDigest(signature.keyDigest, ctx(field(itemPath, "keyDigest")));
    assertDigest(signature.signatureDigest, ctx(field(itemPath, "signatureDigest")));
  });
  sortedUnique(values, (signature) => `${signature.signerId}:${signature.keyDigest}`, path);
}

const TOP_LEVEL_FIELDS = Object.freeze([
  "schemaVersion", "migrationVersion", "runtimeId", "revision", "runtimeClass",
  "previousDigest", "state", "contract", "platform", "source",
  "toolchain", "codex", "plugin", "permissions", "permissionsDigest",
  "contractDigest", "signatures", "lockDigest",
]);

function validateV1(lock) {
  closed(lock, TOP_LEVEL_FIELDS, "");
  assertInteger(lock.schemaVersion, { minimum: 1, maximum: 1, ...ctx("/schemaVersion") });
  assertInteger(lock.migrationVersion, {
    minimum: RUNTIME_LOCK_MIGRATION_VERSION,
    maximum: RUNTIME_LOCK_MIGRATION_VERSION,
    ...ctx("/migrationVersion"),
  });
  string(lock.runtimeId, "/runtimeId", { minLength: 72, maxLength: 72, pattern: RUNTIME_ID });
  assertInteger(lock.revision, { minimum: 1, maximum: 1_000_000, ...ctx("/revision") });
  assertEnum(lock.runtimeClass, ["headless-oci", "desktop-macos"], ctx("/runtimeClass"));
  if (lock.previousDigest !== null) assertDigest(lock.previousDigest, ctx("/previousDigest"));
  if (lock.revision === 1 && lock.previousDigest !== null) fail("invalid_lineage", "initial lock cannot have a previous digest", "/previousDigest");
  if (lock.revision > 1 && lock.previousDigest === null) fail("invalid_lineage", "successor lock requires a previous digest", "/previousDigest");
  assertEnum(lock.state, RUNTIME_LOCK_STATES_V1, ctx("/state"));
  validateContract(lock.contract, "/contract");
  if (lock.contract.migrationVersion !== lock.migrationVersion) fail("invalid_lineage", "contract and lock migration versions must agree", "/contract/migrationVersion");
  validatePlatform(lock.platform, "/platform");
  if (lock.runtimeClass === "headless-oci" && lock.platform.os !== "linux") fail("invalid_format", "headless OCI runtime requires Linux", "/platform/os");
  if (lock.runtimeClass === "desktop-macos" && lock.platform.os !== "macos") fail("invalid_format", "Desktop runtime requires macOS", "/platform/os");
  validateSource(lock.source, "/source");
  validateToolchain(lock.toolchain, "/toolchain");
  validateCodex(lock.codex, "/codex");
  if ((lock.runtimeClass === "desktop-macos") !== (lock.codex.product === "desktop")) fail("invalid_format", "Codex product must match the runtime class", "/codex/product");
  validatePlugin(lock.plugin, "/plugin");
  validatePermissions(lock.permissions, "/permissions");
  assertDigest(lock.permissionsDigest, ctx("/permissionsDigest"));
  if (lock.permissionsDigest !== canonicalDigest(lock.permissions, ctx("/permissions"))) {
    fail("invalid_digest", "permissions digest does not bind the closed permissions", "/permissionsDigest");
  }
  assertDigest(lock.contractDigest, ctx("/contractDigest"));
  if (lock.contractDigest !== canonicalDigest(lock.contract, ctx("/contract"))) {
    fail("invalid_digest", "contract digest does not bind the closed contract", "/contractDigest");
  }
  validateSignatures(lock.signatures, "/signatures");
  assertDigest(lock.lockDigest, ctx("/lockDigest"));
  return lock;
}

const dispatchRuntimeLock = createVersionDispatcher({
  contractKind: KIND,
  versions: { 1: validateV1 },
});

/** All admission and immutable provenance fields; lifecycle and lineage are excluded. */
export function runtimeLockIdentityProjection(lock) {
  const {
    schemaVersion, migrationVersion, runtimeClass, contract, contractDigest,
    platform, source, toolchain, codex, plugin, permissions, permissionsDigest,
    signatures,
  } = lock;
  return {
    schemaVersion, migrationVersion, runtimeClass, contract, contractDigest,
    platform, source, toolchain, codex, plugin, permissions, permissionsDigest,
    signatures,
  };
}

export function deriveRuntimeIdentity(lock) {
  return `runtime:${deriveIdentity(lock, runtimeLockIdentityProjection, ctx()).slice("sha256:".length)}`;
}

export const deriveRuntimeLockIdentity = deriveRuntimeIdentity;

export function verifyRuntimeIdentity(lock) {
  const expected = deriveRuntimeIdentity(lock);
  if (lock.runtimeId !== expected) fail("invalid_digest", "runtime identity does not match its complete projection", "/runtimeId");
  return lock;
}

export const verifyRuntimeLockIdentity = verifyRuntimeIdentity;

/**
 * Lock digest material excludes lockDigest itself and revision lineage only.
 * Thus no placeholder or fixed-point digest is used; runtimeId and state remain bound.
 */
export function runtimeLockDigestProjection(lock) {
  const material = { ...lock };
  delete material.revision;
  delete material.previousDigest;
  delete material.lockDigest;
  return material;
}

export function deriveRuntimeLockDigest(lock) {
  return canonicalDigest(runtimeLockDigestProjection(lock), ctx());
}

export function verifyRuntimeLockDigest(lock) {
  if (lock.lockDigest !== deriveRuntimeLockDigest(lock)) {
    fail("revision_digest_mismatch", "runtime lock digest does not match its projection", "/lockDigest");
  }
  return lock;
}

export function validateRuntimeLock(lock) {
  dispatchRuntimeLock(lock);
  verifyRuntimeIdentity(lock);
  verifyRuntimeLockDigest(lock);
  return lock;
}

export function canonicalizeRuntimeLock(lock) {
  validateRuntimeLock(lock);
  return canonicalize(lock, ctx());
}

export function parseCanonicalRuntimeLock(bytes) {
  return sealRuntimeLock(parseCanonicalJsonV1(bytes, ctx()));
}

export function sealRuntimeLock(lock) {
  validateRuntimeLock(lock);
  return sealRecord(lock, ctx());
}

export function reviseRuntimeLock(previous, update) {
  validateRuntimeLock(previous);
  if (!Object.isFrozen(previous)) fail("record_not_sealed", "prior RuntimeLock must be sealed", "");
  const changes = typeof update === "function" ? update(structuredClone(previous)) : update;
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    fail("invalid_revision", "RuntimeLock revision update must be an object", "");
  }
  for (const name of [
    "schemaVersion", "migrationVersion", "runtimeId", "revision",
    "previousDigest", "state", "lockDigest",
  ]) {
    if (Object.hasOwn(changes, name)) fail("unknown_field", "revision field is managed by the RuntimeLock contract", `/${name}`);
  }
  const preview = { ...structuredClone(previous), ...structuredClone(changes) };
  preview.runtimeId = deriveRuntimeIdentity(preview);
  const next = reviseRecord(previous, { ...changes, runtimeId: preview.runtimeId }, {
    revisionField: "revision",
    digestField: "lockDigest",
    previousDigestField: "previousDigest",
    identityProjection: runtimeLockIdentityProjection,
    contractKind: KIND,
    schemaVersion: 1,
  });
  return sealRuntimeLock(next);
}

export function verifyRuntimeLockRevision(previous, next) {
  validateRuntimeLock(previous);
  validateRuntimeLock(next);
  verifyRevision(previous, next, {
    revisionField: "revision",
    digestField: "lockDigest",
    previousDigestField: "previousDigest",
    identityProjection: runtimeLockIdentityProjection,
    contractKind: KIND,
    schemaVersion: 1,
  });
  return next;
}

const transitionRuntimeLockRecord = createLifecycle({
  contractKind: KIND,
  transitions: {
    draft: ["reviewed", "invalidated"],
    reviewed: ["sealed", "invalidated"],
    sealed: ["active", "invalidated"],
    active: ["superseded", "revoked"],
  },
  terminalStates: ["superseded", "revoked", "invalidated"],
});

export function transitionRuntimeLock(lock, nextState) {
  const sealed = sealRuntimeLock(lock);
  const transitioned = transitionRuntimeLockRecord(sealed, nextState, ctx());
  const candidate = { ...structuredClone(transitioned) };
  candidate.lockDigest = deriveRuntimeLockDigest(candidate);
  return sealRuntimeLock(candidate);
}
