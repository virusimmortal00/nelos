import { createWorkUnitSpecV1 } from "./execution-store.mjs";
import { normalizeLaunchMemberV1 } from "./launch-contract.mjs";

export const PLAN_ORCHESTRATION_BRIDGE_SCHEMA_VERSION = 1;

function capabilitiesFor(memberKind, cleanupIntended) {
  const capabilities = ["observe", "read-result", "follow-up"];
  if (memberKind === "spinoff" && cleanupIntended) capabilities.push("archive");
  return capabilities;
}

/**
 * Convert one planned launch member into the durable work-unit contract.
 */
export function workUnitFromLaunchMemberV1(
  member,
  {
    webId,
    queenThreadId,
    specRevision = 1,
    attempt = 1,
    required = true,
    maxAttempts = 3,
    cleanupIntended = false,
  },
) {
  if (typeof cleanupIntended !== "boolean") {
    throw new Error("cleanupIntended must be a boolean");
  }
  const { memberKind, launch } = normalizeLaunchMemberV1(member);

  return createWorkUnitSpecV1({
    schemaVersion: 1,
    webId,
    queenThreadId,
    workUnitId: member.sliceId,
    specRevision,
    attempt,
    memberKind,
    // Planned required work must be observable and readable so it can supply
    // actual acceptance evidence. Archive is host cleanup authority, not a
    // default launch privilege.
    capabilities: capabilitiesFor(memberKind, cleanupIntended),
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
