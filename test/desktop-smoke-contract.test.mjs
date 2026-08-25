import assert from "node:assert/strict";
import test from "node:test";

import { validateDesktopSmokeCaptureRegionsV1, validateDesktopSmokeScenarioV1 } from "nelos/desktop-smoke-contract";
import { desktopGuiScenario } from "./fixtures/desktop-gui-driver-scenarios.mjs";

test("minimal Desktop smoke scenario contract accepts the reviewed allowlisted shape", () => {
  assert.deepEqual(validateDesktopSmokeScenarioV1(desktopGuiScenario()), desktopGuiScenario());
  const forbidden = desktopGuiScenario();
  forbidden.actions[0].type = "shell";
  assert.throws(() => validateDesktopSmokeScenarioV1(forbidden), /not allowlisted/u);
});

test("capture geometry requires complete conversation and credential exclusion inventory", () => {
  const proof = {
    schemaVersion: 1,
    conversation: { kind: "conversation", x: 1, y: 2, width: 3, height: 4 },
    credentialInventory: { complete: true, count: 1, regions: [{ kind: "credential", x: 5, y: 6, width: 7, height: 8 }] },
    traversal: { complete: true, scannedNodes: 4, maximumNodes: 100 },
  };
  assert.equal(validateDesktopSmokeCaptureRegionsV1(proof).length, 2);
  proof.traversal.complete = false;
  assert.throws(() => validateDesktopSmokeCaptureRegionsV1(proof), /incomplete/u);
});
