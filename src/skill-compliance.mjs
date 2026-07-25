function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedRuntimeRoute(nativeTask) {
  return {
    model: nativeTask?.model ?? null,
    effort: nativeTask?.thinking ?? null,
  };
}

function exactRouteWasVerified(events, launch, member) {
  if (member.routeEnforcement?.verifyAfterLaunch !== true) return true;
  if (!launch.threadId) return false;
  const expected = expectedRuntimeRoute(member.nativeTask);
  return events.some(
    (event) =>
      event.type === "native-route-verification" &&
      event.threadId === launch.threadId &&
      event.verified === true &&
      sameJson(event.expected, expected) &&
      Array.isArray(event.observed) &&
      event.observed.length > 0 &&
      event.observed.every(
        (turn) =>
          turn.matches === true &&
          turn.model === expected.model &&
          turn.effort === expected.effort,
      ),
  );
}

function hasExactMembers(events, action) {
  const launches = events.filter((event) => event.type === "native-launch");
  return action.members.every((member) =>
    launches.some(
      (launch) =>
        launch.lifecycle === member.lifecycle &&
        launch.title === member.title &&
        launch.workspaceMode === member.workspaceMode &&
        launch.prompt === member.prompt &&
        sameJson(launch.nativeTask, member.nativeTask) &&
        sameJson(launch.routeEnforcement, member.routeEnforcement) &&
        exactRouteWasVerified(events, launch, member),
    ),
  );
}

function exactPlannerWasLaunched(events, action) {
  const member = action.member;
  const launch = events.find(
    (event) =>
      event.type === "native-launch" &&
      event.lifecycle === member.lifecycle &&
      event.title === member.title &&
      event.workspaceMode === member.workspaceMode &&
      event.prompt === member.prompt &&
      event.forkTurns === member.forkTurns &&
      sameJson(event.nativeTask, member.nativeTask) &&
      sameJson(event.routeEnforcement, member.routeEnforcement),
  );
  return Boolean(
    launch?.threadId &&
    member.threadIdentity?.required === true &&
    exactRouteWasVerified(events, launch, member),
  );
}

function actionWasExecuted(events, action) {
  switch (action.kind) {
    case "native-set-title":
      return events.some(
        (event) =>
          event.type === "native-title" &&
          event.threadId === action.threadId &&
          event.title === action.title &&
          event.verify === action.verify,
      );
    case "launch-wave":
      return hasExactMembers(events, action);
    case "launch-planner":
      return exactPlannerWasLaunched(events, action);
    case "reconcile-planner-launch":
      return events.some(
        (event) =>
          event.type === "native-launch-reconciliation" &&
          event.createActionId === action.createActionId &&
          event.actionId === action.actionId,
      );
    case "verify-route":
      return events.some(
        (event) =>
          event.type === "native-route-verification" &&
          event.threadId === action.arguments.threadId &&
          event.verified === true &&
          sameJson(event.expected, {
            model: action.arguments.model,
            effort: action.arguments.effort,
          }),
      );
    case "native-wait":
      return events.some(
        (event) =>
          event.type === "native-wait" &&
          sameJson(event.threadIds, action.threadIds) &&
          (action.turnIds === undefined || sameJson(event.turnIds, action.turnIds)),
      );
    case "native-read":
      return events.some(
        (event) =>
          event.type === "native-read" &&
          event.threadId === action.threadId &&
          (action.turnId === undefined || event.turnId === action.turnId),
      );
    case "native-follow-up":
      return action.members.every((member) =>
        events.some(
          (event) =>
            event.type === "native-follow-up" &&
            event.threadId === member.threadId &&
            event.prompt === member.prompt,
        ),
      );
    case "attach-native-task-options":
      return events.some(
        (event) => event.type === "native-launch" && sameJson(event.nativeTask, action.nativeTask),
      );
    case "decide":
      return events.some(
        (event) => event.type === "judgment" && event.operation === action.operation,
      );
    case "execute-cli":
      return events.some(
        (event) => event.type === "cli-command" && event.command === action.command,
      );
    case "complete":
    case "attention":
      return true;
    default:
      return false;
  }
}

/**
 * Evaluate a bounded agent transcript against the one native task-management
 * path. Fixtures use tool-level events rather than prose so they assert the
 * actions an agent actually attempted.
 */
export function evaluateSkillTraceV1(trace) {
  if (!trace || typeof trace !== "object" || !Array.isArray(trace.events)) {
    return [{ code: "malformed_trace" }];
  }

  const violations = [];
  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index];
    if (!event || typeof event !== "object") {
      violations.push({ code: "malformed_event", index });
      continue;
    }
    if (
      event.type === "cli-command" &&
      Array.isArray(event.args) &&
      event.args.includes("--socket")
    ) {
      violations.push({ code: "standalone_transport", index });
    }
    if (event.type !== "cli-output") continue;
    const nextAction = event.output?.nextAction;
    if (!nextAction || typeof nextAction !== "object") {
      violations.push({ code: "missing_next_action", index });
      continue;
    }
    const subsequentEvents = trace.events.slice(index + 1);
    if (!actionWasExecuted(subsequentEvents, nextAction)) {
      violations.push({
        code: "next_action_not_executed",
        index,
        kind: nextAction.kind,
      });
    }
  }
  return violations;
}
