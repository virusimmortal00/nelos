import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_MCP_INSPECTION_BYTES,
  inspectBundledMcpState,
} from "../src/bundled-mcp-state.mjs";

const selector = "nelos@fixture-marketplace";
const version = "1.2.3+fixture";
const block =
  '[plugins."nelos@fixture-marketplace".mcp_servers."nelos"]\nenabled = true';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nelos-mcp-state-"));
  const pluginRoot = join(root, "plugin");
  const configPath = join(root, "config.toml");
  await mkdir(pluginRoot);
  const writeMetadata = (value) =>
    writeFile(join(pluginRoot, ".mcp.json"), `${JSON.stringify(value)}\n`);
  await writeMetadata({
    nelos: {
      command: "node",
      args: ["-e", "process.exit(0)"],
      env: { NELOS_PLUGIN_VERSION: version },
    },
  });
  return { root, pluginRoot, configPath, writeMetadata };
}

async function inspect(paths) {
  return inspectBundledMcpState({
    pluginRoot: paths.pluginRoot,
    selector,
    expectedVersion: version,
    configPath: paths.configPath,
  });
}

test("bundled MCP inspection distinguishes missing, disabled, incompatible, and healthy", async () => {
  const paths = await fixture();
  try {
    await rm(join(paths.pluginRoot, ".mcp.json"));
    const missing = await inspect(paths);
    assert.equal(missing.state, "missing");
    assert.equal(missing.recovery, `Run \`codex plugin add ${selector}\` to reinstall the bundled server.`);

    await paths.writeMetadata({
      nelos: {
        command: "node",
        args: [],
        env: { NELOS_PLUGIN_VERSION: version },
      },
    });
    const disabled = await inspect(paths);
    assert.equal(disabled.state, "disabled");
    assert.equal(disabled.recovery, block);

    await writeFile(paths.configPath, `${block}\n`);
    await paths.writeMetadata({
      nelos: {
        command: "node",
        args: [],
        env: { NELOS_PLUGIN_VERSION: "wrong" },
      },
    });
    const incompatible = await inspect(paths);
    assert.equal(incompatible.state, "incompatible");
    assert.ok(incompatible.recovery);

    await paths.writeMetadata({
      nelos: {
        command: "node",
        args: [],
        env: { NELOS_PLUGIN_VERSION: version },
      },
    });
    const healthy = await inspect(paths);
    assert.equal(healthy.state, "healthy");
    assert.equal(healthy.recovery, null);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("bundled MCP inspection is bounded and never returns adversarial contents", async () => {
  const paths = await fixture();
  const secret = "DO_NOT_ECHO_TOKEN_7f9c";
  try {
    await writeFile(paths.configPath, `${block}\nenabled = "${secret}"\n`);
    let state = await inspect(paths);
    assert.equal(state.state, "incompatible");
    assert.doesNotMatch(JSON.stringify(state), new RegExp(secret));

    await writeFile(paths.configPath, "x".repeat(MAX_MCP_INSPECTION_BYTES + 1));
    state = await inspect(paths);
    assert.equal(state.state, "incompatible");
    assert.doesNotMatch(JSON.stringify(state), /xxx/u);

    const target = join(paths.root, "secret-config");
    await writeFile(target, secret);
    await rm(paths.configPath);
    await symlink(target, paths.configPath);
    state = await inspect(paths);
    assert.equal(state.state, "incompatible");
    assert.doesNotMatch(JSON.stringify(state), new RegExp(secret));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
