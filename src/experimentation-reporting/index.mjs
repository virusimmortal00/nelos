import { createHash } from "node:crypto";
import { canonicalDigest } from "../experimentation-contract/index.mjs";

export const REPORT_SCHEMA_VERSION = 1;
export const REQUIRED_METRIC_CATEGORIES = Object.freeze(["quality", "reliability", "latency", "token", "tool", "resource", "credit", "cost"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TERMINAL = new Set(["succeeded", "failed", "invalid", "cancelled", "inconclusive"]);
const MISSING_RULES = new Set(["zero", "censored-limit", "report-missing", "reject"]);
const DENOMINATORS = new Set(["all-started", "valid-started", "terminal-trials"]);

export class ExperimentReportingError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "ExperimentReportingError"; this.code = code; this.details = Object.freeze({ ...details }); }
}
function fail(code, message, details) { throw new ExperimentReportingError(code, message, details); }
function plain(value, label) { const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined; if (!value || typeof value !== "object" || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) fail("INVALID_REPORT_INPUT", `${label} must be a plain object`); }
function fields(value, expected, label) {
  plain(value, label); const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) fail("INVALID_REPORT_INPUT", `${label} fields must match the closed schema`, { actual, expected: wanted });
}
function finite(value, label, minimum = -Infinity) { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) fail("INVALID_REPORT_INPUT", `${label} must be a finite number`); }
function round(value) { return Number.isFinite(value) ? Number(value.toFixed(12)) : null; }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function variance(values) { if (values.length < 2) return 0; const average = mean(values); return values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1); }
function quantile(values, probability) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * probability; const lower = Math.floor(position); return sorted[lower] + (position - lower) * ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]); }
function validateDigestRecord(record, digestField, label) {
  if (!DIGEST.test(record[digestField])) fail("INCOMPATIBLE_PROVENANCE", `${label}.${digestField} is invalid`);
  const unsigned = { ...record }; delete unsigned[digestField];
  if (canonicalDigest(unsigned) !== record[digestField]) fail("ALTERED_INPUT", `${label}.${digestField} does not match its contents`);
}

function validatePolicy(policy) {
  fields(policy, ["schemaVersion", "baselineCandidateId", "candidateId", "primaryMetricId", "confidenceLevel", "bootstrapSamples", "permutationSamples", "criticalStrata", "stratumAssignments", "metricDefinitions", "digest"], "analysisPolicy");
  if (policy.schemaVersion !== 1 || policy.baselineCandidateId === policy.candidateId || typeof policy.baselineCandidateId !== "string" || typeof policy.candidateId !== "string") fail("INVALID_REPORT_INPUT", "analysisPolicy identity is invalid");
  finite(policy.confidenceLevel, "analysisPolicy.confidenceLevel", 0.5); if (policy.confidenceLevel >= 1) fail("INVALID_REPORT_INPUT", "confidenceLevel must be below one");
  for (const name of ["bootstrapSamples", "permutationSamples"]) if (!Number.isSafeInteger(policy[name]) || policy[name] < 100) fail("INVALID_REPORT_INPUT", `${name} must be at least 100`);
  if (!Array.isArray(policy.criticalStrata) || new Set(policy.criticalStrata).size !== policy.criticalStrata.length) fail("INVALID_REPORT_INPUT", "criticalStrata must be unique");
  if (!Array.isArray(policy.stratumAssignments)) fail("INVALID_REPORT_INPUT", "stratumAssignments must be an array");
  const assignedTasks = new Set();
  for (const [index, assignment] of policy.stratumAssignments.entries()) {
    fields(assignment, ["taskId", "strata"], `stratumAssignments[${index}]`);
    if (typeof assignment.taskId !== "string" || assignedTasks.has(assignment.taskId) || !Array.isArray(assignment.strata) || new Set(assignment.strata).size !== assignment.strata.length || assignment.strata.some((stratum) => !policy.criticalStrata.includes(stratum))) fail("INVALID_REPORT_INPUT", "stratum assignment is invalid");
    assignedTasks.add(assignment.taskId);
  }
  if (!Array.isArray(policy.metricDefinitions) || !policy.metricDefinitions.length) fail("INVALID_REPORT_INPUT", "metricDefinitions must be non-empty");
  const seen = new Set();
  for (const [index, metric] of policy.metricDefinitions.entries()) {
    fields(metric, ["metricId", "category", "direction", "aggregation", "denominator", "missingRule", "limitMetricId", "practicalBenefit", "noninferiorityMargin", "regressionMargin", "multiplicityFamily", "critical"], `metricDefinitions[${index}]`);
    if (typeof metric.metricId !== "string" || seen.has(metric.metricId)) fail("DUPLICATE_METRIC", "metric identities must be unique"); seen.add(metric.metricId);
    if (!REQUIRED_METRIC_CATEGORIES.includes(metric.category) || !["higher", "lower"].includes(metric.direction) || !["mean", "rate", "median", "p90", "sum", "restricted-mean"].includes(metric.aggregation) || !DENOMINATORS.has(metric.denominator) || !MISSING_RULES.has(metric.missingRule)) fail("INVALID_REPORT_INPUT", `metric ${metric.metricId} is invalid`);
    if ((metric.missingRule === "censored-limit") !== (typeof metric.limitMetricId === "string")) { if (metric.limitMetricId !== null || metric.missingRule === "censored-limit") fail("INVALID_REPORT_INPUT", `metric ${metric.metricId} limit rule is invalid`); }
    finite(metric.practicalBenefit, `${metric.metricId}.practicalBenefit`, 0); finite(metric.noninferiorityMargin, `${metric.metricId}.noninferiorityMargin`, 0); finite(metric.regressionMargin, `${metric.metricId}.regressionMargin`, 0);
    if (typeof metric.multiplicityFamily !== "string" || typeof metric.critical !== "boolean") fail("INVALID_REPORT_INPUT", `metric ${metric.metricId} decision fields are invalid`);
  }
  for (const category of REQUIRED_METRIC_CATEGORIES) if (!policy.metricDefinitions.some((metric) => metric.category === category)) fail("MISSING_REQUIRED_METRIC", `analysis policy has no ${category} metric`);
  if (!seen.has(policy.primaryMetricId)) fail("INVALID_REPORT_INPUT", "primaryMetricId must reference a metric definition");
  validateDigestRecord(policy, "digest", "analysisPolicy");
}

