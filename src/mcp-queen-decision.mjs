import { ExecutionStoreV1 } from "./execution-store.mjs";
import { OrchestrationCheckpointStoreV1 } from "./orchestration-checkpoint-store.mjs";
import {
  observationReceiptDigestV1,
  validateNativeResultReadReceiptV1,
} from "./orchestration-observation.mjs";
import {
  QueenAcceptanceStoreV1,
  createQueenAcceptanceV1,
  deriveWebReadinessV1,
  queenAcceptanceIdV1,
} from "./queen-acceptance.mjs";

export const MCP_QUEEN_DECISION_SCHEMA_VERSION = 1;

const RESULT_RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    type: { const: "native-result-read" },
    actionId: { type: "string", minLength: 1, maxLength: 512 },
    workUnitId: { type: "string", minLength: 1, maxLength: 128 },
    specRevision: { type: "integer", minimum: 1 },
    attempt: { type: "integer", minimum: 1 },
    bindingGeneration: { type: "integer", minimum: 1 },
    memberThreadId: { type: "string", minLength: 1, maxLength: 512 },
    requestedTurnId: { type: "string", minLength: 1, maxLength: 512 },
    sourceTurnId: { type: "string", minLength: 1, maxLength: 512 },
    resultEnvelope: {
      type: "object",
      properties: {
        schemaVersion: { const: 1 },
        workUnitId: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        },
        specRevision: { type: "integer", minimum: 1 },
        attempt: { type: "integer", minimum: 1 },
        outcome: {
          type: "string",
          enum: ["succeeded", "blocked", "failed"],
        },
        summary: { type: "string", minLength: 1, maxLength: 2_000 },
        artifacts: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
        verification: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
        blockers: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
        recoveryHint: {
          anyOf: [
            { type: "null" },
            { type: "string", minLength: 1, maxLength: 1_000 },
          ],
        },
      },
      required: [
        "schemaVersion", "workUnitId", "specRevision", "attempt", "outcome",
        "summary", "artifacts", "verification", "blockers", "recoveryHint",
      ],
      additionalProperties: false,
    },
  },
  required: [
    "schemaVersion", "type", "actionId", "workUnitId", "specRevision",
    "attempt", "bindingGeneration", "memberThreadId", "requestedTurnId",
    "sourceTurnId", "resultEnvelope",
  ],
  additionalProperties: false,
};

export const MCP_QUEEN_DECISION_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    schemaVersion: { const: MCP_QUEEN_DECISION_SCHEMA_VERSION },
    webId: { type: "string", minLength: 1, maxLength: 64 },
    queenThreadId: { type: "string", minLength: 1, maxLength: 512 },
    decision: { type: "string", enum: ["accepted", "rejected"] },
    decisionSummary: { type: "string", minLength: 1, maxLength: 1_000 },
    receipt: RESULT_RECEIPT_SCHEMA,
  },
  required: [
    "schemaVersion", "webId", "queenThreadId", "decision",
    "decisionSummary", "receipt",
  ],
  additionalProperties: false,
});

function successfulTurnStatus(value) {
  return ["completed", "complete", "succeeded"].includes(
    String(value ?? "").replaceAll(/[_\s-]/gu, "").toLowerCase(),
  );
}

function matchesCurrentWorkUnit(workUnit, webId, queenThreadId, receipt) {
  return (
    workUnit?.webId === webId &&
    workUnit.queenThreadId === queenThreadId &&
    workUnit.workUnitId === receipt.workUnitId &&
    workUnit.specRevision === receipt.specRevision &&
    workUnit.attempt === receipt.attempt &&
    workUnit.binding.state === "bound" &&
    workUnit.binding.generation === receipt.bindingGeneration &&
    workUnit.binding.memberThreadId === receipt.memberThreadId &&
    receipt.requestedTurnId === receipt.sourceTurnId
  );
}

function requirePersistedCurrentResult(checkpoint, receipt) {
  if (!checkpoint) {
    throw new Error("queen decision requires a persisted orchestration result");
  }
  const consumed = checkpoint.consumedReceipts.find(
    ({ actionId }) => actionId === receipt.actionId,
  );
  if (
    !consumed ||
    consumed.digest !== observationReceiptDigestV1(receipt)
  ) {
    throw new Error("queen decision receipt was not consumed by orchestration");
  }
  const member = checkpoint.members.find(
    ({ workUnitId }) => workUnitId === receipt.workUnitId,
  );
  if (
    !member ||
    member.specRevision !== receipt.specRevision ||
    member.attempt !== receipt.attempt ||
    member.bindingGeneration !== receipt.bindingGeneration ||
    member.memberThreadId !== receipt.memberThreadId ||
    member.execution.state !== "terminal" ||
    member.execution.latestTurnId !== receipt.sourceTurnId ||
    member.result.state !== "current" ||
    member.result.sourceTurnId !== receipt.sourceTurnId
  ) {
    throw new Error("queen decision receipt is not the current orchestration result");
  }
}

