#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { bindReleaseCanary } from "../src/experiment-ci-gates.mjs";

function take(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const compatibilityPath = resolve(take("--compatibility"));
const runtimeLockPath = resolve(take("--runtime-lock"));
const schemaPath = resolve(take("--schema"));
const outputPath = resolve(take("--out"));
const packageRecord = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const distribution = JSON.parse(await readFile(resolve("distribution-provenance.json"), "utf8"));
const compatibility = await readFile(compatibilityPath);
const schema = await readFile(schemaPath);
const runtimeLock = await readFile(runtimeLockPath);
const evidence = bindReleaseCanary({
  codexVersion: take("--codex-version"),
  pluginVersion: packageRecord.version,
  pluginDigest: distribution.integrity,
  runtimeLockDigest: digest(runtimeLock),
  schemaDigest: digest(schema),
  compatibilityDigest: digest(compatibility),
  sourceCommit: take("--source-commit"),
});
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
