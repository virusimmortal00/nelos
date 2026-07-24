import assert from "node:assert/strict";
import * as fileSystem from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionStoreRecordError,
  ExecutionStoreV1,
  WorkUnitSpecV1,
  createWorkUnitSpecV1,
  serializeWorkUnitSpecV1,
  validateWorkUnitSpecV1,
} from "../src/execution-store.mjs";

function specInput(overrides = {}) {
  return {
    schemaVersion: 1,
    webId: "A1",
    queenThreadId: "queen-thread",
    workUnitId: "work-unit",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["archive", "observe", "follow-up", "read-result"],
    title: "Verify distribution",
    objectiveSummary: "Run the packed and live distribution checks.",
    deliverable: "A bounded verification report.",
    acceptanceCriteria: ["Packed verifier passes", "Failures include evidence"],
    dependencies: ["work-z", "work-a"],
    required: true,
    policy: {
      maxAttempts: 3,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    },
    ...overrides,
  };
}

function workUnit(overrides = {}) {
  return createWorkUnitSpecV1(specInput(overrides));
}

async function withStore(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "nelos-execution-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "execution-v1");
  return {
    directory,
    store: new ExecutionStoreV1({ directory, ...options }),
  };
}

test("WorkUnitSpecV1 constructs a canonical, explicit pre-launch contract", () => {
  const record = WorkUnitSpecV1(specInput());

  assert.deepEqual(record.binding, {
    state: "unbound",
    memberThreadId: null,
    launchActionId: null,
    generation: 1,
  });
  assert.deepEqual(record.replacementHistory, []);
  assert.deepEqual(record.capabilities, [
    "observe",
    "read-result",
    "follow-up",
    "archive",
  ]);
  assert.deepEqual(record.dependencies, ["work-a", "work-z"]);
  assert.equal(record.specRevision, 1);
  assert.equal(record.attempt, 1);
  assert.equal(
    serializeWorkUnitSpecV1(record),
    `${JSON.stringify(record, null, 2)}\n`,
  );
});

test("work-unit validation rejects incompatible, ambiguous, and unbounded records", () => {
  const valid = workUnit();
  const invalidInputs = [
    [specInput({ schemaVersion: 2 }), /schemaVersion must be 1/],
    [specInput({ workUnitId: "../escape" }), /workUnitId has an invalid format/],
    [specInput({ specRevision: 0 }), /specRevision must be a positive integer/],
    [specInput({ attempt: 0 }), /attempt must be a positive integer/],
    [specInput({ capabilities: ["observe", "observe"] }), /must not contain duplicates/],
    [specInput({ capabilities: ["observe", "launch"] }), /unsupported work-unit capability/],
    [specInput({ dependencies: ["work-unit"] }), /must not depend on itself/],
    [specInput({ unexpected: true }), /contains unknown field: unexpected/],
    [
      specInput({
        memberKind: "joined-subagent",
        capabilities: ["observe", "follow-up"],
      }),
      /limited to observe/,
    ],
    [
      specInput({
        policy: {
          maxAttempts: 1,
          onBlocked: "queen-review",
          onFailure: "queen-review",
        },
        attempt: 2,
      }),
      /attempt must not exceed/,
    ],
  ];
  for (const [input, expected] of invalidInputs) {
    assert.throws(() => createWorkUnitSpecV1(input), expected);
  }

  assert.throws(
    () => validateWorkUnitSpecV1({ ...valid, schemaVersion: 2 }),
    /schemaVersion must be 1/,
  );
  assert.throws(
    () =>
      validateWorkUnitSpecV1({
        ...valid,
        binding: {
          ...valid.binding,
          state: "bound",
          memberThreadId: "member-task",
        },
      }),
    /memberThreadId|launchActionId/,
  );
  assert.throws(
    () => validateWorkUnitSpecV1({ ...valid, privatePrompt: "do not persist" }),
    /contains unknown field: privatePrompt/,
  );
});

