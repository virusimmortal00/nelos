# Handover: live smoke test of the Nelos rename (v0.3.0)

## Context

The project previously published as **Fraktik** is now **Nelos**
(repository `virusimmortal00/nelos`). The bundled MCP tool surface was
live-verified end-to-end under the old name at 0.2.0 (bootstrap cache
resolution, all three tools, fail-closed verification); design record:
`docs/mcp-tool-surface.md`. The rename changes every load-bearing install
identifier — marketplace/plugin pair (`nelos@nelos`), config enablement key,
bootstrap cache glob (`cache/*/nelos/<version>`), MCP server key, baked
version env (`NELOS_PLUGIN_VERSION`), and tool names — so this smoke test
revalidates the same mechanics under the new identity, and exercises the
Fraktik→Nelos migration path on a machine with the old plugin installed.

**Scope: observe and report.** Call the MCP tools directly. Do not modify
the repository. Leave Nelos installed and enabled at the end.

## Steps

1. Migration cleanup (this machine has Fraktik 0.2.x installed):

   ```bash
   codex plugin remove fraktik@fraktik --json
   codex plugin marketplace remove fraktik --json
   ```

   Delete the `[plugins."fraktik@fraktik".mcp_servers."fraktik"]` block from
   `~/.codex/config.toml`. Record any friction — this is the migration path
   the README now documents (N1).

2. Install Nelos from the renamed GitHub marketplace:

   ```bash
   codex plugin marketplace add virusimmortal00/nelos --ref main --json
   codex plugin add nelos@nelos --json
   ```

   Record the installed version and cache path (expected:
   `~/.codex/plugins/cache/nelos/nelos/0.3.0`) (N2).

3. Enable the server in `~/.codex/config.toml`:

   ```toml
   [plugins."nelos@nelos".mcp_servers."nelos"]
   enabled = true
   ```

4. Start a fresh Codex session. Confirm the server starts cleanly and
   exactly these tools appear: `nelos_plan_slices`,
   `nelos_intelligence_route`, `nelos_intelligence_verify` (N3).

5. Call `nelos_intelligence_route` with `{"taskShape": "everyday"}` —
   expect a non-error route with model and effort. Record verbatim (N4).

6. Call `nelos_plan_slices` with:

   ```json
   {
     "plan": {
       "schemaVersion": 1,
       "objective": "smoke-test the renamed planner",
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

   Expect `command: "plan slices"`, one wave, one slice (N5).

7. Verification round-trip: launch a trivial native task with the exact
   model/effort from step 5, then call `nelos_intelligence_verify` with its
   thread ID and the same values — expect `verified: true` (N6). Repeat with
   a deliberately wrong effort — expect a tool error with `verified: false`
   (N7). Also confirm the bundled skill is discoverable under its new name
   (`manage-nelos-tasks`) in this fresh task (N8).

## Findings template — fill in and return

```markdown
# Nelos rename smoke-test findings — <date>, codex version: <codex --version>

## N1 — Fraktik removal
Commands used; any friction with the documented migration path.

## N2 — Install
Installed version and cache path; any warnings.

## N3 — Server startup and discovery
Started cleanly yes/no; exact tool list; any stderr.

## N4 — intelligence_route JSON (verbatim)

## N5 — plan_slices JSON (verbatim)

## N6 — verify success case (verbatim)

## N7 — verify fail-closed case (verbatim error payload)

## N8 — Skill discovery
manage-nelos-tasks visible in the fresh task: yes/no.

## N9 — Anything unexpected

## N10 — End state
Nelos left installed and enabled; all fraktik surfaces gone: yes/no.
```

## What the findings decide

- N2/N3 prove the renamed bootstrap resolves the new cache path and server
  key end-to-end.
- N1 validates (or corrects) the README's migration instructions.
- Green across N1–N8 closes the rename; anything red feeds a fix before the
  rename is announced.
