import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { installFakeProxmoxLeaseAuthority } from "./support/fake-proxmox-lease-authority.mjs";

const identitySource = resolve("validation/proxmox/desktop/helpers/nelos-desktop-identity.py");
const hostHelper = resolve("validation/proxmox/desktop/helpers/nelos-proxmox-host-helper.py");
const packageLockSource = resolve("validation/proxmox-desktop/v1/package-lock.json");

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function run(command, args, { env = {}, input = "" } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({
      code,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
    child.stdin.end(input);
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-installed-identity-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const mapped = (path) => join(root, path.slice(1));
  for (const directory of [
    "/opt/nelos-desktop", "/usr/libexec", "/usr/lib/chatgpt/resources/cua_node/bin", "/usr/bin", "/run",
  ]) {
    await mkdir(mapped(directory), { mode: 0o755, recursive: true });
    await chown(mapped(directory), process.getuid(), process.getgid());
  }

  const identity = mapped("/usr/libexec/nelos-desktop-identity");
  await copyFile(identitySource, identity);
  await chmod(identity, 0o755);
  await chown(identity, process.getuid(), process.getgid());

  const uaPath = join(root, "user-agent.txt");
  const codexVersionPath = join(root, "codex-version.txt");
  const nodeVersionPath = join(root, "node-version.txt");
  const packageVersionPath = join(root, "package-version.txt");
  await writeFile(uaPath, "Codex Desktop/0.148.0-alpha.15\n");
  await writeFile(codexVersionPath, "codex-cli 0.148.0-alpha.15\n");
  await writeFile(nodeVersionPath, "v24.19.0\n");
  await writeFile(packageVersionPath, "26.814.41957\n");

  const codex = mapped("/usr/lib/chatgpt/resources/codex");
  const codexBytes = `#!${process.execPath}
import { readFileSync } from "node:fs";
import readline from "node:readline";
const uaPath = ${JSON.stringify(uaPath)};
const versionPath = ${JSON.stringify(codexVersionPath)};
if (process.argv[2] === "--version") {
  process.stdout.write(readFileSync(versionPath));
} else {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) process.exit(91);
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["app-server","--stdio","--strict-config","-c",'cli_auth_credentials_store="file"'])) process.exit(92);
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const value = JSON.parse(line);
    const expected = { capabilities: { experimentalApi: true, requestAttestation: false }, clientInfo: { name: "nelos_desktop_identity", version: "1.0.0" } };
    if (value.id !== 1 || value.method !== "initialize" || JSON.stringify(value.params) !== JSON.stringify(expected)) process.exit(93);
    process.stdout.write(JSON.stringify({ id: 1, result: { codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux", userAgent: readFileSync(uaPath, "utf8").trim() } }) + "\\n");
  });
}
`;
  await writeFile(codex, codexBytes);
  await chmod(codex, 0o755);
  await chown(codex, process.getuid(), process.getgid());

  const node = mapped("/usr/lib/chatgpt/resources/cua_node/bin/node");
  const nodeBytes = `#!${process.execPath}\nimport { readFileSync } from "node:fs"; process.stdout.write(readFileSync(${JSON.stringify(nodeVersionPath)}));\n`;
  await writeFile(node, nodeBytes);
  await chmod(node, 0o755);
  await chown(node, process.getuid(), process.getgid());

  const dpkgQuery = mapped("/usr/bin/dpkg-query");
  await writeFile(dpkgQuery, `#!${process.execPath}
import { readFileSync } from "node:fs";
process.stdout.write("chatgpt\\t" + readFileSync(${JSON.stringify(packageVersionPath)}, "utf8").trim() + "\\tamd64\\tinstall ok installed\\n");
`);
  await chmod(dpkgQuery, 0o755);
  await chown(dpkgQuery, process.getuid(), process.getgid());

  const deb = join(root, "chatgpt.deb");
  const debBytes = Buffer.from("sealed Desktop package fixture\n");
  await writeFile(deb, debBytes, { mode: 0o600 });
  await chown(deb, process.getuid(), process.getgid());
  const lock = JSON.parse(await readFile(packageLockSource, "utf8"));
  lock.artifacts.chatgptDesktop.digest = sha256(debBytes);
  lock.artifacts.chatgptDesktop.bundledCodexDigest = sha256(codexBytes);
  lock.artifacts.chatgptDesktop.bundledNodeDigest = sha256(nodeBytes);
  const packageLock = mapped("/opt/nelos-desktop/package-lock.json");
  await writeFile(packageLock, `${JSON.stringify(lock, null, 2)}\n`);
  await chmod(packageLock, 0o444);
  await chown(packageLock, process.getuid(), process.getgid());
  const packageLockBytes = await readFile(packageLock);
  const lockDigest = sha256(packageLockBytes);
  const env = {
    CODEX_API_KEY: "must-not-reach-app-server",
    NELOS_DESKTOP_IDENTITY_EXPECT_GID: String(process.getgid()),
    NELOS_DESKTOP_IDENTITY_EXPECT_UID: String(process.getuid()),
    NELOS_DESKTOP_IDENTITY_PACKAGE_LOCK_SHA256: lockDigest,
    NELOS_DESKTOP_IDENTITY_ROOT: root,
    OPENAI_API_KEY: "must-not-reach-app-server",
  };
  return {
    codex, codexBytes, codexVersionPath, deb, env, identity, lock, mapped,
    node, nodeBytes, nodeVersionPath, packageLock, packageLockBytes, packageVersionPath, root, uaPath,
  };
}

async function bake(paths) {
  return run("/usr/bin/python3", [identitySource, "bake", paths.deb], { env: paths.env });
}

async function verify(paths, env = paths.env) {
  return run("/usr/bin/python3", [identitySource], { env });
}

test("bake receipt and pre-auth app-server probe bind the exact installed Desktop identity", async (t) => {
  const paths = await fixture(t);
  const baked = await bake(paths);
  assert.equal(baked.code, 0, baked.stderr);
  assert.deepEqual(JSON.parse(baked.stdout), {
    bakeDigest: JSON.parse(await readFile(paths.mapped("/opt/nelos-desktop/bake-receipt.json"), "utf8")).bakeDigest,
    kind: "nelos-desktop-bake-complete",
    schemaVersion: 1,
  });
  const checked = await verify(paths);
  assert.equal(checked.code, 0, checked.stderr);
  const identity = JSON.parse(checked.stdout);
  assert.equal(identity.verified, true);
  assert.deepEqual(identity.appServer, {
    platformFamily: "unix",
    platformOs: "linux",
    userAgent: "Codex Desktop/0.148.0-alpha.15",
  });
  assert.equal(identity.desktopPackage.version, "26.814.41957");
  assert.equal(identity.bundledCodex.path, "/usr/lib/chatgpt/resources/codex");
  assert.equal(identity.bundledNode.path, "/usr/lib/chatgpt/resources/cua_node/bin/node");
  assert.doesNotMatch(checked.stdout, /OPENAI_API_KEY|must-not-reach/u);
});

test("installed identity fails closed on package, binary, metadata, receipt, or user-agent mutation", async (t) => {
  const paths = await fixture(t);
  assert.equal((await bake(paths)).code, 0);

  await writeFile(paths.packageVersionPath, "26.814.41958\n");
  let rejected = await verify(paths);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /package identity differs/u);
  await writeFile(paths.packageVersionPath, "26.814.41957\n");

  await writeFile(paths.codexVersionPath, "codex-cli 0.148.0-alpha.16\n");
  rejected = await verify(paths);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /Codex version differs/u);
  await writeFile(paths.codexVersionPath, "codex-cli 0.148.0-alpha.15\n");

  await writeFile(paths.nodeVersionPath, "v24.19.1\n");
  rejected = await verify(paths);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /Node version differs/u);
  await writeFile(paths.nodeVersionPath, "v24.19.0\n");

  await writeFile(paths.codex, `${paths.codexBytes}\n`); await chmod(paths.codex, 0o755);
  rejected = await verify(paths);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /Codex digest differs/u);
  await writeFile(paths.codex, paths.codexBytes); await chmod(paths.codex, 0o755);

  await writeFile(paths.node, `${paths.nodeBytes}\n`); await chmod(paths.node, 0o755);
  rejected = await verify(paths);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /Node digest differs/u);
  await writeFile(paths.node, paths.nodeBytes); await chmod(paths.node, 0o755);

  await chmod(paths.codex, 0o775);
  rejected = await verify(paths);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /Codex ownership, mode/u);
  await chmod(paths.codex, 0o755);

  rejected = await verify(paths, { ...paths.env, NELOS_DESKTOP_IDENTITY_EXPECT_UID: String(process.getuid() + 1) });
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /ownership, mode/u);

  await writeFile(paths.uaPath, "Codex Desktop/0.148.0-alpha.15 (Linux; x86_64)\n");
  rejected = await verify(paths);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /initialize identity differs/u);
  await writeFile(paths.uaPath, "Codex Desktop/0.148.0-alpha.15\n");

  const wrongPathLock = JSON.parse(paths.packageLockBytes);
  wrongPathLock.artifacts.chatgptDesktop.bundledCodexPath = "/tmp/codex";
  await chmod(paths.packageLock, 0o644);
  await writeFile(paths.packageLock, `${JSON.stringify(wrongPathLock, null, 2)}\n`);
  await chmod(paths.packageLock, 0o444);
  const wrongPathEnv = { ...paths.env, NELOS_DESKTOP_IDENTITY_PACKAGE_LOCK_SHA256: sha256(await readFile(paths.packageLock)) };
  rejected = await verify(paths, wrongPathEnv);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /package lock identity differs/u);
  await chmod(paths.packageLock, 0o644);
  await writeFile(paths.packageLock, paths.packageLockBytes);
  await chmod(paths.packageLock, 0o444);

  const receiptPath = paths.mapped("/opt/nelos-desktop/bake-receipt.json");
  await chmod(receiptPath, 0o644);
  rejected = await verify(paths);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /bake receipt ownership, mode/u);
});

