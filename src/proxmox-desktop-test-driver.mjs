import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { validateDesktopBundleReviewOutputV1 } from "./proxmox-review-output.mjs";
import { validateDesktopSmokeEvidenceBundleV1 } from "./desktop-smoke-evidence-contract.mjs";
import { validateDesktopSmokeScenarioV1 } from "./desktop-smoke-contract.mjs";
import { canonicalBytes, canonicalDigest } from "./experimentation-contract/index.mjs";

const DRIVER_OPERATIONS = Object.freeze([
  "clone-template-vm", "install-candidate-vm", "read-loaded-identity-vm",
  "execute-scenario-vm", "package-evidence-vm", "destroy-clone-vm",
  "verify-absent-vm", "review-sanitized-bundle",
]);
const OPERATION_SET = new Set(DRIVER_OPERATIONS);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const SUBMISSION_ACTIONS = new Set(["submit-planning", "submit-joined", "submit-durable", "submit-recovery"]);
const CANONICAL_SCENARIOS = new Set(["plugin-availability", "planning-lifecycle", "joined-agent-execution", "durable-task-lifecycle", "attention-recovery"]);
const MAX_INPUT_BYTES = 96 * 1024 * 1024;
const MAX_GUEST_OUTPUT_BYTES = 24 * 1024 * 1024;
const MAX_EVIDENCE_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_OUTPUT_BYTES = 256 * 1024;

