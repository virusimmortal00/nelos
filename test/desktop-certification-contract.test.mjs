import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import test from "node:test";

import {
  DesktopCertificationContractError,
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

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory)) {
    const path = resolve(directory, entry);
    if ((await stat(path)).isDirectory()) {
      if (![".git", "node_modules"].includes(entry)) output.push(...await files(path));
    }
    else output.push(relative(root, path));
  }
  return output;
}

test("the positive certification fixture validates and verifies exact external identities", async () => {
  const receipt = await fixture("valid-receipt.v1.json");
  assert.deepEqual(validateDesktopCertificationReceiptV1(receipt), receipt);
  const verification = verifyDesktopCertificationReceiptV1({
    receipt,
    expected: {
      nelosCommitSha: receipt.nelosCommitSha,
      candidateDigest: receipt.candidateDigest,
      harnessCommitSha: receipt.harnessCommitSha,
      harnessVersion: receipt.harnessVersion,
      templateIdentity: receipt.templateIdentity,
    },
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
    expected: {
      nelosCommitSha: "f".repeat(40),
      candidateDigest: receipt.candidateDigest,
      harnessCommitSha: receipt.harnessCommitSha,
      harnessVersion: receipt.harnessVersion,
      templateIdentity: receipt.templateIdentity,
    },
  }), { code: "CERTIFICATION_IDENTITY_MISMATCH" });
  assert.throws(() => verifyDesktopCertificationReceiptV1({
    receipt,
    expected: {
      nelosCommitSha: receipt.nelosCommitSha,
      candidateDigest: receipt.candidateDigest,
      harnessCommitSha: receipt.harnessCommitSha,
      harnessVersion: receipt.harnessVersion,
      templateIdentity: receipt.templateIdentity,
      controllerAddress: "private.invalid",
    },
  }), { code: "UNEXPECTED_CERTIFICATION_FIELD" });
});

test("the migration manifest classifies every current Desktop testing asset exactly once", async () => {
  const manifest = await json(resolve(root, "validation/desktop-smoke/asset-migration.v1.json"));
  assert.deepEqual(Object.keys(manifest).sort(), ["candidateBaseCommit", "inventoryDefinition", "manifestVersion", "private", "public", "removed", "schemaVersion"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.candidateBaseCommit, "a767ac133f864e327a067efeebc534a7f850ccd1");
  assert.equal(new Set(manifest.public).size, manifest.public.length);
  assert.equal(new Set(manifest.private).size, manifest.private.length);
  assert.equal(manifest.public.some((path) => manifest.private.includes(path)), false);
  assert.deepEqual(manifest.removed.map(({ assetClass }) => assetClass), ["raw-screenshots", "controller-and-guest-logs", "credential-and-lease-material"]);

  const integration = new Set([
    ".github/workflows/release.yml", "bin/nelos", "completions/nelos.bash", "completions/nelos.fish",
    "completions/nelos.zsh", "docs/release-policy.md", "package.json",
  ]);
  const inventory = (await files(root)).filter((path) =>
    !path.startsWith(".git/") && !path.startsWith("node_modules/") &&
    (/desktop|proxmox|screen-capture|visual-state/iu.test(path) || integration.has(path))
  ).sort();
  assert.deepEqual([...manifest.public, ...manifest.private].sort(), inventory);
});

test("the public receipt schema and fixtures have no private or raw-evidence fields", async () => {
  const publicPaths = [
    "validation/desktop-smoke/certification-receipt.v1.schema.json",
    "validation/desktop-smoke/scenario-result.v1.schema.json",
    "validation/desktop-smoke/assertion-result.v1.schema.json",
    "test/fixtures/desktop-certification/valid-receipt.v1.json",
  ];
  const forbidden = /credential|password|secret|token|controllerAddress|controllerUrl|vmId|vmid|cloneId|accountId|guestCodexHome|rawScreenshot|rawEvidence/iu;
  for (const path of publicPaths) assert.doesNotMatch(await readFile(resolve(root, path), "utf8"), forbidden, path);
});
