#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  openAppServerClient,
  parsePositiveInteger,
} from "../src/app-server-client.mjs";
import { startStandaloneAppServer } from "./dev-app-server.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = fileURLToPath(new URL("../bin/nelos", import.meta.url));
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_WAIT_MS = 300_000;

function usage() {
  return `Usage: node scripts/verify-app-server.mjs [options]

Verify Nelos against a disposable standalone Codex app server.
The default mode performs no model calls. --live creates two model turns and
archives the uniquely named smoke task before shutdown.

Options:
  --live                         Run start/read/send/archive lifecycle smoke
  --codex PATH                   Codex executable or command (default: codex)
  --model MODEL                  Optional live-mode model override
  --effort LEVEL                 Optional live-mode reasoning override
  --startup-timeout-ms N         App-server readiness timeout (default: 15000)
  --turn-wait-ms N               Live turn timeout (default: 300000)
  -h, --help                     Show this help
`;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseVerifierArgs(argv) {
  const options = {
    codexCommand: "codex",
    effort: null,
    help: false,
    live: false,
    model: null,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    turnWaitMs: DEFAULT_TURN_WAIT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["-h", "--help"].includes(argument)) {
      options.help = true;
      continue;
    }
    if (argument === "--live") {
      options.live = true;
      continue;
    }
    if (argument === "--codex") {
      options.codexCommand = takeValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--model") {
      options.model = takeValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--effort") {
      options.effort = takeValue(argv, index, argument);
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
    if (argument === "--turn-wait-ms") {
      options.turnWaitMs = parsePositiveInteger(
        takeValue(argv, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (!options.live && (options.model || options.effort)) {
    throw new Error("--model and --effort require --live");
  }
  return options;
}

function containsText(value, expected) {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => containsText(item, expected));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsText(item, expected));
  }
  return false;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function runCli(argumentsList, { signal, socketPath, stateHome, timeoutMs }) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [cliPath, ...argumentsList, "--socket", socketPath],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, XDG_STATE_HOME: stateHome },
        maxBuffer: 4 * 1024 * 1024,
        signal,
        timeout: timeoutMs,
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(
      `nelos ${argumentsList[0]} failed${stderr ? `: ${stderr}` : `: ${error.message}`}`,
    );
  }
}

async function discoverRegisteredThreadIds(stateHome, title) {
  const directory = join(stateHome, "nelos", "tasks");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readFile(join(directory, entry.name), "utf8")
      .then((contents) => JSON.parse(contents))
      .catch(() => null);
    if (record?.title === title && typeof record.threadId === "string") {
      ids.push(record.threadId);
    }
  }
  return ids;
}

async function discoverServerThreadIds(context, title, workspace, attempts = 3) {
  const ids = new Set();
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const results = await Promise.all([
        runCli(["list", "--all", "--search", title, "--limit", "100"], {
          ...context,
          timeoutMs: 30_000,
        }),
        runCli(["list", "--all", "--limit", "100"], {
          ...context,
          timeoutMs: 30_000,
        }),
      ]);
      for (const task of results.flatMap((result) => result.tasks)) {
        if (
          (task.title === title || task.cwd === workspace) &&
          typeof task.threadId === "string"
        ) {
          ids.add(task.threadId);
        }
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await sleep(250);
  }
  if (lastError) throw lastError;
  return [...ids];
}

async function discoverActiveTurns(context, threadIds, activeTurns) {
  for (const threadId of threadIds) {
    try {
      const status = await runCli(["status", threadId], {
        ...context,
        timeoutMs: 10_000,
      });
      if (status.latestTurn?.id && status.latestTurn.status === "inProgress") {
        activeTurns.set(status.latestTurn.id, {
          threadId,
          turnId: status.latestTurn.id,
        });
      }
    } catch {
      // Archival reports whether server-side cleanup ultimately succeeded.
    }
  }
}

async function interruptActiveTurns(socketPath, activeTurns) {
  if (activeTurns.size === 0) return;
  let client;
  try {
    client = await openAppServerClient({
      clientName: "nelos-app-server-verifier-cleanup",
      clientTitle: "Nelos App Server Verifier Cleanup",
      socketPath,
      timeoutMs: 5_000,
    });
    for (const { threadId, turnId } of activeTurns.values()) {
      await client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    }
    await sleep(100);
  } catch {
    // Archival below remains the authoritative cleanup check. Interruption is
    // best-effort because a turn may complete between the last watch and here.
  } finally {
    client?.close();
  }
}

async function runTransportCheck(context) {
  const result = await runCli(["list", "--all", "--limit", "1"], context);
  assert.equal(result.command, "list");
  assert.ok(Number.isInteger(result.count) && result.count >= 0);
  assert.ok(Array.isArray(result.tasks));
  assert.equal(result.count, result.tasks.length);
}

