# Route Provenance and Outcome Join

Status: proposed contract. Phase 0 of
[Adaptive Intelligence Routing](intelligence-routing-v2.md).

## Boundary

Phase 0 changes no route. Every task shape, profile, effort, override, Ultra
gate, and launch option behaves exactly as it does today. The slice adds only
the identity and the content-free observation needed to tell, later, whether a
route was a good one.

Today the router computes `policyVersion`, `catalogVersion`, `modelSelection`,
`effortSelection`, and `rationale`, and the plan retains them per slice. The
launch member carries only `route.launch.nativeTask`
(`src/next-action.mjs`), and `normalizeNativeLaunchV1` narrows that to
`{model, thinking}` (`src/launch-contract.mjs`). By the time a task launches,
verifies, and is accepted or rejected, no key remains to join the outcome back
to the decision that caused it. Every later phase — shadow policy, escalation,
calibration — depends on that join existing first.

## Two identities, not one

The router is a pure function whose determinism is asserted directly:
`routeIntelligenceProfile({taskShape})` called twice must deep-equal itself
(`test/intelligence-profile-router.test.mjs`). A minted-per-call identifier
would break that test and the reducer idempotency the orchestration contract
depends on. A pure content hash, on the other hand, collides across slices:
two `everyday` slices in one plan produce the same decision, so one identifier
could not attribute their outcomes separately.

Phase 0 therefore splits the identity in two.

| Identity | Minted by | Scope |
| --- | --- | --- |
| `routePolicyDigest` | the pure router | one policy decision |
| `routeDecisionId` | the work-unit launch binding | one attempt at one work unit |

`routePolicyDigest` identifies *what was decided*; identical decisions share
one digest, which is what offline replay must group by. `routeDecisionId`
identifies *one application of that decision*, and is the join key.

This supersedes the single `routeDecisionId` described in the v2 Phase 0
bullet, which cannot satisfy both purity and per-slice attribution.

### `routePolicyDigest`

A `sha256`/`base64url` digest over a canonical ordered array of the
decision-bearing fields only:

```text
[policyVersion, catalogVersion, taskShape, profile,
 requestedModel, requestedEffort, modelSelection, effortSelection,
 nativeFanoutAllowed]
```

`rationale` is excluded deliberately: it is prose, and rewording it must not
present as a policy change. The digest is added to the frozen route record and
the route `schemaVersion` becomes `3`. A route record is either absent
entirely (routing omitted, host defaults inherited) or carries a digest; there
is no record without one.

### `routeDecisionId`

Derived at binding time, mirroring `queenAcceptanceIdV1`
(`src/queen-acceptance.mjs`) in both shape and discipline:

```text
route-decision-v1/<webId>/<workUnitId>/revision-<n>/attempt-<m>/<routePolicyDigest>
```

Pure, clock-free, and random-free. Every writer re-derives it from the
provenance it is storing and fails closed on mismatch, exactly as
`createQueenAcceptanceV1` does for `decisionId`.

`parentRouteDecisionId` is `null` on the first attempt and otherwise names the
immediately preceding attempt's `routeDecisionId`. Phase 0 never changes a
route between attempts, so the parent is mechanically derivable today — it is
recorded rather than derived so that Phase 4 escalation, where the route does
change, does not have to reconstruct a chain after the fact.

`routeDecisionId` is a routing identity and stays distinct from the queen
acceptance `decisionId`, which continues to identify a judgment about a result.

## Persistence points

Three additive changes, each fail-closed and each with a lazy reader for
existing records. No migration rewrites a stored file.

**`WorkUnitSpecV2`** gains one grouped, content-free block:

```json
{
  "route": {
    "routeDecisionId": "route-decision-v1/...",
    "parentRouteDecisionId": null,
    "routePolicyDigest": "...",
    "policyVersion": 2,
    "catalogVersion": "openai-2026-07-21"
  }
}
```

