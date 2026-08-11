import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createRoutingLivePromptV1,
  createRoutingObservationTemplateV1,
  gradeRoutingEvalSuiteV1,
  routingEvalCoverageV1,
  validateRoutingEvalSuiteV1,
  validateRoutingObservationV1,
} from "../src/routing-evaluation.mjs";

const suite = JSON.parse(
  readFileSync(
    new URL("../evals/routing/isolated-queen-scenarios.v1.json", import.meta.url),
    "utf8",
  ),
);

function completedObservation() {
  const observation = createRoutingObservationTemplateV1(suite);
  observation.runs.forEach((run, runIndex) => {
    run.queenTaskId = `queen-${runIndex + 1}`;
    run.orchestrationQueenTaskId = run.queenTaskId;
    run.workspaceId = `workspace-${runIndex + 1}`;
    run.members.forEach((member, memberIndex) => {
      member.sliceId = `slice-${runIndex + 1}-${memberIndex + 1}`;
      member.threadId = `worker-${runIndex + 1}-${memberIndex + 1}`;
      member.turnId = `turn-${runIndex + 1}-${memberIndex + 1}`;
      member.verified = true;
    });
  });
  return observation;
}

test("isolated-queen suite covers models, effort tiers, and task shapes", () => {
  const validated = validateRoutingEvalSuiteV1(suite);
  const coverage = routingEvalCoverageV1(validated);
  assert.equal(validated.scenarios.length, 14);
  assert.equal(coverage.enabledByDefault, 9);
  assert.equal(coverage.knownGaps, 5);
  assert.deepEqual(coverage.models, [
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ]);
  assert.deepEqual(coverage.efforts, ["high", "low", "max", "medium"]);
  assert.deepEqual(coverage.taskShapes, [
    "clear/repeatable",
    "complex/open-ended",
    "everyday",
  ]);
  assert.deepEqual(coverage.routes, [
    "spinoff:gpt-5.6-luna/high",
    "spinoff:gpt-5.6-luna/low",
    "spinoff:gpt-5.6-terra/low",
    "spinoff:gpt-5.6-terra/max",
    "subagent:gpt-5.6-sol/high",
    "subagent:gpt-5.6-sol/low",
    "subagent:gpt-5.6-sol/medium",
    "subagent:gpt-5.6-terra/high",
  ]);
});

test("observation templates preserve each expected launch surface", () => {
  const observation = createRoutingObservationTemplateV1(suite, [
    "shape-sol-medium",
    "shape-luna-low",
  ]);
  assert.deepEqual(
    observation.runs.map((run) => run.members[0].lifecycle),
    ["subagent", "spinoff"],
  );
  assert.equal(observation.runs.every((run) => run.freshQueen), true);
  assert.equal(
    observation.runs.every((run) => run.orchestrationQueenTaskId === run.queenTaskId),
    true,
  );
  assert.equal(observation.runs.every((run) => run.members[0].verified === false), true);
  assert.deepEqual(
    observation.runs.map((run) => ({
      routeSchemaVersion: run.members[0].routeSchemaVersion,
      policyVersion: run.members[0].policyVersion,
      catalogVersion: run.members[0].catalogVersion,
      taskShape: run.members[0].taskShape,
      modelSelection: run.members[0].modelSelection,
      effortSelection: run.members[0].effortSelection,
    })),
    [
      {
        routeSchemaVersion: 2,
        policyVersion: 3,
        catalogVersion: "openai-2026-07-21",
        taskShape: "complex/open-ended",
        modelSelection: "recommended",
        effortSelection: "recommended",
      },
      {
        routeSchemaVersion: 2,
        policyVersion: 3,
        catalogVersion: "openai-2026-07-21",
        taskShape: "clear/repeatable",
        modelSelection: "recommended",
        effortSelection: "recommended",
      },
    ],
  );
});

test("live prompts bind the current task as queen and require lazy tool discovery", () => {
  const prompt = createRoutingLivePromptV1(suite, "auto-clear-repeatable");
  assert.match(prompt, /This current task is the fresh queen/);
  assert.match(prompt, /use available tool discovery to load the Nelos MCP tools/);
  assert.match(prompt, /delegation source_thread_id is provenance only/);
  assert.match(prompt, /orchestration queen task ID/);
});

test("live prompts scope work-unit IDs per run so retained executions do not collide", () => {
  const first = createRoutingLivePromptV1(suite, "shape-terra-low", {
    runId: "run-one",
  });
  const second = createRoutingLivePromptV1(suite, "shape-terra-low", {
    runId: "run-two",
  });
  assert.match(first, /"id": "write-terra-smoke--run-one"/);
  assert.match(second, /"id": "write-terra-smoke--run-two"/);
  assert.doesNotMatch(first, /write-terra-smoke--run-two/);
});

