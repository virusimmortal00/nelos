import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateDesktopSmokeCoverageMatrixV1 } from "nelos/desktop-smoke-contract";

const fixtureRoot = new URL("../validation/desktop-smoke/", import.meta.url);

async function fixture(path) {
  return JSON.parse(await readFile(new URL(path, fixtureRoot), "utf8"));
}

test("routine and release libraries remain complete provider-neutral certification inputs", async () => {
  const [matrix, release, routine, bindings] = await Promise.all([
    fixture("coverage-matrix.json"),
    fixture("scenario-sets/release.json"),
    fixture("scenario-sets/routine.json"),
    fixture("accessibility-bindings.json"),
  ]);
  const validated = validateDesktopSmokeCoverageMatrixV1(matrix, { release, routine });
  assert.equal(validated.release.scenarios.length, 5);
  assert.deepEqual(validated.routine.scenarios.map(({ scenarioId }) => scenarioId), ["plugin-availability", "planning-lifecycle", "attention-recovery"]);
  const releaseById = new Map(validated.release.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  for (const scenario of validated.routine.scenarios) assert.deepEqual(scenario, releaseById.get(scenario.scenarioId));

  const publicDefinitions = JSON.stringify({ matrix, release, routine, bindings });
  assert.doesNotMatch(publicDefinitions, /proxmox|provider|credential|secret|token|screenshot|raw.?evidence|vmid/iu);
  assert.ok(validated.release.scenarios.every((scenario) => scenario.checkpoints.every(({ type }) => ["accessibility_tree", "window_state"].includes(type))));
});

test("coverage fails closed when a result checkpoint or assertion contract drifts", async () => {
  const [matrix, release, routine] = await Promise.all([
    fixture("coverage-matrix.json"),
    fixture("scenario-sets/release.json"),
    fixture("scenario-sets/routine.json"),
  ]);
  const missingCheckpoint = structuredClone(release);
  missingCheckpoint.scenarios[0].checkpoints = missingCheckpoint.scenarios[0].checkpoints.filter(({ checkpointId }) => checkpointId !== matrix.coverage[0].expectedCheckpointIds[0]);
  assert.throws(() => validateDesktopSmokeCoverageMatrixV1(matrix, { release: missingCheckpoint, routine }));

  const visibleExchangeAssertion = structuredClone(release);
  visibleExchangeAssertion.scenarios[0].assertions[0].type = "text_ref_present";
  visibleExchangeAssertion.scenarios[0].assertions[0].expectedRef = "visible-value";
  assert.throws(() => validateDesktopSmokeCoverageMatrixV1(matrix, { release: visibleExchangeAssertion, routine }), /visible exchange text/u);
});
