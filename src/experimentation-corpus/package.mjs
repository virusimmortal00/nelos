import {
  canonicalBytes,
  canonicalDigest,
  sealRecord,
  sha256Bytes,
  validateTask,
} from "../experimentation-contract/index.mjs";
import { corpusFailure } from "./errors.mjs";

const ASSET_AUDIENCES = new Set(["candidate", "grader"]);
const PACKAGE_ID = /^package:[0-9a-f]{64}$/u;

function assertPlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    corpusFailure("INVALID_PACKAGE", "value must be an object", path);
  }
}

function packageIdentityMaterial(value) {
  return {
    schemaVersion: value.schemaVersion,
    task: value.task,
    assets: value.assets,
    graderBundle: value.graderBundle,
  };
}

export function deriveTaskPackageId(value) {
  return `package:${canonicalDigest(packageIdentityMaterial(value)).slice(7)}`;
}

export function deriveTaskPackageDigest(value) {
  const material = { ...value };
  delete material.digest;
  return canonicalDigest(material);
}

function decodeAsset(asset, index) {
  const path = `/assets/${index}`;
  assertPlainObject(asset, path);
  const fields = ["assetId", "mediaType", "audience", "encoding", "digest", "bytes"];
  if (Object.keys(asset).sort().join() !== fields.sort().join()) {
    corpusFailure("INVALID_PACKAGE", "asset fields must match the closed schema", path);
  }
  if (typeof asset.assetId !== "string" || !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u.test(asset.assetId)) {
    corpusFailure("INVALID_PACKAGE", "asset identity is invalid", `${path}/assetId`);
  }
  if (!ASSET_AUDIENCES.has(asset.audience)) {
    corpusFailure("INVALID_PACKAGE", "asset audience is invalid", `${path}/audience`);
  }
  if (asset.encoding !== "base64" || typeof asset.bytes !== "string") {
    corpusFailure("INVALID_PACKAGE", "assets must use canonical base64", `${path}/encoding`);
  }
  const bytes = Buffer.from(asset.bytes, "base64");
  if (bytes.toString("base64") !== asset.bytes) {
    corpusFailure("INVALID_PACKAGE", "asset bytes are not canonical base64", `${path}/bytes`);
  }
  if (sha256Bytes(bytes) !== asset.digest) {
    corpusFailure("PACKAGE_DIGEST_MISMATCH", "asset digest does not match bytes", `${path}/digest`);
  }
  return bytes;
}

function validateGraderBundle(bundle) {
  assertPlainObject(bundle, "/graderBundle");
  const fields = ["graderBundleId", "version", "digest", "entrypoint", "implementationDigest", "executionBoundary"];
  if (Object.keys(bundle).sort().join() !== fields.sort().join()) {
    corpusFailure("INVALID_PACKAGE", "grader bundle fields must match the closed schema", "/graderBundle");
  }
  if (bundle.executionBoundary !== "host-only") {
    corpusFailure("UNSAFE_GRADER_BOUNDARY", "grader must execute outside the candidate environment", "/graderBundle/executionBoundary");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(bundle.implementationDigest)) {
    corpusFailure("INVALID_PACKAGE", "grader implementation digest is invalid", "/graderBundle/implementationDigest");
  }
  if (bundle.digest !== bundleDigest(bundle)) {
    corpusFailure("PACKAGE_DIGEST_MISMATCH", "grader bundle identity is invalid", "/graderBundle/digest");
  }
}

export function bundleDigest(bundle) {
  return canonicalDigest({
    graderBundleId: bundle.graderBundleId,
    version: bundle.version,
    entrypoint: bundle.entrypoint,
    implementationDigest: bundle.implementationDigest,
    executionBoundary: bundle.executionBoundary,
  });
}

