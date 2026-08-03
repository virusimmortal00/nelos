import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEDICATED_DESKTOP_MARKER,
  DedicatedDesktopRuntimeError,
  admitDedicatedDesktopAction,
  runDedicatedDesktopAction,
} from "../src/dedicated-desktop-runtime.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture(action = "restart") {
  const user = "nelosbench";
  const home = `/Users/${user}`;
  const target = {
    appPid: 4101,
    backendPid: 4102,
    bundleId: "com.openai.codex.benchmark",
    bundlePath: `${home}/Applications/Codex.app`,
    socketOwnerPid: 4102,
    socketPath: `${home}/Library/Application Support/Codex/app-server.sock`,
  };
  const lease = {
    action,
    appPid: target.appPid,
    backendPid: target.backendPid,
    bundleId: target.bundleId,
    bundlePath: target.bundlePath,
    expiresAt: "2099-01-01T00:00:00.000Z",
    fencingToken: "fence-0001",
    hostId: "desktop-worker-01",
    leaseId: `lease-${action}`,
    mutating: true,
    runtimeLockDigest: digest("1"),
    socketOwnerPid: target.socketOwnerPid,
    socketPath: target.socketPath,
    state: "active",
  };
  const plugin = {
    artifactDigest: digest("2"),
    lockDigest: digest("3"),
    pluginId: "nelos",
    version: "0.6.1",
  };
  const worker = {
    automation: {
      codexHome: `${home}/.codex-benchmark`,
      credentialRef: `keychain://${user}/nelos-benchmark`,
      home,
      uid: 551,
      user,
    },
    currentLease: structuredClone(lease),
    goldenImage: {
      digest: digest("4"),
      generation: 7,
      imageId: "nelos-desktop-2026-08-03",
      signatureDigest: digest("5"),
    },
    hostId: lease.hostId,
    isolation: {
      addressableHomes: [home],
      developmentStateReachable: false,
      fastUserSwitching: false,
      interactiveHumanUse: false,
      mountedWritableRoots: [home],
    },
    marker: {
      dedicated: true,
      issuedAt: "2026-08-03T00:00:00.000Z",
      kind: DEDICATED_DESKTOP_MARKER,
      signatureDigest: digest("6"),
      workerId: lease.hostId,
    },
    pluginLock: plugin,
    runtimeClass: "desktop-macos",
    schemaVersion: 1,
    state: "leased",
    target,
  };
  return {
    action,
    actorUser: user,
    evidenceLane: "desktop",
    expectedGoldenImageDigest: worker.goldenImage.digest,
    lease,
    nextGoldenImage: ["reimage", "rollback"].includes(action) ? {
      digest: digest("7"),
      generation: action === "rollback" ? 6 : 8,
      imageId: action === "rollback" ? "nelos-desktop-2026-08-02" : "nelos-desktop-2026-08-04",
      signatureDigest: digest("8"),
    } : null,
    observed: {
      crashCount: action === "crash-recovery" ? 1 : 0,
      expectedProfileDigest: digest("9"),
      expectedTaskIds: ["task-existing"],
      pluginArtifactDigest: plugin.artifactDigest,
      pluginCopies: 1,
      pluginId: plugin.pluginId,
      pluginLockDigest: plugin.lockDigest,
      pluginVersion: plugin.version,
      profileDigest: digest("9"),
      socketOwnerPid: target.backendPid,
      taskIds: ["task-existing"],
    },
    plugin: ["install", "upgrade"].includes(action) ? {
      ...plugin,
      artifactDigest: action === "upgrade" ? digest("a") : plugin.artifactDigest,
      lockDigest: action === "upgrade" ? digest("b") : plugin.lockDigest,
      version: action === "upgrade" ? "0.7.0" : plugin.version,
    } : null,
    priorPlugin: action === "rollback" ? {
      ...plugin,
      artifactDigest: digest("c"),
      lockDigest: digest("d"),
      version: "0.5.3",
    } : null,
    target: structuredClone(target),
    worker,
  };
}

class DisposableDesktop {
  constructor({ failCleanup = false } = {}) {
    this.calls = [];
    this.failCleanup = failCleanup;
  }

  async drainHost({ hostId, lease }) {
    this.calls.push(["drainHost", hostId, lease.leaseId]);
    return { drained: true, hostId, leaseId: lease.leaseId };
  }

