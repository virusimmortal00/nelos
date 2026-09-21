import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeDistribution, retainedWorker } from "./support/runtime-distribution.mjs";
import { runPlanningLifecycleScenario } from "../scripts/verify-planning-lifecycle.mjs";
import { canInstallRuntimeV1, isRuntimeStateEmptyV1, runtimeContractsCompatibleV1, validateRuntimeCompatibilityV1 } from "../src/runtime-compatibility.mjs";
import { RuntimeWorkerRegistryV1 } from "../src/runtime-worker-registry.mjs";
import { deriveRuntimeIdentityV1 } from "../src/runtime-identity.mjs";
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

test("a published runtime remains usable if the cache vanishes before bootstrap returns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-retention-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = await runtimeDistribution(join(root, "cache"), A);
  const retained = await retainRuntimeV1({
    moduleRoot, declaredVersion: A, directory: join(root, "images"),
    publish: async (temporary, target) => {
      await rename(temporary, target);
      await rm(moduleRoot, { recursive: true });
    },
  });
  assert.ok(await readFile(join(retained, "src/mcp-server.mjs"), "utf8"));
  assert.ok(await readFile(join(retained, "skills/manage-nelos-tasks/SKILL.md"), "utf8"));
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


test("repeat retention verifies and reuses the existing image without publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-retention-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = await runtimeDistribution(join(root, "cache"), A);
  const args = { moduleRoot, declaredVersion: A, directory: join(root, "images") };
  const target = await retainRuntimeV1(args);
  const noPublish = async () => { assert.fail("existing images must not be copied/published again"); };
  assert.equal(await retainRuntimeV1({ ...args, publish: noPublish }), target);
  const provenancePath = join(target, "distribution-provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  await writeFile(provenancePath, JSON.stringify({ ...provenance, sourceRevision: "a".repeat(40) }));
  await assert.rejects(retainRuntimeV1({ ...args, publish: noPublish }), /digest|provenance/);
  await writeFile(provenancePath, JSON.stringify(provenance));
  await writeFile(join(target, "src/runtime-compatibility.json"), "{}\n");
  await assert.rejects(retainRuntimeV1({ ...args, publish: noPublish }), /digest|contract/);
});


test("unknown persisted state requires explicit drained adoption and cannot reset a pin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-legacy-adoption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = await runtimeDistribution(join(root, "candidate"), A);
  const stateDirectory = join(root, "state", "nelos");
  const directory = join(stateDirectory, "runtime-workers");
  const registry = new RuntimeWorkerRegistryV1({ directory, stateDirectory,
    withLock: async (callback) => callback(), verifyContract: async () => CONTRACT });
  assert.equal(await canInstallRuntimeV1(moduleRoot, await registry.inspect()), true);
  assert.equal(await canInstallRuntimeV1(moduleRoot, { liveWorkerCount: 0 }), false);
  await mkdir(stateDirectory, { recursive: true });
  const record = join(stateDirectory, "legacy-record.json");
  await writeFile(record, "{\"unchanged\":true}\n");
  assert.equal(await isRuntimeStateEmptyV1(stateDirectory), false);
  assert.equal(await canInstallRuntimeV1(moduleRoot, await registry.inspect()), false);
  await assert.rejects(registry.adoptLegacyState({ moduleRoot, expectedContract: { ...CONTRACT, state: "other" } }), /does not match/);
  await assert.rejects(readFile(join(directory, "compatibility.json")), { code: "ENOENT" });
  const command = join(moduleRoot, "bin/nelos-adopt-legacy-runtime");
  const env = { ...process.env, XDG_STATE_HOME: join(root, "state") };
  const unconfirmed = spawnSync(process.execPath, [command], { env, encoding: "utf8" });
  assert.equal(unconfirmed.status, 1);
  await assert.rejects(readFile(join(directory, "compatibility.json")), { code: "ENOENT" });
  const adopted = spawnSync(process.execPath, [command, "--package-root", moduleRoot,
    "--verified-contract", join(moduleRoot, "src/runtime-compatibility.json"),
    "--confirm-verified-legacy-state"], { env, encoding: "utf8" });
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(JSON.parse(adopted.stdout).adopted, true);
  assert.equal((await registry.adoptLegacyState({ moduleRoot, expectedContract: CONTRACT })).adopted, false);
  assert.equal(await canInstallRuntimeV1(moduleRoot, await registry.inspect()), true);
  assert.equal(await readFile(record, "utf8"), "{\"unchanged\":true}\n");
  const handle = await registry.register(await deriveRuntimeIdentityV1({ moduleRoot }));
  t.after(() => handle.remove());
  await assert.rejects(registry.adoptLegacyState({ moduleRoot, expectedContract: CONTRACT }), /every Nelos worker to be drained/);
  await handle.remove();
  const incompatible = { ...CONTRACT, state: "other" };
  const otherRoot = await runtimeDistribution(join(root, "other"), B, incompatible);
  await assert.rejects(registry.adoptLegacyState({ moduleRoot: otherRoot, expectedContract: incompatible }), /cannot replace/);
  await writeFile(join(moduleRoot, "src/runtime-compatibility.json"), JSON.stringify(incompatible));
  await assert.rejects(registry.adoptLegacyState({ moduleRoot, expectedContract: incompatible }), /integrity is invalid/);
  assert.deepEqual((await registry.inspect()).compatibilityContract, CONTRACT);
});
