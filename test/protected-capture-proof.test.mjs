import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { encodePngRgba } from "../src/remote-desktop-evidence/index.mjs";
import { assertCapturePrivacyPixelsV1, assertCapturePrivacyRgbaV1, capturePrivacyProofV1 } from "../src/protected-capture-proof.mjs";

const TASK_ID = "01a01ae1-0000-7000-8000-000000000001";
const OTHER_ID = "01a01ae1-0000-7000-8000-000000000002";
const screen = { width: 100, height: 80 };
const protectedRegions = [{ kind: "conversation", x: 40, y: 10, width: 50, height: 60 }];
const region = { kind: "expected-task-title", taskId: TASK_ID, textDigest: `sha256:${"a".repeat(64)}`, x: 2, y: 2, width: 20, height: 5 };
const proof = {
  schemaVersion: 1,
  classificationComplete: true,
  maskedBase: "full-frame-black",
  mode: "expected-task-evidence-only",
  preservedRegions: [region],
  rawPixelsPersisted: false,
  traversal: { complete: true, scannedNodes: 50, maximumNodes: 10_000 },
};

test("full-frame privacy proof permits only the exact expected task evidence", () => {
  assert.deepEqual(capturePrivacyProofV1(proof, {
    screen, protectedRegions, mode: "expected-task-evidence-only", expectedTaskIds: [TASK_ID], requireTitle: true,
  }), [region]);
  for (const altered of [
    { ...proof, rawPixelsPersisted: true },
    { ...proof, classificationComplete: false },
    { ...proof, traversal: { ...proof.traversal, complete: false } },
    { ...proof, preservedRegions: [{ ...region, taskId: OTHER_ID }] },
    { ...proof, preservedRegions: [{ ...region, x: 45, y: 15 }] },
    { ...proof, preservedRegions: [] },
  ]) {
    assert.throws(() => capturePrivacyProofV1(altered, {
      screen, protectedRegions, mode: "expected-task-evidence-only", expectedTaskIds: [TASK_ID], requireTitle: true,
    }), (error) => error.code === "PROTECTED_GEOMETRY_UNAVAILABLE");
  }
});

test("archive privacy proof may expose zero pixels and rejects an unrelated row", () => {
  const archived = { ...proof, mode: "expected-archive-evidence-only", preservedRegions: [] };
  assert.deepEqual(capturePrivacyProofV1(archived, {
    screen, protectedRegions, mode: "expected-archive-evidence-only", expectedTaskIds: [TASK_ID],
  }), []);
  assert.throws(() => capturePrivacyProofV1({ ...archived, preservedRegions: [{ ...region, taskId: OTHER_ID }] }, {
    screen, protectedRegions, mode: "expected-archive-evidence-only", expectedTaskIds: [TASK_ID],
  }), (error) => error.code === "PROTECTED_GEOMETRY_UNAVAILABLE");
});

