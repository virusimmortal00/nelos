import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyPluginMarketplaceUpgrade } from "../scripts/verify-plugin-marketplace-upgrade.mjs";
import { RUNTIME_UPGRADE_MATRIX_V1 } from "../src/runtime-lifecycle.mjs";
import { resolveRuntimeHealthV1 } from "../src/runtime-identity.mjs";

const codexAvailable = spawnSync("codex", ["--version"], {
  stdio: "ignore",
}).status === 0;

test("real Codex marketplace refresh loads 0.12.8 skills and MCP in a fresh process", {
  skip: codexAvailable ? false : "requires the Codex CLI",
  timeout: 600_000,
}, async () => {
  const result = await verifyPluginMarketplaceUpgrade();
  assert.equal(result.verified, true);
  assert.equal(result.legacyVersion, "0.4.0");
  assert.equal(result.candidateVersion, "0.12.8");
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
