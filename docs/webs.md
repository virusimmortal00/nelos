# Webs and Terminology

Codex exposes several kinds of work that are easy to conflate. Nelos
uses these terms consistently:

| Term | Meaning |
| --- | --- |
| **Task** | A durable sidebar conversation. Codex's UI generally calls it a chat; the app-server protocol calls it a thread. |
| **Agent** | The runtime actor executing a turn inside a task; it has no durable task title of its own. |
| **Custom agent** | Reusable configuration for a spawned agent session, not a durable work container. |
| **Queen** | A task responsible for starting, monitoring, and integrating work across a web. |
| **Spinoff** | A separate top-level task started or directed by a queen, with its own lifecycle. |
| **Subagent** | A delegated agent for bounded work, with an inspectable child thread. Its result returns to the current task, and it becomes a web member only when joined. |
| **Web member** | A spinoff or subagent that belongs to a web. |
| **Web** | One queen and the queen's direct web members, identified by a shared web ID. |

Queen, spinoff, web member, and web are Nelos vocabulary. See the Codex
documentation for the native [subagent](https://developers.openai.com/codex/subagents)
and [app-server thread](https://developers.openai.com/codex/app-server) models.

Use *parent* and *child* only for actual app-server thread topology.
`nelos spinoff` creates a separate top-level thread with `thread/start`;
queen and spinoff describe its web roles, not its thread topology.

## Title Grammar

Top-level web IDs use an uppercase letter and a digit. Title role markers have
one canonical order:

```text
[🕸️ inbound] [🕷️ outbound] [👑] · base title
```

Each bracketed marker is optional, but present markers stay in that order. The
crown records queen responsibility independently from web lineage; it never
replaces an inbound or outbound web marker. Examples:

```text
👑 · Standalone queen
🕷️ A1 👑 · Root queen
🕸️ A1 · First spinoff
🕸️ A1 · Second spinoff
```

A spinoff can also become queen of a nested web. Nelos allocates a
hierarchical web ID and retains both roles in its title:

```text
🕷️ A1 👑 · Root queen
🕸️ A1 🕷️ A1.1 👑 · Spinoff queen
🕸️ A1.1 · Nested spinoff
```

The inbound `🕸️` marker always comes first, followed by outbound `🕷️`, then
the queen crown. Crown synchronization preserves these web markers and
normalizes legacy outer-crown forms such as
`👑 · 🕸️ A1 🕷️ A1.1 · Spinoff queen` into the canonical order. Web IDs are
compact visual labels, not substitutes for stable task IDs.

## Native Desktop Workflow

When Codex exposes native project/thread tools, create durable members through
those tools so the desktop sidebar receives the host's normal lifecycle events.
For a high-level objective, run the queen-authored contract through
`nelos plan slices --spec-file -`, launch only its current dependency wave,
and pass each slice's `route.launch.nativeTask` to native creation. See
[Slice Planning and Intelligence Routing](slice-planning.md).
Record topology without connecting to an app-server socket:

```bash
nelos web begin --registry-only --title "Release planning"
nelos web join --registry-only --id A1 --title "API changes" \
  --queen-thread-id QUEEN_THREAD_ID --thread-id MEMBER_THREAD_ID
```

Each command returns `renderedTitle`, `titleVerified: false`, and
`requiresNativeTitleSync: true`, plus a `nextAction` with the exact native title
operation. Execute that action and its verification fields rather than
reconstructing the title protocol. Use native multi-thread wait, read, send,
navigate, and archive operations for the rest of the lifecycle. If native task
tools or a host endpoint are unavailable, stop; do not bootstrap a standalone
daemon as an implicit desktop fallback.

The local record is topology plus a derived lifecycle observation. A native
archive does not authorize a second local archive mutation. Until the Desktop
host exposes a scoped observation callback, registry-only desktop records retain
`disposition: "unknown"`; show that as unobserved rather than guessing whether
the task is active or archived. App-server-backed reads refresh the cache from
the app server, stamp `observedAt`, and give the result a bounded `freshUntil`
lease. The next read still contacts the source of truth; the lease only makes
cache age explicit for diagnostics and future projections.

## Development-only Standalone CLI Workflow

This is development documentation only. The task-management skill never directs
an agent here. For deliberate standalone development, start a development app
server and pass its absolute socket explicitly:

```bash
nelos spinoff \
  --title "API changes" \
  --prompt "Implement the API changes and leave verification in this task's output." \
  --cwd "/absolute/path/to/spinoff-worktree" \
  --queen-thread-id "$CODEX_THREAD_ID" \
  --socket "/absolute/path/app-server.sock"
```

The queen defaults to `CODEX_THREAD_ID`; use `--queen-thread-id ID` when
invoking the command elsewhere. The command allocates or reuses a web, renames
the queen, creates the spinoff with the same web ID, and persists structured
relationship metadata.

When web visibility is useful, built-in subagent tools do not always expose the
new subagent child thread's ID to the queen. In that case, begin the web first:

```bash
nelos web begin --socket "/absolute/path/app-server.sock"
```

Pass the returned `webId`, queen `threadId`, and a short title in the subagent's
initial instructions. The subagent renames its child thread before doing other
work:

```bash
nelos web join --id A1 --title "Architecture scan" \
  --queen-thread-id QUEEN_THREAD_ID \
  --socket "/absolute/path/app-server.sock"
```

Both commands are idempotent. `web begin` reuses the current task's outbound
web, and `web join` reuses matching inbound membership. Allocation and
membership are stored under the user's `nelos/webs` state directory so
nested webs do not depend on parsing sidebar titles as their source of truth.

Socket-backed `web begin` returns a verified `liveTitle`. Registry-only setup
returns an unverified `renderedTitle` that must be synchronized through the
native desktop tool. Never use one process's successful title read as proof of
another process's live sidebar projection.

At a queen checkpoint, collect one current bounded result from every direct,
active member:

```bash
nelos web collect --queen-thread-id "$CODEX_THREAD_ID" \
  --socket "/absolute/path/app-server.sock"
```

Collection is read-only and transcript-free. It keeps app-server transport
lifecycle separate from the member's reported work outcome, so a completed
turn may still report `blocked` or `failed`. `latestTurnId` controls transport
lifecycle and `sourceTurnId` identifies the completed turn supplying the
bounded result; they differ while a corrective turn runs after a prior result.
`allSucceeded` means every member's latest turn is completed and its current
result is `succeeded`; it is not queen acceptance. A queen records a separate,
durable acceptance decision tied to the work-unit revision, attempt, member
task, source turn, and bounded result. Only a current accepted prerequisite can
release a dependent work unit. Missing, malformed, rejected, stale, and
unavailable results remain blocked or `unknown`, never implicitly accepted.

For a durable execution web, inspect the gate and record a decision after the
queen has reviewed the current bounded result:

```bash
nelos web readiness --id WEB_ID
nelos web accept --work-unit-id UNIT_ID --member-thread-id MEMBER_ID \
  --source-turn-id TURN_ID --result-file result-envelope.json
```

Both commands use only local durable state. `web accept` atomically persists
the queen decision before reporting the new ready set, so a restarted queen
reconstructs the same dependency release rather than treating completion as
approval.

With `--wait`, reaching `--max-wait-ms` returns a normal bounded collection
checkpoint rather than throwing away the evidence gathered so far. The added
`wait` object reports `status: "timed_out"`, elapsed and configured wait bounds,
`mayStillBeRunning`, and an ordered identity-only list of nonterminal members.
Each list entry contains the task ID and a work-unit ID when a valid result was
already observed. A timeout is not a failed work outcome; recollect or steer the
identified task as appropriate.

Socket-backed `web begin` and `web join` mutate live task titles through an
explicit app-server control socket. Use them only from a trusted queen with the
`task-orchestrator` permission profile (or equivalent access). Registry-only
variants mutate local topology but perform no live task action. `web collect`
uses an explicit socket only for bounded reads. Do not grant control-socket access to a web member
solely so it can rename itself; when a native creation tool accepts a title,
set the decorated title there instead.

Web title markers represent durable web lineage and persist for the task's
lifetime.
A web ID becomes reusable only after its queen and every task carrying that ID
or a descendant ID are observed archived through `nelos archive` or a
host-provided lifecycle observation. Until then its compact ID remains reserved;
the local cache never releases it based on a manually asserted archive. Sidebar
activity state, rather than removal of the marker, indicates whether a member is
currently running.
