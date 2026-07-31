---
name: manage-nelos-tasks
description: Plan multi-stream feature or fix work into dependency-safe waves, choose bounded built-in subagents or durable Codex tasks, and execute Nelos's machine-generated next actions.
---

# Manage Nelos Tasks

Planning quality must not depend on the queen's model. One bounded Sol planner
decomposes work; the queen identifies user-supplied plans and judges result
acceptance. Configure with `nelos_config_get`, `nelos_config_set`, or
`nelos_config_reset`. Call set/reset only after an explicit user request with
`userIntentConfirmed: true`; never use the CLI as fallback.
Keep native kinds exact:

- A `subagent` is a joined child. Its primary identity is `agentPath`; its
  internal thread ID is verification evidence only. Never call it a spinoff.
- A `spinoff` is a durable Codex task controlled by `threadId`.

## Choose the Planning Path

Only if the user explicitly supplied a complete plan with `schemaVersion`,
`objective`, and bounded `slices`, call `nelos_plan_slices` directly with the
queen task ID. A queen-authored plan is not user-supplied and
must not use this fast path.

Otherwise call `nelos_plan_lifecycle` with schema version 1, queen task ID,
caller-stable idempotency key, objective, optional bounded context/parallelism,
`receipt: null`, and `launchAuthorization: null`. Spinoffs are cleanup-capable;
use `cleanupIntended: false` only when explicitly requested. Do not first author slices or
classify them in the queen. Execute only its returned action, then
call again with the unchanged request, returned `bootstrapId`, and exact native
receipt. Never substitute an agent path for a task ID.

Reject invalid identity, parent, route, or result-turn evidence. Render maps
from top-level `structuredContent`; reserve `structuredContent.protocol.result`
for nonvisual handling.

## Follow the One Desktop Path

After the fast path or bootstrap, execute only the returned
`nextAction`; do not reconstruct a procedure from memory.

- `native-set-title`: use only for the queen or a durable spinoff with its exact
  `threadId` and `title`; verify, then repeat the returning tool. Joined
  subagents do not support native title control.
- `launch-planner`: follow the bounded path; map exact `forkTurns` to the
  native launcher's `fork_turns` field.
- `verify-route`: call its `tool` with unchanged `arguments`.
- `authorization-required`: run its `authorizationEffect` with native tool-registry
  data and confirmed user intent. Replay its exact receipt; never author one.
- `execution-unavailable`: stop; never substitute a launcher or execute locally.
- `launch-wave`: its `executionGate` is authoritative. Dispatch only listed
  members with exact fields. Never omit, substitute, or inherit a decided `nativeTask`.
  `create-thread` makes spinoffs; `spawn-subagent` uses
  `agentTaskName`. Joined subagents support only Sol or Terra; Luna is
  valid only for durable spinoffs. Never bind an agent name as a thread ID.
  For spinoffs, call the exact `orchestration.tool` and arguments, execute its
  `native-create`, then submit the unchanged work unit and exact task-ID receipt.
  Follow title effects; never create from the member prompt or invent capabilities.
  Do not launch a later wave until required current results are accepted.
- Before waiting or reading any launched wave, call
  `nelos_launch_verify_batch` once with the launch action's exact
  `verification` identity and every current-wave launch receipt. Joined
  Subagents use agent paths; spinoffs use thread IDs, omit parent claims absent
  native inventory, and include turn IDs.
  Proceed only when `allVerified` is true.
  Subagents report title as `not-applicable`; spinoffs verify
  `native-thread-title`. On title mismatch, run `native-set-title` and repeat.
  Bad identity, topology, read, or route evidence blocks the whole batch.
- `native-wait-subagent` and `native-read-subagent-result`: use collaboration
  controls with the exact `agentPath`. Do not send the verification-only
  subagent thread ID to Codex task title/read controls. After waiting, never
  submit a mailbox result directly: replay the exact planner launch receipt
  until Nelos returns `native-read-subagent-result`, then use its exact
  `actionId`. Never construct or guess a result action ID. While this settles,
  tell the user only that the planner finished and Nelos is verifying its
  terminal turn; expose protocol details only if `attention` persists.
- `native-wait-wave`: route every target independently by `controlSurface`;
  `collaboration` targets are subagents and `codex-task` targets are spinoffs.
  After terminal turns call `nelos_execution_map_refresh` with resolved display/thread/turn fields; never trust mailbox status.
- `native-wait` and `native-read`: use Codex task controls for durable task
  targets. For task checks call `nelos_thread_wait`, then
  `nelos_thread_inventory`. Never serially poll a web.
- `attach-native-task-options`: pass `nativeTask` unchanged to the next launch.
- `decide`: only the queen may judge current evidence; call `nelos_queen_decide`
  with schema version 1 and the exact consumed `native-result-read` receipt,
  web/queen IDs, decision, and summary; execute its returned
  `nelos_orchestrate_advance` action. Never reconstruct result provenance.
  Author slices only when explicitly returned unresolved.
- `cleanup-spinoffs`: call its exact `tool` with unchanged `arguments`. The
  snapshotted default `auto` archives eligible accepted spinoffs; `ask` prompts
  once with exact names/IDs, and `keep` preserves them. Set `rememberPolicy:
  true` with `userIntentConfirmed: true` only for an explicit always choice;
  submit exact receipts until `complete`.
- `orchestration-repair-member`: submit its exact identity as an `orchestration-member-repaired` receipt through `nelos_orchestrate_advance`,
  adding only `resolution: "detach"`; never detach locally.
- `attention`: stop and supply the missing launch inputs or resolve the named
  evidence gap; do not infer an executable action.
- `complete`: stop; the command has no additional protocol step.

Spinoffs run exact `nelos_spinoff_complete`: call with `receipt: null`, send its
effect through `codex_app.send_message_to_thread`, then pass the exact
`{"threadId":"..."}` result; never add fields or repeat an `attention`
reconciliation. After acceptance follow `cleanup-spinoffs`; never depend on remembering a separate cleanup call.
Never clean up failed, blocked, detached, unaccepted, stale, or archive-incapable work.

Use `nelos_plan_replan` only for a typed terminal failure/block, user
requirements change, or insufficient-confidence event. Supply the base
plan-run identity, plan, affected/completed slices, evidence, and generation 1.
Timeouts, unavailable reads, and successful execution are not replanning
triggers. Completed slices remain unchanged and are never scheduled again; a
second autonomous replan stops.

Unavailable reads and timed-out waits are unknown evidence, not failure.
Registry-only topology has a lifecycle cache; never write lifecycle or archival state
from a native action. Lifecycle reads reconcile their cache on every read; the observation lease is informational.
Never perform a second local lifecycle mutation to mirror a native archive.
