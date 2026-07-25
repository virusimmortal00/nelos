import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PlanningLifecycleCoordinatorV1,
  PlanningLifecycleStoreV1,
} from "../src/planning-lifecycle.mjs";

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    idempotencyKey: "feature-history-view",
    queenThreadId: "queen-1",
    objective: "Design and ship a task-history view",
    maxParallel: 2,
    receipt: null,
    ...overrides,
  };
}

function plannerResponse(bootstrapId, overrides = {}) {
  return [
    "```nelos-plan",
    JSON.stringify({
      schemaVersion: 1,
      bootstrapId,
      confidence: "high",
      classificationEvidence: ["The implementation has one bounded slice."],
      plan: {
        schemaVersion: 1,
        objective: "Ship a task-history view",
        maxParallel: 2,
        slices: [
          {
            id: "implement",
            title: "Implement history view",
            objective: "Implement the bounded view",
            deliverable: "Working view and tests",
            acceptanceCriteria: ["The view tests pass"],
            dependsOn: [],
            lifecycle: "spinoff",
            workspaceMode: "isolated-write",
            taskShape: "everyday",
          },
        ],
      },
      ...overrides,
    }),
    "```",
  ].join("\n");
}

async function fixture({ title = "Plan and classify the work", status = "active" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nelos-planning-lifecycle-"));
  const store = new PlanningLifecycleStoreV1({
    directory: join(root, "records"),
  });
  const calls = [];
  const thread = {
    schemaVersion: 1,
    threadId: "planner-1",
    title,
    status,
    cwd: "/workspace",
    parentThreadId: "queen-1",
    createdAt: 1,
    updatedAt: 2,
    latestTurn: {
      turnId: "planner-turn",
      status: "completed",
    },
  };
  const dependencies = {
    store,
    sessionsRoot: join(root, "sessions"),
    withLock: async (_bootstrapId, callback) => callback(),
    currentThreadId: () => "queen-1",
    async resolveSubagent(value) {
      calls.push(["resolve", value]);
      return {
        schemaVersion: 1,
        parentThreadId: value.parentThreadId,
        agentPath: value.agentPath,
        threadId: "planner-1",
      };
    },
    async verifyRoute(value) {
      calls.push(["verify", value]);
      return {
        schemaVersion: 1,
        threadId: value.threadId,
        turnId: value.turnId ?? null,
        expected: { model: value.model, effort: value.effort },
        observed: [
          {
            turnId: value.turnId ?? "planner-turn",
            model: value.model,
            effort: value.effort,
            matches: true,
          },
        ],
        verified: true,
      };
    },
  };
  const bridge = {
    async inspect({ threadId }) {
      calls.push(["inspect", threadId]);
      return { ...thread };
    },
    async latestTurn({ threadId }) {
      calls.push(["latest-turn", threadId]);
      return thread.latestTurn === null ? null : { ...thread.latestTurn };
    },
  };
  return {
    root,
    store,
    calls,
    thread,
    bridge,
    coordinator: new PlanningLifecycleCoordinatorV1(dependencies),
    restart() {
      return new PlanningLifecycleCoordinatorV1(dependencies);
    },
  };
}

function launchReceipt(initial) {
  return {
    schemaVersion: 1,
    type: "native-planner-created",
    actionId: initial.nextAction.member.actionId,
    bootstrapId: initial.lifecycle.bootstrapId,
    parentThreadId: "queen-1",
    agentPath: "/root/nelos_planner_feature",
  };
}

function resultReceipt(initial, response) {
  return {
    schemaVersion: 1,
    type: "native-planner-result",
    actionId: `planning-lifecycle-v1/${initial.lifecycle.bootstrapId}/read-result`,
    bootstrapId: initial.lifecycle.bootstrapId,
    threadId: "planner-1",
    turnId: "planner-turn",
    response,
  };
}

test("planning lifecycle is idempotent, restart-safe, and completes from exact receipts", async () => {
  const value = await fixture();
  try {
    const initial = await value.coordinator.advance(request(), {
      appServerBridge: value.bridge,
    });
    assert.equal(initial.lifecycle.phase, "launch-pending");
    assert.equal(initial.nextAction.kind, "launch-planner");
    assert.deepEqual(initial.nextAction.member.nativeTask, {
      model: "gpt-5.6-sol",
      thinking: "medium",
    });
    assert.equal(
      initial.nextAction.member.preconditions.expectedPhase,
      "launch-pending",
    );

    const replay = await value.restart().advance(request(), {
      appServerBridge: value.bridge,
    });
    assert.equal(replay.lifecycle.bootstrapId, initial.lifecycle.bootstrapId);
    assert.equal(replay.nextAction.kind, "reconcile-planner-launch");
    assert.equal(
      replay.nextAction.createActionId,
      initial.nextAction.member.actionId,
    );

    const launched = await value.restart().advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: launchReceipt(initial),
      }),
      { appServerBridge: value.bridge },
    );
    assert.equal(launched.lifecycle.phase, "verified");
    assert.equal(launched.nextAction.kind, "native-wait");
    assert.equal(launched.identity.threadId, "planner-1");

    value.thread.status = "idle";
    const settled = await value.restart().advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: launchReceipt(initial),
      }),
      { appServerBridge: value.bridge },
    );
    assert.equal(settled.nextAction.kind, "native-read");

    const response = plannerResponse(initial.lifecycle.bootstrapId);
    const completed = await value.restart().advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: resultReceipt(initial, response),
      }),
      { appServerBridge: value.bridge },
    );
    assert.equal(completed.lifecycle.phase, "completed");
    assert.equal(completed.plan.summary.spinoffs, 1);
    assert.equal(completed.planning.confidence, "high");

    const completedReplay = await value.restart().advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: resultReceipt(initial, response),
      }),
      { appServerBridge: value.bridge },
    );
    assert.deepEqual(completedReplay.plan, completed.plan);
    assert.equal(completedReplay.lifecycle.phase, "completed");
    const callsBeforeChangedHostReplay = value.calls.length;
    value.thread.status = "systemError";
    value.thread.parentThreadId = "other-queen";
    value.thread.latestTurn = {
      turnId: "newer-planner-turn",
      status: "completed",
    };
    const changedHostReplay = await value.restart().advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: resultReceipt(initial, response),
      }),
      { appServerBridge: value.bridge },
    );
    assert.equal(changedHostReplay.lifecycle.phase, "completed");
    assert.deepEqual(changedHostReplay.plan, completed.plan);
    assert.equal(value.calls.length, callsBeforeChangedHostReplay);
    value.bridge.inspect = async () => {
      throw new Error("host inspection unavailable after restart");
    };
    value.bridge.latestTurn = async () => {
      throw new Error("host turn inspection unavailable after restart");
    };
    const stableReplay = await value.restart().advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: resultReceipt(initial, response),
      }),
      { appServerBridge: value.bridge },
    );
    assert.equal(stableReplay.lifecycle.phase, "completed");
    assert.deepEqual(stableReplay.plan, completed.plan);
    assert.equal(value.calls.length, callsBeforeChangedHostReplay);
    await assert.rejects(
      value.restart().advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt: launchReceipt(initial),
        }),
        { appServerBridge: value.bridge },
      ),
      /stale after result finalization/u,
    );
    assert.equal(
      (await value.store.read(initial.lifecycle.bootstrapId)).phase,
      "completed",
    );

    const recordPath = join(
      value.root,
      "records",
      `${encodeURIComponent(initial.lifecycle.bootstrapId)}.json`,
    );
    const persisted = await readFile(recordPath, "utf8");
    assert.equal(persisted.includes(response), false);
    assert.equal(persisted.includes("Working view and tests"), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("planning lifecycle returns title repair and blocks out-of-order or conflicting receipts", async () => {
  const value = await fixture({ title: "Unexpected planner title" });
  try {
    const initial = await value.coordinator.advance(request(), {
      appServerBridge: value.bridge,
    });
    const launched = await value.coordinator.advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: launchReceipt(initial),
      }),
      { appServerBridge: value.bridge },
    );
    assert.deepEqual(launched.nextAction, {
      schemaVersion: 1,
      kind: "native-set-title",
      actionId: `planning-lifecycle-v1/${initial.lifecycle.bootstrapId}/set-planner-title`,
      threadId: "planner-1",
      title: "Plan and classify the work",
      verify: true,
      after: "repeat-planner-launch-receipt",
    });

    await assert.rejects(
      value.coordinator.advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt: { ...launchReceipt(initial), agentPath: "/root/other" },
        }),
        { appServerBridge: value.bridge },
      ),
      /conflicts with a consumed action/u,
    );

    const separate = await fixture();
    try {
      const otherInitial = await separate.coordinator.advance(
        request({ idempotencyKey: "other-operation" }),
        { appServerBridge: separate.bridge },
      );
      await assert.rejects(
        separate.coordinator.advance(
          request({
            idempotencyKey: "other-operation",
            bootstrapId: otherInitial.lifecycle.bootstrapId,
            receipt: resultReceipt(
              otherInitial,
              plannerResponse(otherInitial.lifecycle.bootstrapId),
            ),
          }),
          { appServerBridge: separate.bridge },
        ),
        /before launch verification/u,
      );
    } finally {
      await rm(separate.root, { recursive: true, force: true });
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("planning lifecycle accepts responses only from the current terminal native turn", async () => {
  const value = await fixture({ status: "idle" });
  try {
    const initial = await value.coordinator.advance(request(), {
      appServerBridge: value.bridge,
    });
    await value.coordinator.advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: launchReceipt(initial),
      }),
      { appServerBridge: value.bridge },
    );
    value.thread.latestTurn = {
      turnId: "newer-planner-turn",
      status: "completed",
    };
    const result = await value.restart().advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: resultReceipt(
          initial,
          plannerResponse(initial.lifecycle.bootstrapId),
        ),
      }),
      { appServerBridge: value.bridge },
    );
    assert.equal(result.nextAction.kind, "attention");
    assert.equal(result.nextAction.reason, "planner-result-turn-not-terminal");
    assert.equal(result.nextAction.retryable, true);
    const record = await value.store.read(initial.lifecycle.bootstrapId);
    assert.equal(record.phase, "verified");
    assert.equal(record.responseDigest, null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("planning lifecycle rejects a result from a failed terminal planner turn", async () => {
  const value = await fixture({ status: "idle" });
  try {
    const initial = await value.coordinator.advance(request(), {
      appServerBridge: value.bridge,
    });
    await value.coordinator.advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: launchReceipt(initial),
      }),
      { appServerBridge: value.bridge },
    );
    value.thread.latestTurn.status = "failed";
    const result = await value.coordinator.advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: resultReceipt(
          initial,
          plannerResponse(initial.lifecycle.bootstrapId),
        ),
      }),
      { appServerBridge: value.bridge },
    );
    assert.equal(result.nextAction.kind, "attention");
    assert.equal(result.nextAction.reason, "planner-result-turn-failed");
    assert.equal(result.nextAction.retryable, false);
    const record = await value.store.read(initial.lifecycle.bootstrapId);
    assert.equal(record.phase, "verified");
    assert.equal(record.responseDigest, null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("planning lifecycle fails closed on topology, route, active-result, and low-confidence evidence", async (t) => {
  await t.test("wrong parent", async () => {
    const value = await fixture();
    try {
      value.thread.parentThreadId = "other-queen";
      const initial = await value.coordinator.advance(request(), {
        appServerBridge: value.bridge,
      });
      const result = await value.coordinator.advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt: launchReceipt(initial),
        }),
        { appServerBridge: value.bridge },
      );
      assert.equal(result.nextAction.kind, "attention");
      assert.equal(result.nextAction.reason, "planner-topology-mismatch");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  await t.test("route mismatch", async () => {
    const value = await fixture();
    try {
      value.coordinator = new PlanningLifecycleCoordinatorV1({
        store: value.store,
        withLock: async (_id, callback) => callback(),
        currentThreadId: () => "queen-1",
        resolveSubagent: async ({ parentThreadId, agentPath }) => ({
          parentThreadId,
          agentPath,
          threadId: "planner-1",
        }),
        verifyRoute: async () => ({ verified: false }),
      });
      const initial = await value.coordinator.advance(request(), {
        appServerBridge: value.bridge,
      });
      const result = await value.coordinator.advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt: launchReceipt(initial),
        }),
        { appServerBridge: value.bridge },
      );
      assert.equal(result.nextAction.kind, "attention");
      assert.equal(result.nextAction.reason, "planner-route-mismatch");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  await t.test("unsettled identity evidence is retryable attention", async () => {
    const value = await fixture();
    try {
      value.coordinator = new PlanningLifecycleCoordinatorV1({
        store: value.store,
        withLock: async (_id, callback) => callback(),
        currentThreadId: () => "queen-1",
        resolveSubagent: async () => {
          throw new Error("session metadata is still settling");
        },
      });
      const initial = await value.coordinator.advance(request(), {
        appServerBridge: value.bridge,
      });
      const attention = await value.coordinator.advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt: launchReceipt(initial),
        }),
        { appServerBridge: value.bridge },
      );
      assert.equal(attention.nextAction.kind, "attention");
      assert.equal(
        attention.nextAction.reason,
        "planner-identity-evidence-unavailable",
      );
      assert.equal(attention.nextAction.retryable, true);
      assert.equal(attention.lifecycle.phase, "launch-pending");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  await t.test("active result and low confidence", async () => {
    const value = await fixture();
    try {
      const initial = await value.coordinator.advance(request(), {
        appServerBridge: value.bridge,
      });
      await value.coordinator.advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt: launchReceipt(initial),
        }),
        { appServerBridge: value.bridge },
      );
      const response = plannerResponse(initial.lifecycle.bootstrapId, {
        confidence: "low",
      });
      const active = await value.coordinator.advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt: resultReceipt(initial, response),
        }),
        { appServerBridge: value.bridge },
      );
      assert.equal(active.nextAction.kind, "native-wait");
      value.thread.status = "idle";
      const attention = await value.coordinator.advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt: resultReceipt(initial, response),
        }),
        { appServerBridge: value.bridge },
      );
      assert.equal(attention.lifecycle.phase, "attention");
      assert.equal(attention.nextAction.reason, "low-planner-confidence");
      const unavailableBridge = new Proxy({}, {
        get() {
          throw new Error("terminal attention replay must not read host state");
        },
      });
      assert.deepEqual(
        await value.restart().advance(
          request({
            bootstrapId: initial.lifecycle.bootstrapId,
            receipt: resultReceipt(initial, response),
          }),
          { appServerBridge: unavailableBridge },
        ),
        attention,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});

test("planning lifecycle rejects idempotency-key reuse with different intent", async () => {
  const value = await fixture();
  try {
    await value.coordinator.advance(request(), {
      appServerBridge: value.bridge,
    });
    await assert.rejects(
      value.coordinator.advance(
        request({ objective: "A materially different objective" }),
        { appServerBridge: value.bridge },
      ),
      /already bound to different intent/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("planning lifecycle binds queen identity to the current host task", async () => {
  const value = await fixture();
  try {
    value.coordinator = new PlanningLifecycleCoordinatorV1({
      store: value.store,
      withLock: async (_id, callback) => callback(),
      currentThreadId: () => "other-queen",
    });
    await assert.rejects(
      value.coordinator.advance(request(), {
        appServerBridge: value.bridge,
      }),
      /must match the current host task identity/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
