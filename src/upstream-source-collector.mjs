import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  UPSTREAM_SOURCE_OBSERVATION_SCHEMA_VERSION,
  validateCompatibilityRegistryV1,
} from "./compatibility-contract-registry.mjs";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new Error(`upstream source collector: ${message}`);
}

function closedObject(value, label, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${label}.${key} is not allowed`);
  }
}

function selectedItems(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      fail(`${label} must contain non-empty strings`);
    }
    if (seen.has(item)) fail(`${label} contains duplicate ${item}`);
    seen.add(item);
  }
  return value;
}

function observationBase({
  repositoryUrl,
  requestedRef,
  selectedPaths,
  selectedArtifacts,
  observedAt,
  classification,
}) {
  return {
    schemaVersion: UPSTREAM_SOURCE_OBSERVATION_SCHEMA_VERSION,
    outcome: "non-evidence",
    classification,
    countsForCompatibility: false,
    repositoryUrl,
    requestedRef,
    resolvedRef: null,
    commitSha: null,
    selectedPaths: [...selectedPaths],
    selectedArtifacts: [...selectedArtifacts],
    artifacts: [],
    observedAt,
    authority: "public-source-only",
    limitations: [
      "Does not infer Codex Desktop, cloud, entitlement, rollout, or closed-host behavior.",
      "Source-only drift is advisory until corroborated by official documentation, generated schemas, or exact runtime evidence.",
    ],
    reason: null,
  };
}

async function defaultRunGit(args, options = {}) {
  return execFileAsync("git", args, {
    ...options,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function classifyGitFailure(error) {
  const text = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  if (/not our ref|couldn't find remote ref|unknown revision|invalid object name/iu.test(text)) {
    return "requested ref or artifact did not resolve";
  }
  return "Git infrastructure failure";
}

async function resolveRef(runGit, remote, requestedRef) {
  if (SHA_PATTERN.test(requestedRef)) {
    return { resolvedRef: requestedRef, commitSha: requestedRef };
  }
  const { stdout } = await runGit([
    "ls-remote",
    remote,
    requestedRef,
    `${requestedRef}^{}`,
  ]);
  const refs = new Map(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/u);
        return [ref, sha];
      }),
  );
  const peeledRef = `${requestedRef}^{}`;
  if (refs.has(peeledRef)) {
    return { resolvedRef: peeledRef, commitSha: refs.get(peeledRef) };
  }
  if (refs.has(requestedRef)) {
    return { resolvedRef: requestedRef, commitSha: refs.get(requestedRef) };
  }
  throw Object.assign(new Error("requested ref did not resolve"), {
    stderr: "couldn't find remote ref",
  });
}

export async function collectUpstreamSourceEvidenceV1(
  registry,
  request,
  {
    runGit = defaultRunGit,
    resolveRemote = (repositoryUrl) => repositoryUrl,
    now = () => new Date(),
  } = {},
) {
  validateCompatibilityRegistryV1(registry);
  closedObject(request, "request", [
    "capabilityId",
    "repositoryUrl",
    "evidenceRef",
    "selectedPaths",
    "selectedArtifacts",
  ]);
  closedObject(request.evidenceRef, "request.evidenceRef", [
    "kind",
    "releaseId",
  ]);
  const capability = registry.capabilities.find(
    ({ id }) => id === request.capabilityId,
  );
  if (!capability) fail("capabilityId is not declared by the contract");
  const source = capability.mappings.upstreamSource.find(
    ({ repository }) => repository === request.repositoryUrl,
  );
  if (!source) fail("repositoryUrl is not declared for the capability");
  const selectedPaths = selectedItems(request.selectedPaths, "request.selectedPaths");
  const selectedArtifacts = selectedItems(
    request.selectedArtifacts,
    "request.selectedArtifacts",
  );
  if (selectedPaths.length + selectedArtifacts.length === 0) {
    fail("at least one selected path or artifact is required");
  }
  for (const path of selectedPaths) {
    if (!source.paths.includes(path)) fail(`selected path is undeclared: ${path}`);
  }
  for (const artifact of selectedArtifacts) {
    if (!source.artifacts.includes(artifact)) {
      fail(`selected artifact is undeclared: ${artifact}`);
    }
  }

  let requestedRef;
  let expectedCommitSha = null;
  let classification;
  if (request.evidenceRef.kind === "supported-release") {
    if (typeof request.evidenceRef.releaseId !== "string") {
      fail("supported-release requires releaseId");
    }
    const release = registry.supportedCodexReleases.find(
      ({ id }) => id === request.evidenceRef.releaseId,
    );
    if (!capability.supportedCodexReleases.includes(request.evidenceRef.releaseId)) {
      fail("releaseId is not supported by the capability");
    }
    const declaration = release?.upstreamSourceRefs.find(
      ({ repository }) => repository === request.repositoryUrl,
    );
    if (!declaration) fail("release ref is not declared for the repository");
    requestedRef = declaration.requestedRef;
    expectedCommitSha = declaration.commitSha;
    classification = "release";
  } else if (request.evidenceRef.kind === "floating-main") {
    if (request.evidenceRef.releaseId !== undefined) {
      fail("floating-main cannot name a releaseId");
    }
    if (!source.advisoryRef) fail("floating ref is not declared for the capability");
    requestedRef = source.advisoryRef;
    classification = "early-warning-advisory";
  } else {
    fail("evidenceRef.kind must be supported-release or floating-main");
  }

  const observedAtValue = now();
  const observedAt = observedAtValue instanceof Date
    ? observedAtValue.toISOString()
    : fail("now must return a Date");
  const result = observationBase({
    repositoryUrl: request.repositoryUrl,
    requestedRef,
    selectedPaths,
    selectedArtifacts,
    observedAt,
    classification,
  });
  const remote = resolveRemote(request.repositoryUrl);
  if (typeof remote !== "string" || remote.length === 0) {
    fail("resolved Git remote must be a non-empty string");
  }

  let checkout;
  try {
    const resolved = await resolveRef(runGit, remote, requestedRef);
    result.resolvedRef = resolved.resolvedRef;
    result.commitSha = resolved.commitSha;
    if (!SHA_PATTERN.test(result.commitSha)) {
      result.reason = "resolved ref returned an invalid commit SHA";
      return Object.freeze(result);
    }
    if (expectedCommitSha && result.commitSha !== expectedCommitSha) {
      result.reason = "resolved commit SHA does not match the declared expectation";
      return Object.freeze(result);
    }

    checkout = await mkdtemp(join(tmpdir(), "nelos-upstream-source-"));
    await runGit(["init", "--quiet", checkout]);
    await runGit(["-C", checkout, "remote", "add", "origin", remote]);
    await runGit([
      "-c",
      "protocol.version=2",
      "-C",
      checkout,
      "fetch",
      "--quiet",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      result.commitSha,
    ]);
    const fetched = await runGit([
      "-C",
      checkout,
      "rev-parse",
      "FETCH_HEAD^{commit}",
    ]);
    if (fetched.stdout.trim() !== result.commitSha) {
      result.reason = "fetched commit does not match the resolved ref";
      return Object.freeze(result);
    }

    for (const path of [...selectedPaths, ...selectedArtifacts]) {
      const type = await runGit([
        "-C",
        checkout,
        "cat-file",
        "-t",
        `FETCH_HEAD:${path}`,
      ]);
      if (type.stdout.trim() !== "blob") {
        result.reason = `selected artifact is ambiguous or not a file: ${path}`;
        result.artifacts = [];
        return Object.freeze(result);
      }
      const blob = await runGit(
        ["-C", checkout, "show", `FETCH_HEAD:${path}`],
        { encoding: "buffer" },
      );
      result.artifacts.push({
        path,
        sha256: createHash("sha256").update(blob.stdout).digest("hex"),
        size: blob.stdout.length,
      });
    }
    result.outcome = classification === "release" ? "evidence" : "advisory";
    result.countsForCompatibility = classification === "release";
    result.reason = classification === "release"
      ? "exact declared release ref and commit verified"
      : "floating main is early-warning advisory only";
    return Object.freeze(result);
  } catch (error) {
    result.artifacts = [];
    result.reason = classifyGitFailure(error);
    return Object.freeze(result);
  } finally {
    if (checkout) await rm(checkout, { recursive: true, force: true });
  }
}
