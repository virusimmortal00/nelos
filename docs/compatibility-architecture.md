# Compatibility Architecture and Maintenance

This document is the maintainer contract for changing Nelos compatibility
claims. It explains who owns each declaration, which observations are evidence,
how pull-request impact selection works, and which artifacts must be reviewed
before a claim or supported version changes.

The executable source of truth is
[`src/compatibility-contract-registry.mjs`](../src/compatibility-contract-registry.mjs).
Documentation describes that registry; it does not independently grant support.
Collectors observe declared inputs and produce reports. They never edit the
registry, fixtures, supported-version lists, source, or documentation.

## Contract ownership and mappings

Each entry in `COMPATIBILITY_CONTRACT_REGISTRY_V1.capabilities` is one owned
compatibility contract:

- `id` is its stable machine identity and `title` is its review label.
- `dependsOn` forms the compatibility dependency graph. Selecting a contract
  also selects every transitive dependent because a changed dependency can
  invalidate its consumers.
- `globalInvariant: true` selects the contract for every pull request, including
  an empty diff. Use it only for repository-wide safety properties.
- `supportedCodexReleases` refers to exact entries in the registry-level
  supported release list. It is not a version-family wildcard.
- `mappings.owned` names paths for which the contract is the primary owner.
- `mappings.shared` names implementation or metadata shared with another
  contract.
- `mappings.test`, `documentation`, and `generatedSchema` name the corresponding
  checked-in repository surfaces.
- `mappings.upstreamDocumentation` contains bounded official HTTPS sources.
- `mappings.upstreamSource` contains a public repository, exact selectable
  paths or artifacts, and an optional floating advisory ref.
- `mappings.runtime` names exact transport or live-runtime surfaces.
- `mappings.checks` binds the capability to check declarations in
  `registry.checks`.

Every mapping key is required, even when its value is `[]`. Paths are normalized
repository-relative files or bounded `directory/**` scopes. Broad repository
scopes are rejected for public-source collection. Check IDs, capability IDs,
release IDs, dependency IDs, and selected evidence must all resolve inside the
same validated registry.

The current ownership split is:

| Capability | Primary ownership | Important consumers |
| --- | --- | --- |
| `app-server.protocol-shapes` | Reduced protocol contracts, generated-schema fixture, exact upstream protocol files | Strict bridge |
| `app-server.strict-bridge` | MCP App Server bridge and exact stdio/live transport behavior | Nelos lifecycle invariants |
| `nelos.experimentation-contracts` | Closed v1 Experiment, CorpusRelease, Task, and RuntimeLock schemas, fixtures, public exports, and architecture documentation | Experimentation runners, graders, and analysis planned in later milestones |
| `nelos.lifecycle-invariants` | Fail-closed compatibility gate, registry consistency, reports, advisory isolation, and orchestration safety | All pull requests and releases |

## Global invariants and fail-closed impact selection

`selectImpactedCompatibilityContractsV1` evaluates added, modified, deleted,
and renamed files. Both the old and new path of a rename are considered. It:

1. selects every global invariant;
2. selects contracts whose repository mappings match a changed path;
3. traverses all transitive dependents in registry order; and
4. records every path-to-contract decision in `pathSelections`.

A compatibility-sensitive path under `src/`, `bin/`, `scripts/`, `test/`, or
`docs/`, or one of the declared repository metadata files, fails closed when it
has no mapping. The selector returns `ok: false`, lists the path in
`unmappedSensitivePaths`, and requires the contributor to map it or make a
separate, reviewed selector exclusion. Deletions and renames therefore cannot
silently escape an obsolete mapping.

The required offline gate runs only deterministic repository and generated
schema checks. A deterministic mismatch exits `1`. Missing runners, malformed
registries or reports, Git failures, timeouts, and other infrastructure faults
exit `2` and remain non-evidence. An infrastructure failure must never create a
positive compatibility claim.

## Evidence hierarchy

