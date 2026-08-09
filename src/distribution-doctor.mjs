import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import {
  DISTRIBUTION_NAME,
  INSTALL_STATE_FILENAME,
  MANAGED_CLI_BINS,
  PLUGIN_NAME,
  PROVENANCE_FILENAME,
  compareProvenance,
  computeDistributionIntegrity,
  computeFileIntegrity,
  currentDirectoryPathEntries,
  inspectCliProvenance,
  inspectProvenance,
  listPathCommands,
  validateProvenance,
} from "./distribution-provenance.mjs";
import { resolveControlEndpoint } from "./control-endpoint.mjs";
import { inspectBundledMcpState } from "./bundled-mcp-state.mjs";
import { inspectPersonalMarketplace, parsePersonalMarketplaceText } from "./personal-marketplace.mjs";
import { assertNoSymlinkComponents, ensureCanonicalDirectory, pathInfo } from "./path-safety.mjs";

async function executable(path) {
  try {
    const info = await pathInfo(path);
    if (!info?.isFile() || info.isSymbolicLink()) return false;
    await access(path, constants.X_OK);
    return (await realpath(path)) === resolve(path);
  } catch { return false; }
}

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch { return null; }
}

async function observedIntegrity(readIntegrity) {
  try { return await readIntegrity(); }
  catch { return null; }
}

const item = (id, status, summary, nextStep = null) => ({ id, status, summary, nextStep });

function within(path, root) {
  const value = relative(resolve(root), resolve(path));
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}

async function validateStateCandidate(candidate, { codexHome, installRoot }) {
  if (candidate?.schemaVersion !== 1 || candidate.distribution !== DISTRIBUTION_NAME ||
      resolve(candidate.codexHome ?? "") !== codexHome || resolve(candidate.installRoot ?? "") !== installRoot ||
      !isAbsolute(candidate.releasePath ?? "") || !within(candidate.releasePath, join(installRoot, "releases")) ||
      !isAbsolute(candidate.binDir ?? "") || !isAbsolute(candidate.codexCommand ?? "") || !isAbsolute(candidate.skillPath ?? "") ||
      resolve(candidate.skillPath) !== join(codexHome, "skills", "manage-nelos-tasks") ||
      candidate.plugin?.selector !== `${PLUGIN_NAME}@personal` ||
      !isAbsolute(candidate.plugin?.sourcePath ?? "") || !isAbsolute(candidate.plugin?.installedPath ?? "") ||
      !within(candidate.plugin.installedPath, join(codexHome, "plugins", "cache", "personal", PLUGIN_NAME))) {
    throw new Error("invalid managed install state");
  }
  validateProvenance(candidate.provenance, "install state");
  await Promise.all([
    ensureCanonicalDirectory(codexHome, "CODEX_HOME", { create: false }),
    ensureCanonicalDirectory(installRoot, "distribution install root", { create: false }),
    ensureCanonicalDirectory(candidate.releasePath, "recorded release", { create: false }),
    ensureCanonicalDirectory(candidate.binDir, "managed bin directory", { create: false }),
    ensureCanonicalDirectory(candidate.skillPath, "user-wide skill", { create: false }),
    ensureCanonicalDirectory(candidate.plugin.sourcePath, "plugin source", { create: false }),
    ensureCanonicalDirectory(candidate.plugin.installedPath, "plugin cache", { create: false }),
  ]);
  return candidate;
}

