import {
  RECOMMENDED_SEEDED_TITLE_CHARACTERS,
  buildTaskLaunchPromptV1,
  createTaskResultTemplateV1,
} from "./task-launch-prompt.mjs";

export const NEXT_ACTION_SCHEMA_VERSION = 1;

function action(kind, fields = {}) {
  return Object.freeze({
    schemaVersion: NEXT_ACTION_SCHEMA_VERSION,
    kind,
    ...fields,
  });
}

function isActiveTurn(turn) {
  const status = String(turn?.status?.type ?? turn?.status ?? "")
    .replaceAll(/[_\s-]/g, "")
    .toLowerCase();
  return ["inprogress", "running", "active", "queued", "pending"].includes(status);
}

function waitForTask(threadId, turnId = null) {
  return action("native-wait", {
    threadIds: [threadId],
    ...(turnId ? { turnIds: [turnId] } : {}),
    after: "read-result",
  });
}

function readTaskResult(threadId, turnId = null) {
  return action("native-read", {
    threadId,
    ...(turnId ? { turnId } : {}),
    purpose: "read-result",
  });
}

function memberPrompt(slice) {
  return buildTaskLaunchPromptV1({
    title: slice.title,
    objective: slice.objective,
    deliverable: slice.deliverable,
    acceptanceCriteria: slice.acceptanceCriteria,
    resultTemplate: createTaskResultTemplateV1({
      workUnitId: slice.id,
      specRevision: 1,
      attempt: 1,
    }),
  });
}

function launchMember(slice) {
  return {
    sliceId: slice.id,
    lifecycle: slice.lifecycle,
    title: slice.title,
    titlePolicy: {
      mode: "prompt-seeded",
      recommendedMaxCharacters: RECOMMENDED_SEEDED_TITLE_CHARACTERS,
      verifyAfterLaunch: true,
      onMismatch: "native-set-title",
    },
    workspaceMode: slice.workspaceMode,
    nativeTask: slice.route.launch.nativeTask,
    routeEnforcement: {
      mode: "exact",
      onUnavailable: "stop",
      verifyAfterLaunch: true,
    },
    prompt: memberPrompt(slice),
  };
}

function correctionPrompt(member) {
  const result = member.result;
  const identity = result
    ? `Preserve workUnitId ${result.workUnitId} and specRevision ${result.specRevision}; use attempt ${result.attempt + 1}.`
    : "Return a valid current result envelope for this same assigned slice.";
  const blockers = result?.blockers?.length
    ? ` Resolve these blockers: ${result.blockers.join("; ")}.`
    : "";
  return [
    `Correct the prior task result: ${member.attentionReason}.`,
    identity + blockers,
    "Finish with exactly one valid final nelos-result block and no trailing prose.",
  ].join(" ");
}

function launchWave(plan) {
  const currentWave = plan.waves[0];
  return action("launch-wave", {
    waveIndex: currentWave.index,
    members: currentWave.slices.map(launchMember),
    settleBeforeWaveIndex: currentWave.index + 1,
    remainingWaveCount: plan.waves.length - 1,
  });
}

function webCollectionAction(output) {
  const nonterminal = output.members
    .filter((member) => !["completed", "failed"].includes(member.transportStatus))
    .map((member) => member.threadId);
  if (nonterminal.length > 0) {
    return action("native-wait", {
      threadIds: nonterminal,
      after: "web-collect",
      webId: output.webId,
    });
  }
  if (output.allSucceeded) {
    return action("decide", {
      operation: "accept-current-results",
      webId: output.webId,
      members: output.members.map((member) => ({
        threadId: member.threadId,
        sourceTurnId: member.sourceTurnId ?? null,
        workUnitId: member.result?.workUnitId ?? null,
        result: member.result ?? null,
      })),
    });
  }
  const correctable = output.members.filter(
    (member) =>
      member.attentionRequired &&
      ["completed", "failed"].includes(member.transportStatus) &&
      member.threadId,
  );
  if (correctable.length > 0) {
    return action("native-follow-up", {
      members: correctable.map((member) => ({
        threadId: member.threadId,
        prompt: correctionPrompt(member),
      })),
      after: "web-collect",
      webId: output.webId,
    });
  }
  return action("attention", {
    reason: "collection-needs-fresh-evidence",
    webId: output.webId,
    members: output.members
      .filter((member) => member.attentionRequired)
      .map((member) => member.threadId),
  });
}

