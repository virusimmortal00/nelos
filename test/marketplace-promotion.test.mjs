import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareStableVersions,
  materializeMarketplaceProvenance,
  validateMarketplacePromotion,
} from "../scripts/validate-marketplace-promotion.mjs";
import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
  selectImpactedCompatibilityContractsV1,
} from "../src/compatibility-contract-registry.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function repositoryFixture(tag) {
  const paths = [
    ["package.json", "packageMetadata"],
    [".codex-plugin/plugin.json", "pluginMetadata"],
    [".mcp.json", "mcpMetadata"],
    ["distribution-provenance.json", "provenance"],
    ["package-lock.json", "lockMetadata"],
    [".agents/plugins/marketplace.json", "marketplace"],
  ];
  const entries = await Promise.all(
    paths.map(async ([path, key]) => [
      key,
      JSON.parse(await readFile(join(repositoryRoot, path), "utf8")),
    ]),
  );
  const fixture = Object.fromEntries(entries);
  return {
    tag: tag ?? `v${fixture.packageMetadata.version}`,
    ...fixture,
  };
}

test("the repository is a coherent stable marketplace candidate", async () => {
  const fixture = await repositoryFixture();
  assert.deepEqual(
    validateMarketplacePromotion(fixture),
    {
      valid: true,
      tag: `v${fixture.packageMetadata.version}`,
      version: fixture.packageMetadata.version,
      marketplaceName: "nelos-marketplace",
      pluginName: "nelos",
    },
  );
});

test("stable promotion rejects prereleases, builds, and version drift", async () => {
  for (const tag of [
    "v0.4.0-alpha.1",
    "v0.4.0+codex.20260729010101",
    "0.4.0",
  ]) {
    const fixture = await repositoryFixture(tag);
    assert.throws(
      () => validateMarketplacePromotion(fixture),
      /vMAJOR\.MINOR\.PATCH/u,
    );
  }

  const fixture = await repositoryFixture();
  fixture.pluginMetadata.version = "0.4.1";
  assert.throws(
    () => validateMarketplacePromotion(fixture),
    /does not match stable tag/u,
  );
});

test("stable promotion rejects semantic-version downgrades", async () => {
  assert.equal(compareStableVersions("2.0.0", "1.999.999"), 1);
  assert.equal(compareStableVersions("2.0.0", "2.0.0"), 0);
  assert.equal(compareStableVersions("1.999.999", "2.0.0"), -1);
  assert.equal(
    compareStableVersions(
      "999999999999999999999999.0.0",
      "999999999999999999999998.999.999",
    ),
    1,
  );

  const downgrade = await repositoryFixture();
  downgrade.currentStableVersion = "0.5.1";
  assert.throws(
    () => validateMarketplacePromotion(downgrade),
    /older than current stable version/u,
  );

  const sameVersion = await repositoryFixture();
  sameVersion.currentStableVersion = "0.5.0";
  assert.doesNotThrow(() => validateMarketplacePromotion(sameVersion));
});

test("stable promotion rejects marketplace contract drift", async () => {
  const remoteSource = await repositoryFixture();
  remoteSource.marketplace.plugins[0].source = {
    source: "url",
    url: "https://example.com/nelos.git",
  };
  assert.throws(
    () => validateMarketplacePromotion(remoteSource),
    /supported contract/u,
  );

  const multiplePlugins = await repositoryFixture();
  multiplePlugins.marketplace.plugins.push({
    ...multiplePlugins.marketplace.plugins[0],
    name: "another-plugin",
  });
  assert.throws(
    () => validateMarketplacePromotion(multiplePlugins),
    /exactly one plugin/u,
  );
});

test("stable promotion materializes exact immutable source provenance", async () => {
  const fixture = await repositoryFixture();
  const sourceRevision = "a".repeat(40);
  assert.deepEqual(
    materializeMarketplaceProvenance(fixture.provenance, sourceRevision),
    {
      ...fixture.provenance,
      sourceRepository: "https://github.com/virusimmortal00/nelos.git",
      sourceRevision,
      sourceRevisionType: "git",
      cacheIdentity: `https://github.com/virusimmortal00/nelos.git#nelos@${fixture.provenance.revision}`,
    },
  );
  assert.throws(
    () => materializeMarketplaceProvenance(fixture.provenance, "main"),
    /immutable Git commit/u,
  );
});

test("promotion workflow is published-release-only and fast-forward-only", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "promote-marketplace.yml"),
    "utf8",
  );
  assert.match(workflow, /release:\s*\n\s+types: \[published\]/u);
  assert.match(workflow, /workflow_dispatch:[\s\S]*tag:/u);
  assert.match(workflow, /github\.workflow_sha/u);
  assert.match(workflow, /path: release-source/u);
  assert.equal(
    (workflow.match(/persist-credentials:\s*false/gu) ?? []).length,
    2,
  );
  assert.doesNotMatch(workflow, /persist-credentials:\s*true/u);
  assert.match(workflow, /gh release view/u);
  assert.match(workflow, /\.isDraft == false/u);
  assert.match(workflow, /\.isPrerelease == false/u);
  assert.match(workflow, /build-release-artifacts\.mjs/u);
  assert.match(workflow, /validate-marketplace-promotion\.mjs/u);
  assert.match(workflow, /--materialize/u);
  assert.match(workflow, /git commit -m "Record \$\{RELEASE_TAG\} marketplace provenance"/u);
  assert.match(workflow, /--current-version "\$CURRENT_STABLE_VERSION"/u);
  assert.match(
    workflow,
    /http\.extraheader=AUTHORIZATION: bearer \$\{GH_TOKEN\}/u,
  );
  assert.match(workflow, /git merge-base[\s\S]*--is-ancestor/u);
  assert.match(workflow, /\.sourceRevision/u);
  assert.match(
    workflow,
    /refs\/heads\/marketplace-promotion:refs\/heads\/\$\{STABLE_BRANCH\}/u,
  );
  assert.match(workflow, /STABLE_BRANCH: marketplace\/stable/u);
  assert.doesNotMatch(workflow, /git push[\s\S]*--force/u);
});

test("promotion surfaces are mapped to the compatibility lifecycle", () => {
  const selection = selectImpactedCompatibilityContractsV1(
    COMPATIBILITY_CONTRACT_REGISTRY_V1,
    [
      {
        status: "added",
        path: ".github/workflows/promote-marketplace.yml",
      },
      {
        status: "modified",
        path: "docs/installation.md",
      },
      {
        status: "added",
        path: "scripts/validate-marketplace-promotion.mjs",
      },
      {
        status: "added",
        path: "test/marketplace-promotion.test.mjs",
      },
    ],
  );
  assert.equal(selection.ok, true);
  assert.deepEqual(selection.unmappedSensitivePaths, []);
  assert.ok(
    selection.selectedCapabilityIds.includes("nelos.lifecycle-invariants"),
  );
});
