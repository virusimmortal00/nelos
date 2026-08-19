# Proxmox Desktop backend v1

This versioned recipe builds the Ubuntu 24.04 amd64 graphical golden image used
by `nelos/proxmox-desktop-backend`. It is an offline source artifact: nothing in
this directory contacts or mutates Proxmox unless an operator separately runs
Packer with credentials and explicitly reserved template VMIDs.

The immutable package lock binds the base image, QGA, GNOME/GDM graphical
session, signature verifier, and official ChatGPT Desktop Linux preview package
to exact sources, versions, SHA-256 digests, and signature identities. The
Desktop lock pins preview `26.814.41957`, its embedded Codex
`0.148.0-alpha.15`, and the `Codex Linux Repository` OpenPGP fingerprint. The
recipe verifies both the package digest and its debsig origin signature before
installation. The template has QGA and graphical
boot enabled but deliberately has no automation account or benchmark/developer
credentials. The provider adapter creates the locked-down `nelosauto` account
and fresh writable state only on a disposable clone.

The adapter never discovers a free VMID. The caller supplies an owned provider,
host, VMID, golden image, active lease, reservation, and fencing token; all are
compared with fresh provider state before any mutation. Ambiguous operations are
observed once through the provider's reconciliation endpoint and are never
blindly retried. Cleanup is successful only after exact absence is attested;
otherwise the VM is quarantined with all reconciliation identities retained.
