import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ExecutionStoreV1 } from "../src/execution-store.mjs";
import { McpOrchestrationAdapterV1 } from "../src/mcp-orchestration.mjs";
import {
  deriveNextAction,
  withNextAction,
} from "../src/next-action.mjs";
import { createPlanRunV1 } from "../src/plan-run-store.mjs";

function slice(overrides = {}) {
  return {
    id: "research",
    title: "Research the design",
    objective: "Resolve the open design question.",
    deliverable: "A short evidence-backed recommendation.",
    acceptanceCriteria: ["The tradeoff is explicit."],
    lifecycle: "subagent",
    workspaceMode: "shared-read-only",
    route: { launch: { nativeTask: { model: "gpt-5.6-sol", thinking: "medium" } } },
    ...overrides,
  };
}

test("unstructured planning returns one exact planner launch action", () => {
  const planner = {
    bootstrapId: "plan:abc",
    launcher: "spawn-subagent",
    nativeTask: { model: "gpt-5.6-sol", thinking: "medium" },
  };
  assert.deepEqual(
    deriveNextAction({
      command: "plan bootstrap",
      bootstrap: { planner },
    }),
    {
      schemaVersion: 1,
      kind: "launch-planner",
      member: planner,
    },
  );
});

test("low-confidence planning stops before execution", () => {
  assert.deepEqual(
    deriveNextAction({
      command: "plan bootstrap review",
      bootstrap: {
        bootstrapId: "plan:abc",
        confidence: "low",
        classificationEvidence: ["Repository boundaries remain unknown."],
        reason: "low-planner-confidence",
      },
    }),
    {
      schemaVersion: 1,
      kind: "attention",
      reason: "low-planner-confidence",
      bootstrapId: "plan:abc",
      confidence: "low",
      classificationEvidence: ["Repository boundaries remain unknown."],
    },
  );
});

test("slice planning returns an executable current-wave launch action", () => {
  const plan = {
    waves: [
      { index: 1, slices: [slice()] },
      { index: 2, slices: [slice({ id: "implement", lifecycle: "spinoff" })] },
    ],
  };
  const planRun = createPlanRunV1(plan, {
    queenThreadId: "queen-1",
    sourceId: "next-action-test",
  });
  const output = withNextAction({
    command: "plan slices",
    plan,
    planRun,
  });

  assert.deepEqual(output.nextAction, {
    schemaVersion: 1,
    kind: "launch-wave",
    waveIndex: 1,
    members: [
      {
        sliceId: "research",
        lifecycle: "subagent",
        memberKind: "joined-subagent",
        launcher: "spawn-subagent",
        title: "Research the design",
        objective: "Resolve the open design question.",
        deliverable: "A short evidence-backed recommendation.",
        acceptanceCriteria: ["The tradeoff is explicit."],
        dependsOn: [],
        titlePolicy: {
          mode: "prompt-seeded",
          recommendedMaxCharacters: 48,
          verifyAfterLaunch: false,
          evidence: "agent-path",
          onMismatch: "attention",
        },
        agentTaskName: "nelos_research_66f62d18",
        identityContract: {
          lifecycle: "subagent",
          memberKind: "joined-subagent",
          primaryId: "agentPath",
          controlSurface: "collaboration",
          nativeThreadIdUse: "verification-only",
          nativeTitleControl: false,
        },
        workspaceMode: "shared-read-only",
        nativeTask: { model: "gpt-5.6-sol", thinking: "medium" },
        routeEnforcement: {
          mode: "exact",
          onUnavailable: "stop",
          verifyAfterLaunch: true,
        },
        prompt: [
          "Task title: Research the design",
          "",
          "Own only this slice: Resolve the open design question.",
          "Deliverable: A short evidence-backed recommendation.",
          "Acceptance criteria:",
          "- The tradeoff is explicit.",
        ].join("\n") +
          "\nFinish with exactly one final fenced nelos-result block and no trailing prose.\n" +
          "Use this result shape. Change outcome when needed; succeeded has no blockers, while blocked has at least one blocker and a recoveryHint:\n" +
          "```nelos-result\n" +
          "{\"schemaVersion\":1,\"workUnitId\":\"research\",\"specRevision\":1,\"attempt\":1,\"outcome\":\"succeeded\",\"summary\":\"concise result summary\",\"artifacts\":[],\"verification\":[],\"blockers\":[],\"recoveryHint\":null}\n" +
          "```",
      },
    ],
    verification: {
      planRunId: planRun.planRunId,
      waveIndex: 1,
      waveDigest: planRun.waves[0].waveDigest,
    },
    settleBeforeWaveIndex: 2,
    remainingWaveCount: 1,
  });
});

