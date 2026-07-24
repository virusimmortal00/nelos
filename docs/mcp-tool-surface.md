# ADR: MCP tool surface for the marketplace plugin

Status: accepted July 2026, amended 2026-07-24; launch mechanics and app-server
protocol pinned to behavior observed on `codex-cli 0.144.6`.

## Decision

Ship the plugin's CLI-backed operations as a bundled MCP server so that a
marketplace install is self-sufficient. The skill calls named tools instead of
a `nelos` shell command; the CLI remains a developer and automation surface
installed separately via the distribution installer.

Most MCP operations remain local and socket-free. Deliberately scoped
operations use one lazily started, long-lived
`codex app-server --stdio` child:

- `nelos_plan_slices` — validates and computes the plan locally. When the plan
  contains at least one spinoff, it reads the current task, preserves any
  inbound and outbound web markers, renders the canonical
  `[🕸️ inbound] [🕷️ outbound] [👑] · base title`, and verifies the persisted
  title before returning a launch action. Legacy outer-crown forms are
  normalized. A subagent-only plan does not start the bridge;
- `nelos_thread_inspect` — reads one task by ID (defaulting to the current
  `CODEX_THREAD_ID`) and returns only bounded identity, title, status, working
  directory, parent, and timestamp fields. It requests no turns and never
  returns previews, prompts, or transcripts;
- `nelos_thread_inventory` — concurrently reads 1–16 unique caller-supplied
  task IDs with four reads maximum in flight, preserves caller order, returns
  bounded per-task failures, and optionally projects only authoritative direct
  parent edges among successful reads;
- `nelos_thread_wait` — polls current state for 1–8 known tasks for at most 30
  seconds total. `timeoutMs` controls the change-poll window; an initial
  inspection may use up to five seconds of bounded I/O allowance, while the
  whole call remains capped at 30 seconds. Deterministic Nelos snapshot cursors
  suppress unchanged snapshots; attention flags or any changed snapshot wake
  the call. Wait calls run beside later MCP requests, so they do not block
  ping, health, or unrelated tools; wait calls themselves are serialized so
  their per-call read bounds cannot multiply without limit;
- `nelos_app_server_health` — reports content-free compatibility, version,
  connection, batch, poll, retry, and mutation-attempt telemetry. With
  `probe: true`, it performs only the initialization handshake;
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
  [Durable Host Observation and Parent Join](observation-join.md);
- `nelos_spinoff_complete` — validates the calling task against its exact bound
  durable work unit, persists a bounded completion record, and delivers one
  idempotent queen wake. It reconciles the stable client message ID first,
  steers a known active queen turn, or resumes and starts an idle queen turn.
  Deferred delivery receives bounded retries and remains safely callable by the
  member with the same identity. Ambiguous mutations stop in `attention` rather
  than blindly duplicating a turn; and
- `nelos_spinoff_cleanup` — derives cleanup candidates only from current exact
  queen acceptances with an explicit `archive` capability. It previews a named
  confirmation list under the default `ask` policy, or applies remembered
  `auto` and `keep` policies only after every required current result is
  accepted. Native archive receipts are persisted per spin-off; partial and
  in-flight outcomes remain visible without replaying an archive.

Thread inspection, routing, and verification are explicitly read-only. Planning
is non-read-only and idempotent because a spinoff plan may synchronize the queen
title. Both orchestration tools remain non-read-only and idempotent: they write
private Nelos state but do not themselves perform native host effects.
Completion delivery is a non-destructive idempotent mutation; cleanup is
declared destructive because it archives native tasks. This
small bridge does not restore the retired MCP/UI prototype; it exposes no web
server, task dashboard, transcript surface, or general-purpose app-server
proxy.

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

Additional app-server behavior was verified on 2026-07-24:

- the Codex desktop app runs its own `app-server` child over private pipes;
- a separately started `codex app-server --stdio` process can read the same
  persisted task identified by `CODEX_THREAD_ID`;
- the generated protocol schema exposes the reviewed read, title, resume,
  turn-list, turn-start, turn-steer, and archive methods used by the bridge; and
- the separate process shares persisted Codex task state, but does not attach
  to or reuse the desktop app's private transport.

## Experimental protocol compatibility

