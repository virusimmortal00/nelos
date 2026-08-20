import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encodePngRgba } from "../src/remote-desktop-evidence/index.mjs";

import {
  BoundedNelosMcpClientV1,
  NativeCodexTaskObserverV1,
  NelosMcpTaskObserverV1,
  ProducerTaskSurfaceObserverV1,
  PRODUCTION_TASK_SURFACE_EXECUTABLES_V1,
} from "../src/production-task-surface-observer.mjs";
import { runtimeGenerationKeyV1 } from "../src/runtime-worker-registry.mjs";

const TASK = { taskId: "01a01ae1-0000-7000-8000-000000000001", title: "scenario-1", lifecycle: "active" };
const BINDING = {
  providerId: "proxmox-lab", hostId: "prox2", vmId: "9401", leaseId: "lease-1", fencingToken: "fence-1",
  macAddress: "02:4E:45:4C:94:01", networkId: "nelosbld", gatewayId: "9023", networkPolicyDigest: `sha256:${"9".repeat(64)}`,
  imageId: "image-1", runId: "remote-desktop-run-001", automationUser: "nelosauto", stateRoot: "/var/lib/nelos-desktop/runs/remote-desktop-run-001",
};
const THREAD = {
  schemaVersion: 1, threadId: TASK.taskId, title: TASK.title, status: "active", activeFlags: [], cwd: "/workspace", parentThreadId: null,
  createdAt: 1, updatedAt: 2,
};
const NOT_LOADED_THREAD = Object.fromEntries(Object.entries({ ...THREAD, status: "notLoaded" }).filter(([key]) => key !== "activeFlags"));
const RUNTIME_IDENTITY = {
  buildIdentity: `nelos-build:${"a".repeat(32)}`, cacheIdentity: "https://github.com/example/nelos.git#nelos@0.12.19",
  integrity: `sha256:${"b".repeat(64)}`, modulePath: "/opt/nelos/0.12.19", sourceRevision: "c".repeat(40), version: "0.12.19",
};
const GENERATION_KEY = runtimeGenerationKeyV1(RUNTIME_IDENTITY);
const WORKER_ID = `worker:${"d".repeat(64)}`;
const MCP_HEALTH = {
  registry: {
    activeGenerations: [{ generationKey: GENERATION_KEY, identity: RUNTIME_IDENTITY, workers: [{ heartbeatAt: "2026-08-20T12:00:00.000Z", pid: 123, state: "active", workerId: WORKER_ID }] }],
    liveWorkerCount: 1, mutationAllowed: true, recoveredWorkerIds: [], state: "single-generation",
  },
};
const AGGREGATE_TOPOLOGY = {
  schemaVersion: 1, source: "codex-app-server-parent-history-latest-turn", rootThreadId: TASK.taskId, complete: true,
  descendantCount: 0, working: 0, completed: 0, interrupted: 0, terminal: 0, descendants: [],
  topologyDigest: `sha256:${createHash("sha256").update("[]").digest("hex")}`,
};
const EMPTY_DESCENDANT_TASKS = { schemaVersion: 1, sidebar: [], mcpVisual: [], observationPhases: [] };
const PROTECTED_INVENTORY = {
  schemaVersion: 1,
  conversation: { kind: "conversation", x: 40, y: 10, width: 50, height: 60 },
  credentialInventory: { complete: true, count: 0, regions: [] },
  traversal: { complete: true, scannedNodes: 24, maximumNodes: 10_000 },
};
const DESKTOP_COUNTERS = { schemaVersion: 1, source: "visible-codex-desktop-atspi", current: 0, done: 0, groups: { needsInput: 0, inProgress: 0, queued: 0 }, scan: { ...PROTECTED_INVENTORY.traversal } };
function privacyProof(title, lifecycleValue = null) {
  const titleDigest = `sha256:${createHash("sha256").update(title).digest("hex")}`;
  const preservedRegions = [{ kind: "expected-task-title", taskId: TASK.taskId, textDigest: titleDigest, x: 2, y: 2, width: 20, height: 5 }];
  if (lifecycleValue !== null) preservedRegions.push({ kind: "expected-task-status", taskId: TASK.taskId, textDigest: `sha256:${createHash("sha256").update(lifecycleValue).digest("hex")}`, x: 2, y: 8, width: 20, height: 5 });
  return { schemaVersion: 1, classificationComplete: true, maskedBase: "full-frame-black", mode: "expected-task-evidence-only", preservedRegions, rawPixelsPersisted: false, traversal: { ...PROTECTED_INVENTORY.traversal } };
}
function protectedScreenshot(png, digest, title, lifecycleValue, { path = true } = {}) {
  return {
    byteLength: png.length, bytesBase64: png.toString("base64"), digest, width: 1920, height: 1080, mediaType: "image/png",
    ...(path ? { path: `${BINDING.stateRoot}/surface-observations/${digest.slice(7)}.png` } : {}),
    privacy: privacyProof(title, lifecycleValue), protectedInventory: PROTECTED_INVENTORY, protectedRegions: [PROTECTED_INVENTORY.conversation],
    protection: { geometryCertain: true, inventoryComplete: true, mode: "mask" },
  };
}

