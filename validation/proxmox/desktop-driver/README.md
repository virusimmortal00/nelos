# Proxmox Desktop provider driver

This directory is the reviewed-source provider implementation for the public
machine-driver boundary documented in `docs/disposable-desktop-smoke.md`. It is
not part of ordinary hosted CI and contains no cluster identity or credential.

Install the exact digest-verified candidate on the protected Linux controller:

```sh
sudo validation/proxmox/desktop-driver/install.sh /absolute/path/to/candidate
```

Copy `config.json.example` to
`/etc/nelos/proxmox-desktop-driver.json`, replace every example identity with
the reviewed maintained-template and designated-disposable-VM values, make the
file root-owned and not group/world writable, and create the referenced files.
The credential file is mode 0600 and contains exactly one
`PVEAPIToken=<token-id>=<secret>` value. The SSH identity is mode 0600. The
known-hosts file must pin the guest host key; the driver fixes
`StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`, and an empty SSH config.

The maintained template must carry the configured tag, be a template on the
configured node, and have every attached disk on an allowlisted storage. The
designated VMID and name are intentionally stable collision sentinels: a run
fails if either exists before cloning. The destination storage must be one
active, enabled `images` storage. A protected, non-DNS-ambiguous guest address
and provider-side network policy are operator prerequisites.

The template includes a root-owned `/usr/local/libexec/nelos-desktop-guest-driver`.
That guest helper accepts only the operations emitted by this controller,
maintains its own operation ledger, installs into the run-specific account and
`CODEX_HOME`, launches Codex Desktop, and returns the exact receipts described
by the controller. Its scenario executor treats the supplied
`submissionActionIds` as at-most-once: it records `not_submitted` before dispatch
or `submitted` after dispatch and never retries those actions. Capture handling
must sanitize protected regions before persistence, enforce the evidence
contract ceilings, and delete source pixels and temporary material before the
package receipt is returned.

The controller ledger uses create-only pending records. A repeated completed
operation returns the durable receipt only when the request digest matches. A
pending operation fails as ambiguous and is never dispatched again. Dependency,
shape, and provider preflight failures occur before a pending record is created,
so the public runner may safely retry them with its stable operation ID. Every
invocation verifies `/usr/bin/jq` before any provider path; driver stdout is one
JSON receipt and all child stdout/stderr is captured and bounded.
