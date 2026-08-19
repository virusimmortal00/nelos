import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateDeveloperVisualState } from "../src/dev-visual-state-validation.mjs";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("visual-state")]);
const ID = "01a01ae1-1dd0-77f1-8cda-e4285c58dd4c";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nelos-visual-state-"));
  const imagePath = join(directory, "capture.png");
  const metadataPath = join(directory, "capture.json");
  const digest = `sha256:${createHash("sha256").update(PNG).digest("hex")}`;
  await writeFile(imagePath, PNG);
  await writeFile(metadataPath, `${JSON.stringify({ schemaVersion: 1, kind: "nelos-developer-screen-capture", capturedAt: "2026-08-19T17:20:00.000Z", display: 1, image: "capture.png", bytes: PNG.length, digest, localOnly: true })}\n`);
  return {
    capture: { imagePath, metadataPath },
    input: {
      schemaVersion: 1,
      capture: { imagePath, metadataPath },
      visualSurfaces: [{ surface: "sidebar", entries: [{ threadId: ID, observedName: "Build Proxmox Desktop backe…", nameResolution: "truncated", observedStatus: "active" }] }],
      nativeThreads: [{ threadId: ID, title: "Build Proxmox Desktop backend", status: "active" }],
      nelosThreads: [{ threadId: ID, title: "Build Proxmox Desktop backend", status: "running" }],
    },
  };
}

test("passes a digest-bound capture when visual, native, and Nelos lifecycle phases agree", async () => {
  const { input } = await fixture();
  input.visualSurfaces.push({ surface: "mcpVisual", entries: [{ threadId: ID, observedName: "Build Proxmox Desktop backend", nameResolution: "exact", observedStatus: "running" }] });
  const report = await validateDeveloperVisualState(input);
  assert.equal(report.outcome, "passed");
  assert.deepEqual(report.findings, []);
  assert.equal(report.counts.visibleEntries, 2);
});

test("reports sidebar, Created tasks, native inventory, and Nelos contradictions", async () => {
  const { input } = await fixture();
  input.visualSurfaces.push({ surface: "createdTasks", entries: [{ threadId: ID, observedName: "Build Proxmox Desktop backend", nameResolution: "exact", observedStatus: "done" }] });
  input.nativeThreads[0].status = "idle";
  input.nelosThreads[0].status = "running";
  const report = await validateDeveloperVisualState(input);
  assert.equal(report.outcome, "failed");
  assert.deepEqual(new Set(report.findings.map(({ code }) => code)), new Set([
    "VISUAL_NATIVE_STATUS_MISMATCH",
    "VISUAL_SURFACE_CONTRADICTION",
    "NATIVE_NELOS_STATUS_MISMATCH",
  ]));
  assert.equal(report.findings.filter(({ code }) => code === "VISUAL_NATIVE_STATUS_MISMATCH").length, 2);
});

test("flags generic or incorrect visual names instead of guessing task identity", async () => {
  const { input } = await fixture();
  input.visualSurfaces[0].entries[0] = { threadId: ID, observedName: "Created task", nameResolution: "generic", observedStatus: "active" };
  const report = await validateDeveloperVisualState(input);
  assert.equal(report.outcome, "failed");
  assert.equal(report.findings[0].code, "VISUAL_NAME_MISMATCH");
});

test("fails closed on unknown fields and capture tampering", async () => {
  const first = await fixture();
  first.input.extra = true;
  await assert.rejects(validateDeveloperVisualState(first.input), (error) => error.code === "INVALID_INPUT");

  const second = await fixture();
  await writeFile(second.capture.imagePath, Buffer.concat([PNG, Buffer.from("tampered")]));
  await assert.rejects(validateDeveloperVisualState(second.input), (error) => error.code === "INVALID_CAPTURE" || error.code === "CAPTURE_DIGEST_MISMATCH");

  const third = await fixture();
  third.input.capture.imagePath = "capture.png";
  await assert.rejects(validateDeveloperVisualState(third.input), (error) => error.code === "INVALID_CAPTURE");
});

test("fails closed on duplicate surfaces, duplicate thread entries, and unsupported states", async () => {
  const { input } = await fixture();
  input.visualSurfaces.push(structuredClone(input.visualSurfaces[0]));
  await assert.rejects(validateDeveloperVisualState(input), (error) => error.code === "INVALID_INPUT");

  const duplicate = await fixture();
  duplicate.input.nativeThreads.push(structuredClone(duplicate.input.nativeThreads[0]));
  await assert.rejects(validateDeveloperVisualState(duplicate.input), (error) => error.code === "INVALID_INPUT");

  const badStatus = await fixture();
  badStatus.input.visualSurfaces[0].entries[0].observedStatus = "busy";
  await assert.rejects(validateDeveloperVisualState(badStatus.input), (error) => error.code === "INVALID_INPUT");
});
