# ADR: MCP tool surface for the marketplace plugin

Status: accepted July 2026; launch mechanics pinned to behavior observed on
`codex-cli 0.144.6`.

## Decision

Ship the plugin's CLI-backed operations as a bundled MCP server so that a
marketplace install is self-sufficient. The skill calls named tools instead of
a `nelos` shell command; the CLI remains a developer and automation surface
installed separately via the distribution installer.

The MCP surface is limited to **socket-free** operations — commands that never
open an app-server control endpoint:

- `nelos_plan_slices` — the offline slice planner (pure computation);
- `nelos_intelligence_route` — the offline model/reasoning router (pure
  computation);
- `nelos_intelligence_verify` — runtime-intelligence verification, which
  reads only bounded turn-context metadata from local rollout files under the
  Codex sessions directory and fails closed on any mismatch; and
- `nelos_orchestrate_create` — a callback-only durable effect adapter. It
  creates one private `WorkUnitSpecV1` execution record, advances its
  deterministic reducer action to `launch-pending`, and returns exactly one
  typed `native-create` effect. An uncertain replay returns a non-creating
  reconciliation effect instead of another create. A later call supplies a
  schema-validated host receipt, binds the returned member thread ID, and
  emits an idempotent title-sync effect; and
- `nelos_orchestrate_advance` — a callback-only observation and join adapter.
  It writes a separate private web checkpoint, validates exact title, wait,
  and result receipts, and returns typed host-owned effects. See
  [Durable Host Observation and Parent Join](observation-join.md).

The original three tools remain explicitly read-only. Both orchestration tools
are explicitly non-read-only and idempotent: they write private Nelos state
but do not themselves perform native host effects. Tools that would contact
an app server remain out of scope here and stay behind the
reintroduction gate in [Future Host Integration](mcp-web-ui.md). This ADR does
not reverse the earlier removal of the MCP/UI prototype: that removal retired
a live-state surface the plugin could not safely read; this surface reads no
live host state at all.

## Why not the alternatives

- **A skill that locates the CLI inside the plugin cache** depends on the same
  undocumented cache layout as the bootstrap below, but spreads the dependency
  across prose the model must follow instead of one testable shim, and breaks
  on every plugin upgrade path change.
- **A hook that provisions PATH launchers at install** sits behind the same
  disabled-by-default trust gate as MCP servers, so it saves no user steps and
  adds a mutation surface.
- **Requiring `npm run install:distribution`** is the status quo this work
  removes for skill users.

## Verified host behavior (codex-cli 0.144.6, observed 2026-07-22)

Established empirically with a minimal probe plugin (three installation
rounds; repro and findings preserved with the draft upstream issue):

- `mcpServers: "./.mcp.json"` in `.codex-plugin/plugin.json` is recognized;
  paths resolve from the plugin root.
- Bundled servers are **disabled by default**. Enabling requires a
  `~/.codex/config.toml` block keyed by plugin *and* marketplace:
  `[plugins."nelos@nelos-marketplace".mcp_servers."<server>"] enabled = true`.
  The bare plugin key documented upstream is rejected.
- `${PLUGIN_ROOT}` is **not substituted anywhere** in `.mcp.json` (`command`,
  `args`, or `env` values pass through literally), and the server process
  receives no `PLUGIN_ROOT`/`PLUGIN_DATA`/`CLAUDE_PLUGIN_ROOT`/
  `CLAUDE_PLUGIN_DATA` environment variables, contrary to the plugin docs.
- The server's working directory is the **active task workspace**, not the
  plugin cache root, so plugin-relative paths do not resolve either.
- Transport is **newline-delimited JSON** over stdio; `initialize`,
  `tools/list`, and `tools/call` behave normally once a process starts.
- `.mcp.json` `env` blocks deliver **static values** faithfully.
- `command: "node"` with `args: ["-e", "<code>"]` launches successfully.
- The plugin cache lives at
  `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` with executable
  permissions preserved; the path is version-specific.
- `HOME` and `PATH` are present and sane; `CODEX_HOME` is absent, so sessions
  resolution uses the conventional `~/.codex` fallback.

## Launch mechanism: inline self-locating bootstrap

