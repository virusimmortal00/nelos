#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { runDesktopSmokeBundleCommandV1 } from "../src/desktop-smoke-cli.mjs";

function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] ?? null; }
function required(name) { const value = argument(name); if (!value) throw new Error(`${name} is required`); return value; }

export async function runRoutineDesktopSmokeV1({ candidatePath, outputDirectory, runId } = {}) {
  if (!candidatePath || !outputDirectory || !runId) throw new Error("candidatePath, outputDirectory, and runId are required");
  const output = resolve(outputDirectory);
  if (!isAbsolute(output)) throw new Error("outputDirectory must be absolute");
  await mkdir(output, { recursive: true, mode: 0o700 });
  return runDesktopSmokeBundleCommandV1({ candidatePath, scenarioSetName: "routine", runId, bundleOutput: join(output, "routine-bundle.json") });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRoutineDesktopSmokeV1({ candidatePath: required("--candidate"), outputDirectory: required("--out-dir"), runId: required("--run-id") })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`desktop-smoke-routine: ${error.message}\n`); process.exitCode = 1; });
}
