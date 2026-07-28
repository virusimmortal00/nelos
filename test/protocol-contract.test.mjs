import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_PROTOCOL_TOOL_CONTRACTS_V1,
  PROTOCOL_ACTION_SCHEMA_V1,
  PROTOCOL_CODE_REGISTRY_V1,
  PROTOCOL_COMPATIBILITY_ENVELOPE_SCHEMA_V1,
  PROTOCOL_NATIVE_EFFECT_SCHEMA_V1,
  PROTOCOL_RECEIPT_SCHEMA_V1,
  PROTOCOL_SEMANTIC_INPUT_SCHEMA_V1,
  RECOVERY_COMMANDS_V1,
  initialProtocolTransitionStateV1,
  protocolCompatibilityEnvelopeV1,
  protocolValueEnvelopeV1,
  reduceProtocolTransitionV1,
  validateProtocolContractV1,
  validateRecoveryTransitionV1,
} from "../src/protocol-contract/index.mjs";
import { PROTOCOL_MIGRATION_MAP_V1 } from "../src/protocol-contract/migration-map.mjs";
import { listNelosMcpTools } from "../src/mcp-server.mjs";

test("protocol contracts are available through public package subpaths", async () => {
  const contract = await import("nelos/protocol-contract");
  const migration = await import("nelos/protocol-contract/migration-map");

  assert.equal(contract.PROTOCOL_CONTRACT_SCHEMA_VERSION, 1);
  assert.equal(migration.PROTOCOL_MIGRATION_MAP_V1, PROTOCOL_MIGRATION_MAP_V1);
});

function discriminatorValues(schema, field) {
  return schema.oneOf
    .map(({ properties }) => properties[field]?.const)
    .filter(Boolean);
}

test("definitive unions use the repository's emitted discriminators", () => {
  assert.deepEqual(discriminatorValues(PROTOCOL_ACTION_SCHEMA_V1, "kind"), [
    "launch-planner",
    "reconcile-planner-launch",
    "native-wait-subagent",
    "native-read-subagent-result",
    "launch-wave",
    "native-wait-wave",
    "native-wait",
    "native-read",
    "native-follow-up",
    "native-set-title",
    "verify-route",
    "attach-native-task-options",
    "decide",
    "advance-orchestration",
    "cleanup-spinoffs",
    "execute-cli",
    "attention",
    "complete",
  ]);
  assert.deepEqual(discriminatorValues(PROTOCOL_NATIVE_EFFECT_SCHEMA_V1, "type"), [
    "native-create",
    "native-reconcile-create",
    "native-read-title",
    "native-set-title",
    "native-wait",
    "native-read-result",
    "native-send-message",
    "native-reconcile-send-message",
    "native-archive",
    "native-reconcile-archive",
  ]);
  assert.deepEqual(discriminatorValues(PROTOCOL_RECEIPT_SCHEMA_V1, "type"), [
    "native-planner-created",
    "native-planner-result",
    "native-create",
    "native-title-observed",
    "native-wait",
    "native-result-read",
    "native-archive",
  ]);
  assert.equal(
    discriminatorValues(PROTOCOL_ACTION_SCHEMA_V1, "kind").includes("read-planner"),
    false,
  );
});

function example(schema, seed = 0) {
  if (schema.oneOf) return example(schema.oneOf[seed % schema.oneOf.length], seed);
  if (schema.anyOf) return example(schema.anyOf[0], seed);
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (schema.enum) return schema.enum[seed % schema.enum.length];
  if (schema.type === "null") return null;
  if (schema.type === "string") {
    if (schema.pattern === "^[a-f0-9]{64}$") return "a".repeat(64);
    return `value-${seed}`;
  }
  if (schema.type === "integer") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") {
    return Array.from(
      { length: schema.minItems ?? 0 },
      (_, index) => example(schema.items, seed + index),
    );
  }
  if (schema.type === "object") {
    const value = Object.fromEntries(
      (schema.required ?? []).map((key, index) => [
        key,
        example(schema.properties[key], seed + index),
      ]),
    );
    let ordinal = 0;
    while (Object.keys(value).length < (schema.minProperties ?? 0)) {
      const key = `field${ordinal}`;
      if (!Object.hasOwn(value, key)) {
        value[key] =
          schema.additionalProperties &&
          typeof schema.additionalProperties === "object"
            ? example(schema.additionalProperties, seed + ordinal)
            : `value-${seed}-${ordinal}`;
      }
      ordinal += 1;
    }
    return value;
  }
  return null;
}

