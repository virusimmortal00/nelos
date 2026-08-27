# Disposable Desktop smoke lane

The release smoke lane tests one immutable Nelos package on a fresh Codex Desktop clone and then destroys that clone. It deliberately does not bind a maintained template to a Proxmox VMID, historical VM name, per-release golden-image receipt, or one-model-turn budget.

Run the release scenario set with:

```sh
nelos desktop-test --candidate /absolute/path/to/staged-package --scenario-set release
```

The candidate directory must be outside the controller's `CODEX_HOME` and contain coherent `package.json` and `distribution-provenance.json` files. The command recomputes the package digest before any Desktop operation. This invocation remains the released V1 receipt path.

Select the bounded fresh-VM workflow runner explicitly by supplying both a
unique run identity and a new bundle path:

```sh
nelos desktop-test --candidate /absolute/path/to/staged-package --scenario-set release \
  --run-id release-2026-08-27-1 --bundle-output /absolute/path/to/release-2026-08-27-1.json
```

Bundle mode clones a maintained clean template, assigns a run-unique account and
guest `CODEX_HOME`, verifies the installed and loaded candidate identity, runs the
whole selected library under bounded deadlines, and packages only guest-sanitized
evidence. It always destroys the clone and independently checks absence. The
bundle is written with create-only semantics and contains stable
`evidence/desktop-smoke-v1.json` and `receipts/run.json` entries.

## Machine-local driver boundary

The controller invokes `/usr/local/libexec/nelos-desktop-test-driver`. That executable must be root-owned, executable, and not group- or world-writable. It owns provider-specific clone, network, guest-install, launch, UI, and destruction operations. Each invocation accepts one JSON request on standard input and returns one JSON receipt on standard output.

The driver may select any maintained clean Desktop template. It must create a disposable clone with a separate test account and guest `CODEX_HOME`, install only the requested candidate, report the loaded plugin identity, execute the requested allowlisted scenario, return only sanitized screenshot/diagnostic metadata, destroy the exact clone, and independently attest its absence. Bundle-mode operations reuse stable operation IDs; only an explicitly safe-before-dispatch failure may retry, so a lost model submission is never repeated ambiguously.

Cleanup ambiguity fails the whole run. Raw pixels, prompts, responses, transcripts, credentials, cookies, tokens, sealed values, and environment data are not accepted in the public result.

This lane is intentionally provider-neutral. A Proxmox installation can use an isolated VNet and stable gateway policy behind the driver without making those implementation details part of the Nelos release contract.
