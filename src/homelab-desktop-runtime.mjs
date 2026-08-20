import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ArchiveProjectionLaneV1 } from "./archive-projection-lane.mjs";
import { DesktopGuiScenarioDriver, SealedValueResolver } from "./desktop-gui-scenario-driver/index.mjs";
import { ProducerArchiveSurfaceObserverV1 } from "./production-archive-surface-observer.mjs";
import { ProducerTaskSurfaceObserverV1 } from "./production-task-surface-observer.mjs";
import { createRemoteDesktopEvidenceBundleV1, verifyRemoteDesktopEvidenceBundleV1 } from "./remote-desktop-evidence/index.mjs";
import { AtomicRemoteDesktopJournal, ProxmoxDesktopControllerV1, contentDigest } from "./remote-desktop-runner/index.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { assertCapturePrivacyRgbaV1, capturePrivacyProofV1, protectedCaptureRegionsV1 } from "./protected-capture-proof.mjs";
import { materializeProductionGuestTaskRunV1, productionGuestTaskDigestV1, validateProductionGuestTaskIntentV1, validateProductionGuestTaskReceiptV1 } from "./production-guest-task.mjs";
import { assertPreDestroyCollection, attestEvidenceInventory, sha256, validateNetworkPolicyObservationV1, validateProductionConfigBindingV1, validateSealedRoots } from "./proxmox-desktop-runtime.mjs";
import {
  createCredentialTerminalDispositionV1,
  validateCredentialTerminalDispositionV1,
  validateCredentialVolatilityAttestationV1,
  validateInstalledDesktopIdentityV1,
} from "../validation/proxmox-desktop/v1/backend/index.mjs";
import { ProxmoxVeDesktopAdapterV1 } from "../validation/proxmox-desktop/v1/backend/proxmox-ve-adapter.mjs";

const PROVIDER_HELPER = fileURLToPath(new URL("../bin/nelos-proxmox-transport", import.meta.url));
const ATTEST_HELPER = fileURLToPath(new URL("../bin/nelos-proxmox-attest-transport", import.meta.url));
export const PROXMOX_SSH_TRANSPORT_EXECUTABLE_V1 = PROVIDER_HELPER;
export const PROXMOX_SSH_ATTEST_EXECUTABLE_V1 = ATTEST_HELPER;
const ATSPI_HELPER = "/usr/libexec/nelos-desktop-atspi";
const ARCHIVE_HELPER = "/usr/libexec/nelos-desktop-archive";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ATSPI_OPERATIONS = new Set([
  "list_tasks", "activate_expected_task", "active_task", "click", "keypress", "scroll", "select_menu",
  "type_text", "wait_for", "accessibility_tree", "window_state", "query_element", "task_state",
  "text_present", "window_count", "protected_capture_regions", "capture_evidence", "health",
  "gui_ready", "auth_status", "expected_task_visible", "observe_task_surface", "observe_archive_surface", "diagnostics",
  "prepare_expected_task", "read_prepared_task", "reconcile_prepared_task", "observe_native_task", "observe_mcp_task", "observe_native_archive", "observe_mcp_archive",
]);
const ARCHIVE_OPERATIONS = new Set(["archive_tasks", "restart_desktop", "reconcile_convergence"]);
const DEFAULTS = Object.freeze({
  deadlines: { providerMs: 30_000, qgaMs: 20_000, archiveMs: 60_000 },
  outputLimits: { providerBytes: 8_388_608, qgaBytes: 8_388_608, archiveReportBytes: 10_485_760 },
});

export class HomelabDesktopRuntimeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "HomelabDesktopRuntimeError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) { throw new HomelabDesktopRuntimeError(code, message, details); }
function plain(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_HOMELAB_CONFIG", `${label} must be an object`);
  return value;
}
function closed(value, fields, label) {
  plain(value, label);
  const actual = Object.keys(value).sort(); const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail("INVALID_HOMELAB_CONFIG", `${label} fields do not match the closed contract`);
  return value;
}
function fieldsEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function closedAggregateGroups(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === ["inProgress", "needsInput", "queued"].sort().join("\0") &&
    [value.inProgress, value.needsInput, value.queued].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 500);
}
function closedLifecycleEvidence(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === ["kind", "scan", "value"].sort().join("\0") &&
    ["complete-absence", "role", "state", "text"].includes(value.kind) && typeof value.value === "string" && value.value.length > 0 && value.value.length <= 256 &&
    value.scan && typeof value.scan === "object" && !Array.isArray(value.scan) && Object.keys(value.scan).sort().join("\0") === ["complete", "maximumNodes", "scannedNodes"].sort().join("\0") &&
    value.scan.complete === true && value.scan.maximumNodes === 2_000 && Number.isSafeInteger(value.scan.scannedNodes) && value.scan.scannedNodes > 0 && value.scan.scannedNodes <= value.scan.maximumNodes;
}
const AUTH_ATTESTATION_FIELDS = Object.freeze([
  "accountBindingDigest", "accountType", "attestationDigest", "authenticated", "authMethod", "authReceiptDigest",
  "automationUser", "credentialStore", "developerSessionImported", "fencingToken", "observedAt", "runId", "schemaVersion", "source", "type",
]);
function validateLiveAuthAttestation(value, admitted, clock = Date, expectedAccountBindingDigest = null, { requireFresh = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...AUTH_ATTESTATION_FIELDS].sort().join("\0")) {
    fail("AUTH_IDENTITY_MISMATCH", "live account/read attestation is not closed metadata");
  }
  const { attestationDigest, ...base } = value;
  const observedAt = Date.parse(value.observedAt);
  if (value.schemaVersion !== 1 || value.type !== "live-device-auth-attestation" || value.source !== "codex-app-server-account-read" ||
      value.authenticated !== true || value.accountType !== "chatgpt" || value.authMethod !== "chatgptDeviceCode" || value.credentialStore !== "file" || value.developerSessionImported !== false ||
      !SHA256.test(value.accountBindingDigest ?? "") || !SHA256.test(value.authReceiptDigest ?? "") || value.automationUser !== admitted.plan.automation.user ||
      value.runId !== admitted.run.runId || value.fencingToken !== admitted.run.lease.fencingToken || !Number.isFinite(observedAt) || (requireFresh && Math.abs(clock.now() - observedAt) > 30_000) ||
      attestationDigest !== sha256(base) || (expectedAccountBindingDigest !== null && value.accountBindingDigest !== expectedAccountBindingDigest)) {
    fail("AUTH_IDENTITY_MISMATCH", "live account/read attestation differs from the admitted run or account binding");
  }
  return Object.freeze(structuredClone(value));
}
function validateExpectedTaskCapture(captured, scenario) {
  closed(captured, ["height", "lifecycleEvidence", "privacy", "protectedInventory", "protectedRegions", "renderedLifecycle", "rgbaBase64", "width"], "capture output");
  const rgba = Buffer.from(captured.rgbaBase64, "base64");
  if (!Number.isSafeInteger(captured.width) || !Number.isSafeInteger(captured.height) || captured.width < 1 || captured.height < 1 || rgba.length !== captured.width * captured.height * 4) {
    rgba.fill(0); fail("UNSAFE_CAPTURE", "capture dimensions and payload disagree");
  }
  let regions; let preserved;
  try {
    regions = protectedCaptureRegionsV1(captured.protectedInventory, { screen: { width: captured.width, height: captured.height } });
    preserved = capturePrivacyProofV1(captured.privacy, {
      screen: { width: captured.width, height: captured.height }, protectedRegions: regions,
      mode: "expected-task-evidence-only", expectedTaskIds: [scenario.task.taskId], requireTitle: true,
    });
  } catch {
    rgba.fill(0); fail("PROTECTED_GEOMETRY_UNAVAILABLE", "atomic evidence capture lacks a complete full-frame privacy proof");
  }
  if (!fieldsEqual(captured.protectedRegions, regions) || captured.privacy.traversal.scannedNodes !== captured.protectedInventory.traversal.scannedNodes ||
      !["idle", "running", "waitingOnApproval", "waitingOnUserInput"].includes(captured.renderedLifecycle) ||
      !closedLifecycleEvidence(captured.lifecycleEvidence) ||
      (captured.renderedLifecycle === "idle" ? captured.lifecycleEvidence.kind !== "complete-absence" || captured.lifecycleEvidence.value !== "no-running-approval-or-input-indicator" : captured.lifecycleEvidence.kind === "complete-absence") ||
      (captured.renderedLifecycle !== "idle" && !preserved.some(({ kind }) => kind === "expected-task-status"))) {
    rgba.fill(0); fail("UNSAFE_CAPTURE", "atomic evidence capture privacy, traversal, or lifecycle proof differs");
  }
  const expectedTitleDigest = `sha256:${createHash("sha256").update(scenario.scenarioId).digest("hex")}`;
  const expectedStatusDigest = `sha256:${createHash("sha256").update(captured.lifecycleEvidence.value).digest("hex")}`;
  if (preserved.some((region) => region.textDigest !== (region.kind === "expected-task-title" ? expectedTitleDigest : expectedStatusDigest))) {
    rgba.fill(0); fail("UNSAFE_CAPTURE", "evidence capture restored pixels outside the exact expected title/status allowlist");
  }
  try {
    assertCapturePrivacyRgbaV1(rgba, {
      screen: { width: captured.width, height: captured.height }, preservedRegions: preserved, protectedRegions: regions, requireSignal: true,
    });
  } catch {
    rgba.fill(0); fail("UNSAFE_CAPTURE", "evidence capture exposes RGBA pixels outside the exact expected task allowlist");
  }
  return { rgba, regions, preserved };
}
function boundedInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail("INVALID_HOMELAB_CONFIG", `${label} is outside its bound`);
  return value;
}
function exactIdentity(actual, expected, code = "RUNTIME_IDENTITY_MISMATCH") {
  for (const [field, value] of Object.entries(expected)) if (actual?.[field] !== value) fail(code, `${field} does not match the admitted runtime identity`);
}
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function bindingFor(config) {
  return { ...config.run.provider, leaseId: config.run.lease.leaseId, fencingToken: config.run.lease.fencingToken };
}
function runtimeBindingFor(config) {
  return { ...bindingFor(config), imageId: config.run.goldenImage.imageId, runId: config.run.runId, automationUser: config.plan.automation.user, stateRoot: config.plan.automation.stateRoot };
}
function assertWithin(root, target, label) {
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("UNSAFE_RUNTIME_PATH", `${label} must be below the admitted runtime state root`);
}

function validateConfig(config, clock = Date, { effectiveLease = null, operationMode = "run" } = {}) {
  plain(config, "config"); plain(config.run, "config.run"); plain(config.plan, "config.plan");
  const homelab = closed(config.homelab, ["schemaVersion", "stateRoot", "sealedValueRoot", "observationRoot", "guiBindings", "deadlines", "outputLimits"], "config.homelab");
  if (homelab.schemaVersion !== 1 || typeof config.run.runId !== "string" || !ID.test(config.run.runId)) fail("INVALID_HOMELAB_CONFIG", "homelab schema or run identity is invalid");
  for (const [field, value] of Object.entries(config.run.provider ?? {})) if (!ID.test(value ?? "")) fail("INVALID_HOMELAB_CONFIG", `run.provider.${field} is invalid`);
  for (const field of ["leaseId", "fencingToken"]) if (!ID.test(config.run.lease?.[field] ?? "")) fail("INVALID_HOMELAB_CONFIG", `run.lease.${field} is invalid`);
  if (!isAbsolute(config.journalDirectory ?? "") || !isAbsolute(config.plan.evidence?.bundleDirectory ?? "") || !isAbsolute(homelab.stateRoot ?? "") || !isAbsolute(homelab.sealedValueRoot ?? "") || !isAbsolute(homelab.observationRoot ?? "")) fail("UNSAFE_RUNTIME_PATH", "runtime, journal, evidence, observation, and sealed roots must be absolute");
  const stateRoot = resolve(homelab.stateRoot);
  if (dirname(resolve(config.journalDirectory)) !== stateRoot || stateRoot.split(sep).at(-1) !== config.run.runId) fail("WRITABLE_STATE_NOT_ISOLATED", "host state and journal must be isolated to the admitted run");
  if (config.runPacket) validateProductionConfigBindingV1(config, config.runPacket.packet);
  else {
    if (dirname(resolve(config.plan.evidence.bundleDirectory)) !== stateRoot || resolve(homelab.sealedValueRoot).split(sep).at(-1) !== config.run.runId) fail("WRITABLE_STATE_NOT_ISOLATED", "evidence and sealed values must be isolated to the admitted run");
    assertWithin(stateRoot, resolve(homelab.observationRoot), "observation root");
  }
  if (config.plan.automation?.stateRoot !== `/var/lib/nelos-desktop/runs/${config.run.runId}` || config.plan.automation?.home !== `/home/${config.plan.automation?.user}` || config.plan.automation?.credentialRefs?.length !== 0) fail("WRITABLE_STATE_NOT_ISOLATED", "guest automation state is not isolated or contains credential references");
  plain(config.currentLease, "config.currentLease");
  exactIdentity(config.currentLease, { ...config.run.provider, ...config.run.lease }, "STALE_FENCING_TOKEN");
  if (config.runPacket) {
    plain(effectiveLease, "effective production lease");
    exactIdentity(effectiveLease, {
      leaseId: config.run.lease.leaseId,
      holderId: config.run.lease.holderId,
      fencingToken: config.run.lease.fencingToken,
    }, "STALE_FENCING_TOKEN");
    const cleanupOnly = operationMode !== "run" && effectiveLease.state === "cleanup-only";
    if (!(effectiveLease.state === "active" || cleanupOnly) || Date.parse(effectiveLease.expiresAt) <= clock.now()) {
      fail("STALE_FENCING_TOKEN", "the independently observed production lease does not authorize this operation");
    }
  } else if (config.run.lease.state !== "active" || Date.parse(config.run.lease.expiresAt) <= clock.now()) {
    fail("STALE_FENCING_TOKEN", "the admitted lease is not currently active");
  }
  closed(homelab.deadlines, ["providerMs", "qgaMs", "archiveMs"], "config.homelab.deadlines");
  boundedInteger(homelab.deadlines.providerMs, "providerMs", 300_000); boundedInteger(homelab.deadlines.qgaMs, "qgaMs", 120_000); boundedInteger(homelab.deadlines.archiveMs, "archiveMs", 3_600_000);
  closed(homelab.outputLimits, ["providerBytes", "qgaBytes", "archiveReportBytes"], "config.homelab.outputLimits");
  boundedInteger(homelab.outputLimits.providerBytes, "providerBytes", 16_777_216); boundedInteger(homelab.outputLimits.qgaBytes, "qgaBytes", 16_777_216); boundedInteger(homelab.outputLimits.archiveReportBytes, "archiveReportBytes", 10_485_760);
  plain(homelab.guiBindings, "config.homelab.guiBindings");
  for (const scenario of config.run.scenarios) {
    const submitActions = scenario.actions.filter((action) => action.type === "keypress" && homelab.guiBindings[action.targetRef]?.key === "ENTER");
    if (submitActions.length !== 1) fail("INVALID_HOMELAB_CONFIG", `scenario ${scenario.scenarioId} must declare exactly one allowlisted ENTER model-submit action`);
  }
  const serialized = JSON.stringify(homelab);
  if (/(?:password|passwd|secret|token|cookie|authorization|credential|sealedValue)(?:"|\s)*:/iu.test(serialized.replace(/"sealedValueRoot"/gu, "\"sealedRoot\""))) fail("FORBIDDEN_RUNTIME_SECRET", "homelab configuration contains a forbidden secret field class");
  return { ...config, homelab: structuredClone(homelab), binding: bindingFor(config), runtimeBinding: runtimeBindingFor(config), stateRoot };
}

