import assert from "node:assert/strict";
import test from "node:test";

import { validatePluginReleaseChange } from "../scripts/validate-plugin-release.mjs";

test("changed plugin bytes cannot reuse a version or cache identity", () => {
  assert.throws(() => validatePluginReleaseChange({
    baseVersion: "1.0.0",
    candidateVersion: "1.0.0",
    baseCacheIdentity: "repo#nelos@1.0.0",
    candidateCacheIdentity: "repo#nelos@1.0.0",
    payloadChanged: true,
  }), /without a version bump/u);
});

test("changed source revision cannot reuse an otherwise unchanged identity", () => {
  assert.throws(() => validatePluginReleaseChange({
    baseVersion: "1.0.0",
    candidateVersion: "1.0.0",
    baseCacheIdentity: "repo#nelos@1.0.0",
    candidateCacheIdentity: "repo#nelos@1.0.0",
    payloadChanged: false,
    sourceRevisionChanged: true,
  }), /without a version bump/u);
});

test("versioned payload upgrade changes the cache identity", () => {
  assert.deepEqual(validatePluginReleaseChange({
    baseVersion: "1.0.0",
    candidateVersion: "1.1.0",
    baseCacheIdentity: "repo#nelos@1.0.0",
    candidateCacheIdentity: "repo#nelos@1.1.0",
    payloadChanged: true,
  }), {
    changed: true,
    version: "1.1.0",
    cacheIdentity: "repo#nelos@1.1.0",
  });
});
