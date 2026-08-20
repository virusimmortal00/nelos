# Nelos Proxmox Linux Desktop recipe v1

This recipe targets an Ubuntu 24.04 Proxmox clone with one non-human account,
`nelosauto`. Run `install-guest.sh` while building the immutable template;
do not run it from a live experiment packet. Pass an immutable Linux Codex
Desktop `.deb` as `NELOS_CODEX_DESKTOP_DEB` and its lowercase digest as
`NELOS_CODEX_DESKTOP_SHA256`. The installer verifies that digest, uses the dated
Ubuntu snapshot in `ubuntu.sources`, and installs GNOME on Xorg, GDM, the AT-SPI
accessibility stack, screenshot tooling, and the bounded Nelos guest helpers.
The package path must be an absolute, root-owned, single-link regular file that
is not writable by group or world so the one-shot bake receipt cannot bind
caller-mutable bytes.
GDM autologin is enabled only for the automation account and the account is
locked against password/SSH login.

After the runtime binding is installed, the guest exposes explicit bounded
`start`, `status`, and `cancel` device-auth operations. Authentication uses the
package-pinned Codex app-server device-code protocol under `env -i`, a fresh
automation-only `HOME` and `CODEX_HOME`, and the bundled pinned Node runtime.
That `CODEX_HOME` is the exact run-scoped tmpfs
`nelos-codex-<runId>` mounted at `/home/nelosauto/.codex` with
`rw,nosuid,nodev,noexec`; it is never a writable image layer. The credential
boundary refuses authentication unless both `swapon` and `/proc/swaps` prove
that swap is empty, and it binds its metadata-only receipt to the run, fence,
VMID, golden-image ID, and boot identity. Provisioning disables swap, removes swap entries from
`fstab`, and masks hibernation and sleep targets. Any path, source, mount-option,
swap, ownership, or boot-identity drift fails closed.
Only metadata (`chatgpt`, file credential store, a run-salted account binding
digest, and the complete run binding) is persisted in the root-owned receipt;
account email, tokens, login IDs, and device codes are not. The Desktop user service and bounded graphical readiness
check start only after that receipt is established. No developer Codex home or
session file is accepted.

`cancel` stops auth and Desktop services, unmounts the tmpfs, proves the
persistent mountpoint empty, removes run auth/readiness metadata, and commits a
metadata-only scrub receipt. A scrubbed boundary cannot be reopened. If QGA is
lost, the host must stop and independently attest the exact VM as `stopped`
before applying quarantine; quarantine never preserves a running guest with a
reusable credential.

Capture readiness also requires `/run/user/<uid>` to be `tmpfs` and executes a
one-pixel ImageMagick probe with explicit `map=0` and `disk=0` limits. Production
`import`, `identify`, and `convert` calls repeat those limits, use a unique
mode-`0700` runtime cache directory, verify it remains empty, and fail closed on
any attempted spill.

After authentication, the QGA allowlist exposes a fixed
`/usr/libexec/nelos-guest-task-control` route. It loads only the integrity-checked
candidate installed at `/opt/nelos-desktop/nelos`, runs the pinned app-server
and packaged Nelos MCP as `nelosauto` against `/home/nelosauto/.codex`, and uses
the canonical mode-`0700` `/home/nelosauto/workspace`. Task preparation requires
an empty complete pre-inventory, creates exactly one empty task, and seals a
run-, fence-, account-, runtime-, ID-, and title-bound receipt before GUI model
work. Native, MCP, and AT-SPI task/archive observations therefore inspect the
same guest store; no controller-store synchronization is assumed.

Before either `start` or `status` can enter the device-auth flow, the fixed
`/usr/libexec/nelos-desktop-identity` helper must validate the immutable
package lock and its root-owned bake receipt, re-hash and version-check the
installed Codex and Node binaries, query the exact installed Desktop package,
and complete an app-server initialize probe in a fresh empty automation home.
The host can request that same metadata-only proof through exactly this QGA
body; the command and its empty argument list are fixed rather than selected by
the caller:

```json
{
  "capture-output": 1,
  "command": "/usr/libexec/nelos-desktop-identity",
  "extra-args": []
}
```

`input-data`, helper subcommands, package paths, and any additional fields are
rejected by the PVE transport. The provisioning-only `bake` subcommand is never
QGA-routable.

The versioned backend exposes this as a command-free request whose only fields
are `control` and the exact nine-field provider/run binding:

```json
{
  "control": "installed-desktop-identity",
  "binding": {
    "providerId": "...",
    "hostId": "...",
    "vmId": "...",
    "macAddress": "...",
    "networkId": "nelosbld",
    "gatewayId": "9023",
    "networkPolicyDigest": "sha256:...",
    "leaseId": "...",
    "fencingToken": "..."
  }
}
```

The backend, not its caller, lowers that request to the fixed QGA body above.

Install the PVE-native Python helpers with `install-host-helper.sh`; the target
node needs only its existing `/usr/bin/python3` and `/usr/bin/pvesh`. The
installer creates the mutating `/usr/libexec/nelos-proxmox-transport` and the
separate read-only `/usr/libexec/nelos-proxmox-attest`. Install
`nelos-network-policy-observer.py` separately inside the exact gateway guest as
`/usr/libexec/nelos-network-policy-observer` with
`install-network-policy-observer.sh`; the host attestor invokes only its fixed
`observe` operation through QGA and binds its measured bytes to the candidate
digest. The production helpers accept closed JSON envelopes
and compare the exact run, provider, host, VMID, lease, fence, image, automation
user, and state-root binding against root-owned files before any operation.
No host observation-staging helper is installed or routed. Active task and
archive surfaces are independently producer-observed and cannot be supplied as
staged claims. Archive AT-SPI output contains three ordered, distinct-container
proofs for sidebar, open Created Tasks summary, and the Nelos MCP visual; a
generic row inventory, hidden summary remainder, or ambiguous container is a
typed failure. All helper inputs reject stale or identity-mismatched records.