export class BoundedJsonProcessV1 {
  constructor({ spawnProcess = spawn } = {}) { this.spawnProcess = spawnProcess; }
  invoke({ executable, operation, payload, inputBytes = null, deadlineMs, maxOutputBytes, signal = null }) {
    if (![PROVIDER_HELPER, ATTEST_HELPER].includes(executable)) fail("UNAVAILABLE_HELPER", "helper executable is not allowlisted");
    return new Promise((resolvePromise, rejectPromise) => {
      const abort = new AbortController();
      const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      const controllerEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^NELOS_PROXMOX_(?:(?:ATTEST_)?(?:SSH_HOST|SSH_USER|SSH_PORT|KNOWN_HOSTS|IDENTITY_FILE|HOST_FINGERPRINT|HOST_ID|PROVIDER_ID|SOURCE_TEMPLATE_VM_ID))$/u.test(name)));
      const child = this.spawnProcess(process.execPath, [executable, operation], { shell: false, stdio: ["pipe", "pipe", "ignore"], signal: combined, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", ...controllerEnv } });
      const chunks = []; let size = 0; let settled = false;
      const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); callback(value); };
      const onAbort = () => { abort.abort(); finish(rejectPromise, new HomelabDesktopRuntimeError("HELPER_DEADLINE", "helper invocation was aborted")); };
      const timer = setTimeout(() => { abort.abort(); finish(rejectPromise, new HomelabDesktopRuntimeError("HELPER_DEADLINE", "helper invocation exceeded its deadline")); }, deadlineMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", () => finish(rejectPromise, new HomelabDesktopRuntimeError("UNAVAILABLE_HELPER", "allowlisted helper is unavailable")));
      child.stdout.on("data", (chunk) => { size += chunk.length; if (size > maxOutputBytes) { abort.abort(); finish(rejectPromise, new HomelabDesktopRuntimeError("HELPER_OUTPUT_LIMIT", "helper output exceeded its bound")); } else chunks.push(chunk); });
      child.once("close", (code) => {
        if (code === 44 && [PROVIDER_HELPER, ATTEST_HELPER].includes(executable) && operation === "request") {
          const error = new HomelabDesktopRuntimeError("PVE_NOT_FOUND", "Proxmox object was not found");
          error.status = 404;
          return finish(rejectPromise, error);
        }
        if (code !== 0) return finish(rejectPromise, new HomelabDesktopRuntimeError("HELPER_FAILED", "allowlisted helper returned a failure", { exitCode: code }));
        try { finish(resolvePromise, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(rejectPromise, new HomelabDesktopRuntimeError("INVALID_HELPER_OUTPUT", "helper returned invalid JSON")); }
      });
      const header = Buffer.from(`${JSON.stringify(payload)}\n`);
      child.stdin.write(header); header.fill(0);
      if (inputBytes) child.stdin.write(inputBytes);
      child.stdin.end();
    });
  }
}

export class HomelabProxmoxTransportV1 {
  constructor({ processBoundary, binding, deadlineMs, maxOutputBytes, executable = PROVIDER_HELPER, clock = Date }) {
    if (![PROVIDER_HELPER, ATTEST_HELPER].includes(executable)) fail("UNAVAILABLE_HELPER", "Proxmox transport helper is not allowlisted");
    this.processBoundary = processBoundary; this.binding = binding; this.deadlineMs = deadlineMs; this.maxOutputBytes = maxOutputBytes; this.executable = executable; this.clock = clock;
  }
  request(request, options = {}) {
    const deadlineMs = Math.min(options.deadlineMs ?? this.deadlineMs, this.deadlineMs);
    const maxOutputBytes = Math.min(options.maxOutputBytes ?? this.maxOutputBytes, this.maxOutputBytes);
    return this.processBoundary.invoke({ executable: this.executable, operation: "request", payload: {
      schemaVersion: 1,
      binding: this.binding,
      deadlineAt: new Date(this.clock.now() + deadlineMs).toISOString(),
      maxOutputBytes,
      request,
    }, deadlineMs, maxOutputBytes, signal: options.signal ?? null });
  }
}

export class AtomicProviderReceiptStoreV1 {
  constructor(root) { this.root = resolve(root); }
  path(receiptId) { if (!ID.test(receiptId ?? "")) fail("INVALID_RECEIPT", "receipt identity is invalid"); return join(this.root, `${receiptId}.json`); }
  async commit(receipt) {
    const target = this.path(receipt.receiptId); await mkdir(this.root, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    try { const handle = await open(target, "wx", 0o400); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("ALTERED_RECEIPT", "existing receipt is not a regular identity-bound file");
      const existing = await readFile(target); if (!existing.equals(bytes)) fail("ALTERED_RECEIPT", "receipt identity was reused with altered content");
    }
    return { committed: true, receiptId: receipt.receiptId, attestationDigest: receipt.attestationDigest };
  }
  async read(receiptId) {
    const target = this.path(receiptId);
    try { await access(target, fsConstants.R_OK); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65_536) fail("ALTERED_RECEIPT", "receipt is not a bounded regular file");
    const root = await realpath(this.root); const canonical = await realpath(target); if (!canonical.startsWith(`${root}${sep}`)) fail("ALTERED_RECEIPT", "receipt escaped its state root");
    try { return JSON.parse(await readFile(canonical, "utf8")); } catch { fail("ALTERED_RECEIPT", "receipt is not valid JSON"); }
  }
}

function receiptFacts(effect, operation = null, credentialDisposition = null) {
  if (operation === "quarantine" || effect.kind === "quarantine") return { operation: "quarantine", facts: { ...(credentialDisposition === null ? {} : { credentialDisposition }), quarantined: true, reconciliation: { operationId: effect.request.operationId, ...bindingFor({ run: effect.request }) } } };
  if (operation === "destroy" || effect.kind === "destroy") return { operation: "destroy", facts: { ...(credentialDisposition === null ? {} : { credentialDisposition }), destroyed: true, macAbsent: true, networkInventoryComplete: true } };
  if (operation === "create" || effect.kind === "provision") return { operation: "create", facts: { created: true, qgaReady: true, state: "running" } };
  fail("RECONCILIATION_REQUIRED", "provider effect kind is not reconcilable");
}

function provisionReceiptFacts(admitted, desktopIdentity, credentialBoundary) {
  const verified = validateInstalledDesktopIdentityV1(desktopIdentity, admitted.run.desktopBundle);
  const boundary = validateCredentialVolatilityAttestationV1(credentialBoundary, admitted.runtimeBinding);
  return { created: true, credentialBoundary: boundary, desktopIdentity: verified, desktopIdentityDigest: sha256(verified), qgaReady: true, state: "running" };
}

export class HomelabProviderReconcilerV1 {
  constructor({ adapter, receiptStore, admitted, currentLease = admitted?.run?.lease, clock = Date }) { this.adapter = adapter; this.receiptStore = receiptStore; this.admitted = admitted; this.currentLease = currentLease; this.clock = clock; }
  assertEffect(effect, { cleanupOnly = false } = {}) {
    if (effect?.request?.runId !== this.admitted.run.runId) fail("RUNTIME_IDENTITY_MISMATCH", "provider effect run differs from the admitted run");
    exactIdentity(effect.request.provider, this.admitted.run.provider); exactIdentity(effect.request.lease, this.admitted.run.lease, "STALE_FENCING_TOKEN");
    exactIdentity(effect.request.automation, this.admitted.plan.automation); exactIdentity(effect.request.reservation, this.admitted.plan.reservation);
    const stateAllowed = this.currentLease?.state === "active" || (cleanupOnly && this.currentLease?.state === "cleanup-only");
    if (!stateAllowed || Date.parse(this.currentLease?.expiresAt ?? "") <= this.clock.now()) fail("STALE_FENCING_TOKEN", "lease expired before provider reconciliation");
  }
  async reconcile(effect, { cleanupOnly = false } = {}) {
    this.assertEffect(effect, { cleanupOnly });
    const binding = this.admitted.binding;
    const primary = receiptFacts(effect);
    const operations = effect.kind === "quarantine" ? ["quarantine"] : effect.kind === "provision" ? ["create", "destroy", "quarantine"] : [primary.operation, "quarantine"];
    let operation = primary.operation; let facts = primary.facts; let receiptId; let persisted = null;
    for (const candidate of operations) {
      const candidateId = `${effect.request.operationId}-${candidate}-receipt`;
      const candidateReceipt = await this.receiptStore.read(candidateId);
      if (candidateReceipt) { operation = candidate; facts = receiptFacts(effect, candidate).facts; receiptId = candidateId; persisted = candidateReceipt; break; }
    }
    receiptId ??= `${effect.request.operationId}-${operation}-receipt`;
    if (persisted && operation === "create") facts = persisted.cleanupOnly === true
      ? { cleanupOnly: true, created: true, qgaReady: false, state: "running" }
      : provisionReceiptFacts(this.admitted, persisted.desktopIdentity, persisted.credentialBoundary);
    if (persisted && operation === "destroy") {
      const disposition = validateCredentialTerminalDispositionV1(persisted.credentialDisposition, binding, "powered-off-before-destroy");
      facts = receiptFacts(effect, operation, disposition).facts;
    }
    if (persisted && operation === "quarantine") {
      const disposition = validateCredentialTerminalDispositionV1(persisted.credentialDisposition, binding, "powered-off-quarantine");
      facts = receiptFacts(effect, operation, disposition).facts;
    }
    if (!persisted) {
      const observed = await this.adapter.inspectVm(this.admitted.run.provider);
      if (operation === "create") {
        if (observed?.quarantined === true) {
          operation = "quarantine";
          const disposition = createCredentialTerminalDispositionV1(effect.request, await this.adapter.attestVmStopped(binding), "powered-off-quarantine");
          facts = receiptFacts(effect, operation, disposition).facts; receiptId = `${effect.request.operationId}-quarantine-receipt`;
        }
        else if (cleanupOnly && observed === null) { operation = "destroy"; facts = receiptFacts(effect, operation).facts; receiptId = `${effect.request.operationId}-destroy-receipt`; }
        else if (cleanupOnly) {
          exactIdentity(observed, { ...binding, imageId: this.admitted.run.goldenImage.imageId });
          facts = { cleanupOnly: true, created: true, qgaReady: false, state: "running" };
        }
        else {
        exactIdentity(observed, { ...binding, imageId: this.admitted.run.goldenImage.imageId });
        const qga = await this.adapter.waitForQga({
          binding, expectedUser: this.admitted.plan.automation.user, expectedSession: "graphical",
          deadlineAt: Date.parse(this.admitted.run.lease.expiresAt) - 120_000,
          hardDeadlineAt: Date.parse(this.admitted.run.lease.expiresAt),
        });
        if (qga?.ready !== true) fail("RECONCILIATION_REQUIRED", "creation cannot be proven complete through read boundaries");
        facts = provisionReceiptFacts(this.admitted, qga.installedDesktopIdentity, qga.credentialBoundary);
        }
      } else if (operation === "destroy") {
        const absent = await this.adapter.attestVmAbsent(binding); exactIdentity(absent, binding);
        if (absent.absent !== true) {
          if (observed?.quarantined === true) {
            operation = "quarantine";
            const disposition = createCredentialTerminalDispositionV1(effect.request, await this.adapter.attestVmStopped(binding), "powered-off-quarantine");
            facts = receiptFacts(effect, operation, disposition).facts; receiptId = `${effect.request.operationId}-quarantine-receipt`;
          }
          else fail("RECONCILIATION_REQUIRED", "destruction remains ambiguous");
        } else fail("RECONCILIATION_REQUIRED", "destroyed VM has no committed credential-loss receipt");
      } else if (!observed?.quarantined) fail("RECONCILIATION_REQUIRED", "quarantine remains ambiguous");
      else {
        const disposition = createCredentialTerminalDispositionV1(effect.request, await this.adapter.attestVmStopped(binding), "powered-off-quarantine");
        facts = receiptFacts(effect, operation, disposition).facts;
      }
      const base = { receiptId, ...binding, operation, operationId: effect.request.operationId, mutationStatus: "committed", attestationDigest: digest({ binding, operation, operationId: effect.request.operationId, facts }) };
      persisted = { ...base, ...facts };
      await this.receiptStore.commit(persisted);
    }
    exactIdentity(persisted, { receiptId, ...binding, operation, operationId: effect.request.operationId, mutationStatus: "committed" });
    const expectedDigest = digest({ binding, operation, operationId: effect.request.operationId, facts });
    if (persisted.attestationDigest !== expectedDigest || !SHA256.test(persisted.attestationDigest ?? "")) fail("ALTERED_RECEIPT", "persisted provider receipt failed attestation verification");
    if (operation === "destroy") return { receiptId, ...binding, mutationStatus: "committed", ...facts, attestationDigest: expectedDigest };
    return { ...persisted, ...facts };
  }
}

export class ProxmoxQgaHelperClientV1 {
  constructor({ adapter, admitted, deadlineMs, maxOutputBytes, clock = Date }) {
    this.adapter = adapter; this.admitted = admitted; this.deadlineMs = deadlineMs; this.maxOutputBytes = maxOutputBytes; this.clock = clock;
    this.unresolvedProcess = null;
    this.operationTail = Promise.resolve();
  }
  async assertGuestIdentity() {
    if (Date.parse(this.admitted.run.lease.expiresAt) <= this.clock.now()) fail("STALE_FENCING_TOKEN", "lease expired before guest helper invocation");
    const observed = await this.adapter.inspectRuntimeBinding(this.admitted.run.provider);
    exactIdentity(observed, this.admitted.runtimeBinding);
  }
  async #boundedAdapterCall(method, path, payload, { signal = null, wallDeadlineAt }) {
    const remaining = wallDeadlineAt - Date.now();
    if (!Number.isSafeInteger(remaining) || remaining < 1 || signal?.aborted) fail("HELPER_DEADLINE", "QGA provider call exceeded its sealed deadline");
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onExternalAbort); callback(value);
      };
      const rejectDeadline = () => { abort.abort(); finish(rejectPromise, new HomelabDesktopRuntimeError("HELPER_DEADLINE", "QGA provider call exceeded its sealed deadline")); };
      const onExternalAbort = () => rejectDeadline();
      const timer = setTimeout(rejectDeadline, remaining);
      signal?.addEventListener("abort", onExternalAbort, { once: true });
      if (signal?.aborted) { onExternalAbort(); return; }
      Promise.resolve().then(() => this.adapter.call(method, path, payload, { signal: combined, deadlineMs: remaining })).then(
        (value) => Date.now() >= wallDeadlineAt ? rejectDeadline() : finish(resolvePromise, value),
        (error) => combined.aborted ? rejectDeadline() : finish(rejectPromise, error),
      );
    });
  }
  async #status(pid, { signal = null, wallDeadlineAt }) {
    const response = await this.#boundedAdapterCall(
      "GET",
      `/nodes/${encodeURIComponent(this.admitted.binding.hostId)}/qemu/${encodeURIComponent(this.admitted.binding.vmId)}/agent/exec-status?pid=${pid}`,
      undefined,
      { signal, wallDeadlineAt },
    );
    return response?.data ?? response;
  }
  async #reconcilePid(pid, wallDeadlineAt) {
    let lastStatus = null;
    for (;;) {
      const remaining = wallDeadlineAt - Date.now();
      if (remaining <= 0) return null;
      try {
        lastStatus = await this.#status(pid, { wallDeadlineAt });
        if (lastStatus?.exited === 1 || lastStatus?.exited === true) return lastStatus;
      } catch { /* an unavailable status remains unresolved and fails closed below */ }
      const sleepMs = Math.min(25, wallDeadlineAt - Date.now());
      if (sleepMs <= 0) return null;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, sleepMs));
    }
  }
  async #reconcileOutstanding() {
    if (this.unresolvedProcess === null) return;
    const pending = this.unresolvedProcess;
    if (!Number.isSafeInteger(pending.pid)) fail("QGA_PROCESS_RECONCILIATION_REQUIRED", "a prior QGA exec has no exact PID; no new guest operation is allowed");
    const status = await this.#reconcilePid(pending.pid, pending.wallDeadlineAt);
    if (!status) fail("QGA_PROCESS_RECONCILIATION_REQUIRED", "a prior guest helper PID is not terminal; no new guest operation is allowed");
    this.unresolvedProcess = null;
  }
  async invoke(request) {
    const signal = request?.signal ?? null;
    let release;
    const predecessor = this.operationTail;
    this.operationTail = new Promise((resolvePromise) => { release = resolvePromise; });
    try {
      await predecessor;
      if (signal?.aborted) fail("HELPER_DEADLINE", "queued QGA guest operation was aborted before process creation");
      return await this.#invokeExclusive(request);
    } finally { release(); }
  }
  async #invokeExclusive({ helper, operation, payload = {}, bytes = null, signal = null, deadlineAt = null, maxOutputBytes = this.maxOutputBytes }) {
    const operations = helper === ATSPI_HELPER ? ATSPI_OPERATIONS : helper === ARCHIVE_HELPER ? ARCHIVE_OPERATIONS : null;
    if (!operations?.has(operation)) fail("FORBIDDEN_HELPER_OPERATION", "guest helper or operation is not allowlisted");
    await this.#reconcileOutstanding();
    await this.assertGuestIdentity();
    const parsedDeadlineAt = deadlineAt === null ? null : Date.parse(deadlineAt);
    if (deadlineAt !== null && !Number.isFinite(parsedDeadlineAt)) fail("HELPER_DEADLINE", "guest helper received an invalid absolute deadline");
    const effectiveDeadlineMs = Math.min(this.deadlineMs, parsedDeadlineAt === null ? this.deadlineMs : parsedDeadlineAt - this.clock.now());
    if (!Number.isSafeInteger(effectiveDeadlineMs) || effectiveDeadlineMs < 4 || signal?.aborted) fail("HELPER_DEADLINE", "guest helper deadline expired before process creation");
    maxOutputBytes = Math.min(maxOutputBytes, this.maxOutputBytes);
    const reconciliationBudgetMs = Math.min(1_000, Math.max(2, Math.floor(effectiveDeadlineMs / 5)));
    const executionDeadlineMs = effectiveDeadlineMs - reconciliationBudgetMs;
    const guestDeadlineAt = new Date(this.clock.now() + executionDeadlineMs).toISOString();
    const envelope = Buffer.from(`${JSON.stringify({ schemaVersion: 1, binding: this.admitted.runtimeBinding, operation, payload, byteLength: bytes?.length ?? 0, deadlineAt: guestDeadlineAt, maxOutputBytes })}\n`);
    const input = bytes ? Buffer.concat([envelope, bytes]) : envelope;
    const abort = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const wallDeadlineAt = Date.now() + effectiveDeadlineMs;
    const executionWallDeadlineAt = wallDeadlineAt - reconciliationBudgetMs;
    const timer = setTimeout(() => abort.abort(), executionDeadlineMs);
    let pid = null;
    let execIssued = false;
    try {
      execIssued = true;
      this.unresolvedProcess = { operation, pid: null, wallDeadlineAt };
      const response = await this.#boundedAdapterCall("POST", `/nodes/${encodeURIComponent(this.admitted.binding.hostId)}/qemu/${encodeURIComponent(this.admitted.binding.vmId)}/agent/exec`, {
        command: helper, "extra-args": [operation], "input-data": input.toString("base64"), "capture-output": 1,
      }, { signal: combinedSignal, wallDeadlineAt: executionWallDeadlineAt });
      pid = response?.data?.pid ?? response?.pid ?? response?.data;
      if (!Number.isSafeInteger(pid)) fail("AMBIGUOUS_GUI_EFFECT", "QGA helper start did not return a process identity");
      this.unresolvedProcess = { operation, pid, wallDeadlineAt };
      for (;;) {
        if (combinedSignal.aborted || Date.now() >= executionWallDeadlineAt) fail("HELPER_DEADLINE", "guest helper exceeded its execution deadline");
        const status = await this.#status(pid, { signal: combinedSignal, wallDeadlineAt: executionWallDeadlineAt });
        if (status?.exited === 1 || status?.exited === true) {
          this.unresolvedProcess = null;
          if (status.exitcode !== 0) fail("HELPER_FAILED", "guest helper returned a failure");
          const output = Buffer.from(status["out-data"] ?? status.outData ?? "", "base64");
          if (output.length > maxOutputBytes) fail("HELPER_OUTPUT_LIMIT", "guest helper output exceeded its bound");
          try { const parsed = JSON.parse(output.toString("utf8")); return parsed.bytesBase64 === undefined ? parsed : Buffer.from(parsed.bytesBase64, "base64"); }
          catch { fail("INVALID_HELPER_OUTPUT", "guest helper returned invalid bounded output"); }
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    } catch (error) {
      clearTimeout(timer);
      if (execIssued && pid === null) {
        this.unresolvedProcess = { operation, pid: null, wallDeadlineAt };
        fail("QGA_PROCESS_RECONCILIATION_REQUIRED", "QGA exec outcome has no exact PID and cannot be replayed safely");
      }
      if (pid !== null && this.unresolvedProcess !== null) {
        const terminal = await this.#reconcilePid(pid, wallDeadlineAt);
        if (!terminal) {
          this.unresolvedProcess = { operation, pid, wallDeadlineAt };
          fail("QGA_PROCESS_RECONCILIATION_REQUIRED", "guest helper PID did not reach a terminal state before its sealed deadline");
        }
        this.unresolvedProcess = null;
      }
      if (combinedSignal.aborted && error?.code !== "HELPER_DEADLINE") fail("HELPER_DEADLINE", "guest helper exceeded its deadline after terminal PID reconciliation");
      throw error;
    } finally { clearTimeout(timer); envelope.fill(0); input.fill(0); }
  }
}

