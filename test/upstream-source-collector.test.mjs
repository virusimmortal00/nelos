import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
  validateCompatibilityRegistryV1,
} from "../src/compatibility-contract-registry.mjs";
import {
  collectUpstreamSourceEvidenceV1,
} from "../src/upstream-source-collector.mjs";

const execFileAsync = promisify(execFile);
const OBSERVED_AT = new Date("2026-07-29T12:00:00.000Z");
const REPOSITORY = "https://github.com/openai/codex";
const PATH = "codex-rs/app-server-protocol/src/protocol/common.rs";
const SECOND_PATH = "codex-rs/app-server-protocol/src/protocol/v2.rs";

test("collector is available through its public package subpath", async () => {
  const publicContract = await import("nelos/upstream-source-collector");
  assert.equal(
    publicContract.collectUpstreamSourceEvidenceV1,
    collectUpstreamSourceEvidenceV1,
  );
});

async function git(args, options = {}) {
  return execFileAsync("git", args, {
    ...options,
    encoding: options.encoding ?? "utf8",
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-source-fixture-"));
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  await mkdir(join(work, "codex-rs/app-server-protocol/src/protocol"), {
    recursive: true,
  });
  await mkdir(join(work, "private"), { recursive: true });
  await git(["init", "--quiet", "-b", "main", work]);
  await git(["-C", work, "config", "user.name", "Fixture"]);
  await git(["-C", work, "config", "user.email", "fixture@example.test"]);
  await writeFile(join(work, PATH), "pub const VERSION: u8 = 1;\n");
  await writeFile(join(work, SECOND_PATH), "pub const V2: bool = true;\n");
  await writeFile(join(work, "private/closed-host.txt"), "must never be selected\n");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "--quiet", "-m", "release"]);
  const releaseSha = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "tag", "-a", "rust-v0.144.5", "-m", "release"]);
  await writeFile(join(work, PATH), "pub const VERSION: u8 = 2;\n");
  await git(["-C", work, "add", PATH]);
  await git(["-C", work, "commit", "--quiet", "-m", "main drift"]);
  const mainSha = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["init", "--quiet", "--bare", remote]);
  await git(["-C", work, "remote", "add", "fixture", remote]);
  await git(["-C", work, "push", "--quiet", "fixture", "main", "rust-v0.144.5"]);

  const registry = structuredClone(COMPATIBILITY_CONTRACT_REGISTRY_V1);
  registry.supportedCodexReleases[0].upstreamSourceRefs[0] = {
    repository: REPOSITORY,
    requestedRef: "refs/tags/rust-v0.144.5",
    commitSha: releaseSha,
  };
  validateCompatibilityRegistryV1(registry);
  const beforeRefs = (await git(["--git-dir", remote, "show-ref"])).stdout;
  const beforeObjects = (await git([
    "--git-dir",
    remote,
    "count-objects",
    "-v",
  ])).stdout;
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, work, remote, registry, releaseSha, mainSha, beforeRefs, beforeObjects };
}

function request(evidenceRef, selectedPaths = [PATH]) {
  return {
    capabilityId: "app-server.protocol-shapes",
    repositoryUrl: REPOSITORY,
    evidenceRef,
    selectedPaths,
    selectedArtifacts: [],
  };
}

function options(remote, calls = undefined) {
  return {
    resolveRemote: (repository) => {
      assert.equal(repository, REPOSITORY);
      return remote;
    },
    now: () => OBSERVED_AT,
    ...(calls
      ? {
          runGit: async (args, processOptions) => {
            calls.push(args);
            return git(args, processOptions);
          },
        }
      : {}),
  };
}

