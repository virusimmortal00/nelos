import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  assertPackedDistributionInventory,
  buildReleaseArtifacts,
} from "../scripts/build-release-artifacts.mjs";
import { stageProductionDesktopCandidate } from "../scripts/stage-production-desktop-candidate.mjs";
import {
  MANAGED_CLI_BINS,
  computeDistributionIntegrity,
  listDistributionFiles,
} from "../src/distribution-provenance.mjs";
import { SEALED_SOURCE_PATHS_V1 } from "../validation/proxmox-desktop/v1/build-golden-image.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function git(root, ...argumentsList) {
  return execFileAsync("/usr/bin/git", ["-C", root, ...argumentsList], {
    encoding: "utf8",
    env: {
      HOME: "/var/empty",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
}

async function createCleanFixture(root) {
  await cp(repositoryRoot, root, {
    recursive: true,
    filter(source) {
      const name = basename(source);
      return ![".git", "node_modules", "dist"].includes(name) &&
        !name.startsWith(".nelos-worktree-launch-");
    },
  });
  const provenancePath = join(root, "distribution-provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.integrity = await computeDistributionIntegrity(root);
  delete provenance.sourceRevision;
  delete provenance.sourceRevisionType;
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Nelos Candidate Test");
  await git(root, "config", "user.email", "candidate@example.invalid");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "candidate fixture");
  return (await git(root, "rev-parse", "HEAD")).stdout.trim();
}

async function resolvePackExecutable() {
  for (const command of ["pnpm", "npm"]) {
    try {
      await execFileAsync(command, ["--version"], { encoding: "utf8" });
      return command;
    } catch {
      // Try the next locally installed package manager. Both implement pack.
    }
  }
  throw new Error("neither pnpm nor npm is available for the package test");
}

function parsePackResult(stdout) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

async function pack(command, root, destination, { dryRun = false } = {}) {
  const argumentsList = ["pack"];
  if (dryRun) argumentsList.push("--dry-run");
  if (destination) argumentsList.push("--pack-destination", destination);
  argumentsList.push("--json");
  const { stdout } = await execFileAsync(command, argumentsList, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePackResult(stdout);
}

async function probeInstalledCandidate(root, digest) {
  const moduleUrl = pathToFileURL(join(root, "src", "proxmox-desktop-runtime.mjs")).href;
  const source = `
    const module = await import(${JSON.stringify(moduleUrl)});
    try {
      const result = await module.verifyInstalledNelosCandidateV1(${JSON.stringify(digest)});
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    source,
  ], { cwd: tmpdir(), encoding: "utf8" });
  return JSON.parse(stdout);
}

async function treeDigest(root, files) {
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function importFromNodeStdin(moduleUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-"], {
      cwd: tmpdir(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => {
      if (status === 0) resolve({ stdout, stderr });
      else reject(new Error(`stdin import exited ${status}: ${stderr}`));
    });
    child.stdin.end(`await import(${JSON.stringify(moduleUrl)}); process.stdout.write("imported\\n");\n`);
  });
}

test("candidate staging module is inert when imported from stdin or eval", async () => {
  const moduleUrl = pathToFileURL(
    join(repositoryRoot, "scripts", "stage-production-desktop-candidate.mjs"),
  ).href;
  const stdin = await importFromNodeStdin(moduleUrl);
  assert.equal(stdin.stdout, "imported\n");
  assert.equal(stdin.stderr, "");
  const evaluated = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(`${moduleUrl}?eval-import=1`)}); process.stdout.write("imported\\n");`,
  ], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(evaluated.stdout, "imported\n");
  assert.equal(evaluated.stderr, "");
});

test("published Desktop operator commands name their script interpreters", async () => {
  const paths = [
    join(repositoryRoot, "docs", "proxmox-desktop-lease-authority.md"),
    join(repositoryRoot, "validation", "proxmox-desktop", "v1", "README.md"),
  ];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(
      source,
      /^(?:sudo\s+)?(?:\.\/)?validation\/\S+\.(?:mjs|py|sh)(?:\s|\\|$)/mu,
      path,
    );
    assert.doesNotMatch(
      source,
      /^\s*"\$SOURCE_ROOT\/validation\/\S+\.(?:mjs|py|sh)"(?:\s|$)/mu,
      path,
    );
  }
});

