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
| Coordination | `unjoined`, `waiting`, `collected`, `correction-pending`, `accepted`, `detached` |

Required result-bearing members must receive `observe` and `read-result`; new
registrations that omit `read-result` fail before persistence. Optional
observe-only members are non-result-bearing and cannot block collection. A
legacy required observe-only member returns a diagnostic naming the member and
missing capability plus an idempotent `orchestration-repair-member` detach
action boundary. The shipped task-management skill submits its exact detach
receipt before continuing. Its consumed repair receipt is retained in the checkpoint audit
history. `archive` is granted to durable spinoffs by default so the
terminal cleanup policy can be honored; explicit `cleanupIntended: false`
removes it. The built-in policy automatically archives only after exact-current
acceptance; users can configure `ask` or `keep`. Joined subagents can never
receive archive authority. The first eligible cleanup call snapshots the
policy for the web so later global changes cannot alter an in-flight archive
or confirmation sequence.

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

## Multiple plans in one web

An observation checkpoint remains bounded to one verified wave. Plan IDs are
content hashes, not a chronological or readiness ordering. Scope selection
keeps an unfinished checkpoint's plan stable; after that plan settles, it
resumes another unfinished verified plan before returning web completion. Within a
plan, a settled latest wave cannot hide an older unresolved verified wave.
Recovery compares the full plan, wave index, and digest; receipt replay stays
pinned to its exact verified wave and never launches an already verified wave again.
Verified replans supersede their own lineage only. A submitted receipt remains
bound to the checkpoint that issued it; a changed or superseded wave rejects
the receipt instead of applying it to another plan. When a settled plan's
receipt is replayed while other work remains, the returned next action resumes
orchestration rather than reporting completion.

Settled means every wave is verified, each required current binding has matching
successful acceptance, and every wave containing spinoffs has a durable cleanup
completion. Cleanup may record archival or an intentional keep policy. Native
`notLoaded`, idle, or terminal status alone does not establish acceptance.

Web inspection includes all execution bindings, even outside this checkpoint.
An untracked required bound member contributes to `persistedAttentionRequired`
unless every applicable wave has current acceptance and cleanup evidence.
Superseded ancestors are excluded, but an independent plan sharing the same
slice ID must also settle before inspection suppresses attention. Accepted and
cleaned historical waves therefore do not produce false recovery alarms. Final-wave spinoff cleanup returns an explicit orchestration advance so independent unfinished plans are revisited before web completion.
This count indicates missing coordination evidence, not permission to archive.

## Offline incident verification

The sanitized fixture in `test/fixtures/unresolved-spinoffs.json` records the
September 21 incident's structural facts: three blocked spinoffs with older
rejections, a separate accepted and cleaned plan, and a checkpoint containing
only that finished plan. IDs, titles, and results are synthetic; no transcripts,
credentials, production paths, or external-service payloads are retained.

| Layer | Real behavior under test | Replaced boundary |
| --- | --- | --- |
| `observation-scope.test.mjs` | Plan selection, lineage, settlement, receipt scope | Plain deterministic inputs; no I/O |
| `unresolved-spinoffs.test.mjs` | Validators, plan/execution/acceptance/checkpoint stores, restart, receipt replay, inspection, cleanup eligibility | Native task metadata and configuration preference |
| Existing observation and lifecycle tests | Dependency waves, title/wait/result receipts, correction, acceptance, cleanup effects | Host responses and task mutations |
| Planning lifecycle verifier | MCP process, stdio, persistence, restart, protocol wiring | Separate fake Codex app-server process |

Run the focused incident and boundary tests with networking disabled:

```sh
NODE_OPTIONS=--require=./scripts/offline-network-blocker.cjs \
  node --import ./scripts/test-bootstrap.mjs --test \
  test/observation-scope.test.mjs test/unresolved-spinoffs.test.mjs \
  test/mcp-observation.test.mjs test/web-inspection.test.mjs \
  test/spinoff-lifecycle.test.mjs test/mcp-queen-decision.test.mjs \
  test/orchestration-observation.test.mjs test/plan-run-store.test.mjs
```

The incident harness uses disposable directories for both stores and locks.
Assertions establish that blocked members never emit archive effects and that
recovery never invents acceptance. No models, live task creation, provider
accounts, or installed-plugin state are involved. These tests do not establish
that a released plugin was loaded by Desktop or that a real archive succeeded;
those are separate deployment/host checks.

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
- `native-follow-up-delivered` consumes the exact typed correction action for
  a rejected source turn and advances the same bound task to the next attempt.
  The next wait and result-read action IDs include that new attempt and exact
  later native turn. A rejection without follow-up capability or remaining
  attempt budget surfaces attention without emitting an unusable correction.
- `orchestration-member-repaired` detaches only the exact legacy required
  member identified by the repair effect. It cannot replace or discard an
  accepted result.

## Pure join reducer

`reduceObservationJoinV1()` has no filesystem, clock, network, or process
dependency. In deterministic member order it emits:

1. pending title observation or fallback-rename effects independently of
   execution;
2. at most one batched wait for required, nonterminal, unaccepted members;
3. current-turn result reads for terminal members without a current result;
4. same-task follow-up effects for rejected results in `correction-pending`;
5. audited detach repair effects for impossible legacy members;
6. `decide` only after every required member has a current successful result;
7. `continue` only after exact queen acceptance.

Detached members do not block the join. The `continue` boundary includes
`automaticWake: false`: it instructs the active parent callback and does not
claim completion restarts an already-ended Desktop turn. A later parent
invocation reconstructs the same outstanding work from the checkpoint.
