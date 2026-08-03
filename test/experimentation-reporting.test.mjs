import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { canonicalBytes, canonicalDigest } from "../src/experimentation-contract/index.mjs";
import { createDefaultAnalysisPolicy, ExperimentReportingError, generateExperimentReport, renderExperimentReport, sealAnalysisPolicy, verifyExperimentReport } from "../src/experimentation-reporting/index.mjs";

const exec = promisify(execFile);
const fixture = JSON.parse(await readFile(new URL("./fixtures/experimentation-reporting/golden-cases.json", import.meta.url)));
const D = (character) => `sha256:${character.repeat(64)}`;

function policy() {
  const metric = (metricId, category, overrides = {}) => ({ metricId, category, direction: "lower", aggregation: "mean", denominator: "all-started", missingRule: "reject", limitMetricId: null, practicalBenefit: 0.1, noninferiorityMargin: 0, regressionMargin: 0.1, multiplicityFamily: "primary", critical: false, ...overrides });
  return sealAnalysisPolicy({
    schemaVersion: 1, baselineCandidateId: "candidate:base", candidateId: "candidate:new", primaryMetricId: "score",
    confidenceLevel: 0.95, bootstrapSamples: 200, permutationSamples: 200, criticalStrata: [], stratumAssignments: [],
    metricDefinitions: [
      metric("score", "quality", { direction: "higher", critical: true }),
      metric("timeout_rate", "reliability", { missingRule: "zero" }),
      metric("latency_ms", "latency", { aggregation: "restricted-mean", missingRule: "censored-limit", limitMetricId: "wall_limit_ms" }),
      metric("tokens", "token"), metric("tool_calls", "tool"), metric("cpu_ms", "resource"),
      metric("credits", "credit"), metric("cost", "cost"),
    ],
  });
}

function acceptedInput({ baseline = 1, candidate = 2, timeout = false, routeMismatch = false, count = 4, candidateOutcome = "succeeded", omitCandidateScore = false } = {}) {
  const experiment = { experimentId: "exp:report", digest: D("e"), design: { pairing: "task-seed-time-block" }, decisionRules: { promotion: { minimumSamples: count } } };
  const trials = [];
  for (let index = 0; index < count; index += 1) for (const candidateId of ["candidate:base", "candidate:new"]) trials.push({
    ordinal: trials.length, trialId: `trial:${index}:${candidateId}`, taskId: `task:${index}`, taskRevision: 1,
    candidateId, seed: `seed:${index}`, replicate: 1, runtime: { digest: D("r") },
    declaredInputsDigest: D("i"), declaredInputs: { strata: index === 0 ? ["critical"] : [] },
  });
  const planUnsigned = { schemaVersion: 1, experimentId: experiment.experimentId, experimentDigest: experiment.digest, manifestDigest: D("m"), trials };
  const plan = { ...planUnsigned, planDigest: canonicalDigest(planUnsigned) };
  const attempts = trials.map((trial, index) => {
    const isCandidate = trial.candidateId === "candidate:new";
    const measurements = [
      ...(!isCandidate || !omitCandidateScore ? [{ metricId: "score", value: isCandidate ? candidate : baseline }] : []),
      { metricId: "wall_limit_ms", value: 500 },
      { metricId: "timeout", value: Number(isCandidate && timeout) },
      { metricId: "latency_ms", value: isCandidate && timeout ? null : (isCandidate ? candidate : baseline) },
      { metricId: "tokens", value: isCandidate ? candidate : baseline },
      { metricId: "tool_calls", value: isCandidate ? candidate : baseline },
      { metricId: "cpu_ms", value: isCandidate ? candidate : baseline },
      { metricId: "credits", value: isCandidate ? candidate : baseline },
      { metricId: "cost", value: isCandidate ? candidate : baseline },
    ];
    const unsigned = { schemaVersion: 1, planDigest: plan.planDigest, manifestDigest: plan.manifestDigest, trialId: trial.trialId, attempt: 1, operationId: `op:${index}`, candidateId: trial.candidateId, outcome: isCandidate ? candidateOutcome : "succeeded", authoritative: true, routeMatch: !(isCandidate && routeMismatch), measurements };
    return { ...unsigned, bundleDigest: canonicalDigest(unsigned) };
  });
  return { schemaVersion: 1, experiment, plan, analysisPolicy: policy(), attempts };
}

