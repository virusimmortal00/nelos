import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

import { taskStateDirectory } from "./task-state.mjs";

// The Claude Code desktop app imports a CLI session when it receives a
// claude://resume deep link, so a handoff is: write a transcript the CLI
// itself could have written, then open the link. Verified against Claude
// desktop 1.24012.1 / Claude Code CLI 2.1.217; the transcript records below
// mirror that CLI's session format.
export const CLAUDE_HANDOFF_SCHEMA_VERSION = 1;
export const MAX_HANDOFF_TITLE_LENGTH = 200;
export const MAX_HANDOFF_PROMPT_BYTES = 64 * 1024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertClaudeSessionId(sessionId) {
  const normalized = String(sessionId || "").toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`Claude session ID must be a UUID: ${sessionId}`);
  }
  return normalized;
}

export function claudeConfigDirectory(environment = process.env) {
  const configured = environment.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`CLAUDE_CONFIG_DIR must be absolute: ${configured}`);
    }
    return configured;
  }
  return join(homedir(), ".claude");
}

// Claude Code stores each workspace's transcripts under
// <config>/projects/<encoded-cwd>/, where every non-alphanumeric character
// of the absolute path becomes "-".
export function claudeProjectDirectoryName(cwd) {
  if (!isAbsolute(cwd)) throw new Error(`cwd must be absolute: ${cwd}`);
  return cwd.replaceAll(/[^A-Za-z0-9]/g, "-");
}

export function claudeResumeUrl(sessionId) {
  return `claude://resume?session=${encodeURIComponent(
    assertClaudeSessionId(sessionId),
  )}`;
}

function assertHandoffTitle(title) {
  const normalized = String(title ?? "").trim();
  if (!normalized) throw new Error("handoff title must not be empty");
  if (/[\n\r]/.test(normalized)) {
    throw new Error("handoff title must be a single line");
  }
  if (normalized.length > MAX_HANDOFF_TITLE_LENGTH) {
    throw new Error(
      `handoff title exceeds ${MAX_HANDOFF_TITLE_LENGTH} characters`,
    );
  }
  return normalized;
}

function assertHandoffPrompt(prompt) {
  const normalized = String(prompt ?? "");
  if (!normalized.trim()) throw new Error("handoff prompt must not be empty");
  if (Buffer.byteLength(normalized, "utf8") > MAX_HANDOFF_PROMPT_BYTES) {
    throw new Error(`handoff prompt exceeds ${MAX_HANDOFF_PROMPT_BYTES} bytes`);
  }
  return normalized;
}

// The imported session starts untitled in the desktop app (its importer does
// not read transcript titles yet), so the first line must carry the task
// identity for both the human reader and the app's later auto-titling.
export function composeHandoffPrompt({ title, prompt, sourceThreadId = null }) {
  const normalizedTitle = assertHandoffTitle(title);
  const normalizedPrompt = assertHandoffPrompt(prompt);
  const lines = [`Nelos handoff — ${normalizedTitle}`];
  if (sourceThreadId) {
    lines.push(
      `Source: Codex task ${sourceThreadId} (codex://threads/${encodeURIComponent(sourceThreadId)})`,
    );
  }
  lines.push("", normalizedPrompt);
  return lines.join("\n");
}

export function buildSeedRecords({ sessionId, cwd, title, prompt, now = new Date() }) {
  const normalizedSessionId = assertClaudeSessionId(sessionId);
  if (!isAbsolute(cwd)) throw new Error(`cwd must be absolute: ${cwd}`);
  const normalizedTitle = assertHandoffTitle(title);
  const normalizedPrompt = assertHandoffPrompt(prompt);
  const timestamp = now.toISOString();
  const userUuid = randomUUID();
  return [
    {
      type: "custom-title",
      customTitle: normalizedTitle,
      sessionId: normalizedSessionId,
    },
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: normalizedPrompt },
      uuid: userUuid,
      timestamp,
      cwd,
      sessionId: normalizedSessionId,
      userType: "external",
    },
    {
      type: "last-prompt",
      lastPrompt: normalizedPrompt,
      leafUuid: userUuid,
      sessionId: normalizedSessionId,
    },
  ];
}

export async function writeSeedTranscript({
  claudeConfigDir,
  cwd,
  sessionId,
  records,
}) {
  const normalizedSessionId = assertClaudeSessionId(sessionId);
  const projectDirectory = join(
    claudeConfigDir,
    "projects",
    claudeProjectDirectoryName(cwd),
  );
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  const transcriptPath = join(projectDirectory, `${normalizedSessionId}.jsonl`);
  const payload = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  try {
    // "wx" refuses to overwrite: a transcript collision means the session ID
    // is already in use by a real conversation.
    await writeFile(transcriptPath, payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Claude session ${normalizedSessionId} already has a transcript: ${transcriptPath}`,
      );
    }
    throw error;
  }
  return transcriptPath;
}

export async function seedClaudeHandoff({
  title,
  prompt,
  cwd,
  sessionId = null,
  sourceThreadId = null,
  claudeConfigDir = null,
  now = new Date(),
}) {
  if (!isAbsolute(cwd || "")) throw new Error(`cwd must be absolute: ${cwd}`);
  const cwdInfo = await stat(cwd).catch(() => null);
  if (!cwdInfo?.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  const resolvedSessionId = sessionId
    ? assertClaudeSessionId(sessionId)
    : randomUUID();
  const resolvedConfigDir = claudeConfigDir || claudeConfigDirectory();
  const promptText = composeHandoffPrompt({ title, prompt, sourceThreadId });
  const records = buildSeedRecords({
    sessionId: resolvedSessionId,
    cwd,
    title,
    prompt: promptText,
    now,
  });
  const transcriptPath = await writeSeedTranscript({
    claudeConfigDir: resolvedConfigDir,
    cwd,
    sessionId: resolvedSessionId,
    records,
  });
  return {
    sessionId: resolvedSessionId,
    transcriptPath,
    taskUrl: claudeResumeUrl(resolvedSessionId),
    promptText,
  };
}

// Fires the deep link through the platform opener. The desktop app owns the
// claude:// scheme; if handling is disabled or the app is absent the opener
// exits non-zero and the caller should fall back to the app's manual
// "Import Claude Code CLI sessions" flow.
export function openClaudeDeepLink(
  url,
  { platform = process.platform, spawnImpl = spawn, timeoutMs = 10_000 } = {},
) {
  if (!url.startsWith("claude://")) {
    throw new Error(`refusing to open a non-claude:// URL: ${url}`);
  }
  const command =
    platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
  if (!command) {
    return Promise.reject(
      new Error(`deep links are not supported on platform: ${platform}`),
    );
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl(command, [url], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`${command} failed: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with code ${code}`));
    });
  });
}

function handoffRegistryDirectory() {
  return join(taskStateDirectory(), "claude-handoffs");
}

export async function writeClaudeHandoffRecord(record) {
  const sessionId = assertClaudeSessionId(record.sessionId);
  const directory = handoffRegistryDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${sessionId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ schemaVersion: CLAUDE_HANDOFF_SCHEMA_VERSION, ...record }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, target);
  return target;
}

export async function listClaudeHandoffRecords() {
  let entries;
  try {
    entries = await readdir(handoffRegistryDirectory(), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(
        await readFile(join(handoffRegistryDirectory(), entry.name), "utf8"),
      );
      if (typeof record?.sessionId === "string" && record.sessionId) {
        records.push(record);
      }
    } catch {
      // A malformed entry must not prevent healthy state from being used.
    }
  }
  return records.toSorted((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}
