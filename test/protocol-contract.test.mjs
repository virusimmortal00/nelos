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
import { createPlanningBootstrapV1 } from "../src/planning-bootstrap.mjs";
import {
  deriveNextAction,
  derivePlanWaveActionV1,
} from "../src/next-action.mjs";
import { createPlanRunV1 } from "../src/plan-run-store.mjs";

test("protocol contracts are available through public package subpaths", async () => {
  const contract = await import("nelos/protocol-contract");
  const migration = await import("nelos/protocol-contract/migration-map");

  assert.equal(contract.PROTOCOL_CONTRACT_SCHEMA_VERSION, 1);
  assert.equal(migration.PROTOCOL_MIGRATION_MAP_V1, PROTOCOL_MIGRATION_MAP_V1);
});

function discriminatorValues(schema, field) {
  return [...new Set(schema.oneOf
    .map(({ properties }) => properties[field]?.const)
    .filter(Boolean))];
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
    if (schema.pattern === "^plan:[a-f0-9]{24}$") {
      return `plan:${"a".repeat(24)}`;
    }
    if (schema.pattern?.startsWith("^/")) return "/root/planner";
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

test("reconciliation success policies are correlated to native effect types", () => {
  const policies = new Map([
    ["native-reconcile-create", "return-native-create-receipt"],
    [
      "native-reconcile-send-message",
      "return-exact-send-message-host-result",
    ],
    ["native-reconcile-archive", "return-native-archive-receipt"],
  ]);

  for (const [type, onFound] of policies) {
    const schema = PROTOCOL_NATIVE_EFFECT_SCHEMA_V1.oneOf.find(
      ({ properties }) => properties.type?.const === type,
    );
    const effect = example(schema);
    assert.equal(effect.policy.onFound, onFound);
    assert.deepEqual(validateProtocolContractV1("effect", effect), effect);
    assert.throws(
      () => validateProtocolContractV1("effect", {
        ...effect,
        policy: {
          ...effect.policy,
          onFound: "return-wrong-receipt",
        },
      }),
      /exactly one/,
    );
  }
});

test("work-unit identifiers use the canonical orchestration identifier shape", () => {
  assert.throws(
    () => validateProtocolContractV1("effect", {
      ...createEffect,
      workUnitId: "not valid",
    }),
    /exactly one/,
  );
});

test("planner interrupted-turn reconciliation evidence is closed and typed", () => {
  const action = {
    schemaVersion: 1,
    kind: "native-wait-subagent",
    actionId: "wait-1",
    agentPath: "/root/planner",
    threadId: "thread-planner",
    turnId: "turn-planner",
    after: "repeat-planner-launch-receipt",
    reconciliation: {
      reason: "planner-turn-observation-conflict",
      retryable: true,
      appServerTurnStatus: "interrupted",
      nativeCollaborationStatus: "unavailable",
      observation: 1,
      maximumObservations: 1,
    },
  };

  assert.deepEqual(validateProtocolContractV1("action", action), action);
  assert.throws(
    () => validateProtocolContractV1("action", {
      ...action,
      reconciliation: {
        ...action.reconciliation,
        appServerTurnStatus: "failed",
      },
    }),
    /exactly one/,
  );
  assert.throws(
    () => validateProtocolContractV1("action", {
      ...action,
      reconciliation: {
        ...action.reconciliation,
        widened: true,
      },
    }),
    /exactly one|not allowed/,
  );
});

const plannerBootstrapFixture = createPlanningBootstrapV1({
  objective: "Produce a bounded plan.",
  maxParallel: 2,
  bootstrapId: "plan:1234567890abcdef12345678",
});
const cliPlannerAction = deriveNextAction({
  command: "plan bootstrap",
  bootstrap: plannerBootstrapFixture,
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
      ...plannerBootstrapFixture.planner,
      actionId:
        "planning-lifecycle-v1/plan:1234567890abcdef12345678/launch",
      preconditions: {
        bootstrapId: "plan:1234567890abcdef12345678",
        expectedPhase: "launch-pending",
        expectedParentThreadId: "queen-1",
      },
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
  assert.deepEqual(
    validateProtocolContractV1("action", cliPlannerAction),
    cliPlannerAction,
  );
  const largePlannerBootstrap = createPlanningBootstrapV1({
    objective: "o".repeat(8_000),
    context: "c".repeat(16_000),
    maxParallel: 2,
    bootstrapId: "plan:aaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const largePlannerAction = deriveNextAction({
    command: "plan bootstrap",
    bootstrap: largePlannerBootstrap,
  });
  assert.ok(largePlannerAction.member.prompt.length > 8_192);
  assert.deepEqual(
    validateProtocolContractV1("action", largePlannerAction),
    largePlannerAction,
  );
  const largePlannerReceipt = {
    schemaVersion: 1,
    type: "native-planner-result",
    actionId: "planner-read-1",
    bootstrapId: "plan:aaaaaaaaaaaaaaaaaaaaaaaa",
    threadId: "thread-planner",
    turnId: "turn-planner",
    response: "r".repeat(96_000),
  };
  assert.deepEqual(
    validateProtocolContractV1("receipt", largePlannerReceipt),
    largePlannerReceipt,
  );
  const plannerCreatedReceipt = {
    schemaVersion: 1,
    type: "native-planner-created",
    actionId: "planner-launch-1",
    bootstrapId: "plan:aaaaaaaaaaaaaaaaaaaaaaaa",
    parentThreadId: "queen-1",
    agentPath: "/root/planner",
  };
  assert.deepEqual(
    validateProtocolContractV1("receipt", plannerCreatedReceipt),
    plannerCreatedReceipt,
  );
  for (const overrides of [
    { bootstrapId: "bad" },
    { agentPath: "planner" },
    { parentThreadId: "queen 1" },
  ]) {
    assert.throws(
      () => validateProtocolContractV1("receipt", {
        ...plannerCreatedReceipt,
        ...overrides,
      }),
      /exactly one/,
    );
  }
  assert.throws(
    () => validateProtocolContractV1("receipt", {
      ...largePlannerReceipt,
      response: "   \n\t",
    }),
    /exactly one/,
  );
  assert.throws(
    () => validateProtocolContractV1("effect", {
      ...readEffect(),
      actionId: "read 1",
    }),
    /exactly one/,
  );

  const subagentWait = {
    ...verificationOutput.nextAction,
    targets: [{
      sliceId: "member",
      lifecycle: "subagent",
      memberKind: "joined-subagent",
      controlSurface: "collaboration",
      primaryId: "agentPath",
      agentPath: "/root/member",
      threadId: "thread-member",
      turnId: "turn-member",
    }],
  };
  assert.deepEqual(
    validateProtocolContractV1("action", subagentWait),
    subagentWait,
  );
  assert.throws(
    () => validateProtocolContractV1("action", {
      ...verificationOutput.nextAction,
      targets: [{
        ...verificationOutput.nextAction.targets[0],
        agentPath: "/root/member",
      }],
    }),
    /exactly one/,
  );

  assert.throws(
    () => validateProtocolContractV1("action", {
      schemaVersion: 1,
      kind: "launch-planner",
      member: Object.fromEntries(
        Array.from({ length: 18 }, (_, index) => [`field${index}`, index]),
      ),
    }),
    /exactly one/,
  );

  const routeMismatch = deriveNextAction({
    command: "intelligence verify",
    threadId: "thread-1",
    expected: { model: "gpt-5.6-terra", effort: "low" },
    observed: [{
      turnId: "turn-1",
      model: "gpt-5.6-sol",
      effort: "medium",
      matches: false,
    }],
    verified: false,
  });
  assert.deepEqual(
    validateProtocolContractV1("action", routeMismatch),
    routeMismatch,
  );

  const acceptedDecision = {
    schemaVersion: 1,
    kind: "decide",
    operation: "accept-current-results",
    webId: "A1",
    members: [{
      threadId: "thread-member",
      sourceTurnId: "turn-member",
      workUnitId: "member",
      result: resultEnvelope(),
    }],
  };
  assert.deepEqual(
    validateProtocolContractV1("action", acceptedDecision),
    acceptedDecision,
  );
  assert.throws(
    () => validateProtocolContractV1("action", {
      ...acceptedDecision,
      members: [{ a: 1, b: 2, c: 3, d: 4 }],
    }),
    /exactly one/,
  );

  const slice = (overrides = {}) => ({
    id: "research",
    title: "Research",
    objective: "Resolve the bounded question.",
    deliverable: "Return an evidence-backed answer.",
    acceptanceCriteria: ["The answer is verified."],
    lifecycle: "subagent",
    workspaceMode: "shared-read-only",
    route: {
      launch: {
        nativeTask: { model: "gpt-5.6-sol", thinking: "medium" },
      },
    },
    ...overrides,
  });
  const plan = {
    waves: [{
      index: 1,
      slices: [
        slice(),
        slice({
          id: "implement",
          title: "Implement",
          lifecycle: "spinoff",
          workspaceMode: "isolated-write",
        }),
      ],
    }],
  };
  const planRun = createPlanRunV1(plan, {
    queenThreadId: "queen-1",
    sourceId: "protocol-contract-test",
    webIdentity: {
      schemaVersion: 1,
      webId: "A1",
      queenThreadId: "queen-1",
      queenTitle: "👑 A1 · Queen",
    },
  });
  const launchWave = derivePlanWaveActionV1(plan, planRun);
  assert.deepEqual(
    validateProtocolContractV1("action", launchWave),
    launchWave,
  );
  const unreadableSpinoffWave = structuredClone(launchWave);
  const unreadableSpinoff = unreadableSpinoffWave.members.find(
    ({ lifecycle }) => lifecycle === "spinoff",
  );
  unreadableSpinoff.orchestration.arguments.workUnit.capabilities = [
    "observe",
    "follow-up",
    "archive",
  ];
  assert.throws(
    () => validateProtocolContractV1("action", unreadableSpinoffWave),
    /exactly one/,
  );
  assert.throws(
    () => validateProtocolContractV1("action", {
      ...launchWave,
      members: [Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => [`field${index}`, index]),
      )],
    }),
    /exactly one/,
  );

  const lifecycleWithEvidence = {
    ...launchPlannerOutput,
    identity: {
      parentThreadId: "queen-1",
      agentPath: "/root/planner",
      threadId: "thread-planner",
    },
    route: { verified: true },
    thread: { threadId: "thread-planner", status: "idle" },
    latestTurn: null,
    queenTitleSync: {
      schemaVersion: 1,
      threadId: "queen-1",
      changed: false,
    },
  };
  assert.deepEqual(
    protocolCompatibilityEnvelopeV1(
      "nelos_plan_lifecycle",
      lifecycleWithEvidence,
    ).value,
    lifecycleWithEvidence,
  );
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
    (error) => {
      assert.match(error.message, /exactly one/);
      assert.match(error.message, /\$\.arguments\.threadId/);
      return true;
    },
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
  assert.deepEqual(
    validateProtocolContractV1("effect", createEffect),
    createEffect,
  );
  assert.equal(
    validateProtocolContractV1("effect", {
      ...createEffect,
      prompt: "p".repeat(10_000),
    }).prompt.length,
    10_000,
  );
  assert.throws(
    () => validateProtocolContractV1("effect", {
      ...createEffect,
      launcher: "spawn-subagent",
    }),
    /exactly one/,
  );
  assert.equal(
    reduceProtocolTransitionV1(
      initialProtocolTransitionStateV1([createEffect]),
      createEffect,
      {
        schemaVersion: 1,
        type: "native-create",
        actionId: createEffect.actionId,
        workUnitId: createEffect.workUnitId,
        specRevision: createEffect.specRevision,
        attempt: createEffect.attempt,
        memberThreadId: "not a valid thread",
      },
    ).error.code,
    "protocol.malformed",
  );
  assert.throws(
    () => validateProtocolContractV1("effect", {
      ...createEffect,
      memberKind: "joined-subagent",
      launcher: "spawn-subagent",
      launch: {
        schemaVersion: 1,
        launcher: "spawn-subagent",
        workspaceMode: "shared-read-only",
        nativeTask: { model: "gpt-5.6-luna", thinking: "low" },
        requiresThreadId: true,
        onMissingThreadId: "attention",
      },
    }),
    /exactly one/,
  );
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
    readReceipt({
      resultEnvelope: {
        ...resultEnvelope(),
        workUnitId: "other-member",
      },
    }),
  ]) {
    assert.equal(
      reduceProtocolTransitionV1(state, action, changedReceipt).accepted,
      false,
    );
  }
  assert.equal(
    reduceProtocolTransitionV1(state, action, readReceipt({
      resultEnvelope: {
        arbitraryA: 1,
        arbitraryB: 2,
        arbitraryC: 3,
        arbitraryD: 4,
        arbitraryE: 5,
        arbitraryF: 6,
        arbitraryG: 7,
        arbitraryH: 8,
        arbitraryI: 9,
        arbitraryJ: 10,
      },
    })).error.code,
    "protocol.malformed",
  );
  assert.equal(
    reduceProtocolTransitionV1(state, action, readReceipt({
      resultEnvelope: {
        ...resultEnvelope(),
        summary: "\u0000\n\t ",
      },
    })).error.code,
    "protocol.malformed",
  );
  for (const field of ["artifacts", "verification", "blockers"]) {
    const malformedEvidence = {
      ...resultEnvelope(),
      [field]: ["\u0000\n\t "],
    };
    if (field === "blockers") malformedEvidence.outcome = "blocked";
    assert.equal(
      reduceProtocolTransitionV1(state, action, readReceipt({
        resultEnvelope: malformedEvidence,
      })).error.code,
      "protocol.malformed",
    );
  }
  assert.equal(
    reduceProtocolTransitionV1(state, action, readReceipt({
      resultEnvelope: {
        ...resultEnvelope(),
        outcome: "blocked",
        blockers: new Array(1),
      },
    })).error.code,
    "protocol.malformed",
  );
  assert.equal(
    reduceProtocolTransitionV1(state, action, readReceipt({
      resultEnvelope: {
        ...resultEnvelope(),
        recoveryHint: "\u0000\n\t ",
      },
    })).error.code,
    "protocol.malformed",
  );
  const oversizedResultEnvelope = {
    ...resultEnvelope(),
    summary: "🙂".repeat(1_000),
    artifacts: Array.from({ length: 8 }, () => "🙂".repeat(250)),
    verification: Array.from({ length: 8 }, () => "🙂".repeat(250)),
  };
  assert.equal(
    reduceProtocolTransitionV1(state, action, readReceipt({
      resultEnvelope: oversizedResultEnvelope,
    })).error.code,
    "protocol.malformed",
  );
  assert.throws(
    () => protocolValueEnvelopeV1(
      "receipt",
      readReceipt({ resultEnvelope: oversizedResultEnvelope }),
    ),
    /16384 bytes/,
  );
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
    bootstrapId: "plan:1234567890abcdef12345678",
    agentPath: "/root/planner",
    threadId: "planner-thread",
    turnId: "planner-turn",
    purpose: "read-planner-result",
  };
  const state = initialProtocolTransitionStateV1([plannerRead]);
  for (const overrides of [
    { bootstrapId: "bad" },
    { agentPath: "planner" },
    { threadId: "planner/thread" },
    { turnId: "planner/turn" },
  ]) {
    assert.throws(
      () => initialProtocolTransitionStateV1([{
        ...plannerRead,
        ...overrides,
      }]),
      /not valid|exactly one/,
    );
  }
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
  assert.equal(
    reduceProtocolTransitionV1(state, plannerRead, {
      schemaVersion: 1,
      type: "native-planner-result",
      actionId: "planner-read-1",
      bootstrapId: "plan:abcdef1234567890abcdef12",
      threadId: "planner-thread",
      turnId: "planner-turn",
      response: "```nelos-plan\n{}\n```",
    }).error.code,
    "receipt.conflicting",
  );
});

