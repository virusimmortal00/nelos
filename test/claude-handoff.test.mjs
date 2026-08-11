import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildSeedRecords,
  claudeProjectDirectoryName,
  claudeResumeUrl,
  composeHandoffPrompt,
  listClaudeHandoffRecords,
  openClaudeDeepLink,
  seedClaudeHandoff,
  writeSeedTranscript,
} from "../src/claude-handoff.mjs";

const cli = fileURLToPath(new URL("../bin/nelos", import.meta.url));
const SESSION_ID = "2a5fa9ad-9234-46fb-9f97-f2461329008b";

test("claudeResumeUrl formats and validates the session id", () => {
  assert.equal(
    claudeResumeUrl(SESSION_ID),
    `claude://resume?session=${SESSION_ID}`,
  );
  assert.equal(claudeResumeUrl(SESSION_ID.toUpperCase()).includes(SESSION_ID), true);
  assert.throws(() => claudeResumeUrl("not-a-uuid"), /must be a UUID/);
  assert.throws(() => claudeResumeUrl(""), /must be a UUID/);
});

test("claudeProjectDirectoryName matches Claude Code's observed encoding", () => {
  assert.equal(
    claudeProjectDirectoryName("/Users/bobby.sayers/src/nelos"),
    "-Users-bobby-sayers-src-nelos",
  );
  assert.equal(
    claudeProjectDirectoryName(
      "/Users/bobby.sayers/src/nelos/.claude/worktrees/x-1",
    ),
    "-Users-bobby-sayers-src-nelos--claude-worktrees-x-1",
  );
  assert.throws(() => claudeProjectDirectoryName("relative/path"), /absolute/);
});

test("composeHandoffPrompt leads with the title and cites the source task", () => {
  const prompt = composeHandoffPrompt({
    title: "Migrate the flaky test harness",
    prompt: "Full context body.",
    sourceThreadId: "thread-123",
  });
  const lines = prompt.split("\n");
  assert.equal(lines[0], "Nelos handoff — Migrate the flaky test harness");
  assert.equal(
    lines[1],
    "Source: Codex task thread-123 (codex://threads/thread-123)",
  );
  assert.equal(lines.at(-1), "Full context body.");
});

test("composeHandoffPrompt omits the source line without a thread id", () => {
  const prompt = composeHandoffPrompt({ title: "T", prompt: "Body." });
  assert.equal(prompt, "Nelos handoff — T\n\nBody.");
});

test("composeHandoffPrompt rejects unusable titles and prompts", () => {
  assert.throws(() => composeHandoffPrompt({ title: " ", prompt: "x" }), /empty/);
  assert.throws(
    () => composeHandoffPrompt({ title: "a\nb", prompt: "x" }),
    /single line/,
  );
  assert.throws(
    () => composeHandoffPrompt({ title: "x".repeat(201), prompt: "x" }),
    /exceeds 200/,
  );
  assert.throws(() => composeHandoffPrompt({ title: "T", prompt: "" }), /empty/);
});

test("buildSeedRecords produces a coherent transcript chain", () => {
  const records = buildSeedRecords({
    sessionId: SESSION_ID,
    cwd: "/tmp/example",
    title: "Handoff title",
    prompt: "Handoff prompt",
    now: new Date("2026-07-22T00:00:00.000Z"),
  });
  const [title, user, lastPrompt] = records;
  assert.equal(title.type, "custom-title");
  assert.equal(title.customTitle, "Handoff title");
  assert.equal(user.type, "user");
  assert.equal(user.parentUuid, null);
  assert.equal(user.message.content, "Handoff prompt");
  assert.equal(user.cwd, "/tmp/example");
  assert.equal(user.timestamp, "2026-07-22T00:00:00.000Z");
  assert.equal(lastPrompt.type, "last-prompt");
  assert.equal(lastPrompt.leafUuid, user.uuid);
  for (const record of records) assert.equal(record.sessionId, SESSION_ID);
});

