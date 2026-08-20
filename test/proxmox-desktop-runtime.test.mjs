import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  validateNetworkPolicyObservationV1,
  validateRunPacket,
  validateSanitizedDiagnostics,
  validateSealedRoots,
  verifyDeviceAuthIsolation,
} from "../src/proxmox-desktop-runtime.mjs";
import { createLeaseAuthorityIssueFixtureV1, installFakeProxmoxLeaseAuthority } from "./support/fake-proxmox-lease-authority.mjs";

const networkPolicyRulesetDigest = `sha256:${"9".repeat(64)}`;
const networkPolicyAddressDigest = `sha256:${"7".repeat(64)}`;
const networkPolicyDigest = sha256({
  approvedAddressInventoryDigest: networkPolicyAddressDigest,
  kind: "nelos.proxmox-desktop.gateway-policy-identity.v1",
  networkId: "nelosbld",
  rulesetDigest: networkPolicyRulesetDigest,
  schemaVersion: 1,
});
const binding = Object.freeze({
  fencingToken: "fence-9",
  gatewayId: "9023",
  hostId: "prox2",
  leaseId: "lease-7",
  macAddress: "02:4E:45:4C:03:19",
  networkId: "nelosbld",
  networkPolicyDigest,
  providerId: "proxmox-lab",
  runId: "run-1",
  vmid: 319,
});

function errorCode(code) {
  return (error) => error instanceof ProxmoxDesktopError && error.code === code;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function networkPolicyObservation(now = Date.parse("2026-08-20T12:00:00.000Z")) {
  const expiresAt = new Date(now + 3_600_000).toISOString();
  const measurementUnsigned = {
    approvedAddressCount: 2,
    approvedAddressInventoryDigest: networkPolicyAddressDigest,
    complete: true,
    expiresAt,
    forwardPolicy: "drop",
    helper: { digest: `sha256:${"8".repeat(64)}`, path: "/usr/libexec/nelos-network-policy-observer" },
    kind: "nelos.proxmox-desktop.gateway-policy-measurement.v1",
    networkId: binding.networkId,
    observedAt: new Date(now - 1_500).toISOString(),
    policyDigest: binding.networkPolicyDigest,
    rulesetBytes: 4096,
    rulesetDigest: networkPolicyRulesetDigest,
    schemaVersion: 1,
    unexpectedForwardAccepts: 0,
  };
  const measurement = { ...measurementUnsigned, measurementDigest: sha256(measurementUnsigned) };
  const unsigned = {
    complete: true,
    expiresAt,
    gateway: { configDigest: `sha256:${"6".repeat(64)}`, hostId: binding.hostId, providerId: binding.providerId, vmId: binding.gatewayId },
    installed: true,
    kind: "nelos.proxmox-desktop.network-policy-observation.v1",
    measurement,
    networkId: binding.networkId,
    networkPolicyDigest: binding.networkPolicyDigest,
    observedAt: new Date(now - 1_000).toISOString(),
    schemaVersion: 1,
  };
  return { ...unsigned, observationDigest: sha256(unsigned) };
}

test("network policy attestation binds the exact gateway, VNet, digest, freshness, and cleanup margin", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const valid = networkPolicyObservation(now);
  assert.deepEqual(validateNetworkPolicyObservationV1(valid, { binding, now }), valid);

  for (const [mutate, code] of [
    [(value) => { value.gateway.vmId = "9024"; }, "NETWORK_POLICY_IDENTITY_MISMATCH"],
    [(value) => { value.networkId = "wrong-vnet"; }, "NETWORK_POLICY_IDENTITY_MISMATCH"],
    [(value) => { value.networkPolicyDigest = `sha256:${"8".repeat(64)}`; }, "NETWORK_POLICY_IDENTITY_MISMATCH"],
    [(value) => { value.observedAt = new Date(now - 30_001).toISOString(); }, "NETWORK_POLICY_OBSERVATION_STALE"],
    [(value) => { value.expiresAt = new Date(now + 120_000).toISOString(); value.measurement.expiresAt = value.expiresAt; const { measurementDigest: ignored, ...unsignedMeasurement } = value.measurement; value.measurement.measurementDigest = sha256(unsignedMeasurement); }, "NETWORK_POLICY_OBSERVATION_STALE"],
  ]) {
    const altered = structuredClone(valid);
    mutate(altered);
    const { observationDigest: ignored, ...unsigned } = altered;
    altered.observationDigest = sha256(unsigned);
    assert.throws(() => validateNetworkPolicyObservationV1(altered, { binding, now }), errorCode(code));
  }

  const unknown = { ...valid, callerSelectedPolicy: true };
  assert.throws(() => validateNetworkPolicyObservationV1(unknown, { binding, now }), errorCode("INVALID_CONTRACT"));
  const alteredDigest = { ...valid, observationDigest: `sha256:${"0".repeat(64)}` };
  assert.throws(() => validateNetworkPolicyObservationV1(alteredDigest, { binding, now }), errorCode("NETWORK_POLICY_DIGEST_MISMATCH"));
});