Codex does not currently advertise an app-server method list during
initialization. Nelos therefore treats the checked-in compact fixture generated
by `codex app-server generate-json-schema --experimental` as the capability
attestation. The relevant initialization, `thread/read`, `thread/name/set`,
`thread/resume`, `thread/turns/list`, `turn/start`, `turn/steer`,
`thread/archive`, thread-status, and active-flag shapes are identical in public
stable `0.144.5` and Desktop `0.144.6`; both are supported. The bridge parses
the version from the initialized server's `userAgent` and rejects unknown
versions before any thread operation.

Read transport failures receive exactly one reconnect and replay. A second
failure is returned. Mutations are attempted once and are never replayed after
a timeout, disconnect, or malformed response. The health tool exposes only
bounded counters, compatibility state, platform labels, version, required
methods, and classified failure codes—never raw stderr or task content.

Codex `0.144.x` has no native wait method, notification cursor, sequence,
replay token, or catch-up request. `nelos_thread_wait` therefore polls
`thread/read`; its `snapshot-v1:` cursor is a hash of the allowlisted current
status, flags, and update timestamp. It cannot prove that an intermediate state
was never missed, and `idle` is quiescence—not successful completion or result
provenance. A deadline-limited read is canceled locally and any later response
is ignored; this does not terminate the shared app-server connection or block
other MCP requests. Result collection continues through the durable
observation/join contract.

Parent wake delivery is an application-level completion callback rather than a
native subscription. Before returning its final result, a durable spin-off
calls `nelos_spinoff_complete` using the fixed identity embedded in its launch
prompt and its current `CODEX_THREAD_ID`. Nelos writes the completion record
before app-server mutation. It reads at most 20 recent turns solely to reconcile
the deterministic `clientUserMessageId`; message content is neither retained
nor returned. If the server reports older pages, Nelos records attention rather
than concluding a previously attempted wake was absent and risking a duplicate.
A persisted pre-mutation `delivering` state distinguishes that crash-recovery
case from a fresh wake, which may proceed despite older pages. A known active
queen receives `turn/steer` with its exact active turn ID. An idle or unloaded
queen receives `thread/resume` as needed, followed by `turn/start`. This covers
both a live join and an already-ended queen without installing a background
daemon. Native waiting remains authoritative if a member terminates before
executing its callback.

The same protocol exposes no title compare-and-set field or expected revision.
Queen synchronization therefore performs two preflight title reads, aborts if
they disagree, canonically orders the inbound, outbound, and crown markers
without discarding web lineage, writes once, and verifies the result. Nelos
serializes its own non-wait MCP operations, but it cannot make an independent
manual Desktop rename atomic with that write. Operators must not manually
rename the current task during this short synchronization window; adding true
concurrent-writer safety is explicitly gated on a future versioned CAS or
revision precondition.

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

Thread inspection, routing, and verification advertise `readOnlyHint: true`.
Planning advertises `readOnlyHint: false`, `destructiveHint: false`, and
`idempotentHint: true`; its sole host mutation is `thread/name/set` for the
current queen title. Validation completes before that mutation, and any read,
rename, or verification uncertainty fails closed before a launch action is
returned. Verification performs bounded reads of local rollout metadata (never
prompts or transcripts, per `src/runtime-intelligence-verification.mjs`).
Orchestration advertises `readOnlyHint: false`, `destructiveHint: false`, and
`idempotentHint: true`.
Creation writes atomic private execution records through `ExecutionStoreV1`;
observation writes a separate revision-checked web checkpoint.
One work-unit decision is protected by a cross-process state lock so
conflicting callbacks cannot both bind independent store instances.

The server opens no sockets. It starts at most one app-server child on first
inspection, health probe, or required title synchronization, completes the
experimental API handshake and version check, reuses the child for subsequent
requests, and closes it when MCP stdin ends. Responses and errors are
size-bounded. Protocol failures fail closed.

Native creation remains a host-owned effect: the server returns a deterministic
action ID, and it accepts only an exact receipt containing that action identity
and a bounded member thread ID. Receipt shape, revision, attempt, and action
identity are validated before a state transition. Stale receipts and a second
thread ID for an already bound action fail closed. The requested child title is
carried undecorated in a complete launch prompt whose first line is
`Task title: <short intended title>`. After binding, the callback adapter emits
a read-only title observation and an idempotent rename effect only on mismatch.
It also advances opaque wait cursors, validates current-turn result provenance,
and returns a deterministic parent boundary.

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