function maskedPng(width = 1920, height = 1080, { status = true } = {}) {
  return maskedPngForRegions(width, height, [{ x: 2, y: 2, width: 20, height: 5 }, ...(status ? [{ x: 2, y: 8, width: 20, height: 5 }] : [])]);
}

function maskedPngForRegions(width, height, regions) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) rgba[pixel * 4 + 3] = 255;
  for (const [index, region] of regions.entries()) {
    for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * width + x) * 4; rgba[offset] = 45 + index * 30; rgba[offset + 1] = 100; rgba[offset + 2] = 190;
    }
  }
  try { return encodePngRgba({ width, height, rgba }); } finally { rgba.fill(0); }
}

function phaseFixture(rows, { sequence, surface, view }) {
  const width = 120; const height = 100;
  const protectedInventory = {
    schemaVersion: 1, conversation: { kind: "conversation", x: 80, y: 0, width: 40, height: 100 },
    credentialInventory: { complete: true, count: 0, regions: [] }, traversal: { complete: true, scannedNodes: 50 + sequence, maximumNodes: 10_000 },
  };
  const preservedRegions = [];
  for (const [index, row] of rows.entries()) {
    const y = 2 + index * 10;
    preservedRegions.push({ kind: "expected-task-title", taskId: row.taskId, textDigest: `sha256:${createHash("sha256").update(row.title).digest("hex")}`, x: 2, y, width: 30, height: 3 });
    if (surface === "mcpVisual" || row.renderedStatus !== "idle") preservedRegions.push({ kind: "expected-task-status", taskId: row.taskId, textDigest: `sha256:${createHash("sha256").update(row.lifecycleEvidence.value).digest("hex")}`, x: 35, y, width: 20, height: 3 });
  }
  const png = maskedPngForRegions(width, height, preservedRegions); const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  return {
    phase: {
      schemaVersion: 1, sequence, surface, view, taskIds: rows.map(({ taskId }) => taskId).sort(), scan: { ...protectedInventory.traversal },
      screenshot: {
        byteLength: png.length, bytesBase64: png.toString("base64"), digest, width, height, mediaType: "image/png", path: `${BINDING.stateRoot}/surface-observations/${digest.slice(7)}.png`,
        privacy: { schemaVersion: 1, classificationComplete: true, maskedBase: "full-frame-black", mode: "expected-task-evidence-only", preservedRegions, rawPixelsPersisted: false, traversal: { ...protectedInventory.traversal } },
        protectedInventory, protectedRegions: [protectedInventory.conversation], protection: { geometryCertain: true, inventoryComplete: true, mode: "mask" },
      },
    },
    png,
  };
}

function descendantDesktopProof(descendants, { swapTitles = false, swapStatuses = false } = {}) {
  const titles = new Map(descendants.map(({ taskId, title }) => [taskId, title]));
  if (swapTitles) {
    const [left, right] = descendants;
    titles.set(left.taskId, right.title); titles.set(right.taskId, left.title);
  }
  const sidebar = descendants.map((item) => {
    const running = item.latestTurnStatus === "inProgress";
    return { taskId: item.taskId, title: titles.get(item.taskId), renderedStatus: running ? "running" : "idle", lifecycleEvidence: running
      ? { kind: "text", value: "In progress", scan: { complete: true, scannedNodes: 8, maximumNodes: 2_000 } }
      : { kind: "complete-absence", value: "no-running-approval-or-input-indicator", scan: { complete: true, scannedNodes: 8, maximumNodes: 2_000 } } };
  });
  const mcpVisual = descendants.map((item) => ({ taskId: item.taskId, title: titles.get(item.taskId), renderedStatus: item.latestTurnStatus === "inProgress" ? "running" : "complete", lifecycleEvidence: { kind: "text", value: item.latestTurnStatus === "inProgress" ? "Running" : "Complete", scan: { complete: true, scannedNodes: 8, maximumNodes: 2_000 } } }));
  if (swapStatuses) {
    const runningIndex = mcpVisual.findIndex(({ renderedStatus }) => renderedStatus === "running");
    const completeIndex = mcpVisual.findIndex(({ renderedStatus }) => renderedStatus === "complete");
    [mcpVisual[runningIndex].renderedStatus, mcpVisual[completeIndex].renderedStatus] = [mcpVisual[completeIndex].renderedStatus, mcpVisual[runningIndex].renderedStatus];
    [mcpVisual[runningIndex].lifecycleEvidence, mcpVisual[completeIndex].lifecycleEvidence] = [mcpVisual[completeIndex].lifecycleEvidence, mcpVisual[runningIndex].lifecycleEvidence];
  }
  const sidebarPhase = phaseFixture(sidebar, { sequence: 1, surface: "sidebar", view: "scroll-page" });
  for (const row of sidebar) row.phaseSequence = 1;
  const currentRows = mcpVisual.filter(({ renderedStatus }) => renderedStatus !== "complete");
  const doneRows = mcpVisual.filter(({ renderedStatus }) => renderedStatus === "complete");
  const currentPhase = phaseFixture(currentRows, { sequence: 2, surface: "mcpVisual", view: "current" });
  for (const row of currentRows) row.phaseSequence = 2;
  const donePhase = phaseFixture(doneRows, { sequence: 3, surface: "mcpVisual", view: "done" });
  for (const row of doneRows) row.phaseSequence = 3;
  return { value: { schemaVersion: 1, sidebar, mcpVisual, observationPhases: [sidebarPhase.phase, currentPhase.phase, donePhase.phase] }, pngs: [sidebarPhase.png, currentPhase.png, donePhase.png] };
}

