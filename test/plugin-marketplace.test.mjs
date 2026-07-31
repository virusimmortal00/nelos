import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const marketplacePath = new URL("../.agents/plugins/marketplace.json", import.meta.url);
const manifestPath = new URL("../.codex-plugin/plugin.json", import.meta.url);

test("the repository marketplace exposes the root Nelos plugin", async () => {
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = marketplace.plugins.find(({ name }) => name === manifest.name);

  assert.equal(marketplace.name, "nelos-marketplace");
  assert.equal(marketplace.interface.displayName, "Nelos Marketplace");
  assert.deepEqual(entry, {
    name: "nelos",
    source: { source: "local", path: "./" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  });
});

test("the plugin manifest declares bundled light and dark spider assets", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { composerIcon, logo, logoDark } = manifest.interface;

  assert.equal(composerIcon, "./assets/nelos-spider-icon.png");
  assert.equal(logo, composerIcon);
  assert.equal(logoDark, "./assets/nelos-spider-icon-dark.png");
  await access(new URL(`../${composerIcon.slice(2)}`, import.meta.url));
  await access(new URL(`../${logoDark.slice(2)}`, import.meta.url));
});

test("the plugin manifest offers three distinct showcase prompts within UI limits", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const prompts = manifest.interface.defaultPrompt;

  assert.deepEqual(prompts, [
    "Use Nelos to ship team roles across the API, UI, migration, tests, and docs. Plan safe waves and verify every result.",
    "Inspect this Nelos web. Show current orchestration, native task status, topology, and anything needing attention.",
    "Use Nelos to modernize our billing module safely. Map dependencies, parallelize independent changes, and verify the migration.",
  ]);
  assert.equal(new Set(prompts).size, prompts.length);
  assert.ok(prompts.every((prompt) => prompt.length <= 128 && !/[\r\n]/u.test(prompt)));
});
