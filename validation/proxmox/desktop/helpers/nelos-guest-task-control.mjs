#!/usr/lib/chatgpt/resources/cua_node/bin/node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const helperRoot = process.env.NELOS_DESKTOP_HELPER_ROOT || "/";
const at = (path) => helperRoot === "/" ? path : `${helperRoot}${path}`;
const candidateRoot = helperRoot === "/" ? "/opt/nelos-desktop/nelos" : process.env.NELOS_CANDIDATE_ROOT;
const bindingPath = at("/etc/nelos-desktop/run-binding.json");
const authPath = at("/var/lib/nelos-desktop/device-auth.json");
const codexHome = at("/home/nelosauto/.codex");
const workspace = at("/home/nelosauto/workspace");
const MAX_INPUT = 1_048_576;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const BINDING_FIELDS = ["automationUser", "fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "stateRoot", "vmId"];

function die(code, message) { process.stderr.write(`${JSON.stringify({ error: code, message })}\n`); process.exit(77); }
function fields(value, expected) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"); }
function sortDeep(value) { return Array.isArray(value) ? value.map(sortDeep) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])])) : value; }
function bytes(value) { return Buffer.from(`${JSON.stringify(sortDeep(value))}\n`); }
function digest(value) { return `sha256:${createHash("sha256").update(Buffer.isBuffer(value) ? value : JSON.stringify(sortDeep(value))).digest("hex")}`; }
async function trusted(path, maximum, { uid = null, mode = null } = {}) {
  const info = await lstat(path); const canonical = await realpath(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 2 || info.size > maximum || canonical !== resolve(path) ||
      (uid !== null && info.uid !== uid) || (mode !== null && (info.mode & 0o777) !== mode) || (helperRoot === "/" && (info.mode & 0o022) !== 0)) throw new Error("untrusted file");
  const raw = await readFile(path); let value;
  try { value = JSON.parse(raw); } finally { raw.fill(0); }
  return value;
}
async function optionalTrusted(path, maximum, options = {}) {
  try { return await trusted(path, maximum, options); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function exclusive(path, value, mode = 0o400) {
  const raw = bytes(value);
  try {
    try {
      const handle = await open(path, "wx", mode);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(dirname(path));
    }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const observed = await readFile(path); try { if (!observed.equals(raw)) throw new Error("existing bytes differ"); } finally { observed.fill(0); }
    }
  } finally { raw.fill(0); }
}

const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks); if (input.length < 2 || input.length > MAX_INPUT) die("INVALID_GUEST_TASK_REQUEST", "guest task request is outside its byte bound");
let request; let binding; let auth;
try {
  request = JSON.parse(input); binding = await trusted(bindingPath, 16_384); auth = await trusted(authPath, 65_536);
} catch { die("GUEST_TASK_BOUNDARY_UNAVAILABLE", "guest binding or isolated authentication receipt is unavailable"); }
finally { input.fill(0); }
if (!fields(request, ["operation", "payload", "schemaVersion"]) || request.schemaVersion !== 1 ||
    !new Set(["prepare", "read", "reconcile", "observe-auth", "observe-native", "observe-mcp", "observe-native-archive", "observe-mcp-archive"]).has(request.operation) ||
    !fields(binding, BINDING_FIELDS) || binding.automationUser !== "nelosauto" ||
    !fields(auth, ["accountBindingDigest", "accountType", "authMethod", "authenticated", "binding", "credentialStore", "developerSessionImported", "schemaVersion"]) ||
    auth.schemaVersion !== 1 || auth.authenticated !== true || auth.accountType !== "chatgpt" || auth.authMethod !== "chatgptDeviceCode" ||
    auth.credentialStore !== "file" || auth.developerSessionImported !== false || !SHA256.test(auth.accountBindingDigest ?? "") ||
    JSON.stringify(sortDeep(auth.binding)) !== JSON.stringify(sortDeep(binding))) die("GUEST_TASK_BINDING_MISMATCH", "guest task request is not bound to isolated authentication");