function fakeMcpProcess(onSpawn) {
  return (executable, args, options) => {
    onSpawn({ executable, args, options });
    const child = new EventEmitter(); const stdout = new EventEmitter(); stdout.setEncoding = () => {};
    child.stdout = stdout; child.kill = () => {};
    child.stdin = {
      destroy() {},
      write(text) {
        const message = JSON.parse(text);
        if (!Object.hasOwn(message, "id")) return true;
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "nelos", version: "0.12.19" }, instructions: "bounded" }
          : { content: [{ type: "text", text: JSON.stringify(message.params.name === "nelos_runtime_health"
            ? { command: "runtime health", health: MCP_HEALTH }
            : { command: "thread inspect", thread: THREAD }) }], isError: false };
        queueMicrotask(() => stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
        return true;
      },
    };
    child.pid = 123;
    return child;
  };
}

function runHelper(executable, operation, input, env = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [executable, operation], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => code === 0 ? resolvePromise(JSON.parse(Buffer.concat(stdout))) : rejectPromise(Object.assign(new Error(Buffer.concat(stderr).toString("utf8")), { exitCode: code })));
    child.stdin.end(input);
  });
}

test("native observation uses the pinned Codex app-server command and exact thread/read result", async () => {
  let command = null; let inspected = null; let latest = null; let topologyRequest = null; let closed = false;
  const observer = new NativeCodexTaskObserverV1({ bridgeFactory(value) {
    command = value;
    return { async inspect(request) { inspected = request; return THREAD; }, async latestTurn(request) { latest = request; return { turnId: "turn-1", status: "inProgress" }; }, async collaborationTopologyCounters(request) { topologyRequest = request; return AGGREGATE_TOPOLOGY; }, async close() { closed = true; } };
  } });
  const result = await observer.observe(TASK);
  assert.equal(command, PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.codex);
  assert.deepEqual(inspected, { threadId: TASK.taskId });
  assert.deepEqual(latest, { threadId: TASK.taskId });
  assert.deepEqual(topologyRequest, { rootThreadId: TASK.taskId });
  assert.deepEqual(result.attestation, { activeFlags: [], aggregateTaskTopology: AGGREGATE_TOPOLOGY, command, latestTurn: { turnId: "turn-1", status: "inProgress" }, loadState: "active", method: "thread/read+thread/turns/list(parent-history-complete)" });
  assert.equal(closed, true);
});

test("native completed observation requires a non-null completed latest turn", async () => {
  const { activeFlags: _activeFlags, ...idleBase } = THREAD; const idleThread = { ...idleBase, status: "idle" };
  const expected = { ...TASK, lifecycle: "completed" };
  const observer = new NativeCodexTaskObserverV1({ bridgeFactory() {
    return { async inspect() { return idleThread; }, async latestTurn() { return { turnId: "turn-complete", status: "completed" }; }, async collaborationTopologyCounters() { return AGGREGATE_TOPOLOGY; }, async close() {} };
  } });
  assert.equal((await observer.observe(expected)).attestation.latestTurn.status, "completed");
  const missing = new NativeCodexTaskObserverV1({ bridgeFactory() {
    return { async inspect() { return idleThread; }, async latestTurn() { return null; }, async collaborationTopologyCounters() { return AGGREGATE_TOPOLOGY; }, async close() {} };
  } });
  await assert.rejects(missing.observe(expected), (error) => error.code === "THREE_SURFACE_IDENTITY_MISMATCH");
});

test("ordinary observation invokes packaged Nelos identity, task inspection, and runtime health in one worker", async () => {
  let spawned = null;
  const client = new BoundedNelosMcpClientV1({ spawnProcess: fakeMcpProcess((value) => { spawned = value; }), deadlineMs: 1_000 });
  const result = await client.callThreadInspect(TASK.taskId);
  assert.equal(spawned.executable, PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.node);
  assert.deepEqual(spawned.args, [PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.nelosMcp]);
  assert.equal(spawned.options.shell, false);
  assert.equal(spawned.options.env.PATH.split(":")[0], PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.codex.slice(0, PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.codex.lastIndexOf("/")));
  assert.equal(result.serverVersion, "0.12.19");
  assert.deepEqual(result.thread, THREAD);
  assert.equal(result.workerPid, 123);
  assert.deepEqual(result.health, MCP_HEALTH);
});

test("ordinary Nelos observation binds identity and load state to the producing healthy worker", async () => {
  const observer = new NelosMcpTaskObserverV1({ client: { async callThreadInspect() {
    return { health: MCP_HEALTH, serverVersion: "0.12.19", thread: NOT_LOADED_THREAD, workerPid: 123 };
  } } });
  const result = await observer.observe(TASK);
  assert.deepEqual(result.attestation, {
    activeFlags: [], health: { generationKey: GENERATION_KEY, registryState: "single-generation", workerId: WORKER_ID },
    loadState: "notLoaded", server: "nelos", serverVersion: "0.12.19", tool: "nelos_thread_inspect+nelos_runtime_health",
  });

  const unhealthy = structuredClone(MCP_HEALTH); unhealthy.registry.state = "multi-generation";
  const rejected = new NelosMcpTaskObserverV1({ client: { async callThreadInspect() {
    return { health: unhealthy, serverVersion: "0.12.19", thread: NOT_LOADED_THREAD, workerPid: 123 };
  } } });
  await assert.rejects(rejected.observe(TASK), (error) => error.code === "OBSERVATION_UNAVAILABLE");
});

