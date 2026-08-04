#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateConfirmatoryAuthorization, validateApiBaselineBundle } from "../src/api-baseline-harness.mjs";

function options(argv) { const value = {}; for (let index = 0; index < argv.length; index += 2) value[argv[index]?.slice(2)] = argv[index + 1]; return value; }
const input = options(process.argv.slice(2));
if (!input.bundle || !input.observations) throw new Error("usage: decide-api-baseline --bundle FILE --observations FILE");
const bundle = JSON.parse(await readFile(resolve(input.bundle), "utf8"));
const observations = JSON.parse(await readFile(resolve(input.observations), "utf8"));
validateApiBaselineBundle(bundle);
const decision = evaluateConfirmatoryAuthorization({ varianceEvidence: observations });
process.stdout.write(`${JSON.stringify(decision)}\n`);
