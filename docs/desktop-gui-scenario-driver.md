# Linux Desktop GUI scenario driver

`nelos/desktop-gui-scenario-driver` executes v1 scenarios admitted by the public
`nelos/remote-desktop-contract` boundary. It is intentionally black-box: the
driver sees Desktop only through Linux AT-SPI accessibility observations and
window state. The installed `nelos-desktop-gui-driver` executable uses the
fixed `/usr/libexec/nelos-desktop-atspi` golden-image helper without a shell.

The executable accepts only `--scenario`, `--bindings`, and `--sealed-root`.
Target bindings contain bounded accessibility roles, names, menu paths, keys,
scroll directions, and opaque wait states. Neither scenarios nor bindings can
name a command, script, DOM selector, IPC method, or internal Desktop API.

Benchmark text is staged as `<valueRef>.sealed` beneath the sealed root. Each
reference is one-shot: the file is opened without following symlinks, bounded,
unlinked before typing, and its buffer is zeroed immediately after the AT-SPI
operation. Results contain only action metadata and sanitized observations.

Every scenario creates a task through the GUI and verifies that the returned
task ID was absent beforehand, is present and active afterward, matches the
scenario contract, and has never been used by the driver. Action and scenario
deadlines abort accessibility operations. Errors have stable codes for action
failure, assertion failure, stalls, crashes, and deadline expiry.

Screenshot checkpoints first request protected geometry for both conversation
and credential regions. Capture is refused unless both have valid positive
geometry; accepted regions are supplied as exclusions to the fixed helper.
