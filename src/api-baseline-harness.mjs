import { realpath, readFile } from "node:fs/promises";

import {
  canonicalDigest,
  deriveExperimentDigest,
  deriveExperimentIdentity,
  sha256Bytes,
  transitionExperiment,
} from "./experimentation-contract/index.mjs";
import { createStarterDevelopmentRelease, createStarterTaskPackage, starterGraderBundle } from "./experimentation-corpus/index.mjs";
import { expandExperimentPlan, validateRunnerManifest } from "./experiment-runner.mjs";

export const API_BASELINE_FAMILIES = Object.freeze(["localized-repair", "cross-cutting-feature", "multi-module-migration", "planning", "orchestration-restart"]);
export const API_BASELINE_CANDIDATES = Object.freeze(["candidate:api-repeat-a", "candidate:api-repeat-b"]);
export const API_BASELINE_RUN_PREFIX = "run:api-baseline-canary-";
export const CANARY_FAMILY = "localized-repair";
export const CANARY_CEILINGS = Object.freeze({
  blocks: 2,
  trials: 4,
  maxConcurrency: 1,
  maxAttempts: 1,
  tokenBudgetPerTrial: 4000,
  maxTotalTokens: 16000,
  wallClockSecondsPerTrial: 180,
  maxTotalWallClockSeconds: 720,
  candidateNetworkRequestsPerTrial: 0,
  providerExecutionsPerTrial: 1,
  maxTotalProviderExecutions: 4,
  providerRetriesPerTrial: 0,
  maxTotalProviderRetries: 0,
  providerRequestsPerTrial: 1,
  maxTotalProviderRequests: 4,
  maxTotalCandidateNetworkRequests: 0,
  maxEstimatedCostUsdPerTrial: 0.25,
  maxTotalEstimatedCostUsd: 1,
});
export const CONFIRMATORY_POWER_POLICY = Object.freeze({
  schemaVersion: 1,
  endpoint: Object.freeze({ metricId: "strict_pass_rate", contrast: "paired-risk-difference", direction: "higher" }),
  minimumDetectableEffect: 0.2,
  alpha: 0.05,
  targetPower: 0.8,
  samplingUnit: "task",
  dependence: "paired-task-cluster",
  criticalStrata: API_BASELINE_FAMILIES,
  minimumIndependentPairedTasksPerStratum: 10,
  eligibleVariancePhases: Object.freeze(["signed-in-pilot", "api-canary"]),
});

function failure(code) { throw Object.assign(new Error(code), { code }); }
function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) failure(code);
}
function digest(value) { return /^sha256:[0-9a-f]{64}$/u.test(value ?? ""); }

export async function measureRuntimeProvenance({ executablePath, backend, platform, expectedExecutableDigest = null, read = readFile, resolvePath = realpath }) {
  if (typeof executablePath !== "string" || !executablePath.startsWith("/")) failure("INVALID_RUNTIME_EXECUTABLE");
  const measuredPath = await resolvePath(executablePath);
  const bytes = await read(measuredPath);
  const executableDigest = sha256Bytes(bytes);
  const byteLength = bytes.byteLength;
  if (expectedExecutableDigest !== null && expectedExecutableDigest !== executableDigest) failure("RUNTIME_DIGEST_CLAIM_MISMATCH");
  const receipt = { schemaVersion: 1, measurement: "immutable-executable-bytes", executablePath: measuredPath, executableDigest, byteLength, backend, platform };
  return Object.freeze({ ...receipt, receiptDigest: canonicalDigest(receipt) });
}

