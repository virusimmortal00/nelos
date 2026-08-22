import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { canonicalJsonV1, sha256V1 } from "../validation/proxmox-desktop/v1/build-golden-image.mjs";
import { createGoldenBuilderGatewayPolicyBindingV1, GoldenBuilderGatewayPolicyAdapterV1 } from "../validation/proxmox-desktop/v1/golden-builder-gateway-policy.mjs";
import {
  createGoldenBuilderGatewayHostBindingV1,
  createGoldenBuilderGatewayHostInstallPlanV1,
  createGoldenBuilderGatewaySshTransportsV1,
  validateGoldenBuilderGatewayTransportAccessV1,
} from "../validation/proxmox-desktop/v1/golden-builder-gateway-qga-transport.mjs";
import { prepareGoldenBuilderGatewayTransportV1 } from "../validation/proxmox-desktop/v1/prepare-golden-builder-gateway-transport.mjs";
import { runGoldenBuilderGatewayControlV1 } from "../validation/proxmox-desktop/v1/golden-builder-gateway-control.mjs";

const exec = promisify(execFile);
const HOST_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm";
const HOST_FINGERPRINT = "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg";

async function key(root, name) {
  const path = join(root, name);
  await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path]);
  const publicKey = (await readFile(`${path}.pub`, "utf8")).trim();
  const { stdout } = await exec("/usr/bin/ssh-keygen", ["-lf", path, "-E", "sha256"]);
  return { path, publicKey, fingerprint: stdout.trim().split(/\s+/u)[1] };
}

