# Experimentation and Regression Framework

Status: proposed architecture; v1 contract foundation implemented.

This document is the entry point for a general-purpose experimentation system
for Nelos and Codex. The system is intended to evaluate product hypotheses,
model and reasoning routes, plugin versions, code changes, efficiency theories,
and future experiment types without rebuilding the runner for each study.

The first study will compare direct Codex execution with Nelos-coordinated
execution across multiple model and reasoning configurations. That study is a
consumer of the framework, not the framework's organizing abstraction.

Related contracts:

- [Evaluation, Task Corpus, and Statistical Analysis](experimentation-evaluation.md)
- [Runtime Isolation and Version Locking](experimentation-runtime.md)
- [Runner, Telemetry, Provenance, and Operations](experimentation-operations.md)
- [Implementation Roadmap](experimentation-roadmap.md)

## Implemented contract foundation

The bounded v1 foundation implements the shared canonicalization, structured
error, validation, revision, and lifecycle kernel plus closed `Experiment`,
`CorpusRelease`, `Task`, and `RuntimeLock` contracts. Import the public API from
either `nelos/experimentation-contract` or
`nelos/experimentation-contract/index.mjs`; both entry points expose the same
94-symbol ESM surface. The shorter subpath is preferred in examples:

```js
import {
  validateCorpusRelease,
  validateExperiment,
  validateRuntimeLock,
  validateTask,
} from "nelos/experimentation-contract";
```

The [public contract index](../src/experimentation-contract/index.mjs),
[package export regression test](../test/experimentation-contract-export.test.mjs),
and [golden and invalid fixtures](../test/fixtures/experimentation-contract/)
are the executable authority for that implemented subset. `Trial`, `Attempt`,
`Result`, `Event`, `Artifact`, `Grade`, and `Report`, along with runners,
graders, telemetry collection, and runtime execution, remain proposed.

## Goals

- Express new experiments as versioned data plus adapters, without changing
  scheduling or reporting code.
- Start every trial from immutable, independently verifiable inputs.
- Grade outcomes outside the agent runtime using deterministic or independently
  reproducible procedures.
- Measure the complete cost and lifecycle of a task, including failed work,
  retries, subagents, spinoffs, graders, and orchestration overhead.
- Compare candidates with repeated, randomized or blocked trials and
  predeclared statistical decision rules.
- Run routine work in disposable headless workers while reserving real Desktop
  lifecycle claims for dedicated macOS workers.
- Select exact Codex, Nelos, plugin, corpus, grader, and runtime versions without
  mutating the Codex app used for development.
- Preserve enough telemetry and provenance to recompute a report and determine
  when a result is not reproducible.
- Support local development, pull-request smoke tests, scheduled regressions,
  release gates, and fleet-scale studies through the same contracts.

## Non-goals

- Treat one task or one run as evidence for a general efficiency claim.
- Treat an agent's self-reported success as an acceptance oracle.
- Claim that a headless CLI or app-server test proves Desktop UI behavior.
- Present token-derived credit estimates as observed billing.
- Make hosted-model inference deterministic when the provider does not expose a
  stable revision or deterministic execution.
- Reuse writable Codex homes, workspaces, credentials, sessions, or plugin
  caches across trials.
- Automatically promote a code, plugin, or routing change from an advisory
  experiment.

## System boundary

```text
sealed experiment
       |
       v
deterministic expansion -----> immutable trial plan
       |                              |
       v                              v
runtime admission ------------> isolated worker
                                      |
                         +------------+------------+
                         |                         |
                         v                         v
                  candidate execution       external grader
                         |                         |
                         +------------+------------+
                                      |
                                      v
                          evidence and artifact ledger
                                      |
                                      v
                         statistical report + decision
```

The control plane owns contracts, expansion, scheduling, leases, collection,
and finalization. A worker owns only the current leased attempt. A grader owns
only the declared transformation from immutable outputs to observations. The
reporter owns aggregation; it cannot invent missing evidence or change the
sealed decision rule.

## Core contracts

Every persisted contract uses a closed, versioned schema. Unknown fields,
unbounded strings, duplicate identities, invalid enums, and non-canonical
numbers fail validation. Semantic changes create a new revision and digest;
sealed records are never edited in place.

### Experiment

An `Experiment` defines the hypothesis and the comparison, not its mutable run
state.

