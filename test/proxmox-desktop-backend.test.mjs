import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ProxmoxDesktopBackendError,
  ProxmoxVeDesktopAdapterV1,
  admitProxmoxDesktopOperationV1,
  assertProxmoxDesktopPackageLockUsableV1,
  executeProxmoxQgaControlV1,
  runProxmoxDesktopOperationV1,
  validateProxmoxDesktopPackageLockV1,
} from "../validation/proxmox-desktop/v1/backend/index.mjs";
import { validateRemoteDesktopTerminalOutcomeV1 } from "../src/remote-desktop-contract/index.mjs";
import { validRemoteDesktopRunV1 } from "./fixtures/remote-desktop-contract-v1.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const credentialBoundary = (value = request()) => {
  const unsigned = {
    schemaVersion: 1, type: "nelos.credential-volatility.v1", runId: value.runId, fencingToken: value.lease.fencingToken,
    vmId: value.provider.vmId, imageId: value.goldenImage.imageId, codexHome: "/home/nelosauto/.codex", filesystemType: "tmpfs",
    mountOptions: ["nodev", "noexec", "nosuid", "rw"], swapActive: false, volatile: true,
    bootIdDigest: digest("6"), secretBytesIncluded: false,
  };
  return { ...unsigned, attestationDigest: `sha256:${createHash("sha256").update(`${JSON.stringify(canonical(unsigned))}\n`).digest("hex")}` };
};

function request(operation = "create") {
  return {
    schemaVersion: 1,
    operationId: `op-${operation}-001`,
    operation,
    runId: "desktop-run-001",
    provider: {
      providerId: "proxmox-lab", hostId: "prox2", vmId: "9051",
      macAddress: "02:4E:45:4C:90:51", networkId: "nelosbld", gatewayId: "9023", networkPolicyDigest: digest("9"),
    },
    desktopBundle: { bundleId: "chatgpt", version: "26.814.41957", digest: "sha256:4778b26a7abd08647214d5b05c17bd3ebe2d9688d146dabf017c1a2faf93ac7d" },
    goldenImage: { imageId: "nelos-desktop-ubuntu-24-04-v1", digest: digest("a"), templateVmId: "9001" },
    lease: {
      leaseId: "lease-desktop-001",
      holderId: "controller-01",
      expiresAt: "2099-01-01T00:00:00.000Z",
      fencingToken: "fence-0007",
      state: "active",
    },
    reservation: {
      reservationId: "reservation-9051",
      providerId: "proxmox-lab",
      hostId: "prox2",
      vmId: "9051",
      macAddress: "02:4E:45:4C:90:51",
      networkId: "nelosbld",
      gatewayId: "9023",
      networkPolicyDigest: digest("9"),
      leaseId: "lease-desktop-001",
      fencingToken: "fence-0007",
      state: "reserved",
    },
    automation: {
      user: "nelosauto",
      uid: 2401,
      home: "/home/nelosauto",
      stateRoot: "/var/lib/nelos-desktop/runs/desktop-run-001",
      credentialRefs: [],
    },
  };
}

function installedDesktopIdentity() {
  return {
    appServer: { platformFamily: "unix", platformOs: "linux", userAgent: "Codex Desktop/0.148.0-alpha.15" },
    bakeReceiptDigest: digest("b"),
    bundledCodex: { digest: "sha256:f13176129580681cf3024192f1ad43535c9933b24b7eca89e90fa57b3f4855fc", gid: 0, mode: "0755", path: "/usr/lib/chatgpt/resources/codex", uid: 0, version: "0.148.0-alpha.15" },
    bundledNode: { digest: "sha256:bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12", gid: 0, mode: "0755", path: "/usr/lib/chatgpt/resources/cua_node/bin/node", uid: 0, version: "24.19.0" },
    desktopPackage: { architecture: "amd64", digest: "sha256:4778b26a7abd08647214d5b05c17bd3ebe2d9688d146dabf017c1a2faf93ac7d", name: "chatgpt", version: "26.814.41957" },
    kind: "nelos-desktop-installed-identity",
    lockId: "nelos-proxmox-desktop-ubuntu-24.04-amd64-20260819",
    packageLockDigest: "sha256:9925b56c881ae22ffe6a3d22f8a2066b7ae2b4a4613029c2f79cb024a0398e93",
    schemaVersion: 1,
    verified: true,
  };
}

function inventoryOf(value, state = "running") {
  return {
    ...value.provider,
    leaseId: value.lease.leaseId,
    fencingToken: value.lease.fencingToken,
    imageId: value.goldenImage.imageId,
    state,
  };
}

class OfflineProxmoxFixture {
  constructor({ present = false, ambiguous = null, qgaReady = true, qgaError = null, exactAbsence = true } = {}) {
    this.calls = [];
    this.vm = present ? inventoryOf(request("start"), "stopped") : null;
    this.ambiguous = ambiguous;
    this.qgaReady = qgaReady;
    this.qgaError = qgaError;
    this.exactAbsence = exactAbsence;
    this.receipts = [];
  }

  async inspectVm(binding) {
    this.calls.push(["inspectVm", binding.vmId]);
    return this.vm === null ? null : structuredClone(this.vm);
  }

  result(method, state) {
    this.calls.push([method]);
    if (this.ambiguous === method) return { status: "timed_out", providerOperationId: `upid-${method}` };
    if (state === null) this.vm = null;
    else if (state) this.vm = { ...(this.vm ?? inventoryOf(request())), state };
    return { status: "committed", providerOperationId: `upid-${method}` };
  }

  async cloneVm({ configuration }) {
    assert.equal(configuration.disposable, true);
    assert.equal(configuration.automation.passwordLocked, true);
    assert.deepEqual(configuration.automation.sshAuthorizedKeys, []);
    assert.deepEqual(configuration.credentialRefs, []);
    this.vm = inventoryOf(request(), "created");
    return this.result("cloneVm");
  }

