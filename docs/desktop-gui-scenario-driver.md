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
operation. Results contain only action metadata and sanitized observations. A
production composition declares each exact path without a value, digest, or
observed length. Before launch, `nelos-prepare-production-run
--require-sealed-values` requires the complete unique set to be caller-owned,
single-link, canonical, nonempty, at most 1 MiB, and exactly mode `0400`; it
checks metadata only and never opens the value bytes.

Production composition seals only a deterministic, run- and fence-bound empty
task slot and creation intent; it does not create a task in the controller's
Codex store. After isolated guest device authentication, a fixed QGA helper
starts the pinned guest app-server with `/home/nelosauto/.codex` and
`/home/nelosauto/workspace`, proves the store inventory was empty, creates
exactly one task without a turn, titles and reads it back, and commits an
immutable receipt before any model-submit action. The runner atomically replaces
the admitted slot with that receipt's real task ID. Recovery adopts only the
sole empty task added after the immutable pre-inventory receipt and never assumes
controller/guest cloud synchronization. The driver then requires AT-SPI to see
the same receipt-bound ID and title. Action and scenario deadlines abort
accessibility and three-surface observation operations. Errors have stable codes
for action failure, assertion failure, surface disagreement, stalls, crashes,
and deadline expiry.

Active and terminal checkpoints compare identity and title across the native
app-server, the packaged Nelos MCP worker, and the visible AT-SPI task row in
that same guest. Both producer observers are invoked through the fixed QGA
helper under the automation user's exact `HOME` and `CODEX_HOME`; controller
stores are not accepted as a substitute. The same bounded MCP worker performs
`nelos_thread_inspect` and
`nelos_runtime_health`; its PID must appear in the single healthy runtime
generation. A freshly spawned app-server or MCP worker reports its own
process-local `Thread.status` load state, which may legitimately be `notLoaded` while the
Desktop process is running the task; those independent load states are retained
as diagnostics but are never compared to infer lifecycle. `systemError` and any
explicit approval/input attention flag still fail closed. Active lifecycle is
proved by the selected Desktop row's distinct running indicator immediately
after the exact Enter action. Terminal lifecycle requires a real completed
latest native turn and a complete Desktop scan proving no running, approval, or
input indicator remains. A disagreement is a failed scenario, not a successful
run.

Scenario screenshot checkpoints require exactly one conversation geometry and
a closed, complete inventory of visible credential geometries. Their bytes are
zeroed after producing a digest and are not exported. Production evidence and
task/archive review images use the stronger atomic capture boundary: a complete
10,000-node AT-SPI scan, a full-frame-black base, and an allowlist containing
only the exact expected test task's title and lifecycle/status geometry. No raw
frame is written to disk. Text status geometry is eligible only when the
component's complete accessible text canonicalizes exactly to one finite UI
indicator; a substring inside row, title, prompt, or preview text is rejected.
The filtered PNG and a sanitized mismatch diagnostic are retained before
comparison so a visual regression can be reviewed even
though the disposable VM is quarantined; ambiguous classification or unrelated
task geometry rejects the capture.
