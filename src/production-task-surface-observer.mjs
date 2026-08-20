import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerBridgeV1 } from "./mcp-app-server-bridge.mjs";
import { assertCapturePrivacyPixelsV1, capturePrivacyProofV1, protectedCaptureRegionsV1 } from "./protected-capture-proof.mjs";
import { runtimeGenerationKeyV1 } from "./runtime-worker-registry.mjs";

const PINNED_CODEX_COMMAND = process.platform === "darwin"
  ? "/Applications/ChatGPT.app/Contents/Resources/codex"
  : "/usr/lib/chatgpt/resources/codex";
const PACKAGED_NELOS_MCP = fileURLToPath(new URL("../bin/nelos-mcp", import.meta.url));
const THREAD_STATUSES = new Set(["active", "idle", "notLoaded", "systemError"]);
const ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const EXPECTED_LIFECYCLES = new Set(["active", "completed"]);
const TEXT_LIFECYCLE_VALUES = new Map([
  ["Approval", "waitingOnApproval"], ["Approval required", "waitingOnApproval"], ["Needs approval", "waitingOnApproval"],
  ["Waiting approval", "waitingOnApproval"], ["Waiting for approval", "waitingOnApproval"],
  ["Input required", "waitingOnUserInput"], ["Needs input", "waitingOnUserInput"], ["Needs user input", "waitingOnUserInput"],
  ["Waiting for input", "waitingOnUserInput"], ["Waiting for user input", "waitingOnUserInput"],
  ["Waiting input", "waitingOnUserInput"], ["Waiting user input", "waitingOnUserInput"],
  ["In progress", "running"], ["Loading", "running"], ["Running", "running"], ["Spinner", "running"], ["Working", "running"],
]);
const ROLE_LIFECYCLE_VALUES = new Map([["animation", "running"], ["progress bar", "running"], ["spinner", "running"]]);
const STATE_LIFECYCLE_VALUES = new Map([["busy", "running"]]);
const WORKER_ID = /^worker:[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RUNTIME_IDENTITY_FIELDS = ["buildIdentity", "cacheIdentity", "integrity", "modulePath", "sourceRevision", "version"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024;
const LATEST_TURN_STATUSES = new Set(["completed", "inProgress", "interrupted"]);
const NATIVE_TO_SIDEBAR_STATUS = new Map([["completed", "idle"], ["inProgress", "running"]]);
const NATIVE_TO_MCP_STATUS = new Map([["completed", "complete"], ["inProgress", "running"], ["interrupted", "attention"]]);

export class ProductionTaskSurfaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProductionTaskSurfaceError";
    this.code = code;
  }
}

