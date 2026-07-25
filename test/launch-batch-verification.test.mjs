import assert from "node:assert/strict";
import test from "node:test";

import {
  LAUNCH_BATCH_VERIFICATION_INPUT_SCHEMA,
  LAUNCH_BATCH_VERIFICATION_OUTPUT_SCHEMA,
  MAX_LAUNCH_BATCH_MEMBERS,
  verifyLaunchBatchV1,
} from "../src/launch-batch-verification.mjs";
import { planRunLaunchActionIdV1 } from "../src/plan-run-store.mjs";

const PLAN_RUN_ID = "run:1234567890abcdef1234567890abcdef12345678";

function actionId(sliceId) {
  return planRunLaunchActionIdV1({
    planRunId: PLAN_RUN_ID,
    waveIndex: 1,
    sliceId,
  });
}

function receipt(overrides = {}) {
  return {
    planRunId: PLAN_RUN_ID,
    waveIndex: 1,
    waveDigest: "a".repeat(64),
    parentThreadId: "queen-1",
    members: [
      {
        sliceId: "research",
        lifecycle: "subagent",
        agentPath: "/root/research",
        turnId: "turn-research",
      },
      {
        sliceId: "implementation",
        lifecycle: "spinoff",
        threadId: "spinoff-1",
        actionId: actionId("implementation"),
        reportedParentThreadId: null,
        turnId: "turn-implementation",
      },
    ],
    ...overrides,
  };
}

function waveContract(members = [
  {
    sliceId: "research",
    lifecycle: "subagent",
    title: "Research the boundary",
    model: "gpt-5.6-sol",
    effort: "medium",
  },
  {
    sliceId: "implementation",
    lifecycle: "spinoff",
    title: "Implement the boundary",
    model: "gpt-5.6-terra",
    effort: "high",
  },
]) {
  return {
    waveIndex: 1,
    waveDigest: "a".repeat(64),
    members,
  };
}

function inventory(threads, { topology = true } = {}) {
  const items = threads.map((thread) => ({
    threadId: thread.threadId,
    state: "ready",
    thread,
  }));
  return {
    requested: items.length,
    succeeded: items.length,
    failed: 0,
    items,
    ...(topology
      ? { topology: { nodes: threads.map((thread) => ({ ...thread })) } }
      : {}),
  };
}

function threads() {
  return [
    {
      threadId: "child-1",
      title: "Research the boundary",
      parentThreadId: "queen-1",
    },
    {
      threadId: "spinoff-1",
      title: "Implement the boundary",
      parentThreadId: null,
    },
  ];
}

test("batch verification accepts exact identity, topology, title, and route evidence in one read-only batch", async () => {
  const inspected = [];
  const routes = [];
  const result = await verifyLaunchBatchV1(receipt(), {
    waveContract: waveContract(),
    appServerBridge: {
      async inspectMany(request) {
        inspected.push(request);
        return inventory(threads());
      },
    },
    async resolveNativeSubagentThread({ parentThreadId, agentPath }) {
      assert.equal(parentThreadId, "queen-1");
      assert.equal(agentPath, "/root/research");
      return { parentThreadId, agentPath, threadId: "child-1" };
    },
    async verifyRuntimeIntelligence(request) {
      routes.push(request);
      return { verified: true };
    },
  });

  assert.deepEqual(inspected, [{ threadIds: ["child-1", "spinoff-1"], includeTopology: true }]);
  assert.deepEqual(routes, [
    {
      threadId: "child-1",
      model: "gpt-5.6-sol",
      effort: "medium",
      turnId: "turn-research",
    },
    {
      threadId: "spinoff-1",
      model: "gpt-5.6-terra",
      effort: "high",
      turnId: "turn-implementation",
    },
  ]);
  assert.equal(result.allVerified, true);
  assert.deepEqual(result.members.map((member) => member.checks), [
    { identity: "verified", read: "verified", topology: "verified", title: "verified", route: "verified" },
    { identity: "verified", read: "verified", topology: "verified", title: "verified", route: "verified" },
  ]);
  assert.equal(typeof LAUNCH_BATCH_VERIFICATION_INPUT_SCHEMA.properties.members, "object");
  assert.equal(LAUNCH_BATCH_VERIFICATION_OUTPUT_SCHEMA.properties.allVerified.type, "boolean");
});