export class ProxmoxDesktopDriverError extends Error {
  constructor(code, message, details = null) { super(message); this.name = "ProxmoxDesktopDriverError"; this.code = code; this.details = details; }
}
function fail(code, message, details = null) { throw new ProxmoxDesktopDriverError(code, message, details); }
function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("INVALID_DRIVER_REQUEST", `${label} must be a plain object`);
}
function exact(value, fields, label) {
  plain(value, label); const actual = Object.keys(value).sort(); const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail("INVALID_DRIVER_REQUEST", `${label} has an unsupported shape`);
}
function id(value, label) { if (typeof value !== "string" || !ID.test(value)) fail("INVALID_DRIVER_REQUEST", `${label} is invalid`); return value; }
function integer(value, label, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("INVALID_DRIVER_REQUEST", `${label} is invalid`); return value; }
function absolute(value, label) { if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) fail("INVALID_DRIVER_REQUEST", `${label} must be an absolute path`); return value; }
function same(left, right) { return canonicalDigest(left) === canonicalDigest(right); }
async function boundedRuntime(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((resolvePromise, rejectPromise) => { timer = setTimeout(() => rejectPromise(new ProxmoxDesktopDriverError("PROVIDER_DEADLINE_EXCEEDED", `${label} exceeded its deadline`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
function candidate(value) {
  exact(value, ["version", "digest", "sourceRevision", "packagePath"], "candidate");
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version) || !SHA256.test(value.digest) || !REVISION.test(value.sourceRevision)) fail("INVALID_DRIVER_REQUEST", "candidate identity is invalid");
  absolute(value.packagePath, "candidate.packagePath"); return structuredClone(value);
}
function identity(value, expected, label) {
  exact(value, ["version", "digest", "sourceRevision"], label);
  if (value.version !== expected.version || value.digest !== expected.digest || value.sourceRevision !== expected.sourceRevision) fail("CANDIDATE_IDENTITY_MISMATCH", `${label} does not match the requested candidate`);
  return structuredClone(value);
}
function clone(value, runId = null) {
  exact(value, ["cloneId", "templateRef", "accountId", "guestCodexHome", "runId", "fresh", "templateMaintained", "templateClean"], "clone");
  for (const field of ["cloneId", "templateRef", "accountId", "runId"]) id(value[field], `clone.${field}`);
  absolute(value.guestCodexHome, "clone.guestCodexHome");
  if ((runId !== null && value.runId !== runId) || value.fresh !== true || value.templateMaintained !== true || value.templateClean !== true || !value.cloneId.includes(value.runId) || !value.accountId.includes(value.runId) || !value.guestCodexHome.includes(value.runId)) fail("INVALID_CLONE_ISOLATION", "clone isolation receipt is invalid");
  return structuredClone(value);
}
function operationPayload(value, fields, label) { exact(value, ["operationId", ...fields], label); id(value.operationId, `${label}.operationId`); return value; }

export function validateProxmoxDesktopDriverConfigV1(value) {
  exact(value, ["schemaVersion", "api", "template", "disposable", "ssh", "reviewer", "stateDirectory"], "driver configuration");
  if (value.schemaVersion !== 1) fail("INVALID_DRIVER_CONFIG", "driver configuration schemaVersion must be 1");
  exact(value.api, ["url", "node", "credentialFile", "caFile"], "api configuration");
  if (typeof value.api.url !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/api2\/json$/u.test(value.api.url) || !SAFE_NAME.test(value.api.node)) fail("INVALID_DRIVER_CONFIG", "Proxmox API URL or node is invalid");
  absolute(value.api.credentialFile, "api.credentialFile"); absolute(value.api.caFile, "api.caFile");
  exact(value.template, ["vmid", "name", "maintainedTag", "storageIds"], "template configuration");
  integer(value.template.vmid, "template.vmid", 100, 999999999);
  if (!SAFE_NAME.test(value.template.name) || !SAFE_NAME.test(value.template.maintainedTag) || !Array.isArray(value.template.storageIds) || value.template.storageIds.length < 1 || new Set(value.template.storageIds).size !== value.template.storageIds.length || value.template.storageIds.some((item) => !SAFE_NAME.test(item))) fail("INVALID_DRIVER_CONFIG", "maintained template identity or storage allowlist is invalid");
  exact(value.disposable, ["vmid", "name", "storage", "guestHost", "accountPrefix", "codexHomeRoot"], "disposable configuration");
  integer(value.disposable.vmid, "disposable.vmid", 100, 999999999);
  for (const field of ["name", "storage", "guestHost", "accountPrefix"]) if (!SAFE_NAME.test(value.disposable[field])) fail("INVALID_DRIVER_CONFIG", `disposable.${field} is invalid`);
  absolute(value.disposable.codexHomeRoot, "disposable.codexHomeRoot");
  if (value.disposable.vmid === value.template.vmid || value.disposable.name === value.template.name) fail("INVALID_DRIVER_CONFIG", "disposable VM identity collides with the maintained template");
  exact(value.ssh, ["user", "identityFile", "knownHostsFile", "guestDriver", "stagingRoot"], "ssh configuration");
  if (!SAFE_NAME.test(value.ssh.user)) fail("INVALID_DRIVER_CONFIG", "ssh.user is invalid");
  for (const field of ["identityFile", "knownHostsFile", "guestDriver", "stagingRoot"]) absolute(value.ssh[field], `ssh.${field}`);
  exact(value.reviewer, ["executable"], "reviewer configuration"); absolute(value.reviewer.executable, "reviewer.executable");
  absolute(value.stateDirectory, "stateDirectory");
  return structuredClone(value);
}

class OperationLedger {
  constructor(root) { this.root = root; }
  paths(operationId) { const key = createHash("sha256").update(operationId).digest("hex"); return { pending: join(this.root, `${key}.pending.json`), complete: join(this.root, `${key}.complete.json`) }; }
  async inspect(operationId, requestDigest) {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); const paths = this.paths(operationId);
    const complete = await readFile(paths.complete).catch(() => null);
    if (complete) { const record = JSON.parse(complete); if (record.requestDigest !== requestDigest) fail("OPERATION_ID_COLLISION", "operation ID was previously used for different input"); return { state: "complete", receipt: record.receipt, paths }; }
    const pending = await readFile(paths.pending).catch(() => null);
    if (pending) { const record = JSON.parse(pending); if (record.requestDigest !== requestDigest) fail("OPERATION_ID_COLLISION", "operation ID was previously used for different input"); return { state: "ambiguous", receipt: null, paths }; }
    return { state: "new", receipt: null, paths };
  }
  async dispatch(paths, operationId, requestDigest) { await writeFile(paths.pending, canonicalBytes({ operationId, requestDigest }), { flag: "wx", mode: 0o600 }); }
  async commit(paths, operationId, requestDigest, receipt) { await writeFile(`${paths.pending}.done`, canonicalBytes({ operationId, requestDigest, receipt }), { flag: "wx", mode: 0o600 }); await rename(`${paths.pending}.done`, paths.complete); await rm(paths.pending, { force: true }); }
  identityPath(cloneId) { return join(this.root, `${createHash("sha256").update(`clone:${cloneId}`).digest("hex")}.identity.json`); }
  async bindIdentity(cloneId, value) {
    const path = this.identityPath(cloneId); const bytes = canonicalBytes(value);
    try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; const current = await readFile(path); if (!current.equals(bytes)) fail("CANDIDATE_IDENTITY_MISMATCH", "clone is already bound to a different candidate"); }
  }
  async readIdentity(cloneId) { const bytes = await readFile(this.identityPath(cloneId)).catch(() => null); if (!bytes) fail("CANDIDATE_IDENTITY_MISMATCH", "clone has no controller-bound installed candidate identity"); return JSON.parse(bytes); }
}

async function trustedFile(path, { executable = false, privateFile = false } = {}) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (executable && (info.mode & 0o111) === 0) || (privateFile && (info.mode & 0o077) !== 0)) fail("UNTRUSTED_DRIVER_DEPENDENCY", `required root-protected file is unavailable: ${path}`);
  await access(path, executable ? constants.X_OK : constants.R_OK); return path;
}
async function trustedStateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== resolve(path)) fail("UNTRUSTED_DRIVER_DEPENDENCY", "state directory contains a symlink component");
  let current = path;
  while (true) {
    const info = await lstat(current).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) fail("UNTRUSTED_DRIVER_DEPENDENCY", `state directory ancestry is not root-protected: ${current}`);
    if (current === "/") break; current = dirname(current);
  }
}

