import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CodexAppServerBridgeV1,
  REQUIRED_CODEX_APP_SERVER_INITIALIZE_FIELDS,
  REQUIRED_CODEX_APP_SERVER_METHODS,
  SUPPORTED_CODEX_APP_SERVER_ACTIVE_FLAGS,
  SUPPORTED_CODEX_APP_SERVER_THREAD_STATUSES,
  SUPPORTED_CODEX_APP_SERVER_VERSIONS,
} from "../src/mcp-app-server-bridge.mjs";

function fakeCodexAppServer({
  codexVersion = "0.144.6",
  ignoreNameSetCount = 0,
  ignoreReadCount = 0,
  ignoredMethods = [],
  ignoredReadOrdinals = [],
  initializeOverrides = {},
  initialTurns = [],
  initialTitle = "Release coordination",
  persistRename = true,
  rejectedMethods = [],
  readDelays = {},
  readErrors = {},
  readSequences = {},
  threadOverrides = {},
} = {}) {
  let ignoredNameSets = 0;
  let ignoredReads = 0;
  let readOrdinal = 0;
  let title = initialTitle;
  let spawnCount = 0;
  let activeReads = 0;
  let maxConcurrentReads = 0;
  let turnOrdinal = 0;
  const requests = [];
  const turns = [...initialTurns];
  const threads = new Map(Object.entries(threadOverrides));
  const sequences = new Map(
    Object.entries(readSequences).map(([id, values]) => [id, [...values]]),
  );

  function spawnProcess(command, args) {
    spawnCount += 1;
    assert.equal(command, "codex");
    assert.deepEqual(args, ["app-server", "--stdio"]);

    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
      return true;
    };

    let buffer = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        requests.push(message);
        if (message.id === undefined) continue;
        if (message.method === "thread/read") {
          readOrdinal += 1;
          if (
            ignoredReads < ignoreReadCount ||
            ignoredReadOrdinals.includes(readOrdinal)
          ) {
            ignoredReads += 1;
            continue;
          }
        }
        if (
          message.method === "thread/name/set" &&
          ignoredNameSets < ignoreNameSetCount
        ) {
          ignoredNameSets += 1;
          continue;
        }
        if (ignoredMethods.includes(message.method)) continue;
        if (rejectedMethods.includes(message.method)) {
          child.stdout.write(
            `${JSON.stringify({
              id: message.id,
              error: { message: `${message.method} rejected` },
            })}\n`,
          );
          continue;
        }

        let result;
        let responseDelay = 0;
        if (message.method === "initialize") {
          result = {
            userAgent: `Codex Desktop/${codexVersion} (test)`,
            codexHome: "/codex-home",
            platformFamily: "unix",
            platformOs: "macos",
            ...initializeOverrides,
          };
        } else if (message.method === "thread/read") {
          const resolvedThreadId = message.params.threadId;
          activeReads += 1;
          maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
          if (readErrors[resolvedThreadId]) {
            child.stdout.write(
              `${JSON.stringify({
                id: message.id,
                error: { message: readErrors[resolvedThreadId] },
              })}\n`,
            );
            activeReads -= 1;
            continue;
          }
          const sequence = sequences.get(resolvedThreadId);
          const override =
            sequence?.length > 0
              ? sequence.shift()
              : threads.get(resolvedThreadId) ?? {};
          responseDelay = readDelays[resolvedThreadId] ?? 0;
          result = {
            thread: {
              id: resolvedThreadId,
              name: override.name ?? title,
              status: { type: "active", activeFlags: [] },
              cwd: "/workspace/project",
              parentThreadId: null,
              createdAt: 10,
              updatedAt: 20,
              preview: "must never escape",
              turns: [{ id: "must-never-escape" }],
              ...override,
            },
          };
        } else if (message.method === "thread/name/set") {
          if (persistRename) title = message.params.name;
          result = {};
        } else if (message.method === "thread/turns/list") {
          const ordered = message.params.sortDirection === "asc"
            ? [...turns]
            : [...turns].reverse();
          const offset = message.params.cursor === undefined
            ? 0
            : Number.parseInt(message.params.cursor.slice("cursor:".length), 10);
          const limit = message.params.limit ?? 20;
          result = {
            data: ordered.slice(offset, offset + limit),
            nextCursor:
              offset + limit < ordered.length
                ? `cursor:${offset + limit}`
                : null,
          };
        } else if (message.method === "thread/resume") {
          const current = threads.get(message.params.threadId) ?? {};
          threads.set(message.params.threadId, {
            ...current,
            status: { type: "idle" },
          });
          result = {
            thread: {
              id: message.params.threadId,
              status: { type: "idle" },
            },
          };
        } else if (message.method === "turn/start") {
          turnOrdinal += 1;
          const turn = {
            id: `turn-${turnOrdinal}`,
            status: "inProgress",
            items: [{
              type: "userMessage",
              clientId: message.params.clientUserMessageId ?? null,
              content: message.params.input,
            }],
          };
          turns.push(turn);
          result = { turn };
        } else if (message.method === "turn/steer") {
          const turn = turns.find(({ id }) => id === message.params.expectedTurnId);
          if (!turn) {
            child.stdout.write(
              `${JSON.stringify({
                id: message.id,
                error: { message: "active turn not found" },
              })}\n`,
            );
            continue;
          }
          turn.items.push({
            type: "userMessage",
            clientId: message.params.clientUserMessageId ?? null,
            content: message.params.input,
          });
          result = { turnId: turn.id };
        } else if (message.method === "thread/archive") {
          result = {};
        } else {
          child.stdout.write(
            `${JSON.stringify({
              id: message.id,
              error: { message: `unexpected method ${message.method}` },
            })}\n`,
          );
          continue;
        }
        const response = `${JSON.stringify({ id: message.id, result })}\n`;
        const writeResponse = () => {
          child.stdout.write(response);
          if (message.method === "thread/read") activeReads -= 1;
        };
        if (responseDelay > 0) {
          setTimeout(writeResponse, responseDelay);
        } else {
          writeResponse();
        }
      }
    });
    return child;
  }

  return {
    spawnProcess,
    requests,
    spawnCount: () => spawnCount,
    maxConcurrentReads: () => maxConcurrentReads,
    setThread(threadId, value) {
      threads.set(threadId, value);
    },
    title: () => title,
  };
}

