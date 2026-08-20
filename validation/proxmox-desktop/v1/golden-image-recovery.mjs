import { randomBytes } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  canonicalJsonV1,
  createGoldenImageAttestationV1,
  goldenOwnershipV1,
  parsePackerArtifactV1,
  proveExactBuildOwnershipV1,
  sha256V1,
  validateGoldenImageOutputV1,
  validateGoldenImageReservationV1,
  validateVolumeMeasurementV1,
} from "./build-golden-image.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UPID = /^UPID:[A-Za-z0-9:._@!+-]{1,507}$/u;
const ALLOWED_PHASES = new Set([
  "admitted", "preflighted", "mutation-started", "packer-exited", "attested", "committed",
  "cleanup-admitted", "cleaned", "quarantined", "reconciliation-required", "retry-admitted",
]);
const BUILD_TASK_TYPES = new Set(["qmclone", "qmconfig", "qmcreate", "qmstart", "qmstop", "qmtemplate"]);
const CLEANUP_TASK_TYPES = new Set(["qmdestroy", "qmstop"]);

export class GoldenImageRecoveryError extends Error {
  constructor(code, message, details = null) { super(message); this.name = "GoldenImageRecoveryError"; this.code = code; this.details = details; }
}

function fail(code, message, details = null) { throw new GoldenImageRecoveryError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${label} fields differ from the closed contract`);
  return value;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function privateStateRoot(path, expectedUid) {
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") fail("UNSAFE_JOURNAL", "golden recovery state root must be a specific absolute path");
  const canonical = await realpath(path).catch(() => null); const info = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || canonical !== path || !info?.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid || (info.mode & 0o777) !== 0o700) {
    fail("UNSAFE_JOURNAL", "golden recovery state root must be caller-owned mode 0700");
  }
  return canonical;
}

async function writeAtomic(path, bytes, root) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 262_144 || !path.startsWith(`${root}/`)) fail("UNSAFE_JOURNAL", "golden recovery journal bytes or path are invalid");
  const temporary = join(root, `.${randomBytes(16).toString("hex")}.journal.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(0o600); } finally { await handle.close(); }
  try { await rename(temporary, path); await syncDirectory(root); } finally { await unlink(temporary).catch(() => {}); }
}

function journalKey(reservation) { return sha256V1({ providerId: reservation.providerId, reservationId: reservation.reservationId }).slice(7); }

function validateJournalDocument(value, reservation) {
  exact(value, ["entries", "outputVmId", "providerId", "reservationId", "schemaVersion"], "golden recovery journal");
  if (value.schemaVersion !== 1 || value.reservationId !== reservation.reservationId || value.providerId !== reservation.providerId ||
      value.outputVmId !== reservation.outputTemplate.vmId || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 128) {
    fail("INVALID_JOURNAL", "golden recovery journal identity or bounds differ");
  }
  let previousDigest = null;
  for (const [index, entry] of value.entries.entries()) {
    exact(entry, ["details", "digest", "outputVmId", "ownership", "phase", "previousDigest", "providerId", "recordedAt", "reservationId", "schemaVersion", "sequence"], `golden recovery journal entry ${index}`);
    const { digest, ...unsigned } = entry;
    if (entry.schemaVersion !== 1 || entry.sequence !== index + 1 || entry.phase === undefined || !ALLOWED_PHASES.has(entry.phase) ||
        entry.previousDigest !== previousDigest || entry.reservationId !== reservation.reservationId || entry.providerId !== reservation.providerId ||
        entry.outputVmId !== reservation.outputTemplate.vmId || entry.ownership !== goldenOwnershipV1(reservation) || !plain(entry.details) ||
        !Number.isFinite(Date.parse(entry.recordedAt)) || digest !== sha256V1(unsigned)) fail("INVALID_JOURNAL", "golden recovery journal chain or entry differs");
    if (/(?:password|privateKey|secretValue|tokenValue)/iu.test(canonicalJsonV1(entry.details))) fail("INVALID_JOURNAL", "golden recovery journal contains a forbidden secret-shaped field");
    previousDigest = digest;
  }
  if (value.entries[0].phase !== "admitted") fail("INVALID_JOURNAL", "golden recovery journal does not begin with admission");
  return value;
}

