import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  DISTRIBUTION_ENTRIES,
  DISTRIBUTION_NAME,
  INSTALL_STATE_FILENAME,
  MANAGED_CLI_BINS,
  PLUGIN_NAME,
  SOURCE_REPOSITORY,
  PROVENANCE_FILENAME,
  REQUIRED_CLI_COMMANDS,
  compareProvenance,
  computeDistributionIntegrity,
  computeFileIntegrity,
  currentDirectoryPathEntries,
  inspectProvenance,
  listPathCommands,
  readRequiredProvenance,
  safeCommandPath,
  sameStringSet,
  validateProvenance,
  pluginCacheIdentity,
} from "./distribution-provenance.mjs";
import { openAppServerClient } from "./app-server-client.mjs";
import { resolveControlEndpoint } from "./control-endpoint.mjs";
import {
  ensureCanonicalDirectory,
  pathExists,
  pathInfo,
} from "./path-safety.mjs";
import {
  processIdentitiesMatch,
  processIdentitiesProveReplacement,
  processMayOwnLease,
  readProcessIdentity,
} from "./process-liveness.mjs";
import {
  hasOnlyManagedSkillFiles,
  pathFingerprint,
  skillFingerprint,
} from "./skill-installation.mjs";
import {
  applyPersonalMarketplaceMutation,
  inspectPersonalMarketplace,
  parsePersonalMarketplaceText,
  personalMarketplaceDocument,
} from "./personal-marketplace.mjs";

const INSTALL_SCHEMA_VERSION = 1;
const TRANSACTION_FILENAME = "install-transaction.json";
const MARKETPLACE_TRANSACTION_FILENAME = ".nelos-marketplace-transaction.json";
const LOCK_DIRECTORY = ".nelos-install.lock";
const MARKETPLACE_LOCK_DIRECTORY = ".nelos-marketplace.lock";
const SKILL_NAME = "manage-nelos-tasks";
const DEFAULT_PLUGIN_SELECTOR = `${PLUGIN_NAME}@personal`;
const DEFAULT_APP_SERVER_TIMEOUT_MS = 15_000;
const LOCK_HEARTBEAT_INTERVAL_MS = 1_000;
const LOCK_STALE_AFTER_MS = 30_000;
const MAX_MARKETPLACE_BYTES = 1_048_576;
const EXPECTED_BINS = new Map(Object.entries(MANAGED_CLI_BINS));
const LEGACY_HASHES = new Map([
  [
    "nelos",
    new Set(["67daffba89630769986e7b902925dd4d340b4121d5752ecca460b77afd45f8c1"]),
  ],
  [
    "nelos-title",
    new Set(["91b21ef37501c4c3d669e3fcc21e6751648967e28b3e19072563456088cf02c8"]),
  ],
]);
const LEGACY_SKILL_HASHES = new Set([
  "ebded04b802393b00fd58aaf51ed83452760a583160f69b569d2bc7ad7e8105d",
]);

function now() {
  return new Date().toISOString();
}

function directoryIdentity(info) {
  return {
    device: String(info.dev),
    inode: String(info.ino),
  };
}

async function assertDirectoryIdentity(
  path,
  expectedIdentity,
  label,
  { create = false } = {},
) {
  await ensureCanonicalDirectory(path, label, { create });
  const identity = directoryIdentity(await lstat(path));
  if (expectedIdentity &&
      (identity.device !== expectedIdentity.device ||
       identity.inode !== expectedIdentity.inode)) {
    throw new Error(`${label} changed after preflight`);
  }
  return identity;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeJsonAtomically(
  path,
  value,
  mode = 0o600,
  { expectedParentIdentity = null, parentLabel = "transaction directory" } = {},
) {
  const parentPath = dirname(path);
  if (expectedParentIdentity) {
    await assertDirectoryIdentity(
      parentPath,
      expectedParentIdentity,
      parentLabel,
    );
  } else {
    await mkdir(parentPath, { recursive: true, mode: 0o700 });
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (expectedParentIdentity) {
      await assertDirectoryIdentity(
        parentPath,
        expectedParentIdentity,
        parentLabel,
      );
    }
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode,
    });
    if (expectedParentIdentity) {
      await assertDirectoryIdentity(
        parentPath,
        expectedParentIdentity,
        parentLabel,
      );
    }
    await rename(temporary, path);
  } finally {
    if (expectedParentIdentity) {
      await assertDirectoryIdentity(
        parentPath,
        expectedParentIdentity,
        parentLabel,
      );
    }
    await rm(temporary, { force: true });
  }
}

async function writeBytesAtomically(
  path,
  bytes,
  {
    mode = 0o600,
    expectedFingerprint = null,
    expectedMode = null,
    beforeLink = null,
    afterLink = null,
    displacedPath = null,
    temporaryPath = null,
    testInterruption = null,
    expectedParentIdentity = null,
  } = {},
) {
  await assertMarketplacePathSafety(path, { expectedParentIdentity });
  const temporary = temporaryPath ?? `${path}.${process.pid}.${randomUUID()}.tmp`;
  let displaced = null;
  let retainTemporary = false;
  const interruptForTest = (phase) => {
    if (testInterruption !== phase) return;
    retainTemporary = true;
    const error = new Error(
      `injected marketplace interruption after ${phase}`,
    );
    error.marketplaceProcessInterrupted = true;
    error.marketplaceMutationUnresolved = true;
    throw error;
  };
  try {
    await assertMarketplacePathSafety(path, { expectedParentIdentity });
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await chmod(temporary, mode);
    interruptForTest("candidate");
    if (expectedFingerprint === "missing") {
      if (beforeLink) await beforeLink();
      await assertMarketplacePathSafety(path, { expectedParentIdentity });
      try {
        await link(temporary, path);
        interruptForTest("linked");
      } catch (error) {
        if (error.marketplaceProcessInterrupted) {
          retainTemporary = true;
          throw error;
        }
        if (error.code === "EEXIST") {
          throw new Error("marketplace changed before atomic replacement");
        }
        throw error;
      }
      return;
    }
    if (expectedFingerprint === null) {
      throw new Error("marketplace replacement requires an expected fingerprint");
    }
    await assertMarketplacePathSafety(path, { expectedParentIdentity });
    displaced = displacedPath ?? `${path}.${process.pid}.${randomUUID()}.previous`;
    if (await pathInfo(displaced)) {
      throw new Error(`marketplace exchange path already exists: ${displaced}`);
    }
    await assertMarketplacePathSafety(path, { expectedParentIdentity });
    await rename(path, displaced);
    try {
      if ((await marketplaceFileFingerprint(displaced)) !== expectedFingerprint) {
        throw new Error("marketplace changed before atomic replacement");
      }
      if (expectedMode !== null &&
          ((await lstat(displaced)).mode & 0o777) !== expectedMode) {
        throw new Error("marketplace mode changed before atomic replacement");
      }
      interruptForTest("displaced");
      if (beforeLink) await beforeLink();
      await assertMarketplacePathSafety(path, { expectedParentIdentity });
      await link(temporary, path);
      interruptForTest("linked");
      if (afterLink) await afterLink();
      await assertMarketplacePathSafety(path, { expectedParentIdentity });
      await rm(displaced, { force: true });
      displaced = null;
    } catch (cause) {
      if (cause.marketplaceProcessInterrupted) {
        retainTemporary = true;
        throw cause;
      }
      const restored = await restoreDisplacedMarketplace(
        path,
        displaced,
        expectedParentIdentity,
      );
      if (restored) displaced = null;
      if (restored &&
          /marketplace(?: mode)? changed before atomic replacement/.test(
            cause.message,
          )) {
        throw cause;
      }
      const error = new Error("marketplace changed during atomic replacement", {
        cause,
      });
      error.marketplaceMutationUnresolved = !restored;
      throw error;
    }
  } finally {
    if (!retainTemporary) {
      await assertMarketplacePathSafety(path, { expectedParentIdentity });
      await rm(temporary, { force: true });
    }
  }
}

async function restoreDisplacedMarketplace(
  path,
  displaced,
  expectedParentIdentity = null,
) {
  await assertMarketplacePathSafety(path, { expectedParentIdentity });
  if (await pathInfo(path)) return false;
  try {
    await assertMarketplacePathSafety(path, { expectedParentIdentity });
    await link(displaced, path);
    await assertMarketplacePathSafety(path, { expectedParentIdentity });
    await rm(displaced, { force: true });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

async function removeMarketplaceIfFingerprint(
  path,
  expectedFingerprint,
  displacedPath = `${path}.${process.pid}.${randomUUID()}.rollback`,
  expectedMode = null,
  expectedParentIdentity = null,
) {
  await assertMarketplacePathSafety(path, { expectedParentIdentity });
  if (await pathInfo(displacedPath)) {
    throw new Error(`marketplace rollback path already exists: ${displacedPath}`);
  }
  let displaced = displacedPath;
  await assertMarketplacePathSafety(path, { expectedParentIdentity });
  await rename(path, displaced);
  const displacedFingerprint = await marketplaceFileFingerprint(displaced);
  const displacedMode = displacedFingerprint === "foreign"
    ? null
    : (await lstat(displaced)).mode & 0o777;
  if (displacedFingerprint !== expectedFingerprint ||
      (expectedMode !== null && displacedMode !== expectedMode)) {
    const restored = await restoreDisplacedMarketplace(
      path,
      displaced,
      expectedParentIdentity,
    );
    if (restored) displaced = null;
    const error = new Error(
      "marketplace changed before conditional removal",
    );
    error.marketplaceMutationUnresolved = !restored;
    throw error;
  }
  await assertMarketplacePathSafety(path, { expectedParentIdentity });
  await rm(displaced, { force: true });
}

function marketplaceExchangePaths(path, exchangeId) {
  const prefix = `${path}.nelos-exchange-${exchangeId}`;
  return {
    displacedPath: `${prefix}.displaced`,
    candidatePath: `${prefix}.candidate`,
    removalPath: `${prefix}.removal`,
  };
}

async function marketplaceArtifactFingerprints(paths) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        await marketplaceFileFingerprint(path),
      ]),
    ),
  );
}

async function cleanupMarketplaceArtifacts(
  paths,
  allowedFingerprints,
  { marketplacePath = null, expectedParentIdentity = null } = {},
) {
  for (const path of Object.values(paths)) {
    const fingerprint = await marketplaceFileFingerprint(path);
    if (fingerprint === "missing") continue;
    if (!allowedFingerprints.has(fingerprint)) {
      throw new Error(
        `marketplace recovery artifact changed at ${path}; refusing cleanup`,
      );
    }
    if (marketplacePath) {
      await assertMarketplacePathSafety(marketplacePath, {
        expectedParentIdentity,
      });
    }
    await rm(path);
  }
}

async function restoreMarketplaceArtifact(
  path,
  artifactPath,
  expectedFingerprint,
  expectedMode = null,
  expectedParentIdentity = null,
) {
  await assertMarketplacePathSafety(path, { expectedParentIdentity });
  if ((await marketplaceFileFingerprint(path)) !== "missing" ||
      (await marketplaceFileFingerprint(artifactPath)) !== expectedFingerprint ||
      (expectedMode !== null &&
       ((await lstat(artifactPath)).mode & 0o777) !== expectedMode)) {
    throw new Error("marketplace recovery state changed before restoration");
  }
  try {
    await assertMarketplacePathSafety(path, { expectedParentIdentity });
    await link(artifactPath, path);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("marketplace changed before recovery restoration");
    }
    throw error;
  }
  if ((await marketplaceFileFingerprint(path)) !== expectedFingerprint) {
    throw new Error("marketplace recovery restoration verification failed");
  }
  if (expectedMode !== null &&
      ((await lstat(path)).mode & 0o777) !== expectedMode) {
    throw new Error("marketplace recovery mode verification failed");
  }
  await assertMarketplacePathSafety(path, { expectedParentIdentity });
  await rm(artifactPath);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runCommand(command, args, { env = process.env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let leaderClosed = false;
    let killTimer = null;
    const killProcessGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = null;
        killProcessGroup("SIGKILL");
        if (leaderClosed && !settled) {
          settled = true;
          reject(new Error(`${basename(command)} ${args.join(" ")} timed out`));
        }
      }, 250);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      leaderClosed = true;
      clearTimeout(timer);
      if (timedOut && killTimer) return;
      settled = true;
      reject(error);
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      leaderClosed = true;
      clearTimeout(timer);
      if (timedOut) {
        // A detached descendant can outlive the process leader. Keep the
        // scheduled SIGKILL armed and do not let rollback begin until it fires.
        if (!killTimer) {
          settled = true;
          reject(new Error(`${basename(command)} ${args.join(" ")} timed out`));
        }
        return;
      }
      settled = true;
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

