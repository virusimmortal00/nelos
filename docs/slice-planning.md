# Slice Planning and Intelligence Routing

Nelos composes a receipt-driven planning and launch-verification lifecycle for
high-level work:

1. For an unstructured objective, `nelos_plan_lifecycle` durably prepares and
   coordinates one bounded, read-only Sol/medium planning subagent.
2. Typed launch and result receipts advance a replay-safe lifecycle. Nelos
   independently verifies the planner's collaboration identity, direct-parent
   topology, exact route, and terminal result turn before validating the result
   fence, request identity,
   confidence, evidence, parallelism, and complete plan schema.
3. `nelos plan slices` validates that topology, schedules deterministic
   parallel waves, and applies the reviewed model/reasoning policy to every
   slice. Nelos persists a content-addressed plan run with authoritative wave
   membership, title, and route contracts.
4. `nelos_launch_verify_batch` blocks result use until every launched member in
   the current wave has lifecycle-appropriate identity, available topology,
   and route evidence. Native title verification applies only to spinoffs.

An explicit user-supplied structured plan skips the Sol bootstrap and enters
step 3 directly. A plan authored by the starting queen does not qualify for this
fast path. This makes decomposition quality independent of whether the user's
task began on Luna, Terra, or Sol while avoiding an extra model turn when no
decomposition is needed.

The MCP server deliberately does not pretend to understand arbitrary natural
language. Sol supplies bounded planning judgment; Nelos supplies a stable,
testable contract and deterministic routing policy. Routing remains a reviewed
cost/intelligence heuristic, not a claim of mathematical optimality.

## Receipt-driven planning lifecycle

The first lifecycle call accepts schema version 1, the queen task ID, a stable
idempotency key, objective, optional bounded context, maximum parallelism, and
`receipt: null`, and `launchAuthorization: null`. The queen ID plus key deterministically identify one durable
checkpoint, so an uncertain replay returns reconciliation rather than creating
a second planner. Raw planner output is never persisted.

Its `launch-planner` action fixes all launch-sensitive fields:
joined-subagent lifecycle, shared-read-only workspace, `forkTurns: "none"`,
Sol/medium native route, required child identity, and exact verification.

`forkTurns` maps to the native subagent launcher's `fork_turns` argument. The
generated prompt is therefore self-contained rather than relying on inherited
turns. The launcher returns a canonical agent path, which is the joined
subagent's primary control identity. Nelos resolves it together with the
current parent task ID against bounded local `session_meta`, requiring one
exact native child task. That internal thread ID is verification evidence only:
current Codex collaboration controls do not expose joined-subagent title
mutation or treat the child as a durable task. Missing or ambiguous identity
evidence stops with `attention`.

Each native action is returned with a stable action ID. The caller repeats the
unchanged request and `bootstrapId` with the exact typed receipt. Identical
receipts replay safely; conflicting, stale, future, or out-of-order receipts
fail closed. The coordinator returns exactly one title, wait, read, attention,
or launch action. A matching planning result produces only a bounded
`authorization-required` proposal for the first wave.

## Wave gate and exception replanning

Every wave has a deterministic pre-launch execution gate. The proposal binds
the plan-run ID, wave index, wave digest, and each member's exact lifecycle,
task kind, launcher, workspace mode, model, and reasoning route. Only an exact
`native-launch-authorization` receipt returned by the native host can attest
launcher availability, route support, and task-creation authorization for all
members. The proposal includes an exact `native-authorize-launch` effect naming
`nelos_launch_authorize`. The host copies bounded capability data from its
current native tool registry and confirms user intent; the tool produces the
receipt, which the skill replays unchanged instead of authoring it.

Missing or denied authorization returns `authorization-required`. Missing
launcher or route support returns `execution-unavailable`. Stale, altered, or
partial receipts return `attention`; a mixed wave never becomes partially
executable. An all-positive matching receipt produces the previous
`launch-wave` plus its receipt digest in `executionGate`, so identical inputs
and receipts replay byte-for-byte. Planning a potential graph therefore does
not authorize user-visible task creation.

