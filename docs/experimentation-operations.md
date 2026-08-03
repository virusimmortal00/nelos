# Experiment Runner, Telemetry, Provenance, and Operations

Status: correlated evidence collectors, append-only event ledger, task-web
accounting, artifact privacy controls, provenance validation, evidence-health
analysis, attempt-manifest verification, the local resumable experiment runner,
and deterministic reporting are implemented; the fleet control plane remains
proposed.

This document defines execution, evidence collection, reporting operations, and
scale behavior for the [experimentation framework](experimentation-framework.md).

These components consume the implemented v1 contract foundation. The evidence
implementation is published from `nelos/experimentation-evidence`; the runner
and reporting engine are published from their corresponding package exports.
Later lifecycle services and the fleet services described here remain proposed.

## Runner responsibilities

The runner implementation is exported from `nelos/experiment-runner` and the
headless CLI is `nelos-experiment`. A runner manifest binds one sealed
`Experiment`, an ordered list of sealed `Task` records, direct-Codex and Nelos
adapter commands, and bounded scheduling policy. Adapter commands consume one
canonical JSON request on standard input and produce one JSON result on standard
output. This keeps invocation replaceable while including the exact command,
version, and non-secret environment declaration in the persisted manifest
digest.

The runner may:

- validate and seal supported contracts;
- expand a deterministic trial plan;
- allocate seeds and blocks;
- schedule eligible workers under leases;
- invoke declared candidate, runtime, and grader adapters;
- collect bounded receipts, measurements, events, and artifacts;
- resume from verified immutable state;
- finalize attempts and runs when evidence is complete.

It may not infer success from exit status, repair missing measurements, silently
substitute a model/plugin/grader, or use operational telemetry as an undeclared
experiment measurement.

## Deterministic expansion

The runner:

1. Validates and canonicalizes the experiment.
2. Sorts dimension names canonically while preserving declared value order.
3. Expands candidate dimensions, corpus order, and replicate index.
4. Derives a stable trial key and component seeds.
5. Persists the ordered plan and digest before scheduling.

Scheduling order cannot change trial identity or seed. Adaptive scheduling is
permitted only as a separately versioned, measured policy with its own seed.

## Run lifecycle

```text
draft -> validating -> expanded -> queued -> running -> finalizing
running -> cancelling -> cancelled
finalizing -> succeeded | failed | invalid | inconclusive
failed | cancelled | invalid | inconclusive -> resuming -> queued
```

Terminal records are immutable. Resume creates a new run generation linked to
the prior run. It adopts a terminal attempt only when plan, provenance, input,
output, grader, and telemetry-health digests match. Other attempts are requeued
with new attempt identities.

Changing source, contracts, corpus, prompts, candidate, runtime, grader, or
measurement definition requires a new experiment identity.

## Commands and effects

Every state-changing command has a stable ID, idempotency key, scope, expected
revision, and input digest. The command ledger returns the original receipt for
exact replay and rejects conflicting reuse.

Externally visible effects use:

```text
prepare -> dispatch -> reconcile -> commit
```

An ambiguous dispatch is reconciled using its adapter-native operation ID and
never blindly repeated.

Cancellation first stops new leases, then issues bounded adapter cancellation.
Post-cutoff outputs are retained and marked; they cannot become measurements
unless the sealed experiment explicitly permits them.

## Event envelope

Events use closed payload schemas and a common bounded envelope:

```json
{
  "schemaVersion": 1,
  "eventId": "evt:...",
  "eventType": "trial.model.completed",
  "stream": "measurement",
  "experimentId": "exp:...",
  "runId": "run:...",
  "runGeneration": 1,
  "taskId": "task:...",
  "trialId": "trial:...",
  "attempt": 1,
  "operationId": "op:...",
  "traceId": "trace:...",
  "writerId": "writer:...",
  "writerEpoch": 1,
  "sequence": 42,
  "previousEventDigest": "sha256:...",
  "observedWallTime": "RFC3339 UTC",
  "monotonicTimeNs": "decimal-string",
  "clockId": "clock:...",
  "payloadSchema": "nelos://events/trial.model.completed/v1",
  "payload": {},
  "classification": "internal",
  "redaction": {
    "policyId": "privacy-v1",
    "status": "none"
  },
  "eventDigest": "sha256:..."
}
```

