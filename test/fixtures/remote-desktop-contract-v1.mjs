import { createHash } from "node:crypto";

const sha = (character) => `sha256:${character.repeat(64)}`;
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const digest = (value) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
export const FIXTURE_NETWORK_POLICY_RULESET_DIGEST_V1 = sha("9");
export const FIXTURE_NETWORK_POLICY_ADDRESS_DIGEST_V1 = sha("7");
export const FIXTURE_NETWORK_POLICY_DIGEST_V1 = digest({
  approvedAddressInventoryDigest: FIXTURE_NETWORK_POLICY_ADDRESS_DIGEST_V1,
  kind: "nelos.proxmox-desktop.gateway-policy-identity.v1",
  networkId: "nelosbld",
  rulesetDigest: FIXTURE_NETWORK_POLICY_RULESET_DIGEST_V1,
  schemaVersion: 1,
});

export function validRemoteDesktopRunV1() {
  const scenario = (number) => ({
    schemaVersion: 1,
    scenarioId: `scenario-${number}`,
    task: { taskId: `01a01ae1-0000-7000-8000-${String(number).padStart(12, "0")}`, createdForScenario: `scenario-${number}`, fresh: true },
    actions: [
      { actionId: `action-${number}-1`, type: "type_text_ref", targetRef: "task-composer", valueRef: `benchmark-input-${number}`, timeoutMs: 10_000 },
      { actionId: `action-${number}-2`, type: "keypress", targetRef: "submit-key", valueRef: null, timeoutMs: 5_000 },
    ],
    checkpoints: [
      { checkpointId: `checkpoint-${number}`, type: "screenshot", afterActionId: `action-${number}-2`, failureOnly: false },
    ],
    assertions: [
      { assertionId: `assertion-${number}`, type: "task_state", targetRef: "active-task", expectedRef: "task-complete", checkpointId: `checkpoint-${number}` },
    ],
    deadlineMs: 120_000,
    failureCaptureTriggers: ["action_error", "assertion_failure", "deadline_exceeded", "desktop_crash", "task_stalled"],
  });
  return {
    schemaVersion: 1,
    runId: "remote-desktop-run-001",
    candidate: { digest: sha("1"), immutable: true },
    desktopBundle: { bundleId: "chatgpt", version: "26.814.41957", digest: "sha256:4778b26a7abd08647214d5b05c17bd3ebe2d9688d146dabf017c1a2faf93ac7d" },
    goldenImage: { imageId: "golden-macos-15-001", digest: sha("3") },
    provider: {
      providerId: "proxmox-lab", hostId: "prox2", vmId: "9401",
      macAddress: "02:4E:45:4C:94:01", networkId: "nelosbld", gatewayId: "9023", networkPolicyDigest: FIXTURE_NETWORK_POLICY_DIGEST_V1,
    },
    lease: {
      leaseId: "lease-remote-001",
      holderId: "nelos-validator-01",
      expiresAt: "2099-01-01T00:00:00.000Z",
      fencingToken: "fence-remote-0007",
      state: "active",
    },
    benchmarkProfile: { profileId: "desktop-blackbox-standard", digest: sha("4") },
    scenarioManifest: { manifestId: "desktop-release-gate-001", digest: sha("5") },
    policy: {
      maxTaskCount: 2,
      maxModelTurnCount: 12,
      maxSpendUsd: 4,
      reservedSpendUsd: 5,
      maxWallTimeMs: 600_000,
      screenshots: { maxCount: 12, maxBytes: 12_000_000 },
      recording: { enabled: true, maxDurationMs: 180_000, maxBytes: 50_000_000 },
      diagnostics: { maxCount: 8, maxBytes: 2_000_000 },
    },
    scenarios: [scenario(1), scenario(2)],
    state: "draft",
  };
}

export function currentLeaseFor(run) {
  return { ...structuredClone(run.lease), ...structuredClone(run.provider) };
}

