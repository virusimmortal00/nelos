import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ArchiveProjectionLaneV1 } from "./archive-projection-lane.mjs";
import { DesktopGuiScenarioDriver, SealedValueResolver } from "./desktop-gui-scenario-driver/index.mjs";
import { ProxmoxDesktopControllerV1 } from "./remote-desktop-runner/index.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { ProxmoxVeDesktopAdapterV1 } from "../validation/proxmox-desktop/v1/backend/proxmox-ve-adapter.mjs";

const PROVIDER_HELPER = "/usr/libexec/nelos-proxmox-transport";
const ATSPI_HELPER = "/usr/libexec/nelos-desktop-atspi";
const ARCHIVE_HELPER = "/usr/libexec/nelos-desktop-archive";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ATSPI_OPERATIONS = new Set([
  "list_tasks", "activate_expected_task", "active_task", "click", "keypress", "scroll", "select_menu",
  "type_text", "wait_for", "accessibility_tree", "window_state", "query_element", "task_state",
  "text_present", "window_count", "protected_capture_regions", "capture_screenshot", "capture_evidence", "health",
  "gui_ready", "auth_status", "stage_task_surfaces", "stage_archive_observations", "compare_task_surfaces", "diagnostics",
]);
const ARCHIVE_OPERATIONS = new Set(["archive_tasks", "observe_checkpoint", "restart_desktop", "reconcile_convergence"]);
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

function validateConfig(config) {
  plain(config, "config"); plain(config.run, "config.run"); plain(config.plan, "config.plan");
  const homelab = closed(config.homelab, ["schemaVersion", "stateRoot", "sealedValueRoot", "observationRoot", "guiBindings", "deadlines", "outputLimits"], "config.homelab");
  if (homelab.schemaVersion !== 1 || typeof config.run.runId !== "string" || !ID.test(config.run.runId)) fail("INVALID_HOMELAB_CONFIG", "homelab schema or run identity is invalid");
  for (const [field, value] of Object.entries(config.run.provider ?? {})) if (!ID.test(value ?? "")) fail("INVALID_HOMELAB_CONFIG", `run.provider.${field} is invalid`);
  for (const field of ["leaseId", "fencingToken"]) if (!ID.test(config.run.lease?.[field] ?? "")) fail("INVALID_HOMELAB_CONFIG", `run.lease.${field} is invalid`);
  if (!isAbsolute(config.journalDirectory ?? "") || !isAbsolute(config.plan.evidence?.bundleDirectory ?? "") || !isAbsolute(homelab.stateRoot ?? "") || !isAbsolute(homelab.sealedValueRoot ?? "") || !isAbsolute(homelab.observationRoot ?? "")) fail("UNSAFE_RUNTIME_PATH", "runtime, journal, evidence, observation, and sealed roots must be absolute");
  const stateRoot = resolve(homelab.stateRoot);
  if (dirname(resolve(config.journalDirectory)) !== stateRoot || dirname(resolve(config.plan.evidence.bundleDirectory)) !== stateRoot || stateRoot.split(sep).at(-1) !== config.run.runId || resolve(homelab.sealedValueRoot).split(sep).at(-1) !== config.run.runId) fail("WRITABLE_STATE_NOT_ISOLATED", "host state, journal, evidence, and sealed values must be isolated to the admitted run");
  assertWithin(stateRoot, resolve(homelab.observationRoot), "observation root");
  if (config.plan.automation?.stateRoot !== `/var/lib/nelos-desktop/runs/${config.run.runId}` || config.plan.automation?.home !== `/home/${config.plan.automation?.user}` || config.plan.automation?.credentialRefs?.length !== 0) fail("WRITABLE_STATE_NOT_ISOLATED", "guest automation state is not isolated or contains credential references");
  plain(config.currentLease, "config.currentLease");
  exactIdentity(config.currentLease, { ...config.run.provider, ...config.run.lease }, "STALE_FENCING_TOKEN");
  if (config.run.lease.state !== "active" || Date.parse(config.run.lease.expiresAt) <= Date.now()) fail("STALE_FENCING_TOKEN", "the admitted lease is not currently active");
  closed(homelab.deadlines, ["providerMs", "qgaMs", "archiveMs"], "config.homelab.deadlines");
  boundedInteger(homelab.deadlines.providerMs, "providerMs", 300_000); boundedInteger(homelab.deadlines.qgaMs, "qgaMs", 120_000); boundedInteger(homelab.deadlines.archiveMs, "archiveMs", 3_600_000);
  closed(homelab.outputLimits, ["providerBytes", "qgaBytes", "archiveReportBytes"], "config.homelab.outputLimits");
  boundedInteger(homelab.outputLimits.providerBytes, "providerBytes", 16_777_216); boundedInteger(homelab.outputLimits.qgaBytes, "qgaBytes", 16_777_216); boundedInteger(homelab.outputLimits.archiveReportBytes, "archiveReportBytes", 10_485_760);
  plain(homelab.guiBindings, "config.homelab.guiBindings");
  const serialized = JSON.stringify(homelab);
  if (/(?:password|passwd|secret|token|cookie|authorization|credential|sealedValue)(?:"|\s)*:/iu.test(serialized.replace(/"sealedValueRoot"/gu, "\"sealedRoot\""))) fail("FORBIDDEN_RUNTIME_SECRET", "homelab configuration contains a forbidden secret field class");
  return { ...config, homelab: structuredClone(homelab), binding: bindingFor(config), runtimeBinding: runtimeBindingFor(config), stateRoot };
}

