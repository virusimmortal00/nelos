import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertReleaseTag,
  buildReleaseArtifacts,
  buildCycloneDxBom,
  extractReleaseNotes,
  validateVersionCoherence,
} from "../scripts/build-release-artifacts.mjs";
import {
  computeDistributionIntegrity,
} from "../src/distribution-provenance.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

function coherentFixture(version = "1.2.3+codex.20260728120000") {
  return {
    tag: `v${version}`,
    packageMetadata: { name: "nelos", version },
    pluginMetadata: { version },
    mcpMetadata: {
      nelos: { env: { NELOS_PLUGIN_VERSION: version } },
    },
    provenance: { revision: version, integrity: "sha256:fixture" },
    lockMetadata: {
      version,
      packages: {
        "": { name: "nelos", version },
      },
    },
    actualIntegrity: "sha256:fixture",
  };
}

test("release tags exactly match valid package SemVer", () => {
  assert.doesNotThrow(() =>
    assertReleaseTag(
      "v1.2.3-rc.1+codex.20260728120000",
      "1.2.3-rc.1+codex.20260728120000",
    ),
  );
  assert.throws(
    () => assertReleaseTag("v1.2.4", "1.2.3"),
    /must exactly equal/u,
  );
  assert.throws(() => assertReleaseTag("v01.2.3", "01.2.3"), /valid SemVer/u);
  assert.throws(() => assertReleaseTag("v1.2.3-01", "1.2.3-01"), /valid SemVer/u);
  assert.throws(
    () => assertReleaseTag("v1.2.3-alpha.01", "1.2.3-alpha.01"),
    /valid SemVer/u,
  );
  assert.doesNotThrow(() =>
    assertReleaseTag("v1.2.3-01-beta", "1.2.3-01-beta"),
  );
});

test("release coherence requires every version and provenance surface", () => {
  const fixture = coherentFixture();
  assert.equal(
    validateVersionCoherence(fixture),
    fixture.packageMetadata.version,
  );
  for (const mutate of [
    (candidate) => { candidate.pluginMetadata.version = "9.9.9"; },
    (candidate) => {
      candidate.mcpMetadata.nelos.env.NELOS_PLUGIN_VERSION = "9.9.9";
    },
    (candidate) => { candidate.provenance.revision = "9.9.9"; },
    (candidate) => { candidate.lockMetadata.version = "9.9.9"; },
    (candidate) => { candidate.lockMetadata.packages[""].version = "9.9.9"; },
    (candidate) => { candidate.actualIntegrity = "sha256:drift"; },
  ]) {
    const candidate = structuredClone(fixture);
    mutate(candidate);
    assert.throws(() => validateVersionCoherence(candidate));
  }
});

test("release notes come only from the exact dated changelog section", () => {
  const changelog = `# Changelog

## Unreleased

- Pending.

## [1.2.3+codex.20260728120000] - 2026-07-28

### User-facing changes

- Added a release gate.

## [1.2.2] - 2026-07-20

- Previous.
`;
  assert.equal(
    extractReleaseNotes(changelog, "1.2.3+codex.20260728120000"),
    `## [1.2.3+codex.20260728120000] - 2026-07-28

### User-facing changes

- Added a release gate.
`,
  );
  assert.throws(
    () => extractReleaseNotes(changelog, "1.2.4"),
    /no dated/u,
  );
});

test("CycloneDX output is deterministic and rooted at the release package", () => {
  const packageMetadata = { name: "nelos", version: "1.2.3" };
  const lockMetadata = {
    packages: {
      "": packageMetadata,
      "node_modules/zeta": {
        name: "zeta",
        version: "2.0.0",
        dev: true,
        license: "SEE LICENSE IN LICENSE",
      },
      "node_modules/alpha": { name: "alpha", version: "1.0.0", license: "MIT" },
    },
  };
  const first = buildCycloneDxBom({
    packageMetadata,
    lockMetadata,
    sourceCommit: "abc123",
  });
  const second = buildCycloneDxBom({
    packageMetadata,
    lockMetadata,
    sourceCommit: "abc123",
  });
  assert.deepEqual(first, second);
  assert.equal(first.bomFormat, "CycloneDX");
  assert.equal(first.metadata.component.name, "nelos");
  assert.deepEqual(
    first.components.map(({ name }) => name),
    ["alpha", "zeta"],
  );
  assert.deepEqual(first.dependencies[0].dependsOn, [
    "pkg:npm/alpha@1.0.0",
    "pkg:npm/zeta@2.0.0",
  ]);
  assert.deepEqual(first.components[0].licenses, [{ license: { id: "MIT" } }]);
  assert.deepEqual(first.components[1].licenses, [{
    license: { name: "SEE LICENSE IN LICENSE" },
  }]);
});

