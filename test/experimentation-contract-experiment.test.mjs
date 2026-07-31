import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractError,
  canonicalizeExperiment,
  deriveExperimentDigest,
  deriveExperimentIdentity,
  parseCanonicalExperiment,
  reviseExperiment,
  sealExperiment,
  transitionExperiment,
  validateExperiment,
  verifyExperimentDigest,
  verifyExperimentIdentity,
  verifyExperimentRevision,
} from "../src/experimentation-contract/index.mjs";
import {
  buildExperimentV1,
  invalidExperimentFixturesV1,
  validExperimentV1,
} from "./fixtures/experimentation-contract/experiment-v1.mjs";

function expectError(action, code, path) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    assert.equal(error.contractKind, "Experiment");
    assert.equal(error.schemaVersion, code === "UNSUPPORTED_SCHEMA_VERSION" ? 2 : 1);
    return true;
  });
}

test("valid Experiment v1 is canonical, identity-complete, and sealable", () => {
  assert.equal(validateExperiment(validExperimentV1), validExperimentV1);
  assert.match(deriveExperimentIdentity(validExperimentV1), /^exp:[0-9a-f]{64}$/u);
  assert.equal(verifyExperimentIdentity(validExperimentV1), validExperimentV1);
  assert.equal(verifyExperimentDigest(validExperimentV1), validExperimentV1);
  const canonical = canonicalizeExperiment(validExperimentV1);
  assert.equal(canonical, canonicalizeExperiment(JSON.parse(canonical)));
  const sealed = sealExperiment(validExperimentV1);
  assert.ok(Object.isFrozen(sealed));
  assert.ok(Object.isFrozen(sealed.candidates[0].model));
  assert.deepEqual(parseCanonicalExperiment(Buffer.from(canonical)), parseCanonicalExperiment(Buffer.from(canonical)));
});

test("identity includes every semantic field and excludes descriptive lifecycle data", () => {
  const original = deriveExperimentIdentity(validExperimentV1);
  for (const mutate of [
    (v) => { v.candidates[0].configuration[0].value = "changed"; },
    (v) => { v.corpus.digest = `sha256:${"a".repeat(64)}`; },
    (v) => { v.graderBundle.digest = `sha256:${"b".repeat(64)}`; },
    (v) => { v.design.seedSchedule[0].seed = "changed"; },
    (v) => { v.limits.toolCalls += 1; },
    (v) => { v.runtimeMatrix[0].requiredCapabilities.push("python"); },
    (v) => { v.exclusions[0].reasonCode = "other"; },
    (v) => { v.metrics.secondary[0].direction = "higher"; },
    (v) => { v.metrics.minimumDetectableEffect.absolute = 0.1; },
    (v) => { v.decisionRules.promotion.threshold = 0.03; },
    (v) => { v.decisionRules.regression.threshold = 0.2; },
    (v) => { v.decisionRules.stop.minimumSamples = 41; },
    (v) => { v.decisionRules.invalidation.maxInvalidFraction = 0.2; },
  ]) {
    const changed = structuredClone(validExperimentV1);
    mutate(changed);
    assert.notEqual(deriveExperimentIdentity(changed), original);
  }
  for (const mutate of [(v) => { v.name = "renamed"; }, (v) => { v.description = "edited"; }, (v) => { v.state = "reviewed"; }]) {
    const changed = structuredClone(validExperimentV1);
    mutate(changed);
    assert.equal(deriveExperimentIdentity(changed), original);
  }
});

test("golden invalid fixtures return exact structured codes and pointers", () => {
  for (const fixture of invalidExperimentFixturesV1) {
    const value = structuredClone(validExperimentV1);
    fixture.mutate(value);
    expectError(() => validateExperiment(value), fixture.code, fixture.path);
  }
});

test("canonical parser rejects non-canonical Experiment input", () => {
  const canonical = canonicalizeExperiment(validExperimentV1);
  expectError(() => parseCanonicalExperiment(Buffer.from(`${canonical}\n`)), "NON_CANONICAL_JSON", "");
});

test("documented Experiment lifecycle accepts all edges and rejects skips and terminals", () => {
  const edges = [
    ["draft", "reviewed"], ["draft", "invalidated"], ["reviewed", "sealed"],
    ["reviewed", "invalidated"], ["sealed", "running"], ["sealed", "invalidated"],
    ["running", "stopped"], ["running", "completed"], ["running", "invalidated"],
    ["completed", "reported"], ["reported", "archived"],
  ];
  for (const [from, to] of edges) {
    const input = buildExperimentV1({ state: from });
    const snapshot = structuredClone(input);
    const output = transitionExperiment(input, to);
    assert.equal(output.state, to);
    assert.deepEqual(input, snapshot);
    assert.ok(Object.isFrozen(output));
    verifyExperimentDigest(output);
  }
  expectError(() => transitionExperiment(buildExperimentV1(), "sealed"), "UNAUTHORIZED_TRANSITION", "/state");
  expectError(() => transitionExperiment(buildExperimentV1({ state: "archived" }), "draft"), "TERMINAL_TRANSITION", "/state");
});

test("semantic revisions enforce identity, digest, revision, and lineage", () => {
  const previous = sealExperiment(validExperimentV1);
  const next = reviseExperiment(previous, { metrics: { ...structuredClone(previous.metrics), minimumDetectableEffect: { ...previous.metrics.minimumDetectableEffect, absolute: 0.08 } } });
  assert.equal(next.specRevision, 2);
  assert.equal(next.previousDigest, previous.digest);
  assert.notEqual(next.experimentId, previous.experimentId);
  assert.notEqual(next.digest, previous.digest);
  assert.equal(verifyExperimentRevision(previous, next), next);

  expectError(() => reviseExperiment(previous, { description: "only prose changed" }), "REVISION_WITHOUT_SEMANTIC_CHANGE", "");
  const badLineage = sealExperiment({ ...structuredClone(next), previousDigest: `sha256:${"f".repeat(64)}`, digest: deriveExperimentDigest({ ...next, previousDigest: `sha256:${"f".repeat(64)}` }) });
  expectError(() => verifyExperimentRevision(previous, badLineage), "INVALID_LINEAGE", "/previousDigest");
  const skipped = structuredClone(next);
  skipped.specRevision = 3;
  skipped.digest = deriveExperimentDigest(skipped);
  expectError(() => verifyExperimentRevision(previous, sealExperiment(skipped)), "INVALID_REVISION", "/specRevision");
});

test("identity and record digest mismatches fail at their exact fields", () => {
  const badIdentity = structuredClone(validExperimentV1);
  badIdentity.experimentId = `exp:${"f".repeat(64)}`;
  badIdentity.digest = deriveExperimentDigest(badIdentity);
  expectError(() => verifyExperimentIdentity(badIdentity), "INVALID_DIGEST", "/experimentId");

  const badDigest = { ...structuredClone(validExperimentV1), digest: `sha256:${"f".repeat(64)}` };
  expectError(() => verifyExperimentDigest(badDigest), "REVISION_DIGEST_MISMATCH", "/digest");
});
