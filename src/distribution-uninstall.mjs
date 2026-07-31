import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  DISTRIBUTION_NAME,
  INSTALL_STATE_FILENAME,
  MANAGED_CLI_COMMANDS,
  PLUGIN_NAME,
  PROVENANCE_FILENAME,
  currentDirectoryPathEntries,
  readProvenance,
  safeCommandPath,
} from "./distribution-provenance.mjs";
import {
  acquireInstallLock,
  resolveCodexCommand,
  writeJsonAtomically,
} from "./distribution-install.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function within(path, root) {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function run(command, args, env) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => status === 0
      ? accept()
      : reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim()}`)));
  });
}

async function removeManagedTree(path, label) {
  const pathInfo = await info(path);
  if (!pathInfo) return false;
  if (!pathInfo.isDirectory() || pathInfo.isSymbolicLink()) {
    throw new Error(`refusing to remove unsafe ${label}: ${path}`);
  }
  const provenance = await readProvenance(join(path, PROVENANCE_FILENAME));
  if (!provenance || provenance.distribution !== DISTRIBUTION_NAME) {
    throw new Error(`refusing to remove unverified ${label}: ${path}`);
  }
  await rm(path, { recursive: true });
  return true;
}

async function removeLauncher(path, installRoot) {
  const pathInfo = await info(path);
  if (!pathInfo) return false;
  if (!pathInfo.isSymbolicLink()) return false;
  const target = resolve(dirname(path), await readlink(path));
  if (!within(target, installRoot)) return false;
  await rm(path);
  return true;
}

async function removePluginCacheRoot(path) {
  const pathInfo = await info(path);
  if (!pathInfo) return false;
  if (!pathInfo.isDirectory() || pathInfo.isSymbolicLink()) {
    throw new Error(`refusing unsafe Nelos plugin cache root: ${path}`);
  }
  await realpath(path);
  await rm(path, { recursive: true });
  return true;
}

async function removePersonalMarketplaceEntry(path, sourcePath) {
  const pathInfo = await info(path);
  if (!pathInfo) return false;
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw new Error(`refusing unsafe personal marketplace file: ${path}`);
  }
  const document = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(document.plugins)) return false;
  const retained = document.plugins.filter((plugin) => !(
    plugin?.name === PLUGIN_NAME &&
    plugin?.source?.source === "local" &&
    resolve(dirname(path), plugin.source.path) === resolve(sourcePath)
  ));
  if (retained.length === document.plugins.length) return false;
  await writeJsonAtomically(
    path,
    { ...document, plugins: retained },
    pathInfo.mode & 0o777,
  );
  return true;
}

export async function uninstallDistribution(options = {}) {
  const home = resolve(options.home ?? homedir());
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex"));
  const installRoot = resolve(options.installRoot ?? join(codexHome, "distributions", PLUGIN_NAME));
  const env = { ...process.env, ...options.env, HOME: home, CODEX_HOME: codexHome };
  if (currentDirectoryPathEntries(env.PATH).length > 0) {
    env.PATH = safeCommandPath(env.PATH);
  }
  await ensureCanonicalDirectory(installRoot, "distribution install root", {
    enforceMode: true,
  });
  const releaseLock = await acquireInstallLock(installRoot, {
    scope: "distribution uninstall",
  });
  try {
    let state = null;
    try { state = JSON.parse(await readFile(join(installRoot, INSTALL_STATE_FILENAME), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const binDir = resolve(
      options.binDir ?? state?.binDir ?? join(home, ".local", "bin"),
    );
    const sourcePath = resolve(
      options.pluginSource ?? state?.plugin?.sourcePath ?? join(home, "plugins", PLUGIN_NAME),
    );
    const selector =
      options.pluginSelector ?? state?.plugin?.selector ?? `${PLUGIN_NAME}@personal`;
    const marketplacePath = resolve(
      options.marketplacePath ??
      state?.plugin?.liveActivation?.marketplacePath ??
      join(home, ".agents", "plugins", "marketplace.json"),
    );
    const codexCommand = await resolveCodexCommand(
      options.codexCommand ?? state?.codexCommand,
      env.PATH,
    );
    await run(codexCommand, ["plugin", "remove", selector, "--json"], env).catch((error) => {
      if (!options.allowMissingPlugin) throw error;
    });

    const removed = [];
    for (const command of MANAGED_CLI_COMMANDS) {
      if (await removeLauncher(join(binDir, command), installRoot)) removed.push(`launcher:${command}`);
    }
    if (await removeManagedTree(join(codexHome, "skills", "manage-nelos-tasks"), "global skill")) {
      removed.push("global-skill");
    }
    if (await removeManagedTree(sourcePath, "managed plugin source")) removed.push("plugin-source");
    for (const cachePath of [
      join(codexHome, "plugins", "cache", "personal", PLUGIN_NAME),
      join(codexHome, "plugins", "cache", PLUGIN_NAME),
    ]) {
      if (await removePluginCacheRoot(cachePath)) removed.push(`cache:${cachePath}`);
    }
    if (await removePersonalMarketplaceEntry(marketplacePath, sourcePath)) {
      removed.push("personal-marketplace-entry");
    }
    const rootInfo = await info(installRoot);
    if (rootInfo) {
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error(`refusing unsafe distribution root: ${installRoot}`);
      }
      await rm(installRoot, { recursive: true });
      removed.push("distribution-root");
    }
    return { uninstalled: true, selector, removed, restartRequired: true, freshTaskRequired: true };
  } finally {
    await releaseLock();
  }
}

export const distributionUninstallInternals = {
  removeLauncher,
  removeManagedTree,
  removePersonalMarketplaceEntry,
  removePluginCacheRoot,
};