test("release workflow is tag-triggered, recoverable, gated, draft-only, and checksum-aware", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  assert.match(workflow, /tags:\s*\n\s+- "v\*"/u);
  assert.match(workflow, /workflow_dispatch:[\s\S]*tag:/u);
  assert.match(
    workflow,
    /RELEASE_TAG: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name \}\}/u,
  );
  assert.match(
    workflow,
    /group: release-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name \}\}/u,
  );
  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
  assert.match(workflow, /needs: \[verify, artifacts\]/u);
  assert.match(workflow, /contents: write/u);
  assert.equal(
    (workflow.match(/Restore annotated release tag/gu) ?? []).length,
    2,
  );
  assert.equal(
    (workflow.match(/env -u GITHUB_SHA node scripts\/build-release-artifacts\.mjs/gu) ?? []).length,
    2,
  );
  assert.match(workflow, /sha256sum --check SHA256SUMS/u);
  assert.match(workflow, /gh release create[\s\S]*--draft[\s\S]*--verify-tag/u);
  assert.doesNotMatch(workflow, /gh release create[\s\S]*--latest/u);
  assert.doesNotMatch(workflow, /cache:\s*npm/u);
  assert.equal(
    (workflow.match(/persist-credentials:\s*false/gu) ?? []).length,
    2,
  );
});

test("release artifact build is reproducible and checksum-complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-release-artifacts-"));
  const fixtureRoot = join(root, "repository");
  try {
    await cp(repositoryRoot, fixtureRoot, {
      recursive: true,
      filter: (source) => {
        const name = basename(source);
        return ![".git", "node_modules", "dist"].includes(name)
          && !name.startsWith(".nelos-worktree-launch-");
      },
    });
    const packageMetadata = JSON.parse(
      await readFile(join(fixtureRoot, "package.json"), "utf8"),
    );
    const tag = `v${packageMetadata.version}`;
    const changelogPath = join(fixtureRoot, "CHANGELOG.md");
    await writeFile(
      changelogPath,
      `${await readFile(changelogPath, "utf8")}

## [${packageMetadata.version}] - 2026-07-28

### User-facing changes

- Release artifact integration fixture.

### Compatibility requirements

- Node.js 20.

### Migrations

- None.

### Security fixes

- None.

### Known limitations

- None.
`,
    );
    const provenancePath = join(fixtureRoot, "distribution-provenance.json");
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.integrity = await computeDistributionIntegrity(fixtureRoot);
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

    for (const argumentsList of [
      ["init", "-b", "main"],
      ["config", "user.name", "Nelos Release Test"],
      ["config", "user.email", "release-test@example.invalid"],
      ["add", "."],
      ["commit", "-m", "release fixture"],
      ["tag", "-a", tag, "-m", `Nelos ${packageMetadata.version}`],
    ]) {
      await execFileAsync("git", argumentsList, { cwd: fixtureRoot });
    }

    const outputDirectory = join(fixtureRoot, "dist", "release");
    const result = await buildReleaseArtifacts({
      tag,
      outputDirectory,
      root: fixtureRoot,
      environment: {},
    });
    assert.equal(result.tag, tag);
    assert.match(result.packageDigest, /^sha256:[a-f0-9]{64}$/u);
    const checksumText = await readFile(
      join(outputDirectory, "SHA256SUMS"),
      "utf8",
    );
    const checksumLines = checksumText.trim().split("\n");
    assert.deepEqual(
      checksumLines.map((line) => line.slice(66)),
      [
        "distribution-provenance.json",
        `nelos-${packageMetadata.version}.tgz`,
        "release-manifest.json",
        "sbom.cdx.json",
      ],
    );
    for (const line of checksumLines) {
      const [expected, name] = line.split("  ");
      const actual = createHash("sha256")
        .update(await readFile(join(outputDirectory, name)))
        .digest("hex");
      assert.equal(actual, expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
