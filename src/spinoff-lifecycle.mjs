import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { join } from "node:path";

import { ExecutionStoreV1 } from "./execution-store.mjs";
import {
  NELOS_CLEANUP_POLICIES,
  NelosConfigurationV1,
} from "./nelos-configuration.mjs";
import { QueenAcceptanceStoreV1 } from "./queen-acceptance.mjs";
import { taskStateDirectory, withQueenSpinoffLock } from "./task-state.mjs";

export const SPINOFF_LIFECYCLE_SCHEMA_VERSION = 1;
export const SPINOFF_CLEANUP_POLICIES = NELOS_CLEANUP_POLICIES;

const MAX_RECORD_BYTES = 32 * 1024;
const MAX_SUMMARY_CHARACTERS = 2_000;
const ID = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const WORK_UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OUTCOMES = new Set(["succeeded", "blocked", "failed"]);
const WAKE_STATES = new Set([
  "pending",
  "delivering",
  "deferred",
  "delivered",
  "attention",
]);
const CLEANUP_STATES = new Set(["pending", "kept", "archiving", "archived", "attention"]);
const WAKE_RECEIPT_FIELDS = ["threadId"];
const ARCHIVE_RECEIPT_FIELDS = [
  "schemaVersion",
  "actionId",
  "type",
  "threadId",
  "archived",
];

export const SPINOFF_COMPLETE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    webId: { type: "string", minLength: 1, maxLength: 64 },
    queenThreadId: { type: "string", minLength: 1, maxLength: 512 },
    workUnitId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    specRevision: { type: "integer", minimum: 1 },
    attempt: { type: "integer", minimum: 1 },
    memberThreadId: { type: "string", minLength: 1, maxLength: 512 },
    outcome: { type: "string", enum: [...OUTCOMES] },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SUMMARY_CHARACTERS,
    },
    receipt: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            threadId: { type: "string", minLength: 1, maxLength: 512 },
          },
          required: WAKE_RECEIPT_FIELDS,
          additionalProperties: false,
        },
      ],
    },
  },
  required: [
    "webId", "queenThreadId", "workUnitId", "specRevision", "attempt",
    "memberThreadId", "outcome", "summary", "receipt",
  ],
  additionalProperties: false,
});

export const SPINOFF_CLEANUP_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    webId: { type: "string", minLength: 1, maxLength: 64 },
    queenThreadId: { type: "string", minLength: 1, maxLength: 512 },
    policy: { type: "string", enum: SPINOFF_CLEANUP_POLICIES },
    rememberPolicy: { type: "boolean" },
    userIntentConfirmed: { type: "boolean", const: true },
    confirmedThreadIds: {
      type: "array",
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 512 },
    },
    archiveReceipts: {
      type: "array",
      maxItems: 100,
      uniqueItems: true,
      items: {
        type: "object",
        properties: {
          schemaVersion: { const: 1 },
          actionId: { type: "string", minLength: 1, maxLength: 512 },
          type: { const: "native-archive" },
          threadId: { type: "string", minLength: 1, maxLength: 512 },
          archived: { const: true },
        },
        required: ARCHIVE_RECEIPT_FIELDS,
        additionalProperties: false,
      },
    },
  },
  required: ["webId", "queenThreadId"],
  additionalProperties: false,
});

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new Error(`${label} has an incompatible shape`);
  }
  return value;
}

