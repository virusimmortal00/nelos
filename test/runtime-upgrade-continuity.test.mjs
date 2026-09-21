import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeDistribution, retainedWorker } from "./support/runtime-distribution.mjs";
import { runPlanningLifecycleScenario } from "../scripts/verify-planning-lifecycle.mjs";
import { runtimeContractsCompatibleV1, validateRuntimeCompatibilityV1 } from "../src/runtime-compatibility.mjs";
import { retainRuntimeV1 } from "../src/runtime-retention.mjs";

const CONTRACT = JSON.parse(await readFile(new URL("../src/runtime-compatibility.json", import.meta.url), "utf8"));
const A = "9.1.0", B = "9.2.0", C = "9.3.0"; // Synthetic releases, never published.
const cache = (home, version) => join(home, "plugins/cache/fixture/nelos", version);
const health = async (worker) => (await worker.tool("nelos_runtime_health", { verifyIntegrity: true })).health;
const mutation = (worker, value = "ask") => worker.tool("nelos_config_set", {
  key: "spinoffs.cleanup_policy", value, userIntentConfirmed: true,
});

test("coexistence requires every behavioral contract, not semver or a schema number", () => {
  assert.equal(runtimeContractsCompatibleV1(CONTRACT, structuredClone(CONTRACT)), true);
  for (const field of ["state", "tools", "receipts", "locking", "instructions"]) {
    assert.equal(runtimeContractsCompatibleV1(CONTRACT, { ...CONTRACT, [field]: "incompatible" }), false);
  }
  assert.equal(runtimeContractsCompatibleV1(CONTRACT, null), false);
  assert.throws(() => validateRuntimeCompatibilityV1({ ...CONTRACT, schemaVersion: 2 }));
  assert.throws(() => validateRuntimeCompatibilityV1({ ...CONTRACT, extra: true }));
});

test("real MCP workers survive cache deletion, compatible upgrade, rollback, and incompatible arrivals", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-upgrade-"));
  const environment = { ...process.env, HOME: root, CODEX_HOME: join(root, "codex"), XDG_STATE_HOME: join(root, "state") };
  const workers = [];
  t.after(async () => { await Promise.all(workers.map((worker) => worker.stop())); await rm(root, { recursive: true, force: true }); });
  const start = async (version, threadId) => {
    const worker = retainedWorker({ ...environment, CODEX_THREAD_ID: threadId }, version);
    workers.push(worker);
    await worker.initialize();
    return worker;
  };
  await runtimeDistribution(cache(environment.CODEX_HOME, A), A);
  const queen = await start(A, "same-queen");
  const spinoff = await start(A, "same-spinoff");
  await mutation(queen);
  const before = await health(queen);
  assert.equal(before.mutationAllowed, true);
  assert.match(before.skillPath, /runtime-images/);
  await runtimeDistribution(cache(environment.CODEX_HOME, B), B);
  await rm(cache(environment.CODEX_HOME, A), { recursive: true });
  const newer = await start(B, "unrelated-queen");
  for (const worker of [queen, spinoff, newer]) {
    const report = await health(worker);
    assert.equal(report.mutationAllowed, true);
    assert.equal(report.registry.state, "compatible-generations");
    await mutation(worker);
  }
  assert.equal((await health(queen)).loaded.modulePath, before.loaded.modulePath);
  assert.ok((await readFile(before.skillPath, "utf8")).includes("mutationAllowed"));
  // Reopen the same task with its old launch env after the cache was pruned.
  const reopened = await start(A, "same-queen");
  assert.equal((await health(reopened)).loaded.modulePath, before.loaded.modulePath);
  await mutation(reopened);
  await runtimeDistribution(cache(environment.CODEX_HOME, C), C, { ...CONTRACT, state: "incompatible-state" });
  const incompatible = await start(C, "new-incompatible");
  assert.equal((await health(incompatible)).state, "upgrade-deferred");
  await assert.rejects(mutation(incompatible), /RUNTIME_UPGRADE_DEFERRED/);
  assert.equal((await health(queen)).mutationAllowed, true);
  await mutation(queen);
  // Integrity failures still fence mutations, even for the incumbent generation.
  await writeFile(join(before.loaded.modulePath, "src/runtime-compatibility.json"), "{}\n");
  assert.equal((await health(queen)).mutationAllowed, false);
  await assert.rejects(mutation(queen), /RUNTIME_INTEGRITY_FAILURE/);
});

test("retention is atomic under concurrent launches and rejects changed bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = await runtimeDistribution(join(root, "cache"), A);
  const args = { moduleRoot, declaredVersion: A, directory: join(root, "images") };
  const paths = await Promise.all([retainRuntimeV1(args), retainRuntimeV1(args), retainRuntimeV1(args)]);
  assert.equal(new Set(paths).size, 1);
  await rm(moduleRoot, { recursive: true });
  assert.ok(await readFile(join(paths[0], "skills/manage-nelos-tasks/SKILL.md"), "utf8"));
  await writeFile(join(paths[0], "src/runtime-compatibility.json"), "{}\n");
  await assert.rejects(retainRuntimeV1({ ...args, moduleRoot: paths[0] }), /digest|contract/);
});

test("a pending planner receipt survives upgrade and same-task reconnect with real stores and a fake host", { timeout: 60000 }, async (t) => {
  let version = A;
  let initialized = false;
  let otherWorker;
  t.after(async () => { if (otherWorker) await otherWorker.stop(); });
  const report = await runPlanningLifecycleScenario({
    startWorker: async (environment) => {
      if (!initialized) {
        await runtimeDistribution(cache(environment.CODEX_HOME, A), A);
        initialized = true;
      }
      return retainedWorker(environment, version);
    },
    onPendingReceipt: async ({ mcp, environment, launchReceipt }) => {
      const recordedReceipt = structuredClone(launchReceipt);
      await runtimeDistribution(cache(environment.CODEX_HOME, B), B);
      await rm(cache(environment.CODEX_HOME, A), { recursive: true });
      otherWorker = retainedWorker({ ...environment, CODEX_THREAD_ID: "unrelated-web" }, B);
      await otherWorker.initialize();
      assert.equal((await health(mcp)).mutationAllowed, true);
      assert.equal((await health(otherWorker)).registry.state, "compatible-generations");
      assert.deepEqual(launchReceipt, recordedReceipt);
      version = B;
    },
  });
  assert.equal(report.receiptResume, true);
  assert.equal(report.batchAtomic, true);
  assert.equal(report.completedSlicesPreserved, true);
  assert.equal(report.modelTurns, 0);
});
