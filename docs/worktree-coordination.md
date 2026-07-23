# Worktree Coordination

Nelos coordinates task lifecycles; it does not infer Git ownership
from an agent thread. A durable Codex task, a Git branch, and a Git worktree are
different resources and must be bound explicitly when work runs concurrently.

## Branch Contract

Use one Jira subtask, one branch, one named worktree, and one pull request for
separately reviewable work. Provision the branch and worktree before starting
the Codex task, then pass the absolute worktree path through `--cwd`.

### Opt-in provisioning

`nelos worktree provision` is the supported initial provisioning adapter.
It performs no task, merge, deployment, or cleanup action. It instead creates
or explicitly adopts one clean worktree and records a private receipt under
the user-scoped Nelos state directory.

```bash
nelos worktree provision \
  --action-id "web-A1-api-launch-r1" \
  --work-unit-id "api" \
  --owner-task-id "$CODEX_THREAD_ID" \
  --source "/absolute/path/project-main" \
  --worktree-path "/absolute/path/project-api" \
  --branch "nelos/BA-1234-short-name" \
  --base "origin/main"
```

The source worktree must be clean. The destination's parent must be a real,
canonical directory with no symlinked components; the destination must not
already exist. Use `--operation adopt` only for an existing, clean worktree
that already has the requested repository, branch, and base commit.

The `action-id` makes this effect idempotent: rerunning the same command
verifies the recorded worktree instead of creating another one. Reusing that
ID with different ownership, branch, repository, or path is rejected. A crash
after the pending receipt is written is reconciled by inspecting the expected
worktree; ambiguity becomes explicit queen attention. No supported command
removes a worktree.

### State boundary

Provisioning receipts are private, durable execution state and are the source
of truth for workspace ownership. The planned user-scoped SQLite database may
later project bounded lifecycle observations for fast cross-repository reads,
but it must not own a Git lock, decide a receipt is current, or replace Git
verification. In particular, a SQLite transaction is never held while invoking
Git; the repository lock covers only the short provisioning decision and the
receipt makes restart reconciliation possible.

### Queen workflow

For an isolated-write `WorkUnitSpecV1`, the queen can now use this bounded
sequence in explicit standalone development:

1. Preview the deterministic action, branch, and path without changing Git:

   ```bash
   nelos worktree plan \
     --web-id A1 --work-unit-id api --spec-revision 1 --attempt 1 \
     --worktree-root "/absolute/path/writers"
   ```

2. Launch exactly once from the durable work-unit contract. This writes the
   `launch-pending` execution transition before provisioning, starts the
   spinoff only after the receipt verifies, and then binds its returned task ID.

   ```bash
   nelos worktree launch \
     --work-unit-spec "/absolute/path/api-work-unit.json" \
     --prompt-file "/absolute/path/api-prompt.md" \
     --source "/absolute/path/project-main" \
     --worktree-root "/absolute/path/writers" \
     --base origin/main \
     --socket "/absolute/path/app-server.sock"
   ```

   If the process is interrupted while the launch is pending, the command does
   not guess whether a task was created. It stops for queen attention rather
   than risking a duplicate writer.

3. Inspect ownership without contacting Codex, or inspect the queen's full
   read-only integration queue through the same app-server connection:

   ```bash
   nelos worktree inspect --action-id "launch:A1:api:r1:a1"
   nelos worktree integration \
     --queen-thread-id "$CODEX_THREAD_ID" \
     --socket "/absolute/path/app-server.sock"
   ```

The integration queue never accepts or merges work. It requires a current
successful result, a clean branch descended from the recorded base with at
least one member commit, and existing relative artifacts whose real paths stay
inside the assigned worktree.

After the provisioning receipt is `provisioned`, task launch remains explicit:

```bash
nelos start \
  --title "BA-1234: Short name" \
  --cwd "/absolute/path/project-ba-1234" \
  --prompt "Work only in /absolute/path/project-ba-1234 on branch nelos/BA-1234-short-name."
```

