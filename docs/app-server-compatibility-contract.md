# Codex App Server Compatibility Contract

Status: accepted compatibility baseline, revision 1, 2026-07-28.

This contract defines the Codex App Server behavior Nelos may rely on today,
the evidence required to widen that behavior, and the failure rules that keep
task control from becoming a second lifecycle authority.

It is deliberately narrower than the current
[Codex App Server API](https://learn.chatgpt.com/docs/app-server.md). An API
being documented or present in a generated schema does not make it part of the
Nelos product surface.

## Authority and compatibility profiles

Native Codex remains authoritative for tasks, turns, approvals, permissions,
goals, and archive state. Nelos owns work-unit topology, attempts, action
identities, receipts, acceptance, cleanup policy, and web lineage. Current
state reads and exact mutation verification may inform Nelos; an ignored
notification, idle task, or successful transport write never proves work
completed or a result was accepted.

Nelos has four distinct App Server profiles:

| Profile | Transport | Purpose | Compatibility decision |
| --- | --- | --- | --- |
| Strict MCP bridge | Child `codex app-server --stdio`, JSONL | Bounded task inspection, title verification, parent wake delivery, and archive effects | Minimum Codex `0.144.5`; compatibility metadata names `0.144.5` and `0.144.6`, backed by one combined reduced `v0.144.x` fixture, earlier Desktop `0.144.6` evidence, and `0.4.0` release revalidation of the exact CLI npm distributions for both versions; newer semantic versions proceed provisionally behind the same response validators |
| Source CLI | Explicit Unix-WebSocket endpoint | Developer task start, list, read, send, title, watch, collect, and archive commands | Conditional development support on observed `0.144.6`; not covered by the strict bridge attestation |
| Distribution installer | Validated host-owned Unix-WebSocket endpoint | Best-effort refresh of a running plugin registry after a coherent disk install | Optimization only; under-development methods may fail and must degrade to restart-required |
| Verifier cleanup | Explicit disposable endpoint | Best-effort interruption of a smoke-test turn | Test-only; not a supported product dependency |

The profiles do not inherit capabilities from one another. In particular, the
strict bridge fixture does not attest the CLI's `thread/start` or `thread/list`
payloads, and installer-only plugin methods do not widen task-control support.

## Release decision

The supported revision-1 baseline is:

- a semantic server identity at or above minimum version `0.144.5`;
- combined reduced-fixture evidence whose recorded source covers `0.144.5` and
  Desktop `0.144.6`, plus `0.4.0` release revalidation of the exact
  `codex-cli 0.144.5` and `0.144.6` npm distributions; the raw generated
  schemas remain temporary rather than separately checked-in captures, and
  newer semantic versions are reported as compatible but untested;
- `initialize`, followed by the outbound `initialized` notification;
- `capabilities.experimentalApi: true`;
- stdio JSONL for the strict bridge;
- the reviewed `thread/read`, `thread/name/set`, `thread/resume`,
  `thread/turns/list`, `turn/start`, `turn/steer`, and `thread/archive`
  request and response subsets;
- closed thread-status and active-flag enums;
- one reconnect and replay for a transport-failed read; and
- one attempt and no blind replay for a mutation with an unknown outcome.

Everything else is conditional, best-effort, unavailable, or unknown as
classified below.

## Transport and handshake matrix

| Dependency | Evidence and maturity | Nelos rule |
| --- | --- | --- |
| JSON-RPC shape | Official: `method`, `params`, and optional `id`, with the JSON-RPC header omitted | Accept only bounded object messages; response `id` must match a pending request |
| stdio | Official JSONL transport; the combined fixture records the reviewed `0.144.x` shapes and `--stdio` was locally re-verified on `0.144.6` for this revision | Supported by the strict bridge at or above the minimum version, subject to strict per-operation response validation |
| Unix-WebSocket | Official WebSocket-over-Unix transport using HTTP Upgrade | Accept an explicit development `--socket` or validated descriptor only |
| TCP `ws://` / `wss://` | Official, but WebSocket transport is experimental and unsupported | Outside the revision-1 endpoint descriptor and Nelos product support |
| Host descriptor | Nelos proposal: `{schemaVersion:1, transport:"unix-websocket", path, protocolVersion}` | Receiver seam only. Codex does not inject, lease, or attest this descriptor today |
| Implicit `CODEX_HOME` socket | Historical diagnostic discovery | Never implicit authorization for task control |
| Initialization request | `clientInfo{name,title,version}` and `capabilities{experimentalApi:true,requestAttestation:false}` | Send once per connection, before all other requests |
| Initialization response | Strict bridge consumes `codexHome`, `platformFamily`, `platformOs`, and `userAgent`; shared client records the last three | Missing or malformed strict-bridge fields fail closed |
| Server identity | `userAgent` forms reviewed: `Codex Desktop/V`, `codex-cli/V`, and `nelos_mcp/V` | Strict bridge parses semantic `V`, rejects malformed versions and versions below `0.144.5`, and reports whether `V` was tested |
| Method negotiation | No method or capability list is advertised by `initialize` on the tested versions | Generated fixture, minimum-version policy, tested-version list, and strict response validators form the temporary compatibility boundary |
| Peer identity | `requestAttestation:false`; no authenticated host/plugin identity contract | Privileged host-owned control remains proposed, not release-supported |

The shared Unix-WebSocket client does not yet enforce the strict version and
response validators. Its operations therefore remain conditional even when
they happen to connect to a pinned runtime.

## Method matrix

### Strict MCP bridge

| Method | Fields Nelos sends or consumes | Classification and rule |
| --- | --- | --- |
| `thread/read` | Request: `threadId`, `includeTurns`. Response: `thread.id`, `name`, `status`, `cwd`, `parentThreadId`, `createdAt`, `updatedAt` | Stable documented method; the combined fixture records the same reduced subset for `0.144.5` and `0.144.6`. Returned ID, status, and flags must validate on every version |
| `thread/name/set` | Request: `threadId`, `name`; response body unused; followed by `thread/read` | Stable method, but no revision or compare-and-set. Support verified single-writer rename only |
| `thread/resume` | Request: `threadId`, `excludeTurns:true`; resulting task must read idle before a new turn | Stable method; exact behavior is version-specific and fixture-attested |
| `thread/turns/list` | Request: `threadId`, `limit`, `sortDirection`, `itemsView`, optional `cursor`. Response: `data`, `nextCursor`, turn `id`, `status`, `items`, and user-message `clientId` | Experimental. Requires `experimentalApi`; tested shapes come from the fixture and untested versions must satisfy the same validators |
| `turn/start` | Request: `threadId`, text `input`, optional `clientUserMessageId`. Response: `turn.id` | Stable core; fixture-attested subset. One mutation attempt |
| `turn/steer` | Request: `threadId`, `expectedTurnId`, text `input`, `clientUserMessageId`. Response: `turnId`, which must equal the expected turn | Stable core with version-specific client ID usage. One mutation attempt |
| `thread/archive` | Request: `threadId`; empty success response | Stable core. One attempt; lost response is an unknown outcome |

### Source CLI and installer

| Method | Fields Nelos sends or consumes | Classification and rule |
| --- | --- | --- |
| `thread/start` | Request: `cwd`, `approvalPolicy`, `ephemeral:false`, `serviceName`, `threadSource`, one of permission-profile `permissions` or `sandbox`, optional `model`. Response: `thread.id` and task fields | Stable core, but the exact extension set is not in the compact fixture. Conditional explicit-development support on observed `0.144.6` |
| `thread/list` | Request: `limit`, `sortKey:"updated_at"`, `sortDirection:"desc"`, `sourceKinds`, `archived:false`, `searchTerm`, `useStateDbOnly:true`. Response: `data[]` thread summaries | Stable core with version-specific filters. Conditional; `--all` fails rather than claiming a complete fallback |
| `permissionProfile/list` | Request: `cwd`. Response: `data[].id`; chosen ID is sent as the `permissions` string | Beta/version-specific. Attested only on `0.144.6`; profile absence never silently downgrades to a sandbox mode |
| Extended `turn/start` | Adds `permissions`, `model`, or `effort`; consumes initial turn status and items | Extensions are not fully captured by the strict fixture. Conditional on `0.144.6`; expand the fixture before release support |
| `plugin/read` | Request: `pluginName`, `marketplacePath`. Response fields used: plugin summary `id`, `name`, `source.type`, `source.path`, `installed`, `enabled`, `localVersion` | Officially under development and not for production clients. Installer preflight only |
| `plugin/install` | Same identity request; result unused; exact `plugin/read` verifies afterward | Officially under development. Best-effort post-commit refresh; failure means restart-required, not install failure |
| `turn/interrupt` | Request: `threadId`, `turnId`; empty success response | Stable documented method, but verifier cleanup only. Failure is ignored and archival verification remains authoritative |

`thread/read`, `thread/turns/list`, `turn/start`, `thread/resume`,
`thread/name/set`, and `thread/archive` also appear in the source CLI. Their
shared-client use remains conditional until that client adopts the same
version, schema, and failure gates as the strict bridge.

## Consumed schema contract

Every App Server field that currently affects Nelos behavior belongs to one of
these allowlisted groups:

| Schema group | Fields used |
| --- | --- |
| Thread identity and display | `id`, `sessionId`, `name`, `preview`, `cwd`, `source`, `threadSource`, `parentThreadId`, `forkedFromId`, `createdAt`, `updatedAt` |
| Thread lifecycle | `status` as a string or `{type,activeFlags}`; strict types `notLoaded`, `idle`, `systemError`, `active`; strict flags `waitingOnApproval`, `waitingOnUserInput` |
| Turn summary | `id`, `status`, `error`, `startedAt`, `completedAt`, `durationMs`, `items` |
| Turn paging | `data`, `nextCursor`; request `cursor`, `limit`, `sortDirection`, `itemsView` |
| Wake reconciliation | `userMessage.type`, `userMessage.clientId` |
| User input items | `type`; text `text`; skill/mention `name`; local image `path`; image `url` |
| Output items | Agent message `text` and `phase`; plan `text`; command `command`, `status`, `exitCode`, `durationMs`; file change `status`, `changes.length`; MCP/dynamic tool `tool`, `status`; collaboration item `tool`, `status`, receiver IDs; subagent activity `kind`, `agentThreadId` |
| Permission profiles | `data[].id` |
| Plugin refresh | Summary identity, local source path, installed/enabled state, and local version listed above |

The CLI suppresses reasoning and hook-prompt content, reduces unknown items to
their type for display, and returns some user-visible previews. Normal strict
inspection uses `thread/read(includeTurns:false)`. Parent-wake reconciliation
makes one bounded `thread/turns/list` request for at most 20 recent turns with
`itemsView:"full"` so it can match a user-message `clientId`; it discards every
other item field. The strict MCP bridge never returns previews, prompts,
transcripts, raw errors, or item content.

Turn/item unions are only partially attested. Lifecycle decisions must treat an
unknown or nonterminal status as active or unknown, never as success. An idle
thread is quiescent; durable result collection and queen acceptance remain the
only completion evidence for a Nelos web.

## Notification contract

Nelos sends the required `initialized {}` notification. Both current adapters
drop all inbound messages without an `id`, so no server notification changes
application state.

Upstream notifications such as `thread/status/changed`, `turn/started`,
`turn/completed`, `item/started`, `item/completed`, deltas, approvals, and
`serverRequest/resolved` are therefore available but unsupported by revision 1.
This is intentional until a durable catch-up contract exists:

- dropped, duplicate, late, or out-of-order notifications cause no Nelos state
  transition;
- polling `thread/read` observes only current state and may miss intermediate
  states;
- `snapshot-v1:` wait cursors hash allowlisted current state and are not native
  event cursors; and
- a wait timeout means no current-state change was observed, not that no event
  occurred.

## Failure and fallback rules

1. **Absent or disabled capability.** Experimental-method rejection is a hard
   capability failure. CLI history display may fall back from
   `thread/turns/list` to bounded `thread/read(includeTurns:true)`. Durable wake
   reconciliation and result collection fail closed when their bounded paging
   evidence is unavailable.
2. **Permission profile unavailable.** Stop before task creation or mutation.
   The caller must explicitly select a sandbox mode; Nelos never silently
   broadens or substitutes permissions.
3. **Version classification.** Semantic versions below `0.144.5` and malformed
   identities fail during initialization. A newer stable, prerelease, or build
   version proceeds as compatible but untested; every consumed response still
   validates, and any actual schema change fails at the affected operation.
   Only reviewed generated-schema evidence may add a version to the tested list.
4. **Schema mismatch.** Missing initialize fields, mismatched task IDs, unknown
   status types or flags, malformed pages, malformed JSON, and oversized
   messages fail closed.
5. **Read transport failure.** The strict bridge starts one fresh child,
   reinitializes, and replays the read once. A second failure is returned. The
   shared WebSocket client currently requires explicit reopen.
6. **Mutation rejection.** A definite server rejection may be returned as
   unapplied. Retrying still requires the operation's own idempotency contract.
7. **Mutation timeout, disconnect, or malformed response.** Treat as unknown.
   Never replay blindly. Reconcile by stable task, turn, title, archive state,
   or client message ID where possible; otherwise return attention.
8. **WebSocket overload.** Upstream documents error `-32001` and retry with
   backoff for overloaded WebSocket ingress. Nelos does not yet preserve this
   code. Never infer that a mutation is safe to retry.
9. **Installer method failure.** Preserve the coherent disk installation and
   report that a fresh task/restart is required. The under-development live
   refresh is never the installation authority.
10. **Endpoint absence or invalidity.** Fail closed. Do not launch, replace,
    unlink, or stop an endpoint the client does not own.

## Explicit exclusions

Revision 1 does not support or claim:

- a native wait method, notification sequence, resumable cursor, replay token,
  or catch-up request;
- atomic title synchronization, compare-and-set, or an expected title revision;
- automatic host descriptor injection, endpoint leases, peer identity,
  authenticated plugin identity, or host-managed shutdown;
- network endpoint support in descriptor schema version 1;
- general-purpose App Server proxying, transcript storage, or a Nelos-owned
  task lifecycle;
- Goals, fork, unarchive, rollback, review, approvals, hooks, or other
  documented methods merely because they exist; or
- compatibility below Codex `0.144.5`, with malformed identities, or a claim
  that a provisionally allowed newer semantic version has
  passed the complete Nelos verification matrix.

Resumable subscriptions and title compare-and-set remain backlog monitor items,
not actionable implementation work, until upstream schema and behavior provide
the missing contracts.

## Evidence

- Current official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server.md):
  protocol, transports, initialization, experimental gating, method maturity,
  events, errors, and approvals.
