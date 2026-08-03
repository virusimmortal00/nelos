#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalBytes } from "../src/experimentation-contract/index.mjs";
import { createStarterDevelopmentRelease } from "../src/experimentation-corpus/index.mjs";

const arguments_ = process.argv.slice(2);
const check = arguments_.includes("--check");
const outIndex = arguments_.indexOf("--out");
const out = outIndex === -1 ? null : arguments_[outIndex + 1];
if (outIndex !== -1 && !out) throw new Error("--out requires a directory");

const { release, packages } = createStarterDevelopmentRelease();
const lock = {
  schemaVersion: 1,
  version: release.version,
  releaseId: release.releaseId,
  digest: release.digest,
  taskIds: packages.map((entry) => entry.task.taskId).sort(),
  packageDigests: packages.map((entry) => entry.digest).sort(),
};

if (check) {
  const expected = JSON.parse(await readFile(new URL("../corpus/starter/release-lock.json", import.meta.url), "utf8"));
  if (JSON.stringify(lock) !== JSON.stringify(expected)) {
    throw new Error("starter corpus differs from its release lock; author a semantic task and corpus revision");
  }
}

if (out) {
  const root = resolve(out);
  await mkdir(resolve(root, "packages"), { recursive: true });
  await writeFile(resolve(root, "corpus-release.json"), canonicalBytes(release));
  for (const taskPackage of packages) {
    await writeFile(resolve(root, "packages", `${taskPackage.task.taskId.slice(5)}.json`), canonicalBytes(taskPackage));
  }
  await writeFile(resolve(root, "release-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

process.stdout.write(`${release.releaseId} ${release.digest}\n`);
