import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parse: parseToml } = require("./vendor/smol-toml-1.6.0.cjs");

export const BUNDLED_MCP_SERVER = "nelos";
export const MAX_MCP_INSPECTION_BYTES = 1_048_576;

function enablementBlock(selector, server) {
  return `[plugins.${JSON.stringify(selector)}.mcp_servers.${JSON.stringify(server)}]\nenabled = true`;
}

function result(state, selector, server, detail) {
  const recovery =
    state === "disabled"
      ? enablementBlock(selector, server)
      : ["healthy", "host-default"].includes(state)
        ? null
        : `Run \`codex plugin add ${selector}\` to reinstall the bundled server.`;
  return { state, detail, recovery };
}

export function missingBundledMcpState(
  selector,
  server = BUNDLED_MCP_SERVER,
) {
  return result(
    "missing",
    selector,
    server,
    "bundled server metadata is missing",
  );
}

async function readBoundedRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MCP_INSPECTION_BYTES) {
    throw new Error("file is not a bounded regular file");
  }
  if ((await realpath(path)) !== resolve(path)) {
    throw new Error("file path is not canonical");
  }
  return readFile(path, "utf8");
}

function inspectEnablement(text, selector, server) {
  try {
    const config = parseToml(text);
    const plugins = config.plugins;
    const plugin = plugins?.[selector];
    const servers = plugin?.mcp_servers;
    const descriptor = servers?.[server];
    for (const value of [plugins, plugin, servers, descriptor]) {
      if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
        return { enabled: null, malformed: true };
      }
    }
    for (const value of [plugin?.enabled, descriptor?.enabled]) {
      if (value !== undefined && typeof value !== "boolean") return { enabled: null, malformed: true };
    }
    if (plugin?.enabled === false) return { enabled: false, malformed: false, disabledBy: "plugin" };
    if (descriptor?.enabled === false) return { enabled: false, malformed: false, disabledBy: "server" };
    return { enabled: descriptor?.enabled === true ? true : null, malformed: false };
  } catch {
    // TOML parser errors can contain user configuration; never return them.
    return { enabled: null, malformed: true };
  }
}

function hostDefaultState(selector, server) {
  return result("host-default", selector, server,
    "bundled server metadata is valid; enablement follows Codex host defaults (no explicit override)");
}

export async function inspectBundledMcpState({
  pluginRoot,
  selector,
  expectedVersion,
  configPath,
  server = BUNDLED_MCP_SERVER,
}) {
  const reinstall = () =>
    result("incompatible", selector, server, "bundled server metadata is incompatible");
  let metadata;
  try {
    metadata = JSON.parse(await readBoundedRegularFile(join(pluginRoot, ".mcp.json")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return missingBundledMcpState(selector, server);
    }
    return reinstall();
  }
  // Current generated plugin metadata uses the standard `mcpServers` wrapper.
  // Retain the legacy direct map only for inspection of older installed
  // releases during upgrade and rollback diagnostics.
  const declarations = metadata?.mcpServers ?? metadata;
  if (!Object.hasOwn(declarations ?? {}, server)) {
    return result("missing", selector, server, "bundled server declaration is missing");
  }
  const descriptor = declarations[server];
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor) ||
    typeof descriptor.command !== "string" ||
    descriptor.command.length === 0 ||
    !Array.isArray(descriptor.args) ||
    !descriptor.args.every((argument) => typeof argument === "string") ||
    descriptor.env?.NELOS_PLUGIN_VERSION !== expectedVersion
  ) {
    return reinstall();
  }

  let config;
  try {
    config = await readBoundedRegularFile(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return hostDefaultState(selector, server);
    }
    return result("incompatible", selector, server, "Codex MCP enablement is incompatible");
  }
  const enablement = inspectEnablement(config, selector, server);
  if (enablement.malformed) {
    return result("incompatible", selector, server, "Codex MCP enablement is incompatible");
  }
  if (enablement.enabled === false) {
    const disabled = result("disabled", selector, server, "bundled server is explicitly disabled");
    if (enablement.disabledBy === "plugin") {
      disabled.recovery = `[plugins.${JSON.stringify(selector)}]\nenabled = true`;
    }
    return disabled;
  }
  if (enablement.enabled === null) return hostDefaultState(selector, server);
  return result("healthy", selector, server, "bundled server is installed, compatible, and enabled");
}

export const bundledMcpStateInternals = Object.freeze({
  enablementBlock,
  inspectEnablement,
});
