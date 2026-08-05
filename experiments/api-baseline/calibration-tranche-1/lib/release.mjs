import {
  canonicalDigest,
  reviseCorpusRelease,
  transitionCorpusRelease,
} from "../../../../src/experimentation-contract/index.mjs";
import {
  analyzeCorpusDuplicates,
  createStarterDevelopmentRelease,
  tokenJaccard,
  validateEvaluationPartitions,
  validateTaskPackage,
} from "../../../../src/experimentation-corpus/index.mjs";

export const CALIBRATION_REQUIREMENT_DIGEST = "sha256:507f57cdbbefa44d90919d6cd552502cc1d1f7137f02e9f27bb0c301768e51e6";
export const CALIBRATION_RELEASE_VERSION = "1.1.0";
export const CALIBRATION_RELEASE_CREATED_AT = "2026-08-05T12:00:00Z";
export const CALIBRATION_FREEZE_AT = "2026-08-05T12:30:00Z";
export const CALIBRATION_STRATA = Object.freeze([
  "localized-repair",
  "cross-cutting-feature",
  "multi-module-migration",
  "planning",
  "orchestration-restart",
]);
export const CALIBRATION_CONCEPTS = Object.freeze([
  { key: "lr-duration-carry", stratum: "localized-repair" },
  { key: "lr-path-containment", stratum: "localized-repair" },
  { key: "cf-operation-provenance", stratum: "cross-cutting-feature" },
  { key: "cf-disk-ceiling", stratum: "cross-cutting-feature" },
  { key: "mm-checkpoint-v2", stratum: "multi-module-migration" },
  { key: "mm-cost-microusd", stratum: "multi-module-migration" },
  { key: "pl-capability-waves", stratum: "planning" },
  { key: "pl-release-verification", stratum: "planning" },
  { key: "or-ambiguous-effect", stratum: "orchestration-restart" },
  { key: "or-expired-lease", stratum: "orchestration-restart" },
].map(Object.freeze));

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function exactConcepts(concepts) {
  if (canonicalDigest(concepts) !== canonicalDigest(CALIBRATION_CONCEPTS)) {
    fail("INVALID_CONCEPT_MANIFEST", "private material must use the approved ordered concept catalog");
  }
}

export function validateCalibrationContamination({
  release,
  activePackages,
  developmentPackages,
  accessLog,
  exclusions,
  observedExclusions = [],
}) {
  const releaseIds = release.tasks.map(({ taskId }) => taskId).sort();
  const activeIds = activePackages.map(({ task }) => task.taskId).sort();
  if (canonicalDigest(releaseIds) !== canonicalDigest(activeIds)) fail("INCOMPLETE_ACTIVE_MEMBERSHIP", "contamination validation must cover the complete active release");
  const duplicates = analyzeCorpusDuplicates(activePackages, 0.8);
  if (duplicates.exactGroups.length > 0) fail("PROHIBITED_EXACT_DUPLICATE", "exact task duplicates are prohibited");
  if (duplicates.nearGroups.length > 0) fail("PROHIBITED_NEAR_DUPLICATE", "near task duplicates are prohibited");
  const declared = new Set(exclusions.map(({ taskId }) => taskId));
  if (observedExclusions.some((taskId) => !declared.has(taskId))) fail("UNDECLARED_EXCLUSION", "every observed exclusion must be declared before freeze");
  const known = new Set([...developmentPackages, ...activePackages].map(({ task }) => task.taskId));
  if (exclusions.some(({ taskId }) => !known.has(taskId))) fail("INVALID_EXCLUSION", "exclusions cannot name unknown task identities");
  const loggedPrivateIds = new Set(accessLog.filter(({ role }) => role !== "author").map(({ taskId }) => taskId));
  if (activeIds.some((taskId) => !loggedPrivateIds.has(taskId))) fail("UNLOGGED_PRIVATE_ACCESS", "each inspected private task requires a logged host access record");
  return validateEvaluationPartitions({
    developmentPackages,
    privatePackages: activePackages,
    accessLog,
    exclusions,
    frozenAt: CALIBRATION_FREEZE_AT,
    nearThreshold: 0.8,
  });
}

