import { canonicalDigest } from "../experimentation-contract/index.mjs";
import { accountTaskWeb } from "./collectors.mjs";
import { validateEvidenceEvent } from "./contracts.mjs";
import { evidenceFailure } from "./errors.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PROVENANCE_FIELDS = [
  "schemaVersion", "experimentId", "runId", "trialId", "attempt", "repository",
  "contractDigest", "corpusDigest", "configurationDigest", "promptDigest",
  "permissionDigest", "policyDigest", "models", "components", "runtime",
  "dependencyLockDigest", "sbomDigest", "inputArtifacts", "graderArtifacts",
  "collectorVersion", "manifestDigest",
];

function exactFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) evidenceFailure("INVALID_PROVENANCE", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) evidenceFailure("INVALID_PROVENANCE", `${label} fields must match the closed schema`);
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) evidenceFailure("INVALID_PROVENANCE", `${label} must be a sha256 digest`);
}

export function provenanceDigest(provenance) {
  const material = { ...provenance };
  delete material.manifestDigest;
  return canonicalDigest(material);
}

export function validateProvenanceManifest(provenance) {
  exactFields(provenance, PROVENANCE_FIELDS, "provenance manifest");
  if (provenance.schemaVersion !== 1 || !Number.isSafeInteger(provenance.attempt) || provenance.attempt < 1) evidenceFailure("INCOMPATIBLE_EVIDENCE", "provenance schema or attempt is invalid");
  for (const field of ["contractDigest", "corpusDigest", "configurationDigest", "promptDigest", "permissionDigest", "policyDigest", "dependencyLockDigest", "sbomDigest"]) digest(provenance[field], field);
  exactFields(provenance.repository, ["url", "commit", "treeDigest", "dirty", "diffDigest", "untrackedInputsDigest"], "repository provenance");
  digest(provenance.repository.treeDigest, "repository.treeDigest");
  digest(provenance.repository.diffDigest, "repository.diffDigest");
  digest(provenance.repository.untrackedInputsDigest, "repository.untrackedInputsDigest");
  if (typeof provenance.repository.dirty !== "boolean" || typeof provenance.repository.commit !== "string") evidenceFailure("INVALID_PROVENANCE", "repository provenance is invalid");
  if (!Array.isArray(provenance.models) || !Array.isArray(provenance.components) || !Array.isArray(provenance.inputArtifacts) || !Array.isArray(provenance.graderArtifacts)) evidenceFailure("INVALID_PROVENANCE", "provenance inventories must be arrays");
  for (const [index, model] of provenance.models.entries()) {
    exactFields(model, ["requestId", "requested", "observed", "parameterDigest"], `models/${index}`);
    digest(model.parameterDigest, `models/${index}/parameterDigest`);
    if (!model.requestId || !model.requested || !model.observed) evidenceFailure("INVALID_PROVENANCE", "model provenance is incomplete");
  }
  for (const [index, component] of provenance.components.entries()) {
    exactFields(component, ["kind", "name", "version", "digest"], `components/${index}`);
    digest(component.digest, `components/${index}/digest`);
  }
  exactFields(provenance.runtime, ["runtimeLockDigest", "imageDigest", "hostCapabilityDigest"], "runtime provenance");
  for (const value of Object.values(provenance.runtime)) digest(value, "runtime digest");
  for (const value of [...provenance.inputArtifacts, ...provenance.graderArtifacts]) digest(value, "artifact provenance digest");
  if (typeof provenance.collectorVersion !== "string" || !provenance.collectorVersion) evidenceFailure("INVALID_PROVENANCE", "collector version is required");
  if (provenance.manifestDigest !== provenanceDigest(provenance)) evidenceFailure("ALTERED_PROVENANCE", "provenance manifest digest does not match its contents");
  return provenance;
}

function issue(code, severity, detail) { return Object.freeze({ code, severity, detail }); }

function boundedCounter(value, eventId, field, issues) {
  try {
    if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error();
    return BigInt(value);
  } catch {
    issues.push(issue("MALFORMED_STREAM", "invalid", `${eventId}:${field}`));
    return 0n;
  }
}

