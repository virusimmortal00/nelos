import assert from "node:assert/strict";
import test from "node:test";

import { createWorkUnitSpecV1 } from "../src/execution-store.mjs";
import {
  NelosWebInspectorV1,
  WEB_INSPECTION_MAX_EXECUTION_RECORDS,
  WEB_INSPECTION_MAX_MEMBERS,
} from "../src/web-inspection.mjs";

function webRegistry({ webId = "A1", queenThreadId = "queen-1" } = {}) {
  return {
    async read(requestedQueenThreadId) {
      if (requestedQueenThreadId !== queenThreadId) return null;
      return {
        threadId: queenThreadId,
        outboundWebId: webId,
      };
    },
  };
}

function workUnit({
  workUnitId,
  memberThreadId,
  bindingState = "bound",
} = {}) {
  const record = createWorkUnitSpecV1({
    webId: "A1",
    queenThreadId: "queen-1",
    workUnitId,
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result", "follow-up", "archive"],
    title: `Member ${workUnitId}`,
    objectiveSummary: "Produce one bounded result.",
    deliverable: "A verified result.",
    acceptanceCriteria: ["The result is bounded."],
    dependencies: [],
    required: true,
    policy: {
      maxAttempts: 2,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    },
  });
  return {
    ...record,
    binding: {
      state: bindingState,
      memberThreadId:
        bindingState === "bound" ? memberThreadId : null,
      launchActionId:
        bindingState === "unbound" ? null : `launch-${workUnitId}`,
      generation: 1,
    },
  };
}

function checkpointMember(unit, overrides = {}) {
  return {
    workUnitId: unit.workUnitId,
    specRevision: unit.specRevision,
    attempt: unit.attempt,
    bindingGeneration: unit.binding.generation,
    memberThreadId: unit.binding.memberThreadId,
    title: { state: "verified" },
    execution: {
      state: "terminal",
      attentionRequired: false,
    },
    result: {
      state: "current",
      errorCode: null,
    },
    coordination: { state: "accepted" },
    ...overrides,
  };
}

function readyItem(threadId, {
  title = threadId,
  status = "idle",
  parentThreadId = null,
} = {}) {
  return {
    threadId,
    state: "ready",
    thread: {
      schemaVersion: 1,
      threadId,
      title,
      status,
      cwd: "/private/worktree",
      parentThreadId,
      createdAt: 1,
      updatedAt: 2,
    },
  };
}

test("web inspection composes persisted and native state with bounded paging", async () => {
  const first = workUnit({
    workUnitId: "member-a",
    memberThreadId: "task-a",
  });
  const second = workUnit({
    workUnitId: "member-b",
    memberThreadId: "task-b",
  });
  const calls = [];
  let scanOptions = null;
  const inspector = new NelosWebInspectorV1({
    executionStore: {
      async scan(options) {
        scanOptions = options;
        return {
          workUnits: [second, first],
          malformedRecords: [{ reason: "unreadable_record" }],
        };
      },
    },
    checkpointStore: {
      async read() {
        return {
          checkpointRevision: 4,
          waitGeneration: 2,
          members: [
            checkpointMember(first),
            checkpointMember(second, {
              execution: {
                state: "active",
                attentionRequired: true,
              },
              result: { state: "absent", errorCode: null },
              coordination: { state: "unjoined" },
            }),
          ],
        };
      },
    },
  });
  const inspection = await inspector.inspect(
    {
      schemaVersion: 1,
      webId: "a1",
      queenThreadId: "queen-1",
      offset: 0,
      limit: 1,
    },
    {
      appServerBridge: {
        async inspectMany(args) {
          calls.push(["inspect", args]);
          return {
            schemaVersion: 1,
            requested: 2,
            succeeded: 2,
            failed: 0,
            items: [
              readyItem("queen-1", { title: "Queen" }),
              readyItem("task-a", {
                title: "Member A",
                parentThreadId: "queen-1",
              }),
            ],
            topology: {
              schemaVersion: 1,
              nodes: [
                readyItem("queen-1", { title: "Queen" }).thread,
                readyItem("task-a", {
                  title: "Member A",
                  parentThreadId: "queen-1",
                }).thread,
              ],
              edges: [
                {
                  parentThreadId: "queen-1",
                  childThreadId: "task-a",
                },
              ],
              externalParents: [],
            },
          };
        },
        async health(args) {
          calls.push(["health", args]);
          return {
            schemaVersion: 1,
            state: "ready",
            compatible: true,
          };
        },
      },
      webRegistry: webRegistry(),
    },
  );

  assert.deepEqual(inspection.page, {
    offset: 0,
    limit: 1,
    returned: 1,
    total: 2,
    nextOffset: 1,
  });
  assert.deepEqual(inspection.summary.bindingCounts, { bound: 2 });
  assert.deepEqual(inspection.summary.coordinationCounts, {
    accepted: 1,
    unjoined: 1,
  });
  assert.equal(inspection.summary.persistedAttentionRequired, 1);
  assert.equal(inspection.summary.pageNativeFailures, 0);
  assert.equal(inspection.summary.malformedExecutionRecords, 1);
  assert.equal(inspection.members[0].workUnitId, "member-a");
  assert.deepEqual(inspection.members[0].orchestration, {
    state: "current",
    title: "verified",
    execution: "terminal",
    attentionRequired: false,
    result: "current",
    resultErrorCode: null,
    coordination: "accepted",
  });
  assert.equal(inspection.members[0].native.status, "idle");
  assert.equal("cwd" in inspection.members[0].native, false);
  assert.deepEqual(scanOptions, {
    maximumRecords: WEB_INSPECTION_MAX_EXECUTION_RECORDS,
  });
  assert.deepEqual(inspection.topology.nodes, [
    {
      schemaVersion: 1,
      threadId: "queen-1",
      title: "Queen",
      status: "idle",
      parentThreadId: null,
      updatedAt: 2,
    },
    {
      schemaVersion: 1,
      threadId: "task-a",
      title: "Member A",
      status: "idle",
      parentThreadId: "queen-1",
      updatedAt: 2,
    },
  ]);
  assert.equal(JSON.stringify(inspection.topology).includes("/private"), false);
  assert.deepEqual(calls, [
    [
      "inspect",
      {
        threadIds: ["queen-1", "task-a"],
        includeTopology: true,
      },
    ],
    ["health", { probe: false }],
  ]);
});

