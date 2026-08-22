import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  expectedLeaseAuthorityIdentityV1,
  leaseAuthorityBindingFromObservationV1,
  validateLeaseAuthorityObservationV1,
} from "../src/proxmox-lease-authority.mjs";

const exec = promisify(execFile);
const helper = resolve("validation/proxmox/desktop/helpers/nelos-proxmox-lease-authority.py");
const hostHelper = resolve("validation/proxmox/desktop/helpers/nelos-proxmox-host-helper.py");
const attestorHelper = resolve("validation/proxmox/desktop/helpers/nelos-proxmox-attest.py");
const canonical = (value) => `${JSON.stringify(value, Object.keys(value).sort())}\n`;
const sortDeep = (value) => Array.isArray(value)
  ? value.map(sortDeep)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]))
    : value;
const bytes = (value) => `${JSON.stringify(sortDeep(value))}\n`;

async function sealed(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, bytes(value), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function invoke(fixture, command, args = [], now = "2026-08-20T12:00:00.000Z") {
  try {
    const { stdout, stderr } = await exec("/usr/bin/python3", [helper, command, ...args, "--fake-root", fixture.root], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NELOS_LEASE_AUTHORITY_TEST_NOW: now },
      maxBuffer: 1_048_576,
    });
    assert.equal(stderr, "");
    return JSON.parse(stdout);
  } catch (error) {
    error.authorityError = (() => { try { return JSON.parse(error.stderr); } catch { return null; } })();
    throw error;
  }
}

const rejectsCode = (code) => (error) => error?.authorityError?.error === code;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-lease-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".nelos-lease-authority-fake-root"), "nelos-proxmox-lease-authority-fake-root-v1\n", { mode: 0o600 });
  const inputs = join(root, "inputs");
  await mkdir(inputs, { mode: 0o700 });
  const trust = {
    authorityId: "prox2-desktop-authority-v1",
    effectMarginMs: 5_000,
    hostId: "prox2",
    kind: "nelos.proxmox-desktop.lease-authority-trust.v1",
    providerId: "proxmox-lab",
    schemaVersion: 1,
    stateRoot: "/var/lib/nelos-lease-authority",
  };
  const trustPath = await sealed(join(inputs, "trust.json"), trust);
  const prepared = await invoke({ root }, "prepare", ["--trust", trustPath]);
  const resource = { hostId: "prox2", providerId: "proxmox-lab", vmid: "9401" };
  const resourcePath = await sealed(join(inputs, "resource.json"), resource);
  return { root, inputs, trust, prepared, resource, resourcePath };
}

async function issue(fixtureValue, suffix = "1", previousRecordDigest = null, now = "2026-08-20T12:00:00.000Z", windows = {}) {
  const request = {
    authorityId: fixtureValue.trust.authorityId,
    cleanupExpiresAt: windows.cleanupExpiresAt ?? "2026-08-20T13:00:00.000Z",
    expiresAt: windows.expiresAt ?? "2026-08-20T12:30:00.000Z",
    fencingToken: `fence-${suffix}`,
    holderId: "nelos-validator",
    leaseId: `lease-${suffix}`,
    previousRecordDigest,
    reason: `test issuance ${suffix}`,
    resource: fixtureValue.resource,
    runId: `run-${suffix}`,
  };
  const path = await sealed(join(fixtureValue.inputs, `issue-${suffix}.json`), request);
  return invoke(fixtureValue, "issue", ["--request", path], now);
}

async function transition(fixtureValue, operation, observation, now = "2026-08-20T12:05:00.000Z", mutate = () => {}) {
  const request = {
    authorityId: fixtureValue.trust.authorityId,
    currentRecordDigest: observation.recordDigest,
    fencingToken: observation.record.lease.fencingToken,
    holderId: observation.record.lease.holderId,
    leaseId: observation.record.lease.leaseId,
    reason: `test ${operation}`,
    resource: fixtureValue.resource,
    runId: observation.record.lease.runId,
  };
  mutate(request);
  const path = await sealed(join(fixtureValue.inputs, `${operation}-${observation.record.revision}-${Math.random()}.json`), request);
  return invoke(fixtureValue, operation, ["--request", path], now);
}

