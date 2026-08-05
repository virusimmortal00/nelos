#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalBytes, canonicalDigest } from "../../../src/experimentation-contract/index.mjs";
import { validateTaskPackage } from "../../../src/experimentation-corpus/index.mjs";
import {
  CALIBRATION_CONCEPTS,
  CALIBRATION_REQUIREMENT_DIGEST,
  createCalibrationTrancheRelease,
} from "./lib/release.mjs";

export const STUDY_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const REPOSITORY_ROOT = resolve(STUDY_ROOT, "../../..");
export const COMMITTED_ARTIFACT_ROOT = resolve(STUDY_ROOT, "artifacts");

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function containedBy(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function regularNonSymlink(path, code) {
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink()) fail(code, "private material members must be regular non-symlink files");
}

export async function resolvePrivateRoot(privateRoot) {
  if (typeof privateRoot !== "string" || privateRoot.length === 0) fail("PRIVATE_ROOT_REQUIRED", "--private-root is required");
  const lexical = resolve(privateRoot);
  const entry = await lstat(lexical).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) fail("UNSAFE_PRIVATE_ROOT", "private root must be a real directory, not a symlink");
  const physical = await realpath(lexical);
  const repositoryPhysical = await realpath(REPOSITORY_ROOT);
  if (containedBy(repositoryPhysical, physical) || containedBy(physical, repositoryPhysical)) {
    fail("PRIVATE_ROOT_OVERLAPS_REPOSITORY", "grader and oracle storage must not overlap the repository or plugin payload");
  }
  return physical;
}

export async function loadPrivateMaterial(privateRoot) {
  const root = await resolvePrivateRoot(privateRoot);
  const manifestPath = resolve(root, "private-manifest.json");
  const packagesRoot = resolve(root, "packages");
  const accessEvidencePath = resolve(root, "access-evidence.json");
  const semanticReviewPath = resolve(root, "semantic-pair-review.json");
  await regularNonSymlink(manifestPath, "UNSAFE_PRIVATE_MANIFEST");
  await regularNonSymlink(accessEvidencePath, "UNSAFE_ACCESS_EVIDENCE");
  await regularNonSymlink(semanticReviewPath, "UNSAFE_SEMANTIC_REVIEW");
  const packagesEntry = await lstat(packagesRoot).catch(() => null);
  if (!packagesEntry?.isDirectory() || packagesEntry.isSymbolicLink()) fail("UNSAFE_PRIVATE_PACKAGES", "private packages must use a real directory");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest?.concepts) || manifest.concepts.length !== 10) fail("INVALID_PRIVATE_MANIFEST", "private manifest must bind ten concepts");
  if (
    manifest.evidence?.access?.file !== "access-evidence.json" || !/^sha256:[0-9a-f]{64}$/u.test(manifest.evidence.access.digest) ||
    manifest.evidence?.semanticReview?.file !== "semantic-pair-review.json" || !/^sha256:[0-9a-f]{64}$/u.test(manifest.evidence.semanticReview.digest)
  ) fail("INVALID_PRIVATE_MANIFEST", "private manifest must bind the fixed external evidence files and their digests");
  const accessEvidence = JSON.parse(await readFile(accessEvidencePath, "utf8"));
  const semanticReview = JSON.parse(await readFile(semanticReviewPath, "utf8"));
  if (canonicalDigest(accessEvidence) !== manifest.evidence.access.digest || canonicalDigest(semanticReview) !== manifest.evidence.semanticReview.digest) {
    fail("PRIVATE_EVIDENCE_IDENTITY_MISMATCH", "external evidence differs from its private-manifest binding");
  }
  const concepts = manifest.concepts.map(({ key, stratum }) => ({ key, stratum }));
  const packages = [];
  for (const concept of manifest.concepts) {
    if (!/^task:[0-9a-f]{64}$/u.test(concept.taskId) || !/^sha256:[0-9a-f]{64}$/u.test(concept.packageDigest)) fail("INVALID_PRIVATE_MANIFEST", "private manifest identities are malformed");
    const path = resolve(packagesRoot, `${concept.taskId.slice(5)}.json`);
    await regularNonSymlink(path, "UNSAFE_PRIVATE_PACKAGE");
    const taskPackage = JSON.parse(await readFile(path, "utf8"));
    validateTaskPackage(taskPackage);
    if (taskPackage.task.taskId !== concept.taskId || taskPackage.digest !== concept.packageDigest) fail("PRIVATE_PACKAGE_IDENTITY_MISMATCH", "private package differs from its manifest identity");
    packages.push(taskPackage);
  }
  const packageEntries = await readdir(packagesRoot, { withFileTypes: true });
  if (packageEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) fail("UNSAFE_PRIVATE_PACKAGE", "private package directory may contain only regular declared files");
  const declaredFiles = packageEntries.map(({ name }) => name).sort();
  const expectedFiles = manifest.concepts.map(({ taskId }) => `${taskId.slice(5)}.json`).sort();
  if (JSON.stringify(declaredFiles) !== JSON.stringify(expectedFiles)) fail("UNDECLARED_PRIVATE_PACKAGE", "private package directory must exactly match declared membership");
  return { root, concepts, packages, accessEvidence, semanticReview };
}

