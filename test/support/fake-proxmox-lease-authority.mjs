import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalLeaseAuthorityBytesV1, leaseAuthoritySha256V1 } from "../../src/proxmox-lease-authority.mjs";

const exec = promisify(execFile);
const source = resolve("validation/proxmox/desktop/helpers/nelos-proxmox-lease-authority.py");
const sortDeep = (value) => Array.isArray(value)
  ? value.map(sortDeep)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]))
    : value;
const canonical = (value) => `${JSON.stringify(sortDeep(value))}\n`;

export function createLeaseAuthorityIssueFixtureV1({
  run,
  observedAt,
  cleanupExpiresAt = new Date(Date.parse(run.lease.expiresAt) + 600_000).toISOString(),
  authorityId = `${run.provider.hostId}-desktop-authority-v1`,
  epoch = 1,
  revision = 1,
  reason = "deterministic test lease issuance",
} = {}) {
  const trustDigest = leaseAuthoritySha256V1({ authorityId, fixture: "lease-authority-trust-v1" });
  const unsignedRecord = {
    authority: { authorityId, trustDigest },
    epoch,
    kind: "nelos.proxmox-desktop.lease-authority-record.v1",
    lease: {
      cleanupExpiresAt,
      expiresAt: run.lease.expiresAt,
      fencingToken: run.lease.fencingToken,
      holderId: run.lease.holderId,
      issuedAt: observedAt,
      leaseId: run.lease.leaseId,
      runId: run.runId,
    },
    previousRecordDigest: null,
    resource: { hostId: run.provider.hostId, providerId: run.provider.providerId, vmid: String(run.provider.vmId) },
    revision,
    schemaVersion: 1,
    state: "active",
    transition: { at: observedAt, operation: "issue", reason },
  };
  const record = { ...unsignedRecord, recordDigest: leaseAuthoritySha256V1(unsignedRecord) };
  const recordBytes = canonicalLeaseAuthorityBytesV1(record);
  const observation = {
    authorityId,
    kind: "nelos.proxmox-desktop.lease-authority-observation.v1",
    observedAt,
    record,
    recordBytesBase64: recordBytes.toString("base64"),
    recordDigest: record.recordDigest,
    recordFileDigest: leaseAuthoritySha256V1(recordBytes),
    resourceKey: leaseAuthoritySha256V1(record.resource).slice(7),
    schemaVersion: 1,
    trustDigest,
  };
  return Object.freeze({
    authorityBinding: Object.freeze({
      authorityId,
      epoch,
      issuedRecordDigest: observation.recordDigest,
      issuedRecordFileDigest: observation.recordFileDigest,
      issuedRevision: revision,
      trustDigest,
    }),
    observation: Object.freeze(observation),
  });
}

async function sealed(path, value, mode = 0o600) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, canonical(value), { mode });
  await chmod(path, mode);
  return path;
}

async function invoke(root, command, args, now) {
  const { stdout, stderr } = await exec("/usr/bin/python3", [source, command, ...args, "--fake-root", root], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NELOS_LEASE_AUTHORITY_TEST_NOW: now },
    maxBuffer: 1_048_576,
  });
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

export async function installFakeProxmoxLeaseAuthority({ root, binding, nowMs = Date.now(), installRunBinding = true }) {
  const now = new Date(nowMs).toISOString();
  await writeFile(join(root, ".nelos-lease-authority-fake-root"), "nelos-proxmox-lease-authority-fake-root-v1\n", { mode: 0o600 });
  const libexec = join(root, "usr/libexec");
  await mkdir(libexec, { recursive: true, mode: 0o755 });
  const installedHelper = join(libexec, "nelos-proxmox-lease-authority");
  await copyFile(source, installedHelper);
  await chmod(installedHelper, 0o750);
  const inputs = join(root, "lease-authority-inputs");
  await mkdir(inputs, { mode: 0o700 });
  const trust = {
    authorityId: `${binding.hostId}-desktop-authority-v1`,
    effectMarginMs: 1_000,
    hostId: binding.hostId,
    kind: "nelos.proxmox-desktop.lease-authority-trust.v1",
    providerId: binding.providerId,
    schemaVersion: 1,
    stateRoot: "/var/lib/nelos-lease-authority",
  };
  const trustPath = await sealed(join(inputs, "trust.json"), trust);
  const prepared = await invoke(root, "prepare", ["--trust", trustPath], now);
  const issuePath = await sealed(join(inputs, "issue.json"), {
    authorityId: trust.authorityId,
    cleanupExpiresAt: new Date(nowMs + 1_800_000).toISOString(),
    expiresAt: new Date(nowMs + 600_000).toISOString(),
    fencingToken: binding.fencingToken,
    holderId: "nelos-validator",
    leaseId: binding.leaseId,
    previousRecordDigest: null,
    reason: "isolated host-helper fixture",
    resource: { hostId: binding.hostId, providerId: binding.providerId, vmid: binding.vmId },
    runId: binding.runId,
  });
  const issued = await invoke(root, "issue", ["--request", issuePath], now);
  const authorityBinding = {
    authorityId: trust.authorityId,
    epoch: issued.record.epoch,
    issuedRecordDigest: issued.recordDigest,
    issuedRecordFileDigest: issued.recordFileDigest,
    issuedRevision: issued.record.revision,
    trustDigest: prepared.trustDigest,
  };
  if (installRunBinding) {
    const etc = join(root, "etc/nelos-desktop");
    await mkdir(etc, { recursive: true, mode: 0o700 });
    await sealed(join(etc, "run-binding.json"), binding, 0o400);
    await sealed(join(etc, "lease-authority-binding.json"), authorityBinding, 0o400);
  }
  return {
    authority: issued,
    authorityBinding,
    env: { NELOS_LEASE_AUTHORITY_TEST_NOW: now },
    prepared,
    trust,
  };
}
