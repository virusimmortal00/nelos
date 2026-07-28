import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { join } from "node:path";

import {
  createPlanningBootstrapV1,
  finalizePlanningBootstrapV1,
  MAX_PLANNING_CONTEXT_CHARACTERS,
  MAX_PLANNING_OBJECTIVE_CHARACTERS,
  MAX_PLANNING_RESPONSE_CHARACTERS,
  PLANNER_ROUTE,
} from "./planning-bootstrap.mjs";
import {
  defaultCodexSessionsRoot,
  resolveNativeSubagentThreadV1,
  verifyRuntimeIntelligenceV1,
} from "./runtime-intelligence-verification.mjs";
import {
  PROTOCOL_CODE_REGISTRY_V1,
  validateProtocolContractV1,
} from "./protocol-contract/index.mjs";
import { MAX_PARALLEL_SLICES } from "./slice-planner.mjs";
import {
  taskStateDirectory,
  withPlanningLifecycleLock,
} from "./task-state.mjs";

export const PLANNING_LIFECYCLE_SCHEMA_VERSION = 1;
export const PLANNING_LIFECYCLE_RECEIPT_SCHEMA_VERSION = 1;

export class PlanningLifecycleProtocolError extends Error {
  constructor(code, message) {
    super(message);
    if (!Object.hasOwn(PROTOCOL_CODE_REGISTRY_V1, code)) {
      throw new Error(`unknown planning lifecycle protocol code ${code}`);
    }
    const declaration = PROTOCOL_CODE_REGISTRY_V1[code];
    this.name = "PlanningLifecycleProtocolError";
    this.code = code;
    this.retryable = !declaration.terminal;
    this.recoveryCommand = declaration.recoveryCommand;
    this.protocolError = validateProtocolContractV1("error", {
      schemaVersion: 1,
      code,
      category: declaration.category,
      message,
      recoveryCommand: declaration.recoveryCommand,
    });
  }
}

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_INTERRUPTED_TURN_RECONCILIATIONS = 1;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const BOOTSTRAP_ID = /^plan:[a-f0-9]{24}$/u;
const AGENT_PATH =
  /^\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*){0,15}$/u;
const ACTION_ID = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PHASES = new Set(["launch-pending", "launched", "verified", "completed", "attention"]);
const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "failed",
  "error",
  "interrupted",
  "cancelled",
  "canceled",
]);
const SUCCESSFUL_TURN_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
]);
const REQUEST_FIELDS = new Set([
  "schemaVersion",
  "idempotencyKey",
  "queenThreadId",
  "objective",
  "context",
  "maxParallel",
  "cleanupIntended",
  "bootstrapId",
  "receipt",
]);
const LAUNCH_RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "type",
  "actionId",
  "bootstrapId",
  "parentThreadId",
  "agentPath",
]);
const RESULT_RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "type",
  "actionId",
  "bootstrapId",
  "threadId",
  "turnId",
  "response",
]);
const RECORD_FIELDS = new Set([
  "schemaVersion",
  "bootstrapId",
  "revision",
  "requestDigest",
  "phase",
  "launchActionId",
  "identity",
  "responseDigest",
  "attentionReason",
  "interruptedTurnReconciliations",
  "consumedReceipts",
]);
const IDENTITY_FIELDS = new Set([
  "parentThreadId",
  "agentPath",
  "threadId",
]);

function exactObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
  return value;
}

function text(value, field, maximum, { optional = false } = {}) {
  if (optional && value === undefined) return "";
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum
  ) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value
    .replaceAll(/[\u0000-\u001f\u007f]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function rawText(value, field, maximum) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum
  ) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function identifier(value, field, pattern = IDENTIFIER) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value), "utf8")
    .digest("hex");
}

function terminalTurnStatus(value) {
  return TERMINAL_TURN_STATUSES.has(
    String(value ?? "").replaceAll(/[_\s-]/gu, "").toLowerCase(),
  );
}

function successfulTurnStatus(value) {
  return SUCCESSFUL_TURN_STATUSES.has(
    String(value ?? "").replaceAll(/[_\s-]/gu, "").toLowerCase(),
  );
}

function interruptedTurnStatus(value) {
  return (
    String(value ?? "").replaceAll(/[_\s-]/gu, "").toLowerCase() ===
    "interrupted"
  );
}