export function validRemoteDesktopEvidenceExportV1(run = validRemoteDesktopRunV1()) {
  return {
    schemaVersion: 1,
    runId: run.runId,
    scenarioMetadata: run.scenarios.map((scenario) => ({
      evidenceClass: "scenario_metadata",
      scenarioId: scenario.scenarioId,
      taskId: scenario.task.taskId,
      startedAt: "2026-08-19T12:00:00.000Z",
      finishedAt: "2026-08-19T12:01:00.000Z",
      outcome: "passed",
    })),
    identities: {
      candidateDigest: run.candidate.digest,
      desktopBundleDigest: run.desktopBundle.digest,
      goldenImageDigest: run.goldenImage.digest,
      providerId: run.provider.providerId,
      hostId: run.provider.hostId,
      vmId: run.provider.vmId,
      macAddress: run.provider.macAddress,
      networkId: run.provider.networkId,
      gatewayId: run.provider.gatewayId,
      networkPolicyDigest: run.provider.networkPolicyDigest,
      leaseId: run.lease.leaseId,
      fencingToken: run.lease.fencingToken,
      benchmarkProfileDigest: run.benchmarkProfile.digest,
      scenarioManifestDigest: run.scenarioManifest.digest,
    },
    visualArtifacts: [{
      evidenceClass: "sanitized_screenshot",
      artifactId: "screenshot-001",
      scenarioId: "scenario-1",
      digest: sha("6"),
      mediaType: "image/png",
      byteLength: 400_000,
      durationMs: 0,
      sanitized: true,
    }],
    diagnostics: [{
      evidenceClass: "bounded_diagnostic",
      diagnosticId: "diagnostic-001",
      scenarioId: "scenario-1",
      code: "DESKTOP_TASK_COMPLETE",
      occurredAt: "2026-08-19T12:01:00.000Z",
      artifactDigest: sha("7"),
      byteLength: 1_024,
      sanitized: true,
    }],
    actionTimeline: [{
      evidenceClass: "action_timeline",
      scenarioId: "scenario-1",
      actionId: "action-1-1",
      actionType: "type_text_ref",
      startedAt: "2026-08-19T12:00:00.000Z",
      finishedAt: "2026-08-19T12:00:01.000Z",
      outcome: "succeeded",
    }],
    assertionOutcomes: [{
      evidenceClass: "assertion_outcome",
      scenarioId: "scenario-1",
      assertionId: "assertion-1",
      passed: true,
      observedRef: "task-complete",
    }],
    cleanupAttestation: {
      evidenceClass: "cleanup_attestation",
      runId: run.runId,
      providerId: run.provider.providerId,
      hostId: run.provider.hostId,
      vmId: run.provider.vmId,
      macAddress: run.provider.macAddress,
      networkId: run.provider.networkId,
      gatewayId: run.provider.gatewayId,
      networkPolicyDigest: run.provider.networkPolicyDigest,
      leaseId: run.lease.leaseId,
      fencingToken: run.lease.fencingToken,
      terminalOutcomeDigest: sha("8"),
    },
  };
}

export function validRemoteDesktopTerminalOutcomeV1(run = validRemoteDesktopRunV1(), outcome = "destroyed") {
  const binding = {
    providerId: run.provider.providerId,
    hostId: run.provider.hostId,
    vmId: run.provider.vmId,
    macAddress: run.provider.macAddress,
    networkId: run.provider.networkId,
    gatewayId: run.provider.gatewayId,
    networkPolicyDigest: run.provider.networkPolicyDigest,
    leaseId: run.lease.leaseId,
    fencingToken: run.lease.fencingToken,
  };
  const credentialDisposition = (method) => ({
    schemaVersion: 1,
    type: "nelos.credential-terminal-disposition.v1",
    method,
    codexHome: "/home/nelosauto/.codex",
    filesystemType: "tmpfs",
    swapPolicy: "disabled-and-attested-before-auth",
    powerState: "stopped",
    reusableCredentialsAbsent: true,
    secretBytesIncluded: false,
    attestationDigest: sha("b"),
  });
  return {
    schemaVersion: 1,
    runId: run.runId,
    outcome,
    ownedVm: structuredClone(run.provider),
    leaseId: run.lease.leaseId,
    fencingToken: run.lease.fencingToken,
    receipt: outcome === "destroyed" ? {
      receiptId: "destroy-receipt-001",
      ...binding,
      mutationStatus: "committed",
      credentialDisposition: credentialDisposition("powered-off-before-destroy"),
      destroyed: true,
      macAbsent: true,
      networkInventoryComplete: true,
      attestationDigest: sha("9"),
    } : {
      receiptId: "quarantine-receipt-001",
      ...binding,
      mutationStatus: "committed",
      credentialDisposition: credentialDisposition("powered-off-quarantine"),
      quarantined: true,
      attestationDigest: sha("a"),
      reconciliation: { operationId: "reconcile-vm-9401", ...binding },
    },
  };
}
