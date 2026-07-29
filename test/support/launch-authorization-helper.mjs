export function authorizeLaunchProposal(proposal, overrides = {}) {
  if (proposal?.kind !== "authorization-required") {
    throw new Error("test helper requires an authorization-required proposal");
  }
  const memberOverrides = overrides.members ?? {};
  return {
    schemaVersion: 1,
    type: "native-launch-authorization",
    source: "native-host",
    actionId: overrides.actionId ?? proposal.actionId,
    planRunId:
      overrides.planRunId ?? proposal.verification.planRunId,
    waveIndex:
      overrides.waveIndex ?? proposal.verification.waveIndex,
    waveDigest:
      overrides.waveDigest ?? proposal.verification.waveDigest,
    members: proposal.members.map((member) => ({
      ...member,
      launcherAvailable: true,
      taskKindSupported: true,
      workspaceModeSupported: true,
      modelSupported: true,
      reasoningSupported: true,
      creationAuthorized: true,
      ...(memberOverrides[member.sliceId] ?? {}),
    })),
  };
}
