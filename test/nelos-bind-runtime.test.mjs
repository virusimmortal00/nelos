import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const helper = new URL("../validation/proxmox/desktop/helpers/nelos-bind-runtime", import.meta.url).pathname;
const markerBytes = "nelos-bind-runtime-fake-root-v1\n";

function quote(value) { return `'${value.replaceAll("'", `'\\''`)}'`; }
function binding(overrides = {}) {
  const value = {
    automationUser: "nelosauto",
    fencingToken: "fence-001",
    gatewayId: "9023",
    hostId: "prox2",
    imageId: "nelos-desktop-ubuntu-24-04-v1",
    leaseId: "lease-001",
    macAddress: "02:00:00:00:23:28",
    networkId: "nelosbld",
    networkPolicyDigest: `sha256:${"a".repeat(64)}`,
    providerId: "proxmox-lab",
    runId: "run-001",
    stateRoot: "/var/lib/nelos-desktop/runs/run-001",
    vmId: "9028",
    ...overrides,
  };
  if (overrides.runId && !Object.hasOwn(overrides, "stateRoot")) value.stateRoot = `/var/lib/nelos-desktop/runs/${overrides.runId}`;
  return value;
}
function encoded(value) { return Buffer.from(JSON.stringify(value)).toString("base64"); }

async function executable(path, contents) {
  await writeFile(path, contents, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-bind-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  for (const path of ["run", "etc", "var/lib", "home/nelosauto", ".nelos-bind-runtime-bin"]) await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  await chmod(join(root, ".nelos-bind-runtime-bin"), 0o700);
  await writeFile(join(root, ".nelos-bind-runtime-fake-root"), markerBytes, { mode: 0o600 });
  await chmod(join(root, ".nelos-bind-runtime-fake-root"), 0o600);
  const state = join(root, ".systemctl-state");
  const behavior = join(root, ".systemctl-behavior");
  const log = join(root, ".systemctl-log");
  await writeFile(state, "active\n", { mode: 0o600 });
  await writeFile(behavior, "normal\n", { mode: 0o600 });
  await writeFile(log, "", { mode: 0o600 });
  await executable(join(root, ".nelos-bind-runtime-bin/flock"), `#!/usr/bin/env python3
import fcntl, sys, time
args=sys.argv[1:]
if len(args) != 3 or args[0] != "-w": sys.exit(64)
deadline=time.monotonic()+float(args[1]); fd=int(args[2])
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB); sys.exit(0)
    except BlockingIOError:
        if time.monotonic() >= deadline: sys.exit(1)
        time.sleep(0.01)
`);
  await executable(join(root, ".nelos-bind-runtime-bin/systemctl"), `#!/bin/sh
set -eu
state=${quote(state)}
behavior=${quote(behavior)}
log=${quote(log)}
printf '%s\\n' "$*" >> "$log"
case "$1" in
  stop)
    current="$(cat "$behavior")"
    [ "$current" != fail-stop ] || exit 1
    [ "$current" != slow-stop ] || sleep 0.35
    [ "$current" = stay-active ] || printf 'inactive\\n' > "$state"
    ;;
  is-active)
    [ "$(cat "$state")" = active ] && exit 0
    exit 3
    ;;
  *) exit 64 ;;
