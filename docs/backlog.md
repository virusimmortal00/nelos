# Product Backlog

This is the canonical running backlog for Nelos. Keep slices small
enough to implement, validate, and review independently. Move completed slices
to **Done**, and revise **Next** before beginning new product work.

This backlog is the source of truth for longer-term queen-driven coordination
work. Order future slices by their evidence and acceptance gates.

**Last reviewed:** 2026-07-28 14:33 EDT (`America/New_York`)

Refresh this timestamp whenever **Next** is reordered, an item changes state, or
a material implementation lands that changes the remaining scope.

## Next

### Host-owned task-control hardening

Nelos owns durable policy, preconditions, and receipts. Codex remains
authoritative for native task effects. Do not move task mutations into an
unscoped MCP proxy or rely on the active agent to reconstruct lifecycle rules.

- [ ] inventory the current create, follow-up, steer, archive, and title effects
  plus app-server compatibility fallbacks; document one explicit replay and
  reconciliation policy per operation, and decide whether fork, resume, and
  unarchive belong in the supported product surface;
- [ ] finish launch attestation by binding authoritative working-directory,
  worktree/branch, route, model, and reasoning evidence where the host exposes
  it, while marking unavailable fields as unknown rather than inferred;
- [ ] define one bounded mutation-audit event schema, permission matrix,
  serialization contract, and content-free operator diagnostic across native
  effects and compatibility fallbacks; and
- [ ] run an end-to-end Desktop validation matrix covering task visibility,
  notification propagation, concurrent Desktop/Nelos writers, uncertain
  mutation outcomes, and supported mismatched Desktop/CLI versions.

Acceptance criteria: validation precedes mutation; stale or ambiguous receipts
fail closed; uncertain mutations are never blindly replayed; repeated calls
converge; native effects remain host-owned; and diagnostics expose allowlisted
metadata only.

### Release engineering and open-source readiness

The repository currently has protected `main`, required macOS/Linux checks,
Dependabot, CodeQL, an MIT license, a security policy, a release policy, a
changelog, community-health files, and a tag-only draft-release workflow with
reproducible integrity artifacts. It has no published GitHub releases or Git
tags yet.

- [ ] publish the first GitHub Release from the next verified version instead of
  inventing retroactive tags for unverified historical states;
- [ ] clean up repository presentation and discovery metadata: remove the stale
  `fraktik` topic, set the canonical documentation/homepage link, add CI and
  release badges, and review Discussions, issue labels, merge settings, and
  branch rules against the actual maintainer model.

Remaining acceptance criteria: every advertised release maps one-to-one to a
signed or otherwise immutable tag and coherent versioned source state; release
automation cannot publish from an unverified commit; artifacts are
integrity-checkable; and repository presentation matches the actual
solo-maintainer model.

### Synthesis and automatic continuation

- [ ] export deterministic synthesis provenance from exact accepted member
  attempts without exposing prompts or transcripts; and
- [ ] journal bounded continuation receipts so accepted dependency waves can
  resume safely after a queen restart, while retaining an explicit attention
  boundary whenever host evidence is unavailable.

Acceptance criteria: completion, collection, queen acceptance, synthesis, and
continuation remain distinct states; stale attempts cannot enter synthesis; and
recovery never relaunches accepted work.

## Upstream-blocked protocol opportunities

These are not actionable **Next** work against the currently supported Codex
`0.144.x` protocol. Re-evaluate them when the compatibility fixture changes.

- native lifecycle subscriptions with a resumable cursor or catch-up request,
  replacing bounded current-state polling only after missed-event behavior is
  testable; and
- a versioned title compare-and-set or revision precondition, replacing the
  documented unsupported simultaneous Desktop/MCP title-writer window.

## Leading candidates after Next

1. **Safe steering, worktree provisioning, and delivery:** turn the existing
   worktree contracts into revision-checked effects with one-writer ownership
   and bounded delivery evidence.
2. **Protocol and status hardening:** expand compatibility/fallback coverage and
   branch coverage around app-server protocol and status normalization.
3. **Release sustainability:** automate dependency-update release notes,
   deprecation notices, support-window checks, and reproducibility verification
   after the first release workflow is proven.

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
- a general-purpose live dashboard or transcript surface, only after the
  separate permission and lifecycle gate in
  [Future Host Integration](mcp-web-ui.md).

Any future task mutation or task-history exposure needs its own explicit
permission design, confirmation path, and audit model.

## Proposed Adaptive Intelligence Routing

- Instrument current route decisions with stable identity and content-free
  outcome observations before changing launch behavior.
- Replace the three-way task-shape input with an evidence-backed task profile,
  retaining a compatibility translation for persisted plans.
- Add live host-capability filtering, a versioned deterministic scorecard,
  independent model/effort selection, alternatives, and confidence.
- Run the new policy in shadow and advisory modes before making it the default.
- Add evidence-specific bounded escalation and empirical calibration only after
  evaluation and rollback gates are in place.

See [Adaptive Intelligence Routing](intelligence-routing-v2.md) for contracts,
module boundaries, safety rules, and rollout criteria.

## Done

- Define a public, versioned protocol-contract package with closed action,
  effect, receipt, continuation, attention, error, and semantic-input schemas;
  add a centralized recovery registry, replay-safe transition reducer, producer
  compatibility envelopes, migration map, and MCP-advertised contract metadata.
- Add a tag-only release workflow that requires an annotated version tag,
  macOS/Linux verification, the golden loop, a clean-install gate, coherent
  release metadata, and a dated changelog section before creating or refreshing
  a draft GitHub Release.
- Build the npm package twice to prove reproducibility and attach SHA-256
  checksums, distribution provenance, a release manifest, release notes, and a
  deterministic CycloneDX SBOM; document install, upgrade, rollback, and
  support expectations.
- Add bounded, read-only bundled MCP diagnostics to `nelos doctor` and the
  distribution verifier, distinguishing missing, disabled, incompatible, and
  healthy states with one exact non-echoing recovery action where needed.
- Define the SemVer, release-line, prerelease, Codex compatibility, provenance,
  immutable-tag, and release-note contracts; add a packaged `CHANGELOG.md`.
- Add repository-local contribution, conduct, support, ownership, bug/feature
  issue forms, and pull-request guidance that preserves private security
  reporting and reflects the solo-maintainer model.
- Add `ExecutionStoreV1` and `WorkUnitSpecV1` with atomic private writes,
  schema validation, malformed-record isolation, stable revisions and attempts,
  explicit bindings, guarded transitions, and deterministic restart fixtures.
- Add pure execution and observation reducers whose actions carry stable
  work-unit, revision, attempt, task, and turn preconditions and whose identical
  inputs reconstruct identical next actions without performing effects.
- Add the durable host-observation checkpoint, strict title/wait/result receipts,
  current-turn result provenance, separate queen acceptance, dependency-wave
  readiness, and callback-only MCP advance operation
  ([contract](observation-join.md)).
- Add the bounded Codex app-server compatibility bridge, generated-schema and
  version gates, health telemetry, task inspection and inventory, direct-parent
  topology, and snapshot-cursor polling without prompts or transcripts.
- Complete the executable-web golden loop: deterministic durable spinoffs,
  bounded outcome classification, same-task corrective recovery, pull-based
  collection, traceable synthesis readiness, and a twice-run verifier.
- Retire the MCP/UI prototype from the repository and distributed plugin; retain
  its future host requirements in [Future Host Integration](mcp-web-ui.md).
  (The retired surface was live-state UI; the later bounded tool surface in
  [MCP tool surface](mcp-tool-surface.md) is a different scope and
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