export function assessEvidenceHealth(events, {
  expectedWriters = [], expectedComponents = [], maxClockUncertaintyNs = 5_000_000n,
  maxObserverOverheadRatio = 0.05,
} = {}) {
  const issues = [];
  const ids = new Set();
  const digests = new Set();
  const chains = new Map();
  const started = new Set();
  const terminal = new Set();
  let overheadNs = 0n;
  let attemptNs = 0n;

  for (const event of events) {
    try { validateEvidenceEvent(event); } catch (error) {
      issues.push(issue(error.code ?? "MALFORMED_STREAM", "invalid", error.message));
      continue;
    }
    if (ids.has(event.eventId) || digests.has(event.eventDigest)) issues.push(issue("DUPLICATE_EVIDENCE", "invalid", event.eventId));
    ids.add(event.eventId);
    digests.add(event.eventDigest);
    const key = `${event.writerId}\0${event.writerEpoch}`;
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push(event);
    const componentId = event.payload.componentId;
    if (componentId && event.eventType.endsWith(".started")) started.add(componentId);
    if (componentId && event.eventType.endsWith(".terminal")) terminal.add(componentId);
    if (event.eventType === "telemetry.health" && (event.payload.sinkLoss === true || event.payload.droppedEvents > 0)) issues.push(issue("SINK_LOSS", "invalid", event.eventId));
    if (event.payload.clockUncertaintyNs !== undefined && boundedCounter(event.payload.clockUncertaintyNs, event.eventId, "clockUncertaintyNs", issues) > maxClockUncertaintyNs) issues.push(issue("CLOCK_UNCERTAINTY", "invalid", event.eventId));
    if (event.payload.observerCpuTimeNs !== undefined) overheadNs += boundedCounter(event.payload.observerCpuTimeNs, event.eventId, "observerCpuTimeNs", issues);
    if (event.payload.attemptCpuTimeNs !== undefined) attemptNs += boundedCounter(event.payload.attemptCpuTimeNs, event.eventId, "attemptCpuTimeNs", issues);
  }
  for (const [key, chain] of chains) {
    chain.sort((left, right) => left.sequence - right.sequence);
    for (let index = 0; index < chain.length; index += 1) {
      const event = chain[index];
      const previous = chain[index - 1];
      if (event.sequence !== index + 1) issues.push(issue("SEQUENCE_GAP", "invalid", `${key}:${event.sequence}`));
      if ((index === 0 && event.previousEventDigest !== null) || (previous && event.previousEventDigest !== previous.eventDigest)) issues.push(issue("BROKEN_CHAIN", "invalid", event.eventId));
    }
  }
  for (const writer of expectedWriters) {
    const chain = chains.get(`${writer.writerId}\0${writer.writerEpoch}`) ?? [];
    if (!chain.some((event) => event.eventType === "writer.shutdown")) issues.push(issue("MISSING_TERMINAL", "invalid", `${writer.writerId}:${writer.writerEpoch}`));
  }
  for (const componentId of new Set([...started, ...expectedComponents])) {
    if (!terminal.has(componentId)) issues.push(issue("MISSING_TERMINAL", "invalid", componentId));
  }
  if (attemptNs > 0n && Number(overheadNs) / Number(attemptNs) > maxObserverOverheadRatio) issues.push(issue("OBSERVER_OVERHEAD", "invalid", `${overheadNs}/${attemptNs}`));
  return Object.freeze({
    status: issues.some((entry) => entry.severity === "invalid") ? "invalid" : issues.length ? "degraded" : "healthy",
    issues: Object.freeze(issues),
    clockDurationsReliable: !issues.some((entry) => entry.code === "CLOCK_UNCERTAINTY"),
  });
}

function sameAttempt(event, expected) {
  return event.experimentId === expected.experimentId && event.runId === expected.runId && event.runGeneration === expected.runGeneration && event.taskId === expected.taskId && event.trialId === expected.trialId && event.rootTrialId === expected.rootTrialId && event.attempt === expected.attempt;
}

