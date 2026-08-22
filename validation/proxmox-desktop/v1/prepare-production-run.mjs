import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { DesktopGuiScenarioDriver } from "nelos/desktop-gui-scenario-driver";
import { validateRemoteDesktopScenarioV1 } from "nelos/remote-desktop-contract";
import { preflightRemoteDesktopRunV1 } from "nelos/remote-desktop-runner";
import { validateProductionGuestTaskIntentV1 } from "../../../src/production-guest-task.mjs";
import {
  leaseAuthorityBindingFromObservationV1,
  validateLeaseAuthorityObservationV1,
} from "../../../src/proxmox-lease-authority.mjs";
import {
  prepareProductionAdmissionV1,
  sha256,
  verifyInstalledNelosCandidateV1,
} from "nelos/proxmox-desktop-runtime";

import { assertProxmoxDesktopPackageLockUsableV1 } from "./backend/index.mjs";

const exec = promisify(execFile);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VMID = /^[1-9][0-9]{2,8}$/u;
const MAC_ADDRESS = /^02(?::[0-9A-F]{2}){5}$/u;
const PRODUCTION_PROXMOX_LANE_V1 = Object.freeze({ gatewayId: "9023", hostId: "prox2", networkId: "nelosbld", providerId: "proxmox-lab" });
const MAX_INPUT_BYTES = 1_048_576;
const MAX_SEALED_VALUE_BYTES = 1_048_576;
const INCOMPLETE_NAME = ".nelos-composition.incomplete.json";
const COMPOSITION_NAME = "composition.json";
const USAGE_FIELDS = Object.freeze([
  "taskCount", "modelTurnCount", "spendUsd", "wallTimeMs", "screenshotCount",
  "screenshotBytes", "recordingDurationMs", "recordingBytes",
  "diagnosticLogCount", "diagnosticLogBytes",
]);

export class ProductionRunComposerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProductionRunComposerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionRunComposerError(code, message);
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}

export function canonicalProductionRunBytesV1(value) {
  return Buffer.from(`${JSON.stringify(sortDeep(value))}\n`, "utf8");
}

function digestBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exact(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    fail("INVALID_COMPOSER_INPUT", `${label} fields differ from the closed contract`);
  }
  return value;
}

function identity(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) fail("INVALID_COMPOSER_INPUT", `${label} is invalid`);
  return value;
}

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("INVALID_COMPOSER_INPUT", `${label} is outside its bound`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("INVALID_COMPOSER_INPUT", `${label} must be one millisecond UTC timestamp`);
  }
  return value;
}

function normalizedAbsolute(value, label) {
  if (!isAbsolute(value ?? "") || resolve(value) !== value || value === "/" || value.includes("\0")) {
    fail("UNSAFE_COMPOSER_PATH", `${label} must be one normalized non-root absolute path`);
  }
  return value;
}

function equal(left, right) {
  return canonicalProductionRunBytesV1(left).equals(canonicalProductionRunBytesV1(right));
}

async function sealedJson(path, label, maximum = MAX_INPUT_BYTES) {
  normalizedAbsolute(path, label);
  let handle; let info; let canonical; let bytes;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    [info, canonical] = await Promise.all([handle.stat({ bigint: true }), realpath(path)]);
  } catch {
    await handle?.close().catch(() => {});
    fail("SEALED_INPUT_UNAVAILABLE", `${label} is unavailable`);
  }
  const uid = BigInt(process.getuid()); const gid = BigInt(process.getgid()); const mode = Number(info.mode & 0o777n);
  if (!info.isFile() || info.nlink !== 1n || canonical !== path || info.uid !== uid || info.gid !== gid ||
      !new Set([0o400, 0o440, 0o600, 0o640]).has(mode) || mode & 0o022 || info.size < 2n || info.size > BigInt(maximum)) {
    await handle.close();
    fail("UNTRUSTED_COMPOSER_INPUT", `${label} ownership, mode, type, link count, path, or size differs`);
  }
  try {
    bytes = await handle.readFile();
    const [after, canonicalAfter] = await Promise.all([handle.stat({ bigint: true }), realpath(path)]);
    if (canonicalAfter !== canonical || after.dev !== info.dev || after.ino !== info.ino || after.mode !== info.mode || after.nlink !== info.nlink ||
        after.uid !== info.uid || after.gid !== info.gid || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs ||
        bytes.length !== Number(info.size)) {
      bytes.fill(0);
      fail("UNTRUSTED_COMPOSER_INPUT", `${label} changed while it was read`);
    }
  } finally {
    await handle.close();
  }
  let value;
  try { value = JSON.parse(bytes); }
  catch { bytes.fill(0); fail("INVALID_COMPOSER_INPUT", `${label} is not JSON`); }
  if (!bytes.equals(canonicalProductionRunBytesV1(value))) {
    bytes.fill(0);
    fail("NONCANONICAL_COMPOSER_INPUT", `${label} is not canonically encoded`);
  }
  return { bytes, digest: digestBytes(bytes), path, value };
}