function scheduleFor(release, packages) {
  const taskIds = packages.map(({ task }) => task.taskId).sort();
  const trials = taskIds.flatMap((taskId, index) => {
    const order = index % 2 === 0 ? ["a", "b"] : ["b", "a"];
    return order.map((arm, withinBlock) => ({
      ordinal: index * 2 + withinBlock + 1,
      blockId: `calibration:${taskId.slice(5, 21)}`,
      taskId,
      arm: `candidate:api-repeat-${arm}`,
      attempt: 1,
      providerRetries: 0,
      estimatedCostUsd: 0.1875,
    }));
  });
  const unsigned = {
    schemaVersion: 1,
    kind: "api-calibration-tranche-schedule",
    status: "prepared-unauthorized",
    executable: false,
    adapter: "direct-codex",
    treatmentArm: null,
    requirementDigest: CALIBRATION_REQUIREMENT_DIGEST,
    corpus: { releaseId: release.releaseId, digest: release.digest },
    allocation: "deterministic-balanced-ab-ba-over-sorted-task-identities",
    trialCount: trials.length,
    maxConcurrency: 1,
    maxAttempts: 1,
    providerRetriesPerTrial: 0,
    maxTotalProviderRetries: 0,
    maxEstimatedCostUsd: 3.75,
    authorization: {
      confirmatoryNoGoPreserved: true,
      providerCallsMadeDuringConstruction: 0,
      credentialAccessesDuringConstruction: 0,
      freshExactUserAuthorizationRequiredBeforeAnyTrancheCall: true,
      thisScheduleCanAuthorizeCalls: false,
    },
    trials,
  };
  return Object.freeze({ ...unsigned, scheduleDigest: canonicalDigest(unsigned) });
}

function successorRelease(previous, members) {
  const tasks = members.map(({ taskPackage, strata }) => ({
    taskId: taskPackage.task.taskId,
    revision: taskPackage.task.specRevision,
    digest: taskPackage.task.digest,
    assetDigests: taskPackage.assets.map(({ digest }) => digest).sort(),
    strata,
  })).sort((left, right) => left.taskId.localeCompare(right.taskId));
  const assets = new Map(previous.assets.map((entry) => [entry.assetId, entry]));
  for (const { taskPackage } of members) {
    for (const entry of taskPackage.assets) assets.set(entry.assetId, {
      assetId: entry.assetId,
      digest: entry.digest,
      mediaType: entry.mediaType,
      bytes: Buffer.from(entry.bytes, "base64").byteLength,
    });
  }
  const graderBundles = new Map();
  for (const { taskPackage } of members) {
    const bundle = taskPackage.graderBundle;
    const existing = graderBundles.get(bundle.graderBundleId);
    if (existing !== undefined && existing.digest !== bundle.digest) {
      fail("GRADER_IDENTITY_COLLISION", "one grader identity cannot reference multiple bundle digests");
    }
    graderBundles.set(bundle.graderBundleId, {
      graderBundleId: bundle.graderBundleId,
      version: bundle.version,
      digest: bundle.digest,
    });
  }
  const removedTaskIds = previous.tasks.map(({ taskId }) => taskId).sort();
  return reviseCorpusRelease(previous, {
    version: CALIBRATION_RELEASE_VERSION,
    tasks,
    assets: [...assets.values()].sort((left, right) => left.assetId.localeCompare(right.assetId)),
    graderBundles: [...graderBundles.values()].sort((left, right) => left.graderBundleId.localeCompare(right.graderBundleId)),
    changelog: [
      { changeId: "change:task-added", kind: "task-added", summary: "Add ten requirement-bound independent calibration tasks.", taskIds: tasks.map(({ taskId }) => taskId) },
      { changeId: "change:task-excluded", kind: "task-excluded", summary: "Retain predecessor development identities as audited exclusions from the private calibration release.", taskIds: removedTaskIds },
    ],
    retainedExclusions: removedTaskIds.map((taskId) => ({ taskId, reasonCode: "superseded", reason: "Excluded from the private requirement-bound calibration membership." })),
    cutoff: { ...previous.cutoff, createdAt: CALIBRATION_RELEASE_CREATED_AT },
    provenance: { ...previous.provenance, sourceUri: `urn:nelos:api-calibration:${CALIBRATION_REQUIREMENT_DIGEST}`, sourceDigest: canonicalDigest(members.map(({ taskPackage }) => taskPackage.digest).sort()) },
    duplicateAnalysis: analyzeCorpusDuplicates(members.map(({ taskPackage }) => taskPackage), 0.8),
    visibility: "private-test",
  });
}

