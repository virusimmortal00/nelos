import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { sha256V1 } from "../validation/proxmox-desktop/v1/build-golden-image.mjs";
import { createGoldenBuilderLifecycleBindingV1 } from "../validation/proxmox-desktop/v1/prepare-golden-builder.mjs";
import { runDisposableGoldenBuilderV1 } from "../validation/proxmox-desktop/v1/golden-builder-lifecycle.mjs";
import {
  activateGoldenBuilderGatewayPolicyV1,
  createGoldenBuilderGatewayPolicyBindingV1,
  GoldenBuilderGatewayPolicyAdapterV1,
  runGatewayProtectedGoldenBuilderV1,
  validateGoldenBuilderGatewayPolicyBindingV1,
} from "../validation/proxmox-desktop/v1/golden-builder-gateway-policy.mjs";

const NOW = Date.parse("2026-08-20T16:00:00.000Z");
const PROVIDER_FP = `SHA256:${"P".repeat(43)}`;
const ATTESTOR_FP = `SHA256:${"A".repeat(43)}`;

function reservation() {
  const config = { name: "nelos-ubuntu-24-04-source", template: 1, scsi0: "local-lvm:base-9024-disk-0,size=64G", efidisk0: "local-lvm:base-9024-disk-1,efitype=4m,size=4M" };
  return {
    schemaVersion: 2, reservationId: "gateway-test", providerId: "proxmox-lab", apiUrl: "https://192.168.1.110:8006/api2/json",
    tlsCaDigest: "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d", node: "prox2", storage: "local-lvm",
    networkAclPath: "/sdn/zones/nelosbld/nelosbld", sourceCommit: "a".repeat(40), buildNonce: "c".repeat(32),
    buildTokenId: "nelosgoldbuild@pve!build-cccccccccccc", attestorTokenId: "nelosgoldattest@pve!attest-cccccccccccc",
    expiresAt: new Date(NOW + 3_600_000).toISOString(), cleanupExpiresAt: new Date(NOW + 7_200_000).toISOString(), maxBuildMs: 300_000,
    sourceArtifact: { name: "ubuntu-24.04-server-cloudimg-amd64.img", digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe", signatureScheme: "openpgp-detached-sha256sums", signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092" },
    volumeAttestor: { helperDigest: `sha256:${"1".repeat(64)}`, hostKeyFingerprint: `SHA256:${"H".repeat(43)}`, identityFingerprint: `SHA256:${"I".repeat(43)}`, sshHost: "192.168.1.110", sshPort: 22, sshUser: "nelosmeasure" },
    sourceTemplate: { vmId: 9024, name: "nelos-ubuntu-24-04-source", configDigest: sha256V1(config), volumeMeasurementDigest: `sha256:${"3".repeat(64)}` },
    outputTemplate: { vmId: 9027, name: "nelos-desktop-ubuntu-24-04-v1", macAddress: "02:4E:45:4C:90:27" },
  };
}

function destinations() {
  return [
    { host: "persistent.oaistatic.com", addresses: ["104.18.1.10", "104.18.2.10"], resolvedAt: new Date(NOW).toISOString(), ttlSeconds: 300, expiresAt: new Date(NOW + 300_000).toISOString() },
    { host: "snapshot.ubuntu.com", addresses: ["185.125.190.36"], resolvedAt: new Date(NOW).toISOString(), ttlSeconds: 300, expiresAt: new Date(NOW + 300_000).toISOString() },
  ];
}

function binding() {
  const value = reservation();
  return { reservation: value, binding: createGoldenBuilderGatewayPolicyBindingV1({
    reservation: value, originalRulesetDigest: `sha256:${"4".repeat(64)}`, helperDigest: `sha256:${"5".repeat(64)}`, gatewayConfigDigest: `sha256:${"8".repeat(64)}`, destinations: destinations(),
  }, { now: NOW }) };
}

function receipt(request, payload, { status = "observed", providerOperationId = null } = {}) {
  const unsigned = {
    schemaVersion: 1, kind: "nelos-golden-builder-gateway-receipt", role: request.role, operation: request.operation,
    operationId: request.operationId, bindingDigest: request.binding.bindingDigest, status, providerOperationId,
    observedAt: new Date(NOW).toISOString(), payload, payloadDigest: sha256V1(payload),
  };
  return { ...unsigned, receiptDigest: sha256V1(unsigned) };
}

function preflight(value) {
  return { approvedSetEmpty: true, forwardPolicy: "drop", gatewayVmId: 9023, helperDigest: value.helper.digest, rulesetDigest: value.originalRulesetDigest, unexpectedForwardAccepts: 0 };
}

