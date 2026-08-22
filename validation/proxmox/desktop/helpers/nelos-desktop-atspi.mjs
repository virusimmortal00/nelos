#!/usr/lib/chatgpt/resources/cua_node/bin/node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";

const root = process.env.NELOS_DESKTOP_HELPER_ROOT || "/";
const at = (path) => root === "/" ? path : `${root}${path}`;
const control = root === "/" ? "/usr/libexec/nelos-atspi-control" : process.env.NELOS_ATSPI_CONTROL || at("/usr/libexec/nelos-atspi-control");
const guestTaskControl = root === "/" ? "/usr/libexec/nelos-guest-task-control" : process.env.NELOS_GUEST_TASK_CONTROL || at("/usr/libexec/nelos-guest-task-control");
const operations = new Set([
  "list_tasks", "activate_expected_task", "active_task", "click", "keypress", "scroll", "select_menu", "type_text", "wait_for",
  "accessibility_tree", "window_state", "query_element", "task_state", "text_present", "window_count", "protected_capture_regions",
  "capture_evidence", "expected_task_visible", "observe_task_surface", "observe_archive_surface", "health", "gui_ready", "auth_status", "diagnostics",
  "prepare_expected_task", "read_prepared_task", "reconcile_prepared_task", "observe_native_task", "observe_mcp_task", "observe_native_archive", "observe_mcp_archive",
]);
const guestTaskOperations = new Map([
  ["prepare_expected_task", "prepare"],
  ["read_prepared_task", "read"],
  ["reconcile_prepared_task", "reconcile"],
  ["observe_native_task", "observe-native"],
  ["observe_mcp_task", "observe-mcp"],
  ["observe_native_archive", "observe-native-archive"],
  ["observe_mcp_archive", "observe-mcp-archive"],
]);
const BINDING_FIELDS = ["automationUser", "fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "stateRoot", "vmId"];
const ARCHIVE_SURFACE_CONTRACTS = new Map([
  ["sidebar", { contract: "codex-desktop-sidebar-app-action-v1", states: new Set(["present"]) }],
  ["createdTasks", { contract: "codex-desktop-created-tasks-summary-v1", states: new Set(["empty", "present"]) }],
  ["mcpVisual", { contract: "nelos-mcp-task-workers-v1", states: new Set(["present"]) }],
]);
const ARCHIVE_CONTROL_ERRORS = new Set([
  "ARCHIVE_SURFACE_AMBIGUOUS", "ARCHIVE_SURFACE_IDENTITY_UNSUPPORTED", "ARCHIVE_SURFACE_INCOMPLETE", "ARCHIVE_SURFACE_UNSUPPORTED",
  "CAPTURE_CACHE_SPILL", "CAPTURE_CACHE_UNAVAILABLE", "CAPTURE_LIMIT",
  "DESCENDANT_SURFACE_AMBIGUOUS", "DESCENDANT_SURFACE_IDENTITY_MISMATCH", "DESCENDANT_SURFACE_INCOMPLETE", "DESCENDANT_SURFACE_STATUS_MISMATCH",
]);
const TASK_ID = /^[a-f0-9-]{8,80}$/u;
const LATEST_TURN_STATUSES = new Set(["completed", "inProgress", "interrupted"]);
const SIDEBAR_RENDERED_STATUSES = new Set(["idle", "running", "waitingOnApproval", "waitingOnUserInput"]);
const MCP_RENDERED_STATUSES = new Map([["attention", "Attention"], ["complete", "Complete"], ["running", "Running"]]);

function die(exitCode, code, message) { process.stderr.write(`${JSON.stringify({ error: code, message })}\n`); process.exit(exitCode); }
function fields(value, expected) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"); }
function sameBinding(left, right) { return fields(left, BINDING_FIELDS) && fields(right, BINDING_FIELDS) && BINDING_FIELDS.every((field) => left[field] === right[field]); }
function canonical(value) { return Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value); }
function digest(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
async function trusted(path, max = 1_048_576) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (root === "/" && (info.uid !== 0 || (info.mode & 0o022) !== 0)) || info.size > max) throw new Error("untrusted file");
  return JSON.parse(await readFile(path, "utf8"));
}
async function output(value, limit) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > limit) die(65, "OUTPUT_LIMIT", "helper output exceeds its bound");
  await new Promise((resolvePromise, rejectPromise) => {
    process.stdout.write(bytes, (error) => error ? rejectPromise(error) : resolvePromise());
  });
  bytes.fill(0);
}
function validProtectedInventory(value, width, height) {
  if (!fields(value, ["conversation", "credentialInventory", "schemaVersion", "traversal"]) || value.schemaVersion !== 1 ||
      !fields(value.credentialInventory, ["complete", "count", "regions"]) || value.credentialInventory.complete !== true ||
      !Number.isSafeInteger(value.credentialInventory.count) || value.credentialInventory.count < 0 || value.credentialInventory.count > 1_000 ||
      !Array.isArray(value.credentialInventory.regions) || value.credentialInventory.regions.length !== value.credentialInventory.count ||
      !fields(value.traversal, ["complete", "maximumNodes", "scannedNodes"]) || value.traversal.complete !== true || value.traversal.maximumNodes !== 10_000 ||
      !Number.isSafeInteger(value.traversal.scannedNodes) || value.traversal.scannedNodes < 1 || value.traversal.scannedNodes > value.traversal.maximumNodes) return false;
  const regions = [value.conversation, ...value.credentialInventory.regions];
  if (regions.some((region, index) => !fields(region, ["height", "kind", "width", "x", "y"]) || region.kind !== (index === 0 ? "conversation" : "credential") ||
      !["x", "y", "width", "height"].every((field) => Number.isSafeInteger(region[field])) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
      region.x + region.width > width || region.y + region.height > height)) return false;
  const identities = regions.map(({ x, y, width: regionWidth, height: regionHeight }) => `${x}:${y}:${regionWidth}:${regionHeight}`);
  return new Set(identities).size === identities.length;
}
function overlaps(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}
function validArchiveSurfaceScans(value, inventories, width, height, globalScannedNodes) {
  if (!Array.isArray(value) || value.length !== ARCHIVE_SURFACE_CONTRACTS.size) return false;
  const geometries = new Set();
  for (const [index, [surface, expected]] of [...ARCHIVE_SURFACE_CONTRACTS].entries()) {
    const proof = value[index]; const ids = inventories[surface];
    if (!fields(proof, ["accessibilityRole", "contract", "geometry", "scan", "state", "surface", "threadIds"]) ||
        proof.surface !== surface || proof.contract !== expected.contract || !expected.states.has(proof.state) ||
        typeof proof.accessibilityRole !== "string" || proof.accessibilityRole.length < 1 || proof.accessibilityRole.length > 128 ||
        !Array.isArray(proof.threadIds) || JSON.stringify(proof.threadIds) !== JSON.stringify(ids) ||
        (proof.state === "empty" && proof.threadIds.length !== 0) ||
        !fields(proof.geometry, ["height", "width", "x", "y"]) ||
        ![proof.geometry.x, proof.geometry.y, proof.geometry.width, proof.geometry.height].every(Number.isSafeInteger) ||
        proof.geometry.x < 0 || proof.geometry.y < 0 || proof.geometry.width < 1 || proof.geometry.height < 1 ||
        proof.geometry.x + proof.geometry.width > width || proof.geometry.y + proof.geometry.height > height ||
        !fields(proof.scan, ["complete", "maximumNodes", "scannedNodes"]) || proof.scan.complete !== true || proof.scan.maximumNodes !== 10_000 ||
        !Number.isSafeInteger(proof.scan.scannedNodes) || proof.scan.scannedNodes < 1 || proof.scan.scannedNodes > globalScannedNodes) return false;
    geometries.add(`${proof.geometry.x}:${proof.geometry.y}:${proof.geometry.width}:${proof.geometry.height}`);
  }
  return geometries.size === ARCHIVE_SURFACE_CONTRACTS.size;
}
function validPrivacyProof(value, width, height, protectedRegions, { mode, taskIds, title = null, lifecycleEvidence = null, titles = null, lifecycleEvidenceByTaskId = null, requiredStatusTaskIds = [], requireStatus = false, scannedNodes }) {
  if (!fields(value, ["classificationComplete", "maskedBase", "mode", "preservedRegions", "rawPixelsPersisted", "schemaVersion", "traversal"]) || value.schemaVersion !== 1 ||
      value.classificationComplete !== true || value.maskedBase !== "full-frame-black" || value.mode !== mode || value.rawPixelsPersisted !== false ||
      !fields(value.traversal, ["complete", "maximumNodes", "scannedNodes"]) || value.traversal.complete !== true || value.traversal.maximumNodes !== 10_000 ||
      value.traversal.scannedNodes !== scannedNodes || !Array.isArray(value.preservedRegions) || value.preservedRegions.length > 200 ||
      !Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > 100 || new Set(taskIds).size !== taskIds.length) return false;
  const expected = new Set(taskIds); const titleDigests = new Map(); const statusDigests = new Map();
  if (title !== null) titleDigests.set(taskIds[0], `sha256:${createHash("sha256").update(title).digest("hex")}`);
  for (const [taskId, value] of Object.entries(titles ?? {})) titleDigests.set(taskId, `sha256:${createHash("sha256").update(value).digest("hex")}`);
  if (lifecycleEvidence !== null) statusDigests.set(taskIds[0], new Set([`sha256:${createHash("sha256").update(lifecycleEvidence).digest("hex")}`]));
  for (const [taskId, values] of Object.entries(lifecycleEvidenceByTaskId ?? {})) statusDigests.set(taskId, new Set(values.map((value) => `sha256:${createHash("sha256").update(value).digest("hex")}`)));
  for (const region of value.preservedRegions) {
    if (!fields(region, ["height", "kind", "taskId", "textDigest", "width", "x", "y"]) || !["expected-task-title", "expected-task-status"].includes(region.kind) || !expected.has(region.taskId) ||
        !/^sha256:[a-f0-9]{64}$/u.test(region.textDigest ?? "") || ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
        region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > width || region.y + region.height > height ||
        protectedRegions.some((protectedRegion) => overlaps(region, protectedRegion)) ||
        (mode === "expected-task-evidence-only" && region.kind === "expected-task-title" && region.textDigest !== titleDigests.get(region.taskId)) ||
        (mode === "expected-task-evidence-only" && region.kind === "expected-task-status" && !statusDigests.get(region.taskId)?.has(region.textDigest))) return false;
  }
  const geometry = value.preservedRegions.map(({ x, y, width: regionWidth, height: regionHeight }) => `${x}:${y}:${regionWidth}:${regionHeight}`);
  if (new Set(geometry).size !== geometry.length || value.preservedRegions.some((region, index) => value.preservedRegions.slice(index + 1).some((other) => overlaps(region, other))) ||
      taskIds.some((taskId) => value.preservedRegions.filter((region) => region.taskId === taskId && region.kind === "expected-task-title").length > 1 ||
        value.preservedRegions.filter((region) => region.taskId === taskId && region.kind === "expected-task-status").length > 1)) return false;
  return mode !== "expected-task-evidence-only" ||
    taskIds.every((taskId) => value.preservedRegions.filter((region) => region.kind === "expected-task-title" && region.taskId === taskId).length === 1) &&
    (!requireStatus || value.preservedRegions.some((region) => region.kind === "expected-task-status" && region.taskId === taskIds[0])) &&
    requiredStatusTaskIds.every((taskId) => value.preservedRegions.some((region) => region.kind === "expected-task-status" && region.taskId === taskId));
}
function validExpectedDescendants(value, rootTaskId) {
  if (!Array.isArray(value) || value.length > 32) return false;
  const ids = value.map(({ taskId }) => taskId);
  if (new Set(ids).size !== ids.length || ids.includes(rootTaskId) || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) return false;
  const known = new Set([rootTaskId, ...ids]);
  return value.every((item) => fields(item, ["latestTurnId", "latestTurnStatus", "parentTaskId", "taskId", "title"]) && TASK_ID.test(item.taskId ?? "") && TASK_ID.test(item.parentTaskId ?? "") &&
    TASK_ID.test(item.latestTurnId ?? "") && known.has(item.parentTaskId) && item.parentTaskId !== item.taskId && LATEST_TURN_STATUSES.has(item.latestTurnStatus) &&
    typeof item.title === "string" && item.title.length >= 1 && item.title.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(item.title));
}
function validDescendantTaskRows(value, expectedDescendants) {
  if (!fields(value, ["mcpVisual", "observationPhases", "schemaVersion", "sidebar"]) || value.schemaVersion !== 1 || !Array.isArray(value.observationPhases)) return false;
  const expectedIds = expectedDescendants.map(({ taskId }) => taskId); const sealedTitles = new Set(expectedDescendants.map(({ title }) => title));
  const validEvidence = (evidence, renderedStatus, surface) => fields(evidence, ["kind", "scan", "value"]) &&
    typeof evidence.value === "string" && evidence.value.length >= 1 && evidence.value.length <= 256 &&
    fields(evidence.scan, ["complete", "maximumNodes", "scannedNodes"]) && evidence.scan.complete === true && evidence.scan.maximumNodes === 2_000 &&
    Number.isSafeInteger(evidence.scan.scannedNodes) && evidence.scan.scannedNodes >= 1 && evidence.scan.scannedNodes <= 2_000 &&
    (surface === "sidebar"
      ? SIDEBAR_RENDERED_STATUSES.has(renderedStatus) && (renderedStatus === "idle" ? evidence.kind === "complete-absence" && evidence.value === "no-running-approval-or-input-indicator" : ["role", "state", "text"].includes(evidence.kind))
      : evidence.kind === "text" && MCP_RENDERED_STATUSES.get(renderedStatus) === evidence.value);
  for (const [surface, statuses] of [["sidebar", SIDEBAR_RENDERED_STATUSES], ["mcpVisual", new Set(MCP_RENDERED_STATUSES.keys())]]) {
    const rows = value[surface];
    if (!Array.isArray(rows) || rows.length !== expectedIds.length || JSON.stringify(rows.map(({ taskId }) => taskId)) !== JSON.stringify(expectedIds)) return false;
    if (rows.some((row) => !fields(row, ["lifecycleEvidence", "phaseSequence", "renderedStatus", "taskId", "title"]) || !TASK_ID.test(row.taskId ?? "") || !sealedTitles.has(row.title) ||
      !Number.isSafeInteger(row.phaseSequence) || row.phaseSequence < 1 || row.phaseSequence > 34 || !statuses.has(row.renderedStatus) || !validEvidence(row.lifecycleEvidence, row.renderedStatus, surface))) return false;
  }
  if (expectedDescendants.length === 0) return value.observationPhases.length === 0;
  if (value.observationPhases.length < 2 || value.observationPhases.length > 34 || value.observationPhases.some((phase, index) =>
    !fields(phase, ["scan", "schemaVersion", "screenshot", "sequence", "surface", "taskIds", "view"]) || phase.schemaVersion !== 1 || phase.sequence !== index + 1 ||
    !["sidebar", "mcpVisual"].includes(phase.surface) || !["current", "done", "scroll-page", "standalone"].includes(phase.view) ||
    !Array.isArray(phase.taskIds) || phase.taskIds.length < 1 || phase.taskIds.length > 32 || new Set(phase.taskIds).size !== phase.taskIds.length ||
    JSON.stringify(phase.taskIds) !== JSON.stringify([...phase.taskIds].sort()) || phase.taskIds.some((taskId) => !expectedIds.includes(taskId)) ||
    !fields(phase.scan, ["complete", "maximumNodes", "scannedNodes"]) || phase.scan.complete !== true || phase.scan.maximumNodes !== 10_000 ||
    !Number.isSafeInteger(phase.scan.scannedNodes) || phase.scan.scannedNodes < 1 || phase.scan.scannedNodes > phase.scan.maximumNodes ||
    !fields(phase.screenshot, ["byteLength", "bytesBase64", "digest", "height", "mediaType", "privacy", "protectedInventory", "protectedRegions", "protection", "width"]))) return false;
  for (const [surface, rows] of [["sidebar", value.sidebar], ["mcpVisual", value.mcpVisual]]) {
    if (rows.some((row) => {
      const phase = value.observationPhases[row.phaseSequence - 1];
      return phase?.surface !== surface || !phase.taskIds.includes(row.taskId) || (surface === "mcpVisual" &&
        (row.renderedStatus === "complete" ? phase.view !== "done" : !["current", "standalone"].includes(phase.view)));
    })) return false;
  }
  return value.observationPhases.every((phase) => {
    const rows = value[phase.surface].filter((row) => row.phaseSequence === phase.sequence).map(({ taskId }) => taskId).sort();
    return JSON.stringify(rows) === JSON.stringify(phase.taskIds);
  });
}
async function immutableBytes(path, bytes) {
  const directory = path.slice(0, path.lastIndexOf("/"));
  await mkdir(directory, { recursive: true, mode: 0o750 });
  if (root === "/" && await realpath(directory) !== directory) throw new Error("unsafe capture directory");
  try {
    const handle = await open(path, "wx", 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (root === "/" && (info.uid !== 0 || (info.mode & 0o022) !== 0)) || !(await readFile(path)).equals(bytes)) throw error;
  }
}
function runControl(executable, operation, input, timeout, maxOutputBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [operation], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
    const chunks = []; const errorChunks = []; let size = 0; let errorSize = 0; let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(rejectPromise, Object.assign(new Error("control deadline"), { killed: true })); }, timeout);
    child.once("error", (error) => finish(rejectPromise, error));
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > maxOutputBytes) { child.kill("SIGKILL"); finish(rejectPromise, Object.assign(new Error("control output"), { code: "OUTPUT_LIMIT" })); } else chunks.push(chunk); });
    child.stderr.on("data", (chunk) => { errorSize += chunk.length; if (errorSize <= 4_096) errorChunks.push(chunk); });
    child.once("close", (code) => {
      if (code === 0) { finish(resolvePromise, Buffer.concat(chunks).toString("utf8")); return; }
      let surfaceCode = null;
      if (errorSize <= 4_096) {
        try {
          const parsed = JSON.parse(Buffer.concat(errorChunks).toString("utf8"));
          const closedError = fields(parsed, ["error"]) || (
            fields(parsed, ["error", "message"]) && typeof parsed.message === "string" && Buffer.byteLength(parsed.message, "utf8") <= 1_024
          );
          if (closedError && ARCHIVE_CONTROL_ERRORS.has(parsed.error)) surfaceCode = parsed.error;
        } catch {}
      }
      finish(rejectPromise, Object.assign(new Error("control failure"), { code, ...(surfaceCode === null ? {} : { surfaceCode }) }));
    });
    child.stdin.end(input);
  });
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
if (input.length > 16_777_216) die(65, "INPUT_LIMIT", "helper input exceeds 16 MiB");
const newline = input.indexOf(0x0a);
if (newline < 0 || newline > 65_536) die(65, "INVALID_CONTRACT", "bounded JSON header is missing");
let request; let expected;
try { request = JSON.parse(input.subarray(0, newline).toString("utf8")); expected = await trusted(at("/etc/nelos-desktop/run-binding.json"), 16_384); }
catch { die(70, "HELPER_UNAVAILABLE", "trusted guest binding is unavailable"); }
if (!fields(request, ["binding", "byteLength", "deadlineAt", "maxOutputBytes", "operation", "payload", "schemaVersion"]) || request.schemaVersion !== 1 ||
    !sameBinding(request.binding, expected) ||
    request.operation !== process.argv[2] || !operations.has(request.operation) || request.payload === null || typeof request.payload !== "object" || Array.isArray(request.payload)) die(77, "IDENTITY_MISMATCH", "guest request binding or operation differs");
