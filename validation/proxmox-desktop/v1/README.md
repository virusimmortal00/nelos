# Proxmox Desktop backend v1

This versioned recipe builds the Ubuntu 24.04 amd64 graphical golden image used
by `nelos/proxmox-desktop-backend`. It is an offline source artifact: nothing in
this directory contacts or mutates Proxmox unless an operator separately runs
Packer with credentials and explicitly reserved template VMIDs.

The immutable package lock binds the base image, QGA, GNOME/GDM graphical
session, signature verifier, and official ChatGPT Desktop Linux preview package
to exact sources, versions, SHA-256 digests, and signature identities. The
Desktop lock pins preview `26.814.41957`, its embedded Codex
`0.148.0-alpha.15`, embedded Node `24.19.0`, and the `Codex Linux Repository`
OpenPGP fingerprint. The recipe verifies the package signature and digest plus
both embedded runtime paths and digests before installation. The template has QGA and graphical
boot enabled but deliberately has no automation account or benchmark/developer
credentials. The provider adapter creates the locked-down `nelosauto` account
and fresh writable state only on a disposable clone.

Clone authentication is one-run and volatile. The guest mounts only the exact
run-scoped, option-locked tmpfs at `/home/nelosauto/.codex`, refuses auth when
either swap inventory is nonempty, and emits only run/fence/VM/image/boot-bound
metadata attestations. Normal cancellation explicitly unmounts and proves the
persistent mountpoint empty. Destroy and quarantine first stop the exact VM and
independently attest `stopped`, so QGA loss cannot leave a running quarantined
disk with reusable credentials. A terminal receipt records only the volatility
policy and power-state proof, never credential bytes.

Provisioning also installs `/usr/libexec/nelos-desktop-identity` and creates the
one-shot, root-owned, read-only `/opt/nelos-desktop/bake-receipt.json`. That
receipt binds the exact package-lock bytes, verified Desktop `.deb` digest and
installed dpkg version/architecture, the fixed Codex and Node paths, byte
digests, versions, owners and modes, and the identity helper itself. Runtime
verification recomputes those facts and performs an isolated, pre-auth
app-server initialize probe. It accepts only the exact response identity
`Codex Desktop/0.148.0-alpha.15`, platform family `unix`, and platform OS
`linux`; a version-containing prefix or suffix is not accepted.

The adapter never discovers a free VMID. The caller supplies an owned provider,
host, VMID, golden image, active lease, reservation, and fencing token; all are
compared with fresh provider state before any mutation. Every asynchronous
mutation is polled to a bounded terminal task result before the adapter can
return a committed outcome. Reconciliation uses the same bounded observation
rule and never blindly repeats a mutation. Cleanup is successful only after
exact absence is attested; otherwise the VM is quarantined with all
reconciliation identities retained, its NIC down, autostart disabled, disk
protected, and power state independently attested as stopped.

## Guarded golden-image build

The bake has two controllers with deliberately different authority. macOS may
generate and validate contracts, collect the read-only source-volume
measurement, and coordinate the disposable builder lifecycle. It may not run
the bake. `build-golden-image.mjs` accepts only Linux x86_64, Ubuntu 24.04, and
the exact Node `24.18.0`; `run-golden-builder-controller.sh` enforces that the
bake runs as root inside the identity-bound disposable Ubuntu VM and refuses a
Proxmox host. The Proxmox plugin's clone builder creates an in-memory ephemeral
SSH key, injects its public half through Cloud-Init, and clears the authorized
key before template conversion. No developer SSH key is a Packer input.

The immutable toolchain lock pins Node `24.18.0`, Packer `1.15.4`, and the
HashiCorp Proxmox plugin `1.2.4` by archive name, URL, and SHA-256. All three
archives are staged before the disposable VM starts and are verified there;
the bake does not resolve or update tooling. The package lock pins Ubuntu
release `20260801`, snapshot `20260801T120000Z`, the official Desktop package,
and every direct guest package. Provisioning deletes existing APT source files,
installs only `ubuntu.sources`, verifies the five direct package `.deb` files,
and resolves their transitive dependencies only from that signed snapshot.

### Source and output byte identity

