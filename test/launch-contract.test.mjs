import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLaunchMemberV1,
  normalizeNativeLaunchV1,
} from "../src/launch-contract.mjs";

test("joined-subagent launch contracts reject legacy model IDs at the shared boundary", () => {
  const launch = {
    workspaceMode: "shared-read-only",
    nativeTask: { model: "gpt-5.6-luna", thinking: "low" },
  };
  assert.throws(
    () => normalizeNativeLaunchV1(launch, "joined-subagent"),
    /joined-subagent launches do not support gpt-5\.6-luna/,
  );
  assert.throws(
    () =>
      normalizeLaunchMemberV1({
        lifecycle: "subagent",
        memberKind: "joined-subagent",
        ...launch,
      }),
    /joined-subagent launches do not support gpt-5\.6-luna/,
  );
});

test("joined subagents and durable tasks accept GPT-6 Sol and Luna", () => {
  for (const model of ["gpt-6-sol", "gpt-6-luna"]) {
    assert.equal(
      normalizeNativeLaunchV1(
        {
          workspaceMode: "shared-read-only",
          nativeTask: { model, thinking: "low" },
        },
        "joined-subagent",
      ).nativeTask.model,
      model,
    );
  }
  assert.equal(
    normalizeNativeLaunchV1(
      {
        workspaceMode: "isolated-write",
        nativeTask: { model: "gpt-6-luna", thinking: "low" },
      },
      "spinoff",
    ).nativeTask.model,
    "gpt-6-luna",
  );
});