function validateMeasuredRuntime(runtime) {
  exactObject(runtime, ["schemaVersion", "measurement", "executablePath", "executableDigest", "byteLength", "backend", "platform", "receiptDigest"], "INVALID_RUNTIME_PROVENANCE");
  const material = { ...runtime }; delete material.receiptDigest;
  if (runtime.schemaVersion !== 1 || runtime.measurement !== "immutable-executable-bytes" || !runtime.executablePath.startsWith("/") || !digest(runtime.executableDigest)
    || !Number.isSafeInteger(runtime.byteLength) || runtime.byteLength < 1 || canonicalDigest(material) !== runtime.receiptDigest) failure("INVALID_RUNTIME_PROVENANCE");
}

function candidate(candidateId, repeatArm, { sourceCommit, requestedModel }) {
  return { candidateId, adapter: "direct-codex", source: { commit: sourceCommit, digest: canonicalDigest({ sourceCommit, adapter: "api-codex-receipt-v2" }) }, model: { ...requestedModel }, plugins: [], configuration: [{ name: "authentication", value: "runtime-api-key" }, { name: "developer-config", value: "absent" }, { name: "repeat-arm", value: repeatArm }, { name: "user-config", value: "ignored" }] };
}

function sealedCanarySchedule(manifest) {
  const plan = expandExperimentPlan(manifest);
  const bySeedCandidate = new Map(plan.trials.map((trial) => [`${trial.seed}|${trial.candidateId}`, trial]));
  const orders = [[...API_BASELINE_CANDIDATES], [...API_BASELINE_CANDIDATES].reverse()];
  const taskId = manifest.tasks[0].taskId;
  const blocks = manifest.experiment.design.seedSchedule.map(({ seed, replicate }, index) => ({
    blockId: canonicalDigest({ phase: "api-canary", taskId, seed, replicate }), taskId, seed, replicate, candidateOrder: orders[index], trialIds: orders[index].map((candidateId) => bySeedCandidate.get(`${seed}|${candidateId}`).trialId),
  }));
  const unsigned = { schemaVersion: 1, phase: "api-canary", pairing: "task-seed", blocks, trialCount: 4, runnerPlanDigest: plan.planDigest };
  return Object.freeze({ ...unsigned, scheduleDigest: canonicalDigest(unsigned) });
}