async function trustedOutputParent(outputRoot) {
  normalizedAbsolute(outputRoot, "output root");
  const parent = dirname(outputRoot);
  let info; let canonical;
  try { [info, canonical] = await Promise.all([lstat(parent), realpath(parent)]); }
  catch { fail("UNSAFE_COMPOSER_PATH", "output parent is unavailable"); }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== parent || info.uid !== process.getuid() || info.gid !== process.getgid() || (info.mode & 0o777) !== 0o700) {
    fail("UNSAFE_COMPOSER_PATH", "output parent must be canonical, caller-owned, and mode 0700");
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(path, bytes, mode = 0o400) {
  let handle;
  try { handle = await open(path, "wx", mode); }
  catch (error) {
    if (error?.code === "EEXIST") fail("COMPOSER_OUTPUT_CONFLICT", `output already exists: ${path}`);
    throw error;
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(path, mode);
  await syncDirectory(dirname(path));
}

async function createDirectory(path, mode = 0o700) {
  try { await mkdir(path, { mode }); }
  catch (error) {
    if (error?.code === "EEXIST") fail("COMPOSER_OUTPUT_CONFLICT", `output directory already exists: ${path}`);
    throw error;
  }
  await chmod(path, mode);
}

async function trustedExecutable(path, label) {
  let info; let canonical;
  try { [info, canonical] = await Promise.all([lstat(path), realpath(path)]); }
  catch { fail("CANDIDATE_PREFLIGHT_FAILED", `${label} is unavailable`); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || canonical !== path || (info.mode & 0o111) === 0 || info.mode & 0o022) {
    fail("CANDIDATE_PREFLIGHT_FAILED", `${label} is not one trusted executable`);
  }
}

function assertNoSecretMaterial(value, label) {
  const visit = (item, path) => {
    if (Array.isArray(item)) return item.forEach((entry, index) => visit(entry, `${path}/${index}`));
    if (item !== null && typeof item === "object") {
      for (const [name, entry] of Object.entries(item)) {
        if (/^(?:password|passwd|secret|privateKey|apiToken|cookie|credential|modelResponse|prompt|sealedValue)$/iu.test(name)) {
          fail("FORBIDDEN_SECRET_MATERIAL", `${label}${path}/${name} is a forbidden secret field`);
        }
        visit(entry, `${path}/${name}`);
      }
      return;
    }
    if (typeof item === "string" && /-----BEGIN [A-Z ]*PRIVATE KEY-----|PVEAPIToken\s*=|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|(?:password|secret)\s*[:=]/iu.test(item)) {
      fail("FORBIDDEN_SECRET_MATERIAL", `${label}${path} contains secret-shaped material`);
    }
  };
  visit(value, "");
}

function validateCandidateManifest(value) {
  exact(value, ["candidateDigest", "packageRoot", "provenancePath", "runnerPath", "schemaVersion", "sourceRevision", "sourceRevisionType"], "candidate manifest");
  identity(value.candidateDigest, "candidateDigest", SHA256);
  normalizedAbsolute(value.packageRoot, "candidate packageRoot");
  if (value.schemaVersion !== 1 || value.provenancePath !== join(value.packageRoot, "distribution-provenance.json") || value.runnerPath !== join(value.packageRoot, "bin", "nelos-desktop-runner") ||
      value.sourceRevisionType !== "git" || typeof value.sourceRevision !== "string" || !GIT_COMMIT.test(value.sourceRevision)) {
    fail("CANDIDATE_PREFLIGHT_FAILED", "candidate paths or Git identity differ from the staged candidate contract");
  }
}

function usage(value, label) {
  exact(value, USAGE_FIELDS, label);
  for (const field of USAGE_FIELDS) {
    const number = value[field];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || (field !== "spendUsd" && !Number.isSafeInteger(number))) {
      fail("INVALID_COMPOSER_INPUT", `${label}.${field} is invalid`);
    }
  }
  return structuredClone(value);
}

function validateProviderInput(value) {
  exact(value, ["access", "controller", "provider", "schemaVersion"], "provider input");
  if (value.schemaVersion !== 1) fail("INVALID_COMPOSER_INPUT", "provider schema is unsupported");
  exact(value.provider, ["hostId", "providerId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest"], "provider identity");
  for (const field of ["hostId", "providerId", "networkId"]) identity(value.provider[field], `provider.${field}`);
  identity(value.provider.vmId, "provider.vmId", VMID);
  identity(value.provider.gatewayId, "provider.gatewayId", VMID);
  identity(value.provider.macAddress, "provider.macAddress", MAC_ADDRESS);
  identity(value.provider.networkPolicyDigest, "provider.networkPolicyDigest", SHA256);
  if (value.provider.gatewayId === value.provider.vmId) fail("INVALID_COMPOSER_INPUT", "provider gateway and disposable VM identities must differ");
  if (Object.entries(PRODUCTION_PROXMOX_LANE_V1).some(([field, expected]) => value.provider[field] !== expected)) {
    fail("INVALID_COMPOSER_INPUT", "production provider must use the fixed prox2 gateway VM 9023 and nelosbld VNet identity");
  }
  exact(value.access, ["attestorPublicKey", "providerPublicKey"], "provider access");
  exact(value.controller, ["attestorIdentityFile", "hostFingerprint", "hostPublicKey", "knownHostsFile", "providerIdentityFile", "sshHost", "sshPort"], "provider controller");
  for (const field of ["attestorPublicKey", "providerPublicKey"]) {
    if (typeof value.access[field] !== "string" || value.access[field].length > 4_096 || !value.access[field].startsWith("ssh-ed25519 ") || /[\r\n]/u.test(value.access[field])) {
      fail("INVALID_COMPOSER_INPUT", `provider access ${field} is invalid`);
    }
  }
  for (const field of ["attestorIdentityFile", "knownHostsFile", "providerIdentityFile"]) normalizedAbsolute(value.controller[field], `provider.controller.${field}`);
  if (value.controller.attestorIdentityFile === value.controller.providerIdentityFile || !Number.isSafeInteger(value.controller.sshPort) || value.controller.sshPort < 1 || value.controller.sshPort > 65_535 ||
      typeof value.controller.sshHost !== "string" || value.controller.sshHost.length < 1 || value.controller.sshHost.length > 253 || /[\r\n\0]/u.test(value.controller.sshHost) ||
      typeof value.controller.hostPublicKey !== "string" || !value.controller.hostPublicKey.startsWith("ssh-ed25519 ") || /[\r\n]/u.test(value.controller.hostPublicKey) ||
      typeof value.controller.hostFingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(value.controller.hostFingerprint)) {
    fail("INVALID_COMPOSER_INPUT", "provider controller identity is invalid");
  }
  assertNoSecretMaterial(value, "provider input");
}

function validateLeaseInput(value) {
  try { validateLeaseAuthorityObservationV1(value, { requireIssue: true }); }
  catch (error) { fail(error?.code ?? "INVALID_COMPOSER_INPUT", `independent lease authority rejected the lease input: ${error?.message ?? "invalid observation"}`); }
}

function validateScenarioInput(value) {
  exact(value, ["benchmarkProfile", "scenario", "scenarioManifest", "schemaVersion"], "scenario input");
  if (value.schemaVersion !== 1) fail("INVALID_COMPOSER_INPUT", "scenario input schema is unsupported");
  exact(value.benchmarkProfile, ["digest", "profileId"], "benchmark profile");
  exact(value.scenarioManifest, ["digest", "manifestId"], "scenario manifest");
  identity(value.benchmarkProfile.profileId, "benchmarkProfile.profileId"); identity(value.benchmarkProfile.digest, "benchmarkProfile.digest", SHA256);
  identity(value.scenarioManifest.manifestId, "scenarioManifest.manifestId"); identity(value.scenarioManifest.digest, "scenarioManifest.digest", SHA256);
  validateRemoteDesktopScenarioV1(value.scenario);
  const expectedManifest = sha256({ schemaVersion: 1, scenarios: [value.scenario] });
  if (value.scenarioManifest.digest !== expectedManifest) fail("SCENARIO_MANIFEST_MISMATCH", "scenario manifest digest does not bind the exact scenario");
  assertNoSecretMaterial(value, "scenario input");
}

function validateEvidence(value, scenarioId) {
  exact(value, ["diagnostics", "proposedOperationalUsage", "recordings", "screenshots"], "evidence plan");
  exact(value.proposedOperationalUsage, ["modelTurnCount", "spendUsd", "taskCount", "wallTimeMs"], "evidence proposed usage");
  for (const [field, number] of Object.entries(value.proposedOperationalUsage)) {
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || (field !== "spendUsd" && !Number.isSafeInteger(number))) {
      fail("INVALID_COMPOSER_INPUT", `evidence proposed usage ${field} is invalid`);
    }
  }
  if (!Array.isArray(value.screenshots) || !Array.isArray(value.recordings) || !Array.isArray(value.diagnostics) || value.recordings.length !== 0) {
    fail("INVALID_COMPOSER_INPUT", "production evidence arrays are invalid or request unsupported recording");
  }
  for (const [index, item] of value.screenshots.entries()) {
    exact(item, ["artifactId", "maxOutputBytes", "scenarioId"], `evidence screenshot ${index}`);
    identity(item.artifactId, `evidence screenshot ${index}.artifactId`);
    if (item.scenarioId !== scenarioId) fail("INVALID_COMPOSER_INPUT", "evidence screenshot belongs to another scenario");
    integer(item.maxOutputBytes, `evidence screenshot ${index}.maxOutputBytes`, { minimum: 1, maximum: 16_777_216 });
  }
  for (const [index, item] of value.diagnostics.entries()) {
    exact(item, ["code", "diagnosticId", "scenarioId"], `evidence diagnostic ${index}`);
    identity(item.code, `evidence diagnostic ${index}.code`); identity(item.diagnosticId, `evidence diagnostic ${index}.diagnosticId`);
    if (item.scenarioId !== scenarioId) fail("INVALID_COMPOSER_INPUT", "evidence diagnostic belongs to another scenario");
  }
}

