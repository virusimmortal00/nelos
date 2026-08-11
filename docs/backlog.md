# Product Backlog

This is the canonical running backlog for Nelos. Keep slices small
enough to implement, validate, and review independently. Move completed slices
to **Done**, and revise **Next** before beginning new product work.

This backlog is the source of truth for longer-term queen-driven coordination
work. Order future slices by their evidence and acceptance gates.

## Next

- [x] add the durable host-observation checkpoint, strict title/wait/result
  receipts, pure join reducer, and callback-only MCP advance operation without
  rewriting `ExecutionStoreV1` or opening an app-server connection
  ([contract](observation-join.md)).

### Self-sufficient marketplace install (MCP tool surface)

Close the packaging gap where a marketplace install ships the skill but not
the `nelos` executable the skill invokes. Expose the skill's only CLI
dependencies — the offline slice planner, the intelligence router, and
runtime-intelligence verification — as a bundled, socket-free MCP server, per
[Socket-free MCP tool surface](mcp-tool-surface.md). Launch mechanics are
pinned to verified `codex-cli 0.144.6` behavior (no `${PLUGIN_ROOT}`
substitution; inline self-locating bootstrap) with a recorded retirement
condition and a filed upstream report.

Delivery slices:

- [x] add the newline-framed stdio MCP server exposing `nelos_plan_slices`,
  `nelos_intelligence_route`, and `nelos_intelligence_verify`, reusing the
  CLI's modules with no behavioral fork (live-smoke-tested on a real
  marketplace install of 0.2.0);
- [x] generate `.mcp.json` with the baked release version and inline
  bootstrap; verify freshness and version consistency in tests;
- [x] move the skill's two CLI invocations to the named tools, keeping the
  one-desktop-path protocol unchanged, and assert in compliance tests that the
  installed skill references no shell `nelos` commands;
- [x] update install documentation with the required `config.toml` enablement
  block;
- [ ] teach `nelos doctor` and the distribution verifier to recognize the
  installed-but-disabled server state and point at the enablement block.

Acceptance criteria: a fresh marketplace install plus the documented
enablement block yields a task where the skill completes plan → launch →
verify using only bundled tools and native task controls; the MCP server
opens no sockets; its original three tools perform no writes, while stateful
orchestration tools write only revision-checked private Nelos state and return
host-owned effects; provenance and hermetic release gates cover the new
surfaces; and the CLI remains fully supported for developers without being a
skill dependency.

### Durable execution foundation

Make the shipped golden loop resumable and deterministic by introducing the
smallest durable orchestration contract. Keep the app server authoritative for
tasks and turns, keep external effects in the existing adapters, and do not add
automatic execution in this slice.

Delivery slices:

- [ ] add `ExecutionStoreV1` with atomic private-state writes, schema validation,
  and malformed-record isolation;
- [ ] add `WorkUnitSpecV1` with stable work-unit IDs, spec revisions, attempts,
  capabilities, and explicit unbound/pending/bound task relationships;
- [ ] add a pure orchestration reducer that derives outcome, phase, attention,
  and proposed actions without performing effects;
- [ ] key every proposed action to the work-unit ID and spec revision, and add
  expected task/turn preconditions for task-scoped actions; and
- [ ] prove restart reconciliation and reducer idempotency with deterministic
  fixtures before enabling any automatic continuation.
- [x] add the callback-only MCP first slice: persist one deterministic
  `launch-pending` action, return one typed native-create effect, validate the
  host receipt before mutation, and bind its returned member thread ID without
  adding app-server transport or a second registry writer.
- [x] harden that callback boundary: serialize decisions across processes,
  turn uncertain replays into a non-creating reconciliation effect, carry the
  requested title in a title-seeded creation prompt, observe the settled title
  after binding, and emit an idempotent rename only on mismatch.
- [x] add host receipt and observation contracts for title verification,
  cursor-aware waiting, result collection, and parent continuation.

Acceptance criteria: a queen restart reconstructs the same derived state and
same proposed next action; stale observations and malformed records fail closed;
unbound work units cannot receive task-scoped effects; identical reducer inputs
produce identical output without duplicate effects; and no background service
or unscoped host integration is introduced.

### Route provenance and outcome join

Establish the evidence needed to improve routing before any new policy is
allowed to affect a launch. Today the router computes route provenance and the
plan retains it, but the launch member carries only `nativeTask`, so an accepted
or rejected outcome cannot be joined back to the decision that caused it. This
slice adds that join and nothing else — it changes no route, per
[Route provenance and outcome join](route-provenance-join.md).

