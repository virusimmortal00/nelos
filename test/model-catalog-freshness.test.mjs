import assert from "node:assert/strict";
import test from "node:test";

import { checkModelCatalogFreshness, STALE_AFTER_DAYS } from "../src/model-catalog-freshness.mjs";

function baseCatalog(overrides = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: "test-2026-01-01",
    reviewedAt: "2026-01-01",
    sourceUrl: "https://learn.chatgpt.com/docs/models",
    evidence: { kind: "verified-openai-docs", summary: "test fixture" },
    profiles: {
      luna: {
        id: "luna",
        label: "Luna",
        requestedModel: "gpt-5.6-luna",
        supportedEfforts: ["low", "medium", "high"],
      },
    },
    ...overrides,
  };
}

test("fresh: recent reviewedAt and guidance corroborating every profile", () => {
  const report = checkModelCatalogFreshness({
    catalog: baseCatalog({ reviewedAt: "2026-01-01" }),
    guidance: {
      observedAt: "2026-01-10T00:00:00.000Z",
      modelsGuidanceText: "gpt-5.6-luna supports low, medium, and high effort.",
      subagentsGuidanceText: "Subagents inherit reasoning effort from the parent.",
    },
    now: "2026-01-10T00:00:00.000Z",
  });

  assert.equal(report.ok, true);
  assert.equal(report.freshness, "fresh");
  assert.deepEqual(report.differences, []);
  assert.equal(report.recommendation, "No action needed.");
});

test(`stale: reviewedAt older than ${STALE_AFTER_DAYS} days with no guidance drift`, () => {
  const report = checkModelCatalogFreshness({
    catalog: baseCatalog({ reviewedAt: "2026-01-01" }),
    guidance: {
      observedAt: "2026-06-01T00:00:00.000Z",
      modelsGuidanceText: "gpt-5.6-luna supports low, medium, and high effort.",
    },
    now: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(report.ok, false);
  assert.equal(report.freshness, "stale");
  assert.ok(report.ageDays > STALE_AFTER_DAYS);
  assert.deepEqual(report.differences, []);
  assert.match(report.recommendation, /Re-review the catalog/);
});

test("malformed-provenance: catalog missing a required provenance field", () => {
  const catalog = baseCatalog();
  delete catalog.sourceUrl;

  const report = checkModelCatalogFreshness({
    catalog,
    guidance: { observedAt: "2026-01-10T00:00:00.000Z" },
    now: "2026-01-10T00:00:00.000Z",
  });

  assert.equal(report.ok, false);
  assert.equal(report.freshness, "malformed-provenance");
  assert.equal(report.sourceUrl, null);
  assert.equal(report.differences.length, 1);
  assert.match(report.differences[0].detail, /missing required provenance field "sourceUrl"/);
});

test("changed-guidance: guidance no longer corroborates a profile's model or effort", () => {
  const report = checkModelCatalogFreshness({
    catalog: baseCatalog({ reviewedAt: "2026-01-01" }),
    guidance: {
      observedAt: "2026-01-10T00:00:00.000Z",
      modelsGuidanceText: "gpt-5.6-luna supports low and medium effort only.",
    },
    now: "2026-01-10T00:00:00.000Z",
  });

  assert.equal(report.ok, false);
  assert.equal(report.freshness, "changed-guidance");
  assert.deepEqual(report.differences, [
    {
      profile: "luna",
      field: "supportedEfforts",
      detail: 'Models guidance no longer mentions the "high" reasoning-effort tier',
    },
  ]);
  assert.match(report.recommendation, /Guidance has drifted/);
});

test("changed-guidance takes priority over staleness when both apply", () => {
  const report = checkModelCatalogFreshness({
    catalog: baseCatalog({ reviewedAt: "2026-01-01" }),
    guidance: {
      observedAt: "2026-06-01T00:00:00.000Z",
      modelsGuidanceText: "no model roles mentioned here",
    },
    now: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(report.freshness, "changed-guidance");
  assert.ok(report.differences.length > 0);
});

test("without fetched guidance text, only malformed-provenance and staleness are evaluated", () => {
  const report = checkModelCatalogFreshness({
    catalog: baseCatalog({ reviewedAt: "2026-01-01" }),
    guidance: { observedAt: "2026-01-10T00:00:00.000Z" },
    now: "2026-01-10T00:00:00.000Z",
  });

  assert.equal(report.freshness, "fresh");
  assert.deepEqual(report.differences, []);
});
