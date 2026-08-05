import { canonicalDigest } from "./experimentation-contract/index.mjs";
import { API_BASELINE_FAMILIES, CANARY_FAMILY, validateApiBaselineBundle } from "./api-baseline-harness.mjs";

function failure(code) { throw Object.assign(new Error(code), { code }); }

function repeatArms(candidates) {
  if (!Array.isArray(candidates) || candidates.length !== 2) failure("INVALID_VARIANCE_CANDIDATES");
  const arms = new Map();
  for (const candidate of candidates) {
    const matches = candidate?.configuration?.filter(({ name }) => name === "repeat-arm") ?? [];
    if (typeof candidate?.candidateId !== "string" || matches.length !== 1 || !["a", "b"].includes(matches[0].value) || arms.has(candidate.candidateId)) failure("INVALID_VARIANCE_CANDIDATES");
    arms.set(candidate.candidateId, matches[0].value);
  }
  if (new Set(arms.values()).size !== 2) failure("INVALID_VARIANCE_CANDIDATES");
  return arms;
}

function strictPass(measurements) {
  const matches = measurements?.filter(({ metricId }) => metricId === "strict_pass_rate") ?? [];
  if (matches.length !== 1 || (matches[0].value !== 0 && matches[0].value !== 1)) failure("INVALID_VARIANCE_MEASUREMENT");
  return matches[0].value;
}

function completePairs(rows) {
  const blocks = new Map();
  for (const row of rows) {
    const key = `${row.phase}|${row.stratum}|${row.taskId}|${row.blockId}`;
    const block = blocks.get(key) ?? new Map();
    if (block.has(row.arm)) failure("DUPLICATE_VARIANCE_OBSERVATION");
    block.set(row.arm, row); blocks.set(key, block);
  }
  return [...blocks.values()].filter((block) => block.has("a") && block.has("b")).flatMap((block) => [block.get("a"), block.get("b")]);
}

function signedInRows(input) {
  if (input?.schemaVersion !== 1 || !Array.isArray(input.plan?.trials) || !Array.isArray(input.attempts) || !Array.isArray(input.analysisPolicy?.stratumAssignments)) failure("INVALID_SIGNED_IN_VARIANCE_INPUT");
  const arms = repeatArms(input.experiment?.candidates);
  const strata = new Map();
  for (const assignment of input.analysisPolicy.stratumAssignments) {
    if (typeof assignment?.taskId !== "string" || !Array.isArray(assignment.strata) || assignment.strata.length !== 1 || !API_BASELINE_FAMILIES.includes(assignment.strata[0]) || strata.has(assignment.taskId)) failure("INVALID_SIGNED_IN_VARIANCE_INPUT");
    strata.set(assignment.taskId, assignment.strata[0]);
  }
  const trials = new Map();
  for (const trial of input.plan.trials) {
    if (typeof trial?.trialId !== "string" || trials.has(trial.trialId) || !strata.has(trial.taskId) || !arms.has(trial.candidateId) || typeof trial.seed !== "string" || !Number.isSafeInteger(trial.replicate)) failure("INVALID_SIGNED_IN_VARIANCE_INPUT");
    trials.set(trial.trialId, trial);
  }
  const rows = [];
  const authoritative = new Set();
  for (const attempt of input.attempts) {
    if (!attempt?.authoritative) continue;
    const trial = trials.get(attempt.trialId);
    if (!trial || authoritative.has(attempt.trialId) || attempt.candidateId !== trial.candidateId || !attempt.evidenceComplete || !attempt.routeMatch) failure("INVALID_SIGNED_IN_VARIANCE_ATTEMPT");
    authoritative.add(attempt.trialId);
    rows.push({
      phase: "signed-in-pilot",
      stratum: strata.get(trial.taskId),
      taskId: trial.taskId,
      blockId: canonicalDigest({ phase: "signed-in-pilot", taskId: trial.taskId, seed: trial.seed, replicate: trial.replicate }),
      arm: arms.get(trial.candidateId),
      value: strictPass(attempt.measurements),
    });
  }
  return completePairs(rows);
}

function apiCanaryRows(bundle, results) {
  validateApiBaselineBundle(bundle);
  if (!Array.isArray(results)) failure("INVALID_API_VARIANCE_RESULTS");
  const arms = repeatArms(bundle.runnerManifest.experiment.candidates);
  const scheduled = new Map();
  for (const block of bundle.executionSchedule.blocks) {
    for (let index = 0; index < block.trialIds.length; index += 1) {
      const trialId = block.trialIds[index];
      if (scheduled.has(trialId)) failure("INVALID_API_VARIANCE_SCHEDULE");
      scheduled.set(trialId, { blockId: block.blockId, taskId: block.taskId, candidateId: block.candidateOrder[index] });
    }
  }
  const rows = [];
  const observed = new Set();
  for (const result of results) {
    const expected = scheduled.get(result?.trialId);
    if (!expected || observed.has(result.trialId) || result.blockId !== expected.blockId || result.candidateId !== expected.candidateId || !result.artifacts?.some(({ id }) => id === "runtime-provider-receipt")) failure("INVALID_API_VARIANCE_RESULT");
    for (const [field, value] of Object.entries(bundle.identity.requestedRoute)) if (result.observedRoute?.[field] !== value) failure("INVALID_API_VARIANCE_ROUTE");
    observed.add(result.trialId);
    rows.push({ phase: "api-canary", stratum: CANARY_FAMILY, taskId: expected.taskId, blockId: expected.blockId, arm: arms.get(result.candidateId), value: strictPass(result.measurements) });
  }
  if (observed.size !== scheduled.size) failure("INCOMPLETE_API_VARIANCE_RESULTS");
  return completePairs(rows);
}

export function normalizeApiBaselineVarianceEvidence({ signedInInput, apiBundle, apiResults }) {
  const observations = [...signedInRows(signedInInput), ...apiCanaryRows(apiBundle, apiResults)];
  observations.sort((left, right) => [left.phase, left.stratum, left.taskId, left.blockId, left.arm].join("|").localeCompare([right.phase, right.stratum, right.taskId, right.blockId, right.arm].join("|")));
  return Object.freeze(observations.map((observation) => Object.freeze(observation)));
}