- [`test/fixtures/mcp-app-server-protocol-v0.144.x.json`](../test/fixtures/mcp-app-server-protocol-v0.144.x.json):
  combined reduced generated-schema evidence for the strict bridge. Its source
  metadata records generation from CLI `0.144.5` and Desktop `0.144.6`, but it
  is not a pair of independently checked-in raw schema captures.
- [`test/fixtures/app-server-permissions-v0.144.6.json`](../test/fixtures/app-server-permissions-v0.144.6.json):
  named-permission payload evidence.
- [`mcp-tool-surface.md`](mcp-tool-surface.md): verified Desktop/child behavior
  and the existing bridge decision.
- [`host-owned-control.md`](host-owned-control.md): proposed host lifecycle and
  implemented endpoint receiver seam.
- Release revalidation on 2026-07-28 used isolated npm distributions for
  `codex-cli 0.144.5` and `0.144.6`. Both generated experimental schemas; the
  initialization, read, name, resume, bounded turn-list, start, steer, archive,
  status, and active-flag shapes Nelos consumes were identical. Each exact
  binary also passed initialization, Unix-socket transport, task creation, two
  same-task live turns, readback, archival, and cleanup.

Official documentation is a moving current reference rather than versioned
`0.144.x` documentation. Generated schemas and bounded probes are decisive for
the pinned compatibility claim.

