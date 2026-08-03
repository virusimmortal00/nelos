# ADR: MCP tool surface for the marketplace plugin

Status: accepted July 2026, amended 2026-07-24; launch mechanics and app-server
protocol pinned to behavior observed on `codex-cli 0.144.6`.

## Decision

Ship the plugin's operations as a bundled MCP server so that a marketplace
install is self-sufficient. The MCP surface is authoritative for installed
plugin workflows, including configuration. Even when an agent knows the source
CLI exists, it uses the named MCP tools unless the user is explicitly working
on contributor or automation tasks. The CLI remains a separately installed
developer surface and is never a plugin fallback.

Most MCP operations remain local and socket-free. Deliberately scoped planning
finalization, lifecycle, and thread-control operations use one lazily started,
long-lived
`codex app-server --stdio` child:

- `nelos_plan_bootstrap` — prepares an exact Sol/medium planning launch for an
  unstructured objective, then validates the returned planning envelope on a
  second local call. This remains the stateless compatibility primitive;
- `nelos_plan_lifecycle` — derives a durable bootstrap identity from the queen
  task and caller-stable idempotency key, accepts exact native launch/result
  receipts, resolves the joined planner by agent path, verifies parent topology
  and Sol/medium terminal result-turn metadata, and returns one replay-safe
  next action. Completed planning first returns a wave-bound
  `authorization-required` proposal; only an exact native-host capability and
  task-creation authorization receipt for every member can produce
  `launch-wave`. The resolved internal thread ID is verification evidence, not
  a durable-task control handle.
  Checkpoints persist request/response digests, identities, phases, and receipt
  digests, never raw planner responses;
- `nelos_plan_replan` — reuses the lifecycle only for typed failure, blocking,
  requirements-change, or insufficient-confidence evidence. It permits one
  persisted plan-run generation, requires the supplied base plan to match its
  durable digest, preserves completed slice semantics, and removes them from
  the executable revised plan;
- `nelos_plan_slices` — validates and computes the plan locally. When the plan
  contains at least one spinoff, it requires the explicit queen task ID, reads
  that task, and preserves any
  inbound and outbound web lineage, renders the canonical crown-first
  `👑 WEB_ID · base title`, and verifies the persisted title. Durable spin-offs
  use `🕷️ WEB_ID · base title`. When synchronization is needed it returns a host-owned native title
  effect; a repeated call verifies the persisted title before returning a
  launch-authorization proposal. Legacy outer-crown forms are normalized. A subagent-only plan
  does not start the bridge;
- `nelos_launch_authorize` — consumes the proposal's exact
  `native-authorize-launch` request, bounded capabilities copied from the
  current native host tool registry, and explicit user intent. It
  deterministically produces the receipt that must be replayed through the
  planning tool and never launches work itself;
- `nelos_launch_verify_batch` — performs one all-or-nothing idempotent gate for
  1–16 launched wave members. It binds receipts to a persisted plan-run,
  wave index, digest, and authoritative member contract; resolves subagents
  from parent plus canonical agent path; rejects altered member sets and
  duplicate identities; performs one bounded inventory and topology
  projection; and verifies lifecycle-appropriate identity plus route metadata.
  Joined subagents use agent-path identity with title `not-applicable`; a
  successful gate adopts their verified native thread binding into the durable
  execution web, including as a reconciliation path for older plan runs;
  spinoffs require exact settled native titles. Any member failure prevents
  the downstream wait/read action;
- `nelos_execution_map_refresh` — performs bounded latest-turn reads for 1–16
  exact native thread and turn identities after launch. A matching completed
  turn renders `complete`, an in-progress turn renders `running`, and stale,
  unavailable, or unsuccessful evidence renders `attention`. It returns no
  prompts, previews, result bodies, or transcripts;
- `nelos_thread_inspect` — reads one explicitly identified task and returns
  only bounded identity, title, status, working
  directory, parent, and timestamp fields. It requests no turns and never
  returns previews, prompts, or transcripts;
- `nelos_thread_inventory` — concurrently reads 1–16 unique caller-supplied
  task IDs with four reads maximum in flight, preserves caller order, returns
  bounded per-task failures, and optionally projects only authoritative direct
  parent edges among successful reads;
- `nelos_web_inspect` — composes one read-only, paged view of a persisted web
  from current work-unit bindings, the exact orchestration checkpoint, bounded
  native task status, direct-parent topology, and content-free bridge health.
  It verifies the persisted web/queen identity, caps the execution-state scan
  at 256 directory records, inspects the queen plus at most 15 members per call,
  and returns neither prompts, turns, transcripts, result text, nor filesystem
  paths;
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
  Codex sessions directory and fails closed on any mismatch;
- `nelos_intelligence_resolve_subagent` — resolves one exact native child task
  from bounded parent/agent session metadata before route verification; and
- `nelos_config_get` — returns the effective installed-plugin configuration,
  its source, allowed values, and the exact machine-local TOML path; its first
  call can migrate one exact valid legacy preference into TOML;
- `nelos_config_set` — atomically persists one validated setting to that TOML
  file while preserving unrelated comments, only with explicit user intent;
  and