export async function openGoldenImageJournalV1(rootInput, reservationInput, { clock = Date, expectedUid = process.getuid() } = {}) {
  const reservation = validateGoldenImageReservationV1(reservationInput, { now: clock.now(), allowExpiredForCleanup: true });
  if (typeof clock?.now !== "function" || !Number.isSafeInteger(expectedUid) || expectedUid < 0) fail("INVALID_ADAPTER", "golden recovery journal boundary is invalid");
  const root = await privateStateRoot(rootInput, expectedUid); const path = join(root, `${journalKey(reservation)}.journal.json`);
  let entries = []; let mode = "created";
  const info = await lstat(path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (info) {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== expectedUid || (info.mode & 0o777) !== 0o600 || await realpath(path) !== path || info.size < 2 || info.size > 262_144) {
      fail("UNSAFE_JOURNAL", "existing golden recovery journal metadata differs");
    }
    const bytes = await readFile(path); let parsed;
    try { parsed = JSON.parse(bytes); } catch { fail("INVALID_JOURNAL", "existing golden recovery journal is not JSON"); }
    if (!bytes.equals(Buffer.from(`${canonicalJsonV1(parsed)}\n`))) fail("INVALID_JOURNAL", "existing golden recovery journal is not canonical");
    entries = validateJournalDocument(parsed, reservation).entries;
    mode = "adopted";
  }
  let queue = Promise.resolve();
  const journal = {
    path,
    mode,
    get entries() { return structuredClone(entries); },
    get attempt() { return 1 + entries.filter(({ phase }) => phase === "retry-admitted").length; },
    async record(phase, details) {
      queue = queue.then(async () => {
        if (!ALLOWED_PHASES.has(phase) || !plain(details) || entries.length >= 128) fail("INVALID_JOURNAL", "golden recovery journal phase, details, or bound differs");
        const previousDigest = entries.at(-1)?.digest ?? null;
        const unsigned = {
          schemaVersion: 1,
          sequence: entries.length + 1,
          phase,
          previousDigest,
          reservationId: reservation.reservationId,
          providerId: reservation.providerId,
          outputVmId: reservation.outputTemplate.vmId,
          ownership: goldenOwnershipV1(reservation),
          recordedAt: new Date(clock.now()).toISOString(),
          details,
        };
        const entry = { ...unsigned, digest: sha256V1(unsigned) };
        const next = {
          schemaVersion: 1,
          reservationId: reservation.reservationId,
          providerId: reservation.providerId,
          outputVmId: reservation.outputTemplate.vmId,
          entries: [...entries, entry],
        };
        const bytes = Buffer.from(`${canonicalJsonV1(next)}\n`);
        await writeAtomic(path, bytes, root);
        entries = next.entries;
      });
      await queue;
    },
  };
  if (mode === "created") await journal.record("admitted", { sourceCommit: reservation.sourceCommit });
  return journal;
}

