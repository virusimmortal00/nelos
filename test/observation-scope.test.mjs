import assert from "node:assert/strict";
import test from "node:test";
import { isObservationWaveSettledV1, selectObservationRunV1, selectObservationScopeV1 } from "../src/observation-scope.mjs";

function scenario() {
  const unit = (workUnitId) => ({
    webId: "A1", queenThreadId: "queen", workUnitId, specRevision: 1, attempt: 1,
    required: true, binding: { state: "bound", memberThreadId: `task-${workUnitId}` },
  });
  const run = (planRunId, sliceId, cleaned) => ({
    planRunId, rootPlanRunId: planRunId, replanGeneration: 0,
    verifiedWaveIndexes: [1], cleanedWaveIndexes: cleaned ? [1] : [],
    waves: [{ waveIndex: 1, waveDigest: `digest-${sliceId}`, members: [{ sliceId, lifecycle: "spinoff" }] }],
  });
  const finished = run("run:a", "finished", true);
  const unfinished = run("run:z", "unfinished", false);
  const units = [unit("finished"), unit("unfinished")];
  const decisions = [{
    ...units[0], decision: "accepted", memberThreadId: units[0].binding.memberThreadId,
    result: { outcome: "succeeded" },
  }];
  const checkpoint = { waveScope: { planRunId: finished.planRunId, waveIndex: 1, waveDigest: finished.waves[0].waveDigest } };
  return { runs: [finished, unfinished], workUnits: units, decisions, checkpoint };
}

test("scope selection prioritizes unfinished plans in either hash order", () => {
  for (const reverse of [false, true]) {
    const input = scenario();
    if (reverse) input.runs.reverse();
    assert.equal(selectObservationRunV1(input).planRunId, "run:z");
  }
});

test("a receipt remains pinned to its checkpoint even after that run settles", () => {
  const input = scenario();
  assert.equal(selectObservationRunV1({ ...input, receipt: { type: "native-result-read" } }).planRunId, "run:a");
  input.runs[0].verifiedWaveIndexes.push(2);
  assert.throws(() => selectObservationRunV1({ ...input, receipt: {} }), /wave is no longer current/);
  input.runs.shift();
  assert.throws(() => selectObservationRunV1({ ...input, receipt: {} }), /scope is no longer current/);
});

test("registration of another unfinished plan does not displace ongoing work", () => {
  const input = scenario();
  input.runs[0].cleanedWaveIndexes = [];
  input.runs.reverse();
  assert.equal(selectObservationRunV1(input).planRunId, "run:a");
});

test("cleanup alone, stale acceptance, rejection, and absent bindings do not settle work", () => {
  const changes = [
    (input) => { input.decisions = []; },
    (input) => { input.decisions[0].decision = "rejected"; },
    (input) => { input.decisions[0].result.outcome = "blocked"; },
    (input) => { input.decisions[0].attempt = 2; },
    (input) => { input.decisions[0].specRevision = 2; },
    (input) => { input.decisions[0].memberThreadId = "another-task"; },
    (input) => { input.decisions[0].queenThreadId = "another-queen"; },
    (input) => { input.decisions[0].webId = "B1"; },
    (input) => { input.workUnits[0].binding.state = "unbound"; },
    (input) => { input.workUnits = []; },
    (input) => { input.runs[0].cleanedWaveIndexes = []; },
    (input) => { input.runs[0].verifiedWaveIndexes = []; },
  ];
  for (const change of changes) {
    const input = scenario();
    change(input);
    assert.equal(isObservationWaveSettledV1(input.runs[0], input.runs[0].waves[0], input.workUnits, input.decisions), false);
  }
});

test("future dependency waves keep a plan unfinished", () => {
  const input = scenario();
  input.runs[0].waves.push({ waveIndex: 2, members: [{ sliceId: "future", lifecycle: "spinoff" }] });
  assert.equal(selectObservationRunV1(input).planRunId, "run:a");
});

test("joined-only accepted waves need no archival; verified replans supersede their own lineage", () => {
  const input = scenario();
  input.runs[0].waves[0].members[0].lifecycle = "subagent";
  input.runs[0].cleanedWaveIndexes = [];
  assert.equal(isObservationWaveSettledV1(input.runs[0], input.runs[0].waves[0], input.workUnits, input.decisions), true);
  input.runs.push({ ...input.runs[1], planRunId: "run:replanned", replanGeneration: 1 });
  assert.equal(selectObservationRunV1(input).planRunId, "run:replanned");
  input.runs[2].verifiedWaveIndexes = [];
  assert.equal(selectObservationRunV1(input).planRunId, "run:z", "unverified replans cannot hide verified work");
});


test("wave recovery retains exact scopes and permits receipts from an earlier verified wave", () => {
  const input = scenario();
  const run = input.runs[0];
  run.waves.unshift({ ...input.runs[1].waves[0], waveIndex: 1 });
  run.waves[1] = { ...run.waves[1], waveIndex: 2 };
  run.verifiedWaveIndexes = [1, 2];
  run.cleanedWaveIndexes = [2];
  input.runs = [run];
  input.checkpoint.waveScope = { planRunId: run.planRunId, waveIndex: 2, waveDigest: run.waves[1].waveDigest };
  assert.equal(selectObservationScopeV1(input).scope.waveIndex, 1);
  assert.equal(selectObservationScopeV1({ ...input, receipt: {} }).scope.waveIndex, 2);
  input.checkpoint.waveScope = { planRunId: run.planRunId, waveIndex: 1, waveDigest: run.waves[0].waveDigest };
  assert.equal(selectObservationScopeV1({ ...input, receipt: {} }).scope.waveIndex, 1);
  input.checkpoint.waveScope.waveDigest = "wrong-wave";
  assert.throws(() => selectObservationScopeV1({ ...input, receipt: {} }), /wave is no longer current/);
});
