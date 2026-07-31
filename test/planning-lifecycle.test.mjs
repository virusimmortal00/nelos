import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const sliceIdSuffix = bootstrapId.slice(5, 17);
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
            id: `implement-${sliceIdSuffix}`,
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

async function fixture({
  title = null,
  status = "notLoaded",
  latestTurnStatus = "inProgress",
  collaborationStatus = "unavailable",
} = {}) {
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
      status: latestTurnStatus,
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
  const collaboration = {
    status: collaborationStatus,
    parentTurnId:
      collaborationStatus === "unavailable" ? null : "queen-turn",
    toolCallId:
      collaborationStatus === "unavailable" ? null : "spawn-planner",
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
    async collaborationAgentStatus(value) {
      calls.push(["collaboration-agent-status", value]);
      return { ...collaboration };
    },
  };
  return {
    root,
    store,
    calls,
    thread,
    collaboration,
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
    assert.equal(launched.nextAction.kind, "native-wait-subagent");
    assert.equal(launched.identity.lifecycle, "subagent");
    assert.equal(launched.identity.memberKind, "joined-subagent");
    assert.equal(launched.identity.primaryId, "agentPath");
    assert.equal(launched.identity.controlSurface, "collaboration");
    assert.equal(launched.identity.threadId, "planner-1");

    value.thread.latestTurn.status = "completed";
    const settled = await value.restart().advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: launchReceipt(initial),
      }),
      { appServerBridge: value.bridge },
    );
    assert.equal(settled.nextAction.kind, "native-read-subagent-result");
    assert.equal(
      settled.nextAction.bootstrapId,
      initial.lifecycle.bootstrapId,
    );

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

