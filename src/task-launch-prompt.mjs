export const TASK_TITLE_PROMPT_PREFIX = "Task title:";
export const RECOMMENDED_SEEDED_TITLE_CHARACTERS = 48;
export { QUEEN_TITLE_PREFIX, renderQueenTitle } from "./task-web.mjs";

export function taskTitlePromptLine(title) {
  if (typeof title !== "string" || !title.trim()) {
    throw new Error("task launch title must be a non-empty string");
  }
  return `${TASK_TITLE_PROMPT_PREFIX} ${title.trim()}`;
}

export function buildTaskLaunchPromptV1({
  title,
  objective,
  deliverable,
  acceptanceCriteria,
  resultFence = "nelos-result",
  resultTemplate,
  completionWake = null,
}) {
  if (typeof objective !== "string" || !objective.trim()) {
    throw new Error("task launch objective must be a non-empty string");
  }
  if (typeof deliverable !== "string" || !deliverable.trim()) {
    throw new Error("task launch deliverable must be a non-empty string");
  }
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
    throw new Error("task launch acceptanceCriteria must be non-empty");
  }
  if (!resultTemplate || typeof resultTemplate !== "object" || Array.isArray(resultTemplate)) {
    throw new Error("task launch resultTemplate must be an object");
  }
  const criteria = acceptanceCriteria
    .map((criterion) => `- ${criterion}`)
    .join("\n");
  const wakeInstructions = completionWake
    ? [
        "Before your final response, call `nelos_spinoff_complete`.",
        "Set receipt to null on the first call. Execute the returned effect with",
        "`codex_app.send_message_to_thread`, passing its threadId and prompt unchanged.",
        "That host tool returns only a threadId. Pass its exact result unchanged as",
        `receipt: ${JSON.stringify({ threadId: completionWake.queenThreadId })}.`,
        "Do not add actionId, specRevision, memberThreadId, delivered, type, or turnId.",
        "A reconciliation effect means stop for attention; never resend blindly.",
        "After the exact receipt is acknowledged, immediately return your final result.",
        "Never wait for queen acceptance, coordination, archival, or cleanup; those are queen-owned post-result steps.",
        "Use the outcome and concise summary you will place in the result block,",
        "set memberThreadId to this task's CODEX_THREAD_ID, and use these fixed fields:",
        JSON.stringify(completionWake),
      ]
    : [];
  return [
    taskTitlePromptLine(title),
    "",
    `Own only this slice: ${objective}`,
    `Deliverable: ${deliverable}`,
    "Acceptance criteria:",
    criteria,
    ...wakeInstructions,
    `Finish with exactly one final fenced ${resultFence} block and no trailing prose.`,
    "Use this result shape. Change outcome when needed; succeeded has no blockers, while blocked has at least one blocker and a recoveryHint:",
    `\`\`\`${resultFence}`,
    JSON.stringify(resultTemplate),
    "```",
  ].join("\n");
}

export function createTaskResultTemplateV1({
  workUnitId,
  specRevision,
  attempt,
}) {
  if (typeof workUnitId !== "string" || !workUnitId.trim()) {
    throw new Error("task result template workUnitId must be a non-empty string");
  }
  for (const [field, value] of Object.entries({ specRevision, attempt })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`task result template ${field} must be a positive integer`);
    }
  }
  return {
    schemaVersion: 1,
    workUnitId,
    specRevision,
    attempt,
    outcome: "succeeded",
    summary: "concise result summary",
    artifacts: [],
    verification: [],
    blockers: [],
    recoveryHint: null,
  };
}