  async configureVm({ configuration }) {
    assert.equal(configuration.qgaEnabled, true);
    assert.equal(configuration.graphicalTarget, "graphical.target");
    assert.equal(configuration.writableState.persistent, false);
    assert.deepEqual(configuration.network, {
      interface: "net0", model: "virtio", macAddress: "02:4E:45:4C:90:51", networkId: "nelosbld",
      gatewayId: "9023", networkPolicyDigest: digest("9"), firewall: true, exclusive: true,
    });
    return this.result("configureVm", "configured");
  }

  async startVm() { return this.result("startVm", "running"); }
  async stopVm() { return this.result("stopVm", "stopped"); }
  async attestVmStopped(binding) {
    this.calls.push(["attestVmStopped", binding.vmId]);
    return { ...binding, poweredOff: this.vm?.state === "stopped" || this.vm?.state === "quarantined", powerState: this.vm?.state === "stopped" || this.vm?.state === "quarantined" ? "stopped" : "running" };
  }
  async destroyVm() { return this.result("destroyVm", null); }

  async quarantineVm({ reason }) {
    this.calls.push(["quarantineVm", reason]);
    this.vm = { ...inventoryOf(request(), "quarantined"), quarantined: true };
    return { status: "committed", providerOperationId: "upid-quarantine" };
  }

  async waitForQga({ expectedUser, expectedSession }) {
    this.calls.push(["waitForQga", expectedUser, expectedSession]);
    if (this.qgaError !== null) throw Object.assign(new Error("bounded QGA wait failed"), { code: this.qgaError });
    return this.qgaReady
      ? { ready: true, credentialBoundary: credentialBoundary(), installedDesktopIdentity: installedDesktopIdentity(), user: expectedUser, session: expectedSession }
      : { ready: false, user: null, session: null };
  }

  async attestVmAbsent(binding) {
    this.calls.push(["attestVmAbsent", binding.vmId]);
    return this.exactAbsence
      ? { ...binding, absent: true, macAbsent: true, networkInventoryComplete: true }
      : { ...binding, absent: false, macAbsent: false, networkInventoryComplete: true };
  }

  async reconcileMutation({ mutation, providerOperationId }) {
    this.calls.push(["reconcileMutation", mutation, providerOperationId]);
    if (mutation === "clone") this.vm = inventoryOf(request(), "created");
    return { status: "committed", providerOperationId };
  }

  async commitReceipt(value) {
    this.calls.push(["commitReceipt", value.operation]);
    this.receipts.push(structuredClone(value));
    return { committed: true, receiptId: value.receiptId, attestationDigest: value.attestationDigest };
  }

  async qgaControl(value) {
    this.calls.push(["qgaControl", value.control]);
    return { status: "ok", control: value.control };
  }
}

const context = (value) => ({ ownership: value.provider, currentLease: value.lease });

test("immutable lock covers Ubuntu, QGA, graphical session, and the official signed Linux Desktop preview", async () => {
  const lockUrl = new URL("../validation/proxmox-desktop/v1/package-lock.json", import.meta.url);
  const lock = JSON.parse(await readFile(lockUrl, "utf8"));
  assert.equal(validateProxmoxDesktopPackageLockV1(lock), lock);
  const artifacts = [lock.artifacts.ubuntuBase, lock.artifacts.qga, ...lock.artifacts.graphicalSession, lock.artifacts.chatgptDesktop, lock.artifacts.signatureVerifier];
  assert.ok(artifacts.every((item) => item.source && item.version && item.digest && item.signatureIdentity.fingerprint));
  assert.equal(assertProxmoxDesktopPackageLockUsableV1(lock), lock);
  assert.equal(lock.artifacts.chatgptDesktop.version, "26.814.41957");
  assert.equal(lock.artifacts.chatgptDesktop.digest, "sha256:4778b26a7abd08647214d5b05c17bd3ebe2d9688d146dabf017c1a2faf93ac7d");
  assert.equal(lock.artifacts.chatgptDesktop.bundledCodexPath, "/usr/lib/chatgpt/resources/codex");
  assert.equal(lock.artifacts.chatgptDesktop.bundledCodexDigest, "sha256:f13176129580681cf3024192f1ad43535c9933b24b7eca89e90fa57b3f4855fc");
  assert.equal(lock.artifacts.chatgptDesktop.bundledCodexVersion, "0.148.0-alpha.15");
  assert.equal(lock.artifacts.chatgptDesktop.bundledNodePath, "/usr/lib/chatgpt/resources/cua_node/bin/node");
  assert.equal(lock.artifacts.chatgptDesktop.bundledNodeDigest, "sha256:bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12");
  assert.equal(lock.artifacts.chatgptDesktop.bundledNodeVersion, "24.19.0");
  assert.equal(lock.artifacts.chatgptDesktop.signatureIdentity.fingerprint, "3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4");

  const recipe = await readFile(new URL("../validation/proxmox-desktop/v1/provision-golden-image.sh", import.meta.url), "utf8");
  assert.match(recipe, /getent passwd nelosauto.*die/u);
  assert.match(recipe, /qemu-guest-agent\.service gdm3\.service/u);
  assert.match(recipe, /graphical\.target/u);
  assert.match(recipe, /debsig-verify --policies-dir/u);
  assert.match(recipe, /bundled Codex digest mismatch/u);
  assert.match(recipe, /bundled Node version mismatch/u);
});

