import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4})$/u;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const PRODUCTION_PROXMOX_LANE_V1 = Object.freeze({ gatewayId: "9023", hostId: "prox2", networkId: "nelosbld", providerId: "proxmox-lab" });

function die(exitCode, code, message) {
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exit(exitCode);
}

async function sealedFile(path, label, modes) {
  let info;
  try { info = await lstat(path); } catch { die(78, "CONTROLLER_CONFIG_INVALID", `${label} file is unavailable`); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !modes.has(info.mode & 0o777)) die(78, "CONTROLLER_CONFIG_INVALID", `${label} file is not a sealed regular file`);
  return { canonicalPath: await realpath(path), info };
}

async function identityFingerprint(path, label) {
  let output;
  try {
    ({ stdout: output } = await exec("/usr/bin/ssh-keygen", ["-lf", path, "-E", "sha256"], {
      encoding: "utf8", maxBuffer: 16_384, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    }));
  } catch { die(78, "CONTROLLER_CONFIG_INVALID", `${label} fingerprint cannot be verified`); }
  const lines = output.trim().split(/\r?\n/u).filter(Boolean);
  const fields = lines.length === 1 ? lines[0].trim().split(/\s+/u) : [];
  if (fields.length < 4 || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(fields[1] ?? "")) die(78, "CONTROLLER_CONFIG_INVALID", `${label} fingerprint is invalid`);
  return fields[1];
}

function exactReadOnlyRequest(envelope, sourceTemplateVmId) {
  const request = envelope?.request;
  if (!request || Object.keys(request).sort().join("\0") !== ["method", "path"].join("\0") || request.method !== "GET" || typeof request.path !== "string") return false;
  let url;
  try { url = new URL(request.path, "https://proxmox.invalid"); } catch { return false; }
  const host = encodeURIComponent(envelope.binding.hostId);
  const vmid = encodeURIComponent(envelope.binding.vmId);
  const source = encodeURIComponent(sourceTemplateVmId);
  if (url.pathname === "/nelos/lease-authority/current" && url.search === "") return true;
  if (url.pathname === "/nelos/network/mac-absence" && url.search === "") return true;
  if (url.pathname === "/nelos/network/policy" && url.search === "") return true;
  if (url.pathname === `/nodes/${host}/qemu/${vmid}/config` && url.search === "") return true;
  if ([`/nodes/${host}/qemu/${source}/config`, `/nodes/${host}/qemu/${source}/status/current`].includes(url.pathname) && url.search === "") return true;
  return url.pathname === "/cluster/resources" && url.searchParams.size === 1 && url.searchParams.get("type") === "vm";
}

