#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const bindingPath = "/etc/nelos-desktop/run-binding.json";
const providerPath = "/etc/nelos-desktop/provider.json";
const allowed = new Set(["read", "clone", "start", "stop", "destroy", "task-status"]);
const bindingFields = ["fencingToken", "hostId", "leaseId", "providerId", "runId", "vmid"];

function die(code, message) {
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exit(70);
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 16_384) die("INPUT_LIMIT", "request exceeds 16 KiB");
}
let request;
let expected;
let provider;
try {
  const [bindingStat, providerStat] = await Promise.all([lstat(bindingPath), lstat(providerPath)]);
  if (!bindingStat.isFile() || bindingStat.isSymbolicLink() || bindingStat.uid !== 0 || (bindingStat.mode & 0o022) !== 0 ||
      !providerStat.isFile() || providerStat.isSymbolicLink() || providerStat.uid !== 0 || (providerStat.mode & 0o022) !== 0) throw new Error("untrusted configuration");
  request = JSON.parse(input);
  expected = JSON.parse(await readFile(bindingPath, "utf8"));
  provider = JSON.parse(await readFile(providerPath, "utf8"));
} catch { die("HELPER_UNAVAILABLE", "sealed request or binding unavailable"); }
if (JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(["binding", "deadlineAt", "maxOutputBytes", "operation", "taskId"]) ||
    JSON.stringify(Object.keys(request.binding ?? {}).sort()) !== JSON.stringify(bindingFields) ||
    JSON.stringify(Object.keys(expected ?? {}).sort()) !== JSON.stringify(bindingFields) ||
    JSON.stringify(Object.keys(provider ?? {}).sort()) !== JSON.stringify(["hostId", "providerId", "sourceTemplateVmid"])) die("INVALID_CONTRACT", "request or configuration fields differ");
if (!allowed.has(request.operation) || bindingFields.some((field) => request.binding[field] !== expected[field]) ||
    provider.hostId !== expected.hostId || provider.providerId !== expected.providerId || !Number.isSafeInteger(expected.vmid) || expected.vmid < 100 ||
    !Number.isSafeInteger(provider.sourceTemplateVmid) || provider.sourceTemplateVmid < 100) die("IDENTITY_MISMATCH", "operation, provider, host, VMID, lease, or fence denied");
if ((request.operation === "task-status") !== (typeof request.taskId === "string" && /^UPID:[A-Za-z0-9:._-]{1,507}$/u.test(request.taskId))) die("INVALID_CONTRACT", "task identity is required only for task-status");
const remaining = Date.parse(request.deadlineAt) - Date.now();
if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 1_048_576 || remaining <= 0 || remaining > 600_000) die("DEADLINE_EXPIRED", "deadline or output bound invalid");
const base = ["nodes", expected.hostId, "qemu", String(expected.vmid)];
const command = request.operation === "read" ? ["get", ...base, "status", "current", "--output-format", "json"]
  : request.operation === "task-status" ? ["get", "nodes", expected.hostId, "tasks", request.taskId, "status", "--output-format", "json"]
  : request.operation === "clone" ? ["create", "nodes", expected.hostId, "qemu", String(provider.sourceTemplateVmid), "clone", "--newid", String(expected.vmid), "--full", "1"]
    : request.operation === "destroy" ? ["delete", ...base]
      : ["create", ...base, "status", request.operation];
try {
  const { stdout } = await exec("/usr/bin/pvesh", command, { timeout: remaining, maxBuffer: request.maxOutputBytes, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
  process.stdout.write(stdout);
} catch (error) {
  if (request.operation === "read" && error.code === 2 && /does not exist|not found/iu.test(`${error.stderr ?? ""}`)) process.exit(44);
  die(error.killed ? "DEADLINE_EXPIRED" : "HELPER_FAILED", "bounded Proxmox operation failed");
}
