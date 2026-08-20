import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  ProxmoxDesktopError,
  admitCapture,
  assertPreDestroyCollection,
  attestEvidenceInventory,
  compareTaskSurfaces,
  mutateProxmoxVm,
  readProxmoxVm,
  sha256,
  validateHelperRequest,
  validateRunPacket,
  validateSanitizedDiagnostics,
  validateSealedRoots,
  verifyDeviceAuthIsolation,
} from "../src/proxmox-desktop-runtime.mjs";

const binding = Object.freeze({
  fencingToken: "fence-9",
  hostId: "pve-1",
  leaseId: "lease-7",
  providerId: "production-pve",
  runId: "run-1",
  vmid: 319,
});

function errorCode(code) {
  return (error) => error instanceof ProxmoxDesktopError && error.code === code;
}

function packet(now = Date.now()) {
  const packetValue = {
    authorization: { gateId: "gate-1", runId: binding.runId, used: false },
    binding,
    budgets: { captureCount: 4, runDeadlineAt: new Date(now + 120_000).toISOString(), stepDeadlineMs: 20_000 },
    capture: { height: 1080, protectedRegions: [{ height: 40, name: "system-bar", width: 1920, x: 0, y: 0 }], width: 1920 },
    expectedTask: { taskId: "task-fresh-1", title: "Production Desktop validation" },
    lease: { active: true, binding, expiresAt: new Date(now + 60_000).toISOString(), observedAt: new Date(now - 1_000).toISOString() },
    roots: {
      evidence: { gid: process.getgid(), mode: "0700", path: "/sealed/evidence", sealed: true, uid: process.getuid() },
      packet: { gid: process.getgid(), mode: "0700", path: "/sealed/packet", sealed: true, uid: process.getuid() },
      staging: { gid: process.getgid(), mode: "0700", path: "/sealed/staging", sealed: true, uid: process.getuid() },
    },
    schemaVersion: 1,
  };
  return { digest: sha256(packetValue), packet: packetValue };
}

test("provider read preserves only not-found and async mutations reach bounded success", async () => {
  const missing = await readProxmoxVm({ readVm: async () => { throw Object.assign(new Error("missing"), { status: 404 }); } }, binding);
  assert.equal(missing, null);
  await assert.rejects(() => readProxmoxVm({ readVm: async () => { throw Object.assign(new Error("denied"), { status: 403 }); } }, binding), /denied/u);
  const observations = [
    { state: "running" },
    { exitStatus: "OK", state: "stopped" },
  ];
  let clock = 0;
  const receipt = await mutateProxmoxVm({
    mutateVm: async () => ({ taskId: "UPID:pve:1" }),
    readTask: async () => observations.shift(),
  }, "start", binding, { deadlineMs: 20, now: () => clock, pollIntervalMs: 1, wait: async () => { clock += 1; } });
  assert.deepEqual(receipt, { exitStatus: "OK", operation: "start", polls: 2, taskId: "UPID:pve:1", terminalState: "stopped" });
});

test("provider failure and nonterminal deadline never produce a committed receipt", async () => {
  await assert.rejects(() => mutateProxmoxVm({
    mutateVm: async () => ({ taskId: "UPID:pve:2" }),
    readTask: async () => ({ exitStatus: "ERROR", state: "stopped" }),
  }, "destroy", binding), errorCode("PROVIDER_TASK_FAILED"));
  let clock = 0;
  await assert.rejects(() => mutateProxmoxVm({
    mutateVm: async () => ({ taskId: "UPID:pve:3" }),
    readTask: async () => ({ state: "running" }),
  }, "clone", binding, { deadlineMs: 2, now: () => clock, pollIntervalMs: 1, wait: async () => { clock += 1; } }), errorCode("PROVIDER_TASK_TIMEOUT"));
});

test("immutable packet validates fresh lease, budgets, capture bounds, and one-run authorization", () => {
  const now = Date.now();
  assert.equal(validateRunPacket(packet(now), { now, authorize: ({ gateId }) => gateId === "gate-1" }).binding.vmid, 319);
  const stale = packet(now);
  stale.packet.lease.observedAt = new Date(now - 31_000).toISOString();
  stale.digest = sha256(stale.packet);
  assert.throws(() => validateRunPacket(stale, { now, authorize: () => true }), errorCode("STALE_OBSERVATION"));
  const altered = packet(now);
  altered.packet.binding = { ...binding, fencingToken: "changed" };
  assert.throws(() => validateRunPacket(altered, { now, authorize: () => true }), errorCode("PACKET_DIGEST_MISMATCH"));
});

test("sealed staging roots validate actual ownership, mode, type, and non-nesting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-roots-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const roots = {};
  for (const name of ["evidence", "packet", "staging"]) {
    const path = join(root, name);
    await mkdir(path);
    await chmod(path, 0o700);
    const stat = await lstat(path);
    roots[name] = { gid: stat.gid, mode: "0700", path, sealed: true, uid: stat.uid };
  }
  assert.equal(await validateSealedRoots(roots), true);
  await chmod(roots.staging.path, 0o777);
  await assert.rejects(() => validateSealedRoots(roots), errorCode("UNSEALED_ROOT"));
});

