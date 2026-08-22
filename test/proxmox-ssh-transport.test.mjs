import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const helper = resolve("bin/nelos-proxmox-transport");
const attestHelper = resolve("bin/nelos-proxmox-attest-transport");
const implementation = resolve("src/proxmox-ssh-transport.mjs");

function run(env, input = "{}", executable = helper) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [executable, "request"], { env: { PATH: "/usr/bin:/bin", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(input);
  });
}

async function controllerEnv(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-proxmox-ssh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = join(root, "controller-key");
  await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  await chmod(key, 0o600);
  const publicParts = (await readFile(`${key}.pub`, "utf8")).trim().split(/\s+/u);
  const knownHosts = join(root, "known-hosts");
  await writeFile(knownHosts, `192.0.2.10 ${publicParts[0]} ${publicParts[1]}\n`, { mode: 0o600 });
  const { stdout } = await exec("/usr/bin/ssh-keygen", ["-lf", knownHosts, "-E", "sha256"]);
  const fingerprint = stdout.trim().split(/\s+/u)[1];
  return {
    NELOS_PROXMOX_SSH_HOST: "192.0.2.10",
    NELOS_PROXMOX_SSH_USER: "codex",
    NELOS_PROXMOX_KNOWN_HOSTS: knownHosts,
    NELOS_PROXMOX_IDENTITY_FILE: key,
    NELOS_PROXMOX_HOST_FINGERPRINT: fingerprint,
    NELOS_PROXMOX_HOST_ID: "prox2",
    NELOS_PROXMOX_GATEWAY_ID: "9023",
    NELOS_PROXMOX_MAC_ADDRESS: "02:4E:45:4C:03:19",
    NELOS_PROXMOX_NETWORK_ID: "nelosbld",
    NELOS_PROXMOX_NETWORK_POLICY_DIGEST: `sha256:${"9".repeat(64)}`,
    NELOS_PROXMOX_PROVIDER_ID: "proxmox-lab",
    NELOS_PROXMOX_SOURCE_TEMPLATE_VM_ID: "9001",
  };
}

test("controller SSH transport fails closed without the external pinned identity", async () => {
  const result = await run({});
  assert.equal(result.code, 78);
  assert.match(result.stderr, /CONTROLLER_CONFIG_REQUIRED/u);
  assert.equal(result.stdout, "");
});

test("controller SSH transport rejects run/provider drift before opening SSH", async (t) => {
  const env = await controllerEnv(t);
  const envelope = {
    schemaVersion: 1,
    binding: { hostId: "wrong-host", providerId: env.NELOS_PROXMOX_PROVIDER_ID },
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    maxOutputBytes: 1024,
    request: { method: "GET", path: "/cluster/resources?type=vm" },
  };
  const result = await run(env, `${JSON.stringify(envelope)}\n`);
  assert.equal(result.code, 77);
  assert.match(result.stderr, /IDENTITY_MISMATCH/u);
});

test("controller SSH transport rejects an alternate prox2 gateway before opening SSH", async (t) => {
  const env = await controllerEnv(t);
  const result = await run({ ...env, NELOS_PROXMOX_GATEWAY_ID: "9024" });
  assert.equal(result.code, 78);
  assert.match(result.stderr, /fixed prox2 gateway VM 9023/u);
  assert.equal(result.stdout, "");
});

test("controller SSH transport rejects an alternate prox2 VNet before opening SSH", async (t) => {
  const env = await controllerEnv(t);
  const result = await run({ ...env, NELOS_PROXMOX_NETWORK_ID: "caller-selected" });
  assert.equal(result.code, 78);
  assert.match(result.stderr, /nelosbld VNet/u);
  assert.equal(result.stdout, "");
});

test("controller transport source fixes host verification, identity isolation, and remote helper path", async () => {
  const source = await readFile(implementation, "utf8");
  for (const expected of ["StrictHostKeyChecking=yes", "ForwardAgent=no", "IdentitiesOnly=yes", "PasswordAuthentication=no", "UserKnownHostsFile=", "/usr/libexec/nelos-proxmox-transport", "/usr/libexec/nelos-proxmox-attest"]) assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(source, /remoteHelper,\s*"request"/u);
  assert.doesNotMatch(source, /accept-new|StrictHostKeyChecking=no|ForwardAgent=yes|shell:\s*true/u);
});