function active(value) {
  return { active: true, allowedHttpsAddresses: value.httpsAllow.destinations.flatMap(({ addresses }) => addresses).sort(), apiAddress: "192.168.1.110", apiPort: 8006, marker: `nelos-golden:${value.bindingDigest.slice(7, 23)}`, rulesetDigest: `sha256:${"6".repeat(64)}` };
}

function restored(value, independent = false) {
  return { restored: true, rulesetDigest: value.originalRulesetDigest, ...(independent ? { independentInventoryDigest: `sha256:${"7".repeat(64)}` } : {}) };
}

function transports(value, behavior = {}) {
  const calls = []; let state = "original";
  const providerTransport = {
    identityFingerprint: PROVIDER_FP,
    async invoke(request) {
      calls.push({ role: "provider", operation: request.operation, operationId: request.operationId });
      if (behavior.provider) return behavior.provider({ request, calls, get state() { return state; }, set state(next) { state = next; } });
      if (request.operation === "preflight") return receipt(request, preflight(value));
      if (request.operation === "apply") { state = "active"; return receipt(request, active(value), { status: "committed", providerOperationId: "nft:apply" }); }
      if (request.operation === "observe") return receipt(request, active(value));
      if (request.operation === "restore") { state = "original"; return receipt(request, restored(value), { status: "committed", providerOperationId: "nft:restore" }); }
      throw new Error("unexpected provider operation");
    },
  };
  const attestorTransport = {
    identityFingerprint: ATTESTOR_FP,
    async invoke(request) {
      calls.push({ role: "attestor", operation: request.operation, operationId: request.operationId });
      if (behavior.attestor) return behavior.attestor({ request, state });
      return receipt(request, restored(value, true));
    },
  };
  return { providerTransport, attestorTransport, calls, state: () => state };
}

function adapterFor(value, transport) {
  return new GoldenBuilderGatewayPolicyAdapterV1({
    binding: value.binding, reservation: value.reservation, ...transport, receiptStore: { async commit() {} }, clock: { now: () => NOW },
  });
}

test("gateway binding closes VM 9023, nft identity, literal API, and only two fresh package hosts", () => {
  const value = binding();
  assert.equal(validateGoldenBuilderGatewayPolicyBindingV1(value.binding, value.reservation, { now: NOW }), value.binding);
  assert.deepEqual(value.binding.gateway, { providerId: "proxmox-lab", hostId: "prox2", vmId: 9023, configDigest: `sha256:${"8".repeat(64)}` });
  assert.deepEqual(value.binding.apiAllow, { address: "192.168.1.110", port: 8006, protocol: "tcp" });
  assert.deepEqual(value.binding.httpsAllow.destinations.map(({ host }) => host), ["persistent.oaistatic.com", "snapshot.ubuntu.com"]);
  assert.throws(() => createGoldenBuilderGatewayPolicyBindingV1({ reservation: value.reservation, originalRulesetDigest: value.binding.originalRulesetDigest, helperDigest: value.binding.helper.digest, gatewayConfigDigest: value.binding.gateway.configDigest, destinations: [...destinations(), { ...destinations()[0], host: "example.com" }] }, { now: NOW }), { code: "INVALID_CONTRACT" });
  const hostile = destinations(); hostile[0].addresses = ["192.168.1.50"];
  assert.throws(() => createGoldenBuilderGatewayPolicyBindingV1({ reservation: value.reservation, originalRulesetDigest: value.binding.originalRulesetDigest, helperDigest: value.binding.helper.digest, gatewayConfigDigest: value.binding.gateway.configDigest, destinations: hostile }, { now: NOW }), { code: "INVALID_CONTRACT" });
  assert.throws(() => validateGoldenBuilderGatewayPolicyBindingV1({ ...value.binding, apiAllow: { ...value.binding.apiAllow, address: "192.168.1.254" } }, value.reservation, { now: NOW }), { code: "INVALID_CONTRACT" });
});

test("gateway-protected wrapper activates before builder and independently restores exact original digest after cleanup", async () => {
  const value = binding(); const transport = transports(value.binding); const adapter = adapterFor(value, transport); const events = [];
  const result = await runGatewayProtectedGoldenBuilderV1({
    binding: value.binding, adapter, journal: { async record(event) { events.push(event); } },
    runBuilder: async () => { assert.equal(transport.state(), "active"); events.push("builder-ran"); return { state: "destroyed" }; },
  });
  assert.deepEqual(result, { state: "destroyed" });
  assert.equal(transport.state(), "original");
  assert.deepEqual(transport.calls.map(({ operation }) => operation), ["preflight", "apply", "observe", "restore", "confirm-restored"]);
  assert.deepEqual(events, ["gateway-policy-preflighted", "gateway-policy-active", "builder-ran", "gateway-policy-restored"]);
});

