import {
  ExecutionStoreV1,
  workUnitDefinitionV1,
} from "./execution-store.mjs";
import { McpOrchestrationAdapterV1 } from "./mcp-orchestration.mjs";
import { validateNativeResultReadReceiptV1 } from "./orchestration-observation.mjs";
import { workUnitFromLaunchMemberV1 } from "./plan-orchestration-bridge.mjs";
import {
  QueenAcceptanceStoreV1,
  createQueenAcceptanceV1,
  deriveWebReadinessV1,
  queenAcceptanceIdV1,
} from "./queen-acceptance.mjs";
import {
  SpinoffLifecycleAdapterV1,
} from "./spinoff-lifecycle.mjs";

function plannedMembers(plan) {
  if (!plan || !Array.isArray(plan.waves) || plan.waves.length === 0) {
    throw new Error("durable spinoff composition requires a planned wave set");
  }
  return plan.waves.flatMap(({ slices }) =>
    slices.map((slice) => ({
      sliceId: slice.id,
      lifecycle: slice.lifecycle,
      memberKind:
        slice.lifecycle === "spinoff" ? "spinoff" : "joined-subagent",
      workspaceMode: slice.workspaceMode,
      nativeTask: slice.route.launch.nativeTask,
      title: slice.title,
      objective: slice.objective,
      deliverable: slice.deliverable,
      acceptanceCriteria: slice.acceptanceCriteria,
      dependsOn: slice.dependsOn,
    })),
  );
}

function matchesResultReceipt(workUnit, receipt) {
  const expectedActionId =
    `observation-v1/result/${encodeURIComponent(workUnit.workUnitId)}` +
    `/r${workUnit.specRevision}/a${workUnit.attempt}` +
    `/b${workUnit.binding.generation}` +
    `/${encodeURIComponent(receipt.requestedTurnId)}`;
  return (
    workUnit.specRevision === receipt.specRevision &&
    workUnit.attempt === receipt.attempt &&
    workUnit.binding.state === "bound" &&
    workUnit.binding.generation === receipt.bindingGeneration &&
    workUnit.binding.memberThreadId === receipt.memberThreadId &&
    receipt.actionId === expectedActionId &&
    receipt.requestedTurnId === receipt.sourceTurnId
  );
}

function successfulTurnStatus(value) {
  return ["completed", "complete", "succeeded"].includes(
    String(value ?? "").replaceAll(/[_\s-]/gu, "").toLowerCase(),
  );
}

/**
 * Compose existing durable execution, native receipt, acceptance, wake, and
 * cleanup primitives. Native effects are returned to the host; this adapter
 * never reconstructs or executes their protocol itself.
 */
export class DurableSpinoffCompositionV1 {
  #executionStore;
  #acceptanceStore;
  #orchestration;
  #lifecycle;
  #now;
  #callerThreadId;

  constructor({
    executionStore = new ExecutionStoreV1(),
    acceptanceStore = new QueenAcceptanceStoreV1(),
    orchestration = new McpOrchestrationAdapterV1({ store: executionStore }),
    lifecycle = new SpinoffLifecycleAdapterV1({
      executionStore,
      acceptanceStore,
    }),
    now = () => new Date().toISOString(),
    callerThreadId = () => process.env.CODEX_THREAD_ID ?? null,
  } = {}) {
    this.#executionStore = executionStore;
    this.#acceptanceStore = acceptanceStore;
    this.#orchestration = orchestration;
    this.#lifecycle = lifecycle;
    this.#now = now;
    this.#callerThreadId = callerThreadId;
  }

