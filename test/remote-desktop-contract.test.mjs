import assert from "node:assert/strict";
import test from "node:test";

import {
  REMOTE_DESKTOP_EVIDENCE_CLASSES_V1,
  REMOTE_DESKTOP_FORBIDDEN_EVIDENCE_CLASSES_V1,
  REMOTE_DESKTOP_SCHEMAS_V1,
  RemoteDesktopContractError,
  admitRemoteDesktopRun,
  emptyRemoteDesktopUsage,
  transitionRemoteDesktopRun,
  validateRemoteDesktopEvidenceExportV1,
  validateRemoteDesktopRunV1,
  validateRemoteDesktopTerminalOutcomeV1,
  validateRemoteDesktopUsage,
} from "nelos/remote-desktop-contract";
import {
  currentLeaseFor,
  validRemoteDesktopEvidenceExportV1,
  validRemoteDesktopRunV1,
  validRemoteDesktopTerminalOutcomeV1,
} from "./fixtures/remote-desktop-contract-v1.mjs";

const rejectsWith = (code) => (error) => error instanceof RemoteDesktopContractError && error.code === code;

function collectObjectSchemas(schema, path = "$") {
  const found = [];
  if (schema?.type === "object") found.push([path, schema]);
  for (const [field, child] of Object.entries(schema?.properties ?? {})) {
    found.push(...collectObjectSchemas(child, `${path}.properties.${field}`));
  }
  if (schema?.items) found.push(...collectObjectSchemas(schema.items, `${path}.items`));
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    for (const [index, child] of (schema?.[keyword] ?? []).entries()) {
      found.push(...collectObjectSchemas(child, `${path}.${keyword}[${index}]`));
    }
  }
  for (const keyword of ["then", "else"]) {
    if (schema?.[keyword]) found.push(...collectObjectSchemas(schema[keyword], `${path}.${keyword}`));
  }
  return found;
}

function schemaRejectsUnknownProperty(schema, field) {
  return schema?.type === "object" && schema.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, field);
}

test("v1 schemas are closed and valid run binds all immutable remote Desktop identities", () => {
  const run = validRemoteDesktopRunV1();
  assert.equal(REMOTE_DESKTOP_SCHEMAS_V1.run.additionalProperties, false);
  assert.equal(REMOTE_DESKTOP_SCHEMAS_V1.scenario.additionalProperties, false);
  assert.equal(validateRemoteDesktopRunV1(run), run);
  const admitted = admitRemoteDesktopRun(run, {
    candidateDigest: run.candidate.digest,
    currentLease: currentLeaseFor(run),
    now: Date.parse("2026-08-19T12:00:00.000Z"),
  });
  assert.equal(admitted.state, "admitted");
});

test("every nested public JSON schema is closed and rejects unknown fields at the schema boundary", () => {
  for (const [kind, schema] of Object.entries(REMOTE_DESKTOP_SCHEMAS_V1)) {
    const objectSchemas = collectObjectSchemas(schema, kind);
    assert.ok(objectSchemas.length > 1, `${kind} must describe nested public objects`);
    for (const [path, objectSchema] of objectSchemas) {
      assert.equal(objectSchema.additionalProperties, false, `${path} is open`);
      assert.equal(schemaRejectsUnknownProperty(objectSchema, "secretMaterial"), true, `${path} accepts an unknown field`);
    }
  }
  assert.equal(schemaRejectsUnknownProperty(REMOTE_DESKTOP_SCHEMAS_V1.run.properties.policy, "prompt"), true);
  assert.equal(schemaRejectsUnknownProperty(REMOTE_DESKTOP_SCHEMAS_V1.scenario.properties.actions.items, "shellCommand"), true);
  assert.equal(schemaRejectsUnknownProperty(REMOTE_DESKTOP_SCHEMAS_V1.evidenceExport.properties.diagnostics.items, "modelResponse"), true);
  assert.ok(REMOTE_DESKTOP_SCHEMAS_V1.terminalOutcome.properties.receipt.oneOf.every((receipt) => schemaRejectsUnknownProperty(receipt, "cookie")));
});

test("admission rejects stale fencing and mutable candidate identities", () => {
  const run = validRemoteDesktopRunV1();
  const stale = currentLeaseFor(run);
  stale.fencingToken = "fence-remote-newer";
  assert.throws(() => admitRemoteDesktopRun(run, { candidateDigest: run.candidate.digest, currentLease: stale }), rejectsWith("STALE_FENCING_TOKEN"));

  const mutable = validRemoteDesktopRunV1();
  mutable.candidate.immutable = false;
  assert.throws(() => validateRemoteDesktopRunV1(mutable), rejectsWith("MUTABLE_CANDIDATE"));
  assert.throws(() => admitRemoteDesktopRun(run, { candidateDigest: `sha256:${"f".repeat(64)}`, currentLease: currentLeaseFor(run) }), rejectsWith("MUTABLE_CANDIDATE"));
});

