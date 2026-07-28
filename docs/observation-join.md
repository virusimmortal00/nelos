# Durable Host Observation and Parent Join

Status: implemented callback contract, July 2026.

## Boundary

Nelos persists host observations and computes the next coordination action.
The Codex host remains authoritative for title changes, task status, waiting,
and result reads. No observation module starts, discovers, or connects to an
app-server process.

`nelos_orchestrate_advance` follows one callback loop:

1. read current `ExecutionStoreV1` records and the separate web checkpoint;
2. validate and atomically consume at most one host receipt;
3. incorporate exact current queen-acceptance provenance;
4. reduce the checkpoint;
5. return typed host effects and a `waiting`, `attention`, `decide`, or
   `continue` boundary; and
6. when every required current result is accepted, return the exact
   `nelos_spinoff_cleanup` next action.

The caller executes returned effects and submits the receipt on the next call.
An exact receipt replay is a no-op. Reusing an action ID with different content
fails closed. Receipt digests retain the newest 1,000-action replay window;
older identities are compacted before persistence so long-running timeout loops
cannot exceed the checkpoint schema bound.

At a `decide` boundary, the queen submits the exact consumed
`native-result-read` receipt to `nelos_queen_decide` with a versioned accepted
or rejected decision. The operation verifies the persisted checkpoint, current
durable binding, calling queen, and latest successful host turn before
recording through `QueenAcceptanceStoreV1`. It returns the unchanged arguments
for the next `nelos_orchestrate_advance`; that call projects an exact accepted
decision into member coordination and emits the cleanup action. Cleanup is not
attempted before this advance reports acceptance.

## Durable checkpoint

Checkpoints live under the private Nelos task-state directory, separately from
legacy execution files. A checkpoint is keyed by `{webId, queenThreadId}` and
uses revision-checked atomic replacement under a web-scoped process lock.

Each bound member has four orthogonal state groups:

| Group | States |
| --- | --- |
| Title | `pending`, `verified`, `attention` |
| Execution | `unknown`, `waiting`, `running`, `terminal`, `attention` |
| Result | `absent`, `current`, `stale`, `malformed` |
| Coordination | `unjoined`, `waiting`, `collected`, `accepted`, `detached` |

Required planned members receive `observe` and `read-result` so their final
envelope can become acceptance evidence. Lower-level contracts may deliberately
be observe-only; when such a member reaches a terminal turn, Nelos emits no
result-read effect and returns `attention` rather than fabricating a result or
claiming acceptance. `archive` is granted to durable spinoffs by default so the
terminal cleanup policy can be honored; explicit `cleanupIntended: false`
removes it. Authority does not imply mutation: the default policy still asks.
Joined subagents can never receive it.

A title mismatch never changes execution or result state. A terminal task does
not imply a current result. A collected result does not imply queen acceptance.
Acceptance is incorporated only when its member, revision, attempt, and source
turn match the checkpoint's current result.

Migration is lazy. Bound version-1 execution records synthesize fresh
observation members. Unbound and launch-pending records produce no observation
effects and keep the boundary at `waiting`; an unknown web fails closed rather
than implying continuation. A changed revision, attempt, binding generation, or member task ID
invalidates old evidence. Observation migration never rewrites an
`ExecutionStoreV1` file.

## Strict receipts

All receipts use `schemaVersion: 1`, reject unknown or missing fields, and
carry the exact action ID.

- `native-title-observed` carries revision, attempt, binding generation,
  member task ID, requested title, and observed title. Exact equality verifies
  the title. The first effect is `native-read-title`, because launch prompts
  already seed short intended titles. Only a mismatch advances to a bounded
  `native-set-title` fallback; repeated mismatch ends in title `attention`
  without changing execution.
- `native-wait` carries web and queen identity, `event | timeout`, and the
  exact target set. Every target carries revision, attempt, binding generation,
  member/host IDs, expected `afterCursor`, opaque `nextCursor`, lifecycle,
  latest turn ID, and attention state. Cursors are compared only for equality.
  Completed and failed lifecycles require a non-null latest turn ID. A failed
  lifecycle always moves execution to attention even if the host's explicit
  attention flag is false.
  Every accepted timeout increments the wait generation even when cursors do
  not change.
- `native-result-read` carries the requested latest turn, actual source turn,
  binding identity, and bounded result envelope. A result is `current` only
  when its source turn, revision, and attempt match current state. Corrective
  turns invalidate earlier result provenance.

## Pure join reducer

`reduceObservationJoinV1()` has no filesystem, clock, network, or process
dependency. In deterministic member order it emits:

1. pending title observation or fallback-rename effects independently of
   execution;
2. at most one batched wait for required, nonterminal, unaccepted members;
3. current-turn result reads for terminal members without a current result;
4. `decide` only after every required member has a current successful result;
5. `continue` only after exact queen acceptance.

Detached members do not block the join. The `continue` boundary includes
`automaticWake: false`: it instructs the active parent callback and does not
claim completion restarts an already-ended Desktop turn. A later parent
invocation reconstructs the same outstanding work from the checkpoint.
