#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Generates the repository-root .mcp.json declared by
// .codex-plugin/plugin.json. The launch form is an inline `node -e`
// bootstrap because the verified codex-cli 0.144.6 host substitutes no
// ${PLUGIN_ROOT} anywhere, sets no plugin path environment variables, and
// starts servers in the task workspace; the bootstrap therefore locates the
// versioned plugin cache itself. Retire it for the documented direct launch
// form once the host implements substitution; see docs/mcp-tool-surface.md.

export const MCP_CONFIG_FILENAME = ".mcp.json";
export const MCP_PLUGIN_VERSION_ENV = "NELOS_PLUGIN_VERSION";
export const MCP_SERVER_CONFIG_KEY = "nelos";

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
    `  if (!version) fail("${MCP_PLUGIN_VERSION_ENV} is missing from the .mcp.json env block");`,
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
    "    const serverModule = await import(pathToFileURL(candidates[0]).href);",
    "    serverModule.startNelosMcpServer({ serverVersion: version });",
    "  } catch (error) {",
    '    fail("failed to start " + candidates[0] + ": " + error.message);',
    "  }",
    "})();",
  ].join("\n");
}

export function buildMcpConfig(version) {
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:\+codex\.[a-z0-9-]+)?$/u.test(version)
  ) {
    throw new Error(`mcp config requires a release version, got: ${version}`);
  }
  return {
    [MCP_SERVER_CONFIG_KEY]: {
      command: "node",
      args: ["-e", buildMcpBootstrap()],
      env: { [MCP_PLUGIN_VERSION_ENV]: version },
    },
  };
}

export function renderMcpConfig(version) {
  return JSON.stringify(buildMcpConfig(version), null, 2) + "\n";
}

async function main() {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, ".codex-plugin/plugin.json"), "utf8"),
  );
  const target = resolve(packageRoot, MCP_CONFIG_FILENAME);
  await writeFile(target, renderMcpConfig(manifest.version));
  process.stdout.write(`wrote ${target} for version ${manifest.version}\n`);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`generate-mcp-config: ${error.message}\n`);
    process.exitCode = 1;
  });
}
