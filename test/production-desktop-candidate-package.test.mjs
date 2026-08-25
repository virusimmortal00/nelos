import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { stageProductionDesktopCandidate } from "../scripts/stage-production-desktop-candidate.mjs";
import { computeDistributionIntegrity, listDistributionFiles } from "../src/distribution-provenance.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function git(root, ...args) {
  return execFileAsync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8", env: { HOME: "/var/empty", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" } });
}

async function cleanFixture(root) {
  await cp(repositoryRoot, root, { recursive: true, filter(source) { return ![".git", "node_modules", "dist"].includes(basename(source)); } });
  const provenancePath = join(root, "distribution-provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.integrity = await computeDistributionIntegrity(root);
  delete provenance.sourceRevision; delete provenance.sourceRevisionType;
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await git(root, "init", "-b", "main"); await git(root, "config", "user.name", "Nelos Test"); await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "add", "."); await git(root, "commit", "-m", "fixture");
  return (await git(root, "rev-parse", "HEAD")).stdout.trim();
}

test("candidate staging produces an immutable external package for the minimal Desktop lane", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "nelos-desktop-candidate-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await chmod(temporary, 0o700);
  const source = join(temporary, "source"); const outputs = join(temporary, "outputs");
  await mkdir(outputs, { mode: 0o700 });
  const revision = await cleanFixture(source);
  const staged = await stageProductionDesktopCandidate({ root: source, outputDirectory: join(outputs, "candidate") });
  assert.equal(staged.sourceRevision, revision);
  assert.equal(staged.candidateDigest, await computeDistributionIntegrity(staged.packageRoot));
  const provenance = JSON.parse(await readFile(staged.provenancePath, "utf8"));
  assert.equal(provenance.sourceRevision, revision);
  assert.equal(provenance.integrity, staged.candidateDigest);
  const files = new Set(await listDistributionFiles(staged.packageRoot, { includeProvenance: true }));
  for (const required of ["bin/nelos", "src/disposable-desktop-smoke.mjs", "src/desktop-smoke-contract.mjs", "validation/desktop-smoke/scenario-sets/release.json"]) assert.equal(files.has(required), true, required);
  assert.equal([...files].some((path) => path.includes("golden-builder") || path.includes("proxmox-desktop")), false);
  assert.equal((await git(source, "status", "--porcelain")).stdout, "");
});

test("candidate staging refuses dirty sources and existing output ownership", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "nelos-desktop-candidate-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await chmod(temporary, 0o700);
  const source = join(temporary, "source"); const outputs = join(temporary, "outputs");
  await mkdir(outputs, { mode: 0o700 }); await cleanFixture(source);
  await writeFile(join(source, "dirty-marker"), "dirty\n");
  await assert.rejects(stageProductionDesktopCandidate({ root: source, outputDirectory: join(outputs, "candidate") }), /completely clean/u);
  await rm(join(source, "dirty-marker"));
  await mkdir(join(outputs, "owned"), { mode: 0o700 });
  await assert.rejects(stageProductionDesktopCandidate({ root: source, outputDirectory: join(outputs, "owned") }), /must not already exist/u);
});
