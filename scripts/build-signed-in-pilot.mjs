#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  canonicalBytes,
  canonicalDigest,
  deriveExperimentDigest,
  deriveExperimentIdentity,
  transitionExperiment,
} from "../src/experimentation-contract/index.mjs";
import {
  createStarterDevelopmentRelease,
  createStarterTaskPackage,
  starterGraderBundle,
} from "../src/experimentation-corpus/index.mjs";

export const PILOT_FAMILIES = Object.freeze([
  "localized-repair",
  "cross-cutting-feature",
  "multi-module-migration",
  "planning",
  "orchestration-restart",
]);

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(["out", "source-commit", "image-digest", "image", "evidence-dir"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`invalid option: ${name ?? "<missing>"}`);
    const key = name.slice(2);
    if (!allowed.has(key) || Object.hasOwn(values, key)) throw new Error(`invalid option: ${name}`);
    values[key] = argv[index + 1];
  }
  return values;
}

function digest(value, name) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value ?? "")) throw new Error(`${name} must be a sha256 digest`);
  return value;
}

function commit(value) {
  if (!/^[0-9a-f]{40}$/u.test(value ?? "")) throw new Error("source-commit must be a 40-character Git commit");
  return value;
}

function candidate(candidateId, repeatArm, sourceCommit, imageDigest) {
  return {
    candidateId,
    adapter: "direct-codex",
    source: { commit: sourceCommit, digest: canonicalDigest({ sourceCommit, adapter: "signed-in-codex-vm-v1", imageDigest }) },
    model: { id: "model:product-default", revision: "unavailable", reasoningEffort: "medium" },
    plugins: [],
    configuration: [
      { name: "authentication", value: "chatgpt-device-auth" },
      { name: "codex-version", value: "0.146.0" },
      { name: "repeat-arm", value: repeatArm },
      { name: "user-config", value: "ignored" },
    ],
  };
}

