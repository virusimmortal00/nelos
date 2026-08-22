#!/usr/lib/chatgpt/resources/cua_node/bin/node
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";

const root = process.env.NELOS_DESKTOP_HELPER_ROOT || "/";
const at = (path) => root === "/" ? path : `${root}${path}`;
const control = process.env.NELOS_ARCHIVE_CONTROL || "/usr/libexec/nelos-archive-control";
const operations = new Set(["archive_tasks", "restart_desktop", "reconcile_convergence"]);
const BINDING_FIELDS = ["automationUser", "fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "stateRoot", "vmId"];
function die(exitCode, code, message) { process.stderr.write(`${JSON.stringify({ error: code, message })}\n`); process.exit(exitCode); }
function fields(value, expected) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"); }
function sameBinding(left, right) { return fields(left, BINDING_FIELDS) && fields(right, BINDING_FIELDS) && BINDING_FIELDS.every((field) => left[field] === right[field]); }
async function trusted(path, max = 16_384) { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (root === "/" && (info.uid !== 0 || (info.mode & 0o022) !== 0)) || info.size > max) throw new Error("untrusted"); return JSON.parse(await readFile(path, "utf8")); }
function runControl(executable, operation, inputBytes, timeout, maxOutputBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [operation], { shell: false, stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
    const chunks = []; let size = 0; let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(rejectPromise, Object.assign(new Error("control deadline"), { killed: true })); }, timeout);
    child.once("error", (error) => finish(rejectPromise, error));
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > maxOutputBytes) { child.kill("SIGKILL"); finish(rejectPromise, Object.assign(new Error("control output"), { code: "OUTPUT_LIMIT" })); } else chunks.push(chunk); });
    child.once("close", (code) => code === 0 ? finish(resolvePromise, Buffer.concat(chunks).toString("utf8")) : finish(rejectPromise, Object.assign(new Error("control failure"), { code })));
    child.stdin.end(inputBytes);
  });
}

const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); const input = Buffer.concat(chunks);
const newline = input.indexOf(0x0a); if (newline < 0 || newline > 65_536 || input.length > 1_048_576) die(65, "INPUT_LIMIT", "archive request exceeds its bound");
let request; let expected;
try { request = JSON.parse(input.subarray(0, newline)); expected = await trusted(at("/etc/nelos-desktop/run-binding.json")); } catch { die(70, "HELPER_UNAVAILABLE", "trusted archive binding is unavailable"); }
if (!fields(request, ["binding", "byteLength", "deadlineAt", "maxOutputBytes", "operation", "payload", "schemaVersion"]) || request.schemaVersion !== 1 || !sameBinding(request.binding, expected) || request.operation !== process.argv[2] || !operations.has(request.operation) || request.byteLength !== input.length - newline - 1) die(77, "IDENTITY_MISMATCH", "archive request identity or operation differs");
const remaining = Date.parse(request.deadlineAt) - Date.now(); if (remaining <= 0 || remaining > 3_600_000 || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 10_485_760) die(75, "DEADLINE_EXPIRED", "archive deadline or output bound is invalid");
try {
  const stdout = await runControl(control, request.operation, Buffer.from(`${JSON.stringify({ schemaVersion: 1, binding: expected, operation: request.operation, payload: request.payload })}\n`), remaining, request.maxOutputBytes);
  const value = JSON.parse(stdout);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`); if (bytes.length > request.maxOutputBytes) die(65, "OUTPUT_LIMIT", "archive output exceeds its bound"); process.stdout.write(bytes);
} catch (error) { die(error.killed ? 75 : error.code === "ENOENT" ? 69 : 70, error.killed ? "DEADLINE_EXPIRED" : error.code === "ENOENT" ? "ARCHIVE_UNAVAILABLE" : "HELPER_FAILED", "bounded archive operation failed"); }