test("bake refuses altered package bytes and is one-shot", async (t) => {
  const altered = await fixture(t);
  await writeFile(altered.deb, "altered package bytes\n");
  let rejected = await bake(altered);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /package digest differs/u);

  const oneShot = await fixture(t);
  assert.equal((await bake(oneShot)).code, 0);
  rejected = await bake(oneShot);
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /created exclusively/u);
});

test("PVE transport exposes only the fixed zero-argument installed-identity QGA operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-installed-identity-qga-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "etc/nelos-desktop"), { recursive: true });
  const binding = {
    automationUser: "nelosauto", fencingToken: "fence-identity", gatewayId: "9023", hostId: "prox2", imageId: "desktop-image-v1",
    leaseId: "lease-identity", macAddress: "02:4E:45:4C:90:51", networkId: "nelosbld",
    networkPolicyDigest: `sha256:${"9".repeat(64)}`, providerId: "proxmox-lab", runId: "run-identity",
    stateRoot: "/var/lib/nelos-desktop/runs/run-identity", vmId: "9051",
  };
  await writeFile(join(root, "etc/nelos-desktop/run-binding.json"), JSON.stringify(binding));
  await writeFile(join(root, "etc/nelos-desktop/provider.json"), JSON.stringify({ gatewayId: binding.gatewayId, hostId: "prox2", networkId: binding.networkId, networkPolicyDigest: binding.networkPolicyDigest, networkPolicyObserverDigest: `sha256:${"8".repeat(64)}`, providerId: "proxmox-lab", sourceTemplateVmId: "9025" }));
  const log = join(root, "pvesh.log");
  const pvesh = join(root, "pvesh.mjs");
  await writeFile(pvesh, `#!${process.execPath}\nimport { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n"); process.stdout.write('{"pid":71}');\n`);
  await chmod(pvesh, 0o755);
  const leaseAuthority = await installFakeProxmoxLeaseAuthority({ root, binding });
  const envelope = {
    binding,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    maxOutputBytes: 65_536,
    request: {
      body: { "capture-output": 1, command: "/usr/libexec/nelos-desktop-identity", "extra-args": [] },
      method: "POST",
      path: "/nodes/prox2/qemu/9051/agent/exec",
    },
    schemaVersion: 1,
  };
  const env = { NELOS_DESKTOP_HELPER_ROOT: root, NELOS_PVESH: pvesh, ...leaseAuthority.env };
  const accepted = await run("/usr/bin/python3", [hostHelper, "request"], { env, input: JSON.stringify(envelope) });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { data: { pid: 71 } });
  assert.match(await readFile(log, "utf8"), /nelos-desktop-identity/u);

  const argument = structuredClone(envelope);
  argument.request.body["extra-args"] = ["bake", "/tmp/untrusted.deb"];
  let rejected = await run("/usr/bin/python3", [hostHelper, "request"], { env, input: JSON.stringify(argument) });
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /arguments are not allowlisted/u);

  const inputData = structuredClone(envelope);
  inputData.request.body["input-data"] = "e30=";
  rejected = await run("/usr/bin/python3", [hostHelper, "request"], { env, input: JSON.stringify(inputData) });
  assert.equal(rejected.code, 77); assert.match(rejected.stderr, /body fields differ/u);
});

