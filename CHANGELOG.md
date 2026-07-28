# Changelog

All notable user-facing changes to Nelos are recorded here. Versions follow the
[release and compatibility policy](docs/release-policy.md).

## Unreleased

### User-facing changes

- Added bounded four-state bundled MCP diagnostics to the doctor and
  distribution verifier.
- Added release and compatibility policy, community-health files, and
  repository contribution templates.
- Added a tag-only workflow that verifies release candidates on macOS and
  Linux, creates reproducible package artifacts with checksums and provenance,
  emits a CycloneDX SBOM, and opens a draft GitHub Release for maintainer
  review.

### Compatibility requirements

- Node.js 20 or newer on macOS or Linux.
- Exact supported Codex versions and exercised surfaces must be recorded before
  a release tag is created.

### Migrations

- None.

### Security fixes

- None.

### Known limitations

- Windows remains unsupported.
- Release drafts still require explicit maintainer review and publication.

<!--
Release automation should preserve the Unreleased section above and copy this
structure for each release:

## [VERSION] - YYYY-MM-DD

### User-facing changes

- None.

### Compatibility requirements

- Exact supported Codex versions and exercised surfaces.
- Supported operating systems and Node.js requirement.

### Migrations

- None.

### Security fixes

- None.

### Known limitations

- None.

Replace every "None" that applies; keep "None" when there is no entry.
-->
