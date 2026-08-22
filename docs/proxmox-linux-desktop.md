# Production Proxmox Linux Desktop lane

Status: implemented production admission, helper, recipe, and evidence
contract. Live execution remains NO-GO until the exact candidate-bound observer
is installed in gateway VM `9023` and a fresh read-only measurement's composite
ruleset/address-inventory identity matches the sealed policy digest and
run-plus-cleanup expiry requirement.

This lane is distinct from both the headless experiment fleet and the dedicated
macOS worker. It boots a disposable Ubuntu 24.04 graphical guest on an explicitly
leased Proxmox node. The admission and evidence contract is implemented in
[`src/proxmox-desktop-runtime.mjs`](../src/proxmox-desktop-runtime.mjs). It is
carried by the accepted homelab lane in
[`src/homelab-desktop-runtime.mjs`](../src/homelab-desktop-runtime.mjs), whose
concrete Proxmox adapter is
[`validation/proxmox-desktop/v1/backend/proxmox-ve-adapter.mjs`](../validation/proxmox-desktop/v1/backend/proxmox-ve-adapter.mjs).
The versioned image recipe and installable helpers live under
[`validation/proxmox/desktop`](../validation/proxmox/desktop).

## Provider lifecycle

A VM read returning provider HTTP 404 is represented as absence. Authorization,
transport, and server errors retain their original failure semantics. Every
clone, start, stop, and destroy response must name one Proxmox task. The caller
polls that task to a successful terminal state under a maximum ten-minute
deadline. Failed, ambiguous, missing, and nonterminal tasks produce no committed
receipt, and the next lifecycle operation is not admitted.

The root-owned host helper has no shell operation or caller-selected executable.
It accepts only the closed JSON envelope, checks the run, provider, node, target
VMID, exact locally administered MAC, VNet, gateway VMID, installed
network-policy digest, lease, and fencing token against
`/etc/nelos-desktop/run-binding.json`, and
then re-reads the independent host-local lease authority under a shared lock
immediately before every provider effect. It holds that lock through `pvesh`,
so a revoke, completion, or reassignment cannot race an admitted effect. Active
work requires the exact current active epoch inside its margin; cleanup requires
the exact separately admitted active or cleanup-only epoch. A second root-owned
`provider.json` binds the provider and node to one immutable source-template
VMID; callers cannot select a clone source. The task-status operation accepts
only the UPID returned by a mutation. Exit 44 is the sole not-found read result.
All other nonzero exits are failures.

One live run is installed and removed through the sealed, receipt-bound
[Proxmox Desktop host-run workflow](./proxmox-desktop-host-run-binding.md). It
creates distinct forced-command provider and attestor SSH identities, binds
both controller transports to the accepted source-template VMID, and refuses a
conflicting run rather than replacing host state.

The disposable VM has exactly one sealed `net0`:
`virtio=<macAddress>,bridge=<networkId>,firewall=1`. Clone configuration cannot
inherit, omit, or generate another NIC. For the approved validation reservation,
VMID `9028` and MAC `02:4E:45:4C:90:28` are explicit reserved operator inputs.
Production v1 itself fixes provider `proxmox-lab`, host `prox2`, VNet `nelosbld`,
and gateway VMID `9023`; an alternate gateway is not caller-selectable even when
every supplied JSON record agrees. The VNet's
authoritative policy path is `/sdn/zones/nelosbld/nelosbld`.

The policy proof is never an operator-authored JSON assertion. Install the
candidate's exact
`validation/proxmox/desktop/helpers/nelos-network-policy-observer.py` inside
gateway VM `9023` as `/usr/libexec/nelos-network-policy-observer`, root:root
mode `0755`, using `install-network-policy-observer.sh` from a trusted console.
The composer hashes those candidate bytes and seals that helper digest into the
host-run binding.