const raw = input.subarray(newline + 1);
if (!Number.isSafeInteger(request.byteLength) || request.byteLength !== raw.length || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 16_777_216) die(65, "INVALID_CONTRACT", "byte or output bound differs");
const remaining = Date.parse(request.deadlineAt) - Date.now();
if (remaining <= 0 || remaining > 600_000) die(75, "DEADLINE_EXPIRED", "guest helper deadline is invalid");

if (request.operation === "gui_ready") {
  let ready;
  try { ready = await trusted(at("/var/lib/nelos-desktop/gui-ready.json"), 16_384); }
  catch { await output({ ready: false, accessibilityBus: false, captureReady: false }, request.maxOutputBytes); process.exit(0); }
  if (!fields(ready, ["accessibilityBus", "binding", "captureReady", "ready", "schemaVersion", "sessionUser"]) || ready.schemaVersion !== 1 ||
      !sameBinding(ready.binding, expected) ||
      ready.sessionUser !== expected.automationUser || ![ready.ready, ready.accessibilityBus, ready.captureReady].every((value) => typeof value === "boolean")) die(69, "GUI_NOT_READY", "graphical readiness receipt is incomplete or identity-mismatched");
  await output({ ready: ready.ready, accessibilityBus: ready.accessibilityBus, captureReady: ready.captureReady }, request.maxOutputBytes); process.exit(0);
}
if (request.operation === "auth_status") {
  let auth; try { auth = await trusted(at("/var/lib/nelos-desktop/device-auth.json"), 65_536); } catch { die(69, "AUTH_UNAVAILABLE", "device-auth receipt is unavailable"); }
  if (!fields(auth, ["accountBindingDigest", "accountType", "authMethod", "authenticated", "binding", "credentialStore", "developerSessionImported", "schemaVersion"]) || auth.schemaVersion !== 1 ||
      !sameBinding(auth.binding, expected) || auth.authenticated !== true ||
      auth.accountType !== "chatgpt" || auth.authMethod !== "chatgptDeviceCode" || auth.credentialStore !== "file" ||
      auth.developerSessionImported !== false || !/^sha256:[0-9a-f]{64}$/u.test(auth.accountBindingDigest ?? "")) die(77, "AUTH_IDENTITY_MISMATCH", "device-auth receipt is not isolated to this run");
  let stdout;
  try {
    const liveRequest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, operation: "observe-auth", payload: {} })}\n`);
    try { stdout = await runControl(guestTaskControl, "observe-auth", liveRequest, remaining, request.maxOutputBytes); }
    finally { liveRequest.fill(0); }
  } catch { die(70, "AUTH_OBSERVATION_UNAVAILABLE", "live account/read observation failed closed"); }
  let live; try { live = JSON.parse(stdout); } catch { die(70, "AUTH_OBSERVATION_UNAVAILABLE", "live account/read observation returned invalid JSON"); }
  const liveFields = ["accountBindingDigest", "accountType", "attestationDigest", "authenticated", "authMethod", "authReceiptDigest", "automationUser", "credentialStore", "developerSessionImported", "fencingToken", "observedAt", "runId", "schemaVersion", "source", "type"];
  const { attestationDigest, ...base } = live ?? {};
  if (!fields(live, liveFields) || live.schemaVersion !== 1 || live.type !== "live-device-auth-attestation" || live.source !== "codex-app-server-account-read" ||
      live.authenticated !== true || live.accountType !== "chatgpt" || live.authMethod !== "chatgptDeviceCode" || live.credentialStore !== "file" || live.developerSessionImported !== false ||
      live.accountBindingDigest !== auth.accountBindingDigest || live.authReceiptDigest !== digest(auth) || live.automationUser !== expected.automationUser || live.runId !== expected.runId || live.fencingToken !== expected.fencingToken ||
      !Number.isFinite(Date.parse(live.observedAt)) || Math.abs(Date.now() - Date.parse(live.observedAt)) > 30_000 || attestationDigest !== digest(base)) {
    die(77, "AUTH_IDENTITY_MISMATCH", "live account/read attestation differs from the isolated device-auth receipt");
  }
  await output(live, request.maxOutputBytes); process.exit(0);
}
if (request.operation === "diagnostics") {
  let ready; try { ready = await trusted(at("/var/lib/nelos-desktop/gui-ready.json"), 16_384); } catch { die(69, "GUI_NOT_READY", "graphical readiness receipt is unavailable"); }
  await output({ source: "desktop_runtime", code: "DESKTOP_READY", occurredAt: new Date().toISOString(), fields: { component: "production_gui", event: "checkpoint", status: ready.ready ? "ready" : "unready", outcome: ready.accessibilityBus && ready.captureReady ? "passed" : "failed" } }, request.maxOutputBytes); process.exit(0);
}

if (guestTaskOperations.has(request.operation)) {
  if (raw.length !== 0) die(65, "INVALID_CONTRACT", "guest task operations do not accept an opaque byte payload");
  const operation = guestTaskOperations.get(request.operation);
  const payload = operation === "prepare" || operation === "read" || operation === "reconcile"
    ? request.payload
    : operation === "observe-native" || operation === "observe-mcp"
      ? { expected: request.payload }
      : { expectedThreads: request.payload.expectedThreads };
  let stdout;
  try {
    const guestRequest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, operation, payload })}\n`);
    try { stdout = await runControl(guestTaskControl, operation, guestRequest, remaining, request.maxOutputBytes); }
    finally { guestRequest.fill(0); }
  } catch { die(70, "GUEST_TASK_CONTROL_FAILED", "guest task producer or guest-local observer failed closed"); }
  let value;
  try { value = JSON.parse(stdout); } catch { die(70, "INVALID_GUEST_TASK_OUTPUT", "guest task producer returned invalid JSON"); }
  await output(value, request.maxOutputBytes);
  process.exit(0);
}

