import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  verifyFreshCodexTask,
  verifyPluginMarketplaceUpgrade,
} from "../scripts/verify-plugin-marketplace-upgrade.mjs";
import { RUNTIME_UPGRADE_MATRIX_V1 } from "../src/runtime-lifecycle.mjs";
import { resolveRuntimeHealthV1 } from "../src/runtime-identity.mjs";

const codexAvailable = spawnSync("codex", ["--version"], {
  stdio: "ignore",
}).status === 0;

for (const scenario of ["success", "invalid-plugin", "launcher-exit"]) {
  test(`fresh upgrade probe reaps the npm-style native child after ${scenario}`, {
    skip: process.platform === "win32",
    timeout: 20_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "nelos-upgrade-process-"));
    const launcher = join(root, "codex");
    const native = join(root, "native.mjs");
    const pidsFile = join(root, "pids.json");
    const mockModule = new URL("./support/mock-app-server.mjs", import.meta.url).href;
    let pids;
    try {
      await writeFile(native, `
        import { writeFileSync } from "node:fs";
        import { startMockAppServer } from ${JSON.stringify(mockModule)};
        process.on("SIGTERM", () => {});
        writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({
          launcher: process.ppid, native: process.pid,
        }));
        setInterval(() => writeFileSync(${JSON.stringify(join(root, "cache-write"))}, String(Date.now())), 10);
        if (process.env.PROBE_SCENARIO !== "launcher-exit") {
          await startMockAppServer(process.argv.at(-1).slice("unix://".length), async ({ method }) => {
            if (method === "initialize") return {};
            if (method === "plugin/read") return { plugin: { summary: {
              id: "nelos@upgrade-fixture", localVersion: "fixture", installed: true,
              enabled: process.env.PROBE_SCENARIO !== "invalid-plugin",
            } } };
            if (method === "thread/start") return { thread: { id: "fixture-task" } };
            throw new Error("unexpected method: " + method);
          });
        }
        process.stdout.write("ready");
      `);
      await writeFile(launcher, `#!/usr/bin/env node
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, [${JSON.stringify(native)}, ...process.argv.slice(2)], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        child.stdout.once("data", () => {
          if (process.env.PROBE_SCENARIO === "launcher-exit") process.exit(1);
        });
      `);
      await chmod(launcher, 0o700);
      const probe = verifyFreshCodexTask({
        codexCommand: launcher,
        env: { ...process.env, PROBE_SCENARIO: scenario },
        expectedVersion: "fixture",
        marketplacePath: root,
      });
      if (scenario === "success") assert.equal((await probe).taskId, "fixture-task");
      else await assert.rejects(probe, scenario === "launcher-exit"
        ? /exited before startup/u : /did not activate/u);
      pids = JSON.parse(await readFile(pidsFile, "utf8"));
      for (const pid of Object.values(pids)) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      // File removal must happen after the writer is gone, including on failure.
      await rm(root, { recursive: true, force: true });
    } finally {
      pids ??= await readFile(pidsFile, "utf8").then(JSON.parse).catch(() => null);
      if (pids) {
        try { process.kill(-pids.launcher, "SIGKILL"); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("fresh upgrade probe reports a missing Codex executable without an unhandled error", async () => {
  await assert.rejects(verifyFreshCodexTask({
    codexCommand: "/nelos-upgrade-missing-command/codex",
    env: process.env,
  }), { code: "ENOENT" });
});

test("real Codex marketplace refresh loads candidate skills and MCP in a fresh process", {
  skip: codexAvailable ? false : "requires the Codex CLI",
  timeout: 600_000,
}, async () => {
  const result = await verifyPluginMarketplaceUpgrade();
  assert.equal(result.verified, true);
  assert.equal(result.legacyVersion, "0.4.0");
  const candidate = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(result.candidateVersion, candidate.version);
  assert.equal(result.processRestarted, true);
  assert.equal(result.freshTaskVerified, true);
  assert.match(result.freshTaskId, /^[0-9a-f-]+$/u);
  assert.ok(Number.isInteger(result.freshCodexPid));
  assert.equal(result.legacyCacheRemoved, true);
  assert.equal(result.unrelatedDataPreserved, true);
  assert.match(result.legacyRevision, /^[a-f0-9]{40}$/u);
  assert.match(result.candidateRevision, /^[a-f0-9]{40}$/u);
  assert.match(result.marketplaceRevision, /^[a-f0-9]{40}$/u);
  assert.notEqual(result.legacyRevision, result.candidateRevision);
  assert.notEqual(result.candidateRevision, result.marketplaceRevision);
  assert.match(result.candidateIntegrity, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(result.upgradeLifecycleMatrix, RUNTIME_UPGRADE_MATRIX_V1);
  assert.deepEqual(result.hostReload, {
    attempted: false,
    reason: "no owned live MCP child across replacement",
  });
  assert.equal(
    result.hostOwnedSiblingFallback,
    "Quit and relaunch Codex, then open a fresh task.",
  );
});

test("upgrade lifecycle matrix names every deterministic compatibility scenario", () => {
  assert.deepEqual(RUNTIME_UPGRADE_MATRIX_V1, [
    "old-worker-replacement",
    "same-version-concurrency",
    "mixed-generations",
    "missing-backing-files",
    "ambiguous-install",
    "pid-reuse",
    "crash-recovery",
    "compatible-rollback",
    "owner-client-reload",
    "full-restart",
  ]);
});

test("an old loaded worker survives cache replacement only for diagnostics and draining", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-old-worker-"));
  const loadedRoot = join(root, "cache", "0.12.5");
  await mkdir(loadedRoot, { recursive: true });
  const loaded = {
    version: "0.12.5",
    sourceRevision: "a".repeat(40),
    integrity: `sha256:${"1".repeat(64)}`,
    buildIdentity: `nelos-build:${"a".repeat(32)}`,
    modulePath: loadedRoot,
  };
  await rm(loadedRoot, { recursive: true, force: true });
  try {
    const health = await resolveRuntimeHealthV1({
      loaded,
      findProvenance: async () => [{
        path: join(root, "cache", "0.12.7", "distribution-provenance.json"),
        provenance: {
          schemaVersion: 1,
          distribution: "nelos",
          revision: "0.12.7",
          sourceRepository: "https://github.com/virusimmortal00/nelos.git",
          sourceRevision: "b".repeat(40),
          integrity: `sha256:${"2".repeat(64)}`,
        },
      }],
    });
    assert.equal(health.backingPathPresent, false);
    assert.equal(health.state, "restart-required");
    assert.equal(health.mutationAllowed, false);
    assert.equal(health.loaded.version, "0.12.5");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