  async #readiness(webId, queenThreadId) {
    const workUnits = (await this.#executionStore.list()).filter(
      (workUnit) =>
        workUnit.webId === webId &&
        workUnit.queenThreadId === queenThreadId,
    );
    const decisions = await this.#acceptanceStore.list({
      webId,
      queenThreadId,
    });
    return {
      workUnits,
      readiness: deriveWebReadinessV1({ workUnits, decisions }),
    };
  }

  async #launchReady(workUnits, readiness) {
    const byId = new Map(
      workUnits.map((workUnit) => [workUnit.workUnitId, workUnit]),
    );
    const launches = [];
    for (const workUnitId of readiness.readyWorkUnitIds) {
      const workUnit = byId.get(workUnitId);
      if (!workUnit) {
        throw new Error(`ready work unit ${workUnitId} is not persisted`);
      }
      launches.push(await this.#orchestration.orchestrate({
        workUnit: workUnitDefinitionV1(workUnit),
        receipt: null,
      }));
    }
    return launches;
  }

  /**
   * Persist every planned contract before returning the first native launch
   * effect. This is intentionally batch-first even when only wave one is ready.
   */
  async persistPlan({ plan, webId, queenThreadId, cleanupIntended = false } = {}) {
    if (this.#callerThreadId() !== queenThreadId) {
      throw new Error("only the plan's queen may persist durable work");
    }
    if (typeof cleanupIntended !== "boolean") {
      throw new Error("cleanupIntended must be a boolean");
    }
    const workUnits = plannedMembers(plan).map((member) =>
      workUnitFromLaunchMemberV1(member, { webId, queenThreadId, cleanupIntended }),
    );
    for (const workUnit of workUnits) {
      await this.#executionStore.create(workUnit);
    }
    const state = await this.#readiness(webId, queenThreadId);
    return {
      schemaVersion: 1,
      webId,
      queenThreadId,
      persistedWorkUnitIds: workUnits
        .map(({ workUnitId }) => workUnitId)
        .sort((left, right) => left.localeCompare(right)),
      readiness: state.readiness,
      launches: await this.#launchReady(state.workUnits, state.readiness),
    };
  }

  /**
   * Bind a native create receipt to the exact persisted launch identity.
   */
  async bindNativeCreate({ workUnitId, receipt } = {}) {
    const workUnit = await this.#executionStore.read(workUnitId);
    if (!workUnit) throw new Error(`work unit ${workUnitId} was not found`);
    return this.#orchestration.orchestrate({
      workUnit: workUnitDefinitionV1(workUnit),
      receipt,
    });
  }

  async complete(value) {
    return this.#lifecycle.complete(value);
  }

  /**
   * Record a queen decision from the exact native result receipt and return
   * executable native-create effects for every newly released dependent.
   */
  async acceptNativeResult({
    webId,
    queenThreadId,
    receipt,
    decision = "accepted",
    decisionSummary = null,
  } = {}, appServerBridge) {
    if (this.#callerThreadId() !== queenThreadId) {
      throw new Error("only the work unit's queen may accept a native result");
    }
    const nativeReceipt = validateNativeResultReadReceiptV1(receipt);
    const workUnit = await this.#executionStore.read(nativeReceipt.workUnitId);
    if (
      !workUnit ||
      workUnit.webId !== webId ||
      workUnit.queenThreadId !== queenThreadId ||
      !matchesResultReceipt(workUnit, nativeReceipt)
    ) {
      throw new Error("native result receipt does not match the current durable binding");
    }
    if (!appServerBridge || typeof appServerBridge.latestTurn !== "function") {
      throw new Error("native result acceptance requires latestTurn host evidence");
    }
    let latestTurn;
    try {
      latestTurn = await appServerBridge.latestTurn({
        threadId: workUnit.binding.memberThreadId,
      });
    } catch {
      throw new Error("native result latest-turn evidence is unavailable");
    }
    if (
      latestTurn?.turnId !== nativeReceipt.requestedTurnId ||
      !successfulTurnStatus(latestTurn?.status)
    ) {
      throw new Error("native result receipt is not from the latest successful turn");
    }
    const identity = {
      webId,
      workUnitId: workUnit.workUnitId,
      specRevision: workUnit.specRevision,
      attempt: workUnit.attempt,
      memberThreadId: workUnit.binding.memberThreadId,
      sourceTurnId: nativeReceipt.sourceTurnId,
    };
    const acceptance = await this.#acceptanceStore.record(
      createQueenAcceptanceV1({
        schemaVersion: 1,
        decisionId: queenAcceptanceIdV1(identity),
        ...identity,
        queenThreadId,
        decision,
        decisionSummary:
          decisionSummary ??
          (decision === "accepted"
            ? "Queen accepted the current native result."
            : "Queen rejected the current native result."),
        result: nativeReceipt.resultEnvelope,
        recordedAt: this.#now(),
      }),
    );
    const state = await this.#readiness(webId, queenThreadId);
    return {
      schemaVersion: 1,
      acceptance,
      readiness: state.readiness,
      launches: await this.#launchReady(state.workUnits, state.readiness),
    };
  }

  async cleanup(value) {
    return this.#lifecycle.cleanup(value);
  }
}
