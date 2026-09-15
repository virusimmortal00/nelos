# Executor admission and recovery

Current implementation: [owned executor plan runbook](owned-executor-plan-runbook.md).
The milestone sections below retain their historical scope.

Development contract, 2026-09-02. This implements the service-side boundary in
the [owned App Server design](mcp-owned-app-server-execution.md). It does not
enable an MCP execution tool or certify a runtime.

## Scoped grants

`ExecutorGrantAuthorityV1` keeps grants in private service memory. `issue`
accepts only a normalized execution wave; `validate` accepts only that wave and
an opaque grant ID. Neither accepts a host-capability receipt or user-intent
boolean. The gate resolves the ID against the same authority instance. Restart,
revocation, expiry, or changed execution context invalidates it.

An execution wave includes its existing planner identity and a separate digest
over every member's work-unit revision, attempt, launch sequence, host, Codex
home, repository, final cwd, workspace mode, exact model/effort, permission
profile, approval policy, title, and prompt digest. The digest uses the
normalized contract's JSON encoding. Member order and object key order do not
change the normalized digest. The prompt digest is `executorDigest(prompt)`.
Target paths are retained verbatim; the work host must validate their canonical
placement. A source-machine path resolver must not rewrite a foreign path.

The service installs two trusted providers at construction:

- `evaluate(scope, {signal})` verifies placement, the actual adapter and required
  operations, interaction support, live configuration/account identity, and
  a runtime certification record. It returns the exact scope digest, service
  and owner epoch, loaded runtime generation, account/config fingerprints,
  certification ID, freshness deadline, available operations, and interaction
  mode. Discovery alone is insufficient evidence for this provider.
- `authorize(scope, {context, signal})` uses the host's actual authorization
  channel and returns an allowed decision bound to both the scope digest and
  context fingerprint, with its own expiry and decision ID. A missing or
  non-allowing authorizer produces an authorization requirement.

These are dependency interfaces, not claims that Codex currently supplies a
host attestation API. They must never be selected, implemented, or populated
from MCP argument objects. No production providers are installed by this
change. The default authority cannot grant execution.

Context is rechecked after authorization and at every admission. Required
operations are creation, turn start, observation, result reads, and interruption.
Without an interactive channel, the first contract only accepts an explicitly
preauthorized unattended route with an already selected `never` approval policy;
it never changes policy itself. Grant count, outstanding provider callbacks,
provider deadlines, and lifetime are bounded. Providers must honor cancellation;
late callbacks cannot issue a grant after timeout or shutdown.

The authority protects the service API from fabricated JSON claims. It does
not protect against arbitrary code execution inside the service or a compromised
host user. Service-channel access control and runtime certification remain
required before rollout.

## Launch recovery

`ExecutorLaunchJournalV1` stores one bounded private record per work unit, with
separate creation and turn identities. It uses the existing process-start-aware
lock protocol in the service's own directory, compare-and-set revisions,
exclusive temporary files, file sync, atomic rename, and directory sync.
The caller must wait for the dispatch transition to finish before calling
App Server. A failed durable write never permits dispatch.

The initial sequence is `prepared → create-dispatched → thread-bound →
turn-dispatched → running → terminal`. Failure after a dispatch transition is
`outcome-unknown`, with its create/turn stage preserved. Reconciliation may bind
an independently verified identity; an empty listing or timeout cannot permit
creation again. This version conservatively treats even post-dispatch RPC
errors as requiring reconciliation rather than assuming they prove non-execution.

Only `prepared` may become `not-executed`. A fresh launch must advance the
sequence by exactly one, use a fresh grant and operation ID, and retain the
closed operation. At most 32 operations and 512 KiB are retained per work unit;
exhaustion requires attention. Prompts are private, bounded to 32 KiB each, and
must match their approved digests. Journal records are service state, never a
tool response or diagnostic transcript.

