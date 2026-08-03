import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export function normalizedProcessIdentity(identity) {
  if (typeof identity === "string") {
    const separator = identity.indexOf(":");
    return separator > 0
      ? { [identity.slice(0, separator)]: identity.slice(separator + 1) }
      : {};
  }
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(identity)
      .filter(([, value]) => ["string", "number"].includes(typeof value))
      .map(([kind, value]) => [kind, String(value)]),
  );
}

export function processIdentitiesProveReplacement(recorded, active) {
  const recordedIdentities = normalizedProcessIdentity(recorded);
  const activeIdentities = normalizedProcessIdentity(active);
  const commonStrongKinds = Object.keys(recordedIdentities).filter(
    (kind) => kind !== "pid-only" && Object.hasOwn(activeIdentities, kind),
  );
  return (
    commonStrongKinds.length > 0 &&
    commonStrongKinds.every(
      (kind) => recordedIdentities[kind] !== activeIdentities[kind],
    )
  );
}

export function processIdentitiesMatch(recorded, active) {
  const recordedIdentities = normalizedProcessIdentity(recorded);
  const activeIdentities = normalizedProcessIdentity(active);
  return Object.keys(recordedIdentities).some(
    (kind) =>
      kind !== "pid-only" &&
      Object.hasOwn(activeIdentities, kind) &&
      recordedIdentities[kind] === activeIdentities[kind],
  );
}

export function processMayOwnLease(
  recordedIdentity,
  activeIdentity,
  leaseIsFresh,
) {
  if (
    activeIdentity === null ||
    processIdentitiesProveReplacement(recordedIdentity, activeIdentity)
  ) {
    return false;
  }
  return (
    processIdentitiesMatch(recordedIdentity, activeIdentity) ||
    Boolean(leaseIsFresh)
  );
}

/**
 * Build a process-identity reader. Keeping the primitive injectable makes the
 * cache policy testable without depending on a particular host's `ps`.
 */
export function createProcessIdentityReader({
  isRunning = processIsRunning,
  readStat = (path) => readFile(path, "utf8"),
  readProcInfo = lstat,
  runPs = execFileAsync,
} = {}) {
  return async function readProcessIdentity(pid) {
    if (!isRunning(pid)) return null;
    const identities = {};
    try {
      const record = await readStat(`/proc/${pid}/stat`);
      const commandEnd = record.lastIndexOf(")");
      if (commandEnd >= 0) {
        const fields = record.slice(commandEnd + 2).trim().split(/\s+/);
        if (fields[19]) identities["linux-start"] = fields[19];
      }
    } catch {
      if (!isRunning(pid)) return null;
    }
    try {
      const procInfo = await readProcInfo(`/proc/${pid}`);
      identities["proc-inode"] = `${procInfo.dev}:${procInfo.ino}`;
    } catch {
      if (!isRunning(pid)) return null;
    }
    for (const psCommand of ["/bin/ps", "/usr/bin/ps"]) {
      try {
        const { stdout } = await runPs(
          psCommand,
          ["-o", "lstart=", "-p", String(pid)],
          { encoding: "utf8", timeout: 2_000 },
        );
        const started = stdout.trim();
        if (started) {
          identities["ps-start"] = started;
          break;
        }
      } catch {}
    }
    if (!isRunning(pid)) return null;
    if (Object.keys(identities).length === 0) identities["pid-only"] = String(pid);
    return identities;
  };
}

export const readProcessIdentity = createProcessIdentityReader();

/**
 * Cache an identity only for a short contention window. A live-PID probe is
 * still made on every use, and expiry forces a fresh identity read so PID reuse
 * continues to be detected before reclaiming a lock.
 */
export function createBoundedProcessIdentityLookup({
  readIdentity = readProcessIdentity,
  isRunning = processIsRunning,
  now = Date.now,
  maxAgeMs = 250,
} = {}) {
  const cache = new Map();
  return async function readBoundedProcessIdentity(pid) {
    if (!isRunning(pid)) {
      cache.delete(pid);
      return null;
    }
    const cached = cache.get(pid);
    if (cached && now() - cached.observedAt < maxAgeMs) return cached.identity;
    const identity = await readIdentity(pid);
    if (identity === null) cache.delete(pid);
    else cache.set(pid, { identity, observedAt: now() });
    return identity;
  };
}
