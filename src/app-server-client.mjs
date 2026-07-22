import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import {
  resolveControlEndpoint,
  validateResolvedControlEndpoint,
} from "./control-endpoint.mjs";

export {
  CONTROL_ENDPOINT_ENV,
  LEGACY_CONTROL_SOCKET_ENV,
  parseControlEndpoint,
  resolveControlEndpoint,
  validateResolvedControlEndpoint,
} from "./control-endpoint.mjs";

export {
  allocateWebId,
  assertWebId,
  parseWebTitle,
  renderWebTitle,
} from "./task-web.mjs";

export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

export function resolveSocketPath(socketPath) {
  return resolveControlEndpoint({ socketPath }).endpoint.path;
}

export function resolveThreadId(threadId) {
  const resolved = threadId || process.env.CODEX_THREAD_ID;
  if (!resolved) {
    throw new Error("task ID is required; set CODEX_THREAD_ID or pass --thread-id");
  }
  return resolved;
}

export function codexTaskUrl(threadId) {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function encodeClientFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const mask = randomBytes(4);
  let header;

  if (data.length <= 125) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = data[index] ^ mask[index % mask.length];
  }

  return Buffer.concat([header, mask, masked]);
}

function formatProtocolError(error) {
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  return JSON.stringify(error);
}