test("successful lifecycle provisions a disposable graphical clone and commits every receipt", async () => {
  const adapter = new OfflineProxmoxFixture();
  const create = request("create");
  const created = await runProxmoxDesktopOperationV1(create, adapter, context(create));
  assert.equal(created.created, true);
  assert.equal(created.qgaReady, true);

  for (const operation of ["stop", "start"]) {
    const value = request(operation);
    const result = await runProxmoxDesktopOperationV1(value, adapter, context(value));
    assert.equal(result.mutationStatus, "committed");
    assert.equal(result.operation, operation);
  }
  assert.deepEqual(adapter.receipts.map(({ operation }) => operation), ["create", "stop", "start"]);
  assert.ok(adapter.receipts.every(({ providerId, vmId, leaseId, fencingToken }) =>
    providerId === "proxmox-lab" && vmId === "9051" && leaseId === "lease-desktop-001" && fencingToken === "fence-0007"));
});

test("post-create QGA exceptions are quarantined and attested before failure returns", async () => {
  const value = request("create");
  const adapter = new OfflineProxmoxFixture({ qgaError: "QGA_DEADLINE_EXPIRED" });
  await assert.rejects(
    runProxmoxDesktopOperationV1(value, adapter, context(value)),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "QGA_NOT_READY" &&
      error.details?.cause === "QGA_DEADLINE_EXPIRED" && error.details?.quarantineReceipt?.quarantined === true,
  );
  assert.equal(adapter.calls.filter(([method]) => method === "quarantineVm").length, 1);
  assert.equal(adapter.receipts.at(-1)?.operation, "quarantine");
  assert.equal(adapter.vm?.quarantined, true);
  const methods = adapter.calls.map(([method]) => method);
  assert.ok(methods.indexOf("stopVm") < methods.indexOf("quarantineVm"));
  assert.equal(adapter.receipts.at(-1)?.credentialDisposition?.method, "powered-off-quarantine");
  assert.equal(adapter.receipts.at(-1)?.credentialDisposition?.reusableCredentialsAbsent, true);
  assert.equal(adapter.receipts.at(-1)?.credentialDisposition?.secretBytesIncluded, false);
});

test("post-start QGA failures are quarantined and attested before failure returns", async () => {
  const value = request("start");
  const adapter = new OfflineProxmoxFixture({ present: true, qgaReady: false });
  await assert.rejects(
    runProxmoxDesktopOperationV1(value, adapter, context(value)),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "QGA_NOT_READY" &&
      error.details?.quarantineReceipt?.quarantined === true,
  );
  assert.equal(adapter.calls.filter(([method]) => method === "quarantineVm").length, 1);
  assert.equal(adapter.receipts.at(-1)?.operation, "quarantine");
  const methods = adapter.calls.map(([method]) => method);
  assert.ok(methods.indexOf("stopVm") < methods.indexOf("quarantineVm"));
});

test("restart binds the exact run and golden image before any guest auth work", async () => {
  const value = request("start");
  const adapter = new OfflineProxmoxFixture({ present: true });
  const originalWaitForQga = adapter.waitForQga.bind(adapter);
  let waitInput = null;
  adapter.waitForQga = async (input) => {
    waitInput = structuredClone(input);
    return originalWaitForQga(input);
  };

  const result = await runProxmoxDesktopOperationV1(value, adapter, context(value));

  assert.equal(result.started, true);
  assert.deepEqual(waitInput.runtimeBinding, {
    ...value.provider,
    leaseId: value.lease.leaseId,
    fencingToken: value.lease.fencingToken,
    imageId: value.goldenImage.imageId,
    runId: value.runId,
    automationUser: value.automation.user,
    stateRoot: value.automation.stateRoot,
  });
});

test("lost QGA cannot produce a quarantine receipt until exact power-off is independently attested", async () => {
  const value = request("create");
  const adapter = new OfflineProxmoxFixture({ qgaError: "QGA_DEADLINE_EXPIRED" });
  adapter.attestVmStopped = async (binding) => {
    adapter.calls.push(["attestVmStopped", binding.vmId]);
    return { ...binding, poweredOff: false, powerState: "running" };
  };
  await assert.rejects(
    runProxmoxDesktopOperationV1(value, adapter, context(value)),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "CREDENTIAL_POWER_OFF_UNATTESTED",
  );
  assert.equal(adapter.calls.filter(([method]) => method === "stopVm").length, 1);
  assert.equal(adapter.calls.filter(([method]) => method === "quarantineVm").length, 0);
  assert.equal(adapter.receipts.some(({ operation }) => operation === "quarantine"), false);
  assert.equal(adapter.vm?.state, "stopped");
});

test("graphical startup requires cleanup margin before mutation and revalidates installed Desktop identity", async () => {
  const expiring = request("start");
  expiring.lease.expiresAt = "2026-08-20T12:02:00.000Z";
  const untouched = new OfflineProxmoxFixture({ present: true });
  await assert.rejects(
    runProxmoxDesktopOperationV1(expiring, untouched, { ...context(expiring), now: Date.parse("2026-08-20T12:00:00.000Z") }),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "STALE_FENCING_TOKEN",
  );
  assert.ok(untouched.calls.every(([method]) => method === "inspectVm"));

  const value = request("start");
  const altered = new OfflineProxmoxFixture({ present: true });
  altered.waitForQga = async ({ expectedUser, expectedSession }) => ({
    ready: true,
    installedDesktopIdentity: { ...installedDesktopIdentity(), packageLockDigest: digest("f") },
    user: expectedUser,
    session: expectedSession,
  });
  await assert.rejects(
    runProxmoxDesktopOperationV1(value, altered, context(value)),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "DESKTOP_IDENTITY_MISMATCH" &&
      error.details?.quarantineReceipt?.quarantined === true,
  );
  assert.equal(altered.calls.filter(([method]) => method === "quarantineVm").length, 1);
});

