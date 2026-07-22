import assert from "node:assert/strict";
import test from "node:test";

import {
  reduceWebOrchestration,
} from "../src/web-orchestration.mjs";

function spec(overrides = {}) {
  return {
    schemaVersion: 1,
    workUnitId: "member-a",
    specRevision: 3,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result", "follow-up", "archive"],
    policy: {
      maxAttempts: 2,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    },
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    workUnitId: "member-a",
    specRevision: 3,
    state: "bound",
    memberThreadId: "task-a",
    launchActionId: "launch-member-a",
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    workUnitId: "member-a",
    specRevision: 3,
    memberThreadId: "task-a",
    lifecycle: "completed",
    latestTurnId: "turn-a1",
    sourceTurnId: "turn-a1",
    ...overrides,
  };
}

function resultEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    workUnitId: "member-a",
    specRevision: 3,
    attempt: 1,
    outcome: "succeeded",
    summary: "The bounded work completed.",
    artifacts: [],
    verification: ["focused verification"],
    blockers: [],
    recoveryHint: null,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    schemaVersion: 1,
    spec: spec(),
    binding: binding(),
    observation: observation(),
    resultEnvelope: resultEnvelope(),
    actionReceipts: [],
    ...overrides,
  };
}

function receiptFor(action) {
  return {
    schemaVersion: 1,
    actionId: action.actionId,
    actionType: action.type,
    workUnitId: action.workUnitId,
    specRevision: action.specRevision,
    attempt: action.attempt,
    memberThreadId: action.preconditions.expectedMemberThreadId,
    sourceTurnId: action.preconditions.expectedSourceTurnId,
  };
}

test("unbound durable work is ready with one stable launch proposal", () => {
  const value = input({
    binding: binding({
      state: "unbound",
      memberThreadId: null,
      launchActionId: null,
    }),
    observation: null,
    resultEnvelope: null,
  });
  const before = structuredClone(value);
  const first = reduceWebOrchestration(value);
  const second = reduceWebOrchestration(value);

  assert.deepEqual(first, second);
  assert.deepEqual(value, before);
  assert.equal(first.workOutcome, "unknown");
  assert.equal(first.orchestrationPhase, "ready");
  assert.equal(first.attentionRequired, false);
  assert.equal(first.proposedActions.length, 1);
  assert.deepEqual(first.proposedActions[0], {
    schemaVersion: 1,
    actionId:
      "web-orchestration-v1/member-a/revision-3/attempt-1/launch",
    type: "launch",
    scope: "work-unit",
    workUnitId: "member-a",
    specRevision: 3,
    attempt: 1,
    requiredCapability: null,
    preconditions: {
      expectedSpecRevision: 3,
      expectedBindingState: "unbound",
      expectedMemberThreadId: null,
      expectedSourceTurnId: null,
    },
  });
  assert.equal(
    new Set(first.proposedActions.map(({ actionId }) => actionId)).size,
    first.proposedActions.length,
  );
});

test("lifecycle and work outcome remain separate deterministic state", () => {
  const cases = [
    {
      name: "waiting",
      value: input({
        observation: observation({
          lifecycle: "waiting",
          latestTurnId: null,
          sourceTurnId: null,
        }),
        resultEnvelope: null,
      }),
      expected: ["unknown", "pending", null, null],
    },
    {
      name: "running",
      value: input({
        observation: observation({
          lifecycle: "running",
          sourceTurnId: null,
        }),
        resultEnvelope: null,
      }),
      expected: ["unknown", "active", null, null],
    },
    {
      name: "succeeded",
      value: input(),
      expected: ["succeeded", "settled", null, null],
    },
    {
      name: "unavailable",
      value: input({
        observation: observation({
          lifecycle: "unavailable",
          latestTurnId: null,
          sourceTurnId: null,
        }),
        resultEnvelope: null,
      }),
      expected: ["unknown", "attention", "unavailable", null],
    },
    {
      name: "archived without a successful result",
      value: input({
        observation: observation({
          lifecycle: "archived",
          latestTurnId: null,
          sourceTurnId: null,
        }),
        resultEnvelope: null,
      }),
      expected: ["unknown", "attention", "archived", null],
    },
    {
      name: "unknown future lifecycle",
      value: input({
        observation: observation({
          lifecycle: "paused-by-server",
          latestTurnId: null,
          sourceTurnId: null,
        }),
        resultEnvelope: null,
      }),
      expected: ["unknown", "attention", "unknown_lifecycle", null],
    },
    {
      name: "completed without a result",
      value: input({ resultEnvelope: null }),
      expected: ["unknown", "attention", "missing_result", "inspect-result"],
    },
    {
      name: "failed transport turn",
      value: input({
        observation: observation({ lifecycle: "failed", sourceTurnId: null }),
        resultEnvelope: null,
      }),
      expected: ["unknown", "attention", "turn_failed", "escalate"],
    },
  ];

  for (const { name, value, expected } of cases) {
    const reduced = reduceWebOrchestration(value);
    assert.deepEqual(
      [
        reduced.workOutcome,
        reduced.orchestrationPhase,
        reduced.attentionReason,
        reduced.proposedActions[0]?.type ?? null,
      ],
      expected,
      name,
    );
  }
});

