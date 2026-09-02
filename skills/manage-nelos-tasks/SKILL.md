---
name: manage-nelos-tasks
description: Coordinate parallel agents and resume multi-step coding work with tracked dependencies and verified results. Use for multi-stream features or fixes, Nelos task-web status or recovery, and explicit Nelos orchestration; not single-file edits or standalone reviews.
---

# Coordinate Work with Nelos

Use Nelos when coding work needs independent workers, ordered dependencies,
and a reliable join of their results. It tracks what can run together, what
must wait, and which results have actually been accepted across restarts.
The coordinating agent (the queen) remains responsible for the outcome.

## Choose the Scope

- For a multi-stream feature or fix, plan bounded work, execute dependency-safe
  waves, and verify results before dependent work starts.
- For an existing Nelos task web, inspect its current persisted state and resume
  its returned action; do not recreate completed work or start a duplicate plan.
- For status-only requests, use read-only Nelos inspection tools. Do not launch,
  replan, archive, or otherwise mutate tasks merely to report their state.
- Handle isolated edits, explanations, single-task renaming, and standalone
  reviews directly with the appropriate tools; they do not need a task web.

Automatic discovery does not expand the user's task or grant permission for
external changes. Respect explicit limits on delegation and side effects.

## Execute Safely

Before coordinated execution or recovery, read the protocol below in full.
Follow its machine-generated next actions, including evidence and stop gates.
Planning quality must not depend on the queen's model. One bounded Sol planner
decomposes; the queen judges. Use bundled MCP tools; never use the CLI as fallback.

Before mutations call `nelos_runtime_health`; require `mutationAllowed`, else use `recovery`.
Never live-upgrade Nelos. Quit, install externally, relaunch and open fresh task; task alone leaves workers live.

- A `subagent` is a joined child. Its primary identity is `agentPath`; its
  internal thread ID is verification evidence only. Never call it a spinoff.
- A `spinoff` is a durable Codex task controlled by `threadId`.

## Choose the Planning Path

Only if the user explicitly supplied a complete plan with `schemaVersion`,
`objective`, and bounded `slices`, call `nelos_plan_slices` directly. A queen-authored plan is not user-supplied.

For new work otherwise call `nelos_plan_lifecycle` with schema version 1, queen task ID,
caller-stable idempotency key, objective, optional bounded context/parallelism,
`receipt: null`, and `launchAuthorization: null`. Spinoffs are cleanup-capable;
use `cleanupIntended: false` only when explicitly requested. Do not first author slices or
classify them in the queen. Execute only its returned action, then
call again with the unchanged request, returned `bootstrapId`, and exact native
receipt. Never substitute an agent path for a task ID.

Reject invalid identity, parent, route, or result-turn evidence. Render maps from top-level `structuredContent`; reserve `structuredContent.protocol.result` for nonvisual handling. Ordinary maps omit archived members.
Only when the user asks for historical web members, call `nelos_execution_map_history` with the exact web and queen IDs; never make full history routine.

## Follow the One Desktop Path

After the fast path or bootstrap, execute only the returned
`nextAction`; do not reconstruct a procedure from memory.

- `native-set-title`: for the queen or durable spinoff, use exact `threadId` and
  `title`; verify, then repeat the returning tool. Joined subagents cannot use it.
- `launch-planner`: follow the bounded path; map exact `forkTurns` to the
  native launcher's `fork_turns` field.
- `verify-route`: call its `tool` with unchanged `arguments`.
- `authorization-required`: run its `authorizationEffect` with registry data and
  confirmed user intent. Replay its exact receipt; never author one.
- `execution-unavailable`: stop; never substitute a launcher or execute locally.
- `launch-wave`: its `executionGate` is authoritative. Dispatch only listed
  members with exact fields. Never omit, substitute, or inherit a decided `nativeTask`.
  `create-thread` makes spinoffs; `spawn-subagent` uses
  `agentTaskName`. Joined subagents support only Sol or Terra; Luna is
  valid only for durable spinoffs. Never bind an agent name as a thread ID.
  For each `orchestration`, call its exact tool/arguments, execute
  `native-create`, and submit the unchanged work unit plus exact task-ID receipt.
  For a subagent, resolve its agent path to the verification-only thread ID.
  Follow title effects; never invent prompts or capabilities.
  Do not launch a later wave until required current results are accepted.