test("golden wins, ties, regressions, timeouts, missing data, and route mismatches are fail-closed", () => {
  for (const golden of fixture.cases) {
    const input = acceptedInput({ baseline: golden.baseline, candidate: golden.candidate, timeout: golden.timeout, routeMismatch: golden.routeMismatch, omitCandidateScore: golden.name === "missing" });
    const report = generateExperimentReport(input);
    assert.equal(report.decision.outcome, golden.expected, golden.name);
    if (golden.timeout) assert.equal(report.accounting.timedOut, 4);
    if (golden.routeMismatch) assert.ok(report.decision.blockers.includes("route-mismatch"));
    if (golden.name === "missing") assert.ok(report.decision.blockers.includes("required-metric-missing"));
  }
});

test("every attempt and retry remains in sealed denominator accounting", () => {
  const input = acceptedInput();
  const original = input.attempts[0];
  const retryUnsigned = { ...structuredClone(original), attempt: 2, operationId: "op:retry", outcome: "failed" };
  delete retryUnsigned.bundleDigest;
  input.attempts.push({ ...retryUnsigned, bundleDigest: canonicalDigest(retryUnsigned) });
  const report = generateExperimentReport(input);
  assert.equal(report.accounting.totalStarted, 9);
  assert.equal(report.accounting.retries, 1);
  assert.equal(report.accounting.byOutcome.failed, 1);
});

test("randomized accepted-attempt order cannot change aggregates or decisions", () => {
  const input = acceptedInput({ count: 8 });
  const first = generateExperimentReport(input);
  const shuffled = { ...input, attempts: [...input.attempts].sort((a, b) => b.operationId.localeCompare(a.operationId)) };
  const second = generateExperimentReport(shuffled);
  assert.deepEqual(second.accounting, first.accounting);
  assert.deepEqual(second.comparisons, first.comparisons);
  assert.deepEqual(second.decision, first.decision);
  const unpaired = acceptedInput({ count: 8 });
  unpaired.experiment.design.pairing = "unpaired";
  const unpairedReport = generateExperimentReport(unpaired);
  assert.ok(unpairedReport.comparisons.every(({ comparisonMethod, pairedClusters }) => comparisonMethod === "unpaired-task-cluster" && pairedClusters === 0));
});

