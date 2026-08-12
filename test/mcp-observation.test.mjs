import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionStoreV1,
  createWorkUnitSpecV1,
} from "../src/execution-store.mjs";
import { McpJoinAdapterV1 } from "../src/mcp-observation.mjs";
import { OrchestrationCheckpointStoreV1 } from "../src/orchestration-checkpoint-store.mjs";
import {
  createPlanRunV1,
  PlanRunStoreV1,
} from "../src/plan-run-store.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";

function workUnit(overrides = {}) {
  return createWorkUnitSpecV1({
    schemaVersion: 1,
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result"],
    title: "🕷️ A1 · Alpha",
    objectiveSummary: "Implement alpha.",
    deliverable: "Source and tests.",
    acceptanceCriteria: ["Tests pass"],
    dependencies: [],
    required: true,
    policy: {
      maxAttempts: 3,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    },
    ...overrides,
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-mcp-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executionStore = new ExecutionStoreV1({
    directory: join(root, "executions"),
  });
  const checkpointStore = new OrchestrationCheckpointStoreV1({
    directory: join(root, "checkpoints"),
  });
  const acceptanceStore = {
    decisions: [],
    async list() {
      return this.decisions;
    },
  };
  const planRunStore = new PlanRunStoreV1({
    directory: join(root, "plan-runs"),
  });
  return {
    root,
    executionStore,
    checkpointStore,
    acceptanceStore,
    planRunStore,
    adapter: () =>
      new McpJoinAdapterV1({
        executionStore,
        checkpointStore,
        acceptanceStore,
        planRunStore,
      }),
  };
}

async function bind(store, record, memberThreadId = "thread-alpha") {
  await store.create(record);
  await store.markLaunchPending({
    workUnitId: record.workUnitId,
    specRevision: record.specRevision,
    launchActionId: "launch-alpha",
  });
  await store.bind({
    workUnitId: record.workUnitId,
    specRevision: record.specRevision,
    launchActionId: "launch-alpha",
    memberThreadId,
  });
}

test("lazy migration ignores unbound/pending records and never rewrites execution files", async (t) => {
  const current = await fixture(t);
  const unbound = workUnit();
  await current.executionStore.create(unbound);
  const before = await readFile(join(current.root, "executions", "alpha.json"), "utf8");
  let advanced = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(advanced.checkpoint.members, []);
  assert.deepEqual(advanced.join.effects, []);
  assert.deepEqual(advanced.join.boundary, {
    type: "waiting",
    reason: "required-members-unbound",
  });

  await current.executionStore.markLaunchPending({
    workUnitId: "alpha",
    specRevision: 1,
    launchActionId: "launch-alpha",
  });
  advanced = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(advanced.checkpoint.members, []);
  assert.deepEqual(advanced.join.boundary, {
    type: "waiting",
    reason: "required-members-unbound",
  });
  assert.notEqual(
    await readFile(join(current.root, "executions", "alpha.json"), "utf8"),
    before,
    "only the legacy store's own transition changes its file",
  );
  const pending = await readFile(join(current.root, "executions", "alpha.json"), "utf8");
  await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.equal(
    await readFile(join(current.root, "executions", "alpha.json"), "utf8"),
    pending,
    "checkpoint migration never rewrites ExecutionStoreV1",
  );
});

test("unknown webs fail closed instead of implying parent continuation", async (t) => {
  const current = await fixture(t);
  await assert.rejects(
    current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: null,
    }),
    /found no execution work units/,
  );
});

test("malformed records from another orchestration do not block advance", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  await writeFile(
    join(current.root, "executions", "unrelated.json"),
    "{not-json\n",
  );
  const advanced = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.equal(advanced.checkpoint.members[0].workUnitId, "alpha");
});

