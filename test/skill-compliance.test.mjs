import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateSkillTraceV1 } from "../src/skill-compliance.mjs";

async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`./fixtures/skill-compliance/${name}.json`, import.meta.url), "utf8"),
  );
}

test("native desktop fixture follows every machine-generated next action", async () => {
  assert.deepEqual(evaluateSkillTraceV1(await fixture("native-desktop")), []);
});

test("compliance eval rejects socket transport and skipped machine actions", async () => {
  assert.deepEqual(evaluateSkillTraceV1(await fixture("noncompliant")), [
    { code: "standalone_transport", index: 0 },
    { code: "next_action_not_executed", index: 1, kind: "native-set-title" },
  ]);
});

test("compliance eval rejects a launch whose effective route was not verified", () => {
  const nextAction = {
    schemaVersion: 1,
    kind: "launch-wave",
    waveIndex: 1,
    members: [
      {
        sliceId: "worker",
        lifecycle: "spinoff",
        title: "Worker",
        workspaceMode: "isolated-write",
        nativeTask: { model: "gpt-5.6-terra", thinking: "low" },
        routeEnforcement: {
          mode: "exact",
          onUnavailable: "stop",
          verifyAfterLaunch: true,
        },
        prompt: "Do bounded work.",
      },
    ],
    settleBeforeWaveIndex: 2,
    remainingWaveCount: 0,
  };
  const launch = {
    type: "native-launch",
    threadId: "member-1",
    lifecycle: "spinoff",
    title: "Worker",
    workspaceMode: "isolated-write",
    nativeTask: { model: "gpt-5.6-terra", thinking: "low" },
    routeEnforcement: nextAction.members[0].routeEnforcement,
    prompt: "Do bounded work.",
  };
  assert.deepEqual(
    evaluateSkillTraceV1({
      schemaVersion: 1,
      events: [{ type: "cli-output", output: { nextAction } }, launch],
    }),
    [{ code: "next_action_not_executed", index: 0, kind: "launch-wave" }],
  );
});

test("planning bootstrap requires the exact fork, child identity, and verified route", () => {
  const member = {
    lifecycle: "subagent",
    title: "Plan and classify the work",
    workspaceMode: "shared-read-only",
    prompt: "bounded planner prompt",
    forkTurns: "none",
    nativeTask: { model: "gpt-5.6-sol", thinking: "medium" },
    routeEnforcement: { verifyAfterLaunch: true },
    threadIdentity: { required: true, onMissing: "attention" },
  };
  const nextAction = { kind: "launch-planner", member };
  const launch = {
    type: "native-launch",
    threadId: "planner-thread",
    lifecycle: "subagent",
    title: member.title,
    workspaceMode: member.workspaceMode,
    prompt: member.prompt,
    forkTurns: "none",
    nativeTask: member.nativeTask,
    routeEnforcement: member.routeEnforcement,
  };
  const verification = {
    type: "native-route-verification",
    threadId: "planner-thread",
    verified: true,
    expected: { model: "gpt-5.6-sol", effort: "medium" },
    observed: [
      { model: "gpt-5.6-sol", effort: "medium", matches: true },
    ],
  };
  assert.deepEqual(
    evaluateSkillTraceV1({
      events: [
        { type: "cli-output", output: { nextAction } },
        launch,
        verification,
      ],
    }),
    [],
  );
  assert.deepEqual(
    evaluateSkillTraceV1({
      events: [
        { type: "cli-output", output: { nextAction } },
        { ...launch, threadId: null },
        verification,
      ],
    }),
    [{ code: "next_action_not_executed", index: 0, kind: "launch-planner" }],
  );
  assert.deepEqual(
    evaluateSkillTraceV1({
      events: [
        { type: "cli-output", output: { nextAction } },
        launch,
        { ...verification, observed: [] },
      ],
    }),
    [{ code: "next_action_not_executed", index: 0, kind: "launch-planner" }],
  );
});
