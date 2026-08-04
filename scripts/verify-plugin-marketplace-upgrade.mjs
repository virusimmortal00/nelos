#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { openAppServerClient } from "../src/app-server-client.mjs";
import {
  RUNTIME_UPGRADE_MATRIX_V1,
  RUNTIME_UPGRADE_RECOVERY_ACTION,
} from "../src/runtime-lifecycle.mjs";

import {
  DISTRIBUTION_ENTRIES,
  PROVENANCE_FILENAME,
  computeDistributionIntegrity,
  pluginCacheIdentity,
} from "../src/distribution-provenance.mjs";
import { materializeMarketplaceProvenance } from "./validate-marketplace-promotion.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return result.stdout.trim();
}

async function git(root, ...args) {
  return run("git", args, { cwd: root });
}

async function sha256(path) {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createLegacySource(root) {
  await writeJson(join(root, ".agents", "plugins", "marketplace.json"), {
    name: "upgrade-fixture",
    plugins: [{
      name: "nelos",
      source: { source: "local", path: "./" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    }],
  });
  await writeJson(join(root, ".codex-plugin", "plugin.json"), {
    name: "nelos",
    version: "0.4.0",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
  });
  await writeJson(join(root, ".mcp.json"), {
    nelos: {
      command: "node",
      args: ["src/mcp-server.mjs"],
      env: { NELOS_PLUGIN_VERSION: "0.4.0" },
    },
  });
  await mkdir(join(root, "skills", "manage-nelos-tasks"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "skills", "manage-nelos-tasks", "SKILL.md"),
    "---\nname: manage-nelos-tasks\ndescription: legacy fixture\n---\nlegacy-0.4.0\n",
  );
  await writeFile(join(root, "src", "mcp-server.mjs"), "export const marker = 'legacy-0.4.0';\n");
  await writeJson(join(root, PROVENANCE_FILENAME), {
    schemaVersion: 1,
    distribution: "nelos",
    revision: "0.4.0",
  });
}

async function replaceWithCandidate(root) {
  for (const entry of await readdir(root)) {
    if (entry !== ".git") await rm(join(root, entry), { recursive: true, force: true });
  }
  for (const entry of DISTRIBUTION_ENTRIES) {
    await cp(join(repositoryRoot, entry), join(root, entry), { recursive: true });
  }
  await cp(
    join(repositoryRoot, ".agents"),
    join(root, ".agents"),
    { recursive: true },
  );
  const marketplacePath = join(root, ".agents", "plugins", "marketplace.json");
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  await writeJson(marketplacePath, { ...marketplace, name: "upgrade-fixture" });
  const provenance = JSON.parse(
    await readFile(join(repositoryRoot, PROVENANCE_FILENAME), "utf8"),
  );
  await writeJson(join(root, PROVENANCE_FILENAME), provenance);
}

async function startDumbGitServer(serverRoot) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const requested = resolve(serverRoot, `.${normalize(pathname)}`);
      const rel = relative(serverRoot, requested);
      if (rel.startsWith("..") || rel === "") {
        response.writeHead(404).end();
        return;
      }
      const info = await stat(requested);
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const contentType = extname(requested) === ".json"
        ? "application/json"
        : "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": info.size,
      });
      response.end(await readFile(requested));
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  return server;
}