test("exact annotated release tag yields bounded compatibility evidence", async (t) => {
  const data = await fixture(t);
  const calls = [];
  const result = await collectUpstreamSourceEvidenceV1(
    data.registry,
    request({ kind: "supported-release", releaseId: "codex@0.144.5" }),
    options(data.remote, calls),
  );

  assert.equal(result.outcome, "evidence");
  assert.equal(result.classification, "release");
  assert.equal(result.countsForCompatibility, true);
  assert.equal(result.repositoryUrl, REPOSITORY);
  assert.equal(result.requestedRef, "refs/tags/rust-v0.144.5");
  assert.equal(result.resolvedRef, "refs/tags/rust-v0.144.5^{}");
  assert.equal(result.commitSha, data.releaseSha);
  assert.equal(result.observedAt, OBSERVED_AT.toISOString());
  assert.deepEqual(result.selectedPaths, [PATH]);
  assert.deepEqual(result.selectedArtifacts, []);
  assert.deepEqual(result.artifacts, [{
    path: PATH,
    sha256: createHash("sha256")
      .update("pub const VERSION: u8 = 1;\n")
      .digest("hex"),
    size: 27,
  }]);
  assert.equal(result.authority, "public-source-only");
  assert.match(result.limitations.join(" "), /Desktop/u);
  assert.match(result.limitations.join(" "), /corroborated/u);

  assert.equal(calls.some((args) => args[0] === "clone"), false);
  const fetch = calls.find((args) => args.includes("fetch"));
  assert.ok(fetch.includes("--depth=1"));
  assert.ok(fetch.includes("--filter=blob:none"));
  assert.ok(fetch.includes("--no-tags"));
  const accessed = calls
    .filter((args) => ["cat-file", "show"].some((command) => args.includes(command)))
    .flat()
    .filter((arg) => typeof arg === "string" && arg.startsWith("FETCH_HEAD:"));
  assert.deepEqual([...new Set(accessed)], [`FETCH_HEAD:${PATH}`]);
});

test("an exact declared commit can supply release evidence", async (t) => {
  const data = await fixture(t);
  data.registry.supportedCodexReleases[0].upstreamSourceRefs[0] = {
    repository: REPOSITORY,
    requestedRef: data.releaseSha,
    commitSha: data.releaseSha,
  };
  const result = await collectUpstreamSourceEvidenceV1(
    data.registry,
    request({ kind: "supported-release", releaseId: "codex@0.144.5" }),
    options(data.remote),
  );
  assert.equal(result.outcome, "evidence");
  assert.equal(result.requestedRef, data.releaseSha);
  assert.equal(result.resolvedRef, data.releaseSha);
});

test("declared generated artifacts use the same exact-ref digest boundary", async (t) => {
  const data = await fixture(t);
  const registry = structuredClone(data.registry);
  registry.capabilities[0].mappings.upstreamSource[0].artifacts = [SECOND_PATH];
  const result = await collectUpstreamSourceEvidenceV1(
    registry,
    {
      ...request({ kind: "supported-release", releaseId: "codex@0.144.5" }),
      selectedPaths: [],
      selectedArtifacts: [SECOND_PATH],
    },
    options(data.remote),
  );
  assert.equal(result.outcome, "evidence");
  assert.deepEqual(result.selectedArtifacts, [SECOND_PATH]);
  assert.deepEqual(result.artifacts, [{
    path: SECOND_PATH,
    sha256: createHash("sha256")
      .update("pub const V2: bool = true;\n")
      .digest("hex"),
    size: 27,
  }]);
});

test("floating main is labeled early-warning and never counts as release evidence", async (t) => {
  const data = await fixture(t);
  const result = await collectUpstreamSourceEvidenceV1(
    data.registry,
    request({ kind: "floating-main" }),
    options(data.remote),
  );
  assert.equal(result.outcome, "advisory");
  assert.equal(result.classification, "early-warning-advisory");
  assert.equal(result.countsForCompatibility, false);
  assert.equal(result.requestedRef, "refs/heads/main");
  assert.equal(result.resolvedRef, "refs/heads/main");
  assert.equal(result.commitSha, data.mainSha);
  assert.match(result.reason, /advisory only/u);
});