test("launch contracts distinguish joined subagents from durable spinoffs", () => {
  const plan = {
    waves: [{
      index: 1,
      slices: [
        slice(),
        slice({
          id: "implement",
          title: "Implement",
          lifecycle: "spinoff",
          workspaceMode: "isolated-write",
        }),
      ],
    }],
  };
  const planRun = createPlanRunV1(plan, {
    queenThreadId: "queen-1",
    sourceId: "identity-contract-test",
    webIdentity: {
      schemaVersion: 1,
      webId: "A1",
      queenThreadId: "queen-1",
      queenTitle: "👑 A1 · Queen",
    },
  });
  const { members } = withNextAction({
    command: "plan slices",
    plan,
    planRun,
  }).nextAction;

  assert.deepEqual(
    members.map((member) => ({
      lifecycle: member.lifecycle,
      launcher: member.launcher,
      agentTaskName: member.agentTaskName,
      identityContract: member.identityContract,
      titlePolicy: member.titlePolicy,
    })),
    [
      {
        lifecycle: "subagent",
        launcher: "spawn-subagent",
        agentTaskName: "nelos_research_66f62d18",
        identityContract: {
          lifecycle: "subagent",
          memberKind: "joined-subagent",
          primaryId: "agentPath",
          controlSurface: "collaboration",
          nativeThreadIdUse: "verification-only",
          nativeTitleControl: false,
        },
        titlePolicy: {
          mode: "prompt-seeded",
          recommendedMaxCharacters: 48,
          verifyAfterLaunch: false,
          evidence: "agent-path",
          onMismatch: "attention",
        },
      },
      {
        lifecycle: "spinoff",
        launcher: "create-thread",
        agentTaskName: undefined,
        identityContract: {
          lifecycle: "spinoff",
          memberKind: "spinoff",
          primaryId: "threadId",
          controlSurface: "codex-task",
          nativeThreadIdUse: "control-and-verification",
          nativeTitleControl: true,
        },
        titlePolicy: {
          mode: "post-bind-read-set-verify",
          recommendedMaxCharacters: 48,
          verifyAfterLaunch: true,
          creationTitleSupported: false,
          promptSeedAuthoritative: false,
          onMismatch: "native-set-title",
        },
      },
    ],
  );
  assert.equal(members[1].title, "🕷️ A1 · Implement");
  assert.equal(
    members[1].orchestration.tool,
    "nelos_orchestrate_create",
  );
  assert.deepEqual(
    members[1].orchestration.arguments.workUnit.capabilities,
    ["observe", "read-result", "follow-up", "archive"],
  );
  assert.equal(
    Object.hasOwn(members[1].orchestration.arguments.workUnit, "binding"),
    false,
  );
  assert.equal(
    Object.hasOwn(
      members[1].orchestration.arguments.workUnit,
      "replacementHistory",
    ),
    false,
  );
  assert.equal(members[1].orchestration.arguments.receipt, null);

  const cleanupDisabledMember = withNextAction({
    command: "plan slices",
    plan,
    planRun,
    cleanupIntended: false,
  }).nextAction.members[1];
  assert.deepEqual(
    cleanupDisabledMember.orchestration.arguments.workUnit.capabilities,
    ["observe", "read-result", "follow-up"],
  );
});

