import { canonicalDigest, reviseCorpusRelease } from "../experimentation-contract/index.mjs";
import { analyzeCorpusDuplicates } from "./contamination.mjs";
import { corpusFailure } from "./errors.mjs";
import { validateTaskPackage } from "./package.mjs";

function taskPath(memberIndex, field) {
  return `/members/${memberIndex}/taskPackage/task/${field}`;
}

export function reviseCorpusFromPackages(previousRelease, {
  version,
  members,
  summary,
  createdAt,
}) {
  if (!Array.isArray(members) || members.length === 0) {
    corpusFailure("INVALID_RELEASE_MEMBERS", "a successor release requires task package members", "/members");
  }
  const admitted = members.map((member, index) => {
    validateTaskPackage(member?.taskPackage);
    if (member.strata === null || typeof member.strata !== "object") {
      corpusFailure("INVALID_RELEASE_MEMBERS", "each member requires declared strata", `/members/${index}/strata`);
    }
    return {
      memberIndex: index,
      taskPackage: member.taskPackage,
      releaseTask: {
        taskId: member.taskPackage.task.taskId,
        revision: member.taskPackage.task.specRevision,
        digest: member.taskPackage.task.digest,
        assetDigests: member.taskPackage.assets.map((asset) => asset.digest).sort(),
        strata: structuredClone(member.strata),
      },
    };
  });
  const active = admitted.map(({ releaseTask }) => releaseTask)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  const activeIds = new Set(active.map((entry) => entry.taskId));
  const previousById = new Map(previousRelease.tasks.map((entry) => [entry.taskId, entry]));
  const previousByDigest = new Map(previousRelease.tasks.map((entry) => [entry.digest, entry]));
  const revisedIds = [];
  const addedIds = [];
  const revisedPredecessors = new Set();
  for (const { memberIndex, taskPackage } of admitted) {
    const task = taskPackage.task;
    const previous = previousById.get(task.taskId);
    if (
      previous?.digest === task.digest &&
      previous.revision === task.specRevision
    ) {
      continue;
    }
    if (task.previousDigest === null) {
      if (previous !== undefined) {
        corpusFailure(
          "INVALID_TASK_LINEAGE",
          "changed task identity requires an exact predecessor revision",
          taskPath(memberIndex, "previousDigest"),
        );
      }
      addedIds.push(task.taskId);
      continue;
    }
    const predecessor = previousByDigest.get(task.previousDigest);
    if (predecessor === undefined) {
      corpusFailure(
        "INVALID_TASK_LINEAGE",
        "task predecessor is not an active member of the prior corpus release",
        taskPath(memberIndex, "previousDigest"),
      );
    }
    if (task.specRevision !== predecessor.revision + 1) {
      corpusFailure(
        "INVALID_TASK_REVISION",
        "task revision must advance exactly once from its matched predecessor",
        taskPath(memberIndex, "specRevision"),
      );
    }
    if (task.taskId === predecessor.taskId) {
      corpusFailure(
        "INVALID_TASK_REVISION",
        "task revision must change semantic identity",
        taskPath(memberIndex, "taskId"),
      );
    }
    if (activeIds.has(predecessor.taskId)) {
      corpusFailure(
        "INVALID_TASK_LINEAGE",
        "a replaced predecessor cannot remain active beside its successor",
        taskPath(memberIndex, "previousDigest"),
      );
    }
    if (revisedPredecessors.has(predecessor.taskId)) {
      corpusFailure(
        "INVALID_TASK_LINEAGE",
        "one predecessor cannot produce multiple active successors",
        taskPath(memberIndex, "previousDigest"),
      );
    }
    revisedPredecessors.add(predecessor.taskId);
    revisedIds.push(task.taskId);
  }
  revisedIds.sort();
  addedIds.sort();
  const removedIds = previousRelease.tasks.map((entry) => entry.taskId).filter((taskId) => !activeIds.has(taskId)).sort();
  const previousExclusions = new Map(previousRelease.retainedExclusions.map((entry) => [entry.taskId, entry]));
  for (const taskId of removedIds) previousExclusions.set(taskId, {
    taskId,
    reasonCode: "superseded",
    reason: "Replaced by a semantic task revision in this corpus release.",
  });
  const assets = new Map(previousRelease.assets.map((asset) => [asset.assetId, asset]));
  for (const { taskPackage } of members) {
    for (const asset of taskPackage.assets) assets.set(asset.assetId, {
      assetId: asset.assetId,
      digest: asset.digest,
      mediaType: asset.mediaType,
      bytes: Buffer.from(asset.bytes, "base64").byteLength,
    });
  }
  const bundles = new Map();
  for (let index = 0; index < members.length; index += 1) {
    const { graderBundle } = members[index].taskPackage;
    const existing = bundles.get(graderBundle.graderBundleId);
    if (existing !== undefined && existing.digest !== graderBundle.digest) {
      corpusFailure(
        "GRADER_IDENTITY_COLLISION",
        "one grader identity cannot reference multiple bundle digests",
        `/members/${index}/taskPackage/graderBundle/digest`,
      );
    }
    bundles.set(graderBundle.graderBundleId, {
      graderBundleId: graderBundle.graderBundleId,
      version: graderBundle.version,
      digest: graderBundle.digest,
    });
  }
  const changelog = [
    ...(removedIds.length === 0 ? [] : [{ changeId: "change:task-excluded", kind: "task-excluded", summary: "Retain replaced task identities as audited exclusions.", taskIds: removedIds }]),
    ...(addedIds.length === 0 ? [] : [{ changeId: "change:task-added", kind: "task-added", summary: "Add governed task identities to the corpus.", taskIds: addedIds }]),
    ...(revisedIds.length === 0 ? [] : [{ changeId: "change:task-revised", kind: "task-revised", summary, taskIds: revisedIds }]),
  ];
  return reviseCorpusRelease(previousRelease, {
    version,
    tasks: active,
    assets: [...assets.values()].sort((left, right) => left.assetId.localeCompare(right.assetId)),
    graderBundles: [...bundles.values()].sort((left, right) => left.graderBundleId.localeCompare(right.graderBundleId)),
    changelog,
    retainedExclusions: [...previousExclusions.values()].sort((left, right) => left.taskId.localeCompare(right.taskId)),
    cutoff: { ...previousRelease.cutoff, createdAt },
    provenance: {
      ...previousRelease.provenance,
      sourceDigest: canonicalDigest(members.map(({ taskPackage }) => taskPackage.digest).sort()),
    },
    duplicateAnalysis: analyzeCorpusDuplicates(
      members.map(({ taskPackage }) => taskPackage),
      previousRelease.duplicateAnalysis.nearThreshold,
    ),
  });
}
