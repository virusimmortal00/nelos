import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  codexTaskUrl,
  openAppServerClient,
  parsePositiveInteger,
  resolveSocketPath,
  resolveThreadId,
} from "../src/app-server-client.mjs";
import { startMockAppServer } from "./support/mock-app-server.mjs";

test("parsePositiveInteger accepts positive integers", () => {
  assert.equal(parsePositiveInteger("42", "--value"), 42);
  assert.equal(parsePositiveInteger(1, "--value"), 1);
});

test("parsePositiveInteger rejects invalid values", () => {
  for (const value of [0, -1, 1.5, "nope"]) {
    assert.throws(
      () => parsePositiveInteger(value, "--value"),
      /--value must be a positive integer/,
    );
  }
});

test("explicit task and socket values take precedence", () => {
  assert.equal(resolveThreadId("thread-123"), "thread-123");
  assert.equal(resolveSocketPath("/tmp/codex.sock"), "/tmp/codex.sock");
});

test("codexTaskUrl safely encodes task IDs", () => {
  assert.equal(codexTaskUrl("thread/with spaces"), "codex://threads/thread%2Fwith%20spaces");
});

test("package root exports the shared app-server client API", async () => {
  const packageApi = await import("nelos");

  assert.equal(typeof packageApi.AppServerClient, "function");
  assert.equal(typeof packageApi.openAppServerClient, "function");
  assert.equal(typeof packageApi.resolveControlEndpoint, "function");
  assert.equal(typeof packageApi.allocateWebId, "function");
  assert.equal(typeof packageApi.renderWebTitle, "function");
});

test("an open client remains usable after the request timeout interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-server-client-idle-"));
  const socketPath = join(root, "app.sock");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "probe") return { alive: true };
    throw new Error(`unexpected method: ${method}`);
  });
  let client;

  try {
    client = await openAppServerClient({
      clientName: "idle-test",
      clientTitle: "Idle test",
      socketPath,
      timeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(client.socket.timeout, 0);
    assert.deepEqual(await client.request("probe", {}), { alive: true });
  } finally {
    client?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a per-request timeout ignores a late response and keeps the client usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-server-client-request-timeout-"));
  const socketPath = join(root, "app.sock");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return { tooLate: true };
    }
    if (method === "probe") return { alive: true };
    throw new Error(`unexpected method: ${method}`);
  });
  let client;

  try {
    client = await openAppServerClient({
      clientName: "request-timeout-test",
      clientTitle: "Request timeout test",
      socketPath,
      timeoutMs: 1_000,
    });

    await assert.rejects(
      client.request("slow", {}, { timeoutMs: 20 }),
      /slow timed out after 20 ms/,
    );
    assert.equal(client.pending.size, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await client.request("probe", {}), { alive: true });
  } finally {
    client?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("openAppServerClient discovers a host endpoint from the process environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-server-client-host-endpoint-"));
  const socketPath = join(root, "app.sock");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    throw new Error(`unexpected method: ${method}`);
  });
  const previous = process.env.CODEX_APP_SERVER_CONTROL_ENDPOINT;
  let client;
  try {
    process.env.CODEX_APP_SERVER_CONTROL_ENDPOINT = JSON.stringify({
      schemaVersion: 1,
      transport: "unix-websocket",
      path: socketPath,
      protocolVersion: "fixture-v1",
    });
    client = await openAppServerClient({
      clientName: "host-endpoint-test",
      clientTitle: "Host endpoint test",
      timeoutMs: 1_000,
    });
    assert.equal(client.socketPath, socketPath);
    assert.equal(client.controlEndpoint.source, "host-endpoint");
    assert.equal(client.controlEndpoint.endpoint.protocolVersion, "fixture-v1");
  } finally {
    client?.close();
    if (previous === undefined) delete process.env.CODEX_APP_SERVER_CONTROL_ENDPOINT;
    else process.env.CODEX_APP_SERVER_CONTROL_ENDPOINT = previous;
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("openAppServerClient rejects ambiguous endpoint arguments before connecting", async () => {
  await assert.rejects(
    openAppServerClient({
      clientName: "ambiguous-test",
      clientTitle: "Ambiguous test",
      socketPath: "/tmp/explicit.sock",
      resolvedControlEndpoint: {
        source: "host-endpoint",
        endpoint: {
          schemaVersion: 1,
          transport: "unix-websocket",
          path: "/tmp/host.sock",
          protocolVersion: "fixture-v1",
        },
      },
    }),
    /socketPath or resolvedControlEndpoint, not both/,
  );
});

test("openAppServerClient rejects implicit standalone fallback", async () => {
  await assert.rejects(
    openAppServerClient({
      clientName: "desktop-safety-test",
      clientTitle: "Desktop safety test",
      resolvedControlEndpoint: {
        source: "codex-home-default",
        endpoint: {
          schemaVersion: 1,
          transport: "unix-websocket",
          path: "/tmp/implicit-standalone.sock",
          protocolVersion: null,
        },
      },
    }),
    /use native Codex task tools or pass --socket/,
  );
});
