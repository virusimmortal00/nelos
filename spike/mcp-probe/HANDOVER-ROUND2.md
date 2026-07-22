# Handover: MCP plugin-packaging spike — round 2

## What round 1 established

Round 1 (see `HANDOVER.md` and its findings) installed this probe plugin
cleanly, but no MCP server appeared in a fresh task. Root cause identified
afterward from the plugin docs: **plugin-bundled MCP servers are disabled by
default**, mirroring the hook trust model — the user must enable each server
in Codex `config.toml` after install. Nothing suggested the manifest or
`.mcp.json` shape was wrong (camelCase `mcpServers`, bare server map, and
plugin-root-relative paths are all confirmed correct as shipped here).

Round 2 repeats the spike **with the servers enabled**, to finally collect the
probe report. Same ground rules: observe and report only; the probe is
read-only and throwaway; do not modify the main repo.

## Steps

1. Reinstall (round 1 cleaned everything up):

   ```bash
   codex plugin marketplace add '<repo>/spike/mcp-probe' --json
   codex plugin add fraktik-mcp-probe@fraktik-mcp-probe --json
   ```

2. Enable both probe servers in Codex `config.toml` (expected at
   `~/.codex/config.toml`; record the actual location):

   ```toml
   [plugins."fraktik-mcp-probe".mcp_servers."probe-args"]
   enabled = true

   [plugins."fraktik-mcp-probe".mcp_servers."probe-command"]
   enabled = true
   ```

   Record verbatim any validation error or warning Codex emits about this
   block (key naming, quoting of hyphenated names, unknown-key complaints).

3. Restart Codex if needed, then start a **fresh task**. Record whether a
   restart was required or a fresh task sufficed (R1).

4. Check which servers are now exposed: `probe-args`, `probe-command`, both,
   or neither. Record any error states and any probe stderr startup lines
   (`[probe:args] started pid=...`) visible in logs (R2).

5. Call `probe_report` from **each** entry that started and copy the full
   JSON verbatim (R3).

6. Approval UX: with only `enabled = true` set, was the `probe_report` call
   gated by a per-call prompt? If cheap, also try setting
   `default_tools_approval_mode` on one server, restart/fresh task, and record
   the accepted values and behavior change (R6).

7. Clean up:

   ```bash
   codex plugin remove fraktik-mcp-probe@fraktik-mcp-probe --json
   codex plugin marketplace remove fraktik-mcp-probe --json
   ```

   Also delete the `[plugins."fraktik-mcp-probe"...]` blocks from
   `config.toml`. Confirm all three in R9.

## Findings template — fill in and return

```markdown
# Probe findings round 2 — <date>, codex version: <codex --version>

## R1 — Enablement mechanics
config.toml location used. Exact TOML block that worked (verbatim, if it
differed from the suggested one). Restart required, or fresh task enough?
Any config validation warnings.

## R2 — Discovery after enablement
Which entries exposed: probe-args / probe-command / both / neither. Error
states, and probe stderr startup lines if logs show them.

## R3 — probe_report JSON (verbatim)
One fenced block per entry that started. Full JSON, unedited.

## R4 — Environment inheritance (from the JSON)
PLUGIN_ROOT / PLUGIN_DATA / CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA set?
CODEX_HOME, HOME, PATH, CODEX_THREAD_ID present and sane? process.cwd?

## R5 — Install layout (from the JSON)
process.selfRealPath — confirm it matches the version-specific cache path
seen in round 1.

## R6 — Approval UX
Per-call prompt with only enabled = true? default_tools_approval_mode values
accepted and observed effect (if tested).

## R7 — Anything unexpected

## R9 — Cleanup confirmed
Plugin removed, marketplace source removed, config blocks deleted: yes/no.
```

## What the findings decide

Same as round 1's closing section, plus one new product fact already settled
by the docs: because enablement is a manual per-user config step, Fraktik's
install instructions will need to include the `enabled = true` block — the
"no manual steps at all" goal becomes "install + one documented config
paste". R1/R6 determine exactly what that documented step must say.
