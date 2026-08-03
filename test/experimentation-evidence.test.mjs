import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { canonicalDigest } from "../src/experimentation-contract/index.mjs";
import {
  ArtifactStore, EvidenceError, EvidenceLedger, accountTaskWeb, assessEvidenceHealth,
  captureAllowedEnvironment, collectEvidenceEvent, createEvidenceEvent,
  createStreamContractRegistry, provenanceDigest, validateEvidenceEvent, verifyAttemptEvidence,
} from "../src/experimentation-evidence/index.mjs";

const base = Object.freeze({
  experimentId: "exp:one", runId: "run:one", runGeneration: 1, taskId: "task:one",
  trialId: "trial:one", rootTrialId: "trial:one", attempt: 1,
  writerId: "writer:one", writerEpoch: 1, clockId: "clock:one",
  observedWallTime: "2026-08-03T12:00:00Z",
});

function event(fields = {}) {
  return createEvidenceEvent({
    ...base,
    eventId: "evt:one", eventType: "trial.started", stream: "measurement",
    sequence: 1, previousEventDigest: null, monotonicTimeNs: "1",
    payloadSchema: "nelos://events/trial.started/v1", payload: {},
    ...fields,
  });
}

function chain(specifications, common = {}) {
  let previousEventDigest = null;
  return specifications.map((specification, index) => {
    const next = event({
      eventId: `evt:${common.writerId ?? "one"}:${index + 1}`,
      sequence: index + 1,
      previousEventDigest,
      monotonicTimeNs: String(index + 1),
      ...common,
      ...specification,
    });
    previousEventDigest = next.eventDigest;
    return next;
  });
}

function contractsFor(events) {
  return createStreamContractRegistry(events.map((entry) => ({
    payloadSchema: entry.payloadSchema,
    stream: entry.stream,
    version: 1,
    validate() {},
  })).filter((entry, index, all) => all.findIndex((other) => other.payloadSchema === entry.payloadSchema) === index));
}

function errorCode(code) {
  return (error) => error instanceof EvidenceError && error.code === code;
}

function provenance(overrides = {}) {
  const sha = canonicalDigest({ fixture: true });
  const unsigned = {
    schemaVersion: 1, experimentId: base.experimentId, runId: base.runId,
    trialId: base.trialId, attempt: base.attempt,
    repository: { url: "https://example.invalid/nelos.git", commit: "a".repeat(40), treeDigest: sha, dirty: false, diffDigest: sha, untrackedInputsDigest: sha },
    contractDigest: sha, corpusDigest: sha, configurationDigest: sha, promptDigest: sha,
    permissionDigest: sha, policyDigest: sha,
    models: [{ requestId: "request:one", requested: "gpt-requested", observed: "gpt-observed", parameterDigest: sha }],
    components: [{ kind: "collector", name: "nelos-evidence", version: "1.0.0", digest: sha }],
    runtime: { runtimeLockDigest: sha, imageDigest: sha, hostCapabilityDigest: sha },
    dependencyLockDigest: sha, sbomDigest: sha, inputArtifacts: [], graderArtifacts: [],
    collectorVersion: "1.0.0",
    ...overrides,
  };
  return { ...unsigned, manifestDigest: provenanceDigest(unsigned) };
}

test("event envelopes correlate every required identity and stream contracts are enforceable", () => {
  const correlated = event({
    processId: "process:1", operationId: "operation:1", modelRequestId: "request:1",
    toolCallId: "tool:1", pluginInvocationId: "plugin:1", graderInvocationId: "grader:1",
    artifactId: "artifact:1", threadId: "thread:1", turnId: "turn:1",
  });
  assert.equal(correlated.eventDigest.startsWith("sha256:"), true);
  for (const field of ["experimentId", "runId", "taskId", "trialId", "processId", "operationId", "modelRequestId", "toolCallId", "pluginInvocationId", "graderInvocationId", "artifactId", "threadId", "turnId", "rootTrialId"]) {
    assert.notEqual(correlated[field], undefined, field);
  }

  const registry = createStreamContractRegistry([{ payloadSchema: correlated.payloadSchema, stream: "operational", version: 1, validate() {} }]);
  assert.throws(() => createEvidenceEvent({ ...correlated, eventDigest: undefined }, { streamContracts: registry }), errorCode("STREAM_CONTRACT_VIOLATION"));
  assert.throws(() => validateEvidenceEvent({ ...correlated, extra: true }), errorCode("INVALID_EVENT"));
});