if (!candidateRoot || !resolve(candidateRoot).startsWith("/")) die("GUEST_CANDIDATE_UNAVAILABLE", "verified guest candidate root is unavailable");
const [{ prepareProductionTaskV1, PinnedCodexTaskPreparationClientV1 }, guestTask, observer, archiveObserver, bridgeModule] = await Promise.all([
  import(`${candidateRoot}/src/production-task-preparation.mjs`),
  import(`${candidateRoot}/src/production-guest-task.mjs`),
  import(`${candidateRoot}/src/production-task-surface-observer.mjs`),
  import(`${candidateRoot}/src/production-archive-surface-observer.mjs`),
  import(`${candidateRoot}/src/mcp-app-server-bridge.mjs`),
]).catch(() => die("GUEST_CANDIDATE_UNAVAILABLE", "verified guest candidate modules could not load"));

function clientFactory() {
  const command = at("/usr/lib/chatgpt/resources/codex");
  return new PinnedCodexTaskPreparationClientV1({
    command,
    expectedCommand: command,
    expectedCodexHome: codexHome,
    environment: {
      HOME: at("/home/nelosauto"), CODEX_HOME: codexHome, USER: "nelosauto", LOGNAME: "nelosauto", LC_ALL: "C",
      ...(helperRoot !== "/" && process.env.NELOS_FAKE_PRODUCTION_TASK_STATE ? { NELOS_FAKE_PRODUCTION_TASK_STATE: process.env.NELOS_FAKE_PRODUCTION_TASK_STATE } : {}),
    },
    spawnProcess: spawnAsAutomation,
  });
}
async function appClient() {
  const client = clientFactory(); const identity = await client.connect();
  const expected = { command: at("/usr/lib/chatgpt/resources/codex"), platformFamily: "unix", platformOs: "linux", userAgent: "Codex Desktop/0.148.0-alpha.15" };
  if (!fields(identity, Object.keys(expected)) || Object.entries(expected).some(([name, value]) => identity[name] !== value)) {
    await client.close(); die("GUEST_CODEX_IDENTITY_MISMATCH", "guest task producer differs from the pinned Desktop runtime");
  }
  return client;
}
async function allTaskIds(client) {
  if (typeof client.listAllThreadIds !== "function") die("GUEST_CANDIDATE_UNAVAILABLE", "candidate task producer lacks bounded inventory support");
  return client.listAllThreadIds();
}
async function accountBinding(client) {
  if (typeof client.accountBindingDigest !== "function") die("GUEST_CANDIDATE_UNAVAILABLE", "candidate task producer lacks account binding support");
  return client.accountBindingDigest(binding.runId);
}
function producerRoot() { return join(at(binding.stateRoot), "task-producer"); }
function wrappedReceiptPath(intentDigest) { return join(producerRoot(), `guest-receipt-${intentDigest.slice(7)}.json`); }
function spawnAsAutomation(command, args, options = {}) {
  if (helperRoot !== "/") {
    if (process.env.NELOS_FAKE_PRODUCTION_TASK_COMMAND) return spawn(process.execPath, [process.env.NELOS_FAKE_PRODUCTION_TASK_COMMAND, ...args], options);
    return spawn(command, args, options);
  }
  const allowedEnvironment = {
    HOME: "/home/nelosauto",
    CODEX_HOME: "/home/nelosauto/.codex",
    USER: "nelosauto",
    LOGNAME: "nelosauto",
    PATH: "/usr/lib/chatgpt/resources/cua_node/bin:/usr/bin:/bin",
    LC_ALL: "C",
  };
  return spawn("/usr/sbin/runuser", [
    "-u", "nelosauto", "--", "/usr/bin/env", "-i",
    ...Object.entries(allowedEnvironment).map(([name, value]) => `${name}=${value}`),
    command, ...args,
  ], {
    ...options,
    shell: false,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
  });
}

