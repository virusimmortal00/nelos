#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";

const root = process.env.NELOS_DESKTOP_HELPER_ROOT || "/";
const at = (path) => root === "/" ? path : `${root}${path}`;
const control = process.env.NELOS_ATSPI_CONTROL || "/usr/libexec/nelos-atspi-control";
const operations = new Set([
  "list_tasks", "activate_expected_task", "active_task", "click", "keypress", "scroll", "select_menu", "type_text", "wait_for",
  "accessibility_tree", "window_state", "query_element", "task_state", "text_present", "window_count", "protected_capture_regions",
  "capture_screenshot", "capture_evidence", "health", "gui_ready", "auth_status", "stage_task_surfaces", "stage_archive_observations", "compare_task_surfaces", "diagnostics",
]);
const BINDING_FIELDS = ["automationUser", "fencingToken", "hostId", "imageId", "leaseId", "providerId", "runId", "stateRoot", "vmId"];

function die(exitCode, code, message) { process.stderr.write(`${JSON.stringify({ error: code, message })}\n`); process.exit(exitCode); }
function fields(value, expected) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"); }
async function trusted(path, max = 1_048_576) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (root === "/" && (info.uid !== 0 || (info.mode & 0o022) !== 0)) || info.size > max) throw new Error("untrusted file");
  return JSON.parse(await readFile(path, "utf8"));
}
async function output(value, limit) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > limit) die(65, "OUTPUT_LIMIT", "helper output exceeds its bound");
  process.stdout.write(bytes); bytes.fill(0);
}
async function atomicObservation(path, value) {
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true, mode: 0o750 });
  const temporary = `${path}.new`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o440 });
  await rename(temporary, path);
}
function runControl(executable, operation, input, timeout, maxOutputBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [operation], { shell: false, stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
    const chunks = []; let size = 0; let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(rejectPromise, Object.assign(new Error("control deadline"), { killed: true })); }, timeout);
    child.once("error", (error) => finish(rejectPromise, error));
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > maxOutputBytes) { child.kill("SIGKILL"); finish(rejectPromise, Object.assign(new Error("control output"), { code: "OUTPUT_LIMIT" })); } else chunks.push(chunk); });
    child.once("close", (code) => code === 0 ? finish(resolvePromise, Buffer.concat(chunks).toString("utf8")) : finish(rejectPromise, Object.assign(new Error("control failure"), { code })));
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
    !fields(request.binding, BINDING_FIELDS) || !fields(expected, BINDING_FIELDS) || JSON.stringify(request.binding) !== JSON.stringify(expected) ||
    request.operation !== process.argv[2] || !operations.has(request.operation) || request.payload === null || typeof request.payload !== "object" || Array.isArray(request.payload)) die(77, "IDENTITY_MISMATCH", "guest request binding or operation differs");
const raw = input.subarray(newline + 1);
if (!Number.isSafeInteger(request.byteLength) || request.byteLength !== raw.length || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 16_777_216) die(65, "INVALID_CONTRACT", "byte or output bound differs");
const remaining = Date.parse(request.deadlineAt) - Date.now();
if (remaining <= 0 || remaining > 600_000) die(75, "DEADLINE_EXPIRED", "guest helper deadline is invalid");

