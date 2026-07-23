import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const openaiYaml = await readFile(
  new URL("../skills/manage-nelos-tasks/agents/openai.yaml", import.meta.url),
  "utf8",
);
const webQueen = await readFile(
  new URL(
    "../skills/manage-nelos-tasks/agents/samples/web-queen.toml",
    import.meta.url,
  ),
  "utf8",
);
const reviewerExplorer = await readFile(
  new URL(
    "../skills/manage-nelos-tasks/agents/samples/reviewer-explorer.toml",
    import.meta.url,
  ),
  "utf8",
);
const agentsReadme = await readFile(
  new URL("../skills/manage-nelos-tasks/agents/README.md", import.meta.url),
  "utf8",
);

test("openai.yaml declares discovery metadata without changing implicit invocation", () => {
  assert.match(openaiYaml, /^interface:/m);
  assert.match(openaiYaml, /display_name:\s*.+/);
  assert.match(openaiYaml, /short_description:\s*.+/);
  assert.match(openaiYaml, /default_prompt:\s*.+/);
  assert.doesNotMatch(openaiYaml, /allow_implicit_invocation/);
});

test("the web-queen sample inherits live parent permissions", () => {
  assert.match(webQueen, /^name = "nelos-web-queen"$/m);
  assert.match(webQueen, /^description = ".+"$/m);
  assert.match(webQueen, /^developer_instructions = """/m);
  assert.doesNotMatch(webQueen, /^sandbox_mode\s*=/m);
  assert.doesNotMatch(webQueen, /^model\s*=/m);
  assert.match(webQueen, /does not itself grant write access/);
});

test("the reviewer-explorer sample narrows to read-only without escalating", () => {
  assert.match(reviewerExplorer, /^name = "nelos-reviewer-explorer"$/m);
  assert.match(reviewerExplorer, /^sandbox_mode = "read-only"$/m);
  assert.match(reviewerExplorer, /a restriction, not an escalation/);
});

test("the agents README explains opt-in installation for both samples", () => {
  assert.match(agentsReadme, /Nothing here is\ninstalled automatically/);
  assert.match(agentsReadme, /~\/\.codex\/agents\//);
  assert.match(agentsReadme, /\.codex\/agents\//);
  assert.match(agentsReadme, /samples\/web-queen\.toml/);
  assert.match(agentsReadme, /samples\/reviewer-explorer\.toml/);
});