test("host and guest requests reject stale deadlines, unavailable scope, and fence mismatches", () => {
  const request = { binding, deadlineAt: new Date(Date.now() + 10_000).toISOString(), maxOutputBytes: 8192, operation: "gui-ready" };
  assert.equal(validateHelperRequest(request, binding).operation, "gui-ready");
  assert.throws(() => validateHelperRequest({ ...request, binding: { ...binding, fencingToken: "old" } }, binding), errorCode("IDENTITY_MISMATCH"));
  assert.throws(() => validateHelperRequest({ ...request, operation: "shell" }, binding), errorCode("OPERATION_DENIED"));
});

test("device auth proves one automation identity without developer session reuse", () => {
  const state = { accounts: [{ automation: true, subject: "automation@example.invalid" }], binding, developerSessionImported: false, modelBacked: true, sessionId: "session-run-1" };
  assert.equal(verifyDeviceAuthIsolation(state, binding), state);
  assert.throws(() => verifyDeviceAuthIsolation({ ...state, developerSessionImported: true }, binding), errorCode("AUTH_ISOLATION_FAILED"));
  assert.throws(() => verifyDeviceAuthIsolation({ ...state, accounts: [...state.accounts, state.accounts[0]] }, binding), errorCode("AUTH_ISOLATION_FAILED"));
});

test("checkpoint accepts fresh task only when native, MCP, and visible Desktop agree", () => {
  const expected = { taskId: "task-fresh-1", title: "Production Desktop validation" };
  const surfaces = Object.fromEntries(["native", "mcp", "desktop"].map((name) => [name, { lifecycle: "active", ...expected }]));
  assert.equal(compareTaskSurfaces(expected, surfaces), true);
  assert.throws(() => compareTaskSurfaces(expected, { ...surfaces, desktop: { ...surfaces.desktop, title: "stale" } }), errorCode("TASK_SURFACE_MISMATCH"));
});

test("protected capture geometry and sanitized diagnostic schema fail closed", () => {
  const screen = { height: 1080, width: 1920 };
  const protectedRegions = [{ height: 40, name: "system-bar", width: 1920, x: 0, y: 0 }];
  assert.equal(admitCapture({ protectedRegions, requested: { height: 800, width: 1200, x: 200, y: 100 }, screen }), true);
  assert.throws(() => admitCapture({ protectedRegions, requested: { height: 100, width: 100, x: 0, y: 0 }, screen }), errorCode("UNSAFE_CAPTURE"));
  const diagnostics = { binding, capturedAt: new Date().toISOString(), checks: { accessibilityBus: "ready", authIsolated: "ready", desktopSession: "ready", guestHelper: "ready" }, schemaVersion: 1 };
  assert.equal(validateSanitizedDiagnostics(diagnostics, binding), diagnostics);
  assert.throws(() => validateSanitizedDiagnostics({ ...diagnostics, secret: "forbidden" }, binding), errorCode("INVALID_CONTRACT"));
});

test("checkpoint screenshots and diagnostics must be collected before destroy", () => {
  assert.equal(assertPreDestroyCollection(["checkpoint-screenshot", "diagnostics", "inventory-draft", "destroy", "post-destroy-attestation"]), true);
  assert.throws(() => assertPreDestroyCollection(["destroy", "checkpoint-screenshot", "diagnostics", "inventory-draft"]), errorCode("CLEANUP_ORDER_VIOLATION"));
});

test("independent post-destroy attestation rejects altered inventory and unreferenced bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-evidence-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const fixtures = [
    ["checkpoint.png", "real png bytes", "checkpoint-screenshot"],
    ["diagnostics.json", "{\"ready\":true}\n", "diagnostics"],
    ["archive.html", "<html>real report</html>\n", "archive-visual-report"],
  ];
  for (const [name, bytes] of fixtures) await writeFile(join(root, name), bytes);
  const evidenceStat = await lstat(join(root, fixtures[0][0]));
  const files = await Promise.all(fixtures.map(async ([path, , role]) => {
    const bytes = await readFile(join(root, path));
    return { length: bytes.length, path, role, sha256: sha256(bytes) };
  }));
  const inventory = { binding, files, manifestReferences: files.map(({ path }) => path), packetDigest: packet().digest, schemaVersion: 1 };
  assert.equal((await attestEvidenceInventory(root, inventory, { expectedGid: evidenceStat.gid, expectedPacketDigest: inventory.packetDigest, expectedUid: evidenceStat.uid })).files, 3);
  const altered = structuredClone(inventory);
  altered.files[0].length += 1;
  await assert.rejects(() => attestEvidenceInventory(root, altered, { expectedPacketDigest: inventory.packetDigest }), errorCode("EVIDENCE_HASH_MISMATCH"));
  await writeFile(join(root, "unreferenced.txt"), "no");
  await assert.rejects(() => attestEvidenceInventory(root, inventory, { expectedPacketDigest: inventory.packetDigest }), errorCode("EVIDENCE_UNREFERENCED_FILE"));
});