export async function verifyAttemptEvidence({
  events, artifactManifests = [], artifactStore, provenance, expected, streamContracts,
  expectedWriters = [], expectedComponents = [], expectedTaskWebMembers = [], rateTable = null,
  verifierPrincipal, healthPolicy = {},
}) {
  if (!Array.isArray(events) || events.length === 0) evidenceFailure("MISSING_EVIDENCE", "attempt has no events");
  validateProvenanceManifest(provenance);
  if (provenance.experimentId !== expected.experimentId || provenance.runId !== expected.runId || provenance.trialId !== expected.trialId || provenance.attempt !== expected.attempt) evidenceFailure("CROSS_RUN_EVIDENCE", "provenance belongs to another attempt");
  const eventIds = new Set();
  const eventDigests = new Set();
  for (const event of events) {
    validateEvidenceEvent(event, { streamContracts });
    if (!sameAttempt(event, expected)) evidenceFailure("CROSS_RUN_EVIDENCE", "event belongs to another attempt");
    if (eventIds.has(event.eventId) || eventDigests.has(event.eventDigest)) evidenceFailure("DUPLICATE_EVIDENCE", "attempt contains duplicate evidence");
    eventIds.add(event.eventId);
    eventDigests.add(event.eventDigest);
  }

  const manifestsById = new Map();
  for (const manifest of artifactManifests) {
    if (manifestsById.has(manifest.artifactId)) evidenceFailure("DUPLICATE_EVIDENCE", "attempt contains duplicate artifact manifests");
    if (manifest.experimentId !== expected.experimentId || manifest.runId !== expected.runId || manifest.trialId !== expected.trialId || manifest.attempt !== expected.attempt) evidenceFailure("CROSS_RUN_EVIDENCE", "artifact belongs to another attempt");
    if (!eventIds.has(manifest.producerEventId)) evidenceFailure("MISSING_EVIDENCE", "artifact producer event is missing");
    if (manifest.classification !== "public" && !manifest.access.readers.includes(verifierPrincipal)) evidenceFailure("UNAUTHORIZED_ARTIFACT", "verifier is not authorized for an evidence artifact");
    await artifactStore.verify(manifest);
    manifestsById.set(manifest.artifactId, manifest);
  }
  for (const event of events.filter((entry) => entry.artifactId !== null)) {
    const manifest = manifestsById.get(event.artifactId);
    if (!manifest) evidenceFailure("MISSING_ARTIFACT", "referenced artifact manifest is missing");
    if (event.payload.manifestDigest && event.payload.manifestDigest !== manifest.manifestDigest) evidenceFailure("ALTERED_ARTIFACT", "event references an incompatible artifact manifest");
  }

  const health = assessEvidenceHealth(events, { expectedWriters, expectedComponents, ...healthPolicy });
  if (health.status === "invalid") evidenceFailure("UNHEALTHY_EVIDENCE", "attempt evidence health is invalid", { issues: health.issues });
  const accounting = accountTaskWeb(events, { rateTable, expectedMembers: expectedTaskWebMembers });
  const unsigned = {
    schemaVersion: 1, experimentId: expected.experimentId, runId: expected.runId,
    runGeneration: expected.runGeneration, taskId: expected.taskId, trialId: expected.trialId,
    rootTrialId: expected.rootTrialId, attempt: expected.attempt,
    provenanceDigest: provenance.manifestDigest,
    eventRoot: canonicalDigest([...eventDigests].sort()), eventCount: events.length,
    artifactRoot: canonicalDigest([...artifactManifests.map((entry) => entry.manifestDigest)].sort()),
    artifactCount: artifactManifests.length, accounting, evidenceHealth: health,
    measurementStatus: "complete", telemetryStatus: "complete",
    observerEffectStatus: "within-policy", acceptedForAggregation: true,
  };
  return Object.freeze({ ...unsigned, manifestDigest: canonicalDigest(unsigned) });
}
