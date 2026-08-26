import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const INPUT_KEYS = ["archiveReceipts", "checkpoints", "expectedThreads", "policy", "schemaVersion", "startedAt"];
const POLICY_KEYS = ["maxConvergenceMs", "requireArchiveReceipts", "requireRestartCheckpoint", "requiredConsecutiveAbsent"];
const THREAD_KEYS = ["threadId", "title"];
const RECEIPT_KEYS = ["actionId", "archived", "schemaVersion", "threadId", "type"];
const CHECKPOINT_KEYS = ["appInstanceId", "cleanupState", "nelosWorkers", "nativeVisibleThreadIds", "observedAt", "ordinaryMapThreadIds", "phase", "sequence", "visualEvidence"];
const WORKER_KEYS = ["archivedThreadIds", "workerId"];
const THREAD_ID = /^[a-f0-9-]{8,80}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PHASES = new Set(["afterArchiveReceipt", "afterCleanup", "afterRestart", "settled"]);
const CLEANUP_STATES = new Set(["effects-required", "archiving", "complete", "attention"]);

export class ArchiveProjectionConvergenceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ArchiveProjectionConvergenceError";
    this.code = code;
  }
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function boundedString(value, label, maximum = 240) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must be a non-empty bounded string`);
  }
  return value;
}

function identifier(value, label) {
  const resolved = boundedString(value, label);
  if (!IDENTIFIER.test(resolved)) throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must be a bounded identifier`);
  return resolved;
}

function threadId(value, label) {
  if (typeof value !== "string" || !THREAD_ID.test(value)) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must be a bounded thread identifier`);
  }
  return value;
}

function dateMillis(value, label) {
  if (typeof value !== "string") throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must be a canonical ISO timestamp`);
  }
  return date.getTime();
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function idArray(value, label, maximum = 500) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must contain at most ${maximum} thread IDs`);
  }
  const ids = value.map((item, index) => threadId(item, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} contains duplicate thread IDs`);
  return ids;
}

async function verifiedReportDigest(value, label) {
  const path = boundedString(value.path, `${label}.path`, 4096);
  if (!isAbsolute(path) || !DIGEST.test(value.digest)) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `${label} must bind an absolute path to a SHA-256 digest`);
  }
  const resolved = resolve(path);
  let info;
  try { info = await lstat(resolved); }
  catch { throw new ArchiveProjectionConvergenceError("INVALID_VISUAL_REPORT", `${label} could not be read`); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024) {
    throw new ArchiveProjectionConvergenceError("INVALID_VISUAL_REPORT", `${label} must reference a bounded regular file`);
  }
  let bytes;
  try { bytes = await readFile(resolved); }
  catch { throw new ArchiveProjectionConvergenceError("INVALID_VISUAL_REPORT", `${label} could not be read`); }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== value.digest) throw new ArchiveProjectionConvergenceError("VISUAL_REPORT_DIGEST_MISMATCH", `${label} digest does not match its report`);
  let report;
  try { report = JSON.parse(bytes); }
  catch { throw new ArchiveProjectionConvergenceError("INVALID_VISUAL_REPORT", `${label} is not valid JSON`); }
  if (report?.schemaVersion !== 1 || report?.kind !== "nelos-developer-visual-state-validation" || report?.outcome !== "passed" || !DIGEST.test(report?.capture?.digest)) {
    throw new ArchiveProjectionConvergenceError("INVALID_VISUAL_REPORT", `${label} does not reference a visual-state validation report`);
  }
  return { reportDigest: digest, captureDigest: report.capture.digest };
}

function finding(code, threadIdValue, details = {}) {
  return { code, threadId: threadIdValue, ...details };
}

