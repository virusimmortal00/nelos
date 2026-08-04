import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalBytes, canonicalDigest, sha256Bytes } from "./experimentation-contract/index.mjs";

function metric(result, metricId) { return result.measurements.find((item) => item.metricId === metricId)?.value; }
function wilson(successes, count) {
  if (count === 0) return null;
  const z = 1.959964; const proportion = successes / count; const denominator = 1 + z ** 2 / count;
  const center = (proportion + z ** 2 / (2 * count)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z ** 2 / (4 * count)) / count) / denominator;
  return { lower: Number(Math.max(0, center - margin).toFixed(6)), upper: Number(Math.min(1, center + margin).toFixed(6)) };
}
function armSummary(results, candidateId) {
  const selected = results.filter((result) => result.candidateId === candidateId);
  const passes = selected.reduce((sum, result) => sum + Number(metric(result, "strict_pass_rate") ?? 0), 0);
  return { candidateId, trials: selected.length, strictPasses: passes, strictPassRate: selected.length ? passes / selected.length : null, wilson95: wilson(passes, selected.length), failures: selected.filter(({ outcome }) => outcome !== "succeeded").length };
}
function narrative(title, runId, finishedAt, sections) {
  return `# ${title}\n\nRun: ${runId}\nRecorded: ${finishedAt}\n\n${sections.map(([heading, text]) => `## ${heading}\n\n${text}`).join("\n\n")}\n`;
}

