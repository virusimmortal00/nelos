import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1,
  createDesktopSmokeEvidenceBundleV1,
  deriveDesktopSmokeReviewResultV1,
  readDesktopSmokeEvidenceFilesV1,
  validateDesktopSmokeArtifactV1,
  validateDesktopSmokeAssertionResultV1,
  validateDesktopSmokeBundleManifestV1,
  validateDesktopSmokeCheckpointV1,
  validateDesktopSmokeDiagnosticV1,
  validateDesktopSmokeEvidenceBundleV1,
  validateDesktopSmokeEvidenceRunV1,
  validateDesktopSmokeReviewResultV1,
} from "nelos/desktop-smoke-evidence-contract";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function fixture() {
  const screenshot = Buffer.from("sanitized-png-v1");
  const run = {
    schemaVersion: 1,
    runId: "run-1",
    scenarioSetId: "release",
    candidate: { version: "0.12.20", digest: `sha256:${"a".repeat(64)}`, sourceRevision: "b".repeat(40) },
    startedAt: "2026-08-27T12:00:00.000Z",
    finishedAt: "2026-08-27T12:00:01.000Z",
    outcome: "passed",
    scenarioIds: ["scenario-1"],
    diagnosticLimits: { ...DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 },
  };
  const artifact = {
    schemaVersion: 1,
    artifactId: "shot-1",
    runId: "run-1",
    scenarioId: "scenario-1",
    checkpointId: "checkpoint-1",
    kind: "screenshot",
    relativePath: "artifacts/scenario-1/shot-1.png",
    mediaType: "image/png",
    byteLength: screenshot.byteLength,
    digest: sha256(screenshot),
    viewable: true,
    protection: {
      policyId: "desktop-redaction-v1",
      attested: true,
      traversalComplete: true,
      inventoryComplete: true,
      regionsDetected: 2,
      regionsProcessed: 2,
      outputSanitized: true,
      sourcePixelsRetained: false,
    },
  };
  const checkpoint = {
    schemaVersion: 1,
    checkpointId: "checkpoint-1",
    runId: "run-1",
    scenarioId: "scenario-1",
    type: "screenshot",
    outcome: "captured",
    artifactIds: ["shot-1"],
  };
  const assertion = {
    schemaVersion: 1,
    assertionId: "assertion-1",
    runId: "run-1",
    scenarioId: "scenario-1",
    checkpointId: "checkpoint-1",
    outcome: "passed",
    code: "MATCHED",
  };
  const diagnosticPayload = {
    code: "SCENARIO_COMPLETE",
    severity: "info",
    fields: { checkpointId: "checkpoint-1", elapsedMs: 1000 },
    text: { value: "completed with [REDACTED] identifiers", redacted: true, policyId: "diagnostic-redaction-v1" },
  };
  const diagnosticBytes = Buffer.from(canonical(diagnosticPayload));
  const diagnostic = {
    schemaVersion: 1,
    diagnosticId: "diagnostic-1",
    runId: "run-1",
    scenarioId: "scenario-1",
    ...diagnosticPayload,
    byteLength: diagnosticBytes.byteLength,
    digest: sha256(diagnosticBytes),
  };
  return { run, artifact, checkpoint, assertion, diagnostic, screenshot };
}

function build(input = fixture()) {
  return createDesktopSmokeEvidenceBundleV1({
    run: input.run,
    checkpoints: [input.checkpoint],
    artifacts: [input.artifact],
    assertionResults: [input.assertion],
    diagnostics: [input.diagnostic],
    files: [{ artifactId: input.artifact.artifactId, bytes: input.screenshot }],
  });
}

test("V1 run, checkpoint, artifact, assertion, diagnostic, manifest, and review shapes are closed", () => {
  const input = fixture();
  const bundle = build(input);
  const review = deriveDesktopSmokeReviewResultV1({
    manifest: bundle.manifest,
    run: input.run,
    checkpoints: [input.checkpoint],
    artifacts: [input.artifact],
    assertionResults: [input.assertion],
    diagnostics: [input.diagnostic],
  });
  assert.equal(validateDesktopSmokeEvidenceRunV1(input.run).runId, "run-1");
  assert.equal(validateDesktopSmokeCheckpointV1(input.checkpoint).checkpointId, "checkpoint-1");
  assert.equal(validateDesktopSmokeArtifactV1(input.artifact).artifactId, "shot-1");
  assert.equal(validateDesktopSmokeAssertionResultV1(input.assertion).outcome, "passed");
  assert.equal(validateDesktopSmokeDiagnosticV1(input.diagnostic).severity, "info");
  assert.equal(validateDesktopSmokeBundleManifestV1(bundle.manifest).bundleDigest, bundle.manifest.bundleDigest);
  assert.equal(validateDesktopSmokeReviewResultV1(review).outcome, "approved");
  for (const [validator, value] of [
    [validateDesktopSmokeEvidenceRunV1, input.run],
    [validateDesktopSmokeCheckpointV1, input.checkpoint],
    [validateDesktopSmokeArtifactV1, input.artifact],
    [validateDesktopSmokeAssertionResultV1, input.assertion],
    [validateDesktopSmokeDiagnosticV1, input.diagnostic],
    [validateDesktopSmokeBundleManifestV1, bundle.manifest],
    [validateDesktopSmokeReviewResultV1, review],
  ]) assert.throws(() => validator({ ...value, futureField: true }), /closed schema/u);
});

