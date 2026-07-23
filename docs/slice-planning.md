# Slice Planning and Intelligence Routing

Nelos composes two tools for high-level work:

1. The queen turns the user's objective into bounded semantic slices with
   deliverables, acceptance criteria, dependencies, lifecycle, and isolation.
2. `nelos plan slices` validates that topology, schedules deterministic
   parallel waves, and applies the reviewed model/reasoning policy to every
   slice.

The CLI deliberately does not pretend to understand arbitrary natural
language. The queen supplies judgment; the planner supplies a stable, testable
contract. Routing is a reviewed cost/intelligence heuristic, not a claim of
mathematical optimality.

## Example

Suppose the user asks:

> Design and ship a new task-history view, including implementation,
> documentation, and an independent verification pass.

The queen can produce this bounded input:

```json
{
  "schemaVersion": 1,
  "objective": "Ship the task-history view",
  "maxParallel": 2,
  "slices": [
    {
      "id": "architecture",
      "title": "Architecture decision",
      "objective": "Resolve the data and UI boundaries",
      "deliverable": "A decision with risks and interfaces",
      "acceptanceCriteria": ["Every mutable boundary has one owner"],
      "dependsOn": [],
      "lifecycle": "subagent",
      "workspaceMode": "shared-read-only",
      "taskShape": "complex/open-ended"
    },
    {
      "id": "inventory",
      "title": "Test inventory",
      "objective": "Locate reusable fixtures and coverage gaps",
      "deliverable": "A bounded test map",
      "acceptanceCriteria": ["Existing fixtures and missing cases are listed"],
      "dependsOn": [],
      "lifecycle": "subagent",
      "workspaceMode": "shared-read-only",
      "taskShape": "clear/repeatable"
    },
    {
      "id": "implementation",
      "title": "History implementation",
      "objective": "Implement the approved task-history view",
      "deliverable": "A tested patch in an isolated worktree",
      "acceptanceCriteria": ["Focused tests pass", "The view has a useful empty state"],
      "dependsOn": ["architecture"],
      "lifecycle": "spinoff",
      "workspaceMode": "isolated-write",
      "taskShape": "everyday"
    },
    {
      "id": "documentation",
      "title": "History documentation",
      "objective": "Document the approved user workflow",
      "deliverable": "User-facing documentation in an isolated worktree",
      "acceptanceCriteria": ["The example matches the approved interface"],
      "dependsOn": ["architecture"],
      "lifecycle": "spinoff",
      "workspaceMode": "isolated-write",
      "taskShape": "clear/repeatable"
    },
    {
      "id": "verification",
      "title": "Independent verification",
      "objective": "Audit the integrated result against the objective",
      "deliverable": "A pass/fail report with exact evidence",
      "acceptanceCriteria": ["Every acceptance criterion has evidence"],
      "dependsOn": ["implementation", "documentation", "inventory"],
      "lifecycle": "subagent",
      "workspaceMode": "shared-read-only",
      "taskShape": "complex/open-ended"
    }
  ]
}
```

Pipe it without shell-encoding multiline JSON:

```bash
nelos plan slices --spec-file - < slice-plan.json
```

The result has three waves:

| Wave | Concurrent slices | Default route |
| --- | --- | --- |
| 1 | `architecture`, `inventory` | Sol/Medium, Luna/Low |
| 2 | `implementation`, `documentation` | Terra/Low, Luna/Low |
| 3 | `verification` | Sol/Medium |

For a native durable task, the queen passes the slice's
`route.launch.nativeTask` object directly as the creation tool's `model` and
`thinking` fields. It launches only the current wave, gives each concurrent
writer a different worktree, waits for accepted results, and then unlocks the
next wave. Durable slices become sidebar spinoffs; bounded subagents return to
the queen.

The route is fail-closed. The queen must not omit or substitute a decided model
or reasoning value when native task creation requires additional authorization.
It obtains approval for the exact values or does not launch. After creation it
runs `nelos intelligence verify` for the returned task ID and expected
route. Work from an unverified or mismatched task cannot settle a wave or enter
queen acceptance.

## Overrides and Guardrails

Each slice may include a `routing` object with `profile`, `model`, or `effort`.
Model and reasoning are independent, so omitting either dimension preserves its
task-shape recommendation. Explicit values still pass the same reviewed
catalog. Ultra additionally requires `nativeFanoutAllowed: true` and a Sol or
Terra route.

The planner rejects unknown fields, duplicate or cyclic dependencies, unsafe
shared concurrent writers, unsupported task shapes, plans larger than 32
slices, and concurrency above eight. It only plans and routes; task creation,
worktree provisioning, acceptance, integration, and archival remain explicit
queen or user actions.
