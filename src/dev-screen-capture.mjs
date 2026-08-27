import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const DEFAULT_SCREEN_CAPTURE_MAX_BYTES = 25 * 1024 * 1024;
export const MACOS_SCREEN_CAPTURE_TOOL = "/usr/sbin/screencapture";
export const MACOS_SWIFT_TOOL = "/usr/bin/swift";
export const MACOS_WINDOW_CATALOG_HELPER = fileURLToPath(new URL("./macos-window-catalog.swift", import.meta.url));

const BUNDLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u;
const WINDOW_KEYS = ["bounds", "bundleId", "isOnScreen", "layer", "ownerName", "ownerPid", "sharingState", "title", "titleAvailable", "windowId"];
const BOUNDS_KEYS = ["height", "width", "x", "y"];

export class DeveloperScreenCaptureError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DeveloperScreenCaptureError";
    this.code = code;
  }
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new DeveloperScreenCaptureError("INVALID_ARGUMENT", `${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", `${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", `${name} has an unexpected shape`);
  }
}

function safeBundleIdentifier(value) {
  if (typeof value !== "string" || value.length > 255 || !BUNDLE_IDENTIFIER.test(value)) {
    throw new DeveloperScreenCaptureError("INVALID_ARGUMENT", "appBundleId must be a bounded reverse-DNS identifier");
  }
  return value;
}

function safeWindowTitle(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DeveloperScreenCaptureError("INVALID_ARGUMENT", "windowTitle must be an exact bounded title without control characters");
  }
  return value;
}

function boundedCatalogString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > 512 || (!allowEmpty && value.length === 0) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", `${name} is invalid`);
  }
  return value;
}

function boundedCoordinate(value, name, { positive = false } = {}) {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000 || (positive && value <= 0)) {
    throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", `${name} is outside the supported geometry`);
  }
  return value;
}

function catalogWindowId(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", `${name} is invalid`);
  }
  return value;
}

function parseWindowCatalog(value, appBundleId) {
  exactObject(value, ["kind", "schemaVersion", "windows"], "window catalog");
  if (value.schemaVersion !== 1 || value.kind !== "nelos-macos-window-catalog" || !Array.isArray(value.windows) || value.windows.length > 256) {
    throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", "window catalog header or entry count is invalid");
  }
  const identifiers = new Set();
  return value.windows.map((entry, index) => {
    exactObject(entry, WINDOW_KEYS, `window catalog entry ${index}`);
    exactObject(entry.bounds, BOUNDS_KEYS, `window catalog entry ${index} bounds`);
    const windowId = catalogWindowId(entry.windowId, `window catalog entry ${index} windowId`);
    if (identifiers.has(windowId)) {
      throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", "window catalog contains a duplicate window identifier");
    }
    identifiers.add(windowId);
    if (entry.bundleId !== appBundleId || !BUNDLE_IDENTIFIER.test(entry.bundleId)) {
      throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", "window catalog escaped the requested application selector");
    }
    if (!Number.isSafeInteger(entry.ownerPid) || entry.ownerPid < 1 || entry.ownerPid > 0x7fff_ffff ||
        !Number.isSafeInteger(entry.layer) || Math.abs(entry.layer) > 10_000 ||
        !Number.isSafeInteger(entry.sharingState) || entry.sharingState < 0 || entry.sharingState > 2 ||
        typeof entry.isOnScreen !== "boolean" || typeof entry.titleAvailable !== "boolean") {
      throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", `window catalog entry ${index} has invalid process or capture state`);
    }
    return Object.freeze({
      bundleId: entry.bundleId,
      windowId,
      ownerPid: entry.ownerPid,
      ownerName: boundedCatalogString(entry.ownerName, `window catalog entry ${index} ownerName`),
      title: boundedCatalogString(entry.title, `window catalog entry ${index} title`, { allowEmpty: true }),
      titleAvailable: entry.titleAvailable,
      layer: entry.layer,
      isOnScreen: entry.isOnScreen,
      sharingState: entry.sharingState,
      bounds: Object.freeze({
        x: boundedCoordinate(entry.bounds.x, `window catalog entry ${index} bounds.x`),
        y: boundedCoordinate(entry.bounds.y, `window catalog entry ${index} bounds.y`),
        width: boundedCoordinate(entry.bounds.width, `window catalog entry ${index} bounds.width`, { positive: true }),
        height: boundedCoordinate(entry.bounds.height, `window catalog entry ${index} bounds.height`, { positive: true }),
      }),
    });
  });
}