function validateReservationInput(value, scenario) {
  exact(value, [
    "archiveConvergence", "authorizationGateId", "automationUid", "capture", "evidence", "homelab",
    "operationUsage", "packetBudgets", "policy", "reservationId", "runId", "scenarioUsage", "schemaVersion",
  ], "reservation input");
  if (value.schemaVersion !== 1) fail("INVALID_COMPOSER_INPUT", "reservation schema is unsupported");
  for (const field of ["authorizationGateId", "reservationId", "runId"]) identity(value[field], `reservation.${field}`);
  integer(value.automationUid, "reservation.automationUid", { minimum: 1000, maximum: 60_000 });
  exact(value.packetBudgets, ["captureCount", "runDeadlineAt", "stepDeadlineMs"], "packet budgets");
  integer(value.packetBudgets.captureCount, "packetBudgets.captureCount", { minimum: 1, maximum: 100 });
  integer(value.packetBudgets.stepDeadlineMs, "packetBudgets.stepDeadlineMs", { minimum: 1, maximum: 600_000 });
  timestamp(value.packetBudgets.runDeadlineAt, "packetBudgets.runDeadlineAt");
  exact(value.capture, ["height", "protectedRegions", "width"], "capture geometry");
  integer(value.capture.width, "capture.width", { minimum: 640, maximum: 7680 });
  integer(value.capture.height, "capture.height", { minimum: 480, maximum: 4320 });
  if (!Array.isArray(value.capture.protectedRegions)) fail("INVALID_COMPOSER_INPUT", "capture protectedRegions must be an array");
  exact(value.operationUsage, ["cleanup", "provision", "quarantine"], "operation usage");
  for (const name of ["cleanup", "provision", "quarantine"]) usage(value.operationUsage[name], `operationUsage.${name}`);
  usage(value.scenarioUsage, "scenarioUsage");
  exact(value.homelab, ["deadlines", "guiBindings", "outputLimits"], "homelab input");
  exact(value.homelab.deadlines, ["archiveMs", "providerMs", "qgaMs"], "homelab deadlines");
  exact(value.homelab.outputLimits, ["archiveReportBytes", "providerBytes", "qgaBytes"], "homelab output limits");
  for (const [field, maximum] of Object.entries({ providerMs: 300_000, qgaMs: 120_000, archiveMs: 3_600_000 })) {
    integer(value.homelab.deadlines[field], `homelab.deadlines.${field}`, { minimum: 1, maximum });
  }
  for (const [field, maximum] of Object.entries({ providerBytes: 16_777_216, qgaBytes: 16_777_216, archiveReportBytes: 10_485_760 })) {
    integer(value.homelab.outputLimits[field], `homelab.outputLimits.${field}`, { minimum: 1, maximum });
  }
  validateEvidence(value.evidence, scenario.scenarioId);
  if (value.packetBudgets.stepDeadlineMs < Math.max(scenario.deadlineMs, ...scenario.actions.map(({ timeoutMs }) => timeoutMs))) {
    fail("UNDERDECLARED_RUN_PACKET", "packet step deadline underdeclares the scenario");
  }
  const screenshotCheckpoints = scenario.checkpoints.filter(({ type }) => type === "screenshot").length;
  if (value.scenarioUsage.screenshotCount < screenshotCheckpoints || value.packetBudgets.captureCount < value.evidence.screenshots.length + screenshotCheckpoints) {
    fail("UNDERDECLARED_RUN_PACKET", "capture or scenario usage does not cover planned screenshots");
  }
  const refs = new Set(Object.keys(value.homelab.guiBindings ?? {}));
  for (const action of scenario.actions) if (!refs.has(action.targetRef)) fail("INVALID_COMPOSER_INPUT", `GUI binding ${action.targetRef} is absent`);
  for (const assertion of scenario.assertions) {
    if (!refs.has(assertion.targetRef)) fail("INVALID_COMPOSER_INPUT", "assertion target GUI binding is absent");
    if (["task_state", "window_count"].includes(assertion.type) && (assertion.expectedRef === null || !refs.has(assertion.expectedRef))) {
      fail("INVALID_COMPOSER_INPUT", "assertion expected GUI binding is absent");
    }
    if (["element_absent", "element_present"].includes(assertion.type) && assertion.expectedRef !== null) {
      fail("INVALID_COMPOSER_INPUT", "element assertions do not accept an expected reference");
    }
    if (assertion.type === "text_ref_present" && assertion.expectedRef === null) {
      fail("INVALID_COMPOSER_INPUT", "text_ref_present requires an opaque sealed value reference");
    }
  }
  const dummy = new Proxy({}, { get: () => () => null });
  new DesktopGuiScenarioDriver({ boundary: dummy, sealedValueResolver: { resolve() {} }, bindings: value.homelab.guiBindings });
  const submitActions = scenario.actions.filter(({ targetRef, type }) => type === "keypress" && value.homelab.guiBindings[targetRef]?.key === "ENTER");
  if (submitActions.length !== 1) fail("INVALID_COMPOSER_INPUT", "production scenario must contain exactly one bound ENTER model-submit action");
  assertNoSecretMaterial(value, "reservation input");
}