test("collectors cover every required source and refuse inline private content", () => {
  const sources = ["codex-jsonl", "app-server", "opentelemetry", "nelos-task-web", "grader", "runtime-resource", "artifact"];
  for (const [index, source] of sources.entries()) {
    const collected = collectEvidenceEvent(source, {
      eventId: `evt:collector:${index}`,
      payload: { sourceRecordId: `${source}:1`, promptArtifactId: "artifact:prompt" },
    }, { ...base, sequence: 1, previousEventDigest: null, monotonicTimeNs: String(index + 1) });
    assert.equal(collected.payload.source, source);
  }
  for (const [field, value] of [
    ["environment", { API_TOKEN: "secret" }], ["toolArguments", { password: "secret" }],
    ["toolResult", "secret"], ["prompt", "secret"], ["response", "secret"], ["stderr", "secret"],
  ]) {
    assert.throws(() => collectEvidenceEvent("codex-jsonl", { eventId: `evt:private:${field}`, payload: { [field]: value } }, { ...base, sequence: 1, previousEventDigest: null, monotonicTimeNs: "1" }), errorCode("PRIVACY_VIOLATION"));
  }
});

test("the ledger durably separates streams, enforces chains, and rejects interrupted records", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nelos-ledger-"));
  const events = chain([
    { eventType: "trial.started", stream: "measurement", payloadSchema: "nelos://events/trial.started/v1" },
    { eventType: "runner.heartbeat", stream: "operational", payloadSchema: "nelos://events/runner.heartbeat/v1" },
    { eventType: "writer.shutdown", stream: "audit", payloadSchema: "nelos://events/writer.shutdown/v1" },
  ]);
  const registry = contractsFor(events);
  const ledger = await EvidenceLedger.open(root, { streamContracts: registry });
  for (const entry of events) await ledger.append(entry);
  assert.match(await readFile(resolve(root, "streams/measurement.jsonl"), "utf8"), /trial\.started/u);
  assert.match(await readFile(resolve(root, "streams/operational.jsonl"), "utf8"), /runner\.heartbeat/u);
  assert.match(await readFile(resolve(root, "streams/audit.jsonl"), "utf8"), /writer\.shutdown/u);
  const reopened = await EvidenceLedger.open(root, { streamContracts: registry });
  assert.equal(reopened.events.length, 3);
  await assert.rejects(reopened.append(events[2]), errorCode("DUPLICATE_EVIDENCE"));
  await assert.rejects(reopened.append(event({ eventId: "evt:gap", sequence: 5, previousEventDigest: events[2].eventDigest })), errorCode("SEQUENCE_GAP"));

  const interrupted = await mkdtemp(resolve(tmpdir(), "nelos-ledger-interrupted-"));
  const interruptedLedger = await EvidenceLedger.open(interrupted);
  await interruptedLedger.append(event());
  await appendFile(resolve(interrupted, "streams/measurement.jsonl"), "{\"partial\":");
  await assert.rejects(EvidenceLedger.open(interrupted), errorCode("INTERRUPTED_LEDGER"));
});

test("task-web accounting includes every role and keeps token, credit, and currency measures distinct", () => {
  const roles = ["queen", "planner", "subagent", "spinoff", "grader"];
  const events = roles.map((role, index) => event({
    eventId: `evt:usage:${index}`, writerId: `writer:${index}`, threadId: `thread:${index}`,
    turnId: `turn:${index}`, modelRequestId: `request:${index}`,
    payload: {
      memberRole: role,
      measuredTokens: { input: index + 1, cachedInput: index, output: 2, reasoningOutput: 3 },
      observedBillingCredits: 0.25,
      observedCurrencyCost: 0.01,
      correction: index === 1,
      retry: index === 2,
      outcome: index === 3 ? "blocked" : index === 4 ? "failed" : "succeeded",
    },
  }));
  const result = accountTaskWeb([...events, events[0]], {
    rateTable: { version: "credits-2026-08", rates: { input: 1, cachedInput: 0.5, output: 2, reasoningOutput: 3 } },
    expectedMembers: roles.map((role, index) => ({ threadId: `thread:${index}`, role })),
  });
  assert.deepEqual(result.measuredTokens, { input: 15, cachedInput: 10, output: 10, reasoningOutput: 15 });
  assert.equal(result.estimatedStandardCredits, 85);
  assert.equal(result.estimatedStandardCreditsRateTableVersion, "credits-2026-08");
  assert.equal(result.observedBillingCredits, 1.25);
  assert.equal(result.observedCurrencyCost, 0.05);
  assert.deepEqual({ corrections: result.taskWeb.corrections, retries: result.taskWeb.retries, blocked: result.taskWeb.blocked, failures: result.taskWeb.failures }, { corrections: 1, retries: 1, blocked: 1, failures: 1 });
  assert.equal(result.taskWeb.members.length, 5);
  assert.throws(() => accountTaskWeb([event({ turnId: "turn:unattributed", threadId: "thread:unknown" })]), errorCode("UNATTRIBUTED_DESCENDANT"));
});

