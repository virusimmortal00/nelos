# Resumable Desktop runner operations

`nelos-desktop-runner` is the fail-closed controller for the Ubuntu 24.04
Proxmox Desktop validation lane. It is not a VM-discovery tool and it never
chooses an account, host, VMID, image, benchmark, scenario, or budget. Operators
must bind those values before preflight. The CLI performs no live operation
without the literal `--authorize-live` flag and a separately supplied runtime
module.

## Immutable run packet

Keep the run packet on an operator-controlled filesystem. It contains:

- the immutable candidate digest, exact Desktop bundle ID/version/digest, golden
  image ID/digest and its template VMID;
- benchmark profile and scenario-manifest IDs and digests, with every scenario,
  fresh task ID, action timeout, assertion, capture checkpoint, and deadline;
- provider ownership (`providerId`, `hostId`, reserved `vmId`, exact
  `macAddress`, VNet `networkId`, gateway `gatewayId`, and
  `networkPolicyDigest`), reservation ID,
  active lease identity/expiry/state, current fencing token, and the independent
  authority ID, trust digest, epoch, issued revision, issued record digest, and
  exact-record file digest;
- explicit maximum task count, model turns, spend, reserved spend, wall time,
  screenshot count/bytes, recording duration/bytes, and diagnostic count/bytes;
- per-operation usage reservations for provision, every scenario, cleanup,
  quarantine, archive convergence, and evidence finalization. Archive
  convergence must reserve at least two screenshots and its full shared
  convergence deadline;
- the dedicated `nelosauto` account identity and per-run state root. The golden
  image must not contain that account, credentials, benchmark values, tokens, or
  developer state. Clone configuration creates a locked-password account with
  no SSH keys and fresh, non-persistent writable state.

`reservedSpendUsd` must pessimistically cover `maxSpendUsd` before admission.
The production v1 identity is fixed to provider `proxmox-lab`, host `prox2`,
gateway VMID `9023`, and VNet `nelosbld`; an internally consistent alternate
VNet is rejected before provider inspection, SSH, output creation, or mutation.
The runner validates projected usage during preflight and again immediately
before every bounded effect. A ceiling is a stop boundary, not a target: usage
equal to a ceiling is rejected.

The packet `runDeadlineAt` is also enforced by the runner itself immediately
before provisioning, each GUI/model scenario, archive convergence, and new
capture work. Crossing it durably selects cleanup-only recovery. It can never
start another clone, model turn, GUI action, archive action, or capture merely
because the original process passed admission while the deadline was still
current.

## Offline inspection and preflight

These commands validate only local JSON and the public
`nelos/remote-desktop-contract`; they do not load a runtime module or contact a
provider, Desktop, or model.

```sh
nelos-desktop-runner dry-run --config /srv/nelos/runs/RUN_ID/packet/run.json
nelos-desktop-runner preflight --config /srv/nelos/runs/RUN_ID/packet/run.json
```

Review the returned identity digest and projected usage against the change
ticket. Confirm that the candidate, bundle, golden image, benchmark profile,
scenario manifest, provider owner, lease, fence, reservation, dedicated account,
and all ceilings are exactly the approved values. Do not proceed if the lease
will expire before the worst-case wall-time plus cleanup margin.

The end-to-end harness is offline:

```sh
node --import ./scripts/test-bootstrap.mjs --test test/remote-desktop-runner.test.mjs
```

It injects crashes after provisioning, GUI work, evidence commit, exact destroy,
and quarantine, and also covers in-flight GUI ambiguity, failure, cancellation,
identity mismatch, and content-addressed journal recovery.

## Explicit live authorization

Live operation requires all of the following:

1. An approved change/benchmark ticket naming the exact run identity digest.
2. A dedicated provider account scoped to the named host, template, and reserved
   disposable VMID. Never use a personal or broad cluster-administrator account.
3. A canonical active issue observation made immediately before launch by the
   independently operated host-local lease authority. Reservation or packet
   fields are not a current-lease observation.
4. A fresh read-only QGA measurement from the fixed candidate-bound observer in
   the exact gateway VM. Its composite identity over the full stateless
   nftables ruleset digest, VNet, and exact approved-address inventory digest
   must equal the sealed `networkPolicyDigest`; the inventory must contain no
   duplicates or extras, and the minimum actual element expiry must
   cover the remaining run deadline plus cleanup budget. An operator-authored
   file or copied packet field is not policy attestation.
