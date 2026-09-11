import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { ExecutorServiceRuntimeV1 } from "./executor-service-runtime.mjs";
import { ExecutorLaunchJournalV1 } from "./executor-launch-journal.mjs";
import { ExecutionStoreV1, createWorkUnitSpecV1, workUnitDefinitionV1 } from "./execution-store.mjs";
import { QueenAcceptanceStoreV1, createQueenAcceptanceV1, queenAcceptanceIdV1, deriveWebReadinessV1 } from "./queen-acceptance.mjs";
import { ExecutorContractError, executorExact, executorDigest, executorContextFingerprintV1,
  executorText, normalizeExecutorWaveV1 } from "./executor-contract.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { readPrivateExecutorJsonV1 } from "./executor-service-channel.mjs";
import { probeAppServerExecutionV1 } from "./app-server-execution-profile.mjs";

const run = promisify(execFile);
// App Server config maps do not promise JSON property order. Identity follows
// values, while array order remains meaningful (for example layered policy).
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const observationDigest = (value) => executorDigest(canonical(value));
const fail = (code) => { throw new ExecutorContractError(code); };

export async function executorRepositoryIdentityV1(cwd) {
  if (!isAbsolute(cwd) || await realpath(cwd) !== cwd) fail("noncanonical-job-target");
  const git = async (...args) => (await run("git", ["-C", cwd, "rev-parse", ...args],
    { timeout: 5000, maxBuffer: 8192 })).stdout.trim();
  if (await realpath(await git("--show-toplevel")) !== cwd) fail("job-target-must-be-repository-root");
  const common = await realpath(await git("--path-format=absolute", "--git-common-dir"));
  return executorDigest({ common });
}

// An operator-installed, immutable job. RPC clients cannot supply a wave,
// prompt, target, authorizer, or permission policy. Initial rollout deliberately
// supports one preauthorized, read-only worker; this is not certification.
export function normalizeExecutorJobV1(value) {
  executorExact(value, ["schemaVersion", "command", "codexHome", "hostId", "expiresAt", "job"]);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.expiresAt)) fail("invalid-job-policy");
  for (const key of ["command", "codexHome"]) {
    executorText(value[key], 4096);
    if (!isAbsolute(value[key])) fail("absolute-executor-path-required");
  }
  executorText(value.hostId, 256);
  executorExact(value.job, ["wave", "workUnits", "prompts"]);
  const wave = normalizeExecutorWaveV1(value.job.wave);
  if (wave.members.length !== 1 || value.job.workUnits?.length !== 1 || value.job.prompts?.length !== 1) fail("single-worker-job-required");
  const member = wave.members[0];
  const unit = createWorkUnitSpecV1(value.job.workUnits[0]);
  const prompt = value.job.prompts[0];
  executorExact(prompt, ["sliceId", "text"]);
  if (member.workspaceMode !== "shared-read-only" || member.permissionProfile !== ":read-only" ||
      member.approvalPolicy !== "never" || member.target.hostId !== value.hostId ||
      member.target.codexHomeId !== executorDigest(value.codexHome) ||
      unit.workUnitId !== member.workUnitId || unit.specRevision !== member.specRevision ||
      unit.attempt !== member.attempt || unit.title !== member.title || unit.memberKind !== "spinoff" ||
      unit.dependencies.length || unit.binding.state !== "unbound" ||
      prompt.sliceId !== member.sliceId || typeof prompt.text !== "string" || !prompt.text.trim() ||
      Buffer.byteLength(prompt.text) > 32 * 1024 || executorDigest(prompt.text) !== member.promptDigest) fail("job-policy-scope-mismatch");
  return { ...value, job: { wave, workUnits: [workUnitDefinitionV1(unit)], prompts: [structuredClone(prompt)] } };
}

export class ExecutorJobServiceV1 {
  #config; #runtime; #units; #journal; #decisions; #launching = null; #joining = null; #directory; #starting = null;

