# API-controlled repeat-arm baseline

This phase is separate from the signed-in product-default pilot. Its canary is
deliberately tiny: exactly four API trials, consisting of two identical direct
Codex repeat arms in two predetermined blocks. Block one is AB and block two is
BA. The builder includes one sealed starter task only; it cannot multiply the
canary across the five confirmatory strata.

## Build the four-trial canary

The runtime executable is measured from its real immutable bytes. An optional
expected digest is a comparison assertion, not provenance supplied by the
caller; a mismatch stops construction.

```sh
node scripts/build-api-baseline.mjs \
  --mode canary \
  --out /secure/operator/api-canary.json \
  --source-commit 0123456789012345678901234567890123456789 \
  --model-id model:gpt-5.6-sol-2026-07-15 \
  --model-revision 2026-07-15 \
  --reasoning-effort medium \
  --runtime-executable /immutable/runtime/bin/codex \
  --expected-runtime-digest sha256:0123456789012345678901234567890123456789012345678901234567890123 \
  --backend dedicated-desktop \
  --platform macos-arm64
```

The create-only bundle seals four trials, two blocks, AB/BA order, concurrency
one, one attempt, 4,000 tokens and 180 seconds per trial, zero candidate network
requests, one provider execution/request, zero provider retries, and maximum
estimated exposure of USD 0.25 per trial / USD 1.00 total. Total token and wall
ceilings are 16,000 tokens and 720 seconds. Editing any value breaks the bundle
digest and validation.

There is no direct `--mode confirmatory` builder. Confirmatory trial counts are
fixed only after the offline power authorization described below.

## Credential and disposable-attempt boundary

Production reads only `/Users/bobby.sayers/src/nelos/.env.local`. Before reading,
it requires owner-only permissions, current-user ownership, and a successful
Git-ignore check. The value enters only the disposable Codex child environment;
it is absent from argv, bundles, requested/observed route records, logs,
telemetry, reports, evidence, artifacts, and error text. Fresh home, Codex home,
XDG, temporary, and workspace directories are removed in `finally`.

Tests use an explicit dependency-injection seam with a generated synthetic key
and fake Codex process. Production's executable script does not expose a key
path or injected credential option, and the tests never read the real file.

## Receipt and replay requirements

The adapter does not treat requested route fields as observations. A successful
attempt requires exactly one independently parsed `api.runtime_receipt` event
containing the observed model ID, revision, reasoning effort, provider execution
count, retry count, request count, estimated cost, and executable byte digest.
Missing, duplicate, malformed, mismatched, or over-ceiling receipts fail closed.

Before credential loading, the adapter verifies the deterministic operation ID,
lease ID, unexpired lease, attempt number, controller owner, and fencing token.
It then claims the operation in a create-only ledger. Replaying the same
operation is rejected before another provider execution.

Run into a new store and API-canary run namespace only:

```sh
node scripts/run-api-baseline.mjs \
  --bundle /secure/operator/api-canary.json \
  --store /secure/operator/api-canary-store \
  --run-id run:api-baseline-canary-001
```

The current raw Codex command must emit the receipt contract above through an
admitted runtime wrapper/provider integration. If it cannot, the canary is
inconclusive and makes no confirmatory authorization claim.

## Offline confirmatory authorization

Power evidence is reduced at the paired task-cluster level. Repeated seeds or
blocks for one task are averaged within that task and count as one independent
sample. Applicable variance evidence may come from the signed-in repeat-arm
pilot and the four-trial API canary. The sealed policy uses paired strict-pass
risk difference, absolute MDE 0.20, alpha 0.05, target power 0.80, and a hard
floor of ten independent paired tasks in every critical stratum.

Evidence rows use normalized repeat-arm labels `a` and `b` (not phase-specific
candidate IDs) with `phase`, `stratum`, `taskId`, `blockId`, and binary `value`.

```sh
node scripts/decide-api-baseline.mjs \
  --bundle /secure/operator/api-canary.json \
  --observations /secure/operator/paired-task-variance-evidence.json
```

If any stratum lacks the larger of the power-derived count and ten independent
paired tasks, the result is `no-go`, `zeroFurtherCalls` is true, and no
confirmatory plan can be created. An authorized result seals exact independent
task IDs, AB/BA allocation, trial count, and exposure ceilings into a separate
confirmatory plan; it never reuses repeated seeds as independent clusters.
