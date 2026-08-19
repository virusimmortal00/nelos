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

Historical investigations may set `requireArchiveReceipts` to `false` when the
bounded historical API no longer exposes the original receipt. They must still
provide the persisted worker state and content-addressed visual reports. This
mode diagnoses convergence; it does not retroactively prove the archive
mutation.

The command exits `0` only for convergence, `1` for valid evidence containing a
product failure, and `2` for malformed or unverifiable evidence. Output files
are mode `0600` and are never overwritten.