function bootstrapIdFor(queenThreadId, idempotencyKey) {
  return `plan:${digest(["planning-lifecycle-v1", queenThreadId, idempotencyKey]).slice(0, 24)}`;
}

function launchActionId(bootstrapId) {
  return `planning-lifecycle-v1/${bootstrapId}/launch`;
}

function waitActionId(bootstrapId) {
  return `planning-lifecycle-v1/${bootstrapId}/wait`;
}

function readActionId(bootstrapId) {
  return `planning-lifecycle-v1/${bootstrapId}/read-result`;
}

function normalizeRequest(value) {
  exactObject(value, "planning lifecycle input", REQUEST_FIELDS);
  if (value.schemaVersion !== PLANNING_LIFECYCLE_SCHEMA_VERSION) {
    throw new Error(
      `planning lifecycle schemaVersion must be ${PLANNING_LIFECYCLE_SCHEMA_VERSION}`,
    );
  }
  const idempotencyKey = identifier(
    value.idempotencyKey,
    "idempotencyKey",
    IDEMPOTENCY_KEY,
  );
  const queenThreadId = identifier(value.queenThreadId, "queenThreadId");
  const objective = text(
    value.objective,
    "objective",
    MAX_PLANNING_OBJECTIVE_CHARACTERS,
  );
  const context = text(
    value.context,
    "context",
    MAX_PLANNING_CONTEXT_CHARACTERS,
    { optional: true },
  );
  const maxParallel = value.maxParallel ?? 4;
  if (
    !Number.isSafeInteger(maxParallel) ||
    maxParallel < 1 ||
    maxParallel > MAX_PARALLEL_SLICES
  ) {
    throw new Error(`maxParallel must be between 1 and ${MAX_PARALLEL_SLICES}`);
  }
  const cleanupIntended = value.cleanupIntended ?? true;
  if (typeof cleanupIntended !== "boolean") {
    throw new Error("cleanupIntended must be a boolean");
  }
  const derivedBootstrapId = bootstrapIdFor(queenThreadId, idempotencyKey);
  if (
    value.bootstrapId !== undefined &&
    identifier(value.bootstrapId, "bootstrapId", BOOTSTRAP_ID) !==
      derivedBootstrapId
  ) {
    throw new Error("bootstrapId conflicts with the planning idempotency key");
  }
  return {
    schemaVersion: PLANNING_LIFECYCLE_SCHEMA_VERSION,
    idempotencyKey,
    queenThreadId,
    objective,
    context,
    maxParallel,
    cleanupIntended,
    bootstrapId: derivedBootstrapId,
  };
}

function normalizeReceipt(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("planning lifecycle receipt must be null or a JSON object");
  }
  const fields =
    value.type === "native-planner-created"
      ? LAUNCH_RECEIPT_FIELDS
      : value.type === "native-planner-result"
        ? RESULT_RECEIPT_FIELDS
        : null;
  if (!fields) throw new Error("planning lifecycle receipt type is unsupported");
  exactObject(value, "planning lifecycle receipt", fields);
  if (value.schemaVersion !== PLANNING_LIFECYCLE_RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `planning lifecycle receipt schemaVersion must be ${PLANNING_LIFECYCLE_RECEIPT_SCHEMA_VERSION}`,
    );
  }
  const common = {
    schemaVersion: PLANNING_LIFECYCLE_RECEIPT_SCHEMA_VERSION,
    type: value.type,
    actionId: identifier(value.actionId, "receipt.actionId", ACTION_ID),
    bootstrapId: identifier(
      value.bootstrapId,
      "receipt.bootstrapId",
      BOOTSTRAP_ID,
    ),
  };
  if (value.type === "native-planner-created") {
    return {
      ...common,
      parentThreadId: identifier(
        value.parentThreadId,
        "receipt.parentThreadId",
      ),
      agentPath: identifier(value.agentPath, "receipt.agentPath", AGENT_PATH),
    };
  }
  return {
    ...common,
    threadId: identifier(value.threadId, "receipt.threadId"),
    turnId: identifier(value.turnId, "receipt.turnId"),
    response: rawText(
      value.response,
      "receipt.response",
      MAX_PLANNING_RESPONSE_CHARACTERS,
    ),
  };
}

function requestDigest(request) {
  return digest({
    schemaVersion: request.schemaVersion,
    idempotencyKey: request.idempotencyKey,
    queenThreadId: request.queenThreadId,
    objective: request.objective,
    context: request.context,
    maxParallel: request.maxParallel,
    ...(request.cleanupIntended === false ? { cleanupIntended: false } : {}),
  });
}