Identity is split in two so the router stays pure: `routePolicyDigest` is
minted by the pure router and identifies one policy decision, while
`routeDecisionId` is derived at the work-unit launch binding and identifies one
attempt at one work unit.

Delivery slices:

- [ ] add `routePolicyDigest` to the pure route record, bump the route schema
  version, and assert purity, determinism, and rationale-independence;
- [ ] add `intelligence-route-identity.mjs` deriving and re-validating
  `routeDecisionId`, mirroring `queenAcceptanceIdV1`;
- [ ] add `WorkUnitSpecV2` carrying the route provenance block, with a lazy v1
  reader that yields `route: null`;
- [ ] thread `routeDecisionId` through the launch adapter and the runtime
  verification receipt without granting it evidentiary weight;
- [ ] add `QueenAcceptanceV2` with a required `routeDecisionId`, a retained v1
  reader, and work-unit-mapped resolution for v1 records;
- [ ] add `intelligence-observation-store.mjs` with strict content-free
  validation and atomic private-state writes;
- [ ] add the read-only `nelos intelligence report` aggregate.

Acceptance criteria: a route decision, its runtime verification, and its queen
acceptance join on `routeDecisionId` with no task content persisted anywhere in
the chain; the router remains pure, with no clock, randomness, or I/O; every
current routing test passes without a changed expectation, because no route
changed; v1 work-unit specs and v1 acceptance records still read, surfacing
missing provenance as `null` rather than a fabricated identity; the observation
validator rejects any field outside the content-free set; and the report
performs no write, no network call, and no catalog or policy mutation.

### Ultra authorization and fan-out containment

Close the self-asserted `nativeFanoutAllowed` boolean. Ultra permits native
subagent fan-out, so it changes execution topology rather than only reasoning
depth, and fanned-out children are never routed, verified, or counted in plan
accounting. Today a queen-authored plan can set the flag itself, so a model can
authorize the one control that removes its own work from verification, per
[Ultra authorization and fan-out containment](ultra-authorization.md).

No host primitive can authenticate a user decision today, so this slice
contains and audits Ultra without claiming to authenticate it, and names the
missing upstream contract in the same register as
[Host-owned Codex control lifecycle](host-owned-control.md).

Delivery slices:

- [ ] remove `nativeFanoutAllowed` from the slice-plan routing schema so a
  queen-authored plan cannot reach Ultra, and reject the field as unknown;
- [ ] add `intelligence-authorization.mjs` with pure `AuthorizationReceiptV1`
  validation, caller-supplied `evaluatedAt`, and launch-scope binding;
- [ ] require a validated receipt for `ultra` in the router and replace the MCP
  `allowNativeFanout` boolean with a receipt argument;
- [ ] add the default-deny user-owned enablement loader with symlink, mode, and
  path-containment checks;
- [ ] persist the bounded authorization audit record separately from the
  content-free observation store;
- [ ] record and surface that Ultra fan-out children are outside runtime
  verification;
- [ ] document the CLI flag as a developer affordance that does not satisfy
  this contract.

Acceptance criteria: no queen-authored plan can produce an Ultra route by any
field combination; a missing, negative, expired, malformed, or wrongly-scoped
receipt denies, and no path treats absence as permission; a receipt scoped to
one work unit, revision, attempt, or route decision fails against any other;
receipt validation is pure; the enablement loader rejects symlinks,
group-or-other-writable files, and paths outside the expected root; the
authorization audit record never enters the content-free observation store; an
Ultra launch reports its fan-out children as unverified; and the documentation
states plainly that this contains and audits Ultra without authenticating it.

## Leading candidates after Next

1. **Result handoffs, acceptance, and synthesis:** validate current attempts,
   record queen acceptance separately from completion, and export deterministic
   synthesis provenance.
2. **Queen-owned dependency gates and crash-safe continuation:** derive readiness
   from accepted dependencies and journal bounded action receipts before any
   automatic recovery.
3. **Safe steering, worktree provisioning, and delivery:** add revision-checked,
   auditable actions and one-writer workspace ownership.
4. **Protocol and status hardening:** expand compatibility/fallback coverage and
   raise branch coverage around app-server protocol and status normalization.

## Deferred Architecture Milestone

### Shared SQLite state projection and observation history

