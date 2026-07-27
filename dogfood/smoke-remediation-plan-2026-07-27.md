# Nelos Smoke Remediation Plan — 2026-07-27

Source: `dogfood/dogfood-smoke-2026-07-27.md`

Validated Nelos plan run:
`run:9f5232e08f5a8a8b6a4e544483e06e7c8cddc733`

## Diagnosis

The existing crown did not block the queen rename. The title grammar is
explicitly idempotent across crown and web markers, including legacy marker
ordering.

The queen stayed `👑 · Clarify CLI and MCP roles (6)` because the two paths
currently own different pieces of identity:

- planning synchronizes only the crown with `renderQueenTitle`;
- lower-level durable orchestration accepts a child `webId`, but does not
  allocate, persist, or synchronize the queen's outbound web identity;
- therefore the queen-title check considered the crown-only title complete,
  while F8.1 and F9.1 were decorated independently after launch.

Codex also does not currently expose a title field on native durable-task
creation. Exact spin-off titles cannot be guaranteed at the first visible
instant. Prompt seeding is advisory; read, set, and verify after binding must be
the supported contract. Existing joined subagents likewise have no native title
control, and their follow-up control has no model or effort override.

## Actionable Gaps

1. Queen and spin-offs do not share one persisted web identity and title-sync
   lifecycle.
2. MCP has no queen accept/reject operation between an exact result read and
   cleanup.
3. Exception replanning reuses a joined-subagent path even though a follow-up
   cannot establish the newly required route.
4. Lifecycle-specific routing and capability defaults need one explicit,
   fail-closed contract across planning and lower-level orchestration.
5. The durable-title documentation and tests imply a stronger creation-time
   guarantee than Codex can provide.

F17 and F20 are not defects: missing `read-result` authority and cleanup before
acceptance correctly failed closed. Luna rejection for joined subagents already
worked, but remains a required regression invariant.

Permanent hexadecimal allocation, non-reuse, high-water persistence, and
historical migration remain owned by
[GitHub issue #23](https://github.com/virusimmortal00/nelos/issues/23).

## Dependency-Safe Fix Plan

### Wave 1 — parallel foundations

#### A. Synchronize queen and durable web titles

- Persist one web identity before a durable wave proceeds.
- Return a host-owned queen title effect using the same identity used by its
  decorated spin-offs.
- Preserve crown and lineage markers idempotently.
- Reject conflicting persisted identities rather than overwriting lineage.
- Treat post-create read/set/verify as the normal compatibility path.
- Keep legacy records readable without renumbering them.

Required tests: title grammar, planning, plan-run persistence, orchestration
replay, conflicting identity, and legacy compatibility.

#### B. Expose queen acceptance through MCP

- Add a versioned, idempotent queen accept/reject operation backed by the
  existing acceptance store.
- Bind each decision to the exact queen, member, spec revision, attempt, result
  turn, and current result provenance.
- Accept only current succeeded results.
- Make exact replay idempotent and conflicting replay fail closed.
- Feed persisted acceptance into orchestration and cleanup eligibility.
- Document the MCP-only `decide -> accept/reject -> cleanup` path.

Required tests: schema, current/stale result decisions, replay, restart,
cross-queen rejection, observation state, and cleanup gating.

#### C. Give exception replans fresh joined identities

- Generate a new, generation-scoped agent task name for every pending joined
  slice in a replan.
- Never use `followup_task` as a replacement launch when an exact route must be
  established.
- Preserve completed slices and the one-generation limit.
- Continue exact current-turn and atomic batch verification.

Required tests: name uniqueness, semantic slice-ID reuse, completed-slice
preservation, exact turn, and route mismatch.

### Wave 2 — routing and capability hardening

Depends on Wave 1C.

- Require every routing call to name its native launch surface.
- Permit only Sol or Terra for joined subagents; reject Luna before state
  mutation.
- Give planner-generated required work the capabilities needed to observe and
  read its result.
- Grant archive authority only when durable cleanup is intended.
- Keep deliberate lower-level observe-only contracts valid and fail closed at
  the missing-capability boundary.
- Reject unsupported or duplicate capabilities per lifecycle.

Required tests: router, slice planner, plan bridge, lower-level orchestration,
capability boundaries, and Luna rejection.

### Wave 3 — full-angle verification

Depends on all implementation slices.

- Run focused title, acceptance, cleanup, replan, routing, capability, and
  lifecycle suites.
- Run the full repository and distribution-integrity suites.
- Dogfood a durable web through queen/child identity convergence,
  post-creation title repair, exact result acceptance, cleanup eligibility, and
  replay.
- Dogfood an exception replan through a fresh joined path and exact route.
- Reconcile every F1–F23 scenario, distinguishing fixes from intentional
  fail-closed behavior.
- Confirm issue #23 remains the sole owner of permanent hexadecimal allocation
  and migration.

## Exit Criteria

- The queen and every durable child visibly share one persisted compact web
  identity.
- No contract claims Codex can set a durable title during creation.
- A complete durable workflow is possible through MCP without CLI fallback.
- Replans never depend on changing route through a joined-subagent follow-up.
- Joined subagents are never routed to Luna or treated as durable tasks.
- All focused and full suites pass with clean distribution integrity.

## Implementation Status

All implementation waves are integrated on `fix/mcp-host-owned-effects`.
Focused and full automated verification pass, and the rebuilt plugin is
installed as `0.4.0+codex.20260727175748`.

The final live gate remains pending because Codex retained the pre-reinstall
MCP process for existing task capability snapshots. A new task created without
fully restarting the app loaded the new skill but received no Nelos MCP tools;
the original queen could discover Nelos tools but calls still returned the old
server response shape. The next verification must therefore begin only after a
full Codex restart.

The full restart subsequently verified queen/child web A2 title convergence
and exact Luna/low launch identity. It also exposed a missing handoff between
`launch-wave` and `nelos_orchestrate_create`: the durable task existed before
its work unit was registered, so its completion callback correctly failed
closed as unbound. The follow-up patch adds machine-generated orchestration
preparation, explicit cleanup intent, and a worker role boundary before the
next live smoke.

A fully restarted smoke of that patch reached preparation before native
creation and exposed a narrower producer/consumer mismatch: the launch action
embedded a persisted work-unit record, including `binding` and
`replacementHistory`, while `nelos_orchestrate_create` accepts only the
immutable creation definition. The tool rejected the action before mutation.
The next patch projects `workUnitDefinitionV1` into the generated action and
tests that the complete generated arguments are directly consumable.
