# ADR: Socket-free MCP tool surface for the marketplace plugin

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
  Codex sessions directory and fails closed on any mismatch.

These are the only CLI commands the installed skill's desktop path invokes;
everything else in that path uses native Codex task tools. Tools that would
contact an app server remain out of scope here and stay behind the
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
  `[plugins."nelos@nelos".mcp_servers."<server>"] enabled = true`. The
  bare plugin key documented upstream is rejected.
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

Every shipped tool is read-only from the host's perspective: the planner and
router are pure functions of their inputs, and verification performs bounded
reads of local rollout metadata (never prompts or transcripts, per
`src/runtime-intelligence-verification.mjs`). The server opens no sockets,
spawns no processes, and writes nothing. Any future tool that mutates state
or reads live host state requires its own permission design and, for live
state, the host contract in [Host-owned Codex control](host-owned-control.md).

## User-visible install contract

Marketplace install plus one documented config paste (the `enabled = true`
block) yields working skill tools; no distribution installer, no `PATH`
changes. The plugin cannot pre-enable its own server — enablement is
deliberately user-owned, mirroring hook trust — so installation documentation
must include the exact block, and diagnostics should recognize the
installed-but-disabled state.