test("the bridge contract matches the checked-in generated-schema fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(
          "./fixtures/mcp-app-server-protocol-v0.144.x.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
  assert.deepStrictEqual(
    SUPPORTED_CODEX_APP_SERVER_VERSIONS,
    fixture.compatibleCodexVersions,
  );
  assert.deepStrictEqual(
    REQUIRED_CODEX_APP_SERVER_METHODS,
    Object.keys(fixture.methods),
  );
  assert.deepStrictEqual(
    REQUIRED_CODEX_APP_SERVER_INITIALIZE_FIELDS,
    fixture.initialize.requiredResponseFields,
  );
  assert.deepStrictEqual(fixture.methods["thread/read"].requiredParams, [
    "threadId",
  ]);
  assert.deepStrictEqual(
    fixture.methods["thread/name/set"].requiredParams,
    ["name", "threadId"],
  );
  assert.deepStrictEqual(fixture.methods["thread/resume"].requiredParams, [
    "threadId",
  ]);
  assert.deepStrictEqual(
    fixture.methods["thread/turns/list"].requiredParams,
    ["threadId"],
  );
  assert.deepStrictEqual(
    fixture.methods["thread/turns/list"].requiredResponseFields,
    [
      "data",
      "nextCursor",
      "data[].id",
      "data[].items[].clientId",
      "data[].status",
    ],
  );
  assert.deepStrictEqual(fixture.methods["turn/start"].requiredParams, [
    "input",
    "threadId",
  ]);
  assert.deepStrictEqual(
    fixture.methods["turn/start"].requiredResponseFields,
    ["turn.id"],
  );
  assert.deepStrictEqual(fixture.methods["turn/steer"].requiredParams, [
    "expectedTurnId",
    "input",
    "threadId",
  ]);
  assert.deepStrictEqual(
    fixture.methods["turn/steer"].requiredResponseFields,
    ["turnId"],
  );
  assert.deepStrictEqual(fixture.methods["thread/archive"].requiredParams, [
    "threadId",
  ]);
  assert.deepStrictEqual(
    SUPPORTED_CODEX_APP_SERVER_THREAD_STATUSES,
    fixture.threadStatus.types,
  );
  assert.deepStrictEqual(
    SUPPORTED_CODEX_APP_SERVER_ACTIVE_FLAGS,
    fixture.threadStatus.activeFlags,
  );
});

test("positive integer validation has a strict default and no undefined bound", () => {
  for (const requestTimeoutMs of [-1, 0, 1.5, Number.NaN]) {
    assert.throws(
      () => new CodexAppServerBridgeV1({ requestTimeoutMs }),
      (error) => {
        assert.equal(
          error.message,
          "app-server request timeout must be an integer of at least 1",
        );
        assert.equal(error.message.includes("undefined"), false);
        return true;
      },
    );
  }
  assert.doesNotThrow(
    () => new CodexAppServerBridgeV1({ requestTimeoutMs: 1 }),
  );
});

