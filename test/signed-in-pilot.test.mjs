import assert from "node:assert/strict";
import test from "node:test";

import {
  expandExperimentPlan,
  validateRunnerManifest,
} from "../src/experiment-runner.mjs";
import {
  createSignedInPilotManifest,
  PILOT_FAMILIES,
} from "../scripts/build-signed-in-pilot.mjs";
import {
  parseCodexJsonl,
  parseContainerStats,
  parseProcessTime,
} from "../src/signed-in-pilot-telemetry.mjs";

const D = `sha256:${"a".repeat(64)}`;

function manifest() {
  return createSignedInPilotManifest({
    sourceCommit: "b".repeat(40),
    imageDigest: D,
    image: "nelos-codex-pilot:test",
    evidenceDirectory: "/tmp/nelos-pilot-test-evidence",
  });
}

test("signed-in pilot seals five strata into identical product-default repeat arms", () => {
  const input = manifest();
  validateRunnerManifest(input);
  const plan = expandExperimentPlan(input);
  assert.equal(input.tasks.length, PILOT_FAMILIES.length);
  assert.equal(plan.trials.length, 20);
  assert.deepEqual([...new Set(plan.trials.map(({ runtime }) => runtime.platform))], ["linux-arm64"]);
  assert.deepEqual([...new Set(plan.trials.map(({ adapter }) => adapter))], ["direct-codex"]);
  assert.deepEqual([...new Set(plan.trials.map(({ candidateProvenance }) => candidateProvenance.model.id))], ["model:product-default"]);
  assert.deepEqual([...new Set(plan.trials.map(({ budget }) => JSON.stringify(budget)))].length, 1);
  assert.equal(input.experiment.candidates.every(({ plugins }) => plugins.length === 0), true);
  assert.equal(input.tasks.every(({ prompt }) => prompt.text.includes("family followed by :verified")), true);
  assert.equal(Object.keys(input.adapters["direct-codex"].environment).some((name) => /AUTH|TOKEN|SECRET|CREDENTIAL/u.test(name)), false);
});

test("signed-in adapter reduces Codex JSONL and resource output without retaining text", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "sensitive-session-id" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "secret command" } }),
    JSON.stringify({ type: "item.failed", item: { type: "mcp_tool_call", error: "secret error" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } }),
  ].join("\n"));
  assert.deepEqual(parsed, {
    eventCounts: { "item.completed": 1, "item.failed": 1, "thread.started": 1, "turn.completed": 1 },
    inputTokens: 11,
    cachedInputTokens: 3,
    outputTokens: 5,
    reasoningOutputTokens: 2,
    toolCalls: 2,
    toolFailures: 1,
  });
  assert.deepEqual(parseProcessTime("noise\nNELOS_TIME user_seconds=1.25 system_seconds=0.75 max_rss_kb=2048\n"), { cpuMs: 2000, peakMemoryBytes: 2097152 });
  assert.deepEqual(parseContainerStats(JSON.stringify({ NetIO: "1.5kB / 2MB", BlockIO: "3MB / 500kB" })), { networkBytes: 2001500, diskBytes: 3500000 });
});
