import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ContractError,
  canonicalDigest,
  canonicalizeRuntimeLock,
  deriveRuntimeIdentity,
  deriveRuntimeLockDigest,
  parseCanonicalRuntimeLock,
  reviseRuntimeLock,
  runtimeLockDigestProjection,
  runtimeLockIdentityProjection,
  sealRuntimeLock,
  transitionRuntimeLock,
  validateRuntimeLock,
  verifyRuntimeIdentity,
  verifyRuntimeLockDigest,
  verifyRuntimeLockRevision,
} from "../src/experimentation-contract/index.mjs";

const FIXTURES = new URL("./fixtures/experimentation-contract/", import.meta.url);

async function bytes(name) {
  return readFile(new URL(name, FIXTURES));
}

async function fixture(name = "runtime-lock-v1.json") {
  return JSON.parse(await readFile(new URL(name, FIXTURES), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function expectError(action, code, path, schemaVersion = 1) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ContractError);
    assert.deepEqual(
      { code: error.code, path: error.path, contractKind: error.contractKind, schemaVersion: error.schemaVersion },
      { code, path, contractKind: "RuntimeLock", schemaVersion },
    );
    return true;
  });
}

function replaceAtPointer(value, pointer, replacement) {
  const parts = pointer.slice(1).split("/");
  let target = value;
  for (const part of parts.slice(0, -1)) target = target[part];
  target[parts.at(-1)] = replacement;
}

function rebind(lock) {
  lock.runtimeId = deriveRuntimeIdentity(lock);
  lock.lockDigest = deriveRuntimeLockDigest(lock);
  return lock;
}

test("golden RuntimeLock is exact canonical JSON and seals immutably", async () => {
  const raw = await bytes("runtime-lock-v1.json");
  const lock = parseCanonicalRuntimeLock(raw);
  assert.ok(Object.isFrozen(lock));
  assert.ok(Object.isFrozen(lock.platform.filesystem));
  assert.equal(canonicalizeRuntimeLock(lock), raw.toString("utf8"));
  assert.equal(validateRuntimeLock(lock), lock);
  assert.equal(verifyRuntimeIdentity(lock), lock);
  assert.equal(verifyRuntimeLockDigest(lock), lock);
  assert.equal(lock.runtimeId, deriveRuntimeIdentity(lock));
  assert.equal(lock.lockDigest, deriveRuntimeLockDigest(lock));
});

test("identity and lock projections bind admission and provenance with explicit self-digest handling", async () => {
  const lock = await fixture();
  const identity = runtimeLockIdentityProjection(lock);
  assert.deepEqual(Object.keys(identity), [
    "schemaVersion", "migrationVersion", "runtimeClass", "contract",
    "contractDigest", "platform", "source", "toolchain", "codex", "plugin",
    "permissions", "permissionsDigest", "signatures",
  ]);
  assert.equal(identity.runtimeClass, "headless-oci");
  assert.match(identity.platform.imageDigest, /^sha256:/u);
  assert.equal(identity.platform.locale, "en-US");
  assert.equal(identity.platform.timezone, "UTC");
  assert.equal(identity.source.dirty, false);
  assert.equal(identity.toolchain.nodeVersion, "22.17.0");
  assert.match(identity.toolchain.nodeDigest, /^sha256:/u);
  assert.equal(identity.toolchain.npmVersion, "10.9.2");
  assert.equal(identity.toolchain.sbom.version, "1.6");
  assert.equal(identity.codex.product, "cli");
  assert.match(identity.codex.artifactDigest, /^sha256:/u);
  assert.match(identity.codex.appServerSchemaDigest, /^sha256:/u);
  assert.equal(identity.codex.compatibilityReleaseId, "codex@0.144.6");
  assert.equal(identity.codex.protocolFixture.version, "0.144.6");
  assert.match(identity.plugin.packageDigest, /^sha256:/u);
  assert.match(identity.plugin.manifestDigest, /^sha256:/u);
  assert.equal(identity.plugin.skillDigests.length, 1);
  assert.equal(identity.plugin.dependencies.length, 2);
  assert.equal(identity.permissionsDigest, canonicalDigest(identity.permissions));
  assert.equal(identity.contractDigest, canonicalDigest(identity.contract));
  assert.ok(!Object.hasOwn(identity, "state"));
  const digestMaterial = runtimeLockDigestProjection(lock);
  assert.ok(!Object.hasOwn(digestMaterial, "lockDigest"));
  assert.ok(!Object.hasOwn(digestMaterial, "revision"));
  assert.ok(!Object.hasOwn(digestMaterial, "previousDigest"));
  assert.equal(digestMaterial.runtimeId, lock.runtimeId);
  assert.equal(digestMaterial.state, "draft");
});

