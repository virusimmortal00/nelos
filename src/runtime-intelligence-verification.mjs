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
// Codex lays rollouts out as sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl.
const ROLLOUT_YEAR_PATTERN = /^\d{4}$/;
const ROLLOUT_MONTH_DAY_PATTERN = /^\d{2}$/;

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
  let visitedEntries = 0;

  function count() {
    visitedEntries += 1;
    if (visitedEntries > MAX_DIRECTORY_ENTRIES) {
      throw new Error(
        `session discovery exceeded ${MAX_DIRECTORY_ENTRIES} entries`,
      );
    }
  }

  async function readEntries(directory) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      return entries;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  // Suffix-matching files directly inside one directory (a day directory).
  async function matchesIn(directory) {
    const entries = await readEntries(directory);
    if (!entries) return [];
    const found = [];
    for (const entry of entries) {
      count();
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name.endsWith(suffix)) {
        found.push(join(directory, entry.name));
      }
    }
    return found;
  }

  // Numeric child directories (year/month/day segments), newest first.
  async function descendingSegments(directory, pattern) {
    const entries = await readEntries(directory);
    if (!entries) return [];
    const segments = [];
    for (const entry of entries) {
      count();
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (pattern.test(entry.name)) segments.push(entry.name);
    }
    return segments.reverse();
  }

  // Fast path: walk sessions/YYYY/MM/DD newest-first and stop at the first
  // day that holds the thread, so growth in older history costs nothing per
  // call. Same-day duplicates are still surfaced (the whole day is scanned);
  // cross-day duplicates are intentionally not — see docs/mcp-tool-surface.md.
  // Returns null when the root is not date-partitioned so the caller can fall
  // back to an exhaustive walk rather than risk a false "not found".
  async function newestFirst() {
    const years = await descendingSegments(root, ROLLOUT_YEAR_PATTERN);
    if (years.length === 0) return null;
    for (const year of years) {
      const yearPath = join(root, year);
      for (const month of await descendingSegments(yearPath, ROLLOUT_MONTH_DAY_PATTERN)) {
        const monthPath = join(yearPath, month);
        for (const day of await descendingSegments(monthPath, ROLLOUT_MONTH_DAY_PATTERN)) {
          const matches = await matchesIn(join(monthPath, day));
          if (matches.length > 0) return matches;
        }
      }
    }
    return [];
  }

  // Exhaustive bounded walk, used when the layout is not date-partitioned or
  // the date tree held no match, so a nonstandard placement is still found.
  async function walk(directory, depth) {
    if (depth > MAX_DIRECTORY_DEPTH) return [];
    const entries = await readEntries(directory);
    if (!entries) return [];
    const found = [];
    for (const entry of entries) {
      count();
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        found.push(...(await walk(path, depth + 1)));
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        found.push(path);
      }
    }
    return found;
  }

  const structured = await newestFirst();
  if (structured && structured.length > 0) return structured;
  return walk(root, 0);
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
