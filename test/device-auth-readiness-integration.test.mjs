import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { verifyDeviceAuthIsolation } from "../src/proxmox-desktop-runtime.mjs";

const NO_CORE_POLICY = Object.freeze({
  "/etc/security/limits.d/99-nelos-no-core.conf": "* soft core 0\n* hard core 0\nroot soft core 0\nroot hard core 0\n",
  "/etc/systemd/system.conf.d/99-nelos-no-core.conf": "[Manager]\nDefaultLimitCORE=0\n",
  "/etc/systemd/user.conf.d/99-nelos-no-core.conf": "[Manager]\nDefaultLimitCORE=0\n",
  "/etc/systemd/coredump.conf.d/99-nelos-no-core.conf": "[Coredump]\nStorage=none\nProcessSizeMax=0\nExternalSizeMax=0\n",
  "/etc/sysctl.d/99-nelos-no-core.conf": "fs.suid_dumpable = 0\nkernel.core_pattern = /dev/null\n",
  "/etc/default/apport": "enabled=0\n",
});
const CORE_COLLECTORS = Object.freeze(["apport.service", "apport-autoreport.path", "apport-autoreport.service", "systemd-coredump.socket", "systemd-coredump@.service"]);

async function installNoCoreFixture(root) {
  for (const [path, bytes] of Object.entries(NO_CORE_POLICY)) {
    const target = join(root, path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, bytes, { mode: 0o644 }); await chmod(target, 0o644);
  }
  for (const [path, bytes] of [["/proc/sys/fs/suid_dumpable", "0\n"], ["/proc/sys/kernel/core_pattern", "/dev/null\n"]]) {
    const target = join(root, path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, bytes, { mode: 0o644 });
  }
  const unitRoot = join(root, "etc/systemd/system"); await mkdir(unitRoot, { recursive: true });
  for (const unit of CORE_COLLECTORS) await symlink("/dev/null", join(unitRoot, unit));
}