`proveNotExecuted` produces an in-process opaque proof backed by the persisted
closed operation. `ExecutionStoreV1.releaseUndispatchedLaunch` accepts this
proof, checks the exact pending action, revision, and attempt, and restores the
initial unbound state. A serialized or fabricated proof is rejected. Journal
closure precedes store recovery, so a restart between the two steps can safely
repeat recovery. A late receipt from the old operation cannot bind the new one.
Bound tasks and replacement bindings cannot be reset through this path.

The proof is about the owned executor's recorded dispatch protocol. Legacy
native `launch-pending` records have no such evidence and remain reconciliation
cases. This module does not retrospectively assert that their native tool was
never called. It also does not install a supervisor or start an App Server.

## Launch coordinator

`ExecutorLaunchCoordinatorV1` joins grants, the journal, and the work-unit store.
It validates the entire wave's definitions and prompt digests before creating
anything, then acquires the existing per-work-unit orchestration lock. The
service supplies bounded `createThread`, `setTitle`, and `startTurn` effects.
These providers must project actual App Server responses, not echo their inputs.

For each member, the coordinator revalidates admission before intent and again
before the effect. It persists the returned creation identity immediately, binds
the work unit, verifies effective model/cwd/permission-profile/approval-policy
metadata, verifies the title, and only then starts and records the turn. A
deterministic client message ID correlates that turn; it does not claim upstream
idempotency. Runtime mutation fencing covers durable commits and effect entry.

Repeated calls report an existing operation without invoking creation or turn
start again. An unresolved earlier operation blocks wave dispatch. Partial
waves retain every already-started member and stop at the first member requiring
reconciliation. Effect deadlines do not make an unknown outcome safe to retry.

`recover(workUnitId)` reconciles local journal/store state only. It closes a
prepared operation as unexecuted, turns stranded dispatch intent into an unknown
outcome, and repairs a binding from a journaled task ID. It makes no App Server
call. Created-but-not-started tasks, running tasks, and uncertain outcomes still
require upstream observation and an explicitly authorized continuation path.
The current effect tests are isolated fixtures, not remote runtime certification.

Production wiring still requires a service entrypoint/channel, actual target and
worktree verification, the trusted policy/certification providers, a real UI
adapter for the approval relay, and persisted result evidence for parent join. The legacy
native launch gate remains available under its existing contract; this new path
is not enabled in the MCP tool surface yet.

## Typed App Server effects

`ExecutorAppServerEffectsV1` implements the coordinator's effects over the owned
stdio session. The generated 0.152.0 schema supplies the exact request fields:
`thread/start`, `thread/name/set`, `thread/read`, `turn/start`, and
`turn/interrupt`. Creation and turn start select the approved model, named
permission profile, cwd and approval policy explicitly. Turns also select the
approved effort and prompt. Inherited environments and provider model fallback
are disabled to preserve execution on the verified work host and exact route.
The adapter does not override the configured approval reviewer; the trusted
policy provider must verify that review configuration as part of admission.

The adapter requires a service-installed target verifier before creation and
again before turn start. It records ownership only from creation responses,
checks both returned cwd fields, preserves the creation identity on effective
policy mismatch, verifies titles by readback, and rejects foreign IDs and
duplicate starts. Events and approval requests arriving before a turn-start
response wait for its returned identity rather than asserting ownership.

`readResult` reads the exact owned turn, bounds history and assistant text,
rejects partial history, and passes only the projected assistant messages to
the existing work-result classifier. A completed turn is not automatically a
successful or accepted deliverable. Interruption requires the same owned turn;
its acknowledgment is not completion evidence. These operations are private
service APIs, not model-callable tools. The integrated launch test uses fake
App Server traffic and fake admission providers, not a live worker or runtime
certification.

## Owner lifecycle

`ExecutorServiceSupervisorV1` elects one owner using the existing process-start
identity lock, scoped to the host, Codex home, and authentication domain in a
private canonical service directory. It opens the owned session only after
election. The lock remains held until the actual child exits, including the
shutdown grace period. Startup failure and connection loss invalidate clients;
neither silently starts another session. Runtime generation and owner epoch are
available to the service's trusted admission provider.

