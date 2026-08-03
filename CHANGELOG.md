# Changelog

All notable user-facing changes to Nelos are recorded here. Versions follow the
[release and compatibility policy](docs/release-policy.md).

## Unreleased

## [0.6.0] - 2026-08-03

### User-facing changes

- Added immutable governed experiment task packages and a reproducible starter
  corpus spanning ten task families with seven deterministic machine outcomes.
- Added host-isolated hidden grading, contamination controls, semantic corpus
  revision tooling, release locks, and public experimentation-corpus exports.
- Bound grader, task, package, and corpus identities to a recursive manifest of
  the complete shipped grader implementation and its local contract modules.

### Compatibility requirements

- Task packages now fail closed when their grader identity does not match the
  exact installed implementation. Regenerate packages after grader or local
  experimentation-contract module changes.

### Migrations

- Existing development corpus packages must be rebuilt with
  `npm run corpus:build` before grading under `0.6.0`.

### Security fixes

- Candidate-visible and hidden grader assets may not reuse the same digest,
  preventing hidden-oracle bytes from crossing audience boundaries.

### Known limitations

- The bundled corpus is an offline starter release; additional task families
  require the documented governed semantic-revision workflow.

## [0.5.3] - 2026-08-03

### User-facing changes

- Persisted web-backed joined subagents as durable work units so accepted
  review results can satisfy later spin-off dependencies after restart.
- Added an idempotent legacy reconciliation path: successful launch-batch
  verification adopts previously omitted joined members into the execution
  web, while later waves stop with the exact missing dependency IDs until the
  repair is completed.
- Made queen decisions validate the complete dependency graph before writing
  acceptance state, so an unknown dependency cannot partially advance a
  correction attempt.
- Allowed a completed spin-off cleanup call to consume the exact next-wave
  launch authorization receipt it requested.

### Compatibility requirements

- `nelos_launch_verify_batch` is now non-read-only and idempotent because a
  successful call may persist a verified joined-member binding.
- `nelos_spinoff_cleanup` accepts the optional, backward-compatible
  `launchAuthorization` receipt used by its next-wave execution gate.

### Migrations

- Existing webs stopped by `missing-persisted-dependency-work-units` should
  replay exact launch-batch verification for the named joined members. Nelos
  revalidates their native identity and adopts their binding without relaunch.

### Security fixes

- No security fixes.

### Known limitations

- No new known limitations.

## [0.5.2] - 2026-08-03

### User-facing changes

- Reduced state-lock contention overhead by memoizing the current process
  identity for the process lifetime and bounding repeated owner identity
  lookups while preserving stale-lock replacement revalidation.

### Compatibility requirements

- No compatibility changes.

### Migrations

- No migrations.

### Security fixes

- No security fixes.

### Known limitations

- No new known limitations.

## [0.5.1] - 2026-07-31

### User-facing changes

- Published the 0.5 milestone with a fresh plugin version and cache identity
  after correcting the authoritative Codex App Server source mapping from the
  retired `protocol/v2.rs` path to `protocol/v2/mod.rs`.
- Preserved all verified 0.5.0 candidate behavior while ensuring exact-source,
  generated-schema, and runtime-transport release evidence agree on the public
  compatibility contract. The `v0.5.0` candidate tag was never released.

### Migrations

- Upgrade existing `0.4.0` marketplace installs directly to `0.5.1`, restart
  Codex, and create a fresh task before verifying the loaded skill and MCP
  server.

## [0.5.0] - 2026-07-31

### User-facing changes

- Bumped the distributable plugin to `0.5.0` and added deterministic cache
  identity plus exact source-repository, source-revision, and payload-integrity
  provenance to installed copies and release artifacts.
- Added stale-payload validation, legacy-to-candidate upgrade coverage, and a
  source-distribution uninstaller that removes every Nelos-owned historical
  cache, skill, source, launcher, marketplace, and state location.
