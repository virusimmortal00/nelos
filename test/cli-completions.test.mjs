import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cliSource = await readFile(new URL("../bin/nelos", import.meta.url), "utf8");
const bash = await readFile(new URL("../completions/nelos.bash", import.meta.url), "utf8");
const zsh = await readFile(new URL("../completions/nelos.zsh", import.meta.url), "utf8");
const fish = await readFile(new URL("../completions/nelos.fish", import.meta.url), "utf8");

function sortedSet(values) {
  return [...new Set(values)].toSorted();
}

function canonicalTopLevelCommands() {
  const match = cliSource.match(/const supported = \[([\s\S]*?)\];/);
  assert.ok(match, "could not find nelos's `supported` command array");
  return sortedSet([...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
}

function canonicalSubcommands(name, pattern, source = cliSource) {
  const match = source.match(pattern);
  assert.ok(match, `could not find nelos's ${name} subcommand list`);
  return sortedSet([...match[0].matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]));
}

const CANONICAL = {
  commands: canonicalTopLevelCommands(),
  title: canonicalSubcommands(
    "title",
    /!\['[a-z]+', '[a-z]+'\]\.includes\(action\)\) throw new Error\("title requires/,
  ),
  web: canonicalSubcommands(
    "web",
    /!\["[a-z]+", "[a-z]+", "[a-z]+", "[a-z]+", "[a-z]+"\]\.includes\(action\)\) \{\s*\n\s*throw new Error\("web requires/,
    cliSource.slice(cliSource.indexOf("async function runWeb")),
  ),
  plan: canonicalSubcommands("plan", /action !== "slices"\) throw new Error\("plan requires/),
  intelligence: canonicalSubcommands(
    "intelligence",
    /const INTELLIGENCE_ACTIONS = Object\.freeze\(\["[a-z]+", "[a-z]+"\]\)/,
  ),
  worktree: canonicalSubcommands(
    "worktree",
    /!\["plan", "provision", "inspect", "launch", "integration"\]\.includes\(action\)/,
  ),
};

test("nelos's own command surface has the expected shape", () => {
  assert.deepEqual(CANONICAL.commands, [
    "archive",
    "doctor",
    "intelligence",
    "list",
    "plan",
    "read",
    "send",
    "spinoff",
    "start",
    "status",
    "title",
    "watch",
    "web",
    "worktree",
  ]);
  assert.deepEqual(CANONICAL.title, ["get", "set"]);
  assert.deepEqual(CANONICAL.web, ["accept", "begin", "collect", "join", "readiness"]);
  assert.deepEqual(CANONICAL.plan, ["slices"]);
  assert.deepEqual(CANONICAL.intelligence, ["route", "verify"]);
  assert.deepEqual(CANONICAL.worktree, ["inspect", "integration", "launch", "plan", "provision"]);
});

test("bash completion's command and subcommand lists match nelos exactly", () => {
  const commands = sortedSet(bash.match(/_nelos_commands="([^"]*)"/)[1].split(/\s+/));
  const title = sortedSet(bash.match(/_nelos_subcommands_title="([^"]*)"/)[1].split(/\s+/));
  const web = sortedSet(bash.match(/_nelos_subcommands_web="([^"]*)"/)[1].split(/\s+/));
  const plan = sortedSet(bash.match(/_nelos_subcommands_plan="([^"]*)"/)[1].split(/\s+/));
  const intelligence = sortedSet(
    bash.match(/_nelos_subcommands_intelligence="([^"]*)"/)[1].split(/\s+/),
  );
  const worktree = sortedSet(
    bash.match(/_nelos_subcommands_worktree="([^"]*)"/)[1].split(/\s+/),
  );

  assert.deepEqual(commands, CANONICAL.commands);
  assert.deepEqual(title, CANONICAL.title);
  assert.deepEqual(web, CANONICAL.web);
  assert.deepEqual(plan, CANONICAL.plan);
  assert.deepEqual(intelligence, CANONICAL.intelligence);
  assert.deepEqual(worktree, CANONICAL.worktree);
});

test("zsh completion's command and subcommand lists match nelos exactly", () => {
  const commands = sortedSet(zsh.match(/_nelos_commands=\(([^)]*)\)/)[1].split(/\s+/));
  const title = sortedSet(
    zsh.match(/_nelos_subcommands_title=\(([^)]*)\)/)[1].split(/\s+/),
  );
  const web = sortedSet(zsh.match(/_nelos_subcommands_web=\(([^)]*)\)/)[1].split(/\s+/));
  const plan = sortedSet(zsh.match(/_nelos_subcommands_plan=\(([^)]*)\)/)[1].split(/\s+/));
  const intelligence = sortedSet(
    zsh.match(/_nelos_subcommands_intelligence=\(([^)]*)\)/)[1].split(/\s+/),
  );
  const worktree = sortedSet(
    zsh.match(/_nelos_subcommands_worktree=\(([^)]*)\)/)[1].split(/\s+/),
  );

  assert.deepEqual(commands, CANONICAL.commands);
  assert.deepEqual(title, CANONICAL.title);
  assert.deepEqual(web, CANONICAL.web);
  assert.deepEqual(plan, CANONICAL.plan);
  assert.deepEqual(intelligence, CANONICAL.intelligence);
  assert.deepEqual(worktree, CANONICAL.worktree);
});

test("fish completion's top-level command list matches nelos exactly", () => {
  const commands = sortedSet(
    [...fish.matchAll(/__fish_use_subcommand -a (\S+)/g)].map((m) => m[1]),
  );
  assert.deepEqual(commands, CANONICAL.commands);
});

test("fish completion's subcommand lists match nelos exactly", () => {
  const title = sortedSet(
    fish
      .match(/__fish_seen_subcommand_from title;[^\n]*-a '([^']*)'/)[1]
      .split(/\s+/),
  );
  const web = sortedSet(
    fish.match(/__fish_seen_subcommand_from web;[^\n]*-a '([^']*)'/)[1].split(/\s+/),
  );
  const plan = sortedSet(
    fish.match(/__fish_seen_subcommand_from plan;[^\n]*-a (\S+)/)[1].split(/\s+/),
  );
  const intelligence = sortedSet(
    fish
      .match(/__fish_seen_subcommand_from intelligence;[^\n]*-a '([^']*)'/)[1]
      .split(/\s+/),
  );
  const worktree = sortedSet(
    fish.match(/__fish_seen_subcommand_from worktree;[^\n]*-a '([^']*)'/)[1].split(/\s+/),
  );

  assert.deepEqual(title, CANONICAL.title);
  assert.deepEqual(web, CANONICAL.web);
  assert.deepEqual(plan, CANONICAL.plan);
  assert.deepEqual(intelligence, CANONICAL.intelligence);
  assert.deepEqual(worktree, CANONICAL.worktree);
});