For every admission and immediately before every provider effect, the distinct
read-only host principal verifies that gateway `9023` is running with QGA,
starts only `/usr/libexec/nelos-network-policy-observer observe`, and waits for
that exact QGA PID. The guest helper hashes the complete bytes returned by
`nft --stateless list ruleset`, rejects any forward accept beyond the single
`10.77.77.0/24` to `@approved_ipv4` TCP/443 rule and established/related
traffic, requires forward policy `drop`, and independently reads the live
timeout-backed `approved_ipv4` set. It rejects an empty, duplicate, malformed,
or over-64-address inventory. The result binds the exact sorted-address
inventory digest, full-ruleset digest, installed helper digest, byte count, and
minimum actual element expiry in one content-addressed measurement. The helper
derives a policy identity digest over the full-ruleset digest, exact approved
address-inventory digest, and VNet; the host attestor requires that composite
digest to equal the sealed `networkPolicyDigest` before deriving the final observation. A broad address,
extra rule, stale element, different helper, truncated QGA output, or changed
gateway therefore fails closed.

The observation expiry is the minimum live nft element expiry—not a lease- or
configuration-derived timestamp. Runtime admission requires that expiry to
cover the entire remaining run deadline plus cleanup budget, and reattests it
before clone, configure, start, stop, destroy, quarantine, and recovery
mutation. Do not construct an observation from run configuration or treat VNet
attachment alone as proof that device authentication or model egress is
available.

## Guest bootstrap and authentication

Recipe v1 installs GNOME on Xorg, GDM, AT-SPI, D-Bus activation utilities,
X11 control and screenshot packages, and the guest helper. The only account is
the locked-password `nelosauto` account. GDM provides controlled
autologin; the first-boot service has 120 seconds to observe its active X11
session. The session autostart imports the display, Xauthority, session bus, and
accessibility bus into the user service manager.

`device-auth.sh` refuses to start while a root or developer Codex home is
addressable. Before it invokes the dedicated device-auth flow, the fixed
credential-boundary helper mounts the exact run-scoped tmpfs at
`/home/nelosauto/.codex` and proves both kernel swap inventories empty. Its
closed metadata-only receipt binds the run, fence, VMID, golden-image identity, mount policy, and boot
identity. A persistent path, wrong tmpfs source/options, active swap, changed
boot, or prior scrub is rejected. The auth flow writes only the authenticated flag, account type,
run-salted account binding digest, auth method, credential-store type, complete
run binding, and negative
developer-import fact to a root-owned closed receipt. `auth_status` independently
opens the pinned app-server as `nelosauto`, calls live `account/read`, and binds
that fresh observation to the receipt digest, run, fence, and automation user.
The controller requires the same live account-binding digest during initial
synchronization, immediately before the sole Enter submission, and again during
final evidence collection. The final observation is content-addressed as a
mandatory `account-binding-attestation`; persisted authentication metadata alone
cannot authorize a model turn or destruction. Actual scenario evidence requires the later native
terminal turn plus an independently matching MCP identity and visible Desktop
lifecycle observations.
Before any model action, the controller bounded-polls graphical readiness and a
complete AT-SPI scan for the exact guest producer-receipt task ID and title. It
never copies a developer
Desktop database, token, keychain, profile, or session.

## Run admission and checkpoints

The control plane serializes the closed run packet canonically and binds its
SHA-256 digest. Admission requires all of the following at the point of use:

- the canonical active issue record from the independently operated host-local
  lease authority, observed within the last 30 seconds, with its exact authority
  ID, trust digest, resource key, epoch, revision, run, lease, and fencing token;
- one fresh, complete, read-only observation from the independently operated
  network-policy boundary, binding the same provider and host, gateway VMID,
  VNet, full-ruleset digest, exact approved-address inventory digest, installed
  observer digest, and the minimum actual nft element expiry. It must be at
  most 30 seconds old and retain the entire remaining run plus cleanup margin
  (and never less than 120 seconds). The fixed attestor route is
  `GET /nelos/network/policy`; callers cannot select a policy record;
- four distinct, non-symlinked roots (packet, recovery, staging, and evidence)
  whose actual UID, GID, and restrictive
  mode match the sealed packet declarations;
- explicit run and step deadlines, an evidence count budget, screen bounds, and
  protected regions wholly within that screen;