test("blocked and failed outcomes follow bounded recovery policy", () => {
  const followUpSpec = spec({
    policy: {
      maxAttempts: 2,
      onBlocked: "follow-up",
      onFailure: "follow-up",
    },
  });
  const blockedInput = input({
    spec: followUpSpec,
    resultEnvelope: resultEnvelope({
      outcome: "blocked",
      summary: "A bounded input is missing.",
      blockers: ["fixture mode is unavailable"],
      recoveryHint: "Provide a fixture mode.",
    }),
  });
  const blocked = reduceWebOrchestration(blockedInput);

  assert.equal(blocked.workOutcome, "blocked");
  assert.equal(blocked.orchestrationPhase, "attention");
  assert.equal(blocked.attentionReason, "blocked");
  assert.equal(blocked.proposedActions.length, 1);
  assert.deepEqual(blocked.proposedActions[0].preconditions, {
    expectedSpecRevision: 3,
    expectedBindingState: "bound",
    expectedMemberThreadId: "task-a",
    expectedSourceTurnId: "turn-a1",
  });
  assert.equal(blocked.proposedActions[0].requiredCapability, "follow-up");
  assert.match(
    blocked.proposedActions[0].actionId,
    /^web-orchestration-v1\/member-a\/revision-3\/attempt-1\/follow-up\/context-[A-Za-z0-9_-]{43}$/,
  );

  const failed = reduceWebOrchestration({
    ...blockedInput,
    resultEnvelope: resultEnvelope({
      outcome: "failed",
      summary: "Verification failed.",
      blockers: ["fixture assertion failed"],
      recoveryHint: "Inspect the fixture mismatch.",
    }),
  });
  assert.equal(failed.workOutcome, "failed");
  assert.equal(failed.attentionReason, "failed");
  assert.equal(failed.proposedActions[0].type, "follow-up");

  const exhausted = reduceWebOrchestration({
    ...blockedInput,
    spec: spec({
      attempt: 2,
      policy: {
        maxAttempts: 2,
        onBlocked: "follow-up",
        onFailure: "follow-up",
      },
    }),
    resultEnvelope: resultEnvelope({
      attempt: 2,
      outcome: "blocked",
      summary: "Still blocked.",
      blockers: ["fixture mode is still unavailable"],
      recoveryHint: "Escalate to the queen.",
    }),
  });
  assert.equal(exhausted.workOutcome, "blocked");
  assert.equal(exhausted.attentionReason, "attempts_exhausted");
  assert.equal(exhausted.proposedActions[0].type, "escalate");
});

test("receipts suppress only the exact stable action and reject duplicates", () => {
  const value = input({ resultEnvelope: null });
  const initial = reduceWebOrchestration(value);
  const receipt = receiptFor(initial.proposedActions[0]);
  const reconciled = reduceWebOrchestration({
    ...value,
    actionReceipts: [receipt],
  });

  assert.equal(reconciled.attentionReason, "missing_result");
  assert.deepEqual(reconciled.proposedActions, []);
  assert.deepEqual(
    reduceWebOrchestration({ ...value, actionReceipts: [receipt] }),
    reconciled,
  );

  const duplicate = reduceWebOrchestration({
    ...value,
    actionReceipts: [receipt, structuredClone(receipt)],
  });
  assert.equal(duplicate.attentionReason, "malformed_receipt");
  assert.deepEqual(duplicate.proposedActions, []);

  const staleReceipt = { ...receipt, specRevision: 2 };
  const stale = reduceWebOrchestration({
    ...value,
    actionReceipts: [staleReceipt],
  });
  assert.equal(stale.attentionReason, "malformed_receipt");
  assert.deepEqual(stale.proposedActions, []);
});

