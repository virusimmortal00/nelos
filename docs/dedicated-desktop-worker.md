# Dedicated macOS Desktop Worker

Status: implemented v1 worker contract and lifecycle automation.

This lane produces Codex Desktop evidence without exposing the Codex app used
for development. It is not a developer-machine mode. A host is eligible only
when it is a disposable macOS VM or dedicated physical Mac enrolled under the
closed contract in [`src/dedicated-desktop-runtime.mjs`](../src/dedicated-desktop-runtime.mjs).

## Golden image

Build the image from a pinned macOS base and record an immutable image ID,
content digest, signing digest, and monotonically increasing generation. The
image contains:

- one automation OS account and graphical login session;
- an app bundle, backend, and socket rooted under that account's home;
- a root-owned `/Library/NelosDesktopWorker/automation-driver.mjs`;
- a root-owned `/Library/NelosDesktopWorker/requests` directory whose sealed
  request files are written by the control plane;
- a Keychain item named `nelos-benchmark` owned by the automation account;
- no developer account, home mount, credential helper, Codex profile, plugin
  cache, session database, cloud-synchronized directory, or fast-user-switching
  capability.

The image builder signs both the image manifest and dedicated-worker marker.
Admission compares their exact SHA-256 identities before any lifecycle effect.
Reimage boots the requested signed generation and repeats marker, image,
account, mount, bundle, socket, credential, and development-unreachability
checks. A failed check leaves the host quarantined.

## Exclusive lease and sealed request

The control plane admits at most one mutating lease per host. A lease binds the
host, action, runtime lock, exact bundle path and ID, backend PID and socket,
expiration, and fencing token. The worker snapshot carries that same lease as
`currentLease`; every bound field must compare equal and the worker must be in
`leased` state. Lease expiry or token replacement rejects the action.

Each workflow dispatch names a request ID, request SHA-256, host, lease, action,
and golden-image digest. The workflow checks out lifecycle code from the
protected default branch, while the runner resolves the ID only beneath the
fixed request root, verifies the bytes before parsing, and imports only the
fixed root-owned driver. Repository inputs cannot select a driver or filesystem
path.
The workflow uses a host-keyed, non-cancelling concurrency group as a second
serialization layer; the lease remains authoritative.

The sealed request also proves:

- runtime class and evidence lane are Desktop, never headless;
- the active user is the automation account;
- the dedicated marker and golden image identify this host;
- only the automation home is addressable or writable;
- the benchmark credential has the dedicated Keychain identity;
- the bundle, app, backend, socket, and socket owner are the exact leased
  target;
- the expected task inventory, profile digest, and single plugin copy match.

## Lifecycle table

| Action | Required sequence |
| --- | --- |
| Install | Drain, install one exact plugin lock, restart the exact target, discover the locked plugin in a newly created task. |
| Restart | Restart only the leased app/backend, then verify the installed plugin in a newly created task. |
| Upgrade | Drain, install the exact successor lock, restart the exact target, and verify it in a newly created task. |
| Cancel | Invoke the driver's native targeted cancellation with the leased app PID, backend PID, and lease ID. |
| Crash recovery | Restart the exact crashed target and perform fresh-task discovery; three observed crashes constitute a crash loop. |
| Cleanup | Remove lease-owned tasks, credentials, and writable state, then prove all three inventories are empty. |
| Rollback | Drain, restore the prior signed golden image, verify its dedicated boundary, install the exact prior plugin lock, restart the exact target, and verify the prior version in a newly created task. |
| Reimage | Drain, restore a signed golden generation, then reverify the dedicated marker, image digest, and development-state boundary. |

The adapter surface deliberately has no generic process termination operation.
`pkill`, `killall`, name-based termination, socket unlinking, and fallback to a
host-owned backend are outside the contract. A restart receipt must retain the
leased bundle ID, bundle path, and socket path; changed PIDs are accepted only
as the result of that exact restart.

## Quarantine and recovery

Unexpected tasks, profile drift, multiple plugin copies, socket-owner mismatch,
three or more crashes, ambiguous drain/install/restart/reimage receipts, and
cleanup failure quarantine the host. Mutation timeouts are ambiguous and must
be surfaced by the driver as failed exact receipts; they are never blindly
retried. Quarantine removes the host from scheduling while preserving the
lease, request, and partial receipts for reconciliation.

Routine recovery is reimage to the current signed golden image. Upgrade
rollback selects the previous signed image and prior immutable plugin lock,
drains the host, reimages, runs the rollback lifecycle, and admits the worker
only after fresh-task discovery. An unexplained cleanup, profile, process, or
socket failure always requires reimage rather than in-place repair.

## Evidence and tests

The workflow emits a receipt with `evidenceLane: "desktop"`, host, lease,
runtime-lock digest, and exact post-action target. Only a receipt from this
dedicated workflow can satisfy a Desktop gate; passing macOS unit tests or
headless evidence cannot.

[`test/dedicated-desktop-runtime.test.mjs`](../test/dedicated-desktop-runtime.test.mjs)
uses a disposable in-memory worker adapter to cover install, targeted restart
and cancellation, upgrade, crash recovery, cleanup, rollback, reimage,
development-state isolation, fresh-task discovery, fencing, quarantine, and
headless-evidence rejection without addressing a real app or process.
