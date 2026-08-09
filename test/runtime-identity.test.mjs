import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RUNTIME_HEALTH_STATES,
  RuntimeIdentityError,
  compareRuntimeIdentitiesV1,
  deriveBuildIdentityV1,
  deriveRuntimeIdentityV1,
  resolveInstalledIdentityV1,
  resolveRuntimeHealthV1,
  runtimeIdentitiesMatchV1,
} from "../src/runtime-identity.mjs";

const SOURCE_REPOSITORY = "https://github.com/virusimmortal00/nelos.git";
const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);
const INTEGRITY_A = `sha256:${"1".repeat(64)}`;
const INTEGRITY_B = `sha256:${"2".repeat(64)}`;

function provenanceFor(version, extra = {}) {
  return {
    schemaVersion: 1,
    distribution: "nelos",
    revision: version,
    sourceRepository: SOURCE_REPOSITORY,
    cacheIdentity: `${SOURCE_REPOSITORY}#nelos@${version}`,
    ...extra,
  };
}

/** Write a distribution root carrying all four on-disk identity sources. */
async function writeDistribution(root, version, { provenance, ...overrides } = {}) {
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "nelos", version: overrides.packageVersion ?? version }),
  );
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "nelos",
      version: overrides.pluginVersion ?? version,
      releaseBuildIdentity:
        overrides.pluginBuildIdentity ?? `nelos-release-v1:${version}`,
    }),
  );
  await writeFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        nelos: {
          command: "node",
          env: {
            NELOS_PLUGIN_VERSION: overrides.mcpVersion ?? version,
            NELOS_RELEASE_BUILD_IDENTITY:
              overrides.mcpBuildIdentity ?? `nelos-release-v1:${version}`,
          },
        },
      },
    }),
  );
  await writeFile(
    join(root, "distribution-provenance.json"),
    JSON.stringify(provenance ?? provenanceFor(version)),
  );
  return root;
}

/** Write an installed plugin cache entry the way Codex lays one out. */
async function writeInstalledPlugin(codexHome, marketplace, version, extra = {}) {
  const root = join(codexHome, "plugins", "cache", marketplace, "nelos", version);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "distribution-provenance.json"),
    JSON.stringify(provenanceFor(version, extra)),
  );
  return root;
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "nelos-runtime-identity-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("derives a coherent identity from all on-disk sources", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3", {
      provenance: provenanceFor("1.2.3", {
        sourceRevision: REVISION_A,
        sourceRevisionType: "git",
        integrity: INTEGRITY_A,
      }),
    });
    const identity = await deriveRuntimeIdentityV1({ moduleRoot: root });
    assert.equal(identity.version, "1.2.3");
    assert.equal(identity.sourceRevision, REVISION_A);
    assert.equal(identity.integrity, INTEGRITY_A);
    assert.equal(identity.modulePath, root);
    assert.match(identity.buildIdentity, /^nelos-build:[a-f0-9]{32}$/);
    assert.ok(Object.isFrozen(identity));
  });
});

test("accepts a bootstrap-declared version that agrees with disk", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3");
    const identity = await deriveRuntimeIdentityV1({
      moduleRoot: root,
      declaredVersion: "1.2.3",
    });
    assert.equal(identity.version, "1.2.3");
  });
});

test("rejects a bootstrap-declared version that disagrees with disk", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3");
    await assert.rejects(
      deriveRuntimeIdentityV1({ moduleRoot: root, declaredVersion: "9.9.9" }),
      (error) => {
        assert.ok(error instanceof RuntimeIdentityError);
        assert.equal(error.code, "IDENTITY_SOURCES_DISAGREE");
        assert.match(error.message, /bootstrap=9\.9\.9/);
        return true;
      },
    );
  });
});