function safeLabel(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(value)) {
    throw new DeveloperScreenCaptureError("INVALID_ARGUMENT", "label must be a lowercase slug of at most 48 characters");
  }
  return value;
}

function safeOutputDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new DeveloperScreenCaptureError("UNSAFE_OUTPUT", "output directory must be absolute");
  }
  const normalized = resolve(value);
  if (normalized === parse(normalized).root) {
    throw new DeveloperScreenCaptureError("UNSAFE_OUTPUT", "filesystem roots cannot be capture directories");
  }
  return normalized;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DeveloperScreenCaptureError("INVALID_CLOCK", "capture clock returned an invalid date");
  }
  return date.toISOString().replace(/[-:.]/gu, "");
}

async function defaultRunCapture({ tool, args }) {
  await execFileAsync(tool, args, { timeout: 15_000, windowsHide: true });
}

async function defaultListWindows({ tool, args }) {
  const { stdout } = await execFileAsync(tool, args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024,
    timeout: 15_000,
    windowsHide: true,
  });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new DeveloperScreenCaptureError("INVALID_WINDOW_CATALOG", "native window catalog did not return JSON", { cause: error });
  }
}

function selectWindow(catalog, { appBundleId, windowId, windowTitle }) {
  let candidates = parseWindowCatalog(catalog, appBundleId)
    .filter((entry) => entry.layer === 0 && entry.sharingState > 0);
  if (windowId !== undefined) candidates = candidates.filter((entry) => entry.windowId === windowId);
  if (windowTitle !== undefined && candidates.length > 0 && candidates.every((entry) => !entry.titleAvailable)) {
    throw new DeveloperScreenCaptureError("SCREEN_RECORDING_PERMISSION_REQUIRED", "window titles are unavailable; grant Screen Recording permission");
  }
  if (windowTitle !== undefined) candidates = candidates.filter((entry) => entry.title === windowTitle);
  if (candidates.length === 0) {
    throw new DeveloperScreenCaptureError("WINDOW_NOT_FOUND", "no capturable window matched the exact application/window selector");
  }
  if (candidates.length !== 1) {
    throw new DeveloperScreenCaptureError("WINDOW_AMBIGUOUS", `application selector matched ${candidates.length} capturable windows; specify --window-id`);
  }
  return candidates[0];
}

async function removeOwnedFile(path) {
  await rm(path, { force: true }).catch(() => {});
}

