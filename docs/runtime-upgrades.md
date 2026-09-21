# Runtime continuity across plugin upgrades

The installer selects the release for new connections. Existing MCP workers
continue using their original, verified runtime image. Upgrades do not replace
imported JavaScript, task identities, webs, work attempts, or action receipts.

## Modules and guarantees

| Module | Responsibility | Verification boundary |
| --- | --- | --- |
| `runtime-retention.mjs` | Copy the distributable files, verify digest and provenance, atomically publish before server import | Real temporary files; concurrent publication, cache deletion, tampering |
| `runtime-compatibility.mjs` | Validate the explicit behavioral contract and bind it to retained bytes | Pure compatibility matrix; real distribution hashes |
| `runtime-worker-registry.mjs` | Admit compatible writers under the registration lock; retain the state contract after workers exit | Temporary leases, fake clock/process identities; real multiprocess coexistence |
| `runtime-identity.mjs` | Distinguish installation selection from a retained worker's health; provide its skill path | Real retained images and cache replacement |
| `runtime-mutation-fence.mjs` | Recheck health at admission and immediately before durable commit | Injected health transitions and real store writes |
| MCP / planning lifecycle | Preserve tool inputs, task identity, launch receipts, replay, and accepted progress | Real MCP subprocesses and durable stores against a fake Codex host; zero model calls |

`src/runtime-compatibility.json` is covered by the distribution digest. Each
token promises a behavioral contract: state validation and exact-attempt CAS,
closed MCP inputs and compatible results, checkpoint-bound receipt replay,
process-start file locking, and skill instructions that defer to runtime health.
Every token must match for symmetric coexistence or rollback. A package version
or schema version by itself cannot authorize an upgrade. Release authors must
change the relevant token for incompatible behavior and retain tokens only when
the regression and cross-generation tests pass. Adding a token requires a new
contract format; unknown formats fail closed.

The first retained writer pins the contract in `runtime-workers/compatibility.json`
under the same lock used to register workers. A new incompatible writer never
joins the registry; it can answer diagnostics with `upgrade-deferred`. The pin
survives crashes, PID reuse, and all workers exiting. Compatible arrivals cannot
change it between another worker's admission and commit. There is deliberately
no automatic schema migration or contract-reset operation. Incompatible releases
need a separate, verified migration with writers drained; restoring a compatible
release is the supported recovery. The optional CLI's direct state writes remain
outside MCP admission and must not be used to run an incompatible migration.

## Retention and task instructions

Images live under `$XDG_STATE_HOME/nelos/runtime-images/<version>/<build>` (or
`~/.local/state/nelos/runtime-images`). The image contains all distributable
code, assets, skills, and references. Files are never overwritten by an upgrade.
Failed staging copies are removed; a process crash can leave an inert staging
directory, which is never selected as a runtime.

No images are automatically garbage-collected. A missing or expired worker
lease does not prove that a closed Desktop task no longer needs the image.
This deliberately trades disk space for reliable reopening and rollback. Delete
an image only after all tasks that reference it have been retired. Never rewrite
an old plugin-cache path as an alias to a different generation.

The legacy inline bootstrap first looks for the configured version in the cache,
then in retained images if the cache was removed. Multiple retained builds of the
same version fail as ambiguous. Agent Plugins v1 launches from its configured
plugin root; a host that removes that root must refresh its launch configuration
before reconnecting. Already-running workers are unaffected in both layouts.
`nelos_runtime_health` and initialization expose the retained `skillPath` so a
task can load its original instructions and references without reconstructing webs.

Pre-fix workers cannot acquire these changes retroactively. The initial upgrade
may require the old worker's restart recovery once. Future compatible upgrades
preserve tasks; host catalog refresh/restart behavior is a separate capability.
The plugin never kills or reloads a connection it does not own.

## Verification

Run the offline module and multiprocess checks:

```sh
NODE_OPTIONS=--require=./scripts/offline-network-blocker.cjs node --import ./scripts/test-bootstrap.mjs --test test/runtime-identity.test.mjs test/runtime-worker-registry.test.mjs test/runtime-mutation-fence.test.mjs test/runtime-upgrade-continuity.test.mjs test/mcp-config.test.mjs
npm run verify:planning-lifecycle
```

The synthetic A/B releases intentionally run the same behavioral contract under
different versions and digests. The lifecycle test upgrades while a planner
receipt exists, verifies old/new workers coexist, reconnects the same queen on
B, and replays the receipt through the real lifecycle, launch-batch validation,
and replanning flow. Separate tests reject changed contracts and tampered images.
Existing orchestration and spinoff tests cover acceptance/archive idempotency;
the upgrade test does not claim real Desktop archival or live model execution.

Before release, a bounded Desktop canary should keep one queen and its spinoffs
open, install a compatible release, check both generations' health, continue a
pending receipt, and verify acceptance-gated archival exactly once. Record host
version and whether catalog refresh was needed. Mock tests cannot certify that
host-owned connections or cached skill catalogs refresh correctly.
