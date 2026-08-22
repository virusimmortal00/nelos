# Proxmox Desktop one-run host binding

The production Desktop controller must never SSH to a general administrator
account. One trusted-console bootstrap installs three fixed host helpers and one
sealed run binding. That binding creates two locked, key-only system accounts:
`nelos-provider` can reach only the mutating provider helper and
`nelos-attestor` can reach only the read-only attestation helper. Their ED25519
keys, users, sudo commands, provider, node, source template, reserved VMID,
locally administered MAC, VNet, gateway VMID, installed network-policy digest,
lease, fencing token, and run ID are fixed by one canonical packet.
The third helper is the independent host-local lease authority described in
[`proxmox-desktop-lease-authority.md`](./proxmox-desktop-lease-authority.md).
It is prepared before a run binding, is not owned by that binding, and is
re-read immediately before every provider effect.

The host workflow is
[`nelos-proxmox-run-binding.py`](../validation/proxmox/desktop/helpers/nelos-proxmox-run-binding.py).
`render` and `env` are mutation-free. `install`, `check`, and `cleanup` require
root on the real host. `--fake-root` is marker-gated and exists only for the
offline security suite; it does not prove real uid/gid ownership.

## Compose one production run

Do not hand-assemble `run.json`, its content-addressed run packet, or the host
binding. First stage one clean committed candidate. The staging CLI now emits
compact, sorted, newline-terminated JSON that is directly accepted by the
composer; no `jq` rewrite is needed:

```sh
umask 077
install -d -m 0700 -o "$(id -u)" -g "$(id -g)" /srv/nelos/candidates
node scripts/stage-production-desktop-candidate.mjs \
  --out-dir /srv/nelos/candidates/CANDIDATE_ID \
  > /srv/nelos/inputs/candidate.json
chmod 0400 /srv/nelos/inputs/candidate.json
```

Supply the independently attested golden-image receipt, deterministic guest-task
intent, provider/controller identity, authoritative lease observation, reservation
and budgets, and one scenario as separate canonical JSON files. Every input
must be a caller-owned, non-symlinked, single-link regular file with mode
`0400`, `0440`, `0600`, or `0640`. The output parent must be canonical,
caller-owned, and exactly mode `0700`; the run-ID output directory must not
exist on first composition.

```sh
nelos-prepare-production-run \
  --candidate-manifest /srv/nelos/inputs/candidate.json \
  --golden-receipt /srv/nelos/inputs/golden.json \
  --task-intent /srv/nelos/inputs/tasks/production-task-intent-SHA256.json \
  --provider /srv/nelos/inputs/provider.json \
  --lease /srv/nelos/inputs/lease.json \
  --reservation /srv/nelos/inputs/reservation.json \
  --scenario /srv/nelos/inputs/scenario.json \
  --output-root /srv/nelos/runs/RUN_ID
```

Generate the intent first with `nelos-prepare-production-guest-task`. Its output
names the content-addressed `intentPath` and deterministic `taskSlotId`; the
scenario's task ID must be that exact slot, and `--task-intent` must name the
generated mode-`0400` intent file. This controller step never opens a Codex
app-server or creates a real task. The real ID is created inside the disposable
guest after device authentication and is journaled before any paid turn.

The composition command emits one canonical `composition.json` receipt and creates only
these mode-`0700` directories under the new run root: `packet`, `evidence`,
`recovery`, `staging`, and `operator`. The packet binds all four sealed runtime
roots (`packet`, `evidence`, `recovery`, and `staging`). `packet/run.json`, the
content-addressed run-packet envelope, copied golden receipt and guest-task
intent, the content-addressed host binding, and the composition receipt are
mode `0400`.
The recovery root starts empty and is the only accepted location for later
content-addressed current-lease observations.

`composition.json.sealedValues` lists every unique `type_text_ref` required by
the scenario. It declares only the opaque reference, exact path, caller UID and
GID, mode `0400`, and the 1-to-1,048,576-byte bound; it deliberately contains no
value, value length, or digest. Initial composition leaves that root empty and
does **not** claim the benchmark values are ready. After reviewing the
composition, the trusted secret provider must create every declared
`<valueRef>.sealed` path with `O_CREAT|O_EXCL|O_NOFOLLOW`, write and fsync the
bytes without placing them in argv, environment, shell history, or logs, set
the declared caller owner/group and exact mode `0400`, and fsync the mode-`0700`
root. It must not add a temporary, backup, metadata, or unrelated file there.

