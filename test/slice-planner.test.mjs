import assert from "node:assert/strict";
import test from "node:test";

import { planWorkSlices } from "../src/slice-planner.mjs";

function slice(id, overrides = {}) {
  return {
    id,
    title: `${id} title`,
    objective: `Complete ${id}`,
    deliverable: `${id} deliverable`,
    acceptanceCriteria: [`${id} is verified`],
    dependsOn: [],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
    taskShape: "everyday",
    ...overrides,
  };
}

test("slice planning composes dependency waves with guidance-backed routes", () => {
  const input = {
    schemaVersion: 1,
    objective: "Build and verify a feature",
    maxParallel: 2,
    slices: [
      slice("design", {
        lifecycle: "subagent",
        workspaceMode: "shared-read-only",
        taskShape: "complex/open-ended",
      }),
      slice("research", {
        lifecycle: "subagent",
        workspaceMode: "shared-read-only",
        taskShape: "clear/repeatable",
      }),
      slice("implement", { dependsOn: ["design"] }),
      slice("tests", {
        dependsOn: ["implement"],
        taskShape: "clear/repeatable",
      }),
      slice("review", {
        dependsOn: ["implement"],
        lifecycle: "subagent",
        workspaceMode: "shared-read-only",
        taskShape: "complex/open-ended",
      }),
    ],
  };

  const first = planWorkSlices(input);
  const second = planWorkSlices(input);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.waves.map((wave) => wave.slices.map((candidate) => candidate.id)),
    [["design", "research"], ["implement"], ["tests", "review"]],
  );
  assert.deepEqual(first.summary, {
    slices: 5,
    waves: 3,
    spinoffs: 2,
    subagents: 3,
    models: {
      "gpt-5.6-sol": 2,
      "gpt-5.6-terra": 2,
      "gpt-5.6-luna": 1,
    },
    efforts: { medium: 2, low: 3 },
  });
  assert.deepEqual(first.waves[0].slices[0].route.launch.nativeTask, {
    model: "gpt-5.6-sol",
    thinking: "medium",
  });
  assert.deepEqual(first.waves[0].slices[1].route.launch.nativeTask, {
    model: "gpt-5.6-terra",
    thinking: "low",
  });
  assert.deepEqual(first.waves[2].slices[0].route.launch.nativeTask, {
    model: "gpt-5.6-luna",
    thinking: "low",
  });
});

test("maxParallel deterministically chunks otherwise independent work", () => {
  const plan = planWorkSlices({
    schemaVersion: 1,
    objective: "Three independent slices",
    maxParallel: 2,
    slices: [slice("a"), slice("b"), slice("c")],
  });
  assert.deepEqual(
    plan.waves.map((wave) => wave.slices.map((candidate) => candidate.id)),
    [["a", "b"], ["c"]],
  );
  assert.equal(plan.waves[0].parallel, true);
  assert.equal(plan.waves[1].parallel, false);
});

test("per-slice overrides remain subordinate to the reviewed router", () => {
  const plan = planWorkSlices({
    schemaVersion: 1,
    objective: "Route two slices",
    slices: [
      slice("quality", {
        routing: { profile: "sol", effort: "max" },
      }),
      slice("reasoning", {
        routing: { effort: "high" },
      }),
    ],
  });
  const [quality, reasoning] = plan.waves[0].slices;
  assert.deepEqual(quality.route.launch.nativeTask, {
    model: "gpt-5.6-sol",
    thinking: "max",
  });
  assert.deepEqual(reasoning.route.launch.nativeTask, {
    model: "gpt-5.6-terra",
    thinking: "high",
  });
});

test("slice planning rejects explicit Luna routing for joined subagents", () => {
  const joined = {
    lifecycle: "subagent",
    workspaceMode: "shared-read-only",
    taskShape: "clear/repeatable",
  };
  for (const routing of [
    { profile: "luna" },
    { model: "gpt-5.6-luna" },
  ]) {
    assert.throws(
      () =>
        planWorkSlices({
          schemaVersion: 1,
          objective: "Never launch a Luna subagent",
          slices: [slice("joined", { ...joined, routing })],
        }),
      /joined-subagent launches do not support gpt-5\.6-luna/,
    );
  }
});

test("slice plans reject malformed topology and unsafe isolation", async (t) => {
  const base = {
    schemaVersion: 1,
    objective: "Invalid plan",
    slices: [slice("a"), slice("b")],
  };
  const scenarios = [
    ["unknown field", { ...base, surprise: true }, /unknown field: surprise/],
    [
      "string schema version",
      { ...base, schemaVersion: "1" },
      /schemaVersion must be the number 1/,
    ],
    ["duplicate id", { ...base, slices: [slice("a"), slice("a")] }, /duplicate slice id/],
    [
      "unknown dependency",
      { ...base, slices: [slice("a", { dependsOn: ["missing"] })] },
      /unknown dependency/,
    ],
    [
      "self dependency",
      { ...base, slices: [slice("a", { dependsOn: ["a"] })] },
      /must not depend on itself/,
    ],
    [
      "cycle",
      {
        ...base,
        slices: [
          slice("a", { dependsOn: ["b"] }),
          slice("b", { dependsOn: ["a"] }),
        ],
      },
      /contain a cycle/,
    ],
    [
      "decorated role title",
      { ...base, slices: [slice("a", { title: "🕷️ A1 · Implement" })] },
      /title must be plain undecorated text/u,
    ],
    [
      "bare spider role title",
      { ...base, slices: [slice("a", { title: "🕷 A1 · Implement" })] },
      /title must be plain undecorated text/u,
    ],
    [
      "bare web role title",
      { ...base, slices: [slice("a", { title: "🕸 A1 · Implement" })] },
      /title must be plain undecorated text/u,
    ],
    [
      "subagent writer",
      {
        ...base,
        slices: [slice("a", { lifecycle: "subagent" })],
      },
      /must be a spinoff to use an isolated worktree/,
    ],
    [
      "unsupported task shape",
      { ...base, slices: [slice("a", { taskShape: "mystery" })] },
      /unsupported intelligence task shape/,
    ],
    [
      "unapproved Ultra",
      {
        ...base,
        slices: [slice("a", { routing: { profile: "sol", effort: "ultra" } })],
      },
      /Ultra requires explicit native-fan-out permission/,
    ],
  ];

  for (const [name, value, pattern] of scenarios) {
    await t.test(name, () => assert.throws(() => planWorkSlices(value), pattern));
  }
});