if (request.operation === "observe_archive_surface") {
  const requestFields = request.payload.expectedAppInstanceId === undefined ? ["expectedThreads", "phase", "runId", "schemaVersion", "sequence"] : ["expectedAppInstanceId", "expectedThreads", "phase", "runId", "schemaVersion", "sequence"];
  if (raw.length !== 0 || !fields(request.payload, requestFields) || request.payload.schemaVersion !== 1 || request.payload.runId !== expected.runId ||
      !["afterCleanup", "afterRestart"].includes(request.payload.phase) || !Number.isSafeInteger(request.payload.sequence) || request.payload.sequence < 1 || request.payload.sequence > 50 ||
      !Array.isArray(request.payload.expectedThreads) || request.payload.expectedThreads.length < 1 || request.payload.expectedThreads.length > 100 ||
      request.payload.expectedThreads.some((thread) => !fields(thread, ["threadId", "title"]) || !/^[a-f0-9-]{8,80}$/u.test(thread.threadId ?? "") || typeof thread.title !== "string" || thread.title.length < 1 || thread.title.length > 240 || /[\u0000-\u001f\u007f]/u.test(thread.title)) ||
      new Set(request.payload.expectedThreads.map(({ threadId }) => threadId)).size !== request.payload.expectedThreads.length ||
      new Set(request.payload.expectedThreads.map(({ title }) => title)).size !== request.payload.expectedThreads.length ||
      (request.payload.expectedAppInstanceId !== undefined && !/^desktop-pid-[1-9][0-9]{0,9}$/u.test(request.payload.expectedAppInstanceId))) {
    die(65, "INVALID_CONTRACT", "archive surface request does not match the unique sealed identity contract");
  }
}