test("both golden-image installers bake the helper before device auth and seal its source", async () => {
  const [provision, recipe, deviceAuth, identityHelper, wrapper] = await Promise.all([
    readFile(resolve("validation/proxmox-desktop/v1/provision-golden-image.sh"), "utf8"),
    readFile(resolve("validation/proxmox/desktop/recipe-v1/install-guest.sh"), "utf8"),
    readFile(resolve("validation/proxmox/desktop/helpers/device-auth.sh"), "utf8"),
    readFile(resolve("validation/proxmox/desktop/helpers/nelos-desktop-identity.py"), "utf8"),
    readFile(resolve("validation/proxmox-desktop/v1/build-golden-image.mjs"), "utf8"),
  ]);
  for (const installer of [provision, recipe]) {
    assert.match(installer, /install .*nelos-desktop-identity/u);
    assert.match(installer, /nelos-desktop-identity bake/u);
  }
  assert.match(identityHelper, /BAKE_RECEIPT_PATH = "\/opt\/nelos-desktop\/bake-receipt\.json"/u);
  assert.match(deviceAuth, /start\)\s+assert_no_core_policy\s+assert_installed_identity\s+assert_no_developer_state/u);
  assert.match(deviceAuth, /status\)\s+assert_no_core_policy\s+assert_installed_identity\s+assert_no_developer_state/u);
  assert.match(wrapper, /export const SEALED_SOURCE_PATHS_V1/u);
  assert.match(wrapper, /validation\/proxmox\/desktop\/helpers\/nelos-desktop-identity\.py/u);
});
