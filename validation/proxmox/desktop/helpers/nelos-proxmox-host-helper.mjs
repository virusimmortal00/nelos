#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.env.NELOS_DESKTOP_HELPER_ROOT || "/";
const at = (path) => root === "/" ? path : `${root}${path}`;
const bindingPath = at("/etc/nelos-desktop/run-binding.json");
const providerPath = at("/etc/nelos-desktop/provider.json");
const BINDING_FIELDS = ["automationUser", "fencingToken", "hostId", "imageId", "leaseId", "providerId", "runId", "stateRoot", "vmId"];
const BODY_FIELDS = new Set(["agent", "cipassword", "ciuser", "command", "description", "destroy-unreferenced-disks", "extra-args", "full", "input-data", "memory", "name", "net0", "newid", "node", "onboot", "protection", "purge", "sockets", "sshkeys", "tags", "target"]);

function die(exitCode, code, message) {
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exit(exitCode);
}
function sameFields(value, fields) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...fields].sort().join("\0"); }
function safeId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value); }
async function trustedJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (root === "/" && (info.uid !== 0 || (info.mode & 0o022) !== 0)) || info.size > 16_384) throw new Error("untrusted configuration");
  return JSON.parse(await readFile(path, "utf8"));
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 65_536) die(65, "INPUT_LIMIT", "request exceeds 64 KiB");
}
let envelope; let expected; let provider;
try {
  envelope = JSON.parse(input);
  [expected, provider] = await Promise.all([trustedJson(bindingPath), trustedJson(providerPath)]);
} catch { die(70, "HELPER_UNAVAILABLE", "sealed request or trusted binding is unavailable"); }
if (!sameFields(envelope, ["binding", "deadlineAt", "maxOutputBytes", "request", "schemaVersion"]) || envelope.schemaVersion !== 1 ||
    !sameFields(envelope.binding, BINDING_FIELDS) || !sameFields(expected, BINDING_FIELDS) || JSON.stringify(envelope.binding) !== JSON.stringify(expected) ||
    !sameFields(provider, ["hostId", "providerId", "sourceTemplateVmId"]) || provider.hostId !== expected.hostId || provider.providerId !== expected.providerId) {
  die(77, "IDENTITY_MISMATCH", "run, provider, host, VMID, lease, fence, or automation binding differs");
}
if (!BINDING_FIELDS.every((field) => field === "stateRoot" ? typeof expected[field] === "string" : safeId(expected[field])) || !/^[1-9][0-9]{2,8}$/u.test(expected.vmId)) die(77, "IDENTITY_MISMATCH", "trusted binding is invalid");
const remaining = Date.parse(envelope.deadlineAt) - Date.now();
if (!Number.isSafeInteger(envelope.maxOutputBytes) || envelope.maxOutputBytes < 1 || envelope.maxOutputBytes > 16_777_216 || remaining <= 0 || remaining > 600_000) die(75, "DEADLINE_EXPIRED", "deadline or output bound is invalid");
const requestFields = envelope.request?.body === undefined ? ["method", "path"] : ["body", "method", "path"];
if (!sameFields(envelope.request, requestFields) || !["GET", "POST", "PUT", "DELETE"].includes(envelope.request.method) || typeof envelope.request.path !== "string") die(65, "INVALID_CONTRACT", "provider request fields are invalid");

const url = new URL(envelope.request.path, "https://proxmox.invalid");
const decodedPath = decodeURIComponent(url.pathname);
const node = expected.hostId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const vm = expected.vmId;
const template = String(provider.sourceTemplateVmId);
const patterns = [
  ["GET", new RegExp(`^/nodes/${node}/qemu/${vm}/config$`, "u")],
  ["PUT", new RegExp(`^/nodes/${node}/qemu/${vm}/config$`, "u")],
  ["POST", new RegExp(`^/nodes/${node}/qemu/${template}/clone$`, "u")],
  ["POST", new RegExp(`^/nodes/${node}/qemu/${vm}/status/(?:start|stop)$`, "u")],
  ["DELETE", new RegExp(`^/nodes/${node}/qemu/${vm}$`, "u")],
  ["GET", new RegExp(`^/nodes/${node}/tasks/UPID:[A-Za-z0-9:._-]{1,507}/status$`, "u")],
  ["POST", new RegExp(`^/nodes/${node}/qemu/${vm}/agent/exec$`, "u")],
  ["POST", new RegExp(`^/nodes/${node}/qemu/${vm}/agent/(?:ping|get-osinfo|get-users)$`, "u")],
  ["GET", new RegExp(`^/nodes/${node}/qemu/${vm}/agent/exec-status$`, "u")],
  ["GET", /^\/cluster\/resources$/u],
];
if (!patterns.some(([method, pattern]) => method === envelope.request.method && pattern.test(decodedPath))) die(77, "FORBIDDEN_PROVIDER_OPERATION", "provider path or method is not allowlisted");
if (decodedPath === "/cluster/resources" && url.searchParams.get("type") !== "vm") die(77, "FORBIDDEN_PROVIDER_OPERATION", "only VM inventory is allowlisted");
if (decodedPath.endsWith("/agent/exec-status") && !/^[1-9][0-9]{0,9}$/u.test(url.searchParams.get("pid") ?? "")) die(65, "INVALID_CONTRACT", "QGA process identity is invalid");
const body = envelope.request.body ?? {};
if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !BODY_FIELDS.has(key))) die(77, "FORBIDDEN_PROVIDER_OPERATION", "provider body contains a non-allowlisted field");
if (decodedPath.endsWith(`/${template}/clone`) && String(body.newid) !== vm) die(77, "IDENTITY_MISMATCH", "clone target differs from the reserved VMID");

const verb = { GET: "get", POST: "create", PUT: "set", DELETE: "delete" }[envelope.request.method];
const args = [verb, decodedPath, "--output-format", "json"];
for (const [key, value] of url.searchParams) args.push(`--${key}`, value);
for (const [key, value] of Object.entries(body)) args.push(`--${key}`, typeof value === "string" ? value : JSON.stringify(value));
try {
  const { stdout } = await exec("/usr/bin/pvesh", args, { timeout: remaining, maxBuffer: envelope.maxOutputBytes, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
  const text = stdout.trim();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  process.stdout.write(`${JSON.stringify({ data })}\n`);
} catch (error) {
  if (envelope.request.method === "GET" && decodedPath.endsWith(`/${vm}/config`) && (error.code === 2 || /does not exist|not found/iu.test(`${error.stderr ?? ""}`))) process.exit(44);
  die(error.killed ? 75 : 70, error.killed ? "DEADLINE_EXPIRED" : "HELPER_FAILED", "bounded Proxmox operation failed");
}
