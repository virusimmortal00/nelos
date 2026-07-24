export const TASK_TITLE_PROMPT_PREFIX = "Task title:";
export const RECOMMENDED_SEEDED_TITLE_CHARACTERS = 48;

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
}) {
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
    throw new Error("task launch acceptanceCriteria must be non-empty");
  }
  if (!resultTemplate || typeof resultTemplate !== "object" || Array.isArray(resultTemplate)) {
    throw new Error("task launch resultTemplate must be an object");
  }
  const criteria = acceptanceCriteria
    .map((criterion) => `- ${criterion}`)
    .join("\n");
  return [
    taskTitlePromptLine(title),
    "",
    `Own only this slice: ${objective}`,
    `Deliverable: ${deliverable}`,
    "Acceptance criteria:",
    criteria,
    `Finish with exactly one final fenced ${resultFence} block and no trailing prose.`,
    "Use this result shape. Change outcome when needed; succeeded has no blockers, while blocked has at least one blocker and a recoveryHint:",
    `\`\`\`${resultFence}`,
    JSON.stringify(resultTemplate),
    "```",
  ].join("\n");
}