export function sealAnalysisPolicy(policy) { const unsigned = structuredClone(policy); delete unsigned.digest; const sealed = { ...unsigned, digest: canonicalDigest(unsigned) }; validatePolicy(sealed); return deepFreeze(sealed); }

export function createDefaultAnalysisPolicy({ baselineCandidateId, candidateId, primaryMetricId = "strict_pass_rate", confidenceLevel = 0.95, bootstrapSamples = 2000, permutationSamples = 4096, criticalStrata = [], stratumAssignments = [] }) {
  const metric = (metricId, category, options = {}) => ({ metricId, category, direction: "lower", aggregation: "mean", denominator: "all-started", missingRule: "reject", limitMetricId: null, practicalBenefit: 0, noninferiorityMargin: 0, regressionMargin: 0, multiplicityFamily: "primary", critical: false, ...options });
  return sealAnalysisPolicy({ schemaVersion: 1, baselineCandidateId, candidateId, primaryMetricId, confidenceLevel, bootstrapSamples, permutationSamples, criticalStrata, stratumAssignments, metricDefinitions: [
    metric("strict_pass_rate", "quality", { direction: "higher", aggregation: "rate", denominator: "terminal-trials", missingRule: "zero", practicalBenefit: 0.1, noninferiorityMargin: 0.02, critical: true }),
    metric("completion_without_retry", "reliability", { direction: "higher", aggregation: "rate", missingRule: "zero", noninferiorityMargin: 0.02, critical: true }),
    metric("candidate_failure_rate", "reliability", { aggregation: "rate", denominator: "valid-started", missingRule: "zero", noninferiorityMargin: 0.02, critical: true }),
    metric("timeout_rate", "reliability", { aggregation: "rate", denominator: "valid-started", missingRule: "zero", noninferiorityMargin: 0.02, critical: true }),
    metric("route_mismatch_rate", "reliability", { aggregation: "rate", missingRule: "zero", critical: true }),
    metric("safety_violation_rate", "reliability", { aggregation: "rate", missingRule: "zero", critical: true }),
    metric("terminal_wall_ms", "latency", { aggregation: "restricted-mean", missingRule: "censored-limit", limitMetricId: "wall_limit_ms" }),
    metric("input_tokens", "token"), metric("cached_input_tokens", "token"), metric("output_tokens", "token"), metric("reasoning_output_tokens", "token"),
    metric("tool_calls", "tool"), metric("tool_failures", "tool"),
    metric("cpu_ms", "resource"), metric("peak_memory_bytes", "resource", { aggregation: "p90" }), metric("disk_bytes", "resource"), metric("network_bytes", "resource"), metric("concurrency_seconds", "resource"),
    metric("estimated_standard_credits", "credit"), metric("observed_billing_credits", "credit", { missingRule: "report-missing" }),
    metric("observed_currency_cost", "cost", { missingRule: "report-missing" }),
  ] });
}

