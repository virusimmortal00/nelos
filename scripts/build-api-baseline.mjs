#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalBytes } from "../src/experimentation-contract/index.mjs";
import { createApiBaselineBundle, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";

function argumentsOf(argv) {
  const allowed = new Set(["mode", "out", "source-commit", "model-id", "model-revision", "reasoning-effort", "runtime-version", "runtime-digest", "backend", "platform"]);
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
const bundle = createApiBaselineBundle({
  mode: options.mode ?? "canary",
  sourceCommit: options["source-commit"],
  requestedModel: { id: options["model-id"], revision: options["model-revision"], reasoningEffort: options["reasoning-effort"] },
  runtime: { backend: options.backend ?? "oci-headless", platform: options.platform ?? "linux-arm64", runtimeVersion: options["runtime-version"], runtimeDigest: options["runtime-digest"] },
});
validateApiBaselineBundle(bundle);
await mkdir(dirname(out), { recursive: true, mode: 0o700 });
await writeFile(out, canonicalBytes(bundle), { mode: 0o400, flag: "wx" });
process.stdout.write(`${JSON.stringify({ bundle: out, bundleDigest: bundle.bundleDigest, scheduleDigest: bundle.executionSchedule.scheduleDigest, trials: bundle.executionSchedule.trialCount })}\n`);
