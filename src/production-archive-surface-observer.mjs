import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { CodexAppServerBridgeV1 } from "./mcp-app-server-bridge.mjs";
import { BoundedNelosMcpClientV1, PRODUCTION_TASK_SURFACE_EXECUTABLES_V1 } from "./production-task-surface-observer.mjs";
import { assertCapturePrivacyPixelsV1, capturePrivacyProofV1, protectedCaptureRegionsV1 } from "./protected-capture-proof.mjs";
import { runtimeGenerationKeyV1 } from "./runtime-worker-registry.mjs";

const THREAD_ID = /^[a-f0-9-]{8,80}$/u;
const WORKER_ID = /^worker:[a-f0-9]{64}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RUNTIME_IDENTITY_FIELDS = ["buildIdentity", "cacheIdentity", "integrity", "modulePath", "sourceRevision", "version"];
const ARCHIVE_SURFACE_CONTRACTS = new Map([
  ["sidebar", { contract: "codex-desktop-sidebar-app-action-v1", states: new Set(["present"]) }],
  ["createdTasks", { contract: "codex-desktop-created-tasks-summary-v1", states: new Set(["empty", "present"]) }],
  ["mcpVisual", { contract: "nelos-mcp-task-workers-v1", states: new Set(["present"]) }],
]);

export class ProductionArchiveSurfaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProductionArchiveSurfaceError";
    this.code = code;
  }
}