function fail(code, message) { throw new ProductionTaskSurfaceError(code, message); }
function fields(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function expectedTask(value) {
  if (!fields(value, ["lifecycle", "taskId", "title"]) || !ID.test(value.taskId ?? "") ||
      typeof value.title !== "string" || value.title.length < 1 || value.title.length > 512 || /[\u0000-\u001f\u007f]/u.test(value.title) || !EXPECTED_LIFECYCLES.has(value.lifecycle)) {
    fail("INVALID_TASK_OBSERVATION_REQUEST", "task observation requires one exact active or completed task identity");
  }
  return value;
}
function statusProjection(thread) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread) || !THREAD_STATUSES.has(thread.status)) {
    fail("OBSERVATION_UNAVAILABLE", "task producer returned an unsupported status");
  }
  const activeFlags = thread.status === "active" ? thread.activeFlags : [];
  if (!Array.isArray(activeFlags) || activeFlags.some((flag) => !ACTIVE_FLAGS.has(flag)) || new Set(activeFlags).size !== activeFlags.length) {
    fail("OBSERVATION_UNAVAILABLE", "task producer returned unsupported active flags");
  }
  if (thread.status === "systemError") {
    fail("OBSERVATION_UNAVAILABLE", "task producer reports a system-error load state");
  }
  if (activeFlags.length > 0) {
    fail("THREE_SURFACE_IDENTITY_MISMATCH", "task producer reports an approval or user-input attention flag");
  }
  return { loadState: thread.status, activeFlags: [...activeFlags].sort() };
}
function validateThread(thread, expected, label) {
  const active = fields(thread, ["activeFlags", "createdAt", "cwd", "parentThreadId", "schemaVersion", "status", "threadId", "title", "updatedAt"]);
  const inactive = fields(thread, ["createdAt", "cwd", "parentThreadId", "schemaVersion", "status", "threadId", "title", "updatedAt"]);
  if ((thread?.status === "active" ? !active : !inactive) || thread.schemaVersion !== 1 || thread.threadId !== expected.taskId || thread.title !== expected.title) {
    fail("THREE_SURFACE_IDENTITY_MISMATCH", `${label} task ID or title differs from the sealed scenario`);
  }
  return statusProjection(thread);
}
function validateNativeAggregateTopology(value, expected) {
  if (!fields(value, ["complete", "completed", "descendantCount", "descendants", "interrupted", "rootThreadId", "schemaVersion", "source", "terminal", "topologyDigest", "working"]) ||
      value.schemaVersion !== 1 || value.source !== "codex-app-server-parent-history-latest-turn" || value.rootThreadId !== expected.taskId || value.complete !== true ||
      ![value.descendantCount, value.working, value.completed, value.interrupted, value.terminal].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 500) ||
      value.terminal !== value.completed + value.interrupted || value.descendantCount !== value.working + value.terminal || !SHA256.test(value.topologyDigest ?? "") ||
      !Array.isArray(value.descendants) || value.descendants.length !== value.descendantCount || value.descendants.length > 32) {
    fail("AGGREGATE_TOPOLOGY_UNSUPPORTED", "native Codex did not prove a complete bounded descendant latest-turn topology");
  }
  const ids = value.descendants.map(({ taskId }) => taskId); const known = new Set([expected.taskId, ...ids]);
  if (new Set(ids).size !== ids.length || ids.includes(expected.taskId) || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) {
    fail("AGGREGATE_TOPOLOGY_UNSUPPORTED", "native descendant task identities are incomplete or non-canonical");
  }
  for (const descendant of value.descendants) {
    if (!fields(descendant, ["latestTurnId", "latestTurnStatus", "parentTaskId", "taskId", "title"]) || !ID.test(descendant.taskId ?? "") || !ID.test(descendant.parentTaskId ?? "") ||
        !ID.test(descendant.latestTurnId ?? "") || !known.has(descendant.parentTaskId) || descendant.parentTaskId === descendant.taskId || !LATEST_TURN_STATUSES.has(descendant.latestTurnStatus) ||
        typeof descendant.title !== "string" || descendant.title.length < 1 || descendant.title.length > 512 || /[\u0000-\u001f\u007f]/u.test(descendant.title)) {
      fail("AGGREGATE_TOPOLOGY_UNSUPPORTED", "native descendant task identity, title, parent, or latest turn is incompatible");
    }
    const visited = new Set([descendant.taskId]); let parent = descendant.parentTaskId;
    while (parent !== expected.taskId) {
      if (visited.has(parent)) fail("AGGREGATE_TOPOLOGY_UNSUPPORTED", "native descendant topology contains a cycle");
      visited.add(parent); parent = value.descendants.find(({ taskId }) => taskId === parent)?.parentTaskId;
      if (parent === undefined) fail("AGGREGATE_TOPOLOGY_UNSUPPORTED", "native descendant topology has an unknown parent");
    }
  }
  const projected = { working: 0, completed: 0, interrupted: 0 };
  for (const { latestTurnStatus } of value.descendants) projected[latestTurnStatus === "inProgress" ? "working" : latestTurnStatus] += 1;
  if (value.working !== projected.working || value.completed !== projected.completed || value.interrupted !== projected.interrupted ||
      value.topologyDigest !== `sha256:${createHash("sha256").update(JSON.stringify(value.descendants)).digest("hex")}`) {
    fail("AGGREGATE_TOPOLOGY_UNSUPPORTED", "native descendant rows differ from their counters or content digest");
  }
  return value;
}
function validateDesktopAggregateCounters(value, traversal) {
  if (!fields(value, ["current", "done", "groups", "scan", "schemaVersion", "source"]) || value.schemaVersion !== 1 || value.source !== "visible-codex-desktop-atspi" ||
      !Number.isSafeInteger(value.current) || value.current < 0 || !Number.isSafeInteger(value.done) || value.done < 0 || value.current + value.done > 500 ||
      !fields(value.groups, ["inProgress", "needsInput", "queued"]) || ![value.groups.inProgress, value.groups.needsInput, value.groups.queued].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 500) ||
      value.current !== value.groups.inProgress + value.groups.needsInput + value.groups.queued ||
      !fields(value.scan, ["complete", "maximumNodes", "scannedNodes"]) || value.scan.complete !== true || value.scan.maximumNodes !== 10_000 ||
      !Number.isSafeInteger(value.scan.scannedNodes) || value.scan.scannedNodes < 1 || value.scan.scannedNodes > value.scan.maximumNodes || value.scan.scannedNodes !== traversal?.scannedNodes) {
    fail("AGGREGATE_COUNTER_UNAVAILABLE", "visible Desktop did not expose a complete bounded Current/Done and current-group count proof");
  }
  return value;
}
function validateDesktopDescendantRows(value, expectedDescendants) {
  if (!fields(value, ["mcpVisual", "observationPhases", "schemaVersion", "sidebar"]) || value.schemaVersion !== 1 || !Array.isArray(value.observationPhases)) {
    fail("THREE_SURFACE_IDENTITY_MISMATCH", "visible Desktop descendant row proof is not closed");
  }
  const expectedIds = expectedDescendants.map(({ taskId }) => taskId); const sealedTitles = new Set(expectedDescendants.map(({ title }) => title));
  const validateEvidence = (evidence, renderedStatus, surface) => {
    if (!fields(evidence, ["kind", "scan", "value"]) || typeof evidence.value !== "string" || evidence.value.length < 1 || evidence.value.length > 256 ||
        !fields(evidence.scan, ["complete", "maximumNodes", "scannedNodes"]) || evidence.scan.complete !== true || evidence.scan.maximumNodes !== 2_000 ||
        !Number.isSafeInteger(evidence.scan.scannedNodes) || evidence.scan.scannedNodes < 1 || evidence.scan.scannedNodes > evidence.scan.maximumNodes) {
      fail("THREE_SURFACE_IDENTITY_MISMATCH", `${surface} descendant lifecycle evidence is incomplete`);
    }
    if (surface === "sidebar") {
      const projected = evidence.kind === "text" ? TEXT_LIFECYCLE_VALUES.get(evidence.value)
        : evidence.kind === "role" ? ROLE_LIFECYCLE_VALUES.get(evidence.value)
          : evidence.kind === "state" ? STATE_LIFECYCLE_VALUES.get(evidence.value) : undefined;
      if (renderedStatus === "idle" ? evidence.kind !== "complete-absence" || evidence.value !== "no-running-approval-or-input-indicator" : projected !== renderedStatus) {
        fail("THREE_SURFACE_IDENTITY_MISMATCH", "sidebar descendant lifecycle label differs from its rendered status");
      }
    } else {
      const expectedLabel = new Map([["attention", "Attention"], ["complete", "Complete"], ["running", "Running"]]).get(renderedStatus);
      if (evidence.kind !== "text" || evidence.value !== expectedLabel) fail("THREE_SURFACE_IDENTITY_MISMATCH", "MCP visual descendant status label differs from its row status");
    }
  };
  for (const [surface, allowed] of [["sidebar", new Set(["idle", "running", "waitingOnApproval", "waitingOnUserInput"])], ["mcpVisual", new Set(["attention", "complete", "running"])]]) {
    const rows = value[surface];
    if (!Array.isArray(rows) || rows.length !== expectedIds.length || JSON.stringify(rows.map(({ taskId }) => taskId)) !== JSON.stringify(expectedIds)) {
      fail("THREE_SURFACE_IDENTITY_MISMATCH", `${surface} did not retain every exact native descendant task ID`);
    }
    for (const row of rows) {
      if (!fields(row, ["lifecycleEvidence", "phaseSequence", "renderedStatus", "taskId", "title"]) || !ID.test(row.taskId ?? "") || !sealedTitles.has(row.title) || !allowed.has(row.renderedStatus) ||
          !Number.isSafeInteger(row.phaseSequence) || row.phaseSequence < 1 || row.phaseSequence > 34) {
        fail("THREE_SURFACE_IDENTITY_MISMATCH", `${surface} descendant row identity, title, or status is incompatible`);
      }
      validateEvidence(row.lifecycleEvidence, row.renderedStatus, surface);
    }
  }
  if (expectedDescendants.length === 0) {
    if (value.observationPhases.length !== 0) fail("THREE_SURFACE_IDENTITY_MISMATCH", "zero-descendant proof contains an observation phase");
    return value;
  }
  if (value.observationPhases.length < 2 || value.observationPhases.length > 34) fail("THREE_SURFACE_IDENTITY_MISMATCH", "Desktop descendant observation phases are incomplete");
  for (const [index, phase] of value.observationPhases.entries()) {
    if (!fields(phase, ["scan", "schemaVersion", "screenshot", "sequence", "surface", "taskIds", "view"]) || phase.schemaVersion !== 1 || phase.sequence !== index + 1 ||
        !["sidebar", "mcpVisual"].includes(phase.surface) || !["current", "done", "scroll-page", "standalone"].includes(phase.view) ||
        !Array.isArray(phase.taskIds) || phase.taskIds.length < 1 || phase.taskIds.length > 32 || new Set(phase.taskIds).size !== phase.taskIds.length ||
        JSON.stringify(phase.taskIds) !== JSON.stringify([...phase.taskIds].sort()) || phase.taskIds.some((taskId) => !expectedIds.includes(taskId)) ||
        !fields(phase.scan, ["complete", "maximumNodes", "scannedNodes"]) || phase.scan.complete !== true || phase.scan.maximumNodes !== 10_000 ||
        !Number.isSafeInteger(phase.scan.scannedNodes) || phase.scan.scannedNodes < 1 || phase.scan.scannedNodes > phase.scan.maximumNodes ||
        !fields(phase.screenshot, ["byteLength", "bytesBase64", "digest", "height", "mediaType", "path", "privacy", "protectedInventory", "protectedRegions", "protection", "width"])) {
      fail("THREE_SURFACE_IDENTITY_MISMATCH", "Desktop descendant observation phase is incompatible");
    }
    const rows = value[phase.surface].filter((row) => row.phaseSequence === phase.sequence).map(({ taskId }) => taskId).sort();
    if (JSON.stringify(rows) !== JSON.stringify(phase.taskIds)) fail("THREE_SURFACE_IDENTITY_MISMATCH", "Desktop descendant phase does not bind its exact observed rows");
  }
  for (const [surface, rows] of [["sidebar", value.sidebar], ["mcpVisual", value.mcpVisual]]) {
    for (const row of rows) {
      const phase = value.observationPhases[row.phaseSequence - 1];
      if (phase?.surface !== surface || !phase.taskIds.includes(row.taskId) || (surface === "mcpVisual" &&
          (row.renderedStatus === "complete" ? phase.view !== "done" : !["current", "standalone"].includes(phase.view)))) {
        fail("THREE_SURFACE_IDENTITY_MISMATCH", "Desktop descendant row is bound to the wrong observation phase");
      }
    }
  }
  return value;
}
function compareDesktopDescendantRows(value, nativeTopology) {
  for (const [index, expected] of nativeTopology.descendants.entries()) {
    const sidebar = value.sidebar[index]; const mcpVisual = value.mcpVisual[index];
    if (sidebar.taskId !== expected.taskId || mcpVisual.taskId !== expected.taskId || sidebar.title !== expected.title || mcpVisual.title !== expected.title ||
        sidebar.renderedStatus !== NATIVE_TO_SIDEBAR_STATUS.get(expected.latestTurnStatus) || mcpVisual.renderedStatus !== NATIVE_TO_MCP_STATUS.get(expected.latestTurnStatus)) {
      fail("DESCENDANT_TASK_SURFACE_MISMATCH", "native, sidebar, and MCP visual descendant task names or latest statuses disagree");
    }
  }
}
function surface(binding, expected, producer, attestation, observedAt) {
  return {
    schemaVersion: 1,
    runId: binding.runId,
    fencingToken: binding.fencingToken,
    taskId: expected.taskId,
    title: expected.title,
    lifecycle: expected.lifecycle,
    observedAt,
    producer,
    attestation,
  };
}
function validateBinding(binding) {
  if (!fields(binding, ["automationUser", "fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "stateRoot", "vmId"]) ||
      !ID.test(binding.runId ?? "") || !ID.test(binding.fencingToken ?? "")) {
    fail("RUNTIME_IDENTITY_MISMATCH", "task observer did not receive the exact runtime binding");
  }
  return binding;
}
function validateMcpHealth(health, workerPid, serverVersion) {
  const registry = health?.registry;
  if (!fields(registry, ["activeGenerations", "liveWorkerCount", "mutationAllowed", "recoveredWorkerIds", "state"]) ||
      registry.state !== "single-generation" || registry.mutationAllowed !== true || !Number.isSafeInteger(registry.liveWorkerCount) ||
      registry.liveWorkerCount < 1 || registry.liveWorkerCount > 32 || !Array.isArray(registry.activeGenerations) || registry.activeGenerations.length !== 1 ||
      !Array.isArray(registry.recoveredWorkerIds) || registry.recoveredWorkerIds.length > 32 || new Set(registry.recoveredWorkerIds).size !== registry.recoveredWorkerIds.length ||
      registry.recoveredWorkerIds.some((workerId) => !WORKER_ID.test(workerId))) {
    fail("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP health did not prove one mutable runtime generation");
  }
  const generation = registry.activeGenerations[0];
  let exactGeneration = false;
  try {
    exactGeneration = fields(generation, ["generationKey", "identity", "workers"]) && fields(generation.identity, RUNTIME_IDENTITY_FIELDS) &&
      generation.generationKey === runtimeGenerationKeyV1(generation.identity);
  } catch { exactGeneration = false; }
  if (!exactGeneration || generation.identity.version !== serverVersion || !Array.isArray(generation.workers) || generation.workers.length !== registry.liveWorkerCount) {
    fail("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP runtime generation identity is incompatible");
  }
  const workers = generation.workers.map((worker) => {
    if (!fields(worker, ["heartbeatAt", "pid", "state", "workerId"]) || !WORKER_ID.test(worker.workerId ?? "") || !["active", "draining"].includes(worker.state) ||
        !Number.isSafeInteger(worker.pid) || worker.pid < 1 || !ISO.test(worker.heartbeatAt ?? "") || !Number.isFinite(Date.parse(worker.heartbeatAt))) {
      fail("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP runtime worker health is incompatible");
    }
    return worker;
  });
  if (!Number.isSafeInteger(workerPid) || workerPid < 1 || new Set(workers.map(({ workerId }) => workerId)).size !== workers.length) {
    fail("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP worker process identity is unavailable");
  }
  const producingWorkers = workers.filter(({ pid }) => pid === workerPid);
  if (producingWorkers.length !== 1) fail("OBSERVATION_UNAVAILABLE", "runtime health does not identify the MCP worker that inspected the task");
  return { generationKey: generation.generationKey, registryState: registry.state, workerId: producingWorkers[0].workerId };
}

export class BoundedNelosMcpClientV1 {
  constructor({ spawnProcess = spawn, deadlineMs = 20_000 } = {}) {
    if (typeof spawnProcess !== "function" || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) throw new TypeError("bounded MCP client configuration is invalid");
    this.spawnProcess = spawnProcess;
    this.deadlineMs = deadlineMs;
  }

  async #callTools(calls) {
    // One archive checkpoint may contain the lane-contract maximum of 100
    // tasks: seven exact 16-task inventory calls plus one lifecycle call.
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > 8 || calls.some((call) => !fields(call, ["arguments", "name"]))) fail("INVALID_TASK_OBSERVATION_REQUEST", "MCP observation calls are invalid");
    const home = process.env.HOME;
    if (typeof home !== "string" || !home.startsWith("/") || home.length > 4096) fail("OBSERVATION_UNAVAILABLE", "controller HOME is unavailable");
    const env = {
      HOME: home,
      PATH: `${dirname(PINNED_CODEX_COMMAND)}:/usr/bin:/bin`,
      ...(typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.startsWith("/") ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
      ...(typeof process.env.LANG === "string" ? { LANG: process.env.LANG } : {}),
    };
    const child = this.spawnProcess(process.execPath, [PACKAGED_NELOS_MCP], { shell: false, stdio: ["pipe", "pipe", "ignore"], env });
    let buffer = ""; let byteLength = 0; let nextId = 1; let failure = null;
    const pending = new Map();
    const rejectAll = (error) => {
      if (failure !== null) return;
      failure = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); rejectAll(new ProductionTaskSurfaceError("OBSERVATION_DEADLINE", "Nelos MCP observation exceeded its deadline")); }, this.deadlineMs);
    child.once("error", () => rejectAll(new ProductionTaskSurfaceError("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP could not start")));
    child.once("close", () => { if (pending.size > 0 && failure === null) rejectAll(new ProductionTaskSurfaceError("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP exited before returning its observation")); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      byteLength += Buffer.byteLength(chunk);
      if (byteLength > MAX_PROTOCOL_BYTES) { child.kill("SIGKILL"); rejectAll(new ProductionTaskSurfaceError("OBSERVATION_UNAVAILABLE", "Nelos MCP observation exceeded its output bound")); return; }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { rejectAll(new ProductionTaskSurfaceError("OBSERVATION_UNAVAILABLE", "Nelos MCP returned malformed JSON")); return; }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error !== undefined) waiter.reject(new ProductionTaskSurfaceError("OBSERVATION_UNAVAILABLE", "Nelos MCP rejected its observation request"));
        else waiter.resolve(message.result);
      }
    });
    const request = (method, params) => {
      if (failure !== null) return Promise.reject(failure);
      const id = nextId; nextId += 1;
      const response = new Promise((resolvePromise, rejectPromise) => pending.set(id, { resolve: resolvePromise, reject: rejectPromise }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    };
    try {
      const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "nelos_desktop_validator", version: "1.0.0" } });
      if (!fields(initialized, ["capabilities", "instructions", "protocolVersion", "serverInfo"]) || initialized.protocolVersion !== "2025-11-25" || initialized.serverInfo?.name !== "nelos" || typeof initialized.serverInfo.version !== "string") fail("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP returned an incompatible identity");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      const bodies = [];
      for (const call of calls) {
        const result = await request("tools/call", { name: call.name, arguments: call.arguments });
        const allowedResultFields = result?.structuredContent === undefined ? ["content", "isError"] : ["content", "isError", "structuredContent"];
        if (!fields(result, allowedResultFields) || result.isError !== false || !Array.isArray(result.content) || result.content.length !== 1 ||
            !fields(result.content[0], ["text", "type"]) || result.content[0].type !== "text" || typeof result.content[0].text !== "string" || result.content[0].text.length > 262_144) {
          fail("OBSERVATION_UNAVAILABLE", `${call.name} returned an incompatible result envelope`);
        }
        let body; try { body = JSON.parse(result.content[0].text); } catch { fail("OBSERVATION_UNAVAILABLE", `${call.name} returned malformed bounded content`); }
        bodies.push(body);
      }
      return { serverVersion: initialized.serverInfo.version, workerPid: Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null, bodies };
    } finally {
      clearTimeout(timer); child.stdin.destroy(); child.kill("SIGTERM");
    }
  }

  async callThreadInspect(threadId) {
    if (!ID.test(threadId ?? "")) fail("INVALID_TASK_OBSERVATION_REQUEST", "MCP task identity is invalid");
    const result = await this.#callTools([
      { name: "nelos_thread_inspect", arguments: { threadId } },
      { name: "nelos_runtime_health", arguments: { verifyIntegrity: false } },
    ]);
    const [body, healthBody] = result.bodies;
    if (!fields(body, ["command", "thread"]) || body.command !== "thread inspect" || !fields(healthBody, ["command", "health"]) || healthBody.command !== "runtime health") {
      fail("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP returned an incompatible task or health projection");
    }
    return { health: healthBody.health, serverVersion: result.serverVersion, thread: body.thread, workerPid: result.workerPid };
  }

  async callArchiveProjection(threadIds) {
    if (!Array.isArray(threadIds) || threadIds.length < 1 || threadIds.length > 100 || new Set(threadIds).size !== threadIds.length || threadIds.some((id) => !ID.test(id ?? ""))) {
      fail("INVALID_TASK_OBSERVATION_REQUEST", "MCP archive task identities are invalid");
    }
    const batches = [];
    for (let index = 0; index < threadIds.length; index += 16) batches.push(threadIds.slice(index, index + 16));
    const result = await this.#callTools([
      ...batches.map((batch) => ({ name: "nelos_thread_inventory", arguments: { threadIds: batch, includeTopology: false } })),
      { name: "nelos_runtime_health", arguments: { verifyIntegrity: false } },
    ]);
    const inventoryBodies = result.bodies.slice(0, -1); const healthBody = result.bodies.at(-1);
    if (inventoryBodies.length !== batches.length || inventoryBodies.some((body, index) =>
      !fields(body, ["command", "inventory"]) || body.command !== "thread inventory" ||
      !fields(body.inventory, ["failed", "items", "requested", "schemaVersion", "succeeded"]) || body.inventory.schemaVersion !== 1 ||
      body.inventory.requested !== batches[index].length || !Number.isSafeInteger(body.inventory.succeeded) || !Number.isSafeInteger(body.inventory.failed) ||
      body.inventory.succeeded + body.inventory.failed !== body.inventory.requested || !Array.isArray(body.inventory.items) || body.inventory.items.length !== body.inventory.requested
    ) ||
        !fields(healthBody, ["command", "health"]) || healthBody.command !== "runtime health") fail("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP returned an incompatible archive projection");
    if (!Number.isSafeInteger(result.workerPid) || result.workerPid < 1) fail("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP worker process identity is unavailable");
    return {
      serverVersion: result.serverVersion,
      workerPid: result.workerPid,
      inventory: {
        schemaVersion: 1,
        requested: inventoryBodies.reduce((sum, body) => sum + (body.inventory?.requested ?? 0), 0),
        succeeded: inventoryBodies.reduce((sum, body) => sum + (body.inventory?.succeeded ?? 0), 0),
        failed: inventoryBodies.reduce((sum, body) => sum + (body.inventory?.failed ?? 0), 0),
        items: inventoryBodies.flatMap((body) => Array.isArray(body.inventory?.items) ? body.inventory.items : []),
      },
      health: healthBody.health,
    };
  }
}

