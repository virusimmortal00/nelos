import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  DISTRIBUTION_ENTRIES,
} from "../src/distribution-provenance.mjs";
import { listNelosMcpTools } from "../src/mcp-server.mjs";
import {
  AGENT_PLUGIN_MANIFEST_FILENAME,
  AGENT_PLUGIN_MCP_CONFIG_FILENAME,
  AGENT_PLUGIN_MCP_SCHEMA,
  AGENT_PLUGIN_SCHEMA,
  MCP_PLUGIN_VERSION_ENV,
  MCP_RELEASE_BUILD_IDENTITY_ENV,
  assertAgentPluginLayout,
  buildAgentPluginManifest,
  renderAgentPluginManifest,
  renderAgentPluginMcpConfig,
} from "../scripts/generate-mcp-config.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(join(packageRoot, path), "utf8"));
}

test("Agent Plugins v1 files are generated from the legacy release identity", async () => {
  const [legacy, agentText, agentMcpText, packageMetadata, lock, provenance] =
    await Promise.all([
      readJson(".codex-plugin/plugin.json"),
      readFile(join(packageRoot, AGENT_PLUGIN_MANIFEST_FILENAME), "utf8"),
      readFile(join(packageRoot, AGENT_PLUGIN_MCP_CONFIG_FILENAME), "utf8"),
      readJson("package.json"),
      readJson("package-lock.json"),
      readJson("distribution-provenance.json"),
    ]);
  const agent = JSON.parse(agentText);
  const agentMcp = JSON.parse(agentMcpText);
  const server = agentMcp.mcpServers.nelos;

  assert.equal(agentText, renderAgentPluginManifest(legacy));
  assert.equal(
    agentMcpText,
    renderAgentPluginMcpConfig(legacy.version, legacy.releaseBuildIdentity),
  );
  assert.equal(agent.$schema, AGENT_PLUGIN_SCHEMA);
  assert.equal(agentMcp.$schema, AGENT_PLUGIN_MCP_SCHEMA);
  assert.equal(agent.name, legacy.name);
  assert.equal(agent.version, legacy.version);
  assert.equal(agent.version, packageMetadata.version);
  assert.equal(agent.version, lock.version);
  assert.equal(agent.version, lock.packages[""].version);
  assert.equal(agent.version, provenance.revision);
  assert.deepEqual(server, {
    type: "stdio",
    command: "node",
    args: ["${PLUGIN_ROOT}/bin/nelos-mcp"],
    env: {
      [MCP_PLUGIN_VERSION_ENV]: legacy.version,
      [MCP_RELEASE_BUILD_IDENTITY_ENV]: legacy.releaseBuildIdentity,
    },
  });
  assert.throws(
    () => buildAgentPluginManifest({ ...legacy, name: "another-plugin" }),
    /requires the nelos identity/u,
  );
  assert.equal(assertAgentPluginLayout({
    legacyPluginMetadata: legacy,
    agentPluginMetadata: agent,
    agentPluginMcpMetadata: agentMcp,
  }), true);
  for (const [candidateAgent, candidateMcp] of [
    [{ ...agent, $schema: "https://example.invalid/plugin.schema.json" }, agentMcp],
    [{ ...agent, name: "another-plugin" }, agentMcp],
    [{ ...agent, unsupported: true }, agentMcp],
    [agent, { ...agentMcp, $schema: "https://example.invalid/mcp.schema.json" }],
    [agent, { ...agentMcp, unsupported: true }],
    [agent, {
      ...agentMcp,
      mcpServers: {
        nelos: { ...server, type: "http" },
      },
    }],
    [agent, {
      ...agentMcp,
      mcpServers: {
        nelos: { ...server, command: "sh" },
      },
    }],
    [agent, {
      ...agentMcp,
      mcpServers: {
        nelos: { ...server, args: ["${PLUGIN_ROOT}/bin/another-entrypoint"] },
      },
    }],
    [agent, {
      ...agentMcp,
      mcpServers: {
        nelos: {
          ...server,
          env: { ...server.env, PLUGIN_ROOT: "/unsafe" },
        },
      },
    }],
    [agent, {
      ...agentMcp,
      mcpServers: {
        nelos: {
          ...server,
          env: { ...server.env, PLUGIN_DATA: "/unsafe" },
        },
      },
    }],
  ]) {
    assert.throws(
      () => assertAgentPluginLayout({
        legacyPluginMetadata: legacy,
        agentPluginMetadata: candidateAgent,
        agentPluginMcpMetadata: candidateMcp,
      }),
      /does not match the closed generated Agent Plugins v1/u,
    );
  }
});

test("npm and provenance payloads contain both plugin layouts", async () => {
  const packageMetadata = await readJson("package.json");
  for (const entry of [
    ".codex-plugin/",
    ".mcp.json",
    AGENT_PLUGIN_MANIFEST_FILENAME,
    AGENT_PLUGIN_MCP_CONFIG_FILENAME,
  ]) {
    assert.ok(packageMetadata.files.includes(entry), `package files missing ${entry}`);
  }
  for (const entry of [
    ".codex-plugin",
    ".mcp.json",
    AGENT_PLUGIN_MANIFEST_FILENAME,
    AGENT_PLUGIN_MCP_CONFIG_FILENAME,
  ]) {
    assert.ok(DISTRIBUTION_ENTRIES.includes(entry), `provenance missing ${entry}`);
  }
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const files = new Set(JSON.parse(stdout)[0].files.map(({ path }) => path));
  for (const path of [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "plugin.json",
    "mcp.json",
    "bin/nelos-mcp",
  ]) {
    assert.ok(files.has(path), `packed payload missing ${path}`);
  }
  await access(join(packageRoot, "bin", "nelos-mcp"), constants.X_OK);
});

function runAgentPluginServer({ home, pluginData, server, requests }) {
  const pluginRoot = packageRoot;
  const args = server.args.map((argument) =>
    argument.replaceAll("${PLUGIN_ROOT}", pluginRoot)
      .replaceAll("${PLUGIN_DATA}", pluginData));
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, args, {
      cwd: pluginRoot,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
        PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: pluginData,
        ...server.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdinClosed = false;
    child.once("error", reject);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const completeLines = stdout
        .split("\n")
        .slice(0, -1)
        .filter((line) => line.trim());
      if (!stdinClosed && completeLines.length >= requests.length) {
        stdinClosed = true;
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (status) => resolve({ status, stdout, stderr }));
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

test("the Agent Plugins direct entry point serves the packaged Nelos surface", async () => {
  const home = await mkdtemp(join(tmpdir(), "nelos-agent-plugin-home-"));
  const pluginData = join(home, "plugin-data");
  try {
    const mcp = await readJson(AGENT_PLUGIN_MCP_CONFIG_FILENAME);
    const { status, stdout, stderr } = await runAgentPluginServer({
      home,
      pluginData,
      server: mcp.mcpServers.nelos,
      requests: [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "agent-plugin-layout-test", version: "0" },
          },
        },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
    });
    assert.equal(status, 0, stderr);
    const responses = stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const manifest = await readJson(AGENT_PLUGIN_MANIFEST_FILENAME);
    assert.deepEqual(responses[0].result.serverInfo, {
      name: "nelos",
      version: manifest.version,
    });
    assert.deepEqual(
      responses[1].result.tools.map(({ name }) => name),
      listNelosMcpTools().map(({ name }) => name),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