Frontend attachments and activity holds are opaque in-process values. Detach
does not terminate the service. A worker or uncertain launch must retain its
hold through durable completion or reconciliation. Draining rejects new work
but lets clients reconnect and existing workers obtain approvals. The session
stops after all work and approval holds are released. A live but unresponsive
owner is never displaced merely because a heartbeat or request timed out.

This supplies the election/lifetime core, not a daemon entrypoint or IPC
transport. The eventual private channel must authenticate connections, expose
typed operations, and bind its attachments and holds to these service-owned
values. Frontends must not deserialize activity tokens or release worker holds.

## Interaction and completion

`ExecutorApprovalRelayV1` accepts a channel installed by the service's trusted
UI adapter. Each user answer carries a fresh opaque callback token and must
still match a live owned turn when the decision arrives. Upstream request
resolution, disconnect, channel replacement, shutdown, and timeout cancel the
answer. Callbacks that ignore cancellation retain their bounded capacity until
they settle. Missing channels cancel requests; caller-supplied booleans cannot
approve them. The relay retains no request transcript in its status output.

The first reviewed response subset covers per-request command/file decisions,
question-ID-bound user input, and standard form/URL MCP elicitations correlated
to an owned turn. Session/persistent approvals, policy amendments, permission
expansion requests, uncorrelated MCP elicitations, OpenAI form extensions,
dynamic tools, and token refresh need separate adapters/contracts. They are not
silently accepted. No production UI channel is installed by this change.

The service must route notifications to the effects adapter's
`observeNotification`. An owned `turn/completed` event immediately revokes
approval eligibility and requests a result read. It never asserts deliverable
acceptance. `collectResult(workUnitId)` on the coordinator checks the current
binding, reads the recorded turn through the typed effects adapter, validates
the result's work-unit/revision/attempt scope, and durably records terminal
transport status. Repeated reads do not start more work, and a contradictory
terminal status requires attention. The existing result classifier distinguishes
valid structured results from plain text, failures, and missing results.

The journal now atomically persists terminal status and the bounded validated
result classification, including an exact work-unit/revision/attempt envelope
when present. `collectResult` can replay that evidence after an owner restart
without contacting or claiming ownership of an upstream task. It rechecks the
current binding before returning cached evidence. An explicit `refresh: true`
reads upstream again and rejects contradictory status or payload. Existing V1
journals with terminal status alone still require a result read. No transcript
is persisted, and transport completion never implies queen acceptance.

Active-turn restart recovery/reattachment, automatic parent wake and general
production scheduling still need integration. The bounded parent join and
service attachment are described in the September 11 milestone below.
The fixture now exercises create → bind → title → start → read → terminal
recording, alongside early approvals and late-answer cancellation. This remains
fixture coverage rather than a remote execution canary.

## Composed service runtime

`ExecutorServiceRuntimeV1` now composes the session, owner supervisor, approval
relay, grant authority, effects, journal, coordinator and private work-unit store.
It wires terminal notifications into asynchronous durable collection without
blocking notification delivery on the work-unit lock. Pending collections are
bounded and duplicate reads are coalesced. Failed collection retains the work
hold and reports attention; an explicit collection can retry the read.

Wave admission reserves service-owned work holds before awaiting the launch
coordinator. Concurrent calls share each work-unit hold. Frontend detachment
cannot release them, and drain rejects new waves while permitting existing
approvals and collection. Only saved result evidence, proven non-dispatch, or
the absence of an owned operation releases a hold. Approval holds remain until
the relay returns, including when terminal collection finishes first. Unknown
launch outcomes retain their holds for reconciliation. Scope checks bind grants
to this supervisor's owner epoch, runtime generation, host and Codex-home ID;
interactive admission also requires a connected relay channel.