test("evidence health detects gaps, broken chains, missing terminals, sink loss, clock uncertainty, and observer overhead", () => {
  const [first, second] = chain([
    { eventType: "process.started", payload: { componentId: "process:1" } },
    { eventType: "telemetry.health", stream: "operational", payloadSchema: "nelos://events/telemetry.health/v1", payload: { sinkLoss: true, droppedEvents: 1, clockUncertaintyNs: "9000000", observerCpuTimeNs: "20", attemptCpuTimeNs: "100" } },
  ]);
  const broken = { ...second, sequence: 3, previousEventDigest: canonicalDigest({ wrong: true }) };
  broken.eventDigest = canonicalDigest(Object.fromEntries(Object.entries(broken).filter(([key]) => key !== "eventDigest")));
  const health = assessEvidenceHealth([first, broken], {
    expectedWriters: [{ writerId: "writer:one", writerEpoch: 1 }], expectedComponents: ["process:1"],
    maxObserverOverheadRatio: 0.05,
  });
  assert.equal(health.status, "invalid");
  for (const code of ["SEQUENCE_GAP", "BROKEN_CHAIN", "MISSING_TERMINAL", "SINK_LOSS", "CLOCK_UNCERTAINTY", "OBSERVER_OVERHEAD"]) {
    assert.ok(health.issues.some((entry) => entry.code === code), code);
  }
});

test("artifacts are content-addressed, redacted or quarantined, access-controlled, and retention-bound", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nelos-artifacts-"));
  const store = await ArtifactStore.open(root);
  const common = {
    kind: "tool-result", mediaType: "text/plain", experimentId: base.experimentId,
    runId: base.runId, trialId: base.trialId, attempt: 1, producerEventId: "evt:producer",
    provenanceDigest: canonicalDigest({ provenance: true }), readers: ["verifier"],
    retention: { policyId: "experiment-90d", retainUntil: "2027-01-01T00:00:00Z", legalHold: false },
  };
  const redacted = await store.commit({ ...common, bytes: "Authorization: Bearer abcdefghijklmnop", redactionPolicy: { policyId: "privacy-v1", onSecret: "redact" } });
  assert.equal(redacted.redaction.status, "redacted");
  assert.equal((await store.read(redacted, { principal: "verifier" })).toString(), "[REDACTED]");
  await assert.rejects(store.read(redacted, { principal: "intruder" }), errorCode("UNAUTHORIZED_ARTIFACT"));
  const same = await store.commit({ ...common, bytes: "Authorization: Bearer abcdefghijklmnop", redactionPolicy: { policyId: "privacy-v1", onSecret: "redact" } });
  assert.equal(same.contentDigest, redacted.contentDigest);

  const quarantined = await store.commit({ ...common, bytes: "password=hunter2", redactionPolicy: { policyId: "privacy-v1", onSecret: "quarantine" } });
  assert.equal(quarantined.classification, "quarantined");
  assert.ok(quarantined.access.readers.includes("privacy-reviewer"));
  await assert.rejects(store.commit({ ...common, bytes: "sk-proj_abcdefghijklmnop", redactionPolicy: { policyId: "privacy-v1", onSecret: "drop" } }), errorCode("PRIVACY_DROPPED"));
  assert.deepEqual(JSON.parse(captureAllowedEnvironment({ LANG: "en_US", API_TOKEN: "secret" }, ["LANG"]).toString()), { LANG: "en_US" });
  assert.throws(() => captureAllowedEnvironment({ API_TOKEN: "secret" }, ["API_TOKEN"]), errorCode("PRIVACY_VIOLATION"));

  await chmod(resolve(root, "objects/internal", redacted.contentDigest.slice(7)), 0o600).catch(() => {});
});