function requestDigestWithExplicitDefaultCleanup(request) {
  return digest({
    schemaVersion: request.schemaVersion,
    idempotencyKey: request.idempotencyKey,
    queenThreadId: request.queenThreadId,
    objective: request.objective,
    context: request.context,
    maxParallel: request.maxParallel,
    cleanupIntended: request.cleanupIntended,
  });
}

function normalizeRecord(value) {
  exactObject(value, "planning lifecycle record", RECORD_FIELDS);
  if (value.schemaVersion !== PLANNING_LIFECYCLE_SCHEMA_VERSION) {
    throw new Error("planning lifecycle record has an unsupported schema version");
  }
  const bootstrapId = identifier(value.bootstrapId, "record.bootstrapId", BOOTSTRAP_ID);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error("planning lifecycle record revision is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.requestDigest)) {
    throw new Error("planning lifecycle record request digest is invalid");
  }
  if (!PHASES.has(value.phase)) {
    throw new Error("planning lifecycle record phase is invalid");
  }
  const launchId = identifier(value.launchActionId, "record.launchActionId", ACTION_ID);
  if (launchId !== launchActionId(bootstrapId)) {
    throw new Error("planning lifecycle record launch action is invalid");
  }
  let identity = null;
  if (value.identity !== null) {
    exactObject(value.identity, "planning lifecycle identity", IDENTITY_FIELDS);
    identity = {
      parentThreadId: identifier(
        value.identity.parentThreadId,
        "record.identity.parentThreadId",
      ),
      agentPath: identifier(
        value.identity.agentPath,
        "record.identity.agentPath",
        AGENT_PATH,
      ),
      threadId: identifier(value.identity.threadId, "record.identity.threadId"),
    };
  }
  if (
    value.responseDigest !== null &&
    !/^[a-f0-9]{64}$/u.test(value.responseDigest)
  ) {
    throw new Error("planning lifecycle response digest is invalid");
  }
  if (
    value.attentionReason !== null &&
    (typeof value.attentionReason !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(value.attentionReason))
  ) {
    throw new Error("planning lifecycle attention reason is invalid");
  }
  const interruptedTurnReconciliations =
    value.interruptedTurnReconciliations ?? 0;
  if (
    !Number.isSafeInteger(interruptedTurnReconciliations) ||
    interruptedTurnReconciliations < 0 ||
    interruptedTurnReconciliations >
      MAX_INTERRUPTED_TURN_RECONCILIATIONS
  ) {
    throw new Error(
      "planning lifecycle interrupted-turn reconciliation count is invalid",
    );
  }
  if (
    !Array.isArray(value.consumedReceipts) ||
    value.consumedReceipts.length > 8
  ) {
    throw new Error("planning lifecycle receipt history is invalid");
  }
  const consumedReceipts = value.consumedReceipts.map((entry) => {
    exactObject(entry, "planning lifecycle receipt history entry", new Set(["actionId", "digest"]));
    const actionId = identifier(entry.actionId, "receipt history actionId", ACTION_ID);
    if (!/^[a-f0-9]{64}$/u.test(entry.digest)) {
      throw new Error("planning lifecycle receipt history digest is invalid");
    }
    return { actionId, digest: entry.digest };
  });
  if (new Set(consumedReceipts.map(({ actionId }) => actionId)).size !== consumedReceipts.length) {
    throw new Error("planning lifecycle receipt action IDs must be unique");
  }
  return {
    schemaVersion: PLANNING_LIFECYCLE_SCHEMA_VERSION,
    bootstrapId,
    revision: value.revision,
    requestDigest: value.requestDigest,
    phase: value.phase,
    launchActionId: launchId,
    identity,
    responseDigest: value.responseDigest,
    attentionReason: value.attentionReason,
    interruptedTurnReconciliations,
    consumedReceipts,
  };
}

export function planningLifecycleDirectory() {
  return join(taskStateDirectory(), "planning-lifecycles");
}

export class PlanningLifecycleStoreV1 {
  #directory;
  #fileSystem;
  #makeTemporaryId;

