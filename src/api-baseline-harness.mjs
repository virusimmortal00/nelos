import {
  canonicalDigest,
  deriveExperimentDigest,
  deriveExperimentIdentity,
  transitionExperiment,
} from "./experimentation-contract/index.mjs";
import { createStarterDevelopmentRelease, createStarterTaskPackage, starterGraderBundle } from "./experimentation-corpus/index.mjs";
import { expandExperimentPlan, validateRunnerManifest } from "./experiment-runner.mjs";

export const API_BASELINE_FAMILIES = Object.freeze([
  "localized-repair", "cross-cutting-feature", "multi-module-migration", "planning", "orchestration-restart",
]);
export const API_BASELINE_CANDIDATES = Object.freeze(["candidate:api-repeat-a", "candidate:api-repeat-b"]);
export const API_BASELINE_RUN_PREFIX = "run:api-baseline-";

const MODE_CEILINGS = Object.freeze({
  canary: Object.freeze({ repetitions: 2, trials: 20, tokenBudget: 4000, wallClockSeconds: 180, maxConcurrency: 1, maxAttempts: 1, candidateNetworkRequestsPerTrial: 0, providerExecutionsPerTrial: 1 }),
  confirmatory: Object.freeze({ repetitions: 10, trials: 100, tokenBudget: 4000, wallClockSeconds: 180, maxConcurrency: 2, maxAttempts: 1, candidateNetworkRequestsPerTrial: 0, providerExecutionsPerTrial: 1 }),
});

function failure(code) { throw Object.assign(new Error(code), { code }); }
function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) failure(code);
}

function candidate(candidateId, repeatArm, { sourceCommit, requestedModel }) {
  return {
    candidateId,
    adapter: "direct-codex",
    source: { commit: sourceCommit, digest: canonicalDigest({ sourceCommit, adapter: "api-codex-v1" }) },
    model: { id: requestedModel.id, revision: requestedModel.revision, reasoningEffort: requestedModel.reasoningEffort },
    plugins: [],
    configuration: [
      { name: "authentication", value: "runtime-api-key" },
      { name: "developer-config", value: "absent" },
      { name: "repeat-arm", value: repeatArm },
      { name: "user-config", value: "ignored" },
    ],
  };
}

function seedSchedule(mode, repetitions) {
  return Array.from({ length: repetitions }, (_, index) => ({ replicate: index + 1, seed: `api-${mode}-${String(index + 1).padStart(2, "0")}` }));
}

function balanceOrder(taskId, seed, index) {
  const hashParity = Number.parseInt(canonicalDigest({ taskId, allocation: "candidate-order" }).slice(-2), 16) % 2;
  const first = (index + hashParity) % 2;
  void seed;
  return first === 0 ? [...API_BASELINE_CANDIDATES] : [...API_BASELINE_CANDIDATES].reverse();
}

function sealedSchedule(manifest) {
  const plan = expandExperimentPlan(manifest);
  const byBlockCandidate = new Map(plan.trials.map((trial) => [`${trial.taskId}|${trial.seed}|${trial.candidateId}`, trial]));
  const blocks = [];
  for (const task of manifest.tasks) {
    manifest.experiment.design.seedSchedule.forEach(({ seed, replicate }, index) => {
      const candidateOrder = balanceOrder(task.taskId, seed, index);
      blocks.push({
        blockId: canonicalDigest({ taskId: task.taskId, seed, replicate }), taskId: task.taskId, seed, replicate, candidateOrder,
        trialIds: candidateOrder.map((candidateId) => byBlockCandidate.get(`${task.taskId}|${seed}|${candidateId}`).trialId),
      });
    });
  }
  const unsigned = { schemaVersion: 1, pairing: "task-seed", blocks, trialCount: blocks.length * 2, runnerPlanDigest: plan.planDigest };
  return Object.freeze({ ...unsigned, scheduleDigest: canonicalDigest(unsigned) });
}

