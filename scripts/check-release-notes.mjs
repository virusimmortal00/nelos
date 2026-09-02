#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { checkReleaseNotes } from "./release-notes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
async function main() {
  const args = process.argv.slice(2);
  let baseRef;
  let requireReview = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--require-review") requireReview = true;
    else if (args[i] === "--base-ref" && args[i + 1] && !args[i + 1].startsWith("-")) baseRef = args[++i];
    else throw new Error(`unsupported release notes argument: ${args[i]}`);
  }
  if (baseRef && requireReview) throw new Error("choose --base-ref or --require-review, not both");
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  let baseVersion, baseChangelog;
  if (baseRef) {
    // Resolve first so caller input cannot be interpreted as a git-show option.
    const commit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
    baseVersion = JSON.parse(execFileSync("git", ["show", `${commit}:package.json`], { cwd: root, encoding: "utf8" })).version;
    baseChangelog = execFileSync("git", ["show", `${commit}:CHANGELOG.md`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  }
  console.log(JSON.stringify(await checkReleaseNotes({ root, version, baseVersion, baseChangelog, requireReview: requireReview || !baseRef })));
}
main().catch((error) => { console.error(`release-notes: ${error.message}`); process.exitCode = 1; });
