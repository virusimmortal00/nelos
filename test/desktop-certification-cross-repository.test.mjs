import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { verifyDesktopCertificationReceiptV1 } from "../src/desktop-certification-contract.mjs";

const fixtures = resolve(new URL("./fixtures/desktop-certification/", import.meta.url).pathname);

async function json(name) {
  return JSON.parse(await readFile(resolve(fixtures, name), "utf8"));
}

test("public verification accepts the immutable sanitized fixture emitted by the private producer", async () => {
  const run = await json("sanitized-run.v1.json");
  const receipt = await json("valid-receipt.v1.json");
  assert.equal(receipt.harnessCommitSha, "0aa30e343177d2bef8abc9b0041c79125a492c9e");
  assert.equal(receipt.harnessVersion, "0.1.0");

  const verification = verifyDesktopCertificationReceiptV1({
    receipt,
    expected: {
      nelosCommitSha: run.candidate.commitSha,
      candidateDigest: run.candidate.artifactDigest,
      harnessCommitSha: run.harness.commitSha,
      harnessVersion: run.harness.version,
      templateIdentity: run.template.identity,
      evidenceIdentity: run.evidence.identity,
    },
  });
  assert.equal(verification.outcome, "verified");
});