test("active production lifecycle accepts native active and MCP notLoaded with digest-bound visible running proof", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z"); const calls = [];
  const nativeObserver = { async observe() { return { thread: THREAD, attestation: { activeFlags: [], aggregateTaskTopology: AGGREGATE_TOPOLOGY, command: PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.codex, latestTurn: { turnId: "turn-1", status: "inProgress" }, loadState: "active", method: "thread/read+thread/turns/list(parent-history-complete)" } }; } };
  const mcpObserver = { async observe() { return { thread: NOT_LOADED_THREAD, attestation: { activeFlags: [], loadState: "notLoaded", server: "nelos", serverVersion: "0.12.19", tool: "nelos_thread_inspect" } }; } };
  const png = maskedPng(); const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  const screenshot = protectedScreenshot(png, digest, TASK.title, "In progress");
  const client = { async invoke(request) { calls.push(request); return { schemaVersion: 1, runId: BINDING.runId, fencingToken: BINDING.fencingToken, taskId: TASK.taskId, title: TASK.title, lifecycle: "active", observedAt: new Date(now).toISOString(), producer: "visible-codex-desktop", attestation: { accessibilityRole: "list item", aggregateTaskCounters: DESKTOP_COUNTERS, descendantTasks: EMPTY_DESCENDANT_TASKS, lifecycleEvidence: { kind: "text", value: "In progress", scan: { complete: true, scannedNodes: 12, maximumNodes: 2_000 } }, renderedLifecycle: "running", selected: true, screenshot } }; } };
  const evidenceRoot = await mkdtemp(join(tmpdir(), "nelos-task-surface-host-"));
  const observer = new ProducerTaskSurfaceObserverV1({ client, binding: BINDING, nativeObserver, mcpObserver, evidenceRoot, clock: { now: () => now } });
  const result = await observer.observeTask(TASK);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { helper: "/usr/libexec/nelos-desktop-atspi", operation: "observe_task_surface", payload: { ...TASK, descendants: [] } });
  assert.equal(result.native.producer, "native-codex");
  assert.equal(result.mcp.producer, "ordinary-nelos-mcp");
  assert.equal(result.native.attestation.loadState, "active");
  assert.equal(result.mcp.attestation.loadState, "notLoaded");
  assert.equal(result.desktop.attestation.screenshot.digest, screenshot.digest);
  assert.deepEqual(result.aggregateTaskCounters, { state: "launched-rows-verified", visualCountSemantics: "observed-only", authoritativeSource: AGGREGATE_TOPOLOGY.source, visualSource: DESKTOP_COUNTERS.source, current: 0, done: 0, groups: { needsInput: 0, inProgress: 0, queued: 0 }, working: 0, completed: 0, interrupted: 0, descendantCount: 0, topologyDigest: AGGREGATE_TOPOLOGY.topologyDigest });
  assert.deepEqual(await readFile(join(evidenceRoot, `${digest.slice(7)}.png`)), png);

  const wrongTitleRoot = await mkdtemp(join(tmpdir(), "nelos-task-title-mismatch-host-"));
  const wrongTitleClient = { async invoke() {
    const value = structuredClone(await client.invoke({})); value.title = "unexpected test title";
    value.attestation.screenshot.privacy = privacyProof(value.title, "In progress");
    return value;
  } };
  await assert.rejects(new ProducerTaskSurfaceObserverV1({ client: wrongTitleClient, binding: BINDING, nativeObserver, mcpObserver, evidenceRoot: wrongTitleRoot, clock: { now: () => now } }).observeTask(TASK), (error) => error.code === "THREE_SURFACE_IDENTITY_MISMATCH");
  assert.deepEqual(await readFile(join(wrongTitleRoot, `${digest.slice(7)}.png`)), png);

  const unrelatedPrivacyClient = { async invoke() {
    const value = structuredClone(await client.invoke({})); value.attestation.screenshot.privacy.preservedRegions[0].taskId = "01a01ae1-0000-7000-8000-000000000002"; return value;
  } };
  await assert.rejects(new ProducerTaskSurfaceObserverV1({ client: unrelatedPrivacyClient, binding: BINDING, nativeObserver, mcpObserver, clock: { now: () => now } }).observeTask(TASK), (error) => error.code === "UNSAFE_CAPTURE");

  const surroundingTextClient = { async invoke() {
    const value = structuredClone(await client.invoke({}));
    value.attestation.lifecycleEvidence.value = "In progress — summarize the user's private prompt";
    value.attestation.screenshot.privacy = privacyProof(value.title, value.attestation.lifecycleEvidence.value);
    return value;
  } };
  await assert.rejects(new ProducerTaskSurfaceObserverV1({ client: surroundingTextClient, binding: BINDING, nativeObserver, mcpObserver, clock: { now: () => now } }).observeTask(TASK), (error) => error.code === "UNSAFE_CAPTURE");

  const bothNotLoaded = { async observe() { return { thread: NOT_LOADED_THREAD, attestation: { activeFlags: [], aggregateTaskTopology: AGGREGATE_TOPOLOGY, loadState: "notLoaded" } }; } };
  assert.equal((await new ProducerTaskSurfaceObserverV1({ client, binding: BINDING, nativeObserver: bothNotLoaded, mcpObserver: bothNotLoaded, clock: { now: () => now } }).observeTask(TASK)).desktop.attestation.renderedLifecycle, "running");

  const attentionThread = { ...THREAD, activeFlags: ["waitingOnUserInput"] };
  const attention = { async observe() { return { thread: attentionThread, attestation: { activeFlags: ["waitingOnUserInput"], aggregateTaskTopology: AGGREGATE_TOPOLOGY, loadState: "active" } }; } };
  await assert.rejects(new ProducerTaskSurfaceObserverV1({ client, binding: BINDING, nativeObserver: attention, mcpObserver, clock: { now: () => now } }).observeTask(TASK), (error) => error.code === "THREE_SURFACE_IDENTITY_MISMATCH");

  const systemErrorThread = { ...NOT_LOADED_THREAD, status: "systemError" };
  const systemError = { async observe() { return { thread: systemErrorThread, attestation: { activeFlags: [], loadState: "systemError" } }; } };
  await assert.rejects(new ProducerTaskSurfaceObserverV1({ client, binding: BINDING, nativeObserver, mcpObserver: systemError, clock: { now: () => now } }).observeTask(TASK), (error) => error.code === "OBSERVATION_UNAVAILABLE");

  const staleSidebarClient = { async invoke() { const value = await client.invoke({}); value.attestation.renderedLifecycle = "idle"; value.attestation.lifecycleEvidence = { kind: "text", value: "Idle" }; return value; } };
  await assert.rejects(new ProducerTaskSurfaceObserverV1({ client: staleSidebarClient, binding: BINDING, nativeObserver, mcpObserver, clock: { now: () => now } }).observeTask(TASK), (error) => error.code === "THREE_SURFACE_IDENTITY_MISMATCH");
});