- `nelos_config_reset` — with explicit user intent, removes one TOML override
  and any legacy preference so the built-in default becomes effective;
- `nelos_orchestrate_create` — a callback-only durable effect adapter. It
  creates one private `WorkUnitSpecV1` execution record, advances its
  deterministic reducer action to `launch-pending`, and returns exactly one
  typed `native-create` effect. An uncertain replay returns a non-creating
  reconciliation effect instead of another create. A later call supplies a
  schema-validated host receipt, binds the returned member thread ID, and
  emits an idempotent title-sync effect; and
- `nelos_orchestrate_advance` — a callback-only observation and join adapter.
  It writes a separate private web checkpoint, validates exact title, wait,
  result, correction-follow-up, and legacy-member repair receipts, and returns
  typed effects. See
  [Durable Host Observation and Parent Join](observation-join.md);
- `nelos_queen_decide` — records one accepted or rejected queen decision only
  for an exact `native-result-read` receipt already consumed by the persisted
  observation checkpoint. It verifies the current work-unit revision, attempt,
  binding generation, member, source turn, result envelope, calling queen, and
  latest successful host turn before the first write. It returns persisted
  provenance and the exact `nelos_orchestrate_advance` call that incorporates
  it. Exact replay is idempotent across restart; the same provenance cannot be
  reused for a different decision;
- `nelos_spinoff_complete` — validates the completion against its exact bound
  durable work unit, persists a bounded completion record, and returns one
  host-owned native send-message effect. A later call validates the exact host
  receipt. An uncertain replay returns a non-sending reconciliation effect
  rather than blindly duplicating a turn; and
- `nelos_spinoff_cleanup` — derives cleanup candidates only from current exact
  queen acceptances with an explicit `archive` capability. Its
  `auto`/`ask`/`keep` setting defaults to `auto` and is snapshotted for the
  whole web when terminal cleanup begins; `ask` previews a named confirmation
  list. It acts only after every required current result is accepted, returns
  host-owned native archive effects, and persists exact receipts per spin-off;
  partial and in-flight outcomes remain visible without replaying an archive.
  Persisting a cleanup choice globally requires explicit user intent. It also
  exposes the execution-map resource: outstanding effects render as
  `archiving`, while accepted native archive receipts render a terminal
  `archived` worker card. Aggregate counts remain available in the structured
  receipt without duplicating the visible worker roster.

Bootstrap preparation, thread inspection, inventory, web inspection, wait,
health, routing, verification, and subagent identity resolution perform
read-only work. Batch launch verification is non-read-only and idempotent
because successful verification adopts joined members into the execution web.
Lifecycle planning, exception replanning,
the bootstrap compatibility tool, and structured planning are annotated
non-read-only and idempotent because they write private checkpoints. Queen
title synchronization is returned as a host-owned effect.
Both orchestration tools and queen decision remain non-read-only and
idempotent: they write private Nelos state but do not perform native host
effects. Completion
delivery persists private state and returns a receipt-bound host wake effect;
cleanup remains declared destructive because its requested native effect
archives tasks. This small bridge exposes no web server, live task dashboard,
transcript surface, or general-purpose app-server proxy. Selected planning,
dispatch, status-refresh, and spin-off cleanup tools expose a self-contained
MCP Apps execution-map resource that renders only their current receipt,
including the authorization-required state before a launch wave becomes
executable, native-turn completion after bounded refresh, and the terminal
archived state after exact native archive receipts are accepted. The widget
performs no app-server reads or native effects; the refresh tool owns its
bounded read before returning the receipt. Every protocol-producing tool
publishes its exact result `outputSchema`. Results containing `nextAction`
expose the complete discriminated action union, and successful nonvisual
protocol calls return the same complete result as model-visible
`structuredContent`.

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
  persisted task when given its explicit task ID;
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
stable `0.144.5` and Desktop `0.144.6`; both are tested. The bridge parses the
version from the initialized server's `userAgent`, rejects stable versions
older than `0.144.5`, and provisionally allows newer stable versions. An
untested version is advisory rather than a startup failure: every response
still passes the same bounded shape validation, so an actual protocol change
fails at the affected operation instead of blocking the whole plugin in
advance.

As additional evidence—not a replacement for the Desktop `0.144.6` evidence
above—the `0.4.0` release gate revalidated isolated npm distributions of
`codex-cli 0.144.5` and `codex-cli 0.144.6` on 2026-07-28. Their generated
initialization, read, name, resume, bounded turn-list, start, steer, archive,
status, and active-flag shapes were identical. Both exact CLI binaries also
completed the two-turn live App Server verifier with confirmed archival and
cleanup.

In a clean plugin MCP environment, the app server identifies itself with the
initialized client name (`nelos_mcp/<version>`); interactive shells may instead
report `Codex Desktop/<version>` or `codex-cli/<version>`. All three reviewed
forms use the same minimum-version and tested-version classification.

