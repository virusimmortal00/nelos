#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalBytes } from "../src/experimentation-contract/index.mjs";
import { createApiBaselineBundle, measureRuntimeProvenance, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";

function argumentsOf(argv) {
  const allowed = new Set(["mode", "out", "source-commit", "model-id", "model-revision", "reasoning-effort", "runtime-executable", "expected-runtime-digest", "backend", "platform", "pricing-snapshot"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || argv[index + 1] === undefined || !allowed.has(name.slice(2)) || Object.hasOwn(result, name.slice(2))) throw new Error("INVALID_BUILD_ARGUMENTS");
    result[name.slice(2)] = argv[index + 1];
  }
  return result;
}

const options = argumentsOf(process.argv.slice(2));
const out = resolve(options.out ?? `api-baseline-${options.mode ?? "canary"}.json`);
if ((options.mode ?? "canary") !== "canary") throw new Error("CONFIRMATORY_POWER_AUTHORIZATION_REQUIRED");
if (!options["runtime-executable"]) throw new Error("runtime-executable is required");
if (!options["pricing-snapshot"]) throw new Error("pricing-snapshot is required");
const runtimeProvenance = await measureRuntimeProvenance({ executablePath: resolve(options["runtime-executable"]), backend: options.backend ?? "dedicated-desktop", platform: options.platform ?? "macos-arm64", expectedExecutableDigest: options["expected-runtime-digest"] ?? null });
const bundle = createApiBaselineBundle({
  mode: "canary",
  sourceCommit: options["source-commit"],
  requestedModel: { id: options["model-id"], revision: options["model-revision"], reasoningEffort: options["reasoning-effort"] },
  runtimeProvenance,
  pricingSnapshot: JSON.parse(await readFile(resolve(options["pricing-snapshot"]), "utf8")),
});
validateApiBaselineBundle(bundle);
await mkdir(dirname(out), { recursive: true, mode: 0o700 });
await writeFile(out, canonicalBytes(bundle), { mode: 0o400, flag: "wx" });
process.stdout.write(`${JSON.stringify({ bundle: out, bundleDigest: bundle.bundleDigest, scheduleDigest: bundle.executionSchedule.scheduleDigest, trials: bundle.executionSchedule.trialCount })}\n`);
