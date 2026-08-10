# Proxmox validator template

Status: source-only foundation. The repository contains an executable,
checksum-pinned recipe; it does not contain a VM image, Proxmox backup, live
cluster configuration, credential, generated variable file, or live validation
receipt. Nothing in ordinary CI contacts or mutates Proxmox.

The target is a Proxmox VE 8.4, Ubuntu 24.04, x86_64 VM for Linux Codex CLI
plugin validation. macOS, Codex Desktop, IDE integrations, Windows, and arm64
are outside this template's scope.

## What is implemented

- `contract.json` and its closed schema define the Linux-only hardware,
  isolation, two-Codex-lane, retention, and evidence requirements.
- `toolchain.lock.json` pins the controller Packer binary, Proxmox plugin,
  Ubuntu cloud image, Node.js, and both self-contained Codex CLI archives by
  exact URL and SHA-256 digest. It also fixes the Ubuntu APT snapshot used for
  every guest package installation so a rebuild cannot silently select newer
  package candidates.
- `scripts/bootstrap-cloud-image-template.sh` creates a clean Ubuntu base
  template on one explicitly selected PVE node.
- `scripts/attest-base-template-disks.sh` measures the exact logical bytes of
  the immutable SCSI and EFI clone sources through a node-local forced command.
- `packer/` plus `scripts/build-template.sh` create an immutable validator
  template from that base on an isolated Linux controller.
- The offline validator, tests, ShellCheck, and Packer syntax checks run without
  Proxmox credentials or a lab endpoint.

The live validation runner is intentionally not implemented yet. In
particular, this slice does not create the disposable validation clone, enforce
deny-all validation networking, install both Nelos plugin formats, start Codex,
collect MCP evidence, or delete the clone. The current checkout still uses the
legacy `.codex-plugin/plugin.json` and `.mcp.json` layout; the root
`plugin.json`/`mcp.json` agent-plugin layout in the contract is a migration
target, not a current pass claim.

## Dedicated Linux controller VM

Use a disposable or snapshotted Ubuntu Server 24.04 LTS x86_64 VM. Do not use a
Proxmox hypervisor, a developer workstation, or a Mac that has an active Codex
Desktop/plugin setup.

Recommended controller sizing:

- 4 portable x86_64 vCPUs; 2 is a practical minimum.
- 8 GiB RAM; 4 GiB is a practical minimum.
- 40 GiB thin-provisioned disk.
- One untagged `vmbr0` NIC using DHCP.
- Outbound HTTPS to the immutable artifact hosts in `toolchain.lock.json`.
- HTTPS access to the selected PVE API hostname, public-key-only SSH access to
  the selected node's forced-command disk attester, and SSH reachability to the
  temporary build guest.

Install the internal Proxmox CA into the controller operating system's trust
store and use an API hostname covered by its certificate. TLS verification is
mandatory; the Packer source fixes `insecure_skip_tls_verify = false`.

Controller prerequisites are Bash, Git, OpenSSH, curl, jq, unzip, SHA-256
utilities, and the lock-pinned Node.js 24.18.0. The build wrapper downloads and
verifies the exact Packer 1.15.4 and Proxmox plugin 1.2.4 Linux archives itself;
it never uses a controller-installed Packer binary or plugin cache.

Each invocation creates a fresh mode-0700 child beneath the operator-supplied
`NELOS_PACKER_STATE_DIR`, which must itself be a mode-0700 absolute directory
outside the checkout. Packer config, plugin, cache, XDG, and temporary paths are
isolated there and deleted on exit. The wrapper requires an exact clean Git
commit, materializes only the four expected HCL files and their allowlisted
inputs directly from that commit into the run directory, and executes the
sealed copy. Git replacement objects are disabled and any loose or packed
`refs/replace/*` entry is rejected before the source revision is resolved. It
refuses macOS, arm64, a PVE host, proxy variables, command-line overrides,
unknown `PKR_VAR_*` values, extra HCL source, or an unclean checkout.
The controller checkout is a trusted, single-purpose build input: no other
process may mutate its common Git directory while the wrapper runs. The wrapper
rejects alternates and partial/promisor repositories and verifies every
materialized blob against its source object ID; it does not replace repository
maintenance with a full object-database `fsck` on every build.