export class QgaAtspiBoundaryV1 {
  constructor(client) { this.client = client; }
  request(operation, payload = {}, bytes = null, signal = null, deadlineAt = null) { return this.client.invoke({ helper: ATSPI_HELPER, operation, payload, bytes, signal, deadlineAt }); }
  listTasks({ signal }) { return this.request("list_tasks", {}, null, signal); } activateExpectedTask({ scenarioId, taskId, title, signal }) { return this.request("activate_expected_task", { scenarioId, taskId, title }, null, signal); }
  activeTask({ signal }) { return this.request("active_task", {}, null, signal); } click({ target, signal }) { return this.request("click", { target }, null, signal); }
  keypress({ target, key, signal }) { return this.request("keypress", { target, key }, null, signal); } scroll({ target, direction, amount, signal }) { return this.request("scroll", { target, direction, amount }, null, signal); }
  selectMenu({ target, menuPath, signal }) { return this.request("select_menu", { target, menuPath }, null, signal); } typeText({ target, bytes, signal }) { return this.request("type_text", { target }, bytes, signal); }
  waitFor({ target, condition, signal }) { return this.request("wait_for", { target, condition }, null, signal); } accessibilityTree({ signal }) { return this.request("accessibility_tree", {}, null, signal); }
  windowState({ signal }) { return this.request("window_state", {}, null, signal); } queryElement({ target, signal }) { return this.request("query_element", { target }, null, signal); }
  taskState({ target, expected, signal }) { return this.request("task_state", { target, expected }, null, signal); } textPresent({ target, bytes, signal }) { return this.request("text_present", { target }, bytes, signal); }
  windowCount({ target, signal }) { return this.request("window_count", { target }, null, signal); } protectedCaptureRegions({ kinds, signal }) { return this.request("protected_capture_regions", { kinds }, null, signal); }
  async captureScreenshot({ exclude, expectedTask, signal }) {
    if (!expectedTask || typeof expectedTask.taskId !== "string" || typeof expectedTask.title !== "string") fail("UNSAFE_CAPTURE", "production checkpoint capture lacks its exact expected task identity");
    const captured = await this.request("capture_evidence", { expectedTask }, null, signal);
    const verified = validateExpectedTaskCapture(captured, { scenarioId: expectedTask.title, task: { taskId: expectedTask.taskId } });
    if (!fieldsEqual(exclude, verified.regions.map(({ kind, x, y, width, height }) => ({ kind, x, y, width, height })))) {
      verified.rgba.fill(0); fail("PROTECTED_GEOMETRY_UNAVAILABLE", "checkpoint capture geometry changed between complete bounded observations");
    }
    return verified.rgba;
  }
  health({ signal }) { return this.request("health", {}, null, signal); }
}

export class GuestProductionTaskPreparerV1 {
  constructor({ client, admitted, intent } = {}) {
    if (typeof client?.invoke !== "function") throw new TypeError("guest task preparer requires a QGA client");
    this.client = client;
    this.admitted = admitted;
    this.intent = validateProductionGuestTaskIntentV1(intent);
    if (this.intent.runId !== admitted?.run?.runId || this.intent.fencingToken !== admitted?.run?.lease?.fencingToken ||
        this.intent.automationUser !== admitted?.plan?.automation?.user || this.intent.scenarioId !== admitted?.run?.scenarios?.[0]?.scenarioId ||
        this.intent.taskSlotId !== admitted?.run?.scenarios?.[0]?.task?.taskId) {
      fail("TASK_INTENT_BINDING_MISMATCH", "guest task intent differs from the admitted run, fence, automation user, or scenario slot");
    }
    this.intentDigest = productionGuestTaskDigestV1(this.intent);
  }
  #validate(receipt) {
    return validateProductionGuestTaskReceiptV1(receipt, { intent: this.intent, binding: this.admitted.runtimeBinding });
  }
  async execute({ intentDigest, signal = null } = {}) {
    if (intentDigest !== this.intentDigest) fail("TASK_INTENT_BINDING_MISMATCH", "guest task preparation effect differs from the admitted intent");
    const receipt = await this.client.invoke({
      helper: ATSPI_HELPER,
      operation: "prepare_expected_task",
      payload: { intent: this.intent },
      ...(signal === null ? {} : { signal }),
    });
    return structuredClone(this.#validate(receipt));
  }
  async reconcileEffect(effect, { cleanupOnly = false, signal = null } = {}) {
    if (effect?.kind !== "task-preparation" || effect?.request?.intentDigest !== this.intentDigest) {
      fail("TASK_INTENT_BINDING_MISMATCH", "pending guest task effect differs from the admitted intent");
    }
    if (cleanupOnly) fail("TASK_PREPARATION_RECONCILIATION_REQUIRED", "cleanup-only recovery cannot create or assume a guest task");
    const receipt = await this.client.invoke({
      helper: ATSPI_HELPER,
      operation: "reconcile_prepared_task",
      payload: { intent: this.intent },
      ...(signal === null ? {} : { signal }),
    });
    return structuredClone(this.#validate(receipt));
  }
  materialize(run, receipt) {
    return materializeProductionGuestTaskRunV1(run, this.#validate(receipt), {
      intent: this.intent,
      binding: this.admitted.runtimeBinding,
    });
  }
}

function scenarioEvidence(results) {
  return {
    scenarioMetadata: results.map((result) => ({
      evidenceClass: "scenario_metadata", scenarioId: result.scenarioId, taskId: result.taskId,
      startedAt: result.startedAt, finishedAt: result.finishedAt, outcome: result.outcome,
    })),
    actionTimeline: results.flatMap((result) => result.actions.map((action) => ({
      evidenceClass: "action_timeline", scenarioId: result.scenarioId, ...action,
    }))),
    assertionOutcomes: results.flatMap((result) => result.assertions.map((assertion) => ({
      evidenceClass: "assertion_outcome", scenarioId: result.scenarioId, ...assertion,
    }))),
  };
}

