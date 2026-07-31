import { contractFailure, errorContext } from "./errors.mjs";
import { sealRecord } from "./revision.mjs";
import { appendJsonPointer } from "./canonical-json.mjs";

function normalizedTransitions(transitions) {
  if (transitions instanceof Map) {
    return new Map(
      [...transitions].map(([state, targets]) => [
        state,
        Array.isArray(targets)
          ? [...targets]
          : targets instanceof Set
            ? new Set(targets)
            : targets,
      ]),
    );
  }
  if (
    transitions === null ||
    typeof transitions !== "object" ||
    Array.isArray(transitions)
  ) {
    throw new TypeError("lifecycle transitions must be an object or Map");
  }
  return new Map(
    Object.entries(transitions).map(([state, next]) => [
      state,
      new Set(next),
    ]),
  );
}

export function createLifecycle({
  contractKind,
  transitions,
  terminalStates = [],
  stateField = "state",
}) {
  const graph = normalizedTransitions(transitions);
  const terminals = new Set(terminalStates);
  if (
    typeof contractKind !== "string" ||
    contractKind.length === 0 ||
    graph.size === 0
  ) {
    throw new TypeError("lifecycle configuration is invalid");
  }
  for (const [state, targets] of graph) {
    if (
      typeof state !== "string" ||
      state.length === 0 ||
      (!Array.isArray(targets) && !(targets instanceof Set))
    ) {
      throw new TypeError("lifecycle transition entries are invalid");
    }
    const normalized = new Set(targets);
    if (
      [...normalized].some(
        (target) => typeof target !== "string" || target.length === 0,
      )
    ) {
      throw new TypeError("lifecycle transition targets are invalid");
    }
    graph.set(state, normalized);
  }
  for (const terminal of terminals) {
    if (typeof terminal !== "string" || terminal.length === 0 || graph.has(terminal)) {
      throw new TypeError("terminal lifecycle states are invalid");
    }
  }
  for (const targets of graph.values()) {
    for (const target of targets) {
      if (!graph.has(target) && !terminals.has(target)) {
        throw new TypeError("lifecycle transition target is undeclared");
      }
    }
  }

  return function transition(record, nextState, options = {}) {
    const ctx = { ...errorContext(options), contractKind };
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record)
    ) {
      contractFailure("invalid_type", "lifecycle record must be an object", {
        path: "",
        ...ctx,
      });
    }
    const current = record[stateField];
    if (!graph.has(current) && !terminals.has(current)) {
      contractFailure("unknown_lifecycle_state", "current state is not declared", {
        path: appendJsonPointer("", stateField),
        ...ctx,
      });
    }
    if (terminals.has(current)) {
      contractFailure(
        "terminal_transition",
        "terminal lifecycle records cannot transition",
        { path: appendJsonPointer("", stateField), ...ctx },
      );
    }
    if (!graph.get(current).has(nextState)) {
      contractFailure(
        "unauthorized_transition",
        "requested lifecycle transition is not declared",
        { path: appendJsonPointer("", stateField), ...ctx },
      );
    }
    return sealRecord({ ...structuredClone(record), [stateField]: nextState }, ctx);
  };
}

export function transitionLifecycle(record, nextState, configuration) {
  return createLifecycle(configuration)(record, nextState, configuration);
}
