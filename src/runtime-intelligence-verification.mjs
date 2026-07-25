import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { findIntelligenceProfileByModel } from "./intelligence-profile-catalog.mjs";

export const RUNTIME_INTELLIGENCE_VERIFICATION_SCHEMA_VERSION = 1;

const MAX_DIRECTORY_DEPTH = 6;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_ROLLOUT_BYTES = 128 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const MAX_TURN_CONTEXTS = 1_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const AGENT_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*){0,15}$/u;

function assertIdentifier(value, field) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function expectedRoute(model, effort) {
  const profile = findIntelligenceProfileByModel(model);
  if (!profile.supportedEfforts.includes(effort)) {
    throw new Error(`unsupported reasoning effort for ${profile.id}: ${effort}`);
  }
  return Object.freeze({ model, effort });
}

export function defaultCodexSessionsRoot() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "sessions");
}

async function findRolloutFiles(root, threadId) {
  const suffix = `-${threadId}.jsonl`;
  const matches = [];
  let visitedEntries = 0;

  async function visit(directory, depth) {
    if (depth > MAX_DIRECTORY_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_DIRECTORY_ENTRIES) {
        throw new Error(
          `session discovery exceeded ${MAX_DIRECTORY_ENTRIES} entries`,
        );
      }
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        matches.push(path);
      }
    }
  }

  await visit(root, 0);
  return matches;
}

async function listRolloutFiles(root) {
  const matches = [];
  let visitedEntries = 0;

  async function visit(directory, depth) {
    if (depth > MAX_DIRECTORY_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_DIRECTORY_ENTRIES) {
        throw new Error(
          `session discovery exceeded ${MAX_DIRECTORY_ENTRIES} entries`,
        );
      }
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        matches.push(path);
      }
    }
  }

  await visit(root, 0);
  return matches;
}

async function readPrimarySessionIdentity(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > MAX_ROLLOUT_BYTES) return null;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) return null;
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return null;
      }
      if (event?.type !== "session_meta") continue;
      return {
        id: event.payload?.id,
        parentThreadId: event.payload?.parent_thread_id,
        spawn: event.payload?.source?.subagent?.thread_spawn ?? null,
      };
    }
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Resolve multiple native subagent launches for one parent with one bounded
 * sessions scan. Every requested path must still match exactly one native
 * child identity.
 */
export async function resolveNativeSubagentThreadsV1({
  parentThreadId,
  agentPaths,
  sessionsRoot = defaultCodexSessionsRoot(),
}) {
  const normalizedParent = assertIdentifier(parentThreadId, "parent thread ID");
  if (!Array.isArray(agentPaths) || agentPaths.length === 0) {
    throw new Error("agent paths must be a non-empty array");
  }
  const normalizedPaths = agentPaths.map((agentPath) => {
    if (typeof agentPath !== "string" || !AGENT_PATH_PATTERN.test(agentPath)) {
      throw new Error("agent path has an invalid format");
    }
    return agentPath;
  });
  const requestedPaths = new Set(normalizedPaths);
  const matches = new Map(
    [...requestedPaths].map((agentPath) => [agentPath, []]),
  );
  for (const path of await listRolloutFiles(sessionsRoot)) {
    const identity = await readPrimarySessionIdentity(path);
    if (
      identity?.parentThreadId === normalizedParent &&
      identity.spawn?.parent_thread_id === normalizedParent &&
      requestedPaths.has(identity.spawn?.agent_path)
    ) {
      const threadId = assertIdentifier(identity.id, "resolved child thread ID");
      if (!path.endsWith(`-${threadId}.jsonl`)) {
        throw new Error("resolved child identity conflicts with its rollout filename");
      }
      matches.get(identity.spawn.agent_path).push(threadId);
    }
  }
  const resolvedByPath = new Map();
  for (const agentPath of requestedPaths) {
    const unique = [...new Set(matches.get(agentPath))];
    if (unique.length === 0) {
      throw new Error("no native child task matches the subagent launch");
    }
    if (unique.length > 1) {
      throw new Error("multiple native child tasks match the subagent launch");
    }
    resolvedByPath.set(
      agentPath,
      Object.freeze({
        schemaVersion: RUNTIME_INTELLIGENCE_VERIFICATION_SCHEMA_VERSION,
        parentThreadId: normalizedParent,
        agentPath,
        threadId: unique[0],
      }),
    );
  }
  return Object.freeze(
    normalizedPaths.map((agentPath) => resolvedByPath.get(agentPath)),
  );
}