Template `9024` is accepted only when its exact stopped config and every
persistent LVM-thin volume have been independently measured. The fixed-command
`nelos-proxmox-volume-measure.py` activates an inactive thin volume read-only
for measurement, checks its PVE/LVM identity and size, hashes every block byte,
rereads configuration and state, and deactivates it. The wrapper repeats the
source measurement immediately before Packer, then measures every output disk
before emitting a receipt. A config-preserving disk swap therefore fails.

The reservation also records the package lock's Ubuntu artifact digest and
OpenPGP signing fingerprint. Existing source template `9024` should be created
with `validation/proxmox/scripts/bootstrap-cloud-image-template.sh`, whose
receipt begins at that signature- and digest-verified artifact. The live trust
boundary is nevertheless the fresh full-volume measurement, not an assumption
that a current disk still equals the original download.

Every golden contract uses the production provider identity `proxmox-lab`.
The disposable builder NIC is exactly `02:4E:45:4C:90:26`; the output-template
NIC is exactly `02:4E:45:4C:90:27`, is passed to Packer as a sealed variable,
and is checked again in both output observations and the final receipt.
Provider and attestor preflights independently enumerate every QEMU config in
the cluster and must agree that both reserved MACs are absent before provision.

Successful attestation is schema v2. `goldenImage.digest` uses the domain
`nelos-proxmox-desktop-volume-recipe-config-v2` and binds the source artifact,
source and output configuration, full source and output volume measurements,
canonical candidate integrity, package/toolchain/recipe inputs, and committed
source revision. `attestationDigest` additionally binds the independent PVE
observation, Packer artifact, attestor identity, and observation time.

### Generated operator contracts

Operators do not invent reservation or packet fields. The closed source files
`golden-builder-request.schema.json` and
`golden-builder-lifecycle-identity.schema.json` enumerate every initial input;
`prepare-golden-builder.mjs` validates them and deterministically derives the
reservation, volume-attestor binding, lifecycle binding, final builder packet,
controller identity, and exact ACL bootstrap. Unknown fields fail.

Create only canonical files under private `0700` directories. First derive the
two-phase attestor binding, install it through a trusted Proxmox console, and
collect the source measurement through the dedicated pinned SSH principal:

```sh
node validation/proxmox-desktop/v1/prepare-golden-builder.mjs \
  --prepare-volume-binding --request "$REQUEST" --output "$VOLUME_BINDING"

sudo nelos-volume-attestor-host-installer prepare \
  --helper "$VOLUME_HELPER" --binding "$VOLUME_BINDING" \
  --public-key "$ATTESTOR_PUBLIC_KEY" --plan "$VOLUME_HOST_PLAN"

volume_plan_digest="$(jq -er .planDigest "$VOLUME_HOST_PLAN")"
sudo nelos-volume-attestor-host-installer install \
  --helper "$VOLUME_HELPER" --binding "$VOLUME_BINDING" \
  --plan "$VOLUME_HOST_PLAN" --authorize-plan "$volume_plan_digest" \
  --receipt "$PRIVATE_RECEIPTS/volume-attestor-install.json"

sudo nelos-volume-attestor-host-installer verify \
  --helper "$VOLUME_HELPER" --binding "$VOLUME_BINDING" \
  --plan "$VOLUME_HOST_PLAN" \
  --receipt "$PRIVATE_RECEIPTS/volume-attestor-verify.json"

bash validation/proxmox-desktop/v1/collect-golden-source-measurement.sh \
  "$REQUEST" "$PVE_KNOWN_HOSTS" "$ATTESTOR_PRIVATE_KEY" \
  "$SOURCE_CONFIG" "$SOURCE_MEASUREMENT"

node validation/proxmox-desktop/v1/prepare-golden-builder.mjs \
  --prepare-builder-lifecycle --request "$REQUEST" \
  --source-config "$SOURCE_CONFIG" --source-measurement "$SOURCE_MEASUREMENT" \
  --package-lock "$PACKAGE_LOCK" --builder "$BUILDER_IDENTITY" \
  --output "$BUILDER_LIFECYCLE" --acl-output "$PVE_ACL_PLAN" \
  --acl-cleanup-output "$PVE_ACL_CLEANUP"
```