test("production run deadline bounds QGA work and rejects expired create/start before provider access", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const deadlineAt = "2026-08-20T12:05:00.000Z";
  const value = request("create");
  value.lease.expiresAt = "2026-08-20T12:30:00.000Z";
  const adapter = new OfflineProxmoxFixture();
  let waitInput = null;
  adapter.waitForQga = async (input) => {
    waitInput = structuredClone(input);
    return { ready: true, credentialBoundary: credentialBoundary(value), installedDesktopIdentity: installedDesktopIdentity(), user: input.expectedUser, session: input.expectedSession };
  };
  const result = await runProxmoxDesktopOperationV1(value, adapter, { ...context(value), now, runDeadlineAt: deadlineAt });
  assert.equal(result.created, true);
  assert.equal(waitInput.deadlineAt, Date.parse(deadlineAt));
  assert.equal(waitInput.hardDeadlineAt, Date.parse(value.lease.expiresAt));

  for (const operation of ["create", "start"]) {
    const expired = request(operation);
    expired.lease.expiresAt = "2026-08-20T12:30:00.000Z";
    const untouched = new OfflineProxmoxFixture({ present: operation === "start" });
    await assert.rejects(
      runProxmoxDesktopOperationV1(expired, untouched, { ...context(expired), now, runDeadlineAt: "2026-08-20T12:00:00.000Z" }),
      (error) => error instanceof ProxmoxDesktopBackendError && error.code === "RUN_DEADLINE_EXPIRED" && error.path === "/runDeadlineAt",
    );
    assert.deepEqual(untouched.calls, []);
  }
});

test("a run deadline crossed by start permits only exact quarantine and never begins QGA work", async () => {
  let clockNow = Date.parse("2026-08-20T12:00:00.000Z");
  const deadlineAt = "2026-08-20T12:05:00.000Z";
  const value = request("start");
  value.lease.expiresAt = "2026-08-20T12:30:00.000Z";
  const adapter = new OfflineProxmoxFixture({ present: true });
  const originalStart = adapter.startVm.bind(adapter);
  adapter.startVm = async (input) => {
    const result = await originalStart(input);
    clockNow = Date.parse(deadlineAt);
    return result;
  };
  await assert.rejects(
    runProxmoxDesktopOperationV1(value, adapter, { ...context(value), now: () => clockNow, runDeadlineAt: deadlineAt }),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "RUN_DEADLINE_EXPIRED" &&
      error.details?.quarantineReceipt?.quarantined === true &&
      error.details.quarantineReceipt.reconciliation.operationId === value.operationId,
  );
  assert.equal(adapter.calls.some(([method]) => method === "waitForQga"), false);
  assert.deepEqual(adapter.calls.filter(([method]) => ["startVm", "cloneVm", "configureVm", "quarantineVm"].includes(method)), [
    ["startVm"],
    ["quarantineVm", "run-deadline-expired"],
  ]);
  assert.equal(adapter.receipts.at(-1)?.operation, "quarantine");
  assert.equal(adapter.vm?.quarantined, true);
});

test("stale fencing and identity mismatch fail before any provider mutation", async () => {
  const value = request("start");
  const adapter = new OfflineProxmoxFixture({ present: true });
  const stale = structuredClone(value.lease);
  stale.fencingToken = "fence-0008";
  await assert.rejects(
    runProxmoxDesktopOperationV1(value, adapter, { ownership: value.provider, currentLease: stale }),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "STALE_FENCING_TOKEN",
  );
  assert.ok(adapter.calls.every(([method]) => method === "inspectVm"));

  const mismatched = structuredClone(value);
  mismatched.provider.vmId = "9052";
  assert.throws(
    () => admitProxmoxDesktopOperationV1(mismatched, {
      ownership: value.provider,
      currentLease: value.lease,
      inventory: inventoryOf(value),
    }),
    (error) => error.code === "IDENTITY_MISMATCH",
  );
});

test("an internally consistent alternate prox2 gateway fails before provider inspection or mutation", async () => {
  const value = request("create");
  value.provider.gatewayId = "9024";
  value.reservation.gatewayId = "9024";
  const adapter = new OfflineProxmoxFixture();
  await assert.rejects(
    runProxmoxDesktopOperationV1(value, adapter, {
      ownership: structuredClone(value.provider),
      currentLease: structuredClone(value.lease),
    }),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "INVALID_IDENTITY" && error.path === "/provider/gatewayId",
  );
  assert.deepEqual(adapter.calls, []);
});

test("an internally consistent alternate prox2 VNet fails before provider inspection or mutation", async () => {
  const value = request("create");
  value.provider.networkId = "caller-selected";
  value.reservation.networkId = "caller-selected";
  const adapter = new OfflineProxmoxFixture();
  await assert.rejects(
    runProxmoxDesktopOperationV1(value, adapter, {
      ownership: structuredClone(value.provider),
      currentLease: structuredClone(value.lease),
    }),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "INVALID_IDENTITY" && error.path === "/provider/networkId",
  );
  assert.deepEqual(adapter.calls, []);
});

test("cleanup-only authority permits exact cleanup after active expiry but never start", async () => {
  const now = Date.parse("2026-08-20T12:10:00.000Z");
  const cleanupLease = {
    ...request().lease,
    state: "cleanup-only",
    expiresAt: "2026-08-20T12:20:00.000Z",
  };
  const stop = request("stop");
  stop.lease.expiresAt = "2026-08-20T12:05:00.000Z";
  const adapter = new OfflineProxmoxFixture({ present: true });
  const stopped = await runProxmoxDesktopOperationV1(stop, adapter, {
    ownership: stop.provider,
    currentLease: cleanupLease,
    now,
  });
  assert.equal(stopped.operation, "stop");
  assert.equal(adapter.calls.filter(([method]) => method === "stopVm").length, 1);

  const start = request("start");
  start.lease.expiresAt = stop.lease.expiresAt;
  const noStart = new OfflineProxmoxFixture({ present: true });
  await assert.rejects(
    runProxmoxDesktopOperationV1(start, noStart, { ownership: start.provider, currentLease: cleanupLease, now }),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "STALE_FENCING_TOKEN",
  );
  assert.equal(noStart.calls.some(([method]) => method === "startVm"), false);

  const expiredCleanup = { ...cleanupLease, expiresAt: "2026-08-20T12:10:00.000Z" };
  const noCleanup = new OfflineProxmoxFixture({ present: true });
  await assert.rejects(
    runProxmoxDesktopOperationV1(stop, noCleanup, { ownership: stop.provider, currentLease: expiredCleanup, now }),
    (error) => error instanceof ProxmoxDesktopBackendError && error.code === "STALE_FENCING_TOKEN",
  );
  assert.equal(noCleanup.calls.some(([method]) => method === "stopVm"), false);
});