test("every action, native effect, and receipt union member validates closed", () => {
  for (const [contract, schema] of [
    ["action", PROTOCOL_ACTION_SCHEMA_V1],
    ["effect", PROTOCOL_NATIVE_EFFECT_SCHEMA_V1],
    ["receipt", PROTOCOL_RECEIPT_SCHEMA_V1],
  ]) {
    schema.oneOf.forEach((member, index) => {
      const value = example(member, index + 1);
      let validated;
      try {
        validated = validateProtocolContractV1(contract, value);
      } catch (error) {
        throw new Error(`${contract} union member ${index}: ${error.message}`);
      }
      assert.deepEqual(validated, value);
      assert.throws(
        () => validateProtocolContractV1(contract, {
          ...value,
          widened: true,
        }),
        /exactly one|not allowed/,
      );
    });
  }
});

const launchPlannerOutput = {
  schemaVersion: 1,
  command: "plan lifecycle",
  lifecycle: {
    bootstrapId: "plan:1234567890abcdef12345678",
    revision: 1,
    phase: "launch-pending",
    plannerThreadId: null,
  },
  bootstrap: { bootstrapId: "plan:1234567890abcdef12345678" },
  nextAction: {
    schemaVersion: 1,
    kind: "launch-planner",
    member: {
      sliceId: "planner",
      lifecycle: "subagent",
      memberKind: "joined-subagent",
      launcher: "spawn-subagent",
      agentTaskName: "nelos_planner",
      title: "Planner",
      prompt: "Produce a bounded plan.",
      forkTurns: "none",
    },
  },
};

const verificationOutput = {
  command: "launch verify batch",
  verification: {
    schemaVersion: 1,
    parentThreadId: "queen-1",
    allVerified: true,
    members: [{ sliceId: "member", verified: true }],
  },
  nextAction: {
    schemaVersion: 1,
    kind: "native-wait-wave",
    targets: [{
      sliceId: "member",
      lifecycle: "spinoff",
      memberKind: "spinoff",
      controlSurface: "codex-task",
      primaryId: "threadId",
      threadId: "thread-member",
      turnId: "turn-member",
    }],
    after: "read-results",
  },
};

const createEffect = {
  schemaVersion: 1,
  actionId: "launch-1",
  type: "native-create",
  scope: "work-unit",
  workUnitId: "member",
  specRevision: 1,
  attempt: 1,
  memberKind: "spinoff",
  launcher: "create-thread",
  launch: null,
  title: "Member",
  prompt: "Implement the member.",
  preconditions: {
    expectedSpecRevision: 1,
    expectedBindingState: "unbound",
    expectedMemberThreadId: null,
    expectedSourceTurnId: null,
  },
};

const createOutput = {
  schemaVersion: 1,
  workUnitId: "member",
  specRevision: 1,
  attempt: 1,
  binding: { state: "launch-pending", launchActionId: "launch-1" },
  effects: [createEffect],
};

const waitEffect = {
  schemaVersion: 1,
  type: "native-wait",
  actionId: "wait-1",
  webId: "A1",
  queenThreadId: "queen-1",
  targets: [{
    workUnitId: "member",
    specRevision: 1,
    attempt: 1,
    bindingGeneration: 1,
    memberThreadId: "thread-member",
    hostId: null,
    afterCursor: null,
  }],
};