  async installPlugin({ plugin }) {
    this.calls.push(["installPlugin", plugin.version]);
    return { artifactDigest: plugin.artifactDigest, lockDigest: plugin.lockDigest };
  }

  async restartTarget({ target, reason }) {
    this.calls.push(["restartTarget", reason, target.appPid, target.backendPid]);
    return { ...target, appPid: target.appPid + 100, backendPid: target.backendPid + 100, socketOwnerPid: target.backendPid + 100 };
  }

  async createFreshTask({ target }) {
    this.calls.push(["createFreshTask", target.appPid]);
    return { taskId: "task-fresh" };
  }

  async discoverPlugin({ taskId }) {
    this.calls.push(["discoverPlugin", taskId]);
    const install = this.calls.find((call) => call[0] === "installPlugin");
    const version = install?.[1] ?? "0.6.1";
    const request = this.request;
    const plugin = request?.action === "rollback" ? request.priorPlugin : request?.plugin ?? request?.worker.pluginLock;
    return { artifactDigest: plugin.artifactDigest, copyCount: 1, pluginId: plugin.pluginId, taskId, version };
  }

  async cancelTarget({ lease, target }) {
    this.calls.push(["cancelTarget", target.appPid, target.backendPid]);
    return { appPid: target.appPid, backendPid: target.backendPid, leaseId: lease.leaseId };
  }

  async cleanupLease({ lease }) {
    this.calls.push(["cleanupLease", lease.leaseId]);
    return { complete: !this.failCleanup, leaseId: lease.leaseId };
  }

  async verifyClean() {
    this.calls.push(["verifyClean"]);
    return { clean: true, credentialCount: 0, taskCount: 0, writableStateCount: 0 };
  }

  async quarantineHost({ hostId, reason }) {
    this.calls.push(["quarantineHost", hostId, reason]);
    return { quarantined: true };
  }

  async reimageHost({ goldenImage, target }) {
    this.calls.push(["reimageHost", goldenImage.imageId]);
    return {
      ...goldenImage,
      target: { ...target, appPid: target.appPid + 50, backendPid: target.backendPid + 50, socketOwnerPid: target.backendPid + 50 },
    };
  }

  async verifyReimage({ goldenImage }) {
    this.calls.push(["verifyReimage", goldenImage.digest]);
    return { developmentStateReachable: false, imageDigest: goldenImage.digest, markerKind: DEDICATED_DESKTOP_MARKER };
  }
}

async function execute(action, options) {
  const request = fixture(action);
  const adapter = new DisposableDesktop(options);
  adapter.request = request;
  return { adapter, request, result: await runDedicatedDesktopAction(request, adapter) };
}

test("install drains, installs an exact lock, targets the leased processes, and discovers in a fresh task", async () => {
  const { adapter, result } = await execute("install");
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidenceLane, "desktop");
  assert.equal(result.freshTask.taskId, "task-fresh");
  assert.deepEqual(adapter.calls.map((call) => call[0]), ["drainHost", "installPlugin", "restartTarget", "createFreshTask", "discoverPlugin"]);
  assert.deepEqual(adapter.calls[2].slice(2), [4101, 4102]);
});

