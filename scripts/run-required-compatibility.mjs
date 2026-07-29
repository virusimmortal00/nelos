#!/usr/bin/env node

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { main as runCompatibility } from "../bin/nelos-compatibility";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

export async function resolveRequiredCompatibilityRange({
  baseRef = process.env.COMPATIBILITY_BASE_REF ||
    (process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : "origin/main"),
  head = process.env.COMPATIBILITY_HEAD || "HEAD",
  cwd = root,
  runGit = execFileAsync,
} = {}) {
  const { stdout } = await runGit(
    "git",
    ["merge-base", "--", baseRef, head],
    { cwd, encoding: "utf8" },
  );
  const base = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(base)) {
    throw new Error(`git merge-base returned an invalid commit for ${baseRef}`);
  }
  return { base, baseRef, head };
}

export async function main() {
  delete process.env.OPENAI_API_KEY;
  const range = await resolveRequiredCompatibilityRange();
  process.stderr.write(
    `required compatibility range: ${range.baseRef} (${range.base})...${range.head}\n`,
  );
  return runCompatibility([
    "--root",
    root,
    "--base",
    range.base,
    "--head",
    range.head,
  ]);
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`required compatibility gate: ${error.message}\n`);
      process.exitCode = 2;
    });
}