test("bound v1 records migrate lazily and reconstruct byte-stable effects after restart", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  const first = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(first.join.effects.map(({ type }) => type), [
    "native-read-title",
    "native-wait",
  ]);
  const restarted = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(restarted, first);
  assert.equal(restarted.checkpoint.members[0].title.state, "pending");
  assert.equal(restarted.checkpoint.members[0].execution.state, "unknown");
  assert.equal(restarted.checkpoint.members[0].result.state, "absent");
  assert.equal(restarted.checkpoint.members[0].coordination.state, "unjoined");
});

test("adapter persists receipts before returning the deterministic next action", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  const initial = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const title = initial.join.effects.find(({ type }) => type === "native-read-title");
  const receipt = {
    schemaVersion: 1,
    type: "native-title-observed",
    actionId: title.actionId,
    workUnitId: title.workUnitId,
    specRevision: title.specRevision,
    attempt: title.attempt,
    bindingGeneration: title.bindingGeneration,
    memberThreadId: title.memberThreadId,
    requestedTitle: title.requestedTitle,
    observedTitle: title.requestedTitle,
  };
  const observed = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt,
  });
  assert.equal(observed.checkpoint.members[0].title.state, "verified");
  assert.deepEqual(observed.join.effects.map(({ type }) => type), ["native-wait"]);
  const replay = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt,
  });
  assert.deepEqual(replay, observed);
  await assert.rejects(
    current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: { ...receipt, observedTitle: "conflict" },
    }),
    /conflicts with a consumed actionId/,
  );
});

test("independent adapters serialize a conflicting receipt race", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  const initial = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const title = initial.join.effects.find(({ type }) => type === "native-read-title");
  const base = {
    schemaVersion: 1,
    type: "native-title-observed",
    actionId: title.actionId,
    workUnitId: title.workUnitId,
    specRevision: title.specRevision,
    attempt: title.attempt,
    bindingGeneration: title.bindingGeneration,
    memberThreadId: title.memberThreadId,
    requestedTitle: title.requestedTitle,
  };
  const results = await Promise.allSettled([
    current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: { ...base, observedTitle: title.requestedTitle },
    }),
    current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: { ...base, observedTitle: "conflict" },
    }),
  ]);
  assert.deepEqual(
    results.map(({ status }) => status).sort(),
    ["fulfilled", "rejected"],
  );
});

test("acceptance advances collection to continuation without claiming Desktop wakeup", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit());
  const initial = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const wait = initial.join.effects.find(({ type }) => type === "native-wait");
  const waitReceipt = {
    schemaVersion: 1,
    type: "native-wait",
    actionId: wait.actionId,
    webId: "A1",
    queenThreadId: "queen",
    status: "event",
    targets: wait.targets.map((target) => ({
      ...target,
      nextCursor: "cursor-1",
      lifecycle: "completed",
      latestTurnId: "turn-1",
      attentionRequired: false,
    })),
  };
  const terminal = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: waitReceipt,
  });
  const read = terminal.join.effects.find(({ type }) => type === "native-read-result");
  const result = {
    schemaVersion: 1,
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    outcome: "succeeded",
    summary: "done",
    artifacts: [],
    verification: [],
    blockers: [],
    recoveryHint: null,
  };
  const collected = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-result-read",
      actionId: read.actionId,
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
      bindingGeneration: 1,
      memberThreadId: "thread-alpha",
      requestedTurnId: "turn-1",
      sourceTurnId: "turn-1",
      resultEnvelope: result,
    },
  });
  assert.equal(collected.join.boundary.type, "decide");
  current.acceptanceStore.decisions.push({
    decision: "accepted",
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "thread-alpha",
    sourceTurnId: "turn-1",
  });
  const continued = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(continued.join.boundary, {
    type: "continue",
    reason: "all-required-results-accepted",
    automaticWake: false,
  });
  assert.deepEqual(continued.nextAction, {
    schemaVersion: 1,
    kind: "cleanup-spinoffs",
    tool: "nelos_spinoff_cleanup",
    arguments: {
      webId: "A1",
      queenThreadId: "queen",
    },
  });
});