function webReadinessAction(output) {
  const readiness = output.command === "web accept" ? output.readiness : output;
  const readyWorkUnitIds = readiness?.readyWorkUnitIds ?? [];
  if (readyWorkUnitIds.length > 0) {
    return action("attention", {
      reason: "work-units-ready-for-launch",
      webId: readiness.webId,
      workUnitIds: readyWorkUnitIds,
    });
  }
  return action("complete", {
    state: "no-work-units-ready",
    webId: readiness?.webId ?? null,
  });
}

function threadAction(output, { readWhenTerminal = false } = {}) {
  if (!output.threadId) return action("complete");
  if (isActiveTurn(output.latestTurn) || output.detached === true) {
    return waitForTask(output.threadId, output.turnId ?? output.latestTurn?.id ?? null);
  }
  if (readWhenTerminal || output.latestTurn?.id) {
    return readTaskResult(output.threadId, output.latestTurn?.id ?? null);
  }
  return action("complete");
}

/**
 * Attach one explicit next step to every successful CLI response. `decide` is
 * deliberate: commands provide protocol and safe execution parameters, while
 * a model retains only semantic decisions such as authoring slices. `attention`
 * means the command has no safe automatic action from its current evidence.
 */
export function deriveNextAction(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return action("complete");
  }

  switch (output.command) {
    case "intelligence route":
      return output.route
        ? action("attach-native-task-options", {
            nativeTask: output.route.launch.nativeTask,
            routeEnforcement: {
              mode: "exact",
              onUnavailable: "stop",
              verifyAfterLaunch: true,
            },
          })
        : action("decide", { operation: "author-slice-plan" });
    case "intelligence verify":
      return output.verified
        ? action("complete", {
            state: "exact-native-route-verified",
            threadId: output.threadId,
            turnIds: output.observed.map((turn) => turn.turnId),
          })
        : action("attention", {
            reason: "exact-native-route-mismatch",
            threadId: output.threadId,
            expected: output.expected,
            observed: output.observed,
          });
    case "plan slices":
      return launchWave(output.plan);
    case "web begin":
    case "web join":
      return output.requiresNativeTitleSync
        ? action("native-set-title", {
            threadId: output.threadId,
            title: output.renderedTitle,
            verify: true,
          })
        : action("complete");
    case "web collect":
      return webCollectionAction(output);
    case "web readiness":
    case "web accept":
      return webReadinessAction(output);
    case "start":
    case "spinoff":
    case "send":
    case "status":
      return threadAction(output);
    case "read":
    case "watch":
      return isActiveTurn(output.latestTurn)
        ? waitForTask(output.threadId, output.latestTurn?.id ?? null)
        : action("complete");
    case "worktree launch":
      return output.task?.threadId
        ? threadAction(output.task)
        : action("complete");
    case "worktree integration": {
      const pending = output.entries
        .filter((entry) => !entry.ready && entry.memberThreadId)
        .map((entry) => entry.memberThreadId);
      if (pending.length > 0) {
        return action("native-wait", {
          threadIds: pending,
          after: "worktree-integration",
        });
      }
      return output.readyCount > 0
        ? action("complete", {
            state: "integration-ready",
            workUnitIds: output.entries.filter((entry) => entry.ready).map((entry) => entry.workUnitId),
          })
        : action("complete");
    }
    case "worktree plan":
      return action("execute-cli", {
        command: "worktree provision",
        actionId: output.worktree.actionId,
        worktreePath: output.worktree.worktreePath,
        branch: output.worktree.branch,
        requiredInputs: ["sourcePath", "baseRevision", "ownerTaskId"],
      });
    case "worktree provision":
      return action("complete");
    case "list":
    case "archive":
    case "title set":
    case "title get":
      return action("complete");
    default:
      return output.ok === false
        ? action("attention", { reason: "diagnostic-failed" })
        : action("complete");
  }
}

export function withNextAction(output) {
  return {
    ...output,
    nextAction: deriveNextAction(output),
  };
}
