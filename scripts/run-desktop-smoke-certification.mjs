#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { runDesktopSmokeBundleCommandV1 } from "../src/desktop-smoke-cli.mjs";
import { createMachineDesktopBundleReviewerV1 } from "../src/machine-desktop-smoke-adapter.mjs";
import { runDesktopBundleReviewPipelineV1 } from "../src/desktop-bundle-review.mjs";

function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] ?? null; }
function required(name) { const value = argument(name); if (!value) throw new Error(`${name} is required`); return value; }
async function scenarioSet() { return JSON.parse(await readFile(new URL("../validation/desktop-smoke/scenario-sets/release.json", import.meta.url), "utf8")); }
function unwrap(bytes) {
  const outer = JSON.parse(bytes.toString("utf8"));
  const entries = new Map(outer.entries.map((entry) => [entry.relativePath, Buffer.from(entry.data, "base64")]));
  return { evidence: entries.get("evidence/desktop-smoke-v1.json"), receipt: JSON.parse(entries.get("receipts/run.json").toString("utf8")) };
}
function expectations(library) {
  return {
    schemaVersion: 1,
    requiredCheckpoints: library.scenarios.flatMap((scenario) => scenario.checkpoints.filter((checkpoint) => !checkpoint.failureOnly).map((checkpoint) => ({ scenarioId: scenario.scenarioId, checkpointId: checkpoint.checkpointId, type: checkpoint.type, minWidth: checkpoint.type === "screenshot" ? 1 : 0, minHeight: checkpoint.type === "screenshot" ? 1 : 0, maxWidth: 16384, maxHeight: 16384 }))),
    scenarioOutcomes: library.scenarios.map(({ scenarioId }) => ({ scenarioId, outcome: "passed" })),
    workflowInvariants: ["all_assertions_passed", "all_checkpoints_captured", "all_scenarios_declared", "cleanup_proven", "screenshots_sanitized"],
  };
}

export async function runReleaseDesktopCertificationV1({ candidatePath, outputDirectory, runId, reviewer = createMachineDesktopBundleReviewerV1() } = {}) {
  if (!candidatePath || !outputDirectory || !runId) throw new Error("candidatePath, outputDirectory, and runId are required");
  const output = resolve(outputDirectory);
  if (!isAbsolute(output)) throw new Error("outputDirectory must be absolute");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const bundlePath = join(output, "certification-bundle.json");
  const executed = await runDesktopSmokeBundleCommandV1({ candidatePath, scenarioSetName: "release", runId, bundleOutput: bundlePath });
  if (executed.outcome !== "passed" || executed.cleanup?.destroyed !== true || executed.cleanup?.absent !== true) throw new Error("release execution or independent cleanup proof failed");
  const { evidence, receipt } = unwrap(await readFile(bundlePath));
  const review = await runDesktopBundleReviewPipelineV1({ bundle: evidence, expectations: expectations(await scenarioSet()), execution: { runId: receipt.runId, outcome: receipt.outcome, scenarioOutcomes: receipt.scenarioOutcomes.map(({ scenarioId, outcome }) => ({ scenarioId, outcome })), cleanup: receipt.cleanup }, reviewer });
  await writeFile(join(output, "certification-review.json"), `${JSON.stringify(review.report.json)}\n`, { flag: "wx", mode: 0o600 });
  if (review.assertions.status !== "passed" || review.review.status !== "passed") throw new Error("release assertions or independent review policy failed");
  return Object.freeze({ ...executed, reviewPath: join(output, "certification-review.json"), candidate: receipt.candidate });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReleaseDesktopCertificationV1({ candidatePath: required("--candidate"), outputDirectory: required("--out-dir"), runId: required("--run-id") })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`desktop-smoke-certification: ${error.message}\n`); process.exitCode = 1; });
}
