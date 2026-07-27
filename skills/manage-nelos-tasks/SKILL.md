---
name: manage-nelos-tasks
description: Plan multi-stream feature or fix work into dependency-safe waves, choose bounded built-in subagents or durable Codex tasks, and execute Nelos's machine-generated next actions.
---

# Manage Nelos Tasks

Use this for coordinated work. Planning quality must not
depend on the queen's model. One bounded Sol planner decomposes unstructured
work. The queen identifies user-supplied plans and judges result acceptance.

Keep native kinds exact:

- A `subagent` is a joined child controlled through Codex collaboration tools.
  Its primary identity is `agentPath`; its internal thread ID is verification
  evidence only. Never call it a spinoff or use Codex task title controls on it.
- A `spinoff` is a durable independent Codex task controlled by `threadId`.
  It may be renamed, waited on, read, resumed, or archived through task controls.

## Choose the Planning Path

Only if the user explicitly supplied a complete plan with `schemaVersion`,
`objective`, and bounded `slices`, call `nelos_plan_slices` directly with the
explicit current queen task ID. A queen-authored plan is not user-supplied and
must not use this fast path.

Otherwise call `nelos_plan_lifecycle` with schema version 1, the current queen
task ID, a caller-stable idempotency key, the unstructured objective, optional
bounded context/parallelism, `cleanupIntended: true` only when the user
explicitly requested disposable-task cleanup, and `receipt: null`. Do not first author slices or
classify them in the queen. Execute only its returned action and call the same
tool again with the unchanged request, returned `bootstrapId`, and exact typed
native receipt. Never substitute an agent path for a task ID.

The coordinator prevents duplicate planners and verifies identity, parent,
Sol/medium route, and result turn. Follow its actions until a wave; invalid,
stale, conflicting, low-confidence, or unverifiable evidence stops.

## Follow the One Desktop Path

After the fast path or validated bootstrap, execute only the returned
`nextAction`; do not reconstruct a procedure from memory.

- `native-set-title`: use only for the queen or a durable spinoff with its exact
  `threadId`, `title`, and optional `actionId`; verify, then repeat the returning
  tool. Joined subagents do not support native title control.
- `launch-planner`: follow the bounded path; map exact `forkTurns` to the
  native launcher's `fork_turns` field.
- `verify-route`: call its `tool` with unchanged `arguments`.
- `launch-wave`: create only listed current-wave members. Use exact lifecycle,
  kind, launcher, title, route, identity, and prompt fields. `create-thread`
  makes spinoffs; `spawn-subagent` uses a joined member's `agentTaskName`.
  Joined subagents support only Sol or Terra. Luna is
  valid only for durable spinoffs. Follow `titlePolicy`; never omit,
  substitute, or inherit a decided `nativeTask`. Missing route/identity is `attention`;
  never bind an agent name as a
  thread ID. Codex cannot set a task title at creation, so verify it after.
  For spinoffs, call the exact `orchestration.tool` and arguments first. Execute
  its `native-create` prompt/options, then call it with the unchanged work unit
  and exact task-ID receipt. Follow title effects before verification; never
  create from the member prompt or invent capabilities.
  Do not launch a later wave until required current results are accepted.
- Before waiting or reading any launched wave, call
  `nelos_launch_verify_batch` once with the launch action's exact
  `verification` identity and every current-wave launch receipt. Joined
  subagents use agent paths; spinoffs use thread IDs; both include turn IDs.
  Nelos obtains title/model/effort from the persisted wave contract. Proceed
  only when `allVerified` is true.
  Subagents report title as `not-applicable`; spinoffs verify
  `native-thread-title`. On title mismatch, run `native-set-title` and repeat.
  Bad identity, topology, read, or route evidence blocks the whole batch.
- `native-wait-subagent` and `native-read-subagent-result`: use collaboration
  controls with the exact `agentPath`. Do not send the verification-only
  subagent thread ID to Codex task title/read controls.
- `native-wait-wave`: route every target independently by `controlSurface`;
  `collaboration` targets are subagents and `codex-task` targets are spinoffs.
  Never collapse the wave into one lifecycle kind.
- `native-wait` and `native-read`: use Codex task controls for durable task
  targets. For task checks call `nelos_thread_wait`, then
  `nelos_thread_inventory`. Never serially poll a web.
- `attach-native-task-options`: pass `nativeTask` unchanged to the next launch.
- `decide`: only the queen may judge current evidence; call `nelos_queen_decide`
  with schema version 1 and the exact consumed `native-result-read` receipt,
  web/queen IDs, decision, and summary; execute its returned
  `nelos_orchestrate_advance` action. Never reconstruct result provenance.
  Author slices only when explicitly returned unresolved.
- `attention`: stop and supply the missing launch inputs or resolve the named
  evidence gap; do not infer an executable action.
- `complete`: stop; the command has no additional protocol step.

The launch prompt requires a bounded result and, for spinoffs, an exact
`nelos_spinoff_complete` callback cycle before final response. Call first with
`receipt: null`, execute only the returned native send-message effect, and call
again with the exact host receipt. A reconciliation effect is `attention`;
never blindly repeat the send.
Only after that advance reports the member accepted, call `nelos_spinoff_cleanup`.
`ask` confirms exact candidates; `auto` returns native archive effects; `keep`
preserves them. Execute returned effects, then submit their exact receipts.
Never clean up failed, blocked, detached, unaccepted, stale, or archive-incapable work.

Use `nelos_plan_replan` only for a typed terminal failure/block, user
requirements change, or insufficient-confidence event. Supply the current
base plan-run ID/digest, plan, affected and completed slice IDs,
bounded evidence, generation 1, and follow its receipt lifecycle exactly.
Timeouts, unavailable reads, and successful execution are not replanning
triggers. Completed slices remain unchanged and are never scheduled again; a
second autonomous replan stops.

Unavailable reads and timed-out waits are unknown evidence, not failure.
Registry-only topology has a lifecycle cache; never write lifecycle or archival state
from a native action. CLI-backed reads reconcile their
lifecycle cache on every read; the observation lease is informational.
Never perform a second local lifecycle mutation to mirror a native archive.