test("inspection lazily starts one app server and returns bounded metadata", async () => {
  const fake = fakeCodexAppServer();
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  assert.equal(fake.spawnCount(), 0);
  const inspection = await bridge.inspect({ threadId: "thread-1" });
  assert.equal(fake.spawnCount(), 1);
  assert.deepEqual(inspection, {
    schemaVersion: 1,
    threadId: "thread-1",
    title: "Release coordination",
    status: "active",
    activeFlags: [],
    cwd: "/workspace/project",
    parentThreadId: null,
    createdAt: 10,
    updatedAt: 20,
  });
  assert.equal(JSON.stringify(inspection).includes("must never escape"), false);
  assert.deepEqual(
    fake.requests.find(({ method }) => method === "thread/read")?.params,
    { threadId: "thread-1", includeTurns: false },
  );
  assert.deepEqual(await bridge.health(), {
    schemaVersion: 1,
    state: "ready",
    compatible: true,
    version: "0.144.6",
    platformFamily: "unix",
    platformOs: "macos",
    supportedVersions: ["0.144.5", "0.144.6"],
    requiredMethods: [
      "thread/read",
      "thread/name/set",
      "thread/resume",
      "thread/turns/list",
      "turn/start",
      "turn/steer",
      "thread/archive",
    ],
    connectionAttempts: 1,
    reconnects: 0,
    requestsSucceeded: 2,
    requestsFailed: 0,
    readRetries: 0,
    mutationAttempts: 0,
    batchRequests: 0,
    batchItemsRequested: 0,
    batchItemsSucceeded: 0,
    batchItemsFailed: 0,
    partialBatches: 0,
    topologyProjections: 0,
    waitRequests: 0,
    waitPolls: 0,
    waitEvents: 0,
    waitTimeouts: 0,
    lastFailure: null,
  });

  await bridge.close();
});

test("latest turn inspection returns the current native turn identity and status", async () => {
  const fake = fakeCodexAppServer({
    initialTurns: [
      { id: "older-turn", status: "completed", items: [] },
      { id: "current-turn", status: "interrupted", items: [] },
    ],
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  assert.deepEqual(await bridge.latestTurn({ threadId: "thread-1" }), {
    turnId: "current-turn",
    status: "interrupted",
  });
  assert.deepEqual(
    fake.requests.find(({ method }) => method === "thread/turns/list")?.params,
    {
      threadId: "thread-1",
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    },
  );
  await bridge.close();
});

test("public stable Codex 0.144.5 passes the reviewed schema gate", async () => {
  const fake = fakeCodexAppServer({ codexVersion: "0.144.5" });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
  });
  assert.equal(
    (await bridge.inspect({ threadId: "thread-1" })).threadId,
    "thread-1",
  );
  assert.equal((await bridge.health()).version, "0.144.5");
  await bridge.close();
});