function fail(code, message) { throw new ProductionArchiveSurfaceError(code, message); }
function fields(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function exactIds(value, label, maximum = 500) {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length || value.some((id) => !THREAD_ID.test(id ?? ""))) fail("ARCHIVE_OBSERVATION_MISMATCH", `${label} is not an exact bounded task inventory`);
  return [...value].sort();
}
function exactWorkers(value, expectedIds) {
  const expectedSet = new Set(expectedIds);
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail("ARCHIVE_OBSERVATION_MISMATCH", "ordinary MCP worker lifecycle inventory is not bounded");
  const workers = value.map((worker) => {
    if (!fields(worker, ["archivedThreadIds", "workerId"]) || !WORKER_ID.test(worker.workerId ?? "")) fail("ARCHIVE_OBSERVATION_MISMATCH", "ordinary MCP worker identity is incompatible");
    const archivedThreadIds = exactIds(worker.archivedThreadIds, "ordinary MCP worker archived tasks", 100);
    if (archivedThreadIds.some((id) => !expectedSet.has(id))) fail("ARCHIVE_OBSERVATION_MISMATCH", "ordinary MCP worker reported an unrequested archive identity");
    return { workerId: worker.workerId, archivedThreadIds };
  });
  if (new Set(workers.map(({ workerId }) => workerId)).size !== workers.length) fail("ARCHIVE_OBSERVATION_MISMATCH", "ordinary MCP worker lifecycle inventory contains duplicates");
  return workers;
}
function exactSurfaceScans(value, inventories, screen, globalScannedNodes) {
  if (!Array.isArray(value) || value.length !== ARCHIVE_SURFACE_CONTRACTS.size) fail("ARCHIVE_OBSERVATION_MISMATCH", "Desktop archive surface proof set is incomplete");
  const geometries = new Set();
  return value.map((proof, index) => {
    const [surface, expected] = [...ARCHIVE_SURFACE_CONTRACTS][index]; const ids = inventories[surface];
    if (!fields(proof, ["accessibilityRole", "contract", "geometry", "scan", "state", "surface", "threadIds"]) ||
        proof.surface !== surface || proof.contract !== expected.contract || !expected.states.has(proof.state) ||
        typeof proof.accessibilityRole !== "string" || proof.accessibilityRole.length < 1 || proof.accessibilityRole.length > 128 ||
        !Array.isArray(proof.threadIds) || JSON.stringify(proof.threadIds) !== JSON.stringify(ids) || (proof.state === "empty" && ids.length !== 0) ||
        !fields(proof.geometry, ["height", "width", "x", "y"]) ||
        ![proof.geometry.x, proof.geometry.y, proof.geometry.width, proof.geometry.height].every(Number.isSafeInteger) ||
        proof.geometry.x < 0 || proof.geometry.y < 0 || proof.geometry.width < 1 || proof.geometry.height < 1 ||
        proof.geometry.x + proof.geometry.width > screen.width || proof.geometry.y + proof.geometry.height > screen.height ||
        !fields(proof.scan, ["complete", "maximumNodes", "scannedNodes"]) || proof.scan.complete !== true || proof.scan.maximumNodes !== 10_000 ||
        !Number.isSafeInteger(proof.scan.scannedNodes) || proof.scan.scannedNodes < 1 || proof.scan.scannedNodes > globalScannedNodes) {
      fail("ARCHIVE_OBSERVATION_MISMATCH", `${surface} does not carry an exact bounded accessibility-container proof`);
    }
    const geometry = `${proof.geometry.x}:${proof.geometry.y}:${proof.geometry.width}:${proof.geometry.height}`;
    if (geometries.has(geometry)) fail("ARCHIVE_OBSERVATION_MISMATCH", "Desktop archive surfaces alias one accessibility container");
    geometries.add(geometry);
    return structuredClone(proof);
  });
}
function expectedRequest(value) {
  const requestFields = value?.expectedAppInstanceId === undefined
    ? ["expectedThreads", "phase", "runId", "schemaVersion", "sequence"]
    : ["expectedAppInstanceId", "expectedThreads", "phase", "runId", "schemaVersion", "sequence"];
  if (!fields(value, requestFields) || value.schemaVersion !== 1 || !["afterCleanup", "afterRestart"].includes(value.phase) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > 50 ||
      !Array.isArray(value.expectedThreads) || value.expectedThreads.length < 1 || value.expectedThreads.length > 100 ||
      value.expectedThreads.some((thread) => !fields(thread, ["threadId", "title"]) || !THREAD_ID.test(thread.threadId ?? "") || typeof thread.title !== "string" || thread.title.length < 1 || thread.title.length > 240 || /[\u0000-\u001f\u007f]/u.test(thread.title)) ||
      new Set(value.expectedThreads.map(({ threadId }) => threadId)).size !== value.expectedThreads.length ||
      new Set(value.expectedThreads.map(({ title }) => title)).size !== value.expectedThreads.length ||
      (value.expectedAppInstanceId !== undefined && !/^desktop-pid-[1-9][0-9]{0,9}$/u.test(value.expectedAppInstanceId))) {
    fail("INVALID_ARCHIVE_OBSERVATION_REQUEST", "archive observation request does not match the closed contract");
  }
  return value;
}

export class NativeCodexArchiveObserverV1 {
  constructor({ bridgeFactory = (command) => new CodexAppServerBridgeV1({ command }) } = {}) { this.bridgeFactory = bridgeFactory; }
  async observe(expectedThreads) {
    const bridge = this.bridgeFactory(PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.codex);
    try {
      const ids = expectedThreads.map(({ threadId }) => threadId); const visibleThreadIds = [];
      for (let index = 0; index < ids.length; index += 16) {
        visibleThreadIds.push(...await bridge.visibleThreadIds({ threadIds: ids.slice(index, index + 16) }));
      }
      return { producer: "native-codex-app-server", method: "thread/list", visibleThreadIds: exactIds(visibleThreadIds, "native visible tasks", 100) };
    } catch (error) {
      if (error instanceof ProductionArchiveSurfaceError) throw error;
      fail("OBSERVATION_UNAVAILABLE", "native Codex app-server visible inventory failed");
    } finally { await bridge.close?.(); }
  }
}

