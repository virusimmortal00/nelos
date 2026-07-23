#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openAppServerClient,
  parsePositiveInteger,
  resolveSocketPath,
} from "../src/app-server-client.mjs";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const READINESS_POLL_MS = 100;
const READINESS_STABILITY_MS = 200;
const PROCESS_EXIT_POLL_MS = 25;

function usage() {
  return `Usage: node scripts/dev-app-server.mjs [options]

Start a foreground standalone Codex app server on a Unix socket.

Options:
  --socket PATH                 Absolute Unix socket path
  --codex PATH                  Codex executable or command (default: codex)
  --startup-timeout-ms N        Readiness timeout (default: 15000)
  --shutdown-timeout-ms N       Graceful shutdown timeout (default: 5000)
  -h, --help                    Show this help
`;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseDevAppServerArgs(argv) {
  const options = {
    codexCommand: "codex",
    help: false,
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    socketPath: null,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["-h", "--help"].includes(argument)) {
      options.help = true;
      continue;
    }
    if (argument === "--socket") {
      const socketPath = takeValue(argv, index, argument);
      if (!isAbsolute(socketPath)) {
        throw new Error("--socket must be an absolute path");
      }
      options.socketPath = socketPath;
      index += 1;
      continue;
    }
    if (argument === "--codex") {
      options.codexCommand = takeValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--startup-timeout-ms") {
      options.startupTimeoutMs = parsePositiveInteger(
        takeValue(argv, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    if (argument === "--shutdown-timeout-ms") {
      options.shutdownTimeoutMs = parsePositiveInteger(
        takeValue(argv, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  if (!options.help) {
    options.socketPath = resolveSocketPath(options.socketPath);
  }
  return options;
}

export function unixListenUrl(socketPath) {
  if (!isAbsolute(socketPath)) {
    throw new Error("app-server socket path must be absolute");
  }
  return `unix://${socketPath}`;
}

export function sameSocketIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.isSocket() &&
      right.isSocket() &&
      left.dev === right.dev &&
      left.ino === right.ino,
  );
}

export function quoteShellArgument(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function readSocketInfo(socketPath) {
  try {
    return await lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function probeAppServer(socketPath, timeoutMs = 1_000) {
  let client;
  try {
    client = await openAppServerClient({
      clientName: "nelos-dev-launcher",
      clientTitle: "Nelos Dev Launcher",
      socketPath,
      timeoutMs,
    });
    return { ready: true, error: null };
  } catch (error) {
    return { ready: false, error };
  } finally {
    client?.close();
  }
}

function childHasExited(child) {
  return (
    child.pid === undefined || child.exitCode !== null || child.signalCode !== null
  );
}

export function waitForChildResult(child) {
  const currentResult = () =>
    childHasExited(child) ? [child.exitCode, child.signalCode] : null;
  const current = currentResult();
  if (current) return Promise.resolve(current);

  return new Promise((resolvePromise) => {
    const handleExit = (code, signal) => resolvePromise([code, signal]);
    child.once("exit", handleExit);
    const afterListener = currentResult();
    if (afterListener) {
      child.removeListener("exit", handleExit);
      resolvePromise(afterListener);
    }
  });
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", handleExit);
      resolvePromise(exited);
    };
    const handleExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", handleExit);
    if (childHasExited(child)) finish(true);
  });
}

function processGroupIsRunning(pid) {
  if (!pid || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsRunning(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(PROCESS_EXIT_POLL_MS, remaining));
  }
  return true;
}

function signalChild(child, signal, processGroup = false) {
  if (!child.pid) return false;
  try {
    if (processGroup && process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return true;
    }
    if (childHasExited(child)) return false;
    return child.kill(signal);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function stopChild(
  child,
  {
    processGroup = false,
    signal = "SIGTERM",
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = {},
) {
  if (!child?.pid) return;
  if (processGroup && process.platform !== "win32") {
    if (!processGroupIsRunning(child.pid)) return;
    signalChild(child, signal, true);
    if (await waitForProcessGroupExit(child.pid, timeoutMs)) return;
    signalChild(child, "SIGKILL", true);
    if (!(await waitForProcessGroupExit(child.pid, timeoutMs))) {
      throw new Error(
        `app-server process group ${child.pid} did not exit after SIGKILL`,
      );
    }
    return;
  }

  if (childHasExited(child)) return;
  signalChild(child, signal, processGroup);
  if (await waitForChildExit(child, timeoutMs)) return;
  signalChild(child, "SIGKILL", processGroup);
  if (!(await waitForChildExit(child, timeoutMs))) {
    throw new Error(`app-server process ${child.pid} did not exit after SIGKILL`);
  }
}

async function removeOwnedSocket(socketPath, identity) {
  if (!identity) return false;
  const current = await readSocketInfo(socketPath);
  if (!sameSocketIdentity(current, identity)) return false;
  await unlink(socketPath);
  return true;
}

async function prepareSocketDirectory(socketPath) {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory()) {
    throw new Error(`app-server socket parent is not a directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`app-server socket parent is not owned by this user: ${directory}`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(
      `app-server socket parent must not be group- or world-writable: ${directory}`,
    );
  }
}

function assertSocketOwnedByCurrentUser(info, socketPath) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`app-server socket is not owned by this user: ${socketPath}`);
  }
}

export async function startStandaloneAppServer({
  codexCommand = "codex",
  detached = false,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  signal = null,
  socketPath = resolveSocketPath(),
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  stdio = "inherit",
} = {}) {
  if (!isAbsolute(socketPath)) {
    throw new Error("app-server socket path must be absolute");
  }

  if (signal?.aborted) throw new Error("app-server startup was interrupted");
  await prepareSocketDirectory(socketPath);
  if (signal?.aborted) throw new Error("app-server startup was interrupted");

  const existing = await readSocketInfo(socketPath);
  if (existing) {
    if (!existing.isSocket()) {
      throw new Error(`app-server path exists and is not a Unix socket: ${socketPath}`);
    }
    assertSocketOwnedByCurrentUser(existing, socketPath);
    const probe = await probeAppServer(socketPath);
    if (probe.ready) {
      return {
        child: null,
        owned: false,
        reused: true,
        socketPath,
        stop: async () => {},
      };
    }
    throw new Error(
      `app-server socket exists but is unreachable; inspect it before removal: ${socketPath} (${probe.error.message})`,
    );
  }

  const child = spawn(
    codexCommand,
    ["app-server", "--listen", unixListenUrl(socketPath)],
    {
      detached,
      stdio,
    },
  );
  const stopOnParentExit = () => {
    signalChild(child, "SIGTERM", detached);
  };
  process.once("exit", stopOnParentExit);
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + startupTimeoutMs;
  let lastProbeError = null;
  let spawnedSocketIdentity = null;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("app-server startup was interrupted");
      if (spawnError) throw spawnError;
      if (childHasExited(child)) {
        throw new Error(
          `codex app-server exited before readiness (code=${child.exitCode}, signal=${child.signalCode})`,
        );
      }
      const socketInfo = await readSocketInfo(socketPath);
      if (socketInfo?.isSocket()) {
        assertSocketOwnedByCurrentUser(socketInfo, socketPath);
        spawnedSocketIdentity ??= socketInfo;
        const probe = await probeAppServer(
          socketPath,
          Math.min(1_000, startupTimeoutMs),
        );
        if (probe.ready) {
          const identity = await readSocketInfo(socketPath);
          if (!sameSocketIdentity(socketInfo, identity)) {
            lastProbeError = new Error("app-server socket changed during readiness");
            continue;
          }
          if (await waitForChildExit(child, READINESS_STABILITY_MS)) {
            throw new Error(
              `codex app-server exited during readiness (code=${child.exitCode}, signal=${child.signalCode})`,
            );
          }
          return {
            child,
            owned: true,
            reused: false,
            socketIdentity: identity,
            socketPath,
            async stop({ signal = "SIGTERM" } = {}) {
              await stopChild(child, {
                processGroup: detached,
                signal,
                timeoutMs: shutdownTimeoutMs,
              });
              process.removeListener("exit", stopOnParentExit);
              await removeOwnedSocket(socketPath, identity).catch(() => false);
            },
          };
        }
        lastProbeError = probe.error;
      }
      await sleep(READINESS_POLL_MS);
    }
    const detail = lastProbeError ? `: ${lastProbeError.message}` : "";
    throw new Error(`app-server did not become ready within ${startupTimeoutMs} ms${detail}`);
  } catch (error) {
    let stopError = null;
    await stopChild(child, {
      processGroup: detached,
      timeoutMs: shutdownTimeoutMs,
    }).catch((caught) => {
      stopError = caught;
    });
    if (!stopError) {
      process.removeListener("exit", stopOnParentExit);
      await removeOwnedSocket(socketPath, spawnedSocketIdentity).catch((caught) => {
        stopError = caught;
      });
    }
    if (stopError) {
      const aggregate = new AggregateError(
        [error, stopError],
        `app-server startup failed and process cleanup did not complete: ${error.message}`,
      );
      aggregate.cleanupIncomplete = true;
      throw aggregate;
    }
    throw error;
  }
}

export async function runDevAppServer(argv = process.argv.slice(2)) {
  const options = parseDevAppServerArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const server = await startStandaloneAppServer(options);
  if (server.reused) {
    process.stdout.write(`Codex app-server is already ready at ${server.socketPath}\n`);
    return;
  }

  process.stdout.write(
    [
      `Codex app-server ready at ${server.socketPath}`,
      `Connect the Codex TUI with: codex --remote ${quoteShellArgument(unixListenUrl(server.socketPath))}`,
      "Press Ctrl-C to stop the development server.",
      "",
    ].join("\n"),
  );

  let stopping = false;
  let stopPromise = null;
  const requestStop = (signal) => {
    if (stopping) return;
    stopping = true;
    stopPromise = server.stop({ signal }).catch((error) => {
      process.stderr.write(`Failed to stop app-server: ${error.message}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => requestStop("SIGINT"));
  process.once("SIGTERM", () => requestStop("SIGTERM"));

  const [code, signal] = await waitForChildResult(server.child);
  if (stopPromise) {
    await stopPromise;
  } else {
    // The child may remove its socket itself. If it does not, this only unlinks
    // the exact device/inode that this launcher observed at readiness.
    await server.stop();
  }
  if (!stopping && (code !== 0 || signal)) {
    throw new Error(`codex app-server exited unexpectedly (code=${code}, signal=${signal})`);
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDevAppServer().catch((error) => {
    process.stderr.write(`dev-app-server: ${error.message}\n`);
    process.exitCode = 1;
  });
}