test("mismatched, moved, unresolved, and infrastructure-failed refs are non-evidence", async (t) => {
  const data = await fixture(t);
  const mismatch = structuredClone(data.registry);
  mismatch.supportedCodexReleases[0].upstreamSourceRefs[0].commitSha =
    "1111111111111111111111111111111111111111";
  const mismatched = await collectUpstreamSourceEvidenceV1(
    mismatch,
    request({ kind: "supported-release", releaseId: "codex@0.144.5" }),
    options(data.remote),
  );
  assert.equal(mismatched.outcome, "non-evidence");
  assert.equal(mismatched.countsForCompatibility, false);
  assert.match(mismatched.reason, /does not match/u);
  assert.equal(mismatched.artifacts.length, 0);

  const moved = structuredClone(data.registry);
  moved.supportedCodexReleases[0].upstreamSourceRefs[0].requestedRef =
    "refs/tags/rust-v0.144.5-moved";
  const unresolved = await collectUpstreamSourceEvidenceV1(
    moved,
    request({ kind: "supported-release", releaseId: "codex@0.144.5" }),
    options(data.remote),
  );
  assert.equal(unresolved.outcome, "non-evidence");
  assert.equal(unresolved.resolvedRef, null);
  assert.match(unresolved.reason, /did not resolve/u);

  const failed = await collectUpstreamSourceEvidenceV1(
    data.registry,
    request({ kind: "supported-release", releaseId: "codex@0.144.5" }),
    options(join(data.root, "absent.git")),
  );
  assert.equal(failed.outcome, "non-evidence");
  assert.match(failed.reason, /infrastructure/u);
});

test("missing and non-file artifacts are non-evidence without partial digests", async (t) => {
  const data = await fixture(t);
  const registry = structuredClone(data.registry);
  registry.capabilities[0].mappings.upstreamSource[0].paths.push(
    "codex-rs/app-server-protocol/src/protocol/moved.rs",
    "codex-rs/app-server-protocol/src/protocol",
  );
  const missing = await collectUpstreamSourceEvidenceV1(
    registry,
    request(
      { kind: "supported-release", releaseId: "codex@0.144.5" },
      [PATH, "codex-rs/app-server-protocol/src/protocol/moved.rs"],
    ),
    options(data.remote),
  );
  assert.equal(missing.outcome, "non-evidence");
  assert.deepEqual(missing.artifacts, []);

  const directory = await collectUpstreamSourceEvidenceV1(
    registry,
    request(
      { kind: "supported-release", releaseId: "codex@0.144.5" },
      ["codex-rs/app-server-protocol/src/protocol"],
    ),
    options(data.remote),
  );
  assert.equal(directory.outcome, "non-evidence");
  assert.match(directory.reason, /ambiguous or not a file/u);
});

test("undeclared repositories, paths, artifacts, releases, and broad scans are rejected", async (t) => {
  const data = await fixture(t);
  const release = { kind: "supported-release", releaseId: "codex@0.144.5" };
  await assert.rejects(
    collectUpstreamSourceEvidenceV1(
      data.registry,
      { ...request(release), repositoryUrl: "https://github.com/example/repo" },
      options(data.remote),
    ),
    /repositoryUrl is not declared/u,
  );
  for (const selectedPaths of [["."], ["codex-rs"], ["codex-rs/**"]]) {
    await assert.rejects(
      collectUpstreamSourceEvidenceV1(
        data.registry,
        request(release, selectedPaths),
        options(data.remote),
      ),
      /selected path is undeclared/u,
    );
  }
  await assert.rejects(
    collectUpstreamSourceEvidenceV1(
      data.registry,
      {
        ...request(release),
        selectedPaths: [],
        selectedArtifacts: ["codex-rs/schema.json"],
      },
      options(data.remote),
    ),
    /selected artifact is undeclared/u,
  );
  await assert.rejects(
    collectUpstreamSourceEvidenceV1(
      data.registry,
      request({ kind: "supported-release", releaseId: "codex@9.9.9" }),
      options(data.remote),
    ),
    /releaseId is not supported/u,
  );
  await assert.rejects(
    collectUpstreamSourceEvidenceV1(
      data.registry,
      {
        ...request(release),
        semanticScan: true,
      },
      options(data.remote),
    ),
    /semanticScan is not allowed/u,
  );
});

test("collection does not mutate the source worktree or fake remote", async (t) => {
  const data = await fixture(t);
  await collectUpstreamSourceEvidenceV1(
    data.registry,
    request({ kind: "supported-release", releaseId: "codex@0.144.5" }),
    options(data.remote),
  );
  assert.equal((await git(["-C", data.work, "status", "--porcelain"])).stdout, "");
  assert.equal(
    (await git(["--git-dir", data.remote, "show-ref"])).stdout,
    data.beforeRefs,
  );
  assert.equal(
    (await git(["--git-dir", data.remote, "count-objects", "-v"])).stdout,
    data.beforeObjects,
  );
  assert.equal(
    await readFile(join(data.work, "private/closed-host.txt"), "utf8"),
    "must never be selected\n",
  );
});