test("clean Git candidate staging is external, deterministic, atomic, and package-complete", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "nelos-production-candidate-package-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await chmod(temporaryRoot, 0o700);
  const fixtureRoot = join(temporaryRoot, "source");
  const outputParent = join(temporaryRoot, "outputs");
  await mkdir(outputParent, { mode: 0o700 });
  const sourceRevision = await createCleanFixture(fixtureRoot);
  const packageMetadata = JSON.parse(await readFile(join(fixtureRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(fixtureRoot, "package-lock.json"), "utf8"));
  assert.deepEqual(packageMetadata.bin, MANAGED_CLI_BINS);
  assert.deepEqual(packageLock.packages[""].bin, MANAGED_CLI_BINS);
  const tag = `v${packageMetadata.version}`;
  await git(fixtureRoot, "tag", "-a", tag, "-m", `Nelos ${packageMetadata.version}`);
  const firstRoot = join(outputParent, "candidate-a");
  const secondRoot = join(outputParent, "candidate-b");

  const first = await stageProductionDesktopCandidate({
    outputDirectory: firstRoot,
    root: fixtureRoot,
  });
  const second = await stageProductionDesktopCandidate({
    outputDirectory: secondRoot,
    root: fixtureRoot,
    environment: {
      ...process.env,
      GIT_DIR: "/attacker-controlled/git-dir",
      GIT_WORK_TREE: "/",
      GIT_OBJECT_DIRECTORY: "/attacker-controlled/objects",
      PATH: "/attacker-controlled/bin",
    },
  });
  assert.equal(first.sourceRevision, sourceRevision);
  assert.equal(first.sourceRevisionType, "git");
  assert.equal(first.candidateDigest, second.candidateDigest);
  assert.equal(first.candidateDigest, await computeDistributionIntegrity(firstRoot));
  assert.equal(second.candidateDigest, await computeDistributionIntegrity(secondRoot));
  const firstFiles = await listDistributionFiles(firstRoot, { includeProvenance: true });
  const secondFiles = await listDistributionFiles(secondRoot, { includeProvenance: true });
  assert.deepEqual(firstFiles, secondFiles);
  assert.equal(await treeDigest(firstRoot, firstFiles), await treeDigest(secondRoot, secondFiles));
  const provenance = JSON.parse(await readFile(first.provenancePath, "utf8"));
  assert.equal(provenance.sourceRevision, sourceRevision);
  assert.equal(provenance.sourceRevisionType, "git");
  assert.equal(provenance.integrity, first.candidateDigest);
  assert.equal((await lstat(first.provenancePath)).mode & 0o777, 0o444);
  assert.equal((await git(fixtureRoot, "status", "--porcelain")).stdout, "");

  const concurrentRoot = join(outputParent, "candidate-concurrent");
  const concurrent = await Promise.allSettled([
    stageProductionDesktopCandidate({ outputDirectory: concurrentRoot, root: fixtureRoot }),
    stageProductionDesktopCandidate({ outputDirectory: concurrentRoot, root: fixtureRoot }),
  ]);
  assert.deepEqual(concurrent.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  assert.equal(await computeDistributionIntegrity(concurrentRoot), first.candidateDigest);
  assert.equal((await stat(concurrentRoot)).dev, (await stat(outputParent)).dev);
  assert.deepEqual(
    (await (await import("node:fs/promises")).readdir(outputParent))
      .filter((name) => name.includes("nelos-stage")),
    [],
  );

  const existingRoot = join(outputParent, "candidate-existing");
  const existingMarker = join(existingRoot, "owner-marker");
  await mkdir(existingRoot, { mode: 0o700 });
  await writeFile(existingMarker, "must survive\n", { mode: 0o600 });
  await assert.rejects(
    stageProductionDesktopCandidate({ outputDirectory: existingRoot, root: fixtureRoot }),
    /output must not already exist/u,
  );
  assert.equal(await readFile(existingMarker, "utf8"), "must survive\n");

  const publicParent = join(temporaryRoot, "public-output");
  await mkdir(publicParent, { mode: 0o755 });
  await assert.rejects(
    stageProductionDesktopCandidate({
      outputDirectory: join(publicParent, "candidate"),
      root: fixtureRoot,
    }),
    /caller-owned with exact mode 0700/u,
  );

  const packExecutable = await resolvePackExecutable();
  const dryRun = await pack(packExecutable, firstRoot, null, { dryRun: true });
  assertPackedDistributionInventory(dryRun, firstFiles);
  const requiredDesktopFiles = [
    "bin/nelos-desktop-runner",
    "bin/nelos-prepare-production-run",
    "bin/nelos-prepare-production-task",
    "bin/nelos-proxmox-transport",
    "bin/nelos-proxmox-attest-transport",
    "bin/nelos-observe-current-lease",
    "bin/nelos-volume-attestor-host-installer",
    "src/homelab-desktop-runtime.mjs",
    "src/proxmox-desktop-runtime.mjs",
    "src/production-task-surface-observer.mjs",
    "src/production-archive-surface-observer.mjs",
    "validation/proxmox-desktop/v1/build-golden-image.mjs",
    "validation/proxmox-desktop/v1/prepare-production-run.mjs",
    "validation/proxmox/desktop/helpers/nelos-desktop-identity.py",
    "validation/proxmox/desktop/helpers/nelos-proxmox-host-helper.py",
    "validation/proxmox/desktop/helpers/nelos-proxmox-attest.py",
    "validation/proxmox/desktop/helpers/nelos-proxmox-run-binding.py",
  ];
  const packedPaths = new Set(dryRun.files.map(({ path }) => path));
  for (const path of requiredDesktopFiles) assert.equal(packedPaths.has(path), true, path);
  for (const path of SEALED_SOURCE_PATHS_V1) {
    assert.equal(packedPaths.has(path), true, `golden-image source ${path}`);
  }
  const missingHelper = {
    ...dryRun,
    files: dryRun.files.filter(({ path }) => path !== requiredDesktopFiles.at(-1)),
  };
  assert.throws(
    () => assertPackedDistributionInventory(missingHelper, firstFiles),
    /missing=validation\/proxmox\/desktop\/helpers\/nelos-proxmox-run-binding\.py/u,
  );

  const extractDirectory = join(temporaryRoot, "extract");
  await mkdir(extractDirectory, { mode: 0o700 });
  const releaseOutput = join(fixtureRoot, "dist", "release");
  const release = await buildReleaseArtifacts({
    tag,
    outputDirectory: releaseOutput,
    root: fixtureRoot,
    environment: {},
    packExecutable,
  });
  assert.equal(release.sourceCommit, sourceRevision);
  const archivePath = join(releaseOutput, `nelos-${packageMetadata.version}.tgz`);
  await execFileAsync("/usr/bin/tar", ["-xzf", archivePath, "-C", extractDirectory]);
  const installedRoot = join(extractDirectory, "package");
  const releaseProvenance = JSON.parse(
    await readFile(join(releaseOutput, "distribution-provenance.json"), "utf8"),
  );
  assert.equal(
    await computeDistributionIntegrity(installedRoot),
    releaseProvenance.integrity,
  );
  assert.equal(releaseProvenance.sourceRevision, sourceRevision);
  assert.equal(releaseProvenance.sourceRevisionType, "git");
  const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  assert.deepEqual(installedPackage.bin, MANAGED_CLI_BINS);
  for (const path of Object.values(MANAGED_CLI_BINS)) {
    await access(join(installedRoot, path), constants.X_OK);
  }
  const probe = await probeInstalledCandidate(installedRoot, releaseProvenance.integrity);
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.result.candidateDigest, releaseProvenance.integrity);
  assert.equal(probe.result.sourceCommit, sourceRevision);
  await assert.rejects(
    execFileAsync(process.execPath, [join(installedRoot, "bin", "nelos-desktop-runner")], {
      cwd: tmpdir(),
      encoding: "utf8",
    }),
    (error) => error.code === 2 && /usage: nelos-desktop-runner/u.test(error.stderr),
  );

  await appendFile(
    join(installedRoot, "validation", "proxmox", "desktop", "helpers", "nelos-proxmox-attest.py"),
    "\n# tampered after installation\n",
  );
  const tampered = await probeInstalledCandidate(installedRoot, releaseProvenance.integrity);
  assert.deepEqual(
    { ok: tampered.ok, code: tampered.code },
    { ok: false, code: "CANDIDATE_INTEGRITY_MISMATCH" },
  );

  await appendFile(join(fixtureRoot, "README.md"), "\ndirty candidate\n");
  const dirtyOutput = join(outputParent, "candidate-dirty");
  await assert.rejects(
    stageProductionDesktopCandidate({ outputDirectory: dirtyOutput, root: fixtureRoot }),
    /completely clean Git worktree/u,
  );
  await assert.rejects(access(dirtyOutput, constants.F_OK), { code: "ENOENT" });
});
