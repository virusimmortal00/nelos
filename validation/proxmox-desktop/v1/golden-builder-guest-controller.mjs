import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJsonV1, sha256V1 } from "./build-golden-image.mjs";

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const INPUT_FIELDS = Object.freeze([
  "attestorTokenFile", "buildTokenFile", "nodeArchive", "packerArchive", "pluginArchive",
  "sourceRoot", "tlsCaFile", "volumeIdentityFile", "volumeKnownHostsFile",
]);

export class GoldenBuilderGuestControllerError extends Error {
  constructor(code, message, details = null) { super(message); this.name = "GoldenBuilderGuestControllerError"; this.code = code; this.details = details; }
}

function fail(code, message, details = null) { throw new GoldenBuilderGuestControllerError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTROLLER_ACCESS", `${label} fields differ from the closed contract`);
  return value;
}
function openSshFingerprint(publicKey) {
  const fields = typeof publicKey === "string" ? publicKey.split(" ") : [];
  if (fields.length !== 2 || fields[0] !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(fields[1])) return null;
  const bytes = Buffer.from(fields[1], "base64");
  if (bytes.length !== 51 || bytes.toString("base64") !== fields[1]) return null;
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/u, "")}`;
}

export function validateGoldenBuilderGuestControllerAccessV1(value) {
  exact(value, ["builderIdentityFile", "kind", "limits", "schemaVersion", "stagingRoot", "workspace"], "guestControllerAccess");
  exact(value.limits, ["maxOutputBytes", "operationTimeoutMs"], "guestControllerAccess.limits");
  exact(value.workspace, INPUT_FIELDS, "guestControllerAccess.workspace");
  if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-builder-guest-controller-access" ||
      !Number.isSafeInteger(value.limits.operationTimeoutMs) || value.limits.operationTimeoutMs < 60_000 || value.limits.operationTimeoutMs > 3_600_000 ||
      !Number.isSafeInteger(value.limits.maxOutputBytes) || value.limits.maxOutputBytes < 1_024 || value.limits.maxOutputBytes > 1_048_576) {
    fail("INVALID_CONTROLLER_ACCESS", "guest controller identity or limits differ");
  }
  for (const [name, path] of Object.entries({ builderIdentityFile: value.builderIdentityFile, stagingRoot: value.stagingRoot, ...value.workspace })) {
    if (!isAbsolute(path ?? "") || resolve(path) !== path || /[\0\r\n]/u.test(path)) fail("INVALID_CONTROLLER_ACCESS", `${name} path is not absolute and canonical`);
  }
  const names = Object.values(value.workspace).map((path) => basename(path));
  if (names.some((name) => !SAFE_NAME.test(name)) || new Set(names).size !== names.length) fail("INVALID_CONTROLLER_ACCESS", "workspace input basenames must be safe and unique");
  return value;
}

async function sealed(path, { directory = false, modes, label }) {
  const canonical = await realpath(path).catch(() => null);
  const info = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || canonical !== path || info?.isSymbolicLink() || (directory ? !info?.isDirectory() : (!info?.isFile() || info.nlink !== 1)) ||
      !modes.has(info.mode & 0o777) || info.uid !== process.getuid()) fail("UNSEALED_CONTROLLER_INPUT", `${label} is not one sealed caller-owned ${directory ? "directory" : "file"}`);
  return canonical;
}

function runBounded(command, args, { input = null, timeoutMs, maxOutputBytes, allowFailure = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    const stdout = []; const stderr = []; let length = 0; let overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const collect = (target) => (chunk) => { length += chunk.length; if (length > maxOutputBytes) { overflow = true; child.kill("SIGKILL"); } else target.push(chunk); };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    child.stdin.on("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return rejectPromise(Object.assign(new Error("guest controller output exceeded its bound"), { code: "OUTPUT_LIMIT" }));
      const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code !== 0 && !allowFailure) return rejectPromise(Object.assign(new Error("guest controller transport failed"), { code: signal ? "DEADLINE_EXPIRED" : "GUEST_CONTROLLER_FAILED" }));
      resolvePromise(result);
    });
    child.stdin.end(input ?? undefined);
  });
}

async function identityFingerprint(path) {
  const result = await runBounded("/usr/bin/ssh-keygen", ["-lf", path, "-E", "sha256"], { timeoutMs: 10_000, maxOutputBytes: 4_096 });
  const values = result.stdout.toString("utf8").trim().split(/\s+/u);
  if (!FINGERPRINT.test(values[1] ?? "")) fail("CONTROLLER_KEY_MISMATCH", "builder controller key fingerprint is unavailable");
  return values[1];
}

async function writeExclusive(path, bytes, mode) {
  const handle = await open(path, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(mode); } finally { await handle.close(); }
}

function sshOptions({ identityFile, knownHosts, address }) {
  return [
    "-F", "/dev/null", "-T", "-p", "22", "-o", "BatchMode=yes", "-o", "CanonicalizeHostname=no", "-o", "CheckHostIP=no",
    "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForwardAgent=no", "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "KbdInteractiveAuthentication=no", "-o", "NumberOfPasswordPrompts=0",
    "-o", "PasswordAuthentication=no", "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "RequestTTY=no",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-i", identityFile, "--", `codex@${address}`,
  ];
}

function scpOptions({ identityFile, knownHosts }) {
  return [
    "-F", "/dev/null", "-P", "22", "-o", "BatchMode=yes", "-o", "CanonicalizeHostname=no", "-o", "CheckHostIP=no",
    "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForwardAgent=no", "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "KbdInteractiveAuthentication=no", "-o", "NumberOfPasswordPrompts=0",
    "-o", "PasswordAuthentication=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`, "-i", identityFile,
  ];
}