Evidence `candidate.treeSha256` is object-format-scoped Git plumbing data: the
SHA-256 of
`nelos.proxmox.candidate-tree.git-ls-tree.v1\0objectFormat=<sha1|sha256>\0`
followed by the raw, NUL-delimited
`git ls-tree -r -z --full-tree <sourceRevision> --` bytes with replacement
objects disabled. Record modes, object types, object IDs, and raw paths are
bound without a text round trip or sort. Gitlinks are forbidden. SHA-1 and
SHA-256 repositories intentionally have different digest domains; this is not
a cross-object-format identity, and its object binding inherits the security
properties of the repository's storage object format. It is not a digest of a
Git-generated tar archive. A future live-runner archive must record a separate
`archiveSha256`.

Evidence inspection uses the fixed system Git with system/global configuration,
lazy fetches, fsmonitor, commit graphs, multi-pack indexes, and replacement
objects disabled. Repository alternates and partial/promisor configuration are
rejected before cleanliness or object reads, so offline validation cannot
silently obtain or substitute candidate objects through those backends.

## Proxmox prerequisites

For each target node, identify:

- A node-local, active, enabled, `images`-capable VM disk storage.
- A node-local, active, enabled, `images`-capable EFI storage.
- A node-local, active, enabled, `images`-capable Cloud-Init storage.
- A node-local, active, enabled `dir` storage with `snippets` enabled.
- An untagged `vmbr0` with DHCP and provisioning-time outbound internet.

The persistent VM and EFI disks require node-local `lvmthin` or `zfspool`
backends so the validator template can provide snapshots and linked clones.
The transient inherited and final Cloud-Init disks use full-copy semantics and
may also use node-local `dir` or plain thick `lvm`. The snippets role remains
restricted to `dir`. Both scripts require each selected storage to report
`active=1` and `enabled=1` through the selected node's PVE storage status API.
VM disks are node-local, so a template built on one node is not assumed to
exist on another. Run the bootstrap and validator-template build separately for
each target node, using a different VMID and name each time.

VMIDs are cluster-wide even when storage is node-local. Reserve and inventory
the base-template VMID, validator-template VMID, previous-generation VMID, and
future disposable-clone VMIDs before any mutation. A documented high range such
as `9000`-`9099` is reasonable only after confirming every selected ID is free
across the cluster. Neither script discovers and claims “the next” VMID.

## Identity and secret boundary

Use a dedicated Proxmox API token in `user@realm!token-id` form. Scope it to the
selected node, the dedicated validator resource pool if one is used, approved
node-local storages, and reserved VMIDs as narrowly as PVE ACLs permit. Do not
use a root token or a password.

Packer reads these process-scoped values directly:

- `PROXMOX_URL`
- `PROXMOX_USERNAME`
- `PROXMOX_TOKEN`

The token must come from an approved secret store and must never be written to
an example file, shell history, log, Packer variable file, or repository. The
wrapper disables shell tracing, ignores curl configuration files, and refuses
proxy variables. The token still exists in the dedicated controller process
environment while Packer runs, so the controller must remain single-purpose.

Packer generates a one-run SSH key pair in memory, injects its public key with
Cloud-Init, and removes build authorization before template conversion. No
developer SSH key or forwarded agent is accepted by this recipe.

## Base disk attestation boundary

