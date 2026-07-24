import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  SpinoffLifecycleAdapterV1,
  SpinoffLifecycleStoreV1,
  spinoffWakeIdV1,
} from "../src/spinoff-lifecycle.mjs";

const testStateHome = await mkdtemp(join(tmpdir(), "nelos-lifecycle-state-"));
process.env.XDG_STATE_HOME = testStateHome;
after(() => rm(testStateHome, { recursive: true, force: true }));

function workUnit() {
  return {
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    required: true,
    title: "Member A",
    capabilities: ["observe", "archive"],
    binding: {
      state: "bound",
      memberThreadId: "member-thread",
    },
  };
}

function completion() {
  return {
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "member-thread",
    outcome: "succeeded",
    summary: "Implemented and verified the bounded change.",
  };
}

function acceptance() {
  return {
    decision: "accepted",
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "member-thread",
    result: {
      outcome: "succeeded",
      summary: "Implemented and verified the bounded change.",
    },
  };
}

async function fixture(
  t,
  callerThreadId = "member-thread",
  {
    units = [workUnit()],
    decisions = [acceptance()],
    storeDecorator = (store) => store,
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "nelos-spinoff-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = storeDecorator(new SpinoffLifecycleStoreV1({ directory }));
  const adapter = new SpinoffLifecycleAdapterV1({
    store,
    callerThreadId: () => callerThreadId,
    now: (() => {
      let ordinal = 0;
      return () => new Date(Date.UTC(2026, 6, 24, 12, 0, ordinal++)).toISOString();
    })(),
    executionStore: {
      async read(id) {
        return units.find(({ workUnitId }) => workUnitId === id) ?? null;
      },
      async list() {
        return units;
      },
    },
    acceptanceStore: {
      async list() {
        return decisions;
      },
    },
  });
  return { adapter, store, decisions, units };
}

test("spin-off completion persists and delivers exactly one queen wake", async (t) => {
  const { adapter } = await fixture(t);
  const deliveries = [];
  const bridge = {
    async deliverParentWake(value) {
      deliveries.push(value);
      return {
        delivered: true,
        replayed: false,
        queenTurnId: "queen-turn",
      };
    },
  };
  const first = await adapter.complete(completion(), bridge);
  assert.equal(first.record.wakeState, "delivered");
  assert.equal(first.record.wakeReason, null);
  assert.equal(first.record.queenTurnId, "queen-turn");
  const second = await adapter.complete(completion(), bridge);
  assert.equal(second.replayed, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].message, /member-a/u);
  assert.match(deliveries[0].message, /\nOutcome:/u);
});

test("spin-off completion rejects a caller outside its durable identity", async (t) => {
  const { adapter } = await fixture(t, "another-thread");
  await assert.rejects(
    adapter.complete(completion(), {}),
    /only the bound spin-off/u,
  );
});

test("spin-off completion accepts the full result-summary contract", async (t) => {
  const { adapter } = await fixture(t);
  const value = {
    ...completion(),
    summary: "x".repeat(2_000),
  };
  const result = await adapter.complete(value, {
    async deliverParentWake() {
      return {
        delivered: true,
        replayed: false,
        queenTurnId: "queen-turn",
      };
    },
  });
  assert.equal(result.record.summary.length, 2_000);
});

test("spin-off completion does not blindly retry an uncertain wake", async (t) => {
  const { adapter } = await fixture(t);
  let calls = 0;
  const bridge = {
    async deliverParentWake() {
      calls += 1;
      const error = new Error("connection closed after mutation");
      error.mutationUncertain = true;
      throw error;
    },
  };
  await assert.rejects(
    adapter.complete(completion(), bridge),
    /persisted as attention/u,
  );
  const replay = await adapter.complete(completion(), bridge);
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.wakeState, "attention");
  assert.equal(calls, 1);
});

test("cleanup asks with exact accepted candidates before archiving", async (t) => {
  const { adapter } = await fixture(t, "queen");
  const archived = [];
  const bridge = {
    async archiveThread({ threadId }) {
      archived.push(threadId);
      return { archived: true, threadId };
    },
  };
  const preview = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
  }, bridge);
  assert.deepEqual(preview, {
    schemaVersion: 1,
    policy: "ask",
    state: "confirmation-required",
    candidates: [{
      workUnitId: "member-a",
      threadId: "member-thread",
      title: "Member A",
    }],
  });
  assert.deepEqual(archived, []);

  const applied = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    confirmedThreadIds: ["member-thread"],
  }, bridge);
  assert.equal(applied.state, "complete");
  assert.deepEqual(applied.results, [{
    threadId: "member-thread",
    state: "archived",
    replayed: false,
  }]);
  assert.deepEqual(archived, ["member-thread"]);
});

test("remembered auto and keep policies are durable", async (t) => {
  const autoFixture = await fixture(t, "queen");
  const archived = [];
  await autoFixture.adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
    rememberPolicy: true,
  }, {
    async archiveThread({ threadId }) {
      archived.push(threadId);
    },
  });
  assert.equal(await autoFixture.store.preference(), "auto");
  assert.deepEqual(archived, ["member-thread"]);

  const keepFixture = await fixture(t, "queen");
  const kept = await keepFixture.adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "keep",
    rememberPolicy: true,
  }, {
    async archiveThread() {
      assert.fail("keep must not archive");
    },
  });
  assert.equal(await keepFixture.store.preference(), "keep");
  assert.deepEqual(kept.results, [{
    threadId: "member-thread",
    state: "kept",
  }]);
});

