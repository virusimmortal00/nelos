import { canonicalDigest, sealRecord } from "../experimentation-contract/index.mjs";
import { corpusFailure } from "./errors.mjs";

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
  if (typeof nearThreshold !== "number" || nearThreshold < 0 || nearThreshold > 1) {
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

export function validateEvaluationPartitions({
  developmentPackages,
  privatePackages,
  accessLog,
  exclusions,
  frozenAt,
  nearThreshold = 0.8,
}) {
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
    if (!access || typeof access.actor !== "string" || typeof access.at !== "string" || !["author", "evaluator", "administrator"].includes(access.role)) {
      corpusFailure("INVALID_ACCESS_LOG", "access records must identify actor, role, and time", `/accessLog/${index}`);
    }
    if (privateIds.has(access.taskId) && access.role === "author" && Date.parse(access.at) <= freeze) {
      corpusFailure("PRIVATE_ACCESS_VIOLATION", "policy authors cannot access private tasks before freeze", `/accessLog/${index}`);
    }
  }
  const excluded = new Map(exclusions.map((entry) => [entry.taskId, entry]));
  for (const comparison of analyzePartitionSimilarity(developmentPackages, privatePackages, nearThreshold)) {
    const exclusion = excluded.get(comparison.privateTaskId);
    if (!exclusion || exclusion.reasonCode !== "contamination" || Date.parse(exclusion.declaredAt) > freeze) {
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
