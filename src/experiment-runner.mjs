import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  canonicalBytes,
  canonicalDigest,
  parseCanonicalJsonV1,
  sealExperiment,
  sealTask,
} from "./experimentation-contract/index.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";

export const RUNNER_SCHEMA_VERSION = 1;
export const RUN_OUTCOMES = Object.freeze([
  "succeeded", "failed", "invalid", "cancelled", "incomplete", "inconclusive",
]);
export const TERMINAL_ATTEMPT_OUTCOMES = Object.freeze([
  "succeeded", "failed", "invalid", "cancelled", "inconclusive",
]);

const ADAPTER_KINDS = Object.freeze(["direct-codex", "nelos"]);
const DEFAULT_POLICY = Object.freeze({
  maxConcurrency: 1,
  perAdapterConcurrency: Object.freeze({ "direct-codex": 1, nelos: 1 }),
  leaseMs: 300_000,
  timeoutMs: 300_000,
  maxAttempts: 2,
});

export class ExperimentRunnerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExperimentRunnerError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new ExperimentRunnerError(code, message, details);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("INVALID_MANIFEST", `${label} must be a plain object`);
  }
}

function closedObject(value, fields, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("INVALID_MANIFEST", `${label} fields must match the closed schema`, { actual, expected });
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail("INVALID_MANIFEST", `${label} must be a positive safe integer`);
}

function normalizePolicy(policy) {
  closedObject(policy, Object.keys(DEFAULT_POLICY), "manifest.policy");
  const normalized = { ...policy, perAdapterConcurrency: { ...policy.perAdapterConcurrency } };
  for (const field of ["maxConcurrency", "leaseMs", "timeoutMs", "maxAttempts"]) positiveInteger(normalized[field], `manifest.policy.${field}`);
  closedObject(normalized.perAdapterConcurrency, ADAPTER_KINDS, "manifest.policy.perAdapterConcurrency");
  for (const kind of ADAPTER_KINDS) positiveInteger(normalized.perAdapterConcurrency[kind], `manifest.policy.perAdapterConcurrency.${kind}`);
  return Object.freeze({ ...normalized, perAdapterConcurrency: Object.freeze(normalized.perAdapterConcurrency) });
}

function validateAdapterDeclaration(value, kind) {
  closedObject(value, ["command", "environment", "version"], `manifest.adapters.${kind}`);
  if (!Array.isArray(value.command) || value.command.length === 0 || value.command.some((argument) => typeof argument !== "string" || argument.length === 0 || argument.includes("\0"))) {
    fail("INVALID_MANIFEST", `manifest.adapters.${kind}.command must be a non-empty argv array`);
  }
  plainObject(value.environment, `manifest.adapters.${kind}.environment`);
  for (const [name, entry] of Object.entries(value.environment)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) || typeof entry !== "string") fail("INVALID_MANIFEST", `manifest.adapters.${kind}.environment is invalid`);
    if (/TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|PRIVATE|CREDENTIAL|API_KEY/iu.test(name)) fail("INVALID_MANIFEST", "adapter declarations cannot embed secret-bearing environment variables");
  }
  if (typeof value.version !== "string" || value.version.length === 0) fail("INVALID_MANIFEST", `manifest.adapters.${kind}.version is required`);
  return Object.freeze({ command: Object.freeze([...value.command]), environment: Object.freeze({ ...value.environment }), version: value.version });
}

