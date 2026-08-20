import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const CAPTURE_KEYS = ["bytes", "capturedAt", "digest", "display", "image", "kind", "localOnly", "schemaVersion"];
const INPUT_KEYS = ["capture", "nelosThreads", "nativeThreads", "schemaVersion", "visualSurfaces"];
const CAPTURE_REF_KEYS = ["imagePath", "metadataPath"];
const SURFACE_KEYS = ["entries", "surface"];
const VISUAL_KEYS = ["nameResolution", "observedName", "observedStatus", "threadId"];
const THREAD_KEYS = ["status", "threadId", "title"];
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const THREAD_ID = /^[a-f0-9-]{8,80}$/u;
const SURFACES = new Set(["sidebar", "createdTasks", "mcpVisual", "taskBody"]);
const NAME_RESOLUTIONS = new Set(["exact", "truncated", "generic"]);
const STATUS_PHASE = new Map([
  ["active", "active"], ["running", "active"], ["starting", "active"],
  ["planning", "active"], ["inProgress", "active"],
  ["done", "terminal"], ["completed", "terminal"], ["accepted", "terminal"],
  ["archived", "terminal"], ["succeeded", "terminal"],
  ["inactive", "inactive"], ["idle", "inactive"], ["notLoaded", "inactive"], ["planned", "inactive"],
  ["queued", "inactive"], ["unknown", "unknown"], ["systemError", "error"],
]);

export class DeveloperVisualStateValidationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DeveloperVisualStateValidationError";
    this.code = code;
  }
}

function assertExactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeveloperVisualStateValidationError("INVALID_INPUT", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DeveloperVisualStateValidationError("INVALID_INPUT", `${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function boundedString(value, label, maximum = 240) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new DeveloperVisualStateValidationError("INVALID_INPUT", `${label} must be a non-empty bounded string`);
  }
  return value;
}

function status(value, label) {
  if (!STATUS_PHASE.has(value)) {
    throw new DeveloperVisualStateValidationError("INVALID_INPUT", `${label} has an unsupported status`);
  }
  return value;
}

function threadId(value, label) {
  if (typeof value !== "string" || !THREAD_ID.test(value)) {
    throw new DeveloperVisualStateValidationError("INVALID_INPUT", `${label} must be a bounded thread identifier`);
  }
  return value;
}

function parseThreads(values, label) {
  if (!Array.isArray(values) || values.length > 500) {
    throw new DeveloperVisualStateValidationError("INVALID_INPUT", `${label} must be an array of at most 500 entries`);
  }
  const ids = new Set();
  return values.map((value, index) => {
    assertExactObject(value, THREAD_KEYS, `${label}[${index}]`);
    const id = threadId(value.threadId, `${label}[${index}].threadId`);
    if (ids.has(id)) throw new DeveloperVisualStateValidationError("INVALID_INPUT", `${label} contains duplicate thread ${id}`);
    ids.add(id);
    return { threadId: id, title: boundedString(value.title, `${label}[${index}].title`), status: status(value.status, `${label}[${index}].status`) };
  });
}

function normalizedVisibleName(value) {
  return value.replace(/[.\s]*…$/u, "").trim();
}

function finding(code, threadIdValue, details) {
  return { code, threadId: threadIdValue, ...details };
}

async function verifyCapture(capture) {
  assertExactObject(capture, CAPTURE_REF_KEYS, "capture");
  const suppliedImagePath = boundedString(capture.imagePath, "capture.imagePath", 4096);
  const suppliedMetadataPath = boundedString(capture.metadataPath, "capture.metadataPath", 4096);
  if (!isAbsolute(suppliedImagePath) || !isAbsolute(suppliedMetadataPath)) {
    throw new DeveloperVisualStateValidationError("INVALID_CAPTURE", "capture paths must be absolute");
  }
  const imagePath = resolve(suppliedImagePath);
  const metadataPath = resolve(suppliedMetadataPath);
  const [imageInfo, metadataInfo] = await Promise.all([lstat(imagePath), lstat(metadataPath)]);
  if (!imageInfo.isFile() || imageInfo.isSymbolicLink() || !metadataInfo.isFile() || metadataInfo.isSymbolicLink()) {
    throw new DeveloperVisualStateValidationError("INVALID_CAPTURE", "capture image and metadata must be regular non-symlink files");
  }
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  assertExactObject(metadata, CAPTURE_KEYS, "capture metadata");
  if (metadata.schemaVersion !== 1 || metadata.kind !== "nelos-developer-screen-capture" || metadata.localOnly !== true ||
      !Number.isSafeInteger(metadata.bytes) || metadata.bytes !== imageInfo.size || !DIGEST.test(metadata.digest) ||
      dirname(imagePath) !== dirname(metadataPath) || basename(imagePath) !== metadata.image) {
    throw new DeveloperVisualStateValidationError("INVALID_CAPTURE", "capture metadata does not bind the supplied image");
  }
  const image = await readFile(imagePath);
  const digest = `sha256:${createHash("sha256").update(image).digest("hex")}`;
  if (digest !== metadata.digest) throw new DeveloperVisualStateValidationError("CAPTURE_DIGEST_MISMATCH", "capture image digest does not match metadata");
  return { digest, capturedAt: metadata.capturedAt, display: metadata.display };
}

export async function validateDeveloperVisualState(input) {
  assertExactObject(input, INPUT_KEYS, "input");
  if (input.schemaVersion !== 1) throw new DeveloperVisualStateValidationError("INVALID_INPUT", "schemaVersion must be 1");
  const capture = await verifyCapture(input.capture);
  const nativeThreads = parseThreads(input.nativeThreads, "nativeThreads");
  const nelosThreads = parseThreads(input.nelosThreads, "nelosThreads");
  if (!Array.isArray(input.visualSurfaces) || input.visualSurfaces.length < 1 || input.visualSurfaces.length > 8) {
    throw new DeveloperVisualStateValidationError("INVALID_INPUT", "visualSurfaces must contain 1 through 8 surfaces");
  }

  const nativeById = new Map(nativeThreads.map((entry) => [entry.threadId, entry]));
  const nelosById = new Map(nelosThreads.map((entry) => [entry.threadId, entry]));
  const visualById = new Map();
  const findings = [];
  const surfaceNames = new Set();

  for (const [surfaceIndex, surface] of input.visualSurfaces.entries()) {
    assertExactObject(surface, SURFACE_KEYS, `visualSurfaces[${surfaceIndex}]`);
    if (!SURFACES.has(surface.surface) || surfaceNames.has(surface.surface)) {
      throw new DeveloperVisualStateValidationError("INVALID_INPUT", `visualSurfaces[${surfaceIndex}].surface is unsupported or duplicated`);
    }
    surfaceNames.add(surface.surface);
    if (!Array.isArray(surface.entries) || surface.entries.length > 500) {
      throw new DeveloperVisualStateValidationError("INVALID_INPUT", `visualSurfaces[${surfaceIndex}].entries must contain at most 500 entries`);
    }
    const surfaceIds = new Set();
    for (const [entryIndex, entry] of surface.entries.entries()) {
      assertExactObject(entry, VISUAL_KEYS, `visualSurfaces[${surfaceIndex}].entries[${entryIndex}]`);
      const id = threadId(entry.threadId, `visualSurfaces[${surfaceIndex}].entries[${entryIndex}].threadId`);
      if (surfaceIds.has(id)) throw new DeveloperVisualStateValidationError("INVALID_INPUT", `${surface.surface} contains duplicate thread ${id}`);
      surfaceIds.add(id);
      const observedStatus = status(entry.observedStatus, `${surface.surface}.${id}.observedStatus`);
      const observedName = boundedString(entry.observedName, `${surface.surface}.${id}.observedName`);
      if (!NAME_RESOLUTIONS.has(entry.nameResolution)) throw new DeveloperVisualStateValidationError("INVALID_INPUT", `${surface.surface}.${id}.nameResolution is unsupported`);
      const visual = { surface: surface.surface, threadId: id, observedName, nameResolution: entry.nameResolution, observedStatus };
      if (!visualById.has(id)) visualById.set(id, []);
      visualById.get(id).push(visual);

      if (observedStatus === "systemError") findings.push(finding("VISUAL_SYSTEM_ERROR", id, { surface: surface.surface }));

      const authoritative = nativeById.get(id);
      if (!authoritative) {
        findings.push(finding("VISIBLE_THREAD_MISSING_FROM_NATIVE_INVENTORY", id, { surface: surface.surface, observedName }));
      } else {
        const visibleName = normalizedVisibleName(observedName);
        const nameMatches = entry.nameResolution === "exact"
          ? observedName === authoritative.title
          : entry.nameResolution === "truncated"
            ? authoritative.title.startsWith(visibleName)
            : false;
        if (!nameMatches) findings.push(finding("VISUAL_NAME_MISMATCH", id, { surface: surface.surface, observedName, authoritativeTitle: authoritative.title, nameResolution: entry.nameResolution }));
        if (STATUS_PHASE.get(observedStatus) !== STATUS_PHASE.get(authoritative.status)) {
          findings.push(finding("VISUAL_NATIVE_STATUS_MISMATCH", id, { surface: surface.surface, visualStatus: observedStatus, nativeStatus: authoritative.status }));
        }
      }
    }
  }

  for (const [id, entries] of visualById) {
    const phases = new Set(entries.map((entry) => STATUS_PHASE.get(entry.observedStatus)));
    if (phases.size > 1) findings.push(finding("VISUAL_SURFACE_CONTRADICTION", id, { observations: entries.map(({ surface, observedStatus }) => ({ surface, status: observedStatus })) }));
  }

  for (const [id, native] of nativeById) {
    const nelos = nelosById.get(id);
    if (native.status === "systemError") findings.push(finding("NATIVE_SYSTEM_ERROR", id, { nativeStatus: native.status }));
    if (nelos && native.title !== nelos.title) findings.push(finding("NATIVE_NELOS_NAME_MISMATCH", id, { nativeTitle: native.title, nelosTitle: nelos.title }));
  }
  for (const [id, nelos] of nelosById) {
    if (nelos.status === "systemError") findings.push(finding("NELOS_SYSTEM_ERROR", id, { nelosLoadState: nelos.status }));
  }

  findings.sort((left, right) => `${left.threadId}:${left.code}:${left.surface ?? ""}`.localeCompare(`${right.threadId}:${right.code}:${right.surface ?? ""}`));
  return Object.freeze({
    schemaVersion: 1,
    kind: "nelos-developer-visual-state-validation",
    capture,
    outcome: findings.length === 0 ? "passed" : "failed",
    counts: { surfaces: input.visualSurfaces.length, visibleEntries: [...visualById.values()].reduce((sum, entries) => sum + entries.length, 0), nativeThreads: nativeThreads.length, nelosThreads: nelosThreads.length, findings: findings.length },
    findings,
  });
}