test("detects disagreement between each pair of on-disk sources", async () => {
  const cases = [
    ["packageVersion", "package.json"],
    ["pluginVersion", "\\.codex-plugin/plugin\\.json"],
    ["mcpVersion", "\\.mcp\\.json"],
  ];
  for (const [override, sourceLabel] of cases) {
    await withTempDir(async (dir) => {
      const root = await writeDistribution(join(dir, "dist"), "1.2.3", {
        [override]: "4.5.6",
      });
      await assert.rejects(
        deriveRuntimeIdentityV1({ moduleRoot: root }),
        (error) => {
          assert.equal(error.code, "IDENTITY_SOURCES_DISAGREE");
          assert.match(error.message, new RegExp(sourceLabel));
          assert.match(error.message, /4\.5\.6/);
          return true;
        },
      );
    });
  }
});

test("requires the plugin manifest for identity derivation", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "dist");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "nelos", version: "1.2.3" }),
    );
    await writeFile(
      join(root, "distribution-provenance.json"),
      JSON.stringify(provenanceFor("1.2.3")),
    );
    await assert.rejects(deriveRuntimeIdentityV1({ moduleRoot: root }), (error) => {
      assert.equal(error.code, "IDENTITY_SOURCE_MISSING");
      assert.match(error.message, /plugin\.json/);
      return true;
    });
  });
});

test("missing provenance fails derivation", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "dist");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "nelos", version: "1.2.3" }),
    );
    await assert.rejects(deriveRuntimeIdentityV1({ moduleRoot: root }), (error) => {
      assert.equal(error.code, "IDENTITY_SOURCE_MISSING");
      return true;
    });
  });
});

test("invalid provenance JSON is attributed to the identity source", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3");
    await writeFile(join(root, "distribution-provenance.json"), "{ not json");
    await assert.rejects(deriveRuntimeIdentityV1({ moduleRoot: root }), (error) => {
      assert.equal(error.code, "IDENTITY_SOURCE_UNREADABLE");
      return true;
    });
  });
});

test("semver alone never proves the same generation", () => {
  // The acceptance criterion: exact source revision and integrity decide, not
  // the version string and not a self-reported MCP serverInfo version.
  assert.equal(
    runtimeIdentitiesMatchV1(
      { version: "1.2.3", sourceRevision: REVISION_A, integrity: INTEGRITY_A },
      { version: "1.2.3", sourceRevision: REVISION_B, integrity: INTEGRITY_B },
    ),
    false,
  );
  assert.equal(
    runtimeIdentitiesMatchV1(
      { version: "1.2.3", sourceRevision: null, integrity: INTEGRITY_A },
      { version: "1.2.3", sourceRevision: null, integrity: INTEGRITY_B },
    ),
    false,
  );
  assert.equal(
    runtimeIdentitiesMatchV1(
      { version: "1.2.3", sourceRevision: REVISION_A, integrity: INTEGRITY_A },
      { version: "1.2.3", sourceRevision: REVISION_A, integrity: INTEGRITY_A },
    ),
    true,
  );
  assert.equal(
    runtimeIdentitiesMatchV1(
      { version: "1.2.3", sourceRevision: REVISION_A, integrity: null },
      { version: "9.9.9", sourceRevision: REVISION_A, integrity: null },
    ),
    false,
  );
});

test("build identity separates adjacent fields without collision", () => {
  const left = deriveBuildIdentityV1({ version: "1.2", sourceRevision: "34" });
  const right = deriveBuildIdentityV1({ version: "1.23", sourceRevision: "4" });
  assert.notEqual(left, right);
  assert.equal(
    deriveBuildIdentityV1({ version: "1.2", sourceRevision: "34" }),
    left,
  );
});

test("reports healthy when the loaded generation is the installed one", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3", {
      provenance: provenanceFor("1.2.3", {
        sourceRevision: REVISION_A,
        integrity: INTEGRITY_A,
      }),
    });
    const codexHome = join(dir, "codex");
    await writeInstalledPlugin(codexHome, "market", "1.2.3", {
      sourceRevision: REVISION_A,
      integrity: INTEGRITY_A,
    });
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    const health = await resolveRuntimeHealthV1({ loaded, codexHome });
    assert.equal(health.state, "healthy");
    assert.equal(health.mutationAllowed, true);
    assert.equal(health.backingPathPresent, true);
    assert.deepEqual(health.activeVersions, ["1.2.3"]);
  });
});

