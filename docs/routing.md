# Model & reasoning routing

Nelos routes every slice along **two independent dimensions** — which **model**
runs it, and how much **reasoning effort** it gets — then verifies the launched
task actually ran on that choice. This page explains how each decision is made.

Routing is a *reviewed heuristic*, not an entitlement claim. Codex remains
authoritative at launch: if the host can't run a requested model or the reasoning
tier isn't authorized, the launch fails rather than silently falling back to a
cheaper or weaker default.

## The profiles

Nelos ships a small, versioned catalog of GPT-6 profiles
(`src/intelligence-profile-catalog.mjs`, reviewed against OpenAI's model guidance
and re-dated on each review):

| Profile | Model | Character | Reasoning efforts |
| --- | --- | --- | --- |
| **Sol** | `gpt-6-sol` | Complex coding and work needing judgment | `low` → `max`, plus Codex `ultra` |
| **Luna** | `gpt-6-luna` | Focused, frequent work | `low` → `max` |

The effort ladder is `low` · `medium` · `high` · `xhigh` · `max` · `ultra`. Only
Sol is eligible for Codex `ultra` (see [Max and Ultra](#max-and-ultra)).

## Task shapes pick the starting point

When you hand Nelos a slice's *shape*, it selects a profile **and the lowest
reviewed effort that shape needs** — so routine work isn't over-powered and hard
work isn't starved:

| Task shape | Routes to | Effort | Why |
| --- | --- | --- | --- |
| `complex/open-ended` | Sol | `medium` | Sustained judgment needs a frontier model; medium is the lowest reviewed starting point. |
| `everyday` | Sol | `low` | A capable default for ordinary implementation work. |
| `clear/repeatable` | Luna | `low` | Focused work with explicit acceptance criteria fits Luna on either launcher. |

## Overriding the recommendation

The two dimensions are set independently, and explicit choices always win:

**Precedence:** explicit override → task-shape recommendation → host default
(inherit). Any dimension you don't set falls back to the next level down. With no
routing input at all, Nelos inherits both host defaults and stays out of the way.

The router (`nelos_intelligence_route`) takes any combination of `taskShape`,
`profile`, `model`, `effort`, and `allowNativeFanout`:

```jsonc
{ "taskShape": "everyday" }                 // Sol + low, fully automatic
{ "profile": "luna" }                       // pin Luna, keep the host's reasoning
{ "effort": "high" }                        // keep the host's model, raise reasoning
{ "profile": "sol", "effort": "max" }       // pin both
```

Conflicts fail loudly rather than resolving silently: a `profile` and `model`
that name different profiles, or an `effort` a profile doesn't support, are
errors. Both launchers can request Sol or Luna; the host checks actual
availability at launch. (The contributor CLI mirrors generic routing as `nelos intelligence route
--task-shape everyday`, etc.)

### What comes back

The route returns launch-ready settings plus its own provenance:

```jsonc
{
  "profile": "sol",
  "requestedModel": "gpt-6-sol",
  "requestedEffort": "low",
  "modelSelection": "recommended",   // inherit | recommended | override
  "effortSelection": "recommended",
  "launch": { "nativeTask": { "model": "gpt-6-sol", "thinking": "low" } },
  "rationale": "Everyday work is routed to Sol with low reasoning …"
}
```

`launch.nativeTask` is handed straight to the selected Codex launcher — `model`
and `thinking` already filled in — so the skill never reconstructs launch
settings by hand. The shared launch-contract validator accepts GPT-6 Sol and
Luna on `spawn-subagent`, including lower-level orchestration calls.

## Max and Ultra

`max` is the highest **single-task** reasoning tier. `ultra` goes further: it also
permits native **subagent fan-out**, so it's gated twice — it requires an explicit
or recommended **Sol** profile *and* explicit permission
(`allowNativeFanout: true`). Requesting `ultra` any other way is an error.

## Verification (fail-closed)

Routing a task isn't the same as trusting it ran that way. After launch,
`nelos_intelligence_verify` checks the claim against evidence:

```jsonc
{ "threadId": "…", "model": "gpt-6-sol", "effort": "low" }
```

It locates the task's local Codex rollout under `~/.codex/sessions`, reads the
`turn_context` events, and compares each turn's recorded `model` and `effort`
against the expected route. It returns `verified: true` **only if every observed
turn matches**; any mismatch (or missing/ambiguous rollout) fails closed, and the
skill stops the wave instead of accepting the result. Pass an optional `turnId`
to check one specific turn.

The check is deliberately narrow: it reads **only** bounded model/effort metadata
— never prompts, messages, reasoning, tool output, or environment values
(`src/runtime-intelligence-verification.mjs`). That's what makes it safe to run
automatically on every launched slice.

## Why it's a heuristic

The catalog and shape mappings are reviewed release data, re-evaluated over time,
not a live capability check. Quality, latency, and cost outcomes still warrant
ongoing evaluation — the value Nelos adds is making the choice *explicit,
per-slice, and verified*, rather than promising a fixed model is always best.

The proposed successor to this heuristic is described in
[Adaptive Intelligence Routing](intelligence-routing-v2.md). It introduces a
structured task profile, live capability filtering, independent model/effort
selection, bounded escalation, and a content-free evaluation loop while
preserving exact launch verification.

The implemented [isolated-queen routing suite](routing-evaluation.md) provides
fresh-task prompts and a closed grader for the current routes, explicit
high/max probes, requested-versus-observed verification, and known-gap semantic
challenges.
