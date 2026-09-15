import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { ExecutorContractError, executorExact } from "./executor-contract.mjs";

const MAX_BYTES = 128 * 1024;
const fail = (code) => { throw new ExecutorContractError(code); };
const privateOwner = (info) => (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid());

export async function readPrivateExecutorJsonV1(path) {
  if (!isAbsolute(path)) fail("absolute-service-path-required");
  await ensureCanonicalDirectory(dirname(path), "executor channel directory", { create: false });
  if (!privateOwner(await lstat(dirname(path)))) fail("insecure-service-directory");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || !privateOwner(info) || info.size > MAX_BYTES) fail("insecure-service-file");
    const bytes = await file.readFile();
    if (bytes.length > MAX_BYTES) fail("service-message-too-large");
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { fail("invalid-service-file"); }
  } finally { await file.close(); }
}

// Called only after this job's service owns the election lock. A live or
// indeterminate listener is never removed, even when its descriptor is stale.
async function clearStoppedEndpoint(socketPath, descriptorPath) {
  const info = await lstat(socketPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info) {
    if (!info.isSocket() || !privateOwner(info)) fail("insecure-service-socket");
    const stopped = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 1000);
      probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
      probe.once("error", (error) => { clearTimeout(timer); probe.destroy();
        resolve(["ECONNREFUSED", "ENOENT"].includes(error.code)); });
    });
    if (!stopped) fail("service-endpoint-already-live");
  }
  const descriptor = await readPrivateExecutorJsonV1(descriptorPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (descriptor) {
    executorExact(descriptor, ["schemaVersion", "socketPath", "token"]);
    if (descriptor.schemaVersion !== 1 || descriptor.socketPath !== socketPath ||
        typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.token)) fail("invalid-service-endpoint");
    await unlink(descriptorPath);
  }
  if (info) await unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
}

// Local Unix IPC, confined to the current OS user's private directory. The
// bearer credential is never returned through MCP. This is not isolation from
// other processes already able to act as that same OS user.
export async function serveExecutorJobV1({ service, directory }) {
  await ensureCanonicalDirectory(directory, "executor channel directory");
  if (!privateOwner(await lstat(directory))) fail("insecure-service-directory");
  const socketPath = join(directory, "control.sock");
  if (Buffer.byteLength(socketPath) > 100) fail("service-socket-path-too-long");
  const descriptorPath = join(directory, "endpoint.json");
  if (service.status().state !== "ready") fail("service-owner-unavailable");
  await clearStoppedEndpoint(socketPath, descriptorPath);
  const token = randomBytes(32).toString("hex");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    let buffer = "", client = null;
    const pending = new Set();
    socket.setTimeout(5000, () => socket.destroy());
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); if (client) service.detach(client); });
    const send = (message) => {
      const bytes = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(bytes) > MAX_BYTES || socket.writableLength + Buffer.byteLength(bytes) > MAX_BYTES * 2) {
        socket.destroy(); return;
      }
      if (!socket.destroyed) socket.write(bytes);
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_BYTES || pending.size >= 4) { socket.destroy(); return; }
        let message;
        try {
          message = JSON.parse(line);
          executorExact(message, ["id", "method", "params", "token"]);
          if (!Number.isSafeInteger(message.id) || message.id < 1 || pending.has(message.id) ||
              typeof message.token !== "string" || !/^[a-f0-9]{64}$/u.test(message.token) ||
              !timingSafeEqual(Buffer.from(token), Buffer.from(message.token))) fail("service-authentication-failed");
          if (!client) { client = service.attach(); socket.setTimeout(0); }
        } catch { socket.destroy(); return; }
        pending.add(message.id);
        Promise.resolve().then(() => service.request(client, message.method, message.params)).then(
          (result) => send({ id: message.id, result }),
          (error) => send({ id: message.id, error: { code: error instanceof ExecutorContractError ? error.code : "service-request-failed" } }),
        ).finally(() => { pending.delete(message.id); });
      }
      if (Buffer.byteLength(buffer) > MAX_BYTES) socket.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(socketPath, resolve);
  });
  // Any later listener error closes clients; it never becomes an uncaught
  // exception that could silently orphan service-owned work.
  server.on("error", () => { for (const socket of sockets) socket.destroy(); });
  try {
    await chmod(socketPath, 0o600);
    await writeFile(descriptorPath, JSON.stringify({ schemaVersion: 1, socketPath, token }), { mode: 0o600, flag: "wx" });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve)); throw error;
  }
  return { descriptorPath, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    // This listener created the descriptor exclusively. Never unlink a file
    // that was replaced with a different owner's endpoint.
    const current = await readPrivateExecutorJsonV1(descriptorPath).catch(() => null);
    if (current?.token === token) await unlink(descriptorPath);
  } };
}

export class ExecutorServiceClientV1 {
  #socket; #token; #sequence = 0; #pending = new Map(); #buffer = ""; #closed = false;
  constructor(socket, token) {
    this.#socket = socket; this.#token = token;
    socket.setEncoding("utf8");
    socket.on("error", () => this.close()); socket.on("close", () => this.close());
    socket.on("data", (chunk) => {
      this.#buffer += chunk;
      let newline;
      while ((newline = this.#buffer.indexOf("\n")) !== -1) {
        const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_BYTES) { this.close(); return; }
        try {
          const message = JSON.parse(line), entry = this.#pending.get(message.id);
          if (!entry) { this.close(); return; }
          this.#pending.delete(message.id); clearTimeout(entry.timer);
          if (message.error) entry.reject(new ExecutorContractError(
            /^[a-z][a-z0-9-]{0,100}$/u.test(message.error.code) ? message.error.code : "service-request-failed"));
          else if (Object.hasOwn(message, "result")) entry.resolve(message.result);
          else { entry.reject(new ExecutorContractError("invalid-service-response")); this.close(); }
        } catch { this.close(); return; }
      }
      if (Buffer.byteLength(this.#buffer) > MAX_BYTES) this.close();
    });
  }

  static async connect(descriptorPath) {
    const descriptor = await readPrivateExecutorJsonV1(descriptorPath);
    executorExact(descriptor, ["schemaVersion", "socketPath", "token"]);
    if (descriptor.schemaVersion !== 1 || descriptor.socketPath !== join(dirname(descriptorPath), "control.sock") ||
        typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.token)) fail("invalid-service-endpoint");
    const info = await lstat(descriptor.socketPath);
    if (!info.isSocket() || !privateOwner(info)) fail("insecure-service-socket");
    const socket = net.connect(descriptor.socketPath);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new ExecutorContractError("service-connect-timeout")); }, 5000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new ExecutorContractError("service-connect-failed")); });
    });
    return new ExecutorServiceClientV1(socket, descriptor.token);
  }

  request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    if (this.#closed) return Promise.reject(new ExecutorContractError("service-disconnected"));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || this.#pending.size >= 4) {
      return Promise.reject(new ExecutorContractError("invalid-service-request-limits"));
    }
    const id = ++this.#sequence, bytes = `${JSON.stringify({ id, method, params, token: this.#token })}\n`;
    if (Buffer.byteLength(bytes) > MAX_BYTES) return Promise.reject(new ExecutorContractError("service-message-too-large"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(bytes);
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true; this.#socket.destroy();
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer); entry.reject(new ExecutorContractError("service-disconnected-outcome-unknown"));
    }
    this.#pending.clear();
  }
}
