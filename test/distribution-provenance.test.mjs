import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DISTRIBUTION_ENTRIES,
  MANAGED_CLI_COMMANDS,
  compareProvenance,
  computeDistributionIntegrity,
  computeFileIntegrity,
  listPathCommands,
  readRequiredProvenance,
} from "../src/distribution-provenance.mjs";

const verifier = fileURLToPath(
  new URL("../bin/fraktik-verify-distribution", import.meta.url),
);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedPath = fileURLToPath(
  new URL("../distribution-provenance.json", import.meta.url),
);
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const pluginManifestPath = fileURLToPath(
  new URL("../.codex-plugin/plugin.json", import.meta.url),
);
function runVerifier(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifier], {
      env: { ...process.env, ...environment },
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

async function writeProvenance(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

async function createDistributionFixture(overrides = {}) {
  // Keep a status token in the path so result assertions must count line prefixes.
  const root = await mkdtemp(join(tmpdir(), "codex-distribution-fixture-OK-"));
  const codexHome = join(root, "codex-home");
  const cliRoot = join(root, "cli");
  const cliPath = join(cliRoot, "bin", "fraktik");
  const pluginRoot = join(
    codexHome,
    "plugins",
    "cache",
    "personal",
    "fraktik",
    "0.1.0+fixture",
  );
  const expected = JSON.parse(await readFile(expectedPath, "utf8"));
  const stale = { ...expected, revision: `${expected.revision}-stale` };
  const records = {
    cli: expected,
    skill: expected,
    plugin: expected,
    ...overrides,
  };

  await mkdir(cliRoot, { recursive: true });
  await mkdir(pluginRoot, { recursive: true });
  for (const entry of DISTRIBUTION_ENTRIES) {
    await cp(join(packageRoot, entry), join(cliRoot, entry), { recursive: true });
    await cp(join(packageRoot, entry), join(pluginRoot, entry), {
      recursive: true,
    });
  }
  for (const command of MANAGED_CLI_COMMANDS) {
    const destination = join(cliRoot, "bin", command);
    await chmod(destination, 0o755);
  }
  await writeProvenance(
    join(cliRoot, "distribution-provenance.json"),
    records.cli === "stale" ? stale : records.cli,
  );
  await writeProvenance(
    join(
      codexHome,
      "skills",
      "manage-fraktik-tasks",
      "distribution-provenance.json",
    ),
    records.skill === "stale" ? stale : records.skill,
  );
  await cp(
    join(packageRoot, "skills", "manage-fraktik-tasks", "SKILL.md"),
    join(codexHome, "skills", "manage-fraktik-tasks", "SKILL.md"),
  );
  await writeProvenance(
    join(pluginRoot, "distribution-provenance.json"),
    records.plugin === "stale" ? stale : records.plugin,
  );

  return {
    root,
    pluginRoot,
    environment: { CODEX_HOME: codexHome, PATH: join(cliRoot, "bin") },
    expected,
    stale,
  };
}

test("isolated CODEX_HOME fixtures report coherent and independently stale surfaces", async (t) => {
  const scenarios = [
    { name: "all surfaces coherent", overrides: {}, mismatch: null },
    { name: "stale PATH CLI", overrides: { cli: "stale" }, mismatch: "PATH CLI" },
    { name: "stale skill", overrides: { skill: "stale" }, mismatch: "user-wide skill" },
    { name: "stale cached plugin", overrides: { plugin: "stale" }, mismatch: "cached plugin" },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = await createDistributionFixture(scenario.overrides);
      try {
        const result = await runVerifier(fixture.environment);
        if (scenario.mismatch === null) {
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /OK PATH CLI/);
          assert.match(result.stdout, /OK user-wide skill/);
          assert.match(result.stdout, /OK cached plugin/);
          assert.equal(result.stderr, "");
          return;
        }

        assert.equal(result.status, 1);
        assert.ok(
          result.stderr.includes(
            `MISMATCH ${scenario.mismatch}: expected=${fixture.expected.revision} installed=${fixture.stale.revision}`,
          ),
          result.stderr,
        );
        assert.match(result.stderr, /Reinstall the CLI, user-wide skill, and cached plugin/);
        assert.equal((result.stderr.match(/^MISMATCH /gm) ?? []).length, 1);
        assert.equal((result.stdout.match(/^OK /gm) ?? []).length, 2);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("the provenance revision stays aligned with package and plugin releases", async () => {
  const provenance = JSON.parse(await readFile(expectedPath, "utf8"));
  const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
  const pluginMetadata = JSON.parse(await readFile(pluginManifestPath, "utf8"));
  assert.equal(provenance.revision, packageMetadata.version);
  assert.equal(provenance.revision, pluginMetadata.version);
  assert.equal(provenance.integrity, await computeDistributionIntegrity(packageRoot));
  assert.equal(
    provenance.skillIntegrity,
    await computeFileIntegrity(
      join(packageRoot, "skills", "manage-fraktik-tasks", "SKILL.md"),
    ),
  );
});

test("the distributed plugin ships the active MCP tool surface and nothing dormant", async () => {
  const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
  // The socket-free tool surface (docs/mcp-tool-surface.md) is an active,
  // provenance-covered distribution entry. The retired live-state prototype's
  // built runtime surfaces stay excluded, and the server remains
  // dependency-free by design.
  assert.ok(DISTRIBUTION_ENTRIES.includes(".mcp.json"));
  assert.ok(packageMetadata.files.includes(".mcp.json"));
  assert.ok(!DISTRIBUTION_ENTRIES.includes("dist"));
  assert.ok(!DISTRIBUTION_ENTRIES.includes("ui"));
  assert.ok(!packageMetadata.files.includes("dist/"));
  assert.ok(!packageMetadata.files.includes("ui/"));
  assert.equal(packageMetadata.scripts["build:mcp"], undefined);
  assert.equal(packageMetadata.scripts["verify:packed"], undefined);
  assert.equal(packageMetadata.dependencies["@modelcontextprotocol/sdk"], undefined);
  assert.deepEqual(packageMetadata.dependencies ?? {}, {});
});

test("read-only verification detects a tampered PATH command without executing it", async () => {
  const fixture = await createDistributionFixture();
  const sentinel = join(fixture.root, "executed-sentinel");
  const cliPath = join(fixture.root, "cli", "bin", "fraktik");
  try {
    await writeFile(
      cliPath,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed\\n");\n`,
    );
    await chmod(cliPath, 0o755);
    const result = await runVerifier(fixture.environment);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /MISMATCH PATH CLI:.*fraktik integrity\/executability mismatch/,
    );
    await assert.rejects(readFile(sentinel, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("read-only verification detects cached plugin content drift without install state", async () => {
  const fixture = await createDistributionFixture();
  const manifestPath = join(fixture.pluginRoot, ".codex-plugin", "plugin.json");
  try {
    await writeFile(
      manifestPath,
      `${await readFile(manifestPath, "utf8")}\n// tampered fixture\n`,
    );
    const result = await runVerifier(fixture.environment);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /MISMATCH cached plugin:.*cached plugin integrity mismatch/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("required bundled provenance rejects a missing record", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-missing-provenance-"));
  try {
    const missingPath = join(root, "distribution-provenance.json");
    await assert.rejects(
      readRequiredProvenance(missingPath),
      (error) =>
        error instanceof Error &&
        error.message === `bundled provenance is missing at ${missingPath}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PATH lookup uses empty components but ignores directories", async () => {
  const matches = await listPathCommands("bin/fraktik", delimiter);
  assert.equal(matches[0]?.path, resolve("bin/fraktik"));
  assert.deepEqual(await listPathCommands("bin", delimiter), []);
});

test("provenance compares required CLI commands as an unordered set", () => {
  const expected = {
    schemaVersion: 1,
    distribution: "fraktik",
    revision: "0.2.0",
    requiredCliCommands: ["spinoff", "web begin", "web join", "web collect"],
  };
  const inspection = {
    installed: expected.revision,
    provenance: {
      ...expected,
      requiredCliCommands: ["web collect", "web join", "spinoff", "web begin"],
    },
  };
  assert.equal(compareProvenance("fixture", expected, inspection).coherent, true);
});

test("an invalid installed record reports one mismatch without hiding other surfaces", async () => {
  const fixture = await createDistributionFixture();
  const skillPath = join(
    fixture.environment.CODEX_HOME,
    "skills",
    "manage-fraktik-tasks",
    "distribution-provenance.json",
  );
  try {
    await writeFile(skillPath, "{truncated\n");
    const result = await runVerifier(fixture.environment);
    assert.equal(result.status, 1);
    assert.ok(
      result.stderr.includes(
        `MISMATCH user-wide skill: expected=${fixture.expected.revision} installed=invalid`,
      ),
      result.stderr,
    );
    assert.match(result.stderr, /detail=invalid provenance JSON/);
    assert.equal((result.stdout.match(/^OK /gm) ?? []).length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("retained plugin revisions do not make the newest cached copy ambiguous", async () => {
  const fixture = await createDistributionFixture();
  try {
    await writeProvenance(
      join(
        fixture.environment.CODEX_HOME,
        "plugins",
        "cache",
        "personal",
        "fraktik",
        "0.0.9+retained",
        "distribution-provenance.json",
      ),
      fixture.stale,
    );
    const retainedPath = join(
      fixture.environment.CODEX_HOME,
      "plugins",
      "cache",
      "personal",
      "fraktik",
      "0.0.9+retained",
    );
    await utimes(retainedPath, new Date(0), new Date(0));
    const result = await runVerifier(fixture.environment);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK cached plugin:.*0\.1\.0\+fixture/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cached copies from multiple marketplaces report ambiguity", async () => {
  const fixture = await createDistributionFixture();
  try {
    await writeProvenance(
      join(
        fixture.environment.CODEX_HOME,
        "plugins",
        "cache",
        "another-marketplace",
        "fraktik",
        "0.1.0+fixture",
        "distribution-provenance.json",
      ),
      fixture.expected,
    );
    const result = await runVerifier(fixture.environment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MISMATCH cached plugin:.*installed=ambiguous/);
    assert.match(result.stderr, /multiple marketplaces/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a newer cached plugin missing provenance is not masked by an older copy", async () => {
  const fixture = await createDistributionFixture();
  try {
    await utimes(
      join(
        fixture.environment.CODEX_HOME,
        "plugins",
        "cache",
        "personal",
        "fraktik",
        "0.1.0+fixture",
      ),
      new Date(0),
      new Date(0),
    );
    await mkdir(
      join(
        fixture.environment.CODEX_HOME,
        "plugins",
        "cache",
        "personal",
        "fraktik",
        "0.2.0+missing",
      ),
      { recursive: true },
    );
    const result = await runVerifier(fixture.environment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MISMATCH cached plugin:.*installed=missing/);
    assert.match(result.stderr, /0\.2\.0\+missing/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