async function installBoundRun(fixtureValue, observation, overrides = {}, issuedObservation = observation) {
  const etc = join(fixtureValue.root, "etc", "nelos-desktop");
  await mkdir(etc, { recursive: true, mode: 0o700 });
  for (const name of ["run-binding.json", "lease-authority-binding.json"]) {
    await chmod(join(etc, name), 0o600).catch(() => {});
  }
  const run = {
    automationUser: "nelosauto",
    fencingToken: observation.record.lease.fencingToken,
    hostId: fixtureValue.resource.hostId,
    imageId: "desktop-golden-v1",
    leaseId: observation.record.lease.leaseId,
    macAddress: "02:4E:45:4C:94:01",
    networkId: "nelosbld",
    gatewayId: "9023",
    networkPolicyDigest: `sha256:${"9".repeat(64)}`,
    providerId: fixtureValue.resource.providerId,
    runId: observation.record.lease.runId,
    stateRoot: `/var/lib/nelos-desktop/runs/${observation.record.lease.runId}`,
    vmId: fixtureValue.resource.vmid,
    ...overrides,
  };
  const authority = {
    authorityId: fixtureValue.trust.authorityId,
    epoch: issuedObservation.record.epoch,
    issuedRecordDigest: issuedObservation.recordDigest,
    issuedRecordFileDigest: issuedObservation.recordFileDigest,
    issuedRevision: issuedObservation.record.revision,
    trustDigest: fixtureValue.prepared.trustDigest,
  };
  await sealed(join(etc, "run-binding.json"), run);
  await sealed(join(etc, "lease-authority-binding.json"), authority);
  await chmod(join(etc, "run-binding.json"), 0o400);
  await chmod(join(etc, "lease-authority-binding.json"), 0o400);
}

test("authority prepares immutable trust and returns canonical current bytes from a chained first issue", async (t) => {
  const value = await fixture(t);
  assert.equal(value.prepared.prepared, true);
  const issued = await issue(value);
  assert.equal(issued.record.epoch, 1);
  assert.equal(issued.record.revision, 1);
  assert.equal(issued.record.state, "active");
  assert.equal(Buffer.from(issued.recordBytesBase64, "base64").toString("utf8"), bytes(issued.record));

  // A new process reconstructs the same authoritative head after restart.
  const observed = await invoke(value, "observe", ["--resource", value.resourcePath], "2026-08-20T12:01:00.000Z");
  assert.equal(issued.observedAt, "2026-08-20T12:00:00.000Z");
  assert.equal(observed.observedAt, "2026-08-20T12:01:00.000Z");
  assert.deepEqual({ ...observed, observedAt: issued.observedAt }, issued);
  const currentPath = join(value.root, "var/lib/nelos-lease-authority/current", `${issued.resourceKey}.json`);
  assert.equal(await readFile(currentPath, "utf8"), bytes(issued.record));
  const binding = leaseAuthorityBindingFromObservationV1(issued, { now: Date.parse("2026-08-20T12:01:00.000Z"), marginMs: 5_000 });
  assert.deepEqual(binding, {
    authorityId: value.trust.authorityId,
    epoch: 1,
    issuedRecordDigest: issued.recordDigest,
    issuedRecordFileDigest: issued.recordFileDigest,
    issuedRevision: 1,
    trustDigest: value.prepared.trustDigest,
  });
  assert.deepEqual(expectedLeaseAuthorityIdentityV1({ authorityBinding: binding, run: {
    runId: issued.record.lease.runId,
    provider: { hostId: value.resource.hostId, providerId: value.resource.providerId, vmId: value.resource.vmid },
    lease: issued.record.lease,
  } }), {
    authorityId: value.trust.authorityId, epoch: 1, fencingToken: "fence-1", holderId: "nelos-validator",
    hostId: "prox2", leaseId: "lease-1", providerId: "proxmox-lab", runId: "run-1",
    trustDigest: value.prepared.trustDigest, vmid: "9401",
  });
});

