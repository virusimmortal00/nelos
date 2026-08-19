import { createHash } from "node:crypto";

import {
  REMOTE_DESKTOP_ACTION_TYPES_V1,
  REMOTE_DESKTOP_ASSERTION_TYPES_V1,
  REMOTE_DESKTOP_CHECKPOINT_TYPES_V1,
  validateRemoteDesktopScenarioV1,
} from "nelos/remote-desktop-contract";

export { SealedValueError, SealedValueResolver } from "./sealed-value-resolver.mjs";

const ACTIONS = new Set(REMOTE_DESKTOP_ACTION_TYPES_V1);
const ASSERTIONS = new Set(REMOTE_DESKTOP_ASSERTION_TYPES_V1);
const CHECKPOINTS = new Set(REMOTE_DESKTOP_CHECKPOINT_TYPES_V1);
const BOUNDARY_METHODS = Object.freeze([
  "listTasks", "createFreshTask", "activeTask", "click", "keypress", "scroll", "selectMenu",
  "typeText", "waitFor", "accessibilityTree", "windowState", "queryElement", "taskState",
  "textPresent", "windowCount", "protectedCaptureRegions", "captureScreenshot", "health",
]);
const PROTECTED_REGION_KINDS = Object.freeze(["conversation", "credential"]);

export class DesktopGuiDriverError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "DesktopGuiDriverError";
    this.code = code;
    this.details = details;
  }
}

function assertBoundary(boundary) {
  for (const method of BOUNDARY_METHODS) {
    if (typeof boundary?.[method] !== "function") throw new DesktopGuiDriverError("INVALID_GUI_BOUNDARY", `missing GUI boundary method: ${method}`);
  }
}

function nowIso(clock) {
  return new Date(clock.now()).toISOString();
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sanitizeTree(value) {
  if (Array.isArray(value)) return value.map(sanitizeTree);
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return { digest: digestBytes(Buffer.from(value)), length: Buffer.byteLength(value) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeTree(item)]));
}

function deadline(promise, timeoutMs, code, signal, abortController = null) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new DesktopGuiDriverError(code, "deadline expired"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DesktopGuiDriverError(code, "deadline expired"));
      abortController?.abort();
    }, timeoutMs);
    const onAbort = () => reject(new DesktopGuiDriverError(code, "operation aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

function remaining(started, limit, clock) {
  return Math.max(0, limit - (clock.now() - started));
}

function mapFailure(error, fallback = "ACTION_ERROR") {
  if (error instanceof DesktopGuiDriverError) return error;
  if (["DESKTOP_CRASH", "TASK_STALLED"].includes(error?.code)) {
    return new DesktopGuiDriverError(error.code, error.code === "DESKTOP_CRASH" ? "Desktop crashed" : "Desktop task stalled");
  }
  return new DesktopGuiDriverError(fallback, "GUI boundary operation failed");
}

function validateBindings(bindings) {
  if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) throw new DesktopGuiDriverError("INVALID_BINDINGS", "target bindings must be an object");
  for (const [ref, binding] of Object.entries(bindings)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(ref) || binding === null || typeof binding !== "object" || Array.isArray(binding)) {
      throw new DesktopGuiDriverError("INVALID_BINDINGS", "target binding is invalid");
    }
    const allowed = new Set(["role", "name", "description", "index", "key", "direction", "amount", "menuPath", "condition", "state", "count"]);
    if (Object.keys(binding).some((key) => !allowed.has(key))) throw new DesktopGuiDriverError("FORBIDDEN_BINDING", "binding contains a non-accessibility operation");
    for (const field of ["role", "name", "description", "condition", "state"]) {
      if (binding[field] !== undefined && (typeof binding[field] !== "string" || binding[field].length < 1 || binding[field].length > 256)) {
        throw new DesktopGuiDriverError("INVALID_BINDINGS", "accessibility binding string is invalid");
      }
    }
    if (binding.condition !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(binding.condition)) throw new DesktopGuiDriverError("FORBIDDEN_BINDING", "wait condition must be opaque");
    if (binding.key !== undefined && !["ENTER", "ESCAPE", "TAB", "BACKSPACE", "DELETE", "SPACE", "ARROW_UP", "ARROW_DOWN", "ARROW_LEFT", "ARROW_RIGHT", "PAGE_UP", "PAGE_DOWN", "HOME", "END"].includes(binding.key)) throw new DesktopGuiDriverError("FORBIDDEN_BINDING", "keypress is not allowlisted");
    if (binding.direction !== undefined && !["up", "down", "left", "right"].includes(binding.direction)) throw new DesktopGuiDriverError("INVALID_BINDINGS", "scroll direction is invalid");
    for (const field of ["index", "amount", "count"]) {
      if (binding[field] !== undefined && (!Number.isSafeInteger(binding[field]) || binding[field] < 0 || binding[field] > 100)) throw new DesktopGuiDriverError("INVALID_BINDINGS", "numeric accessibility binding is invalid");
    }
    if (binding.menuPath !== undefined && (!Array.isArray(binding.menuPath) || binding.menuPath.length < 1 || binding.menuPath.length > 8 || binding.menuPath.some((item) => typeof item !== "string" || item.length < 1 || item.length > 128))) throw new DesktopGuiDriverError("INVALID_BINDINGS", "menu path is invalid");
  }
}