/**
 * Resolve only the native child task identity for one exact native subagent
 * launch. Agent path plus parent task identity must match a unique rollout.
 */
export async function resolveNativeSubagentThreadV1(value) {
  return (await resolveNativeSubagentThreadsV1({
    ...value,
    agentPaths: [value?.agentPath],
  }))[0];
}

async function readTurnContexts(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > MAX_ROLLOUT_BYTES) {
    throw new Error("task rollout is missing, unsupported, or oversized");
  }

  const contexts = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
        throw new Error("task rollout contains an oversized event");
      }
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error("task rollout contains malformed JSONL");
      }
      if (event?.type !== "turn_context") continue;
      if (contexts.length >= MAX_TURN_CONTEXTS) {
        throw new Error(
          `task rollout exceeds ${MAX_TURN_CONTEXTS} turn contexts`,
        );
      }
      const turnId = assertIdentifier(event.payload?.turn_id, "observed turn ID");
      const model = event.payload?.model;
      const effort = event.payload?.effort;
      if (typeof model !== "string" || typeof effort !== "string") {
        throw new Error("task rollout turn context has no model or effort");
      }
      contexts.push({ turnId, model, effort });
    }
    return contexts;
  } finally {
    lines.close();
    input.destroy();
  }
}

function uniqueTurnContexts(contexts) {
  const turns = new Map();
  for (const context of contexts) {
    const current = turns.get(context.turnId);
    if (
      current &&
      (current.model !== context.model || current.effort !== context.effort)
    ) {
      throw new Error(
        `task rollout has conflicting route evidence for turn ${context.turnId}`,
      );
    }
    turns.set(context.turnId, context);
  }
  return [...turns.values()];
}

/**
 * Read only bounded turn-context metadata from a local Codex rollout. Prompts,
 * messages, reasoning, tool output, and environment values are never returned.
 */
export async function verifyRuntimeIntelligenceV1({
  threadId,
  turnId = null,
  model,
  effort,
  sessionsRoot = defaultCodexSessionsRoot(),
}) {
  const normalizedThreadId = assertIdentifier(threadId, "thread ID");
  const normalizedTurnId =
    turnId === null ? null : assertIdentifier(turnId, "turn ID");
  const expected = expectedRoute(model, effort);
  const matches = await findRolloutFiles(sessionsRoot, normalizedThreadId);
  if (matches.length === 0) {
    throw new Error(`no local rollout found for task ${normalizedThreadId}`);
  }
  if (matches.length > 1) {
    throw new Error(`multiple local rollouts found for task ${normalizedThreadId}`);
  }

  let observed = uniqueTurnContexts(await readTurnContexts(matches[0]));
  if (normalizedTurnId !== null) {
    observed = observed.filter((context) => context.turnId === normalizedTurnId);
  }
  if (observed.length === 0) {
    throw new Error(
      normalizedTurnId === null
        ? `task ${normalizedThreadId} has no observed turn context`
        : `task ${normalizedThreadId} has no observed context for turn ${normalizedTurnId}`,
    );
  }

  const turns = observed.map((context) => ({
    ...context,
    matches:
      context.model === expected.model && context.effort === expected.effort,
  }));
  return Object.freeze({
    schemaVersion: RUNTIME_INTELLIGENCE_VERIFICATION_SCHEMA_VERSION,
    threadId: normalizedThreadId,
    turnId: normalizedTurnId,
    expected,
    observed: Object.freeze(turns.map((turn) => Object.freeze(turn))),
    verified: turns.every((turn) => turn.matches),
  });
}
