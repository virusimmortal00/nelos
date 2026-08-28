import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";

import {
  createDeterministicReviewerFixtureV1,
  runDesktopBundleAssertionsV1,
  runDesktopBundleReviewPipelineV1,
  validateIndependentReviewOutputV1,
} from "nelos/desktop-bundle-review";
import { createDesktopSmokeEvidenceBundleV1, DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 } from "nelos/desktop-smoke-evidence-contract";

function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function chunk(type, payload) {
  const value = Buffer.alloc(payload.byteLength + 12);
  value.writeUInt32BE(payload.byteLength, 0); value.write(type, 4, 4, "ascii"); payload.copy(value, 8);
  let crc = 0xffffffff;
  for (const byte of value.subarray(4, 8 + payload.byteLength)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  value.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + payload.byteLength);
  return value;
}

function png(width, height, tone) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const row = Buffer.alloc(width * 4 + 1);
  for (let index = 1; index < row.length; index += 4) { row[index] = tone; row[index + 1] = tone; row[index + 2] = tone; row[index + 3] = 255; }
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

const defects = Object.freeze([
  ["blank", "UNEXPECTED_BLANK_STATE", "error", "Rendered state is unexpectedly blank."],
  ["clipped", "UNEXPECTED_CLIPPED_STATE", "error", "Primary content is clipped at the viewport boundary."],
  ["overlap", "UNEXPECTED_OVERLAP", "error", "Independent visual review detected overlapping controls."],
  ["modal", "UNEXPECTED_MODAL_OBSCURATION", "warning", "A modal obscures the required interaction state."],
  ["loading", "UNEXPECTED_LOADING_STUCK", "error", "The checkpoint remains in a loading state."],
  ["inconsistent", "VISUAL_INCONSISTENCY", "warning", "Visual treatment is inconsistent with adjacent checkpoints."],
]);

function fixture({ invalidPng = false, assertionOutcome = "passed", includeAssertions = true, omitLastAssertion = false } = {}) {
  const runId = "run-review-1";
  const scenarioIds = defects.map(([name]) => `scenario-${name}`);
  const screenshots = new Map(); const artifacts = []; const checkpoints = []; const assertions = [];
  defects.forEach(([name], index) => {
    const scenarioId = `scenario-${name}`; const checkpointId = `checkpoint-${name}`; const artifactId = `shot-${name}`;
    const bytes = invalidPng && index === 0 ? Buffer.from("not-a-png") : png(32, 24, 30 + index * 20);
    screenshots.set(artifactId, bytes);
    artifacts.push({
      schemaVersion: 1, artifactId, runId, scenarioId, checkpointId, kind: "screenshot",
      relativePath: `artifacts/${scenarioId}/${artifactId}.png`, mediaType: "image/png", byteLength: bytes.byteLength,
      digest: sha256(bytes), viewable: true,
      protection: { policyId: "desktop-redaction-v1", attested: true, traversalComplete: true, inventoryComplete: true, regionsDetected: 1, regionsProcessed: 1, outputSanitized: true, sourcePixelsRetained: false },
    });
    checkpoints.push({ schemaVersion: 1, checkpointId, runId, scenarioId, type: "screenshot", outcome: "captured", artifactIds: [artifactId] });
    assertions.push({ schemaVersion: 1, assertionId: `assertion-${name}`, runId, scenarioId, checkpointId, outcome: assertionOutcome, code: assertionOutcome === "passed" ? "MATCHED" : "MISMATCH" });
  });
  const bundle = createDesktopSmokeEvidenceBundleV1({
    run: { schemaVersion: 1, runId, scenarioSetId: "release", candidate: { version: "0.12.20", digest: `sha256:${"a".repeat(64)}`, sourceRevision: "b".repeat(40) }, startedAt: "2026-08-27T12:00:00.000Z", finishedAt: "2026-08-27T12:00:01.000Z", outcome: "passed", scenarioIds: [...scenarioIds].sort(), diagnosticLimits: { ...DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 } },
    checkpoints, artifacts, assertionResults: includeAssertions ? (omitLastAssertion ? assertions.slice(0, -1) : assertions) : [], diagnostics: [],
    files: artifacts.map(({ artifactId }) => ({ artifactId, bytes: screenshots.get(artifactId) })),
  });
  const expectations = {
    schemaVersion: 1,
    requiredCheckpoints: checkpoints.map(({ scenarioId, checkpointId, type }) => ({ scenarioId, checkpointId, type, minWidth: 32, minHeight: 24, maxWidth: 32, maxHeight: 24 })),
    requiredAssertions: assertions.map(({ scenarioId, assertionId, checkpointId }) => ({ scenarioId, assertionId, checkpointId, outcome: "passed" })),
    scenarioOutcomes: scenarioIds.map((scenarioId) => ({ scenarioId, outcome: "passed" })),
    workflowInvariants: ["all_assertions_passed", "all_checkpoints_captured", "all_scenarios_declared", "cleanup_proven", "screenshots_sanitized"],
  };
  const execution = { runId, outcome: "passed", scenarioOutcomes: scenarioIds.map((scenarioId) => ({ scenarioId, outcome: "passed" })), cleanup: { cloneId: "clone-review-1", destroyed: true, absent: true, independentlyVerified: true } };
  return { bundle: bundle.bytes, expectations, execution, artifacts };
}

