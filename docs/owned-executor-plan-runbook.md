# Owned executor plans

The executor can run a dependency plan of durable workers in separate Git
worktrees. A service owns the App Server connections, launch journals, completion
inbox and parent decisions. Closing an MCP frontend does not stop the workers.
CLI versions are diagnostic metadata; admission checks the requested model,
effort, effective permissions, account and current configuration.

This is an explicitly configured backend. Preparing a plan does not launch a
model or enable arbitrary model-authored execution policies. Normal plugin tools
remain available when the service is absent. The service does not spawn another
Nelos service, impersonate a native joined subagent, resume the user's parent,
or automatically merge worker branches.

## Prepare and run

Use a canonical, private directory on the execution host. Save an operator plan
JSON file with mode `0600` in a directory with mode `0700`:

```json
{
  "plan": {
    "schemaVersion": 1,
    "objective": "Implement and verify the bounded change",
    "maxParallel": 2,
    "slices": [
      {
        "id": "implementation-unique-id",
        "title": "Implement the change",
        "objective": "Implement the agreed change in the assigned worktree",
        "deliverable": "The implementation and its verification evidence",
        "acceptanceCriteria": ["The requested behavior and relevant checks pass"],
        "dependsOn": [],
        "lifecycle": "spinoff",
        "workspaceMode": "isolated-write",
        "taskShape": "everyday"
      }
    ]
  },
  "queenThreadId": "actual-parent-task-id",
  "webId": "A1",
  "queenTitle": "👑 A1 · Bounded change",
  "command": "/absolute/path/to/codex",
  "codexHome": "/absolute/path/to/signed-in/codex-home",
  "hostId": "actual-work-host",
  "sourcePath": "/absolute/canonical/repository",
  "worktreeRoot": "/absolute/canonical/sibling-worktrees",
  "expiresAt": 1790000000000,
  "approvalPolicy": "never",
  "directory": "/absolute/private/installation"
}
```

Replace the example identities and expiry with the actual authorized scope. The
source repository must have a committed base. Worktrees start from that exact
commit; uncommitted source changes are not copied. The worktree root must not
overlap the source repository. Use unique work-unit IDs. The parent task ID is a
logical join identity, not a claim of native Desktop lineage.

From the installed distribution directory:

```sh
node bin/nelos-executor-prepare /absolute/private/operator-plan.json
node bin/nelos-executor-service /absolute/private/installation/policy.json /absolute/private/installation/service
```

Preparation uses the same structured slice planner and persists its exact
model/effort, titles, wave contracts, prerequisite edges and worktree base. Read
the resulting `policy.json` to review the selected routes. Changes to the
operator input require a new installation and fresh, unique work-unit IDs;
repeating identical preparation preserves the original pinned base. Services
support at most 16 workers per plan. Planned wave boundaries preserve the
planner's concurrency limit.

Attach a parent MCP process with:

```sh
node bin/nelos-mcp --executor-endpoint /absolute/private/installation/service/endpoint.json
```

Unix socket paths must fit the host's path limit. Choose a short installation
path, especially on macOS. For a remote host, run the service and its attached MCP
process on that host through the existing transport; the endpoint is local IPC,
not a network address.

If the work depends on a particular MCP tool, add an optional
`requiredMcpTools` array to the operator input, for example
`[{"server":"node_repl","tool":"js"}]`. The service checks the newly created
thread's live tool connection before starting its model turn. Missing, failed,
authentication-required or merely cached tools do not satisfy that requirement.
Unconfigured tools impose no admission requirement; unrelated plugin failures do
not block the job. The supplied m3 canary explicitly requires `node_repl/js`.

## Parent loop

1. Call `nelos_owned_status` and verify the plan identity and readiness.
2. Call `nelos_owned_launch`. The service preflights every ready member before
   dispatching that wave. No request can replace targets, prompts, routes or
   permissions. An incomplete or uncertain dispatch stops further admission.
3. Read `nelos_owned_notifications` and call `nelos_owned_collect` with each
   `workUnitId`. Review the validated envelope and independently verify the
   artifacts in that worker's worktree.
4. Call `nelos_owned_join` with `workUnitId`, `expectedAttempt`, `decision` and
   `decisionSummary`. Only an accepted successful result releases prerequisites.
   Then launch the next ready wave. Dependent prompts identify prerequisite
   workspaces for inspection; accepted changes are not silently merged into the
   dependent worktree. Parent integration remains explicit.
5. Acknowledge each notification using `workUnitId`, `notificationId` and
   `expectedAttempt`. This records receipt only; it does not accept the result.

The durable inbox and decisions survive owner restart. Repeated launch requests
never repeat a recorded native create or turn. SIGTERM/SIGINT drains active work;
frontend disconnect merely detaches. Unknown creation/turn outcomes retain their
journal and require reconciliation. Do not erase the journal or substitute a
new service directory to retry the same work.

Existing read-only jobs (schema 1) and bounded interrupted-worker retry families
(schema 2) remain supported. Isolated worktree jobs use schema 3, and dependency
plans use schema 4. Automatic retries remain explicitly authorized read-only
policies; write workers are not automatically repeated after interruption.
Review their actual worktree before authorizing replacement work.

## Trusted approval terminal

An isolated job may select `on-request` or `untrusted` instead of `never`. Such
jobs require a connected operator approval terminal before launch:

```sh
node bin/nelos-executor-approve /absolute/private/installation/service/ui/endpoint.json
```

The separate private endpoint accepts one operator connection. It displays
command/file approval requests and structured input/elicitation requests.
Responses are bound to opaque request tokens and rechecked against the live
owned turn. Disconnect, timeout, invalid answers and stale tokens cancel the
request. Session-wide permission grants and policy amendments are not supported.
There is no model-facing MCP approval tool. This boundary is between adapters
running as the same OS user; it is not a sandbox against that user's processes.

## Existing native plans

Preparation creates a new owned plan from structured planner output. It does
not convert old native receipts into execution grants or adopt existing workers.
Any existing work-unit record—including an unbound or launch-pending legacy
record—blocks installation under that ID. Successful installation persists
backend claims before exposing the runnable policy. Native orchestration rejects
claimed units, and owned plan next-actions select owned tools. Interrupted
preparation can replay only the same installation. Existing native tasks retain
their original reconciliation path and are never silently relaunched.

## Verification and product boundary

Offline tests cover real Git worktrees, dependency acceptance across restart,
partial waves, route failure before dispatch, legacy pending records, immutable
installation replay, trusted approvals and late/disconnected answers. Existing
executor tests cover lost responses, exact-turn recovery, expired authorization,
changed accounts/configuration and read-only retry limits.

Run the explicit signed-in canary on a test host with:

```sh
node bin/nelos-verify-owned-plan /absolute/codex /absolute/codex-home host-id parent-task-id
```

It requests Astra/medium, launches two isolated write workers, disconnects the
frontend, verifies their artifacts, restarts with a partial parent join, and
launches a third worker only after both prerequisites are accepted. It checks
inbox acknowledgment replay, unique native identities and an unchanged source
repository. Canary worktrees and private proof files are retained for inspection.

Detached parent wake remains unavailable. Queue experiments did not establish
reliable cross-owner deduplication. The durable parent loop is supported without
claiming native Desktop lineage, Desktop approval UI integration or handoff
certification. Linux/Node 20, fresh install/upgrade and final release-artifact
verification remain release gates, separate from these implementation tests.
