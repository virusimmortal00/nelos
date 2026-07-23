import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(
  new URL("../skills/manage-fraktik-tasks/SKILL.md", import.meta.url),
  "utf8",
);

test("the task-management skill is discoverable for coordinated work", () => {
  const frontMatter = skill.slice(0, skill.indexOf("---", 3) + 3);

  assert.match(frontMatter, /Plan multi-stream feature or fix work/);
  assert.match(frontMatter, /subagents or durable Codex tasks/);
  assert.match(frontMatter, /machine-generated next actions/);
});

test("the skill reserves model judgment for lifecycle choice and slice authorship", () => {
  assert.match(skill, /only judgment this skill asks the queen to make/i);
  assert.match(skill, /bounded \*\*subagent\*\*/);
  assert.match(skill, /durable \*\*spinoff\*\*/);
  assert.match(skill, /Parallelism alone is not a reason to create a spinoff/);
  assert.match(skill, /objective, concrete deliverable,\n+testable acceptance criteria, explicit dependencies/);
  assert.match(skill, /`subagent` with `shared-read-only`/);
  assert.match(skill, /`spinoff` with `isolated-write`/);
});

test("the skill has one native path driven by machine-generated next actions", () => {
  assert.match(skill, /## Follow the One Desktop Path/);
  assert.match(skill, /`fraktik_plan_slices` tool with the plan/);
  assert.match(skill, /execute only the\n+returned `nextAction`/);
  assert.match(skill, /`native-set-title`/);
  assert.match(skill, /`launch-wave`/);
  assert.match(skill, /`native-wait` and `native-read`/);
  assert.match(skill, /`attach-native-task-options`/);
  assert.match(skill, /Never omit, substitute, or inherit a decided `nativeTask` field/);
  assert.match(skill, /`fraktik_intelligence_verify` tool/);
  assert.match(skill, /any mismatch stops\n+  the wave/);
  assert.match(skill, /`decide`/);
  assert.match(skill, /`complete`/);
  assert.match(skill, /Never serially poll a web/);
  assert.doesNotMatch(skill, /--socket|app-server|standalone|FRAKTIK_PROMPT/);
  assert.doesNotMatch(skill, /web collect|web begin|web join|fraktik-result/);
  // Marketplace installs ship no `fraktik` executable; the installed skill
  // must reference only the bundled MCP tools, never shell commands.
  assert.doesNotMatch(skill, /`fraktik[ \-]/);
  assert.doesNotMatch(skill, /--spec-file|--effort|--turn-id/);
  assert.ok(skill.length < 5_000, "agent-facing skill should remain compact");
  assert.ok(skill.split("\n").length < 90, "agent-facing skill should be scannable");
});

test("the task-management skill treats lifecycle state as reconcile-on-read", () => {
  assert.match(skill, /lifecycle cache;\s*never write lifecycle or archival state/i);
  assert.match(skill, /reconcile their lifecycle cache on every read/i);
  assert.match(skill, /observation\nlease is informational/i);
  assert.match(skill, /Never perform a second local lifecycle\n  mutation/i);
  assert.doesNotMatch(skill, /archive THREAD_ID --registry-only/);
  assert.doesNotMatch(skill, /immediately\s+run/i);
  assert.doesNotMatch(skill, /run[^\n]{0,120}after[^\n]{0,120}archive/i);
});
