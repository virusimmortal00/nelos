import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installExecutorPlanV1, readExecutorClaimV1 } from "../src/executor-plan-install.mjs";
import { PlanRunStoreV1 } from "../src/plan-run-store.mjs";
import { ExecutionStoreV1, createWorkUnitSpecV1 } from "../src/execution-store.mjs";
import { derivePlanWaveActionV1 } from "../src/next-action.mjs";
import { McpOrchestrationAdapterV1 } from "../src/mcp-orchestration.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ni-"))), sourcePath = join(root, "source"), codexHome = join(root, "home");
  await mkdir(sourcePath); await mkdir(codexHome);
  const git = async (...args) => promisify(execFile)("git", ["-C", sourcePath, ...args]);
  await git("init", "--quiet"); await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  const stores = { planRunStore: new PlanRunStoreV1({ directory: join(root, "plans") }), executionStore: new ExecutionStoreV1({ directory: join(root, "units") }) };
  const input = { plan: { schemaVersion: 1, objective: "Implement a plan", maxParallel: 1, slices: ["one", "two"].map((id) => ({ id, title: `Implement ${id}`, objective: `Complete ${id}`, deliverable: "Artifact", acceptanceCriteria: ["Artifact verified"], dependsOn: id === "two" ? ["one"] : [], lifecycle: "spinoff", workspaceMode: "isolated-write", taskShape: "everyday" })) },
    queenThreadId: "parent", webId: "A1", queenTitle: "👑 A1 · Implementation", command: "/test/codex", codexHome, hostId: "host", sourcePath, worktreeRoot: join(root, "worktrees"), expiresAt: Date.now() + 600_000, approvalPolicy: "never", directory: join(root, "installed") };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, input, stores, git };
}
test("planner preparation pins routes, worktrees and dependencies, persists claims, and replays after source HEAD changes", async (t) => {
  const f = await fixture(t), result = await installExecutorPlanV1(f.input, f.stores);
  const config = JSON.parse(await readFile(result.policyPath));
  const record = await f.stores.planRunStore.read(result.planRunId);
  assert.equal(config.jobs[0].config.job.wave.members[0].model, record.waves[0].members[0].model);
  assert.equal(derivePlanWaveActionV1(record.plan, record).kind, "owned-executor");
  assert.deepEqual(config.jobs[1].dependsOn, ["one"]);
  assert.match(config.jobs[1].config.job.prompts[0].text, /Changes are not automatically merged/);
  assert.doesNotMatch(config.jobs[0].config.job.prompts[0].text, /nelos_spinoff_complete/);
  assert.ok(await readExecutorClaimV1(f.stores.executionStore, "one"));
  await f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "advance");
  assert.deepEqual(await installExecutorPlanV1(f.input, f.stores), result);
  assert.deepEqual(JSON.parse(await readFile(result.policyPath)), config);
  const adapter = new McpOrchestrationAdapterV1({ store: f.stores.executionStore });
  await assert.rejects(adapter.orchestrate({ workUnit: config.jobs[0].config.job.workUnits[0] }), /owned executor/);
  await assert.rejects(installExecutorPlanV1({ ...f.input, directory: join(f.root, "other") }, f.stores), /work-unit-already-owned/);
});

test("legacy records, including pending unknown launches, are never adopted or cleared", async (t) => {
  const f = await fixture(t);
  // Obtain a valid definition in a separate store, then retain its pending
  // native operation in the store selected for installation.
  const alternate = { ...f.stores, executionStore: new ExecutionStoreV1({ directory: join(f.root, "alternate") }) };
  const result = await installExecutorPlanV1(f.input, alternate);
  const config = JSON.parse(await readFile(result.policyPath));
  await f.stores.executionStore.create(createWorkUnitSpecV1(config.jobs[0].config.job.workUnits[0]));
  await f.stores.executionStore.markLaunchPending({ workUnitId: "one", specRevision: 1, launchActionId: "legacy-unknown" });
  await assert.rejects(installExecutorPlanV1(f.input, f.stores), /legacy-work-unit-requires-reconciliation/);
  assert.equal((await f.stores.executionStore.read("one")).binding.launchActionId, "legacy-unknown");
  assert.equal(await readExecutorClaimV1(f.stores.executionStore, "one"), null);
});
test("joined native subagents cannot silently become durable owned workers", async (t) => {
  const f = await fixture(t); f.input.plan.slices[0].lifecycle = "subagent"; f.input.plan.slices[0].workspaceMode = "shared-read-only";
  await assert.rejects(installExecutorPlanV1(f.input, f.stores), /owned-plan-requires-durable-members/);
  assert.equal(await readExecutorClaimV1(f.stores.executionStore, "one"), null);
});