async function runLiveCheck(context, options, smoke) {
  const profileArguments = [
    ...(options.model ? ["--model", options.model] : []),
    ...(options.effort ? ["--effort", options.effort] : []),
  ];
  const commonWait = [
    "--poll-ms",
    "250",
    "--max-wait-ms",
    String(options.turnWaitMs),
  ];
  const commandTimeoutMs = options.turnWaitMs + 30_000;

  const started = await runCli(
    [
      "start",
      "--title",
      smoke.title,
      "--prompt",
      `Reply with ${smoke.firstSentinel}. Do not use tools.`,
      "--cwd",
      smoke.workspace,
      "--sandbox",
      "read-only",
      "--approval",
      "never",
      ...profileArguments,
    ],
    { ...context, timeoutMs: commandTimeoutMs },
  );
  assert.equal(started.command, "start");
  assert.equal(started.detached, true);
  assert.ok(started.threadId);
  assert.ok(started.turnId);
  assert.equal(started.title, smoke.title);
  smoke.threadIds.add(started.threadId);
  smoke.activeTurns.set(started.turnId, {
    threadId: started.threadId,
    turnId: started.turnId,
  });

  const firstWatch = await runCli(
    ["watch", started.threadId, ...commonWait],
    { ...context, timeoutMs: commandTimeoutMs },
  );
  assert.equal(firstWatch.threadId, started.threadId);
  assert.equal(firstWatch.turn?.id, started.turnId);
  assert.equal(firstWatch.turn?.status, "completed");
  assert.ok(containsText(firstWatch.turn?.items, smoke.firstSentinel));
  smoke.activeTurns.delete(started.turnId);

  const firstRead = await runCli(
    ["read", started.threadId, "--turns", "2"],
    { ...context, timeoutMs: commandTimeoutMs },
  );
  assert.ok(containsText(firstRead.turns, smoke.firstSentinel));

  const sent = await runCli(
    [
      "send",
      started.threadId,
      "--prompt",
      `Reply with ${smoke.secondSentinel}. Do not use tools.`,
      ...profileArguments,
    ],
    { ...context, timeoutMs: commandTimeoutMs },
  );
  assert.equal(sent.command, "send");
  assert.equal(sent.threadId, started.threadId);
  assert.ok(sent.turnId);
  assert.notEqual(sent.turnId, started.turnId);
  smoke.activeTurns.set(sent.turnId, {
    threadId: started.threadId,
    turnId: sent.turnId,
  });

  const secondWatch = await runCli(
    ["watch", started.threadId, ...commonWait],
    { ...context, timeoutMs: commandTimeoutMs },
  );
  assert.equal(secondWatch.threadId, started.threadId);
  assert.equal(secondWatch.turn?.id, sent.turnId);
  assert.equal(secondWatch.turn?.status, "completed");
  assert.ok(containsText(secondWatch.turn?.items, smoke.secondSentinel));
  smoke.activeTurns.delete(sent.turnId);

  const finalRead = await runCli(
    ["read", started.threadId, "--turns", "3"],
    { ...context, timeoutMs: commandTimeoutMs },
  );
  assert.ok(containsText(finalRead.turns, started.turnId));
  assert.ok(containsText(finalRead.turns, sent.turnId));
  assert.ok(containsText(finalRead.turns, smoke.firstSentinel));
  assert.ok(containsText(finalRead.turns, smoke.secondSentinel));

  return {
    firstTurnCompleted: true,
    laterTurnCompleted: true,
    sameTaskContinuation: true,
  };
}

function combineCleanupErrors(errors, message = "verifier cleanup failed") {
  const normalized = errors.map((error) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  if (normalized.length === 0) return null;
  if (normalized.length === 1) return normalized[0];
  return new AggregateError(
    normalized,
    `${message}: ${normalized.map((error) => error.message).join("; ")}`,
  );
}

export async function finalizeVerifierCleanup({
  cleanupLiveTasks,
  removeTemporary,
  retainTemporary = false,
  stopServer,
  temporary,
}) {
  const errors = [];
  let safeToRemoveArtifacts = !retainTemporary;

  try {
    await cleanupLiveTasks();
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await stopServer();
    } catch (error) {
      safeToRemoveArtifacts = false;
      errors.push(error);
    } finally {
      if (safeToRemoveArtifacts) {
        try {
          await removeTemporary();
        } catch (error) {
          errors.push(
            new Error(
              `could not remove verifier artifacts at ${temporary}: ${error.message}`,
              { cause: error },
            ),
          );
        }
      } else {
        errors.push(
          new Error(
            `app-server cleanup did not complete; retained recovery artifacts at ${temporary}`,
          ),
        );
      }
    }
  }

  return combineCleanupErrors(errors);
}