function id(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function text(value, label, maximum = 1_000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value
    .replaceAll(/[\u0000-\u001f\u007f]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} has an invalid length`);
  }
  return normalized;
}

function timestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function lifecycleIdentity(value) {
  return {
    webId: id(value.webId, "webId"),
    queenThreadId: id(value.queenThreadId, "queenThreadId"),
    workUnitId: id(value.workUnitId, "workUnitId", WORK_UNIT_ID),
    specRevision: positive(value.specRevision, "specRevision"),
    attempt: positive(value.attempt, "attempt"),
    memberThreadId: id(value.memberThreadId, "memberThreadId"),
  };
}

export function spinoffWakeIdV1(value) {
  const identity = lifecycleIdentity(value);
  const digest = createHash("sha256")
    .update(JSON.stringify(Object.values(identity)), "utf8")
    .digest("base64url");
  return `spinoff-wake-v1:${digest}`;
}

export function validateSpinoffCompletionV1(value) {
  exact(value, [
    "webId", "queenThreadId", "workUnitId", "specRevision", "attempt",
    "memberThreadId", "outcome", "summary", "receipt",
  ], "spinoff completion");
  const identity = lifecycleIdentity(value);
  if (!OUTCOMES.has(value.outcome)) throw new Error("outcome is invalid");
  return {
    ...identity,
    outcome: value.outcome,
    summary: text(value.summary, "summary", MAX_SUMMARY_CHARACTERS),
    receipt: validateWakeReceipt(value.receipt, identity),
  };
}

function wakeActionId(identity) {
  return `${spinoffWakeIdV1(identity)}/native-send-message`;
}

function archiveActionId(identity) {
  return `${spinoffWakeIdV1(identity)}/native-archive`;
}

function validateWakeReceipt(value, identity) {
  if (value === null) return null;
  exact(value, WAKE_RECEIPT_FIELDS, "native send-message host result");
  if (value.threadId !== identity.queenThreadId) {
    throw new Error("native send-message host result is stale or conflicting");
  }
  return { threadId: value.threadId };
}

function validateArchiveReceipt(value) {
  exact(value, ARCHIVE_RECEIPT_FIELDS, "native archive receipt");
  if (
    value.schemaVersion !== 1 ||
    value.type !== "native-archive" ||
    value.archived !== true
  ) {
    throw new Error("native archive receipt is invalid");
  }
  return {
    schemaVersion: 1,
    actionId: id(value.actionId, "archive receipt actionId"),
    type: "native-archive",
    threadId: id(value.threadId, "archive receipt threadId"),
    archived: true,
  };
}

function validateRecord(value) {
  exact(value, [
    "schemaVersion", "revision", "wakeId", "clientUserMessageId", "webId",
    "queenThreadId", "workUnitId", "specRevision", "attempt", "memberThreadId",
    "outcome", "summary", "wakeState", "wakeReason", "queenTurnId",
    "cleanupState", "cleanupPolicy", "createdAt", "updatedAt",
  ], "spinoff lifecycle record");
  if (value.schemaVersion !== SPINOFF_LIFECYCLE_SCHEMA_VERSION) {
    throw new Error("spinoff lifecycle schemaVersion is unsupported");
  }
  const identity = lifecycleIdentity(value);
  const wakeId = spinoffWakeIdV1(identity);
  if (value.wakeId !== wakeId || value.clientUserMessageId !== wakeId) {
    throw new Error("spinoff lifecycle wake identity is invalid");
  }
  if (!OUTCOMES.has(value.outcome) || !WAKE_STATES.has(value.wakeState)) {
    throw new Error("spinoff lifecycle wake state is invalid");
  }
  if (!CLEANUP_STATES.has(value.cleanupState)) {
    throw new Error("spinoff lifecycle cleanup state is invalid");
  }
  if (
    value.cleanupPolicy !== null &&
    !SPINOFF_CLEANUP_POLICIES.includes(value.cleanupPolicy)
  ) {
    throw new Error("spinoff lifecycle cleanup policy is invalid");
  }
  return {
    schemaVersion: SPINOFF_LIFECYCLE_SCHEMA_VERSION,
    revision: positive(value.revision, "revision"),
    wakeId,
    clientUserMessageId: wakeId,
    ...identity,
    outcome: value.outcome,
    summary: text(value.summary, "summary", MAX_SUMMARY_CHARACTERS),
    wakeState: value.wakeState,
    wakeReason:
      value.wakeReason === null ? null : text(value.wakeReason, "wakeReason", 128),
    queenTurnId:
      value.queenTurnId === null ? null : id(value.queenTurnId, "queenTurnId"),
    cleanupState: value.cleanupState,
    cleanupPolicy: value.cleanupPolicy,
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
  };
}

function initialRecord(completion, now) {
  const identity = validateSpinoffCompletionV1({
    ...completion,
    receipt: completion.receipt ?? null,
  });
  const wakeId = spinoffWakeIdV1(identity);
  return validateRecord({
    schemaVersion: SPINOFF_LIFECYCLE_SCHEMA_VERSION,
    revision: 1,
    wakeId,
    clientUserMessageId: wakeId,
    ...lifecycleIdentity(identity),
    outcome: identity.outcome,
    summary: identity.summary,
    wakeState: "pending",
    wakeReason: null,
    queenTurnId: null,
    cleanupState: "pending",
    cleanupPolicy: null,
    createdAt: now,
    updatedAt: now,
  });
}

function serialize(record) {
  const source = `${JSON.stringify(validateRecord(record), null, 2)}\n`;
  if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("spinoff lifecycle record is oversized");
  }
  return source;
}

export function spinoffLifecycleDirectory() {
  return join(taskStateDirectory(), "spinoff-lifecycle");
}

export class SpinoffLifecycleStoreV1 {
  #directory;
  #fileSystem;
  #makeTemporaryId;

  constructor({
    directory = spinoffLifecycleDirectory(),
    fileSystem = defaultFileSystem,
    makeTemporaryId = randomUUID,
  } = {}) {
    this.#directory = directory;
    this.#fileSystem = fileSystem;
    this.#makeTemporaryId = makeTemporaryId;
  }

  #path(wakeId) {
    return join(
      this.#directory,
      `${createHash("sha256").update(wakeId).digest("hex")}.json`,
    );
  }

  async read(wakeId) {
    const resolvedWakeId = id(wakeId, "wakeId");
    try {
      const path = this.#path(resolvedWakeId);
      const metadata = await this.#fileSystem.stat(path);
      if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) {
        throw new Error("spinoff lifecycle record is malformed");
      }
      const record = validateRecord(
        JSON.parse(await this.#fileSystem.readFile(path, "utf8")),
      );
      if (record.wakeId !== resolvedWakeId) {
        throw new Error("spinoff lifecycle record identity is mismatched");
      }
      return record;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(record, { expectedRevision = 0 } = {}) {
    const normalized = validateRecord(record);
    const current = await this.read(normalized.wakeId);
    if (
      (current?.revision ?? 0) !== expectedRevision ||
      normalized.revision !== expectedRevision + 1
    ) {
      throw new Error("spinoff lifecycle revision conflict");
    }
    await this.#fileSystem.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const target = this.#path(normalized.wakeId);
    const temporary = `${target}.${process.pid}.${this.#makeTemporaryId()}.tmp`;
    try {
      await this.#fileSystem.writeFile(temporary, serialize(normalized), {
        flag: "wx",
        mode: 0o600,
      });
      await this.#fileSystem.rename(temporary, target);
    } catch (error) {
      await this.#fileSystem.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return normalized;
  }

  async preference() {
    try {
      const parsed = JSON.parse(
        await this.#fileSystem.readFile(join(this.#directory, "preference.json"), "utf8"),
      );
      return SPINOFF_CLEANUP_POLICIES.includes(parsed?.policy)
        ? parsed.policy
        : "ask";
    } catch (error) {
      if (error?.code === "ENOENT") return "ask";
      return "ask";
    }
  }

  async rememberPreference(policy) {
    if (!SPINOFF_CLEANUP_POLICIES.includes(policy)) {
      throw new Error("cleanup policy is invalid");
    }
    await this.#fileSystem.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const target = join(this.#directory, "preference.json");
    const temporary = `${target}.${process.pid}.${this.#makeTemporaryId()}.tmp`;
    await this.#fileSystem.writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, policy }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await this.#fileSystem.rename(temporary, target);
    return policy;
  }
}