PVE 8.4 exposes a configuration digest but no REST checksum for existing
`lvmthin` or `zfspool` VM volumes. A digest copied into a VM description would
not bind the disk bytes. Before Packer may full-clone a retained base, the
controller therefore sends a fresh nonce to a fixed, node-local attester over
public-key-only SSH. The attester hashes the complete logical byte range of
`scsi0` and `efidisk0`, returns their logical sizes and storage-native
identities, and binds the response to the exact current PVE config digest. The
controller compares those values with an operator-pinned trusted bootstrap
receipt, then re-reads current and pending configuration immediately before
Packer runs.

Cloud-Init `ide2` is not content-hashed. PVE recognizes the Cloud-Init volume
during clone, allocates a fresh destination, and skips copying its source data;
the pinned Packer source then regenerates that drive before first boot. Its
configuration, backend, and volume name remain part of the closed preflight.

Node root is the measurement trust anchor: a compromised PVE root can alter a
volume and falsify any node-local measurement. Within that boundary, the
attester requires an inactive, read-only, activation-skip LVM thin base volume,
or an unchanged ZFS current zvol whose bytes remain equivalent to its stable
`@__base__` linked-clone snapshot (`written@__base__=0`). Full clones read the
current zvol; linked clones use that snapshot. The attester compares storage
identity before and after the sequential read. A missing zvol link fails
closed. Each base build performs one full logical read of its 64 GiB SCSI disk,
so allow adequate local I/O time.

Install one attester endpoint per base VMID on its owning PVE node:

1. Copy `attest-base-template-disks.sh` to
   `/usr/local/sbin/attest-base-template-disks.sh` as `root:root` mode `0755`.
   This permanent forced-command copy is separate from the protected sibling
   copy used by a one-time bootstrap invocation; keep both byte-identical to
   the reviewed commit while rebuilding the base.
2. Copy `examples/base-disk-attester.json.example` to
   `/etc/nelos-validator/base-disk-attester.json`, replace every identity with
   that node's exact values, and set the file to `root:root` mode `0600`.
3. Create a dedicated `nelos-attester` Unix account and its SSH paths with
   explicit ownership and modes. Keep the home non-writable by group/other so
   `sshd` `StrictModes` accepts the key:

   ```sh
   /usr/sbin/useradd --system --create-home --home-dir /var/lib/nelos-attester --shell /bin/bash nelos-attester
   /usr/sbin/usermod --lock nelos-attester
   /usr/bin/install -d -o nelos-attester -g nelos-attester -m 0750 /var/lib/nelos-attester
   /usr/bin/install -d -o nelos-attester -g nelos-attester -m 0700 /var/lib/nelos-attester/.ssh
   test ! -L /var/lib/nelos-attester/.ssh/authorized_keys
   test ! -e /var/lib/nelos-attester/.ssh/authorized_keys || test -f /var/lib/nelos-attester/.ssh/authorized_keys
   test -e /var/lib/nelos-attester/.ssh/authorized_keys || /usr/bin/install -o nelos-attester -g nelos-attester -m 0600 /dev/null /var/lib/nelos-attester/.ssh/authorized_keys
   /usr/bin/chown nelos-attester:nelos-attester /var/lib/nelos-attester/.ssh/authorized_keys
   /usr/bin/chmod 0600 /var/lib/nelos-attester/.ssh/authorized_keys
   ```

   Its only accepted key must be the dedicated controller key described below.
4. Install this exact sudoers grant as a root-owned mode-`0440` file and verify
   it with `visudo -cf`:

   ```text
   Defaults:nelos-attester env_reset,secure_path="/usr/sbin:/usr/bin:/sbin:/bin"
   nelos-attester ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/attest-base-template-disks.sh serve
   ```

5. Put one line in that account's mode-`0600` `authorized_keys`, substituting
   the controller's fixed source IP and public key:

   ```text
   from="<controller-ip>",restrict,command="/usr/bin/sudo -n /usr/local/sbin/attest-base-template-disks.sh serve" ssh-ed25519 <controller-public-key>
   ```

