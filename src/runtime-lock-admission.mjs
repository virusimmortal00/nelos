import {
  canonicalDigest,
  sealRecord,
  validateRuntimeLock,
  verifyRuntimeLockDigest,
  verifyRuntimeLockIdentity,
  verifyRuntimeLockRevision,
} from "./experimentation-contract/index.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const ABSOLUTE_PATH = /^\/(?:[^/\0]+\/)*[^/\0]+$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const RUNTIME_ADMISSION_SCHEMA_VERSION = 1;
export const RUNTIME_CANDIDATE_ARMS = Object.freeze([
  "baseline",
  "plugin-a",
  "plugin-b",
]);

export class RuntimeLockAdmissionError extends Error {
  constructor(code, message, path = "", options = {}) {
    super(message, options);
    this.name = "RuntimeLockAdmissionError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "") {
  throw new RuntimeLockAdmissionError(code, message, path);
}

function record(value, fields, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CONTRACT", "expected an object", path);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail("INVALID_CONTRACT", "object fields do not match the closed contract", path);
  }
  return value;
}

function string(value, path, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("INVALID_CONTRACT", "invalid string identity", path);
  }
  return value;
}

function digest(value, path) {
  return string(value, path, SHA256);
}

function boolean(value, path) {
  if (typeof value !== "boolean") fail("INVALID_CONTRACT", "expected a boolean", path);
  return value;
}

function array(value, path, maximum = 4_096) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("INVALID_CONTRACT", "expected a bounded array", path);
  }
  return value;
}

function same(left, right) {
  return canonicalDigest(left) === canonicalDigest(right);
}

function isDeeplyFrozenData(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
    if (!isDeeplyFrozenData(descriptor.value, seen)) return false;
  }
  return true;
}

function validatePolicy(policy) {
  record(policy, [
    "schemaVersion",
    "supportedCodexBuilds",
    "trustedSignerKeyDigests",
  ], "/policy");
  if (policy.schemaVersion !== RUNTIME_ADMISSION_SCHEMA_VERSION) {
    fail("INVALID_CONTRACT", "unsupported admission policy schema", "/policy/schemaVersion");
  }
  array(policy.supportedCodexBuilds, "/policy/supportedCodexBuilds", 256);
  if (policy.supportedCodexBuilds.length === 0) {
    fail("INVALID_CONTRACT", "at least one exact Codex build is required", "/policy/supportedCodexBuilds");
  }
  for (const [index, build] of policy.supportedCodexBuilds.entries()) {
    record(build, [
      "appServerSchemaDigest",
      "artifactDigest",
      "commit",
      "product",
      "protocolFixtureDigest",
      "version",
    ], `/policy/supportedCodexBuilds/${index}`);
    if (!["cli", "desktop"].includes(build.product)) {
      fail("INVALID_CONTRACT", "unsupported Codex product", `/policy/supportedCodexBuilds/${index}/product`);
    }
    string(build.version, `/policy/supportedCodexBuilds/${index}/version`, VERSION);
    string(build.commit, `/policy/supportedCodexBuilds/${index}/commit`, COMMIT);
    for (const field of ["artifactDigest", "appServerSchemaDigest", "protocolFixtureDigest"]) {
      digest(build[field], `/policy/supportedCodexBuilds/${index}/${field}`);
    }
  }
  array(policy.trustedSignerKeyDigests, "/policy/trustedSignerKeyDigests", 64);
  if (policy.trustedSignerKeyDigests.length === 0) {
    fail("INVALID_CONTRACT", "at least one trusted signer is required", "/policy/trustedSignerKeyDigests");
  }
  const trusted = new Set();
  for (const [index, keyDigest] of policy.trustedSignerKeyDigests.entries()) {
    digest(keyDigest, `/policy/trustedSignerKeyDigests/${index}`);
    if (trusted.has(keyDigest)) {
      fail("INVALID_CONTRACT", "trusted signer identities must be unique", `/policy/trustedSignerKeyDigests/${index}`);
    }
    trusted.add(keyDigest);
  }
  return policy;
}

