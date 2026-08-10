# Proxmox validator template

Status: bounded pilot source. The repository contains an executable,
checksum-pinned template recipe and an explicit-operator live runner; it does
not contain a VM image, Proxmox backup, live cluster configuration, credential,
generated variable file, or live validation receipt. Nothing in ordinary CI
contacts or mutates Proxmox.

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
- `scripts/validate-build-network-attestation.sh` fails closed unless an
  operator supplies a fresh, exact-node and exact-source readiness receipt for
  the externally enforced `nelosbld` build VNet policy.
- `packer/` plus `scripts/build-template.sh` create an immutable validator
  template from that base on an isolated Linux controller.
- The `0.12.12` release payload ships both the legacy Codex plugin layout and
  the portable Agent Plugins v1 root `plugin.json`/`mcp.json` layout. Both are
  covered by the same distribution integrity digest.
- `scripts/run-live-validation.mjs` controls one explicitly selected prox2
  disposable clone, while `scripts/run-plugin-evidence.mjs` performs the two
  isolated offline Codex/plugin probes inside that guest.
- Evidence schema v2 binds candidate, template, clone safety, network denial,
  QGA and Cloud-Init readiness, both plugin lanes, cleanup, and post-cleanup
  cluster absence without exporting credentials or raw infrastructure logs.
- The offline validator, tests, ShellCheck, and Packer syntax checks run without
  Proxmox credentials or a lab endpoint.

The runner source and its simulated failure-path tests are not live evidence.
Only a schema-valid receipt produced from an exact candidate, after the owned
clone is destroyed and cluster-wide absence is verified, can support a Linux
CLI result. This remains a provisional prox2 pilot until that run is completed.

## Dedicated Linux controller VM

Use a disposable or snapshotted Ubuntu Server 24.04 LTS x86_64 VM. Do not use a
Proxmox hypervisor, a developer workstation, or a Mac that has an active Codex
Desktop/plugin setup.

Recommended controller sizing:

- 4 portable x86_64 vCPUs; 2 is a practical minimum.
- 8 GiB RAM; 4 GiB is a practical minimum.
- 40 GiB thin-provisioned disk.
- One untagged `vmbr0` NIC using DHCP.
- Reachability from the controller to the cluster-spanning `nelosbld` VNet so
  Packer can SSH to its VNet-only temporary guest.
- Outbound HTTPS to the immutable artifact hosts in `toolchain.lock.json`.
- HTTPS access to the selected PVE API hostname, public-key-only SSH access to
  the selected node's forced-command disk attester, and SSH reachability to the
  temporary build guest.

