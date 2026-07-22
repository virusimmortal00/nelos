#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { INTELLIGENCE_PROFILE_CATALOG } from "../src/intelligence-profile-catalog.mjs";
import { checkModelCatalogFreshness } from "../src/model-catalog-freshness.mjs";

const MODELS_GUIDANCE_URL = "https://learn.chatgpt.com/docs/models";
const SUBAGENTS_GUIDANCE_URL =
  "https://learn.chatgpt.com/docs/agent-configuration/subagents";

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

async function fetchGuidanceText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetching ${url} failed: HTTP ${response.status}`);
  }
  return response.text();
}

export async function collectGuidance({ offline = false } = {}) {
  if (offline) return {};
  const [modelsGuidanceText, subagentsGuidanceText] = await Promise.all([
    fetchGuidanceText(MODELS_GUIDANCE_URL),
    fetchGuidanceText(SUBAGENTS_GUIDANCE_URL),
  ]);
  return { modelsGuidanceText, subagentsGuidanceText };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(usage());
    return;
  }
  const offline = args.includes("--offline");
  const guidance = await collectGuidance({ offline });
  guidance.observedAt = new Date().toISOString();
  const report = checkModelCatalogFreshness({
    catalog: INTELLIGENCE_PROFILE_CATALOG,
    guidance,
    now: new Date().toISOString(),
  });
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
