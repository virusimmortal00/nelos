#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

// Generates both supported plugin layouts from the legacy Codex manifest:
//
// - `.codex-plugin/plugin.json` + `.mcp.json` for codex-cli 0.144.6. The
//   launch form remains an inline `node -e` bootstrap because that host does
//   not substitute ${PLUGIN_ROOT}.
// - `plugin.json` + `mcp.json` for Agent Plugins v1. That format injects and
//   expands ${PLUGIN_ROOT}, so it launches the bundled entry point directly.
//
// Keeping both generated MCP identities in one module makes their release
// version and entry-point contract drift together or not at all.

export const MCP_CONFIG_FILENAME = ".mcp.json";
export const AGENT_PLUGIN_MANIFEST_FILENAME = "plugin.json";
export const AGENT_PLUGIN_MCP_CONFIG_FILENAME = "mcp.json";
export const AGENT_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_PLUGIN_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const MCP_PLUGIN_VERSION_ENV = "NELOS_PLUGIN_VERSION";
export const MCP_RELEASE_BUILD_IDENTITY_ENV = "NELOS_RELEASE_BUILD_IDENTITY";
export const MCP_SERVER_CONFIG_KEY = "nelos";

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:\+codex\.[a-z0-9-]+)?$/u;
const RELEASE_BUILD_IDENTITY =
  /^nelos-release-v1:\d+\.\d+\.\d+(?:\+codex\.[a-z0-9-]+)?$/u;

function assertReleaseIdentity(version, releaseBuildIdentity) {
  if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
    throw new Error(`mcp config requires a release version, got: ${version}`);
  }
  if (
    typeof releaseBuildIdentity !== "string" ||
    !RELEASE_BUILD_IDENTITY.test(releaseBuildIdentity)
  ) {
    throw new Error(
      `mcp config requires an embedded release build identity, got: ${releaseBuildIdentity}`,
    );
  }
}

// The bootstrap must stay dependency-free CommonJS (it runs via `node -e`),
// use no template literals (kept trivially embeddable in JSON), and confine
// every cache-layout assumption to this one string.
export function buildMcpBootstrap() {
  return [
    "(async () => {",
    '  const fs = require("node:fs");',
    '  const path = require("node:path");',
    '  const os = require("node:os");',
    '  const { pathToFileURL } = require("node:url");',
    "  const fail = (message) => {",
    '    process.stderr.write("nelos-mcp bootstrap: " + message + "\\n");',
    "    process.exit(1);",
    "  };",
    `  const version = process.env.${MCP_PLUGIN_VERSION_ENV};`,
    `  const releaseBuildIdentity = process.env.${MCP_RELEASE_BUILD_IDENTITY_ENV};`,
    `  if (!version) fail("${MCP_PLUGIN_VERSION_ENV} is missing from the .mcp.json env block");`,
    `  if (!releaseBuildIdentity) fail("${MCP_RELEASE_BUILD_IDENTITY_ENV} is missing from the .mcp.json env block");`,
    '  const cacheRoot = path.join(os.homedir(), ".codex", "plugins", "cache");',
    "  let marketplaces = [];",
    "  try {",
    "    marketplaces = fs.readdirSync(cacheRoot);",
    "  } catch (error) {",
    '    fail("cannot read the plugin cache at " + cacheRoot + ": " + error.message);',
    "  }",
    "  const candidates = [];",
    "  for (const marketplace of marketplaces) {",
    "    const candidate = path.join(",
    '      cacheRoot, marketplace, "nelos", version, "src", "mcp-server.mjs");',
    "    if (fs.existsSync(candidate)) candidates.push(candidate);",
    "  }",
    "  if (candidates.length === 0) {",
    '    fail("no cached nelos " + version + " plugin under " + cacheRoot +',
    '      "; reinstall the nelos plugin so the cached version matches .mcp.json");',
    "  }",
    "  candidates.sort();",
    "  if (candidates.length > 1) {",
    '    fail("multiple cached nelos " + version + " plugins found: " +',
    '      candidates.join(", ") +',
  '      "; keep exactly one installed nelos plugin copy before restarting Codex");',
    "  }",
    "  try {",
    "    const pluginRoot = path.dirname(path.dirname(candidates[0]));",
    '    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));',
    '    const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));',
    "    const configured = mcp.mcpServers && mcp.mcpServers.nelos && mcp.mcpServers.nelos.env;",
    `    if (!configured || manifest.version !== version || configured.${MCP_PLUGIN_VERSION_ENV} !== version || manifest.releaseBuildIdentity !== releaseBuildIdentity || configured.${MCP_RELEASE_BUILD_IDENTITY_ENV} !== releaseBuildIdentity) {`,
    '      fail("cached Nelos identity metadata disagrees; reinstall the Nelos plugin before restarting Codex");',
    "    }",
    "    const serverModule = await import(pathToFileURL(candidates[0]).href);",
    "    serverModule.startNelosMcpServer({ serverVersion: version });",
    "  } catch (error) {",
    '    fail("failed to start " + candidates[0] + ": " + error.message);',
    "  }",
    "})();",
  ].join("\n");
}

