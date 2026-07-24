import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskLaunchPromptV1,
  createTaskResultTemplateV1,
} from "../src/task-launch-prompt.mjs";

function prompt(overrides = {}) {
  return buildTaskLaunchPromptV1({
    title: "Alpha",
    objective: "Implement alpha.",
    deliverable: "Source and tests.",
    acceptanceCriteria: ["Tests pass."],
    resultTemplate: createTaskResultTemplateV1({
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
    }),
    ...overrides,
  });
}

test("task launch prompts reject missing objectives and deliverables", () => {
  assert.throws(
    () => prompt({ objective: " " }),
    /objective must be a non-empty string/,
  );
  assert.throws(
    () => prompt({ deliverable: "" }),
    /deliverable must be a non-empty string/,
  );
});

test("the shared task result template preserves launch identity", () => {
  const template = createTaskResultTemplateV1({
    workUnitId: "alpha",
    specRevision: 2,
    attempt: 3,
  });
  assert.deepEqual(
    {
      workUnitId: template.workUnitId,
      specRevision: template.specRevision,
      attempt: template.attempt,
    },
    { workUnitId: "alpha", specRevision: 2, attempt: 3 },
  );
  assert.match(prompt(), /"workUnitId":"alpha"/u);
});
