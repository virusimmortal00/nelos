#!/usr/lib/chatgpt/resources/cua_node/bin/node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const CODEX = process.env.NELOS_DEVICE_AUTH_CODEX ?? "/usr/lib/chatgpt/resources/codex";
const CODEX_HOME = process.env.CODEX_HOME;
const STATE_DIR = process.env.NELOS_DEVICE_AUTH_STATE_DIR ?? "/run/nelos-desktop/auth";
const CHALLENGE_PATH = `${STATE_DIR}/challenge.json`;
const COMPLETE_PATH = `${STATE_DIR}/complete.json`;
const DEADLINE_MS = Number(process.env.NELOS_DEVICE_AUTH_DEADLINE_MS ?? 900_000);
const POLL_MS = Number(process.env.NELOS_DEVICE_AUTH_POLL_MS ?? 1_000);
const MAX_LINE_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 65_536;
const mode = process.argv[2];
const RUN_ID = process.env.NELOS_RUN_ID;

function fail(message) {
  const error = new Error(message);
  error.isDeviceAuthFailure = true;
  throw error;
}

function exactFields(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

function validateBounds() {
  if (!Number.isSafeInteger(DEADLINE_MS) || DEADLINE_MS < 1_000 || DEADLINE_MS > 900_000 ||
      !Number.isSafeInteger(POLL_MS) || POLL_MS < 1 || POLL_MS > 10_000 ||
      typeof RUN_ID !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(RUN_ID)) {
    fail("device-auth timing bounds are invalid");
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.new`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

class AppServerSession {
  constructor() {
    const required = ["HOME", "CODEX_HOME"];
    if (required.some((name) => typeof process.env[name] !== "string" || !process.env[name])) {
      fail("isolated HOME and CODEX_HOME are required");
    }
    this.child = spawn(CODEX, [
      "app-server", "--stdio", "--strict-config", "-c", 'cli_auth_credentials_store="file"',
    ], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: process.env.HOME,
        CODEX_HOME: process.env.CODEX_HOME,
        USER: "nelosauto",
        LOGNAME: "nelosauto",
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
      },
    });
    this.buffer = "";
    this.stderrBytes = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > MAX_STDERR_BYTES) this.child.kill("SIGKILL");
    });
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("close", (code) => {
      this.closed = true;
      this.rejectAll(new Error(`Codex app-server exited before auth completed (${code ?? "signal"})`));
    });
  }

  rejectAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
      this.child.kill("SIGKILL");
      this.rejectAll(new Error("Codex app-server response exceeded its bound"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this.child.kill("SIGKILL");
        this.rejectAll(new Error("Codex app-server returned invalid JSONL"));
        return;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error("Codex app-server request failed"));
      else pending.resolve(message.result);
    }
  }

  request(method, params, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Codex app-server ${method} timed out`));
      }, Math.min(timeoutMs, 30_000));
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "nelos_desktop_device_auth", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (!exactFields(result, ["codexHome", "platformFamily", "platformOs", "userAgent"]) ||
        result.codexHome !== CODEX_HOME || result.platformFamily !== "unix" || result.platformOs !== "linux" ||
        result.userAgent !== "Codex Desktop/0.148.0-alpha.15") {
      fail("pinned Codex app-server identity is incompatible");
    }
    this.notify("initialized", {});
  }

  async account() {
    const result = await this.request("account/read", { refreshToken: false });
    if (!exactFields(result, ["account", "requiresOpenaiAuth"]) || result.requiresOpenaiAuth !== true) {
      fail("Codex account/read response is incompatible");
    }
    if (result.account === null) return null;
    if (!exactFields(result.account, ["email", "planType", "type"]) || result.account.type !== "chatgpt" ||
        typeof result.account.email !== "string" || result.account.email.length < 3 || result.account.email.length > 320 ||
        /[\u0000-\u0020\u007f]/u.test(result.account.email)) {
      fail("only isolated ChatGPT device authentication is accepted");
    }
    const email = Buffer.from(result.account.email.normalize("NFKC").toLowerCase(), "utf8");
    try {
      return { type: "chatgpt", accountBindingDigest: `sha256:${createHash("sha256").update(RUN_ID).update("\0").update(email).digest("hex")}` };
    } finally { email.fill(0); }
  }

  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    await Promise.race([
      new Promise((resolvePromise) => this.child.once("close", resolvePromise)),
      delay(1_000).then(() => this.child.kill("SIGTERM")),
    ]);
  }
}

async function status() {
  const session = new AppServerSession();
  try {
    await session.initialize();
    const account = await session.account();
    process.stdout.write(`${JSON.stringify({
      authenticated: account?.type === "chatgpt",
      accountType: account?.type ?? null,
      accountBindingDigest: account?.accountBindingDigest ?? null,
      credentialStore: "file",
    })}\n`);
  } finally {
    await session.close();
  }
}

async function login() {
  const session = new AppServerSession();
  let loginId = null;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    await session.initialize();
    const existing = await session.account();
    if (existing) {
      await atomicJson(COMPLETE_PATH, { authenticated: true, accountType: "chatgpt", accountBindingDigest: existing.accountBindingDigest, credentialStore: "file" });
      return;
    }
    const challenge = await session.request("account/login/start", { type: "chatgptDeviceCode" });
    if (!exactFields(challenge, ["loginId", "type", "userCode", "verificationUrl"]) ||
        challenge.type !== "chatgptDeviceCode" || typeof challenge.loginId !== "string" || !challenge.loginId ||
        typeof challenge.userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/u.test(challenge.userCode) ||
        typeof challenge.verificationUrl !== "string" || !challenge.verificationUrl.startsWith("https://")) {
      fail("Codex device-auth challenge is incompatible");
    }
    loginId = challenge.loginId;
    await atomicJson(CHALLENGE_PATH, {
      type: "chatgptDeviceCode",
      userCode: challenge.userCode,
      verificationUrl: challenge.verificationUrl,
    });
    const deadline = Date.now() + DEADLINE_MS;
    while (!cancelled && Date.now() < deadline) {
      await delay(POLL_MS);
      const account = await session.account();
      if (account) {
        await atomicJson(COMPLETE_PATH, { authenticated: true, accountType: "chatgpt", accountBindingDigest: account.accountBindingDigest, credentialStore: "file" });
        return;
      }
    }
    if (loginId) {
      try { await session.request("account/login/cancel", { loginId }, 5_000); } catch { /* fail closed below */ }
    }
    fail(cancelled ? "device authentication was cancelled" : "device authentication timed out");
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    await session.close();
  }
}

try {
  validateBounds();
  if (mode === "login") await login();
  else if (mode === "status") await status();
  else fail("expected login or status operation");
} catch (error) {
  process.stderr.write(`${error?.isDeviceAuthFailure ? error.message : "device-auth controller failed"}\n`);
  process.exitCode = 70;
}
