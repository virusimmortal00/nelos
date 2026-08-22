import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const TITLE = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const MAX_BYTES = 65_536;

export const PRODUCTION_GUEST_CODEX_IDENTITY_V1 = Object.freeze({
  command: "/usr/lib/chatgpt/resources/codex",
  codexHome: "/home/nelosauto/.codex",
  cwd: "/home/nelosauto/workspace",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent: "Codex Desktop/0.148.0-alpha.15",
});

export class ProductionGuestTaskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProductionGuestTaskError";
    this.code = code;
  }
}

function fail(code, message) { throw new ProductionGuestTaskError(code, message); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fields(value, expected) {
  return plain(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  return value;
}
export function canonicalProductionGuestTaskBytesV1(value) { return Buffer.from(`${JSON.stringify(sortDeep(value))}\n`, "utf8"); }
export function productionGuestTaskDigestV1(value) {
  const bytes = Buffer.isBuffer(value) ? value : canonicalProductionGuestTaskBytesV1(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function identity(value, label) { if (!ID.test(value ?? "")) fail("INVALID_GUEST_TASK_CONTRACT", `${label} is invalid`); return value; }
function digest(value, label) { if (!SHA256.test(value ?? "")) fail("INVALID_GUEST_TASK_CONTRACT", `${label} is invalid`); return value; }
function title(value) { if (!TITLE.test(value ?? "")) fail("INVALID_GUEST_TASK_CONTRACT", "task title is invalid"); return value; }
function validateRuntime(value) {
  if (!fields(value, ["codexHome", "command", "cwd", "platformFamily", "platformOs", "userAgent"]) ||
      Object.entries(PRODUCTION_GUEST_CODEX_IDENTITY_V1).some(([name, expected]) => value[name] !== expected)) {
    fail("GUEST_CODEX_IDENTITY_MISMATCH", "guest Codex identity differs from the pinned Linux Desktop runtime");
  }
  return value;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export function createProductionGuestTaskIntentV1({ runId, fencingToken, scenarioId, title: taskTitle }) {
  identity(runId, "runId"); identity(fencingToken, "fencingToken"); identity(scenarioId, "scenarioId"); title(taskTitle);
  const slotMaterial = { schemaVersion: 1, domain: "nelos-production-guest-task-slot-v1", runId, fencingToken, scenarioId, title: taskTitle };
  const taskSlotId = `task-slot-${productionGuestTaskDigestV1(slotMaterial).slice(7)}`;
  return Object.freeze({
    schemaVersion: 1,
    type: "nelos-production-guest-task-intent",
    runId,
    fencingToken,
    scenarioId,
    taskSlotId,
    title: taskTitle,
    automationUser: "nelosauto",
    accountPolicy: "isolated-chatgpt-device-code",
    runtime: structuredClone(PRODUCTION_GUEST_CODEX_IDENTITY_V1),
    initialTurnStarted: false,
  });
}

export function validateProductionGuestTaskIntentV1(value) {
  if (!fields(value, ["accountPolicy", "automationUser", "fencingToken", "initialTurnStarted", "runId", "runtime", "scenarioId", "schemaVersion", "taskSlotId", "title", "type"]) ||
      value.schemaVersion !== 1 || value.type !== "nelos-production-guest-task-intent" || value.automationUser !== "nelosauto" ||
      value.accountPolicy !== "isolated-chatgpt-device-code" || value.initialTurnStarted !== false) {
    fail("INVALID_GUEST_TASK_INTENT", "guest task intent fields differ from the closed contract");
  }
  const expected = createProductionGuestTaskIntentV1(value);
  validateRuntime(value.runtime);
  if (canonicalProductionGuestTaskBytesV1(value).compare(canonicalProductionGuestTaskBytesV1(expected)) !== 0) {
    fail("GUEST_TASK_INTENT_MISMATCH", "guest task intent is not its deterministic run-bound value");
  }
  return value;
}

export function validateProductionGuestTaskReceiptV1(value, { intent, binding } = {}) {
  validateProductionGuestTaskIntentV1(intent);
  if (!fields(value, [
    "accountBindingDigest", "binding", "codexIdentity", "createdAt", "initialTurnStarted", "intentDigest", "inventory",
    "schemaVersion", "taskId", "taskSlotId", "title", "type",
  ]) || value.schemaVersion !== 1 || value.type !== "nelos-production-guest-task-receipt" || value.initialTurnStarted !== false ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !fields(value.inventory, ["afterTaskIds", "beforeTaskIds", "complete", "maximumTasks"]) ||
      value.inventory.complete !== true || value.inventory.maximumTasks !== 100 || !Array.isArray(value.inventory.beforeTaskIds) || !Array.isArray(value.inventory.afterTaskIds) ||
      value.inventory.beforeTaskIds.length !== 0 || value.inventory.afterTaskIds.length !== 1 || value.inventory.afterTaskIds[0] !== value.taskId ||
      !ID.test(value.taskId ?? "") || value.taskId === intent.taskSlotId || value.taskSlotId !== intent.taskSlotId || value.title !== intent.title ||
      value.intentDigest !== productionGuestTaskDigestV1(intent) || !SHA256.test(value.accountBindingDigest ?? "") ||
      !fields(value.binding, ["automationUser", "fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "stateRoot", "vmId"])) {
    fail("INVALID_GUEST_TASK_RECEIPT", "guest task receipt fields or fresh inventory differ from the closed contract");
  }
  validateRuntime(value.codexIdentity);
  if (binding && Object.entries(binding).some(([name, expected]) => value.binding[name] !== expected)) {
    fail("GUEST_TASK_BINDING_MISMATCH", "guest task receipt belongs to another run, VM, or fence");
  }
  if (value.binding.runId !== intent.runId || value.binding.fencingToken !== intent.fencingToken || value.binding.automationUser !== intent.automationUser) {
    fail("GUEST_TASK_BINDING_MISMATCH", "guest task receipt differs from its intent binding");
  }
  return value;
}

async function sealedFile(path, root, digestValue) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path || dirname(path) !== resolve(root.path) ||
      path !== join(resolve(root.path), `production-task-intent-${digestValue.slice(7)}.json`)) {
    fail("GUEST_TASK_INTENT_BINDING_MISMATCH", "guest task intent path is not content-addressed inside the packet root");
  }
  let handle; let before; let canonical; let bytes;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    [before, canonical] = await Promise.all([handle.stat({ bigint: true }), realpath(path)]);
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(root.uid) || before.gid !== BigInt(root.gid) ||
        Number(before.mode & 0o777n) !== 0o400 || before.size < 2n || before.size > BigInt(MAX_BYTES) || canonical !== path ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        bytes.length !== Number(before.size) || productionGuestTaskDigestV1(bytes) !== digestValue) {
      fail("UNTRUSTED_GUEST_TASK_INTENT", "guest task intent ownership, mode, path, or bytes differ");
    }
    let value; try { value = JSON.parse(bytes); } catch { fail("INVALID_GUEST_TASK_INTENT", "guest task intent is not JSON"); }
    if (!bytes.equals(canonicalProductionGuestTaskBytesV1(value))) fail("INVALID_GUEST_TASK_INTENT", "guest task intent is not canonically encoded");
    return Object.freeze(validateProductionGuestTaskIntentV1(value));
  } finally { bytes?.fill(0); await handle?.close().catch(() => {}); }
}

export async function readProductionGuestTaskIntentV1({ path, digest: digestValue, root }) {
  digest(digestValue, "intent digest");
  if (!plain(root) || !isAbsolute(root.path ?? "") || !Number.isSafeInteger(root.uid) || !Number.isSafeInteger(root.gid)) {
    fail("GUEST_TASK_INTENT_BINDING_MISMATCH", "guest task intent root is invalid");
  }
  return sealedFile(path, root, digestValue);
}

export async function writeProductionGuestTaskIntentV1({ root, runId, fencingToken, scenarioId, title: taskTitle }, {
  expectedUid = typeof process.getuid === "function" ? process.getuid() : 0,
  expectedGid = typeof process.getgid === "function" ? process.getgid() : 0,
} = {}) {
  if (!isAbsolute(root ?? "") || resolve(root) === "/") fail("UNSAFE_TASK_ROOT", "guest task intent root must be bounded and absolute");
  const [info, canonical] = await Promise.all([lstat(root), realpath(root)]).catch(() => fail("UNSAFE_TASK_ROOT", "guest task intent root is unavailable"));
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolve(root) || info.uid !== expectedUid || info.gid !== expectedGid || (info.mode & 0o777) !== 0o700) {
    fail("UNSAFE_TASK_ROOT", "guest task intent root ownership, mode, type, or path differs");
  }
  const value = createProductionGuestTaskIntentV1({ runId, fencingToken, scenarioId, title: taskTitle });
  const bytes = canonicalProductionGuestTaskBytesV1(value); const digestValue = productionGuestTaskDigestV1(bytes);
  const path = join(canonical, `production-task-intent-${digestValue.slice(7)}.json`);
  try {
    try {
      const handle = await open(path, "wx", 0o400);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(canonical);
    }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  } finally { bytes.fill(0); }
  const verified = await readProductionGuestTaskIntentV1({ path, digest: digestValue, root: { path: canonical, uid: expectedUid, gid: expectedGid } });
  return Object.freeze({ value: verified, intentDigest: digestValue, intentPath: path, taskSlotId: verified.taskSlotId, title: verified.title });
}

export function materializeProductionGuestTaskRunV1(run, receipt, { intent, binding } = {}) {
  validateProductionGuestTaskReceiptV1(receipt, { intent, binding });
  const matches = run.scenarios.filter((scenario) => scenario.scenarioId === intent.scenarioId && scenario.task.taskId === intent.taskSlotId);
  if (matches.length !== 1 || run.scenarios.some((scenario) => scenario.task.taskId === receipt.taskId)) {
    fail("GUEST_TASK_MATERIALIZATION_MISMATCH", "guest task receipt does not fill one unique admitted task slot");
  }
  return Object.freeze({
    ...structuredClone(run),
    scenarios: run.scenarios.map((scenario) => scenario.scenarioId === intent.scenarioId
      ? { ...structuredClone(scenario), task: { ...structuredClone(scenario.task), taskId: receipt.taskId } }
      : structuredClone(scenario)),
  });
}
