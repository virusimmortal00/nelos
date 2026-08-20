# Nelos Proxmox Linux Desktop recipe v1

This recipe targets an Ubuntu 24.04 Proxmox clone with one non-human account,
`nelosauto`. Run `install-guest.sh` while building the immutable template;
do not run it from a live experiment packet. Pass an immutable Linux Codex
Desktop `.deb` as `NELOS_CODEX_DESKTOP_DEB` and its lowercase digest as
`NELOS_CODEX_DESKTOP_SHA256`. The installer verifies that digest, uses the dated
Ubuntu snapshot in `ubuntu.sources`, and installs GNOME on Xorg, GDM, the AT-SPI
accessibility stack, screenshot tooling, and the bounded Nelos guest helpers.
GDM autologin is enabled only for the automation account and the account is
locked against password/SSH login.

At boot, `nelos-desktop-session.service` waits up to 120 seconds for the exact
graphical user session, imports `DISPLAY`, `XAUTHORITY`, and the accessibility
bus into the user service manager, and writes a root-owned readiness receipt.
The helper independently bounds GUI readiness and capture calls. Device auth
starts with an absent automation `CODEX_HOME`, creates it empty, verifies the
run-scoped model-backed identity, and only then starts the globally enabled
Desktop user service. No developer Codex home or session file is accepted.

Install `../helpers/nelos-proxmox-host-helper.mjs` on the Proxmox node with
`install-host-helper.sh`. The production helpers accept closed JSON envelopes
and compare the exact run, provider, host, VMID, lease, fence, image, automation
user, and state-root binding against root-owned files before any operation.
The host observation staging helper is the only producer path into the sealed
native, ordinary-MCP, visible-Desktop, and archive observation roots; it rejects
stale or identity-mismatched records.
