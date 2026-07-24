# Adaptive Intelligence Routing

Status: proposed architecture.

## Problem

Nelos currently accepts a queen-authored `taskShape` and deterministically maps
it to one model and reasoning effort:

| Task shape | Model | Effort |
| --- | --- | --- |
| `complex/open-ended` | Sol | `medium` |
| `everyday` | Terra | `low` |
| `clear/repeatable` | Luna | `low` |

This is a useful enforcement policy, but only a coarse recommendation policy.
The three shapes do not distinguish ambiguity from consequence, task novelty
from context size, or weak verification from strong verification. The system
also has no objective function, live capability preflight, adaptive escalation,
or outcome feedback.

The next routing architecture should choose the least expensive route expected
to meet an explicit quality target while retaining deterministic, reviewable
behavior and exact runtime verification.

## Goals

- Recommend model and effort as genuinely independent dimensions.
- Represent the task evidence that influenced a recommendation.
- Respect quality, latency, cost, and host-capability constraints.
- Return alternatives, uncertainty, and a bounded escalation policy.
- Learn from accepted and rejected outcomes without storing prompts, reasoning,
  source code, tool output, or credentials.
- Preserve explicit overrides, exact native launch options, and fail-closed
  runtime verification.
- Introduce the new policy without changing production routes until shadow
  evaluation shows a measurable improvement.

## Non-goals

- Claim that a model is available or entitled without host evidence.
- Put an opaque learned model directly in the launch-critical path.
- Let worker self-reported success serve as the sole quality signal.
- Silently substitute a route when an exact requested route is unavailable.
- Optimize globally across users before local measurements and consent support
  that use.

## Decision Pipeline

```text
slice contract
    │
    ▼
task profile + evidence ─────── explicit preferences
    │                                  │
    └──────────────┬───────────────────┘
                   ▼
          host capability filter
                   │
                   ▼
      versioned deterministic policy
                   │
          ┌────────┴────────┐
          ▼                 ▼
   selected route      alternatives
          │
          ▼
 exact native launch options
          │
          ▼
 runtime verification → outcome observation → offline evaluation
```

The queen remains responsible for semantic task decomposition. Instead of
choosing one opaque shape, it supplies a bounded task profile whose values must
be supported by fields in the slice contract. Nelos validates and scores that
profile deterministically.

## Task Profile Contract

Use discrete, reviewable values in the first version. Apparent numeric
precision should be introduced only after calibration data exists.

```json
{
  "schemaVersion": 1,
  "ambiguity": {
    "value": "high",
    "evidence": ["Acceptance criteria allow multiple architectures"]
  },
  "novelty": {
    "value": "medium",
    "evidence": ["No prior implementation is identified"]
  },
  "consequence": {
    "value": "high",
    "evidence": ["The change affects persisted user data"]
  },
  "reversibility": {
    "value": "low",
    "evidence": ["The migration cannot be automatically rolled back"]
  },
  "verificationStrength": {
    "value": "medium",
    "evidence": ["Focused automated tests exist; no end-to-end oracle exists"]
  },
  "contextSize": {
    "value": "large",
    "evidence": ["The slice spans four packages"]
  },
  "toolComplexity": {
    "value": "medium",
    "evidence": ["Repository inspection and test execution are required"]
  },
  "interactionMode": {
    "value": "autonomous",
    "evidence": ["The slice is expected to finish without user input"]
  },
  "qualityTarget": "critical",
  "latencyPreference": "balanced",
  "costPreference": "balanced",
  "confidence": "medium"
}
```

Initial enums:

| Field | Values |
| --- | --- |
| ambiguity, novelty, consequence | `low`, `medium`, `high` |
| reversibility, verificationStrength | `low`, `medium`, `high` |
| contextSize | `small`, `medium`, `large` |
| toolComplexity | `low`, `medium`, `high` |
| interactionMode | `interactive`, `autonomous` |
| qualityTarget | `routine`, `high`, `critical` |
| latencyPreference, costPreference | `minimize`, `balanced`, `relaxed` |
| confidence | `low`, `medium`, `high` |

Evidence strings are bounded summaries derived from the slice contract, not
arbitrary prompt excerpts. A profile with missing required fields, unsupported
values, or no evidence for a `high` risk signal fails validation. Low classifier
confidence must bias toward a safer route or return `attention`; it must never
silently bias toward the cheapest route.

### Legacy task-shape translation

Existing plans remain valid during migration. Translate a legacy `taskShape`
into a profile with `confidence: "low"` and record
`profileSource: "legacy-task-shape"`. This preserves compatibility without
pretending the old label supplied evidence it did not contain.

## Host Capability Snapshot

