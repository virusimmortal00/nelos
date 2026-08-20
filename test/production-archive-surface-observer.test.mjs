import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NativeCodexArchiveObserverV1,
  NelosMcpArchiveObserverV1,
  ProducerArchiveSurfaceObserverV1,
} from "../src/production-archive-surface-observer.mjs";
import { BoundedNelosMcpClientV1, PRODUCTION_TASK_SURFACE_EXECUTABLES_V1 } from "../src/production-task-surface-observer.mjs";
import { encodePngRgba } from "../src/remote-desktop-evidence/index.mjs";
import { runtimeGenerationKeyV1 } from "../src/runtime-worker-registry.mjs";

const THREAD_ID = "01a01ae1-0000-7000-8000-000000000001";
const BINDING = {
  providerId: "proxmox-lab", hostId: "prox2", vmId: "9401", leaseId: "lease-1", fencingToken: "fence-1",
  macAddress: "02:4E:45:4C:94:01", networkId: "nelosbld", gatewayId: "9023", networkPolicyDigest: `sha256:${"9".repeat(64)}`,
  imageId: "image-1", runId: "remote-desktop-run-001", automationUser: "nelosauto", stateRoot: "/var/lib/nelos-desktop/runs/remote-desktop-run-001",
};
const REQUEST = { schemaVersion: 1, runId: BINDING.runId, sequence: 1, phase: "afterCleanup", expectedThreads: [{ threadId: THREAD_ID, title: "Scenario one" }] };
const PROOF = {
  schemaVersion: 1,
  conversation: { kind: "conversation", x: 20, y: 10, width: 70, height: 60 },
  credentialInventory: { complete: true, count: 0, regions: [] },
  traversal: { complete: true, scannedNodes: 30, maximumNodes: 10_000 },
};
const RUNTIME_IDENTITY = {
  version: "0.12.19", sourceRevision: "a".repeat(40), cacheIdentity: "nelos@0.12.19",
  integrity: `sha256:${"1".repeat(64)}`, modulePath: "/opt/nelos", buildIdentity: `nelos-build:${"2".repeat(32)}`,
};
const GENERATION_KEY = runtimeGenerationKeyV1(RUNTIME_IDENTITY);

function archiveSurfaceScans({ sidebar = [], createdTasks = [], mcpVisual = [] } = {}) {
  return [
    { surface: "sidebar", contract: "codex-desktop-sidebar-app-action-v1", state: "present", accessibilityRole: "scroll pane", geometry: { x: 0, y: 0, width: 10, height: 80 }, scan: { complete: true, scannedNodes: 10, maximumNodes: 10_000 }, threadIds: sidebar },
    { surface: "createdTasks", contract: "codex-desktop-created-tasks-summary-v1", state: createdTasks.length === 0 ? "empty" : "present", accessibilityRole: createdTasks.length === 0 ? "button" : "presentation", geometry: { x: 10, y: 0, width: 10, height: 80 }, scan: { complete: true, scannedNodes: 20, maximumNodes: 10_000 }, threadIds: createdTasks },
    { surface: "mcpVisual", contract: "nelos-mcp-task-workers-v1", state: "present", accessibilityRole: "group", geometry: { x: 20, y: 0, width: 10, height: 80 }, scan: { complete: true, scannedNodes: 15, maximumNodes: 10_000 }, threadIds: mcpVisual },
  ];
}

function maskedPng(regions = []) {
  const width = 100; const height = 80; const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) rgba[pixel * 4 + 3] = 255;
  for (const region of regions) {
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        const offset = (y * width + x) * 4;
        rgba[offset] = 220; rgba[offset + 1] = 225; rgba[offset + 2] = 230;
      }
    }
  }
  const png = encodePngRgba({ width, height, rgba });
  rgba.fill(0);
  return png;
}

