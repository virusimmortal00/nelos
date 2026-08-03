import { canonicalDigest } from "./experimentation-contract/index.mjs";

export const EXPERIMENT_CI_SCHEMA_VERSION = 1;
export const TERMINAL_EVIDENCE_CLASSES = Object.freeze([
  "succeeded", "regression", "failed", "invalid", "inconclusive",
  "infrastructure-failure", "interrupted", "incompatible-provenance",
]);

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const LANES = {
  offline: { trigger: "pull-request", taskBudget: 0, repetitions: 0, shardCount: 1, maxConcurrency: 1, maxStarts: 0, network: "none", credentials: "none", isolatedHomes: true },
  smoke: { trigger: "pull-request", taskBudget: 1, repetitions: 1, shardCount: 1, maxConcurrency: 1, maxStarts: 2, network: "sealed-task-policy", credentials: "runtime-only", isolatedHomes: true },
  regression: { trigger: "nightly", taskBudget: 8, repetitions: 2, shardCount: 4, maxConcurrency: 2, maxStarts: 32, network: "sealed-task-policy", credentials: "runtime-only", isolatedHomes: true },
  powered: { trigger: "weekly-or-manual", taskBudget: 32, repetitions: 10, shardCount: 8, maxConcurrency: 4, maxStarts: 640, network: "sealed-task-policy", credentials: "runtime-only", isolatedHomes: true },
  "release-canary": { trigger: "release", taskBudget: 4, repetitions: 2, shardCount: 1, maxConcurrency: 1, maxStarts: 16, network: "sealed-task-policy", credentials: "runtime-only", isolatedHomes: true },
  desktop: { trigger: "manual-or-release", taskBudget: 1, repetitions: 1, shardCount: 1, maxConcurrency: 1, maxStarts: 1, network: "dedicated-worker-policy", credentials: "worker-lease", isolatedHomes: true },
};

export const EXPERIMENT_CI_LANES = Object.freeze(Object.fromEntries(
  Object.entries(LANES).map(([name, value]) => [name, Object.freeze({ schemaVersion: 1, name, ...value })]),
));

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function laneContract(name) {
  const lane = EXPERIMENT_CI_LANES[name];
  if (!lane) fail("UNKNOWN_LANE", `unknown experiment CI lane: ${name}`);
  return lane;
}

export function deterministicShard(trials, { index, count }) {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || index < 0 || index >= count) {
    fail("INVALID_SHARD", "shard index/count are invalid");
  }
  const identities = trials.map(({ trialId }) => trialId);
  if (identities.some((identity) => typeof identity !== "string") || new Set(identities).size !== identities.length) {
    fail("DUPLICATE_TRIAL", "trial identities must be present and globally unique before sharding");
  }
  return Object.freeze(trials
    .map((trial) => ({ trial, key: canonicalDigest({ trialId: trial.trialId }) }))
    .filter(({ key }) => Number.parseInt(key.slice(-8), 16) % count === index)
    .sort((left, right) => left.trial.trialId.localeCompare(right.trial.trialId))
    .map(({ trial }) => trial));
}

export function verifyShardFamily(trials, shards) {
  const expected = [...trials].map(({ trialId }) => trialId).sort();
  const actual = shards.flat().map(({ trialId }) => trialId).sort();
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    fail("INVALID_SHARD_FAMILY", "shards must be disjoint and cover the exact plan");
  }
  return { verified: true, trialCount: actual.length, familyDigest: canonicalDigest(actual) };
}

