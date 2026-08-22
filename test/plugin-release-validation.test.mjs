import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  PLUGIN_PAYLOAD_PATHS,
  validatePluginRelease,
  validatePluginReleaseChange,
} from "../scripts/validate-plugin-release.mjs";
import {
  buildAgentPluginManifest,
  buildAgentPluginMcpConfig,
} from "../scripts/generate-mcp-config.mjs";

const execFileAsync = promisify(execFile);
const sourceRepository = "https://github.com/virusimmortal00/nelos.git";

test("Desktop candidate and validation sources are release-intent payload", () => {
  assert.ok(PLUGIN_PAYLOAD_PATHS.includes("scripts/stage-production-desktop-candidate.mjs"));
  assert.ok(PLUGIN_PAYLOAD_PATHS.includes("validation"));
});

async function git(root, ...args) {
  await execFileAsync("git", args, { cwd: root });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("ordinary evaluation or fix work may retain the current plugin version", () => {
  assert.deepEqual(validatePluginReleaseChange({
    baseVersion: "1.0.0",
    candidateVersion: "1.0.0",
    baseCacheIdentity: "repo#nelos@1.0.0",
    candidateCacheIdentity: "repo#nelos@1.0.0",
    payloadChanged: true,
  }), {
    changed: true,
    releaseIntentional: false,
    version: "1.0.0",
    cacheIdentity: "repo#nelos@1.0.0",
  });
});

test("ordinary source revision changes may retain an otherwise unchanged identity", () => {
  assert.deepEqual(validatePluginReleaseChange({
    baseVersion: "1.0.0",
    candidateVersion: "1.0.0",
    baseCacheIdentity: "repo#nelos@1.0.0",
    candidateCacheIdentity: "repo#nelos@1.0.0",
    payloadChanged: false,
    sourceRevisionChanged: true,
  }), {
    changed: true,
    releaseIntentional: false,
    version: "1.0.0",
    cacheIdentity: "repo#nelos@1.0.0",
  });
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
    releaseIntentional: true,
    version: "1.1.0",
    cacheIdentity: "repo#nelos@1.1.0",
  });
});

test("ordinary evaluation evidence is validated from Git without a bump", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-release-validation-"));
  const version = "1.0.0";
  const cacheIdentity = `${sourceRepository}#nelos@${version}`;
  const provenancePath = join(root, "distribution-provenance.json");
  try {
    await mkdir(join(root, ".codex-plugin"));
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Nelos Test");
    await git(root, "config", "user.email", "nelos@example.invalid");
    const legacyManifest = {
      name: "nelos",
      version,
      releaseBuildIdentity: `nelos-release-v1:${version}`,
    };
    await writeJson(join(root, ".codex-plugin", "plugin.json"), legacyManifest);
    await writeJson(join(root, "plugin.json"), buildAgentPluginManifest(legacyManifest));
    await writeJson(join(root, "package.json"), { version });
    await writeJson(join(root, "package-lock.json"), {
      version,
      packages: { "": { version } },
    });
    await writeJson(join(root, ".mcp.json"), {
      mcpServers: { nelos: { env: {
        NELOS_PLUGIN_VERSION: version,
        NELOS_RELEASE_BUILD_IDENTITY: `nelos-release-v1:${version}`,
      } } },
    });
    await writeJson(
      join(root, "mcp.json"),
      buildAgentPluginMcpConfig(version, legacyManifest.releaseBuildIdentity),
    );
    await writeJson(provenancePath, {
      revision: version,
      sourceRepository,
      sourceRevision: "a".repeat(40),
      sourceRevisionType: "git",
      cacheIdentity,
    });
    await mkdir(join(root, "validation"));
    await writeFile(join(root, "validation", "desktop-contract.json"), "initial evidence\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");

    await writeFile(join(root, "validation", "desktop-contract.json"), "observed fix evidence\n");

    assert.deepEqual(await validatePluginRelease({ baseRef: "HEAD", root }), {
      changed: true,
      releaseIntentional: false,
      version,
      cacheIdentity,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an inconsistent intentional release bump fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-release-validation-"));
  const version = "1.0.0";
  const cacheIdentity = `${sourceRepository}#nelos@${version}`;
  try {
    await mkdir(join(root, ".codex-plugin"));
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Nelos Test");
    await git(root, "config", "user.email", "nelos@example.invalid");
    const legacyManifest = {
      name: "nelos",
      version,
      releaseBuildIdentity: `nelos-release-v1:${version}`,
    };
    await writeJson(join(root, ".codex-plugin", "plugin.json"), legacyManifest);
    await writeJson(join(root, "plugin.json"), buildAgentPluginManifest(legacyManifest));
    await writeJson(join(root, "package.json"), { version });
    await writeJson(join(root, "package-lock.json"), {
      version,
      packages: { "": { version } },
    });
    await writeJson(join(root, ".mcp.json"), {
      mcpServers: { nelos: { env: {
        NELOS_PLUGIN_VERSION: version,
        NELOS_RELEASE_BUILD_IDENTITY: `nelos-release-v1:${version}`,
      } } },
    });
    await writeJson(
      join(root, "mcp.json"),
      buildAgentPluginMcpConfig(version, legacyManifest.releaseBuildIdentity),
    );
    await writeJson(join(root, "distribution-provenance.json"), {
      revision: version,
      sourceRepository,
      sourceRevision: "a".repeat(40),
      sourceRevisionType: "git",
      cacheIdentity,
    });
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");

    const bumpedManifest = {
      ...legacyManifest,
      version: "1.0.1",
      releaseBuildIdentity: "nelos-release-v1:1.0.1",
    };
    await writeJson(join(root, ".codex-plugin", "plugin.json"), bumpedManifest);
    await writeJson(join(root, "plugin.json"), buildAgentPluginManifest(bumpedManifest));
    await writeJson(join(root, ".mcp.json"), {
      mcpServers: { nelos: { env: {
        NELOS_PLUGIN_VERSION: "1.0.1",
        NELOS_RELEASE_BUILD_IDENTITY: "nelos-release-v1:1.0.1",
      } } },
    });
    await writeJson(
      join(root, "mcp.json"),
      buildAgentPluginMcpConfig("1.0.1", bumpedManifest.releaseBuildIdentity),
    );

    await assert.rejects(
      validatePluginRelease({ baseRef: "HEAD", root }),
      /package\.json version 1\.0\.0 does not match plugin 1\.0\.1/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