async function prepare({ recovery = false } = {}) {
  const intent = guestTask.validateProductionGuestTaskIntentV1(request.payload?.intent);
  if (intent.runId !== binding.runId || intent.fencingToken !== binding.fencingToken || intent.automationUser !== binding.automationUser ||
      intent.runtime.codexHome !== "/home/nelosauto/.codex" || intent.runtime.cwd !== "/home/nelosauto/workspace") die("GUEST_TASK_BINDING_MISMATCH", "guest task intent differs from the active VM binding");
  const root = producerRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(root));
  const rootInfo = await lstat(root); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o777) !== 0o700) die("UNSAFE_GUEST_TASK_STATE", "guest task producer state is unsafe");
  const intentDigest = guestTask.productionGuestTaskDigestV1(intent); const finalPath = wrappedReceiptPath(intentDigest);
  const existing = await optionalTrusted(finalPath, 65_536, { uid: rootInfo.uid, mode: 0o400 });
  if (existing !== null) {
    guestTask.validateProductionGuestTaskReceiptV1(existing, { intent, binding });
    const verify = await appClient();
    try {
      if (await accountBinding(verify) !== existing.accountBindingDigest) die("GUEST_ACCOUNT_MISMATCH", "prepared task account binding changed");
      const task = await verify.readThread(existing.taskId); await verify.assertNoTurns(existing.taskId);
      if (task.name !== intent.title || task.createdAt !== existing.createdAt || JSON.stringify(await allTaskIds(verify)) !== JSON.stringify(existing.inventory.afterTaskIds)) die("GUEST_TASK_READBACK_MISMATCH", "prepared guest task or inventory changed");
    } finally { await verify.close(); }
    return existing;
  }
  const preinventoryPath = join(root, `.preinventory-${intentDigest.slice(7)}.json`);
  let preinventory = await optionalTrusted(preinventoryPath, 16_384, { uid: rootInfo.uid, mode: 0o400 });
  if (preinventory === null) {
    if (recovery) die("GUEST_TASK_RECONCILIATION_UNAVAILABLE", "guest task effect has no immutable pre-inventory receipt");
    const preClient = await appClient(); let beforeTaskIds; let accountBindingDigest;
    try { beforeTaskIds = await allTaskIds(preClient); accountBindingDigest = await accountBinding(preClient); }
    finally { await preClient.close(); }
    if (beforeTaskIds.length !== 0 || accountBindingDigest !== auth.accountBindingDigest) die("GUEST_TASK_NOT_FRESH", "isolated guest store or account is not fresh and exact");
    preinventory = { accountBindingDigest, beforeTaskIds, intentDigest, schemaVersion: 1 };
    await exclusive(preinventoryPath, preinventory, 0o400);
  }
  if (!fields(preinventory, ["accountBindingDigest", "beforeTaskIds", "intentDigest", "schemaVersion"]) || preinventory.schemaVersion !== 1 ||
      preinventory.intentDigest !== intentDigest || preinventory.accountBindingDigest !== auth.accountBindingDigest ||
      !Array.isArray(preinventory.beforeTaskIds) || preinventory.beforeTaskIds.length !== 0) {
    die("GUEST_TASK_PREINVENTORY_MISMATCH", "guest task pre-inventory receipt differs from the isolated account and intent");
  }
  const accountBindingDigest = preinventory.accountBindingDigest; const beforeTaskIds = preinventory.beforeTaskIds;
  const recoveryClient = await appClient(); let recoveredIds; let recoveredTask = null;
  try {
    recoveredIds = await allTaskIds(recoveryClient);
    if (await accountBinding(recoveryClient) !== accountBindingDigest) die("GUEST_ACCOUNT_MISMATCH", "guest account changed after the immutable pre-inventory receipt");
    if (recoveredIds.length > 1) die("GUEST_TASK_INVENTORY_AMBIGUOUS", "guest task inventory contains more than the sole authorized task");
    if (recoveredIds.length === 1) {
      recoveredTask = await recoveryClient.readThread(recoveredIds[0]); await recoveryClient.assertNoTurns(recoveredIds[0]);
      if (recoveredTask.name !== null && recoveredTask.name !== "" && recoveredTask.name !== intent.title) die("GUEST_TASK_READBACK_MISMATCH", "sole recovered guest task has an unrelated title");
      if (recoveredTask.name !== intent.title) {
        await recoveryClient.setTitle(recoveredTask.id, intent.title);
        recoveredTask = await recoveryClient.readThread(recoveredTask.id); await recoveryClient.assertNoTurns(recoveredTask.id);
      }
      if (recoveredTask.name !== intent.title) die("GUEST_TASK_READBACK_MISMATCH", "sole recovered guest task could not be bound to its exact title");
    }
  } finally { await recoveryClient.close(); }
  const prepared = recoveredTask === null
    ? await prepareProductionTaskV1({ root, title: intent.title, cwd: workspace, authorizeCreate: true }, { clientFactory, expectedUid: rootInfo.uid, expectedGid: rootInfo.gid })
    : { taskId: recoveredTask.id, createdAt: recoveredTask.createdAt };
  const postClient = await appClient(); let afterTaskIds;
  try {
    afterTaskIds = await allTaskIds(postClient); const observedBinding = await accountBinding(postClient);
    if (observedBinding !== accountBindingDigest) die("GUEST_ACCOUNT_MISMATCH", "guest account changed while creating the task");
    const task = await postClient.readThread(prepared.taskId); await postClient.assertNoTurns(prepared.taskId);
    if (task.name !== intent.title || task.createdAt !== prepared.createdAt) die("GUEST_TASK_READBACK_MISMATCH", "guest task readback differs");
  } finally { await postClient.close(); }
  const receipt = {
    schemaVersion: 1, type: "nelos-production-guest-task-receipt", binding, intentDigest, taskSlotId: intent.taskSlotId,
    taskId: prepared.taskId, title: intent.title, createdAt: prepared.createdAt, codexIdentity: intent.runtime,
    accountBindingDigest, initialTurnStarted: false,
    inventory: { beforeTaskIds, afterTaskIds, complete: true, maximumTasks: 100 },
  };
  guestTask.validateProductionGuestTaskReceiptV1(receipt, { intent, binding }); await exclusive(finalPath, receipt, 0o400); return receipt;
}

