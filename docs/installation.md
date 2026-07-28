# Installation and Distribution Trust

This document records the complete trust, recovery, and verification model for
Nelos's transactional installer, the read-only `nelos doctor`
diagnostic, and the distribution verifier. For the normal Codex installation —
the marketplace plugin plus its bundled MCP tool surface
([docs/mcp-tool-surface.md](mcp-tool-surface.md)) — see
[Install in Codex](../README.md#install-in-codex); this document covers the
maintainer-oriented source distribution path, which installs the optional
`nelos` CLI that the installed plugin no longer depends on.

## Bundled MCP server states

Both `nelos doctor` and `nelos-verify-distribution` inspect the installed
plugin's bundled `nelos` server and `CODEX_HOME/config.toml` without modifying
either file. Inspection is limited to canonical regular files no larger than
1 MiB, and diagnostics never echo configuration, environment values, or raw
malformed input.

| State | Meaning | Single recovery action |
| --- | --- | --- |
| `missing` | The installed plugin has no `.mcp.json` or no `nelos` declaration. | Run `codex plugin add <installed-selector>` to reinstall the bundled server. |
| `disabled` | The declaration is compatible but the exact installed selector and server are not enabled. | Add the exact block emitted by the diagnostic to `CODEX_HOME/config.toml`. |
| `incompatible` | Server metadata or the target enablement setting is malformed, unsafe, oversized, or does not match the installed revision. | Run `codex plugin add <installed-selector>` to reinstall the bundled server. |
| `healthy` | The installed declaration is compatible and its exact selector/server block has `enabled = true`. | None. |

For example, an installed `nelos@personal` plugin emits only:

```toml
[plugins."nelos@personal".mcp_servers."nelos"]
enabled = true
```

## The unified installer

The unified installer copies one immutable release under `CODEX_HOME` and
updates the CLI launchers, user-wide task-management skill,
configured `nelos@personal` plugin source, and Codex plugin cache
from that release. It uses a lock, transaction journal, and backups so an
interrupted install is recovered on the next run and a failed install restores
the previous surfaces. Its lock combines process identity with a heartbeat so
PID reuse and platforms without Linux `/proc` metadata cannot strand the
installation permanently. When the host exposes no strong process-start
identity, the 30-second heartbeat lease is the conservative fallback. Existing
managed private directories are normalized to mode `0700`; the launcher
directory is normalized to `0755`. The personal plugin is resolved from one
absolute local marketplace path. On a clean home, the same command safely
creates the exact personal marketplace entry and managed plugin source;
rerunning it is idempotent. Existing foreign marketplace content is never
merged or replaced.

## Release artifacts, upgrades, and rollback

Every tagged release candidate produces a draft GitHub Release containing the
npm package tarball, `distribution-provenance.json`, a CycloneDX SBOM,
`release-manifest.json`, and `SHA256SUMS`. The workflow builds the package
twice and requires identical SHA-256 digests before uploading either copy.
Drafts are not supported releases until a maintainer reviews and publishes
them.

Before installing a published source distribution, download all release assets
from the same immutable tag and verify them from the download directory:

```bash
sha256sum --check SHA256SUMS
```

On macOS, use `shasum -a 256 -c SHA256SUMS`. Confirm that the manifest's tag,
version, source commit, and distribution integrity agree with the release page.
Extract the npm tarball and run the unified installer from its `package/`
directory. Do not combine a package, checksum file, provenance record, or SBOM
from different releases.

To upgrade, repeat those checks for the newer published release, run its unified
installer, run `nelos-verify-distribution`, restart Codex when requested, and
validate the skill from a fresh task. Read the release's **Compatibility
requirements** and **Migrations** sections before upgrading.

To roll back, use a previously downloaded and verified release that remains in
a supported line. Review migrations first because a release may change
persisted contracts that an older version cannot read. Run that release's
unified installer and verifier, then restart Codex and use a fresh task. Never
move a tag or substitute rebuilt bytes to simulate a rollback.

Support follows [SUPPORT.md](../SUPPORT.md) and the support windows in the
[release policy](release-policy.md#release-lines-and-support). Security reports
must continue through the private route in [SECURITY.md](../SECURITY.md).

## Foreign files and forced installs

Unknown executables that shadow the managed bin directory are never replaced.
Existing foreign files at the managed launcher or skill destinations also stop
the install; inspect them before explicitly using
`npm run install:distribution -- --force`. The force option does not override
an earlier PATH shadow. The installer owns
`~/plugins/nelos` by default and refuses to replace another local
plugin source or a Git checkout. To deliberately adopt a different configured
source, pass its exact path with `--plugin-source PATH`.
An explicitly opted-in Git checkout is fingerprinted in full, including its
`.git` metadata and hooks, across staging, activation, and rollback.

## Execution trust boundaries

The Codex CLI and managed launchers are execution trust boundaries. Installation
filters relative and empty `PATH` components from its private environment and
reports when it does so, so current-directory content cannot enter command
discovery or final verification. Only absolute entries are used. Use
`--codex PATH` to select a specific trusted Codex executable. Fix the shell's
original `PATH` separately before running the doctor or verifier, which continue
to report unsafe host `PATH` entries.

## Transactional path ownership

For transactional path ownership, the installer requires `HOME`, `CODEX_HOME`,
the install root, managed bin directory, skill root, and plugin-cache root to
have no symlinked path components. It validates existing parents before it
creates anything, so a rejected path cannot redirect creation outside the
declared roots. Use canonical paths for custom or isolated installations.

## Host refresh ordering

When the app-server control socket is reachable, the installer also
uses the app-server's plugin install API and checks that the running process
sees the expected local plugin version. The immutable
on-disk transaction commits before this host refresh. That ordering is
intentional: if a side-effecting app-server request times out and completes
late, it can only reinstall the already committed release instead of racing a
rollback. If a host refresh corrupts the committed plugin cache, the installer
records the post-commit repair state before invoking Codex; an interrupted or
failed repair is visible to the verifier and a subsequent install repairs it.
If no app-server is running, installation still succeeds safely but
reports `restart-required`; start or restart Codex before creating a fresh
task. `--socket PATH` and `--marketplace PATH` select non-default app-server and
local-marketplace locations.

## The read-only doctor

`nelos doctor` is a strictly read-only JSON diagnostic. It fails closed
when PATH cannot select one trusted canonical Codex executable and reports
distribution coherence, personal-marketplace bootstrap state, host endpoint
availability, and exact restart/fresh-task actions. It never executes a PATH
candidate or prints environment values, endpoint credentials, prompts, or
transcripts. Host endpoint injection remains proposed; current source use needs
a compatible Codex CLI and a reachable app server or developer launcher.

## Skill discovery and fresh tasks

Codex discovers plugin skills when a task starts. Restart Codex and start a
fresh task after installation before validating agent-visible behavior. A
`registry-refreshed` result confirms the running host's plugin metadata, but a
fresh-task smoke test remains the authoritative check for the task-management
skill. A running Desktop session can retain a stale skill locator after an
initial install as well as after an upgrade. If a fresh task says that its
advertised skill path is unavailable—or points one directory above the
versioned installed bundle—restart Codex once and retry in a fresh task. Do
not recreate or alias the obsolete cache directory. If the restarted task still
reports the stale locator, remove and reinstall the plugin, then restart once
more.

## Distribution provenance and the verifier

Every distributed surface carries the same `distribution-provenance.json`
record. Compare the candidate package with the CLI on `PATH`, user-wide skill,
and cached plugin without changing any installation state:

```bash
nelos-verify-distribution
```

The verifier never executes an untrusted `nelos` found on `PATH`. It rejects
relative or empty current-directory `PATH` components and excludes them from
inspection, so cwd content cannot influence the trust report. It reads sidecar
provenance, uses the installer's exact cached-plugin record when one is
available, verifies immutable-release integrity when run from the installed
release, and exits non-zero when a record is missing, ambiguous, invalid, or
stale. Source distributions also carry their expected distribution and skill
digests, so verification without install state hashes the complete PATH CLI and
cached-plugin roots plus the installed skill instead of trusting version labels
alone. It also never executes the `codexCommand` recorded in mutable install
state. Pass `--codex PATH` to opt into the active-plugin registry check with an
executable you explicitly trust; without it, that check is visibly reported as
`SKIP`. Recorded release, skill, bin, and plugin-cache paths are revalidated for
confinement and symlink-free ancestry before their contents are inspected. Set
`CODEX_HOME` to check an isolated installation. The `revision` is
the opaque release/build revision and must be updated once for all surfaces
when producing a new distribution.

## The skill-only development escape hatch

`npm run install:skill` remains available only as a development escape hatch.
It intentionally updates just the user-wide skill, so using it independently
can make the distribution verifier report drift. It applies the same
no-symlink ancestry rule to `CODEX_HOME` and the skill root, records the skill
content digest, and recovers an interrupted directory replacement using the
crashed transaction's recorded intent. A process-identity lease with a heartbeat
prevents recovery from reclaiming a live long-running install. Because this
standalone path has no external trust anchor for older provenance, any existing
content drift—even a self-consistent older managed copy—requires `--force`, which
replaces the whole skill directory including extra files.