export function createDefaultGoldenBuilderGuestBoundaryV1() {
  return Object.freeze({
    async invoke({ args, input = null, timeoutMs, maxOutputBytes, allowFailure = false }) {
      return runBounded("/usr/bin/ssh", args, { input, timeoutMs, maxOutputBytes, allowFailure });
    },
    async transfer({ args, timeoutMs, maxOutputBytes }) {
      return runBounded("/usr/bin/scp", args, { timeoutMs, maxOutputBytes });
    },
  });
}

export async function executeGoldenBuilderGuestControllerV1({ binding, bundle, controllerIdentity, packet, observation, access: inputAccess, cleanupOnly = false }, { boundary = createDefaultGoldenBuilderGuestBoundaryV1() } = {}) {
  const access = validateGoldenBuilderGuestControllerAccessV1(inputAccess);
  if (!plain(binding?.builderVm) || !SHA256.test(packet?.packetDigest ?? "") || packet?.packetDigest !== bundle?.builderPacket?.packetDigest || packet?.packetDigest !== controllerIdentity?.packetDigest ||
      observation?.status !== "running" || observation?.guest?.hostKeyFingerprint !== packet?.builderVm?.sshHostFingerprint ||
      typeof observation?.guest?.sshAddress !== "string" || /\s/u.test(observation.guest.sshAddress) ||
      typeof observation?.guest?.hostPublicKey !== "string" || /[\r\n]/u.test(observation.guest.hostPublicKey) ||
      openSshFingerprint(observation.guest.hostPublicKey) !== packet?.builderVm?.sshHostFingerprint ||
      typeof cleanupOnly !== "boolean" || typeof boundary?.invoke !== "function" || typeof boundary?.transfer !== "function") {
    fail("INVALID_CONTROLLER_INVOCATION", "guest controller input identities differ");
  }
  const [identityFile, stagingRoot, sourceRoot] = await Promise.all([
    sealed(access.builderIdentityFile, { modes: new Set([0o400, 0o600]), label: "builder private key" }),
    sealed(access.stagingRoot, { directory: true, modes: new Set([0o700]), label: "controller staging root" }),
    sealed(access.workspace.sourceRoot, { directory: true, modes: new Set([0o700]), label: "source checkout" }),
  ]);
  if (await identityFingerprint(identityFile) !== binding.builderVm.sshPublicKeyFingerprint) fail("CONTROLLER_KEY_MISMATCH", "builder controller private key differs from the lifecycle binding");
  for (const name of INPUT_FIELDS.filter((name) => name !== "sourceRoot")) await sealed(access.workspace[name], { modes: new Set([0o400, 0o440, 0o600, 0o640]), label: name });
  const runName = packet.packetDigest.slice(7);
  const localRun = join(stagingRoot, runName);
  await mkdir(localRun, { recursive: true, mode: 0o700 }); await chmod(localRun, 0o700);
  const knownHosts = join(localRun, "known-hosts");
  const bundlePath = join(localRun, "builder-bundle.json");
  const identityPath = join(localRun, "controller-identity.json");
  for (const [path, bytes, mode] of [
    [knownHosts, Buffer.from(`${observation.guest.sshAddress} ${observation.guest.hostPublicKey}\n`), 0o600],
    [bundlePath, Buffer.from(`${canonicalJsonV1(bundle)}\n`), 0o400],
    [identityPath, Buffer.from(`${canonicalJsonV1(controllerIdentity)}\n`), 0o400],
  ]) {
    try { await writeExclusive(path, bytes, mode); }
    catch (error) { if (error.code !== "EEXIST" || !(await readFile(path)).equals(bytes)) throw error; }
  }
  const ssh = sshOptions({ identityFile, knownHosts, address: observation.guest.sshAddress });
  const remoteRoot = `/var/lib/nelos-golden-controller/${runName}`;
  const timeoutMs = access.limits.operationTimeoutMs; const maxOutputBytes = access.limits.maxOutputBytes;
  const sourceRemote = `${remoteRoot}/${basename(sourceRoot)}`;
  const stateRemote = `${remoteRoot}/state`; const attestationRemote = `${remoteRoot}/attestation`; const terminalRemote = `${remoteRoot}/terminal`;
  const terminalPath = `${remoteRoot}/terminal/${runName}.json`;
  const cleanupPath = `${remoteRoot}/terminal/${runName}.cleanup.json`;
  const remote = (path) => `${remoteRoot}/${basename(path)}`;
  const readyPath = `${stateRemote}/controller-ready`;
  const readyBytes = Buffer.from(`${packet.packetDigest}\n`);
  const ambiguous = (message, error, phase) => fail("CONTROLLER_OUTCOME_AMBIGUOUS", message, { causeCode: error?.code ?? "TRANSPORT_FAILED", phase });
  const probeReady = async () => {
    let result;
    try {
      result = await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/cat", readyPath], timeoutMs: 30_000, maxOutputBytes: 4_096, allowFailure: true });
    } catch (error) { ambiguous("guest controller staging state could not be reconciled", error, "ready-probe"); }
    if (result?.code === 1) {
      let absent;
      try {
        absent = await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/test", "!", "-e", readyPath], timeoutMs: 30_000, maxOutputBytes: 4_096, allowFailure: true });
      } catch (error) { ambiguous("guest controller staging-marker absence could not be proven", error, "ready-absence"); }
      if (absent?.code === 0) return false;
      ambiguous("guest controller staging marker exists but cannot be read exactly", Object.assign(new Error("ready marker unreadable"), { code: "CONTROLLER_STAGING_UNPROVEN" }), "ready-absence");
    }
    if (result?.code !== 0 || !Buffer.isBuffer(result.stdout) || !result.stdout.equals(readyBytes)) {
      ambiguous("guest controller staging marker is unavailable or belongs to another packet", Object.assign(new Error("ready marker differs"), { code: "CONTROLLER_STAGING_UNPROVEN" }), "ready-probe");
    }
    return true;
  };

  let ready = await probeReady();
  if (!ready) {
    await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/bin/rm", "-rf", "--one-file-system", "--", remoteRoot], timeoutMs: 60_000, maxOutputBytes });
    await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/install", "-d", "-o", "codex", "-g", "codex", "-m", "0700", remoteRoot], timeoutMs: 30_000, maxOutputBytes });
    const transferPaths = [bundlePath, identityPath, sourceRoot, ...INPUT_FIELDS.filter((name) => name !== "sourceRoot").map((name) => access.workspace[name])];
    await boundary.transfer({ args: ["-r", ...scpOptions({ identityFile, knownHosts }), ...transferPaths, `codex@${observation.guest.sshAddress}:${remoteRoot}/`], timeoutMs, maxOutputBytes });
    await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/bin/chown", "-R", "root:root", remoteRoot], timeoutMs: 60_000, maxOutputBytes });
    await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/install", "-d", "-o", "root", "-g", "root", "-m", "0700", stateRemote, attestationRemote, terminalRemote], timeoutMs: 30_000, maxOutputBytes });
    await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/bin/chmod", "0700", remoteRoot, sourceRemote], timeoutMs: 30_000, maxOutputBytes });
    try {
      await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/install", "-o", "root", "-g", "root", "-m", "0400", "/dev/stdin", readyPath], input: readyBytes, timeoutMs: 30_000, maxOutputBytes });
      await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/sync", "-f", readyPath], timeoutMs: 30_000, maxOutputBytes });
      await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/sync", "-f", stateRemote], timeoutMs: 30_000, maxOutputBytes });
    } catch (error) {
      ready = await probeReady();
      if (ready) ambiguous("guest controller staging marker publication has an ambiguous durable outcome", error, "ready-publish");
      throw error;
    }
    ready = true;
  } else {
    try {
      await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/sync", "-f", readyPath], timeoutMs: 30_000, maxOutputBytes });
      await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/sync", "-f", stateRemote], timeoutMs: 30_000, maxOutputBytes });
    } catch (error) { ambiguous("existing guest controller staging marker could not be made durable", error, "ready-sync"); }
  }

  const controllerRequest = { args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    `NELOS_GOLDEN_BUILDER_BUNDLE=${remote(bundlePath)}`, `NELOS_GOLDEN_CONTROLLER_IDENTITY=${remote(identityPath)}`, `NELOS_GOLDEN_SOURCE_ROOT=${sourceRemote}`,
    `NELOS_GOLDEN_NODE_ARCHIVE=${remote(access.workspace.nodeArchive)}`, `NELOS_GOLDEN_PACKER_ARCHIVE=${remote(access.workspace.packerArchive)}`,
    `NELOS_GOLDEN_PLUGIN_ARCHIVE=${remote(access.workspace.pluginArchive)}`, `NELOS_GOLDEN_BUILD_TOKEN_FILE=${remote(access.workspace.buildTokenFile)}`,
    `NELOS_GOLDEN_ATTEST_TOKEN_FILE=${remote(access.workspace.attestorTokenFile)}`, `NELOS_GOLDEN_TLS_CA_FILE=${remote(access.workspace.tlsCaFile)}`,
    `NELOS_GOLDEN_VOLUME_KNOWN_HOSTS=${remote(access.workspace.volumeKnownHostsFile)}`, `NELOS_GOLDEN_VOLUME_IDENTITY_FILE=${remote(access.workspace.volumeIdentityFile)}`,
    `NELOS_GOLDEN_STATE_DIR=${stateRemote}`, `NELOS_GOLDEN_ATTESTATION_DIR=${attestationRemote}`, `NELOS_GOLDEN_TERMINAL_RECEIPT=${terminalPath}`,
    `NELOS_GOLDEN_CLEANUP_RECEIPT=${cleanupPath}`, `NELOS_GOLDEN_OPERATION=${cleanupOnly ? "cleanup" : "run"}`,
    "/bin/bash", `${sourceRemote}/validation/proxmox-desktop/v1/run-golden-builder-controller.sh`], timeoutMs, maxOutputBytes };
  try {
    const result = await boundary.invoke(controllerRequest);
    if (result?.code !== 0) ambiguous("guest controller process returned without a proven terminal outcome", Object.assign(new Error("controller failed"), { code: "GUEST_CONTROLLER_FAILED" }), "controller-process");
  } catch (error) {
    if (error?.code === "CONTROLLER_OUTCOME_AMBIGUOUS") throw error;
    ambiguous("guest controller transport or process outcome is ambiguous after durable staging", error, "controller-process");
  }
  let result;
  try {
    result = await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/cat", terminalPath], timeoutMs: 30_000, maxOutputBytes, allowFailure: cleanupOnly });
  } catch (error) { ambiguous("guest controller terminal publication could not be read after process success", error, "terminal-read"); }
  if (result?.code === 0 && Buffer.isBuffer(result.stdout)) {
    try { return JSON.parse(result.stdout); }
    catch (error) { ambiguous("guest controller terminal publication is partial or invalid and requires journal recovery", Object.assign(error, { code: "CONTROLLER_RECEIPT_INVALID" }), "terminal-parse"); }
  }
  if (!cleanupOnly) ambiguous("guest controller terminal publication is unavailable after process success", Object.assign(new Error("terminal unavailable"), { code: "CONTROLLER_RECEIPT_UNAVAILABLE" }), "terminal-read");
  let cleanup;
  try { cleanup = await boundary.invoke({ args: [...ssh, "/usr/bin/sudo", "-n", "--", "/usr/bin/cat", cleanupPath], timeoutMs: 30_000, maxOutputBytes }); }
  catch (error) { ambiguous("guest cleanup terminal publication could not be read after process success", error, "cleanup-read"); }
  if (cleanup?.code !== 0 || !Buffer.isBuffer(cleanup.stdout)) ambiguous("guest cleanup terminal publication is unavailable after process success", Object.assign(new Error("cleanup terminal unavailable"), { code: "CONTROLLER_RECEIPT_UNAVAILABLE" }), "cleanup-read");
  let parsed;
  try { parsed = JSON.parse(cleanup.stdout); } catch (error) { ambiguous("guest cleanup terminal publication is malformed", Object.assign(error, { code: "CONTROLLER_RECEIPT_INVALID" }), "cleanup-parse"); }
  exact(parsed, ["cleanupDigest", "completedAt", "kind", "packetDigest", "reservationDigest", "result", "schemaVersion"], "guestCleanupTerminal");
  const { cleanupDigest, ...unsigned } = parsed;
  if (parsed.schemaVersion !== 1 || parsed.kind !== "nelos-golden-builder-cleanup-terminal" || parsed.result !== "cleaned" ||
      parsed.packetDigest !== packet.packetDigest || parsed.reservationDigest !== packet.reservationDigest ||
      !Number.isFinite(Date.parse(parsed.completedAt)) || cleanupDigest !== sha256V1(unsigned)) {
    ambiguous("guest cleanup terminal publication identity differs", Object.assign(new Error("cleanup receipt differs"), { code: "CONTROLLER_RECEIPT_INVALID" }), "cleanup-validate");
  }
  return parsed;
}
