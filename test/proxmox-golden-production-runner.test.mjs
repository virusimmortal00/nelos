import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HARNESS = resolve("test/support/fake-golden-production-runtime.mjs");

async function root(t, label) { const path = await mkdtemp(join(tmpdir(), `nelos-golden-${label}-`)); await chmod(path, 0o700); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function invoke(command, path, crash = "none") {
  try { const result = await exec(process.execPath, [HARNESS, command, path, crash], { env: { PATH: process.env.PATH, NODE_OPTIONS: "--import=./scripts/test-bootstrap.mjs" } }); return { code: 0, ...result }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

async function journal(path) {
  const pointer = JSON.parse(await readFile(join(path, "journal", "CURRENT"), "utf8"));
  return JSON.parse(await readFile(join(path, "journal", "entries", `${pointer.digest.slice(7)}.json`), "utf8"));
}

for (const crash of ["gateway-policy-active", "builder-provisioned", "builder-terminal-stored", "builder-destroyed", "gateway-policy-restored"]) {
  test(`fresh process resumes ${crash} without duplicating a mutation`, async (t) => {
    const path = await root(t, crash); const interrupted = await invoke("start", path, crash); assert.equal(interrupted.code, 86);
    const completed = await invoke("resume", path); assert.equal(completed.code, 0, completed.stderr); assert.equal(JSON.parse(completed.stdout).state, "succeeded");
    const world = JSON.parse(await readFile(join(path, "world.json"), "utf8"));
    assert.deepEqual(world.effects, { apply: 1, controller: 1, destroy: 1, provision: 1, restore: 1, stop: 1 });
    assert.equal(world.gateway, "original"); assert.equal(world.builderPresent, false);
    const pointer = JSON.parse(await readFile(join(path, "journal", "CURRENT"), "utf8"));
    const journal = JSON.parse(await readFile(join(path, "journal", "entries", `${pointer.digest.slice(7)}.json`), "utf8"));
    assert.doesNotMatch(JSON.stringify(journal), /password|privateKey|tokenValue|credential/iu);
  });
}

for (const ambiguity of ["lost-controller-response", "partial-controller-terminal"]) {
  test(`fresh process preserves and reconciles ${ambiguity} on the same builder without replaying Packer`, async (t) => {
    const path = await root(t, ambiguity);
    const interrupted = await invoke("start", path, ambiguity); assert.equal(interrupted.code, 1); assert.match(interrupted.stderr, /BUILDER_CONTROLLER_RECONCILIATION_REQUIRED/u);
    let world = JSON.parse(await readFile(join(path, "world.json"), "utf8"));
    assert.equal(world.builderPresent, true); assert.equal(world.builderStatus, "running"); assert.equal(world.gateway, "original");
    assert.deepEqual(world.effects, { apply: 1, controller: 1, destroy: 0, provision: 1, restore: 1, stop: 0 });
    assert.match(world.controllerPacketDigest, /^sha256:[0-9a-f]{64}$/u); assert.match(world.controllerTerminalDigest, /^sha256:[0-9a-f]{64}$/u);
    const interruptedJournal = await journal(path);
    assert.equal(interruptedJournal.state, "interrupted");
    assert.ok(interruptedJournal.events.some(({ event }) => event === "builder-controller-reconciliation-required"));

    const completed = await invoke("resume", path); assert.equal(completed.code, 0, completed.stderr); assert.equal(JSON.parse(completed.stdout).state, "succeeded");
    world = JSON.parse(await readFile(join(path, "world.json"), "utf8"));
    assert.deepEqual(world.effects, { apply: 2, controller: 1, destroy: 1, provision: 1, restore: 2, stop: 1 });
    assert.equal(world.builderPresent, false); assert.equal(world.gateway, "original"); assert.equal(world.controllerTerminalState, "committed");
    const completedJournal = await journal(path);
    assert.equal(completedJournal.state, "succeeded");
    assert.equal(completedJournal.builderTerminal.packetDigest, world.controllerPacketDigest);
    assert.equal(completedJournal.builderTerminal.terminalDigest, world.controllerTerminalDigest);
    assert.ok(completedJournal.events.some(({ event, details }) => event === "builder-provisioned" && details.providerOperationId === "reconciled-existing-builder"));
  });
}

test("cancel first reconciles the nested guest journal, then destroys the exact builder without replaying Packer", async (t) => {
  const path = await root(t, "ambiguous-cancel");
  assert.equal((await invoke("start", path, "lost-controller-response")).code, 1);
  const canceled = await invoke("cancel", path); assert.equal(canceled.code, 0, canceled.stderr); assert.equal(JSON.parse(canceled.stdout).state, "canceled");
  const world = JSON.parse(await readFile(join(path, "world.json"), "utf8"));
  assert.equal(world.builderPresent, false); assert.equal(world.gateway, "original");
  assert.deepEqual(world.effects, { apply: 1, controller: 1, destroy: 1, provision: 1, restore: 1, stop: 1 });
});

test("fresh-process cancel after active gateway performs only exact cleanup", async (t) => {
  const path = await root(t, "cancel"); assert.equal((await invoke("start", path, "gateway-policy-active")).code, 86);
  const canceled = await invoke("cancel", path); assert.equal(canceled.code, 0, canceled.stderr); assert.equal(JSON.parse(canceled.stdout).state, "canceled");
  const world = JSON.parse(await readFile(join(path, "world.json"), "utf8"));
  assert.deepEqual(world.effects, { apply: 1, controller: 0, destroy: 0, provision: 0, restore: 1, stop: 0 });
});

test("expired resume performs nested cleanup-only terminal adoption through cleanupExpiresAt", async (t) => {
  const path = await root(t, "expired-resume");
  assert.equal((await invoke("start", path, "lost-controller-response")).code, 1);
  const resumed = await invoke("resume-expired", path); assert.equal(resumed.code, 0, resumed.stderr); assert.equal(JSON.parse(resumed.stdout).state, "canceled");
  const world = JSON.parse(await readFile(join(path, "world.json"), "utf8"));
  assert.deepEqual(world.effects, { apply: 1, controller: 1, destroy: 1, provision: 1, restore: 1, stop: 1 });
  assert.equal(world.builderPresent, false); assert.equal(world.gateway, "original");
  const state = await journal(path);
  assert.ok(state.events.some(({ event }) => event === "builder-terminal-stored"));
  assert.equal(state.events.filter(({ event }) => event === "builder-provisioned").length, 1);
});

test("cleanup-only cancel scrubs an orphan between provider tasks without controller replay", async (t) => {
  const path = await root(t, "orphan-cleanup");
  assert.equal((await invoke("start", path, "orphan-between-provider-tasks")).code, 1);
  const canceled = await invoke("cancel", path); assert.equal(canceled.code, 0, canceled.stderr); assert.equal(JSON.parse(canceled.stdout).state, "canceled");
  const world = JSON.parse(await readFile(join(path, "world.json"), "utf8"));
  assert.deepEqual(world.effects, { apply: 1, controller: 1, destroy: 1, provision: 1, restore: 1, stop: 1 });
  const state = await journal(path);
  assert.ok(state.events.some(({ event }) => event === "builder-controller-cleaned"));
});

test("cleanup-only authority fails closed at cleanupExpiresAt", async (t) => {
  const path = await root(t, "cleanup-expired");
  assert.equal((await invoke("start", path, "lost-controller-response")).code, 1);
  const resumed = await invoke("resume-cleanup-expired", path); assert.equal(resumed.code, 1); assert.match(resumed.stderr, /EXPIRED_RESERVATION/u);
  const world = JSON.parse(await readFile(join(path, "world.json"), "utf8"));
  assert.equal(world.builderPresent, true); assert.deepEqual(world.effects, { apply: 1, controller: 1, destroy: 0, provision: 1, restore: 1, stop: 0 });
});

for (const command of ["invalid-builder-identity", "invalid-output-identity"]) {
  test(`fresh process rejects internally re-digested ${command} before any provider call`, async (t) => {
    const path = await root(t, command);
    const result = await invoke(command, path); assert.equal(result.code, 1); assert.match(result.stderr, /INVALID_(?:CONTRACT|RESERVATION)/u);
    const world = JSON.parse(await readFile(join(path, "world.json"), "utf8"));
    assert.deepEqual(world.effects, { apply: 0, controller: 0, destroy: 0, provision: 0, restore: 0, stop: 0 });
  });
}

test("production runner source composes both concrete guarded lifecycle functions", async () => {
  const source = await readFile(resolve("validation/proxmox-desktop/v1/golden-builder-production-runner.mjs"), "utf8");
  assert.match(source, /runGatewayProtectedGoldenBuilderV1/u); assert.match(source, /runDisposableGoldenBuilderV1/u);
  const schema = JSON.parse(await readFile(resolve("validation/proxmox-desktop/v1/golden-builder-production-config.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false); assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.equal(schema.$defs.reservation.additionalProperties, false); assert.deepEqual([...schema.$defs.reservation.required].sort(), Object.keys(schema.$defs.reservation.properties).sort());
  assert.equal(schema.$defs.reservation.properties.outputTemplate.properties.vmId.const, 9027);
  const hostBinding = JSON.parse(await readFile(resolve("validation/proxmox-desktop/v1/golden-builder-host-binding.schema.json"), "utf8"));
  assert.equal(hostBinding.properties.lifecycleBinding.properties.builderVm.properties.vmId.const, 9026);
  assert.equal(hostBinding.properties.lifecycleBinding.properties.outputTemplateVmId.const, 9027);
});
