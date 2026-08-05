#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createCalibrationTrancheRequirement } from "../src/api-baseline-calibration-plan.mjs";
import { canonicalBytes } from "../src/experimentation-contract/index.mjs";

function options(argv) {
  const allowed = new Set(["bundle", "decision", "observations", "out"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    const key = name?.slice(2);
    if (!name?.startsWith("--") || value === undefined || !allowed.has(key) || Object.hasOwn(result, key)) throw new Error("INVALID_CALIBRATION_PLAN_ARGUMENTS");
    result[key] = value;
  }
  if ([...allowed].some((key) => !result[key])) throw new Error("usage: plan-api-baseline-calibration --bundle FILE --decision FILE --observations FILE --out FILE");
  return result;
}

const input = options(process.argv.slice(2));
const apiBundle = JSON.parse(await readFile(resolve(input.bundle), "utf8"));
const confirmatoryDecision = JSON.parse(await readFile(resolve(input.decision), "utf8"));
const varianceEvidence = JSON.parse(await readFile(resolve(input.observations), "utf8"));
const requirement = createCalibrationTrancheRequirement({ apiBundle, confirmatoryDecision, varianceEvidence });
const out = resolve(input.out);
await mkdir(dirname(out), { recursive: true, mode: 0o700 });
await writeFile(out, canonicalBytes(requirement), { mode: 0o400, flag: "wx" });
process.stdout.write(`${JSON.stringify({ out, status: requirement.status, executable: requirement.executable, trialCount: requirement.scheduleRequirement.trialCount, maxEstimatedCostUsd: requirement.ceilings.maxTotalEstimatedCostUsd, requirementDigest: requirement.requirementDigest })}\n`);
