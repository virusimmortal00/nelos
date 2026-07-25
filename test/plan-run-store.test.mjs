import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("plan runs are deterministic, durable, and preserve authoritative wave contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-runs-"));
  try {
    const directory = join(root, "records");
    const firstStore = new PlanRunStoreV1({ directory });
    const planned = plan();
    const created = createPlanRunV1(planned, { sourceId: "operation-1" });
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
      createPlanRunV1(planned, { sourceId: "operation-1" }),
      created,
    );

    const restarted = new PlanRunStoreV1({ directory });
    assert.deepEqual(await restarted.read(created.planRunId), created);
    const { wave } = await restarted.requireWave({
      planRunId: created.planRunId,
      waveIndex: created.waves[0].waveIndex,
      waveDigest: created.waves[0].waveDigest,
    });
    assert.deepEqual(wave, created.waves[0]);
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
      createPlanRunV1(plan(), { sourceId: "operation-2" }),
    );
    await assert.rejects(
      store.requireWave({
        planRunId: created.planRunId,
        waveIndex: 1,
        waveDigest: "0".repeat(64),
      }),
      /persisted wave contract/u,
    );
    const unknownId = `run:${"f".repeat(40)}`;
    await assert.rejects(
      store.requireWave({
        planRunId: unknownId,
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

test("exception plan-run lineage permits exactly one derived generation", () => {
  const root = createPlanRunV1(plan(), { sourceId: "operation-3" });
  const revised = createPlanRunV1(plan("replacement"), {
    sourceId: "exception-1",
    parentPlanRun: root,
  });
  assert.equal(revised.replanGeneration, 1);
  assert.equal(revised.parentPlanRunId, root.planRunId);
  assert.equal(revised.rootPlanRunId, root.planRunId);
  assert.throws(
    () =>
      createPlanRunV1(plan("second-replacement"), {
        sourceId: "exception-2",
        parentPlanRun: revised,
      }),
    /bounded to one plan-run generation/u,
  );
});
