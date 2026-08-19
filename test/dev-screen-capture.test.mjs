import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MACOS_SCREEN_CAPTURE_TOOL,
  captureDeveloperScreen,
} from "../src/dev-screen-capture.mjs";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("bounded-test-image"),
]);

async function directory() {
  return mkdtemp(join(tmpdir(), "nelos-screen-capture-"));
}

test("captures one explicit display with a fixed tool and content-addressed local metadata", async () => {
  const root = await directory();
  const outputDirectory = join(root, "evidence");
  let invocation;
  const result = await captureDeveloperScreen({
    outputDirectory,
    display: 2,
    maxBytes: 1024,
    label: "codex-state",
    clock: () => new Date("2026-08-19T17:20:00.000Z"),
    nonce: () => "0123456789ab",
    runCapture: async (value) => {
      invocation = value;
      await writeFile(value.args.at(-1), PNG);
    },
  });

  assert.equal(invocation.tool, MACOS_SCREEN_CAPTURE_TOOL);
  assert.deepEqual(invocation.args.slice(0, 3), ["-x", "-D2", "-tpng"]);
  assert.doesNotMatch(invocation.args.at(-1).split("/").at(-1), /^\./u);
  assert.equal(result.localOnly, true);
  assert.equal(result.image, "codex-state-20260819T172000000Z-0123456789ab.png");
  assert.equal(result.bytes, PNG.length);
  assert.equal(result.digest, `sha256:${createHash("sha256").update(PNG).digest("hex")}`);
  assert.deepEqual(await readFile(result.imagePath), PNG);
  const metadata = JSON.parse(await readFile(result.metadataPath, "utf8"));
  assert.deepEqual(metadata, {
    schemaVersion: 1,
    kind: "nelos-developer-screen-capture",
    capturedAt: "2026-08-19T17:20:00.000Z",
    display: 2,
    image: result.image,
    bytes: PNG.length,
    digest: result.digest,
    localOnly: true,
  });
});

test("rejects unsafe paths, invalid arguments, and non-macOS execution before capture", async () => {
  const root = await directory();
  let calls = 0;
  const runCapture = async () => { calls += 1; };
  for (const options of [
    { outputDirectory: "relative", runCapture },
    { outputDirectory: "/", runCapture },
    { outputDirectory: join(root, "out"), display: 0, runCapture },
    { outputDirectory: join(root, "out"), maxBytes: 0, runCapture },
    { outputDirectory: join(root, "out"), label: "Not Safe", runCapture },
    { outputDirectory: join(root, "out"), platform: "linux", runCapture },
  ]) {
    await assert.rejects(captureDeveloperScreen(options));
  }
  assert.equal(calls, 0);
});

test("rejects a symlink capture directory", async () => {
  const root = await directory();
  const target = join(root, "target");
  await writeFile(target, "not-a-directory");
  const link = join(root, "evidence");
  await symlink(target, link);
  await assert.rejects(
    captureDeveloperScreen({ outputDirectory: link, runCapture: async () => {} }),
    (error) => error.code === "UNSAFE_OUTPUT",
  );
});

test("fails closed and removes owned capture bytes when format or budget validation fails", async () => {
  for (const { bytes, maxBytes, code } of [
    { bytes: Buffer.from("not-png"), maxBytes: 1024, code: "INVALID_CAPTURE" },
    { bytes: PNG, maxBytes: 8, code: "CAPTURE_BUDGET_EXCEEDED" },
  ]) {
    const outputDirectory = join(await directory(), "evidence");
    await assert.rejects(
      captureDeveloperScreen({
        outputDirectory,
        maxBytes,
        nonce: () => "abcdef012345",
        runCapture: async ({ args }) => writeFile(args.at(-1), bytes),
      }),
      (error) => error.code === code,
    );
    assert.deepEqual(await readdir(outputDirectory), []);
  }
});

test("wraps tool failure without leaving an evidence artifact", async () => {
  const outputDirectory = join(await directory(), "evidence");
  await assert.rejects(
    captureDeveloperScreen({
      outputDirectory,
      nonce: () => "abcdef012345",
      runCapture: async () => { throw new Error("permission denied"); },
    }),
    (error) => error.code === "CAPTURE_FAILED" && /permission denied/u.test(error.message),
  );
  assert.deepEqual(await readdir(outputDirectory), []);
});

test("never overwrites an existing capture when a generated name collides", async () => {
  const outputDirectory = join(await directory(), "evidence");
  await mkdir(outputDirectory);
  const existingPath = join(outputDirectory, "screen-20260819T172000000Z-0123456789ab.png");
  await writeFile(existingPath, "existing-evidence");
  await assert.rejects(
    captureDeveloperScreen({
      outputDirectory,
      clock: () => new Date("2026-08-19T17:20:00.000Z"),
      nonce: () => "0123456789ab",
      runCapture: async ({ args }) => writeFile(args.at(-1), PNG),
    }),
    (error) => error.code === "CAPTURE_FAILED" && /EEXIST/u.test(error.message),
  );
  assert.equal(await readFile(existingPath, "utf8"), "existing-evidence");
  assert.deepEqual(await readdir(outputDirectory), ["screen-20260819T172000000Z-0123456789ab.png"]);
});