export function validateRunnerManifest(manifest) {
  closedObject(manifest, ["schemaVersion", "experiment", "tasks", "adapters", "policy"], "manifest");
  if (manifest.schemaVersion !== RUNNER_SCHEMA_VERSION) fail("INVALID_MANIFEST", "unsupported runner manifest schema version");
  sealExperiment(manifest.experiment);
  if (manifest.experiment.state !== "sealed") fail("EXPERIMENT_NOT_SEALED", "experiment must be sealed before expansion", { state: manifest.experiment.state });
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) fail("INVALID_MANIFEST", "manifest.tasks must be non-empty");
  const tasks = manifest.tasks.map((task) => {
    sealTask(task);
    if (task.state !== "sealed") fail("TASK_NOT_SEALED", "every task must be sealed before expansion", { taskId: task.taskId, state: task.state });
    return task;
  });
  if (new Set(tasks.map(({ taskId }) => taskId)).size !== tasks.length) fail("INVALID_MANIFEST", "manifest tasks must be unique");
  closedObject(manifest.adapters, ADAPTER_KINDS, "manifest.adapters");
  const adapters = Object.fromEntries(ADAPTER_KINDS.map((kind) => [kind, validateAdapterDeclaration(manifest.adapters[kind], kind)]));
  const declaredKinds = new Set(manifest.experiment.candidates.map(({ adapter }) => adapter));
  for (const kind of declaredKinds) if (!ADAPTER_KINDS.includes(kind)) fail("UNSUPPORTED_ADAPTER", `candidate adapter is unsupported: ${kind}`);
  const policy = normalizePolicy(manifest.policy);
  return Object.freeze({
    schemaVersion: RUNNER_SCHEMA_VERSION,
    experiment: manifest.experiment,
    tasks: Object.freeze(tasks),
    adapters: Object.freeze(adapters),
    policy,
  });
}

function effectiveLimits(experiment, task) {
  const limits = {};
  for (const field of Object.keys(experiment.limits).sort()) limits[field] = Math.min(experiment.limits[field], task.limits[field]);
  return Object.freeze(limits);
}

function declaredInputs(task, experiment) {
  return Object.freeze({
    taskId: task.taskId,
    taskRevision: task.specRevision,
    taskDigest: task.digest,
    prompt: task.prompt,
    fixture: task.fixture,
    baseline: task.baseline,
    inputs: task.inputs,
    determinism: task.determinism,
    permissions: task.permissions,
    tools: task.tools,
    network: task.network,
    environment: task.environment,
    outputs: task.outputs,
    artifacts: task.artifacts,
    limits: effectiveLimits(experiment, task),
  });
}

function trialIdentity({ experiment, task, candidate, runtime, replicate, seed }) {
  const material = {
    experimentId: experiment.experimentId,
    experimentDigest: experiment.digest,
    candidateId: candidate.candidateId,
    candidateDigest: canonicalDigest(candidate),
    taskId: task.taskId,
    taskRevision: task.specRevision,
    taskDigest: task.digest,
    runtimeLockId: runtime.runtimeLockId,
    runtimeDigest: runtime.digest,
    replicate,
    seed,
    environmentDigest: canonicalDigest(task.environment),
  };
  const trialKey = canonicalDigest(material);
  return Object.freeze({ trialKey, trialId: `trial:${trialKey.slice(7)}` });
}

export function expandExperimentPlan(rawManifest) {
  const manifest = validateRunnerManifest(rawManifest);
  const manifestDigest = canonicalDigest(manifest);
  const trials = [];
  for (const task of manifest.tasks) {
    for (const candidate of manifest.experiment.candidates) {
      for (const runtime of manifest.experiment.runtimeMatrix) {
        if (!runtime.eligibleCandidateIds.includes(candidate.candidateId)) continue;
        for (const schedule of manifest.experiment.design.seedSchedule) {
          const identity = trialIdentity({ experiment: manifest.experiment, task, candidate, runtime, replicate: schedule.replicate, seed: schedule.seed });
          const componentSeeds = Object.freeze({
            candidate: canonicalDigest({ seedRoot: manifest.experiment.design.seedRoot, trialKey: identity.trialKey, component: "candidate" }),
            grader: canonicalDigest({ seedRoot: manifest.experiment.design.seedRoot, trialKey: identity.trialKey, component: "grader" }),
            scheduler: canonicalDigest({ seedRoot: manifest.experiment.design.seedRoot, trialKey: identity.trialKey, component: "scheduler" }),
          });
          const inputs = structuredClone(declaredInputs(task, manifest.experiment));
          trials.push(Object.freeze({
            ordinal: trials.length,
            ...identity,
            taskId: task.taskId,
            taskRevision: task.specRevision,
            taskDigest: task.digest,
            candidateId: candidate.candidateId,
            adapter: candidate.adapter,
            candidateProvenance: structuredClone(candidate),
            runtime: structuredClone(runtime),
            replicate: schedule.replicate,
            seed: schedule.seed,
            componentSeeds,
            declaredInputs: inputs,
            declaredInputsDigest: canonicalDigest(inputs),
            budget: structuredClone(inputs.limits),
          }));
        }
      }
    }
  }
  if (new Set(trials.map(({ trialId }) => trialId)).size !== trials.length) fail("DUPLICATE_TRIAL", "matrix expansion produced duplicate trial identities");
  const unsigned = { schemaVersion: RUNNER_SCHEMA_VERSION, experimentId: manifest.experiment.experimentId, experimentDigest: manifest.experiment.digest, manifestDigest, trials };
  return Object.freeze({ ...unsigned, planDigest: canonicalDigest(unsigned) });
}

