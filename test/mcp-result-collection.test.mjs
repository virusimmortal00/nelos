import assert from "node:assert/strict";
import test from "node:test";
import { collectOrchestrationResultsV1, hasHostRecoveryEffectV1 } from "../src/mcp-result-collection.mjs";

test("collection preserves host-owned correction and repair effects without observing again", async () => {
  for (const type of ["native-follow-up", "orchestration-repair-member"]) {
    const state = { join: { effects: [{ type, actionId: "existing-action" }] } };
    assert.equal(hasHostRecoveryEffectV1(state), true);
    const actual = await collectOrchestrationResultsV1({ webId: "A1", queenThreadId: "queen" }, {
      joinAdapter: { async advance() { return state; } },
      appServerBridge: new Proxy({}, { get() { assert.fail("recovery must not read or mutate native tasks"); } }),
    });
    assert.equal(actual, state);
  }
});

test("collection requires a verified plan wave before native result reads", async () => {
  const state = { checkpoint: { waveScope: null }, join: { effects: [] } };
  const actual = await collectOrchestrationResultsV1({ webId: "A1", queenThreadId: "queen" }, {
    joinAdapter: { async advance() { return state; } },
    appServerBridge: new Proxy({}, { get() { assert.fail("unverified wave must not read native tasks"); } }),
  });
  assert.equal(actual.nextAction.reason, "verified-plan-wave-required");
});