The runtime is an internal composition API, not an externally authenticated
control channel. Its attachment tokens remain opaque in-process objects.
Policy/certification evaluation, authorization, worktree target verification and
the user-interaction adapter are constructor-installed dependencies. Missing
providers deny execution. The constructor does not provide a production policy
or treat caller JSON as authorization. Production discovery/provisioning,
active-operation ownership reattachment and general product integration remain
rollout requirements. Runtime unit tests use a simulated stdio server; the
service milestone below also includes live canaries.

## Restart admission barrier

Before exposing attachments, `start()` inventories the private journal while
holding the supervisor's owner election. It validates every record and hashed
filename, rejects symlinks and unexpected entries, and bounds the inventory to
256 records and 1,024 directory entries. Known atomic-write and lock remnants
are not committed dispatch evidence. A missing, malformed, foreign-host or
wrong-Codex-home record fails startup and closes the replacement session.

The runtime reserves work holds for every inventoried unit. It then uses the
coordinator to reconcile local bindings: `prepared` can become `not-executed`
and release the exact pending binding; dispatch records become uncertain;
recorded thread identities can repair the private unit binding. Saved terminal
results are checked against that binding before releasing their holds. No old
thread is adopted by the replacement session and no upstream mutation is
replayed. Without a trusted recorded-result reader, terminal status without saved
result evidence remains unresolved. The job service reader is described below.

`status().acceptingLaunches` is false throughout scanning and while any startup
record needs reconciliation. After inventory, attachments can inspect/recover
records and replay valid saved results, but grant issuance and all new waves
remain blocked until every startup record is settled. Frontend detach or drain
does not discard those holds. Empty App Server listings play no role in this
decision. Inventory failure is not a clean start.

This supplies the conservative startup barrier. A reviewed protocol to
reattach active/unknown upstream ownership is still required before such a
replacement owner can resume work automatically. The current implementation
reports attention instead of claiming a recovery it cannot prove. The later
recorded-result reader can reconcile exact known turns without acquiring live
ownership.

## First parent-facing service job

`ExecutorJobServiceV1` adds a deliberately narrow operator policy over the
runtime: one immutable, preauthorized, shared read-only worker in a canonical
Git repository, using Codex-managed authentication. Model and effort are
explicit. The service checks the live account, model, permissions, requirements
and effective configuration before issuing and consuming a grant. Configuration
fingerprints ignore JSON map key order but retain values and array order.
CLI versions remain informational. A missing capability affects that operation.

Start the owner separately from the MCP frontend:

```sh
node bin/nelos-executor-service /absolute/private/job-policy.json /absolute/private/service
node bin/nelos-mcp --executor-endpoint /absolute/private/service/endpoint.json
```

The policy schema is implemented by `normalizeExecutorJobV1`; the runnable
canary below constructs a complete example. The JSON policy must be a private
0600 regular file inside a canonical 0700 directory owned by the current user.
The service directory is bound to the normalized policy digest, including its
expiry. Restart uses that same policy; a different job needs a new directory.
The short Unix socket path must fit within 100 bytes. Descriptor, socket and
bearer credential are private to the OS user. This protects against other users,
not another process already able to read and write as the same user.

The explicit endpoint option adds `nelos_owned_status`, `nelos_owned_launch`,
`nelos_owned_collect`, and `nelos_owned_join`. A normal plugin instance retains
its ordinary tool surface. Endpoint connection is lazy; an unavailable service
does not prevent MCP initialization or use of ordinary tools. Never add this
parent-only endpoint to the global configuration inherited by workers.
Frontend JSON cannot replace the job, grant permissions, install providers or
supply result evidence. The parent explicitly accepts or rejects independently
reviewed evidence; the service records that decision against the saved native
thread/turn binding and derives readiness. Conflicting decisions are rejected.