export function createCalibrationTrancheRelease({ packages, concepts }) {
  if (!Array.isArray(packages) || packages.length !== 10) fail("INVALID_PRIVATE_MEMBERSHIP", "exactly ten private packages are required");
  exactConcepts(concepts);
  packages.forEach(validateTaskPackage);
  const predecessor = createStarterDevelopmentRelease();
  if (
    predecessor.release.releaseId !== "corpus:355bf16738a0d874d3c265d85bc148ad9d61fd3ca1e852c36b3a60c7feb8cf7f" ||
    predecessor.release.digest !== "sha256:64fbee81daaea1c0869cf54f8ef7f36c76d2c7af62ec85995112328f2ad13a89"
  ) fail("PREDECESSOR_IDENTITY_MISMATCH", "the calibration release requires the approved immutable 1.0.0 predecessor");
  for (const taskPackage of packages) {
    const candidateDigests = new Set(taskPackage.assets.filter(({ audience }) => audience === "candidate").map(({ digest }) => digest));
    const graderDigests = taskPackage.assets.filter(({ audience }) => audience === "grader").map(({ digest }) => digest);
    if (graderDigests.length === 0 || graderDigests.some((digest) => candidateDigests.has(digest))) fail("HIDDEN_ASSET_EXPOSED", "candidate and grader asset digest sets must be nonempty and disjoint");
  }
  const previousIds = new Set(predecessor.packages.map(({ task }) => task.taskId));
  if (packages.some(({ task }) => previousIds.has(task.taskId))) fail("PRIOR_EVIDENCE_TASK_REUSE", "calibration tasks cannot reuse predecessor identities");
  const counts = Object.fromEntries(CALIBRATION_STRATA.map((stratum) => [stratum, 0]));
  const members = packages.map((taskPackage, index) => {
    counts[concepts[index].stratum] += 1;
    return { taskPackage, strata: { category: concepts[index].stratum, risk: "high", size: "medium", decomposability: "localized" } };
  });
  if (Object.values(counts).some((count) => count !== 2)) fail("INVALID_STRATUM_MEMBERSHIP", "each baseline stratum requires two independent tasks");
  let release = successorRelease(predecessor.release, members);
  release = transitionCorpusRelease(transitionCorpusRelease(transitionCorpusRelease(release, "reviewed"), "sealed"), "published");
  const priorEvidencePackages = CALIBRATION_STRATA.map((stratum) => predecessor.packages.find((taskPackage) => predecessor.release.tasks.find(({ taskId }) => taskId === taskPackage.task.taskId)?.strata.category === stratum));
  const reviewPackages = [...packages, ...priorEvidencePackages];
  const pairs = [];
  for (let left = 0; left < reviewPackages.length; left += 1) {
    for (let right = left + 1; right < reviewPackages.length; right += 1) pairs.push({
      leftTaskId: reviewPackages[left].task.taskId,
      rightTaskId: reviewPackages[right].task.taskId,
      promptTokenJaccard: tokenJaccard(reviewPackages[left].task.prompt.text, reviewPackages[right].task.prompt.text),
      disposition: "independent",
    });
  }
  pairs.sort((left, right) => `${left.leftTaskId}:${left.rightTaskId}`.localeCompare(`${right.leftTaskId}:${right.rightTaskId}`));
  if (pairs.length !== 105) fail("SEMANTIC_INDEPENDENCE_REVIEW_FAILED", "the complete semantic review must cover all 105 pairs");
  const semanticIndependence = Object.freeze({ schemaVersion: 1, method: "complete-pair-human-concept-review-plus-unicode-token-jaccard-v1", newTaskCount: 10, priorEvidenceTaskCount: 5, comparisonCount: 105, nearThreshold: 0.8, disposition: "independent", pairs, digest: canonicalDigest(pairs) });
  const accessLog = packages.map(({ task }, index) => ({ actor: "team:evaluation-host", role: "evaluator", taskId: task.taskId, at: `2026-08-05T13:${String(index).padStart(2, "0")}:00Z` }));
  const exclusions = [];
  const contamination = validateCalibrationContamination({ release, activePackages: packages, developmentPackages: priorEvidencePackages, accessLog, exclusions });
  return Object.freeze({ predecessor: predecessor.release, release, packages, concepts, priorEvidencePackages, semanticIndependence, accessLog, exclusions, contamination, schedule: scheduleFor(release, packages) });
}
