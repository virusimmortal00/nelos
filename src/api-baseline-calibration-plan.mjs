import { canonicalDigest } from "./experimentation-contract/index.mjs";
import {
  API_BASELINE_FAMILIES,
  CANARY_CEILINGS,
  evaluateConfirmatoryAuthorization,
  validateApiBaselineBundle,
} from "./api-baseline-harness.mjs";

export const CALIBRATION_TRANCHE_POLICY = Object.freeze({
  schemaVersion: 1,
  phase: "api-repeat-arm-variance-calibration",
  purpose: "variance-estimation-only",
  newIndependentTasksPerStratum: 2,
  repeatArmsPerTask: 2,
  maxTranches: 5,
  maxConcurrency: 1,
  maxAttempts: 1,
  providerRetriesPerTrial: 0,
  maxEstimatedCostUsdPerTrial: CANARY_CEILINGS.maxEstimatedCostUsdPerTrial,
  authorization: "fresh-exact-user-authorization-required-per-tranche",
  comparativeClaimEligibility: "prohibited",
});

function failure(code) {
  throw Object.assign(new Error(code), { code });
}

function assertCurrentNoGo(confirmatoryDecision, varianceEvidence) {
  const expected = evaluateConfirmatoryAuthorization({ varianceEvidence });
  if (
    canonicalDigest(confirmatoryDecision) !== canonicalDigest(expected) ||
    confirmatoryDecision?.authorizationDigest !== expected.authorizationDigest
  ) failure("CALIBRATION_STALE_POWER_DECISION");
  if (
    expected.status !== "no-go" ||
    expected.decision !== "inconclusive-insufficient-independent-task-clusters" ||
    expected.zeroFurtherCalls !== true
  ) failure("CALIBRATION_NOT_APPLICABLE");
  return expected;
}

function existingTaskIdsByStratum(varianceEvidence) {
  const blocks = new Map();
  for (const item of varianceEvidence) {
    const key = `${item.stratum}|${item.taskId}|${item.blockId}`;
    const arms = blocks.get(key) ?? new Set();
    arms.add(item.arm);
    blocks.set(key, arms);
  }
  const tasks = new Map(API_BASELINE_FAMILIES.map((stratum) => [stratum, new Set()]));
  for (const [key, arms] of blocks) {
    if (!arms.has("a") || !arms.has("b")) continue;
    const [stratum, taskId] = key.split("|");
    tasks.get(stratum)?.add(taskId);
  }
  return Object.fromEntries(API_BASELINE_FAMILIES.map((stratum) => [stratum, [...tasks.get(stratum)].sort()]));
}