Disconnecting a frontend does not terminate service-owned work. An explicit
repeat launch returns the recorded operation instead of creating another thread
or turn, including when the outcome is uncertain. The client never automatically
replays a failed request. Service restart rotates its endpoint credential after
proving any old listener is stopped; live or indeterminate listeners are retained.
Saved terminal evidence and parent decisions remain available after restart.
Active or unknown operations still require reconciliation and cannot be adopted
automatically. SIGTERM/SIGINT drain the owner; unresolved work keeps its hold.

Run a real signed-in canary explicitly, outside the offline test suite:

```sh
npm run verify:owned-executor -- /absolute/codex /absolute/codex-home host-id parent-task-id
```

It uses separate service and MCP processes, a temporary Git repository, Astra
at medium effort, read-only permissions, and no approval prompts. The parent
client has isolated state and an empty client home; the service uses the specified
real Codex home and sign-in. This avoids mixing the test frontend with installed
plugin generations while preserving normal runtime integrity checks. The parent
compares a random file marker with the worker's result, accepts it, restarts the
completed service, and verifies the persisted result and decision. Private
artifacts are retained for inspection. On failure, uncertain work is retained
for recovery rather than killed or replayed.

[Live evidence](owned-service-canary-2026-09-11.json) records successful runs on
m3's standalone and updated Desktop-bundled CLIs. This verifies the bounded
service/MCP path. It is not general runtime certification, Desktop UI lineage
verification, dynamic plan scheduling, multiple-worktree coverage, an interactive
approval adapter, or automatic parent wake-up. Those remain later milestones,
along with migration of legacy pending launch receipts. The explicit parent ID
is operator-configured; no Desktop-native parent relationship is inferred.

## Recovery of recorded turns after owner loss

The fixed read-only job service now installs a trusted recorded-result reader.
At startup, the owner can read the exact native thread and turn from its private
journal when the operation was `running` or `terminal`. It verifies the private
work-unit binding, approved job scope, canonical repository identity, Codex home
and account fingerprint. Account and target checks bracket the upstream read;
returned history must match the expected thread, turn and repository. Changed
launch settings or an expired launch approval do not prevent reading already
recorded work. Cached evidence still follows its existing private-store checks.