test("ExecutionStoreV1 atomically persists private records in deterministic order", async (t) => {
  const { directory, store } = await withStore(t);
  const second = workUnit({ workUnitId: "work-b", dependencies: [] });
  const first = workUnit({ workUnitId: "work-a", dependencies: [] });

  await store.create(second);
  await store.create(first);
  assert.deepEqual(
    (await store.list()).map((record) => record.workUnitId),
    ["work-a", "work-b"],
  );
  assert.deepEqual(await store.read("work-a"), first);
  assert.deepEqual(await store.create(first), first, "identical creates are idempotent");
  await assert.rejects(
    store.create({ ...first, title: "Conflicting definition" }),
    (error) => error instanceof ExecutionStoreRecordError && error.code === "already_exists",
  );

  const persisted = await readFile(join(directory, "work-a.json"), "utf8");
  assert.equal(persisted, serializeWorkUnitSpecV1(first));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, "work-a.json"))).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("normal binding is one-way and guarded by work-unit revision", async (t) => {
  const { store } = await withStore(t);
  await store.create(workUnit());

  await assert.rejects(
    store.bind({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-1",
      memberThreadId: "member-1",
    }),
    /matching launch-pending action/,
  );
  await assert.rejects(
    store.markLaunchPending({
      workUnitId: "work-unit",
      specRevision: 2,
      launchActionId: "launch-1",
    }),
    (error) => error.code === "revision_conflict",
  );

  const pending = await store.markLaunchPending({
    workUnitId: "work-unit",
    specRevision: 1,
    launchActionId: "launch-1",
  });
  assert.deepEqual(pending.binding, {
    state: "launch-pending",
    memberThreadId: null,
    launchActionId: "launch-1",
    generation: 1,
  });
  assert.deepEqual(
    await store.markLaunchPending({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-1",
    }),
    pending,
    "replaying the same transition is idempotent",
  );
  await assert.rejects(
    store.markLaunchPending({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-other",
    }),
    /only move from unbound/,
  );

  const bound = await store.bind({
    workUnitId: "work-unit",
    specRevision: 1,
    launchActionId: "launch-1",
    memberThreadId: "member-1",
  });
  assert.deepEqual(bound.binding, {
    state: "bound",
    memberThreadId: "member-1",
    launchActionId: "launch-1",
    generation: 1,
  });
  assert.deepEqual(
    await store.bind({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-1",
      memberThreadId: "member-1",
    }),
    bound,
  );
  await assert.rejects(
    store.bind({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-1",
      memberThreadId: "member-2",
    }),
    /matching launch-pending action/,
  );
  await assert.rejects(
    store.markLaunchPending({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-2",
    }),
    /only move from unbound/,
  );
});

test("corrective attempts retain bindings and replacements preserve history", async (t) => {
  const { store } = await withStore(t);
  await store.create(workUnit());
  await store.markLaunchPending({
    workUnitId: "work-unit",
    specRevision: 1,
    launchActionId: "launch-1",
  });
  const firstBinding = (
    await store.bind({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-1",
      memberThreadId: "member-1",
    })
  ).binding;

  const correcting = await store.advanceAttempt({
    workUnitId: "work-unit",
    specRevision: 1,
    attempt: 1,
  });
  assert.equal(correcting.attempt, 2);
  assert.deepEqual(correcting.binding, firstBinding);
  await assert.rejects(
    store.advanceAttempt({
      workUnitId: "work-unit",
      specRevision: 1,
      attempt: 1,
    }),
    (error) => error.code === "attempt_conflict",
  );

  const replacementPending = await store.beginReplacement({
    workUnitId: "work-unit",
    specRevision: 1,
    attempt: 2,
    launchActionId: "launch-2",
  });
  assert.equal(replacementPending.attempt, 3);
  assert.deepEqual(replacementPending.binding, {
    state: "launch-pending",
    memberThreadId: null,
    launchActionId: "launch-2",
    generation: 2,
  });
  assert.deepEqual(replacementPending.replacementHistory, [
    {
      state: "bound",
      memberThreadId: "member-1",
      launchActionId: "launch-1",
      generation: 1,
      replacedByLaunchActionId: "launch-2",
    },
  ]);
  assert.deepEqual(
    await store.beginReplacement({
      workUnitId: "work-unit",
      specRevision: 1,
      attempt: 2,
      launchActionId: "launch-2",
    }),
    replacementPending,
  );
  await assert.rejects(
    store.advanceAttempt({
      workUnitId: "work-unit",
      specRevision: 1,
      attempt: 3,
    }),
    /requires a bound member task/,
  );
  await assert.rejects(
    store.bind({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-2",
      memberThreadId: "member-1",
    }),
    /must bind a new member task/,
  );
  await store.bind({
    workUnitId: "work-unit",
    specRevision: 1,
    launchActionId: "launch-2",
    memberThreadId: "member-2",
  });
  await assert.rejects(
    store.beginReplacement({
      workUnitId: "work-unit",
      specRevision: 1,
      attempt: 3,
      launchActionId: "launch-3",
    }),
    (error) => error.code === "attempt_limit",
  );
});

