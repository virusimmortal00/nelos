# Production Proxmox Linux Desktop lane

Status: implemented production admission, helper, recipe, and evidence contract.

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
VMID, lease, and fencing token against `/etc/nelos-desktop/run-binding.json`, and
enforces a deadline and output ceiling around `pvesh`. A second root-owned
`provider.json` binds the provider and node to one immutable source-template
VMID; callers cannot select a clone source. The task-status operation accepts
only the UPID returned by a mutation. Exit 44 is the sole not-found read result.
All other nonzero exits are failures.

## Guest bootstrap and authentication

Recipe v1 installs GNOME on Xorg, GDM, AT-SPI, D-Bus activation utilities,
X11 control and screenshot packages, and the guest helper. The only account is
the locked-password `nelos-automation` account. GDM provides controlled
autologin; the first-boot service has 120 seconds to observe its active X11
session. The session autostart imports the display, Xauthority, session bus, and
accessibility bus into the user service manager.

`device-auth.sh` refuses to start while a root or developer Codex home is
addressable. It creates a new automation-owned Codex home, invokes the dedicated
device-auth flow, verifies a model-backed login, and writes only the subject,
session ID, run binding, and negative developer-import fact to a root-owned
closed receipt. The guest helper accepts that receipt only when it contains one
automation account bound to the current run. It never copies a developer
Desktop database, token, keychain, profile, or session.

## Run admission and checkpoints

The control plane serializes the closed run packet canonically and binds its
SHA-256 digest. Admission requires all of the following at the point of use:

- an active, unexpired lease observed within the last 30 seconds and the exact
  fencing token;
- three distinct, non-symlinked roots whose actual UID, GID, and restrictive
  mode match the sealed packet declarations;
- explicit run and step deadlines, an evidence count budget, screen bounds, and
  protected regions wholly within that screen;
- a fresh expected task ID and title; and
- an unused authorization gate whose run ID matches the packet and which the
  external one-run authorizer consumes exactly once.

Before accepting a checkpoint, the caller supplies the same fresh identity from
native Codex task state, the ordinary Nelos MCP execution map, and the visible
Codex Desktop sidebar. All three must report the same ID, title, and active
lifecycle. Screenshot requests must lie within the declared screen and must not
intersect any protected region.

## Cleanup and independent evidence attestation

The sequence is fixed: checkpoint screenshots, sanitized diagnostics, and an
inventory draft precede VM destroy. Destruction cannot be used as the evidence
collection mechanism. After destroy, an independent verifier walks the retained
evidence root without following links and compares it to the finalized
inventory. It verifies the whole run binding and packet digest, ownership, file
type, length, SHA-256, unique manifest reference, absence of unreferenced files,
and mandatory checkpoint screenshot, diagnostics, and archive visual-report
roles. Any byte or inventory change invalidates the attestation.

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