test("Desktop automation is dedicated, host-serialized, fixed-driver, and contains no generic termination", async () => {
  const workflow = await readFile(new URL("../.github/workflows/experiment-ci.yml", import.meta.url), "utf8");
  const entrypoint = await readFile(new URL("../scripts/run-dedicated-desktop-lifecycle.mjs", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../src/dedicated-desktop-runtime.mjs", import.meta.url), "utf8");
  assert.match(workflow, /runs-on: \[self-hosted, macOS, nelos-dedicated-desktop\]/u);
  assert.match(workflow, /group: dedicated-desktop-\$\{\{ inputs\.desktop_host_id \}\}/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/u);
  assert.match(entrypoint, /\/Library\/NelosDesktopWorker\/automation-driver\.mjs/u);
  assert.match(entrypoint, /\/Library\/NelosDesktopWorker\/requests/u);
  for (const source of [workflow, entrypoint, runtime]) {
    assert.doesNotMatch(source, /\b(?:pkill|killall)\b/u);
  }
});
test("restart and crash recovery operate only on the exact leased app and backend", async () => {
  for (const action of ["restart", "crash-recovery"]) {
    const { adapter } = await execute(action);
    assert.deepEqual(adapter.calls[0], ["restartTarget", action, 4101, 4102]);
    assert.ok(adapter.calls.every((call) => !["pkill", "killall", "terminateGeneric"].includes(call[0])));
  }
  const { adapter } = await execute("cancel");
  assert.deepEqual(adapter.calls, [["cancelTarget", 4101, 4102]]);
});

test("upgrade and rollback both drain, restart, and prove exact discovery in a new task", async () => {
  const upgrade = await execute("upgrade");
  assert.deepEqual(upgrade.adapter.calls[1], ["installPlugin", "0.7.0"]);
  assert.equal(upgrade.result.freshTask.discovery.version, "0.7.0");
  const rollback = await execute("rollback");
  assert.deepEqual(rollback.adapter.calls.map((call) => call[0]), [
    "drainHost", "reimageHost", "verifyReimage", "installPlugin", "restartTarget", "createFreshTask", "discoverPlugin",
  ]);
  assert.deepEqual(rollback.adapter.calls[3], ["installPlugin", "0.5.3"]);
  assert.equal(rollback.result.freshTask.discovery.version, "0.5.3");
});

test("cleanup proves no tasks, credentials, or writable state remain; failure quarantines", async () => {
  const clean = await execute("cleanup");
  assert.deepEqual(clean.adapter.calls.map((call) => call[0]), ["cleanupLease", "verifyClean"]);
  const request = fixture("cleanup");
  const adapter = new DisposableDesktop({ failCleanup: true });
  await assert.rejects(runDedicatedDesktopAction(request, adapter), (error) => error.code === "CLEANUP_FAILED");
  assert.equal(adapter.calls.at(-1)[0], "quarantineHost");
});

test("signed golden image reimage is drained and re-establishes an unreachable development boundary", async () => {
  const { adapter, result } = await execute("reimage");
  assert.equal(result.status, "succeeded");
  assert.deepEqual(adapter.calls.map((call) => call[0]), ["drainHost", "reimageHost", "verifyReimage"]);
});

test("development homes, wrong users, stale fences, headless claims, and non-exact targets fail before effects", async () => {
  const cases = [
    ["DEVELOPMENT_STATE_REACHABLE", (request) => request.worker.isolation.addressableHomes.push("/Users/developer")],
    ["AUTOMATION_USER_REQUIRED", (request) => { request.actorUser = "developer"; }],
    ["LEASE_NOT_CURRENT", (request) => { request.lease.fencingToken = "stale-fence"; }],
    ["HEADLESS_EVIDENCE", (request) => { request.evidenceLane = "headless"; }],
    ["TARGET_MISMATCH", (request) => { request.target.appPid += 1; }],
  ];
  for (const [code, mutate] of cases) {
    const request = fixture("restart");
    mutate(request);
    assert.throws(() => admitDedicatedDesktopAction(request), (error) => error instanceof DedicatedDesktopRuntimeError && error.code === code);
  }
});

test("unexpected tasks, drift, socket mismatch, crash loops, and ambiguous mutations quarantine the host", async () => {
  const cases = [
    ["UNEXPECTED_TASK", (request) => request.observed.taskIds.push("intruder")],
    ["PROFILE_DRIFT", (request) => { request.observed.profileDigest = digest("e"); }],
    ["PLUGIN_DRIFT", (request) => { request.observed.pluginCopies = 2; }],
    ["PLUGIN_DRIFT", (request) => { request.observed.pluginVersion = "9.9.9"; }],
    ["SOCKET_MISMATCH", (request) => { request.observed.socketOwnerPid += 1; }],
    ["CRASH_LOOP", (request) => { request.observed.crashCount = 3; }],
  ];
  for (const [code, mutate] of cases) {
    const request = fixture("restart");
    mutate(request);
    const adapter = new DisposableDesktop();
    await assert.rejects(runDedicatedDesktopAction(request, adapter), (error) => error.code === code);
    assert.deepEqual(adapter.calls.at(-1), ["quarantineHost", request.worker.hostId, code]);
  }
  const request = fixture("restart");
  const adapter = new DisposableDesktop();
  adapter.request = request;
  adapter.restartTarget = async () => ({ ...request.target, bundlePath: "/Applications/Codex.app" });
  await assert.rejects(runDedicatedDesktopAction(request, adapter), (error) => error.code === "AMBIGUOUS_MUTATION");
  assert.equal(adapter.calls.at(-1)[0], "quarantineHost");
});