export function validateGoldenBuildTaskObservationV1(value, { reservation, startedAt }) {
  exact(value, ["complete", "digest", "query", "tasks"], "golden provider-task observation");
  exact(value.query, ["startedAt", "user", "vmId"], "golden provider-task query");
  if (value.complete !== true || value.query.startedAt !== startedAt || value.query.user !== reservation.buildTokenId || value.query.vmId !== reservation.outputTemplate.vmId ||
      !Array.isArray(value.tasks) || value.tasks.length > 100 || !SHA256.test(value.digest ?? "")) fail("PROVIDER_TASK_OBSERVATION_INVALID", "golden provider-task observation is incomplete or misbound");
  const start = Date.parse(startedAt); const seen = new Set();
  for (const [index, task] of value.tasks.entries()) {
    exact(task, ["endedAt", "exitStatus", "node", "startedAt", "status", "type", "upid", "user", "vmId"], `golden provider task ${index}`);
    const taskStart = Date.parse(task.startedAt); const taskEnd = task.endedAt === null ? null : Date.parse(task.endedAt);
    if (!UPID.test(task.upid ?? "") || seen.has(task.upid) || task.node !== reservation.node || task.user !== reservation.buildTokenId || task.vmId !== reservation.outputTemplate.vmId ||
        !new Set([...BUILD_TASK_TYPES, ...CLEANUP_TASK_TYPES]).has(task.type) || !new Set(["running", "stopped"]).has(task.status) ||
        !Number.isFinite(taskStart) || taskStart < start - 1_000 || (task.status === "running" ? task.endedAt !== null || task.exitStatus !== null : !Number.isFinite(taskEnd) || typeof task.exitStatus !== "string")) {
      fail("PROVIDER_TASK_OBSERVATION_INVALID", "golden provider task identity, time, or terminal state differs");
    }
    seen.add(task.upid);
  }
  if (value.tasks.map(({ upid }) => upid).join("\0") !== [...value.tasks].map(({ upid }) => upid).sort().join("\0")) fail("PROVIDER_TASK_OBSERVATION_INVALID", "golden provider tasks are not canonically ordered");
  const { digest, ...content } = value;
  if (digest !== sha256V1(content)) fail("PROVIDER_TASK_OBSERVATION_INVALID", "golden provider-task observation digest differs");
  return value;
}

async function observeOutput(api, reservation) {
  const [inventory, storageContent] = await Promise.all([api.inventory(), api.storageContent()]);
  if (!Array.isArray(inventory) || !Array.isArray(storageContent)) fail("OUTPUT_RECOVERY_UNPROVEN", "output inventory or storage observation is malformed");
  const identityMatches = inventory.filter((item) => Number(item?.vmid) === reservation.outputTemplate.vmId || item?.name === reservation.outputTemplate.name);
  const volumes = storageContent.filter((item) => Number(item?.vmid) === reservation.outputTemplate.vmId ||
    (typeof item?.volid === "string" && new RegExp(`(?:^|[:/])(?:base|vm)-${reservation.outputTemplate.vmId}-`, "u").test(item.volid)));
  if (identityMatches.length === 0 && volumes.length === 0) return { state: "absent", snapshot: null, volumeDigest: sha256V1([]) };
  if (identityMatches.length !== 1 || Number(identityMatches[0]?.vmid) !== reservation.outputTemplate.vmId || identityMatches[0]?.name !== reservation.outputTemplate.name ||
      identityMatches[0]?.node !== reservation.node || identityMatches[0]?.type !== "qemu" || volumes.length < 1) {
    return { state: "ambiguous", snapshot: null, volumeDigest: sha256V1(volumes) };
  }
  const [config, status, pending] = await Promise.all([
    api.config(reservation.outputTemplate.vmId), api.status(reservation.outputTemplate.vmId), api.pending(reservation.outputTemplate.vmId),
  ]);
  return { state: "present", snapshot: { inventory: [identityMatches[0]], config, status, pending }, volumeDigest: sha256V1(volumes) };
}

async function independentRecoveryObservation(builderApi, attestorApi, reservation, startedAt) {
  for (const api of [builderApi, attestorApi]) {
    for (const method of ["inventory", "storageContent", "config", "status", "pending", "operationTasks"]) if (typeof api?.[method] !== "function") fail("INVALID_ADAPTER", `recovery API.${method} is unavailable`);
  }
  const [builderTasksRaw, attestorTasksRaw, builderOutput, attestorOutput] = await Promise.all([
    builderApi.operationTasks({ reservation, startedAt }), attestorApi.operationTasks({ reservation, startedAt }),
    observeOutput(builderApi, reservation), observeOutput(attestorApi, reservation),
  ]);
  const builderTasks = validateGoldenBuildTaskObservationV1(builderTasksRaw, { reservation, startedAt });
  const attestorTasks = validateGoldenBuildTaskObservationV1(attestorTasksRaw, { reservation, startedAt });
  if (canonicalJsonV1(builderTasks) !== canonicalJsonV1(attestorTasks)) fail("INDEPENDENT_RECOVERY_MISMATCH", "builder and attestor task histories differ");
  if (canonicalJsonV1(builderOutput) !== canonicalJsonV1(attestorOutput)) fail("INDEPENDENT_RECOVERY_MISMATCH", "builder and attestor output observations differ");
  return { output: builderOutput, tasks: builderTasks, observationDigest: sha256V1({ output: builderOutput, tasks: builderTasks }) };
}

