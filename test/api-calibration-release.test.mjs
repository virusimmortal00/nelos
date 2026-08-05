import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { reviseTask, sha256Bytes } from "../src/experimentation-contract/index.mjs";
import { createStarterDevelopmentRelease, createTaskPackage } from "../src/experimentation-corpus/index.mjs";
import { validatePluginReleaseChange } from "../scripts/validate-plugin-release.mjs";
import {
  COMMITTED_ARTIFACT_ROOT,
  REPOSITORY_ROOT,
  buildCalibrationRelease,
  loadPrivateMaterial,
  publicProjectionFiles,
  resolvePrivateRoot,
} from "../experiments/api-baseline/calibration-tranche-1/build-release.mjs";
import {
  CALIBRATION_CONCEPTS,
  CALIBRATION_REQUIREMENT_DIGEST,
  createCalibrationTrancheRelease,
} from "../experiments/api-baseline/calibration-tranche-1/lib/release.mjs";

const executeFile = promisify(execFile);

function privatePackages() {
  return createStarterDevelopmentRelease().packages.map((original, index) => {
    const text = `Synthetic private fixture ${CALIBRATION_CONCEPTS[index].key}`;
    const task = reviseTask(original.task, {
      prompt: { ...original.task.prompt, text, digest: sha256Bytes(Buffer.from(text, "utf8")) },
      determinism: { ...original.task.determinism, seed: 9100 + index },
      visibility: "private",
    });
    return createTaskPackage({
      task,
      graderBundle: original.graderBundle,
      assets: original.assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes, "base64") })),
    });
  });
}

async function writePrivateRoot(root, packages = privatePackages()) {
  await mkdir(resolve(root, "packages"), { recursive: true });
  const concepts = CALIBRATION_CONCEPTS.map((concept, index) => ({
    ...concept,
    taskId: packages[index].task.taskId,
    packageDigest: packages[index].digest,
  }));
  await writeFile(resolve(root, "private-manifest.json"), JSON.stringify({ schemaVersion: 1, concepts }));
  await Promise.all(packages.map((taskPackage) => writeFile(resolve(root, "packages", `${taskPackage.task.taskId.slice(5)}.json`), JSON.stringify(taskPackage))));
  return { concepts, packages };
}

test("public study artifacts preserve the approved immutable release and inert schedule", async () => {
  const lock = JSON.parse(await readFile(resolve(COMMITTED_ARTIFACT_ROOT, "release-lock.json"), "utf8"));
  const schedule = JSON.parse(await readFile(resolve(COMMITTED_ARTIFACT_ROOT, "schedule.json"), "utf8"));
  const independence = JSON.parse(await readFile(resolve(COMMITTED_ARTIFACT_ROOT, "independence-summary.json"), "utf8"));
  assert.equal(lock.requirementDigest, CALIBRATION_REQUIREMENT_DIGEST);
  assert.deepEqual(lock.predecessor, { version: "1.0.0", releaseId: "corpus:355bf16738a0d874d3c265d85bc148ad9d61fd3ca1e852c36b3a60c7feb8cf7f", digest: "sha256:64fbee81daaea1c0869cf54f8ef7f36c76d2c7af62ec85995112328f2ad13a89" });
  assert.equal(lock.release.version, "1.1.0");
  assert.equal(lock.release.revision, 2);
  assert.equal(lock.release.state, "published");
  assert.deepEqual(lock.concepts.map(({ key, stratum }) => ({ key, stratum })), CALIBRATION_CONCEPTS);
  assert.equal(new Set(lock.concepts.map(({ taskId }) => taskId)).size, 10);
  assert.equal(independence.comparisonCount, 105);
  assert.equal(independence.pairs.length, 105);
  assert.equal(schedule.executable, false);
  assert.equal(schedule.status, "prepared-unauthorized");
  assert.equal(schedule.trialCount, 20);
  assert.equal(schedule.maxConcurrency, 1);
  assert.equal(schedule.maxAttempts, 1);
  assert.equal(schedule.providerRetriesPerTrial, 0);
  assert.equal(schedule.maxEstimatedCostUsd, 3.75);
  assert.equal(schedule.authorization.confirmatoryNoGoPreserved, true);
  assert.equal(schedule.authorization.freshExactUserAuthorizationRequiredBeforeAnyTrancheCall, true);
  assert.equal(schedule.authorization.providerCallsMadeDuringConstruction, 0);
  assert.equal(schedule.authorization.credentialAccessesDuringConstruction, 0);
  const blocks = Array.from({ length: 10 }, (_, index) => schedule.trials.slice(index * 2, index * 2 + 2));
  assert.deepEqual(blocks.map(([trial]) => trial.taskId), blocks.map(([trial]) => trial.taskId).toSorted());
  assert.equal(blocks.filter(([first]) => first.arm.endsWith("-a")).length, 5);
  assert.equal(blocks.filter(([first]) => first.arm.endsWith("-b")).length, 5);
});