function validateMcpProjection(value, expectedIds) {
  const inventory = value?.inventory;
  if (!fields(inventory, ["failed", "items", "requested", "schemaVersion", "succeeded"]) || inventory.schemaVersion !== 1 || inventory.requested !== expectedIds.length ||
      !Number.isSafeInteger(inventory.succeeded) || !Number.isSafeInteger(inventory.failed) || inventory.succeeded + inventory.failed !== expectedIds.length ||
      !Array.isArray(inventory.items) || inventory.items.length !== expectedIds.length) fail("OBSERVATION_UNAVAILABLE", "nelos_thread_inventory returned an incompatible bounded inventory");
  const visible = [];
  for (const [index, item] of inventory.items.entries()) {
    if (item?.threadId !== expectedIds[index]) fail("ARCHIVE_OBSERVATION_MISMATCH", "Nelos MCP reordered or substituted an archive task identity");
    if (item.state === "ready") {
      if (!fields(item, ["state", "thread", "threadId"]) || item.thread?.schemaVersion !== 1 || item.thread?.threadId !== item.threadId) fail("OBSERVATION_UNAVAILABLE", "Nelos MCP ready archive item is malformed");
      visible.push(item.threadId);
    } else if (item.state === "failed") {
      if (!fields(item, ["error", "state", "threadId"]) || !fields(item.error, ["code", "retriable"]) || item.error.retriable !== false || !["invalid-response", "request-rejected"].includes(item.error.code)) {
        fail("OBSERVATION_UNAVAILABLE", "Nelos MCP archive absence is ambiguous or retriable");
      }
    } else fail("OBSERVATION_UNAVAILABLE", "Nelos MCP archive item has an unsupported state");
  }
  const registry = value?.health?.registry;
  if (!fields(registry, ["activeGenerations", "liveWorkerCount", "mutationAllowed", "recoveredWorkerIds", "state"]) || registry.state !== "single-generation" || registry.mutationAllowed !== true ||
      !Number.isSafeInteger(registry.liveWorkerCount) || registry.liveWorkerCount < 1 || registry.liveWorkerCount > 32 || !Array.isArray(registry.activeGenerations) || registry.activeGenerations.length !== 1 ||
      !Array.isArray(registry.recoveredWorkerIds) || registry.recoveredWorkerIds.length > 32 || new Set(registry.recoveredWorkerIds).size !== registry.recoveredWorkerIds.length ||
      registry.recoveredWorkerIds.some((workerId) => !WORKER_ID.test(workerId))) fail("OBSERVATION_UNAVAILABLE", "Nelos runtime worker registry did not prove one live generation");
  const generation = registry.activeGenerations[0];
  let exactGeneration = false;
  try {
    exactGeneration = fields(generation, ["generationKey", "identity", "workers"]) && fields(generation.identity, RUNTIME_IDENTITY_FIELDS) &&
      generation.generationKey === runtimeGenerationKeyV1(generation.identity);
  } catch { exactGeneration = false; }
  if (!exactGeneration || !Array.isArray(generation.workers) || generation.workers.length !== registry.liveWorkerCount) fail("OBSERVATION_UNAVAILABLE", "Nelos runtime generation inventory is incompatible");
  const registryWorkers = generation.workers.map((worker) => {
    if (!fields(worker, ["heartbeatAt", "pid", "state", "workerId"]) || !WORKER_ID.test(worker.workerId ?? "") || !["active", "draining"].includes(worker.state) ||
        !Number.isSafeInteger(worker.pid) || worker.pid < 1 || !ISO.test(worker.heartbeatAt ?? "") || !Number.isFinite(Date.parse(worker.heartbeatAt))) fail("OBSERVATION_UNAVAILABLE", "Nelos runtime worker lifecycle is incompatible");
    return worker;
  });
  if (new Set(registryWorkers.map(({ workerId }) => workerId)).size !== registryWorkers.length) fail("OBSERVATION_UNAVAILABLE", "Nelos runtime worker inventory contains duplicate identities");
  const producingWorkers = registryWorkers.filter(({ pid }) => pid === value.workerPid);
  if (!Number.isSafeInteger(value.workerPid) || value.workerPid < 1 || producingWorkers.length !== 1) fail("OBSERVATION_UNAVAILABLE", "Nelos runtime health did not identify the exact MCP worker that produced the archive projection");
  const workers = [{ workerId: producingWorkers[0].workerId, archivedThreadIds: expectedIds.filter((id) => !visible.includes(id)) }];
  return { producer: "packaged-nelos-mcp", serverVersion: value.serverVersion, tool: "nelos_thread_inventory+nelos_runtime_health", visibleThreadIds: visible.sort(), workers };
}

