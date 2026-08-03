# Experiment Runtime Isolation and Version Locking

Status: v1 RuntimeLock contract and headless worker lane implemented; dedicated
Desktop execution remains proposed.

This document defines the execution environments for the
[experimentation framework](experimentation-framework.md). It separates routine
headless evidence from real Codex Desktop lifecycle evidence and makes
protection of the development Codex app a hard admission rule.

The closed v1 `RuntimeLock` record and its identity, revision, lineage, digest,
and lifecycle APIs are part of the implemented
[contract foundation](experimentation-framework.md#implemented-contract-foundation).
The headless worker admission and lifecycle API is implemented in
`src/headless-experiment-runtime.mjs`. A deployment supplies an engine adapter
for its OCI or disposable-VM infrastructure. The dedicated Desktop worker
remains a proposed execution system.

## Runtime classes

| Runtime | Evidence it may support | Isolation boundary |
| --- | --- | --- |
| `headless-oci` | CLI, MCP, app-server protocol, repository changes, deterministic graders | Disposable Linux VM or strongly isolated container |
| `desktop-macos` | Desktop plugin discovery, restart, sidebar tasks, host-owned app-server, approvals, handoff, UI lifecycle | Dedicated macOS VM or dedicated physical host |

Headless success does not prove Desktop discovery, UI, approvals, handoff,
streaming, or host-owned endpoint behavior. Desktop-specific acceptance
criteria require the Desktop lane.

Containers share a kernel. Untrusted repository code should run in a disposable
VM even when it uses the headless contract.

## Headless worker boundary

Every attempt receives:

- a read-only runtime image pinned by digest;
- immutable source input pinned by commit and tree/archive digest;
- one new writable workspace;
- unique ephemeral `HOME`, `CODEX_HOME`, `CODEX_SQLITE_HOME`, XDG state, Git
  config, npm config, and temporary root;
- an unprivileged UID, private process namespace and process group;
- explicit CPU, memory, process, file-descriptor, disk, and time limits;
- deny-by-default execution network policy;
- only short-lived, audience-scoped credentials required by the contract;
- dedicated output and telemetry directories.

Never mount the developer home, Codex home, plugin cache, sessions, worktrees,
credential helpers, or mutable package caches. Acquisition and execution are
separate phases. Acquisition may use allow-listed HTTPS; deterministic
execution may require fully blocked networking.

After bounded output collection, terminate the owned process tree, remove
secrets, verify artifacts, and destroy the worker. Cleanup failure quarantines
the worker and invalidates reuse.

### Implemented worker lane API

`createHeadlessWorkerLane` prepares one attempt at a time beneath a canonical,
non-developer lane root. It accepts only an active, digest-valid `headless-oci`
`RuntimeLock`, a fenced lease, a supported `oci-container` or `disposable-vm`
boundary, closed resource limits, an acquisition network policy, and optional
short-lived acquisition credentials. The returned attempt exposes
`acquire`, `execute`, `cancel`, `collectArtifacts`, and `cleanup`.

The engine adapter is the infrastructure trust boundary. It implements
`create`, `runPhase`, `inspect`, `cancelProcessGroup`, `destroy`, and
`quarantine`. Creation and phase receipts must attest the exact canonical
policy digest passed by the lane. Cancellation must echo the leased process
group and fencing token, and cleanup succeeds only after a clean inspection and
an explicit destruction receipt. Missing or mismatched attestations fail
closed. Cleanup or contamination failures call `quarantine` and preserve the
attempt boundary for investigation.

The admitted policy pins the image digest and runtime-lock digest; requests an
unprivileged UID/GID, private process namespace and group, read-only root,
no-new-privileges, all capability drops, default seccomp, and declared PID,
CPU, memory, disk, descriptor, phase-time, cleanup-time, and total-time limits.
Only fresh attempt directories are mounted. Developer home/state, sessions,
sockets, worktrees, mutable caches, credential stores, and container-engine
sockets are forbidden mount classes.

Acquisition receives its own `none` or HTTPS-host-allowlist policy. Credentials
are audience-labelled files with an acquisition-only scope and expiry; the
secret boundary is destroyed before execution. Execution receives only the
network policy sealed in the `RuntimeLock`. An offline lock therefore has a
digest-attested `none` policy, an empty credential list, and an environment
without API credential variables. Untrusted repository workloads select
`disposable-vm`; deployments that do not provide that boundary reject it.

`resolveConfinedArtifact` accepts only existing relative output paths. It
rejects absolute paths, traversal, missing paths, and symlinks whose canonical
target escapes the attempt output root.

## Dedicated Desktop boundary

Desktop testing requires:

- an automation-only macOS account and graphical session;
- a dedicated benchmark credential or workspace identity;
- encrypted storage with no personal or cloud-synchronized files;
- an isolated Codex home and plugin installation;
- no concurrent human use or fast-user switching;
- one mutating experiment lease per host initially;
- a versioned golden image and reimage procedure.

The Codex Desktop app owns its backend process, app-server endpoint, and
session inventory. Benchmark clients must not unlink, replace, or stop a
host-owned endpoint. Restart and crash testing may restart only the app inside
the leased dedicated worker.

A local-development safety guard must reject a Desktop lifecycle action unless:

- the host is registered as `desktop-macos`;
- its automation marker and golden-image identity verify;
- the active OS user is the automation user;
- the lease fencing token is current;
- no development profile, process, socket, or Codex home is mounted or
  addressable;
- the target bundle and process identities match the lease.

Generic commands such as `pkill Codex` are forbidden. Lifecycle control targets
the verified bundle/process inside the dedicated worker.

Plugin installation or upgrade drains the host, installs one exact artifact,
restarts Desktop, and verifies discovery in a fresh task. Existing tasks are not
accepted as reload evidence because they may retain stale skill or plugin
locators.

Unexpected tasks, profile drift, socket-owner mismatch, plugin duplication,
crash loops, ambiguous mutations, or cleanup failure quarantine the entire
host. A reimage is the default recovery for unexplained state.

## Runtime lock

Every experiment candidate references an immutable `RuntimeLock` with a closed
schema:

The sketch below is abridged. The
[golden v1 fixture](../test/fixtures/experimentation-contract/runtime-lock-v1.json)
is the complete closed record, including migration, identity, revision,
lineage, lifecycle, permissions, signatures, and complete nested provenance.

```json
{
  "schemaVersion": 1,
  "runtimeClass": "headless-oci",
  "platform": {
    "os": "linux",
    "architecture": "arm64",
    "imageDigest": "sha256:..."
  },
  "source": {
    "repository": "https://github.com/virusimmortal00/nelos.git",
    "commit": "40-character-sha",
    "treeDigest": "sha256:...",
    "dirty": false
  },
  "toolchain": {
    "nodeVersion": "exact-patch",
    "nodeDigest": "sha256:...",
    "npmVersion": "exact-version",
    "lockfileDigest": "sha256:..."
  },
  "codex": {
    "product": "cli",
    "version": "exact-version",
    "artifactDigest": "sha256:...",
    "appServerSchemaDigest": "sha256:...",
    "compatibilityReleaseId": "codex@..."
  },
  "plugin": {
    "id": "nelos",
    "version": "exact-version",
    "packageDigest": "sha256:...",
    "manifestDigest": "sha256:...",
    "skillDigests": []
  },
  "permissionsDigest": "sha256:...",
  "contractDigest": "sha256:...",
  "lockDigest": "sha256:..."
}
```

The lock also records locale, timezone, filesystem behavior, sandbox policy,
dependency/SBOM digest, builder identity, signatures, model/profile IDs,
protocol fixture, permissions, plugin dependency graph, and persisted-state
migration version.

`runtimeId` content-addresses that complete admission and immutable-provenance
projection. `lockDigest` also binds lifecycle state while excluding only the
managed revision lineage and the digest field itself. The implemented lifecycle
is:

```text
draft -> reviewed -> sealed -> active -> superseded | revoked
draft | reviewed | sealed -> invalidated
```

Branches, `latest`, `marketplace/stable`, floating model aliases, and container
tags cannot satisfy admission. They may be recorded as source metadata only
after resolving to immutable artifacts.

The worker verifies the lock before attaching secrets or writable storage.
Missing identities, unknown fields, digest mismatch, duplicate cached plugin
copies, unsupported Codex builds, or incompatible evidence fail closed.

## Plugin-version experiments

Each plugin candidate is built once from an exact source commit. The build emits
the package, manifest, dependency graph, checksums, distribution provenance, and
signature or attestation. Trials install from that immutable local artifact into
a new Codex home.

Baseline trials use the same runtime and task contract with `plugin: null`.
They do not reuse a home from a plugin trial. Version A and version B never share
a writable plugin cache.

The effective plugin inventory is captured after installation and compared with
the lock. More than one installed or cached copy that could satisfy the same
plugin identity is contamination.

## Construction and caches

Images are built from pinned base-image and binary digests. A separate
network-enabled acquisition phase downloads exact commits or release assets and
verifies signatures and checksums. Execution consumes verified material
read-only.

Caches are content-addressed and read-only during a trial. Safe candidates
include source archives, npm content, and exact installers. Never cache:

- writable Codex or user homes;
- Desktop profiles or session databases;
- Nelos state;
- workspaces or worktrees;
- credentials;
- app-server sockets;
- trial results.

Cache corruption evicts the object and quarantines its producer. It never causes
fallback to mutable or unverified content.

## Leases, capacity, and cancellation

A worker lease binds:

```text
execution + work unit + revision + attempt + worker + runtime lock
+ workspace + expiration + controller + fencing token
```

Only the current fencing token may request effects or commit progress. Lease
loss stops new effects. An in-flight mutation becomes unknown and requires
reconciliation.

Headless workers may run concurrently only with independent namespaces and
quotas. Desktop workers initially advertise one mutating slot. Repository
worktree topology changes are serialized by repository identity.

Each phase has a monotonic deadline: queue, acquisition, boot, preflight,
execution, result collection, cleanup, and total time. A read timeout means no
new evidence and may be retried according to policy. A mutation timeout is
unknown and may not be blindly repeated.

Headless cancellation targets the leased process group, waits a bounded grace
period, then force-terminates owned processes. Desktop cancellation uses a
verified native interruption capability. If interruption is unavailable or
ambiguous, preserve receipts and quarantine the host; never kill the development
app or a host-owned backend.

## Upgrade and rollback

An upgrade:

1. Builds a new immutable image and lock.
2. Collects exact source, generated-schema, and runtime evidence.
3. Runs offline compatibility and platform tests.
4. Canaries one headless pool and one dedicated Desktop host.
5. Drains current leases.
6. Promotes the new lock digest.

Images and installed artifacts are not mutated in use. Rollback selects the
previous immutable lock after checking persisted-state compatibility.

## Runtime invariants

1. No trial starts unless every locked identity and digest matches.
2. Attempts never share writable homes, state, workspaces, credentials, or
   output directories.
3. Desktop lifecycle commands cannot target a development host or profile.
4. One Desktop host has at most one mutating lease until stronger concurrency
   evidence exists.
5. A timed-out mutation is reconciled before retry.
6. Cleanup or contamination failure prevents worker reuse.
7. Result artifacts cannot escape the owned workspace through absolute paths,
   traversal, or symlinks.
8. Mutable plugin channels and untested Codex versions fail admission.
9. Headless evidence never satisfies Desktop-only gates.
10. Upgrade promotion binds all evidence to one runtime-lock digest.
