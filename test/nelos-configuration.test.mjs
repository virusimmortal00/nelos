import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  NELOS_CLEANUP_POLICY_KEY,
  NelosConfigStoreV1,
  NelosConfigurationV1,
  legacyCleanupPreferencePath,
  parseNelosConfig,
  resolveNelosConfigPath,
} from "../src/nelos-configuration.mjs";

test("the pinned TOML parser and license match the reviewed package", async () => {
  for (const [path, expected] of [
    [
      "../src/vendor/smol-toml-1.6.0.cjs",
      "db5bf42d36ba6c950c9bd651026be9a771e55a2c82f8b64866de8928d04e1fd1",
    ],
    [
      "../src/vendor/smol-toml-1.6.0.LICENSE",
      "fa5659948374d4f555594f47f6da073b40dc503e921aeeece30df4362b3051a5",
    ],
  ]) {
    const digest = createHash("sha256")
      .update(await readFile(new URL(path, import.meta.url)))
      .digest("hex");
    assert.equal(digest, expected);
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-configuration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "nelos", "config.toml");
  const legacyPreferencePath = join(root, "state", "preference.json");
  const store = new NelosConfigStoreV1({
    path: configPath,
    makeTemporaryId: () => "temporary",
  });
  const configuration = new NelosConfigurationV1({
    store,
    legacyPreferencePath,
  });
  return {
    root,
    configPath,
    legacyPreferencePath,
    store,
    configuration,
  };
}

test("configuration path resolution follows explicit, XDG, then home precedence", () => {
  assert.equal(
    resolveNelosConfigPath({
      environment: {
        NELOS_CONFIG: "/custom/nelos.toml",
        XDG_CONFIG_HOME: "/xdg",
        HOME: "/home/user",
      },
    }),
    "/custom/nelos.toml",
  );
  assert.equal(
    resolveNelosConfigPath({
      environment: {
        NELOS_CONFIG: "  ",
        XDG_CONFIG_HOME: "/xdg",
        HOME: "/home/user",
      },
    }),
    "/xdg/nelos/config.toml",
  );
  assert.equal(
    resolveNelosConfigPath({
      environment: { HOME: "/home/user" },
      homeDirectory: "/ignored",
    }),
    "/home/user/.config/nelos/config.toml",
  );
  assert.throws(
    () => resolveNelosConfigPath({
      environment: {
        NELOS_CONFIG: "relative",
        HOME: "/home/user",
      },
    }),
    /NELOS_CONFIG must be an absolute path/u,
  );
  assert.throws(
    () => resolveNelosConfigPath({
      environment: {
        XDG_CONFIG_HOME: "relative",
        HOME: "/home/user",
      },
    }),
    /XDG_CONFIG_HOME must be an absolute path/u,
  );
});

test("legacy preference migration rejects a relative state home", () => {
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = "repository-relative-state";
    assert.throws(
      () => legacyCleanupPreferencePath(),
      /absolute XDG_STATE_HOME/u,
    );
  } finally {
    if (previousStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousStateHome;
    }
  }
});

test("the bounded TOML parser accepts the supported schema and rejects drift", () => {
  assert.equal(
    parseNelosConfig([
      "schema_version = 1",
      "",
      "[spinoffs]",
      "cleanup_policy = 'ask' # retain tasks for confirmation",
      "",
    ].join("\n")).cleanupPolicy,
    "ask",
  );
  assert.equal(
    parseNelosConfig(
      "\"schema_version\" = 1\nspinoffs.cleanup_policy = \"a\\u0073k\"\n",
    ).cleanupPolicy,
    "ask",
  );
  for (const [source, message] of [
    ["[spinoffs]\ncleanup_policy = \"auto\"\n", /schema_version = 1 is required/u],
    ["schema_version = 2\n", /unsupported schema_version 2/u],
    ["schema_version = 1\nunknown = true\n", /unsupported root key unknown/u],
    ["schema_version = 1\n[other]\nvalue = true\n", /unsupported root key other/u],
    [
      "schema_version = 1\n[spinoffs]\ncleanup_policy = \"sometimes\"\n",
      /must be one of auto, ask, or keep/u,
    ],
    [
      "schema_version = 1\n[spinoffs]\ncleanup_policy = auto\n",
      /invalid TOML/u,
    ],
    [
      "schema_version = 1\nspinoffs = {}\n",
      /inline tables use valid but unsupported editing syntax/u,
    ],
  ]) {
    assert.throws(() => parseNelosConfig(source), message);
  }
});