test("Current 16 retains queued visual semantics while exact launched descendant rows prove names and statuses", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const descendants = Array.from({ length: 7 }, (_value, index) => ({
    taskId: `01a01ae1-0000-7000-8000-${String(index + 2).padStart(12, "0")}`, parentTaskId: TASK.taskId,
    title: `Worker ${index + 1}`, latestTurnId: `turn-${index + 1}`, latestTurnStatus: index < 4 ? "inProgress" : "completed",
  }));
  const topology = {
    ...AGGREGATE_TOPOLOGY, descendantCount: 7, working: 4, completed: 3, terminal: 3, descendants,
    topologyDigest: `sha256:${createHash("sha256").update(JSON.stringify(descendants)).digest("hex")}`,
  };
  const nativeObserver = { async observe() { return { thread: THREAD, attestation: { activeFlags: [], aggregateTaskTopology: topology, latestTurn: { turnId: "turn-root", status: "inProgress" }, loadState: "active" } }; } };
  const mcpObserver = { async observe() { return { thread: NOT_LOADED_THREAD, attestation: { activeFlags: [], loadState: "notLoaded" } }; } };
  const rootPng = maskedPng(); const rootDigest = `sha256:${createHash("sha256").update(rootPng).digest("hex")}`;
  const counters = { ...DESKTOP_COUNTERS, current: 16, done: 3, groups: { needsInput: 0, inProgress: 4, queued: 12 } };
  const clientFor = (proof) => ({ async invoke() { return {
    schemaVersion: 1, runId: BINDING.runId, fencingToken: BINDING.fencingToken, taskId: TASK.taskId, title: TASK.title, lifecycle: "active", observedAt: new Date(now).toISOString(), producer: "visible-codex-desktop",
    attestation: { accessibilityRole: "list item", aggregateTaskCounters: counters, descendantTasks: proof.value, lifecycleEvidence: { kind: "text", value: "In progress", scan: { complete: true, scannedNodes: 12, maximumNodes: 2_000 } }, renderedLifecycle: "running", selected: true, screenshot: protectedScreenshot(rootPng, rootDigest, TASK.title, "In progress") },
  }; } });

  const healthyProof = descendantDesktopProof(descendants); const evidenceRoot = await mkdtemp(join(tmpdir(), "nelos-descendant-map-"));
  const verified = await new ProducerTaskSurfaceObserverV1({ client: clientFor(healthyProof), binding: BINDING, nativeObserver, mcpObserver, evidenceRoot, clock: { now: () => now } }).observeTask(TASK);
  assert.deepEqual(verified.aggregateTaskCounters, {
    state: "launched-rows-verified", visualCountSemantics: "observed-only", authoritativeSource: topology.source, visualSource: counters.source, current: 16, done: 3,
    groups: { needsInput: 0, inProgress: 4, queued: 12 }, working: 4, completed: 3, interrupted: 0,
    descendantCount: 7, topologyDigest: topology.topologyDigest,
  });
  assert.equal(verified.desktop.attestation.descendantTasks.observationPhases.length, 3);
  for (const png of healthyProof.pngs) assert.deepEqual(await readFile(join(evidenceRoot, createHash("sha256").update(png).digest("hex") + ".png")), png);

  for (const mutation of [{ swapTitles: true }, { swapStatuses: true }]) {
    const proof = descendantDesktopProof(descendants, mutation); const mismatchRoot = await mkdtemp(join(tmpdir(), "nelos-descendant-mismatch-"));
    await assert.rejects(
      new ProducerTaskSurfaceObserverV1({ client: clientFor(proof), binding: BINDING, nativeObserver, mcpObserver, evidenceRoot: mismatchRoot, clock: { now: () => now } }).observeTask(TASK),
      (error) => error.code === "DESCENDANT_TASK_SURFACE_MISMATCH",
    );
    for (const png of proof.pngs) assert.deepEqual(await readFile(join(mismatchRoot, createHash("sha256").update(png).digest("hex") + ".png")), png);
  }

  const interruptedDescendants = descendants.map((value, index) => index === 0 ? { ...value, latestTurnStatus: "interrupted" } : value);
  const interruptedTopology = { ...topology, working: 3, interrupted: 1, terminal: 4, descendants: interruptedDescendants, topologyDigest: `sha256:${createHash("sha256").update(JSON.stringify(interruptedDescendants)).digest("hex")}` };
  const interruptedNativeObserver = { async observe() { return { thread: THREAD, attestation: { activeFlags: [], aggregateTaskTopology: interruptedTopology, latestTurn: { turnId: "turn-root", status: "inProgress" }, loadState: "active" } }; } };
  const interruptedProof = descendantDesktopProof(interruptedDescendants);
  await assert.rejects(
    new ProducerTaskSurfaceObserverV1({ client: clientFor(interruptedProof), binding: BINDING, nativeObserver: interruptedNativeObserver, mcpObserver, clock: { now: () => now } }).observeTask(TASK),
    (error) => error.code === "AGGREGATE_INTERRUPTED_SEMANTICS_UNSUPPORTED",
  );
});

