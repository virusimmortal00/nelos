# MCP Execution Map and Future Host Integration

Status: the installed plugin exposes a narrow inline execution-map resource for
planning, dispatch, and spin-off cleanup receipts. Broad live-state UI
integration is not implemented.

## Shipped receipt UI

`nelos_plan_bootstrap`, `nelos_plan_lifecycle`, `nelos_plan_replan`,
`nelos_plan_slices`, `nelos_orchestrate_create`,
`nelos_execution_map_refresh`, `nelos_execution_map_history`, and
`nelos_spinoff_cleanup` advertise the versioned
`ui://nelos/execution-map-v11.html` MCP Apps resource. Successful calls preserve
their existing complete text/JSON result and additionally return
`structuredContent` containing a compact visual projection plus a versioned
`protocol.result` copy of the complete tool result. The latter keeps
`nextAction`, receipts, identifiers, and other continuation fields visible to
modern MCP clients that report only `structuredContent`.

Every protocol-producing tool also publishes an exact per-tool `outputSchema`.
Schemas for tools that return `nextAction` reference the complete discriminated
action union rather than an untyped object. Visual tools correlate
`protocol.tool` with the exact raw result schema nested under
`protocol.result`; nonvisual protocol tools return their complete raw result as
`structuredContent`. The visual projection contains:

- the parent task or objective;
- every non-archived member task in an ordinary receipt;
- lifecycle, exact requested model, and reasoning level;
- planning, planned, authorization-required, launch-pending, created, unknown,
  running, attention, complete, accepted, archiving, archived, or kept status.

The durable projection retains the full roster, but ordinary visual receipts
omit archived members. `nelos_execution_map_history` is the explicit read-only
path for showing the complete persisted roster, including archived members.
This separation keeps archive recoverable and inspectable without making every
later tool call replay the entire history.

Every non-empty canonical status renders as a native disclosure group in the
same deterministic order as the execution-map lifecycle rank. Headings use
sentence-case user labels and exact counts, including `Launch pending`,
`Running`, `Complete`, and `Archive`. A new UI instance starts folded. Compatible
updates within that instance preserve open groups and keyboard focus for
surviving statuses. The user can expand or close each group independently
without another MCP call, or use one compact bulk control to expand active
statuses and collapse the roster again. Receipts containing only terminal
groups offer `Expand all` instead. Expanded groups render compact worker rows:
one line on ordinary desktop widths and a compact title-plus-metadata stack on
narrow widths. Aggregate total, lifecycle, created, and archived counts remain
in `structuredContent` for model and client compatibility, but are intentionally
not rendered separately because the status headings already communicate the
visible roster.
Archived phases and workers use a muted neutral treatment so green remains
reserved for created or completed work. Attention uses an amber review-needed
treatment rather than failure red. Collapsed disclosure markers carry the same
supplemental semantics while the written label remains authoritative. The
widget consumes MCP Apps host theme, font, radius, and safe-area context when
provided, with self-contained light/dark fallbacks. The widget does not render
its own header or global phase because the host card already supplies the tool
title and each rollup supplies its members' status. The global phase remains
available in `structuredContent`.

Lifecycle is shown as neutral metadata using the compact labels `Sub-agent` and
`Spin-off`. Model and reasoning remain visible beside it. Full native task IDs
remain in the document and accessible labels but are visually bounded so they
cannot grow a row. Narrow layouts allow task titles to use two lines, and touch
hosts receive larger disclosure targets without expanding ordinary desktop
rows. Planning, launch-pending, running, and archiving dots pulse subtly while
work is active; the animation is disabled when the host operating system
requests reduced motion.

The replaceable task tree is not itself a live region. A dedicated status node
announces bounded receipt updates without replaying every row, and waiting or
empty states use valid non-list markup. Native `details` and `summary` elements
retain their built-in keyboard interaction.

