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
  ignoredReadOrdinals = [],
  initializeOverrides = {},
  initialTitle = "Release coordination",
  persistRename = true,
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
  const requests = [];
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
  assert.deepEqual(
    SUPPORTED_CODEX_APP_SERVER_VERSIONS,
    fixture.compatibleCodexVersions,
  );
  assert.deepEqual(
    REQUIRED_CODEX_APP_SERVER_METHODS,
    Object.keys(fixture.methods),
  );
  assert.deepEqual(
    REQUIRED_CODEX_APP_SERVER_INITIALIZE_FIELDS,
    fixture.initialize.requiredResponseFields,
  );
  assert.deepEqual(fixture.methods["thread/read"].requiredParams, ["threadId"]);
  assert.deepEqual(
    fixture.methods["thread/name/set"].requiredParams,
    ["name", "threadId"],
  );
  assert.deepEqual(
    SUPPORTED_CODEX_APP_SERVER_THREAD_STATUSES,
    fixture.threadStatus.types,
  );
  assert.deepEqual(
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
    requiredMethods: ["thread/read", "thread/name/set"],
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
    requiredMethods: ["thread/read", "thread/name/set"],
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
