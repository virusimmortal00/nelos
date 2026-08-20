# Proxmox Desktop lease authority

Every production Desktop VM is fenced by an authority on the Proxmox host.
The authority is independent of the per-run binder and survives controller or
runner restarts. A run packet can describe a lease, but it cannot make that
lease current. Only the root-operated authority can do so.

The authority stores one canonical current record for each exact
`providerId`/`hostId`/`vmid` resource key under
`/var/lib/nelos-lease-authority`. Records are canonical JSON, content
addressed, chained through `previousRecordDigest`, and retained in a contiguous
append-only revision history. A new assignment increments both the resource
epoch and revision. A state transition increments the revision without
changing the epoch or lease identity. A current record that is older than its
history, a broken chain, a missing revision, a clock rollback, or an inexact
identity fails closed.

The four states are:

- `active`: exact run work is allowed before `expiresAt`; ordinary cleanup is
  allowed only inside that same active window.
- `cleanup-only`: only the allowlisted stop, quarantine, and destroy effects
  are allowed before `cleanupExpiresAt`.
- `revoked`: no automatic mutation is allowed. Preserve the VM and reconcile
  it manually.
- `completed`: no automatic mutation is allowed. A fresh assignment may be
  issued only by naming this exact terminal record digest and using fresh
  lease, fence, and run identities that have never appeared in this resource's
  authority history.

The effect margin comes from the immutable host trust, never from a run. The
provider helper re-reads the authority under a shared authority lock immediately
before every non-GET PVE effect and holds that lock through `pvesh`; an exclusive
transition or reassignment therefore cannot race an admitted effect. The
independent attestor reads the same host-local record and returns its observation
time, exact canonical bytes, record-file digest, record digest, and parsed value.
Neither forced SSH command
accepts a caller-selected lease lookup.

The authority resource key deliberately remains only
`providerId`/`hostId`/`vmid`. The bound no-argument runtime path additionally
validates the sealed MAC, VNet, gateway VMID, and network-policy digest from the
root-owned run binding before it compares the lease, fence, and run. Those
network values cannot redirect authority lookup and an old fence cannot mutate
a reassigned VM or NIC.

## One-time authority preparation

Install the three root helpers from the exact staged candidate:

```sh
sudo bash ./validation/proxmox/desktop/helpers/install-host-helper.sh
```

Prepare a canonical, root-owned `0400` trust input. The production state root
is fixed; the authority ID is stable for this authority installation:

```json
{
  "authorityId": "prox2-desktop-authority-v1",
  "effectMarginMs": 5000,
  "hostId": "prox2",
  "kind": "nelos.proxmox-desktop.lease-authority-trust.v1",
  "providerId": "proxmox-lab",
  "schemaVersion": 1,
  "stateRoot": "/var/lib/nelos-lease-authority"
}
```

Then run once from the trusted Proxmox console:

```sh
sudo /usr/libexec/nelos-proxmox-lease-authority prepare \
  --trust /root/nelos-lease-authority-trust.json
```

The command is idempotent only for byte-identical trust. It does not install a
run binding and does not grant SSH access.

## Issue a lease

Use a root-owned canonical `0400` request. `previousRecordDigest` is `null` for
the first epoch and must be the exact current completed record digest for a
later epoch:

```json
{
  "authorityId": "prox2-desktop-authority-v1",
  "cleanupExpiresAt": "2026-08-20T18:00:00.000Z",
  "expiresAt": "2026-08-20T17:00:00.000Z",
  "fencingToken": "fence-desktop-9401-0001",
  "holderId": "nelos-validator",
  "leaseId": "lease-desktop-9401-0001",
  "previousRecordDigest": null,
  "reason": "approved production Desktop validation run",
  "resource": {
    "hostId": "prox2",
    "providerId": "proxmox-lab",
    "vmid": "9401"
  },
  "runId": "desktop-run-20260820-0001"
}
```

```sh
sudo /usr/libexec/nelos-proxmox-lease-authority issue \
  --request /root/nelos-desktop-lease-issue.json \
  > /root/nelos-desktop-lease-observation.json
```

Pass the resulting observation, unchanged, to the production run composer. It
contains the record, its canonical bytes in base64, the record digest, trust
digest, epoch, revision, authority ID, resource key, `recordFileDigest`, and
`observedAt`. Never reconstruct it from reservation fields.

## Observe and transition

An operator may inspect an exact resource using a sealed resource document:

```json
{"hostId":"prox2","providerId":"proxmox-lab","vmid":"9401"}
```

```sh
sudo /usr/libexec/nelos-proxmox-lease-authority observe \
  --resource /root/nelos-desktop-resource.json
```

Transitions use one sealed request that repeats the exact current lease
identity and current record digest:

```json
{
  "authorityId": "prox2-desktop-authority-v1",
  "currentRecordDigest": "sha256:<64 lowercase hex>",
  "fencingToken": "fence-desktop-9401-0001",
  "holderId": "nelos-validator",
  "leaseId": "lease-desktop-9401-0001",
  "reason": "run deadline crossed; authorize bounded cleanup only",
  "resource": {
    "hostId": "prox2",
    "providerId": "proxmox-lab",
    "vmid": "9401"
  },
  "runId": "desktop-run-20260820-0001"
}
```

Choose exactly one transition:

```sh
sudo /usr/libexec/nelos-proxmox-lease-authority cleanup-only --request /root/transition.json
sudo /usr/libexec/nelos-proxmox-lease-authority revoke       --request /root/transition.json
sudo /usr/libexec/nelos-proxmox-lease-authority complete     --request /root/transition.json
```

`complete` is an operator assertion that manual reconciliation is finished or
the exact resource has reached its terminal outcome. Do not use it merely to
clear a revoked record. A revoked or superseded run receives
`LEASE_MANUAL_RECONCILIATION_REQUIRED` or `LEASE_SUPERSEDED`; the runner must
not automatically stop, quarantine, destroy, or otherwise mutate the VM.

## Bound runtime observations

These commands are internal fixed boundaries and take no resource or lease
argument:

```sh
sudo /usr/libexec/nelos-proxmox-lease-authority observe-bound
sudo /usr/libexec/nelos-proxmox-lease-authority authorize-bound active
sudo /usr/libexec/nelos-proxmox-lease-authority authorize-bound cleanup
```

The attestor exposes only `GET /nelos/lease-authority/current` for this
record. `nelos-observe-current-lease` uses that route, verifies the returned
canonical bytes and authority identity, and writes a content-addressed recovery
observation. Provider inventory is not a lease authority and cannot substitute
for this record.

## Offline verification

```sh
python3 -m py_compile validation/proxmox/desktop/helpers/nelos-proxmox-lease-authority.py
node --test test/proxmox-lease-authority.test.mjs
```

The fake-root harness is marker-gated and refuses production clock overrides.
It covers restart reconstruction, expiry margins, cleanup-only authorization,
revocation, completion, epoch reassignment, stale transitions, current-record
rollback, and proof that an old fence cannot reach the fake `pvesh` effect.