test("completed scenario accepts independent idle or notLoaded states but requires a terminal turn and visibly idle Desktop", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const expected = { ...TASK, lifecycle: "completed" };
  const { activeFlags: _activeFlags, ...idleBase } = THREAD;
  const idleThread = { ...idleBase, status: "idle" };
  const png = maskedPng(1920, 1080, { status: false }); const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  const screenshot = protectedScreenshot(png, digest, expected.title, null);
  const runningPng = maskedPng(); const runningDigest = `sha256:${createHash("sha256").update(runningPng).digest("hex")}`;
  const runningScreenshot = protectedScreenshot(runningPng, runningDigest, expected.title, "In progress");
  const nativeObserver = { async observe() { return { thread: idleThread, attestation: { activeFlags: [], aggregateTaskTopology: AGGREGATE_TOPOLOGY, command: PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.codex, latestTurn: { turnId: "turn-completed", status: "completed" }, loadState: "idle", method: "thread/read+thread/turns/list(parent-history-complete)" } }; } };
  const notLoadedNativeObserver = { async observe() { return { thread: NOT_LOADED_THREAD, attestation: { activeFlags: [], aggregateTaskTopology: AGGREGATE_TOPOLOGY, command: PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.codex, latestTurn: { turnId: "turn-completed", status: "completed" }, loadState: "notLoaded", method: "thread/read+thread/turns/list(parent-history-complete)" } }; } };
  const mcpObserver = { async observe() { return { thread: NOT_LOADED_THREAD, attestation: { activeFlags: [], loadState: "notLoaded", server: "nelos", serverVersion: "0.12.19", tool: "nelos_thread_inspect" } }; } };
  const desktop = (renderedLifecycle, lifecycleEvidence) => ({ schemaVersion: 1, runId: BINDING.runId, fencingToken: BINDING.fencingToken, taskId: expected.taskId, title: expected.title, lifecycle: "completed", observedAt: new Date(now).toISOString(), producer: "visible-codex-desktop", attestation: { accessibilityRole: "list item", aggregateTaskCounters: DESKTOP_COUNTERS, descendantTasks: EMPTY_DESCENDANT_TASKS, lifecycleEvidence, renderedLifecycle, selected: true, screenshot: renderedLifecycle === "idle" ? screenshot : runningScreenshot } });
  const idleClient = { async invoke() { return desktop("idle", { kind: "complete-absence", value: "no-running-approval-or-input-indicator", scan: { complete: true, scannedNodes: 18, maximumNodes: 2_000 } }); } };
  const result = await new ProducerTaskSurfaceObserverV1({ client: idleClient, binding: BINDING, nativeObserver, mcpObserver, clock: { now: () => now } }).observeTask(expected);
  assert.equal(result.native.lifecycle, "completed");
  assert.equal(result.mcp.attestation.loadState, "notLoaded");
  assert.equal(result.desktop.attestation.renderedLifecycle, "idle");
  assert.equal((await new ProducerTaskSurfaceObserverV1({ client: idleClient, binding: BINDING, nativeObserver: notLoadedNativeObserver, mcpObserver, clock: { now: () => now } }).observeTask(expected)).native.attestation.loadState, "notLoaded");

  const staleRunningClient = { async invoke() { return desktop("running", { kind: "text", value: "In progress", scan: { complete: true, scannedNodes: 18, maximumNodes: 2_000 } }); } };
  const mismatchRoot = await mkdtemp(join(tmpdir(), "nelos-stale-running-evidence-"));
  const evidenceRoot = join(mismatchRoot, "screenshots"); const diagnosticRoot = join(mismatchRoot, "diagnostics");
  await assert.rejects(new ProducerTaskSurfaceObserverV1({ client: staleRunningClient, binding: BINDING, nativeObserver, mcpObserver, evidenceRoot, diagnosticRoot, clock: { now: () => now } }).observeTask(expected), (error) => error.code === "THREE_SURFACE_IDENTITY_MISMATCH");
  assert.deepEqual(await readFile(join(evidenceRoot, `${runningDigest.slice(7)}.png`)), runningPng);
  const diagnostics = await readdir(diagnosticRoot); assert.equal(diagnostics.length, 1);
  const mismatch = JSON.parse(await readFile(join(diagnosticRoot, diagnostics[0]), "utf8"));
  assert.deepEqual({ native: mismatch.nativeLoadState, mcp: mismatch.mcpLoadState, desktop: mismatch.desktopRenderedLifecycle, expected: mismatch.expectedLifecycle }, { native: "idle", mcp: "notLoaded", desktop: "running", expected: "completed" });

  const noTurnNative = { async observe() { return { thread: idleThread, attestation: { activeFlags: [], aggregateTaskTopology: AGGREGATE_TOPOLOGY, command: PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.codex, latestTurn: null, loadState: "idle", method: "thread/read+thread/turns/list(parent-history-complete)" } }; } };
  await assert.rejects(new ProducerTaskSurfaceObserverV1({ client: idleClient, binding: BINDING, nativeObserver: noTurnNative, mcpObserver, clock: { now: () => now } }).observeTask(expected), (error) => error.code === "THREE_SURFACE_IDENTITY_MISMATCH");

  const rejectedRoot = await mkdtemp(join(tmpdir(), "nelos-producer-rejection-evidence-"));
  const rejectedEvidenceRoot = join(rejectedRoot, "screenshots"); const rejectedDiagnosticRoot = join(rejectedRoot, "diagnostics");
  const unavailableNative = { async observe() { throw Object.assign(new Error("bounded native producer failure"), { code: "OBSERVATION_UNAVAILABLE" }); } };
  await assert.rejects(new ProducerTaskSurfaceObserverV1({ client: idleClient, binding: BINDING, nativeObserver: unavailableNative, mcpObserver, evidenceRoot: rejectedEvidenceRoot, diagnosticRoot: rejectedDiagnosticRoot, clock: { now: () => now } }).observeTask(expected), (error) => error.code === "OBSERVATION_UNAVAILABLE");
  assert.deepEqual(await readFile(join(rejectedEvidenceRoot, `${digest.slice(7)}.png`)), png);
  const rejectedDiagnostics = await readdir(rejectedDiagnosticRoot); assert.equal(rejectedDiagnostics.length, 1);
  const rejectedDiagnostic = JSON.parse(await readFile(join(rejectedDiagnosticRoot, rejectedDiagnostics[0]), "utf8"));
  assert.equal(rejectedDiagnostic.nativeLoadState, "unavailable");
  assert.equal(rejectedDiagnostic.desktopRenderedLifecycle, "idle");
});