export async function writeApiBaselineResearchPacket({ store, bundle, runId, results, status, errorCode = null, startedAt, finishedAt }) {
  const packetRoot = resolve(store, "research-packet");
  await mkdir(packetRoot, { mode: 0o700 });
  const distribution = JSON.parse(await readFile(new URL("../distribution-provenance.json", import.meta.url), "utf8"));
  const experiment = bundle.runnerManifest.experiment;
  const candidates = experiment.candidates.map(({ candidateId, adapter, source, model, plugins, configuration }) => ({ candidateId, adapter, source, model, pluginDigest: canonicalDigest(plugins), configuration, configurationDigest: canonicalDigest(configuration) }));
  const tasks = bundle.runnerManifest.tasks.map((task) => ({ taskId: task.taskId, digest: task.digest, promptDigest: task.prompt.digest, graderBundleDigest: experiment.graderBundle.digest }));
  const protocol = {
    schemaVersion: 1, runId, phase: bundle.identity.phase, capturedBeforeResults: true,
    researchQuestion: "Can the API-controlled direct Codex path produce complete, reproducible evidence across identical repeat arms under one explicit route?",
    hypothesis: experiment.hypothesis,
    expectedOutcome: "The two identical repeat arms should show no systematic strict-pass difference; this canary estimates instrumentation health, not comparative performance.",
    rationale: {
      controlAndTreatment: "Identical A/B repeat arms isolate order, transport, and instrumentation variance before any treatment contrast.",
      corpus: "One sealed localized-repair starter task minimizes API exposure while exercising the end-to-end grader path.",
      metrics: "Strict pass is primary; candidate failure, usage, wall time, retries, route integrity, and evidence completeness diagnose operations.",
      sampleSize: "Four trials in two opposite AB/BA blocks are a canary only; confirmatory work remains independently power-gated.",
      stoppingRules: experiment.decisionRules.stop,
    },
    identities: {
      source: candidates.map(({ candidateId, source }) => ({ candidateId, source: { ...source } })),
      nelosDistribution: distribution,
      requestedModel: bundle.identity.requestedRoute,
      runtime: bundle.identity.runtimeProvenance,
      tasks,
      grader: experiment.graderBundle,
      candidates,
      schedule: bundle.executionSchedule,
      pricingSnapshot: bundle.identity.pricingSnapshot,
      bundleDigest: bundle.bundleDigest,
    },
    prohibitions: ["credentials", "hidden-grader-or-oracle-content", "secret-bearing-request-material", "comparative-performance-claims-from-repeat-arm-canary"],
  };
  const arms = candidates.map(({ candidateId }) => armSummary(results, candidateId));
  const complete = status === "completed" && results.length === bundle.controls.sealedTrialCount;
  const summary = {
    schemaVersion: 1, runId, status, startedAt, finishedAt, errorCode, bundleDigest: bundle.bundleDigest,
    trialCount: results.length, expectedTrialCount: bundle.controls.sealedTrialCount,
    evidenceHealth: { complete, receiptCount: results.filter(({ artifacts }) => artifacts.some(({ id }) => id === "runtime-provider-receipt")).length, routeMatchedCount: results.filter(({ observedRoute }) => Object.entries(bundle.identity.requestedRoute).every(([field, value]) => observedRoute[field] === value)).length },
    derived: { arms, strictPassRiskDifferenceBMinusA: arms.length === 2 && arms.every(({ strictPassRate }) => strictPassRate !== null) ? arms[1].strictPassRate - arms[0].strictPassRate : null, uncertainty: "Per-arm Wilson 95% intervals are descriptive only; n=2 per arm does not authorize comparative inference." },
    exclusions: results.filter(({ outcome }) => outcome === "invalid" || outcome === "inconclusive").map(({ trialId, outcome }) => ({ trialId, reason: outcome })),
    missingTrials: bundle.controls.sealedTrialCount - results.length,
    decision: complete ? "Instrumentation evidence is available for operator review; no comparative performance claim is authorized." : "Run aborted or incomplete; no performance claim is authorized.",
    limitations: ["Four repeat-arm trials are not an independently powered comparative sample.", "One starter task does not represent the confirmatory corpus strata.", "Provider cost is an estimate tied to the sealed pricing snapshot, not an invoice."],
    alternativeExplanations: ["Order effects", "Transient provider or host conditions", "Task-specific variance", "Grader or transport instrumentation defects"],
    unresolvedQuestions: ["Does instrumentation remain complete across the planned independent task strata?", "What paired task-level variance should determine confirmatory sample size?"],
  };
  const anomalies = results.filter(({ outcome }) => outcome !== "succeeded").map(({ trialId, candidateId, outcome }) => `- ${trialId} (${candidateId}): ${outcome}`);
  if (errorCode) anomalies.push(`- Run abort: ${errorCode}`);
  const claimLedger = {
    schemaVersion: 1, updatedAt: finishedAt,
    claims: [{ claimId: "claim:api-baseline-evidence-instrumentation", statement: "The API-controlled repeat-arm path can produce provenance-bound, independently receipted trial evidence.", claimClass: "methodology-only", status: complete ? "preliminary" : "instrumented", requiredEvidence: ["four sealed trials", "one receipt per trial", "exact route and executable provenance", "complete grading and usage evidence"], supportingRuns: complete ? [runId] : [], contradictingRuns: [], limitations: summary.limitations },
      { claimId: "claim:comparative-performance", statement: "Any comparative Nelos performance claim requires a separately authorized confirmatory design.", claimClass: "comparative", status: "untested", requiredEvidence: ["independently powered paired tasks in every critical stratum"], supportingRuns: [], contradictingRuns: [], limitations: ["Repeat-arm canary observations are explicitly ineligible as comparative support."] }],
  };
  const files = new Map([
    ["protocol.json", canonicalBytes(protocol)],
    ["run-summary.json", canonicalBytes(summary)],
    ["trials.jsonl", Buffer.from(results.map((result) => JSON.stringify(result)).join("\n") + (results.length ? "\n" : ""), "utf8")],
    ["claim-ledger.json", canonicalBytes(claimLedger)],
    ["anomalies.md", Buffer.from(narrative("Anomalies and operational incidents", runId, finishedAt, [["Automatically observed", anomalies.length ? anomalies.join("\n") : "No automated anomalies recorded."], ["Operator additions", "<!-- Record incidents, protocol deviations, exclusions, and aborted-run context here. Do not include credentials or hidden grader material. -->"]]), "utf8")],
    ["operator-notes.md", Buffer.from(narrative("Operator notes", runId, finishedAt, [["Contemporaneous observations", "<!-- Record observations made during the run. Separate facts from interpretation. -->"], ["Protocol deviations", "<!-- State none, or identify the exact deviation and affected trials. -->"]]), "utf8")],
    ["decision.md", Buffer.from(narrative("Post-result decision", runId, finishedAt, [["Default disposition", summary.decision], ["Evidence and limitations", "<!-- Cite receipt/trial IDs and explain limitations and credible alternatives. -->"], ["Changes before the next phase", "<!-- Record what will change, why, and the prospective decision rule before making the change. -->"]]), "utf8")],
    ["design-decisions.md", Buffer.from(narrative("Methodology design decisions", runId, finishedAt, Object.entries(protocol.rationale).map(([name, value]) => [name, typeof value === "string" ? value : `\`${JSON.stringify(value)}\``])), "utf8")],
    ["limitations.md", Buffer.from(narrative("Methodology limitations", runId, finishedAt, [["Known limitations", summary.limitations.map((value) => `- ${value}`).join("\n")], ["Credible alternatives", summary.alternativeExplanations.map((value) => `- ${value}`).join("\n")]]), "utf8")],
  ]);
  await Promise.all([...files].map(([name, bytes]) => writeFile(resolve(packetRoot, name), bytes, { mode: 0o400, flag: "wx" })));
  const manifest = { schemaVersion: 1, runId, files: [...files].map(([name, bytes]) => ({ name, digest: sha256Bytes(bytes), byteLength: bytes.byteLength })) };
  await writeFile(resolve(packetRoot, "manifest.json"), canonicalBytes(manifest), { mode: 0o400, flag: "wx" });
  return Object.freeze({ packetRoot, manifest });
}
