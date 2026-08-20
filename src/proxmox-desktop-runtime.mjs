import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TERMINAL_TASK_STATES = new Set(["stopped", "completed", "failed"]);
const ALLOWED_GUEST_OPERATIONS = new Set(["auth-status", "gui-ready", "capture", "diagnostics"]);
const ALLOWED_HOST_OPERATIONS = new Set(["read", "clone", "start", "stop", "destroy"]);

export class ProxmoxDesktopError extends Error {
  constructor(code, message, path = "") {
    super(message);
    this.name = "ProxmoxDesktopError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "") {
  throw new ProxmoxDesktopError(code, message, path);
}

function object(value, fields, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_CONTRACT", "expected object", path);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("INVALID_CONTRACT", "object fields do not match closed contract", path);
  }
  return value;
}

function string(value, path, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) fail("INVALID_CONTRACT", "invalid string", path);
  return value;
}

function integer(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("INVALID_CONTRACT", "invalid integer", path);
  return value;
}

function exact(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : canonical(value));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function providerStatus(error) {
  return error?.status ?? error?.statusCode ?? error?.response?.status;
}

export async function readProxmoxVm(provider, binding) {
  if (typeof provider?.readVm !== "function") fail("HELPER_UNAVAILABLE", "provider read helper is unavailable", "/provider/readVm");
  validateBinding(binding);
  try {
    const vm = await provider.readVm(binding);
    if (vm === null || typeof vm !== "object" || Array.isArray(vm)) fail("AMBIGUOUS_EFFECT", "provider returned an ambiguous VM read");
    return vm;
  } catch (error) {
    if (providerStatus(error) === 404) return null;
    throw error;
  }
}