async function writeExclusive(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, 0o400);
}

async function writeImmutable(path, bytes) {
  try { await writeExclusive(path, bytes); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(bytes)) fail("IMMUTABLE_CONFLICT", "immutable path contains different bytes", { path });
  }
}

async function replaceJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, canonicalBytes(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export class ExperimentRunStore {
  #root;
  #objects;
  #refs;
  #commands;
  #mutex = Promise.resolve();

  constructor(root) {
    this.#root = root;
    this.#objects = resolve(root, "objects", "sha256");
    this.#refs = resolve(root, "refs");
    this.#commands = resolve(root, "commands");
  }

  static async open(root) {
    const canonicalRoot = await ensureCanonicalDirectory(root, "experiment run store", { mode: 0o700, enforceMode: true });
    await Promise.all([
      mkdir(resolve(canonicalRoot, "objects", "sha256"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(canonicalRoot, "refs"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(canonicalRoot, "commands"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(canonicalRoot, "index"), { recursive: true, mode: 0o700 }),
    ]);
    return new ExperimentRunStore(canonicalRoot);
  }

  get root() { return this.#root; }

  async commit(value) {
    const bytes = canonicalBytes(value);
    const digest = canonicalDigest(value);
    const target = resolve(this.#objects, digest.slice(7));
    await writeImmutable(target, bytes);
    return Object.freeze({ digest, byteLength: bytes.byteLength });
  }

  async read(digest) {
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) fail("INVALID_DIGEST", "content digest is invalid");
    let bytes;
    try { bytes = await readFile(resolve(this.#objects, digest.slice(7))); } catch (error) { if (error.code === "ENOENT") fail("MISSING_ARTIFACT", "content-addressed object is missing", { digest }); throw error; }
    const value = parseCanonicalJsonV1(bytes, { contractKind: "ExperimentRunArtifact", schemaVersion: 1 });
    if (canonicalDigest(value) !== digest) fail("ALTERED_ARTIFACT", "content-addressed object digest does not match", { digest });
    return value;
  }

  async writeGenerationRef(runId, generation, name, digest) {
    const path = resolve(this.#refs, runId, `generation-${generation}`, `${name}.digest`);
    await writeImmutable(path, Buffer.from(`${digest}\n`, "utf8"));
  }

  async readGenerationRef(runId, generation, name) {
    try { return (await readFile(resolve(this.#refs, runId, `generation-${generation}`, `${name}.digest`), "utf8")).trim(); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async recordCommand(command, effect) {
    closedObject(command, ["commandId", "idempotencyKey", "scope", "expectedRevision", "input"], "command");
    for (const field of ["commandId", "idempotencyKey", "scope"]) if (typeof command[field] !== "string" || command[field].length === 0) fail("INVALID_COMMAND", `command.${field} is required`);
    positiveInteger(command.expectedRevision, "command.expectedRevision");
    const inputDigest = canonicalDigest(command.input);
    const identityDigest = canonicalDigest({ commandId: command.commandId, idempotencyKey: command.idempotencyKey, scope: command.scope, expectedRevision: command.expectedRevision, inputDigest });
    const idempotencyPath = resolve(this.#commands, "by-idempotency", `${canonicalDigest(command.idempotencyKey).slice(7)}.json`);
    const commandPath = resolve(this.#commands, "by-command", `${canonicalDigest(command.commandId).slice(7)}.json`);
    const operation = this.#mutex.then(async () => {
      const existingPath = await exists(idempotencyPath) ? idempotencyPath : await exists(commandPath) ? commandPath : null;
      if (existingPath) {
        const receipt = parseCanonicalJsonV1(await readFile(existingPath), { contractKind: "ExperimentCommandReceipt", schemaVersion: 1 });
        if (receipt.identityDigest !== identityDigest) fail("IDEMPOTENCY_CONFLICT", "idempotency key was reused with different command input", { idempotencyKey: command.idempotencyKey });
        const bytes = canonicalBytes(receipt);
        await writeImmutable(idempotencyPath, bytes);
        await writeImmutable(commandPath, bytes);
        return Object.freeze(JSON.parse(JSON.stringify(receipt)));
      }
      const effectResult = await effect();
      const unsigned = { schemaVersion: 1, ...command, inputDigest, identityDigest, effectResult };
      const receipt = Object.freeze({ ...unsigned, receiptDigest: canonicalDigest(unsigned) });
      const bytes = canonicalBytes(receipt);
      await writeImmutable(idempotencyPath, bytes);
      await writeImmutable(commandPath, bytes);
      return receipt;
    });
    this.#mutex = operation.catch(() => {});
    return operation;
  }

  async replaceIndex(runs) {
    const rows = runs.map((run) => ({ runId: run.runId, generation: run.generation, outcome: run.outcome, experimentId: run.experimentId, finalDigest: run.finalDigest })).sort((a, b) => a.runId.localeCompare(b.runId) || a.generation - b.generation);
    const index = { schemaVersion: 1, generatedFrom: canonicalDigest(rows), rows };
    await replaceJson(resolve(this.#root, "index", "runs.json"), index);
    return index;
  }

  async updateIndex(run) {
    const path = resolve(this.#root, "index", "runs.json");
    let rows = [];
    try {
      const current = parseCanonicalJsonV1(await readFile(path), { contractKind: "ExperimentRunIndex", schemaVersion: 1 });
      if (Array.isArray(current.rows)) rows = current.rows;
    } catch (error) {
      if (error.code !== "ENOENT") rows = [];
    }
    const retained = rows.filter((row) => row.runId !== run.runId || row.generation !== run.generation);
    return this.replaceIndex([...retained, run]);
  }
}

function normalizeAdapterResult(result) {
  plainObject(result, "adapter result");
  const fields = ["outcome", "observedRoute", "operationId", "outputs", "artifacts", "measurements", "evidenceComplete", "retryable"];
  closedObject(result, fields, "adapter result");
  if (!TERMINAL_ATTEMPT_OUTCOMES.includes(result.outcome) && result.outcome !== "incomplete") fail("INVALID_ADAPTER_RESULT", "adapter outcome is invalid");
  if (typeof result.operationId !== "string" || result.operationId.length === 0) fail("INVALID_ADAPTER_RESULT", "adapter operationId is required");
  plainObject(result.observedRoute, "adapter result observedRoute");
  if (!Array.isArray(result.outputs) || !Array.isArray(result.artifacts) || !Array.isArray(result.measurements) || typeof result.evidenceComplete !== "boolean" || typeof result.retryable !== "boolean") fail("INVALID_ADAPTER_RESULT", "adapter result evidence fields are invalid");
  return Object.freeze(structuredClone(result));
}

export function createCandidateAdapter({ kind, version, execute, cancel, reconcile }) {
  if (!ADAPTER_KINDS.includes(kind) || typeof version !== "string" || !version || typeof execute !== "function" || typeof cancel !== "function" || typeof reconcile !== "function") {
    fail("INVALID_ADAPTER", "candidate adapter must implement execute, cancel, and reconcile");
  }
  return Object.freeze({
    kind,
    version,
    async execute(request, context) { return normalizeAdapterResult(await execute(request, context)); },
    async cancel(operationId, context) { return cancel(operationId, context); },
    async reconcile(operationId, context) {
      const result = await reconcile(operationId, context);
      return result === null ? null : normalizeAdapterResult(result);
    },
  });
}

export function createDirectCodexAdapter(options) { return createCandidateAdapter({ kind: "direct-codex", ...options }); }
export function createNelosAdapter(options) { return createCandidateAdapter({ kind: "nelos", ...options }); }

function runProcess(command, request, { signal, timeoutMs, environment }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timer;
    const finish = (callback) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); callback(); };
    const abort = () => { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch {} };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, killedSignal) => finish(() => {
      if (code !== 0) return reject(new ExperimentRunnerError("ADAPTER_PROCESS_FAILED", "adapter command failed", { code, signal: killedSignal, stderr: Buffer.concat(stderr).toString("utf8") }));
      try { resolvePromise(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
      catch { reject(new ExperimentRunnerError("INVALID_ADAPTER_RESULT", "adapter command did not emit one JSON result", { stderr: Buffer.concat(stderr).toString("utf8") })); }
    }));
    child.stdin.end(canonicalBytes(request));
    timer = setTimeout(() => finish(() => {
      abort();
      reject(new ExperimentRunnerError("ATTEMPT_TIMEOUT", "adapter command exceeded its timeout", { timeoutMs }));
    }), timeoutMs);
  });
}

export function createProcessCandidateAdapter({ kind, version, command, environment = {} }) {
  const operations = new Map();
  return createCandidateAdapter({
    kind,
    version,
    async execute(request, context) {
      const operationId = context.operationId;
      operations.set(operationId, { state: "running", controller: context.controller });
      try {
        const result = await runProcess(command, request, { signal: context.controller.signal, timeoutMs: context.timeoutMs, environment });
        const normalized = { ...result, operationId: result.operationId ?? operationId };
        operations.set(operationId, { state: "terminal", result: normalized });
        return normalized;
      } catch (error) {
        operations.set(operationId, { state: "ambiguous", error: error.code ?? "ADAPTER_PROCESS_FAILED" });
        throw error;
      }
    },
    async cancel(operationId) {
      const operation = operations.get(operationId);
      if (!operation) return { cancelled: false, reason: "unknown-operation" };
      operation.controller?.abort();
      return { cancelled: true, operationId };
    },
    async reconcile(operationId) {
      const operation = operations.get(operationId);
      return operation?.state === "terminal" ? operation.result : null;
    },
  });
}

function requestedRoute(trial) {
  return Object.freeze({
    candidateId: trial.candidateId,
    adapter: trial.adapter,
    modelId: trial.candidateProvenance.model.id,
    modelRevision: trial.candidateProvenance.model.revision,
    reasoningEffort: trial.candidateProvenance.model.reasoningEffort,
    pluginDigest: canonicalDigest(trial.candidateProvenance.plugins),
  });
}

function routesMatch(requested, observed) {
  return Object.keys(requested).every((field) => observed[field] === requested[field]);
}

function declaredEvidenceComplete(trial, result) {
  const verify = (declarations, entries) => {
    const byId = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string" || byId.has(entry.id)) return false;
      if (!/^sha256:[0-9a-f]{64}$/u.test(entry.digest) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) return false;
      byId.set(entry.id, entry);
    }
    return declarations.filter(({ required }) => required).every((declaration) => {
      const entry = byId.get(declaration.id);
      return entry && entry.byteLength <= declaration.maxBytes;
    });
  };
  return result.evidenceComplete
    && verify(trial.declaredInputs.outputs, result.outputs)
    && verify(trial.declaredInputs.artifacts, result.artifacts);
}

function attemptNumber(previousAttempts, trialId) {
  return 1 + previousAttempts.filter((attempt) => attempt.trialId === trialId).reduce((maximum, attempt) => Math.max(maximum, attempt.attempt), 0);
}

function finalizeOutcome(attempts, plan, cancellationRequested) {
  const authoritative = new Map();
  for (const attempt of attempts) if (attempt.authoritative && TERMINAL_ATTEMPT_OUTCOMES.includes(attempt.outcome)) authoritative.set(attempt.trialId, attempt);
  if (authoritative.size !== plan.trials.length) return cancellationRequested ? "cancelled" : "incomplete";
  const outcomes = [...authoritative.values()].map(({ outcome }) => outcome);
  if (outcomes.includes("invalid")) return "invalid";
  if (outcomes.includes("inconclusive")) return "inconclusive";
  if (outcomes.includes("cancelled")) return "cancelled";
  if (outcomes.includes("failed")) return "failed";
  return outcomes.every((outcome) => outcome === "succeeded") ? "succeeded" : "inconclusive";
}

async function verifyAttempt(store, attempt) {
  const stored = await store.read(attempt.objectDigest);
  if (stored.bundleDigest !== attempt.bundleDigest || stored.trialId !== attempt.trialId || stored.attempt !== attempt.attempt) fail("ALTERED_ATTEMPT", "attempt bundle identity does not match its reference");
  const unsigned = { ...stored }; delete unsigned.bundleDigest;
  if (canonicalDigest(unsigned) !== stored.bundleDigest) fail("ALTERED_ATTEMPT", "attempt bundle digest is invalid");
  return stored;
}

export async function runExperiment({ manifest: rawManifest, store, adapters, runId = `run:${randomUUID()}`, resume = null, signal = null, clock = Date }) {
  const manifest = validateRunnerManifest(rawManifest);
  const plan = expandExperimentPlan(manifest);
  if (!(store instanceof ExperimentRunStore)) fail("INVALID_STORE", "runExperiment requires an ExperimentRunStore");
  for (const kind of new Set(plan.trials.map(({ adapter }) => adapter))) if (adapters?.[kind]?.kind !== kind) fail("MISSING_ADAPTER", `adapter implementation is missing: ${kind}`);
  let generation = 1;
  const attempts = [];
  const adoptedTrialIds = new Set();
  if (resume) {
    if (resume.runId !== runId) fail("RESUME_MISMATCH", "resume source must belong to the same run ID");
    const previousFinalDigest = await store.readGenerationRef(runId, resume.generation, "final");
    if (!previousFinalDigest) fail("RESUME_MISSING", "resume source final record is missing");
    const previous = await store.read(previousFinalDigest);
    const previousMaterial = { ...previous }; delete previousMaterial.finalDigest;
    if (canonicalDigest(previousMaterial) !== previous.finalDigest || previous.runId !== runId || previous.generation !== resume.generation) {
      fail("RESUME_MISMATCH", "resume source final record identity is invalid");
    }
    if (previous.planDigest !== plan.planDigest || previous.manifestDigest !== plan.manifestDigest) fail("RESUME_MISMATCH", "resume source plan or manifest does not match");
    generation = resume.generation + 1;
    for (const reference of previous.attempts) {
      if (!TERMINAL_ATTEMPT_OUTCOMES.includes(reference.outcome)) continue;
      const verified = await verifyAttempt(store, reference);
      if (!verified.authoritative || adoptedTrialIds.has(verified.trialId)) continue;
      attempts.push(Object.freeze({ ...verified, objectDigest: reference.objectDigest, adoptedFromGeneration: resume.generation }));
      adoptedTrialIds.add(verified.trialId);
    }
  }
  const manifestObject = await store.commit(manifest);
  if (manifestObject.digest !== plan.manifestDigest) fail("MANIFEST_DIGEST_MISMATCH", "persisted manifest digest changed during validation");
  const planObject = await store.commit(plan);
  const planMaterial = { ...plan }; delete planMaterial.planDigest;
  if (canonicalDigest(planMaterial) !== plan.planDigest) fail("PLAN_DIGEST_MISMATCH", "persisted expansion digest changed before scheduling");
  await store.writeGenerationRef(runId, generation, "manifest", manifestObject.digest);
  await store.writeGenerationRef(runId, generation, "plan", planObject.digest);

  const pending = plan.trials.filter(({ trialId }) => !adoptedTrialIds.has(trialId));
  const active = new Map();
  const adapterActive = new Map(ADAPTER_KINDS.map((kind) => [kind, 0]));
  let cancellationRequested = signal?.aborted === true;
  const cancelAll = async () => {
    cancellationRequested = true;
    await Promise.all([...active.values()].map(({ adapter, operationId, controller }) => {
      controller.abort();
      return adapter.cancel(operationId, { runId, generation }).catch(() => null);
    }));
  };
  signal?.addEventListener("abort", cancelAll, { once: true });

  const executeTrial = async (trial) => {
    const adapter = adapters[trial.adapter];
    let attempt = attemptNumber(attempts, trial.trialId);
    while (attempt <= manifest.policy.maxAttempts && !cancellationRequested) {
      const operationId = `op:${canonicalDigest({ runId, generation, trialId: trial.trialId, attempt }).slice(7)}`;
      const fencingToken = canonicalDigest({ runId, generation, trialId: trial.trialId, attempt, operationId });
      const startedAt = new Date(clock.now()).toISOString();
      const lease = Object.freeze({
        leaseId: `lease:${fencingToken.slice(7)}`,
        owner: `controller:${runId}`,
        fencingToken,
        acquiredAt: startedAt,
        expiresAt: new Date(clock.now() + manifest.policy.leaseMs).toISOString(),
      });
      const route = requestedRoute(trial);
      const request = Object.freeze({
        schemaVersion: 1, runId, runGeneration: generation, trialId: trial.trialId, attempt,
        operationId, lease, seed: trial.seed, componentSeeds: trial.componentSeeds,
        declaredInputs: trial.declaredInputs, declaredInputsDigest: trial.declaredInputsDigest,
        budget: trial.budget, requestedRoute: route,
      });
      const controller = new AbortController();
      active.set(trial.trialId, { adapter, operationId, controller });
      let result;
      let ambiguity = null;
      try {
        result = await adapter.execute(request, { operationId, controller, timeoutMs: Math.min(manifest.policy.timeoutMs, trial.budget.wallClockSeconds * 1000), fencingToken });
      } catch (error) {
        const reconciled = await adapter.reconcile(operationId, { fencingToken, runId, generation, trialId: trial.trialId, attempt }).catch(() => null);
        if (reconciled) result = reconciled;
        else ambiguity = { code: error.code ?? "ADAPTER_FAILURE", message: error.message };
      }
      if (cancellationRequested && !result) result = { outcome: "cancelled", observedRoute: structuredClone(route), operationId, outputs: [], artifacts: [], measurements: [], evidenceComplete: true, retryable: false };
      if (!result) result = { outcome: "inconclusive", observedRoute: structuredClone(route), operationId, outputs: [], artifacts: [], measurements: [], evidenceComplete: false, retryable: true };
      const routeMatch = routesMatch(route, result.observedRoute);
      const leaseValid = clock.now() <= Date.parse(lease.expiresAt);
      const evidenceComplete = result.outcome === "cancelled" ? result.evidenceComplete : declaredEvidenceComplete(trial, result);
      let outcome = result.outcome;
      if (!routeMatch) outcome = "invalid";
      if (!leaseValid) outcome = "invalid";
      if (!evidenceComplete && outcome !== "cancelled") outcome = ambiguity ? "inconclusive" : "incomplete";
      const authoritative = TERMINAL_ATTEMPT_OUTCOMES.includes(outcome) && evidenceComplete && leaseValid;
      const unsigned = {
        schemaVersion: 1, runId, runGeneration: generation, planDigest: plan.planDigest,
        manifestDigest: plan.manifestDigest, trialId: trial.trialId, trialKey: trial.trialKey,
        attempt, operationId, lease, candidateId: trial.candidateId, adapter: trial.adapter,
        adapterVersion: adapter.version, candidateProvenance: trial.candidateProvenance,
        declaredInputsDigest: trial.declaredInputsDigest, budget: trial.budget,
        requestedRoute: route, observedRoute: result.observedRoute, routeMatch, leaseValid,
        outcome, authoritative, evidenceComplete, adapterEvidenceComplete: result.evidenceComplete,
        retryable: result.retryable, outputs: result.outputs, artifacts: result.artifacts, measurements: result.measurements,
        ambiguity, startedAt, finishedAt: new Date(clock.now()).toISOString(), adoptedFromGeneration: null,
      };
      const bundle = Object.freeze({ ...unsigned, bundleDigest: canonicalDigest(unsigned) });
      const committedBundle = await store.commit(bundle);
      attempts.push(Object.freeze({ ...bundle, objectDigest: committedBundle.digest }));
      if (authoritative || !result.retryable || attempt === manifest.policy.maxAttempts) break;
      attempt += 1;
    }
  };

  let cursor = 0;
  let fatalError = null;
  await new Promise((resolveAll) => {
    const schedule = () => {
      if ((cancellationRequested || cursor >= pending.length) && active.size === 0) return resolveAll();
      let progressed = false;
      while (!cancellationRequested && cursor < pending.length && active.size < manifest.policy.maxConcurrency) {
        let selected = -1;
        for (let index = cursor; index < pending.length; index += 1) {
          const trial = pending[index];
          if (adapterActive.get(trial.adapter) < manifest.policy.perAdapterConcurrency[trial.adapter]) { selected = index; break; }
        }
        if (selected < 0) break;
        const [trial] = pending.splice(selected, 1);
        if (selected === cursor) cursor += 0;
        adapterActive.set(trial.adapter, adapterActive.get(trial.adapter) + 1);
        progressed = true;
        executeTrial(trial).catch((error) => { fatalError ??= error; cancellationRequested = true; }).finally(() => {
          active.delete(trial.trialId);
          adapterActive.set(trial.adapter, adapterActive.get(trial.adapter) - 1);
          schedule();
        });
      }
      if (!progressed && active.size === 0 && cursor >= pending.length) resolveAll();
    };
    schedule();
  });
  signal?.removeEventListener("abort", cancelAll);
  if (fatalError) throw fatalError;

  const outcome = finalizeOutcome(attempts, plan, cancellationRequested);
  const finalUnsigned = {
    schemaVersion: 1, runId, generation, previousGeneration: resume?.generation ?? null,
    experimentId: plan.experimentId, experimentDigest: plan.experimentDigest,
    manifestDigest: plan.manifestDigest, planDigest: plan.planDigest, outcome,
    cancellationRequested, trialCount: plan.trials.length,
    attempts: attempts.map(({ trialId, attempt, outcome: attemptOutcome, authoritative, bundleDigest, objectDigest, adoptedFromGeneration }) => ({ trialId, attempt, outcome: attemptOutcome, authoritative, bundleDigest, objectDigest, adoptedFromGeneration })),
  };
  const final = Object.freeze({ ...finalUnsigned, finalDigest: canonicalDigest(finalUnsigned) });
  const committedFinal = await store.commit(final);
  await store.writeGenerationRef(runId, generation, "final", committedFinal.digest);
  await store.updateIndex(final).catch(() => null);
  return final;
}

export function adaptersFromManifest(manifest) {
  const validated = validateRunnerManifest(manifest);
  return Object.freeze(Object.fromEntries(ADAPTER_KINDS.map((kind) => [kind, createProcessCandidateAdapter({ kind, ...validated.adapters[kind] })])));
}