- Before waiting or reading any launched wave, call
  `nelos_launch_verify_batch` once with the launch action's exact
  `verification` identity and every wave receipt. Subagents use agent paths;
  spinoffs use thread IDs, omit unobserved parent claims, and include turn IDs.
  Proceed only when `allVerified` is true; success durably adopts joined
  members and replays legacy adoption.
  Subagent title is `not-applicable`; spinoffs verify `native-thread-title`.
  On mismatch, run `native-set-title` and repeat.
  Bad identity, topology, read, or route evidence blocks the whole batch.
- `native-wait-subagent` and `native-read-subagent-result`: use collaboration
  controls with exact `agentPath`; never use its thread ID for task controls. Never
  submit a mailbox result directly: replay the exact planner launch receipt
  until Nelos returns `native-read-subagent-result`, then use its exact
  `actionId`. Never construct or guess a result action ID. Say only that the
  planner finished and Nelos is verifying its
  terminal turn; expose protocol details only if `attention` persists.
- `native-wait-wave`: route every target independently by `controlSurface`;
  `collaboration` targets are subagents and `codex-task` targets are spinoffs.
  After terminal turns call `nelos_execution_map_refresh` with resolved fields; never trust mailbox status.
- `native-wait` and `native-read`: use Codex task controls for durable task
  targets. For task checks call `nelos_thread_wait`, then
  `nelos_thread_inventory`. Never serially poll a web.
- `attach-native-task-options`: pass `nativeTask` unchanged to the next launch.
- `decide`: only the queen may judge current evidence; call `nelos_queen_decide`
  with schema version 1 and the exact consumed `native-result-read` receipt,
  web/queen IDs, decision, and summary; execute its returned
  `nelos_orchestrate_advance` action. Never reconstruct result provenance.
  Author slices only when explicitly returned unresolved.
- `cleanup-spinoffs`: call its exact `tool` and unchanged `arguments`. The
  snapshotted default `auto` archives eligible spinoffs; `ask` prompts
  once with exact names/IDs, and `keep` preserves. `rememberPolicy:
  true` with `userIntentConfirmed: true` only for an explicit always choice;
  submit receipts until settled. `not-ready` retains unaccepted members but archives
  accepted siblings. On `authorization-required`, run its exact effect and replay
  the same `nelos_spinoff_cleanup` call with its `launchAuthorization`; never route
  that receipt through planning. Durable cleanup makes a restarted
  `nelos_orchestrate_advance` resume the next-wave authorization boundary.
- `orchestration-repair-member`: submit its exact identity as an `orchestration-member-repaired` receipt through `nelos_orchestrate_advance`,
  adding only `resolution: "detach"`; never detach locally.
- `attention`: stop and resolve the named evidence gap; do not infer an action.
  For `missing-persisted-dependency-work-units`, replay exact launch
  verification for named legacy joined members, then retry the transition.
- `complete`: stop; the command has no additional protocol step.

Spinoffs run exact `nelos_spinoff_complete`: start with `receipt: null`, send its
effect through `codex_app.send_message_to_thread`, then pass the exact
`{"threadId":"..."}` result; never add fields or repeat `attention`. After acceptance
follow `cleanup-spinoffs`; never depend on remembering a separate cleanup call.
Never clean up failed, blocked, detached, unaccepted, stale, or archive-incapable work.

Use `nelos_plan_replan` only for a typed terminal failure/block, user
requirements change, or insufficient-confidence event. Supply the base
plan-run identity, plan, affected/completed slices, evidence, and generation 1.
Timeouts, unavailable reads, and successful execution are not replanning
triggers. Completed slices remain unchanged and are never scheduled again; a
second autonomous replan stops.

Unavailable reads and timed-out waits are unknown evidence, not failure. Registry-only
topology has a lifecycle cache; never write lifecycle or archival state from a native
action. Lifecycle reads reconcile their cache on every read; the observation lease is informational.
Never perform a second local lifecycle mutation to mirror a native archive.