test("task action identities stay bounded at maximum identifier lengths", () => {
  const workUnitId = "w".repeat(128);
  const memberThreadId = "t".repeat(256);
  const sourceTurnId = "s".repeat(256);
  const value = input({
    spec: spec({
      workUnitId,
      policy: {
        maxAttempts: 2,
        onBlocked: "follow-up",
        onFailure: "queen-review",
      },
    }),
    binding: binding({ workUnitId, memberThreadId }),
    observation: observation({
      workUnitId,
      memberThreadId,
      latestTurnId: sourceTurnId,
      sourceTurnId,
    }),
    resultEnvelope: resultEnvelope({
      workUnitId,
      outcome: "blocked",
      summary: "Bounded identifiers remain journalable.",
      blockers: ["fixture input is absent"],
      recoveryHint: "Provide the fixture input.",
    }),
  });
  const first = reduceWebOrchestration(value);

  assert.ok(first.proposedActions[0].actionId.length <= 512);
  const reconciled = reduceWebOrchestration({
    ...value,
    actionReceipts: [receiptFor(first.proposedActions[0])],
  });
  assert.deepEqual(reconciled.proposedActions, []);
});

test("malformed and stale joins fail closed without task effects", () => {
  const cases = [
    [
      "stale binding",
      input({ binding: binding({ specRevision: 2 }) }),
      "stale_binding",
    ],
    [
      "stale observation task",
      input({ observation: observation({ memberThreadId: "old-task" }) }),
      "stale_observation",
    ],
    [
      "stale result attempt",
      input({ resultEnvelope: resultEnvelope({ attempt: 2 }) }),
      "stale_result",
    ],
    [
      "malformed result",
      input({
        resultEnvelope: resultEnvelope({
          outcome: "succeeded",
          blockers: ["success cannot have blockers"],
        }),
      }),
      "malformed_result",
    ],
    [
      "unbound observation",
      input({
        binding: binding({
          state: "unbound",
          memberThreadId: null,
          launchActionId: null,
        }),
        resultEnvelope: null,
      }),
      "stale_observation",
    ],
    [
      "ambiguous launch",
      input({
        binding: binding({
          state: "launch-pending",
          memberThreadId: null,
        }),
        observation: null,
        resultEnvelope: null,
      }),
      "ambiguous_launch",
    ],
  ];

  for (const [name, value, attentionReason] of cases) {
    const reduced = reduceWebOrchestration(value);
    assert.equal(reduced.workOutcome, "unknown", name);
    assert.equal(reduced.orchestrationPhase, "attention", name);
    assert.equal(reduced.attentionReason, attentionReason, name);
    assert.deepEqual(reduced.proposedActions, [], name);
  }
});

test("unsupported member capabilities never produce durable task actions", () => {
  const noRead = reduceWebOrchestration(
    input({
      spec: spec({ capabilities: ["observe"] }),
      resultEnvelope: null,
    }),
  );
  assert.equal(noRead.attentionReason, "unsupported_capability");
  assert.deepEqual(noRead.proposedActions, []);

  const noFollowUp = reduceWebOrchestration(
    input({
      spec: spec({
        capabilities: ["observe", "read-result"],
        policy: {
          maxAttempts: 2,
          onBlocked: "follow-up",
          onFailure: "queen-review",
        },
      }),
      resultEnvelope: resultEnvelope({
        outcome: "blocked",
        summary: "Blocked.",
        blockers: ["input unavailable"],
        recoveryHint: "Ask the queen.",
      }),
    }),
  );
  assert.equal(noFollowUp.workOutcome, "blocked");
  assert.equal(noFollowUp.attentionReason, "unsupported_capability");
  assert.deepEqual(noFollowUp.proposedActions, []);

  const joinedUnbound = reduceWebOrchestration(
    input({
      spec: spec({
        memberKind: "joined-subagent",
        capabilities: ["observe"],
      }),
      binding: binding({
        state: "unbound",
        memberThreadId: null,
        launchActionId: null,
      }),
      observation: null,
      resultEnvelope: null,
    }),
  );
  assert.equal(joinedUnbound.attentionReason, "unsupported_capability");
  assert.deepEqual(joinedUnbound.proposedActions, []);
});

test("bounded versioned contracts reject unknown fields and oversized history", () => {
  const unknownSpecField = reduceWebOrchestration(
    input({ spec: { ...spec(), transcript: "not allowed" } }),
  );
  assert.equal(unknownSpecField.attentionReason, "malformed_spec");
  assert.deepEqual(unknownSpecField.proposedActions, []);

  const forwardVersion = reduceWebOrchestration({
    ...input(),
    schemaVersion: 2,
  });
  assert.equal(forwardVersion.attentionReason, "malformed_input");

  const oversizedHistory = reduceWebOrchestration({
    ...input(),
    actionReceipts: Array.from({ length: 101 }, () => ({})),
  });
  assert.equal(oversizedHistory.attentionReason, "malformed_receipt");
  assert.deepEqual(oversizedHistory.proposedActions, []);

  const sparseCapabilities = new Array(1);
  const sparse = reduceWebOrchestration(
    input({ spec: spec({ capabilities: sparseCapabilities }) }),
  );
  assert.equal(sparse.attentionReason, "malformed_spec");
});
