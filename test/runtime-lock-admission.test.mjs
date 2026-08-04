import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deriveRuntimeIdentity,
  deriveRuntimeLockDigest,
  parseCanonicalRuntimeLock,
  reviseRuntimeLock,
  sealRuntimeLock,
  transitionRuntimeLock,
} from "../src/experimentation-contract/index.mjs";
import {
  RuntimeLockAdmissionError,
  admitRuntimeLock,
  approveRuntimeRollback,
  approveRuntimeUpgrade,
  createRuntimeCandidateController,
} from "../src/runtime-lock-admission.mjs";

const FIXTURES = new URL("./fixtures/experimentation-contract/", import.meta.url);
const D = (character) => `sha256:${character.repeat(64)}`;

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function activeLock() {
  let lock = parseCanonicalRuntimeLock(await readFile(new URL("runtime-lock-v1.json", FIXTURES)));
  for (const state of ["reviewed", "sealed", "active"]) lock = transitionRuntimeLock(lock, state);
  return lock;
}

function rebind(lock) {
  lock.runtimeId = deriveRuntimeIdentity(lock);
  lock.lockDigest = deriveRuntimeLockDigest(lock);
  return lock;
}

function baselineLock(lock) {
  const baseline = clone(lock);
  baseline.plugin = null;
  return sealRuntimeLock(rebind(baseline));
}

function pluginCopy(lock, locationId = "cache:one") {
  return { ...clone(lock.plugin), locationId };
}

function policy(lock, overrides = {}) {
  const supported = {
    product: lock.codex.product,
    version: lock.codex.version,
    commit: lock.codex.commit,
    artifactDigest: lock.codex.artifactDigest,
    appServerSchemaDigest: lock.codex.appServerSchemaDigest,
    protocolFixtureDigest: lock.codex.protocolFixture.digest,
  };
  return {
    schemaVersion: 1,
    supportedCodexBuilds: [supported],
    trustedSignerKeyDigests: lock.signatures.map(({ keyDigest }) => keyDigest),
    ...overrides,
  };
}

function observation(lock, overrides = {}) {
  return {
    schemaVersion: 1,
    phase: "pre-attachment",
    attachments: { secrets: false, workspace: false },
    sourceReference: { kind: "commit", value: lock.source.commit },
    pluginReference: lock.plugin === null
      ? { kind: "none", value: null }
      : { kind: "commit", value: lock.plugin.sourceCommit },
    source: clone(lock.source),
    platform: clone(lock.platform),
    toolchain: clone(lock.toolchain),
    codex: clone(lock.codex),
    permissionsDigest: lock.permissionsDigest,
    contractDigest: lock.contractDigest,
    pluginCopies: lock.plugin === null ? [] : [pluginCopy(lock)],
    ...overrides,
  };
}

function admissionError(code) {
  return (error) => error instanceof RuntimeLockAdmissionError && error.code === code;
}

function request(lock, candidateId, arm = "plugin-a") {
  return {
    schemaVersion: 1,
    candidateId,
    arm,
    runtimeLock: lock,
    observation: observation(lock),
    policy: policy(lock),
    secretRefs: ["secret:openai"],
  };
}

function adapter({ sharedRoot = false } = {}) {
  const calls = [];
  const installed = new Map();
  return {
    calls,
    async buildPluginArtifact({ plugin }) {
      calls.push("build");
      return deepFreeze(clone(plugin));
    },
    async createFreshHome({ candidateId }) {
      calls.push(`home:${candidateId}`);
      const root = sharedRoot ? "/isolated/shared" : `/isolated/${candidateId}`;
      return {
        candidateId,
        homeId: `home:${candidateId}`,
        codexHome: `${root}/codex`,
        pluginStateRoot: `${root}/plugin-state`,
        workspaceRoot: `${root}/workspace`,
      };
    },
    async installPlugin({ artifact, home }) {
      calls.push(`install:${home.candidateId}`);
      installed.set(home.homeId, artifact);
      return {
        candidateId: home.candidateId,
        homeId: home.homeId,
        installed: true,
        packageDigest: artifact.packageDigest,
        manifestDigest: artifact.manifestDigest,
      };
    },
    async observeInstalledPlugins({ home }) {
      calls.push(`observe:${home.candidateId}`);
      const artifact = installed.get(home.homeId);
      return artifact ? [{ ...clone(artifact), locationId: home.homeId }] : [];
    },
    async attachCandidate({ candidateId, home, secretRefs }) {
      calls.push(`attach:${candidateId}`);
      return {
        attached: true,
        candidateId,
        homeId: home.homeId,
        secretRefCount: secretRefs.length,
        workspaceRoot: home.workspaceRoot,
      };
    },
  };
}

