import { canonicalDigest, reviseCorpusRelease } from "../experimentation-contract/index.mjs";
import { corpusFailure } from "./errors.mjs";
import { validateTaskPackage } from "./package.mjs";

export function reviseCorpusFromPackages(previousRelease, {
  version,
  members,
  summary,
  createdAt,
}) {
  if (!Array.isArray(members) || members.length === 0) {
    corpusFailure("INVALID_RELEASE_MEMBERS", "a successor release requires task package members", "/members");
  }
  const active = members.map((member, index) => {
    validateTaskPackage(member?.taskPackage);
    if (member.strata === null || typeof member.strata !== "object") {
      corpusFailure("INVALID_RELEASE_MEMBERS", "each member requires declared strata", `/members/${index}/strata`);
    }
    return {
      taskId: member.taskPackage.task.taskId,
      revision: member.taskPackage.task.specRevision,
      digest: member.taskPackage.task.digest,
      assetDigests: member.taskPackage.assets.map((asset) => asset.digest).sort(),
      strata: structuredClone(member.strata),
    };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  const activeIds = new Set(active.map((entry) => entry.taskId));
  const previousById = new Map(previousRelease.tasks.map((entry) => [entry.taskId, entry]));
  const changedIds = active.filter((entry) => previousById.get(entry.taskId)?.digest !== entry.digest)
    .map((entry) => entry.taskId);
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
  const bundles = new Map(previousRelease.graderBundles.map((bundle) => [bundle.graderBundleId, bundle]));
  for (const { taskPackage } of members) bundles.set(taskPackage.graderBundle.graderBundleId, {
    graderBundleId: taskPackage.graderBundle.graderBundleId,
    version: taskPackage.graderBundle.version,
    digest: taskPackage.graderBundle.digest,
  });
  const changelog = [
    ...(removedIds.length === 0 ? [] : [{ changeId: "change:task-excluded", kind: "task-excluded", summary: "Retain replaced task identities as audited exclusions.", taskIds: removedIds }]),
    { changeId: "change:task-revised", kind: "task-revised", summary, taskIds: changedIds },
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
  });
}