function desktopValue(now, png) {
  const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  const privacy = { schemaVersion: 1, classificationComplete: true, maskedBase: "full-frame-black", mode: "expected-archive-evidence-only", preservedRegions: [], rawPixelsPersisted: false, traversal: { ...PROOF.traversal } };
  return {
    schemaVersion: 1, runId: BINDING.runId, fencingToken: BINDING.fencingToken, sequence: 1, phase: "afterCleanup", appInstanceId: "desktop-pid-123", observedAt: new Date(now).toISOString(), producer: "visible-codex-desktop-atspi",
    scan: { complete: true, scannedNodes: 30, maximumNodes: 10_000 }, surfaceScans: archiveSurfaceScans(), sidebarThreadIds: [], createdTasksThreadIds: [], mcpVisualThreadIds: [], screenshotThreadIds: [],
    screenshot: { bytesBase64: png.toString("base64"), byteLength: png.length, digest, width: 100, height: 80, mediaType: "image/png", path: `${BINDING.stateRoot}/archive-surface-observations/${digest.slice(7)}.png`, privacy, protectedInventory: PROOF, protectedRegions: [PROOF.conversation], protection: { geometryCertain: true, inventoryComplete: true, mode: "mask" } },
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

function fakeArchiveMcpProcess(calls) {
  return () => {
    const child = new EventEmitter(); const stdout = new EventEmitter(); stdout.setEncoding = () => {};
    child.pid = 123; child.stdout = stdout; child.kill = () => {};
    child.stdin = {
      destroy() {},
      write(text) {
        const message = JSON.parse(text);
        if (!Object.hasOwn(message, "id")) return true;
        let result;
        if (message.method === "initialize") {
          result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "nelos", version: "0.12.19" }, instructions: "bounded" };
        } else {
          const call = message.params; calls.push(call);
          const body = call.name === "nelos_thread_inventory"
            ? { command: "thread inventory", inventory: { schemaVersion: 1, requested: call.arguments.threadIds.length, succeeded: 0, failed: call.arguments.threadIds.length, items: call.arguments.threadIds.map((threadId) => ({ threadId, state: "failed", error: { code: "request-rejected", retriable: false } })) } }
            : { command: "runtime health", health: { registry: { state: "single-generation", mutationAllowed: true, liveWorkerCount: 1, recoveredWorkerIds: [], activeGenerations: [{ generationKey: GENERATION_KEY, identity: RUNTIME_IDENTITY, workers: [{ workerId: `worker:${"b".repeat(64)}`, pid: 123, state: "active", heartbeatAt: "2026-08-20T12:00:00.000Z" }] }] } } };
          result = { content: [{ type: "text", text: JSON.stringify(body) }], isError: false };
        }
        queueMicrotask(() => stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
        return true;
      },
    };
    return child;
  };
}

test("production AT-SPI archive classifier proves three independent exact containers and fails closed", () => {
  const probe = fileURLToPath(new URL("./fixtures/atspi-archive-surface-probe.py", import.meta.url));
  const helper = fileURLToPath(new URL("../validation/proxmox/desktop/helpers/nelos-atspi-control", import.meta.url));
  const valid = spawnSync("python3", [probe, helper, "valid"], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  const proofs = JSON.parse(valid.stdout).proofs;
  assert.deepEqual(proofs.map(({ surface, threadIds }) => [surface, threadIds]), [
    ["sidebar", ["01a01ae1-0000-7000-8000-000000000001"]],
    ["createdTasks", ["01a01ae1-0000-7000-8000-000000000002"]],
    ["mcpVisual", ["01a01ae1-0000-7000-8000-000000000003"]],
  ]);
  assert.equal(new Set(proofs.map(({ geometry }) => JSON.stringify(geometry))).size, 3);

  for (const [mode, code] of [
    ["aliased", "ARCHIVE_SURFACE_AMBIGUOUS"],
    ["collapsed-created", "ARCHIVE_SURFACE_UNSUPPORTED"],
    ["duplicate-mcp", "ARCHIVE_SURFACE_AMBIGUOUS"],
    ["missing-created", "ARCHIVE_SURFACE_UNSUPPORTED"],
    ["show-more", "ARCHIVE_SURFACE_INCOMPLETE"],
    ["missing-sidebar-id", "ARCHIVE_SURFACE_IDENTITY_UNSUPPORTED"],
    ["wrong-sidebar-id", "ARCHIVE_SURFACE_IDENTITY_UNSUPPORTED"],
    ["missing-created-status", "ARCHIVE_SURFACE_IDENTITY_UNSUPPORTED"],
    ["wrong-created-status", "ARCHIVE_SURFACE_IDENTITY_UNSUPPORTED"],
    ["missing-mcp-aria", "ARCHIVE_SURFACE_IDENTITY_UNSUPPORTED"],
    ["wrong-mcp-aria", "ARCHIVE_SURFACE_IDENTITY_UNSUPPORTED"],
  ]) {
    const rejected = spawnSync("python3", [probe, helper, mode], { encoding: "utf8" });
    assert.equal(rejected.status, 70);
    assert.equal(JSON.parse(rejected.stderr).error, code);
  }
});

test("guest wrapper retains independent surface proofs and propagates typed classifier refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-archive-atspi-wrapper-"));
  await mkdir(join(root, "etc/nelos-desktop"), { recursive: true });
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(BINDING));
  const png = maskedPng(); const raw = desktopValue(Date.now(), png);
  delete raw.producer; delete raw.screenshot.path;
  const control = join(root, "atspi-control");
  await writeFile(control, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(raw)}'\n`); await chmod(control, 0o755);
  const helper = fileURLToPath(new URL("../validation/proxmox/desktop/helpers/nelos-desktop-atspi.mjs", import.meta.url));
  const envelope = `${JSON.stringify({ schemaVersion: 1, binding: BINDING, operation: "observe_archive_surface", payload: REQUEST, byteLength: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 1_048_576 })}\n`;
  const observed = await runHelper(helper, "observe_archive_surface", envelope, { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_ATSPI_CONTROL: control });
  assert.deepEqual(observed.surfaceScans.map(({ surface }) => surface), ["sidebar", "createdTasks", "mcpVisual"]);
  assert.deepEqual(observed.screenshotThreadIds, []);

  for (const code of ["ARCHIVE_SURFACE_UNSUPPORTED", "ARCHIVE_SURFACE_IDENTITY_UNSUPPORTED"]) {
    const refusingControl = join(root, `atspi-control-refusing-${code.toLowerCase()}`);
    await writeFile(refusingControl, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${JSON.stringify({ error: code, message: "bounded classifier refusal" })}' >&2\nexit 70\n`); await chmod(refusingControl, 0o755);
    await assert.rejects(
      runHelper(helper, "observe_archive_surface", envelope, { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_ATSPI_CONTROL: refusingControl }),
      (error) => error.exitCode === 70 && JSON.parse(error.message).error === code,
    );
  }
});