test("a consumed malformed result enters bounded correction and joins the later valid turn", async (t) => {
  const current = await fixture(t);
  await bind(current.executionStore, workUnit({
    capabilities: ["observe", "read-result", "follow-up"],
  }));
  const initial = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const wait = initial.join.effects.find(({ type }) => type === "native-wait");
  const terminal = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-wait",
      actionId: wait.actionId,
      webId: "A1",
      queenThreadId: "queen",
      status: "event",
      targets: wait.targets.map((target) => ({
        ...target,
        nextCursor: "cursor-malformed",
        lifecycle: "completed",
        latestTurnId: "turn-malformed",
        attentionRequired: false,
      })),
    },
  });
  const read = terminal.join.effects.find(
    ({ type }) => type === "native-read-result",
  );
  const malformedReceipt = {
    schemaVersion: 1,
    type: "native-result-read",
    actionId: read.actionId,
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    bindingGeneration: 1,
    memberThreadId: "thread-alpha",
    requestedTurnId: "turn-malformed",
    sourceTurnId: "turn-malformed",
    resultEnvelope: {
      schemaVersion: 1,
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
      outcome: "succeeded",
      summary: "The work passed, but the evidence item has the wrong shape.",
      artifacts: [],
      verification: [{ command: "npm test", outcome: "passed" }],
      blockers: [],
      recoveryHint: null,
    },
  };
  const malformed = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: malformedReceipt,
  });
  assert.equal(malformed.checkpoint.members[0].result.state, "malformed");
  assert.equal(
    malformed.checkpoint.members[0].coordination.state,
    "correction-pending",
  );
  assert.deepEqual(malformed.join.boundary, {
    type: "action",
    reason: "rejected-results-require-correction",
  });
  assert.equal(
    malformed.join.effects.some(({ type }) => type === "native-read-result"),
    false,
  );
  const followUp = malformed.join.effects.find(
    ({ type }) => type === "native-follow-up",
  );
  assert.equal(followUp.rejectedSourceTurnId, "turn-malformed");
  assert.equal(followUp.nextAttempt, 2);
  assert.match(followUp.prompt, /malformed result rejected by the orchestration contract/u);

  const replayedMalformed = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: malformedReceipt,
  });
  assert.deepEqual(replayedMalformed, malformed);

  const restarted = current.adapter();
  const legacyCheckpoint = structuredClone(replayedMalformed.checkpoint);
  legacyCheckpoint.checkpointRevision += 1;
  legacyCheckpoint.members[0].coordination.state = "waiting";
  legacyCheckpoint.members[0].execution.attentionRequired = false;
  await current.checkpointStore.write(legacyCheckpoint, {
    expectedRevision: replayedMalformed.checkpoint.checkpointRevision,
  });
  const migrated = await restarted.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.equal(
    migrated.checkpoint.members[0].coordination.state,
    "correction-pending",
  );
  assert.deepEqual(
    migrated.checkpoint.consumedReceipts,
    legacyCheckpoint.consumedReceipts,
  );
  assert.equal(
    migrated.join.effects.find(({ type }) => type === "native-follow-up").actionId,
    followUp.actionId,
  );

  const correctionWaiting = await restarted.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-follow-up-delivered",
      actionId: followUp.actionId,
      workUnitId: followUp.workUnitId,
      specRevision: followUp.specRevision,
      attempt: followUp.attempt,
      bindingGeneration: followUp.bindingGeneration,
      memberThreadId: followUp.memberThreadId,
      rejectedSourceTurnId: followUp.rejectedSourceTurnId,
      nextAttempt: followUp.nextAttempt,
    },
  });
  assert.equal((await current.executionStore.read("alpha")).attempt, 2);
  const correctionWait = correctionWaiting.join.effects.find(
    ({ type }) => type === "native-wait",
  );
  const correctionTerminal = await restarted.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-wait",
      actionId: correctionWait.actionId,
      webId: "A1",
      queenThreadId: "queen",
      status: "event",
      targets: correctionWait.targets.map((target) => ({
        ...target,
        nextCursor: "cursor-corrected",
        lifecycle: "completed",
        latestTurnId: "turn-corrected",
        attentionRequired: false,
      })),
    },
  });
  const correctionRead = correctionTerminal.join.effects.find(
    ({ type }) => type === "native-read-result",
  );
  const corrected = await restarted.advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-result-read",
      actionId: correctionRead.actionId,
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 2,
      bindingGeneration: 1,
      memberThreadId: "thread-alpha",
      requestedTurnId: "turn-corrected",
      sourceTurnId: "turn-corrected",
      resultEnvelope: {
        schemaVersion: 1,
        workUnitId: "alpha",
        specRevision: 1,
        attempt: 2,
        outcome: "succeeded",
        summary: "The corrected result uses the contract shape.",
        artifacts: [],
        verification: ["npm test passed"],
        blockers: [],
        recoveryHint: null,
      },
    },
  });
  assert.equal(corrected.checkpoint.members[0].result.state, "current");
  assert.equal(
    corrected.checkpoint.members[0].result.sourceTurnId,
    "turn-corrected",
  );
  assert.equal(corrected.join.boundary.type, "decide");
  assert.equal(
    corrected.checkpoint.consumedReceipts.some(
      ({ actionId }) => actionId === malformedReceipt.actionId,
    ),
    true,
    "the rejected receipt remains immutable audit evidence",
  );
});