function captured(path, args, { input = null, timeoutMs = 60_000, maxOutputBytes = 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(path, args, { env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0); let stderrBytes = 0; let settled = false; let timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) rejectPromise(error); else resolvePromise(value); };
    timer = setTimeout(() => { child.kill("SIGKILL"); finish(new ProxmoxDesktopDriverError("PROVIDER_DEADLINE_EXCEEDED", "provider command exceeded its deadline")); }, timeoutMs); timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); if (stdout.byteLength > maxOutputBytes) { child.kill("SIGKILL"); finish(new ProxmoxDesktopDriverError("OVERSIZED_PROVIDER_OUTPUT", "provider command output exceeded its bound")); } });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.byteLength; if (stderrBytes > 64 * 1024) child.kill("SIGKILL"); });
    child.once("error", () => finish(new ProxmoxDesktopDriverError("PROVIDER_COMMAND_FAILED", "provider command could not start")));
    child.once("close", (code) => code === 0 ? finish(null, stdout) : finish(new ProxmoxDesktopDriverError("PROVIDER_COMMAND_FAILED", "provider command failed")));
    child.stdin.on("error", () => finish(new ProxmoxDesktopDriverError("PROVIDER_COMMAND_FAILED", "provider command closed its input")));
    child.stdin.end(input);
  });
}

