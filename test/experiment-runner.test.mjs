import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createDirectCodexAdapter,
  createNelosAdapter,
  expandExperimentPlan,
  ExperimentRunnerError,
  ExperimentRunStore,
  runExperiment,
} from "../src/experiment-runner.mjs";
import {
  parseCanonicalTask,
  transitionExperiment,
  transitionTask,
} from "../src/experimentation-contract/index.mjs";
import { buildExperimentV1 } from "./fixtures/experimentation-contract/experiment-v1.mjs";

const TASK_FIXTURE = new URL("./fixtures/experimentation-contract/task-v1.json", import.meta.url);
const executeFile = promisify(execFile);

async function sealedTask() {
  const draft = parseCanonicalTask(await readFile(TASK_FIXTURE));
  return transitionTask(transitionTask(draft, "reviewed"), "sealed");
}

function sealedExperiment() {
  const draft = buildExperimentV1();
  return transitionExperiment(transitionExperiment(draft, "reviewed"), "sealed");
}

async function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    experiment: sealedExperiment(),
    tasks: [await sealedTask()],
    adapters: {
      "direct-codex": { command: ["direct-fixture"], environment: {}, version: "1.0.0" },
      nelos: { command: ["nelos-fixture"], environment: {}, version: "1.0.0" },
    },
    policy: {
      maxConcurrency: 2,
      perAdapterConcurrency: { "direct-codex": 1, nelos: 1 },
      leaseMs: 10_000,
      timeoutMs: 10_000,
      maxAttempts: 2,
    },
    ...overrides,
  };
}

function result(request, overrides = {}) {
  return {
    outcome: "succeeded",
    observedRoute: request.requestedRoute,
    operationId: request.operationId,
    outputs: [{ id: "result", digest: request.declaredInputsDigest, byteLength: 1 }],
    artifacts: [],
    measurements: [{ metricId: "strict_pass_rate", value: 1 }],
    evidenceComplete: true,
    retryable: false,
    ...overrides,
  };
}

function adapters(execute = async (request) => result(request)) {
  const base = { version: "test-v1", execute, cancel: async (operationId) => ({ cancelled: true, operationId }), reconcile: async () => null };
  return {
    "direct-codex": createDirectCodexAdapter(base),
    nelos: createNelosAdapter(base),
  };
}

async function store() {
  return ExperimentRunStore.open(await mkdtemp(resolve(tmpdir(), "nelos-experiment-runner-")));
}

function errorCode(code) {
  return (error) => error instanceof ExperimentRunnerError && error.code === code;
}

test("sealed manifests expand a stable ordered matrix before scheduling", async () => {
  const input = await manifest();
  const first = expandExperimentPlan(input);
  const repeated = expandExperimentPlan(structuredClone(input));
  assert.deepEqual(repeated, first);
  assert.equal(first.trials.length, 4);
  assert.deepEqual(first.trials.map(({ candidateId, replicate }) => [candidateId, replicate]), [
    ["candidate:direct", 1], ["candidate:direct", 2], ["candidate:nelos", 1], ["candidate:nelos", 2],
  ]);
  assert.equal(new Set(first.trials.map(({ trialId }) => trialId)).size, 4);
  assert.equal(new Set(first.trials.map(({ componentSeeds }) => componentSeeds.candidate)).size, 4);

  const differentScheduling = await manifest({ policy: { ...input.policy, maxConcurrency: 1 } });
  assert.deepEqual(expandExperimentPlan(differentScheduling).trials.map(({ trialId }) => trialId), first.trials.map(({ trialId }) => trialId));
  const unsealed = structuredClone(input);
  unsealed.experiment = buildExperimentV1();
  assert.throws(() => expandExperimentPlan(unsealed), errorCode("EXPERIMENT_NOT_SEALED"));
});

test("direct Codex and Nelos receive equivalent declared inputs and budgets with explicit arm provenance", async () => {
  const input = await manifest();
  const requests = [];
  const database = await store();
  const implementation = adapters(async (request) => {
    if (request.runId === "run:equivalence-one") {
      assert.equal(await database.readGenerationRef(request.runId, request.runGeneration, "manifest"), expandExperimentPlan(input).manifestDigest);
      assert.ok(await database.readGenerationRef(request.runId, request.runGeneration, "plan"));
    }
    requests.push(request);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, request.requestedRoute.adapter === "nelos" ? 1 : 5));
    return result(request);
  });
  const first = await runExperiment({ manifest: input, store: database, adapters: implementation, runId: "run:equivalence-one" });
  assert.equal(first.outcome, "succeeded");
  assert.equal(first.trialCount, 4);
  const byReplicate = Map.groupBy(requests, ({ seed }) => seed);
  for (const paired of byReplicate.values()) {
    assert.equal(paired.length, 2);
    assert.equal(paired[0].declaredInputsDigest, paired[1].declaredInputsDigest);
    assert.deepEqual(paired[0].budget, paired[1].budget);
    assert.notEqual(paired[0].requestedRoute.adapter, paired[1].requestedRoute.adapter);
  }

  const serial = await manifest({ policy: { ...input.policy, maxConcurrency: 1 } });
  const second = await runExperiment({ manifest: serial, store: await store(), adapters: implementation, runId: "run:equivalence-two" });
  assert.equal(second.outcome, "succeeded");
  assert.deepEqual(expandExperimentPlan(input).trials.map(({ trialId }) => trialId), expandExperimentPlan(serial).trials.map(({ trialId }) => trialId));
});