After creating every current-wave member, call
`nelos_launch_verify_batch` once with the launch action's `planRunId`,
`waveIndex`, and `waveDigest`, plus all member identity and turn receipts.
Expected membership, title, model, and effort come from the persisted wave
contract rather than caller-supplied claims. Joined subagents are resolved
from parent task plus canonical agent path and report title verification as
`not-applicable`; spinoffs use returned task IDs and require exact native
titles. Any missing, altered, duplicate, unreadable, wrong-parent, applicable
wrong-title, or wrong-route member blocks the entire batch before wait, read,
or acceptance.

For a plan containing durable spinoffs, the plan run also persists one
queen-owned compact web identity. The queen and every spinoff title are rendered
from that identity before a wave is returned. Replays reuse the same identity
and exact titles; conflicting persisted or observed identities fail closed.

Each web-backed `launch-wave` member carries an exact
`nelos_orchestrate_create` preparation call. The queen must execute that call
before native creation, create only from its returned effect, and submit the
exact task-ID receipt to bind the work unit. Joined subagents use their
canonical agent path for collaboration control and the resolved native thread
ID only for the binding receipt. This persists review evidence before a later
wave can depend on it and guarantees a spinoff callback target exists before
the worker can call `nelos_spinoff_complete`.
Durable spin-offs are cleanup-capable by default: omitted `cleanupIntended`
behaves as `true` and grants the work unit `archive` capability. This is
authority for the later lifecycle step, not permission to archive immediately;
the built-in cleanup policy is `auto`, while a user can configure `ask` or
`keep`. Terminal cleanup snapshots that policy for the web; a later global
change applies only to future webs. Explicit `false` is a deliberate opt-out
that leaves the work unit archive-incapable.

The `create-thread` launcher does not imply a creation-time title argument:
current Codex `create_thread` has no title field. The prompt's `Task title:`
line is non-authoritative seeding. Post-bind native read/set/verify is expected,
and exact settled-title verification gates the wave.

`nelos_plan_replan` reuses the same receipt lifecycle only for typed terminal
failure/blocking, changed requirements, or insufficient confidence. Timeouts,
unavailable reads, and normal success are not triggers. The supplied base plan
must match its persisted plan-run digest. Persisted lineage bounds generation
to one; completed slices must remain semantically unchanged, and the execution
plan removes them so accepted work is never launched again.

The size contract is aligned across both paths. A structured plan is bounded to
64 KiB and 32 slices before persistence. Planning context is bounded to 128 Ki
characters, while the generated exception-replanning envelope has the stricter
128 KiB UTF-8 byte ceiling. That envelope accommodates a maximum-size accepted
plan plus the maximum typed trigger and framing. Oversized or malformed caller
plans are rejected before a planner task can be launched.

Corrective follow-up and exception replacement are intentionally different
operations. A corrective follow-up asks an existing durable task to repair a
result while retaining its established route. An exception replan creates new
required work and can therefore require a different model or reasoning effort.
Its pending joined subagents receive a fresh, generation-one, plan-run-scoped
task name even when the semantic slice ID is reused. The launcher then resolves
and batch-verifies that exact new child and current turn; it must never send a
follow-up to an earlier joined path as a substitute for the fresh launch.

## Example

Suppose the user asks:

> Design and ship a new task-history view, including implementation,
> documentation, and an independent verification pass.

The queen can produce this bounded input:

```json
{
  "schemaVersion": 1,
  "objective": "Ship the task-history view",
  "maxParallel": 2,
  "slices": [
    {
      "id": "architecture",
      "title": "Architecture decision",
      "objective": "Resolve the data and UI boundaries",
      "deliverable": "A decision with risks and interfaces",
      "acceptanceCriteria": ["Every mutable boundary has one owner"],
      "dependsOn": [],
      "lifecycle": "subagent",
      "workspaceMode": "shared-read-only",
      "taskShape": "complex/open-ended"
    },
    {
      "id": "inventory",
      "title": "Test inventory",
      "objective": "Locate reusable fixtures and coverage gaps",
      "deliverable": "A bounded test map",
      "acceptanceCriteria": ["Existing fixtures and missing cases are listed"],
      "dependsOn": [],
      "lifecycle": "subagent",
      "workspaceMode": "shared-read-only",
      "taskShape": "clear/repeatable"
    },
    {
      "id": "implementation",
      "title": "History implementation",
      "objective": "Implement the approved task-history view",
      "deliverable": "A tested patch in an isolated worktree",
      "acceptanceCriteria": ["Focused tests pass", "The view has a useful empty state"],
      "dependsOn": ["architecture"],
      "lifecycle": "spinoff",
      "workspaceMode": "isolated-write",
      "taskShape": "everyday"
    },
    {
      "id": "documentation",
      "title": "History documentation",
      "objective": "Document the approved user workflow",
      "deliverable": "User-facing documentation in an isolated worktree",
      "acceptanceCriteria": ["The example matches the approved interface"],
      "dependsOn": ["architecture"],
      "lifecycle": "spinoff",
      "workspaceMode": "isolated-write",
      "taskShape": "clear/repeatable"
    },
    {
      "id": "verification",
      "title": "Independent verification",
      "objective": "Audit the integrated result against the objective",
      "deliverable": "A pass/fail report with exact evidence",
      "acceptanceCriteria": ["Every acceptance criterion has evidence"],
      "dependsOn": ["implementation", "documentation", "inventory"],
      "lifecycle": "subagent",
      "workspaceMode": "shared-read-only",
      "taskShape": "complex/open-ended"
    }
  ]
}
```

Pipe it without shell-encoding multiline JSON:

```bash
nelos plan slices --spec-file - < slice-plan.json
```

The result has three waves:

| Wave | Concurrent slices | Default route |
| --- | --- | --- |
| 1 | `architecture`, `inventory` | Sol/Medium, Terra/Low |
| 2 | `implementation`, `documentation` | Terra/Low, Luna/Low |
| 3 | `verification` | Sol/Medium |

Every launch member now carries an explicit `memberKind` and `launcher`.
`spinoff` maps to `memberKind: "spinoff"` and `launcher: "create-thread"`;
`subagent` maps to `memberKind: "joined-subagent"` and
`launcher: "spawn-subagent"`. A joined subagent is controlled through its
canonical `agentPath`; a durable spinoff is controlled through its `threadId`.
The queen must not describe or route one as the other. The queen passes the slice's
`route.launch.nativeTask` unchanged to that launcher. It launches only the
current wave, gives each concurrent writer a different worktree, waits for
accepted results, and then unlocks the next wave. Durable slices become sidebar
spinoffs; bounded subagents return to the queen.

The route is fail-closed. The queen must not omit or substitute a decided model
or reasoning value when native task creation requires additional authorization.
It obtains approval for the exact values or does not launch. After creation it
runs `nelos intelligence verify` for the returned task ID and expected
route. Work from an unverified or mismatched member cannot settle a wave or
enter queen acceptance. A spinoff launcher result without a native `threadId`
fails closed. A joined-subagent result instead requires its exact `agentPath`;
its resolved internal thread ID remains verification evidence, not its control
handle.

## Overrides and Guardrails

Each slice may include a `routing` object with `profile`, `model`, or `effort`.
Model and reasoning are independent, so omitting either dimension preserves its
task-shape recommendation. Explicit values still pass the same reviewed
catalog. Ultra additionally requires `nativeFanoutAllowed: true` and a Sol or
Terra route.

The planner rejects unknown fields, duplicate or cyclic dependencies, unsafe
shared concurrent writers, unsupported task shapes, plans larger than 32
slices, and concurrency above eight. It only plans and routes; task creation,
worktree provisioning, acceptance, integration, and archival remain explicit
queen or user actions.