test("JavaScript authority validation rejects noncanonical bytes, digest drift, unknown fields, and terminal state", async (t) => {
  const value = await fixture(t);
  const issued = await issue(value);
  for (const mutate of [
    (candidate) => { candidate.extra = true; },
    (candidate) => { candidate.recordDigest = `sha256:${"0".repeat(64)}`; },
    (candidate) => { candidate.recordBytesBase64 = Buffer.from(`${JSON.stringify(candidate.record, null, 2)}\n`).toString("base64"); },
  ]) {
    const candidate = structuredClone(issued); mutate(candidate);
    assert.throws(() => validateLeaseAuthorityObservationV1(candidate), /lease-authority|digest|fields|bytes/iu);
  }
  const revoked = await transition(value, "revoke", issued);
  assert.throws(
    () => validateLeaseAuthorityObservationV1(revoked, { now: Date.parse("2026-08-20T12:06:00.000Z"), marginMs: 5_000 }),
    (error) => error?.code === "LEASE_MANUAL_RECONCILIATION_REQUIRED",
  );
});

test("bound authorization is resource-derived, margin-aware, and rejects an old fence", async (t) => {
  const value = await fixture(t);
  const first = await issue(value);
  await installBoundRun(value, first);
  const authorized = await invoke(value, "authorize-bound", ["active"], "2026-08-20T12:20:00.000Z");
  assert.equal(authorized.authorizedMode, "active");
  await assert.rejects(
    invoke(value, "authorize-bound", ["active"], "2026-08-20T12:29:56.000Z"),
    rejectsCode("LEASE_NOT_ACTIVE"),
  );

  const completed = await transition(value, "complete", first);
  const second = await issue(value, "2", completed.recordDigest, "2026-08-20T12:06:00.000Z");
  assert.equal(second.record.epoch, 2);
  assert.equal(second.record.revision, 3);
  await assert.rejects(
    invoke(value, "authorize-bound", ["active"], "2026-08-20T12:07:00.000Z"),
    rejectsCode("LEASE_SUPERSEDED"),
  );
});

test("bound authorization rejects a caller-selected VNet before authorizing any provider effect", async (t) => {
  const value = await fixture(t);
  const active = await issue(value);
  await installBoundRun(value, active, { networkId: "caller-selected" });
  await assert.rejects(
    invoke(value, "authorize-bound", ["active"], "2026-08-20T12:20:00.000Z"),
    rejectsCode("INVALID_AUTHORITY_BINDING"),
  );
});

test("cleanup-only is separately bounded and revoked leases require manual reconciliation", async (t) => {
  const value = await fixture(t);
  const active = await issue(value);
  const cleanup = await transition(value, "cleanup-only", active, "2026-08-20T12:31:00.000Z");
  await installBoundRun(value, cleanup, {}, active);
  await assert.rejects(invoke(value, "authorize-bound", ["active"], "2026-08-20T12:31:01.000Z"), rejectsCode("LEASE_NOT_ACTIVE"));
  assert.equal((await invoke(value, "authorize-bound", ["cleanup"], "2026-08-20T12:31:01.000Z")).authorizedMode, "cleanup");
  await assert.rejects(invoke(value, "authorize-bound", ["cleanup"], "2026-08-20T12:59:56.000Z"), rejectsCode("CLEANUP_LEASE_EXPIRED"));

  const revoked = await transition(value, "revoke", cleanup, "2026-08-20T12:32:00.000Z");
  await installBoundRun(value, revoked, {}, active);
  await assert.rejects(invoke(value, "authorize-bound", ["cleanup"], "2026-08-20T12:32:01.000Z"), rejectsCode("LEASE_MANUAL_RECONCILIATION_REQUIRED"));
  await assert.rejects(issue(value, "2", revoked.recordDigest, "2026-08-20T12:33:00.000Z", {
    expiresAt: "2026-08-20T13:30:00.000Z", cleanupExpiresAt: "2026-08-20T14:00:00.000Z",
  }), rejectsCode("AUTHORITY_REASSIGNMENT_BLOCKED"));
  const reconciled = await transition(value, "complete", revoked, "2026-08-20T12:34:00.000Z");
  assert.equal(reconciled.record.state, "completed");
});

test("authority detects rollback, stale transition, identity reassignment, and non-contiguous history", async (t) => {
  const value = await fixture(t);
  const active = await issue(value);
  const cleanup = await transition(value, "cleanup-only", active);

  await assert.rejects(transition(value, "revoke", active), rejectsCode("AUTHORITY_ROLLBACK_DETECTED"));
  await assert.rejects(transition(value, "revoke", cleanup, "2026-08-20T12:06:00.000Z", (request) => { request.fencingToken = "fence-other"; }), rejectsCode("LEASE_SUPERSEDED"));

  const currentPath = join(value.root, "var/lib/nelos-lease-authority/current", `${cleanup.resourceKey}.json`);
  await chmod(currentPath, 0o600);
  await writeFile(currentPath, bytes(active.record));
  await chmod(currentPath, 0o400);
  await assert.rejects(invoke(value, "observe", ["--resource", value.resourcePath]), rejectsCode("AUTHORITY_ROLLBACK_DETECTED"));
});