test("native archive inventory uses the pinned app-server thread/list producer", async () => {
  let command; let request; let closed = false;
  const observer = new NativeCodexArchiveObserverV1({ bridgeFactory(value) {
    command = value;
    return { async visibleThreadIds(args) { request = args; return []; }, async close() { closed = true; } };
  } });
  const result = await observer.observe(REQUEST.expectedThreads);
  assert.equal(command, PRODUCTION_TASK_SURFACE_EXECUTABLES_V1.codex);
  assert.deepEqual(request, { threadIds: [THREAD_ID] });
  assert.deepEqual(result.visibleThreadIds, []);
  assert.equal(result.method, "thread/list");
  assert.equal(closed, true);
});

test("archive producers batch the full 100-task lane contract through fixed native and MCP routes", async () => {
  const expectedThreads = Array.from({ length: 100 }, (_, index) => ({
    threadId: `01a01ae1-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
    title: `Scenario ${index + 1}`,
  }));
  const nativeBatches = [];
  const native = new NativeCodexArchiveObserverV1({ bridgeFactory() {
    return { async visibleThreadIds({ threadIds }) { nativeBatches.push(threadIds); return []; }, async close() {} };
  } });
  assert.deepEqual((await native.observe(expectedThreads)).visibleThreadIds, []);
  assert.deepEqual(nativeBatches.map((ids) => ids.length), [16, 16, 16, 16, 16, 16, 4]);

  const calls = [];
  const client = new BoundedNelosMcpClientV1({ spawnProcess: fakeArchiveMcpProcess(calls), deadlineMs: 1_000 });
  const projection = await client.callArchiveProjection(expectedThreads.map(({ threadId }) => threadId));
  assert.equal(projection.inventory.requested, 100);
  assert.equal(projection.inventory.items.length, 100);
  assert.deepEqual(calls.map(({ name, arguments: args }) => [name, args.threadIds?.length ?? null]), [
    ["nelos_thread_inventory", 16], ["nelos_thread_inventory", 16], ["nelos_thread_inventory", 16],
    ["nelos_thread_inventory", 16], ["nelos_thread_inventory", 16], ["nelos_thread_inventory", 16],
    ["nelos_thread_inventory", 4], ["nelos_runtime_health", null],
  ]);
});

test("packaged MCP archive projection binds non-retriable inventory absence to its live worker registry", async () => {
  const observer = new NelosMcpArchiveObserverV1({ client: { async callArchiveProjection(ids) {
    return {
      serverVersion: "0.12.19",
      workerPid: 123,
      inventory: { schemaVersion: 1, requested: 1, succeeded: 0, failed: 1, items: [{ threadId: ids[0], state: "failed", error: { code: "request-rejected", retriable: false } }] },
      health: { registry: { state: "single-generation", mutationAllowed: true, liveWorkerCount: 2, recoveredWorkerIds: [], activeGenerations: [{ generationKey: GENERATION_KEY, identity: RUNTIME_IDENTITY, workers: [
        { workerId: `worker:${"b".repeat(64)}`, pid: 123, state: "active", heartbeatAt: "2026-08-20T12:00:00.000Z" },
        { workerId: `worker:${"c".repeat(64)}`, pid: 124, state: "active", heartbeatAt: "2026-08-20T12:00:00.000Z" },
      ] }] } },
    };
  } } });
  const result = await observer.observe(REQUEST.expectedThreads);
  assert.deepEqual(result.visibleThreadIds, []);
  assert.deepEqual(result.workers, [{ workerId: `worker:${"b".repeat(64)}`, archivedThreadIds: [THREAD_ID] }]);
  assert.equal(result.tool, "nelos_thread_inventory+nelos_runtime_health");
});

test("producer archive checkpoint needs no observationRoot fixture and persists the actual protected Desktop PNG", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z"); const png = maskedPng(); const evidenceRoot = await mkdtemp(join(tmpdir(), "nelos-archive-surface-host-"));
  const client = { async invoke({ operation, payload }) { assert.equal(operation, "observe_archive_surface"); assert.deepEqual(payload, REQUEST); return desktopValue(now, png); } };
  const nativeObserver = { async observe() { return { visibleThreadIds: [] }; } };
  const mcpObserver = { async observe() { return { visibleThreadIds: [], workers: [{ workerId: `worker:${"d".repeat(64)}`, archivedThreadIds: [THREAD_ID] }] }; } };
  const observer = new ProducerArchiveSurfaceObserverV1({ client, binding: BINDING, nativeObserver, mcpObserver, evidenceRoot, clock: { now: () => now } });
  const checkpoint = await observer.observeArchive(REQUEST);
  assert.equal(checkpoint.cleanupState, "complete");
  assert.deepEqual(checkpoint.nativeVisibleThreadIds, []);
  assert.deepEqual(checkpoint.ordinaryMapThreadIds, []);
  const report = JSON.parse(Buffer.from(checkpoint.visualEvidence.reportBytesBase64, "base64"));
  assert.equal(report.capture.digest, desktopValue(now, png).screenshot.digest);
  assert.deepEqual(report.surfaceScans.map(({ surface, threadIds }) => [surface, threadIds]), [["sidebar", []], ["createdTasks", []], ["mcpVisual", []]]);
  assert.deepEqual(await readFile(join(evidenceRoot, `${report.capture.digest.slice(7)}.png`)), png);
});

test("archive checkpoint fails closed when native and packaged MCP visibility disagree", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z"); const png = maskedPng();
  const observer = new ProducerArchiveSurfaceObserverV1({
    client: { async invoke() { return desktopValue(now, png); } }, binding: BINDING,
    nativeObserver: { async observe() { return { visibleThreadIds: [THREAD_ID] }; } },
    mcpObserver: { async observe() { return { visibleThreadIds: [], workers: [{ workerId: `worker:${"d".repeat(64)}`, archivedThreadIds: [THREAD_ID] }] }; } },
    clock: { now: () => now },
  });
  await assert.rejects(observer.observeArchive(REQUEST), (error) => error.code === "ARCHIVE_OBSERVATION_MISMATCH");
});

test("archive checkpoint rejects the legacy generic row inventory aliased into all visual surfaces", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z"); const png = maskedPng();
  const client = { async invoke() {
    const value = desktopValue(now, png);
    value.sidebarThreadIds = [THREAD_ID]; value.createdTasksThreadIds = [THREAD_ID]; value.mcpVisualThreadIds = [THREAD_ID];
    value.surfaceScans = archiveSurfaceScans({ sidebar: [THREAD_ID], createdTasks: [THREAD_ID], mcpVisual: [THREAD_ID] });
    value.surfaceScans[1].geometry = { ...value.surfaceScans[0].geometry };
    value.surfaceScans[2].geometry = { ...value.surfaceScans[0].geometry };
    return value;
  } };
  await assert.rejects(new ProducerArchiveSurfaceObserverV1({
    client, binding: BINDING,
    nativeObserver: { async observe() { return { visibleThreadIds: [] }; } },
    mcpObserver: { async observe() { return { visibleThreadIds: [], workers: [{ workerId: `worker:${"d".repeat(64)}`, archivedThreadIds: [THREAD_ID] }] }; } },
    clock: { now: () => now },
  }).observeArchive(REQUEST), (error) => error.code === "ARCHIVE_OBSERVATION_MISMATCH");
});

test("archive screenshot may preserve only an exact requested stale row and rejects unrelated task pixels", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const titleRegion = { kind: "expected-task-title", taskId: THREAD_ID, textDigest: `sha256:${"a".repeat(64)}`, x: 2, y: 2, width: 10, height: 5 };
  const png = maskedPng([titleRegion]);
  const exactClient = { async invoke() {
    const value = desktopValue(now, png);
    value.sidebarThreadIds = [THREAD_ID]; value.createdTasksThreadIds = [THREAD_ID]; value.mcpVisualThreadIds = [THREAD_ID];
    value.surfaceScans = archiveSurfaceScans({ sidebar: [THREAD_ID], createdTasks: [THREAD_ID], mcpVisual: [THREAD_ID] });
    value.screenshotThreadIds = [THREAD_ID];
    value.screenshot.privacy.preservedRegions = [titleRegion];
    return value;
  } };
  const visibleNative = { async observe() { return { visibleThreadIds: [THREAD_ID] }; } };
  const visibleMcp = { async observe() { return { visibleThreadIds: [THREAD_ID], workers: [{ workerId: `worker:${"d".repeat(64)}`, archivedThreadIds: [] }] }; } };
  const checkpoint = await new ProducerArchiveSurfaceObserverV1({ client: exactClient, binding: BINDING, nativeObserver: visibleNative, mcpObserver: visibleMcp, clock: { now: () => now } }).observeArchive(REQUEST);
  assert.equal(checkpoint.cleanupState, "attention");
  assert.deepEqual(JSON.parse(Buffer.from(checkpoint.visualEvidence.reportBytesBase64, "base64")).capture.privacy.preservedTaskIds, [THREAD_ID]);

  const unrelatedClient = { async invoke() {
    const value = desktopValue(now, png);
    value.screenshot.privacy.preservedRegions = [{ kind: "expected-task-title", taskId: "01a01ae1-0000-7000-8000-000000000002", textDigest: `sha256:${"b".repeat(64)}`, x: 2, y: 2, width: 10, height: 5 }];
    return value;
  } };
  await assert.rejects(new ProducerArchiveSurfaceObserverV1({
    client: unrelatedClient, binding: BINDING,
    nativeObserver: { async observe() { return { visibleThreadIds: [] }; } },
    mcpObserver: { async observe() { return { visibleThreadIds: [], workers: [{ workerId: `worker:${"d".repeat(64)}`, archivedThreadIds: [THREAD_ID] }] }; } },
    clock: { now: () => now },
  }).observeArchive(REQUEST), (error) => error.code === "UNSAFE_CAPTURE");

  const unrelatedInventoryClient = { async invoke() {
    const value = desktopValue(now, png); const unrelated = "01a01ae1-0000-7000-8000-000000000002";
    value.sidebarThreadIds = [unrelated]; value.surfaceScans = archiveSurfaceScans({ sidebar: [unrelated] }); return value;
  } };
  await assert.rejects(new ProducerArchiveSurfaceObserverV1({
    client: unrelatedInventoryClient, binding: BINDING,
    nativeObserver: { async observe() { return { visibleThreadIds: [] }; } },
    mcpObserver: { async observe() { return { visibleThreadIds: [], workers: [{ workerId: `worker:${"d".repeat(64)}`, archivedThreadIds: [THREAD_ID] }] }; } },
    clock: { now: () => now },
  }).observeArchive(REQUEST), (error) => error.code === "ARCHIVE_OBSERVATION_MISMATCH");
});
