import { canonicalDigest, sealRecord } from "../experimentation-contract/index.mjs";
import { corpusFailure } from "./errors.mjs";
import { validateTaskPackage } from "./package.mjs";

const TASK_ID = /^task:[0-9a-f]{64}$/u;
const MAX_CORPUS_DUPLICATE_COMPARISONS = 5_000_000;
export const CORPUS_DUPLICATE_METHOD = "unicode-token-jaccard-v1";
export const CORPUS_DUPLICATE_TOOL_DIGEST = canonicalDigest({
  implementation: "nelos-corpus-duplicate-analysis",
  method: CORPUS_DUPLICATE_METHOD,
  grouping: "connected-components-v1",
  exactComparisonBudget: MAX_CORPUS_DUPLICATE_COMPARISONS,
});

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tokens(value) {
  return new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

export function tokenJaccard(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / union.size;
}

export function analyzePartitionSimilarity(developmentPackages, privatePackages, nearThreshold = 0.8) {
  if (!Number.isFinite(nearThreshold) || nearThreshold < 0 || nearThreshold > 1) {
    corpusFailure("INVALID_SIMILARITY_THRESHOLD", "similarity threshold must be between zero and one", "/nearThreshold");
  }
  const comparisons = [];
  for (const development of developmentPackages) {
    for (const evaluation of privatePackages) {
      const similarity = tokenJaccard(development.task.prompt.text, evaluation.task.prompt.text);
      if (similarity >= nearThreshold) comparisons.push({
        developmentTaskId: development.task.taskId,
        privateTaskId: evaluation.task.taskId,
        similarity,
      });
    }
  }
  return comparisons.sort((a, b) => `${a.developmentTaskId}:${a.privateTaskId}`.localeCompare(`${b.developmentTaskId}:${b.privateTaskId}`));
}

function duplicateGroupId(kind, taskIds) {
  return `${kind}:${canonicalDigest(taskIds).slice("sha256:".length)}`;
}

export function analyzeCorpusDuplicates(taskPackages, nearThreshold = 0.8) {
  if (!Array.isArray(taskPackages) || taskPackages.length === 0) {
    corpusFailure(
      "INVALID_RELEASE_MEMBERS",
      "duplicate analysis requires task package members",
      "/members",
    );
  }
  if (!Number.isFinite(nearThreshold) || nearThreshold < 0 || nearThreshold > 1) {
    corpusFailure(
      "INVALID_SIMILARITY_THRESHOLD",
      "similarity threshold must be between zero and one",
      "/nearThreshold",
    );
  }
  if (
    taskPackages.length * (taskPackages.length - 1) / 2 >
    MAX_CORPUS_DUPLICATE_COMPARISONS
  ) {
    corpusFailure(
      "DUPLICATE_ANALYSIS_LIMIT",
      "task membership exceeds the bounded exact comparison budget",
      "/members",
    );
  }
  const seenTaskIds = new Set();
  for (const taskPackage of taskPackages) {
    validateTaskPackage(taskPackage);
    if (seenTaskIds.has(taskPackage.task.taskId)) {
      corpusFailure(
        "DUPLICATE_TASK",
        "duplicate analysis requires unique task identities",
        "/members",
      );
    }
    seenTaskIds.add(taskPackage.task.taskId);
  }
  const packages = [...taskPackages].sort((left, right) =>
    compareStrings(left.task.taskId, right.task.taskId)
  );

  const exactByPrompt = new Map();
  for (const taskPackage of packages) {
    const promptDigest = taskPackage.task.prompt.digest;
    const taskIds = exactByPrompt.get(promptDigest) ?? [];
    taskIds.push(taskPackage.task.taskId);
    exactByPrompt.set(promptDigest, taskIds);
  }
  const exactGroups = [...exactByPrompt.values()]
    .filter((taskIds) => taskIds.length > 1)
    .map((taskIds) => ({
      groupId: duplicateGroupId("exact", taskIds),
      taskIds,
    }))
    .sort((left, right) => compareStrings(left.groupId, right.groupId));

  const adjacency = new Map(
    packages.map(({ task }) => [task.taskId, new Set()]),
  );
  const pairSimilarity = new Map();
  for (let leftIndex = 0; leftIndex < packages.length; leftIndex += 1) {
    const left = packages[leftIndex].task;
    for (let rightIndex = leftIndex + 1; rightIndex < packages.length; rightIndex += 1) {
      const right = packages[rightIndex].task;
      if (left.prompt.digest === right.prompt.digest) continue;
      const similarity = tokenJaccard(left.prompt.text, right.prompt.text);
      if (similarity < nearThreshold) continue;
      adjacency.get(left.taskId).add(right.taskId);
      adjacency.get(right.taskId).add(left.taskId);
      pairSimilarity.set(`${left.taskId}:${right.taskId}`, similarity);
    }
  }
  const visited = new Set();
  const nearGroups = [];
  for (const { task } of packages) {
    if (visited.has(task.taskId) || adjacency.get(task.taskId).size === 0) continue;
    const pending = [task.taskId];
    const taskIds = [];
    while (pending.length > 0) {
      const taskId = pending.pop();
      if (visited.has(taskId)) continue;
      visited.add(taskId);
      taskIds.push(taskId);
      for (const neighbor of adjacency.get(taskId)) {
        if (!visited.has(neighbor)) pending.push(neighbor);
      }
    }
    taskIds.sort(compareStrings);
    let maximumSimilarity = 0;
    for (let leftIndex = 0; leftIndex < taskIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < taskIds.length; rightIndex += 1) {
        maximumSimilarity = Math.max(
          maximumSimilarity,
          pairSimilarity.get(`${taskIds[leftIndex]}:${taskIds[rightIndex]}`) ?? 0,
        );
      }
    }
    nearGroups.push({
      groupId: duplicateGroupId("near", taskIds),
      taskIds,
      maximumSimilarity,
    });
  }
  nearGroups.sort((left, right) => compareStrings(left.groupId, right.groupId));
  return {
    method: CORPUS_DUPLICATE_METHOD,
    toolDigest: CORPUS_DUPLICATE_TOOL_DIGEST,
    nearThreshold,
    exactGroups,
    nearGroups,
  };
}

