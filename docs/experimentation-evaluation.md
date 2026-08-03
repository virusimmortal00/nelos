# Evaluation, Task Corpus, and Statistical Analysis

Status: v1 contracts, governed starter corpus, immutable packaging,
deterministic host graders, release lock, and contamination controls implemented;
statistical analysis remains proposed.

This document defines how experiments are graded and compared. It extends the
[framework contract](experimentation-framework.md) and is intentionally
independent of a specific runner or storage implementation.

The closed v1 `CorpusRelease` and `Task` records are part of the implemented
[contract foundation](experimentation-framework.md#implemented-contract-foundation).
Corpus authoring and release instructions are in
[Governed Corpus Authoring and Release](corpus-authoring.md). Statistical
analysis and subjective-grading execution remain proposed.

## Corpus governance

A `CorpusRelease` is a signed or content-addressed manifest of immutable task
contracts and their assets. It records:

- semantic corpus version, parent release, and changelog;
- task and asset digests;
- category, risk, size, and decomposability strata;
- creation cutoff, provenance, and license;
- exact and near-duplicate analysis;
- grader bundle identities;
- public, development, private-test, or challenge visibility.

Any input, grader, oracle, permission, rubric, or fixture change creates a new
release. A report names exactly one release. Tasks excluded after sealing remain
listed with a reason.

The implemented `CorpusRelease` lifecycle is:

```text
draft -> reviewed -> sealed -> published -> superseded
draft | reviewed | sealed | published -> invalidated
```

`releaseId` content-addresses the complete semantic governance projection.
Successor releases advance both semantic `version` and `revision`, retain the
parent release identity, and bind the parent's digest through `previousDigest`.
Canonical initial and successor fixtures live with the
[contract tests](../test/fixtures/experimentation-contract/corpus-release/).

Development tasks and private evaluation tasks are separate. Policy authors do
not receive private task or oracle access before an experiment is frozen.
Access is audited. Canary markers, similarity analysis, post-cutoff fixtures,
and rotating challenge sets reduce contamination risk. Hosted-model pretraining
contamination cannot be proven absent and remains a reported limitation.

The implemented partition validator binds access, exclusion, membership, and
cross-partition similarity evidence in a deterministic contamination report.
Private packages and oracle bytes remain outside development source and build
artifacts.

## Initial task families

The starter corpus should include several difficulty and decomposability
strata. A single standardized task cannot support a broad efficiency claim.

| Family | Example outcome oracle |
| --- | --- |
| Localized defect repair | Hidden behavioral tests and patch constraints |
| Cross-cutting feature | API, integration, and hidden edge-case tests |
| Multi-module migration | Behavior snapshots, schema compatibility, rollback |
| Test authoring | Mutation score and hidden fault detection |
| Refactor | Behavior equivalence and static constraints |
| Repository investigation | Frozen facts and causal-component match |
| Planning/decomposition | Dependency graph and criterion-coverage validators |
| Routing/capability | Deterministic policy oracle and observed-route receipt |
| Orchestration/restart | Reference state-machine trace and effect invariants |
| Compatibility/safety | Protocol fixtures and forbidden-side-effect audit |

The versioned starter development release includes all ten families above. Its
release and package digests are locked in
[`corpus/starter/release-lock.json`](../corpus/starter/release-lock.json).

Tasks expected to benefit from orchestration must be balanced with tasks where
coordination overhead is unlikely to help. Categories and weights are declared
before results are observed.

## Grading policy

Prefer executable, deterministic grading:

- hidden tests;
- state and protocol invariants;
- canonical JSON or AST comparisons;
- API, ABI, and schema snapshots;
- mutation testing;
- exact or tolerance-bounded defect matching;
- forbidden-file, permission, or effect audits.

An agent message, queen acceptance, or successful process exit is diagnostic
evidence only.

The implemented machine grader requires a distinct host grader environment,
uses host-observed termination and contamination evidence, strips worker
self-report, and keeps rubric and oracle bytes out of the candidate envelope.
Its implementation identity binds a deterministic manifest of the complete
local corpus and experimentation-contract module closure, while `RuntimeLock`
binds Node and built-in behavior. A package carrying an older or otherwise
different grader identity is rejected before grading.
Golden conformance fixtures cover success, failure, partial, timeout, malformed,
contaminated, and grader-failure outcomes.

Some research, requirements, and architecture tasks require judgment. These
tasks use a separately versioned blinded rubric, at least two independent
raters, retained ratings, inter-rater statistics, and adjudication. Subjective
scores remain a separate stratum and cannot silently enter the fully objective
aggregate.

The same task output and deterministic grader image must reproduce the same
machine grade. Regrading produces a new report linked to the original artifacts.

## Measurement taxonomy

### Correctness

- Strict task pass rate is primary.
- A predeclared score from zero to one may be secondary.
- Candidate-caused timeout, crash, malformed output, route mismatch, safety
  violation, or unapproved intervention scores zero.
- Partial work receives only rubric-defined credit and is not a strict pass.
- Repetitions estimate success probability; the best run is never selected.

### Reliability

Measure:

- completion without retry;
- candidate failure and timeout rates;
- route mismatch and safety rates;
- duplicate-effect rate;
- replay consistency;
- within-task variance and flakiness.

The denominator is all valid started attempts, including failures, timeouts, and
partial outcomes. Invalid infrastructure or grader attempts are reported
separately and replaced only under a sealed symmetric retry rule.

### Latency

Record queue, provisioning, time to first useful result, execution, grading, and
terminal wall time independently and end to end. Timeouts are retained at the
limit for bounded summaries and treated as censored for survival analysis.
Report median, p90, and restricted mean rather than mean of successes only.

### Resources

Record:

- input, cached-input, output, and reasoning-output tokens;
- model requests and task-web descendants;
- tool calls and failures;
- CPU time and peak memory;
- disk and network bytes;
- concurrency-seconds.

Unavailable counters are missing, never zero.

### Credits and monetary cost

The result schema distinguishes:

- `measuredTokens`: provider/runtime-observed token categories;
- `estimatedStandardCredits`: measured tokens multiplied by a versioned public
  credit rate card;
- `observedBillingCredits`: an authoritative per-run billing observation when
  available;
- `observedCurrencyCost`: provider-billed monetary cost when available.

Estimated credits are never labeled as observed. Price-table changes create a
new derived report. Retries, failures, planning, grading model calls, and every
task-web member are included.

Useful efficiency ratios include:

```text
tokens per strict success
estimated credits per strict success
wall time per strict success
score per thousand tokens
strict successes per task-web attempt
```

Ratios are reported alongside their numerator and denominator. A cheap failed
attempt is not an efficiency win.

## Experimental design

Randomize candidate order within blocks defined by task, seed or variant,
environment, and time window. Candidates execute in independent workspaces.
Paired comparisons are preferred when candidates can receive the same immutable
task inputs without shared mutable state.

The task is the independent sampling unit. Repeated attempts are clustered
within task; they do not inflate the effective sample size. Use task-level
aggregation, a hierarchical model, or a cluster bootstrap.

The complete seed schedule is derived and persisted before execution. The same
seed means the same task variant and allocation block, not identical hosted
model inference.

Run a pilot to estimate base rates and variance, then choose sample size from a
predeclared minimum detectable effect and power target. A fixed arbitrary run
count can inform a pilot but cannot promote a candidate.

## Statistical methods

Every report includes sample sizes, eligible attempts, exclusions, point
estimates, confidence intervals, effect sizes, and the declared decision rule.

- Pass and reliability: paired risk difference, relative risk, and an exact or
  paired binary test where applicable.
- Latency, tokens, credits, and resources: paired differences or ratios using a
  task-cluster bootstrap or permutation method.
- Timeouts: paired survival or restricted-mean analysis.
- Flakiness: task-level variance and intraclass correlation.

The default confidence level is 95 percent. The primary endpoint and comparison
family are sealed. Holm correction controls the primary family-wise error;
Benjamini-Hochberg may label exploratory findings. Optional stopping is
prohibited unless the design includes group-sequential boundaries and alpha
spending.

## Promotion and regression decisions

A product policy or release gate should require all of:

1. No safety-floor violation, unauthorized effect, duplicate committed effect,
   or overwritten user state.
2. Correctness and reliability noninferiority in every critical stratum.
3. The primary practical benefit threshold is met.
4. Latency, token, credit, and resource regressions remain within their caps.
5. Invalidity, contamination, route mismatch, and missing-evidence ceilings
   pass.

Margins are product decisions and must be ratified with pilot data. Reasonable
starting proposals are:

- routine correctness/reliability noninferiority margin: two percentage points;
- critical margin: one percentage point;
- p90 latency and normalized-credit regression cap: ten percent;
- practical efficiency benefit: at least ten percent when quality is merely
  noninferior;
- any critical safety violation: automatic reject and rollback.

If a confidence interval crosses a required margin, the decision is
`inconclusive`, not `pass`.

## Initial study matrix

The first study should stage its matrix rather than running every combination:

1. Pilot corpus calibration using direct Codex and deterministic graders.
2. Product comparison: direct defaults versus Nelos defaults.
3. Route-controlled comparison for supported model/effort combinations.
4. Plugin-version comparison from fresh isolated homes.
5. Confirmatory run with the sealed corpus, repetitions, and decision rule.

Requested and observed routes are distinct fields. A provider or host reroute is
never silently analyzed as the requested candidate.

## Evaluation invariants

1. Corpus membership, exclusions, category weights, seeds, metrics, and
   decisions are frozen before outcomes are unblinded.
2. No task serves as both development and private test evidence in the same
   policy lineage.
3. Every category has a machine oracle or independently repeatable blinded
   procedure.
4. Timeouts and candidate failures remain in correctness and efficiency
   accounting.
5. Invalid trials are visible by cause; asymmetric invalidity invalidates the
   comparison.
6. No aggregate improvement masks a critical-stratum regression.
7. Every reported decision can be recomputed from immutable attempt and grader
   manifests.
