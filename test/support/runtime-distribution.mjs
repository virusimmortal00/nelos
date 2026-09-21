import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { listDistributionFiles, computeDistributionIntegrity, pluginCacheIdentity, SOURCE_REPOSITORY } from "../../src/distribution-provenance.mjs";
import { buildMcpConfig, renderMcpConfig, renderAgentPluginManifest, renderAgentPluginMcpConfig } from "../../scripts/generate-mcp-config.mjs";
import { McpProcess } from "../../scripts/verify-planning-lifecycle.mjs";

const source = fileURLToPath(new URL("../..", import.meta.url));
export async function runtimeDistribution(root, version, contractOverride = null) {
  for (const path of await listDistributionFiles(source, { includeProvenance: true })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(source, path), join(root, path));
  }
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  pkg.version = version;
  const plugin = JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"));
  plugin.version = version;
  plugin.releaseBuildIdentity = `nelos-release-v1:${version}`;
  for (const [path, value] of [["package.json", pkg], [".codex-plugin/plugin.json", plugin]]) {
    await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  }
  await writeFile(join(root, ".mcp.json"), renderMcpConfig(version));
  await writeFile(join(root, "plugin.json"), renderAgentPluginManifest(plugin));
  await writeFile(join(root, "mcp.json"), renderAgentPluginMcpConfig(version));
  if (contractOverride) await writeFile(join(root, "src/runtime-compatibility.json"), `${JSON.stringify(contractOverride)}\n`);
  const provenance = JSON.parse(await readFile(join(root, "distribution-provenance.json"), "utf8"));
  provenance.revision = version;
  provenance.cacheIdentity = pluginCacheIdentity({ sourceRepository: SOURCE_REPOSITORY, version });
  provenance.integrity = await computeDistributionIntegrity(root);
  await writeFile(join(root, "distribution-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  return root;
}

export function retainedWorker(environment, version) {
  const config = buildMcpConfig(version).mcpServers.nelos;
  return new McpProcess(spawn(process.execPath, config.args, {
    env: { ...environment, ...config.env }, stdio: ["pipe", "pipe", "pipe"],
  }));
}
