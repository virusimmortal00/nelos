import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ExecutionStoreV1,
  createWorkUnitSpecV1,
} from "../src/execution-store.mjs";

const cli = fileURLToPath(new URL("../bin/nelos", import.meta.url));

function workUnit({ workUnitId, dependencies = [] }) {
  return createWorkUnitSpecV1({
    webId: "A1",
    queenThreadId: "queen-a",
    workUnitId,
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result"],
    title: workUnitId,
    objectiveSummary: "Produce a bounded result.",
    deliverable: "A result envelope.",
    acceptanceCriteria: ["A queen reviews the result."],
    dependencies,
    required: true,
    policy: { maxAttempts: 2, onBlocked: "queen-review", onFailure: "queen-review" },
  });
}

function run(argumentsList, stateHome) {
  return spawnSync(process.execPath, [cli, ...argumentsList], {
    encoding: "utf8",
    env: { ...process.env, XDG_STATE_HOME: stateHome, CODEX_THREAD_ID: "queen-a" },
  });
}

test("web acceptance persists an exact decision and releases only accepted dependencies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-acceptance-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateHome = join(root, "state");
  const store = new ExecutionStoreV1({
    directory: join(stateHome, "nelos", "executions"),
  });
  await store.create(workUnit({ workUnitId: "upstream" }));
  await store.create(workUnit({ workUnitId: "dependent", dependencies: ["upstream"] }));
  await store.markLaunchPending({
    workUnitId: "upstream",
    specRevision: 1,
    launchActionId: "launch-upstream",
  });
  await store.bind({
    workUnitId: "upstream",
    specRevision: 1,
    launchActionId: "launch-upstream",
    memberThreadId: "task-upstream",
  });
  const resultPath = join(root, "result.json");
  await writeFile(
    resultPath,
    `${JSON.stringify({
      schemaVersion: 1,
      workUnitId: "upstream",
      specRevision: 1,
      attempt: 1,
      outcome: "succeeded",
      summary: "UPSTREAM_RESULT",
      artifacts: [],
      verification: ["fixture"],
      blockers: [],
      recoveryHint: null,
    })}\n`,
  );

  const before = run(["web", "readiness", "--id", "A1"], stateHome);
  assert.equal(before.status, 0, before.stderr);
  const beforeOutput = JSON.parse(before.stdout);
  assert.deepEqual(beforeOutput.readyWorkUnitIds, []);
  assert.equal(
    beforeOutput.entries.find((entry) => entry.workUnitId === "dependent").reason,
    "blocked_by_unaccepted_dependencies",
  );

  const accepted = run(
    [
      "web",
      "accept",
      "--work-unit-id",
      "upstream",
      "--member-thread-id",
      "task-upstream",
      "--source-turn-id",
      "turn-upstream-1",
      "--result-file",
      resultPath,
    ],
    stateHome,
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  const acceptedOutput = JSON.parse(accepted.stdout);
  assert.equal(acceptedOutput.decision.decision, "accepted");
  assert.deepEqual(acceptedOutput.readiness.readyWorkUnitIds, ["dependent"]);

  const afterRestart = run(["web", "readiness", "--id", "A1"], stateHome);
  assert.equal(afterRestart.status, 0, afterRestart.stderr);
  assert.deepEqual(JSON.parse(afterRestart.stdout).readyWorkUnitIds, ["dependent"]);
});