async function freshProcessProbe({ installedPath, candidateRoot, expectedVersion }) {
  const files = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "skills/manage-nelos-tasks/SKILL.md",
    "src/mcp-server.mjs",
    PROVENANCE_FILENAME,
  ];
  const expected = Object.fromEntries(
    await Promise.all(files.map(async (path) => [path, await sha256(join(candidateRoot, path))])),
  );
  const probe = `
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { pathToFileURL } = require("node:url");
    (async () => {
    const root = process.argv[1];
    const expected = JSON.parse(process.argv[2]);
    const hash = (path) => "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
    for (const [path, digest] of Object.entries(expected)) {
      if (hash(join(root, path)) !== digest) throw new Error("candidate mismatch: " + path);
    }
    const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json")));
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json")));
    const provenance = JSON.parse(readFileSync(join(root, "distribution-provenance.json")));
    const expectedVersion = process.argv[3];
    const configured = (mcp.mcpServers && mcp.mcpServers.nelos) || mcp.nelos;
    if (manifest.version !== expectedVersion || !configured || configured.env.NELOS_PLUGIN_VERSION !== expectedVersion) throw new Error("fresh process loaded a stale version");
    if (expectedVersion !== "0.4.0") {
      if (!provenance.sourceRepository || !provenance.sourceRevision || !provenance.cacheIdentity) throw new Error("fresh process lacks provenance");
      const module = await import(pathToFileURL(join(root, "src/mcp-server.mjs")).href);
      if (typeof module.startNelosMcpServer !== "function") throw new Error("fresh process cannot load candidate MCP server");
    }
    process.stdout.write(JSON.stringify({ pid: process.pid, version: manifest.version, cacheIdentity: provenance.cacheIdentity }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  return JSON.parse(await run(
    process.execPath,
    ["-e", probe, installedPath, JSON.stringify(expected), expectedVersion],
  ));
}

async function waitForSocket(path, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`fresh Codex app-server exited before startup: ${stderr.value.trim()}`);
    }
    try {
      if ((await stat(path)).isSocket()) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error("fresh Codex app-server did not create its control socket");
}

async function verifyFreshCodexTask({
  codexCommand,
  env,
  expectedVersion,
  marketplacePath,
}) {
  const socketBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const socketRoot = await mkdtemp(join(socketBase, "npu-"));
  const socketPath = join(socketRoot, `${randomUUID().slice(0, 8)}.sock`);
  const stderr = { value: "" };
  const child = spawn(
    codexCommand,
    ["app-server", "--listen", `unix://${socketPath}`],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr.value += chunk; });
  let client;
  try {
    await waitForSocket(socketPath, child, stderr);
    client = await openAppServerClient({
      clientName: "nelos-upgrade-verifier",
      clientTitle: "Nelos Upgrade Verifier",
      socketPath,
      timeoutMs: 5_000,
    });
    const plugin = await client.request("plugin/read", {
      marketplacePath,
      pluginName: "nelos",
    });
    const summary = plugin?.plugin?.summary;
    if (
      summary?.id !== "nelos@upgrade-fixture" ||
      summary?.localVersion !== expectedVersion ||
      summary?.installed !== true ||
      summary?.enabled !== true
    ) {
      throw new Error(
        `fresh Codex app-server did not activate nelos@upgrade-fixture ${expectedVersion}`,
      );
    }
    const started = await client.request("thread/start", {
      cwd: repositoryRoot,
      approvalPolicy: "never",
      ephemeral: true,
      serviceName: "nelos-upgrade-verifier",
      threadSource: "nelos-upgrade-verifier",
      sandbox: "read-only",
    });
    if (!started?.thread?.id) {
      throw new Error("fresh Codex app-server did not create a verification task");
    }
    return { taskId: started.thread.id, appServerPid: child.pid };
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((accept) => child.once("exit", accept)),
      new Promise((accept) => setTimeout(accept, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(socketRoot, { recursive: true, force: true });
  }
}

export async function verifyPluginMarketplaceUpgrade({ codexCommand = "codex" } = {}) {
  const candidateVersion = JSON.parse(
    await readFile(join(repositoryRoot, ".codex-plugin", "plugin.json"), "utf8"),
  ).version;
  const root = await mkdtemp(join(tmpdir(), "nelos-marketplace-upgrade-"));
  const sourceRoot = join(root, "source");
  const bareRoot = join(root, "served", "nelos-upgrade.git");
  const isolatedHome = join(root, "home");
  const codexHome = join(isolatedHome, ".codex");
  let server;
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await git(sourceRoot, "init", "-b", "stable");
    await git(sourceRoot, "config", "user.name", "Nelos Upgrade Fixture");
    await git(sourceRoot, "config", "user.email", "fixture@example.invalid");
    await createLegacySource(sourceRoot);
    await git(sourceRoot, "add", ".");
    await git(sourceRoot, "commit", "-m", "legacy 0.4.0");
    const legacyRevision = await git(sourceRoot, "rev-parse", "HEAD");
    await mkdir(dirname(bareRoot), { recursive: true });
    await run("git", ["clone", "--bare", sourceRoot, bareRoot]);
    await git(bareRoot, "update-server-info");
    server = await startDumbGitServer(dirname(bareRoot));
    const address = server.address();
    const marketplaceUrl = `http://127.0.0.1:${address.port}/${basename(bareRoot)}`;
    const env = { ...process.env, HOME: isolatedHome, CODEX_HOME: codexHome };
    const added = JSON.parse(await run(
      codexCommand,
      ["plugin", "marketplace", "add", marketplaceUrl, "--ref", "stable", "--json"],
      { env },
    ));
    const marketplaceName = added.name ?? added.marketplaceName ?? "nelos-upgrade";
    const legacyInstall = JSON.parse(await run(
      codexCommand,
      ["plugin", "add", `nelos@${marketplaceName}`, "--json"],
      { env },
    ));
    const legacyProbe = await freshProcessProbe({
      installedPath: legacyInstall.installedPath,
      candidateRoot: sourceRoot,
      expectedVersion: "0.4.0",
    });
    const unrelatedCache = join(codexHome, "plugins", "cache", "unrelated", "user-data");
    await mkdir(dirname(unrelatedCache), { recursive: true });
    await writeFile(unrelatedCache, "keep\n");

    await replaceWithCandidate(sourceRoot);
    await git(sourceRoot, "add", ".");
    await git(sourceRoot, "commit", "-m", `candidate ${candidateVersion}`);
    const candidateRevision = await git(sourceRoot, "rev-parse", "HEAD");
    const candidateProvenancePath = join(sourceRoot, PROVENANCE_FILENAME);
    const candidateProvenance = JSON.parse(
      await readFile(candidateProvenancePath, "utf8"),
    );
    await writeJson(
      candidateProvenancePath,
      materializeMarketplaceProvenance(candidateProvenance, candidateRevision),
    );
    await git(sourceRoot, "add", PROVENANCE_FILENAME);
    await git(sourceRoot, "commit", "-m", "record candidate provenance");
    const marketplaceRevision = await git(sourceRoot, "rev-parse", "HEAD");
    await git(sourceRoot, "remote", "add", "fixture", bareRoot);
    await git(sourceRoot, "push", "fixture", "stable");
    await git(bareRoot, "update-server-info");

    await run(
      codexCommand,
      ["plugin", "marketplace", "upgrade", marketplaceName, "--json"],
      { env },
    );
    const candidateInstall = JSON.parse(await run(
      codexCommand,
      ["plugin", "add", `nelos@${marketplaceName}`, "--json"],
      { env },
    ));
    const freshProbe = await freshProcessProbe({
      installedPath: candidateInstall.installedPath,
      candidateRoot: sourceRoot,
      expectedVersion: candidateVersion,
    });
    const freshTask = await verifyFreshCodexTask({
      codexCommand,
      env,
      expectedVersion: candidateVersion,
      marketplacePath: join(
        added.installedRoot,
        ".agents",
        "plugins",
        "marketplace.json",
      ),
    });
    let legacyCacheRemoved = false;
    try {
      await stat(legacyInstall.installedPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      legacyCacheRemoved = true;
    }
    if (!legacyCacheRemoved) {
      throw new Error(`legacy plugin cache survived upgrade: ${legacyInstall.installedPath}`);
    }
    if (await readFile(unrelatedCache, "utf8") !== "keep\n") {
      throw new Error("marketplace upgrade changed unrelated cache data");
    }
    const installedIntegrity = await computeDistributionIntegrity(candidateInstall.installedPath);
    const candidateIntegrity = await computeDistributionIntegrity(sourceRoot);
    if (installedIntegrity !== candidateIntegrity) {
      throw new Error("installed candidate integrity differs from refreshed marketplace source");
    }
    const listing = JSON.parse(await run(
      codexCommand,
      ["plugin", "list", "--available", "--json"],
      { env },
    ));
    const active = listing.installed.find(
      (entry) => entry.pluginId === `nelos@${marketplaceName}`,
    );
    if (active?.version !== candidateVersion || freshProbe.pid === process.pid) {
      throw new Error("fresh Codex process did not resolve the candidate plugin");
    }
    return {
      verified: true,
      marketplaceName,
      legacyVersion: legacyInstall.version,
      candidateVersion: candidateInstall.version,
      legacyRevision,
      candidateRevision,
      marketplaceRevision,
      processRestarted: freshProbe.pid !== legacyProbe.pid,
      freshTaskVerified: true,
      freshTaskId: freshTask.taskId,
      freshCodexPid: freshTask.appServerPid,
      legacyCacheRemoved,
      unrelatedDataPreserved: true,
      candidateIntegrity,
      cacheIdentity: pluginCacheIdentity({ version: candidateVersion }),
      upgradeLifecycleMatrix: RUNTIME_UPGRADE_MATRIX_V1,
      // This verifier owns the fresh app-server it starts, but no live server
      // spans the fixture's cache replacement. Therefore reload is neither
      // required nor falsely claimed; the tested transition is full restart.
      hostReload: { attempted: false, reason: "no owned live MCP child across replacement" },
      hostOwnedSiblingFallback: RUNTIME_UPGRADE_RECOVERY_ACTION,
    };
  } finally {
    if (server) await new Promise((accept) => server.close(accept));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPluginMarketplaceUpgrade()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`verify-plugin-marketplace-upgrade: ${error.message}\n`);
      process.exitCode = 1;
    });
}
