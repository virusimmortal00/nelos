import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { basename, delimiter, dirname, join } from "node:path";
import test from "node:test";

import { diagnoseDistribution } from "../src/distribution-doctor.mjs";
import { distributionInstallInternals } from "../src/distribution-install.mjs";
import {
  DISTRIBUTION_NAME,
  MANAGED_CLI_BINS,
  PLUGIN_NAME,
  REQUIRED_CLI_COMMANDS,
  computeDistributionIntegrity,
  computeFileIntegrity,
} from "../src/distribution-provenance.mjs";

async function canonicalMkdtemp(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function createDoctorFixture(root, { includeCorpus = true } = {}) {
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const installRoot = join(codexHome, "distributions", PLUGIN_NAME);
  const releasePath = join(installRoot, "releases", "test-release");
  const binDir = join(home, ".local", "bin");
  const skillPath = join(codexHome, "skills", "manage-nelos-tasks");
  const pluginSourcePath = join(home, "plugins", PLUGIN_NAME);
  const pluginInstalledPath = join(
    codexHome,
    "plugins",
    "cache",
    "personal",
    PLUGIN_NAME,
    "test-release",
  );
  for (const directory of [
    join(releasePath, ".codex-plugin"),
    join(releasePath, "assets"),
    join(releasePath, "bin"),
    join(releasePath, "completions"),
    ...(includeCorpus ? [join(releasePath, "corpus")] : []),
    join(releasePath, "docs"),
    join(releasePath, "skills"),
    join(releasePath, "src"),
    binDir,
    skillPath,
    pluginSourcePath,
    dirname(pluginInstalledPath),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await Promise.all([
    writeFile(join(releasePath, "README.md"), "trusted release\n"),
    writeFile(join(releasePath, "CHANGELOG.md"), "# Changelog\n"),
    writeFile(join(releasePath, ".mcp.json"), `${JSON.stringify({
      nelos: {
        command: "node",
        args: ["-e", "process.exit(0)"],
        env: { NELOS_PLUGIN_VERSION: "test-release" },
      },
    })}\n`),
    writeFile(join(releasePath, "package.json"), '{"name":"doctor-fixture"}\n'),
    writeFile(join(skillPath, "SKILL.md"), "# Trusted skill\n"),
    writeFile(
      join(codexHome, "config.toml"),
      '[plugins."nelos@personal".mcp_servers."nelos"]\nenabled = true\n',
    ),
  ]);
  for (const [command, packagePath] of Object.entries(MANAGED_CLI_BINS)) {
    const executablePath = join(releasePath, packagePath);
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o755);
    await symlink(executablePath, join(binDir, command));
  }
  const provenance = {
    schemaVersion: 1,
    distribution: DISTRIBUTION_NAME,
    revision: "test-release",
    integrity: await computeDistributionIntegrity(
      releasePath,
      { allowLegacyWithoutCorpus: !includeCorpus },
    ),
    skillIntegrity: await computeFileIntegrity(join(skillPath, "SKILL.md")),
    requiredCliCommands: [...REQUIRED_CLI_COMMANDS],
  };
  await writeFile(
    join(releasePath, "distribution-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  await cp(releasePath, pluginInstalledPath, { recursive: true });
  await writeFile(
    join(skillPath, "distribution-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  const codexCommand = await realpath(process.execPath);
  await writeFile(
    join(installRoot, "install-state.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      distribution: DISTRIBUTION_NAME,
      codexHome,
      installRoot,
      releasePath,
      binDir,
      skillPath,
      codexCommand,
      plugin: {
        selector: `${PLUGIN_NAME}@personal`,
        sourcePath: pluginSourcePath,
        installedPath: pluginInstalledPath,
      },
      provenance,
    }, null, 2)}\n`,
  );
  return {
    home,
    codexHome,
    installRoot,
    releasePath,
    binDir,
    skillPath,
    pluginInstalledPath,
    codexCommand,
    configPath: join(codexHome, "config.toml"),
  };
}

test("personal marketplace bootstrap is exact and idempotent", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const options = { home: root, marketplacePath: path, pluginIdentity: { name: "nelos", marketplaceName: "personal" }, sourcePath: join(root, "plugins", "nelos") };
    const transaction = join(root, "transaction.json");
    const initial = await distributionInstallInternals.ensurePersonalMarketplace(options);
    assert.equal(initial.created, true);
    await distributionInstallInternals.activateMarketplaceBootstrap(initial, transaction);
    await rm(transaction, { force: true });
    const first = await readFile(path, "utf8");
    const document = JSON.parse(first);
    assert.equal(document.interface.displayName, "Personal");
    assert.equal(document.plugins[0].source.path, "./plugins/nelos");
    assert.deepEqual(document.plugins[0].policy, {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    });
    assert.equal((await distributionInstallInternals.ensurePersonalMarketplace(options)).created, false);
    assert.equal(await readFile(path, "utf8"), first);
    await writeFile(path, '{"name":"foreign","plugins":[]}\n');
    await assert.rejects(distributionInstallInternals.ensurePersonalMarketplace(options), /conflicting local marketplace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace activation rejects a parent swap before writing intent", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-parent-swap-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(
      dirname(path),
      ".nelos-marketplace-transaction.json",
    );
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: PLUGIN_NAME, marketplaceName: "personal" },
      sourcePath: join(root, "plugins", PLUGIN_NAME),
    });
    const originalParent = join(root, "original-marketplace-parent");
    const outside = join(root, "outside");
    await rename(dirname(path), originalParent);
    await mkdir(outside);
    await symlink(outside, dirname(path));

    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(planned, transaction),
      /symlinked path component|changed after preflight/,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace activation never cleans through a parent swapped during linking", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-link-parent-swap-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const parent = dirname(path);
    const transaction = join(
      parent,
      ".nelos-marketplace-transaction.json",
    );
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: PLUGIN_NAME, marketplaceName: "personal" },
      sourcePath: join(root, "plugins", PLUGIN_NAME),
    });
    const originalParent = join(root, "original-marketplace-parent");
    const outside = join(root, "outside");
    const transactionSentinel = "outside transaction must survive\n";
    const candidateSentinel = "outside candidate must survive\n";

    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(
        planned,
        transaction,
        {
          beforeReplaceLink: async () => {
            const intent = JSON.parse(await readFile(transaction, "utf8"));
            const candidateName = basename(
              `${path}.nelos-exchange-${intent.exchangeId}.candidate`,
            );
            await rename(parent, originalParent);
            await mkdir(outside);
            await writeFile(
              join(outside, basename(transaction)),
              transactionSentinel,
            );
            await writeFile(join(outside, candidateName), candidateSentinel);
            await symlink(outside, parent);
          },
        },
      ),
      /symlinked path component|changed after preflight/,
    );
    assert.equal(
      await readFile(join(outside, basename(transaction)), "utf8"),
      transactionSentinel,
    );
    const outsideEntries = await readdir(outside);
    const candidateName = outsideEntries.find((entry) => entry.endsWith(".candidate"));
    assert.ok(candidateName);
    assert.equal(await readFile(join(outside, candidateName), "utf8"), candidateSentinel);
    await assert.rejects(readFile(join(outside, "marketplace.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace crash recovery refuses a concurrently replaced file", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-recovery-");
  try {
    const path = join(root, "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    const options = { home: root, marketplacePath: path, pluginIdentity: { name: "nelos", marketplaceName: "personal" }, sourcePath: join(root, "source") };
    const bootstrap = await distributionInstallInternals.ensurePersonalMarketplace(options);
    await distributionInstallInternals.activateMarketplaceBootstrap(bootstrap, transaction);
    await writeFile(path, '{"name":"foreign","plugins":[]}\n');
    await assert.rejects(distributionInstallInternals.recoverMarketplaceTransaction(transaction, path), /refusing recovery deletion/);
    assert.match(await readFile(path, "utf8"), /foreign/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical marketplace metadata and unrelated plugins coexist byte-for-byte", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-coexist-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    const bytes = `${JSON.stringify({
      name: "personal",
      interface: { displayName: "My Plugins", accent: "violet" },
      customMetadata: { owner: "developer" },
      plugins: [
        {
          name: "another-plugin",
          source: { source: "local", path: "/opt/another-plugin" },
          custom: true,
        },
        {
          name: "nelos",
          source: { source: "local", path: "./plugins/nelos" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Developer Tools",
        },
      ],
    }, null, 4)}\n`;
    await writeFile(path, bytes);
    const options = {
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    };
    const result = await distributionInstallInternals.ensurePersonalMarketplace(options);
    assert.equal(result.changed, false);
    assert.equal(result.state, "compatible");
    assert.equal(await readFile(path, "utf8"), bytes);

    const diagnosis = await diagnoseDistribution({
      home: root,
      marketplacePath: path,
      env: { PATH: "/usr/bin:/bin" },
    });
    const marketplace = diagnosis.checks.find(({ id }) => id === "marketplace");
    assert.equal(marketplace.status, "ok");
    assert.match(marketplace.summary, /unambiguous local Nelos source/);
    assert.equal(await readFile(path, "utf8"), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace update rollback restores exact bytes and mode", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-update-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    const original = '{\n  "name": "personal",\n  "interface": { "displayName": "Preserve Me" },\n  "plugins": [{ "name": "other", "source": { "source": "local", "path": "/opt/other" }, "keep": [1, 2, 3] }]\n}\n';
    await writeFile(path, original, { mode: 0o640 });
    await chmod(path, 0o640);
    const options = {
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    };
    const planned = await distributionInstallInternals.ensurePersonalMarketplace(options);
    assert.equal(planned.updated, true);
    const active = await distributionInstallInternals.activateMarketplaceBootstrap(planned, transaction);
    assert.equal(active.updated, true);
    const updated = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(updated.interface, { displayName: "Preserve Me" });
    assert.equal(updated.plugins[0].keep[2], 3);
    assert.equal(updated.plugins[1].name, "nelos");
    assert.equal((await stat(path)).mode & 0o777, 0o640);

    await distributionInstallInternals.recoverMarketplaceTransaction(transaction, path);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    await assert.rejects(stat(transaction), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace recovery restores an update interrupted after displacement", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-displaced-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(dirname(path), { recursive: true });
    const original = '{\n  "name": "personal",\n  "plugins": [{ "name": "other", "source": { "source": "local", "path": "/opt/other" } }]\n}\n';
    await writeFile(path, original, { mode: 0o640 });
    await chmod(path, 0o640);
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    });

    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(
        planned,
        transaction,
        { testInterruption: "displaced" },
      ),
      /injected marketplace interruption after displaced/,
    );
    await assert.rejects(stat(path), /ENOENT/);
    const intent = JSON.parse(await readFile(transaction, "utf8"));
    const prefix = `${path}.nelos-exchange-${intent.exchangeId}`;
    assert.equal((await stat(`${prefix}.displaced`)).isFile(), true);
    assert.equal((await stat(`${prefix}.candidate`)).isFile(), true);

    await distributionInstallInternals.recoverMarketplaceTransaction(transaction, path);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    await assert.rejects(stat(transaction), /ENOENT/);
    assert.deepEqual(
      (await readdir(dirname(path))).filter((entry) =>
        entry.startsWith(`${basename(path)}.nelos-exchange-`)),
      [],
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor reports four distinct bundled MCP states with one fixed recovery", async () => {
  const scenarios = [
    {
      state: "missing",
      mutate: async (fixture) => rm(join(fixture.pluginInstalledPath, ".mcp.json")),
    },
    {
      state: "disabled",
      mutate: async (fixture) => writeFile(
        fixture.configPath,
        'unrelated_secret = "DO_NOT_ECHO_DOCTOR"\n',
      ),
    },
    {
      state: "incompatible",
      mutate: async (fixture) => writeFile(
        join(fixture.pluginInstalledPath, ".mcp.json"),
        '{"nelos":{"command":"node","args":[],"env":{"NELOS_PLUGIN_VERSION":"DO_NOT_ECHO_DOCTOR"}}}\n',
      ),
    },
    { state: "healthy", mutate: async () => {} },
  ];
  for (const scenario of scenarios) {
    const root = await canonicalMkdtemp(`nelos-doctor-mcp-${scenario.state}-`);
    try {
      const fixture = await createDoctorFixture(root);
      await scenario.mutate(fixture);
      const diagnosis = await diagnoseDistribution({
        home: fixture.home,
        codexHome: fixture.codexHome,
        installRoot: fixture.installRoot,
        codexCommand: fixture.codexCommand,
        env: { PATH: fixture.binDir },
      });
      const check = diagnosis.checks.find(({ id }) => id === "bundled-mcp-server");
      assert.equal(check.state, scenario.state);
      assert.equal(check.nextStep === null, scenario.state === "healthy");
      if (scenario.state === "disabled") {
        assert.equal(
          check.nextStep,
          '[plugins."nelos@personal".mcp_servers."nelos"]\nenabled = true',
        );
      }
      assert.doesNotMatch(JSON.stringify(check), /DO_NOT_ECHO_DOCTOR/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("marketplace recovery restores an update interrupted after replacement link", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-linked-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(dirname(path), { recursive: true });
    const original = '{"name":"personal","plugins":[{"name":"other","source":{"source":"local","path":"/opt/other"}}]}\n';
    await writeFile(path, original, { mode: 0o640 });
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    });

    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(
        planned,
        transaction,
        { testInterruption: "linked" },
      ),
      /injected marketplace interruption after linked/,
    );
    assert.match(await readFile(path, "utf8"), /nelos/);
    const intent = JSON.parse(await readFile(transaction, "utf8"));
    const prefix = `${path}.nelos-exchange-${intent.exchangeId}`;
    assert.equal((await stat(`${prefix}.displaced`)).isFile(), true);
    assert.equal((await stat(`${prefix}.candidate`)).isFile(), true);

    await distributionInstallInternals.recoverMarketplaceTransaction(transaction, path);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    await assert.rejects(stat(transaction), /ENOENT/);
    assert.deepEqual(
      (await readdir(dirname(path))).filter((entry) =>
        entry.startsWith(`${basename(path)}.nelos-exchange-`)),
      [],
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace recovery discards a partial journaled candidate before mutation", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-partial-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(dirname(path), { recursive: true });
    const original = '{"name":"personal","plugins":[]}\n';
    await writeFile(path, original, { mode: 0o640 });
    await chmod(path, 0o640);
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    });
    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(
        planned,
        transaction,
        { testInterruption: "candidate" },
      ),
      /injected marketplace interruption after candidate/,
    );
    const intent = JSON.parse(await readFile(transaction, "utf8"));
    const candidate = `${path}.nelos-exchange-${intent.exchangeId}.candidate`;
    await writeFile(candidate, "{partial");
    await chmod(path, 0o600);

    await distributionInstallInternals.recoverMarketplaceTransaction(transaction, path);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(stat(candidate), /ENOENT/);
    await assert.rejects(stat(transaction), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace recovery rebuilds a missing preimage after a partial candidate", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-partial-missing-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(dirname(path), { recursive: true });
    const original = '{"name":"personal","plugins":[]}\n';
    await writeFile(path, original, { mode: 0o640 });
    await chmod(path, 0o640);
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    });
    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(
        planned,
        transaction,
        { testInterruption: "candidate" },
      ),
      /injected marketplace interruption after candidate/,
    );
    const intent = JSON.parse(await readFile(transaction, "utf8"));
    const candidate = `${path}.nelos-exchange-${intent.exchangeId}.candidate`;
    await writeFile(candidate, "{partial");
    await rm(path);

    await distributionInstallInternals.recoverMarketplaceTransaction(transaction, path);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    await assert.rejects(stat(candidate), /ENOENT/);
    await assert.rejects(stat(transaction), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace recovery restores the exact displaced preimage mode", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-displaced-mode-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(dirname(path), { recursive: true });
    const original = '{"name":"personal","plugins":[]}\n';
    await writeFile(path, original, { mode: 0o640 });
    await chmod(path, 0o640);
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    });
    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(
        planned,
        transaction,
        { testInterruption: "candidate" },
      ),
      /injected marketplace interruption after candidate/,
    );
    const intent = JSON.parse(await readFile(transaction, "utf8"));
    const prefix = `${path}.nelos-exchange-${intent.exchangeId}`;
    await chmod(path, 0o600);
    await rename(path, `${prefix}.displaced`);

    await distributionInstallInternals.recoverMarketplaceTransaction(transaction, path);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(stat(`${prefix}.candidate`), /ENOENT/);
    await assert.rejects(stat(`${prefix}.displaced`), /ENOENT/);
    await assert.rejects(stat(transaction), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace append preserves unrelated JSON numbers losslessly", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-lossless-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    const original = '{"name":"personal","metadata":{"id":9007199254740993,"ratio":1.2300},"plugins":[{"name":"other","source":{"source":"local","path":"/opt/other"}}]}\n';
    await writeFile(path, original);
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    });
    await distributionInstallInternals.activateMarketplaceBootstrap(planned, transaction);
    const updated = await readFile(path, "utf8");
    assert.match(updated, /"id":9007199254740993/);
    assert.match(updated, /"ratio":1\.2300/);
    assert.match(updated, /"name":"other"/);
    assert.match(updated, /"name":"nelos"/);
    await distributionInstallInternals.recoverMarketplaceTransaction(transaction, path);
    assert.equal(await readFile(path, "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("committed marketplace update recovery preserves the appended entry", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-commit-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    await writeFile(path, '{"name":"personal","plugins":[{"name":"other","source":{"source":"local","path":"/opt/other"}}]}\n');
    const options = {
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    };
    const planned = await distributionInstallInternals.ensurePersonalMarketplace(options);
    await distributionInstallInternals.activateMarketplaceBootstrap(planned, transaction);
    const committedBytes = await readFile(path, "utf8");
    await distributionInstallInternals.recoverMarketplaceTransaction(
      transaction,
      path,
      { preserve: true },
    );
    assert.equal(await readFile(path, "utf8"), committedBytes);
    assert.equal(JSON.parse(committedBytes).plugins.at(-1).name, "nelos");
    await assert.rejects(stat(transaction), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared marketplace recovery honors a committed owner from another install root", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-cross-root-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(
      dirname(path),
      ".nelos-marketplace-transaction.json",
    );
    const ownerJournalPath = join(root, "install-a", "install-transaction.json");
    const ownerTransactionId = "install-a-transaction";
    const options = {
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    };
    const planned = await distributionInstallInternals.ensurePersonalMarketplace(options);
    await distributionInstallInternals.activateMarketplaceBootstrap(
      planned,
      transaction,
      { ownerJournalPath, ownerTransactionId },
    );
    await mkdir(dirname(ownerJournalPath), { recursive: true });
    await writeFile(ownerJournalPath, `${JSON.stringify({
      id: ownerTransactionId,
      status: "committed",
    })}\n`);

    await distributionInstallInternals.recoverMarketplaceTransaction(transaction, path);
    assert.equal(
      (await distributionInstallInternals.ensurePersonalMarketplace(options)).state,
      "compatible",
    );
    await distributionInstallInternals.recoverMarketplaceTransaction(transaction, path);
    assert.equal((await stat(path)).isFile(), true);

    await rm(path);
    const nextOwnerJournalPath = join(root, "install-c", "install-transaction.json");
    const nextOwnerTransactionId = "install-c-transaction";
    const nextPlan = await distributionInstallInternals.ensurePersonalMarketplace(options);
    await distributionInstallInternals.activateMarketplaceBootstrap(
      nextPlan,
      transaction,
      {
        ownerJournalPath: nextOwnerJournalPath,
        ownerTransactionId: nextOwnerTransactionId,
      },
    );
    await mkdir(dirname(nextOwnerJournalPath), { recursive: true });
    await writeFile(nextOwnerJournalPath, `${JSON.stringify({
      id: nextOwnerTransactionId,
      status: "active",
    })}\n`);
    await assert.rejects(
      distributionInstallInternals.recoverMarketplaceTransaction(transaction, path),
      /belongs to an incomplete distribution/,
    );
    assert.equal((await stat(path)).isFile(), true);
    await writeFile(nextOwnerJournalPath, `${JSON.stringify({
      id: "different-owner-transaction",
      status: "committed",
    })}\n`);
    await assert.rejects(
      distributionInstallInternals.recoverMarketplaceTransaction(transaction, path),
      /owner evidence does not match/,
    );
    assert.equal((await stat(path)).isFile(), true);
    assert.equal((await stat(transaction)).isFile(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared recovery settles committed marketplace intent before owner evidence", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-order-");
  try {
    const home = root;
    const codexHome = join(root, ".codex");
    const installRoot = join(codexHome, "distributions", "nelos");
    const binDir = join(root, ".local", "bin");
    const sourcePath = join(root, "plugins", "nelos");
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const journalPath = join(installRoot, "install-transaction.json");
    const transactionPath = join(
      dirname(path),
      ".nelos-marketplace-transaction.json",
    );
    const transactionId = "committed-order-probe";
    const expected = {
      codexCommand: process.execPath,
      codexHome,
      installRoot,
      binDir,
      pluginSelector: "nelos@personal",
      pluginSource: sourcePath,
    };
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath,
    });
    await distributionInstallInternals.activateMarketplaceBootstrap(
      planned,
      transactionPath,
      { ownerJournalPath: journalPath, ownerTransactionId: transactionId },
    );
    const committedBytes = await readFile(path);
    await mkdir(installRoot, { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schemaVersion: 1,
      id: transactionId,
      status: "committed",
      codexCommand: process.execPath,
      statePath: join(installRoot, "install-state.json"),
      plugin: { selector: "nelos@personal" },
      launchers: [],
    })}\n`);

    await assert.rejects(
      distributionInstallInternals.recoverDistributionTransactions({
        journalPath,
        marketplaceTransactionPath: transactionPath,
        legacyMarketplaceTransactionPath: join(
          installRoot,
          "marketplace-transaction.json",
        ),
        marketplacePath: path,
        env: process.env,
        report: () => {},
        expected,
        afterMarketplaceRecovery: () => {
          throw new Error("injected recovery interruption");
        },
      }),
      /injected recovery interruption/,
    );
    assert.deepEqual(await readFile(path), committedBytes);
    assert.equal((await stat(journalPath)).isFile(), true);
    await assert.rejects(stat(transactionPath), /ENOENT/);

    await distributionInstallInternals.recoverDistributionTransactions({
      journalPath,
      marketplaceTransactionPath: transactionPath,
      legacyMarketplaceTransactionPath: join(
        installRoot,
        "marketplace-transaction.json",
      ),
      marketplacePath: path,
      env: process.env,
      report: () => {},
      expected,
    });
    assert.deepEqual(await readFile(path), committedBytes);
    await assert.rejects(stat(journalPath), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("released marketplace journals recover and dual locations fail closed", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-legacy-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const installRoot = join(root, ".codex", "distributions", "nelos");
    const journalPath = join(installRoot, "install-transaction.json");
    const legacyPath = join(installRoot, "marketplace-transaction.json");
    const sharedPath = join(
      dirname(path),
      ".nelos-marketplace-transaction.json",
    );
    const bytes = Buffer.from('{"name":"personal","plugins":[]}\n');
    const intent = {
      schemaVersion: 1,
      operation: "create-personal-marketplace",
      path,
      expectedFingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
    const expected = {
      codexCommand: process.execPath,
      codexHome: join(root, ".codex"),
      installRoot,
      binDir: join(root, ".local", "bin"),
      pluginSelector: "nelos@personal",
      pluginSource: join(root, "plugins", "nelos"),
    };
    await mkdir(dirname(path), { recursive: true });
    await mkdir(installRoot, { recursive: true });
    await writeFile(path, bytes);
    await writeFile(legacyPath, `${JSON.stringify(intent)}\n`);

    await distributionInstallInternals.recoverDistributionTransactions({
      journalPath,
      marketplaceTransactionPath: sharedPath,
      legacyMarketplaceTransactionPath: legacyPath,
      marketplacePath: path,
      env: process.env,
      report: () => {},
      expected,
    });
    await assert.rejects(stat(path), /ENOENT/);
    await assert.rejects(stat(legacyPath), /ENOENT/);

    await writeFile(path, bytes);
    await writeFile(legacyPath, `${JSON.stringify(intent)}\n`);
    await writeFile(sharedPath, `${JSON.stringify(intent)}\n`);
    await assert.rejects(
      distributionInstallInternals.recoverDistributionTransactions({
        journalPath,
        marketplaceTransactionPath: sharedPath,
        legacyMarketplaceTransactionPath: legacyPath,
        marketplacePath: path,
        env: process.env,
        report: () => {},
        expected,
      }),
      /both shared and legacy marketplace transactions exist/,
    );
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await stat(legacyPath)).isFile(), true);
    assert.equal((await stat(sharedPath)).isFile(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace update intent cannot overwrite a concurrent writer", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-cas-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    await writeFile(path, '{"name":"personal","plugins":[]}\n');
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    });
    const concurrent = '{"name":"personal","plugins":[{"name":"concurrent","source":{"source":"local","path":"/opt/concurrent"}}]}\n';
    await writeFile(path, concurrent);
    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(planned, transaction),
      /marketplace changed before atomic replacement/,
    );
    assert.equal(await readFile(path, "utf8"), concurrent);
    await assert.rejects(stat(transaction), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace update intent preserves a concurrent mode change", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-mode-cas-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(dirname(path), { recursive: true });
    const original = '{"name":"personal","plugins":[]}\n';
    await writeFile(path, original, { mode: 0o640 });
    await chmod(path, 0o640);
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    });
    await chmod(path, 0o600);

    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(planned, transaction),
      /marketplace mode changed before atomic replacement/,
    );
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(stat(transaction), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace replacement cannot clobber a writer after fingerprint validation", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-link-cas-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    await writeFile(path, '{"name":"personal","plugins":[]}\n');
    const planned = await distributionInstallInternals.ensurePersonalMarketplace({
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    });
    const concurrent = '{"name":"personal","plugins":[{"name":"late-writer","source":{"source":"local","path":"/opt/late"}}]}\n';
    await assert.rejects(
      distributionInstallInternals.activateMarketplaceBootstrap(
        planned,
        transaction,
        { beforeReplaceLink: () => writeFile(path, concurrent, { flag: "wx" }) },
      ),
      /marketplace changed during atomic replacement/,
    );
    assert.equal(await readFile(path, "utf8"), concurrent);
    await assert.rejects(
      distributionInstallInternals.recoverMarketplaceTransaction(transaction, path),
      /refusing recovery replacement/,
    );
    assert.equal(await readFile(path, "utf8"), concurrent);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing canonical target metadata is repaired while conflicts fail closed", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-policy-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const transaction = join(root, "transaction.json");
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    const minimal = '{"name":"personal","plugins":[{"name":"nelos","source":{"source":"local","path":"./plugins/nelos"},"custom":"preserve"}]}\n';
    await writeFile(path, minimal);
    const options = {
      home: root,
      marketplacePath: path,
      pluginIdentity: { name: "nelos", marketplaceName: "personal" },
      sourcePath: join(root, "plugins", "nelos"),
    };
    const beforeRepair = await diagnoseDistribution({
      home: root,
      marketplacePath: path,
      env: { PATH: "/usr/bin:/bin" },
    });
    assert.match(
      beforeRepair.checks.find(({ id }) => id === "marketplace").summary,
      /canonical policy metadata/,
    );
    const planned = await distributionInstallInternals.ensurePersonalMarketplace(options);
    assert.equal(planned.state, "bootstrap-ready");
    await distributionInstallInternals.activateMarketplaceBootstrap(planned, transaction);
    await rm(transaction, { force: true });
    const repaired = JSON.parse(await readFile(path, "utf8"));
    assert.equal(repaired.plugins[0].custom, "preserve");
    assert.deepEqual(repaired.plugins[0].policy, {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    });
    assert.equal(repaired.plugins[0].category, "Developer Tools");
    assert.equal(
      (await distributionInstallInternals.ensurePersonalMarketplace(options)).state,
      "compatible",
    );

    for (const conflict of [
      { policy: { installation: "DENY", authentication: "ON_INSTALL" }, category: "Developer Tools" },
      { policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Untrusted" },
    ]) {
      const document = {
        name: "personal",
        plugins: [{
          name: "nelos",
          source: { source: "local", path: "./plugins/nelos" },
          ...conflict,
        }],
      };
      await writeFile(path, `${JSON.stringify(document)}\n`);
      await assert.rejects(
        distributionInstallInternals.ensurePersonalMarketplace(options),
        /conflicting local marketplace/,
      );
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace ownership and relative-path conflicts fail without writes", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-conflict-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    const target = (source) => ({ name: "nelos", source });
    const conflicts = [
      { name: "personal", plugins: [target({ source: "remote", path: "./plugins/nelos" })] },
      { name: "personal", plugins: [target({ source: "local", path: "/tmp/foreign" })] },
      { name: "personal", plugins: [target({ source: "local", path: "./plugins/../plugins/nelos" })] },
      { name: "personal", plugins: [target({ source: "local", path: "./plugins/nelos" }), target({ source: "local", path: "./plugins/nelos" })] },
      { name: "foreign", plugins: [] },
      { name: "personal", plugins: "not-an-array" },
    ];
    for (const document of conflicts) {
      const bytes = `${JSON.stringify(document)}\n`;
      await writeFile(path, bytes);
      await assert.rejects(
        distributionInstallInternals.ensurePersonalMarketplace({
          home: root,
          marketplacePath: path,
          pluginIdentity: { name: "nelos", marketplaceName: "personal" },
          sourcePath: join(root, "plugins", "nelos"),
        }),
        /conflicting local marketplace/,
      );
      assert.equal(await readFile(path, "utf8"), bytes);
    }

    const customPath = join(root, "custom", "marketplace.json");
    await mkdir(join(root, "custom"), { recursive: true });
    const customBytes = '{"name":"personal","plugins":[{"name":"nelos","source":{"source":"local","path":"./plugins/nelos"}}]}\n';
    await writeFile(customPath, customBytes);
    await assert.rejects(
      distributionInstallInternals.ensurePersonalMarketplace({
        home: root,
        marketplacePath: customPath,
        pluginIdentity: { name: "nelos", marketplaceName: "personal" },
        sourcePath: join(root, "plugins", "nelos"),
      }),
      /conflicting local marketplace/,
    );
    assert.equal(await readFile(customPath, "utf8"), customBytes);

    const duplicateKeyBytes = '{"name":"personal","plugins":[],"plugins":[{"name":"nelos","source":{"source":"local","path":"./plugins/nelos"}}]}\n';
    await writeFile(path, duplicateKeyBytes);
    await assert.rejects(
      distributionInstallInternals.ensurePersonalMarketplace({
        home: root,
        marketplacePath: path,
        pluginIdentity: { name: "nelos", marketplaceName: "personal" },
        sourcePath: join(root, "plugins", "nelos"),
      }),
      /malformed local marketplace/,
    );
    assert.equal(await readFile(path, "utf8"), duplicateKeyBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace semantic conflicts do not echo arbitrary plugin names", async () => {
  const root = await canonicalMkdtemp("nelos-marketplace-secret-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const secret = "TOP_SECRET_PLUGIN_NAME";
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      name: "personal",
      plugins: [
        { name: secret, source: { source: "local", path: "/opt/first" } },
        { name: secret, source: { source: "local", path: "/opt/second" } },
      ],
    })}\n`);
    let failure;
    try {
      await distributionInstallInternals.ensurePersonalMarketplace({
        home: root,
        marketplacePath: path,
        pluginIdentity: { name: PLUGIN_NAME, marketplaceName: "personal" },
        sourcePath: join(root, "plugins", PLUGIN_NAME),
      });
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message ?? "", /conflicting local marketplace/);
    assert.doesNotMatch(failure.message, new RegExp(secret));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor distinguishes safe bootstrap-ready marketplace states", async () => {
  const root = await canonicalMkdtemp("nelos-doctor-bootstrap-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    const missing = await diagnoseDistribution({
      home: root,
      marketplacePath: path,
      env: { PATH: "/usr/bin:/bin" },
    });
    const missingCheck = missing.checks.find(({ id }) => id === "marketplace");
    assert.equal(missingCheck.status, "warning");
    assert.match(missingCheck.summary, /ready for safe bootstrap/);

    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    const unrelated = '{"name":"personal","interface":{"displayName":"Personal"},"plugins":[{"name":"other","source":{"source":"local","path":"/opt/other"}}]}\n';
    await writeFile(path, unrelated);
    const ready = await diagnoseDistribution({
      home: root,
      marketplacePath: path,
      env: { PATH: "/usr/bin:/bin" },
    });
    const readyCheck = ready.checks.find(({ id }) => id === "marketplace");
    assert.equal(readyCheck.status, "warning");
    assert.match(readyCheck.summary, /ready for a Nelos entry/);
    assert.equal(await readFile(path, "utf8"), unrelated);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor bounds malformed marketplace content without echoing it", async () => {
  const root = await canonicalMkdtemp("nelos-doctor-malformed-marketplace-");
  try {
    const path = join(root, ".agents", "plugins", "marketplace.json");
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    const secret = "do-not-echo-marketplace-token";
    await writeFile(path, `{malformed:${secret}`);
    const result = await diagnoseDistribution({
      home: root,
      marketplacePath: path,
      env: { PATH: "/usr/bin:/bin" },
    });
    assert.equal(result.checks.find(({ id }) => id === "marketplace").status, "error");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor is read-only and fails closed on a PATH shadow", async () => {
  const root = await canonicalMkdtemp("nelos-doctor-");
  try {
    const home = join(root, "home");
    const shadow = join(root, "shadow");
    await mkdir(shadow, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(shadow, "codex"), `#!/bin/sh\necho should-not-run > ${join(root, "marker")}\n`);
    await chmod(join(shadow, "codex"), 0o755);
    const result = await diagnoseDistribution({ home, env: { PATH: `${shadow}::relative` } });
    assert.equal(result.readOnly, true);
    assert.equal(result.ok, false);
    assert.equal(result.checks.find(({ id }) => id === "codex-executable").status, "error");
    await assert.rejects(readFile(join(root, "marker")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor bounds malformed state, endpoint descriptors, and foreign marketplaces", async () => {
  const root = await canonicalMkdtemp("nelos-doctor-adversarial-");
  try {
    const home = join(root, "home");
    const codexHome = join(home, ".codex");
    const installRoot = join(codexHome, "distributions", "nelos");
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, "install-state.json"), '{"schemaVersion":1,"distribution":"nelos","plugin":null}\n');
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "marketplace.json"), '{"name":"personal","plugins":[{"name":"nelos","source":{"source":"local","path":"/tmp/foreign-source"}},{"name":"extra","source":{"source":"local","path":"/tmp/extra"}}]}\n');
    await mkdir(join(home, ".agents"), { recursive: true });
    await symlink(outside, join(home, ".agents", "plugins"));
    const secret = "do-not-echo-this-token";
    const result = await diagnoseDistribution({ home, codexHome, installRoot, env: { PATH: "/usr/bin:/bin", CODEX_APP_SERVER_CONTROL_ENDPOINT: `{malformed:${secret}` } });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find(({ id }) => id === "distribution").status, "error");
    assert.equal(result.checks.find(({ id }) => id === "marketplace").status, "error");
    assert.equal(result.checks.find(({ id }) => id === "host-endpoint").status, "error");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor does not claim a non-Codex Unix socket is compatible", async () => {
  const root = await canonicalMkdtemp("nelos-doctor-socket-");
  const socketPath = join(root, "not-codex.sock");
  const server = net.createServer((socket) => socket.end());
  try {
    await new Promise((resolvePromise, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolvePromise()));
    const result = await diagnoseDistribution({ home: root, socketPath, env: { PATH: "/usr/bin:/bin" } });
    const endpoint = result.checks.find(({ id }) => id === "host-endpoint");
    assert.equal(endpoint.status, "warning");
    assert.match(endpoint.summary, /compatibility is unverified/);
    assert.doesNotMatch(endpoint.summary, /compatible app-server endpoint/);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor binds selected Codex and PATH launchers to recorded install state", async () => {
  const root = await canonicalMkdtemp("nelos-doctor-binding-");
  try {
    const fixture = await createDoctorFixture(root);
    const healthy = await diagnoseDistribution({
      ...fixture,
      env: { PATH: fixture.binDir },
    });
    assert.equal(healthy.ok, true);
    assert.equal(
      healthy.checks.find(({ id }) => id === "coherence").status,
      "ok",
    );

    const copiedRelease = join(root, "copied-release");
    const shadowBin = join(root, "shadow-bin");
    await cp(fixture.releasePath, copiedRelease, { recursive: true });
    await mkdir(shadowBin);
    for (const [command, packagePath] of Object.entries(MANAGED_CLI_BINS)) {
      await symlink(join(copiedRelease, packagePath), join(shadowBin, command));
    }
    const inactiveDuplicates = await diagnoseDistribution({
      ...fixture,
      env: { PATH: `${fixture.binDir}${delimiter}${shadowBin}` },
    });
    assert.equal(inactiveDuplicates.ok, true);
    assert.equal(
      inactiveDuplicates.checks.find(
        ({ id }) => id === "cli-path-duplicates",
      ).status,
      "warning",
    );

    const otherCodex = join(root, "other-codex");
    await writeFile(otherCodex, "#!/bin/sh\nexit 0\n");
    await chmod(otherCodex, 0o755);
    const mismatchedCodex = await diagnoseDistribution({
      ...fixture,
      codexCommand: otherCodex,
      env: { PATH: fixture.binDir },
    });
    assert.equal(mismatchedCodex.ok, false);
    assert.equal(
      mismatchedCodex.checks.find(({ id }) => id === "coherence").status,
      "error",
    );

    const shadowedCli = await diagnoseDistribution({
      ...fixture,
      env: { PATH: `${shadowBin}${delimiter}${fixture.binDir}` },
    });
    assert.equal(shadowedCli.ok, false);
    assert.equal(
      shadowedCli.checks.find(({ id }) => id === "coherence").status,
      "error",
    );
    assert.equal(
      shadowedCli.checks.some(({ id }) => id === "cli-path-duplicates"),
      false,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor verifies release, skill, and plugin bytes rather than provenance alone", async () => {
  const root = await canonicalMkdtemp("nelos-doctor-integrity-");
  try {
    const fixture = await createDoctorFixture(root);
    const diagnose = () => diagnoseDistribution({
      ...fixture,
      env: { PATH: fixture.binDir },
    });

    await writeFile(join(fixture.releasePath, "README.md"), "tampered release\n");
    const releaseTamper = await diagnose();
    assert.equal(
      releaseTamper.checks.find(({ id }) => id === "distribution").status,
      "error",
    );
    await writeFile(join(fixture.releasePath, "README.md"), "trusted release\n");

    await writeFile(join(fixture.skillPath, "SKILL.md"), "# Tampered skill\n");
    const skillTamper = await diagnose();
    assert.equal(
      skillTamper.checks.find(({ id }) => id === "coherence").status,
      "error",
    );
    await writeFile(join(fixture.skillPath, "SKILL.md"), "# Trusted skill\n");

    await writeFile(
      join(fixture.pluginInstalledPath, "README.md"),
      "tampered plugin\n",
    );
    const pluginTamper = await diagnose();
    assert.equal(
      pluginTamper.checks.find(({ id }) => id === "coherence").status,
      "error",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor verifies a pre-corpus release with its legacy integrity entry set", async () => {
  const root = await canonicalMkdtemp("nelos-doctor-legacy-integrity-");
  try {
    const fixture = await createDoctorFixture(root, { includeCorpus: false });
    const diagnosis = await diagnoseDistribution({
      ...fixture,
      env: { PATH: fixture.binDir },
    });
    assert.equal(
      diagnosis.checks.find(({ id }) => id === "distribution").status,
      "ok",
    );
    assert.equal(
      diagnosis.checks.find(({ id }) => id === "coherence").status,
      "ok",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