function reservation(now) {
  return {
    schemaVersion: 2, reservationId: "gateway-transport-test", providerId: "proxmox-lab", apiUrl: "https://192.168.1.110:8006/api2/json",
    tlsCaDigest: "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d", node: "prox2", storage: "local-lvm",
    networkAclPath: "/sdn/zones/nelosbld/nelosbld", sourceCommit: "b".repeat(40), buildNonce: "c".repeat(32),
    buildTokenId: "nelos-build@pve!gateway-transport", attestorTokenId: "nelos-attest@pve!gateway-transport",
    expiresAt: new Date(now + 3_600_000).toISOString(), cleanupExpiresAt: new Date(now + 7_200_000).toISOString(), maxBuildMs: 1_800_000,
    sourceArtifact: { name: "ubuntu-24.04-server-cloudimg-amd64.img", digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe", signatureScheme: "openpgp-detached-sha256sums", signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092" },
    volumeAttestor: { sshHost: "192.168.1.110", sshPort: 22, sshUser: "nelosmeasure", hostKeyFingerprint: HOST_FINGERPRINT, identityFingerprint: `SHA256:${"V".repeat(43)}`, helperDigest: `sha256:${"d".repeat(64)}` },
    sourceTemplate: { vmId: 9024, name: "nelos-ubuntu-24-04-source", configDigest: `sha256:${"a".repeat(64)}`, volumeMeasurementDigest: `sha256:${"b".repeat(64)}` },
    outputTemplate: { vmId: 9027, name: "nelos-desktop-ubuntu-24-04-v1", macAddress: "02:4E:45:4C:90:27" },
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nelos-gateway-transport-"))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const [provider, attestor] = await Promise.all([key(root, "gateway-provider"), key(root, "gateway-attestor")]);
  await chmod(provider.path, 0o600); await chmod(attestor.path, 0o600);
  const knownHosts = join(root, "known-hosts"); await writeFile(knownHosts, `192.168.1.110 ${HOST_PUBLIC_KEY}\n`, { mode: 0o600 }); await chmod(knownHosts, 0o600);
  const now = Date.now(); const reservationValue = reservation(now);
  const guestHelperDigest = sha256V1(await readFile(resolve("validation/proxmox-desktop/v1/nelos-golden-gateway-policy.py")));
  const hostHelperDigest = sha256V1(await readFile(resolve("validation/proxmox-desktop/v1/nelos-proxmox-golden-gateway-transport.py")));
  const destinations = [
    { host: "persistent.oaistatic.com", addresses: ["104.18.1.10"], resolvedAt: new Date(now).toISOString(), ttlSeconds: 300, expiresAt: new Date(now + 300_000).toISOString() },
    { host: "snapshot.ubuntu.com", addresses: ["185.125.190.36"], resolvedAt: new Date(now).toISOString(), ttlSeconds: 300, expiresAt: new Date(now + 300_000).toISOString() },
  ];
  const policy = createGoldenBuilderGatewayPolicyBindingV1({ reservation: reservationValue, originalRulesetDigest: `sha256:${"c".repeat(64)}`, helperDigest: guestHelperDigest, gatewayConfigDigest: `sha256:${"e".repeat(64)}`, destinations }, { now });
  const access = {
    schemaVersion: 1, kind: "nelos-golden-builder-gateway-transport-access", hostHelperDigest,
    host: { sshHost: "192.168.1.110", sshPort: 22, hostPublicKey: HOST_PUBLIC_KEY, hostFingerprint: HOST_FINGERPRINT, knownHostsFile: knownHosts },
    provider: { sshUser: "nelos-golden-gateway-provider", identityFile: provider.path, publicKey: provider.publicKey, publicKeyFingerprint: provider.fingerprint },
    attestor: { sshUser: "nelos-golden-gateway-attestor", identityFile: attestor.path, publicKey: attestor.publicKey, publicKeyFingerprint: attestor.fingerprint },
    limits: { operationTimeoutMs: 120_000, maxOutputBytes: 1_048_576, transportAttempts: 2 },
  };
  return { root, now, reservation: reservationValue, policy, access };
}

function receipt(request, payload) {
  const unsigned = { schemaVersion: 1, kind: "nelos-golden-builder-gateway-receipt", role: request.role, operation: request.operation, operationId: request.operationId,
    bindingDigest: request.binding.bindingDigest, status: "observed", providerOperationId: null, observedAt: new Date().toISOString(), payload, payloadDigest: sha256V1(payload) };
  return { ...unsigned, receiptDigest: sha256V1(unsigned) };
}

test("gateway host binding and install plan use distinct forced principals and both measured helpers", async (t) => {
  const value = await fixture(t);
  const binding = createGoldenBuilderGatewayHostBindingV1({ policyBinding: value.policy, reservation: value.reservation, access: value.access }, { now: value.now });
  const plan = createGoldenBuilderGatewayHostInstallPlanV1({ hostBinding: binding, access: value.access });
  assert.equal(plan.knownHostsLine, `192.168.1.110 ${HOST_PUBLIC_KEY}\n`);
  assert.equal(plan.guestHelperDigest, value.policy.helper.digest);
  assert.equal(plan.hostHelperDigest, value.access.hostHelperDigest);
  assert.match(plan.principals[0].authorizedKey, /nelos-proxmox-golden-gateway-transport provider request/u);
  assert.match(plan.principals[1].authorizedKey, /nelos-proxmox-golden-gateway-transport attestor request/u);
  assert.notEqual(binding.providerKeyFingerprint, binding.attestorKeyFingerprint);
  assert.throws(() => validateGoldenBuilderGatewayTransportAccessV1({ ...value.access, host: { ...value.access.host, sshHost: "prox2.sayers.io" } }), { code: "INVALID_CONTRACT" });
});

test("concrete gateway SSH/QGA transport pins literal host and forwards only the sealed policy envelope", async (t) => {
  const value = await fixture(t); const captures = [];
  const runCommand = async (capture) => {
    captures.push(capture); const request = JSON.parse(capture.input);
    const payload = request.operation === "preflight" ? {
      approvedSetEmpty: true, forwardPolicy: "drop", gatewayVmId: 9023, helperDigest: value.policy.helper.digest,
      rulesetDigest: value.policy.originalRulesetDigest, unexpectedForwardAccepts: 0,
    } : { restored: true, rulesetDigest: value.policy.originalRulesetDigest, independentInventoryDigest: `sha256:${"f".repeat(64)}` };
    return Buffer.from(`${canonicalJsonV1(receipt(request, payload))}\n`);
  };
  const transports = await createGoldenBuilderGatewaySshTransportsV1({ access: value.access, policyBinding: value.policy, reservation: value.reservation, runCommand, clock: { now: () => value.now } });
  const adapter = new GoldenBuilderGatewayPolicyAdapterV1({ binding: value.policy, reservation: value.reservation, ...transports, receiptStore: { async commit() {} }, clock: { now: () => value.now } });
  await adapter.preflight(); await adapter.confirmRestored();
  assert.equal(captures.length, 2);
  for (const capture of captures) {
    const command = capture.args.join(" ");
    for (const token of ["192.168.1.110", "StrictHostKeyChecking=yes", "ForwardAgent=no", "IdentitiesOnly=yes", "ProxyCommand=none", "nelos-proxmox-golden-gateway-transport"]) assert.match(command, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(command, /prox2\.sayers\.io|accept-new|StrictHostKeyChecking=no/u);
    assert.equal(JSON.parse(capture.input).binding.bindingDigest, value.policy.bindingDigest);
  }
  assert.ok(captures[0].args.includes(value.access.provider.identityFile));
  assert.ok(captures[1].args.includes(value.access.attestor.identityFile));
});

test("gateway transport preparation verifies both helper digests and writes exclusive sealed outputs", async (t) => {
  const value = await fixture(t); const reservationPath = join(value.root, "reservation.json"); const policyPath = join(value.root, "policy.json"); const accessPath = join(value.root, "access.json");
  const bindingPath = join(value.root, "host-binding.json"); const planPath = join(value.root, "install-plan.json");
  for (const [path, contents] of [[reservationPath, value.reservation], [policyPath, value.policy], [accessPath, value.access]]) {
    await writeFile(path, `${canonicalJsonV1(contents)}\n`, { mode: 0o400 }); await chmod(path, 0o400);
  }
  await unlink(value.access.host.knownHostsFile);
  const result = await prepareGoldenBuilderGatewayTransportV1({ reservationPath, policyPath, accessPath, hostBindingOutput: bindingPath, planOutput: planPath, knownHostsOutput: value.access.host.knownHostsFile }, { now: value.now });
  assert.match(result.hostBindingDigest, /^sha256:/u); assert.match(result.planDigest, /^sha256:/u);
  assert.equal((await stat(bindingPath)).mode & 0o777, 0o400); assert.equal((await stat(planPath)).mode & 0o777, 0o400);
  assert.equal((await stat(value.access.host.knownHostsFile)).mode & 0o777, 0o600);
  assert.equal(await readFile(value.access.host.knownHostsFile, "utf8"), `192.168.1.110 ${HOST_PUBLIC_KEY}\n`);
});

test("gateway operator controller content-addresses receipts and gates apply/restore on the exact policy digest", async (t) => {
  const value = await fixture(t); const reservationPath = join(value.root, "control-reservation.json"); const policyPath = join(value.root, "control-policy.json"); const accessPath = join(value.root, "control-access.json"); const receiptDir = join(value.root, "receipts");
  for (const [path, contents] of [[reservationPath, value.reservation], [policyPath, value.policy], [accessPath, value.access]]) { await writeFile(path, `${canonicalJsonV1(contents)}\n`, { mode: 0o400 }); await chmod(path, 0o400); }
  await mkdir(receiptDir, { mode: 0o700 }); await chmod(receiptDir, 0o700);
  const createTransports = async () => ({
    providerTransport: { identityFingerprint: value.access.provider.publicKeyFingerprint, async invoke(request) {
      const payload = request.operation === "preflight" ? { approvedSetEmpty: true, forwardPolicy: "drop", gatewayVmId: 9023, helperDigest: value.policy.helper.digest, rulesetDigest: value.policy.originalRulesetDigest, unexpectedForwardAccepts: 0 } :
        { active: true, allowedHttpsAddresses: value.policy.httpsAllow.destinations.flatMap(({ addresses }) => addresses).sort(), apiAddress: "192.168.1.110", apiPort: 8006, marker: `nelos-golden:${value.policy.bindingDigest.slice(7, 23)}`, rulesetDigest: `sha256:${"6".repeat(64)}` };
      const unsigned = { schemaVersion: 1, kind: "nelos-golden-builder-gateway-receipt", role: request.role, operation: request.operation, operationId: request.operationId, bindingDigest: request.binding.bindingDigest, status: request.operation === "apply" ? "committed" : "observed", providerOperationId: request.operation === "apply" ? "nft:apply" : null, observedAt: new Date(value.now).toISOString(), payload, payloadDigest: sha256V1(payload) };
      return { ...unsigned, receiptDigest: sha256V1(unsigned) };
    } },
    attestorTransport: { identityFingerprint: value.access.attestor.publicKeyFingerprint, async invoke() { throw new Error("not used"); } },
  });
  const preflight = await runGoldenBuilderGatewayControlV1({ reservationPath, policyPath, accessPath, receiptDir, operation: "preflight" }, { createTransports, clock: { now: () => value.now } });
  assert.equal(preflight.bindingDigest, value.policy.bindingDigest);
  await assert.rejects(() => runGoldenBuilderGatewayControlV1({ reservationPath, policyPath, accessPath, receiptDir, operation: "apply" }, { createTransports, clock: { now: () => value.now } }), { code: "MUTATION_AUTHORIZATION_REQUIRED" });
  const applied = await runGoldenBuilderGatewayControlV1({ reservationPath, policyPath, accessPath, receiptDir, operation: "apply", authorizeBinding: value.policy.bindingDigest }, { createTransports, clock: { now: () => value.now } });
  assert.equal(applied.result.providerOperationId, "nft:apply");
  const names = await readdir(receiptDir); assert.equal(names.length, 2); assert.ok(names.every((name) => /^[0-9a-f]{64}\.json$/u.test(name)));
});

test("gateway transport schemas and host helper close DNS, QGA, config, and principal boundaries", async () => {
  const [accessSchema, bindingSchema, helper] = await Promise.all([
    readFile(resolve("validation/proxmox-desktop/v1/golden-builder-gateway-transport-access.schema.json"), "utf8").then(JSON.parse),
    readFile(resolve("validation/proxmox-desktop/v1/golden-builder-gateway-host-binding.schema.json"), "utf8").then(JSON.parse),
    readFile(resolve("validation/proxmox-desktop/v1/nelos-proxmox-golden-gateway-transport.py"), "utf8"),
  ]);
  for (const schema of [accessSchema, bindingSchema]) { assert.equal(schema.additionalProperties, false); assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort()); }
  for (const token of ["SUDO_USER", "/nodes/prox2/qemu/9023/config", "/nodes/prox2/qemu/9023/agent/exec", "input-data", "exec-status", "configDigest", "StrictHostKeyChecking"]) assert.match(`${helper}\n${await readFile(resolve("validation/proxmox-desktop/v1/golden-builder-gateway-qga-transport.mjs"), "utf8")}`, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(helper, /shell\s*=\s*True|os\.system|subprocess\.Popen/u);
});