test("writeSeedTranscript writes JSONL once and refuses to overwrite", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "nelos-claude-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const records = buildSeedRecords({
    sessionId: SESSION_ID,
    cwd: configDir,
    title: "T",
    prompt: "P",
  });
  const transcriptPath = await writeSeedTranscript({
    claudeConfigDir: configDir,
    cwd: configDir,
    sessionId: SESSION_ID,
    records,
  });
  assert.equal(
    transcriptPath,
    join(
      configDir,
      "projects",
      claudeProjectDirectoryName(configDir),
      `${SESSION_ID}.jsonl`,
    ),
  );
  const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, records.length);
  for (const line of lines) JSON.parse(line);

  await assert.rejects(
    writeSeedTranscript({
      claudeConfigDir: configDir,
      cwd: configDir,
      sessionId: SESSION_ID,
      records,
    }),
    /already has a transcript/,
  );
});

test("seedClaudeHandoff validates the workspace directory", async () => {
  await assert.rejects(
    seedClaudeHandoff({
      title: "T",
      prompt: "P",
      cwd: "/nonexistent/nelos-handoff-path",
      claudeConfigDir: "/tmp",
    }),
    /not a directory/,
  );
  await assert.rejects(
    seedClaudeHandoff({ title: "T", prompt: "P", cwd: "relative" }),
    /absolute/,
  );
});

test("openClaudeDeepLink only opens claude:// URLs and reports failures", async () => {
  assert.throws(
    () => openClaudeDeepLink("https://example.com"),
    /non-claude:\/\//,
  );
  await assert.rejects(
    openClaudeDeepLink(claudeResumeUrl(SESSION_ID), {
      platform: "win32",
    }),
    /not supported/,
  );
  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push([command, ...args]);
    return {
      on(event, handler) {
        if (event === "exit") setImmediate(() => handler(0));
      },
      kill() {},
    };
  };
  await openClaudeDeepLink(claudeResumeUrl(SESSION_ID), {
    platform: "darwin",
    spawnImpl: fakeSpawn,
  });
  assert.deepEqual(calls, [["open", claudeResumeUrl(SESSION_ID)]]);
});

test("handoff-claude CLI seeds, records, and reports without opening", async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), "nelos-handoff-cli-"));
  const configDir = join(workDir, "claude-config");
  const stateHome = join(workDir, "state");
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "handoff-claude",
      "--title",
      "CLI handoff test",
      "--prompt",
      "Do the thing.",
      "--cwd",
      workDir,
      "--thread-id",
      "thread-9",
      "--claude-config-dir",
      configDir,
      "--no-open",
    ],
    { encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: stateHome } },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.command, "handoff-claude");
  assert.equal(output.title, "CLI handoff test");
  assert.equal(output.sourceThreadId, "thread-9");
  assert.equal(output.opened, false);
  assert.equal(output.taskUrl, `claude://resume?session=${output.sessionId}`);
  assert.equal(output.nextAction.kind, "attention");
  assert.match(output.openHint, /Import Claude Code CLI sessions/);

  const transcript = await readFile(output.transcriptPath, "utf8");
  const records = transcript.trim().split("\n").map((line) => JSON.parse(line));
  const user = records.find((record) => record.type === "user");
  assert.match(user.message.content, /^Nelos handoff — CLI handoff test\n/);
  assert.match(user.message.content, /Source: Codex task thread-9/);
  assert.match(user.message.content, /Do the thing\./);

  const listed = await (async () => {
    const prior = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      return await listClaudeHandoffRecords();
    } finally {
      if (prior === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prior;
    }
  })();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, output.sessionId);
  assert.equal(listed[0].sourceThreadId, "thread-9");
});

test("handoff-claude CLI rejects an in-use session id", async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), "nelos-handoff-dup-"));
  const configDir = join(workDir, "claude-config");
  const stateHome = join(workDir, "state");
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const args = [
    cli,
    "handoff-claude",
    "--title",
    "Duplicate",
    "--prompt",
    "P",
    "--cwd",
    workDir,
    "--session-id",
    SESSION_ID,
    "--claude-config-dir",
    configDir,
    "--no-open",
  ];
  const environment = { ...process.env, XDG_STATE_HOME: stateHome };
  const first = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already has a transcript/);
});