test("malformed results without a correction path remain fail-closed", async (t) => {
  const scenarios = [
    {
      overrides: { capabilities: ["observe", "read-result"] },
      sourceTurnId: "turn-malformed",
    },
    {
      overrides: {
        capabilities: ["observe", "read-result", "follow-up"],
        policy: {
          maxAttempts: 1,
          onBlocked: "queen-review",
          onFailure: "queen-review",
        },
      },
      sourceTurnId: "turn-malformed",
    },
    {
      overrides: {
        capabilities: ["observe", "read-result", "follow-up"],
      },
      sourceTurnId: "stale-source-turn",
    },
  ];
  for (const { overrides, sourceTurnId } of scenarios) {
    const current = await fixture(t);
    await bind(current.executionStore, workUnit(overrides));
    const initial = await current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: null,
    });
    const wait = initial.join.effects.find(({ type }) => type === "native-wait");
    const terminal = await current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: {
        schemaVersion: 1,
        type: "native-wait",
        actionId: wait.actionId,
        webId: "A1",
        queenThreadId: "queen",
        status: "event",
        targets: wait.targets.map((target) => ({
          ...target,
          nextCursor: "cursor-malformed",
          lifecycle: "completed",
          latestTurnId: "turn-malformed",
          attentionRequired: false,
        })),
      },
    });
    const read = terminal.join.effects.find(
      ({ type }) => type === "native-read-result",
    );
    const malformed = await current.adapter().advance({
      webId: "A1",
      queenThreadId: "queen",
      receipt: {
        schemaVersion: 1,
        type: "native-result-read",
        actionId: read.actionId,
        workUnitId: "alpha",
        specRevision: 1,
        attempt: 1,
        bindingGeneration: 1,
        memberThreadId: "thread-alpha",
        requestedTurnId: "turn-malformed",
        sourceTurnId,
        resultEnvelope: { schemaVersion: 1 },
      },
    });
    assert.equal(malformed.checkpoint.members[0].result.state, "malformed");
    assert.equal(
      malformed.checkpoint.members[0].execution.attentionRequired,
      true,
    );
    assert.equal(
      malformed.join.effects.some(({ type }) => type === "native-follow-up"),
      false,
    );
    assert.deepEqual(malformed.join.boundary, {
      type: "attention",
      reason: "member-evidence-requires-review",
    });
  }
});

