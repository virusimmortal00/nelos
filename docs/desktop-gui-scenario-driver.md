# Desktop GUI scenario driver

`DesktopGuiScenarioDriver` executes predefined UI scenarios through an accessibility-only boundary. The public `nelos/desktop-smoke-contract` allowlists six action types: click, keypress, scroll, menu selection, sealed text entry, and waiting for an opaque condition. It exposes no shell, script, DOM, IPC, or evaluation operation.

Text inputs are referenced by sealed-value IDs. The driver borrows their bytes only for the accessibility call, zeroes them afterward, and supports terminal absence cleanup. Scenario results contain stable action/checkpoint/assertion receipts, not prompt content.

Screenshots require a complete exclusion inventory for the conversation and every visible credential region. The boundary captures only after that geometry validates. The public result retains a digest, byte length, media type, scenario ID, and `sanitized: true`; it does not retain raw pixels.

The included Linux AT-SPI boundary is suitable for a disposable Desktop guest. Provider-specific VM creation, application installation, and teardown belong to the fixed machine-local smoke driver described in [Disposable Desktop smoke lane](disposable-desktop-smoke.md).

For direct guest-side debugging, use:

```sh
nelos-desktop-gui-driver \
  --scenario /private/scenarios/release.json \
  --bindings /private/scenarios/bindings.json \
  --sealed-root /private/sealed-values
```

Those inputs must be created inside the disposable guest. Do not place sealed values or screenshots in the repository or controller plugin cache.

## Workflow libraries

The repository ships two validated scenario sets under `validation/desktop-smoke/scenario-sets/`. `release.json` is the release gate and exercises all representative workflows. `routine.json` is the faster checkpoint set; it retains plugin discovery, planning, and recovery coverage while omitting the longer joined-agent and durable-task waits. `coverage-matrix.json` is the machine-readable source for library membership and checkpoint expectations. `accessibility-bindings.json` contains only allowlisted accessibility selectors and opaque conditions.

| Scenario | Nelos capability | Release | Routine | Visual-review checkpoints |
| --- | --- | --- | --- | --- |
| `plugin-availability` | Installed plugin inventory is reachable | yes | yes | plugin inventory open; single-window state |
| `planning-lifecycle` | A plan reaches its ready state | yes | yes | plan ready; accessibility structure |
| `joined-agent-execution` | A joined member runs and completes | yes | no | member running; member complete |
| `durable-task-lifecycle` | A durable task runs, exposes details, and completes | yes | no | running; details; complete |
| `attention-recovery` | An attention state can be retried to recovery | yes | yes | attention; recovered; single-window state |

Every run activates and verifies a distinct, pre-created scenario-bound task before its first action. Text entry names a one-shot sealed value; scenario files, bindings, coverage metadata, driver results, and evidence receipts contain no exchange content. Assertions use element presence, task state, and window count only, so they do not inspect or retain visible model text.

Normal screenshots occur only at user-visible state transitions listed in the matrix. Every action also owns a failure-only screenshot checkpoint. The complete trigger set requests that checkpoint for action errors, assertion failures, deadlines, Desktop crashes, and task stalls. Screenshot collection remains fail-closed when conversation or credential geometry cannot be proven.

When adding or changing a workflow:

1. Add it to `release.json` with a fresh task ID, sealed input references, stable assertions, meaningful normal checkpoints, and a failure-only screenshot after every action.
2. Add exactly one distinct capability row to `coverage-matrix.json`; copy the identical scenario into `routine.json` only when it belongs in the fast subset.
3. Bind every target in `accessibility-bindings.json` using accessibility roles, descriptions, menu paths, keys, or opaque wait conditions only.
4. Run `npm run check:desktop-smoke`. The fixture suite contract-validates both sets, checks subset identity, and executes every release scenario through deterministic GUI boundaries.
