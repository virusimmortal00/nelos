import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyRuntimeIntelligenceV1 } from "../src/runtime-intelligence-verification.mjs";

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

// Write one rollout at an explicit date and (optionally) nonstandard location
// so tests can exercise the newest-first fast path and the fallback walk.
async function writeRollout(root, { date, threadId, events, segments }) {
  const directory = segments
    ? join(root, ...segments)
    : join(root, ...date.split("-"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `rollout-${date}T18-29-33-${threadId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
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

test("runtime verification resolves a thread in an older day directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-route-verification-"));
  try {
    await writeRollout(root, {
      date: "2026-07-20",
      threadId: "thread-old",
      events: [turnContext("turn-1", "gpt-5.6-terra", "low")],
    });
    await writeRollout(root, {
      date: "2026-07-22",
      threadId: "thread-new",
      events: [turnContext("turn-1", "gpt-5.6-sol", "medium")],
    });
    // The newest-first scan keeps descending past the newest day until it
    // finds the requested thread, so an older thread still resolves.
    const result = await verifyRuntimeIntelligenceV1({
      threadId: "thread-old",
      model: "gpt-5.6-terra",
      effort: "low",
      sessionsRoot: root,
    });
    assert.equal(result.verified, true);
    assert.equal(result.observed[0].turnId, "turn-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cross-day duplicate resolves to the newest rollout instead of failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-route-verification-"));
  try {
    await writeRollout(root, {
      date: "2026-07-20",
      threadId: "thread-1",
      events: [turnContext("turn-1", "gpt-5.6-terra", "low")],
    });
    await writeRollout(root, {
      date: "2026-07-22",
      threadId: "thread-1",
      events: [turnContext("turn-1", "gpt-5.6-sol", "medium")],
    });
    // Short-circuit at the newest day: the older same-id rollout is not seen,
    // so this returns the newest evidence rather than throwing "multiple".
    const result = await verifyRuntimeIntelligenceV1({
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      effort: "medium",
      sessionsRoot: root,
    });
    assert.equal(result.verified, true);
    assert.equal(result.observed[0].model, "gpt-5.6-sol");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a same-day duplicate still fails closed as ambiguous", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-route-verification-"));
  try {
    const directory = join(root, "2026", "07", "22");
    await mkdir(directory, { recursive: true });
    for (const stamp of ["18-29-33", "19-04-11"]) {
      await writeFile(
        join(directory, `rollout-2026-07-22T${stamp}-thread-1.jsonl`),
        `${JSON.stringify(turnContext("turn-1", "gpt-5.6-sol", "medium"))}\n`,
      );
    }
    await assert.rejects(
      verifyRuntimeIntelligenceV1({
        threadId: "thread-1",
        model: "gpt-5.6-sol",
        effort: "medium",
        sessionsRoot: root,
      }),
      /multiple local rollouts/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rollout outside the date layout is still found via the fallback walk", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-route-verification-"));
  try {
    await writeRollout(root, {
      date: "2026-07-22",
      threadId: "thread-1",
      events: [turnContext("turn-1", "gpt-5.6-terra", "low")],
      segments: ["archive", "misc"],
    });
    const result = await verifyRuntimeIntelligenceV1({
      threadId: "thread-1",
      model: "gpt-5.6-terra",
      effort: "low",
      sessionsRoot: root,
    });
    assert.equal(result.verified, true);
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
