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
bounded context/parallelism, and `receipt: null`. Do not first author slices or
classify them in the queen. Execute only its returned action and call the same
tool again with the unchanged request, returned `bootstrapId`, and exact typed
native receipt. Never substitute an agent path for a task ID.

The coordinator prevents duplicate planners and verifies child identity,
parent, exact Sol/medium route, and result turn. Follow its actions until
it returns a wave. Invalid, stale, conflicting, low-confidence, or unverifiable
evidence stops. `nelos_plan_bootstrap` is only a compatibility primitive.

## Follow the One Desktop Path

After the fast path or validated bootstrap, execute only the returned
`nextAction`; do not reconstruct a procedure from memory.

- `native-set-title`: use only for the queen or a durable spinoff with its
  exact `threadId` and `title`, verify it natively, then repeat the tool that
  returned the action. Joined subagents do not support native title control.
- `launch-planner`: follow the bounded path; map exact `forkTurns` to the
  native launcher's `fork_turns` field.
- `verify-route`: call its `tool` with unchanged `arguments`.
- `launch-wave`: create only the listed current-wave members concurrently. Use
  each member's exact `lifecycle`, `memberKind`, `launcher`, `title`,
  `nativeTask`, `identityContract`, and generated `prompt`. `create-thread`
  launches a durable spinoff; `spawn-subagent` launches a joined subagent using
  its exact `agentTaskName`. Joined subagents support only Sol or Terra; Luna is
  valid only for durable spinoffs. Never translate fields by inference or
  describe a subagent as a spinoff. Follow `titlePolicy`; never omit,
  substitute, or inherit a decided `nativeTask`. If the exact route or native
  identity is unavailable, stop with `attention`; never bind an agent name as a
  thread ID.
  Do not launch a later wave until required current results are accepted.
- Before waiting or reading any launched wave, call
  `nelos_launch_verify_batch` once with the launch action's exact
  `verification` identity and every current-wave launch receipt. Joined
  subagents use agent paths; spinoffs use thread IDs; both include turn IDs.
  Nelos obtains title/model/effort from the persisted wave contract. Proceed
  only when `allVerified` is true.
  Subagents verify `agent-path` identity and report title as `not-applicable`;
  spinoffs verify `native-thread-title`. One missing, altered, duplicate,
  wrong-parent, unreadable, or wrong-route member blocks the whole batch;
  a spinoff title mismatch also blocks it.
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
- `decide`: author the slice plan or decide whether current evidence satisfies
  its acceptance criteria. Slice-plan authorship is permitted here only when
  explicitly returned as an unresolved `decide` action.
- `attention`: stop and supply the missing launch inputs or resolve the named
  evidence gap; do not infer an executable action.
- `complete`: stop; the command has no additional protocol step.

The launch prompt requires a bounded result and, for spinoffs, an exact
`nelos_spinoff_complete` callback cycle before final response. Call first with
`receipt: null`, execute only the returned native send-message effect, and call
again with the exact host receipt. A reconciliation effect is `attention`;
never blindly repeat the send.
After current queen acceptance, call `nelos_spinoff_cleanup`: `ask` names exact
candidates before confirmation, `auto` returns native archive effects, and
`keep` preserves them. Execute only returned archive effects and call cleanup
again with their exact receipts.
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
lifecycle cache on every read; the observation lease is informational. Never perform a second local lifecycle
mutation to mirror a native archive.