test("reports restart-required when a newer generation is installed", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "0.5.1", {
      provenance: provenanceFor("0.5.1", {
        sourceRevision: REVISION_A,
        integrity: INTEGRITY_A,
      }),
    });
    const codexHome = join(dir, "codex");
    await writeInstalledPlugin(codexHome, "market", "0.12.5", {
      sourceRevision: REVISION_B,
      integrity: INTEGRITY_B,
    });
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    const health = await resolveRuntimeHealthV1({ loaded, codexHome });
    assert.equal(health.state, "restart-required");
    assert.equal(health.mutationAllowed, false);
    assert.equal(health.loaded.version, "0.5.1");
    assert.equal(health.installed.version, "0.12.5");
    assert.deepEqual(health.activeVersions, ["0.12.5", "0.5.1"]);
    assert.equal(health.recovery, "Quit and relaunch Codex, then open a fresh task.");
  });
});

test("a compatible rollback is healthy when loaded and installed exact identity agree", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "0.12.5", {
      provenance: provenanceFor("0.12.5", {
        sourceRevision: REVISION_A,
        integrity: INTEGRITY_A,
      }),
    });
    const codexHome = join(dir, "codex");
    await writeInstalledPlugin(codexHome, "market", "0.12.5", {
      sourceRevision: REVISION_A,
      integrity: INTEGRITY_A,
    });
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    const health = await resolveRuntimeHealthV1({ loaded, codexHome });
    assert.equal(health.state, "healthy");
    assert.equal(health.mutationAllowed, true);
  });
});

test("stays callable after the loaded cache path is deleted", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "0.5.1");
    const codexHome = join(dir, "codex");
    await writeInstalledPlugin(codexHome, "market", "0.12.5");
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });

    // The upgrade replaced the cache underneath a live worker.
    await rm(root, { recursive: true, force: true });

    const health = await resolveRuntimeHealthV1({ loaded, codexHome });
    assert.equal(health.state, "restart-required");
    assert.equal(health.backingPathPresent, false);
    assert.equal(health.mutationAllowed, false);
    assert.ok(health.recovery.length > 0);
  });
});

test("reports ambiguous-install across multiple marketplaces", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3");
    const codexHome = join(dir, "codex");
    await writeInstalledPlugin(codexHome, "market-a", "1.2.3");
    await writeInstalledPlugin(codexHome, "market-b", "1.2.3");
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    const health = await resolveRuntimeHealthV1({ loaded, codexHome });
    assert.equal(health.state, "ambiguous-install");
    assert.equal(health.mutationAllowed, false);
    assert.equal(health.installed, null);
    assert.equal(health.installedIdentities.length, 2);
    assert.match(health.recovery, /exactly one/);
  });
});

test("reports degraded, and still permits mutation, on a source checkout", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3");
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    const health = await resolveRuntimeHealthV1({
      loaded,
      codexHome: join(dir, "absent-codex-home"),
    });
    assert.equal(health.state, "degraded");
    // Absence of an installed plugin is not evidence of staleness; failing
    // closed here would brick every non-plugin install.
    assert.equal(health.mutationAllowed, true);
  });
});

test("reports integrity-failure when the digest does not match", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3", {
      provenance: provenanceFor("1.2.3", { integrity: INTEGRITY_A }),
    });
    const codexHome = join(dir, "codex");
    await writeInstalledPlugin(codexHome, "market", "1.2.3", {
      integrity: INTEGRITY_A,
    });
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    let integrityOptions;
    const health = await resolveRuntimeHealthV1({
      loaded,
      codexHome,
      verifyIntegrity: true,
      computeIntegrity: async (_path, options) => {
        integrityOptions = options;
        return INTEGRITY_B;
      },
    });
    assert.deepEqual(integrityOptions, {
      allowLegacyWithoutCorpus: true,
      allowLegacyWithoutAgentPluginLayout: true,
    });
    assert.equal(health.state, "integrity-failure");
    assert.equal(health.mutationAllowed, false);
    assert.match(health.detail, /does not match/);
  });
});

