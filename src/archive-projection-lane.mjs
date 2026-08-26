import { validateArchiveProjectionConvergence } from "./archive-projection-convergence.mjs";

const POLICY_KEYS = ["maxConvergenceMs", "requireArchiveReceipts", "requireRestartCheckpoint", "requiredConsecutiveAbsent"];
const CHECKPOINT_KEYS = ["appInstanceId", "cleanupState", "nelosWorkers", "nativeVisibleThreadIds", "observedAt", "ordinaryMapThreadIds", "phase", "sequence", "visualEvidence"];
const THREAD_ID = /^[a-f0-9-]{8,80}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REPORT_KEYS = ["counts", "evidence", "findings", "kind", "outcome", "policy", "schemaVersion"];
const REPORT_COUNT_KEYS = ["archiveReceipts", "checkpoints", "expectedThreads", "findings", "workers"];
const REPORT_EVIDENCE_KEYS = ["captureDigest", "cleanupState", "observedAt", "phase", "sequence", "visualReportDigest"];
const FINDING_DETAIL_KEYS = new Map([
  ["MISSING_ARCHIVE_RECEIPT", []],
  ["MISSING_RESTART_CHECKPOINT", []],
  ["MISSING_PRE_RESTART_CHECKPOINT", []],
  ["RESTART_INSTANCE_NOT_CHANGED", ["checkpoint"]],
  ["NELOS_WORKER_ARCHIVE_STATE_STALE", ["checkpoint", "workerId"]],
  ["ORDINARY_MAP_ARCHIVE_PROJECTION_STALE", ["checkpoint", "phase", "source"]],
  ["NATIVE_ARCHIVE_PROJECTION_STALE", ["checkpoint", "phase", "source"]],
  ["SIDEBAR_ARCHIVE_PROJECTION_STALE", ["checkpoint", "phase", "source"]],
  ["CREATED_TASKS_ARCHIVE_PROJECTION_STALE", ["checkpoint", "phase", "source"]],
  ["MCP_VISUAL_ARCHIVE_PROJECTION_STALE", ["checkpoint", "phase", "source"]],
  ["CLEANUP_COMPLETE_BEFORE_PROJECTION_CONVERGENCE", ["checkpoint", "phase"]],
  ["INSUFFICIENT_CONVERGENCE_CHECKPOINTS", ["observed", "required"]],
  ["ARCHIVE_PROJECTION_DID_NOT_CONVERGE", ["deadlineAt", "requiredConsecutiveAbsent"]],
]);

export class ArchiveProjectionLaneError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ArchiveProjectionLaneError";
    this.code = code;
    this.details = details;
  }
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new ArchiveProjectionLaneError("INVALID_ARCHIVE_LANE_INPUT", `${label} fields do not match the closed archive lane contract`);
  }
}

function validateRequest(request) {
  exactObject(request, ["expectedThreads", "policy", "runId", "schemaVersion", "startedAt"], "request");
  if (request.schemaVersion !== 1 || typeof request.runId !== "string" || request.runId.length < 1 || request.runId.length > 240) {
    throw new ArchiveProjectionLaneError("INVALID_ARCHIVE_LANE_INPUT", "archive lane request identity is invalid");
  }
  exactObject(request.policy, POLICY_KEYS, "request.policy");
  if (!Number.isSafeInteger(request.policy.maxConvergenceMs) || request.policy.maxConvergenceMs < 1 || request.policy.maxConvergenceMs > 3_600_000 ||
      request.policy.requireArchiveReceipts !== true || request.policy.requireRestartCheckpoint !== true ||
      !Number.isSafeInteger(request.policy.requiredConsecutiveAbsent) || request.policy.requiredConsecutiveAbsent !== 2) {
    throw new ArchiveProjectionLaneError("INVALID_ARCHIVE_LANE_POLICY", "live archive convergence requires receipts, restart, and two clean checkpoints");
  }
  const started = new Date(request.startedAt);
  if (typeof request.startedAt !== "string" || Number.isNaN(started.getTime()) || started.toISOString() !== request.startedAt ||
      !Array.isArray(request.expectedThreads) || request.expectedThreads.length < 1 || request.expectedThreads.length > 100) {
    throw new ArchiveProjectionLaneError("INVALID_ARCHIVE_LANE_INPUT", "archive lane requires expected Desktop tasks");
  }
  const ids = new Set();
  for (const [index, thread] of request.expectedThreads.entries()) {
    exactObject(thread, ["threadId", "title"], `request.expectedThreads[${index}]`);
    if (typeof thread.threadId !== "string" || !THREAD_ID.test(thread.threadId) || ids.has(thread.threadId) || typeof thread.title !== "string" || thread.title.length < 1 || thread.title.length > 240) {
      throw new ArchiveProjectionLaneError("INVALID_ARCHIVE_LANE_INPUT", "archive lane task identities are invalid or duplicated");
    }
    ids.add(thread.threadId);
  }
  return structuredClone(request);
}