test("unreserved and conflicting VMIDs are rejected before clone mutation", async () => {
  const value = request("create");
  const unreserved = structuredClone(value);
  unreserved.reservation.state = "released";
  assert.throws(
    () => admitProxmoxDesktopOperationV1(unreserved, { ownership: value.provider, currentLease: value.lease, inventory: null }),
    (error) => error.code === "UNRESERVED_VMID",
  );
  assert.throws(
    () => admitProxmoxDesktopOperationV1(value, { ownership: value.provider, currentLease: value.lease, inventory: inventoryOf(value) }),
    (error) => error.code === "VMID_CONFLICT",
  );
});

test("ambiguous clone is reconciled once and never blindly retried", async () => {
  const value = request("create");
  const adapter = new OfflineProxmoxFixture({ ambiguous: "cloneVm" });
  const result = await runProxmoxDesktopOperationV1(value, adapter, context(value));
  assert.equal(result.created, true);
  assert.equal(adapter.calls.filter(([method]) => method === "cloneVm").length, 1);
  assert.deepEqual(adapter.calls.find(([method]) => method === "reconcileMutation"), ["reconcileMutation", "clone", "upid-cloneVm"]);
});

test("QGA readiness failure produces an identity-preserving quarantine receipt", async () => {
  const value = request("create");
  const adapter = new OfflineProxmoxFixture({ qgaReady: false });
  await assert.rejects(
    runProxmoxDesktopOperationV1(value, adapter, context(value)),
    (error) => {
      assert.equal(error.code, "QGA_NOT_READY");
      assert.equal(error.details.quarantineReceipt.quarantined, true);
      assert.equal(error.details.quarantineReceipt.reconciliation.operationId, value.operationId);
      assert.equal(error.details.quarantineReceipt.fencingToken, value.lease.fencingToken);
      return true;
    },
  );
  assert.equal(adapter.receipts.at(-1).operation, "quarantine");
});

test("destroy succeeds only with exact absence and yields a remote-contract-compatible receipt", async () => {
  const value = request("destroy");
  const adapter = new OfflineProxmoxFixture({ present: true, exactAbsence: true });
  const destroyed = await runProxmoxDesktopOperationV1(value, adapter, context(value));
  assert.equal(destroyed.destroyed, true);
  assert.equal(destroyed.mutationStatus, "committed");

  const run = validRemoteDesktopRunV1();
  run.runId = value.runId;
  run.provider = structuredClone(value.provider);
  run.lease.leaseId = value.lease.leaseId;
  run.lease.fencingToken = value.lease.fencingToken;
  validateRemoteDesktopTerminalOutcomeV1({
    schemaVersion: 1,
    runId: run.runId,
    outcome: "destroyed",
    ownedVm: structuredClone(run.provider),
    leaseId: run.lease.leaseId,
    fencingToken: run.lease.fencingToken,
    receipt: destroyed,
  }, run);
});

test("inexact destruction emits quarantine with preserved reconciliation identities", async () => {
  const value = request("destroy");
  const adapter = new OfflineProxmoxFixture({ present: true, exactAbsence: false });
  const result = await runProxmoxDesktopOperationV1(value, adapter, context(value));
  assert.equal(result.quarantined, true);
  assert.equal(result.reconciliation.operationId, value.operationId);
  assert.deepEqual(
    Object.fromEntries(["providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken"].map((key) => [key, result.reconciliation[key]])),
    { ...value.provider, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken },
  );
});

test("QGA controls include a command-free installed-identity operation and guest-exec has a fixed executable allowlist", async () => {
  const adapter = new OfflineProxmoxFixture();
  const binding = { ...request().provider, leaseId: request().lease.leaseId, fencingToken: request().lease.fencingToken };
  const result = await executeProxmoxQgaControlV1({ control: "guest-exec", binding, command: "/usr/libexec/nelos-device-auth", arguments: ["status"] }, adapter);
  assert.equal(result.status, "ok");
  let exactIdentityCall;
  const installedIdentity = await executeProxmoxQgaControlV1({ control: "installed-desktop-identity", binding }, {
    async qgaControl(value) { exactIdentityCall = value; return { status: "ok" }; },
  });
  assert.equal(installedIdentity.status, "ok");
  assert.deepEqual(exactIdentityCall, {
    arguments: [], binding, command: "/usr/libexec/nelos-desktop-identity", control: "guest-exec",
  });
  await assert.rejects(
    executeProxmoxQgaControlV1({ control: "installed-desktop-identity", binding, command: "/tmp/caller-selected", arguments: [] }, adapter),
    (error) => error.code === "INVALID_CONTRACT",
  );
  await assert.rejects(
    executeProxmoxQgaControlV1({ control: "guest-exec", binding, command: "/bin/sh", arguments: ["-c", "id"] }, adapter),
    (error) => error.code === "QGA_CONTROL_DENIED",
  );
});