function validateInput(input) {
  fields(input, ["schemaVersion", "experiment", "plan", "analysisPolicy", "attempts"], "report input");
  if (input.schemaVersion !== 1) fail("INVALID_REPORT_INPUT", "unsupported report input schema version");
  if (!Array.isArray(input.attempts) || !input.attempts.length) fail("INVALID_REPORT_INPUT", "attempts must be non-empty");
  validatePolicy(input.analysisPolicy); validateDigestRecord(input.plan, "planDigest", "plan");
  if (input.plan.experimentDigest !== input.experiment.digest || input.plan.experimentId !== input.experiment.experimentId) fail("INCOMPATIBLE_PROVENANCE", "plan and experiment identities differ");
  const trialById = new Map(input.plan.trials.map((trial) => [trial.trialId, trial])); const trialIds = new Set(trialById.keys()); const attempts = new Set(); const operations = new Set(); const attemptNumbers = new Map();
  for (const [index, attempt] of input.attempts.entries()) {
    plain(attempt, `attempts[${index}]`); validateDigestRecord(attempt, "bundleDigest", `attempts[${index}]`);
    if (attempt.planDigest !== input.plan.planDigest || attempt.manifestDigest !== input.plan.manifestDigest || !trialIds.has(attempt.trialId) || attempt.candidateId !== trialById.get(attempt.trialId)?.candidateId) fail("INCOMPATIBLE_PROVENANCE", "attempt does not belong to the accepted plan", { index });
    const key = `${attempt.trialId}\u0000${attempt.attempt}`; if (attempts.has(key) || operations.has(attempt.operationId)) fail("DUPLICATE_TRIAL", "duplicate attempt or operation identity prevents reporting", { index });
    attempts.add(key); operations.add(attempt.operationId); const numbers = attemptNumbers.get(attempt.trialId) ?? []; numbers.push(attempt.attempt); attemptNumbers.set(attempt.trialId, numbers); if (!Array.isArray(attempt.measurements)) fail("INVALID_REPORT_INPUT", "attempt measurements must be an array", { index });
  }
  for (const trialId of trialIds) {
    const numbers = (attemptNumbers.get(trialId) ?? []).sort((a, b) => a - b);
    if (!numbers.length) fail("MISSING_TRIAL", "every sealed trial must remain visible in accepted attempt manifests", { trialId });
    if (numbers.some((number, index) => number !== index + 1)) fail("MISSING_ATTEMPT", "attempt numbering must be contiguous so retries cannot be silently excluded", { trialId, attempts: numbers });
  }
  const candidateIds = new Set(input.plan.trials.map(({ candidateId }) => candidateId));
  if (!candidateIds.has(input.analysisPolicy.baselineCandidateId) || !candidateIds.has(input.analysisPolicy.candidateId)) fail("INCOMPATIBLE_PROVENANCE", "analysis candidates are absent from the plan");
}

