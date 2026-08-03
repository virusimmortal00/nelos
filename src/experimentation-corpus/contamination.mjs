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
