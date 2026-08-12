# Isolated-Queen Routing Evaluation

Status: implemented developer and dogfood suite.

This suite tests the claim that Nelos launches workers on varied, exact model
and reasoning routes. It is deliberately smaller than the general
[experimentation framework](experimentation-framework.md): it can be run now in
fresh Codex Desktop tasks, before the full experiment runner and telemetry
ledger exist.

The suite separates four questions that should not be conflated:

1. Does a reviewed `taskShape` produce the documented route?
2. Does an explicit model/effort choice survive planning, launch, and runtime
   verification unchanged?
3. Does the automatic recommendation policy choose enough reasoning for
   high-consequence situations?
4. Can each observation prove the decision's task shape, selection source,
   route schema, policy, and catalog rather than merely naming a model?

The first two are release-gating probes. The third is a semantic challenge
lane. A challenge failure is reported as `known-gap-reproduced`; it does not
turn the current mechanical routing checks green or red. When a future adaptive
policy satisfies the challenge, the grader reports `unexpected-pass` so the
baseline can be reviewed and promoted intentionally.

## Current coverage

The versioned manifest is
[`evals/routing/isolated-queen-scenarios.v1.json`](../evals/routing/isolated-queen-scenarios.v1.json).
It covers:

- Sol, Terra, and Luna;
- low, medium, high, and max effort;
- joined subagents and durable spinoffs;
- task-shape recommendations and independent explicit overrides;
- eight natural-language planning situations, including three current-policy
  baselines and five semantic challenges;
- requested-versus-observed route matching;
- independent-dimension challenges such as Sol/low and Terra/high;
- critical, irreversible, weak-oracle and cost-pressure challenges that should
  retain a Sol/high safety floor.

Terra/max is opt-in because it is the most expensive mechanical probe. Four
forward-policy challenges are also opt-in; the default set remains a bounded
nine scenarios and covers every model plus low, medium, and high effort.

This distribution is intentional. The current automatic policy can naturally
produce only Sol/medium, Terra/low, and Luna/low. High and max are therefore
explicit-route probes until adaptive routing is implemented. Pretending those
were automatic recommendations would hide the exact limitation the suite is
meant to measure.

## Validate and inspect the suite

```bash
npm run eval:routing -- validate
npm run eval:routing -- list
npm run eval:routing -- list --all
npm run eval:routing -- prompt shape-sol-medium
```

`validate` is offline and makes no model calls. `prompt` prints the scenario
plus a standard live protocol to paste into one new queen. Each invocation
automatically appends a unique run ID to every work-unit ID so retained durable
records from an earlier probe cannot collide with a rerun. Supply a stable ID
with `--run-id RUN_ID` only when reproducing or reconciling the same launch.
The protocol binds
the current task—not a delegation source—as the orchestration queen, requires
lazy plugin-tool discovery before declaring Nelos unavailable, and requests a
closed observation summary.

## Run live probes

For every selected scenario:

1. Start a new Codex task in a newly isolated worktree. Do not reuse a queen or
   writable workspace between scenarios.
2. Print and paste the scenario prompt:

   ```bash
   npm run eval:routing -- prompt SCENARIO_ID
   ```

3. Let the Nelos skill follow its machine-generated actions to completion. Do
   not replace unavailable launchers or routes. If the plugin is installed but
   its MCP tools are lazy, use host tool discovery; listing MCP resources does
   not load plugin tools.
4. Retain the exact `nelos_intelligence_verify` result for every worker. A
   planned execution-map card is not observed-route evidence.
5. Record the queen task ID, isolated workspace identity, worker thread and
   turn IDs, slice lifecycle, requested route, observed route, and verification
   result in an observation bundle. Copy task shape, profile, per-dimension
   selection source, route schema, policy version, and catalog version from the
   route decision—not from the expected template.

Generate a fill-in template for the default suite or a bounded subset:

```bash
npm run eval:routing -- template > routing-observation.json
npm run eval:routing -- template shape-sol-medium override-sol-high \
  > routing-observation.json
```

Every generated run binds `orchestrationQueenTaskId` to `queenTaskId`. A
different value is a hard isolation failure. Every generated member starts
with `"verified": false`. Change it to `true`
only when the exact runtime-verification receipt confirms the requested model
and effort. Replace all `replace-*` identities with native evidence; the grader
rejects reused queen and workspace IDs.

## Grade observations

Grade every default scenario:

```bash
npm run eval:routing -- grade routing-observation.json
```

Grade an intentionally bounded subset:

```bash
npm run eval:routing -- grade routing-observation.json --partial
```

The first bounded Desktop pilot is retained as
[`live-pilot-2026-08-03.json`](../evals/routing/observations/live-pilot-2026-08-03.json).
It intentionally remains failing evidence: five fresh tasks stopped at plugin
tool preflight, while the Luna/high probe verified its exact route but bound
orchestration to the delegation source rather than the isolated task. Keeping
the raw closed observation prevents either infrastructure failure from being
misreported as a routing-policy result.