/**
 * Persist one queen decision only after the callback-only observation join has
 * consumed the exact current result receipt. The app-server latest-turn check
 * closes the gap between durable observation and the moment of a fresh
 * decision. Exact persisted replays do not require the member to remain live.
 */
export class McpQueenDecisionAdapterV1 {
  #executionStore;
  #acceptanceStore;
  #checkpointStore;
  #now;

  constructor({
    executionStore = new ExecutionStoreV1(),
    acceptanceStore = new QueenAcceptanceStoreV1(),
    checkpointStore = new OrchestrationCheckpointStoreV1(),
    now = () => new Date().toISOString(),
  } = {}) {
    this.#executionStore = executionStore;
    this.#acceptanceStore = acceptanceStore;
    this.#checkpointStore = checkpointStore;
    this.#now = now;
  }

  async decide(value, { appServerBridge } = {}) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.schemaVersion !== MCP_QUEEN_DECISION_SCHEMA_VERSION
    ) {
      throw new Error(
        `queen decision schemaVersion must be ${MCP_QUEEN_DECISION_SCHEMA_VERSION}`,
      );
    }
    const {
      webId,
      queenThreadId,
      decision,
      decisionSummary,
    } = value;
    // A bundled STDIO MCP process can outlive the Codex task that launched it.
    // Its process environment is therefore not per-call caller evidence.
    // Queen ownership is established by the persisted binding and exact
    // consumed result below.
    const receipt = validateNativeResultReadReceiptV1(value.receipt);
    const workUnit = await this.#executionStore.read(receipt.workUnitId);
    if (!matchesCurrentWorkUnit(workUnit, webId, queenThreadId, receipt)) {
      throw new Error("queen decision does not match the current durable binding");
    }
    const checkpoint = await this.#checkpointStore.read(webId, queenThreadId);
    requirePersistedCurrentResult(checkpoint, receipt);

    const identity = {
      webId,
      workUnitId: workUnit.workUnitId,
      specRevision: workUnit.specRevision,
      attempt: workUnit.attempt,
      memberThreadId: workUnit.binding.memberThreadId,
      sourceTurnId: receipt.sourceTurnId,
    };
    const decisionId = queenAcceptanceIdV1(identity);
    const existing = await this.#acceptanceStore.read(decisionId);

    if (!existing) {
      if (
        !appServerBridge ||
        typeof appServerBridge.latestTurn !== "function"
      ) {
        throw new Error("fresh queen decision requires latest-turn host evidence");
      }
      let latestTurn;
      try {
        latestTurn = await appServerBridge.latestTurn({
          threadId: workUnit.binding.memberThreadId,
        });
      } catch {
        throw new Error("queen decision latest-turn evidence is unavailable");
      }
      if (
        latestTurn?.turnId !== receipt.sourceTurnId ||
        !successfulTurnStatus(latestTurn?.status)
      ) {
        throw new Error("queen decision receipt is not from the latest successful turn");
      }
    }

    const proposed = createQueenAcceptanceV1({
      schemaVersion: 1,
      decisionId,
      ...identity,
      queenThreadId,
      decision,
      decisionSummary,
      result: receipt.resultEnvelope,
      recordedAt: existing?.recordedAt ?? this.#now(),
    });
    const workUnits = (await this.#executionStore.list()).filter(
      (candidate) =>
        candidate.webId === webId &&
        candidate.queenThreadId === queenThreadId,
    );
    const decisions = await this.#acceptanceStore.list({
      webId,
      queenThreadId,
    });
    const readiness = deriveWebReadinessV1({
      workUnits,
      decisions: decisions.some(
        (candidate) => candidate.decisionId === decisionId,
      )
        ? decisions
        : [...decisions, proposed],
    });
    // The complete web graph and proposed decision are validated before the
    // acceptance store is mutated. A dangling dependency therefore cannot
    // leave behind a decision that a later observation pass would consume.
    const persisted = await this.#acceptanceStore.record(proposed);
    return {
      schemaVersion: MCP_QUEEN_DECISION_SCHEMA_VERSION,
      replayed: existing !== null,
      decision: persisted,
      readiness,
      nextAction: {
        schemaVersion: 1,
        kind: "advance-orchestration",
        tool: "nelos_orchestrate_advance",
        arguments: { webId, queenThreadId, receipt: null },
      },
    };
  }
}
