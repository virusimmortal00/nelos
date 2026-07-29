import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DISTRIBUTION_ENTRIES } from "../src/distribution-provenance.mjs";
import { listNelosMcpTools } from "../src/mcp-server.mjs";
import {
  MCP_CONFIG_FILENAME,
  MCP_PLUGIN_VERSION_ENV,
  MCP_SERVER_CONFIG_KEY,
  buildMcpConfig,
  renderMcpConfig,
} from "../scripts/generate-mcp-config.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginMetadata = JSON.parse(
  await readFile(join(packageRoot, ".codex-plugin/plugin.json"), "utf8"),
);
const packageMetadata = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);

test("checked-in .mcp.json is fresh for the current plugin version", async () => {
  const onDisk = await readFile(join(packageRoot, MCP_CONFIG_FILENAME), "utf8");
  assert.equal(onDisk, renderMcpConfig(pluginMetadata.version));
});

test("plugin manifest, package metadata, and provenance cover the MCP surface", () => {
  assert.equal(pluginMetadata.mcpServers, `./${MCP_CONFIG_FILENAME}`);
  assert.equal(pluginMetadata.version, packageMetadata.version);
  assert.ok(packageMetadata.files.includes(MCP_CONFIG_FILENAME));
  assert.ok(DISTRIBUTION_ENTRIES.includes(MCP_CONFIG_FILENAME));
});

test("the generated launch form is the verified inline bootstrap", () => {
  const config = buildMcpConfig("1.2.3");
  const server = config[MCP_SERVER_CONFIG_KEY];
  // Pinned to verified codex-cli 0.144.6 behavior (docs/mcp-tool-surface.md):
  // no ${PLUGIN_ROOT} substitution and no plugin path environment variables
  // exist, so the only viable launch form is `node -e` plus a static env
  // version. Loosen only after the host retirement condition is met.
  assert.equal(server.command, "node");
  assert.equal(server.args[0], "-e");
  assert.deepEqual(server.env, { [MCP_PLUGIN_VERSION_ENV]: "1.2.3" });
  assert.deepEqual(
    buildMcpConfig("1.2.3+codex.20260725014918")[MCP_SERVER_CONFIG_KEY].env,
    { [MCP_PLUGIN_VERSION_ENV]: "1.2.3+codex.20260725014918" },
  );
  assert.ok(!server.args[1].includes("${"), "bootstrap must not rely on substitution");
  assert.ok(!server.args[1].includes("`"), "bootstrap must stay embeddable");
  assert.throws(() => buildMcpConfig("not-a-version"));
  assert.throws(() => buildMcpConfig("1.2.3+other.build"));
});

async function bootstrapFixture() {
  const home = await mkdtemp(join(tmpdir(), "nelos-mcp-bootstrap-"));
  const cachedPlugin = join(
    home,
    ".codex",
    "plugins",
    "cache",
    "a-marketplace",
    "nelos",
    pluginMetadata.version,
  );
  await mkdir(cachedPlugin, { recursive: true });
  await cp(join(packageRoot, "src"), join(cachedPlugin, "src"), {
    recursive: true,
  });
  return home;
}

function runBootstrap({ home, version, requests }) {
  const bootstrap = buildMcpConfig(version)[MCP_SERVER_CONFIG_KEY].args[1];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", bootstrap], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        [MCP_PLUGIN_VERSION_ENV]: version,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout
        .split("\n")
        .slice(0, -1)
        .filter((line) => line.trim());
      if (lines.length >= requests.length) child.stdin.end();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
    if (requests.length === 0) child.stdin.end();
  });
}

test("the bootstrap locates the versioned cache and serves the tools", async () => {
  const home = await bootstrapFixture();
  try {
    const { code, stdout } = await runBootstrap({
      home,
      version: pluginMetadata.version,
      requests: [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
    });
    assert.equal(code, 0);
    const responses = stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    assert.deepEqual(responses[0].result.serverInfo, {
      name: "nelos",
      version: pluginMetadata.version,
    });
    assert.equal(
      responses[1].result.tools.length,
      listNelosMcpTools().length,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the bootstrap fails closed with an actionable diagnostic", async () => {
  const home = await bootstrapFixture();
  try {
    const { code, stderr } = await runBootstrap({
      home,
      version: "9.9.9",
      requests: [],
    });
    assert.equal(code, 1);
    assert.match(stderr, /no cached nelos 9\.9\.9 plugin under/);
    assert.match(stderr, /reinstall the nelos plugin/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the bootstrap rejects duplicate cached plugin identities", async () => {
  const home = await bootstrapFixture();
  const first = join(
    home,
    ".codex",
    "plugins",
    "cache",
    "a-marketplace",
    "nelos",
    pluginMetadata.version,
  );
  const duplicate = join(
    home,
    ".codex",
    "plugins",
    "cache",
    "nelos-marketplace",
    "nelos",
    pluginMetadata.version,
  );
  try {
    await mkdir(duplicate, { recursive: true });
    await cp(join(first, "src"), join(duplicate, "src"), { recursive: true });
    const { code, stderr } = await runBootstrap({
      home,
      version: pluginMetadata.version,
      requests: [],
    });
    assert.equal(code, 1);
    assert.match(stderr, /multiple cached nelos .* plugins found/);
    assert.match(stderr, /keep exactly one installed nelos plugin copy/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