export async function validateArchiveProjectionConvergence(input) {
  exactObject(input, INPUT_KEYS, "input");
  if (input.schemaVersion !== 1) throw new ArchiveProjectionConvergenceError("INVALID_INPUT", "schemaVersion must be 1");
  const startedAt = dateMillis(input.startedAt, "startedAt");
  exactObject(input.policy, POLICY_KEYS, "policy");
  const policy = {
    maxConvergenceMs: integer(input.policy.maxConvergenceMs, "policy.maxConvergenceMs", 1, 3_600_000),
    requireArchiveReceipts: input.policy.requireArchiveReceipts,
    requireRestartCheckpoint: input.policy.requireRestartCheckpoint,
    requiredConsecutiveAbsent: integer(input.policy.requiredConsecutiveAbsent, "policy.requiredConsecutiveAbsent", 1, 10),
  };
  if (typeof policy.requireArchiveReceipts !== "boolean" || typeof policy.requireRestartCheckpoint !== "boolean") {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", "policy receipt and restart requirements must be booleans");
  }

  if (!Array.isArray(input.expectedThreads) || input.expectedThreads.length < 1 || input.expectedThreads.length > 100) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", "expectedThreads must contain 1 through 100 entries");
  }
  const expectedThreads = input.expectedThreads.map((entry, index) => {
    exactObject(entry, THREAD_KEYS, `expectedThreads[${index}]`);
    return { threadId: threadId(entry.threadId, `expectedThreads[${index}].threadId`), title: boundedString(entry.title, `expectedThreads[${index}].title`) };
  });
  const expectedIds = expectedThreads.map(({ threadId: value }) => value);
  if (new Set(expectedIds).size !== expectedIds.length) throw new ArchiveProjectionConvergenceError("INVALID_INPUT", "expectedThreads contains duplicate thread IDs");
  const expectedSet = new Set(expectedIds);

  if (!Array.isArray(input.archiveReceipts) || input.archiveReceipts.length > 100) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", "archiveReceipts must contain at most 100 receipts");
  }
  const receiptIds = new Set();
  for (const [index, receipt] of input.archiveReceipts.entries()) {
    exactObject(receipt, RECEIPT_KEYS, `archiveReceipts[${index}]`);
    const id = threadId(receipt.threadId, `archiveReceipts[${index}].threadId`);
    if (!expectedSet.has(id) || receiptIds.has(id) || receipt.schemaVersion !== 1 || receipt.type !== "native-archive" || receipt.archived !== true) {
      throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `archiveReceipts[${index}] is mismatched or duplicated`);
    }
    identifier(receipt.actionId, `archiveReceipts[${index}].actionId`);
    receiptIds.add(id);
  }

  if (!Array.isArray(input.checkpoints) || input.checkpoints.length < 1 || input.checkpoints.length > 50) {
    throw new ArchiveProjectionConvergenceError("INVALID_INPUT", "checkpoints must contain 1 through 50 entries");
  }
  const checkpoints = [];
  for (const [index, checkpoint] of input.checkpoints.entries()) {
    exactObject(checkpoint, CHECKPOINT_KEYS, `checkpoints[${index}]`);
    const sequence = integer(checkpoint.sequence, `checkpoints[${index}].sequence`, 1, 50);
    if (sequence !== index + 1) throw new ArchiveProjectionConvergenceError("INVALID_INPUT", "checkpoint sequences must be contiguous and one-based");
    const observedAt = dateMillis(checkpoint.observedAt, `checkpoints[${index}].observedAt`);
    if (observedAt < startedAt || (index > 0 && observedAt < checkpoints.at(-1).observedAt)) {
      throw new ArchiveProjectionConvergenceError("INVALID_INPUT", "checkpoint timestamps must be monotonic and no earlier than startedAt");
    }
    if (!PHASES.has(checkpoint.phase) || !CLEANUP_STATES.has(checkpoint.cleanupState)) {
      throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `checkpoints[${index}] has an unsupported phase or cleanup state`);
    }
    if (!Array.isArray(checkpoint.nelosWorkers) || checkpoint.nelosWorkers.length < 1 || checkpoint.nelosWorkers.length > 32) {
      throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `checkpoints[${index}].nelosWorkers must contain 1 through 32 workers`);
    }
    const workerIds = new Set();
    const nelosWorkers = checkpoint.nelosWorkers.map((worker, workerIndex) => {
      exactObject(worker, WORKER_KEYS, `checkpoints[${index}].nelosWorkers[${workerIndex}]`);
      const workerId = identifier(worker.workerId, `checkpoints[${index}].nelosWorkers[${workerIndex}].workerId`);
      if (workerIds.has(workerId)) throw new ArchiveProjectionConvergenceError("INVALID_INPUT", `checkpoints[${index}] contains duplicate workers`);
      workerIds.add(workerId);
      return { workerId, archivedThreadIds: idArray(worker.archivedThreadIds, `checkpoints[${index}].nelosWorkers[${workerIndex}].archivedThreadIds`) };
    });
    exactObject(checkpoint.visualEvidence, ["createdTasksThreadIds", "mcpVisualThreadIds", "report", "sidebarThreadIds"], `checkpoints[${index}].visualEvidence`);
    exactObject(checkpoint.visualEvidence.report, ["digest", "path"], `checkpoints[${index}].visualEvidence.report`);
    const report = await verifiedReportDigest(checkpoint.visualEvidence.report, `checkpoints[${index}].visualEvidence.report`);
    checkpoints.push({
      sequence,
      appInstanceId: identifier(checkpoint.appInstanceId, `checkpoints[${index}].appInstanceId`),
      observedAt,
      observedAtText: checkpoint.observedAt,
      phase: checkpoint.phase,
      cleanupState: checkpoint.cleanupState,
      nelosWorkers,
      ordinaryMapThreadIds: idArray(checkpoint.ordinaryMapThreadIds, `checkpoints[${index}].ordinaryMapThreadIds`),
      nativeVisibleThreadIds: idArray(checkpoint.nativeVisibleThreadIds, `checkpoints[${index}].nativeVisibleThreadIds`),
      visualEvidence: {
        ...report,
        sidebarThreadIds: idArray(checkpoint.visualEvidence.sidebarThreadIds, `checkpoints[${index}].visualEvidence.sidebarThreadIds`),
        createdTasksThreadIds: idArray(checkpoint.visualEvidence.createdTasksThreadIds, `checkpoints[${index}].visualEvidence.createdTasksThreadIds`),
        mcpVisualThreadIds: idArray(checkpoint.visualEvidence.mcpVisualThreadIds, `checkpoints[${index}].visualEvidence.mcpVisualThreadIds`),
      },
    });
  }

  const findings = [];
  if (policy.requireArchiveReceipts) {
    for (const id of expectedIds) if (!receiptIds.has(id)) findings.push(finding("MISSING_ARCHIVE_RECEIPT", id));
  }
  if (policy.requireRestartCheckpoint && !checkpoints.some(({ phase }) => phase === "afterRestart")) {
    findings.push(finding("MISSING_RESTART_CHECKPOINT", null));
  }
  if (policy.requireRestartCheckpoint) {
    const firstRestart = checkpoints.findIndex(({ phase }) => phase === "afterRestart");
    if (firstRestart === 0) {
      findings.push(finding("MISSING_PRE_RESTART_CHECKPOINT", null));
    } else if (firstRestart > 0 && checkpoints[firstRestart].appInstanceId === checkpoints[firstRestart - 1].appInstanceId) {
      findings.push(finding("RESTART_INSTANCE_NOT_CHANGED", null, { checkpoint: checkpoints[firstRestart].sequence }));
    }
  }

  for (const checkpoint of checkpoints) {
    const sources = [
      ["ORDINARY_MAP_ARCHIVE_PROJECTION_STALE", "ordinaryMap", checkpoint.ordinaryMapThreadIds],
      ["NATIVE_ARCHIVE_PROJECTION_STALE", "nativeInventory", checkpoint.nativeVisibleThreadIds],
      ["SIDEBAR_ARCHIVE_PROJECTION_STALE", "sidebar", checkpoint.visualEvidence.sidebarThreadIds],
      ["CREATED_TASKS_ARCHIVE_PROJECTION_STALE", "createdTasks", checkpoint.visualEvidence.createdTasksThreadIds],
      ["MCP_VISUAL_ARCHIVE_PROJECTION_STALE", "mcpVisual", checkpoint.visualEvidence.mcpVisualThreadIds],
    ];
    for (const worker of checkpoint.nelosWorkers) {
      for (const id of expectedIds) if (!worker.archivedThreadIds.includes(id)) findings.push(finding("NELOS_WORKER_ARCHIVE_STATE_STALE", id, { checkpoint: checkpoint.sequence, workerId: worker.workerId }));
    }
    for (const [code, source, ids] of sources) {
      for (const id of expectedIds) if (ids.includes(id)) findings.push(finding(code, id, { checkpoint: checkpoint.sequence, phase: checkpoint.phase, source }));
    }
    const workerStale = checkpoint.nelosWorkers.some(({ archivedThreadIds }) => expectedIds.some((id) => !archivedThreadIds.includes(id)));
    if (checkpoint.cleanupState === "complete" && (workerStale || sources.some(([, , ids]) => expectedIds.some((id) => ids.includes(id))))) {
      findings.push(finding("CLEANUP_COMPLETE_BEFORE_PROJECTION_CONVERGENCE", null, { checkpoint: checkpoint.sequence, phase: checkpoint.phase }));
    }
  }

  const deadlineAt = startedAt + policy.maxConvergenceMs;
  const onTime = checkpoints.filter(({ observedAt }) => observedAt <= deadlineAt);
  const finalWindow = onTime.slice(-policy.requiredConsecutiveAbsent);
  if (finalWindow.length < policy.requiredConsecutiveAbsent) {
    findings.push(finding("INSUFFICIENT_CONVERGENCE_CHECKPOINTS", null, { required: policy.requiredConsecutiveAbsent, observed: finalWindow.length }));
  } else {
    for (const id of expectedIds) {
      const converged = finalWindow.every((checkpoint) =>
        checkpoint.nelosWorkers.every(({ archivedThreadIds }) => archivedThreadIds.includes(id)) &&
        !checkpoint.ordinaryMapThreadIds.includes(id) &&
        !checkpoint.nativeVisibleThreadIds.includes(id) &&
        !checkpoint.visualEvidence.sidebarThreadIds.includes(id) &&
        !checkpoint.visualEvidence.createdTasksThreadIds.includes(id) &&
        !checkpoint.visualEvidence.mcpVisualThreadIds.includes(id));
      if (!converged) findings.push(finding("ARCHIVE_PROJECTION_DID_NOT_CONVERGE", id, { deadlineAt: new Date(deadlineAt).toISOString(), requiredConsecutiveAbsent: policy.requiredConsecutiveAbsent }));
    }
  }

  findings.sort((left, right) => `${left.threadId ?? ""}:${left.code}:${left.checkpoint ?? 0}`.localeCompare(`${right.threadId ?? ""}:${right.code}:${right.checkpoint ?? 0}`));
  return Object.freeze({
    schemaVersion: 1,
    kind: "nelos-archive-projection-convergence",
    outcome: findings.length === 0 ? "passed" : "failed",
    policy,
    counts: { expectedThreads: expectedIds.length, archiveReceipts: receiptIds.size, checkpoints: checkpoints.length, workers: new Set(checkpoints.flatMap(({ nelosWorkers }) => nelosWorkers.map(({ workerId }) => workerId))).size, findings: findings.length },
    evidence: checkpoints.map(({ sequence, observedAtText, phase, cleanupState, visualEvidence }) => ({ sequence, observedAt: observedAtText, phase, cleanupState, captureDigest: visualEvidence.captureDigest, visualReportDigest: visualEvidence.reportDigest })),
    findings,
  });
}
