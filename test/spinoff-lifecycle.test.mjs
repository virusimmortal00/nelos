import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  NelosConfigStoreV1,
  NelosConfigurationV1,
} from "../src/nelos-configuration.mjs";
import {
  SpinoffLifecycleAdapterV1,
  SpinoffLifecycleStoreV1,
  spinoffWakeIdV1,
} from "../src/spinoff-lifecycle.mjs";

const testStateHome = await mkdtemp(join(tmpdir(), "nelos-lifecycle-state-"));
process.env.XDG_STATE_HOME = testStateHome;
after(() => rm(testStateHome, { recursive: true, force: true }));

function workUnit(overrides = {}) {
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
    ...overrides,
  };
}

function completion(overrides = {}) {
  return {
    webId: "A1",
    queenThreadId: "queen",
    workUnitId: "member-a",
    specRevision: 1,
    attempt: 1,
    memberThreadId: "member-thread",
    outcome: "succeeded",
    summary: "Implemented and verified the bounded change.",
    receipt: null,
    ...overrides,
  };
}

function acceptance(unit = workUnit()) {
  return {
    decision: "accepted",
    webId: unit.webId,
    queenThreadId: unit.queenThreadId,
    workUnitId: unit.workUnitId,
    specRevision: unit.specRevision,
    attempt: unit.attempt,
    memberThreadId: unit.binding.memberThreadId,
    result: {
      outcome: "succeeded",
      summary: "Implemented and verified the bounded change.",
    },
  };
}

async function fixture(
  t,
  {
    units = [workUnit()],
    decisions = units.map(acceptance),
    storeDecorator = (store) => store,
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "nelos-spinoff-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = storeDecorator(new SpinoffLifecycleStoreV1({ directory }));
  const configPath = join(directory, "config.toml");
  const configuration = new NelosConfigurationV1({
    store: new NelosConfigStoreV1({ path: configPath }),
    legacyPreferencePath: join(directory, "preference.json"),
  });
  let ordinal = 0;
  const adapter = new SpinoffLifecycleAdapterV1({
    store,
    configuration,
    now: () =>
      new Date(Date.UTC(2026, 6, 24, 12, 0, ordinal++)).toISOString(),
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
  return {
    adapter,
    store,
    configuration,
    configPath,
    directory,
    decisions,
    units,
  };
}

function wakeReceipt(effect, overrides = {}) {
  return {
    threadId: effect.threadId,
    ...overrides,
  };
}

function archiveReceipt(effect, overrides = {}) {
  return {
    schemaVersion: 1,
    actionId: effect.actionId,
    type: "native-archive",
    threadId: effect.threadId,
    archived: true,
    ...overrides,
  };
}

test("spin-off completion persists before returning one host-owned wake effect", async (t) => {
  const { adapter } = await fixture(t);
  const first = await adapter.complete(completion());
  assert.equal(first.record.wakeState, "delivering");
  assert.equal(first.effects.length, 1);
  assert.equal(first.effects[0].type, "native-send-message");
  assert.equal(first.effects[0].threadId, "queen");
  assert.equal(
    first.effects[0].preconditions.expectedCallerThreadId,
    "member-thread",
  );
  assert.match(first.effects[0].prompt, /member-a/u);

  const delivered = await adapter.complete(
    completion({ receipt: wakeReceipt(first.effects[0]) }),
  );
  assert.equal(delivered.record.wakeState, "delivered");
  assert.equal(delivered.record.queenTurnId, null);
  assert.deepEqual(delivered.effects, []);

  const replay = await adapter.complete(completion());
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.wakeState, "delivered");
});

test("spin-off completion never blindly re-emits an in-flight wake", async (t) => {
  const { adapter } = await fixture(t);
  const first = await adapter.complete(completion());
  const replay = await adapter.complete(completion());
  assert.equal(replay.effects.length, 1);
  assert.equal(replay.effects[0].type, "native-reconcile-send-message");
  assert.equal(replay.effects[0].originalActionId, first.effects[0].actionId);
});

test("spin-off completion rejects stale receipts and unbound identities", async (t) => {
  const { adapter } = await fixture(t);
  const first = await adapter.complete(completion());
  await assert.rejects(
    adapter.complete(
      completion({
        receipt: wakeReceipt(first.effects[0], { threadId: "other" }),
      }),
    ),
    /stale or conflicting/u,
  );
  await assert.rejects(
    adapter.complete(
      completion({
        receipt: {
          threadId: first.effects[0].threadId,
          specRevision: 1,
        },
      }),
    ),
    /incompatible shape/u,
  );
  await assert.rejects(
    adapter.complete(completion({ memberThreadId: "other" })),
    /bound durable work unit/u,
  );
});

test("spin-off completion accepts the full result-summary contract", async (t) => {
  const { adapter } = await fixture(t);
  const result = await adapter.complete(
    completion({ summary: "x".repeat(2_000) }),
  );
  assert.equal(result.record.summary.length, 2_000);
});

test("cleanup defaults to auto while migrating an explicit legacy ask", async (t) => {
  const automatic = await fixture(t);
  const requested = await automatic.adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
  });
  assert.equal(requested.policy, "auto");
  assert.equal(requested.state, "effects-required");
  assert.equal(requested.effects[0].type, "native-archive");

  const legacy = await fixture(t);
  await legacy.store.rememberPreference("ask");
  const preview = await legacy.adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
  });
  assert.equal(preview.policy, "ask");
  assert.equal(preview.state, "confirmation-required");
  assert.equal(
    (await legacy.configuration.get()).setting.source,
    "toml",
  );
});