export class NativeCodexTaskObserverV1 {
  constructor({ bridgeFactory = (command) => new CodexAppServerBridgeV1({ command }) } = {}) {
    if (typeof bridgeFactory !== "function") throw new TypeError("native bridge factory is required");
    this.bridgeFactory = bridgeFactory;
  }
  async observe(expected) {
    const bridge = this.bridgeFactory(PINNED_CODEX_COMMAND);
    try {
      const thread = await bridge.inspect({ threadId: expected.taskId });
      const status = validateThread(thread, expected, "native Codex");
      const latestTurn = await bridge.latestTurn({ threadId: expected.taskId });
      if (expected.lifecycle === "completed" && (!latestTurn || !ID.test(latestTurn.turnId ?? "") || latestTurn.status !== "completed")) {
        fail("THREE_SURFACE_IDENTITY_MISMATCH", "native Codex did not prove a completed real scenario turn");
      }
      const aggregateTaskTopology = await bridge.collaborationTopologyCounters({ rootThreadId: expected.taskId });
      return { thread, attestation: { activeFlags: status.activeFlags, aggregateTaskTopology, command: PINNED_CODEX_COMMAND, latestTurn, loadState: status.loadState, method: "thread/read+thread/turns/list(parent-history-complete)" } };
    } catch (error) {
      if (error instanceof ProductionTaskSurfaceError) throw error;
      fail("OBSERVATION_UNAVAILABLE", "native Codex app-server inspection failed");
    } finally { await bridge.close?.(); }
  }
}

