import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createProductionGuestTaskIntentV1, productionGuestTaskDigestV1 } from "../src/production-guest-task.mjs";

const helper = resolve("validation/proxmox/desktop/helpers/nelos-guest-task-control.mjs");
const fakeAppServer = resolve("test/support/fake-production-task-app-server.mjs");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

function invoke(input, environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [helper], { env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) {
        const error = new Error(Buffer.concat(stderr).toString("utf8") || `guest helper exited ${code}`);
        error.exitCode = code; rejectPromise(error); return;
      }
      try { resolvePromise(JSON.parse(output)); } catch (error) { rejectPromise(error); }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

test("fresh guest helper creates exactly one empty task after bound auth and read-adopts it across processes", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nelos-guest-task-helper-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const stateRoot = "/var/lib/nelos-desktop/runs/run-guest-helper";
  const binding = {
    automationUser: "nelosauto", fencingToken: "fence-guest-helper", hostId: "prox2", imageId: "golden-1",
    leaseId: "lease-guest-helper", macAddress: "02:4E:45:4C:94:01", networkId: "nelosbld", gatewayId: "9023",
    networkPolicyDigest: `sha256:${"9".repeat(64)}`, providerId: "proxmox-lab", runId: "run-guest-helper", stateRoot, vmId: "9401",
  };
  const intent = createProductionGuestTaskIntentV1({ runId: binding.runId, fencingToken: binding.fencingToken, scenarioId: "desktop-guest-helper", title: "desktop-guest-helper" });
  const accountEmail = "guest-helper@example.invalid";
  const accountBindingDigest = `sha256:${createHash("sha256").update(binding.runId).update("\0").update(accountEmail).digest("hex")}`;
  const paths = [
    "/etc/nelos-desktop", "/var/lib/nelos-desktop", stateRoot,
    "/home/nelosauto/.codex", "/home/nelosauto/workspace", "/usr/lib/chatgpt/resources",
  ];
  for (const path of paths) await mkdir(`${root}${path}`, { recursive: true, mode: path === stateRoot ? 0o700 : 0o700 });
  const fakeCodex = `${root}/usr/lib/chatgpt/resources/codex`;
  await writeFile(fakeCodex, "test-only pinned command marker\n", { mode: 0o755 });
  await writeFile(`${root}/etc/nelos-desktop/run-binding.json`, `${JSON.stringify(binding)}\n`, { mode: 0o440 });
  await writeFile(`${root}/var/lib/nelos-desktop/device-auth.json`, `${JSON.stringify({
    schemaVersion: 1, binding, authenticated: true, accountType: "chatgpt", accountBindingDigest,
    authMethod: "chatgptDeviceCode", credentialStore: "file", developerSessionImported: false,
  })}\n`, { mode: 0o440 });
  const statePath = join(root, "app-server-state.json");
  await writeFile(statePath, `${JSON.stringify({
    accountEmail,
    expectedCwd: `${root}/home/nelosauto/workspace`,
    initialize: {
      codexHome: `${root}/home/nelosauto/.codex`, platformFamily: "unix", platformOs: "linux",
      userAgent: "Codex Desktop/0.148.0-alpha.15",
    },
    methods: [], mode: "normal", startCalls: 0, threads: {},
  })}\n`, { mode: 0o600 });
  const environment = {
    NELOS_CANDIDATE_ROOT: resolve("."),
    NELOS_DESKTOP_HELPER_ROOT: root,
    NELOS_FAKE_PRODUCTION_TASK_COMMAND: fakeAppServer,
    NELOS_FAKE_PRODUCTION_TASK_STATE: statePath,
  };
  const request = { schemaVersion: 1, operation: "prepare", payload: { intent } };
  const first = await invoke(request, environment);
  const auth = await invoke({ schemaVersion: 1, operation: "observe-auth", payload: {} }, environment);
  const { attestationDigest, ...authBase } = auth;
  assert.deepEqual({ source: auth.source, runId: auth.runId, fencingToken: auth.fencingToken, accountBindingDigest: auth.accountBindingDigest }, {
    source: "codex-app-server-account-read", runId: binding.runId, fencingToken: binding.fencingToken, accountBindingDigest,
  });
  assert.equal(attestationDigest, `sha256:${createHash("sha256").update(canonical(authBase)).digest("hex")}`);
  await unlink(`${root}${stateRoot}/task-producer/guest-receipt-${productionGuestTaskDigestV1(intent).slice(7)}.json`);
  const reconciled = await invoke({ schemaVersion: 1, operation: "reconcile", payload: { intent } }, environment);
  const second = await invoke(request, environment);
  const read = await invoke({ schemaVersion: 1, operation: "read", payload: { intent } }, environment);
  assert.deepEqual(reconciled, first);
  assert.deepEqual(second, first);
  assert.deepEqual(read, first);
  assert.equal(first.intentDigest, productionGuestTaskDigestV1(intent));
  assert.equal(first.taskSlotId, intent.taskSlotId);
  assert.notEqual(first.taskId, intent.taskSlotId);
  assert.equal(first.initialTurnStarted, false);
  assert.deepEqual(first.inventory, { beforeTaskIds: [], afterTaskIds: [first.taskId], complete: true, maximumTasks: 100 });
  assert.equal(first.accountBindingDigest, accountBindingDigest);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.startCalls, 1);
  assert.deepEqual(state.threads[first.taskId].turns, []);
  assert.equal(state.threads[first.taskId].name, intent.title);
  assert.equal(state.methods.includes("turn/start"), false);
  assert.equal(state.methods.filter((method) => method === "thread/start").length, 1);
});