Because no supported mechanism lets a bundled server reference its own files,
`.mcp.json` launches `node -e` with a small generated bootstrap that:

1. reads the release version from a static `env` value baked into `.mcp.json`
   at generation time (checked against the plugin manifest by tests);
2. resolves `~/.codex/plugins/cache/*/nelos/<version>/` — the marketplace
   segment is globbed so a differently named marketplace source cannot break
   resolution — and fails with a structured, actionable stderr diagnostic if
   no match contains the server module;
3. dynamically imports the real server module from the resolved cache
   directory and starts it.

The bootstrap is the only component that depends on the undocumented cache
layout, and it is quarantined on purpose: the server itself is an ordinary
module, launched identically by `bin/nelos-mcp` for development and tests.

**Retirement condition:** when a Codex release substitutes `${PLUGIN_ROOT}`
in `.mcp.json` (or injects an equivalent environment variable), replace the
inline bootstrap with the documented direct launch form. No server changes
are required. The gap is reported upstream; the draft issue accompanies the
probe repro.

## Trust model

The planner, router, and verifier advertise `readOnlyHint: true`; verification
performs bounded reads of local rollout metadata (never prompts or transcripts,
per `src/runtime-intelligence-verification.mjs`). Orchestration advertises
`readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: true`.
Creation writes atomic private execution records through `ExecutionStoreV1`;
observation writes a separate revision-checked web checkpoint.
One work-unit decision is protected by a cross-process state lock so
conflicting callbacks cannot both bind independent store instances.

The server opens no sockets and spawns no processes. Native creation remains a
host-owned effect: the server returns a deterministic action ID, and it accepts
only an exact receipt containing that action identity and a bounded member
thread ID. Receipt shape, revision, attempt, and action identity are validated
before a state transition. Stale receipts and a second thread ID for an already
bound action fail closed. The requested title is carried in a complete launch
prompt whose first line is `Task title: <short intended title>`. After binding,
the adapter emits a read-only title observation. The observation adapter emits
a rename only when that native title differs, advances opaque wait cursors,
validates current-turn result
provenance, and returns a deterministic parent boundary. App-server transport
remains outside this surface.

## Callback contract

Call `nelos_orchestrate_create` with an unbound work-unit definition and an
explicit `null` receipt. The result persists `launch-pending` and contains one
effect shaped as:

```json
{
  "schemaVersion": 1,
  "actionId": "web-orchestration-v1/member-a/revision-1/attempt-1/launch",
  "type": "native-create",
  "scope": "work-unit",
  "workUnitId": "member-a",
  "specRevision": 1,
  "attempt": 1,
  "title": "Member A",
  "prompt": "Task title: Member A\n\nOwn only this slice: ...",
  "preconditions": {
    "expectedSpecRevision": 1,
    "expectedBindingState": "unbound",
    "expectedMemberThreadId": null,
    "expectedSourceTurnId": null
  }
}
```

If that response may have been lost, replaying the null-receipt call returns
`native-reconcile-create`, whose policy forbids another create until the host
inventory proves absence and explicitly returns attention. It never blindly
re-emits `native-create`.

After the host performs that effect, call the same tool with the same work-unit
definition and this receipt:

```json
{
  "schemaVersion": 1,
  "actionId": "web-orchestration-v1/member-a/revision-1/attempt-1/launch",
  "type": "native-create",
  "workUnitId": "member-a",
  "specRevision": 1,
  "attempt": 1,
  "memberThreadId": "returned-host-thread-id"
}
```

The bound result emits a stable `native-read-title` effect for the returned
thread and exact requested title. Submit its `native-title-observed` receipt to
`nelos_orchestrate_advance`. An exact match verifies without mutation; a
mismatch produces a bounded, idempotent `native-set-title` fallback. Replaying
the bound phase re-emits only the same read effect. The adapter never interprets
a receipt as authorization for a second create.

## User-visible install contract

Marketplace install plus one documented config paste (the `enabled = true`
block) yields working skill tools; no distribution installer, no `PATH`
changes. The plugin cannot pre-enable its own server — enablement is
deliberately user-owned, mirroring hook trust — so installation documentation
must include the exact block, and diagnostics should recognize the
installed-but-disabled state.