### Generated-schema and runtime collectors

`collectGeneratedSchemaEvidenceV1` reads only the artifact path declared by
the caller, or executes only a declared executable plus argument vector and a
separately declared identity command. Its normalized report records the exact
Codex version (and commit when supplied), artifact or command provenance,
SHA-256 digest, and observation time. Malformed JSON, missing identity,
identity mismatch, command failure, and timeout are non-evidence; a schema
contract mismatch is the only collector result classified as incompatible.

The required offline pull-request gate delegates its checked-in fixture check
to this collector in artifact mode. It does not generate schemas, update the
fixture, or change the supported-version list.

Required pull-request CI invokes `npm run compatibility:required`. That command
resolves the pull request's actual merge base, removes `OPENAI_API_KEY`, and
loads the offline network blocker through `NODE_OPTIONS` so selected child
tests inherit it. It is the only compatibility status intended for branch
protection.

`collectRuntimeTransportEvidenceV1` starts the exact declared Codex executable
over stdio JSONL, initializes once, requires an exact declared supported
version, and performs only the declared bounded read operations. The collector
does not probe or infer Desktop, cloud, entitlement, rollout, or closed-host
behavior.

`collectRuntimeLiveEvidenceV1` is a separate entry point and returns
unavailable without opening a transport unless `enabled: true` is supplied.
Even when enabled, it accepts only explicitly declared read-only operations.
It is not registered in the offline gate or any required pull-request script.
The older `verify:app-server:live` lifecycle smoke remains an explicitly
requested developer check; it is not compatibility evidence and does not
update fixtures or version policy.

