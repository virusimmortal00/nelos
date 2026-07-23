# ADR: Host-owned Codex control lifecycle

Status: proposed host contract; repository compatibility seam implemented July 2026.

## Decision

Codex should own the app-server process used by the task that loads Nelos.
The host starts or reuses that process as part of its own session lifecycle and
passes the plugin a scoped, versioned control endpoint. Nelos connects as
a client; it does not install another Codex CLI, bootstrap a system service, or
stop a process it did not create.

The target user path is: install the plugin, open a fresh Codex task, and use
the skill or CLI. A future host may supply `CODEX_APP_SERVER_CONTROL_ENDPOINT`
to a plugin/task context. Codex does not inject this descriptor today; the
repository implements only the receiving compatibility seam. The version 1
descriptor is:

```json
{"schemaVersion":1,"transport":"unix-websocket","path":"/absolute/host-owned.sock","protocolVersion":"host-protocol-revision"}
```

Discovery records still recognize explicit `--socket`, host descriptor, legacy
`CODEX_APP_SERVER_CONTROL_SOCKET`, and the historical `CODEX_HOME` default.
Task clients accept only the first three; the conventional default is diagnostic
metadata, not implicit authorization to control a standalone backend. An invalid
or missing host descriptor fails closed. Explicit socket development workflows
remain compatible.

## Verified capability versus proposal

Verified locally with `codex-cli 0.144.6`: Codex includes `app-server daemon`
commands (`start`, `restart`, `stop`, `version`, and remote-control controls), an
`app-server proxy` command, and the default control-socket location used by this
project. Re-confirmed on 2026-07-20 against the same pinned `codex-cli 0.144.6`
via `codex app-server --help`, `codex app-server daemon --help`, and
`codex app-server proxy --help`: both subcommands and their full set of
sub-subcommands (including `daemon bootstrap`/`enable-remote-control`/
`disable-remote-control`) still exist exactly as described, even though the
public app-server documentation at https://learn.chatgpt.com/docs/app-server
still documents only the bare `codex app-server --listen <stdio://|ws://|unix://|off>`
invocation form and says nothing about `daemon`/`proxy`. Official app-server
documentation describes the JSON-RPC protocol, stdio and WebSocket listeners,
and Unix endpoints for remote clients. The current plugin manifest can forward
allow-listed environment variables. As before, no implementation in this
project depends on the undocumented `daemon`/`proxy` subcommands —
`scripts/dev-app-server.mjs` only uses the documented `--listen` form.

Not verified or publicly specified today: automatic injection of a scoped
app-server endpoint into plugin/task environments, an endpoint lease API,
plugin identity in the app-server handshake, or host-managed idle shutdown for
this use case. The descriptor above is the exact missing upstream contract. The
repo implementation currently accepts only the verified Unix-WebSocket shape;
future transports require a new descriptor schema or an additive transport
implementation.

## Lifecycle and concurrency

The host is the single process and socket owner. Concurrent tasks and CLI
clients are clients of the same endpoint; they never unlink, replace, or
restart it. Host startup must use one owner lock and publish the socket only
after readiness. Losers of a start race attach to the winner after verifying
its identity and protocol. A disconnect triggers one bounded rediscovery and
reconnect; ambiguous mutating requests are not replayed unless a subsequent
read proves they did not commit.

The host tracks client/session leases and active turns. It may shut down after
all clients are gone, no turn or approval is active, and a bounded idle grace
period expires. New clients cancel pending shutdown. Shutdown removes only a
socket whose recorded filesystem identity still matches the host-owned socket.
Desktop may keep its own app server alive for broader product reasons; that is
still host policy, not a Nelos requirement.

## Handshake, versions, and recovery

Endpoint schema compatibility is checked before connection. The existing
`initialize` exchange remains the protocol handshake, but it does not currently
provide the identity/version/capability attestation needed by this design.
Upstream should return server identity, protocol revision/range, and capabilities
so the client can reject incompatible mutation surfaces before use. Descriptor
`protocolVersion`, when present, must be a non-empty string and is only an
unauthenticated discovery hint; it is not proof until the live handshake exposes
and authenticates that contract.

On stale socket, crash, or host upgrade, the client asks the host for a fresh
descriptor and reconnects. Reads may retry once. Mutation timeouts remain
unknown outcomes and require reconciliation by task/turn ID. No client removes
a stale socket unless it holds the host's ownership record and start lock.

The current app-server schema is the source of truth for mutation payloads. For
a named permission profile, both `thread/start` and `turn/start` receive the
profile ID as the `permissions` string, not as a nested permission object.
Clients request the experimental API capability, preflight the profile with
`permissionProfile/list` for the selected working directory, and stop before
thread creation or queen-title mutation when the profile is absent. The
repository's protocol fixture records this verified shape for the supported
Codex CLI version so payload compatibility remains testable across upgrades.

## Trust and security boundaries

Process-environment control is already a trust boundary in the current product:
the legacy socket variable can redirect the client in the same way. The new
descriptor makes that dependency versioned but does not make it authenticated.
The host must grant sandbox access only to tasks allowed to control it. The
descriptor requires an absolute Unix path; unknown schemas/transports, empty
values, and relative paths are rejected. Before enabling host descriptors for
privileged mutations, upstream must enforce a user-owned, non-writable socket
directory, verify socket ownership and peer identity where the OS supports it,
and attest server identity/version/capabilities in the live handshake.
Nelos does not add a portable peer-credential check in this seam because
Node's cross-platform Unix socket API does not expose one and applying partial
filesystem checks only in the client would overstate the guarantee. App-server
authorization must bind requests to the current Codex user/workspace and
distinguish read-only observation from task mutations. Endpoint values and
tokens must not enter logs or persisted web state. Network transports are out
of scope for schema version 1.

## Upgrade, uninstall, and migration

Host upgrades may rotate the endpoint and advertise a new compatible protocol
revision while old clients drain. Incompatible changes require a new descriptor
schema and coexistence window. Plugin uninstall removes only plugin files and
state; it never stops the host app server. Host uninstall owns daemon/socket
cleanup after verifying ownership.

Developers may continue `npm run dev:app-server`, `--socket`, or the legacy
environment variable. Migration is additive: hosts first inject the versioned
descriptor, then grant the plugin/task sandbox access, then remove dependence on
the conventional socket path. The developer launcher remains a test tool, not
the ordinary installation path.

## Fallback boundary

If a host cannot broker control, a later compatibility launcher may lazily
start the same installed Codex app server under a per-user lock and lease, with
identity-safe cleanup and idle shutdown. It must be opt-in or automatically
selected only when the host explicitly reports no endpoint. This repository
does not enable that fallback now because it would still depend on an available
Codex executable and could race the host-managed daemon.