This uses `thread/read` with turns included. The [official App Server documentation](https://learn.chatgpt.com/docs/app-server)
distinguishes reading stored history from loading a thread with `thread/resume`.
Recovery never installs the recorded thread in the effects layer's live ownership
map, so it cannot answer approvals, interrupt, steer, resume or start that turn.
Frontend inputs cannot choose an arbitrary recovery thread or grant this access.
The generic runtime keeps this reader disabled unless the service installs the
validation callback.

An observed terminal status and validated result classification are persisted
before the service releases its work hold. Interrupted or failed work is not
accepted as successful work. A known running turn can be observed again through
`nelos_owned_collect`; it keeps its hold and admission barrier until an actual
terminal observation arrives. Missing turns, incomplete history, changed account
fingerprints and target mismatches remain unresolved. A lost creation/start reply
without a recorded turn ID still cannot authorize lookup-based adoption or replay.

Run the explicit crash canary with the final `crash` argument:

```sh
npm run verify:owned-executor -- /absolute/codex /absolute/codex-home host-id parent-task-id crash
```

The driver first verifies that its newly created worker is in progress, closes
its MCP frontend, and sends SIGKILL only to its own detached service process.
It starts a replacement owner, waits for a rotated endpoint, verifies reuse of
the original thread and turn, and collects the preserved upstream outcome. It
then restarts once more to check the recovered cache. [Live evidence](owned-recovery-canary-2026-09-11.json)
records this flow on m3 with CLI 0.154.0 and Desktop-bundled 0.154.0-alpha.6.2.
Both reported `interrupted`, with unknown work outcome and no parent acceptance;
neither created another turn. These are observed outcomes, not a claim that
all Codex versions finish an interrupted turn in the same way.

This milestone reconciles recorded execution history. It does not revive model
execution killed with the old App Server. A new attempt needs a separate policy
and authorization flow; automatic retry, unknown-ID reconciliation, parent wake,
interactive approvals and broader scheduling remain later work.

## Bounded preauthorized retries

An optional V2 operator policy adds a family of two or three explicitly approved
attempts. The existing V1 single-job policy and ordinary plugin tools continue
to work. The same service entry point selects the implementation from the policy:

```json
{
  "schemaVersion": 2,
  "attempts": ["complete V1 policy for attempt 1", "complete V1 policy for attempt 2"]
}
```

The strings above stand for full policy objects, not file paths. The runnable
`retry` canary below constructs a complete example. Each policy has the same
host, canonical repository, Codex home, model, reasoning effort, permissions,
expiry, work-unit identity and definition. Attempts are consecutively numbered
from one; `policy.maxAttempts` equals the configured family size. Only the
approved prompt bytes and their digests can differ to express the correct
result-envelope attempt. The current policy remains shared read-only with
approval `never`. This is not an editable frontend authorization proposal.

`nelos_owned_retry` takes only `expectedAttempt`, the attempt being replaced.
The service first collects that attempt's result and requires a persisted
`interrupted` status, matching private work-unit binding, and no successful work
outcome. Running, successful, failed, missing-ID and unresolved operations cannot
advance. An expired policy or exhausted family cannot advance either. These
choices are explicit policy limits, not CLI version gates.

The service records a durable retry marker that binds the predecessor's exact
operation/thread/turn, result digest and next policy digest. It drains the old
job's owner and opens the next job in a separate private attempt directory. Each
attempt retains its original binding, journal, grant and result. A family-wide
owner lock prevents concurrent service instances from independently advancing.
No new model turn is sent before the retry selection is persisted, and the new
attempt gets a fresh account/config/capability check and execution grant.

A repeated `expectedAttempt: 1` can finish or report attempt two; it never
advances to attempt three. Disconnects and lost responses do not change that.
Restart verifies each retry marker against the previous attempt's preserved
evidence. A selected attempt that has not launched remains selected; an explicit
retry or launch request can obtain a fresh grant later. Unknown dispatch outcomes
remain owned operations requiring reconciliation rather than permission to replay.

`nelos_owned_status` reports the current attempt, maximum attempts and prior
transition identities. A V2 `nelos_owned_join` requires `expectedAttempt` matching
the current attempt, so a delayed acceptance cannot apply to a different worker.
V1 joins also accept this field when supplied, while preserving their older
argument shape. V1 retry requests return `retry-not-configured` and do not affect
other tools.

```sh
npm run verify:owned-executor -- /absolute/codex /absolute/codex-home host-id parent-task-id retry
```

This canary approves two read-only attempts, kills only its own first service
while Astra is running, verifies the interruption, requests the next attempt,
and independently checks its random file marker. It tests repeated retry calls,
a fresh MCP frontend, parent acceptance of attempt two, completed-service restart
and the attempt limit. [Live results](owned-retry-canary-2026-09-11.json) cover
m3's standalone CLI 0.154.0 and Desktop-bundled 0.154.0-alpha.6.2.

### Automatic retry scheduling

V2 policies can explicitly opt into owner-side scheduling by adding
`"automaticRetry": { "intervalMs": 1000 }`. The integer interval is bounded to
1–60 seconds and included in the immutable policy binding. Omitting the field
preserves the prior manual behavior and policy digest. Frontends cannot enable
it or alter the approved prompts, attempt count, expiry, or execution scope.

The owner periodically collects the current recorded operation. Startup does
not launch an unused first attempt. Once the parent launches it, a confirmed
interruption can advance through the same persisted retry transition used by
`nelos_owned_retry`. Scheduling continues with no MCP frontend connected and
resumes after owner restart. A selected retry with no recorded operation can
obtain a fresh grant; an existing operation is collected, never dispatched again.
Running, unknown, failed and successful operations cannot trigger a replacement.
Terminal success or failure and the attempt limit stop the timer. Expired retry
authorization stops scheduling with a status reason; historical collection
remains available to the parent.

Timer work and parent requests share one serialized queue. Drain cancels the
timer and prevents another launch. Transient collection/admission failures use
exponential backoff capped at 60 seconds. `nelos_owned_status.automaticRetry`
reports whether scheduling is enabled, its next check time, and the last error
code. Backoff resets after a successful check and on owner restart. Results
still require the parent's explicit, attempt-specific acceptance.

```sh
npm run verify:owned-executor -- /absolute/codex /absolute/codex-home host-id parent-task-id automatic-retry
```

The automatic canary crashes its first owner during a live turn, starts a new
owner, and keeps the MCP frontend disconnected until the second attempt's
terminal result is durable. It then independently verifies the file marker,
joins attempt two, restarts the owner, and checks replay and attempt limits.
See [live evidence](owned-automatic-retry-canary-2026-09-11.json).

Parent wake delivery is still open. The existing spin-off lifecycle emits a
host-owned `native-send-message` effect and requires an exact host receipt;
that is not an unattended sender connected to the owned executor. A future
adapter must deliver persisted completion identity through the parent host and
reconcile uncertain sends. The worker's separate App Server must not resume or
steer the live parent as a substitute. Non-interruption retry policies,
write-capable workers, unknown-ID recovery, and general scheduling also remain
separate rollout work.


### Durable completion inbox

Every owned V1 job and V2 attempt now projects validated terminal evidence into
its private `notifications/completion.json` outbox. Projection finishes before
the runtime releases the work hold. If projection fails, the journal still
contains the result and the service reports attention. A later collection or
owner restart repairs the notice from that evidence. Retry selection waits for
the predecessor's hold to settle, avoiding a drain that would strand the parent
request queue when the outbox is unavailable.

Two optional parent MCP tools expose this handoff:

- `nelos_owned_notifications({})` returns all terminal notices for the attached
  job's selected attempts, including which receipts were acknowledged.
- `nelos_owned_acknowledge({ notificationId, expectedAttempt })` durably records
  receipt of that exact notice. It can acknowledge an earlier retry attempt.
  It never creates a parent acceptance decision or claims a native message was
  sent. Replaying an acknowledgment after a lost response returns the same state.

Each notice binds the normalized policy digest, configured parent, work-unit
identity and attempt, native operation/thread/turn, terminal status and result
digest. It contains no prompt, credentials, transcript or model-authored summary.
There is at most one notice per attempt and at most three in the current retry
family. Reads revalidate its identity against the private journal and work-unit
binding. A receipt from a different attempt, job or parent cannot acknowledge it.
The private endpoint grants access to the configured job; it is not a claim that
Codex authenticated the caller as the configured native parent thread.

Records use a serialized private write, file sync, atomic rename and directory
sync. Projection preserves acknowledgment state. Startup reconstructs a missing
notice after a crash between terminal persistence and projection. MCP responses
can be lost or repeated, so the parent deduplicates by `notificationId`; this is
an at-least-once inbox, not an exactly-once native messaging guarantee. The parent
must still collect the bounded result and explicitly join the current attempt.

The `automatic-retry` canary now checks that both attempts' notices exist before
reconnecting any parent frontend. It then acknowledges each exact notice, repeats
the calls, restarts the service and checks that acknowledgment state survives.
[Live completion-inbox evidence](owned-completion-inbox-canary-2026-09-11.json)
covers both installed m3 Codex builds. Offline tests additionally discard an
acknowledgment response after persistence and replay it through a fresh owner.

`completionDelivery.detachedWakeAvailable` and notification responses explicitly
remain false. The parent must poll or stay in its join loop. The installed schema
contains experimental queue methods, but the current
[official App Server documentation](https://learn.chatgpt.com/docs/app-server)
does not establish cross-owner wake delivery or deduplication. Connecting this
outbox to a verified host sender, including reconciliation of uncertain sends,
remains the next integration step. The owned worker service does not resume,
steer, or fabricate a native send receipt for the parent.