test("issue rejects unsafe windows and cannot reuse prior lease, fence, or run identities", async (t) => {
  const value = await fixture(t);
  const active = await issue(value);
  const completed = await transition(value, "complete", active);
  const request = {
    authorityId: value.trust.authorityId,
    cleanupExpiresAt: "2026-08-20T13:00:00.000Z",
    expiresAt: "2026-08-20T12:30:00.000Z",
    fencingToken: "fence-1",
    holderId: "nelos-validator",
    leaseId: "lease-new",
    previousRecordDigest: completed.recordDigest,
    reason: "unsafe fence reuse",
    resource: value.resource,
    runId: "run-new",
  };
  const requestPath = await sealed(join(value.inputs, "reuse.json"), request);
  await assert.rejects(invoke(value, "issue", ["--request", requestPath], "2026-08-20T12:06:00.000Z"), rejectsCode("AUTHORITY_REASSIGNMENT_BLOCKED"));

  request.fencingToken = "fence-new";
  request.expiresAt = "2026-08-20T12:30:00Z";
  const noncanonicalTimePath = await sealed(join(value.inputs, "noncanonical-time.json"), request);
  await assert.rejects(
    invoke(value, "issue", ["--request", noncanonicalTimePath], "2026-08-20T12:06:00.000Z"),
    rejectsCode("INVALID_AUTHORITY_CONTRACT"),
  );

  request.expiresAt = "2026-08-20T12:06:04.000Z";
  const expiredPath = await sealed(join(value.inputs, "unsafe-window.json"), request);
  await assert.rejects(invoke(value, "issue", ["--request", expiredPath], "2026-08-20T12:06:00.000Z"), rejectsCode("INVALID_LEASE_WINDOW"));

  request.fencingToken = "fence-2";
  request.leaseId = "lease-2";
  request.runId = "run-2";
  request.expiresAt = "2026-08-20T13:30:00.000Z";
  request.cleanupExpiresAt = "2026-08-20T14:00:00.000Z";
  const secondPath = await sealed(join(value.inputs, "second-epoch.json"), request);
  const second = await invoke(value, "issue", ["--request", secondPath], "2026-08-20T12:06:00.000Z");
  const secondCompleted = await transition(value, "complete", second, "2026-08-20T12:07:00.000Z");
  request.previousRecordDigest = secondCompleted.recordDigest;
  request.leaseId = active.record.lease.leaseId;
  request.fencingToken = "fence-3";
  request.runId = "run-3";
  request.expiresAt = "2026-08-20T14:30:00.000Z";
  request.cleanupExpiresAt = "2026-08-20T15:00:00.000Z";
  const historicalReusePath = await sealed(join(value.inputs, "historical-reuse.json"), request);
  await assert.rejects(
    invoke(value, "issue", ["--request", historicalReusePath], "2026-08-20T12:08:00.000Z"),
    rejectsCode("AUTHORITY_REASSIGNMENT_BLOCKED"),
  );
});