The identity-oriented sketch below is abridged. The
[golden v1 fixture](../test/fixtures/experimentation-contract/experiment-v1.mjs)
constructs the complete closed record, including revision, lineage, lifecycle,
metrics, exclusions, and decision rules.

```json
{
  "schemaVersion": 1,
  "experimentId": "exp:...",
  "specRevision": 1,
  "hypothesis": {
    "primaryMetric": "strict_pass_rate",
    "decisionRule": "noninferior-quality-and-lower-credit-cost"
  },
  "candidates": [],
  "corpus": {
    "releaseId": "corpus:...",
    "digest": "sha256:..."
  },
  "design": {
    "pairing": "task-seed-time-block",
    "repetitions": 5,
    "seedRoot": "non-secret-value",
    "multiplicityFamily": "primary"
  },
  "limits": {},
  "runtimeMatrix": [],
  "graderBundle": {
    "id": "grader-bundle:...",
    "digest": "sha256:..."
  }
}
```

Required identity includes the complete candidate configuration, corpus,
grader, seed schedule, resource limits, runtime eligibility, exclusions,
primary and secondary metrics, minimum detectable effect, and promotion,
regression, stop, and invalidation rules.

`Experiment.runtimeMatrix[].backend` selects an execution adapter and uses
`oci-headless` or `dedicated-desktop`. It is deliberately distinct from the
`RuntimeLock.runtimeClass` admission value `headless-oci` or `desktop-macos`.

Lifecycle:

```text
draft -> reviewed -> sealed -> running -> stopped | completed
completed -> reported -> archived
draft | reviewed | sealed | running -> invalidated
```

No execution may begin before the specification is sealed and its expansion is
persisted.

### Task

A `Task` is one objectively assessable unit in a versioned corpus. It binds:

- prompt or objective bytes;
- repository or workspace fixture and baseline digest;
- deterministic input parameters;
- permissions, tools, network policy, and secret-free environment descriptor;
- time, token, tool-call, disk, process, and network limits;
- expected output and artifact shapes;
- grader identity, version, oracle digest, and partial-credit map.

Changing an input, permission, oracle, rubric, or limit creates a new task
revision. Workers cannot read hidden grader inputs unless the task contract
explicitly declares them public.

The implemented lifecycle is:

```text
draft -> reviewed -> sealed -> retired
draft | reviewed | sealed -> invalidated
```

A semantic revision advances `specRevision`, links `previousDigest`, and
recomputes both the content-addressed `taskId` and record `digest`.

### Trial and attempt

A `Trial` is the comparison unit derived from:

```text
experiment + candidate + task revision + replicate + seed + environment
```

A retry creates a new immutable attempt under the same trial. It never replaces
an unfavorable or incomplete attempt. Each attempt records the requested and
observed model and reasoning route, plugin and runtime identities, all
descendant task identities, terminal state, measurements, artifacts, grading,
and contamination or intervention flags.

Lifecycle:

```text
planned -> queued -> leased -> provisioning -> running -> grading
grading -> succeeded | partial | failed | timed_out | invalid | cancelled
```

### Result, event, artifact, and grading

- A `Result` is the terminal manifest for one attempt. Process exit alone is
  never a result.
- An `Event` is an append-only, correlated lifecycle, measurement, operational,
  or audit observation.
- An `Artifact` is content-addressed bytes plus immutable metadata, provenance,
  classification, redaction, and retention policy.
- A `Grade` references the exact task output, grader contract, grader runtime,
  oracle, and observation schema.

The runner may finalize an attempt only when required event sequences,
measurements, artifacts, provenance, telemetry health, and grades verify.

## Identity and canonicalization

All non-secret identities are derived from canonical JSON. The initial digest
algorithm is SHA-256 over canonical UTF-8 bytes:

```text
experimentId = digest(sealed experiment identity)
releaseId    = digest(corpus release semantic identity)
taskId       = digest(task semantic identity)
runtimeId    = digest(runtime admission and provenance identity)
trialKey     = digest(experimentId, candidate, taskId, taskRevision, replicate, seed, environment)
trialId      = experimentId + truncated trialKey
artifactId   = digest(artifact bytes)
```

Canonical JSON v1 rejects structures deeper than 64 container levels. The
shared readers and serializers default to 64 MiB and enforce a 256 MiB hard
ceiling before recursive work; `CorpusRelease` uses that ceiling for its
bounded task, asset, exclusion, changelog, and duplicate-analysis catalogs.
Limit violations are structured `OUT_OF_BOUNDS` contract errors.

