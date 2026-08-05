# API baseline calibration tranche 1

This repository-only study packet is excluded from the Nelos plugin/npm
payload. Its public artifacts bind the immutable corpus 1.1.0/revision-2
successor to starter release 1.0.0 and requirement digest
`sha256:507f57cdbbefa44d90919d6cd552502cc1d1f7137f02e9f27bb0c301768e51e6`.

The ten approved concepts are two independent tasks in each required stratum:

- localized repair: `lr-duration-carry`, `lr-path-containment`
- cross-cutting feature: `cf-operation-provenance`, `cf-disk-ceiling`
- multi-module migration: `mm-checkpoint-v2`, `mm-cost-microusd`
- planning: `pl-capability-waves`, `pl-release-verification`
- orchestration restart: `or-ambiguous-effect`, `or-expired-lease`

Only sanitized projections are tracked. `artifacts/release-lock.json` contains
identities and digests; `artifacts/schedule.json` is the inert 20-trial,
5-AB/5-BA direct-Codex schedule; the other artifacts contain contamination,
105-pair independence, and validation summaries. No complete package, rubric,
oracle, grader implementation, or candidate envelope is committed.

## Private material workflow

Keep private material outside the repository and outside every package payload
root. The private root must be a real, non-symlink directory with this shape:

```text
<private-root>/
  private-manifest.json
  access-evidence.json
  semantic-pair-review.json
  packages/<64-hex-task-id>.json
```

`private-manifest.json` uses the public release-lock shape, binds each approved
concept to one task ID and package digest, and binds the exact digests of both
external evidence files. `access-evidence.json` records one real post-freeze
host access per private task. `semantic-pair-review.json` records the external
reviewer, review time, and disposition of every one of the 105 required task
pairs. The builder never manufactures either form of evidence. Complete package files may
contain grader-audience assets only in that external root. The builder rejects
repository overlap, symlinked roots/directories/files, undeclared package
files, identity mismatch, candidate/grader digest overlap, unbound or incomplete
access/review evidence, duplicates, and partition contamination.

Reproduce the committed public projections without provider or credential
access:

```sh
node experiments/api-baseline/calibration-tranche-1/build-release.mjs \
  --private-root /secure/nelos/calibration-tranche-1 \
  --check
```

To inspect a clean regenerated public directory, add `--out <directory>` and
compare it with `artifacts/`. Generated private material and study run outputs
are narrowly ignored if an operator accidentally stages them under this study
directory, but the builder still refuses to read private material there.

The schedule is non-executable and unauthorized. It preserves the current
confirmatory no-go, makes zero provider calls during construction/validation,
and requires fresh exact user authorization before any tranche call. No study
artifact authorizes confirmatory work, a Nelos arm, credential access, or a
provider call.