test("the clean MCP environment identity passes the reviewed schema gate", async () => {
  const fake = fakeCodexAppServer({
    initializeOverrides: {
      userAgent: "nelos_mcp/0.144.6 (Mac OS; arm64) unknown (nelos_mcp; 1.0.0)",
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
  });
  assert.equal(
    (await bridge.inspect({ threadId: "thread-1" })).threadId,
    "thread-1",
  );
  assert.equal((await bridge.health()).version, "0.144.6");
  await bridge.close();
});

test("version and initialize gates reject unreviewed runtime identities", async () => {
  for (const codexVersion of [
    "0.144.5-rc.1",
    "0.144.6+nightly",
    "0.144.6.1",
  ]) {
    const fake = fakeCodexAppServer({ codexVersion });
    const bridge = new CodexAppServerBridgeV1({
      spawnProcess: fake.spawnProcess,
    });
    await assert.rejects(
      bridge.inspect({ threadId: "thread-1" }),
      /did not identify a versioned Codex runtime/,
    );
    assert.equal((await bridge.health()).state, "incompatible");
    await bridge.close();
  }

  const fake = fakeCodexAppServer({
    initializeOverrides: { codexHome: undefined },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
  });
  await assert.rejects(
    bridge.inspect({ threadId: "thread-1" }),
    /initialize response is incompatible/,
  );
  await bridge.close();
});

test("queen title synchronization is verified, idempotent, and connection-reusing", async () => {
  const fake = fakeCodexAppServer();
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  assert.deepEqual(
    await bridge.synchronizeQueenTitle({ threadId: "queen-1" }),
    {
      schemaVersion: 1,
      threadId: "queen-1",
      previousTitle: "Release coordination",
      title: "👑 · Release coordination",
      changed: true,
      verified: true,
    },
  );
  assert.equal(fake.title(), "👑 · Release coordination");

  const replay = await bridge.synchronizeQueenTitle({ threadId: "queen-1" });
  assert.equal(replay.changed, false);
  assert.equal(
    fake.requests.filter(({ method }) => method === "thread/name/set").length,
    1,
  );
  assert.equal(fake.spawnCount(), 1);

  await bridge.close();
});

test("queen title synchronization fails closed when the rename does not persist", async () => {
  const fake = fakeCodexAppServer({ persistRename: false });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  await assert.rejects(
    bridge.synchronizeQueenTitle({ threadId: "queen-1" }),
    /queen title verification failed/,
  );
  await bridge.close();
});

test("queen title synchronization detects a preflight title change", async () => {
  const fake = fakeCodexAppServer({
    readSequences: {
      "queen-1": [
        { name: "Original title" },
        { name: "Newer Desktop title" },
      ],
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  await assert.rejects(
    bridge.synchronizeQueenTitle({ threadId: "queen-1" }),
    /queen title changed during synchronization/,
  );
  assert.equal(
    fake.requests.filter(({ method }) => method === "thread/name/set").length,
    0,
  );
  await bridge.close();
});

test("queen title synchronization canonicalizes legacy web-marker ordering once", async () => {
  const legacyTitle = "👑 · 🕸️ A1 · Release coordination";
  const canonicalTitle = "🕸️ A1 👑 · Release coordination";
  const fake = fakeCodexAppServer({ initialTitle: legacyTitle });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  const synchronized = await bridge.synchronizeQueenTitle({
    threadId: "queen-1",
  });
  assert.equal(synchronized.previousTitle, legacyTitle);
  assert.equal(synchronized.title, canonicalTitle);
  assert.equal(synchronized.changed, true);
  assert.equal(fake.title(), canonicalTitle);

  const replay = await bridge.synchronizeQueenTitle({
    threadId: "queen-1",
  });
  assert.equal(replay.title, canonicalTitle);
  assert.equal(replay.changed, false);
  assert.equal(
    fake.requests.filter(({ method }) => method === "thread/name/set").length,
    1,
  );
  await bridge.close();
});

test("a timed-out read reconnects once and reports content-free telemetry", async () => {
  const fake = fakeCodexAppServer({ ignoreReadCount: 1 });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 25,
  });

  assert.equal(
    (await bridge.inspect({ threadId: "thread-1" })).title,
    "Release coordination",
  );
  assert.equal(fake.spawnCount(), 2);
  const health = await bridge.health();
  assert.equal(health.state, "ready");
  assert.equal(health.reconnects, 1);
  assert.equal(health.readRetries, 1);
  assert.equal(health.requestsFailed, 1);
  assert.deepEqual(health.lastFailure, {
    sequence: 1,
    code: "timeout",
    method: "thread/read",
  });
  await bridge.close();
});

test("a read fails after exactly one bounded reconnect", async () => {
  const fake = fakeCodexAppServer({ ignoreReadCount: 2 });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 25,
  });

  await assert.rejects(
    bridge.inspect({ threadId: "thread-1" }),
    /thread\/read timed out/,
  );
  assert.equal(fake.spawnCount(), 2);
  const health = await bridge.health();
  assert.equal(health.readRetries, 1);
  assert.equal(health.requestsFailed, 2);
  assert.equal(health.state, "unavailable");
  await bridge.close();
});

test("spawn failures are bounded, content-free, and retried once for reads", async () => {
  let spawnCount = 0;
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess() {
      spawnCount += 1;
      throw new Error("secret executable path must not escape");
    },
  });

  await assert.rejects(
    bridge.inspect({ threadId: "thread-1" }),
    (error) => {
      assert.equal(error.message, "Codex app-server initialization failed");
      assert.equal(error.message.includes("secret executable path"), false);
      return true;
    },
  );
  assert.equal(spawnCount, 2);
  const health = await bridge.health();
  assert.equal(health.state, "unavailable");
  assert.equal(health.connectionAttempts, 2);
  assert.equal(health.readRetries, 1);
  assert.deepEqual(health.lastFailure, {
    sequence: 2,
    code: "initialize-failed",
    method: null,
  });
  await bridge.close();
});