test("batch verification fails closed for an incorrect subagent parent, a conflicting spinoff parent, and a settled-title mismatch", async () => {
  const verifierCalls = [];
  const value = receipt();
  value.members[1].reportedParentThreadId = "queen-1";
  const result = await verifyLaunchBatchV1(value, {
    waveContract: waveContract(),
    appServerBridge: {
      async inspectMany() {
        return inventory([
          { ...threads()[0], parentThreadId: "other-queen" },
          { ...threads()[1], title: "Changed in Desktop", parentThreadId: "other-parent" },
        ]);
      },
    },
    async resolveNativeSubagentThread() {
      return { parentThreadId: "queen-1", agentPath: "/root/research", threadId: "child-1" };
    },
    async verifyRuntimeIntelligence(request) {
      verifierCalls.push(request.threadId);
      return { verified: true };
    },
  });

  assert.equal(result.allVerified, false);
  assert.equal(result.members[0].attentionReason, "parent-thread-mismatch");
  assert.equal(result.members[0].checks.topology, "failed");
  assert.equal(result.members[1].attentionReason, "reported-parent-conflict");
  assert.equal(result.members[1].checks.title, "failed");
  // Runtime evidence is still collected for resolved, readable tasks, but no
  // title operation is ever exposed or called by this verifier.
  assert.deepEqual(verifierCalls, ["child-1", "spinoff-1"]);
});

