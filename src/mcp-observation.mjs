import { ExecutionStoreV1 } from "./execution-store.mjs";
import { OrchestrationCheckpointStoreV1 } from "./orchestration-checkpoint-store.mjs";
import {
  applyObservationReceiptV1,
  reduceObservationJoinV1,
  validateObservationReceiptV1,
} from "./orchestration-observation.mjs";
import { QueenAcceptanceStoreV1 } from "./queen-acceptance.mjs";
import { withObservationCheckpointLock } from "./task-state.mjs";
import { PlanRunStoreV1 } from "./plan-run-store.mjs";
import { derivePlanWaveActionV1 } from "./next-action.mjs";

export const MCP_OBSERVATION_SCHEMA_VERSION = 1;

function initialMember(workUnit) {
  return {
    workUnitId: workUnit.workUnitId,
    specRevision: workUnit.specRevision,
    attempt: workUnit.attempt,
    bindingGeneration: workUnit.binding.generation,
    memberThreadId: workUnit.binding.memberThreadId,
    capabilities: [...workUnit.capabilities],
    required: workUnit.required,
    title: {
      state: "pending",
      requestedTitle: workUnit.title,
      observedTitle: null,
      retryOrdinal: 0,
    },
    execution: {
      state: "unknown",
      hostId: null,
      cursor: null,
      latestTurnId: null,
      attentionRequired: false,
    },
    result: {
      state: "absent",
      sourceTurnId: null,
      envelope: null,
      errorCode: null,
    },
    coordination: { state: workUnit.required ? "unjoined" : "detached" },
  };
}

function sameBinding(member, workUnit) {
  return (
    member.specRevision === workUnit.specRevision &&
    member.attempt === workUnit.attempt &&
    member.bindingGeneration === workUnit.binding.generation &&
    member.memberThreadId === workUnit.binding.memberThreadId
  );
}

function synthesize(current, workUnits, webId, queenThreadId) {
  const prior = new Map((current?.members ?? []).map((member) => [member.workUnitId, member]));
  return {
    schemaVersion: 1,
    webId,
    queenThreadId,
    checkpointRevision: current?.checkpointRevision ?? 0,
    waitGeneration: current?.waitGeneration ?? 0,
    members: workUnits
      .filter((workUnit) => workUnit.binding.state === "bound")
      .map((workUnit) => {
        const existing = prior.get(workUnit.workUnitId);
        return existing && sameBinding(existing, workUnit)
          ? existing
          : initialMember(workUnit);
      })
      .sort((left, right) => left.workUnitId.localeCompare(right.workUnitId)),
    consumedReceipts: current?.consumedReceipts ?? [],
  };
}

function applyAcceptances(checkpoint, decisions) {
  let changed = false;
  const members = checkpoint.members.map((member) => {
    const accepted = decisions.find(
      (decision) =>
        decision.decision === "accepted" &&
        decision.workUnitId === member.workUnitId &&
        decision.specRevision === member.specRevision &&
        decision.attempt === member.attempt &&
        decision.memberThreadId === member.memberThreadId &&
        member.result.state === "current" &&
        decision.sourceTurnId === member.result.sourceTurnId,
    );
    if (!accepted || member.coordination.state === "accepted") return member;
    changed = true;
    return { ...member, coordination: { state: "accepted" } };
  });
  return changed ? { ...checkpoint, members } : checkpoint;
}

function statePayload(checkpoint) {
  const { checkpointRevision: _revision, ...payload } = checkpoint;
  return payload;
}

function sameState(left, right) {
  return JSON.stringify(statePayload(left)) === JSON.stringify(statePayload(right));
}

