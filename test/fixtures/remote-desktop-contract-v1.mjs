const sha = (character) => `sha256:${character.repeat(64)}`;

export function validRemoteDesktopRunV1() {
  const scenario = (number) => ({
    schemaVersion: 1,
    scenarioId: `scenario-${number}`,
    task: { taskId: `01a01ae1-0000-7000-8000-${String(number).padStart(12, "0")}`, createdForScenario: `scenario-${number}`, fresh: true },
    actions: [
      { actionId: `action-${number}-1`, type: "click", targetRef: "new-task-button", valueRef: null, timeoutMs: 5_000 },
      { actionId: `action-${number}-2`, type: "type_text_ref", targetRef: "task-composer", valueRef: `benchmark-input-${number}`, timeoutMs: 10_000 },
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
    desktopBundle: { bundleId: "com.openai.codex", version: "2026.819.1", digest: sha("2") },
    goldenImage: { imageId: "golden-macos-15-001", digest: sha("3") },
    provider: { providerId: "provider-proxmox-east", hostId: "pve-host-07", vmId: "vm-9401" },
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
      actionType: "click",
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
    leaseId: run.lease.leaseId,
    fencingToken: run.lease.fencingToken,
  };
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
      destroyed: true,
      attestationDigest: sha("9"),
    } : {
      receiptId: "quarantine-receipt-001",
      ...binding,
      mutationStatus: "committed",
      quarantined: true,
      attestationDigest: sha("a"),
      reconciliation: { operationId: "reconcile-vm-9401", ...binding },
    },
  };
}