function validatePluginCopy(copy, path) {
  record(copy, [
    "dependencies",
    "id",
    "locationId",
    "manifestDigest",
    "packageDigest",
    "skillDigests",
    "sourceCommit",
    "version",
  ], path);
  string(copy.locationId, `${path}/locationId`);
  string(copy.id, `${path}/id`);
  string(copy.version, `${path}/version`, VERSION);
  string(copy.sourceCommit, `${path}/sourceCommit`, COMMIT);
  digest(copy.packageDigest, `${path}/packageDigest`);
  digest(copy.manifestDigest, `${path}/manifestDigest`);
  array(copy.skillDigests, `${path}/skillDigests`, 256);
  copy.skillDigests.forEach((value, index) => digest(value, `${path}/skillDigests/${index}`));
  array(copy.dependencies, `${path}/dependencies`, 1_024);
  return copy;
}

function pluginMaterial(copy) {
  const { locationId: _locationId, ...material } = copy;
  return material;
}

function validateObservation(observation) {
  record(observation, [
    "attachments",
    "codex",
    "contractDigest",
    "permissionsDigest",
    "phase",
    "platform",
    "pluginCopies",
    "pluginReference",
    "schemaVersion",
    "source",
    "sourceReference",
    "toolchain",
  ], "/observation");
  if (observation.schemaVersion !== RUNTIME_ADMISSION_SCHEMA_VERSION) {
    fail("INVALID_CONTRACT", "unsupported observation schema", "/observation/schemaVersion");
  }
  if (observation.phase !== "pre-attachment") {
    fail("ATTACHMENT_ALREADY_PRESENT", "admission requires a pre-attachment observation", "/observation/phase");
  }
  record(observation.attachments, ["secrets", "workspace"], "/observation/attachments");
  if (
    boolean(observation.attachments.secrets, "/observation/attachments/secrets") ||
    boolean(observation.attachments.workspace, "/observation/attachments/workspace")
  ) {
    fail("ATTACHMENT_ALREADY_PRESENT", "secrets and writable workspaces must not be attached before admission", "/observation/attachments");
  }
  record(observation.sourceReference, ["kind", "value"], "/observation/sourceReference");
  if (observation.sourceReference.kind !== "commit") {
    fail("MUTABLE_REFERENCE", "source admission requires an exact commit reference", "/observation/sourceReference/kind");
  }
  string(observation.sourceReference.value, "/observation/sourceReference/value", COMMIT);
  record(observation.pluginReference, ["kind", "value"], "/observation/pluginReference");
  if (!["commit", "none"].includes(observation.pluginReference.kind)) {
    fail("MUTABLE_REFERENCE", "plugin admission rejects branches, channels, and floating tags", "/observation/pluginReference/kind");
  }
  if (observation.pluginReference.kind === "commit") {
    string(observation.pluginReference.value, "/observation/pluginReference/value", COMMIT);
  } else if (observation.pluginReference.value !== null) {
    fail("INVALID_CONTRACT", "baseline plugin reference must be null", "/observation/pluginReference/value");
  }
  digest(observation.permissionsDigest, "/observation/permissionsDigest");
  digest(observation.contractDigest, "/observation/contractDigest");
  array(observation.pluginCopies, "/observation/pluginCopies", 16);
  observation.pluginCopies.forEach((copy, index) =>
    validatePluginCopy(copy, `/observation/pluginCopies/${index}`)
  );
  return observation;
}

function expectedCodexBuild(codex) {
  return {
    appServerSchemaDigest: codex.appServerSchemaDigest,
    artifactDigest: codex.artifactDigest,
    commit: codex.commit,
    product: codex.product,
    protocolFixtureDigest: codex.protocolFixture.digest,
    version: codex.version,
  };
}

