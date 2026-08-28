import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export const PROVENANCE_FILENAME = "distribution-provenance.json";
export const DISTRIBUTION_NAME = "nelos";
export const PLUGIN_NAME = "nelos";
export const SOURCE_REPOSITORY = "https://github.com/virusimmortal00/nelos.git";
export const INSTALL_STATE_FILENAME = "install-state.json";
export const REQUIRED_CLI_COMMANDS = [
  "doctor",
  "spinoff",
  "web begin",
  "web join",
  "web collect",
  "web readiness",
  "web accept",
  "plan slices",
  "worktree plan",
  "worktree provision",
  "worktree inspect",
  "worktree launch",
  "worktree integration",
  "intelligence route",
  "intelligence verify",
];
export const MANAGED_CLI_BINS = Object.freeze({
  "nelos": "bin/nelos",
  "nelos-experiment": "bin/nelos-experiment",
  "nelos-title": "bin/nelos-title",
  "nelos-install-skill": "bin/nelos-install-skill",
  "nelos-install-distribution": "bin/nelos-install-distribution",
  "nelos-uninstall-distribution": "bin/nelos-uninstall-distribution",
  "nelos-verify-distribution": "bin/nelos-verify-distribution",
});
export const MANAGED_CLI_COMMANDS = Object.freeze(Object.keys(MANAGED_CLI_BINS));
export const DISTRIBUTION_ENTRIES = [
  ".codex-plugin",
  ".mcp.json",
  "plugin.json",
  "mcp.json",
  "CHANGELOG.md",
  "README.md",
  "assets",
  "bin",
  "completions",
  "corpus",
  "docs",
  "evals",
  "package.json",
  "scripts/evaluate-routing-scenarios.mjs",
  "skills",
  "src",
  "validation/desktop-smoke",
];

export function materializeGitDistributionProvenance(provenance, { sourceRevision, integrity }) {
  validateProvenance(provenance, "base distribution provenance");
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision ?? "")) throw new Error("Git distribution provenance requires a full SHA-1 commit");
  if (!/^sha256:[a-f0-9]{64}$/u.test(integrity ?? "")) throw new Error("Git distribution provenance requires a SHA-256 integrity digest");
  return validateProvenance({
    ...provenance,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision,
    sourceRevisionType: "git",
    cacheIdentity: pluginCacheIdentity({ sourceRepository: SOURCE_REPOSITORY, version: provenance.revision }),
    integrity,
  }, "materialized Git distribution provenance");
}

export function currentDirectoryPathEntries(pathValue = "") {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry === "" || !isAbsolute(entry));
}

export function safeCommandPath(pathValue = "") {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry !== "" && isAbsolute(entry))
    .join(delimiter);
}

export function validateProvenance(value, source) {
  if (
    value?.schemaVersion !== 1 ||
    value?.distribution !== DISTRIBUTION_NAME ||
    typeof value?.revision !== "string" ||
    value.revision.length === 0 ||
    (value.sourceRepository !== undefined &&
      value.sourceRepository !== SOURCE_REPOSITORY) ||
    (value.sourceRevision !== undefined &&
      !/^[a-f0-9]{40}$/.test(value.sourceRevision)) ||
    (value.sourceRevisionType !== undefined &&
      !["git", "distribution-sha256"].includes(value.sourceRevisionType)) ||
    (value.cacheIdentity !== undefined &&
      value.cacheIdentity !== pluginCacheIdentity({
        sourceRepository: value.sourceRepository,
        version: value.revision,
      })) ||
    (value.integrity !== undefined &&
      !/^sha256:[a-f0-9]{64}$/.test(value.integrity)) ||
    (value.skillIntegrity !== undefined &&
      !/^sha256:[a-f0-9]{64}$/.test(value.skillIntegrity)) ||
    (value.requiredCliCommands !== undefined &&
      (!Array.isArray(value.requiredCliCommands) ||
        value.requiredCliCommands.length === 0 ||
        new Set(value.requiredCliCommands).size !== value.requiredCliCommands.length ||
        value.requiredCliCommands.some(
          (command) => typeof command !== "string" || command.length === 0,
        )))
  ) {
    throw new Error(`invalid provenance record from ${source}`);
  }
  return value;
}