const advanceOutput = {
  schemaVersion: 1,
  webId: "A1",
  queenThreadId: "queen-1",
  checkpoint: { checkpointRevision: 1 },
  join: {
    schemaVersion: 1,
    effects: [waitEffect],
    boundary: { type: "waiting", reason: "required-members-outstanding" },
  },
};

const decisionOutput = {
  schemaVersion: 1,
  replayed: false,
  decision: { decisionId: "queen-acceptance-v1/member", decision: "accepted" },
  readiness: { readyWorkUnitIds: [], settledWorkUnitIds: ["member"] },
  nextAction: {
    schemaVersion: 1,
    kind: "advance-orchestration",
    tool: "nelos_orchestrate_advance",
    arguments: { webId: "A1", queenThreadId: "queen-1", receipt: null },
  },
};

const sendEffect = {
  schemaVersion: 1,
  actionId: "wake-1",
  type: "native-send-message",
  threadId: "queen-1",
  prompt: "Member completed.",
  preconditions: {
    expectedCallerThreadId: "thread-member",
    expectedBoundMemberThreadId: "thread-member",
  },
};

const completionOutput = {
  schemaVersion: 1,
  replayed: false,
  record: { wakeId: "wake-1", wakeState: "delivering" },
  effects: [sendEffect],
};

const archiveEffect = {
  schemaVersion: 1,
  actionId: "archive-1",
  type: "native-archive",
  threadId: "thread-member",
  archived: true,
  preconditions: {
    expectedQueenThreadId: "queen-1",
    expectedAcceptedWorkUnitId: "member",
  },
};

const cleanupOutput = {
  schemaVersion: 1,
  policy: "ask",
  state: "effects-required",
  results: [{ threadId: "thread-member", state: "archiving", replayed: false }],
  effects: [archiveEffect],
};

const RUNTIME_OUTPUTS = new Map([
  ["nelos_plan_lifecycle", launchPlannerOutput],
  ["nelos_launch_verify_batch", verificationOutput],
  ["nelos_orchestrate_create", createOutput],
  ["nelos_orchestrate_advance", advanceOutput],
  ["nelos_queen_decide", decisionOutput],
  ["nelos_spinoff_complete", completionOutput],
  ["nelos_spinoff_cleanup", cleanupOutput],
]);

test("all seven real MCP output families pass producer-correlated envelopes", () => {
  for (const [producer, output] of RUNTIME_OUTPUTS) {
    const envelope = protocolCompatibilityEnvelopeV1(producer, output);
    assert.equal(envelope.producer, producer);
    assert.deepEqual(envelope.value, output);
    assert.deepEqual(
      validateProtocolContractV1(
        PROTOCOL_COMPATIBILITY_ENVELOPE_SCHEMA_V1,
        envelope,
      ),
      envelope,
    );
    assert.throws(
      () => protocolCompatibilityEnvelopeV1(
        producer,
        { ...output, widened: true },
      ),
      /exactly one|not allowed/,
    );
  }
});

test("compatibility and contract discriminators are correlated to value schemas", () => {
  assert.throws(
    () => protocolCompatibilityEnvelopeV1(
      "nelos_spinoff_cleanup",
      launchPlannerOutput,
    ),
    /exactly one/,
  );
  assert.throws(
    () => protocolValueEnvelopeV1("action", {
      schemaVersion: 1,
      code: "protocol.malformed",
      category: "protocol-error",
      message: "bad",
      recoveryCommand: null,
    }),
    /exactly one/,
  );
  const actionEnvelope = protocolValueEnvelopeV1(
    "action",
    verificationOutput.nextAction,
  );
  assert.equal(actionEnvelope.contract, "action");
  assert.deepEqual(actionEnvelope.value, verificationOutput.nextAction);
});