function assertWorkUnitMatches(workUnit, identity) {
  if (
    !workUnit ||
    workUnit.webId !== identity.webId ||
    workUnit.queenThreadId !== identity.queenThreadId ||
    workUnit.workUnitId !== identity.workUnitId ||
    workUnit.specRevision !== identity.specRevision ||
    workUnit.attempt !== identity.attempt ||
    workUnit.memberKind !== "spinoff" ||
    workUnit.binding.state !== "bound" ||
    workUnit.binding.memberThreadId !== identity.memberThreadId
  ) {
    throw new Error("spinoff completion does not match a bound durable work unit");
  }
}

function wakeMessage(completion) {
  return [
    `Nelos spin-off completed: ${completion.workUnitId}`,
    `Outcome: ${completion.outcome}`,
    `Summary: ${completion.summary}`,
    `Spin-off task: ${completion.memberThreadId}`,
    "",
    "Resume the persisted Nelos join for this web, read the bounded current result,",
    "and decide whether it meets the recorded acceptance criteria.",
  ].join("\n");
}

function sameCompletion(record, completion) {
  return [
    "webId", "queenThreadId", "workUnitId", "specRevision", "attempt",
    "memberThreadId", "outcome", "summary",
  ].every((field) => record[field] === completion[field]);
}