export function createSignedInPilotManifest({ sourceCommit, imageDigest, image, evidenceDirectory }) {
  const { release } = createStarterDevelopmentRelease();
  const tasks = PILOT_FAMILIES.map((familyId) => createStarterTaskPackage(familyId).task);
  const candidateIds = ["candidate:product-default-repeat-a", "candidate:product-default-repeat-b"];
  const runtimeMaterial = {
    backend: "oci-headless",
    platform: "linux-arm64",
    image,
    imageDigest,
    codexVersion: "0.146.0",
    hostMounts: "none",
    acquisition: "pinned-oci-image",
    executionIsolation: "unmounted-colima-vm",
    authBoundary: "root-owned-seed-copy-per-attempt",
  };
  const runtimeDigest = canonicalDigest(runtimeMaterial);
  const grader = starterGraderBundle();
  let experiment = {
    schemaVersion: 1,
    experimentId: `exp:${"0".repeat(64)}`,
    specRevision: 1,
    previousDigest: null,
    digest: `sha256:${"0".repeat(64)}`,
    state: "draft",
    name: "Signed-in product-default pilot calibration",
    description: "Diagnostic repeat-arm calibration of five synthetic starter strata before the confirmatory direct-versus-Nelos study.",
    hypothesis: {
      statement: "Identical product-default repeat arms have comparable strict-pass behavior under the isolated signed-in worker contract.",
      primaryMetric: "strict_pass_rate",
      decisionRule: "noninferiority",
    },
    candidates: [
      candidate(candidateIds[0], "a", sourceCommit, imageDigest),
      candidate(candidateIds[1], "b", sourceCommit, imageDigest),
    ],
    corpus: { releaseId: release.releaseId, digest: release.digest },
    design: {
      pairing: "task-seed-time-block",
      repetitions: 2,
      seedRoot: "nelos-issue-51-signed-in-pilot-v1",
      seedSchedule: [{ replicate: 1, seed: "pilot-repeat-1" }, { replicate: 2, seed: "pilot-repeat-2" }],
      multiplicityFamily: "pilot-calibration",
    },
    limits: { wallClockSeconds: 180, tokenBudget: 4000, toolCalls: 50, diskBytes: 536870912, processes: 32, networkRequests: 0 },
    runtimeMatrix: [{
      runtimeLockId: `runtime:${runtimeDigest.slice(7)}`,
      digest: runtimeDigest,
      backend: "oci-headless",
      platform: "linux-arm64",
      eligibleCandidateIds: candidateIds,
      requiredCapabilities: ["git", "node"],
    }],
    graderBundle: { id: grader.graderBundleId, digest: grader.digest },
    exclusions: [],
    metrics: {
      primary: { metricId: "strict_pass_rate", direction: "higher", aggregation: "rate" },
      secondary: [
        { metricId: "candidate_failure_rate", direction: "lower", aggregation: "rate" },
        { metricId: "input_tokens", direction: "lower", aggregation: "median" },
        { metricId: "output_tokens", direction: "lower", aggregation: "median" },
        { metricId: "terminal_wall_ms", direction: "lower", aggregation: "median" },
        { metricId: "tool_calls", direction: "lower", aggregation: "median" },
      ],
      minimumDetectableEffect: { metricId: "strict_pass_rate", absolute: 0.2, power: 0.8, alpha: 0.05 },
    },
    decisionRules: {
      promotion: { kind: "noninferiority", metricId: "strict_pass_rate", threshold: 0.2, minimumSamples: 10 },
      regression: { kind: "absolute", metricId: "candidate_failure_rate", threshold: 0.2, minimumSamples: 10 },
      stop: { kind: "fixed-sample", metricId: "strict_pass_rate", threshold: 20, minimumSamples: 20 },
      invalidation: { maxInvalidFraction: 0.1, asymmetricInvalidity: "invalidate-comparison", reasonCodes: ["contamination", "grader_failure", "route_mismatch"] },
    },
  };
  experiment.experimentId = deriveExperimentIdentity(experiment);
  experiment.digest = deriveExperimentDigest(experiment);
  experiment = transitionExperiment(transitionExperiment(experiment, "reviewed"), "sealed");
  const root = resolve(new URL("..", import.meta.url).pathname);
  return {
    schemaVersion: 1,
    experiment,
    tasks,
    adapters: {
      "direct-codex": {
        command: [process.execPath, resolve(root, "scripts", "signed-in-codex-vm-adapter.mjs")],
        environment: {
          NELOS_PILOT_COLIMA_PROFILE: "nelos-pilot",
          NELOS_PILOT_EVIDENCE_DIR: resolve(evidenceDirectory),
          NELOS_PILOT_IMAGE: image,
          NELOS_PILOT_VM_RUNTIME: "/opt/nelos-pilot-runtime/0.146.0-adc09c2f664a",
          NELOS_PILOT_VM_SEED_ROOT: "/var/lib/nelos-pilot/auth-seed",
        },
        version: "signed-in-codex-vm-v1",
      },
      nelos: {
        command: [process.execPath, resolve(root, "scripts", "test-support", "fake-experiment-adapter.mjs")],
        environment: {},
        version: "unused-v1",
      },
    },
    policy: {
      maxConcurrency: 1,
      perAdapterConcurrency: { "direct-codex": 1, nelos: 1 },
      leaseMs: 240000,
      timeoutMs: 180000,
      maxAttempts: 1,
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const out = resolve(options.out ?? "signed-in-pilot-manifest.json");
  const manifest = createSignedInPilotManifest({
    sourceCommit: commit(options["source-commit"]),
    imageDigest: digest(options["image-digest"], "image-digest"),
    image: options.image ?? "nelos-codex-pilot:0.146.0",
    evidenceDirectory: options["evidence-dir"] ?? resolve(dirname(out), "evidence"),
  });
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, canonicalBytes(manifest), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ manifest: out, digest: canonicalDigest(manifest), trials: manifest.tasks.length * manifest.experiment.candidates.length * manifest.experiment.design.repetitions })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
