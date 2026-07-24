import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SpinoffLifecycleAdapterV1,
  SpinoffLifecycleStoreV1,
} from "../src/spinoff-lifecycle.mjs";

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

async function fixture(t, callerThreadId = "member-thread") {
  const directory = await mkdtemp(join(tmpdir(), "nelos-spinoff-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unit = workUnit();
  const decisions = [acceptance()];
  const store = new SpinoffLifecycleStoreV1({ directory });
  const adapter = new SpinoffLifecycleAdapterV1({
    store,
    callerThreadId: () => callerThreadId,
    now: (() => {
      let ordinal = 0;
      return () => new Date(Date.UTC(2026, 6, 24, 12, 0, ordinal++)).toISOString();
    })(),
    executionStore: {
      async read(id) {
        return id === unit.workUnitId ? unit : null;
      },
      async list() {
        return [unit];
      },
    },
    acceptanceStore: {
      async list() {
        return decisions;
      },
    },
  });
  return { adapter, store, decisions };
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
        deferred: false,
        reason: null,
        queenTurnId: "queen-turn",
      };
    },
  };
  const first = await adapter.complete(completion(), bridge);
  assert.equal(first.record.wakeState, "delivered");
  assert.equal(first.record.queenTurnId, "queen-turn");
  const second = await adapter.complete(completion(), bridge);
  assert.equal(second.replayed, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].message, /member-a/u);
});

test("spin-off completion rejects a caller outside its durable identity", async (t) => {
  const { adapter } = await fixture(t, "another-thread");
  await assert.rejects(
    adapter.complete(completion(), {}),
    /only the bound spin-off/u,
  );
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
  const { adapter } = await fixture(t, "queen");
  await assert.rejects(
    adapter.cleanup({
      webId: "A1",
      queenThreadId: "queen",
      confirmedThreadIds: ["unrelated-thread"],
    }, {}),
    /ineligible spin-off/u,
  );
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
  assert.deepEqual(preview, {
    schemaVersion: 1,
    policy: "ask",
    state: "complete",
    candidates: [],
  });
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
