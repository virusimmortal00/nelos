# API-controlled repeat-arm baseline

This harness is a separate experiment phase from the signed-in product-default
pilot. It has distinct `run:api-baseline-*` IDs, store directories, evidence
roots, report kind, explicit model route, and runtime provenance. Both arms run
the same direct Codex API adapter with no Nelos candidate, plugins, developer
configuration, or inherited user configuration.

## Build and inspect a sealed bundle

Build either the 20-trial canary (two pairs in each of five strata) or the
100-trial confirmatory baseline (ten pairs in each stratum):

```sh
node scripts/build-api-baseline.mjs \
  --mode canary \
  --out /secure/operator/api-baseline-canary.json \
  --source-commit 0123456789012345678901234567890123456789 \
  --model-id model:gpt-5.6-sol-2026-07-15 \
  --model-revision 2026-07-15 \
  --reasoning-effort medium \
  --runtime-version codex-api-runtime-v1 \
  --runtime-digest sha256:0123456789012345678901234567890123456789012345678901234567890123
```

The builder writes with create-only semantics. The bundle seals the full
task/seed schedule, runner expansion digest, trial IDs, AB/BA order, ceilings,
route, runtime provenance, and power policy. Rebuild to a new path for the
confirmatory phase with `--mode confirmatory`; never edit a built bundle.

## Credential boundary

The only approved credential source is
`/Users/bobby.sayers/src/nelos/.env.local`, containing one
`OPENAI_API_KEY=...` declaration. Before reading it, the adapter requires a
regular file with no group/world permission bits and proves that Git ignores it.
The value is injected only into the Codex child environment. It is never placed
in the bundle, command arguments, adapter declaration, retained output,
telemetry, or error details.

Each attempt receives a newly created home, Codex home, XDG directories,
temporary directory, and workspace. Only generated sealed task inputs are
staged. The parent environment, repository files, `.git`, `.codex`, rules,
developer configuration, and repository secrets are not copied. The entire
attempt root and child environment disappear in the `finally` boundary.

Verify immediately before a run:

```sh
stat -f '%Sp %Lp %N' /Users/bobby.sayers/src/nelos/.env.local
git -C /Users/bobby.sayers/src/nelos check-ignore -v .env.local
```

## Execute without expansion

Use a new, nonexistent store directory and an API-only run ID:

```sh
node scripts/run-api-baseline.mjs \
  --bundle /secure/operator/api-baseline-canary.json \
  --store /secure/operator/api-baseline-canary-store \
  --run-id run:api-baseline-canary-001
```

The controller validates the bundle and follows only the sealed trial order. It
refuses a non-API run ID, an existing store, an added trial, a route mismatch,
candidate network access, more than one provider execution per trial, or any changed ceiling. Do not run the
API bundle with the signed-in pilot scripts or share its store/evidence/report
paths with that pilot.

## Power decision

The confirmatory policy predeclares strict pass rate as the primary endpoint,
candidate failure rate as a safety endpoint, absolute MDE 0.20, alpha 0.05,
target power 0.80, and task-level paired clustering. A decision is unavailable
until every critical stratum has at least ten complete AB pairs. Repeats are
clustered within task and never counted as independent tasks.

After reducing retained run records to the documented observation shape
(`stratum`, `blockId`, `candidateId`, and `trialId`), check that a decision is
permitted:

```sh
node scripts/decide-api-baseline.mjs \
  --bundle /secure/operator/api-baseline-confirmatory.json \
  --observations /secure/operator/api-baseline-observations.json
```

This gate reports readiness and the sealed endpoints; it rejects rather than
extrapolates when any critical stratum has fewer than ten complete pairs.