function measurementMap(attempt) {
  const values = new Map();
  for (const entry of attempt.measurements) {
    if (!entry || typeof entry.metricId !== "string" || values.has(entry.metricId) || (entry.value !== null && (typeof entry.value !== "number" || !Number.isFinite(entry.value)))) fail("INVALID_MEASUREMENT", "measurements must be unique finite values or null", { trialId: attempt.trialId, attempt: attempt.attempt });
    values.set(entry.metricId, entry.value);
  }
  return values;
}
function classify(attempt) {
  const values = measurementMap(attempt); const bool = (id) => values.get(id) === 1; const contaminated = bool("contaminated");
  return { values, timedOut: bool("timeout") || values.get("terminal_status") === 408, contaminated, infrastructureInvalid: attempt.outcome === "invalid" && !contaminated && attempt.routeMatch !== false && !bool("candidate_invalid"), safety: bool("safety_violation"), duplicateEffect: bool("duplicate_effect") };
}
function eligible(metric, attempt, classification, terminal) { if (metric.denominator === "all-started") return true; if (metric.denominator === "valid-started") return !classification.infrastructureInvalid && !classification.contaminated; return terminal === attempt && TERMINAL.has(attempt.outcome) && attempt.authoritative === true; }
function resolveValue(metric, attempt, classification) {
  let value = classification.values.get(metric.metricId); if (value !== undefined && value !== null) return { value, missing: false, censored: false };
  const derived = { strict_pass_rate: attempt.outcome === "succeeded" ? 1 : 0, completion_without_retry: attempt.attempt === 1 && attempt.outcome === "succeeded" ? 1 : 0, candidate_failure_rate: ["failed", "cancelled", "inconclusive"].includes(attempt.outcome) ? 1 : 0, timeout_rate: classification.timedOut ? 1 : 0, route_mismatch_rate: attempt.routeMatch === false ? 1 : 0, safety_violation_rate: classification.safety ? 1 : 0 };
  if (Object.hasOwn(derived, metric.metricId)) return { value: derived[metric.metricId], missing: false, censored: false };
  if (metric.missingRule === "zero") return { value: 0, missing: true, censored: false };
  if (metric.missingRule === "censored-limit" && classification.timedOut && typeof classification.values.get(metric.limitMetricId) === "number") return { value: classification.values.get(metric.limitMetricId), missing: true, censored: true };
  return { value: null, missing: true, censored: false };
}
function pairingKey(trial, pairing) {
  const material = { taskId: trial.taskId, taskRevision: trial.taskRevision, runtimeDigest: trial.runtime.digest };
  if (["task-seed", "task-seed-time-block", "unpaired"].includes(pairing)) material.seed = trial.seed;
  if (pairing === "task-seed-time-block") { material.replicate = trial.replicate; material.declaredInputsDigest = trial.declaredInputsDigest; }
  return canonicalDigest(material);
}
function random(seed, index) { return createHash("sha256").update(`${seed}:${index}`).digest().readUInt32BE(0); }
function aggregate(values, kind) { if (!values.length) return null; if (kind === "sum") return values.reduce((sum, value) => sum + value, 0); if (kind === "median") return quantile(values, 0.5); if (kind === "p90") return quantile(values, 0.9); return mean(values); }
function interval(values, confidence, samples, seed) {
  if (!values.length) return [null, null]; const estimates = [];
  for (let sample = 0; sample < samples; sample += 1) { let total = 0; for (let draw = 0; draw < values.length; draw += 1) total += values[random(seed, sample * values.length + draw) % values.length]; estimates.push(total / values.length); }
  const tail = (1 - confidence) / 2; return [round(quantile(estimates, tail)), round(quantile(estimates, 1 - tail))];
}
function unpairedInterval(baseline, candidate, direction, confidence, samples, seed) {
  if (!baseline.length || !candidate.length) return [null, null]; const estimates = []; const sign = direction === "higher" ? 1 : -1;
  for (let sample = 0; sample < samples; sample += 1) { const base = []; const next = []; for (let draw = 0; draw < baseline.length; draw += 1) base.push(baseline[random(seed, sample * (baseline.length + candidate.length) + draw) % baseline.length]); for (let draw = 0; draw < candidate.length; draw += 1) next.push(candidate[random(seed, sample * (baseline.length + candidate.length) + baseline.length + draw) % candidate.length]); estimates.push(sign * (mean(next) - mean(base))); }
  const tail = (1 - confidence) / 2; return [round(quantile(estimates, tail)), round(quantile(estimates, 1 - tail))];
}
function permutationP(values, samples, seed) {
  if (!values.length) return null; const observed = Math.abs(mean(values)); const exhaustive = values.length <= 16; const count = exhaustive ? 2 ** values.length : samples; let extreme = 0;
  for (let sample = 0; sample < count; sample += 1) { let total = 0; for (let index = 0; index < values.length; index += 1) total += values[index] * ((exhaustive ? ((sample >> index) & 1) : (random(seed, sample * values.length + index) & 1)) ? 1 : -1); if (Math.abs(total / values.length) >= observed - 1e-15) extreme += 1; }
  return round((extreme + (exhaustive ? 0 : 1)) / (count + (exhaustive ? 0 : 1)));
}
function unpairedPermutationP(baseline, candidate, samples, seed) {
  if (!baseline.length || !candidate.length) return null; const observed = Math.abs(mean(candidate) - mean(baseline)); const combined = [...baseline, ...candidate]; let extreme = 0;
  for (let sample = 0; sample < samples; sample += 1) { const ranked = combined.map((value, index) => ({ value, rank: random(seed, sample * combined.length + index) })).sort((a, b) => a.rank - b.rank || a.value - b.value); const base = ranked.slice(0, baseline.length).map(({ value }) => value); const next = ranked.slice(baseline.length).map(({ value }) => value); if (Math.abs(mean(next) - mean(base)) >= observed - 1e-15) extreme += 1; }
  return round((extreme + 1) / (samples + 1));
}
function applyHolm(comparisons, alpha) {
  const families = new Map(); for (const comparison of comparisons.filter(({ pValue }) => pValue !== null)) { const members = families.get(comparison.multiplicityFamily) ?? []; members.push(comparison); families.set(comparison.multiplicityFamily, members); }
  for (const members of families.values()) { const ordered = [...members].sort((a, b) => a.pValue - b.pValue || a.metricId.localeCompare(b.metricId) || a.stratum.localeCompare(b.stratum)); let adjusted = 0; for (let index = 0; index < ordered.length; index += 1) { adjusted = Math.max(adjusted, Math.min(1, ordered[index].pValue * (ordered.length - index))); ordered[index].adjustedPValue = round(adjusted); ordered[index].statisticallySignificant = adjusted <= alpha; } }
}