export function createApiBaselineBundle({ mode, sourceCommit, requestedModel, runtime }) {
  const ceilings = MODE_CEILINGS[mode];
  if (!ceilings) failure("INVALID_API_BASELINE_MODE");
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit ?? "")) failure("INVALID_SOURCE_COMMIT");
  exactObject(requestedModel, ["id", "revision", "reasoningEffort"], "INVALID_REQUESTED_ROUTE");
  if (!/^model:[A-Za-z0-9._-]+$/u.test(requestedModel.id) || requestedModel.id === "model:product-default" || requestedModel.revision === "unavailable") failure("INVALID_REQUESTED_ROUTE");
  exactObject(runtime, ["backend", "platform", "runtimeVersion", "runtimeDigest"], "INVALID_RUNTIME_PROVENANCE");
  if (!/^sha256:[0-9a-f]{64}$/u.test(runtime.runtimeDigest ?? "")) failure("INVALID_RUNTIME_PROVENANCE");
  const { release } = createStarterDevelopmentRelease();
  const tasks = API_BASELINE_FAMILIES.map((family) => createStarterTaskPackage(family).task);
  const grader = starterGraderBundle();
  const runtimeMaterial = { ...runtime, routeControl: "explicit-model-and-effort", credentialSource: "approved-runtime-file", developerConfiguration: "absent" };
  const runtimeDigest = canonicalDigest(runtimeMaterial);
  let experiment = {
    schemaVersion: 1, experimentId: `exp:${"0".repeat(64)}`, specRevision: 1, previousDigest: null, digest: `sha256:${"0".repeat(64)}`, state: "draft",
    name: `API-controlled direct Codex ${mode} baseline`,
    description: "Independent route-controlled API repeat-arm baseline with sealed execution and provenance.",
    hypothesis: { statement: "Identical direct Codex API repeat arms have comparable strict-pass behavior under an explicit route.", primaryMetric: "strict_pass_rate", decisionRule: "noninferiority" },
    candidates: API_BASELINE_CANDIDATES.map((id, index) => candidate(id, index === 0 ? "a" : "b", { sourceCommit, requestedModel })),
    corpus: { releaseId: release.releaseId, digest: release.digest },
    design: { pairing: "task-seed", repetitions: ceilings.repetitions, seedRoot: `nelos-api-baseline-${mode}-v1`, seedSchedule: seedSchedule(mode, ceilings.repetitions), multiplicityFamily: `api-baseline-${mode}` },
    limits: { wallClockSeconds: ceilings.wallClockSeconds, tokenBudget: ceilings.tokenBudget, toolCalls: 50, diskBytes: 536870912, processes: 8, networkRequests: 0 },
    runtimeMatrix: [{ runtimeLockId: `runtime:${runtimeDigest.slice(7)}`, digest: runtimeDigest, backend: runtime.backend, platform: runtime.platform, eligibleCandidateIds: [...API_BASELINE_CANDIDATES], requiredCapabilities: ["git", "node"] }],
    graderBundle: { id: grader.graderBundleId, digest: grader.digest }, exclusions: [],
    metrics: { primary: { metricId: "strict_pass_rate", direction: "higher", aggregation: "rate" }, secondary: [{ metricId: "candidate_failure_rate", direction: "lower", aggregation: "rate" }, { metricId: "input_tokens", direction: "lower", aggregation: "median" }, { metricId: "output_tokens", direction: "lower", aggregation: "median" }, { metricId: "terminal_wall_ms", direction: "lower", aggregation: "median" }], minimumDetectableEffect: { metricId: "strict_pass_rate", absolute: 0.2, power: 0.8, alpha: 0.05 } },
    decisionRules: { promotion: { kind: "noninferiority", metricId: "strict_pass_rate", threshold: 0.2, minimumSamples: 10 }, regression: { kind: "absolute", metricId: "candidate_failure_rate", threshold: 0.2, minimumSamples: 10 }, stop: { kind: "fixed-sample", metricId: "strict_pass_rate", threshold: ceilings.trials, minimumSamples: ceilings.trials }, invalidation: { maxInvalidFraction: 0.1, asymmetricInvalidity: "invalidate-comparison", reasonCodes: ["contamination", "grader_failure", "route_mismatch"] } },
  };
  experiment.experimentId = deriveExperimentIdentity(experiment);
  experiment.digest = deriveExperimentDigest(experiment);
  experiment = transitionExperiment(transitionExperiment(experiment, "reviewed"), "sealed");
  const root = new URL("..", import.meta.url).pathname;
  const runnerManifest = { schemaVersion: 1, experiment, tasks, adapters: { "direct-codex": { command: [process.execPath, `${root}scripts/api-codex-adapter.mjs`], environment: {}, version: "api-codex-v1" }, nelos: { command: [process.execPath, `${root}scripts/test-support/fake-experiment-adapter.mjs`], environment: {}, version: "unused-v1" } }, policy: { maxConcurrency: ceilings.maxConcurrency, perAdapterConcurrency: { "direct-codex": ceilings.maxConcurrency, nelos: 1 }, leaseMs: (ceilings.wallClockSeconds + 30) * 1000, timeoutMs: ceilings.wallClockSeconds * 1000, maxAttempts: ceilings.maxAttempts } };
  const executionSchedule = sealedSchedule(runnerManifest);
  const decisionPolicy = { schemaVersion: 1, endpoints: [{ metricId: "strict_pass_rate", role: "primary", direction: "higher" }, { metricId: "candidate_failure_rate", role: "safety", direction: "lower" }], minimumDetectableEffect: { metricId: "strict_pass_rate", absolute: 0.2 }, alpha: 0.05, targetPower: 0.8, samplingUnit: "task", dependence: "task-level-paired-cluster", criticalStrata: [...API_BASELINE_FAMILIES], minimumPairedSamplesPerCriticalStratum: 10 };
  const identity = { phase: "api-controlled-baseline", mode, runIdPrefix: API_BASELINE_RUN_PREFIX, storeNamespace: "api-baseline-store-v1", evidenceRootName: "api-baseline-evidence", reportKind: "api-baseline-report", requestedRoute: { modelId: requestedModel.id, modelRevision: requestedModel.revision, reasoningEffort: requestedModel.reasoningEffort }, runtimeProvenance: runtimeMaterial };
  const controls = { ceilings: { ...ceilings }, sealedTrialCount: executionSchedule.trialCount, expansion: "forbidden" };
  const unsigned = { schemaVersion: 1, identity, runnerManifest, executionSchedule, decisionPolicy, controls };
  return Object.freeze({ ...unsigned, bundleDigest: canonicalDigest(unsigned) });
}

