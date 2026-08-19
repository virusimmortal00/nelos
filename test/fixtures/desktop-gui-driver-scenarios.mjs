export const desktopGuiBindings = Object.freeze({
  "new-task-button": { role: "push button", name: "New task" },
  "task-composer": { role: "text", description: "Message composer" },
  "task-menu": { role: "menu button", name: "Task options", menuPath: ["View", "Details"] },
  "task-scroll": { role: "scroll pane", direction: "down", amount: 3 },
  "submit-key": { role: "text", description: "Message composer", key: "ENTER" },
  "task-ready": { role: "status", condition: "task-ready" },
  "active-task": { role: "frame", name: "Codex" },
  "task-complete": { role: "status", state: "complete" },
  "visible-window": { role: "frame", name: "Codex" },
  "one-window": { role: "application", count: 1 },
});

export function desktopGuiScenario({ scenarioId = "scenario-driver-1", taskId = "desktop-task-driver-1", deadlineMs = 1_000 } = {}) {
  return {
    schemaVersion: 1,
    scenarioId,
    task: { taskId, createdForScenario: scenarioId, fresh: true },
    actions: [
      { actionId: "menu", type: "select_menu", targetRef: "task-menu", valueRef: null, timeoutMs: 100 },
      { actionId: "type", type: "type_text_ref", targetRef: "task-composer", valueRef: "prompt-one", timeoutMs: 100 },
      { actionId: "wait", type: "wait_for", targetRef: "task-ready", valueRef: null, timeoutMs: 100 },
    ],
    checkpoints: [
      { checkpointId: "tree", type: "accessibility_tree", afterActionId: "menu", failureOnly: false },
      { checkpointId: "shot", type: "screenshot", afterActionId: "type", failureOnly: false },
      { checkpointId: "windows", type: "window_state", afterActionId: "wait", failureOnly: false },
    ],
    assertions: [
      { assertionId: "present", type: "element_present", targetRef: "active-task", expectedRef: null, checkpointId: "tree" },
      { assertionId: "state", type: "task_state", targetRef: "active-task", expectedRef: "task-complete", checkpointId: "shot" },
      { assertionId: "count", type: "window_count", targetRef: "visible-window", expectedRef: "one-window", checkpointId: "windows" },
    ],
    deadlineMs,
    failureCaptureTriggers: ["action_error", "assertion_failure", "deadline_exceeded", "desktop_crash", "task_stalled"],
  };
}
