import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MACOS_SCREEN_CAPTURE_TOOL,
  MACOS_SWIFT_TOOL,
  MACOS_WINDOW_CATALOG_HELPER,
  captureDeveloperScreen,
} from "../src/dev-screen-capture.mjs";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("bounded-test-image"),
]);

async function directory() {
  return mkdtemp(join(tmpdir(), "nelos-screen-capture-"));
}

function windowRecord(overrides = {}) {
  return {
    bounds: { x: 40, y: 20, width: 1280, height: 800 },
    bundleId: "com.openai.codex",
    isOnScreen: false,
    layer: 0,
    ownerName: "ChatGPT",
    ownerPid: 4242,
    sharingState: 1,
    title: "ChatGPT",
    windowId: 4318,
    ...overrides,
  };
}

function windowCatalog(windows) {
  return { schemaVersion: 1, kind: "nelos-macos-window-catalog", windows };
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

test("captures one exact app window with fixed native tools and selector-bound provenance", async () => {
  const outputDirectory = join(await directory(), "evidence");
  let catalogInvocation;
  let captureInvocation;
  const result = await captureDeveloperScreen({
    outputDirectory,
    appBundleId: "com.openai.codex",
    windowId: 4318,
    maxBytes: 1024,
    label: "codex-window",
    clock: () => new Date("2026-08-20T12:30:00.000Z"),
    nonce: () => "112233445566",
    listWindows: async (value) => {
      catalogInvocation = value;
      return windowCatalog([windowRecord()]);
    },
    runCapture: async (value) => {
      captureInvocation = value;
      await writeFile(value.args.at(-1), PNG);
    },
  });

  assert.deepEqual(catalogInvocation, {
    tool: MACOS_SWIFT_TOOL,
    args: [MACOS_WINDOW_CATALOG_HELPER, "--bundle-id", "com.openai.codex"],
  });
  assert.equal(captureInvocation.tool, MACOS_SCREEN_CAPTURE_TOOL);
  assert.deepEqual(captureInvocation.args.slice(0, 4), ["-x", "-o", "-l4318", "-tpng"]);
  assert.equal(result.digest, `sha256:${createHash("sha256").update(PNG).digest("hex")}`);
  assert.deepEqual(result.display, {
    mode: "window",
    appBundleId: "com.openai.codex",
    windowId: 4318,
    ownerPid: 4242,
    ownerName: "ChatGPT",
    windowTitleDigest: `sha256:${createHash("sha256").update("ChatGPT").digest("hex")}`,
    bounds: { x: 40, y: 20, width: 1280, height: 800 },
    onScreen: false,
  });
  const metadata = JSON.parse(await readFile(result.metadataPath, "utf8"));
  assert.deepEqual(Object.keys(metadata).sort(), ["bytes", "capturedAt", "digest", "display", "image", "kind", "localOnly", "schemaVersion"]);
  assert.deepEqual(metadata.display, result.display);
});

test("fails closed on zero or ambiguous app matches until an exact window is selected", async () => {
  for (const { windows, code } of [
    { windows: [], code: "WINDOW_NOT_FOUND" },
    { windows: [windowRecord(), windowRecord({ windowId: 4319, title: "Settings" })], code: "WINDOW_AMBIGUOUS" },
  ]) {
    let captureCalls = 0;
    await assert.rejects(
      captureDeveloperScreen({
        outputDirectory: join(await directory(), "evidence"),
        appBundleId: "com.openai.codex",
        listWindows: async () => windowCatalog(windows),
        runCapture: async () => { captureCalls += 1; },
      }),
      (error) => error.code === code,
    );
    assert.equal(captureCalls, 0);
  }
});

test("an exact title can select one window without exposing that title in metadata", async () => {
  const outputDirectory = join(await directory(), "evidence");
  const result = await captureDeveloperScreen({
    outputDirectory,
    appBundleId: "com.openai.codex",
    windowTitle: "Settings",
    listWindows: async () => windowCatalog([
      windowRecord(),
      windowRecord({ windowId: 4319, title: "Settings", isOnScreen: true }),
    ]),
    runCapture: async ({ args }) => writeFile(args.at(-1), PNG),
  });
  assert.equal(result.display.windowId, 4319);
  assert.equal(result.display.onScreen, true);
  assert.equal(JSON.stringify(result).includes("Settings"), false);
});

test("rejects escaped or malformed native catalogs before invoking screencapture", async () => {
  for (const catalog of [
    windowCatalog([windowRecord({ bundleId: "com.example.other" })]),
    windowCatalog([windowRecord(), windowRecord()]),
    windowCatalog([windowRecord({ sharingState: 7 })]),
    { schemaVersion: 1, kind: "nelos-macos-window-catalog", windows: [], extra: true },
  ]) {
    let captureCalls = 0;
    await assert.rejects(
      captureDeveloperScreen({
        outputDirectory: join(await directory(), "evidence"),
        appBundleId: "com.openai.codex",
        windowId: 4318,
        listWindows: async () => catalog,
        runCapture: async () => { captureCalls += 1; },
      }),
      (error) => error.code === "INVALID_WINDOW_CATALOG",
    );
    assert.equal(captureCalls, 0);
  }
});

test("rejects protection requests before enumeration because local app-window capture cannot mask safely", async () => {
  let catalogCalls = 0;
  let captureCalls = 0;
  await assert.rejects(
    captureDeveloperScreen({
      outputDirectory: join(await directory(), "evidence"),
      appBundleId: "com.openai.codex",
      protectedRegions: "0,0,100,100",
      listWindows: async () => { catalogCalls += 1; },
      runCapture: async () => { captureCalls += 1; },
    }),
    (error) => error.code === "UNSUPPORTED_PROTECTION",
  );
  assert.equal(catalogCalls, 0);
  assert.equal(captureCalls, 0);
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
    { outputDirectory: join(root, "out"), display: 1, appBundleId: "com.openai.codex", runCapture },
    { outputDirectory: join(root, "out"), appBundleId: "not-a-bundle", runCapture },
    { outputDirectory: join(root, "out"), windowId: 4318, runCapture },
    { outputDirectory: join(root, "out"), appBundleId: "com.openai.codex", windowTitle: "bad\ntitle", runCapture },
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