export function validateApiBaselineBundle(bundle) {
  exactObject(bundle, ["schemaVersion", "identity", "runnerManifest", "executionSchedule", "decisionPolicy", "controls", "bundleDigest"], "INVALID_API_BASELINE_BUNDLE");
  const candidates = bundle.runnerManifest?.experiment?.candidates ?? [];
  if (candidates.length !== 2 || candidates.some(({ adapter }) => adapter !== "direct-codex") || candidates.some(({ candidateId }) => /nelos/iu.test(candidateId))) failure("INVALID_API_BASELINE_ARM");
  const material = { ...bundle }; delete material.bundleDigest;
  if (bundle.schemaVersion !== 1 || canonicalDigest(material) !== bundle.bundleDigest) failure("ALTERED_API_BASELINE_BUNDLE");
  validateRunnerManifest(bundle.runnerManifest);
  const armMaterial = candidates.map((entry) => ({ ...entry, candidateId: "candidate:repeat", configuration: entry.configuration.map((item) => item.name === "repeat-arm" ? { ...item, value: "repeat" } : item) }));
  if (canonicalDigest(armMaterial[0]) !== canonicalDigest(armMaterial[1])) failure("NONIDENTICAL_API_BASELINE_ARMS");
  if (bundle.identity.phase !== "api-controlled-baseline" || bundle.identity.runIdPrefix !== API_BASELINE_RUN_PREFIX || bundle.identity.requestedRoute.modelId === "model:product-default") failure("SIGNED_IN_API_PHASE_COLLISION");
  const expected = sealedSchedule(bundle.runnerManifest);
  if (canonicalDigest(bundle.executionSchedule) !== canonicalDigest(expected)) failure("ALTERED_API_BASELINE_SCHEDULE");
  const ceiling = MODE_CEILINGS[bundle.identity.mode];
  if (!ceiling || bundle.executionSchedule.trialCount !== ceiling.trials || canonicalDigest(bundle.controls.ceilings) !== canonicalDigest(ceiling) || bundle.controls.sealedTrialCount !== ceiling.trials || bundle.controls.expansion !== "forbidden") failure("API_BASELINE_CEILING_EXCEEDED");
  if (bundle.runnerManifest.policy.maxConcurrency > ceiling.maxConcurrency || bundle.runnerManifest.policy.maxAttempts > ceiling.maxAttempts || bundle.runnerManifest.experiment.limits.tokenBudget > ceiling.tokenBudget || bundle.runnerManifest.experiment.limits.wallClockSeconds > ceiling.wallClockSeconds) failure("API_BASELINE_CEILING_EXCEEDED");
  return bundle;
}

export function assertPowerDecisionReady({ bundle, observations }) {
  validateApiBaselineBundle(bundle);
  const policy = bundle.decisionPolicy;
  const expectedEndpoints = [{ metricId: "strict_pass_rate", role: "primary", direction: "higher" }, { metricId: "candidate_failure_rate", role: "safety", direction: "lower" }];
  if (policy.schemaVersion !== 1 || canonicalDigest(policy.endpoints) !== canonicalDigest(expectedEndpoints)
    || policy.minimumDetectableEffect?.metricId !== "strict_pass_rate" || policy.minimumDetectableEffect.absolute !== 0.2
    || policy.minimumPairedSamplesPerCriticalStratum < 10 || policy.samplingUnit !== "task"
    || policy.dependence !== "task-level-paired-cluster" || policy.alpha !== 0.05 || policy.targetPower !== 0.8
    || canonicalDigest(policy.criticalStrata) !== canonicalDigest(API_BASELINE_FAMILIES)) failure("INVALID_POWER_POLICY");
  if (!Array.isArray(observations)) failure("INVALID_POWER_OBSERVATIONS");
  for (const stratum of policy.criticalStrata) {
    const blocks = new Map();
    for (const item of observations.filter((entry) => entry.stratum === stratum)) {
      const present = blocks.get(item.blockId) ?? new Set(); present.add(item.candidateId); blocks.set(item.blockId, present);
    }
    const paired = [...blocks.values()].filter((ids) => API_BASELINE_CANDIDATES.every((id) => ids.has(id))).length;
    if (paired < policy.minimumPairedSamplesPerCriticalStratum) failure("INSUFFICIENT_PAIRED_SAMPLES");
  }
  return Object.freeze({ ready: true, endpoints: policy.endpoints, samplingUnit: policy.samplingUnit, dependence: policy.dependence });
}