test("independent attestation requires another credential and rejects mutations before SSH", async (t) => {
  const provider = await controllerEnv(t);
  const second = await controllerEnv(t);
  const attest = Object.fromEntries(Object.entries(second).map(([name, value]) => [name.replace("NELOS_PROXMOX_", "NELOS_PROXMOX_ATTEST_"), value]));
  const sameCredential = { ...provider, ...attest, NELOS_PROXMOX_ATTEST_IDENTITY_FILE: provider.NELOS_PROXMOX_IDENTITY_FILE };
  const sameCredentialResult = await run(sameCredential, "{}", attestHelper);
  assert.equal(sameCredentialResult.code, 78, sameCredentialResult.stderr);
  assert.match(sameCredentialResult.stderr, /INDEPENDENT_ATTESTOR_REQUIRED/u);
  const copiedRoot = await mkdtemp(join(tmpdir(), "nelos-proxmox-copied-key-"));
  t.after(() => rm(copiedRoot, { recursive: true, force: true }));
  const copiedCredential = join(copiedRoot, "copied-provider-key");
  await writeFile(copiedCredential, await readFile(provider.NELOS_PROXMOX_IDENTITY_FILE), { mode: 0o600 });
  const copiedKeyResult = await run({ ...provider, ...attest, NELOS_PROXMOX_ATTEST_IDENTITY_FILE: copiedCredential }, "{}", attestHelper);
  assert.equal(copiedKeyResult.code, 78);
  assert.match(copiedKeyResult.stderr, /INDEPENDENT_ATTESTOR_REQUIRED/u);
  const envelope = {
    schemaVersion: 1,
    binding: {
      hostId: attest.NELOS_PROXMOX_ATTEST_HOST_ID, providerId: attest.NELOS_PROXMOX_ATTEST_PROVIDER_ID, vmId: "319",
      gatewayId: attest.NELOS_PROXMOX_ATTEST_GATEWAY_ID, macAddress: attest.NELOS_PROXMOX_ATTEST_MAC_ADDRESS,
      networkId: attest.NELOS_PROXMOX_ATTEST_NETWORK_ID, networkPolicyDigest: attest.NELOS_PROXMOX_ATTEST_NETWORK_POLICY_DIGEST,
    },
    deadlineAt: new Date(Date.now() + 30_000).toISOString(), maxOutputBytes: 1024,
    request: { method: "DELETE", path: `/nodes/${attest.NELOS_PROXMOX_ATTEST_HOST_ID}/qemu/319`, body: { purge: 1 } },
  };
  const rejected = await run({ ...provider, ...attest }, `${JSON.stringify(envelope)}\n`, attestHelper);
  assert.equal(rejected.code, 77);
  assert.match(rejected.stderr, /READ_ONLY_ATTESTATION_REQUIRED/u);

  const mismatchedSource = await run({
    ...provider,
    ...attest,
    NELOS_PROXMOX_ATTEST_SOURCE_TEMPLATE_VM_ID: "9002",
  }, "{}", attestHelper);
  assert.equal(mismatchedSource.code, 78);
  assert.match(mismatchedSource.stderr, /INDEPENDENT_ATTESTOR_REQUIRED/u);

  const sourceCollision = structuredClone(envelope);
  sourceCollision.binding.vmId = provider.NELOS_PROXMOX_SOURCE_TEMPLATE_VM_ID;
  sourceCollision.request = {
    method: "GET",
    path: `/nodes/${attest.NELOS_PROXMOX_ATTEST_HOST_ID}/qemu/${provider.NELOS_PROXMOX_SOURCE_TEMPLATE_VM_ID}/config`,
  };
  const collided = await run({ ...provider, ...attest }, `${JSON.stringify(sourceCollision)}\n`, attestHelper);
  assert.equal(collided.code, 77);
  assert.match(collided.stderr, /IDENTITY_MISMATCH/u);
});