test("an explicit ask policy confirms before returning archive effects", async (t) => {
  const { adapter } = await fixture(t);
  const preview = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "ask",
  });
  assert.deepEqual(preview, {
    schemaVersion: 1,
    policy: "ask",
    state: "confirmation-required",
    candidates: [{
      workUnitId: "member-a",
      threadId: "member-thread",
      title: "Member A",
      model: "host-default",
      reasoning: "host-default",
    }],
  });

  const requested = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "ask",
    confirmedThreadIds: ["member-thread"],
  });
  assert.equal(requested.state, "effects-required");
  assert.equal(requested.results[0].state, "archiving");
  assert.equal(requested.effects[0].type, "native-archive");

  const applied = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "ask",
    confirmedThreadIds: ["member-thread"],
    archiveReceipts: [archiveReceipt(requested.effects[0])],
  });
  assert.equal(applied.state, "complete");
  assert.deepEqual(applied.effects, []);
  assert.equal(applied.results[0].state, "archived");

  const receiptReplay = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "ask",
    archiveReceipts: [archiveReceipt(requested.effects[0])],
  });
  assert.equal(receiptReplay.state, "complete");
  assert.equal(receiptReplay.results[0].state, "archived");
  assert.equal(receiptReplay.results[0].replayed, true);

  const replay = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "ask",
    confirmedThreadIds: ["member-thread"],
  });
  assert.equal(replay.results[0].state, "archived");
  assert.equal(replay.results[0].replayed, true);
});

test("ask reconciliation never expands a partial confirmation", async (t) => {
  const first = workUnit();
  const second = workUnit({
    workUnitId: "member-b",
    title: "Member B",
    binding: {
      state: "bound",
      memberThreadId: "member-thread-b",
    },
  });
  const { adapter } = await fixture(t, {
    units: [first, second],
    decisions: [acceptance(first), acceptance(second)],
  });
  const requested = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "ask",
    confirmedThreadIds: ["member-thread"],
  });
  assert.deepEqual(
    requested.effects.map(({ threadId }) => threadId),
    ["member-thread"],
  );

  const applied = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    archiveReceipts: [archiveReceipt(requested.effects[0])],
  });
  assert.equal(applied.state, "complete");
  assert.deepEqual(applied.effects, []);
  assert.deepEqual(
    applied.results.map(({ threadId, state }) => ({ threadId, state })),
    [{ threadId: "member-thread", state: "archived" }],
  );

  const remaining = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
  });
  assert.equal(remaining.state, "confirmation-required");
  assert.deepEqual(
    remaining.candidates.map(({ threadId }) => threadId),
    ["member-thread-b"],
  );
});