export function validateEvaluationPartitions({
  developmentPackages,
  privatePackages,
  accessLog,
  exclusions,
  frozenAt,
  nearThreshold = 0.8,
}) {
  if (!Array.isArray(developmentPackages) || !Array.isArray(privatePackages)) {
    corpusFailure("INVALID_PARTITIONS", "development and private package arrays are required", "/developmentPackages");
  }
  for (const taskPackage of [...developmentPackages, ...privatePackages]) {
    validateTaskPackage(taskPackage);
  }
  const developmentIds = new Set(developmentPackages.map((entry) => entry.task.taskId));
  const privateIds = new Set(privatePackages.map((entry) => entry.task.taskId));
  for (const id of privateIds) {
    if (developmentIds.has(id)) corpusFailure("PARTITION_OVERLAP", "a task cannot be development and private evidence", "/privatePackages");
  }
  if (!Array.isArray(accessLog) || !Array.isArray(exclusions)) {
    corpusFailure("MISSING_CONTAMINATION_EVIDENCE", "access and exclusion logs are required");
  }
  const freeze = Date.parse(frozenAt);
  if (!Number.isFinite(freeze)) corpusFailure("INVALID_FREEZE_TIME", "experiment freeze time is invalid", "/frozenAt");
  for (let index = 0; index < accessLog.length; index += 1) {
    const access = accessLog[index];
    if (
      !access ||
      typeof access.actor !== "string" ||
      typeof access.at !== "string" ||
      !TASK_ID.test(access.taskId) ||
      !["author", "evaluator", "administrator"].includes(access.role)
    ) {
      corpusFailure("INVALID_ACCESS_LOG", "access records must identify actor, role, task, and time", `/accessLog/${index}`);
    }
    const accessedAt = Date.parse(access.at);
    if (!Number.isFinite(accessedAt)) {
      corpusFailure("INVALID_ACCESS_LOG", "access record time is invalid", `/accessLog/${index}/at`);
    }
    if (privateIds.has(access.taskId) && access.role === "author" && accessedAt <= freeze) {
      corpusFailure("PRIVATE_ACCESS_VIOLATION", "policy authors cannot access private tasks before freeze", `/accessLog/${index}`);
    }
  }
  const excluded = new Map();
  for (let index = 0; index < exclusions.length; index += 1) {
    const exclusion = exclusions[index];
    if (
      !exclusion ||
      typeof exclusion.taskId !== "string" ||
      exclusion.taskId.length === 0 ||
      typeof exclusion.reasonCode !== "string" ||
      exclusion.reasonCode.length === 0 ||
      typeof exclusion.declaredAt !== "string"
    ) {
      corpusFailure(
        "INVALID_EXCLUSION",
        "exclusions must identify a task, reason, and declaration time",
        `/exclusions/${index}`,
      );
    }
    const declaredAt = Date.parse(exclusion.declaredAt);
    if (!Number.isFinite(declaredAt)) {
      corpusFailure("INVALID_EXCLUSION", "exclusion declaration time is invalid", `/exclusions/${index}/declaredAt`);
    }
    excluded.set(exclusion.taskId, { exclusion, declaredAt });
  }
  for (const comparison of analyzePartitionSimilarity(developmentPackages, privatePackages, nearThreshold)) {
    const record = excluded.get(comparison.privateTaskId);
    if (!record || record.exclusion.reasonCode !== "contamination" || record.declaredAt > freeze) {
      corpusFailure("SIMILARITY_EXCLUSION_REQUIRED", "near-duplicate private tasks require a predeclared contamination exclusion", "/exclusions");
    }
  }
  const report = {
    schemaVersion: 1,
    frozenAt,
    nearThreshold,
    developmentTaskIds: [...developmentIds].sort(),
    privateTaskIds: [...privateIds].sort(),
    accessLogDigest: canonicalDigest(accessLog),
    exclusionsDigest: canonicalDigest(exclusions),
    similarity: analyzePartitionSimilarity(developmentPackages, privatePackages, nearThreshold),
  };
  return sealRecord({ ...report, digest: canonicalDigest(report) }, { contractKind: "ContaminationReport", schemaVersion: 1 });
}