test("canonical bundles are byte-identical for identical normalized inputs and self-verify", () => {
  const first = build();
  const second = build();
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(validateDesktopSmokeEvidenceBundleV1(first.bytes).manifest, first.manifest);
  const decoded = JSON.parse(first.bytes);
  assert.deepEqual(decoded.entries.map(({ relativePath }) => relativePath), [...decoded.entries.map(({ relativePath }) => relativePath)].sort());
});

test("screenshots require complete protected-region processing and sensitive fields never enter records", () => {
  const input = fixture();
  input.artifact.protection.regionsProcessed = 1;
  assert.throws(() => validateDesktopSmokeArtifactV1(input.artifact), /protected-region processing/u);
  input.artifact.protection.regionsProcessed = 2;
  input.diagnostic.fields.token = "sensitive";
  assert.throws(() => validateDesktopSmokeDiagnosticV1(input.diagnostic), /not allowlisted/u);
  const unsafe = { ...input.artifact, unsanitizedPixels: "forbidden" };
  assert.throws(() => validateDesktopSmokeArtifactV1(unsafe), /closed schema/u);
});

test("traversal, duplicate identifiers, digest mismatches, and oversized diagnostics fail closed", () => {
  const input = fixture();
  assert.throws(() => validateDesktopSmokeArtifactV1({ ...input.artifact, relativePath: "../shot.png" }), /traversal/u);
  assert.throws(() => createDesktopSmokeEvidenceBundleV1({
    run: input.run,
    checkpoints: [input.checkpoint],
    artifacts: [input.artifact, input.artifact],
    assertionResults: [input.assertion],
    diagnostics: [input.diagnostic],
    files: [{ artifactId: input.artifact.artifactId, bytes: input.screenshot }],
  }), /unique/u);
  assert.throws(() => createDesktopSmokeEvidenceBundleV1({
    run: input.run,
    checkpoints: [input.checkpoint],
    artifacts: [input.artifact],
    assertionResults: [input.assertion],
    diagnostics: [input.diagnostic],
    files: [{ artifactId: input.artifact.artifactId, bytes: Buffer.from("altered") }],
  }), /do not match/u);
  const diagnostics = Array.from({ length: 65 }, (_, index) => ({ ...input.diagnostic, diagnosticId: `diagnostic-${index}` }));
  assert.throws(() => createDesktopSmokeEvidenceBundleV1({
    run: input.run,
    checkpoints: [input.checkpoint],
    artifacts: [input.artifact],
    assertionResults: [input.assertion],
    diagnostics,
    files: [{ artifactId: input.artifact.artifactId, bytes: input.screenshot }],
  }), /per-scenario ceiling/u);
});

test("bundle verification rejects altered payloads and manifests", () => {
  const bundle = build();
  const alteredPayload = JSON.parse(bundle.bytes);
  alteredPayload.entries[0].data = Buffer.from("altered").toString("base64");
  assert.throws(() => validateDesktopSmokeEvidenceBundleV1(Buffer.from(canonical(alteredPayload))), /does not match its manifest/u);
  const alteredManifest = JSON.parse(bundle.bytes);
  alteredManifest.manifest.totals.fileBytes += 1;
  assert.throws(() => validateDesktopSmokeEvidenceBundleV1(Buffer.from(canonical(alteredManifest))), /totals do not match/u);
});

test("filesystem evidence ingestion rejects symlinks and verifies regular-file digests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-evidence-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = fixture();
  await mkdir(join(root, "artifacts", "scenario-1"), { recursive: true });
  const target = join(root, "target.png");
  await writeFile(target, input.screenshot);
  await symlink(target, join(root, input.artifact.relativePath));
  await assert.rejects(readDesktopSmokeEvidenceFilesV1(root, [input.artifact]), /symlinks/u);
  await rm(join(root, input.artifact.relativePath));
  await writeFile(join(root, input.artifact.relativePath), input.screenshot);
  const files = await readDesktopSmokeEvidenceFilesV1(root, [input.artifact]);
  assert.deepEqual(files, [{ artifactId: "shot-1", bytes: input.screenshot }]);
});