export class NelosMcpArchiveObserverV1 {
  constructor({ client = new BoundedNelosMcpClientV1() } = {}) { this.client = client; }
  async observe(expectedThreads) {
    const expectedIds = expectedThreads.map(({ threadId }) => threadId);
    const value = await this.client.callArchiveProjection(expectedIds);
    return validateMcpProjection(value, expectedIds);
  }
}

export class GuestNativeCodexArchiveObserverV1 {
  constructor({ client } = {}) {
    if (typeof client?.invoke !== "function") throw new TypeError("guest native archive observer requires a QGA client");
    this.client = client;
  }
  observe(expectedThreads, { signal = null } = {}) {
    return this.client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "observe_native_archive", payload: { expectedThreads }, ...(signal === null ? {} : { signal }) });
  }
}

export class GuestNelosMcpArchiveObserverV1 {
  constructor({ client } = {}) {
    if (typeof client?.invoke !== "function") throw new TypeError("guest MCP archive observer requires a QGA client");
    this.client = client;
  }
  observe(expectedThreads, { signal = null } = {}) {
    return this.client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "observe_mcp_archive", payload: { expectedThreads }, ...(signal === null ? {} : { signal }) });
  }
}

async function immutableScreenshot(root, digest, bytes) {
  if (root === null) return null;
  const target = join(root, `${digest.slice(7)}.png`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(target, "wx", 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !(await readFile(target)).equals(bytes)) fail("ALTERED_RECEIPT", "controller archive screenshot was altered");
  }
  return target;
}

