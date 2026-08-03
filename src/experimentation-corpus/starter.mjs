import {
  canonicalBytes,
  canonicalDigest,
  createCorpusRelease,
  deriveTaskDigest,
  deriveTaskIdentity,
  reviseTask,
  sealTask,
  sha256Bytes,
  transitionCorpusRelease,
  transitionTask,
} from "../experimentation-contract/index.mjs";
import { createTaskPackage } from "./package.mjs";
import { analyzeCorpusDuplicates } from "./contamination.mjs";
import { starterGraderBundle } from "./grader.mjs";

export const STARTER_TASK_FAMILIES = Object.freeze([
  { id: "localized-repair", label: "Localized defect repair", risk: "low", size: "small", decomposability: "localized" },
  { id: "cross-cutting-feature", label: "Cross-cutting feature", risk: "medium", size: "medium", decomposability: "parallel" },
  { id: "multi-module-migration", label: "Multi-module migration", risk: "high", size: "large", decomposability: "sequential" },
  { id: "test-authoring", label: "Test authoring", risk: "medium", size: "medium", decomposability: "parallel" },
  { id: "refactor", label: "Behavior-preserving refactor", risk: "medium", size: "medium", decomposability: "localized" },
  { id: "investigation", label: "Repository investigation", risk: "low", size: "small", decomposability: "localized" },
  { id: "planning", label: "Planning and decomposition", risk: "medium", size: "medium", decomposability: "parallel" },
  { id: "routing", label: "Routing and capability selection", risk: "high", size: "small", decomposability: "localized" },
  { id: "orchestration-restart", label: "Orchestration and restart", risk: "high", size: "large", decomposability: "sequential" },
  { id: "compatibility-safety", label: "Compatibility and safety", risk: "critical", size: "large", decomposability: "parallel" },
]);

const FIXED_CLOCK = "2026-08-01T00:00:00Z";

function jsonBytes(value) {
  return canonicalBytes(value);
}

function taskAsset(family, suffix, audience, value, mediaType = "application/json") {
  return { assetId: `asset:${family.id}:${suffix}`, audience, mediaType, bytes: jsonBytes(value) };
}

function baseTask(family, assets, graderBundle) {
  const bySuffix = Object.fromEntries(assets.map((asset) => [asset.assetId.split(":").at(-1), sha256Bytes(asset.bytes)]));
  const promptText = `Complete the sealed ${family.label} fixture and return the required canonical JSON result.`;
  const candidate = {
    schemaVersion: 1,
    taskId: `task:${"0".repeat(64)}`,
    specRevision: 1,
    previousDigest: null,
    digest: `sha256:${"0".repeat(64)}`,
    state: "draft",
    prompt: { kind: "objective", encoding: "utf-8", text: promptText, digest: sha256Bytes(Buffer.from(promptText, "utf8")) },
    fixture: { format: "json", version: "1.0.0", digest: bySuffix.fixture },
    baseline: { format: "json", digest: bySuffix.baseline },
    inputs: [{ id: "request", kind: "json", digest: bySuffix.input, canonicalization: "canonical-json-v1", required: true }],
    determinism: { seed: 4200 + STARTER_TASK_FAMILIES.findIndex((entry) => entry.id === family.id), clock: FIXED_CLOCK, timezone: "UTC", locale: "en-US" },
    permissions: { filesystem: "workspace-write", subprocess: true, systemClock: false },
    tools: [],
    network: { mode: "none", allowHosts: [] },
    environment: [{ name: "LANG", value: "C.UTF-8" }],
    limits: { wallClockSeconds: 300, tokenBudget: 100000, toolCalls: 1000, diskBytes: 1073741824, processes: 8, networkRequests: 0 },
    outputs: [{ id: "result", kind: "json", required: true, maxBytes: 1048576, shapeDigest: bySuffix["output-shape"] }],
    artifacts: [{ id: "evidence", mediaType: "application/json", required: false, maxBytes: 1048576, shapeDigest: bySuffix["artifact-shape"] }],
    grader: {
      id: "starter-exact",
      version: graderBundle.version,
      digest: graderBundle.digest,
      rubricDigest: bySuffix.rubric,
      inputVisibility: "hidden",
      oracle: { kind: "exact", version: "1.0.0", digest: bySuffix.oracle },
    },
    visibility: "public",
    partialCredit: {
      mode: "weighted",
      criteria: [{ id: "answer", weightBasisPoints: 8000 }, { id: "family", weightBasisPoints: 2000 }],
    },
  };
  candidate.taskId = deriveTaskIdentity(candidate);
  candidate.digest = deriveTaskDigest(candidate);
  return transitionTask(transitionTask(sealTask(candidate), "reviewed"), "sealed");
}

