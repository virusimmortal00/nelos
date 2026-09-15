import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, rename, unlink, realpath } from "node:fs/promises";
import { join, isAbsolute, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { executorDigest, executorExact, ExecutorContractError } from "./executor-contract.mjs";
import { normalizeExecutorRequiredToolsV1 } from "./executor-required-tools.mjs";
import { normalizeExecutorPlanPolicyV1 } from "./executor-plan-service.mjs";
import { executorRepositoryIdentityV1 } from "./executor-job-service.mjs";
import { PlanRunStoreV1, createPlanRunV1 } from "./plan-run-store.mjs";
import { ExecutionStoreV1 } from "./execution-store.mjs";
import { planWorkSlices } from "./slice-planner.mjs";
import { buildTaskLaunchPromptV1, createTaskResultTemplateV1 } from "./task-launch-prompt.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { readPrivateExecutorJsonV1 } from "./executor-service-channel.mjs";
import { withExecutionOrchestrationLock, withPlanRunLock } from "./task-state.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };
const read = (path) => readPrivateExecutorJsonV1(path).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
export { readExecutorClaimV1 } from "./executor-backend-claim.mjs";
import { readExecutorClaimV1, claimPath } from "./executor-backend-claim.mjs";
async function persist(path, value) {
  await ensureCanonicalDirectory(dirname(path), "executor plan installation", { mode: 0o700 });
  const prior = await read(path);
  if (prior && executorDigest(prior) !== executorDigest(value)) fail("executor-installation-conflict");
  // Republish even a replay to repair a failed directory sync. Callers hold the
  // plan and all work-unit orchestration locks through this transaction.
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600); await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close(); file = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await file?.close(); await unlink(temporary).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
}

export async function compileExecutorPlanV1({ record, command, codexHome, hostId, sourcePath, worktreeRoot, expiresAt, approvalPolicy = "never", baseCommit = null, requiredMcpTools = [] }) {
  requiredMcpTools = normalizeExecutorRequiredToolsV1(requiredMcpTools);
  if (!record?.plan || !record.webIdentity || record.verifiedWaveIndexes.length || record.cleanedWaveIndexes.length) fail("fresh-owned-plan-required");
  for (const path of [sourcePath, worktreeRoot, codexHome, command]) if (!isAbsolute(path ?? "")) fail("absolute-executor-path-required");
  if (await realpath(sourcePath) !== sourcePath || await realpath(codexHome) !== codexHome) fail("noncanonical-job-target");
  const repositoryId = await executorRepositoryIdentityV1(sourcePath);
  baseCommit ??= (await promisify(execFile)("git", ["-C", sourcePath, "rev-parse", "HEAD"], { timeout: 5000 })).stdout.trim();
  const paths = new Map(record.plan.waves.flatMap(({ slices }) => slices.map(({ id, workspaceMode }) => [id, workspaceMode === "isolated-write" ? join(worktreeRoot, executorDigest([record.planRunId, id]).slice(0, 20)) : sourcePath])));
  const jobs = record.plan.waves.flatMap((wave) => wave.slices.map((slice) => {
    const contract = record.waves.find(({ waveIndex }) => waveIndex === wave.index);
    const member = contract.members.find(({ sliceId }) => sliceId === slice.id);
    if (slice.lifecycle !== "spinoff" || !["isolated-write", "shared-read-only"].includes(slice.workspaceMode)) fail("owned-plan-requires-durable-members");
    if (member.model !== slice.route.launch.nativeTask.model || member.effort !== slice.route.launch.nativeTask.thinking) fail("persisted-plan-route-mismatch");
    const isolated = slice.workspaceMode === "isolated-write", cwd = paths.get(slice.id);
    const dependencies = slice.dependsOn ?? [];
    const context = dependencies.length ? `\nPrerequisite results require parent acceptance before this work starts. Their workspaces are available for inspection: ${JSON.stringify(dependencies.map((id) => ({ workUnitId: id, cwd: paths.get(id) })))}. Changes are not automatically merged. Inspect the accepted artifacts and implement your deliverable in your own workspace.` : "";
    const prompt = buildTaskLaunchPromptV1({ title: member.title, objective: slice.objective + context, deliverable: slice.deliverable,
      acceptanceCriteria: slice.acceptanceCriteria, resultTemplate: createTaskResultTemplateV1({ workUnitId: slice.id, specRevision: 1, attempt: 1 }) });
    return { dependsOn: dependencies, config: { schemaVersion: isolated ? 3 : 1, command, codexHome, hostId, expiresAt,
      ...(requiredMcpTools.length ? { requiredMcpTools } : {}),
      ...(isolated ? { workspace: { sourcePath, worktreePath: cwd, branch: `codex/owned-${record.planRunId.slice(4, 16)}-${executorDigest(slice.id).slice(0, 12)}`, baseCommit } } : {}),
      job: { wave: { schemaVersion: 1, backend: "nelos-app-server", planRunId: record.planRunId, waveIndex: wave.index, waveDigest: contract.waveDigest,
        members: [{ sliceId: slice.id, workUnitId: slice.id, specRevision: 1, attempt: 1, launchSequence: 1,
          target: { hostId, codexHomeId: executorDigest(codexHome), repositoryId, cwd }, workspaceMode: slice.workspaceMode,
          model: member.model, reasoningEffort: member.effort, permissionProfile: isolated ? ":workspace" : ":read-only",
          approvalPolicy: isolated ? approvalPolicy : "never", title: member.title, promptDigest: executorDigest(prompt) }] },
        workUnits: [{ webId: record.webIdentity.webId, queenThreadId: record.queenThreadId, workUnitId: slice.id, specRevision: 1, attempt: 1,
          memberKind: "spinoff", capabilities: ["observe", "read-result"], title: member.title, objectiveSummary: slice.objective,
          deliverable: slice.deliverable, acceptanceCriteria: slice.acceptanceCriteria, dependencies: [], required: true,
          policy: { maxAttempts: 1, onBlocked: "queen-review", onFailure: "queen-review" } }], prompts: [{ sliceId: slice.id, text: prompt }] } } };
  }));
  const config = normalizeExecutorPlanPolicyV1({ schemaVersion: 4, jobs });
  if (Buffer.byteLength(JSON.stringify(config)) > 128 * 1024) fail("executor-plan-policy-too-large");
  return config;
}