test("set and reset are atomic, private, idempotent, and preserve comments", async (t) => {
  const { configPath, configuration } = await fixture(t);
  const initial = await configuration.get();
  assert.equal(initial.setting.value, "auto");
  assert.equal(initial.setting.source, "default");
  assert.equal(initial.configFileExists, false);

  const set = await configuration.set({
    key: NELOS_CLEANUP_POLICY_KEY,
    value: "ask",
    userIntentConfirmed: true,
  });
  assert.equal(set.setting.value, "ask");
  assert.equal(set.setting.source, "toml");
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(configPath))).mode & 0o777, 0o700);

  await writeFile(
    configPath,
    [
      "# Nelos preferences",
      "schema_version = 1",
      "",
      "[spinoffs]",
      "cleanup_policy = \"ask\" # explain this choice",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await configuration.set({
    key: NELOS_CLEANUP_POLICY_KEY,
    value: "keep",
    userIntentConfirmed: true,
  });
  const updated = await readFile(configPath, "utf8");
  assert.match(updated, /^# Nelos preferences$/mu);
  assert.match(updated, /cleanup_policy = "keep" # explain this choice/u);

  const reset = await configuration.reset({
    key: NELOS_CLEANUP_POLICY_KEY,
    userIntentConfirmed: true,
  });
  assert.equal(reset.setting.value, "auto");
  assert.equal(reset.setting.source, "default");
  assert.doesNotMatch(await readFile(configPath, "utf8"), /cleanup_policy/u);
  assert.deepEqual(
    await configuration.reset({
      key: NELOS_CLEANUP_POLICY_KEY,
      userIntentConfirmed: true,
    }),
    reset,
  );
});

test("a valid legacy preference migrates once and reset means built-in default", async (t) => {
  const {
    configPath,
    legacyPreferencePath,
    configuration,
  } = await fixture(t);
  await mkdir(dirname(legacyPreferencePath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    legacyPreferencePath,
    `${JSON.stringify({ schemaVersion: 1, policy: "keep" })}\n`,
    { mode: 0o600 },
  );

  const legacy = await configuration.get();
  assert.equal(legacy.setting.value, "keep");
  assert.equal(legacy.setting.source, "toml");
  assert.deepEqual(legacy.migration, {
    performed: true,
    from: "legacy-preference",
  });
  await assert.rejects(readFile(legacyPreferencePath, "utf8"), {
    code: "ENOENT",
  });
  assert.equal((await configuration.get()).migration, null);

  await configuration.set({
    key: NELOS_CLEANUP_POLICY_KEY,
    value: "ask",
    userIntentConfirmed: true,
  });
  assert.equal((await configuration.get()).setting.value, "ask");

  await writeFile(
    configPath,
    "schema_version = 1\n\n[spinoffs]\ncleanup_policy = \"auto\"\n",
  );
  const reloaded = await configuration.get();
  assert.equal(reloaded.setting.value, "auto");
  assert.equal(reloaded.setting.source, "toml");

  await configuration.reset({
    key: NELOS_CLEANUP_POLICY_KEY,
    userIntentConfirmed: true,
  });
  const restored = await configuration.get();
  assert.equal(restored.setting.value, "auto");
  assert.equal(restored.setting.source, "default");
});

test("reset retires a legacy preference without first migrating it", async (t) => {
  const { legacyPreferencePath, configuration } = await fixture(t);
  await mkdir(dirname(legacyPreferencePath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    legacyPreferencePath,
    `${JSON.stringify({ schemaVersion: 1, policy: "keep" })}\n`,
    { mode: 0o600 },
  );
  const reset = await configuration.reset({
    key: NELOS_CLEANUP_POLICY_KEY,
    userIntentConfirmed: true,
  });
  assert.equal(reset.setting.value, "auto");
  assert.equal(reset.setting.source, "default");
  await assert.rejects(readFile(legacyPreferencePath, "utf8"), {
    code: "ENOENT",
  });
});

test("malformed and unsafe configuration paths fail with actionable context", async (t) => {
  const { root, configPath, configuration } = await fixture(t);
  await configuration.set({
    key: NELOS_CLEANUP_POLICY_KEY,
    value: "auto",
    userIntentConfirmed: true,
  });
  await writeFile(configPath, "schema_version = 1\n[spinoffs]\nwat = true\n");
  await assert.rejects(
    configuration.get(),
    /invalid Nelos configuration.*unsupported spinoffs key/u,
  );

  const target = join(root, "redirected.toml");
  await writeFile(target, "schema_version = 1\n", { mode: 0o600 });
  await rm(configPath);
  await symlink(target, configPath);
  await assert.rejects(
    configuration.get(),
    /invalid Nelos configuration/u,
  );
});

test("configuration changes require explicit user intent", async (t) => {
  const { configuration } = await fixture(t);
  await assert.rejects(
    configuration.set({
      key: NELOS_CLEANUP_POLICY_KEY,
      value: "ask",
    }),
    /requires explicit user intent/u,
  );
  await assert.rejects(
    configuration.reset({ key: NELOS_CLEANUP_POLICY_KEY }),
    /requires explicit user intent/u,
  );
});

test("an invalid legacy preference fails closed instead of enabling auto", async (t) => {
  const { legacyPreferencePath, configuration } = await fixture(t);
  await mkdir(dirname(legacyPreferencePath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(legacyPreferencePath, "{not-json}\n", { mode: 0o600 });
  await assert.rejects(
    configuration.get(),
    /invalid legacy Nelos preference/u,
  );
});

test("configuration writers serialize across equivalent path aliases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-configuration-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.toml");
  let activeWrites = 0;
  let maximumWrites = 0;
  const fileSystem = {
    ...await import("node:fs/promises"),
    async writeFile(path, ...args) {
      if (String(path).endsWith(".tmp")) {
        activeWrites += 1;
        maximumWrites = Math.max(maximumWrites, activeWrites);
        await delay(20);
      }
      try {
        return await writeFile(path, ...args);
      } finally {
        if (String(path).endsWith(".tmp")) activeWrites -= 1;
      }
    },
  };
  const createConfiguration = (temporaryId, path) => new NelosConfigurationV1({
    store: new NelosConfigStoreV1({
      path,
      fileSystem,
      makeTemporaryId: () => temporaryId,
    }),
    legacyPreferencePath: join(root, "legacy.json"),
    fileSystem,
  });
  await Promise.all([
    createConfiguration("one", configPath).set({
      key: NELOS_CLEANUP_POLICY_KEY,
      value: "ask",
      userIntentConfirmed: true,
    }),
    createConfiguration("two", `${root}/./config.toml`).set({
      key: NELOS_CLEANUP_POLICY_KEY,
      value: "keep",
      userIntentConfirmed: true,
    }),
  ]);
  assert.equal(maximumWrites, 1);
  assert.ok(
    ["ask", "keep"].includes(parseNelosConfig(
      await readFile(configPath, "utf8"),
    ).cleanupPolicy),
  );
});