Evidence kinds answer different questions and are not interchangeable:

| Kind | Authority and use | Cannot establish |
| --- | --- | --- |
| `deterministic-repo` | Checked-in invariants, claims, mappings, tests, and version consistency; required offline | Any fact not represented in the repository |
| `upstream-docs` | Bounded selection from explicitly official documentation, with URL, selection, digest, time, and availability metadata | Runtime presence, entitlement, or rollout |
| `upstream-open-source` | Exact declared tag or commit, verified commit SHA, bounded files, and content digests | Desktop, cloud, entitlement, rollout, or closed-host behavior |
| `generated-schema` | Generated or checked-in schema tied to an exact runtime identity | Runtime behavior beyond the generated shape |
| `runtime-transport` | Exact runtime identity over a declared transport with bounded read-only probes | Unprobed product or hosted behavior |
| `runtime-live` | Explicitly enabled trusted live probe against an exact runtime identity | General availability outside the probed host and account |
| `semantic-advisory` | Explicit, bounded comparison by an injected semantic provider; findings are review hints | Any deterministic compatibility status |

Within wire compatibility, generated schema, exact runtime transport, and an
explicit live probe are decisive for the exact surface they test. Exact-ref
public source can corroborate the implementation behind a supported release,
but it remains public-source-only and cannot substitute for generated or
runtime evidence about closed surfaces.

Floating `refs/heads/main` observations and uncorroborated source drift are
early-warning only. They always have `countsForCompatibility: false`. Public
open source cannot establish Codex Desktop, cloud, entitlement, rollout, or
closed-host behavior. Documentation or source collection failure is
unavailable/non-evidence, never a pass. Semantic findings are always
`advisory-only`, even when they disagree with a deterministic report.

## Report fields and status derivation

The normalized compatibility report has:

- `schemaVersion` and the exact `registryVersion`;
- `overallStatus`: `compatible`, `incompatible`, or `unverified`;
- one entry per selected `capabilityId`, in stable registry order;
- capability `status`; and
- mapped `evidence` entries with `checkId`, `kind`, `outcome`,
  `countsForCompatibility`, `source`, and `summary`.

Official documentation evidence additionally carries
`upstreamDocumentation`: requested URL, selected artifact or section, digest,
observation time, availability status, evidence kind, and failure kind.
Collector-specific reports add exact identity, provenance, operation digests,
limitations, and failure classification without weakening this normalized
shape.

Only `outcome: passed` is positive evidence in the normalized report. A mapped
`failed` result makes the capability incompatible. If no result failed but any
mapped check is unavailable or infrastructure-failed, the capability is
unverified. It is compatible only when every mapped check passed.
`overallStatus` is incompatible if any selected capability is incompatible,
compatible if every selected capability is compatible, and otherwise
unverified.

Semantic output is a separate report section with
`authority: advisory-only` and `countsForCompatibility: false`. It freezes and
repeats the deterministic status supplied to it; provider warnings cannot
promote, demote, or replace that status.

## Safe capability maintenance

Treat registry and claim changes as reviewed migrations, not collector output.

### Add a capability

1. Choose a stable ID and declare every mapping key.
2. Assign narrow owned/shared/test/documentation/schema paths.
3. Declare dependencies and decide explicitly whether it is a global invariant.
4. Add or reuse typed checks for every evidence lane the capability requires.
5. Add offline fixtures and end-to-end selection/report coverage.
6. Run the required gate and review `pathSelections`,
   `selectedCapabilityIds`, and all new evidence records.

### Rename a capability

Capability IDs are persisted report and review identities. Prefer retaining the
ID and changing only `title`. If an ID must change, update dependencies,
selected-evidence fixtures, report fixtures, scripts, workflow artifact
consumers, and documentation in one deliberate migration. Add a release-note
migration and test that old report inputs fail clearly. Do not leave aliases
that make ownership ambiguous.

### Deprecate a capability