- Added a real isolated Codex Git-marketplace upgrade gate that installs the
  legacy payload, refreshes and installs `0.5.0`, restarts the app-server,
  creates a fresh task, and verifies candidate skill, MCP, cache, and provenance
  bytes while preserving unrelated data.

- Added a published-release promotion workflow for the
  `marketplace/stable` Codex marketplace channel, with immutable-release
  validation and fast-forward-only updates.
- Added conversational installed-plugin configuration through the bundled
  `nelos_config_get`, `nelos_config_set`, and `nelos_config_reset` MCP tools.
- Added `nelos_web_inspect`, a bounded read-only MCP workflow that combines
  persisted work-unit bindings, orchestration state, paged native task status,
  direct-parent topology, and content-free bridge health without exposing
  prompts, turns, transcripts, result text, or filesystem paths.
- Reduced the bundled skill to task-planning and coordination policy.
  Configuration and web inspection now route directly through MCP tool
  metadata and schemas.
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
- Added a deterministic execution gate for planned waves. Nelos now emits
  `launch-wave` only after the native host authorizes every exact launcher,
  task kind, workspace mode, model, reasoning route, and task creation.
- Authorization proposals now include a typed host effect backed by the
  `nelos_launch_authorize` receipt producer, preventing installed Desktop flows
  from stopping without a way to complete the authorized replay.
- Added an inline MCP Apps execution map for planning and dispatch receipts.
  It shows each task's lifecycle, exact model, reasoning level, and whether the
  task is planned, launch-pending, or created as an individual worker card.
- Extended the execution map to spin-off cleanup. Outstanding archive effects
  render as `archiving`; accepted native archive receipts produce a terminal
  update with worker identities, model, reasoning level, task ID, and a muted
  archived state. Aggregate counts remain in structured output without being
  duplicated in the visual.
- Refined execution-map semantics and spacing: attention now uses an amber
  review-needed treatment, while the redundant internal header and global phase
  pill are no longer rendered above worker statuses.
- Moved each worker status beside its title, shortened joined-worker lifecycle
  metadata to neutral `Sub-agent`, and added a reduced-motion-safe pulse for
  active work.
- Added an app-server-backed execution-map refresh receipt so a completed
  native turn produces a terminal visual update instead of leaving the latest
  visible worker at launch-pending.
- Published exact MCP output schemas for every protocol-producing tool,
  including the complete discriminated `nextAction` union, and made nonvisual
  protocol results available as model-visible `structuredContent`.
- Added pinned official MCP Inspector commands for interactive inspection and
  automated capability, app-binding, resource, valid-call, and invalid-input
  verification of the execution map.
- Added a deterministic nine-state visual fixture server and a pinned build of
  the official MCP Apps reference host, giving the component repeatable
  protocol, sandbox-readiness, and connected-browser test lanes.

### Compatibility requirements

- `NELOS_CONFIG` and `XDG_CONFIG_HOME`, when set, must be absolute paths.

### Migrations

- Upgrade existing `0.4.0` marketplace installs by refreshing the marketplace
  and reinstalling `0.5.0`, then restart Codex and create a fresh task. Source
  distribution users may rerun the unified installer; committed upgrades prune
  stale Nelos cache versions without touching other plugins.

- Existing exact-tag marketplace installs remain pinned. Users can opt into
  stable-channel upgrades by removing and re-adding `nelos-marketplace` with
  `--ref marketplace/stable`, then reinstalling the plugin.
- The first configuration read migrates an exact valid legacy remembered
  cleanup preference into TOML and removes the legacy file. Invalid or unsafe
  legacy state fails closed.
- Reset removes both the TOML override and any legacy preference, restoring the
  built-in `auto` default.
- Planning callers should start with `launchAuthorization: null`, then replay
  the unchanged request with the exact `native-launch-authorization` receipt
  returned by the host. Missing or partial evidence no longer permits fallback
  execution.

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
- The execution map renders only in MCP Apps-compatible hosts. Other clients
  continue to receive the complete text/JSON tool result.
- The map is a point-in-time receipt, not a broad live Desktop-state dashboard.

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
