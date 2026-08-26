import { createHash } from "node:crypto";

import {
  DESKTOP_SMOKE_ACTION_TYPES_V1,
  DESKTOP_SMOKE_ASSERTION_TYPES_V1,
  DESKTOP_SMOKE_CHECKPOINT_TYPES_V1,
  validateDesktopSmokeCaptureRegionsV1,
  validateDesktopSmokeScenarioV1,
} from "../desktop-smoke-contract.mjs";

export { SealedValueError, SealedValueResolver } from "./sealed-value-resolver.mjs";

const ACTIONS = new Set(DESKTOP_SMOKE_ACTION_TYPES_V1);
const ASSERTIONS = new Set(DESKTOP_SMOKE_ASSERTION_TYPES_V1);
const CHECKPOINTS = new Set(DESKTOP_SMOKE_CHECKPOINT_TYPES_V1);
const BOUNDARY_METHODS = Object.freeze([
  "listTasks", "activateExpectedTask", "activeTask", "click", "keypress", "scroll", "selectMenu",
  "typeText", "waitFor", "accessibilityTree", "windowState", "queryElement", "taskState",
  "textPresent", "windowCount", "protectedCaptureRegions", "captureScreenshot", "health",
]);
const PROTECTED_REGION_KINDS = Object.freeze(["conversation", "credential"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function supportedImageBytes(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
      bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).toString("ascii") === "IHDR" &&
      bytes.readUInt32BE(bytes.length - 12) === 0 && bytes.subarray(bytes.length - 8, bytes.length - 4).toString("ascii") === "IEND") return true;
  return bytes.length >= 32 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
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
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(new DesktopGuiDriverError(code, "deadline expired"));
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DesktopGuiDriverError(code, "operation aborted")); return; }
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

  async cleanupSealedValues(valueRefs, options = {}) {
    if (typeof this.#resolver.cleanup !== "function") throw new DesktopGuiDriverError("INVALID_SEALED_RESOLVER", "sealed value resolver cannot attest terminal absence");
    return this.#resolver.cleanup(structuredClone(valueRefs), options);
  }

  async runScenario(input, { beforeAction = null, afterAction = null, hardDeadlineAt = null } = {}) {
    if (beforeAction !== null && typeof beforeAction !== "function") throw new DesktopGuiDriverError("INVALID_SCENARIO_HOOK", "before-action observer must be a function");
    if (afterAction !== null && typeof afterAction !== "function") throw new DesktopGuiDriverError("INVALID_SCENARIO_HOOK", "after-action observer must be a function");
    const hardDeadline = hardDeadlineAt === null ? null : Date.parse(hardDeadlineAt);
    if (hardDeadlineAt !== null && !Number.isFinite(hardDeadline)) throw new DesktopGuiDriverError("INVALID_SCENARIO_HOOK", "absolute run deadline is invalid");
    let scenario;
    try {
      scenario = validateDesktopSmokeScenarioV1(structuredClone(input));
    } catch (error) {
      const requestedActions = Array.isArray(input?.actions) ? input.actions : [];
      const hasForbiddenAction = requestedActions.some((action) => !ACTIONS.has(action?.type));
      throw new DesktopGuiDriverError(hasForbiddenAction ? "FORBIDDEN_ACTION" : "INVALID_SCENARIO", "scenario was rejected by the disposable Desktop smoke contract");
    }
    if (scenario.actions.some(({ type }) => !ACTIONS.has(type))) throw new DesktopGuiDriverError("FORBIDDEN_ACTION", "action is not allowlisted");
    const startedMs = this.#clock.now();
    const startedAt = nowIso(this.#clock);
    const result = { scenarioId: scenario.scenarioId, taskId: scenario.task.taskId, startedAt, finishedAt: null, outcome: "failed", failure: null, actions: [], checkpoints: [], assertions: [] };
    const abort = new AbortController();
    let lastAction = null;
    const hardRemaining = () => hardDeadline === null ? Number.MAX_SAFE_INTEGER : Math.max(0, hardDeadline - this.#clock.now());
    const boundedRemaining = () => Math.min(remaining(startedMs, scenario.deadlineMs, this.#clock), hardRemaining());
    const deadlineCode = () => hardRemaining() <= remaining(startedMs, scenario.deadlineMs, this.#clock) ? "RUN_DEADLINE_EXPIRED" : "SCENARIO_DEADLINE";
    try {
      if (hardRemaining() === 0) throw new DesktopGuiDriverError("RUN_DEADLINE_EXPIRED", "production run deadline expired before GUI task activation");
      await deadline(this.#establishFreshTask(scenario, abort.signal), boundedRemaining(), deadlineCode(), abort.signal, abort);
      for (const action of scenario.actions) {
        lastAction = action;
        const scenarioRemaining = remaining(startedMs, scenario.deadlineMs, this.#clock);
        const runRemaining = hardRemaining();
        if (runRemaining === 0) throw new DesktopGuiDriverError("RUN_DEADLINE_EXPIRED", "production run deadline expired before the next GUI action");
        if (scenarioRemaining === 0) throw new DesktopGuiDriverError("SCENARIO_DEADLINE", "scenario deadline expired");
        const actionStartedAt = nowIso(this.#clock);
        const actionLimitMs = Math.min(action.timeoutMs, scenarioRemaining, runRemaining);
        const actionDeadlineAt = this.#clock.now() + actionLimitMs;
        const actionTimeoutCode = runRemaining <= Math.min(action.timeoutMs, scenarioRemaining)
          ? "RUN_DEADLINE_EXPIRED" : scenarioRemaining <= action.timeoutMs ? "SCENARIO_DEADLINE" : "ACTION_TIMEOUT";
        const actionRemaining = () => Math.max(0, actionDeadlineAt - this.#clock.now());
        const actionAbort = new AbortController();
        const actionSignal = AbortSignal.any([abort.signal, actionAbort.signal]);
        let actionError = null;
        try {
          await deadline(this.#verifyActiveTaskBeforeSubmit(action, scenario, actionSignal), actionRemaining(), actionTimeoutCode, abort.signal, actionAbort);
          if (beforeAction !== null) {
            const hookRemaining = actionRemaining();
            if (hookRemaining === 0) throw new DesktopGuiDriverError(actionTimeoutCode, "deadline expired before the pre-action observer");
            await deadline(beforeAction({ action: structuredClone(action), scenarioId: scenario.scenarioId, taskId: scenario.task.taskId, signal: actionSignal }), hookRemaining, actionTimeoutCode, abort.signal, actionAbort);
          }
          if (actionRemaining() === 0) throw new DesktopGuiDriverError(actionTimeoutCode, "deadline expired at the model-submit boundary");
          await deadline(this.#perform(action, actionSignal), actionRemaining(), actionTimeoutCode, abort.signal, actionAbort);
          result.actions.push({ actionId: action.actionId, actionType: action.type, startedAt: actionStartedAt, finishedAt: nowIso(this.#clock), outcome: "succeeded" });
        } catch (error) {
          actionError = mapFailure(error);
          result.actions.push({ actionId: action.actionId, actionType: action.type, startedAt: actionStartedAt, finishedAt: nowIso(this.#clock), outcome: ["ACTION_TIMEOUT", "SCENARIO_DEADLINE"].includes(actionError.code) ? "timed_out" : "failed" });
        }
        if (actionError) {
          if (actionError.code !== "RUN_DEADLINE_EXPIRED") {
            try { await this.#collectAfterAction(scenario, action, result, true, abort, startedMs, hardDeadline); } catch { /* preserve the primary action failure */ }
          }
          throw actionError;
        }
        if (afterAction !== null) {
          const hookRemaining = actionRemaining();
          if (hookRemaining === 0) throw new DesktopGuiDriverError(actionTimeoutCode, "deadline expired before the post-action observer");
          await deadline(afterAction({ action: structuredClone(action), scenarioId: scenario.scenarioId, taskId: scenario.task.taskId, signal: actionSignal }), hookRemaining, actionTimeoutCode, abort.signal, actionAbort);
        }
        actionAbort.abort();
        if (hardRemaining() === 0) throw new DesktopGuiDriverError("RUN_DEADLINE_EXPIRED", "production run deadline expired after the GUI action");
        await this.#collectAfterAction(scenario, action, result, false, abort, startedMs, hardDeadline);
        const healthRemaining = boundedRemaining(); const healthDeadlineCode = deadlineCode();
        if (healthRemaining === 0) throw new DesktopGuiDriverError(healthDeadlineCode, "deadline expired before the Desktop health observation");
        const health = await deadline(this.#boundary.health({ signal: abort.signal }), healthRemaining, healthDeadlineCode, abort.signal, abort);
        if (health?.crashed) throw new DesktopGuiDriverError("DESKTOP_CRASH", "Desktop crashed");
        if (health?.stalled) throw new DesktopGuiDriverError("TASK_STALLED", "Desktop task stalled");
      }
      const executedAssertionIds = new Set(result.assertions.map(({ assertionId }) => assertionId));
      if (result.assertions.some(({ passed }) => !passed) || scenario.assertions.some(({ assertionId }) => !executedAssertionIds.has(assertionId))) {
        throw new DesktopGuiDriverError("ASSERTION_FAILURE", "one or more allowlisted assertions failed or did not execute");
      }
      result.outcome = "passed";
    } catch (error) {
      const failure = mapFailure(error);
      const trigger = failureTrigger(failure.code);
      if (failure.code !== "RUN_DEADLINE_EXPIRED" && lastAction && trigger !== null && scenario.failureCaptureTriggers.includes(trigger) && !abort.signal.aborted) {
        try { await this.#collectAfterAction(scenario, lastAction, result, true, abort, startedMs, hardDeadline); } catch { /* failure capture is best-effort except for protected screenshots in the primary path */ }
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
    const activated = await this.#boundary.activateExpectedTask({ scenarioId: scenario.scenarioId, taskId: scenario.task.taskId, title: scenario.scenarioId, signal });
    const afterList = await this.#boundary.listTasks({ signal });
    if (!Array.isArray(afterList)) throw new DesktopGuiDriverError("INVALID_GUI_OBSERVATION", "Desktop task inventory is invalid");
    const after = new Set(afterList);
    const active = await this.#boundary.activeTask({ signal });
    const taskId = activated?.taskId;
    const existingPreserved = [...before].every((candidate) => after.has(candidate));
    if (taskId !== scenario.task.taskId || !before.has(taskId) || !after.has(taskId) || !existingPreserved || active?.taskId !== taskId || activated?.createdForScenario !== scenario.scenarioId || activated?.fresh !== true || this.#usedTaskIds.has(taskId)) {
      throw new DesktopGuiDriverError("REUSED_TASK_IDENTITY", "pre-created fresh task activation and identity verification failed");
    }
    this.#usedTaskIds.add(taskId);
  }

  #binding(ref) {
    const binding = this.#bindings[ref];
    if (!binding) throw new DesktopGuiDriverError("UNKNOWN_TARGET_REF", "opaque target reference is not bound");
    return structuredClone(binding);
  }

  async #verifyActiveTaskBeforeSubmit(action, scenario, signal) {
    if (action.type !== "keypress" || this.#binding(action.targetRef).key !== "ENTER") return;
    const active = await this.#boundary.activeTask({ signal });
    if (active?.taskId !== scenario.task.taskId) {
      throw new DesktopGuiDriverError("TASK_IDENTITY_CHANGED", "active Desktop task changed before the model-submit boundary");
    }
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

  async #collectAfterAction(scenario, action, result, failed, abort, startedMs, hardDeadline) {
    const signal = abort.signal;
    const boundedRemaining = () => Math.min(
      remaining(startedMs, scenario.deadlineMs, this.#clock),
      hardDeadline === null ? Number.MAX_SAFE_INTEGER : Math.max(0, hardDeadline - this.#clock.now()),
    );
    const deadlineCode = () => hardDeadline !== null && hardDeadline - this.#clock.now() <= remaining(startedMs, scenario.deadlineMs, this.#clock)
      ? "RUN_DEADLINE_EXPIRED" : "SCENARIO_DEADLINE";
    for (const checkpoint of scenario.checkpoints.filter(({ checkpointId, afterActionId, failureOnly }) => afterActionId === action.actionId && (!failureOnly || failed) && !result.checkpoints.some((item) => item.checkpointId === checkpointId))) {
      const checkpointRemaining = boundedRemaining();
      const checkpointDeadlineCode = deadlineCode();
      if (checkpointRemaining === 0) throw new DesktopGuiDriverError(checkpointDeadlineCode, "GUI checkpoint deadline expired");
      const captured = await deadline(this.#checkpoint(checkpoint, scenario, signal), checkpointRemaining, checkpointDeadlineCode, signal, abort);
      if (boundedRemaining() === 0) throw new DesktopGuiDriverError(deadlineCode(), "GUI checkpoint deadline expired");
      result.checkpoints.push(captured.record);
      for (const assertion of scenario.assertions.filter(({ checkpointId }) => checkpointId === checkpoint.checkpointId)) {
        const assertionRemaining = boundedRemaining();
        const assertionDeadlineCode = deadlineCode();
        if (assertionRemaining === 0) throw new DesktopGuiDriverError(assertionDeadlineCode, "GUI assertion deadline expired");
        const passed = await deadline(this.#assert(assertion, signal), assertionRemaining, assertionDeadlineCode, signal, abort);
        if (boundedRemaining() === 0) throw new DesktopGuiDriverError(deadlineCode(), "GUI assertion deadline expired");
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
    const proof = await this.#boundary.protectedCaptureRegions({ kinds: [...PROTECTED_REGION_KINDS], signal });
    let regions;
    try { regions = validateDesktopSmokeCaptureRegionsV1(proof); }
    catch {
      throw new DesktopGuiDriverError("PROTECTED_GEOMETRY_UNAVAILABLE", "protected screenshot geometry could not be located");
    }
    const image = await this.#boundary.captureScreenshot({
      exclude: regions.map(({ kind, x, y, width, height }) => ({ kind, x, y, width, height })),
      expectedTask: { taskId: scenario.task.taskId, title: scenario.scenarioId },
      signal,
    });
    const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image);
    try {
      if (!supportedImageBytes(bytes)) throw new DesktopGuiDriverError("INVALID_GUI_OBSERVATION", "screenshot bytes are empty, truncated, or unsupported");
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
      case "task_state": return Boolean(await this.#boundary.taskState({ target, expected: this.#binding(assertion.expectedRef), signal }));
      case "window_count": return (await this.#boundary.windowCount({ target, signal })) === this.#binding(assertion.expectedRef).count;
      case "text_ref_present": {
        const secret = await this.#resolver.resolve(assertion.expectedRef);
        try { return Boolean(await this.#boundary.textPresent({ target, bytes: secret.bytes, signal })); }
        finally { secret.dispose(); }
      }
      default: return false;
    }
  }
}

function failureTrigger(code) {
  if (code === "ASSERTION_FAILURE") return "assertion_failure";
  if (["ACTION_TIMEOUT", "SCENARIO_DEADLINE"].includes(code)) return "deadline_exceeded";
  if (code === "DESKTOP_CRASH") return "desktop_crash";
  if (code === "TASK_STALLED") return "task_stalled";
  return "action_error";
}
