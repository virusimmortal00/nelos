import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  DesktopCertificationContractError,
  createDesktopCertificationCheckRequestV1,
  validateDesktopCertificationReceiptV1,
  verifyDesktopCertificationReceiptV1,
} from "../src/desktop-certification-contract.mjs";

const root = resolve(new URL("../", import.meta.url).pathname);
const fixtureRoot = resolve(root, "test/fixtures/desktop-certification");

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fixture(name) {
  return json(resolve(fixtureRoot, name));
}

function expectation(receipt) {
  return {
    nelosCommitSha: receipt.nelosCommitSha,
    candidateDigest: receipt.candidateDigest,
    harnessCommitSha: receipt.harnessCommitSha,
    harnessVersion: receipt.harnessVersion,
    templateIdentity: receipt.templateIdentity,
    evidenceIdentity: receipt.evidenceIdentity,
  };
}

test("the positive certification fixture validates and verifies exact external identities", async () => {
  const receipt = await fixture("valid-receipt.v1.json");
  assert.deepEqual(validateDesktopCertificationReceiptV1(receipt), receipt);
  const verification = verifyDesktopCertificationReceiptV1({
    receipt,
    expected: expectation(receipt),
  });
  assert.equal(verification.outcome, "verified");
  assert.match(verification.receiptDigest, /^sha256:[a-f0-9]{64}$/u);
});

for (const [name, code] of [
  ["missing-identity.v1.json", "UNEXPECTED_CERTIFICATION_FIELD"],
  ["inconsistent-totals.v1.json", "INCONSISTENT_CERTIFICATION_TOTALS"],
  ["failed-cleanup.v1.json", "CLEANUP_NOT_VERIFIED"],
  ["unexpected-private-field.v1.json", "UNEXPECTED_CERTIFICATION_FIELD"],
]) {
  test(`${name} fails closed`, async () => {
    const receipt = await fixture(name);
    assert.throws(
      () => validateDesktopCertificationReceiptV1(receipt),
      (error) => error instanceof DesktopCertificationContractError && error.code === code,
    );
  });
}

test("external verification fails closed on an identity mismatch and unexpected expectation fields", async () => {
  const receipt = await fixture("valid-receipt.v1.json");
  assert.throws(() => verifyDesktopCertificationReceiptV1({
    receipt,
    expected: { ...expectation(receipt), nelosCommitSha: "f".repeat(40) },
  }), { code: "CERTIFICATION_IDENTITY_MISMATCH" });
  assert.throws(() => verifyDesktopCertificationReceiptV1({
    receipt,
    expected: { ...expectation(receipt), controllerAddress: "private.invalid" },
  }), { code: "UNEXPECTED_CERTIFICATION_FIELD" });
});

test("verification rejects schema-version mismatch and failed certification results", async () => {
  const receipt = await fixture("valid-receipt.v1.json");
  assert.throws(() => verifyDesktopCertificationReceiptV1({
    receipt: { ...receipt, schemaVersion: 2 },
    expected: expectation(receipt),
  }), { code: "UNSUPPORTED_CERTIFICATION_VERSION" });

  const failed = structuredClone(receipt);
  failed.scenarios[0].outcome = "failed";
  failed.scenarios[0].assertionTotals = { total: 2, passed: 1, failed: 1 };
  failed.assertions[0].outcome = "failed";
  failed.scenarioTotals = { total: 2, passed: 1, failed: 1, skipped: 0 };
  failed.assertionTotals = { total: 3, passed: 2, failed: 1 };
  assert.deepEqual(validateDesktopCertificationReceiptV1(failed), failed);
  assert.throws(() => verifyDesktopCertificationReceiptV1({
    receipt: failed,
    expected: expectation(failed),
  }), { code: "CERTIFICATION_FAILED" });
});