test("batch verification rejects duplicate resolved thread identities before app-server reads", async () => {
  const calls = [];
  const value = receipt({
    members: [
      receipt().members[0],
      { ...receipt().members[0], sliceId: "research-copy", agentPath: "/root/research-copy" },
    ],
  });
  const result = await verifyLaunchBatchV1(value, {
    waveContract: waveContract([
      waveContract().members[0],
      {
        ...waveContract().members[0],
        sliceId: "research-copy",
      },
    ]),
    appServerBridge: { async inspectMany() { calls.push("inspect"); } },
    async resolveNativeSubagentThread({ parentThreadId, agentPath }) {
      return { parentThreadId, agentPath, threadId: "child-1" };
    },
    async verifyRuntimeIntelligence() {
      throw new Error("must not route verify duplicate identities");
    },
  });
  assert.equal(result.allVerified, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(result.members.map((member) => member.attentionReason), [
    "duplicate-thread-identity",
    "duplicate-thread-identity",
  ]);
});

test("batch verification treats identity resolution, batch read, missing topology, and route evidence as attention", async (t) => {
  await t.test("resolver failure", async () => {
    let inspected = false;
    const result = await verifyLaunchBatchV1(receipt({ members: [receipt().members[0]] }), {
      waveContract: waveContract([waveContract().members[0]]),
      appServerBridge: { async inspectMany() { inspected = true; } },
      async resolveNativeSubagentThread() { throw new Error("no native task"); },
      async verifyRuntimeIntelligence() { throw new Error("must not be called"); },
    });
    assert.equal(inspected, false);
    assert.equal(result.members[0].attentionReason, "identity-resolution-unavailable");
  });

  await t.test("read failure", async () => {
    const result = await verifyLaunchBatchV1(receipt({ members: [receipt().members[1]] }), {
      waveContract: waveContract([waveContract().members[1]]),
      appServerBridge: {
        async inspectMany() {
          return { items: [{ threadId: "spinoff-1", state: "failed", error: { code: "timeout" } }], topology: { nodes: [] } };
        },
      },
      async verifyRuntimeIntelligence() { throw new Error("must not be called"); },
    });
    assert.equal(result.members[0].attentionReason, "thread-read-unavailable");
    assert.equal(result.members[0].checks.route, "not-attempted");
  });

  await t.test("topology unavailable", async () => {
    const result = await verifyLaunchBatchV1(receipt({ members: [receipt().members[1]] }), {
      waveContract: waveContract([waveContract().members[1]]),
      appServerBridge: { async inspectMany() { return inventory([threads()[1]], { topology: false }); } },
      async verifyRuntimeIntelligence() { return { verified: true }; },
    });
    assert.equal(result.members[0].attentionReason, "topology-unavailable");
    assert.equal(result.members[0].checks.topology, "failed");
  });

  await t.test("route mismatch and unavailable route", async () => {
    const value = receipt({
      members: [
        receipt().members[1],
        {
          ...receipt().members[1],
          sliceId: "other",
          threadId: "spinoff-2",
          actionId: actionId("other"),
          turnId: "turn-other",
        },
      ],
    });
    const result = await verifyLaunchBatchV1(value, {
      waveContract: waveContract([
        waveContract().members[1],
        {
          ...waveContract().members[1],
          sliceId: "other",
          title: "Other task",
        },
      ]),
      appServerBridge: { async inspectMany() { return inventory([threads()[1], { ...threads()[1], threadId: "spinoff-2", title: "Other task" }]); } },
      async verifyRuntimeIntelligence({ threadId }) {
        if (threadId === "spinoff-1") return { verified: false };
        throw new Error("rollout unavailable");
      },
    });
    assert.deepEqual(result.members.map((member) => member.attentionReason), [
      "exact-route-mismatch",
      "route-verification-unavailable",
    ]);
  });
});

test("batch verification validates bounded receipt shapes and all 16-member limit", async () => {
  const dependencies = {
    appServerBridge: { async inspectMany() { throw new Error("not reached"); } },
    waveContract: waveContract(),
    async verifyRuntimeIntelligence() { throw new Error("not reached"); },
  };
  await assert.rejects(
    verifyLaunchBatchV1(receipt({ members: [] }), dependencies),
    /between 1 and 16/u,
  );
  await assert.rejects(
    verifyLaunchBatchV1(receipt({
      members: Array.from({ length: MAX_LAUNCH_BATCH_MEMBERS + 1 }, (_, index) => ({
        ...receipt().members[1],
        sliceId: `spinoff-${index}`,
        threadId: `thread-${index}`,
        actionId: actionId(`spinoff-${index}`),
      })),
    }), dependencies),
    /between 1 and 16/u,
  );
  await assert.rejects(
    verifyLaunchBatchV1(receipt({ members: [{ ...receipt().members[1], agentPath: "/root/invalid" }] }), dependencies),
    /must not contain agentPath/u,
  );
  await assert.rejects(
    verifyLaunchBatchV1(receipt({ members: [receipt().members[1], { ...receipt().members[1] }] }), dependencies),
    /duplicate slice identity/u,
  );
  const mismatchedAction = await verifyLaunchBatchV1(receipt({
      members: [{
        ...receipt().members[1],
        actionId: actionId("different-launch"),
      }],
    }), {
      appServerBridge: {
        async inspectMany() {
          throw new Error("identity failure must prevent native reads");
        },
      },
      waveContract: waveContract([waveContract().members[1]]),
      async verifyRuntimeIntelligence() {
        throw new Error("identity failure must prevent route verification");
      },
    });
  assert.equal(mismatchedAction.allVerified, false);
  assert.equal(mismatchedAction.members[0].attentionReason, "launch-action-mismatch");
});

test("batch verification rejects omitted, added, or altered wave members before native reads", async () => {
  const calls = [];
  const dependencies = {
    waveContract: waveContract(),
    appServerBridge: {
      async inspectMany() {
        calls.push("inspect");
      },
    },
  };
  await assert.rejects(
    verifyLaunchBatchV1(
      receipt({ members: [receipt().members[0]] }),
      dependencies,
    ),
    /does not match its persisted wave contract/u,
  );
  await assert.rejects(
    verifyLaunchBatchV1(
      receipt({
        members: [
          receipt().members[0],
          {
            ...receipt().members[1],
            sliceId: "replacement",
            actionId: actionId("replacement"),
          },
        ],
      }),
      dependencies,
    ),
    /member set conflicts/u,
  );
  assert.deepEqual(calls, []);
});