export async function mutateProxmoxVm(provider, operation, binding, {
  deadlineMs = 120_000,
  pollIntervalMs = 1_000,
  now = Date.now,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  if (!ALLOWED_HOST_OPERATIONS.has(operation) || operation === "read") fail("OPERATION_DENIED", "host operation is not allowlisted", "/operation");
  validateBinding(binding);
  if (typeof provider?.mutateVm !== "function" || typeof provider?.readTask !== "function") {
    fail("HELPER_UNAVAILABLE", "provider mutation helpers are unavailable", "/provider");
  }
  integer(deadlineMs, "/deadlineMs", 1, 600_000);
  integer(pollIntervalMs, "/pollIntervalMs", 1, deadlineMs);
  const started = now();
  const accepted = await provider.mutateVm(operation, binding);
  if (accepted === null || typeof accepted !== "object" || typeof accepted.taskId !== "string" || !ID.test(accepted.taskId)) {
    fail("AMBIGUOUS_EFFECT", "provider mutation did not return one task identity");
  }
  let polls = 0;
  while (now() - started <= deadlineMs) {
    const task = await provider.readTask({ ...binding, taskId: accepted.taskId });
    polls += 1;
    if (task === null || typeof task !== "object" || Array.isArray(task) || typeof task.state !== "string") {
      fail("AMBIGUOUS_EFFECT", "provider task observation is ambiguous");
    }
    if (TERMINAL_TASK_STATES.has(task.state)) {
      if ((task.state === "completed" || task.state === "stopped") && task.exitStatus === "OK") {
        return Object.freeze({ operation, taskId: accepted.taskId, terminalState: task.state, exitStatus: task.exitStatus ?? "OK", polls });
      }
      fail("PROVIDER_TASK_FAILED", `provider task ${accepted.taskId} ended in ${task.state}:${task.exitStatus ?? "unknown"}`);
    }
    await wait(pollIntervalMs);
  }
  fail("PROVIDER_TASK_TIMEOUT", `provider task ${accepted.taskId} did not reach a terminal result before its deadline`);
}

export function validateBinding(binding, path = "/binding") {
  object(binding, ["fencingToken", "hostId", "leaseId", "providerId", "runId", "vmid"], path);
  for (const field of ["runId", "providerId", "hostId", "leaseId", "fencingToken"]) string(binding[field], `${path}/${field}`);
  integer(binding.vmid, `${path}/vmid`, 100, 999_999_999);
  return binding;
}

export function validateHelperRequest(request, expected, { now = Date.now() } = {}) {
  object(request, ["binding", "deadlineAt", "maxOutputBytes", "operation"], "/request");
  validateBinding(request.binding, "/request/binding");
  validateBinding(expected, "/expected");
  if (![...ALLOWED_HOST_OPERATIONS, ...ALLOWED_GUEST_OPERATIONS].includes(request.operation)) fail("OPERATION_DENIED", "helper operation is not allowlisted", "/request/operation");
  integer(request.maxOutputBytes, "/request/maxOutputBytes", 1, 1_048_576);
  if (typeof request.deadlineAt !== "string" || !Number.isFinite(Date.parse(request.deadlineAt)) || Date.parse(request.deadlineAt) <= now) {
    fail("DEADLINE_EXPIRED", "helper deadline is invalid or expired", "/request/deadlineAt");
  }
  if (Date.parse(request.deadlineAt) - now > 600_000) fail("INVALID_CONTRACT", "helper deadline exceeds ten minutes", "/request/deadlineAt");
  for (const field of Object.keys(expected)) {
    if (request.binding[field] !== expected[field]) fail("IDENTITY_MISMATCH", `helper binding differs at ${field}`, `/request/binding/${field}`);
  }
  return request;
}

function validateLease(lease, binding, now) {
  object(lease, ["active", "binding", "expiresAt", "observedAt"], "/packet/lease");
  validateBinding(lease.binding, "/packet/lease/binding");
  if (lease.active !== true || Object.keys(binding).some((field) => lease.binding[field] !== binding[field])) {
    fail("LEASE_NOT_CURRENT", "packet lease or fencing token is not current", "/packet/lease");
  }
  const observed = Date.parse(lease.observedAt);
  const expires = Date.parse(lease.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now + 5_000 || now - observed > 30_000 || expires <= now || observed >= expires) {
    fail("STALE_OBSERVATION", "lease observation is stale or expired", "/packet/lease");
  }
}

export function validateRunPacket(envelope, { now = Date.now(), authorize } = {}) {
  object(envelope, ["digest", "packet"], "/envelope");
  string(envelope.digest, "/envelope/digest", SHA256);
  if (!exact(envelope.digest, sha256(envelope.packet))) fail("PACKET_DIGEST_MISMATCH", "run packet is not content-addressed", "/envelope/digest");
  const packet = envelope.packet;
  object(packet, ["authorization", "binding", "budgets", "capture", "expectedTask", "lease", "roots", "schemaVersion"], "/packet");
  if (packet.schemaVersion !== 1) fail("INVALID_CONTRACT", "unsupported run packet schema", "/packet/schemaVersion");
  validateBinding(packet.binding, "/packet/binding");
  validateLease(packet.lease, packet.binding, now);
  object(packet.expectedTask, ["taskId", "title"], "/packet/expectedTask");
  string(packet.expectedTask.taskId, "/packet/expectedTask/taskId");
  string(packet.expectedTask.title, "/packet/expectedTask/title", /^.{1,160}$/u);
  object(packet.budgets, ["captureCount", "runDeadlineAt", "stepDeadlineMs"], "/packet/budgets");
  integer(packet.budgets.captureCount, "/packet/budgets/captureCount", 1, 100);
  integer(packet.budgets.stepDeadlineMs, "/packet/budgets/stepDeadlineMs", 1, 600_000);
  const runDeadline = Date.parse(packet.budgets.runDeadlineAt);
  if (!Number.isFinite(runDeadline) || runDeadline <= now) fail("DEADLINE_EXPIRED", "run deadline is expired", "/packet/budgets/runDeadlineAt");
  object(packet.capture, ["height", "protectedRegions", "width"], "/packet/capture");
  integer(packet.capture.width, "/packet/capture/width", 640, 7680);
  integer(packet.capture.height, "/packet/capture/height", 480, 4320);
  if (!Array.isArray(packet.capture.protectedRegions)) fail("INVALID_CONTRACT", "protected regions must be an array", "/packet/capture/protectedRegions");
  for (const [index, region] of packet.capture.protectedRegions.entries()) validateRegion(region, packet.capture, `/packet/capture/protectedRegions/${index}`);
  object(packet.roots, ["evidence", "packet", "staging"], "/packet/roots");
  for (const [name, root] of Object.entries(packet.roots)) {
    object(root, ["gid", "mode", "path", "sealed", "uid"], `/packet/roots/${name}`);
    string(root.path, `/packet/roots/${name}/path`, /^\/(?:[^/\0]+\/)*[^/\0]+$/u);
    integer(root.uid, `/packet/roots/${name}/uid`);
    integer(root.gid, `/packet/roots/${name}/gid`);
    if (root.sealed !== true || !["0500", "0550", "0700", "0750"].includes(root.mode)) fail("UNSEALED_ROOT", "run root is not sealed", `/packet/roots/${name}`);
  }
  object(packet.authorization, ["gateId", "runId", "used"], "/packet/authorization");
  string(packet.authorization.gateId, "/packet/authorization/gateId");
  if (packet.authorization.runId !== packet.binding.runId || packet.authorization.used !== false || typeof authorize !== "function" || authorize(packet.authorization) !== true) {
    fail("AUTHORIZATION_REQUIRED", "one-run authorization gate was not accepted", "/packet/authorization");
  }
  return packet;
}

export async function validateSealedRoots(roots) {
  object(roots, ["evidence", "packet", "staging"], "/roots");
  const resolved = [];
  for (const [name, root] of Object.entries(roots)) {
    object(root, ["gid", "mode", "path", "sealed", "uid"], `/roots/${name}`);
    const stat = await lstat(root.path);
    const canonicalPath = await realpath(root.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== root.uid || stat.gid !== root.gid ||
      canonicalPath !== resolve(root.path) || (stat.mode & 0o777).toString(8).padStart(4, "0") !== root.mode || root.sealed !== true) {
      fail("UNSEALED_ROOT", `${name} root ownership, mode, link, or type differs`, `/roots/${name}`);
    }
    resolved.push(resolve(root.path));
  }
  if (new Set(resolved).size !== resolved.length || resolved.some((left, index) => resolved.some((right, other) => index !== other && left.startsWith(`${right}${sep}`)))) {
    fail("UNSEALED_ROOT", "run roots must be distinct and non-nested", "/roots");
  }
  return true;
}

export function validateRegion(region, screen, path = "/region") {
  object(region, ["height", "name", "width", "x", "y"], path);
  string(region.name, `${path}/name`);
  for (const field of ["x", "y", "width", "height"]) integer(region[field], `${path}/${field}`, field === "width" || field === "height" ? 1 : 0);
  if (region.x + region.width > screen.width || region.y + region.height > screen.height) fail("UNSAFE_CAPTURE", "protected region escapes capture geometry", path);
  return region;
}

export function admitCapture({ screen, requested, protectedRegions }) {
  object(requested, ["height", "width", "x", "y"], "/capture/requested");
  const region = { name: "requested", ...requested };
  validateRegion(region, screen, "/capture/requested");
  for (const protectedRegion of protectedRegions) {
    validateRegion(protectedRegion, screen, "/capture/protectedRegions");
    const intersects = requested.x < protectedRegion.x + protectedRegion.width && requested.x + requested.width > protectedRegion.x &&
      requested.y < protectedRegion.y + protectedRegion.height && requested.y + requested.height > protectedRegion.y;
    if (intersects) fail("UNSAFE_CAPTURE", `capture intersects protected region ${protectedRegion.name}`, "/capture/requested");
  }
  return true;
}

export function verifyDeviceAuthIsolation(state, binding) {
  object(state, ["accounts", "binding", "developerSessionImported", "modelBacked", "sessionId"], "/auth");
  validateBinding(state.binding, "/auth/binding");
  for (const field of Object.keys(binding)) if (state.binding[field] !== binding[field]) fail("IDENTITY_MISMATCH", `auth binding differs at ${field}`, `/auth/binding/${field}`);
  if (state.developerSessionImported !== false || state.modelBacked !== true || !Array.isArray(state.accounts) || state.accounts.length !== 1) {
    fail("AUTH_ISOLATION_FAILED", "device-auth state is not isolated to one model-backed account", "/auth");
  }
  object(state.accounts[0], ["automation", "subject"], "/auth/accounts/0");
  if (state.accounts[0].automation !== true) fail("AUTH_ISOLATION_FAILED", "only account is not the automation identity", "/auth/accounts/0");
  string(state.accounts[0].subject, "/auth/accounts/0/subject", /^[^\0\r\n]{1,256}$/u);
  string(state.sessionId, "/auth/sessionId");
  return state;
}

export function validateSanitizedDiagnostics(diagnostics, binding) {
  object(diagnostics, ["binding", "checks", "capturedAt", "schemaVersion"], "/diagnostics");
  if (diagnostics.schemaVersion !== 1) fail("INVALID_CONTRACT", "unsupported diagnostic schema", "/diagnostics/schemaVersion");
  validateBinding(diagnostics.binding, "/diagnostics/binding");
  for (const field of Object.keys(binding)) if (diagnostics.binding[field] !== binding[field]) fail("IDENTITY_MISMATCH", `diagnostic binding differs at ${field}`, `/diagnostics/binding/${field}`);
  if (typeof diagnostics.capturedAt !== "string" || !Number.isFinite(Date.parse(diagnostics.capturedAt))) fail("INVALID_CONTRACT", "diagnostic timestamp is invalid", "/diagnostics/capturedAt");
  object(diagnostics.checks, ["accessibilityBus", "authIsolated", "desktopSession", "guestHelper"], "/diagnostics/checks");
  for (const [name, value] of Object.entries(diagnostics.checks)) if (value !== "ready") fail("DIAGNOSTIC_NOT_READY", `${name} is not ready`, `/diagnostics/checks/${name}`);
  return diagnostics;
}

export function compareTaskSurfaces(expected, surfaces) {
  object(expected, ["taskId", "title"], "/expectedTask");
  object(surfaces, ["desktop", "mcp", "native"], "/surfaces");
  for (const [name, surface] of Object.entries(surfaces)) {
    object(surface, ["lifecycle", "taskId", "title"], `/surfaces/${name}`);
    if (surface.taskId !== expected.taskId || surface.title !== expected.title || surface.lifecycle !== "active") {
      fail("TASK_SURFACE_MISMATCH", `task identity or lifecycle differs on ${name}`, `/surfaces/${name}`);
    }
  }
  return true;
}

export function assertPreDestroyCollection(events) {
  if (!Array.isArray(events)) fail("INVALID_CONTRACT", "events must be an array", "/events");
  const destroy = events.indexOf("destroy");
  for (const required of ["checkpoint-screenshot", "diagnostics", "inventory-draft"]) {
    const index = events.indexOf(required);
    if (index === -1 || destroy === -1 || index > destroy) fail("CLEANUP_ORDER_VIOLATION", `${required} must precede destroy`, "/events");
  }
  return true;
}

async function walk(root, current = root) {
  const entries = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    if (entry.isSymbolicLink()) fail("EVIDENCE_LINK_FORBIDDEN", "evidence contains a symbolic link", `/${rel}`);
    if (entry.isDirectory()) entries.push(...await walk(root, path));
    else if (entry.isFile()) entries.push({ path, rel });
    else fail("EVIDENCE_TYPE_FORBIDDEN", "evidence contains a non-regular file", `/${rel}`);
  }
  return entries;
}