export class DesktopGuiScenarioDriver {
  #boundary;
  #resolver;
  #bindings;
  #clock;
  #usedTaskIds = new Set();

  constructor({ boundary, sealedValueResolver, bindings, clock = Date }) {
    assertBoundary(boundary);
    validateBindings(bindings);
    if (typeof sealedValueResolver?.resolve !== "function") throw new DesktopGuiDriverError("INVALID_SEALED_RESOLVER", "sealed value resolver is required");
    this.#boundary = boundary;
    this.#resolver = sealedValueResolver;
    this.#bindings = structuredClone(bindings);
    this.#clock = clock;
  }

  async runScenario(input) {
    let scenario;
    try {
      scenario = validateRemoteDesktopScenarioV1(structuredClone(input));
    } catch (error) {
      throw new DesktopGuiDriverError(ACTIONS.has(input?.actions?.[0]?.type) ? "INVALID_SCENARIO" : "FORBIDDEN_ACTION", "scenario was rejected by the public remote Desktop contract");
    }
    if (scenario.actions.some(({ type }) => !ACTIONS.has(type))) throw new DesktopGuiDriverError("FORBIDDEN_ACTION", "action is not allowlisted");
    const startedMs = this.#clock.now();
    const startedAt = nowIso(this.#clock);
    const result = { scenarioId: scenario.scenarioId, taskId: scenario.task.taskId, startedAt, finishedAt: null, outcome: "failed", failure: null, actions: [], checkpoints: [], assertions: [] };
    const abort = new AbortController();
    let lastAction = null;
    try {
      await deadline(this.#establishFreshTask(scenario, abort.signal), remaining(startedMs, scenario.deadlineMs, this.#clock), "SCENARIO_DEADLINE", abort.signal, abort);
      for (const action of scenario.actions) {
        lastAction = action;
        const scenarioRemaining = remaining(startedMs, scenario.deadlineMs, this.#clock);
        if (scenarioRemaining === 0) throw new DesktopGuiDriverError("SCENARIO_DEADLINE", "scenario deadline expired");
        const actionStartedAt = nowIso(this.#clock);
        let actionError = null;
        try {
          const actionAbort = new AbortController();
          const actionSignal = AbortSignal.any([abort.signal, actionAbort.signal]);
          const timeoutCode = scenarioRemaining <= action.timeoutMs ? "SCENARIO_DEADLINE" : "ACTION_TIMEOUT";
          await deadline(this.#perform(action, actionSignal), Math.min(action.timeoutMs, scenarioRemaining), timeoutCode, abort.signal, actionAbort);
          result.actions.push({ actionId: action.actionId, actionType: action.type, startedAt: actionStartedAt, finishedAt: nowIso(this.#clock), outcome: "succeeded" });
        } catch (error) {
          actionError = mapFailure(error);
          result.actions.push({ actionId: action.actionId, actionType: action.type, startedAt: actionStartedAt, finishedAt: nowIso(this.#clock), outcome: ["ACTION_TIMEOUT", "SCENARIO_DEADLINE"].includes(actionError.code) ? "timed_out" : "failed" });
        }
        if (actionError) {
          try { await this.#collectAfterAction(scenario, action, result, true, abort, startedMs); } catch { /* preserve the primary action failure */ }
          throw actionError;
        }
        await this.#collectAfterAction(scenario, action, result, false, abort, startedMs);
        const health = await deadline(this.#boundary.health({ signal: abort.signal }), remaining(startedMs, scenario.deadlineMs, this.#clock), "SCENARIO_DEADLINE", abort.signal, abort);
        if (health?.crashed) throw new DesktopGuiDriverError("DESKTOP_CRASH", "Desktop crashed");
        if (health?.stalled) throw new DesktopGuiDriverError("TASK_STALLED", "Desktop task stalled");
      }
      if (result.assertions.some(({ passed }) => !passed)) throw new DesktopGuiDriverError("ASSERTION_FAILURE", "one or more allowlisted assertions failed");
      result.outcome = "passed";
    } catch (error) {
      const failure = mapFailure(error);
      const trigger = failureTrigger(failure.code);
      if (lastAction && trigger !== null && scenario.failureCaptureTriggers.includes(trigger) && !abort.signal.aborted) {
        try { await this.#collectAfterAction(scenario, lastAction, result, true, abort, startedMs); } catch { /* failure capture is best-effort except for protected screenshots in the primary path */ }
      }
      abort.abort();
      result.failure = { code: failure.code };
      result.outcome = failure.code.includes("DEADLINE") || failure.code === "ACTION_TIMEOUT" ? "timed_out" : "failed";
    } finally {
      result.finishedAt = nowIso(this.#clock);
    }
    return Object.freeze(result);
  }

  async #establishFreshTask(scenario, signal) {
    const beforeList = await this.#boundary.listTasks({ signal });
    if (!Array.isArray(beforeList)) throw new DesktopGuiDriverError("INVALID_GUI_OBSERVATION", "Desktop task inventory is invalid");
    const before = new Set(beforeList);
    const created = await this.#boundary.createFreshTask({ scenarioId: scenario.scenarioId, signal });
    const afterList = await this.#boundary.listTasks({ signal });
    if (!Array.isArray(afterList)) throw new DesktopGuiDriverError("INVALID_GUI_OBSERVATION", "Desktop task inventory is invalid");
    const after = new Set(afterList);
    const active = await this.#boundary.activeTask({ signal });
    const taskId = created?.taskId;
    const newlyObserved = [...after].filter((candidate) => !before.has(candidate));
    const existingPreserved = [...before].every((candidate) => after.has(candidate));
    if (taskId !== scenario.task.taskId || newlyObserved.length !== 1 || newlyObserved[0] !== taskId || !existingPreserved || active?.taskId !== taskId || this.#usedTaskIds.has(taskId)) {
      throw new DesktopGuiDriverError("REUSED_TASK_IDENTITY", "fresh Desktop task verification failed");
    }
    this.#usedTaskIds.add(taskId);
  }

  #binding(ref) {
    const binding = this.#bindings[ref];
    if (!binding) throw new DesktopGuiDriverError("UNKNOWN_TARGET_REF", "opaque target reference is not bound");
    return structuredClone(binding);
  }

  async #perform(action, signal) {
    const target = this.#binding(action.targetRef);
    switch (action.type) {
      case "click": return this.#boundary.click({ target, signal });
      case "keypress": return this.#boundary.keypress({ target, key: target.key, signal });
      case "scroll": return this.#boundary.scroll({ target, direction: target.direction, amount: target.amount, signal });
      case "select_menu": return this.#boundary.selectMenu({ target, menuPath: target.menuPath, signal });
      case "wait_for": return this.#boundary.waitFor({ target, condition: target.condition, signal });
      case "type_text_ref": {
        const secret = await this.#resolver.resolve(action.valueRef);
        try {
          return await this.#boundary.typeText({ target, bytes: secret.bytes, signal });
        } finally {
          secret.dispose();
        }
      }
      default: throw new DesktopGuiDriverError("FORBIDDEN_ACTION", "action is not allowlisted");
    }
  }

  async #collectAfterAction(scenario, action, result, failed, abort, startedMs) {
    const signal = abort.signal;
    for (const checkpoint of scenario.checkpoints.filter(({ checkpointId, afterActionId, failureOnly }) => afterActionId === action.actionId && (!failureOnly || failed) && !result.checkpoints.some((item) => item.checkpointId === checkpointId))) {
      const checkpointRemaining = remaining(startedMs, scenario.deadlineMs, this.#clock);
      if (checkpointRemaining === 0) throw new DesktopGuiDriverError("SCENARIO_DEADLINE", "scenario deadline expired");
      const captured = await deadline(this.#checkpoint(checkpoint, scenario, signal), checkpointRemaining, "SCENARIO_DEADLINE", signal, abort);
      result.checkpoints.push(captured.record);
      for (const assertion of scenario.assertions.filter(({ checkpointId }) => checkpointId === checkpoint.checkpointId)) {
        const assertionRemaining = remaining(startedMs, scenario.deadlineMs, this.#clock);
        if (assertionRemaining === 0) throw new DesktopGuiDriverError("SCENARIO_DEADLINE", "scenario deadline expired");
        const passed = await deadline(this.#assert(assertion, signal), assertionRemaining, "SCENARIO_DEADLINE", signal, abort);
        result.assertions.push({ assertionId: assertion.assertionId, passed, observedRef: passed ? assertion.expectedRef : null });
      }
    }
  }

  async #checkpoint(checkpoint, scenario, signal) {
    if (!CHECKPOINTS.has(checkpoint.type)) throw new DesktopGuiDriverError("FORBIDDEN_CHECKPOINT", "checkpoint is not allowlisted");
    if (checkpoint.type === "accessibility_tree") {
      const tree = await this.#boundary.accessibilityTree({ signal });
      return { record: { checkpointId: checkpoint.checkpointId, type: checkpoint.type, observation: sanitizeTree(tree) } };
    }
    if (checkpoint.type === "window_state") {
      const state = await this.#boundary.windowState({ signal });
      return { record: { checkpointId: checkpoint.checkpointId, type: checkpoint.type, observation: sanitizeTree(state) } };
    }
    const regions = await this.#boundary.protectedCaptureRegions({ kinds: [...PROTECTED_REGION_KINDS], signal });
    if (!Array.isArray(regions) || PROTECTED_REGION_KINDS.some((kind) => !regions.some((region) => region?.kind === kind && validGeometry(region)))) {
      throw new DesktopGuiDriverError("PROTECTED_GEOMETRY_UNAVAILABLE", "protected screenshot geometry could not be located");
    }
    const image = await this.#boundary.captureScreenshot({ exclude: regions.map(({ kind, x, y, width, height }) => ({ kind, x, y, width, height })), signal });
    const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image);
    try {
      return { record: { checkpointId: checkpoint.checkpointId, type: checkpoint.type, observation: { digest: digestBytes(bytes), byteLength: bytes.length, sanitized: true, scenarioId: scenario.scenarioId } } };
    } finally {
      bytes.fill(0);
    }
  }

  async #assert(assertion, signal) {
    if (!ASSERTIONS.has(assertion.type)) throw new DesktopGuiDriverError("FORBIDDEN_ASSERTION", "assertion is not allowlisted");
    const target = this.#binding(assertion.targetRef);
    switch (assertion.type) {
      case "element_present": return Boolean(await this.#boundary.queryElement({ target, signal }));
      case "element_absent": return !await this.#boundary.queryElement({ target, signal });
      case "task_state": return await this.#boundary.taskState({ target, expected: this.#binding(assertion.expectedRef), signal });
      case "window_count": return (await this.#boundary.windowCount({ target, signal })) === this.#binding(assertion.expectedRef).count;
      case "text_ref_present": {
        const secret = await this.#resolver.resolve(assertion.expectedRef);
        try { return await this.#boundary.textPresent({ target, bytes: secret.bytes, signal }); }
        finally { secret.dispose(); }
      }
      default: return false;
    }
  }
}

function validGeometry(region) {
  return [region.x, region.y, region.width, region.height].every(Number.isFinite) && region.width > 0 && region.height > 0;
}

function failureTrigger(code) {
  if (code === "ASSERTION_FAILURE") return "assertion_failure";
  if (["ACTION_TIMEOUT", "SCENARIO_DEADLINE"].includes(code)) return "deadline_exceeded";
  if (code === "DESKTOP_CRASH") return "desktop_crash";
  if (code === "TASK_STALLED") return "task_stalled";
  return "action_error";
}
