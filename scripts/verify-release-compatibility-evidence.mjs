#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
} from "../src/compatibility-contract-registry.mjs";

function take(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`${name} is required`);
  return argv[index + 1];
}

export async function main(argv = process.argv.slice(2)) {
  const releaseId = take(argv, "--release-id");
  const output = take(argv, "--out");
  const source = JSON.parse(await readFile(resolve(take(argv, "--source")), "utf8"));
  const schema = JSON.parse(await readFile(resolve(take(argv, "--schema")), "utf8"));
  const runtime = JSON.parse(await readFile(resolve(take(argv, "--runtime")), "utf8"));
  const release = COMPATIBILITY_CONTRACT_REGISTRY_V1.supportedCodexReleases
    .find(({ id }) => id === releaseId);
  if (!release) throw new Error(`release evidence ref ${releaseId} is unresolved`);
  const declared = release.upstreamSourceRefs.find(
    ({ repository }) => repository === "https://github.com/openai/codex",
  );
  const sourceReports = source.reports ?? [];
  const sourceMatches = source.releaseId === releaseId &&
    source.countsForCompatibility === true &&
    sourceReports.length > 0 &&
    sourceReports.every((report) =>
      report.outcome === "evidence" &&
      report.commitSha === declared.commitSha &&
      report.requestedRef === declared.requestedRef);
  const schemaMatches = schema.outcome === "passed" &&
    schema.releaseId === releaseId &&
    schema.observedCodexIdentity?.version === release.version;
  const runtimeMatches = runtime.outcome === "passed" &&
    runtime.expectedCodexIdentities?.length === 1 &&
    runtime.expectedCodexIdentities[0].version === release.version &&
    runtime.observedCodexIdentity?.version === release.version;
  if (!sourceMatches || !schemaMatches || !runtimeMatches) {
    throw new Error(
      `release evidence for ${releaseId} is unresolved, mismatched, or unavailable`,
    );
  }
  const bundle = {
    schemaVersion: 1,
    outcome: "passed",
    countsForCompatibility: true,
    releaseId,
    codexIdentity: {
      version: release.version,
      requestedRef: declared.requestedRef,
      commitSha: declared.commitSha,
    },
    evidence: {
      openSource: source,
      generatedSchema: schema,
      runtimeTransport: runtime,
    },
  };
  await writeFile(resolve(output), `${JSON.stringify(bundle, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`verify-release-compatibility-evidence: ${error.message}\n`);
    process.exitCode = 1;
  });
}
