import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { sha256V1 } from "../validation/proxmox-desktop/v1/build-golden-image.mjs";
import { executeGoldenBuilderGuestControllerV1, validateGoldenBuilderGuestControllerAccessV1 } from "../validation/proxmox-desktop/v1/golden-builder-guest-controller.mjs";

const exec = promisify(execFile);
const HOST_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILiNq9QOutY4VHdlX7n2fNRQtlF1uXQGQIxfF9mlJSmm";
const HOST_FINGERPRINT = "SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-guest-controller-")); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const identity = join(root, "builder-identity"); await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]); await chmod(identity, 0o600);
  const { stdout } = await exec("/usr/bin/ssh-keygen", ["-lf", identity, "-E", "sha256"]); const fingerprint = stdout.trim().split(/\s+/u)[1];
  const stagingRoot = join(root, "staging"); const sourceRoot = join(root, "source-checkout"); await mkdir(stagingRoot, { mode: 0o700 }); await mkdir(sourceRoot, { mode: 0o700 });
  const workspace = { sourceRoot };
  for (const name of ["attestorTokenFile", "buildTokenFile", "nodeArchive", "packerArchive", "pluginArchive", "tlsCaFile", "volumeIdentityFile", "volumeKnownHostsFile"]) {
    const path = join(root, `${name}.sealed`); await writeFile(path, name.includes("Token") ? "never-emit-this-secret\n" : `${name}\n`, { mode: 0o600 }); await chmod(path, 0o600); workspace[name] = path;
  }
  const access = { schemaVersion: 1, kind: "nelos-golden-builder-guest-controller-access", builderIdentityFile: identity, stagingRoot, limits: { operationTimeoutMs: 600_000, maxOutputBytes: 65_536 }, workspace };
  const packet = { packetDigest: `sha256:${"a".repeat(64)}`, reservationDigest: `sha256:${"b".repeat(64)}`, builderVm: { sshHostFingerprint: HOST_FINGERPRINT } };
  const bundle = { builderPacket: packet }; const controllerIdentity = { packetDigest: packet.packetDigest };
  const binding = { builderVm: { sshPublicKeyFingerprint: fingerprint } };
  const observation = { status: "running", guest: { hostKeyFingerprint: HOST_FINGERPRINT, hostPublicKey: HOST_PUBLIC_KEY, sshAddress: "10.77.77.26" } };
  const unsigned = { schemaVersion: 1, kind: "nelos-golden-builder-terminal", result: "committed", packetDigest: packet.packetDigest, reservationDigest: packet.reservationDigest, attestationDigest: `sha256:${"c".repeat(64)}`, goldenImageDigest: `sha256:${"d".repeat(64)}`, completedAt: "2026-08-20T12:00:00.000Z" };
  const terminal = { ...unsigned, terminalDigest: sha256V1(unsigned) };
  return { root, access, packet, bundle, controllerIdentity, binding, observation, terminal };
}