test("guest Desktop observer persists only the recomputed protected screenshot and rejects staged task claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-visible-task-observer-"));
  await mkdir(join(root, "etc/nelos-desktop"), { recursive: true });
  // The installed binder canonicalizes JSON keys, so identity equality must be
  // semantic after both closed objects have been validated.
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(Object.fromEntries(Object.entries(BINDING).sort(([left], [right]) => left.localeCompare(right)))));
  const png = maskedPng(100, 80); const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  const control = join(root, "atspi-control.mjs");
  const controlResult = {
    taskId: TASK.taskId, title: TASK.title, lifecycle: "active", renderedLifecycle: "running", lifecycleEvidence: { kind: "role", value: "spinner", scan: { complete: true, scannedNodes: 12, maximumNodes: 2_000 } }, aggregateTaskCounters: DESKTOP_COUNTERS, descendantTasks: EMPTY_DESCENDANT_TASKS, accessibilityRole: "list item", selected: true,
    screenshot: { ...protectedScreenshot(png, digest, TASK.title, "spinner", { path: false }), width: 100, height: 80 },
  };
  await writeFile(control, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(controlResult)}'\n`); await chmod(control, 0o755);
  const helper = new URL("../validation/proxmox/desktop/helpers/nelos-desktop-atspi.mjs", import.meta.url).pathname;
  const envelope = (operation, payload) => `${JSON.stringify({ schemaVersion: 1, binding: BINDING, operation, payload, byteLength: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 65_536 })}\n`;
  const observed = await runHelper(helper, "observe_task_surface", envelope("observe_task_surface", { ...TASK, descendants: [] }), { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_ATSPI_CONTROL: control });
  assert.equal(observed.attestation.screenshot.digest, digest);
  assert.equal(observed.attestation.screenshot.path, `${BINDING.stateRoot}/surface-observations/${digest.slice(7)}.png`);
  assert.deepEqual(await readFile(join(root, observed.attestation.screenshot.path)), png);
  await assert.rejects(runHelper(helper, "stage_task_surfaces", envelope("stage_task_surfaces", { surfaces: {} }), { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_ATSPI_CONTROL: control }), (error) => error.exitCode === 77);
});