function reviewerForDefects(state) {
  const findings = Object.fromEntries(state.artifacts.map((artifact, index) => [artifact.digest, [{ code: defects[index][1], severity: defects[index][2], observation: defects[index][3] }]]));
  return createDeterministicReviewerFixtureV1(findings);
}

test("two-pass review emits separate receipts and finds all deterministic unexpected visual states", async () => {
  const state = fixture();
  const result = await runDesktopBundleReviewPipelineV1({ ...state, reviewer: reviewerForDefects(state) });
  assert.equal(result.assertions.evaluatorId, "desktop-bundle-assertion-evaluator-v1");
  assert.equal(result.assertions.status, "passed");
  assert.equal(result.review.reviewerId, "deterministic-sanitized-visual-reviewer-fixture-v1");
  assert.notEqual(result.review.reviewerId, result.assertions.evaluatorId);
  assert.equal(result.review.status, "findings");
  assert.deepEqual(new Set(result.review.findings.map(({ code }) => code)), new Set(defects.map(([, code]) => code)));
  for (const finding of result.review.findings) {
    assert.match(finding.findingId, /^finding:/u);
    assert.match(finding.evidenceDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(!Object.keys(finding).some((field) => /pixels|text|credential|transcript/iu.test(field)));
  }
  assert.match(result.report.text, /Execution: passed\nAssertions: passed\nIndependent review: findings/u);
  assert.equal(result.report.json.cleanup.independentlyVerified, true);
});

test("clean deterministic reviewer fixture avoids material false findings", async () => {
  const state = fixture();
  const result = await runDesktopBundleReviewPipelineV1({ ...state, reviewer: createDeterministicReviewerFixtureV1() });
  assert.equal(result.assertions.status, "passed");
  assert.equal(result.review.status, "passed");
  assert.deepEqual(result.review.findings, []);
  assert.match(result.report.text, /Findings: none$/u);
});

test("assertion pass verifies decoding, dimensions, checkpoints, outcomes, cleanup, bounds, and invariants", () => {
  const clean = fixture();
  const receipt = runDesktopBundleAssertionsV1(clean);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.screenshotInventory.length, defects.length);
  assert.ok(receipt.checks.some(({ checkId, code }) => checkId === "manifest-integrity" && code === "MANIFEST_VERIFIED"));
  assert.ok(receipt.checks.some(({ checkId }) => checkId === "evidence-bounds"));
  assert.ok(receipt.checks.some(({ checkId }) => checkId === "cleanup-proof"));
  assert.ok(receipt.checks.filter(({ checkId }) => checkId.startsWith("invariant:")).every(({ status }) => status === "passed"));

  const badImage = fixture({ invalidPng: true });
  const badImageReceipt = runDesktopBundleAssertionsV1(badImage);
  assert.equal(badImageReceipt.status, "failed");
  assert.ok(badImageReceipt.checks.some(({ code }) => code === "SCREENSHOT_DECODE_FAILED"));

  const failedAssertions = fixture({ assertionOutcome: "failed" });
  assert.ok(runDesktopBundleAssertionsV1(failedAssertions).checks.some(({ checkId, status }) => checkId === "invariant:all_assertions_passed" && status === "failed"));

  const wrong = fixture();
  wrong.execution.cleanup.absent = false;
  wrong.execution.scenarioOutcomes[0].outcome = "failed";
  wrong.expectations.requiredCheckpoints[0].checkpointId = "checkpoint-missing";
  const failed = runDesktopBundleAssertionsV1(wrong);
  assert.equal(failed.status, "failed");
  assert.ok(failed.checks.some(({ checkId, status }) => checkId === "cleanup-proof" && status === "failed"));
  assert.ok(failed.checks.some(({ checkId, status }) => checkId.startsWith("scenario:") && status === "failed"));
  assert.ok(failed.checks.some(({ code }) => code === "CHECKPOINT_MISSING_OR_INCOMPLETE"));
});

test("zero assertion evidence fails the assertion pass and prevents independent review", async () => {
  const state = fixture({ includeAssertions: false });
  const result = await runDesktopBundleReviewPipelineV1({ ...state, reviewer: createDeterministicReviewerFixtureV1() });
  assert.equal(result.assertions.status, "failed");
  assert.ok(result.assertions.checks.some(({ checkId, status }) => checkId === "invariant:all_assertions_passed" && status === "failed"));
  assert.equal(result.review.status, "not_run");
  assert.equal(result.review.errorCode, "ASSERTIONS_NOT_PASSED");
});

