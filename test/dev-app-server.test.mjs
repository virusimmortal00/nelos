import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  parseDevAppServerArgs,
  probeAppServer,
  quoteShellArgument,
  sameSocketIdentity,
  startStandaloneAppServer,
  stopChild,
  unixListenUrl,
  waitForChildResult,
} from "../scripts/dev-app-server.mjs";
import { parseVerifierArgs } from "../scripts/verify-app-server.mjs";
import { startMockAppServer } from "./support/mock-app-server.mjs";

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

test("dev app-server arguments preserve explicit paths and timeouts", () => {
  assert.deepEqual(
    parseDevAppServerArgs([
      "--socket",
      "/tmp/nelos dev.sock",
      "--codex",
      "/usr/local/bin/codex",
      "--startup-timeout-ms",
      "2500",
      "--shutdown-timeout-ms",
      "900",
    ]),
    {
      codexCommand: "/usr/local/bin/codex",
      help: false,
      shutdownTimeoutMs: 900,
      socketPath: "/tmp/nelos dev.sock",
      startupTimeoutMs: 2500,
    },
  );
});

test("an explicit launcher socket wins before host endpoint parsing", () => {
  const previous = process.env.CODEX_APP_SERVER_CONTROL_ENDPOINT;
  process.env.CODEX_APP_SERVER_CONTROL_ENDPOINT = "{malformed-host-endpoint";
  try {
    assert.equal(
      parseDevAppServerArgs(["--socket", "/tmp/explicit.sock"]).socketPath,
      "/tmp/explicit.sock",
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_APP_SERVER_CONTROL_ENDPOINT;
    else process.env.CODEX_APP_SERVER_CONTROL_ENDPOINT = previous;
  }
});

test("dev app-server arguments reject unsafe or malformed input", () => {
  assert.throws(
    () => parseDevAppServerArgs(["--socket", "relative.sock"]),
    /--socket must be an absolute path/,
  );
  assert.throws(
    () => parseDevAppServerArgs(["--startup-timeout-ms", "0"]),
    /positive integer/,
  );
  assert.throws(() => parseDevAppServerArgs(["--unknown"]), /unknown option/);
});

test("Unix listen URLs preserve an absolute socket path verbatim", () => {
  assert.equal(
    unixListenUrl("/tmp/path with spaces/app.sock"),
    "unix:///tmp/path with spaces/app.sock",
  );
  assert.throws(() => unixListenUrl("relative.sock"), /must be absolute/);
  assert.equal(
    quoteShellArgument("unix:///tmp/path with spaces/app.sock"),
    "'unix:///tmp/path with spaces/app.sock'",
  );
  assert.equal(
    quoteShellArgument("unix:///tmp/queen's.sock"),
    "'unix:///tmp/queen'\\''s.sock'",
  );
});

test("child result waits are safe after the exit event has already fired", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(17)"], {
    stdio: "ignore",
  });
  await new Promise((resolvePromise) => child.once("close", resolvePromise));
  assert.deepEqual(await waitForChildResult(child), [17, null]);
});

test("bounded shutdown escalates when a child ignores SIGTERM", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((resolvePromise) => child.stdout.once("data", resolvePromise));
  await stopChild(child, { timeoutMs: 50 });
  assert.equal(child.signalCode, "SIGKILL");
});

