#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalBytes, canonicalDigest, parseCanonicalJsonV1 } from "../src/experimentation-contract/index.mjs";
import { verifyExperimentReport } from "../src/experimentation-reporting/index.mjs";
import { normalizeApiBaselineVarianceEvidence } from "../src/api-baseline-variance-evidence.mjs";

function options(argv) {
  const allowed = new Set(["signed-in-input", "signed-in-report", "api-bundle", "api-trials", "out"]); const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1]; const key = name?.slice(2);
    if (!name?.startsWith("--") || value === undefined || !allowed.has(key) || Object.hasOwn(result, key)) throw new Error("INVALID_VARIANCE_BUILD_ARGUMENTS");
    result[key] = value;
  }
  if ([...allowed].some((key) => !result[key])) throw new Error("usage: build-api-baseline-variance-evidence --signed-in-input FILE --signed-in-report FILE --api-bundle FILE --api-trials FILE --out FILE");
  return result;
}

function jsonLines(bytes) {
  const text = bytes.toString("utf8");
  if (text.length > 0 && !text.endsWith("\n")) throw new Error("INVALID_API_TRIALS_JSONL");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const input = options(process.argv.slice(2));
const signedInInput = parseCanonicalJsonV1(await readFile(resolve(input["signed-in-input"])), { contractKind: "ExperimentReportInput", schemaVersion: 1 });
const signedInReport = parseCanonicalJsonV1(await readFile(resolve(input["signed-in-report"])), { contractKind: "ExperimentReport", schemaVersion: 1 });
const signedInVerification = verifyExperimentReport(signedInInput, signedInReport);
const apiBundle = JSON.parse(await readFile(resolve(input["api-bundle"]), "utf8"));
const apiResults = jsonLines(await readFile(resolve(input["api-trials"])));
const observations = normalizeApiBaselineVarianceEvidence({ signedInInput, apiBundle, apiResults });
const out = resolve(input.out); await mkdir(dirname(out), { recursive: true, mode: 0o700 });
await writeFile(out, canonicalBytes(observations), { mode: 0o400, flag: "wx" });
const phases = Object.fromEntries([...new Set(observations.map(({ phase }) => phase))].sort().map((phase) => [phase, observations.filter((item) => item.phase === phase).length]));
process.stdout.write(`${JSON.stringify({ out, evidenceDigest: canonicalDigest(observations), observations: observations.length, phases, signedInVerification })}\n`);