export function validateTaskPackage(value) {
  assertPlainObject(value, "");
  const fields = ["schemaVersion", "packageId", "digest", "task", "assets", "graderBundle"];
  if (Object.keys(value).sort().join() !== fields.sort().join()) {
    corpusFailure("INVALID_PACKAGE", "package fields must match the closed schema");
  }
  if (value.schemaVersion !== 1) corpusFailure("UNSUPPORTED_SCHEMA_VERSION", "only package schema v1 is supported", "/schemaVersion");
  validateTask(value.task);
  if (!PACKAGE_ID.test(value.packageId) || value.packageId !== deriveTaskPackageId(value)) {
    corpusFailure("PACKAGE_IDENTITY_MISMATCH", "package identity does not match semantic contents", "/packageId");
  }
  if (value.digest !== deriveTaskPackageDigest(value)) {
    corpusFailure("PACKAGE_DIGEST_MISMATCH", "package digest does not match record", "/digest");
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    corpusFailure("INVALID_PACKAGE", "package must contain immutable assets", "/assets");
  }
  const ids = new Set();
  const digestAudience = new Map();
  value.assets.forEach((asset, index) => {
    decodeAsset(asset, index);
    if (ids.has(asset.assetId)) corpusFailure("DUPLICATE_ASSET", "asset identities must be unique", `/assets/${index}/assetId`);
    ids.add(asset.assetId);
    const existingAudience = digestAudience.get(asset.digest);
    if (existingAudience !== undefined && existingAudience !== asset.audience) {
      corpusFailure(
        "HIDDEN_ASSET_EXPOSED",
        "one asset digest cannot be visible to both candidate and grader audiences",
        `/assets/${index}/audience`,
      );
    }
    digestAudience.set(asset.digest, asset.audience);
  });
  validateGraderBundle(value.graderBundle);
  if (value.task.grader.digest !== value.graderBundle.digest) {
    corpusFailure("GRADER_IDENTITY_MISMATCH", "task and package grader identities disagree", "/graderBundle/digest");
  }
  if (
    value.graderBundle.entrypoint === "exact-json-v1" &&
    (
      value.task.grader.oracle.kind !== "exact" ||
      value.task.outputs.find((output) => output.required)?.kind !== "json"
    )
  ) {
    corpusFailure(
      "GRADER_CONTRACT_MISMATCH",
      "exact JSON graders require an exact oracle and one required JSON output",
      "/task/grader/oracle/kind",
    );
  }
  for (const [path, digest] of [
    ["/task/fixture/digest", value.task.fixture.digest],
    ["/task/baseline/digest", value.task.baseline.digest],
    ...value.task.inputs.map((input, index) => [`/task/inputs/${index}/digest`, input.digest]),
    ...value.task.outputs.map((output, index) => [`/task/outputs/${index}/shapeDigest`, output.shapeDigest]),
    ...value.task.artifacts.map((artifact, index) => [`/task/artifacts/${index}/shapeDigest`, artifact.shapeDigest]),
  ]) {
    if (digestAudience.get(digest) !== "candidate") {
      corpusFailure("MISSING_ASSET", "candidate task material must have candidate audience", path);
    }
  }
  for (const [path, digest] of [
    ["/task/grader/rubricDigest", value.task.grader.rubricDigest],
    ["/task/grader/oracle/digest", value.task.grader.oracle.digest],
  ]) {
    if (digestAudience.get(digest) !== "grader") corpusFailure("HIDDEN_ASSET_EXPOSED", "grader material must be hidden", path);
  }
  return value;
}

export function createTaskPackage({ task, assets, graderBundle }) {
  validateTask(task);
  const normalizedAssets = assets.map((asset) => {
    const bytes = Buffer.isBuffer(asset.bytes) ? asset.bytes : Buffer.from(asset.bytes);
    return {
      assetId: asset.assetId,
      mediaType: asset.mediaType,
      audience: asset.audience,
      encoding: "base64",
      digest: sha256Bytes(bytes),
      bytes: bytes.toString("base64"),
    };
  }).sort((left, right) => (
    left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0
  ));
  const candidate = { schemaVersion: 1, packageId: `package:${"0".repeat(64)}`, digest: `sha256:${"0".repeat(64)}`, task, assets: normalizedAssets, graderBundle };
  candidate.packageId = deriveTaskPackageId(candidate);
  candidate.digest = deriveTaskPackageDigest(candidate);
  validateTaskPackage(candidate);
  return sealRecord(candidate, { contractKind: "TaskPackage", schemaVersion: 1 });
}

export function candidateTaskEnvelope(taskPackage) {
  validateTaskPackage(taskPackage);
  const task = structuredClone(taskPackage.task);
  // Candidate input includes only the grader identity and oracle digest, never
  // hidden rubric/oracle bytes or executable grader code.
  return sealRecord({
    schemaVersion: 1,
    packageId: taskPackage.packageId,
    task,
    assets: taskPackage.assets.filter((asset) => asset.audience === "candidate"),
  }, { contractKind: "CandidateTaskEnvelope", schemaVersion: 1 });
}

export function canonicalTaskPackageBytes(taskPackage) {
  validateTaskPackage(taskPackage);
  return canonicalBytes(taskPackage);
}