export class NelosMcpTaskObserverV1 {
  constructor({ client = new BoundedNelosMcpClientV1() } = {}) { this.client = client; }
  async observe(expected) {
    const result = await this.client.callThreadInspect(expected.taskId);
    const status = validateThread(result.thread, expected, "ordinary Nelos MCP");
    if (typeof result.serverVersion !== "string" || result.serverVersion.length < 1 || result.serverVersion.length > 128 || /[\u0000-\u001f\u007f]/u.test(result.serverVersion)) {
      fail("OBSERVATION_UNAVAILABLE", "packaged Nelos MCP server version is invalid");
    }
    const health = validateMcpHealth(result.health, result.workerPid, result.serverVersion);
    return { thread: result.thread, attestation: { activeFlags: status.activeFlags, health, loadState: status.loadState, server: "nelos", serverVersion: result.serverVersion, tool: "nelos_thread_inspect+nelos_runtime_health" } };
  }
}

export class GuestNativeCodexTaskObserverV1 {
  constructor({ client } = {}) {
    if (typeof client?.invoke !== "function") throw new TypeError("guest native observer requires a QGA client");
    this.client = client;
  }
  observe(expected, { signal = null } = {}) {
    return this.client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "observe_native_task", payload: expected, ...(signal === null ? {} : { signal }) });
  }
}

