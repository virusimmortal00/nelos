# Robust Native Task Orchestration

Status: proposed architecture.

## Problem

Native Desktop task creation currently accepts an initial prompt and target but
not a title. A directly created task returns a `threadId`; a queued worktree
creation may initially return only a `clientThreadId`. Nelos therefore cannot
make "create with this title" one formal native operation. Live Desktop
validation shows that a short first prompt line in the form
`Task title: <intended title>` can be preserved exactly, but inference may still
rewrite even a short seed, so native verification remains mandatory.

Durable spinoffs are also independent top-level tasks. Their completion does
not restart a queen after the queen has ended its turn. While the queen remains
active, the native multi-task wait operation can wake it when a member
completes or needs attention. If the queen ends first, resumption needs a
separate persistent mechanism.

These are related orchestration problems, but they are not one linear
lifecycle. A task may be running while title synchronization is pending, and a
title failure does not prove that task creation or execution failed.

## Decision

Represent every durable member launch as a persisted **launch intent** with
orthogonal launch, title, execution, and coordination state. Drive that intent
through an MCP-first orchestration reducer that emits machine-generated native
actions only at the host boundary. The queen must join required spinoffs before
ending its turn unless the plan explicitly marks them detached.

Nelos remains the protocol and topology layer. Native Codex tools remain the
authority for task creation, titles, execution status, results, and archival
state.

## MCP-First Product Surface

The installed product should not require the model to reconstruct shell
commands or lifecycle rules from skill prose. Put the state machine in shared
library code and expose it primarily through Nelos MCP tools. Keep CLI commands
as a developer, automation, and recovery adapter over the same library.

The MCP server can directly own:

- launch-intent, topology, cursor, and acceptance persistence;
- idempotency locks and crash reconciliation for Nelos-owned state;
- slice planning, routing, prompt construction, and title rendering;
- result-envelope validation and dependency-wave reduction;
- selection of the one exact next action;
- local worktree provisioning when explicitly authorized by that tool's
  permission contract.

The desired installed loop is:

```text
call nelos_orchestration_start/advance
                │
                ▼
        MCP persists and reduces
                │
                ▼
     complete / attention / nativeEffect
                │
                ▼
 agent performs only the nativeEffect
                │
                ▼
   MCP receives the bounded native receipt
```

This is one protocol loop, not a collection of instructions the agent must
remember. A native receipt must be schema-validated before it changes Nelos
state.

An MCP server does not automatically inherit the Codex host's native task
tools, and it cannot call a sibling tool merely because the model can see that
tool. Nelos now starts a separate stdio app-server lazily for bounded task
inspection, batched current-state polling, direct-parent topology projection,
and current-queen title synchronization. The polling cursor is Nelos-owned and
does not claim native event replay or result provenance. Task creation,
follow-ups, archival, durable result collection, and other unverified effects
remain explicit `nativeEffect` callbacks executed by the agent. Each additional
migration requires its own capability, permission, concurrency, and failure
contract.

Local CLI and app-server processes that use the same Codex home write to the
shared session inventory, so tasks they create can be discovered in Desktop.
Spawning a dedicated stdio app-server is therefore a viable compatibility
path for creating visible local tasks; it is not inherently a separate task
universe.

It is not automatically equivalent to controlling Desktop's own live
app-server connection. Before treating the compatibility path as full Desktop
integration, verify concurrent live behavior for streamed status, approvals,
steering, interruption, worktree ownership, and handoff. Prefer a brokered
connection to the Desktop-owned app-server when available because that makes
those host semantics explicit. Otherwise, use the shared-session compatibility
path only for capabilities verified across both processes, and retain native
effects for host-only operations.

The Nelos MCP server previously exposed only three socket-free, read-only
tools. Orchestration state and the narrowly scoped app-server bridge are
therefore deliberate MCP permission expansions, not behavior hidden inside the
prior read-only contract.

## State Model

One record owns a stable `intentId` and these independent state groups:

| Group | States | Authority |
| --- | --- | --- |
| Launch | `planned`, `creating`, `provisioning`, `bound`, `attention` | Durable Nelos receipt plus native creation result |
| Title | `pending`, `applying`, `verified`, `attention` | Native title write and subsequent native observation |
| Execution | `unknown`, `queued`, `running`, `terminal`, `attention` | Native wait/read result |
| Coordination | `unjoined`, `waiting`, `collected`, `correction-pending`, `accepted`, `detached` | Queen decision and result provenance |

The launch intent should persist at least:

```json
{
  "schemaVersion": 1,
  "intentId": "launch:A1:api:r1:a1",
  "queenThreadId": "queen-task-id",
  "workUnitId": "api",
  "requestedTitle": "🕷️ A1 · API changes",
  "promptDigest": "sha256:...",
  "target": {},
  "nativeTask": {},
  "clientThreadId": null,
  "memberThreadId": null,
  "hostId": null,
  "launchState": "planned",
  "titleState": "pending",
  "executionState": "unknown",
  "coordinationState": "unjoined",
  "waitPolicy": "required"
}
```

