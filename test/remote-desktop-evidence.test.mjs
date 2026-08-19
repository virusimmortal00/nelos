import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  RemoteDesktopEvidenceError,
  assertProposedRemoteDesktopUsageV1,
  createRemoteDesktopEvidenceBundleV1,
  decodePngRgba,
  verifyRemoteDesktopEvidenceBundleV1,
} from "nelos/remote-desktop-evidence";
import { emptyRemoteDesktopUsage } from "nelos/remote-desktop-contract";
import { validRemoteDesktopEvidenceExportV1, validRemoteDesktopRunV1 } from "./fixtures/remote-desktop-contract-v1.mjs";

const SECRET = Buffer.from("PROMPT_RESPONSE_COOKIE_TOKEN_CREDENTIAL_PASSWORD", "ascii");
const CLASSES = ["conversation", "prompt", "response", "account", "sign_in", "credential"];

function maskedFrame(width = 16, height = 6) {
  const rgba = Buffer.alloc(width * height * 4, 0x7f);
  const regions = [];
  for (const [index, protectionClass] of CLASSES.entries()) {
    const region = { x: 0, y: index, width, height: 1 };
    regions.push({ class: protectionClass, region });
    for (let offset = 0; offset < width * 4; offset += 1) rgba[(index * width * 4) + offset] = SECRET[offset % SECRET.length];
  }
  return {
    rgba,
    sensitiveRegions: regions,
    protection: { geometryCertain: true, inventoryComplete: true, mode: "mask", regions: regions.map(({ region }) => ({ ...region })) },
  };
}

function metadata(run) {
  const remote = validRemoteDesktopEvidenceExportV1(run);
  return {
    scenarioMetadata: remote.scenarioMetadata,
    actionTimeline: remote.actionTimeline,
    assertionOutcomes: remote.assertionOutcomes,
    cleanupAttestation: remote.cleanupAttestation,
  };
}

const operationalUsage = { taskCount: 1, modelTurnCount: 1, spendUsd: 0.25, wallTimeMs: 2_000 };

async function directory(name) {
  const parent = await mkdtemp(join(tmpdir(), `nelos-desktop-evidence-${name}-`));
  return resolve(parent, "bundle");
}

async function builtBundle(name = "valid") {
  const run = validRemoteDesktopRunV1();
  const bundleDirectory = await directory(name);
  const frame = maskedFrame();
  const result = await createRemoteDesktopEvidenceBundleV1({
    bundleDirectory, run, ...metadata(run),
    screenshots: [{ artifactId: "screenshot-synthetic", scenarioId: "scenario-1", width: 16, height: 6, frame, maxOutputBytes: 20_000 }],
    recordings: [{
      artifactId: "recording-synthetic", scenarioId: "scenario-1", width: 16, height: 6,
      frames: [maskedFrame(), maskedFrame()], durationMs: 1_000, maxOutputBytes: 20_000,
      encodeSanitizedFrames: ({ frames }) => Buffer.concat([Buffer.from("000000106674797069736f6d00000000", "hex"), ...frames.map(({ rgba }) => rgba)]),
    }],
    diagnostics: [{ source: "desktop_runtime", diagnosticId: "diagnostic-synthetic", scenarioId: "scenario-1", code: "TASK_COMPLETE", occurredAt: "2026-08-19T12:01:00.000Z", fields: { component: "desktop", event: "task_complete", status: "ok", durationMs: 1000 } }],
    proposedOperationalUsage: operationalUsage,
  });
  return { run, bundleDirectory, result };
}

test("sanitizes every protected visual class before screenshot and recording persistence", async () => {
  const { run, bundleDirectory, result } = await builtBundle("sanitize");
  const verified = await verifyRemoteDesktopEvidenceBundleV1(bundleDirectory, run, { forbiddenBytes: [SECRET] });
  assert.equal(verified.artifactCount, 3);
  const screenshotRef = result.inventory.artifacts.find(({ kind }) => kind === "screenshot");
  const screenshot = decodePngRgba(await readFile(resolve(bundleDirectory, screenshotRef.relativePath)));
  assert.deepEqual(new Set(screenshot.rgba), new Set([0, 255]));
  const recordingRef = result.inventory.artifacts.find(({ kind }) => kind === "recording");
  const recording = await readFile(resolve(bundleDirectory, recordingRef.relativePath));
  assert.equal(recording.includes(SECRET), false);
  const files = await readdir(bundleDirectory, { recursive: true });
  assert.equal(files.some((name) => /raw|source|capture/iu.test(name)), false);
});

test("rejects uncertain, incomplete, and uncovered protection geometry without creating a bundle", async () => {
  const run = validRemoteDesktopRunV1();
  for (const mutate of [
    (frame) => { frame.protection.geometryCertain = false; },
    (frame) => { frame.protection.inventoryComplete = false; },
    (frame) => { frame.protection.regions.pop(); },
  ]) {
    const frame = maskedFrame(); mutate(frame); const bundleDirectory = await directory("geometry");
    await assert.rejects(createRemoteDesktopEvidenceBundleV1({
      bundleDirectory, run, ...metadata(run), proposedOperationalUsage: operationalUsage, screenshots: [{ artifactId: "shot", scenarioId: "scenario-1", width: 16, height: 6, frame, maxOutputBytes: 20_000 }],
    }), (error) => error instanceof RemoteDesktopEvidenceError && error.code === "UNCERTAIN_PROTECTION_GEOMETRY");
    await assert.rejects(readFile(resolve(bundleDirectory, "inventory.json")), { code: "ENOENT" });
  }
});

