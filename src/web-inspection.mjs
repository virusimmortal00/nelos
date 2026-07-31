import { ExecutionStoreV1 } from "./execution-store.mjs";
import { OrchestrationCheckpointStoreV1 } from "./orchestration-checkpoint-store.mjs";
import { assertWebId } from "./task-web.mjs";

export const WEB_INSPECTION_SCHEMA_VERSION = 1;
export const WEB_INSPECTION_MAX_MEMBERS = 15;
export const WEB_INSPECTION_MAX_EXECUTION_RECORDS = 256;

const INPUT_FIELDS = new Set([
  "schemaVersion",
  "webId",
  "queenThreadId",
  "offset",
  "limit",
  "probe",
]);
const THREAD_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,256}$/u;

export const WEB_INSPECTION_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "webId", "queenThreadId"],
  properties: {
    schemaVersion: { const: WEB_INSPECTION_SCHEMA_VERSION },
    webId: {
      type: "string",
      pattern: "^[A-Za-z][1-9]\\d*(?:\\.[1-9]\\d*)*$",
    },
    queenThreadId: {
      type: "string",
      minLength: 1,
      maxLength: 256,
    },
    offset: {
      type: "integer",
      minimum: 0,
      maximum: 10_000,
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: WEB_INSPECTION_MAX_MEMBERS,
    },
    probe: { type: "boolean" },
  },
});

function exactInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("web inspection input must be a JSON object");
  }
  const unknown = Object.keys(value).find((field) => !INPUT_FIELDS.has(field));
  if (unknown) {
    throw new Error(`web inspection input contains unknown field: ${unknown}`);
  }
  if (value.schemaVersion !== WEB_INSPECTION_SCHEMA_VERSION) {
    throw new Error(
      `web inspection schemaVersion must be ${WEB_INSPECTION_SCHEMA_VERSION}`,
    );
  }
  const webId = assertWebId(value.webId);
  if (
    typeof value.queenThreadId !== "string" ||
    !THREAD_ID_PATTERN.test(value.queenThreadId)
  ) {
    throw new Error("web inspection queenThreadId has an invalid format");
  }
  const offset = value.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
    throw new Error("web inspection offset must be between 0 and 10000");
  }
  const limit = value.limit ?? WEB_INSPECTION_MAX_MEMBERS;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > WEB_INSPECTION_MAX_MEMBERS
  ) {
    throw new Error(
      `web inspection limit must be between 1 and ${WEB_INSPECTION_MAX_MEMBERS}`,
    );
  }
  if (value.probe !== undefined && typeof value.probe !== "boolean") {
    throw new Error("web inspection probe must be a boolean");
  }
  return {
    schemaVersion: WEB_INSPECTION_SCHEMA_VERSION,
    webId,
    queenThreadId: value.queenThreadId,
    offset,
    limit,
    probe: value.probe === true,
  };
}

function currentCheckpointMember(workUnit, checkpointByWorkUnit) {
  const member = checkpointByWorkUnit.get(workUnit.workUnitId);
  if (!member) return { state: "untracked" };
  if (
    workUnit.binding.state !== "bound" ||
    member.specRevision !== workUnit.specRevision ||
    member.attempt !== workUnit.attempt ||
    member.bindingGeneration !== workUnit.binding.generation ||
    member.memberThreadId !== workUnit.binding.memberThreadId
  ) {
    return { state: "stale" };
  }
  return {
    state: "current",
    title: member.title.state,
    execution: member.execution.state,
    attentionRequired: member.execution.attentionRequired,
    result: member.result.state,
    resultErrorCode: member.result.errorCode,
    coordination: member.coordination.state,
  };
}

