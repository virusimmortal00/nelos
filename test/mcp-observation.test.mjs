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
  return {
    root,
    executionStore,
    checkpointStore,
    acceptanceStore,
    adapter: () =>
      new McpJoinAdapterV1({
        executionStore,
        checkpointStore,
        acceptanceStore,
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
});

test("observation adapter has no app-server or process-control dependency", async () => {
  const source = await readFile(new URL("../src/mcp-observation.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /app-server-client|control-endpoint|child_process|spawn\s*\(/u);
});