function run(command, args, environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

test("real device-auth start/status receipt satisfies the real GUI readiness helper", async (t) => {
  const root = await realpath(await mkdtemp("/tmp/nelos-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const bin = join(root, "bin");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const digest = `sha256:${"a".repeat(64)}`;
  const binding = {
    automationUser: "nelosauto", fencingToken: "fence-auth-integration", hostId: "prox2", imageId: "image-auth-integration",
    leaseId: "lease-auth-integration", macAddress: "02:4E:45:4C:94:51", networkId: "nelosbld", gatewayId: "9023",
    networkPolicyDigest: `sha256:${"9".repeat(64)}`, providerId: "proxmox-lab", runId: "run-auth-integration",
    stateRoot: "/var/lib/nelos-desktop/runs/run-auth-integration", vmId: "9451",
  };
  for (const path of [
    bin, join(root, "etc/nelos-desktop"), join(root, "var/lib/nelos-desktop"), join(root, "usr/libexec"),
    join(root, "usr/lib/chatgpt/resources/cua_node/bin"), join(root, `run/user/${uid}`), join(root, "run/lock"),
    join(root, "home/nelosauto"), join(root, "proc/sys/kernel/random"),
  ]) await mkdir(path, { recursive: true, mode: 0o700 });
  await installNoCoreFixture(root);
  await writeFile(join(root, ".nelos-credential-boundary-fake-root"), "nelos-credential-boundary-fake-v1\n", { mode: 0o600 });
  await mkdir(join(root, ".nelos-credential-boundary-bin"), { mode: 0o700 });
  await writeFile(join(root, "proc/swaps"), "Filename\tType\tSize\tUsed\tPriority\n", { mode: 0o600 });
  await writeFile(join(root, "proc/sys/kernel/random/boot_id"), "11111111-2222-4333-8444-555555555555\n", { mode: 0o600 });
  const bindingPath = join(root, "etc/nelos-desktop/run-binding.json");
  await writeFile(bindingPath, `${JSON.stringify(binding)}\n`, { mode: 0o440 });
  const gid = (await lstat(bindingPath)).gid;
  const identity = join(root, "usr/libexec/nelos-desktop-identity");
  const credentialHelper = join(root, "usr/libexec/nelos-credential-boundary");
  const controller = join(root, "usr/libexec/nelos-device-auth-controller");
  const readinessHelper = join(root, "usr/libexec/nelos-check-gui-readiness");
  const node = join(root, "usr/lib/chatgpt/resources/cua_node/bin/node");
  await writeFile(identity, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await copyFile(resolve("validation/proxmox/desktop/helpers/nelos-credential-boundary"), credentialHelper);
  await chmod(credentialHelper, 0o755);
  await copyFile(resolve("validation/proxmox/desktop/recipe-v1/check-gui-readiness.sh"), readinessHelper);
  await chmod(readinessHelper, 0o755);
  await writeFile(controller, "test-only controller marker\n", { mode: 0o600 });
  await writeFile(node, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ accountBindingDigest: digest, accountType: "chatgpt", authenticated: true, credentialStore: "file" })}'\n`, { mode: 0o755 });
  const systemctl = `#!/bin/sh
if [ "$1" = show ] && printf '%s' "$*" | /usr/bin/grep -q DefaultLimitCORE; then printf '0\\n'; exit 0; fi
if [ "$1" = is-active ] && [ "$3" = nelos-device-auth.service -o "$2" = nelos-device-auth.service ]; then
  [ -f "${root}/run/nelos-desktop/auth-active" ]
  exit $?
fi
if [ "$1" = start ] && [ "$2" = nelos-device-auth.service ]; then
  [ "$(ulimit -c)" = 0 ] || exit 97
  mkdir -p "${root}/run/nelos-desktop/auth" "${root}/home/nelosauto/.codex"
  touch "${root}/run/nelos-desktop/auth-active"
  printf '%s\\n' '${JSON.stringify({ type: "chatgptDeviceCode", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/device" })}' >"${root}/run/nelos-desktop/auth/challenge.json"
  printf '%s\\n' '{"tokens":"test-only"}' >"${root}/home/nelosauto/.codex/auth.json"
  chmod 0600 "${root}/run/nelos-desktop/auth/challenge.json" "${root}/home/nelosauto/.codex/auth.json"
fi
if [ "$1" = stop ] && [ "$2" = nelos-device-auth.service ]; then rm -f "${root}/run/nelos-desktop/auth-active"; fi
if [ "$1" = is-failed ]; then exit 1; fi
exit 0
`;
  const scripts = {
    systemctl,
    id: `#!/bin/sh\nif [ "$1" = -g ]; then printf '${gid}\\n'; else printf '${uid}\\n'; fi\n`,
    loginctl: `#!/bin/sh\nif [ "$1" = list-sessions ]; then printf '7 ${uid} nelosauto seat0\\n'; elif printf '%s' "$*" | /usr/bin/grep -q Type; then printf 'x11\\n'; else printf 'active\\n'; fi\n`,
    scrot: "#!/bin/sh\nexit 0\n", convert: "#!/bin/sh\nexit 0\n", identify: "#!/bin/sh\nexit 0\n", import: "#!/bin/sh\nexit 0\n",
    runuser: '#!/bin/sh\n[ "$1" = -u ] || exit 1\nshift 2\n[ "$1" = -- ] || exit 1\nshift\nexec "$@"\n',
    swapon: "#!/bin/sh\nexit 0\n",
    flock: "#!/bin/sh\nexit 0\n",
    sha256sum: "#!/bin/sh\nexec shasum -a 256 \"$@\"\n",
    findmnt: `#!/bin/sh
if [ -f "${root}/home/nelosauto/.codex/.mounted" ]; then
  if printf '%s' "$*" | /usr/bin/grep -q 'TARGET,SOURCE,FSTYPE,OPTIONS'; then
    printf '${root}/home/nelosauto/.codex nelos-codex-${binding.runId} tmpfs rw,nosuid,nodev,noexec,relatime,size=65536k,mode=700,uid=${uid},gid=${gid}\\n'
  else
    printf 'tmpfs\\n'
  fi
  exit 0
fi
exit 1
`,
    mount: `#!/bin/sh\ntouch "${root}/home/nelosauto/.codex/.mounted"\nexit 0\n`,
    umount: `#!/bin/sh\n/usr/bin/find "${root}/home/nelosauto/.codex" -mindepth 1 -delete\nexit 0\n`,
  };
  for (const [name, source] of Object.entries(scripts)) { await writeFile(join(bin, name), source, { mode: 0o755 }); await chmod(join(bin, name), 0o755); }
  for (const name of ["findmnt", "flock", "id", "mount", "sha256sum", "swapon", "systemctl", "umount"]) {
    await copyFile(join(bin, name), join(root, ".nelos-credential-boundary-bin", name));
    await chmod(join(root, ".nelos-credential-boundary-bin", name), 0o755);
  }
  const environment = {
    ...process.env, PATH: `${bin}:/usr/bin:/bin`, NELOS_DEVICE_AUTH_ROOT: root, NELOS_DEVICE_AUTH_TEST_MODE: "1",
  };
  const authHelper = resolve("validation/proxmox/desktop/helpers/device-auth.sh");
  const started = await run("/bin/bash", [authHelper, "start"], environment);
  assert.equal(started.code, 0, started.stderr);
  assert.deepEqual(JSON.parse(started.stdout), { type: "chatgptDeviceCode", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/device", status: "authorization_required" });
  const status = await run("/bin/bash", [authHelper, "status"], environment);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).authenticated, true);
  const receipt = JSON.parse(await readFile(join(root, "var/lib/nelos-desktop/device-auth.json"), "utf8"));
  assert.deepEqual(receipt.binding, binding);
  assert.notEqual(receipt.binding, true);
  assert.equal(receipt.accountBindingDigest, digest);
  assert.equal(verifyDeviceAuthIsolation(receipt, binding), receipt);

  await writeFile(join(root, `run/user/${uid}/nelos-accessibility-ready`), "", { mode: 0o600 });
  const socketPath = join(root, `run/user/${uid}/bus`); const server = createServer();
  await new Promise((resolvePromise) => server.listen(socketPath, resolvePromise));
  t.after(() => new Promise((closed) => server.close(closed)));
  const readiness = await run("/bin/bash", ["-u", resolve("validation/proxmox/desktop/recipe-v1/check-gui-readiness.sh")], {
    ...environment, NELOS_READINESS_ROOT: root, NELOS_READINESS_TEST_MODE: "1", NELOS_READINESS_ATTEMPTS: "1",
  });
  assert.equal(readiness.code, 0, readiness.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(root, "var/lib/nelos-desktop/gui-ready.json"), "utf8")), {
    schemaVersion: 1, binding, ready: true, accessibilityBus: true, captureReady: true, sessionUser: "nelosauto",
  });

  const corePattern = join(root, "proc/sys/kernel/core_pattern");
  await writeFile(corePattern, "/var/lib/systemd/coredump/core\n", { mode: 0o644 });
  const authBlockedByCoreDrift = await run("/bin/bash", [authHelper, "start"], environment);
  assert.equal(authBlockedByCoreDrift.code, 77);
  assert.match(authBlockedByCoreDrift.stderr, /global no-core policy is unavailable or drifted/u);
  const readinessBlockedByCoreDrift = await run("/bin/bash", ["-u", resolve("validation/proxmox/desktop/recipe-v1/check-gui-readiness.sh")], {
    ...environment, NELOS_READINESS_ROOT: root, NELOS_READINESS_TEST_MODE: "1", NELOS_READINESS_ATTEMPTS: "1",
  });
  assert.equal(readinessBlockedByCoreDrift.code, 77);
  await writeFile(corePattern, "/dev/null\n", { mode: 0o644 });
  const systemPolicy = join(root, "etc/systemd/system.conf.d/99-nelos-no-core.conf");
  await unlink(systemPolicy);
  const authBlockedByPolicyAbsence = await run("/bin/bash", [authHelper, "status"], environment);
  assert.equal(authBlockedByPolicyAbsence.code, 77);
  assert.match(authBlockedByPolicyAbsence.stderr, /global no-core policy is unavailable or drifted/u);
  await writeFile(systemPolicy, NO_CORE_POLICY["/etc/systemd/system.conf.d/99-nelos-no-core.conf"], { mode: 0o644 });
  await chmod(systemPolicy, 0o644);

  const boundaryEnvironment = {
    ...environment, NELOS_CREDENTIAL_BOUNDARY_ROOT: root, NELOS_CREDENTIAL_BOUNDARY_TEST_MODE: "1",
  };
  const boundaryAttested = await run("/bin/bash", [credentialHelper, "attest"], boundaryEnvironment);
  assert.equal(boundaryAttested.code, 0, boundaryAttested.stderr);

  const boundaryBin = join(root, ".nelos-credential-boundary-bin");
  await writeFile(join(boundaryBin, "swapon"), '#!/bin/sh\nprintf "/dev/vda2\\n"\n', { mode: 0o755 });
  const swapDrift = await run("/bin/bash", [credentialHelper, "attest"], boundaryEnvironment);
  assert.equal(swapDrift.code, 77);
  assert.match(swapDrift.stderr, /active swap would persist credential pages/u);
  await copyFile(join(bin, "swapon"), join(boundaryBin, "swapon"));
  await chmod(join(boundaryBin, "swapon"), 0o755);

  await writeFile(join(boundaryBin, "findmnt"), `#!/bin/sh
printf '${root}/home/nelosauto/.codex wrong-run-source tmpfs rw,nosuid,nodev,noexec\\n'
`, { mode: 0o755 });
  const mountDrift = await run("/bin/bash", [credentialHelper, "attest"], boundaryEnvironment);
  assert.equal(mountDrift.code, 77);
  assert.match(mountDrift.stderr, /not the exact run-scoped tmpfs/u);
  await copyFile(join(bin, "findmnt"), join(boundaryBin, "findmnt"));
  await chmod(join(boundaryBin, "findmnt"), 0o755);

  await chmod(bindingPath, 0o600);
  await writeFile(bindingPath, `${JSON.stringify({ ...binding, imageId: "image-auth-drift" })}\n`);
  await chmod(bindingPath, 0o440);
  const imageDrift = await run("/bin/bash", [credentialHelper, "attest"], boundaryEnvironment);
  assert.equal(imageDrift.code, 77);
  assert.match(imageDrift.stderr, /differs from this run, fence, VM, image, or boot/u);
  await chmod(bindingPath, 0o600);
  await writeFile(bindingPath, `${JSON.stringify(binding)}\n`);
  await chmod(bindingPath, 0o440);

  const canceled = await run("/bin/bash", [authHelper, "cancel"], environment);
  assert.equal(canceled.code, 0, canceled.stderr);
  const cancelStatus = JSON.parse(canceled.stdout);
  assert.equal(cancelStatus.status, "cancelled");
  assert.equal(cancelStatus.credentialState, "absent");
  assert.match(cancelStatus.attestationDigest, /^sha256:[0-9a-f]{64}$/u);
  const scrub = JSON.parse(await readFile(join(root, "var/lib/nelos-desktop/credential-scrub.json"), "utf8"));
  assert.equal(scrub.reusableCredentialsAbsent, true);
  assert.equal(scrub.secretBytesIncluded, false);
  await assert.rejects(readFile(join(root, "home/nelosauto/.codex/auth.json"), "utf8"), { code: "ENOENT" });
  const reopened = await run("/bin/bash", [authHelper, "start"], environment);
  assert.equal(reopened.code, 77);
  assert.match(reopened.stderr, /cannot be reopened/u);
});
