import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_ENDPOINT_ENV,
  parseControlEndpoint,
  resolveControlEndpoint,
  validateResolvedControlEndpoint,
} from "../src/control-endpoint.mjs";

const hostDescriptor = JSON.stringify({
  schemaVersion: 1,
  transport: "unix-websocket",
  path: "/run/user/501/codex.sock",
  protocolVersion: "2026-07-01",
});

test("host endpoint is discovered before legacy and default sockets", () => {
  const resolved = resolveControlEndpoint({
    env: {
      CODEX_APP_SERVER_CONTROL_ENDPOINT: hostDescriptor,
      CODEX_APP_SERVER_CONTROL_SOCKET: "/tmp/legacy.sock",
      CODEX_HOME: "/tmp/codex-home",
    },
  });
  assert.equal(resolved.source, "host-endpoint");
  assert.deepEqual(resolved.endpoint, {
    schemaVersion: 1,
    transport: "unix-websocket",
    path: "/run/user/501/codex.sock",
    protocolVersion: "2026-07-01",
  });
});

test("explicit socket remains highest priority for compatibility", () => {
  const resolved = resolveControlEndpoint({
    socketPath: "/tmp/explicit.sock",
    env: { CODEX_APP_SERVER_CONTROL_ENDPOINT: hostDescriptor },
  });
  assert.equal(resolved.source, "explicit-socket");
  assert.equal(resolved.endpoint.path, "/tmp/explicit.sock");
});

test("legacy environment and CODEX_HOME fallback remain compatible", () => {
  assert.equal(
    resolveControlEndpoint({
      env: { CODEX_APP_SERVER_CONTROL_SOCKET: "/tmp/legacy.sock" },
    }).endpoint.path,
    "/tmp/legacy.sock",
  );
  assert.equal(
    resolveControlEndpoint({ env: {}, codexHome: "/tmp/codex-home" }).endpoint.path,
    "/tmp/codex-home/app-server-control/app-server-control.sock",
  );
});

test("endpoint descriptors fail closed on malformed or unknown contracts", () => {
  for (const value of [
    "not-json",
    "[]",
    JSON.stringify({ schemaVersion: 2, transport: "unix-websocket", path: "/x" }),
    JSON.stringify({ schemaVersion: 1, transport: "tcp", path: "/x" }),
    JSON.stringify({ schemaVersion: 1, transport: "unix-websocket", path: "relative" }),
    JSON.stringify({ schemaVersion: 1, transport: "unix-websocket", path: "/x", protocolVersion: 1 }),
    JSON.stringify({ schemaVersion: 1, transport: "unix-websocket", path: "/x", protocolVersion: "" }),
  ]) {
    assert.throws(() => parseControlEndpoint(value));
  }
});

test("an empty host endpoint is present and fails closed", () => {
  assert.throws(
    () => resolveControlEndpoint({ env: { CODEX_APP_SERVER_CONTROL_ENDPOINT: "" } }),
    /valid JSON control endpoint descriptor/,
  );
});

test("endpoint validation errors do not echo descriptor content", () => {
  const sentinel = "do-not-echo-endpoint-token";
  assert.throws(
    () => parseControlEndpoint(`{${sentinel}`),
    (error) => {
      assert.equal(
        error.message,
        `${CONTROL_ENDPOINT_ENV} must be a valid JSON control endpoint descriptor`,
      );
      assert.doesNotMatch(error.message, new RegExp(sentinel));
      return true;
    },
  );

  for (const value of [
    JSON.stringify({ schemaVersion: sentinel }),
    JSON.stringify({ schemaVersion: 1, transport: sentinel }),
  ]) {
    assert.throws(
      () => parseControlEndpoint(value),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        return true;
      },
    );
  }
});

test("pre-resolved endpoint validation rejects ambiguous shapes", () => {
  assert.throws(() => validateResolvedControlEndpoint(null), /resolved control endpoint/);
  assert.throws(
    () => validateResolvedControlEndpoint({ source: "host-endpoint", endpoint: {} }),
    /unsupported endpoint contract/,
  );
  assert.throws(
    () =>
      validateResolvedControlEndpoint({
        source: "host-endpoint",
        endpoint: {
          schemaVersion: 1,
          transport: "unix-websocket",
          path: "relative.sock",
          protocolVersion: "fixture-v1",
        },
      }),
    /host path must be absolute/,
  );
});

test("explicit and legacy relative socket paths retain legacy behavior", () => {
  assert.equal(
    resolveControlEndpoint({ socketPath: "relative.sock", env: {} }).endpoint.path,
    "relative.sock",
  );
  assert.equal(
    resolveControlEndpoint({
      env: { CODEX_APP_SERVER_CONTROL_SOCKET: "relative.sock" },
    }).endpoint.path,
    "relative.sock",
  );
});