export class BoundedJsonProcessV1 {
  constructor({ spawnProcess = spawn } = {}) { this.spawnProcess = spawnProcess; }
  invoke({ executable, operation, payload, inputBytes = null, deadlineMs, maxOutputBytes, signal = null }) {
    if (![PROVIDER_HELPER].includes(executable)) fail("UNAVAILABLE_HELPER", "helper executable is not allowlisted");
    return new Promise((resolvePromise, rejectPromise) => {
      const abort = new AbortController();
      const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      const child = this.spawnProcess(executable, [operation], { shell: false, stdio: ["pipe", "pipe", "ignore"], signal: combined, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
      const chunks = []; let size = 0; let settled = false;
      const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); callback(value); };
      const onAbort = () => { abort.abort(); finish(rejectPromise, new HomelabDesktopRuntimeError("HELPER_DEADLINE", "helper invocation was aborted")); };
      const timer = setTimeout(() => { abort.abort(); finish(rejectPromise, new HomelabDesktopRuntimeError("HELPER_DEADLINE", "helper invocation exceeded its deadline")); }, deadlineMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", () => finish(rejectPromise, new HomelabDesktopRuntimeError("UNAVAILABLE_HELPER", "allowlisted helper is unavailable")));
      child.stdout.on("data", (chunk) => { size += chunk.length; if (size > maxOutputBytes) { abort.abort(); finish(rejectPromise, new HomelabDesktopRuntimeError("HELPER_OUTPUT_LIMIT", "helper output exceeded its bound")); } else chunks.push(chunk); });
      child.once("close", (code) => {
        if (code === 44 && executable === PROVIDER_HELPER && operation === "request") {
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
  constructor({ processBoundary, binding, deadlineMs, maxOutputBytes, clock = Date }) { this.processBoundary = processBoundary; this.binding = binding; this.deadlineMs = deadlineMs; this.maxOutputBytes = maxOutputBytes; this.clock = clock; }
  request(request, options = {}) {
    const deadlineMs = Math.min(options.deadlineMs ?? this.deadlineMs, this.deadlineMs);
    const maxOutputBytes = Math.min(options.maxOutputBytes ?? this.maxOutputBytes, this.maxOutputBytes);
    return this.processBoundary.invoke({ executable: PROVIDER_HELPER, operation: "request", payload: {
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

function receiptFacts(effect, operation = null) {
  if (operation === "quarantine" || effect.kind === "quarantine") return { operation: "quarantine", facts: { quarantined: true, reconciliation: { operationId: effect.request.operationId, ...bindingFor({ run: effect.request }) } } };
  if (effect.kind === "provision") return { operation: "create", facts: { created: true, qgaReady: true, state: "running" } };
  if (effect.kind === "destroy") return { operation: "destroy", facts: { destroyed: true } };
  fail("RECONCILIATION_REQUIRED", "provider effect kind is not reconcilable");
}

export class HomelabProviderReconcilerV1 {
  constructor({ adapter, receiptStore, admitted, clock = Date }) { this.adapter = adapter; this.receiptStore = receiptStore; this.admitted = admitted; this.clock = clock; }
  assertEffect(effect) {
    if (effect?.request?.runId !== this.admitted.run.runId) fail("RUNTIME_IDENTITY_MISMATCH", "provider effect run differs from the admitted run");
    exactIdentity(effect.request.provider, this.admitted.run.provider); exactIdentity(effect.request.lease, this.admitted.run.lease, "STALE_FENCING_TOKEN");
    exactIdentity(effect.request.automation, this.admitted.plan.automation); exactIdentity(effect.request.reservation, this.admitted.plan.reservation);
    if (Date.parse(this.admitted.run.lease.expiresAt) <= this.clock.now()) fail("STALE_FENCING_TOKEN", "lease expired before provider reconciliation");
  }
  async reconcile(effect) {
    this.assertEffect(effect);
    const binding = this.admitted.binding;
    const primary = receiptFacts(effect);
    const operations = effect.kind === "quarantine" ? ["quarantine"] : [primary.operation, "quarantine"];
    let operation = primary.operation; let facts = primary.facts; let receiptId; let persisted = null;
    for (const candidate of operations) {
      const candidateId = `${effect.request.operationId}-${candidate}-receipt`;
      const candidateReceipt = await this.receiptStore.read(candidateId);
      if (candidateReceipt) { operation = candidate; facts = receiptFacts(effect, candidate).facts; receiptId = candidateId; persisted = candidateReceipt; break; }
    }
    receiptId ??= `${effect.request.operationId}-${operation}-receipt`;
    if (!persisted) {
      const observed = await this.adapter.inspectVm(this.admitted.run.provider);
      if (operation === "create") {
        if (observed?.quarantined === true) { operation = "quarantine"; facts = receiptFacts(effect, operation).facts; receiptId = `${effect.request.operationId}-quarantine-receipt`; }
        else {
        exactIdentity(observed, { ...binding, imageId: this.admitted.run.goldenImage.imageId });
        const qga = await this.adapter.waitForQga({ binding, expectedUser: this.admitted.plan.automation.user, expectedSession: "graphical" });
        if (qga?.ready !== true) fail("RECONCILIATION_REQUIRED", "creation cannot be proven complete through read boundaries");
        }
      } else if (operation === "destroy") {
        const absent = await this.adapter.attestVmAbsent(binding); exactIdentity(absent, binding);
        if (absent.absent !== true) {
          if (observed?.quarantined === true) { operation = "quarantine"; facts = receiptFacts(effect, operation).facts; receiptId = `${effect.request.operationId}-quarantine-receipt`; }
          else fail("RECONCILIATION_REQUIRED", "destruction remains ambiguous");
        }
      } else if (!observed?.quarantined) fail("RECONCILIATION_REQUIRED", "quarantine remains ambiguous");
      const base = { receiptId, ...binding, operation, operationId: effect.request.operationId, mutationStatus: "committed", attestationDigest: digest({ binding, operation, operationId: effect.request.operationId, facts }) };
      await this.receiptStore.commit(base); persisted = base;
    }
    exactIdentity(persisted, { receiptId, ...binding, operation, operationId: effect.request.operationId, mutationStatus: "committed" });
    const expectedDigest = digest({ binding, operation, operationId: effect.request.operationId, facts });
    if (persisted.attestationDigest !== expectedDigest || !SHA256.test(persisted.attestationDigest ?? "")) fail("ALTERED_RECEIPT", "persisted provider receipt failed attestation verification");
    if (operation === "destroy") return { receiptId, ...binding, mutationStatus: "committed", destroyed: true, attestationDigest: expectedDigest };
    return { ...persisted, ...facts };
  }
}

export class ProxmoxQgaHelperClientV1 {
  constructor({ adapter, admitted, deadlineMs, maxOutputBytes, clock = Date }) { this.adapter = adapter; this.admitted = admitted; this.deadlineMs = deadlineMs; this.maxOutputBytes = maxOutputBytes; this.clock = clock; }
  async assertGuestIdentity() {
    if (Date.parse(this.admitted.run.lease.expiresAt) <= this.clock.now()) fail("STALE_FENCING_TOKEN", "lease expired before guest helper invocation");
    const observed = await this.adapter.inspectRuntimeBinding(this.admitted.run.provider);
    exactIdentity(observed, this.admitted.runtimeBinding);
  }
  async invoke({ helper, operation, payload = {}, bytes = null, signal = null, maxOutputBytes = this.maxOutputBytes }) {
    const operations = helper === ATSPI_HELPER ? ATSPI_OPERATIONS : helper === ARCHIVE_HELPER ? ARCHIVE_OPERATIONS : null;
    if (!operations?.has(operation)) fail("FORBIDDEN_HELPER_OPERATION", "guest helper or operation is not allowlisted");
    await this.assertGuestIdentity();
    const envelope = Buffer.from(`${JSON.stringify({ schemaVersion: 1, binding: this.admitted.runtimeBinding, operation, payload, byteLength: bytes?.length ?? 0, deadlineAt: new Date(this.clock.now() + this.deadlineMs).toISOString(), maxOutputBytes })}\n`);
    const input = bytes ? Buffer.concat([envelope, bytes]) : envelope;
    const abort = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const timer = setTimeout(() => abort.abort(), this.deadlineMs);
    try {
      const started = Date.now();
      const response = await this.adapter.call("POST", `/nodes/${encodeURIComponent(this.admitted.binding.hostId)}/qemu/${encodeURIComponent(this.admitted.binding.vmId)}/agent/exec`, {
        command: helper, "extra-args": [operation], "input-data": input.toString("base64"), "capture-output": 1,
      }, { signal: combinedSignal, deadlineMs: this.deadlineMs });
      const pid = response?.data?.pid ?? response?.pid ?? response?.data;
      if (!Number.isSafeInteger(pid)) fail("AMBIGUOUS_GUI_EFFECT", "QGA helper start did not return a process identity");
      for (;;) {
        if (combinedSignal.aborted || Date.now() - started >= this.deadlineMs) fail("HELPER_DEADLINE", "guest helper exceeded its deadline");
        const remaining = Math.max(1, this.deadlineMs - (Date.now() - started));
        const statusResponse = await this.adapter.call("GET", `/nodes/${encodeURIComponent(this.admitted.binding.hostId)}/qemu/${encodeURIComponent(this.admitted.binding.vmId)}/agent/exec-status?pid=${pid}`, undefined, { signal: combinedSignal, deadlineMs: remaining });
        const status = statusResponse?.data ?? statusResponse;
        if (status?.exited === 1 || status?.exited === true) {
          if (status.exitcode !== 0) fail("HELPER_FAILED", "guest helper returned a failure");
          const output = Buffer.from(status["out-data"] ?? status.outData ?? "", "base64");
          if (output.length > maxOutputBytes) fail("HELPER_OUTPUT_LIMIT", "guest helper output exceeded its bound");
          try { const parsed = JSON.parse(output.toString("utf8")); return parsed.bytesBase64 === undefined ? parsed : Buffer.from(parsed.bytesBase64, "base64"); }
          catch { fail("INVALID_HELPER_OUTPUT", "guest helper returned invalid bounded output"); }
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    } catch (error) {
      if (combinedSignal.aborted && error?.code !== "HELPER_DEADLINE") fail("HELPER_DEADLINE", "guest helper exceeded its deadline");
      throw error;
    } finally { clearTimeout(timer); envelope.fill(0); input.fill(0); }
  }
}

export class QgaAtspiBoundaryV1 {
  constructor(client) { this.client = client; }
  request(operation, payload = {}, bytes = null, signal = null) { return this.client.invoke({ helper: ATSPI_HELPER, operation, payload, bytes, signal }); }
  listTasks({ signal }) { return this.request("list_tasks", {}, null, signal); } activateExpectedTask({ scenarioId, taskId, title, signal }) { return this.request("activate_expected_task", { scenarioId, taskId, title }, null, signal); }
  activeTask({ signal }) { return this.request("active_task", {}, null, signal); } click({ target, signal }) { return this.request("click", { target }, null, signal); }
  keypress({ target, key, signal }) { return this.request("keypress", { target, key }, null, signal); } scroll({ target, direction, amount, signal }) { return this.request("scroll", { target, direction, amount }, null, signal); }
  selectMenu({ target, menuPath, signal }) { return this.request("select_menu", { target, menuPath }, null, signal); } typeText({ target, bytes, signal }) { return this.request("type_text", { target }, bytes, signal); }
  waitFor({ target, condition, signal }) { return this.request("wait_for", { target, condition }, null, signal); } accessibilityTree({ signal }) { return this.request("accessibility_tree", {}, null, signal); }
  windowState({ signal }) { return this.request("window_state", {}, null, signal); } queryElement({ target, signal }) { return this.request("query_element", { target }, null, signal); }
  taskState({ target, expected, signal }) { return this.request("task_state", { target, expected }, null, signal); } textPresent({ target, bytes, signal }) { return this.request("text_present", { target }, bytes, signal); }
  windowCount({ target, signal }) { return this.request("window_count", { target }, null, signal); } protectedCaptureRegions({ kinds, signal }) { return this.request("protected_capture_regions", { kinds }, null, signal); }
  captureScreenshot({ exclude, signal }) { return this.request("capture_screenshot", { exclude }, null, signal); } health({ signal }) { return this.request("health", {}, null, signal); }
}

function validRegions(regions) {
  return Array.isArray(regions) && ["conversation", "credential"].every((kind) => regions.some((region) => region?.kind === kind && ["x", "y", "width", "height"].every((field) => Number.isSafeInteger(region[field])) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0));
}

export class HomelabEvidenceCollectorV1 {
  constructor({ client, plan }) { this.client = client; this.plan = plan; }
  async collect({ run, scenarioResults }) {
    exactIdentity(run.provider, this.client.admitted.run.provider); exactIdentity(run.lease, this.client.admitted.run.lease, "STALE_FENCING_TOKEN");
    if ((this.plan.evidence.recordings ?? []).length) fail("UNAVAILABLE_HELPER", "production recording helper is not configured");
    const completed = new Set(scenarioResults.map(({ scenarioId }) => scenarioId)); const screenshots = [];
    for (const spec of this.plan.evidence.screenshots ?? []) {
      if (!completed.has(spec.scenarioId)) fail("RUNTIME_IDENTITY_MISMATCH", "evidence request refers to an unexecuted scenario");
      const regions = await this.client.invoke({ helper: ATSPI_HELPER, operation: "protected_capture_regions", payload: { kinds: ["conversation", "credential"] } });
      if (!validRegions(regions)) fail("PROTECTED_GEOMETRY_UNAVAILABLE", "protected-region geometry is incomplete; screenshot was not requested");
      const exclude = regions.map(({ kind, x, y, width, height }) => ({ kind, x, y, width, height }));
      const captured = await this.client.invoke({ helper: ATSPI_HELPER, operation: "capture_evidence", payload: { exclude }, maxOutputBytes: Math.min(this.client.maxOutputBytes, spec.maxOutputBytes * 8) });
      closed(captured, ["width", "height", "rgbaBase64"], "capture output");
      const rgba = Buffer.from(captured.rgbaBase64, "base64");
      if (!Number.isSafeInteger(captured.width) || !Number.isSafeInteger(captured.height) || rgba.length !== captured.width * captured.height * 4) fail("UNSAFE_CAPTURE", "capture dimensions and payload disagree");
      screenshots.push({ artifactId: spec.artifactId, scenarioId: spec.scenarioId, width: captured.width, height: captured.height, maxOutputBytes: spec.maxOutputBytes, frame: { rgba, sensitiveRegions: exclude.map(({ kind, ...region }) => ({ class: kind, region })), protection: { geometryCertain: true, inventoryComplete: true, mode: "mask", regions: exclude.map(({ kind: _kind, ...region }) => region) } } });
    }
    const diagnostics = [];
    for (const spec of this.plan.evidence.diagnostics ?? []) {
      if (!completed.has(spec.scenarioId)) fail("RUNTIME_IDENTITY_MISMATCH", "diagnostic request refers to an unexecuted scenario");
      const observed = await this.client.invoke({ helper: ATSPI_HELPER, operation: "diagnostics", payload: { scenarioId: spec.scenarioId } });
      closed(observed, ["source", "code", "occurredAt", "fields"], "diagnostic output");
      diagnostics.push({ diagnosticId: spec.diagnosticId, scenarioId: spec.scenarioId, ...observed });
    }
    return { screenshots, recordings: [], diagnostics };
  }
}

export class ProductionGuiDriverV1 {
  constructor({ driver, client, admitted, surfaceObserver }) { this.driver = driver; this.client = client; this.admitted = admitted; this.surfaceObserver = surfaceObserver; }
  async runScenario(scenario) {
    const readiness = await this.client.invoke({ helper: ATSPI_HELPER, operation: "gui_ready" });
    if (readiness?.ready !== true || readiness?.accessibilityBus !== true || readiness?.captureReady !== true) fail("GUI_NOT_READY", "graphical control and protected capture are not ready");
    const auth = await this.client.invoke({ helper: ATSPI_HELPER, operation: "auth_status" });
    if (auth?.modelBacked !== true || auth?.developerSessionImported !== false || auth?.automationUser !== this.admitted.plan.automation.user || auth?.runId !== this.admitted.run.runId || auth?.accountCount !== 1) fail("AUTH_IDENTITY_MISMATCH", "run-scoped model authentication is unavailable or contaminated");
    const result = await this.driver.runScenario(scenario);
    if (result.outcome === "passed") {
      const surfaces = await this.surfaceObserver.observeTask({ taskId: scenario.task.taskId, title: scenario.scenarioId, lifecycle: "active" });
      await this.client.invoke({ helper: ATSPI_HELPER, operation: "stage_task_surfaces", payload: { surfaces } });
      const compared = await this.client.invoke({ helper: ATSPI_HELPER, operation: "compare_task_surfaces", payload: { taskId: scenario.task.taskId, title: scenario.scenarioId, lifecycle: "active" } });
      if (compared?.matched !== true || compared?.taskId !== scenario.task.taskId || compared?.lifecycle !== "active") fail("THREE_SURFACE_IDENTITY_MISMATCH", "native, ordinary MCP, and visible Desktop task state disagree");
    }
    return result;
  }
}

export class FileTaskSurfaceObserverV1 {
  constructor({ root, binding, clock = Date }) { this.root = resolve(root); this.binding = binding; this.clock = clock; }
  async read(relativePath) {
    const target = join(this.root, relativePath); assertWithin(this.root, target, "task observation");
    const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1_048_576) fail("OBSERVATION_UNAVAILABLE", "task observation is not a bounded regular file");
    return JSON.parse(await readFile(target, "utf8"));
  }
  validate(value, expected, label) {
    closed(value, ["fencingToken", "lifecycle", "observedAt", "producer", "runId", "schemaVersion", "taskId", "title"], label);
    const observedAt = Date.parse(value.observedAt);
    if (value.schemaVersion !== 1 || value.runId !== this.binding.runId || value.fencingToken !== this.binding.fencingToken || value.taskId !== expected.taskId || value.title !== expected.title || value.lifecycle !== expected.lifecycle || !["native-codex", "ordinary-nelos-mcp", "visible-codex-desktop"].includes(value.producer) || !Number.isFinite(observedAt) || Math.abs(this.clock.now() - observedAt) > 30_000) fail("THREE_SURFACE_IDENTITY_MISMATCH", `${label} is stale or identity-mismatched`);
    return value;
  }
  async observeTask(expected) {
    const entries = await Promise.all(["native", "mcp", "desktop"].map(async (name) => this.validate(await this.read(`task/${name}.json`), expected, `${name} task observation`)));
    return Object.fromEntries(["native", "mcp", "desktop"].map((name, index) => [name, entries[index]]));
  }
  async observeArchive(request) {
    const values = await Promise.all(["native", "mcp", "desktop", "workers"].map((name) => this.read(`archive/${request.phase}/${name}.json`)));
    const now = this.clock.now();
    for (const [index, value] of values.entries()) {
      const observedAt = Date.parse(value?.observedAt);
      if (value?.schemaVersion !== 1 || value.runId !== this.binding.runId || value.fencingToken !== this.binding.fencingToken || !Number.isFinite(observedAt) || Math.abs(now - observedAt) > 30_000) fail("ARCHIVE_OBSERVATION_MISMATCH", `${["native", "mcp", "desktop", "workers"][index]} archive observation is stale or identity-mismatched`);
    }
    return Object.fromEntries(["native", "mcp", "desktop", "workers"].map((name, index) => [name, values[index]]));
  }
}

export class HomelabArchiveAdapterV1 {
  constructor({ client, stateRoot, maxReportBytes, surfaceObserver }) { this.client = client; this.stateRoot = stateRoot; this.maxReportBytes = maxReportBytes; this.surfaceObserver = surfaceObserver; }
  async call(operation, payload, { signal = null } = {}) { return this.client.invoke({ helper: ARCHIVE_HELPER, operation, payload, maxOutputBytes: this.maxReportBytes, signal }); }
  async archiveTasks(request, options) { return this.call("archive_tasks", request, options); }
  async restartDesktop(request, options) { return this.call("restart_desktop", request, options); }
  async observeCheckpoint(request, options) {
    const observations = await this.surfaceObserver.observeArchive(request);
    await this.client.invoke({ helper: ATSPI_HELPER, operation: "stage_archive_observations", payload: { phase: request.phase, observations } });
    const value = await this.call("observe_checkpoint", request, options);
    const visual = value?.visualEvidence; const reportBytes = Buffer.from(visual?.reportBytesBase64 ?? "", "base64");
    if (!reportBytes.length || reportBytes.length > this.maxReportBytes) fail("UNSAFE_CAPTURE", "archive visual report is missing or exceeds its bound");
    const reportDigest = `sha256:${createHash("sha256").update(reportBytes).digest("hex")}`;
    if (visual.reportDigest !== reportDigest) fail("ALTERED_RECEIPT", "archive visual report digest changed in transit");
    const reportRoot = join(this.stateRoot, "archive-reports"); await mkdir(reportRoot, { recursive: true, mode: 0o700 });
    const reportPath = join(reportRoot, `${request.sequence}-${reportDigest.slice(7)}.json`); assertWithin(this.stateRoot, reportPath, "archive report");
    try { const handle = await open(reportPath, "wx", 0o400); try { await handle.writeFile(reportBytes); await handle.sync(); } finally { await handle.close(); } }
    catch (error) { if (error?.code !== "EEXIST" || !(await readFile(reportPath)).equals(reportBytes)) fail("ALTERED_RECEIPT", "archive report was altered"); }
    const { reportBytesBase64: _bytes, reportDigest: _digest, ...visualEvidence } = visual;
    return { ...value, visualEvidence: { ...visualEvidence, report: { path: reportPath, digest: reportDigest } } };
  }
  async reconcileEffect(effect) { return this.call("reconcile_convergence", { effectId: effect.effectId, identityDigest: effect.identityDigest, request: effect.request }); }
}

export async function createHomelabRemoteDesktopRuntimeV1(config, { providerTransport = null, providerAdapter = null, qgaClient = null, processBoundary = null, clock = Date } = {}) {
  const admitted = validateConfig(config);
  await ensureCanonicalDirectory(admitted.stateRoot, "homelab runtime state", { mode: 0o700, enforceMode: true });
  await ensureCanonicalDirectory(admitted.homelab.sealedValueRoot, "sealed value staging root", { create: false });
  await ensureCanonicalDirectory(admitted.homelab.observationRoot, "task observation staging root", { create: false });
  const boundary = processBoundary ?? new BoundedJsonProcessV1();
  const transport = providerTransport ?? new HomelabProxmoxTransportV1({ processBoundary: boundary, binding: admitted.runtimeBinding, deadlineMs: admitted.homelab.deadlines.providerMs, maxOutputBytes: admitted.homelab.outputLimits.providerBytes, clock });
  const receiptStore = new AtomicProviderReceiptStoreV1(join(admitted.stateRoot, "provider-receipts"));
  const adapter = providerAdapter ?? new ProxmoxVeDesktopAdapterV1({ transport, receiptStore, providerId: admitted.run.provider.providerId });
  const reconciler = new HomelabProviderReconcilerV1({ adapter, receiptStore, admitted, clock });
  const providerController = new ProxmoxDesktopControllerV1({ adapter, ownership: admitted.run.provider, currentLease: admitted.run.lease, now: () => clock.now(), reconcileEffect: (effect) => reconciler.reconcile(effect) });
  const qga = qgaClient ?? new ProxmoxQgaHelperClientV1({ adapter, admitted, deadlineMs: admitted.homelab.deadlines.qgaMs, maxOutputBytes: admitted.homelab.outputLimits.qgaBytes, clock });
  const surfaceObserver = new FileTaskSurfaceObserverV1({ root: admitted.homelab.observationRoot, binding: admitted.runtimeBinding, clock });
  const rawGuiDriver = new DesktopGuiScenarioDriver({ boundary: new QgaAtspiBoundaryV1(qga), sealedValueResolver: new SealedValueResolver({ root: admitted.homelab.sealedValueRoot }), bindings: admitted.homelab.guiBindings, clock });
  const guiDriver = new ProductionGuiDriverV1({ driver: rawGuiDriver, client: qga, admitted, surfaceObserver });
  const archiveQga = qgaClient ?? new ProxmoxQgaHelperClientV1({ adapter, admitted, deadlineMs: Math.min(admitted.homelab.deadlines.archiveMs, admitted.plan.archiveConvergence.policy.maxConvergenceMs), maxOutputBytes: admitted.homelab.outputLimits.archiveReportBytes, clock });
  const archiveAdapter = new HomelabArchiveAdapterV1({ client: archiveQga, stateRoot: admitted.stateRoot, maxReportBytes: admitted.homelab.outputLimits.archiveReportBytes, surfaceObserver });
  const archiveProjectionController = new ArchiveProjectionLaneV1({ adapter: archiveAdapter, clock });
  const evidenceCollector = new HomelabEvidenceCollectorV1({ client: qga, plan: admitted.plan });
  return Object.freeze({ providerController, guiDriver, archiveProjectionController, evidenceCollector });
}

export function createRemoteDesktopRuntime(config) { return createHomelabRemoteDesktopRuntimeV1(config); }

export const HOMELAB_DESKTOP_RUNTIME_DEFAULTS_V1 = DEFAULTS;
