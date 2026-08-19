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
- provider ownership (`providerId`, `hostId`, reserved `vmId`), reservation ID,
  active lease identity/expiry/state, and current fencing token;
- explicit maximum task count, model turns, spend, reserved spend, wall time,
  screenshot count/bytes, recording duration/bytes, and diagnostic count/bytes;
- per-operation usage reservations for provision, every scenario, cleanup,
  quarantine, and evidence finalization;
- the dedicated `nelosauto` account identity and per-run state root. The golden
  image must not contain that account, credentials, benchmark values, tokens, or
  developer state. Clone configuration creates a locked-password account with
  no SSH keys and fresh, non-persistent writable state.

`reservedSpendUsd` must pessimistically cover `maxSpendUsd` before admission.
The runner validates projected usage during preflight and again immediately
before every bounded effect. A ceiling is a stop boundary, not a target: usage
equal to a ceiling is rejected.

## Offline inspection and preflight

These commands validate only local JSON and the public
`nelos/remote-desktop-contract`; they do not load a runtime module or contact a
provider, Desktop, or model.

```sh
nelos-desktop-runner dry-run --config /srv/nelos/runs/RUN_ID/run.json
nelos-desktop-runner preflight --config /srv/nelos/runs/RUN_ID/run.json
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
3. A current external lease and fencing-token observation made immediately
   before launch.
4. Confirmed spend reservation and enough time for worst-case cleanup.
5. A reviewed runtime module exporting `createRemoteDesktopRuntime(config)` and
   providing the backend controller, the contract GUI driver, and (when needed)
   an evidence collector. Runtime modules must use
   `ProxmoxDesktopControllerV1`/`runProxmoxDesktopOperationV1`, not raw mutation
   calls.
6. A human-issued command containing the one-run authorization gate:

```sh
nelos-desktop-runner run \
  --config /srv/nelos/runs/RUN_ID/run.json \
  --authorize-live
```

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
nelos-desktop-runner inspect --config /srv/nelos/runs/RUN_ID/run.json
nelos-desktop-runner resume --config /srv/nelos/runs/RUN_ID/run.json --authorize-live
nelos-desktop-runner cancel --config /srv/nelos/runs/RUN_ID/run.json --authorize-live
```

A pending provider intent must go through the runtime module's read/reconcile
boundary; it is never blindly invoked again. A pending GUI intent is ambiguous
and is never replayed—the run fails and proceeds to cleanup. Cancellation is
durable and also proceeds to cleanup. Never edit `CURRENT` or an entry by hand,
copy effects between run directories, or resume with changed inputs.

## Evidence and terminal review

Evidence finalization happens only after cleanup returns an identity-matching
terminal attestation. The evidence pipeline sanitizes visual geometry, accepts
only closed diagnostic fields, builds content-addressed artifacts, validates the
unchanged remote Desktop export contract, and verifies every file and digest.
An invalid, forbidden, uncertain-geometry, altered, or over-budget bundle makes
the run failed; it can never be reported as success.

Before publishing a successful result, review:

- journal state is exactly `succeeded`, every effect is `committed`, and there
  are no failures or unresolved intents;
- every scenario passed under a unique fresh task and usage remains below all
  admitted ceilings;
- the evidence inventory and export identities match the journal and contain
  only sanitized allowlisted classes;
- the terminal outcome is `destroyed`, the receipt is committed, `destroyed` is
  true, and provider/host/VM/lease/fence all exactly match the admitted run;
- an independent provider inventory read proves the exact VMID is absent and no
  replacement resource has reused it.

## Quarantine reconciliation and incident stops

Uncertain destruction never becomes success. The backend commits an
identity-preserving quarantine receipt containing the original provider, host,
VMID, lease, fence, and reconciliation operation. Keep the VM isolated, preserve
the journal and provider audit record, extend or transfer the lease through the
approved ownership system, and reconcile the named operation with a fresh
read-only inventory. Destruction may be performed only under a new explicit
authorization and must produce exact absence attestation. Do not rewrite the
original quarantined outcome.

Stop immediately and open an incident if any of these occurs:

- candidate, bundle, image, manifest, provider ownership, lease, fence,
  reservation, VM inventory, or journal identity differs;
- the lease is expired/near expiry, spend is unreserved, or any projected or
  actual ceiling is reached;
- a provider mutation is ambiguous and reconciliation cannot prove one exact
  outcome, or a GUI intent lacks a committed receipt;
- protected capture geometry is incomplete, evidence contains forbidden data,
  artifact verification fails, or a bundle has unreferenced files;
- QGA, graphical session, dedicated account, Desktop health, or task freshness
  cannot be attested;
- cleanup cannot prove exact absence or committed quarantine.

When stopped, do not retry mutations, paid turns, GUI actions, or capture. Keep
the identity-preserving journal and use `inspect`; resume only after the named
reconciliation or incident owner has supplied the required external evidence and
fresh authorization.
