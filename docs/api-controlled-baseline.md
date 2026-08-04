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
  --model-id model:gpt-5.6-sol \
  --model-revision gpt-5.6-sol \
  --reasoning-effort medium \
  --runtime-executable /immutable/runtime/bin/codex \
  --expected-runtime-digest sha256:0123456789012345678901234567890123456789012345678901234567890123 \
  --backend dedicated-desktop \
  --platform macos-arm64 \
  --pricing-snapshot /secure/operator/openai-pricing-2026-08-04.json
```

The create-only bundle seals four trials, two blocks, AB/BA order, concurrency
one, one attempt, 4,000 output tokens and 180 seconds per trial, zero candidate
network requests, one provider execution, at most eight sequential logical
Responses turns, zero transport retries, and maximum new estimated exposure of
USD 0.1875 per trial / USD 0.75 total. The controls reserve USD 0.25 for the
earlier calibration call, preserving the original USD 1.00 aggregate pilot
ceiling. Total output-token and wall ceilings are 16,000 tokens and 720 seconds.
Editing any value breaks the bundle digest and validation.

The pricing snapshot is prospective run input, not a lookup performed after the
results. It contains `schemaVersion`, `provider: "openai"`, an ISO `capturedAt`,
the official OpenAI `sourceUrl`, exact `modelId`, `currency: "USD"`, and the
standard-service short/long-context input, cached-input, cache-write, and output
USD rates per million tokens plus the 272,000-token threshold. Its digest is
bound into every runtime receipt. The proxy forces `service_tier` to `default`
and records cache-write tokens separately so historical cost estimates cannot
silently use Fast, Flex, or incomplete cache accounting.

There is no direct `--mode confirmatory` builder. Confirmatory trial counts are
fixed only after the offline power authorization described below.

## Credential and disposable-attempt boundary

Production reads only `/Users/bobby.sayers/src/nelos/.env.local`. Before reading,
it requires owner-only permissions, current-user ownership, and a successful
Git-ignore check. The value enters only the disposable Codex child environment
and its loopback receipt proxy; it is absent from argv, bundles, requested/observed route records, logs,
telemetry, reports, evidence, artifacts, and error text. Fresh home, Codex home,
XDG, temporary, and workspace directories are removed in `finally`.

Tests use an explicit dependency-injection seam with a generated synthetic key
and fake Codex process. Production's executable script does not expose a key
path or injected credential option, and the tests never read the real file.

## Receipt and replay requirements

The adapter does not treat requested route fields as observations. It starts an
ephemeral server bound only to `127.0.0.1`, configures a private Codex Responses
provider to use it, and admits at most eight sequential authenticated
`POST /v1/responses` logical turns per trial. The proxy checks the forwarded
model and reasoning effort before sending each request to OpenAI, rejects
concurrent or ninth requests, and clamps `max_output_tokens` to the remaining
per-trial output allowance. Codex provider and stream transport retries are both
disabled; multiple logical turns are not counted as retries.

A successful attempt requires a completed upstream response and a proxy-minted
receipt containing the provider-observed model, forwarded reasoning effort,
every OpenAI request and response ID, exact per-turn and aggregate token usage,
provider execution/logical-turn/retry counts, and the measured Codex executable
digest. Each completed exchange is first written to a create-only credential-free
ledger, so its usage and cost evidence survives a later aborted trial. The final
receipt is retained as canonical, content-addressed JSON. Estimated cost is
computed per exchange from exact usage and the dated OpenAI pricing snapshot
sealed into the bundle; its source, capture time, model, currency, and
per-million-token rates remain reproducible. Missing, duplicate, malformed,
mismatched, incomplete, or over-ceiling exchanges fail closed.

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

The host proxy forwards the provider response only after the completed exchange
has been validated and durably receipted, without logging request or response
bodies. It accepts the requested model name or a provider-returned
snapshot of that exact model family; any different observed model invalidates
the attempt. No receipt is issued for a non-2xx or incomplete response.

## Research packet

Every completed or caught-aborted run creates `research-packet/` beneath the
new run store. Its immutable manifest covers `protocol.json`, `run-summary.json`,
`trials.jsonl`, `provider-exchanges.jsonl`, `claim-ledger.json`, and short anomaly,
operator-note, decision, design-decision, and limitation documents. The structured files retain exact
source, distribution, route, runtime, task, grader, prompt/configuration digest,
schedule, seed, pricing, receipt, grading, usage, timing, failure, exclusion,
and evidence-health identities without copying hidden grader material or request
bodies.

The initial ledger contains one methodology-only instrumentation claim and one
explicitly untested comparative claim. A four-trial repeat-arm canary can make
the former preliminary when evidence is complete; it can never support or
promote the comparative claim. Operator templates ask for contemporaneous
incidents, deviations, alternative explanations, the post-result decision, and
prospective changes before the next phase.

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
