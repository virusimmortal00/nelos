# Model & reasoning routing

Nelos routes every slice along **two independent dimensions** — which **model**
runs it, and how much **reasoning effort** it gets — then verifies the launched
task actually ran on that choice. This page explains how each decision is made.

Routing is a *reviewed heuristic*, not an entitlement claim. Codex remains
authoritative at launch: if the host can't run a requested model or the reasoning
tier isn't authorized, the launch fails rather than silently falling back to a
cheaper or weaker default.

## The profiles

Nelos ships a small, versioned catalog of GPT-5.6 profiles
(`src/intelligence-profile-catalog.mjs`, reviewed against OpenAI's model guidance
and re-dated on each review):

| Profile | Model | Character | Reasoning efforts |
| --- | --- | --- | --- |
| **Sol** | `gpt-5.6-sol` | Frontier — deepest judgment | `low` → `max`, plus `ultra` |
| **Terra** | `gpt-5.6-terra` | Balanced, efficient default | `low` → `max`, plus `ultra` |
| **Luna** | `gpt-5.6-luna` | Fastest, most efficient | `low` → `max` |

The effort ladder is `low` · `medium` · `high` · `xhigh` · `max` · `ultra`. Only
Sol and Terra are eligible for `ultra` (see [Max and Ultra](#max-and-ultra)).

## Task shapes pick the starting point

When you hand Nelos a slice's *shape*, it selects a profile **and the lowest
reviewed effort that shape needs** — so routine work isn't over-powered and hard
work isn't starved:

| Task shape | Routes to | Effort | Why |
| --- | --- | --- | --- |
| `complex/open-ended` | Sol | `medium` | Sustained judgment needs a frontier model; medium is the lowest reviewed starting point. |
| `everyday` | Terra | `low` | A capable, efficient default for ordinary implementation work. |
| `clear/repeatable` | Luna | `low` | The task and acceptance criteria are explicit, so a fast model suffices. |

## Overriding the recommendation

The two dimensions are set independently, and explicit choices always win:

**Precedence:** explicit override → task-shape recommendation → host default
(inherit). Any dimension you don't set falls back to the next level down. With no
routing input at all, Nelos inherits both host defaults and stays out of the way.

The router (`nelos_intelligence_route`) takes any combination of `taskShape`,
`profile`, `model`, `effort`, and `allowNativeFanout`:

```jsonc
{ "taskShape": "everyday" }                 // Terra + low, fully automatic
{ "profile": "terra" }                      // pin Terra, keep the host's reasoning
{ "effort": "high" }                        // keep the host's model, raise reasoning
{ "profile": "sol", "effort": "max" }       // pin both
```

Conflicts fail loudly rather than resolving silently: a `profile` and `model`
that name different profiles, or an `effort` a profile doesn't support, are
errors. (The contributor CLI mirrors this as `nelos intelligence route
--task-shape everyday`, etc.)

### What comes back

The route returns launch-ready settings plus its own provenance:

```jsonc
{
  "profile": "terra",
  "requestedModel": "gpt-5.6-terra",
  "requestedEffort": "low",
  "modelSelection": "recommended",   // inherit | recommended | override
  "effortSelection": "recommended",
  "launch": { "nativeTask": { "model": "gpt-5.6-terra", "thinking": "low" } },
  "rationale": "Everyday work is routed to Terra with low reasoning …"
}
```

`launch.nativeTask` is handed straight to Codex's native task tool — `model` and
`thinking` already filled in — so the skill never reconstructs launch settings by
hand.

## Max and Ultra

`max` is the highest **single-task** reasoning tier. `ultra` goes further: it also
permits native **subagent fan-out**, so it's gated twice — it requires an explicit
or recommended **Sol or Terra** profile *and* explicit permission
(`allowNativeFanout: true`). Requesting `ultra` any other way is an error.

## Verification (fail-closed)

Routing a task isn't the same as trusting it ran that way. After launch,
`nelos_intelligence_verify` checks the claim against evidence:

```jsonc
{ "threadId": "…", "model": "gpt-5.6-terra", "effort": "low" }
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
