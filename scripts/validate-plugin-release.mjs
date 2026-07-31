#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  SOURCE_REPOSITORY,
  pluginCacheIdentity,
} from "../src/distribution-provenance.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const PLUGIN_PAYLOAD_PATHS = Object.freeze([
  ".codex-plugin",
  ".mcp.json",
  "assets",
  "bin",
  "completions",
  "docs",
  "package.json",
  "skills",
  "src",
]);

export function validatePluginReleaseChange({
  baseVersion,
  candidateVersion,
  baseCacheIdentity,
  candidateCacheIdentity,
  payloadChanged,
  sourceRevisionChanged = false,
}) {
  const changed = payloadChanged || sourceRevisionChanged;
  if (changed && candidateVersion === baseVersion) {
    throw new Error(
      `distributable plugin payload/source changed without a version bump (${candidateVersion})`,
    );
  }
  if (changed && candidateCacheIdentity === baseCacheIdentity) {
    throw new Error(
      `distributable plugin payload/source changed without a cache identity change (${candidateCacheIdentity})`,
    );
  }
  return { changed, version: candidateVersion, cacheIdentity: candidateCacheIdentity };
}

async function git(root, ...args) {
  return (await execFileAsync("git", args, { cwd: root, encoding: "utf8" })).stdout.trim();
}

async function jsonAt(root, path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

export async function validatePluginRelease({ baseRef, root = repositoryRoot }) {
  if (!baseRef) throw new Error("--base-ref is required");
  const [
    baseManifestText,
    baseProvenanceText,
    candidateManifest,
    packageMetadata,
    mcp,
    provenance,
  ] =
    await Promise.all([
      git(root, "show", `${baseRef}:.codex-plugin/plugin.json`),
      git(root, "show", `${baseRef}:distribution-provenance.json`),
      jsonAt(root, ".codex-plugin/plugin.json"),
      jsonAt(root, "package.json"),
      jsonAt(root, ".mcp.json"),
      jsonAt(root, "distribution-provenance.json"),
    ]);
  const baseManifest = JSON.parse(baseManifestText);
  const baseProvenance = JSON.parse(baseProvenanceText);
  const candidateVersion = candidateManifest.version;
  for (const [label, version] of [
    ["package.json", packageMetadata.version],
    [".mcp.json", mcp?.nelos?.env?.NELOS_PLUGIN_VERSION],
    ["distribution-provenance.json", provenance.revision],
  ]) {
    if (version !== candidateVersion) {
      throw new Error(`${label} version ${version} does not match plugin ${candidateVersion}`);
    }
  }
  const candidateCacheIdentity = pluginCacheIdentity({
    sourceRepository: provenance.sourceRepository,
    version: candidateVersion,
  });
  if (provenance.cacheIdentity !== candidateCacheIdentity) {
    throw new Error("distribution provenance cache identity is missing or stale");
  }
  let payloadChanged = true;
  try {
    await execFileAsync(
      "git",
      ["diff", "--quiet", baseRef, "--", ...PLUGIN_PAYLOAD_PATHS],
      { cwd: root },
    );
    payloadChanged = false;
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  return validatePluginReleaseChange({
    baseVersion: baseManifest.version,
    candidateVersion,
    baseCacheIdentity: pluginCacheIdentity({
      sourceRepository: SOURCE_REPOSITORY,
      version: baseManifest.version,
    }),
    candidateCacheIdentity,
    payloadChanged,
    sourceRevisionChanged:
      baseProvenance.sourceRevision !== provenance.sourceRevision ||
      baseProvenance.sourceRevisionType !== provenance.sourceRevisionType,
  });
}

function parseArgs(args) {
  const index = args.indexOf("--base-ref");
  const baseRef = index === -1 ? process.env.GITHUB_BASE_REF : args[index + 1];
  if (!baseRef) throw new Error("usage: validate-plugin-release --base-ref REF");
  return { baseRef };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validatePluginRelease(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify({ valid: true, ...result })}\n`))
    .catch((error) => {
      process.stderr.write(`validate-plugin-release: ${error.message}\n`);
      process.exitCode = 1;
    });
}
