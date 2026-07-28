import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlanningBootstrapV1,
  finalizePlanningBootstrapV1,
} from "../src/planning-bootstrap.mjs";

test("planning bootstrap creates one uniquely identified exact Sol planning subagent", () => {
  const first = createPlanningBootstrapV1({
    objective: "Design and ship a task-history view",
    context: "The repository uses native task lifecycle records.",
    maxParallel: 3,
  });
  const second = createPlanningBootstrapV1({
    objective: "Design and ship a task-history view",
    context: "The repository uses native task lifecycle records.",
    maxParallel: 3,
  });

  assert.notEqual(first.bootstrapId, second.bootstrapId);
  assert.match(first.bootstrapId, /^plan:[a-f0-9]{24}$/u);
  assert.equal(first.planner.lifecycle, "subagent");
  assert.equal(first.planner.memberKind, "joined-subagent");
  assert.equal(first.planner.launcher, "spawn-subagent");
  assert.equal(first.planner.workspaceMode, "shared-read-only");
  assert.equal(first.planner.forkTurns, "none");
  assert.deepEqual(first.planner.nativeTask, {
    model: "gpt-5.6-sol",
    thinking: "medium",
  });
  assert.deepEqual(first.planner.routeEnforcement, {
    mode: "exact",
    onUnavailable: "stop",
    verifyAfterLaunch: true,
  });
  assert.match(first.planner.prompt, /^Task title: Plan and classify the work\n\n/u);
  assert.match(first.planner.prompt, /Do not implement, edit files, launch tasks/u);
  assert.match(first.planner.prompt, /Do not include routing or raw model\/effort overrides/u);
  assert.match(first.planner.prompt, /between 1 and 8 testable acceptance criteria/u);
  assert.match(first.planner.prompt, /Every new or changed slice id must end with -[a-f0-9]{12}/u);
  assert.match(first.planner.prompt, /plain undecorated text/u);
  assert.match(first.planner.prompt, /peer tasks, not children of the queen/u);
  assert.match(first.planner.prompt, /queen-owned post-result steps/u);
  assert.match(first.planner.prompt, /```nelos-plan/u);
  assert.equal(first.planner.resultContract.nextTool, "nelos_plan_bootstrap");
  assert.deepEqual(first.planner.threadIdentity, {
    required: true,
    onMissing: "attention",
    resolver: "nelos_intelligence_resolve_subagent",
    parentThreadIdSource: "current-task",
    agentPathSource: "launcher-result",
    turnIdSource: "resolved-native-session",
  });
  assert.deepEqual(first.planner.identityContract, {
    lifecycle: "subagent",
    memberKind: "joined-subagent",
    primaryId: "agentPath",
    controlSurface: "collaboration",
    nativeThreadIdUse: "verification-only",
    nativeTitleControl: false,
  });
  assert.equal(first.planner.titlePolicy.verifyAfterLaunch, false);
  assert.equal(first.planner.titlePolicy.evidence, "agent-path");
  assert.equal(first.planner.continuation.wait.action, "native-wait-subagent");
  assert.equal(
    first.planner.continuation.read.action,
    "native-read-subagent-result",
  );
  assert.match(first.planner.agentTaskName, /^nelos_planner_[a-f0-9]{12}$/u);
  assert.deepEqual(first.planner.continuation.verify, {
    tool: "nelos_intelligence_verify",
    model: "gpt-5.6-sol",
    effort: "medium",
    beforeRead: true,
  });
});

function plannerResponse(bootstrap, overrides = {}) {
  const sliceIdSuffix = bootstrap.bootstrapId.slice(5, 17);
  return [
    "Planning completed.",
    "```nelos-plan",
    JSON.stringify({
      schemaVersion: 1,
      bootstrapId: bootstrap.bootstrapId,
      confidence: "high",
      classificationEvidence: [
        "The architecture decision is ambiguous, so it uses complex/open-ended.",
      ],
      plan: {
        schemaVersion: 1,
        objective: "Ship the feature",
        maxParallel: 2,
        slices: [
          {
            id: `design-${sliceIdSuffix}`,
            title: "Resolve the design",
            objective: "Choose the architecture",
            deliverable: "An architecture decision",
            acceptanceCriteria: ["The selected boundary is justified"],
            dependsOn: [],
            lifecycle: "subagent",
            workspaceMode: "shared-read-only",
            taskShape: "complex/open-ended",
          },
        ],
      },
      ...overrides,
    }),
    "```",
  ].join("\n");
}

test("planning bootstrap deterministically finalizes a matching confident plan", () => {
  const initialRequest = { objective: "Ship the feature", maxParallel: 2 };
  const bootstrap = createPlanningBootstrapV1(initialRequest);
  const request = { ...initialRequest, bootstrapId: bootstrap.bootstrapId };
  const finalized = finalizePlanningBootstrapV1(
    request,
    plannerResponse(bootstrap),
  );

  assert.equal(finalized.ready, true);
  assert.equal(finalized.confidence, "high");
  assert.equal(finalized.plan.summary.slices, 1);
  assert.match(
    finalized.plan.waves[0].slices[0].id,
    /^design-[a-f0-9]{12}$/u,
  );
  assert.deepEqual(
    finalized.plan.waves[0].slices[0].route.launch.nativeTask,
    { model: "gpt-5.6-sol", thinking: "medium" },
  );
});

test("planning bootstrap returns attention for low confidence", () => {
  const initialRequest = { objective: "Ship the feature", maxParallel: 2 };
  const bootstrap = createPlanningBootstrapV1(initialRequest);
  const request = { ...initialRequest, bootstrapId: bootstrap.bootstrapId };
  const finalized = finalizePlanningBootstrapV1(
    request,
    plannerResponse(bootstrap, { confidence: "low" }),
  );
  assert.deepEqual(
    {
      ready: finalized.ready,
      confidence: finalized.confidence,
      reason: finalized.reason,
    },
    {
      ready: false,
      confidence: "low",
      reason: "low-planner-confidence",
    },
  );
});

test("planning bootstrap materializes the requested parallelism when omitted", () => {
  const initialRequest = { objective: "Ship the feature", maxParallel: 1 };
  const bootstrap = createPlanningBootstrapV1(initialRequest);
  const request = { ...initialRequest, bootstrapId: bootstrap.bootstrapId };
  const response = plannerResponse(bootstrap);
  const parsed = JSON.parse(
    response.match(/```nelos-plan\n([\s\S]*?)\n```/u)[1],
  );
  delete parsed.plan.maxParallel;
  const finalized = finalizePlanningBootstrapV1(
    request,
    `\`\`\`nelos-plan\n${JSON.stringify(parsed)}\n\`\`\``,
  );
  assert.equal(finalized.plan.maxParallel, 1);
});

test("preservedSliceIds permits an authorized caller to reuse an earlier slice ID", () => {
  const context = JSON.stringify({
    mode: "exception-replan",
    policy: { preserveCompletedSlicesExactly: true },
    trigger: { completedSliceIds: ["accepted-old"] },
  });
  const initialRequest = {
    objective: "Revise the failed work",
    context,
    maxParallel: 2,
  };
  const bootstrap = createPlanningBootstrapV1(initialRequest);
  const request = { ...initialRequest, bootstrapId: bootstrap.bootstrapId };
  const response = plannerResponse(bootstrap, {
    plan: {
      schemaVersion: 1,
      objective: "Revise the failed work",
      maxParallel: 2,
      slices: [
        {
          id: "accepted-old",
          title: "Accepted work",
          objective: "Preserve accepted work",
          deliverable: "The existing accepted result",
          acceptanceCriteria: ["The accepted slice is unchanged"],
          dependsOn: [],
          lifecycle: "subagent",
          workspaceMode: "shared-read-only",
          taskShape: "everyday",
        },
        {
          id: `replacement-${bootstrap.bootstrapId.slice(5, 17)}`,
          title: "Replacement work",
          objective: "Replace the failed work",
          deliverable: "A corrected result",
          acceptanceCriteria: ["The replacement is verified"],
          dependsOn: ["accepted-old"],
          lifecycle: "spinoff",
          workspaceMode: "isolated-write",
          taskShape: "everyday",
        },
      ],
    },
  });

  assert.throws(
    () => finalizePlanningBootstrapV1(request, response),
    /slice id accepted-old must end with/u,
  );
  const finalized = finalizePlanningBootstrapV1(request, response, {
    preservedSliceIds: ["accepted-old"],
  });
  assert.deepEqual(
    finalized.plan.waves.flatMap((wave) =>
      wave.slices.map(({ id }) => id),
    ),
    ["accepted-old", `replacement-${bootstrap.bootstrapId.slice(5, 17)}`],
  );
});

test("planning bootstrap rejects stale, malformed, or over-parallel results", async (t) => {
  const initialRequest = { objective: "Ship the feature", maxParallel: 2 };
  const bootstrap = createPlanningBootstrapV1(initialRequest);
  const request = { ...initialRequest, bootstrapId: bootstrap.bootstrapId };
  const scenarios = [
    [
      "stale identity",
      plannerResponse(bootstrap, { bootstrapId: "plan:stale" }),
      /bootstrapId does not match/u,
    ],
    [
      "trailing prose",
      `${plannerResponse(bootstrap)}\nextra`,
      /must not contain trailing prose/u,
    ],
    [
      "reused unsuffixed slice identity",
      plannerResponse(bootstrap, {
        plan: {
          schemaVersion: 1,
          objective: "Ship the feature",
          maxParallel: 2,
          slices: [
            {
              id: "design",
              title: "Resolve the design",
              objective: "Choose the architecture",
              deliverable: "An architecture decision",
              acceptanceCriteria: ["The boundary is justified"],
              dependsOn: [],
              lifecycle: "subagent",
              workspaceMode: "shared-read-only",
              taskShape: "complex/open-ended",
            },
          ],
        },
      }),
      /must end with -[a-f0-9]{12}/u,
    ],
    [
      "over parallel",
      plannerResponse(bootstrap, {
        plan: {
          schemaVersion: 1,
          objective: "Ship the feature",
          maxParallel: 3,
          slices: [
            {
              id: `design-${bootstrap.bootstrapId.slice(5, 17)}`,
              title: "Resolve the design",
              objective: "Choose the architecture",
              deliverable: "An architecture decision",
              acceptanceCriteria: ["The boundary is justified"],
              dependsOn: [],
              lifecycle: "subagent",
              workspaceMode: "shared-read-only",
              taskShape: "complex/open-ended",
            },
          ],
        },
      }),
      /maxParallel exceeds/u,
    ],
    [
      "planner routing override",
      plannerResponse(bootstrap, {
        plan: {
          schemaVersion: 1,
          objective: "Ship the feature",
          maxParallel: 2,
          slices: [
            {
              id: `design-${bootstrap.bootstrapId.slice(5, 17)}`,
              title: "Resolve the design",
              objective: "Choose the architecture",
              deliverable: "An architecture decision",
              acceptanceCriteria: ["The boundary is justified"],
              dependsOn: [],
              lifecycle: "subagent",
              workspaceMode: "shared-read-only",
              taskShape: "complex/open-ended",
              routing: { profile: "luna" },
            },
          ],
        },
      }),
      /must not contain planner-authored routing overrides/u,
    ],
  ];
  for (const [name, response, pattern] of scenarios) {
    await t.test(name, () =>
      assert.throws(
        () => finalizePlanningBootstrapV1(request, response),
        pattern,
      ),
    );
  }
});

test("planning bootstrap validates bounded input", async (t) => {
  const scenarios = [
    ["missing objective", {}, /objective must be a non-empty string/u],
    [
      "unknown field",
      { objective: "Plan", surprise: true },
      /unknown field: surprise/u,
    ],
    [
      "invalid parallelism",
      { objective: "Plan", maxParallel: 9 },
      /maxParallel must be between 1 and 8/u,
    ],
    [
      "invalid bootstrap identity",
      { objective: "Plan", bootstrapId: "plan:bad" },
      /bootstrapId has an invalid format/u,
    ],
  ];

  for (const [name, value, pattern] of scenarios) {
    await t.test(name, () =>
      assert.throws(() => createPlanningBootstrapV1(value), pattern),
    );
  }
});