export function createApiBaselineBundle({ mode = "canary", sourceCommit, requestedModel, runtimeProvenance }) {
  if (mode !== "canary") failure("CONFIRMATORY_POWER_AUTHORIZATION_REQUIRED");
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit ?? "")) failure("INVALID_SOURCE_COMMIT");
  exactObject(requestedModel, ["id", "revision", "reasoningEffort"], "INVALID_REQUESTED_ROUTE");
  if (!/^model:[A-Za-z0-9._-]+$/u.test(requestedModel.id) || requestedModel.id === "model:product-default" || requestedModel.revision === "unavailable") failure("INVALID_REQUESTED_ROUTE");
  validateMeasuredRuntime(runtimeProvenance);
  const { release } = createStarterDevelopmentRelease();
  const tasks = [createStarterTaskPackage(CANARY_FAMILY).task];
  const grader = starterGraderBundle();
  const runtimeDigest = canonicalDigest(runtimeProvenance);
  let experiment = {
    schemaVersion: 1, experimentId: `exp:${"0".repeat(64)}`, specRevision: 1, previousDigest: null, digest: `sha256:${"0".repeat(64)}`, state: "draft",
    name: "API-controlled direct Codex four-trial canary", description: "Two repeat arms in two predetermined opposite-order blocks; confirmatory construction is power-gated separately.",
    hypothesis: { statement: "Identical direct Codex API repeat arms have comparable strict-pass behavior under an explicit route.", primaryMetric: "strict_pass_rate", decisionRule: "noninferiority" },
    candidates: API_BASELINE_CANDIDATES.map((id, index) => candidate(id, index === 0 ? "a" : "b", { sourceCommit, requestedModel })), corpus: { releaseId: release.releaseId, digest: release.digest },
    design: { pairing: "task-seed", repetitions: 2, seedRoot: "nelos-api-canary-v2", seedSchedule: [{ replicate: 1, seed: "api-canary-block-ab" }, { replicate: 2, seed: "api-canary-block-ba" }], multiplicityFamily: "api-canary" },
    limits: { wallClockSeconds: CANARY_CEILINGS.wallClockSecondsPerTrial, tokenBudget: CANARY_CEILINGS.tokenBudgetPerTrial, toolCalls: 50, diskBytes: 536870912, processes: 8, networkRequests: 0 },
    runtimeMatrix: [{ runtimeLockId: `runtime:${runtimeDigest.slice(7)}`, digest: runtimeDigest, backend: runtimeProvenance.backend, platform: runtimeProvenance.platform, eligibleCandidateIds: [...API_BASELINE_CANDIDATES], requiredCapabilities: ["git", "node"] }],
    graderBundle: { id: grader.graderBundleId, digest: grader.digest }, exclusions: [],
    metrics: { primary: { metricId: "strict_pass_rate", direction: "higher", aggregation: "rate" }, secondary: [{ metricId: "candidate_failure_rate", direction: "lower", aggregation: "rate" }, { metricId: "input_tokens", direction: "lower", aggregation: "median" }, { metricId: "output_tokens", direction: "lower", aggregation: "median" }, { metricId: "terminal_wall_ms", direction: "lower", aggregation: "median" }], minimumDetectableEffect: { metricId: "strict_pass_rate", absolute: 0.2, power: 0.8, alpha: 0.05 } },
    decisionRules: { promotion: { kind: "noninferiority", metricId: "strict_pass_rate", threshold: 0.2, minimumSamples: 4 }, regression: { kind: "absolute", metricId: "candidate_failure_rate", threshold: 0.2, minimumSamples: 4 }, stop: { kind: "fixed-sample", metricId: "strict_pass_rate", threshold: 4, minimumSamples: 4 }, invalidation: { maxInvalidFraction: 0, asymmetricInvalidity: "invalidate-comparison", reasonCodes: ["contamination", "grader_failure", "route_mismatch", "receipt_missing"] } },
  };
  experiment.experimentId = deriveExperimentIdentity(experiment); experiment.digest = deriveExperimentDigest(experiment); experiment = transitionExperiment(transitionExperiment(experiment, "reviewed"), "sealed");
  const root = new URL("..", import.meta.url).pathname;
  const runnerManifest = { schemaVersion: 1, experiment, tasks, adapters: { "direct-codex": { command: [process.execPath, `${root}scripts/api-codex-adapter.mjs`], environment: {}, version: "api-codex-receipt-v2" }, nelos: { command: [process.execPath, `${root}scripts/test-support/fake-experiment-adapter.mjs`], environment: {}, version: "unused-v1" } }, policy: { maxConcurrency: 1, perAdapterConcurrency: { "direct-codex": 1, nelos: 1 }, leaseMs: 210000, timeoutMs: 180000, maxAttempts: 1 } };
  const executionSchedule = sealedCanarySchedule(runnerManifest);
  const identity = { phase: "api-controlled-canary", runIdPrefix: API_BASELINE_RUN_PREFIX, storeNamespace: "api-canary-store-v2", evidenceRootName: "api-canary-evidence-v2", reportKind: "api-canary-report-v2", requestedRoute: { modelId: requestedModel.id, modelRevision: requestedModel.revision, reasoningEffort: requestedModel.reasoningEffort }, runtimeProvenance };
  const controls = { ceilings: CANARY_CEILINGS, sealedTrialCount: 4, expansion: "forbidden", confirmatoryAuthorization: "not-granted" };
  const unsigned = { schemaVersion: 2, identity, runnerManifest, executionSchedule, controls };
  return Object.freeze({ ...unsigned, bundleDigest: canonicalDigest(unsigned) });
}