test("critical regressions, insufficient power, asymmetric invalidity, safety, duplicates, and provenance prevent pass", () => {
  const insufficient = acceptedInput({ count: 3 });
  insufficient.experiment.decisionRules.promotion.minimumSamples = 4;
  assert.ok(generateExperimentReport(insufficient).decision.blockers.includes("insufficient-power"));

  const asymmetric = acceptedInput({ candidateOutcome: "invalid" });
  assert.ok(generateExperimentReport(asymmetric).decision.blockers.includes("asymmetric-invalidity"));

  const stratum = acceptedInput({ count: 20, baseline: 1, candidate: 2 });
  stratum.analysisPolicy = sealAnalysisPolicy({ ...stratum.analysisPolicy, criticalStrata: ["critical"], stratumAssignments: [{ taskId: "task:0", strata: ["critical"] }] });
  const criticalAttempt = stratum.attempts.find(({ trialId }) => trialId === "trial:0:candidate:new");
  const criticalScore = { ...criticalAttempt, measurements: criticalAttempt.measurements.map((measurement) => measurement.metricId === "score" ? { ...measurement, value: -2 } : measurement) };
  delete criticalScore.bundleDigest; criticalScore.bundleDigest = canonicalDigest(criticalScore);
  stratum.attempts[stratum.attempts.indexOf(criticalAttempt)] = criticalScore;
  const stratumReport = generateExperimentReport(stratum);
  assert.ok(stratumReport.comparisons.find(({ metricId, stratum: name }) => metricId === "score" && name === "all").improvementEstimate > 0);
  assert.ok(stratumReport.decision.blockers.includes("critical-stratum-regression"));

  const safety = acceptedInput();
  const target = safety.attempts.find(({ candidateId }) => candidateId === "candidate:new");
  const unsafe = { ...target, measurements: [...target.measurements, { metricId: "safety_violation", value: 1 }] }; delete unsafe.bundleDigest; unsafe.bundleDigest = canonicalDigest(unsafe);
  safety.attempts[safety.attempts.indexOf(target)] = unsafe;
  assert.equal(generateExperimentReport(safety).decision.outcome, "safety-rejection");

  const duplicate = acceptedInput(); duplicate.attempts.push(structuredClone(duplicate.attempts[0]));
  assert.throws(() => generateExperimentReport(duplicate), (error) => error instanceof ExperimentReportingError && error.code === "DUPLICATE_TRIAL");
  const incompatible = acceptedInput(); incompatible.attempts[0].planDigest = D("x");
  assert.throws(() => generateExperimentReport(incompatible), (error) => error instanceof ExperimentReportingError && ["ALTERED_INPUT", "INCOMPATIBLE_PROVENANCE"].includes(error.code));
});

test("machine and human reports separate statistical, practical, and noninferiority conclusions", () => {
  const report = generateExperimentReport(acceptedInput({ count: 18, baseline: 2, candidate: 1 }));
  assert.ok(report.comparisons.every((comparison) => typeof comparison.noninferior === "boolean" && typeof comparison.practicallySignificant === "boolean" && typeof comparison.statisticallySignificant === "boolean"));
  assert.match(renderExperimentReport(report), /Decision: \*\*(?:pass|inconclusive|regression)\*\*/u);
  assert.equal(verifyExperimentReport(acceptedInput({ count: 18, baseline: 2, candidate: 1 }), report).verified, true);
});

test("standalone verifier exactly recomputes report and rejects altered decisions", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nelos-reporting-"));
  const input = acceptedInput(); const report = generateExperimentReport(input);
  const inputPath = resolve(directory, "input.json"); const reportPath = resolve(directory, "report.json");
  await writeFile(inputPath, canonicalBytes(input)); await writeFile(reportPath, canonicalBytes(report));
  const verified = await exec(process.execPath, [resolve("bin/nelos-verify-experiment-report"), inputPath, reportPath]);
  assert.equal(JSON.parse(verified.stdout).verified, true);
  const altered = structuredClone(report); altered.decision.outcome = "regression"; await writeFile(reportPath, canonicalBytes(altered));
  await assert.rejects(exec(process.execPath, [resolve("bin/nelos-verify-experiment-report"), inputPath, reportPath]));
});

test("deterministic property sweep preserves bounds and verifier equivalence", async () => {
  assert.equal(typeof (await import("nelos/experimentation-reporting")).generateExperimentReport, "function");
  const defaults = createDefaultAnalysisPolicy({ baselineCandidateId: "candidate:base", candidateId: "candidate:new" });
  assert.deepEqual(new Set(defaults.metricDefinitions.map(({ category }) => category)), new Set(["quality", "reliability", "latency", "token", "tool", "resource", "credit", "cost"]));
  for (let seed = 0; seed < 32; seed += 1) {
    const input = acceptedInput({ baseline: seed % 5, candidate: (seed * 7) % 5, count: 3 + (seed % 6) });
    const report = generateExperimentReport(input);
    assert.ok(report.comparisons.every(({ confidenceInterval }) => confidenceInterval[0] === null || confidenceInterval[0] <= confidenceInterval[1]));
    assert.equal(verifyExperimentReport(input, report).reportDigest, report.reportDigest);
  }
});
