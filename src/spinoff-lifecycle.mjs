import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { join } from "node:path";

import { ExecutionStoreV1 } from "./execution-store.mjs";
import { QueenAcceptanceStoreV1 } from "./queen-acceptance.mjs";
import { taskStateDirectory, withQueenSpinoffLock } from "./task-state.mjs";

export const SPINOFF_LIFECYCLE_SCHEMA_VERSION = 1;
export const SPINOFF_CLEANUP_POLICIES = Object.freeze(["ask", "auto", "keep"]);

const MAX_RECORD_BYTES = 32 * 1024;
const MAX_SUMMARY_CHARACTERS = 2_000;
const ID = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const WORK_UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OUTCOMES = new Set(["succeeded", "blocked", "failed"]);
const WAKE_STATES = new Set(["pending", "deferred", "delivered", "attention"]);
const CLEANUP_STATES = new Set(["pending", "kept", "archiving", "archived", "attention"]);

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
  },
  required: [
    "webId", "queenThreadId", "workUnitId", "specRevision", "attempt",
    "memberThreadId", "outcome", "summary",
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
    confirmedThreadIds: {
      type: "array",
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 512 },
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
    "memberThreadId", "outcome", "summary",
  ], "spinoff completion");
  const identity = lifecycleIdentity(value);
  if (!OUTCOMES.has(value.outcome)) throw new Error("outcome is invalid");
  return {
    ...identity,
    outcome: value.outcome,
    summary: text(value.summary, "summary", MAX_SUMMARY_CHARACTERS),
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
  const identity = validateSpinoffCompletionV1(completion);
  const wakeId = spinoffWakeIdV1(identity);
  return validateRecord({
    schemaVersion: SPINOFF_LIFECYCLE_SCHEMA_VERSION,
    revision: 1,
    wakeId,
    clientUserMessageId: wakeId,
    ...identity,
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
  #callerThreadId;
  #now;

  constructor({
    executionStore = new ExecutionStoreV1(),
    acceptanceStore = new QueenAcceptanceStoreV1(),
    store = new SpinoffLifecycleStoreV1(),
    callerThreadId = () => process.env.CODEX_THREAD_ID ?? null,
    now = () => new Date().toISOString(),
  } = {}) {
    this.#executionStore = executionStore;
    this.#acceptanceStore = acceptanceStore;
    this.#store = store;
    this.#callerThreadId = callerThreadId;
    this.#now = now;
  }

  async complete(value, appServerBridge) {
    const completion = validateSpinoffCompletionV1(value);
    if (this.#callerThreadId() !== completion.memberThreadId) {
      throw new Error("only the bound spin-off may deliver its completion wake");
    }
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
      try {
        const delivery = await appServerBridge.deliverParentWake({
          queenThreadId: completion.queenThreadId,
          clientUserMessageId: record.clientUserMessageId,
          message: wakeMessage(completion),
        });
        record = await this.#store.write({
          ...record,
          revision: record.revision + 1,
          wakeState: delivery.delivered ? "delivered" : "deferred",
          wakeReason: delivery.reason ?? null,
          queenTurnId: delivery.queenTurnId,
          updatedAt: this.#now(),
        }, { expectedRevision: record.revision });
        return {
          schemaVersion: 1,
          replayed: delivery.replayed,
          delivery,
          record,
        };
      } catch (error) {
        record = await this.#store.write({
          ...record,
          revision: record.revision + 1,
          wakeState: error?.mutationUncertain ? "attention" : "pending",
          wakeReason: error?.mutationUncertain
            ? "delivery-uncertain"
            : "delivery-rejected",
          updatedAt: this.#now(),
        }, { expectedRevision: record.revision });
        const wrapped = new Error(
          `${error.message}; completion was persisted as ${record.wakeState}`,
        );
        wrapped.cause = error;
        throw wrapped;
      }
    });
  }

  async cleanup({
    webId,
    queenThreadId,
    policy = null,
    rememberPolicy = false,
    confirmedThreadIds,
  } = {}, appServerBridge) {
    const identity = {
      webId: id(webId, "webId"),
      queenThreadId: id(queenThreadId, "queenThreadId"),
    };
    if (this.#callerThreadId() !== identity.queenThreadId) {
      throw new Error("only the queen may clean up its spin-offs");
    }
    if (typeof rememberPolicy !== "boolean") {
      throw new Error("rememberPolicy must be a boolean");
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
    const resolvedPolicy =
      policy === null ? await this.#store.preference() : policy;
    if (!SPINOFF_CLEANUP_POLICIES.includes(resolvedPolicy)) {
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
        policy: resolvedPolicy,
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
    const candidates = (
      await Promise.all(
        eligible.map(async (candidate) => {
          const completion = {
            ...identity,
            workUnitId: candidate.workUnit.workUnitId,
            specRevision: candidate.workUnit.specRevision,
            attempt: candidate.workUnit.attempt,
            memberThreadId: candidate.threadId,
            outcome: candidate.decision.result.outcome,
            summary: candidate.decision.result.summary,
          };
          const record = await this.#store.read(spinoffWakeIdV1(completion));
          return { ...candidate, completion, record };
        }),
      )
    ).filter(
      ({ record }) =>
        !["archived", "kept"].includes(record?.cleanupState),
    );

    if (resolvedPolicy === "ask" && confirmedThreadIds === undefined) {
      if (rememberPolicy) await this.#store.rememberPreference(resolvedPolicy);
      return {
        schemaVersion: 1,
        policy: resolvedPolicy,
        state: candidates.length > 0 ? "confirmation-required" : "complete",
        candidates: candidates.map(({ workUnit, threadId, title }) => ({
          workUnitId: workUnit.workUnitId,
          threadId,
          title,
        })),
      };
    }

    const confirmed = confirmedThreadIds === undefined
      ? new Set(candidates.map(({ threadId }) => threadId))
      : new Set(confirmedThreadIds.map((thread) => id(thread, "confirmedThreadId")));
    const candidateIds = new Set(candidates.map(({ threadId }) => threadId));
    if ([...confirmed].some((thread) => !candidateIds.has(thread))) {
      throw new Error("cleanup confirmation contains an ineligible spin-off");
    }
    if (rememberPolicy) await this.#store.rememberPreference(resolvedPolicy);
    const selected = candidates.filter(({ threadId }) => confirmed.has(threadId));
    const results = [];
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
          if (resolvedPolicy === "keep") {
            if (record.cleanupState !== "kept") {
              record = await this.#store.write({
                ...record,
                revision: record.revision + 1,
                cleanupState: "kept",
                cleanupPolicy: resolvedPolicy,
                updatedAt: this.#now(),
              }, { expectedRevision: record.revision });
            }
            results.push({ threadId: candidate.threadId, state: "kept" });
            return;
          }
          if (record.cleanupState === "archived") {
            results.push({
              threadId: candidate.threadId,
              state: "archived",
              replayed: true,
            });
            return;
          }
          if (record.cleanupState === "attention") {
            results.push({
              threadId: candidate.threadId,
              state: "attention",
              reason: "prior-archive-attention",
            });
            return;
          }
          if (record.cleanupState === "archiving") {
            record = await this.#store.write({
              ...record,
              revision: record.revision + 1,
              cleanupState: "attention",
              updatedAt: this.#now(),
            }, { expectedRevision: record.revision });
            results.push({
              threadId: candidate.threadId,
              state: "attention",
              reason: "prior-archive-in-flight",
            });
            return;
          }
          record = await this.#store.write({
            ...record,
            revision: record.revision + 1,
            cleanupState: "archiving",
            cleanupPolicy: resolvedPolicy,
            updatedAt: this.#now(),
          }, { expectedRevision: record.revision });
          try {
            await appServerBridge.archiveThread({ threadId: candidate.threadId });
            record = await this.#store.write({
              ...record,
              revision: record.revision + 1,
              cleanupState: "archived",
              updatedAt: this.#now(),
            }, { expectedRevision: record.revision });
            results.push({
              threadId: candidate.threadId,
              state: "archived",
              replayed: false,
            });
          } catch (error) {
            const uncertain = error?.mutationUncertain === true;
            await this.#store.write({
              ...record,
              revision: record.revision + 1,
              cleanupState: uncertain ? "attention" : "pending",
              updatedAt: this.#now(),
            }, { expectedRevision: record.revision });
            results.push({
              threadId: candidate.threadId,
              state: uncertain ? "attention" : "pending",
              reason: uncertain
                ? "archive-uncertain"
                : "archive-rejected",
            });
          }
        });
      } catch {
        results.push({
          threadId: candidate.threadId,
          state: "attention",
          reason: "cleanup-candidate-failed",
        });
      }
    }
    return {
      schemaVersion: 1,
      policy: resolvedPolicy,
      state: results.some(({ state }) => state === "attention")
        ? "attention"
        : results.some(({ state }) => state === "pending")
          ? "pending"
          : "complete",
      results,
    };
  }
}
