import assert from "node:assert/strict";
import test from "node:test";

import { runGoldenLoopScenario } from "../scripts/verify-golden-loop.mjs";

test("golden loop recovers one blocked member on the same durable task", async () => {
  const result = await runGoldenLoopScenario();
  assert.equal(result.acceptanceGate, true);
  assert.equal(result.dependencyReleasedOnlyAfterAcceptance, true);
  assert.equal(result.restartSafeContinuation, true);
  assert.equal(result.sameTaskRecovery, true);
  assert.equal(result.exactCollection, true);
  assert.equal(result.acceptedSynthesis, "A_RESULT | B_RESULT | C_RESULT");
  assert.equal(result.modelOverrides, 0);
  assert.equal(result.cleanedUp, true);
});
