#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  computeDistributionIntegrity,
} from "../src/distribution-provenance.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function fail(message) {
  throw new Error(message);
}

function json(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

export function assertReleaseTag(tag, version) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    fail(`package version is not valid SemVer: ${version}`);
  }
  if (tag !== `v${version}`) {
    fail(`tag ${tag} must exactly equal v${version}`);
  }
}

export function validateVersionCoherence({
  tag,
  packageMetadata,
  pluginMetadata,
  mcpMetadata,
  provenance,
  lockMetadata,
  actualIntegrity,
}) {
  const version = packageMetadata?.version;
  assertReleaseTag(tag, version);
  const surfaces = [
    [".codex-plugin/plugin.json", pluginMetadata?.version],
    [".mcp.json", mcpMetadata?.nelos?.env?.NELOS_PLUGIN_VERSION],
    ["distribution-provenance.json", provenance?.revision],
    ["package-lock.json", lockMetadata?.version],
    ["package-lock.json root package", lockMetadata?.packages?.[""]?.version],
  ];
  for (const [label, candidate] of surfaces) {
    if (candidate !== version) {
      fail(`${label} version ${candidate} does not match ${version}`);
    }
  }
  if (provenance?.integrity !== actualIntegrity) {
    fail("distribution provenance does not match the candidate bytes");
  }
  return version;
}

export function extractReleaseNotes(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const heading = new RegExp(
    `^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`,
    "mu",
  );
  const match = heading.exec(changelog);
  if (!match) {
    fail(`CHANGELOG.md has no dated ${version} release section`);
  }
  const start = match.index;
  const remainder = changelog.slice(start + match[0].length);
  const nextHeading = /^##\s+/mu.exec(remainder);
  const end =
    nextHeading === null
      ? changelog.length
      : start + match[0].length + nextHeading.index;
  return `${changelog.slice(start, end).trim()}\n`;
}

function packageNameFromLockPath(path, metadata) {
  if (typeof metadata?.name === "string" && metadata.name.length > 0) {
    return metadata.name;
  }
  return path.replace(/^node_modules\//u, "");
}

function purl(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

export function buildCycloneDxBom({
  packageMetadata,
  lockMetadata,
  sourceCommit,
}) {
  const rootRef = purl(packageMetadata.name, packageMetadata.version);
  const components = Object.entries(lockMetadata.packages ?? {})
    .filter(([path, metadata]) => path !== "" && metadata?.version)
    .map(([path, metadata]) => {
      const name = packageNameFromLockPath(path, metadata);
      const reference = purl(name, metadata.version);
      return {
        type: "library",
        "bom-ref": reference,
        name,
        version: metadata.version,
        purl: reference,
        ...(metadata.license ? { licenses: [{ license: { id: metadata.license } }] } : {}),
        ...(metadata.dev ? { scope: "excluded" } : {}),
      };
    })
    .sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: packageMetadata.name,
        version: packageMetadata.version,
        purl: rootRef,
      },
      properties: [
        { name: "nelos:source-commit", value: sourceCommit },
      ],
    },
    components,
    dependencies: [
      {
        ref: rootRef,
        dependsOn: components.map((component) => component["bom-ref"]),
      },
    ],
  };
}

