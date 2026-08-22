import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hclPath = new URL("../validation/proxmox-desktop/v1/golden-image.pkr.hcl", import.meta.url);
const provisionPath = new URL("../validation/proxmox-desktop/v1/provision-golden-image.sh", import.meta.url);
const bindRuntimePath = new URL("../validation/proxmox/desktop/helpers/nelos-bind-runtime", import.meta.url);
const wrapperPath = new URL("../validation/proxmox-desktop/v1/build-golden-image.mjs", import.meta.url);

test("Desktop clone build preserves the source OS disk and uses isolated Cloud-Init SSH", async () => {
  const [hcl, wrapper] = await Promise.all([readFile(hclPath, "utf8"), readFile(wrapperPath, "utf8")]);
  assert.doesNotMatch(hcl, /^\s*disks\s*\{/mu, "a proxmox-clone disks block replaces the source template disks");
  for (const required of [
    /cloud_init\s*=\s*true/u,
    /cloud_init_storage_pool\s*=\s*var\.storage_pool/u,
    /ssh_clear_authorized_keys\s*=\s*true/u,
    /insecure_skip_tls_verify\s*=\s*false/u,
  ]) assert.match(hcl, required);
  assert.match(wrapper, /`-only=\$\{PACKER_TARGET\}`/u);
});

test("Packer variable validation messages satisfy its full-sentence contract", async () => {
  const hcl = await readFile(hclPath, "utf8");
  const messages = [...hcl.matchAll(/error_message\s*=\s*"([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(messages.length, 4);
  for (const message of messages) assert.match(message, /^[A-Z].*[.?]$/u);
});

test("golden provisioning removes the ephemeral communicator key before attesting no credentials", async () => {
  const [script, binder] = await Promise.all([readFile(provisionPath, "utf8"), readFile(bindRuntimePath, "utf8")]);
  const deletion = script.indexOf("-name authorized_keys -delete");
  const absenceCheck = script.indexOf("SSH authorization state could not be removed");
  assert.ok(deletion >= 0 && absenceCheck > deletion, "authorized_keys must be removed and then independently checked");
  assert.match(script, /getent passwd nelosauto.*die/u);
  assert.match(script, /cloud-init clean --logs --seed/u);
  assert.match(script, /bundled Codex digest mismatch/u);
  assert.match(script, /bundled Node digest mismatch/u);
  assert.match(script, /stat -c '%u:%g:%a' \/usr\/libexec\/nelos-guest-task-control.*0:0:755/u);
  assert.match(script, /#!\/usr\/lib\/chatgpt\/resources\/cua_node\/bin\/node/u);
  assert.match(binder, /ensure_directory "\$\{workspace\}" "\$\{uid\}" "\$\{gid\}" 700/u);
  assert.match(binder, /\.providerId == "proxmox-lab" and \.hostId == "prox2" and \.gatewayId == "9023"/u);
  assert.match(binder, /flock -w 10 9/u);
  assert.match(binder, /assert_regular "\$\{path\}" "\$\{expected_root_uid\}" "\$\{expected_root_gid\}" 440 16384/u);
  assert.doesNotMatch(binder, /systemctl stop nelos-desktop-session\.service[^\n]*\|\| true/u);
  assert.match(binder, /temporary="\$\(mktemp "\$\{directory\}\/\.\$\{name\}\.XXXXXXXX"\)"/u);
  assert.match(binder, /fsync_path "\$\{temporary\}"[\s\S]*mv -f "\$\{temporary\}" "\$\{destination\}"[\s\S]*fsync_path "\$\{directory\}"/u);
  const intent = binder.indexOf('publish_json "${intent_file}" "${binding}"');
  const stop = binder.indexOf("systemctl stop nelos-desktop-session.service");
  const publish = binder.indexOf('publish_json "${binding_file}" "${binding}"');
  const intentRemoval = binder.lastIndexOf('remove_durable "${intent_file}"');
  assert.ok(intent >= 0 && stop > intent && publish > stop && intentRemoval > publish, "binding must durably journal before teardown and clear intent only after durable publication");
});