export class ProxmoxCommandRuntimeV1 {
  constructor(config) { this.config = validateProxmoxDesktopDriverConfigV1(config); }
  async verifyJq() { await trustedStateDirectory(this.config.stateDirectory); await trustedFile("/usr/bin/jq", { executable: true }); await captured("/usr/bin/jq", ["--version"], { maxOutputBytes: 256 }); }
  async #api(method, path, body = null) {
    await trustedFile("/usr/bin/curl", { executable: true }); await trustedFile(this.config.api.caFile); await trustedFile(this.config.api.credentialFile, { privateFile: true });
    const credential = (await readFile(this.config.api.credentialFile, "utf8")).trim();
    if (!/^PVEAPIToken=[^\r\n]{1,1024}$/u.test(credential)) fail("INVALID_DRIVER_CREDENTIAL", "Proxmox credential file is malformed");
    const escapedCredential = credential.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const curlConfig = Buffer.from(`header = "Authorization: ${escapedCredential}"\n`, "utf8");
    const args = ["--config", "-", "--silent", "--show-error", "--fail-with-body", "--proto", "=https", "--tlsv1.2", "--cacert", this.config.api.caFile, "--request", method];
    if (body !== null) args.push("--header", "Content-Type: application/x-www-form-urlencoded", "--data-binary", new URLSearchParams(body).toString());
    args.push(`${this.config.api.url}${path}`);
    const bytes = await captured("/usr/bin/curl", args, { input: curlConfig, timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
    let parsed; try { parsed = JSON.parse(bytes); } catch { fail("INVALID_PROXMOX_RECEIPT", "Proxmox API returned invalid JSON"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => key !== "data") || !("data" in parsed)) fail("INVALID_PROXMOX_RECEIPT", "Proxmox API response shape is unsupported");
    return parsed.data;
  }
  listResources() { return this.#api("GET", "/cluster/resources?type=vm"); }
  getVmConfig(vmid) { return this.#api("GET", `/nodes/${encodeURIComponent(this.config.api.node)}/qemu/${vmid}/config?current=1`); }
  listStorage() { return this.#api("GET", `/nodes/${encodeURIComponent(this.config.api.node)}/storage?enabled=1`); }
  async #task(method, path, body, timeoutMs) {
    const upid = await this.#api(method, path, body); if (typeof upid !== "string" || !/^UPID:[A-Za-z0-9:._-]+$/u.test(upid)) fail("INVALID_PROXMOX_RECEIPT", "Proxmox mutation did not return one task identity");
    const started = Date.now(); const node = encodeURIComponent(this.config.api.node); const task = encodeURIComponent(upid);
    while (Date.now() - started < timeoutMs) {
      const status = await this.#api("GET", `/nodes/${node}/tasks/${task}/status`);
      if (status?.status === "stopped") { if (status.exitstatus !== "OK") fail("PROXMOX_TASK_FAILED", "Proxmox task completed unsuccessfully"); return; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
    fail("PROVIDER_DEADLINE_EXCEEDED", "Proxmox task exceeded its deadline");
  }
  async cloneVm() { const { template, disposable, api } = this.config; await this.#task("POST", `/nodes/${encodeURIComponent(api.node)}/qemu/${template.vmid}/clone`, { newid: String(disposable.vmid), name: disposable.name, full: "1", storage: disposable.storage, target: api.node }, 20 * 60_000); }
  async startVm() {
    const { disposable, api } = this.config; await this.#task("POST", `/nodes/${encodeURIComponent(api.node)}/qemu/${disposable.vmid}/status/start`, {}, 5 * 60_000);
    const started = Date.now(); while (Date.now() - started < 5 * 60_000) { try { await this.#api("POST", `/nodes/${encodeURIComponent(api.node)}/qemu/${disposable.vmid}/agent/ping`, {}); return; } catch {} await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000)); }
    fail("PROVIDER_DEADLINE_EXCEEDED", "disposable guest agent did not become ready");
  }
  async destroyVm() { const { disposable, api } = this.config; await this.#task("DELETE", `/nodes/${encodeURIComponent(api.node)}/qemu/${disposable.vmid}?destroy-unreferenced-disks=1&purge=1`, null, 5 * 60_000); }
  async #sshArgs() {
    await trustedFile("/usr/bin/ssh", { executable: true }); await trustedFile(this.config.ssh.identityFile, { privateFile: true }); await trustedFile(this.config.ssh.knownHostsFile);
    return ["-F", "/dev/null", "-i", this.config.ssh.identityFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${this.config.ssh.knownHostsFile}`, "-o", "LogLevel=ERROR", `${this.config.ssh.user}@${this.config.disposable.guestHost}`];
  }
  async guest(operation, payload, { timeoutMs = 15 * 60_000, maxOutputBytes = MAX_GUEST_OUTPUT_BYTES } = {}) {
    const args = await this.#sshArgs(); args.push(this.config.ssh.guestDriver, operation);
    const bytes = await captured("/usr/bin/ssh", args, { input: canonicalBytes({ schemaVersion: 1, operation, payload }), timeoutMs, maxOutputBytes });
    let receipt; try { receipt = JSON.parse(bytes); } catch { fail("INVALID_GUEST_RECEIPT", "guest driver returned invalid JSON"); } return receipt;
  }
  async stageCandidate(packagePath, runId) {
    await trustedFile("/usr/bin/scp", { executable: true }); const ssh = await this.#sshArgs();
    const sshOptions = ssh.slice(0, -1); const destination = `${ssh.at(-1)}:${this.config.ssh.stagingRoot}/${runId}`;
    await captured("/usr/bin/scp", [...sshOptions, "-r", "--", packagePath, destination], { timeoutMs: 10 * 60_000, maxOutputBytes: 1024 });
    return `${this.config.ssh.stagingRoot}/${runId}`;
  }
  review(context) { return trustedFile(this.config.reviewer.executable, { executable: true }).then(() => captured(this.config.reviewer.executable, [], { input: canonicalBytes(context), timeoutMs: 5 * 60_000, maxOutputBytes: MAX_REVIEW_OUTPUT_BYTES })).then((bytes) => { try { return JSON.parse(bytes); } catch { fail("MALFORMED_REVIEW_OUTPUT", "reviewer returned invalid JSON"); } }); }
}

function validateResources(resources, config) {
  if (!Array.isArray(resources)) fail("INVALID_PROXMOX_RECEIPT", "Proxmox VM inventory is invalid");
  const templateMatches = resources.filter((item) => item?.vmid === config.template.vmid || item?.name === config.template.name);
  if (templateMatches.length !== 1 || templateMatches[0].vmid !== config.template.vmid || templateMatches[0].name !== config.template.name || templateMatches[0].node !== config.api.node || templateMatches[0].template !== 1) fail("TEMPLATE_IDENTITY_AMBIGUOUS", "maintained Proxmox template identity is absent or ambiguous");
  if (resources.some((item) => item?.vmid === config.disposable.vmid || item?.name === config.disposable.name)) fail("CLONE_COLLISION", "designated disposable VM identity is already in use");
}
function validateTemplateConfig(value, config) {
  plain(value, "template API config");
  const tags = String(value.tags ?? "").split(/[;,]/u).filter(Boolean);
  if (value.template !== 1 || value.name !== config.template.name || !tags.includes(config.template.maintainedTag)) fail("UNMAINTAINED_TEMPLATE", "template does not carry the configured maintained identity");
  const volumes = Object.entries(value).filter(([key]) => /^(?:scsi|sata|ide|virtio)\d+$/u.test(key)).map(([, disk]) => String(disk).split(":", 1)[0]);
  if (volumes.length < 1 || volumes.some((storage) => !config.template.storageIds.includes(storage))) fail("TEMPLATE_STORAGE_MISMATCH", "template disk storage is outside the maintained allowlist");
}
function validateStorage(value, config) {
  if (!Array.isArray(value)) fail("INVALID_PROXMOX_RECEIPT", "Proxmox storage inventory is invalid");
  const storage = value.filter((item) => item?.storage === config.disposable.storage);
  if (storage.length !== 1 || storage[0].active !== 1 || storage[0].enabled !== 1 || !String(storage[0].content ?? "").split(",").includes("images")) fail("DISPOSABLE_STORAGE_UNAVAILABLE", "configured disposable storage is absent, ambiguous, inactive, or lacks images content");
}
function scenarioReceipt(value, scenario, operationId) {
  exact(value, ["scenarioId", "operationId", "outcome", "failure", "assertionResults", "actionReceipts"], "scenario receipt");
  if (value.scenarioId !== scenario.scenarioId || value.operationId !== operationId || !["passed", "failed", "timed_out", "crashed"].includes(value.outcome) || !Array.isArray(value.assertionResults) || !Array.isArray(value.actionReceipts) || value.actionReceipts.length !== scenario.actions.length) fail("INVALID_GUEST_RECEIPT", "scenario receipt identity or cardinality is invalid");
  const actions = new Map(scenario.actions.map((item) => [item.actionId, item])); const seen = new Set();
  for (const item of value.actionReceipts) {
    exact(item, ["actionId", "outcome", "attempts", "submissionState"], "action receipt"); const action = actions.get(item.actionId);
    if (!action || seen.has(item.actionId) || !["completed", "failed", "timed_out", "skipped"].includes(item.outcome) || !Number.isSafeInteger(item.attempts) || item.attempts < 1 || item.attempts > 2) fail("INVALID_GUEST_RECEIPT", "action receipt is invalid");
    const submission = SUBMISSION_ACTIONS.has(item.actionId);
    if ((submission && (item.attempts !== 1 || !["not_submitted", "submitted"].includes(item.submissionState))) || (!submission && item.submissionState !== "not_applicable")) fail("AMBIGUOUS_SUBMISSION_RECEIPT", "submission retry or disposition is unsafe");
    seen.add(item.actionId);
  }
  if (value.failure !== null) { exact(value.failure, ["code"], "scenario failure"); id(value.failure.code, "scenario failure code"); }
  return structuredClone(value);
}
function reviewContext(value) {
  exact(value, ["schemaVersion", "manifestContext", "screenshots"], "sanitized review context");
  if (value.schemaVersion !== 1 || !Array.isArray(value.screenshots) || value.screenshots.length > 512) fail("INVALID_REVIEW_INPUT", "sanitized review context is invalid");
  exact(value.manifestContext, ["bundleId", "runId", "bundleDigest", "format", "totals"], "review manifest context");
  id(value.manifestContext.bundleId, "review bundleId"); id(value.manifestContext.runId, "review runId");
  if (!SHA256.test(value.manifestContext.bundleDigest) || value.manifestContext.format !== "nelos-desktop-smoke-evidence-v1") fail("INVALID_REVIEW_INPUT", "review manifest identity is invalid");
  exact(value.manifestContext.totals, ["recordCount", "fileCount", "fileBytes", "diagnosticCount", "diagnosticBytes"], "review manifest totals");
  for (const [field, amount] of Object.entries(value.manifestContext.totals)) integer(amount, `review manifest totals.${field}`, 0, 96 * 1024 * 1024);
  let total = 0;
  for (const shot of value.screenshots) {
    exact(shot, ["artifactId", "scenarioId", "checkpointId", "evidenceDigest", "mediaType", "byteLength", "width", "height", "bytes"], "review screenshot");
    for (const field of ["artifactId", "scenarioId", "checkpointId"]) id(shot[field], `review screenshot.${field}`);
    if (!SHA256.test(shot.evidenceDigest) || !["image/png", "image/jpeg", "image/webp"].includes(shot.mediaType)) fail("INVALID_REVIEW_INPUT", "review screenshot metadata is invalid");
    const bytes = Buffer.isBuffer(shot.bytes) ? shot.bytes : shot.bytes?.type === "Buffer" && Array.isArray(shot.bytes.data) ? Buffer.from(shot.bytes.data) : fail("INVALID_REVIEW_INPUT", "review screenshot bytes are invalid");
    integer(shot.byteLength, "review screenshot.byteLength", 1, 16 * 1024 * 1024); integer(shot.width, "review screenshot.width", 1, 16384); integer(shot.height, "review screenshot.height", 1, 16384);
    if (bytes.byteLength !== shot.byteLength || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== shot.evidenceDigest) fail("INVALID_REVIEW_INPUT", "review screenshot digest is invalid"); total += bytes.byteLength;
  }
  if (total > 64 * 1024 * 1024) fail("INVALID_REVIEW_INPUT", "review screenshots exceed the aggregate byte limit");
  return structuredClone(value);
}

export function createProxmoxDesktopDriverV1({ config, runtime, scenarioLibrary }) {
  const settings = validateProxmoxDesktopDriverConfigV1(config); const ledger = new OperationLedger(settings.stateDirectory);
  if (!runtime || typeof runtime.verifyJq !== "function") fail("INVALID_DRIVER_CONFIG", "runtime must explicitly verify jq");
  if (!scenarioLibrary || scenarioLibrary.schemaVersion !== 1 || scenarioLibrary.scenarioSetId !== "release" || !Array.isArray(scenarioLibrary.scenarios) || scenarioLibrary.scenarios.length !== 5 || scenarioLibrary.scenarios.reduce((sum, item) => sum + item.actions.length, 0) !== 19 || scenarioLibrary.scenarios.filter((item) => item.actions.some(({ actionId }) => SUBMISSION_ACTIONS.has(actionId))).length !== 4) fail("INVALID_DRIVER_CONFIG", "canonical five-scenario/19-action release library is unavailable");
  const scenarios = new Map(scenarioLibrary.scenarios.map((item) => [item.scenarioId, validateDesktopSmokeScenarioV1(item)]));
  if (scenarios.size !== 5 || [...CANONICAL_SCENARIOS].some((scenarioId) => !scenarios.has(scenarioId))) fail("INVALID_DRIVER_CONFIG", "canonical release scenario identities are invalid");

  async function idempotent(operationId, payload, work, { preflight = async () => undefined } = {}) {
    const requestDigest = canonicalDigest(payload); const observed = await ledger.inspect(operationId, requestDigest);
    if (observed.state === "complete") return structuredClone(observed.receipt);
    if (observed.state === "ambiguous") fail("AMBIGUOUS_AFTER_DISPATCH", "operation was dispatched without a durable receipt", { retryDisposition: "ambiguous_after_dispatch" });
    const prepared = await preflight();
    await ledger.dispatch(observed.paths, operationId, requestDigest);
    const receipt = await work(prepared); await ledger.commit(observed.paths, operationId, requestDigest, receipt); return receipt;
  }

  return Object.freeze({
    async dispatch(request) {
      exact(request, ["schemaVersion", "operation", "payload"], "driver request");
      if (request.schemaVersion !== 1 || !OPERATION_SET.has(request.operation)) fail("INVALID_DRIVER_REQUEST", "driver operation is unsupported");
      await runtime.verifyJq();
      const payload = request.payload;
      switch (request.operation) {
        case "clone-template-vm": {
          operationPayload(payload, ["runId", "candidate", "scenarioSetId"], "clone request"); id(payload.runId, "runId"); candidate(payload.candidate);
          if (payload.scenarioSetId !== "release" && payload.scenarioSetId !== "routine") fail("INVALID_DRIVER_REQUEST", "scenario set is unsupported");
          return idempotent(payload.operationId, payload, async () => {
            await runtime.cloneVm(); await runtime.startVm();
            const accountId = `${settings.disposable.accountPrefix}-${payload.runId}`; const guestCodexHome = `${settings.disposable.codexHomeRoot}/${payload.runId}`;
            const prepared = await boundedRuntime(() => runtime.guest("prepare-clone", { schemaVersion: 1, operationId: payload.operationId, runId: payload.runId, accountId, guestCodexHome }, { timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 }), 10 * 60_000, "guest preparation");
            exact(prepared, ["prepared", "accountId", "guestCodexHome"], "guest preparation receipt");
            if (prepared.prepared !== true || prepared.accountId !== accountId || prepared.guestCodexHome !== guestCodexHome) fail("INVALID_CLONE_ISOLATION", "guest did not prove isolated account and CODEX_HOME preparation");
            return { cloneId: `${settings.disposable.name}-${payload.runId}`, templateRef: `${settings.api.node}:${settings.template.vmid}:${settings.template.name}`, accountId, guestCodexHome, runId: payload.runId, fresh: true, templateMaintained: true, templateClean: true };
          }, { preflight: async () => { const resources = await runtime.listResources(); validateResources(resources, settings); validateTemplateConfig(await runtime.getVmConfig(settings.template.vmid), settings); validateStorage(await runtime.listStorage(), settings); } });
        }
        case "install-candidate-vm": {
          operationPayload(payload, ["clone", "candidate"], "install request"); const expected = candidate(payload.candidate); const machine = clone(payload.clone);
          return idempotent(payload.operationId, payload, async () => {
            const stagedPath = await runtime.stageCandidate(expected.packagePath, machine.runId);
            const receipt = await boundedRuntime(() => runtime.guest("install-candidate", { schemaVersion: 1, operationId: payload.operationId, cloneId: machine.cloneId, accountId: machine.accountId, guestCodexHome: machine.guestCodexHome, stagedPath, candidate: { version: expected.version, digest: expected.digest, sourceRevision: expected.sourceRevision } }, { timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 }), 10 * 60_000, "candidate installation");
            exact(receipt, ["identity", "digestVerified", "exclusive"], "installation receipt"); identity(receipt.identity, expected, "installed identity");
            if (receipt.digestVerified !== true || receipt.exclusive !== true) fail("CANDIDATE_IDENTITY_MISMATCH", "guest did not prove exact exclusive candidate installation");
            await ledger.bindIdentity(machine.cloneId, { version: expected.version, digest: expected.digest, sourceRevision: expected.sourceRevision }); return structuredClone(receipt);
          });
        }
        case "read-loaded-identity-vm": {
          operationPayload(payload, ["clone"], "identity request"); const machine = clone(payload.clone);
          return idempotent(payload.operationId, payload, async () => {
            const expected = await ledger.readIdentity(machine.cloneId);
            const result = await boundedRuntime(() => runtime.guest("launch-and-read-loaded-identity", { schemaVersion: 1, operationId: payload.operationId, cloneId: machine.cloneId, accountId: machine.accountId, guestCodexHome: machine.guestCodexHome }, { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 }), 60_000, "Desktop identity inspection");
            exact(result, ["requestedCandidate", "loadedIdentity", "desktopLaunched", "exclusive"], "loaded identity receipt");
            exact(result.requestedCandidate, ["version", "digest", "sourceRevision"], "requested candidate identity"); identity(result.requestedCandidate, expected, "guest requested candidate identity"); identity(result.loadedIdentity, expected, "loaded plugin identity");
            if (result.desktopLaunched !== true || result.exclusive !== true) fail("CANDIDATE_IDENTITY_MISMATCH", "Desktop did not load one exclusive requested plugin"); return structuredClone(result.loadedIdentity);
          });
        }
        case "execute-scenario-vm": {
          operationPayload(payload, ["clone", "scenario", "deadlines", "maxActionAttempts"], "scenario request"); const machine = clone(payload.clone); const supplied = validateDesktopSmokeScenarioV1(payload.scenario); const canonical = scenarios.get(supplied.scenarioId);
          if (!canonical || !same(supplied, canonical)) fail("INVALID_DRIVER_REQUEST", "scenario is not an exact canonical release scenario");
          exact(payload.deadlines, ["scenarioMs", "actionMs"], "scenario deadlines"); integer(payload.deadlines.scenarioMs, "scenarioMs", 1, canonical.deadlineMs); integer(payload.deadlines.actionMs, "actionMs", 1, Math.min(payload.deadlines.scenarioMs, 5 * 60_000)); integer(payload.maxActionAttempts, "maxActionAttempts", 1, 2);
          return idempotent(payload.operationId, payload, async () => scenarioReceipt(await boundedRuntime(() => runtime.guest("execute-canonical-scenario", { schemaVersion: 1, operationId: payload.operationId, cloneId: machine.cloneId, scenario: canonical, deadlines: payload.deadlines, maxActionAttempts: payload.maxActionAttempts, submissionActionIds: [...SUBMISSION_ACTIONS].filter((actionId) => canonical.actions.some((action) => action.actionId === actionId)) }, { timeoutMs: payload.deadlines.scenarioMs, maxOutputBytes: 1024 * 1024 }), payload.deadlines.scenarioMs, "scenario execution"), canonical, payload.operationId));
        }
        case "package-evidence-vm": {
          operationPayload(payload, ["clone", "runId", "scenarioIds"], "package request"); const machine = clone(payload.clone, payload.runId);
          if (!Array.isArray(payload.scenarioIds) || payload.scenarioIds.length < 1 || payload.scenarioIds.some((scenarioId) => !scenarios.has(scenarioId)) || new Set(payload.scenarioIds).size !== payload.scenarioIds.length) fail("INVALID_DRIVER_REQUEST", "package scenario inventory is invalid");
          return idempotent(payload.operationId, payload, async () => {
            const result = await boundedRuntime(() => runtime.guest("package-sanitized-evidence", { schemaVersion: 1, operationId: payload.operationId, cloneId: machine.cloneId, runId: payload.runId, scenarioIds: [...payload.scenarioIds].sort(), maximumBundleBytes: MAX_EVIDENCE_BUNDLE_BYTES }, { timeoutMs: 5 * 60_000, maxOutputBytes: MAX_GUEST_OUTPUT_BYTES }), 5 * 60_000, "evidence packaging");
            exact(result, ["runId", "bundleBase64", "sanitized", "rawCapturesRemoved", "temporaryMaterialRemoved"], "evidence package receipt");
            if (result.runId !== payload.runId || result.sanitized !== true || result.rawCapturesRemoved !== true || result.temporaryMaterialRemoved !== true || typeof result.bundleBase64 !== "string") fail("UNSAFE_FRESH_VM_EVIDENCE", "guest did not prove sanitization and temporary/raw removal");
            const bytes = Buffer.from(result.bundleBase64, "base64"); if (bytes.byteLength > MAX_EVIDENCE_BUNDLE_BYTES || bytes.toString("base64") !== result.bundleBase64) fail("OVERSIZED_FRESH_VM_OUTPUT", "guest evidence encoding or size is invalid");
            const first = validateDesktopSmokeEvidenceBundleV1(bytes); const second = validateDesktopSmokeEvidenceBundleV1(Buffer.from(first.bytes)); if (!first.bytes.equals(second.bytes)) fail("NONDETERMINISTIC_EVIDENCE", "evidence package is not deterministic"); return structuredClone(result);
          });
        }
        case "destroy-clone-vm": {
          operationPayload(payload, ["clone"], "destroy request"); const machine = clone(payload.clone);
          return idempotent(payload.operationId, payload, async () => { await runtime.destroyVm(); return { cloneId: machine.cloneId, destroyed: true }; });
        }
        case "verify-absent-vm": {
          operationPayload(payload, ["clone"], "absence request"); const machine = clone(payload.clone);
          return idempotent(payload.operationId, payload, async () => {
            const resources = await runtime.listResources(); if (!Array.isArray(resources)) fail("INVALID_PROXMOX_RECEIPT", "independent VM inventory is invalid");
            if (resources.some((item) => item?.vmid === settings.disposable.vmid || item?.name === settings.disposable.name)) fail("CLONE_STILL_PRESENT", "independent inventory still contains the disposable VM"); return { cloneId: machine.cloneId, absent: true, independent: true };
          });
        }
        case "review-sanitized-bundle": {
          const context = reviewContext(payload); const output = await boundedRuntime(() => runtime.review(context), 5 * 60_000, "sanitized review"); return validateDesktopBundleReviewOutputV1(output, context.screenshots);
        }
        default: fail("INVALID_DRIVER_REQUEST", "driver operation is unsupported");
      }
    },
  });
}

export async function runProxmoxDesktopDriverCliV1({ input = process.stdin, output = process.stdout, configPath = "/etc/nelos/proxmox-desktop-driver.json", scenarioPath = "/usr/local/lib/nelos-provider-driver/validation/desktop-smoke/scenario-sets/release.json" } = {}) {
  const chunks = []; let bytes = 0;
  for await (const chunk of input) { bytes += chunk.byteLength; if (bytes > MAX_INPUT_BYTES) fail("INVALID_DRIVER_REQUEST", "driver request exceeds its byte limit"); chunks.push(chunk); }
  const wire = Buffer.concat(chunks).toString("utf8"); if (!wire.endsWith("\n") || wire.slice(0, -1).includes("\n") || wire.includes("\0")) fail("INVALID_DRIVER_REQUEST", "driver request framing is invalid");
  let request; try { request = JSON.parse(wire); } catch { fail("INVALID_DRIVER_REQUEST", "driver request is not JSON"); }
  await trustedFile(configPath, { privateFile: true }); await trustedFile(scenarioPath);
  const config = JSON.parse(await readFile(configPath, "utf8")); const scenarioLibrary = JSON.parse(await readFile(scenarioPath, "utf8")); const runtime = new ProxmoxCommandRuntimeV1(config);
  const receipt = await createProxmoxDesktopDriverV1({ config, runtime, scenarioLibrary }).dispatch(request); output.write(`${JSON.stringify(receipt)}\n`);
}