test("unsupported app-server versions fail closed with actionable health", async () => {
  const fake = fakeCodexAppServer({ codexVersion: "0.145.0" });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  await assert.rejects(
    bridge.inspect({ threadId: "thread-1" }),
    /unsupported Codex app-server version 0\.145\.0; supported: 0\.144\.5, 0\.144\.6/,
  );
  assert.deepEqual(await bridge.health({ probe: true }), {
    schemaVersion: 1,
    state: "incompatible",
    compatible: false,
    version: "0.145.0",
    platformFamily: null,
    platformOs: null,
    supportedVersions: ["0.144.5", "0.144.6"],
    requiredMethods: [
      "thread/read",
      "thread/name/set",
      "thread/resume",
      "thread/turns/list",
      "turn/start",
      "turn/steer",
      "thread/archive",
    ],
    connectionAttempts: 1,
    reconnects: 0,
    requestsSucceeded: 1,
    requestsFailed: 0,
    readRetries: 0,
    mutationAttempts: 0,
    batchRequests: 0,
    batchItemsRequested: 0,
    batchItemsSucceeded: 0,
    batchItemsFailed: 0,
    partialBatches: 0,
    topologyProjections: 0,
    waitRequests: 0,
    waitPolls: 0,
    waitEvents: 0,
    waitTimeouts: 0,
    lastFailure: {
      sequence: 1,
      code: "incompatible-version",
      method: null,
    },
  });
  assert.equal(fake.spawnCount(), 1);
  await bridge.close();
});

test("batch inspection preserves order, bounds failures, and projects direct topology", async () => {
  const fake = fakeCodexAppServer({
    readDelays: { queen: 15, child: 5 },
    readErrors: { missing: "secret server detail must not escape" },
    threadOverrides: {
      queen: {
        name: "Queen",
        status: { type: "idle" },
        parentThreadId: null,
      },
      child: {
        name: "Child",
        status: { type: "active", activeFlags: [] },
        parentThreadId: "queen",
      },
      external: {
        name: "External child",
        status: { type: "systemError" },
        parentThreadId: "outside",
      },
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  const inventory = await bridge.inspectMany({
    threadIds: ["queen", "child", "external", "missing"],
  });
  assert.deepEqual(
    inventory.items.map(({ threadId, state }) => ({ threadId, state })),
    [
      { threadId: "queen", state: "ready" },
      { threadId: "child", state: "ready" },
      { threadId: "external", state: "ready" },
      { threadId: "missing", state: "failed" },
    ],
  );
  assert.deepEqual(inventory.items[3].error, {
    code: "request-rejected",
    retriable: false,
  });
  assert.deepEqual(inventory.topology.edges, [
    { parentThreadId: "queen", childThreadId: "child" },
  ]);
  assert.deepEqual(inventory.topology.externalParents, [
    { threadId: "external", parentThreadId: "outside" },
  ]);
  assert.equal(JSON.stringify(inventory).includes("secret server detail"), false);
  assert.equal(JSON.stringify(inventory).includes("must never escape"), false);
  const health = await bridge.health();
  assert.equal(health.batchRequests, 1);
  assert.equal(health.batchItemsRequested, 4);
  assert.equal(health.batchItemsSucceeded, 3);
  assert.equal(health.batchItemsFailed, 1);
  assert.equal(health.partialBatches, 1);
  assert.equal(health.topologyProjections, 1);
  await bridge.close();
});

test("batch input rejects duplicates before starting the app server", async () => {
  const fake = fakeCodexAppServer();
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
  });

  await assert.rejects(
    bridge.inspectMany({ threadIds: ["same", "same"] }),
    /must not contain duplicate/,
  );
  assert.equal(fake.spawnCount(), 0);
  await bridge.close();
});

test("wait input bounds reject before starting the app server", async () => {
  const fake = fakeCodexAppServer();
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
  });
  const target = { threadId: "worker", afterCursor: null };
  const cases = [
    [
      { targets: [{ ...target, unexpected: true }] },
      /only threadId and afterCursor/,
    ],
    [
      {
        targets: Array.from(
          { length: 9 },
          (_, index) => ({ threadId: `worker-${index}` }),
        ),
      },
      /between 1 and 8 entries/,
    ],
    [
      { targets: [target, target] },
      /must not contain duplicate thread IDs/,
    ],
    [{ targets: [target], timeoutMs: -1 }, /between 0 and 30000/],
    [{ targets: [target], timeoutMs: 30_001 }, /between 0 and 30000/],
    [{ targets: [target], timeoutMs: 1.5 }, /between 0 and 30000/],
    [{ targets: [target], pollIntervalMs: 49 }, /between 50 and 5000/],
    [{ targets: [target], pollIntervalMs: 5_001 }, /between 50 and 5000/],
    [{ targets: [target], pollIntervalMs: 50.5 }, /between 50 and 5000/],
  ];

  for (const [args, pattern] of cases) {
    await assert.rejects(bridge.waitForThreads(args), pattern);
  }
  assert.equal(fake.spawnCount(), 0);
  await bridge.close();
});