export async function attestEvidenceInventory(root, inventory, { expectedUid, expectedGid, expectedPacketDigest } = {}) {
  object(inventory, ["binding", "files", "manifestReferences", "packetDigest", "schemaVersion"], "/inventory");
  if (inventory.schemaVersion !== 1) fail("INVALID_CONTRACT", "unsupported inventory schema", "/inventory/schemaVersion");
  validateBinding(inventory.binding, "/inventory/binding");
  string(inventory.packetDigest, "/inventory/packetDigest", SHA256);
  string(expectedPacketDigest, "/expectedPacketDigest", SHA256);
  if (!exact(inventory.packetDigest, expectedPacketDigest)) fail("PACKET_DIGEST_MISMATCH", "inventory is not bound to the independently supplied packet", "/inventory/packetDigest");
  if (!Array.isArray(inventory.files)) fail("INVALID_CONTRACT", "inventory files must be an array", "/inventory/files");
  if (!Array.isArray(inventory.manifestReferences) || inventory.manifestReferences.some((path) => typeof path !== "string")) {
    fail("INVALID_CONTRACT", "manifest references must be a string array", "/inventory/manifestReferences");
  }
  const disk = await walk(root);
  const inventoryNames = new Set(inventory.files.map((file) => file.path));
  if (inventoryNames.size !== inventory.files.length) fail("EVIDENCE_INVENTORY_MISMATCH", "inventory contains duplicate references", "/inventory/files");
  for (const item of disk) {
    if (!inventoryNames.has(item.rel)) fail("EVIDENCE_UNREFERENCED_FILE", `unreferenced evidence file ${item.rel}`);
  }
  if (disk.length !== inventory.files.length) fail("EVIDENCE_INVENTORY_MISMATCH", "inventory references a missing file", "/inventory/files");
  const references = new Set(inventory.manifestReferences);
  if (references.size !== inventory.manifestReferences.length || references.size !== inventory.files.length || [...inventoryNames].some((path) => !references.has(path))) {
    fail("EVIDENCE_REFERENCE_MISMATCH", "manifest references do not bind every inventory file exactly once", "/inventory/manifestReferences");
  }
  const requiredRoles = new Set(["archive-visual-report", "checkpoint-screenshot", "diagnostics"]);
  for (const file of inventory.files) {
    object(file, ["length", "path", "role", "sha256"], "/inventory/files/*");
    string(file.path, "/inventory/files/*/path", /^(?!\/|.*(?:^|\/)\.\.(?:\/|$)).+$/u);
    string(file.role, "/inventory/files/*/role", /^[a-z][a-z0-9-]{0,63}$/u);
    requiredRoles.delete(file.role);
    string(file.sha256, "/inventory/files/*/sha256", SHA256);
    integer(file.length, "/inventory/files/*/length");
    const path = resolve(root, file.path);
    if (!path.startsWith(`${resolve(root)}${sep}`)) fail("EVIDENCE_PATH_ESCAPE", "inventory path escapes evidence root", "/inventory/files/*/path");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("EVIDENCE_LINK_FORBIDDEN", "inventory target is not a regular non-link file", `/${file.path}`);
    if (expectedUid !== undefined && stat.uid !== expectedUid) fail("EVIDENCE_OWNER_MISMATCH", "evidence UID differs", `/${file.path}`);
    if (expectedGid !== undefined && stat.gid !== expectedGid) fail("EVIDENCE_OWNER_MISMATCH", "evidence GID differs", `/${file.path}`);
    const bytes = await readFile(path);
    if (bytes.length !== file.length || !exact(sha256(bytes), file.sha256)) fail("EVIDENCE_HASH_MISMATCH", `evidence bytes differ for ${file.path}`);
  }
  if (requiredRoles.size > 0) fail("EVIDENCE_REQUIRED_ROLE_MISSING", `inventory lacks ${[...requiredRoles].join(",")}`, "/inventory/files");
  return Object.freeze({ files: disk.length, packetDigest: inventory.packetDigest, binding: inventory.binding });
}

export const PROXMOX_DESKTOP_ALLOWED_OPERATIONS = Object.freeze({
  guest: Object.freeze([...ALLOWED_GUEST_OPERATIONS]),
  host: Object.freeze([...ALLOWED_HOST_OPERATIONS]),
});