5. Confirmed spend reservation and enough time for worst-case cleanup.
6. A reviewed runtime module exporting `createRemoteDesktopRuntime(config)` and
   providing the backend controller, the contract GUI driver, the mandatory
   archive-projection controller, and (when needed) an evidence collector. The
   projection controller must archive exact scenario task IDs once, capture a
   post-cleanup checkpoint, restart Desktop under a new app-instance identity,
   capture a post-restart checkpoint, and reconcile interrupted effects without
   replay. Runtime modules must use
   `ProxmoxDesktopControllerV1`/`runProxmoxDesktopOperationV1`, not raw mutation
   calls.
7. A human-issued command containing the one-run authorization gate:

```sh
nelos-desktop-runner run \
  --config /srv/nelos/runs/RUN_ID/packet/run.json \
  --authorize-live
```

The packaged homelab entrypoint is `nelos/homelab-desktop-runtime`. A production
run packet points `runtimeModule` at that module and adds this closed, non-secret
configuration. The state root must be named for the run and directly contain
the journal and evidence directories; the sealed-value root must also end in
the run ID but remains a separate one-shot staging namespace.

```json
{
  "runtimeModule": "nelos/homelab-desktop-runtime",
  "journalDirectory": "/srv/nelos/runs/RUN_ID/journal",
  "homelab": {
    "schemaVersion": 1,
    "stateRoot": "/srv/nelos/runs/RUN_ID",
    "sealedValueRoot": "/run/nelos-sealed/RUN_ID",
    "guiBindings": {
      "task-composer": { "role": "textbox" },
      "submit-key": { "role": "textbox", "key": "ENTER" }
    },
    "deadlines": { "providerMs": 30000, "qgaMs": 20000, "archiveMs": 60000 },
    "outputLimits": { "providerBytes": 8388608, "qgaBytes": 8388608, "archiveReportBytes": 10485760 }
  }
}
```

The module invokes only `/usr/libexec/nelos-proxmox-transport` on the host and
the fixed AT-SPI/archive helpers in the admitted guest through QGA. The provider
helper obtains its scoped Proxmox credentials outside this JSON. Do not add
tokens, passwords, cookies, sealed values, commands, endpoints, or helper paths
to the run packet.

`--offline-adapter` is test-only and must never appear in a production ticket.
Do not place secrets or sealed benchmark values in the run packet, journal,
command line, logs, or evidence plan.

## Resume, cancel, and journal rules

The journal's `CURRENT` pointer selects one immutable, content-addressed entry.
Each entry records generation, accepted state, conservative usage, effect
intents, committed receipts, immutable identity, and terminal attestation. A
provider or GUI effect intent is committed before invocation. On resume, only a
committed effect with the same identity is adopted.

```sh
nelos-observe-current-lease \
  --config /srv/nelos/runs/RUN_ID/packet/run.json
# Copy the exact `path` from that canonical JSON result into CURRENT_LEASE_PATH.
nelos-desktop-runner run \
  --config /srv/nelos/runs/RUN_ID/packet/run.json \
  --current-lease-observation CURRENT_LEASE_PATH \
  --authorize-live
nelos-desktop-runner inspect --config /srv/nelos/runs/RUN_ID/packet/run.json
nelos-desktop-runner resume \
  --config /srv/nelos/runs/RUN_ID/packet/run.json \
  --current-lease-observation CURRENT_LEASE_PATH
nelos-desktop-runner cancel \
  --config /srv/nelos/runs/RUN_ID/packet/run.json \
  --current-lease-observation CURRENT_LEASE_PATH
```

The first `run`, not only recovery, requires this fresh independent authority
observation. The issued observation sealed into `run.json` fixes the immutable
lease/fence identity; it does not authorize mutation after the operator has
installed the host binding and staged one-shot values. For an initial run, the
fresh authority record must still be `active` and its lease must outlive the
sealed run deadline. Generate a new receipt immediately before each `run`,
`resume`, or `cancel`; preflight remains read-only and does not require one.

The recovery receipt must be canonical JSON at the exact content-addressed
filename inside the packet-declared `roots.recovery` directory. The controller
opens it without following links, compares the opened file identity and
metadata, and reads those same bytes through that descriptor. An arbitrary
absolute path, digest/filename mismatch, link, replacement race, wrong owner,
or permissive mode fails before runtime creation.

Do not hand-author this receipt. `nelos-observe-current-lease` obtains it by
calling only the independently credentialed Proxmox attestor. Its remote root
helper resolves the resource from `/etc/nelos-desktop/run-binding.json`, verifies
the immutable issued authority binding, and returns the canonical current record,
exact record bytes, file digest, record digest, authority ID, trust digest, epoch,
revision, state, and observation time from `/var/lib/nelos-lease-authority`.
There is no caller-selected lookup. A controller-authored JSON file—even one
that repeats expected values—is not operational evidence and must never be
staged into `roots.recovery`.