// Explicit operator preparation from structured planner output. Creates a new
// owned run; never adopts old receipts, pending launches, or existing workers.
export async function installExecutorPlanV1(input, { planRunStore = new PlanRunStoreV1(), executionStore = new ExecutionStoreV1() } = {}) {
  executorExact(input, ["plan", "queenThreadId", "webId", "queenTitle", "command", "codexHome", "hostId", "sourcePath", "worktreeRoot", "expiresAt", "approvalPolicy", "directory", ...(Object.hasOwn(input ?? {}, "requiredMcpTools") ? ["requiredMcpTools"] : [])]);
  const { directory, plan: definition, queenThreadId, webId, queenTitle, ...options } = input;
  if (!isAbsolute(directory ?? "") || typeof executionStore.directory !== "string") fail("durable-executor-installation-required");
  const plan = planWorkSlices(definition);
  const record = createPlanRunV1(plan, { queenThreadId, sourceId: `owned:${executorDigest(input)}`,
    webIdentity: { schemaVersion: 1, queenThreadId, webId, queenTitle }, cleanupIntended: false });
  return withPlanRunLock(record.planRunId, async () => {
    const ids = plan.waves.flatMap(({ slices }) => slices.map(({ id }) => id)).sort();
    const locked = (i, callback) => i === ids.length ? callback() : withExecutionOrchestrationLock(ids[i], () => locked(i + 1, callback));
    return locked(0, async () => {
      await ensureCanonicalDirectory(directory, "executor installation", { mode: 0o700 });
      const intentPath = join(directory, "installation.json");
      const existing = await read(intentPath);
      if (existing && existing.inputDigest !== executorDigest(input)) fail("executor-installation-conflict");
      const config = await compileExecutorPlanV1({ record, ...options,
        baseCommit: existing?.config?.jobs?.find(({ config }) => config.workspace)?.config.workspace.baseCommit ?? null });
      if (existing && executorDigest(existing.config) !== executorDigest(config)) fail("executor-installation-conflict");
      const policyDigest = executorDigest(config);
      for (const id of ids) {
        if (await executionStore.read(id)) fail("legacy-work-unit-requires-reconciliation");
        const claim = await readExecutorClaimV1(executionStore, id);
        if (claim && (claim.policyDigest !== policyDigest || claim.directory !== directory)) fail("work-unit-already-owned");
      }
      // Durable intent precedes claims; interruption can replay only this exact
      // installation. The runnable policy appears after all claims are synced.
      await persist(intentPath, { schemaVersion: 1, inputDigest: executorDigest(input), config });
      for (const id of ids) await persist(claimPath(executionStore, id), { backend: "nelos-app-server", workUnitId: id, policyDigest, directory, planRunId: record.planRunId });
      await planRunStore.create(record);
      const policyPath = join(directory, "policy.json"); await persist(policyPath, config);
      return { planRunId: record.planRunId, policyPath, stateDirectory: join(directory, "service"), workUnitIds: ids };
    });
  });
}