test("concrete Proxmox adapter maps lifecycle calls through an injected offline transport", async () => {
  const calls = [];
  const taskStates = [
    { data: { status: "running" } },
    { data: { status: "stopped", exitstatus: "OK" } },
  ];
  const transport = {
    async request(call) {
      calls.push(structuredClone(call));
      if (call.path.endsWith("/clone")) return { data: "UPID:node:clone:1" };
      if (call.path.includes("/tasks/")) return taskStates.shift();
      if (call.path.endsWith("/config")) {
        const error = new Error("not found");
        error.status = 404;
        throw error;
      }
      if (call.path === "/cluster/resources?type=vm") return { data: [] };
      if (call.path === "/nelos/network/mac-absence") return { data: { absent: true, complete: true, kind: "nelos.proxmox-desktop.mac-absence.v1", macAddress: "02:4E:45:4C:90:51", networkId: "nelosbld", scannedQemuCount: 0, schemaVersion: 1 } };
      return { data: {} };
    },
  };
  const receiptStore = { async commit(value) { return { committed: true, receiptId: value.receiptId, attestationDigest: value.attestationDigest }; } };
  const adapter = new ProxmoxVeDesktopAdapterV1({ transport, receiptStore, providerId: "proxmox-lab", taskPollMs: 1, wait: async () => {} });
  const value = request("create");
  const binding = { ...value.provider, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken };
  const clone = await adapter.cloneVm({
    binding,
    goldenImage: value.goldenImage,
    configuration: { cloneMode: "linked" },
  });
  assert.equal(clone.status, "committed");
  assert.equal(calls.filter(({ path }) => path.includes("/tasks/")).length, 2);
  assert.equal(calls[0].path, "/nodes/prox2/qemu/9001/clone");
  assert.equal(calls[0].body.newid, 9051);
  assert.equal(calls[0].body.full, 0);
  assert.doesNotMatch(JSON.stringify(calls[0].body), /password|credential|authorized_keys/iu);
  assert.deepEqual(await adapter.attestVmAbsent(binding), { ...binding, absent: true, macAbsent: true, networkInventoryComplete: true });
});

test("golden-image inspection reads only the pinned template and excludes volatile Proxmox digests", async () => {
  const calls = [];
  const adapter = new ProxmoxVeDesktopAdapterV1({
    providerId: "proxmox-lab",
    receiptStore: { async commit() { throw new Error("not used"); } },
    transport: { async request(call) {
      calls.push(structuredClone(call));
      if (call.path === "/nodes/prox2/qemu/9001/config") {
        return { data: { digest: "volatile-proxmox-config-digest", memory: 8192, name: "sealed-desktop-golden", template: 1 } };
      }
      if (call.path === "/nodes/prox2/qemu/9001/status/current") return { data: { status: "stopped" } };
      throw new Error(`unexpected golden-image read ${call.path}`);
    } },
  });

  assert.deepEqual(await adapter.inspectGoldenImage({ hostId: "prox2", templateVmId: "9001" }), {
    providerId: "proxmox-lab",
    hostId: "prox2",
    templateVmId: "9001",
    config: { memory: 8192, name: "sealed-desktop-golden", template: 1 },
    status: "stopped",
    template: true,
  });
  assert.deepEqual(calls, [
    { method: "GET", path: "/nodes/prox2/qemu/9001/config" },
    { method: "GET", path: "/nodes/prox2/qemu/9001/status/current" },
  ]);
});