The prompt and credentials should not be persisted in this receipt. Persist a
digest and the bounded routing/target metadata needed to detect accidental
reuse of an `intentId` with different inputs.

## Launch Protocol

1. **Authorize the exact wave before mutation.** Planning returns a bounded
   `authorization-required` proposal with a `native-authorize-launch` effect.
   Execute its named `nelos_launch_authorize` producer using bounded current
   native tool-registry capabilities and confirmed user intent, then replay its
   typed wave-bound receipt. Missing, negative, partial, stale, or mismatched
   evidence cannot produce `launch-wave`; planning a graph alone is never
   permission to create user-visible tasks.
2. **Prepare the intent before mutation.** Write `planned` with the desired
   title, target, route, queen, and work-unit provenance.
3. **Claim creation once.** Move to `creating` under the existing queen/action
   lock, then dispatch the persisted launcher exactly once:
   `create-thread` for a spinoff or `spawn-subagent` for a joined subagent.
4. **Record the native receipt before further effects.**
   - A spinoff's returned `threadId` moves launch directly to `bound`.
   - A joined subagent's returned canonical `agentPath` is its primary control
     identity. Its resolved internal thread ID is retained only as verification
     evidence.
   - A returned `clientThreadId` moves launch to `provisioning`. It must be
     resolved to a `threadId` through a host-provided creation result before
     the task can be titled or waited on.
   - An ambiguous timeout moves the intent to `attention`; never create a
     replacement until native reconciliation proves that the first create did
     not commit.
5. **Persist one web identity, then settle queen and spinoff titles.** For a
   durable plan, Nelos reuses the queen's existing legacy web record or marked
   title, or allocates through that compatibility registry once. The web ID,
   exact queen title, and every durable member's decorated title are persisted
   in the plan-run contract before launch. Conflicting record, title, or
   plan-run identities fail closed rather than overwriting lineage.

   The planner reads the current queen title twice and returns one deterministic
   host-owned `native-set-title` effect when the persisted queen title is not
   settled. Repeated planning reuses the same effect identity; no wave is
   returned until exact equality is observed.

   Current Codex `create_thread` has no title field. `Task title: <decorated
   intended title>` remains only a non-authoritative prompt seed. After binding,
   batch verification reads a durable spinoff's title. A title-only mismatch
   returns one deterministic post-bind `native-set-title`/verify action and
   gates the wave until exact equality is observed. Joined subagents have no
   native title-control contract; their title check is `not-applicable`.
6. **Join required work.** Once every required current-wave member is bound,
   enter the queen join loop. Detached members are recorded but excluded.

The standalone app-server adapter can continue its stronger sequence of
`thread/start`, title synchronization, then `turn/start`. Native Desktop
creation currently starts the initial turn as part of creation. Prompt seeding
may give that task an approximate useful title, but it is never settled-title
evidence. Native read/set/verify is the normal compatibility path.

## Queen Join Loop

For required members, the queen should remain active and wait through each
member's actual control surface rather than serial status polling:

1. Route the generated `native-wait-wave` targets independently: collaboration
   `agentPath` for joined subagents and Codex-task `threadId` for spinoffs.
2. When the first member completes or needs attention, persist its returned
   cursor and read only the bounded result needed for collection.
3. Classify the result as current, stale, correctable, blocked, or failed.
4. Send a same-task corrective turn when allowed, or stop for queen attention.
5. Wait again on the remaining nonterminal members, supplying their latest
   cursors.
6. After all required results are current, call `nelos_queen_decide` with the
   exact consumed result receipt, execute its returned
   `nelos_orchestrate_advance`, then advance the dependency wave or synthesize
   the final response only when observation reports acceptance.

The queen-only call is a workflow role constraint. A bundled STDIO MCP server
is long-lived and does not receive a documented per-call Codex task identity,
so its decision adapter must not authorize from the server process's launch-time
`CODEX_THREAD_ID`. Instead it fails closed by matching the asserted queen ID,
web ID, bound work unit, consumed current-result receipt, and fresh terminal
turn evidence. The CLI remains free to use its per-invocation
`CODEX_THREAD_ID`.

`wait_threads` is an event wait from the queen's perspective; it is the
preferred "pull" mechanism while the queen turn is alive. A bounded timeout is
an opportunity to report progress and wait again, not evidence that a member
failed.

The queen must not return a final answer while required members remain
`waiting`. Ending the turn is valid only when all required work is accepted,
the workflow needs user attention, or the plan explicitly chose `detached`.

## Resume After an Interrupted Queen

Persist enough join state that a later queen turn can reconstruct the wait set
without replaying launches:

- bound member and host IDs;
- per-member wait cursor;
- latest observed turn/result provenance;
- required/detached policy;
- current dependency wave and acceptance records.

On resume, reconcile native state, verify any still-pending bound titles, then
continue the join loop.

Codex still exposes no native persistent completion subscription. Nelos closes
that gap at the application layer: every durable launch prompt carries an exact
`nelos_spinoff_complete` callback identity. The member persists its completion
before its final response and receives one deterministic host-owned native
send-message effect. The member executes it through
`codex_app.send_message_to_thread`, whose successful result contains only the
target `threadId`, then supplies that exact result without adding lifecycle or
effect fields. A persisted in-flight operation returns a reconciliation effect
rather than another send.