export function generateExperimentReport(input) {
  validateInput(input); const policy = input.analysisPolicy; const trialById = new Map(input.plan.trials.map((trial) => [trial.trialId, trial]));
  const pairing = input.experiment.design?.pairing ?? "task-seed-time-block"; if (!["unpaired", "task", "task-seed", "task-seed-time-block"].includes(pairing)) fail("UNSUPPORTED_DESIGN", "experiment pairing declaration is unsupported");
  const attempts = [...input.attempts].sort((a, b) => a.trialId.localeCompare(b.trialId) || a.attempt - b.attempt); const terminalByTrial = new Map(); for (const attempt of attempts) if (attempt.authoritative && TERMINAL.has(attempt.outcome)) terminalByTrial.set(attempt.trialId, attempt);
  const accounting = { totalStarted: attempts.length, byOutcome: {}, retries: 0, partial: 0, timedOut: 0, invalid: 0, contaminated: 0, censored: 0, routeMismatch: 0, missingByMetric: {}, invalidByCandidate: {} };
  for (const outcome of [...new Set(attempts.map(({ outcome }) => outcome))].sort()) accounting.byOutcome[outcome] = attempts.filter((attempt) => attempt.outcome === outcome).length;
  const classes = new Map(); for (const attempt of attempts) { const c = classify(attempt); classes.set(attempt, c); accounting.retries += Number(attempt.attempt > 1); accounting.partial += Number(attempt.outcome === "incomplete"); accounting.timedOut += Number(c.timedOut); accounting.invalid += Number(attempt.outcome === "invalid"); accounting.contaminated += Number(c.contaminated); accounting.routeMismatch += Number(attempt.routeMatch === false); if (c.infrastructureInvalid || c.contaminated) accounting.invalidByCandidate[attempt.candidateId] = (accounting.invalidByCandidate[attempt.candidateId] ?? 0) + 1; }
  const comparisons = []; const missingRejects = []; const strataByTask = new Map(policy.stratumAssignments.map(({ taskId, strata }) => [taskId, strata]));
  for (const metric of policy.metricDefinitions) for (const stratum of ["all", ...policy.criticalStrata.map((value) => `critical:${value}`)]) {
    const pairs = new Map(); let missing = 0;
    for (const attempt of attempts) { const trial = trialById.get(attempt.trialId); const taskStrata = strataByTask.get(trial.taskId) ?? []; if (stratum !== "all" && !taskStrata.includes(stratum.slice(9))) continue; if (![policy.baselineCandidateId, policy.candidateId].includes(trial.candidateId)) continue; const c = classes.get(attempt); if (!eligible(metric, attempt, c, terminalByTrial.get(attempt.trialId))) continue; const resolved = resolveValue(metric, attempt, c); missing += Number(resolved.value === null); accounting.censored += Number(resolved.censored); if (resolved.value === null) continue; const key = pairingKey(trial, pairing); const pair = pairs.get(key) ?? { baseline: [], candidate: [] }; pair[trial.candidateId === policy.baselineCandidateId ? "baseline" : "candidate"].push(resolved.value); pairs.set(key, pair); }
    accounting.missingByMetric[metric.metricId] = Math.max(accounting.missingByMetric[metric.metricId] ?? 0, missing); if (metric.missingRule === "reject" && missing) missingRejects.push(`${metric.metricId}:${stratum}`);
    const entries = [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b)); const paired = entries.filter(([, pair]) => pair.baseline.length && pair.candidate.length); const selected = pairing === "unpaired" ? entries : paired; const baseline = selected.filter(([, pair]) => pair.baseline.length).map(([, pair]) => aggregate(pair.baseline, metric.aggregation)); const candidate = selected.filter(([, pair]) => pair.candidate.length).map(([, pair]) => aggregate(pair.candidate, metric.aggregation)); const differences = paired.map(([, pair]) => (metric.direction === "higher" ? 1 : -1) * (aggregate(pair.candidate, metric.aggregation) - aggregate(pair.baseline, metric.aggregation))); const estimate = pairing === "unpaired" ? (baseline.length && candidate.length ? (metric.direction === "higher" ? 1 : -1) * (mean(candidate) - mean(baseline)) : null) : mean(differences); const seed = canonicalDigest({ policy: policy.digest, metric: metric.metricId, stratum, pairing, clusters: selected.map(([key]) => key) }); const ci = pairing === "unpaired" ? unpairedInterval(baseline, candidate, metric.direction, policy.confidenceLevel, policy.bootstrapSamples, seed) : interval(differences, policy.confidenceLevel, policy.bootstrapSamples, seed); const pValue = pairing === "unpaired" ? unpairedPermutationP(baseline, candidate, policy.permutationSamples, seed) : permutationP(differences, policy.permutationSamples, seed); const spread = pairing === "unpaired" ? Math.sqrt((variance(baseline) + variance(candidate)) / 2) : Math.sqrt(variance(differences)); const effect = estimate === null ? null : spread === 0 ? (estimate === 0 ? 0 : Math.sign(estimate)) : estimate / spread;
    comparisons.push({ metricId: metric.metricId, category: metric.category, stratum, direction: metric.direction, aggregation: metric.aggregation, comparisonMethod: pairing === "unpaired" ? "unpaired-task-cluster" : `paired-${pairing}-cluster`, denominator: metric.denominator, missingRule: metric.missingRule, multiplicityFamily: metric.multiplicityFamily, baselineN: baseline.length, candidateN: candidate.length, pairedClusters: pairing === "unpaired" ? 0 : paired.length, effectiveClusters: pairing === "unpaired" ? Math.min(baseline.length, candidate.length) : paired.length, baselineEstimate: round(mean(baseline)), candidateEstimate: round(mean(candidate)), improvementEstimate: round(estimate), confidenceInterval: ci, standardizedEffectSize: round(effect), pValue, adjustedPValue: null, statisticallySignificant: false, practicallySignificant: estimate !== null && estimate >= metric.practicalBenefit, noninferior: ci[0] !== null && ci[0] >= -metric.noninferiorityMargin, regression: ci[1] !== null && ci[1] < -metric.regressionMargin, inconclusive: ci[0] === null || (ci[0] < -metric.noninferiorityMargin && ci[1] >= -metric.regressionMargin), critical: metric.critical || stratum !== "all", missing });
  }
  applyHolm(comparisons, 1 - policy.confidenceLevel);
  const invalidityByCluster = new Map();
  for (const attempt of attempts) { const c = classes.get(attempt); if (!c.infrastructureInvalid && !c.contaminated) continue; const trial = trialById.get(attempt.trialId); const key = pairingKey(trial, pairing); const counts = invalidityByCluster.get(key) ?? { baseline: 0, candidate: 0 }; counts[trial.candidateId === policy.baselineCandidateId ? "baseline" : "candidate"] += 1; invalidityByCluster.set(key, counts); }
  const asymmetricInvalidity = [...invalidityByCluster.values()].some(({ baseline, candidate }) => baseline !== candidate); const safety = attempts.some((attempt) => classes.get(attempt).safety || classes.get(attempt).duplicateEffect); const insufficientPower = comparisons.some((item) => item.critical && item.effectiveClusters < input.experiment.decisionRules.promotion.minimumSamples); const criticalRegression = comparisons.some((item) => item.critical && item.regression); const inconclusive = comparisons.some((item) => item.critical && (!item.noninferior || item.inconclusive)); const blockers = [];
  if (safety) blockers.push("safety-rejection"); if (asymmetricInvalidity) blockers.push("asymmetric-invalidity"); if (accounting.routeMismatch) blockers.push("route-mismatch"); if (missingRejects.length) blockers.push("required-metric-missing"); if (insufficientPower) blockers.push("insufficient-power"); if (criticalRegression) blockers.push("critical-stratum-regression"); if (accounting.contaminated) blockers.push("contamination");
  const primary = comparisons.filter(({ metricId, stratum }) => metricId === policy.primaryMetricId && stratum === "all");
  let outcome = "pass"; if (safety) outcome = "safety-rejection"; else if (criticalRegression) outcome = "regression"; else if (blockers.length || inconclusive || !primary.some(({ practicallySignificant }) => practicallySignificant)) outcome = "inconclusive";
  const unsigned = { schemaVersion: REPORT_SCHEMA_VERSION, inputDigest: canonicalDigest(input), experimentId: input.experiment.experimentId, experimentDigest: input.experiment.digest, planDigest: input.plan.planDigest, analysisPolicyDigest: policy.digest, accounting, comparisons, decision: { outcome, blockers: [...new Set(blockers)].sort(), statisticalAndPracticalBenefit: primary.some((item) => item.statisticallySignificant && item.practicallySignificant), sealed: true } };
  return deepFreeze({ ...unsigned, reportDigest: canonicalDigest(unsigned) });
}