function assertAdapter(adapter) {
  for (const method of ["archiveTasks", "observeCheckpoint", "restartDesktop", "reconcileEffect"]) {
    if (typeof adapter?.[method] !== "function") throw new ArchiveProjectionLaneError("INVALID_ARCHIVE_LANE_ADAPTER", `archive lane adapter is missing ${method}`);
  }
}

function canonicalDate(value) {
  if (typeof value !== "string") return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function reportInteger(value, minimum = 0, maximum = 10_000) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateTerminalReceipt(receipt, request) {
  exactObject(receipt, ["outcome", "report", "restart", "runId", "schemaVersion", "type"], "reconciled archive lane receipt");
  if (receipt.schemaVersion !== 1 || receipt.type !== "archive-projection-convergence" || receipt.runId !== request.runId || !["passed", "failed"].includes(receipt.outcome)) {
    throw new Error("receipt identity mismatch");
  }
  exactObject(receipt.restart, ["newAppInstanceId", "previousAppInstanceId", "restarted", "schemaVersion", "type"], "reconciled restart receipt");
  if (receipt.restart.schemaVersion !== 1 || receipt.restart.type !== "desktop-restart" || receipt.restart.restarted !== true ||
      typeof receipt.restart.previousAppInstanceId !== "string" || receipt.restart.previousAppInstanceId.length < 1 ||
      typeof receipt.restart.newAppInstanceId !== "string" || receipt.restart.newAppInstanceId.length < 1 ||
      receipt.restart.newAppInstanceId === receipt.restart.previousAppInstanceId) {
    throw new Error("restart receipt mismatch");
  }

  const report = receipt.report;
  exactObject(report, REPORT_KEYS, "reconciled convergence report");
  exactObject(report.policy, POLICY_KEYS, "reconciled convergence policy");
  exactObject(report.counts, REPORT_COUNT_KEYS, "reconciled convergence counts");
  if (report.schemaVersion !== 1 || report.kind !== "nelos-archive-projection-convergence" || report.outcome !== receipt.outcome ||
      JSON.stringify(report.policy) !== JSON.stringify(request.policy) ||
      !Array.isArray(report.evidence) || !Array.isArray(report.findings) ||
      !REPORT_COUNT_KEYS.every((key) => reportInteger(report.counts[key])) ||
      report.counts.expectedThreads !== request.expectedThreads.length || report.counts.checkpoints !== report.evidence.length ||
      report.counts.archiveReceipts > report.counts.expectedThreads || report.counts.workers < 1 || report.counts.workers > 32 ||
      report.counts.checkpoints < 1 || report.counts.checkpoints > 50 ||
      report.counts.findings !== report.findings.length ||
      (report.outcome === "passed" ? report.findings.length !== 0 : report.findings.length === 0)) {
    throw new Error("convergence report mismatch");
  }
  let priorObservedAt = Date.parse(request.startedAt);
  const captureDigests = new Set();
  const reportDigests = new Set();
  for (const [index, evidence] of report.evidence.entries()) {
    exactObject(evidence, REPORT_EVIDENCE_KEYS, `reconciled convergence evidence[${index}]`);
    const observedAt = Date.parse(evidence.observedAt);
    if (evidence.sequence !== index + 1 || !canonicalDate(evidence.observedAt) || observedAt < priorObservedAt ||
        !["afterArchiveReceipt", "afterCleanup", "afterRestart", "settled"].includes(evidence.phase) ||
        !["effects-required", "archiving", "complete", "attention"].includes(evidence.cleanupState) ||
        !DIGEST.test(evidence.captureDigest) || !DIGEST.test(evidence.visualReportDigest) ||
        captureDigests.has(evidence.captureDigest) || reportDigests.has(evidence.visualReportDigest)) {
      throw new Error("convergence evidence mismatch");
    }
    captureDigests.add(evidence.captureDigest);
    reportDigests.add(evidence.visualReportDigest);
    priorObservedAt = observedAt;
  }
  for (const [index, finding] of report.findings.entries()) {
    const detailKeys = FINDING_DETAIL_KEYS.get(finding?.code);
    if (!detailKeys) throw new Error("unknown convergence finding");
    exactObject(finding, ["code", "threadId", ...detailKeys], `reconciled convergence finding[${index}]`);
    if (finding.threadId !== null && (typeof finding.threadId !== "string" || !THREAD_ID.test(finding.threadId))) {
      throw new Error("convergence finding identity mismatch");
    }
    if ((Object.hasOwn(finding, "checkpoint") && !reportInteger(finding.checkpoint, 1, 50)) ||
        (Object.hasOwn(finding, "workerId") && (typeof finding.workerId !== "string" || finding.workerId.length < 1 || finding.workerId.length > 240)) ||
        (Object.hasOwn(finding, "phase") && !["afterArchiveReceipt", "afterCleanup", "afterRestart", "settled"].includes(finding.phase)) ||
        (Object.hasOwn(finding, "source") && !["ordinaryMap", "nativeInventory", "sidebar", "createdTasks", "mcpVisual"].includes(finding.source)) ||
        (Object.hasOwn(finding, "deadlineAt") && !canonicalDate(finding.deadlineAt)) ||
        (Object.hasOwn(finding, "requiredConsecutiveAbsent") && !reportInteger(finding.requiredConsecutiveAbsent, 1, 10)) ||
        (Object.hasOwn(finding, "required") && !reportInteger(finding.required, 1, 10)) ||
        (Object.hasOwn(finding, "observed") && !reportInteger(finding.observed, 0, 10))) {
      throw new Error("convergence finding details mismatch");
    }
  }
}

export class ArchiveProjectionLaneV1 {
  constructor({ adapter, clock = Date }) {
    assertAdapter(adapter);
    this.adapter = adapter;
    this.clock = clock;
  }

  async execute(request, options = {}) {
    const input = validateRequest(request);
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new ArchiveProjectionLaneError("INVALID_ARCHIVE_LANE_INPUT", "archive lane options must be an object");
    exactObject(options, Object.hasOwn(options, "hardDeadlineAt") ? ["hardDeadlineAt"] : [], "archive lane options");
    const convergenceDeadlineAt = new Date(input.startedAt).getTime() + input.policy.maxConvergenceMs;
    let hardDeadlineAt = null;
    if (Object.hasOwn(options, "hardDeadlineAt")) {
      hardDeadlineAt = Date.parse(options.hardDeadlineAt);
      if (typeof options.hardDeadlineAt !== "string" || !Number.isFinite(hardDeadlineAt) || new Date(hardDeadlineAt).toISOString() !== options.hardDeadlineAt) {
        throw new ArchiveProjectionLaneError("INVALID_ARCHIVE_LANE_INPUT", "archive lane absolute run deadline is invalid");
      }
    }
    const deadlineAt = hardDeadlineAt === null ? convergenceDeadlineAt : Math.min(convergenceDeadlineAt, hardDeadlineAt);
    const deadlineCode = hardDeadlineAt !== null && hardDeadlineAt <= convergenceDeadlineAt ? "RUN_DEADLINE_EXPIRED" : "ARCHIVE_CONVERGENCE_DEADLINE";
    const stage = async (name, operation) => {
      const remaining = deadlineAt - this.clock.now();
      if (remaining < 1) throw new ArchiveProjectionLaneError(deadlineCode, `${name} exceeded the shared archive deadline`);
      let timer; const abort = new AbortController();
      try {
        const result = await Promise.race([
          operation(abort.signal),
          new Promise((resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new ArchiveProjectionLaneError(deadlineCode, `${name} exceeded the shared archive deadline`)); }, remaining); }),
        ]);
        if (this.clock.now() >= deadlineAt) {
          abort.abort();
          throw new ArchiveProjectionLaneError(deadlineCode, `${name} exceeded the shared archive deadline`);
        }
        return result;
      } finally { clearTimeout(timer); }
    };
    const archiveReceipts = await stage("archive", (signal) => this.adapter.archiveTasks({ schemaVersion: 1, runId: input.runId, expectedThreads: input.expectedThreads }, { signal }));
    const afterCleanup = await stage("post-cleanup checkpoint", (signal) => this.adapter.observeCheckpoint({ schemaVersion: 1, runId: input.runId, sequence: 1, phase: "afterCleanup", expectedThreads: input.expectedThreads }, { signal }));
    exactObject(afterCleanup, CHECKPOINT_KEYS, "post-cleanup checkpoint");
    const restart = await stage("Desktop restart", (signal) => this.adapter.restartDesktop({ schemaVersion: 1, runId: input.runId, previousAppInstanceId: afterCleanup.appInstanceId }, { signal }));
    exactObject(restart, ["newAppInstanceId", "previousAppInstanceId", "restarted", "schemaVersion", "type"], "restart receipt");
    if (restart.schemaVersion !== 1 || restart.type !== "desktop-restart" || restart.restarted !== true || restart.previousAppInstanceId !== afterCleanup.appInstanceId || restart.newAppInstanceId === restart.previousAppInstanceId) {
      throw new ArchiveProjectionLaneError("INVALID_RESTART_RECEIPT", "Desktop restart did not prove a new app instance");
    }
    const afterRestart = await stage("post-restart checkpoint", (signal) => this.adapter.observeCheckpoint({ schemaVersion: 1, runId: input.runId, sequence: 2, phase: "afterRestart", expectedThreads: input.expectedThreads, expectedAppInstanceId: restart.newAppInstanceId }, { signal }));
    const report = await stage("archive convergence validation", () => validateArchiveProjectionConvergence({ schemaVersion: 1, startedAt: input.startedAt, policy: input.policy, expectedThreads: input.expectedThreads, archiveReceipts, checkpoints: [afterCleanup, afterRestart] }));
    return Object.freeze({ schemaVersion: 1, type: "archive-projection-convergence", runId: input.runId, outcome: report.outcome, restart: structuredClone(restart), report });
  }

  async reconcileEffect(effect) {
    let request;
    try { request = validateRequest(effect?.request); }
    catch {
      throw new ArchiveProjectionLaneError("ARCHIVE_LANE_RECONCILIATION_REQUIRED", "archive lane reconciliation did not return an identity-matching terminal receipt");
    }
    const receipt = await this.adapter.reconcileEffect(structuredClone(effect));
    try { validateTerminalReceipt(receipt, request); }
    catch {
      throw new ArchiveProjectionLaneError("ARCHIVE_LANE_RECONCILIATION_REQUIRED", "archive lane reconciliation did not return a complete identity-matching terminal receipt");
    }
    return structuredClone(receipt);
  }
}