The callback complements rather than replaces the queen join loop. A member can
crash before making its callback, so a live queen still uses bounded native
waits and reconstructs them from receipts after interruption. No heartbeat or
silently installed daemon is required for normal successful completion.

## Spin-off Cleanup

Completion, queen acceptance, and archival remain separate. Once all required
current results are accepted, `nelos_orchestrate_advance` emits the exact
`nelos_spinoff_cleanup` next action. That tool derives a candidate set from the
durable execution and acceptance records:

- `auto` is the built-in default and returns native archive effects for all
  eligible candidates;
- `ask` returns names and task IDs and archives nothing, while recording the
  cleanup policy snapshot on candidate lifecycle records;
- `keep` records the decision without archiving; and
- `rememberPolicy: true` persists an explicit choice to the machine-local TOML
  config only when `userIntentConfirmed: true` records an explicit user request.

The first eligible cleanup call snapshots the effective policy across the web.
Changing the global default afterward affects future webs but does not change
an in-flight confirmation, archive, or receipt reconciliation.

If a required current spin-off lacks a successful current acceptance, cleanup
returns that exact work unit in `pending`. Independently accepted siblings may
still emit archive effects; after those receipts settle, cleanup remains
`not-ready` until the pending work is accepted. Failed, blocked, detached,
unaccepted, stale-attempt, non-spinoff work, and work without an explicit
`archive` capability is never eligible. Archive remains a host-owned native
mutation. Each exact host receipt is recorded independently so partial cleanup
remains recoverable. A persisted `archiving` state returns a reconciliation
effect and is never replayed as a second archive request.
Terminal `archived` and `kept` records remain addressable by an exact
confirmation replay.

## Upstream Native API Improvements

Nelos should feature-detect and use these if Codex adds them:

1. `create_thread.title`: apply the requested title atomically with creation.
2. `create_thread.idempotencyKey`: let an ambiguous create be safely retried.
3. A durable mapping/event from `clientThreadId` to the eventual `threadId`.
4. `resumeParentOnCompletion` or a persistent wait subscription for a set of
   independently owned tasks, which can eventually replace the application
   completion callback.

Until then, the title receipt and queen join loop are the compatibility layer.

## Failure Rules

| Failure | Required behavior |
| --- | --- |
| Create rejected before commit | Mark launch `attention`; retry only by explicit policy. |
| Create response lost | Reconcile by idempotency/correlation; never blindly duplicate. |
| Worktree still provisioning | Preserve `clientThreadId`; do not title or wait prematurely. |
| Title write fails | Keep the task bound/running; retry title independently. |
| Title verification disagrees | Preserve desired and observed titles; surface attention after bounded retries. |
| Wait times out | Persist progress/cursors and wait again or yield an explicit resumable checkpoint. |
| Queen process/turn stops | Resume from receipts; do not recreate members. |
| Member result is stale | Reject for acceptance and wait/read the current turn. |
| Member needs correction | If follow-up capability and attempt budget remain, persist `correction-pending`, consume the typed same-task follow-up receipt, advance the attempt, and rejoin the later turn; otherwise surface attention without an unusable follow-up. |
| Legacy required member lacks `read-result` | Return the exact member/capability diagnostic and an audited idempotent detach repair action. |

## Implementation Slices

1. Extend `WorkUnitSpec` execution state with the orthogonal title,
   execution, coordination, `hostId`, `clientThreadId`, and wait-cursor fields.
   Add a migration from the current binding-only record.
2. Extract a shared orchestration reducer and expose stateful MCP
   `start`/`advance`/`resume` operations with strict native-receipt schemas.
   Retain the CLI as an adapter over the same code.
3. Add crash-safe native launch-intent transitions and reconciliation. Reuse
   the existing launch action ID and queen lock instead of introducing a second
   identity. The callback adapter now serializes one work unit and emits a
   non-creating reconciliation action after an uncertain first dispatch; live
   host inventory reconciliation is still required.
4. Make `launch-wave` emit lifecycle-specific native actions. Joined subagents
   bind to collaboration `agentPath` and skip title mutation; durable spinoffs
   first execute their machine-generated `nelos_orchestrate_create` preparation,
   then bind its exact task-ID receipt, verify their native title, and may emit
   a conditional `native-set-title`. The callback adapters reach cursor-aware
   wait and current-turn result-read steps through strict host receipts.
5. [Implemented](observation-join.md): use a cursor-aware queen join reducer
   with at most one batched `native-wait` while required members are
   nonterminal.
6. Add queen-resume reconstruction and an explicit detached/heartbeat policy.
7. Keep the standalone app-server adapter, but make both transports produce
   the same state transitions and acceptance provenance.

## Verification

Tests should cover direct and queued creation, delayed title application,
title failure during successful execution, lost create responses, wait
timeouts, multiple members completing in different orders, corrective turns,
queen restart, stale cursors/results, detached members, and a twice-run
idempotency test proving that no duplicate task is created.
