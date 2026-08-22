const digest = Object.freeze({ type: "string", pattern: "^sha256:[0-9a-f]{64}$" });
const identity = Object.freeze({ type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const macAddress = Object.freeze({ type: "string", pattern: "^02(?::[0-9A-F]{2}){5}$" });
const timestamp = Object.freeze({ type: "string", format: "date-time" });
const positiveInteger = Object.freeze({ type: "integer", minimum: 1 });
const nonNegativeInteger = Object.freeze({ type: "integer", minimum: 0 });
const positiveNumber = Object.freeze({ type: "number", exclusiveMinimum: 0 });

const closed = (required, properties) => Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(required),
  properties: Object.freeze(properties),
});

const task = closed(["taskId", "createdForScenario", "fresh"], {
  taskId: identity, createdForScenario: identity, fresh: { const: true },
});
const action = closed(["actionId", "type", "targetRef", "valueRef", "timeoutMs"], {
  actionId: identity,
  type: { enum: ["click", "keypress", "scroll", "select_menu", "type_text_ref", "wait_for"] },
  targetRef: identity,
  valueRef: { oneOf: [identity, { type: "null" }] },
  timeoutMs: positiveInteger,
});
const checkpoint = closed(["checkpointId", "type", "afterActionId", "failureOnly"], {
  checkpointId: identity,
  type: { enum: ["accessibility_tree", "screenshot", "window_state"] },
  afterActionId: identity,
  failureOnly: { type: "boolean" },
});
const assertion = closed(["assertionId", "type", "targetRef", "expectedRef", "checkpointId"], {
  assertionId: identity,
  type: { enum: ["element_absent", "element_present", "task_state", "text_ref_present", "window_count"] },
  targetRef: identity,
  expectedRef: { oneOf: [identity, { type: "null" }] },
  checkpointId: identity,
});
const scenario = closed(
  ["schemaVersion", "scenarioId", "task", "actions", "checkpoints", "assertions", "deadlineMs", "failureCaptureTriggers"],
  {
    schemaVersion: { const: 1 }, scenarioId: identity, task,
    actions: { type: "array", minItems: 1, maxItems: 500, items: action },
    checkpoints: { type: "array", minItems: 1, maxItems: 500, items: checkpoint },
    assertions: { type: "array", minItems: 1, maxItems: 500, items: assertion },
    deadlineMs: positiveInteger,
    failureCaptureTriggers: {
      type: "array", minItems: 1, maxItems: 5, uniqueItems: true,
      items: { enum: ["action_error", "assertion_failure", "deadline_exceeded", "desktop_crash", "task_stalled"] },
    },
  },
);
const policy = closed(
  ["maxTaskCount", "maxModelTurnCount", "maxSpendUsd", "reservedSpendUsd", "maxWallTimeMs", "screenshots", "recording", "diagnostics"],
  {
    maxTaskCount: positiveInteger, maxModelTurnCount: positiveInteger,
    maxSpendUsd: positiveNumber, reservedSpendUsd: positiveNumber,
    maxWallTimeMs: positiveInteger,
    screenshots: closed(["maxCount", "maxBytes"], { maxCount: positiveInteger, maxBytes: positiveInteger }),
    recording: closed(["enabled", "maxDurationMs", "maxBytes"], {
      enabled: { type: "boolean" }, maxDurationMs: nonNegativeInteger, maxBytes: nonNegativeInteger,
    }),
    diagnostics: closed(["maxCount", "maxBytes"], { maxCount: positiveInteger, maxBytes: positiveInteger }),
  },
);
const providerIdentity = Object.freeze({
  ...closed(["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest"], {
    providerId: identity, hostId: identity, vmId: identity, macAddress, networkId: identity,
    gatewayId: identity, networkPolicyDigest: digest,
  }),
  allOf: Object.freeze([Object.freeze({
    if: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ properties: Object.freeze({ providerId: Object.freeze({ const: "proxmox-lab" }) }), required: Object.freeze(["providerId"]) }),
        Object.freeze({ properties: Object.freeze({ hostId: Object.freeze({ const: "prox2" }) }), required: Object.freeze(["hostId"]) }),
        Object.freeze({ properties: Object.freeze({ gatewayId: Object.freeze({ const: "9023" }) }), required: Object.freeze(["gatewayId"]) }),
        Object.freeze({ properties: Object.freeze({ networkId: Object.freeze({ const: "nelosbld" }) }), required: Object.freeze(["networkId"]) }),
      ]),
    }),
    then: Object.freeze({
      properties: Object.freeze({
        gatewayId: Object.freeze({ const: "9023" }),
        hostId: Object.freeze({ const: "prox2" }),
        networkId: Object.freeze({ const: "nelosbld" }),
        providerId: Object.freeze({ const: "proxmox-lab" }),
      }),
      required: Object.freeze(["gatewayId", "hostId", "networkId", "providerId"]),
    }),
  })]),
});
const scenarioMetadata = closed(["evidenceClass", "scenarioId", "taskId", "startedAt", "finishedAt", "outcome"], {
  evidenceClass: { const: "scenario_metadata" }, scenarioId: identity, taskId: identity,
  startedAt: timestamp, finishedAt: timestamp, outcome: { enum: ["passed", "failed", "timed_out"] },
});
const exportIdentities = closed(
  ["candidateDigest", "desktopBundleDigest", "goldenImageDigest", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "benchmarkProfileDigest", "scenarioManifestDigest"],
  {
    candidateDigest: digest, desktopBundleDigest: digest, goldenImageDigest: digest,
    providerId: identity, hostId: identity, vmId: identity, macAddress, networkId: identity, gatewayId: identity,
    networkPolicyDigest: digest, leaseId: identity, fencingToken: identity,
    benchmarkProfileDigest: digest, scenarioManifestDigest: digest,
  },
);
const visualArtifact = closed(["evidenceClass", "artifactId", "scenarioId", "digest", "mediaType", "byteLength", "durationMs", "sanitized"], {
  evidenceClass: { enum: ["sanitized_screenshot", "sanitized_recording"] },
  artifactId: identity, scenarioId: identity, digest,
  mediaType: { enum: ["image/png", "image/jpeg", "video/mp4"] },
  byteLength: positiveInteger, durationMs: nonNegativeInteger, sanitized: { const: true },
});
const diagnostic = closed(["evidenceClass", "diagnosticId", "scenarioId", "code", "occurredAt", "artifactDigest", "byteLength", "sanitized"], {
  evidenceClass: { const: "bounded_diagnostic" }, diagnosticId: identity, scenarioId: identity,
  code: identity, occurredAt: timestamp, artifactDigest: digest, byteLength: positiveInteger, sanitized: { const: true },
});
const timelineEntry = closed(["evidenceClass", "scenarioId", "actionId", "actionType", "startedAt", "finishedAt", "outcome"], {
  evidenceClass: { const: "action_timeline" }, scenarioId: identity, actionId: identity,
  actionType: { enum: ["click", "keypress", "scroll", "select_menu", "type_text_ref", "wait_for"] },
  startedAt: timestamp, finishedAt: timestamp, outcome: { enum: ["succeeded", "failed", "timed_out"] },
});
const assertionOutcome = closed(["evidenceClass", "scenarioId", "assertionId", "passed", "observedRef"], {
  evidenceClass: { const: "assertion_outcome" }, scenarioId: identity, assertionId: identity,
  passed: { type: "boolean" }, observedRef: { oneOf: [identity, { type: "null" }] },
});
const cleanupAttestation = closed(["evidenceClass", "runId", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "terminalOutcomeDigest"], {
  evidenceClass: { const: "cleanup_attestation" }, runId: identity, providerId: identity,
  hostId: identity, vmId: identity, macAddress, networkId: identity, gatewayId: identity,
  networkPolicyDigest: digest, leaseId: identity, fencingToken: identity, terminalOutcomeDigest: digest,
});
const terminalReceiptBinding = {
  receiptId: identity, providerId: identity, hostId: identity, vmId: identity, macAddress, networkId: identity, gatewayId: identity,
  networkPolicyDigest: digest,
  leaseId: identity, fencingToken: identity, mutationStatus: { const: "committed" }, attestationDigest: digest,
};
const credentialDispositionBase = {
  attestationDigest: digest,
  codexHome: { const: "/home/nelosauto/.codex" },
  filesystemType: { const: "tmpfs" },
  powerState: { const: "stopped" },
  reusableCredentialsAbsent: { const: true },
  schemaVersion: { const: 1 },
  secretBytesIncluded: { const: false },
  swapPolicy: { const: "disabled-and-attested-before-auth" },
  type: { const: "nelos.credential-terminal-disposition.v1" },
};
const destructionCredentialDisposition = closed(
  ["attestationDigest", "codexHome", "filesystemType", "method", "powerState", "reusableCredentialsAbsent", "schemaVersion", "secretBytesIncluded", "swapPolicy", "type"],
  { ...credentialDispositionBase, method: { const: "powered-off-before-destroy" } },
);
const quarantineCredentialDisposition = closed(
  ["attestationDigest", "codexHome", "filesystemType", "method", "powerState", "reusableCredentialsAbsent", "schemaVersion", "secretBytesIncluded", "swapPolicy", "type"],
  { ...credentialDispositionBase, method: { const: "powered-off-quarantine" } },
);
const destructionReceipt = closed(
  ["receiptId", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "mutationStatus", "credentialDisposition", "destroyed", "macAbsent", "networkInventoryComplete", "attestationDigest"],
  { ...terminalReceiptBinding, credentialDisposition: destructionCredentialDisposition, destroyed: { const: true }, macAbsent: { const: true }, networkInventoryComplete: { const: true } },
);
const reconciliation = closed(["operationId", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken"], {
  operationId: identity, providerId: identity, hostId: identity, vmId: identity, macAddress, networkId: identity,
  gatewayId: identity, networkPolicyDigest: digest, leaseId: identity, fencingToken: identity,
});
const quarantineReceipt = closed(
  ["receiptId", "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken", "mutationStatus", "credentialDisposition", "quarantined", "attestationDigest", "reconciliation"],
  { ...terminalReceiptBinding, credentialDisposition: quarantineCredentialDisposition, quarantined: { const: true }, reconciliation },
);

