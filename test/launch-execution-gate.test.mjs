import assert from "node:assert/strict";
import test from "node:test";

import { withNextAction } from "../src/next-action.mjs";
import { createPlanRunV1 } from "../src/plan-run-store.mjs";
import { authorizeLaunchProposal } from "./support/launch-authorization-helper.mjs";

function slice(id, lifecycle) {
  const subagent = lifecycle === "subagent";
  return {
    id,
    title: id,
    objective: `Complete ${id}.`,
    deliverable: `${id} result.`,
    acceptanceCriteria: [`${id} is verified.`],
    dependsOn: [],
    lifecycle,
    workspaceMode: subagent ? "shared-read-only" : "isolated-write",
    route: {
      launch: {
        nativeTask: {
          model: subagent ? "gpt-5.6-sol" : "gpt-5.6-terra",
          thinking: subagent ? "medium" : "low",
        },
      },
    },
  };
}

function fixture(lifecycles) {
  const plan = {
    waves: [{
      index: 1,
      slices: lifecycles.map((lifecycle, index) =>
        slice(`slice-${index + 1}`, lifecycle)),
    }],
  };
  const planRun = createPlanRunV1(plan, {
    queenThreadId: "queen-1",
    sourceId: `gate-${lifecycles.join("-")}`,
    webIdentity: lifecycles.includes("spinoff")
      ? {
          schemaVersion: 1,
          webId: "A1",
          queenThreadId: "queen-1",
          queenTitle: "👑 A1 · Queen",
        }
      : null,
  });
  const input = { command: "plan slices", plan, planRun };
  const proposal = withNextAction(input).nextAction;
  return { input, proposal };
}

test("a create-thread wave requires explicit host authorization evidence", () => {
  const { proposal } = fixture(["spinoff"]);
  assert.equal(proposal.kind, "authorization-required");
  assert.equal(proposal.reason, "launch-authorization-evidence-required");
  assert.equal(proposal.members[0].launcher, "create-thread");
  assert.equal(proposal.receiptType, "native-launch-authorization");
  assert.equal(
    proposal.authorizationEffect.tool,
    "nelos_launch_authorize",
  );
  assert.deepEqual(
    proposal.authorizationEffect.requiredHostInputs,
    ["capabilities", "userIntentConfirmed"],
  );
  assert.equal(
    proposal.authorizationEffect.arguments.request.actionId,
    proposal.actionId,
  );
});

test("unavailable create-thread and spawn-subagent launchers fail closed", () => {
  for (const [lifecycle, capability] of [
    ["spinoff", "create-thread"],
    ["subagent", "spawn-subagent"],
  ]) {
    const { input, proposal } = fixture([lifecycle]);
    const receipt = authorizeLaunchProposal(proposal, {
      members: {
        "slice-1": { launcherAvailable: false },
      },
    });
    const action = withNextAction({
      ...input,
      launchAuthorization: receipt,
    }).nextAction;
    assert.deepEqual(action, {
      schemaVersion: 1,
      kind: "execution-unavailable",
      reason: "launch-capability-unavailable",
      actionId: proposal.actionId,
      sliceId: "slice-1",
      launcher: capability,
      capability: "launcher",
    });
  }
});

test("a mixed wave is never partially executable", () => {
  const { input, proposal } = fixture(["spinoff", "subagent"]);
  const receipt = authorizeLaunchProposal(proposal, {
    members: {
      "slice-2": { modelSupported: false },
    },
  });
  const action = withNextAction({
    ...input,
    launchAuthorization: receipt,
  }).nextAction;
  assert.equal(action.kind, "execution-unavailable");
  assert.equal(action.sliceId, "slice-2");
  assert.equal(action.capability, "model");
});

test("exact authorization produces a receipt-bound launch wave and replays", () => {
  const { input, proposal } = fixture(["spinoff", "subagent"]);
  const receipt = authorizeLaunchProposal(proposal);
  const first = withNextAction({
    ...input,
    launchAuthorization: receipt,
  }).nextAction;
  const replay = withNextAction({
    ...input,
    launchAuthorization: structuredClone(receipt),
  }).nextAction;
  assert.equal(first.kind, "launch-wave");
  assert.equal(first.members.length, 2);
  assert.equal(first.executionGate.actionId, proposal.actionId);
  assert.match(first.executionGate.evidenceDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(replay, first);
});

test("unauthorized, stale, mismatched, and free-form evidence cannot launch", () => {
  const { input, proposal } = fixture(["spinoff"]);
  const unauthorized = authorizeLaunchProposal(proposal, {
    members: { "slice-1": { creationAuthorized: false } },
  });
  assert.equal(
    withNextAction({
      ...input,
      launchAuthorization: unauthorized,
    }).nextAction.kind,
    "authorization-required",
  );

  const stale = authorizeLaunchProposal(proposal, {
    waveDigest: "f".repeat(64),
  });
  assert.equal(
    withNextAction({
      ...input,
      launchAuthorization: stale,
    }).nextAction.reason,
    "stale-launch-authorization",
  );

  const mismatched = authorizeLaunchProposal(proposal, {
    members: {
      "slice-1": { workspaceMode: "shared-read-only" },
    },
  });
  assert.equal(
    withNextAction({
      ...input,
      launchAuthorization: mismatched,
    }).nextAction.reason,
    "launch-authorization-member-mismatch",
  );

  const mixed = fixture(["spinoff", "subagent"]);
  const partial = authorizeLaunchProposal(mixed.proposal);
  partial.members.pop();
  assert.equal(
    withNextAction({
      ...mixed.input,
      launchAuthorization: partial,
    }).nextAction.reason,
    "launch-authorization-member-mismatch",
  );

  const freeForm = {
    ...authorizeLaunchProposal(proposal),
    assertion: "The user probably meant to allow this.",
  };
  assert.equal(
    withNextAction({
      ...input,
      launchAuthorization: freeForm,
    }).nextAction.reason,
    "invalid-launch-authorization",
  );
});
