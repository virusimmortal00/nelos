#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  SOURCE_REPOSITORY,
  pluginCacheIdentity,
} from "../src/distribution-provenance.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function fail(message) {
  throw new Error(message);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function stableVersionParts(version, label) {
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) {
    fail(`${label} must be MAJOR.MINOR.PATCH: ${version}`);
  }
  return version.split(".").map((part) => BigInt(part));
}

export function compareStableVersions(left, right) {
  const leftParts = stableVersionParts(left, "candidate stable version");
  const rightParts = stableVersionParts(right, "current stable version");
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function validateMarketplacePromotion({
  tag,
  currentStableVersion,
  packageMetadata,
  pluginMetadata,
  mcpMetadata,
  provenance,
  lockMetadata,
  marketplace,
}) {
  if (typeof tag !== "string" || !STABLE_TAG.test(tag)) {
    fail(`stable marketplace tag must be vMAJOR.MINOR.PATCH: ${tag}`);
  }

  const version = tag.slice(1);
  const surfaces = [
    ["package.json", packageMetadata?.version],
    [".codex-plugin/plugin.json", pluginMetadata?.version],
    [".mcp.json", mcpMetadata?.nelos?.env?.NELOS_PLUGIN_VERSION],
    ["distribution-provenance.json", provenance?.revision],
    ["package-lock.json", lockMetadata?.version],
    ["package-lock.json root package", lockMetadata?.packages?.[""]?.version],
  ];
  for (const [label, candidate] of surfaces) {
    if (candidate !== version) {
      fail(`${label} version ${candidate} does not match stable tag ${tag}`);
    }
  }
  if (
    currentStableVersion !== undefined &&
    compareStableVersions(version, currentStableVersion) < 0
  ) {
    fail(
      `candidate stable version ${version} is older than current stable version ${currentStableVersion}`,
    );
  }

  if (packageMetadata?.name !== "nelos" || pluginMetadata?.name !== "nelos") {
    fail("package and plugin names must both be nelos");
  }
  if (
    marketplace?.name !== "nelos-marketplace" ||
    marketplace?.interface?.displayName !== "Nelos Marketplace"
  ) {
    fail("marketplace identity must remain nelos-marketplace");
  }
  if (!Array.isArray(marketplace?.plugins) || marketplace.plugins.length !== 1) {
    fail("stable marketplace must contain exactly one plugin");
  }

  const [entry] = marketplace.plugins;
  const expectedEntry = {
    name: pluginMetadata.name,
    source: { source: "local", path: "./" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };
  if (!isDeepStrictEqual(entry, expectedEntry)) {
    fail("stable marketplace plugin entry does not match the supported contract");
  }

  return {
    valid: true,
    tag,
    version,
    marketplaceName: marketplace.name,
    pluginName: entry.name,
  };
}

export function materializeMarketplaceProvenance(provenance, sourceRevision) {
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) {
    fail(`marketplace source revision must be an immutable Git commit: ${sourceRevision}`);
  }
  return {
    ...provenance,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision,
    sourceRevisionType: "git",
    cacheIdentity: pluginCacheIdentity({
      sourceRepository: SOURCE_REPOSITORY,
      version: provenance.revision,
    }),
  };
}

async function git(root, ...argumentsList) {
  const { stdout } = await execFileAsync("git", argumentsList, {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function readPromotionInputs(root, tag) {
  const paths = [
    ["package.json", "packageMetadata"],
    [".codex-plugin/plugin.json", "pluginMetadata"],
    [".mcp.json", "mcpMetadata"],
    ["distribution-provenance.json", "provenance"],
    ["package-lock.json", "lockMetadata"],
    [".agents/plugins/marketplace.json", "marketplace"],
  ];
  const entries = await Promise.all(
    paths.map(async ([path, key]) => [
      key,
      parseJson(await readFile(join(root, path), "utf8"), path),
    ]),
  );
  return validateMarketplacePromotion({
    tag,
    ...Object.fromEntries(entries),
  });
}

async function validateSourceCheckout(root, tag) {
  const reference = `refs/tags/${tag}`;
  const tagType = await git(root, "cat-file", "-t", reference);
  if (tagType !== "tag") {
    fail(`${tag} must be an annotated tag`);
  }
  const sourceCommit = await git(root, "rev-list", "-n", "1", reference);
  const headCommit = await git(root, "rev-parse", "HEAD");
  if (headCommit !== sourceCommit) {
    fail(`checked-out commit ${headCommit} does not match ${tag} at ${sourceCommit}`);
  }
  if (await git(root, "status", "--porcelain")) {
    fail("release checkout must be clean before marketplace promotion");
  }
  return sourceCommit;
}

function parseArguments(argumentsList) {
  const options = { root: repositoryRoot, materialize: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--materialize") {
      options.materialize = true;
      continue;
    }
    if (
      argument !== "--tag" &&
      argument !== "--root" &&
      argument !== "--current-version"
    ) {
      fail(`unknown argument: ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (!value) fail(`${argument} requires a value`);
    if (argument === "--tag") options.tag = value;
    else if (argument === "--root") options.root = resolve(value);
    else options.currentStableVersion = value;
    index += 1;
  }
  if (!options.tag) fail("--tag is required");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await readPromotionInputs(options.root, options.tag);
  if (
    options.currentStableVersion !== undefined &&
    compareStableVersions(result.version, options.currentStableVersion) < 0
  ) {
    fail(
      `candidate stable version ${result.version} is older than current stable version ${options.currentStableVersion}`,
    );
  }
  const sourceCommit = await validateSourceCheckout(options.root, options.tag);
  if (options.materialize) {
    const provenancePath = join(options.root, "distribution-provenance.json");
    const provenance = parseJson(
      await readFile(provenancePath, "utf8"),
      "distribution-provenance.json",
    );
    await writeFile(
      provenancePath,
      `${JSON.stringify(
        materializeMarketplaceProvenance(provenance, sourceCommit),
        null,
        2,
      )}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({ ...result, sourceCommit })}\n`);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`validate-marketplace-promotion: ${error.message}\n`);
    process.exitCode = 1;
  });
}