  constructor({
    directory = planningLifecycleDirectory(),
    fileSystem = defaultFileSystem,
    makeTemporaryId = randomUUID,
  } = {}) {
    this.#directory = directory;
    this.#fileSystem = fileSystem;
    this.#makeTemporaryId = makeTemporaryId;
  }

  #path(bootstrapId) {
    return join(
      this.#directory,
      `${encodeURIComponent(identifier(bootstrapId, "bootstrapId", BOOTSTRAP_ID))}.json`,
    );
  }

  async read(bootstrapId) {
    const path = this.#path(bootstrapId);
    try {
      const metadata = await this.#fileSystem.stat(path);
      if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) {
        throw new Error("planning lifecycle record is malformed");
      }
      return normalizeRecord(
        JSON.parse(await this.#fileSystem.readFile(path, "utf8")),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value, { expectedRevision }) {
    const record = normalizeRecord(value);
    const current = await this.read(record.bootstrapId);
    const actualRevision = current?.revision ?? 0;
    if (
      actualRevision !== expectedRevision ||
      record.revision !== actualRevision + 1
    ) {
      throw new Error("planning lifecycle revision conflict");
    }
    const source = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("planning lifecycle record is oversized");
    }
    await this.#fileSystem.mkdir(this.#directory, {
      recursive: true,
      mode: 0o700,
    });
    const target = this.#path(record.bootstrapId);
    const temporary = `${target}.${process.pid}.${this.#makeTemporaryId()}.tmp`;
    try {
      await this.#fileSystem.writeFile(temporary, source, {
        flag: "wx",
        mode: 0o600,
      });
      await this.#fileSystem.rename(temporary, target);
    } catch (error) {
      await this.#fileSystem.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return record;
  }
}

function receiptEntry(receipt) {
  return { actionId: receipt.actionId, digest: digest(receipt) };
}

function existingReceipt(record, receipt) {
  const entry = record.consumedReceipts.find(
    ({ actionId }) => actionId === receipt.actionId,
  );
  if (!entry) return false;
  if (entry.digest !== digest(receipt)) {
    throw new Error("planning lifecycle receipt conflicts with a consumed action");
  }
  return true;
}

function launchMember(bootstrap, actionId, parentThreadId) {
  return {
    ...bootstrap.planner,
    actionId,
    preconditions: {
      bootstrapId: bootstrap.bootstrapId,
      expectedPhase: "launch-pending",
      expectedParentThreadId: parentThreadId,
    },
  };
}

function lifecycleOutput(record, bootstrap, nextAction, fields = {}) {
  return {
    schemaVersion: PLANNING_LIFECYCLE_SCHEMA_VERSION,
    command: "plan lifecycle",
    lifecycle: {
      bootstrapId: record.bootstrapId,
      revision: record.revision,
      phase: record.phase,
      plannerThreadId: record.identity?.threadId ?? null,
    },
    bootstrap,
    ...fields,
    nextAction,
  };
}

function attentionAction(reason, fields = {}) {
  return {
    schemaVersion: 1,
    kind: "attention",
    reason,
    ...fields,
  };
}

function publicPlannerIdentity(identity) {
  return {
    ...identity,
    lifecycle: "subagent",
    memberKind: "joined-subagent",
    primaryId: "agentPath",
    controlSurface: "collaboration",
  };
}

function statusAction(
  record,
  thread,
  latestTurn,
  { reconciledInterruptedTurn = false } = {},
) {
  if (thread.status === "systemError") {
    return {
      schemaVersion: 1,
      kind: "attention",
      reason: "planner-system-error",
      threadId: thread.threadId,
    };
  }
  if (
    latestTurn === null ||
    !terminalTurnStatus(latestTurn.status) ||
    reconciledInterruptedTurn
  ) {
    return {
      schemaVersion: 1,
      kind: "native-wait-subagent",
      actionId: waitActionId(record.bootstrapId),
      agentPath: record.identity.agentPath,
      threadId: thread.threadId,
      turnId: latestTurn?.turnId ?? null,
      after: "repeat-planner-launch-receipt",
      ...(reconciledInterruptedTurn
        ? {
            reconciliation: {
              reason: "planner-turn-observation-conflict",
              retryable: true,
              appServerTurnStatus: "interrupted",
              nativeCollaborationStatus: "unavailable",
              observation: record.interruptedTurnReconciliations,
              maximumObservations:
                MAX_INTERRUPTED_TURN_RECONCILIATIONS,
            },
          }
        : {}),
    };
  }
  if (!successfulTurnStatus(latestTurn.status)) {
    return {
      schemaVersion: 1,
      kind: "attention",
      reason: "planner-turn-failed",
      threadId: thread.threadId,
      turnId: latestTurn.turnId,
    };
  }
  return {
    schemaVersion: 1,
    kind: "native-read-subagent-result",
    actionId: readActionId(record.bootstrapId),
    bootstrapId: record.bootstrapId,
    agentPath: record.identity.agentPath,
    threadId: thread.threadId,
    turnId: latestTurn.turnId,
    purpose: "read-planner-result",
  };
}

