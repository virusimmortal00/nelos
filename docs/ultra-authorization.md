# Ultra Authorization and Fan-out Containment

Status: proposed contract. Companion to
[Adaptive Intelligence Routing](intelligence-routing-v2.md); independent of
[Route provenance and outcome join](route-provenance-join.md) and neither
blocks nor waits on it.

## Why Ultra is different

Every other reasoning tier changes how hard one task thinks. Ultra also permits
native subagent fan-out, so it changes execution topology. That distinction is
already recorded in the catalog's host-capability evidence and in
[Model & reasoning routing](routing.md), and it is why the router gates Ultra
twice rather than treating it as one more rung on the effort ladder.

The consequence is sharper than cost. `verifyRuntimeIntelligenceV1` verifies
exactly one thread: it locates that thread's rollout and compares each
`turn_context` against the expected route. Children a task fans out to are
never routed by Nelos, never verified, and never counted in the plan's
`summary.models` and `summary.efforts` accounting. Ultra is therefore the one
route that can produce execution the system cannot see — which is precisely the
guarantee the rest of the routing design exists to provide.

## Current exposure

The gate at `src/intelligence-profile-router.mjs` requires an explicit or
recommended Sol or Terra profile *and* `nativeFanoutAllowed === true`. The
second condition is a plain boolean that the caller asserts about itself, on
three paths:

| Path | Surface |
| --- | --- |
| MCP tool | `allowNativeFanout: true` on `nelos_intelligence_route` |
| Slice plan | `routing.nativeFanoutAllowed` on any slice |
| CLI | `--allow-native-fanout` |

The first two are reachable by the queen. A model authoring a plan can
therefore authorize the one control that removes its own work from
verification, which inverts the trust relationship the rest of the system
maintains.

## What a receipt can and cannot prove today

The v2 contract specifies an authorization receipt whose trusted boundary is
"an explicit user decision captured by a host-owned authorization receipt."
No such receipt exists. Codex exposes no primitive that lets a plugin request a
user confirmation and receive an attested answer, and a task with shell access
can write any file its user can write. A receipt read from disk therefore
proves that *something with the user's filesystem access* wrote it — not that
the user decided anything.

This document does not treat a file as authentication. That would repeat the
error [Host-owned Codex control lifecycle](host-owned-control.md) explicitly
declines when it refuses to add a partial peer-credential check, on the grounds
that applying it only in the client would overstate the guarantee.

What is achievable today is containment and audit:

- Ultra becomes unreachable from queen-authored plan content entirely.
- Authorization becomes a structured, validated, single-purpose record bound to
  one launch, so it cannot be asserted incidentally or reused.
- Every Ultra launch leaves a reviewable record naming a reason.
- The contract is shaped so that when host attestation exists, only the issuer
  check changes.

The exact missing upstream contract is a host-mediated user confirmation that
returns an attested receipt bound to a launch identity, carrying the
authenticated principal, the control, and the host's own signature over both.
Until Codex supplies it, an executable Ultra route is contained, logged, and
default-denied, but it is not authenticated. That limitation is stated in the
contract rather than papered over by the schema.

## `AuthorizationReceiptV1`

Validation is a pure function: no filesystem, clock, network, or process
dependency. Freshness is evaluated against an `evaluatedAt` the caller supplies,
the same way `checkModelCatalogFreshness` takes `now` as an argument rather than
reading a clock.

```json
{
  "schemaVersion": 1,
  "receiptId": "host-authorization:...",
  "control": "native-fanout",
  "authorized": true,
  "source": "user",
  "principal": "host-user",
  "reason": "Bounded parallel exploration approved for this migration",
  "scope": {
    "webId": "...",
    "workUnitId": "...",
    "specRevision": 1,
    "attempt": 1,
    "routePolicyDigest": "..."
  },
  "recordedAt": "2026-07-24T12:00:00.000Z"
}
```