export function createStarterTaskPackage(familyId) {
  const family = STARTER_TASK_FAMILIES.find((entry) => entry.id === familyId);
  if (!family) throw new RangeError(`unknown starter task family: ${familyId}`);
  const graderBundle = starterGraderBundle();
  const expected = { answer: `${family.id}:verified`, family: family.id };
  const assets = [
    taskAsset(family, "fixture", "candidate", { family: family.id, contract: "starter-v1" }),
    taskAsset(family, "baseline", "candidate", { repositoryState: "clean", revision: 1 }),
    taskAsset(family, "input", "candidate", { objective: family.label, seed: 4200 + STARTER_TASK_FAMILIES.indexOf(family) }),
    taskAsset(family, "output-shape", "candidate", { type: "object", required: ["answer", "family"] }),
    taskAsset(family, "artifact-shape", "candidate", { type: "object" }),
    taskAsset(family, "rubric", "grader", { answer: 8000, family: 2000 }),
    taskAsset(family, "oracle", "grader", {
      expected,
      criteria: {
        answer: { field: "answer", expected: expected.answer },
        family: { field: "family", expected: expected.family },
      },
    }),
  ];
  return createTaskPackage({ task: baseTask(family, assets, graderBundle), assets, graderBundle });
}

function stratumCatalog(values) {
  const weight = 1 / values.length;
  return values.map((entry) => ({ id: entry.id, label: entry.label, weight }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function createStarterDevelopmentRelease() {
  const packages = STARTER_TASK_FAMILIES.map((family) => createStarterTaskPackage(family.id));
  const assetsById = new Map();
  for (const taskPackage of packages) {
    for (const asset of taskPackage.assets) assetsById.set(asset.assetId, {
      assetId: asset.assetId,
      digest: asset.digest,
      mediaType: asset.mediaType,
      bytes: Buffer.from(asset.bytes, "base64").byteLength,
    });
  }
  const bundle = starterGraderBundle();
  let release = createCorpusRelease({
    version: "1.0.0",
    changelog: [{ changeId: "change:initial", kind: "initial", summary: "Initial governed starter corpus covering all machine-graded task families.", taskIds: packages.map((entry) => entry.task.taskId).sort() }],
    tasks: packages.map((entry) => {
      const family = STARTER_TASK_FAMILIES.find((candidate) => entry.task.prompt.text.includes(candidate.label));
      return {
        taskId: entry.task.taskId,
        revision: entry.task.specRevision,
        digest: entry.task.digest,
        assetDigests: entry.assets.map((asset) => asset.digest).sort(),
        strata: { category: family.id, risk: family.risk, size: family.size, decomposability: family.decomposability },
      };
    }).sort((left, right) => left.taskId.localeCompare(right.taskId)),
    assets: [...assetsById.values()].sort((left, right) => left.assetId.localeCompare(right.assetId)),
    strata: {
      categories: stratumCatalog(STARTER_TASK_FAMILIES),
      risks: stratumCatalog([{ id: "critical", label: "Critical" }, { id: "high", label: "High" }, { id: "low", label: "Low" }, { id: "medium", label: "Medium" }]),
      sizes: stratumCatalog([{ id: "large", label: "Large" }, { id: "medium", label: "Medium" }, { id: "small", label: "Small" }]),
      decomposabilities: stratumCatalog([{ id: "localized", label: "Localized" }, { id: "parallel", label: "Parallel" }, { id: "sequential", label: "Sequential" }]),
    },
    cutoff: { createdAt: FIXED_CLOCK, sourceCutoffAt: "2026-07-31T00:00:00Z", policy: "strict" },
    provenance: { method: "authored", sourceUri: "urn:nelos:starter-corpus:1.0.0", sourceDigest: canonicalDigest(STARTER_TASK_FAMILIES), curators: ["team:evaluation"] },
    license: { spdxId: "MIT", textDigest: sha256Bytes(Buffer.from("MIT", "utf8")), attribution: "Nelos evaluation corpus contributors." },
    duplicateAnalysis: analyzeCorpusDuplicates(packages, 0.8),
    graderBundles: [{ graderBundleId: bundle.graderBundleId, version: bundle.version, digest: bundle.digest }],
    visibility: "development",
    retainedExclusions: [],
  });
  release = transitionCorpusRelease(transitionCorpusRelease(transitionCorpusRelease(release, "reviewed"), "sealed"), "published");
  return { release, packages };
}

export function reviseStarterTask(taskPackage, changes) {
  return reviseTask(taskPackage.task, changes);
}