test("golden semantic revision is created and verified through kernel lineage", async () => {
  const first = parseCanonicalRuntimeLock(await bytes("runtime-lock-v1.json"));
  const expected = parseCanonicalRuntimeLock(await bytes("runtime-lock-v1-revision.json"));
  const toolchain = clone(first.toolchain);
  toolchain.nodeVersion = "22.18.0";
  const next = reviseRuntimeLock(first, { toolchain });
  assert.deepEqual(next, expected);
  assert.equal(next.revision, 2);
  assert.equal(next.previousDigest, first.lockDigest);
  assert.notEqual(next.runtimeId, first.runtimeId);
  assert.equal(verifyRuntimeLockRevision(first, next), next);
});

test("baseline runtime locks explicitly admit a null plugin without losing provenance", async () => {
  const baseline = await fixture();
  baseline.plugin = null;
  const sealed = sealRuntimeLock(rebind(baseline));
  assert.equal(sealed.plugin, null);
  assert.equal(sealed.runtimeId, deriveRuntimeIdentity(sealed));
  assert.equal(sealed.lockDigest, deriveRuntimeLockDigest(sealed));
});

test("RuntimeLock lifecycle allows only the closed v1 graph", async () => {
  const draft = parseCanonicalRuntimeLock(await bytes("runtime-lock-v1.json"));
  const reviewed = transitionRuntimeLock(draft, "reviewed");
  const sealed = transitionRuntimeLock(reviewed, "sealed");
  const active = transitionRuntimeLock(sealed, "active");
  const superseded = transitionRuntimeLock(active, "superseded");
  assert.deepEqual([reviewed.state, sealed.state, active.state, superseded.state], ["reviewed", "sealed", "active", "superseded"]);
  for (const lock of [reviewed, sealed, active, superseded]) {
    assert.equal(lock.lockDigest, deriveRuntimeLockDigest(lock));
    assert.ok(Object.isFrozen(lock));
  }
  expectError(() => transitionRuntimeLock(draft, "active"), "UNAUTHORIZED_TRANSITION", "/state");
  expectError(() => transitionRuntimeLock(superseded, "active"), "TERMINAL_TRANSITION", "/state");
});

test("unknown nested fields and missing required fields fail at exact pointers", async () => {
  const unknown = await fixture();
  unknown.codex.protocolFixture.channel = "stable";
  expectError(() => validateRuntimeLock(unknown), "UNKNOWN_FIELD", "/codex/protocolFixture/channel");
  const missing = await fixture();
  delete missing.permissions.sandbox.approvalPolicy;
  expectError(() => validateRuntimeLock(missing), "REQUIRED_FIELD", "/permissions/sandbox/approvalPolicy");
});