`concludeWireCompatibilityV1` makes generated-schema and exact runtime results
decisive. Public implementation-source observations are preserved as
`advisory-only` and cannot independently produce a compatible or incompatible
conclusion.

### Bounded public-source observations

The registry also pins the official
[`openai/codex`](https://github.com/openai/codex) release tags and peeled commit
SHAs used for source comparison. `collectUpstreamSourceEvidenceV1` accepts only
a repository, release, and exact paths or generated artifacts already declared
for the selected capability. It resolves the tag or commit, verifies the
declared SHA, performs a depth-one blob-filtered fetch, and hashes only the
selected files. Missing, moved, non-file, unresolved, mismatched, or
infrastructure-failed inputs produce non-evidence.

The separately declared `refs/heads/main` route is always labeled
`early-warning-advisory`; it cannot satisfy release or blocking compatibility
evidence. Public source cannot establish Desktop, cloud, entitlement, rollout,
or closed-host behavior. Source-only drift remains advisory until corroborated
by official documentation, generated schemas, or exact runtime evidence.

Scheduled/manual drift reports preserve documentation, floating-main,
exact-release source, generated-schema, and transport outcomes even when
infrastructure is unavailable. Release verification is stricter: a bundle is
accepted only when the open-source tag resolves to the registry's exact commit
and both schema and runtime identities equal that same supported release
version. Unresolved or mismatched refs are non-evidence. Live-runtime and
semantic jobs are manual, optional, advisory-only, and have distinct job names;
they cannot satisfy or override the required deterministic status. No evidence
workflow automatically changes compatibility claims or checked-in artifacts.

## Hardening work derived from this contract

The next implementation slice should make the current distinctions executable
without widening product behavior.

### Fixtures

1. Split tested compatibility evidence by version and profile: `mcpBridge`, `cli`,
   `installer`, and `verifierOnly`.
2. Add deterministic reduced-schema extracts or extraction hashes for
   initialization, every method above, full consumed Thread/Turn/Item subsets,
   client capabilities, and enum values.
3. Extend the `0.144.6` permission fixture with pagination and availability
   fields; keep `0.144.5` named permissions explicitly unknown.
4. Add negative fixtures for disabled experimental APIs, missing profiles,
   unknown runtimes, changed enums, missing methods, dropped notifications,
   reconnects, and ambiguous mutation responses.

### Adapters

1. Introduce one versioned compatibility descriptor consumed by both clients,
   with separate supported, conditional, installer-only, and verifier-only
   method sets.
2. Apply stable-identity, minimum-version, tested-version reporting, and
   allowlisted per-method request and response validators to the shared client
   before product mutations.
3. Preserve bounded error codes and uncertainty classifications without
   exposing raw server bodies.
4. Add at most one rediscovery/reconnect for read-only WebSocket calls. Keep
   zero automatic mutation replay.
5. Either opt out of every ignored notification using the documented exact
   notification names or continue to discard them explicitly; do not introduce
   subscription-derived state.

### Tests

1. Fail when a literal App Server method in `bin/`, `src/`, or `scripts/` lacks
   a profile, maturity, schema, and failure classification here.
2. Parameterize the compatibility suite across tested `0.144.5`/`0.144.6`,
   an older version, newer untested stable and prerelease versions, malformed
   identities, disabled experimental APIs, missing initialize fields,
   unavailable profiles/methods, changed enums, and malformed pages.
3. Test WebSocket close-before-response, late responses, fragmented messages,
   oversized aggregate messages, one read replay, a second read failure, and
   zero mutation replay.
4. Prove id-less notifications never establish completion and current polling
   plus durable observation/join remains authoritative.
5. Cover exact CLI and installer request/response fields, including restart
   fallback, and reject `0.144.5` named permissions until evidence changes.
6. Assert that no native catch-up/subscription request or title revision field
   is emitted.

This hardening is the prerequisite for the separate task-lifecycle,
turn-lifecycle, permission/hook, and continuation contracts.