export async function runProxmoxSshTransportV1({ mode }) {
  if (!new Set(["provider", "attestor"]).has(mode) || process.argv.length !== 3 || process.argv[2] !== "request") die(64, "INVALID_OPERATION", "only the fixed request operation is supported");
  const prefix = mode === "provider" ? "NELOS_PROXMOX" : "NELOS_PROXMOX_ATTEST";
  const value = (suffix) => process.env[`${prefix}_${suffix}`];
  for (const suffix of ["SSH_HOST", "SSH_USER", "KNOWN_HOSTS", "IDENTITY_FILE", "HOST_FINGERPRINT", "HOST_ID", "GATEWAY_ID", "MAC_ADDRESS", "NETWORK_ID", "NETWORK_POLICY_DIGEST", "PROVIDER_ID", "SOURCE_TEMPLATE_VM_ID"]) if (!value(suffix)) die(78, "CONTROLLER_CONFIG_REQUIRED", `${prefix}_${suffix} is required`);
  const host = value("SSH_HOST"); const user = value("SSH_USER"); const port = value("SSH_PORT") ?? "22";
  const knownHosts = value("KNOWN_HOSTS"); const identityFile = value("IDENTITY_FILE"); const expectedFingerprint = value("HOST_FINGERPRINT");
  if (!HOST.test(host) || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(user) || !/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65_535 || !isAbsolute(knownHosts) || !isAbsolute(identityFile) || !FINGERPRINT.test(expectedFingerprint) || !ID.test(value("HOST_ID")) || !/^[1-9][0-9]{2,8}$/u.test(value("GATEWAY_ID")) || !/^02(?::[0-9A-F]{2}){5}$/u.test(value("MAC_ADDRESS")) || !ID.test(value("NETWORK_ID")) || !/^sha256:[0-9a-f]{64}$/u.test(value("NETWORK_POLICY_DIGEST")) || !ID.test(value("PROVIDER_ID")) || !/^[1-9][0-9]{2,8}$/u.test(value("SOURCE_TEMPLATE_VM_ID")) || value("GATEWAY_ID") === value("SOURCE_TEMPLATE_VM_ID") || value("GATEWAY_ID") !== PRODUCTION_PROXMOX_LANE_V1.gatewayId || value("HOST_ID") !== PRODUCTION_PROXMOX_LANE_V1.hostId || value("NETWORK_ID") !== PRODUCTION_PROXMOX_LANE_V1.networkId || value("PROVIDER_ID") !== PRODUCTION_PROXMOX_LANE_V1.providerId) die(78, "CONTROLLER_CONFIG_INVALID", "the external Proxmox controller identity is invalid or differs from the fixed prox2 gateway VM 9023 and nelosbld VNet lane");
  await sealedFile(knownHosts, "known-hosts", new Set([0o400, 0o440, 0o600, 0o640]));
  const identity = await sealedFile(identityFile, "identity", new Set([0o400, 0o600]));
  if (mode === "attestor") {
    if (!process.env.NELOS_PROXMOX_IDENTITY_FILE) die(78, "INDEPENDENT_ATTESTOR_REQUIRED", "the provider credential is required for independence verification");
    if (process.env.NELOS_PROXMOX_SOURCE_TEMPLATE_VM_ID !== value("SOURCE_TEMPLATE_VM_ID")) die(78, "INDEPENDENT_ATTESTOR_REQUIRED", "provider and attestor source-template identities differ");
    const providerIdentity = await sealedFile(process.env.NELOS_PROXMOX_IDENTITY_FILE, "provider identity", new Set([0o400, 0o600]));
    if (identity.canonicalPath === providerIdentity.canonicalPath || (identity.info.dev === providerIdentity.info.dev && identity.info.ino === providerIdentity.info.ino)) die(78, "INDEPENDENT_ATTESTOR_REQUIRED", "attestation and provider credentials must be distinct files");
    const [attestorFingerprint, providerFingerprint] = await Promise.all([
      identityFingerprint(identity.canonicalPath, "attestation identity"),
      identityFingerprint(providerIdentity.canonicalPath, "provider identity"),
    ]);
    if (attestorFingerprint === providerFingerprint) die(78, "INDEPENDENT_ATTESTOR_REQUIRED", "attestation and provider credentials must be distinct keys");
  }
  let fingerprintOutput;
  try { ({ stdout: fingerprintOutput } = await exec("/usr/bin/ssh-keygen", ["-lf", knownHosts, "-E", "sha256"], { encoding: "utf8", maxBuffer: 16_384, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } })); }
  catch { die(78, "CONTROLLER_CONFIG_INVALID", "known-hosts fingerprint cannot be verified"); }
  const observedFingerprints = fingerprintOutput.trim().split(/\r?\n/u).filter(Boolean).map((line) => line.trim().split(/\s+/u)[1]);
  if (observedFingerprints.length === 0 || observedFingerprints.some((item) => item !== expectedFingerprint)) die(78, "HOST_KEY_MISMATCH", "known-hosts does not contain only the approved host key");

  const chunks = []; let inputLength = 0;
  for await (const chunk of process.stdin) { inputLength += chunk.length; if (inputLength > 16_777_216) die(65, "INPUT_LIMIT", "controller request exceeds 16 MiB"); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  let envelope;
  try { envelope = JSON.parse(bytes); } catch { bytes.fill(0); die(65, "INVALID_CONTRACT", "controller request is not valid JSON"); }
  if (envelope?.schemaVersion !== 1 || envelope?.binding?.hostId !== value("HOST_ID") || envelope?.binding?.gatewayId !== value("GATEWAY_ID") || envelope?.binding?.macAddress !== value("MAC_ADDRESS") || envelope?.binding?.networkId !== value("NETWORK_ID") || envelope?.binding?.networkPolicyDigest !== value("NETWORK_POLICY_DIGEST") || envelope?.binding?.providerId !== value("PROVIDER_ID") || !Number.isSafeInteger(envelope.maxOutputBytes) || envelope.maxOutputBytes < 1 || envelope.maxOutputBytes > 16_777_216) { bytes.fill(0); die(77, "IDENTITY_MISMATCH", "controller request is not bound to the approved provider, host, gateway, MAC, VNet, and network policy"); }
  if ([value("SOURCE_TEMPLATE_VM_ID"), value("GATEWAY_ID")].includes(String(envelope.binding?.vmId))) { bytes.fill(0); die(77, "IDENTITY_MISMATCH", "reserved VMID conflicts with the approved source template or gateway"); }
  if (mode === "attestor" && !exactReadOnlyRequest(envelope, value("SOURCE_TEMPLATE_VM_ID"))) { bytes.fill(0); die(77, "READ_ONLY_ATTESTATION_REQUIRED", "attestation transport accepts only exact provider inventory reads"); }
  const remaining = Date.parse(envelope.deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 600_000) { bytes.fill(0); die(75, "DEADLINE_EXPIRED", "controller deadline is invalid"); }

  const remoteHelper = mode === "provider" ? "/usr/libexec/nelos-proxmox-transport" : "/usr/libexec/nelos-proxmox-attest";
  const args = [
    "-F", "/dev/null", "-T", "-p", port,
    "-o", "BatchMode=yes", "-o", "CanonicalizeHostname=no", "-o", "CheckHostIP=no", "-o", "ClearAllForwardings=yes",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForwardAgent=no", "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "KbdInteractiveAuthentication=no", "-o", "NumberOfPasswordPrompts=0",
    "-o", "PasswordAuthentication=no", "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none",
    "-o", "RequestTTY=no", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`,
    "-i", identityFile, "--", `${user}@${host}`, "/usr/bin/sudo", "-n", remoteHelper, "request",
  ];
  const child = spawn("/usr/bin/ssh", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  const output = []; let outputLength = 0; let exceeded = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), remaining);
  child.stdout.on("data", (chunk) => { outputLength += chunk.length; if (outputLength > envelope.maxOutputBytes) { exceeded = true; child.kill("SIGKILL"); } else output.push(chunk); });
  child.stderr.on("data", () => {});
  child.stdin.end(bytes, () => bytes.fill(0));
  child.once("error", () => { clearTimeout(timer); die(69, "TRANSPORT_UNAVAILABLE", "the pinned Proxmox SSH transport is unavailable"); });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    if (exceeded) die(75, "OUTPUT_LIMIT", "remote helper output exceeded its admitted bound");
    if (code === 44) process.exit(44);
    if (code !== 0) die(signal ? 75 : 70, signal ? "DEADLINE_EXPIRED" : "REMOTE_HELPER_FAILED", "the bounded remote Proxmox helper failed");
    process.stdout.write(Buffer.concat(output));
  });
}