async function terminalNextAction(
  join,
  webId,
  queenThreadId,
  workUnits,
  planRunStore,
) {
  if (
    join.boundary.type !== "continue" ||
    join.boundary.reason !== "all-required-results-accepted"
  ) {
    return null;
  }
  const planRuns = await planRunStore.listForWeb({
    webId,
    queenThreadId,
  });
  const workUnitIds = new Set(
    workUnits.map(({ workUnitId }) => workUnitId),
  );
  const relevantRuns = planRuns.filter((planRun) => {
    const memberIds = new Set(
      planRun.waves.flatMap(({ members }) =>
        members.map(({ sliceId }) => sliceId),
      ),
    );
    return (
      planRun.verifiedWaveIndexes.length > 0 &&
      [...workUnitIds].some((workUnitId) => memberIds.has(workUnitId))
    );
  });
  const activeRun = relevantRuns[0] ?? null;
  if (activeRun) {
    const lastVerifiedWave =
      activeRun.verifiedWaveIndexes.at(-1) ?? 0;
    if (lastVerifiedWave < activeRun.waves.length) {
      if (!activeRun.plan) {
        return {
          schemaVersion: 1,
          kind: "attention",
          reason: "remaining-plan-wave-contract-is-unavailable",
          planRunId: activeRun.planRunId,
          nextWaveIndex: lastVerifiedWave + 1,
        };
      }
      return derivePlanWaveActionV1(
        activeRun.plan,
        activeRun,
        lastVerifiedWave + 1,
        activeRun.cleanupIntended,
      );
    }
  }
  return {
    schemaVersion: 1,
    kind: "cleanup-spinoffs",
    tool: "nelos_spinoff_cleanup",
    arguments: { webId, queenThreadId },
  };
}

/**
 * Callback-only adapter. It reads durable Nelos state and returns typed host
 * effects; it never discovers, starts, or connects to an app-server process.
 */
export class McpJoinAdapterV1 {
  #executionStore;
  #checkpointStore;
  #acceptanceStore;
  #planRunStore;

  constructor({
    executionStore = new ExecutionStoreV1(),
    checkpointStore = new OrchestrationCheckpointStoreV1(),
    acceptanceStore = new QueenAcceptanceStoreV1(),
    planRunStore = new PlanRunStoreV1(),
  } = {}) {
    this.#executionStore = executionStore;
    this.#checkpointStore = checkpointStore;
    this.#acceptanceStore = acceptanceStore;
    this.#planRunStore = planRunStore;
  }

  async advance({ webId, queenThreadId, receipt = null } = {}) {
    if (typeof webId !== "string" || !webId || typeof queenThreadId !== "string" || !queenThreadId) {
      throw new Error("orchestration advance requires webId and queenThreadId");
    }
    const normalizedReceipt = receipt === null ? null : validateObservationReceiptV1(receipt);
    return withObservationCheckpointLock(webId, queenThreadId, async () => {
      const scan = await this.#executionStore.scan();
      const workUnits = scan.workUnits.filter(
        (workUnit) =>
          workUnit.webId === webId && workUnit.queenThreadId === queenThreadId,
      );
      if (workUnits.length === 0) {
        throw new Error("orchestration advance found no execution work units");
      }
      const stored = await this.#checkpointStore.read(webId, queenThreadId);
      const scopedWorkUnitIds = new Set([
        ...workUnits.map(({ workUnitId }) => workUnitId),
        ...(stored?.members ?? []).map(({ workUnitId }) => workUnitId),
      ]);
      if (
        scan.malformedRecords.some(
          ({ workUnitId }) =>
            workUnitId !== null && scopedWorkUnitIds.has(workUnitId),
        )
      ) {
        throw new Error("execution state contains malformed records for this orchestration");
      }
      const hasUnboundRequired = workUnits.some(
        (workUnit) => workUnit.required && workUnit.binding.state !== "bound",
      );
      let checkpoint = synthesize(stored, workUnits, webId, queenThreadId);
      const decisions = await this.#acceptanceStore.list({ webId, queenThreadId });
      checkpoint = applyAcceptances(checkpoint, decisions);
      if (normalizedReceipt !== null) {
        checkpoint = applyObservationReceiptV1(checkpoint, normalizedReceipt).checkpoint;
      }

      const changed = stored === null || !sameState(stored, checkpoint);
      if (changed) {
        const expectedRevision = stored?.checkpointRevision ?? 0;
        checkpoint = {
          ...checkpoint,
          checkpointRevision: expectedRevision + 1,
        };
        checkpoint = await this.#checkpointStore.write(checkpoint, {
          expectedRevision,
        });
      } else {
        checkpoint = stored;
      }
      const join = reduceObservationJoinV1(checkpoint);
      if (
        hasUnboundRequired &&
        ["decide", "continue"].includes(join.boundary.type)
      ) {
        join.boundary = {
          type: "waiting",
          reason: "required-members-unbound",
        };
      }
      const nextAction = await terminalNextAction(
        join,
        webId,
        queenThreadId,
        workUnits,
        this.#planRunStore,
      );
      return {
        schemaVersion: MCP_OBSERVATION_SCHEMA_VERSION,
        webId,
        queenThreadId,
        checkpoint,
        join,
        ...(nextAction === null ? {} : { nextAction }),
      };
    });
  }
}