export async function captureDeveloperScreen({
  outputDirectory,
  display,
  appBundleId,
  windowId,
  windowTitle,
  protectedRegions,
  maxBytes = DEFAULT_SCREEN_CAPTURE_MAX_BYTES,
  label = "screen",
  platform = process.platform,
  clock = () => new Date(),
  nonce = () => randomBytes(6).toString("hex"),
  runCapture = defaultRunCapture,
  listWindows = defaultListWindows,
} = {}) {
  if (platform !== "darwin") {
    throw new DeveloperScreenCaptureError("UNSUPPORTED_PLATFORM", "developer screen capture is supported only on macOS");
  }
  const directory = safeOutputDirectory(outputDirectory);
  const byteCeiling = positiveInteger(maxBytes, "maxBytes", 1024 * 1024 * 1024);
  const captureLabel = safeLabel(label);
  if (protectedRegions !== undefined) {
    throw new DeveloperScreenCaptureError("UNSUPPORTED_PROTECTION", "developer capture cannot guarantee protected-region masking; use the remote evidence lane");
  }
  const windowMode = appBundleId !== undefined || windowId !== undefined || windowTitle !== undefined;
  if (windowMode && display !== undefined) {
    throw new DeveloperScreenCaptureError("INVALID_ARGUMENT", "display and app-window selectors are mutually exclusive");
  }
  const selectedDisplay = windowMode ? undefined : positiveInteger(display ?? 1, "display", 32);
  const selectedBundleId = windowMode ? safeBundleIdentifier(appBundleId) : undefined;
  const selectedWindowId = windowId === undefined ? undefined : positiveInteger(windowId, "windowId", 0xffff_ffff);
  const selectedWindowTitle = safeWindowTitle(windowTitle);
  if (typeof runCapture !== "function") {
    throw new DeveloperScreenCaptureError("INVALID_ARGUMENT", "runCapture must be a function");
  }
  if (windowMode && typeof listWindows !== "function") {
    throw new DeveloperScreenCaptureError("INVALID_ARGUMENT", "listWindows must be a function");
  }

  let selectedWindow;
  if (windowMode) {
    let catalog;
    try {
      catalog = await listWindows({
        tool: MACOS_SWIFT_TOOL,
        args: [MACOS_WINDOW_CATALOG_HELPER, "--bundle-id", selectedBundleId],
      });
    } catch (error) {
      if (error instanceof DeveloperScreenCaptureError) throw error;
      throw new DeveloperScreenCaptureError("WINDOW_ENUMERATION_FAILED", `could not enumerate application windows: ${error.message}`, { cause: error });
    }
    selectedWindow = selectWindow(catalog, {
      appBundleId: selectedBundleId,
      windowId: selectedWindowId,
      windowTitle: selectedWindowTitle,
    });
  }

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new DeveloperScreenCaptureError("UNSAFE_OUTPUT", "capture directory must be a real directory, not a symlink");
  }

  const id = nonce();
  if (typeof id !== "string" || !/^[a-f0-9]{8,32}$/u.test(id)) {
    throw new DeveloperScreenCaptureError("INVALID_NONCE", "capture nonce must be 8 to 32 lowercase hexadecimal characters");
  }
  const capturedAt = new Date(clock());
  const stem = `${captureLabel}-${timestamp(capturedAt)}-${id}`;
  const imageName = `${stem}.png`;
  const metadataName = `${stem}.json`;
  const imagePath = join(directory, imageName);
  const metadataPath = join(directory, metadataName);
  // macOS screencapture returns success without an image for dot-prefixed destinations.
  const temporaryImagePath = join(directory, `${stem}.capture-partial.png`);
  const temporaryMetadataPath = join(directory, `.${stem}.metadata.json`);
  let finalImageCreated = false;
  let finalMetadataCreated = false;

  try {
    await runCapture({
      tool: MACOS_SCREEN_CAPTURE_TOOL,
      args: selectedWindow
        ? ["-x", "-o", `-l${selectedWindow.windowId}`, "-tpng", temporaryImagePath]
        : ["-x", `-D${selectedDisplay}`, "-tpng", temporaryImagePath],
    });
    const imageInfo = await lstat(temporaryImagePath);
    if (!imageInfo.isFile() || imageInfo.isSymbolicLink() || imageInfo.size < PNG_SIGNATURE.length) {
      throw new DeveloperScreenCaptureError("INVALID_CAPTURE", "screen capture did not produce a regular PNG file");
    }
    if (imageInfo.size > byteCeiling) {
      throw new DeveloperScreenCaptureError("CAPTURE_BUDGET_EXCEEDED", `capture exceeded the ${byteCeiling}-byte ceiling`);
    }
    const image = await readFile(temporaryImagePath);
    if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new DeveloperScreenCaptureError("INVALID_CAPTURE", "screen capture output does not have a PNG signature");
    }
    const digest = `sha256:${createHash("sha256").update(image).digest("hex")}`;
    await chmod(temporaryImagePath, 0o600);
    await link(temporaryImagePath, imagePath);
    finalImageCreated = true;
    await unlink(temporaryImagePath);

    const source = selectedWindow
      ? Object.freeze({
        mode: "window",
        appBundleId: selectedWindow.bundleId,
        windowId: selectedWindow.windowId,
        ownerPid: selectedWindow.ownerPid,
        ownerName: selectedWindow.ownerName,
        windowTitleDigest: `sha256:${createHash("sha256").update(selectedWindow.title).digest("hex")}`,
        bounds: selectedWindow.bounds,
        onScreen: selectedWindow.isOnScreen,
      })
      : selectedDisplay;
    const metadata = Object.freeze({
      schemaVersion: 1,
      kind: "nelos-developer-screen-capture",
      capturedAt: capturedAt.toISOString(),
      display: source,
      image: imageName,
      bytes: image.length,
      digest,
      localOnly: true,
    });
    await writeFile(temporaryMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await link(temporaryMetadataPath, metadataPath);
    finalMetadataCreated = true;
    await unlink(temporaryMetadataPath);
    return Object.freeze({ ...metadata, imagePath, metadataPath });
  } catch (error) {
    await removeOwnedFile(temporaryImagePath);
    await removeOwnedFile(temporaryMetadataPath);
    if (finalImageCreated) await removeOwnedFile(imagePath);
    if (finalMetadataCreated) await removeOwnedFile(metadataPath);
    if (error instanceof DeveloperScreenCaptureError) throw error;
    throw new DeveloperScreenCaptureError("CAPTURE_FAILED", `screen capture failed: ${error.message}`, { cause: error });
  }
}
