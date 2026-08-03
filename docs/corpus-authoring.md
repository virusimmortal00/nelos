# Governed Corpus Authoring and Release

The `nelos/experimentation-corpus` entry point implements immutable task
packages, the starter development corpus, deterministic host grading, and
development/private-set contamination controls. It builds on the closed v1
`Task` and `CorpusRelease` contracts; it does not run candidates or replace the
future experiment runner.

## Author a task

1. Start from one declared task family in `STARTER_TASK_FAMILIES`, or add a new
   category and predeclare its corpus weight.
2. Store fixture, baseline, input, output-shape, and artifact-shape bytes as
   candidate assets. Store the rubric and oracle as `grader` assets. Every byte
   receives a SHA-256 digest.
3. Build and seal a v1 `Task`. Its semantic identity binds the exact prompt,
   fixture, baseline, inputs, deterministic seed and clock, permissions, tools,
   network policy, environment, limits, output and artifact contracts, grader,
   rubric, oracle, visibility, and partial-credit policy.
4. Move the reviewed task to `sealed`, then call `createTaskPackage`. Package
   and grading admission reject draft, reviewed, retired, and invalidated tasks.
   Validation also requires every referenced asset, a host-only grader bundle,
   and grader-only rubric and oracle bytes.
5. Review the candidate envelope. It must contain only candidate assets. Oracle,
   rubric, and grader implementation bytes never enter the candidate workspace.

Do not edit a released task in place. Use `reviseTask`; a semantic change creates
a successor revision, predecessor digest, new task identity, and new package
identity. This includes changes to inputs, permission, limit, fixture, output
shape, grader, rubric, or oracle. The containing corpus must then receive a
higher semantic version and revision. `reviseCorpusFromPackages` creates that
lineage only when `previousDigest` names the exact active predecessor and
`specRevision` advances once. It rejects jumps, forks, unmatched predecessors,
and predecessors retained beside their replacements, then retains the old task
as an audited exclusion.

## Grade a task

`gradeTaskAttempt` accepts candidate output plus a trusted host observation and
a boundary attestation. Candidate and grader environment identities must differ.
The grader uses host-observed termination, timeout, and contamination state; it
does not pass `selfReport` to grader code. Candidate timeout, crash, malformed
output, and contamination fail closed. A grader exception produces the separate
`grader-failure` infrastructure outcome and never a candidate pass or failure.

The same package, output, observation, and grader bundle produce identical
canonical grade bytes. Golden fixtures cover success, failure, partial, timeout,
malformed, contaminated, and grader-failure outcomes.

The starter grader implementation identity is the digest of a canonical,
path-sorted manifest covering every shipped `.mjs` file in both
`src/experimentation-corpus` and `src/experimentation-contract`. This
conservatively overbinds some modules so a transitive helper, validation,
canonicalization, or host-outcome change cannot retain the old grader identity.
Node and its built-in modules are bound separately by `RuntimeLock`. Grading
fails closed when a task package names a grader bundle other than the exact
implementation installed in the host runtime.

Human judgment is an explicit boundary. Subjective tasks are not accepted by
the machine-grader registry. A future blinded-grading adapter must bind a
separately versioned rubric, hide candidate identity and treatment, retain at
least two independent ratings, report agreement, and record adjudication. Its
scores remain a separate subjective stratum.

## Development and private evaluation sets

Development task packages may be committed. Private task packages and oracle
bytes must remain in access-controlled evaluation storage and must not be added
to this repository or a development build artifact.

Before an experiment is frozen, run `validateEvaluationPartitions` with the
complete development/private membership, immutable access log, predeclared
exclusions, freeze time, and similarity threshold. It rejects:

- any task identity present in both partitions;
- author access to a private task before freeze;
- an unlogged or malformed access record;
- a cross-partition near duplicate without a pre-freeze contamination
  exclusion.

The resulting contamination report binds membership, access-log, exclusion,
and similarity evidence digests. Hosted-model pretraining contamination cannot
be proven absent; report it as a limitation and rotate private challenge tasks.

## Build and publish a release

Run `npm run corpus:validate` to reproduce the committed release lock. Run
`npm run corpus:build -- --out <empty-output-directory>` to materialize canonical
release and package JSON. The build uses no machine time, absolute paths,
randomness, or network input, so clean machines reproduce the same identities.

For a semantic change:

1. revise the task and its package;
2. increment the `CorpusRelease` semantic version and revision;
3. record task additions, replacements, and exclusions in the changelog;
4. let `reviseCorpusFromPackages` deterministically recompute exact-prompt and
   near-token duplicate groups for the complete active membership, then
   regenerate cross-partition contamination evidence;
5. review, seal, and publish through the contract lifecycle;
6. update `corpus/starter/release-lock.json` only after reviewing the diff;
7. run `npm run corpus:validate`, the corpus tests, and `npm test`.

Never overwrite a published release or reuse its version for changed bytes.
The exact comparison helper fails closed when membership would exceed its
bounded five-million-pair analysis budget; shard curator analysis into a new
reviewed workflow rather than retaining stale evidence.
