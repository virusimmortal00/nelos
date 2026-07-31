import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ContractError,
  canonicalCorpusReleaseBytes,
  createCorpusRelease,
  deriveCorpusReleaseDigest,
  deriveCorpusReleaseId,
  parseCorpusRelease,
  reviseCorpusRelease,
  sealCorpusRelease,
  transitionCorpusRelease,
  validateCorpusRelease,
  verifyCorpusReleaseDigest,
  verifyCorpusReleaseIdentity,
  verifyCorpusReleaseLineage,
} from "../src/experimentation-contract/index.mjs";

const fixtureRoot = new URL(
  "./fixtures/experimentation-contract/corpus-release/",
  import.meta.url,
);

async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
}

async function canonicalFixture(name) {
  const bytes = await readFile(new URL(name, fixtureRoot));
  return bytes.subarray(0, bytes.at(-1) === 0x0a ? bytes.length - 1 : bytes.length);
}

function clone(value) {
  return structuredClone(value);
}

function expectContractError(action, code, path, schemaVersion = 1) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    assert.equal(error.contractKind, "CorpusRelease");
    assert.equal(error.schemaVersion, schemaVersion);
    return true;
  });
}

test("golden initial and successor CorpusRelease fixtures are canonical and sealed", async () => {
  const initialBytes = await canonicalFixture("golden-initial.json");
  const successorBytes = await canonicalFixture("golden-successor.json");
  const initial = parseCorpusRelease(initialBytes);
  const successor = parseCorpusRelease(successorBytes);

  assert.ok(Object.isFrozen(initial));
  assert.ok(Object.isFrozen(initial.tasks[0].strata));
  assert.deepEqual(canonicalCorpusReleaseBytes(initial), initialBytes);
  assert.deepEqual(canonicalCorpusReleaseBytes(successor), successorBytes);
  assert.equal(deriveCorpusReleaseId(initial), initial.releaseId);
  assert.equal(deriveCorpusReleaseDigest(initial), initial.digest);
  assert.equal(verifyCorpusReleaseIdentity(initial), initial);
  assert.equal(verifyCorpusReleaseDigest(successor), successor);
  assert.equal(verifyCorpusReleaseLineage(initial, successor), successor);
});

test("create and semantic revision reproduce the golden releases", async () => {
  const initialGolden = await fixture("golden-initial.json");
  const successorGolden = await fixture("golden-successor.json");
  const material = clone(initialGolden);
  delete material.schemaVersion;
  delete material.releaseId;
  delete material.revision;
  delete material.parent;
  delete material.previousDigest;
  delete material.state;
  delete material.digest;

  const initial = createCorpusRelease(material);
  assert.deepEqual(initial, initialGolden);
  const successor = reviseCorpusRelease(initial, {
    version: successorGolden.version,
    changelog: successorGolden.changelog,
    tasks: successorGolden.tasks,
  });
  assert.deepEqual(successor, successorGolden);
  assert.equal(successor.parent.releaseId, initial.releaseId);
  assert.equal(successor.parent.version, initial.version);
  assert.equal(successor.parent.digest, initial.digest);
  assert.equal(successor.previousDigest, initial.digest);

  expectContractError(
    () => reviseCorpusRelease(initial, { version: "1.0.0", changelog: initial.changelog }),
    "INVALID_REVISION",
    "/version",
  );
  expectContractError(
    () => reviseCorpusRelease(initial, { version: "1.0.1", changelog: initial.changelog }),
    "INVALID_LINEAGE",
    "/changelog/0/kind",
  );
});

test("the closed release lifecycle accepts only declared immutable transitions", async () => {
  const draft = sealCorpusRelease(await fixture("golden-initial.json"));
  const reviewed = transitionCorpusRelease(draft, "reviewed");
  const sealed = transitionCorpusRelease(reviewed, "sealed");
  const published = transitionCorpusRelease(sealed, "published");
  const superseded = transitionCorpusRelease(published, "superseded");

  assert.equal(draft.state, "draft");
  assert.deepEqual(
    [reviewed.state, sealed.state, published.state, superseded.state],
    ["reviewed", "sealed", "published", "superseded"],
  );
  assert.equal(reviewed.releaseId, draft.releaseId);
  assert.notEqual(reviewed.digest, draft.digest);
  assert.ok(Object.isFrozen(superseded));
  expectContractError(() => transitionCorpusRelease(draft, "published"), "UNAUTHORIZED_TRANSITION", "/state");
  expectContractError(() => transitionCorpusRelease(superseded, "draft"), "TERMINAL_TRANSITION", "/state");
  assert.equal(transitionCorpusRelease(draft, "invalidated").state, "invalidated");
});

