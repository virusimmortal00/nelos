import { createWorkUnitSpecV1 } from "./execution-store.mjs";
import { normalizeLaunchMemberV1 } from "./launch-contract.mjs";

export const PLAN_ORCHESTRATION_BRIDGE_SCHEMA_VERSION = 1;

/**
 * Return the complete prerequisite closure of one planned wave that has no
 * durable work unit in the current web.
 * This closes the gap for legacy plans where joined reviews were verified by
 * the native host but omitted from the persisted execution web.
 */
export function missingPersistedDependencyIdsV1(
  plan,
  waveIndex,
  workUnits,
  { webId, queenThreadId },
) {
  const wave = plan?.waves?.find(({ index }) => index === waveIndex);
  if (!wave) throw new Error(`plan has no dependency wave ${waveIndex}`);
  if (!Array.isArray(workUnits)) throw new Error("workUnits must be an array");
  if (!webId || !queenThreadId) {
    throw new Error("webId and queenThreadId are required");
  }
  const slices = plan.waves.flatMap(({ slices: plannedSlices }) => plannedSlices);
  const slicesById = new Map(slices.map((slice) => [slice.id, slice]));
  const dependencies = new Set();
  const visit = (dependencyId) => {
    if (dependencies.has(dependencyId)) return;
    dependencies.add(dependencyId);
    for (const nested of slicesById.get(dependencyId)?.dependsOn ?? []) {
      visit(nested);
    }
  };
  for (const dependencyId of wave.slices.flatMap(
    ({ dependsOn = [] }) => dependsOn,
  )) {
    visit(dependencyId);
  }
  const persisted = new Set(
    workUnits
      .filter((workUnit) =>
        workUnit.webId === webId && workUnit.queenThreadId === queenThreadId)
      .map(({ workUnitId }) => workUnitId),
  );
  return [...dependencies]
    .filter((dependency) => !persisted.has(dependency))
    .sort();
}

function capabilitiesFor(memberKind, cleanupIntended) {
  const capabilities = ["observe", "read-result", "follow-up"];
  if (memberKind === "spinoff" && cleanupIntended) capabilities.push("archive");
  return capabilities;
}

/**
 * Reconstruct the durable work-unit definition for a persisted plan slice.
 * Launch verification uses this to adopt joined members from legacy runs
 * without trusting caller-authored work-unit fields.
 */
export function workUnitFromPlanSliceV1(slice, options) {
  return workUnitFromLaunchMemberV1({
    sliceId: slice.id,
    lifecycle: slice.lifecycle,
    title: slice.title,
    objective: slice.objective,
    deliverable: slice.deliverable,
    acceptanceCriteria: slice.acceptanceCriteria,
    dependsOn: slice.dependsOn,
    workspaceMode: slice.workspaceMode,
    nativeTask: slice.route?.launch?.nativeTask,
  }, options);
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
    cleanupIntended = true,
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