The corrected single-scenario retry is retained as
[`live-smoke-retry-2026-08-03.json`](../evals/routing/observations/live-smoke-retry-2026-08-03.json).
It bound both queen identities to the fresh task as intended, but still stopped
at `attention` with zero workers because that task exposed neither Nelos MCP
tools nor a lazy plugin-tool discovery surface. The next live run therefore
requires a verified plugin activation/reload preflight; repeating routing
scenarios before that would only resample infrastructure availability.

The post-upgrade retry is retained as
[`live-smoke-post-upgrade-2026-08-09.json`](../evals/routing/observations/live-smoke-post-upgrade-2026-08-09.json).
The fresh task discovered the Nelos tools, passed its initial `0.12.10`
runtime-health preflight, bound itself as queen, and planned Luna/high. Before
worker launch, the installed plugin changed to `0.12.11`; runtime health then
reported mixed `0.12.10`/`0.12.11` generations and correctly fenced mutation.
The run therefore remains `attention` with zero workers. Its exact recovery is
to quit and relaunch Codex, then retry from another fresh task.

The first healthy single-generation matrix on 2026-08-11 produced one exact
route pass and two distinct infrastructure findings. The retained
[`live-sol-high-2026-08-11.json`](../evals/routing/observations/live-sol-high-2026-08-11.json)
passes its partial grade after a joined worker was independently verified as
`gpt-5.6-sol/high`. The retained
[`live-terra-low-attention-2026-08-11.json`](../evals/routing/observations/live-terra-low-attention-2026-08-11.json)
fails closed: the requested Terra/low spinoff completed on a different host,
so identity was available but topology, rollout read, and runtime-route
verification were not. Its unavailable observed route is represented by JSON
`null`, not by copying the requested route.

The retained
[`live-luna-low-launch-pending-2026-08-11.json`](../evals/routing/observations/live-luna-low-launch-pending-2026-08-11.json)
captures the third matrix outcome: the exact Luna/low route was planned, but
native isolated-task creation never returned a worker identity, including
after reconciliation proved the first outcome absent and permitted one retry.
The run therefore records `launch-pending` with no worker rather than claiming
an observed Luna route.

The same session also reproduced a durable rerun collision before worker
launch; it is retained as
[`live-luna-high-repeat-attention-2026-08-11.json`](../evals/routing/observations/live-luna-high-repeat-attention-2026-08-11.json).
An older execution already owned the static `write-luna-high-fixture` work-unit
ID. Live prompt generation now appends a unique run ID to every slice and
dependency ID, preventing future probes from colliding with retained execution
records while keeping the scenario and expected route unchanged.

The first recommendation-path retry after that repair is retained as
[`live-shape-sol-medium-2026-08-12.json`](../evals/routing/observations/live-shape-sol-medium-2026-08-12.json).
A fresh isolated queen supplied only the `complex/open-ended` task shape;
Nelos recommended a joined Sol/medium worker, the native launch batch verified
its identity and topology, and a post-completion runtime check independently
observed the exact Sol/medium route. This passes the `shape-sol-medium`
mechanical probe without an explicit model or effort override.

The completed default recommendation comparison is retained as the
[`recommendation-diversity-2026-08-12.md`](../evals/routing/observations/recommendation-diversity-2026-08-12.md)
packet and its schema-checked
[`live-shape-recommendation-diversity-2026-08-12.json`](../evals/routing/observations/live-shape-recommendation-diversity-2026-08-12.json)
bundle. Two additional fresh isolated queens recommended and independently
observed Terra/low and Luna/low. Their current terminal-turn result receipts,
resolver correlation, acceptance, and archival dispositions are recorded
separately from their recommendation and route-verification outcomes. Together
with the fresh Sol/medium result, the three distinct route-verified defaults
establish recommendation diversity without relying on a planned route or a
delivery-only signal.

The command exits nonzero when a must-pass route is missing, unverified,
mismatched, selected for the wrong reason, on the wrong lifecycle surface, or
observed in a reused queen or workspace. Stale route-schema, policy, or catalog
provenance is always a hard failure, including for a known-gap scenario.
Missing default scenarios also fail a complete grade. Known-gap policy
differences remain visible in the report but do not mask mechanical or evidence
regressions.

## Evidence boundary

The observation format stores only task/workspace/thread/turn identities, slice
IDs, lifecycle, task shape, route profile, per-dimension selection source,
route/policy/catalog versions, model, effort, terminal state, and verification
status. An `attention` run may contain no workers, allowing plugin preflight
failures to be recorded without fabricated route evidence. When a worker exists
but runtime verification fails closed before observing its route, record both
`observedModel` and `observedEffort` as `null`; the grader retains the worker and
fails the probe without inventing runtime evidence. It does not store
prompts, responses, private reasoning, source code, tool output, credentials,
or environment values.

When native creation never returns a worker identity, record the run as
`launch-pending` with an empty member list. This differs from `attention` after
a worker exists: the grader can then report that routing verification never
became possible rather than implying an observed worker failed.

These live dogfood results are diagnostic rather than statistically powered.
Repeated randomized comparisons, immutable task fixtures, resource accounting,
and promotion decisions remain responsibilities of the general
[evaluation design](experimentation-evaluation.md).
