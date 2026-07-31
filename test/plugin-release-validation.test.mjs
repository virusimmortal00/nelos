import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  validatePluginRelease,
  validatePluginReleaseChange,
} from "../scripts/validate-plugin-release.mjs";

const execFileAsync = promisify(execFile);
const sourceRepository = "https://github.com/virusimmortal00/nelos.git";

async function git(root, ...args) {
  await execFileAsync("git", args, { cwd: root });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("changed plugin bytes cannot reuse a version or cache identity", () => {
  assert.throws(() => validatePluginReleaseChange({
    baseVersion: "1.0.0",
    candidateVersion: "1.0.0",
    baseCacheIdentity: "repo#nelos@1.0.0",
    candidateCacheIdentity: "repo#nelos@1.0.0",
    payloadChanged: true,
  }), /without a version bump/u);
});

test("changed source revision cannot reuse an otherwise unchanged identity", () => {
  assert.throws(() => validatePluginReleaseChange({
    baseVersion: "1.0.0",
    candidateVersion: "1.0.0",
    baseCacheIdentity: "repo#nelos@1.0.0",
    candidateCacheIdentity: "repo#nelos@1.0.0",
    payloadChanged: false,
    sourceRevisionChanged: true,
  }), /without a version bump/u);
});

test("versioned payload upgrade changes the cache identity", () => {
  assert.deepEqual(validatePluginReleaseChange({
    baseVersion: "1.0.0",
    candidateVersion: "1.1.0",
    baseCacheIdentity: "repo#nelos@1.0.0",
    candidateCacheIdentity: "repo#nelos@1.1.0",
    payloadChanged: true,
  }), {
    changed: true,
    version: "1.1.0",
    cacheIdentity: "repo#nelos@1.1.0",
  });
});

test("provenance-only source revision changes are validated from Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-release-validation-"));
  const version = "1.0.0";
  const cacheIdentity = `${sourceRepository}#nelos@${version}`;
  const provenancePath = join(root, "distribution-provenance.json");
  try {
    await mkdir(join(root, ".codex-plugin"));
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Nelos Test");
    await git(root, "config", "user.email", "nelos@example.invalid");
    await writeJson(join(root, ".codex-plugin", "plugin.json"), { version });
    await writeJson(join(root, "package.json"), { version });
    await writeJson(join(root, ".mcp.json"), {
      nelos: { env: { NELOS_PLUGIN_VERSION: version } },
    });
    await writeJson(provenancePath, {
      revision: version,
      sourceRepository,
      sourceRevision: "a".repeat(40),
      sourceRevisionType: "git",
      cacheIdentity,
    });
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");

    await writeJson(provenancePath, {
      revision: version,
      sourceRepository,
      sourceRevision: "b".repeat(40),
      sourceRevisionType: "git",
      cacheIdentity,
    });

    await assert.rejects(
      validatePluginRelease({ baseRef: "HEAD", root }),
      /without a version bump/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