test("cleanup rejects ineligible confirmation IDs", async (t) => {
  const { adapter, store } = await fixture(t, "queen");
  await assert.rejects(
    adapter.cleanup({
      webId: "A1",
      queenThreadId: "queen",
      policy: "auto",
      rememberPolicy: true,
      confirmedThreadIds: ["unrelated-thread"],
    }, {}),
    /ineligible spin-off/u,
  );
  assert.equal(await store.preference(), "ask");
});

test("cleanup excludes accepted failed or blocked outcomes", async (t) => {
  const { adapter, decisions } = await fixture(t, "queen");
  decisions[0].result.outcome = "blocked";
  const preview = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
  }, {
    async archiveThread() {
      assert.fail("blocked work must not be archived");
    },
  });
  assert.equal(preview.state, "not-ready");
  assert.deepEqual(preview.pending.map(({ workUnitId }) => workUnitId), [
    "member-a",
  ]);
});

test("cleanup waits for every required current spin-off acceptance", async (t) => {
  const first = workUnit();
  const second = {
    ...workUnit(),
    workUnitId: "member-b",
    title: "Member B",
    binding: {
      state: "bound",
      memberThreadId: "member-thread-b",
    },
  };
  const { adapter } = await fixture(t, "queen", {
    units: [first, second],
    decisions: [acceptance()],
  });
  const result = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  }, {
    async archiveThread() {
      assert.fail("cleanup must wait for every required result");
    },
  });
  assert.equal(result.state, "not-ready");
  assert.deepEqual(result.pending, [{
    workUnitId: "member-b",
    threadId: "member-thread-b",
    title: "Member B",
  }]);
});

test("cleanup excludes work units without archive capability", async (t) => {
  const { adapter, units } = await fixture(t, "queen");
  units[0].capabilities = ["observe"];
  const preview = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
  }, {
    async archiveThread() {
      assert.fail("unauthorized work must not be archived");
    },
  });
  assert.deepEqual(preview.candidates, []);
  assert.equal(preview.state, "complete");
});

test("cleanup keeps per-candidate progress when persistence fails", async (t) => {
  const first = workUnit();
  const second = {
    ...workUnit(),
    workUnitId: "member-b",
    title: "Member B",
    binding: {
      state: "bound",
      memberThreadId: "member-thread-b",
    },
  };
  const secondDecision = {
    ...acceptance(),
    workUnitId: second.workUnitId,
    memberThreadId: second.binding.memberThreadId,
  };
  const { adapter } = await fixture(t, "queen", {
    units: [first, second],
    decisions: [acceptance(), secondDecision],
    storeDecorator(base) {
      return {
        preference: (...args) => base.preference(...args),
        rememberPreference: (...args) => base.rememberPreference(...args),
        read: (...args) => base.read(...args),
        async write(record, options) {
          if (record.memberThreadId === first.binding.memberThreadId) {
            throw new Error("simulated persistence failure");
          }
          return base.write(record, options);
        },
      };
    },
  });
  const archived = [];
  const result = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  }, {
    async archiveThread({ threadId }) {
      archived.push(threadId);
    },
  });
  assert.deepEqual(result.results, [
    {
      threadId: "member-thread",
      state: "attention",
      reason: "cleanup-candidate-failed",
    },
    {
      threadId: "member-thread-b",
      state: "archived",
      replayed: false,
    },
  ]);
  assert.deepEqual(archived, ["member-thread-b"]);
});

test("cleanup does not blindly retry an uncertain archive", async (t) => {
  const { adapter } = await fixture(t, "queen");
  let calls = 0;
  const bridge = {
    async archiveThread() {
      calls += 1;
      const error = new Error("connection closed after mutation");
      error.mutationUncertain = true;
      throw error;
    },
  };
  const first = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  }, bridge);
  assert.equal(first.state, "attention");
  assert.equal(first.results[0].reason, "archive-uncertain");

  const replay = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  }, bridge);
  assert.equal(replay.state, "attention");
  assert.equal(replay.results[0].reason, "prior-archive-attention");
  assert.equal(calls, 1);
});

test("cleanup can retry a certainly rejected archive", async (t) => {
  const { adapter } = await fixture(t, "queen");
  let calls = 0;
  const bridge = {
    async archiveThread() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("archive rejected before mutation");
        error.mutationUncertain = false;
        throw error;
      }
    },
  };
  const rejected = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  }, bridge);
  assert.equal(rejected.state, "pending");
  assert.deepEqual(rejected.results, [{
    threadId: "member-thread",
    state: "pending",
    reason: "archive-rejected",
  }]);

  const retried = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  }, bridge);
  assert.equal(retried.state, "complete");
  assert.equal(retried.results[0].state, "archived");
  assert.equal(calls, 2);
});

test("cleanup does not replay a persisted archiving operation", async (t) => {
  const { adapter, store } = await fixture(t, "queen");
  const value = completion();
  const wakeId = spinoffWakeIdV1(value);
  await store.write({
    schemaVersion: 1,
    revision: 1,
    wakeId,
    clientUserMessageId: wakeId,
    ...value,
    wakeState: "delivered",
    wakeReason: null,
    queenTurnId: "queen-turn",
    cleanupState: "archiving",
    cleanupPolicy: "auto",
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:01.000Z",
  }, {
    expectedRevision: 0,
  });
  let archives = 0;
  const bridge = {
    async archiveThread() {
      archives += 1;
    },
  };
  const replay = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  }, bridge);
  assert.equal(replay.state, "attention");
  assert.equal(replay.results[0].reason, "prior-archive-in-flight");
  assert.equal(archives, 0);
});