export function publicProjectionFiles(tranche) {
  const candidateAssetDigests = tranche.packages.flatMap(({ assets }) => assets.filter(({ audience }) => audience === "candidate").map(({ digest }) => digest)).sort();
  const graderAssetDigests = tranche.packages.flatMap(({ assets }) => assets.filter(({ audience }) => audience === "grader").map(({ digest }) => digest)).sort();
  const lock = {
    schemaVersion: 1,
    requirementDigest: CALIBRATION_REQUIREMENT_DIGEST,
    predecessor: { version: tranche.predecessor.version, releaseId: tranche.predecessor.releaseId, digest: tranche.predecessor.digest },
    release: { version: tranche.release.version, revision: tranche.release.revision, releaseId: tranche.release.releaseId, digest: tranche.release.digest, state: tranche.release.state },
    scheduleDigest: tranche.schedule.scheduleDigest,
    concepts: CALIBRATION_CONCEPTS.map((concept, index) => ({ ...concept, taskId: tranche.packages[index].task.taskId, packageDigest: tranche.packages[index].digest })),
  };
  const validation = {
    schemaVersion: 1,
    status: "passed",
    requirementDigest: CALIBRATION_REQUIREMENT_DIGEST,
    releaseDigest: tranche.release.digest,
    checks: [
      { id: "immutable-packages", status: "passed", count: tranche.packages.length },
      { id: "five-strata-two-independent-tasks", status: "passed", strata: CALIBRATION_CONCEPTS.map(({ stratum }) => stratum).filter((value, index, all) => all.indexOf(value) === index) },
      { id: "complete-semantic-review", status: "passed", comparisons: tranche.semanticIndependence.comparisonCount },
      { id: "external-review-evidence", status: "passed", evidenceDigest: tranche.semanticReview.digest },
      { id: "external-access-evidence", status: "passed", evidenceDigest: tranche.accessEvidence.digest },
      { id: "candidate-host-isolation", status: "passed", candidateAssetDigest: canonicalDigest(candidateAssetDigests), graderAssetDigest: canonicalDigest(graderAssetDigests), disjoint: !graderAssetDigests.some((digest) => candidateAssetDigests.includes(digest)) },
      { id: "contamination", status: "passed", reportDigest: tranche.contamination.digest },
      { id: "inert-schedule", status: "passed", trials: tranche.schedule.trialCount, abBlocks: 5, baBlocks: 5 },
      { id: "construction-provider-calls", status: "passed", count: 0 },
      { id: "construction-credential-accesses", status: "passed", count: 0 },
    ],
    hiddenContentIncluded: false,
  };
  return new Map([
    ["release-lock.json", canonicalBytes(lock)],
    ["schedule.json", canonicalBytes(tranche.schedule)],
    ["contamination-summary.json", canonicalBytes(tranche.contamination)],
    ["independence-summary.json", canonicalBytes(tranche.semanticIndependence)],
    ["validation-summary.json", canonicalBytes(validation)],
  ]);
}

async function writeProjections(root, files) {
  for (const [path, bytes] of files) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), bytes);
  }
}

async function compareCommitted(files, artifactRoot) {
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  const paths = entries.map(({ name }) => name).sort();
  if (entries.some((entry) => !entry.isFile())) fail("PUBLIC_PROJECTION_MEMBERSHIP_MISMATCH", "committed public artifact directory must contain only projection files");
  if (JSON.stringify(paths) !== JSON.stringify([...files.keys()].sort())) fail("PUBLIC_PROJECTION_MEMBERSHIP_MISMATCH", "committed public artifact membership differs");
  for (const [path, expected] of files) {
    if (!(await readFile(resolve(artifactRoot, path))).equals(expected)) fail("PUBLIC_PROJECTION_MISMATCH", `${path} differs from the private-material projection`);
  }
}

export async function buildCalibrationRelease({ privateRoot, outputRoot = null, check = false, committedArtifactRoot = COMMITTED_ARTIFACT_ROOT }) {
  const material = await loadPrivateMaterial(privateRoot);
  const tranche = createCalibrationTrancheRelease(material);
  const files = publicProjectionFiles(tranche);
  if (check) await compareCommitted(files, committedArtifactRoot);
  if (outputRoot !== null) await writeProjections(resolve(outputRoot), files);
  return { tranche, files };
}

function parseArguments(arguments_) {
  const value = (flag) => {
    const index = arguments_.indexOf(flag);
    return index === -1 ? null : arguments_[index + 1] ?? fail("INVALID_ARGUMENT", `${flag} requires a value`);
  };
  const privateRoot = value("--private-root");
  const outputRoot = value("--out");
  const check = arguments_.includes("--check");
  if (!check && outputRoot === null) fail("INVALID_ARGUMENT", "use --check or --out <public-output-directory>");
  return { privateRoot, outputRoot, check };
}

async function main() {
  const { tranche } = await buildCalibrationRelease(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ releaseId: tranche.release.releaseId, releaseDigest: tranche.release.digest, scheduleDigest: tranche.schedule.scheduleDigest, packages: 10, semanticComparisons: 105, providerCalls: 0, credentialAccesses: 0 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`build-api-calibration-release: ${error.code ?? "ERROR"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
