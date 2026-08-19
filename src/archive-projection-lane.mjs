import { validateArchiveProjectionConvergence } from "./archive-projection-convergence.mjs";

const POLICY_KEYS = ["maxConvergenceMs", "requireArchiveReceipts", "requireRestartCheckpoint", "requiredConsecutiveAbsent"];
const THREAD_ID = /^[a-f0-9-]{8,80}$/u;

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
      !Number.isSafeInteger(request.policy.requiredConsecutiveAbsent) || request.policy.requiredConsecutiveAbsent < 2 || request.policy.requiredConsecutiveAbsent > 10) {
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

export class ArchiveProjectionLaneV1 {
  constructor({ adapter, clock = Date }) {
    assertAdapter(adapter);
    this.adapter = adapter;
    this.clock = clock;
  }

  async execute(request) {
    const input = validateRequest(request);
    const deadlineAt = new Date(input.startedAt).getTime() + input.policy.maxConvergenceMs;
    const stage = async (name, operation) => {
      const remaining = deadlineAt - this.clock.now();
      if (remaining < 1) throw new ArchiveProjectionLaneError("ARCHIVE_CONVERGENCE_DEADLINE", `${name} exceeded the shared convergence deadline`);
      let timer;
      try {
        return await Promise.race([
          operation(),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new ArchiveProjectionLaneError("ARCHIVE_CONVERGENCE_DEADLINE", `${name} exceeded the shared convergence deadline`)), remaining); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    const archiveReceipts = await stage("archive", () => this.adapter.archiveTasks({ schemaVersion: 1, runId: input.runId, expectedThreads: input.expectedThreads }));
    const afterCleanup = await stage("post-cleanup checkpoint", () => this.adapter.observeCheckpoint({ schemaVersion: 1, runId: input.runId, sequence: 1, phase: "afterCleanup", expectedThreads: input.expectedThreads }));
    const restart = await stage("Desktop restart", () => this.adapter.restartDesktop({ schemaVersion: 1, runId: input.runId, previousAppInstanceId: afterCleanup.appInstanceId }));
    exactObject(restart, ["newAppInstanceId", "previousAppInstanceId", "restarted", "schemaVersion", "type"], "restart receipt");
    if (restart.schemaVersion !== 1 || restart.type !== "desktop-restart" || restart.restarted !== true || restart.previousAppInstanceId !== afterCleanup.appInstanceId || restart.newAppInstanceId === restart.previousAppInstanceId) {
      throw new ArchiveProjectionLaneError("INVALID_RESTART_RECEIPT", "Desktop restart did not prove a new app instance");
    }
    const afterRestart = await stage("post-restart checkpoint", () => this.adapter.observeCheckpoint({ schemaVersion: 1, runId: input.runId, sequence: 2, phase: "afterRestart", expectedThreads: input.expectedThreads, expectedAppInstanceId: restart.newAppInstanceId }));
    const report = await validateArchiveProjectionConvergence({ schemaVersion: 1, startedAt: input.startedAt, policy: input.policy, expectedThreads: input.expectedThreads, archiveReceipts, checkpoints: [afterCleanup, afterRestart] });
    return Object.freeze({ schemaVersion: 1, type: "archive-projection-convergence", runId: input.runId, outcome: report.outcome, restart: structuredClone(restart), report });
  }

  async reconcileEffect(effect) {
    const receipt = await this.adapter.reconcileEffect(structuredClone(effect));
    exactObject(receipt, ["outcome", "report", "restart", "runId", "schemaVersion", "type"], "reconciled archive lane receipt");
    if (receipt.schemaVersion !== 1 || receipt.type !== "archive-projection-convergence" || receipt.runId !== effect.request?.runId || !["passed", "failed"].includes(receipt.outcome) || receipt.report?.kind !== "nelos-archive-projection-convergence" || receipt.report.outcome !== receipt.outcome) {
      throw new ArchiveProjectionLaneError("ARCHIVE_LANE_RECONCILIATION_REQUIRED", "archive lane reconciliation did not return an identity-matching terminal receipt");
    }
    return structuredClone(receipt);
  }
}
