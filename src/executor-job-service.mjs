import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, writeFile } from "node:fs/promises";
import { join, isAbsolute, dirname } from "node:path";
import { ExecutorServiceRuntimeV1 } from "./executor-service-runtime.mjs";
import { ExecutorLaunchJournalV1 } from "./executor-launch-journal.mjs";
import { ExecutionStoreV1, createWorkUnitSpecV1, workUnitDefinitionV1 } from "./execution-store.mjs";
import { QueenAcceptanceStoreV1, createQueenAcceptanceV1, queenAcceptanceIdV1, deriveWebReadinessV1 } from "./queen-acceptance.mjs";
import { ExecutorContractError, executorExact, executorDigest, executorContextFingerprintV1,
  executorText, normalizeExecutorWaveV1 } from "./executor-contract.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { readPrivateExecutorJsonV1 } from "./executor-service-channel.mjs";
import { probeAppServerExecutionV1 } from "./app-server-execution-profile.mjs";
import { ExecutorCompletionOutboxV1 } from "./executor-completion-outbox.mjs";
import { WorktreeReceiptStoreV1, provisionWorktreeV1, inspectWorktreeReceiptV1 } from "./worktree-provisioning.mjs";
import { normalizeExecutorRequiredToolsV1, verifyExecutorRequiredToolsV1 } from "./executor-required-tools.mjs";

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
// prompt, target, authorizer, or permission policy. V1 is read-only; V3 owns a
// receipt-backed Git worktree. Runtime certification is recorded separately.
export function normalizeExecutorJobV1(value) {
  const isolated = value?.schemaVersion === 3;
  const hasRequiredTools = Object.hasOwn(value ?? {}, "requiredMcpTools");
  executorExact(value, ["schemaVersion", "command", "codexHome", "hostId", "expiresAt", "job", ...(isolated ? ["workspace"] : []), ...(hasRequiredTools ? ["requiredMcpTools"] : [])]);
  if (![1, 3].includes(value.schemaVersion) || !Number.isSafeInteger(value.expiresAt)) fail("invalid-job-policy");
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
  if (member.workspaceMode !== (isolated ? "isolated-write" : "shared-read-only") || member.permissionProfile !== (isolated ? ":workspace" : ":read-only") ||
      (!isolated && member.approvalPolicy !== "never") || member.target.hostId !== value.hostId ||
      member.target.codexHomeId !== executorDigest(value.codexHome) ||
      unit.workUnitId !== member.workUnitId || unit.specRevision !== member.specRevision ||
      unit.attempt !== member.attempt || unit.title !== member.title || unit.memberKind !== "spinoff" ||
      unit.dependencies.length || unit.binding.state !== "unbound" ||
      prompt.sliceId !== member.sliceId || typeof prompt.text !== "string" || !prompt.text.trim() ||
      Buffer.byteLength(prompt.text) > 32 * 1024 || executorDigest(prompt.text) !== member.promptDigest) fail("job-policy-scope-mismatch");
  if (isolated) {
    executorExact(value.workspace, ["sourcePath", "worktreePath", "branch", "baseCommit"]);
    for (const key of ["sourcePath", "worktreePath"]) { executorText(value.workspace[key], 4096); if (!isAbsolute(value.workspace[key])) fail("absolute-workspace-path-required"); }
    executorText(value.workspace.branch, 255);
    if (!/^[a-f0-9]{40,64}$/u.test(value.workspace.baseCommit) || value.workspace.worktreePath !== member.target.cwd ||
        value.workspace.sourcePath === value.workspace.worktreePath) fail("workspace-policy-mismatch");
  }
  return { ...value, ...(hasRequiredTools ? { requiredMcpTools: normalizeExecutorRequiredToolsV1(value.requiredMcpTools) } : {}), ...(isolated ? { workspace: structuredClone(value.workspace) } : {}), job: { wave, workUnits: [workUnitDefinitionV1(unit)], prompts: [structuredClone(prompt)] } };
}

export class ExecutorJobServiceV1 {
  #config; #runtime; #units; #journal; #decisions; #outbox; #workspaceReceipt = null; #launching = null; #joining = null; #directory; #starting = null;

