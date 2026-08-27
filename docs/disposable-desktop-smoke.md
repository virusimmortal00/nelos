# Disposable Desktop smoke lane

The release smoke lane tests one immutable Nelos package on a fresh Codex Desktop clone and then destroys that clone. It deliberately does not bind a maintained template to a Proxmox VMID, historical VM name, per-release golden-image receipt, or one-model-turn budget.

Run the release scenario set with:

```sh
nelos desktop-test --candidate /absolute/path/to/staged-package --scenario-set release
```

The candidate directory must be outside the controller's `CODEX_HOME` and contain coherent `package.json` and `distribution-provenance.json` files. The command recomputes the package digest before any Desktop operation.

## Machine-local driver boundary

The controller invokes `/usr/local/libexec/nelos-desktop-test-driver`. That executable must be root-owned, executable, and not group- or world-writable. It owns provider-specific clone, network, guest-install, launch, UI, and destruction operations. Each invocation accepts one JSON request on standard input and returns one JSON receipt on standard output.

The driver may select any maintained clean Desktop template. It must create a disposable clone with a separate test account and guest `CODEX_HOME`, install only the requested candidate, report the loaded plugin identity, execute the requested allowlisted scenario, return only sanitized screenshot/diagnostic metadata, destroy the exact clone, and independently attest its absence.

Cleanup ambiguity fails the whole run. Raw pixels, prompts, responses, transcripts, credentials, cookies, tokens, sealed values, and environment data are not accepted in the public result.

This lane is intentionally provider-neutral. A Proxmox installation can use an isolated VNet and stable gateway policy behind the driver without making those implementation details part of the Nelos release contract.