test("partial canonical assertion omission fails review even when every retained assertion passed", async () => {
  const state = fixture({ omitLastAssertion: true });
  const result = await runDesktopBundleReviewPipelineV1({ ...state, reviewer: createDeterministicReviewerFixtureV1() });
  assert.equal(result.assertions.status, "failed");
  assert.ok(result.assertions.checks.some(({ checkId, code }) => checkId === "assertion-inventory" && code === "ASSERTION_INVENTORY_MISMATCH"));
  assert.equal(result.review.status, "not_run");
});

test("reviewer receives only verified sanitized artifacts and bounded manifest context", async () => {
  const state = fixture(); let observed = null;
  const reviewer = {
    reviewerId: "boundary-probe-reviewer-v1",
    async review(context) {
      observed = context;
      assert.deepEqual(Object.keys(context).sort(), ["manifestContext", "schemaVersion", "screenshots"]);
      assert.deepEqual(Object.keys(context.manifestContext).sort(), ["bundleDigest", "bundleId", "format", "runId", "totals"]);
      assert.ok(context.screenshots.every((shot) => shot.bytes instanceof Buffer && shot.evidenceDigest === sha256(shot.bytes)));
      assert.ok(!JSON.stringify(context, (key, value) => key === "bytes" ? "[bytes]" : value).match(/sealed|transcript|credential|controller|rawGuest/iu));
      context.screenshots[0].bytes.fill(0);
      return { schemaVersion: 1, outcome: "clean", findings: [] };
    },
  };
  const before = sha256(state.bundle);
  const result = await runDesktopBundleReviewPipelineV1({ ...state, reviewer });
  assert.ok(observed);
  assert.equal(result.review.status, "passed");
  assert.equal(sha256(state.bundle), before, "reviewer cannot mutate the underlying run bundle");
});

test("review failures remain independent from execution and assertion outcomes", async () => {
  const state = fixture();
  const unavailable = await runDesktopBundleReviewPipelineV1({ ...state, reviewer: null });
  assert.equal(unavailable.assertions.status, "passed"); assert.equal(unavailable.review.status, "unavailable"); assert.equal(unavailable.report.json.execution.status, "passed");

  const failed = await runDesktopBundleReviewPipelineV1({ ...state, reviewer: { reviewerId: "failing-reviewer-v1", async review() { throw new Error("down"); } } });
  assert.equal(failed.review.status, "failed"); assert.equal(failed.review.errorCode, "REVIEW_FAILED");

  const malformed = await runDesktopBundleReviewPipelineV1({ ...state, reviewer: { reviewerId: "malformed-reviewer-v1", async review() { return { outcome: "clean", findings: [] }; } } });
  assert.equal(malformed.review.status, "malformed");

  const timedOut = await runDesktopBundleReviewPipelineV1({ ...state, reviewer: { reviewerId: "slow-reviewer-v1", async review() { return new Promise(() => {}); } }, reviewTimeoutMs: 5 });
  assert.equal(timedOut.review.status, "timed_out"); assert.equal(timedOut.review.errorCode, "REVIEW_TIMEOUT");

  const assertionFailure = fixture({ assertionOutcome: "failed" });
  const skipped = await runDesktopBundleReviewPipelineV1({ ...assertionFailure, reviewer: createDeterministicReviewerFixtureV1() });
  assert.equal(skipped.assertions.status, "failed"); assert.equal(skipped.review.status, "not_run");
});

test("review schema rejects unbound digests, unstable identifiers, sensitive observations, and oversized lists", () => {
  const state = fixture(); const assertions = runDesktopBundleAssertionsV1(state); const evidence = assertions.screenshotInventory[0];
  const finding = { findingId: `finding:unexpected_blank_state:${evidence.scenarioId}:${evidence.checkpointId}:${evidence.evidenceDigest.slice(7, 19)}`, code: "UNEXPECTED_BLANK_STATE", severity: "error", scenarioId: evidence.scenarioId, checkpointId: evidence.checkpointId, observation: "Unexpected blank state.", evidenceDigest: evidence.evidenceDigest };
  assert.equal(validateIndependentReviewOutputV1({ schemaVersion: 1, outcome: "findings", findings: [finding] }, assertions.screenshotInventory).findings.length, 1);
  assert.throws(() => validateIndependentReviewOutputV1({ schemaVersion: 1, outcome: "findings", findings: [{ ...finding, evidenceDigest: `sha256:${"0".repeat(64)}` }] }, assertions.screenshotInventory), /evidence/iu);
  assert.throws(() => validateIndependentReviewOutputV1({ schemaVersion: 1, outcome: "findings", findings: [{ ...finding, findingId: "finding:unstable" }] }, assertions.screenshotInventory), /stable/iu);
  assert.throws(() => validateIndependentReviewOutputV1({ schemaVersion: 1, outcome: "findings", findings: [{ ...finding, observation: "Leaked credential text" }] }, assertions.screenshotInventory), /unsafe/iu);
  assert.throws(() => validateIndependentReviewOutputV1({ schemaVersion: 1, outcome: "findings", findings: Array.from({ length: 33 }, () => finding) }, assertions.screenshotInventory), /bound/iu);
});
