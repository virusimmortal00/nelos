# Archive projection convergence

An accepted native archive receipt proves that one archive mutation returned
success. It does not by itself prove that every later projection has converged.
`nelos-validate-archive-convergence` evaluates that separate boundary without
replaying or issuing an archive mutation.

```sh
nelos-validate-archive-convergence \
  --input /absolute/path/archive-checkpoints.json \
  --out /absolute/path/archive-convergence-report.json
```

The closed input binds:

- expected task IDs and titles;
- optional exact `native-archive` receipts (required for new live runs);
- a maximum convergence interval and required number of consecutive clean
  observations;
- whether a Desktop restart checkpoint is mandatory;
- the archived IDs observed by every participating Nelos worker;
- IDs retained by ordinary execution maps and native visible inventory;
- IDs visible in the sidebar, Created Tasks, and MCP visualization; and
- a content-addressed `nelos-developer-visual-state-validation` report for each
  checkpoint.

The three Desktop inventories are not aliases for one generic row scan. One
complete bounded AT-SPI traversal must independently prove, in order:

- the Codex sidebar scroll container and rows identified by the app-owned
  `data-app-action-sidebar-thread-id` and title attributes;
- the open `Created tasks` summary container, whose rows map to task IDs only
  through the run's unique sealed titles; and
- the `Nelos task workers` MCP visual container and exact
  `Open Codex task <thread-id>` links.

Each proof retains its accessibility role, contract name, state, bounded scan,
geometry, and independently derived task IDs. The three container geometries
must be distinct. A missing marker, duplicate container, non-unique title,
closed summary, unclassifiable row, declared-count disagreement, or visible
`Show N more…` control fails closed as a typed unsupported, ambiguous, identity,
or incomplete surface result. It is never converted into an empty inventory.
In particular, an exact visible sealed title is positive evidence of a row:
the classifier must reject the observation if that row lacks the exact sidebar
thread ID, a supported Created Tasks lifecycle token, or the exact MCP task-link
ARIA identity. A malformed marker can never turn a visible expected row into an
absence claim.

Every checkpoint has a contiguous sequence, canonical timestamp, phase,
cleanup state, and opaque app-instance identity. A required `afterRestart`
checkpoint must follow a pre-restart checkpoint and use a different app
instance. This prevents relabeling a repeated observation as a restart.

A live cleanup passes only when all expected IDs have required receipts, every
worker reports them archived, and all ordinary, native, and visible projections
omit them for the configured number of consecutive observations within the
deadline. Cleanup marked complete while a projection retains a task produces
`CLEANUP_COMPLETE_BEFORE_PROJECTION_CONVERGENCE`. Missing receipts, worker
drift, stale maps, native visibility, sidebar residue, Created Tasks residue,
MCP residue, insufficient checkpoints, and failed restart identity each have a
separate typed finding.

Archive screenshots remain full-frame black by default. An independently
classified expected title/status region may be restored only when it does not
overlap conversation or credential geometry. Surface membership is retained
even when its pixels stay protected, so screenshot coverage is recorded
separately from the three visual inventories.

Historical investigations may set `requireArchiveReceipts` to `false` when the
bounded historical API no longer exposes the original receipt. They must still
provide the persisted worker state and content-addressed visual reports. This
mode diagnoses convergence; it does not retroactively prove the archive
mutation.

The command exits `0` only for convergence, `1` for valid evidence containing a
product failure, and `2` for malformed or unverifiable evidence. Output files
are mode `0600` and are never overwritten.

## Disposable Desktop runner integration

The resumable Desktop runner requires an `archiveConvergence` plan block. Live
plans must require native archive receipts, a Desktop restart, and at least two
consecutive clean checkpoints. The operation usage reservation must cover the
entire convergence deadline and at least two screenshots.

After all scenario task results are committed and before VM destruction, the
runtime projection controller executes exactly once:

1. archive every exact scenario task ID;
2. collect the post-cleanup worker, map, native, and visual checkpoint;
3. restart Desktop and prove a different app-instance identity; and
4. collect the post-restart checkpoint and evaluate this convergence contract.

The sequence is one journaled external effect. A lost response or runner crash
must use `reconcileEffect`; the runner never repeats archive or restart. A valid
failed convergence receipt records `ARCHIVE_PROJECTION_STALE`, still performs
exact VM destruction or quarantine, and prevents the run from reporting
success. Evidence collection receives the terminal convergence receipt so the
sanitized bundle can retain its content-addressed report references.