Tool receipts remain immutable snapshots. After a native wait or result read,
`nelos_execution_map_refresh` checks the exact supplied thread and turn
identities through the app-server bridge and emits a new current-state visual.
A matching completed latest turn renders `complete`; an in-progress turn
renders `running`; unavailable, stale, failed, or mismatched evidence renders
`attention`. The widget never guesses that launch-pending work completed.

The component is self-contained, uses the MCP Apps bridge, loads no remote
resources, and renders only the tool result supplied by the host. It does not
read Desktop state, discover tasks, poll, mutate native state, or treat widget
state as authoritative. Clients that do not support MCP Apps continue to use
the unchanged text/JSON result. The parent objective remains in the structured
data for model context but the compact component does not render it.

The authorization status mirrors the launch gate exactly: an unapproved wave
renders `authorization-required`, while replaying a valid native-host receipt
changes the same planned members to `launch-pending`. The component does not
approve or launch tasks itself.

Cleanup remains host-owned and receipt-driven. Its first map can show
`archiving` while native archive effects are outstanding; replaying the exact
archive receipts removes those workers from subsequent ordinary maps. The
cleanup protocol receipt still reports the exact archive outcome, and the
explicit history tool shows those workers in the `Archive` rollup.

Development verification is layered:

1. `npm test` exercises the execution-map projection, resource contract,
   lifecycle styling hooks, and deterministic fixture data.
2. `npm run verify:mcp-app` uses the official MCP Inspector for
   machine-readable initialization, app-binding, resource, representative-call,
   and invalid-input probes. `npm run inspect:mcp` opens its interactive UI.
3. `npm run verify:mcp-app:host` builds the official MCP Apps `basic-host` at
   the repository-pinned commit and verifies its host, sandbox, and fixture MCP
   endpoints. `npm run dev:mcp-app-ui` keeps that stack running and prints a
   direct link for every meaningful map state.
4. A connected-browser review of those fixtures and a final smoke test in
   Codex cover visual presentation and product-host integration.

`npm run verify:mcp-app:all` runs the Inspector and reference-host lanes
together. The pinned Inspector requires Node.js 22.19 or newer; this does not
change the plugin's Node.js 20 runtime floor.

## Scope: live host state, not tool transport

This gate governs broad **live host state** exposure—turns, lifecycle streams,
dashboards, or general-purpose controls—from the installed plugin. It does not
govern MCP as a transport, the receipt UI above, or the narrowly allowlisted
app-server operations specified in [MCP tool surface](mcp-tool-surface.md).
Those operations expose no prompts, transcripts, or socket endpoint to the
component.

## Host Capability Required

Before a live integration is considered, Codex must broker a host-owned
endpoint to the installed plugin/task context. The minimum contract is:

- a scoped, versioned endpoint descriptor injected for the current plugin/task;
- authenticated peer identity and negotiated read-only capabilities after
  `initialize`;
- current project, thread, and workspace authorization rather than ambient
  access to every local task;
- bounded thread/turn reads and event or refresh semantics suitable for a
  snapshot UI;
- host-owned leases, reconnect behavior, idle shutdown, and endpoint rotation;
- no client-side socket discovery, replacement, daemon startup, or privileged
  lifecycle mutation.

The detailed proposal, trust model, and compatibility descriptor are in
[Host-owned Codex control](host-owned-control.md).

## Future Reintroduction Gate

Consider a future live dashboard or stateful embedded UI only after all of the
following are demonstrated on a fresh Desktop task:

1. Codex injects the descriptor into the plugin process.
2. The plugin verifies the endpoint schema and negotiated read-only capability.
3. The UI receives a bounded, current snapshot of the same native threads shown
   in the Desktop sidebar.
4. Disconnects, endpoint rotation, archived tasks, and denied access render as
   explicit unavailable states rather than stale or invented activity.
5. Process ownership, permissions, and shutdown are explicit and testable.

The earlier live-state prototype was intentionally removed from the source tree
and distributed plugin. Git history retains it for future reference. The
execution map is not a reintroduction of that prototype: it is a pure rendering
of the current tool receipt and has no general-purpose state exposure.