test("the mutating host helper re-reads authority immediately and an old fence never reaches pvesh", async (t) => {
  const value = await fixture(t);
  const active = await issue(value);
  await installBoundRun(value, active);
  const libexec = join(value.root, "usr/libexec");
  await mkdir(libexec, { recursive: true, mode: 0o755 });
  await copyFile(helper, join(libexec, "nelos-proxmox-lease-authority"));
  await chmod(join(libexec, "nelos-proxmox-lease-authority"), 0o750);
  await sealed(join(value.root, "etc/nelos-desktop/provider.json"), {
    gatewayId: "9023", hostId: value.resource.hostId, networkId: "nelosbld", networkPolicyDigest: `sha256:${"9".repeat(64)}`,
    networkPolicyObserverDigest: `sha256:${"8".repeat(64)}`,
    providerId: value.resource.providerId, sourceTemplateVmId: "9025",
  });
  const log = join(value.root, "pvesh.log");
  const startedMarker = join(value.root, "pvesh.started");
  const releaseMarker = join(value.root, "pvesh.release");
  const pvesh = join(value.root, "pvesh.mjs");
  await writeFile(pvesh, `#!${process.execPath}\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, "effect\\n"); writeFileSync(${JSON.stringify(startedMarker)}, "started\\n"); while (!existsSync(${JSON.stringify(releaseMarker)})) await new Promise((resolve) => setTimeout(resolve, 5)); process.stdout.write('"UPID:prox2:test"');\n`);
  await chmod(pvesh, 0o700);
  const binding = {
    automationUser: "nelosauto", fencingToken: active.record.lease.fencingToken, hostId: value.resource.hostId,
    imageId: "desktop-golden-v1", leaseId: active.record.lease.leaseId, macAddress: "02:4E:45:4C:94:01",
    networkId: "nelosbld", gatewayId: "9023", networkPolicyDigest: `sha256:${"9".repeat(64)}`, providerId: value.resource.providerId,
    runId: active.record.lease.runId, stateRoot: `/var/lib/nelos-desktop/runs/${active.record.lease.runId}`, vmId: value.resource.vmid,
  };
  const envelope = {
    binding,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    maxOutputBytes: 65_536,
    request: { body: { node: value.resource.hostId }, method: "POST", path: `/nodes/${value.resource.hostId}/qemu/${value.resource.vmid}/status/start` },
    schemaVersion: 1,
  };
  const runBoundHelper = async (executable, request, now) => {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("/usr/bin/python3", [executable, "request"], {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NELOS_DESKTOP_HELPER_ROOT: value.root, NELOS_PVESH: pvesh, NELOS_LEASE_AUTHORITY_TEST_NOW: now },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = []; const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("error", rejectPromise);
      child.once("close", (code) => resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
      child.stdin.end(JSON.stringify(request));
    });
  };
  const firstEffect = runBoundHelper(hostHelper, envelope, "2026-08-20T12:10:00.000Z");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await access(startedMarker).then(() => true, () => false)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.equal(await access(startedMarker).then(() => true, () => false), true);
  let transitioned = false;
  const completion = transition(value, "complete", active, "2026-08-20T12:11:00.000Z").then((result) => { transitioned = true; return result; });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
  assert.equal(transitioned, false, "exclusive authority transition must wait for the in-flight effect guard");
  await writeFile(releaseMarker, "release\n");
  assert.equal((await firstEffect).code, 0);
  assert.equal(await readFile(log, "utf8"), "effect\n");
  const completed = await completion;
  const leaseRead = { ...envelope, request: { method: "GET", path: "/nelos/lease-authority/current" } };
  const attested = await runBoundHelper(attestorHelper, leaseRead, "2026-08-20T12:10:30.000Z");
  assert.equal(attested.code, 0, attested.stderr);
  const attestation = JSON.parse(attested.stdout);
  assert.equal(attestation.recordDigest, completed.recordDigest);
  assert.equal(Buffer.from(attestation.recordBytesBase64, "base64").toString("utf8"), bytes(completed.record));

  await issue(value, "2", completed.recordDigest, "2026-08-20T12:12:00.000Z");
  const rejected = await runBoundHelper(hostHelper, envelope, "2026-08-20T12:13:00.000Z");
  assert.equal(rejected.code, 77);
  assert.match(rejected.stderr, /LEASE_SUPERSEDED/u);
  assert.equal(await readFile(log, "utf8"), "effect\n");
});

test("source contains no production clock override and exposes no caller-selected bound lookup", async () => {
  const source = await readFile(helper, "utf8");
  assert.match(source, /if not fake:\n\s+fail\("UNSAFE_CLOCK_OVERRIDE"/u);
  assert.match(source, /def observe_bound\(/u);
  assert.match(source, /PRODUCTION_PROVIDER_ID = "proxmox-lab"[\s\S]*PRODUCTION_HOST_ID = "prox2"[\s\S]*PRODUCTION_GATEWAY_ID = "9023"/u);
  assert.doesNotMatch(source, /authorize-bound[^\n]+--resource/u);
  assert.doesNotMatch(source, /observe-bound[^\n]+--resource/u);
  assert.equal(canonical({ a: 1 }), "{\"a\":1}\n");
});