test("each accepted dependency wave is isolated and cleanup-scoped before the next wave", async (t) => {
  const current = await fixture(t);
  const planned = planWorkSlices({
    schemaVersion: 1,
    objective: "Run dependency-ordered durable work",
    slices: [
      {
        id: "alpha",
        title: "Alpha",
        objective: "Complete alpha",
        deliverable: "Alpha result",
        acceptanceCriteria: ["Alpha passes"],
        dependsOn: [],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
      {
        id: "beta",
        title: "Beta",
        objective: "Complete beta",
        deliverable: "Beta result",
        acceptanceCriteria: ["Beta passes"],
        dependsOn: ["alpha"],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
    ],
  });
  const run = await current.planRunStore.create(
    createPlanRunV1(planned, {
      queenThreadId: "queen",
      sourceId: "multi-wave-observation",
      webIdentity: {
        schemaVersion: 1,
        webId: "A1",
        queenThreadId: "queen",
        queenTitle: "👑 A1 · Queen",
      },
    }),
  );
  await current.planRunStore.markWaveVerified({
    planRunId: run.planRunId,
    queenThreadId: "queen",
    waveIndex: 1,
    waveDigest: run.waves[0].waveDigest,
  });
  await bind(current.executionStore, workUnit());
  const waiting = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  const waitEffect = waiting.join.effects.find(
    ({ type }) => type === "native-wait",
  );
  const reading = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-wait",
      actionId: waitEffect.actionId,
      webId: "A1",
      queenThreadId: "queen",
      status: "event",
      targets: waitEffect.targets.map((target) => ({
        ...target,
        nextCursor: "cursor-alpha",
        lifecycle: "completed",
        latestTurnId: "turn-1",
        attentionRequired: false,
      })),
    },
  });
  const readEffect = reading.join.effects.find(
    ({ type }) => type === "native-read-result",
  );
  await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-result-read",
      actionId: readEffect.actionId,
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
      bindingGeneration: 1,
      memberThreadId: "thread-alpha",
      requestedTurnId: "turn-1",
      sourceTurnId: "turn-1",
      resultEnvelope: {
        schemaVersion: 1,
        workUnitId: "alpha",
        specRevision: 1,
        attempt: 1,
        outcome: "succeeded",
        summary: "done",
        artifacts: [],
        verification: [],
        blockers: [],
        recoveryHint: null,
      },
    },
  });
  current.acceptanceStore.decisions.push({
    decision: "accepted",
    workUnitId: "alpha",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "thread-alpha",
    sourceTurnId: "turn-1",
  });
  const advanced = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.equal(advanced.join.boundary.type, "continue");
  assert.equal(advanced.nextAction.kind, "cleanup-spinoffs");
  assert.deepEqual(advanced.nextAction.arguments, {
    webId: "A1",
    queenThreadId: "queen",
    planRunId: run.planRunId,
    waveIndex: 1,
    waveDigest: run.waves[0].waveDigest,
  });

  await current.planRunStore.markWaveVerified({
    planRunId: run.planRunId,
    queenThreadId: "queen",
    waveIndex: 2,
    waveDigest: run.waves[1].waveDigest,
  });
  await bind(
    current.executionStore,
    workUnit({
      workUnitId: "beta",
      title: "🕷️ A1 · Beta",
      dependencies: ["alpha"],
    }),
    "thread-beta",
  );
  const betaWaiting = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.deepEqual(
    betaWaiting.checkpoint.members.map(({ workUnitId }) => workUnitId),
    ["beta"],
  );
  assert.deepEqual(betaWaiting.checkpoint.consumedReceipts, []);
  const betaWait = betaWaiting.join.effects.find(
    ({ type, targets }) =>
      type === "native-wait" &&
      targets.some(({ workUnitId }) => workUnitId === "beta"),
  );
  const betaReading = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-wait",
      actionId: betaWait.actionId,
      webId: "A1",
      queenThreadId: "queen",
      status: "event",
      targets: betaWait.targets.map((target) => ({
        ...target,
        nextCursor: "cursor-beta",
        lifecycle: "completed",
        latestTurnId: "turn-beta",
        attentionRequired: false,
      })),
    },
  });
  const betaRead = betaReading.join.effects.find(
    ({ type, workUnitId }) =>
      type === "native-read-result" && workUnitId === "beta",
  );
  await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: {
      schemaVersion: 1,
      type: "native-result-read",
      actionId: betaRead.actionId,
      workUnitId: "beta",
      specRevision: 1,
      attempt: 1,
      bindingGeneration: 1,
      memberThreadId: "thread-beta",
      requestedTurnId: "turn-beta",
      sourceTurnId: "turn-beta",
      resultEnvelope: {
        schemaVersion: 1,
        workUnitId: "beta",
        specRevision: 1,
        attempt: 1,
        outcome: "succeeded",
        summary: "done",
        artifacts: [],
        verification: [],
        blockers: [],
        recoveryHint: null,
      },
    },
  });
  current.acceptanceStore.decisions.push({
    decision: "accepted",
    workUnitId: "beta",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "thread-beta",
    sourceTurnId: "turn-beta",
  });
  const completed = await current.adapter().advance({
    webId: "A1",
    queenThreadId: "queen",
    receipt: null,
  });
  assert.equal(completed.nextAction.kind, "cleanup-spinoffs");
});