function verifyObservedInventory(runtimeLock, observation, policy) {
  if (observation.sourceReference.value !== runtimeLock.source.commit) {
    fail("IDENTITY_MISMATCH", "observed source reference differs from the lock", "/observation/sourceReference/value");
  }
  for (const [field, observed, expected] of [
    ["source", observation.source, runtimeLock.source],
    ["platform", observation.platform, runtimeLock.platform],
    ["toolchain", observation.toolchain, runtimeLock.toolchain],
    ["codex", observation.codex, runtimeLock.codex],
  ]) {
    if (!same(observed, expected)) {
      fail("IDENTITY_MISMATCH", `observed ${field} differs from the lock`, `/observation/${field}`);
    }
  }
  if (observation.permissionsDigest !== runtimeLock.permissionsDigest) {
    fail("IDENTITY_MISMATCH", "observed permissions digest differs from the lock", "/observation/permissionsDigest");
  }
  if (observation.contractDigest !== runtimeLock.contractDigest) {
    fail("IDENTITY_MISMATCH", "observed protocol contract differs from the lock", "/observation/contractDigest");
  }
  const codexBuild = expectedCodexBuild(runtimeLock.codex);
  if (!policy.supportedCodexBuilds.some((build) => same(build, codexBuild))) {
    fail("UNSUPPORTED_CODEX_BUILD", "the exact Codex build is not admitted by policy", "/policy/supportedCodexBuilds");
  }
  const trusted = new Set(policy.trustedSignerKeyDigests);
  for (const [index, signature] of runtimeLock.signatures.entries()) {
    if (!trusted.has(signature.keyDigest)) {
      fail("UNTRUSTED_SIGNATURE", "runtime lock signer is not trusted", `/runtimeLock/signatures/${index}/keyDigest`);
    }
  }

  if (runtimeLock.plugin === null) {
    if (observation.pluginReference.kind !== "none") {
      fail("MUTABLE_REFERENCE", "baseline arms cannot select a plugin reference", "/observation/pluginReference/kind");
    }
    if (observation.pluginCopies.length !== 0) {
      fail("DUPLICATE_PLUGIN_COPY", "baseline admission requires an empty plugin inventory", "/observation/pluginCopies");
    }
    return;
  }
  if (
    observation.pluginReference.kind !== "commit" ||
    observation.pluginReference.value !== runtimeLock.plugin.sourceCommit
  ) {
    fail("MUTABLE_REFERENCE", "plugin source must resolve to the exact locked commit", "/observation/pluginReference");
  }
  if (observation.pluginCopies.length === 0) {
    fail("MISSING_PLUGIN_COPY", "the exact locked plugin copy is missing", "/observation/pluginCopies");
  }
  if (observation.pluginCopies.length !== 1) {
    fail("DUPLICATE_PLUGIN_COPY", "exactly one plugin copy may satisfy the lock", "/observation/pluginCopies");
  }
  if (!same(pluginMaterial(observation.pluginCopies[0]), runtimeLock.plugin)) {
    fail("IDENTITY_MISMATCH", "plugin inventory differs from the exact lock", "/observation/pluginCopies/0");
  }
}

export function admitRuntimeLock({ runtimeLock, observation, policy }) {
  if (!isDeeplyFrozenData(runtimeLock)) {
    fail("RUNTIME_LOCK_MUTABLE", "runtime admission requires a recursively frozen data record", "/runtimeLock");
  }
  validateRuntimeLock(runtimeLock);
  verifyRuntimeLockIdentity(runtimeLock);
  verifyRuntimeLockDigest(runtimeLock);
  if (runtimeLock.state !== "active") {
    fail("RUNTIME_NOT_ACTIVE", "runtime admission requires an active lock", "/runtimeLock/state");
  }
  validatePolicy(policy);
  validateObservation(observation);
  verifyObservedInventory(runtimeLock, observation, policy);
  const receipt = {
    schemaVersion: RUNTIME_ADMISSION_SCHEMA_VERSION,
    kind: "runtime-admission",
    runtimeId: runtimeLock.runtimeId,
    runtimeLockDigest: runtimeLock.lockDigest,
    observationDigest: canonicalDigest(observation),
    policyDigest: canonicalDigest(policy),
  };
  return sealRecord({ ...receipt, receiptDigest: canonicalDigest(receipt) }, {
    contractKind: "RuntimeAdmissionReceipt",
    schemaVersion: 1,
  });
}