test("default cleanup intent replays records written with the explicit-default digest", async () => {
  const value = await fixture();
  try {
    const requested = request();
    const initial = await value.coordinator.advance(requested, {
      appServerBridge: value.bridge,
    });
    const record = await value.store.read(initial.lifecycle.bootstrapId);
    const explicitDefaultDigest = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 1,
          idempotencyKey: requested.idempotencyKey,
          queenThreadId: requested.queenThreadId,
          objective: requested.objective,
          context: "",
          maxParallel: requested.maxParallel,
          cleanupIntended: true,
        }),
        "utf8",
      )
      .digest("hex");
    await value.store.write(
      {
        ...record,
        revision: record.revision + 1,
        requestDigest: explicitDefaultDigest,
      },
      { expectedRevision: record.revision },
    );
    const replay = await value.restart().advance(requested, {
      appServerBridge: value.bridge,
    });
    assert.equal(replay.nextAction.kind, "reconcile-planner-launch");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("planning lifecycle ignores unsupported subagent titles and blocks conflicting receipts", async () => {
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
      kind: "native-wait-subagent",
      actionId: `planning-lifecycle-v1/${initial.lifecycle.bootstrapId}/wait`,
      agentPath: "/root/nelos_planner_feature",
      threadId: "planner-1",
      turnId: "planner-turn",
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
  const value = await fixture({
    status: "idle",
    collaborationStatus: "completed",
  });
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

test("planning lifecycle reconciles interrupted app-server state through running collaboration state and success", async (t) => {
  for (const status of ["active", "notLoaded"]) {
    await t.test(status, async () => {
      const value = await fixture({
        status,
        latestTurnStatus: "interrupted",
        collaborationStatus: "running",
      });
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
        assert.equal(launched.lifecycle.phase, "verified");
        assert.deepEqual(launched.nextAction, {
          schemaVersion: 1,
          kind: "native-wait-subagent",
          actionId: `planning-lifecycle-v1/${initial.lifecycle.bootstrapId}/wait`,
          agentPath: "/root/nelos_planner_feature",
          threadId: "planner-1",
          turnId: "planner-turn",
          after: "repeat-planner-launch-receipt",
          reconciliation: {
            reason: "planner-turn-observation-conflict",
            retryable: true,
            appServerTurnStatus: "interrupted",
            nativeCollaborationStatus: "running",
            unavailableObservations: 0,
            maximumUnavailableObservations: 3,
          },
        });
        assert.equal(
          (await value.store.read(initial.lifecycle.bootstrapId))
            .interruptedTurnReconciliations,
          0,
        );

        const replayed = await value.restart().advance(
          request({
            bootstrapId: initial.lifecycle.bootstrapId,
            receipt: launchReceipt(initial),
          }),
          { appServerBridge: value.bridge },
        );
        assert.equal(replayed.nextAction.kind, "native-wait-subagent");
        assert.equal(replayed.nextAction.reconciliation.unavailableObservations, 0);
        assert.equal(replayed.identity.agentPath, "/root/nelos_planner_feature");

        value.thread.status = "idle";
        value.collaboration.status = "completed";
        const settled = await value.restart().advance(
          request({
            bootstrapId: initial.lifecycle.bootstrapId,
            receipt: launchReceipt(initial),
          }),
          { appServerBridge: value.bridge },
        );
        assert.equal(settled.nextAction.kind, "native-read-subagent-result");
        assert.equal(
          settled.nextAction.bootstrapId,
          initial.lifecycle.bootstrapId,
        );
        assert.equal(
          settled.nextAction.actionId,
          `planning-lifecycle-v1/${initial.lifecycle.bootstrapId}/read-result`,
        );
        assert.equal(settled.nextAction.turnId, "planner-turn");
        assert.equal(settled.nextAction.agentPath, "/root/nelos_planner_feature");
        assert.equal(settled.nextAction.threadId, "planner-1");
        assert.equal(settled.nextAction.purpose, "read-planner-result");
        assert.equal(settled.nextAction.kind === "attention", false);
      } finally {
        await rm(value.root, { recursive: true, force: true });
      }
    });
  }
});

test("planning lifecycle explains how to recover from an early planner result", async () => {
  const value = await fixture({
    status: "active",
    latestTurnStatus: "interrupted",
  });
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
    assert.equal(launched.nextAction.kind, "native-wait-subagent");

    const receipt = resultReceipt(
      initial,
      plannerResponse(initial.lifecycle.bootstrapId),
    );
    receipt.actionId =
      `planning-lifecycle-v1/${initial.lifecycle.bootstrapId}/result`;
    await assert.rejects(
      value.restart().advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt,
        }),
        { appServerBridge: value.bridge },
      ),
      (error) => {
        assert.equal(error.name, "PlanningLifecycleProtocolError");
        assert.equal(error.code, "planner.result-not-yet-authorized");
        assert.equal(error.retryable, true);
        assert.equal(
          error.recoveryCommand,
          "repeat-planner-launch-receipt",
        );
        assert.deepEqual(error.protocolError, {
          schemaVersion: 1,
          code: "planner.result-not-yet-authorized",
          category: "retryable-attention",
          message: error.message,
          recoveryCommand: "repeat-planner-launch-receipt",
        });
        assert.match(error.message, /native-read-subagent-result/);
        return true;
      },
    );

    const record = await value.store.read(initial.lifecycle.bootstrapId);
    assert.equal(record.phase, "verified");
    assert.equal(record.responseDigest, null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("planning lifecycle persists and exhausts a bounded lost-planner reconciliation across restarts", async () => {
  const value = await fixture({
    status: "notLoaded",
    latestTurnStatus: "interrupted",
  });
  try {
    const initial = await value.coordinator.advance(request(), {
      appServerBridge: value.bridge,
    });
    for (const observation of [1, 2, 3]) {
      const reconciled = await value.restart().advance(
        request({
          bootstrapId: initial.lifecycle.bootstrapId,
          receipt: launchReceipt(initial),
        }),
        { appServerBridge: value.bridge },
      );
      assert.equal(reconciled.nextAction.kind, "native-wait-subagent");
      assert.equal(
        reconciled.nextAction.reconciliation.unavailableObservations,
        observation,
      );
    }

    const terminated = await value.restart().advance(
      request({
        bootstrapId: initial.lifecycle.bootstrapId,
        receipt: launchReceipt(initial),
      }),
      { appServerBridge: value.bridge },
    );
    assert.equal(terminated.nextAction.kind, "attention");
    assert.equal(terminated.nextAction.reason, "planner-lost");
    assert.equal(terminated.nextAction.retryable, false);
    assert.equal(terminated.nextAction.turnId, "planner-turn");
    assert.equal(
      (await value.store.read(initial.lifecycle.bootstrapId))
        .interruptedTurnReconciliations,
      3,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("planning lifecycle keeps failed and error planner turns fail-closed", async (t) => {
  for (const scenario of [
    { threadStatus: "active", turnStatus: "failed" },
    { threadStatus: "notLoaded", turnStatus: "error" },
  ]) {
    await t.test(
      `${scenario.threadStatus}/${scenario.turnStatus}`,
      async () => {
        const value = await fixture({
          status: scenario.threadStatus,
          latestTurnStatus: scenario.turnStatus,
          collaborationStatus: "running",
        });
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
          assert.equal(launched.nextAction.kind, "attention");
          assert.equal(launched.nextAction.reason, "planner-turn-failed");
        } finally {
          await rm(value.root, { recursive: true, force: true });
        }
      },
    );
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
      assert.equal(active.nextAction.kind, "native-wait-subagent");
      value.thread.latestTurn.status = "completed";
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

test("planning lifecycle uses the explicit queen identity without ambient host state", async () => {
  const value = await fixture();
  try {
    value.coordinator = new PlanningLifecycleCoordinatorV1({
      store: value.store,
      withLock: async (_id, callback) => callback(),
    });
    const result = await value.coordinator.advance(request(), {
      appServerBridge: value.bridge,
    });
    assert.equal(result.nextAction.kind, "launch-planner");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
