import { normalizeLaunchMemberV1 } from "./launch-contract.mjs";

export const NATIVE_LAUNCH_ADAPTER_SCHEMA_VERSION = 1;

function normalizedError(error) {
  return error instanceof Error && error.message
    ? error.message.slice(0, 500)
    : "native launch failed";
}

function launchRequest(member) {
  const { lifecycle, memberKind, launcher, launch } =
    normalizeLaunchMemberV1(member);
  return {
    sliceId: member.sliceId,
    lifecycle,
    memberKind,
    launcher,
    ...(lifecycle === "spinoff" ? { actionId: member.actionId } : {}),
    title: member.title,
    prompt: member.prompt,
    workspaceMode: launch.workspaceMode,
    nativeTask: { ...launch.nativeTask },
    model: launch.nativeTask.model,
    thinking: launch.nativeTask.thinking,
    reasoningEffort: launch.nativeTask.thinking,
  };
}

function actionIdentity(request) {
  return request.actionId ? { actionId: request.actionId } : {};
}

async function launchOne(request, adapters) {
  let launch;
  try {
    launch =
      request.launcher === "create-thread"
        ? await adapters.createSpinoff(request)
        : await adapters.spawnSubagent(request);
  } catch (error) {
    return {
      sliceId: request.sliceId,
      lifecycle: request.lifecycle,
      memberKind: request.memberKind,
      launcher: request.launcher,
      ...actionIdentity(request),
      status: "attention",
      attentionReason: "launch-failed",
      error: normalizedError(error),
    };
  }
  if (!launch || typeof launch.threadId !== "string" || !launch.threadId) {
    return {
      sliceId: request.sliceId,
      lifecycle: request.lifecycle,
      memberKind: request.memberKind,
      launcher: request.launcher,
      ...actionIdentity(request),
      status: "attention",
      attentionReason: "missing-thread-id",
    };
  }

  const launchIdentity = {
    threadId: launch.threadId,
    ...actionIdentity(request),
    ...(launch.hostId ? { hostId: launch.hostId } : {}),
    ...(launch.turnId ? { turnId: launch.turnId } : {}),
  };
  let verification;
  try {
    verification = await adapters.verifyRoute({
      threadId: launch.threadId,
      ...(launch.turnId ? { turnId: launch.turnId } : {}),
      model: request.nativeTask.model ?? null,
      effort: request.nativeTask.thinking ?? null,
    });
  } catch (error) {
    return {
      sliceId: request.sliceId,
      lifecycle: request.lifecycle,
      memberKind: request.memberKind,
      launcher: request.launcher,
      ...launchIdentity,
      status: "attention",
      attentionReason: "route-verification-unavailable",
      error: normalizedError(error),
    };
  }
  if (verification?.verified !== true) {
    return {
      sliceId: request.sliceId,
      lifecycle: request.lifecycle,
      memberKind: request.memberKind,
      launcher: request.launcher,
      ...launchIdentity,
      status: "attention",
      attentionReason: "exact-route-mismatch",
    };
  }

  return {
    sliceId: request.sliceId,
    lifecycle: request.lifecycle,
    memberKind: request.memberKind,
    launcher: request.launcher,
    ...launchIdentity,
    status: "verified",
    nativeTask: request.nativeTask,
  };
}

/**
 * Preflight and concurrently execute one lifecycle-specific native launch wave.
 */
export async function executeNativeLaunchWaveV1(
  action,
  { authorizeLaunch, createSpinoff, spawnSubagent, verifyRoute },
) {
  if (
    !action ||
    action.kind !== "launch-wave" ||
    !Array.isArray(action.members) ||
    action.members.length === 0
  ) {
    throw new Error("native launch adapter requires a non-empty launch-wave");
  }
  for (const [name, callback] of Object.entries({
    authorizeLaunch,
    createSpinoff,
    spawnSubagent,
    verifyRoute,
  })) {
    if (typeof callback !== "function") {
      throw new Error(`native launch adapter requires ${name}()`);
    }
  }

  const requests = action.members.map(launchRequest);
  const authorizations = await Promise.all(
    requests.map(async (request) => {
      try {
        const result = await authorizeLaunch(request);
        return {
          authorized: result === true || result?.authorized === true,
          reason: result?.reason ?? "launch-not-authorized",
        };
      } catch (error) {
        return {
          authorized: false,
          reason: normalizedError(error),
        };
      }
    }),
  );
  if (authorizations.some(({ authorized }) => !authorized)) {
    const members = requests.map((request, index) => ({
      sliceId: request.sliceId,
      lifecycle: request.lifecycle,
      memberKind: request.memberKind,
      launcher: request.launcher,
      ...actionIdentity(request),
      status: "attention",
      attentionReason: authorizations[index].authorized
        ? "wave-preflight-failed"
        : "launch-not-authorized",
      ...(authorizations[index].authorized
        ? {}
        : { error: authorizations[index].reason }),
    }));
    return {
      schemaVersion: NATIVE_LAUNCH_ADAPTER_SCHEMA_VERSION,
      waveIndex: action.waveIndex,
      members,
      verified: false,
      attentionRequired: true,
    };
  }

  const members = await Promise.all(
    requests.map((request) =>
      launchOne(request, { createSpinoff, spawnSubagent, verifyRoute }),
    ),
  );
  return {
    schemaVersion: NATIVE_LAUNCH_ADAPTER_SCHEMA_VERSION,
    waveIndex: action.waveIndex,
    members,
    verified: members.every((member) => member.status === "verified"),
    attentionRequired: members.some((member) => member.status === "attention"),
  };
}