  constructor({ config, directory, runtimeGeneration, sessionOptions = {} }) {
    this.#config = normalizeExecutorJobV1(config);
    this.#directory = directory;
    this.#outbox = new ExecutorCompletionOutboxV1({ config: this.#config, directory });
    const selected = this.#config;
    const scopeDigest = executorDigest(selected.job.wave);
    const policyId = `operator-${selected.workspace ? "isolated-write" : "read-only"}:${executorDigest(selected)}`;
    const validateTarget = async (member) => {
      if (member.target.repositoryId !== await executorRepositoryIdentityV1(member.target.cwd) ||
          await realpath(selected.codexHome) !== selected.codexHome) return false;
      if (!selected.workspace) return true;
      if (!this.#workspaceReceipt) return false;
      const inspected = await inspectWorktreeReceiptV1(this.#workspaceReceipt);
      return inspected.valid === true && inspected.baseAncestor === true;
    };
    this.#runtime = new ExecutorServiceRuntimeV1({ directory,
      onTerminal: async () => { await this.#outbox.project(); },
      scope: { hostId: selected.hostId, codexHomeId: executorDigest(selected.codexHome),
        authDomainId: executorDigest({ home: selected.codexHome, auth: "codex-managed" }) },
      runtimeGeneration,
      sessionOptions: { ...sessionOptions, command: selected.command,
        codexHome: selected.codexHome, cwd: selected.job.wave.members[0].target.cwd },
      validateTarget,
      validateThread: ({ threadId }, { request, signal }) => verifyExecutorRequiredToolsV1({ required: selected.requiredMcpTools ?? [], threadId, request, signal }),
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
        const config = await request("config/read", { cwd: member.target.cwd, includeLayers: false }, { signal });
        if (!config?.config || typeof config.config !== "object" || Array.isArray(config.config)) fail("job-config-unavailable");
        // Resolve the effective project layers for this exact target. The raw
        // projects table is global trust bookkeeping; Codex may add an entry
        // while creating a workspace task. Its effect on the resolved config,
        // permission profiles and managed requirements is checked separately.
        // Hashing that table itself also invalidates grants for unrelated repos.
        const { projects: _projects, ...effectiveConfig } = config.config;
        return { context: { serviceId: policyId, ownerEpoch: owner.ownerEpoch,
          runtimeGeneration: owner.runtimeGeneration, accountFingerprint: observationDigest(observations.get("account/read")),
          configFingerprint: observationDigest({ config: effectiveConfig, requirements: observations.get("configRequirements/read"),
            profiles: observations.get("permissionProfile/list") }),
          // Legacy context field identifies this explicitly uncertified operator
          // policy. It must never be presented as a successful runtime canary.
          certificationId: `uncertified:${policyId}`, scopeDigest,
          validUntil: Math.min(Date.now() + 60_000, selected.expiresAt) },
          operations: ["create", "start", "observe", "read-result", "interrupt"],
          interaction: member.approvalPolicy === "never" ? "preauthorized-unattended" : "interactive" };
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
    if (this.#config.workspace) {
      const workspace = this.#config.workspace;
      if (await executorRepositoryIdentityV1(workspace.sourcePath) !== member.target.repositoryId) fail("workspace-repository-mismatch");
      const receiptStore = new WorktreeReceiptStoreV1({ directory: join(this.#directory, "worktrees") });
      const actionId = `owned-worktree:${binding.policyDigest}`;
      const existingReceipt = await receiptStore.read(actionId);
      if (!existingReceipt && ((await this.#journal.read(member.workUnitId)) || Date.now() >= this.#config.expiresAt)) fail("workspace-provisioning-not-authorized");
      await ensureCanonicalDirectory(dirname(workspace.worktreePath), "owned worktree parent", { mode: 0o700 });
      const { receipt } = await provisionWorktreeV1({ actionId, workUnitId: member.workUnitId,
        ownerTaskId: this.#config.job.workUnits[0].queenThreadId, sourcePath: workspace.sourcePath,
        worktreePath: workspace.worktreePath, branch: workspace.branch, baseRevision: workspace.baseCommit, operation: "create" }, { receiptStore });
      this.#workspaceReceipt = receipt;
    }
    return this.#runtime.start();
  }
  attachApprovalChannel(channel) { return this.#runtime.attachApprovalChannel(channel); }
  async prepareLaunch(client) {
    this.#runtime.assertClient(client);
    return this.#runtime.requestGrant(client, { wave: this.#config.job.wave });
  }
  async snapshot() {
    const unit = await this.#units.read(this.status().workUnitId) ?? createWorkUnitSpecV1(this.#config.job.workUnits[0]);
    const decisions = await this.#decisions.list({ webId: unit.webId, queenThreadId: unit.queenThreadId });
    const operation = (await this.#journal.read(unit.workUnitId))?.operations.at(-1) ?? null;
    return { unit, decisions, operation };
  }
  attach() { return this.#runtime.attach(); }
  detach(client) { this.#runtime.detach(client); }
  get stopped() { return this.#runtime.stopped; }
  drain() { return this.#runtime.drain(); }
  status() { return { ...this.#runtime.status(), workUnitId: this.#config.job.wave.members[0].workUnitId,
    queenThreadId: this.#config.job.workUnits[0].queenThreadId, attempt: this.#config.job.workUnits[0].attempt,
    retryConfigured: false, runtimeCertified: false,
    completionDelivery: { mode: "durable-inbox", detachedWakeAvailable: false } }; }

  async request(client, method, params) {
    if (["collect", "join", "acknowledge"].includes(method) && Object.hasOwn(params ?? {}, "workUnitId")) {
      if (params.workUnitId !== this.status().workUnitId) fail("executor-plan-member-unavailable");
      const { workUnitId, ...rest } = params; params = rest;
    }
    if (["notifications", "acknowledge"].includes(method)) {
      this.#runtime.assertClient(client);
      if (method === "acknowledge") return this.#outbox.acknowledge(params);
      executorExact(params, []); return { notifications: await this.#outbox.list(), detachedWakeAvailable: false };
    }
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
    if (method === "retry") { executorExact(params, ["expectedAttempt"]); fail("retry-not-configured"); }
    if (method === "join") {
      executorExact(params, ["decision", "decisionSummary", ...(Object.hasOwn(params ?? {}, "expectedAttempt") ? ["expectedAttempt"] : [])]);
      if (Object.hasOwn(params, "expectedAttempt") && params.expectedAttempt !== this.status().attempt) fail("stale-attempt-decision");
      if (!["accepted", "rejected"].includes(params.decision)) fail("invalid-parent-decision");
      executorText(params.decisionSummary, 1000);
      // Serialize decisions but do not coalesce different parent decisions.
      const next = (this.#joining ?? Promise.resolve()).catch(() => {}).then(() => this.#join(client, { decision: params.decision, decisionSummary: params.decisionSummary }));
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