async function writeContentAddressedEvidence(root, role, extension, bytes) {
  const contentHash = sha256(bytes);
  const directory = join(root, role);
  const target = join(directory, `${contentHash.slice(7)}.${extension}`);
  assertWithin(root, target, "pre-destroy evidence artifact");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(target, "wx", 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST" || !(await readFile(target)).equals(bytes)) fail("ALTERED_RECEIPT", "content-addressed pre-destroy evidence was altered");
  }
  return { length: bytes.length, path: relative(root, target).split(sep).join("/"), role, sha256: contentHash };
}

async function writeContentAddressedJson(root, directoryName, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const valueDigest = sha256(value);
  const directory = join(root, directoryName);
  const target = join(directory, `${valueDigest.slice(7)}.json`);
  assertWithin(root, target, "content-addressed evidence receipt");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(target, "wx", 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST" || !(await readFile(target)).equals(bytes)) fail("ALTERED_RECEIPT", "content-addressed evidence receipt was altered");
  }
  return { path: target, digest: valueDigest };
}

export class ReadOnlyProxmoxAbsenceAttestorV1 {
  constructor({ transport, providerId, hostId, sourceTemplateVmId }) {
    if (typeof transport?.request !== "function") fail("INDEPENDENT_ATTESTOR_REQUIRED", "independent provider transport is unavailable");
    if (!ID.test(hostId ?? "") || !/^[1-9][0-9]{2,8}$/u.test(String(sourceTemplateVmId ?? ""))) fail("INDEPENDENT_ATTESTOR_REQUIRED", "independent golden-image identity is unavailable");
    const sourceConfig = `/nodes/${encodeURIComponent(hostId)}/qemu/${encodeURIComponent(sourceTemplateVmId)}/config`;
    const sourceStatus = `/nodes/${encodeURIComponent(hostId)}/qemu/${encodeURIComponent(sourceTemplateVmId)}/status/current`;
    const readOnlyTransport = {
      request(request, options) {
        const targetConfig = /^\/nodes\/[^/]+\/qemu\/[^/]+\/config$/u.test(request?.path ?? "") && ![sourceConfig, sourceStatus].includes(request.path);
        if (request?.method !== "GET" || !(targetConfig || request.path === sourceConfig || request.path === sourceStatus || request.path === "/cluster/resources?type=vm" ||
            request.path === "/nelos/network/mac-absence" || request.path === "/nelos/network/policy")) {
          fail("FORBIDDEN_PROVIDER_OPERATION", "independent attestation transport accepts only exact inventory reads");
        }
        return transport.request(request, options);
      },
    };
    this.adapter = new ProxmoxVeDesktopAdapterV1({ transport: readOnlyTransport, receiptStore: { async commit() { fail("FORBIDDEN_PROVIDER_OPERATION", "read-only attestor cannot commit receipts"); } }, providerId });
  }
  inspectVm(binding) { return this.adapter.inspectVm(binding); }
  inspectGoldenImage(binding) { return this.adapter.inspectGoldenImage(binding); }
  attestNetworkPolicy() { return this.adapter.attestNetworkPolicy(); }
  attestVmAbsent(binding) { return this.adapter.attestVmAbsent(binding); }
}

function assertGoldenImageObservation(observed, admitted, productionAdmission, label) {
  const verified = productionAdmission?.goldenImageVerification;
  const expected = {
    providerId: admitted.run.provider.providerId,
    hostId: admitted.run.provider.hostId,
    templateVmId: String(admitted.plan.goldenImageTemplateVmId),
  };
  if (verified?.templateVmId !== expected.templateVmId || verified?.hostId !== expected.hostId || verified?.providerId !== expected.providerId ||
      verified?.imageId !== admitted.run.goldenImage.imageId || verified?.goldenImageDigest !== admitted.run.goldenImage.digest || !SHA256.test(verified?.outputConfigDigest ?? "")) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "sealed golden-image verification is unavailable or altered");
  }
  exactIdentity(observed, expected, "GOLDEN_IMAGE_ATTESTATION_MISMATCH");
  if (observed?.status !== "stopped" || observed?.template !== true || sha256(observed?.config) !== verified.outputConfigDigest) {
    fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", `${label} golden-image provider observation differs from the sealed build receipt`);
  }
  return observed;
}

function expectedResumeVmStates(journal) {
  const terminal = journal?.terminalOutcome?.outcome;
  if (terminal === "destroyed") return new Set(["absent"]);
  if (terminal === "quarantined") return new Set(["owned"]);
  const effects = Array.isArray(journal?.effects) ? journal.effects : [];
  const pendingProvider = [...effects].reverse().find(({ kind, status }) => ["provision", "destroy", "quarantine"].includes(kind) && status !== "committed");
  if (pendingProvider?.kind === "provision" || pendingProvider?.kind === "destroy") return new Set(["absent", "owned"]);
  if (pendingProvider?.kind === "quarantine") return new Set(["owned"]);
  if (effects.some(({ kind, status }) => kind === "destroy" && status === "committed")) return new Set(["absent"]);
  if (effects.some(({ kind, status }) => kind === "quarantine" && status === "committed")) return new Set(["owned"]);
  if (effects.some(({ kind, status }) => kind === "provision" && status === "committed")) return new Set(["owned"]);
  return new Set(["absent"]);
}

function exactOwnedResumeVm(observed, admitted) {
  const expected = {
    ...admitted.run.provider,
    leaseId: admitted.run.lease.leaseId, fencingToken: admitted.run.lease.fencingToken, imageId: admitted.run.goldenImage.imageId,
  };
  return observed !== null && typeof observed === "object" && !Array.isArray(observed) && Object.entries(expected).every(([field, value]) => observed[field] === value);
}

function validateSealedValueCleanupReceiptV1(value, run) {
  closed(value, ["inventoryDigest", "receiptDigest", "result", "runId", "schemaVersion", "type"], "sealed-value cleanup receipt");
  closed(value.result, ["alreadyAbsentValueRefs", "declaredValueRefs", "kind", "remainingValueRefs", "removedValueRefs", "schemaVersion"], "sealed-value cleanup result");
  const declared = run.scenarios.flatMap((scenario) => [
    ...scenario.actions.filter(({ type }) => type === "type_text_ref").map(({ valueRef }) => valueRef),
    ...scenario.assertions.filter(({ type }) => type === "text_ref_present").map(({ expectedRef }) => expectedRef),
  ]).sort();
  for (const field of ["declaredValueRefs", "removedValueRefs", "alreadyAbsentValueRefs", "remainingValueRefs"]) {
    const observed = value.result[field];
    if (!Array.isArray(observed) || observed.some((item) => typeof item !== "string") || new Set(observed).size !== observed.length ||
        JSON.stringify([...observed].sort()) !== JSON.stringify(observed)) fail("SEALED_VALUE_CLEANUP_FAILED", "sealed-value cleanup inventory is not exact and sorted");
  }
  const absent = [...value.result.removedValueRefs, ...value.result.alreadyAbsentValueRefs].sort();
  const base = { schemaVersion: value.schemaVersion, type: value.type, runId: value.runId, inventoryDigest: value.inventoryDigest, result: value.result };
  if (value.schemaVersion !== 1 || value.type !== "sealed-value-terminal-cleanup" || value.runId !== run.runId || value.result.schemaVersion !== 1 ||
      value.result.kind !== "sealed-value-absence" || value.result.remainingValueRefs.length !== 0 ||
      JSON.stringify(value.result.declaredValueRefs) !== JSON.stringify(declared) || JSON.stringify(absent) !== JSON.stringify(declared) ||
      new Set(absent).size !== absent.length || value.inventoryDigest !== contentDigest({ schemaVersion: 1, runId: run.runId, declaredValueRefs: declared }) ||
      value.receiptDigest !== contentDigest(base)) fail("SEALED_VALUE_CLEANUP_FAILED", "sealed-value cleanup receipt does not prove exact terminal absence");
  return value;
}

export class ProductionEvidenceGuardV1 {
  constructor({ admission, run, evidenceRoot, archiveReportRoot, taskSurfaceEvidenceRoot = null, taskSurfaceDiagnosticRoot = null, archiveSurfaceEvidenceRoot = null, independentAttestor, initialReservationObservation = null, networkPolicyObservation = null, clock = Date }) {
    if (!admission?.packetDigest || typeof independentAttestor?.attestVmAbsent !== "function" || networkPolicyObservation === null) fail("INDEPENDENT_ATTESTOR_REQUIRED", "production evidence guard requires independent absence and network-policy attestations");
    this.admission = admission;
    this.run = run;
    this.evidenceRoot = resolve(evidenceRoot);
    this.archiveReportRoot = resolve(archiveReportRoot);
    this.taskSurfaceEvidenceRoot = taskSurfaceEvidenceRoot === null ? null : resolve(taskSurfaceEvidenceRoot);
    this.taskSurfaceDiagnosticRoot = taskSurfaceDiagnosticRoot === null ? null : resolve(taskSurfaceDiagnosticRoot);
    this.archiveSurfaceEvidenceRoot = archiveSurfaceEvidenceRoot === null ? null : resolve(archiveSurfaceEvidenceRoot);
    for (const [label, root] of [["task", this.taskSurfaceEvidenceRoot], ["task diagnostic", this.taskSurfaceDiagnosticRoot], ["archive", this.archiveSurfaceEvidenceRoot]]) {
      if (root !== null) assertWithin(this.evidenceRoot, root, `${label} surface evidence root`);
    }
    this.independentAttestor = independentAttestor;
    this.initialReservationObservation = initialReservationObservation === null ? null : Object.freeze(structuredClone(initialReservationObservation));
    this.clock = clock;
    this.networkPolicyObservation = validateNetworkPolicyObservationV1(networkPolicyObservation, {
      binding: { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken },
      marginMs: 120_000,
      now: clock.now(),
    });
  }

  async prepareBeforeDestroy({ run, currentUsage, plan, providerReceipt, taskPreparation, scenarioResults, archiveConvergence, sealedValueCleanup, evidenceCollection }) {
    exactIdentity(run.provider, this.run.provider); exactIdentity(run.lease, this.run.lease, "STALE_FENCING_TOKEN");
    const requiresQuarantine = scenarioResults.some(({ outcome }) => outcome !== "passed");
    if (!archiveConvergence?.report?.evidence?.length) fail("EVIDENCE_NOT_COLLECTED", "archive visual reports were not committed before cleanup");
    for (const [name, identityFields] of [["screenshots", ["artifactId", "scenarioId", "maxOutputBytes"]], ["recordings", ["artifactId", "scenarioId", "maxOutputBytes", "durationMs"]], ["diagnostics", ["diagnosticId", "scenarioId", "code"]]]) {
      const expected = plan.evidence[name] ?? [];
      const observed = evidenceCollection[name] ?? [];
      if (observed.length !== expected.length || expected.some((spec) => !observed.some((item) => identityFields.every((field) => item[field] === spec[field])))) fail("EVIDENCE_NOT_COLLECTED", `${name} do not exactly match the admitted evidence plan`);
    }
    const mapped = scenarioEvidence(scenarioResults);
    const cleanup = {
      evidenceClass: "cleanup_attestation", runId: run.runId, ...run.provider,
      leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken,
      terminalOutcomeDigest: sha256({ packetDigest: this.admission.packetDigest, type: "pre-destroy-placeholder" }),
    };
    const draftBundlesRoot = join(this.evidenceRoot, "pre-destroy-bundles");
    await mkdir(draftBundlesRoot, { recursive: true, mode: 0o700 });
    let verified;
    const recovered = [];
    for (const entry of await readdir(draftBundlesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || (!entry.name.startsWith(".preparing-") && !/^[0-9a-f]{64}$/u.test(entry.name))) fail("EVIDENCE_TYPE_FORBIDDEN", "draft bundle root contains an unrecognized entry");
      const candidate = join(draftBundlesRoot, entry.name);
      try {
        const candidateBundle = await verifyRemoteDesktopEvidenceBundleV1(candidate, run);
        const expectedName = sha256(candidateBundle.inventory).slice(7);
        if (entry.name.startsWith(".preparing-")) {
          const target = join(draftBundlesRoot, expectedName);
          try { await rename(candidate, target); }
          catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
            const existing = await verifyRemoteDesktopEvidenceBundleV1(target, run);
            if (sha256(existing.inventory).slice(7) !== expectedName) fail("EVIDENCE_INVENTORY_MISMATCH", "recovered draft bundle identity differs");
            await rm(candidate, { force: true, recursive: true });
          }
          recovered.push(target);
        } else {
          if (entry.name !== expectedName) fail("EVIDENCE_INVENTORY_MISMATCH", "draft bundle path is not content-addressed");
          recovered.push(candidate);
        }
      } catch (error) {
        if (!entry.name.startsWith(".preparing-")) throw error;
        await rm(candidate, { force: true, recursive: true });
      }
    }
    const recoveredUnique = [...new Set(recovered)];
    if (recoveredUnique.length > 1) fail("EVIDENCE_INVENTORY_MISMATCH", "multiple pre-destroy bundles require operator reconciliation");
    if (recoveredUnique.length === 1) {
      const bundleDirectory = recoveredUnique[0];
      verified = { ...await verifyRemoteDesktopEvidenceBundleV1(bundleDirectory, run), bundleDirectory };
    } else {
      const temporary = join(draftBundlesRoot, `.preparing-${process.pid}-${this.clock.now()}`);
      try {
        await createRemoteDesktopEvidenceBundleV1({
          bundleDirectory: temporary, run, currentUsage,
          proposedOperationalUsage: plan.evidence.proposedOperationalUsage,
          ...mapped, cleanupAttestation: cleanup,
          screenshots: evidenceCollection.screenshots,
          recordings: evidenceCollection.recordings,
          diagnostics: evidenceCollection.diagnostics,
        });
        verified = await verifyRemoteDesktopEvidenceBundleV1(temporary, run);
        const target = join(draftBundlesRoot, sha256(verified.inventory).slice(7));
        await rename(temporary, target);
        verified = { ...await verifyRemoteDesktopEvidenceBundleV1(target, run), bundleDirectory: target };
      } catch (error) {
        await rm(temporary, { force: true, recursive: true }).catch(() => {});
        throw error;
      }
    }

