# Owned executor approach audit and continuation

The [2026-09-11 compatibility report](codex-compatibility-2026-09-11.md) supersedes
the installed-version observations below. Commit `d8784ab` adds explicit Astra
routing, generated-schema checks and signed-in read-only probes for installed
CLI 0.153.4, public CLI 0.154.0, and latest Desktop's 0.154.0-alpha.6.1. The
following continuation adds a bounded journal inventory and startup admission
barrier, with cached-result replay and conservative handling of unfinished
operations. Active ownership reattachment, private service wiring, parent join,
and real remote execution certification remain unfinished.

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

On this work host, `codex --version` reports **0.153.4**. The baseline owned
session accepts only **0.152.0**. Retain the version rejection until schema and
runtime validation establish a supported profile. The [official App Server
documentation](https://learn.chatgpt.com/docs/app-server#message-schema) says
generated schemas are specific to the CLI version used; documentation presence
alone does not certify runtime behavior.

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