Add a user-scoped, cross-repository SQLite database for fast current-state
reads and durable, low-cardinality lifecycle observations. Keep the app server
authoritative: queens read the cache first, selectively refresh stale, unknown,
or running tasks, and fall back cleanly when the database is unavailable.
Spinoffs publish versioned lifecycle observations at existing command
boundaries; leases and expiry prevent an abandoned `running` value from being
treated as current. Do not store prompts, transcripts, environment values, or
raw error content.

Delivery slices:

- benchmark live lookup latency and call counts for representative web sizes;
- define the versioned SQLite schema, schema updates, repository identity, WAL
  concurrency policy, retention rules, and current-state/event contracts;
- dual-write lifecycle observations while preserving the existing registry
  and live-status behavior;
- add cache-first reads with TTL-based selective refresh, live fallback, and
  equivalence tests against authoritative task status;
- add bounded rollups for cross-repository time-series analysis after the
  projection is proven reliable.

Acceptance criteria: cached reads never silently override newer live state;
stale writers cannot regress a task revision; crashes degrade to
`stale`/`unknown`; isolated concurrent-writer and schema-update tests pass; and
measured lookup results establish the performance improvement before the cache
becomes the default read path. Begin this only after durable result handoff and
crash-safe action receipts are proven.

## Later Product Ideas

These ideas are intentionally outside the compact-hierarchy slice:

- interactive expand and collapse controls;
- filtering or sorting members;
- hierarchy and status animations;
- task actions such as start, resume, rename, archive, or send message;
- historical turn browsing or timelines;
- richer dashboard or graph views.
- a live host integration, only after Codex supplies a scoped, authenticated,
  host-owned control endpoint and lifecycle contract; see
  [Future Host Integration](mcp-web-ui.md).

Any future task mutation or task-history exposure needs its own explicit
permission design, confirmation path, and audit model.

## Proposed Adaptive Intelligence Routing

- Instrument current route decisions with stable identity and content-free
  outcome observations before changing launch behavior (Phase 0, contracted in
  [Route provenance and outcome join](route-provenance-join.md) and scheduled
  under **Next**).
- Replace the three-way task-shape input with an evidence-backed task profile,
  retaining a compatibility translation for persisted plans.
- Add live host-capability filtering, a versioned deterministic scorecard,
  independent model/effort selection, alternatives, and confidence.
- Run the new policy in shadow and advisory modes before making it the default.
- Add evidence-specific bounded escalation and empirical calibration only after
  evaluation and rollback gates are in place.
- Replace the self-asserted native-fan-out boolean with a scoped, audited,
  default-denied authorization
  ([contract](ultra-authorization.md), scheduled under **Next**).

See [Adaptive Intelligence Routing](intelligence-routing-v2.md) for contracts,
module boundaries, safety rules, and rollout criteria.

## Done

- Complete the executable-web golden loop: deterministic durable spinoffs,
  bounded outcome classification, same-task corrective recovery, pull-based
  collection, traceable synthesis readiness, and a twice-run verifier.
- Retire the MCP/UI prototype from the repository and distributed plugin; retain
  its future host requirements in [Future Host Integration](mcp-web-ui.md).
  (The retired surface was live-state UI; the later socket-free tool surface in
  [Socket-free MCP tool surface](mcp-tool-surface.md) is a different scope and
  does not reverse this.)
- Add deterministic, overridable Sol/Terra/Luna intelligence routing with a
  versioned reviewed catalog, lowest-sufficient effort policy, and explicit
  Ultra guardrails.
- Make model and reasoning selections independently inheritable or overridable,
  and emit exact native and standalone launch options for dogfooding.
- Compose queen-authored semantic slices with validated dependency waves,
  isolation rules, and reviewed per-slice model/reasoning launch options.
- Add lifecycle-first task routing and hard collection deadlines so the
  canonical installed flow remains bounded and does not depend on user-issued
  CLI commands after the initial request.
- Add hermetic macOS/Linux CI release gates that package, install, and verify
  the skill-and-CLI product from clean environments.
- Install the CLI, task-management skill, local plugin source, and plugin cache
  transactionally from one immutable release; verify full-content provenance,
  refresh a running desktop app-server only after the durable commit so late
  requests cannot race rollback, and pass a fresh task gate for skill discovery.
- Define one distribution provenance record shared by the CLI, user-wide skill,
  and cached plugin; add a read-only drift verifier and isolated coherent/stale
  fixtures for all three surfaces.
- Package the task-management skill as one Codex plugin.
- Install the personal plugin and validate skill discovery from a newly started
  Codex task.
