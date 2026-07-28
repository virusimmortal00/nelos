#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const testName =
  "a clean isolated home bootstraps source and marketplace idempotently";
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./scripts/test-bootstrap.mjs",
    "--test",
    "--test-reporter=tap",
    `--test-name-pattern=${testName}`,
    "test/distribution-install.test.mjs",
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  },
);

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (
  !/^# tests 1$/mu.test(result.stdout) ||
  !/^# pass 1$/mu.test(result.stdout) ||
  !/^# fail 0$/mu.test(result.stdout) ||
  !new RegExp(`^ok \\d+ - ${testName}$`, "mu").test(result.stdout)
) {
  throw new Error(`clean-install gate did not execute exactly "${testName}"`);
}
