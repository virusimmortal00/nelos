# Owned executor approach audit and continuation

The [2026-09-11 compatibility report](codex-compatibility-2026-09-11.md) supersedes
the installed-version observations below. Commit `d8784ab` adds explicit Astra
routing, generated-schema checks and signed-in read-only probes for installed
CLI 0.153.4, public CLI 0.154.0, and latest Desktop's 0.154.0-alpha.6.1. Commit
`6b0e722` adds a bounded journal inventory and startup admission
barrier, with cached-result replay and conservative handling of unfinished
operations. Active ownership reattachment, private service wiring, parent join,
and real remote execution certification remain unfinished.

The final code (`bf3aaea`) passed 1,148 tests and the required offline gate.
CodeRabbit's one minor issue was fixed; its follow-up was rate-limited. See the
2026-09-11 report for the complete evidence boundary and remaining rollout work.

Reviewed task: **Fix launch authorization validation**
(`01a062bd-d80c-78f3-b89c-a279c9b33163`). Baseline: `fda8773`, comprising eight
commits after `0d266b7`. Continuation branch:
`codex/owned-executor-audit-continuation`.

## Assessment

Keep the work-host execution design. Service-owned grant lookup addresses the
provenance flaw in caller-authored capability receipts. Separate durable
creation/turn identities and conservative handling of lost responses address
duplicate-launch risk. Owning the App Server independently of the frontend is
the correct lifetime boundary for work that must survive MCP disconnection.

The main limitation is integration evidence. The baseline was a collection of
tested libraries with injected policy, target and interaction dependencies. It
did not restore the public remote launch path. The original native authorization
producer and its replay gate still accept their existing receipt contract, and
legacy pending records still cannot prove non-invocation. Do not close #125 or
advertise restored remote execution on the strength of fixture tests alone.

The next milestone should be one complete work-host create/run/collect/join
scenario through the real service boundary, followed by two isolated workers.
Defer optional queues, environments and detached parent wake until this passes.

## CodeRabbit audit

CodeRabbit 0.7.6 reviewed all 39 changed files with
`coderabbit review --agent --base-commit 0d266b7` and raised **2 major issues**:

1. **Transient admission failures revoke valid grants**
   (`src/executor-grants.mjs`). Confirmed and fixed in `03d607f`.
   A seventeenth admission can hit the sixteen-callback limit and previously
   delete the same grant used by the first sixteen calls. Provider outages also
   deleted it. Each failed call still denies execution, but retries now recheck
   the existing grant and its entire live context. Proven stale context or
   capability loss still revokes it. A regression exercises capacity exhaustion,
   probe failure, successful retry and subsequent real configuration drift.
2. **Timed-out approval callbacks retain their capacity slot**
   (`src/executor-approval-relay.mjs`). Reviewed and intentionally retained.
   The callback may ignore cancellation and continue running. Releasing its slot
   while it runs would permit unbounded outstanding callbacks. The caller still
   receives cancellation promptly; late answers cannot approve anything. The
   existing regression explicitly verifies that the slot becomes available when
   the underlying callback settles. This is a bounded-resource contract, not a
   leaked counter.

A second CodeRabbit review of the continuation through `71d1de4`, relative to
`fda8773`, reviewed eleven changed files and raised **0 issues**.

## Continued implementation

- `2aee19b` persists the validated final classification with terminal status in
  the launch journal. Cached collection works after a coordinator restart,
  rechecks the current binding, and never converts transport completion into
  queen acceptance. Explicit refresh rejects contradictory evidence. Old V1
  records with status alone still require collection.
- `03d607f` fixes transient grant revocation as described above.
- `71d1de4` composes the owner, session, effects, authority, relay, coordinator
  and journal in an internal service runtime. Completion notifications trigger
  bounded collection. Work and approval holds survive frontend disconnects and
  drain, and collection errors or unknown launch outcomes retain those holds.

The runtime's providers are installed by the service, not supplied in frontend
JSON. The runtime is not an authenticated IPC endpoint, a policy provider or a
runtime certification. Its tests simulate stdio traffic and isolated durable
state; they do not start model turns.

## Compatibility and remaining work