export class PlanningLifecycleCoordinatorV1 {
  #store;
  #sessionsRoot;
  #resolveSubagent;
  #verifyRoute;
  #withLock;

  constructor({
    store = new PlanningLifecycleStoreV1(),
    sessionsRoot = defaultCodexSessionsRoot(),
    resolveSubagent = resolveNativeSubagentThreadV1,
    verifyRoute = verifyRuntimeIntelligenceV1,
    withLock = withPlanningLifecycleLock,
  } = {}) {
    this.#store = store;
    this.#sessionsRoot = sessionsRoot;
    this.#resolveSubagent = resolveSubagent;
    this.#verifyRoute = verifyRoute;
    this.#withLock = withLock;
  }

  async #inspectVerified(
    record,
    request,
    appServerBridge,
    { turnId = undefined } = {},
  ) {
    const identity = record.identity;
    if (!identity || identity.parentThreadId !== request.queenThreadId) {
      throw new Error("planning lifecycle has no verified planner identity");
    }
    let route;
    try {
      route = await this.#verifyRoute({
        threadId: identity.threadId,
        model: PLANNER_ROUTE.requestedModel,
        effort: PLANNER_ROUTE.requestedEffort,
        ...(turnId ? { turnId } : {}),
        sessionsRoot: this.#sessionsRoot,
      });
    } catch {
      return { attentionReason: "planner-route-evidence-unavailable" };
    }
    if (route.verified !== true) {
      return { attentionReason: "planner-route-mismatch", route };
    }
    let thread;
    try {
      thread = await appServerBridge.inspect({ threadId: identity.threadId });
    } catch {
      return { attentionReason: "planner-thread-evidence-unavailable", route };
    }
    if (thread.parentThreadId !== request.queenThreadId) {
      return {
        attentionReason: "planner-topology-mismatch",
        route,
        thread,
      };
    }
    let latestTurn;
    try {
      latestTurn = await appServerBridge.latestTurn({
        threadId: identity.threadId,
      });
    } catch {
      return {
        attentionReason: "planner-turn-evidence-unavailable",
        route,
        thread,
      };
    }
    return { route, thread, latestTurn };
  }

  async #reconcileInterruptedTurn(record, latestTurn) {
    if (
      !interruptedTurnStatus(latestTurn?.status) ||
      record.interruptedTurnReconciliations >=
        MAX_INTERRUPTED_TURN_RECONCILIATIONS
    ) {
      return { record, reconciled: false };
    }
    const updated = await this.#store.write(
      {
        ...record,
        revision: record.revision + 1,
        interruptedTurnReconciliations:
          record.interruptedTurnReconciliations + 1,
      },
      { expectedRevision: record.revision },
    );
    return { record: updated, reconciled: true };
  }

  async advance(value, { appServerBridge, preservedSliceIds = [] }) {
    const request = normalizeRequest(value);
    const receipt = normalizeReceipt(value.receipt);
    const bootstrap = createPlanningBootstrapV1({
      objective: request.objective,
      ...(request.context ? { context: request.context } : {}),
      maxParallel: request.maxParallel,
      bootstrapId: request.bootstrapId,
    });
    const expectedRequestDigest = requestDigest(request);

    return this.#withLock(request.bootstrapId, async () => {
      let record = await this.#store.read(request.bootstrapId);
      if (!record) {
        if (receipt !== null) {
          throw new Error("planning lifecycle receipt arrived before preparation");
        }
        record = await this.#store.write(
          {
            schemaVersion: PLANNING_LIFECYCLE_SCHEMA_VERSION,
            bootstrapId: request.bootstrapId,
            revision: 1,
            requestDigest: expectedRequestDigest,
            phase: "launch-pending",
            launchActionId: launchActionId(request.bootstrapId),
            identity: null,
            responseDigest: null,
            attentionReason: null,
            interruptedTurnReconciliations: 0,
            consumedReceipts: [],
          },
          { expectedRevision: 0 },
        );
        return lifecycleOutput(record, bootstrap, {
          schemaVersion: 1,
          kind: "launch-planner",
          member: launchMember(
            bootstrap,
            record.launchActionId,
            request.queenThreadId,
          ),
        });
      }
      const compatibleRequestDigests = new Set([
        expectedRequestDigest,
        ...(request.cleanupIntended === true
          ? [requestDigestWithExplicitDefaultCleanup(request)]
          : []),
      ]);
      if (!compatibleRequestDigests.has(record.requestDigest)) {
        throw new Error("planning idempotency key is already bound to different intent");
      }

      if (receipt === null) {
        if (record.phase !== "launch-pending") {
          throw new Error("planning lifecycle receipt is required to advance");
        }
        return lifecycleOutput(record, bootstrap, {
          schemaVersion: 1,
          kind: "reconcile-planner-launch",
          actionId: `${record.launchActionId}/reconcile`,
          createActionId: record.launchActionId,
          policy: {
            onFound: "return-native-planner-created-receipt",
            onAbsent: "return-attention-before-retry",
            onAmbiguous: "return-attention",
          },
        });
      }
      if (receipt.bootstrapId !== record.bootstrapId) {
        throw new Error("planning lifecycle receipt has a stale bootstrapId");
      }

      if (receipt.type === "native-planner-created") {
        if (receipt.actionId !== record.launchActionId) {
          throw new Error("planner launch receipt has a stale or future actionId");
        }
        if (receipt.parentThreadId !== request.queenThreadId) {
          throw new Error("planner launch receipt has a conflicting parent task");
        }
        const replay = existingReceipt(record, receipt);
        if (replay && ["completed", "attention"].includes(record.phase)) {
          throw new Error(
            "planner launch receipt is stale after result finalization",
          );
        }
        let identity = record.identity;
        if (!replay) {
          if (!["launch-pending", "launched"].includes(record.phase)) {
            throw new Error("planner launch receipt arrived out of order");
          }
          let resolved;
          try {
            resolved = await this.#resolveSubagent({
              parentThreadId: receipt.parentThreadId,
              agentPath: receipt.agentPath,
              sessionsRoot: this.#sessionsRoot,
            });
          } catch {
            return lifecycleOutput(
              record,
              bootstrap,
              attentionAction("planner-identity-evidence-unavailable", {
                retryable: true,
                actionId: receipt.actionId,
              }),
            );
          }
          identity = {
            parentThreadId: receipt.parentThreadId,
            agentPath: receipt.agentPath,
            threadId: resolved.threadId,
          };
          record = await this.#store.write(
            {
              ...record,
              revision: record.revision + 1,
              phase: "launched",
              identity,
              consumedReceipts: [
                ...record.consumedReceipts,
                receiptEntry(receipt),
              ],
            },
            { expectedRevision: record.revision },
          );
        } else if (
          identity?.agentPath !== receipt.agentPath ||
          identity?.parentThreadId !== receipt.parentThreadId
        ) {
          throw new Error("planner launch receipt conflicts with bound identity");
        }

        const inspected = await this.#inspectVerified(
          { ...record, identity },
          request,
          appServerBridge,
        );
        if (inspected.attentionReason) {
          return lifecycleOutput(
            record,
            bootstrap,
            attentionAction(inspected.attentionReason, {
              retryable: inspected.attentionReason.endsWith("-unavailable"),
              actionId: receipt.actionId,
            }),
            {
              identity: { ...identity },
              ...(inspected.route ? { route: inspected.route } : {}),
              ...(inspected.thread ? { thread: inspected.thread } : {}),
            },
          );
        }
        const { route, thread, latestTurn } = inspected;
        if (record.phase !== "verified") {
          record = await this.#store.write(
            {
              ...record,
              revision: record.revision + 1,
              phase: "verified",
              identity,
            },
            { expectedRevision: record.revision },
          );
        }
        const reconciliation = await this.#reconcileInterruptedTurn(
          record,
          latestTurn,
        );
        record = reconciliation.record;
        return lifecycleOutput(
          record,
          bootstrap,
          statusAction(record, thread, latestTurn, {
            reconciledInterruptedTurn: reconciliation.reconciled,
          }),
          {
            identity: publicPlannerIdentity(identity),
            route,
            thread,
            latestTurn,
          },
        );
      }

      if (!["verified", "completed", "attention"].includes(record.phase)) {
        throw new Error("planner result receipt arrived before launch verification");
      }
      if (receipt.actionId !== readActionId(record.bootstrapId)) {
        if (record.phase === "verified") {
          throw new PlanningLifecycleProtocolError(
            "planner.result-not-yet-authorized",
            "planner result is not authorized yet; replay the verified launch receipt until Nelos returns native-read-subagent-result, then copy that actionId unchanged",
          );
        }
        throw new Error("planner result receipt has a stale or future actionId");
      }
      if (receipt.threadId !== record.identity?.threadId) {
        throw new Error("planner result receipt has a conflicting threadId");
      }
      const replay = existingReceipt(record, receipt);
      if (
        record.responseDigest !== null &&
        record.responseDigest !== digest(receipt.response)
      ) {
        throw new Error("planner result conflicts with the completed lifecycle");
      }
      if (replay && ["completed", "attention"].includes(record.phase)) {
        const finalized = finalizePlanningBootstrapV1(
          {
            objective: request.objective,
            ...(request.context ? { context: request.context } : {}),
            maxParallel: request.maxParallel,
            bootstrapId: request.bootstrapId,
          },
          receipt.response,
          { preservedSliceIds },
        );
        if (finalized.ready !== (record.phase === "completed")) {
          throw new Error("terminal planning lifecycle has an invalid result receipt");
        }
        if (!finalized.ready) {
          return lifecycleOutput(record, bootstrap, {
            schemaVersion: 1,
            kind: "attention",
            reason: finalized.reason,
            bootstrapId: finalized.bootstrapId,
            confidence: finalized.confidence,
            classificationEvidence: finalized.classificationEvidence,
          });
        }
        return lifecycleOutput(record, bootstrap, null, {
          planning: {
            bootstrapId: finalized.bootstrapId,
            confidence: finalized.confidence,
            classificationEvidence: finalized.classificationEvidence,
          },
          plan: finalized.plan,
        });
      }
      const inspected = await this.#inspectVerified(
        record,
        request,
        appServerBridge,
        { turnId: receipt.turnId },
      );
      if (inspected.attentionReason) {
        return lifecycleOutput(
          record,
          bootstrap,
          attentionAction(inspected.attentionReason, {
            retryable: inspected.attentionReason.endsWith("-unavailable"),
            actionId: receipt.actionId,
          }),
          {
            identity: publicPlannerIdentity(record.identity),
            ...(inspected.route ? { route: inspected.route } : {}),
            ...(inspected.thread ? { thread: inspected.thread } : {}),
          },
        );
      }
      const { thread, latestTurn } = inspected;
      if (thread.parentThreadId !== request.queenThreadId) {
        return lifecycleOutput(
          record,
          bootstrap,
          attentionAction("planner-result-topology-mismatch", {
            threadId: receipt.threadId,
          }),
          { thread },
        );
      }
      if (
        thread.status === "systemError" ||
        latestTurn === null ||
        !terminalTurnStatus(latestTurn.status)
      ) {
        return lifecycleOutput(
          record,
          bootstrap,
          statusAction(record, thread, latestTurn),
          {
            identity: publicPlannerIdentity(record.identity),
            thread,
            latestTurn,
          },
        );
      }
      if (latestTurn.turnId !== receipt.turnId) {
        return lifecycleOutput(
          record,
          bootstrap,
          attentionAction("planner-result-turn-not-terminal", {
            retryable: true,
            actionId: receipt.actionId,
          }),
        );
      }
      const reconciliation = await this.#reconcileInterruptedTurn(
        record,
        latestTurn,
      );
      record = reconciliation.record;
      if (reconciliation.reconciled) {
        return lifecycleOutput(
          record,
          bootstrap,
          statusAction(record, thread, latestTurn, {
            reconciledInterruptedTurn: true,
          }),
          {
            identity: publicPlannerIdentity(record.identity),
            thread,
            latestTurn,
          },
        );
      }
      if (!successfulTurnStatus(latestTurn.status)) {
        return lifecycleOutput(
          record,
          bootstrap,
          attentionAction("planner-result-turn-failed", {
            retryable: false,
            actionId: receipt.actionId,
            threadId: receipt.threadId,
            turnId: receipt.turnId,
          }),
        );
      }
      let route;
      try {
        route = await this.#verifyRoute({
          threadId: receipt.threadId,
          turnId: receipt.turnId,
          model: PLANNER_ROUTE.requestedModel,
          effort: PLANNER_ROUTE.requestedEffort,
          sessionsRoot: this.#sessionsRoot,
        });
      } catch {
        return lifecycleOutput(
          record,
          bootstrap,
          attentionAction("planner-result-route-evidence-unavailable", {
            retryable: true,
            actionId: receipt.actionId,
          }),
        );
      }
      if (route.verified !== true) {
        return lifecycleOutput(
          record,
          bootstrap,
          attentionAction("planner-result-route-mismatch", {
            actionId: receipt.actionId,
          }),
          { route },
        );
      }
      const finalized = finalizePlanningBootstrapV1(
        {
          objective: request.objective,
          ...(request.context ? { context: request.context } : {}),
          maxParallel: request.maxParallel,
          bootstrapId: request.bootstrapId,
        },
        receipt.response,
        { preservedSliceIds },
      );
      if (!replay) {
        record = await this.#store.write(
          {
            ...record,
            revision: record.revision + 1,
            phase: finalized.ready ? "completed" : "attention",
            responseDigest: digest(receipt.response),
            attentionReason: finalized.ready ? null : finalized.reason,
            consumedReceipts: [
              ...record.consumedReceipts,
              receiptEntry(receipt),
            ],
          },
          { expectedRevision: record.revision },
        );
      }
      if (!finalized.ready) {
        return lifecycleOutput(record, bootstrap, {
          schemaVersion: 1,
          kind: "attention",
          reason: finalized.reason,
          bootstrapId: finalized.bootstrapId,
          confidence: finalized.confidence,
          classificationEvidence: finalized.classificationEvidence,
        });
      }
      return lifecycleOutput(
        record,
        bootstrap,
        null,
        {
          planning: {
            bootstrapId: finalized.bootstrapId,
            confidence: finalized.confidence,
            classificationEvidence: finalized.classificationEvidence,
          },
          plan: finalized.plan,
          route,
          thread,
        },
      );
    });
  }
}