test("tool argument maps enforce value schemas and property-name bounds", () => {
  const base = {
    schemaVersion: 1,
    kind: "verify-route",
    tool: "nelos_intelligence_verify",
  };
  assert.doesNotThrow(() => validateProtocolContractV1("action", {
    ...base,
    arguments: { threadId: "thread-1", effort: "medium" },
  }));
  assert.throws(
    () => validateProtocolContractV1("action", {
      ...base,
      arguments: { threadId: { nested: "not-allowed" } },
    }),
    /exactly one/,
  );
  assert.throws(
    () => validateProtocolContractV1("action", {
      ...base,
      arguments: { ["x".repeat(65)]: "value" },
    }),
    /exactly one/,
  );
});

test("complete nextAction covers discriminator-only and bounded real variants", () => {
  const variants = [
    { schemaVersion: 1, kind: "complete" },
    {
      schemaVersion: 1,
      kind: "complete",
      state: "exact-native-route-verified",
      threadId: "thread-1",
      turnIds: ["turn-1"],
    },
    {
      schemaVersion: 1,
      kind: "complete",
      state: "no-work-units-ready",
      webId: null,
    },
    {
      schemaVersion: 1,
      kind: "complete",
      state: "integration-ready",
      workUnitIds: ["member-1"],
    },
  ];
  variants.forEach((value) => {
    assert.deepEqual(validateProtocolContractV1("action", value), value);
  });
  assert.throws(
    () => validateProtocolContractV1("action", {
      schemaVersion: 1,
      kind: "complete",
      state: "x".repeat(129),
    }),
    /exactly one/,
  );
});

test("semantic inputs are explicitly bounded and discriminator-correlated", () => {
  const values = [
    {
      schemaVersion: 1,
      type: "coordinated-work-selection",
      suppliedBy: "user",
      value: { coordinated: true, rationale: "Multiple independent streams." },
    },
    {
      schemaVersion: 1,
      type: "genuine-user-supplied-plan-recognition",
      suppliedBy: "queen",
      value: { recognized: true, evidence: ["schemaVersion and slices supplied."] },
    },
    {
      schemaVersion: 1,
      type: "result-acceptance-judgment",
      suppliedBy: "queen",
      value: { decision: "accepted", summary: "Criteria satisfied." },
    },
    {
      schemaVersion: 1,
      type: "cleanup-consent-or-preference",
      suppliedBy: "user",
      value: { choice: "keep", threadIds: ["thread-member"], rememberPolicy: false },
    },
    {
      schemaVersion: 1,
      type: "user-facing-communication",
      suppliedBy: "queen",
      value: { message: "Work completed." },
    },
  ];
  values.forEach((value) => {
    assert.deepEqual(validateProtocolContractV1("semanticInput", value), value);
    assert.throws(
      () => validateProtocolContractV1("semanticInput", {
        ...value,
        value: { ...value.value, extra: true },
      }),
      /exactly one/,
    );
  });
  assert.equal(PROTOCOL_SEMANTIC_INPUT_SCHEMA_V1.oneOf.length, 5);
});

function resultEnvelope() {
  return {
    schemaVersion: 1,
    workUnitId: "member",
    specRevision: 1,
    attempt: 1,
    outcome: "succeeded",
    summary: "Done.",
    artifacts: [],
    verification: [],
    blockers: [],
    recoveryHint: null,
  };
}

function readEffect() {
  return {
    schemaVersion: 1,
    type: "native-read-result",
    actionId: "read-1",
    workUnitId: "member",
    specRevision: 1,
    attempt: 1,
    bindingGeneration: 2,
    memberThreadId: "thread-member",
    requestedTurnId: "turn-7",
  };
}

function readReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "native-result-read",
    actionId: "read-1",
    workUnitId: "member",
    specRevision: 1,
    attempt: 1,
    bindingGeneration: 2,
    memberThreadId: "thread-member",
    requestedTurnId: "turn-7",
    sourceTurnId: "turn-7",
    resultEnvelope: resultEnvelope(),
    ...overrides,
  };
}

