# Changelog

All notable user-facing changes to Nelos are recorded here. Versions follow the
[release and compatibility policy](docs/release-policy.md).

## Unreleased

### User-facing changes

- Added a published-release promotion workflow for the
  `marketplace/stable` Codex marketplace channel, with immutable-release
  validation and fast-forward-only updates.
- Added conversational installed-plugin configuration through the bundled
  `nelos_config_get`, `nelos_config_set`, and `nelos_config_reset` MCP tools.
- Added a machine-local TOML configuration file at
  `$XDG_CONFIG_HOME/nelos/config.toml`, falling back to
  `~/.config/nelos/config.toml`. Repository-local `.nelos/` configuration is
  intentionally ignored.
- Changed the built-in spin-off cleanup policy from `ask` to `auto`. Users can
  globally choose `auto`, `ask`, or `keep`; changing or resetting that global
  preference requires an explicit user request.
- Cleanup now snapshots its effective policy for the whole web when terminal
  cleanup begins, so later global changes affect future webs without changing
  an archive or confirmation sequence already underway.

### Compatibility requirements

- `NELOS_CONFIG` and `XDG_CONFIG_HOME`, when set, must be absolute paths.

### Migrations

- Existing exact-tag marketplace installs remain pinned. Users can opt into
  stable-channel upgrades by removing and re-adding `nelos-marketplace` with
  `--ref marketplace/stable`, then reinstalling the plugin.
- The first configuration read migrates an exact valid legacy remembered
  cleanup preference into TOML and removes the legacy file. Invalid or unsafe
  legacy state fails closed.
- Reset removes both the TOML override and any legacy preference, restoring the
  built-in `auto` default.

### Security fixes

- Configuration now uses a pinned standards-compliant TOML parser, strict
  schema validation, bounded regular-file checks, private atomic writes, and a
  machine-local interprocess lock.
- Project-controlled configuration is not consulted for global cleanup
  behavior, preventing an opened repository from silently changing that
  machine-level preference.

### Known limitations

- Nelos does not yet provide a custom Codex Settings pane or MCP settings form.
  Conversation is the primary interface, with TOML available for manual edits;
  no Nelos-specific slash command is provided.

## [0.4.0] - 2026-07-28

### User-facing changes

- Added bounded four-state bundled MCP diagnostics to the doctor and
  distribution verifier.
- Added release and compatibility policy, community-health files, and
  repository contribution templates.
- Added a tag-only workflow that verifies release candidates on macOS and
  Linux, creates reproducible package artifacts with checksums and provenance,
  emits a CycloneDX SBOM, and opens a draft GitHub Release for maintainer
  review.
- Newer stable Codex versions are no longer rejected solely because they have
  not yet been tested. MCP health output distinguishes tested versions from
  provisionally compatible, untested versions.
- Added an ordered audit of 25 Codex capability families, including a bounded
  opt-in pilot contract for native Goals and explicit adoption decisions
  separate from implementation status.
- Added a versioned Codex App Server compatibility contract covering authority,
  profiles, transports, consumed schemas, notifications, privacy boundaries,
  retry behavior, and failure handling.

### Compatibility requirements

- Node.js 20 or newer on macOS or Linux.
- Codex `0.144.5` or newer. Codex `0.144.5` and `0.144.6` are the exact tested
  versions; newer stable versions may proceed provisionally and are reported as
  untested until their protocol surface is reviewed.
- Isolated `codex-cli` `0.144.5` and `0.144.6` release checks generated
  identical schemas for every App Server method Nelos consumes and exercised
  initialization, Unix-socket transport, task creation, two same-task turns,
  readback, archival, and cleanup. This CLI revalidation is additional to the
  recorded Codex Desktop `0.144.6` plugin/MCP dogfood smoke.

### Migrations

- Existing Fraktik installations must remove the `fraktik@fraktik` plugin and
  marketplace before installing `nelos@nelos-marketplace`; the renamed plugin
  identity is not migrated in place.
- Existing Nelos development-snapshot users should install the marketplace at
  Git ref `v0.4.0`, reinstall the plugin, restart Codex when requested, and open
  a fresh task.

### Security fixes

- None.

### Known limitations

- Windows remains unsupported.
- Codex versions newer than `0.144.6` are provisionally compatible but remain
  untested until their consumed App Server surface is reviewed.
- Native Goals integration remains an opt-in pilot proposal, not a default or
  a correctness dependency.

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
