import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export const BUNDLED_MCP_SERVER = "nelos";
export const MAX_MCP_INSPECTION_BYTES = 1_048_576;

function enablementBlock(selector, server) {
  return `[plugins.${JSON.stringify(selector)}.mcp_servers.${JSON.stringify(server)}]\nenabled = true`;
}

function result(state, selector, server, detail) {
  const recovery =
    state === "disabled"
      ? enablementBlock(selector, server)
      : state === "healthy"
        ? null
        : `Run \`codex plugin add ${selector}\` to reinstall the bundled server.`;
  return { state, detail, recovery };
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
  const expectedHeader =
    `[plugins.${JSON.stringify(selector)}.mcp_servers.${JSON.stringify(server)}]`;
  const lines = text.split(/\r?\n/u);
  let inTarget = false;
  let targetCount = 0;
  let enabled = null;
  let malformed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inTarget = trimmed === expectedHeader;
      if (inTarget) {
        targetCount += 1;
        if (targetCount > 1) malformed = true;
      }
      continue;
    }
    if (!inTarget || trimmed === "" || trimmed.startsWith("#")) continue;
    const assignment = /^enabled\s*=\s*(true|false)\s*(?:#.*)?$/u.exec(trimmed);
    if (assignment) {
      if (enabled !== null) malformed = true;
      enabled = assignment[1] === "true";
    } else if (/^enabled\b/u.test(trimmed)) {
      malformed = true;
    }
  }
  return { enabled: targetCount === 1 && enabled === true, malformed };
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
      return result("missing", selector, server, "bundled server metadata is missing");
    }
    return reinstall();
  }
  if (!Object.hasOwn(metadata ?? {}, server)) {
    return result("missing", selector, server, "bundled server declaration is missing");
  }
  const descriptor = metadata[server];
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
      return result("disabled", selector, server, "bundled server is not enabled");
    }
    return result("incompatible", selector, server, "Codex MCP enablement is incompatible");
  }
  const enablement = inspectEnablement(config, selector, server);
  if (enablement.malformed) {
    return result("incompatible", selector, server, "Codex MCP enablement is incompatible");
  }
  if (!enablement.enabled) {
    return result("disabled", selector, server, "bundled server is not enabled");
  }
  return result("healthy", selector, server, "bundled server is installed, compatible, and enabled");
}

export const bundledMcpStateInternals = Object.freeze({
  enablementBlock,
  inspectEnablement,
});