async function candidateIdentity(candidate) {
  validateCandidateManifest(candidate.value);
  const verified = await verifyInstalledNelosCandidateV1(candidate.value.candidateDigest, { packageRoot: candidate.value.packageRoot });
  if (verified.sourceCommit !== candidate.value.sourceRevision || verified.candidateDigest !== candidate.value.candidateDigest) {
    fail("CANDIDATE_PREFLIGHT_FAILED", "installed candidate verification differs from its accepted manifest");
  }
  await trustedExecutable(candidate.value.runnerPath, "candidate Desktop runner");
  const binderPath = join(candidate.value.packageRoot, "validation", "proxmox", "desktop", "helpers", "nelos-proxmox-run-binding.py");
  await trustedExecutable(binderPath, "candidate Proxmox run binder");
  const networkPolicyObserverPath = join(candidate.value.packageRoot, "validation", "proxmox", "desktop", "helpers", "nelos-network-policy-observer.py");
  await trustedExecutable(networkPolicyObserverPath, "candidate gateway network-policy observer");
  const networkPolicyObserverDigest = digestBytes(await readFile(networkPolicyObserverPath));
  const lockPath = join(candidate.value.packageRoot, "validation", "proxmox-desktop", "v1", "package-lock.json");
  let packageLock;
  try { packageLock = JSON.parse(await readFile(lockPath, "utf8")); }
  catch { fail("CANDIDATE_PREFLIGHT_FAILED", "candidate Desktop package lock is unavailable"); }
  assertProxmoxDesktopPackageLockUsableV1(packageLock);
  return { binderPath, networkPolicyObserverDigest, networkPolicyObserverPath, packageLock, verified };
}

async function readInputs(paths) {
  const inputs = {};
  try {
    for (const [name, path] of Object.entries(paths)) {
      inputs[name] = await sealedJson(path, name === "golden" ? "golden receipt" : name === "task" ? "guest task intent" : `${name} input`);
    }
    validateProviderInput(inputs.provider.value);
    validateLeaseInput(inputs.lease.value);
    validateScenarioInput(inputs.scenario.value);
    validateReservationInput(inputs.reservation.value, inputs.scenario.value.scenario);
    for (const [name, input] of Object.entries(inputs)) assertNoSecretMaterial(input.value, `${name} input`);
    return inputs;
  } catch (error) {
    for (const input of Object.values(inputs)) input.bytes.fill(0);
    throw error;
  }
}

function pathsFor(outputRoot, runId, golden, task, packetDigest = null, hostDigest = null) {
  const packetRoot = join(outputRoot, "packet");
  const evidenceRoot = join(outputRoot, "evidence");
  const recoveryRoot = join(outputRoot, "recovery");
  const stagingRoot = join(outputRoot, "staging");
  const operatorRoot = join(outputRoot, "operator");
  return {
    outputRoot,
    packetRoot,
    evidenceRoot,
    recoveryRoot,
    stagingRoot,
    operatorRoot,
    sealedValueRoot: join(stagingRoot, "sealed-values", runId),
    observationRoot: join(stagingRoot, "observations"),
    configPath: join(packetRoot, "run.json"),
    goldenReceiptPath: join(packetRoot, `golden-image-${golden.attestationDigest.slice(7)}.json`),
    taskIntentPath: join(packetRoot, `production-task-intent-${task.digest.slice(7)}.json`),
    runPacketPath: packetDigest === null ? null : join(packetRoot, `run-packet-${packetDigest.slice(7)}.json`),
    hostBindingPath: hostDigest === null ? null : join(operatorRoot, `host-binding-${hostDigest.slice(7)}.json`),
    compositionPath: join(outputRoot, COMPOSITION_NAME),
    incompletePath: join(outputRoot, INCOMPLETE_NAME),
  };
}

function rootRecord(path) {
  return { gid: process.getgid(), mode: "0700", path, sealed: true, uid: process.getuid() };
}

