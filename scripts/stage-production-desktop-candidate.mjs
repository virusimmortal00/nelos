#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  DISTRIBUTION_ENTRIES,
  MANAGED_CLI_BINS,
  PROVENANCE_FILENAME,
  computeDistributionIntegrity,
  listDistributionFiles,
  materializeGitDistributionProvenance,
  validateProvenance,
} from "../src/distribution-provenance.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
const SAFE_GIT_PATH = /^[A-Za-z0-9._/@:+-]+$/u;
const GIT_OBJECT = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new Error(message);
}

function safeGitEnvironment(environment) {
  // Deliberately do not inherit caller-provided Git, PATH, HOME, or config
  // variables. The argument remains explicit so tests can prove they are inert.
  return {
    HOME: "/var/empty",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

async function git(root, environment, argumentsList, { encoding = "utf8" } = {}) {
  const { stdout } = await execFileAsync(
    TRUSTED_GIT_EXECUTABLE,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      root,
      ...argumentsList,
    ],
    {
      encoding,
      env: safeGitEnvironment(environment),
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return stdout;
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function requireCanonicalDirectory(path, label) {
  const info = await pathInfo(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} must be an existing real directory`);
  }
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) fail(`${label} must be canonical and contain no symlink components`);
  return canonical;
}

async function requireTrustedGitExecutable() {
  const info = await lstat(TRUSTED_GIT_EXECUTABLE);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    (info.mode & 0o022) !== 0 ||
    (info.mode & 0o111) === 0
  ) {
    fail("trusted Git executable must be a root-owned, non-writable executable file");
  }
}

async function requireOwnedSourceRoot(path) {
  const canonical = await requireCanonicalDirectory(path, "source root");
  const info = await lstat(canonical);
  const callerUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (callerUid === null || info.uid !== callerUid || (info.mode & 0o022) !== 0) {
    fail("source root must be caller-owned and not group/world writable");
  }
  return canonical;
}

async function requirePrivateOutputParent(path) {
  const canonical = await requireCanonicalDirectory(path, "output parent");
  const info = await lstat(canonical);
  const callerUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (callerUid === null || info.uid !== callerUid || (info.mode & 0o777) !== 0o700) {
    fail("output parent must be caller-owned with exact mode 0700");
  }
  return canonical;
}

function outputIsOutsideRepository(root, output) {
  const path = relative(root, output);
  return path === ".." || path.startsWith(`..${sep}`);
}

function parseGitTree(buffer) {
  const records = buffer.toString("utf8").split("\0").filter(Boolean);
  const files = [];
  const seen = new Set();
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0) fail("Git tree output is malformed");
    const metadata = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (
      metadata.length !== 3 ||
      !["100644", "100755"].includes(metadata[0]) ||
      metadata[1] !== "blob" ||
      !GIT_OBJECT.test(metadata[2]) ||
      !SAFE_GIT_PATH.test(path) ||
      isAbsolute(path) ||
      path.split("/").includes("..") ||
      seen.has(path)
    ) {
      fail("Git tree contains an unsupported, unsafe, or duplicate distribution entry");
    }
    seen.add(path);
    files.push({ mode: metadata[0] === "100755" ? 0o755 : 0o644, object: metadata[2], path });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function identifyCleanGitSource(root, environment) {
  const [topLevel, objectFormat, sourceRevision, statusBefore] = await Promise.all([
    git(root, environment, ["rev-parse", "--show-toplevel"]),
    git(root, environment, ["rev-parse", "--show-object-format"]),
    git(root, environment, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(root, environment, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const revision = sourceRevision.trim();
  if (await realpath(topLevel.trim()) !== root) fail("source root must be the exact Git worktree root");
  if (objectFormat.trim() !== "sha1") fail("production candidate staging currently requires a SHA-1 Git repository");
  if (!GIT_OBJECT.test(revision) || statusBefore !== "") {
    fail("production candidate staging requires one full commit and a completely clean Git worktree");
  }
  const [objectType, tree, sourceRevisionAfter, statusAfter] = await Promise.all([
    git(root, environment, ["cat-file", "-t", revision]),
    git(root, environment, [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      revision,
      "--",
      ...DISTRIBUTION_ENTRIES,
      PROVENANCE_FILENAME,
    ], { encoding: null }),
    git(root, environment, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(root, environment, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (objectType.trim() !== "commit") {
    fail("source HEAD must resolve to one full immutable Git commit");
  }
  if (sourceRevisionAfter.trim() !== revision || statusAfter !== "") {
    fail("source commit or worktree changed while candidate identity was read");
  }
  const allFiles = parseGitTree(tree);
  const provenanceFiles = allFiles.filter(({ path }) => path === PROVENANCE_FILENAME);
  if (provenanceFiles.length !== 1) fail("committed distribution provenance is missing or ambiguous");
  const files = allFiles.filter(({ path }) => path !== PROVENANCE_FILENAME);
  const paths = new Set(files.map(({ path }) => path));
  for (const required of ["package.json", ...Object.values(MANAGED_CLI_BINS)]) {
    if (!paths.has(required)) fail(`committed distribution is missing ${required}`);
  }
  return {
    files,
    provenanceObject: provenanceFiles[0].object,
    sourceRevision: revision,
  };
}

async function assertGitSourceUnchanged(root, environment, expectedRevision) {
  const [sourceRevision, status] = await Promise.all([
    git(root, environment, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(root, environment, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (sourceRevision.trim() !== expectedRevision || status !== "") {
    fail("source commit or worktree changed during candidate staging");
  }
}

async function materializeCommittedFiles(root, destination, environment, files) {
  for (const file of files) {
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    const bytes = await git(root, environment, ["cat-file", "blob", file.object], { encoding: null });
    await writeFile(target, bytes, { flag: "wx", mode: file.mode });
    await chmod(target, file.mode);
  }
}

export async function stageProductionDesktopCandidate({
  outputDirectory,
  root = repositoryRoot,
  environment = process.env,
} = {}) {
  if (!isAbsolute(outputDirectory ?? "")) fail("--out-dir must be an absolute path");
  await requireTrustedGitExecutable();
  const sourceRoot = await requireOwnedSourceRoot(resolve(root));
  const output = resolve(outputDirectory);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(basename(output))) {
    fail("production candidate output basename is invalid");
  }
  if (!outputIsOutsideRepository(sourceRoot, output)) {
    fail("production candidate output must be outside the source repository");
  }
  if (await pathInfo(output)) fail("production candidate output must not already exist");
  const parent = await requirePrivateOutputParent(dirname(output));
  const source = await identifyCleanGitSource(sourceRoot, environment);
  const baseProvenanceBytes = await git(
    sourceRoot,
    environment,
    ["cat-file", "blob", source.provenanceObject],
    { encoding: null },
  );
  let baseProvenance;
  try {
    baseProvenance = validateProvenance(
      JSON.parse(baseProvenanceBytes.toString("utf8")),
      "committed distribution provenance",
    );
  } catch (error) {
    fail(`committed distribution provenance is invalid: ${error.message}`);
  }
  const lockPath = join(parent, `.${basename(output)}.nelos-stage.lock`);
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") fail("production candidate output is already being staged");
    throw error;
  }
  let temporary = null;
  let published = false;
  try {
    temporary = await mkdtemp(join(parent, `.${basename(output)}.nelos-stage-`));
    await chmod(temporary, 0o700);
    const [parentInfo, temporaryInfo] = await Promise.all([stat(parent), stat(temporary)]);
    if (parentInfo.dev !== temporaryInfo.dev) {
      fail("production candidate staging and publish paths must share one filesystem");
    }
    await materializeCommittedFiles(sourceRoot, temporary, environment, source.files);
    const integrity = await computeDistributionIntegrity(temporary);
    const provenance = materializeGitDistributionProvenance(baseProvenance, {
      sourceRevision: source.sourceRevision,
      integrity,
    });
    await writeFile(
      join(temporary, PROVENANCE_FILENAME),
      `${JSON.stringify(provenance, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
    await chmod(join(temporary, PROVENANCE_FILENAME), 0o444);
    if (await computeDistributionIntegrity(temporary) !== integrity) {
      fail("staged distribution changed while provenance was materialized");
    }
    await listDistributionFiles(temporary, { includeProvenance: true });
    await assertGitSourceUnchanged(sourceRoot, environment, source.sourceRevision);
    if (await pathInfo(output)) fail("production candidate output appeared during staging");
    await rename(temporary, output);
    published = true;
    return Object.freeze({
      schemaVersion: 1,
      packageRoot: output,
      smokeCommand: "nelos desktop-test",
      candidateDigest: integrity,
      sourceRevision: source.sourceRevision,
      sourceRevisionType: "git",
      provenancePath: join(output, PROVENANCE_FILENAME),
    });
  } finally {
    try {
      if (!published && temporary !== null) {
        await rm(temporary, { recursive: true, force: true });
      }
    } finally {
      await lockHandle.close();
      await unlink(lockPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

function parseArguments(argumentsList) {
  let outputDirectory = null;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument !== "--out-dir" || outputDirectory !== null) {
      fail(`unknown or duplicate argument: ${argument}`);
    }
    outputDirectory = argumentsList[index + 1] ?? null;
    index += 1;
  }
  if (!outputDirectory) fail("usage: stage-production-desktop-candidate --out-dir /absolute/new-directory");
  return { outputDirectory };
}

function canonicalCliJson(value) {
  const sort = (item) => Array.isArray(item)
    ? item.map(sort)
    : item !== null && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]))
      : item;
  return `${JSON.stringify(sort(value))}\n`;
}

async function main() {
  const result = await stageProductionDesktopCandidate(parseArguments(process.argv.slice(2)));
  process.stdout.write(canonicalCliJson(result));
}

async function isMainModule() {
  const entry = process.argv[1];
  if (!entry || entry === "-") return false;
  try {
    const [entryPath, modulePath] = await Promise.all([
      realpath(entry),
      realpath(fileURLToPath(import.meta.url)),
    ]);
    return entryPath === modulePath;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const isMain = await isMainModule();
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`stage-production-desktop-candidate: ${error.message}\n`);
    process.exitCode = 1;
  });
}