export class GuestNelosMcpTaskObserverV1 {
  constructor({ client } = {}) {
    if (typeof client?.invoke !== "function") throw new TypeError("guest MCP observer requires a QGA client");
    this.client = client;
  }
  observe(expected, { signal = null } = {}) {
    return this.client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "observe_mcp_task", payload: expected, ...(signal === null ? {} : { signal }) });
  }
}

async function persistControllerScreenshot(root, digest, bytes) {
  if (root === null) return null;
  const target = join(root, `${digest.slice(7)}.png`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(target, "wx", 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !(await readFile(target)).equals(bytes)) fail("ALTERED_RECEIPT", "controller task-surface screenshot was altered");
  }
  return target;
}

async function persistControllerDiagnostic(root, value) {
  if (root === null) return null;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const target = join(root, `${digest}.json`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(target, "wx", 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !(await readFile(target)).equals(bytes)) fail("ALTERED_RECEIPT", "controller task-surface diagnostic was altered");
  } finally { bytes.fill(0); }
  return target;
}

async function validateDesktop(value, expected, nativeTopology, binding, now, evidenceRoot) {
  if (!fields(value, ["attestation", "fencingToken", "lifecycle", "observedAt", "producer", "runId", "schemaVersion", "taskId", "title"]) ||
      value.schemaVersion !== 1 || value.runId !== binding.runId || value.fencingToken !== binding.fencingToken || value.taskId !== expected.taskId ||
      typeof value.title !== "string" || value.title.length < 1 || value.title.length > 512 || /[\u0000-\u001f\u007f]/u.test(value.title) ||
      value.lifecycle !== expected.lifecycle || value.producer !== "visible-codex-desktop") {
    fail("THREE_SURFACE_IDENTITY_MISMATCH", "visible Desktop task identity differs from the sealed scenario");
  }
  const observedAt = Date.parse(value.observedAt);
  if (!Number.isFinite(observedAt) || Math.abs(now - observedAt) > 30_000) fail("THREE_SURFACE_IDENTITY_MISMATCH", "visible Desktop task observation is stale");
  const proof = value.attestation;
  const expectedRenderedLifecycle = expected.lifecycle === "active" ? "running" : "idle";
  if (!fields(proof, ["accessibilityRole", "aggregateTaskCounters", "descendantTasks", "lifecycleEvidence", "renderedLifecycle", "selected", "screenshot"]) || typeof proof.accessibilityRole !== "string" || proof.accessibilityRole.length < 1 || proof.selected !== true ||
      !["idle", "running", "waitingOnApproval", "waitingOnUserInput"].includes(proof.renderedLifecycle) || !fields(proof.lifecycleEvidence, ["kind", "scan", "value"]) || typeof proof.lifecycleEvidence.value !== "string" || proof.lifecycleEvidence.value.length < 1 || proof.lifecycleEvidence.value.length > 256 ||
      !fields(proof.lifecycleEvidence.scan, ["complete", "maximumNodes", "scannedNodes"]) || proof.lifecycleEvidence.scan.complete !== true || proof.lifecycleEvidence.scan.maximumNodes !== 2_000 ||
      !Number.isSafeInteger(proof.lifecycleEvidence.scan.scannedNodes) || proof.lifecycleEvidence.scan.scannedNodes < 1 || proof.lifecycleEvidence.scan.scannedNodes > proof.lifecycleEvidence.scan.maximumNodes ||
      (proof.renderedLifecycle === "idle" ? proof.lifecycleEvidence.kind !== "complete-absence" || proof.lifecycleEvidence.value !== "no-running-approval-or-input-indicator" : !["role", "state", "text"].includes(proof.lifecycleEvidence.kind))) {
    fail("THREE_SURFACE_IDENTITY_MISMATCH", "visible Desktop rendered lifecycle proof is not closed or complete");
  }
  const evidenceLifecycle = proof.lifecycleEvidence.kind === "text" ? TEXT_LIFECYCLE_VALUES.get(proof.lifecycleEvidence.value)
    : proof.lifecycleEvidence.kind === "role" ? ROLE_LIFECYCLE_VALUES.get(proof.lifecycleEvidence.value)
      : proof.lifecycleEvidence.kind === "state" ? STATE_LIFECYCLE_VALUES.get(proof.lifecycleEvidence.value) : undefined;
  if (proof.renderedLifecycle !== "idle" && evidenceLifecycle !== proof.renderedLifecycle) {
    fail("UNSAFE_CAPTURE", "visible Desktop lifecycle pixels are not limited to one canonical UI indicator");
  }
  const descendantTasks = validateDesktopDescendantRows(proof.descendantTasks, nativeTopology.descendants);
  if (!fields(proof.screenshot, ["byteLength", "bytesBase64", "digest", "height", "mediaType", "path", "privacy", "protectedInventory", "protectedRegions", "protection", "width"]) || proof.screenshot.mediaType !== "image/png" ||
      !SHA256.test(proof.screenshot.digest ?? "") || !Number.isSafeInteger(proof.screenshot.byteLength) || proof.screenshot.byteLength < 1 ||
      !Number.isSafeInteger(proof.screenshot.width) || proof.screenshot.width < 1 || !Number.isSafeInteger(proof.screenshot.height) || proof.screenshot.height < 1 ||
      proof.screenshot.path !== `${binding.stateRoot}/surface-observations/${proof.screenshot.digest.slice(7)}.png` ||
      !fields(proof.screenshot.protection, ["geometryCertain", "inventoryComplete", "mode"]) || proof.screenshot.protection.geometryCertain !== true ||
      proof.screenshot.protection.inventoryComplete !== true || proof.screenshot.protection.mode !== "mask") {
    fail("UNSAFE_CAPTURE", "visible Desktop observation lacks digest-bound protected screenshot evidence");
  }
  const png = Buffer.from(proof.screenshot.bytesBase64, "base64");
  try {
    const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
    let protectedRegions;
    try { protectedRegions = protectedCaptureRegionsV1(proof.screenshot.protectedInventory, { screen: { width: proof.screenshot.width, height: proof.screenshot.height } }); }
    catch { fail("UNSAFE_CAPTURE", "visible Desktop protected-region inventory is incomplete"); }
    let preservedRegions;
    try {
      preservedRegions = capturePrivacyProofV1(proof.screenshot.privacy, {
        screen: { width: proof.screenshot.width, height: proof.screenshot.height }, protectedRegions,
        mode: "expected-task-evidence-only", expectedTaskIds: [expected.taskId], requireTitle: true,
      });
    } catch { fail("UNSAFE_CAPTURE", "visible Desktop capture did not prove full-frame masking with one exact task evidence allowlist"); }
    const titleDigests = new Map([[expected.taskId, `sha256:${createHash("sha256").update(value.title).digest("hex")}`]]);
    const statusDigests = new Map([[expected.taskId, new Set([`sha256:${createHash("sha256").update(proof.lifecycleEvidence.value).digest("hex")}`])]]);
    validateDesktopAggregateCounters(proof.aggregateTaskCounters, proof.screenshot.protectedInventory?.traversal);
    if (!png.length || png.length !== proof.screenshot.byteLength || digest !== proof.screenshot.digest ||
        JSON.stringify(protectedRegions) !== JSON.stringify(proof.screenshot.protectedRegions) ||
        proof.screenshot.privacy.traversal.scannedNodes !== proof.screenshot.protectedInventory.traversal.scannedNodes ||
        preservedRegions.some((region) => region.kind === "expected-task-title" ? region.textDigest !== titleDigests.get(region.taskId) : !statusDigests.get(region.taskId)?.has(region.textDigest)) ||
        (proof.renderedLifecycle !== "idle" && !preservedRegions.some((region) => region.kind === "expected-task-status" && region.taskId === expected.taskId))) {
      fail("UNSAFE_CAPTURE", "visible Desktop screenshot bytes, protected geometry, or preserved evidence digest differs");
    }
    try {
      assertCapturePrivacyPixelsV1(png, {
        screen: { width: proof.screenshot.width, height: proof.screenshot.height },
        preservedRegions,
        protectedRegions,
        requireSignal: true,
      });
    } catch { fail("UNSAFE_CAPTURE", "visible Desktop screenshot pixels escape the exact task title/status allowlist"); }
    const controllerPath = await persistControllerScreenshot(evidenceRoot, digest, png);
    const { bytesBase64: _bytes, ...screenshot } = proof.screenshot;
    const observationPhases = [];
    for (const phase of descendantTasks.observationPhases) {
      const phasePng = Buffer.from(phase.screenshot.bytesBase64, "base64");
      try {
        const phaseDigest = `sha256:${createHash("sha256").update(phasePng).digest("hex")}`;
        if (!phasePng.length || phasePng.length !== phase.screenshot.byteLength || phase.screenshot.digest !== phaseDigest || phase.screenshot.mediaType !== "image/png" ||
            phase.screenshot.path !== `${binding.stateRoot}/surface-observations/${phaseDigest.slice(7)}.png` || !Number.isSafeInteger(phase.screenshot.width) || phase.screenshot.width < 1 ||
            !Number.isSafeInteger(phase.screenshot.height) || phase.screenshot.height < 1 || !fields(phase.screenshot.protection, ["geometryCertain", "inventoryComplete", "mode"]) ||
            phase.screenshot.protection.geometryCertain !== true || phase.screenshot.protection.inventoryComplete !== true || phase.screenshot.protection.mode !== "mask") {
          fail("UNSAFE_CAPTURE", "Desktop descendant observation phase lacks a digest-bound protected screenshot");
        }
        let phaseProtected; let phasePreserved;
        try {
          phaseProtected = protectedCaptureRegionsV1(phase.screenshot.protectedInventory, { screen: { width: phase.screenshot.width, height: phase.screenshot.height } });
          phasePreserved = capturePrivacyProofV1(phase.screenshot.privacy, {
            screen: { width: phase.screenshot.width, height: phase.screenshot.height }, protectedRegions: phaseProtected,
            mode: "expected-task-evidence-only", expectedTaskIds: phase.taskIds, requireTitle: true,
          });
        } catch { fail("UNSAFE_CAPTURE", "Desktop descendant phase has incomplete protected geometry or privacy proof"); }
        const phaseRows = descendantTasks[phase.surface].filter((row) => row.phaseSequence === phase.sequence);
        const phaseTitleDigests = new Map(phaseRows.map((row) => [row.taskId, `sha256:${createHash("sha256").update(row.title).digest("hex")}`]));
        const phaseStatusDigests = new Map(phaseRows.map((row) => [row.taskId, `sha256:${createHash("sha256").update(row.lifecycleEvidence.value).digest("hex")}`]));
        const requiredStatusTaskIds = new Set(phaseRows.filter((row) => phase.surface === "mcpVisual" || row.renderedStatus !== "idle").map(({ taskId }) => taskId));
        if (JSON.stringify(phaseProtected) !== JSON.stringify(phase.screenshot.protectedRegions) || phase.scan.scannedNodes !== phase.screenshot.protectedInventory?.traversal?.scannedNodes ||
            phasePreserved.some((region) => region.kind === "expected-task-title" ? region.textDigest !== phaseTitleDigests.get(region.taskId) : region.textDigest !== phaseStatusDigests.get(region.taskId)) ||
            [...requiredStatusTaskIds].some((taskId) => !phasePreserved.some((region) => region.kind === "expected-task-status" && region.taskId === taskId))) {
          fail("UNSAFE_CAPTURE", "Desktop descendant phase pixels differ from its exact task title/status allowlist");
        }
        try {
          assertCapturePrivacyPixelsV1(phasePng, {
            screen: { width: phase.screenshot.width, height: phase.screenshot.height }, preservedRegions: phasePreserved, protectedRegions: phaseProtected, requireSignal: true,
          });
        } catch { fail("UNSAFE_CAPTURE", "Desktop descendant phase pixels escape the exact task title/status allowlist"); }
        const phaseControllerPath = await persistControllerScreenshot(evidenceRoot, phaseDigest, phasePng);
        const { bytesBase64: _phaseBytes, ...phaseScreenshot } = phase.screenshot;
        observationPhases.push({ ...phase, screenshot: { ...phaseScreenshot, ...(phaseControllerPath === null ? {} : { controllerPath: phaseControllerPath }) } });
      } finally { phasePng.fill(0); }
    }
    const sanitized = { ...value, attestation: { ...proof, descendantTasks: { ...descendantTasks, observationPhases }, screenshot: { ...screenshot, ...(controllerPath === null ? {} : { controllerPath }) } } };
    if (value.title !== expected.title) fail("THREE_SURFACE_IDENTITY_MISMATCH", "visible Desktop rendered title differs from the sealed scenario");
    if (proof.renderedLifecycle !== expectedRenderedLifecycle ||
        (expected.lifecycle === "active" ? !["role", "state", "text"].includes(proof.lifecycleEvidence.kind) : proof.lifecycleEvidence.kind !== "complete-absence" || proof.lifecycleEvidence.value !== "no-running-approval-or-input-indicator")) {
      fail("THREE_SURFACE_IDENTITY_MISMATCH", "visible Desktop rendered lifecycle differs from the sealed scenario lifecycle");
    }
    return sanitized;
  } finally { png.fill(0); }
}

