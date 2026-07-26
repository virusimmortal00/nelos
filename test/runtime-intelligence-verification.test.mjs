import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveNativeSubagentThreadV1,
  verifyRuntimeIntelligenceV1,
} from "../src/runtime-intelligence-verification.mjs";

async function fixture(events) {
  const root = await mkdtemp(join(tmpdir(), "nelos-route-verification-"));
  const directory = join(root, "2026", "07", "21");
  await mkdir(directory, { recursive: true });
  const path = join(
    directory,
    "rollout-2026-07-21T18-29-33-thread-1.jsonl",
  );
  await writeFile(
    path,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return { root, path };
}

function turnContext(turnId, model, effort) {
  return {
    type: "turn_context",
    payload: { turn_id: turnId, model, effort, summary: "not inspected" },
  };
}

test("runtime verification confirms the exact model and effort", async () => {
  const { root } = await fixture([
    { type: "response_item", payload: { transcript: "private" } },
    turnContext("turn-1", "gpt-5.6-terra", "low"),
  ]);
  try {
    assert.deepEqual(
      await verifyRuntimeIntelligenceV1({
        threadId: "thread-1",
        model: "gpt-5.6-terra",
        effort: "low",
        sessionsRoot: root,
      }),
      {
        schemaVersion: 1,
        threadId: "thread-1",
        turnId: null,
        expected: { model: "gpt-5.6-terra", effort: "low" },
        observed: [
          {
            turnId: "turn-1",
            model: "gpt-5.6-terra",
            effort: "low",
            matches: true,
          },
        ],
        verified: true,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime verification reports a loud exact-route mismatch", async () => {
  const { root } = await fixture([
    turnContext("turn-1", "gpt-5.6-sol", "xhigh"),
  ]);
  try {
    const result = await verifyRuntimeIntelligenceV1({
      threadId: "thread-1",
      turnId: "turn-1",
      model: "gpt-5.6-luna",
      effort: "low",
      sessionsRoot: root,
    });
    assert.equal(result.verified, false);
    assert.deepEqual(result.observed, [
      {
        turnId: "turn-1",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        matches: false,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime verification fails closed without exact turn evidence", async () => {
  const { root } = await fixture([
    turnContext("turn-1", "gpt-5.6-sol", "medium"),
  ]);
  try {
    await assert.rejects(
      verifyRuntimeIntelligenceV1({
        threadId: "thread-1",
        turnId: "turn-missing",
        model: "gpt-5.6-sol",
        effort: "medium",
        sessionsRoot: root,
      }),
      /no observed context for turn turn-missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime verification scopes joined-subagent route evidence to the current launch turn", async () => {
  const { root } = await fixture([
    turnContext("turn-older", "gpt-5.6-sol", "medium"),
    turnContext("turn-current", "gpt-5.6-terra", "high"),
  ]);
  try {
    const current = await verifyRuntimeIntelligenceV1({
      threadId: "thread-1",
      turnId: "turn-current",
      model: "gpt-5.6-terra",
      effort: "high",
      sessionsRoot: root,
    });
    assert.equal(current.verified, true);
    assert.deepEqual(current.observed.map(({ turnId }) => turnId), ["turn-current"]);

    for (const expected of [
      { model: "gpt-5.6-sol", effort: "medium" },
      { model: "gpt-5.6-terra", effort: "medium" },
    ]) {
      const mismatch = await verifyRuntimeIntelligenceV1({
        threadId: "thread-1",
        turnId: "turn-current",
        ...expected,
        sessionsRoot: root,
      });
      assert.equal(mismatch.verified, false);
      assert.deepEqual(mismatch.observed.map(({ turnId }) => turnId), ["turn-current"]);
    }

    await assert.rejects(
      verifyRuntimeIntelligenceV1({
        threadId: "thread-1",
        turnId: "turn-missing",
        model: "gpt-5.6-sol",
        effort: "medium",
        sessionsRoot: root,
      }),
      /no observed context for turn turn-missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subagent resolution uses only exact parent and canonical agent identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-subagent-resolution-"));
  const directory = join(root, "2026", "07", "24");
  await mkdir(directory, { recursive: true });
  const threadId = "child-thread";
  await writeFile(
    join(directory, `rollout-2026-07-24T12-00-00-${threadId}.jsonl`),
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: threadId,
        parent_thread_id: "parent-thread",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "parent-thread",
              agent_path: "/root/nelos_planner_abc123",
            },
          },
        },
      },
    })}\n${JSON.stringify(turnContext("turn-current", "gpt-5.6-terra", "high"))}\n`,
  );
  await writeFile(
    join(directory, "rollout-2026-07-24T11-00-00-unrelated.jsonl"),
    "not-json\n",
  );
  try {
    assert.deepEqual(
      await resolveNativeSubagentThreadV1({
        parentThreadId: "parent-thread",
        agentPath: "/root/nelos_planner_abc123",
        sessionsRoot: root,
      }),
      {
        schemaVersion: 1,
        parentThreadId: "parent-thread",
        agentPath: "/root/nelos_planner_abc123",
        threadId,
        turnId: "turn-current",
      },
    );
    await assert.rejects(
      resolveNativeSubagentThreadV1({
        parentThreadId: "other-parent",
        agentPath: "/root/nelos_planner_abc123",
        sessionsRoot: root,
      }),
      /no native child task matches/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subagent resolution derives the final current turn and fails closed on missing or ambiguous evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-subagent-current-turn-"));
  const directory = join(root, "2026", "07", "24");
  await mkdir(directory, { recursive: true });
  const sessionMeta = (threadId, agentPath) => ({
    type: "session_meta",
    payload: {
      id: threadId,
      parent_thread_id: "parent-thread",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent-thread", agent_path: agentPath } } },
    },
  });
  const writeRollout = async (threadId, agentPath, events) => writeFile(
    join(directory, `rollout-2026-07-24T12-00-00-${threadId}.jsonl`),
    `${[sessionMeta(threadId, agentPath), ...events].map(JSON.stringify).join("\n")}\n`,
  );
  try {
    await writeRollout("current-child", "/root/current", [
      turnContext("turn-older", "gpt-5.6-sol", "medium"),
      turnContext("turn-current", "gpt-5.6-terra", "high"),
    ]);
    assert.equal(
      (await resolveNativeSubagentThreadV1({ parentThreadId: "parent-thread", agentPath: "/root/current", sessionsRoot: root })).turnId,
      "turn-current",
    );
    await writeRollout("missing-child", "/root/missing", []);
    await assert.rejects(
      resolveNativeSubagentThreadV1({ parentThreadId: "parent-thread", agentPath: "/root/missing", sessionsRoot: root }),
      /has no current turn context/,
    );
    await writeRollout("ambiguous-child", "/root/ambiguous", [
      turnContext("turn-current", "gpt-5.6-terra", "high"),
      turnContext("turn-current", "gpt-5.6-terra", "high"),
    ]);
    await assert.rejects(
      resolveNativeSubagentThreadV1({ parentThreadId: "parent-thread", agentPath: "/root/ambiguous", sessionsRoot: root }),
      /has ambiguous current turn evidence/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