Required correlation covers experiment, run, task, trial, attempt, process,
operation, model request, tool call, plugin invocation, grader invocation, and
artifact. Non-applicable identifiers are explicit nulls.

Event and payload sizes are bounded. Prompts, responses, stdout, stderr, tool
arguments/results, files, and environment snapshots use artifact references
unless an explicit content policy permits bounded embedding.

Event families include experiment, task, trial, process, tool, plugin, model,
runtime, grading, artifact, telemetry-health, and audit lifecycle events.

## Measurements and operational telemetry

Every event belongs to one stream:

- `measurement`: declared outcome data;
- `operational`: runner, adapter, resource, and health diagnostics;
- `audit`: authorization, provenance, integrity, and retention.

Operational fields cannot enter aggregation unless a versioned measurement
contract promotes them explicitly.

Each terminal attempt declares:

```json
{
  "measurementStatus": "complete",
  "telemetryStatus": "complete",
  "observerEffectStatus": "within-policy",
  "acceptedForAggregation": true
}
```

Dropped events, sink loss, writer crash, backpressure, sampling drift, or
excessive telemetry overhead degrade evidence. Mandatory measurement,
lifecycle, integrity, and drop-notice events are never shed. If they cannot be
committed, pause or fail the attempt.

## Full task-web accounting

Candidate adapters emit a stable root trial ID into every descendant Codex task.
Collectors aggregate:

- root and descendant turns;
- queen, planner, subagent, and spinoff usage;
- correction and retry turns;
- requested and observed routes;
- tool and MCP activity;
- cancellation, blocked, and failed work;
- grader model usage when applicable.

Unattributed descendants invalidate the task-web total. Duplicate observations
are reconciled by stable thread, turn, request, and event identities rather than
summed.

## Provenance manifest

Before execution, commit immutable provenance for:

- repository, exact commit, tree digest, dirty flag, tracked diff, and
  influential untracked inputs;
- contract, corpus, configuration, prompt, permission, and policy digests;
- requested and observed model identities and parameter digests;
- Codex, Nelos, plugin, skill, tool, and MCP schema identities;
- runtime image and host capability attestation;
- dependency lockfiles and SBOM;
- input and grader artifacts;
- runner and collector versions.

Dirty state is allowed only when the contract permits it and the complete
canonical diff and untracked-input manifest are retained. Undeclared filesystem
or network input invalidates the attempt.

## Artifact ledger

Artifacts are staged, hashed while written, closed, independently rehashed, and
atomically committed. The manifest records:

- content digest, kind, media type, encoding, and byte length;
- experiment, trial, attempt, producer event, and provenance identities;
- classification and redaction state;
- storage namespace and encryption;
- retention policy and legal hold;
- manifest digest.

Bytes are immutable. Metadata corrections create a superseding manifest.
Directories use canonical path-entry manifests. Symlinks record link text and
cannot escape the declared root.

Measurements, operational logs, restricted prompts/responses, and quarantined
content use different storage and access policies. Artifact references confer
no read authority.

Credentials, authorization headers, cookies, private keys, and raw environment
dumps are prohibited. Environment capture is allowlist-only. Suspected secrets
are quarantined or dropped before the ordinary sink with a non-sensitive audit
event.

## Clock and completeness

Wall time is diagnostic, not an ordering authority. Every writer records wall
time, monotonic time, a clock identity, sequence, epoch, and periodic
synchronization observations. Cross-host durations are unknown when clock
uncertainty exceeds policy.

Detect missing evidence using:

- contiguous writer sequences and hash chains;
- writer epoch start, flush, and shutdown records;
- expected writers/components from the expanded plan;
- balanced requested/started/terminal events;
- lease heartbeats;
- sink commit acknowledgements;
- artifact cross-reference checks;
- terminal counts and Merkle roots.

A synthetic gap notice describes loss but does not replace evidence.

## Finalization

A run cannot succeed unless:

- expansion and provenance manifests verify;
- every required trial has one authoritative terminal attempt;
- required event chains and measurements are complete;
- grades reference exact outputs and grader identities;
- artifact digests and bounds verify;
- requested/observed route policy passes;
- telemetry and observer-effect policy passes;
- no unresolved cancellation, unauthorized substitution, redaction failure, or
  clock anomaly remains;
- reports can be recomputed from accepted attempts.