test("does not recompute the digest unless asked", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3", {
      provenance: provenanceFor("1.2.3", { integrity: INTEGRITY_A }),
    });
    const codexHome = join(dir, "codex");
    await writeInstalledPlugin(codexHome, "market", "1.2.3", {
      integrity: INTEGRITY_A,
    });
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    let calls = 0;
    const health = await resolveRuntimeHealthV1({
      loaded,
      codexHome,
      computeIntegrity: async () => {
        calls += 1;
        return INTEGRITY_A;
      },
    });
    assert.equal(calls, 0);
    assert.equal(health.state, "healthy");
  });
});

test("a failed derivation reports integrity-failure with its cause", async () => {
  const health = await resolveRuntimeHealthV1({
    loaded: null,
    identityError: new RuntimeIdentityError(
      "IDENTITY_SOURCES_DISAGREE",
      "package.json=1.0.0, distribution-provenance.json=2.0.0",
    ),
  });
  assert.equal(health.state, "integrity-failure");
  assert.equal(health.mutationAllowed, false);
  assert.equal(health.code, "IDENTITY_SOURCES_DISAGREE");
  assert.match(health.detail, /2\.0\.0/);
});

test("every reported state is a declared state", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3");
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    const health = await resolveRuntimeHealthV1({
      loaded,
      codexHome: join(dir, "codex"),
    });
    assert.ok(RUNTIME_HEALTH_STATES.includes(health.state));
    assert.ok(Object.isFrozen(RUNTIME_HEALTH_STATES));
  });
});

test("installed resolution tolerates an unreadable cache without throwing", async () => {
  const result = await resolveInstalledIdentityV1({
    codexHome: "/nonexistent-codex-home",
  });
  assert.equal(result.identity, null);
  assert.equal(result.ambiguous, false);
});

test("a bare version match is reported as degraded, never healthy", async () => {
  // Regression: an earlier revision let the exact-match branch swallow this
  // case and report `healthy`, which would have let a future mutation fence
  // trust a version string alone.
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3");
    const codexHome = join(dir, "codex");
    await writeInstalledPlugin(codexHome, "market", "1.2.3");
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    assert.equal(loaded.sourceRevision, null);
    const health = await resolveRuntimeHealthV1({ loaded, codexHome });
    assert.equal(health.state, "degraded");
    assert.equal(health.mutationAllowed, true);
    assert.match(health.detail, /cannot be proven exact/);
  });
});

test("classifies match, mismatch, and indeterminate distinctly", () => {
  const exact = { version: "1.2.3", sourceRevision: REVISION_A, integrity: INTEGRITY_A };
  assert.equal(compareRuntimeIdentitiesV1(exact, exact), "match");
  assert.equal(
    compareRuntimeIdentitiesV1(exact, {
      version: "1.2.3",
      sourceRevision: REVISION_B,
      integrity: INTEGRITY_A,
    }),
    "mismatch",
  );
  assert.equal(
    compareRuntimeIdentitiesV1(exact, {
      version: "9.9.9",
      sourceRevision: REVISION_A,
      integrity: INTEGRITY_A,
    }),
    "mismatch",
  );
  // One side carries no exact field: unprovable either way.
  assert.equal(
    compareRuntimeIdentitiesV1(exact, {
      version: "1.2.3",
      sourceRevision: null,
      integrity: null,
    }),
    "indeterminate",
  );
  assert.equal(
    compareRuntimeIdentitiesV1(
      { version: "1.2.3", sourceRevision: null, integrity: null },
      { version: "1.2.3", sourceRevision: null, integrity: null },
    ),
    "indeterminate",
  );
});

test("same version with differing revisions denies mutation", async () => {
  await withTempDir(async (dir) => {
    const root = await writeDistribution(join(dir, "dist"), "1.2.3", {
      provenance: provenanceFor("1.2.3", { sourceRevision: REVISION_A }),
    });
    const codexHome = join(dir, "codex");
    await writeInstalledPlugin(codexHome, "market", "1.2.3", {
      sourceRevision: REVISION_B,
    });
    const loaded = await deriveRuntimeIdentityV1({ moduleRoot: root });
    const health = await resolveRuntimeHealthV1({ loaded, codexHome });
    assert.equal(health.state, "restart-required");
    assert.equal(health.mutationAllowed, false);
  });
});