test("a generated durable orchestration action is directly consumable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nelos-next-action-create-"));
  try {
    const plan = {
      waves: [{
        index: 1,
        slices: [
          slice(),
          slice({
            id: "implement",
            title: "Implement",
            lifecycle: "spinoff",
            workspaceMode: "isolated-write",
          }),
        ],
      }],
    };
    const planRun = createPlanRunV1(plan, {
      queenThreadId: "queen-1",
      sourceId: "directly-consumable-test",
      webIdentity: {
        schemaVersion: 1,
        webId: "A1",
        queenThreadId: "queen-1",
        queenTitle: "👑 A1 · Queen",
      },
    });
    const action = withNextAction({
      command: "plan slices",
      plan,
      planRun,
      cleanupIntended: true,
    }).nextAction.members[1].orchestration;
    const adapter = new McpOrchestrationAdapterV1({
      store: new ExecutionStoreV1({ directory }),
    });

    const prepared = await adapter.orchestrate(action.arguments);

    assert.equal(prepared.effects.length, 1);
    assert.equal(prepared.effects[0].type, action.bindReceiptType);
    assert.equal(prepared.binding.state, "launch-pending");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generation-one exception replans give reused joined slices fresh task identities", () => {
  const basePlan = {
    waves: [{ index: 1, slices: [slice(), slice({ id: "audit" })] }],
  };
  const basePlanRun = createPlanRunV1(basePlan, {
    queenThreadId: "queen-1",
    sourceId: "base-plan",
  });
  const replanned = {
    waves: [{ index: 1, slices: [slice(), slice({ id: "audit" })] }],
  };
  const replanRun = createPlanRunV1(replanned, {
    queenThreadId: "queen-1",
    sourceId: "exception-replan",
    parentPlanRun: basePlanRun,
  });

  const baseAction = withNextAction({
    command: "plan slices",
    plan: basePlan,
    planRun: basePlanRun,
  }).nextAction;
  const baseMember = baseAction.members[0];
  const replanAction = withNextAction({
    command: "plan slices",
    plan: replanned,
    planRun: replanRun,
  }).nextAction;
  const replanMember = replanAction.members[0];

  assert.equal(replanRun.replanGeneration, 1);
  assert.match(replanMember.agentTaskName, /^nelos_research_replan1_[a-f0-9]{12}$/u);
  assert.notEqual(replanMember.agentTaskName, baseMember.agentTaskName);
  assert.match(replanAction.members[1].agentTaskName, /^nelos_audit_replan1_[a-f0-9]{12}$/u);
  assert.notEqual(
    replanAction.members[1].agentTaskName,
    baseAction.members[1].agentTaskName,
  );
  assert.equal(replanMember.launcher, "spawn-subagent");
  assert.equal(replanAction.kind, "launch-wave");
  assert.equal(replanAction.members.some((member) => member.launcher === "followup-task"), false);
  assert.deepEqual(replanAction.verification, {
    planRunId: replanRun.planRunId,
    waveIndex: 1,
    waveDigest: replanRun.waves[0].waveDigest,
  });
});

test("launch-wave derivation rejects a crafted Luna joined subagent", () => {
  const plan = {
    waves: [{
      index: 1,
      slices: [slice({
        route: {
          launch: {
            nativeTask: { model: "gpt-5.6-luna", thinking: "low" },
          },
        },
      })],
    }],
  };
  assert.throws(
    () =>
      withNextAction({
        command: "plan slices",
        plan,
        planRun: createPlanRunV1(plan, {
          queenThreadId: "queen-1",
          sourceId: "crafted-luna-subagent",
        }),
      }),
    /joined-subagent launches do not support gpt-5\.6-luna/,
  );
});

test("slice planning fails closed without its persisted plan-run contract", () => {
  const plan = { waves: [{ index: 1, slices: [slice()] }] };
  assert.throws(
    () => withNextAction({ command: "plan slices", plan }),
    /requires a persisted plan run/u,
  );
  const mismatched = createPlanRunV1(
    plan,
    { queenThreadId: "queen-1", sourceId: "mismatched-next-action-test" },
  );
  assert.throws(
    () => withNextAction({
      command: "plan slices",
      plan: { waves: [{ index: 2, slices: [slice()] }] },
      planRun: mismatched,
    }),
    /has no contract for wave 2/u,
  );
});

test("runtime route verification either completes exactly or stops the wave", () => {
  assert.deepEqual(
    deriveNextAction({
      command: "intelligence verify",
      threadId: "member-1",
      expected: { model: "gpt-5.6-terra", effort: "low" },
      observed: [
        {
          turnId: "turn-1",
          model: "gpt-5.6-terra",
          effort: "low",
          matches: true,
        },
      ],
      verified: true,
    }),
    {
      schemaVersion: 1,
      kind: "complete",
      state: "exact-native-route-verified",
      threadId: "member-1",
      turnIds: ["turn-1"],
    },
  );

  const observed = [
    {
      turnId: "turn-1",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      matches: false,
    },
  ];
  assert.deepEqual(
    deriveNextAction({
      command: "intelligence verify",
      threadId: "member-1",
      expected: { model: "gpt-5.6-luna", effort: "low" },
      observed,
      verified: false,
    }),
    {
      schemaVersion: 1,
      kind: "attention",
      reason: "exact-native-route-mismatch",
      threadId: "member-1",
      expected: { model: "gpt-5.6-luna", effort: "low" },
      observed,
    },
  );
});