A violation produces `failed`, `invalid`, or `inconclusive`, never success with
an informational warning.

## Storage and reporting

The local implementation uses content-addressed immutable JSON objects and
generation refs plus a replaceable derived JSON query index. The immutable
artifact and event formats are the scaling boundary; a later index may use
SQLite or DuckDB, and a later backend can use object storage, PostgreSQL, and a
durable queue without changing experiment contracts.

Every report bundle contains:

- sealed experiment and corpus references;
- ordered trial plan and seed schedule;
- all attempt and exclusion identities;
- raw and aggregate measurements;
- statistical methods and decision;
- runtime, plugin, collector, and grader provenance;
- evidence-health and reproducibility classification;
- human-readable Markdown/HTML plus machine-readable JSON.

## CI and operating lanes

| Lane | Trigger | Purpose |
| --- | --- | --- |
| Contract | Every pull request | Offline schema, canonicalization, reducer, grader, and golden-report tests |
| Smoke | Relevant pull requests | Tiny headless matrix proving isolation and end-to-end plumbing |
| Nightly | Schedule | Targeted task/model/plugin regression matrix |
| Full | Weekly/manual | Statistically powered confirmatory studies |
| Release | Candidate release | Exact plugin/Codex compatibility and headless canary |
| Desktop | Manual/release | Dedicated macOS install, restart, upgrade, recovery, and UI lifecycle |

All lanes use the same runner and contracts. They differ only in the sealed
manifest, task selection, repetitions, and runtime eligibility.

The executable workflow family is `.github/workflows/experiment-ci.yml` and its
shared admission, sharding, provenance, budget, and terminal-evidence contract is
`src/experiment-ci-gates.mjs`. `scripts/run-experiment-ci-gate.mjs` exercises the
same sealed manifest expansion used by `nelos-experiment`; it is also the offline
end-to-end fixture driver for success, regression, infrastructure outage,
interruption, incompatible provenance, and deterministic report regeneration.
Release jobs add a closed canary binding over exact Codex and plugin versions,
source commit, runtime lock, generated schema, and compatibility bundle. Desktop
jobs remain manual and run only on `self-hosted`, `macOS`, and
`nelos-dedicated-desktop` labeled workers.

Shards contain disjoint deterministic trial identities. A merger verifies the
same experiment, corpus, runtime policy, collector, and grader provenance and
rejects duplicate or missing trials.

Caches may accelerate immutable images and fixtures but never mutable trial
state. Artifacts from failed, invalid, and inconclusive runs are retained under
policy because they are necessary for diagnosis and unbiased reporting.

## Fleet behavior

Workers advertise exact runtime-lock digests, runtime class, platform,
architecture, capabilities, network class, permission profile, and resource
slots. Admission requires an exact match.

Use weighted-fair bounded queues, per-tenant quotas, backpressure, and renewable
fenced leases. Capacity is reserved before dispatch. Headless workers may offer
multiple isolated slots; Desktop starts with one mutating slot.

Worker health is `ready`, `leased`, `draining`, or `quarantined`. Readiness
requires identity verification, sufficient resources, clock health, clean state,
and a synthetic probe. Desktop additionally requires its graphical session,
signed bundle, exact plugin, and fresh-task discovery evidence.

## Failure triage and disaster recovery

Infrastructure retry occurs on a clean worker and preserves the original
attempt. Ambiguous mutations reconcile before retry. Contaminated or
cleanup-failed workers are quarantined. Desktop workers reimage from the golden
image after unexplained drift.

The control plane restores from the append-only event, command, lease, and
artifact manifests. It never reconstructs committed side effects from memory.
Backup and restore tests verify artifact reachability, event chains, lease
fencing, and report recomputation.

## Operations invariants

1. Expansion and seeds are stable across scheduling orders.
2. Exact command replay returns the original receipt; conflicting reuse fails.
3. Only the current lease can emit authoritative attempt evidence.
4. Retries and resumes never overwrite prior events or artifacts.
5. Operational telemetry cannot enter analysis without a measurement contract.
6. Required telemetry loss or excessive observer overhead prevents acceptance.
7. Every output and grade resolves transitively to immutable inputs and
   producer provenance.
8. Cross-host timing claims respect clock uncertainty.
9. Artifact deletion cannot remove content still referenced by retained
   evidence.
10. Any unknown or incomplete integrity state fails closed.