Recommendations should be made only across routes supported by a bounded,
current host observation:

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-07-23T12:00:00.000Z",
  "source": "native-model-list",
  "models": [
    {
      "id": "gpt-5.6-terra",
      "efforts": ["low", "medium", "high", "max"],
      "nativeFanout": false
    }
  ]
}
```

The snapshot is capability evidence, not a durable entitlement. Give it a
short maximum age and recheck at launch. If no snapshot is available, the
policy may issue an advisory recommendation, but exact launch behavior remains
fail-closed.

This removes wire-value guesses such as `xhigh` from the launch path when the
host does not explicitly advertise them.

## Policy Engine

The first adaptive policy should be a versioned scorecard, not a learned model.
It has two stages.

### 1. Determine the required capability bands

Model capability should respond primarily to:

- ambiguity;
- novelty;
- context size;
- cross-domain judgment;
- low classifier confidence.

Reasoning effort should respond primarily to:

- consequence;
- reversibility;
- verification strength;
- multi-step tool complexity;
- quality target.

Examples of conservative policy rules:

- High ambiguity or novelty establishes at least the frontier model band.
- Critical quality plus weak verification establishes at least `high` effort.
- High consequence plus low reversibility cannot use the efficient model band.
- Strong deterministic verification may lower effort by one band for routine,
  reversible work.
- Low profile confidence raises one dimension or returns `attention`.

The exact table belongs in versioned data so policy changes are reviewed
separately from routing code.

### 2. Rank eligible candidates

Enumerate every host-supported `(model, effort)` pair. Reject candidates below
the required bands, then rank the remainder by:

1. predicted quality sufficiency;
2. explicit latency and cost preferences;
3. measured correction and rejection rates;
4. deterministic stable tie-breaking.

Before sufficient measurements exist, catalog bands and reviewed latency/cost
ordinals provide the ranking. Empirical estimates may replace those priors only
when sample-size and confidence thresholds are met.

The engine should return the whole decision, not merely the winner:

```json
{
  "schemaVersion": 3,
  "decisionId": "route:...",
  "policyVersion": 3,
  "catalogVersion": "openai-...",
  "profileSource": "queen-authored",
  "selected": {
    "model": "gpt-5.6-sol",
    "effort": "high"
  },
  "alternatives": [
    {
      "model": "gpt-5.6-sol",
      "effort": "medium",
      "rejectedBecause": ["below critical-quality effort floor"]
    }
  ],
  "confidence": "medium",
  "reasons": [
    "High ambiguity requires the frontier model band",
    "Critical quality and weak verification require high effort"
  ],
  "launch": {
    "nativeTask": {
      "model": "gpt-5.6-sol",
      "thinking": "high"
    }
  },
  "escalationPolicy": {
    "maxRouteChanges": 1,
    "on": ["queen-rejected", "verification-inconclusive"],
    "next": {
      "model": "gpt-5.6-sol",
      "effort": "max"
    }
  }
}
```

## Overrides and Safety

Keep the current precedence:

```text
explicit override → adaptive recommendation → host default
```

An override may select model, effort, or both independently. It must still pass
catalog and live-capability validation. The decision record should preserve
which dimensions were overridden and which were recommended.

High-consequence safety floors should not be silently bypassed. An override
below a floor must either:

- carry an explicit `allowBelowSafetyFloor` authorization with a reason; or
- fail with `attention`.

Ultra remains a separate execution policy because it changes fan-out behavior,
not merely reasoning intensity.

## Adaptive Escalation

Prompt correction and route escalation solve different failures and must remain
separate:

| Evidence | Response |
| --- | --- |
| Invalid result envelope | Correct the prompt/result on the same route |
| Missing requested artifact | Correct the same task on the same route |
| Queen rejection for shallow analysis | Raise effort |
| Queen rejection for unresolved judgment or ambiguity | Raise model |
| Exact-route verification mismatch | Stop; do not treat as a quality failure |
| Host rejects route as unavailable | Refresh capabilities and return `attention` |
| Repeated failure at policy limit | Stop for queen/user review |

Every escalation creates a new route decision linked to the prior decision.
Attempts and route changes remain bounded. A route must never be escalated
merely because a task timed out or evidence is unavailable.

## Outcome Observation

Routing telemetry should be local, bounded, and content-free:

```json
{
  "schemaVersion": 1,
  "decisionId": "route:...",
  "policyVersion": 3,
  "catalogVersion": "openai-...",
  "profile": {
    "ambiguity": "high",
    "novelty": "medium",
    "consequence": "high",
    "reversibility": "low",
    "verificationStrength": "medium",
    "contextSize": "large",
    "toolComplexity": "medium",
    "qualityTarget": "critical",
    "confidence": "medium"
  },
  "route": {
    "model": "gpt-5.6-sol",
    "effort": "high"
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

Do not persist task titles, objectives, prompts, acceptance-criterion text,
messages, reasoning, artifacts, source paths, tool output, environment values,
or credentials. Keep route verification separate from outcome quality:
verification proves what ran, not whether it was good.

Queen acceptance is stronger evidence than worker self-report but is still a
model judgment. Where available, record independent test or verifier strength
as a coarse category so evaluation can weight outcomes appropriately.

## Evaluation and Calibration

Recommendation quality needs dedicated tests beyond deterministic unit tests.

### Static policy tests

- Every valid profile produces a deterministic decision.
- Higher consequence or lower reversibility never lowers the safety floor.
- Stronger quality targets never select a weaker candidate.
- Unsupported host routes are never selected.
- Overrides, Ultra gates, and exact launch options retain current behavior.

### Golden task corpus

Build a checked-in corpus of synthetic, content-free task profiles with reviewed
expected capability floors. This tests policy intent without claiming empirical
optimality.

### Offline replay

Replay recorded content-free observations through candidate policy versions.
Compare:

- queen acceptance rate;
- independent verification rate;
- corrective-turn and route-escalation rate;
- latency bucket distribution;
- estimated relative cost;
- safety-floor violations.

Historical observations show correlation, not causation. Use them to reject
obviously worse policies, not to prove one route caused an outcome.

### Controlled comparisons

For low-consequence, reversible work only, optionally compare adjacent eligible
routes. Never experiment below a safety floor. Promote an empirical estimate
only after a configured minimum sample size and confidence threshold.

## Integration with Current Modules

Add small modules with narrow responsibilities:

| Module | Responsibility |
| --- | --- |
| `intelligence-task-profile.mjs` | Validate profiles and translate legacy shapes |
| `intelligence-capabilities.mjs` | Validate and age host capability snapshots |
| `intelligence-policy-catalog.mjs` | Versioned bands, floors, and scorecard rules |
| `intelligence-recommender.mjs` | Filter, score, explain, and select candidates |
| `intelligence-escalation.mjs` | Classify evidence and derive bounded route changes |
| `intelligence-observation-store.mjs` | Persist content-free decision outcomes |
| `intelligence-evaluation.mjs` | Aggregate and replay observations |

Keep `intelligence-profile-router.mjs` as a compatibility facade initially. It
can translate legacy task shapes and call the recommender while preserving the
existing launch output. Do not mix telemetry persistence into the pure routing
function.

The slice-plan schema should evolve additively:

```json
{
  "taskShape": "complex/open-ended",
  "intelligenceProfile": {}
}
```

During migration, exactly one may be supplied. A later schema version can make
`intelligenceProfile` primary while retaining a legacy reader for persisted
plans.

The MCP surface should eventually distinguish:

- a pure recommendation call;
- a host-capability observation receipt;
- an outcome-observation write with an explicit local persistence contract;
- an evaluation/report call.

Recommendation remains pure and safe to call during planning. Capability and
outcome writes must not be hidden inside that call.

## Rollout Plan

### Phase 0 — Decision identity and observation

- Add `decisionId` to current route output.
- Join route decisions to existing runtime verification and queen acceptance.
- Persist only the content-free observation contract.
- Produce a local aggregate report.

Exit criterion: route, verification, and acceptance provenance can be joined
without recording task content.

### Phase 1 — Profile contract and shadow policy

- Add the task-profile validator and legacy translator.
- Implement the deterministic scorecard and alternatives.
- Compute shadow recommendations while launching the existing route.
- Add monotonicity, golden-profile, and compatibility tests.

Exit criterion: shadow decisions are deterministic and produce no safety-floor
regressions on the reviewed corpus.

### Phase 2 — Live capability preflight

- Add the native capability receipt and freshness rules.
- Filter recommendations against observed model/effort support.
- Remove unobserved wire values from executable candidates.

Exit criterion: unsupported combinations are rejected before task creation in
live integration tests.

### Phase 3 — Advisory release

- Show the new recommendation, alternatives, confidence, and reasons.
- Keep the current route as the default launch choice.
- Collect opt-in override decisions and outcome measurements.

Exit criterion: representative workloads show a defined improvement in
acceptance-adjusted latency or cost without reducing quality.

### Phase 4 — Adaptive routing

- Make the scorecard recommendation the default.
- Retain explicit overrides and a compatibility flag for legacy routing.
- Enable bounded evidence-specific escalation.

Exit criterion: rollback, policy pinning, and route provenance are verified
across CLI, MCP, and packaged-plugin paths.

### Phase 5 — Empirical calibration

- Calibrate candidate estimates from eligible observations.
- Add optional controlled comparisons for low-risk work.
- Require sample-size, confidence, and regression gates before policy promotion.

Exit criterion: each promoted policy version has a reproducible evaluation
report and an explicit rollback target.

## First Implementation Slice

The safest useful first slice is Phase 0 plus the profile schema from Phase 1:

1. Define and test `TaskIntelligenceProfileV1`.
2. Add stable decision identity without changing current route selection.
3. Define the content-free observation envelope.
4. Join route verification and queen acceptance to that identity.
5. Add a read-only aggregate report.
6. Run the future scorecard only in shadow mode.

This establishes the evidence needed to improve routing before the new system
is allowed to affect a launch.