The former `install-volume-attestor.sh` and `remove-volume-attestor.sh`
entrypoints are deliberately non-mutating deprecation guards. The supported
installer uses the same sealed per-effect intent and receipt lifecycle as the
builder and gateway host installers. It separately checkpoints the account,
password lock, home, `.ssh`, forced key, sudoers file, and `visudo` proof. A
retry or `reconcile` adopts only exact plan-owned partial state: the intent and
terminal receipt bind the allocated UID/GID, supplementary groups are forbidden,
removal proves the principal owns no process, and every root target traverses an
exact root-owned, non-group-writable parent chain. After the bake,
remove it with the same plan digest; repeat the identical `remove` command (or
use `reconcile`) after interruption:

```sh
sudo nelos-volume-attestor-host-installer remove \
  --helper "$VOLUME_HELPER" --binding "$VOLUME_BINDING" \
  --plan "$VOLUME_HOST_PLAN" --authorize-plan "$volume_plan_digest" \
  --receipt "$PRIVATE_RECEIPTS/volume-attestor-remove.json"
```

`golden-builder-lifecycle.mjs` is the crash/reconciliation-safe orchestration
core. Its provider adapter must preflight cluster-wide collision absence for
the fixed builder `9026` and output `9027` VMIDs, names, volumes, and exact
MACs, prove source `9024`, `local-lvm`, and active VNet
`nelosbld`, clone one Ubuntu 24.04 x86_64 builder carrying the exact ownership
description/MAC/public key, and observe QGA, Cloud-Init, and the fresh guest SSH
host key. Only after that observation does it derive and persist the final
builder packet and controller identity. This ordering prevents a copied or
operator-guessed host fingerprint. On success it commits the terminal receipt,
stops the exact builder, destroys it, and proves VMID/name/volume absence. An
ambiguous mutation or identity drift is quarantined for reconciliation and is
never broadly deleted.

`golden-builder-proxmox-transport.mjs` is that concrete adapter. Provider
mutations and independent absence reads use different one-run ED25519 keys,
different locked Proxmox accounts, different forced commands, and different
sudo rules. Every operation is bound to the lifecycle digest and a deterministic
operation ID. The host helper records a mode-`0400` mutation intent before its
first effect, reconciles a partial clone/configure/start or already-completed
stop/destroy after a transport crash, and persists a digest-bound host receipt;
the controller stores the verified receipt at its content address. Destruction is not accepted until the separate attestor principal
proves the builder VMID, name, and every `base-<vmid>-`/`vm-<vmid>-` storage
volume absent from fresh cluster and storage inventories.

The SSH trust identity is intentionally the literal `192.168.1.110:22` and
console-pinned ED25519 fingerprint
`SHA256:/7TgXiGHrARF8+hFiOuUGlC/mrRFheILcEKs6FiANzg`. The current DNS name
`prox2.sayers.io` does not resolve to that SSH endpoint and is rejected before
connection. The Proxmox HTTPS API is independently fixed to
`https://192.168.1.110:8006/api2/json`; its certificate SAN covers the literal
address, and the only accepted CA digest is
`sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d`.
Neither transport allows trust-on-first-use, a DNS substitution, or a TLS
bypass.

Create a canonical access file matching
`golden-builder-transport-access.schema.json`. It contains public keys and
private-key *paths*, never private-key bytes. `helperDigest` is the SHA-256 of
the exact `nelos-proxmox-golden-builder-helper.py` bytes. The provider,
attestor, builder-guest, and Proxmox-host keys must all be different. Then
derive the forced-helper binding, installation plan, and exact one-line
known-hosts file:

```sh
node validation/proxmox-desktop/v1/prepare-golden-builder-transport.mjs \
  --lifecycle "$BUILDER_LIFECYCLE" \
  --access "$BUILDER_TRANSPORT_ACCESS" \
  --host-binding-output "$BUILDER_HOST_BINDING" \
  --plan-output "$BUILDER_HOST_PLAN" \
  --known-hosts-output "$BUILDER_KNOWN_HOSTS"
```

The plan is executable, not a manual checklist. Stage the sealed plan, binding,
and measured helper through the trusted Proxmox console, then run the root-only
installer with the exact plan digest:

```sh
sudo nelos-golden-host-installer install \
  --plan "$BUILDER_HOST_PLAN" --binding "$BUILDER_HOST_BINDING" \
  --host-helper "$SOURCE_ROOT/validation/proxmox-desktop/v1/nelos-proxmox-golden-builder-helper.py" \
  --receipt "$PRIVATE_RECEIPTS/builder-host-install.json" \
  --authorize-plan "$(jq -er .planDigest "$BUILDER_HOST_PLAN")"
```