function validateHome(home, candidateId) {
  record(home, [
    "candidateId",
    "codexHome",
    "homeId",
    "pluginStateRoot",
    "workspaceRoot",
  ], "/home");
  if (home.candidateId !== candidateId) fail("HOME_NOT_FRESH", "home receipt belongs to another candidate", "/home/candidateId");
  string(home.homeId, "/home/homeId");
  for (const field of ["codexHome", "pluginStateRoot", "workspaceRoot"]) {
    string(home[field], `/home/${field}`, ABSOLUTE_PATH);
  }
  return home;
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function requireCandidateAdapter(adapter) {
  for (const method of [
    "attachCandidate",
    "buildPluginArtifact",
    "createFreshHome",
    "installPlugin",
    "observeInstalledPlugins",
  ]) {
    if (typeof adapter?.[method] !== "function") {
      fail("INVALID_ADAPTER", `missing candidate adapter method ${method}`, "/adapter");
    }
  }
}

function verifyArtifact(plugin, artifact) {
  if (!isDeeplyFrozenData(artifact)) {
    fail("ARTIFACT_MISMATCH", "built plugin artifact must be recursively immutable", "/artifact");
  }
  record(artifact, [
    "dependencies",
    "id",
    "manifestDigest",
    "packageDigest",
    "skillDigests",
    "sourceCommit",
    "version",
  ], "/artifact");
  if (!same(artifact, plugin)) {
    fail("ARTIFACT_MISMATCH", "built artifact does not match the exact plugin lock", "/artifact");
  }
  return artifact;
}

export function createRuntimeCandidateController(adapter) {
  requireCandidateAdapter(adapter);
  const builtArtifacts = new Map();
  const candidateIds = new Set();
  const writableRoots = new Set();

  return Object.freeze({
    async prepareCandidate(request) {
      record(request, [
        "arm",
        "candidateId",
        "observation",
        "policy",
        "runtimeLock",
        "schemaVersion",
        "secretRefs",
      ], "");
      if (request.schemaVersion !== RUNTIME_ADMISSION_SCHEMA_VERSION) {
        fail("INVALID_CONTRACT", "unsupported candidate request schema", "/schemaVersion");
      }
      string(request.candidateId, "/candidateId");
      if (!RUNTIME_CANDIDATE_ARMS.includes(request.arm)) {
        fail("INVALID_CONTRACT", "unknown experiment arm", "/arm");
      }
      if ((request.arm === "baseline") !== (request.runtimeLock.plugin === null)) {
        fail("ARM_LOCK_MISMATCH", "baseline and plugin arms require matching lock shapes", "/arm");
      }
      array(request.secretRefs, "/secretRefs", 32);
      request.secretRefs.forEach((secretRef, index) =>
        string(secretRef, `/secretRefs/${index}`, /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u)
      );
      if (candidateIds.has(request.candidateId)) {
        fail("HOME_NOT_FRESH", "candidate identity has already allocated writable state", "/candidateId");
      }

      const admission = admitRuntimeLock(request);
      let artifact = null;
      if (request.runtimeLock.plugin !== null) {
        const key = request.runtimeLock.plugin.packageDigest;
        artifact = builtArtifacts.get(key) ?? null;
        if (artifact === null) {
          artifact = verifyArtifact(
            request.runtimeLock.plugin,
            await adapter.buildPluginArtifact({
              plugin: request.runtimeLock.plugin,
              runtimeLockDigest: request.runtimeLock.lockDigest,
              sourceCommit: request.runtimeLock.plugin.sourceCommit,
            }),
          );
          builtArtifacts.set(key, artifact);
        }
      }

      const home = validateHome(await adapter.createFreshHome({
        arm: request.arm,
        candidateId: request.candidateId,
        runtimeLockDigest: request.runtimeLock.lockDigest,
      }), request.candidateId);
      const roots = [home.codexHome, home.pluginStateRoot, home.workspaceRoot];
      for (let left = 0; left < roots.length; left += 1) {
        for (let right = left + 1; right < roots.length; right += 1) {
          if (overlaps(roots[left], roots[right])) {
            fail("WRITABLE_STATE_SHARED", "candidate writable roots must be disjoint", "/home");
          }
        }
        for (const existing of writableRoots) {
          if (overlaps(roots[left], existing)) {
            fail("WRITABLE_STATE_SHARED", "experiment arms cannot share writable state", "/home");
          }
        }
      }
      candidateIds.add(request.candidateId);
      roots.forEach((root) => writableRoots.add(root));

      if (artifact !== null) {
        const installed = await adapter.installPlugin({ artifact, home });
        record(installed, [
          "candidateId",
          "homeId",
          "installed",
          "manifestDigest",
          "packageDigest",
        ], "/installReceipt");
        if (
          installed.candidateId !== request.candidateId ||
          installed.homeId !== home.homeId ||
          installed.installed !== true ||
          installed.packageDigest !== artifact.packageDigest ||
          installed.manifestDigest !== artifact.manifestDigest
        ) {
          fail("ARTIFACT_MISMATCH", "installation receipt differs from the built artifact", "/installReceipt");
        }
      }
      const installedCopies = await adapter.observeInstalledPlugins({ home });
      array(installedCopies, "/installedPluginCopies", 16);
      installedCopies.forEach((copy, index) =>
        validatePluginCopy(copy, `/installedPluginCopies/${index}`)
      );
      if (artifact === null && installedCopies.length !== 0) {
        fail("DUPLICATE_PLUGIN_COPY", "baseline home contains plugin state", "/installedPluginCopies");
      }
      if (artifact !== null && (
        installedCopies.length !== 1 ||
        !same(pluginMaterial(installedCopies[0]), artifact)
      )) {
        fail("ARTIFACT_MISMATCH", "fresh home did not install exactly one locked artifact", "/installedPluginCopies");
      }

      const attached = await adapter.attachCandidate({
        admission,
        arm: request.arm,
        candidateId: request.candidateId,
        home,
        secretRefs: [...request.secretRefs],
      });
      record(attached, [
        "attached",
        "candidateId",
        "homeId",
        "secretRefCount",
        "workspaceRoot",
      ], "/attachmentReceipt");
      if (
        attached.attached !== true ||
        attached.candidateId !== request.candidateId ||
        attached.homeId !== home.homeId ||
        attached.secretRefCount !== request.secretRefs.length ||
        attached.workspaceRoot !== home.workspaceRoot
      ) {
        fail("ATTACHMENT_MISMATCH", "candidate attachment receipt is not exact", "/attachmentReceipt");
      }
      const receipt = {
        schemaVersion: 1,
        kind: "runtime-candidate-prepared",
        admissionReceiptDigest: admission.receiptDigest,
        arm: request.arm,
        candidateId: request.candidateId,
        homeId: home.homeId,
        runtimeLockDigest: request.runtimeLock.lockDigest,
        pluginPackageDigest: artifact?.packageDigest ?? null,
        writableRoots: roots,
      };
      return sealRecord({ ...receipt, receiptDigest: canonicalDigest(receipt) }, {
        contractKind: "RuntimeCandidateReceipt",
        schemaVersion: 1,
      });
    },
  });
}

function validateCanary(canary, lane, lockDigest, path) {
  record(canary, ["evidenceDigest", "lane", "outcome", "runtimeLockDigest"], path);
  if (canary.lane !== lane || canary.outcome !== "passed") {
    fail("CANARY_FAILED", `a passed ${lane} canary is required`, path);
  }
  if (canary.runtimeLockDigest !== lockDigest) {
    fail("CANARY_LOCK_MISMATCH", "canary evidence names another runtime lock", `${path}/runtimeLockDigest`);
  }
  digest(canary.evidenceDigest, `${path}/evidenceDigest`);
}

function validateStateCompatibility(value, fromVersion, toVersion, path) {
  record(value, [
    "compatible",
    "evidenceDigest",
    "fromMigrationVersion",
    "persistedStateDigest",
    "toMigrationVersion",
  ], path);
  if (
    value.compatible !== true ||
    value.fromMigrationVersion !== fromVersion ||
    value.toMigrationVersion !== toVersion
  ) {
    fail("STATE_INCOMPATIBLE", "persisted-state compatibility does not match the selected locks", path);
  }
  digest(value.persistedStateDigest, `${path}/persistedStateDigest`);
  digest(value.evidenceDigest, `${path}/evidenceDigest`);
}

function validateWorkflowLock(lock, path) {
  if (!isDeeplyFrozenData(lock)) fail("RUNTIME_LOCK_MUTABLE", "workflow locks must be recursively immutable", path);
  validateRuntimeLock(lock);
  verifyRuntimeLockIdentity(lock);
  verifyRuntimeLockDigest(lock);
  if (!new Set(["active", "superseded"]).has(lock.state)) {
    fail("RUNTIME_NOT_ACTIVE", "workflow lock is not an admitted immutable release", `${path}/state`);
  }
}

export function approveRuntimeUpgrade({ currentLock, nextLock, evidence }) {
  validateWorkflowLock(currentLock, "/currentLock");
  validateWorkflowLock(nextLock, "/nextLock");
  verifyRuntimeLockRevision(currentLock, nextLock);
  record(evidence, [
    "artifactDigest",
    "desktopCanary",
    "fromLockDigest",
    "headlessCanary",
    "kind",
    "schemaVersion",
    "stateCompatibility",
    "toLockDigest",
  ], "/evidence");
  if (evidence.schemaVersion !== 1 || evidence.kind !== "upgrade") {
    fail("INVALID_CONTRACT", "upgrade evidence kind is invalid", "/evidence/kind");
  }
  if (
    evidence.fromLockDigest !== currentLock.lockDigest ||
    evidence.toLockDigest !== nextLock.lockDigest
  ) {
    fail("UPGRADE_LOCK_MISMATCH", "upgrade evidence is not bound to the selected locks", "/evidence/toLockDigest");
  }
  const expectedArtifact = nextLock.plugin?.packageDigest ?? nextLock.platform.imageDigest;
  if (evidence.artifactDigest !== expectedArtifact) {
    fail("ARTIFACT_MISMATCH", "upgrade artifact differs from the new lock", "/evidence/artifactDigest");
  }
  validateCanary(evidence.headlessCanary, "headless", nextLock.lockDigest, "/evidence/headlessCanary");
  validateCanary(evidence.desktopCanary, "desktop", nextLock.lockDigest, "/evidence/desktopCanary");
  validateStateCompatibility(
    evidence.stateCompatibility,
    currentLock.migrationVersion,
    nextLock.migrationVersion,
    "/evidence/stateCompatibility",
  );
  const approval = {
    schemaVersion: 1,
    kind: "runtime-promotion-approved",
    previousLockDigest: currentLock.lockDigest,
    runtimeLockDigest: nextLock.lockDigest,
    evidenceDigest: canonicalDigest(evidence),
  };
  return sealRecord({ ...approval, approvalDigest: canonicalDigest(approval) }, {
    contractKind: "RuntimePromotionApproval",
    schemaVersion: 1,
  });
}

export function approveRuntimeRollback({ currentLock, priorLock, evidence }) {
  validateWorkflowLock(currentLock, "/currentLock");
  validateWorkflowLock(priorLock, "/priorLock");
  if (
    currentLock.previousDigest !== priorLock.lockDigest ||
    priorLock.revision + 1 !== currentLock.revision
  ) {
    fail("ROLLBACK_LOCK_MISMATCH", "rollback must select the exact prior immutable lock", "/priorLock");
  }
  record(evidence, [
    "currentLockDigest",
    "kind",
    "schemaVersion",
    "selectedLockDigest",
    "stateCompatibility",
    "verificationDigest",
  ], "/evidence");
  if (evidence.schemaVersion !== 1 || evidence.kind !== "rollback") {
    fail("INVALID_CONTRACT", "rollback evidence kind is invalid", "/evidence/kind");
  }
  if (
    evidence.currentLockDigest !== currentLock.lockDigest ||
    evidence.selectedLockDigest !== priorLock.lockDigest
  ) {
    fail("ROLLBACK_LOCK_MISMATCH", "rollback evidence names another lock", "/evidence/selectedLockDigest");
  }
  digest(evidence.verificationDigest, "/evidence/verificationDigest");
  validateStateCompatibility(
    evidence.stateCompatibility,
    currentLock.migrationVersion,
    priorLock.migrationVersion,
    "/evidence/stateCompatibility",
  );
  const approval = {
    schemaVersion: 1,
    kind: "runtime-rollback-approved",
    currentLockDigest: currentLock.lockDigest,
    runtimeLockDigest: priorLock.lockDigest,
    evidenceDigest: canonicalDigest(evidence),
  };
  return sealRecord({ ...approval, approvalDigest: canonicalDigest(approval) }, {
    contractKind: "RuntimeRollbackApproval",
    schemaVersion: 1,
  });
}