test("the verifier recomputes stable manifests and rejects altered, missing, duplicated, unauthorized, incompatible, and cross-run evidence", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nelos-verify-"));
  const store = await ArtifactStore.open(root);
  const producer = event({
    eventId: "evt:producer", eventType: "task_web.member.terminal", threadId: "thread:queen", turnId: "turn:queen",
    modelRequestId: "request:one", payloadSchema: "nelos://events/task_web.member.terminal/v1",
    payload: { componentId: "queen", memberRole: "queen", measuredTokens: { input: 10, cachedInput: 2, output: 4, reasoningOutput: 1 }, outcome: "succeeded" },
  });
  const manifest = await store.commit({
    bytes: "safe result", kind: "candidate-output", mediaType: "text/plain",
    experimentId: base.experimentId, runId: base.runId, trialId: base.trialId, attempt: 1,
    producerEventId: producer.eventId, provenanceDigest: provenance().manifestDigest,
    classification: "restricted", readers: ["verifier"], encryption: "envelope",
    redactionPolicy: { policyId: "privacy-v1", onSecret: "quarantine" },
    retention: { policyId: "experiment-90d", retainUntil: "2027-01-01T00:00:00Z", legalHold: false },
  });
  const [artifactEvent, shutdown] = chain([
    { eventId: "evt:artifact", eventType: "artifact.committed", stream: "audit", artifactId: manifest.artifactId, payloadSchema: "nelos://events/artifact.committed/v1", payload: { manifestDigest: manifest.manifestDigest } },
    { eventId: "evt:shutdown", eventType: "writer.shutdown", stream: "audit", payloadSchema: "nelos://events/writer.shutdown/v1", payload: {} },
  ]);
  // Rechain artifact events after the independently created producer.
  const second = createEvidenceEvent({ ...artifactEvent, sequence: 2, previousEventDigest: producer.eventDigest, monotonicTimeNs: "2", eventDigest: undefined });
  const third = createEvidenceEvent({ ...shutdown, sequence: 3, previousEventDigest: second.eventDigest, monotonicTimeNs: "3", eventDigest: undefined });
  const events = [producer, second, third];
  const registry = contractsFor(events);
  const expected = { ...base };
  delete expected.writerId; delete expected.writerEpoch; delete expected.clockId; delete expected.observedWallTime;
  const request = {
    events, artifactManifests: [manifest], artifactStore: store, provenance: provenance(), expected,
    streamContracts: registry, expectedWriters: [{ writerId: "writer:one", writerEpoch: 1 }],
    expectedComponents: ["queen"], expectedTaskWebMembers: [{ threadId: "thread:queen", role: "queen" }],
    rateTable: { version: "v1", rates: { input: 1, cachedInput: 1, output: 1, reasoningOutput: 1 } },
    verifierPrincipal: "verifier",
  };
  const first = await verifyAttemptEvidence(request);
  const reordered = await verifyAttemptEvidence({ ...request, events: [third, producer, second] });
  assert.equal(first.manifestDigest, reordered.manifestDigest);
  assert.equal(first.acceptedForAggregation, true);
  assert.deepEqual(first.accounting.measuredTokens, { input: 10, cachedInput: 2, output: 4, reasoningOutput: 1 });

  const altered = structuredClone(second);
  altered.payload.manifestDigest = canonicalDigest({ altered: true });
  await assert.rejects(verifyAttemptEvidence({ ...request, events: [producer, altered, third] }), errorCode("ALTERED_EVENT"));
  await assert.rejects(verifyAttemptEvidence({ ...request, events: [...events, producer] }), errorCode("DUPLICATE_EVIDENCE"));
  await assert.rejects(verifyAttemptEvidence({ ...request, artifactManifests: [] }), errorCode("MISSING_ARTIFACT"));
  await assert.rejects(verifyAttemptEvidence({ ...request, verifierPrincipal: "intruder" }), errorCode("UNAUTHORIZED_ARTIFACT"));
  await assert.rejects(verifyAttemptEvidence({ ...request, provenance: { ...provenance(), schemaVersion: 2 } }), errorCode("INCOMPATIBLE_EVIDENCE"));
  const foreign = createEvidenceEvent({ ...producer, runId: "run:foreign", eventDigest: undefined });
  await assert.rejects(verifyAttemptEvidence({ ...request, events: [foreign, second, third] }), errorCode("CROSS_RUN_EVIDENCE"));

  await chmod(resolve(root, "objects/restricted", manifest.contentDigest.slice(7)), 0o600);
  await writeFile(resolve(root, "objects/restricted", manifest.contentDigest.slice(7)), "altered");
  await assert.rejects(verifyAttemptEvidence(request), errorCode("ALTERED_ARTIFACT"));
});
