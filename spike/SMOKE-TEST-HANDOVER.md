# Handover: live smoke test of the Fraktik MCP tool surface (v0.2.0)

## Context

PR #5 (merged to `main`) makes the Fraktik marketplace plugin ship a bundled,
socket-free MCP server so installs no longer depend on the `fraktik` CLI
being on PATH. Design and verified host facts: `docs/mcp-tool-surface.md`.
The launch form is an inline self-locating bootstrap (the host substitutes no
`${PLUGIN_ROOT}`), so this smoke test is the first end-to-end validation on a
real marketplace install.

**Scope: test the tools directly.** The bundled skill still references the
`fraktik` CLI (its migration to these tools is a follow-up PR), so do not
drive this through the skill — call the MCP tools yourself. Observe and
report; do not modify the repo. Unlike the probe rounds, **do not clean up at
the end**: leave the plugin installed and enabled.

## Steps

1. Install (or refresh) from the GitHub marketplace:

   ```bash
   codex plugin marketplace add virusimmortal00/fraktik --ref main --json
   codex plugin add fraktik@fraktik --json
   ```

   If an older fraktik marketplace/plugin is already present, update or
   remove-and-re-add so the cached version is **0.2.0**. Record the reported
   cache path (expected shape:
   `~/.codex/plugins/cache/fraktik/fraktik/0.2.0`) (S1).

2. Enable the server in `~/.codex/config.toml`:

   ```toml
   [plugins."fraktik@fraktik".mcp_servers."fraktik"]
   enabled = true
   ```

3. Start a fresh Codex session. Confirm the server starts (no
   `MCP startup failed` line) and that exactly these tools are exposed:
   `fraktik_plan_slices`, `fraktik_intelligence_route`,
   `fraktik_intelligence_verify` (S2).

4. Call `fraktik_intelligence_route` with `{"taskShape": "everyday"}`.
   Expect a non-error JSON result with `command: "intelligence route"` and a
   route containing model and effort values. Record the JSON verbatim (S3).

5. Call `fraktik_plan_slices` with:

   ```json
   {
     "plan": {
       "schemaVersion": 1,
       "objective": "smoke-test the bundled planner",
       "slices": [
         {
           "id": "smoke",
           "title": "Smoke slice",
           "objective": "bounded smoke check",
           "deliverable": "notes",
           "acceptanceCriteria": ["notes recorded"],
           "dependsOn": [],
           "lifecycle": "subagent",
           "workspaceMode": "shared-read-only",
           "taskShape": "everyday"
         }
       ]
     }
   }
   ```

   Expect a non-error result with `command: "plan slices"`, one wave, and a
   summary of one slice. Record verbatim (S4).

6. Verification round-trip: launch a trivial native task using the exact
   model and effort from step 4's route. After it starts, call
   `fraktik_intelligence_verify` with that task's thread ID and the same
   model/effort — expect `verified: true`, not an error (S5). Then call it
   again with a deliberately wrong effort — expect a **tool error** whose
   payload shows `verified: false` (fail-closed) (S6). Archive the trivial
   task afterward if convenient.

7. Note the approval UX for these calls under your current config (S7).

## Findings template — fill in and return

```markdown
# Smoke-test findings — <date>, codex version: <codex --version>

## S1 — Install
Commands used; installed version and cache path; any warnings.

## S2 — Server startup and discovery
Server started cleanly yes/no; tools exposed (exact list); any stderr lines.

## S3 — intelligence_route JSON (verbatim)

## S4 — plan_slices JSON (verbatim)

## S5 — verify success case
Thread ID, model/effort used, and the verbatim JSON result.

## S6 — verify fail-closed case
The verbatim error payload for the wrong-effort call.

## S7 — Approval UX
Prompts observed per call, and relevant config policy in effect.

## S8 — Anything unexpected

## S9 — End state
Plugin left installed and enabled: yes/no.
```

## What the findings decide

- S2 proves the bootstrap resolves a *real* marketplace cache (the probe only
  ever proved a hand-built fixture).
- S5/S6 prove `intelligence verify` finds the live sessions root from inside
  the plugin-launched process (no `CODEX_HOME` env exists there).
- S3–S6 green-light the follow-up PR that migrates the skill from the
  `fraktik` CLI to these tools; anything red feeds a fix first.