test("public projections reproduce deterministically from external private packages", async () => {
  const privateRoot = await mkdtemp(resolve(tmpdir(), "nelos-calibration-private-"));
  await writePrivateRoot(privateRoot);
  const first = await buildCalibrationRelease({ privateRoot });
  const second = createCalibrationTrancheRelease(await loadPrivateMaterial(privateRoot));
  const left = publicProjectionFiles(first.tranche);
  const right = publicProjectionFiles(second);
  assert.deepEqual([...left.keys()], [...right.keys()]);
  for (const [path, bytes] of left) assert.equal(bytes.equals(right.get(path)), true, path);
  assert.equal(first.tranche.packages.length, 10);
  assert.equal(first.tranche.semanticIndependence.comparisonCount, 105);
  assert.equal(first.tranche.schedule.trialCount, 20);
});

test("private material overlap, root symlinks, and package-directory symlinks fail closed", async () => {
  await assert.rejects(() => resolvePrivateRoot(REPOSITORY_ROOT), { code: "PRIVATE_ROOT_OVERLAPS_REPOSITORY" });
  const realRoot = await mkdtemp(resolve(tmpdir(), "nelos-calibration-real-"));
  await writePrivateRoot(realRoot);
  const linkRoot = `${realRoot}-link`;
  await symlink(realRoot, linkRoot, "dir");
  await assert.rejects(() => resolvePrivateRoot(linkRoot), { code: "UNSAFE_PRIVATE_ROOT" });

  const unsafeRoot = await mkdtemp(resolve(tmpdir(), "nelos-calibration-unsafe-"));
  const material = await loadPrivateMaterial(realRoot);
  await writeFile(resolve(unsafeRoot, "private-manifest.json"), JSON.stringify({ schemaVersion: 1, concepts: material.concepts.map((concept, index) => ({ ...concept, taskId: material.packages[index].task.taskId, packageDigest: material.packages[index].digest })) }));
  await symlink(resolve(realRoot, "packages"), resolve(unsafeRoot, "packages"), "dir");
  await assert.rejects(() => loadPrivateMaterial(unsafeRoot), { code: "UNSAFE_PRIVATE_PACKAGES" });
});

test("tracked public projections contain no complete package or hidden grading material", async () => {
  const paths = (await readdir(COMMITTED_ARTIFACT_ROOT)).filter((path) => path.endsWith(".json"));
  assert.deepEqual(paths.sort(), ["contamination-summary.json", "independence-summary.json", "release-lock.json", "schedule.json", "validation-summary.json"]);
  for (const path of paths) {
    const text = await readFile(resolve(COMMITTED_ARTIFACT_ROOT, path), "utf8");
    assert.doesNotMatch(text, /"(?:assets|bytes|graderBundle|implementationDigest|oracle|rubric)"\s*:/u, path);
    assert.doesNotMatch(text, /"encoding"\s*:\s*"base64"/u, path);
  }
  const tracked = (await executeFile("git", ["ls-files"], { cwd: REPOSITORY_ROOT })).stdout.split("\n");
  assert.equal(tracked.some((path) => /calibration-tranche-1\/(?:packages|candidate-envelopes|private-material)\//u.test(path)), false);
});

test("npm/plugin payload excludes the study and the 0.12.9 release invariant remains strict", async () => {
  const packageMetadata = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "package.json"), "utf8"));
  const plugin = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, ".codex-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, ".mcp.json"), "utf8"));
  assert.equal(packageMetadata.version, "0.12.9");
  assert.equal(plugin.version, "0.12.9");
  assert.equal(plugin.releaseBuildIdentity, "nelos-release-v1:0.12.9");
  assert.equal(mcp.mcpServers.nelos.env.NELOS_PLUGIN_VERSION, "0.12.9");
  assert.equal(packageMetadata.files.some((path) => path.startsWith("experiments")), false);
  assert.equal(packageMetadata.scripts["calibration:build"], undefined);
  const packed = JSON.parse((await executeFile("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPOSITORY_ROOT })).stdout)[0];
  assert.equal(packed.files.some(({ path }) => path.startsWith("experiments/")), false);
  assert.equal(packed.files.some(({ path }) => path.includes("calibration-tranche-1")), false);
  assert.deepEqual(validatePluginReleaseChange({ baseVersion: "0.12.9", candidateVersion: "0.12.9", baseCacheIdentity: "same", candidateCacheIdentity: "same", payloadChanged: false }), { changed: false, version: "0.12.9", cacheIdentity: "same" });
  assert.throws(() => validatePluginReleaseChange({ baseVersion: "0.12.9", candidateVersion: "0.12.9", baseCacheIdentity: "same", candidateCacheIdentity: "same", payloadChanged: true }), /without a version bump/u);
});