Then repeat the same composer command with `--require-sealed-values`. That
post-staging adoption reads metadata only—it does not open, hash, copy, or log a
value—and succeeds only when the inventory is the exact complete declared set.
An empty root fails as `SEALED_VALUES_NOT_READY`; a partial, extra, linked,
misowned, wrong-mode, empty, oversized, or non-canonical entry fails as
`COMPOSER_OUTPUT_TAMPERED`. Only after that gate should the operator invoke the
candidate runner's final `preflight`, followed by the separately authorized
`run`. The GUI resolver unlinks each value before its one allowed use and zeros
the in-memory buffer afterward.

Before publishing the receipt, the composer runs both the selected candidate's
actual `nelos-desktop-runner preflight` executable and its actual Python host
binder. It compares their packet, runner identity, projected usage, source
template, and host-binding digests with an independent in-process preflight,
then recomputes candidate integrity. Any mismatch removes a newly created,
composer-owned partial root; an unverifiable partial root is preserved for
operator inspection. Repeating the exact command adopts only a byte-, mode-,
owner-, path-, inventory-, input-, and preflight-identical completed root.
Changed or extra content fails as `COMPOSER_OUTPUT_TAMPERED` and is never
replaced. Before secret staging, ordinary adoption accepts the intentionally
empty value root; afterward it accepts only the exact complete metadata-safe
set. `--require-sealed-values` is the explicit readiness gate, so ordinary
composition success must never be interpreted as a claim that values exist.

These documents and packets contain public keys and private-key *paths*, but
never private keys, tokens, passwords, cookies, prompts, model responses, or
sealed benchmark values. Secret-shaped fields and values are rejected before
the output root is created. Composition and both cross-preflights are local and
read-only with respect to Proxmox; they do not authorize or perform a VM
mutation.

## Closed packet

The packet must be canonical JSON (sorted keys, compact separators, one final
newline), a non-symlinked root-owned regular file, and mode `0400` or `0440` on
the Proxmox host. Unknown or missing fields fail admission. Its exact shape is:

```json
{
  "access": {
    "attestorPublicKey": "ssh-ed25519 <base64> <optional-comment>",
    "providerPublicKey": "ssh-ed25519 <base64> <optional-comment>"
  },
  "controller": {
    "attestorIdentityFile": "/absolute/controller/path/to/attestor-key",
    "hostFingerprint": "SHA256:<43-base64-characters>",
    "hostPublicKey": "ssh-ed25519 <base64> <optional-comment>",
    "knownHostsFile": "/absolute/controller/path/to/known-hosts",
    "providerIdentityFile": "/absolute/controller/path/to/provider-key",
    "sshHost": "192.168.1.110",
    "sshPort": 22
  },
  "kind": "nelos.proxmox-desktop.host-run-binding.v1",
  "leaseAuthority": {
    "authorityId": "prox2-desktop-authority-v1",
    "epoch": 1,
    "issuedRecordDigest": "sha256:<64 lowercase hex>",
    "issuedRecordFileDigest": "sha256:<64 lowercase hex>",
    "issuedRevision": 1,
    "trustDigest": "sha256:<64 lowercase hex>"
  },
  "provider": {
    "gatewayId": "9023",
    "hostId": "prox2",
    "networkId": "nelosbld",
    "networkPolicyDigest": "sha256:<64 lowercase hex>",
    "networkPolicyObserverDigest": "sha256:<candidate observer bytes>",
    "providerId": "proxmox-lab",
    "sourceTemplateVmId": "<sealed-golden-output-vmid>"
  },
  "runBinding": {
    "automationUser": "nelosauto",
    "fencingToken": "<current-fencing-token>",
    "gatewayId": "9023",
    "hostId": "prox2",
    "imageId": "<sealed-golden-image-id>",
    "leaseId": "<current-lease-id>",
    "macAddress": "02:4E:45:4C:90:28",
    "networkId": "nelosbld",
    "networkPolicyDigest": "sha256:<64 lowercase hex>",
    "providerId": "proxmox-lab",
    "runId": "<one-run-id>",
    "stateRoot": "/var/lib/nelos-desktop/runs/<one-run-id>",
    "vmId": "<reserved-disposable-vmid>"
  },
  "schemaVersion": 1
}
```

