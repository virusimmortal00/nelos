// App Server uses bidirectional JSON-RPC without requiring a jsonrpc member.
// Server request IDs and client request IDs are independent namespaces.
export class AppServerRpcError extends Error {
  constructor(message, { code = "protocol-error", rpcCode = null } = {}) {
    super(message);
    this.name = "AppServerRpcError";
    this.code = code;
    this.rpcCode = Number.isSafeInteger(rpcCode) ? rpcCode : null;
  }
}

export function appServerResponseError(error, { includeMessage = false } = {}) {
  // Explicit developer clients retain bounded diagnostics. Service projections
  // use the default and never include arbitrary error messages or data.
  const message = includeMessage && typeof error?.message === "string" && error.message.trim()
    ? error.message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512)
    : "App Server rejected the request";
  return new AppServerRpcError(message, {
    code: "request-rejected",
    rpcCode: error?.code,
  });
}

const has = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (id) => Number.isSafeInteger(id) ||
  (typeof id === "string" && id.length > 0 && id.length <= 512);

function limit(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function validateAppServerDispatcherOptions({
  onNotification = null,
  onServerRequest = null,
  serverRequestTimeoutMs = 60_000,
  maxServerRequests = 16,
  maxPendingNotifications = 256,
  maxNotificationBytes = 4 * 1024 * 1024,
} = {}) {
  for (const [name, callback] of Object.entries({ onNotification, onServerRequest })) {
    if (callback !== null && typeof callback !== "function") {
      throw new Error(`${name} must be a function or null`);
    }
  }
  return {
    onNotification,
    onServerRequest,
    serverRequestTimeoutMs: limit(serverRequestTimeoutMs, "serverRequestTimeoutMs", 300_000),
    maxServerRequests: limit(maxServerRequests, "maxServerRequests", 256),
    maxPendingNotifications: limit(maxPendingNotifications, "maxPendingNotifications", 4096),
    maxNotificationBytes: limit(maxNotificationBytes, "maxNotificationBytes", 16 * 1024 * 1024),
  };
}

export class AppServerRpcDispatcher {
  #closed = false;
  #options;
  #sendResponse;
  #onResponse;
  #onError;
  #requests = new Map();
  #notifications = [];
  #notificationBytes = 0;
  #draining = false;
  #lifetime = new AbortController();

  constructor({ sendResponse, onResponse, onError, ...options }) {
    for (const callback of [sendResponse, onResponse, onError]) {
      if (typeof callback !== "function") throw new Error("dispatcher callbacks are required");
    }
    this.#options = validateAppServerDispatcherOptions(options);
    this.#sendResponse = sendResponse;
    this.#onResponse = onResponse;
    this.#onError = onError;
  }

  receive(message) {
    if (this.#closed) return;
    try {
      if (!object(message)) throw new AppServerRpcError("Invalid App Server message");
      if (has(message, "method")) {
        if (typeof message.method !== "string" || !message.method.length ||
            message.method.length > 512 || has(message, "result") || has(message, "error")) {
          throw new AppServerRpcError("Invalid App Server method message");
        }
        if (has(message, "id")) {
          if (!validId(message.id)) throw new AppServerRpcError("Invalid App Server request ID");
          this.#request(message);
        } else {
          this.#notification(message);
        }
        return;
      }
      if (!validId(message.id) || has(message, "result") === has(message, "error") ||
          (has(message, "error") && !object(message.error))) {
        throw new AppServerRpcError("Invalid App Server response");
      }
      this.#onResponse(message);
    } catch (error) {
      this.#fail(error);
    }
  }

  #send(message) {
    if (this.#closed) return;
    // Validate and snapshot before the transport writes. Undefined is not a reply.
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024 ||
        (!has(message, "error") && !has(JSON.parse(serialized), "result"))) {
      throw new AppServerRpcError("Invalid App Server handler response");
    }
    this.#sendResponse(JSON.parse(serialized));
  }

  #request(message) {
    const { onServerRequest, maxServerRequests, serverRequestTimeoutMs } = this.#options;
    if (this.#requests.has(message.id)) {
      throw new AppServerRpcError("Duplicate pending App Server request ID");
    }
    if (!onServerRequest) {
      this.#send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
      return;
    }
    if (this.#requests.size >= maxServerRequests) {
      this.#send({ id: message.id, error: { code: -32000, message: "Client request capacity exceeded" } });
      return;
    }
    const controller = new AbortController();
    const entry = { controller, timer: null, replied: false, threadId: message.params?.threadId };
    const finish = (reply) => {
      if (this.#closed || entry.replied || this.#requests.get(message.id) !== entry) return;
      entry.replied = true;
      clearTimeout(entry.timer);
      controller.abort();
      try {
        this.#send({ id: message.id, ...reply });
      } catch (error) {
        this.#fail(error);
      }
    };
    entry.timer = setTimeout(() => finish({
      error: { code: -32000, message: "Client request deadline exceeded" },
    }), serverRequestTimeoutMs);
    this.#requests.set(message.id, entry);
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return onServerRequest({ ...message, signal: controller.signal });
    }).then(
      (result) => finish({ result }),
      () => finish({ error: { code: -32603, message: "Client request handler failed" } }),
    ).finally(() => {
      // A timed-out handler that ignores cancellation still occupies capacity.
      if (this.#requests.get(message.id) === entry) this.#requests.delete(message.id);
    });
  }

  #notification(message) {
    if (message.method === "serverRequest/resolved") {
      if (!object(message.params) || !validId(message.params.requestId) ||
          typeof message.params.threadId !== "string" || !message.params.threadId.length) {
        throw new AppServerRpcError("Invalid App Server request resolution");
      }
      const entry = this.#requests.get(message.params.requestId);
      if (entry && entry.threadId === message.params.threadId) {
        entry.replied = true;
        clearTimeout(entry.timer);
        entry.controller.abort();
      }
    }
    if (!this.#options.onNotification) return;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.#notifications.length >= this.#options.maxPendingNotifications ||
        this.#notificationBytes + bytes > this.#options.maxNotificationBytes) {
      throw new AppServerRpcError("App Server notification capacity exceeded", {
        code: "notification-overflow",
      });
    }
    this.#notifications.push({ message, bytes });
    this.#notificationBytes += bytes;
    if (!this.#draining) void this.#drain();
  }

  async #drain() {
    this.#draining = true;
    try {
      while (!this.#closed && this.#notifications.length) {
        const { message, bytes } = this.#notifications[0];
        await this.#options.onNotification({ ...message, signal: this.#lifetime.signal });
        if (this.#closed) return;
        this.#notifications.shift();
        this.#notificationBytes -= bytes;
      }
    } catch {
      this.#fail(new AppServerRpcError("App Server notification handler failed", {
        code: "notification-handler-failed",
      }));
    } finally {
      this.#draining = false;
    }
  }

  #fail(error) {
    if (this.#closed) return;
    this.close();
    this.#onError(error instanceof AppServerRpcError ? error :
      new AppServerRpcError("App Server dispatcher failed"));
  }

  close() {
    this.#closed = true;
    this.#lifetime.abort();
    for (const entry of this.#requests.values()) {
      clearTimeout(entry.timer);
      entry.controller.abort();
    }
    this.#requests.clear();
    this.#notifications = [];
    this.#notificationBytes = 0;
  }
}
