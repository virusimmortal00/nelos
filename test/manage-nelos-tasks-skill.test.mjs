import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const entrypoint = await readFile(
  new URL("../skills/manage-nelos-tasks/SKILL.md", import.meta.url),
  "utf8",
);
const skill = entrypoint;

test("the skill preserves its invocation identity and remains self-contained", () => {
  assert.match(entrypoint, /^name: manage-nelos-tasks$/m);
  // The skill-only installer distributes SKILL.md, not a references tree.
  assert.doesNotMatch(entrypoint, /\]\(references\//);
  // Structural checks do not establish model selection quality. See the
  // independent, bounded selection exercise in docs/skill-discovery.md.
  assert.match(entrypoint, /^description: .{40,400}$/m);
});

test("the skill makes planning quality independent of the queen model", () => {
  assert.match(skill, /Planning quality must not\s+depend on the queen's model/i);
  assert.match(skill, /bounded Sol\s+planner/i);
  assert.match(skill, /Only if the user explicitly supplied a complete plan/i);
  assert.match(skill, /queen-authored plan is not user-supplied/i);
  assert.match(skill, /call `nelos_plan_lifecycle`/);
  assert.match(skill, /caller-stable idempotency key/i);
  assert.match(skill, /Do not first author slices or\s+classify them in the queen/i);
});

test("the skill has one native path driven by machine-generated next actions", () => {
  assert.match(skill, /## Follow the One Desktop Path/);
  assert.match(skill, /call `nelos_plan_slices` directly/);
  assert.match(skill, /execute only the returned\n+`nextAction`/);
  assert.match(skill, /`structuredContent\.protocol\.result`/);
  assert.match(skill, /maps\s+from top-level `structuredContent`/i);
  assert.match(
    skill,
    /reserve `structuredContent\.protocol\.result`\s+for nonvisual handling/i,
  );
  assert.match(skill, /`native-set-title`/);
  assert.match(skill, /`launch-planner`/);
  assert.match(skill, /`launch-wave`/);
  assert.match(skill, /primary identity is `agentPath`/);
  assert.match(skill, /internal thread ID is verification\s+evidence only/);
  assert.match(skill, /Never call it a spinoff/);
  assert.match(skill, /Joined subagents support only Sol or Terra/);
  assert.match(skill, /Luna is\s+valid only for durable spinoffs/);
  assert.match(skill, /`native-wait-subagent` and `native-read-subagent-result`/);
  assert.match(skill, /never\s+submit a mailbox result directly/i);
  assert.match(skill, /Never construct or guess a result action ID/i);
  assert.match(skill, /planner finished and Nelos is verifying its\s+terminal turn/i);
  assert.match(skill, /`native-wait-wave`/);
  assert.match(skill, /`native-wait` and `native-read`/);
  assert.match(skill, /`attach-native-task-options`/);
  assert.match(
    skill,
    /never omit,\s+substitute, or inherit a decided `nativeTask`/i,
  );
  assert.match(skill, /`forkTurns` to the\s+native launcher's `fork_turns` field/);
  assert.match(skill, /never bind an agent name as a\s+thread ID/i);
  assert.match(skill, /`nelos_launch_verify_batch`/);
  assert.match(skill, /`allVerified` is true/);
  assert.match(skill, /`nelos_plan_replan`/);
  assert.match(skill, /second autonomous replan stops/);
  assert.match(skill, /`decide`/);
  assert.match(skill, /call `nelos_queen_decide`/);
  assert.match(skill, /exact consumed `native-result-read` receipt/);
  assert.match(skill, /returned\s+`nelos_orchestrate_advance` action/);
  assert.match(skill, /`cleanup-spinoffs`/);
  assert.match(skill, /snapshotted default `auto`/);
  assert.match(skill, /`ask` prompts\s+once with exact names\/IDs/);
  assert.match(skill, /only for an explicit always choice/);
  assert.match(skill, /`userIntentConfirmed: true`/);
  assert.match(skill, /`orchestration-repair-member`/);
  assert.match(skill, /`orchestration-member-repaired` receipt/);
  assert.match(skill, /adding only `resolution: "detach"`/);
  assert.match(skill, /never\s+depend on remembering a separate cleanup call/i);
  assert.match(skill, /`complete`/);
  assert.match(skill, /Never serially poll a web/);
  assert.doesNotMatch(skill, /--socket|app-server|standalone (?:server|mode)|NELOS_PROMPT/);
  assert.doesNotMatch(skill, /web collect|web begin|web join|nelos-result/);
  // Marketplace installs ship no `nelos` executable; the installed skill
  // must reference only the bundled MCP tools, never shell commands.
  assert.doesNotMatch(skill, /\bnelos_config_(?:get|set|reset)\b/);
  assert.match(skill, /never use the CLI as fallback/i);
  assert.doesNotMatch(skill, /`nelos[ \-]/);
  assert.doesNotMatch(skill, /--spec-file|--effort|--turn-id/);
  assert.ok(skill.length < 10_000, "self-contained skill should remain bounded");
});

test("the task-management skill treats lifecycle state as reconcile-on-read", () => {
  assert.match(skill, /lifecycle cache; never write lifecycle\s+or archival state/i);
  assert.match(skill, /Lifecycle reads reconcile their cache on every read/i);
  assert.match(skill, /observation lease is informational/i);
  assert.match(skill, /Never perform a second local lifecycle\s+mutation/i);
  assert.doesNotMatch(skill, /archive THREAD_ID --registry-only/);
  assert.doesNotMatch(skill, /immediately\s+run/i);
  assert.doesNotMatch(skill, /run[^\n]{0,120}after[^\n]{0,120}archive/i);
});
