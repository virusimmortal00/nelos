import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateArchiveProjectionConvergence } from "../src/archive-projection-convergence.mjs";

const A = "01a01ae1-1dd0-77f1-8cda-e4285c58dd4c";
const B = "01a01ae1-1daf-78f2-8e61-45ed08bb7863";

async function visualReport(directory, name = "visual.json") {
  const path = join(directory, name);
  const value = { schemaVersion: 1, kind: "nelos-developer-visual-state-validation", capture: { digest: `sha256:${"a".repeat(64)}` }, outcome: "passed", counts: {}, findings: [] };
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  await writeFile(path, bytes);
  return { path, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nelos-archive-convergence-"));
  const report = await visualReport(directory);
  const visualEvidence = (overrides = {}) => ({ report, sidebarThreadIds: [], createdTasksThreadIds: [], mcpVisualThreadIds: [], ...overrides });
  const checkpoint = (sequence, observedAt, phase, appInstanceId, overrides = {}) => ({
    sequence,
    observedAt,
    phase,
    appInstanceId,
    cleanupState: "complete",
    nelosWorkers: [
      { workerId: "worker-a", archivedThreadIds: [A, B] },
      { workerId: "worker-b", archivedThreadIds: [A, B] },
    ],
    ordinaryMapThreadIds: [],
    nativeVisibleThreadIds: [],
    visualEvidence: visualEvidence(),
    ...overrides,
  });
  return {
    report,
    checkpoint,
    input: {
      schemaVersion: 1,
      startedAt: "2026-08-19T17:00:00.000Z",
      policy: { maxConvergenceMs: 60_000, requireArchiveReceipts: true, requireRestartCheckpoint: true, requiredConsecutiveAbsent: 2 },
      expectedThreads: [{ threadId: A, title: "Task A" }, { threadId: B, title: "Task B" }],
      archiveReceipts: [
        { schemaVersion: 1, type: "native-archive", actionId: "archive-a", threadId: A, archived: true },
        { schemaVersion: 1, type: "native-archive", actionId: "archive-b", threadId: B, archived: true },
      ],
      checkpoints: [
        checkpoint(1, "2026-08-19T17:00:10.000Z", "afterCleanup", "app-before"),
        checkpoint(2, "2026-08-19T17:00:20.000Z", "afterRestart", "app-after"),
      ],
    },
  };
}

test("passes only after every worker, native inventory, and visual surface converges across restart", async () => {
  const { input } = await fixture();
  const result = await validateArchiveProjectionConvergence(input);
  assert.equal(result.outcome, "passed");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.counts, { expectedThreads: 2, archiveReceipts: 2, checkpoints: 2, workers: 2, findings: 0 });
});

test("fails when cleanup completes while native and sidebar projections retain archived tasks", async () => {
  const { input, checkpoint } = await fixture();
  input.policy = { maxConvergenceMs: 60_000, requireArchiveReceipts: false, requireRestartCheckpoint: false, requiredConsecutiveAbsent: 1 };
  input.archiveReceipts = [];
  input.checkpoints = [checkpoint(1, "2026-08-19T17:00:10.000Z", "afterCleanup", "app-before", {
    nativeVisibleThreadIds: [A, B],
    visualEvidence: { ...input.checkpoints[0].visualEvidence, sidebarThreadIds: [A, B] },
  })];
  const result = await validateArchiveProjectionConvergence(input);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(new Set(result.findings.map(({ code }) => code)), new Set([
    "ARCHIVE_PROJECTION_DID_NOT_CONVERGE",
    "CLEANUP_COMPLETE_BEFORE_PROJECTION_CONVERGENCE",
    "NATIVE_ARCHIVE_PROJECTION_STALE",
    "SIDEBAR_ARCHIVE_PROJECTION_STALE",
  ]));
});

test("detects a lost receipt without replaying the archive mutation", async () => {
  const { input } = await fixture();
  input.archiveReceipts.pop();
  const result = await validateArchiveProjectionConvergence(input);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.findings.filter(({ code }) => code === "MISSING_ARCHIVE_RECEIPT").map(({ threadId }) => threadId), [B]);
});

test("detects cross-worker drift and a restart checkpoint from the same app instance", async () => {
  const { input } = await fixture();
  input.checkpoints[1].appInstanceId = "app-before";
  input.checkpoints[1].nelosWorkers[1].archivedThreadIds = [A];
  const result = await validateArchiveProjectionConvergence(input);
  assert.equal(result.outcome, "failed");
  assert.ok(result.findings.some(({ code }) => code === "RESTART_INSTANCE_NOT_CHANGED"));
  assert.ok(result.findings.some(({ code, threadId, workerId }) => code === "NELOS_WORKER_ARCHIVE_STATE_STALE" && threadId === B && workerId === "worker-b"));
  assert.ok(result.findings.some(({ code, threadId }) => code === "ARCHIVE_PROJECTION_DID_NOT_CONVERGE" && threadId === B));
});

test("rejects unknown fields, duplicate identities, tampered reports, and non-monotonic checkpoints", async () => {
  const unknown = await fixture();
  unknown.input.extra = true;
  await assert.rejects(validateArchiveProjectionConvergence(unknown.input), (error) => error.code === "INVALID_INPUT");

  const duplicate = await fixture();
  duplicate.input.expectedThreads[1].threadId = A;
  await assert.rejects(validateArchiveProjectionConvergence(duplicate.input), (error) => error.code === "INVALID_INPUT");

  const tampered = await fixture();
  await writeFile(tampered.report.path, "tampered\n");
  await assert.rejects(validateArchiveProjectionConvergence(tampered.input), (error) => error.code === "VISUAL_REPORT_DIGEST_MISMATCH");

  const time = await fixture();
  time.input.checkpoints[1].observedAt = "2026-08-19T17:00:05.000Z";
  await assert.rejects(validateArchiveProjectionConvergence(time.input), (error) => error.code === "INVALID_INPUT");
});
