import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, chown, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { installFakeProxmoxLeaseAuthority } from "./support/fake-proxmox-lease-authority.mjs";

const exec = promisify(execFile);
const helper = resolve("validation/proxmox/desktop/helpers/nelos-proxmox-run-binding.py");

function canonicalDeep(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function canonicalize(value) {
  return canonicalDeep(value);
}

function bytes(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function run(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/python3", [helper, ...args], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function key(root, name) {
  const path = join(root, name);
  await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path]);
  const publicKey = (await readFile(`${path}.pub`, "utf8")).trim();
  const { stdout } = await exec("/usr/bin/ssh-keygen", ["-lf", `${path}.pub`, "-E", "sha256"]);
  return { path, publicKey, fingerprint: stdout.trim().split(/\s+/u)[1] };
}

async function fixture(t) {
  const work = await mkdtemp(join(tmpdir(), "nelos-host-binding-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const fakeRoot = join(work, "root");
  await mkdir(join(fakeRoot, "usr/libexec"), { recursive: true, mode: 0o755 });
  await writeFile(join(fakeRoot, ".nelos-operator-fake-root"), "nelos-proxmox-run-binding-fake-root-v1\n", { mode: 0o600 });
  for (const path of [fakeRoot, join(fakeRoot, "usr"), join(fakeRoot, "usr/libexec"), join(fakeRoot, ".nelos-operator-fake-root")]) {
    await chown(path, process.getuid(), process.getgid());
  }
  for (const name of ["nelos-proxmox-transport", "nelos-proxmox-attest"]) {
    const path = join(fakeRoot, "usr/libexec", name);
    await writeFile(path, "#!/bin/sh\nexit 70\n", { mode: 0o750 });
    await chmod(path, 0o750);
    await chown(path, process.getuid(), process.getgid());
  }
  const provider = await key(work, "provider");
  const attestor = await key(work, "attestor");
  const host = await key(work, "host");
  const knownHosts = join(work, "known-hosts");
  const runBinding = {
    automationUser: "nelosauto", fencingToken: "fence-58955598", hostId: "prox2", imageId: "desktop-golden-26.814.41957",
    leaseId: "lease-58955598", macAddress: "02:4E:45:4C:90:28", networkId: "nelosbld", gatewayId: "9023",
    networkPolicyDigest: `sha256:${"9".repeat(64)}`, providerId: "proxmox-lab", runId: "desktop-run-58955598",
    stateRoot: "/var/lib/nelos-desktop/runs/desktop-run-58955598", vmId: "9028",
  };
  const authority = await installFakeProxmoxLeaseAuthority({ root: fakeRoot, binding: runBinding, installRunBinding: false });
  const packet = {
    schemaVersion: 1,
    kind: "nelos.proxmox-desktop.host-run-binding.v1",
    runBinding,
    leaseAuthority: authority.authorityBinding,
    provider: {
      gatewayId: "9023", hostId: "prox2", networkId: "nelosbld", networkPolicyDigest: `sha256:${"9".repeat(64)}`,
      networkPolicyObserverDigest: `sha256:${"8".repeat(64)}`,
      providerId: "proxmox-lab", sourceTemplateVmId: "9025",
    },
    access: { providerPublicKey: provider.publicKey, attestorPublicKey: attestor.publicKey },
    controller: {
      sshHost: "192.168.1.110", sshPort: 22, hostPublicKey: host.publicKey, hostFingerprint: host.fingerprint,
      knownHostsFile: knownHosts, providerIdentityFile: provider.path, attestorIdentityFile: attestor.path,
    },
  };
  const packetPath = join(work, "packet.json");
  await writeFile(packetPath, bytes(packet), { mode: 0o400 });
  await chmod(packetPath, 0o400);
  return { work, fakeRoot, packet, packetPath, provider, attestor, host, knownHosts };
}

async function install(fixtureValue) {
  const result = await run(["install", "--packet", fixtureValue.packetPath, "--fake-root", fixtureValue.fakeRoot]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const receiptPath = join(fixtureValue.work, "receipt.json");
  await writeFile(receiptPath, bytes(output.receipt), { mode: 0o400 });
  await chmod(receiptPath, 0o400);
  return { ...output, receiptPath };
}

test("render closes identities, forced commands, known host, and both source-template environments", async (t) => {
  const item = await fixture(t);
  const rendered = await run(["render", "--packet", item.packetPath]);
  assert.equal(rendered.code, 0, rendered.stderr);
  const plan = JSON.parse(rendered.stdout);
  assert.equal(plan.packetSha256.startsWith("sha256:"), true);
  assert.equal(plan.knownHostsLine, `192.168.1.110 ${item.host.publicKey.split(/\s+/u).slice(0, 2).join(" ")}\n`);
  assert.equal(plan.controllerEnvironment.NELOS_PROXMOX_SOURCE_TEMPLATE_VM_ID, "9025");
  assert.equal(plan.controllerEnvironment.NELOS_PROXMOX_ATTEST_SOURCE_TEMPLATE_VM_ID, "9025");
  assert.equal(plan.controllerEnvironment.NELOS_PROXMOX_GATEWAY_ID, "9023");
  assert.equal(plan.controllerEnvironment.NELOS_PROXMOX_ATTEST_GATEWAY_ID, "9023");
  assert.equal(plan.controllerEnvironment.NELOS_PROXMOX_NETWORK_POLICY_DIGEST, `sha256:${"9".repeat(64)}`);
  assert.equal(plan.controllerEnvironment.NELOS_PROXMOX_SSH_USER, "nelos-provider");
  assert.equal(plan.controllerEnvironment.NELOS_PROXMOX_ATTEST_SSH_USER, "nelos-attestor");
  assert.notEqual(plan.controllerEnvironment.NELOS_PROXMOX_IDENTITY_FILE, plan.controllerEnvironment.NELOS_PROXMOX_ATTEST_IDENTITY_FILE);
  const env = await run(["env", "--packet", item.packetPath]);
  assert.equal(env.code, 0, env.stderr);
  assert.match(env.stdout, /^export NELOS_PROXMOX_SOURCE_TEMPLATE_VM_ID=9025$/mu);
  assert.match(env.stdout, /^export NELOS_PROXMOX_ATTEST_SOURCE_TEMPLATE_VM_ID=9025$/mu);
});

test("fake-root install is content-addressed, exact-mode, and idempotent", async (t) => {
  const item = await fixture(t);
  const first = await install(item);
  const second = await run(["install", "--packet", item.packetPath, "--fake-root", item.fakeRoot]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).sha256, first.sha256);
  const paths = [
    ["etc/nelos-desktop/run-binding.json", 0o400], ["etc/nelos-desktop/provider.json", 0o400],
    ["etc/nelos-desktop/operator-binding.json", 0o400], ["etc/nelos-desktop/operator-receipt.json", 0o400],
    ["etc/nelos-desktop/lease-authority-binding.json", 0o400],
    ["etc/sudoers.d/nelos-desktop-provider", 0o440], ["etc/sudoers.d/nelos-desktop-attestor", 0o440],
    ["var/lib/nelos-proxmox-provider/.ssh/authorized_keys", 0o600], ["var/lib/nelos-proxmox-attestor/.ssh/authorized_keys", 0o600],
  ];
  for (const [path, mode] of paths) assert.equal((await stat(join(item.fakeRoot, path))).mode & 0o777, mode, path);
  const providerKey = await readFile(join(item.fakeRoot, "var/lib/nelos-proxmox-provider/.ssh/authorized_keys"), "utf8");
  const attestorKey = await readFile(join(item.fakeRoot, "var/lib/nelos-proxmox-attestor/.ssh/authorized_keys"), "utf8");
  assert.match(providerKey, /^restrict,command="\/usr\/bin\/sudo -n -- \/usr\/libexec\/nelos-proxmox-transport request" ssh-ed25519 /u);
  assert.match(attestorKey, /^restrict,command="\/usr\/bin\/sudo -n -- \/usr\/libexec\/nelos-proxmox-attest request" ssh-ed25519 /u);
  assert.equal(await readFile(join(item.fakeRoot, "etc/sudoers.d/nelos-desktop-provider"), "utf8"), "nelos-provider ALL=(root) NOPASSWD: /usr/libexec/nelos-proxmox-transport request\n");
  const checked = await run(["check", "--packet", item.packetPath, "--receipt", first.receiptPath, "--fake-root", item.fakeRoot]);
  assert.equal(checked.code, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).valid, true);
});

test("unknown packet fields, duplicate keys, host-key mismatch, and unsealed input fail closed", async (t) => {
  const item = await fixture(t);
  const cases = [
    [{ ...item.packet, unexpected: true }, 65, "INVALID_PACKET"],
    [{ ...item.packet, access: { ...item.packet.access, attestorPublicKey: item.packet.access.providerPublicKey } }, 77, "INDEPENDENT_ATTESTOR_REQUIRED"],
    [{ ...item.packet, controller: { ...item.packet.controller, hostFingerprint: item.provider.fingerprint } }, 77, "HOST_KEY_MISMATCH"],
  ];
  for (const [index, [packet, expectedCode, marker]] of cases.entries()) {
    const path = join(item.work, `invalid-${index}.json`);
    await writeFile(path, bytes(packet), { mode: 0o400 }); await chmod(path, 0o400);
    const result = await run(["render", "--packet", path]);
    assert.equal(result.code, expectedCode, result.stderr);
    assert.match(result.stderr, new RegExp(marker, "u"));
  }
  await chmod(item.packetPath, 0o644);
  const unsealed = await run(["install", "--packet", item.packetPath, "--fake-root", item.fakeRoot]);
  assert.equal(unsealed.code, 66);
  assert.match(unsealed.stderr, /UNTRUSTED_INPUT/u);
});

test("an internally consistent alternate prox2 gateway is rejected before host installation", async (t) => {
  const item = await fixture(t);
  const alternate = structuredClone(item.packet);
  alternate.runBinding.gatewayId = "9024";
  alternate.provider.gatewayId = "9024";
  const path = join(item.work, "alternate-gateway.json");
  await writeFile(path, bytes(alternate), { mode: 0o400 });
  await chmod(path, 0o400);
  const result = await run(["install", "--packet", path, "--fake-root", item.fakeRoot]);
  assert.equal(result.code, 65);
  assert.match(result.stderr, /fixed prox2 gateway VM 9023/u);
  await assert.rejects(stat(join(item.fakeRoot, "etc/nelos-desktop/run-binding.json")), /ENOENT/u);
});

test("an internally consistent alternate prox2 VNet is rejected before host installation", async (t) => {
  const item = await fixture(t);
  const alternate = structuredClone(item.packet);
  alternate.runBinding.networkId = "caller-selected";
  alternate.provider.networkId = "caller-selected";
  const path = join(item.work, "alternate-network.json");
  await writeFile(path, bytes(alternate), { mode: 0o400 });
  await chmod(path, 0o400);
  const result = await run(["install", "--packet", path, "--fake-root", item.fakeRoot]);
  assert.equal(result.code, 65);
  assert.match(result.stderr, /nelosbld VNet/u);
  await assert.rejects(stat(join(item.fakeRoot, "etc/nelos-desktop/run-binding.json")), /ENOENT/u);
});

test("a conflicting run cannot replace any installed binding", async (t) => {
  const item = await fixture(t);
  await install(item);
  const before = await readFile(join(item.fakeRoot, "etc/nelos-desktop/run-binding.json"));
  const conflicting = structuredClone(item.packet);
  conflicting.runBinding.fencingToken = "fence-conflict";
  const conflictPath = join(item.work, "conflict.json");
  await writeFile(conflictPath, bytes(conflicting), { mode: 0o400 }); await chmod(conflictPath, 0o400);
  const result = await run(["install", "--packet", conflictPath, "--fake-root", item.fakeRoot]);
  assert.equal(result.code, 77);
  assert.match(result.stderr, /RECEIPT_MISMATCH/u);
  assert.deepEqual(await readFile(join(item.fakeRoot, "etc/nelos-desktop/run-binding.json")), before);
});

test("install rolls back when the independent authority does not admit the packet epoch", async (t) => {
  const item = await fixture(t);
  const packet = structuredClone(item.packet);
  packet.leaseAuthority.epoch += 1;
  const path = join(item.work, "wrong-authority-epoch.json");
  await writeFile(path, bytes(packet), { mode: 0o400 });
  await chmod(path, 0o400);
  const result = await run(["install", "--packet", path, "--fake-root", item.fakeRoot]);
  assert.equal(result.code, 70);
  assert.match(result.stderr, /LEASE_AUTHORITY_MISMATCH/u);
  await assert.rejects(stat(join(item.fakeRoot, "etc/nelos-desktop/run-binding.json")), /ENOENT/u);
  await assert.rejects(stat(join(item.fakeRoot, "var/lib/nelos-proxmox-provider")), /ENOENT/u);
});

test("cleanup requires the exact receipt and refuses unowned home content", async (t) => {
  const item = await fixture(t);
  const installed = await install(item);
  const wrong = structuredClone(installed.receipt);
  wrong.packetSha256 = `sha256:${"0".repeat(64)}`;
  const wrongPath = join(item.work, "wrong-receipt.json");
  await writeFile(wrongPath, bytes(wrong), { mode: 0o400 }); await chmod(wrongPath, 0o400);
  const rejected = await run(["cleanup", "--packet", item.packetPath, "--receipt", wrongPath, "--fake-root", item.fakeRoot]);
  assert.equal(rejected.code, 77);
  assert.equal((await stat(join(item.fakeRoot, "etc/nelos-desktop/run-binding.json"))).isFile(), true);
  const unknown = join(item.fakeRoot, "var/lib/nelos-proxmox-provider/keep.txt");
  await writeFile(unknown, "not-owned\n", { mode: 0o600 });
  const protectedResult = await run(["cleanup", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", item.fakeRoot]);
  assert.equal(protectedResult.code, 77);
  assert.match(protectedResult.stderr, /UNOWNED_HOME_CONTENT/u);
  await rm(unknown);
  await writeFile(join(item.fakeRoot, "etc/nelos-desktop/unrelated"), "preserve\n", { mode: 0o600 });
  const cleaned = await run(["cleanup", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", item.fakeRoot]);
  assert.equal(cleaned.code, 0, cleaned.stderr);
  assert.equal(JSON.parse(cleaned.stdout).removed, true);
  assert.equal(await readFile(join(item.fakeRoot, "etc/nelos-desktop/unrelated"), "utf8"), "preserve\n");
  await assert.rejects(stat(join(item.fakeRoot, "etc/nelos-desktop/run-binding.json")), /ENOENT/u);
  await assert.rejects(stat(join(item.fakeRoot, "var/lib/nelos-proxmox-provider")), /ENOENT/u);
  const replay = await run(["install", "--packet", item.packetPath, "--fake-root", item.fakeRoot]);
  assert.equal(replay.code, 70); assert.match(replay.stderr, /RUN_TERMINAL/u);
});

test("content tampering blocks both verification and cleanup", async (t) => {
  const item = await fixture(t);
  const installed = await install(item);
  const target = join(item.fakeRoot, "etc/sudoers.d/nelos-desktop-provider");
  await chmod(target, 0o640);
  const checked = await run(["check", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", item.fakeRoot]);
  assert.equal(checked.code, 70);
  assert.match(checked.stderr, /HOST_STATE_MISMATCH/u);
  const cleaned = await run(["cleanup", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", item.fakeRoot]);
  assert.equal(cleaned.code, 70);
  assert.equal((await stat(join(item.fakeRoot, "etc/nelos-desktop/run-binding.json"))).isFile(), true);
  await assert.rejects(stat(join(item.fakeRoot, "var/lib/nelos-proxmox-run-binding-cleanup")), /ENOENT/u);
});

test("hard-linked receipts and symlinked managed targets fail before cleanup intent publication", async (t) => {
  const item = await fixture(t); const installed = await install(item);
  const receiptAlias = join(item.work, "receipt-hardlink.json"); await link(installed.receiptPath, receiptAlias);
  const linkedReceipt = await run(["cleanup", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", item.fakeRoot]);
  assert.equal(linkedReceipt.code, 66); assert.match(linkedReceipt.stderr, /UNTRUSTED_INPUT/u); await unlink(receiptAlias);

  const target = join(item.fakeRoot, "etc/nelos-desktop/provider.json"); const preserved = join(item.work, "provider-preserved.json");
  await writeFile(preserved, await readFile(target), { mode: 0o400 }); await unlink(target); await symlink(preserved, target);
  const symlinkedTarget = await run(["cleanup", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", item.fakeRoot]);
  assert.equal(symlinkedTarget.code, 70); assert.match(symlinkedTarget.stderr, /HOST_STATE_MISMATCH/u);
  await assert.rejects(stat(join(item.fakeRoot, "var/lib/nelos-proxmox-run-binding-cleanup")), /ENOENT/u);
});

test("fake account uid/gid drift is rejected before cleanup intent publication", async (t) => {
  const item = await fixture(t); const installed = await install(item);
  const accountPath = join(item.fakeRoot, "var/lib/nelos-desktop/operator-test-accounts/nelos-provider.json");
  const account = JSON.parse(await readFile(accountPath, "utf8")); account.uid += 1;
  await chmod(accountPath, 0o600); await writeFile(accountPath, bytes(account)); await chmod(accountPath, 0o400);
  const result = await run(["cleanup", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", item.fakeRoot]);
  assert.equal(result.code, 77); assert.match(result.stderr, /RECEIPT_MISMATCH/u);
  await assert.rejects(stat(join(item.fakeRoot, "var/lib/nelos-proxmox-run-binding-cleanup")), /ENOENT/u);
});

test("cleanup resumes in a fresh process across every credential, binding, account, journal, receipt, and clear boundary", async (t) => {
  const item = await fixture(t); const installed = await install(item);
  const effects = [
    "revoke-provider-key", "revoke-attestor-key", "revoke-provider-sudo", "revoke-attestor-sudo",
    "remove-provider-ssh-directory", "remove-attestor-ssh-directory", "remove-provider-home", "remove-attestor-home",
    "remove-provider-account", "remove-attestor-account", "remove-lease-authority-binding", "remove-operator-binding",
    "remove-provider-binding", "remove-run-binding", "remove-installation-receipt", "remove-fake-account-state",
    "remove-empty-binding-directory", "confirm-exact-absence", "publish-cleanup-receipt",
  ];
  const crashes = ["before:intent", "after:intent", ...effects.flatMap((effect) => [`before:${effect}`, `after-effect:${effect}`, `after-journal:${effect}`]), "before:intent-clear", "after:intent-clear"];
  for (const [index, crash] of crashes.entries()) {
    const fakeRoot = join(item.work, `crash-root-${index}`); await mkdir(fakeRoot, { mode: 0o700 }); await exec("/bin/cp", ["-a", `${item.fakeRoot}/.`, fakeRoot]);
    const crashed = await run(["cleanup", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", fakeRoot, "--test-crash-at", crash]);
    assert.equal(crashed.code, 86, `${crash}: ${crashed.stderr}`); assert.match(crashed.stderr, /SYNTHETIC_CRASH/u, crash);
    const resumed = await run(["cleanup", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", fakeRoot]);
    assert.equal(resumed.code, 0, `${crash}: ${resumed.stderr}`); assert.equal(JSON.parse(resumed.stdout).removed, true, crash);
    const cleanupState = join(fakeRoot, "var/lib/nelos-proxmox-run-binding-cleanup");
    assert.deepEqual((await readdir(cleanupState)).filter((name) => name.endsWith(".intent.json")), [], crash);
    const adopted = await run(["cleanup", "--packet", item.packetPath, "--receipt", installed.receiptPath, "--fake-root", fakeRoot]);
    assert.equal(adopted.code, 0, `${crash}: ${adopted.stderr}`); assert.equal(JSON.parse(adopted.stdout).receiptSha256, JSON.parse(resumed.stdout).receiptSha256, crash);
  }
});

test("cleanup intent and terminal receipt schemas are closed over the executable effect graph", async () => {
  for (const name of ["proxmox-desktop-host-run-cleanup-intent.schema.json", "proxmox-desktop-host-run-cleanup-receipt.schema.json"]) {
    const schema = JSON.parse(await readFile(resolve("validation/proxmox-desktop/v1", name), "utf8"));
    assert.equal(schema.additionalProperties, false); assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  }
  const source = await readFile(helper, "utf8");
  for (const token of ["CLEANUP_INTENT_KIND", "CLEANUP_RECEIPT_KIND", "after-effect:", "after-journal:", "confirm-exact-absence", "publish-cleanup-receipt", "timeout=30"]) assert.match(source, new RegExp(token, "u"));
});