test("concrete guest controller pins QGA-observed SSH, stages sealed inputs, and retrieves only terminal JSON", async (t) => {
  const value = await fixture(t); const calls = []; let ready = false; let transfers = 0;
  const boundary = {
    async invoke(request) {
      calls.push(request); const command = request.args.join(" ");
      if (command.includes("/usr/bin/cat /var/lib/nelos-golden-controller/") && command.includes("/state/controller-ready")) {
        return ready ? { code: 0, stdout: Buffer.from(`${value.packet.packetDigest}\n`), stderr: Buffer.alloc(0) } : { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (command.includes("/usr/bin/install") && command.includes("/state/controller-ready")) { assert.deepEqual(request.input, Buffer.from(`${value.packet.packetDigest}\n`)); ready = true; }
      if (command.includes("/usr/bin/cat /var/lib/nelos-golden-controller/") && command.includes("/terminal/")) return { code: 0, stdout: Buffer.from(`${JSON.stringify(value.terminal)}\n`), stderr: Buffer.alloc(0) };
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    async transfer(request) { transfers += 1; calls.push(request); return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
  };
  const result = await executeGoldenBuilderGuestControllerV1(value, { boundary }); assert.deepEqual(result, value.terminal); assert.equal(transfers, 1);
  const commands = calls.map(({ args }) => args.join(" ")).join("\n");
  for (const token of ["10.77.77.26", "StrictHostKeyChecking=yes", "ForwardAgent=no", "IdentitiesOnly=yes", "ProxyCommand=none", "run-golden-builder-controller.sh"]) assert.match(commands, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(commands, /accept-new|StrictHostKeyChecking=no|never-emit-this-secret/u);
});

test("retry invokes the same durably staged controller, which adopts its existing terminal without retransferring secrets", async (t) => {
  const value = await fixture(t); let transfers = 0; let controllerInvokes = 0;
  const boundary = { async invoke(request) {
    const command = request.args.join(" ");
    if (command.includes("/state/controller-ready") && command.includes("/usr/bin/cat")) return { code: 0, stdout: Buffer.from(`${value.packet.packetDigest}\n`), stderr: Buffer.alloc(0) };
    if (command.includes("run-golden-builder-controller.sh")) controllerInvokes += 1;
    if (command.includes("/terminal/") && command.includes("/usr/bin/cat")) return { code: 0, stdout: Buffer.from(`${JSON.stringify(value.terminal)}\n`), stderr: Buffer.alloc(0) };
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }, async transfer() { transfers += 1; } };
  assert.deepEqual(await executeGoldenBuilderGuestControllerV1(value, { boundary }), value.terminal);
  assert.equal(controllerInvokes, 1); assert.equal(transfers, 0);
});

test("lost controller success response preserves staging and the next call adopts the same terminal without replaying work", async (t) => {
  const value = await fixture(t); let ready = false; let transfers = 0; let controllerInvokes = 0; let packerEffects = 0; let terminal = null;
  const boundary = { async invoke(request) {
    const command = request.args.join(" ");
    if (command.includes("/state/controller-ready") && command.includes("/usr/bin/cat")) return ready
      ? { code: 0, stdout: Buffer.from(`${value.packet.packetDigest}\n`), stderr: Buffer.alloc(0) }
      : { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (command.includes("/usr/bin/install") && command.includes("/state/controller-ready")) { ready = true; return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command.includes("run-golden-builder-controller.sh")) {
      controllerInvokes += 1;
      if (!terminal) { packerEffects += 1; terminal = value.terminal; throw Object.assign(new Error("SSH response lost"), { code: "DEADLINE_EXPIRED" }); }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (command.includes("/terminal/") && command.includes("/usr/bin/cat")) return { code: 0, stdout: Buffer.from(`${JSON.stringify(terminal)}\n`), stderr: Buffer.alloc(0) };
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }, async transfer() { transfers += 1; return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } };
  await assert.rejects(() => executeGoldenBuilderGuestControllerV1(value, { boundary }), { code: "CONTROLLER_OUTCOME_AMBIGUOUS" });
  assert.deepEqual(await executeGoldenBuilderGuestControllerV1(value, { boundary }), value.terminal);
  assert.equal(packerEffects, 1); assert.equal(controllerInvokes, 2); assert.equal(transfers, 1);
});

test("partial terminal state is routed through the locked nested recovery controller before it is read", async (t) => {
  const value = await fixture(t); const phases = []; let transfers = 0;
  const boundary = { async invoke(request) {
    const command = request.args.join(" ");
    if (command.includes("/state/controller-ready") && command.includes("/usr/bin/cat")) return { code: 0, stdout: Buffer.from(`${value.packet.packetDigest}\n`), stderr: Buffer.alloc(0) };
    if (command.includes("run-golden-builder-controller.sh")) { phases.push("recover"); return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command.includes("/terminal/") && command.includes("/usr/bin/cat")) { phases.push("read"); return { code: 0, stdout: Buffer.from(`${JSON.stringify(value.terminal)}\n`), stderr: Buffer.alloc(0) }; }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }, async transfer() { transfers += 1; } };
  assert.deepEqual(await executeGoldenBuilderGuestControllerV1(value, { boundary }), value.terminal);
  assert.deepEqual(phases, ["recover", "read"]); assert.equal(transfers, 0);
});

test("cleanup-only guest invocation returns a separate digest-bound cleanup terminal", async (t) => {
  const value = await fixture(t); const calls = [];
  const unsigned = { schemaVersion: 1, kind: "nelos-golden-builder-cleanup-terminal", result: "cleaned", packetDigest: value.packet.packetDigest, reservationDigest: value.packet.reservationDigest, completedAt: "2026-08-20T13:00:00.000Z" };
  const cleanup = { ...unsigned, cleanupDigest: sha256V1(unsigned) };
  const boundary = { async invoke(request) {
    const command = request.args.join(" "); calls.push(command);
    if (command.includes("/state/controller-ready") && command.includes("/usr/bin/cat")) return { code: 0, stdout: Buffer.from(`${value.packet.packetDigest}\n`), stderr: Buffer.alloc(0) };
    if (command.includes(".cleanup.json") && command.includes("/usr/bin/cat")) return { code: 0, stdout: Buffer.from(`${JSON.stringify(cleanup)}\n`), stderr: Buffer.alloc(0) };
    if (command.includes(`/terminal/${value.packet.packetDigest.slice(7)}.json`) && command.includes("/usr/bin/cat")) return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }, async transfer() { throw new Error("staged inputs must be adopted"); } };
  assert.deepEqual(await executeGoldenBuilderGuestControllerV1({ ...value, cleanupOnly: true }, { boundary }), cleanup);
  assert.ok(calls.some((command) => command.includes("NELOS_GOLDEN_OPERATION=cleanup")));
});

test("invalid terminal bytes after controller success remain ambiguous instead of authorizing builder cleanup", async (t) => {
  const value = await fixture(t);
  const boundary = { async invoke(request) {
    const command = request.args.join(" ");
    if (command.includes("/state/controller-ready") && command.includes("/usr/bin/cat")) return { code: 0, stdout: Buffer.from(`${value.packet.packetDigest}\n`), stderr: Buffer.alloc(0) };
    if (command.includes("/terminal/") && command.includes("/usr/bin/cat")) return { code: 0, stdout: Buffer.from("{\n"), stderr: Buffer.alloc(0) };
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }, async transfer() { throw new Error("staged inputs must be adopted"); } };
  await assert.rejects(() => executeGoldenBuilderGuestControllerV1(value, { boundary }), (error) => error?.code === "CONTROLLER_OUTCOME_AMBIGUOUS" && error.details?.phase === "terminal-parse");
});

test("guest controller rejects an unsealed identity, wrong key, and unknown access field before SSH", async (t) => {
  const value = await fixture(t); let called = false; const boundary = { async invoke() { called = true; }, async transfer() { called = true; } };
  await assert.rejects(() => executeGoldenBuilderGuestControllerV1({ ...value, binding: { builderVm: { sshPublicKeyFingerprint: `SHA256:${"Z".repeat(43)}` } } }, { boundary }), { code: "CONTROLLER_KEY_MISMATCH" });
  assert.equal(called, false); assert.throws(() => validateGoldenBuilderGuestControllerAccessV1({ ...value.access, extra: true }), { code: "INVALID_CONTROLLER_ACCESS" });
});

test("guest controller access schema closes every nested object", async () => {
  const schema = JSON.parse(await readFile(resolve("validation/proxmox-desktop/v1/golden-builder-guest-controller-access.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false); assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  for (const key of ["limits", "workspace"]) { assert.equal(schema.properties[key].additionalProperties, false); assert.deepEqual([...schema.properties[key].required].sort(), Object.keys(schema.properties[key].properties).sort()); }
});

test("in-guest controller serializes recovery and publishes terminal bytes exclusively, atomically, and durably", async () => {
  const source = await readFile(resolve("validation/proxmox-desktop/v1/run-golden-builder-controller.sh"), "utf8");
  assert.match(source, /flock -n 9/u);
  assert.match(source, /controller-ready/u);
  assert.match(source, /renameat2/u);
  assert.match(source, /os\.fsync\(source_fd\)[\s\S]*renameat2[\s\S]*os\.fsync\(directory_fd\)/u);
  assert.match(source, /terminal_is_valid[\s\S]*rm -f -- "\$terminal_receipt"[\s\S]*guarded golden-image wrapper/u);
  assert.match(source, /NELOS_GOLDEN_CLEANUP_ONLY=1/u); assert.match(source, /cleanup_is_valid/u);
  assert.match(source, /\$identity\[0\]\.vmId == 9026[\s\S]*\.reservation\.sourceTemplate\.vmId == 9024[\s\S]*\.reservation\.outputTemplate\.vmId == 9027/u);
});
