import assert from "node:assert/strict";
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

function request(operation = "create") {
  return {
    schemaVersion: 1,
    operationId: `op-${operation}-001`,
    operation,
    runId: "desktop-run-001",
    provider: { providerId: "proxmox-lab", hostId: "pve-node-01", vmId: "9051" },
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
      hostId: "pve-node-01",
      vmId: "9051",
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
  constructor({ present = false, ambiguous = null, qgaReady = true, exactAbsence = true } = {}) {
    this.calls = [];
    this.vm = present ? inventoryOf(request("start"), "stopped") : null;
    this.ambiguous = ambiguous;
    this.qgaReady = qgaReady;
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
    return this.result("configureVm", "configured");
  }

  async startVm() { return this.result("startVm", "running"); }
  async stopVm() { return this.result("stopVm", "stopped"); }
  async destroyVm() { return this.result("destroyVm", null); }

  async quarantineVm({ reason }) {
    this.calls.push(["quarantineVm", reason]);
    this.vm = { ...inventoryOf(request(), "quarantined"), quarantined: true };
    return { status: "committed", providerOperationId: "upid-quarantine" };
  }

  async waitForQga({ expectedUser, expectedSession }) {
    this.calls.push(["waitForQga", expectedUser, expectedSession]);
    return this.qgaReady
      ? { ready: true, user: expectedUser, session: expectedSession }
      : { ready: false, user: null, session: null };
  }

  async attestVmAbsent(binding) {
    this.calls.push(["attestVmAbsent", binding.vmId]);
    return this.exactAbsence ? { ...binding, absent: true } : { ...binding, absent: false };
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
  assert.equal(lock.artifacts.chatgptDesktop.bundledCodexVersion, "0.148.0-alpha.15");
  assert.equal(lock.artifacts.chatgptDesktop.signatureIdentity.fingerprint, "3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4");

  const recipe = await readFile(new URL("../validation/proxmox-desktop/v1/provision-golden-image.sh", import.meta.url), "utf8");
  assert.match(recipe, /getent passwd nelosauto.*die/u);
  assert.match(recipe, /qemu-guest-agent\.service gdm3\.service/u);
  assert.match(recipe, /graphical\.target/u);
  assert.match(recipe, /debsig-verify --policies-dir/u);
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
  mismatched.provider.hostId = "pve-node-02";
  assert.throws(
    () => admitProxmoxDesktopOperationV1(mismatched, {
      ownership: value.provider,
      currentLease: value.lease,
      inventory: inventoryOf(value),
    }),
    (error) => error.code === "IDENTITY_MISMATCH",
  );
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
    Object.fromEntries(["providerId", "hostId", "vmId", "leaseId", "fencingToken"].map((key) => [key, result.reconciliation[key]])),
    { ...value.provider, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken },
  );
});

test("QGA controls are closed and guest-exec has a fixed executable allowlist", async () => {
  const adapter = new OfflineProxmoxFixture();
  const binding = { ...request().provider, leaseId: request().lease.leaseId, fencingToken: request().lease.fencingToken };
  const result = await executeProxmoxQgaControlV1({ control: "guest-exec", binding, command: "/usr/bin/loginctl", arguments: ["show-session"] }, adapter);
  assert.equal(result.status, "ok");
  await assert.rejects(
    executeProxmoxQgaControlV1({ control: "guest-exec", binding, command: "/bin/sh", arguments: ["-c", "id"] }, adapter),
    (error) => error.code === "QGA_CONTROL_DENIED",
  );
});

test("concrete Proxmox adapter maps lifecycle calls through an injected offline transport", async () => {
  const calls = [];
  const transport = {
    async request(call) {
      calls.push(structuredClone(call));
      if (call.path.endsWith("/clone")) return { data: "UPID:node:clone:1" };
      if (call.path.includes("/tasks/")) return { data: { status: "stopped", exitstatus: "OK" } };
      if (call.path.endsWith("/config")) {
        const error = new Error("not found");
        error.status = 404;
        throw error;
      }
      if (call.path === "/cluster/resources?type=vm") return { data: [] };
      return { data: {} };
    },
  };
  const receiptStore = { async commit(value) { return { committed: true, receiptId: value.receiptId, attestationDigest: value.attestationDigest }; } };
  const adapter = new ProxmoxVeDesktopAdapterV1({ transport, receiptStore, providerId: "proxmox-lab" });
  const value = request("create");
  const binding = { ...value.provider, leaseId: value.lease.leaseId, fencingToken: value.lease.fencingToken };
  const clone = await adapter.cloneVm({
    binding,
    goldenImage: value.goldenImage,
    configuration: { cloneMode: "linked" },
  });
  assert.equal(clone.status, "committed");
  assert.equal(calls[0].path, "/nodes/pve-node-01/qemu/9001/clone");
  assert.equal(calls[0].body.newid, 9051);
  assert.equal(calls[0].body.full, 0);
  assert.doesNotMatch(JSON.stringify(calls[0].body), /password|credential|authorized_keys/iu);
  assert.deepEqual(await adapter.attestVmAbsent(binding), { ...binding, absent: true });
});