async function validateDesktop(value, request, binding, now, evidenceRoot) {
  if (!fields(value, ["appInstanceId", "createdTasksThreadIds", "fencingToken", "mcpVisualThreadIds", "observedAt", "phase", "producer", "runId", "scan", "schemaVersion", "screenshot", "screenshotThreadIds", "sequence", "sidebarThreadIds", "surfaceScans"]) ||
      value.schemaVersion !== 1 || value.runId !== binding.runId || value.fencingToken !== binding.fencingToken || value.sequence !== request.sequence || value.phase !== request.phase || value.producer !== "visible-codex-desktop-atspi" ||
      !/^desktop-pid-[1-9][0-9]{0,9}$/u.test(value.appInstanceId ?? "") || (request.expectedAppInstanceId !== undefined && value.appInstanceId !== request.expectedAppInstanceId) ||
      !fields(value.scan, ["complete", "maximumNodes", "scannedNodes"]) || value.scan.complete !== true || value.scan.maximumNodes !== 10_000 || !Number.isSafeInteger(value.scan.scannedNodes) || value.scan.scannedNodes < 1 || value.scan.scannedNodes > value.scan.maximumNodes ||
      !Number.isFinite(Date.parse(value.observedAt)) || Math.abs(now - Date.parse(value.observedAt)) > 30_000) fail("ARCHIVE_OBSERVATION_MISMATCH", "visible Desktop archive observation is stale or identity-mismatched");
  const sidebarThreadIds = exactIds(value.sidebarThreadIds, "Desktop sidebar tasks");
  const createdTasksThreadIds = exactIds(value.createdTasksThreadIds, "Desktop created-task projection");
  const mcpVisualThreadIds = exactIds(value.mcpVisualThreadIds, "Desktop MCP visual projection");
  const screenshotThreadIds = exactIds(value.screenshotThreadIds, "Desktop screenshot task coverage", 100);
  const expectedIds = new Set(request.expectedThreads.map(({ threadId }) => threadId));
  const visualIds = new Set([...sidebarThreadIds, ...createdTasksThreadIds, ...mcpVisualThreadIds]);
  if ([sidebarThreadIds, createdTasksThreadIds, mcpVisualThreadIds, screenshotThreadIds].some((ids) => ids.some((id) => !expectedIds.has(id))) || screenshotThreadIds.some((id) => !visualIds.has(id))) fail("ARCHIVE_OBSERVATION_MISMATCH", "visible Desktop archive inventory contains an unrelated task identity");
  const shot = value.screenshot;
  if (!fields(shot, ["byteLength", "bytesBase64", "digest", "height", "mediaType", "path", "privacy", "protectedInventory", "protectedRegions", "protection", "width"]) || shot.mediaType !== "image/png" || !SHA256.test(shot.digest ?? "") ||
      !Number.isSafeInteger(shot.byteLength) || shot.byteLength < 1 || !Number.isSafeInteger(shot.width) || shot.width < 1 || !Number.isSafeInteger(shot.height) || shot.height < 1 ||
      !fields(shot.protection, ["geometryCertain", "inventoryComplete", "mode"]) || shot.protection.geometryCertain !== true || shot.protection.inventoryComplete !== true || shot.protection.mode !== "mask") fail("UNSAFE_CAPTURE", "Desktop archive screenshot envelope is incompatible");
  const surfaceScans = exactSurfaceScans(value.surfaceScans, { sidebar: value.sidebarThreadIds, createdTasks: value.createdTasksThreadIds, mcpVisual: value.mcpVisualThreadIds }, { width: shot.width, height: shot.height }, value.scan.scannedNodes);
  const bytes = Buffer.from(shot.bytesBase64, "base64");
  try {
    let regions; try { regions = protectedCaptureRegionsV1(shot.protectedInventory, { screen: { width: shot.width, height: shot.height } }); } catch { fail("UNSAFE_CAPTURE", "Desktop archive protected inventory is incomplete"); }
    let preserved;
    try {
      preserved = capturePrivacyProofV1(shot.privacy, {
        screen: { width: shot.width, height: shot.height }, protectedRegions: regions,
        mode: "expected-archive-evidence-only", expectedTaskIds: request.expectedThreads.map(({ threadId }) => threadId),
      });
    } catch { fail("UNSAFE_CAPTURE", "Desktop archive capture did not prove full-frame masking with an expected-task-only allowlist"); }
    const preservedTitleIds = preserved.filter(({ kind }) => kind === "expected-task-title").map(({ taskId }) => taskId).sort();
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (!bytes.length || bytes.length !== shot.byteLength || digest !== shot.digest || JSON.stringify(regions) !== JSON.stringify(shot.protectedRegions) ||
        shot.privacy.traversal.scannedNodes !== shot.protectedInventory.traversal.scannedNodes || JSON.stringify(preservedTitleIds) !== JSON.stringify(screenshotThreadIds) ||
        shot.path !== `${binding.stateRoot}/archive-surface-observations/${digest.slice(7)}.png`) fail("UNSAFE_CAPTURE", "Desktop archive screenshot bytes, path, privacy allowlist, or geometry differ");
    try {
      assertCapturePrivacyPixelsV1(bytes, {
        screen: { width: shot.width, height: shot.height },
        preservedRegions: preserved,
        protectedRegions: regions,
        requireSignal: preserved.length > 0,
      });
    } catch {
      fail("UNSAFE_CAPTURE", "Desktop archive PNG exposes pixels outside the exact expected-task allowlist");
    }
    const controllerPath = await immutableScreenshot(evidenceRoot, digest, bytes);
    return {
      appInstanceId: value.appInstanceId, observedAt: value.observedAt, sidebarThreadIds, createdTasksThreadIds, mcpVisualThreadIds,
      surfaceScans,
      capture: { digest, privacy: { maskedBase: shot.privacy.maskedBase, mode: shot.privacy.mode, preservedTaskIds: screenshotThreadIds, rawPixelsPersisted: false }, ...(controllerPath === null ? {} : { path: controllerPath }) },
    };
  } finally { bytes.fill(0); }
}

