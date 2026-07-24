# Security policy

Nelos is an early-stage local plugin and CLI for observing and
coordinating Codex tasks. This policy describes the current implementation; it
does not imply that proposed host capabilities are available.

## Supported versions and platforms

Security fixes are made against the current repository version. Supported
development and installation platforms are macOS and Linux with Node.js 20 or
newer. Windows is not currently supported: the installer depends on POSIX
permissions, symbolic links, and a Unix-domain app-server control socket.

## Security boundaries

The installed plugin contains a local MCP server. Most orchestration tools
only read or update Nelos's private registry, but title synchronization,
spin-off completion wake delivery, and spin-off cleanup can mutate Codex
threads through the local app server. Wake delivery starts a queen turn or
steers its known active turn; cleanup archives only exact, accepted, required
spin-off thread IDs. Treat access to those tools and the app-server endpoint as
a task-mutation grant, not as read-only monitoring access.

Control currently uses a local Unix socket. An explicit CLI socket, the
`CODEX_APP_SERVER_CONTROL_ENDPOINT` process-environment descriptor, or the
legacy socket environment variable can redirect the client, so control of the
process environment is a trust boundary. The versioned host endpoint is a
receiving compatibility seam and proposed host contract: Codex does not
currently inject it automatically. Neither the descriptor nor the current
handshake authenticates host injection, attests the peer, or proves the
advertised server identity, version, or capabilities. Do not treat filesystem
reachability or the descriptor's `protocolVersion` as authentication. See
[Host-owned Codex control](docs/host-owned-control.md) for the exact proposal
and current limitations.

Nelos keeps local task, web, and spin-off lifecycle records under
`$XDG_STATE_HOME/nelos` (or `~/.local/state/nelos` when that variable
is unset). Registry files are written with mode `0600` and their directories
are created with mode `0700`. The records contain coordination metadata
such as task and turn IDs, titles, working directories, web relationships,
timestamps, task URLs, archive state, bounded completion summaries,
wake-delivery state, and the user's cleanup policy. Wake reconciliation reads
at most 20 recent queen turns and examines only turn and client-message IDs.
Nelos does not intentionally persist task prompts, transcripts, tokens, raw
turn content, or raw environment dumps.

Installation also creates local immutable releases, launchers, a user-wide
skill, a configured local plugin source and cache, provenance records,
transaction/lock data, and installation state under the configured Codex and
distribution roots. Installation state records paths, versions, integrity and
activation status; it is not a credential store. The Codex host owns its own
task data and active plugin registry; Nelos does not replace that store.

Plugin, skill, and CLI files are executable trust surfaces. Verify their shared
`distribution-provenance.json` with `nelos-verify-distribution` before use.
The installer manages only its declared destinations, rejects unsafe or
ambiguous ownership and symlink ancestry, excludes relative or empty `PATH`
components from command discovery, and does not override an earlier foreign
executable shadow. Supply explicit, canonical paths only when you trust their
contents and ownership. The installer does not install a second Codex CLI or a
permanent service. Codex owns its plugin cache and app-server lifecycle;
uninstall or cleanup must not remove or stop resources without verifying that
ownership.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use a private channel
provided by this repository or its owning organization—for example, the
repository's private vulnerability-reporting flow if it is visible and
enabled. If no private repository flow is available to you, contact a
repository administrator or maintainer through an organization-approved
private channel and ask how to submit the report. This policy does not publish
or imply a security email address.

Provide a minimal description of the affected version and surface, impact,
safe reproduction conditions, and any suggested mitigation. Do not include
secrets, access tokens, raw environment dumps, prompts, transcripts, private
task content, or unnecessary personal or customer data. Avoid public proof of
concepts or exploitable details until maintainers confirm that a fix and
disclosure plan are ready.

Maintainers should acknowledge a usable private report when they can, assess
scope and severity, request only the additional information needed, and provide
material updates as remediation progresses. Response time depends on
maintainer availability and complexity; no service-level or resolution-time
commitment is promised.

Ordinary defects without a confidentiality, integrity, authorization, or
availability impact may use the repository's normal bug-reporting channel.
Crashes, confusing behavior, or unsupported-platform failures are not security
reports by themselves. When unsure whether a defect crosses a trust boundary,
report it privately first.
