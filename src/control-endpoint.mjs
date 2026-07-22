import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const CONTROL_ENDPOINT_ENV = "CODEX_APP_SERVER_CONTROL_ENDPOINT";
export const LEGACY_CONTROL_SOCKET_ENV = "CODEX_APP_SERVER_CONTROL_SOCKET";
const CONTROL_ENDPOINT_SOURCES = new Set([
  "explicit-socket",
  "host-endpoint",
  "legacy-environment",
  "codex-home-default",
]);

function assertAbsoluteSocketPath(path, source) {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error(`${source} must provide a non-empty socket path`);
  }
  if (!isAbsolute(path)) {
    throw new Error(`${source} must provide an absolute socket path`);
  }
  return path;
}

export function parseControlEndpoint(value, source = CONTROL_ENDPOINT_ENV) {
  let descriptor;
  try {
    descriptor = JSON.parse(value);
  } catch {
    throw new Error(`${source} must be a valid JSON control endpoint descriptor`);
  }
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error(`${source} must be a JSON object`);
  }
  if (descriptor.schemaVersion !== 1) {
    throw new Error(`${source} has an unsupported schemaVersion`);
  }
  if (descriptor.transport !== "unix-websocket") {
    throw new Error(`${source} has an unsupported transport`);
  }
  if (descriptor.protocolVersion !== undefined) {
    if (
      typeof descriptor.protocolVersion !== "string" ||
      !descriptor.protocolVersion.trim()
    ) {
      throw new Error(`${source} protocolVersion must be a non-empty string when provided`);
    }
  }
  return {
    schemaVersion: 1,
    transport: "unix-websocket",
    path: assertAbsoluteSocketPath(descriptor.path, source),
    protocolVersion: descriptor.protocolVersion ?? null,
  };
}

export function resolveControlEndpoint({
  socketPath = null,
  env = process.env,
  codexHome = env.CODEX_HOME || join(homedir(), ".codex"),
} = {}) {
  if (socketPath) {
    return {
      endpoint: {
        schemaVersion: 1,
        transport: "unix-websocket",
        path: socketPath,
        protocolVersion: null,
      },
      source: "explicit-socket",
    };
  }
  if (Object.hasOwn(env, CONTROL_ENDPOINT_ENV)) {
    return {
      endpoint: parseControlEndpoint(env[CONTROL_ENDPOINT_ENV]),
      source: "host-endpoint",
    };
  }
  if (env[LEGACY_CONTROL_SOCKET_ENV]) {
    return {
      endpoint: {
        schemaVersion: 1,
        transport: "unix-websocket",
        path: env[LEGACY_CONTROL_SOCKET_ENV],
        protocolVersion: null,
      },
      source: "legacy-environment",
    };
  }
  return {
    endpoint: {
      schemaVersion: 1,
      transport: "unix-websocket",
      path: join(codexHome, "app-server-control", "app-server-control.sock"),
      protocolVersion: null,
    },
    source: "codex-home-default",
  };
}

export function validateResolvedControlEndpoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("resolvedControlEndpoint must be a resolved control endpoint object");
  }
  if (!CONTROL_ENDPOINT_SOURCES.has(value.source)) {
    throw new Error("resolvedControlEndpoint source is unsupported");
  }
  const endpoint = value.endpoint;
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    throw new Error("resolvedControlEndpoint endpoint must be an object");
  }
  if (endpoint.schemaVersion !== 1 || endpoint.transport !== "unix-websocket") {
    throw new Error("resolvedControlEndpoint uses an unsupported endpoint contract");
  }
  if (typeof endpoint.path !== "string" || !endpoint.path.trim()) {
    throw new Error("resolvedControlEndpoint path must be a non-empty string");
  }
  if (value.source === "host-endpoint" && !isAbsolute(endpoint.path)) {
    throw new Error("resolvedControlEndpoint host path must be absolute");
  }
  if (
    endpoint.protocolVersion !== null &&
    endpoint.protocolVersion !== undefined &&
    (typeof endpoint.protocolVersion !== "string" || !endpoint.protocolVersion.trim())
  ) {
    throw new Error("resolvedControlEndpoint protocolVersion must be a non-empty string or null");
  }
  return value;
}