if (request.operation === "gui_ready") {
  let ready; try { ready = await trusted(at("/var/lib/nelos-desktop/gui-ready.json"), 16_384); } catch { die(69, "GUI_NOT_READY", "graphical readiness receipt is unavailable"); }
  if (!fields(ready, ["accessibilityBus", "captureReady", "ready", "runId", "sessionUser"]) || ready.runId !== expected.runId || ready.sessionUser !== expected.automationUser || ready.ready !== true || ready.accessibilityBus !== true || ready.captureReady !== true) die(69, "GUI_NOT_READY", "graphical readiness receipt is incomplete");
  await output({ ready: true, accessibilityBus: true, captureReady: true }, request.maxOutputBytes); process.exit(0);
}
if (request.operation === "auth_status") {
  let auth; try { auth = await trusted(at("/var/lib/nelos-desktop/device-auth.json"), 65_536); } catch { die(69, "AUTH_UNAVAILABLE", "device-auth receipt is unavailable"); }
  if (auth?.binding?.runId !== expected.runId || auth?.binding?.fencingToken !== expected.fencingToken || auth?.modelBacked !== true || auth?.developerSessionImported !== false || auth?.accounts?.length !== 1 || auth.accounts[0]?.automation !== true) die(77, "AUTH_IDENTITY_MISMATCH", "device-auth receipt is not isolated to this run");
  await output({ modelBacked: true, developerSessionImported: false, automationUser: expected.automationUser, runId: expected.runId, accountCount: 1 }, request.maxOutputBytes); process.exit(0);
}
if (request.operation === "stage_task_surfaces") {
  const surfaces = request.payload.surfaces;
  if (!fields(surfaces, ["desktop", "mcp", "native"])) die(65, "INVALID_CONTRACT", "three-surface staging set is incomplete");
  for (const [name, value] of Object.entries(surfaces)) {
    if (!fields(value, ["fencingToken", "lifecycle", "observedAt", "producer", "runId", "schemaVersion", "taskId", "title"]) || value.schemaVersion !== 1 || value.runId !== expected.runId || value.fencingToken !== expected.fencingToken || Date.now() - Date.parse(value.observedAt) > 30_000 || Date.parse(value.observedAt) - Date.now() > 5_000) die(77, "THREE_SURFACE_IDENTITY_MISMATCH", `${name} observation is stale or identity-mismatched`);
    await atomicObservation(at(`/var/lib/nelos-desktop/observations/${name}.json`), value);
  }
  await output({ staged: true }, request.maxOutputBytes); process.exit(0);
}
if (request.operation === "stage_archive_observations") {
  const observations = request.payload.observations;
  if (!["afterCleanup", "afterRestart"].includes(request.payload.phase) || !fields(observations, ["desktop", "mcp", "native", "workers"])) die(65, "INVALID_CONTRACT", "archive staging set is incomplete");
  for (const [name, value] of Object.entries(observations)) {
    if (value?.schemaVersion !== 1 || value.runId !== expected.runId || value.fencingToken !== expected.fencingToken || Date.now() - Date.parse(value.observedAt) > 30_000 || Date.parse(value.observedAt) - Date.now() > 5_000) die(77, "ARCHIVE_OBSERVATION_MISMATCH", `${name} archive observation is stale or identity-mismatched`);
    await atomicObservation(at(`/var/lib/nelos-desktop/archive-observations/${name}.json`), value);
  }
  await output({ staged: true }, request.maxOutputBytes); process.exit(0);
}
if (request.operation === "compare_task_surfaces") {
  const names = ["native", "mcp", "desktop"]; let values;
  try { values = await Promise.all(names.map((name) => trusted(at(`/var/lib/nelos-desktop/observations/${name}.json`), 65_536))); }
  catch { die(69, "OBSERVATION_UNAVAILABLE", "one or more task surfaces are unavailable"); }
  const expectedTask = { taskId: request.payload.taskId, title: request.payload.title, lifecycle: request.payload.lifecycle, runId: expected.runId, fencingToken: expected.fencingToken };
  if (values.some((value) => !fields(value, ["fencingToken", "lifecycle", "observedAt", "producer", "runId", "schemaVersion", "taskId", "title"]) || Date.now() - Date.parse(value.observedAt) > 30_000 || Object.entries(expectedTask).some(([key, item]) => value[key] !== item))) die(77, "THREE_SURFACE_IDENTITY_MISMATCH", "native, MCP, and visible Desktop observations disagree or are stale");
  await output({ matched: true, taskId: request.payload.taskId, lifecycle: request.payload.lifecycle }, request.maxOutputBytes); process.exit(0);
}
if (request.operation === "diagnostics") {
  let ready; try { ready = await trusted(at("/var/lib/nelos-desktop/gui-ready.json"), 16_384); } catch { die(69, "GUI_NOT_READY", "graphical readiness receipt is unavailable"); }
  await output({ source: "desktop_runtime", code: "DESKTOP_READY", occurredAt: new Date().toISOString(), fields: { component: "production_gui", event: "checkpoint", status: ready.ready ? "ready" : "unready", outcome: ready.accessibilityBus && ready.captureReady ? "passed" : "failed" } }, request.maxOutputBytes); process.exit(0);
}

try {
  const payload = Buffer.from(`${JSON.stringify({ schemaVersion: 1, binding: expected, operation: request.operation, payload: request.payload, bytesBase64: raw.toString("base64") })}\n`);
  const stdout = await runControl(control, request.operation, payload, remaining, request.maxOutputBytes);
  payload.fill(0);
  const value = JSON.parse(stdout);
  await output(value, request.maxOutputBytes);
} catch (error) { die(error.killed ? 75 : error.code === "ENOENT" ? 69 : 70, error.killed ? "DEADLINE_EXPIRED" : error.code === "ENOENT" ? "GUI_NOT_READY" : "HELPER_FAILED", "bounded accessibility operation failed"); }