function composeValues({ candidate, golden, task, provider, lease, reservation, scenario, outputRoot, packageLock, networkPolicyObserverDigest }) {
  const runId = reservation.runId;
  const authorityRecord = lease.record;
  const authorityBinding = leaseAuthorityBindingFromObservationV1(lease, { requireIssue: true });
  const leaseValue = {
    expiresAt: authorityRecord.lease.expiresAt,
    fencingToken: authorityRecord.lease.fencingToken,
    holderId: authorityRecord.lease.holderId,
    leaseId: authorityRecord.lease.leaseId,
    state: "active",
  };
  if (basename(outputRoot) !== runId) fail("UNSAFE_COMPOSER_PATH", "output root basename must equal the run ID");
  try { validateProductionGuestTaskIntentV1(task.value); }
  catch { fail("TASK_INTENT_BINDING_MISMATCH", "guest task intent is invalid"); }
  if (task.value.runId !== runId || task.value.fencingToken !== leaseValue.fencingToken ||
      task.value.scenarioId !== scenario.scenario.scenarioId || task.value.taskSlotId !== scenario.scenario.task.taskId ||
      task.value.title !== scenario.scenario.scenarioId || task.value.initialTurnStarted !== false) {
    fail("TASK_INTENT_BINDING_MISMATCH", "guest task intent does not bind the run, fence, scenario, and empty task slot");
  }
  if (golden.value?.goldenImage?.templateVmId !== String(golden.value?.reservation?.outputTemplate?.vmId) ||
      golden.value?.reservation?.node !== provider.provider.hostId || golden.value?.reservation?.providerId !== provider.provider.providerId ||
      golden.value?.immutableInputs?.sourceCommit !== candidate.sourceRevision) {
    fail("GOLDEN_IMAGE_BINDING_MISMATCH", "golden receipt does not bind the candidate, provider, node, and output template");
  }
  if (provider.provider.vmId === golden.value.goldenImage.templateVmId || provider.provider.vmId === String(golden.value.reservation.sourceTemplate.vmId)) {
    fail("VMID_CONFLICT", "disposable VMID conflicts with a golden build template");
  }
  if (authorityRecord.lease.runId !== runId || authorityRecord.resource.providerId !== provider.provider.providerId ||
      authorityRecord.resource.hostId !== provider.provider.hostId || authorityRecord.resource.vmid !== provider.provider.vmId) {
    fail("LEASE_SUPERSEDED", "authoritative lease resource or run identity differs from the reservation");
  }
  if (Date.parse(reservation.packetBudgets.runDeadlineAt) > Date.parse(leaseValue.expiresAt)) fail("STALE_LEASE", "run deadline exceeds the lease");
  const desktop = packageLock.artifacts.chatgptDesktop;
  const desktopBundle = { bundleId: desktop.name, digest: desktop.digest, version: desktop.version };
  const initialPaths = pathsFor(outputRoot, runId, golden.value, task);
  const binding = {
    fencingToken: leaseValue.fencingToken,
    hostId: provider.provider.hostId,
    leaseId: leaseValue.leaseId,
    macAddress: provider.provider.macAddress,
    networkId: provider.provider.networkId,
    gatewayId: provider.provider.gatewayId,
    networkPolicyDigest: provider.provider.networkPolicyDigest,
    providerId: provider.provider.providerId,
    runId,
    vmid: Number(provider.provider.vmId),
  };
  const roots = {
    evidence: rootRecord(initialPaths.evidenceRoot),
    packet: rootRecord(initialPaths.packetRoot),
    recovery: rootRecord(initialPaths.recoveryRoot),
    staging: rootRecord(initialPaths.stagingRoot),
  };
  const run = {
    schemaVersion: 1,
    runId,
    candidate: { digest: candidate.candidateDigest, immutable: true },
    desktopBundle,
    goldenImage: { digest: golden.value.goldenImage.digest, imageId: golden.value.goldenImage.imageId },
    provider: structuredClone(provider.provider),
    lease: structuredClone(leaseValue),
    benchmarkProfile: structuredClone(scenario.benchmarkProfile),
    scenarioManifest: structuredClone(scenario.scenarioManifest),
    policy: structuredClone(reservation.policy),
    scenarios: [structuredClone(scenario.scenario)],
    state: "draft",
  };
  const plan = {
    goldenImageTemplateVmId: golden.value.goldenImage.templateVmId,
    reservation: {
      reservationId: reservation.reservationId,
      ...structuredClone(provider.provider),
      leaseId: leaseValue.leaseId,
      fencingToken: leaseValue.fencingToken,
      state: "reserved",
    },
    automation: {
      user: "nelosauto",
      uid: reservation.automationUid,
      home: "/home/nelosauto",
      stateRoot: `/var/lib/nelos-desktop/runs/${runId}`,
      credentialRefs: [],
    },
    operationUsage: structuredClone(reservation.operationUsage),
    scenarioUsage: { [scenario.scenario.scenarioId]: structuredClone(reservation.scenarioUsage) },
    archiveConvergence: structuredClone(reservation.archiveConvergence),
    evidence: {
      bundleDirectory: join(initialPaths.evidenceRoot, "bundle"),
      ...structuredClone(reservation.evidence),
    },
  };
  const packet = {
    authorization: { gateId: reservation.authorizationGateId, runId, used: false },
    binding,
    budgets: structuredClone(reservation.packetBudgets),
    capture: structuredClone(reservation.capture),
    expectedTask: {
      intentDigest: task.digest,
      intentPath: initialPaths.taskIntentPath,
      taskSlotId: task.value.taskSlotId,
      title: task.value.title,
    },
    goldenImageReceipt: { attestationDigest: golden.value.attestationDigest, path: initialPaths.goldenReceiptPath },
    leaseAuthority: structuredClone(authorityBinding),
    lease: {
      active: true,
      binding,
      expiresAt: leaseValue.expiresAt,
      observedAt: lease.observedAt,
    },
    roots,
    schemaVersion: 1,
  };
  const runPacket = { digest: sha256(packet), packet };
  const finalPaths = pathsFor(outputRoot, runId, golden.value, task, runPacket.digest);
  const valueRefs = [
    ...scenario.scenario.actions.filter(({ type }) => type === "type_text_ref").map(({ valueRef }) => valueRef),
    ...scenario.scenario.assertions.filter(({ type }) => type === "text_ref_present").map(({ expectedRef }) => expectedRef),
  ];
  if (new Set(valueRefs).size !== valueRefs.length) fail("INVALID_COMPOSER_INPUT", "production sealed value references must be unique one-shot identities");
  const sealedValueRequirements = {
    includedInComposition: false,
    root: finalPaths.sealedValueRoot,
    values: valueRefs.sort().map((valueRef) => ({
      gid: process.getgid(),
      maximumBytes: MAX_SEALED_VALUE_BYTES,
      minimumBytes: 1,
      mode: "0400",
      path: join(finalPaths.sealedValueRoot, `${valueRef}.sealed`),
      uid: process.getuid(),
      valueRef,
    })),
  };
  const config = {
    candidateDigest: candidate.candidateDigest,
    currentLease: { ...structuredClone(leaseValue), ...structuredClone(provider.provider) },
    homelab: {
      schemaVersion: 1,
      stateRoot: outputRoot,
      sealedValueRoot: finalPaths.sealedValueRoot,
      observationRoot: finalPaths.observationRoot,
      guiBindings: structuredClone(reservation.homelab.guiBindings),
      deadlines: structuredClone(reservation.homelab.deadlines),
      outputLimits: structuredClone(reservation.homelab.outputLimits),
    },
    journalDirectory: join(outputRoot, "journal"),
    leaseAuthority: structuredClone(lease),
    plan,
    run,
    runPacket,
    runtimeModule: "nelos/homelab-desktop-runtime",
  };
  const hostBinding = {
    access: structuredClone(provider.access),
    controller: structuredClone(provider.controller),
    kind: "nelos.proxmox-desktop.host-run-binding.v1",
    leaseAuthority: structuredClone(authorityBinding),
    provider: {
      gatewayId: provider.provider.gatewayId,
      hostId: provider.provider.hostId,
      networkId: provider.provider.networkId,
      networkPolicyDigest: provider.provider.networkPolicyDigest,
      networkPolicyObserverDigest,
      providerId: provider.provider.providerId,
      sourceTemplateVmId: golden.value.goldenImage.templateVmId,
    },
    runBinding: {
      automationUser: "nelosauto",
      fencingToken: leaseValue.fencingToken,
      hostId: provider.provider.hostId,
      imageId: golden.value.goldenImage.imageId,
      leaseId: leaseValue.leaseId,
      macAddress: provider.provider.macAddress,
      networkId: provider.provider.networkId,
      gatewayId: provider.provider.gatewayId,
      networkPolicyDigest: provider.provider.networkPolicyDigest,
      providerId: provider.provider.providerId,
      runId,
      stateRoot: `/var/lib/nelos-desktop/runs/${runId}`,
      vmId: provider.provider.vmId,
    },
    schemaVersion: 1,
  };
  const hostBytes = canonicalProductionRunBytesV1(hostBinding);
  const hostDigest = digestBytes(hostBytes);
  return { config, finalPaths: { ...finalPaths, hostBindingPath: pathsFor(outputRoot, runId, golden.value, task, runPacket.digest, hostDigest).hostBindingPath }, hostBinding, hostBytes, hostDigest, runPacket, sealedValueRequirements };
}