`golden-builder-host-install-plan.schema.json` closes every target. The
installer journals intent before its first effect, atomically writes the exact
measured helper and binding, creates only the two locked accounts and forced
authorities, validates each sudoers file, and emits a metadata-only receipt.
`verify`, `remove`, and `reconcile` use the same sealed inputs; removal refuses
any target whose bytes or identity drifted. Homes and `.ssh` directories are
mode `0700`; each authorized-key file is owned by its principal and mode
`0600`; sudoers files are root:root mode `0440`.
Before every request the helper independently verifies its installed path and
digest, the caller's `SUDO_USER`, account home/shell, exact forced-key bytes,
sudo bytes, owners, modes, types, and link counts. An incomplete or hand-edited
installation therefore cannot issue even a read.

`golden-builder-control.mjs` is the operator entrypoint for the injected
lifecycle adapter. Read-only admission needs no mutation flag:

```sh
node validation/proxmox-desktop/v1/golden-builder-control.mjs \
  --lifecycle "$BUILDER_LIFECYCLE" --access "$BUILDER_TRANSPORT_ACCESS" \
  --receipt-dir "$PROVIDER_RECEIPTS" --operation preflight
```

Each `provision`, `stop`, `quarantine`, or `destroy` call additionally requires
`--authorize-binding "$(jq -er .builderLifecycleBinding.bindingDigest "$BUILDER_LIFECYCLE")"`.
That acknowledgement names one immutable lifecycle; it is not a wildcard.
`confirm-absent` always uses the attestor key. The lifecycle core imports
`ProxmoxGoldenBuilderAdapterV1` and passes the resulting adapter at its existing
`adapter` injection boundary; `executeController` remains the sealed in-guest
controller shown below.

`expiresAt` admits active preflight/provision/build work only.
`cleanupExpiresAt` is a separate sealed deadline, later by no more than one
hour, that admits only observation, stop, quarantine, destroy, and independent
absence confirmation. After active expiry, even a correct binding authorization
cannot provision or start build work; after cleanup expiry every operation is
rejected.

The generator writes a canonical bootstrap plan. Its paired shell rendering is
an offline review artifact only; it is not an executable lifecycle or an
authorization boundary. The same sealed plan is consumed only by
`golden-builder-acl-bootstrap.mjs` as root on the pinned Proxmox host for both
bootstrap and crash-safe cleanup. Before mutation the executor proves the exact active VNet,
zone, and `/access/acl` path. It journals intent, creates both tokens with
`--output-format json`, validates the returned full token identities, and
atomically writes the two secret values to distinct mode-`0400` files. Token
values are never emitted in stdout, stderr, receipts, or journals. A parse,
write, or command failure rolls back the owned users, roles, grants, token
files, and tokens; an unproven rollback retains an intent that must be
explicitly reconciled.

```sh
sudo node validation/proxmox-desktop/v1/golden-builder-acl-bootstrap.mjs \
  --reservation "$RESERVATION" --plan "$PVE_ACL_PLAN" \
  --token-root "$TOKEN_ROOT" --receipt "$ACL_RECEIPT" \
  --authorize-plan "$(jq -er .planDigest "$PVE_ACL_PLAN")"

# Only when the executor reports ACL_RECONCILIATION_REQUIRED:
sudo node validation/proxmox-desktop/v1/golden-builder-acl-bootstrap.mjs \
  --reconcile --reservation "$RESERVATION" --plan "$PVE_ACL_PLAN" \
  --token-root "$TOKEN_ROOT" \
  --authorize-plan "$(jq -er .planDigest "$PVE_ACL_PLAN")"

# After terminal build evidence and exact builder/output reconciliation:
sudo node validation/proxmox-desktop/v1/golden-builder-acl-bootstrap.mjs \
  --cleanup --reservation "$RESERVATION" --plan "$PVE_ACL_PLAN" \
  --token-root "$TOKEN_ROOT" --receipt "$ACL_CLEANUP_RECEIPT" \
  --authorize-plan "$(jq -er .planDigest "$PVE_ACL_PLAN")"
```

Per-build role names include the first 12 hex characters of the sealed nonce,
so they cannot silently adopt stale roles. The plan creates distinct
privilege-separated build and attestor tokens and grants only:

- build: node audit; storage allocate/audit; source `VM.Audit`/`VM.Clone`;
  output allocation/configuration/power; and `SDN.Use` on the exact
  `/sdn/zones/nelosbld/nelosbld` path;
- attest: read-only node, storage, source, and output audit.

No ACL is granted at `/`. After terminal evidence and exact builder cleanup,
the executable `--cleanup` lifecycle removes the two token identities, their
exact path grants, the owned users, the nonce-bound roles, and both local
mode-`0400` token-secret files. It persists the exact pending action before
every effect, fsyncs every checkpoint, observes the scoped PVE state through a
separate read boundary after each action, and skips only an already-proven
absence. Re-running the same command adopts that intent after process or SSH
loss; a partial failure never blindly repeats a deletion. Success requires a
final independent scoped-absence observation and emits only the closed,
metadata-only `golden-builder-acl-cleanup-receipt.schema.json` receipt. Token secret files, the TLS CA, known-hosts file,
volume-attestor key, pinned archives, clean source checkout, state directory,
and attestation directory are staged into the disposable controller as sealed
root-owned files. The exact in-guest invocation is:

```sh
sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  NELOS_GOLDEN_BUILDER_BUNDLE="$BUILDER_BUNDLE" \
  NELOS_GOLDEN_CONTROLLER_IDENTITY="$CONTROLLER_IDENTITY" \
  NELOS_GOLDEN_SOURCE_ROOT="$SOURCE_ROOT" \
  NELOS_GOLDEN_NODE_ARCHIVE="$NODE_ARCHIVE" \
  NELOS_GOLDEN_PACKER_ARCHIVE="$PACKER_ARCHIVE" \
  NELOS_GOLDEN_PLUGIN_ARCHIVE="$PLUGIN_ARCHIVE" \
  NELOS_GOLDEN_BUILD_TOKEN_FILE="$BUILD_TOKEN" \
  NELOS_GOLDEN_ATTEST_TOKEN_FILE="$ATTEST_TOKEN" \
  NELOS_GOLDEN_TLS_CA_FILE="$TLS_CA" \
  NELOS_GOLDEN_VOLUME_KNOWN_HOSTS="$PVE_KNOWN_HOSTS" \
  NELOS_GOLDEN_VOLUME_IDENTITY_FILE="$ATTESTOR_PRIVATE_KEY" \
  NELOS_GOLDEN_STATE_DIR="$STATE_DIR" \
  NELOS_GOLDEN_ATTESTATION_DIR="$ATTESTATION_DIR" \
  NELOS_GOLDEN_TERMINAL_RECEIPT="$TERMINAL_RECEIPT" \
  NELOS_GOLDEN_CLEANUP_RECEIPT="$CLEANUP_RECEIPT" \
  NELOS_GOLDEN_OPERATION=run \
  /bin/bash "$SOURCE_ROOT/validation/proxmox-desktop/v1/run-golden-builder-controller.sh"
```

The wrapper itself receives only the derived reservation and the two scoped
token secrets. It performs a repeated build/attestor preflight, invokes exactly
`desktop.proxmox-clone.desktop` with `-machine-readable`,
`-on-error=abort`, no `-force`, one parallel build, and a bounded deadline.
Its content-addressed journal and receipt contain no credentials. A fresh
controller process adopts the exact fsynced digest chain instead of rejecting
it. Before Packer receives its sealed control, a dedicated supervisor's exact
PID, Linux start-time ticks, and process-group ID are durably recorded. The
supervisor owns bounded output and completion publication and survives loss of
the calling controller. Recovery checks that exact process identity before it
queries provider tasks: a live group returns pending even between Proxmox
tasks, PID reuse or an orphaned group quarantines, and cleanup-only recovery
uses bounded TERM/KILL/reap before any output cleanup. For any journal that
crossed the mutation boundary, the build and attestor
identities independently enumerate the bounded provider task history and
output `9027`. An active task returns pending without replay; matching terminal
tasks plus durable complete Packer output resume attestation; a freshly proven
owned but incomplete output is deleted and independently proven absent; and
missing, conflicting, or ambiguous history quarantines the output. Only a
terminal exact cleanup can admit another Packer attempt, and active build expiry
still prevents that retry while preserving cleanup-only recovery.

### Crash-safe builder egress transaction