export async function diagnoseDistribution(options = {}) {
  const home = resolve(options.home ?? homedir());
  const env = { ...process.env, ...options.env };
  const codexHome = resolve(options.codexHome ?? env.CODEX_HOME ?? join(home, ".codex"));
  const installRoot = resolve(options.installRoot ?? join(codexHome, "distributions", PLUGIN_NAME));
  const checks = [];
  const unsafePath = currentDirectoryPathEntries(env.PATH ?? "");
  const safePath = (env.PATH ?? "").split(delimiter).filter((entry) => entry && isAbsolute(entry)).join(delimiter);
  const candidates = await listPathCommands("codex", safePath);
  let trustedCodex = null;
  if (options.codexCommand) {
    const requested = resolve(options.codexCommand);
    if (await executable(requested)) trustedCodex = await realpath(requested);
    checks.push(trustedCodex ? item("codex-executable", "ok", "explicit Codex executable is canonical and executable") : item("codex-executable", "error", "explicit Codex executable is missing, symlinked, or not executable", "Pass --codex with one canonical trusted executable."));
  } else if (unsafePath.length > 0 || candidates.length !== 1) {
    checks.push(item("codex-executable", "error", "PATH does not select exactly one unambiguous canonical Codex executable", "Remove relative/empty PATH entries and shadows, or pass --codex explicitly."));
  } else {
    trustedCodex = candidates[0].realPath;
    checks.push(item("codex-executable", "ok", "PATH selects one canonical Codex executable"));
  }
  let state = null;
  try {
    const candidate = JSON.parse(await readFile(join(installRoot, INSTALL_STATE_FILENAME), "utf8"));
    state = await validateStateCandidate(candidate, { codexHome, installRoot });
  } catch {
    checks.push(item("distribution", "error", "managed distribution state is missing or invalid", "Run npm run install:distribution from the trusted source checkout."));
  }
  if (state) {
    const cliBindings = await Promise.all(
      Object.entries(MANAGED_CLI_BINS).map(async ([command, packagePath]) => {
        const [matches, expectedRealPath] = await Promise.all([
          listPathCommands(command, safePath),
          canonicalPath(join(state.releasePath, packagePath)),
        ]);
        return {
          command,
          expectedLauncher: join(state.binDir, command),
          expectedRealPath,
          matches,
        };
      }),
    );
    const nelosTaskBinding = cliBindings.find(
      ({ command }) => command === "nelos",
    );
    const [cli, skill, plugin, releaseIntegrity, skillIntegrity, pluginIntegrity] = await Promise.all([
      inspectCliProvenance(nelosTaskBinding?.matches[0]?.path ?? null),
      inspectProvenance(join(codexHome, "skills", "manage-nelos-tasks", PROVENANCE_FILENAME)),
      inspectProvenance(join(state.plugin.installedPath, PROVENANCE_FILENAME)),
      observedIntegrity(() => computeDistributionIntegrity(
        state.releasePath,
        {
          allowLegacyWithoutCorpus: true,
          allowLegacyWithoutAgentPluginLayout: true,
        },
      )),
      observedIntegrity(() => computeFileIntegrity(join(state.skillPath, "SKILL.md"))),
      observedIntegrity(() => computeDistributionIntegrity(
        state.plugin.installedPath,
        {
          allowLegacyWithoutCorpus: true,
          allowLegacyWithoutAgentPluginLayout: true,
        },
      )),
    ]);
    const distributionIntact = Boolean(
      state.provenance.integrity &&
      releaseIntegrity === state.provenance.integrity,
    );
    checks.push(distributionIntact
      ? item("distribution", "ok", "managed release content matches recorded integrity")
      : item("distribution", "error", "managed release content is missing or does not match recorded integrity", "Re-run the unified distribution installer from the trusted source checkout."));
    const recordedCodex = await executable(state.codexCommand)
      ? await canonicalPath(state.codexCommand)
      : null;
    const codexBound = Boolean(
      trustedCodex && recordedCodex && trustedCodex === recordedCodex,
    );
    const cliBound = cliBindings.every(
      ({ expectedLauncher, expectedRealPath, matches }) =>
        matches.length >= 1 &&
        matches[0].path === expectedLauncher &&
        matches[0].realPath === expectedRealPath,
    );
    if (cliBound && cliBindings.some(({ matches }) => matches.length > 1)) {
      checks.push(item(
        "cli-path-duplicates",
        "warning",
        "PATH contains inactive managed-command duplicates after the recorded launchers",
        "Remove stale later PATH entries when convenient; the recorded launchers remain active.",
      ));
    }
    const installedContentIntact = Boolean(
      state.provenance.skillIntegrity &&
      skillIntegrity === state.provenance.skillIntegrity &&
      state.provenance.integrity &&
      pluginIntegrity === state.provenance.integrity,
    );
    const coherent = codexBound && cliBound && distributionIntact &&
      installedContentIntact &&
      [
        compareProvenance("CLI", state.provenance, cli),
        compareProvenance("skill", state.provenance, skill),
        compareProvenance("plugin", state.provenance, plugin),
      ].every(({ coherent: surfaceCoherent }) => surfaceCoherent);
    checks.push(coherent ? item("coherence", "ok", `CLI, skill, and plugin share revision ${state.provenance.revision}`) : item("coherence", "error", "CLI, skill, and plugin provenance is missing, ambiguous, or inconsistent", "Re-run the unified distribution installer, then rerun doctor."));
    const mcpState = await inspectBundledMcpState({
      pluginRoot: state.plugin.installedPath,
      selector: state.plugin.selector,
      expectedVersion: state.provenance.revision,
      configPath: resolve(options.configPath ?? join(codexHome, "config.toml")),
    });
    checks.push({
      ...item(
        "bundled-mcp-server",
        mcpState.state === "healthy" ? "ok" : "error",
        `${mcpState.state}: ${mcpState.detail}`,
        mcpState.recovery,
      ),
      state: mcpState.state,
    });
  }
  const marketplacePath = resolve(options.marketplacePath ?? join(home, ".agents", "plugins", "marketplace.json"));
  const expectedSource = resolve(state?.plugin?.sourcePath ?? join(home, "plugins", PLUGIN_NAME));
  try {
    const marketplaceInfo = await pathInfo(marketplacePath);
    if (!marketplaceInfo) {
      await assertNoSymlinkComponents(join(marketplacePath, ".."), "local marketplace directory");
      checks.push(item(
        "marketplace",
        "warning",
        "personal marketplace is absent and ready for safe bootstrap",
        "Run the unified distribution installer to create the marketplace and Nelos entry.",
      ));
    } else {
      if (!marketplaceInfo.isFile() || marketplaceInfo.isSymbolicLink() || marketplaceInfo.size > 1_048_576) {
        throw new Error("unsafe marketplace");
      }
      await ensureCanonicalDirectory(join(marketplacePath, ".."), "local marketplace directory", { create: false });
      if ((await realpath(marketplacePath)) !== marketplacePath) throw new Error("unsafe marketplace ancestry");
      let marketplace;
      try { marketplace = parsePersonalMarketplaceText(await readFile(marketplacePath, "utf8")).document; }
      catch { throw new Error("unreadable marketplace"); }
      const inspection = inspectPersonalMarketplace(marketplace, {
        pluginIdentity: { name: PLUGIN_NAME, marketplaceName: "personal" },
        sourcePath: expectedSource,
        marketplacePath,
        home,
      });
      if (inspection.state === "compatible") {
        checks.push(item("marketplace", "ok", "personal marketplace has one unambiguous local Nelos source"));
      } else if (inspection.state === "bootstrap-ready") {
        if (inspection.mutation?.kind === "append-target-properties") {
          checks.push(item(
            "marketplace",
            "warning",
            "Nelos marketplace source is valid and ready for canonical policy metadata",
            "Run the unified distribution installer to add only missing Nelos metadata; unrelated content will be preserved.",
          ));
        } else {
          checks.push(item(
            "marketplace",
            "warning",
            "personal marketplace is valid and ready for a Nelos entry",
            "Run the unified distribution installer to add only the Nelos entry; unrelated content will be preserved.",
          ));
        }
      } else {
        checks.push(item(
          "marketplace",
          "error",
          "personal marketplace conflicts with the managed Nelos source",
          "Inspect the target entry; do not replace it silently. Use an exact --plugin-source path only if this distribution should own that source.",
        ));
      }
    }
  } catch {
    checks.push(item(
      "marketplace",
      "error",
      "personal marketplace conflicts with the managed Nelos source",
      "Inspect the target entry and path ancestry; do not replace them silently.",
    ));
  }
  try {
    const endpoint = resolveControlEndpoint({ socketPath: options.socketPath, env, codexHome });
    if (!isAbsolute(endpoint.endpoint.path)) throw new Error("relative endpoint");
    const endpointInfo = await pathInfo(endpoint.endpoint.path);
    if (endpointInfo?.isSocket() && !endpointInfo.isSymbolicLink()) {
      await ensureCanonicalDirectory(join(endpoint.endpoint.path, ".."), "app-server socket directory", { create: false });
      checks.push(item("host-endpoint", "warning", "canonical Unix socket path is present; compatibility is unverified and peer identity is unattested", "Use a compatible Codex app server/developer launcher, then run a fresh-task smoke test."));
    } else {
      checks.push(item("host-endpoint", "warning", "no canonical Unix socket path is present", "Start a compatible Codex app server/developer launcher; proposed host injection is not available yet."));
    }
  } catch {
    checks.push(item("host-endpoint", "error", "host endpoint configuration is malformed or has unsafe ancestry", "Remove the malformed endpoint setting or pass one canonical trusted --socket path."));
  }
  checks.push(state?.plugin?.liveActivation?.registryVerified ? item("fresh-task", "warning", "host registry was refreshed; a fresh task is still required", "Start a fresh Codex task and smoke-test the plugin tools.") : item("fresh-task", "warning", "Codex restart and a fresh task are required", "Start or restart compatible Codex, then create a fresh task."));
  const ok = checks.every(({ status }) => status !== "error");
  return { schemaVersion: 1, ok, readOnly: true, trustedCodexSelected: Boolean(trustedCodex), checks };
}