The dedicated private key remains outside the repository, mode `0600`, inside
a mode-`0700` controller directory. It must be directly usable without a prompt
(normally a dedicated passphrase-less key), because the build deliberately
disables agents and interactive askpass. Pin the node's SSH host key in a
separate read-only `known_hosts` file after verifying its fingerprint through
the PVE console; do not trust an unverified `ssh-keyscan` result. The build
wrapper ignores SSH config and agents, disables passwords, proxies, jumps,
forwarding, multiplexing, local commands, and TTYs, and accepts only the pinned
host key and identity file. `CheckHostIP` is disabled intentionally so a
hostname target cannot mutate the pinned file with a newly resolved address;
host authentication still requires its exact pinned key.

Before enabling the key, compare the installed attester's SHA-256 with the
exact file at the merged source revision from the controller or homelab
orchestration. Record that source revision and helper digest beside the trusted
baseline receipt. This detects accidental deployment drift; node root remains
the stated measurement trust anchor.

An existing retained base cannot acquire historical provenance by being hashed
today. Rebuild it from the checksum-verified Ubuntu image with the merged
bootstrap and save the final JSON receipt as the trusted baseline. Point the
private build environment at that complete protected receipt; the wrapper binds
its receipt kind, locked Ubuntu digest, template/config identity, volume IDs,
backends, native identities, hashes, and sizes to the fresh measurement. A
later mismatch requires a fresh trusted rebuild; never rebaseline an
unexplained retained disk.

## 1. Validate the checkout offline

From an exact, clean source commit on the controller:

```bash
node validation/proxmox/scripts/validate-contract.mjs
NODE_OPTIONS=--require=./scripts/offline-network-blocker.cjs \
  node --import ./scripts/test-bootstrap.mjs \
  --test validation/proxmox/test/proxmox-template-contract.test.mjs
bash -n validation/proxmox/scripts/*.sh
shellcheck validation/proxmox/scripts/*.sh
```

These commands are read-only. The path-filtered GitHub workflow performs the
same checks and checksum-installs its Linux Packer tooling into runner-temporary
directories; it has no Proxmox secrets.

## 2. Bootstrap one base template

Review and copy `examples/bootstrap.env.example` to a private temporary file.
Set its values for exactly one target node. Copy the bootstrap and attester
scripts together to a protected directory on that node and run the bootstrap
there as root with no positional arguments.

For example, after copying both files to root-owned paths on the selected PVE
node:

```bash
sudo -i
source /root/private/nelos-bootstrap.env
test ! -e /root/private/nelos-base-baseline-receipt.json
umask 077
/root/bootstrap-cloud-image-template.sh > /root/private/nelos-base-baseline-receipt.json
```

The script performs a cluster-wide VMID/name collision check, verifies PVE 8.4,
checks that every storage is node-local and has the required content role,
downloads and verifies the immutable Ubuntu image, and uses a uniquely named
Cloud-Init snippet to install `qemu-guest-agent`. It boots the owned VM, waits
for Cloud-Init through the guest agent, scrubs machine identity, removes the
snippet reference, and only then converts the VM to a template. After the final
configuration is settled, it invokes the local attester and prints the trusted
baseline JSON receipt as the only standard-output record. Save that mode-`0600`
receipt outside the repository. A failed measurement leaves the template for
explicit operator reconciliation and does not print a usable baseline.

The image-cache directory and cached image must be root-owned and not writable
by group or other users. The configured snippets storage root and its
`snippets` directory have the same ownership and write restrictions; a missing
`snippets` directory is created as `root:root` mode `0755`. Every path must be
canonical and have a root-owned, non-symlink, non-writable ancestor chain; the
only writable-ancestor exception is a root-owned sticky `/tmp` or `/var/tmp`.

Secure Boot enrollment is disabled (`pre-enrolled-keys=0`) because this lane
does not yet test Secure Boot. The hardware contract is fixed to q35/OVMF,
`x86-64-v2-AES`, 4 vCPUs, 8 GiB RAM, a 64 GiB SCSI disk, `vmbr0`, DHCP, and the
PVE firewall flag.

