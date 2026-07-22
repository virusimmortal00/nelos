# Handover: MCP plugin-packaging spike (Phase 0)

## Context — read first

Fraktik (this repo) currently ships a Codex marketplace plugin that declares
only a skill. The skill tells the host to run the `fraktik` CLI, but a
marketplace install never puts `fraktik` on `PATH`, so first-time installs are
broken unless the separate distribution installer was also run. The planned fix
is to make the plugin MCP-backed: declare an `mcpServers` component in
`.codex-plugin/plugin.json` and have the skill call tools instead of a shell
command.

Before building that, this spike verifies the host behaviors the design
depends on. **Your job is only to install the probe plugin in this directory,
call its one tool, observe, and fill in the findings template below.** Do not
fix, redesign, or modify anything in the main repo; the probe is intentionally
throwaway.

The probe is a ~170-line read-only MCP server (`server.mjs`). It writes
nothing, opens no sockets, and reads only its own marker file. `.mcp.json`
declares it twice on purpose:

- `probe-args` — `command: "node"`, with `${PLUGIN_ROOT}` used inside `args`
  and inside the `env` block.
- `probe-command` — `command: "${PLUGIN_ROOT}/server.mjs"` directly (tests
  expansion in the `command` field plus executable-bit/shebang survival
  through the plugin cache).

If only one of the two starts, that by itself is a finding.

## Steps

1. Add this directory as a local marketplace source and install the plugin:

   ```bash
   codex plugin marketplace add <absolute-path-to>/spike/mcp-probe
   codex plugin add fraktik-mcp-probe@fraktik-mcp-probe
   ```

   If the CLI form for a local path differs, use whatever the current Codex
   supports (app UI is fine). Record the exact working command in F0.

2. Start a **fresh Codex task** (tool discovery happens at session start).

3. Observe which MCP servers/tools are available. Record whether
   `probe_report` appears once, twice (both entries), or not at all — and
   whether either server shows an error state.

4. Call `probe_report` (from each entry that started). It returns a JSON
   report. **Copy the full JSON verbatim into the findings** — do not
   summarize or paraphrase it.

5. Note the approval UX: did calling the tool require a per-call approval
   prompt? Check the plugin's server policy config surface
   (`plugins.fraktik-mcp-probe.mcp_servers.<server>` or equivalent) and record
   what modes exist and what the default was.

6. Optional (only if cheap to do safely): observe the failure surface when the
   server cannot start — e.g. temporarily point one entry's `command` at a
   nonexistent binary, reinstall, and record what the user sees. Restore the
   file afterward. Skip this step rather than doing anything invasive to the
   real `node` install.

7. Clean up: uninstall `fraktik-mcp-probe` and remove the marketplace source.
   Confirm removal in F9.

## Findings template — fill in and return everything below

```markdown
# Probe findings — <date>, codex version: <output of codex --version>

## F0 — Install path
Exact commands/UI steps that worked to add the local marketplace source and
install the plugin. Anything that failed first.

## F1 — Auto-start and discovery
Did plugin MCP servers start automatically on a fresh task? Which entries were
visible: probe-args / probe-command / neither? Any error states shown, and
where (UI, logs, config)? If logs exist, paste the probe's stderr startup
line(s), which look like: [probe:args] started pid=...

## F2 — probe_report JSON (verbatim)
One fenced block per entry that started. Full JSON, unedited.

## F3 — ${PLUGIN_ROOT} expansion
From the report(s):
- args: expansion.markerArgWasExpanded and expansion.markerFileExists
- env block: expansion.envValueWasExpanded, and PROBE_STATIC_ENV present?
- command field: did probe-command start at all?

## F4 — Environment inheritance
From env in the report(s): are PLUGIN_ROOT / PLUGIN_DATA /
CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA set as process env vars? Are
CODEX_HOME, HOME, PATH, CODEX_THREAD_ID present and sane? What is
process.cwd?

## F5 — Install layout
From process.selfRealPath: where does the plugin cache live? Is the path
version- or hash-specific (i.e. would it change on plugin upgrade)?

## F6 — Approval UX
Was probe_report gated by a per-call approval prompt? What per-server policy
settings exist and what were the defaults?

## F7 — Failure surface (optional, step 6)
What does the user see when a declared server fails to launch?

## F8 — Anything unexpected
Deviations from the docs, warnings, version notes, sharp edges.

## F9 — Cleanup confirmed
Plugin uninstalled and marketplace source removed: yes/no.
```

## What the findings decide (for the return trip)

- F3 (args + env expansion) → whether the real server is launched as
  `node ${PLUGIN_ROOT}/bin/fraktik-mcp` and how it can be parameterized.
- F3 (command expansion) + F1 → whether direct-exec/shebang is viable instead.
- F4 (`CODEX_HOME` inheritance) → whether `fraktik intelligence verify`'s
  sessions-root resolution works unchanged inside the MCP server or needs an
  explicit strategy.
- F5 → confirms no absolute/cache-version paths may be baked anywhere.
- F6 → whether the skill flow needs a documented approval-policy
  recommendation to avoid a prompt per plan/verify call.
