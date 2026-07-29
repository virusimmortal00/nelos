import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  processMayOwnLease,
  readProcessIdentity,
} from "./process-liveness.mjs";

const PRE_QUEEN_THREAD_ID_FIELD = "coordinatorThreadId";

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function taskStateDirectory() {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "nelos");
}

function taskRegistryDirectory() {
  return join(taskStateDirectory(), "tasks");
}

function webRegistryDirectory() {
  return join(taskStateDirectory(), "webs");
}

function recordPath(directory, threadId) {
  return join(directory, `${encodeURIComponent(threadId)}.json`);
}

async function readRecord(directory, threadId, label) {
  try {
    return JSON.parse(await readFile(recordPath(directory, threadId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`failed to read ${label} ${threadId}: ${error.message}`);
  }
}

async function writeRecord(directory, record) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = recordPath(directory, record.threadId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function listRecords(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
      if (typeof record?.threadId === "string" && record.threadId) {
        records.push(record);
      }
    } catch {
      // A malformed entry must not prevent healthy state from being used.
    }
  }
  return records;
}

function normalizeQueenThreadId(record) {
  if (!record || !Object.hasOwn(record, PRE_QUEEN_THREAD_ID_FIELD)) return record;
  const normalized = {
    ...record,
    queenThreadId: Object.hasOwn(record, "queenThreadId")
      ? record.queenThreadId
      : record[PRE_QUEEN_THREAD_ID_FIELD],
  };
  delete normalized[PRE_QUEEN_THREAD_ID_FIELD];
  return normalized;
}

function normalizeTaskRegistryRecord(record) {
  if (!record?.web) return record;
  const web = normalizeQueenThreadId(record.web);
  return web === record.web ? record : { ...record, web };
}

export async function readTaskRegistryRecord(threadId) {
  return normalizeTaskRegistryRecord(
    await readRecord(taskRegistryDirectory(), threadId, "task registry entry"),
  );
}

export function writeTaskRegistryRecord(record) {
  return writeRecord(
    taskRegistryDirectory(),
    normalizeTaskRegistryRecord(record),
  );
}

export async function patchTaskRegistryRecord(threadId, patch) {
  const current = await readTaskRegistryRecord(threadId);
  if (!current) return;
  await writeTaskRegistryRecord({ ...current, ...patch });
}

export async function listTaskRegistryRecords() {
  return (await listRecords(taskRegistryDirectory())).map(
    normalizeTaskRegistryRecord,
  );
}

export async function readWebRecord(threadId) {
  return normalizeQueenThreadId(
    await readRecord(webRegistryDirectory(), threadId, "web entry"),
  );
}

export function writeWebRecord(record) {
  return writeRecord(webRegistryDirectory(), normalizeQueenThreadId(record));
}

export async function patchWebRecord(threadId, patch) {
  const current = await readWebRecord(threadId);
  if (!current) return;
  await writeWebRecord({ ...current, ...patch });
}

export async function listWebRecords() {
  return (await listRecords(webRegistryDirectory())).map(normalizeQueenThreadId);
}

async function moveStaleLock(lockPath) {
  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
    await rm(stalePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (["ENOENT", "EEXIST"].includes(error.code)) return false;
    throw error;
  }
}

async function withOwnedStateLock(lockName, callback, timeoutMs) {
  await mkdir(taskStateDirectory(), { recursive: true, mode: 0o700 });
  const lockPath = join(taskStateDirectory(), `${lockName}.lock`);
  const ownerPath = join(lockPath, "owner.json");
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const processIdentity = await readProcessIdentity(process.pid);
  if (!processIdentity) {
    throw new Error("could not establish the state-lock owner process identity");
  }

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(
          ownerPath,
          `${JSON.stringify({ pid: process.pid, token, processIdentity })}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      const owner = await readFile(ownerPath, "utf8")
        .then((contents) => JSON.parse(contents))
        .catch(() => null);
      const lockInfo = await stat(lockPath).catch(() => null);
      const activeIdentity = owner
        ? await readProcessIdentity(owner.pid)
        : null;
      // State callbacks are short and caller-bounded. Be conservative on
      // pid-only platforms: reclaim a live PID only when a strong identity
      // proves reuse, rather than expiring ownership mid-callback.
      const abandoned = owner
        ? !processMayOwnLease(owner.processIdentity, activeIdentity, true)
        : lockInfo && Date.now() - lockInfo.mtimeMs > 30_000;
      if (abandoned && (await moveStaleLock(lockPath))) continue;
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for web state");
      }
      await sleep(25);
    }
  }

  try {
    return await callback();
  } finally {
    const owner = await readFile(ownerPath, "utf8")
      .then((contents) => JSON.parse(contents))
      .catch(() => null);
    if (owner?.token === token) {
      const releasePath = `${lockPath}.release.${token}`;
      try {
        await rename(lockPath, releasePath);
        await rm(releasePath, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

export function withWebRegistryLock(callback) {
  return withOwnedStateLock("webs", callback, 60_000);
}

/**
 * Serialize one machine-local Nelos configuration transaction across MCP
 * processes without placing a filesystem path in the lock namespace.
 */
export function withNelosConfigurationLock(
  configPath,
  callback,
  timeoutMs = 60_000,
) {
  if (
    typeof configPath !== "string" ||
    configPath.length === 0 ||
    configPath.length > 4_096 ||
    !isAbsolute(configPath)
  ) {
    throw new Error("Nelos configuration lock requires a bounded absolute path");
  }
  const lockId = createHash("sha256").update(configPath, "utf8").digest("hex");
  return withOwnedStateLock(`configuration-${lockId}`, callback, timeoutMs);
}

export function withQueenSpinoffLock(threadId, callback, timeoutMs = 60_000) {
  return withOwnedStateLock(
    `spinoff-${encodeURIComponent(threadId)}`,
    callback,
    timeoutMs,
  );
}

/**
 * Serialize a queen's decision for one exact result provenance. The digest
 * keeps untrusted task/source identifiers out of the lock-path namespace.
 */
export function withQueenAcceptanceLock(decisionId, callback, timeoutMs = 60_000) {
  if (typeof decisionId !== "string" || decisionId.length === 0 || decisionId.length > 512) {
    throw new Error("queen acceptance lock requires a bounded decision ID");
  }
  const lockId = createHash("sha256").update(decisionId, "utf8").digest("hex");
  return withOwnedStateLock(`queen-acceptance-${lockId}`, callback, timeoutMs);
}

/**
 * Serialize one orchestration decision across adapters and processes. The
 * digest keeps the caller-controlled work-unit ID out of the lock namespace.
 */
export function withExecutionOrchestrationLock(
  workUnitId,
  callback,
  timeoutMs = 60_000,
) {
  if (
    typeof workUnitId !== "string" ||
    workUnitId.length === 0 ||
    workUnitId.length > 128
  ) {
    throw new Error("execution orchestration lock requires a bounded work-unit ID");
  }
  const lockId = createHash("sha256").update(workUnitId, "utf8").digest("hex");
  return withOwnedStateLock(`execution-${lockId}`, callback, timeoutMs);
}

/**
 * Serialize one receipt-driven planning lifecycle across MCP processes.
 */
export function withPlanningLifecycleLock(
  bootstrapId,
  callback,
  timeoutMs = 60_000,
) {
  if (!/^plan:[a-f0-9]{24}$/u.test(bootstrapId)) {
    throw new Error("planning lifecycle lock requires a valid bootstrap ID");
  }
  const lockId = createHash("sha256").update(bootstrapId, "utf8").digest("hex");
  return withOwnedStateLock(`planning-${lockId}`, callback, timeoutMs);
}

/**
 * Serialize mutable progress updates for one persisted plan run.
 */
export function withPlanRunLock(
  planRunId,
  callback,
  timeoutMs = 60_000,
) {
  if (!/^run:[a-f0-9]{40}$/u.test(planRunId)) {
    throw new Error("plan run lock requires a valid plan-run ID");
  }
  const lockId = createHash("sha256").update(planRunId, "utf8").digest("hex");
  return withOwnedStateLock(`plan-run-${lockId}`, callback, timeoutMs);
}

/**
 * Serialize one web checkpoint read/reduce/write transaction.
 */
export function withObservationCheckpointLock(
  webId,
  queenThreadId,
  callback,
  timeoutMs = 60_000,
) {
  if (
    typeof webId !== "string" ||
    webId.length === 0 ||
    webId.length > 256 ||
    typeof queenThreadId !== "string" ||
    queenThreadId.length === 0 ||
    queenThreadId.length > 256
  ) {
    throw new Error("observation checkpoint lock requires bounded web identities");
  }
  const lockId = createHash("sha256")
    .update(JSON.stringify([webId, queenThreadId]), "utf8")
    .digest("hex");
  return withOwnedStateLock(`observation-${lockId}`, callback, timeoutMs);
}

/**
 * Serialize a short-lived effect that changes one Git repository's worktree
 * topology. The key is a stable, opaque repository identity rather than a
 * path, so callers never place an untrusted filesystem path in a lock name.
 */
export function withRepositoryProvisioningLock(
  repositoryId,
  callback,
  timeoutMs = 60_000,
) {
  if (!/^[a-f0-9]{64}$/u.test(repositoryId)) {
    throw new Error("repository provisioning lock requires a SHA-256 repository ID");
  }
  return withOwnedStateLock(`repository-${repositoryId}`, callback, timeoutMs);
}
