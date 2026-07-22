const REQUIRED_CATALOG_FIELDS = [
  "schemaVersion",
  "catalogVersion",
  "reviewedAt",
  "sourceUrl",
  "evidence",
  "profiles",
];

export const STALE_AFTER_DAYS = 90;

function missingCatalogFields(catalog) {
  return REQUIRED_CATALOG_FIELDS.filter((field) => catalog?.[field] == null);
}

function ageInDays(reviewedAt, now) {
  const reviewedAtMs = Date.parse(reviewedAt ?? "");
  const nowMs = Date.parse(now ?? "");
  if (!Number.isFinite(reviewedAtMs) || !Number.isFinite(nowMs)) return null;
  return (nowMs - reviewedAtMs) / 86_400_000;
}

/**
 * Read-only comparison of the reviewed intelligence profile catalog against
 * observed public guidance text. Never mutates the catalog; any drift this
 * finds requires a deliberate, separate code/release change to resolve.
 *
 * `guidance` carries the raw fetched text for the two reference docs so the
 * comparison can check literal substrings (model IDs, effort tier strings)
 * rather than trusting a second hardcoded copy of what those docs should say.
 */
export function checkModelCatalogFreshness({
  catalog,
  guidance = {},
  now,
}) {
  const missingFields = missingCatalogFields(catalog);
  if (missingFields.length > 0) {
    return {
      schemaVersion: 1,
      ok: false,
      freshness: "malformed-provenance",
      catalogVersion: catalog?.catalogVersion ?? null,
      reviewedAt: catalog?.reviewedAt ?? null,
      sourceUrl: catalog?.sourceUrl ?? null,
      observedAt: guidance?.observedAt ?? null,
      ageDays: null,
      differences: missingFields.map((field) => ({
        profile: null,
        field,
        detail: `catalog is missing required provenance field "${field}"`,
      })),
      recommendation:
        "Fix the catalog's own provenance fields before a freshness comparison can run.",
    };
  }

  const differences = [];
  const modelsText = guidance.modelsGuidanceText ?? "";
  const subagentsText = guidance.subagentsGuidanceText ?? "";

  if (guidance.modelsGuidanceText != null && modelsText.trim() === "") {
    differences.push({
      profile: null,
      field: "modelsGuidanceText",
      detail: "fetched Models guidance was empty",
    });
  }
  if (guidance.subagentsGuidanceText != null && subagentsText.trim() === "") {
    differences.push({
      profile: null,
      field: "subagentsGuidanceText",
      detail: "fetched Subagents guidance was empty",
    });
  }

  for (const profile of Object.values(catalog.profiles ?? {})) {
    if (guidance.modelsGuidanceText != null && !modelsText.includes(profile.requestedModel)) {
      differences.push({
        profile: profile.id,
        field: "requestedModel",
        detail: `Models guidance no longer mentions "${profile.requestedModel}"`,
      });
    }
    for (const effort of profile.supportedEfforts ?? []) {
      if (guidance.modelsGuidanceText != null && !modelsText.includes(effort)) {
        differences.push({
          profile: profile.id,
          field: "supportedEfforts",
          detail: `Models guidance no longer mentions the "${effort}" reasoning-effort tier`,
        });
      }
    }
  }

  const ageDays = ageInDays(catalog.reviewedAt, now);
  const stale = ageDays == null || ageDays > STALE_AFTER_DAYS;
  const freshness =
    differences.length > 0 ? "changed-guidance" : stale ? "stale" : "fresh";

  return {
    schemaVersion: 1,
    ok: freshness === "fresh",
    freshness,
    catalogVersion: catalog.catalogVersion,
    reviewedAt: catalog.reviewedAt,
    sourceUrl: catalog.sourceUrl,
    observedAt: guidance?.observedAt ?? null,
    ageDays,
    differences,
    recommendation:
      freshness === "fresh"
        ? "No action needed."
        : freshness === "changed-guidance"
          ? "Guidance has drifted from the reviewed catalog. Review the listed differences and, only if they reflect a real policy change, update the catalog deliberately; this check never edits it itself."
          : `Re-review the catalog against ${catalog.sourceUrl} and update reviewedAt/catalogVersion deliberately; this check never edits the catalog itself.`,
  };
}