test(
  "process-group shutdown kills descendants after the leader exits",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-app-server-process-group-"));
    const grandchildPath = join(root, "grandchild.cjs");
    const leaderPath = join(root, "leader.cjs");
    let groupId = null;
    let grandchildPid = null;
    try {
      await writeFile(
        grandchildPath,
        "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);\n",
      );
      await writeFile(
        leaderPath,
        `const { spawn } = require("node:child_process");\nconst child = spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { stdio: ["ignore", "pipe", "ignore"] });\nchild.stdout.once("data", () => process.stdout.write(String(child.pid) + "\\n"));\nsetInterval(() => {}, 1000);\n`,
      );
      const child = spawn(process.execPath, [leaderPath], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      groupId = child.pid;
      const pidChunk = await new Promise((resolvePromise) =>
        child.stdout.once("data", resolvePromise),
      );
      grandchildPid = Number(pidChunk.toString("utf8").trim());
      assert.equal(processIsRunning(child.pid), true);
      assert.equal(processIsRunning(grandchildPid), true);

      await stopChild(child, { processGroup: true, timeoutMs: 250 });

      assert.equal(child.signalCode, "SIGTERM");
      assert.equal(processIsRunning(grandchildPid), false);
    } finally {
      if (groupId) {
        try {
          process.kill(-groupId, "SIGKILL");
        } catch {}
      }
      if (grandchildPid && processIsRunning(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("the launcher reuses a reachable socket without claiming ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "dev-app-server-reuse-"));
  const socketPath = join(root, "app.sock");
  const mock = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const firstIdentity = await lstat(socketPath);
    assert.deepEqual(await probeAppServer(socketPath), { ready: true, error: null });
    const result = await startStandaloneAppServer({ socketPath });
    assert.equal(result.owned, false);
    assert.equal(result.reused, true);
    assert.equal(result.child, null);
    await result.stop();
    const secondIdentity = await lstat(socketPath);
    assert.equal(sameSocketIdentity(firstIdentity, secondIdentity), true);
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the launcher refuses to overwrite a non-socket path", async () => {
  const root = await mkdtemp(join(tmpdir(), "dev-app-server-file-"));
  const socketPath = join(root, "app.sock");
  try {
    await writeFile(socketPath, "not a socket\n");
    await assert.rejects(
      startStandaloneAppServer({ socketPath }),
      /exists and is not a Unix socket/,
    );
    assert.equal(await lstat(socketPath).then((info) => info.isFile()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the launcher rejects a socket directly under a writable temp parent", async () => {
  const unsafeParent = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  const socketPath = join(
    unsafeParent,
    `nelos-insecure-parent-${randomUUID()}.sock`,
  );
  const mock = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    throw new Error(`unexpected method: ${method}`);
  });
  try {
    await assert.rejects(
      startStandaloneAppServer({ socketPath }),
      /parent (?:is not owned by this user|must not be group- or world-writable)/,
    );
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
    await unlink(socketPath).catch(() => {});
  }
});

test("the launcher owns and stops a ready child without leaving its socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "dev-app-server-owned-"));
  const socketPath = join(root, "app.sock");
  const wrapperPath = join(root, "fake-codex");
  const fixturePath = fileURLToPath(
    new URL("../scripts/test-support/fake-codex-command.mjs", import.meta.url),
  );
  let server = null;
  try {
    await writeFile(
      wrapperPath,
      `#!/bin/sh\nexec ${quoteShellArgument(process.execPath)} ${quoteShellArgument(fixturePath)} "$@"\n`,
      { mode: 0o700 },
    );
    server = await startStandaloneAppServer({
      codexCommand: wrapperPath,
      shutdownTimeoutMs: 1_000,
      socketPath,
      startupTimeoutMs: 2_000,
      stdio: "ignore",
    });
    assert.equal(server.owned, true);
    assert.equal(server.reused, false);
    assert.ok(server.child.pid);
    await server.stop();
    server = null;
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  } finally {
    await server?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("failed startup kills the child before removing its exact socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "dev-app-server-failed-startup-"));
  const socketPath = join(root, "app.sock");
  const pidPath = join(root, "child.pid");
  const fixturePath = join(root, "stubborn-codex.mjs");
  let childPid = null;
  try {
    await writeFile(
      fixturePath,
      `#!/usr/bin/env node\nimport net from "node:net";\nimport { writeFileSync } from "node:fs";\nconst listenIndex = process.argv.indexOf("--listen");\nconst socketPath = process.argv[listenIndex + 1].slice("unix://".length);\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on("SIGTERM", () => {});\nconst server = net.createServer((socket) => socket.on("error", () => {}));\nserver.listen(socketPath);\n`,
      { mode: 0o700 },
    );

    await assert.rejects(
      startStandaloneAppServer({
        codexCommand: fixturePath,
        shutdownTimeoutMs: 75,
        socketPath,
        startupTimeoutMs: 1_000,
        stdio: "ignore",
      }),
      /did not become ready within 1000 ms/,
    );

    childPid = Number(await readFile(pidPath, "utf8"));
    assert.equal(processIsRunning(childPid), false);
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  } finally {
    if (childPid && processIsRunning(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await unlink(socketPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("the launcher preserves an unreachable socket it did not create", async () => {
  const root = await mkdtemp(join(tmpdir(), "dev-app-server-unreachable-"));
  const socketPath = join(root, "app.sock");
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const net=require('net');const s=net.createServer();s.listen(process.argv[1],()=>process.stdout.write('ready\\n'))",
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await new Promise((resolvePromise) => child.stdout.once("data", resolvePromise));
    child.kill("SIGKILL");
    await waitForChildResult(child);
    const identity = await lstat(socketPath);
    await assert.rejects(
      startStandaloneAppServer({ socketPath }),
      /socket exists but is unreachable/,
    );
    assert.equal(sameSocketIdentity(identity, await lstat(socketPath)), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await unlink(socketPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("live-only verifier profile options require explicit live mode", () => {
  assert.throws(
    () => parseVerifierArgs(["--model", "model-id"]),
    /require --live/,
  );
  assert.deepEqual(parseVerifierArgs(["--live", "--effort", "low"]), {
    codexCommand: "codex",
    effort: "low",
    help: false,
    live: true,
    model: null,
    startupTimeoutMs: 15_000,
    turnWaitMs: 300_000,
  });
});
