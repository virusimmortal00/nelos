# Release and Compatibility Policy

This policy defines the public release contract for Nelos. Release automation
may enforce it, but automation does not replace the verification and provenance
requirements below.

## Versioning

Nelos versions follow [Semantic Versioning 2.0.0](https://semver.org/):

- `MAJOR.MINOR.PATCH` identifies a stable release. After `1.0.0`, incompatible
  public contract changes require a major version, compatible features require
  a minor version, and compatible fixes require a patch version.
- Before `1.0.0`, a minor version may contain incompatible public contract
  changes. Patch releases remain backward compatible within their `0.MINOR`
  line.
- Public contracts include the plugin manifest and installation shape, MCP tool
  names and schemas, CLI commands and machine-readable output, persisted state
  that must survive an upgrade, and the documented task-management workflow.
- Deprecations in a stable release are announced in the changelog, include a
  replacement or migration, and remain available through at least the next
  supported minor release line. A security issue or an upstream host change
  that makes the old behavior unsafe or impossible may shorten that window; the
  release notes must explain the exception.

The repository may use build metadata such as
`0.4.0+codex.20260728022005` to bind a verified distribution revision to a
particular build. SemVer ignores build metadata for precedence, but Nelos does
not treat two different build-metadata versions as interchangeable artifacts:
each version string identifies exactly one immutable distribution and
provenance record. A rebuild with different content receives a new version.

## Development and release boundaries

Merging development work is not the same operation as cutting or publishing an
installable plugin release. Evaluation observations and evidence, fixtures,
tests, documentation, and ordinary fix commits do not independently require a
plugin version bump. They may merge while the repository continues to carry the
most recently selected release identity.

A bump is required only at one of these narrow boundaries:

- maintainers intentionally cut or publish an installable plugin release; or
- an externally consumed, versioned contract changes and repository policy for
  that contract requires immediate publication rather than allowing the change
  to remain unreleased.

Other changes accumulate under **Unreleased** until maintainers choose a release
boundary. At that boundary they select one SemVer increment for the coherent
set of changes, update every version and provenance surface together, and run
the release gate. Individual development commits do not each receive a patch
version merely because they may eventually be included in that release.

The distribution integrity checksum may be refreshed during unreleased
development so repository and local-install validation describe the current
tree. That checksum refresh does not cut a release, authorize publication, or
make the retained version identify a second published artifact. An intentional
release still receives one coherent version and immutable provenance at the
boundary.

Version `0.12.14` is the already-selected coherent provenance bump for the
routing-evaluation release boundary. Subsequent observations, fixtures, tests,
documentation, and ordinary fixes in this evaluation wave retain `0.12.14`;
they do not force `0.12.15`. If maintainers later decide to publish those added
bytes, the next intentional release boundary selects and validates its own one
coherent version.

## Release lines and support

A release line is `MAJOR.MINOR` (including `0.MINOR` before `1.0.0`).

| Line or channel | Intended use | Support and deprecation expectation |
| --- | --- | --- |
| Current stable line | Normal installation | Receives compatible fixes and security fixes. Deprecations follow the stable window above. |
| Previous stable line | Short upgrade window | Receives fixes only for critical security issues or severe regressions for 90 days after the next stable line is released. It is then end-of-life unless a release note explicitly extends support. |
| Older stable lines | Historical use | Unsupported. Users must upgrade before requesting a fix. |
| `alpha` prereleases | Early design and schema testing | No compatibility or support guarantee. Contracts and persisted state may change or be reset between builds. |
| `beta` prereleases | Feature-complete integration testing | Best-effort fixes for release blockers. Compatibility is intended to stabilize, but changes may still require migration. |
| `rc` prereleases | Candidate validation | Only release-blocking fixes are expected. A changed candidate receives a new prerelease number and is verified again. |
| Untagged development snapshots | Maintainer testing | Unsupported and not public releases, even if `package.json` contains a valid version. |

Prerelease versions use SemVer identifiers such as `1.2.0-alpha.1`,
`1.2.0-beta.2`, and `1.2.0-rc.1`. Identifiers advance monotonically within a
target stable version. A prerelease does not extend the support life of an older
stable line. Deprecation windows do not apply between prereleases, but every
breaking change after the first beta must be called out under **Migrations**.

## Codex compatibility

Compatibility is an evidence claim about an exact Codex runtime and an exact
Nelos surface, not a promise about all releases in a Codex version family.

The checked-in app-server protocol fixture
[`test/fixtures/mcp-app-server-protocol-v0.144.x.json`](../test/fixtures/mcp-app-server-protocol-v0.144.x.json)
is the machine-readable compatibility metadata for the bridge. Its
`testedCodexVersions` list contains only exact versions whose relevant
experimental schema shapes were compared, and its `source` records how the
fixture was obtained. Permission evidence is recorded separately in the
versioned fixtures under `test/fixtures/`. The plugin manifest declares the MCP
entry point, but it does not invent a host-version range that the Codex plugin
schema cannot verify.

A Codex version is marked as tested only after maintainers:

1. generate and review the experimental app-server schema;
2. compare every method and field Nelos uses with the checked-in fixture;
3. run the bridge compatibility and MCP tests, including the minimum-version
   and response-schema guards; and
4. perform the applicable fresh-task plugin/MCP smoke check on that exact host.

The registry ownership, evidence hierarchy, fail-closed selection rules, and
safe add/rename/deprecate/delete procedures are defined in
[Compatibility Architecture and Maintenance](compatibility-architecture.md).
Scheduled floating-main and uncorroborated source drift are early-warning only,
and public source cannot establish Desktop, cloud, entitlement, rollout, or
closed-host behavior. Collectors produce review artifacts; they never update
claims, fixtures, or supported-version lists.

The bridge enforces the oldest protocol version it can safely use, currently
Codex `0.144.5`, rather than treating the tested-version list as an exhaustive
allowlist. A stable Codex version at or above that minimum may proceed when it
has not yet been tested; health output identifies it as compatible but
untested. Versions below the minimum and malformed, prerelease, or custom
runtime identities fail during startup. Strict validation remains in place for
every app-server response Nelos consumes, so an actual protocol incompatibility
fails at the affected operation instead of being silently accepted.

The compatibility result is communicated in the release's **Compatibility
requirements** notes, including exact tested Codex versions, operating systems,
Node.js requirements, and which surfaces were exercised. A passing schema gate
supports only the reviewed protocol operations. It does not claim that Codex
provides native event replay, atomic title compare-and-set, result provenance,
model availability, plugin-root substitution, or any other behavior that was
not observed. Untested newer stable versions are provisional compatibility
claims, not evidence that their complete host surface has been verified. See
[MCP tool surface](mcp-tool-surface.md#experimental-protocol-compatibility) for
the current evidence and limitations.

## Release coherence and provenance

Every release must have one coherent version and one coherent artifact set:

1. `package.json` `version` and both root `package-lock.json` version fields;
2. `.codex-plugin/plugin.json` `version`;
3. the generated `.mcp.json` `NELOS_PLUGIN_VERSION`;
4. the Agent Plugins v1 `plugin.json` `version`;
5. the generated Agent Plugins v1 `mcp.json` `NELOS_PLUGIN_VERSION`; and
6. `distribution-provenance.json` `revision`

must be exactly equal. Both MCP configurations and the Agent Plugins manifest
are generated from the legacy plugin manifest and must have no checked-in diff
after generation. The distribution provenance digest must match the complete
declared distribution surface, and the skill digest must match the bundled
skill. The tag, source archive, marketplace plugin, optional CLI distribution,
and changelog entry must all refer to that same version and commit.

No released version may be rebuilt, repointed, or have its provenance record
reused for different bytes. A correction requires a new patch or prerelease
version. The verifier and installation trust model are documented in
[Installation and Distribution Trust](installation.md#distribution-provenance-and-the-verifier).

Repository validation applies this coherence check even while development work
retains the current version. A partial or inconsistent intentional bump fails:
changing the legacy manifest alone, for example, is rejected when the Agent
Plugins marketplace manifest, package metadata and lockfile, MCP identities, or
distribution provenance still carry the prior version.

## Release gate and tags

The first public Nelos release will be cut from the next commit that completes
the full release gate. Historical repository states and existing development
version strings are not public releases. Maintainers must not create
retroactive tags for those unverified states.

For every public release, maintainers:

1. finalize the changelog and compatibility evidence;
2. set the same version on all six coherent surfaces and regenerate both plugin
   layouts;
3. refresh distribution and skill provenance after all distributed content is
   final;
4. run the repository syntax checks and complete tests on macOS and Linux,
   package and inspect the release contents, run distribution verification,
   and complete the exact-host compatibility smoke checks claimed by the
   release notes;
5. create the next annotated `v<VERSION>` tag only on that fully verified
   commit; and
6. publish only artifacts produced from that immutable tag.

The compatibility portion of that review retains the required offline report,
exact release-ref observation, generated-schema report, exact runtime-transport
report, and verified release evidence bundle. Trusted-live and semantic runs
remain explicit, protected, optional lanes, and their artifacts cannot replace
or override the deterministic release result.

A failed or incomplete gate produces no release tag. Public tags are immutable:
they are never moved to another commit, deleted and recreated, or added later
to make an unverified historical state appear released.

Pushing the annotated version tag runs `.github/workflows/release.yml`. The
workflow validates that the tag, checked-out commit, package metadata, plugin
manifest, generated MCP configuration, lockfile, changelog, and distribution
provenance are one coherent candidate. It then repeats the macOS/Linux test
gate, golden loop, and clean-install verification before building the package
twice. Only byte-identical package outputs advance. The resulting package,
SHA-256 checksums, provenance record, release manifest, release notes, and
CycloneDX SBOM are attached to a **draft** GitHub Release. A maintainer must
review and explicitly publish that draft; workflow success alone does not make
it a public release.

## Stable marketplace promotion

Publishing a stable GitHub Release triggers
`.github/workflows/promote-marketplace.yml`. The workflow treats the movable
`marketplace/stable` branch as a distribution channel, not as release
provenance. It promotes only the commit behind an existing annotated
`vMAJOR.MINOR.PATCH` tag whose GitHub Release is published, non-draft, and not a
prerelease.

Before promotion, the workflow reruns the immutable release validation from the
tag and independently checks the package, plugin, MCP, provenance, lockfile,
and marketplace identities. It then requires the existing stable branch, when
present, to be an ancestor of the candidate release. Promotion is therefore
idempotent and fast-forward-only; it never force-pushes or moves the channel
backward. A failed validation or push leaves the prior stable channel
unchanged.

Maintainers can manually dispatch the same workflow with an existing published
stable tag to recover from an interrupted GitHub event. This recovery path
applies the same checks. It does not permit promoting a draft, prerelease,
untagged commit, divergent history, or rebuilt release.

Users who configure the marketplace at `marketplace/stable` can refresh it
without changing repository coordinates. Exact immutable release tags remain
the authoritative pin and rollback mechanism; rollback never moves the shared
stable channel.

## Release notes

[`CHANGELOG.md`](../CHANGELOG.md) is the canonical user-facing release history.
Every release moves applicable entries from **Unreleased** into a versioned
section with the release date and retains these headings:

- **User-facing changes**
- **Compatibility requirements**
- **Migrations**
- **Security fixes**
- **Known limitations**

Use `None` when a section has no entry so absence is explicit. Security entries
must avoid exploit details before coordinated disclosure. Known limitations
must distinguish a Nelos limitation from unverified or absent Codex host
behavior.
