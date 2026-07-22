# Draft upstream issue — file against the Codex CLI / plugin runtime

> Suggested title: **Plugin-bundled MCP servers cannot locate their own files:
> `${PLUGIN_ROOT}` is never substituted, no `PLUGIN_ROOT` env is set, and cwd
> is the task workspace**

## Summary

The plugin docs (learn.chatgpt.com/docs/build-plugins) document an
`mcpServers` manifest component and show `${PLUGIN_ROOT}` being used to
reference files bundled inside the plugin. In `codex-cli 0.144.6`
(macOS, aarch64), a plugin-bundled MCP server has **no working way to
reference its own bundled files**:

1. `${PLUGIN_ROOT}` is not substituted in `.mcp.json` — not in `command`, not
   in `args`, and not in `env` values (an `env` value of `"${PLUGIN_ROOT}"`
   arrives in the server process as the literal string `${PLUGIN_ROOT}`).
2. The server process environment contains no `PLUGIN_ROOT`, `PLUGIN_DATA`,
   `CLAUDE_PLUGIN_ROOT`, or `CLAUDE_PLUGIN_DATA` (the variables the docs say
   plugin hook commands receive).
3. The server's working directory is the **active task workspace**, not the
   plugin cache root, so plugin-relative paths do not resolve either.

Net effect: every launch form that references a bundled file fails at startup,
and the only server that can run is one passed entirely inline
(`command: "node"`, `args: ["-e", "<code>"]`). MCP protocol handling itself is
fine — the inline server completes `initialize`/`tools/list`/`tools/call` over
newline-delimited stdio JSON and its tool is callable from a task.

## Reproduction

A minimal probe plugin is attached (this directory): a dependency-free
~200-line stdio MCP server (`server.mjs`) declared five ways in `.mcp.json`
to cover each plausible launch form.

```bash
codex plugin marketplace add <path-to>/mcp-probe
codex plugin add fraktik-mcp-probe@fraktik-mcp-probe
```

Enable the servers in `~/.codex/config.toml` (note: the key requires the
`@<marketplace>` suffix; the docs' bare `plugins.<plugin>` form is rejected
with `invalid plugin key … expected <plugin>@<marketplace>`):

```toml
[plugins."fraktik-mcp-probe@fraktik-mcp-probe".mcp_servers."rel-node"]
enabled = true
# … same for rel-exec, abs-node, shell-env, inline
```

Then start a fresh `codex exec` session and observe startup logs.

## Observed (codex-cli 0.144.6, 2026-07-22)

| `.mcp.json` entry | launch form | result |
|---|---|---|
| `abs-node` | `node ${PLUGIN_ROOT}/server.mjs` | `MCP startup failed: handshaking with MCP server failed: connection closed: initialize response` (node exits on `Cannot find module '${PLUGIN_ROOT}/server.mjs'` — literal, unsubstituted) |
| `rel-node` | `node ./server.mjs` | same handshake failure (`./` resolves against the task workspace, not the plugin root) |
| `rel-exec` | `command: "./server.mjs"` | `MCP startup failed: No such file or directory (os error 2)` |
| `shell-env` | `/bin/sh -c 'exec node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}/server.mjs" …'` | same handshake failure (neither variable set; cwd fallback lands in the workspace) |
| `inline` | `node -e '<self-contained server>'` | **works**; its report shows cwd = task workspace, no `*PLUGIN*` env vars, and the literal `${PLUGIN_ROOT}` delivered through the `env` block |

Verbatim report from the inline server, and full per-round findings, are in
the probe's findings records.

Also verified: the plugin cache itself is populated correctly
(`~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, executable
permissions preserved), so this is purely a launch-context gap.

## Expected

Any one of the following would make bundled servers viable (in preference
order):

1. Substitute `${PLUGIN_ROOT}` (and ideally `${PLUGIN_DATA}`) in `.mcp.json`
   `command`, `args`, and `env` values, as the docs imply.
2. Set `PLUGIN_ROOT`/`PLUGIN_DATA` in the server process environment, as is
   documented for hook commands.
3. Launch bundled servers with cwd = plugin root (least preferred; changes
   observable behavior for servers that want the workspace).

## Docs issues to fix alongside

- The config key for enabling a bundled server requires the marketplace
  suffix: `plugins."<plugin>@<marketplace>".mcp_servers."<server>"`. The docs
  show the bare plugin name.
- If `${PLUGIN_ROOT}` substitution is intentionally unsupported for
  `mcpServers` (vs hooks), the docs should say so explicitly and document the
  supported way for a bundled server to find its files.

## Environment

- `codex-cli 0.144.6`, standalone release `0.144.6-aarch64-apple-darwin`
- macOS (Darwin 25.5.0), Node v24.18.0 (Homebrew `node@24`)
- Plugin installed from a local Git marketplace source