function taskDisposition(observation) {
  if (observation.tasks.length === 0) return { state: "unproven", successfulBuild: false };
  if (observation.tasks.some(({ status }) => status === "running")) return { state: "running", successfulBuild: false };
  const successfulBuild = observation.tasks.some(({ type, status, exitStatus }) => BUILD_TASK_TYPES.has(type) && status === "stopped" && new Set(["OK", "TASK OK"]).has(exitStatus));
  return { state: "terminal", successfulBuild };
}

function proveRecoveredOwnership(output, tasks, reservation) {
  try {
    if (output.state !== "present" || !taskDisposition(tasks).successfulBuild) return false;
    const config = output.snapshot?.config;
    return output.snapshot.inventory.length === 1 && Number(output.snapshot.inventory[0].vmid) === reservation.outputTemplate.vmId &&
      output.snapshot.inventory[0].name === reservation.outputTemplate.name && config?.name === reservation.outputTemplate.name &&
      config?.description === goldenOwnershipV1(reservation) && String(config?.tags ?? "").split(";").includes(`nelos-build-${reservation.buildNonce}`) &&
      String(config?.net0 ?? "").split(",").includes(`virtio=${reservation.outputTemplate.macAddress}`);
  } catch { return false; }
}

function validateReceiptIdentity(receipt, reservation) {
  if (!plain(receipt) || !SHA256.test(receipt.attestationDigest ?? "") || receipt.attestationDigest !== sha256V1(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "attestationDigest"))) ||
      receipt.reservation?.reservationId !== reservation.reservationId || receipt.reservation?.providerId !== reservation.providerId ||
      receipt.reservation?.outputTemplate?.vmId !== reservation.outputTemplate.vmId || receipt.goldenImage?.templateVmId !== String(reservation.outputTemplate.vmId) || !SHA256.test(receipt.goldenImage?.digest ?? "")) {
    fail("INVALID_ATTESTATION", "recoverable golden-image receipt identity or digest differs");
  }
  return receipt;
}