test("provider identity requires one explicit locally administered MAC and network", () => {
  const lowercaseMac = validRemoteDesktopRunV1();
  lowercaseMac.provider.macAddress = lowercaseMac.provider.macAddress.toLowerCase();
  assert.throws(() => validateRemoteDesktopRunV1(lowercaseMac), rejectsWith("INVALID_IDENTITY"));

  const omittedNetwork = validRemoteDesktopRunV1();
  delete omittedNetwork.provider.networkId;
  assert.throws(() => validateRemoteDesktopRunV1(omittedNetwork), rejectsWith("INVALID_CONTRACT"));
});

test("the production prox2 provider schema and runtime fix gateway VM 9023 and VNet nelosbld", () => {
  const production = validRemoteDesktopRunV1();
  production.provider = { ...production.provider, providerId: "proxmox-lab", hostId: "prox2", gatewayId: "9024" };
  assert.throws(() => validateRemoteDesktopRunV1(production), rejectsWith("INVALID_PROVIDER_IDENTITY"));
  const alternateNetwork = validRemoteDesktopRunV1();
  alternateNetwork.provider.networkId = "caller-selected";
  assert.throws(
    () => validateRemoteDesktopRunV1(alternateNetwork),
    (error) => error?.code === "INVALID_PROVIDER_IDENTITY" && error?.path === "/provider/networkId",
  );
  const gatewayOnly = validRemoteDesktopRunV1();
  gatewayOnly.provider = { ...gatewayOnly.provider, providerId: "other-provider", hostId: "other-host", networkId: "other-vnet" };
  assert.throws(() => validateRemoteDesktopRunV1(gatewayOnly), rejectsWith("INVALID_PROVIDER_IDENTITY"));
  const networkOnly = validRemoteDesktopRunV1();
  networkOnly.provider = { ...networkOnly.provider, providerId: "other-provider", hostId: "other-host", gatewayId: "9900" };
  assert.throws(() => validateRemoteDesktopRunV1(networkOnly), rejectsWith("INVALID_PROVIDER_IDENTITY"));
  const conditional = REMOTE_DESKTOP_SCHEMAS_V1.run.properties.provider.allOf[0];
  assert.deepEqual(conditional.if.anyOf, [
    { properties: { providerId: { const: "proxmox-lab" } }, required: ["providerId"] },
    { properties: { hostId: { const: "prox2" } }, required: ["hostId"] },
    { properties: { gatewayId: { const: "9023" } }, required: ["gatewayId"] },
    { properties: { networkId: { const: "nelosbld" } }, required: ["networkId"] },
  ]);
  assert.deepEqual(conditional.then.properties, {
    gatewayId: { const: "9023" },
    hostId: { const: "prox2" },
    networkId: { const: "nelosbld" },
    providerId: { const: "proxmox-lab" },
  });
  assert.deepEqual(conditional.then.required, ["gatewayId", "hostId", "networkId", "providerId"]);
});

test("admission rejects omitted budgets and pessimistic spend under-reservation", () => {
  const omitted = validRemoteDesktopRunV1();
  delete omitted.policy.maxModelTurnCount;
  assert.throws(() => validateRemoteDesktopRunV1(omitted), rejectsWith("INVALID_CONTRACT"));

  const underReserved = validRemoteDesktopRunV1();
  underReserved.policy.reservedSpendUsd = 3;
  assert.throws(() => validateRemoteDesktopRunV1(underReserved), rejectsWith("SPEND_NOT_RESERVED"));
});

test("usage validation rejects exhausted count, spend, wall, visual, recording, and diagnostic budgets", () => {
  const run = validRemoteDesktopRunV1();
  const cases = [
    ["taskCount", run.policy.maxTaskCount],
    ["modelTurnCount", run.policy.maxModelTurnCount],
    ["spendUsd", run.policy.maxSpendUsd],
    ["wallTimeMs", run.policy.maxWallTimeMs],
    ["screenshotCount", run.policy.screenshots.maxCount],
    ["screenshotBytes", run.policy.screenshots.maxBytes],
    ["recordingDurationMs", run.policy.recording.maxDurationMs],
    ["recordingBytes", run.policy.recording.maxBytes],
    ["diagnosticLogCount", run.policy.diagnostics.maxCount],
    ["diagnosticLogBytes", run.policy.diagnostics.maxBytes],
  ];
  for (const [field, exhausted] of cases) {
    const usage = emptyRemoteDesktopUsage();
    usage[field] = exhausted;
    assert.throws(() => validateRemoteDesktopUsage(usage, run.policy), rejectsWith("BUDGET_EXHAUSTED"), field);
  }
  const exhaustedAtAdmission = emptyRemoteDesktopUsage();
  exhaustedAtAdmission.modelTurnCount = run.policy.maxModelTurnCount;
  assert.throws(() => admitRemoteDesktopRun(run, {
    candidateDigest: run.candidate.digest,
    currentLease: currentLeaseFor(run),
    usage: exhaustedAtAdmission,
  }), rejectsWith("BUDGET_EXHAUSTED"));
});