The original audit found a narrow version admission policy. The continuation
removed CLI version floors and allowlists from plugin/MCP and owned execution:
versions are diagnostic evidence, while each operation checks the capabilities
it needs. Current version and host observations are recorded in
[codex-compatibility-2026-09-11.md](codex-compatibility-2026-09-11.md).
The first fixed, read-only service job now has an explicit MCP attachment and
separate parent acceptance; see the current milestone below.

Remaining release requirements, in dependency order:

1. Verify the installed/remote protocol profile, actual work-host repository and
   owned worktrees, authentication, effective permissions and exact route.
2. Add the private versioned service channel and daemon attachment, with trusted
   authorization and a production approval adapter. Child MCP clients attach to
   the elected owner; they must not recursively create executors.
3. Reconcile active/unknown operations before a restarted owner admits new work.
   Saved terminal results can be replayed now; active ownership reattachment is
   still unavailable. Empty listings must never authorize recreation.
4. Feed persisted owned results into parent acceptance/join, then expose the
   versioned backend through planning and MCP. Migrate the legacy gate with
   explicit, independently verified handling of old pending records.
5. Run real remote canaries, including two worktrees, denial/disconnection,
   response loss, restart, partial waves, and parent join. Verify Desktop task
   visibility and detached wake separately before promising either.

## Validation

- Baseline focused executor/transport suite: **91 passed**.
- Continued executor/transport suite: **101 passed** before the final additional
  partial-wave regression.
- Final full suite: **1,134 passed, 0 failed** (`npm test`). This includes the
  added partial-wave regression: collecting a completed first member does not
  release the service hold for an uncertain second member.
- `npm run check`, explicit syntax checks for every `src/executor-*.mjs`, and
  `git diff --check` passed.
- Validation used Node **26.7.0**, npm **10.9.4**, and lockfile-installed
  dependencies. The host's npm symlink was broken, so npm was supplied from a
  temporary directory without changing the global installation. npm 12's changed
  pack JSON shape caused three packaging failures during an intermediate run;
  all passed with npm 10, matching the npm family used by the Node 20 CI jobs.
- The distribution integrity record was recomputed for the final candidate
  bytes. No plugin was published, installed into the user's Codex configuration,
  or enabled for owned remote execution by this continuation.

## September 11 service milestone

The continuation adds the first optional parent-facing service/MCP job: private
local IPC, immutable operator authorization, capability-based admission, and
separate persisted parent acceptance. The [service usage and limitations](executor-admission-and-recovery.md#first-parent-facing-service-job)
and [live evidence](owned-service-canary-2026-09-11.json) supersede the original
remaining-work list for this bounded read-only flow. General scheduling,
interactive approvals, active-operation reattachment, automatic wake-up,
multiworktree coverage and legacy receipt migration remain open.

The next September 11 milestone adds observation of exact recorded turns after
owner loss, with account/target verification and no live ownership adoption.
[Crash canaries](owned-recovery-canary-2026-09-11.json) on both updated m3 CLIs
recovered an interrupted turn without creating another turn or accepting failed
work. This reduces the active-operation recovery gap; resuming execution and
handling lost replies with unknown turn IDs remain open.

The following retry slice adds a V2 family of explicitly preauthorized read-only
attempts. A confirmed interruption can select the next attempt without deleting
prior evidence; repeated requests cannot consume another attempt. Live canaries
on both m3 CLIs completed and accepted attempt two after crashing attempt one.
See [retry evidence](owned-retry-canary-2026-09-11.json). Automatic scheduling of
retry requests and parent wake-up remain open.


The automatic retry slice adds explicitly opted-in owner timers to V2 policies.
They collect and retry confirmed interruptions without a connected parent MCP,
use the existing durable attempt transitions, and stop at policy limits. Startup
alone still cannot launch the first attempt; acceptance remains a parent action.
[Automatic canaries](owned-automatic-retry-canary-2026-09-11.json) exercise owner
loss and frontend absence. Parent wake delivery remains open: the existing
lifecycle produces host effects but has no unattended executor-to-parent adapter.

CodeRabbit identified one drain race in automatic scheduling: drain could begin
while reading the journal for a selected but unstarted retry. The scheduler now
rechecks drain immediately after that read. A regression test pauses the read,
drains the service, and verifies that no replacement turn is sent.
