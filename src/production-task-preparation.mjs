import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 65_536;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const RECEIPT_NAME = /^production-task-([0-9a-f]{64})\.json$/u;
const INTENT_NAME = ".nelos-production-task.intent.json";
const CREATED_NAME = ".nelos-production-task.created.json";
const TITLE = /^[^\u0000-\u001f\u007f]{1,160}$/u;

export const PINNED_PRODUCTION_CODEX_COMMAND_V1 = process.platform === "darwin"
  ? "/Applications/ChatGPT.app/Contents/Resources/codex"
  : process.platform === "linux"
    ? "/usr/lib/chatgpt/resources/codex"
    : null;

export class ProductionTaskPreparationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProductionTaskPreparationError";
    this.code = code;
  }
}

function fail(code, message) { throw new ProductionTaskPreparationError(code, message); }
function exactFields(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(sortDeep(value))}\n`, "utf8"); }
function bytesDigest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function valueDigest(value) {
  const bytes = canonicalBytes(value);
  try { return bytesDigest(bytes); } finally { bytes.fill(0); }
}
function text(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_TASK_PREPARATION", `${label} is invalid`);
  }
  return value;
}
function taskId(value) {
  if (!TASK_ID.test(value ?? "")) fail("TASK_CREATION_AMBIGUOUS", "Codex returned no safely adoptable task identity");
  return value;
}
function createdAt(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("TASK_CREATION_AMBIGUOUS", "Codex returned no safely adoptable creation timestamp");
  return value;
}
function sameValue(left, right) { return JSON.stringify(sortDeep(left)) === JSON.stringify(sortDeep(right)); }

function validateCodexIdentity(value, expectedCommand = null) {
  if (!exactFields(value, ["command", "platformFamily", "platformOs", "userAgent"]) ||
      !isAbsolute(value.command ?? "") || (expectedCommand !== null && value.command !== expectedCommand)) {
    fail("CODEX_IDENTITY_MISMATCH", "Codex producer identity is invalid");
  }
  for (const [field, maximum] of [["platformFamily", 64], ["platformOs", 64], ["userAgent", 512]]) text(value[field], maximum, `Codex ${field}`);
  if (!/\b(?:Codex Desktop|codex-cli)\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?\b/u.test(value.userAgent)) {
    fail("CODEX_IDENTITY_MISMATCH", "Codex producer user agent is incompatible");
  }
  return value;
}

function validateReceipt(value, { expectedCommand = null } = {}) {
  if (!exactFields(value, ["codexIdentity", "createdAt", "initialTurnStarted", "intentDigest", "schemaVersion", "taskId", "title", "type"]) ||
      value.schemaVersion !== 1 || value.type !== "nelos-production-task-receipt" || value.initialTurnStarted !== false ||
      !SHA256.test(value.intentDigest ?? "") || !TASK_ID.test(value.taskId ?? "") || !TITLE.test(value.title ?? "") ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    fail("INVALID_TASK_RECEIPT", "production task receipt is invalid");
  }
  validateCodexIdentity(value.codexIdentity, expectedCommand);
  return value;
}

async function sealedRoot(path, expectedUid, expectedGid) {
  if (!isAbsolute(path ?? "") || resolve(path) === "/") fail("UNSAFE_TASK_ROOT", "producer root must be a bounded absolute path");
  let info; let canonical;
  try { info = await lstat(path); canonical = await realpath(path); } catch { fail("UNSAFE_TASK_ROOT", "producer root is unavailable"); }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolve(path) || info.uid !== expectedUid || info.gid !== expectedGid || (info.mode & 0o777) !== 0o700) {
    fail("UNSAFE_TASK_ROOT", "producer root ownership, mode, type, or canonical path differs");
  }
  return Object.freeze({ path: canonical, uid: info.uid, gid: info.gid });
}

async function sealedFile(path, root, { maximum = MAX_RECEIPT_BYTES } = {}) {
  let info; let canonical;
  try { info = await lstat(path); canonical = await realpath(path); } catch { fail("UNTRUSTED_TASK_RECEIPT", "sealed producer file is unavailable"); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== root.uid || info.gid !== root.gid ||
      (info.mode & 0o777) !== 0o400 || info.size < 2 || info.size > maximum || canonical !== resolve(path) || dirname(canonical) !== root.path) {
    fail("UNTRUSTED_TASK_RECEIPT", "sealed producer file ownership, mode, type, or path differs");
  }
  return readFile(canonical);
}

async function readCanonicalFile(path, root) {
  const bytes = await sealedFile(path, root);
  try {
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("UNTRUSTED_TASK_RECEIPT", "sealed producer file is not JSON"); }
    if (!bytes.equals(canonicalBytes(value))) fail("UNTRUSTED_TASK_RECEIPT", "sealed producer file is not canonically encoded");
    return { bytes: Buffer.from(bytes), value };
  } finally { bytes.fill(0); }
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writeExclusive(path, value, root) {
  const bytes = canonicalBytes(value);
  try {
    const handle = await open(path, "wx", 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(root.path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    fail("EXCLUSIVE_TASK_STATE_EXISTS", "exclusive producer state already exists");
  } finally { bytes.fill(0); }
}

async function readIntent(path, root, expected) {
  const { bytes, value } = await readCanonicalFile(path, root);
  try {
    if (!exactFields(value, ["authorization", "codexIdentity", "cwdDigest", "schemaVersion", "title", "type"]) ||
        value.schemaVersion !== 1 || value.type !== "nelos-production-task-intent" || value.authorization !== "one-shot-explicit" ||
        !SHA256.test(value.cwdDigest ?? "") || !TITLE.test(value.title ?? "")) fail("TASK_INTENT_MISMATCH", "task creation intent is invalid");
    validateCodexIdentity(value.codexIdentity, expected.codexIdentity.command);
    if (!sameValue(value, expected)) fail("TASK_INTENT_MISMATCH", "task creation intent differs from this invocation");
    return { digest: bytesDigest(bytes), value };
  } finally { bytes.fill(0); }
}

async function readCreated(path, root, expected) {
  const { bytes, value } = await readCanonicalFile(path, root);
  try {
    if (!exactFields(value, ["codexIdentity", "createdAt", "intentDigest", "schemaVersion", "taskId", "type"]) ||
        value.schemaVersion !== 1 || value.type !== "nelos-production-task-created" || !SHA256.test(value.intentDigest ?? "") ||
        !TASK_ID.test(value.taskId ?? "") || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
      fail("CREATED_TASK_IDENTITY_MISMATCH", "created task marker is invalid");
    }
    validateCodexIdentity(value.codexIdentity, expected.codexIdentity.command);
    if (value.intentDigest !== expected.intentDigest || !sameValue(value.codexIdentity, expected.codexIdentity)) {
      fail("CREATED_TASK_IDENTITY_MISMATCH", "created task marker differs from the producer intent");
    }
    return value;
  } finally { bytes.fill(0); }
}

async function receiptFiles(root) {
  const names = (await readdir(root.path)).filter((name) => RECEIPT_NAME.test(name));
  if (names.length > 1) fail("MULTIPLE_TASK_RECEIPTS", "producer root contains multiple task receipts");
  return names.map((name) => join(root.path, name));
}

export async function readProductionTaskReceiptV1({ path, digest, root, expectedCommand = null }) {
  if (!SHA256.test(digest ?? "") || !isAbsolute(path ?? "") || !root || !isAbsolute(root.path ?? "") ||
      !Number.isSafeInteger(root.uid) || !Number.isSafeInteger(root.gid) || dirname(resolve(path)) !== resolve(root.path) ||
      path !== join(resolve(root.path), `production-task-${digest.slice(7)}.json`)) {
    fail("TASK_RECEIPT_BINDING_MISMATCH", "task receipt path or digest is not bound to its producer root");
  }
  const bytes = await sealedFile(path, { path: resolve(root.path), uid: root.uid, gid: root.gid });
  try {
    if (bytesDigest(bytes) !== digest) fail("TASK_RECEIPT_DIGEST_MISMATCH", "task receipt bytes differ from the bound digest");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("INVALID_TASK_RECEIPT", "task receipt is not JSON"); }
    if (!bytes.equals(canonicalBytes(value))) fail("INVALID_TASK_RECEIPT", "task receipt is not canonically encoded");
    return Object.freeze(validateReceipt(value, { expectedCommand }));
  } finally { bytes.fill(0); }
}

function validateThread(thread, expectedId = null) {
  if (thread === null || typeof thread !== "object" || Array.isArray(thread) || !TASK_ID.test(thread.id ?? "") ||
      !Number.isSafeInteger(thread.createdAt) || thread.createdAt < 0 || (expectedId !== null && thread.id !== expectedId)) {
    fail("TASK_READBACK_MISMATCH", "Codex task readback identity is invalid");
  }
  if (thread.name !== null && thread.name !== "" && !TITLE.test(thread.name)) fail("TASK_READBACK_MISMATCH", "Codex task readback title is invalid");
  return thread;
}

export class PinnedCodexTaskPreparationClientV1 {
  constructor({
    command = PINNED_PRODUCTION_CODEX_COMMAND_V1,
    expectedCommand = PINNED_PRODUCTION_CODEX_COMMAND_V1,
    spawnProcess = spawn,
    environment = process.env,
    expectedCodexHome = environment.CODEX_HOME ?? null,
    requestTimeoutMs = 30_000,
  } = {}) {
    if (!isAbsolute(command ?? "") || command !== expectedCommand || typeof spawnProcess !== "function" ||
        (expectedCodexHome !== null && !isAbsolute(expectedCodexHome ?? "")) ||
        !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
      throw new TypeError("pinned Codex task producer configuration is invalid");
    }
    this.command = resolve(command);
    this.spawnProcess = spawnProcess;
    this.environment = environment;
    this.expectedCodexHome = expectedCodexHome === null ? null : resolve(expectedCodexHome);
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.pending = new Map();
    this.buffer = "";
    this.bytes = 0;
    this.nextId = 1;
    this.failure = null;
    this.identity = null;
  }

  async connect() {
    let info; let canonical;
    try { info = await lstat(this.command); canonical = await realpath(this.command); } catch { fail("CODEX_IDENTITY_MISMATCH", "pinned Codex executable is unavailable"); }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || canonical !== this.command || (info.mode & 0o111) === 0 || (info.mode & 0o022) !== 0) {
      fail("CODEX_IDENTITY_MISMATCH", "pinned Codex executable type, path, or mode is unsafe");
    }
    const env = {
      ...this.environment,
      PATH: `${dirname(this.command)}:/usr/bin:/bin`,
    };
    this.child = this.spawnProcess(this.command, ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "ignore"], env });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.once("error", () => this.#rejectAll(new ProductionTaskPreparationError("APP_SERVER_UNAVAILABLE", "pinned Codex app-server could not start")));
    this.child.once("close", () => this.#rejectAll(new ProductionTaskPreparationError("APP_SERVER_UNAVAILABLE", "pinned Codex app-server closed before completing the request")));
    const initialized = await this.request("initialize", {
      clientInfo: { name: "nelos_production_task_preparer", title: "Nelos production task preparer", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (!exactFields(initialized, ["codexHome", "platformFamily", "platformOs", "userAgent"]) || typeof initialized.codexHome !== "string" || !isAbsolute(initialized.codexHome) ||
        (this.expectedCodexHome !== null && resolve(initialized.codexHome) !== this.expectedCodexHome)) {
      fail("CODEX_IDENTITY_MISMATCH", "pinned Codex initialize response is incompatible");
    }
    this.identity = Object.freeze(validateCodexIdentity({
      command: this.command,
      platformFamily: initialized.platformFamily,
      platformOs: initialized.platformOs,
      userAgent: initialized.userAgent,
    }, this.command));
    this.notify("initialized", {});
    return this.identity;
  }

  #consume(chunk) {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > MAX_PROTOCOL_BYTES) {
      this.child?.kill("SIGKILL");
      this.#rejectAll(new ProductionTaskPreparationError("APP_SERVER_UNAVAILABLE", "pinned Codex response exceeded its bound"));
      return;
    }
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this.#rejectAll(new ProductionTaskPreparationError("APP_SERVER_UNAVAILABLE", "pinned Codex returned malformed JSON"));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new ProductionTaskPreparationError("APP_SERVER_REJECTED", "pinned Codex rejected a task preparation request"));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error) {
    if (this.failure === null) this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  request(method, params) {
    if (this.failure !== null) return Promise.reject(this.failure);
    const id = this.nextId; this.nextId += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new ProductionTaskPreparationError("APP_SERVER_TIMEOUT", `pinned Codex ${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); }

  async startThread({ cwd }) {
    let result;
    try {
      result = await this.request("thread/start", {
        cwd,
        approvalPolicy: "never",
        ephemeral: false,
        serviceName: "nelos",
        threadSource: "nelos-cli",
        sandbox: "read-only",
      });
    } catch {
      fail("TASK_CREATION_AMBIGUOUS", "thread/start did not return one provable task identity; do not retry creation");
    }
    return validateThread(result?.thread);
  }

  async readThread(id) {
    const result = await this.request("thread/read", { threadId: taskId(id), includeTurns: false });
    return validateThread(result?.thread, id);
  }

  async setTitle(id, title) { await this.request("thread/name/set", { threadId: taskId(id), name: title }); }

  async assertNoTurns(id) {
    const result = await this.request("thread/turns/list", { threadId: taskId(id), limit: 1 });
    if (!exactFields(result, ["data", "nextCursor"]) || !Array.isArray(result.data) || result.data.length !== 0 || result.nextCursor !== null) {
      fail("INITIAL_TURN_FORBIDDEN", "prepared production task already contains a model turn");
    }
  }

  async listAllThreadIds() {
    const sourceKinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
    const ids = [];
    for (const archived of [false, true]) {
      const result = await this.request("thread/list", {
        limit: 100, sortKey: "updated_at", sortDirection: "desc", sourceKinds, archived, useStateDbOnly: true,
      });
      if (!exactFields(result, ["data", "nextCursor"]) || !Array.isArray(result.data) || result.data.length > 100 || result.nextCursor !== null ||
          result.data.some((thread) => !TASK_ID.test(thread?.id ?? ""))) {
        fail("TASK_INVENTORY_INCOMPLETE", "Codex did not return one complete bounded task inventory");
      }
      ids.push(...result.data.map(({ id }) => id));
    }
    if (new Set(ids).size !== ids.length) fail("TASK_INVENTORY_INCOMPLETE", "Codex task inventory contains duplicate identities");
    return ids.sort();
  }

  async accountBindingDigest(runId) {
    if (!TASK_ID.test(runId ?? "")) fail("CODEX_ACCOUNT_MISMATCH", "run identity is invalid for account binding");
    const result = await this.request("account/read", { refreshToken: false });
    if (!exactFields(result, ["account", "requiresOpenaiAuth"]) || result.requiresOpenaiAuth !== true ||
        !exactFields(result.account, ["email", "planType", "type"]) || result.account.type !== "chatgpt" ||
        typeof result.account.email !== "string" || result.account.email.length < 3 || result.account.email.length > 320 ||
        /[\u0000-\u0020\u007f]/u.test(result.account.email)) {
      fail("CODEX_ACCOUNT_MISMATCH", "Codex account identity is unavailable or incompatible");
    }
    const email = Buffer.from(result.account.email.normalize("NFKC").toLowerCase(), "utf8");
    try { return `sha256:${createHash("sha256").update(runId).update("\0").update(email).digest("hex")}`; }
    finally { email.fill(0); }
  }

  async close() {
    this.#rejectAll(new ProductionTaskPreparationError("APP_SERVER_UNAVAILABLE", "pinned Codex app-server session closed"));
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    this.child = null;
  }
}