test("transition reducer binds full persisted action and all receipt identities", () => {
  const action = readEffect();
  const state = initialProtocolTransitionStateV1([action]);
  const accepted = reduceProtocolTransitionV1(state, action, readReceipt());
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.state.cursor, 1);
  const replay = reduceProtocolTransitionV1(
    accepted.state,
    action,
    readReceipt(),
  );
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(
    reduceProtocolTransitionV1(
      accepted.state,
      { ...action, requestedTurnId: "turn-altered" },
      readReceipt(),
    ).error.code,
    "receipt.conflicting",
  );

  for (const changedAction of [
    { ...action, requestedTurnId: "turn-altered" },
    { ...action, memberThreadId: "thread-altered" },
    { ...action, workUnitId: "other-member" },
  ]) {
    assert.equal(
      reduceProtocolTransitionV1(state, changedAction, readReceipt()).error.code,
      "receipt.conflicting",
    );
  }
  for (const changedReceipt of [
    readReceipt({ actionId: "other-action" }),
    readReceipt({ workUnitId: "other-member" }),
    readReceipt({ memberThreadId: "thread-altered" }),
    readReceipt({ requestedTurnId: "turn-altered" }),
    readReceipt({ sourceTurnId: "turn-altered" }),
    readReceipt({ bindingGeneration: 3 }),
  ]) {
    assert.equal(
      reduceProtocolTransitionV1(state, action, changedReceipt).accepted,
      false,
    );
  }
});

test("transition initialization accepts only explicit receipt-consuming executables", () => {
  assert.throws(
    () => initialProtocolTransitionStateV1([{
      schemaVersion: 1,
      kind: "decide",
      operation: "author-slice-plan",
    }]),
    /not a receipt-consuming transition executable/,
  );
  assert.throws(
    () => initialProtocolTransitionStateV1([launchPlannerOutput.nextAction]),
    /not a receipt-consuming transition executable/,
  );
  assert.throws(
    () => initialProtocolTransitionStateV1([{
      schemaVersion: 1,
      type: "native-reconcile-send-message",
      actionId: "wake-1/reconcile",
      originalActionId: "wake-1",
      threadId: "queen-1",
      policy: {
        onFound: "return-exact-send-message-host-result",
        onAbsent: "return-attention-before-retry",
        onAmbiguous: "return-attention",
      },
    }]),
    /not a receipt-consuming transition executable/,
  );

  const plannerRead = {
    schemaVersion: 1,
    kind: "native-read-subagent-result",
    actionId: "planner-read-1",
    agentPath: "/root/planner",
    threadId: "planner-thread",
    turnId: "planner-turn",
    purpose: "read-planner-result",
  };
  const state = initialProtocolTransitionStateV1([plannerRead]);
  assert.equal(
    reduceProtocolTransitionV1(state, plannerRead, {
      schemaVersion: 1,
      type: "native-planner-result",
      actionId: "planner-read-1",
      bootstrapId: "plan:1234567890abcdef12345678",
      threadId: "planner-thread",
      turnId: "planner-turn",
      response: "```nelos-plan\n{}\n```",
    }).accepted,
    true,
  );
});