export function validateApiBaselineBundle(bundle) {
  exactObject(bundle, ["schemaVersion", "identity", "runnerManifest", "executionSchedule", "controls", "bundleDigest"], "INVALID_API_BASELINE_BUNDLE");
  const candidates = bundle.runnerManifest?.experiment?.candidates ?? [];
  if (candidates.length !== 2 || candidates.some(({ adapter }) => adapter !== "direct-codex") || candidates.some(({ candidateId }) => /nelos/iu.test(candidateId))) failure("INVALID_API_BASELINE_ARM");
  const material = { ...bundle }; delete material.bundleDigest;
  if (bundle.schemaVersion !== 2 || canonicalDigest(material) !== bundle.bundleDigest) failure("ALTERED_API_BASELINE_BUNDLE");
  validateRunnerManifest(bundle.runnerManifest); validateMeasuredRuntime(bundle.identity.runtimeProvenance);
  if (bundle.runnerManifest.tasks.length !== 1 || bundle.identity.phase !== "api-controlled-canary" || bundle.identity.runIdPrefix !== API_BASELINE_RUN_PREFIX) failure("CANARY_SCOPE_VIOLATION");
  const armMaterial = candidates.map((entry) => ({ ...entry, candidateId: "candidate:repeat", configuration: entry.configuration.map((item) => item.name === "repeat-arm" ? { ...item, value: "repeat" } : item) }));
  if (canonicalDigest(armMaterial[0]) !== canonicalDigest(armMaterial[1])) failure("NONIDENTICAL_API_BASELINE_ARMS");
  const expected = sealedCanarySchedule(bundle.runnerManifest);
  if (canonicalDigest(bundle.executionSchedule) !== canonicalDigest(expected) || bundle.executionSchedule.trialCount !== 4 || bundle.executionSchedule.blocks.length !== 2) failure("ALTERED_API_BASELINE_SCHEDULE");
  if (canonicalDigest(bundle.controls.ceilings) !== canonicalDigest(CANARY_CEILINGS) || bundle.controls.sealedTrialCount !== 4 || bundle.controls.expansion !== "forbidden" || bundle.controls.confirmatoryAuthorization !== "not-granted") failure("API_BASELINE_CEILING_EXCEEDED");
  return bundle;
}