test("wait target identity and thread-only wake receipts are exact", () => {
  assert.throws(
    () => validateProtocolContractV1("effect", {
      ...waitEffect,
      targets: [waitEffect.targets[0], waitEffect.targets[0]],
    }),
    /duplicate|exactly one/,
  );
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
          hostId: "host-discovered",
        }],
      },
    ).accepted,
    true,
  );
  const hostBoundWait = {
    ...waitEffect,
    targets: [{
      ...waitEffect.targets[0],
      hostId: "host-known",
    }],
  };
  assert.equal(
    reduceProtocolTransitionV1(
      initialProtocolTransitionStateV1([hostBoundWait]),
      hostBoundWait,
      {
        ...waitReceipt,
        targets: [{
          ...waitReceipt.targets[0],
          hostId: "host-conflicting",
        }],
      },
    ).error.code,
    "receipt.conflicting",
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
  assert.equal(
    reduceProtocolTransitionV1(
      waitState,
      waitEffect,
      {
        ...waitReceipt,
        targets: [{
          workUnitId: "member",
          specRevision: 1,
          attempt: 1,
          bindingGeneration: 1,
          memberThreadId: "thread-member",
          hostId: null,
          afterCursor: null,
          arbitraryA: "cursor-1",
          arbitraryB: "running",
          arbitraryC: "turn-1",
          arbitraryD: false,
        }],
      },
    ).error.code,
    "protocol.malformed",
  );
  assert.equal(
    reduceProtocolTransitionV1(
      waitState,
      waitEffect,
      {
        ...waitReceipt,
        targets: [
          waitReceipt.targets[0],
          { ...waitReceipt.targets[0] },
        ],
      },
    ).error.code,
    "protocol.malformed",
  );
  assert.equal(
    reduceProtocolTransitionV1(
      waitState,
      waitEffect,
      {
        ...waitReceipt,
        targets: [{
          ...waitReceipt.targets[0],
          lifecycle: "completed",
          latestTurnId: null,
        }],
      },
    ).error.code,
    "protocol.malformed",
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

  const repeatedWake = {
    ...sendEffect,
    actionId: "wake-2",
    prompt: "Another member completed.",
  };
  const twoWakeState = initialProtocolTransitionStateV1([
    sendEffect,
    repeatedWake,
  ]);
  const firstWake = reduceProtocolTransitionV1(
    twoWakeState,
    sendEffect,
    { threadId: "queen-1" },
  );
  const secondWake = reduceProtocolTransitionV1(
    firstWake.state,
    repeatedWake,
    { threadId: "queen-1" },
  );
  assert.equal(firstWake.accepted, true);
  assert.equal(secondWake.accepted, true);
  assert.equal(secondWake.replayed, false);
  assert.equal(secondWake.state.cursor, 2);
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
    "receipt.cross-action",
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

  const recovered = validateRecoveryTransitionV1({
    schemaVersion: 1,
    code: "native.outcome-uncertain",
    category: "native-outcome-uncertain",
    message: "Outcome uncertain.",
    recoveryCommand: "reconcile-native-outcome",
  }, "reconcile-native-outcome");
  assert.equal(recovered.accepted, true);
  assert.equal(recovered.command, "reconcile-native-outcome");
  assert.equal(recovered.state, null);

  const terminal = validateRecoveryTransitionV1({
    schemaVersion: 1,
    code: "attention.terminal",
    category: "terminal-attention",
    message: "Stop.",
    recoveryCommand: null,
  }, "retry-read");
  assert.equal(terminal.error.code, "attention.terminal");
  assert.equal(terminal.command, null);

  const malformed = validateRecoveryTransitionV1({
    schemaVersion: 1,
    code: "attention.terminal",
    category: "retryable-attention",
    message: "Conflicting declaration.",
    recoveryCommand: "retry-read",
  }, "retry-read");
  assert.equal(malformed.error.code, "protocol.malformed");
  assert.equal(malformed.command, null);

  assert.throws(
    () => validateProtocolContractV1("error", {
      schemaVersion: 1,
      code: "attention.terminal",
      category: "retryable-attention",
      message: "Conflicting declaration.",
      recoveryCommand: "retry-read",
    }),
    /exactly one/,
  );
});

test("listed MCP producers advertise the shared compatibility envelope", () => {
  const listed = new Map(listNelosMcpTools().map((tool) => [tool.name, tool]));
  for (const producer of RUNTIME_OUTPUTS.keys()) {
    assert.ok(
      listed.has(producer),
      `${producer} is not advertised by listNelosMcpTools()`,
    );
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
  assert.ok(Object.isFrozen(PROTOCOL_MIGRATION_MAP_V1));
  assert.ok(PROTOCOL_MIGRATION_MAP_V1.every(Object.isFrozen));
  assert.throws(() => {
    PROTOCOL_MIGRATION_MAP_V1[0].skillClause = "mutated";
  }, TypeError);
  PROTOCOL_MIGRATION_MAP_V1.forEach((entry) => {
    assert.ok(entry.skillClause);
    assert.ok(entry.enforcingContract);
    assert.ok(entry.compatibilityAdapter);
  });
});