test("versioned graphical recipe and bounded helpers remain installable and explicit", async () => {
  const recipe = resolve("validation/proxmox/desktop/recipe-v1/install-guest.sh");
  const unit = await readFile(resolve("validation/proxmox/desktop/recipe-v1/nelos-desktop-session.service"), "utf8");
  const installer = await readFile(recipe, "utf8");
  const guest = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-desktop-atspi.mjs"), "utf8");
  const host = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-proxmox-host-helper.mjs"), "utf8");
  const auth = await readFile(resolve("validation/proxmox/desktop/helpers/device-auth.sh"), "utf8");
  const atspiControl = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-atspi-control"), "utf8");
  const archiveControl = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-archive-control"), "utf8");
  const appService = await readFile(resolve("validation/proxmox/desktop/recipe-v1/nelos-codex-desktop.service"), "utf8");
  for (const required of ["NELOS_CODEX_DESKTOP_SHA256", "sha256sum --check --strict", "ubuntu.sources", "gdm3", "at-spi2-core", "dbus-x11", "scrot", "xdotool", "AutomaticLogin=nelosauto", "WaylandEnable=false", "/usr/libexec/nelos-device-auth", "/usr/libexec/nelos-desktop-atspi", "/usr/libexec/nelos-desktop-archive"]) assert.match(installer, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(unit, /TimeoutStartSec=120/u);
  assert.match(unit, /nelos-check-gui-readiness/u);
  assert.match(auth, /automation CODEX_HOME must not pre-exist/u);
  assert.match(auth, /CODEX_HOME="\$\{automation_home\}\/\.codex" codex login --device-auth/u);
  assert.match(atspiControl, /activate_expected_task/u);
  assert.match(archiveControl, /runuser/u);
  assert.match(appService, /ExecStart=\/usr\/bin\/chatgpt/u);
  assert.match(appService, /WantedBy=default\.target/u);
  assert.match(guest, /child\.kill\("SIGKILL"\)/u);
  assert.match(guest, /IDENTITY_MISMATCH/u);
  assert.match(host, /tasks\/UPID/u);
  assert.match(host, /sourceTemplateVmId/u);
  assert.match(host, /maxBuffer: envelope\.maxOutputBytes/u);
  assert.match(host, /promisify\(execFile\)/u);
  assert.doesNotMatch(host, /shell:\s*true|\/bin\/sh|bash/u);
});

test("systemd readiness command executes under bash -u without expanding awk fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-readiness-")); const bin = join(root, "bin");
  await mkdir(bin, { recursive: true }); await mkdir(join(root, "etc/nelos-desktop"), { recursive: true }); await mkdir(join(root, "run/user/2401"), { recursive: true });
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), '{"runId":"run-readiness"}\n');
  await writeFile(join(root, "run/user/2401/nelos-accessibility-ready"), "");
  const socketPath = join(root, "run/user/2401/bus"); const server = createServer(); await new Promise((resolvePromise) => server.listen(socketPath, resolvePromise));
  const scripts = {
    id: '#!/bin/sh\nprintf "2401\\n"\n',
    loginctl: '#!/bin/sh\nif [ "$1" = list-sessions ]; then printf "7 2401 nelosauto seat0\\n"; elif printf "%s" "$*" | grep -q "Type"; then printf "x11\\n"; else printf "active\\n"; fi\n',
    jq: '#!/bin/sh\nif [ "$1" = -r ]; then printf "run-readiness\\n"; else printf "{\\"ready\\":true,\\"accessibilityBus\\":true,\\"captureReady\\":true,\\"sessionUser\\":\\"nelosauto\\",\\"runId\\":\\"run-readiness\\"}\\n"; fi\n',
    systemctl: '#!/bin/sh\nexit 0\n', scrot: '#!/bin/sh\nexit 0\n', convert: '#!/bin/sh\nexit 0\n',
  };
  for (const [name, body] of Object.entries(scripts)) { await writeFile(join(bin, name), body); await chmod(join(bin, name), 0o755); }
  const script = resolve("validation/proxmox/desktop/recipe-v1/check-gui-readiness.sh");
  const status = await new Promise((resolvePromise) => { const child = spawn("/bin/bash", ["-u", script], { env: { PATH: `${bin}:/usr/bin:/bin`, NELOS_READINESS_ROOT: root, NELOS_READINESS_ATTEMPTS: "1" }, stdio: "ignore" }); child.once("close", resolvePromise); });
  server.close();
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, "var/lib/nelos-desktop/gui-ready.json"), "utf8")), { ready: true, accessibilityBus: true, captureReady: true, sessionUser: "nelosauto", runId: "run-readiness" });
});