export function createCalibrationTrancheRequirement({
  apiBundle,
  confirmatoryDecision,
  varianceEvidence,
}) {
  validateApiBaselineBundle(apiBundle);
  if (!Array.isArray(varianceEvidence)) failure("INVALID_POWER_EVIDENCE");
  const decision = assertCurrentNoGo(confirmatoryDecision, varianceEvidence);
  const existingTaskIds = existingTaskIdsByStratum(varianceEvidence);
  const tasksPerStratum = CALIBRATION_TRANCHE_POLICY.newIndependentTasksPerStratum;
  const newTaskCount = API_BASELINE_FAMILIES.length * tasksPerStratum;
  const trialCount = newTaskCount * CALIBRATION_TRANCHE_POLICY.repeatArmsPerTask;
  const perTrialCost = CALIBRATION_TRANCHE_POLICY.maxEstimatedCostUsdPerTrial;
  const trancheCost = trialCount * perTrialCost;
  const currentByStratum = new Map(decision.strata.map((item) => [item.stratum, item]));
  const unsigned = {
    schemaVersion: 1,
    kind: "api-calibration-tranche-requirement",
    status: "corpus-required",
    executable: false,
    trancheIndex: 1,
    powerDecisionDigest: decision.authorizationDigest,
    varianceEvidenceDigest: decision.evidenceDigest,
    apiCanaryBundleDigest: apiBundle.bundleDigest,
    pricingSnapshot: {
      digest: canonicalDigest(apiBundle.identity.pricingSnapshot),
      capturedAt: apiBundle.identity.pricingSnapshot.capturedAt,
      sourceUrl: apiBundle.identity.pricingSnapshot.sourceUrl,
      currency: apiBundle.identity.pricingSnapshot.currency,
    },
    policy: CALIBRATION_TRANCHE_POLICY,
    currentEvidence: API_BASELINE_FAMILIES.map((stratum) => ({
      stratum,
      independentPairedTasks: currentByStratum.get(stratum).independentPairedTasks,
      currentPowerRequiredTasks: currentByStratum.get(stratum).powerRequiredTasks,
      existingTaskIds: existingTaskIds[stratum],
    })),
    corpusRequirement: {
      governedPublishedReleaseRequired: true,
      immutableTaskPackagesRequired: true,
      contaminationGateRequired: true,
      globallyUniqueTaskIdsRequired: true,
      priorEvidenceTaskReuse: "forbidden",
      promptParaphrasesSeedsAndRepeatsCountAsIndependentTasks: false,
      newIndependentTasksPerStratum: tasksPerStratum,
      totalNewIndependentTasks: newTaskCount,
    },
    scheduleRequirement: {
      arms: ["candidate:api-repeat-a", "candidate:api-repeat-b"],
      adapter: "direct-codex",
      treatmentArm: "absent",
      allocation: "deterministic-balanced-ab-ba-over-sorted-task-identities",
      blocksPerTask: 1,
      trialCount,
    },
    ceilings: {
      maxConcurrency: CALIBRATION_TRANCHE_POLICY.maxConcurrency,
      maxAttempts: CALIBRATION_TRANCHE_POLICY.maxAttempts,
      providerRetriesPerTrial: CALIBRATION_TRANCHE_POLICY.providerRetriesPerTrial,
      maxTotalProviderRetries: 0,
      outputTokenBudgetPerTrial: CANARY_CEILINGS.outputTokenBudgetPerTrial,
      maxTotalOutputTokens: trialCount * CANARY_CEILINGS.outputTokenBudgetPerTrial,
      wallClockSecondsPerTrial: CANARY_CEILINGS.wallClockSecondsPerTrial,
      maxTotalWallClockSeconds: trialCount * CANARY_CEILINGS.wallClockSecondsPerTrial,
      providerExecutionsPerTrial: 1,
      maxTotalProviderExecutions: trialCount,
      maxEstimatedCostUsdPerTrial: perTrialCost,
      maxTotalEstimatedCostUsd: trancheCost,
    },
    hardBounds: {
      maxTranches: CALIBRATION_TRANCHE_POLICY.maxTranches,
      maxNewTasksPerStratum: tasksPerStratum * CALIBRATION_TRANCHE_POLICY.maxTranches,
      maxCumulativeTrials: trialCount * CALIBRATION_TRANCHE_POLICY.maxTranches,
      maxCumulativeEstimatedCostUsd: trancheCost * CALIBRATION_TRANCHE_POLICY.maxTranches,
      actionAtBound: "stop-and-require-manual-design-review",
    },
    stoppingRules: {
      fixedTranche: true,
      effectBasedEarlyStopping: "forbidden",
      postHocExclusions: "forbidden",
      afterEveryCompletedOrAbortedTranche: "zero-further-calls",
      reestimateOnlyAfter: "sealed-complete-variance-evidence",
      authorizedConfirmatoryDecision: "stop-calibration-and-plan-confirmatory-separately",
      noGoDecision: "fresh-next-tranche-proposal-and-user-authorization-required",
      evidenceFailure: "stop-without-replacement-calls",
    },
    claimPolicy: {
      eligibleClaimClasses: ["methodology"],
      comparativePerformanceClaims: "prohibited",
      calibrationEffectEstimateUse: "variance-and-design-only",
    },
    authorizationBoundary: {
      currentPowerDecisionRemainsNoGo: true,
      zeroProviderCallsUntilSeparateAuthorization: true,
      thisArtifactCanAuthorizeCalls: false,
      thisArtifactCanAuthorizeConfirmatoryWork: false,
      thisArtifactCanAuthorizeNelosArm: false,
    },
  };
  return Object.freeze({ ...unsigned, requirementDigest: canonicalDigest(unsigned) });
}
