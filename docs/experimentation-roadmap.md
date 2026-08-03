# Experimentation Framework Implementation Roadmap

Status: active implementation sequence; foundation status follows.

This roadmap turns the
[experimentation architecture](experimentation-framework.md) into
dependency-safe delivery waves. GitHub milestones and issues should mirror these
boundaries. Closing a milestone requires its exit criteria, not merely merged
code.

## Current implementation status

The shared contract kernel and the closed v1 `Experiment`, `CorpusRelease`,
`Task`, and `RuntimeLock` contracts are complete. They include canonical golden
and invalid fixtures and are published through the identical 94-symbol
`nelos/experimentation-contract` and
`nelos/experimentation-contract/index.mjs` entry points.

Milestone 1 remains open. Telemetry envelopes, collectors, append-only storage,
artifact controls, task-web accounting, evidence health, provenance validation,
and attempt-manifest verification are complete. The remaining `Trial`,
`Attempt`, `Result`, `Grade`, and `Report` lifecycle records, migration cases,
and integrated runner/reporting work follow the dependency order below.

## Milestone 1: Contracts and Evidence

Deliver the stable boundaries consumed by every later component.

### Experiment and artifact contracts

- Complete: closed schemas for Experiment, CorpusRelease, Task, and RuntimeLock.
- Complete: their canonicalization, digest, identity, revision, lineage, and
  lifecycle utilities on the shared validation kernel.
- Remaining: closed schemas for Trial, Attempt, Result, Event, Artifact, Grade,
  and Report.
- Remaining: migration utilities and fixtures.
- Failure taxonomy and evidence-health model.
- Complete for the implemented subset: golden fixtures for valid, invalid, and
  unsupported-version cases.

Exit: independent implementations derive identical identities and reject the
same invalid fixtures.

### Task corpus and graders

- Complete: task packaging and immutable fixture builder.
- Complete: initial task families and hidden deterministic grader interface.
- Complete: corpus release lock, access, contamination, and review workflow.
- Complete: grader conformance fixtures and blinded-rubric support boundary.
- Complete: transitive grader implementation manifests and fail-closed installed
  identity verification.

Exit: passing, failing, partial, timed-out, contaminated, and grader-failed
fixtures produce the declared machine-readable outcomes.

### Headless runtime

- Pinned OCI/VM image and construction provenance.
- Fresh home/workspace/plugin state per attempt.
- Network, credential, resource, cancellation, and cleanup policies.
- Exact plugin artifact installation and baseline-without-plugin path.

Exit: repeated trials prove no writable state crosses attempts, and sentinel
host processes and sockets remain untouched.

### Desktop runtime

- Complete: dedicated macOS worker admission and automation marker.
- Complete: exact bundle/plugin installation, restart, fresh-task discovery,
  upgrade, rollback, and crash recovery.
- Complete: exclusive fenced lease, targeted lifecycle controls, quarantine,
  cleanup, and signed golden-image reimage.
- Complete: guard that rejects development homes, profiles, credentials,
  headless evidence, and generic process termination.

Exit: install/restart/upgrade/crash tests run on a disposable dedicated worker
and cannot address the development Codex app.

### Telemetry and provenance

- Complete: Codex JSONL, app-server, OpenTelemetry, Nelos task-web, grader, and
  runtime-resource collector contracts.
- Complete: full task-web correlation, deduplication, outcome accounting, and
  separate token, estimated-credit, observed-credit, and currency measures.
- Complete: append-only stream-separated event chains, content-addressed
  artifact manifests, redaction, access, retention, and evidence health.
- Complete: immutable provenance validation and attempt-manifest recomputation
  that rejects altered, missing, duplicated, unauthorized, incompatible, and
  cross-run evidence.

Exit: complete, partial, duplicated, reordered, interrupted, and missing streams
are normalized or rejected without silently losing work.

## Milestone 2: Execution and Analysis

### Experiment runner

- Complete: manifest validation and deterministic matrix expansion.
- Complete: seeds, bounded queues and quotas, fenced leases, attempts,
  cancellation, retry, and generation-based resumption.
- Complete: direct Codex and Nelos adapter API and headless process adapter.
- Complete: idempotent command receipts, reconciliation, and fail-closed
  finalization.
- Complete: local content-addressed attempt storage and replaceable query index.

Exit: a small repeated Nelos-versus-direct matrix is reproducible from a clean
environment and resumes without duplicating valid trials.

### Statistical reporting

- Metric accounting for all terminal and invalid states.
- Paired/task-cluster analysis, intervals, effects, and multiplicity controls.
- Promotion, regression, inconclusive, and safety decisions.
- Machine-readable and human-readable report bundles.
- Golden datasets with known wins, ties, regressions, missing data, and
  insufficient power.

Exit: every aggregate and decision recomputes from immutable accepted attempt
manifests.

## Milestone 3: Continuous and Scaled Validation

### CI and release gates

- Offline contract lane.
- Pull-request smoke matrix.
- Nightly targeted regression matrix.
- Weekly/manual-powered studies.
- Release headless and dedicated Desktop canaries.

Exit: all lanes use the same contracts and runner, and infrastructure failure is
never reported as a product regression or success.

### Fleet operations

- Durable queue and fenced leases.
- Capability admission, quotas, capacity, health, drain, and quarantine.
- Deterministic sharding and verified merge.
- Object storage/index backend, retention, access, and audit.
- Backup, restore, report regeneration, and disaster-recovery exercises.

Exit: scale execution preserves local-run identities, evidence semantics, and
reproducibility.

### Initial confirmatory experiments

- Calibrate the starter corpus.
- Seal product-comparison and route-controlled designs.
- Run plugin-version and code-change regression studies.
- Publish results with limitations and reproducibility bundles.

Exit: the framework has produced at least one confirmatory, independently
recomputable report without using development app state.

## Dependency graph

```text
contracts
  +--> corpus and graders ----+
  +--> headless runtime ------+
  +--> desktop runtime -------+--> experiment runner
  +--> telemetry/provenance --+          |
                                          v
                               statistical reporting
                                          |
                                          v
                                CI and fleet operations
                                          |
                                          v
                               confirmatory experiments
```

## Cross-cutting acceptance

Every implementation issue must include:

- bounded deliverable and out-of-scope statement;
- exact architecture section;
- testable acceptance criteria;
- validation commands and evidence artifacts;
- security, credential, cleanup, and rollback considerations;
- dependencies and milestone;
- migration or compatibility impact.

No issue may weaken immutable identities, isolation, evidence accounting, or
fail-closed finalization merely to make a test pass.