async function runChecked(command, args, options) {
  const result = await runCommand(command, args, options);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${basename(command)} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

async function runJsonCommand(command, args, options) {
  const result = await runChecked(command, args, options);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${basename(command)} ${args.join(" ")} returned invalid JSON: ${error.message}`,
    );
  }
}

async function readInitializingLockOwner(lockPath) {
  const retryDelayMs = 25;
  while (true) {
    try {
      return await readJson(join(lockPath, "owner.json"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      const lockInfo = await pathInfo(lockPath);
      if (!lockInfo) return null;
      const ownerInfo = await pathInfo(join(lockPath, "owner.json"));
      const newestMtime = Math.max(
        lockInfo.mtimeMs,
        ownerInfo?.mtimeMs ?? Number.NEGATIVE_INFINITY,
      );
      const remainingLease = LOCK_STALE_AFTER_MS - (Date.now() - newestMtime);
      if (remainingLease <= 0) return null;
      await delay(Math.min(retryDelayMs, remainingLease));
    }
  }
}

async function acquireInstallLock(
  lockRoot,
  {
    lockDirectory = LOCK_DIRECTORY,
    scope = "distribution install",
  } = {},
) {
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(lockRoot, lockDirectory);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        const ownerIdentity = await readProcessIdentity(process.pid);
        const ownerPath = join(lockPath, "owner.json");
        await writeFile(
          ownerPath,
          `${JSON.stringify(
            {
              pid: process.pid,
              token,
              startedAt: now(),
              processIdentity: ownerIdentity,
            },
            null,
            2,
          )}\n`,
          { flag: "wx", mode: 0o600 },
        );
        const heartbeat = setInterval(() => {
          const timestamp = new Date();
          void utimes(ownerPath, timestamp, timestamp).catch(() => {});
        }, LOCK_HEARTBEAT_INTERVAL_MS);
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          const owner = await readJson(ownerPath).catch(() => null);
          if (owner?.token === token) {
            await rm(lockPath, { recursive: true, force: true });
          }
        };
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readInitializingLockOwner(lockPath);
      if (owner === null) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      const activeIdentity = await readProcessIdentity(owner?.pid);
      const ownerInfo = await pathInfo(join(lockPath, "owner.json"));
      const heartbeatFresh =
        ownerInfo !== null &&
        Date.now() - ownerInfo.mtimeMs <= LOCK_STALE_AFTER_MS;
      // A pid-only identity cannot safely distinguish PID reuse from the
      // original owner. In that portability fallback, the heartbeat is a
      // bounded lease; strong matching identities remain authoritative.
      if (
        processMayOwnLease(
          owner.processIdentity,
          activeIdentity,
          heartbeatFresh,
        )
      ) {
        throw new Error(`another ${scope} is active (pid ${owner.pid})`);
      }
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  throw new Error(`failed to acquire the ${scope} lock`);
}

function assertSupportedPlatform() {
  if (process.platform === "win32") {
    throw new Error(
      "nelos-install-distribution currently requires a POSIX platform with symlink support",
    );
  }
}

function sanitizeReleaseSegment(value) {
  return value.replace(/[^A-Za-z0-9._+-]/g, "-");
}

async function copyDistribution(packageRoot, target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of DISTRIBUTION_ENTRIES) {
    await cp(join(packageRoot, entry), join(target, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  await cp(
    join(packageRoot, PROVENANCE_FILENAME),
    join(target, PROVENANCE_FILENAME),
    { errorOnExist: true, force: false },
  );
}

async function assertReleaseVersions(packageRoot, provenance) {
  const packageMetadata = await readJson(join(packageRoot, "package.json"));
  const pluginMetadata = await readJson(
    join(packageRoot, ".codex-plugin", "plugin.json"),
  );
  if (
    packageMetadata.version !== provenance.revision ||
    pluginMetadata.version !== provenance.revision
  ) {
    throw new Error(
      `release versions must match: package=${packageMetadata.version} plugin=${pluginMetadata.version} provenance=${provenance.revision}`,
    );
  }
  const entries = Object.entries(packageMetadata.bin ?? {});
  if (entries.length !== EXPECTED_BINS.size) {
    throw new Error("release package must expose exactly the managed CLI commands");
  }
  for (const [command, packagePath] of EXPECTED_BINS) {
    if (packageMetadata.bin?.[command] !== packagePath) {
      throw new Error(`unexpected package bin mapping for ${command}`);
    }
    const target = resolve(packageRoot, packagePath);
    const targetRelative = relative(packageRoot, target);
    if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
      throw new Error(`package bin target escapes the release: ${packagePath}`);
    }
  }
}

async function verifyExecutableBins(releasePath) {
  for (const [command, packagePath] of EXPECTED_BINS) {
    const target = join(releasePath, packagePath);
    const info = await pathInfo(target);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error(`managed CLI target is not a regular file: ${command} (${target})`);
    }
    try {
      await access(target, constants.X_OK);
    } catch (error) {
      if (["EACCES", "ENOENT", "ENOTDIR"].includes(error.code)) {
        throw new Error(`managed CLI target is not executable: ${command} (${target})`);
      }
      throw error;
    }
  }
}

async function verifyCliSurface(releasePath, env) {
  const cliPath = join(releasePath, "bin", "nelos");
  const result = await runChecked(process.execPath, [cliPath, "--help"], { env });
  for (const command of REQUIRED_CLI_COMMANDS) {
    if (!result.stdout.includes(command)) {
      throw new Error(`candidate CLI help is missing required command: ${command}`);
    }
  }
}

async function verifyPackedPluginStructure(
  pluginPath,
  expected,
  { verifiedIntegrity = null } = {},
) {
  const provenance = await readRequiredProvenance(
    join(pluginPath, PROVENANCE_FILENAME),
  );
  const compared = compareProvenance(
    "cached plugin",
    expected,
    { provenance, installed: provenance.revision, path: pluginPath },
    pluginPath,
  );
  if (!compared.coherent) {
    throw new Error(
      `cached plugin provenance does not match ${expected.revision} ${expected.integrity}`,
    );
  }
  if (expected.integrity) {
    const integrity =
      verifiedIntegrity ?? (await computeDistributionIntegrity(pluginPath));
    if (integrity !== expected.integrity) {
      throw new Error(
        `cached plugin integrity mismatch: expected ${expected.integrity} actual ${integrity}`,
      );
    }
  }
  return provenance;
}

async function resolveCandidateSourceRevision(
  packageRoot,
  baseProvenance,
  env,
  integrity,
) {
  let gitRevision = null;
  try {
    const [result, status, topLevel, canonicalPackageRoot] = await Promise.all([
      runChecked(
        "git",
        ["-C", packageRoot, "rev-parse", "--verify", "HEAD"],
        { env },
      ),
      runChecked(
        "git",
        ["-C", packageRoot, "status", "--porcelain", "--", ...DISTRIBUTION_ENTRIES],
        { env },
      ),
      runChecked(
        "git",
        ["-C", packageRoot, "rev-parse", "--show-toplevel"],
        { env },
      ),
      realpath(packageRoot),
    ]);
    const canonicalTopLevel = await realpath(topLevel.stdout.trim());
    if (canonicalTopLevel !== canonicalPackageRoot) {
      if (/^[a-f0-9]{40}$/.test(baseProvenance.sourceRevision ?? "")) {
        return {
          revision: baseProvenance.sourceRevision,
          type: baseProvenance.sourceRevisionType ?? "git",
        };
      }
      return {
        revision: integrity.slice("sha256:".length, "sha256:".length + 40),
        type: "distribution-sha256",
      };
    }
    const revision = result.stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) {
      throw new Error("Git returned a non-immutable source revision");
    }
    if (status.stdout.trim() !== "") {
      return {
        revision: integrity.slice("sha256:".length, "sha256:".length + 40),
        type: "distribution-sha256",
      };
    }
    gitRevision = revision;
  } catch (error) {
    const revision = baseProvenance.sourceRevision ?? env.GITHUB_SHA;
    if (/^[a-f0-9]{40}$/.test(revision ?? "")) {
      return { revision, type: baseProvenance.sourceRevisionType ?? "git" };
    }
    return {
      revision: integrity.slice("sha256:".length, "sha256:".length + 40),
      type: "distribution-sha256",
    };
  }
  if (baseProvenance.sourceRevision &&
      baseProvenance.sourceRevision !== gitRevision) {
    throw new Error(
      `bundled provenance source revision is stale: expected ${baseProvenance.sourceRevision} actual ${gitRevision}`,
    );
  }
  return { revision: gitRevision, type: "git" };
}

async function cleanupLegacyPluginCaches({
  cacheRoot,
  managedPluginCacheRoot,
  installedPath,
  report,
}) {
  const installed = resolve(installedPath);
  const rootInfo = await pathInfo(managedPluginCacheRoot);
  if (rootInfo) {
    await ensureCanonicalDirectory(
      managedPluginCacheRoot,
      "managed plugin cache root",
      { create: false },
    );
    for (const entry of await readdir(managedPluginCacheRoot, {
      withFileTypes: true,
    })) {
      const candidate = join(managedPluginCacheRoot, entry.name);
      if (resolve(candidate) === installed) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`refusing unsafe legacy plugin cache entry: ${candidate}`);
      }
      await rm(candidate, { recursive: true });
      report(`removed stale Nelos plugin cache ${candidate}`);
    }
  }
  const legacyRoot = join(cacheRoot, PLUGIN_NAME);
  const legacyInfo = await pathInfo(legacyRoot);
  if (legacyInfo) {
    if (!legacyInfo.isDirectory() || legacyInfo.isSymbolicLink()) {
      throw new Error(`refusing unsafe legacy plugin cache root: ${legacyRoot}`);
    }
    await ensureCanonicalDirectory(legacyRoot, "legacy plugin cache root", {
      create: false,
    });
    await rm(legacyRoot, { recursive: true });
    report(`removed legacy Nelos plugin cache root ${legacyRoot}`);
  }
}

export async function stageDistribution({ packageRoot, installRoot, env }) {
  const baseProvenance = await readRequiredProvenance(
    join(packageRoot, PROVENANCE_FILENAME),
  );
  await assertReleaseVersions(packageRoot, baseProvenance);
  const releasesRoot = join(installRoot, "releases");
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  const stagePath = join(releasesRoot, `.stage-${randomUUID()}`);
  try {
    await copyDistribution(packageRoot, stagePath);
    await verifyExecutableBins(stagePath);
    const integrity = await computeDistributionIntegrity(stagePath);
    const source = await resolveCandidateSourceRevision(
      packageRoot,
      baseProvenance,
      env,
      integrity,
    );
    const skillIntegrity = await computeFileIntegrity(
      join(stagePath, "skills", SKILL_NAME, "SKILL.md"),
    );
    if (
      baseProvenance.integrity !== undefined &&
      baseProvenance.integrity !== integrity
    ) {
      throw new Error(
        `bundled provenance integrity is stale: expected ${baseProvenance.integrity} actual ${integrity}`,
      );
    }
    if (
      baseProvenance.skillIntegrity !== undefined &&
      baseProvenance.skillIntegrity !== skillIntegrity
    ) {
      throw new Error(
        `bundled skill integrity is stale: expected ${baseProvenance.skillIntegrity} actual ${skillIntegrity}`,
      );
    }
    if (
      baseProvenance.requiredCliCommands !== undefined &&
      !sameStringSet(
        baseProvenance.requiredCliCommands,
        REQUIRED_CLI_COMMANDS,
      )
    ) {
      throw new Error("bundled provenance declares a stale CLI command surface");
    }
    const provenance = validateProvenance(
      {
        ...baseProvenance,
        sourceRepository: SOURCE_REPOSITORY,
        sourceRevision: source.revision,
        sourceRevisionType: source.type,
        cacheIdentity: pluginCacheIdentity({
          sourceRepository: SOURCE_REPOSITORY,
          version: baseProvenance.revision,
        }),
        integrity,
        skillIntegrity,
        requiredCliCommands: REQUIRED_CLI_COMMANDS,
      },
      stagePath,
    );
    await writeJsonAtomically(join(stagePath, PROVENANCE_FILENAME), provenance, 0o644);
    await verifyCliSurface(stagePath, env);
    // The staged tree was just hashed above; reuse that result while checking
    // the plugin-specific entrypoints and provenance.
    await verifyPackedPluginStructure(stagePath, provenance, {
      verifiedIntegrity: integrity,
    });

    const releaseName = `${sanitizeReleaseSegment(provenance.revision)}-${source.revision.slice(0, 12)}-${integrity.slice(7, 19)}`;
    const releasePath = join(releasesRoot, releaseName);
    if (await pathExists(releasePath)) {
      const installed = await readRequiredProvenance(
        join(releasePath, PROVENANCE_FILENAME),
      );
      const installedIntegrity = await computeDistributionIntegrity(releasePath);
      if (
        installed.integrity !== integrity ||
        installedIntegrity !== integrity
      ) {
        throw new Error(`release collision at ${releasePath}`);
      }
      await verifyExecutableBins(releasePath);
      await rm(stagePath, { recursive: true, force: true });
      return { releasePath, provenance, reused: true };
    }
    await rename(stagePath, releasePath);
    return { releasePath, provenance, reused: false };
  } catch (error) {
    await rm(stagePath, { recursive: true, force: true });
    throw error;
  }
}

async function resolveCodexCommand(explicitPath, pathValue) {
  if (explicitPath) {
    const resolved = await realpath(resolve(explicitPath));
    return resolved;
  }
  const candidate = (await listPathCommands("codex", pathValue))[0];
  if (!candidate) throw new Error("codex is not available on PATH; pass --codex PATH");
  return candidate.realPath;
}

function parsePluginSelector(selector) {
  const separator = selector.lastIndexOf("@");
  if (separator <= 0 || separator === selector.length - 1) {
    throw new Error(`plugin selector must use name@marketplace form: ${selector}`);
  }
  return {
    name: selector.slice(0, separator),
    marketplaceName: selector.slice(separator + 1),
  };
}

async function listPlugins(codexCommand, env) {
  const listing = await runJsonCommand(
    codexCommand,
    ["plugin", "list", "--available", "--json"],
    { env },
  );
  return {
    installed: Array.isArray(listing.installed) ? listing.installed : [],
    available: Array.isArray(listing.available) ? listing.available : [],
  };
}

async function discoverPlugin(codexCommand, selector, env) {
  const expectedIdentity = parsePluginSelector(selector);
  const { installed, available } = await listPlugins(codexCommand, env);
  const installedMatches = installed.filter(
    (entry) => entry.pluginId === selector,
  );
  const availableMatches = available.filter(
    (entry) => entry.pluginId === selector,
  );
  if (installedMatches.length > 1 || availableMatches.length > 1) {
    throw new Error(
      `expected at most one ${selector} entry per plugin-list section, found installed=${installedMatches.length} available=${availableMatches.length}`,
    );
  }
  const previous = installedMatches[0] ?? null;
  const configured = availableMatches[0] ?? null;
  const plugin = previous ?? configured;
  if (!plugin) {
    throw new Error(`configured ${selector} plugin was not found`);
  }
  if (
    previous &&
    configured &&
    (previous.name !== configured.name ||
      previous.marketplaceName !== configured.marketplaceName ||
      previous.source?.source !== configured.source?.source ||
      resolve(previous.source?.path ?? "") !==
        resolve(configured.source?.path ?? ""))
  ) {
    throw new Error(`${selector} has inconsistent installed and available entries`);
  }
  if (previous?.enabled === false) {
    throw new Error(
      `${selector} is installed but disabled; enable it or remove it before running the distribution installer`,
    );
  }
  if (
    plugin.source?.source !== "local" ||
    typeof plugin.source?.path !== "string" ||
    !isAbsolute(plugin.source.path)
  ) {
    throw new Error(`${selector} must come from one absolute local marketplace path`);
  }
  if (
    plugin.name !== expectedIdentity.name ||
    plugin.marketplaceName !== expectedIdentity.marketplaceName
  ) {
    throw new Error(
      `${selector} returned inconsistent plugin identity: ${plugin.name ?? "missing"}@${plugin.marketplaceName ?? "missing"}`,
    );
  }
  return {
    selector,
    name: plugin.name,
    marketplaceName: plugin.marketplaceName,
    sourcePath: resolve(plugin.source.path),
    previouslyInstalled: Boolean(previous),
    previousVersion: previous?.version ?? null,
  };
}

async function assertMarketplacePathSafety(
  marketplacePath,
  { createParent = false, expectedParentIdentity = null } = {},
) {
  const parentPath = dirname(marketplacePath);
  const parentIdentity = await assertDirectoryIdentity(
    parentPath,
    expectedParentIdentity,
    "local marketplace directory",
    { create: createParent },
  );
  const info = await pathInfo(marketplacePath);
  if (!info) return { info: null, parentIdentity };
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`refusing non-regular local marketplace: ${marketplacePath}`);
  }
  if ((await realpath(marketplacePath)) !== resolve(marketplacePath)) {
    throw new Error(
      `local marketplace contains a symlinked path component: ${marketplacePath}`,
    );
  }
  return { info, parentIdentity };
}

function fingerprintBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function ensurePersonalMarketplace({
  marketplacePath,
  pluginIdentity,
  sourcePath,
  home,
}) {
  if (!marketplacePath || pluginIdentity.marketplaceName !== "personal") {
    return {
      path: marketplacePath,
      created: false,
      updated: false,
      changed: false,
      managed: false,
    };
  }
  const expected = personalMarketplaceDocument(pluginIdentity, sourcePath, {
    marketplacePath,
    home,
  });
  const existing = await pathInfo(marketplacePath);
  if (existing) {
    const { info: safeInfo, parentIdentity } =
      await assertMarketplacePathSafety(marketplacePath);
    const bytes = await readFile(marketplacePath);
    if (bytes.length > MAX_MARKETPLACE_BYTES) {
      throw new Error(
        `refusing oversized local marketplace at ${marketplacePath}`,
      );
    }
    let parsed;
    try {
      parsed = parsePersonalMarketplaceText(bytes.toString("utf8"));
    } catch {
      throw new Error(`refusing malformed local marketplace at ${marketplacePath}`);
    }
    const inspection = inspectPersonalMarketplace(parsed.document, {
      pluginIdentity,
      sourcePath,
      marketplacePath,
      home,
    });
    if (inspection.state === "conflict") {
      throw new Error(
        `conflicting local marketplace exists at ${marketplacePath}`,
      );
    }
    if (inspection.state === "compatible") {
      return {
        path: marketplacePath,
        created: false,
        updated: false,
        changed: false,
        managed: true,
        state: inspection.state,
        parentIdentity,
      };
    }
    return {
      path: marketplacePath,
      created: false,
      updated: true,
      changed: true,
      managed: true,
      state: inspection.state,
      bytes: Buffer.from(
        applyPersonalMarketplaceMutation(
          bytes.toString("utf8"),
          inspection.mutation,
        ),
        "utf8",
      ),
      previousBytesBase64: bytes.toString("base64"),
      previousFingerprint: fingerprintBytes(bytes),
      previousMode: safeInfo.mode & 0o777,
      parentIdentity,
    };
  }
  const { parentIdentity } = await assertMarketplacePathSafety(marketplacePath, {
    createParent: true,
  });
  return {
    path: marketplacePath,
    created: true,
    updated: false,
    changed: true,
    managed: true,
    state: "bootstrap-ready",
    document: expected,
    parentIdentity,
  };
}

function marketplaceBytes(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function marketplaceFileFingerprint(path) {
  const info = await pathInfo(path);
  if (!info) return "missing";
  if (!info.isFile() || info.isSymbolicLink()) return "foreign";
  return fingerprintBytes(await readFile(path));
}

async function recoverMarketplaceTransaction(
  transactionPath,
  expectedPath,
  { preserve = false, currentOwnerJournalPath = null } = {},
) {
  const transactionParentIdentity = await assertDirectoryIdentity(
    dirname(transactionPath),
    null,
    "marketplace transaction directory",
    { create: false },
  );
  let transaction;
  try { transaction = await readJson(transactionPath); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const validFingerprint = (value) => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
  if (transaction?.schemaVersion !== 1 ||
      !["create-personal-marketplace", "update-personal-marketplace"].includes(transaction.operation) ||
      resolve(transaction.path ?? "") !== resolve(expectedPath)) {
    throw new Error("invalid marketplace bootstrap transaction");
  }
  const ownerFieldsPresent = transaction.ownerJournalPath !== undefined ||
    transaction.ownerTransactionId !== undefined;
  if (ownerFieldsPresent &&
      (!isAbsolute(transaction.ownerJournalPath ?? "") ||
       typeof transaction.ownerTransactionId !== "string" ||
       transaction.ownerTransactionId.length === 0)) {
    throw new Error("invalid marketplace bootstrap transaction");
  }
  const parentIdentity = transaction.parentIdentity ?? null;
  if (parentIdentity !== null &&
      (typeof parentIdentity !== "object" ||
       Array.isArray(parentIdentity) ||
       !/^\d+$/.test(parentIdentity.device ?? "") ||
       !/^\d+$/.test(parentIdentity.inode ?? ""))) {
    throw new Error("invalid marketplace bootstrap transaction");
  }
  let ownerCommitted = false;
  let foreignOwnerActive = false;
  if (ownerFieldsPresent) {
    try {
      const ownerJournal = await readJson(transaction.ownerJournalPath);
      if (ownerJournal?.id !== transaction.ownerTransactionId) {
        throw new Error(
          "personal marketplace owner evidence does not match its transaction",
        );
      }
      if (ownerJournal?.id === transaction.ownerTransactionId) {
        ownerCommitted = ownerJournal.status === "committed";
        foreignOwnerActive = !ownerCommitted &&
          resolve(transaction.ownerJournalPath) !==
            resolve(currentOwnerJournalPath ?? "");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (foreignOwnerActive) {
    throw new Error(
      `personal marketplace update belongs to an incomplete distribution at ${transaction.ownerJournalPath}`,
    );
  }
  const preserveMarketplace = preserve || ownerCommitted;
  await assertMarketplacePathSafety(expectedPath, {
    expectedParentIdentity: parentIdentity,
  });
  if (!validFingerprint(transaction.expectedFingerprint)) {
    throw new Error("invalid marketplace bootstrap transaction");
  }
  if (transaction.expectedMode !== undefined &&
      (!Number.isInteger(transaction.expectedMode) ||
       transaction.expectedMode < 0 || transaction.expectedMode > 0o777)) {
    throw new Error("invalid marketplace bootstrap transaction");
  }
  let previousBytes = null;
  let previousFingerprint = "missing";
  if (transaction.operation === "update-personal-marketplace") {
    if (!validFingerprint(transaction.previousFingerprint) ||
        typeof transaction.previousBytesBase64 !== "string" ||
        transaction.previousBytesBase64.length > Math.ceil(MAX_MARKETPLACE_BYTES / 3) * 4 + 4 ||
        !Number.isInteger(transaction.previousMode) ||
        transaction.previousMode < 0 || transaction.previousMode > 0o777) {
      throw new Error("invalid marketplace bootstrap transaction");
    }
    previousBytes = Buffer.from(transaction.previousBytesBase64, "base64");
    previousFingerprint = transaction.previousFingerprint;
    if (previousBytes.toString("base64") !== transaction.previousBytesBase64 ||
        fingerprintBytes(previousBytes) !== previousFingerprint) {
      throw new Error("invalid marketplace bootstrap transaction");
    }
  }
  const expectedMode = transaction.expectedMode ??
    (transaction.operation === "update-personal-marketplace"
      ? transaction.previousMode
      : null);

  const actual = await marketplaceFileFingerprint(expectedPath);
  if (transaction.exchangeId === undefined) {
    // Upgrade released transactions before mutation so every displacement path
    // is deterministic and recoverable on the next process after interruption.
    await writeJsonAtomically(
      transactionPath,
      {
        ...transaction,
        exchangeId: randomUUID(),
        ...(expectedMode === null ? {} : { expectedMode }),
      },
      0o600,
      {
        expectedParentIdentity: transactionParentIdentity,
        parentLabel: "marketplace transaction directory",
      },
    );
    return recoverMarketplaceTransaction(transactionPath, expectedPath, {
      preserve,
      currentOwnerJournalPath,
    });
  }

  if (typeof transaction.exchangeId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        transaction.exchangeId,
      )) {
    throw new Error("invalid marketplace bootstrap transaction");
  }
  const exchangePaths = marketplaceExchangePaths(
    expectedPath,
    transaction.exchangeId,
  );
  const artifactFingerprints = await marketplaceArtifactFingerprints(exchangePaths);
  const allowedFingerprints = new Set([transaction.expectedFingerprint]);
  if (previousFingerprint !== "missing") {
    allowedFingerprints.add(previousFingerprint);
  }
  const cleanupArtifacts = () => cleanupMarketplaceArtifacts(
    exchangePaths,
    allowedFingerprints,
    { marketplacePath: expectedPath, expectedParentIdentity: parentIdentity },
  );
  const candidateFingerprint = artifactFingerprints.candidatePath;
  if (candidateFingerprint !== "missing" &&
      !allowedFingerprints.has(candidateFingerprint)) {
    const partialCandidateIsRecoverable =
      candidateFingerprint !== "foreign" &&
      !preserveMarketplace &&
      artifactFingerprints.displacedPath === "missing" &&
      artifactFingerprints.removalPath === "missing" &&
      (previousFingerprint === "missing"
        ? actual === "missing"
        : actual === "missing" ||
          actual === previousFingerprint ||
          actual === transaction.expectedFingerprint);
    if (!partialCandidateIsRecoverable) {
      throw new Error(
        "marketplace candidatePath recovery artifact changed; refusing recovery",
      );
    }
    await assertMarketplacePathSafety(expectedPath, {
      expectedParentIdentity: parentIdentity,
    });
    await rm(exchangePaths.candidatePath);
    artifactFingerprints.candidatePath = "missing";
  }
  for (const [name, fingerprint] of Object.entries(artifactFingerprints)) {
    if (fingerprint !== "missing" && !allowedFingerprints.has(fingerprint)) {
      throw new Error(
        `marketplace ${name} recovery artifact changed; refusing recovery`,
      );
    }
  }
  const actualMode = actual === "missing" || actual === "foreign"
    ? null
    : (await lstat(expectedPath)).mode & 0o777;
  if ((actual === transaction.expectedFingerprint &&
       expectedMode !== null && actualMode !== expectedMode) ||
      (actual === previousFingerprint && previousFingerprint !== "missing" &&
       preserveMarketplace &&
       actualMode !== transaction.previousMode)) {
    throw new Error("marketplace mode changed after transaction intent");
  }
  const artifactFor = (fingerprint) => Object.entries(artifactFingerprints)
    .find(([, actualFingerprint]) => actualFingerprint === fingerprint)?.[0];
  const artifactPathFor = (fingerprint) => {
    const name = artifactFor(fingerprint);
    return name ? exchangePaths[name] : null;
  };
  const clearRemovalArtifact = async (protectedPath = null) => {
    if (exchangePaths.removalPath === protectedPath) return;
    const fingerprint = await marketplaceFileFingerprint(exchangePaths.removalPath);
    if (fingerprint === "missing") return;
    if (!allowedFingerprints.has(fingerprint)) {
      throw new Error("marketplace removal artifact changed; refusing recovery");
    }
    await assertMarketplacePathSafety(expectedPath, {
      expectedParentIdentity: parentIdentity,
    });
    await rm(exchangePaths.removalPath);
  };

  if (preserveMarketplace) {
    if (actual === transaction.expectedFingerprint) {
      await cleanupArtifacts();
    } else if (actual === "missing") {
      const sourcePath = artifactPathFor(transaction.expectedFingerprint);
      if (!sourcePath) {
        throw new Error("committed marketplace update is missing; refusing recovery");
      }
      await restoreMarketplaceArtifact(
        expectedPath,
        sourcePath,
        transaction.expectedFingerprint,
        expectedMode,
        parentIdentity,
      );
      await cleanupArtifacts();
    } else if (previousFingerprint !== "missing" &&
               actual === previousFingerprint) {
      const sourcePath = artifactPathFor(transaction.expectedFingerprint);
      if (!sourcePath) {
        throw new Error("committed marketplace update is missing; refusing recovery");
      }
      await clearRemovalArtifact(sourcePath);
      await removeMarketplaceIfFingerprint(
        expectedPath,
        previousFingerprint,
        exchangePaths.removalPath,
        transaction.previousMode,
        parentIdentity,
      );
      await restoreMarketplaceArtifact(
        expectedPath,
        sourcePath,
        transaction.expectedFingerprint,
        expectedMode,
        parentIdentity,
      );
      await cleanupArtifacts();
    } else {
      throw new Error("marketplace changed after committed intent; refusing recovery replacement");
    }
  } else if (previousFingerprint === "missing") {
    if (actual === transaction.expectedFingerprint) {
      await clearRemovalArtifact();
      await removeMarketplaceIfFingerprint(
        expectedPath,
        transaction.expectedFingerprint,
        exchangePaths.removalPath,
        expectedMode,
        parentIdentity,
      );
      await cleanupArtifacts();
    } else if (actual === "missing") {
      await cleanupArtifacts();
    } else {
      throw new Error("marketplace changed after bootstrap intent; refusing recovery deletion");
    }
  } else if (actual === previousFingerprint) {
    await cleanupArtifacts();
  } else if (actual === "missing") {
    const sourceName = artifactFor(previousFingerprint);
    const sourcePath = sourceName ? exchangePaths[sourceName] : null;
    if (sourcePath) {
      await restoreMarketplaceArtifact(
        expectedPath,
        sourcePath,
        previousFingerprint,
        sourceName === "displacedPath" ? null : transaction.previousMode,
        parentIdentity,
      );
      await cleanupArtifacts();
    } else {
      await cleanupArtifacts();
      await writeBytesAtomically(expectedPath, previousBytes, {
        mode: transaction.previousMode,
        expectedFingerprint: "missing",
        temporaryPath: exchangePaths.candidatePath,
        expectedParentIdentity: parentIdentity,
      });
      if ((await marketplaceFileFingerprint(expectedPath)) !== previousFingerprint) {
        throw new Error("marketplace rollback verification failed");
      }
    }
  } else if (actual === transaction.expectedFingerprint) {
    const sourcePath = artifactPathFor(previousFingerprint);
    if (sourcePath) {
      await clearRemovalArtifact(sourcePath);
      await removeMarketplaceIfFingerprint(
        expectedPath,
        transaction.expectedFingerprint,
        exchangePaths.removalPath,
        expectedMode,
        parentIdentity,
      );
      await restoreMarketplaceArtifact(
        expectedPath,
        sourcePath,
        previousFingerprint,
        transaction.previousMode,
        parentIdentity,
      );
      await cleanupArtifacts();
    } else {
      await cleanupArtifacts();
      await writeBytesAtomically(expectedPath, previousBytes, {
        mode: transaction.previousMode,
        expectedFingerprint: transaction.expectedFingerprint,
        expectedMode,
        displacedPath: exchangePaths.displacedPath,
        temporaryPath: exchangePaths.candidatePath,
        expectedParentIdentity: parentIdentity,
      });
    }
    if ((await marketplaceFileFingerprint(expectedPath)) !== previousFingerprint) {
      throw new Error("marketplace rollback verification failed");
    }
  } else {
    throw new Error("marketplace changed after update intent; refusing recovery replacement");
  }
  await assertDirectoryIdentity(
    dirname(transactionPath),
    transactionParentIdentity,
    "marketplace transaction directory",
  );
  await rm(transactionPath, { force: true });
}

async function activateMarketplaceBootstrap(
  bootstrap,
  transactionPath,
  {
    ownerJournalPath = null,
    ownerTransactionId = null,
    beforeReplaceLink = null,
    afterReplaceLink = null,
    testInterruption = null,
  } = {},
) {
  if (!bootstrap.changed) return bootstrap;
  await assertMarketplacePathSafety(bootstrap.path, {
    expectedParentIdentity: bootstrap.parentIdentity,
  });
  const transactionParentIdentity = await assertDirectoryIdentity(
    dirname(transactionPath),
    null,
    "marketplace transaction directory",
    { create: false },
  );
  const bytes = bootstrap.bytes ?? Buffer.from(marketplaceBytes(bootstrap.document));
  const expectedFingerprint = fingerprintBytes(bytes);
  const expectedMode = bootstrap.created ? 0o600 : bootstrap.previousMode;
  const exchangeId = randomUUID();
  const exchangePaths = marketplaceExchangePaths(bootstrap.path, exchangeId);
  const transaction = {
    schemaVersion: 1,
    operation: bootstrap.created
      ? "create-personal-marketplace"
      : "update-personal-marketplace",
    path: bootstrap.path,
    expectedFingerprint,
    expectedMode,
    exchangeId,
    parentIdentity: bootstrap.parentIdentity,
  };
  if (ownerJournalPath !== null || ownerTransactionId !== null) {
    Object.assign(transaction, { ownerJournalPath, ownerTransactionId });
  }
  if (bootstrap.updated) {
    Object.assign(transaction, {
      previousFingerprint: bootstrap.previousFingerprint,
      previousBytesBase64: bootstrap.previousBytesBase64,
      previousMode: bootstrap.previousMode,
    });
  }
  await writeJsonAtomically(transactionPath, transaction, 0o600, {
    expectedParentIdentity: transactionParentIdentity,
    parentLabel: "marketplace transaction directory",
  });
  let mutated = false;
  try {
    if (bootstrap.created) {
      await writeBytesAtomically(bootstrap.path, bytes, {
        mode: 0o600,
        expectedFingerprint: "missing",
        beforeLink: beforeReplaceLink,
        afterLink: afterReplaceLink,
        temporaryPath: exchangePaths.candidatePath,
        testInterruption,
        expectedParentIdentity: bootstrap.parentIdentity,
      });
    } else {
      await assertMarketplacePathSafety(bootstrap.path, {
        expectedParentIdentity: bootstrap.parentIdentity,
      });
      await writeBytesAtomically(bootstrap.path, bytes, {
        mode: bootstrap.previousMode,
        expectedFingerprint: bootstrap.previousFingerprint,
        expectedMode: bootstrap.previousMode,
        beforeLink: beforeReplaceLink,
        afterLink: afterReplaceLink,
        displacedPath: exchangePaths.displacedPath,
        temporaryPath: exchangePaths.candidatePath,
        testInterruption,
        expectedParentIdentity: bootstrap.parentIdentity,
      });
    }
    mutated = true;
  } catch (error) {
    if (!mutated && !error.marketplaceMutationUnresolved) {
      try {
        await assertDirectoryIdentity(
          dirname(transactionPath),
          transactionParentIdentity,
          "marketplace transaction directory",
        );
        await rm(transactionPath, { force: true });
      } catch {
        error.marketplaceMutationUnresolved = true;
      }
    }
    throw error;
  }
  if ((await marketplaceFileFingerprint(bootstrap.path)) !== expectedFingerprint ||
      ((await lstat(bootstrap.path)).mode & 0o777) !== expectedMode) {
    throw new Error("marketplace activation verification failed");
  }
  return {
    path: bootstrap.path,
    created: bootstrap.created,
    updated: bootstrap.updated,
    changed: true,
    managed: true,
    state: "compatible",
    expectedFingerprint,
    parentIdentity: bootstrap.parentIdentity,
  };
}

async function assertPluginActive(codexCommand, selector, revision, env) {
  const { installed } = await listPlugins(codexCommand, env);
  const matches = installed.filter((entry) => entry.pluginId === selector);
  if (matches.length !== 1) {
    throw new Error(`installed plugin state does not contain exactly one ${selector}`);
  }
  const active = matches[0];
  if (active.enabled === false || active.version !== revision) {
    throw new Error(
      `installed plugin state is not active at ${revision}: version=${active.version ?? "missing"} enabled=${active.enabled ?? "unknown"}`,
    );
  }
  return active;
}

async function verifyPluginInstallation({
  installedPath,
  provenance,
  codexCommand,
  selector,
  env,
}) {
  await verifyPackedPluginStructure(installedPath, provenance);
  await assertPluginActive(
    codexCommand,
    selector,
    provenance.revision,
    env,
  );
}

function resolveAppServerActivationContext({
  options,
  env,
  home,
  codexHome,
  pluginIdentity,
}) {
  const timeoutMs = Number(
    options.appServerTimeoutMs ?? DEFAULT_APP_SERVER_TIMEOUT_MS,
  );
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("app-server activation timeout must be a positive integer");
  }
  const discoveredControlEndpoint = resolveControlEndpoint({
    socketPath: options.appServerSocket,
    env,
    codexHome,
  });
  const socketPath = resolve(discoveredControlEndpoint.endpoint.path);
  const controlEndpoint = {
    ...discoveredControlEndpoint,
    endpoint: { ...discoveredControlEndpoint.endpoint, path: socketPath },
  };
  let marketplacePath = options.marketplacePath
    ? resolve(options.marketplacePath)
    : null;
  if (!marketplacePath && pluginIdentity.marketplaceName === "personal") {
    marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
  }
  return {
    controlEndpoint,
    socketPath,
    marketplacePath,
    pluginName: pluginIdentity.name,
    pluginSelector: `${pluginIdentity.name}@${pluginIdentity.marketplaceName}`,
    timeoutMs,
  };
}

async function inspectAppServerActivationPaths(context) {
  const socketInfo = await pathInfo(context.socketPath);
  if (!socketInfo) {
    return {
      available: false,
      reason: `no running Codex app-server socket at ${context.socketPath}`,
    };
  }
  await ensureCanonicalDirectory(
    dirname(context.socketPath),
    "app-server socket directory",
    { create: false },
  );
  if (socketInfo.isSymbolicLink() || !socketInfo.isSocket()) {
    throw new Error(
      `app-server control socket must be a real Unix socket: ${context.socketPath}`,
    );
  }
  if (!context.marketplacePath) {
    return {
      available: false,
      reason: "a local marketplace path is required for live plugin activation",
    };
  }
  const marketplaceInfo = await pathInfo(context.marketplacePath);
  if (!marketplaceInfo) {
    return {
      available: false,
      reason: `local marketplace is missing at ${context.marketplacePath}`,
    };
  }
  await ensureCanonicalDirectory(
    dirname(context.marketplacePath),
    "local marketplace directory",
    { create: false },
  );
  if (marketplaceInfo.isSymbolicLink() || !marketplaceInfo.isFile()) {
    throw new Error(
      `local marketplace must be a real file: ${context.marketplacePath}`,
    );
  }
  const canonicalMarketplace = await realpath(context.marketplacePath);
  if (canonicalMarketplace !== resolve(context.marketplacePath)) {
    throw new Error(
      `local marketplace contains a symlinked path component: ${context.marketplacePath}`,
    );
  }
  return { available: true };
}

function assertAppServerPluginRead(
  response,
  context,
  { revision = null, installed = null } = {},
) {
  const summary = response?.plugin?.summary;
  if (
    summary?.id !== context.pluginSelector ||
    summary?.name !== context.pluginName ||
    summary?.source?.type !== "local" ||
    !isAbsolute(summary?.source?.path ?? "") ||
    resolve(summary.source.path) !== resolve(context.sourcePath)
  ) {
    throw new Error(
      `app-server resolved an unexpected ${context.pluginSelector} marketplace entry`,
    );
  }
  if (installed === true && (summary.installed !== true || summary.enabled !== true)) {
    throw new Error(
      `app-server did not report ${context.pluginSelector} installed and enabled`,
    );
  }
  if (revision !== null && summary.localVersion !== revision) {
    throw new Error(
      `app-server plugin version mismatch: expected ${revision} actual ${summary.localVersion ?? "missing"}`,
    );
  }
  return summary;
}

function deferredLiveActivation(context, reason, report) {
  report(`plugin installed on disk; restart Codex before starting a fresh task (${reason})`);
  return {
    status: "restart-required",
    registryVerified: false,
    freshTaskSmokeTestRequired: true,
    socketPath: context.socketPath,
    marketplacePath: context.marketplacePath,
    reason,
  };
}

async function activateRunningAppServer({
  context,
  revision,
  report,
}) {
  let pathState;
  try {
    pathState = await inspectAppServerActivationPaths(context);
  } catch (error) {
    return deferredLiveActivation(
      context,
      `app-server activation paths were rejected: ${error.message}`,
      report,
    );
  }
  if (!pathState.available) {
    return deferredLiveActivation(context, pathState.reason, report);
  }

  let client;
  try {
    client = await openAppServerClient({
      clientName: "nelos-installer",
      clientTitle: "Nelos Installer",
      resolvedControlEndpoint: context.controlEndpoint,
      timeoutMs: context.timeoutMs,
    });
  } catch (error) {
    return deferredLiveActivation(
      context,
      `could not connect to the running app-server: ${error.message}`,
      report,
    );
  }

  try {
    const params = {
      pluginName: context.pluginName,
      marketplacePath: context.marketplacePath,
    };
    try {
      const before = await client.request("plugin/read", params);
      assertAppServerPluginRead(before, context);
    } catch (error) {
      return deferredLiveActivation(
        context,
        `running app-server does not expose the expected local plugin: ${error.message}`,
        report,
      );
    }
    try {
      await client.request("plugin/install", params);
      const after = await client.request("plugin/read", params);
      assertAppServerPluginRead(after, context, {
        revision,
        installed: true,
      });
      report(
        `refreshed ${context.pluginSelector} metadata in the running Codex app-server`,
      );
      return {
        status: "registry-refreshed",
        registryVerified: true,
        freshTaskSmokeTestRequired: true,
        socketPath: context.socketPath,
        marketplacePath: context.marketplacePath,
      };
    } catch (error) {
      return deferredLiveActivation(
        context,
        `running app-server refresh failed: ${error.message}`,
        report,
      );
    }
  } finally {
    client.close();
  }
}

async function readInstallState(installRoot) {
  try {
    return await readJson(join(installRoot, INSTALL_STATE_FILENAME));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function treeFingerprint(root) {
  const rootInfo = await pathInfo(root);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    return createHash("sha256")
      .update(await pathFingerprint(root))
      .digest("hex");
  }
  const hash = createHash("sha256");
  const visit = async (directory, directoryRelative = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort(({ name: left }, { name: right }) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const entry of entries) {
      const entryRelative = directoryRelative
        ? join(directoryRelative, entry.name)
        : entry.name;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      hash.update(`\0${entryRelative}\0${info.mode}\0`);
      if (info.isSymbolicLink()) {
        hash.update(`symlink:${await readlink(path)}`);
      } else if (info.isDirectory()) {
        hash.update("directory");
        await visit(path, entryRelative);
      } else if (info.isFile()) {
        hash.update("file\0");
        hash.update(await readFile(path));
      } else {
        hash.update(`other:${info.dev}:${info.ino}:${info.ctimeMs}`);
      }
    }
  };
  hash.update(`root:${rootInfo.mode}:${rootInfo.dev}:${rootInfo.ino}`);
  await visit(root);
  return hash.digest("hex");
}

async function updateJournal(journalPath, journal, patch = {}) {
  Object.assign(journal, patch, { updatedAt: now() });
  await writeJsonAtomically(journalPath, journal);
}

function maybeInjectTestFailure(name, testFailpoint) {
  if (testFailpoint === name) {
    throw new Error(`injected install failure at ${name}`);
  }
}

async function stagePluginSource(
  sourcePath,
  releasePath,
  transactionId,
  { rejectGitCheckout = false } = {},
) {
  const sourceInfo = await pathInfo(sourcePath);
  const sourceFingerprint = await treeFingerprint(sourcePath);
  if (sourceInfo?.isSymbolicLink()) {
    throw new Error(`refusing symlinked plugin marketplace source: ${sourcePath}`);
  }
  if (sourceInfo && !sourceInfo.isDirectory()) {
    throw new Error(`plugin marketplace source is not a directory: ${sourcePath}`);
  }
  if (rejectGitCheckout && (await pathExists(join(sourcePath, ".git")))) {
    throw new Error(
      `refusing to replace Git checkout plugin source ${sourcePath}; pass --plugin-source ${sourcePath} to opt in explicitly`,
    );
  }
  if (sourceInfo) {
    const manifest = await readJson(join(sourcePath, ".codex-plugin", "plugin.json"));
    if (manifest.name !== PLUGIN_NAME) {
      throw new Error(`marketplace source at ${sourcePath} is not ${PLUGIN_NAME}`);
    }
  }
  if ((await treeFingerprint(sourcePath)) !== sourceFingerprint) {
    throw new Error(`plugin source changed during preflight: ${sourcePath}`);
  }
  const stagePath = `${sourcePath}.nelos-stage-${transactionId}`;
  await rm(stagePath, { recursive: true, force: true });
  try {
    await cp(releasePath, stagePath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (error) {
    await rm(stagePath, { recursive: true, force: true });
    throw error;
  }
  return { sourcePath, stagePath, sourceInfo, sourceFingerprint };
}

async function activatePluginSource(staged, journal, journalPath) {
  const backupPath = `${staged.sourcePath}.nelos-backup-${journal.id}`;
  journal.plugin.sourcePath = staged.sourcePath;
  journal.plugin.sourceStagePath = staged.stagePath;
  journal.plugin.sourceBackupPath = backupPath;
  journal.plugin.sourceExisted = Boolean(staged.sourceInfo);
  journal.plugin.sourceFingerprint = staged.sourceFingerprint;
  await updateJournal(journalPath, journal);
  const currentFingerprint = await treeFingerprint(staged.sourcePath);
  if (currentFingerprint !== staged.sourceFingerprint) {
    throw new Error(`plugin source changed after preflight: ${staged.sourcePath}`);
  }
  if (staged.sourceInfo) await rename(staged.sourcePath, backupPath);
  await rename(staged.stagePath, staged.sourcePath);
  journal.plugin.sourceActivated = true;
  await updateJournal(journalPath, journal);
}

async function skillIsManaged(skillPath) {
  if (!(await hasOnlyManagedSkillFiles(skillPath))) return false;
  const provenancePath = join(skillPath, PROVENANCE_FILENAME);
  const provenanceInfo = await pathInfo(provenancePath);
  if (!provenanceInfo?.isFile() || provenanceInfo.isSymbolicLink()) return false;
  const provenance = await inspectProvenance(provenancePath);
  const file = join(skillPath, "SKILL.md");
  const fileInfo = await pathInfo(file);
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) return false;
  const hash = await sha256File(file);
  if (
    provenance.provenance?.distribution === DISTRIBUTION_NAME &&
    provenance.provenance.skillIntegrity === `sha256:${hash}`
  ) {
    return true;
  }
  return LEGACY_SKILL_HASHES.has(hash);
}

async function replaceSkill({ releasePath, skillPath, force, journal, journalPath }) {
  const existing = await pathInfo(skillPath);
  const existingFingerprint = await skillFingerprint(skillPath);
  if (existing?.isSymbolicLink()) {
    throw new Error(`refusing symlinked skill directory: ${skillPath}`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`skill destination is not a directory: ${skillPath}`);
  }
  if (existing && !force && !(await skillIsManaged(skillPath))) {
    throw new Error(`foreign skill exists at ${skillPath}; rerun with --force`);
  }
  if ((await skillFingerprint(skillPath)) !== existingFingerprint) {
    throw new Error(`skill changed during preflight: ${skillPath}`);
  }

  const stagePath = `${skillPath}.nelos-stage-${journal.id}`;
  const backupPath = `${skillPath}.nelos-backup-${journal.id}`;
  await rm(stagePath, { recursive: true, force: true });
  try {
    await mkdir(stagePath, { recursive: true, mode: 0o700 });
    await cp(
      join(releasePath, "skills", SKILL_NAME, "SKILL.md"),
      join(stagePath, "SKILL.md"),
    );
    await cp(
      join(releasePath, PROVENANCE_FILENAME),
      join(stagePath, PROVENANCE_FILENAME),
    );
  } catch (error) {
    await rm(stagePath, { recursive: true, force: true });
    throw error;
  }
  journal.skill = {
    path: skillPath,
    stagePath,
    backupPath,
    existed: Boolean(existing),
    activated: false,
  };
  await updateJournal(journalPath, journal);
  if ((await skillFingerprint(skillPath)) !== existingFingerprint) {
    throw new Error(`skill changed after preflight: ${skillPath}`);
  }
  if (existing) await rename(skillPath, backupPath);
  await rename(stagePath, skillPath);
  journal.skill.activated = true;
  await updateJournal(journalPath, journal);
}

async function launcherIsManaged(path, command, installRoot) {
  const info = await pathInfo(path);
  if (!info) return true;
  if (info.isSymbolicLink()) {
    const target = await realpath(path).catch(() => null);
    return Boolean(target && !relative(installRoot, target).startsWith(".."));
  }
  if (!info.isFile()) return false;
  if (LEGACY_HASHES.get(command)?.has(await sha256File(path))) return true;
  const packagePath = EXPECTED_BINS.get(command);
  const managedPath = packagePath
    ? join(installRoot, "current", packagePath)
    : null;
  if (managedPath && (await pathExists(managedPath))) {
    return (await sha256File(path)) === (await sha256File(managedPath));
  }
  return false;
}

async function launcherFingerprint(path) {
  const info = await pathInfo(path);
  if (!info) return "missing";
  if (info.isSymbolicLink()) return `symlink:${await readlink(path)}`;
  if (info.isFile()) return `file:${await sha256File(path)}`;
  return `other:${info.mode}`;
}

async function preflightPath({ binDir, pathValue, installRoot, force }) {
  const pathDirectories = pathValue
    .split(delimiter)
    .map((entry) => resolve(entry || "."));
  const targetDirectoryIndex = pathDirectories.indexOf(resolve(binDir));
  if (targetDirectoryIndex === -1) {
    throw new Error(`${binDir} is not on PATH`);
  }
  const launcherFingerprints = new Map();
  const checks = await Promise.all(
    [...EXPECTED_BINS.keys()].map(async (command) => {
      const path = join(binDir, command);
      const [candidates, fingerprint, managed] = await Promise.all([
        listPathCommands(command, pathValue),
        launcherFingerprint(path),
        force
          ? Promise.resolve(true)
          : launcherIsManaged(path, command, installRoot),
      ]);
      return { command, path, candidates, fingerprint, managed };
    }),
  );
  for (const { command, path, candidates, fingerprint, managed } of checks) {
    const active = candidates[0] ?? null;
    if (active && dirname(active.path) !== resolve(binDir)) {
      const activeIndex = pathDirectories.indexOf(dirname(active.path));
      if (activeIndex !== -1 && activeIndex < targetDirectoryIndex) {
        throw new Error(
          `PATH shadow ${active.path} precedes managed bin directory ${binDir}`,
        );
      }
    }
    launcherFingerprints.set(command, fingerprint);
    if (!managed) {
      throw new Error(`foreign executable exists at ${path}; rerun with --force`);
    }
  }
  return { launcherFingerprints };
}

async function swapCurrent({ installRoot, releasePath, journal, journalPath }) {
  const currentPath = join(installRoot, "current");
  const info = await pathInfo(currentPath);
  if (info && !info.isSymbolicLink()) {
    throw new Error(`refusing non-symlinked current release path: ${currentPath}`);
  }
  const previousTarget = info ? await readlink(currentPath) : null;
  journal.current = { path: currentPath, previousTarget, activated: false };
  await updateJournal(journalPath, journal);
  const temporary = `${currentPath}.${journal.id}.tmp`;
  await rm(temporary, { force: true });
  try {
    await symlink(relative(dirname(currentPath), releasePath), temporary);
    await rename(temporary, currentPath);
  } finally {
    await rm(temporary, { force: true });
  }
  journal.current.activated = true;
  await updateJournal(journalPath, journal);
}

async function replaceLaunchers({
  installRoot,
  binDir,
  launcherFingerprints,
  journal,
  journalPath,
}) {
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  await ensureCanonicalDirectory(binDir, "managed bin directory");
  for (const [command, packagePath] of EXPECTED_BINS) {
    const destination = join(binDir, command);
    const target = join(installRoot, "current", packagePath);
    if (
      launcherFingerprints.get(command) !==
      (await launcherFingerprint(destination))
    ) {
      throw new Error(`launcher changed after preflight: ${destination}`);
    }
    const existing = await pathInfo(destination);
    // preflightPath validated every destination under the same install lock,
    // before current was advanced to the candidate release.
    if (existing?.isSymbolicLink()) {
      const currentTarget = resolve(dirname(destination), await readlink(destination));
      if (currentTarget === target) continue;
    }
    const backupPath = `${destination}.nelos-backup-${journal.id}`;
    const record = {
      path: destination,
      backupPath,
      existed: Boolean(existing),
      activated: false,
    };
    journal.launchers.push(record);
    await updateJournal(journalPath, journal);
    await ensureCanonicalDirectory(binDir, "managed bin directory");
    if (existing) {
      await rename(destination, backupPath);
      await ensureCanonicalDirectory(binDir, "managed bin directory");
    }
    const temporary = `${destination}.${journal.id}.tmp`;
    await ensureCanonicalDirectory(binDir, "managed bin directory");
    await rm(temporary, { force: true });
    try {
      await ensureCanonicalDirectory(binDir, "managed bin directory");
      await symlink(target, temporary);
      await ensureCanonicalDirectory(binDir, "managed bin directory");
      await rename(temporary, destination);
    } finally {
      await ensureCanonicalDirectory(binDir, "managed bin directory");
      await rm(temporary, { force: true });
    }
    record.activated = true;
    await updateJournal(journalPath, journal);
  }
}

async function restorePath(path, backupPath, existed) {
  if (await pathExists(backupPath)) {
    await rm(path, { recursive: true, force: true });
    await rename(backupPath, path);
  } else if (!existed) {
    await rm(path, { recursive: true, force: true });
  }
}

async function restoreCurrent(current) {
  if (!current) return;
  await rm(current.path, { force: true });
  if (current.previousTarget !== null) {
    await symlink(current.previousTarget, current.path);
  }
}

async function rollbackTransaction(journal, { env, report = () => {} }) {
  const errors = [];
  const attempt = async (label, callback) => {
    try {
      await callback();
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
  };

  for (const launcher of [...(journal.launchers ?? [])].reverse()) {
    await attempt(`restore ${launcher.path}`, async () => {
      await ensureCanonicalDirectory(
        dirname(launcher.path),
        "managed bin directory",
      );
      await restorePath(launcher.path, launcher.backupPath, launcher.existed);
    });
  }
  await attempt("restore current release", () => restoreCurrent(journal.current));
  if (journal.skill) {
    await attempt("restore skill", () =>
      restorePath(
        journal.skill.path,
        journal.skill.backupPath,
        journal.skill.existed,
      ),
    );
    await attempt("remove staged skill", () =>
      rm(journal.skill.stagePath, { recursive: true, force: true }),
    );
  }
  if (journal.plugin?.sourcePath) {
    await attempt("restore plugin source", async () => {
      if (
        (await pathExists(journal.plugin.sourceBackupPath)) &&
        (await treeFingerprint(journal.plugin.sourceBackupPath)) !==
          journal.plugin.sourceFingerprint
      ) {
        throw new Error("plugin source backup changed during the transaction");
      }
      await restorePath(
        journal.plugin.sourcePath,
        journal.plugin.sourceBackupPath,
        journal.plugin.sourceExisted,
      );
    });
    await attempt("remove staged plugin source", () =>
      rm(journal.plugin.sourceStagePath, { recursive: true, force: true }),
    );
    if (journal.plugin.previouslyInstalled) {
      await attempt("restore cached plugin", async () => {
        await runChecked(
          journal.codexCommand,
          ["plugin", "add", journal.plugin.selector, "--json"],
          { env },
        );
      });
    } else if (journal.plugin.installAttempted) {
      await attempt("remove newly installed plugin", async () => {
        const { installed } = await listPlugins(journal.codexCommand, env);
        if (installed.some((entry) => entry.pluginId === journal.plugin.selector)) {
          await runChecked(
            journal.codexCommand,
            ["plugin", "remove", journal.plugin.selector, "--json"],
            { env },
          );
        }
      });
    }
  }
  if (journal.previousState === null) {
    await rm(journal.statePath, { force: true });
  } else if (journal.previousState) {
    await attempt("restore install state", () =>
      writeJsonAtomically(journal.statePath, journal.previousState),
    );
  }
  if (errors.length > 0) {
    report(`rollback incomplete: ${errors.join("; ")}`);
    throw new Error(`distribution rollback failed: ${errors.join("; ")}`);
  }
}

async function cleanupTransaction(journal) {
  for (const launcher of journal.launchers ?? []) {
    await ensureCanonicalDirectory(
      dirname(launcher.path),
      "managed bin directory",
    );
    await rm(launcher.backupPath, { recursive: true, force: true });
  }
  if (journal.skill) {
    await rm(journal.skill.backupPath, { recursive: true, force: true });
    await rm(journal.skill.stagePath, { recursive: true, force: true });
  }
  if (journal.plugin?.sourceBackupPath) {
    await rm(journal.plugin.sourceBackupPath, { recursive: true, force: true });
  }
  if (journal.plugin?.sourceStagePath) {
    await rm(journal.plugin.sourceStagePath, { recursive: true, force: true });
  }
}

function assertJournalPath(actual, expected, label) {
  if (typeof actual !== "string" || resolve(actual) !== resolve(expected)) {
    throw new Error(`unsafe transaction journal ${label}: ${actual ?? "missing"}`);
  }
}

function validateJournal(journal, expected) {
  if (
    journal?.schemaVersion !== INSTALL_SCHEMA_VERSION ||
    !/^[A-Za-z0-9-]+$/.test(journal?.id ?? "") ||
    !["active", "committed"].includes(journal?.status)
  ) {
    throw new Error("invalid distribution transaction journal");
  }
  if (!isAbsolute(journal.codexCommand ?? "")) {
    throw new Error("unsafe transaction journal Codex command");
  }
  // Recovery must use the currently resolved trusted Codex executable. The
  // absolute path recorded before a crash may legitimately change on upgrade.
  journal.codexCommand = expected.codexCommand;
  assertJournalPath(
    journal.statePath,
    join(expected.installRoot, INSTALL_STATE_FILENAME),
    "install state",
  );
  if (journal.candidateReleasePath) {
    const candidateRelative = relative(
      join(expected.installRoot, "releases"),
      resolve(journal.candidateReleasePath),
    );
    if (candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) {
      throw new Error("unsafe transaction journal candidate release");
    }
  }
  if (journal.plugin?.selector !== expected.pluginSelector) {
    throw new Error("unsafe transaction journal plugin selector");
  }
  if (journal.plugin?.sourcePath) {
    assertJournalPath(
      journal.plugin.sourcePath,
      expected.pluginSource,
      "plugin source",
    );
    assertJournalPath(
      journal.plugin.sourceBackupPath,
      `${expected.pluginSource}.nelos-backup-${journal.id}`,
      "plugin source backup",
    );
    assertJournalPath(
      journal.plugin.sourceStagePath,
      `${expected.pluginSource}.nelos-stage-${journal.id}`,
      "plugin source stage",
    );
    if (!/^[a-f0-9]{64}$/.test(journal.plugin.sourceFingerprint ?? "")) {
      throw new Error("unsafe transaction journal plugin source fingerprint");
    }
  }
  if (journal.skill) {
    const skillPath = join(expected.codexHome, "skills", SKILL_NAME);
    assertJournalPath(journal.skill.path, skillPath, "skill");
    assertJournalPath(
      journal.skill.backupPath,
      `${skillPath}.nelos-backup-${journal.id}`,
      "skill backup",
    );
    assertJournalPath(
      journal.skill.stagePath,
      `${skillPath}.nelos-stage-${journal.id}`,
      "skill stage",
    );
  }
  if (journal.current) {
    const currentPath = join(expected.installRoot, "current");
    assertJournalPath(journal.current.path, currentPath, "current release");
    if (journal.current.previousTarget !== null) {
      const previous = resolve(dirname(currentPath), journal.current.previousTarget);
      const previousRelative = relative(join(expected.installRoot, "releases"), previous);
      if (previousRelative.startsWith("..") || isAbsolute(previousRelative)) {
        throw new Error("unsafe transaction journal previous release");
      }
    }
  }
  for (const launcher of journal.launchers ?? []) {
    const command = basename(launcher.path ?? "");
    if (!EXPECTED_BINS.has(command)) {
      throw new Error(`unsafe transaction journal launcher: ${launcher.path}`);
    }
    const launcherPath = join(expected.binDir, command);
    assertJournalPath(launcher.path, launcherPath, "launcher");
    assertJournalPath(
      launcher.backupPath,
      `${launcherPath}.nelos-backup-${journal.id}`,
      "launcher backup",
    );
  }
  return journal;
}

async function recoverTransaction(journalPath, env, report, expected) {
  if (!(await pathExists(journalPath))) return null;
  const journal = await readJson(journalPath);
  validateJournal(journal, expected);
  if (journal.status === "committed") {
    await cleanupTransaction(journal);
    await rm(journalPath, { force: true });
    report(`cleaned committed transaction ${journal.id}`);
    return "committed";
  }
  report(`recovering interrupted transaction ${journal.id}`);
  await rollbackTransaction(journal, { env, report });
  await cleanupTransaction(journal);
  await rm(journalPath, { force: true });
  return "rolled-back";
}

async function inspectDistributionTransaction(journalPath, expected) {
  let journal;
  try {
    journal = await readJson(journalPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  validateJournal(journal, expected);
  return { id: journal.id, status: journal.status };
}

async function recoverDistributionTransactions({
  journalPath,
  marketplaceTransactionPath,
  legacyMarketplaceTransactionPath = null,
  marketplacePath,
  env,
  report,
  expected,
  afterMarketplaceRecovery = null,
}) {
  const mainTransaction = await inspectDistributionTransaction(
    journalPath,
    expected,
  );
  const [sharedIntentExists, legacyIntentExists] = await Promise.all([
    pathExists(marketplaceTransactionPath),
    legacyMarketplaceTransactionPath
      ? pathExists(legacyMarketplaceTransactionPath)
      : false,
  ]);
  if (sharedIntentExists && legacyIntentExists &&
      resolve(marketplaceTransactionPath) !==
        resolve(legacyMarketplaceTransactionPath)) {
    throw new Error(
      "both shared and legacy marketplace transactions exist; refusing ambiguous recovery",
    );
  }
  if (legacyIntentExists) {
    await recoverMarketplaceTransaction(
      legacyMarketplaceTransactionPath,
      marketplacePath,
      {
        preserve: mainTransaction?.status === "committed",
        currentOwnerJournalPath: journalPath,
      },
    );
  } else if (sharedIntentExists) {
    // The shared intent reads its owner journal before that evidence is cleaned.
    // This ordering makes a crash between marketplace and main-journal recovery
    // safe: the marketplace intent is already settled while the main journal
    // remains available for the next run.
    const sharedIntent = await readJson(marketplaceTransactionPath);
    const ownerFieldsPresent = sharedIntent.ownerJournalPath !== undefined ||
      sharedIntent.ownerTransactionId !== undefined;
    const preserveFromCurrentCommit = mainTransaction?.status === "committed" &&
      (!ownerFieldsPresent ||
       (typeof sharedIntent.ownerJournalPath === "string" &&
        resolve(sharedIntent.ownerJournalPath) === resolve(journalPath) &&
        sharedIntent.ownerTransactionId === mainTransaction.id));
    await recoverMarketplaceTransaction(
      marketplaceTransactionPath,
      marketplacePath,
      {
        preserve: preserveFromCurrentCommit,
        currentOwnerJournalPath: journalPath,
      },
    );
  }
  if (afterMarketplaceRecovery) await afterMarketplaceRecovery();
  return recoverTransaction(journalPath, env, report, expected);
}

async function verifyInstalled({
  releasePath,
  provenance,
  binDir,
  skillPath,
  pluginInstalledPath,
  codexCommand,
  pluginSelector,
  env,
}) {
  const integrity = await computeDistributionIntegrity(releasePath);
  if (integrity !== provenance.integrity) {
    throw new Error(`installed release integrity mismatch at ${releasePath}`);
  }
  const cliChecks = await Promise.all(
    [...EXPECTED_BINS].map(async ([command, packagePath]) => {
      const [candidates, expectedCli] = await Promise.all([
        listPathCommands(command, env.PATH),
        realpath(join(releasePath, packagePath)),
      ]);
      return { command, active: candidates[0], expectedCli };
    }),
  );
  for (const { command, active, expectedCli } of cliChecks) {
    if (!active || active.realPath !== expectedCli || dirname(active.path) !== binDir) {
      throw new Error(
        `bare ${command} resolves to ${active?.path ?? "nothing"}, expected ${join(binDir, command)}`,
      );
    }
  }
  const help = await runChecked("nelos", ["--help"], { env });
  for (const command of REQUIRED_CLI_COMMANDS) {
    if (!help.stdout.includes(command)) {
      throw new Error(`installed CLI help is missing required command: ${command}`);
    }
  }
  const skill = await readRequiredProvenance(join(skillPath, PROVENANCE_FILENAME));
  const skillIntegrity = await computeFileIntegrity(join(skillPath, "SKILL.md"));
  if (skillIntegrity !== provenance.skillIntegrity) {
    throw new Error(`installed skill integrity mismatch at ${skillPath}`);
  }
  if (
    !compareProvenance(
      "user-wide skill",
      provenance,
      { provenance: skill, installed: skill.revision, path: skillPath },
      skillPath,
    ).coherent
  ) {
    throw new Error("installed skill provenance does not match the release");
  }
  await verifyPluginInstallation({
    installedPath: pluginInstalledPath,
    provenance,
    codexCommand,
    selector: pluginSelector,
    env,
  });
}

async function restoreCommittedPluginCache({
  state,
  statePath,
  reason,
  installedPath,
  provenance,
  codexCommand,
  selector,
  env,
  appServerContext,
  report,
  testFailpoint,
}) {
  state.plugin.cacheRepair = {
    status: "in-progress",
    startedAt: now(),
    reason: reason.message,
  };
  try {
    await writeJsonAtomically(statePath, state);
    maybeInjectTestFailure("post-commit-cache-repair", testFailpoint);
    const repaired = await runJsonCommand(
      codexCommand,
      ["plugin", "add", selector, "--json"],
      { env },
    );
    if (
      repaired.pluginId !== selector ||
      repaired.version !== provenance.revision ||
      !isAbsolute(repaired.installedPath ?? "") ||
      resolve(repaired.installedPath) !== resolve(installedPath)
    ) {
      throw new Error(
        "Codex CLI returned an unexpected plugin identity while repairing the committed release",
      );
    }
    await verifyPluginInstallation({
      installedPath,
      provenance,
      codexCommand,
      selector,
      env,
    });
    delete state.plugin.cacheRepair;
  } catch (repairError) {
    state.plugin.cacheRepair = {
      ...state.plugin.cacheRepair,
      status: "failed",
      failedAt: now(),
      reason: repairError.message,
    };
    state.plugin.liveActivation = {
      status: "repair-failed",
      registryVerified: false,
      freshTaskSmokeTestRequired: true,
      socketPath: appServerContext.socketPath,
      marketplacePath: appServerContext.marketplacePath,
      reason: repairError.message,
    };
    await writeJsonAtomically(statePath, state).catch((recordError) =>
      report(`could not record plugin-cache repair failure: ${recordError.message}`),
    );
    throw repairError;
  }
}

async function reconcileCommittedPluginAfterAppServer({
  state,
  statePath,
  installedPath,
  provenance,
  codexCommand,
  selector,
  env,
  appServerContext,
  report,
  testFailpoint,
}) {
  // The host request is side-effecting and cannot be cancelled reliably after
  // a timeout. The disk transaction therefore commits first; this reconciliation
  // verifies that any on-time or late host refresh left the committed cache intact.
  const liveActivation = await activateRunningAppServer({
    context: appServerContext,
    revision: provenance.revision,
    report,
  });
  try {
    await verifyPluginInstallation({
      installedPath,
      provenance,
      codexCommand,
      selector,
      env,
    });
    return liveActivation;
  } catch (activationMutationError) {
    report(
      `post-commit app-server refresh changed the plugin cache unexpectedly; restoring the committed release (${activationMutationError.message})`,
    );
    await restoreCommittedPluginCache({
      state,
      statePath,
      reason: activationMutationError,
      installedPath,
      provenance,
      codexCommand,
      selector,
      env,
      appServerContext,
      report,
      testFailpoint,
    });
    return deferredLiveActivation(
      appServerContext,
      "plugin cache was repaired after the running app-server refresh",
      report,
    );
  }
}

export async function installDistribution(options = {}) {
  assertSupportedPlatform();
  const home = resolve(options.home ?? homedir());
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex"));
  const installRoot = resolve(
    options.installRoot ?? join(codexHome, "distributions", PLUGIN_NAME),
  );
  const binDir = resolve(options.binDir ?? join(home, ".local", "bin"));
  const packageRoot = resolve(options.packageRoot);
  const pluginSelector = options.pluginSelector ?? DEFAULT_PLUGIN_SELECTOR;
  const pluginIdentity = parsePluginSelector(pluginSelector);
  const expectedPluginSource = resolve(
    options.pluginSource ?? join(home, "plugins", PLUGIN_NAME),
  );
  const report = options.report ?? (() => {});
  const env = {
    ...process.env,
    ...options.env,
    HOME: home,
    CODEX_HOME: codexHome,
  };
  const ignoredPathEntries = currentDirectoryPathEntries(env.PATH);
  if (ignoredPathEntries.length > 0) {
    env.PATH = safeCommandPath(env.PATH);
    report(
      `ignored ${ignoredPathEntries.length} relative or empty PATH ${
        ignoredPathEntries.length === 1 ? "component" : "components"
      }; command discovery uses absolute entries only`,
    );
  }
  const appServerContext = {
    ...resolveAppServerActivationContext({
      options,
      env,
      home,
      codexHome,
      pluginIdentity,
    }),
    sourcePath: expectedPluginSource,
  };
  const testFailpoint = options.testFailpoint ?? null;
  await ensureCanonicalDirectory(home, "home", { create: false });
  await ensureCanonicalDirectory(codexHome, "CODEX_HOME", {
    enforceMode: true,
  });
  await ensureCanonicalDirectory(installRoot, "distribution install root", {
    enforceMode: true,
  });
  await ensureCanonicalDirectory(binDir, "managed bin directory", {
    mode: 0o755,
    enforceMode: true,
  });
  await ensureCanonicalDirectory(join(codexHome, "skills"), "skill root", {
    enforceMode: true,
  });
  const cacheRoot = join(codexHome, "plugins", "cache");
  await ensureCanonicalDirectory(cacheRoot, "plugin cache root", {
    enforceMode: true,
  });
  const releaseLock = await acquireInstallLock(installRoot);
  let releaseMarketplaceLock = null;
  const journalPath = join(installRoot, TRANSACTION_FILENAME);
  const legacyMarketplaceTransactionPath = join(
    installRoot,
    "marketplace-transaction.json",
  );
  const marketplaceTransactionPath = appServerContext.marketplacePath
    ? join(dirname(appServerContext.marketplacePath), MARKETPLACE_TRANSACTION_FILENAME)
    : join(installRoot, MARKETPLACE_TRANSACTION_FILENAME);
  const transactionId = randomUUID();
  let marketplaceBootstrap = null;
  let installationCommitted = false;
  try {
    if (appServerContext.marketplacePath) {
      const marketplaceRoot = dirname(appServerContext.marketplacePath);
      await ensureCanonicalDirectory(
        marketplaceRoot,
        "local marketplace directory",
      );
      releaseMarketplaceLock = await acquireInstallLock(marketplaceRoot, {
        lockDirectory: MARKETPLACE_LOCK_DIRECTORY,
        scope: "personal marketplace update",
      });
    }
    const codexCommand = await resolveCodexCommand(options.codexCommand, env.PATH);
    await recoverDistributionTransactions({
      journalPath,
      marketplaceTransactionPath,
      legacyMarketplaceTransactionPath,
      marketplacePath: appServerContext.marketplacePath,
      env,
      report,
      expected: {
      codexCommand,
      codexHome,
      installRoot,
      binDir,
      pluginSelector,
      pluginSource: expectedPluginSource,
      },
    });
    marketplaceBootstrap = await activateMarketplaceBootstrap(
      await ensurePersonalMarketplace({
        marketplacePath: appServerContext.marketplacePath,
        pluginIdentity,
        sourcePath: expectedPluginSource,
        home,
      }),
      marketplaceTransactionPath,
      { ownerJournalPath: journalPath, ownerTransactionId: transactionId },
    );
    const plugin = await discoverPlugin(codexCommand, pluginSelector, env);
    if (resolve(plugin.sourcePath) !== expectedPluginSource) {
      throw new Error(
        `${pluginSelector} source is ${plugin.sourcePath}; expected managed source ${expectedPluginSource}. Pass --plugin-source with that exact path only if replacing it is intentional`,
      );
    }
    await ensureCanonicalDirectory(
      dirname(plugin.sourcePath),
      "plugin source parent",
      {},
    );
    if (await pathExists(plugin.sourcePath)) {
      await ensureCanonicalDirectory(plugin.sourcePath, "plugin source", { create: false });
    }
    if (!options.pluginSource && (await pathExists(join(plugin.sourcePath, ".git")))) {
      throw new Error(
        `refusing to replace Git checkout plugin source ${plugin.sourcePath}; pass --plugin-source ${plugin.sourcePath} to opt in explicitly`,
      );
    }
    const pathPreflight = await preflightPath({
      binDir,
      pathValue: env.PATH,
      installRoot,
      force: Boolean(options.force),
    });
    const skillPath = join(codexHome, "skills", SKILL_NAME);
    const statePath = join(installRoot, INSTALL_STATE_FILENAME);
    const previousState = await readInstallState(installRoot);
    const staged = await stageDistribution({ packageRoot, installRoot, env });
    const journal = {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      id: transactionId,
      status: "active",
      createdAt: now(),
      updatedAt: now(),
      codexCommand,
      statePath,
      previousState,
      candidateReleasePath: staged.releasePath,
      plugin: {
        selector: plugin.selector,
        previouslyInstalled: plugin.previouslyInstalled,
        previousVersion: plugin.previousVersion,
      },
      skill: null,
      current: null,
      launchers: [],
    };
    await updateJournal(journalPath, journal);
    let committed = false;

    try {
      const pluginStage = await stagePluginSource(
        plugin.sourcePath,
        staged.releasePath,
        journal.id,
        { rejectGitCheckout: !options.pluginSource },
      );
      await activatePluginSource(pluginStage, journal, journalPath);
      maybeInjectTestFailure("plugin-source", testFailpoint);
      journal.plugin.installAttempted = true;
      await updateJournal(journalPath, journal);
      const pluginInstall = await runJsonCommand(
        codexCommand,
        ["plugin", "add", plugin.selector, "--json"],
        { env },
      );
      if (!isAbsolute(pluginInstall.installedPath ?? "")) {
        throw new Error("codex plugin add did not return an absolute installedPath");
      }
      if (
        pluginInstall.pluginId !== plugin.selector ||
        pluginInstall.version !== staged.provenance.revision
      ) {
        throw new Error(
          `codex plugin add returned unexpected identity: ${pluginInstall.pluginId ?? "missing"} ${pluginInstall.version ?? "missing"}`,
        );
      }
      const installedPath = resolve(pluginInstall.installedPath);
      await ensureCanonicalDirectory(installedPath, "installed plugin cache", {
        create: false,
      });
      const managedPluginCacheRoot = join(
        cacheRoot,
        pluginIdentity.marketplaceName,
        pluginIdentity.name,
      );
      const cacheRelative = relative(managedPluginCacheRoot, installedPath);
      if (
        cacheRelative === "" ||
        cacheRelative.startsWith("..") ||
        isAbsolute(cacheRelative)
      ) {
        throw new Error(
          `codex plugin add returned a path outside the managed plugin cache: ${pluginInstall.installedPath}`,
        );
      }
      journal.plugin.installedPath = pluginInstall.installedPath;
      journal.plugin.installedVersion = pluginInstall.version ?? null;
      journal.plugin.activated = true;
      await updateJournal(journalPath, journal);
      maybeInjectTestFailure("plugin-add", testFailpoint);

      // Fail before replacing any other managed surface. verifyInstalled repeats
      // these checks at the commit boundary to catch concurrent cache drift.
      await verifyPluginInstallation({
        installedPath: pluginInstall.installedPath,
        provenance: staged.provenance,
        codexCommand,
        selector: plugin.selector,
        env,
      });

      await replaceSkill({
        releasePath: staged.releasePath,
        skillPath,
        force: Boolean(options.force),
        journal,
        journalPath,
      });
      maybeInjectTestFailure("skill", testFailpoint);
      await swapCurrent({
        installRoot,
        releasePath: staged.releasePath,
        journal,
        journalPath,
      });
      maybeInjectTestFailure("current", testFailpoint);
      await replaceLaunchers({
        installRoot,
        binDir,
        launcherFingerprints: pathPreflight.launcherFingerprints,
        journal,
        journalPath,
      });
      maybeInjectTestFailure("launchers", testFailpoint);

      await verifyInstalled({
        releasePath: staged.releasePath,
        provenance: staged.provenance,
        binDir,
        skillPath,
        pluginInstalledPath: pluginInstall.installedPath,
        codexCommand,
        pluginSelector: plugin.selector,
        env,
      });
      maybeInjectTestFailure("verify", testFailpoint);
      const state = {
        schemaVersion: INSTALL_SCHEMA_VERSION,
        distribution: DISTRIBUTION_NAME,
        installedAt: now(),
        installRoot,
        releasePath: staged.releasePath,
        binDir,
        codexHome,
        skillPath,
        codexCommand,
        plugin: {
          selector: plugin.selector,
          sourcePath: plugin.sourcePath,
          installedPath: pluginInstall.installedPath,
          version: pluginInstall.version ?? null,
          liveActivation: {
            status: "restart-required",
            registryVerified: false,
            freshTaskSmokeTestRequired: true,
            socketPath: appServerContext.socketPath,
            marketplacePath: appServerContext.marketplacePath,
            reason: "running app-server refresh has not completed",
          },
        },
        provenance: staged.provenance,
      };
      // The state file is transaction data. The journal commit marker must be
      // written last: recovery rolls back a crash before this marker and only
      // cleans backups after it.
      await writeJsonAtomically(statePath, state);
      maybeInjectTestFailure("state", testFailpoint);
      await updateJournal(journalPath, journal, { status: "committed" });
      committed = true;
      installationCommitted = true;
      if (appServerContext.marketplacePath && marketplaceBootstrap?.parentIdentity) {
        await assertMarketplacePathSafety(appServerContext.marketplacePath, {
          expectedParentIdentity: marketplaceBootstrap.parentIdentity,
        });
      }
      await rm(marketplaceTransactionPath, { force: true });
      try {
        await cleanupTransaction(journal);
        await rm(journalPath, { force: true });
      } catch (error) {
        report(
          `installation committed; deferred transaction cleanup at ${journalPath}: ${error.message}`,
        );
      }

      const liveActivation = await reconcileCommittedPluginAfterAppServer({
        state,
        statePath,
        installedPath: pluginInstall.installedPath,
        provenance: staged.provenance,
        codexCommand,
        selector: plugin.selector,
        env,
        appServerContext,
        report,
        testFailpoint,
      });
      state.plugin.liveActivation = liveActivation;
      let activationRecordUpdated = true;
      try {
        await writeJsonAtomically(statePath, state);
      } catch (error) {
        activationRecordUpdated = false;
        report(
          `installation is committed, but the live-activation result could not be recorded: ${error.message}`,
        );
      }
      await cleanupLegacyPluginCaches({
        cacheRoot,
        managedPluginCacheRoot,
        installedPath: pluginInstall.installedPath,
        report,
      });
      report(`installed ${staged.provenance.revision} (${staged.provenance.integrity})`);
      return {
        ...state,
        marketplaceBootstrap,
        reusedRelease: staged.reused,
        activationRecordUpdated,
      };
    } catch (error) {
      if (committed) {
        throw new Error(
          `distribution is committed at ${staged.releasePath}, but post-commit app-server handling failed: ${error.message}`,
          { cause: error },
        );
      }
      try {
        await rollbackTransaction(journal, { env, report });
        await cleanupTransaction(journal);
        await rm(journalPath, { force: true });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `distribution install failed and rollback was incomplete; journal retained at ${journalPath}`,
        );
      }
      throw error;
    }
  } catch (error) {
    if (marketplaceBootstrap?.changed && !installationCommitted) {
      try {
        await recoverMarketplaceTransaction(
          marketplaceTransactionPath,
          marketplaceBootstrap.path,
          { currentOwnerJournalPath: journalPath },
        );
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "distribution install failed and marketplace rollback was refused");
      }
    }
    throw error;
  } finally {
    try {
      if (releaseMarketplaceLock) await releaseMarketplaceLock();
    } finally {
      await releaseLock();
    }
  }
}

export const distributionInstallInternals = {
  LEGACY_HASHES,
  LEGACY_SKILL_HASHES,
  acquireInstallLock,
  activatePluginSource,
  discoverPlugin,
  ensurePersonalMarketplace,
  activateMarketplaceBootstrap,
  recoverMarketplaceTransaction,
  recoverDistributionTransactions,
  preflightPath,
  processIdentitiesMatch,
  processIdentitiesProveReplacement,
  processMayOwnLease,
  recoverTransaction,
  replaceLaunchers,
  runCommand,
  stagePluginSource,
  treeFingerprint,
  verifyExecutableBins,
  verifyPackedPluginStructure,
};