test("scenario contract rejects reused tasks and actions outside the allowlist", () => {
  const reused = validRemoteDesktopRunV1();
  reused.scenarios[1].task.taskId = reused.scenarios[0].task.taskId;
  assert.throws(() => validateRemoteDesktopRunV1(reused), rejectsWith("REUSED_TASK_IDENTITY"));

  const prohibitedAction = validRemoteDesktopRunV1();
  prohibitedAction.scenarios[0].actions[0].type = "shell_command";
  assert.throws(() => validateRemoteDesktopRunV1(prohibitedAction), rejectsWith("INVALID_CONTRACT"));
});

test("export accepts only bounded, sanitized evidence and has an explicit forbidden inventory", () => {
  const run = validRemoteDesktopRunV1();
  const evidence = validRemoteDesktopEvidenceExportV1(run);
  assert.equal(validateRemoteDesktopEvidenceExportV1(evidence, run), evidence);
  assert.ok(REMOTE_DESKTOP_EVIDENCE_CLASSES_V1.includes("cleanup_attestation"));
  assert.deepEqual(REMOTE_DESKTOP_FORBIDDEN_EVIDENCE_CLASSES_V1, [
    "prompt", "model_response", "token", "cookie", "session_database", "environment_dump", "credential",
  ]);

  const prohibited = validRemoteDesktopEvidenceExportV1(run);
  prohibited.diagnostics[0].evidenceClass = "prompt";
  assert.throws(() => validateRemoteDesktopEvidenceExportV1(prohibited, run), rejectsWith("PROHIBITED_EVIDENCE_CLASS"));

  const secretField = validRemoteDesktopEvidenceExportV1(run);
  secretField.diagnostics[0].modelResponse = "raw response";
  assert.throws(() => validateRemoteDesktopEvidenceExportV1(secretField, run), rejectsWith("INVALID_CONTRACT"));

  const cleanupMismatch = validRemoteDesktopEvidenceExportV1(run);
  cleanupMismatch.cleanupAttestation.vmId = "vm-other";
  assert.throws(() => validateRemoteDesktopEvidenceExportV1(cleanupMismatch, run), rejectsWith("IDENTITY_MISMATCH"));
});

test("only exact attested destruction or identity-preserving quarantine is terminal", () => {
  const run = validRemoteDesktopRunV1();
  assert.doesNotThrow(() => validateRemoteDesktopTerminalOutcomeV1(validRemoteDesktopTerminalOutcomeV1(run), run));
  assert.doesNotThrow(() => validateRemoteDesktopTerminalOutcomeV1(validRemoteDesktopTerminalOutcomeV1(run, "quarantined"), run));

  const mismatch = validRemoteDesktopTerminalOutcomeV1(run);
  mismatch.receipt.vmId = "vm-other";
  assert.throws(() => validateRemoteDesktopTerminalOutcomeV1(mismatch, run), rejectsWith("TERMINAL_IDENTITY_MISMATCH"));

  const quarantineMismatch = validRemoteDesktopTerminalOutcomeV1(run, "quarantined");
  quarantineMismatch.receipt.reconciliation.hostId = "host-other";
  assert.throws(() => validateRemoteDesktopTerminalOutcomeV1(quarantineMismatch, run), rejectsWith("TERMINAL_IDENTITY_MISMATCH"));

  const ambiguous = validRemoteDesktopTerminalOutcomeV1(run);
  ambiguous.receipt.mutationStatus = "ambiguous";
  assert.throws(() => validateRemoteDesktopTerminalOutcomeV1(ambiguous, run), rejectsWith("AMBIGUOUS_MUTATION_RECEIPT"));
});

test("run lifecycle is closed and terminal states cannot transition", () => {
  const run = validRemoteDesktopRunV1();
  const admitted = { ...run, state: "admitted" };
  const running = transitionRemoteDesktopRun(admitted, "running");
  const cleaning = transitionRemoteDesktopRun(running, "cleaning");
  assert.throws(() => transitionRemoteDesktopRun(cleaning, "succeeded"), rejectsWith("TERMINAL_ATTESTATION_REQUIRED"));
  const succeeded = transitionRemoteDesktopRun(cleaning, "succeeded", {
    terminalOutcome: validRemoteDesktopTerminalOutcomeV1(run),
  });
  assert.throws(() => transitionRemoteDesktopRun(succeeded, "running"), rejectsWith("INVALID_TRANSITION"));
});
