# Nelos Skill Dogfood and Stress Test — 2026-07-25

Environment:

- Codex Desktop thread: `019f9a40-d66f-70c1-abc6-b9296cfab53e`
- Nelos plugin: `0.4.0+codex.20260725164719`
- Repository branch: `fix/mcp-host-owned-effects`

## Scenarios

| ID | Area / use case | Expected behavior | Status |
| --- | --- | --- | --- |
| S1 | Fresh-thread plugin and MCP discovery | Updated skill and lifecycle-aware MCP descriptions load; app-server health is compatible | Passed |
| S2 | Unstructured objective planning | Nelos launches one Sol/medium joined planner and resumes through exact receipts without treating it as a spinoff | Partial — transient false failure |
| S3 | Single joined-subagent wave | Launch uses `agentPath`; title verification is not applicable; result returns through collaboration controls | Failed — native route unavailable |
| S4 | Parallel joined-subagent wave | Multiple exact agent paths remain distinct and batch verification is atomic | Blocked by S3 |
| S5 | Invalid or incomplete launch evidence | Batch blocks before reading or accepting results and reports actionable attention | Passed |
| S6 | Replay and idempotency | Repeating an exact lifecycle request/receipt reconciles without duplicate launches | Passed |
| S7 | Spinoff-only wave | Launch uses a durable Codex task `threadId` and native title controls, never collaboration identity | Partial — plan/title only |
| S8 | Mixed subagent/spinoff wave | Generated wait targets retain separate collaboration and Codex-task control surfaces | Partial — scheduled, not launchable |
| S9 | Blocked or failed member | Failure remains distinct from timeout/unavailable evidence and does not silently settle the wave | Failed/inconclusive |
| S10 | Documentation and terminology | Queen consistently calls joined children subagents and durable tasks spinoffs | Passed |

## Run Notes

### S1 — Fresh-thread plugin and MCP discovery

- Result: Passed.
- Evidence: the installed skill path includes version
  `0.4.0+codex.20260725164719`; `nelos_app_server_health` reported
  `ready`, `compatible: true`, and Codex app-server `0.144.6`.
- Terminology check: the loaded MCP description explicitly says
  “agent path for joined subagents, native title for spinoffs.”
- Repository effects: none.

### S2 — Unstructured objective planning

- Result: Partial.
- Planner launch contract was correct:
  `memberKind: joined-subagent`, `primaryId: agentPath`,
  `controlSurface: collaboration`, `nativeThreadIdUse: verification-only`,
  `nativeTitleControl: false`, Sol/medium, and `forkTurns: none`.
- The native collaboration launch returned
  `/root/nelos_planner_007d0e721f59`. Nelos resolved it to internal thread
  `019f9a43-941d-7bb2-a717-534d3b222c0d`, verified the direct parent and exact
  Sol/medium route, and correctly tolerated `title: null` and
  `status: notLoaded`.
- Unexpected behavior: immediately after the launch receipt, app-server
  `latestTurn` reported `interrupted`, so Nelos returned
  `attention: planner-turn-failed`, while the collaboration API simultaneously
  reported the same agent as `running`.
- After the collaboration agent completed, replaying the exact launch receipt
  returned `native-read-subagent-result`, and the exact result receipt
  completed the plan.
- Verdict: identity/title/control semantics worked; active-turn observation has
  a race or status-mapping defect.

### S3 — Single joined-subagent wave

- Result: Failed before launch.
- Nelos routed the current joined-subagent member to
  `gpt-5.6-luna` with low reasoning.
- The real Codex collaboration launcher rejected that exact model and reported
  that only `gpt-5.6-sol` and `gpt-5.6-terra` are available to `spawn_agent`.
- The Codex durable-task launcher does advertise Luna, so this is specifically
  a launcher-capability mismatch: Nelos's routing catalog does not currently
  distinguish joined-subagent models from durable-task models.
- Per the skill's fail-closed rule, no model was substituted and no member was
  launched.

