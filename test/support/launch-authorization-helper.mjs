import {
  createLaunchAuthorizationReceiptV1,
} from "../../src/launch-execution-gate.mjs";

export function authorizeLaunchProposal(proposal, overrides = {}) {
  if (proposal?.kind !== "authorization-required") {
    throw new Error("test helper requires an authorization-required proposal");
  }
  const launchers = [];
  for (const member of proposal.members) {
    let launcher = launchers.find(
      (candidate) => candidate.launcher === member.launcher,
    );
    if (!launcher) {
      launcher = {
        launcher: member.launcher,
        memberKinds: [],
        workspaceModes: [],
        routes: [],
      };
      launchers.push(launcher);
    }
    if (!launcher.memberKinds.includes(member.memberKind)) {
      launcher.memberKinds.push(member.memberKind);
    }
    if (!launcher.workspaceModes.includes(member.workspaceMode)) {
      launcher.workspaceModes.push(member.workspaceMode);
    }
    let route = launcher.routes.find(
      (candidate) => candidate.model === member.nativeTask.model,
    );
    if (!route) {
      route = {
        model: member.nativeTask.model,
        reasoningEfforts: [],
      };
      launcher.routes.push(route);
    }
    if (!route.reasoningEfforts.includes(member.nativeTask.thinking)) {
      route.reasoningEfforts.push(member.nativeTask.thinking);
    }
  }
  const produced = createLaunchAuthorizationReceiptV1({
    request: proposal.authorizationEffect.arguments.request,
    capabilities: {
      source: "native-host-tool-registry",
      launchers,
    },
    userIntentConfirmed: true,
  });
  const memberOverrides = overrides.members ?? {};
  return {
    ...produced,
    actionId: overrides.actionId ?? proposal.actionId,
    planRunId:
      overrides.planRunId ?? proposal.verification.planRunId,
    waveIndex:
      overrides.waveIndex ?? proposal.verification.waveIndex,
    waveDigest:
      overrides.waveDigest ?? proposal.verification.waveDigest,
    members: produced.members.map((member) => ({
      ...member,
      ...(memberOverrides[member.sliceId] ?? {}),
    })),
  };
}
