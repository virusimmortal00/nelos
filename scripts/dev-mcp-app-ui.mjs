#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXECUTION_MAP_FIXTURES,
  MCP_APP_FIXTURE_PORT,
} from "./mcp-app-fixture-server.mjs";

export const MCP_APPS_UPSTREAM_REPOSITORY =
  "https://github.com/modelcontextprotocol/ext-apps.git";
export const MCP_APPS_UPSTREAM_COMMIT =
  "92f46a574568a3ddac7600343b7d3c4c4ed7b588";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixturePort = Number.parseInt(
  process.env.NELOS_MCP_APP_FIXTURE_PORT ?? String(MCP_APP_FIXTURE_PORT),
  10,
);
const hostPort = Number.parseInt(
  process.env.NELOS_MCP_APP_HOST_PORT ?? "8180",
  10,
);
const sandboxPort = Number.parseInt(
  process.env.NELOS_MCP_APP_SANDBOX_PORT ?? "8181",
  10,
);
const cacheRoot = resolve(
  process.env.NELOS_MCP_APP_HOST_CACHE_DIR ??
    join(tmpdir(), "nelos-mcp-app-basic-host"),
);
const basicHostRoot = join(cacheRoot, MCP_APPS_UPSTREAM_COMMIT);
const markerPath = join(basicHostRoot, ".nelos-upstream.json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited ${result.status}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function markerIsCurrent() {
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    return (
      marker.repository === MCP_APPS_UPSTREAM_REPOSITORY &&
      marker.commit === MCP_APPS_UPSTREAM_COMMIT
    );
  } catch {
    return false;
  }
}

async function prepareBasicHost() {
  if (await markerIsCurrent()) return basicHostRoot;

  await mkdir(cacheRoot, { recursive: true });
  const stageRoot = await mkdtemp(join(cacheRoot, ".prepare-"));
  const checkoutRoot = join(stageRoot, "ext-apps");
  const stagedHostRoot = join(stageRoot, "basic-host");
  try {
    run("git", ["init", checkoutRoot]);
    run("git", [
      "-C",
      checkoutRoot,
      "fetch",
      "--depth",
      "1",
      MCP_APPS_UPSTREAM_REPOSITORY,
      MCP_APPS_UPSTREAM_COMMIT,
    ]);
    run("git", ["-C", checkoutRoot, "checkout", "--detach", "FETCH_HEAD"]);
    const resolvedCommit = spawnSync(
      "git",
      ["-C", checkoutRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).stdout.trim();
    if (resolvedCommit !== MCP_APPS_UPSTREAM_COMMIT) {
      throw new Error(
        `basic-host checkout resolved ${resolvedCommit}, expected ${MCP_APPS_UPSTREAM_COMMIT}`,
      );
    }

    await cp(
      join(checkoutRoot, "examples", "basic-host"),
      stagedHostRoot,
      { recursive: true },
    );
    const packagePath = join(stagedHostRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.devDependencies = {
      ...packageJson.devDependencies,
      "@types/cors": "2.8.19",
      "cross-env": "10.1.0",
      tsx: "4.21.0",
    };
    await writeFile(
      packagePath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
      "utf8",
    );
    run(
      npmCommand,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: stagedHostRoot },
    );
    run(npmCommand, ["run", "build"], {
      cwd: stagedHostRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
      },
    });
    await writeFile(
      join(stagedHostRoot, ".nelos-upstream.json"),
      `${JSON.stringify({
        repository: MCP_APPS_UPSTREAM_REPOSITORY,
        commit: MCP_APPS_UPSTREAM_COMMIT,
      }, null, 2)}\n`,
      "utf8",
    );

    if (!basicHostRoot.startsWith(`${cacheRoot}/`)) {
      throw new Error("refusing to replace a basic-host cache outside its root");
    }
    await rm(basicHostRoot, { recursive: true, force: true });
    await rename(stagedHostRoot, basicHostRoot);
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
  return basicHostRoot;
}

async function waitForHttp(url, children, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const child of children) {
      if (child.exitCode !== null) {
        throw new Error(
          `${child.spawnfile} exited ${child.exitCode} before ${url} became ready`,
        );
      }
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(
    `${url} did not become ready: ${lastError?.message ?? "timeout"}`,
  );
}

function fixtureUrl(toolName) {
  const url = new URL(`http://127.0.0.1:${hostPort}/`);
  url.searchParams.set("server", "Nelos execution map fixtures");
  url.searchParams.set("tool", toolName);
  url.searchParams.set("call", "true");
  return url.href;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const hostRoot = await prepareBasicHost();
  const fixtureUrlValue = `http://127.0.0.1:${fixturePort}/mcp`;

  const fixtureChild = spawn(
    process.execPath,
    ["scripts/mcp-app-fixture-server.mjs"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NELOS_MCP_APP_FIXTURE_PORT: String(fixturePort),
      },
      stdio: "inherit",
    },
  );
  let hostChild = null;
  const cleanup = async () => {
    await stopChild(hostChild);
    await stopChild(fixtureChild);
  };

  process.once("SIGINT", () => {
    cleanup().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    cleanup().finally(() => process.exit(143));
  });

  try {
    await waitForHttp(
      `http://127.0.0.1:${fixturePort}/healthz`,
      [fixtureChild],
    );
    hostChild = spawn(
      join(hostRoot, "node_modules", ".bin", "tsx"),
      ["serve.ts"],
      {
        cwd: hostRoot,
        env: {
          ...process.env,
          HOST_PORT: String(hostPort),
          SANDBOX_PORT: String(sandboxPort),
          SERVERS: JSON.stringify([fixtureUrlValue]),
        },
        stdio: "inherit",
      },
    );
    await waitForHttp(
      `http://127.0.0.1:${hostPort}/api/servers`,
      [fixtureChild, hostChild],
    );
    await waitForHttp(
      `http://127.0.0.1:${sandboxPort}/sandbox.html`,
      [fixtureChild, hostChild],
    );

    process.stdout.write(
      [
        "",
        "Official MCP Apps basic-host is ready.",
        `Host: http://127.0.0.1:${hostPort}/`,
        `Sandbox: http://127.0.0.1:${sandboxPort}/sandbox.html`,
        `Fixture MCP: ${fixtureUrlValue}`,
        "",
        ...EXECUTION_MAP_FIXTURES.map(
          ({ title, toolName }) => `${title}: ${fixtureUrl(toolName)}`,
        ),
        "",
      ].join("\n"),
    );

    if (checkOnly) {
      process.stdout.write(
        `✓ pinned basic-host ${MCP_APPS_UPSTREAM_COMMIT} built and reached all local endpoints\n`,
      );
      return;
    }

    await new Promise((resolveWait, reject) => {
      fixtureChild.once("exit", (code, signal) => {
        reject(
          new Error(
            `fixture server stopped (${signal ?? `exit ${code}`})`,
          ),
        );
      });
      hostChild.once("exit", (code, signal) => {
        reject(
          new Error(`basic-host stopped (${signal ?? `exit ${code}`})`),
        );
      });
    });
  } finally {
    await cleanup();
  }
}

await main();