- a deterministic empty guest-task slot and title bound by a sealed creation
  intent; and
- an unused authorization gate whose run ID matches the packet and which the
  external one-run authorizer consumes exactly once.

Before accepting a checkpoint, the controller asks the guest to read the same
fresh identity three ways. A fixed QGA route calls `thread/read` through the
pinned guest Codex app-server, starts the verified packaged `bin/nelos-mcp`
inside the guest and calls its real `nelos_thread_inspect` and
`nelos_runtime_health` tools over MCP stdio, verifies that the producing PID
belongs to the single healthy runtime generation, and inspects the visible
Codex Desktop sidebar through guest AT-SPI. All three observations must report
the receipt-bound real task ID and exact title. The app-server and MCP `Thread.status`
values are process-local load states: either may report `notLoaded`, `idle`, or
`active` independently, so they are retained as `loadState` diagnostics and are
not required to equal one another or the scenario lifecycle. A `systemError`
load state or any explicitly observed approval/input attention flag still fails
closed. An active checkpoint is proved by a rendered Desktop running indicator
immediately after the exact Enter action. A completed checkpoint requires a real
latest native turn with terminal `completed` status and a complete bounded
Desktop task-row scan proving no running, approval, or input indicator remains.

Each checkpoint retains the Desktop Environment/Subagents aggregate without
giving it a false native meaning. The guest parses exact visible `Current` and
`Done` counts plus the `Needs input`, `In progress`, and `Queued` group counts;
the three current groups must sum to `Current`. Those counts are marked
`observed-only`. `Current` includes queued plan nodes that do not yet have a
Codex thread ID or turn, so it is never compared with the native in-progress or
descendant count. A healthy map can therefore report `Current 16` as four
in-progress launched tasks plus twelve queued plan nodes.

Independently, the pinned app-server walks the complete paginated collaboration
history and retains each launched descendant's exact ID, title, parent,
latest-turn ID, and latest-turn status (at most 32 in the bounded visual proof).
Those launched rows—not the aggregate `Current` number—are the cross-surface
oracle. Every launched ID must map to the same title and latest status in the
native Desktop sidebar and the Nelos MCP execution map. `inProgress` maps to a
sidebar running indicator and MCP `Running`; `completed` maps to sidebar idle
and MCP `Complete`. Missing, swapped, stale, cyclic, multi-parent, truncated, or
unknown rows fail closed. `interrupted` remains distinct; because Desktop
`Done` semantics for interruption are not authoritative, any nonzero count
still fails as `AGGREGATE_INTERRUPTED_SEMANTICS_UNSUPPORTED`.

Observation is deliberately multi-phase. The sidebar is scanned in bounded
read-only scroll pages and restored. The MCP execution map selects `Current`,
opens disclosure groups, expands bounded `Show N more…` controls, then selects
`Done` and repeats before restoring `Current`. This covers the real UI where
only one filter renders at a time, groups preview three rows, completed rows
live behind `Done`, and sidebar tasks can be off-screen. Every retained row
points to one ordered phase with its own content-addressed protected screenshot;
a static one-frame claim cannot prove the complete launched roster.

Every admitted production scenario contains exactly one allowlisted Enter
keypress that submits model work. Immediately after that action succeeds—and
before the completion wait or any later action—the controller takes the active
three-surface checkpoint. The completed checkpoint is taken only after the GUI
scenario itself reports completion. Device authentication and task visibility
alone are never treated as model-backed evidence.