Read transport failures receive exactly one reconnect and replay. A second
failure is returned. Mutations are attempted once and are never replayed after
a timeout, disconnect, or malformed response. The health tool exposes only
bounded counters, compatibility state, platform labels, the observed and
minimum versions, the tested-version list, whether the current version was
tested, required methods, and classified failure codes—never raw stderr or task
content. Its legacy `supportedVersions` field mirrors `testedVersions` for
schema-v1 consumers and must not be interpreted as an exhaustive allowlist.

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
prompt and its current task ID. Nelos writes the completion record before
returning one deterministic `native-send-message` effect. The member executes
that effect through `codex_app.send_message_to_thread` and returns the host
tool's exact `{ "threadId": "..." }` result without adding lifecycle or effect
fields. A persisted in-flight state returns only a reconciliation effect, never
another send. Native waiting remains authoritative if a member terminates
before completing the callback cycle.

The same protocol exposes no title compare-and-set field or expected revision.
Queen synchronization therefore performs two preflight title reads, aborts if
they disagree, persists one compatibility web identity and exact queen/member
titles in the plan run, and returns a deterministic host-owned title effect.
A repeat call reuses that identity and verifies the exact result before launch.

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

Thread controls, batch launch verification, routing, verification, and
subagent identity resolution advertise `readOnlyHint: true`. Planning
lifecycle, exception replanning, compatibility bootstrap, and structured
planning advertise `readOnlyHint: false`, `destructiveHint: false`, and
`idempotentHint: true`; they write private digest-only lifecycle state and
return a host-owned title effect when synchronization is needed. A repeat call
must observe that title before launch. Uncertainty fails closed before launch.
Verification reads bounded rollout metadata only.
Orchestration also advertises `readOnlyHint: false`, `destructiveHint: false`,
and `idempotentHint: true`.
Creation writes atomic private execution records through `ExecutionStoreV1`;
observation writes a separate revision-checked web checkpoint.
One work-unit decision is protected by a cross-process state lock so
conflicting callbacks cannot both bind independent store instances.

The server opens no sockets. It starts at most one app-server child on first
inspection, health probe, or required title observation, completes the
experimental API handshake and version check, reuses the child for subsequent
requests, and closes it when MCP stdin ends. Responses and errors are
size-bounded. Protocol failures fail closed.

Native creation remains a host-owned effect: the server returns a deterministic
action ID, and it accepts only an exact receipt containing that action identity
and a bounded member thread ID. Receipt shape, revision, attempt, and action
identity are validated before a state transition. Stale receipts and a second
thread ID for an already bound action fail closed. Current Codex
`create_thread` has no title field. The decorated requested child title is
carried in the launch contract and as a non-authoritative first prompt line,
`Task title: <decorated intended title>`. After binding, the callback adapter
emits a read-only title observation and an idempotent rename effect only on
mismatch.
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

## Queen decision and cleanup sequence

When `nelos_orchestrate_advance` returns `boundary.type: "decide"`, preserve the
exact consumed `native-result-read` receipt. After judging the result against
the slice criteria, call `nelos_queen_decide` with `schemaVersion: 1`, the
current web and queen task IDs, `accepted | rejected`, a bounded summary, and
that receipt. Execute the returned `nelos_orchestrate_advance` call unchanged.
The bundled STDIO MCP process is long-lived and has no documented per-call
Codex task identity, so this adapter does not treat its launch-time
`CODEX_THREAD_ID` as caller authorization. Queen ownership is instead checked
against the persisted web/work-unit binding and the exact consumed current
result; the skill keeps the decision call on the queen side of the workflow.
Only an accepted exact-current decision changes the member coordination state
to `accepted`. When all required current results are accepted, that observation
returns a machine-generated `cleanup-spinoffs` next action containing the exact
`nelos_spinoff_cleanup` call. The cleanup adapter snapshots the configured
policy for that web when cleanup begins; the built-in default is `auto`, and
`ask` returns an exact confirmation list. A later global change applies to
future webs. Missing,
rejected, stale, mismatched, failed, blocked, or cross-queen evidence remains
cleanup `not-ready` and yields no archive effect.

A rejected exact-current decision changes the member to
`correction-pending`. The next advance returns one turn-bound
`native-follow-up` effect for the same task and the next attempt. After the host
delivers it, submit the exact `native-follow-up-delivered` receipt to advance;
Nelos durably increments the attempt before emitting a new wait/read sequence.
The corrected turn therefore receives a fresh `native-result-read` action ID
and can be accepted normally after restart. Reading the Codex task directly
still does not create acceptable queen-decision provenance. If follow-up is
unavailable or the attempt budget is exhausted, rejection instead surfaces
attention and does not advertise an unusable correction effect.

New required result-bearing registrations without `read-result` are rejected.
For a legacy persisted required observe-only member, advance returns the member
ID, missing capability, supported `detach` action, and an exact
`orchestration-repair-member` action boundary. The shipped task-management
skill submits its exact idempotent receipt, which reclassifies the
execution as non-required and records the repair without changing accepted
results.

## User-visible install contract

Marketplace install plus one documented config paste (the `enabled = true`
block) yields working skill tools; no distribution installer, no `PATH`
changes. The plugin cannot pre-enable its own server — enablement is
deliberately user-owned, mirroring hook trust — so installation documentation
must include the exact block, and diagnostics should recognize the
installed-but-disabled state.