async function attestRecoveredOutput({ reservation, immutableInputs, builderApi, attestorApi, volumeAttestor, receiptStore, journal, recovery, artifact, operationId, attempt, clock, checkpoint }) {
  validateGoldenImageOutputV1(recovery.output.snapshot, reservation);
  if (!proveExactBuildOwnershipV1({ artifact, snapshot: recovery.output.snapshot, reservation })) fail("OUTPUT_RECOVERY_UNPROVEN", "recovered Packer artifact does not own output 9027");
  const [builderSourceConfig, attestorSourceConfig, builderSourceStatus, attestorSourceStatus, builderSourcePending, attestorSourcePending] = await Promise.all([
    builderApi.config(reservation.sourceTemplate.vmId), attestorApi.config(reservation.sourceTemplate.vmId),
    builderApi.status(reservation.sourceTemplate.vmId), attestorApi.status(reservation.sourceTemplate.vmId),
    builderApi.pending(reservation.sourceTemplate.vmId), attestorApi.pending(reservation.sourceTemplate.vmId),
  ]);
  if (canonicalJsonV1(builderSourceConfig) !== canonicalJsonV1(attestorSourceConfig) || sha256V1(builderSourceConfig) !== reservation.sourceTemplate.configDigest ||
      builderSourceStatus?.status !== "stopped" || attestorSourceStatus?.status !== "stopped" ||
      !Array.isArray(builderSourcePending) || !Array.isArray(attestorSourcePending) || builderSourcePending.length !== 0 || attestorSourcePending.length !== 0) {
    fail("SOURCE_RECOVERY_MISMATCH", "source template changed while resuming golden attestation");
  }
  const [sourceMeasurementRaw, outputMeasurementRaw] = await Promise.all([
    volumeAttestor.measure({ role: "source", vmId: reservation.sourceTemplate.vmId, name: reservation.sourceTemplate.name, configDigest: sha256V1(builderSourceConfig) }),
    volumeAttestor.measure({ role: "output", vmId: reservation.outputTemplate.vmId, name: reservation.outputTemplate.name, configDigest: sha256V1(recovery.output.snapshot.config) }),
  ]);
  const sourceMeasurement = validateVolumeMeasurementV1(sourceMeasurementRaw, reservation, { role: "source", config: builderSourceConfig });
  const outputMeasurement = validateVolumeMeasurementV1(outputMeasurementRaw, reservation, { role: "output", config: recovery.output.snapshot.config });
  const receipt = createGoldenImageAttestationV1({
    reservation, immutableInputs, builderOutput: recovery.output.snapshot, attestorOutput: recovery.output.snapshot,
    sourceConfig: builderSourceConfig, sourceVolumeMeasurement: sourceMeasurement, outputVolumeMeasurement: outputMeasurement,
    artifact, observedAt: new Date(clock.now()).toISOString(),
  });
  await journal.record("attested", { attempt, operationId, receipt });
  await checkpoint({ phase: "attested", operationId });
  await receiptStore.commit(receipt);
  await checkpoint({ phase: "receipt-committed", operationId });
  await journal.record("committed", { attestationDigest: receipt.attestationDigest, goldenImageDigest: receipt.goldenImage.digest, operationId });
  return { schemaVersion: 1, state: "committed", receipt };
}

async function exactCleanup({ reservation, builderApi, attestorApi, journal, recovery, artifact, operationId, attempt, clock, checkpoint, retryAllowed }) {
  if (!proveRecoveredOwnership(recovery.output, recovery.tasks, reservation)) fail("OUTPUT_RECOVERY_UNPROVEN", "fresh provider task and output identity cannot authorize cleanup");
  await journal.record("cleanup-admitted", { attempt, operationId, observationDigest: recovery.observationDigest, outputConfigDigest: sha256V1(recovery.output.snapshot.config) });
  await checkpoint({ phase: "cleanup-admitted", operationId });
  const cleanupArtifact = artifact ?? {
    target: "desktop.proxmox-clone.desktop", builderId: "proxmox.clone", artifactId: String(reservation.outputTemplate.vmId), machineOutputDigest: recovery.tasks.digest,
  };
  const result = await builderApi.destroyOwned(reservation.outputTemplate.vmId, cleanupArtifact);
  if (!plain(result) || result.destroyed !== true || result.absent !== true || typeof result.providerOperationId !== "string") fail("CLEANUP_UNPROVEN", "recovered output cleanup did not commit exactly");
  await checkpoint({ phase: "cleanup-returned", operationId });
  const [builderAfter, attestorAfter] = await Promise.all([observeOutput(builderApi, reservation), observeOutput(attestorApi, reservation)]);
  if (canonicalJsonV1(builderAfter) !== canonicalJsonV1(attestorAfter) || builderAfter.state !== "absent") fail("CLEANUP_UNPROVEN", "independent output absence is unproven after recovery cleanup");
  await journal.record("cleaned", { attempt, operationId, providerOperationId: result.providerOperationId, absenceDigest: sha256V1(builderAfter), completedAt: new Date(clock.now()).toISOString() });
  return { schemaVersion: 1, state: "cleaned", retryAllowed };
}