test("enums, bounds, digests, versions, and immutable identities fail closed", async () => {
  const cases = JSON.parse(await readFile(new URL("runtime-lock-invalid-cases.json", FIXTURES), "utf8"));
  for (const invalid of cases) {
    const lock = await fixture();
    replaceAtPointer(lock, invalid.pointer, invalid.value);
    expectError(() => validateRuntimeLock(lock), invalid.code, invalid.pointer);
  }
  const architecture = await fixture();
  architecture.platform.architecture = "riscv64";
  expectError(() => validateRuntimeLock(architecture), "INVALID_ENUM", "/platform/architecture");
  const bound = await fixture();
  bound.platform.filesystem.timestampResolutionNanoseconds = 0;
  expectError(() => validateRuntimeLock(bound), "OUT_OF_BOUNDS", "/platform/filesystem/timestampResolutionNanoseconds");
  const schema = await fixture();
  schema.schemaVersion = 2;
  expectError(() => validateRuntimeLock(schema), "UNSUPPORTED_SCHEMA_VERSION", "/schemaVersion", 2);
});

test("dependency and signature collections enforce canonical uniqueness", async () => {
  const dependency = await fixture();
  dependency.toolchain.dependencies.push(clone(dependency.toolchain.dependencies[0]));
  expectError(() => validateRuntimeLock(dependency), "DUPLICATE_IDENTITY", "/toolchain/dependencies/1");
  const signature = await fixture();
  signature.signatures.push(clone(signature.signatures[0]));
  expectError(() => validateRuntimeLock(signature), "DUPLICATE_IDENTITY", "/signatures/1");
  const plugin = await fixture();
  plugin.plugin.dependencies[1].dependencies = ["missing"];
  expectError(() => validateRuntimeLock(plugin), "INVALID_LINEAGE", "/plugin/dependencies/1/dependencies/0");
});

test("plugin dependency graph rejects cycles at a deterministic path", async () => {
  const lock = await fixture();
  lock.plugin.dependencies[0].dependencies = ["nelos-runtime"];
  expectError(() => validateRuntimeLock(lock), "INVALID_LINEAGE", "/plugin/dependencies/0/dependencies");
});

test("canonical parser rejects non-canonical input", async () => {
  const lock = await fixture();
  const noncanonical = Buffer.from(JSON.stringify(lock, null, 2));
  expectError(() => parseCanonicalRuntimeLock(noncanonical), "NON_CANONICAL_JSON", "");
});

test("unchanged revisions, bad lineage, and digest mismatches are structured", async () => {
  const first = parseCanonicalRuntimeLock(await bytes("runtime-lock-v1.json"));
  expectError(() => reviseRuntimeLock(first, { platform: clone(first.platform) }), "REVISION_WITHOUT_SEMANTIC_CHANGE", "");

  const badLineageValue = await fixture("runtime-lock-v1-revision.json");
  badLineageValue.previousDigest = `sha256:${"0".repeat(64)}`;
  const badLineage = sealRuntimeLock(rebind(badLineageValue));
  expectError(() => verifyRuntimeLockRevision(first, badLineage), "INVALID_LINEAGE", "/previousDigest");

  const contract = await fixture();
  contract.contractDigest = `sha256:${"0".repeat(64)}`;
  expectError(() => validateRuntimeLock(contract), "INVALID_DIGEST", "/contractDigest");

  const permissions = await fixture();
  permissions.permissionsDigest = `sha256:${"0".repeat(64)}`;
  expectError(() => validateRuntimeLock(permissions), "INVALID_DIGEST", "/permissionsDigest");

  const digest = await fixture();
  digest.lockDigest = `sha256:${"0".repeat(64)}`;
  expectError(() => validateRuntimeLock(digest), "REVISION_DIGEST_MISMATCH", "/lockDigest");

  const identity = await fixture();
  identity.runtimeId = `runtime:${"0".repeat(64)}`;
  identity.lockDigest = deriveRuntimeLockDigest(identity);
  expectError(() => validateRuntimeLock(identity), "INVALID_DIGEST", "/runtimeId");
});

test("top-level contract and permissions digests bind their complete closed structures", async () => {
  const lock = await fixture();
  assert.equal(lock.contractDigest, canonicalDigest(lock.contract));
  assert.equal(lock.permissionsDigest, canonicalDigest(lock.permissions));
});