test("observation adapter has no app-server or process-control dependency", async () => {
  const source = await readFile(new URL("../src/mcp-observation.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /app-server-client|control-endpoint|child_process|spawn\s*\(/u);
});

test("high-cardinality wave transitions bound observation state to the exact active wave", async (t) => {
  const current = await fixture(t);
  const firstIds = Array.from({ length: 40 }, (_, index) => `first-${index}`);
  const secondIds = Array.from({ length: 40 }, (_, index) => `second-${index}`);
  for (const workUnitId of [...firstIds, ...secondIds]) {
    await bind(
      current.executionStore,
      workUnit({ workUnitId, title: `Member ${workUnitId}` }),
      `thread-${workUnitId}`,
    );
  }
  let activeWave = 1;
  const wave = (waveIndex, ids) => ({
    waveIndex,
    waveDigest: String(waveIndex).repeat(64),
    members: ids.map((sliceId) => ({ sliceId, lifecycle: "spinoff" })),
  });
  const run = {
    planRunId: `run:${"a".repeat(40)}`,
    verifiedWaveIndexes: [1],
    waves: [wave(1, firstIds), wave(2, secondIds)],
  };
  const adapter = new McpJoinAdapterV1({
    executionStore: current.executionStore,
    checkpointStore: current.checkpointStore,
    acceptanceStore: current.acceptanceStore,
    planRunStore: {
      async listForWeb() {
        run.verifiedWaveIndexes = activeWave === 1 ? [1] : [1, 2];
        return [run];
      },
    },
  });
  const first = await adapter.advance({ webId: "A1", queenThreadId: "queen" });
  assert.deepEqual(
    first.checkpoint.members.map(({ workUnitId }) => workUnitId),
    [...firstIds].sort((left, right) => left.localeCompare(right)),
  );
  activeWave = 2;
  const second = await adapter.advance({ webId: "A1", queenThreadId: "queen" });
  assert.deepEqual(
    second.checkpoint.members.map(({ workUnitId }) => workUnitId),
    [...secondIds].sort((left, right) => left.localeCompare(right)),
  );
  assert.equal(second.checkpoint.members.length, 40);
  assert.deepEqual(second.checkpoint.consumedReceipts, []);
  assert.equal(second.checkpoint.waveScope.waveIndex, 2);
});