export function pluginCacheIdentity({
  sourceRepository = SOURCE_REPOSITORY,
  version,
} = {}) {
  if (sourceRepository !== SOURCE_REPOSITORY ||
      typeof version !== "string" || version.length === 0) {
    throw new Error("cache identity requires the canonical source repository and release version");
  }
  return `${sourceRepository}#${PLUGIN_NAME}@${version}`;
}

export async function readProvenance(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`invalid provenance JSON at ${path}: ${error.message}`);
    }
    throw error;
  }

  return validateProvenance(value, path);
}

export async function readRequiredProvenance(path) {
  const provenance = await readProvenance(path);
  if (!provenance) {
    throw new Error(`bundled provenance is missing at ${path}`);
  }
  return provenance;
}

export async function inspectProvenance(path) {
  try {
    const provenance = await readProvenance(path);
    return {
      path,
      provenance,
      installed: provenance?.revision ?? "missing",
      error: null,
    };
  } catch (error) {
    return { path, provenance: null, installed: "invalid", error: error.message };
  }
}

async function isExecutable(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

export async function listPathCommands(command, pathValue = "") {
  const matches = [];
  const seen = new Set();
  for (const entry of pathValue.split(delimiter)) {
    const path = resolve(entry || ".", command);
    if (seen.has(path) || !(await isExecutable(path))) continue;
    seen.add(path);
    let realPath;
    try {
      realPath = await realpath(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    matches.push({ path, realPath });
  }
  return matches;
}

export async function resolvePathCommand(command, pathValue = "") {
  return (await listPathCommands(command, pathValue))[0]?.realPath ?? null;
}

export async function inspectCliProvenance(path) {
  if (!path) return null;
  let realPath;
  try {
    realPath = await realpath(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const root = dirname(dirname(realPath));
  const inspection = await inspectProvenance(join(root, PROVENANCE_FILENAME));
  return { ...inspection, path, realPath, root };
}

export async function computeFileIntegrity(path) {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

async function listIntegrityFiles(root, entry) {
  const start = join(root, entry);
  const info = await lstat(start);
  if (info.isSymbolicLink()) {
    throw new Error(`distribution entry must not be a symlink: ${start}`);
  }
  if (info.isFile()) return [start];
  if (!info.isDirectory()) {
    throw new Error(`unsupported distribution entry type: ${start}`);
  }

  const files = [];
  for (const child of await readdir(start, { withFileTypes: true })) {
    const childPath = join(start, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(`distribution entry must not be a symlink: ${childPath}`);
    }
    if (child.isDirectory()) {
      files.push(...(await listIntegrityFiles(root, relative(root, childPath))));
    } else if (child.isFile()) {
      files.push(childPath);
    } else {
      throw new Error(`unsupported distribution entry type: ${childPath}`);
    }
  }
  return files;
}

async function selectedDistributionFiles(root, {
  includeProvenance = false,
  allowLegacyWithoutCorpus = false,
  allowLegacyWithoutAgentPluginLayout = false,
} = {}) {
  const requireCertificationEntries = await requiresCertificationEntries(root);
  let omitLegacyAgentPluginLayout = false;
  if (allowLegacyWithoutAgentPluginLayout) {
    const presence = await Promise.all(
      ["plugin.json", "mcp.json"].map(async (entry) => {
        try {
          await lstat(join(root, entry));
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      }),
    );
    omitLegacyAgentPluginLayout = presence.every((entryPresent) => !entryPresent);
  }
  const files = [];
  const entries = includeProvenance ? [...DISTRIBUTION_ENTRIES, PROVENANCE_FILENAME] : DISTRIBUTION_ENTRIES;
  for (const entry of entries) {
    if (
      omitLegacyAgentPluginLayout &&
      (entry === "plugin.json" || entry === "mcp.json")
    ) {
      continue;
    }
    if (allowLegacyWithoutCorpus && entry === "corpus") {
      try {
        await lstat(join(root, entry));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
    }
    try {
      files.push(...(await listIntegrityFiles(root, entry)));
    } catch (error) {
      if (error.code === "ENOENT" && !requireCertificationEntries && entry === "validation/desktop-smoke") continue;
      throw error;
    }
  }
  return files.map((path) => ({ path, relativePath: relative(root, path).split("\\").join("/") }))
    .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
}

async function requiresCertificationEntries(root) {
  try {
    const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version ?? "");
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    return major > 0 || minor > 12 || (minor === 12 && patch >= 20);
  } catch {
    return false;
  }
}

export async function listDistributionFiles(root, options = {}) {
  return (await selectedDistributionFiles(root, options)).map(({ relativePath }) => relativePath);
}

export async function computeDistributionIntegrity(root, options = {}) {
  const files = await selectedDistributionFiles(root, options);

  const hash = createHash("sha256");
  for (const { path, relativePath } of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function findPluginProvenance(codexHome) {
  const cacheRoot = join(codexHome, "plugins", "cache");
  const matches = [];
  let marketplaces;
  try {
    marketplaces = await readdir(cacheRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return matches;
    throw error;
  }

  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory()) continue;
    const pluginRoot = join(cacheRoot, marketplace.name, PLUGIN_NAME);
    let revisions;
    try {
      revisions = await readdir(pluginRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const revision of revisions) {
      if (!revision.isDirectory()) continue;
      const revisionRoot = join(pluginRoot, revision.name);
      const candidate = join(revisionRoot, PROVENANCE_FILENAME);
      const inspection = await inspectProvenance(candidate);
      let installedAtMs;
      try {
        ({ mtimeMs: installedAtMs } = await stat(revisionRoot));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      matches.push({
        ...inspection,
        marketplace: marketplace.name,
        cacheRevision: revision.name,
        installedAtMs,
      });
    }
  }
  return matches;
}

export function selectPluginProvenance(matches) {
  if (matches.length === 0) return null;
  const marketplaces = new Set(matches.map(({ marketplace }) => marketplace));
  if (marketplaces.size > 1) {
    return {
      path: matches.map(({ path }) => path).sort().join(", "),
      provenance: null,
      installed: "ambiguous",
      error: `cached copies found in multiple marketplaces: ${[...marketplaces].sort().join(", ")}`,
    };
  }
  return matches.toSorted(
    ({ installedAtMs: left }, { installedAtMs: right }) => left - right,
  ).at(-1);
}

export function sameStringSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  );
}

export function compareProvenance(surface, expected, inspection, path) {
  const installed = inspection?.provenance;
  return {
    surface,
    expected: expected.revision,
    installed: inspection?.installed ?? "missing",
    path: path ?? inspection?.path ?? "not found",
    detail: inspection?.error,
    coherent:
      installed?.schemaVersion === expected.schemaVersion &&
      installed?.distribution === expected.distribution &&
      installed?.revision === expected.revision &&
      (expected.integrity === undefined || installed?.integrity === expected.integrity) &&
      (expected.skillIntegrity === undefined ||
        installed?.skillIntegrity === expected.skillIntegrity) &&
      (expected.sourceRepository === undefined ||
        installed?.sourceRepository === expected.sourceRepository) &&
      (expected.sourceRevision === undefined ||
        installed?.sourceRevision === expected.sourceRevision) &&
      (expected.sourceRevisionType === undefined ||
        installed?.sourceRevisionType === expected.sourceRevisionType) &&
      (expected.cacheIdentity === undefined ||
        installed?.cacheIdentity === expected.cacheIdentity) &&
      (expected.requiredCliCommands === undefined ||
        sameStringSet(
          installed?.requiredCliCommands,
          expected.requiredCliCommands,
        )),
  };
}