### S4 — Parallel joined-subagent wave

- Result: Blocked by S3.
- The generated plan's first wave contained one joined member whose own
  acceptance criteria requested two nested joined members. Before that member
  could run, its Luna route was rejected by the collaboration launcher.
- No parallel identities were fabricated and no later wave was launched.

### S5 — Invalid or incomplete launch evidence

- Result: Passed.
- Submitted a deliberately nonexistent agent path for the persisted first-wave
  contract.
- Batch verification returned `allVerified: false`,
  `identityEvidence: agent-path`, `threadId: null`,
  `attentionReason: identity-resolution-unavailable`, and did not attempt read,
  topology, title, or route checks.
- `nextAction` was `attention`; no result was read or accepted.

### S6 — Replay and idempotency

- Result: Passed.
- Replayed the exact `native-planner-created` receipt after the planner
  completed. The lifecycle retained revision 3 and the same planner identity;
  it did not launch another planner.
- Replayed the exact result-bound lifecycle request after queen title sync.
  It retained the same plan-run ID and advanced to the first wave without
  duplicating planning state.

### S7 — Spinoff-only wave

- Result: Partial.
- The planner produced a durable `spinoff` slice with
  `workspaceMode: isolated-write` and a Terra/low route.
- The presence of a spinoff correctly caused a host-owned queen-title action.
  Codex renamed the current task, and an exact replay verified the title before
  returning the first launch wave.
- The durable spinoff itself was in wave 2 and was not launched because the
  required wave-1 member could not be launched with its exact route.

### S8 — Mixed subagent/spinoff wave

- Result: Partial.
- The generated plan scheduled the joined `invalid-replay` member and durable
  `durable-identity` spinoff together in wave 2, demonstrating the intended
  mixed lifecycle topology at planning time.
- Launch/wait target routing could not be exercised because the skill correctly
  prohibited skipping the blocked required first wave.

### S9 — Blocked or failed member

- Result: Failed/inconclusive.
- The deliberate blocked-member scenario was downstream of the inaccessible
  first wave and therefore did not run.
- The earlier planner observation did reveal a related defect: a collaboration
  member that was actually running was temporarily classified as a failed
  interrupted turn. This violates the expected separation between active,
  unavailable, and failed evidence.

### S10 — Documentation and terminology

- Result: Passed.
- Throughout the live run, generated contracts used `joined-subagent`,
  `spawn-subagent`, `agentPath`, and `collaboration` for joined children.
- Durable work was consistently called `spinoff` and associated with
  `threadId`, Codex-task controls, isolated write mode, and queen-title sync.
- No joined subagent was renamed or referred to as a spinoff.

## Findings

1. **D1 — Active planner can appear interrupted through app-server.**
   The lifecycle fails early even though collaboration still reports the
   subagent running. Exact replay recovers after completion, but the initial
   `attention` is misleading and interrupts normal automation.
2. **D2 — Joined-subagent routing can select Luna even when the native
   collaboration launcher rejects Luna.** The route catalog needs
   launcher-specific capability filtering or the native collaboration launcher
   must expose Luna.
3. **The identity fix itself behaved correctly.** Agent path remained the
   primary joined-subagent control identity; internal thread ID stayed
   verification-only; missing titles and `notLoaded` thread status did not
   trigger title mutation.
4. **Fail-closed gates behaved correctly.** Invalid identity evidence blocked
   atomically, replay did not duplicate planning, and a blocked required wave
   could not be bypassed to reach later spinoff or mixed-lifecycle work.

## Remediation

- D2 was fixed after this run. Slice routing now maps clear/repeatable joined
  subagents to Terra while retaining Luna for durable spinoffs.
- Explicit Luna overrides for joined subagents fail during plan validation.
- The shared native launch validator independently rejects Luna for
  `spawn-subagent`, covering lower-level orchestration paths as well as normal
  slice planning.
- A fresh-thread dogfood rerun remains required after reinstall.