const WAIT_TARGET_SCHEMA = {
  type: "object",
  properties: {
    workUnitId: { type: "string" },
    specRevision: { type: "integer", minimum: 1 },
    attempt: { type: "integer", minimum: 1 },
    bindingGeneration: { type: "integer", minimum: 1 },
    memberThreadId: { type: "string" },
    hostId: { type: ["string", "null"] },
    afterCursor: { type: ["string", "null"] },
    nextCursor: { type: ["string", "null"] },
    lifecycle: { enum: ["waiting", "running", "completed", "failed", "unavailable"] },
    latestTurnId: { type: ["string", "null"] },
    attentionRequired: { type: "boolean" },
  },
  required: [
    "workUnitId", "specRevision", "attempt", "bindingGeneration",
    "memberThreadId", "hostId", "afterCursor", "nextCursor", "lifecycle",
    "latestTurnId", "attentionRequired",
  ],
  additionalProperties: false,
};

const IDENTITY_PROPERTIES = {
  workUnitId: { type: "string" },
  specRevision: { type: "integer", minimum: 1 },
  attempt: { type: "integer", minimum: 1 },
  bindingGeneration: { type: "integer", minimum: 1 },
  memberThreadId: { type: "string" },
};
const IDENTITY_REQUIRED = Object.keys(IDENTITY_PROPERTIES);

export const MCP_OBSERVATION_ADVANCE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    webId: { type: "string" },
    queenThreadId: { type: "string" },
    receipt: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            schemaVersion: { const: 1 },
            type: { const: "native-title-observed" },
            actionId: { type: "string" },
            ...IDENTITY_PROPERTIES,
            requestedTitle: { type: "string" },
            observedTitle: { type: "string" },
          },
          required: [
            "schemaVersion", "type", "actionId", ...IDENTITY_REQUIRED,
            "requestedTitle", "observedTitle",
          ],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            schemaVersion: { const: 1 },
            type: { const: "native-wait" },
            actionId: { type: "string" },
            webId: { type: "string" },
            queenThreadId: { type: "string" },
            status: { enum: ["event", "timeout"] },
            targets: { type: "array", minItems: 1, maxItems: 100, items: WAIT_TARGET_SCHEMA },
          },
          required: [
            "schemaVersion", "type", "actionId", "webId", "queenThreadId",
            "status", "targets",
          ],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            schemaVersion: { const: 1 },
            type: { const: "native-result-read" },
            actionId: { type: "string" },
            ...IDENTITY_PROPERTIES,
            requestedTurnId: { type: "string" },
            sourceTurnId: { type: "string" },
            resultEnvelope: {},
          },
          required: [
            "schemaVersion", "type", "actionId", ...IDENTITY_REQUIRED,
            "requestedTurnId", "sourceTurnId", "resultEnvelope",
          ],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["webId", "queenThreadId", "receipt"],
  additionalProperties: false,
});
