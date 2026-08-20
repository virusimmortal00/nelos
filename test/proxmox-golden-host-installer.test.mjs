import assert from "node:assert/strict";
import { chmod, chown, link, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { sha256V1 } from "../validation/proxmox-desktop/v1/build-golden-image.mjs";
import {
  createVolumeAttestorHostInstallPlanV1,
  installGoldenBuilderHostV1,
  LocalGoldenBuilderHostBoundaryV1,
  observeGoldenGatewayGuestHelperV1,
  reconcileGoldenBuilderHostV1,
  removeGoldenBuilderHostV1,
  validateGoldenBuilderHostInstallPlanV1,
  verifyGoldenBuilderHostV1,
} from "../validation/proxmox-desktop/v1/golden-builder-host-installer.mjs";

const PUBLIC = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm";
const FP = "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg";
const NOW = Date.parse("2026-08-20T12:00:00.000Z");

function fixture(gateway = false) {
  const hostHelperBytes = Buffer.from(gateway ? "gateway host helper\n" : "builder host helper\n"); const guestHelperBytes = gateway ? Buffer.from("gateway guest helper\n") : null;
  const hostHelperPath = gateway ? "/usr/libexec/nelos-proxmox-golden-gateway-transport" : "/usr/libexec/nelos-proxmox-golden-builder-helper";
  const users = gateway ? ["nelos-golden-gateway-provider", "nelos-golden-gateway-attestor"] : ["nelos-golden-provider", "nelos-golden-attestor"];
  const homes = gateway ? ["/var/lib/nelos-golden-gateway-provider", "/var/lib/nelos-golden-gateway-attestor"] : ["/var/lib/nelos-golden-provider", "/var/lib/nelos-golden-attestor"];
  const sudoers = gateway ? ["/etc/sudoers.d/nelos-golden-gateway-provider", "/etc/sudoers.d/nelos-golden-gateway-attestor"] : ["/etc/sudoers.d/nelos-golden-builder-provider", "/etc/sudoers.d/nelos-golden-builder-attestor"];
  const principals = ["provider", "attestor"].map((role, index) => {
    const command = `${hostHelperPath} ${role} request`;
    return { role, user: users[index], home: homes[index], shell: "/bin/sh", authorizedKeysPath: `${homes[index]}/.ssh/authorized_keys`, authorizedKey: `restrict,command="/usr/bin/sudo -n -- ${command}" ${PUBLIC} nelos:${role}:fixture\n`, sudoersPath: sudoers[index], sudoers: `${users[index]} ALL=(root) NOPASSWD: ${command}\n` };
  });
  const commonBinding = { schemaVersion: 1, providerPublicKey: PUBLIC, providerKeyFingerprint: FP, providerUser: users[0], attestorPublicKey: PUBLIC, attestorKeyFingerprint: FP, attestorUser: users[1], expiresAt: "2026-08-20T14:00:00.000Z" };
  const unsignedBinding = gateway ? { ...commonBinding, kind: "nelos-golden-builder-gateway-host-binding", policyBinding: { helper: { digest: sha256V1(guestHelperBytes) } }, hostHelperDigest: sha256V1(hostHelperBytes) }
    : { ...commonBinding, kind: "nelos-golden-builder-host-binding", lifecycleBinding: {}, helperDigest: sha256V1(hostHelperBytes), cleanupExpiresAt: "2026-08-20T15:00:00.000Z" };
  const hostBinding = { ...unsignedBinding, hostBindingDigest: sha256V1(unsignedBinding) };
  const unsignedPlan = gateway ? { schemaVersion: 1, kind: "nelos-golden-builder-gateway-host-install-plan", hostBindingDigest: hostBinding.hostBindingDigest, hostBindingPath: "/etc/nelos-golden/gateway-transport-binding.json", hostHelperDigest: sha256V1(hostHelperBytes), hostHelperPath, guestHelperDigest: sha256V1(guestHelperBytes), guestHelperPath: "/usr/libexec/nelos-golden-gateway-policy", guestVmId: 9023, knownHostsLine: `192.168.1.110 ${PUBLIC}\n`, principals }
    : { schemaVersion: 1, kind: "nelos-golden-builder-host-install-plan", hostBindingDigest: hostBinding.hostBindingDigest, hostBindingPath: "/etc/nelos-golden/builder-host-binding.json", helperDigest: sha256V1(hostHelperBytes), helperPath: hostHelperPath, knownHostsLine: `192.168.1.110 ${PUBLIC}\n`, principals };
  const plan = { ...unsignedPlan, planDigest: sha256V1(unsignedPlan) };
  return { plan, hostBinding, hostHelperBytes, guestHelperBytes };
}

function volumeFixture() {
  const hostHelperBytes = Buffer.from("#!/usr/bin/python3\n# measured volume helper\n");
  const hostBinding = {
    schemaVersion: 1, reservationId: "volume-attestor-fixture", providerId: "proxmox-lab", node: "prox2", storage: "local-lvm",
    sourceTemplate: { vmId: 9024, name: "nelos-ubuntu-24-04-source" }, outputTemplate: { vmId: 9027, name: "nelos-desktop-ubuntu-24-04-v1", macAddress: "02:4E:45:4C:90:27" },
    buildNonce: "c".repeat(32), expiresAt: "2026-08-20T14:00:00.000Z", helperDigest: sha256V1(hostHelperBytes), volumeAttestorFingerprint: FP,
  };
  const plan = createVolumeAttestorHostInstallPlanV1({ hostBinding, helperBytes: hostHelperBytes, publicKey: PUBLIC });
  return { plan, hostBinding, hostHelperBytes, guestHelperBytes: null };
}

class FakeBoundary {
  constructor({ failAt = null, ownershipDrift = false } = {}) { this.targets = new Set(); this.intent = null; this.calls = []; this.failAt = failAt; this.ownershipDrift = ownershipDrift; }
  #crash(name) { this.calls.push(name); if (this.failAt === name) { this.failAt = null; throw Object.assign(new Error("synthetic process death"), { code: "SYNTHETIC_CRASH" }); } }
  #effect(name, key, present) { this.#crash(`before:${name}`); if (present) this.targets.add(key); else this.targets.delete(key); this.#crash(`after:${name}`); }
  #principal(role, part) { return `principal:${role}:${part}`; }
  #identity(plan, role) { const index = plan.principals.findIndex((item) => item.role === role); const principal = plan.principals[index]; return { role, user: principal.user, uid: 29_001 + index, gid: 29_001 + index }; }
  #persistent(plan) {
    return new Set([
      plan.hostBindingPath, plan.helperPath ?? plan.hostHelperPath, ...(plan.guestHelperPath ? [plan.guestHelperPath] : []),
      ...plan.principals.flatMap(({ role }) => ["user", "lock", "home", "ssh", "authorized-key", "sudoers"].map((part) => this.#principal(role, part))),
    ]);
  }
  async beginIntent({ plan, action, targetsDigest, principalIdentities }) {
    this.#crash(`before:intent:${action}`);
    if (this.intent && (this.intent.planDigest !== plan.planDigest || this.intent.action !== action || this.intent.targetsDigest !== targetsDigest)) throw Object.assign(new Error("intent collision"), { code: "HOST_INSTALL_RECONCILIATION_REQUIRED" });
    this.intent ??= { schemaVersion: 1, kind: "nelos-golden-builder-host-install-intent", planDigest: plan.planDigest, hostBindingDigest: plan.hostBindingDigest, action, targetsDigest, principalIdentities: structuredClone(principalIdentities), completedEffects: [] };
    this.#crash(`after:intent:${action}`);
  }
  async recordEffect({ effect }) { this.#crash(`before-journal:${effect}`); if (!this.intent.completedEffects.includes(effect)) this.intent.completedEffects.push(effect); this.#crash(`after-journal:${effect}`); }
  async bindPrincipalIdentity({ plan, principal }) {
    const identity = this.#identity(plan, principal.role); this.#crash(`before-bind:${principal.role}`);
    const existing = this.intent.principalIdentities.find((item) => item.role === principal.role);
    if (existing && JSON.stringify(existing) !== JSON.stringify(identity)) throw Object.assign(new Error("identity mismatch"), { code: "HOST_INSTALL_RECONCILIATION_REQUIRED" });
    if (!existing) this.intent.principalIdentities.push(identity);
    this.#crash(`after-bind:${principal.role}`);
  }
  async clearIntent() { this.#crash("before:intent:clear"); this.intent = null; this.#crash("after:intent:clear"); }
  async readIntent() { return this.intent; }
  async installHostFile({ path }) { this.#effect(`install:${path}`, path, true); }
  async installGuestFile({ path }) { this.#effect(`install:${path}`, path, true); }
  async installPrincipal({ plan, principal }) { for (const part of ["user", "lock", "home", "ssh", "authorized-key", "sudoers", "visudo"]) { this.#effect(`install:${this.#principal(principal.role, part)}`, this.#principal(principal.role, part), part !== "visudo"); if (part === "user") await this.bindPrincipalIdentity({ plan, principal }); await this.recordEffect({ plan, effect: this.#principal(principal.role, part) }); } }
  async removeHostFile({ path }) { this.#effect(`remove:${path}`, path, false); }
  async removeGuestFile({ path }) { this.#effect(`remove:${path}`, path, false); }
  async removePrincipal({ plan, principal }) { for (const part of ["authorized-key", "sudoers", "ssh", "home", "lock", "user"]) { this.#effect(`remove:${this.#principal(principal.role, part)}`, this.#principal(principal.role, part), false); await this.recordEffect({ plan, effect: this.#principal(principal.role, part) }); } }
  async verify({ plan, expectedState }) {
    const expected = this.#persistent(plan);
    const all = [...expected].every((item) => this.targets.has(item)); const none = [...expected].every((item) => !this.targets.has(item));
    const state = none ? "absent" : all ? "installed" : "partial"; const exactOwned = !this.ownershipDrift;
    if (expectedState === "absent" && state !== "absent" || expectedState === "installed" && state !== "installed" || expectedState === "partial-or-installed" && !exactOwned) throw Object.assign(new Error("state mismatch"), { code: "HOST_STATE_MISMATCH" });
    const principalIdentities = plan.principals.filter(({ role }) => this.targets.has(this.#principal(role, "user"))).map(({ role }) => this.#identity(plan, role));
    return { state, exactOwned, principalIdentities, targetsDigest: sha256V1({ state, planDigest: plan.planDigest, principalIdentities }) };
  }
}

async function directory(t) { const created = await mkdtemp(join(tmpdir(), "nelos-host-install-")); const path = await realpath(created); await chown(path, process.getuid(), process.getgid()); await chmod(path, 0o700); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function input(value, receiptPath) { return { ...value, authorizePlan: value.plan.planDigest, receiptPath }; }

for (const gateway of [false, true]) test(`${gateway ? "gateway" : "builder"} plan installs, verifies, and removes exact measured authority`, async (t) => {
  const root = await directory(t); const value = fixture(gateway); const boundary = new FakeBoundary(); validateGoldenBuilderHostInstallPlanV1(value.plan);
  const installed = await installGoldenBuilderHostV1(input(value, join(root, "install.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 });
  assert.equal(installed.result, "installed"); assert.equal(installed.principalIdentities.length, 2); assert.equal((await stat(join(root, "install.json"))).mode & 0o777, 0o400);
  const installedBytes = await readFile(join(root, "install.json")); const atomicTemporary = join(root, `.install.json.${sha256V1(installedBytes).slice(7, 23)}.nelos-tmp`);
  await link(join(root, "install.json"), atomicTemporary);
  assert.deepEqual(await installGoldenBuilderHostV1(input(value, join(root, "install.json")), { boundary, clock: { now: () => NOW + 1_000 }, euid: () => 0 }), installed);
  assert.equal((await stat(join(root, "install.json"))).nlink, 1); await assert.rejects(stat(atomicTemporary), /ENOENT/u);
  const verified = await verifyGoldenBuilderHostV1({ ...value, receiptPath: join(root, "verify.json") }, { boundary, clock: { now: () => NOW }, euid: () => 0 }); assert.equal(verified.action, "verify");
  assert.deepEqual(await verifyGoldenBuilderHostV1({ ...value, receiptPath: join(root, "verify.json") }, { boundary, clock: { now: () => NOW + 1_000 }, euid: () => 0 }), verified);
  const removed = await removeGoldenBuilderHostV1(input(value, join(root, "remove.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 }); assert.equal(removed.result, "absent"); assert.equal(boundary.targets.size, 0);
  assert.deepEqual(removed.principalIdentities, installed.principalIdentities);
  for (const receipt of ["install.json", "verify.json", "remove.json"]) assert.doesNotMatch(await readFile(join(root, receipt), "utf8"), /authorizedKey|publicKey|sudoers|secret|token/iu);
});

test("partial installation retains its exact intent and resumes without replaying conflicting authority", async (t) => {
  const root = await directory(t); const value = fixture(true); const boundary = new FakeBoundary({ failAt: "after:install:principal:provider:home" });
  await assert.rejects(() => installGoldenBuilderHostV1(input(value, join(root, "receipt.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 }), { code: "SYNTHETIC_CRASH" });
  assert.equal(boundary.intent.action, "install"); await assert.rejects(readFile(join(root, "receipt.json")), { code: "ENOENT" });
  const resumed = await reconcileGoldenBuilderHostV1(input(value, join(root, "receipt.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 });
  assert.equal(resumed.result, "installed"); assert.equal(boundary.intent, null);
});

test("tampered partial installation retains its intent for explicit quarantine", async (t) => {
  const root = await directory(t); const value = fixture(false); const boundary = new FakeBoundary({ failAt: `after:install:${value.plan.hostBindingPath}` });
  await assert.rejects(() => installGoldenBuilderHostV1(input(value, join(root, "receipt.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 }), { code: "SYNTHETIC_CRASH" });
  assert.equal(boundary.intent.planDigest, value.plan.planDigest);
  boundary.ownershipDrift = true;
  await assert.rejects(() => reconcileGoldenBuilderHostV1(input(value, join(root, "reconciled.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 }), { code: "HOST_STATE_MISMATCH" });
  boundary.ownershipDrift = false;
  const reconciled = await reconcileGoldenBuilderHostV1(input(value, join(root, "reconciled.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 }); assert.equal(reconciled.result, "installed");
});

test("partial account allocation cannot be rebound to a different uid or gid on replay", async (t) => {
  const root = await directory(t); const value = fixture(false); const boundary = new FakeBoundary({ failAt: "after-bind:provider" });
  await assert.rejects(() => installGoldenBuilderHostV1(input(value, join(root, "receipt.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 }), { code: "SYNTHETIC_CRASH" });
  boundary.intent.principalIdentities[0].uid += 10;
  await assert.rejects(
    () => reconcileGoldenBuilderHostV1(input(value, join(root, "receipt.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 }),
    { code: "HOST_INSTALL_RECONCILIATION_REQUIRED" },
  );
  assert.equal(boundary.intent.principalIdentities[0].uid, 29_011);
});

test("authorization, root identity, material digest, and unknown plan fields fail before mutation", async (t) => {
  const root = await directory(t); const value = fixture(false);
  for (const [inputValue, options, code] of [
    [{ ...input(value, join(root, "a.json")), authorizePlan: `sha256:${"0".repeat(64)}` }, { boundary: new FakeBoundary(), euid: () => 0 }, "MUTATION_AUTHORIZATION_REQUIRED"],
    [input(value, join(root, "b.json")), { boundary: new FakeBoundary(), euid: () => 501 }, "ROOT_REQUIRED"],
    [{ ...input(value, join(root, "c.json")), hostHelperBytes: Buffer.from("tampered") }, { boundary: new FakeBoundary(), euid: () => 0 }, "INSTALL_MATERIAL_MISMATCH"],
    [{ ...input(value, join(root, "d.json")), plan: { ...value.plan, extra: true } }, { boundary: new FakeBoundary(), euid: () => 0 }, "INVALID_INSTALL_PLAN"],
  ]) await assert.rejects(() => installGoldenBuilderHostV1(inputValue, { clock: { now: () => NOW }, ...options }), { code });
});

test("gateway guest observation treats only an exact in-guest ENOENT proof as absence", async () => {
  const envelope = (payload, overrides = {}) => ({
    code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({ "err-data": "", exitcode: 0, exited: 1, "out-data": `${JSON.stringify(payload)}\n`, ...overrides })),
  });
  const target = { vmId: 9023, path: "/usr/libexec/nelos-golden-gateway-policy", mode: 0o755 };
  assert.deepEqual(await observeGoldenGatewayGuestHelperV1(target, { runCommand: async () => envelope({ state: "absent" }) }), { state: "absent", exact: true });
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal((await observeGoldenGatewayGuestHelperV1(target, { runCommand: async () => envelope({ digest, gid: 0, mode: "0755", nlink: 1, state: "present", uid: 0 }) })).digest, digest);
  for (const response of [
    { code: 255, stdout: Buffer.alloc(0), stderr: Buffer.from("QGA unavailable") },
    { code: 0, stdout: Buffer.from("not-json"), stderr: Buffer.alloc(0) },
    envelope({ state: "absent" }, { exitcode: 1 }),
    envelope({ state: "absent" }, { exited: 0 }),
    envelope({ state: "absent", reason: "guessed" }),
    envelope({ digest, gid: 0, mode: "0755", nlink: 1, state: "present", uid: 1 }),
  ]) await assert.rejects(() => observeGoldenGatewayGuestHelperV1(target, { runCommand: async () => response }), { code: "GATEWAY_GUEST_OBSERVATION_AMBIGUOUS" });
});

test("the Local boundary refuses a group-writable parent before atomic host publication", async (t) => {
  const root = await directory(t); await chmod(root, 0o770); const target = join(root, "helper");
  await assert.rejects(
    () => new LocalGoldenBuilderHostBoundaryV1().installHostFile({ path: target, bytes: Buffer.from("helper\n"), mode: 0o755 }),
    { code: "HOST_TARGET_COLLISION" },
  );
  await assert.rejects(readFile(target), /ENOENT/u);
});

test("fixed volume-attestor plan uses the same resumable helper/binding/key/sudo/account lifecycle", async (t) => {
  const root = await directory(t); const value = volumeFixture(); const boundary = new FakeBoundary({ failAt: "after:install:principal:attestor:authorized-key" });
  const installPath = join(root, "volume-install.json");
  await assert.rejects(() => installGoldenBuilderHostV1(input(value, installPath), { boundary, clock: { now: () => NOW }, euid: () => 0 }), { code: "SYNTHETIC_CRASH" });
  const installed = await installGoldenBuilderHostV1(input(value, installPath), { boundary, clock: { now: () => NOW }, euid: () => 0 });
  assert.equal(installed.result, "installed"); assert.equal(boundary.targets.has("principal:attestor:authorized-key"), true);
  boundary.failAt = "after:remove:principal:attestor:user"; const removePath = join(root, "volume-remove.json");
  await assert.rejects(() => removeGoldenBuilderHostV1(input(value, removePath), { boundary, clock: { now: () => NOW }, euid: () => 0 }), { code: "SYNTHETIC_CRASH" });
  const removed = await removeGoldenBuilderHostV1(input(value, removePath), { boundary, clock: { now: () => NOW }, euid: () => 0 });
  assert.equal(removed.result, "absent"); assert.equal(boundary.targets.size, 0);
});

test("reconcile rejects a missing intent with the reconciliation error", async (t) => {
  const root = await directory(t); const value = fixture(true); const boundary = new FakeBoundary();
  await assert.rejects(
    () => reconcileGoldenBuilderHostV1(input(value, join(root, "reconcile.json")), { boundary, clock: { now: () => NOW }, euid: () => 0 }),
    { code: "HOST_INSTALL_RECONCILIATION_REQUIRED" },
  );
});

test("every host/principal effect and receipt boundary resumes idempotently after process death", async (t) => {
  const root = await directory(t); const value = fixture(true);
  const hostInstall = [`install:${value.plan.hostHelperPath}`, `install:${value.plan.hostBindingPath}`, `install:${value.plan.guestHelperPath}`];
  const principalInstall = value.plan.principals.flatMap(({ role }) => ["user", "lock", "home", "ssh", "authorized-key", "sudoers", "visudo"].map((part) => `install:principal:${role}:${part}`));
  const installEffects = [
    `host-file:${value.plan.hostHelperPath}`, `host-file:${value.plan.hostBindingPath}`, `guest-file:${value.plan.guestVmId}:${value.plan.guestHelperPath}`,
    ...value.plan.principals.flatMap(({ role }) => ["user", "lock", "home", "ssh", "authorized-key", "sudoers", "visudo"].map((part) => `principal:${role}:${part}`)), "receipt",
  ];
  const installCrashes = ["before:intent:install", "after:intent:install", ...hostInstall.flatMap((name) => [`before:${name}`, `after:${name}`]),
    ...principalInstall.flatMap((name) => [`before:${name}`, `after:${name}`]), ...value.plan.principals.flatMap(({ role }) => [`before-bind:${role}`, `after-bind:${role}`]), ...installEffects.flatMap((name) => [`before-journal:${name}`, `after-journal:${name}`]),
    "before:intent:clear", "after:intent:clear"];
  for (const [index, crash] of installCrashes.entries()) {
    const receiptPath = join(root, `install-${index}.json`); const boundary = new FakeBoundary({ failAt: crash });
    await assert.rejects(() => installGoldenBuilderHostV1(input(value, receiptPath), { boundary, clock: { now: () => NOW }, euid: () => 0 }), { code: "SYNTHETIC_CRASH" }, crash);
    const resumed = await installGoldenBuilderHostV1(input(value, receiptPath), { boundary, clock: { now: () => NOW + 1_000 }, euid: () => 0 });
    assert.equal(resumed.result, "installed", crash); assert.equal(boundary.intent, null, crash);
  }

  const principalRemove = [...value.plan.principals].reverse().flatMap(({ role }) => ["authorized-key", "sudoers", "ssh", "home", "lock", "user"].map((part) => `remove:principal:${role}:${part}`));
  const hostRemove = [`remove:${value.plan.guestHelperPath}`, `remove:${value.plan.hostBindingPath}`, `remove:${value.plan.hostHelperPath}`];
  const removeEffects = [
    ...[...value.plan.principals].reverse().flatMap(({ role }) => ["authorized-key", "sudoers", "ssh", "home", "lock", "user"].map((part) => `principal:${role}:${part}`)),
    `guest-file:${value.plan.guestVmId}:${value.plan.guestHelperPath}`, `host-file:${value.plan.hostBindingPath}`, `host-file:${value.plan.hostHelperPath}`, "receipt",
  ];
  const removeCrashes = ["before:intent:remove", "after:intent:remove", ...principalRemove.flatMap((name) => [`before:${name}`, `after:${name}`]),
    ...hostRemove.flatMap((name) => [`before:${name}`, `after:${name}`]), ...removeEffects.flatMap((name) => [`before-journal:${name}`, `after-journal:${name}`]),
    "before:intent:clear", "after:intent:clear"];
  for (const [index, crash] of removeCrashes.entries()) {
    const boundary = new FakeBoundary(); const installPath = join(root, `remove-setup-${index}.json`); const receiptPath = join(root, `remove-${index}.json`);
    await installGoldenBuilderHostV1(input(value, installPath), { boundary, clock: { now: () => NOW }, euid: () => 0 }); boundary.failAt = crash;
    await assert.rejects(() => removeGoldenBuilderHostV1(input(value, receiptPath), { boundary, clock: { now: () => NOW }, euid: () => 0 }), { code: "SYNTHETIC_CRASH" }, crash);
    const resumed = await removeGoldenBuilderHostV1(input(value, receiptPath), { boundary, clock: { now: () => NOW + 1_000 }, euid: () => 0 });
    assert.equal(resumed.result, "absent", crash); assert.equal(boundary.intent, null, crash); assert.equal(boundary.targets.size, 0, crash);
  }
});

test("installer schemas are closed and production CLIs have no live-test escape hatch", async () => {
  for (const name of ["golden-builder-host-install-plan.schema.json", "golden-builder-gateway-host-install-plan.schema.json", "golden-volume-attestor-host-install-plan.schema.json", "golden-builder-host-install-intent.schema.json", "golden-builder-host-install-receipt.schema.json"]) {
    const schema = JSON.parse(await readFile(resolve("validation/proxmox-desktop/v1", name), "utf8")); assert.equal(schema.additionalProperties, false); assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    if (schema.$defs?.principalIdentities) assert.equal(schema.$defs.principalIdentities.items.additionalProperties, false);
  }
  const cli = `${await readFile(resolve("bin/nelos-golden-host-installer"), "utf8")}\n${await readFile(resolve("bin/nelos-volume-attestor-host-installer"), "utf8")}`; assert.doesNotMatch(cli, /runtime-module|accept-new|StrictHostKeyChecking=no/u);
  assert.match(await readFile(resolve("validation/proxmox-desktop/v1/install-volume-attestor.sh"), "utf8"), /deprecated unsafe entrypoint/u);
  const source = await readFile(resolve("validation/proxmox-desktop/v1/golden-builder-host-installer.mjs"), "utf8");
  for (const token of ["principalIdentities", "requireNoSupplementaryGroups", "/usr/bin/id", "requireNoOwnedProcesses", "/usr/bin/pgrep", "requireRootOwnedDirectoryChain", "unsafe parent chain"]) assert.match(source, new RegExp(token.replaceAll("/", "\\/"), "u"));
});