test("closed nested objects, requirements, enums, bounds, digests, versions, and duplicates report exact locations", async () => {
  const initial = await fixture("golden-initial.json");
  const cases = await fixture("invalid-cases.json");
  const actions = {
    "unknown-nested-field"() {
      const value = clone(initial);
      value.tasks[0].strata.extra = true;
      return () => validateCorpusRelease(value);
    },
    "missing-required-field"() {
      const value = clone(initial);
      delete value.license.attribution;
      return () => validateCorpusRelease(value);
    },
    "invalid-enum"() {
      const value = clone(initial);
      value.visibility = "internal";
      return () => validateCorpusRelease(value);
    },
    "duplicate-task"() {
      const value = clone(initial);
      value.tasks.push(clone(value.tasks[0]));
      return () => validateCorpusRelease(value);
    },
    "out-of-bounds"() {
      const value = clone(initial);
      value.assets[0].bytes = 1099511627777;
      return () => validateCorpusRelease(value);
    },
    "malformed-digest"() {
      const value = clone(initial);
      value.tasks[0].digest = "sha256:ABC";
      return () => validateCorpusRelease(value);
    },
    "invalid-semver"() {
      const value = clone(initial);
      value.version = "v1";
      return () => validateCorpusRelease(value);
    },
    "unsupported-version"() {
      const value = clone(initial);
      value.schemaVersion = 2;
      return () => validateCorpusRelease(value);
    },
    "invalid-transition"() {
      return () => transitionCorpusRelease(sealCorpusRelease(initial), "published");
    },
    async "invalid-parent-lineage"() {
      const successor = await fixture("golden-successor.json");
      const value = clone(successor);
      value.parent.digest = `sha256:${"8".repeat(64)}`;
      value.releaseId = deriveCorpusReleaseId(value);
      value.digest = deriveCorpusReleaseDigest(value);
      return () => verifyCorpusReleaseLineage(
        sealCorpusRelease(initial),
        sealCorpusRelease(value),
      );
    },
    async "invalid-revision-lineage"() {
      const value = await fixture("golden-successor.json");
      value.revision = 4;
      const sealed = sealCorpusRelease(value);
      return () => verifyCorpusReleaseLineage(sealCorpusRelease(initial), sealed);
    },
    "digest-mismatch"() {
      const value = clone(initial);
      value.digest = `sha256:${"9".repeat(64)}`;
      return () => sealCorpusRelease(value);
    },
  };

  for (const invalidCase of cases) {
    const action = await actions[invalidCase.name]();
    expectContractError(
      action,
      invalidCase.code,
      invalidCase.path,
      invalidCase.name === "unsupported-version" ? 2 : 1,
    );
  }
});

test("canonical ordering and cross-reference rules fail at the first offending element", async () => {
  const successor = await fixture("golden-successor.json");
  successor.tasks.reverse();
  expectContractError(() => validateCorpusRelease(successor), "INVALID_FORMAT", "/tasks/1");

  const initial = await fixture("golden-initial.json");
  initial.tasks[0].assetDigests[0] = `sha256:${"a".repeat(64)}`;
  expectContractError(() => validateCorpusRelease(initial), "INVALID_LINEAGE", "/tasks/0/assetDigests/0");
});

test("semantic versions fail at exact nested paths and build metadata cannot advance a release", async () => {
  const initial = await fixture("golden-initial.json");

  const topLevel = clone(initial);
  topLevel.version = "01.0.0";
  expectContractError(() => validateCorpusRelease(topLevel), "INVALID_FORMAT", "/version");

  const successor = await fixture("golden-successor.json");
  successor.parent.version = "1.0.0-";
  expectContractError(() => validateCorpusRelease(successor), "INVALID_FORMAT", "/parent/version");

  const grader = clone(initial);
  grader.graderBundles[0].version = "1.0.0+build..1";
  expectContractError(
    () => validateCorpusRelease(grader),
    "INVALID_FORMAT",
    "/graderBundles/0/version",
  );

  expectContractError(
    () => reviseCorpusRelease(sealCorpusRelease(initial), {
      version: "1.0.0+different-build",
    }),
    "INVALID_REVISION",
    "/version",
  );
});

test("non-canonical JSON bytes are rejected before schema admission", async () => {
  const bytes = await readFile(new URL("invalid-noncanonical.json", fixtureRoot));
  expectContractError(() => parseCorpusRelease(bytes), "NON_CANONICAL_JSON", "");
});

test("identity covers every semantic governance section but excludes lifecycle state", async () => {
  const initial = await fixture("golden-initial.json");
  const baseline = deriveCorpusReleaseId(initial);
  for (const mutate of [
    (value) => { value.tasks[0].revision += 1; },
    (value) => { value.assets[0].bytes += 1; },
    (value) => { value.strata.categories[0].weight = 0.5; },
    (value) => { value.cutoff.policy = "declared-exceptions"; },
    (value) => { value.provenance.method = "mixed"; },
    (value) => { value.license.spdxId = "Apache-2.0"; },
    (value) => { value.duplicateAnalysis.nearThreshold = 0.9; },
    (value) => { value.graderBundles[0].version = "1.0.1"; },
    (value) => { value.visibility = "private-test"; },
    (value) => { value.retainedExclusions[0].reason = "Retained audit explanation."; },
  ]) {
    const changed = clone(initial);
    mutate(changed);
    assert.notEqual(deriveCorpusReleaseId(changed), baseline);
  }
  const lifecycleOnly = clone(initial);
  lifecycleOnly.state = "reviewed";
  lifecycleOnly.digest = deriveCorpusReleaseDigest(lifecycleOnly);
  assert.equal(deriveCorpusReleaseId(lifecycleOnly), baseline);
});
