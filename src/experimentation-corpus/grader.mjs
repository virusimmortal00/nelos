import { canonicalBytes, canonicalDigest, sealRecord, sha256Bytes } from "../experimentation-contract/index.mjs";
import { corpusFailure } from "./errors.mjs";
import {
  graderImplementationDigest,
  graderImplementationManifest,
} from "./grader-identity.mjs";
import { bundleDigest, validateTaskPackage } from "./package.mjs";

export const MACHINE_GRADE_OUTCOMES = Object.freeze([
  "success", "failure", "partial", "timeout", "malformed", "contaminated", "grader-failure",
]);

function assertHostBoundary(attestation) {
  if (
    attestation === null ||
    typeof attestation !== "object" ||
    attestation.issuer !== "nelos-host-runtime" ||
    typeof attestation.candidateEnvironmentId !== "string" ||
    typeof attestation.graderEnvironmentId !== "string" ||
    attestation.candidateEnvironmentId === attestation.graderEnvironmentId
  ) {
    corpusFailure("UNSAFE_GRADER_BOUNDARY", "a distinct host grader environment is required", "/attestation");
  }
}

function assetBytes(taskPackage, digest) {
  const asset = taskPackage.assets.find((candidate) => candidate.digest === digest);
  if (!asset || asset.audience !== "grader") {
    corpusFailure("MISSING_ASSET", "hidden grader asset is unavailable", "/task/grader/oracle/digest");
  }
  return Buffer.from(asset.bytes, "base64");
}

function outputBytes(taskPackage, submission) {
  if (submission === null || typeof submission !== "object" || !Array.isArray(submission.outputs)) return null;
  const required = taskPackage.task.outputs.find((output) => output.required);
  const output = submission.outputs.find((candidate) => candidate?.id === required.id);
  if (!output || output.encoding !== "base64" || typeof output.bytes !== "string") return null;
  const bytes = Buffer.from(output.bytes, "base64");
  if (bytes.toString("base64") !== output.bytes || bytes.byteLength > required.maxBytes) return null;
  return bytes;
}

function exactJsonGrade({ taskPackage, submission }) {
  const bytes = outputBytes(taskPackage, submission);
  if (bytes === null) return { outcome: "malformed", strictPass: false, scoreBasisPoints: 0, criteria: [] };
  let actual;
  let oracle;
  try {
    actual = JSON.parse(bytes.toString("utf8"));
    oracle = JSON.parse(assetBytes(taskPackage, taskPackage.task.grader.oracle.digest).toString("utf8"));
  } catch {
    return { outcome: "malformed", strictPass: false, scoreBasisPoints: 0, criteria: [] };
  }
  if (oracle.forceGraderFailure === true) throw new Error("sealed grader-failure fixture");
  const expected = oracle.expected;
  if (canonicalDigest(actual) === canonicalDigest(expected)) {
    return { outcome: "success", strictPass: true, scoreBasisPoints: 10000, criteria: [] };
  }
  const criteria = taskPackage.task.partialCredit.criteria.map((criterion) => ({
    id: criterion.id,
    earned: oracle.criteria?.[criterion.id]?.expected === actual?.[oracle.criteria?.[criterion.id]?.field],
    weightBasisPoints: criterion.weightBasisPoints,
  }));
  const scoreBasisPoints = criteria.reduce((total, criterion) => total + (criterion.earned ? criterion.weightBasisPoints : 0), 0);
  return {
    outcome: scoreBasisPoints > 0 ? "partial" : "failure",
    strictPass: false,
    scoreBasisPoints,
    criteria,
  };
}

export function graderBundleForImplementationManifest(implementationManifest) {
  const bundle = {
    graderBundleId: "grader:starter-exact",
    version: "1.0.0",
    digest: "",
    entrypoint: "exact-json-v1",
    // The manifest binds the complete local contract and corpus implementation
    // closure. RuntimeLock binds the Node runtime and built-in modules.
    implementationDigest: graderImplementationDigest(implementationManifest),
    executionBoundary: "host-only",
  };
  bundle.digest = bundleDigest(bundle);
  return Object.freeze(bundle);
}

const INSTALLED_STARTER_GRADER_BUNDLE = graderBundleForImplementationManifest(
  graderImplementationManifest(),
);

const GRADERS = new Map([["grader:starter-exact", Object.freeze({
  grade: exactJsonGrade,
  bundle: INSTALLED_STARTER_GRADER_BUNDLE,
})]]);

export function starterGraderBundle() {
  return INSTALLED_STARTER_GRADER_BUNDLE;
}

function assertInstalledGraderIdentity(taskPackage) {
  const installed = GRADERS.get(taskPackage.graderBundle.graderBundleId);
  if (!installed) {
    corpusFailure("UNKNOWN_GRADER", "grader identity is not installed", "/graderBundle/graderBundleId");
  }
  if (
    taskPackage.graderBundle.digest !== installed.bundle.digest ||
    taskPackage.graderBundle.implementationDigest !== installed.bundle.implementationDigest
  ) {
    corpusFailure(
      "GRADER_IDENTITY_MISMATCH",
      "task package grader identity does not match the installed implementation",
      "/graderBundle/implementationDigest",
    );
  }
  return installed;
}

function gradeRecord(taskPackage, observation, machine) {
  const record = {
    schemaVersion: 1,
    taskId: taskPackage.task.taskId,
    taskDigest: taskPackage.task.digest,
    packageDigest: taskPackage.digest,
    graderId: taskPackage.graderBundle.graderBundleId,
    graderDigest: taskPackage.graderBundle.digest,
    oracleDigest: taskPackage.task.grader.oracle.digest,
    attemptId: observation.attemptId,
    outcome: machine.outcome,
    strictPass: machine.strictPass,
    scoreBasisPoints: machine.scoreBasisPoints,
    criteria: machine.criteria ?? [],
    candidateOutputDigest: machine.outputDigest ?? null,
    trustedObservationDigest: canonicalDigest(observation),
  };
  return sealRecord({ ...record, digest: canonicalDigest(record) }, { contractKind: "MachineGrade", schemaVersion: 1 });
}

export function gradeTaskAttempt({ taskPackage, submission, observation, attestation }) {
  validateTaskPackage(taskPackage);
  const installed = assertInstalledGraderIdentity(taskPackage);
  assertHostBoundary(attestation);
  if (observation === null || typeof observation !== "object" || typeof observation.attemptId !== "string") {
    corpusFailure("INVALID_OBSERVATION", "trusted host observation is required", "/observation");
  }
  let machine;
  if (observation.contaminated === true) {
    machine = { outcome: "contaminated", strictPass: false, scoreBasisPoints: 0, criteria: [] };
  } else if (observation.termination === "timeout") {
    machine = { outcome: "timeout", strictPass: false, scoreBasisPoints: 0, criteria: [] };
  } else if (observation.termination !== "exited" || observation.exitCode !== 0) {
    machine = { outcome: "failure", strictPass: false, scoreBasisPoints: 0, criteria: [] };
  } else {
    try {
      machine = installed.grade({ taskPackage, submission: { outputs: submission?.outputs } });
      const bytes = outputBytes(taskPackage, submission);
      machine.outputDigest = bytes === null ? null : sha256Bytes(bytes);
    } catch {
      machine = { outcome: "grader-failure", strictPass: false, scoreBasisPoints: 0, criteria: [], outputDigest: null };
    }
  }
  return gradeRecord(taskPackage, observation, machine);
}

export function canonicalGradeBytes(grade) {
  return canonicalBytes(grade);
}