async function readPrepared() {
  const intent = guestTask.validateProductionGuestTaskIntentV1(request.payload?.intent); const root = producerRoot();
  const info = await lstat(root); const receipt = await trusted(wrappedReceiptPath(guestTask.productionGuestTaskDigestV1(intent)), 65_536, { uid: info.uid, mode: 0o400 });
  return guestTask.validateProductionGuestTaskReceiptV1(receipt, { intent, binding });
}

async function reconcilePrepared() { return prepare({ recovery: true }); }

async function observeAuth() {
  if (!fields(request.payload, [])) die("GUEST_AUTH_OBSERVATION_MISMATCH", "live account observation accepts no caller-authored fields");
  const client = await appClient(); let accountBindingDigest;
  try { accountBindingDigest = await accountBinding(client); }
  finally { await client.close(); }
  if (accountBindingDigest !== auth.accountBindingDigest) die("GUEST_ACCOUNT_MISMATCH", "live account binding differs from the isolated authentication receipt");
  const base = {
    schemaVersion: 1, type: "live-device-auth-attestation", source: "codex-app-server-account-read",
    runId: binding.runId, fencingToken: binding.fencingToken, automationUser: binding.automationUser,
    authenticated: true, accountType: "chatgpt", authMethod: "chatgptDeviceCode", credentialStore: "file",
    developerSessionImported: false, accountBindingDigest, authReceiptDigest: digest(auth), observedAt: new Date().toISOString(),
  };
  return { ...base, attestationDigest: digest(base) };
}

async function observeNative() {
  const expected = request.payload?.expected;
  const native = new observer.NativeCodexTaskObserverV1({ bridgeFactory: (command) => new bridgeModule.CodexAppServerBridgeV1({ command, spawnProcess: spawnAsAutomation }) });
  return native.observe(expected);
}

async function observeMcp() {
  const client = new observer.BoundedNelosMcpClientV1({ spawnProcess: spawnAsAutomation });
  return new observer.NelosMcpTaskObserverV1({ client }).observe(request.payload?.expected);
}
async function observeNativeArchive() {
  const native = new archiveObserver.NativeCodexArchiveObserverV1({ bridgeFactory: (command) => new bridgeModule.CodexAppServerBridgeV1({ command, spawnProcess: spawnAsAutomation }) });
  return native.observe(request.payload?.expectedThreads);
}
async function observeMcpArchive() {
  const client = new observer.BoundedNelosMcpClientV1({ spawnProcess: spawnAsAutomation });
  return new archiveObserver.NelosMcpArchiveObserverV1({ client }).observe(request.payload?.expectedThreads);
}

let result;
try {
  if (request.operation === "prepare") result = await prepare();
  else if (request.operation === "read") result = await readPrepared();
  else if (request.operation === "reconcile") result = await reconcilePrepared();
  else if (request.operation === "observe-auth") result = await observeAuth();
  else if (request.operation === "observe-native") result = await observeNative();
  else if (request.operation === "observe-mcp") result = await observeMcp();
  else if (request.operation === "observe-native-archive") result = await observeNativeArchive();
  else result = await observeMcpArchive();
  process.stdout.write(bytes(result));
} catch (error) { die(error?.code ?? "GUEST_TASK_CONTROL_FAILED", "guest task control failed closed"); }