export function validateCacheEntries(entries) {
  for (const entry of entries) {
    if (!["image", "fixture"].includes(entry.kind) || entry.readOnly !== true || !SHA256.test(entry.digest)) {
      fail("MUTABLE_CACHE", "CI caches may contain only digest-bound read-only images or fixtures");
    }
  }
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

export function bindReleaseCanary(evidence) {
  const expected = ["codexVersion", "pluginVersion", "sourceCommit", "pluginDigest", "runtimeLockDigest", "schemaDigest", "compatibilityDigest"].sort();
  const actual = Object.keys(evidence).sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail("INCOMPATIBLE_PROVENANCE", "release evidence must match the closed canary schema");
  const requiredStrings = ["codexVersion", "pluginVersion", "sourceCommit"];
  const requiredDigests = ["pluginDigest", "runtimeLockDigest", "schemaDigest", "compatibilityDigest"];
  for (const field of requiredStrings) if (typeof evidence[field] !== "string" || evidence[field].length === 0) fail("INCOMPATIBLE_PROVENANCE", `release evidence is missing ${field}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(evidence.codexVersion) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(evidence.pluginVersion) || !/^[0-9a-f]{40}$/u.test(evidence.sourceCommit)) fail("INCOMPATIBLE_PROVENANCE", "release versions and source commit must be exact immutable identities");
  for (const field of requiredDigests) if (!SHA256.test(evidence[field])) fail("INCOMPATIBLE_PROVENANCE", `release evidence has invalid ${field}`);
  const normalized = { schemaVersion: 1, ...evidence };
  return Object.freeze({ ...normalized, canaryDigest: canonicalDigest(normalized) });
}

export function classifyTerminalEvidence(attempt) {
  if (attempt.failureKind === "infrastructure" || attempt.outcome === "infrastructure-failure") {
    return Object.freeze({ evidenceClass: "infrastructure-failure", productDecision: null, countsAsProductEvidence: false });
  }
  if (attempt.outcome === "interrupted") return Object.freeze({ evidenceClass: "interrupted", productDecision: null, countsAsProductEvidence: false });
  if (attempt.outcome === "incompatible-provenance") return Object.freeze({ evidenceClass: "incompatible-provenance", productDecision: null, countsAsProductEvidence: false });
  if (!TERMINAL_EVIDENCE_CLASSES.includes(attempt.outcome)) fail("INVALID_OUTCOME", `unknown terminal outcome: ${attempt.outcome}`);
  return Object.freeze({ evidenceClass: attempt.outcome, productDecision: attempt.outcome === "regression" ? "regression" : attempt.outcome === "succeeded" ? "success" : null, countsAsProductEvidence: ["succeeded", "regression", "failed", "invalid", "inconclusive"].includes(attempt.outcome) });
}

export async function runBudgetedShard({ trials, budget, completed = [], execute }) {
  const evidence = completed.map((attempt) => Object.freeze({ ...attempt, classification: classifyTerminalEvidence(attempt) }));
  const completedIds = new Set(evidence.map(({ trialId }) => trialId));
  let starts = 0;
  let cost = 0;
  let stoppedReason = null;
  for (const trial of trials) {
    if (completedIds.has(trial.trialId)) continue;
    if (starts >= budget.maxStarts || cost >= budget.maxCost) { stoppedReason = "budget-exhausted"; break; }
    const attempt = await execute(trial);
    starts += 1;
    cost += Number(attempt.cost ?? 0);
    evidence.push(Object.freeze({ ...attempt, trialId: trial.trialId, classification: classifyTerminalEvidence(attempt) }));
    if (attempt.outcome === "interrupted") { stoppedReason = "interrupted"; break; }
  }
  return Object.freeze({ evidence: Object.freeze(evidence), starts, cost, stoppedReason, pendingTrialIds: Object.freeze(trials.filter(({ trialId }) => !evidence.some((attempt) => attempt.trialId === trialId)).map(({ trialId }) => trialId)) });
}

export function regenerateEvidenceReport(evidence) {
  const ordered = [...evidence].sort((left, right) => left.trialId.localeCompare(right.trialId));
  const counts = Object.fromEntries(TERMINAL_EVIDENCE_CLASSES.map((name) => [name, ordered.filter(({ outcome }) => outcome === name).length]));
  const productDecisions = ordered.map(classifyTerminalEvidence).map(({ productDecision }) => productDecision).filter(Boolean);
  const report = { schemaVersion: 1, counts, productDecision: productDecisions.includes("regression") ? "regression" : productDecisions.includes("success") ? "success" : null, terminalTrialIds: ordered.map(({ trialId }) => trialId) };
  return Object.freeze({ ...report, reportDigest: canonicalDigest(report) });
}