const RECEIPT_SCHEMA = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      properties: {
        schemaVersion: { const: PLANNING_LIFECYCLE_RECEIPT_SCHEMA_VERSION },
        type: { const: "native-planner-created" },
        actionId: { type: "string" },
        bootstrapId: { type: "string", pattern: "^plan:[a-f0-9]{24}$" },
        parentThreadId: { type: "string" },
        agentPath: { type: "string" },
      },
      required: [...LAUNCH_RECEIPT_FIELDS],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: PLANNING_LIFECYCLE_RECEIPT_SCHEMA_VERSION },
        type: { const: "native-planner-result" },
        actionId: { type: "string" },
        bootstrapId: { type: "string", pattern: "^plan:[a-f0-9]{24}$" },
        threadId: { type: "string" },
        turnId: { type: "string" },
        response: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PLANNING_RESPONSE_CHARACTERS,
        },
      },
      required: [...RESULT_RECEIPT_FIELDS],
      additionalProperties: false,
    },
  ],
};

export const PLANNING_LIFECYCLE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    schemaVersion: { const: PLANNING_LIFECYCLE_SCHEMA_VERSION },
    idempotencyKey: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    },
    queenThreadId: { type: "string" },
    objective: {
      type: "string",
      minLength: 1,
      maxLength: MAX_PLANNING_OBJECTIVE_CHARACTERS,
    },
    context: {
      type: "string",
      maxLength: MAX_PLANNING_CONTEXT_CHARACTERS,
    },
    maxParallel: {
      type: "integer",
      minimum: 1,
      maximum: MAX_PARALLEL_SLICES,
    },
    cleanupIntended: {
      type: "boolean",
      description:
        "Grant durable spin-offs archive capability for terminal cleanup. Defaults to true; cleanup still asks before archiving unless a preference says otherwise.",
    },
    bootstrapId: {
      type: "string",
      pattern: "^plan:[a-f0-9]{24}$",
    },
    receipt: RECEIPT_SCHEMA,
  },
  required: [
    "schemaVersion",
    "idempotencyKey",
    "queenThreadId",
    "objective",
    "receipt",
  ],
  additionalProperties: false,
});