export class ProducerTaskSurfaceObserverV1 {
  constructor({ client, binding, nativeObserver = null, mcpObserver = null, evidenceRoot = null, diagnosticRoot = null, clock = Date } = {}) {
    if (typeof client?.invoke !== "function") throw new TypeError("QGA helper client is required");
    this.client = client;
    this.binding = validateBinding(binding);
    this.nativeObserver = nativeObserver ?? new GuestNativeCodexTaskObserverV1({ client });
    this.mcpObserver = mcpObserver ?? new GuestNelosMcpTaskObserverV1({ client });
    if (evidenceRoot !== null && (!isAbsolute(evidenceRoot) || resolve(evidenceRoot) === "/")) throw new TypeError("controller task-surface evidence root must be an absolute bounded directory");
    this.evidenceRoot = evidenceRoot === null ? null : resolve(evidenceRoot);
    if (diagnosticRoot !== null && (!isAbsolute(diagnosticRoot) || resolve(diagnosticRoot) === "/")) throw new TypeError("controller task-surface diagnostic root must be an absolute bounded directory");
    this.diagnosticRoot = diagnosticRoot === null ? null : resolve(diagnosticRoot);
    this.clock = clock;
  }
  async observeTask(request, { signal = null } = {}) {
    const expected = expectedTask(request);
    const nativePromise = Promise.resolve().then(() => this.nativeObserver.observe(expected, { signal }));
    const mcpPromise = Promise.resolve().then(() => this.mcpObserver.observe(expected, { signal }));
    const nativeResult = await Promise.allSettled([nativePromise]).then(([result]) => result);
    const native = nativeResult.status === "fulfilled" ? nativeResult.value : null;
    let nativeTopology = null; let nativeTopologyError = null;
    if (native !== null) {
      try { nativeTopology = validateNativeAggregateTopology(native.attestation?.aggregateTaskTopology, expected); }
      catch (error) { nativeTopologyError = error; }
    }
    const desktopPayload = { ...expected, descendants: nativeTopology?.descendants ?? [] };
    const [mcpResult, desktopResult] = await Promise.allSettled([
      mcpPromise,
      this.client.invoke({ helper: "/usr/libexec/nelos-desktop-atspi", operation: "observe_task_surface", payload: desktopPayload, ...(signal === null ? {} : { signal }) }),
    ]);
    const mcp = mcpResult.status === "fulfilled" ? mcpResult.value : null;
    const desktop = desktopResult.status === "fulfilled" ? desktopResult.value : null;
    const now = this.clock.now();
    try {
      if (desktopResult.status === "rejected") throw desktopResult.reason;
      const captureTopology = nativeTopology ?? { descendants: [] };
      const validatedDesktop = await validateDesktop(desktop, expected, captureTopology, this.binding, now, this.evidenceRoot);
      // Pull and verify the protected Desktop image before surfacing a native
      // or MCP producer failure, so a disagreement remains reviewable.
      if (nativeResult.status === "rejected") throw nativeResult.reason;
      if (nativeTopologyError !== null) throw nativeTopologyError;
      if (mcpResult.status === "rejected") throw mcpResult.reason;
      // Revalidate at the composition boundary as well as in the default
      // producers so injected/test adapters cannot bypass identity or title.
      // A freshly spawned app-server or MCP worker reports its own process-local
      // Thread.status load state. It may legitimately be notLoaded while the
      // Desktop process is actively rendering the same task, so lifecycle is
      // never inferred by comparing those independent load states.
      validateThread(native.thread, expected, "native Codex");
      validateThread(mcp.thread, expected, "ordinary Nelos MCP");
      if (expected.lifecycle === "completed" && (!native.attestation?.latestTurn || native.attestation.latestTurn.status !== "completed" || !ID.test(native.attestation.latestTurn.turnId ?? ""))) {
        fail("THREE_SURFACE_IDENTITY_MISMATCH", "completed scenario lacks a real terminal native turn");
      }
      const desktopCounters = validateDesktopAggregateCounters(validatedDesktop.attestation.aggregateTaskCounters, validatedDesktop.attestation.screenshot.protectedInventory?.traversal);
      if (nativeTopology.interrupted !== 0) {
        fail("AGGREGATE_INTERRUPTED_SEMANTICS_UNSUPPORTED", "visible Desktop Done semantics for interrupted descendants are not authoritatively defined");
      }
      compareDesktopDescendantRows(validatedDesktop.attestation.descendantTasks, nativeTopology);
      const observedAt = new Date(now).toISOString();
      return {
        native: surface(this.binding, expected, "native-codex", native.attestation, observedAt),
        mcp: surface(this.binding, expected, "ordinary-nelos-mcp", mcp.attestation, observedAt),
        desktop: validatedDesktop,
        aggregateTaskCounters: {
          state: "launched-rows-verified", visualCountSemantics: "observed-only", authoritativeSource: nativeTopology.source, visualSource: desktopCounters.source,
          current: desktopCounters.current, done: desktopCounters.done, groups: desktopCounters.groups, working: nativeTopology.working, completed: nativeTopology.completed,
          interrupted: nativeTopology.interrupted, descendantCount: nativeTopology.descendantCount, topologyDigest: nativeTopology.topologyDigest,
        },
      };
    } catch (error) {
      const nativeAggregate = native?.attestation?.aggregateTaskTopology;
      const desktopAggregate = desktop?.attestation?.aggregateTaskCounters;
      const boundedCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 500 ? value : null;
      await persistControllerDiagnostic(this.diagnosticRoot, {
        schemaVersion: 1, type: "task-surface-mismatch", runId: this.binding.runId, fencingToken: this.binding.fencingToken,
        taskId: expected.taskId, expectedLifecycle: expected.lifecycle,
        nativeLoadState: THREAD_STATUSES.has(native?.thread?.status) ? native.thread.status : "unavailable",
        mcpLoadState: THREAD_STATUSES.has(mcp?.thread?.status) ? mcp.thread.status : "unavailable",
        desktopRenderedLifecycle: ["idle", "running", "waitingOnApproval", "waitingOnUserInput"].includes(desktop?.attestation?.renderedLifecycle) ? desktop.attestation.renderedLifecycle : "unavailable",
        aggregateCounters: {
          visualCurrent: boundedCount(desktopAggregate?.current), visualDone: boundedCount(desktopAggregate?.done),
          nativeWorking: boundedCount(nativeAggregate?.working), nativeCompleted: boundedCount(nativeAggregate?.completed),
          nativeInterrupted: boundedCount(nativeAggregate?.interrupted), nativeTerminal: boundedCount(nativeAggregate?.terminal),
          nativeDescendantCount: boundedCount(nativeAggregate?.descendantCount),
        },
        code: /^[A-Z][A-Z0-9_]{0,127}$/u.test(error?.code ?? "") ? error.code : "OBSERVATION_UNAVAILABLE",
        observedAt: new Date(now).toISOString(),
      });
      if (error instanceof Error) throw error;
      fail("OBSERVATION_UNAVAILABLE", "a task-surface producer failed without a bounded error");
    }
  }
}

export const PRODUCTION_TASK_SURFACE_EXECUTABLES_V1 = Object.freeze({
  codex: PINNED_CODEX_COMMAND,
  nelosMcp: resolve(PACKAGED_NELOS_MCP),
  node: process.execPath,
});
