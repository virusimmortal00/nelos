import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DurableSpinoffCompositionV1 } from "../src/durable-spinoff-composition.mjs";
import { ExecutionStoreV1 } from "../src/execution-store.mjs";
import { McpOrchestrationAdapterV1 } from "../src/mcp-orchestration.mjs";
import { QueenAcceptanceStoreV1 } from "../src/queen-acceptance.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";
import {
  SpinoffLifecycleAdapterV1,
  SpinoffLifecycleStoreV1,
} from "../src/spinoff-lifecycle.mjs";

test("the durable spin-off composition is a public package subpath", async () => {
  const imported = await import("nelos/durable-spinoff-composition");
  assert.equal(
    imported.DurableSpinoffCompositionV1,
    DurableSpinoffCompositionV1,
  );
});

function plan() {
  return planWorkSlices({
    schemaVersion: 1,
    objective: "Exercise the durable spin-off composition.",
    slices: [
      {
        id: "upstream",
        title: "Upstream",
        objective: "Produce the upstream result.",
        deliverable: "A verified upstream result.",
        acceptanceCriteria: ["The upstream result is verified."],
        dependsOn: [],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
      {
        id: "dependent",
        title: "Dependent",
        objective: "Consume the accepted upstream result.",
        deliverable: "A verified dependent result.",
        acceptanceCriteria: ["The dependent result is verified."],
        dependsOn: ["upstream"],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
    ],
  });
}

function resultEnvelope(workUnitId, summary) {
  return {
    schemaVersion: 1,
    workUnitId,
    specRevision: 1,
    attempt: 1,
    outcome: "succeeded",
    summary,
    artifacts: [],
    verification: ["restart-safe integration fixture"],
    blockers: [],
    recoveryHint: null,
  };
}

function createReceipt(effect, memberThreadId) {
  return {
    schemaVersion: 1,
    type: "native-create",
    actionId: effect.actionId,
    workUnitId: effect.workUnitId,
    specRevision: effect.specRevision,
    attempt: effect.attempt,
    memberThreadId,
  };
}

function wakeReceipt(effect) {
  return { threadId: effect.threadId };
}

function archiveReceipt(effect) {
  return {
    schemaVersion: 1,
    actionId: effect.actionId,
    type: "native-archive",
    threadId: effect.threadId,
    archived: true,
  };
}

function resultReceipt(workUnit, sourceTurnId, resultEnvelopeValue) {
  return {
    schemaVersion: 1,
    type: "native-result-read",
    actionId:
      `observation-v1/result/${encodeURIComponent(workUnit.workUnitId)}` +
      `/r${workUnit.specRevision}/a${workUnit.attempt}` +
      `/b${workUnit.binding.generation}/${encodeURIComponent(sourceTurnId)}`,
    workUnitId: workUnit.workUnitId,
    specRevision: workUnit.specRevision,
    attempt: workUnit.attempt,
    bindingGeneration: workUnit.binding.generation,
    memberThreadId: workUnit.binding.memberThreadId,
    requestedTurnId: sourceTurnId,
    sourceTurnId,
    resultEnvelope: resultEnvelopeValue,
  };
}

test("planned spin-offs compose through restart-safe launch, wake, acceptance, dependent advancement, and cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-durable-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executionDirectory = join(root, "executions");
  const acceptanceDirectory = join(root, "acceptances");
  const lifecycleDirectory = join(root, "lifecycle");
  const deliveries = [];
  const archived = [];
  const bridge = {
    async latestTurn({ threadId }) {
      return {
        turnId:
          threadId === "task-upstream"
            ? "turn-upstream"
            : "turn-dependent",
        status: "completed",
      };
    },
  };

  function restarted(callerThreadId) {
    const executionStore = new ExecutionStoreV1({
      directory: executionDirectory,
    });
    const acceptanceStore = new QueenAcceptanceStoreV1({
      directory: acceptanceDirectory,
    });
    const lifecycle = new SpinoffLifecycleAdapterV1({
      executionStore,
      acceptanceStore,
      store: new SpinoffLifecycleStoreV1({
        directory: lifecycleDirectory,
      }),
      callerThreadId: () => callerThreadId,
      wakeRetryDelays: [],
    });
    return {
      executionStore,
      composition: new DurableSpinoffCompositionV1({
        executionStore,
        acceptanceStore,
        orchestration: new McpOrchestrationAdapterV1({
          store: executionStore,
        }),
        lifecycle,
        callerThreadId: () => callerThreadId,
        now: () => "2026-07-24T12:00:00.000Z",
      }),
    };
  }

  const initial = restarted("queen");
  await assert.rejects(
    restarted("other-queen").composition.persistPlan({
      plan: plan(),
      webId: "A1",
      queenThreadId: "queen",
    }),
    /only the plan's queen/u,
  );
  const persisted = await initial.composition.persistPlan({
    plan: plan(),
    webId: "A1",
    queenThreadId: "queen",
  });
  assert.deepEqual(persisted.persistedWorkUnitIds, ["dependent", "upstream"]);
  assert.equal((await initial.executionStore.read("dependent")).binding.state, "unbound");
  assert.equal((await initial.executionStore.read("upstream")).binding.state, "launch-pending");
  assert.deepEqual(
    persisted.launches.flatMap(({ effects }) => effects.map(({ workUnitId }) => workUnitId)),
    ["upstream"],
  );

  const upstreamEffect = persisted.launches[0].effects[0];
  await restarted("queen").composition.bindNativeCreate({
    workUnitId: "upstream",
    receipt: createReceipt(upstreamEffect, "task-upstream"),
  });

  const upstreamCompletion = {
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "upstream",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "task-upstream",
    outcome: "succeeded",
    summary: "UPSTREAM_RESULT",
    receipt: null,
  };
  const upstreamWake = await restarted("task-upstream").composition.complete(
    upstreamCompletion,
  );
  deliveries.push(upstreamWake.effects[0]);
  await restarted("task-upstream").composition.complete({
    ...upstreamCompletion,
    receipt: wakeReceipt(upstreamWake.effects[0]),
  });
  assert.equal(deliveries.length, 1);

  const upstream = await restarted("queen").executionStore.read("upstream");
  await assert.rejects(
    restarted("queen").composition.acceptNativeResult({
      webId: "A1",
      queenThreadId: "queen",
      receipt: {
        ...resultReceipt(
          upstream,
          "turn-upstream",
          resultEnvelope("upstream", "UPSTREAM_RESULT"),
        ),
        actionId: "observation-v1/result/stale",
      },
    }, bridge),
    /does not match the current durable binding/u,
  );
  await assert.rejects(
    restarted("queen").composition.acceptNativeResult({
      webId: "A1",
      queenThreadId: "queen",
      receipt: resultReceipt(
        upstream,
        "turn-upstream",
        resultEnvelope("upstream", "UPSTREAM_RESULT"),
      ),
    }, {
      async latestTurn() {
        return { turnId: "newer-turn", status: "completed" };
      },
    }),
    /not from the latest successful turn/u,
  );
  const acceptedUpstream = await restarted("queen").composition.acceptNativeResult({
    webId: "A1",
    queenThreadId: "queen",
    receipt: resultReceipt(
      upstream,
      "turn-upstream",
      resultEnvelope("upstream", "UPSTREAM_RESULT"),
    ),
  }, bridge);
  assert.deepEqual(acceptedUpstream.readiness.readyWorkUnitIds, ["dependent"]);
  assert.equal(acceptedUpstream.launches.length, 1);
  assert.equal(acceptedUpstream.launches[0].effects[0].type, "native-create");
  assert.equal(acceptedUpstream.launches[0].effects[0].workUnitId, "dependent");

  const dependentEffect = acceptedUpstream.launches[0].effects[0];
  await restarted("queen").composition.bindNativeCreate({
    workUnitId: "dependent",
    receipt: createReceipt(dependentEffect, "task-dependent"),
  });
  const dependentCompletion = {
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "dependent",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "task-dependent",
    outcome: "succeeded",
    summary: "DEPENDENT_RESULT",
    receipt: null,
  };
  const dependentWake = await restarted("task-dependent").composition.complete(
    dependentCompletion,
  );
  deliveries.push(dependentWake.effects[0]);
  await restarted("task-dependent").composition.complete({
    ...dependentCompletion,
    receipt: wakeReceipt(dependentWake.effects[0]),
  });
  const dependent = await restarted("queen").executionStore.read("dependent");
  await restarted("queen").composition.acceptNativeResult({
    webId: "A1",
    queenThreadId: "queen",
    receipt: resultReceipt(
      dependent,
      "turn-dependent",
      resultEnvelope("dependent", "DEPENDENT_RESULT"),
    ),
  }, bridge);

  const cleanup = restarted("queen").composition;
  const archiveRequest = await cleanup.cleanup({
    webId: "A1",
    queenThreadId: "queen",
  });
  assert.equal(archiveRequest.policy, "auto");
  assert.equal(archiveRequest.state, "effects-required");
  archived.push(...archiveRequest.effects.map(({ threadId }) => threadId));
  const completedCleanup = await cleanup.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    archiveReceipts: archiveRequest.effects.map(archiveReceipt),
  });
  assert.equal(completedCleanup.state, "complete");
  assert.deepEqual(archived, ["task-dependent", "task-upstream"]);
});
