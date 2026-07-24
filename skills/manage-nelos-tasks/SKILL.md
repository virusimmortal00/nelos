---
name: manage-nelos-tasks
description: Plan multi-stream feature or fix work into dependency-safe waves, choose bounded built-in subagents or durable Codex tasks, and execute Nelos's machine-generated next actions.
---

# Manage Nelos Tasks

Use this for coordinated work.
The only judgment this skill asks the queen to make before launch is whether
each slice is a bounded **subagent** or durable **spinoff**, and its contract.
The queen also decides whether evidence meets the acceptance criteria; Nelos
owns protocol, sequencing, titles, result format, and launch settings.

## Make the Two Judgments

Default to a built-in subagent for bounded work that returns to this task.
Choose a durable spinoff only when the work needs its own addressable lifecycle:
a separate workspace, independent follow-up, inspection, archival, a handoff,
or a dependency gate. Parallelism alone is not a reason to create a spinoff.

Write small independent slices. Each has one objective, concrete deliverable,
testable acceptance criteria, explicit dependencies, and one of these valid
shapes:

- `subagent` with `shared-read-only` for bounded exploration, review, or
  analysis.
- `spinoff` with `isolated-write` for a durable writer; concurrent writers must
  use distinct worktrees.

Use `complex/open-ended`, `everyday`, or `clear/repeatable` for `taskShape`.
Send a JSON plan with `schemaVersion`, `objective`, optional `maxParallel`, and
`slices`; each slice needs `id`, `title`, `objective`, `deliverable`,
`acceptanceCriteria`, `dependsOn`, `lifecycle`, `workspaceMode`, and
`taskShape`.

## Follow the One Desktop Path

Call the `nelos_plan_slices` tool with the plan as its `plan` argument.
Then execute only the
returned `nextAction`; do not reconstruct a procedure from memory.

- `native-set-title`: use the native title tool with its exact `threadId` and
  `title`, then verify it natively.
- `launch-wave`: create only the listed current-wave members concurrently. Use
  each member's exact `lifecycle`, `memberKind`, `launcher`, `title`,
  `nativeTask`, and generated `prompt`. `create-thread` launches a durable
  spinoff; `spawn-subagent` launches a bounded joined subagent. Never translate
  these fields by inference. For spinoff plans, the tool has rendered and
  verified `[🕸️ inbound] [🕷️ outbound] [👑] · base title`, preserving web
  markers; a tool error stops launch. Child titles remain exact and undecorated.
  The generated prompt begins with `Task title: <short intended title>` so
  Desktop can assign the intended title during creation. After the task ID
  resolves, observe its settled native title. If it matches, do not rename it;
  only use the native title tool on a mismatch, then verify the fallback rename.
  Follow the returned `titlePolicy` exactly.
  Never omit, substitute, or inherit a decided `nativeTask` field. If the native
  tool requires explicit model authorization or cannot accept the exact route,
  stop and obtain that authorization or report `attention`; do not launch.
  After launch returns a task ID, call the `nelos_intelligence_verify` tool
  with that ID and the exact `model`/`thinking` values (`thinking` maps to
  `effort`). Include `turnId` when known. Do not wait, read, accept, or
  synthesize the task until it returns `verified: true`; any mismatch stops
  the wave. A subagent launcher result without a native child `threadId` is
  `attention`; never bind its agent name as though it were a thread ID.
  Do not launch a later wave until required current results are accepted.
- `native-wait` and `native-read`: use native controls for receipts; for checks
  call `nelos_thread_wait`, then `nelos_thread_inventory`. Never serially poll a web.
- `attach-native-task-options`: pass the returned `nativeTask` object unchanged
  to the next native launch and apply the same exact-route verification.
- `decide`: author the slice plan or decide whether current evidence satisfies
  its acceptance criteria; these are the model judgments in this workflow.
- `attention`: stop and supply the missing launch inputs or resolve the named
  evidence gap; do not infer an executable action.
- `complete`: stop; the command has no additional protocol step.

The launch prompt requires a bounded result and, for spinoffs, an exact
`nelos_spinoff_complete` call before final response; only the member may call it.
After current queen acceptance, call `nelos_spinoff_cleanup`: `ask` names exact
candidates before confirmation, `auto` archives, and `keep` preserves them.
Never clean up failed, blocked, detached, unaccepted, stale, or archive-incapable work.

Registry-only topology has an unobserved lifecycle cache;
never write lifecycle or archival state from a native action.
CLI-backed reads reconcile their lifecycle cache on every read; the observation
lease is informational, never authority over fresh native evidence.

- Never perform a second local lifecycle
  mutation to mirror a native archive.