The visible observation accepts exactly one showing, selected AT-SPI task
container containing the expected ID and a single classifiable accessible title.
Task-visibility synchronization performs one strict bounded 10,000-node traversal
and derives row ancestry and descendants from that in-memory index; it does not
repeat ancestor subtree scans or suppress accessibility exceptions. The helper
captures raw pixels only through anonymous pipes, starts the exported frame fully black, and restores
only the exact expected test row's title and rendered lifecycle/status geometry.
Thus unrelated sidebar tasks, Created Tasks, folder names, statuses, document or
conversation content, and credential fields cannot reach a durable image even
when the automation account unexpectedly contains pre-existing state. Every
ImageMagick process receives explicit memory bounds and zero map/disk limits.
Its only temporary path is a unique mode-`0700` directory under the automation
user's verified `/run/user` `tmpfs`; any entry is removed and turns the capture
into `CAPTURE_CACHE_SPILL`. Guest readiness independently checks the `tmpfs`
mount and the same ImageMagick limits. Missing,
ambiguous, overlapping, or out-of-screen evidence geometry fails closed before
the guest or controller persists a PNG. The root-owned guest wrapper recomputes
the filtered PNG SHA-256 and retains it under the run's guest state.
The final evidence collector separately inspects the returned raw RGBA frame:
every pixel outside the exact title/status allowlist, including every protected
conversation or credential rectangle, must be opaque black, and each allowed
rectangle must contain visible signal. Generic unprotected Desktop screenshot
operations are not present in the production helper allowlists.
Lifecycle text is allowlisted only when the complete accessible component text
canonicalizes exactly to a finite UI indicator. A status word embedded in a
title, prompt, preview, attribute blob, or other surrounding text cannot expose
that component's pixels.

Archive captures use the same full-frame-black policy. They restore no task
pixels after successful absence. If an exact expected test task remains visible,
only that ID-bound row's classifiable title/status evidence may be restored for
stale-projection diagnosis; unrelated task IDs are excluded from both the image
allowlist and the returned visible-task inventory. Controller-side validation
rechecks the closed privacy proof, traversal count, protected-region separation,
expected IDs, content digest, and one-title-per-visible-task invariant before
export.

The archive observer independently classifies three exact AT-SPI containers; it
never copies one generic row list into sidebar, Created Tasks, and MCP output.
Sidebar rows require the app-owned sidebar ID/title attributes. Created Tasks
requires the open summary surface and maps rows only through unique sealed run
titles, rejecting a hidden `Show N more…` remainder or count mismatch. The MCP
visual requires the `Nelos task workers` container and exact task-link labels.
The report retains three ordered container proofs with distinct geometry. An
absent, duplicated, aliased, closed, truncated, or unclassifiable surface fails
closed with a typed archive-surface error; it cannot be reported as clean.

The protected image is retained before lifecycle agreement is evaluated. Thus
the original stale-sidebar failure—a completed native latest turn while Desktop
still renders “In progress”—produces a content-addressed masked PNG and a
closed, sanitized disagreement record. The record calls app-server and MCP
values `nativeLoadState` and `mcpLoadState` so process-local load state is never
misrepresented as global lifecycle. It remains a failed scenario: the evidence
draft is collected before VM loss and the VM is quarantined for review; the
mismatch can never authorize success or destruction.

Before the run packet is sealed, the controller creates only a deterministic
guest-task intent and empty task-slot ID. It does not call `thread/start` in its
own `CODEX_HOME`. After the disposable guest completes isolated device
authentication, a fixed QGA route invokes the pinned guest app-server under
`/home/nelosauto/.codex` and `/home/nelosauto/workspace`. It seals the empty
pre-inventory, creates exactly one task without a turn, titles and reads it back,
binds its real ID to the run, fence, account digest, and pinned runtime, and
commits that receipt before the first paid action. Crash reconciliation may
adopt only the sole empty task added after the sealed pre-inventory; it never
relies on account cloud synchronization or a controller task appearing in the
guest.

Every QGA helper invocation is identified by the exact PID returned by
`guest-exec`. Provider POST, status polling, and caller aborts share a sealed
absolute deadline with reserved read-only reconciliation time. Timeout or abort
must observe that PID terminal before another guest operation is admitted. A
lost exec response (unknown PID), a nonterminal PID, or a controller crash during
an in-flight GUI effect is never replayed; recovery records reconciliation as
required and proceeds only to identity-bound quarantine or cleanup.