test("resolved subagent identity leads to exact route verification", () => {
  assert.deepEqual(
    deriveNextAction({
      command: "intelligence resolve subagent",
      threadId: "child-thread",
      expected: { model: "gpt-5.6-sol", effort: "medium" },
      turnId: "turn-current",
    }),
    {
      schemaVersion: 1,
      kind: "verify-route",
      tool: "nelos_intelligence_verify",
      arguments: {
        threadId: "child-thread",
        model: "gpt-5.6-sol",
        effort: "medium",
        turnId: "turn-current",
      },
    },
  );
});

test("registry-only title operations return the exact native synchronization action", () => {
  assert.deepEqual(
    deriveNextAction({
      command: "web begin",
      threadId: "queen-1",
      renderedTitle: "🕷️ A1 · Release",
      requiresNativeTitleSync: true,
    }),
    {
      schemaVersion: 1,
      kind: "native-set-title",
      threadId: "queen-1",
      title: "🕷️ A1 · Release",
      verify: true,
    },
  );
});

test("task lifecycle responses never make the queen infer whether to wait or read", () => {
  assert.deepEqual(
    deriveNextAction({
      command: "spinoff",
      detached: true,
      threadId: "member-1",
      turnId: "turn-1",
      latestTurn: { id: "turn-1", status: "inProgress" },
    }),
    {
      schemaVersion: 1,
      kind: "native-wait",
      threadIds: ["member-1"],
      turnIds: ["turn-1"],
      after: "read-result",
    },
  );
  assert.deepEqual(
    deriveNextAction({
      command: "status",
      threadId: "member-1",
      latestTurn: { id: "turn-1", status: "completed" },
    }),
    {
      schemaVersion: 1,
      kind: "native-read",
      threadId: "member-1",
      turnId: "turn-1",
      purpose: "read-result",
    },
  );
});

test("web collection returns one action for waiting, correction, or acceptance", () => {
  const base = {
    command: "web collect",
    webId: "A1",
    members: [
      {
        threadId: "member-1",
        transportStatus: "running",
        attentionRequired: false,
        attentionReason: null,
        resultState: "running",
      },
    ],
    allSucceeded: false,
  };
  assert.deepEqual(deriveNextAction(base), {
    schemaVersion: 1,
    kind: "native-wait",
    threadIds: ["member-1"],
    after: "web-collect",
    webId: "A1",
  });
  assert.deepEqual(
    deriveNextAction({
      ...base,
      allSucceeded: true,
      members: [{ ...base.members[0], transportStatus: "completed" }],
    }),
    {
      schemaVersion: 1,
      kind: "decide",
      operation: "accept-current-results",
      webId: "A1",
      members: [
        {
          threadId: "member-1",
          sourceTurnId: null,
          workUnitId: null,
          result: null,
        },
      ],
    },
  );
  assert.deepEqual(
    deriveNextAction({
      ...base,
      members: [
        {
          ...base.members[0],
          transportStatus: "completed",
          attentionRequired: true,
          attentionReason: "blocked",
          result: {
            workUnitId: "member-work",
            specRevision: 2,
            attempt: 1,
            blockers: ["Needs the API decision"],
          },
        },
      ],
    }),
    {
      schemaVersion: 1,
      kind: "native-follow-up",
      members: [
        {
          threadId: "member-1",
          prompt:
            "Correct the prior task result: blocked. Preserve workUnitId member-work and specRevision 2; use attempt 2. Resolve these blockers: Needs the API decision. Finish with exactly one valid final nelos-result block and no trailing prose.",
        },
      ],
      after: "web-collect",
      webId: "A1",
    },
  );
});

test("acceptance and readiness surface newly launchable work instead of stopping", () => {
  assert.deepEqual(
    deriveNextAction({
      command: "web accept",
      readiness: {
        webId: "A1",
        readyWorkUnitIds: ["dependent"],
      },
    }),
    {
      schemaVersion: 1,
      kind: "attention",
      reason: "work-units-ready-for-launch",
      webId: "A1",
      workUnitIds: ["dependent"],
    },
  );
  assert.deepEqual(
    deriveNextAction({
      command: "web readiness",
      webId: "A1",
      readyWorkUnitIds: [],
    }),
    {
      schemaVersion: 1,
      kind: "complete",
      state: "no-work-units-ready",
      webId: "A1",
    },
  );
});