export function renderExperimentReport(report) {
  const lines = [`# Experiment report: ${report.experimentId}`, "", `Decision: **${report.decision.outcome}**`, `Report digest: \`${report.reportDigest}\``, "", `Started attempts: ${report.accounting.totalStarted}; retries: ${report.accounting.retries}; invalid: ${report.accounting.invalid}; timeouts: ${report.accounting.timedOut}; contaminated: ${report.accounting.contaminated}.`, "", "| Metric | Stratum | Baseline | Candidate | Improvement (CI) | Adjusted p | Practical | Interpretation |", "| --- | --- | ---: | ---: | --- | ---: | --- | --- |"]; for (const item of report.comparisons) { const interpretation = item.regression ? "regression" : item.noninferior ? (item.statisticallySignificant ? "noninferior; statistically significant" : "noninferior") : "inconclusive"; lines.push(`| ${item.metricId} | ${item.stratum} | ${item.baselineEstimate ?? "missing"} | ${item.candidateEstimate ?? "missing"} | ${item.improvementEstimate ?? "missing"} (${item.confidenceInterval[0] ?? "?"}, ${item.confidenceInterval[1] ?? "?"}) | ${item.adjustedPValue ?? "n/a"} | ${item.practicallySignificant ? "yes" : "no"} | ${interpretation} |`); } if (report.decision.blockers.length) lines.push("", `Blocking evidence: ${report.decision.blockers.join(", ")}.`); lines.push(""); return `${lines.join("\n")}\n`;
}
export function verifyExperimentReport(input, report) { plain(report, "report"); const unsigned = { ...report }; delete unsigned.reportDigest; if (!DIGEST.test(report.reportDigest) || canonicalDigest(unsigned) !== report.reportDigest) fail("ALTERED_REPORT", "report digest is invalid"); const recomputed = generateExperimentReport(input); if (canonicalDigest(recomputed) !== canonicalDigest(report)) fail("REPORT_MISMATCH", "report does not exactly recompute from immutable inputs", { expected: recomputed.reportDigest, actual: report.reportDigest }); return Object.freeze({ verified: true, reportDigest: report.reportDigest, inputDigest: report.inputDigest, decision: report.decision.outcome }); }
