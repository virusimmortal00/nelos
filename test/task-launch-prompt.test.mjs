import assert from "node:assert/strict";
import test from "node:test";

import {
  renderQueenTitle,
  buildTaskLaunchPromptV1,
  createTaskResultTemplateV1,
} from "../src/task-launch-prompt.mjs";

test("queen titles are visibly marked and idempotent", () => {
  assert.equal(renderQueenTitle("Research"), "👑 · Research");
  assert.equal(renderQueenTitle(" 👑 · Research "), "👑 · Research");
  assert.equal(renderQueenTitle("👑 Research"), "👑 · Research");
  assert.equal(
    renderQueenTitle("🕷️ a1 · Release planning"),
    "👑A1 · Release planning",
  );
  const nestedQueen = "👑A1.1 · Contract tests";
  assert.equal(
    renderQueenTitle("🕸️ A1 🕷️ A1.1 · Contract tests"),
    nestedQueen,
  );
  assert.equal(
    renderQueenTitle("👑 · 🕸️ A1 🕷️ A1.1 · Contract tests"),
    nestedQueen,
  );
  assert.equal(
    renderQueenTitle("🕸️ A1 🕷️ A1.1 · 👑 · Contract tests"),
    nestedQueen,
  );
  assert.equal(renderQueenTitle(nestedQueen), nestedQueen);
  assert.throws(
    () => renderQueenTitle("👑"),
    /must include text after the queen marker/,
  );
});

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

test("durable launch prompts require the exact threadId-only Codex host result", () => {
  const value = prompt({
    completionWake: {
      webId: "A4",
      queenThreadId: "queen-thread",
      workUnitId: "alpha",
      specRevision: 1,
      attempt: 1,
    },
  });
  assert.match(value, /codex_app\.send_message_to_thread/u);
  assert.match(value, /receipt: \{"threadId":"queen-thread"\}/u);
  assert.match(value, /Do not add actionId, specRevision/u);
  assert.match(value, /immediately return your final result/u);
  assert.match(value, /Never wait for queen acceptance/u);
});
