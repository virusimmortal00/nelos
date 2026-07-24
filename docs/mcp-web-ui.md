# Future Host Integration

Status: not implemented; no live-state integration is shipped in the
installed plugin.

Nelos's current product surface is the queen skill, the offline planner
and router, the native Codex task lifecycle, and locally synchronized web
topology. A visual dashboard would otherwise promise live Desktop state that
the plugin cannot safely read on ordinary installations.

## Scope: live host state, not tool transport

This gate governs anything that reads **live host state** — Desktop threads,
turns, or lifecycle — from the installed plugin. It does not govern MCP as a
transport. The plugin ships a bundled MCP server whose tools are strictly
socket-free: three read-only tools (the offline planner, router, and bounded
local runtime-intelligence verification) plus stateful callback-only adapters
that journal native-create intent, refuse blind create replay, and advance
strict title/wait/result observations through host-owned effects. That surface
is specified in [MCP tool surface](mcp-tool-surface.md) and reads no live host
state directly. Any tool that would contact an app server belongs to this gate,
not to that surface.

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

Consider a future MCP server or embedded UI only after all of the following are
demonstrated on a fresh Desktop task:

1. Codex injects the descriptor into the plugin process.
2. The plugin verifies the endpoint schema and negotiated read-only capability.
3. The UI receives a bounded, current snapshot of the same native threads shown
   in the Desktop sidebar.
4. Disconnects, endpoint rotation, archived tasks, and denied access render as
   explicit unavailable states rather than stale or invented activity.
5. The host remains the sole owner of process startup, permissions, and
   shutdown.

The earlier prototype was intentionally removed from the source tree as well
as the distributed plugin. Git history retains it for future reference. The
later socket-free tool surface is not a reintroduction of that prototype: it
exposes no live host state and passes none of the above gates, because it
needs none of them.