async function finalizeTask({ client, marker, intent, root, title }) {
  let observed = await client.readThread(marker.taskId);
  if (observed.createdAt !== marker.createdAt) fail("CREATED_TASK_IDENTITY_MISMATCH", "Codex task creation timestamp changed");
  if (observed.name !== title) {
    if (observed.name !== null && observed.name !== "") fail("TASK_TITLE_CHANGED", "prepared task title changed outside the producer");
    try { await client.setTitle(marker.taskId, title); }
    catch { fail("TASK_TITLE_UPDATE_UNCERTAIN", "thread/name/set outcome is uncertain; retry adoption without creating another task"); }
    observed = await client.readThread(marker.taskId);
  }
  if (observed.name !== title || observed.createdAt !== marker.createdAt) fail("TASK_READBACK_MISMATCH", "thread/read did not return the exact prepared task");
  await client.assertNoTurns(marker.taskId);
  const receipt = {
    schemaVersion: 1,
    type: "nelos-production-task-receipt",
    taskId: marker.taskId,
    title,
    createdAt: marker.createdAt,
    codexIdentity: intent.codexIdentity,
    initialTurnStarted: false,
    intentDigest: marker.intentDigest,
  };
  const bytes = canonicalBytes(receipt);
  const digest = bytesDigest(bytes);
  const path = join(root.path, `production-task-${digest.slice(7)}.json`);
  try {
    try {
      const handle = await open(path, "wx", 0o400);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(root.path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally { bytes.fill(0); }
  const verified = await readProductionTaskReceiptV1({ path, digest, root, expectedCommand: intent.codexIdentity.command });
  if (!sameValue(verified, receipt)) fail("TASK_RECEIPT_DIGEST_MISMATCH", "existing content-addressed task receipt differs");
  return Object.freeze({ taskId: receipt.taskId, title: receipt.title, createdAt: receipt.createdAt, codexIdentity: receipt.codexIdentity, receiptDigest: digest, receiptPath: path });
}

export async function prepareProductionTaskV1({
  root: rootPath,
  title,
  cwd,
  authorizeCreate = false,
}, {
  clientFactory = () => new PinnedCodexTaskPreparationClientV1(),
  expectedUid = typeof process.getuid === "function" ? process.getuid() : 0,
  expectedGid = typeof process.getgid === "function" ? process.getgid() : 0,
  afterCreatedMarker = null,
} = {}) {
  if (!TITLE.test(title ?? "") || !isAbsolute(cwd ?? "") || resolve(cwd) === "/" || typeof clientFactory !== "function" ||
      !Number.isSafeInteger(expectedUid) || !Number.isSafeInteger(expectedGid) || (afterCreatedMarker !== null && typeof afterCreatedMarker !== "function")) {
    fail("INVALID_TASK_PREPARATION", "production task preparation input is invalid");
  }
  const canonicalCwd = await realpath(cwd).catch(() => fail("INVALID_TASK_PREPARATION", "production task cwd is unavailable"));
  const cwdInfo = await lstat(canonicalCwd).catch(() => fail("INVALID_TASK_PREPARATION", "production task cwd is unavailable"));
  if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()) fail("INVALID_TASK_PREPARATION", "production task cwd is not a canonical directory");
  const root = await sealedRoot(rootPath, expectedUid, expectedGid);
  const intentPath = join(root.path, INTENT_NAME);
  const createdPath = join(root.path, CREATED_NAME);
  const existingReceipts = await receiptFiles(root);
  const client = clientFactory();
  if (typeof client?.connect !== "function" || typeof client?.startThread !== "function" || typeof client?.readThread !== "function" ||
      typeof client?.setTitle !== "function" || typeof client?.assertNoTurns !== "function" || typeof client?.close !== "function") {
    throw new TypeError("production task client is invalid");
  }
  try {
    const codexIdentity = await client.connect();
    const expectedIntent = {
      schemaVersion: 1,
      type: "nelos-production-task-intent",
      authorization: "one-shot-explicit",
      title,
      cwdDigest: bytesDigest(Buffer.from(canonicalCwd, "utf8")),
      codexIdentity,
    };
    let intent;
    let intentExists = true;
    try { intent = await readIntent(intentPath, root, expectedIntent); }
    catch (error) {
      if (error?.code !== "UNTRUSTED_TASK_RECEIPT") throw error;
      intentExists = false;
    }
    if (existingReceipts.length === 1) {
      if (!intentExists) fail("TASK_INTENT_MISMATCH", "task receipt has no sealed creation intent");
      const marker = await readCreated(createdPath, root, { codexIdentity, intentDigest: intent.digest });
      const receiptPath = existingReceipts[0];
      const match = RECEIPT_NAME.exec(receiptPath.split("/").at(-1));
      const receiptDigest = `sha256:${match[1]}`;
      const receipt = await readProductionTaskReceiptV1({ path: receiptPath, digest: receiptDigest, root, expectedCommand: codexIdentity.command });
      if (receipt.taskId !== marker.taskId || receipt.createdAt !== marker.createdAt || receipt.title !== title || receipt.intentDigest !== intent.digest || !sameValue(receipt.codexIdentity, codexIdentity)) {
        fail("TASK_RECEIPT_BINDING_MISMATCH", "task receipt differs from its sealed producer lineage");
      }
      const observed = await client.readThread(receipt.taskId);
      if (observed.name !== title || observed.createdAt !== receipt.createdAt) fail("TASK_TITLE_CHANGED", "prepared task no longer matches its immutable receipt");
      await client.assertNoTurns(receipt.taskId);
      return Object.freeze({ taskId: receipt.taskId, title: receipt.title, createdAt: receipt.createdAt, codexIdentity: receipt.codexIdentity, receiptDigest, receiptPath, adopted: true });
    }
    if (intentExists) {
      let marker;
      try { marker = await readCreated(createdPath, root, { codexIdentity, intentDigest: intent.digest }); }
      catch (error) {
        if (error?.code === "UNTRUSTED_TASK_RECEIPT") fail("TASK_CREATION_AMBIGUOUS", "creation intent exists without a provable task identity; do not call thread/start again");
        throw error;
      }
      const result = await finalizeTask({ client, marker, intent: intent.value, root, title });
      return Object.freeze({ ...result, adopted: true });
    }
    if (authorizeCreate !== true) fail("TASK_CREATION_AUTHORIZATION_REQUIRED", "new production task creation requires the explicit one-shot authorization flag");
    await writeExclusive(intentPath, expectedIntent, root);
    const intentDigest = valueDigest(expectedIntent);
    let created;
    try { created = await client.startThread({ cwd: canonicalCwd }); }
    catch (error) {
      if (error?.code === "TASK_CREATION_AMBIGUOUS") throw error;
      fail("TASK_CREATION_AMBIGUOUS", "thread/start outcome is uncertain; do not call it again for this producer root");
    }
    const marker = {
      schemaVersion: 1,
      type: "nelos-production-task-created",
      intentDigest,
      taskId: taskId(created.id),
      createdAt: createdAt(created.createdAt),
      codexIdentity,
    };
    await writeExclusive(createdPath, marker, root);
    await afterCreatedMarker?.(Object.freeze({ ...marker }));
    const result = await finalizeTask({ client, marker, intent: expectedIntent, root, title });
    return Object.freeze({ ...result, adopted: false });
  } finally { await client.close().catch(() => {}); }
}