function lastAttemptMutation(entries) {
  const retryIndex = entries.map(({ phase }) => phase).lastIndexOf("retry-admitted");
  return [...entries].slice(retryIndex + 1).reverse().find(({ phase }) => phase === "mutation-started") ?? null;
}

async function admitRetry({ reservation, journal, clock, reason, allowRetry = true }) {
  if (!allowRetry) return { schemaVersion: 1, state: "cleaned", retryAllowed: false };
  try { validateGoldenImageReservationV1(reservation, { now: clock.now() }); }
  catch (error) {
    if (error?.code === "EXPIRED_RESERVATION") return { schemaVersion: 1, state: "cleaned", retryAllowed: false };
    throw error;
  }
  await journal.record("retry-admitted", { previousAttempt: journal.attempt, reason });
  return { schemaVersion: 1, state: "retry-admitted", retryAllowed: true };
}

export async function reconcileGoldenImageBuildV1({
  reservation: reservationInput, immutableInputs, builderApi, attestorApi, volumeAttestor, packer, receiptStore, journal, clock = Date,
}, { checkpoint = async () => {}, cleanupOnly: requestedCleanupOnly = false } = {}) {
  const reservation = validateGoldenImageReservationV1(reservationInput, { now: clock.now(), allowExpiredForCleanup: true });
  if (typeof requestedCleanupOnly !== "boolean" || !plain(journal) || !Array.isArray(journal.entries) || typeof journal.record !== "function" || typeof checkpoint !== "function" ||
      typeof packer?.recover !== "function" || typeof receiptStore?.commit !== "function" || typeof receiptStore?.read !== "function" || typeof volumeAttestor?.measure !== "function") {
    fail("INVALID_ADAPTER", "golden recovery boundaries are incomplete");
  }
  const entries = journal.entries; const last = entries.at(-1);
  if (!last) fail("INVALID_JOURNAL", "golden recovery journal is empty");
  if (last.phase === "committed") {
    const receipt = validateReceiptIdentity(await receiptStore.read(last.details.attestationDigest), reservation);
    return { schemaVersion: 1, state: "committed", receipt };
  }
  if (last.phase === "attested") {
    const receipt = validateReceiptIdentity(last.details.receipt, reservation);
    const mutation = lastAttemptMutation(entries);
    if (!mutation || mutation.details.operationId !== last.details.operationId || !Number.isFinite(Date.parse(mutation.details.startedAt))) fail("INVALID_JOURNAL", "attested recovery lacks its exact mutation identity");
    const recovery = await independentRecoveryObservation(builderApi, attestorApi, reservation, mutation.details.startedAt);
    const stableConfig = recovery.output.state === "present" ? Object.fromEntries(Object.entries(recovery.output.snapshot.config).filter(([key]) => key !== "digest")) : null;
    if (taskDisposition(recovery.tasks).state !== "terminal" || !proveRecoveredOwnership(recovery.output, recovery.tasks, reservation) ||
        !proveExactBuildOwnershipV1({ artifact: receipt.buildArtifact, snapshot: recovery.output.snapshot, reservation }) ||
        canonicalJsonV1(stableConfig) !== canonicalJsonV1(receipt.output?.config) || canonicalJsonV1(receipt.immutableInputs) !== canonicalJsonV1(immutableInputs)) {
      fail("OUTPUT_RECOVERY_UNPROVEN", "attested output changed before its receipt could be committed");
    }
    const [builderSourceConfig, attestorSourceConfig, sourceMeasurementRaw, outputMeasurementRaw] = await Promise.all([
      builderApi.config(reservation.sourceTemplate.vmId), attestorApi.config(reservation.sourceTemplate.vmId),
      volumeAttestor.measure({ role: "source", vmId: reservation.sourceTemplate.vmId, name: reservation.sourceTemplate.name, configDigest: reservation.sourceTemplate.configDigest }),
      volumeAttestor.measure({ role: "output", vmId: reservation.outputTemplate.vmId, name: reservation.outputTemplate.name, configDigest: sha256V1(recovery.output.snapshot.config) }),
    ]);
    if (canonicalJsonV1(builderSourceConfig) !== canonicalJsonV1(attestorSourceConfig) || sha256V1(builderSourceConfig) !== reservation.sourceTemplate.configDigest) {
      fail("SOURCE_RECOVERY_MISMATCH", "source template changed before the attested receipt could be committed");
    }
    const sourceMeasurement = validateVolumeMeasurementV1(sourceMeasurementRaw, reservation, { role: "source", config: builderSourceConfig });
    const outputMeasurement = validateVolumeMeasurementV1(outputMeasurementRaw, reservation, { role: "output", config: recovery.output.snapshot.config });
    if (sourceMeasurement.contentDigest !== receipt.volumeAttestation?.source?.contentDigest || outputMeasurement.contentDigest !== receipt.volumeAttestation?.output?.contentDigest) {
      fail("OUTPUT_RECOVERY_UNPROVEN", "source or output volume bytes changed before the attested receipt could be committed");
    }
    await receiptStore.commit(receipt); await checkpoint({ phase: "receipt-committed", operationId: last.details.operationId });
    await journal.record("committed", { attestationDigest: receipt.attestationDigest, goldenImageDigest: receipt.goldenImage.digest, operationId: last.details.operationId });
    return { schemaVersion: 1, state: "committed", receipt };
  }
  const cleanupOnly = requestedCleanupOnly || clock.now() >= Date.parse(reservation.expiresAt);
  if (new Set(["admitted", "preflighted", "cleaned"]).has(last.phase)) return admitRetry({ reservation, journal, clock, reason: last.phase, allowRetry: !cleanupOnly });
  if (last.phase === "retry-admitted") return cleanupOnly ? { schemaVersion: 1, state: "cleaned", retryAllowed: false } : { schemaVersion: 1, state: "retry-admitted", retryAllowed: true };

  const mutation = lastAttemptMutation(entries);
  if (!mutation || !SHA256.test(mutation.details?.operationId ?? "") || !Number.isFinite(Date.parse(mutation.details?.startedAt))) {
    fail("INVALID_JOURNAL", "golden recovery journal lacks its exact mutation identity");
  }
  const { operationId, attempt, startedAt } = mutation.details;
  let packerRecord = await packer.recover({ operationId, reservation });
  if (packerRecord?.state === "running") {
    if (!cleanupOnly) {
      throw new GoldenImageRecoveryError("RECOVERY_PENDING", "the exact durable Packer process group is still active; provider task gaps cannot authorize replay", {
        operationId, process: packerRecord.process,
      });
    }
    if (typeof packer.terminate !== "function") {
      if (last.phase !== "quarantined") await journal.record("quarantined", { attempt, operationId, causeCode: "PACKER_TERMINATION_UNAVAILABLE" });
      throw new GoldenImageRecoveryError("PACKER_PROCESS_QUARANTINED", "cleanup-only recovery cannot terminate the exact Packer process group", { operationId });
    }
    const terminated = await packer.terminate({ operationId, reservation });
    if (!plain(terminated) || !new Set(["completed", "terminated"]).has(terminated.state)) {
      if (last.phase !== "quarantined") await journal.record("quarantined", { attempt, operationId, causeCode: "PACKER_TERMINATION_UNPROVEN", terminationState: terminated?.state ?? "invalid" });
      throw new GoldenImageRecoveryError("PACKER_PROCESS_QUARANTINED", "cleanup-only recovery could not prove Packer process-group termination", { operationId, terminationState: terminated?.state ?? "invalid" });
    }
    packerRecord = await packer.recover({ operationId, reservation });
    if (packerRecord?.state === "running") throw new GoldenImageRecoveryError("PACKER_PROCESS_QUARANTINED", "Packer remained active after bounded termination", { operationId });
  }
  if (new Set(["identity-mismatch", "orphaned"]).has(packerRecord?.state)) {
    if (last.phase !== "quarantined") await journal.record("quarantined", { attempt, operationId, causeCode: "PACKER_PROCESS_IDENTITY_UNPROVEN", processState: packerRecord.state });
    throw new GoldenImageRecoveryError("PACKER_PROCESS_QUARANTINED", "Packer PID, start time, or process-group ownership differs; no provider mutation is authorized", { operationId, processState: packerRecord.state });
  }
  if (!new Set(["abandoned", "completed"]).has(packerRecord?.state)) {
    if (last.phase !== "quarantined") await journal.record("quarantined", { attempt, operationId, causeCode: "PACKER_PROCESS_STATE_UNPROVEN", processState: packerRecord?.state ?? "invalid" });
    throw new GoldenImageRecoveryError("PACKER_PROCESS_QUARANTINED", "durable Packer process state is unavailable or unproven", { operationId, processState: packerRecord?.state ?? "invalid" });
  }
  const recovery = await independentRecoveryObservation(builderApi, attestorApi, reservation, startedAt);
  const disposition = taskDisposition(recovery.tasks);
  if (disposition.state === "running") throw new GoldenImageRecoveryError("RECOVERY_PENDING", "the exact provider operation is still active; Packer was not replayed", { operationId, taskObservationDigest: recovery.tasks.digest });
  if (disposition.state === "unproven") {
    if (last.phase !== "quarantined") await journal.record("quarantined", { attempt, operationId, causeCode: "PROVIDER_TASK_HISTORY_UNPROVEN", observationDigest: recovery.observationDigest });
    throw new GoldenImageRecoveryError("OUTPUT_RECOVERY_UNPROVEN", "no complete provider task history can authorize output adoption or deletion", { operationId });
  }
  if (recovery.output.state === "ambiguous") {
    if (last.phase !== "quarantined") await journal.record("quarantined", { attempt, operationId, causeCode: "OUTPUT_IDENTITY_AMBIGUOUS", observationDigest: recovery.observationDigest });
    throw new GoldenImageRecoveryError("OUTPUT_RECOVERY_UNPROVEN", "output 9027 identity is ambiguous and remains quarantined", { operationId });
  }
  if (recovery.output.state === "absent") {
    if (last.phase !== "cleaned") await journal.record("cleaned", { attempt, operationId, providerOperationId: null, absenceDigest: sha256V1(recovery.output), completedAt: new Date(clock.now()).toISOString() });
    return admitRetry({ reservation, journal, clock, reason: "independently-observed-terminal-cleanup", allowRetry: !cleanupOnly });
  }
  let artifact = null;
  if (plain(packerRecord) && packerRecord.state === "completed" && packerRecord.operationId === operationId && Number.isSafeInteger(packerRecord.exitCode) &&
      typeof packerRecord.machineOutput === "string" && packerRecord.machineOutputDigest === sha256V1(packerRecord.machineOutput)) {
    try { artifact = parsePackerArtifactV1(packerRecord.machineOutput, reservation); } catch { artifact = null; }
  }
  let outputValid = false;
  try { outputValid = validateGoldenImageOutputV1(recovery.output.snapshot, reservation) === true; } catch { outputValid = false; }
  if (artifact && packerRecord.exitCode === 0 && disposition.successfulBuild && outputValid) {
    if (!entries.slice(entries.indexOf(mutation)).some(({ phase }) => phase === "packer-exited")) {
      await journal.record("packer-exited", { attempt, operationId, exitCode: 0, artifact, machineOutputDigest: artifact.machineOutputDigest, recovered: true });
    }
    return attestRecoveredOutput({ reservation, immutableInputs, builderApi, attestorApi, volumeAttestor, receiptStore, journal, recovery, artifact, operationId, attempt, clock, checkpoint });
  }
  return exactCleanup({ reservation, builderApi, attestorApi, journal, recovery, artifact, operationId, attempt, clock, checkpoint, retryAllowed: !cleanupOnly && Date.parse(reservation.expiresAt) > clock.now() });
}