function sampleVariance(values) {
  if (values.length < 2) return 0.25;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

export function evaluateConfirmatoryAuthorization({ varianceEvidence }) {
  if (!Array.isArray(varianceEvidence)) failure("INVALID_POWER_EVIDENCE");
  const allowedPhases = new Set(CONFIRMATORY_POWER_POLICY.eligibleVariancePhases);
  const observedPhases = new Set();
  const byStratumTaskBlock = new Map();
  for (const item of varianceEvidence) {
    exactObject(item, ["phase", "stratum", "taskId", "blockId", "arm", "value"], "INVALID_POWER_EVIDENCE");
    if (!allowedPhases.has(item.phase) || !API_BASELINE_FAMILIES.includes(item.stratum) || !["a", "b"].includes(item.arm) || typeof item.taskId !== "string" || item.taskId.length === 0 || item.taskId.includes("|") || typeof item.blockId !== "string" || item.blockId.length === 0 || item.blockId.includes("|") || (item.value !== 0 && item.value !== 1)) failure("INVALID_POWER_EVIDENCE");
    observedPhases.add(item.phase);
    const key = `${item.stratum}|${item.taskId}|${item.blockId}`; const block = byStratumTaskBlock.get(key) ?? new Map();
    if (block.has(item.arm)) failure("DUPLICATE_POWER_OBSERVATION"); block.set(item.arm, item.value); byStratumTaskBlock.set(key, block);
  }
  const taskEffects = new Map(API_BASELINE_FAMILIES.map((stratum) => [stratum, new Map()]));
  for (const [key, block] of byStratumTaskBlock) {
    if (!block.has("a") || !block.has("b")) continue;
    const [stratum, taskId] = key.split("|"); const tasks = taskEffects.get(stratum); const effects = tasks.get(taskId) ?? [];
    effects.push(block.get("b") - block.get("a")); tasks.set(taskId, effects);
  }
  const strata = API_BASELINE_FAMILIES.map((stratum) => {
    const clusterEffects = [...taskEffects.get(stratum).values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
    const variance = sampleVariance(clusterEffects);
    const powerRequiredTasks = Math.max(10, Math.ceil(((1.959964 + 0.841621) ** 2 * variance) / (CONFIRMATORY_POWER_POLICY.minimumDetectableEffect ** 2)));
    return { stratum, independentPairedTasks: clusterEffects.length, pairedTaskVariance: variance, powerRequiredTasks, authorizedTasks: Math.max(10, powerRequiredTasks) };
  });
  const hasApplicablePhases = CONFIRMATORY_POWER_POLICY.eligibleVariancePhases.every((phase) => observedPhases.has(phase));
  const authorized = hasApplicablePhases && strata.every(({ independentPairedTasks, authorizedTasks }) => independentPairedTasks >= authorizedTasks);
  const unsigned = { schemaVersion: 1, status: authorized ? "authorized" : "no-go", decision: authorized ? "confirmatory-authorized" : hasApplicablePhases ? "inconclusive-insufficient-independent-task-clusters" : "inconclusive-missing-applicable-variance-phase", zeroFurtherCalls: !authorized, policy: CONFIRMATORY_POWER_POLICY, observedVariancePhases: [...observedPhases].sort(), evidenceDigest: canonicalDigest(varianceEvidence), strata };
  return Object.freeze({ ...unsigned, authorizationDigest: canonicalDigest(unsigned) });
}

export function createAuthorizedConfirmatoryPlan({ authorization, taskIdsByStratum }) {
  const authMaterial = { ...authorization }; delete authMaterial.authorizationDigest;
  if (authorization?.status !== "authorized" || canonicalDigest(authMaterial) !== authorization.authorizationDigest || authorization.zeroFurtherCalls) failure("CONFIRMATORY_POWER_AUTHORIZATION_REQUIRED");
  const blocks = [];
  const allTaskIds = new Set();
  for (const result of authorization.strata) {
    const taskIds = taskIdsByStratum?.[result.stratum];
    if (!Array.isArray(taskIds) || new Set(taskIds).size !== taskIds.length || taskIds.length < result.authorizedTasks) failure("CONFIRMATORY_INDEPENDENT_TASK_FLOOR_UNMET");
    taskIds.forEach((taskId, index) => { if (typeof taskId !== "string" || taskId.length === 0 || allTaskIds.has(taskId)) failure("CONFIRMATORY_INDEPENDENT_TASK_FLOOR_UNMET"); allTaskIds.add(taskId); blocks.push({ stratum: result.stratum, taskId, candidateOrder: index % 2 === 0 ? [...API_BASELINE_CANDIDATES] : [...API_BASELINE_CANDIDATES].reverse() }); });
  }
  const trials = blocks.length * 2;
  const ceilings = { trials, maxConcurrency: 2, maxAttempts: 1, tokenBudgetPerTrial: 4000, maxTotalTokens: trials * 4000, wallClockSecondsPerTrial: 180, maxTotalWallClockSeconds: trials * 180, candidateNetworkRequestsPerTrial: 0, maxTotalCandidateNetworkRequests: 0, providerExecutionsPerTrial: 1, maxTotalProviderExecutions: trials, providerRetriesPerTrial: 0, maxTotalProviderRetries: 0, providerRequestsPerTrial: 1, maxTotalProviderRequests: trials, maxEstimatedCostUsdPerTrial: 0.25, maxTotalEstimatedCostUsd: trials * 0.25 };
  const unsigned = { schemaVersion: 1, phase: "api-confirmatory-authorized", authorizationDigest: authorization.authorizationDigest, blocks, ceilings };
  return Object.freeze({ ...unsigned, planDigest: canonicalDigest(unsigned) });
}
