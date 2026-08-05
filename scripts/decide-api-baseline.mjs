#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { evaluateConfirmatoryAuthorization, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";
import { canonicalBytes } from "../src/experimentation-contract/index.mjs";

function options(argv) { const value = {}; for (let index = 0; index < argv.length; index += 2) value[argv[index]?.slice(2)] = argv[index + 1]; return value; }
const input = options(process.argv.slice(2));
if (!input.bundle || !input.observations) throw new Error("usage: decide-api-baseline --bundle FILE --observations FILE");
const bundle = JSON.parse(await readFile(resolve(input.bundle), "utf8"));
const observations = JSON.parse(await readFile(resolve(input.observations), "utf8"));
validateApiBaselineBundle(bundle);
const decision = evaluateConfirmatoryAuthorization({ varianceEvidence: observations });
if (input.out) {
  const out = resolve(input.out); await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, canonicalBytes(decision), { mode: 0o400, flag: "wx" });
}
process.stdout.write(`${JSON.stringify(decision)}\n`);