export async function runVerifier(argv = process.argv.slice(2)) {
  const options = parseVerifierArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const temporary = await mkdtemp(join(tmpdir(), "nelos-app-server-"));
  const socketPath = join(temporary, "app.sock");
  const stateHome = join(temporary, "state");
  const workspace = join(temporary, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const nonce = randomUUID().replaceAll("-", "");
  const smoke = {
    activeTurns: new Map(),
    firstSentinel: `NELOS_FIRST_${nonce}`,
    secondSentinel: `NELOS_SECOND_${nonce}`,
    threadIds: new Set(),
    title: `Nelos live smoke ${nonce}`,
    workspace,
  };
  let server = null;
  let cleanupPromise = null;
  let cleanupError = null;
  let receivedSignal = null;
  let summary = null;
  let failure = null;
  const abortController = new AbortController();
  const baseContext = {
    socketPath,
    stateHome,
    timeoutMs: options.startupTimeoutMs + 10_000,
  };
  const executionContext = {
    ...baseContext,
    signal: abortController.signal,
  };

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const cleanupLiveTasks = async () => {
        if (!options.live || !server) return;
        const errors = [];

        try {
          for (const id of await discoverRegisteredThreadIds(stateHome, smoke.title)) {
            smoke.threadIds.add(id);
          }
        } catch (error) {
          errors.push(
            new Error(
              `failed to discover registered live smoke tasks: ${error.message}`,
              { cause: error },
            ),
          );
        }
        try {
          for (const id of await discoverServerThreadIds(
            baseContext,
            smoke.title,
            smoke.workspace,
          )) {
            smoke.threadIds.add(id);
          }
        } catch (error) {
          errors.push(
            new Error(`failed to discover live smoke tasks: ${error.message}`, {
              cause: error,
            }),
          );
        }
        try {
          await discoverActiveTurns(baseContext, smoke.threadIds, smoke.activeTurns);
        } catch (error) {
          errors.push(
            new Error(`failed to discover active live smoke turns: ${error.message}`, {
              cause: error,
            }),
          );
        }
        try {
          await interruptActiveTurns(socketPath, smoke.activeTurns);
        } catch (error) {
          errors.push(
            new Error(`failed to interrupt active live smoke turns: ${error.message}`, {
              cause: error,
            }),
          );
        }
        for (const threadId of smoke.threadIds) {
          try {
            const archived = await runCli(["archive", threadId], {
              ...baseContext,
              timeoutMs: 30_000,
            });
            if (!archived.archived || !archived.serverArchived) {
              throw new Error(`server did not confirm archive for ${threadId}`);
            }
          } catch (error) {
            errors.push(
              new Error(
                `${error.message}; manual recovery: nelos archive ${threadId}`,
                { cause: error },
              ),
            );
          }
        }

        const liveCleanupError = combineCleanupErrors(
          errors,
          "failed to clean up live smoke tasks",
        );
        if (liveCleanupError) throw liveCleanupError;
      };

      cleanupError = await finalizeVerifierCleanup({
        cleanupLiveTasks,
        removeTemporary: () => rm(temporary, { recursive: true, force: true }),
        retainTemporary: Boolean(failure?.cleanupIncomplete),
        stopServer: async () => {
          if (server) {
            await server.stop({ signal: receivedSignal || "SIGTERM" });
          }
        },
        temporary,
      });
    })();
    return cleanupPromise;
  };

  const handleSignal = (signal) => {
    receivedSignal ||= signal;
    abortController.abort();
  };
  const handleSigint = () => handleSignal("SIGINT");
  const handleSigterm = () => handleSignal("SIGTERM");
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  try {
    server = await startStandaloneAppServer({
      codexCommand: options.codexCommand,
      detached: true,
      signal: abortController.signal,
      socketPath,
      startupTimeoutMs: options.startupTimeoutMs,
      stdio: ["ignore", "ignore", "ignore"],
    });
    assert.equal(server.owned, true);
    assert.equal(server.reused, false);
    if (receivedSignal) throw new Error(`verification interrupted by ${receivedSignal}`);
    await runTransportCheck(executionContext);
    const liveResult = options.live
      ? await runLiveCheck(executionContext, options, smoke)
      : {};
    summary = {
      mode: options.live ? "live" : "transport",
      customUnixSocket: true,
      initialized: true,
      threadListShapeValid: true,
      modelTurns: options.live ? 2 : 0,
      ...liveResult,
    };
  } catch (error) {
    failure = error;
  } finally {
    await cleanup();
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
  }

  if (failure && cleanupError) {
    throw new AggregateError(
      [failure, cleanupError],
      `${failure.message}; cleanup also failed: ${cleanupError.message}`,
    );
  }
  if (receivedSignal && cleanupError) {
    throw new Error(
      `verification interrupted by ${receivedSignal}; cleanup failed: ${cleanupError.message}`,
    );
  }
  if (receivedSignal) {
    throw new Error(`verification interrupted by ${receivedSignal}`);
  }
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
  process.stdout.write(`${JSON.stringify({ ...summary, cleanedUp: true }, null, 2)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runVerifier().catch((error) => {
    process.stderr.write(`verify-app-server: ${error.message}\n`);
    process.exitCode = 1;
  });
}
