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

async function readTurnContexts(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > MAX_ROLLOUT_BYTES) {
    throw new Error("task rollout is missing, unsupported, or oversized");
  }

  const contexts = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
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