export class AppServerClient {
  constructor(socketPath, timeoutMs) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.state = "disconnected";
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextRequestId = 1;
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const websocketKey = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1")
        .update(websocketKey + WEBSOCKET_GUID)
        .digest("base64");
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      this.state = "handshake";
      this.socket = net.createConnection(this.socketPath);
      this.socket.setTimeout(this.timeoutMs);
      this.socket.once("error", fail);
      const handleConnectTimeout = () => {
        fail(new Error(`timed out connecting to ${this.socketPath}`));
        this.socket.destroy();
      };
      this.socket.once("timeout", handleConnectTimeout);
      this.socket.once("connect", () => {
        const request = [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${websocketKey}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n");
        this.socket.write(request);
      });
      this.socket.on("data", (chunk) => {
        try {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          if (this.state === "handshake") {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;

            const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
            this.buffer = this.buffer.subarray(headerEnd + 4);
            const lines = headerText.split("\r\n");
            if (!/^HTTP\/1\.[01] 101\b/.test(lines[0])) {
              throw new Error(`WebSocket upgrade failed: ${lines[0]}`);
            }

            const headers = new Map();
            for (const line of lines.slice(1)) {
              const separator = line.indexOf(":");
              if (separator > 0) {
                headers.set(
                  line.slice(0, separator).trim().toLowerCase(),
                  line.slice(separator + 1).trim(),
                );
              }
            }
            if (headers.get("sec-websocket-accept") !== expectedAccept) {
              throw new Error("WebSocket server acceptance key did not match");
            }

            this.state = "open";
            this.socket.setTimeout(0);
            this.socket.removeListener("error", fail);
            this.socket.removeListener("timeout", handleConnectTimeout);
            this.socket.on("error", (error) => this.failAll(error));
            this.socket.on("close", () => {
              if (this.state !== "closed") {
                this.failAll(new Error("app-server closed the connection"));
              }
              this.state = "closed";
            });
            settled = true;
            resolve();
          }

          if (this.state === "open") this.consumeFrames();
        } catch (error) {
          fail(error);
          this.failAll(error);
          this.socket.destroy();
        }
      });
    });
  }

  consumeFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        const largeLength = this.buffer.readBigUInt64BE(offset);
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("WebSocket frame is too large");
        }
        payloadLength = Number(largeLength);
        offset += 8;
      }

      if (payloadLength > MAX_MESSAGE_BYTES) {
        throw new Error(`WebSocket frame exceeds ${MAX_MESSAGE_BYTES} bytes`);
      }

      const maskLength = masked ? 4 : 0;
      const frameLength = offset + maskLength + payloadLength;
      if (this.buffer.length < frameLength) return;

      let mask;
      if (masked) {
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(frameLength);

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % mask.length];
        }
      }

      this.handleFrame(opcode, final, payload);
    }
  }

  handleFrame(opcode, final, payload) {
    if (opcode === 0x8) {
      this.state = "closed";
      this.socket.end();
      this.failAll(new Error("app-server sent a WebSocket close frame"));
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(encodeClientFrame(payload, 0x0a));
      return;
    }
    if (opcode === 0x0a) return;

    if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragmentOpcode !== null) {
        throw new Error("received a new data frame during a fragmented message");
      }
      if (final) {
        this.handleMessage(opcode, payload);
        return;
      }
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      return;
    }

    if (opcode !== 0x0 || this.fragmentOpcode === null) {
      throw new Error(`unsupported WebSocket opcode: ${opcode}`);
    }

    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
      throw new Error(`WebSocket message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }
    this.fragments.push(payload);
    if (final) {
      const completePayload = Buffer.concat(this.fragments, this.fragmentBytes);
      const completeOpcode = this.fragmentOpcode;
      this.fragmentOpcode = null;
      this.fragments = [];
      this.fragmentBytes = 0;
      this.handleMessage(completeOpcode, completePayload);
    }
  }

  handleMessage(opcode, payload) {
    if (opcode !== 0x1) {
      throw new Error("received an unsupported binary WebSocket message");
    }

    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch (error) {
      throw new Error(`invalid JSON from app-server: ${error.message}`);
    }

    if (!("id" in message)) return;
    const pending = this.takePending(message.id);
    if (!pending) return;

    if ("error" in message && message.error !== null) {
      pending.reject(new Error(formatProtocolError(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  takePending(id) {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
    return pending;
  }

  request(method, params, { timeoutMs = this.timeoutMs, signal = null } = {}) {
    if (this.state !== "open") {
      return Promise.reject(new Error("app-server connection is not open"));
    }
    const requestTimeoutMs = parsePositiveInteger(timeoutMs, "request timeout");
    if (
      signal !== null &&
      (typeof signal?.addEventListener !== "function" ||
        typeof signal?.removeEventListener !== "function")
    ) {
      return Promise.reject(new Error("request signal must be an AbortSignal"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error(`${method} aborted`));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const payload = JSON.stringify({ method, id, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.takePending(id)?.reject(
          new Error(`${method} timed out after ${requestTimeoutMs} ms`),
        );
      }, requestTimeoutMs);
      const abort = () => {
        this.takePending(id)?.reject(new Error(`${method} aborted`));
      };
      this.pending.set(id, { resolve, reject, timer, signal, abort });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.socket.write(encodeClientFrame(payload));
    });
  }

  notify(method, params) {
    if (this.state !== "open") {
      throw new Error("app-server connection is not open");
    }
    const message = params === undefined ? { method } : { method, params };
    this.socket.write(encodeClientFrame(JSON.stringify(message)));
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (!this.socket) return;
    this.state = "closed";
    this.failAll(new Error("app-server connection closed"));
    if (!this.socket.destroyed) this.socket.end();
  }
}

export async function openAppServerClient({
  clientName,
  clientTitle,
  socketPath,
  resolvedControlEndpoint,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  version = "1.0.0",
}) {
  const parsedTimeout = parsePositiveInteger(timeoutMs, "--timeout-ms");
  if (socketPath != null && resolvedControlEndpoint != null) {
    throw new Error("supply socketPath or resolvedControlEndpoint, not both");
  }
  const resolved = resolvedControlEndpoint == null
    ? resolveControlEndpoint({ socketPath })
    : validateResolvedControlEndpoint(resolvedControlEndpoint);
  if (resolved.source === "codex-home-default") {
    throw new Error(
      "no host app-server control endpoint is available; use native Codex task tools " +
        "or pass --socket for explicit standalone development",
    );
  }
  const client = new AppServerClient(resolved.endpoint.path, parsedTimeout);
  client.controlEndpoint = resolved;
  await client.connect();
  try {
    const initializeResult = await client.request("initialize", {
      clientInfo: {
        name: clientName,
        title: clientTitle,
        version,
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    client.serverIdentity = {
      userAgent: initializeResult?.userAgent ?? null,
      platformFamily: initializeResult?.platformFamily ?? null,
      platformOs: initializeResult?.platformOs ?? null,
    };
    client.notify("initialized", {});
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