    const artifactsRoot = join(this.evidenceRoot, "pre-destroy-artifacts");
    await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
    const files = [];
    const expectedProviderBinding = { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken };
    const policyObservedAt = Date.parse(this.networkPolicyObservation.observedAt);
    validateNetworkPolicyObservationV1(this.networkPolicyObservation, {
      binding: expectedProviderBinding,
      marginMs: 120_000,
      now: policyObservedAt,
    });
    files.push(await writeContentAddressedEvidence(artifactsRoot, "network-policy-attestation", "json", Buffer.from(`${JSON.stringify(this.networkPolicyObservation)}\n`)));
    const verifiedSealedValueCleanup = validateSealedValueCleanupReceiptV1(sealedValueCleanup, run);
    files.push(await writeContentAddressedEvidence(artifactsRoot, "sealed-value-cleanup", "json", Buffer.from(`${JSON.stringify(verifiedSealedValueCleanup)}\n`)));
    exactIdentity(providerReceipt, expectedProviderBinding, "DESKTOP_IDENTITY_MISMATCH");
    if (providerReceipt?.operation !== "create" || providerReceipt?.created !== true || providerReceipt?.qgaReady !== true || !SHA256.test(providerReceipt?.attestationDigest ?? "")) {
      fail("DESKTOP_IDENTITY_MISMATCH", "committed provider receipt lacks the verified installed Desktop identity");
    }
    const desktopIdentity = validateInstalledDesktopIdentityV1(providerReceipt.desktopIdentity, run.desktopBundle);
    if (providerReceipt.desktopIdentityDigest !== sha256(desktopIdentity)) fail("DESKTOP_IDENTITY_MISMATCH", "journaled installed Desktop identity digest differs");
    const identityEvidence = {
      schemaVersion: 1, type: "installed-desktop-identity-evidence", runId: run.runId,
      desktopBundle: structuredClone(run.desktopBundle), desktopIdentity, desktopIdentityDigest: providerReceipt.desktopIdentityDigest,
      providerReceiptId: providerReceipt.receiptId,
    };
    files.push(await writeContentAddressedEvidence(artifactsRoot, "installed-desktop-identity", "json", Buffer.from(`${JSON.stringify(identityEvidence)}\n`)));
    const guestTaskBinding = {
      ...run.provider,
      leaseId: run.lease.leaseId,
      fencingToken: run.lease.fencingToken,
      imageId: run.goldenImage.imageId,
      runId: run.runId,
      automationUser: plan.automation.user,
      stateRoot: plan.automation.stateRoot,
    };
    const verifiedTaskPreparation = validateProductionGuestTaskReceiptV1(taskPreparation, {
      intent: this.admission.taskIntentReceipt,
      binding: guestTaskBinding,
    });
    if (run.scenarios.length !== 1 || run.scenarios[0].task.taskId !== verifiedTaskPreparation.taskId ||
        verifiedTaskPreparation.initialTurnStarted !== false) fail("TASK_PREPARATION_RECEIPT_MISMATCH", "guest task receipt differs from the executed scenario identity");
    files.push(await writeContentAddressedEvidence(artifactsRoot, "guest-task-receipt", "json", Buffer.from(`${JSON.stringify(verifiedTaskPreparation)}\n`)));
    const verifiedAuthAttestation = validateLiveAuthAttestation(evidenceCollection.authAttestation, { run, plan }, this.clock, verifiedTaskPreparation.accountBindingDigest);
    files.push(await writeContentAddressedEvidence(artifactsRoot, "account-binding-attestation", "json", Buffer.from(`${JSON.stringify(verifiedAuthAttestation)}\n`)));
    if (!this.admission.verificationReceipt || this.admission.verificationReceiptDigest !== sha256(this.admission.verificationReceipt)) fail("CANDIDATE_INTEGRITY_MISMATCH", "production admission verification receipt is unavailable or altered");
    files.push(await writeContentAddressedEvidence(artifactsRoot, "production-admission-verification", "json", Buffer.from(`${JSON.stringify(this.admission.verificationReceipt)}\n`)));
    for (const ref of verified.inventory.artifacts) {
      if (!["screenshot", "diagnostic"].includes(ref.kind)) continue;
      const bytes = await readFile(join(verified.bundleDirectory, ref.relativePath));
      files.push(await writeContentAddressedEvidence(artifactsRoot, ref.kind === "screenshot" ? "checkpoint-screenshot" : "diagnostics", ref.relativePath.split(".").at(-1), bytes));
    }
    for (const [sourceRoot, role, extension] of [
      [this.taskSurfaceEvidenceRoot, "task-surface-screenshot", "png"],
      [this.taskSurfaceDiagnosticRoot, "task-surface-diagnostic", "json"],
      [this.archiveSurfaceEvidenceRoot, "archive-surface-screenshot", "png"],
    ]) {
      if (sourceRoot === null) continue;
      let entries;
      try { entries = await readdir(sourceRoot, { withFileTypes: true }); }
      catch (error) {
        if (error?.code === "ENOENT" && role === "task-surface-diagnostic" && !requiresQuarantine) continue;
        if (error?.code === "ENOENT") fail("EVIDENCE_NOT_COLLECTED", `${role} was not pulled from the guest before cleanup`);
        throw error;
      }
      if (entries.length < 1 && role === "task-surface-diagnostic" && !requiresQuarantine) continue;
      if (entries.length < 1) fail("EVIDENCE_NOT_COLLECTED", `${role} was not pulled from the guest before cleanup`);
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !new RegExp(`^[0-9a-f]{64}\\.${extension}$`, "u").test(entry.name)) fail("EVIDENCE_TYPE_FORBIDDEN", `${role} source contains a non-content-addressed ${extension.toUpperCase()}`);
        const sourcePath = join(sourceRoot, entry.name); const info = await lstat(sourcePath);
        const maximumBytes = extension === "png" ? 16_777_216 : 65_536;
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximumBytes) fail("UNSAFE_CAPTURE", `${role} is not a bounded regular ${extension.toUpperCase()}`);
        const bytes = await readFile(sourcePath); const sourceDigest = sha256(bytes);
        if (`${sourceDigest.slice(7)}.${extension}` !== entry.name) fail("EVIDENCE_HASH_MISMATCH", `${role} filename and bytes disagree`);
        if (extension === "json") {
          let diagnostic; try { diagnostic = JSON.parse(bytes); } catch { fail("EVIDENCE_INVENTORY_MISMATCH", "task-surface diagnostic is malformed"); }
          closed(diagnostic, ["aggregateCounters", "code", "desktopRenderedLifecycle", "expectedLifecycle", "fencingToken", "mcpLoadState", "nativeLoadState", "observedAt", "runId", "schemaVersion", "taskId", "type"], "task-surface diagnostic");
          if (diagnostic.schemaVersion !== 1 || diagnostic.type !== "task-surface-mismatch" || diagnostic.runId !== run.runId || diagnostic.fencingToken !== run.lease.fencingToken || !Number.isFinite(Date.parse(diagnostic.observedAt))) fail("EVIDENCE_INVENTORY_MISMATCH", "task-surface diagnostic identity differs");
          closed(diagnostic.aggregateCounters, ["nativeCompleted", "nativeDescendantCount", "nativeInterrupted", "nativeTerminal", "nativeWorking", "visualCurrent", "visualDone"], "task-surface diagnostic aggregate counters");
          for (const [field, value] of Object.entries(diagnostic.aggregateCounters)) {
            if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 500)) fail("EVIDENCE_INVENTORY_MISMATCH", `task-surface diagnostic ${field} is not a bounded counter`);
          }
          const { nativeCompleted, nativeDescendantCount, nativeInterrupted, nativeTerminal, nativeWorking, visualCurrent, visualDone } = diagnostic.aggregateCounters;
          if ([nativeCompleted, nativeDescendantCount, nativeInterrupted, nativeTerminal, nativeWorking].every((value) => value !== null) &&
              (nativeTerminal !== nativeCompleted + nativeInterrupted || nativeDescendantCount !== nativeWorking + nativeTerminal)) {
            fail("EVIDENCE_INVENTORY_MISMATCH", "task-surface diagnostic native aggregate counters are internally inconsistent");
          }
          if (visualDone !== null && visualCurrent !== null && visualDone + visualCurrent > 500) fail("EVIDENCE_INVENTORY_MISMATCH", "task-surface diagnostic visual aggregate counters exceed the bounded topology");
        }
        files.push(await writeContentAddressedEvidence(artifactsRoot, role, extension, bytes));
        if (requiresQuarantine && role === "task-surface-screenshot") files.push(await writeContentAddressedEvidence(artifactsRoot, "checkpoint-screenshot", extension, bytes));
        if (requiresQuarantine && role === "task-surface-diagnostic") files.push(await writeContentAddressedEvidence(artifactsRoot, "diagnostics", extension, bytes));
      }
    }
    const expectedReports = new Map();
    for (const { visualReportDigest } of archiveConvergence.report.evidence) expectedReports.set(visualReportDigest, (expectedReports.get(visualReportDigest) ?? 0) + 1);
    const writtenReports = new Set();
    const reportEntries = await readdir(this.archiveReportRoot, { withFileTypes: true });
    for (const entry of reportEntries) {
      if (!entry.isFile() || entry.isSymbolicLink()) fail("EVIDENCE_TYPE_FORBIDDEN", "archive report root contains a non-regular file");
      const reportPath = join(this.archiveReportRoot, entry.name);
      const info = await lstat(reportPath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 10_485_760) fail("UNSAFE_CAPTURE", "archive report is not a bounded regular file");
      const bytes = await readFile(reportPath);
      const reportDigest = sha256(bytes);
      const expectedCount = expectedReports.get(reportDigest) ?? 0;
      if (expectedCount < 1) fail("EVIDENCE_REFERENCE_MISMATCH", "archive report is not referenced by archive convergence");
      if (expectedCount === 1) expectedReports.delete(reportDigest); else expectedReports.set(reportDigest, expectedCount - 1);
      if (!writtenReports.has(reportDigest)) {
        writtenReports.add(reportDigest);
        files.push(await writeContentAddressedEvidence(artifactsRoot, "archive-visual-report", entry.name.split(".").at(-1) || "json", bytes));
      }
    }
    if (expectedReports.size) fail("EVIDENCE_REFERENCE_MISMATCH", "an archive convergence report is missing from the pre-destroy collection");
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const inventory = {
      schemaVersion: 1,
      binding: structuredClone(this.admission.binding),
      files,
      manifestReferences: files.map(({ path }) => path),
      packetDigest: this.admission.packetDigest,
    };
    const stored = await writeContentAddressedJson(this.evidenceRoot, "pre-destroy-inventories", inventory);
    const receipt = {
      schemaVersion: 1, type: "pre-destroy-evidence-inventory", runId: run.runId,
      artifactsRoot, inventoryPath: stored.path, inventoryDigest: stored.digest,
      archiveReportDigests: [...new Set(archiveConvergence.report.evidence.map(({ visualReportDigest }) => visualReportDigest))].sort(),
      packetDigest: this.admission.packetDigest, requiresQuarantine,
      sealedValueCleanupReceiptDigest: verifiedSealedValueCleanup.receiptDigest,
      accountBindingAttestationDigest: verifiedAuthAttestation.attestationDigest,
    };
    await this.verifyBeforeDestroy({ run, draft: receipt, archiveConvergence, allowQuarantineDraft: true });
    return Object.freeze(receipt);
  }

  async verifyBeforeDestroy({ run, draft, archiveConvergence, allowQuarantineDraft = false }) {
    exactIdentity(run.provider, this.run.provider); exactIdentity(run.lease, this.run.lease, "STALE_FENCING_TOKEN");
    if (draft?.type !== "pre-destroy-evidence-inventory" || draft.runId !== run.runId || draft.packetDigest !== this.admission.packetDigest || !SHA256.test(draft.sealedValueCleanupReceiptDigest ?? "") || !SHA256.test(draft.accountBindingAttestationDigest ?? "") || resolve(draft.artifactsRoot ?? "") !== join(this.evidenceRoot, "pre-destroy-artifacts")) fail("EVIDENCE_INVENTORY_MISMATCH", "pre-destroy inventory receipt identity differs");
    if (typeof draft.requiresQuarantine !== "boolean") fail("EVIDENCE_INVENTORY_MISMATCH", "pre-destroy inventory lacks an exact cleanup disposition");
    const inventoryRoot = join(this.evidenceRoot, "pre-destroy-inventories");
    if (resolve(draft.inventoryPath ?? "") !== join(inventoryRoot, `${draft.inventoryDigest?.slice(7)}.json`)) fail("EVIDENCE_PATH_ESCAPE", "pre-destroy inventory is not at its content-addressed evidence path");
    const inventoryInfo = await lstat(draft.inventoryPath);
    if (!inventoryInfo.isFile() || inventoryInfo.isSymbolicLink() || inventoryInfo.nlink !== 1 || inventoryInfo.size > 1_048_576) fail("EVIDENCE_TYPE_FORBIDDEN", "pre-destroy inventory is not a bounded regular file");
    const bytes = await readFile(draft.inventoryPath);
    let inventory;
    try { inventory = JSON.parse(bytes); } catch { fail("EVIDENCE_INVENTORY_MISMATCH", "pre-destroy inventory is not valid JSON"); }
    if (sha256(inventory) !== draft.inventoryDigest) fail("EVIDENCE_HASH_MISMATCH", "pre-destroy inventory digest differs");
    const rootInfo = await lstat(this.evidenceRoot);
    const attested = await attestEvidenceInventory(draft.artifactsRoot, inventory, {
      expectedUid: rootInfo.uid, expectedGid: rootInfo.gid, expectedPacketDigest: this.admission.packetDigest,
    });
    const roles = new Set(inventory.files.map(({ role }) => role));
    assertPreDestroyCollection([
      ...(roles.has("checkpoint-screenshot") || roles.has("task-surface-screenshot") ? ["checkpoint-screenshot"] : []),
      ...(roles.has("diagnostics") || roles.has("task-surface-diagnostic") ? ["diagnostics"] : []),
      "inventory-draft", "destroy",
    ]);
    if (!archiveConvergence?.report?.evidence?.length || !roles.has("archive-visual-report")) fail("EVIDENCE_REQUIRED_ROLE_MISSING", "archive report evidence is absent before destroy");
    if (this.taskSurfaceEvidenceRoot !== null && !roles.has("task-surface-screenshot")) fail("EVIDENCE_REQUIRED_ROLE_MISSING", "digest-bound task sidebar/status screenshot is absent before destroy");
    if (draft.requiresQuarantine === true && this.taskSurfaceDiagnosticRoot !== null && !roles.has("task-surface-diagnostic")) fail("EVIDENCE_REQUIRED_ROLE_MISSING", "sanitized task-surface mismatch diagnostic is absent before quarantine");
    if (this.archiveSurfaceEvidenceRoot !== null && !roles.has("archive-surface-screenshot")) fail("EVIDENCE_REQUIRED_ROLE_MISSING", "archive Desktop screenshot is absent before destroy");
    if (!roles.has("installed-desktop-identity") || !roles.has("production-admission-verification") || !roles.has("guest-task-receipt") || !roles.has("account-binding-attestation") || !roles.has("network-policy-attestation") || !roles.has("sealed-value-cleanup")) fail("EVIDENCE_REQUIRED_ROLE_MISSING", "candidate, installed Desktop, guest task, live account binding, network policy, or sealed-value cleanup identity evidence is absent before destroy");
    const cleanupFiles = inventory.files.filter(({ role }) => role === "sealed-value-cleanup");
    if (cleanupFiles.length !== 1) fail("EVIDENCE_REQUIRED_ROLE_MISSING", "exactly one sealed-value cleanup receipt is required before destroy");
    const cleanupBytes = await readFile(join(draft.artifactsRoot, cleanupFiles[0].path));
    let cleanupReceipt; try { cleanupReceipt = JSON.parse(cleanupBytes); } catch { fail("SEALED_VALUE_CLEANUP_FAILED", "sealed-value cleanup evidence is malformed"); }
    if (validateSealedValueCleanupReceiptV1(cleanupReceipt, run).receiptDigest !== draft.sealedValueCleanupReceiptDigest) fail("SEALED_VALUE_CLEANUP_FAILED", "sealed-value cleanup evidence differs from the journaled receipt");
    const authFiles = inventory.files.filter(({ role }) => role === "account-binding-attestation");
    if (authFiles.length !== 1) fail("EVIDENCE_REQUIRED_ROLE_MISSING", "exactly one live account-binding attestation is required before destroy");
    const authBytes = await readFile(join(draft.artifactsRoot, authFiles[0].path)); let authAttestation;
    try { authAttestation = JSON.parse(authBytes); } catch { fail("AUTH_IDENTITY_MISMATCH", "live account-binding evidence is malformed"); }
    if (validateLiveAuthAttestation(authAttestation, { run, plan: { automation: { user: this.admission.taskIntentReceipt.automationUser } } }, this.clock, null, { requireFresh: false }).attestationDigest !== draft.accountBindingAttestationDigest) fail("AUTH_IDENTITY_MISMATCH", "live account-binding evidence differs from the pre-destroy receipt");
    const expectedReports = [...new Set(archiveConvergence.report.evidence.map(({ visualReportDigest }) => visualReportDigest))].sort();
    const inventoryReports = inventory.files.filter(({ role }) => role === "archive-visual-report").map((file) => file.sha256).sort();
    if (JSON.stringify(expectedReports) !== JSON.stringify(draft.archiveReportDigests) || JSON.stringify(inventoryReports) !== JSON.stringify(draft.archiveReportDigests)) fail("EVIDENCE_REFERENCE_MISMATCH", "archive convergence and content-addressed reports differ");
    if (draft.requiresQuarantine === true && allowQuarantineDraft !== true) fail("SCENARIO_EVIDENCE_REQUIRES_QUARANTINE", "a failed three-surface scenario cannot authorize destructive cleanup");
    return Object.freeze({
      schemaVersion: 1, type: "pre-destroy-evidence-verification", runId: run.runId,
      packetDigest: this.admission.packetDigest, inventoryDigest: draft.inventoryDigest,
      fileCount: attested.files, verifiedAt: new Date(this.clock.now()).toISOString(),
    });
  }

  async attestAfterDestroy({ run, terminalOutcome, draft, preDestroyVerification }) {
    if (terminalOutcome?.outcome !== "destroyed" || terminalOutcome.runId !== run.runId) fail("POST_DESTROY_ATTESTATION_FAILED", "independent absence attestation requires an exact destroyed outcome");
    const archiveConvergence = { report: { evidence: draft.archiveReportDigests.map((visualReportDigest) => ({ visualReportDigest })) } };
    const verified = await this.verifyBeforeDestroy({ run, draft, archiveConvergence });
    if (preDestroyVerification?.inventoryDigest !== verified.inventoryDigest || preDestroyVerification?.packetDigest !== verified.packetDigest) fail("EVIDENCE_INVENTORY_MISMATCH", "journaled pre-destroy verification differs from current evidence");
    const binding = { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken };
    const absence = await this.independentAttestor.attestVmAbsent(structuredClone(binding));
    exactIdentity(absence, binding, "POST_DESTROY_ATTESTATION_FAILED");
    if (absence?.absent !== true || absence.macAbsent !== true || absence.networkInventoryComplete !== true) fail("POST_DESTROY_ATTESTATION_FAILED", "independent read-only inventory did not prove exact VM and cluster-wide MAC absence");
    const base = {
      schemaVersion: 1, type: "independent-post-destroy-attestation", runId: run.runId,
      ...binding, absent: true, packetDigest: this.admission.packetDigest,
      inventoryDigest: draft.inventoryDigest, terminalOutcomeDigest: sha256(terminalOutcome),
      sealedValueCleanupReceiptDigest: draft.sealedValueCleanupReceiptDigest,
      accountBindingAttestationDigest: draft.accountBindingAttestationDigest,
      observedAt: new Date(this.clock.now()).toISOString(),
    };
    return Object.freeze({ ...base, attestationDigest: sha256(base) });
  }

  async attestFinalEvidence({ run, evidence, draft, postDestroyAttestation, sealedValueCleanup }) {
    const verifiedSealedValueCleanup = validateSealedValueCleanupReceiptV1(sealedValueCleanup, run);
    if (postDestroyAttestation?.type !== "independent-post-destroy-attestation" || postDestroyAttestation.runId !== run.runId || postDestroyAttestation.packetDigest !== this.admission.packetDigest || postDestroyAttestation.inventoryDigest !== draft?.inventoryDigest ||
        verifiedSealedValueCleanup.receiptDigest !== draft?.sealedValueCleanupReceiptDigest || postDestroyAttestation.sealedValueCleanupReceiptDigest !== verifiedSealedValueCleanup.receiptDigest ||
        postDestroyAttestation.accountBindingAttestationDigest !== draft?.accountBindingAttestationDigest) fail("POST_DESTROY_ATTESTATION_FAILED", "final evidence is not bound to the independent absence, account binding, and sealed-value cleanup attestations");
    const { attestationDigest, ...postBase } = postDestroyAttestation;
    if (sha256(postBase) !== attestationDigest) fail("POST_DESTROY_ATTESTATION_FAILED", "post-destroy attestation digest differs");
    await this.verifyBeforeDestroy({ run, draft, archiveConvergence: { report: { evidence: draft.archiveReportDigests.map((visualReportDigest) => ({ visualReportDigest })) } } });
    if (resolve(evidence.bundleDirectory ?? "") !== join(this.evidenceRoot, "bundle")) fail("EVIDENCE_PATH_ESCAPE", "final bundle is outside the admitted evidence root");
    const verified = await verifyRemoteDesktopEvidenceBundleV1(evidence.bundleDirectory, run);
    if (sha256(verified.inventory) !== sha256(evidence.inventory)) fail("EVIDENCE_INVENTORY_MISMATCH", "final evidence inventory differs from the journaled bundle");
    const base = {
      schemaVersion: 1, type: "final-evidence-attestation", runId: run.runId,
      packetDigest: this.admission.packetDigest, preDestroyInventoryDigest: draft.inventoryDigest,
      postDestroyAttestationDigest: postDestroyAttestation.attestationDigest,
      sealedValueCleanupReceiptDigest: verifiedSealedValueCleanup.receiptDigest,
      accountBindingAttestationDigest: draft.accountBindingAttestationDigest,
      bundleDirectory: evidence.bundleDirectory, bundleInventoryDigest: sha256(verified.inventory),
      attestedAt: new Date(this.clock.now()).toISOString(),
    };
    return Object.freeze({ ...base, attestationDigest: sha256(base) });
  }
}