test("offline composite runs the real disposable-builder lifecycle only inside the active gateway transaction", async () => {
  const value = binding(); const transport = transports(value.binding); const gatewayAdapter = adapterFor(value, transport); const events = [];
  const ownershipNonce = "0123456789abcdef0123456789abcdef";
  const lifecycleBinding = createGoldenBuilderLifecycleBindingV1({ reservation: value.reservation, builder: {
    vmId: 9026, name: `nelos-golden-builder-${ownershipNonce.slice(0, 12)}`, mac: "02:4E:45:4C:90:26", sshUser: "codex", ownershipNonce,
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm",
    sshPublicKeyFingerprint: "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg",
  } }, { now: NOW });
  let present = false; let builderStatus = "stopped";
  const builderAdapter = {
    async preflight() {
      events.push("builder-preflight");
      const sourceConfig = { name: "nelos-ubuntu-24-04-source", template: 1, scsi0: "local-lvm:base-9024-disk-0,size=64G", efidisk0: "local-lvm:base-9024-disk-1,efitype=4m,size=4M" };
      const scannedVms = [{ node: "prox2", vmId: 9024, configDigest: sha256V1(sourceConfig), macAddresses: [] }];
      return {
        inventory: [{ vmid: 9024, name: "nelos-ubuntu-24-04-source", node: "prox2", template: 1, type: "qemu" }],
        networkInventory: { complete: true, scannedVms, digest: sha256V1({ complete: true, scannedVms }) },
        sourceConfig,
        sourceStatus: { status: "stopped" },
        storage: { storage: "local-lvm", node: "prox2", type: "lvmthin", shared: false, active: true, enabled: true },
        storageContent: [],
        vnet: { vnet: "nelosbld", zone: "nelosbld", aclPath: "/sdn/zones/nelosbld/nelosbld", active: true },
      };
    },
    async provision() { assert.equal(transport.state(), "active"); present = true; builderStatus = "running"; events.push("builder-provision"); return { status: "committed", providerOperationId: "UPID:provision" }; },
    async observe() {
      return present ? {
        config: { name: lifecycleBinding.builderVm.name, description: lifecycleBinding.builderVm.ownership, tags: `disposable;nelos-golden-builder;nelos-builder-${ownershipNonce}`, template: 0, onboot: 0, protection: 0, ciuser: "codex", net0: "virtio=02:4E:45:4C:90:26,bridge=nelosbld,firewall=1" },
        guest: { architecture: "x86_64", cloudInitStatus: "done", hostKeyFingerprint: "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg", hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm", operatingSystem: "linux", qga: true, release: "24.04", sshAddress: "10.77.77.26" }, status: builderStatus,
      } : { config: null, guest: null, status: "absent" };
    },
    async stop() { builderStatus = "stopped"; return { status: "committed", providerOperationId: "UPID:stop" }; },
    async destroy() { present = false; events.push("builder-destroy"); return { status: "committed", providerOperationId: "UPID:destroy" }; },
    async confirmAbsent() { return { vmAbsent: !present, nameAbsent: !present, volumesAbsent: !present }; },
  };
  const result = await runGatewayProtectedGoldenBuilderV1({
    binding: value.binding, adapter: gatewayAdapter, journal: { async record(event) { events.push(event); } },
    runBuilder: () => runDisposableGoldenBuilderV1({
      reservation: value.reservation, lifecycleBinding, toolchainLockDigest: `sha256:${"f".repeat(64)}`, adapter: builderAdapter,
      executeController: async ({ packet }) => {
        const unsigned = { schemaVersion: 1, kind: "nelos-golden-builder-terminal", result: "committed", packetDigest: packet.packetDigest, reservationDigest: packet.reservationDigest, attestationDigest: `sha256:${"a".repeat(64)}`, goldenImageDigest: `sha256:${"b".repeat(64)}`, completedAt: new Date(NOW).toISOString() };
        return { ...unsigned, terminalDigest: sha256V1(unsigned) };
      },
      bundleStore: { async commit() {} }, receiptStore: { async commit() {} }, journal: { async record(event) { events.push(event); } }, clock: { now: () => NOW },
    }),
  });
  assert.equal(result.state, "destroyed"); assert.equal(transport.state(), "original");
  assert.ok(events.indexOf("gateway-policy-active") < events.indexOf("builder-provision"));
  assert.ok(events.indexOf("builder-destroy") < events.indexOf("gateway-policy-restored"));
});

test("builder failure still restores the exact baseline before propagating the original failure", async () => {
  const value = binding(); const transport = transports(value.binding); const adapter = adapterFor(value, transport);
  await assert.rejects(() => runGatewayProtectedGoldenBuilderV1({
    binding: value.binding, adapter, journal: { async record() {} }, runBuilder: async () => { throw Object.assign(new Error("builder failed"), { code: "BUILDER_FAILED" }); },
  }), { code: "BUILDER_FAILED" });
  assert.equal(transport.state(), "original");
  assert.equal(transport.calls.at(-1).operation, "confirm-restored");
});

test("ambiguous apply reuses one operation ID, blocks builder, and enters exact restore instead of stacking rules", async () => {
  const value = binding(); let applies = 0; let restores = 0;
  const transport = transports(value.binding, {
    provider(stateBoundary) {
      const { request } = stateBoundary;
      if (request.operation === "preflight") return receipt(request, preflight(value.binding));
      if (request.operation === "apply") {
        applies += 1;
        if (applies === 1) { stateBoundary.state = "ambiguous"; throw Object.assign(new Error("lost after QGA effect"), { code: "QGA_OUTCOME_UNKNOWN" }); }
        stateBoundary.state = "original";
        return receipt(request, restored(value.binding), { status: "failed" });
      }
      if (request.operation === "restore") { restores += 1; stateBoundary.state = "original"; return receipt(request, restored(value.binding), { status: "committed", providerOperationId: "nft:restore" }); }
      throw new Error("observe must never run after ambiguous apply");
    },
  });
  const adapter = adapterFor(value, transport); let builderRan = false;
  await assert.rejects(() => runGatewayProtectedGoldenBuilderV1({
    binding: value.binding, adapter, journal: { async record() {} }, runBuilder: async () => { builderRan = true; },
  }), { code: "GATEWAY_MUTATION_UNCERTAIN" });
  assert.equal(builderRan, false); assert.equal(applies, 2); assert.equal(restores, 1); assert.equal(transport.state(), "original");
  const applyIds = transport.calls.filter(({ operation }) => operation === "apply").map(({ operationId }) => operationId);
  assert.equal(new Set(applyIds).size, 1);
});

test("unproven terminal restore replaces any success or builder error with reconciliation-required", async () => {
  const value = binding(); const transport = transports(value.binding, {
    provider(stateBoundary) {
      const { request } = stateBoundary;
      if (request.operation === "preflight") return receipt(request, preflight(value.binding));
      if (request.operation === "apply") { stateBoundary.state = "active"; return receipt(request, active(value.binding), { status: "committed", providerOperationId: "nft:apply" }); }
      if (request.operation === "observe") return receipt(request, active(value.binding));
      if (request.operation === "restore") throw Object.assign(new Error("QGA unavailable"), { code: "QGA_UNAVAILABLE" });
      throw new Error("unexpected");
    },
  });
  const adapter = adapterFor(value, transport);
  await assert.rejects(() => runGatewayProtectedGoldenBuilderV1({ binding: value.binding, adapter, journal: { async record() {} }, runBuilder: async () => ({ ok: true }) }), { code: "GATEWAY_RECONCILIATION_REQUIRED" });
});

test("gateway schema and fixed helper expose a closed, journal-before-effect, no-shell surface", async () => {
  const [schema, helper] = await Promise.all([
    readFile(resolve("validation/proxmox-desktop/v1/golden-builder-gateway-policy.schema.json"), "utf8").then(JSON.parse),
    readFile(resolve("validation/proxmox-desktop/v1/nelos-golden-gateway-policy.py"), "utf8"),
  ]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  for (const property of ["gateway", "helper", "nft", "apiAllow", "httpsAllow"]) assert.equal(schema.properties[property].additionalProperties, false);
  for (const token of ["apply.intent.json", "restore.intent.json", "original-ruleset.nft", "flush ruleset", "--stateless", "192.168.1.110", "persistent.oaistatic.com", "snapshot.ubuntu.com"]) assert.match(helper, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.ok(helper.indexOf("atomic_json(apply_intent") < helper.indexOf("run_nft([\"-f\", \"-\"], deadline, script)"));
  assert.doesNotMatch(helper, /shell\s*=\s*True|os\.system|subprocess\.Popen/u);
});