async function runBinderPreflight(binderPath, hostBindingPath, expectedDigest, sourceTemplateVmId) {
  let stdout;
  try {
    ({ stdout } = await exec("/usr/bin/python3", [binderPath, "render", "--packet", hostBindingPath], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      maxBuffer: 1_048_576,
      timeout: 30_000,
    }));
  } catch {
    fail("HOST_BINDING_PREFLIGHT_FAILED", "candidate host binder rejected the immutable host packet");
  }
  let plan;
  try { plan = JSON.parse(stdout); }
  catch { fail("HOST_BINDING_PREFLIGHT_FAILED", "candidate host binder returned invalid JSON"); }
  if (stdout !== canonicalProductionRunBytesV1(plan).toString("utf8") || plan.packetSha256 !== expectedDigest ||
      plan.controllerEnvironment?.NELOS_PROXMOX_SOURCE_TEMPLATE_VM_ID !== sourceTemplateVmId ||
      plan.controllerEnvironment?.NELOS_PROXMOX_ATTEST_SOURCE_TEMPLATE_VM_ID !== sourceTemplateVmId) {
    fail("HOST_BINDING_PREFLIGHT_FAILED", "host binder plan differs from the composed source-template identity");
  }
  return { digest: digestBytes(Buffer.from(stdout)) };
}

async function runCandidateRunnerPreflight(runnerPath, configPath) {
  let stdout; let stderr;
  try {
    ({ stdout, stderr } = await exec(process.execPath, [runnerPath, "preflight", "--config", configPath], {
      encoding: "utf8",
      env: { HOME: "/var/empty", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 1_048_576,
      timeout: 60_000,
    }));
  } catch {
    fail("RUNNER_PREFLIGHT_FAILED", "candidate Desktop runner rejected the composed run");
  }
  let result;
  try { result = JSON.parse(stdout); }
  catch { fail("RUNNER_PREFLIGHT_FAILED", "candidate Desktop runner returned invalid JSON"); }
  exact(result, ["dryRun", "identityDigest", "ok", "packetDigest", "projectedUsage"], "candidate runner preflight");
  if (stderr !== "" || result.ok !== true || result.dryRun !== false || !SHA256.test(result.identityDigest ?? "") || !SHA256.test(result.packetDigest ?? "")) {
    fail("RUNNER_PREFLIGHT_FAILED", "candidate Desktop runner returned an invalid preflight receipt");
  }
  usage(result.projectedUsage, "candidate runner projectedUsage");
  return { digest: digestBytes(canonicalProductionRunBytesV1(result)), result };
}

async function crossPreflight({ candidate, candidateIdentity: identityValue, values, now }) {
  const admission = await prepareProductionAdmissionV1(values.config, {
    candidateRoot: candidate.packageRoot,
    configPath: values.finalPaths.configPath,
    mode: "preflight",
    now,
  });
  const runner = preflightRemoteDesktopRunV1({
    run: values.config.run,
    plan: values.config.plan,
    candidateDigest: values.config.candidateDigest,
    currentLease: values.config.currentLease,
    productionAdmission: admission,
    now,
  });
  const [binder, candidateRunner] = await Promise.all([
    runBinderPreflight(
      identityValue.binderPath,
      values.finalPaths.hostBindingPath,
      values.hostDigest,
      values.hostBinding.provider.sourceTemplateVmId,
    ),
    runCandidateRunnerPreflight(candidate.runnerPath, values.finalPaths.configPath),
  ]);
  if (admission.packetDigest !== values.runPacket.digest || runner.productionAdmission?.packetDigest !== values.runPacket.digest ||
      candidateRunner.result.packetDigest !== values.runPacket.digest || candidateRunner.result.identityDigest !== runner.identityDigest ||
      !equal(candidateRunner.result.projectedUsage, runner.projectedUsage)) {
    fail("RUNNER_PREFLIGHT_FAILED", "runner admission did not retain the composed packet digest");
  }
  const reverified = await verifyInstalledNelosCandidateV1(candidate.candidateDigest, { packageRoot: candidate.packageRoot });
  if (!equal(reverified, identityValue.verified)) fail("CANDIDATE_PREFLIGHT_FAILED", "candidate changed during cross-preflight");
  return {
    binderPlanDigest: binder.digest,
    candidateVerificationReceiptDigest: admission.verificationReceiptDigest,
    identityDigest: runner.identityDigest,
    packetDigest: admission.packetDigest,
    projectedUsage: runner.projectedUsage,
    runnerPreflightDigest: candidateRunner.digest,
  };
}

function inputDigests(inputs) {
  return Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.digest]));
}

