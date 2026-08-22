import { decodePngRgba } from "./remote-desktop-evidence/index.mjs";

const PROOF_FIELDS = ["conversation", "credentialInventory", "schemaVersion", "traversal"];
const REGION_FIELDS = ["height", "kind", "width", "x", "y"];
const CREDENTIAL_INVENTORY_FIELDS = ["complete", "count", "regions"];
const TRAVERSAL_FIELDS = ["complete", "maximumNodes", "scannedNodes"];
const PRIVACY_PROOF_FIELDS = ["classificationComplete", "maskedBase", "mode", "preservedRegions", "rawPixelsPersisted", "schemaVersion", "traversal"];
const PRIVACY_REGION_FIELDS = ["height", "kind", "taskId", "textDigest", "width", "x", "y"];
const PRIVACY_MODES = new Set(["expected-task-evidence-only", "expected-archive-evidence-only"]);
const PRIVACY_REGION_KINDS = new Set(["expected-task-status", "expected-task-title"]);
const TASK_ID = /^[a-f0-9-]{8,80}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export const PROTECTED_CAPTURE_MAXIMUM_NODES_V1 = 10_000;

export class ProtectedCaptureProofError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtectedCaptureProofError";
    this.code = "PROTECTED_GEOMETRY_UNAVAILABLE";
  }
}

export class ProtectedCapturePixelError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtectedCapturePixelError";
    this.code = "UNSAFE_CAPTURE";
  }
}

function assertCapturePrivacyRgbaShape(rgba, screen) {
  if (!Buffer.isBuffer(rgba) ||
      !Number.isSafeInteger(screen?.width) || !Number.isSafeInteger(screen?.height) ||
      screen.width < 1 || screen.height < 1 || screen.width > 7_680 || screen.height > 4_320 ||
      rgba.length !== screen.width * screen.height * 4) {
    throw new ProtectedCapturePixelError("capture pixels lack bounded RGBA dimensions");
  }
}