`hostFingerprint` must be the SHA-256 fingerprint derived from
`hostPublicKey`. The provider, attestor, and host ED25519 keys must all be
different. The two controller private-key paths must also differ.
For the currently approved `prox2` endpoint, `sshHost` is the literal
`192.168.1.110`. Do not substitute `prox2.sayers.io`: its current DNS result
does not identify that pinned host key. A hostname may be admitted only after
its exact resolved address and offered host key have both been independently
reconciled and re-approved.
`leaseAuthority` is copied only from the accepted authority observation. Its
issued record must be the `issue` record for this exact resource, lease, fence,
and run. Later same-epoch transitions may increase the current revision; a new
epoch makes this run binding superseded and unable to mutate.
`provider.hostId`, `provider.providerId`, `provider.gatewayId`,
`provider.networkId`, and `provider.networkPolicyDigest` must equal the run
binding. Cross-binding equality is not the lane authority: production v1
admits only provider `proxmox-lab`, host `prox2`, gateway VMID `9023`, and VNet
`nelosbld`. Changing every caller-controlled occurrence to another internally
consistent gateway or VNet fails before composition, host installation,
provider inspection, SSH, or provider mutation. `provider.networkPolicyObserverDigest` is derived by the composer from
the verified candidate's fixed gateway observer bytes; it is not a caller
selected command or path. The source-template VMID, disposable VMID, and gateway VMID must all
be distinct. The source-template
VMID is the exact `goldenImage.templateVmId` (and matching
`reservation.outputTemplate.vmId`) from the independently accepted golden image
receipt; it is not an operator-selected substitute.

Before any host mutation, inspect the deterministic plan:

```sh
/usr/bin/python3 validation/proxmox/desktop/helpers/nelos-proxmox-run-binding.py \
  render --packet /root/nelos-run/packet.json
```

The render includes every managed path, digest, target owner and mode, the
exact known-hosts line, and all controller environment variables.

## Trusted bootstrap

1. From the trusted `prox2` console, read
   `/etc/ssh/ssh_host_ed25519_key.pub` and verify its SHA-256 fingerprint
   out-of-band. Do not use `ssh-keyscan`, trust-on-first-use, DNS through a
   reverse proxy, or `StrictHostKeyChecking=accept-new` as the authority.
2. On the controller, create two new one-run ED25519 keypairs with empty
   passphrases in a mode-`0700` run directory. Keep each private key mode
   `0600`. Put the two public keys and the trusted server public key in the
   packet. The private keys are never copied to Proxmox.
3. Bind `sourceTemplateVmId` to the accepted golden receipt, and bind the
   reserved disposable VMID, active lease ID, and current fence to the same run
   packet used by production admission. Canonicalize the completed packet,
   install it mode `0400`, and do not edit it in place.
4. Through the trusted console or an explicitly authorized temporary bootstrap
   administrator key, copy this checkout's three host helpers, stable
   `install-host-helper.sh`, this run-binding workflow, and the sealed packet to
   a root-only staging directory. Verify the candidate checkout and packet
   digests before execution.
5. Run `install-host-helper.sh` once to install the fixed root-owned helpers.
   Prepare the independent authority trust and issue the exact resource lease
   using the lease-authority runbook. Then run the one-run installer below.
   The installer invokes the authority's no-argument bound observation and
   rolls back if the epoch, issued revision, trust, lease, fence, run, or VM
   differs. Remove the temporary bootstrap key and
   staging files immediately after `check` succeeds. The production controller
   uses only the two new narrow accounts.
6. Separately, from the trusted console of gateway VM `9023`, run
   `install-network-policy-observer.sh`. Verify that its printed SHA-256 equals
   `provider.networkPolicyObserverDigest`. This is the only guest command the
   read-only attestor may execute on the gateway. Until that exact helper is
   installed and a fresh measurement's composite full-ruleset plus exact
   approved-address-inventory digest equals
   `networkPolicyDigest`, live validation is NO-GO.

```sh
/usr/bin/python3 /root/nelos-run/nelos-proxmox-run-binding.py \
  install --packet /root/nelos-run/packet.json

/usr/bin/python3 /root/nelos-run/nelos-proxmox-run-binding.py \
  check --packet /root/nelos-run/packet.json \
  --receipt /etc/nelos-desktop/operator-receipt.json
```

The installer refuses a pre-existing managed account or path without its exact
receipt. Repeating `install` for the same packet verifies the complete current
state and returns the same receipt digest. A different run, lease, fence,
source template, key, account identity, file byte, link count, owner, or mode
fails closed without replacing the installed binding.

Save an exact mode-`0400` copy of
`/etc/nelos-desktop/operator-receipt.json` outside the managed paths before
removing bootstrap access. The final cleanup command requires that independent
copy and compares it byte-for-byte with the installed receipt.