test("production AT-SPI descendant classifier retains exact Current 16 rows and fails closed on unbound identities", () => {
  const probe = fileURLToPath(new URL("./fixtures/atspi-descendant-surface-probe.py", import.meta.url));
  const helper = fileURLToPath(new URL("../validation/proxmox/desktop/helpers/nelos-atspi-control", import.meta.url));
  const run = (mode) => spawnSync("python3", [probe, helper, mode], { encoding: "utf8" });

  const valid = run("valid");
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    counts: {
      schemaVersion: 1, source: "visible-codex-desktop-atspi", current: 16, done: 3,
      groups: { needsInput: 0, inProgress: 4, queued: 12 },
      scan: { complete: true, scannedNodes: 24, maximumNodes: 10_000 },
    },
    sidebarCount: 7, mcpCount: 7, matchesExpected: true,
    showMore: ["Show 1 more…", "Show 9 more…"],
  });

  for (const mode of ["swapped-name", "swapped-status"]) {
    const mismatch = run(mode);
    assert.equal(mismatch.status, 0, mismatch.stderr);
    const value = JSON.parse(mismatch.stdout);
    assert.equal(value.matchesExpected, false);
    assert.deepEqual(value.counts.groups, { needsInput: 0, inProgress: 4, queued: 12 });
  }

  for (const mode of ["missing-sidebar-id", "wrong-mcp-aria"]) {
    const unsupported = run(mode);
    assert.equal(unsupported.status, 70, unsupported.stdout);
    assert.deepEqual(JSON.parse(unsupported.stderr), { error: "DESCENDANT_SURFACE_IDENTITY_MISMATCH" });
  }
});

test("oversized low-memory ImageMagick capture cannot spill a raw pixel cache", () => {
  const probe = fileURLToPath(new URL("./fixtures/atspi-imagemagick-cache-probe.py", import.meta.url));
  const helper = fileURLToPath(new URL("../validation/proxmox/desktop/helpers/nelos-atspi-control", import.meta.url));
  const bounded = spawnSync("python3", [probe, helper, "bounded"], { encoding: "utf8" });
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.deepEqual(JSON.parse(bounded.stdout), { result: "bounded-memory-result", error: null, cacheDirectoriesCreated: 1, remainingEntries: [] });
  const oversized = spawnSync("python3", [probe, helper, "oversized-spill"], { encoding: "utf8" });
  assert.equal(oversized.status, 0, oversized.stderr);
  assert.deepEqual(JSON.parse(oversized.stdout), { result: null, error: "CAPTURE_CACHE_SPILL", cacheDirectoriesCreated: 1, remainingEntries: [] });
});

test("installed AT-SPI and provider routes expose the visible observer but no self-asserting task staging", async () => {
  const [control, guest, provider] = await Promise.all([
    readFile(new URL("../validation/proxmox/desktop/helpers/nelos-atspi-control", import.meta.url), "utf8"),
    readFile(new URL("../validation/proxmox/desktop/helpers/nelos-desktop-atspi.mjs", import.meta.url), "utf8"),
    readFile(new URL("../validation/proxmox/desktop/helpers/nelos-proxmox-host-helper.py", import.meta.url), "utf8"),
  ]);
  for (const source of [control, guest, provider]) assert.match(source, /observe_task_surface/u);
  for (const source of [control, guest, provider]) assert.match(source, /observe_archive_surface/u);
  for (const source of [control, guest, provider]) assert.match(source, /expected_task_visible/u);
  assert.match(control, /STATE_SHOWING/u);
  assert.match(control, /hashlib\.sha256/u);
  assert.match(control, /full-frame-black/u);
  assert.match(control, /TEXT_LIFECYCLE_LABELS\.get\(canonical_lifecycle_text\(text\)\)/u);
  assert.doesNotMatch(control, /status_text\.strip\(\)\[:256\]/u);
  assert.match(control, /\/usr\/bin\/import/u);
  assert.match(control, /MAGICK_MAP_LIMIT":"0"/u);
  assert.match(control, /MAGICK_DISK_LIMIT":"0"/u);
  assert.match(control, /runtime_mount_type\(runtime_root\) not in \("tmpfs","ramfs"\)/u);
  assert.doesNotMatch(control, /source\.png|tempfile/u);
  const [install, readiness] = await Promise.all([
    readFile(new URL("../validation/proxmox/desktop/recipe-v1/install-guest.sh", import.meta.url), "utf8"),
    readFile(new URL("../validation/proxmox/desktop/recipe-v1/check-gui-readiness.sh", import.meta.url), "utf8"),
  ]);
  for (const source of [install, readiness]) {
    assert.match(source, /MAGICK_MAP_LIMIT=0/u); assert.match(source, /MAGICK_DISK_LIMIT=0/u);
    assert.match(source, /-limit map 0 -limit disk 0/u);
  }
  assert.match(readiness, /findmnt -n -o FSTYPE/u);
  assert.match(guest, /validPrivacyProof/u);
  assert.doesNotMatch(guest, /stage_task_surfaces/u);
  assert.doesNotMatch(provider, /stage_task_surfaces/u);
  assert.doesNotMatch(provider, /compare_task_surfaces/u);
  assert.doesNotMatch(guest, /stage_archive_observations/u);
  assert.doesNotMatch(provider, /stage_archive_observations/u);
});