test("command replay is idempotent and conflicting reuse fails closed", async () => {
  const database = await store();
  let effects = 0;
  const command = { commandId: "command:one", idempotencyKey: "stable-key", scope: "run:test", expectedRevision: 1, input: { value: 1 } };
  const first = await database.recordCommand(command, async () => ({ count: ++effects }));
  const replay = await database.recordCommand(command, async () => ({ count: ++effects }));
  assert.deepEqual(replay, first);
  assert.equal(effects, 1);
  await assert.rejects(database.recordCommand({ ...command, input: { value: 2 } }, async () => ({ count: ++effects })), errorCode("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(database.recordCommand({ ...command, idempotencyKey: "different-key" }, async () => ({ count: ++effects })), errorCode("IDEMPOTENCY_CONFLICT"));
  assert.equal(effects, 1);
});

test("resume adopts only verified authoritative terminal attempts and advances generation", async () => {
  const input = await manifest({ policy: { ...(await manifest()).policy, maxAttempts: 1 } });
  const database = await store();
  const seen = [];
  const first = await runExperiment({
    manifest: input,
    store: database,
    adapters: adapters(async (request) => {
      seen.push([1, request.trialId]);
      return request.requestedRoute.adapter === "direct-codex"
        ? result(request)
        : result(request, { outcome: "incomplete", evidenceComplete: false, retryable: false, outputs: [], artifacts: [] });
    }),
    runId: "run:resume",
  });
  assert.equal(first.outcome, "incomplete");
  assert.equal(first.attempts.filter(({ authoritative }) => authoritative).length, 2);

  const secondSeen = [];
  const resumed = await runExperiment({
    manifest: input,
    store: database,
    adapters: adapters(async (request) => { secondSeen.push(request.trialId); return result(request); }),
    runId: "run:resume",
    resume: { runId: "run:resume", generation: 1 },
  });
  assert.equal(resumed.generation, 2);
  assert.equal(resumed.outcome, "succeeded");
  assert.equal(secondSeen.length, 2);
  assert.ok(resumed.attempts.filter(({ adoptedFromGeneration }) => adoptedFromGeneration === 1).every(({ authoritative }) => authoritative));
  const index = JSON.parse(await readFile(resolve(database.root, "index", "runs.json"), "utf8"));
  assert.deepEqual(index.rows.map(({ generation }) => generation), [1, 2]);
});

test("cancellation, partial evidence, and route mismatch retain bundles and finalize distinctly", async () => {
  const input = await manifest({ policy: { ...(await manifest()).policy, maxAttempts: 1 } });
  const cancelledController = new AbortController();
  let notifyStarted;
  const started = new Promise((resolveStarted) => { notifyStarted = resolveStarted; });
  const cancellationAdapters = adapters(async (request, context) => new Promise((resolveAttempt) => {
    notifyStarted();
    context.controller.signal.addEventListener("abort", () => resolveAttempt(result(request, { outcome: "cancelled", outputs: [], artifacts: [], measurements: [] })), { once: true });
  }));
  const cancellation = runExperiment({ manifest: input, store: await store(), adapters: cancellationAdapters, runId: "run:cancel", signal: cancelledController.signal });
  await started;
  cancelledController.abort();
  const cancelled = await cancellation;
  assert.equal(cancelled.outcome, "cancelled");
  assert.ok(cancelled.attempts.length > 0);

  const partial = await runExperiment({
    manifest: input, store: await store(), adapters: adapters(async (request) => result(request, { outcome: "succeeded", evidenceComplete: false, outputs: [], artifacts: [] })), runId: "run:partial",
  });
  assert.equal(partial.outcome, "incomplete");
  assert.ok(partial.attempts.every(({ authoritative }) => !authoritative));

  const mismatch = await runExperiment({
    manifest: input, store: await store(), adapters: adapters(async (request) => result(request, { observedRoute: { ...request.requestedRoute, modelRevision: "substituted" } })), runId: "run:mismatch",
  });
  assert.equal(mismatch.outcome, "invalid");
  assert.ok(mismatch.attempts.every(({ outcome, authoritative }) => outcome === "invalid" && authoritative));
});

test("ambiguous dispatch reconciles once and never blindly repeats", async () => {
  const input = await manifest({ policy: { ...(await manifest()).policy, maxAttempts: 1 } });
  let dispatched = 0;
  let reconciled = 0;
  const make = (kind) => ({
    kind,
    version: "reconcile-v1",
    execute: async () => { dispatched += 1; throw new Error("lost receipt"); },
    cancel: async () => null,
    reconcile: async (operationId, context) => {
      reconciled += 1;
      const trial = expandExperimentPlan(input).trials.find(({ trialId }) => trialId === context.trialId);
      return result({ operationId, requestedRoute: {
        candidateId: trial.candidateId, adapter: trial.adapter, modelId: trial.candidateProvenance.model.id,
        modelRevision: trial.candidateProvenance.model.revision, reasoningEffort: trial.candidateProvenance.model.reasoningEffort,
        pluginDigest: (await import("../src/experimentation-contract/index.mjs")).canonicalDigest(trial.candidateProvenance.plugins),
      } }, { outputs: [{ id: "result", digest: "sha256:" + "a".repeat(64), byteLength: 1 }], artifacts: [] });
    },
  });
  const implementations = {
    "direct-codex": createDirectCodexAdapter(make("direct-codex")),
    nelos: createNelosAdapter(make("nelos")),
  };
  const run = await runExperiment({ manifest: input, store: await store(), adapters: implementations, runId: "run:reconcile" });
  assert.equal(run.outcome, "succeeded");
  assert.equal(dispatched, 4);
  assert.equal(reconciled, 4);
});

test("timeouts and retryable ambiguity preserve prior attempts while terminal outcomes stay distinct", async () => {
  const input = await manifest();
  const counts = new Map();
  const recovered = await runExperiment({
    manifest: input,
    store: await store(),
    adapters: adapters(async (request) => {
      const count = (counts.get(request.trialId) ?? 0) + 1;
      counts.set(request.trialId, count);
      if (count === 1) throw new ExperimentRunnerError("ATTEMPT_TIMEOUT", "simulated timeout");
      return result(request);
    }),
    runId: "run:retry",
  });
  assert.equal(recovered.outcome, "succeeded");
  assert.equal(recovered.attempts.length, 8);
  for (const attemptsForTrial of Map.groupBy(recovered.attempts, ({ trialId }) => trialId).values()) {
    assert.deepEqual(attemptsForTrial.map(({ attempt, outcome }) => [attempt, outcome]), [[1, "inconclusive"], [2, "succeeded"]]);
    assert.notEqual(attemptsForTrial[0].bundleDigest, attemptsForTrial[1].bundleDigest);
  }

  for (const outcome of ["failed", "inconclusive"]) {
    const terminal = await runExperiment({
      manifest: { ...input, policy: { ...input.policy, maxAttempts: 1 } },
      store: await store(),
      adapters: adapters(async (request) => result(request, { outcome, retryable: false })),
      runId: `run:${outcome}`,
    });
    assert.equal(terminal.outcome, outcome);
  }
});

test("headless CLI runs the repeated direct-versus-Nelos matrix twice with identical plans and isolated stores", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nelos-experiment-cli-"));
  const adapterPath = resolve(new URL("../scripts/test-support/fake-experiment-adapter.mjs", import.meta.url).pathname);
  const input = await manifest();
  input.adapters["direct-codex"].command = [process.execPath, adapterPath];
  input.adapters.nelos.command = [process.execPath, adapterPath];
  const manifestPath = resolve(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(input));
  const cli = resolve(new URL("../bin/nelos-experiment", import.meta.url).pathname);
  const firstPlan = JSON.parse((await executeFile(process.execPath, [cli, "plan", "--manifest", manifestPath])).stdout);
  const secondPlan = JSON.parse((await executeFile(process.execPath, [cli, "plan", "--manifest", manifestPath])).stdout);
  assert.deepEqual(secondPlan, firstPlan);

  const first = JSON.parse((await executeFile(process.execPath, [cli, "run", "--manifest", manifestPath, "--store", resolve(root, "store-one"), "--run-id", "run:cli-one"])).stdout);
  const second = JSON.parse((await executeFile(process.execPath, [cli, "run", "--manifest", manifestPath, "--store", resolve(root, "store-two"), "--run-id", "run:cli-two"])).stdout);
  assert.equal(first.outcome, "succeeded");
  assert.equal(second.outcome, "succeeded");
  assert.equal(first.planDigest, second.planDigest);
  assert.notEqual(first.runId, second.runId);
});
