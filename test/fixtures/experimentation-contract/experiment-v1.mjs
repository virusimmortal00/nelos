import {
  deriveExperimentDigest,
  deriveExperimentIdentity,
} from "../../../src/experimentation-contract/index.mjs";

const D = (character) => `sha256:${character.repeat(64)}`;

export function buildExperimentV1(overrides = {}) {
  const value = {
    schemaVersion: 1,
    experimentId: `exp:${"0".repeat(64)}`,
    specRevision: 1,
    previousDigest: null,
    digest: D("0"),
    state: "draft",
    name: "Nelos coordination comparison",
    description: "Compare quality and cost under a sealed paired design.",
    hypothesis: {
      statement: "Nelos retains quality while reducing credit cost.",
      primaryMetric: "strict_pass_rate",
      decisionRule: "noninferior-quality-and-lower-credit-cost",
    },
    candidates: [
      {
        candidateId: "candidate:direct",
        adapter: "direct-codex",
        source: { commit: "1".repeat(40), digest: D("1") },
        model: { id: "model:gpt", revision: "2026-07-01", reasoningEffort: "medium" },
        plugins: [],
        configuration: [{ name: "orchestration", value: "disabled" }],
      },
      {
        candidateId: "candidate:nelos",
        adapter: "nelos",
        source: { commit: "2".repeat(40), digest: D("2") },
        model: { id: "model:gpt", revision: "2026-07-01", reasoningEffort: "medium" },
        plugins: [{ id: "plugin:nelos", version: "0.4.0", digest: D("3") }],
        configuration: [{ name: "orchestration", value: "enabled" }],
      },
    ],
    corpus: { releaseId: "corpus:milestone-one", digest: D("4") },
    design: {
      pairing: "task-seed-time-block",
      repetitions: 2,
      seedRoot: "public-seed-root",
      seedSchedule: [{ replicate: 1, seed: "seed-a" }, { replicate: 2, seed: "seed-b" }],
      multiplicityFamily: "primary",
    },
    limits: {
      wallClockSeconds: 3600,
      tokenBudget: 200000,
      toolCalls: 500,
      diskBytes: 1073741824,
      processes: 128,
      networkRequests: 0,
    },
    runtimeMatrix: [{
      runtimeLockId: "runtime:linux",
      digest: D("5"),
      backend: "oci-headless",
      platform: "linux-amd64",
      eligibleCandidateIds: ["candidate:direct", "candidate:nelos"],
      requiredCapabilities: ["git", "node"],
    }],
    graderBundle: { id: "grader-bundle:strict", digest: D("6") },
    exclusions: [{ exclusionId: "exclusion:known-flake", scope: "task", subjectId: "task:known-flake", reasonCode: "known_flake" }],
    metrics: {
      primary: { metricId: "strict_pass_rate", direction: "higher", aggregation: "rate" },
      secondary: [{ metricId: "credit_cost", direction: "lower", aggregation: "median" }],
      minimumDetectableEffect: { metricId: "strict_pass_rate", absolute: 0.05, power: 0.8, alpha: 0.05 },
    },
    decisionRules: {
      promotion: { kind: "noninferiority", metricId: "strict_pass_rate", threshold: 0.02, minimumSamples: 20 },
      regression: { kind: "relative", metricId: "credit_cost", threshold: 0.1, minimumSamples: 20 },
      stop: { kind: "fixed-sample", metricId: "strict_pass_rate", threshold: 40, minimumSamples: 40 },
      invalidation: { maxInvalidFraction: 0.1, asymmetricInvalidity: "invalidate-comparison", reasonCodes: ["contamination", "grader_failure"] },
    },
    ...structuredClone(overrides),
  };
  value.experimentId = deriveExperimentIdentity(value);
  value.digest = deriveExperimentDigest(value);
  return value;
}

export const validExperimentV1 = buildExperimentV1();

export const invalidExperimentFixturesV1 = Object.freeze([
  { name: "unknown top-level", code: "UNKNOWN_FIELD", path: "/surprise", mutate: (v) => { v.surprise = true; } },
  { name: "unknown nested", code: "UNKNOWN_FIELD", path: "/candidates/0/model/surprise", mutate: (v) => { v.candidates[0].model.surprise = true; } },
  { name: "missing required", code: "REQUIRED_FIELD", path: "/hypothesis", mutate: (v) => { delete v.hypothesis; } },
  { name: "invalid enum", code: "INVALID_ENUM", path: "/candidates/0/adapter", mutate: (v) => { v.candidates[0].adapter = "unknown"; } },
  { name: "duplicate candidates", code: "DUPLICATE_IDENTITY", path: "/candidates/1", mutate: (v) => { v.candidates[1].candidateId = v.candidates[0].candidateId; } },
  { name: "duplicate runtime eligibility", code: "DUPLICATE_IDENTITY", path: "/runtimeMatrix/0/eligibleCandidateIds/1", mutate: (v) => { v.runtimeMatrix[0].eligibleCandidateIds[1] = v.runtimeMatrix[0].eligibleCandidateIds[0]; } },
  { name: "duplicate exclusions", code: "DUPLICATE_IDENTITY", path: "/exclusions/1", mutate: (v) => { v.exclusions.push(structuredClone(v.exclusions[0])); } },
  { name: "duplicate metrics", code: "DUPLICATE_IDENTITY", path: "/metrics/secondary/1", mutate: (v) => { v.metrics.secondary.push(structuredClone(v.metrics.secondary[0])); } },
  { name: "bounds", code: "OUT_OF_BOUNDS", path: "/design/repetitions", mutate: (v) => { v.design.repetitions = 0; } },
  { name: "malformed digest", code: "INVALID_DIGEST", path: "/corpus/digest", mutate: (v) => { v.corpus.digest = "sha256:BAD"; } },
  { name: "unsupported version", code: "UNSUPPORTED_SCHEMA_VERSION", path: "/schemaVersion", mutate: (v) => { v.schemaVersion = 2; } },
]);
