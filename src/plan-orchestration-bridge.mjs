import { createWorkUnitSpecV1 } from "./execution-store.mjs";
import {
  memberKindForLifecycle,
  normalizeNativeLaunchV1,
} from "./launch-contract.mjs";

export const PLAN_ORCHESTRATION_BRIDGE_SCHEMA_VERSION = 1;

function capabilitiesFor(memberKind) {
  return memberKind === "spinoff"
    ? ["observe", "read-result", "follow-up", "archive"]
    : ["observe", "read-result", "follow-up"];
}

export function workUnitFromLaunchMemberV1(
  member,
  {
    webId,
    queenThreadId,
    specRevision = 1,
    attempt = 1,
    required = true,
    maxAttempts = 3,
  },
) {
  if (!member || typeof member !== "object" || Array.isArray(member)) {
    throw new Error("launch member must be a JSON object");
  }
  const memberKind =
    member.memberKind ?? memberKindForLifecycle(member.lifecycle);
  if (memberKind !== memberKindForLifecycle(member.lifecycle)) {
    throw new Error("launch member lifecycle and memberKind conflict");
  }
  const launch = normalizeNativeLaunchV1(
    {
      workspaceMode: member.workspaceMode,
      nativeTask: member.nativeTask,
    },
    memberKind,
  );

  return createWorkUnitSpecV1({
    schemaVersion: 1,
    webId,
    queenThreadId,
    workUnitId: member.sliceId,
    specRevision,
    attempt,
    memberKind,
    capabilities: capabilitiesFor(memberKind),
    launch,
    title: member.title,
    objectiveSummary: member.objective ?? `Execute the ${member.sliceId} slice.`,
    deliverable: member.deliverable ?? "Return the required bounded result.",
    acceptanceCriteria:
      member.acceptanceCriteria ?? ["The bounded result satisfies the slice contract."],
    dependencies: member.dependsOn ?? [],
    required,
    policy: {
      maxAttempts,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    },
  });
}