try {
  const payload = Buffer.from(`${JSON.stringify({ schemaVersion: 1, binding: expected, operation: request.operation, payload: request.payload, bytesBase64: raw.toString("base64") })}\n`);
  const stdout = await runControl(control, request.operation, payload, remaining, request.maxOutputBytes);
  payload.fill(0);
  let value = JSON.parse(stdout);
  if (request.operation === "expected_task_visible") {
    if (!fields(request.payload, ["taskId", "title"]) || typeof request.payload.taskId !== "string" || !/^[a-f0-9-]{8,80}$/u.test(request.payload.taskId) ||
        typeof request.payload.title !== "string" || request.payload.title.length < 1 || request.payload.title.length > 512 ||
        !fields(value, ["scan", "schemaVersion", "state", "taskId", "title"]) || value.schemaVersion !== 1 || value.taskId !== request.payload.taskId || value.title !== request.payload.title ||
        !["visible", "missing"].includes(value.state) || !fields(value.scan, ["complete", "maximumNodes", "scannedNodes"]) || value.scan.complete !== true ||
        value.scan.maximumNodes !== 10_000 || !Number.isSafeInteger(value.scan.scannedNodes) || value.scan.scannedNodes < 1 || value.scan.scannedNodes > value.scan.maximumNodes) {
      die(77, "EXPECTED_TASK_VISIBILITY_MISMATCH", "visible Desktop task synchronization proof differs from the producer receipt");
    }
  } else if (request.operation === "observe_task_surface") {
    if (!fields(request.payload, ["descendants", "lifecycle", "taskId", "title"]) || !["active", "completed"].includes(request.payload.lifecycle) || !TASK_ID.test(request.payload.taskId ?? "") ||
        typeof request.payload.title !== "string" || request.payload.title.length < 1 || request.payload.title.length > 512 || /[\u0000-\u001f\u007f]/u.test(request.payload.title) || !validExpectedDescendants(request.payload.descendants, request.payload.taskId) ||
        !fields(value, ["accessibilityRole", "aggregateTaskCounters", "descendantTasks", "lifecycle", "lifecycleEvidence", "renderedLifecycle", "screenshot", "selected", "taskId", "title"]) ||
        value.taskId !== request.payload.taskId || typeof value.title !== "string" || value.title.length < 1 || value.title.length > 512 || /[\u0000-\u001f\u007f]/u.test(value.title) || value.lifecycle !== request.payload.lifecycle || !["idle", "running", "waitingOnApproval", "waitingOnUserInput"].includes(value.renderedLifecycle) || value.selected !== true ||
        !fields(value.aggregateTaskCounters, ["current", "done", "groups", "scan", "schemaVersion", "source"]) || value.aggregateTaskCounters.schemaVersion !== 1 || value.aggregateTaskCounters.source !== "visible-codex-desktop-atspi" ||
        !Number.isSafeInteger(value.aggregateTaskCounters.current) || value.aggregateTaskCounters.current < 0 || !Number.isSafeInteger(value.aggregateTaskCounters.done) || value.aggregateTaskCounters.done < 0 || value.aggregateTaskCounters.current + value.aggregateTaskCounters.done > 500 ||
        !fields(value.aggregateTaskCounters.groups, ["inProgress", "needsInput", "queued"]) || ![value.aggregateTaskCounters.groups.inProgress, value.aggregateTaskCounters.groups.needsInput, value.aggregateTaskCounters.groups.queued].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 500) ||
        value.aggregateTaskCounters.current !== value.aggregateTaskCounters.groups.inProgress + value.aggregateTaskCounters.groups.needsInput + value.aggregateTaskCounters.groups.queued ||
        !fields(value.aggregateTaskCounters.scan, ["complete", "maximumNodes", "scannedNodes"]) || value.aggregateTaskCounters.scan.complete !== true || value.aggregateTaskCounters.scan.maximumNodes !== 10_000 || !Number.isSafeInteger(value.aggregateTaskCounters.scan.scannedNodes) || value.aggregateTaskCounters.scan.scannedNodes < 1 || value.aggregateTaskCounters.scan.scannedNodes > value.aggregateTaskCounters.scan.maximumNodes ||
        !fields(value.lifecycleEvidence, ["kind", "scan", "value"]) || typeof value.lifecycleEvidence.value !== "string" || value.lifecycleEvidence.value.length < 1 || value.lifecycleEvidence.value.length > 256 ||
        !fields(value.lifecycleEvidence.scan, ["complete", "maximumNodes", "scannedNodes"]) || value.lifecycleEvidence.scan.complete !== true || value.lifecycleEvidence.scan.maximumNodes !== 2_000 ||
        !Number.isSafeInteger(value.lifecycleEvidence.scan.scannedNodes) || value.lifecycleEvidence.scan.scannedNodes < 1 || value.lifecycleEvidence.scan.scannedNodes > value.lifecycleEvidence.scan.maximumNodes ||
        (value.renderedLifecycle === "idle" ? value.lifecycleEvidence.kind !== "complete-absence" || value.lifecycleEvidence.value !== "no-running-approval-or-input-indicator" : !["role", "state", "text"].includes(value.lifecycleEvidence.kind)) ||
        typeof value.accessibilityRole !== "string" || value.accessibilityRole.length < 1 || value.accessibilityRole.length > 128 ||
        !fields(value.screenshot, ["byteLength", "bytesBase64", "digest", "height", "mediaType", "privacy", "protectedInventory", "protectedRegions", "protection", "width"]) ||
        value.screenshot.mediaType !== "image/png" || !Number.isSafeInteger(value.screenshot.byteLength) || value.screenshot.byteLength < 1 ||
        !Number.isSafeInteger(value.screenshot.width) || value.screenshot.width < 1 || !Number.isSafeInteger(value.screenshot.height) || value.screenshot.height < 1 ||
        !Array.isArray(value.screenshot.protectedRegions) || !value.screenshot.protectedRegions.some((region) => region?.kind === "conversation") ||
        !fields(value.screenshot.protection, ["geometryCertain", "inventoryComplete", "mode"]) || value.screenshot.protection.geometryCertain !== true ||
        value.screenshot.protection.inventoryComplete !== true || value.screenshot.protection.mode !== "mask" || !validDescendantTaskRows(value.descendantTasks, request.payload.descendants)) {
      die(77, "THREE_SURFACE_IDENTITY_MISMATCH", "visible Desktop observer returned an incompatible task proof");
    }
    const png = Buffer.from(value.screenshot.bytesBase64, "base64");
    const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
    const regionsValid = value.screenshot.protectedRegions.every((region) => fields(region, ["height", "kind", "width", "x", "y"]) && ["conversation", "credential"].includes(region.kind) &&
      ["x", "y", "width", "height"].every((field) => Number.isSafeInteger(region[field])) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
      region.x + region.width <= value.screenshot.width && region.y + region.height <= value.screenshot.height);
    const exactRegions = [value.screenshot.protectedInventory?.conversation, ...(value.screenshot.protectedInventory?.credentialInventory?.regions ?? [])];
    if (!png.length || png.length !== value.screenshot.byteLength || value.screenshot.digest !== digest || !regionsValid ||
        !validProtectedInventory(value.screenshot.protectedInventory, value.screenshot.width, value.screenshot.height) || JSON.stringify(exactRegions) !== JSON.stringify(value.screenshot.protectedRegions) ||
        !validPrivacyProof(value.screenshot.privacy, value.screenshot.width, value.screenshot.height, value.screenshot.protectedRegions, {
          mode: "expected-task-evidence-only", taskIds: [value.taskId], title: value.title,
          lifecycleEvidence: value.lifecycleEvidence.value,
          requireStatus: value.renderedLifecycle !== "idle",
          scannedNodes: value.screenshot.protectedInventory?.traversal?.scannedNodes,
        }) ||
        value.aggregateTaskCounters.scan.scannedNodes !== value.screenshot.protectedInventory?.traversal?.scannedNodes ||
        expected.stateRoot !== `/var/lib/nelos-desktop/runs/${expected.runId}`) die(77, "UNSAFE_CAPTURE", "visible Desktop screenshot bytes, digest, geometry, or run path differ");
    const relativePath = `${expected.stateRoot}/surface-observations/${digest.slice(7)}.png`;
    await immutableBytes(at(relativePath), png);
    const persistedPhases = [];
    for (const phase of value.descendantTasks.observationPhases) {
      const phasePng = Buffer.from(phase.screenshot.bytesBase64, "base64");
      try {
        const phaseDigest = `sha256:${createHash("sha256").update(phasePng).digest("hex")}`;
        const phaseRows = value.descendantTasks[phase.surface].filter((row) => row.phaseSequence === phase.sequence);
        const titles = Object.fromEntries(phaseRows.map((row) => [row.taskId, row.title]));
        const statuses = Object.fromEntries(phaseRows.map((row) => [row.taskId, [row.lifecycleEvidence.value]]));
        const requiredStatusTaskIds = phaseRows.filter((row) => phase.surface === "mcpVisual" || row.renderedStatus !== "idle").map(({ taskId }) => taskId);
        const phaseExactRegions = [phase.screenshot.protectedInventory?.conversation, ...(phase.screenshot.protectedInventory?.credentialInventory?.regions ?? [])];
        if (!phasePng.length || phasePng.length !== phase.screenshot.byteLength || phase.screenshot.digest !== phaseDigest || phase.screenshot.mediaType !== "image/png" ||
            !Number.isSafeInteger(phase.screenshot.width) || phase.screenshot.width < 1 || !Number.isSafeInteger(phase.screenshot.height) || phase.screenshot.height < 1 ||
            !validProtectedInventory(phase.screenshot.protectedInventory, phase.screenshot.width, phase.screenshot.height) || JSON.stringify(phaseExactRegions) !== JSON.stringify(phase.screenshot.protectedRegions) ||
            phase.scan.scannedNodes !== phase.screenshot.protectedInventory?.traversal?.scannedNodes ||
            !fields(phase.screenshot.protection, ["geometryCertain", "inventoryComplete", "mode"]) || phase.screenshot.protection.geometryCertain !== true || phase.screenshot.protection.inventoryComplete !== true || phase.screenshot.protection.mode !== "mask" ||
            !validPrivacyProof(phase.screenshot.privacy, phase.screenshot.width, phase.screenshot.height, phase.screenshot.protectedRegions, {
              mode: "expected-task-evidence-only", taskIds: phase.taskIds, titles, lifecycleEvidenceByTaskId: statuses, requiredStatusTaskIds,
              scannedNodes: phase.screenshot.protectedInventory?.traversal?.scannedNodes,
            })) die(77, "UNSAFE_CAPTURE", "Desktop descendant phase screenshot differs from its exact row allowlist");
        const phasePath = `${expected.stateRoot}/surface-observations/${phaseDigest.slice(7)}.png`;
        await immutableBytes(at(phasePath), phasePng);
        persistedPhases.push({ ...phase, screenshot: { ...phase.screenshot, path: phasePath } });
      } finally { phasePng.fill(0); }
    }
    value = {
      schemaVersion: 1, runId: expected.runId, fencingToken: expected.fencingToken,
      taskId: value.taskId, title: value.title, lifecycle: value.lifecycle, observedAt: new Date().toISOString(), producer: "visible-codex-desktop",
      attestation: { accessibilityRole: value.accessibilityRole, aggregateTaskCounters: value.aggregateTaskCounters, descendantTasks: { ...value.descendantTasks, observationPhases: persistedPhases }, lifecycleEvidence: value.lifecycleEvidence, renderedLifecycle: value.renderedLifecycle, selected: true, screenshot: {
        byteLength: png.length, digest, width: value.screenshot.width, height: value.screenshot.height, mediaType: "image/png",
        path: relativePath, bytesBase64: value.screenshot.bytesBase64, privacy: value.screenshot.privacy, protectedInventory: value.screenshot.protectedInventory, protectedRegions: value.screenshot.protectedRegions, protection: value.screenshot.protection,
      } },
    };
    png.fill(0);
  } else if (request.operation === "observe_archive_surface") {
    const requestFields = request.payload.expectedAppInstanceId === undefined ? ["expectedThreads", "phase", "runId", "schemaVersion", "sequence"] : ["expectedAppInstanceId", "expectedThreads", "phase", "runId", "schemaVersion", "sequence"];
    if (!fields(request.payload, requestFields) || request.payload.schemaVersion !== 1 || request.payload.runId !== expected.runId ||
        !fields(value, ["appInstanceId", "createdTasksThreadIds", "fencingToken", "mcpVisualThreadIds", "observedAt", "phase", "runId", "scan", "schemaVersion", "screenshot", "screenshotThreadIds", "sequence", "sidebarThreadIds", "surfaceScans"]) ||
        value.schemaVersion !== 1 || value.runId !== expected.runId || value.fencingToken !== expected.fencingToken || value.sequence !== request.payload.sequence || value.phase !== request.payload.phase ||
        (request.payload.expectedAppInstanceId !== undefined && value.appInstanceId !== request.payload.expectedAppInstanceId) || !/^desktop-pid-[1-9][0-9]{0,9}$/u.test(value.appInstanceId ?? "") ||
        !fields(value.scan, ["complete", "maximumNodes", "scannedNodes"]) || value.scan.complete !== true || value.scan.maximumNodes !== 10_000 || !Number.isSafeInteger(value.scan.scannedNodes) || value.scan.scannedNodes < 1 || value.scan.scannedNodes > value.scan.maximumNodes ||
        ![value.sidebarThreadIds, value.createdTasksThreadIds, value.mcpVisualThreadIds, value.screenshotThreadIds].every((ids) => Array.isArray(ids) && ids.length <= 500 && new Set(ids).size === ids.length && ids.every((id) => typeof id === "string" && /^[a-f0-9-]{8,80}$/u.test(id))) ||
        !fields(value.screenshot, ["byteLength", "bytesBase64", "digest", "height", "mediaType", "privacy", "protectedInventory", "protectedRegions", "protection", "width"]) || value.screenshot.mediaType !== "image/png") {
      die(77, "ARCHIVE_OBSERVATION_MISMATCH", "visible Desktop archive observer returned an incompatible proof");
    }
    const expectedArchiveIds = new Set(request.payload.expectedThreads.map(({ threadId }) => threadId));
    if ([value.sidebarThreadIds, value.createdTasksThreadIds, value.mcpVisualThreadIds, value.screenshotThreadIds].some((ids) => ids.some((id) => !expectedArchiveIds.has(id))) ||
        value.screenshotThreadIds.some((id) => !value.sidebarThreadIds.includes(id) && !value.createdTasksThreadIds.includes(id) && !value.mcpVisualThreadIds.includes(id)) ||
        !validArchiveSurfaceScans(value.surfaceScans, { sidebar: value.sidebarThreadIds, createdTasks: value.createdTasksThreadIds, mcpVisual: value.mcpVisualThreadIds }, value.screenshot.width, value.screenshot.height, value.scan.scannedNodes)) {
      die(77, "ARCHIVE_OBSERVATION_MISMATCH", "visible Desktop archive inventory exposed an unrelated task identity");
    }
    const png = Buffer.from(value.screenshot.bytesBase64, "base64"); const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
    const exactRegions = [value.screenshot.protectedInventory?.conversation, ...(value.screenshot.protectedInventory?.credentialInventory?.regions ?? [])];
    if (!png.length || png.length !== value.screenshot.byteLength || value.screenshot.digest !== digest ||
        !Number.isSafeInteger(value.screenshot.width) || value.screenshot.width < 1 || !Number.isSafeInteger(value.screenshot.height) || value.screenshot.height < 1 ||
        !validProtectedInventory(value.screenshot.protectedInventory, value.screenshot.width, value.screenshot.height) || JSON.stringify(exactRegions) !== JSON.stringify(value.screenshot.protectedRegions) ||
        !validPrivacyProof(value.screenshot.privacy, value.screenshot.width, value.screenshot.height, value.screenshot.protectedRegions, {
          mode: "expected-archive-evidence-only", taskIds: request.payload.expectedThreads.map(({ threadId }) => threadId),
          scannedNodes: value.screenshot.protectedInventory?.traversal?.scannedNodes,
        }) ||
        JSON.stringify(value.screenshot.privacy.preservedRegions.filter(({ kind }) => kind === "expected-task-title").map(({ taskId }) => taskId).sort()) !== JSON.stringify([...value.screenshotThreadIds].sort()) ||
        !fields(value.screenshot.protection, ["geometryCertain", "inventoryComplete", "mode"]) || value.screenshot.protection.geometryCertain !== true || value.screenshot.protection.inventoryComplete !== true || value.screenshot.protection.mode !== "mask" ||
        !Number.isFinite(Date.parse(value.observedAt)) || Math.abs(Date.now() - Date.parse(value.observedAt)) > 30_000) die(77, "UNSAFE_CAPTURE", "visible Desktop archive screenshot proof differs");
    const relativePath = `${expected.stateRoot}/archive-surface-observations/${digest.slice(7)}.png`;
    await immutableBytes(at(relativePath), png);
    value = { ...value, producer: "visible-codex-desktop-atspi", screenshot: { ...value.screenshot, path: relativePath } };
    png.fill(0);
  }
  await output(value, request.maxOutputBytes);
} catch (error) { die(error.killed ? 75 : error.code === "ENOENT" ? 69 : 70, error.killed ? "DEADLINE_EXPIRED" : error.code === "ENOENT" ? "GUI_NOT_READY" : error.surfaceCode ?? "HELPER_FAILED", "bounded accessibility operation failed"); }