test("legacy partial ask retains its terminal policy for missing candidates", async (t) => {
  const first = workUnit();
  const second = workUnit({
    workUnitId: "member-b",
    title: "Member B",
    binding: {
      state: "bound",
      memberThreadId: "member-thread-b",
    },
  });
  const { adapter, directory } = await fixture(t, {
    units: [first, second],
    decisions: [acceptance(first), acceptance(second)],
  });
  const requested = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "ask",
    confirmedThreadIds: ["member-thread"],
  });
  await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    archiveReceipts: [archiveReceipt(requested.effects[0])],
  });

  const missingWakeId = spinoffWakeIdV1(completion({
    workUnitId: "member-b",
    memberThreadId: "member-thread-b",
  }));
  const missingRecord = join(
    directory,
    `${createHash("sha256").update(missingWakeId).digest("hex")}.json`,
  );
  await rm(missingRecord);

  const replay = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
  });
  assert.equal(replay.policy, "ask");
  assert.equal(replay.state, "confirmation-required");
  assert.deepEqual(
    replay.candidates.map(({ threadId }) => threadId),
    ["member-thread-b"],
  );
});

test("cleanup never blindly re-emits an in-flight archive", async (t) => {
  const { adapter } = await fixture(t);
  const first = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  });
  const replay = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  });
  assert.equal(replay.state, "effects-required");
  assert.equal(replay.effects[0].type, "native-reconcile-archive");
  assert.equal(replay.effects[0].originalActionId, first.effects[0].actionId);
});

test("remembered auto and keep policies move to user configuration", async (t) => {
  const autoFixture = await fixture(t);
  const requested = await autoFixture.adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
    rememberPolicy: true,
    userIntentConfirmed: true,
  });
  assert.equal(requested.state, "effects-required");
  assert.equal(
    (await autoFixture.configuration.get()).setting.value,
    "auto",
  );
  assert.equal(
    (await autoFixture.configuration.get()).setting.source,
    "toml",
  );

  const keepFixture = await fixture(t);
  const kept = await keepFixture.adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "keep",
    rememberPolicy: true,
    userIntentConfirmed: true,
  });
  assert.equal(
    (await keepFixture.configuration.get()).setting.value,
    "keep",
  );
  assert.deepEqual(kept.effects, []);
  assert.equal(kept.results[0].state, "kept");
});

test("cleanup rejects ineligible confirmations and receipts", async (t) => {
  const { adapter, configuration } = await fixture(t);
  await assert.rejects(
    adapter.cleanup({
      webId: "A1",
      queenThreadId: "queen",
      policy: "auto",
      rememberPolicy: true,
      userIntentConfirmed: true,
      confirmedThreadIds: ["unrelated-thread"],
    }),
    /ineligible spin-off/u,
  );
  assert.deepEqual((await configuration.get()).setting, {
    key: "spinoffs.cleanup_policy",
    value: "auto",
    source: "default",
  });

  await assert.rejects(
    adapter.cleanup({
      webId: "A1",
      queenThreadId: "queen",
      policy: "auto",
      archiveReceipts: [{
        schemaVersion: 1,
        actionId: "stale",
        type: "native-archive",
        threadId: "unrelated-thread",
        archived: true,
      }],
    }),
    /unselected spin-off/u,
  );
});

test("keep rejects an archive receipt without changing terminal state", async (t) => {
  const { adapter, store } = await fixture(t);
  const result = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "keep",
    archiveReceipts: [{
      schemaVersion: 1,
      actionId: "fabricated-archive",
      type: "native-archive",
      threadId: "member-thread",
      archived: true,
    }],
  });
  assert.equal(result.state, "attention");
  assert.deepEqual(result.results, [{
    workUnitId: "member-a",
    threadId: "member-thread",
    title: "Member A",
    model: "host-default",
    reasoning: "host-default",
    state: "attention",
    reason: "cleanup-candidate-failed",
  }]);
  const record = await store.read(spinoffWakeIdV1(completion()));
  assert.equal(record.cleanupPolicy, "keep");
  assert.equal(record.cleanupState, "pending");
});

test("cleanup waits for every required current spin-off acceptance", async (t) => {
  const first = workUnit();
  const second = workUnit({
    workUnitId: "member-b",
    title: "Member B",
    binding: {
      state: "bound",
      memberThreadId: "member-thread-b",
    },
  });
  const { adapter } = await fixture(t, {
    units: [first, second],
    decisions: [acceptance(first)],
  });
  const result = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  });
  assert.equal(result.state, "not-ready");
  assert.deepEqual(result.pending, [{
    workUnitId: "member-b",
    threadId: "member-thread-b",
    title: "Member B",
  }]);
});