## Controller host key and environment

Create the controller's `knownHostsFile` with exactly the `knownHostsLine` from
`render`, one final newline, and mode `0600`. Do not include additional host
keys. The controller transport independently runs `ssh-keygen -lf` and rejects
any observed fingerprint other than the packet's pinned fingerprint.

Generate the exact shell environment without hand-transcribing values:

```sh
/usr/bin/python3 validation/proxmox/desktop/helpers/nelos-proxmox-run-binding.py \
  env --packet /absolute/controller/path/to/packet.json \
  > /absolute/controller/path/to/controller.env
chmod 0600 /absolute/controller/path/to/controller.env
```

The generated file contains these required provider values:

- `NELOS_PROXMOX_SSH_HOST`
- `NELOS_PROXMOX_SSH_PORT`
- `NELOS_PROXMOX_SSH_USER=nelos-provider`
- `NELOS_PROXMOX_KNOWN_HOSTS`
- `NELOS_PROXMOX_IDENTITY_FILE`
- `NELOS_PROXMOX_HOST_FINGERPRINT`
- `NELOS_PROXMOX_HOST_ID`
- `NELOS_PROXMOX_GATEWAY_ID`
- `NELOS_PROXMOX_MAC_ADDRESS`
- `NELOS_PROXMOX_NETWORK_ID`
- `NELOS_PROXMOX_NETWORK_POLICY_DIGEST`
- `NELOS_PROXMOX_PROVIDER_ID`
- `NELOS_PROXMOX_SOURCE_TEMPLATE_VM_ID`

It also contains the same thirteen `NELOS_PROXMOX_ATTEST_*` values, with
`SSH_USER=nelos-attestor`, the distinct attestor private key, and the same exact
source-template VMID. The attestor transport remains bodyless and read-only;
having the template identity does not grant it mutation authority.

The authorized-key lines use OpenSSH `restrict` plus one forced command. The
provider key can run only:

```text
/usr/bin/sudo -n -- /usr/libexec/nelos-proxmox-transport request
```

The attestor key can run only:

```text
/usr/bin/sudo -n -- /usr/libexec/nelos-proxmox-attest request
```

Each locked account receives one matching argument-exact `NOPASSWD` sudoers
entry. Neither account receives a general sudo command, agent forwarding, port
forwarding, X11 forwarding, PTY, user rc, or unforced shell path.

## Receipt-bound cleanup

After the controller has finalized and independently verified all evidence,
clean up using the same immutable packet and the saved exact receipt:

```sh
/usr/bin/python3 /root/nelos-run/nelos-proxmox-run-binding.py \
  cleanup --packet /root/nelos-run/packet.json \
  --receipt /root/nelos-run/receipt.json
```

Cleanup first verifies every account, artifact byte, digest, mode, owner, and
receipt identity. It refuses to proceed if either managed home contains an
unowned file. It then revokes both authorized keys and sudo grants, removes only
the exact receipt-owned accounts and empty homes, and removes only the exact
receipt-owned binding files. Unrelated files under `/etc/nelos-desktop` are
preserved, and the directory is removed only if empty. The host helpers are not
removed.

Before the first revocation it creates a sealed, packet- and receipt-bound
intent under `/var/lib/nelos-proxmox-run-binding-cleanup`. Every credential,
directory, account/private-group, binding, installation-receipt, and final
absence effect is fsynced and journaled separately. A retry with the identical
packet and saved receipt adopts an already-absent effect only through that exact
intent. Terminal cleanup publishes a sealed receipt in the same directory
before clearing the intent, so a lost final response is also idempotently
adopted. Ambiguous or changed surviving state remains quarantined. Repeat the
same command after interruption; never delete the intent by hand.

Finally delete the controller's one-run private keys, known-hosts file,
packet, environment, and saved receipt through the controller's approved
ephemeral-secret disposal procedure.

## Offline verification

The fake-root suite performs no SSH, Proxmox, user, or sudo mutation:

```sh
node --test test/proxmox-operator-run-binding.test.mjs
```

It covers closed-schema and ED25519 validation, independent identities, pinned
host-key derivation, exact source-template environment binding, content-addressed
idempotence, forced commands, modes, conflicting-run refusal, state tampering,
receipt mismatch, unowned-home protection, narrowly scoped cleanup, and
preservation of unrelated files. The fresh-process cleanup matrix interrupts
before and after every effect, after every journal commit, around terminal
receipt publication, and on both sides of intent clearing.