test("wait target identity and thread-only wake receipts are exact", () => {
  const waitState = initialProtocolTransitionStateV1([waitEffect]);
  const waitReceipt = {
    schemaVersion: 1,
    type: "native-wait",
    actionId: "wait-1",
    webId: "A1",
    queenThreadId: "queen-1",
    status: "event",
    targets: [{
      workUnitId: "member",
      specRevision: 1,
      attempt: 1,
      bindingGeneration: 1,
      memberThreadId: "thread-member",
      hostId: null,
      afterCursor: null,
      nextCursor: "cursor-1",
      lifecycle: "running",
      latestTurnId: "turn-1",
      attentionRequired: false,
    }],
  };
  assert.equal(
    reduceProtocolTransitionV1(waitState, waitEffect, waitReceipt).accepted,
    true,
  );
  assert.equal(
    reduceProtocolTransitionV1(
      waitState,
      waitEffect,
      {
        ...waitReceipt,
        targets: [{
          ...waitReceipt.targets[0],
          memberThreadId: "other-thread",
        }],
      },
    ).accepted,
    false,
  );

  const wakeState = initialProtocolTransitionStateV1([sendEffect]);
  assert.equal(
    reduceProtocolTransitionV1(
      wakeState,
      sendEffect,
      { threadId: "queen-1" },
    ).accepted,
    true,
  );
  assert.equal(
    reduceProtocolTransitionV1(
      wakeState,
      sendEffect,
      { threadId: "other-queen" },
    ).accepted,
    false,
  );
});

test("transition rejects stale, duplicated, cross-action, and out-of-order receipts", () => {
  const first = readEffect();
  const second = { ...readEffect(), actionId: "read-2", requestedTurnId: "turn-8" };
  const state = initialProtocolTransitionStateV1([first, second]);
  const outOfOrder = reduceProtocolTransitionV1(
    state,
    second,
    readReceipt({
      actionId: "read-2",
      requestedTurnId: "turn-8",
      sourceTurnId: "turn-8",
    }),
  );
  assert.equal(outOfOrder.error.code, "protocol.out-of-order-receipt");
  const consumed = reduceProtocolTransitionV1(state, first, readReceipt());
  assert.equal(consumed.accepted, true);
  assert.equal(
    reduceProtocolTransitionV1(
      consumed.state,
      first,
      readReceipt({ sourceTurnId: "different-turn" }),
    ).error.code,
    "receipt.stale",
  );
  assert.equal(
    reduceProtocolTransitionV1(
      consumed.state,
      second,
      readReceipt(),
    ).error.code,
    "receipt.duplicate",
  );
  assert.equal(
    reduceProtocolTransitionV1(
      state,
      first,
      readReceipt({ actionId: "read-2" }),
    ).error.code,
    "receipt.cross-action",
  );
});

test("registry and forbidden recovery transitions remain centralized", () => {
  const categories = new Set(
    Object.values(PROTOCOL_CODE_REGISTRY_V1).map(({ category }) => category),
  );
  assert.equal(categories.size, 6);
  for (const declaration of Object.values(PROTOCOL_CODE_REGISTRY_V1)) {
    assert.ok(
      declaration.recoveryCommand === null ||
      RECOVERY_COMMANDS_V1.includes(declaration.recoveryCommand),
    );
  }
  assert.equal(validateRecoveryTransitionV1({
    schemaVersion: 1,
    code: "protocol.malformed",
    category: "protocol-error",
    message: "Malformed.",
    recoveryCommand: null,
  }, "retry-read").accepted, false);
});

test("listed MCP producers advertise the shared compatibility envelope", () => {
  const listed = new Map(listNelosMcpTools().map((tool) => [tool.name, tool]));
  for (const producer of RUNTIME_OUTPUTS.keys()) {
    assert.deepEqual(
      listed.get(producer)._meta["nelos/protocolContract"],
      {
        schemaVersion: 1,
        compatibilityEnvelope: "ProtocolCompatibilityEnvelopeV1",
      },
    );
    assert.deepEqual(
      MCP_PROTOCOL_TOOL_CONTRACTS_V1[producer],
      {
        schemaVersion: 1,
        compatibilityEnvelope: "ProtocolCompatibilityEnvelopeV1",
      },
    );
  }
});

test("migration map preserves downstream compatibility adapters", () => {
  assert.ok(PROTOCOL_MIGRATION_MAP_V1.length >= 10);
  PROTOCOL_MIGRATION_MAP_V1.forEach((entry) => {
    assert.ok(entry.skillClause);
    assert.ok(entry.enforcingContract);
    assert.ok(entry.compatibilityAdapter);
  });
});