Install the internal Proxmox CA into the controller operating system's trust
store and use an API hostname covered by its certificate. TLS verification is
mandatory; the Packer source fixes `insecure_skip_tls_verify = false`.
Authenticated preflight reads use the verified fixed `/usr/bin/curl` under an
otherwise empty process environment, so they use that operating-system trust
store without ambient proxy, curl-config, loader, or shell-wrapper state. The
live Node.js controller must be started with `NODE_USE_SYSTEM_CA=1`, because the
official Node.js binary otherwise uses its bundled CA set. The runner rejects
ambient `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and
`SSL_CERT_DIR` overrides so the approved operating-system trust store remains
the explicit source of the internal PVE CA.

Controller prerequisites are Bash, Git, OpenSSH, curl, jq, unzip, SHA-256
utilities, and the lock-pinned Node.js 24.18.0. The build wrapper downloads and
verifies the exact Packer 1.15.4 and Proxmox plugin 1.2.4 Linux archives itself;
it never uses a controller-installed Packer binary or plugin cache.

Each invocation creates a fresh mode-0700 child beneath the operator-supplied
`NELOS_PACKER_STATE_DIR`, which must itself be a mode-0700 absolute directory
outside the checkout. Packer config, plugin, cache, XDG, and temporary paths are
isolated there and deleted on exit. The wrapper requires an exact clean Git
commit, rejects every symlink, gitlink, or other non-regular entry in that exact
candidate tree before Node can load repository code, and binds contract
validation to the frozen candidate revision. Validation inputs are read from
the candidate Git blobs. The wrapper then materializes only the four expected
HCL files and their allowlisted inputs directly from that commit into the run
directory and executes the sealed copy. Git replacement objects are disabled
and any loose or packed `refs/replace/*` entry is rejected before the source
revision is resolved. It refuses macOS, arm64, a PVE host, proxy variables,
command-line overrides, unknown `PKR_VAR_*` values, extra HCL source, or an
unclean checkout.
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
Git-generated tar archive. The live runner records the exact transferred tar
bytes separately as `archiveSha256`; the guest verifies that transfer digest
while `treeSha256` continues to identify the canonical tracked tree.

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
- An untagged `vmbr0` with DHCP and provisioning-time outbound internet for
  the retained Ubuntu base template.
- The preconfigured, cluster-spanning VNet named `nelosbld`, with DHCP supplied
  by that VNet for Packer's temporary clone and resulting validator template.

`nelosbld` is an external enforcement boundary, not merely a bridge name. Its
default guest egress policy must be deny. DNS must resolve only the approved
guest destinations, and the only allowed outbound transport is TCP 443 to
`snapshot.ubuntu.com`, `nodejs.org`, `github.com`, and
`release-assets.githubusercontent.com`. The two locked GitHub release URLs
currently redirect from `github.com` to `release-assets.githubusercontent.com`;
`objects.githubusercontent.com` is not in that observed redirect closure and is
not allowed. The PVE NIC `firewall=1` flag remains eligibility for filtering;
it is not the enforcement policy.

The Packer clone may use DHCP only from `nelosbld` and must have no `vmbr0`
adapter. DHCP must not install a route or resolver that bypasses the preceding
restrictions. The retained bootstrap base remains on `vmbr0`; it is not the
guest on which the restricted build policy is enforced. Controller-side Packer
and Proxmox-plugin downloads and the hypervisor-side Ubuntu image download are
checksum-pinned but are also outside this guest-egress policy; their outbound
policy remains an operator infrastructure responsibility.

Live Packer builds are blocked until homelab orchestration tests this policy and
writes a mode-`0400` readiness receipt based on
`examples/build-network-attestation.json.example`. The receipt is intentionally
valid for at most 24 hours and binds the node, exact source revision, complete
policy, and seven readiness assertions. It is operator-authored evidence, not a
cryptographic signature or an independent live network measurement. The node
operator is the trust anchor and must create it only after verifying the actual
VNet policy. Before issuing it, use a disposable VNet-only probe to verify DHCP
and the restricted resolver; positive HTTPS access to all four approved hosts;
and rejection of a non-approved hostname, a direct non-approved destination,
TCP 80, and direct DNS to any non-approved resolver. Also verify that the probe
has no `vmbr0` adapter or alternate default route and that the controller can
reach a Packer guest on `nelosbld`. These are external operator procedures; the
repository script does not perform or cryptographically prove them. The build
wrapper rejects a missing, stale, mismatched, or unprotected receipt, executes
the validator bytes sealed from the exact source revision, hashes the receipt,
and repeats validation and the hash comparison immediately before Packer
mutates Proxmox.

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
  --test \
  validation/proxmox/test/proxmox-template-contract.test.mjs \
  validation/proxmox/test/live-validation-runner.test.mjs \
  validation/proxmox/test/plugin-evidence-runner.test.mjs
bash -n validation/proxmox/scripts/*.sh
shellcheck validation/proxmox/scripts/*.sh
```

These commands are read-only. The path-filtered GitHub workflow performs the
same checks and checksum-installs its Linux Packer tooling into runner-temporary
directories; it has no Proxmox secrets.

The validator's no-argument form intentionally reads the working tree so it can
lint uncommitted local edits. The build wrapper instead passes the frozen source
revision through `--candidate-revision`; that exact-candidate mode requires a
clean checkout, rejects non-regular tracked entries, and reads candidate inputs
from Git blobs rather than following working-tree paths.

## 2. Bootstrap one base template

Review and copy `examples/bootstrap.env.example` to a private temporary file.
Set its values for exactly one target node. Copy the bootstrap and disk attester
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
`x86-64-v2-AES`, 4 vCPUs, 8 GiB RAM, a 64 GiB SCSI disk, DHCP on `vmbr0`, and
the PVE firewall flag. During Packer's full clone, the pinned source replaces
that adapter with VNet-only DHCP on `nelosbld`; the resulting validator
template retains `nelosbld`. This split keeps an existing conforming base
eligible while preventing its ordinary bridge from satisfying the build-egress
contract.

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
exact base VMID/name/node/ownership tag and its `vmbr0` adapter, verifies the
output VMID and name are unused cluster-wide, and checks the Cloud-Init storage.
It requires the protected short-lived `nelosbld` readiness receipt described
above, then requires a fresh, baseline-matching node attestation for the exact
inherited SCSI and EFI bytes. Before any mutation, it
checksum-downloads the locked Linux Packer and plugin archives, installs the
plugin into private one-run state, and performs a full semantic validation
behind a dead proxy with synthetic credentials. It seals the inspected inputs
into a mode-0600, highest-precedence temporary JSON variable file, so an ambient
config or auto variable file cannot redirect the mutation after preflight.
Immediately before mutation it revalidates the readiness receipt with the
validator blob sealed from the exact source revision and compares the receipt
with its initial SHA-256. This gate prevents the recipe from proceeding on the
bridge name alone; it does not prevent a trusted operator from making a false
assertion or convert that assertion into independent live or cryptographic
proof. After Packer reports success, the wrapper reads the output's current
configuration and status from PVE. It accepts only a stopped template with one
`virtio` adapter on `nelosbld`, DHCP, `firewall=1`, four queues, the exact
ownership tag, and no other `netN` device. A mismatch fails the run and leaves
the owned output intact for explicit reconciliation.

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
rollback-readiness checks. Disposable build VMs and validation clones
are not retained.

## Bounded prox2 live pilot

The live command is an explicit controller operation, never a CI job. It fails
before mutation unless all of these fixed pilot identities match:

Do not invoke it until prox2 source template `9021` has been rebuilt from the
merged contract/toolchain generation, its retained base disks have been
re-attested, and the externally enforced `nelosbld` policy has been tested. An
older provisional `9021` cannot satisfy the exact installed lock digest and
must not be treated as compatible merely because its VMID and name match.

1. Create a same-node, disposable linked clone with an explicitly selected,
   authoritatively unused VMID and a unique ownership marker.
2. Enforce and attest validation-time network denial using PVE firewall rules or
   a quarantine bridge; `firewall=1` alone is not a deny policy. Derive
   `lifecycle.networkDeniedDuringValidation` from guest checks before the lanes,
   during each lane, and after the lanes; report `false` whenever denial cannot
   be observed across that complete window.
3. Create each run and lane root from `contract.json` with no shared mutable
   home, Codex home, cache, temporary directory, or plugin cache. Evidence must
   bind the exact lane-local values of `HOME`, `CODEX_HOME`, `TMPDIR`,
   `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_DATA_HOME`, not only report
   that those variable names were present. The Agent Plugins lane must also bind
   `PLUGIN_ROOT` to the exact versioned cache root whose bytes produced
   `installedDistributionIntegrity`, and bind `PLUGIN_DATA` to the pinned
   0.147.0 data root derived from the marketplace and plugin identities. The
   legacy lane records both plugin-path values as `null` and must omit their
   names on a pass; a failed legacy receipt may retain a name to report
   unexpected presence safely. Read only those eight allowlisted process
   values, compare them before projection, and never serialize a mismatched or
   arbitrary environment value. Passed evidence requires every applicable
   exact path. Failed evidence uses `null` for a missing or mismatched value and
   omits the key name only when the variable itself was absent, so launch
   failures remain truthful without exposing the unexpected value.
4. Recompute the candidate distribution integrity from the exact candidate
   bytes, require its tracked provenance to match, and recompute the installed
   distribution integrity in each lane. A version or release-build string alone
   is not exact-source evidence.
5. Install the exact source commit in both the legacy and agent-plugin layouts,
   and require each verified installed digest to equal the candidate digest.
6. Start a fresh Codex process for each lane and verify MCP initialize,
   `tools/list`, `nelos_config_get`, and exact tool parity.
7. Export only schema-valid, sanitized evidence and then reconcile and delete
   the exact owned clone.

The fixed pilot identities are:

- Node `prox2` and source validator template VMID `9021`.
- One operator-selected disposable VMID from `9030` through `9039`; the runner
  never discovers or claims a next free ID.
- One exact clean candidate revision, canonical Git-tree manifest digest, and
  separate exact candidate-archive transfer digest.
- A cluster-wide unused VMID, established with PVE 8's authoritative,
  unfiltered `GET /cluster/nextid?vmid=<id>` check. The runner does not claim
  global clone-name uniqueness from the permission-filtered resource listing.

The runner generates an opaque `run-<128-bit-random-hex>` receipt ID and a
separate cryptographically random ownership nonce for every invocation. It
creates a same-node linked clone (`full=0`) with the random name and
nonce-bearing description atomically, adds the matching ownership tag, and
reads every identity field back before starting it. It removes every `netN`
device before first boot and verifies that the guest sees no non-loopback
interface. Candidate transfer and evidence return use QGA rather than SSH or
guest networking.

Each lane receives an independent mode-0700 run root, `HOME`, `CODEX_HOME`,
temporary directory, XDG directories, app-server process, and MCP process. The
probe uses app-server MCP status/list and a direct `nelos_config_get` tool call;
it does not make a model request or require OpenAI authentication. Only safe
process classifications, allowlisted environment-key names, tool names, and
booleans enter the public receipt.

Run the controller entry point with `--help` first and supply every requested
pilot value explicitly:

```bash
node validation/proxmox/scripts/run-live-validation.mjs --help

unset NODE_OPTIONS NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR
export NODE_USE_SYSTEM_CA=1
node validation/proxmox/scripts/run-live-validation.mjs \
  --disposable-vmid 9030 \
  --candidate-revision "$(/usr/bin/git --no-replace-objects -c core.useReplaceRefs=false -c core.commitGraph=false rev-parse --verify --end-of-options 'HEAD^{commit}')" \
  --template-version 1.0.0 \
  --output /var/lib/nelos-evidence/prox2-9030.json
```

The controller reads the private guest result, reconciles the clone, and only
then assembles evidence schema v2. Clone mutation attempt and settlement are
recorded separately. An ambiguous clone POST or task wait enters
`manual-reconcile`, never authorizes destruction, and never claims cluster
absence. Successful destruction is followed by multiple consecutive
authoritative VMID-absence reads. The first `SIGINT` or `SIGTERM` is handled
cooperatively at stage boundaries so ownership-gated cleanup still runs.

After the clone task is terminal, early cleanup may destroy only a stopped VM
whose VMID, node, non-template state, random name, and atomic description all
match. After ownership readback, cleanup additionally requires the exact tag
and candidate binding. If early identity cannot be read, the VM is left stopped
as last observed but may still have its inherited NIC. If ownership later
drifts, the VM is left completely untouched and may still be running. Both
states require explicit operator reconciliation. Broad cleanup, `purge`,
`skiplock`, VMID ranges, and unreferenced-volume deletion are forbidden.

The pilot API identity needs narrowly scoped source-template clone/audit access,
disposable-VM allocation and audit, option/network configuration, power, and
`VM.Monitor` on only the disposable VMIDs or validator pool for QGA on PVE 8,
plus node-local datastore allocation and `SDN.Use` for the source NIC that
exists only until detachment. `VM.GuestAgent.Unrestricted` is a PVE 9+
privilege and must not be used in the PVE 8.4 role. The token also reads
`/cluster/nextid?vmid=<id>`, whose requested-ID result is unfiltered, while
`/cluster/resources` is used only for visible source and owned-object details.
The source template's current configuration must retain `onboot=0`. The API
token remains process-scoped from the approved secret store and must never be
written to the checkout, evidence, or logs.

Promotion remains evidence-gated: do not expand to prox3 until a prox2 receipt
passes and proves exact cleanup. The failed pve2 validator path remains frozen
and is outside this pilot.

A Linux VM can establish Linux CLI behavior only. macOS and Codex Desktop need
a separate, disposable real-Mac validation lane; successful Proxmox results
must not be generalized to those surfaces.

## References

- [Packer Proxmox clone builder](https://developer.hashicorp.com/packer/integrations/hashicorp/proxmox/latest/components/builder/clone)
- [Packer input variable precedence](https://developer.hashicorp.com/packer/docs/templates/hcl_templates/variables)
- [Ubuntu Noble release checksums](https://cloud-images.ubuntu.com/releases/noble/release-20260801/SHA256SUMS)
- [Codex plugin documentation](https://learn.chatgpt.com/docs/plugins)
