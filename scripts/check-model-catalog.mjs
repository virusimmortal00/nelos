#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { INTELLIGENCE_PROFILE_CATALOG } from "../src/intelligence-profile-catalog.mjs";
import { checkModelCatalogFreshness } from "../src/model-catalog-freshness.mjs";
import { MODEL_CATALOG_DOCUMENTATION_CONTRACTS_V1 } from "../src/upstream-documentation-contracts.mjs";
import {
  collectUpstreamDocumentationContractsV1,
  createUpstreamDocumentationReportV1,
} from "../src/upstream-documentation-evidence.mjs";

function usage() {
  return `Usage: node scripts/check-model-catalog.mjs [options]

Read-only freshness check: compares the reviewed intelligence profile
catalog (src/intelligence-profile-catalog.mjs) against the current public
Models and Subagents guidance. Never mutates the catalog, never queries a
host account, and never asserts live model entitlement or availability --
only the host is authoritative for that at launch time. Any drift this
finds requires a separate, deliberate code/release change to resolve.

Options:
  --offline    Skip fetching guidance and only run the malformed-provenance
               and stale-by-date checks against the local catalog.
  -h, --help   Show this help
`;
}

export async function collectGuidance({
  offline = false,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  if (offline) return {};
  const observations = await collectUpstreamDocumentationContractsV1(
    MODEL_CATALOG_DOCUMENTATION_CONTRACTS_V1,
    { fetchImpl, now },
  );
  const byId = new Map(observations.map((item) => [item.contractId, item]));
  const models = byId.get("model-catalog.models-guidance");
  const subagents = byId.get("model-catalog.subagents-guidance");
  return {
    ...(models?.status === "available"
      ? { modelsGuidanceText: models.selectedText }
      : {}),
    ...(subagents?.status === "available"
      ? { subagentsGuidanceText: subagents.selectedText }
      : {}),
    observedAt: observations[0]?.observedAt ?? now(),
    upstreamDocumentation: createUpstreamDocumentationReportV1(observations),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(usage());
    return;
  }
  const offline = args.includes("--offline");
  const guidance = await collectGuidance({ offline });
  const observedAt = new Date().toISOString();
  const report = checkModelCatalogFreshness({
    catalog: INTELLIGENCE_PROFILE_CATALOG,
    guidance,
    now: observedAt,
  });
  if (guidance.upstreamDocumentation?.status === "unavailable") {
    report.ok = false;
    report.freshness = "unavailable-infrastructure";
    report.recommendation =
      "Upstream documentation collection was unavailable. Retry the advisory collector; do not treat this infrastructure outcome as model-catalog drift or compatibility evidence.";
  }
  report.upstreamDocumentation = guidance.upstreamDocumentation ?? null;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`check-model-catalog: ${error.message}\n`);
    process.exitCode = 1;
  });
}