function summaryFor({ inputs, values, preflight }) {
  const configBytes = canonicalProductionRunBytesV1(values.config);
  const packetBytes = canonicalProductionRunBytesV1(values.runPacket);
  return {
    schemaVersion: 1,
    kind: "nelos-production-desktop-run-composition",
    outputRoot: values.finalPaths.outputRoot,
    inputDigests: inputDigests(inputs),
    runConfig: { digest: sha256(values.config), fileSha256: digestBytes(configBytes), path: values.finalPaths.configPath },
    runPacket: { digest: values.runPacket.digest, fileSha256: digestBytes(packetBytes), path: values.finalPaths.runPacketPath },
    hostBinding: { digest: values.hostDigest, path: values.finalPaths.hostBindingPath },
    goldenReceipt: { attestationDigest: values.config.runPacket.packet.goldenImageReceipt.attestationDigest, path: values.finalPaths.goldenReceiptPath },
    taskIntent: { digest: values.config.runPacket.packet.expectedTask.intentDigest, path: values.finalPaths.taskIntentPath },
    sealedValues: values.sealedValueRequirements,
    preflight,
  };
}

async function assertFile(path, expectedBytes, mode = 0o400) {
  let handle; let before; let canonical; let bytes;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    [before, canonical] = await Promise.all([handle.stat({ bigint: true }), realpath(path)]);
  } catch {
    await handle?.close().catch(() => {});
    fail("COMPOSER_OUTPUT_TAMPERED", `composed file is unavailable: ${path}`);
  }
  try {
    bytes = await handle.readFile();
    const [after, canonicalAfter] = await Promise.all([handle.stat({ bigint: true }), realpath(path)]);
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid()) || before.gid !== BigInt(process.getgid()) ||
        Number(before.mode & 0o777n) !== mode || canonical !== path || canonicalAfter !== canonical ||
        after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.nlink !== before.nlink ||
        after.uid !== before.uid || after.gid !== before.gid || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs || bytes.length !== Number(before.size) || !bytes.equals(expectedBytes)) {
      fail("COMPOSER_OUTPUT_TAMPERED", `composed file differs: ${path}`);
    }
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

async function assertDirectory(path, expectedNames) {
  let info; let canonical;
  try { [info, canonical] = await Promise.all([lstat(path), realpath(path)]); }
  catch { fail("COMPOSER_OUTPUT_TAMPERED", `composed directory is unavailable: ${path}`); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.gid !== process.getgid() || (info.mode & 0o777) !== 0o700 || canonical !== path) {
    fail("COMPOSER_OUTPUT_TAMPERED", `composed directory differs: ${path}`);
  }
  const names = (await readdir(path)).sort();
  if (names.join("\0") !== [...expectedNames].sort().join("\0")) fail("COMPOSER_OUTPUT_TAMPERED", `composed directory inventory differs: ${path}`);
}

async function assertSealedValues(requirements, { required }) {
  const names = (await readdir(requirements.root)).sort();
  await assertDirectory(requirements.root, names);
  if (names.length === 0) {
    if (required && requirements.values.length > 0) fail("SEALED_VALUES_NOT_READY", "required one-shot sealed values have not been staged");
    return;
  }
  const expectedNames = requirements.values.map(({ path }) => basename(path)).sort();
  if (names.join("\0") !== expectedNames.join("\0")) fail("COMPOSER_OUTPUT_TAMPERED", "sealed value inventory is partial or contains an unexpected entry");
  for (const expected of requirements.values) {
    let before; let canonical; let after;
    try {
      before = await lstat(expected.path, { bigint: true });
      canonical = await realpath(expected.path);
      after = await lstat(expected.path, { bigint: true });
    }
    catch { fail("COMPOSER_OUTPUT_TAMPERED", `sealed value metadata is unavailable: ${expected.valueRef}`); }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(expected.uid) || before.gid !== BigInt(expected.gid) ||
        Number(before.mode & 0o777n) !== 0o400 || before.size < BigInt(expected.minimumBytes) || before.size > BigInt(expected.maximumBytes) ||
        canonical !== expected.path || after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.nlink !== before.nlink ||
        after.uid !== before.uid || after.gid !== before.gid || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail("COMPOSER_OUTPUT_TAMPERED", `sealed value metadata differs: ${expected.valueRef}`);
    }
  }
  if ((await readdir(requirements.root)).sort().join("\0") !== expectedNames.join("\0")) {
    fail("COMPOSER_OUTPUT_TAMPERED", "sealed value inventory changed while its metadata was checked");
  }
}