test("must-pass routes gate while a solved semantic challenge is reported separately", () => {
  const report = gradeRoutingEvalSuiteV1(suite, completedObservation());
  assert.equal(report.passed, true);
  assert.equal(report.complete, true);
  assert.deepEqual(report.summary, {
    pass: 8,
    fail: 0,
    knownGapReproduced: 0,
    unexpectedPass: 1,
  });
});

test("the current Sol-medium limitation is a known gap, not a passing recommendation", () => {
  const observation = completedObservation();
  const challenge = observation.runs.find(
    ({ scenarioId }) => scenarioId === "challenge-critical-weak-oracle",
  );
  challenge.members[0].requestedEffort = "medium";
  challenge.members[0].observedEffort = "medium";
  const report = gradeRoutingEvalSuiteV1(suite, observation);
  const result = report.results.find(
    ({ scenarioId }) => scenarioId === "challenge-critical-weak-oracle",
  );
  assert.equal(report.passed, true);
  assert.equal(result.status, "known-gap-reproduced");
  assert.match(result.failures.join("\n"), /required decision subagent:gpt-5\.6-sol\/high/);
  assert.match(result.failures.join("\n"), /forbidden decision subagent:gpt-5\.6-sol\/medium/);
});

test("a requested-versus-observed route mismatch fails a must-pass probe", () => {
  const observation = completedObservation();
  const run = observation.runs.find(({ scenarioId }) => scenarioId === "shape-terra-low");
  run.members[0].observedModel = "gpt-5.6-sol";
  const report = gradeRoutingEvalSuiteV1(suite, observation);
  const result = report.results.find(({ scenarioId }) => scenarioId === "shape-terra-low");
  assert.equal(report.passed, false);
  assert.equal(result.status, "fail");
  assert.match(result.failures.join("\n"), /observed gpt-5\.6-sol\/low instead of gpt-5\.6-terra\/low/);
});

test("an accidental override cannot satisfy a recommended-route probe", () => {
  const observation = completedObservation();
  const run = observation.runs.find(({ scenarioId }) => scenarioId === "shape-terra-low");
  run.members[0].modelSelection = "override";
  const report = gradeRoutingEvalSuiteV1(suite, observation);
  const result = report.results.find(({ scenarioId }) => scenarioId === "shape-terra-low");
  assert.equal(report.passed, false);
  assert.equal(result.status, "fail");
  assert.match(result.failures.join("\n"), /recommended:recommended appeared 0 time/);
});

test("stale policy provenance is a hard failure even for a known gap", () => {
  const observation = completedObservation();
  const challenge = observation.runs.find(
    ({ scenarioId }) => scenarioId === "challenge-critical-weak-oracle",
  );
  challenge.members[0].policyVersion = 2;
  const report = gradeRoutingEvalSuiteV1(suite, observation);
  const result = report.results.find(
    ({ scenarioId }) => scenarioId === "challenge-critical-weak-oracle",
  );
  assert.equal(report.passed, false);
  assert.equal(result.status, "fail");
  assert.match(result.failures.join("\n"), /policy 2 != 3/);
});

test("known-gap challenges never excuse missing runtime verification", () => {
  const observation = completedObservation();
  const challenge = observation.runs.find(
    ({ scenarioId }) => scenarioId === "challenge-critical-weak-oracle",
  );
  challenge.members[0].verified = false;
  const report = gradeRoutingEvalSuiteV1(suite, observation);
  const result = report.results.find(
    ({ scenarioId }) => scenarioId === "challenge-critical-weak-oracle",
  );
  assert.equal(report.passed, false);
  assert.equal(result.status, "fail");
  assert.match(result.failures.join("\n"), /no verified runtime route/);
});

test("attention observations can record a preflight failure with no worker", () => {
  const observation = createRoutingObservationTemplateV1(suite, ["auto-clear-repeatable"]);
  observation.runs[0].queenTaskId = "queen-preflight";
  observation.runs[0].orchestrationQueenTaskId = null;
  observation.runs[0].workspaceId = "workspace-preflight";
  observation.runs[0].terminalState = "attention";
  observation.runs[0].members = [];
  const report = gradeRoutingEvalSuiteV1(suite, observation, { requireComplete: false });
  assert.equal(report.passed, false);
  assert.equal(report.results[0].status, "fail");
  assert.match(report.results[0].failures.join("\n"), /terminal state attention != complete/);
  assert.match(report.results[0].failures.join("\n"), /member count 0 is outside 1-1/);
});

