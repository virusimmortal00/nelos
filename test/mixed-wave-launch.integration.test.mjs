import assert from "node:assert/strict";
import test from "node:test";

import { reconcileExecutionRecord } from "../src/execution-reconciliation.mjs";
import { executeNativeLaunchWaveV1 } from "../src/native-launch-adapter.mjs";
import { withNextAction } from "../src/next-action.mjs";
import { workUnitFromLaunchMemberV1 } from "../src/plan-orchestration-bridge.mjs";
import { createPlanRunV1 } from "../src/plan-run-store.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";
import { authorizeLaunchProposal } from "./support/launch-authorization-helper.mjs";

test("the mixed launch adapter and planner bridge are public package subpaths", async () => {
  const [adapter, bridge] = await Promise.all([
    import("nelos/native-launch-adapter"),
    import("nelos/plan-orchestration-bridge"),
  ]);
  assert.equal(typeof adapter.executeNativeLaunchWaveV1, "function");
  assert.equal(typeof bridge.workUnitFromLaunchMemberV1, "function");
});

function mixedLaunchAction() {
  const plan = planWorkSlices({
    schemaVersion: 1,
    objective: "Launch one durable writer and one bounded reviewer",
    maxParallel: 2,
    slices: [
      {
        id: "implementation",
        title: "Implement",
        objective: "Implement the approved change.",
        deliverable: "A verified patch.",
        acceptanceCriteria: ["Focused tests pass."],
        dependsOn: [],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
      {
        id: "review",
        title: "Review",
        objective: "Review the implementation contract.",
        deliverable: "A bounded review.",
        acceptanceCriteria: ["Every finding cites evidence."],
        dependsOn: [],
        lifecycle: "subagent",
        workspaceMode: "shared-read-only",
        taskShape: "complex/open-ended",
      },
    ],
  });
  const planRun = createPlanRunV1(plan, {
    queenThreadId: "queen-1",
    sourceId: "mixed-wave-integration",
    webIdentity: {
      schemaVersion: 1,
      webId: "A1",
      queenThreadId: "queen-1",
      queenTitle: "👑 A1 · Mixed wave",
    },
  });
  const input = { command: "plan slices", plan, planRun };
  const proposal = withNextAction(input).nextAction;
  return withNextAction({
    ...input,
    launchAuthorization: authorizeLaunchProposal(proposal),
  }).nextAction;
}

test("a mixed wave dispatches both native launchers concurrently and verifies routes", async () => {
  const action = mixedLaunchAction();
  assert.deepEqual(
    action.members.map(({ lifecycle, memberKind, launcher }) => ({
      lifecycle,
      memberKind,
      launcher,
    })),
    [
      {
        lifecycle: "spinoff",
        memberKind: "spinoff",
        launcher: "create-thread",
      },
      {
        lifecycle: "subagent",
        memberKind: "joined-subagent",
        launcher: "spawn-subagent",
      },
    ],
  );
  assert.match(action.members[0].actionId, /^plan-launch:/u);

  const started = [];
  let releaseBoth;
  const bothStarted = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  async function nativeLaunch(request) {
    started.push(request);
    if (started.length === 2) releaseBoth();
    await bothStarted;
    return request.launcher === "create-thread"
      ? { threadId: "spinoff-thread", hostId: "local", turnId: "turn-1" }
      : { threadId: "subagent-thread", turnId: "turn-2" };
  }
  const verified = [];
  const result = await executeNativeLaunchWaveV1(action, {
    async authorizeLaunch() {
      return { authorized: true };
    },
    createSpinoff: nativeLaunch,
    spawnSubagent: nativeLaunch,
    async verifyRoute(expected) {
      verified.push(expected);
      return { verified: true };
    },
  });

  assert.equal(result.verified, true);
  assert.equal(result.members[0].actionId, action.members[0].actionId);
  assert.equal(result.attentionRequired, false);
  assert.equal(Object.hasOwn(started[0], "title"), false);
  assert.equal(started[0].settledTitle, "🕷️A1.1 · Implement");
  assert.deepEqual(
    started.map(({ launcher, workspaceMode }) => ({ launcher, workspaceMode })),
    [
      { launcher: "create-thread", workspaceMode: "isolated-write" },
      { launcher: "spawn-subagent", workspaceMode: "shared-read-only" },
    ],
  );
  assert.deepEqual(verified, [
    {
      threadId: "spinoff-thread",
      turnId: "turn-1",
      model: "gpt-5.6-terra",
      effort: "low",
    },
    {
      threadId: "subagent-thread",
      turnId: "turn-2",
      model: "gpt-5.6-sol",
      effort: "medium",
    },
  ]);
});

test("a subagent without a thread ID fails closed instead of inventing a binding", async () => {
  const action = mixedLaunchAction();
  const result = await executeNativeLaunchWaveV1(action, {
    async authorizeLaunch() {
      return { authorized: true };
    },
    async createSpinoff() {
      return { threadId: "spinoff-thread" };
    },
    async spawnSubagent() {
      return { agentName: "/root/review" };
    },
    async verifyRoute() {
      return { verified: true };
    },
  });

  assert.equal(result.verified, false);
  assert.equal(result.attentionRequired, true);
  assert.deepEqual(
    result.members.find(({ lifecycle }) => lifecycle === "subagent"),
    {
      sliceId: "review",
      lifecycle: "subagent",
      memberKind: "joined-subagent",
      launcher: "spawn-subagent",
      status: "attention",
      attentionReason: "missing-thread-id",
    },
  );
});

test("route verification errors preserve the committed native launch receipt", async () => {
  const action = mixedLaunchAction();
  const result = await executeNativeLaunchWaveV1(action, {
    async authorizeLaunch() {
      return { authorized: true };
    },
    async createSpinoff() {
      return {
        threadId: "spinoff-thread",
        hostId: "local",
        turnId: "spinoff-turn",
      };
    },
    async spawnSubagent() {
      return {
        threadId: "subagent-thread",
        turnId: "subagent-turn",
      };
    },
    async verifyRoute({ threadId }) {
      if (threadId === "spinoff-thread") {
        throw new Error("observation timed out");
      }
      return { verified: true };
    },
  });

  assert.deepEqual(result.members[0], {
    sliceId: "implementation",
    lifecycle: "spinoff",
    memberKind: "spinoff",
    launcher: "create-thread",
    threadId: "spinoff-thread",
    actionId: action.members[0].actionId,
    hostId: "local",
    turnId: "spinoff-turn",
    status: "attention",
    attentionReason: "route-verification-unavailable",
    error: "observation timed out",
  });
});

test("route authorization fails the whole wave before either native mutation", async () => {
  const action = mixedLaunchAction();
  const launched = [];
  const result = await executeNativeLaunchWaveV1(action, {
    async authorizeLaunch(request) {
      return request.lifecycle === "spinoff"
        ? { authorized: false, reason: "explicit model authorization required" }
        : { authorized: true };
    },
    async createSpinoff(request) {
      launched.push(request);
      return { threadId: "unexpected-spinoff" };
    },
    async spawnSubagent(request) {
      launched.push(request);
      return { threadId: "unexpected-subagent" };
    },
    async verifyRoute() {
      return { verified: true };
    },
  });

  assert.deepEqual(launched, []);
  assert.equal(result.attentionRequired, true);
  assert.deepEqual(
    result.members.map(({ attentionReason }) => attentionReason),
    ["launch-not-authorized", "wave-preflight-failed"],
  );
  assert.equal(result.members[0].actionId, action.members[0].actionId);
});

test("spinoff launch failures retain their persisted action identity", async () => {
  for (const createSpinoff of [
    async () => {
      throw new Error("native create failed");
    },
    async () => ({}),
  ]) {
    const action = mixedLaunchAction();
    const result = await executeNativeLaunchWaveV1(action, {
      async authorizeLaunch() {
        return { authorized: true };
      },
      createSpinoff,
      async spawnSubagent() {
        return { threadId: "subagent-thread" };
      },
      async verifyRoute() {
        return { verified: true };
      },
    });
    assert.equal(result.members[0].actionId, action.members[0].actionId);
    assert.equal(result.members[0].status, "attention");
  }
});

test("launch members bridge into durable lifecycle-specific work units", () => {
  const action = mixedLaunchAction();
  const workUnits = action.members.map((member) =>
    workUnitFromLaunchMemberV1(member, {
      webId: "A1",
      queenThreadId: "queen-thread",
    }),
  );

  assert.deepEqual(
    workUnits.map(({ memberKind, capabilities, launch }) => ({
      memberKind,
      capabilities,
      launcher: launch.launcher,
      workspaceMode: launch.workspaceMode,
      nativeTask: launch.nativeTask,
    })),
    [
      {
        memberKind: "spinoff",
        capabilities: ["observe", "read-result", "follow-up", "archive"],
        launcher: "create-thread",
        workspaceMode: "isolated-write",
        nativeTask: { model: "gpt-5.6-terra", thinking: "low" },
      },
      {
        memberKind: "joined-subagent",
        capabilities: ["observe", "read-result", "follow-up"],
        launcher: "spawn-subagent",
        workspaceMode: "shared-read-only",
        nativeTask: { model: "gpt-5.6-sol", thinking: "medium" },
      },
    ],
  );

  for (const workUnit of workUnits) {
    const reconciliation = reconcileExecutionRecord(workUnit);
    assert.equal(reconciliation.orchestrationPhase, "ready");
    assert.equal(reconciliation.proposedActions[0].type, "launch");
  }
});
