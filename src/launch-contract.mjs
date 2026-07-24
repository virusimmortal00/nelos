export const NATIVE_LAUNCH_CONTRACT_SCHEMA_VERSION = 1;

export const NATIVE_LAUNCHERS = Object.freeze({
  spinoff: "create-thread",
  "joined-subagent": "spawn-subagent",
});

const LIFECYCLE_MEMBER_KINDS = Object.freeze({
  spinoff: "spinoff",
  subagent: "joined-subagent",
});

const WORKSPACE_MODES = new Set(["shared-read-only", "isolated-write"]);
const NATIVE_TASK_FIELDS = new Set(["model", "thinking"]);
const LAUNCH_FIELDS = new Set([
  "schemaVersion",
  "launcher",
  "workspaceMode",
  "nativeTask",
  "requiresThreadId",
  "onMissingThreadId",
]);

function assertPlainObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknown = Object.keys(value)
    .filter((field) => !fields.has(field))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field: ${unknown[0]}`);
  }
  return value;
}

function normalizeOptionalText(value, field, maximum) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

/**
 * Translate the planner lifecycle vocabulary into the durable work-unit kind.
 */
export function memberKindForLifecycle(lifecycle) {
  const memberKind = LIFECYCLE_MEMBER_KINDS[lifecycle];
  if (!memberKind) {
    throw new Error("lifecycle must be spinoff or subagent");
  }
  return memberKind;
}

/**
 * Select the host-owned native launcher for one durable member kind.
 */
export function launcherForMemberKind(memberKind) {
  const launcher = NATIVE_LAUNCHERS[memberKind];
  if (!launcher) {
    throw new Error("memberKind must be spinoff or joined-subagent");
  }
  return launcher;
}

/**
 * Validate and canonicalize the launch metadata persisted with a work unit.
 */
export function normalizeNativeLaunchV1(value, memberKind) {
  launcherForMemberKind(memberKind);
  if (value === undefined || value === null) return null;
  assertPlainObject(value, "native launch", LAUNCH_FIELDS);
  const launcher = launcherForMemberKind(memberKind);
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== NATIVE_LAUNCH_CONTRACT_SCHEMA_VERSION
  ) {
    throw new Error(
      `native launch schemaVersion must be ${NATIVE_LAUNCH_CONTRACT_SCHEMA_VERSION}`,
    );
  }
  if (value.launcher !== undefined && value.launcher !== launcher) {
    throw new Error("native launch launcher conflicts with memberKind");
  }
  if (
    value.requiresThreadId !== undefined &&
    value.requiresThreadId !== true
  ) {
    throw new Error("native launch requiresThreadId must be true");
  }
  if (
    value.onMissingThreadId !== undefined &&
    value.onMissingThreadId !== "attention"
  ) {
    throw new Error("native launch onMissingThreadId must be attention");
  }
  if (!WORKSPACE_MODES.has(value.workspaceMode)) {
    throw new Error(
      "native launch workspaceMode must be shared-read-only or isolated-write",
    );
  }
  if (
    memberKind === "joined-subagent" &&
    value.workspaceMode !== "shared-read-only"
  ) {
    throw new Error("joined-subagent launches must use shared-read-only");
  }

  const nativeTask = assertPlainObject(
    value.nativeTask,
    "native launch nativeTask",
    NATIVE_TASK_FIELDS,
  );
  const normalizedNativeTask = {};
  const model = normalizeOptionalText(
    nativeTask.model,
    "native launch nativeTask.model",
    128,
  );
  const thinking = normalizeOptionalText(
    nativeTask.thinking,
    "native launch nativeTask.thinking",
    32,
  );
  if (model !== undefined) normalizedNativeTask.model = model;
  if (thinking !== undefined) normalizedNativeTask.thinking = thinking;

  return {
    schemaVersion: NATIVE_LAUNCH_CONTRACT_SCHEMA_VERSION,
    launcher,
    workspaceMode: value.workspaceMode,
    nativeTask: normalizedNativeTask,
    requiresThreadId: true,
    onMissingThreadId: "attention",
  };
}

/**
 * Resolve one planner launch member into a shared lifecycle-specific contract.
 *
 * Callers retain responsibility for their output-specific fields, while
 * lifecycle translation, conflict detection, and launch normalization stay
 * centralized here.
 */
export function normalizeLaunchMemberV1(member) {
  if (!member || typeof member !== "object" || Array.isArray(member)) {
    throw new Error("launch member must be a JSON object");
  }
  const expectedMemberKind = memberKindForLifecycle(member.lifecycle);
  const memberKind = member.memberKind ?? expectedMemberKind;
  if (memberKind !== expectedMemberKind) {
    throw new Error("launch member lifecycle and memberKind conflict");
  }
  const launch = normalizeNativeLaunchV1(
    {
      workspaceMode: member.workspaceMode,
      nativeTask: member.nativeTask,
    },
    memberKind,
  );
  return {
    lifecycle: member.lifecycle,
    memberKind,
    launcher: launcherForMemberKind(memberKind),
    launch,
  };
}