The builder VNet is deny-by-default. A bake is therefore wrapped by
`runGatewayProtectedGoldenBuilderV1`, which applies one identity-bound policy
to gateway VM `9023` before builder provisioning and restores the exact
original stateless nftables bytes before the run may terminate successfully.
The closed policy allows only TCP/443 to fresh, TTL-bounded public IPv4 answers
for `persistent.oaistatic.com` and `snapshot.ubuntu.com`, plus TCP/8006 to the
literal Proxmox API address `192.168.1.110`. It does not add a general forward
path.

Create a canonical policy with
`createGoldenBuilderGatewayPolicyBindingV1` from the sealed reservation, the
fresh gateway config digest, the SHA-256 of the exact original output of
`/usr/sbin/nft --stateless list ruleset`, the measured guest-helper digest, and
fresh sorted A records carrying their observed TTL and expiry. Then create a
closed access file matching
`golden-builder-gateway-transport-access.schema.json` and derive its forced
host-helper installation:

```sh
node validation/proxmox-desktop/v1/prepare-golden-builder-gateway-transport.mjs \
  --reservation "$RESERVATION" --policy "$GATEWAY_POLICY" \
  --access "$GATEWAY_ACCESS" --host-binding-output "$GATEWAY_HOST_BINDING" \
  --plan-output "$GATEWAY_HOST_PLAN" \
  --known-hosts-output "$GATEWAY_KNOWN_HOSTS"
```

Use the same trusted-console installer for the gateway plan. It installs the
exact host helper and binding on `192.168.1.110`, the exact guest helper in VM
`9023` through QGA, and only the two forced principals. The guest helper bytes
are bound by the plan and must be passed explicitly:

```sh
sudo nelos-golden-host-installer install \
  --plan "$GATEWAY_HOST_PLAN" --binding "$GATEWAY_HOST_BINDING" \
  --host-helper "$SOURCE_ROOT/validation/proxmox-desktop/v1/nelos-proxmox-golden-gateway-transport.py" \
  --guest-helper "$SOURCE_ROOT/validation/proxmox-desktop/v1/nelos-golden-gateway-policy.py" \
  --receipt "$PRIVATE_RECEIPTS/gateway-host-install.json" \
  --authorize-plan "$(jq -er .planDigest "$GATEWAY_HOST_PLAN")"
```

The installer journal records each host file and every principal subeffect.
The QGA guest probe reports absence only for an exact in-guest
`FileNotFoundError`; transport failure, nonterminal execution, guest failure,
stderr, malformed JSON, unsafe type/ownership/mode, or an unexpected response
is ambiguous and authorizes neither overwrite nor removal. Guest removal is
complete only after a second exact-absence probe. Re-run the identical command
or use `reconcile` with the same plan and receipt path after controller death.

Provider apply/restore and independent
restore attestation use different one-run keys. Read-only preflight accepts
only gateway `9023`, the sealed configuration/helper/ruleset digests, an empty
`approved_ipv4` set, forward policy `drop`, and zero unexpected accept rules.

```sh
node validation/proxmox-desktop/v1/golden-builder-gateway-control.mjs \
  --reservation "$RESERVATION" --policy "$GATEWAY_POLICY" \
  --access "$GATEWAY_ACCESS" --receipt-dir "$GATEWAY_RECEIPTS" \
  --operation preflight

node validation/proxmox-desktop/v1/golden-builder-gateway-control.mjs \
  --reservation "$RESERVATION" --policy "$GATEWAY_POLICY" \
  --access "$GATEWAY_ACCESS" --receipt-dir "$GATEWAY_RECEIPTS" \
  --operation apply \
  --authorize-binding "$(jq -er .bindingDigest "$GATEWAY_POLICY")"
```

The guest helper writes an apply intent before changing nftables and a restore
intent before replaying the exact backup. A retry after an unreceipted apply
restores first and returns failure; it never stacks rules. Builder failure also
enters restore. Completion requires a separate attestor receipt proving the
original ruleset digest. An ambiguous apply or unproven restore blocks all
builder mutation or terminal success and requires reconciliation.

### Executable production bake transaction

`nelos-golden-builder-runner` is the packaged production caller that joins the
two guarded lifecycle implementations. Its closed config is
`golden-builder-production-config.schema.json`; guest staging is separately
closed by `golden-builder-guest-controller-access.schema.json`. `identity`
derives the immutable authorization digest without a provider call:

