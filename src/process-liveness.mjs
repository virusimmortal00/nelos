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

export async function readProcessIdentity(pid) {
  if (!processIsRunning(pid)) return null;
  const identities = {};
  try {
    const record = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = record.lastIndexOf(")");
    if (commandEnd >= 0) {
      const fields = record.slice(commandEnd + 2).trim().split(/\s+/);
      if (fields[19]) identities["linux-start"] = fields[19];
    }
  } catch {
    if (!processIsRunning(pid)) return null;
  }
  try {
    const procInfo = await lstat(`/proc/${pid}`);
    identities["proc-inode"] = `${procInfo.dev}:${procInfo.ino}`;
  } catch {
    if (!processIsRunning(pid)) return null;
  }
  for (const psCommand of ["/bin/ps", "/usr/bin/ps"]) {
    try {
      const { stdout } = await execFileAsync(
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
  if (!processIsRunning(pid)) return null;
  if (Object.keys(identities).length === 0) identities["pid-only"] = String(pid);
  return identities;
}