`WORK_UNIT_SPEC_SCHEMA_VERSION` becomes `2`. The v1 reader yields
`route: null`. A missing route reads as unattributed and never as a fabricated
identity.

**The runtime verification receipt** echoes `routeDecisionId` when the caller
supplies one. `verifyRuntimeIntelligenceV1` continues to derive `verified`
solely from observed `turn_context` metadata; the identifier is carried for
joining and is never evidence. Verification proves what ran, not that the route
was well chosen.

**`QueenAcceptanceV2`** gains a required `routeDecisionId` and bumps to
schema version `2`. The v1 reader is retained; v1 records resolve their route
identity through the persisted work-unit mapping where that work unit still
exists, and read as `null` where it does not.

## Observation envelope

Written by an explicit `nelos_intelligence_observe` call at the orchestration
boundary after acceptance is recorded. It is never hidden inside routing, which
must stay pure and safe to call during planning, and never inside acceptance,
which must not grow telemetry responsibilities.

```json
{
  "schemaVersion": 1,
  "routeDecisionId": "route-decision-v1/...",
  "parentRouteDecisionId": null,
  "routePolicyDigest": "...",
  "policyVersion": 2,
  "catalogVersion": "openai-2026-07-21",
  "taskShape": "everyday",
  "route": {
    "model": "gpt-5.6-terra",
    "effort": "low",
    "modelSelection": "recommended",
    "effortSelection": "recommended"
  },
  "outcome": {
    "routeVerified": true,
    "queenDecision": "accepted",
    "attempts": 1,
    "correctiveTurns": 0,
    "routeChanges": 0,
    "durationBucket": "5-15m",
    "failureCategory": null
  }
}
```

`durationBucket` is one of `<1m`, `1-5m`, `5-15m`, `15-60m`, `>60m`, `unknown`.
`queenDecision` is `accepted` or `rejected`. `failureCategory` is `null` or a
bounded enum. Every value in the envelope is an enum, a bounded integer, or an
identity derived above.

The content-free rule is enforced by the validator, not documented and hoped
for: the field set is strict, every leaf is an enum or bounded integer, and no
free-text field exists to carry content. Task titles, objectives, prompts,
acceptance-criterion text, messages, reasoning, artifacts, source paths, tool
output, environment values, and credentials have no representable position in
the schema.

## Aggregate report

`nelos intelligence report` reads persisted observations and emits counts
grouped by `routePolicyDigest`: acceptance rate, verification rate, attempt
distribution, route changes, and the duration histogram.

It is strictly read-only and reports raw counts with their sample sizes. It
does not rank routes, recommend a change, or edit the catalog or policy — the
same discipline `checkModelCatalogFreshness` already applies to catalog drift.
Small samples are reported as small samples.

## Delivery slices

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

## Acceptance criteria

A route decision, its runtime verification, and its queen acceptance join on
`routeDecisionId` with no task content persisted anywhere in the chain; the
router remains pure, with no clock, randomness, or I/O, and its existing
determinism tests pass unmodified apart from the additive digest field; every
current routing test passes without a changed expectation, because no route
changed; v1 work-unit specs and v1 acceptance records still read, surfacing
missing provenance as `null` rather than a fabricated identity; the observation
validator rejects any field outside the content-free set, proven by a test that
feeds it a prompt-bearing object and asserts failure; and the report performs no
write, no network call, and no catalog or policy mutation.

## Non-goals

Phase 0 does not add the task-profile contract (Phase 1), live host-capability
filtering (Phase 2), advisory or default adaptive routing (Phases 3 and 4),
evidence-specific escalation (Phase 4), or empirical calibration (Phase 5). It
changes no route.

It also does not address the self-asserted `nativeFanoutAllowed` boolean, which
is contracted separately in
[Ultra authorization and fan-out containment](ultra-authorization.md). That
slice is independent of this one and neither blocks it nor waits on it, though
it binds its receipts to `routePolicyDigest` once this slice has landed.