The validator requires a strict field set, `control: "native-fanout"`,
`authorized: true`, a `source` of `user` or `host-policy`, a non-empty bounded
`reason`, a well-formed `recordedAt` not in the future beyond a bounded skew,
and a `scope` that matches the launch being authorized. A receipt is
single-purpose: it authorizes one control for one attempt at one work unit.
Changing revision, attempt, or route decision invalidates it rather than
carrying the authorization forward.

`scope.routePolicyDigest` binds a receipt to a specific routing decision and is
required once [Route provenance and outcome join](route-provenance-join.md) has
landed. Before then the scope omits it and binds on work-unit identity alone.
Neither slice blocks the other.

A negative receipt (`authorized: false`) is valid input and denies. Absence of
a receipt also denies. There is no code path in which a missing receipt is
treated as permissive.

## Containment measures

**Remove `nativeFanoutAllowed` from the slice-plan routing schema.** This is the
highest-value change in the slice and is fully implementable today. A
queen-authored plan can then never carry Ultra by any route, and the field
becomes an unknown property that the planner's strict validation rejects. Ultra
remains reachable only by presenting a receipt on a separate, explicit call.

**Replace the MCP boolean with a receipt argument.** `allowNativeFanout` is
removed from `nelos_intelligence_route`; the tool accepts a receipt and the
router requires a validated one for `ultra`. The raw boolean is not sufficient
in this contract.

**Default deny, with user-owned enablement.** Ultra is unavailable unless a
configuration file under `CODEX_HOME`, outside any repository, enables the
control. The loader rejects a symlink, a file writable by group or other, and
any path resolving outside the expected root — the same path-safety discipline
`src/path-safety.mjs` already applies elsewhere. This stops incidental and
plan-authored escalation. It does not stop a hostile task with shell access,
and the documentation says so.

**Keep the CLI flag as a developer affordance.** `--allow-native-fanout`
remains for the operator at a terminal, documented explicitly as not satisfying
this contract and not available to the skill, whose compliance tests already
assert it invokes no shell `nelos` command.

**Record fan-out as unverified.** Any launch whose route is `ultra` records that
its children are outside runtime verification, and the launch result surfaces
that rather than implying the same coverage a single-thread route receives.

## Audit record

The bounded authorization audit record persists `receiptId`, `control`,
`source`, `principal`, `scope`, `recordedAt`, and `reason`.

It is written separately from the content-free observation store. `reason` is
free text supplied by a human, so it is content, and admitting it into the
observation envelope would breach the rule that no free-text field exists
there. The two records join on the launch identity; neither embeds the other.

## Delivery slices

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

## Acceptance criteria

No queen-authored plan can produce an Ultra route by any field combination,
proven by a planner test that submits `routing.nativeFanoutAllowed` and asserts
rejection; a missing, negative, expired, malformed, or wrongly-scoped receipt
denies, with a test for each, and no path treats absence as permission; a
receipt scoped to one work unit, revision, attempt, or route decision fails
against any other; receipt validation is pure, with no clock, filesystem,
network, or process dependency; the enablement loader rejects symlinks,
group-or-other-writable files, and paths outside the expected root; the
authorization audit record never enters the content-free observation store; an
Ultra launch reports its fan-out children as unverified rather than silently
inheriting single-thread verification; and the documentation states plainly
that this contains and audits Ultra without authenticating it.

## Non-goals and residual risk

This slice does not authenticate authorization, because the host primitive to
do so does not exist. A task with shell access can write the enablement file
and a receipt, and this design does not claim otherwise. It also does not route,
verify, or account for fan-out children — bringing them inside the verification
loop would require Nelos to observe threads it did not launch, which is a
separate and larger contract.

What it removes is the ability to escalate to Ultra incidentally, from plan
content, without a bound scope, or without a record. What it leaves is a
deliberate, logged, default-denied control with a documented gap and a contract
ready for host attestation.