test("spec revisions are contiguous and cannot rewrite runtime identity", async (t) => {
  const { store } = await withStore(t);
  const initial = await store.create(workUnit());
  const revised = await store.revise(
    { ...initial, specRevision: 2, title: "Verify the final distribution" },
    { expectedSpecRevision: 1 },
  );
  assert.equal(revised.specRevision, 2);
  assert.equal(revised.title, "Verify the final distribution");

  await assert.rejects(
    store.revise(
      { ...revised, specRevision: 4, title: "Skip a revision" },
      { expectedSpecRevision: 2 },
    ),
    /advance exactly one revision/,
  );
  await assert.rejects(
    store.revise(
      { ...revised, specRevision: 3, queenThreadId: "other-queen" },
      { expectedSpecRevision: 2 },
    ),
    /queenThreadId is immutable/,
  );
  await assert.rejects(
    store.revise(
      { ...revised, specRevision: 3, attempt: 2 },
      { expectedSpecRevision: 2 },
    ),
    /attempt must be changed through an execution-store transition/,
  );
  await assert.rejects(
    store.revise(
      { ...revised, specRevision: 3, title: "Stale writer" },
      { expectedSpecRevision: 1 },
    ),
    (error) => error.code === "revision_conflict",
  );
});

test("malformed records are isolated without exposing their contents", async (t) => {
  const { directory, store } = await withStore(t);
  await store.create(workUnit({ workUnitId: "healthy-b" }));
  await store.create(workUnit({ workUnitId: "healthy-a" }));
  const secret = "PRIVATE_MALFORMED_RECORD_CONTENT";
  await writeFile(join(directory, "broken.json"), `{not-json:${secret}\n`);
  await writeFile(
    join(directory, "future.json"),
    `${JSON.stringify({ schemaVersion: 2, workUnitId: "future" })}\n`,
  );
  await writeFile(
    join(directory, "wrong.json"),
    serializeWorkUnitSpecV1(workUnit({ workUnitId: "different" })),
  );
  await writeFile(join(directory, "ignored.tmp"), secret);

  const scan = await store.scan();
  assert.deepEqual(
    scan.workUnits.map((record) => record.workUnitId),
    ["healthy-a", "healthy-b"],
  );
  assert.deepEqual(scan.malformedRecords, [
    { fileName: "broken.json", workUnitId: "broken", reason: "invalid_json" },
    { fileName: "future.json", workUnitId: "future", reason: "unsupported_schema_version" },
    { fileName: "wrong.json", workUnitId: "wrong", reason: "identity_mismatch" },
  ]);
  assert.doesNotMatch(JSON.stringify(scan), new RegExp(secret));
  await assert.rejects(
    store.read("broken"),
    (error) =>
      error instanceof ExecutionStoreRecordError &&
      error.code === "invalid_json" &&
      !error.message.includes(secret),
  );
});

test("a failed atomic replacement preserves the previous complete record", async (t) => {
  let failRename = false;
  const injectedFileSystem = {
    ...fileSystem,
    async rename(source, destination) {
      if (failRename) {
        const error = new Error("simulated rename failure");
        error.code = "EIO";
        throw error;
      }
      return fileSystem.rename(source, destination);
    },
  };
  const { directory, store } = await withStore(t, {
    fileSystem: injectedFileSystem,
    makeTemporaryId: (() => {
      let counter = 0;
      return () => `temporary-${counter += 1}`;
    })(),
  });
  const initial = await store.create(workUnit());
  failRename = true;
  await assert.rejects(
    store.revise(
      { ...initial, specRevision: 2, title: "Interrupted revision" },
      { expectedSpecRevision: 1 },
    ),
    /simulated rename failure/,
  );

  assert.deepEqual(await store.read("work-unit"), initial);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("same-process concurrent mutations cannot silently overwrite each other", async (t) => {
  const { store } = await withStore(t);
  await store.create(workUnit());
  const results = await Promise.allSettled([
    store.markLaunchPending({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-a",
    }),
    store.markLaunchPending({
      workUnitId: "work-unit",
      specRevision: 1,
      launchActionId: "launch-b",
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await store.read("work-unit")).binding.state, "launch-pending");
});
