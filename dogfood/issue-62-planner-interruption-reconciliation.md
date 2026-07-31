# Issue #62 planner interruption reconciliation dogfood

Date: 2026-07-31

Tracking issue: [#62 — Planning lifecycle falsely reports planner-turn-failed for a running joined planner](https://github.com/virusimmortal00/nelos/issues/62)

## Scenario

The dependency-complete planning lifecycle smoke test uses the stdio MCP server,
the strict fake Codex app-server, an on-disk planning lifecycle store, and a real
MCP process restart. It exercises this sequence:

1. Launch and verify the Sol/medium joined planner.
2. Observe `latestTurn.status: interrupted` for the planner while the queen's
   native `collabAgentToolCall.agentsStates` entry reports the same internal
   planner thread as `running`.
3. Replay the exact verified `native-planner-created` receipt before and after
   restarting the MCP process.
4. Verify both calls return retryable `native-wait-subagent`, retain the
   original agent path and internal thread identity, consume zero unavailable
   evidence observations, and never return `planner-turn-failed`.
5. Change only the authoritative collaboration state to `completed`, leaving
   the app-server planner turn observation `interrupted`.
6. Replay the exact launch receipt and verify `native-read-subagent-result`
   carries the original planner agent path, thread ID, turn ID, bootstrap ID,
   and lifecycle-owned read action ID.
7. Complete plan validation, launch authorization, mixed-wave verification,
   and exception replanning to prove the fix remains dependency-complete.

Focused unit coverage separately exhausts three persisted unavailable-evidence
observations across coordinator restarts, then deterministically returns
non-retryable `planner-lost`. It also verifies app-server `failed` and `error`
remain fail-closed even when collaboration reports a nonterminal planner, and
that a failed result turn cannot be accepted when collaboration reports
completion.

## Reproduction

From the repository root:

```sh
npm run verify:planning-lifecycle
node --import ./scripts/test-bootstrap.mjs --test \
  test/planning-lifecycle.test.mjs \
  test/protocol-contract.test.mjs \
  test/mcp-app-server-bridge.test.mjs
```

## Result

Passed on 2026-07-31. The MCP smoke report was:

```json
{
  "schemaVersion": 1,
  "receiptResume": true,
  "batchAtomic": true,
  "exceptionReplanned": true,
  "completedSlicesPreserved": true,
  "modelTurns": 0,
  "cleanedUp": true
}
```

The focused test command passed 75 tests with zero failures before this report
was written. The final dependency-complete suite result should be recorded in
the task handoff rather than copied here, so this report stays reproducible
instead of becoming a mutable CI ledger.