function publicNativeItem(item) {
  if (!item) return null;
  if (item.state === "failed") {
    return {
      state: "failed",
      error: {
        code: item.error.code,
        retriable: item.error.retriable,
      },
    };
  }
  return {
    state: "ready",
    title: item.thread.title,
    status: item.thread.status,
    ...(item.thread.activeFlags
      ? { activeFlags: [...item.thread.activeFlags] }
      : {}),
    parentThreadId: item.thread.parentThreadId,
    updatedAt: item.thread.updatedAt,
  };
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function compareWorkUnitIds(left, right) {
  return left.workUnitId < right.workUnitId
    ? -1
    : left.workUnitId > right.workUnitId
      ? 1
      : 0;
}

function matchesPersistedWeb(record, request) {
  if (record?.threadId !== request.queenThreadId) return false;
  try {
    return assertWebId(record.outboundWebId) === request.webId;
  } catch {
    return false;
  }
}

function publicTopology(topology) {
  return {
    schemaVersion: topology.schemaVersion,
    nodes: topology.nodes.map((thread) => ({
      schemaVersion: thread.schemaVersion,
      threadId: thread.threadId,
      title: thread.title,
      status: thread.status,
      ...(thread.activeFlags
        ? { activeFlags: [...thread.activeFlags] }
        : {}),
      parentThreadId: thread.parentThreadId,
      updatedAt: thread.updatedAt,
    })),
    edges: topology.edges.map(({ parentThreadId, childThreadId }) => ({
      parentThreadId,
      childThreadId,
    })),
    externalParents: topology.externalParents.map(
      ({ threadId, parentThreadId }) => ({ threadId, parentThreadId }),
    ),
  };
}

export class NelosWebInspectorV1 {
  #executionStore;
  #checkpointStore;

  constructor({
    executionStore = new ExecutionStoreV1(),
    checkpointStore = new OrchestrationCheckpointStoreV1(),
  } = {}) {
    if (typeof executionStore?.scan !== "function") {
      throw new Error("web inspector requires executionStore.scan()");
    }
    if (typeof checkpointStore?.read !== "function") {
      throw new Error("web inspector requires checkpointStore.read()");
    }
    this.#executionStore = executionStore;
    this.#checkpointStore = checkpointStore;
  }

  async inspect(input, { appServerBridge, webRegistry } = {}) {
    if (
      typeof appServerBridge?.inspectMany !== "function" ||
      typeof appServerBridge?.health !== "function"
    ) {
      throw new Error(
        "web inspector requires appServerBridge.inspectMany() and health()",
      );
    }
    if (typeof webRegistry?.read !== "function") {
      throw new Error("web inspector requires webRegistry.read()");
    }
    const request = exactInput(input);
    const persistedWeb = await webRegistry.read(request.queenThreadId);
    if (!matchesPersistedWeb(persistedWeb, request)) {
      throw new Error("web inspection identity is not persisted");
    }
    const [executionScan, checkpoint] = await Promise.all([
      this.#executionStore.scan({
        maximumRecords: WEB_INSPECTION_MAX_EXECUTION_RECORDS,
      }),
      this.#checkpointStore.read(request.webId, request.queenThreadId),
    ]);
    const workUnits = executionScan.workUnits
      .filter(
        (workUnit) =>
          workUnit.webId === request.webId &&
          workUnit.queenThreadId === request.queenThreadId,
      )
      .sort(compareWorkUnitIds);
    const boundWorkUnits = workUnits.filter(
      (workUnit) => workUnit.binding.state === "bound",
    );
    const pageMembers = workUnits.slice(
      request.offset,
      request.offset + request.limit,
    );
    const boundThreadIds = [
      ...new Set(
        pageMembers
          .filter((workUnit) => workUnit.binding.state === "bound")
          .map((workUnit) => workUnit.binding.memberThreadId),
      ),
    ];
    const inspectedThreadIds = [
      request.queenThreadId,
      ...boundThreadIds.filter(
        (threadId) => threadId !== request.queenThreadId,
      ),
    ];
    const [inventory, health] = await Promise.all([
      appServerBridge.inspectMany({
        threadIds: inspectedThreadIds,
        includeTopology: true,
      }),
      appServerBridge.health({ probe: request.probe }),
    ]);
    const inventoryByThreadId = new Map(
      inventory.items.map((item) => [item.threadId, item]),
    );
    const checkpointByWorkUnit = new Map(
      (checkpoint?.members ?? []).map((member) => [
        member.workUnitId,
        member,
      ]),
    );

    const bindingCounts = {};
    const coordinationCounts = {};
    let persistedAttentionRequired = 0;
    for (const workUnit of workUnits) {
      increment(bindingCounts, workUnit.binding.state);
      const orchestration = currentCheckpointMember(
        workUnit,
        checkpointByWorkUnit,
      );
      increment(
        coordinationCounts,
        orchestration.state === "current"
          ? orchestration.coordination
          : orchestration.state,
      );
      if (
        orchestration.state === "stale" ||
        orchestration.attentionRequired === true
      ) {
        persistedAttentionRequired += 1;
      }
    }

    let pageNativeFailures = 0;
    const members = pageMembers.map((workUnit) => {
      const native =
        workUnit.binding.state === "bound"
          ? publicNativeItem(
              inventoryByThreadId.get(workUnit.binding.memberThreadId),
            )
          : null;
      if (native?.state === "failed") pageNativeFailures += 1;
      return {
        workUnitId: workUnit.workUnitId,
        title: workUnit.title,
        memberKind: workUnit.memberKind,
        required: workUnit.required,
        dependencies: [...workUnit.dependencies],
        binding: {
          state: workUnit.binding.state,
          memberThreadId: workUnit.binding.memberThreadId,
          generation: workUnit.binding.generation,
        },
        orchestration: currentCheckpointMember(
          workUnit,
          checkpointByWorkUnit,
        ),
        native,
      };
    });
    const nextOffset =
      request.offset + pageMembers.length < workUnits.length
        ? request.offset + pageMembers.length
        : null;

    return {
      schemaVersion: WEB_INSPECTION_SCHEMA_VERSION,
      web: {
        webId: request.webId,
        queenThreadId: request.queenThreadId,
      },
      page: {
        offset: request.offset,
        limit: request.limit,
        returned: pageMembers.length,
        total: workUnits.length,
        nextOffset,
      },
      summary: {
        bindingCounts,
        coordinationCounts,
        persistedAttentionRequired,
        pageNativeFailures,
        duplicateBoundThreadIds:
          boundWorkUnits.length -
          new Set(
            boundWorkUnits.map(
              (workUnit) => workUnit.binding.memberThreadId,
            ),
          ).size,
        malformedExecutionRecords:
          executionScan.malformedRecords.length,
        checkpoint: checkpoint
          ? {
              state: "ready",
              revision: checkpoint.checkpointRevision,
              waitGeneration: checkpoint.waitGeneration,
            }
          : { state: "absent" },
      },
      queen: publicNativeItem(
        inventoryByThreadId.get(request.queenThreadId),
      ),
      members,
      topology: publicTopology(inventory.topology),
      health,
    };
  }
}
