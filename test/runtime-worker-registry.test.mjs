import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RuntimeWorkerRegistryV1,
  validateRuntimeWorkerLeaseV1,
} from "../src/runtime-worker-registry.mjs";
import {
  reloadOwnedMcpServerV1,
  RUNTIME_UPGRADE_RECOVERY_ACTION,
} from "../src/runtime-lifecycle.mjs";

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);
const INTEGRITY_A = `sha256:${"1".repeat(64)}`;
const INTEGRITY_B = `sha256:${"2".repeat(64)}`;

function identity(version = "0.12.6", revision = REVISION_A, integrity = INTEGRITY_A) {
  return {
    version,
    sourceRevision: revision,
    cacheIdentity: `https://example.invalid/nelos#nelos@${version}`,
    integrity,
    modulePath: `/cache/nelos/${version}`,
    buildIdentity: `nelos-build:${revision.slice(0, 32)}`,
  };
}

function processIdentity(value) {
  return { "ps-start": `Tue Aug 04 12:00:${String(value).padStart(2, "0")} 2026` };
}

test("worker registry and lifecycle helpers are public package subpaths", async () => {
  const [registry, lifecycle] = await Promise.all([
    import("nelos/runtime-worker-registry"),
    import("nelos/runtime-lifecycle"),
  ]);
  assert.equal(registry.RuntimeWorkerRegistryV1, RuntimeWorkerRegistryV1);
  assert.equal(lifecycle.reloadOwnedMcpServerV1, reloadOwnedMcpServerV1);
});

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "nelos-runtime-workers-"));
  let clock = Date.parse("2026-08-04T12:00:00.000Z");
  const active = new Map();
  const timers = [];
  const registry = (pid, parentPid = 10, overrides = {}) => {
    active.set(parentPid, active.get(parentPid) ?? processIdentity(parentPid));
    active.set(pid, active.get(pid) ?? processIdentity(pid));
    return new RuntimeWorkerRegistryV1({
      directory,
      pid,
      parentPid,
      now: () => clock,
      readIdentity: async (target) => active.get(target) ?? null,
      readActiveIdentity: async (target) => active.get(target) ?? null,
      withLock: overrides.withLock ?? (async (callback) => callback()),
      setIntervalFn: (callback) => { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
      clearIntervalFn: () => {},
    });
  };
  try {
    return await run({ directory, registry, active, advance: (ms) => { clock += ms; }, timers });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("same-generation workers coexist and owned shutdown removes only one lease", async () => {
  await fixture(async ({ registry }) => {
    const first = await registry(101).register(identity());
    const second = await registry(102).register(identity());
    const report = await registry(103).inspect();
    assert.equal(report.state, "single-generation");
    assert.equal(report.liveWorkerCount, 2);
    assert.equal(report.activeGenerations[0].workers.length, 2);
    assert.equal(report.mutationAllowed, true);
    assert.equal(validateRuntimeWorkerLeaseV1(first.lease).state, "active");
    assert.equal((await first.drain()).state, "draining");
    assert.equal(await first.remove(), true);
    assert.equal((await registry(103).inspect()).liveWorkerCount, 1);
    await second.remove();
  });
});

test("mixed exact generations are explicit and never trigger process signaling", async () => {
  await fixture(async ({ registry }) => {
    const oldWorker = await registry(201).register(identity("0.12.5", REVISION_A, INTEGRITY_A));
    const newWorker = await registry(202).register(identity("0.12.6", REVISION_B, INTEGRITY_B));
    const report = await registry(203).inspect();
    assert.equal(report.state, "mixed-generations");
    assert.equal(report.mutationAllowed, false);
    assert.deepEqual(report.activeGenerations.map(({ identity: value }) => value.version).sort(), ["0.12.5", "0.12.6"]);
    await oldWorker.remove();
    await newWorker.remove();
  });
});

test("crashed workers are recovered after expiry without a PID-reuse race", async () => {
  await fixture(async ({ registry, active, advance }) => {
    await registry(301).register(identity());
    // Same PID, different strong process-start identity proves reuse even
    // before the heartbeat expires. The replacement never inherits the lease.
    active.set(301, processIdentity(99));
    let report = await registry(302).inspect();
    assert.equal(report.liveWorkerCount, 0);
    assert.equal(report.recoveredWorkerIds.length, 1);

    await registry(303).register(identity());
    active.delete(303);
    advance(31_000);
    report = await registry(304).inspect();
    assert.equal(report.liveWorkerCount, 0);
    assert.equal(report.recoveredWorkerIds.length, 1);
  });
});

test("lease shape binds nonce, parent, runtime identity, and bounded heartbeat", async () => {
  await fixture(async ({ registry, advance }) => {
    const handle = await registry(401, 40).register(identity());
    const first = validateRuntimeWorkerLeaseV1(handle.lease);
    assert.match(first.launchNonce, /^[0-9a-f-]{36}$/u);
    assert.equal(first.parentPid, 40);
    assert.equal(first.runtimeIdentity.version, "0.12.6");
    assert.ok(Date.parse(first.expiresAt) > Date.parse(first.heartbeatAt));
    advance(5_000);
    const heartbeat = await handle.heartbeat();
    assert.ok(Date.parse(heartbeat.heartbeatAt) > Date.parse(first.heartbeatAt));
    await handle.remove();
  });
});

test("malformed protected leases fail closed instead of hiding a generation", async () => {
  await fixture(async ({ directory, registry }) => {
    await writeFile(join(directory, `${"f".repeat(64)}.json`), "{}\n");
    await assert.rejects(registry(450).inspect(), /invalid lease/u);
  });
});

test("registration exclusion holds the registry lock through its callback", async () => {
  await fixture(async ({ registry }) => {
    let locked = false;
    let acquisitions = 0;
    const withLock = async (callback) => {
      assert.equal(locked, false);
      locked = true;
      acquisitions += 1;
      try {
        return await callback();
      } finally {
        locked = false;
      }
    };
    const value = await registry(475, 10, { withLock }).withRegistrationExclusion(
      async (report) => {
        assert.equal(locked, true);
        assert.equal(report.liveWorkerCount, 0);
        return "held-through-callback";
      },
    );
    assert.equal(value, "held-through-callback");
    assert.equal(acquisitions, 1);
    assert.equal(locked, false);
  });
});

test("host reload is restricted to an owning client and restart is the exact fallback", async () => {
  const requests = [];
  const client = { async request(method, params) { requests.push({ method, params }); } };
  const fallback = await reloadOwnedMcpServerV1({ client, ownsAppServer: false, reloadSupported: true });
  assert.deepEqual(fallback, { state: "restart-required", reloaded: false, recovery: RUNTIME_UPGRADE_RECOVERY_ACTION });
  assert.deepEqual(requests, []);

  const result = await reloadOwnedMcpServerV1({
    client,
    ownsAppServer: true,
    reloadSupported: true,
    waitForOwnedChildren: async () => true,
  });
  assert.equal(result.state, "reloaded");
  assert.deepEqual(requests, [{ method: "config/mcpServer/reload", params: { name: "nelos" } }]);

  await assert.rejects(
    reloadOwnedMcpServerV1({ client, ownsAppServer: true, reloadSupported: true, waitForOwnedChildren: async () => false }),
    /did not close/,
  );
});