The guest never clicks “New task” and pretends that the UI-generated ID matches
a predeclared value. The runner replaces the task slot with the receipt's actual
ID and requires the guest AT-SPI sidebar to expose that ID and title before
submission. Production task observations are never read from caller-written
staging JSON. Native app-server, packaged Nelos MCP, and AT-SPI observations all
execute against the same guest store and Desktop. Archive convergence uses the
same guest-local observers at both `afterCleanup` and `afterRestart`; production
installs no observation staging route.

## Cleanup and independent evidence attestation

Before a first-run clone mutation, the independently credentialed attestor must
observe the reserved VMID as absent. It also re-attests the exact installed
gateway/VNet policy immediately before clone, configuration, start, and every
recovery mutation. Each mutation admission and its observation digest are
committed to the content-addressed run journal before the provider call. A
missing, stale, expired, incomplete, or identity-mismatched proof causes zero
provider mutations. A fresh-process `resume` or `cancel` instead
loads the immutable journal and accepts only the exact lease-, fence-, image-,
provider-, host-, and VMID-bound owned VM state (or absence where the committed
journal phase permits it). An unavailable independent boundary, a foreign VM,
or a state inconsistent with the journal causes zero provider mutations.

Recovery also requires one fresh authoritative lease record at the exact
content-addressed filename under the sealed recovery root. It is read through a
single no-follow descriptor with pre/post file-identity and metadata checks.
Generate it with `nelos-observe-current-lease --config
/srv/nelos/runs/RUN_ID/packet/run.json`; that helper calls only the independent
Proxmox attestor, whose root helper returns the canonical current record and
exact record bytes from `/var/lib/nelos-lease-authority` for the bound host run.
It does not reconstruct lease state from config, packet, journal, or inventory.
A controller or operator must not author that receipt. A current `revoked` or
`completed` record, a new epoch, a rolled-back revision, or a broken history
requires manual reconciliation and authorizes no automatic mutation. A current
`cleanup-only` record admits only exact cleanup before `cleanupExpiresAt`.
After `runDeadlineAt`, the runner also selects cleanup only and will not start
provisioning, GUI/model work, archive convergence, or new capture. If the gate
was consumed but no provision intent exists and the independent reservation
probe proves absence, cancellation records a failed pre-provision abort with
zero destroy or quarantine calls.

Every terminal destroy or quarantine path first issues an exact bounded host
stop when needed and independently proves the owned VM power state is
`stopped`. Power loss discards the run-scoped tmpfs credential store without
depending on QGA. Quarantine then leaves the VM stopped, disconnects its NIC,
disables autostart, and protects its disk. Its committed receipt contains only
the run/fence-bound volatility and power-state disposition; failure to prove
power-off commits no quarantine receipt and requires incident recovery.

The sequence is fixed: checkpoint screenshots, sanitized diagnostics, the
content-addressed independent network-policy observation, and an
inventory draft precede VM destroy. Destruction cannot be used as the evidence
collection mechanism. After destroy, an independent verifier walks the retained
evidence root without following links and compares it to the finalized
inventory. It verifies the whole run binding and packet digest, ownership, file
type, length, SHA-256, unique manifest reference, absence of unreferenced files,
and mandatory checkpoint screenshot, diagnostics, network-policy attestation,
and archive visual-report roles. After destroy, the attestor scans the complete
cluster QEMU inventory and every NIC field; success requires both exact VMID
absence and cluster-wide absence of the sealed MAC. Incomplete or unknown
inventory is not absence. Any byte or inventory change invalidates the
attestation.

The diagnostic record is closed and contains only its run binding, timestamp,
schema version, and readiness states for the graphical session, accessibility
bus, guest helper, and isolated authentication. Secrets, tokens, prompts, model
responses, arbitrary environment data, and developer identifiers cannot enter
the schema.

## Verification

`test/proxmox-desktop-runtime.test.mjs` is non-destructive. It uses an in-memory
provider and temporary local roots to cover 404 admission, asynchronous success,
provider failure and timeout, graphical recipe readiness, helper fencing,
device-auth isolation, three-surface identity, stale lease rejection, protected
capture rejection, pre-destroy ordering, evidence alteration, unreferenced
files, and post-destroy attestation. It never contacts or mutates Proxmox.