test("scenario totals include skipped outcomes and fail closed when inconsistent", async () => {
  const receipt = await fixture("valid-receipt.v1.json");
  const skipped = structuredClone(receipt);
  skipped.scenarios.push({
    scenarioId: "optional-platform",
    outcome: "skipped",
    assertionTotals: { total: 0, passed: 0, failed: 0 },
  });
  skipped.scenarioTotals = { total: 3, passed: 2, failed: 0, skipped: 1 };
  assert.deepEqual(validateDesktopCertificationReceiptV1(skipped), skipped);
  skipped.scenarioTotals.skipped = 0;
  assert.throws(() => validateDesktopCertificationReceiptV1(skipped), {
    code: "INCONSISTENT_CERTIFICATION_TOTALS",
  });
});

test("the check request targets only the exact candidate SHA with narrow permissions", async () => {
  const receipt = await fixture("valid-receipt.v1.json");
  const request = createDesktopCertificationCheckRequestV1({
    repository: { owner: "virusimmortal00", name: "nelos" },
    receipt,
    expected: expectation(receipt),
  });
  assert.equal(request.method, "POST");
  assert.equal(request.endpoint, "/repos/virusimmortal00/nelos/check-runs");
  assert.deepEqual(request.permissions, { checks: "write", metadata: "read" });
  assert.equal(request.body.head_sha, receipt.nelosCommitSha);
  assert.equal(request.body.conclusion, "success");
  assert.equal(request.body.external_id, verifyDesktopCertificationReceiptV1({
    receipt,
    expected: expectation(receipt),
  }).receiptDigest);
  assert.doesNotMatch(JSON.stringify(request), /private\.invalid|screenshot|controller|network|credential|localPath/iu);
});

test("the migration manifest retains only provider-neutral public certification assets", async () => {
  const manifest = await json(resolve(root, "validation/desktop-smoke/asset-migration.v1.json"));
  assert.deepEqual(Object.keys(manifest).sort(), ["candidateBaseCommit", "inventoryDefinition", "manifestVersion", "private", "public", "removed", "schemaVersion"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.candidateBaseCommit, "a767ac133f864e327a067efeebc534a7f850ccd1");
  assert.equal(new Set(manifest.public).size, manifest.public.length);
  assert.deepEqual(manifest.private, []);
  assert.deepEqual(manifest.removed.map(({ assetClass }) => assetClass), [
    "provider-and-template-implementation", "controller-and-vm-execution",
    "screenshots-and-raw-evidence", "harness-tests-and-ci",
  ]);
  for (const path of manifest.public) await access(resolve(root, path));

  for (const path of [
    ".github/workflows/proxmox-template.yml", "validation/proxmox/README.md",
    "src/desktop-gui-scenario-driver/index.mjs", "src/desktop-smoke-evidence-contract.mjs",
    "src/disposable-desktop-smoke.mjs", "src/fresh-vm-desktop-runner.mjs",
    "src/machine-desktop-smoke-adapter.mjs", "scripts/run-desktop-smoke-certification.mjs",
  ]) {
    await assert.rejects(access(resolve(root, path)), { code: "ENOENT" });
  }
});

test("the public receipt schema and fixtures have no private or raw-evidence fields", async () => {
  const publicPaths = [
    "validation/desktop-smoke/certification-receipt.v1.schema.json",
    "validation/desktop-smoke/scenario-result.v1.schema.json",
    "validation/desktop-smoke/assertion-result.v1.schema.json",
    "test/fixtures/desktop-certification/valid-receipt.v1.json",
    "test/fixtures/desktop-certification/sanitized-run.v1.json",
  ];
  const forbidden = /credential|password|secret|token|controllerAddress|controllerUrl|networkTopology|vmId|vmid|cloneId|accountId|guestCodexHome|localPath|rawScreenshot|rawEvidence/iu;
  for (const path of publicPaths) assert.doesNotMatch(await readFile(resolve(root, path), "utf8"), forbidden, path);
});