test("web inspection distinguishes stale checkpoints and failed native reads", async () => {
  const unit = workUnit({
    workUnitId: "member-a",
    memberThreadId: "task-a",
  });
  const inspector = new NelosWebInspectorV1({
    executionStore: {
      async scan() {
        return { workUnits: [unit], malformedRecords: [] };
      },
    },
    checkpointStore: {
      async read() {
        return {
          checkpointRevision: 1,
          waitGeneration: 0,
          members: [
            checkpointMember(unit, { bindingGeneration: 2 }),
          ],
        };
      },
    },
  });
  const inspection = await inspector.inspect(
    {
      schemaVersion: 1,
      webId: "A1",
      queenThreadId: "queen-1",
    },
    {
      appServerBridge: {
        async inspectMany() {
          return {
            items: [
              readyItem("queen-1"),
              {
                threadId: "task-a",
                state: "failed",
                error: {
                  code: "request-rejected",
                  retriable: false,
                  detail: "must not escape",
                },
              },
            ],
            topology: {
              schemaVersion: 1,
              nodes: [],
              edges: [],
              externalParents: [],
            },
          };
        },
        async health() {
          return { schemaVersion: 1, state: "ready" };
        },
      },
      webRegistry: webRegistry(),
    },
  );

  assert.equal(inspection.summary.persistedAttentionRequired, 1);
  assert.equal(inspection.summary.pageNativeFailures, 1);
  assert.deepEqual(inspection.members[0].orchestration, {
    state: "stale",
  });
  assert.deepEqual(inspection.members[0].native, {
    state: "failed",
    error: {
      code: "request-rejected",
      retriable: false,
    },
  });
  assert.equal(
    JSON.stringify(inspection).includes("must not escape"),
    false,
  );
});

test("web inspection validates identity and page bounds before reading state", async () => {
  let scans = 0;
  const inspector = new NelosWebInspectorV1({
    executionStore: {
      async scan() {
        scans += 1;
        return { workUnits: [], malformedRecords: [] };
      },
    },
    checkpointStore: {
      async read() {
        return null;
      },
    },
  });
  const appServerBridge = {
    async inspectMany() {
      throw new Error("not reached");
    },
    async health() {
      throw new Error("not reached");
    },
  };
  const persistedWebRegistry = webRegistry();

  await assert.rejects(
    inspector.inspect(
      {
        schemaVersion: 1,
        webId: "not-a-web",
        queenThreadId: "queen-1",
      },
      { appServerBridge, webRegistry: persistedWebRegistry },
    ),
    /web ID must look like/,
  );
  await assert.rejects(
    inspector.inspect(
      {
        schemaVersion: 1,
        webId: "A1",
        queenThreadId: "queen-1",
        limit: WEB_INSPECTION_MAX_MEMBERS + 1,
      },
      { appServerBridge, webRegistry: persistedWebRegistry },
    ),
    /limit must be between/,
  );
  await assert.rejects(
    inspector.inspect(
      {
        schemaVersion: 1,
        webId: "A2",
        queenThreadId: "queen-1",
      },
      { appServerBridge, webRegistry: persistedWebRegistry },
    ),
    /identity is not persisted/,
  );
  assert.equal(scans, 0);
});