function runProgram(command, args, { input = "", env = {} } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(input);
  });
}

function packet(now = Date.now()) {
  const observedAt = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 60_000).toISOString();
  const authority = createLeaseAuthorityIssueFixtureV1({
    observedAt,
    run: {
      runId: binding.runId,
      provider: { hostId: binding.hostId, providerId: binding.providerId, vmId: String(binding.vmid) },
      lease: { expiresAt, fencingToken: binding.fencingToken, holderId: "nelos-validator", leaseId: binding.leaseId },
    },
  });
  const packetValue = {
    authorization: { gateId: "gate-1", runId: binding.runId, used: false },
    binding,
    budgets: { captureCount: 4, runDeadlineAt: new Date(now + 120_000).toISOString(), stepDeadlineMs: 20_000 },
    capture: { height: 1080, protectedRegions: [{ height: 40, name: "system-bar", width: 1920, x: 0, y: 0 }], width: 1920 },
    expectedTask: {
      intentDigest: `sha256:${"a".repeat(64)}`,
      intentPath: `/sealed/packet/production-task-intent-${"a".repeat(64)}.json`,
      taskSlotId: `task-slot-${"b".repeat(64)}`,
      title: "Production Desktop validation",
    },
    goldenImageReceipt: {
      attestationDigest: `sha256:${"b".repeat(64)}`,
      path: `/sealed/packet/golden-image-${"b".repeat(64)}.json`,
    },
    lease: { active: true, binding, expiresAt, observedAt },
    leaseAuthority: authority.authorityBinding,
    roots: {
      evidence: { gid: process.getgid(), mode: "0700", path: "/sealed/evidence", sealed: true, uid: process.getuid() },
      packet: { gid: process.getgid(), mode: "0700", path: "/sealed/packet", sealed: true, uid: process.getuid() },
      recovery: { gid: process.getgid(), mode: "0700", path: "/sealed/recovery", sealed: true, uid: process.getuid() },
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

test("an internally consistent alternate prox2 gateway fails before a provider mutation", async () => {
  let touched = false;
  const alternate = { ...binding, gatewayId: "9024" };
  await assert.rejects(
    mutateProxmoxVm({
      mutateVm: async () => { touched = true; return { taskId: "UPID:prox2:alternate" }; },
      readTask: async () => { touched = true; return { exitStatus: "OK", state: "stopped" }; },
    }, "start", alternate),
    errorCode("IDENTITY_MISMATCH"),
  );
  assert.equal(touched, false);
});

test("an internally consistent alternate prox2 VNet fails before a provider mutation", async () => {
  let touched = false;
  const alternate = { ...binding, networkId: "caller-selected" };
  await assert.rejects(
    mutateProxmoxVm({
      mutateVm: async () => { touched = true; return { taskId: "UPID:prox2:alternate-network" }; },
      readTask: async () => { touched = true; return { exitStatus: "OK", state: "stopped" }; },
    }, "start", alternate),
    (error) => error?.code === "IDENTITY_MISMATCH" && error?.path === "/binding/networkId",
  );
  assert.equal(touched, false);
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
  const root = await realpath(await mkdtemp(join(tmpdir(), "nelos-roots-")));
  t.after(() => rm(root, { force: true, recursive: true }));
  const roots = {};
  for (const name of ["evidence", "packet", "recovery", "staging"]) {
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

test("device auth proves only an isolated ChatGPT file-store login", () => {
  const state = { accountBindingDigest: `sha256:${"c".repeat(64)}`, accountType: "chatgpt", authenticated: true, authMethod: "chatgptDeviceCode", binding, credentialStore: "file", developerSessionImported: false, schemaVersion: 1 };
  assert.equal(verifyDeviceAuthIsolation(state, binding), state);
  assert.throws(() => verifyDeviceAuthIsolation({ ...state, developerSessionImported: true }, binding), errorCode("AUTH_ISOLATION_FAILED"));
  assert.throws(() => verifyDeviceAuthIsolation({ ...state, modelBacked: true }, binding), errorCode("INVALID_CONTRACT"));
});

test("checkpoint accepts a task only when native, MCP, and visible Desktop agree on identity and lifecycle", () => {
  const expected = { lifecycle: "completed", taskId: "task-fresh-1", title: "Production Desktop validation" };
  const surfaces = Object.fromEntries(["native", "mcp", "desktop"].map((name) => [name, { ...expected }]));
  assert.equal(compareTaskSurfaces(expected, surfaces), true);
  assert.throws(() => compareTaskSurfaces(expected, { ...surfaces, desktop: { ...surfaces.desktop, title: "stale" } }), errorCode("TASK_SURFACE_MISMATCH"));
  assert.throws(() => compareTaskSurfaces(expected, { ...surfaces, desktop: { ...surfaces.desktop, lifecycle: "active" } }), errorCode("TASK_SURFACE_MISMATCH"));
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
  const goldenInstaller = await readFile(resolve("validation/proxmox-desktop/v1/provision-golden-image.sh"), "utf8");
  const readiness = await readFile(resolve("validation/proxmox/desktop/recipe-v1/check-gui-readiness.sh"), "utf8");
  const guest = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-desktop-atspi.mjs"), "utf8");
  const host = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-proxmox-host-helper.py"), "utf8");
  const attest = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-proxmox-attest.py"), "utf8");
  const hostInstaller = await readFile(resolve("validation/proxmox/desktop/helpers/install-host-helper.sh"), "utf8");
  const policyObserver = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-network-policy-observer.py"), "utf8");
  const policyObserverInstaller = await readFile(resolve("validation/proxmox/desktop/helpers/install-network-policy-observer.sh"), "utf8");
  const auth = await readFile(resolve("validation/proxmox/desktop/helpers/device-auth.sh"), "utf8");
  const credentialBoundary = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-credential-boundary"), "utf8");
  const atspiControl = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-atspi-control"), "utf8");
  const archiveControl = await readFile(resolve("validation/proxmox/desktop/helpers/nelos-archive-control"), "utf8");
  const appService = await readFile(resolve("validation/proxmox/desktop/recipe-v1/nelos-codex-desktop.service"), "utf8");
  for (const required of ["NELOS_CODEX_DESKTOP_SHA256", "sha256sum --check --strict", "ubuntu.sources", "gdm3", "at-spi2-core", "dbus-x11", "scrot", "xdotool", "AutomaticLogin=nelosauto", "WaylandEnable=false", "/usr/libexec/nelos-device-auth", "/usr/libexec/nelos-desktop-atspi", "/usr/libexec/nelos-desktop-archive"]) assert.match(installer, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(unit, /TimeoutStartSec=120/u);
  assert.match(unit, /nelos-check-gui-readiness/u);
  assert.match(auth, /prepare_volatile_credential_boundary/u);
  assert.match(auth, /ulimit -c 0/u);
  assert.match(auth, /assert_no_core_policy/u);
  assert.match(auth, /credential boundary helper is unavailable/u);
  assert.match(auth, /nelos-device-auth-controller/u);
  assert.match(auth, /if stat -c '[^']+' "\$1" >\/dev\/null 2>&1; then[\s\S]+else[\s\S]+stat -f/u);
  assert.match(auth, /env -i/u);
  assert.match(auth, /trusted_credential_file/u);
  assert.match(auth, /run binding metadata is unsafe/u);
  assert.match(auth, /if trusted_auth_receipt; then\s+start_desktop_after_auth/gu);
  assert.match(credentialBoundary, /active swap would persist credential pages/u);
  assert.match(credentialBoundary, /filesystemType:"tmpfs"/u);
  assert.match(credentialBoundary, /reusableCredentialsAbsent:true/u);
  assert.doesNotMatch(auth, /login status --json/u);
  const authService = await readFile(resolve("validation/proxmox/desktop/recipe-v1/nelos-device-auth.service"), "utf8");
  assert.match(authService, /ExecStart=\/usr\/bin\/env -i HOME=\/home\/nelosauto CODEX_HOME=\/home\/nelosauto\/\.codex/u);
  assert.match(readiness, /NELOS_READINESS_NO_CORE_ONLY/u);
  assert.match(readiness, /kernel\/core_pattern/u);
  for (const bake of [installer, goldenInstaller]) {
    for (const required of ["DefaultLimitCORE=0", "kernel.core_pattern = /dev/null", "fs.suid_dumpable = 0", "Storage=none", "ProcessSizeMax=0", "enabled=0", "systemd-coredump.socket", "apport.service", "systemctl daemon-reexec"]) assert.match(bake, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(bake, /install_and_attest_no_core_policy/u);
  }
  assert.match(atspiControl, /activate_expected_task/u);
  assert.match(archiveControl, /runuser/u);
  assert.match(appService, /ExecStart=\/usr\/bin\/chatgpt/u);
  assert.match(appService, /WantedBy=default\.target/u);
  assert.match(guest, /child\.kill\("SIGKILL"\)/u);
  assert.match(guest, /IDENTITY_MISMATCH/u);
  assert.match(host, /tasks\/UPID/u);
  assert.match(host, /sourceTemplateVmId/u);
  assert.match(host, /subprocess\.run/u);
  assert.match(host, /capture-output/u);
  assert.match(host, /nelos-device-auth/u);
  assert.match(host, /observe_task_surface/u);
  assert.doesNotMatch(host, /shell\s*=\s*True|\/bin\/sh|bash/u);
  assert.match(attest, /attestation accepts only bodyless GET/u);
  assert.match(attest, /\/nodes\/\{node\}\/qemu\/\{gateway\}\/agent\/exec/u);
  assert.match(policyObserver, /--stateless/u);
  assert.match(policyObserver, /approvedAddressInventoryDigest/u);
  assert.match(hostInstaller, /\/usr\/bin\/python3/u);
  assert.match(hostInstaller, /\/usr\/libexec\/nelos-proxmox-attest/u);
  assert.match(policyObserverInstaller, /\/usr\/libexec\/nelos-network-policy-observer/u);
});

test("systemd readiness command executes under bash -u without expanding awk fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-readiness-")); const bin = join(root, "bin");
  await mkdir(bin, { recursive: true }); await mkdir(join(root, "etc/nelos-desktop"), { recursive: true }); await mkdir(join(root, "run/user/2401"), { recursive: true }); await mkdir(join(root, "var/lib/nelos-desktop"), { recursive: true });
  const noCoreFiles = {
    "etc/security/limits.d/99-nelos-no-core.conf": "* soft core 0\n* hard core 0\nroot soft core 0\nroot hard core 0\n",
    "etc/systemd/system.conf.d/99-nelos-no-core.conf": "[Manager]\nDefaultLimitCORE=0\n",
    "etc/systemd/user.conf.d/99-nelos-no-core.conf": "[Manager]\nDefaultLimitCORE=0\n",
    "etc/systemd/coredump.conf.d/99-nelos-no-core.conf": "[Coredump]\nStorage=none\nProcessSizeMax=0\nExternalSizeMax=0\n",
    "etc/sysctl.d/99-nelos-no-core.conf": "fs.suid_dumpable = 0\nkernel.core_pattern = /dev/null\n",
    "etc/default/apport": "enabled=0\n",
    "proc/sys/fs/suid_dumpable": "0\n",
    "proc/sys/kernel/core_pattern": "/dev/null\n",
  };
  for (const [path, bytes] of Object.entries(noCoreFiles)) { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { mode: 0o644 }); await chmod(target, 0o644); }
  await mkdir(join(root, "etc/systemd/system"), { recursive: true });
  for (const unitName of ["apport.service", "apport-autoreport.path", "apport-autoreport.service", "systemd-coredump.socket", "systemd-coredump@.service"]) await symlink("/dev/null", join(root, "etc/systemd/system", unitName));
  const readinessBinding = { automationUser: "nelosauto", fencingToken: "fence-ready", hostId: "prox2", imageId: "image-ready", leaseId: "lease-ready", providerId: "proxmox-lab", runId: "run-readiness", stateRoot: "/var/lib/nelos-desktop/runs/run-readiness", vmId: "9051" };
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), `${JSON.stringify(readinessBinding)}\n`);
  await writeFile(join(root, "var/lib/nelos-desktop/device-auth.json"), `${JSON.stringify({ schemaVersion: 1, binding: readinessBinding, authenticated: true, accountType: "chatgpt", accountBindingDigest: `sha256:${"d".repeat(64)}`, authMethod: "chatgptDeviceCode", credentialStore: "file", developerSessionImported: false })}\n`);
  await writeFile(join(root, "var/lib/nelos-desktop/credential-boundary.json"), `${JSON.stringify({ schemaVersion: 1, type: "nelos.credential-volatility.v1", runId: readinessBinding.runId, fencingToken: readinessBinding.fencingToken, vmId: readinessBinding.vmId, imageId: readinessBinding.imageId, codexHome: "/home/nelosauto/.codex", filesystemType: "tmpfs", mountOptions: ["nodev", "noexec", "nosuid", "rw"], swapActive: false, volatile: true, bootIdDigest: `sha256:${"6".repeat(64)}`, secretBytesIncluded: false, attestationDigest: `sha256:${"7".repeat(64)}` })}\n`);
  await writeFile(join(root, "run/user/2401/nelos-accessibility-ready"), "");
  const socketPath = join(root, "run/user/2401/bus"); const server = createServer(); await new Promise((resolvePromise) => server.listen(socketPath, resolvePromise));
  const scripts = {
    id: '#!/bin/sh\nprintf "2401\\n"\n',
    loginctl: '#!/bin/sh\nif [ "$1" = list-sessions ]; then printf "7 2401 nelosauto seat0\\n"; elif printf "%s" "$*" | grep -q "Type"; then printf "x11\\n"; else printf "active\\n"; fi\n',
    systemctl: '#!/bin/sh\nif [ "$1" = show ]; then printf "0\\n"; fi\nexit 0\n', scrot: '#!/bin/sh\nexit 0\n', convert: '#!/bin/sh\nexit 0\n', identify: '#!/bin/sh\nexit 0\n', import: '#!/bin/sh\nexit 0\n',
    runuser: '#!/bin/sh\n[ "$1" = -u ] || exit 1\nshift 2\n[ "$1" = -- ] || exit 1\nshift\nexec "$@"\n',
    findmnt: '#!/bin/sh\nprintf "tmpfs\\n"\n', swapon: '#!/bin/sh\nexit 0\n',
  };
  for (const [name, body] of Object.entries(scripts)) { await writeFile(join(bin, name), body); await chmod(join(bin, name), 0o755); }
  const script = resolve("validation/proxmox/desktop/recipe-v1/check-gui-readiness.sh");
  const status = await new Promise((resolvePromise) => {
    const child = spawn("/bin/bash", ["-u", script], { env: { PATH: `${bin}:/usr/bin:/bin`, NELOS_READINESS_ROOT: root, NELOS_READINESS_TEST_MODE: "1", NELOS_READINESS_ATTEMPTS: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    const stderr = []; child.stderr.on("data", (chunk) => stderr.push(chunk)); child.once("close", (code) => resolvePromise({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  server.close();
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(root, "var/lib/nelos-desktop/gui-ready.json"), "utf8")), { schemaVersion: 1, binding: readinessBinding, ready: true, accessibilityBus: true, captureReady: true, sessionUser: "nelosauto" });
});


test("pinned app-server device auth emits only an ephemeral challenge and metadata status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-device-auth-controller-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const codexHome = join(root, ".codex"); const state = join(root, "state");
  await mkdir(codexHome, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const fake = join(root, "fake-codex.mjs");
  await writeFile(fake, `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const marker = process.env.CODEX_HOME + "/fake-authenticated";
const apiKey = process.env.CODEX_HOME + "/fake-api-key";
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.method === "initialize") {
    if (process.env.OPENAI_API_KEY) process.exit(91);
    reply(value.id, { codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux", userAgent: "Codex Desktop/0.148.0-alpha.15" });
  } else if (value.method === "account/read") {
    reply(value.id, { account: existsSync(apiKey) ? { type: "apiKey" } : existsSync(marker) ? { type: "chatgpt", email: "must-not-escape@example.invalid", planType: "pro" } : null, requiresOpenaiAuth: true });
  } else if (value.method === "account/login/start") {
    writeFileSync(marker, "ok"); reply(value.id, { type: "chatgptDeviceCode", loginId: "login-secret", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/device" });
  } else if (value.method === "account/login/cancel") reply(value.id, { status: "canceled" });
});
`);
  await chmod(fake, 0o700);
  const controller = resolve("validation/proxmox/desktop/helpers/nelos-device-auth-controller.mjs");
  const controllerEnv = { HOME: root, CODEX_HOME: codexHome, NELOS_RUN_ID: "device-auth-controller-test", NELOS_DEVICE_AUTH_CODEX: fake, NELOS_DEVICE_AUTH_STATE_DIR: state, NELOS_DEVICE_AUTH_DEADLINE_MS: "2000", NELOS_DEVICE_AUTH_POLL_MS: "1", OPENAI_API_KEY: "must-not-reach-app-server" };
  const login = await runProgram(process.execPath, [controller, "login"], { env: controllerEnv });
  assert.equal(login.code, 0, login.stderr); assert.equal(login.stdout, ""); assert.equal(login.stderr, "");
  assert.deepEqual(JSON.parse(await readFile(join(state, "challenge.json"), "utf8")), { type: "chatgptDeviceCode", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/device" });
  const accountBindingDigest = `sha256:${createHash("sha256").update(controllerEnv.NELOS_RUN_ID).update("\0").update("must-not-escape@example.invalid").digest("hex")}`;
  assert.deepEqual(JSON.parse(await readFile(join(state, "complete.json"), "utf8")), { authenticated: true, accountType: "chatgpt", accountBindingDigest, credentialStore: "file" });
  const status = await runProgram(process.execPath, [controller, "status"], { env: controllerEnv });
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { authenticated: true, accountType: "chatgpt", accountBindingDigest, credentialStore: "file" });
  assert.doesNotMatch(status.stdout, /email|login-secret|ABCD-EFGH/u);
  await writeFile(join(codexHome, "fake-api-key"), "no");
  const rejected = await runProgram(process.execPath, [controller, "status"], { env: controllerEnv });
  assert.equal(rejected.code, 70); assert.match(rejected.stderr, /only isolated ChatGPT/u);
});

test("PVE-native host helpers strictly bind QGA capture and independent absence reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-python-pve-helper-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "etc/nelos-desktop"), { recursive: true });
  const runtimeBinding = { automationUser: "nelosauto", fencingToken: "fence-0007", gatewayId: "9023", hostId: "prox2", imageId: "desktop-image-v1", leaseId: "lease-001", macAddress: "02:4E:45:4C:90:51", networkId: "nelosbld", networkPolicyDigest, providerId: "proxmox-lab", runId: "desktop-run-001", stateRoot: "/var/lib/nelos-desktop/runs/desktop-run-001", vmId: "9051" };
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(runtimeBinding));
  const networkPolicyObserverDigest = `sha256:${"8".repeat(64)}`;
  await writeFile(join(root, "etc/nelos-desktop/provider.json"), JSON.stringify({ gatewayId: "9023", hostId: "prox2", networkId: "nelosbld", networkPolicyDigest, networkPolicyObserverDigest, providerId: "proxmox-lab", sourceTemplateVmId: "9025" }));
  const gatewayMeasurementUnsigned = {
    approvedAddressCount: 2, approvedAddressInventoryDigest: networkPolicyAddressDigest, complete: true,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), forwardPolicy: "drop",
    helper: { digest: networkPolicyObserverDigest, path: "/usr/libexec/nelos-network-policy-observer" },
    kind: "nelos.proxmox-desktop.gateway-policy-measurement.v1", networkId: "nelosbld",
    observedAt: new Date().toISOString(), policyDigest: networkPolicyDigest, rulesetBytes: 4096, rulesetDigest: networkPolicyRulesetDigest,
    schemaVersion: 1, unexpectedForwardAccepts: 0,
  };
  const gatewayMeasurement = { ...gatewayMeasurementUnsigned, measurementDigest: sha256(gatewayMeasurementUnsigned) };
  const gatewayMeasurementBase64 = Buffer.from(`${canonicalJson(gatewayMeasurement)}\n`).toString("base64");
  const log = join(root, "pvesh.log"); const fakePvesh = join(root, "pvesh.mjs");
  await writeFile(fakePvesh, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const path = args[1]; const pid = args[args.indexOf("--pid") + 1];
if (path === "/nodes/prox2/qemu/9023/config") process.stdout.write(JSON.stringify({agent:"enabled=1",name:"nelosbld-gateway"}));
else if (path === "/nodes/prox2/qemu/9023/status/current") process.stdout.write(JSON.stringify({status:"running"}));
else if (path === "/nodes/prox2/qemu/9023/agent/exec-status") process.stdout.write(JSON.stringify({ exited: true, exitcode: 0, "out-data": ${JSON.stringify(gatewayMeasurementBase64)} }));
else if (path === "/nodes/prox2/qemu/9023/agent/exec") process.stdout.write('{"pid":88}');
else if (path.endsWith("/agent/exec-status")) process.stdout.write(JSON.stringify(pid === "99" ? { exited: true, exitcode: 0, "out-data": "e30K", "out-truncated": true } : pid === "98" ? { exited: true, exitcode: 0, "out-data": "e30K", "out-truncated": "false" } : { exited: true, exitcode: 0, "out-data": "e30K" }));
else if (path.endsWith("/agent/exec")) process.stdout.write('{"pid":7}');
else if (path === "/cluster/resources") process.stdout.write("[]");
else process.stdout.write('{"description":"owned"}');
`);
  await chmod(fakePvesh, 0o700);
  const leaseAuthority = await installFakeProxmoxLeaseAuthority({ root, binding: runtimeBinding });
  const transport = resolve("validation/proxmox/desktop/helpers/nelos-proxmox-host-helper.py");
  const attest = resolve("validation/proxmox/desktop/helpers/nelos-proxmox-attest.py");
  const base = { schemaVersion: 1, binding: runtimeBinding, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 65_536 };
  const helperHeader = { schemaVersion: 1, binding: runtimeBinding, operation: "health", payload: {}, byteLength: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 8192 };
  const inputData = Buffer.from(`${JSON.stringify(helperHeader)}\n`).toString("base64");
  const valid = { ...base, request: { method: "POST", path: "/nodes/prox2/qemu/9051/agent/exec", body: { command: "/usr/libexec/nelos-desktop-atspi", "extra-args": ["health"], "input-data": inputData, "capture-output": 1 } } };
  const env = { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_PVESH: fakePvesh, ...leaseAuthority.env };
  const alternateBinding = { ...runtimeBinding, gatewayId: "9024" };
  await chmod(join(root, "etc/nelos-desktop/run-binding.json"), 0o600);
  await chmod(join(root, "etc/nelos-desktop/provider.json"), 0o600);
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(alternateBinding));
  await writeFile(join(root, "etc/nelos-desktop/provider.json"), JSON.stringify({ gatewayId: "9024", hostId: "prox2", networkId: "nelosbld", networkPolicyDigest, networkPolicyObserverDigest, providerId: "proxmox-lab", sourceTemplateVmId: "9025" }));
  const alternate = { ...base, binding: alternateBinding, request: { method: "GET", path: "/cluster/resources?type=vm" } };
  for (const executable of [transport, attest]) {
    const rejectedGateway = await runProgram("/usr/bin/python3", [executable, "request"], { input: JSON.stringify(alternate), env });
    assert.equal(rejectedGateway.code, 77);
    assert.match(rejectedGateway.stderr, /IDENTITY_MISMATCH/u);
  }
  await assert.rejects(readFile(log), /ENOENT/u);
  const alternateNetworkBinding = { ...runtimeBinding, networkId: "caller-selected" };
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(alternateNetworkBinding));
  await writeFile(join(root, "etc/nelos-desktop/provider.json"), JSON.stringify({ gatewayId: "9023", hostId: "prox2", networkId: "caller-selected", networkPolicyDigest, networkPolicyObserverDigest, providerId: "proxmox-lab", sourceTemplateVmId: "9025" }));
  const alternateNetwork = { ...base, binding: alternateNetworkBinding, request: { method: "GET", path: "/cluster/resources?type=vm" } };
  for (const executable of [transport, attest]) {
    const rejectedNetwork = await runProgram("/usr/bin/python3", [executable, "request"], { input: JSON.stringify(alternateNetwork), env });
    assert.equal(rejectedNetwork.code, 77);
    assert.match(rejectedNetwork.stderr, /IDENTITY_MISMATCH/u);
  }
  await assert.rejects(readFile(log), /ENOENT/u);
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), `${canonicalJson(runtimeBinding)}\n`);
  await writeFile(join(root, "etc/nelos-desktop/provider.json"), `${canonicalJson({ gatewayId: "9023", hostId: "prox2", networkId: "nelosbld", networkPolicyDigest, networkPolicyObserverDigest, providerId: "proxmox-lab", sourceTemplateVmId: "9025" })}\n`);
  await chmod(join(root, "etc/nelos-desktop/run-binding.json"), 0o400);
  await chmod(join(root, "etc/nelos-desktop/provider.json"), 0o400);
  const started = await runProgram("/usr/bin/python3", [transport, "request"], { input: JSON.stringify(valid), env });
  assert.equal(started.code, 0, started.stderr); assert.deepEqual(JSON.parse(started.stdout), { data: { pid: 7 } });
  assert.match(await readFile(log, "utf8"), /--capture-output/u);
  const arbitrary = structuredClone(valid); arbitrary.request.body.command = "/bin/sh";
  const denied = await runProgram("/usr/bin/python3", [transport, "request"], { input: JSON.stringify(arbitrary), env });
  assert.equal(denied.code, 77); assert.match(denied.stderr, /guest command or operation is not allowlisted/u);
  const truncated = { ...base, request: { method: "GET", path: "/nodes/prox2/qemu/9051/agent/exec-status?pid=99" } };
  const bounded = await runProgram("/usr/bin/python3", [transport, "request"], { input: JSON.stringify(truncated), env });
  assert.equal(bounded.code, 75); assert.match(bounded.stderr, /truncated/u);
  const invalidTruncation = { ...base, request: { method: "GET", path: "/nodes/prox2/qemu/9051/agent/exec-status?pid=98" } };
  const invalidStatus = await runProgram("/usr/bin/python3", [transport, "request"], { input: JSON.stringify(invalidTruncation), env });
  assert.equal(invalidStatus.code, 70); assert.match(invalidStatus.stderr, /truncation status is invalid/u);
  const configuredDescription = `nelos-desktop-v1:${Buffer.from(JSON.stringify({
    providerId: runtimeBinding.providerId, hostId: runtimeBinding.hostId, vmId: runtimeBinding.vmId,
    macAddress: runtimeBinding.macAddress, networkId: runtimeBinding.networkId, gatewayId: runtimeBinding.gatewayId,
    networkPolicyDigest: runtimeBinding.networkPolicyDigest,
    leaseId: runtimeBinding.leaseId, fencingToken: runtimeBinding.fencingToken, imageId: runtimeBinding.imageId,
    state: "configured", stateRoot: runtimeBinding.stateRoot, runId: runtimeBinding.runId, automationUser: runtimeBinding.automationUser,
  })).toString("base64url")}`;
  const configured = { ...base, request: { method: "PUT", path: "/nodes/prox2/qemu/9051/config", body: {
    node: "prox2", agent: "enabled=1,fstrim_cloned_disks=1", onboot: 0, protection: 0,
    tags: "nelos-desktop;disposable;automation-only", ciuser: "nelosauto", description: configuredDescription,
    net0: `virtio=${runtimeBinding.macAddress},bridge=${runtimeBinding.networkId},firewall=1`,
  } } };
  const configuredResult = await runProgram("/usr/bin/python3", [transport, "request"], { input: JSON.stringify(configured), env });
  assert.equal(configuredResult.code, 0, configuredResult.stderr);
  const wrongUser = structuredClone(configured); wrongUser.request.body.ciuser = "developer";
  const wrongUserResult = await runProgram("/usr/bin/python3", [transport, "request"], { input: JSON.stringify(wrongUser), env });
  assert.equal(wrongUserResult.code, 77); assert.match(wrongUserResult.stderr, /not allowlisted/u);
  const configRead = { ...base, request: { method: "GET", path: "/nodes/prox2/qemu/9051/config" } };
  const attested = await runProgram("/usr/bin/python3", [attest, "request"], { input: JSON.stringify(configRead), env });
  assert.equal(attested.code, 0, attested.stderr); assert.deepEqual(JSON.parse(attested.stdout), { data: { description: "owned" } });
  for (const path of ["/nodes/prox2/qemu/9025/config", "/nodes/prox2/qemu/9025/status/current"]) {
    const sourceRead = { ...base, request: { method: "GET", path } };
    const providerRead = await runProgram("/usr/bin/python3", [transport, "request"], { input: JSON.stringify(sourceRead), env });
    assert.equal(providerRead.code, 0, providerRead.stderr);
    assert.deepEqual(JSON.parse(providerRead.stdout), { data: { description: "owned" } });
    const independentRead = await runProgram("/usr/bin/python3", [attest, "request"], { input: JSON.stringify(sourceRead), env });
    assert.equal(independentRead.code, 0, independentRead.stderr);
    assert.deepEqual(JSON.parse(independentRead.stdout), { data: { description: "owned" } });
  }
  const wrongSource = { ...base, request: { method: "GET", path: "/nodes/prox2/qemu/9026/config" } };
  for (const executable of [transport, attest]) {
    const rejectedSource = await runProgram("/usr/bin/python3", [executable, "request"], { input: JSON.stringify(wrongSource), env });
    assert.equal(rejectedSource.code, 77);
    assert.match(rejectedSource.stderr, /not allowlisted/u);
  }
  const mutation = { ...base, request: { method: "POST", path: "/nodes/prox2/qemu/9051/status/stop" } };
  const mutationDenied = await runProgram("/usr/bin/python3", [attest, "request"], { input: JSON.stringify(mutation), env });
  assert.equal(mutationDenied.code, 77); assert.match(mutationDenied.stderr, /bodyless GET/u);

  const policyRead = { ...base, request: { method: "GET", path: "/nelos/network/policy" } };
  const policyResult = await runProgram("/usr/bin/python3", [attest, "request"], { input: JSON.stringify(policyRead), env });
  assert.equal(policyResult.code, 0, policyResult.stderr);
  const policy = JSON.parse(policyResult.stdout);
  assert.equal(policy.gateway.vmId, runtimeBinding.gatewayId);
  assert.equal(policy.measurement.policyDigest, runtimeBinding.networkPolicyDigest);
  assert.equal(policy.measurement.rulesetDigest, networkPolicyRulesetDigest);
  assert.equal(policy.measurement.approvedAddressInventoryDigest, networkPolicyAddressDigest);
  assert.equal(policy.measurement.helper.digest, networkPolicyObserverDigest);
  assert.equal(policy.observationDigest, sha256(Object.fromEntries(Object.entries(policy).filter(([key]) => key !== "observationDigest"))));

  const wrongMeasurement = { ...gatewayMeasurement, approvedAddressCount: 3, approvedAddressInventoryDigest: `sha256:${"6".repeat(64)}` };
  const { measurementDigest: ignoredMeasurementDigest, ...wrongMeasurementUnsigned } = wrongMeasurement;
  wrongMeasurement.measurementDigest = sha256(wrongMeasurementUnsigned);
  const wrongMeasurementBase64 = Buffer.from(`${canonicalJson(wrongMeasurement)}\n`).toString("base64");
  await writeFile(fakePvesh, (await readFile(fakePvesh, "utf8")).replace(gatewayMeasurementBase64, wrongMeasurementBase64));
  const wrongPolicy = await runProgram("/usr/bin/python3", [attest, "request"], { input: JSON.stringify(policyRead), env });
  assert.equal(wrongPolicy.code, 70); assert.match(wrongPolicy.stderr, /QGA-derived gateway nftables proof is unavailable/u);

  const macRead = { ...base, request: { method: "GET", path: "/nelos/network/mac-absence" } };
  const macAbsent = await runProgram("/usr/bin/python3", [attest, "request"], { input: JSON.stringify(macRead), env });
  assert.equal(macAbsent.code, 0, macAbsent.stderr);
  assert.deepEqual(JSON.parse(macAbsent.stdout), {
    absent: true, complete: true, kind: "nelos.proxmox-desktop.mac-absence.v1",
    macAddress: runtimeBinding.macAddress, networkId: runtimeBinding.networkId, scannedQemuCount: 0, schemaVersion: 1,
  });

  await writeFile(fakePvesh, `#!${process.execPath}
const args = process.argv.slice(2); const path = args[1];
if (path === "/cluster/resources") process.stdout.write(JSON.stringify([{type:"qemu",node:"other-node",vmid:9191}]));
else if (path === "/nodes/other-node/qemu/9191/config") process.stdout.write(JSON.stringify({net0:"virtio=${runtimeBinding.macAddress},bridge=other"}));
else process.exit(2);
`);
  const macPresent = await runProgram("/usr/bin/python3", [attest, "request"], { input: JSON.stringify(macRead), env });
  assert.equal(macPresent.code, 0, macPresent.stderr);
  assert.equal(JSON.parse(macPresent.stdout).absent, false);

  await writeFile(fakePvesh, `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[1]==="/cluster/resources") process.stdout.write(JSON.stringify([{type:"unknown",node:"other",vmid:9191}])); else process.exit(2);\n`);
  const incompleteMacInventory = await runProgram("/usr/bin/python3", [attest, "request"], { input: JSON.stringify(macRead), env });
  assert.equal(incompleteMacInventory.code, 70); assert.match(incompleteMacInventory.stderr, /unknown resource/u);
});