function stateCompatibility(fromLock, toLock, compatible = true) {
  return {
    compatible,
    fromMigrationVersion: fromLock.migrationVersion,
    toMigrationVersion: toLock.migrationVersion,
    persistedStateDigest: D("9"),
    evidenceDigest: D("8"),
  };
}

function upgradeEvidence(currentLock, nextLock) {
  return {
    schemaVersion: 1,
    kind: "upgrade",
    fromLockDigest: currentLock.lockDigest,
    toLockDigest: nextLock.lockDigest,
    artifactDigest: nextLock.plugin?.packageDigest ?? nextLock.platform.imageDigest,
    headlessCanary: {
      lane: "headless",
      outcome: "passed",
      runtimeLockDigest: nextLock.lockDigest,
      evidenceDigest: D("6"),
    },
    desktopCanary: {
      lane: "desktop",
      outcome: "passed",
      runtimeLockDigest: nextLock.lockDigest,
      evidenceDigest: D("7"),
    },
    stateCompatibility: stateCompatibility(currentLock, nextLock),
  };
}

test("runtime admission is public, exact, content-addressed, and deeply sealed", async () => {
  const lock = await activeLock();
  const receipt = admitRuntimeLock({ runtimeLock: lock, observation: observation(lock), policy: policy(lock) });
  assert.equal(receipt.kind, "runtime-admission");
  assert.equal(receipt.runtimeLockDigest, lock.lockDigest);
  assert.ok(Object.isFrozen(receipt));
  const exported = await import("nelos/runtime-lock-admission");
  assert.equal(exported.admitRuntimeLock, admitRuntimeLock);
});

test("runtime admission rejects shallow-frozen locks with mutable nested identity", async () => {
  const mutable = clone(await activeLock());
  Object.freeze(mutable);
  assert.throws(
    () => admitRuntimeLock({ runtimeLock: mutable, observation: observation(mutable), policy: policy(mutable) }),
    admissionError("RUNTIME_LOCK_MUTABLE"),
  );
});

test("offline golden admission cases cover valid, drifted, duplicated, missing, and unsupported inventories", async () => {
  const golden = JSON.parse(await readFile(new URL("runtime-lock-admission-golden.json", FIXTURES), "utf8"));
  const lock = await activeLock();
  for (const scenario of golden.admission) {
    const observed = observation(lock);
    const admittedPolicy = policy(lock);
    if (scenario.name === "drifted") observed.platform.imageDigest = D("f");
    if (scenario.name === "duplicated") observed.pluginCopies.push(pluginCopy(lock, "cache:two"));
    if (scenario.name === "missing") observed.pluginCopies = [];
    if (scenario.name === "unsupported") admittedPolicy.supportedCodexBuilds[0].version = "0.144.5";
    if (scenario.name === "valid") {
      assert.equal(admitRuntimeLock({ runtimeLock: lock, observation: observed, policy: admittedPolicy }).kind, scenario.expected);
    } else {
      assert.throws(
        () => admitRuntimeLock({ runtimeLock: lock, observation: observed, policy: admittedPolicy }),
        admissionError(scenario.expected),
        scenario.name,
      );
    }
  }
});

