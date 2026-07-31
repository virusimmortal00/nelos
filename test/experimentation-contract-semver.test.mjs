import assert from "node:assert/strict";
import test from "node:test";

import {
  compareSemanticVersions,
  isSemanticVersion,
  parseSemanticVersion,
} from "../src/experimentation-contract/semantic-version.mjs";

test("semantic version parsing accepts the complete bounded v1 grammar", () => {
  assert.deepEqual(parseSemanticVersion("0.0.0"), {
    core: ["0", "0", "0"],
    prerelease: [],
  });
  assert.deepEqual(parseSemanticVersion("1.2.3-alpha.1+build.001"), {
    core: ["1", "2", "3"],
    prerelease: ["alpha", "1"],
  });
  assert.equal(isSemanticVersion("1.2.3--"), true);
});

test("semantic version parsing rejects malformed identifiers without regex backtracking", () => {
  for (const value of [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-alpha..1",
    "1.2.3+build..1",
    "1.2.3_alpha",
    "1.2.3-álpha",
    "1.2.3+build+again",
  ]) {
    assert.equal(isSemanticVersion(value), false, value);
  }
  assert.equal(
    isSemanticVersion(`1.2.3-${"a".repeat(100_000)}.`),
    false,
  );
});

test("semantic version comparison follows precedence and ignores build metadata", () => {
  const precedence = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let index = 1; index < precedence.length; index += 1) {
    assert.ok(compareSemanticVersions(precedence[index - 1], precedence[index]) < 0);
  }
  assert.equal(
    compareSemanticVersions("1.0.0+build.1", "1.0.0+build.2"),
    0,
  );
  assert.ok(
    compareSemanticVersions(
      "100000000000000000000000000000000000000.0.0",
      "99999999999999999999999999999999999999.0.0",
    ) > 0,
  );
  assert.throws(
    () => compareSemanticVersions("latest", "1.0.0"),
    /requires valid versions/u,
  );
});