test("cleanup excludes failed outcomes and units without archive capability", async (t) => {
  const blocked = acceptance();
  blocked.result.outcome = "blocked";
  const blockedFixture = await fixture(t, { decisions: [blocked] });
  assert.equal(
    (await blockedFixture.adapter.cleanup({
      webId: "A1",
      queenThreadId: "queen",
    })).state,
    "not-ready",
  );

  const noArchive = workUnit({ capabilities: ["observe"] });
  const noArchiveFixture = await fixture(t, {
    units: [noArchive],
    decisions: [acceptance(noArchive)],
  });
  const preview = await noArchiveFixture.adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
  });
  assert.equal(preview.policy, "auto");
  assert.deepEqual(preview.results, []);
  assert.deepEqual(preview.effects, []);
  assert.equal(preview.state, "complete");
});

test("an in-flight archive keeps its snapshotted policy after global changes", async (t) => {
  const { adapter, configuration } = await fixture(t);
  const requested = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  });
  assert.equal(requested.policy, "auto");
  assert.equal(requested.effects[0].type, "native-archive");

  await configuration.set({
    key: "spinoffs.cleanup_policy",
    value: "keep",
    userIntentConfirmed: true,
  });
  const applied = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    archiveReceipts: [archiveReceipt(requested.effects[0])],
  });
  assert.equal(applied.policy, "auto");
  assert.equal(applied.state, "complete");
  assert.equal(applied.results[0].state, "archived");
});

test("competing cleanup starts establish one policy snapshot for the web", async (t) => {
  const first = workUnit();
  const second = workUnit({
    workUnitId: "member-b",
    title: "Member B",
    binding: {
      state: "bound",
      memberThreadId: "member-thread-b",
    },
  });
  const { adapter } = await fixture(t, {
    units: [first, second],
    decisions: [acceptance(first), acceptance(second)],
  });
  const results = await Promise.all([
    adapter.cleanup({
      webId: "A1",
      queenThreadId: "queen",
      policy: "auto",
    }),
    adapter.cleanup({
      webId: "A1",
      queenThreadId: "queen",
      policy: "keep",
    }),
  ]);
  assert.equal(new Set(results.map(({ policy }) => policy)).size, 1);
  assert.ok(
    results.every(({ state }) => state !== "attention"),
    "a competing cleanup start must not split the web policy",
  );
  const replay = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: results[0].policy === "auto" ? "keep" : "auto",
  });
  assert.equal(replay.policy, results[0].policy);
});

test("mixed terminal legacy policies do not block cleanup replay", async (t) => {
  const first = workUnit();
  const second = workUnit({
    workUnitId: "member-b",
    title: "Member B",
    binding: {
      state: "bound",
      memberThreadId: "member-thread-b",
    },
  });
  const { adapter, store } = await fixture(t, {
    units: [first, second],
    decisions: [acceptance(first), acceptance(second)],
  });
  const requested = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  });
  await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    archiveReceipts: requested.effects.map(archiveReceipt),
  });

  const secondCompletion = completion({
    workUnitId: "member-b",
    memberThreadId: "member-thread-b",
  });
  const wakeId = spinoffWakeIdV1(secondCompletion);
  const legacy = await store.read(wakeId);
  await store.write({
    ...legacy,
    revision: legacy.revision + 1,
    cleanupState: "kept",
    cleanupPolicy: "keep",
    updatedAt: "2026-07-24T13:00:00.000Z",
  }, { expectedRevision: legacy.revision });

  const replay = await adapter.cleanup({
    webId: "A1",
    queenThreadId: "queen",
    policy: "auto",
  });
  assert.equal(replay.state, "complete");
  assert.deepEqual(replay.effects, []);
  assert.deepEqual(replay.results, []);
});

test("remembering a cleanup policy requires explicit user intent", async (t) => {
  const { adapter } = await fixture(t);
  await assert.rejects(
    adapter.cleanup({
      webId: "A1",
      queenThreadId: "queen",
      policy: "keep",
      rememberPolicy: true,
    }),
    /requires an explicit policy and user intent/u,
  );
});