test("diagnostics enforce closed sources and fields and reject secret classes and values", async () => {
  const run = validRemoteDesktopRunV1();
  const attempts = [
    { source: "environment_dump", fields: { status: "ok" } },
    { source: "desktop_runtime", fields: { prompt: "synthetic prompt" } },
    { source: "desktop_runtime", fields: { status: "authorization: Bearer synthetic-secret-token" } },
    { source: "desktop_runtime", fields: { sessionStore: "opaque" } },
  ];
  for (const [index, candidate] of attempts.entries()) {
    await assert.rejects(createRemoteDesktopEvidenceBundleV1({
      bundleDirectory: await directory(`diagnostic-${index}`), run, ...metadata(run), proposedOperationalUsage: operationalUsage, diagnostics: [{ diagnosticId: "diag", scenarioId: "scenario-1", code: "ERROR", occurredAt: "2026-08-19T12:01:00.000Z", ...candidate }],
    }), (error) => error instanceof RemoteDesktopEvidenceError && error.code === "FORBIDDEN_DIAGNOSTIC");
  }
});

test("proposed post-operation accounting fails closed at every Desktop ceiling", () => {
  const run = validRemoteDesktopRunV1();
  const mappings = {
    taskCount: run.policy.maxTaskCount, modelTurnCount: run.policy.maxModelTurnCount,
    spendUsd: run.policy.maxSpendUsd, wallTimeMs: run.policy.maxWallTimeMs,
    screenshotCount: run.policy.screenshots.maxCount, screenshotBytes: run.policy.screenshots.maxBytes,
    recordingDurationMs: run.policy.recording.maxDurationMs, recordingBytes: run.policy.recording.maxBytes,
    diagnosticLogCount: run.policy.diagnostics.maxCount, diagnosticLogBytes: run.policy.diagnostics.maxBytes,
  };
  for (const [field, ceiling] of Object.entries(mappings)) {
    const delta = emptyRemoteDesktopUsage(); delta[field] = ceiling;
    assert.throws(() => assertProposedRemoteDesktopUsageV1(emptyRemoteDesktopUsage(), delta, run.policy), (error) => error.code === "BUDGET_EXHAUSTED", field);
  }
});

test("declared capture bounds and exact bytes are checked before persistence", async () => {
  const run = validRemoteDesktopRunV1();
  const bundleDirectory = await directory("budget");
  await assert.rejects(createRemoteDesktopEvidenceBundleV1({
    bundleDirectory, run, ...metadata(run), proposedOperationalUsage: operationalUsage, screenshots: [{ artifactId: "shot", scenarioId: "scenario-1", width: 16, height: 6, frame: maskedFrame(), maxOutputBytes: run.policy.screenshots.maxBytes }],
  }), (error) => error.code === "BUDGET_EXHAUSTED");
  await assert.rejects(readFile(resolve(bundleDirectory, "inventory.json")), { code: "ENOENT" });
});

test("verifier rejects traversal, symlinks, and altered content-addressed bytes", async (t) => {
  await t.test("traversal", async () => {
    const { run, bundleDirectory } = await builtBundle("traversal");
    const path = resolve(bundleDirectory, "inventory.json"); await chmod(path, 0o600);
    const inventory = JSON.parse(await readFile(path, "utf8")); inventory.artifacts[0].relativePath = "../outside.json";
    await writeFile(path, JSON.stringify(inventory));
    await assert.rejects(verifyRemoteDesktopEvidenceBundleV1(bundleDirectory, run), (error) => error.code === "INVALID_INVENTORY");
  });
  await t.test("symlink", async () => {
    const { run, bundleDirectory, result } = await builtBundle("symlink");
    const ref = result.inventory.artifacts[0]; const target = resolve(bundleDirectory, ref.relativePath); const moved = `${target}.outside`;
    await rename(target, moved); await symlink(moved, target);
    await assert.rejects(verifyRemoteDesktopEvidenceBundleV1(bundleDirectory, run), /regular unlinked file|symlinked/u);
  });
  await t.test("digest", async () => {
    const { run, bundleDirectory, result } = await builtBundle("digest");
    const target = resolve(bundleDirectory, result.inventory.artifacts[0].relativePath); await chmod(target, 0o600); await writeFile(target, "altered");
    await assert.rejects(verifyRemoteDesktopEvidenceBundleV1(bundleDirectory, run), (error) => error.code === "DIGEST_MISMATCH");
  });
  await t.test("unreferenced raw input", async () => {
    const { run, bundleDirectory } = await builtBundle("unreferenced");
    await writeFile(resolve(bundleDirectory, "raw-capture.bin"), SECRET);
    await assert.rejects(verifyRemoteDesktopEvidenceBundleV1(bundleDirectory, run, { forbiddenBytes: [SECRET] }), (error) => error.code === "INVALID_INVENTORY");
  });
});

test("bundle export stays accepted by the unchanged remote Desktop v1 validator", async () => {
  const { run, bundleDirectory, result } = await builtBundle("contract");
  const verified = await verifyRemoteDesktopEvidenceBundleV1(bundleDirectory, run);
  assert.deepEqual(verified.evidenceExport, result.evidenceExport);
  assert.deepEqual(Object.keys(verified.evidenceExport).sort(), ["actionTimeline", "assertionOutcomes", "cleanupAttestation", "diagnostics", "identities", "runId", "scenarioMetadata", "schemaVersion", "visualArtifacts"].sort());
});
