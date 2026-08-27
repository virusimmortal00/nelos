import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArchiveProjectionLaneV1 } from "nelos/archive-projection-lane";

const ID = "01a01ae1-0000-7000-8000-000000000001";

async function fixture({ stale = false, badRestart = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "nelos-archive-lane-"));
  const reports = [];
  for (const [sequence, captureByte] of [[1, "a"], [2, "b"]]) {
    const path = join(directory, `visual-${sequence}.json`);
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: "nelos-developer-visual-state-validation", capture: { capturedAt: `2026-08-19T12:00:${sequence - 1}5.000Z`, digest: `sha256:${captureByte.repeat(64)}` }, outcome: "passed" })}\n`);
    await writeFile(path, bytes);
    reports.push({ path, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  }
  const calls = [];
  const adapter = {
    async archiveTasks() { calls.push("archive"); return [{ schemaVersion: 1, type: "native-archive", actionId: "archive-1", threadId: ID, archived: true }]; },
    async observeCheckpoint({ sequence, phase, expectedAppInstanceId }) {
      calls.push(phase);
      const appInstanceId = phase === "afterRestart" ? "app-2" : "app-1";
      if (expectedAppInstanceId) assert.equal(expectedAppInstanceId, appInstanceId);
      return {
        sequence, observedAt: `2026-08-19T12:00:${sequence}0.000Z`, phase, appInstanceId, cleanupState: "complete",
        nelosWorkers: [{ workerId: "worker-a", archivedThreadIds: [ID] }], ordinaryMapThreadIds: [], nativeVisibleThreadIds: stale ? [ID] : [],
        visualEvidence: { report: reports[sequence - 1], sidebarThreadIds: stale ? [ID] : [], createdTasksThreadIds: [], mcpVisualThreadIds: [] },
      };
    },
    async restartDesktop({ previousAppInstanceId }) {
      calls.push("restart");
      return { schemaVersion: 1, type: "desktop-restart", previousAppInstanceId, newAppInstanceId: badRestart ? previousAppInstanceId : "app-2", restarted: true };
    },
    async reconcileEffect() { throw new Error("unused"); },
  };
  const request = {
    schemaVersion: 1, runId: "run-1", startedAt: "2026-08-19T12:00:00.000Z",
    expectedThreads: [{ threadId: ID, title: "Scenario task" }],
    policy: { maxConvergenceMs: 30_000, requireArchiveReceipts: true, requireRestartCheckpoint: true, requiredConsecutiveAbsent: 2 },
  };
  const clock = { now: () => Date.parse("2026-08-19T12:00:00.000Z") };
  return { lane: new ArchiveProjectionLaneV1({ adapter, clock }), adapter, request, calls, clock };
}

test("executes archive, clean checkpoint, restart, and post-restart checkpoint in order", async () => {
  const value = await fixture();
  const receipt = await value.lane.execute(value.request);
  assert.equal(receipt.outcome, "passed");
  assert.deepEqual(value.calls, ["archive", "afterCleanup", "restart", "afterRestart"]);
  assert.equal(receipt.report.counts.checkpoints, 2);
});

test("returns a terminal failed receipt for stale native and sidebar projections", async () => {
  const value = await fixture({ stale: true });
  const receipt = await value.lane.execute(value.request);
  assert.equal(receipt.outcome, "failed");
  assert.ok(receipt.report.findings.some(({ code }) => code === "ARCHIVE_PROJECTION_DID_NOT_CONVERGE"));
});

test("rejects a restart that does not produce a new app instance before the second observation", async () => {
  const value = await fixture({ badRestart: true });
  await assert.rejects(value.lane.execute(value.request), (error) => error.code === "INVALID_RESTART_RECEIPT");
  assert.deepEqual(value.calls, ["archive", "afterCleanup", "restart"]);
});

test("rejects a malformed cleanup checkpoint before requesting a Desktop restart", async () => {
  const value = await fixture();
  const lane = new ArchiveProjectionLaneV1({
    adapter: { ...value.adapter, async observeCheckpoint() { value.calls.push("afterCleanup"); return null; } },
    clock: value.clock,
  });
  await assert.rejects(lane.execute(value.request), (error) => error.code === "INVALID_ARCHIVE_LANE_INPUT");
  assert.deepEqual(value.calls, ["archive", "afterCleanup"]);
});

test("rejects an expired shared convergence deadline before any archive mutation", async () => {
  const value = await fixture();
  const lane = new ArchiveProjectionLaneV1({ adapter: value.adapter, clock: { now: () => Date.parse("2026-08-19T12:00:30.000Z") } });
  await assert.rejects(lane.execute(value.request), (error) => error.code === "ARCHIVE_CONVERGENCE_DEADLINE");
  assert.deepEqual(value.calls, []);
});

test("absolute run deadline aborts archive execution before it can consume cleanup time", async () => {
  const value = await fixture();
  let now = Date.parse(value.request.startedAt);
  let observedSignal = null;
  const adapter = {
    ...value.adapter,
    async archiveTasks(_request, { signal }) {
      value.calls.push("archive");
      observedSignal = signal;
      now += 11;
      return [];
    },
  };
  const lane = new ArchiveProjectionLaneV1({ adapter, clock: { now: () => now } });
  await assert.rejects(
    lane.execute(value.request, { hardDeadlineAt: new Date(now + 10).toISOString() }),
    (error) => error.code === "RUN_DEADLINE_EXPIRED",
  );
  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(value.calls, ["archive"]);
});

test("reconciliation accepts only an identity-matching terminal receipt", async () => {
  const value = await fixture();
  const receipt = await value.lane.execute(value.request);
  const lane = new ArchiveProjectionLaneV1({ adapter: { ...value.adapter, async reconcileEffect() { return { ...receipt, runId: "other-run" }; } } });
  await assert.rejects(lane.reconcileEffect({ request: value.request }), (error) => error.code === "ARCHIVE_LANE_RECONCILIATION_REQUIRED");
});

test("reconciliation validates the complete terminal receipt before accepting success", async () => {
  const value = await fixture();
  const receipt = await value.lane.execute(value.request);
  const accepted = new ArchiveProjectionLaneV1({ adapter: { ...value.adapter, async reconcileEffect() { return receipt; } } });
  assert.deepEqual(await accepted.reconcileEffect({ request: value.request }), receipt);

  const truncated = { ...receipt, report: { kind: receipt.report.kind, outcome: receipt.report.outcome } };
  const rejected = new ArchiveProjectionLaneV1({ adapter: { ...value.adapter, async reconcileEffect() { return truncated; } } });
  await assert.rejects(rejected.reconcileEffect({ request: value.request }), (error) => error.code === "ARCHIVE_LANE_RECONCILIATION_REQUIRED");
});
