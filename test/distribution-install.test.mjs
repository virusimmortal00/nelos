import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  distributionInstallInternals,
  installDistribution,
  stageDistribution,
} from "../src/distribution-install.mjs";
import {
  DISTRIBUTION_ENTRIES,
  MANAGED_CLI_COMMANDS,
  computeDistributionIntegrity,
} from "../src/distribution-provenance.mjs";
import { startMockAppServer } from "./support/mock-app-server.mjs";

const packageRoot = process.env.NELOS_TEST_PACKAGE_ROOT
  ? resolve(process.env.NELOS_TEST_PACKAGE_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));
const candidateVersion = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
).version;
const legacyVersion = "0.0.0";
const verifier = fileURLToPath(
  new URL("../bin/nelos-verify-distribution", import.meta.url),
);

function runVerifier(environment, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifier, ...args], {
      env: { ...process.env, ...environment },
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function createFakeCodex(path) {
  const script = `#!${process.execPath}
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");

const selector = "nelos@personal";
const candidateVersion = ${JSON.stringify(candidateVersion)};
const sourcePath = process.env.FAKE_PLUGIN_SOURCE;
const codexHome = process.env.CODEX_HOME;
const statePath = path.join(codexHome, "fake-plugin-state.json");

async function readState() {
  try { return JSON.parse(await fsp.readFile(statePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { installed: false }; throw error; }
}
async function writeState(state) {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify(state));
}
function output(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }

async function main() {
  const args = process.argv.slice(2);
  if (
    process.env.FAKE_CODEX_REQUIRE_SAFE_PATH === "1" &&
    process.env.PATH.split(path.delimiter).some(
      (entry) => entry === "" || !path.isAbsolute(entry),
    )
  ) {
    throw new Error("unsafe PATH reached fake Codex");
  }
  if (args[0] !== "plugin") throw new Error("unsupported fake codex command");
  if (args[1] === "list") {
    const state = await readState();
    const entry = {
      pluginId: selector,
      name: "nelos",
      marketplaceName: "personal",
      version: state.version || null,
      installed: Boolean(state.installed),
      enabled: Boolean(state.installed),
      source: { source: "local", path: sourcePath },
      installPolicy: "AVAILABLE",
      authPolicy: "ON_INSTALL",
    };
    output({
      installed: state.installed ? [entry] : [],
      available: state.installed && process.env.FAKE_CODEX_OVERLAP !== "1" ? [] : [entry],
    });
    return;
  }
  if (args[1] === "add") {
    const manifest = JSON.parse(await fsp.readFile(path.join(sourcePath, ".codex-plugin", "plugin.json"), "utf8"));
    const currentState = await readState();
    if (process.env.FAKE_CODEX_FAIL_CANDIDATE === "1" && manifest.version === candidateVersion) {
      process.stderr.write("injected candidate plugin failure\\n");
      process.exitCode = 9;
      return;
    }
    if (process.env.FAKE_CODEX_FAIL_REPAIR === "1" && currentState.version === manifest.version) {
      process.stderr.write("injected committed plugin repair failure\\n");
      process.exitCode = 10;
      return;
    }
    const installedPath = path.join(codexHome, "plugins", "cache", "personal", "nelos", manifest.version);
    await fsp.rm(installedPath, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(installedPath), { recursive: true });
    await fsp.cp(sourcePath, installedPath, { recursive: true });
    if (process.env.FAKE_CODEX_CORRUPT_CANDIDATE === "1" && manifest.version === candidateVersion) {
      await fsp.appendFile(
        path.join(installedPath, ".codex-plugin", "plugin.json"),
        "\\n// injected corruption\\n",
      );
    }
    await writeState({ installed: true, version: manifest.version, installedPath });
    output({
      pluginId: selector,
      name: "nelos",
      marketplaceName: "personal",
      version: manifest.version,
      installedPath,
      authPolicy: "ON_INSTALL",
    });
    return;
  }
  if (args[1] === "remove") {
    const state = await readState();
    if (state.installedPath) await fsp.rm(state.installedPath, { recursive: true, force: true });
    await writeState({ installed: false });
    output({ pluginId: selector, removed: true });
    return;
  }
  throw new Error("unsupported fake codex plugin command");
}
main().catch((error) => { process.stderr.write(error.message + "\\n"); process.exitCode = 1; });
`;
  await writeFile(path, script, { mode: 0o755 });
}

async function createLegacyPluginSource(sourcePath) {
  await mkdir(join(sourcePath, ".codex-plugin"), { recursive: true });
  await mkdir(join(sourcePath, "skills", "manage-nelos-tasks"), {
    recursive: true,
  });
  await writeFile(
    join(sourcePath, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name: "nelos", version: legacyVersion }, null, 2)}\n`,
  );
  await writeFile(
    join(sourcePath, "distribution-provenance.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        distribution: "nelos",
        revision: legacyVersion,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(sourcePath, "skills", "manage-nelos-tasks", "SKILL.md"),
    "legacy plugin skill\n",
  );
  await writeFile(join(sourcePath, "legacy-marker"), "legacy source\n");
}

async function runFakeCodex(codexPath, args, env) {
  const result = spawnSync(codexPath, args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-distribution-install-"));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const binDir = join(home, ".local", "bin");
  const fakeBin = join(root, "fake-bin");
  const codexPath = join(fakeBin, "codex");
  const pluginSource = join(home, "plugins", "nelos");
  const skillPath = join(codexHome, "skills", "manage-nelos-tasks");
  const installRoot = join(codexHome, "distributions", "nelos");
  await mkdir(binDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(skillPath, { recursive: true });
  await createFakeCodex(codexPath);
  await createLegacyPluginSource(pluginSource);
  await writeFile(join(skillPath, "SKILL.md"), "legacy user skill\n");
  await writeFile(
    join(skillPath, "distribution-provenance.json"),
    `${JSON.stringify({ schemaVersion: 1, distribution: "legacy", revision: legacyVersion })}\n`,
  );
  const oldCli = "#!/bin/sh\nprintf 'legacy help\\n'\n";
  const oldTitle = "#!/bin/sh\nprintf 'legacy title\\n'\n";
  await writeFile(join(binDir, "nelos"), oldCli, { mode: 0o755 });
  await writeFile(join(binDir, "nelos-title"), oldTitle, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    FAKE_PLUGIN_SOURCE: pluginSource,
    PATH: [binDir, fakeBin, dirname(process.execPath), "/usr/bin", "/bin"].join(
      delimiter,
    ),
  };
  await runFakeCodex(codexPath, ["plugin", "add", "nelos@personal", "--json"], env);
  return {
    root,
    home,
    codexHome,
    binDir,
    codexPath,
    pluginSource,
    skillPath,
    installRoot,
    env,
    oldCli,
    oldTitle,
  };
}

async function installFixture(fixture, overrides = {}) {
  return installDistribution({
    packageRoot,
    home: fixture.home,
    codexHome: fixture.codexHome,
    installRoot: fixture.installRoot,
    binDir: fixture.binDir,
    codexCommand: fixture.codexPath,
    force: true,
    env: fixture.env,
    ...overrides,
  });
}

async function makeFixtureClean(fixture) {
  await Promise.all([
    rm(dirname(fixture.pluginSource), { recursive: true, force: true }),
    rm(join(fixture.home, ".agents"), { recursive: true, force: true }),
    rm(fixture.skillPath, { recursive: true, force: true }),
    rm(join(fixture.codexHome, "plugins"), { recursive: true, force: true }),
    rm(join(fixture.codexHome, "fake-plugin-state.json"), { force: true }),
    rm(join(fixture.binDir, "nelos"), { force: true }),
    rm(join(fixture.binDir, "nelos-title"), { force: true }),
  ]);
}

async function startPluginAppServer(
  fixture,
  {
    installDelayMs = 0,
    failInstall = false,
    corruptCacheAfterInstall = false,
  } = {},
) {
  const socketPath = join(fixture.root, "app-server.sock");
  const marketplacePath = join(
    fixture.home,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  await mkdir(dirname(marketplacePath), { recursive: true });
  await writeFile(
    marketplacePath,
    `${JSON.stringify(
      {
        name: "personal",
        plugins: [
          {
            name: "nelos",
            source: { source: "local", path: fixture.pluginSource },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const state = { installed: true, version: legacyVersion };
  const summary = () => ({
    id: "nelos@personal",
    name: "nelos",
    localVersion: state.version,
    installed: state.installed,
    enabled: state.installed,
    source: { type: "local", path: fixture.pluginSource },
  });
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "plugin/read") {
      return { plugin: { summary: summary() } };
    }
    if (method === "plugin/install") {
      if (installDelayMs > 0) await delay(installDelayMs);
      if (failInstall) throw new Error("injected app-server install failure");
      const manifest = JSON.parse(
        await readFile(
          join(fixture.pluginSource, ".codex-plugin", "plugin.json"),
          "utf8",
        ),
      );
      state.installed = true;
      state.version = manifest.version;
      if (corruptCacheAfterInstall) {
        const fakeState = JSON.parse(
          await readFile(join(fixture.codexHome, "fake-plugin-state.json"), "utf8"),
        );
        await writeFile(
          join(fakeState.installedPath, ".codex-plugin", "plugin.json"),
          "corrupted by app-server fixture\n",
        );
      }
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "plugin/uninstall") {
      state.installed = false;
      state.version = null;
      return {};
    }
    if (method === "plugin/installed") {
      return {
        marketplaces: [{ name: "personal", plugins: [summary()] }],
        marketplaceLoadErrors: [],
      };
    }
    throw new Error(`unexpected app-server method: ${method}`);
  });
  return { server, socketPath, marketplacePath, state };
}

async function assertLegacyState(fixture) {
  assert.equal(await readFile(join(fixture.binDir, "nelos"), "utf8"), fixture.oldCli);
  assert.equal(
    await readFile(join(fixture.binDir, "nelos-title"), "utf8"),
    fixture.oldTitle,
  );
  assert.equal(
    await readFile(join(fixture.skillPath, "SKILL.md"), "utf8"),
    "legacy user skill\n",
  );
  assert.equal(
    await readFile(join(fixture.pluginSource, "legacy-marker"), "utf8"),
    "legacy source\n",
  );
  const fakeState = JSON.parse(
    await readFile(join(fixture.codexHome, "fake-plugin-state.json"), "utf8"),
  );
  assert.equal(fakeState.version, legacyVersion);
}

test("unified install repairs PATH, skill, and plugin from one immutable release", async () => {
  const fixture = await createFixture();
  try {
    const installed = await installFixture(fixture);
    assert.equal(installed.provenance.revision, candidateVersion);
    assert.equal(installed.plugin.liveActivation.status, "restart-required");
    assert.equal(installed.plugin.liveActivation.registryVerified, false);
    assert.equal(installed.plugin.liveActivation.freshTaskSmokeTestRequired, true);
    assert.match(installed.provenance.integrity, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      await realpath(join(fixture.binDir, "nelos")),
      await realpath(join(installed.releasePath, "bin", "nelos")),
    );
    const help = spawnSync("nelos", ["--help"], {
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /nelos spinoff/);
    assert.match(help.stdout, /nelos web begin/);
    assert.match(help.stdout, /nelos web join/);
    assert.match(help.stdout, /nelos web collect/);

    const skillProvenance = JSON.parse(
      await readFile(
        join(fixture.skillPath, "distribution-provenance.json"),
        "utf8",
      ),
    );
    const sourceProvenance = JSON.parse(
      await readFile(
        join(fixture.pluginSource, "distribution-provenance.json"),
        "utf8",
      ),
    );
    const cachedProvenance = JSON.parse(
      await readFile(
        join(installed.plugin.installedPath, "distribution-provenance.json"),
        "utf8",
      ),
    );
    assert.deepEqual(skillProvenance, installed.provenance);
    assert.deepEqual(sourceProvenance, installed.provenance);
    assert.deepEqual(cachedProvenance, installed.provenance);

    const orphanedCache = join(
      fixture.codexHome,
      "plugins",
      "cache",
      "personal",
      "nelos",
      "999.0.0",
    );
    await mkdir(orphanedCache, { recursive: true });
    await writeFile(
      join(orphanedCache, "distribution-provenance.json"),
      '{"schemaVersion":1,"distribution":"nelos","revision":"999.0.0"}\n',
    );

    const verified = await runVerifier(fixture.env);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /OK PATH CLI/);
    assert.match(verified.stdout, /OK user-wide skill/);
    assert.match(verified.stdout, /OK cached plugin/);
    assert.match(verified.stdout, /SKIP active plugin registry/);

    const repeated = await installFixture(fixture);
    assert.equal(repeated.reusedRelease, true);
    assert.equal(repeated.releasePath, installed.releasePath);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a clean isolated home bootstraps source and marketplace idempotently", async () => {
  const fixture = await createFixture();
  try {
    await makeFixtureClean(fixture);
    const first = await installFixture(fixture);
    const marketplace = join(fixture.home, ".agents", "plugins", "marketplace.json");
    assert.equal(first.marketplaceBootstrap.created, true);
    assert.ok((await stat(fixture.pluginSource)).isDirectory());
    const marketplaceBytes = await readFile(marketplace, "utf8");
    const second = await installFixture(fixture);
    assert.equal(second.marketplaceBootstrap.created, false);
    assert.equal(await readFile(marketplace, "utf8"), marketplaceBytes);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a live-shaped canonical marketplace remains byte-identical during install", async () => {
  const fixture = await createFixture();
  try {
    const marketplacePath = join(fixture.home, ".agents", "plugins", "marketplace.json");
    await mkdir(dirname(marketplacePath), { recursive: true });
    const marketplaceBytes = `${JSON.stringify({
      name: "personal",
      interface: { displayName: "Personal", customTheme: "violet" },
      plugins: [
        {
          name: "other-plugin",
          source: { source: "local", path: "/opt/other-plugin" },
          preserve: { nested: true },
        },
        {
          name: "nelos",
          source: { source: "local", path: "./plugins/nelos" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Developer Tools",
        },
      ],
      customMetadata: ["preserve", "me"],
    }, null, 4)}\n`;
    await writeFile(marketplacePath, marketplaceBytes);

    const installed = await installFixture(fixture);
    assert.equal(installed.marketplaceBootstrap.changed, false);
    assert.equal(installed.marketplaceBootstrap.state, "compatible");
    assert.equal(await readFile(marketplacePath, "utf8"), marketplaceBytes);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("install appends Nelos, preserves the legacy plugin, and is byte-idempotent afterward", async () => {
  const fixture = await createFixture();
  try {
    const marketplacePath = join(fixture.home, ".agents", "plugins", "marketplace.json");
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(
      marketplacePath,
      '{"name":"personal","interface":{"displayName":"Keep"},"plugins":[{"name":"other","source":{"source":"local","path":"/opt/other"},"nested":{"keep":true}},{"name":"legacy-orchestrator","source":{"source":"local","path":"./plugins/legacy-orchestrator"},"legacy":true}],"custom":"value"}\n',
    );

    const installed = await installFixture(fixture);
    assert.equal(installed.marketplaceBootstrap.updated, true);
    const updatedBytes = await readFile(marketplacePath, "utf8");
    const updated = JSON.parse(updatedBytes);
    assert.equal(updated.interface.displayName, "Keep");
    assert.equal(updated.custom, "value");
    assert.equal(updated.plugins[0].nested.keep, true);
    assert.equal(updated.plugins[1].name, "legacy-orchestrator");
    assert.equal(updated.plugins[1].legacy, true);
    assert.equal(updated.plugins[2].name, "nelos");
    assert.equal(updated.plugins[2].source.path, "./plugins/nelos");

    const repeated = await installFixture(fixture);
    assert.equal(repeated.marketplaceBootstrap.changed, false);
    assert.equal(await readFile(marketplacePath, "utf8"), updatedBytes);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("failed install restores a coexisting marketplace exactly", async () => {
  const fixture = await createFixture();
  try {
    const marketplacePath = join(fixture.home, ".agents", "plugins", "marketplace.json");
    await mkdir(dirname(marketplacePath), { recursive: true });
    const original = '{\n  "name": "personal",\n  "interface": { "displayName": "Exact bytes" },\n  "plugins": [{ "name": "other", "source": { "source": "local", "path": "/opt/other" } }]\n}\n';
    await writeFile(marketplacePath, original, { mode: 0o640 });
    await chmod(marketplacePath, 0o640);

    await assert.rejects(
      installFixture(fixture, {
        env: { ...fixture.env, FAKE_CODEX_FAIL_CANDIDATE: "1" },
      }),
      /injected candidate plugin failure/,
    );
    assert.equal(await readFile(marketplacePath, "utf8"), original);
    assert.equal((await stat(marketplacePath)).mode & 0o777, 0o640);
    await assert.rejects(
      stat(join(dirname(marketplacePath), ".nelos-marketplace-transaction.json")),
      /ENOENT/,
    );
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("committed crash recovery preserves marketplace and next install coherence", async () => {
  const fixture = await createFixture();
  try {
    await makeFixtureClean(fixture);
    await installFixture(fixture);
    const marketplacePath = join(fixture.home, ".agents", "plugins", "marketplace.json");
    const marketplaceBytes = await readFile(marketplacePath);
    const statePath = join(fixture.installRoot, "install-state.json");
    const previousState = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(join(fixture.installRoot, "install-transaction.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "committed-crash-fixture",
      status: "committed",
      codexCommand: fixture.codexPath,
      statePath,
      previousState,
      plugin: { selector: "nelos@personal" },
      launchers: [],
    })}\n`);
    const marketplaceTransactionPath = join(
      dirname(marketplacePath),
      ".nelos-marketplace-transaction.json",
    );
    await writeFile(marketplaceTransactionPath, `${JSON.stringify({
      schemaVersion: 1,
      operation: "create-personal-marketplace",
      path: marketplacePath,
      expectedFingerprint: `sha256:${createHash("sha256").update(marketplaceBytes).digest("hex")}`,
    })}\n`);
    const recovered = await installFixture(fixture);
    assert.equal(recovered.marketplaceBootstrap.created, false);
    assert.deepEqual(await readFile(marketplacePath), marketplaceBytes);
    await assert.rejects(stat(join(fixture.installRoot, "install-transaction.json")), /ENOENT/);
    await assert.rejects(stat(marketplaceTransactionPath), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("shared bootstrap parents retain mode while newly created parents are private", async () => {
  const shared = await createFixture();
  const clean = await createFixture();
  try {
    const marketplaceParent = join(shared.home, ".agents", "plugins");
    await mkdir(marketplaceParent, { recursive: true });
    await chmod(marketplaceParent, 0o755);
    await chmod(dirname(shared.pluginSource), 0o755);
    await installFixture(shared);
    assert.equal((await stat(marketplaceParent)).mode & 0o777, 0o755);
    assert.equal((await stat(dirname(shared.pluginSource))).mode & 0o777, 0o755);

    await makeFixtureClean(clean);
    await installFixture(clean);
    assert.equal((await stat(join(clean.home, ".agents", "plugins"))).mode & 0o777, 0o700);
    assert.equal((await stat(dirname(clean.pluginSource))).mode & 0o777, 0o700);
  } finally {
    await rm(shared.root, { recursive: true, force: true });
    await rm(clean.root, { recursive: true, force: true });
  }
});

test("a failed clean-home install rolls back its exact marketplace and source", async () => {
  const fixture = await createFixture();
  try {
    await makeFixtureClean(fixture);
    await assert.rejects(installFixture(fixture, { env: { ...fixture.env, FAKE_CODEX_FAIL_CANDIDATE: "1" } }), /injected candidate plugin failure/);
    await assert.rejects(stat(fixture.pluginSource), /ENOENT/);
    await assert.rejects(stat(join(fixture.home, ".agents", "plugins", "marketplace.json")), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("plugin discovery tolerates the same plugin in installed and available lists", async () => {
  const fixture = await createFixture();
  try {
    const installed = await installFixture(fixture, {
      env: { ...fixture.env, FAKE_CODEX_OVERLAP: "1" },
    });
    assert.equal(installed.plugin.version, candidateVersion);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a copied managed launcher is accepted and replaced without force", async () => {
  const fixture = await createFixture();
  try {
    const installed = await installFixture(fixture);
    const launcher = join(fixture.binDir, "nelos");
    await rm(launcher);
    await copyFile(join(installed.releasePath, "bin", "nelos"), launcher);
    const candidate = join(fixture.root, "candidate-distribution");
    await mkdir(candidate);
    for (const entry of DISTRIBUTION_ENTRIES) {
      await cp(join(packageRoot, entry), join(candidate, entry), { recursive: true });
    }
    await copyFile(
      join(packageRoot, "distribution-provenance.json"),
      join(candidate, "distribution-provenance.json"),
    );
    const candidateCli = join(candidate, "bin", "nelos");
    await writeFile(candidateCli, `${await readFile(candidateCli, "utf8")}\n// next build\n`);
    const candidateProvenancePath = join(
      candidate,
      "distribution-provenance.json",
    );
    const candidateProvenance = JSON.parse(
      await readFile(candidateProvenancePath, "utf8"),
    );
    candidateProvenance.integrity = await computeDistributionIntegrity(candidate);
    await writeFile(
      candidateProvenancePath,
      `${JSON.stringify(candidateProvenance, null, 2)}\n`,
    );
    const repeated = await installFixture(fixture, {
      force: false,
      packageRoot: candidate,
    });
    assert.notEqual(repeated.releasePath, installed.releasePath);
    assert.equal(
      await realpath(launcher),
      await realpath(join(repeated.releasePath, "bin", "nelos")),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fresh managed bin directories are world-traversable", async () => {
  const fixture = await createFixture();
  try {
    await rm(fixture.binDir, { recursive: true, force: true });
    await installFixture(fixture);
    assert.equal((await stat(fixture.binDir)).mode & 0o777, 0o755);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pre-existing managed directories are normalized to intended modes", async () => {
  const fixture = await createFixture();
  const managedDirectories = new Map([
    [fixture.codexHome, 0o700],
    [fixture.installRoot, 0o700],
    [fixture.binDir, 0o755],
    [dirname(fixture.skillPath), 0o700],
    [join(fixture.codexHome, "plugins", "cache"), 0o700],
  ]);
  try {
    for (const path of managedDirectories.keys()) {
      await mkdir(path, { recursive: true });
      await chmod(path, 0o777);
    }
    await installFixture(fixture);
    for (const [path, expectedMode] of managedDirectories) {
      assert.equal((await stat(path)).mode & 0o777, expectedMode, path);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("managed verification reports cross-marketplace cache ambiguity", async () => {
  const fixture = await createFixture();
  try {
    const installed = await installFixture(fixture);
    const ambiguous = join(
      fixture.codexHome,
      "plugins",
      "cache",
      "another-marketplace",
      "nelos",
      installed.provenance.revision,
    );
    await mkdir(ambiguous, { recursive: true });
    await writeFile(
      join(ambiguous, "distribution-provenance.json"),
      `${JSON.stringify(installed.provenance, null, 2)}\n`,
    );
    const verified = await runVerifier(fixture.env);
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /MISMATCH cached plugin:.*installed=ambiguous/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed install state reports structured mismatches and stages no release", async () => {
  const fixture = await createFixture();
  try {
    await installFixture(fixture);
    const releases = join(fixture.installRoot, "releases");
    const before = (await readdir(releases)).toSorted();
    await writeFile(join(fixture.installRoot, "install-state.json"), "{truncated\n");
    const verified = await runVerifier(fixture.env);
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /MISMATCH PATH CLI:.*invalid install state/);
    await assert.rejects(installFixture(fixture), /Unexpected token|JSON/);
    assert.deepEqual((await readdir(releases)).toSorted(), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification rejects recorded plugin paths outside the managed cache", async () => {
  const fixture = await createFixture();
  try {
    await installFixture(fixture);
    const outside = join(fixture.root, "outside-plugin-cache");
    await mkdir(outside);
    const statePath = join(fixture.installRoot, "install-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.plugin.installedPath = outside;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const verified = await runVerifier(fixture.env);
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /recorded plugin cache is outside its managed root/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification rejects malformed recorded plugin selectors", async () => {
  const fixture = await createFixture();
  try {
    await installFixture(fixture);
    const statePath = join(fixture.installRoot, "install-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.plugin.selector = "malformed-selector";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const verified = await runVerifier(fixture.env);
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /invalid managed paths/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification reports recorded installation paths that disappeared", async () => {
  const fixture = await createFixture();
  try {
    const installed = await installFixture(fixture);
    await rm(installed.plugin.installedPath, { recursive: true, force: true });
    const verified = await runVerifier(fixture.env);
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /recorded plugin cache is missing/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification never executes a Codex command sourced only from install state", async () => {
  const fixture = await createFixture();
  const sentinel = join(fixture.root, "state-command-executed");
  try {
    await installFixture(fixture);
    const malicious = join(fixture.root, "malicious-state-codex");
    await writeFile(
      malicious,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed\\n");\n`,
      { mode: 0o755 },
    );
    const statePath = join(fixture.installRoot, "install-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(
      statePath,
      `${JSON.stringify({ ...state, codexCommand: malicious }, null, 2)}\n`,
    );

    const defaultVerification = await runVerifier(fixture.env);
    assert.equal(defaultVerification.status, 0, defaultVerification.stderr);
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });

    const explicitVerification = await runVerifier(fixture.env, [
      "--codex",
      fixture.codexPath,
    ]);
    assert.equal(explicitVerification.status, 1);
    assert.match(explicitVerification.stderr, /does not match the explicitly trusted/);
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification reports an unusable explicit Codex path without aborting", async () => {
  const fixture = await createFixture();
  try {
    await installFixture(fixture);
    const missingCodex = join(fixture.root, "missing-codex");
    const verified = await runVerifier(fixture.env, ["--codex", missingCodex]);
    assert.equal(verified.status, 1);
    assert.match(verified.stdout, /OK PATH CLI/);
    assert.match(verified.stdout, /OK user-wide skill/);
    assert.match(
      verified.stderr,
      /MISMATCH cached plugin:.*could not verify active plugin state with --codex/,
    );
    assert.doesNotMatch(verified.stderr, /^nelos-verify-distribution:/m);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification rejects current-directory PATH components without trusting cwd", async () => {
  const fixture = await createFixture();
  try {
    await installFixture(fixture);
    const cwdShadow = join(fixture.root, "nelos");
    await writeFile(cwdShadow, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const unsafeEnvironment = {
      ...fixture.env,
      PATH: ["", fixture.env.PATH].join(delimiter),
    };
    const verified = await runVerifier(unsafeEnvironment, [], {
      cwd: fixture.root,
    });
    assert.equal(verified.status, 1);
    assert.match(
      verified.stderr,
      /MISMATCH PATH CLI:.*relative or empty current-directory component/,
    );
    assert.doesNotMatch(verified.stderr, new RegExp(`path=${cwdShadow}`));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a running desktop app-server refresh verifies its plugin registry metadata", async () => {
  const fixture = await createFixture();
  const appServer = await startPluginAppServer(fixture);
  try {
    const installed = await installFixture(fixture, {
      appServerSocket: appServer.socketPath,
      marketplacePath: appServer.marketplacePath,
    });
    assert.deepEqual(installed.plugin.liveActivation, {
      status: "registry-refreshed",
      registryVerified: true,
      freshTaskSmokeTestRequired: true,
      socketPath: appServer.socketPath,
      marketplacePath: appServer.marketplacePath,
    });
    assert.equal(installed.activationRecordUpdated, true);
    assert.equal(appServer.state.installed, true);
    assert.equal(appServer.state.version, candidateVersion);
    const methods = appServer.server.requests.map(({ method }) => method);
    assert.ok(methods.includes("plugin/install"));
    assert.equal(methods.filter((method) => method === "plugin/read").length, 2);
  } finally {
    await appServer.server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer activation discovers the host endpoint from options.env", async () => {
  const fixture = await createFixture();
  const appServer = await startPluginAppServer(fixture);
  try {
    const installed = await installFixture(fixture, {
      env: {
        ...fixture.env,
        CODEX_APP_SERVER_CONTROL_ENDPOINT: JSON.stringify({
          schemaVersion: 1,
          transport: "unix-websocket",
          path: appServer.socketPath,
          protocolVersion: "fixture-v1",
        }),
        CODEX_APP_SERVER_CONTROL_SOCKET: join(fixture.root, "wrong-legacy.sock"),
      },
      marketplacePath: appServer.marketplacePath,
    });
    assert.equal(installed.plugin.liveActivation.status, "registry-refreshed");
    assert.equal(installed.plugin.liveActivation.socketPath, appServer.socketPath);
    assert.equal(appServer.state.version, candidateVersion);
    assert.ok(
      appServer.server.requests.some(({ method }) => method === "plugin/install"),
    );
  } finally {
    await appServer.server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a failed post-commit app-server refresh keeps the coherent disk release", async () => {
  const fixture = await createFixture();
  const appServer = await startPluginAppServer(fixture, { failInstall: true });
  try {
    const installed = await installFixture(fixture, {
      appServerSocket: appServer.socketPath,
      marketplacePath: appServer.marketplacePath,
    });
    assert.equal(installed.plugin.liveActivation.status, "restart-required");
    assert.match(
      installed.plugin.liveActivation.reason,
      /injected app-server install failure/,
    );
    assert.equal(appServer.state.installed, true);
    assert.equal(appServer.state.version, legacyVersion);
    await assert.rejects(
      readFile(join(fixture.pluginSource, "legacy-marker")),
      { code: "ENOENT" },
    );
    const verified = await runVerifier(fixture.env);
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await appServer.server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a failed post-commit cache repair is recorded and recovered by the next install", async () => {
  const fixture = await createFixture();
  const appServer = await startPluginAppServer(fixture, {
    corruptCacheAfterInstall: true,
  });
  try {
    await assert.rejects(
      installFixture(fixture, {
        appServerSocket: appServer.socketPath,
        marketplacePath: appServer.marketplacePath,
        env: { ...fixture.env, FAKE_CODEX_FAIL_REPAIR: "1" },
      }),
      /distribution is committed.*injected committed plugin repair failure/,
    );
    const statePath = join(fixture.installRoot, "install-state.json");
    const failedState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(failedState.plugin.cacheRepair.status, "failed");
    assert.match(
      failedState.plugin.cacheRepair.reason,
      /injected committed plugin repair failure/,
    );
    const failedVerification = await runVerifier(fixture.env);
    assert.equal(failedVerification.status, 1);
    assert.match(failedVerification.stderr, /plugin cache repair is failed/);

    await appServer.server.close();
    const repaired = await installFixture(fixture);
    assert.equal(repaired.plugin.cacheRepair, undefined);
    const verified = await runVerifier(fixture.env);
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await appServer.server.close().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a timed-out app-server install can finish late only on the committed release", async () => {
  const fixture = await createFixture();
  const appServer = await startPluginAppServer(fixture, { installDelayMs: 200 });
  try {
    const installed = await installFixture(fixture, {
      appServerSocket: appServer.socketPath,
      marketplacePath: appServer.marketplacePath,
      appServerTimeoutMs: 50,
    });
    assert.equal(installed.plugin.liveActivation.status, "restart-required");
    assert.match(installed.plugin.liveActivation.reason, /timed out/);
    await assert.rejects(
      readFile(join(fixture.pluginSource, "legacy-marker")),
      { code: "ENOENT" },
    );
    await delay(300);
    assert.equal(appServer.state.version, candidateVersion);
    const verified = await runVerifier(fixture.env);
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await appServer.server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("plugin activation failure restores every pre-existing surface", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      installFixture(fixture, {
        env: { ...fixture.env, FAKE_CODEX_FAIL_CANDIDATE: "1" },
      }),
      /injected candidate plugin failure/,
    );
    await assertLegacyState(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production environment variables cannot activate test failpoints", async () => {
  const fixture = await createFixture();
  try {
    const installed = await installFixture(fixture, {
      env: { ...fixture.env, NELOS_FAILPOINT: "skill" },
    });
    assert.equal(installed.provenance.revision, candidateVersion);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("candidate plugin corruption is rejected before other surfaces are replaced", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      installFixture(fixture, {
        env: { ...fixture.env, FAKE_CODEX_CORRUPT_CANDIDATE: "1" },
      }),
      /plugin integrity mismatch/,
    );
    await assertLegacyState(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("post-skill failure rolls back plugin source, cache, skill, and launchers", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      installFixture(fixture, { testFailpoint: "skill" }),
      /injected install failure at skill/,
    );
    await assertLegacyState(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a provenance-preserving skill edit is foreign without force", async () => {
  const fixture = await createFixture();
  try {
    await installFixture(fixture);
    await writeFile(join(fixture.skillPath, "SKILL.md"), "tampered managed skill\n");
    await assert.rejects(
      installFixture(fixture, { force: false }),
      /foreign skill exists/,
    );
    assert.equal(
      await readFile(join(fixture.skillPath, "SKILL.md"), "utf8"),
      "tampered managed skill\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an extra skill file is preserved unless directory replacement is forced", async () => {
  const fixture = await createFixture();
  const extraFile = join(fixture.skillPath, "local-notes.md");
  try {
    await installFixture(fixture);
    await writeFile(extraFile, "preserve me\n");
    await assert.rejects(
      installFixture(fixture, { force: false }),
      /foreign skill exists/,
    );
    assert.equal(await readFile(extraFile, "utf8"), "preserve me\n");

    await installFixture(fixture, { force: true });
    await assert.rejects(readFile(extraFile), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("every post-plugin commit failpoint restores the previous installation", async () => {
  for (const failpoint of ["current", "launchers", "verify", "state"]) {
    const fixture = await createFixture();
    try {
      await assert.rejects(
        installFixture(fixture, { testFailpoint: failpoint }),
        new RegExp(`injected install failure at ${failpoint}`),
      );
      await assertLegacyState(fixture);
      await assert.rejects(
        readFile(join(fixture.installRoot, "install-state.json")),
        { code: "ENOENT" },
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("the next install recovers an interrupted journal before proceeding", async () => {
  const fixture = await createFixture();
  const transactionId = "interrupted-fixture";
  const journalPath = join(fixture.installRoot, "install-transaction.json");
  const skillBackup = `${fixture.skillPath}.nelos-backup-${transactionId}`;
  const launcherPath = join(fixture.binDir, "nelos");
  const launcherBackup = `${launcherPath}.nelos-backup-${transactionId}`;
  const sourceBackup = `${fixture.pluginSource}.nelos-backup-${transactionId}`;
  try {
    await mkdir(fixture.installRoot, { recursive: true });
    await rename(fixture.skillPath, skillBackup);
    await mkdir(fixture.skillPath, { recursive: true });
    await writeFile(join(fixture.skillPath, "SKILL.md"), "interrupted candidate\n");
    await rename(launcherPath, launcherBackup);
    await symlink(join(packageRoot, "bin", "nelos"), launcherPath);
    await rename(fixture.pluginSource, sourceBackup);
    await createLegacyPluginSource(fixture.pluginSource);
    await writeFile(
      join(fixture.pluginSource, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({ name: "nelos", version: candidateVersion }, null, 2)}\n`,
    );
    await runFakeCodex(
      fixture.codexPath,
      ["plugin", "add", "nelos@personal", "--json"],
      fixture.env,
    );
    await writeFile(
      journalPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: transactionId,
          status: "active",
          codexCommand: join(fixture.root, "retired-codex-location"),
          statePath: join(fixture.installRoot, "install-state.json"),
          previousState: null,
          plugin: {
            selector: "nelos@personal",
            previouslyInstalled: true,
            sourcePath: fixture.pluginSource,
            sourceBackupPath: sourceBackup,
            sourceStagePath: `${fixture.pluginSource}.nelos-stage-${transactionId}`,
            sourceExisted: true,
            sourceFingerprint:
              await distributionInstallInternals.treeFingerprint(sourceBackup),
            sourceActivated: true,
            activated: true,
          },
          skill: {
            path: fixture.skillPath,
            backupPath: skillBackup,
            stagePath: `${fixture.skillPath}.nelos-stage-${transactionId}`,
            existed: true,
            activated: true,
          },
          current: null,
          launchers: [
            {
              path: launcherPath,
              backupPath: launcherBackup,
              existed: true,
              activated: true,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const messages = [];
    await distributionInstallInternals.recoverTransaction(
      journalPath,
      fixture.env,
      (message) => messages.push(message),
      {
        codexCommand: fixture.codexPath,
        codexHome: fixture.codexHome,
        installRoot: fixture.installRoot,
        binDir: fixture.binDir,
        pluginSelector: "nelos@personal",
        pluginSource: fixture.pluginSource,
      },
    );
    assert.ok(messages.some((message) => message.includes("recovering interrupted")));
    await assertLegacyState(fixture);
    await assert.rejects(readFile(journalPath), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("symlinked destinations never modify an outside target", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.root, "outside");
  const outsideSkill = join(outside, "skill");
  try {
    await mkdir(outsideSkill, { recursive: true });
    await writeFile(join(outsideSkill, "SKILL.md"), "outside sentinel\n");
    await rm(fixture.skillPath, { recursive: true, force: true });
    await symlink(outsideSkill, fixture.skillPath);
    await assert.rejects(
      installFixture(fixture),
      new RegExp(`refusing symlinked skill directory: ${fixture.skillPath}`),
    );
    assert.equal(
      await readFile(join(outsideSkill, "SKILL.md"), "utf8"),
      "outside sentinel\n",
    );
    assert.equal(
      await readFile(join(fixture.pluginSource, "legacy-marker"), "utf8"),
      "legacy source\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("symlinked managed roots are rejected before outside content changes", async () => {
  for (const target of [
    "install-root",
    "bin-dir",
    "skill-root",
    "plugin-source-parent",
    "plugin-source",
    "plugin-cache",
  ]) {
    const fixture = await createFixture();
    const outside = join(fixture.root, `outside-${target}`);
    const sentinel = join(outside, "sentinel");
    try {
      if (target === "install-root") {
        await mkdir(outside, { recursive: true });
        await mkdir(dirname(fixture.installRoot), { recursive: true });
        await symlink(outside, fixture.installRoot);
      } else if (target === "bin-dir") {
        await rename(fixture.binDir, outside);
        await symlink(outside, fixture.binDir);
      } else if (target === "skill-root") {
        const skillRoot = dirname(fixture.skillPath);
        await rename(skillRoot, outside);
        await symlink(outside, skillRoot);
      } else if (target === "plugin-source-parent") {
        const sourceParent = dirname(fixture.pluginSource);
        await rename(sourceParent, outside);
        await symlink(outside, sourceParent);
      } else if (target === "plugin-source") {
        await rename(fixture.pluginSource, outside);
        await symlink(outside, fixture.pluginSource);
      } else {
        const cacheRoot = join(fixture.codexHome, "plugins", "cache");
        await rename(cacheRoot, outside);
        await symlink(outside, cacheRoot);
      }
      await writeFile(sentinel, "outside sentinel\n");
      await assert.rejects(installFixture(fixture), /symlink|real directory/);
      assert.equal(await readFile(sentinel, "utf8"), "outside sentinel\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("symlinked parents are rejected before missing children are created", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.root, "outside-plugin-parent");
  const pluginsRoot = join(fixture.codexHome, "plugins");
  try {
    await rm(pluginsRoot, { recursive: true, force: true });
    await mkdir(outside);
    await symlink(outside, pluginsRoot);
    await assert.rejects(
      installFixture(fixture),
      /plugin cache root contains a symlinked path component/,
    );
    await assert.rejects(readFile(join(outside, "cache")), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("managed verification rejects content drift and a provenance-copying CLI shadow", async () => {
  for (const drift of ["skill", "plugin", "cli-shadow", "plugin-disabled"]) {
    const fixture = await createFixture();
    try {
      const installed = await installFixture(fixture);
      let env = fixture.env;
      let sentinel = null;
      if (drift === "skill") {
        await writeFile(join(fixture.skillPath, "SKILL.md"), "tampered skill\n");
      } else if (drift === "plugin") {
        const manifest = join(installed.plugin.installedPath, ".codex-plugin", "plugin.json");
        await writeFile(manifest, `${await readFile(manifest, "utf8")}\n// tampered\n`);
      } else if (drift === "cli-shadow") {
        const maliciousRoot = join(fixture.root, "malicious-cli");
        const maliciousBin = join(maliciousRoot, "bin");
        sentinel = join(fixture.root, "malicious-cli-executed");
        await mkdir(maliciousBin, { recursive: true });
        await writeFile(
          join(maliciousBin, "nelos"),
          `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed\\n");\n`,
          { mode: 0o755 },
        );
        await writeFile(
          join(maliciousRoot, "distribution-provenance.json"),
          `${JSON.stringify(installed.provenance, null, 2)}\n`,
        );
        env = { ...fixture.env, PATH: `${maliciousBin}${delimiter}${fixture.env.PATH}` };
      } else {
        const statePath = join(fixture.codexHome, "fake-plugin-state.json");
        const state = JSON.parse(await readFile(statePath, "utf8"));
        await writeFile(statePath, `${JSON.stringify({ ...state, installed: false })}\n`);
      }

      const verified = await runVerifier(
        env,
        drift === "plugin-disabled" ? ["--codex", fixture.codexPath] : [],
      );
      assert.equal(verified.status, 1, `${drift}: ${verified.stdout}`);
      if (sentinel) {
        await assert.rejects(readFile(sentinel), { code: "ENOENT" });
        assert.match(verified.stderr, /active CLI is not the recorded release/);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("recovery removes a newly installed plugin from the pre-response crash window", async () => {
  const fixture = await createFixture();
  const transactionId = "pre-response-crash";
  const journalPath = join(fixture.installRoot, "install-transaction.json");
  const sourceBackup = `${fixture.pluginSource}.nelos-backup-${transactionId}`;
  try {
    await runFakeCodex(
      fixture.codexPath,
      ["plugin", "remove", "nelos@personal", "--json"],
      fixture.env,
    );
    await rename(fixture.pluginSource, sourceBackup);
    await createLegacyPluginSource(fixture.pluginSource);
    await writeFile(
      join(fixture.pluginSource, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({ name: "nelos", version: candidateVersion }, null, 2)}\n`,
    );
    await runFakeCodex(
      fixture.codexPath,
      ["plugin", "add", "nelos@personal", "--json"],
      fixture.env,
    );
    await mkdir(fixture.installRoot, { recursive: true });
    await writeFile(
      journalPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: transactionId,
          status: "active",
          codexCommand: fixture.codexPath,
          statePath: join(fixture.installRoot, "install-state.json"),
          previousState: null,
          plugin: {
            selector: "nelos@personal",
            previouslyInstalled: false,
            installAttempted: true,
            sourcePath: fixture.pluginSource,
            sourceBackupPath: sourceBackup,
            sourceStagePath: `${fixture.pluginSource}.nelos-stage-${transactionId}`,
            sourceExisted: true,
            sourceFingerprint:
              await distributionInstallInternals.treeFingerprint(sourceBackup),
            sourceActivated: true,
            activated: false,
          },
          skill: null,
          current: null,
          launchers: [],
        },
        null,
        2,
      )}\n`,
    );
    await distributionInstallInternals.recoverTransaction(
      journalPath,
      fixture.env,
      () => {},
      {
        codexCommand: fixture.codexPath,
        codexHome: fixture.codexHome,
        installRoot: fixture.installRoot,
        binDir: fixture.binDir,
        pluginSelector: "nelos@personal",
        pluginSource: fixture.pluginSource,
      },
    );
    const state = JSON.parse(
      await readFile(join(fixture.codexHome, "fake-plugin-state.json"), "utf8"),
    );
    assert.equal(state.installed, false);
    assert.equal(
      await readFile(join(fixture.pluginSource, "legacy-marker"), "utf8"),
      "legacy source\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery rejects forged journal paths before recursive cleanup", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.root, "outside-journal-target");
  const sentinel = join(outside, "sentinel");
  const journalPath = join(fixture.installRoot, "install-transaction.json");
  try {
    await mkdir(outside, { recursive: true });
    await writeFile(sentinel, "preserve\n");
    await mkdir(fixture.installRoot, { recursive: true });
    await writeFile(
      journalPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "forged-journal",
          status: "active",
          codexCommand: fixture.codexPath,
          statePath: join(fixture.installRoot, "install-state.json"),
          previousState: null,
          plugin: {
            selector: "nelos@personal",
            previouslyInstalled: true,
          },
          skill: {
            path: outside,
            backupPath: `${outside}.nelos-backup-forged-journal`,
            stagePath: `${outside}.nelos-stage-forged-journal`,
            existed: true,
          },
          current: null,
          launchers: [],
        },
        null,
        2,
      )}\n`,
    );
    await assert.rejects(
      installFixture(fixture),
      /unsafe transaction journal skill/,
    );
    assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("timed-out process groups are dead before rollback can begin", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-install-timeout-"));
  const command = join(root, "slow-command.cjs");
  const grandchild = join(root, "late-grandchild.cjs");
  const sentinel = join(root, "late-write");
  try {
    await writeFile(
      grandchild,
      `const fs = require("node:fs");\nprocess.on("SIGTERM", () => {});\nsetTimeout(() => fs.writeFileSync(${JSON.stringify(sentinel)}, "late\\n"), 900);\nsetInterval(() => {}, 1000);\n`,
    );
    await writeFile(
      command,
      `const { spawn } = require("node:child_process");\nprocess.on("SIGTERM", () => {});\nspawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`,
    );
    const started = Date.now();
    await assert.rejects(
      distributionInstallInternals.runCommand(process.execPath, [command], {
        timeoutMs: 150,
      }),
      /timed out/,
    );
    assert.ok(Date.now() - started >= 350);
    await delay(600);
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an earlier unknown PATH shadow aborts before any mutation", async () => {
  const fixture = await createFixture();
  const shadowDir = join(fixture.root, "shadow-bin");
  try {
    await mkdir(shadowDir, { recursive: true });
    await writeFile(join(shadowDir, "nelos"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const env = {
      ...fixture.env,
      PATH: `${shadowDir}${delimiter}${fixture.env.PATH}`,
    };
    await assert.rejects(
      installFixture(fixture, { env }),
      new RegExp(`PATH shadow ${join(shadowDir, "nelos")}`),
    );
    await assertLegacyState(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an earlier shadow of any managed companion command aborts", async () => {
  const fixture = await createFixture();
  const shadowDir = join(fixture.root, "shadow-companion-bin");
  try {
    await mkdir(shadowDir, { recursive: true });
    await writeFile(
      join(shadowDir, "nelos-verify-distribution"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const env = {
      ...fixture.env,
      PATH: `${shadowDir}${delimiter}${fixture.env.PATH}`,
    };
    await assert.rejects(
      installFixture(fixture, { env }),
      new RegExp(
        `PATH shadow ${join(shadowDir, "nelos-verify-distribution")}`,
      ),
    );
    await assertLegacyState(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("foreign launchers require force and an active install lock rejects concurrency", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      installFixture(fixture, { force: false }),
      new RegExp(`foreign executable exists at ${join(fixture.binDir, "nelos")}`),
    );
    const lockPath = join(
      fixture.installRoot,
      ".nelos-install.lock",
    );
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await assert.rejects(
      installFixture(fixture),
      { message: `another distribution install is active (pid ${process.pid})` },
    );
    await assertLegacyState(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the marketplace lock coordinates installers with different install roots", async () => {
  const fixture = await createFixture();
  const marketplaceRoot = join(fixture.home, ".agents", "plugins");
  let releaseMarketplaceLock = null;
  try {
    await mkdir(marketplaceRoot, { recursive: true });
    releaseMarketplaceLock = await distributionInstallInternals.acquireInstallLock(
      marketplaceRoot,
      {
        lockDirectory: ".nelos-marketplace.lock",
        scope: "personal marketplace update",
      },
    );
    await assert.rejects(
      installFixture(fixture, {
        installRoot: join(fixture.codexHome, "distributions", "alternate-root"),
      }),
      { message: `another personal marketplace update is active (pid ${process.pid})` },
    );
    await assertLegacyState(fixture);
  } finally {
    if (releaseMarketplaceLock) await releaseMarketplaceLock();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("lock inspection retries while a competing owner record is being initialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-install-lock-init-"));
  const lockPath = join(root, ".nelos-install.lock");
  try {
    await mkdir(lockPath, { recursive: true });
    const writer = delay(60).then(() =>
      writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      ),
    );
    await assert.rejects(
      distributionInstallInternals.acquireInstallLock(root),
      { message: `another distribution install is active (pid ${process.pid})` },
    );
    await writer;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale ownerless lock directory is recovered", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-install-lock-orphan-"));
  const lockPath = join(root, ".nelos-install.lock");
  try {
    await mkdir(lockPath, { recursive: true });
    await utimes(lockPath, new Date(0), new Date(0));
    const release = await distributionInstallInternals.acquireInstallLock(root);
    await release();
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired lock heartbeat permits recovery after PID reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-install-lock-heartbeat-"));
  const lockPath = join(root, ".nelos-install.lock");
  const ownerPath = join(lockPath, "owner.json");
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "expired-owner",
        startedAt: new Date(0).toISOString(),
        processIdentity: { "pid-only": String(process.pid) },
      })}\n`,
    );
    await utimes(ownerPath, new Date(0), new Date(0));
    const release = await distributionInstallInternals.acquireInstallLock(root);
    await release();
    await assert.rejects(readFile(ownerPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lock identity fallbacks never prove that a live owner was replaced", () => {
  const provesReplacement =
    distributionInstallInternals.processIdentitiesProveReplacement;
  const identitiesMatch = distributionInstallInternals.processIdentitiesMatch;
  const mayOwnLease = distributionInstallInternals.processMayOwnLease;
  assert.equal(
    provesReplacement("linux-start:100", "ps-start:Sat Jul 18 00:00:00 2026"),
    false,
  );
  assert.equal(provesReplacement("pid-only:42", "pid-only:43"), false);
  assert.equal(provesReplacement("linux-start:100", "linux-start:101"), true);
  assert.equal(
    provesReplacement(
      { "linux-start": "100", "ps-start": "start-a" },
      { "linux-start": "101", "ps-start": "start-b" },
    ),
    true,
  );
  assert.equal(
    provesReplacement(
      { "linux-start": "100", "ps-start": "same-second" },
      { "linux-start": "101", "ps-start": "same-second" },
    ),
    false,
  );
  assert.equal(
    identitiesMatch(
      { "linux-start": "100", "ps-start": "same-second" },
      { "linux-start": "101", "ps-start": "same-second" },
    ),
    true,
  );
  assert.equal(identitiesMatch({ "pid-only": "42" }, { "pid-only": "42" }), false);
  assert.equal(
    mayOwnLease({ "linux-start": "100" }, { "linux-start": "100" }, false),
    true,
  );
  assert.equal(
    mayOwnLease({ "linux-start": "100" }, { "linux-start": "101" }, true),
    false,
  );
  assert.equal(
    mayOwnLease({ "pid-only": "42" }, { "pid-only": "42" }, true),
    true,
  );
  assert.equal(
    mayOwnLease({ "pid-only": "42" }, { "pid-only": "42" }, false),
    false,
  );
});

test("plugin source fingerprints represent a missing source as a digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-plugin-source-missing-"));
  try {
    assert.match(
      await distributionInstallInternals.treeFingerprint(join(root, "missing")),
      /^[a-f0-9]{64}$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher replacement rechecks managed bin ancestry before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-launcher-ancestry-"));
  const binDir = join(root, "bin");
  const outside = join(root, "outside");
  try {
    await mkdir(binDir);
    await mkdir(outside);
    await rm(binDir, { recursive: true });
    await symlink(outside, binDir);
    await assert.rejects(
      distributionInstallInternals.replaceLaunchers({
        installRoot: join(root, "install"),
        binDir,
        launcherFingerprints: new Map(
          MANAGED_CLI_COMMANDS.map((command) => [command, "missing"]),
        ),
        journal: { id: "launcher-ancestry", launchers: [] },
        journalPath: join(root, "journal.json"),
      }),
      /managed bin directory (?:must be a real directory|contains a symlinked path component)/,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin source activation detects replacement after staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-plugin-source-race-"));
  const source = join(root, "plugin-source");
  const displaced = join(root, "displaced-source");
  const release = join(root, "release");
  const journalPath = join(root, "journal.json");
  try {
    await mkdir(join(source, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(source, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({ name: "nelos" })}\n`,
    );
    await writeFile(join(source, "original"), "preserve\n");
    await mkdir(release);
    await writeFile(join(release, "candidate"), "candidate\n");
    const staged = await distributionInstallInternals.stagePluginSource(
      source,
      release,
      "race-fixture",
    );
    await rename(source, displaced);
    await mkdir(source);
    await writeFile(join(source, "replacement"), "replacement\n");
    const journal = { id: "race-fixture", plugin: {} };
    await assert.rejects(
      distributionInstallInternals.activatePluginSource(
        staged,
        journal,
        journalPath,
      ),
      /plugin source changed after preflight/,
    );
    assert.equal(await readFile(join(source, "replacement"), "utf8"), "replacement\n");
    assert.equal(await readFile(join(displaced, "original"), "utf8"), "preserve\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin source activation detects in-place content edits after staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-plugin-source-edit-"));
  const source = join(root, "plugin-source");
  const release = join(root, "release");
  const journalPath = join(root, "journal.json");
  try {
    await mkdir(join(source, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(source, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({ name: "nelos" })}\n`,
    );
    const mutableFile = join(source, "mutable");
    await writeFile(mutableFile, "before\n");
    await mkdir(release);
    await writeFile(join(release, "candidate"), "candidate\n");
    const staged = await distributionInstallInternals.stagePluginSource(
      source,
      release,
      "edit-fixture",
    );
    await writeFile(mutableFile, "after!\n");
    await assert.rejects(
      distributionInstallInternals.activatePluginSource(
        staged,
        { id: "edit-fixture", plugin: {} },
        journalPath,
      ),
      /plugin source changed after preflight/,
    );
    assert.equal(await readFile(mutableFile, "utf8"), "after!\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin source activation fingerprints Git metadata and hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-plugin-source-git-edit-"));
  const source = join(root, "plugin-source");
  const release = join(root, "release");
  const journalPath = join(root, "journal.json");
  const hook = join(source, ".git", "hooks", "pre-commit");
  try {
    await mkdir(join(source, ".codex-plugin"), { recursive: true });
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(
      join(source, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({ name: "nelos" })}\n`,
    );
    await writeFile(hook, "before\n");
    await mkdir(release);
    await writeFile(join(release, "candidate"), "candidate\n");
    const staged = await distributionInstallInternals.stagePluginSource(
      source,
      release,
      "git-edit-fixture",
    );
    await writeFile(hook, "after!\n");
    await assert.rejects(
      distributionInstallInternals.activatePluginSource(
        staged,
        { id: "git-edit-fixture", plugin: {} },
        journalPath,
      ),
      /plugin source changed after preflight/,
    );
    assert.equal(await readFile(hook, "utf8"), "after!\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installation excludes relative or empty PATH components from command discovery", async () => {
  const fixture = await createFixture();
  try {
    const messages = [];
    const installed = await installFixture(fixture, {
      env: {
        ...fixture.env,
        FAKE_CODEX_REQUIRE_SAFE_PATH: "1",
        PATH: ["", "relative-bin", fixture.env.PATH].join(delimiter),
      },
      report: (message) => messages.push(message),
    });
    assert.equal(installed.provenance.revision, candidateVersion);
    assert.ok(
      messages.some((message) =>
        message.includes(
          "ignored 2 relative or empty PATH components; command discovery uses absolute entries only",
        ),
      ),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a nonstandard plugin source requires an exact destructive-replacement opt-in", async () => {
  const fixture = await createFixture();
  const customSource = join(fixture.home, "custom-plugin-source");
  try {
    await rename(fixture.pluginSource, customSource);
    const env = { ...fixture.env, FAKE_PLUGIN_SOURCE: customSource };
    await assert.rejects(
      installFixture(fixture, { env }),
      /Pass --plugin-source with that exact path only if replacing it is intentional/,
    );
    assert.equal(
      await readFile(join(customSource, "legacy-marker"), "utf8"),
      "legacy source\n",
    );
    const installed = await installFixture(fixture, {
      env,
      pluginSource: customSource,
    });
    assert.equal(installed.plugin.sourcePath, customSource);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("known legacy fingerprints remain allowlisted for the live migration", () => {
  assert.ok(
    distributionInstallInternals.LEGACY_HASHES.get("nelos").has(
      "67daffba89630769986e7b902925dd4d340b4121d5752ecca460b77afd45f8c1",
    ),
  );
  assert.ok(
    distributionInstallInternals.LEGACY_HASHES.get("nelos-title").has(
      "91b21ef37501c4c3d669e3fcc21e6751648967e28b3e19072563456088cf02c8",
    ),
  );
});

test("staging rejects package bin mappings that could escape the managed directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-malicious-bin-map-"));
  const candidate = join(root, "candidate");
  try {
    await mkdir(candidate, { recursive: true });
    for (const entry of DISTRIBUTION_ENTRIES) {
      await cp(join(packageRoot, entry), join(candidate, entry), {
        recursive: true,
      });
    }
    await cp(
      join(packageRoot, "distribution-provenance.json"),
      join(candidate, "distribution-provenance.json"),
    );
    const metadataPath = join(candidate, "package.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.bin["../../outside"] = "bin/nelos";
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await assert.rejects(
      stageDistribution({
        packageRoot: candidate,
        installRoot: join(root, "install"),
        env: process.env,
      }),
      /exactly the managed CLI commands/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging rejects managed CLI files without executable permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-non-executable-bin-"));
  const candidate = join(root, "candidate");
  try {
    await mkdir(candidate, { recursive: true });
    for (const entry of DISTRIBUTION_ENTRIES) {
      await cp(join(packageRoot, entry), join(candidate, entry), {
        recursive: true,
      });
    }
    await cp(
      join(packageRoot, "distribution-provenance.json"),
      join(candidate, "distribution-provenance.json"),
    );
    await chmod(join(candidate, "bin", "nelos"), 0o644);
    await assert.rejects(
      stageDistribution({
        packageRoot: candidate,
        installRoot: join(root, "install"),
        env: process.env,
      }),
      /managed CLI target is not executable: nelos/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging rejects content drift from bundled provenance integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-stale-provenance-"));
  const candidate = join(root, "candidate");
  try {
    await mkdir(candidate, { recursive: true });
    for (const entry of DISTRIBUTION_ENTRIES) {
      await cp(join(packageRoot, entry), join(candidate, entry), {
        recursive: true,
      });
    }
    await cp(
      join(packageRoot, "distribution-provenance.json"),
      join(candidate, "distribution-provenance.json"),
    );
    const readmePath = join(candidate, "README.md");
    await writeFile(
      readmePath,
      `${await readFile(readmePath, "utf8")}\nundeclared drift\n`,
    );
    await assert.rejects(
      stageDistribution({
        packageRoot: candidate,
        installRoot: join(root, "install"),
        env: process.env,
      }),
      /bundled provenance integrity is stale/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