export class SpinoffLifecycleAdapterV1 {
  #executionStore;
  #acceptanceStore;
  #store;
  #configuration;
  #now;

  constructor({
    executionStore = new ExecutionStoreV1(),
    acceptanceStore = new QueenAcceptanceStoreV1(),
    store = new SpinoffLifecycleStoreV1(),
    configuration = new NelosConfigurationV1(),
    now = () => new Date().toISOString(),
  } = {}) {
    this.#executionStore = executionStore;
    this.#acceptanceStore = acceptanceStore;
    this.#store = store;
    this.#configuration = configuration;
    this.#now = now;
  }

  #rememberPolicy(policy) {
    return this.#configuration.set({
      key: "spinoffs.cleanup_policy",
      value: policy,
      userIntentConfirmed: true,
    });
  }

  async complete(value) {
    const completion = validateSpinoffCompletionV1(value);
    const workUnit = await this.#executionStore.read(completion.workUnitId);
    assertWorkUnitMatches(workUnit, completion);
    return withQueenSpinoffLock(completion.queenThreadId, async () => {
      const wakeId = spinoffWakeIdV1(completion);
      let record = await this.#store.read(wakeId);
      if (record && !sameCompletion(record, completion)) {
        throw new Error("spinoff completion identity already has conflicting content");
      }
      if (!record) {
        record = await this.#store.write(
          initialRecord(completion, this.#now()),
          { expectedRevision: 0 },
        );
      }
      if (record.wakeState === "delivered") {
        return { schemaVersion: 1, replayed: true, record };
      }
      if (record.wakeState === "attention") {
        return { schemaVersion: 1, replayed: true, record };
      }
      if (completion.receipt !== null) {
        if (record.wakeState !== "delivering") {
          throw new Error("native send-message receipt has no pending effect");
        }
        record = await this.#store.write({
          ...record,
          revision: record.revision + 1,
          wakeState: "delivered",
          wakeReason: null,
          queenTurnId: null,
          updatedAt: this.#now(),
        }, { expectedRevision: record.revision });
        return {
          schemaVersion: 1,
          replayed: false,
          record,
          effects: [],
        };
      }
      if (record.wakeState === "delivering") {
        return {
          schemaVersion: 1,
          replayed: true,
          record,
          effects: [{
            schemaVersion: 1,
            actionId: `${wakeActionId(completion)}/reconcile`,
            type: "native-reconcile-send-message",
            originalActionId: wakeActionId(completion),
            threadId: completion.queenThreadId,
            policy: {
              onFound: "return-exact-send-message-host-result",
              onAbsent: "return-attention-before-retry",
              onAmbiguous: "return-attention",
            },
          }],
        };
      }
      record = await this.#store.write({
        ...record,
        revision: record.revision + 1,
        wakeState: "delivering",
        wakeReason: null,
        updatedAt: this.#now(),
      }, { expectedRevision: record.revision });
      return {
        schemaVersion: 1,
        replayed: false,
        record,
        effects: [{
          schemaVersion: 1,
          actionId: wakeActionId(completion),
          type: "native-send-message",
          threadId: completion.queenThreadId,
          prompt: wakeMessage(completion),
          preconditions: {
            expectedCallerThreadId: completion.memberThreadId,
            expectedBoundMemberThreadId: completion.memberThreadId,
          },
        }],
      };
    });
  }

  async cleanup({
    webId,
    queenThreadId,
    policy = null,
    rememberPolicy = false,
    userIntentConfirmed = false,
    confirmedThreadIds,
    archiveReceipts = [],
  } = {}) {
    const identity = {
      webId: id(webId, "webId"),
      queenThreadId: id(queenThreadId, "queenThreadId"),
    };
    if (typeof rememberPolicy !== "boolean") {
      throw new Error("rememberPolicy must be a boolean");
    }
    if (typeof userIntentConfirmed !== "boolean") {
      throw new Error("userIntentConfirmed must be a boolean");
    }
    if (
      rememberPolicy &&
      (policy === null || userIntentConfirmed !== true)
    ) {
      throw new Error(
        "remembering a cleanup policy requires an explicit policy and user intent",
      );
    }
    if (
      confirmedThreadIds !== undefined &&
      (
        !Array.isArray(confirmedThreadIds) ||
        confirmedThreadIds.length > 100 ||
        new Set(confirmedThreadIds).size !== confirmedThreadIds.length
      )
    ) {
      throw new Error("confirmedThreadIds must contain at most 100 unique task IDs");
    }
    if (!Array.isArray(archiveReceipts) || archiveReceipts.length > 100) {
      throw new Error("archiveReceipts must contain at most 100 receipts");
    }
    const receiptByThreadId = new Map();
    for (const value of archiveReceipts) {
      const receipt = validateArchiveReceipt(value);
      if (receiptByThreadId.has(receipt.threadId)) {
        throw new Error("archiveReceipts must identify unique task IDs");
      }
      receiptByThreadId.set(receipt.threadId, receipt);
    }
    const requestedPolicy = policy === null
      ? (await this.#configuration.get()).setting.value
      : policy;
    if (!SPINOFF_CLEANUP_POLICIES.includes(requestedPolicy)) {
      throw new Error("cleanup policy is invalid");
    }
    const [workUnits, decisions] = await Promise.all([
      this.#executionStore.list(),
      this.#acceptanceStore.list(identity),
    ]);
    const accepted = new Map(
      decisions
        .filter((decision) => decision.decision === "accepted")
        .map((decision) => [decision.workUnitId, decision]),
    );
    const requiredCurrent = workUnits.filter(
      (workUnit) =>
        workUnit.webId === identity.webId &&
        workUnit.queenThreadId === identity.queenThreadId &&
        workUnit.memberKind === "spinoff" &&
        workUnit.required,
    );
    const pendingRequired = requiredCurrent.filter((workUnit) => {
      const decision = accepted.get(workUnit.workUnitId);
      return !(
        workUnit.binding.state === "bound" &&
        decision?.result?.outcome === "succeeded" &&
        decision?.specRevision === workUnit.specRevision &&
        decision?.attempt === workUnit.attempt &&
        decision?.memberThreadId === workUnit.binding.memberThreadId
      );
    });
    if (pendingRequired.length > 0) {
      return {
        schemaVersion: 1,
        policy: requestedPolicy,
        state: "not-ready",
        pending: pendingRequired
          .sort((left, right) =>
            left.workUnitId.localeCompare(right.workUnitId),
          )
          .map((workUnit) => ({
            workUnitId: workUnit.workUnitId,
            threadId:
              workUnit.binding.state === "bound"
                ? workUnit.binding.memberThreadId
                : null,
            title: workUnit.title,
          })),
      };
    }
    const eligible = workUnits
      .filter((workUnit) => {
        const decision = accepted.get(workUnit.workUnitId);
        return (
          workUnit.webId === identity.webId &&
          workUnit.queenThreadId === identity.queenThreadId &&
          workUnit.memberKind === "spinoff" &&
          workUnit.required &&
          workUnit.capabilities.includes("archive") &&
          workUnit.binding.state === "bound" &&
          decision?.result?.outcome === "succeeded" &&
          decision?.specRevision === workUnit.specRevision &&
          decision?.attempt === workUnit.attempt &&
          decision?.memberThreadId === workUnit.binding.memberThreadId
        );
      })
      .map((workUnit) => ({
        workUnit,
        decision: accepted.get(workUnit.workUnitId),
        threadId: workUnit.binding.memberThreadId,
        title: workUnit.title,
      }))
      .sort((left, right) => left.workUnit.workUnitId.localeCompare(right.workUnit.workUnitId));
    const candidateBlueprints = eligible.map((candidate) => ({
      ...candidate,
      completion: {
        ...identity,
        workUnitId: candidate.workUnit.workUnitId,
        specRevision: candidate.workUnit.specRevision,
        attempt: candidate.workUnit.attempt,
        memberThreadId: candidate.threadId,
        outcome: candidate.decision.result.outcome,
        summary: candidate.decision.result.summary,
      },
    }));
    const {
      resolvedPolicy,
      records: snapshotRecords,
    } = await withQueenSpinoffLock(
      identity.queenThreadId,
      async () => {
        const records = await Promise.all(
          candidateBlueprints.map(({ completion }) =>
            this.#store.read(spinoffWakeIdV1(completion)),
          ),
        );
        const activeRecords = records.filter(
          (record) =>
            record !== null &&
            !["archived", "kept"].includes(record.cleanupState),
        );
        const activePolicies = new Set(
          activeRecords
            .map((record) => record?.cleanupPolicy ?? null)
            .filter((value) => value !== null),
        );
        if (activePolicies.size > 1) {
          throw new Error("cleanup policy snapshots conflict within the web");
        }
        const terminalPolicies = new Set(
          records
            .filter((record) =>
              record !== null &&
              ["archived", "kept"].includes(record.cleanupState),
            )
            .map((record) => record.cleanupPolicy)
            .filter((value) => value !== null),
        );
        const snapshot =
          activePolicies.values().next().value ??
          (
            terminalPolicies.size === 1
              ? terminalPolicies.values().next().value
              : requestedPolicy
          );
        const settledRecords = [...records];
        for (
          let index = 0;
          index < candidateBlueprints.length;
          index += 1
        ) {
          const completion = candidateBlueprints[index].completion;
          const record = records[index];
          if (
            record !== null &&
            ["archived", "kept"].includes(record.cleanupState)
          ) {
            continue;
          }
          if (!record) {
            const initial = initialRecord(completion, this.#now());
            settledRecords[index] = await this.#store.write({
              ...initial,
              cleanupPolicy: snapshot,
            }, { expectedRevision: 0 });
          } else if (record.cleanupPolicy === null) {
            settledRecords[index] = await this.#store.write({
              ...record,
              revision: record.revision + 1,
              cleanupPolicy: snapshot,
              updatedAt: this.#now(),
            }, { expectedRevision: record.revision });
          } else if (record.cleanupPolicy !== snapshot) {
            throw new Error("cleanup policy snapshot is conflicting");
          }
        }
        return {
          resolvedPolicy: snapshot,
          records: settledRecords,
        };
      },
    );
    const allCandidates = candidateBlueprints.map(
      (candidate, index) => ({
        ...candidate,
        record: snapshotRecords[index],
      }),
    );
    const candidates = allCandidates.filter(
      ({ record }) =>
        !["archived", "kept"].includes(record?.cleanupState),
    );
    const archiveInFlight = candidates.some(
      ({ record }) => record?.cleanupState === "archiving",
    );

    if (
      resolvedPolicy === "ask" &&
      confirmedThreadIds === undefined &&
      receiptByThreadId.size === 0 &&
      !archiveInFlight
    ) {
      if (rememberPolicy) {
        await this.#rememberPolicy(policy);
      }
      return {
        schemaVersion: 1,
        policy: resolvedPolicy,
        state: candidates.length > 0 ? "confirmation-required" : "complete",
        candidates: candidates.map(({ workUnit, threadId, title }) => ({
          workUnitId: workUnit.workUnitId,
          threadId,
          title,
          model: workUnit.launch?.nativeTask?.model ?? "host-default",
          reasoning:
            workUnit.launch?.nativeTask?.thinking ?? "host-default",
        })),
      };
    }

    const reconciliationCandidates =
      confirmedThreadIds === undefined ? candidates : allCandidates;
    const confirmed = confirmedThreadIds === undefined
      ? new Set(
          candidates
            .filter(({ record, threadId }) =>
              resolvedPolicy !== "ask" ||
              record?.cleanupState === "archiving" ||
              receiptByThreadId.has(threadId),
            )
            .map(({ threadId }) => threadId),
        )
      : new Set(confirmedThreadIds.map((thread) => id(thread, "confirmedThreadId")));
    const candidateIds = new Set(
      reconciliationCandidates.map(({ threadId }) => threadId),
    );
    if ([...confirmed].some((thread) => !candidateIds.has(thread))) {
      throw new Error("cleanup confirmation contains an ineligible spin-off");
    }
    if (rememberPolicy) {
      await this.#rememberPolicy(policy);
    }
    const selected = reconciliationCandidates.filter(
      ({ threadId }) => confirmed.has(threadId),
    );
    for (const candidate of allCandidates) {
      if (
        receiptByThreadId.has(candidate.threadId) &&
        candidate.record?.cleanupState === "archived" &&
        !selected.some(({ threadId }) => threadId === candidate.threadId)
      ) {
        selected.push(candidate);
      }
    }
    if (
      [...receiptByThreadId.keys()].some(
        (threadId) => !selected.some((candidate) => candidate.threadId === threadId),
      )
    ) {
      throw new Error("archive receipt identifies an unselected spin-off");
    }
    const results = [];
    const effects = [];
    const cleanupResult = (candidate, state, details = {}) => ({
      workUnitId: candidate.workUnit.workUnitId,
      threadId: candidate.threadId,
      title: candidate.title,
      model:
        candidate.workUnit.launch?.nativeTask?.model ?? "host-default",
      reasoning:
        candidate.workUnit.launch?.nativeTask?.thinking ?? "host-default",
      state,
      ...details,
    });
    for (const candidate of selected) {
      const completion = candidate.completion;
      try {
        await withQueenSpinoffLock(identity.queenThreadId, async () => {
          const wakeId = spinoffWakeIdV1(completion);
          let record = await this.#store.read(wakeId);
          if (!record) {
            record = await this.#store.write(
              initialRecord(completion, this.#now()),
              { expectedRevision: 0 },
            );
          }
          if (record.cleanupState === "archived") {
            const receipt = receiptByThreadId.get(candidate.threadId);
            if (
              receipt &&
              receipt.actionId !== archiveActionId(completion)
            ) {
              throw new Error("native archive receipt is stale or conflicting");
            }
            results.push(cleanupResult(candidate, "archived", {
              replayed: true,
            }));
            return;
          }
          if (record.cleanupState === "kept") {
            results.push(cleanupResult(candidate, "kept", {
              replayed: true,
            }));
            return;
          }
          if (record.cleanupState === "attention") {
            results.push(cleanupResult(candidate, "attention", {
              reason: "prior-archive-attention",
            }));
            return;
          }
          if (
            record.cleanupPolicy !== null &&
            record.cleanupPolicy !== resolvedPolicy
          ) {
            throw new Error("cleanup policy snapshot is conflicting");
          }
          if (record.cleanupState === "archiving") {
            const receipt = receiptByThreadId.get(candidate.threadId);
            if (receipt) {
              if (receipt.actionId !== archiveActionId(completion)) {
                throw new Error("native archive receipt is stale or conflicting");
              }
              record = await this.#store.write({
                ...record,
                revision: record.revision + 1,
                cleanupState: "archived",
                updatedAt: this.#now(),
              }, { expectedRevision: record.revision });
              results.push(cleanupResult(candidate, "archived", {
                replayed: false,
              }));
              return;
            }
            effects.push({
              schemaVersion: 1,
              actionId: `${archiveActionId(completion)}/reconcile`,
              type: "native-reconcile-archive",
              originalActionId: archiveActionId(completion),
              threadId: candidate.threadId,
              policy: {
                onFound: "return-native-archive-receipt",
                onAbsent: "return-attention-before-retry",
                onAmbiguous: "return-attention",
              },
            });
            results.push(cleanupResult(candidate, "archiving", {
              replayed: true,
            }));
            return;
          }
          if (receiptByThreadId.has(candidate.threadId)) {
            throw new Error("native archive receipt has no pending effect");
          }
          if (resolvedPolicy === "keep") {
            record = await this.#store.write({
              ...record,
              revision: record.revision + 1,
              cleanupState: "kept",
              cleanupPolicy: resolvedPolicy,
              updatedAt: this.#now(),
            }, { expectedRevision: record.revision });
            results.push(cleanupResult(candidate, "kept", {
              replayed: false,
            }));
            return;
          }
          record = await this.#store.write({
            ...record,
            revision: record.revision + 1,
            cleanupState: "archiving",
            cleanupPolicy: resolvedPolicy,
            updatedAt: this.#now(),
          }, { expectedRevision: record.revision });
          effects.push({
            schemaVersion: 1,
            actionId: archiveActionId(completion),
            type: "native-archive",
            threadId: candidate.threadId,
            archived: true,
            preconditions: {
              expectedQueenThreadId: identity.queenThreadId,
              expectedAcceptedWorkUnitId: candidate.workUnit.workUnitId,
            },
          });
          results.push(cleanupResult(candidate, "archiving", {
            replayed: false,
          }));
        });
      } catch {
        results.push(cleanupResult(candidate, "attention", {
          reason: "cleanup-candidate-failed",
        }));
      }
    }
    return {
      schemaVersion: 1,
      policy: resolvedPolicy,
      state: effects.length > 0
        ? "effects-required"
        : results.some(({ state }) => state === "attention")
        ? "attention"
        : "complete",
      results,
      effects,
    };
  }
}