export class HomelabEvidenceCollectorV1 {
  constructor({ client, plan, clock = Date }) { this.client = client; this.plan = plan; this.clock = clock; }
  async collect({ run, scenarioResults }) {
    exactIdentity(run.provider, this.client.admitted.run.provider); exactIdentity(run.lease, this.client.admitted.run.lease, "STALE_FENCING_TOKEN");
    if ((this.plan.evidence.recordings ?? []).length) fail("UNAVAILABLE_HELPER", "production recording helper is not configured");
    const completed = new Set(scenarioResults.map(({ scenarioId }) => scenarioId)); const scenarios = new Map(run.scenarios.map((scenario) => [scenario.scenarioId, scenario])); const screenshots = [];
    for (const spec of this.plan.evidence.screenshots ?? []) {
      if (!completed.has(spec.scenarioId)) fail("RUNTIME_IDENTITY_MISMATCH", "evidence request refers to an unexecuted scenario");
      const scenario = scenarios.get(spec.scenarioId);
      if (!scenario) fail("RUNTIME_IDENTITY_MISMATCH", "evidence request lacks its exact admitted scenario");
      const captured = await this.client.invoke({
        helper: ATSPI_HELPER, operation: "capture_evidence",
        payload: { expectedTask: { taskId: scenario.task.taskId, title: scenario.scenarioId } },
        maxOutputBytes: Math.min(this.client.maxOutputBytes, spec.maxOutputBytes * 8),
      });
      const { rgba, regions } = validateExpectedTaskCapture(captured, scenario);
      const exclude = regions.map(({ kind, x, y, width, height }) => ({ kind, x, y, width, height }));
      screenshots.push({ artifactId: spec.artifactId, scenarioId: spec.scenarioId, width: captured.width, height: captured.height, maxOutputBytes: spec.maxOutputBytes, frame: { rgba, sensitiveRegions: exclude.map(({ kind, ...region }) => ({ class: kind, region })), protection: { geometryCertain: true, inventoryComplete: true, mode: "mask", regions: exclude.map(({ kind: _kind, ...region }) => region) } } });
    }
    const diagnostics = [];
    for (const spec of this.plan.evidence.diagnostics ?? []) {
      if (!completed.has(spec.scenarioId)) fail("RUNTIME_IDENTITY_MISMATCH", "diagnostic request refers to an unexecuted scenario");
      const observed = await this.client.invoke({ helper: ATSPI_HELPER, operation: "diagnostics", payload: { scenarioId: spec.scenarioId } });
      closed(observed, ["source", "code", "occurredAt", "fields"], "diagnostic output");
      diagnostics.push({ diagnosticId: spec.diagnosticId, scenarioId: spec.scenarioId, ...observed });
    }
    const authAttestation = validateLiveAuthAttestation(await this.client.invoke({ helper: ATSPI_HELPER, operation: "auth_status" }), this.client.admitted, this.clock);
    return { screenshots, recordings: [], diagnostics, authAttestation };
  }
}