esac
`);
  return { root, state, behavior, log };
}

async function run(item, value = binding()) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [helper, "--fake-root", item.root, encoded(value)], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

async function sealedJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o440 });
  await chmod(path, 0o440);
}

test("an internally consistent alternate VNet fails before guest service teardown or filesystem publication", async (t) => {
  const item = await fixture(t);
  const result = await run(item, binding({ networkId: "caller-selected" }));
  assert.equal(result.code, 65);
  assert.equal(await readFile(item.log, "utf8"), "");
  await assert.rejects(lstat(join(item.root, "etc/nelos-desktop/run-binding.json")), /ENOENT/u);
});

test("executable binder publishes one durable exact binding and leaves no predictable temporary", async (t) => {
  const item = await fixture(t); const value = binding();
  const result = await run(item, value);
  assert.equal(result.code, 0, result.stderr);
  const path = join(item.root, "etc/nelos-desktop/run-binding.json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), value);
  assert.equal((await lstat(path)).mode & 0o777, 0o440);
  await assert.rejects(lstat(join(item.root, "etc/nelos-desktop/run-binding.intent.json")), /ENOENT/u);
  assert.equal((await lstat(join(item.root, "home/nelosauto/workspace"))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(item.root, value.stateRoot))).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(join(item.root, "etc/nelos-desktop"))).sort(), ["run-binding.json"]);
  assert.deepEqual((await readFile(item.log, "utf8")).trim().split("\n"), [
    "stop nelos-desktop-session.service",
    "is-active --quiet nelos-desktop-session.service",
  ]);
});

test("same-run retry validates bound auth/readiness and completes a post-publish intent without teardown", async (t) => {
  const item = await fixture(t); const value = binding();
  assert.equal((await run(item, value)).code, 0);
  const etc = join(item.root, "etc/nelos-desktop"); const state = join(item.root, "var/lib/nelos-desktop");
  await sealedJson(join(etc, "run-binding.intent.json"), value);
  await sealedJson(join(state, "device-auth.json"), {
    accountBindingDigest: `sha256:${"b".repeat(64)}`, accountType: "chatgpt", authMethod: "chatgptDeviceCode",
    authenticated: true, binding: value, credentialStore: "file", developerSessionImported: false, schemaVersion: 1,
  });
  await sealedJson(join(state, "gui-ready.json"), {
    accessibilityBus: true, binding: value, captureReady: true, ready: true, schemaVersion: 1, sessionUser: "nelosauto",
  });
  const before = await readFile(item.log, "utf8");
  const retried = await run(item, value);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(await readFile(item.log, "utf8"), before, "an already bound live run must not be stopped again");
  await assert.rejects(lstat(join(etc, "run-binding.intent.json")), /ENOENT/u);
});

test("concurrent same-run binders serialize and perform readiness teardown exactly once", async (t) => {
  const item = await fixture(t); const value = binding();
  await writeFile(item.behavior, "slow-stop\n");
  const [first, second] = await Promise.all([run(item, value), run(item, value)]);
  assert.equal(first.code, 0, first.stderr); assert.equal(second.code, 0, second.stderr);
  const calls = (await readFile(item.log, "utf8")).trim().split("\n");
  assert.equal(calls.filter((line) => line.startsWith("stop ")).length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(item.root, "etc/nelos-desktop/run-binding.json"), "utf8")), value);
});

test("failed stop is recoverable only by the same run and fence", async (t) => {
  const item = await fixture(t); const value = binding();
  await writeFile(item.behavior, "fail-stop\n");
  const failed = await run(item, value);
  assert.notEqual(failed.code, 0);
  await assert.rejects(lstat(join(item.root, "etc/nelos-desktop/run-binding.json")), /ENOENT/u);
  assert.deepEqual(JSON.parse(await readFile(join(item.root, "etc/nelos-desktop/run-binding.intent.json"), "utf8")), value);
  const divergent = await run(item, binding({ runId: "run-002", fencingToken: "fence-002" }));
  assert.equal(divergent.code, 77);
  assert.match(divergent.stderr, /cannot be rebound/u);
  await writeFile(item.behavior, "normal\n");
  const recovered = await run(item, value);
  assert.equal(recovered.code, 0, recovered.stderr);
});

test("a service that remains active leaves a retryable same-run intent and no binding", async (t) => {
  const item = await fixture(t); const value = binding();
  await writeFile(item.behavior, "stay-active\n");
  const failed = await run(item, value);
  assert.equal(failed.code, 77);
  assert.match(failed.stderr, /remained active/u);
  await assert.rejects(lstat(join(item.root, "etc/nelos-desktop/run-binding.json")), /ENOENT/u);
  await writeFile(item.behavior, "normal\n");
  assert.equal((await run(item, value)).code, 0);
});

test("preexisting auth/readiness objects without a binding fail closed and are never unlinked", async (t) => {
  for (const name of ["device-auth.json", "gui-ready.json"]) {
    await t.test(name, async (child) => {
      const item = await fixture(child); const target = join(item.root, "sentinel");
      await writeFile(target, "preserve\n", { mode: 0o600 });
      const path = join(item.root, "var/lib/nelos-desktop", name);
      await mkdir(dirname(path), { recursive: true, mode: 0o750 });
      await symlink(target, path);
      const result = await run(item);
      assert.equal(result.code, 77);
      assert.match(result.stderr, /exists without/u);
      assert.equal(await readFile(target, "utf8"), "preserve\n");
      assert.equal((await lstat(path)).isSymbolicLink(), true);
      assert.equal(await readFile(item.log, "utf8"), "");
    });
  }
});

test("unsafe existing binding metadata and differently-bound readiness fail closed", async (t) => {
  const item = await fixture(t); const value = binding();
  assert.equal((await run(item, value)).code, 0);
  const bindingPath = join(item.root, "etc/nelos-desktop/run-binding.json");
  await chmod(bindingPath, 0o660);
  const unsafe = await run(item, value);
  assert.equal(unsafe.code, 77);
  assert.match(unsafe.stderr, /unsafe runtime file metadata/u);
  await chmod(bindingPath, 0o440);
  await sealedJson(join(item.root, "var/lib/nelos-desktop/gui-ready.json"), {
    accessibilityBus: true, binding: binding({ fencingToken: "other-fence" }), captureReady: true,
    ready: true, schemaVersion: 1, sessionUser: "nelosauto",
  });
  const mismatched = await run(item, value);
  assert.equal(mismatched.code, 77);
  assert.match(mismatched.stderr, /readiness receipt is unsafe or differently bound/u);
});

test("obsolete fixed temporary names cannot be consumed or replaced", async (t) => {
  const item = await fixture(t); const etc = join(item.root, "etc/nelos-desktop");
  await mkdir(etc, { recursive: true, mode: 0o750 }); await chmod(etc, 0o750);
  const fixed = join(etc, "run-binding.json.new");
  await writeFile(fixed, "sentinel\n", { mode: 0o600 });
  const result = await run(item);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(fixed, "utf8"), "sentinel\n");
});

test("fake-root execution requires the exact sealed marker", async (t) => {
  const item = await fixture(t);
  await chmod(join(item.root, ".nelos-bind-runtime-fake-root"), 0o644);
  const result = await run(item);
  assert.equal(result.code, 70);
  await assert.rejects(lstat(join(item.root, "etc/nelos-desktop/run-binding.json")), /ENOENT/u);
});