test("concrete adapter drives explicit isolated device auth through captured QGA output", async () => {
  const calls = []; const outputs = new Map(); let nextPid = 1; let challenge = "";
  const encodeOutput = (value) => Buffer.from(value === null ? "" : `${JSON.stringify(value)}\n`).toString("base64");
  const transport = { async request(call) {
    calls.push(structuredClone(call));
    if (call.path.endsWith("/agent/ping")) return { data: {} };
    if (call.path.endsWith("/agent/get-users")) return { data: [{ user: "nelosauto" }] };
    if (call.path.endsWith("/agent/exec")) {
      const pid = nextPid++;
      if (call.body.command === "/usr/libexec/nelos-bind-runtime") outputs.set(pid, null);
      else if (call.body.command === "/usr/libexec/nelos-credential-boundary") outputs.set(pid, credentialBoundary(value));
      else if (call.body.command === "/usr/libexec/nelos-desktop-identity") outputs.set(pid, installedDesktopIdentity());
      else if (call.body.command === "/usr/libexec/nelos-device-auth" && call.body["extra-args"][0] === "start") outputs.set(pid, { status: "authorization_required", type: "chatgptDeviceCode", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/device" });
      else if (call.body.command === "/usr/libexec/nelos-device-auth" && call.body["extra-args"][0] === "status") outputs.set(pid, { status: "authenticated", authenticated: true, accountType: "chatgpt", credentialStore: "file" });
      else throw new Error("unexpected guest executable");
      return { data: { pid } };
    }
    if (call.path.includes("/agent/exec-status?pid=")) {
      const pid = Number(new URL(call.path, "https://proxmox.invalid").searchParams.get("pid"));
      return { data: { exited: true, exitcode: 0, "out-data": encodeOutput(outputs.get(pid)) } };
    }
    throw new Error(`unexpected provider call ${call.path}`);
  } };
  const value = request("create");
  const binding = { ...value.provider, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken };
  const runtimeBinding = { ...binding, imageId: value.goldenImage.imageId, runId: value.runId, automationUser: value.automation.user, stateRoot: value.automation.stateRoot };
  const adapter = new ProxmoxVeDesktopAdapterV1({
    transport, receiptStore: { async commit() { throw new Error("not used"); } }, providerId: value.provider.providerId,
    qgaAttempts: 2, authAttempts: 2, taskPollMs: 1, wait: async () => {}, authChallengeSink: (text) => { challenge += text; },
  });
  assert.deepEqual(await adapter.waitForQga({ binding, runtimeBinding, expectedUser: "nelosauto", expectedSession: "graphical" }), { ready: true, credentialBoundary: credentialBoundary(value), installedDesktopIdentity: installedDesktopIdentity(), user: "nelosauto", session: "graphical" });
  const guestExecs = calls.filter(({ path }) => path.endsWith("/agent/exec")).map(({ body }) => body);
  assert.deepEqual(guestExecs.map((body) => [body.command, body["extra-args"], body["capture-output"]]), [
    ["/usr/libexec/nelos-bind-runtime", [Buffer.from(JSON.stringify(runtimeBinding)).toString("base64")], 1],
    ["/usr/libexec/nelos-credential-boundary", ["prepare"], 1],
    ["/usr/libexec/nelos-desktop-identity", [], 1],
    ["/usr/libexec/nelos-device-auth", ["start"], 1],
    ["/usr/libexec/nelos-device-auth", ["status"], 1],
  ]);
  assert.match(challenge, /https:\/\/auth\.openai\.com\/device/u);
  assert.match(challenge, /ABCD-EFGH/u);
  assert.doesNotMatch(challenge, /loginId|email|token/u);
});

test("device auth timeout cancels exactly once and never restarts the paid/live admission phase", async () => {
  const calls = []; const outputs = new Map(); let nextPid = 1;
  const encodeOutput = (value) => Buffer.from(value === null ? "" : `${JSON.stringify(value)}\n`).toString("base64");
  const transport = { async request(call) {
    calls.push(structuredClone(call));
    if (call.path.endsWith("/agent/ping")) return { data: {} };
    if (call.path.endsWith("/agent/exec")) {
      const pid = nextPid++;
      const [operation] = call.body["extra-args"];
      if (call.body.command === "/usr/libexec/nelos-bind-runtime") outputs.set(pid, null);
      else if (call.body.command === "/usr/libexec/nelos-credential-boundary") outputs.set(pid, credentialBoundary(value));
      else if (call.body.command === "/usr/libexec/nelos-desktop-identity") outputs.set(pid, installedDesktopIdentity());
      else if (operation === "start") outputs.set(pid, { status: "authorization_required", type: "chatgptDeviceCode", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/device" });
      else if (operation === "status") outputs.set(pid, { status: "pending", authenticated: false, accountType: null, credentialStore: "file" });
      else if (operation === "cancel") outputs.set(pid, { status: "cancelled" });
      else throw new Error("unexpected guest executable");
      return { data: { pid } };
    }
    if (call.path.includes("/agent/exec-status?pid=")) {
      const pid = Number(new URL(call.path, "https://proxmox.invalid").searchParams.get("pid"));
      return { data: { exited: true, exitcode: 0, "out-data": encodeOutput(outputs.get(pid)) } };
    }
    throw new Error(`unexpected provider call ${call.path}`);
  } };
  const value = request("create");
  const binding = { ...value.provider, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken };
  const runtimeBinding = { ...binding, imageId: value.goldenImage.imageId, runId: value.runId, automationUser: value.automation.user, stateRoot: value.automation.stateRoot };
  const adapter = new ProxmoxVeDesktopAdapterV1({
    transport, receiptStore: { async commit() { throw new Error("not used"); } }, providerId: value.provider.providerId,
    qgaAttempts: 1, authAttempts: 2, taskPollMs: 1, wait: async () => {}, authChallengeSink: () => {},
  });
  assert.deepEqual(await adapter.waitForQga({ binding, runtimeBinding, expectedUser: "nelosauto", expectedSession: "graphical" }), {
    ready: false, errorCode: "DEVICE_AUTH_TIMEOUT", user: null, session: null,
  });
  const operations = calls
    .filter(({ path, body }) => path.endsWith("/agent/exec") && body.command === "/usr/libexec/nelos-device-auth")
    .map(({ body }) => body["extra-args"][0]);
  assert.deepEqual(operations, ["start", "status", "status", "cancel"]);
});

test("device auth stops at the cleanup margin and issues only a bounded cancellation afterward", async () => {
  let now = 1_000;
  const calls = [];
  const outputs = new Map();
  let nextPid = 1;
  const encodeOutput = (value) => Buffer.from(value === null ? "" : `${JSON.stringify(value)}\n`).toString("base64");
  const transport = { async request(call) {
    calls.push({ at: now, call: structuredClone(call) });
    if (call.path.endsWith("/agent/ping")) return { data: {} };
    if (call.path.endsWith("/agent/exec")) {
      const pid = nextPid++;
      const [operation] = call.body["extra-args"];
      if (call.body.command === "/usr/libexec/nelos-bind-runtime") outputs.set(pid, null);
      else if (call.body.command === "/usr/libexec/nelos-credential-boundary") outputs.set(pid, credentialBoundary(value));
      else if (call.body.command === "/usr/libexec/nelos-desktop-identity") outputs.set(pid, installedDesktopIdentity());
      else if (operation === "start") outputs.set(pid, { status: "authorization_required", type: "chatgptDeviceCode", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/device" });
      else if (operation === "status") outputs.set(pid, { status: "pending", authenticated: false, accountType: null, credentialStore: "file" });
      else if (operation === "cancel") outputs.set(pid, { status: "cancelled" });
      else throw new Error("unexpected guest executable");
      return { data: { pid } };
    }
    if (call.path.includes("/agent/exec-status?pid=")) {
      const pid = Number(new URL(call.path, "https://proxmox.invalid").searchParams.get("pid"));
      return { data: { exited: true, exitcode: 0, "out-data": encodeOutput(outputs.get(pid)) } };
    }
    throw new Error(`unexpected provider call ${call.path}`);
  } };
  const value = request("create");
  const binding = { ...value.provider, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken };
  const runtimeBinding = { ...binding, imageId: value.goldenImage.imageId, runId: value.runId, automationUser: value.automation.user, stateRoot: value.automation.stateRoot };
  const operationalDeadline = 5_000;
  const hardDeadline = 10_000;
  const adapter = new ProxmoxVeDesktopAdapterV1({
    transport,
    receiptStore: { async commit() { throw new Error("not used"); } },
    providerId: value.provider.providerId,
    qgaAttempts: 1,
    authAttempts: 5,
    taskPollMs: 2_000,
    wait: async (milliseconds) => { now += milliseconds; },
    authChallengeSink: () => {},
    clock: { now: () => now },
  });

  assert.deepEqual(await adapter.waitForQga({
    binding,
    runtimeBinding,
    expectedUser: "nelosauto",
    expectedSession: "graphical",
    deadlineAt: operationalDeadline,
    hardDeadlineAt: hardDeadline,
  }), { ready: false, errorCode: "QGA_DEADLINE_EXPIRED", user: null, session: null });

  const authCalls = calls
    .filter(({ call }) => call.path.endsWith("/agent/exec") && call.body.command === "/usr/libexec/nelos-device-auth")
    .map(({ at, call }) => ({ at, operation: call.body["extra-args"][0] }));
  assert.deepEqual(authCalls, [
    { at: 1_000, operation: "start" },
    { at: 1_000, operation: "status" },
    { at: 3_000, operation: "status" },
    { at: 5_000, operation: "cancel" },
  ]);
  assert.ok(calls.every(({ at }) => at < hardDeadline));
  assert.ok(calls
    .filter(({ at }) => at >= operationalDeadline)
    .every(({ call }) => call.path.endsWith("/agent/exec") && call.body.command === "/usr/libexec/nelos-device-auth" || call.path.includes("/agent/exec-status?pid=")));
  assert.ok(calls.every(({ call }) => !call.path.endsWith("/agent/get-users")));
});

test("missing provider task IDs reconcile only from exact mutation-specific state", async () => {
  const value = request("create");
  const binding = { ...value.provider, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken };
  const description = (extra) => `nelos-desktop-v1:${Buffer.from(JSON.stringify({ ...binding, ...extra })).toString("base64url")}`;
  let currentConfig = { description: description({ imageId: value.goldenImage.imageId, state: "created" }) };
  let powerState = "stopped";
  const adapter = new ProxmoxVeDesktopAdapterV1({
    providerId: value.provider.providerId,
    receiptStore: { async commit() { throw new Error("not used"); } },
    transport: { async request({ path }) {
      if (path.endsWith("/config")) {
        if (currentConfig === null) throw Object.assign(new Error("not found"), { status: 404 });
        return { data: structuredClone(currentConfig) };
      }
      if (path.endsWith("/status/current")) return { data: { status: powerState } };
      throw new Error(`unexpected provider read ${path}`);
    } },
  });
  const configured = {
    automationUser: value.automation.user,
    imageId: value.goldenImage.imageId,
    macAddress: value.provider.macAddress,
    networkId: value.provider.networkId,
    runId: value.runId,
    state: "configured",
    stateRoot: value.automation.stateRoot,
  };
  assert.deepEqual(await adapter.reconcileMutation({ binding, mutation: "configure", providerOperationId: null, expected: configured }), { status: "ambiguous", providerOperationId: null });
  currentConfig = {
    agent: "enabled=1,fstrim_cloned_disks=1", ciuser: value.automation.user,
    description: description(configured), onboot: 0, protection: 0,
    net0: `virtio=${value.provider.macAddress},bridge=${value.provider.networkId},firewall=1`,
    tags: "nelos-desktop;disposable;automation-only",
  };
  assert.deepEqual(await adapter.reconcileMutation({ binding, mutation: "configure", providerOperationId: null, expected: configured }), { status: "committed", providerOperationId: null });
  assert.deepEqual(await adapter.reconcileMutation({ binding, mutation: "start", providerOperationId: null, expected: { state: "running" } }), { status: "ambiguous", providerOperationId: null });
  powerState = "running";
  assert.deepEqual(await adapter.reconcileMutation({ binding, mutation: "start", providerOperationId: null, expected: { state: "running" } }), { status: "committed", providerOperationId: null });

  const quarantineExpected = { imageId: value.goldenImage.imageId, reason: "bounded-test", state: "quarantined" };
  currentConfig = {
    description: description({ ...quarantineExpected, quarantined: true }),
    net0: `virtio=${value.provider.macAddress},bridge=${value.provider.networkId},link_down=1,firewall=1`,
    onboot: 0, protection: 1, tags: "nelos-desktop;quarantined;do-not-reuse",
  };
  powerState = "stopped";
  assert.deepEqual(await adapter.reconcileMutation({ binding, mutation: "quarantine", providerOperationId: null, expected: quarantineExpected }), { status: "committed", providerOperationId: null });
  currentConfig.description = description({ ...quarantineExpected, imageId: "preserved", quarantined: true });
  assert.deepEqual(await adapter.reconcileMutation({ binding, mutation: "quarantine", providerOperationId: null, expected: quarantineExpected }), { status: "ambiguous", providerOperationId: null });

  currentConfig = null;
  assert.deepEqual(await adapter.reconcileMutation({ binding, mutation: "destroy", providerOperationId: null, expected: { state: "absent" } }), { status: "committed", providerOperationId: null });
});

test("concrete adapter preserves non-not-found failures and bounds nonterminal Proxmox tasks", async () => {
  const receiptStore = { async commit() { throw new Error("not reached"); } };
  const denied = new ProxmoxVeDesktopAdapterV1({
    providerId: "proxmox-lab", receiptStore,
    transport: { async request() { throw Object.assign(new Error("denied"), { status: 403 }); } },
  });
  await assert.rejects(denied.inspectVm(request().provider), /denied/u);

  let observations = 0;
  const timed = new ProxmoxVeDesktopAdapterV1({
    providerId: "proxmox-lab", receiptStore, taskAttempts: 3, taskPollMs: 1, wait: async () => {},
    transport: { async request({ path }) {
      if (path.endsWith("/status/start")) return { data: "UPID:node:start:bounded" };
      observations += 1;
      return { data: { status: "running" } };
    } },
  });
  const value = request("start");
  const binding = { ...value.provider, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken };
  assert.deepEqual(await timed.startVm({ binding }), { status: "timed_out", providerOperationId: "UPID:node:start:bounded" });
  assert.equal(observations, 3);
});