test("launch-pending observations preserve a create that never returned a worker identity", () => {
  const observation = createRoutingObservationTemplateV1(suite, ["shape-luna-low"]);
  const run = observation.runs[0];
  run.queenTaskId = "queen-luna-pending";
  run.orchestrationQueenTaskId = run.queenTaskId;
  run.workspaceId = "workspace-luna-pending";
  run.terminalState = "launch-pending";
  run.members = [];

  const report = gradeRoutingEvalSuiteV1(suite, observation, {
    requireComplete: false,
  });
  assert.equal(report.passed, false);
  assert.match(
    report.results[0].failures.join("\n"),
    /terminal state launch-pending != complete/,
  );
  assert.match(report.results[0].failures.join("\n"), /member count 0 is outside 1-1/);
});

test("attention observations retain a failed-closed worker without inventing an observed route", () => {
  const observation = createRoutingObservationTemplateV1(suite, ["shape-terra-low"]);
  const run = observation.runs[0];
  run.queenTaskId = "queen-terra-attention";
  run.orchestrationQueenTaskId = run.queenTaskId;
  run.workspaceId = "workspace-terra-attention";
  run.terminalState = "attention";
  run.members[0].sliceId = "write-terra-smoke";
  run.members[0].threadId = "worker-terra-attention";
  run.members[0].turnId = "turn-terra-attention";
  run.members[0].observedModel = null;
  run.members[0].observedEffort = null;

  const validated = validateRoutingObservationV1(observation, suite);
  assert.equal(validated.runs[0].members[0].observedModel, null);
  const report = gradeRoutingEvalSuiteV1(suite, observation, {
    requireComplete: false,
  });
  assert.equal(report.passed, false);
  assert.match(report.results[0].failures.join("\n"), /no verified runtime route/);
  assert.match(report.results[0].failures.join("\n"), /observed runtime route is unavailable/);
});

test("verified observations cannot omit their observed runtime route", () => {
  const observation = completedObservation();
  observation.runs[0].members[0].observedModel = null;
  observation.runs[0].members[0].observedEffort = null;
  assert.throws(
    () => validateRoutingObservationV1(observation, suite),
    /verified members require an observed runtime route/,
  );
});

test("a delegated parent cannot silently replace the isolated queen", () => {
  const observation = completedObservation();
  observation.runs[0].orchestrationQueenTaskId = "parent-task";
  const report = gradeRoutingEvalSuiteV1(suite, observation);
  assert.equal(report.passed, false);
  assert.match(
    report.results[0].failures.join("\n"),
    /orchestration queen parent-task != isolated queen queen-1/,
  );
});

test("reused queen or workspace identities invalidate isolation evidence", () => {
  const observation = completedObservation();
  observation.runs[1].queenTaskId = observation.runs[0].queenTaskId;
  assert.throws(
    () => validateRoutingObservationV1(observation, suite),
    /unique queen task for every run/,
  );

  const second = completedObservation();
  second.runs[1].workspaceId = second.runs[0].workspaceId;
  assert.throws(
    () => validateRoutingObservationV1(second, suite),
    /unique workspace for every run/,
  );
});

test("complete grading requires every default scenario while partial grading is bounded", () => {
  const observation = createRoutingObservationTemplateV1(suite, ["shape-sol-medium"]);
  observation.runs[0].queenTaskId = "queen-one";
  observation.runs[0].orchestrationQueenTaskId = "queen-one";
  observation.runs[0].workspaceId = "workspace-one";
  observation.runs[0].members[0].sliceId = "slice-one";
  observation.runs[0].members[0].threadId = "worker-one";
  observation.runs[0].members[0].turnId = "turn-one";
  observation.runs[0].members[0].verified = true;
  const complete = gradeRoutingEvalSuiteV1(suite, observation);
  assert.equal(complete.passed, false);
  assert.equal(complete.complete, false);
  assert.equal(complete.missing.length, 8);

  const partial = gradeRoutingEvalSuiteV1(suite, observation, {
    requireComplete: false,
  });
  assert.equal(partial.passed, true);
  assert.equal(partial.complete, true);
  assert.deepEqual(partial.summary, {
    pass: 1,
    fail: 0,
    knownGapReproduced: 0,
    unexpectedPass: 0,
  });
});

test("the suite and observations reject unknown fields", () => {
  assert.throws(
    () => validateRoutingEvalSuiteV1({ ...suite, surprise: true }),
    /unknown field: surprise/,
  );
  const observation = completedObservation();
  observation.runs[0].members[0].note = "untrusted prose";
  assert.throws(
    () => validateRoutingObservationV1(observation, suite),
    /unknown field: note/,
  );
});

test("observation templates reject duplicate scenario IDs", () => {
  assert.throws(
    () => createRoutingObservationTemplateV1(suite, [
      "shape-sol-medium",
      "shape-sol-medium",
    ]),
    /scenario IDs must be unique/,
  );
});

test("observations reject a profile that disagrees with the requested model", () => {
  const observation = completedObservation();
  observation.runs[0].members[0].profile = "terra";
  assert.throws(
    () => validateRoutingObservationV1(observation, suite),
    /profile does not match requestedModel/,
  );
});
