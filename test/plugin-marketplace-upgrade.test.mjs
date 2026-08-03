import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { verifyPluginMarketplaceUpgrade } from "../scripts/verify-plugin-marketplace-upgrade.mjs";

const codexAvailable = spawnSync("codex", ["--version"], {
  stdio: "ignore",
}).status === 0;

test("real Codex marketplace refresh loads 0.9.0 skills and MCP in a fresh process", {
  skip: codexAvailable ? false : "requires the Codex CLI",
  timeout: 600_000,
}, async () => {
  const result = await verifyPluginMarketplaceUpgrade();
  assert.equal(result.verified, true);
  assert.equal(result.legacyVersion, "0.4.0");
  assert.equal(result.candidateVersion, "0.9.0");
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
});