test("mutable references and invalid admission fail before build, home, secret, or workspace attachment", async () => {
  const lock = await activeLock();
  const fake = adapter();
  const controller = createRuntimeCandidateController(fake);
  const invalid = request(lock, "candidate:invalid");
  invalid.observation.pluginReference = { kind: "branch", value: "main" };
  await assert.rejects(controller.prepareCandidate(invalid), admissionError("MUTABLE_REFERENCE"));
  assert.deepEqual(fake.calls, []);
});

test("candidate preparation builds one exact artifact and allocates disjoint fresh writable state per arm", async () => {
  const pluginA = await activeLock();
  const changedPlugin = clone(pluginA.plugin);
  changedPlugin.version = "1.2.4";
  changedPlugin.sourceCommit = "c".repeat(40);
  changedPlugin.packageDigest = D("a");
  const pluginB = reviseRuntimeLock(pluginA, { plugin: changedPlugin });
  const baseline = baselineLock(pluginA);
  const fake = adapter();
  const controller = createRuntimeCandidateController(fake);

  const first = await controller.prepareCandidate(request(pluginA, "candidate:a1", "plugin-a"));
  const second = await controller.prepareCandidate(request(pluginA, "candidate:a2", "plugin-a"));
  const third = await controller.prepareCandidate(request(pluginB, "candidate:b1", "plugin-b"));
  const fourth = await controller.prepareCandidate(request(baseline, "candidate:base", "baseline"));

  assert.equal(fake.calls.filter((entry) => entry === "build").length, 2);
  assert.equal(new Set([...first.writableRoots, ...second.writableRoots, ...third.writableRoots, ...fourth.writableRoots]).size, 12);
  assert.equal(fake.calls.filter((entry) => entry.startsWith("attach:")).length, 4);
});

test("candidate preparation rejects writable root reuse before installation or attachment", async () => {
  const lock = await activeLock();
  const fake = adapter({ sharedRoot: true });
  const controller = createRuntimeCandidateController(fake);
  await controller.prepareCandidate(request(lock, "candidate:first"));
  await assert.rejects(controller.prepareCandidate(request(lock, "candidate:second")), admissionError("WRITABLE_STATE_SHARED"));
  assert.equal(fake.calls.includes("install:candidate:second"), false);
  assert.equal(fake.calls.includes("attach:candidate:second"), false);
});

test("upgrade and rollback approvals bind exact immutable locks, both canaries, artifact, and persisted state", async () => {
  const golden = JSON.parse(await readFile(new URL("runtime-lock-admission-golden.json", FIXTURES), "utf8"));
  const current = await activeLock();
  const toolchain = clone(current.toolchain);
  toolchain.nodeVersion = "22.18.0";
  const next = reviseRuntimeLock(current, { toolchain });
  const promotion = approveRuntimeUpgrade({ currentLock: current, nextLock: next, evidence: upgradeEvidence(current, next) });
  assert.equal(promotion.kind, golden.workflows.find(({ name }) => name === "upgrade").expected);

  const rollbackEvidence = {
    schemaVersion: 1,
    kind: "rollback",
    currentLockDigest: next.lockDigest,
    selectedLockDigest: current.lockDigest,
    verificationDigest: D("5"),
    stateCompatibility: stateCompatibility(next, current),
  };
  const rollback = approveRuntimeRollback({ currentLock: next, priorLock: current, evidence: rollbackEvidence });
  assert.equal(rollback.kind, golden.workflows.find(({ name }) => name === "rollback").expected);

  const wrongCanary = upgradeEvidence(current, next);
  wrongCanary.desktopCanary.runtimeLockDigest = current.lockDigest;
  assert.throws(
    () => approveRuntimeUpgrade({ currentLock: current, nextLock: next, evidence: wrongCanary }),
    admissionError("CANARY_LOCK_MISMATCH"),
  );
  rollbackEvidence.stateCompatibility.compatible = false;
  assert.throws(
    () => approveRuntimeRollback({ currentLock: next, priorLock: current, evidence: rollbackEvidence }),
    admissionError("STATE_INCOMPATIBLE"),
  );
});