export class ProducerArchiveSurfaceObserverV1 {
  constructor({ client, binding, nativeObserver = null, mcpObserver = null, evidenceRoot = null, clock = Date } = {}) {
    if (typeof client?.invoke !== "function") throw new TypeError("archive observer requires a QGA client");
    if (!fields(binding, ["automationUser", "fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "stateRoot", "vmId"])) throw new TypeError("archive observer binding is incompatible");
    if (evidenceRoot !== null && (!isAbsolute(evidenceRoot) || resolve(evidenceRoot) === "/")) throw new TypeError("archive evidence root must be an absolute bounded directory");
    this.client = client; this.binding = binding;
    this.nativeObserver = nativeObserver ?? new GuestNativeCodexArchiveObserverV1({ client });
    this.mcpObserver = mcpObserver ?? new GuestNelosMcpArchiveObserverV1({ client });
    this.evidenceRoot = evidenceRoot === null ? null : resolve(evidenceRoot); this.clock = clock;
  }

  async observeArchive(rawRequest, { signal = null } = {}) {
    const request = expectedRequest(rawRequest); const expectedIds = request.expectedThreads.map(({ threadId }) => threadId);
    const [native, mcp, rawDesktop] = await Promise.all([
      this.nativeObserver.observe(request.expectedThreads, { signal }),
      this.mcpObserver.observe(request.expectedThreads, { signal }),
      this.client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "observe_archive_surface", payload: request, signal }),
    ]);
    const nativeVisible = exactIds(native.visibleThreadIds, "native visible tasks", 100);
    const mcpVisible = exactIds(mcp.visibleThreadIds, "ordinary MCP visible tasks", 100);
    const mcpWorkers = exactWorkers(mcp.workers, expectedIds);
    if (JSON.stringify(nativeVisible) !== JSON.stringify(mcpVisible)) fail("ARCHIVE_OBSERVATION_MISMATCH", "native Codex and packaged Nelos MCP disagree on archived task visibility");
    const now = this.clock.now(); const desktop = await validateDesktop(rawDesktop, request, this.binding, now, this.evidenceRoot);
    const visualIds = [...new Set([...desktop.sidebarThreadIds, ...desktop.createdTasksThreadIds, ...desktop.mcpVisualThreadIds])];
    const staleIds = expectedIds.filter((id) => nativeVisible.includes(id) || visualIds.includes(id) || mcpWorkers.some(({ archivedThreadIds }) => !archivedThreadIds.includes(id)));
    const report = {
      schemaVersion: 1, kind: "nelos-developer-visual-state-validation", capture: desktop.capture,
      surfaceScans: desktop.surfaceScans,
      outcome: staleIds.length === 0 ? "passed" : "failed",
      counts: { expected: expectedIds.length, nativeVisible: nativeVisible.length, ordinaryMcpVisible: mcpVisible.length, desktopVisible: visualIds.length, workers: mcpWorkers.length },
      findings: staleIds.map((threadId) => ({ code: "ARCHIVE_PROJECTION_VISIBLE", threadId })),
    };
    const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`); const reportDigest = `sha256:${createHash("sha256").update(reportBytes).digest("hex")}`;
    return {
      sequence: request.sequence, observedAt: new Date(now).toISOString(), phase: request.phase, appInstanceId: desktop.appInstanceId,
      cleanupState: staleIds.length === 0 ? "complete" : "attention", nelosWorkers: mcpWorkers,
      ordinaryMapThreadIds: mcpVisible, nativeVisibleThreadIds: nativeVisible,
      visualEvidence: { reportBytesBase64: reportBytes.toString("base64"), reportDigest, sidebarThreadIds: desktop.sidebarThreadIds, createdTasksThreadIds: desktop.createdTasksThreadIds, mcpVisualThreadIds: desktop.mcpVisualThreadIds },
    };
  }
}