async function sha256(path) {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

async function git(root, ...argumentsList) {
  const { stdout } = await execFileAsync("git", argumentsList, {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.trim();
}

export async function validateAnnotatedTag(
  tag,
  root = repositoryRoot,
  environment = process.env,
) {
  const reference = `refs/tags/${tag}`;
  const type = await git(root, "cat-file", "-t", reference);
  if (type !== "tag") {
    fail(`${tag} must be an annotated tag`);
  }
  const [tagCommit, headCommit, status] = await Promise.all([
    git(root, "rev-list", "-n", "1", reference),
    git(root, "rev-parse", "HEAD"),
    git(root, "status", "--porcelain"),
  ]);
  if (tagCommit !== headCommit) {
    fail(`${tag} does not resolve to the checked-out commit`);
  }
  if (environment.GITHUB_SHA && environment.GITHUB_SHA !== tagCommit) {
    fail("GitHub event commit does not match the annotated tag target");
  }
  if (status !== "") {
    fail("release artifacts require a clean checkout");
  }
  return tagCommit;
}

async function readReleaseInputs(tag, root = repositoryRoot) {
  const [
    packageText,
    pluginText,
    mcpText,
    provenanceText,
    lockText,
    changelog,
  ] = await Promise.all([
    readFile(join(root, "package.json"), "utf8"),
    readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"),
    readFile(join(root, ".mcp.json"), "utf8"),
    readFile(join(root, "distribution-provenance.json"), "utf8"),
    readFile(join(root, "package-lock.json"), "utf8"),
    readFile(join(root, "CHANGELOG.md"), "utf8"),
  ]);
  const packageMetadata = json(packageText, "package.json");
  const pluginMetadata = json(pluginText, ".codex-plugin/plugin.json");
  const mcpMetadata = json(mcpText, ".mcp.json");
  const provenance = json(provenanceText, "distribution-provenance.json");
  const lockMetadata = json(lockText, "package-lock.json");
  const actualIntegrity = await computeDistributionIntegrity(root);
  const version = validateVersionCoherence({
    tag,
    packageMetadata,
    pluginMetadata,
    mcpMetadata,
    provenance,
    lockMetadata,
    actualIntegrity,
  });
  const releaseNotes = extractReleaseNotes(changelog, version);
  return {
    packageMetadata,
    provenance,
    lockMetadata,
    version,
    releaseNotes,
  };
}

async function npmPack(destination, root = repositoryRoot) {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", destination],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const result = json(stdout, "npm pack output");
  if (!Array.isArray(result) || result.length !== 1 || !result[0]?.filename) {
    fail("npm pack did not return exactly one artifact");
  }
  return join(destination, result[0].filename);
}

async function assertEmptyOutputDirectory(root, outputDirectory) {
  const relativePath = relative(root, outputDirectory);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    fail("release output directory must be inside the repository");
  }
  await mkdir(outputDirectory, { recursive: true });
  if ((await readdir(outputDirectory)).length !== 0) {
    fail(`release output directory is not empty: ${relativePath}`);
  }
}

export async function buildReleaseArtifacts({
  tag,
  outputDirectory,
  root = repositoryRoot,
  environment = process.env,
}) {
  const inputs = await readReleaseInputs(tag, root);
  const sourceCommit = await validateAnnotatedTag(tag, root, environment);
  const output = resolve(root, outputDirectory);
  await assertEmptyOutputDirectory(root, output);

  const firstPackDirectory = await mkdtemp(join(tmpdir(), "nelos-release-pack-a-"));
  const secondPackDirectory = await mkdtemp(join(tmpdir(), "nelos-release-pack-b-"));
  try {
    const [firstPackage, secondPackage] = await Promise.all([
      npmPack(firstPackDirectory, root),
      npmPack(secondPackDirectory, root),
    ]);
    const [firstDigest, secondDigest] = await Promise.all([
      sha256(firstPackage),
      sha256(secondPackage),
    ]);
    if (
      basename(firstPackage) !== basename(secondPackage) ||
      firstDigest !== secondDigest
    ) {
      fail("two clean npm pack runs produced different artifacts");
    }

    const packagePath = join(output, basename(firstPackage));
    const provenancePath = join(output, "distribution-provenance.json");
    const sbomPath = join(output, "sbom.cdx.json");
    const notesPath = join(output, "release-notes.md");
    await Promise.all([
      copyFile(firstPackage, packagePath),
      copyFile(
        join(root, "distribution-provenance.json"),
        provenancePath,
      ),
      writeFile(
        sbomPath,
        `${JSON.stringify(
          buildCycloneDxBom({
            packageMetadata: inputs.packageMetadata,
            lockMetadata: inputs.lockMetadata,
            sourceCommit,
          }),
          null,
          2,
        )}\n`,
      ),
      writeFile(notesPath, inputs.releaseNotes),
    ]);

    const artifactPaths = [packagePath, provenancePath, sbomPath, notesPath];
    const artifactRecords = await Promise.all(
      artifactPaths.map(async (path) => ({
        name: basename(path),
        sha256: await sha256(path),
        bytes: (await stat(path)).size,
      })),
    );
    artifactRecords.sort((left, right) => left.name.localeCompare(right.name));
    const manifestPath = join(output, "release-manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: inputs.packageMetadata.name,
          version: inputs.version,
          tag,
          sourceCommit,
          distributionIntegrity: inputs.provenance.integrity,
          artifacts: artifactRecords,
        },
        null,
        2,
      )}\n`,
    );

    const checksumPaths = [...artifactPaths, manifestPath];
    const checksumLines = await Promise.all(
      checksumPaths
        .sort((left, right) => basename(left).localeCompare(basename(right)))
        .map(async (path) => {
          const digest = (await sha256(path)).slice("sha256:".length);
          return `${digest}  ${basename(path)}`;
        }),
    );
    await writeFile(join(output, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
    return {
      version: inputs.version,
      tag,
      sourceCommit,
      packageDigest: firstDigest,
      outputDirectory: output,
    };
  } finally {
    await Promise.all([
      rm(firstPackDirectory, { recursive: true, force: true }),
      rm(secondPackDirectory, { recursive: true, force: true }),
    ]);
  }
}

function parseArguments(argumentsList) {
  const options = { validateOnly: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--validate-only") {
      options.validateOnly = true;
      continue;
    }
    if (argument !== "--tag" && argument !== "--out-dir") {
      fail(`unknown argument: ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (!value) fail(`${argument} requires a value`);
    if (argument === "--tag") options.tag = value;
    else options.outputDirectory = value;
    index += 1;
  }
  if (!options.tag) fail("--tag is required");
  if (!options.validateOnly && !options.outputDirectory) {
    fail("--out-dir is required unless --validate-only is used");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.validateOnly) {
    const inputs = await readReleaseInputs(options.tag);
    const sourceCommit = await validateAnnotatedTag(options.tag);
    process.stdout.write(
      `${JSON.stringify({
        valid: true,
        version: inputs.version,
        tag: options.tag,
        sourceCommit,
      })}\n`,
    );
    return;
  }
  const result = await buildReleaseArtifacts({
    tag: options.tag,
    outputDirectory: options.outputDirectory,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`build-release-artifacts: ${error.message}\n`);
    process.exitCode = 1;
  });
}