export function buildMcpConfig(version, releaseBuildIdentity = `nelos-release-v1:${version}`) {
  assertReleaseIdentity(version, releaseBuildIdentity);
  return {
    mcpServers: {
      [MCP_SERVER_CONFIG_KEY]: {
        command: "node",
        args: ["-e", buildMcpBootstrap()],
        env: { [MCP_PLUGIN_VERSION_ENV]: version, [MCP_RELEASE_BUILD_IDENTITY_ENV]: releaseBuildIdentity },
      },
    },
  };
}

export function renderMcpConfig(version, releaseBuildIdentity) {
  return JSON.stringify(buildMcpConfig(version, releaseBuildIdentity), null, 2) + "\n";
}

export function buildAgentPluginManifest(pluginMetadata) {
  assertReleaseIdentity(
    pluginMetadata?.version,
    pluginMetadata?.releaseBuildIdentity,
  );
  if (pluginMetadata?.name !== "nelos") {
    throw new Error(`agent plugin manifest requires the nelos identity, got: ${pluginMetadata?.name}`);
  }
  return {
    $schema: AGENT_PLUGIN_SCHEMA,
    name: pluginMetadata.name,
    version: pluginMetadata.version,
    description: pluginMetadata.description,
    author: pluginMetadata.author,
    homepage: pluginMetadata.homepage,
    repository: pluginMetadata.repository,
    license: pluginMetadata.license,
    keywords: pluginMetadata.keywords,
  };
}

export function renderAgentPluginManifest(pluginMetadata) {
  return `${JSON.stringify(buildAgentPluginManifest(pluginMetadata), null, 2)}\n`;
}

export function buildAgentPluginMcpConfig(
  version,
  releaseBuildIdentity = `nelos-release-v1:${version}`,
) {
  assertReleaseIdentity(version, releaseBuildIdentity);
  return {
    $schema: AGENT_PLUGIN_MCP_SCHEMA,
    mcpServers: {
      [MCP_SERVER_CONFIG_KEY]: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/bin/nelos-mcp"],
        env: {
          [MCP_PLUGIN_VERSION_ENV]: version,
          [MCP_RELEASE_BUILD_IDENTITY_ENV]: releaseBuildIdentity,
        },
      },
    },
  };
}

export function renderAgentPluginMcpConfig(version, releaseBuildIdentity) {
  return `${JSON.stringify(
    buildAgentPluginMcpConfig(version, releaseBuildIdentity),
    null,
    2,
  )}\n`;
}

export function assertAgentPluginLayout({
  legacyPluginMetadata,
  agentPluginMetadata,
  agentPluginMcpMetadata,
}) {
  const expectedManifest = JSON.parse(renderAgentPluginManifest(legacyPluginMetadata));
  const expectedMcp = JSON.parse(renderAgentPluginMcpConfig(
    legacyPluginMetadata?.version,
    legacyPluginMetadata?.releaseBuildIdentity,
  ));
  if (!isDeepStrictEqual(agentPluginMetadata, expectedManifest)) {
    throw new Error("plugin.json does not match the closed generated Agent Plugins v1 manifest");
  }
  if (!isDeepStrictEqual(agentPluginMcpMetadata, expectedMcp)) {
    throw new Error("mcp.json does not match the closed generated Agent Plugins v1 MCP configuration");
  }
  return true;
}

async function main() {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, ".codex-plugin/plugin.json"), "utf8"),
  );
  const outputs = [
    [
      resolve(packageRoot, MCP_CONFIG_FILENAME),
      renderMcpConfig(manifest.version, manifest.releaseBuildIdentity),
    ],
    [
      resolve(packageRoot, AGENT_PLUGIN_MANIFEST_FILENAME),
      renderAgentPluginManifest(manifest),
    ],
    [
      resolve(packageRoot, AGENT_PLUGIN_MCP_CONFIG_FILENAME),
      renderAgentPluginMcpConfig(manifest.version, manifest.releaseBuildIdentity),
    ],
  ];
  await Promise.all(outputs.map(([target, contents]) => writeFile(target, contents)));
  process.stdout.write(
    `wrote ${outputs.map(([target]) => target).join(", ")} for version ${manifest.version}\n`,
  );
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`generate-mcp-config: ${error.message}\n`);
    process.exitCode = 1;
  });
}
