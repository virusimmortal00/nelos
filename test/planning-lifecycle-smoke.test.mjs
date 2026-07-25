import assert from "node:assert/strict";
import test from "node:test";

import { runPlanningLifecycleScenario } from "../scripts/verify-planning-lifecycle.mjs";

test("real MCP and app-server processes complete the receipt-driven planning smoke", async () => {
  const report = await runPlanningLifecycleScenario();
  assert.deepEqual(report, {
    schemaVersion: 1,
    receiptResume: true,
    batchAtomic: true,
    exceptionReplanned: true,
    completedSlicesPreserved: true,
    modelTurns: 0,
    cleanedUp: true,
  });
});
