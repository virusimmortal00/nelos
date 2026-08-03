import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPlanRunV1,
  planDigestV1,
  PlanRunStoreV1,
} from "../src/plan-run-store.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";

function plan(id = "research") {
  return planWorkSlices({
    schemaVersion: 1,
    objective: "Deliver the bounded change",
    maxParallel: 2,
    slices: [
      {
        id,
        title: "Research the boundary",
        objective: "Resolve the implementation boundary",
        deliverable: "An evidence-backed result",
        acceptanceCriteria: ["The boundary is verified"],
        dependsOn: [],
        lifecycle: "subagent",
        workspaceMode: "shared-read-only",
        taskShape: "complex/open-ended",
      },
    ],
  });
}

function durablePlan() {
  const planned = structuredClone(plan("implementation"));
  planned.waves[0].slices[0] = {
    ...planned.waves[0].slices[0],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
  };
  return planned;
}

function twoWaveDurablePlan() {
  return planWorkSlices({
    schemaVersion: 1,
    objective: "Deliver two dependency-ordered changes",
    maxParallel: 2,
    slices: [
      {
        id: "first",
        title: "First change",
        objective: "Complete the prerequisite",
        deliverable: "First result",
        acceptanceCriteria: ["The prerequisite is verified"],
        dependsOn: [],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
      {
        id: "second",
        title: "Second change",
        objective: "Complete the dependent work",
        deliverable: "Second result",
        acceptanceCriteria: ["The dependent result is verified"],
        dependsOn: ["first"],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
    ],
  });
}

function webIdentity(webId = "A1") {
  return {
    schemaVersion: 1,
    webId,
    queenThreadId: "queen-1",
    queenTitle: `👑 ${webId} · Release`,
  };
}

test("plan runs are deterministic, durable, and preserve authoritative wave contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const directory = join(root, "records");
    const firstStore = new PlanRunStoreV1({ directory });
    const planned = plan();
    const created = createPlanRunV1(planned, {
      queenThreadId: "queen-1",
      sourceId: "operation-1",
    });
    assert.equal(created.queenThreadId, "queen-1");
    assert.equal(created.planDigest, planDigestV1(planned));
    assert.equal(created.replanGeneration, 0);
    assert.equal(created.rootPlanRunId, created.planRunId);
    assert.equal(created.parentPlanRunId, null);
    assert.deepEqual(created.waves[0].members, [
      {
        sliceId: "research",
        lifecycle: "subagent",
        title: "Research the boundary",
        model: "gpt-5.6-sol",
        effort: "medium",
      },
    ]);

    const persisted = await firstStore.create(created);
    assert.deepEqual(persisted, created);
    assert.deepEqual(
      createPlanRunV1(planned, {
        queenThreadId: "queen-1",
        sourceId: "operation-1",
      }),
      created,
    );

    const restarted = new PlanRunStoreV1({ directory });
    assert.deepEqual(await restarted.read(created.planRunId), created);
    const { wave } = await restarted.requireWave({
      planRunId: created.planRunId,
      queenThreadId: "queen-1",
      waveIndex: created.waves[0].waveIndex,
      waveDigest: created.waves[0].waveDigest,
    });
    assert.deepEqual(wave, created.waves[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified wave progress is ordered, replay-safe, and durable across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const directory = join(root, "records");
    const store = new PlanRunStoreV1({ directory });
    const created = await store.create(
      createPlanRunV1(twoWaveDurablePlan(), {
        queenThreadId: "queen-1",
        sourceId: "multi-wave-progress",
        webIdentity: webIdentity(),
        cleanupIntended: false,
      }),
    );
    assert.equal(created.cleanupIntended, false);
    assert.deepEqual(created.verifiedWaveIndexes, []);
    assert.deepEqual(created.cleanedWaveIndexes, []);
    await assert.rejects(
      store.markWaveCleaned({
        planRunId: created.planRunId,
        queenThreadId: "queen-1",
        waveIndex: 1,
        waveDigest: created.waves[0].waveDigest,
      }),
      /verified before cleanup/u,
    );
    await assert.rejects(
      store.markWaveVerified({
        planRunId: created.planRunId,
        queenThreadId: "queen-1",
        waveIndex: 2,
        waveDigest: created.waves[1].waveDigest,
      }),
      /dependency order/u,
    );
    const first = await store.markWaveVerified({
      planRunId: created.planRunId,
      queenThreadId: "queen-1",
      waveIndex: 1,
      waveDigest: created.waves[0].waveDigest,
    });
    assert.deepEqual(first.verifiedWaveIndexes, [1]);
    assert.deepEqual(
      await store.markWaveVerified({
        planRunId: created.planRunId,
        queenThreadId: "queen-1",
        waveIndex: 1,
        waveDigest: created.waves[0].waveDigest,
      }),
      first,
    );
    const cleaned = await store.markWaveCleaned({
      planRunId: created.planRunId,
      queenThreadId: "queen-1",
      waveIndex: 1,
      waveDigest: created.waves[0].waveDigest,
    });
    assert.deepEqual(cleaned.cleanedWaveIndexes, [1]);
    assert.deepEqual(
      await store.markWaveCleaned({
        planRunId: created.planRunId,
        queenThreadId: "queen-1",
        waveIndex: 1,
        waveDigest: created.waves[0].waveDigest,
      }),
      cleaned,
    );
    const restarted = new PlanRunStoreV1({ directory });
    const restartedRecord = (await restarted.listForWeb({
      webId: "A1",
      queenThreadId: "queen-1",
    }))[0];
    assert.deepEqual(restartedRecord.verifiedWaveIndexes, [1]);
    assert.deepEqual(restartedRecord.cleanedWaveIndexes, [1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy plan adoption rejects a replacement that exceeds the record bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const directory = join(root, "records");
    const store = new PlanRunStoreV1({ directory });
    const oversizedPlan = {
      ...plan(),
      compatibilityPadding: "x".repeat(140 * 1024),
    };
    const current = createPlanRunV1(oversizedPlan, {
      queenThreadId: "queen-1",
      sourceId: "oversized-adoption",
    });
    const legacy = structuredClone(current);
    delete legacy.plan;
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${encodeURIComponent(legacy.planRunId)}.json`),
      `${JSON.stringify(legacy, null, 2)}\n`,
    );
    await assert.rejects(
      store.create(current),
      /record is oversized/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-run verification rejects unknown or altered wave identity and malformed persisted records", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const directory = join(root, "records");
    const store = new PlanRunStoreV1({ directory });
    const created = await store.create(
      createPlanRunV1(plan(), {
        queenThreadId: "queen-1",
        sourceId: "operation-2",
      }),
    );
    await assert.rejects(
      store.requireWave({
        planRunId: created.planRunId,
        queenThreadId: "queen-2",
        waveIndex: 1,
        waveDigest: created.waves[0].waveDigest,
      }),
      /different queen/u,
    );
    await assert.rejects(
      store.requireWave({
        planRunId: created.planRunId,
        queenThreadId: "queen-1",
        waveIndex: 1,
        waveDigest: "0".repeat(64),
      }),
      /persisted wave contract/u,
    );
    const unknownId = `run:${"f".repeat(40)}`;
    await assert.rejects(
      store.requireWave({
        planRunId: unknownId,
        queenThreadId: "queen-1",
        waveIndex: 1,
        waveDigest: created.waves[0].waveDigest,
      }),
      /unknown plan run/u,
    );

    const path = join(directory, `${encodeURIComponent(created.planRunId)}.json`);
    await writeFile(
      path,
      `${JSON.stringify({
        ...created,
        waves: [
          {
            ...created.waves[0],
            members: [
              {
                ...created.waves[0].members[0],
                model: "gpt-5.6-luna",
              },
            ],
          },
        ],
      })}\n`,
    );
    await assert.rejects(store.read(created.planRunId), /wave digest is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted plan-run identity tampering is rejected on read", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const directory = join(root, "records");
    const store = new PlanRunStoreV1({ directory });
    const created = await store.create(
      createPlanRunV1(plan(), {
        queenThreadId: "queen-1",
        sourceId: "operation-tamper",
      }),
    );
    const path = join(directory, `${encodeURIComponent(created.planRunId)}.json`);
    await writeFile(
      path,
      `${JSON.stringify({ ...created, queenThreadId: "queen-2" })}\n`,
    );
    await assert.rejects(
      store.read(created.planRunId),
      /identity conflicts with persisted intent/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derived plan runs require their exact persisted root", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const store = new PlanRunStoreV1({ directory: join(root, "records") });
    const persistedRoot = await store.create(
      createPlanRunV1(plan(), {
        queenThreadId: "queen-1",
        sourceId: "operation-root",
      }),
    );
    const derived = createPlanRunV1(plan("replacement"), {
      queenThreadId: "queen-1",
      sourceId: "operation-derived",
      parentPlanRun: persistedRoot,
    });
    await assert.rejects(
      store.create({
        ...derived,
        rootPlanRunId: `run:${"f".repeat(40)}`,
      }),
      /exact persisted root/u,
    );

    const orphanRoot = createPlanRunV1(plan("orphan-root"), {
      queenThreadId: "queen-1",
      sourceId: "operation-orphan-root",
    });
    const orphan = createPlanRunV1(plan("orphan-child"), {
      queenThreadId: "queen-1",
      sourceId: "operation-orphan-child",
      parentPlanRun: orphanRoot,
    });
    await assert.rejects(
      store.create(orphan),
      /exact persisted root/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exception plan-run lineage permits exactly one derived generation", () => {
  const root = createPlanRunV1(plan(), {
    queenThreadId: "queen-1",
    sourceId: "operation-3",
  });
  const revised = createPlanRunV1(plan("replacement"), {
    queenThreadId: "queen-1",
    sourceId: "exception-1",
    parentPlanRun: root,
  });
  assert.equal(revised.replanGeneration, 1);
  assert.equal(revised.parentPlanRunId, root.planRunId);
  assert.equal(revised.rootPlanRunId, root.planRunId);
  assert.throws(
    () =>
      createPlanRunV1(plan("second-replacement"), {
        queenThreadId: "queen-1",
        sourceId: "exception-2",
        parentPlanRun: revised,
      }),
    /bounded to one plan-run generation/u,
  );
});

test("durable plan runs persist one web identity and decorated settled titles", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const store = new PlanRunStoreV1({ directory: join(root, "records") });
    const input = createPlanRunV1(durablePlan(), {
      queenThreadId: "queen-1",
      sourceId: "durable-web",
      webIdentity: webIdentity(),
    });
    const first = await store.create(input);
    const replay = await store.create(input);
    assert.deepEqual(replay, first);
    assert.deepEqual(first.webIdentity, webIdentity());
    assert.equal(
      first.waves[0].members[0].title,
      "🕷️ A1 · Research the boundary",
    );

    await assert.rejects(
      store.create(
        createPlanRunV1(durablePlan(), {
          queenThreadId: "queen-1",
          sourceId: "durable-web",
          webIdentity: webIdentity("A2"),
        }),
      ),
      /conflicting persisted web identity/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy plan runs adopt a web identity without renumbering existing markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const directory = join(root, "records");
    const store = new PlanRunStoreV1({ directory });
    const legacy = createPlanRunV1(durablePlan(), {
      queenThreadId: "queen-1",
      sourceId: "legacy-durable-web",
    });
    const legacySource = structuredClone(legacy);
    delete legacySource.webIdentity;
    await store.create(legacySource);

    const upgraded = await store.create(
      createPlanRunV1(durablePlan(), {
        queenThreadId: "queen-1",
        sourceId: "legacy-durable-web",
        webIdentity: webIdentity(),
      }),
    );
    assert.equal(upgraded.webIdentity.webId, "A1");
    assert.equal(
      upgraded.waves[0].members[0].title,
      "🕷️ A1 · Research the boundary",
    );
    assert.deepEqual(await store.read(upgraded.planRunId), upgraded);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy title grammar migrates atomically on an exact plan replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const directory = join(root, "records");
    const store = new PlanRunStoreV1({ directory });
    const current = createPlanRunV1(durablePlan(), {
      queenThreadId: "queen-1",
      sourceId: "legacy-title-grammar",
      webIdentity: webIdentity(),
    });
    const legacy = structuredClone(current);
    legacy.webIdentity.queenTitle = "🕷️ A1 👑 · Release";
    legacy.waves[0].members[0].title =
      "🕸️ A1 · Research the boundary";
    legacy.waves[0].waveDigest = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 1,
          waveIndex: legacy.waves[0].waveIndex,
          members: legacy.waves[0].members,
        }),
        "utf8",
      )
      .digest("hex");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${encodeURIComponent(legacy.planRunId)}.json`),
      `${JSON.stringify(legacy, null, 2)}\n`,
    );

    assert.deepEqual(await store.create(current), current);
    assert.deepEqual(await store.read(current.planRunId), current);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted web identity rejects conflicting queen and member titles", () => {
  assert.throws(
    () =>
      createPlanRunV1(durablePlan(), {
        queenThreadId: "queen-1",
        sourceId: "conflicting-queen-title",
        webIdentity: {
          ...webIdentity(),
          queenTitle: "👑 A2 · Release",
        },
      }),
    /queen outbound marker A2 conflicts with persisted web identity A1/u,
  );
  const created = createPlanRunV1(durablePlan(), {
    queenThreadId: "queen-1",
    sourceId: "conflicting-member-title",
    webIdentity: webIdentity(),
  });
  assert.throws(
    () =>
      createPlanRunV1(
        {
          ...durablePlan(),
          waves: [
            {
              ...durablePlan().waves[0],
              slices: [
                {
                  ...durablePlan().waves[0].slices[0],
                  title: "🕷️ A2 · Research the boundary",
                },
              ],
            },
          ],
        },
        {
          queenThreadId: "queen-1",
          sourceId: "conflicting-member-title",
          webIdentity: created.webIdentity,
        },
      ),
    /child inbound marker A2 conflicts with persisted web identity A1/u,
  );
});
