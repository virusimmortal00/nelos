# Future Host Integration

Status: broad live-state UI integration is not implemented. The installed
plugin has only bounded task inspection/polling, direct-parent projection, and
queen-title synchronization described in
[MCP tool surface](mcp-tool-surface.md).

Nelos's current product surface is the queen skill, the offline planner
and router, the native Codex task lifecycle, and locally synchronized web
topology. A visual dashboard would otherwise promise live Desktop state that
the plugin cannot safely read on ordinary installations.

## Scope: live host state, not tool transport

This gate governs broad **live host state** exposure—turns, lifecycle streams,
dashboards, or general-purpose controls—from the installed plugin. It does not
govern MCP as a transport or the narrowly allowlisted app-server operations
already specified in [MCP tool surface](mcp-tool-surface.md). Those operations
read bounded task metadata and synchronize one current-task title; they expose
no turns, prompts, transcripts, socket endpoint, or UI.

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
5. Process ownership, permissions, and shutdown are explicit and testable.

The earlier prototype was intentionally removed from the source tree as well
as the distributed plugin. Git history retains it for future reference. The
later bounded tool surface is not a reintroduction of that prototype: it has no
UI or general-purpose state exposure and is governed by its own narrow allowlist
and fail-closed contract.