test("batch inspection caps read concurrency at four across 16 tasks", async () => {
  const threadIds = Array.from({ length: 16 }, (_, index) => `thread-${index}`);
  const fake = fakeCodexAppServer({
    readDelays: Object.fromEntries(threadIds.map((id) => [id, 5])),
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  const inventory = await bridge.inspectMany({
    threadIds,
    includeTopology: false,
  });
  assert.deepEqual(
    inventory.items.map((item) => item.threadId),
    threadIds,
  );
  assert.equal(fake.maxConcurrentReads(), 4);
  assert.equal("topology" in inventory, false);
  assert.equal((await bridge.health()).topologyProjections, 0);
  await bridge.close();
});

test("snapshot wait suppresses unchanged state and wakes on a bounded change", async () => {
  const fake = fakeCodexAppServer({
    threadOverrides: {
      worker: {
        name: "Worker",
        status: { type: "idle" },
        updatedAt: 20,
      },
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });

  const initial = await bridge.waitForThreads({
    targets: [{ threadId: "worker", afterCursor: null }],
  });
  assert.equal(initial.status, "event");
  const cursor = initial.snapshots[0].cursor;
  assert.match(cursor, /^snapshot-v1:[A-Za-z0-9_-]{43}$/u);

  const unchanged = await bridge.waitForThreads({
    targets: [{ threadId: "worker", afterCursor: cursor }],
    timeoutMs: 0,
  });
  assert.equal(unchanged.status, "timeout");
  assert.equal(unchanged.snapshots[0].changed, false);

  setTimeout(() => {
    fake.setThread("worker", {
      name: "Worker",
      status: {
        type: "active",
        activeFlags: ["waitingOnUserInput"],
      },
      updatedAt: 21,
    });
  }, 10);
  const changed = await bridge.waitForThreads({
    targets: [{ threadId: "worker", afterCursor: cursor }],
    timeoutMs: 200,
    pollIntervalMs: 50,
  });
  assert.equal(changed.status, "event");
  assert.equal(changed.snapshots[0].changed, true);
  assert.equal(changed.snapshots[0].attentionRequired, true);
  assert.deepEqual(changed.snapshots[0].thread.activeFlags, [
    "waitingOnUserInput",
  ]);
  const health = await bridge.health();
  assert.equal(health.waitRequests, 3);
  assert.equal(health.waitEvents, 2);
  assert.equal(health.waitTimeouts, 1);
  assert.ok(health.waitPolls >= 4);
  await bridge.close();
});

test("snapshot wait enforces a hard deadline on slow reads", async () => {
  const fake = fakeCodexAppServer({
    readDelays: { worker: 100 },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
    waitInitialInspectionAllowanceMs: 30,
  });
  const startedAt = Date.now();

  const wait = await bridge.waitForThreads({
    targets: [{ threadId: "worker", afterCursor: "snapshot-v1:prior" }],
    timeoutMs: 20,
    pollIntervalMs: 50,
  });
  assert.equal(wait.status, "timeout");
  assert.equal(wait.snapshots[0].state, "failed");
  assert.equal(wait.snapshots[0].error.code, "timeout");
  assert.ok(Date.now() - startedAt < 100);
  assert.equal((await bridge.health()).readRetries, 0);
  await bridge.close();
});

test("queen title synchronization applies one deadline to its verification read", async () => {
  const fake = fakeCodexAppServer({ ignoredReadOrdinals: [3] });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  const startedAt = Date.now();

  await assert.rejects(
    bridge.synchronizeQueenTitle({
      threadId: "queen-1",
      deadlineAt: Date.now() + 30,
    }),
    /thread\/read timed out/,
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(
    fake.requests.filter(({ method }) => method === "thread/read").length,
    3,
  );
  assert.equal(
    fake.requests.filter(({ method }) => method === "thread/name/set").length,
    1,
  );
  assert.equal((await bridge.health()).readRetries, 0);
  await bridge.close();
});

test("close rejects an in-flight wait and resets health to idle", async () => {
  const fake = fakeCodexAppServer({
    readDelays: { worker: 100 },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  const pending = bridge.waitForThreads({
    targets: [{ threadId: "worker" }],
    timeoutMs: 500,
  });
  while (!fake.requests.some(({ method }) => method === "thread/read")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  await bridge.close();
  await assert.rejects(pending, (error) => {
    assert.equal(error.bridgeCode, "bridge-closed");
    assert.match(error.message, /bridge closed/);
    return true;
  });
  const health = await bridge.health();
  assert.equal(health.state, "idle");
  assert.equal(health.compatible, false);
  assert.equal(health.version, "0.144.6");
  assert.equal(health.platformFamily, "unix");
  assert.equal(health.platformOs, "macos");
  assert.equal((await bridge.health({ probe: true })).state, "idle");
  assert.equal(fake.spawnCount(), 1);
  await assert.rejects(
    bridge.inspect({ threadId: "worker" }),
    /bridge is closed/,
  );
});

test("an uncertain title mutation respects its deadline and is never replayed", async () => {
  const fake = fakeCodexAppServer({ ignoreNameSetCount: 1 });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  const startedAt = Date.now();

  await assert.rejects(
    bridge.synchronizeQueenTitle({
      threadId: "queen-1",
      deadlineAt: Date.now() + 30,
    }),
    /thread\/name\/set timed out/,
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(
    fake.requests.filter(({ method }) => method === "thread/name/set").length,
    1,
  );
  assert.equal(fake.spawnCount(), 1);
  const health = await bridge.health();
  assert.equal(health.mutationAttempts, 1);
  assert.equal(health.readRetries, 0);
  assert.equal(health.state, "unavailable");
  await bridge.close();
});

test("parent wake delivery starts one queen turn and reconciles replay", async () => {
  const fake = fakeCodexAppServer({
    threadOverrides: {
      queen: { status: { type: "idle" } },
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  const first = await bridge.deliverParentWake({
    queenThreadId: "queen",
    clientUserMessageId: "wake-1",
    message: "Member A completed.\nResume the persisted join.",
  });
  assert.deepEqual(first, {
    delivered: true,
    replayed: false,
    deferred: false,
    reason: null,
    queenTurnId: "turn-1",
    deliveryMode: "start",
  });
  const second = await bridge.deliverParentWake({
    queenThreadId: "queen",
    clientUserMessageId: "wake-1",
    message: "Member A completed.\nResume the persisted join.",
  });
  assert.deepEqual(second, {
    delivered: true,
    replayed: true,
    deferred: false,
    reason: null,
    queenTurnId: "turn-1",
    deliveryMode: "replay",
  });
  assert.equal(
    fake.requests.filter(({ method }) => method === "turn/start").length,
    1,
  );
  await bridge.close();
});

test("parent wake resumes an unloaded queen before starting one turn", async () => {
  const fake = fakeCodexAppServer({
    threadOverrides: {
      queen: { status: { type: "notLoaded" } },
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  const result = await bridge.deliverParentWake({
    queenThreadId: "queen",
    clientUserMessageId: "wake-resume",
    message: "Member A completed.",
  });
  assert.equal(result.deliveryMode, "start");
  assert.deepEqual(
    fake.requests
      .filter(({ method }) =>
        ["thread/resume", "turn/start"].includes(method),
      )
      .map(({ method }) => method),
    ["thread/resume", "turn/start"],
  );
  await bridge.close();
});

test("a post-resume read failure is not classified as an uncertain wake mutation", async () => {
  const fake = fakeCodexAppServer({
    readSequences: {
      queen: [
        { status: { type: "notLoaded" } },
        { id: "unexpected-thread", status: { type: "idle" } },
      ],
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  await assert.rejects(
    bridge.deliverParentWake({
      queenThreadId: "queen",
      clientUserMessageId: "wake-resume-read-failure",
      message: "Member A completed.",
    }),
    (error) => {
      assert.equal(error.bridgeCode, "invalid-response");
      assert.notEqual(error.mutationUncertain, true);
      return true;
    },
  );
  assert.equal(
    fake.requests.some(({ method }) => method === "thread/resume"),
    true,
  );
  assert.equal(
    fake.requests.some(({ method }) => method === "turn/start"),
    false,
  );
  await bridge.close();
});

test("parent wake stops when bounded reconciliation is truncated", async () => {
  const initialTurns = Array.from({ length: 21 }, (_, index) => ({
    id: `old-turn-${index}`,
    status: "completed",
    items: [],
  }));
  const fake = fakeCodexAppServer({
    initialTurns,
    threadOverrides: {
      queen: { status: { type: "idle" } },
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  await assert.rejects(
    bridge.deliverParentWake({
      queenThreadId: "queen",
      clientUserMessageId: "wake-older-than-window",
      message: "Member A completed.",
      reconciliationRequired: true,
    }),
    (error) => {
      assert.equal(error.bridgeCode, "wake-history-truncated");
      assert.equal(error.mutationUncertain, true);
      return true;
    },
  );
  assert.equal(
    fake.requests.some(({ method }) =>
      ["turn/start", "turn/steer"].includes(method),
    ),
    false,
  );
  await bridge.close();
});

test("a fresh wake can proceed despite older turn pages", async () => {
  const initialTurns = Array.from({ length: 21 }, (_, index) => ({
    id: `old-turn-${index}`,
    status: "completed",
    items: [],
  }));
  const fake = fakeCodexAppServer({
    initialTurns,
    threadOverrides: {
      queen: { status: { type: "idle" } },
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  const result = await bridge.deliverParentWake({
    queenThreadId: "queen",
    clientUserMessageId: "fresh-wake",
    message: "Member A completed.",
    reconciliationRequired: false,
  });
  assert.equal(result.deliveryMode, "start");
  assert.equal(
    fake.requests.filter(({ method }) => method === "turn/start").length,
    1,
  );
  await bridge.close();
});

test("rejected wake mutations are certainly unapplied", async () => {
  const fake = fakeCodexAppServer({
    rejectedMethods: ["turn/start"],
    threadOverrides: {
      queen: { status: { type: "idle" } },
    },
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  await assert.rejects(
    bridge.deliverParentWake({
      queenThreadId: "queen",
      clientUserMessageId: "wake-rejected",
      message: "Member A completed.",
    }),
    (error) => {
      assert.equal(error.bridgeCode, "request-rejected");
      assert.equal(error.mutationUncertain, false);
      return true;
    },
  );
  await bridge.close();
});

test("timed-out wake and archive mutations remain uncertain", async () => {
  const wakeFake = fakeCodexAppServer({
    ignoredMethods: ["turn/start"],
    threadOverrides: {
      queen: { status: { type: "idle" } },
    },
  });
  const wakeBridge = new CodexAppServerBridgeV1({
    spawnProcess: wakeFake.spawnProcess,
    requestTimeoutMs: 20,
  });
  await assert.rejects(
    wakeBridge.deliverParentWake({
      queenThreadId: "queen",
      clientUserMessageId: "wake-timeout",
      message: "Member A completed.",
    }),
    (error) => {
      assert.equal(error.bridgeCode, "timeout");
      assert.equal(error.mutationUncertain, true);
      return true;
    },
  );
  await wakeBridge.close();

  const timedOutArchiveFake = fakeCodexAppServer({
    ignoredMethods: ["thread/archive"],
  });
  const timedOutArchiveBridge = new CodexAppServerBridgeV1({
    spawnProcess: timedOutArchiveFake.spawnProcess,
    requestTimeoutMs: 20,
  });
  await assert.rejects(
    timedOutArchiveBridge.archiveThread({ threadId: "member-thread" }),
    (error) => {
      assert.equal(error.bridgeCode, "timeout");
      assert.equal(error.mutationUncertain, true);
      return true;
    },
  );
  await timedOutArchiveBridge.close();
});

test("archiveThread performs one exact native archive", async () => {
  const archiveFake = fakeCodexAppServer();
  const archiveBridge = new CodexAppServerBridgeV1({
    spawnProcess: archiveFake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  assert.deepEqual(
    await archiveBridge.archiveThread({ threadId: "member-thread" }),
    { archived: true, threadId: "member-thread" },
  );
  assert.equal(
    archiveFake.requests.filter(({ method }) => method === "thread/archive").length,
    1,
  );
  await archiveBridge.close();
});

test("parent wake defers instead of starting a concurrent queen turn", async () => {
  const fake = fakeCodexAppServer();
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  const result = await bridge.deliverParentWake({
    queenThreadId: "queen",
    clientUserMessageId: "wake-1",
    message: "Member A completed.",
  });
  assert.deepEqual(result, {
    delivered: false,
    replayed: false,
    deferred: true,
    reason: "queen-active-turn-unknown",
    queenTurnId: null,
  });
  assert.equal(
    fake.requests.some(({ method }) => method === "turn/start"),
    false,
  );
  await bridge.close();
});

test("parent wake steers the known active queen turn", async () => {
  const fake = fakeCodexAppServer({
    initialTurns: [{
      id: "queen-active-turn",
      status: "inProgress",
      items: [],
    }],
  });
  const bridge = new CodexAppServerBridgeV1({
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1_000,
  });
  const result = await bridge.deliverParentWake({
    queenThreadId: "queen",
    clientUserMessageId: "wake-active",
    message: "Member A completed.",
  });
  assert.deepEqual(result, {
    delivered: true,
    replayed: false,
    deferred: false,
    reason: null,
    queenTurnId: "queen-active-turn",
    deliveryMode: "steer",
  });
  assert.equal(
    fake.requests.filter(({ method }) => method === "turn/steer").length,
    1,
  );
  assert.equal(
    fake.requests.some(({ method }) => method === "turn/start"),
    false,
  );
  await bridge.close();
});