Keep the capability and its checks active during the documented deprecation
window. Mark the replacement and migration in documentation and release notes,
move consumers through explicit dependency/mapping changes, and keep fixtures
for every still-supported release. Collectors must not remove deprecated
claims automatically.

### Delete a capability

Delete only after its consumers and supported release obligations are gone.
Remove or reassign every owned/shared path, dependency, check, fixture, workflow
artifact, report fixture, and documentation reference in the same pull request.
Run impact selection over both the deletion and replacement paths. Any newly
unmapped sensitive path blocks the change.

### Change supported Codex versions or claims

Never update a supported version because a floating branch or semantic finding
looks compatible. For each exact version:

1. review the official documentation scope;
2. resolve the declared release tag or commit to its exact SHA;
3. generate and review the schema from an executable whose exact version
   matches the claim;
4. run exact transport probes and any explicitly claimed trusted-live smoke;
5. update the registry release entry, reduced fixture identity, bridge
   `TESTED_CODEX_APP_SERVER_VERSIONS`/minimum where applicable, README,
   compatibility contract, and release notes together;
6. run the offline gate and release evidence verifier; and
7. review the report identities, digests, failure fields, and limitations
   before merging.

Changing a claim, fixture, or supported-version list is always a deliberate
human-reviewed pull request. Scheduled, live, and semantic collectors only
produce artifacts for that review.

## Migration from legacy checks

Existing checks retain familiar commands, but ownership and invocation now
flow through the registry:

| Previous direct check | New owner and required path |
| --- | --- |
| `npm run check:model-catalog` and its two tests | `nelos.lifecycle-invariants` → `repo.model-catalog-invariants`; invoked by `npm run compatibility:required` when selected or as the direct diagnostic command |
| `npm run verify:app-server` / bridge unit test | `app-server.strict-bridge` owns transport behavior and `nelos.lifecycle-invariants` owns `repo.app-server-invariants`; PRs use the offline bridge invariant, scheduled/release lanes use the exact runtime transport collector |
| `npm run verify:app-server:live` | `runtime.live-app-server`; manual trusted-live advisory boundary only |
| Manual schema comparison | `app-server.protocol-shapes` → `schema.app-server-v0144x`; checked-in reduced fixture in PRs, exact executable generation in scheduled/release verification |

Maintainers updating model claims must review catalog provenance, official
documentation selection, freshness policy, fixtures, and supported versions
separately. Maintainers updating App Server claims must review exact source ref,
generated schema, transport identity, reduced fixture, bridge validators, and
the compatibility contract. No single successful lane authorizes all of those
changes.

## Execution boundaries and review artifacts

| Boundary | Allowed work | Required maintainer review |
| --- | --- | --- |
| Pull request | Offline deterministic repository/schema checks; no internet, real Codex, credentials, live mutations, or semantic provider | Selection, unmapped paths, normalized report, tests, claim/fixture diff |
| Scheduled/manual drift | Official docs, floating-main early warning, exact-release source, schema, and exact transport collection; failures preserved | Digests, resolved refs, exact identities, unavailable reasons, drift over time |
| Release | Required offline gate plus exact release source, generated schema, runtime transport, and coherent release bundle | Same-version source SHA/schema/runtime bundle, fixtures, supported-version list, release notes |
| Trusted live | Explicit manual opt-in in the protected compatibility environment; bounded live probes only | Host/account/runtime identity, operations performed, costs or mutations, limitations |
| Semantic | Explicit manual opt-in, injected credentials/provider, bounded preselected evidence, advisory-only | Selected evidence digests, provider/model, findings, deterministic status preserved |

Contributors should run `npm run compatibility` and the targeted unit tests
before opening a pull request. Release maintainers should retain the normalized
gate report, documentation/source drift artifacts, exact generated-schema and
transport reports, semantic report when requested, and the verified release
evidence bundle. Collector output is review input; checked-in claims change only
through the pull request that deliberately edits them.