The implemented projections are contract-specific: `Experiment` binds the
sealed design but not display name or description; `CorpusRelease` excludes its
managed identity, revision, lineage, digest, and lifecycle fields; `Task`
selects every semantic task field; and `RuntimeLock` selects every admission
and immutable-provenance field. Identities for later contract kinds in this
section remain architectural until those contracts are implemented.

Display names, branches, tags, marketplace channels, floating model aliases,
and container tags are descriptive only. Execution requires immutable commits,
package digests, image digests, plugin digests, and model revisions when the
provider exposes them. An unavailable model revision is recorded as
unavailable; the framework never manufactures one.

Secrets are excluded from identity material. When equality of a secret-bearing
input must be checked, use a keyed digest stored in restricted provenance.

## Failure taxonomy

Failure is represented by an orthogonal `failureDomain` and `failureClass`.
The initial classes include:

- contract or fixture invalid;
- provisioning or infrastructure failure;
- permission denied;
- tool or capability unavailable;
- requested/observed route mismatch;
- safety or unauthorized-side-effect violation;
- timeout or cancellation;
- runner, adapter, or candidate crash;
- malformed or incorrect output;
- grader failure;
- nondeterministic or flaky evidence;
- contamination or undeclared input;
- user intervention.

Infrastructure, contract, and grader failures are invalid samples only when a
blinded diagnosis shows the candidate did not cause them. Candidate-triggered
timeouts, malformed outputs, tool misuse, route mismatches, unnecessary
intervention, and crashes count against the candidate.

The runner reports `failed`, `invalid`, and `inconclusive` separately.

## Reproducibility levels

Reports declare one of four levels:

- `exact`: all executable identities and deterministic inputs can be restored.
- `equivalent`: contracts and pinned identities match, but a hosted dependency
  may produce a different response.
- `diagnostic`: recorded adapter responses can replay control logic without
  claiming a new provider execution.
- `unavailable`: required identity or retained content is missing.

A replay creates a new run linked to the original. It never appends new evidence
to the original run.

## Extension model

The framework exposes registries for:

- task package loaders;
- candidate adapters, initially direct Codex and Nelos;
- runtime backends, initially OCI headless and dedicated Desktop;
- graders;
- telemetry collectors;
- artifact stores;
- report renderers.

Adapters accept and return versioned contracts. They do not receive the
scheduler's storage credentials or authority to finalize a trial. An extension
with an unknown contract or capability fails admission before credentials or a
writable workspace are attached.

## Initial Nelos efficiency study

The first experiment contains two complementary studies:

1. Product comparison: Nelos with its reviewed default behavior versus direct
   Codex with its corresponding default behavior.
2. Mechanism comparison: routes held constant where supported so orchestration
   effects can be distinguished from model-selection effects.

Candidate dimensions include:

- execution adapter: `direct-codex` or `nelos`;
- Codex build and runtime class;
- requested and observed model and reasoning effort;
- Nelos/plugin artifact digest;
- Nelos routing policy and worker-route policy;
- fast-mode and permission profile;
- task and replicate.

A Nelos attempt includes every queen, planner, joined subagent, durable
spinoff, correction, retry, and failed attempt in its task-web total. Root-task
usage alone is invalid evidence.

Primary outcomes should be strict task pass rate and measured tokens per
successful task. Credit efficiency is derived and observed as described in the
evaluation contract. Secondary outcomes include wall time, tool calls,
completion without retry, task-web size, reliability, and variance.

## Architecture invariants

1. No trial starts from an unsealed or unverifiable contract.
2. No two attempts share writable homes, workspaces, credentials, sessions, or
   plugin state.
3. No result is accepted from worker self-report alone.
4. Failed, partial, timed-out, and retried work remains visible in denominators
   according to the sealed measurement policy.
5. The complete task web contributes to Nelos cost and reliability.
6. Missing required telemetry is missing evidence, never zero usage.
7. Mutable version selectors cannot satisfy runtime admission.
8. Headless evidence cannot satisfy Desktop-only acceptance criteria.
9. Resumption, retry, regrading, and replay create new identities and preserve
   prior evidence.
10. Every aggregate and decision can be recomputed from retained immutable
    inputs or the report is invalid.