async function verifyExisting({ inputs, candidateIdentity: identityValue, values, now, requireSealedValues }) {
  const paths = values.finalPaths;
  const summaryInput = await sealedJson(paths.compositionPath, "composition receipt");
  try {
    const expectedFiles = {
      [paths.configPath]: canonicalProductionRunBytesV1(values.config),
      [paths.runPacketPath]: canonicalProductionRunBytesV1(values.runPacket),
      [paths.hostBindingPath]: values.hostBytes,
      [paths.goldenReceiptPath]: inputs.golden.bytes,
      [paths.taskIntentPath]: inputs.task.bytes,
    };
    await Promise.all(Object.entries(expectedFiles).map(([path, bytes]) => assertFile(path, bytes)));
    await assertDirectory(paths.outputRoot, [COMPOSITION_NAME, "evidence", "operator", "packet", "recovery", "staging"]);
    await assertDirectory(paths.evidenceRoot, []);
    await assertDirectory(paths.recoveryRoot, []);
    await assertDirectory(paths.operatorRoot, [basename(paths.hostBindingPath)]);
    await assertDirectory(paths.packetRoot, [basename(paths.configPath), basename(paths.runPacketPath), basename(paths.goldenReceiptPath), basename(paths.taskIntentPath)]);
    await assertDirectory(paths.stagingRoot, ["observations", "sealed-values"]);
    await assertDirectory(paths.observationRoot, []);
    await assertDirectory(dirname(paths.sealedValueRoot), [basename(paths.sealedValueRoot)]);
    await assertSealedValues(values.sealedValueRequirements, { required: requireSealedValues });
    const preflight = await crossPreflight({ candidate: inputs.candidate.value, candidateIdentity: identityValue, values, now });
    const expected = summaryFor({ inputs, values, preflight });
    if (!equal(summaryInput.value, expected)) fail("COMPOSER_OUTPUT_TAMPERED", "composition receipt differs from the exact current inputs and preflights");
    await assertFile(paths.compositionPath, canonicalProductionRunBytesV1(expected));
    return expected;
  } finally {
    summaryInput.bytes.fill(0);
  }
}

async function createOutput({ inputs, candidateIdentity: identityValue, values, now }) {
  const paths = values.finalPaths;
  const marker = canonicalProductionRunBytesV1({ schemaVersion: 1, type: "nelos-production-run-composition-incomplete", runId: values.config.run.runId });
  let created = false;
  try {
    await createDirectory(paths.outputRoot); created = true;
    await writeExclusive(paths.incompletePath, marker);
    for (const path of [paths.packetRoot, paths.evidenceRoot, paths.recoveryRoot, paths.stagingRoot, paths.operatorRoot]) await createDirectory(path);
    await createDirectory(join(paths.stagingRoot, "sealed-values"));
    await createDirectory(paths.sealedValueRoot);
    await createDirectory(paths.observationRoot);
    await writeExclusive(paths.goldenReceiptPath, inputs.golden.bytes);
    await writeExclusive(paths.taskIntentPath, inputs.task.bytes);
    await writeExclusive(paths.runPacketPath, canonicalProductionRunBytesV1(values.runPacket));
    await writeExclusive(paths.hostBindingPath, values.hostBytes);
    await writeExclusive(paths.configPath, canonicalProductionRunBytesV1(values.config));
    const preflight = await crossPreflight({ candidate: inputs.candidate.value, candidateIdentity: identityValue, values, now });
    const summary = summaryFor({ inputs, values, preflight });
    await writeExclusive(paths.compositionPath, canonicalProductionRunBytesV1(summary));
    await unlink(paths.incompletePath);
    await syncDirectory(paths.outputRoot);
    return summary;
  } catch (error) {
    if (created) {
      try {
        const observed = await readFile(paths.incompletePath);
        const info = await lstat(paths.incompletePath);
        const rootInfo = await lstat(paths.outputRoot);
        if (observed.equals(marker) && info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid() &&
            rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && rootInfo.uid === process.getuid() && dirname(paths.outputRoot) !== paths.outputRoot) {
          await rm(paths.outputRoot, { recursive: true });
        }
      } catch {
        // Preserve an unverifiable partial root for explicit operator inspection.
      }
    }
    throw error;
  }
}

export async function prepareProductionDesktopRunV1({
  candidatePath,
  goldenReceiptPath,
  taskIntentPath,
  providerPath,
  leasePath,
  reservationPath,
  scenarioPath,
  outputRoot,
  requireSealedValues = false,
  now = Date.now(),
}) {
  integer(now, "composition clock", { minimum: 0 });
  if (typeof requireSealedValues !== "boolean") fail("INVALID_COMPOSER_INPUT", "requireSealedValues must be boolean");
  await trustedOutputParent(outputRoot);
  const inputs = await readInputs({
    candidate: candidatePath,
    golden: goldenReceiptPath,
    lease: leasePath,
    provider: providerPath,
    reservation: reservationPath,
    scenario: scenarioPath,
    task: taskIntentPath,
  });
  try {
    const identityValue = await candidateIdentity(inputs.candidate);
    const reservation = inputs.reservation.value;
    integer(reservation.policy?.maxWallTimeMs, "reservation.policy.maxWallTimeMs", { minimum: 1 });
    try {
      validateLeaseAuthorityObservationV1(inputs.lease.value, {
        maxObservationAgeMs: 30_000,
        now,
        marginMs: reservation.policy.maxWallTimeMs,
        requireIssue: true,
        requireState: "active",
      });
    } catch (error) {
      fail(error?.code ?? "STALE_LEASE", `authoritative lease observation or worst-case run coverage is stale: ${error?.message ?? "invalid authority record"}`);
    }
    const values = composeValues({
      candidate: inputs.candidate.value,
      golden: inputs.golden,
      task: inputs.task,
      provider: inputs.provider.value,
      lease: inputs.lease.value,
      reservation,
      scenario: inputs.scenario.value,
      outputRoot,
      packageLock: identityValue.packageLock,
      networkPolicyObserverDigest: identityValue.networkPolicyObserverDigest,
    });
    preflightRemoteDesktopRunV1({
      run: values.config.run,
      plan: values.config.plan,
      candidateDigest: values.config.candidateDigest,
      currentLease: values.config.currentLease,
      now,
    });
    let exists = false;
    try { await lstat(outputRoot); exists = true; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (!exists && requireSealedValues) fail("SEALED_VALUES_NOT_READY", "compose the run before requiring staged sealed values");
    const result = exists
      ? await verifyExisting({ inputs, candidateIdentity: identityValue, values, now, requireSealedValues })
      : await createOutput({ inputs, candidateIdentity: identityValue, values, now });
    return Object.freeze(structuredClone(result));
  } finally {
    for (const input of Object.values(inputs)) input.bytes.fill(0);
  }
}