export const REMOTE_DESKTOP_SCHEMA_VERSION = 1;

/** Closed wire schemas. Cross-record invariants remain normative in index.mjs. */
export const REMOTE_DESKTOP_SCHEMAS_V1 = Object.freeze({
  scenario,
  run: closed(
    ["schemaVersion", "runId", "candidate", "desktopBundle", "goldenImage", "provider", "lease", "benchmarkProfile", "scenarioManifest", "policy", "scenarios", "state"],
    {
      schemaVersion: { const: 1 }, runId: identity,
      candidate: closed(["digest", "immutable"], { digest, immutable: { const: true } }),
      desktopBundle: closed(["bundleId", "version", "digest"], {
        bundleId: identity, version: { type: "string", minLength: 1, maxLength: 128 }, digest,
      }),
      goldenImage: closed(["imageId", "digest"], { imageId: identity, digest }),
      provider: providerIdentity,
      lease: closed(["leaseId", "holderId", "expiresAt", "fencingToken", "state"], {
        leaseId: identity, holderId: identity, expiresAt: timestamp, fencingToken: identity, state: { const: "active" },
      }),
      benchmarkProfile: closed(["profileId", "digest"], { profileId: identity, digest }),
      scenarioManifest: closed(["manifestId", "digest"], { manifestId: identity, digest }),
      policy,
      scenarios: { type: "array", minItems: 1, items: scenario },
      state: { enum: ["draft", "admitted", "running", "capturing_failure", "cleaning", "succeeded", "failed", "quarantined"] },
    },
  ),
  evidenceExport: closed(
    ["schemaVersion", "runId", "scenarioMetadata", "identities", "visualArtifacts", "diagnostics", "actionTimeline", "assertionOutcomes", "cleanupAttestation"],
    {
      schemaVersion: { const: 1 }, runId: identity,
      scenarioMetadata: { type: "array", items: scenarioMetadata }, identities: exportIdentities,
      visualArtifacts: { type: "array", items: visualArtifact }, diagnostics: { type: "array", items: diagnostic },
      actionTimeline: { type: "array", items: timelineEntry }, assertionOutcomes: { type: "array", items: assertionOutcome },
      cleanupAttestation,
    },
  ),
  terminalOutcome: closed(
    ["schemaVersion", "runId", "outcome", "ownedVm", "leaseId", "fencingToken", "receipt"],
    {
      schemaVersion: { const: 1 }, runId: identity, outcome: { enum: ["destroyed", "quarantined"] },
      ownedVm: providerIdentity, leaseId: identity, fencingToken: identity,
      receipt: { oneOf: [destructionReceipt, quarantineReceipt] },
    },
  ),
});