export class ProductionGuiDriverV1 {
  constructor({ driver, client, admitted, surfaceObserver, clock = Date, sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)), syncTimeoutMs = admitted?.homelab?.deadlines?.qgaMs ?? DEFAULTS.deadlines.qgaMs, pollIntervalMs = Math.min(250, syncTimeoutMs), requireAggregateTopology = Boolean(admitted?.runPacket) }) {
    if (typeof driver?.runScenario !== "function" || typeof client?.invoke !== "function" || typeof surfaceObserver?.observeTask !== "function" || typeof clock?.now !== "function" || typeof sleep !== "function" ||
        !Number.isSafeInteger(syncTimeoutMs) || syncTimeoutMs < 1 || syncTimeoutMs > 120_000 || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > syncTimeoutMs || typeof requireAggregateTopology !== "boolean") {
      throw new TypeError("production GUI synchronization configuration is invalid");
    }
    this.driver = driver; this.client = client; this.admitted = admitted; this.surfaceObserver = surfaceObserver; this.clock = clock; this.sleep = sleep; this.syncTimeoutMs = syncTimeoutMs; this.pollIntervalMs = pollIntervalMs; this.requireAggregateTopology = requireAggregateTopology;
  }
  async cleanupSealedValues(valueRefs, options = {}) {
    if (typeof this.driver.cleanupSealedValues !== "function") fail("SEALED_VALUE_CLEANUP_UNAVAILABLE", "production GUI driver cannot attest sealed-value cleanup");
    return this.driver.cleanupSealedValues(valueRefs, options);
  }
  async boundedCall({ code, message, deadlineAt, signal = null, call }) {
    const remaining = deadlineAt - this.clock.now();
    if (remaining <= 0) fail(code, message);
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onExternalAbort); callback(value);
      };
      const rejectDeadline = () => { abort.abort(); finish(rejectPromise, new HomelabDesktopRuntimeError(code, message)); };
      const onExternalAbort = () => rejectDeadline();
      const timer = setTimeout(rejectDeadline, Math.min(remaining, 2_147_483_647));
      signal?.addEventListener("abort", onExternalAbort, { once: true });
      if (signal?.aborted) { onExternalAbort(); return; }
      Promise.resolve().then(() => call({ signal: combined, deadlineAt: new Date(deadlineAt).toISOString() })).then(
        (value) => this.clock.now() >= deadlineAt ? rejectDeadline() : finish(resolvePromise, value),
        (error) => finish(rejectPromise, error),
      );
    });
  }
  assertAggregateTopology(surface) {
    if (!this.requireAggregateTopology) return;
    const aggregate = surface?.aggregateTaskCounters;
    if (!aggregate || Object.keys(aggregate).sort().join("\0") !== ["authoritativeSource", "completed", "current", "descendantCount", "done", "groups", "interrupted", "state", "topologyDigest", "visualCountSemantics", "visualSource", "working"].sort().join("\0") || aggregate.state !== "launched-rows-verified" || aggregate.visualCountSemantics !== "observed-only" ||
        aggregate.authoritativeSource !== "codex-app-server-parent-history-latest-turn" || aggregate.visualSource !== "visible-codex-desktop-atspi" || !SHA256.test(aggregate.topologyDigest ?? "") ||
        ![aggregate.current, aggregate.working, aggregate.done, aggregate.completed, aggregate.interrupted, aggregate.descendantCount].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 500) ||
        !closedAggregateGroups(aggregate.groups) || aggregate.current !== aggregate.groups.needsInput + aggregate.groups.inProgress + aggregate.groups.queued) {
      fail("AGGREGATE_TOPOLOGY_UNSUPPORTED", "production visual counters cannot be accepted without a complete authoritative collaboration-topology inventory");
    }
    if (aggregate.interrupted !== 0) fail("AGGREGATE_INTERRUPTED_SEMANTICS_UNSUPPORTED", "production visual counters cannot classify interrupted descendants without an authoritative Desktop UI contract");
    if (aggregate.descendantCount !== aggregate.working + aggregate.completed) {
      fail("AGGREGATE_TOPOLOGY_UNSUPPORTED", "authoritative collaboration-topology counters are internally inconsistent");
    }
  }
  async poll({ code, message, probe, ready, hardDeadlineAt = null }) {
    const deadlineAt = Math.min(this.clock.now() + this.syncTimeoutMs, hardDeadlineAt ?? Number.MAX_SAFE_INTEGER);
    for (;;) {
      if (this.clock.now() >= deadlineAt) fail(hardDeadlineAt !== null && deadlineAt === hardDeadlineAt ? "RUN_DEADLINE_EXPIRED" : code, message);
      const timeoutCode = hardDeadlineAt !== null && deadlineAt === hardDeadlineAt ? "RUN_DEADLINE_EXPIRED" : code;
      const value = await this.boundedCall({ code: timeoutCode, message, deadlineAt, call: probe });
      if (this.clock.now() >= deadlineAt) fail(hardDeadlineAt !== null && deadlineAt === hardDeadlineAt ? "RUN_DEADLINE_EXPIRED" : code, message);
      if (ready(value)) return value;
      const remaining = deadlineAt - this.clock.now();
      if (remaining <= 0) fail(timeoutCode, message);
      await this.boundedCall({ code: timeoutCode, message, deadlineAt, call: () => this.sleep(Math.min(this.pollIntervalMs, remaining)) });
    }
  }
  async runScenario(scenario, { runDeadlineAt = null } = {}) {
    const runDeadline = runDeadlineAt === null ? null : Date.parse(runDeadlineAt);
    if (runDeadlineAt !== null && !Number.isFinite(runDeadline)) fail("RUN_DEADLINE_EXPIRED", "production GUI received an invalid absolute run deadline");
    const assertRunDeadline = () => {
      if (runDeadline !== null && this.clock.now() >= runDeadline) fail("RUN_DEADLINE_EXPIRED", "production run deadline expired before model-backed GUI work");
    };
    assertRunDeadline();
    const authDeadlineAt = Math.min(this.clock.now() + this.syncTimeoutMs, runDeadline ?? Number.MAX_SAFE_INTEGER);
    const auth = validateLiveAuthAttestation(await this.boundedCall({
      code: runDeadline !== null && authDeadlineAt === runDeadline ? "RUN_DEADLINE_EXPIRED" : "AUTH_OBSERVATION_TIMEOUT",
      message: "live account/read observation did not complete before its deadline", deadlineAt: authDeadlineAt,
      call: ({ signal, deadlineAt }) => this.client.invoke({ helper: ATSPI_HELPER, operation: "auth_status", signal, deadlineAt }),
    }), this.admitted, this.clock);
    assertRunDeadline();
    await this.poll({
      code: "GUI_READINESS_TIMEOUT", message: "graphical control and protected capture did not become ready before the synchronization deadline",
      probe: ({ signal, deadlineAt }) => this.client.invoke({ helper: ATSPI_HELPER, operation: "gui_ready", signal, deadlineAt }),
      ready: (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== ["accessibilityBus", "captureReady", "ready"].sort().join("\0") ||
            ![value.ready, value.accessibilityBus, value.captureReady].every((item) => typeof item === "boolean")) fail("GUI_READINESS_MISMATCH", "graphical readiness observation is not closed metadata");
        return value.ready === true && value.accessibilityBus === true && value.captureReady === true;
      },
      hardDeadlineAt: runDeadline,
    });
    await this.poll({
      code: "EXPECTED_TASK_VISIBILITY_TIMEOUT", message: "the producer-receipt-bound Desktop task did not become visible before the synchronization deadline",
      probe: ({ signal, deadlineAt }) => this.client.invoke({ helper: ATSPI_HELPER, operation: "expected_task_visible", payload: { taskId: scenario.task.taskId, title: scenario.scenarioId }, signal, deadlineAt }),
      ready: (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== ["scan", "schemaVersion", "state", "taskId", "title"].sort().join("\0") ||
            value.schemaVersion !== 1 || value.taskId !== scenario.task.taskId || value.title !== scenario.scenarioId || !["visible", "missing"].includes(value.state) ||
            !value.scan || typeof value.scan !== "object" || Array.isArray(value.scan) || Object.keys(value.scan).sort().join("\0") !== ["complete", "maximumNodes", "scannedNodes"].sort().join("\0") ||
            value.scan.complete !== true || value.scan.maximumNodes !== 10_000 || !Number.isSafeInteger(value.scan.scannedNodes) || value.scan.scannedNodes < 1 || value.scan.scannedNodes > value.scan.maximumNodes) {
          fail("EXPECTED_TASK_VISIBILITY_MISMATCH", "visible Desktop task synchronization proof differs from the producer receipt");
        }
        return value.state === "visible";
      },
      hardDeadlineAt: runDeadline,
    });
    const submitActions = scenario.actions.filter((action) => action.type === "keypress" && this.admitted.homelab.guiBindings[action.targetRef]?.key === "ENTER");
    if (submitActions.length !== 1) fail("INVALID_HOMELAB_CONFIG", "scenario lacks one exact model-submit action boundary");
    assertRunDeadline();
    let activeObserved = false; let activeFailure = null;
    const observeActive = async ({ signal = null } = {}) => {
      activeObserved = true;
      const deadlineAt = Math.min(this.clock.now() + this.syncTimeoutMs, runDeadline ?? Number.MAX_SAFE_INTEGER); let lastError = null;
      for (;;) {
        if (signal?.aborted) fail("ACTION_DEADLINE_EXPIRED", "active three-surface checkpoint was aborted at the action deadline");
        if (runDeadline !== null && this.clock.now() >= runDeadline) fail("RUN_DEADLINE_EXPIRED", "production run deadline expired during the active three-surface checkpoint");
        try {
          const surface = await this.boundedCall({
            code: runDeadline !== null && deadlineAt === runDeadline ? "RUN_DEADLINE_EXPIRED" : "ACTIVE_SURFACE_TIMEOUT",
            message: "active three-surface checkpoint did not converge before its deadline", deadlineAt, signal,
            call: ({ signal: boundedSignal }) => this.surfaceObserver.observeTask({ taskId: scenario.task.taskId, title: scenario.scenarioId, lifecycle: "active" }, { signal: boundedSignal }),
          });
          this.assertAggregateTopology(surface);
          if (this.clock.now() >= deadlineAt) {
            if (runDeadline !== null && deadlineAt === runDeadline) fail("RUN_DEADLINE_EXPIRED", "production run deadline expired during the active three-surface checkpoint");
            fail("ACTIVE_SURFACE_TIMEOUT", "active three-surface checkpoint did not converge before its deadline");
          }
          return;
        } catch (error) {
          if (signal?.aborted || error?.code === "ACTION_DEADLINE_EXPIRED" || error?.code === "RUN_DEADLINE_EXPIRED" || error?.code === "AGGREGATE_TOPOLOGY_UNSUPPORTED") throw error;
          lastError = error;
        }
        const remaining = deadlineAt - this.clock.now();
        if (remaining <= 0) throw lastError ?? new HomelabDesktopRuntimeError("ACTIVE_SURFACE_TIMEOUT", "active three-surface checkpoint did not converge");
        const sleepMs = Math.min(this.pollIntervalMs, remaining);
        await this.boundedCall({
          code: runDeadline !== null && deadlineAt === runDeadline ? "RUN_DEADLINE_EXPIRED" : "ACTIVE_SURFACE_TIMEOUT",
          message: "active three-surface checkpoint did not converge before its deadline", deadlineAt, signal,
          call: () => this.sleep(sleepMs),
        });
      }
    };
    const result = await this.driver.runScenario(scenario, { hardDeadlineAt: runDeadlineAt, beforeAction: async ({ action, signal = null }) => {
      if (action.actionId !== submitActions[0].actionId) return;
      const deadlineAt = Math.min(this.clock.now() + this.syncTimeoutMs, runDeadline ?? Number.MAX_SAFE_INTEGER);
      validateLiveAuthAttestation(await this.boundedCall({
        code: runDeadline !== null && deadlineAt === runDeadline ? "RUN_DEADLINE_EXPIRED" : "AUTH_OBSERVATION_TIMEOUT",
        message: "live account/read changed or timed out at the model-submit boundary", deadlineAt, signal,
        call: ({ signal: boundedSignal, deadlineAt: boundedDeadlineAt }) => this.client.invoke({ helper: ATSPI_HELPER, operation: "auth_status", signal: boundedSignal, deadlineAt: boundedDeadlineAt }),
      }), this.admitted, this.clock, auth.accountBindingDigest);
    }, afterAction: async ({ action, signal = null }) => {
      if (action.actionId !== submitActions[0].actionId) return;
      try { await observeActive({ signal }); }
      catch (error) {
        activeFailure = error;
        if (signal?.aborted || error?.code === "ACTION_DEADLINE_EXPIRED" || error?.code === "RUN_DEADLINE_EXPIRED") throw error;
      }
    } });
    if (result.outcome !== "passed") return result;
    assertRunDeadline();
    let completedFailure = null;
    try {
      const deadlineAt = Math.min(this.clock.now() + this.syncTimeoutMs, runDeadline ?? Number.MAX_SAFE_INTEGER);
      const surface = await this.boundedCall({
        code: runDeadline !== null && deadlineAt === runDeadline ? "RUN_DEADLINE_EXPIRED" : "COMPLETED_SURFACE_TIMEOUT",
        message: "completed three-surface checkpoint did not converge before its deadline", deadlineAt,
        call: ({ signal }) => this.surfaceObserver.observeTask({ taskId: scenario.task.taskId, title: scenario.scenarioId, lifecycle: "completed" }, { signal }),
      });
      this.assertAggregateTopology(surface);
      assertRunDeadline();
    }
    catch (error) { completedFailure = error; }
    const surfaceFailure = activeFailure ?? (!activeObserved ? new HomelabDesktopRuntimeError("ACTIVE_SURFACE_CHECKPOINT_MISSING", "the model-submit action did not produce its active three-surface checkpoint") : null) ?? completedFailure;
    if (surfaceFailure === null) return result;
    return Object.freeze({ ...result, outcome: "failed", failure: { code: surfaceFailure?.code ?? "THREE_SURFACE_IDENTITY_MISMATCH" } });
  }
}

export class HomelabArchiveAdapterV1 {
  constructor({ client, stateRoot, reportRoot = join(stateRoot, "archive-reports"), maxReportBytes, surfaceObserver }) { this.client = client; this.stateRoot = stateRoot; this.reportRoot = reportRoot; this.maxReportBytes = maxReportBytes; this.surfaceObserver = surfaceObserver; }
  async call(operation, payload, { signal = null } = {}) { return this.client.invoke({ helper: ARCHIVE_HELPER, operation, payload, maxOutputBytes: this.maxReportBytes, signal }); }
  async archiveTasks(request, options) { return this.call("archive_tasks", request, options); }
  async restartDesktop(request, options) { return this.call("restart_desktop", request, options); }
  async observeCheckpoint(request, options) {
    if (!Number.isSafeInteger(request?.sequence) || request.sequence < 1 || request.sequence > 1_000_000) {
      fail("INVALID_ARCHIVE_SEQUENCE", "archive checkpoint sequence must be a bounded positive integer");
    }
    const value = await this.surfaceObserver.observeArchive(request, options);
    const visual = value?.visualEvidence; const reportBytes = Buffer.from(visual?.reportBytesBase64 ?? "", "base64");
    if (!reportBytes.length || reportBytes.length > this.maxReportBytes) fail("UNSAFE_CAPTURE", "archive visual report is missing or exceeds its bound");
    const reportDigest = `sha256:${createHash("sha256").update(reportBytes).digest("hex")}`;
    if (visual.reportDigest !== reportDigest) fail("ALTERED_RECEIPT", "archive visual report digest changed in transit");
    await mkdir(this.reportRoot, { recursive: true, mode: 0o700 });
    const reportPath = join(this.reportRoot, `${request.sequence}-${reportDigest.slice(7)}.json`); assertWithin(this.reportRoot, reportPath, "archive report");
    try { const handle = await open(reportPath, "wx", 0o400); try { await handle.writeFile(reportBytes); await handle.sync(); } finally { await handle.close(); } }
    catch (error) { if (error?.code !== "EEXIST" || !(await readFile(reportPath)).equals(reportBytes)) fail("ALTERED_RECEIPT", "archive report was altered"); }
    const { reportBytesBase64: _bytes, reportDigest: _digest, ...visualEvidence } = visual;
    return { ...value, visualEvidence: { ...visualEvidence, report: { path: reportPath, digest: reportDigest } } };
  }
  async reconcileEffect(effect) { return this.call("reconcile_convergence", { effectId: effect.effectId, identityDigest: effect.identityDigest, request: effect.request }); }
}

function effectiveProductionLease(config, productionAdmission, operationMode, clock) {
  if (!config.runPacket) return config.run.lease;
  const receipt = productionAdmission?.currentLeaseObservation;
  if (!receipt || productionAdmission.currentLeaseObservationDigest !== receipt.observationDigest || !SHA256.test(receipt.observationDigest ?? "")) {
    fail("PRODUCTION_ADMISSION_REQUIRED", "runtime lacks the exact fresh current-lease authority receipt");
  }
  const { observationDigest, ...unsignedReceipt } = receipt;
  if (sha256(unsignedReceipt) !== observationDigest) fail("PRODUCTION_ADMISSION_REQUIRED", "runtime current-lease receipt digest differs");
  const record = receipt.authorityObservation?.record;
  const expectedResource = config.run.provider;
  if (!record || record.lease?.leaseId !== config.run.lease.leaseId || record.lease?.holderId !== config.run.lease.holderId ||
      record.lease?.fencingToken !== config.run.lease.fencingToken || record.lease?.runId !== config.run.runId ||
      record.resource?.providerId !== expectedResource.providerId || record.resource?.hostId !== expectedResource.hostId ||
      String(record.resource?.vmid) !== String(expectedResource.vmId)) {
    fail("PRODUCTION_ADMISSION_REQUIRED", "runtime current-lease authority identity differs from the admitted run");
  }
  const expectedDisposition = operationMode === "run" ? "active" : productionAdmission.recoveryMode;
  if (expectedDisposition === "continue" && record.state !== "active") fail("PRODUCTION_ADMISSION_REQUIRED", "continued work requires an active authority record");
  if (expectedDisposition === "active" && record.state !== "active") fail("PRODUCTION_ADMISSION_REQUIRED", "first-run work requires an active authority record");
  if (expectedDisposition === "cleanup-only" && !["active", "cleanup-only"].includes(record.state)) fail("PRODUCTION_ADMISSION_REQUIRED", "cleanup recovery lacks an active or cleanup-only authority record");
  const expiresAt = record.state === "cleanup-only" ? record.lease.cleanupExpiresAt : record.lease.expiresAt;
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= clock.now()) fail("STALE_FENCING_TOKEN", "runtime current-lease authority deadline expired");
  return Object.freeze({
    leaseId: record.lease.leaseId,
    holderId: record.lease.holderId,
    expiresAt,
    fencingToken: record.lease.fencingToken,
    state: record.state,
  });
}

