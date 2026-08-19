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

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const DEFAULT_SCREEN_CAPTURE_MAX_BYTES = 25 * 1024 * 1024;
export const MACOS_SCREEN_CAPTURE_TOOL = "/usr/sbin/screencapture";

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
  await execFileAsync(tool, args, { windowsHide: true });
}

async function removeOwnedFile(path) {
  await rm(path, { force: true }).catch(() => {});
}

export async function captureDeveloperScreen({
  outputDirectory,
  display = 1,
  maxBytes = DEFAULT_SCREEN_CAPTURE_MAX_BYTES,
  label = "screen",
  platform = process.platform,
  clock = () => new Date(),
  nonce = () => randomBytes(6).toString("hex"),
  runCapture = defaultRunCapture,
} = {}) {
  if (platform !== "darwin") {
    throw new DeveloperScreenCaptureError("UNSUPPORTED_PLATFORM", "developer screen capture is supported only on macOS");
  }
  const directory = safeOutputDirectory(outputDirectory);
  const selectedDisplay = positiveInteger(display, "display", 32);
  const byteCeiling = positiveInteger(maxBytes, "maxBytes", 1024 * 1024 * 1024);
  const captureLabel = safeLabel(label);
  if (typeof runCapture !== "function") {
    throw new DeveloperScreenCaptureError("INVALID_ARGUMENT", "runCapture must be a function");
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
  const temporaryImagePath = join(directory, `.${stem}.capture.png`);
  const temporaryMetadataPath = join(directory, `.${stem}.metadata.json`);
  let finalImageCreated = false;

  try {
    await runCapture({
      tool: MACOS_SCREEN_CAPTURE_TOOL,
      args: ["-x", "-D", String(selectedDisplay), temporaryImagePath],
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

    const metadata = Object.freeze({
      schemaVersion: 1,
      kind: "nelos-developer-screen-capture",
      capturedAt: capturedAt.toISOString(),
      display: selectedDisplay,
      image: imageName,
      bytes: imageInfo.size,
      digest,
      localOnly: true,
    });
    await writeFile(temporaryMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await link(temporaryMetadataPath, metadataPath);
    await unlink(temporaryMetadataPath);
    return Object.freeze({ ...metadata, imagePath, metadataPath });
  } catch (error) {
    await removeOwnedFile(temporaryImagePath);
    await removeOwnedFile(temporaryMetadataPath);
    if (finalImageCreated) await removeOwnedFile(imagePath);
    if (error instanceof DeveloperScreenCaptureError) throw error;
    throw new DeveloperScreenCaptureError("CAPTURE_FAILED", `screen capture failed: ${error.message}`, { cause: error });
  }
}