```sh
run_digest="$(nelos-golden-builder-runner identity --config "$GOLDEN_RUN_CONFIG" | jq -er .runDigest)"
nelos-golden-builder-runner run --config "$GOLDEN_RUN_CONFIG" --authorize-run "$run_digest"
```

The transaction applies and freshly observes the exact gateway policy before
provisioning, proves the builder through QGA, pins the observed private-VNet
address and ED25519 host public key for strict SSH, stages sealed controller
inputs, runs the in-guest bake, commits the terminal receipt, proves exact
builder absence, and independently proves the original gateway ruleset before
success. Its content-addressed journal records metadata only.

After controller or workstation process death, run `resume` with the identical
config. Checkpoints reconcile fresh provider state and deterministic operation
IDs, so an active policy, existing builder, committed terminal, completed
destroy, or restored gateway is adopted without duplicating its mutation. Use
`cancel` for an explicit cleanup. After active expiry, `resume` itself becomes
cleanup-only through `cleanupExpiresAt`: it may adopt an already committed
guest terminal, terminate the exact Packer process group, scrub an owned
partial `9027`, quarantine ambiguity, destroy only the fixed owned builder
`9026`, and restore the gateway. Neither command may provision a builder,
replay Packer, or start new build work in cleanup-only mode. Unknown state, changed
ownership, tampered receipts, or an unproven restore fails closed.

The guest publishes a packet-bound, fsynced `controller-ready` marker before
the bake can start and serializes the nested recovery journal with an exclusive
lock. A lost SSH response, live Packer group, unreadable result, or partial
terminal therefore leaves the exact running builder intact during active
recovery. The outer runner restores the gateway baseline, records
reconciliation-required, and active `resume`
reapplies the bounded gateway policy before invoking the same builder. The
guest adopts the existing Packer operation and content-addressed attestation;
it never starts a second bake. A cleanup-only result has a separate
packet/reservation-bound, content-addressed cleanup terminal and cannot be
mistaken for build success. Terminal JSON is validated, written to a
same-directory temporary file, fsynced, and published with an atomic
no-replace rename before builder destruction is allowed.

### Activation status and remaining live inputs

No live Proxmox mutation was performed while implementing this transport. The
provider/attestor adapter, forced helper, strict schemas, preparation CLI,
operator control CLI, idempotency journal, quarantine path, and independent
absence proof are executable and covered by offline fake-transport tests.

One live run still needs these fresh values:

- committed clean Nelos revision and exact source-config JSON for template
  `9024`;
- collision-free fixed builder `9026` / MAC `02:4E:45:4C:90:26` and fixed
  output `9027` / MAC `02:4E:45:4C:90:27`, plus the run-scoped builder name and
  ownership nonce, on `prox2`, `local-lvm`, `nelosbld`. Both VMIDs and MACs are
  immutable production contract identities; an alternate internally
  self-consistent packet is rejected before a provider read or mutation;
- the protected Proxmox CA file whose bytes match the pinned digest and the
  exact one-line literal-IP known-hosts file;
- separate build and read-only attestor token IDs/secrets created by the safe
  ACL bootstrap executor and sealed in distinct mode-`0400` files;
- fresh dedicated volume-attestor, forced provider, forced absence-attestor,
  builder-guest, gateway-provider, and gateway-attestor ED25519 keypairs, all
  mutually distinct;
- trusted-console installation of the generated host binding/plan followed by
  a read-only `preflight` through the forced provider and a read-only
  `confirm-absent` through the forced attestor;
- trusted-console installation and measurement of both gateway helpers, a
  fresh gateway `9023` config digest, exact original stateless nftables bytes
  and digest, fresh TTL-bounded A records for the two package hosts, and
  read-only gateway preflight/restore-attestor receipts;
- pre-staged pinned Node, Packer, and plugin archives; fresh expiry and build
  nonce; private journal/attestation/terminal paths;
- retained source-template bootstrap receipt, current source volume measurement,
  and enough `local-lvm` capacity for the full builder and output clone; the
  latest read-only inventory reports approximately 829.5 GB available.

