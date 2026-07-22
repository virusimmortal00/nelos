import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyRuntimeIntelligenceV1 } from "../src/runtime-intelligence-verification.mjs";

async function fixture(events) {
  const root = await mkdtemp(join(tmpdir(), "fraktik-route-verification-"));
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