function exactFields(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validRegion(value, kind, screen) {
  if (!exactFields(value, REGION_FIELDS) || value.kind !== kind ||
      ![value.x, value.y, value.width, value.height].every(Number.isSafeInteger) ||
      value.x < 0 || value.y < 0 || value.width < 1 || value.height < 1) return false;
  return screen === null || (
    Number.isSafeInteger(screen?.width) && Number.isSafeInteger(screen?.height) &&
    screen.width > 0 && screen.height > 0 &&
    value.x + value.width <= screen.width && value.y + value.height <= screen.height
  );
}

export function protectedCaptureRegionsV1(proof, { screen = null } = {}) {
  if (!exactFields(proof, PROOF_FIELDS) || proof.schemaVersion !== 1 ||
      !validRegion(proof.conversation, "conversation", screen) ||
      !exactFields(proof.credentialInventory, CREDENTIAL_INVENTORY_FIELDS) ||
      proof.credentialInventory.complete !== true ||
      !Number.isSafeInteger(proof.credentialInventory.count) ||
      proof.credentialInventory.count < 0 || proof.credentialInventory.count > 1_000 ||
      !Array.isArray(proof.credentialInventory.regions) ||
      proof.credentialInventory.regions.length !== proof.credentialInventory.count ||
      proof.credentialInventory.regions.some((region) => !validRegion(region, "credential", screen)) ||
      !exactFields(proof.traversal, TRAVERSAL_FIELDS) ||
      proof.traversal.complete !== true ||
      proof.traversal.maximumNodes !== PROTECTED_CAPTURE_MAXIMUM_NODES_V1 ||
      !Number.isSafeInteger(proof.traversal.scannedNodes) ||
      proof.traversal.scannedNodes < 1 || proof.traversal.scannedNodes > proof.traversal.maximumNodes) {
    throw new ProtectedCaptureProofError("protected capture requires complete bounded traversal, conversation geometry, and a complete credential inventory");
  }
  const regions = [proof.conversation, ...proof.credentialInventory.regions].map((region) => ({ ...region }));
  const identities = regions.map(({ x, y, width, height }) => `${x}:${y}:${width}:${height}`);
  if (new Set(identities).size !== identities.length) {
    throw new ProtectedCaptureProofError("protected capture geometry contains duplicate regions");
  }
  return Object.freeze(regions.map((region) => Object.freeze(region)));
}

function overlaps(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y;
}

/**
 * Validate the stronger production screenshot boundary. The guest starts with
 * a fully black frame and restores only these exact AT-SPI-classified regions;
 * this is deliberately separate from ordinary exclusion-region screenshots.
 */
export function capturePrivacyProofV1(proof, {
  screen,
  protectedRegions,
  mode,
  expectedTaskIds,
  requireTitle = false,
} = {}) {
  if (!exactFields(proof, PRIVACY_PROOF_FIELDS) || proof.schemaVersion !== 1 ||
      proof.classificationComplete !== true || proof.maskedBase !== "full-frame-black" ||
      proof.rawPixelsPersisted !== false || !PRIVACY_MODES.has(proof.mode) || proof.mode !== mode ||
      !exactFields(proof.traversal, TRAVERSAL_FIELDS) || proof.traversal.complete !== true ||
      proof.traversal.maximumNodes !== PROTECTED_CAPTURE_MAXIMUM_NODES_V1 ||
      !Number.isSafeInteger(proof.traversal.scannedNodes) || proof.traversal.scannedNodes < 1 ||
      proof.traversal.scannedNodes > proof.traversal.maximumNodes ||
      !Array.isArray(proof.preservedRegions) || proof.preservedRegions.length > 200 ||
      !Array.isArray(expectedTaskIds) || expectedTaskIds.length < 1 || expectedTaskIds.length > 100 ||
      new Set(expectedTaskIds).size !== expectedTaskIds.length || expectedTaskIds.some((id) => !TASK_ID.test(id ?? ""))) {
    throw new ProtectedCaptureProofError("capture privacy proof is not closed, complete, or identity bounded");
  }
  const expected = new Set(expectedTaskIds);
  if (!Number.isSafeInteger(screen?.width) || !Number.isSafeInteger(screen?.height) || screen.width < 1 || screen.height < 1 ||
      !Array.isArray(protectedRegions) || protectedRegions.some((region) => !["conversation", "credential"].includes(region?.kind) || !validRegion(region, region.kind, screen))) {
    throw new ProtectedCaptureProofError("capture privacy proof lacks bounded screen or protected geometry");
  }
  const regions = proof.preservedRegions.map((region) => {
    if (!exactFields(region, PRIVACY_REGION_FIELDS) || !PRIVACY_REGION_KINDS.has(region.kind) ||
        !expected.has(region.taskId) || !SHA256.test(region.textDigest ?? "") ||
        ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
        region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
        region.x + region.width > screen.width || region.y + region.height > screen.height ||
        protectedRegions.some((protectedRegion) => overlaps(region, protectedRegion))) {
      throw new ProtectedCaptureProofError("capture privacy allowlist contains unsafe or unrelated pixels");
    }
    return { ...region };
  });
  const identities = regions.map(({ x, y, width, height }) => `${x}:${y}:${width}:${height}`);
  if (new Set(identities).size !== identities.length || regions.some((region, index) => regions.slice(index + 1).some((other) => overlaps(region, other)))) {
    throw new ProtectedCaptureProofError("capture privacy allowlist contains duplicate or overlapping geometry");
  }
  if (expectedTaskIds.some((taskId) => regions.filter((region) => region.taskId === taskId && region.kind === "expected-task-title").length > 1 ||
      regions.filter((region) => region.taskId === taskId && region.kind === "expected-task-status").length > 1)) {
    throw new ProtectedCaptureProofError("capture privacy allowlist contains more than one title or status region for a task");
  }
  if (requireTitle && expectedTaskIds.some((taskId) => regions.filter((region) => region.taskId === taskId && region.kind === "expected-task-title").length !== 1)) {
    throw new ProtectedCaptureProofError("capture privacy proof lacks one exact expected task-title region");
  }
  return Object.freeze(regions.map((region) => Object.freeze(region)));
}

/**
 * Independently inspect the durable PNG bytes after the metadata/geometry proof
 * has been accepted. Every pixel outside the non-overlapping allowlist must be
 * opaque black, including every protected conversation/credential rectangle.
 * Each retained rectangle must contain at least one visible non-black pixel so
 * an all-black frame cannot masquerade as useful title/status evidence.
 */
export function assertCapturePrivacyRgbaV1(rgba, {
  screen,
  preservedRegions,
  protectedRegions,
  requireSignal = true,
} = {}) {
  assertCapturePrivacyRgbaShape(rgba, screen);
  if (!Array.isArray(preservedRegions) || preservedRegions.length > 200 ||
      !Array.isArray(protectedRegions) || protectedRegions.length > 1_001 ||
      typeof requireSignal !== "boolean") {
    throw new ProtectedCapturePixelError("capture pixels lack a bounded image and allowlist");
  }
  const geometry = (region) => region &&
    [region.x, region.y, region.width, region.height].every(Number.isSafeInteger) &&
    region.x >= 0 && region.y >= 0 && region.width >= 1 && region.height >= 1 &&
    region.x + region.width <= screen.width && region.y + region.height <= screen.height;
  if (preservedRegions.some((region) => !geometry(region)) || protectedRegions.some((region) => !geometry(region)) ||
      preservedRegions.some((region, index) => preservedRegions.slice(index + 1).some((other) => overlaps(region, other))) ||
      preservedRegions.some((region) => protectedRegions.some((protectedRegion) => overlaps(region, protectedRegion)))) {
    throw new ProtectedCapturePixelError("capture pixel geometry is unsafe or overlapping");
  }

  const ownership = new Uint16Array(screen.width * screen.height);
  const signals = new Array(preservedRegions.length).fill(false);
  try {
    for (const [index, region] of preservedRegions.entries()) {
      for (let y = region.y; y < region.y + region.height; y += 1) {
        ownership.fill(index + 1, y * screen.width + region.x, y * screen.width + region.x + region.width);
      }
    }
    for (let pixel = 0; pixel < ownership.length; pixel += 1) {
      const offset = pixel * 4;
      const opaqueBlack = rgba[offset] === 0 && rgba[offset + 1] === 0 &&
        rgba[offset + 2] === 0 && rgba[offset + 3] === 255;
      if (ownership[pixel] === 0 && !opaqueBlack) {
        throw new ProtectedCapturePixelError("capture exposes a pixel outside the exact allowlist");
      }
      if (ownership[pixel] !== 0) {
        if (rgba[offset + 3] !== 255) throw new ProtectedCapturePixelError("capture retains non-opaque pixel data");
        if (!opaqueBlack) signals[ownership[pixel] - 1] = true;
      }
    }
    if (requireSignal && signals.some((value) => value !== true)) {
      throw new ProtectedCapturePixelError("capture contains no visible evidence in an allowlisted rectangle");
    }
    return Object.freeze({
      width: screen.width,
      height: screen.height,
      opaqueBlackPixelCount: ownership.reduce((count, owner) => count + (owner === 0 ? 1 : 0), 0),
      preservedRegionCount: preservedRegions.length,
    });
  } finally {
    ownership.fill(0);
  }
}

export function assertCapturePrivacyPixelsV1(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) {
    throw new ProtectedCapturePixelError("capture PNG is missing");
  }
  let decoded;
  try { decoded = decodePngRgba(bytes); }
  catch { throw new ProtectedCapturePixelError("capture PNG cannot be decoded as bounded RGBA pixels"); }
  try {
    if (decoded.width !== options?.screen?.width || decoded.height !== options?.screen?.height) {
      throw new ProtectedCapturePixelError("capture PNG dimensions differ from the privacy proof");
    }
    return assertCapturePrivacyRgbaV1(decoded.rgba, options);
  } finally {
    decoded.rgba.fill(0);
  }
}