The offline implementation is a **go** for trusted-console installation and
the read-only builder, absence-attestor, and gateway probes. The live bake
remains **no-go** until those fresh keys/tokens/packet files are sealed, every
host and gateway helper self-check passes, the source and original gateway
ruleset measurements are refreshed, the two DNS resolutions are unexpired,
and the guest controller inputs are staged. Any failed self-check, collision,
stale expiry, receipt mismatch, incomplete absence result, or unproven exact
gateway restoration is a no-go and preserves the exact resource for
reconciliation.

The offline suite is:

```sh
node --import ./scripts/test-bootstrap.mjs --test \
  test/proxmox-golden-builder-acl-bootstrap.test.mjs \
  test/proxmox-golden-builder-gateway-policy.test.mjs \
  test/proxmox-golden-builder-gateway-transport.test.mjs \
  test/proxmox-golden-production-runner.test.mjs \
  test/proxmox-golden-guest-controller.test.mjs \
  test/proxmox-golden-host-installer.test.mjs \
  test/proxmox-golden-image-build-wrapper.test.mjs \
  test/proxmox-golden-image-recovery.test.mjs \
  test/proxmox-golden-builder-workflow.test.mjs \
  test/proxmox-golden-builder-transport.test.mjs \
  test/proxmox-golden-image-contract.test.mjs
```

It uses fake boundaries only and covers closed admission, exact token scope,
source/output byte identity, Packer receipts, deterministic hashing, repeated
preflight, generated schemas/packets, safe token capture/rollback, builder
success, ambiguous cleanup, ownership-drift quarantine, deterministic mutation
recovery, distinct SSH principals, literal-IP host/API trust, strict
no-forwarding SSH, forged receipt rejection, exact gateway apply/restore,
no-stacking crash recovery, five fresh-process transaction crash points,
45 ACL cleanup checkpoints, output `9027` task/output reconciliation,
trusted-console partial-install rollback, strict guest-controller SSH, HCL identity, candidate/helper installation, and
credential removal.
It performs no network request or infrastructure mutation.
An Ubuntu-local ImageMagick/provisioning smoke was not run from the development
Mac: the host is Darwin arm64 with Node `26.7.0`, has no Packer, and has no
cached Ubuntu container or VM image. Pulling a floating image would weaken the
sealed test and was intentionally not substituted for the disposable builder.

## Production run composer

`prepare-production-run.mjs` and the packaged
`nelos-prepare-production-run` CLI are the supported boundary between the
immutable candidate/golden/task-intent inputs and a launchable production run. The
composer accepts seven closed, canonical, sealed JSON inputs plus one absent
run-ID output path. It writes exact content-addressed `run.json`, run-packet,
golden receipt, guest-task intent, and host-binding files under four distinct sealed roots.
The lease input is the canonical active issue observation from the independent
host-local authority; the config, run packet, admission, journal, evidence, and
host binding retain its authority ID, trust digest, epoch, issued revision, and
record digests. The dedicated empty `recovery` root is used only for fresh
authoritative current-record observations during resume or cancel.

The receipt also declares, without values or digests, every unique one-shot
`type_text_ref` path required beneath the sealed-value root. Composition leaves
that root empty. A trusted secret provider stages only the exact caller-owned,
mode-`0400`, 1-to-1,048,576-byte files after composition; a second composer
adoption with `--require-sealed-values` verifies only their complete inventory
and filesystem metadata. It never opens, hashes, copies, or logs the values.
The final candidate runner preflight and authorized run follow that readiness
gate. Partial, extra, linked, misowned, wrong-mode, empty, or oversized value
state is rejected.

The composer executes the staged candidate's runner preflight and Python host
binder, compares both with its independent contract preflight, and verifies the
candidate a second time. It never contacts Proxmox. An identical rerun adopts
the completed composition; input, byte, mode, path, owner, inventory, binder,
runner, or candidate drift fails closed without replacing it. Secret fields or
secret-shaped values fail before output creation.

The focused offline test is:

```sh
node --import ./scripts/test-bootstrap.mjs --test \
  test/production-run-composer.test.mjs
```

That test uses the real candidate staging CLI output, the real packaged runner,
and the real binder render path. It proves deterministic composition/adoption,
closed roots and identities, output tamper refusal, pre-output secret/schema
rejection, metadata-only sealed-value readiness, binder mismatch rollback, and
the direct canonical CLI handoff. It performs no provider, guest, Desktop,
model, or network operation.
