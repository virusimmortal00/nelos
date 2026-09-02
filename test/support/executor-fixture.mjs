import { executorDigest, executorContextFingerprintV1, normalizeExecutorWaveV1 } from "../../src/executor-contract.mjs";

export function executorWave(overrides = {}) {
  return normalizeExecutorWaveV1({
    schemaVersion: 1, backend: "nelos-app-server", planRunId: `run:${"a".repeat(40)}`,
    waveIndex: 1, waveDigest: "b".repeat(64),
    members: [{
      sliceId: "worker", workUnitId: "unit-1", specRevision: 1, attempt: 1, launchSequence: 1,
      target: { hostId: "remote-fixture", codexHomeId: "c".repeat(64), repositoryId: "d".repeat(64), cwd: "/workspace/isolated" },
      workspaceMode: "isolated-write", model: "gpt-5.6-sol", reasoningEffort: "high",
      permissionProfile: "workspace", approvalPolicy: "on-request", title: "Worker",
      promptDigest: executorDigest("Implement the requested change."),
    }],
    ...overrides,
  });
}

export function executorProviders({ now = () => 1000 } = {}) {
  const state = { epoch: "epoch-one", config: "e".repeat(64), account: "f".repeat(64), allow: true,
    operations: ["create", "start", "observe", "read-result", "interrupt"], interaction: "interactive" };
  const evaluate = async (scope) => ({
    context: { serviceId: "test-service", ownerEpoch: state.epoch, runtimeGeneration: "1".repeat(64),
      accountFingerprint: state.account, configFingerprint: state.config, certificationId: "test-only-certification",
      scopeDigest: executorDigest(scope), validUntil: now() + 60_000 },
    operations: [...state.operations], interaction: state.interaction,
  });
  const authorize = async (scope, { context }) => state.allow ? {
    decision: "allow", decisionId: "test-only-policy-decision", scopeDigest: executorDigest(scope),
    contextFingerprint: executorContextFingerprintV1(context), expiresAt: now() + 60_000,
  } : { decision: "deny" };
  return { state, evaluate, authorize, now };
}
