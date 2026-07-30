import { createHash } from "node:crypto";

import {
  RECOMMENDED_SEEDED_TITLE_CHARACTERS,
  buildTaskLaunchPromptV1,
  createTaskResultTemplateV1,
} from "./task-launch-prompt.mjs";
import {
  normalizeLaunchMemberV1,
} from "./launch-contract.mjs";
import { gateLaunchWaveActionV1 } from "./launch-execution-gate.mjs";
import { workUnitDefinitionV1 } from "./execution-store.mjs";
import { workUnitFromLaunchMemberV1 } from "./plan-orchestration-bridge.mjs";
import { planRunLaunchActionIdV1 } from "./plan-run-store.mjs";

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

function memberPrompt(slice, title = slice.title) {
  return buildTaskLaunchPromptV1({
    title,
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

function joinedAgentTaskName(sliceId, planRun) {
  const stem = sliceId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 32) || "task";
  // A joined child cannot be re-routed after it exists.  In particular, an
  // exception replan may reuse a semantic slice ID while requiring a new
  // model/effort route.  Give generation-one work a plan-run-scoped native
  // name so it cannot resolve to the generation-zero child.  Generation zero
  // retains its historic deterministic name for ordinary launch replays.
  if (planRun?.replanGeneration === 1) {
    const suffix = createHash("sha256")
      .update(`${planRun.planRunId}\u0000${sliceId}`, "utf8")
      .digest("hex")
      .slice(0, 12);
    return `nelos_${stem}_replan1_${suffix}`;
  }
  const suffix = createHash("sha256")
    .update(sliceId, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `nelos_${stem}_${suffix}`;
}

function launchMember(
  slice,
  persistedMember = null,
  planRun = null,
  cleanupIntended = true,
) {
  const normalizedLaunch = normalizeLaunchMemberV1({
    ...slice,
    nativeTask: slice.route.launch.nativeTask,
  });
  const { memberKind, launcher } = normalizedLaunch;
  const joinedSubagent = slice.lifecycle === "subagent";
  const title = persistedMember?.title ?? slice.title;
  const member = {
    sliceId: slice.id,
    lifecycle: slice.lifecycle,
    memberKind,
    launcher,
    title,
    objective: slice.objective,
    deliverable: slice.deliverable,
    acceptanceCriteria: [...slice.acceptanceCriteria],
    dependsOn: [...(slice.dependsOn ?? [])],
    titlePolicy: {
      mode: joinedSubagent
        ? "prompt-seeded"
        : "post-bind-read-set-verify",
      recommendedMaxCharacters: RECOMMENDED_SEEDED_TITLE_CHARACTERS,
      verifyAfterLaunch: !joinedSubagent,
      ...(joinedSubagent ? { evidence: "agent-path" } : {}),
      ...(!joinedSubagent
        ? {
            creationTitleSupported: false,
            promptSeedAuthoritative: false,
          }
        : {}),
      onMismatch: joinedSubagent ? "attention" : "native-set-title",
    },
    ...(joinedSubagent
      ? { agentTaskName: joinedAgentTaskName(slice.id, planRun) }
      : {}),
    identityContract: joinedSubagent
      ? {
          lifecycle: "subagent",
          memberKind: "joined-subagent",
          primaryId: "agentPath",
          controlSurface: "collaboration",
          nativeThreadIdUse: "verification-only",
          nativeTitleControl: false,
        }
      : {
          lifecycle: "spinoff",
          memberKind: "spinoff",
          primaryId: "threadId",
          controlSurface: "codex-task",
          nativeThreadIdUse: "control-and-verification",
          nativeTitleControl: true,
        },
    workspaceMode: slice.workspaceMode,
    nativeTask: normalizedLaunch.launch.nativeTask,
    routeEnforcement: {
      mode: "exact",
      onUnavailable: "stop",
      verifyAfterLaunch: true,
    },
    prompt: memberPrompt(slice, title),
  };
  if (joinedSubagent) return member;
  if (!planRun?.webIdentity) {
    throw new Error("durable launch requires a persisted web identity");
  }
  const workUnit = workUnitDefinitionV1(
    workUnitFromLaunchMemberV1(member, {
      webId: planRun.webIdentity.webId,
      queenThreadId: planRun.queenThreadId,
      cleanupIntended,
    }),
  );
  return {
    ...member,
    orchestration: {
      tool: "nelos_orchestrate_create",
      arguments: {
        workUnit,
        receipt: null,
      },
      bindReceiptType: "native-create",
    },
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

export function derivePlanWaveActionV1(
  plan,
  planRun = null,
  waveIndex = plan?.waves?.[0]?.index,
  cleanupIntended = true,
  launchAuthorization = null,
) {
  const currentWave = plan?.waves?.find(
    ({ index }) => index === waveIndex,
  );
  if (!currentWave) {
    throw new Error(`plan has no launchable wave ${waveIndex}`);
  }
  if (!planRun) {
    throw new Error("launch wave requires a persisted plan run");
  }
  const verification = planRun.waves?.find(
    ({ waveIndex }) => waveIndex === currentWave.index,
  );
  if (!verification) {
    throw new Error(
      `plan run ${planRun.planRunId} has no contract for wave ${currentWave.index}`,
    );
  }
  if (
    verification.members.length !== currentWave.slices.length ||
    currentWave.slices.some((slice) => {
      const member = verification.members.find(
        ({ sliceId }) => sliceId === slice.id,
      );
      return (
        !member ||
        member.lifecycle !== slice.lifecycle ||
        member.model !== slice.route.launch.nativeTask.model ||
        member.effort !== slice.route.launch.nativeTask.thinking
      );
    })
  ) {
    throw new Error("launch wave conflicts with its persisted member contract");
  }
  const proposed = action("launch-wave", {
    waveIndex: currentWave.index,
    members: currentWave.slices.map((slice) => ({
      ...launchMember(
        slice,
        verification.members.find(({ sliceId }) => sliceId === slice.id),
        planRun,
        cleanupIntended,
      ),
      ...(slice.lifecycle === "spinoff"
        ? {
            actionId: planRunLaunchActionIdV1({
              planRunId: planRun.planRunId,
              waveIndex: currentWave.index,
              sliceId: slice.id,
            }),
          }
        : {}),
    })),
    verification: {
      planRunId: planRun.planRunId,
      waveIndex: verification.waveIndex,
      waveDigest: verification.waveDigest,
    },
    settleBeforeWaveIndex: currentWave.index + 1,
    remainingWaveCount: plan.waves.filter(
      ({ index }) => index > currentWave.index,
    ).length,
  });
  return gateLaunchWaveActionV1(proposed, launchAuthorization);
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
    case "plan bootstrap":
      return action("launch-planner", {
        member: output.bootstrap.planner,
      });
    case "plan bootstrap review":
      return action("attention", {
        reason: output.bootstrap.reason,
        bootstrapId: output.bootstrap.bootstrapId,
        confidence: output.bootstrap.confidence,
        classificationEvidence: output.bootstrap.classificationEvidence,
      });
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
    case "intelligence resolve subagent":
      return action("verify-route", {
        tool: "nelos_intelligence_verify",
        arguments: {
          threadId: output.threadId,
          model: output.expected.model,
          effort: output.expected.effort,
          turnId: output.turnId,
        },
      });
    case "plan slices":
      return derivePlanWaveActionV1(
        output.plan,
        output.planRun,
        output.plan.waves[0]?.index,
        output.cleanupIntended ?? true,
        output.launchAuthorization ?? null,
      );
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
