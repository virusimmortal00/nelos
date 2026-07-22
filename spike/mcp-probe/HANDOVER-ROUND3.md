# Handover: MCP plugin-packaging spike — round 3 (launch-form matrix)

## What round 2 established

With the corrected enablement key (`<plugin>@<marketplace>`), Codex attempted
to launch both probe servers and both failed before tool registration:

- `MCP startup failed: No such file or directory (os error 2)` — consistent
  with executing the literal, unexpanded string `${PLUGIN_ROOT}/server.mjs`
  as the `command`.
- `MCP startup failed: handshaking with MCP server failed: connection closed:
  initialize response` — consistent with `node` exiting immediately on
  `Cannot find module '${PLUGIN_ROOT}/server.mjs'` (unexpanded `args`) — but
  it could also indicate a message-framing mismatch.

Round 3 separates those hypotheses and finds a launch form that works. The
probe now:

- accepts **both** MCP stdio framings (newline-delimited JSON and
  Content-Length headers) and reports which one the host used;
- is declared **five ways** in `.mcp.json`, so one install tests the whole
  matrix. Which subset starts is the finding:

| entry | launch form | what starting proves |
|---|---|---|
| `rel-node` | `node ./server.mjs` | server cwd is the plugin cache root |
| `rel-exec` | `./server.mjs` (shebang) | relative direct-exec + exec bit survive |
| `abs-node` | `node ${PLUGIN_ROOT}/server.mjs` | `${PLUGIN_ROOT}` IS substituted in args (round-2 failure was framing, now tolerated) |
| `shell-env` | `/bin/sh -c 'exec node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}/server.mjs" …'` | env-var-at-runtime and/or cwd fallback works |
| `inline` | `node -e '<self-contained server>'` | protocol/framing works with **no** file paths at all |

If `inline` starts but the file-based entries don't, the failure is path
resolution. If nothing starts including `inline`, the failure is protocol- or
policy-level. Every combination is informative.

All five are read-only; `shell-env` and `inline` also carry an `env` block to
test env passthrough and whether `${PLUGIN_ROOT}` is substituted there.

Same ground rules: observe and report only; do not modify the main repo.

## Steps

1. Reinstall (plugin version is now 0.0.2):

   ```bash
   codex plugin marketplace add '<repo>/spike/mcp-probe' --json
   codex plugin add fraktik-mcp-probe@fraktik-mcp-probe --json
   ```

2. Enable all five servers in `~/.codex/config.toml` using the round-2
   corrected key form:

   ```toml
   [plugins."fraktik-mcp-probe@fraktik-mcp-probe".mcp_servers."rel-node"]
   enabled = true

   [plugins."fraktik-mcp-probe@fraktik-mcp-probe".mcp_servers."rel-exec"]
   enabled = true

   [plugins."fraktik-mcp-probe@fraktik-mcp-probe".mcp_servers."abs-node"]
   enabled = true

   [plugins."fraktik-mcp-probe@fraktik-mcp-probe".mcp_servers."shell-env"]
   enabled = true

   [plugins."fraktik-mcp-probe@fraktik-mcp-probe".mcp_servers."inline"]
   enabled = true
   ```

3. Start a fresh Codex CLI session (same environment where round 2's startup
   failures were logged). For each of the five entries record: exposed and
   callable / startup failure (verbatim message) / silently absent. Capture
   any probe stderr lines — `[probe:<entry>] started pid=…` and
   `[probe:<entry>] framing=…` — and note where those logs live (T2).

4. For **each entry that started**, call its tool (`probe_report`, or
   `probe_inline_report` for `inline`) and copy the full JSON verbatim (T3).

5. Clean up: remove the plugin, the marketplace source, and the five config
   blocks. Confirm in T9.

## Findings template — fill in and return

```markdown
# Probe findings round 3 — <date>, codex version: <codex --version>

## T1 — Config accepted
Any validation warnings on the five-server enable block.

## T2 — Per-entry launch outcome
One line per entry: rel-node / rel-exec / abs-node / shell-env / inline →
callable | startup-failure (verbatim message) | absent. Probe stderr lines
seen (started/framing), and where the logs were found.

## T3 — Tool-call JSON (verbatim)
One fenced block per entry that was callable. Full JSON, unedited.

## T4 — Derived answers (fill from T2/T3)
- Framing Codex uses: newline | headers (from any report's "framing" field)
- Server process cwd: <path> — is it the plugin cache root?
- ${PLUGIN_ROOT} substituted in args? (did abs-node start; markerArgWasExpanded)
- ${PLUGIN_ROOT} substituted in env block? (envValueRaw in shell-env/inline env)
- PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT set as env vars in the server process?
- CODEX_HOME / HOME / PATH present and sane?

## T5 — Install layout
selfRealPath from any file-based entry that started; confirm version-specific
cache path.

## T6 — Approval UX
Per-call prompts observed with enabled = true only?

## T7 — Anything unexpected

## T9 — Cleanup confirmed
Plugin, marketplace source, and config blocks removed: yes/no.
```

## What the findings decide

- T4 determines the launch form for the real `fraktik-mcp` server: prefer
  plain relative (`node ./bin/fraktik-mcp`) if cwd is the plugin root;
  otherwise whichever matrix entry proved reliable.
- The framing answer fixes the transport implementation (the probe's
  dual-framing reader can be carried over wholesale if useful).
- CODEX_HOME/HOME presence decides whether `intelligence verify` session-root
  resolution works unchanged.
- If only `inline` works, path resolution for plugin-bundled files is broken
  in 0.144.6 and the plan needs an upstream issue + version gate before
  Phase 2 proceeds.