export async function createHomelabRemoteDesktopRuntimeV1(config, { providerTransport = null, providerAdapter = null, independentProviderTransport = null, independentProviderAdapter = null, qgaClient = null, processBoundary = null, independentProcessBoundary = null, productionAdmission = null, taskSurfaceObserver = null, archiveSurfaceObserver = null, operationMode = "run", clock = Date } = {}) {
  if (!["run", "resume", "cancel"].includes(operationMode)) fail("INVALID_HOMELAB_CONFIG", "production runtime operation mode is invalid");
  const effectiveLease = effectiveProductionLease(config, productionAdmission, operationMode, clock);
  const admitted = validateConfig(config, clock, { effectiveLease, operationMode });
  let productionLayout = null;
  if (config.runPacket) {
    if (!productionAdmission?.gateReceipt || productionAdmission.packetDigest !== config.runPacket.digest || productionAdmission.gateReceiptDigest !== sha256(productionAdmission.gateReceipt)) fail("PRODUCTION_ADMISSION_REQUIRED", "runtime did not receive the exact consumed packet authorization");
    productionLayout = validateProductionConfigBindingV1(config, config.runPacket.packet);
    if (productionAdmission.runDeadlineAt !== config.runPacket.packet.budgets.runDeadlineAt) {
      fail("PRODUCTION_ADMISSION_REQUIRED", "runtime admission does not retain the immutable packet run deadline");
    }
    const expectedLeaseAuthority = {
      binding: structuredClone(config.runPacket.packet.leaseAuthority),
      issuedObservationDigest: sha256(config.leaseAuthority),
    };
    if (!fieldsEqual(productionAdmission.leaseAuthority, expectedLeaseAuthority)) {
      fail("PRODUCTION_ADMISSION_REQUIRED", "runtime admission is not bound to the exact issued lease-authority observation");
    }
    await validateSealedRoots(config.runPacket.packet.roots);
  }
  await ensureCanonicalDirectory(admitted.stateRoot, "homelab runtime state", { mode: 0o700, enforceMode: true });
  await ensureCanonicalDirectory(admitted.homelab.sealedValueRoot, "sealed value staging root", { create: false });
  await ensureCanonicalDirectory(admitted.homelab.observationRoot, "runtime observation root", { create: false });
  const boundary = processBoundary ?? new BoundedJsonProcessV1();
  const transport = providerTransport ?? new HomelabProxmoxTransportV1({ processBoundary: boundary, binding: admitted.runtimeBinding, deadlineMs: admitted.homelab.deadlines.providerMs, maxOutputBytes: admitted.homelab.outputLimits.providerBytes, clock });
  const receiptStore = new AtomicProviderReceiptStoreV1(join(admitted.stateRoot, "provider-receipts"));
  const adapter = providerAdapter ?? new ProxmoxVeDesktopAdapterV1({ transport, receiptStore, providerId: admitted.run.provider.providerId });
  let providerMutationGuard = null;
  const beforeProviderMutation = productionLayout === null ? null : async (context) => {
    if (typeof providerMutationGuard !== "function") fail("NETWORK_POLICY_UNAVAILABLE", "provider mutation guard was not initialized from the independent attestor");
    return providerMutationGuard(context);
  };
  const reconciler = new HomelabProviderReconcilerV1({ adapter, receiptStore, admitted, currentLease: effectiveLease, clock });
  const providerController = new ProxmoxDesktopControllerV1({
    adapter,
    ownership: admitted.run.provider,
    currentLease: effectiveLease,
    now: () => clock.now(),
    runDeadlineAt: productionAdmission?.runDeadlineAt ?? null,
    beforeProviderMutation,
    reconcileEffect: (effect, options) => reconciler.reconcile(effect, options),
  });
  const qga = qgaClient ?? new ProxmoxQgaHelperClientV1({ adapter, admitted, deadlineMs: admitted.homelab.deadlines.qgaMs, maxOutputBytes: admitted.homelab.outputLimits.qgaBytes, clock });
  const taskPreparer = productionLayout
    ? new GuestProductionTaskPreparerV1({ client: qga, admitted, intent: productionAdmission.taskIntentReceipt })
    : null;
  const taskSurfaceEvidenceRoot = productionLayout ? join(productionLayout.evidenceRoot, "task-surface-observations") : null;
  const taskSurfaceDiagnosticRoot = productionLayout ? join(productionLayout.evidenceRoot, "task-surface-diagnostics") : null;
  const surfaceObserver = taskSurfaceObserver ?? new ProducerTaskSurfaceObserverV1({ client: qga, binding: admitted.runtimeBinding, evidenceRoot: taskSurfaceEvidenceRoot, diagnosticRoot: taskSurfaceDiagnosticRoot, clock });
  const rawGuiDriver = new DesktopGuiScenarioDriver({ boundary: new QgaAtspiBoundaryV1(qga), sealedValueResolver: new SealedValueResolver({ root: admitted.homelab.sealedValueRoot }), bindings: admitted.homelab.guiBindings, clock });
  const guiDriver = new ProductionGuiDriverV1({ driver: rawGuiDriver, client: qga, admitted, surfaceObserver, clock });
  const archiveQga = qgaClient ?? new ProxmoxQgaHelperClientV1({ adapter, admitted, deadlineMs: Math.min(admitted.homelab.deadlines.archiveMs, admitted.plan.archiveConvergence.policy.maxConvergenceMs), maxOutputBytes: admitted.homelab.outputLimits.archiveReportBytes, clock });
  const archiveReportRoot = productionLayout ? join(productionLayout.evidenceRoot, "archive-reports") : join(admitted.stateRoot, "archive-reports");
  const archiveScreenshotRoot = productionLayout ? join(productionLayout.evidenceRoot, "archive-surface-observations") : null;
  const resolvedArchiveSurfaceObserver = archiveSurfaceObserver ?? new ProducerArchiveSurfaceObserverV1({ client: archiveQga, binding: admitted.runtimeBinding, evidenceRoot: archiveScreenshotRoot, clock });
  const archiveAdapter = new HomelabArchiveAdapterV1({ client: archiveQga, stateRoot: admitted.stateRoot, reportRoot: archiveReportRoot, maxReportBytes: admitted.homelab.outputLimits.archiveReportBytes, surfaceObserver: resolvedArchiveSurfaceObserver });
  const archiveProjectionController = new ArchiveProjectionLaneV1({ adapter: archiveAdapter, clock });
  const evidenceCollector = new HomelabEvidenceCollectorV1({ client: qga, plan: admitted.plan, clock });
  let productionGuard = null;
  if (productionLayout) {
    let independentAttestor = independentProviderAdapter;
    if ((independentAttestor !== null && independentAttestor === providerAdapter) || (independentProviderTransport !== null && independentProviderTransport === providerTransport)) fail("INDEPENDENT_ATTESTOR_REQUIRED", "post-destroy attestation must use a separate read-only provider boundary");
    if (independentAttestor === null) {
      const independentTransport = independentProviderTransport ?? new HomelabProxmoxTransportV1({
        processBoundary: independentProcessBoundary ?? new BoundedJsonProcessV1(),
        binding: admitted.runtimeBinding,
        deadlineMs: admitted.homelab.deadlines.providerMs,
        maxOutputBytes: admitted.homelab.outputLimits.providerBytes,
        executable: ATTEST_HELPER,
        clock,
      });
      if (independentTransport === transport) fail("INDEPENDENT_ATTESTOR_REQUIRED", "post-destroy attestation transport is not independent");
      independentAttestor = new ReadOnlyProxmoxAbsenceAttestorV1({
        transport: independentTransport,
        providerId: admitted.run.provider.providerId,
        hostId: admitted.run.provider.hostId,
        sourceTemplateVmId: admitted.plan.goldenImageTemplateVmId,
      });
    }
    if (typeof independentAttestor?.inspectVm !== "function" || typeof independentAttestor?.attestVmAbsent !== "function" || typeof independentAttestor?.attestNetworkPolicy !== "function") {
      fail("INDEPENDENT_ATTESTOR_REQUIRED", "independent provider adapter cannot perform exact VM, MAC, and network-policy attestations");
    }
    const networkPolicyMarginMs = () => {
      const cleanupMarginMs = admitted.plan.operationUsage.cleanup.wallTimeMs;
      const runDeadline = Date.parse(productionAdmission?.runDeadlineAt ?? "");
      const remainingRunMs = operationMode === "run" && Number.isFinite(runDeadline) ? Math.max(0, runDeadline - clock.now()) : 0;
      return Math.max(120_000, remainingRunMs + cleanupMarginMs);
    };
    const readNetworkPolicy = async () => validateNetworkPolicyObservationV1(
      await independentAttestor.attestNetworkPolicy(),
      { binding: admitted.runtimeBinding, marginMs: networkPolicyMarginMs(), now: clock.now() },
    );
    const networkPolicyObservation = await readNetworkPolicy();
    providerMutationGuard = async (context) => {
      closed(context, ["binding", "mode", "mutation", "operationId"], "provider mutation guard context");
      if (!(["active", "cleanup"].includes(context.mode)) || !["clone", "configure", "start", "stop", "destroy", "quarantine"].includes(context.mutation) || !ID.test(context.operationId ?? "")) {
        fail("NETWORK_POLICY_UNAVAILABLE", "provider mutation is not one bounded admitted lifecycle effect");
      }
      exactIdentity(context.binding, admitted.binding, "NETWORK_POLICY_IDENTITY_MISMATCH");
      const observation = await readNetworkPolicy();
      const journal = new AtomicRemoteDesktopJournal(admitted.journalDirectory);
      await journal.update((value) => {
        exactIdentity(value.run?.provider, admitted.run.provider, "NETWORK_POLICY_IDENTITY_MISMATCH");
        exactIdentity(value.run?.lease, admitted.run.lease, "NETWORK_POLICY_IDENTITY_MISMATCH");
        const existing = Array.isArray(value.networkPolicyMutationAdmissions) ? value.networkPolicyMutationAdmissions : [];
        if (existing.length >= 64) fail("NETWORK_POLICY_UNAVAILABLE", "network-policy mutation admission journal exceeded its bound");
        const entry = {
          schemaVersion: 1,
          type: "network-policy-provider-mutation-admission",
          mode: context.mode,
          mutation: context.mutation,
          operationId: context.operationId,
          observation: structuredClone(observation),
          observationDigest: observation.observationDigest,
        };
        return {
          ...value,
          networkPolicyMutationAdmissions: existing.some((item) => item.operationId === entry.operationId && item.mutation === entry.mutation && item.observationDigest === entry.observationDigest)
            ? existing : [...existing, entry],
        };
      });
      return observation;
    };
    if (operationMode === "run") {
      if (typeof adapter?.inspectGoldenImage !== "function" || typeof independentAttestor?.inspectGoldenImage !== "function") fail("INDEPENDENT_ATTESTOR_REQUIRED", "primary and independent golden-image reads are required before clone");
      const request = { hostId: admitted.run.provider.hostId, templateVmId: String(admitted.plan.goldenImageTemplateVmId) };
      const [primaryGolden, independentGolden] = await Promise.all([
        adapter.inspectGoldenImage(structuredClone(request)),
        independentAttestor.inspectGoldenImage(structuredClone(request)),
      ]);
      assertGoldenImageObservation(primaryGolden, admitted, productionAdmission, "primary");
      assertGoldenImageObservation(independentGolden, admitted, productionAdmission, "independent");
      if (sha256(primaryGolden) !== sha256(independentGolden)) fail("GOLDEN_IMAGE_ATTESTATION_MISMATCH", "primary and independent golden-image observations differ");
    }
    const preMutationVm = await independentAttestor.inspectVm(structuredClone(admitted.run.provider));
    const reservationObservationBase = {
      schemaVersion: 1,
      type: "independent-pre-mutation-vm-observation",
      binding: bindingFor(admitted),
      state: preMutationVm === null ? "absent" : "owned",
      observedAt: new Date(clock.now()).toISOString(),
    };
    const initialReservationObservation = Object.freeze({
      ...reservationObservationBase,
      observationDigest: contentDigest(reservationObservationBase),
    });
    if (operationMode === "run") {
      if (preMutationVm !== null) fail("VM_RESERVATION_NOT_EMPTY", "the independently observed production VM reservation is not empty");
    } else {
      const journal = await new AtomicRemoteDesktopJournal(admitted.journalDirectory).load();
      exactIdentity(journal.run?.provider, admitted.run.provider, "RESUME_IDENTITY_MISMATCH");
      exactIdentity(journal.run?.lease, admitted.run.lease, "RESUME_IDENTITY_MISMATCH");
      const observedState = preMutationVm === null ? "absent" : exactOwnedResumeVm(preMutationVm, admitted) ? "owned" : "foreign";
      if (observedState === "foreign") fail("RESUME_IDENTITY_MISMATCH", "independent resume probe observed a foreign or stale VM identity");
      if (!expectedResumeVmStates(journal).has(observedState)) fail("RECONCILIATION_REQUIRED", "independent resume probe differs from the committed provider lifecycle");
    }
    productionGuard = new ProductionEvidenceGuardV1({ admission: productionAdmission, run: admitted.run, evidenceRoot: productionLayout.evidenceRoot, archiveReportRoot, taskSurfaceEvidenceRoot, taskSurfaceDiagnosticRoot, archiveSurfaceEvidenceRoot: archiveScreenshotRoot, independentAttestor, initialReservationObservation, networkPolicyObservation, clock });
  }
  return Object.freeze({
    providerController,
    guiDriver,
    archiveProjectionController,
    evidenceCollector,
    ...(taskPreparer ? { taskPreparer } : {}),
    ...(productionGuard ? { productionGuard } : {}),
  });
}

export function createRemoteDesktopRuntime(config, options) { return createHomelabRemoteDesktopRuntimeV1(config, options); }

export const HOMELAB_DESKTOP_RUNTIME_DEFAULTS_V1 = DEFAULTS;