function pixels(width, height, regions = []) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) rgba[pixel * 4 + 3] = 255;
  for (const [index, region] of regions.entries()) {
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        const offset = (y * width + x) * 4;
        rgba[offset] = 40 + index * 30;
        rgba[offset + 1] = 90 + index * 20;
        rgba[offset + 2] = 180 - index * 20;
      }
    }
  }
  return rgba;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii"); const length = Buffer.alloc(4); const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function filteredPng({ width, height, rgba, filter }) {
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const distances = [Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - upperLeft)];
    return distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? above : upperLeft;
  };
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4); rows[row] = filter;
    for (let x = 0; x < width * 4; x += 1) {
      const source = y * width * 4 + x; const left = x >= 4 ? rgba[source - 4] : 0;
      const above = y > 0 ? rgba[source - width * 4] : 0; const upperLeft = y > 0 && x >= 4 ? rgba[source - width * 4 - 4] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      rows[row + 1 + x] = (rgba[source] - predictor) & 0xff;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("durable PNG pixels are black outside the exact title/status allowlist", () => {
  const pixelScreen = { width: 12, height: 8 };
  const title = { ...region, x: 1, y: 1, width: 3, height: 2 };
  const status = { ...region, kind: "expected-task-status", textDigest: `sha256:${"b".repeat(64)}`, x: 1, y: 5, width: 2, height: 1 };
  const conversation = { kind: "conversation", x: 6, y: 1, width: 5, height: 6 };
  const safe = pixels(pixelScreen.width, pixelScreen.height, [title, status]);
  const encoded = encodePngRgba({ ...pixelScreen, rgba: safe });
  safe.fill(0);
  assert.deepEqual(assertCapturePrivacyPixelsV1(encoded, {
    screen: pixelScreen, preservedRegions: [title, status], protectedRegions: [conversation],
  }), { width: 12, height: 8, opaqueBlackPixelCount: 88, preservedRegionCount: 2 });

  for (const mutation of [
    { x: 0, y: 0, rgba: [255, 1, 2, 255] },
    { x: 7, y: 2, rgba: [1, 255, 2, 255] },
    { x: 11, y: 7, rgba: [0, 0, 0, 0] },
  ]) {
    const altered = pixels(pixelScreen.width, pixelScreen.height, [title, status]);
    const offset = (mutation.y * pixelScreen.width + mutation.x) * 4;
    altered.set(mutation.rgba, offset);
    const png = encodePngRgba({ ...pixelScreen, rgba: altered });
    altered.fill(0);
    assert.throws(() => assertCapturePrivacyPixelsV1(png, {
      screen: pixelScreen, preservedRegions: [title, status], protectedRegions: [conversation],
    }), (error) => error.code === "UNSAFE_CAPTURE");
  }

  const blank = pixels(pixelScreen.width, pixelScreen.height);
  const blankPng = encodePngRgba({ ...pixelScreen, rgba: blank });
  blank.fill(0);
  assert.throws(() => assertCapturePrivacyPixelsV1(blankPng, {
    screen: pixelScreen, preservedRegions: [title, status], protectedRegions: [conversation],
  }), (error) => error.code === "UNSAFE_CAPTURE");
  assert.deepEqual(assertCapturePrivacyPixelsV1(blankPng, {
    screen: pixelScreen, preservedRegions: [], protectedRegions: [conversation], requireSignal: false,
  }), { width: 12, height: 8, opaqueBlackPixelCount: 96, preservedRegionCount: 0 });
});

test("raw RGBA collector boundary enforces the same exact pixel privacy invariant", () => {
  const pixelScreen = { width: 4, height: 2 };
  const title = { ...region, x: 2, y: 0, width: 1, height: 1 };
  const conversation = { kind: "conversation", x: 0, y: 0, width: 2, height: 2 };
  const rgba = pixels(pixelScreen.width, pixelScreen.height, [title]);
  assert.equal(assertCapturePrivacyRgbaV1(rgba, {
    screen: pixelScreen, preservedRegions: [title], protectedRegions: [conversation],
  }).preservedRegionCount, 1);
  rgba[(1 * pixelScreen.width + 3) * 4] = 255;
  assert.throws(() => assertCapturePrivacyRgbaV1(rgba, {
    screen: pixelScreen, preservedRegions: [title], protectedRegions: [conversation],
  }), (error) => error.code === "UNSAFE_CAPTURE");
  rgba.fill(0);
});

test("durable pixel inspection accepts every standard non-interlaced RGBA PNG row filter", () => {
  const pixelScreen = { width: 12, height: 8 };
  const title = { ...region, x: 1, y: 1, width: 3, height: 2 };
  const conversation = { kind: "conversation", x: 6, y: 1, width: 5, height: 6 };
  const rgba = pixels(pixelScreen.width, pixelScreen.height, [title]);
  try {
    for (let filter = 0; filter <= 4; filter += 1) {
      assert.equal(assertCapturePrivacyPixelsV1(filteredPng({ ...pixelScreen, rgba, filter }), {
        screen: pixelScreen, preservedRegions: [title], protectedRegions: [conversation],
      }).preservedRegionCount, 1);
    }
  } finally { rgba.fill(0); }
});

test("PNG inspection bounds cumulative IDAT bytes before concatenation or inflation", () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const oversized = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.alloc(1_024, 0x41)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  assert.throws(() => assertCapturePrivacyPixelsV1(oversized, {
    screen: { width: 1, height: 1 }, preservedRegions: [], protectedRegions: [], requireSignal: false,
  }), (error) => error.code === "UNSAFE_CAPTURE");
});