On failure, cleanup re-reads the exact VMID, name, and unique ownership tag.
Only a matching, owned incomplete VM is stopped and destroyed. There is no
`--purge`, lock bypass, VMID-range cleanup, name-pattern cleanup, or
unreferenced-volume sweep. Ambiguous state is left for operator review.

## 3. Build one validator template

On the dedicated controller, review and copy `examples/build.env.example` to a
private temporary file, replace every placeholder, inject the token separately,
and export the values into the current process. Then run:

```bash
source /private/path/nelos-build.env
export PROXMOX_TOKEN="$(approved-secret-command)"
validation/proxmox/scripts/build-template.sh
```

The wrapper validates the repository contract before querying PVE, verifies the
exact base VMID/name/node/ownership tag, verifies the output VMID and name are
unused cluster-wide, and checks the Cloud-Init storage. It then requires a
fresh, baseline-matching node attestation for the exact inherited SCSI and EFI
bytes. Before any mutation, it
checksum-downloads the locked Linux Packer and plugin archives, installs the
plugin into private one-run state, and performs a full semantic validation
behind a dead proxy with synthetic credentials. It seals the inspected inputs
into a mode-0600, highest-precedence temporary JSON variable file, so an ambient
config or auto variable file cannot redirect the mutation after preflight.

Root provisioning and identity cleanup inside the guest require a matching
one-run UUID marker created by the active Packer communicator, plus Ubuntu
24.04/x86_64/KVM checks. The scripts refuse to run directly on an ordinary
Linux controller.

Immediately before the mutation, the wrapper prints the exact source revision
and `nelos-build-<nonce>` ownership tag. Packer runs with `-on-error=abort`. A
failed build is not automatically deleted; it remains tagged for exact inventory
reconciliation. This repository intentionally provides no broad cleanup command.

## Node-local rollout and retention

Build the active generation independently on every node that should host it.
Record node, storage IDs, VMID, name, source commit, contract digest, lock
digest, trusted SCSI/EFI logical hashes and sizes, and build ownership tag in an
operator-controlled receipt. Do not assume that a template or linked clone can
move between node-local backends.

Keep the active validated generation indefinitely. Keep the immediately
replaced known-good generation for at least 30 days and until the replacement
has passed live clone, boot, validation, evidence export, exact cleanup, and
rollback-readiness checks. Disposable build VMs and future validation clones
are not retained.

## Live-validation handoff

Before this can produce a valid evidence document, a follow-on Linux runner must:

1. Create a same-node, disposable linked clone with a newly reserved VMID and a
   unique ownership marker.
2. Enforce and attest validation-time network denial using PVE firewall rules or
   a quarantine bridge; `firewall=1` alone is not a deny policy.
3. Create each run and lane root from `contract.json` with no shared mutable
   home, Codex home, cache, temporary directory, or plugin cache.
4. Install the exact source commit in both the legacy and agent-plugin layouts.
5. Start a fresh Codex process for each lane and verify MCP initialize,
   `tools/list`, `nelos_config_get`, and exact tool parity.
6. Export only schema-valid, sanitized evidence and then reconcile and delete
   the exact owned clone.

A Linux VM can establish Linux CLI behavior only. macOS and Codex Desktop need
a separate, disposable real-Mac validation lane; successful Proxmox results
must not be generalized to those surfaces.

## References

- [Packer Proxmox clone builder](https://developer.hashicorp.com/packer/integrations/hashicorp/proxmox/latest/components/builder/clone)
- [Packer input variable precedence](https://developer.hashicorp.com/packer/docs/templates/hcl_templates/variables)
- [Ubuntu Noble release checksums](https://cloud-images.ubuntu.com/releases/noble/release-20260801/SHA256SUMS)
- [Codex plugin documentation](https://learn.chatgpt.com/docs/plugins)