`active` permits work only before `expiresAt`. `cleanup-only` permits only the
exact allowlisted cleanup effects before `cleanupExpiresAt`. `revoked`,
`completed`, a superseding epoch, rollback, or broken revision chain returns no
automatic mutation authority; preserve the VM and reconcile manually. The host
provider helper repeats this check under the authority lock immediately before
every effect and holds the lock through `pvesh`.

A pending provider or archive-convergence intent must go through its runtime
module read/reconcile boundary; it is never blindly invoked again. A pending GUI
intent is ambiguous and is never replayed—the run fails and proceeds to cleanup.
Cancellation is durable and also proceeds to cleanup. If no provision intent
was ever journaled and the fresh independent reservation probe still proves the
VMID absent, cancellation instead records a failed pre-provision abort: it does
not invent a destroy receipt and issues no destroy or quarantine mutation.
Never edit `CURRENT` or an entry by hand, copy effects between run directories,
or resume with changed inputs.

## Evidence and terminal review

Evidence finalization happens only after cleanup returns an identity-matching
terminal attestation. The evidence pipeline sanitizes visual geometry, accepts
only closed diagnostic fields, builds content-addressed artifacts, validates the
unchanged remote Desktop export contract, and verifies every file and digest.
An invalid, forbidden, uncertain-geometry, altered, or over-budget bundle makes
the run failed; it can never be reported as success.

Before publishing a successful result, review:

- journal state is exactly `succeeded`, every effect is `committed`, and there
  are no failures or unresolved intents; every provider mutation has a fresh
  independently observed network-policy admission committed before it;
- every scenario passed under a unique fresh task and usage remains below all
  admitted ceilings;
- archive convergence is `passed`, exact archive receipts cover every scenario
  task, both checkpoints are clean, and the restart receipt proves a different
  Desktop app-instance identity;
- the evidence inventory and export identities match the journal and contain
  only sanitized allowlisted classes;
- the terminal outcome is `destroyed`, the receipt is committed, `destroyed` is
  true, and provider/host/VM/lease/fence all exactly match the admitted run;
- an independent complete provider inventory read proves the exact VMID is
  absent, no replacement resource has reused it, and the exact sealed MAC is
  absent cluster-wide.

## Quarantine reconciliation and incident stops

Uncertain destruction never becomes success. The backend commits an
identity-preserving quarantine receipt containing the original provider, host,
VMID, lease, fence, reconciliation operation, and the metadata-only proof that
the swap-free tmpfs credential store was lost by powering off the exact VM.
Quarantine must remain stopped; QGA scrub is never the sole credential-loss
boundary. Keep the VM isolated and
preserve the journal and provider audit record. Move the exact current authority
record to `cleanup-only` only through the root-operated transition command, or
revoke it and reconcile manually. Destruction may be performed only under exact
current cleanup authority and a new explicit
authorization and must produce exact absence attestation. Do not rewrite the
original quarantined outcome.

If QGA disappears during authentication or cleanup, use the trusted Proxmox
console—not the guest—to recover. Resolve the VMID only from the sealed run
packet, run `qm stop <sealed-vmid> --timeout 30`, and require `qm status
<sealed-vmid>` to report exactly `status: stopped`. Do not start, resume,
hibernate, snapshot a running guest, or mount its disk. Preserve the journal and
provider audit record, then resume only the identity-bound cleanup/quarantine
reconciler under fresh cleanup authority. If stopped state or the original
run/fence/VM identity cannot be independently proven, no quarantine or scrub
receipt may be invented; escalate the resource as an incident while keeping its
network isolated.

Stop immediately and open an incident if any of these occurs:

- candidate, bundle, image, manifest, provider ownership, lease, fence,
  reservation, VM inventory, or journal identity differs;
- the lease is expired/near expiry, spend is unreserved, or any projected or
  actual ceiling is reached;
- a provider mutation is ambiguous and reconciliation cannot prove one exact
  outcome, or a GUI intent lacks a committed receipt;
- protected capture geometry is incomplete, evidence contains forbidden data,
  artifact verification fails, or a bundle has unreferenced files;
- cleanup is reported complete while native inventory, an ordinary MCP map,
  the sidebar, Created Tasks, or the MCP visualization retains an archived task;
- QGA, graphical session, dedicated account, Desktop health, or task freshness
  cannot be attested;
- cleanup cannot prove exact absence or committed quarantine.

When stopped, do not retry mutations, paid turns, GUI actions, or capture. Keep
the identity-preserving journal and use `inspect`; resume only after the named
reconciliation or incident owner has supplied the required external evidence and
fresh authorization.