  constructor({ config, directory, runtimeGeneration, sessionOptions = {} }) {
    this.#config = normalizeExecutorJobV1(config);
    this.#directory = directory;
    const selected = this.#config;
    const scopeDigest = executorDigest(selected.job.wave);
    const policyId = `operator-read-only:${executorDigest(selected)}`;
    const validateTarget = async (member) => member.target.repositoryId ===
      await executorRepositoryIdentityV1(member.target.cwd) &&
      await realpath(selected.codexHome) === selected.codexHome;
    this.#runtime = new ExecutorServiceRuntimeV1({ directory,
      scope: { hostId: selected.hostId, codexHomeId: executorDigest(selected.codexHome),
        authDomainId: executorDigest({ home: selected.codexHome, auth: "codex-managed" }) },
      runtimeGeneration,
      sessionOptions: { ...sessionOptions, command: selected.command,
        codexHome: selected.codexHome, cwd: selected.job.wave.members[0].target.cwd },
      validateTarget,
      validateRecovery: async (operation, { request, signal }) => {
        if (operation.scopeDigest !== scopeDigest ||
            executorDigest(operation.member) !== executorDigest(selected.job.wave.members[0])) return false;
        // Expired launch approval or changed config does not invalidate a read
        // of already-owned history. A changed account still blocks new reads.
        const account = await request("account/read", { refreshToken: false }, { signal });
        return observationDigest([account]) === operation.context.accountFingerprint;
      },
      evaluate: async (wave, { owner, request, observedVersion, signal }) => {
        if (executorDigest(wave) !== scopeDigest || Date.now() >= selected.expiresAt) fail("job-authorization-expired-or-mismatched");
        const member = wave.members[0];
        if (!await validateTarget(member)) fail("execution-target-unverified");
        const observations = new Map();
        const discovery = await probeAppServerExecutionV1({ observedVersion,
          request: async (method, params, options) => {
            const result = await request(method, params, { ...options, signal });
            const pages = observations.get(method) ?? [];
            pages.push(result); observations.set(method, pages); return result;
          }, options: { cwd: member.target.cwd, model: member.model, reasoningEffort: member.reasoningEffort,
            permissionProfile: member.permissionProfile, approvalPolicy: member.approvalPolicy } });
        if (discovery.state !== "discovery-complete") fail(`job-capability-${discovery.blockers[0]?.code ?? "unavailable"}`);
        const config = await request("config/read", { includeLayers: false }, { signal });
        if (!config?.config || typeof config.config !== "object" || Array.isArray(config.config)) fail("job-config-unavailable");
        return { context: { serviceId: policyId, ownerEpoch: owner.ownerEpoch,
          runtimeGeneration: owner.runtimeGeneration, accountFingerprint: observationDigest(observations.get("account/read")),
          configFingerprint: observationDigest({ config: config.config, requirements: observations.get("configRequirements/read"),
            profiles: observations.get("permissionProfile/list") }),
          // Legacy context field identifies this explicitly uncertified operator
          // policy. It must never be presented as a successful runtime canary.
          certificationId: `uncertified:${policyId}`, scopeDigest,
          validUntil: Math.min(Date.now() + 60_000, selected.expiresAt) },
          operations: ["create", "start", "observe", "read-result", "interrupt"],
          interaction: "preauthorized-unattended" };
      },
      authorize: async (wave, { context }) => executorDigest(wave) === scopeDigest && Date.now() < selected.expiresAt
        ? { decision: "allow", decisionId: policyId, scopeDigest,
          contextFingerprint: executorContextFingerprintV1(context), expiresAt: selected.expiresAt }
        : { decision: "deny" },
    });
    this.#units = new ExecutionStoreV1({ directory: join(directory, "units") });
    this.#journal = new ExecutorLaunchJournalV1({ directory: join(directory, "journal") });
    this.#decisions = new QueenAcceptanceStoreV1({ directory: join(directory, "acceptances") });
  }

  start() { return this.#starting ??= this.#start(); }
  async #start() {
    await ensureCanonicalDirectory(this.#directory, "executor job state");
    // An older service directory without a job binding is not an empty job.
    // Validate existing private evidence before installing a policy or opening
    // an upstream connection; never expose another job's cached result.
    const wave = this.#config.job.wave, member = wave.members[0];
    for (const id of await this.#journal.listWorkUnitIds()) {
      const record = await this.#journal.read(id);
      if (id !== member.workUnitId || !record || record.operations.some((operation) =>
        operation.scopeDigest !== executorDigest(wave) ||
        executorDigest(operation.member) !== executorDigest(member))) fail("service-job-journal-mismatch");
    }
    const unit = await this.#units.read(member.workUnitId);
    if (unit && observationDigest(workUnitDefinitionV1(unit)) !==
        observationDigest(this.#config.job.workUnits[0])) fail("service-job-unit-mismatch");
    const path = join(this.#directory, "job-binding.json");
    const binding = { schemaVersion: 1, policyDigest: executorDigest(this.#config) };
    try { await writeFile(path, JSON.stringify(binding), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const persisted = await readPrivateExecutorJsonV1(path);
    if (executorDigest(persisted) !== executorDigest(binding)) fail("service-job-policy-mismatch");
    return this.#runtime.start();
  }
  attach() { return this.#runtime.attach(); }
  detach(client) { this.#runtime.detach(client); }
  get stopped() { return this.#runtime.stopped; }
  drain() { return this.#runtime.drain(); }
  status() { return { ...this.#runtime.status(), workUnitId: this.#config.job.wave.members[0].workUnitId,
    queenThreadId: this.#config.job.workUnits[0].queenThreadId, runtimeCertified: false }; }

  async request(client, method, params) {
    if (method === "status") { executorExact(params, []); return this.status(); }
    if (method === "launch") {
      executorExact(params, []);
      if (!this.#launching) this.#launching = this.#launch(client).finally(() => { this.#launching = null; });
      return this.#launching;
    }
    if (method === "collect") {
      executorExact(params, []);
      return this.#runtime.collectResult(client, this.status().workUnitId);
    }
    if (method === "join") {
      executorExact(params, ["decision", "decisionSummary"]);
      if (!["accepted", "rejected"].includes(params.decision)) fail("invalid-parent-decision");
      executorText(params.decisionSummary, 1000);
      // Serialize decisions but do not coalesce different parent decisions.
      const next = (this.#joining ?? Promise.resolve()).catch(() => {}).then(() => this.#join(client, params));
      this.#joining = next;
      return next;
    }
    fail("unsupported-service-method");
  }

  async #launch(client) {
    const prior = (await this.#journal.read(this.status().workUnitId))?.operations.at(-1);
    if (prior) return { kind: "existing-operation", phase: prior.phase, threadId: prior.threadId, turnId: prior.turnId };
    const grant = await this.#runtime.requestGrant(client, { wave: this.#config.job.wave });
    if (grant.kind !== "execution-granted") return grant;
    return this.#runtime.launchWave(client, { ...this.#config.job, executionGrantId: grant.executionGrantId });
  }

  async #join(client, params) {
    const observed = await this.#runtime.collectResult(client, this.status().workUnitId);
    if (observed.phase !== "terminal" || !observed.result?.result) fail("validated-terminal-result-required");
    const unit = await this.#units.read(this.status().workUnitId);
    const source = { webId: unit.webId, queenThreadId: unit.queenThreadId, workUnitId: unit.workUnitId,
      specRevision: unit.specRevision, attempt: unit.attempt,
      memberThreadId: observed.threadId, sourceTurnId: observed.turnId };
    const decisionId = queenAcceptanceIdV1(source);
    const existing = await this.#decisions.read(decisionId);
    const decision = createQueenAcceptanceV1({ schemaVersion: 1, decisionId, ...source, ...params,
      result: observed.result.result, recordedAt: existing?.recordedAt ?? new Date().toISOString() });
    await this.#decisions.record(decision);
    return { decision, readiness: deriveWebReadinessV1({ workUnits: [unit], decisions: [decision] }) };
  }
}