## Ownership Rules

1. Assign exactly one concurrent writer to each worktree.
2. State the allowed worktree and branch in every writer's task prompt.
3. Do not rely on an automatically forked agent workspace as the branch or PR
   boundary.
4. Give web member tasks disjoint, pre-provisioned worktrees when they must write.
5. Keep dependency ordering, integration, and conflict resolution with the
   queen.
6. Resume an idle persistent task with `nelos send` when its dependency
   gate opens; do not create a replacement task for the same branch.

Read-only agents may inspect a shared checkout, but they must not make commits
or modify files there. The queen must retain sole write ownership of its own
branch while each writing web member uses a separate worktree.

## Native Desktop Worktree Launch

Codex Desktop can manage its own worktrees end to end; this is a second,
host-owned path alongside the explicit `git worktree add` contract above, and
the task-launch workflow should recognize both:

1. A chat selects **Worktree** under the composer and picks the Git branch to
   base it on (`main`, a feature branch, or the current branch with
   uncommitted changes), optionally with a local environment for setup
   scripts.
2. New worktrees start in a **detached HEAD** state by default, so parallel
   worktrees never collide on a shared branch name.
3. **Create branch here** converts the worktree's detached HEAD into a
   persistent branch once the work is ready to commit, push, and open a pull
   request from.
4. **Handoff** moves a chat between the Local checkout and its Worktree, since
   Git allows only one branch checked out per location at a time. Handing a
   chat back to its worktree later resumes the same associated environment.

This satisfies the one-writer-per-worktree rule in the same way explicit
provisioning does: a host-managed worktree is a distinct checkout with its own
(initially unnamed, later named) branch, so two concurrent host-managed
worktrees cannot collide any more than two explicitly provisioned ones can.

## Workspace Identity (Milestone 5 design)

The planned opt-in Git/workspace effect adapter applies when a host exposes enough
information to describe a task's workspace — whether host-managed (above) or
explicitly provisioned (Branch Contract) — Nelos should be able to
record these fields in private execution state:

| Field         | Meaning                                                                 |
| ------------- | ------------------------------------------------------------------------ |
| `repository`  | The repository root the worktree belongs to.                            |
| `baseRevision`| The commit or branch the worktree was created from.                     |
| `branch`      | The branch checked out in the worktree, or `null` while detached.       |
| `worktreePath`| The absolute path of the worktree, if the host will attest to it.       |
| `ownerTaskId` | The Codex task ID that holds write ownership of this worktree.          |
| `ownershipState`| One of `unclaimed`, `owned`, or `released` — whether a writer currently holds this worktree. |

These fields are proposed schema, not an implemented feature: no code in this
repository populates, mutates, or trusts them yet. Milestone 5 owns turning
this into an actual effect adapter, receipts, and audit events; this section
only fixes the shape and trust boundary so that follow-on work does not
reopen it.

## Native Host Worktrees vs. Standalone App-Server Transport

The workspace-identity fields above are only as trustworthy as their source:

- **Native host worktrees**: the host (Codex Desktop) performs the Git
  operations itself — worktree creation, detached HEAD, branch naming, and
  Handoff — so `repository`, `branch`, and `worktreePath` can be read from the
  host's own task/thread state rather than inferred. This is the only path
  where Nelos could treat those fields as host-attested.
- **Standalone app-server transport** (`docs/host-owned-control.md`): a
  directly connected app server has no worktree of its own opinion — the
  worktree is whatever `--cwd` was pointed at when the task was started. In
  this mode workspace identity is exactly what the Branch Contract above
  already requires the operator to provision and pass in explicitly; nothing
  the app server returns can be trusted as an independent attestation of
  worktree identity.

A future effect adapter must not conflate the two: it may read host-attested
identity fields verbatim under native worktrees, but under standalone
transport it must continue to require the same explicit `--cwd`/branch
contract this document already establishes, not invent an attestation the
transport cannot back.
