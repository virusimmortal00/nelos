import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { join } from "node:path";

import {
  taskStateDirectory,
  withPlanRunLock,
} from "./task-state.mjs";
import {
  assertWebId,
  parseWebTitle,
  renderPersistedDurableChildTitle,
  renderPersistedQueenWebTitle,
} from "./task-web.mjs";

export const PLAN_RUN_SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_PLAN_RUN_RECORDS = 1_024;
const RUN_ID = /^run:[a-f0-9]{40}$/u;
const SOURCE_ID = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const QUEEN_THREAD_ID = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const WEB_IDENTITY_FIELDS = new Set([
  "schemaVersion",
  "webId",
  "queenThreadId",
  "queenTitle",
]);

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function planDigestV1(plan) {
  return digest(plan);
}

function runId(value, field = "planRunId") {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function sourceId(value) {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) {
    throw new Error("plan run sourceId has an invalid format");
  }
  return value;
}

function queenThreadId(value) {
  if (typeof value !== "string" || !QUEEN_THREAD_ID.test(value)) {
    throw new Error("plan run queenThreadId has an invalid format");
  }
  return value;
}

function webIdentity(value, owner) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plan run web identity must be a JSON object");
  }
  const unknown = Object.keys(value).find(
    (field) => !WEB_IDENTITY_FIELDS.has(field),
  );
  if (unknown) {
    throw new Error(`plan run web identity contains unknown field: ${unknown}`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error("plan run web identity has an unsupported schema version");
  }
  const normalizedQueenThreadId = queenThreadId(value.queenThreadId);
  if (normalizedQueenThreadId !== owner) {
    throw new Error("plan run web identity belongs to a different queen");
  }
  if (typeof value.queenTitle !== "string" || !value.queenTitle.trim()) {
    throw new Error("plan run web identity queenTitle is invalid");
  }
  const normalizedWebId = assertWebId(value.webId);
  const normalizedQueenTitle = value.queenTitle.trim();
  if (parseWebTitle(normalizedQueenTitle).queenMarked !== true) {
    throw new Error(
      "plan run web identity queenTitle conflicts with its web ID",
    );
  }
  // Validation only: this throws when the settled title's outbound marker
  // conflicts with the persisted web ID.
  renderPersistedQueenWebTitle(normalizedQueenTitle, normalizedWebId);
  return {
    schemaVersion: 1,
    webId: normalizedWebId,
    queenThreadId: normalizedQueenThreadId,
    queenTitle: normalizedQueenTitle,
  };
}

function planRunIdV1({
  queenThreadId: owner,
  sourceId: source,
  planDigest,
  parentPlanRunId,
  replanGeneration,
}) {
  return `run:${digest([
    "plan-run-v1",
    owner,
    source,
    planDigest,
    parentPlanRunId,
    replanGeneration,
  ]).slice(0, 40)}`;
}

export function planRunLaunchActionIdV1({
  planRunId,
  waveIndex,
  sliceId,
}) {
  const normalizedPlanRunId = runId(planRunId);
  if (!Number.isSafeInteger(waveIndex) || waveIndex < 1) {
    throw new Error("waveIndex must be a positive integer");
  }
  if (
    typeof sliceId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sliceId)
  ) {
    throw new Error("sliceId has an invalid format");
  }
  return `plan-launch:${normalizedPlanRunId.slice(4)}:${waveIndex}:${sliceId}`;
}

function waveContract(wave, persistedWebIdentity) {
  const members = wave.slices.map((slice) => ({
    sliceId: slice.id,
    lifecycle: slice.lifecycle,
    title:
      slice.lifecycle === "spinoff" && persistedWebIdentity
        ? renderPersistedDurableChildTitle(
            slice.title,
            persistedWebIdentity.webId,
          )
        : slice.title,
    model: slice.route.launch.nativeTask.model,
    effort: slice.route.launch.nativeTask.thinking,
  }));
  return {
    waveIndex: wave.index,
    waveDigest: digest({
      schemaVersion: PLAN_RUN_SCHEMA_VERSION,
      waveIndex: wave.index,
      members,
    }),
    members,
  };
}

function legacyRecordCanAdoptWebIdentity(legacy, current) {
  if (legacy.webIdentity !== null || current.webIdentity === null) return false;
  for (const field of [
    "schemaVersion",
    "planRunId",
    "queenThreadId",
    "sourceId",
    "planDigest",
    "rootPlanRunId",
    "parentPlanRunId",
    "replanGeneration",
    "cleanupIntended",
  ]) {
    if (legacy[field] !== current[field]) return false;
  }
  if (legacy.waves.length !== current.waves.length) return false;
  return legacy.waves.every((legacyWave, waveIndex) => {
    const currentWave = current.waves[waveIndex];
    if (
      legacyWave.waveIndex !== currentWave.waveIndex ||
      legacyWave.members.length !== currentWave.members.length
    ) {
      return false;
    }
    return legacyWave.members.every((legacyMember, memberIndex) => {
      const currentMember = currentWave.members[memberIndex];
      for (const field of ["sliceId", "lifecycle", "model", "effort"]) {
        if (legacyMember[field] !== currentMember[field]) return false;
      }
      if (legacyMember.lifecycle !== "spinoff") {
        return legacyMember.title === currentMember.title;
      }
      const before = parseWebTitle(legacyMember.title);
      const after = parseWebTitle(currentMember.title);
      return (
        before.baseTitle === after.baseTitle &&
        (before.inboundWebId === null ||
          before.inboundWebId === current.webIdentity.webId) &&
        after.inboundWebId === current.webIdentity.webId &&
        before.outboundWebId === after.outboundWebId &&
        before.queenMarked === after.queenMarked
      );
    });
  });
}

function sameCanonicalWebIdentity(left, right) {
  if (left === null || right === null) return left === right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.webId === right.webId &&
    left.queenThreadId === right.queenThreadId &&
    renderPersistedQueenWebTitle(left.queenTitle, left.webId) ===
      renderPersistedQueenWebTitle(right.queenTitle, right.webId)
  );
}

function sameCanonicalWaveContract(left, right, persistedWebIdentity) {
  if (
    left.waveIndex !== right.waveIndex ||
    left.members.length !== right.members.length
  ) {
    return false;
  }
  return left.members.every((leftMember, memberIndex) => {
    const rightMember = right.members[memberIndex];
    for (const field of ["sliceId", "lifecycle", "model", "effort"]) {
      if (leftMember[field] !== rightMember[field]) return false;
    }
    if (
      leftMember.lifecycle !== "spinoff" ||
      persistedWebIdentity === null
    ) {
      return leftMember.title === rightMember.title;
    }
    return (
      renderPersistedDurableChildTitle(
        leftMember.title,
        persistedWebIdentity.webId,
      ) ===
      renderPersistedDurableChildTitle(
        rightMember.title,
        persistedWebIdentity.webId,
      )
    );
  });
}

function legacyRecordCanAdoptTitleGrammar(legacy, current) {
  for (const field of [
    "schemaVersion",
    "planRunId",
    "queenThreadId",
    "sourceId",
    "planDigest",
    "rootPlanRunId",
    "parentPlanRunId",
    "replanGeneration",
    "cleanupIntended",
  ]) {
    if (legacy[field] !== current[field]) return false;
  }
  if (
    !sameCanonicalWebIdentity(legacy.webIdentity, current.webIdentity) ||
    legacy.webIdentity === null ||
    legacy.waves.length !== current.waves.length
  ) {
    return false;
  }
  return legacy.waves.every((legacyWave, waveIndex) => {
    const currentWave = current.waves[waveIndex];
    if (
      legacyWave.waveIndex !== currentWave.waveIndex ||
      legacyWave.members.length !== currentWave.members.length
    ) {
      return false;
    }
    return legacyWave.members.every((legacyMember, memberIndex) => {
      const currentMember = currentWave.members[memberIndex];
      for (const field of ["sliceId", "lifecycle", "model", "effort"]) {
        if (legacyMember[field] !== currentMember[field]) return false;
      }
      if (legacyMember.lifecycle !== "spinoff") {
        return legacyMember.title === currentMember.title;
      }
      return (
        renderPersistedDurableChildTitle(
          legacyMember.title,
          legacy.webIdentity.webId,
        ) === currentMember.title
      );
    });
  });
}

function validateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plan run record must be a JSON object");
  }
  const fields = new Set([
    "schemaVersion",
    "planRunId",
    "queenThreadId",
    "sourceId",
    "planDigest",
    "rootPlanRunId",
    "parentPlanRunId",
    "replanGeneration",
    "cleanupIntended",
    "plan",
    "verifiedWaveIndexes",
    "cleanedWaveIndexes",
    "webIdentity",
    "waves",
  ]);
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown) throw new Error(`plan run record contains unknown field: ${unknown}`);
  if (value.schemaVersion !== PLAN_RUN_SCHEMA_VERSION) {
    throw new Error("plan run record has an unsupported schema version");
  }
  const planRunId = runId(value.planRunId);
  const normalizedQueenThreadId = queenThreadId(value.queenThreadId);
  const normalizedSourceId = sourceId(value.sourceId);
  const normalizedWebIdentity = webIdentity(
    value.webIdentity,
    normalizedQueenThreadId,
  );
  const cleanupIntended = value.cleanupIntended ?? true;
  if (typeof cleanupIntended !== "boolean") {
    throw new Error("plan run cleanupIntended must be a boolean");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.planDigest)) {
    throw new Error("plan run digest is invalid");
  }
  const plan = value.plan ?? null;
  if (
    plan !== null &&
    (
      typeof plan !== "object" ||
      Array.isArray(plan) ||
      planDigestV1(plan) !== value.planDigest
    )
  ) {
    throw new Error("plan run persisted plan conflicts with its digest");
  }
  const rootPlanRunId = runId(value.rootPlanRunId, "rootPlanRunId");
  const parentPlanRunId =
    value.parentPlanRunId === null
      ? null
      : runId(value.parentPlanRunId, "parentPlanRunId");
  if (
    !Number.isSafeInteger(value.replanGeneration) ||
    ![0, 1].includes(value.replanGeneration)
  ) {
    throw new Error("plan run replanGeneration must be 0 or 1");
  }
  if (
    (value.replanGeneration === 0 &&
      (parentPlanRunId !== null || rootPlanRunId !== planRunId)) ||
    (value.replanGeneration === 1 &&
      (parentPlanRunId === null || rootPlanRunId === planRunId))
  ) {
    throw new Error("plan run lineage is inconsistent");
  }
  if (
    planRunIdV1({
      queenThreadId: normalizedQueenThreadId,
      sourceId: normalizedSourceId,
      planDigest: value.planDigest,
      parentPlanRunId,
      replanGeneration: value.replanGeneration,
    }) !== planRunId
  ) {
    throw new Error("plan run identity conflicts with persisted intent");
  }
  if (!Array.isArray(value.waves) || value.waves.length === 0) {
    throw new Error("plan run waves must be non-empty");
  }
  const waves = value.waves.map((wave, waveOffset) => {
    if (
      !wave ||
      typeof wave !== "object" ||
      Array.isArray(wave) ||
      Object.keys(wave).some(
        (field) => !["waveIndex", "waveDigest", "members"].includes(field),
      ) ||
      wave.waveIndex !== waveOffset + 1 ||
      !/^[a-f0-9]{64}$/u.test(wave.waveDigest) ||
      !Array.isArray(wave.members) ||
      wave.members.length === 0
    ) {
      throw new Error("plan run wave contract is invalid");
    }
    const members = wave.members.map((member) => {
      const memberFields = [
        "sliceId",
        "lifecycle",
        "title",
        "model",
        "effort",
      ];
      if (
        !member ||
        typeof member !== "object" ||
        Array.isArray(member) ||
        Object.keys(member).some((field) => !memberFields.includes(field)) ||
        memberFields.some(
          (field) => typeof member[field] !== "string" || !member[field],
        ) ||
        !["subagent", "spinoff"].includes(member.lifecycle)
      ) {
        throw new Error("plan run member contract is invalid");
      }
      const normalizedMember = Object.fromEntries(
        memberFields.map((field) => [field, member[field]]),
      );
      if (
        normalizedWebIdentity &&
        normalizedMember.lifecycle === "spinoff"
      ) {
        try {
          renderPersistedDurableChildTitle(
            normalizedMember.title,
            normalizedWebIdentity.webId,
          );
        } catch {
          throw new Error(
            "plan run durable member title conflicts with its web identity",
          );
        }
      }
      return normalizedMember;
    });
    if (
      new Set(members.map(({ sliceId }) => sliceId)).size !== members.length ||
      digest({
        schemaVersion: PLAN_RUN_SCHEMA_VERSION,
        waveIndex: wave.waveIndex,
        members,
      }) !== wave.waveDigest
    ) {
      throw new Error("plan run wave digest is invalid");
    }
    return {
      waveIndex: wave.waveIndex,
      waveDigest: wave.waveDigest,
      members,
    };
  });
  if (
    plan !== null &&
    (
      !Array.isArray(plan.waves) ||
      plan.waves.length !== waves.length ||
      plan.waves.some(
        (wave, index) =>
          !sameCanonicalWaveContract(
            waveContract(wave, normalizedWebIdentity),
            waves[index],
            normalizedWebIdentity,
          ),
      )
    )
  ) {
    throw new Error("plan run persisted plan conflicts with its wave contracts");
  }
  const verifiedWaveIndexes = value.verifiedWaveIndexes ?? [];
  if (
    !Array.isArray(verifiedWaveIndexes) ||
    verifiedWaveIndexes.length > waves.length ||
    new Set(verifiedWaveIndexes).size !== verifiedWaveIndexes.length ||
    verifiedWaveIndexes.some(
      (waveIndex, index) =>
        !Number.isSafeInteger(waveIndex) ||
        waveIndex < 1 ||
        waveIndex > waves.length ||
        (index > 0 && verifiedWaveIndexes[index - 1] >= waveIndex),
    )
  ) {
    throw new Error("plan run verified wave indexes are invalid");
  }
  const cleanedWaveIndexes = value.cleanedWaveIndexes ?? [];
  if (
    !Array.isArray(cleanedWaveIndexes) ||
    cleanedWaveIndexes.length > verifiedWaveIndexes.length ||
    new Set(cleanedWaveIndexes).size !== cleanedWaveIndexes.length ||
    cleanedWaveIndexes.some(
      (waveIndex, index) =>
        !Number.isSafeInteger(waveIndex) ||
        !verifiedWaveIndexes.includes(waveIndex) ||
        !waves[waveIndex - 1]?.members.some(
          ({ lifecycle }) => lifecycle === "spinoff",
        ) ||
        (index > 0 && cleanedWaveIndexes[index - 1] >= waveIndex),
    )
  ) {
    throw new Error("plan run cleaned wave indexes are invalid");
  }
  return {
    schemaVersion: PLAN_RUN_SCHEMA_VERSION,
    planRunId,
    queenThreadId: normalizedQueenThreadId,
    sourceId: normalizedSourceId,
    planDigest: value.planDigest,
    rootPlanRunId,
    parentPlanRunId,
    replanGeneration: value.replanGeneration,
    cleanupIntended,
    plan,
    verifiedWaveIndexes,
    cleanedWaveIndexes,
    webIdentity: normalizedWebIdentity,
    waves,
  };
}

function samePlanRunIntent(left, right) {
  const {
    verifiedWaveIndexes: _leftProgress,
    cleanedWaveIndexes: _leftCleanupProgress,
    ...leftIntent
  } = left;
  const {
    verifiedWaveIndexes: _rightProgress,
    cleanedWaveIndexes: _rightCleanupProgress,
    ...rightIntent
  } = right;
  return JSON.stringify(leftIntent) === JSON.stringify(rightIntent);
}

function legacyRecordCanAdoptPlanContract(legacy, current) {
  if (legacy.plan !== null || current.plan === null) return false;
  return samePlanRunIntent(
    { ...legacy, plan: current.plan },
    current,
  );
}

export function createPlanRunV1(
  plan,
  {
    queenThreadId: requestedQueenThreadId,
    sourceId: requestedSourceId,
    parentPlanRun = null,
    webIdentity: requestedWebIdentity = parentPlanRun?.webIdentity ?? null,
    cleanupIntended = parentPlanRun?.cleanupIntended ?? true,
  },
) {
  const normalizedQueenThreadId = queenThreadId(requestedQueenThreadId);
  const normalizedSourceId = sourceId(requestedSourceId);
  const planDigest = planDigestV1(plan);
  if (
    parentPlanRun !== null &&
    (parentPlanRun.replanGeneration !== 0 ||
      parentPlanRun.rootPlanRunId !== parentPlanRun.planRunId)
  ) {
    throw new Error("exception replanning is bounded to one plan-run generation");
  }
  if (
    parentPlanRun !== null &&
    parentPlanRun.queenThreadId !== normalizedQueenThreadId
  ) {
    throw new Error("derived plan run must belong to its persisted root queen");
  }
  if (typeof cleanupIntended !== "boolean") {
    throw new Error("plan run cleanupIntended must be a boolean");
  }
  if (
    parentPlanRun !== null &&
    cleanupIntended !== parentPlanRun.cleanupIntended
  ) {
    throw new Error("derived plan run cannot replace cleanup intent");
  }
  const normalizedWebIdentity = webIdentity(
    requestedWebIdentity,
    normalizedQueenThreadId,
  );
  if (
    parentPlanRun?.webIdentity &&
    JSON.stringify(parentPlanRun.webIdentity) !==
      JSON.stringify(normalizedWebIdentity)
  ) {
    throw new Error("derived plan run cannot replace its persisted web identity");
  }
  const replanGeneration = parentPlanRun === null ? 0 : 1;
  const parentPlanRunId = parentPlanRun?.planRunId ?? null;
  const planRunId = planRunIdV1({
    queenThreadId: normalizedQueenThreadId,
    sourceId: normalizedSourceId,
    planDigest,
    parentPlanRunId,
    replanGeneration,
  });
  return validateRecord({
    schemaVersion: PLAN_RUN_SCHEMA_VERSION,
    planRunId,
    queenThreadId: normalizedQueenThreadId,
    sourceId: normalizedSourceId,
    planDigest,
    rootPlanRunId: parentPlanRun?.rootPlanRunId ?? planRunId,
    parentPlanRunId,
    replanGeneration,
    cleanupIntended,
    plan: structuredClone(plan),
    verifiedWaveIndexes: [],
    cleanedWaveIndexes: [],
    webIdentity: normalizedWebIdentity,
    waves: plan.waves.map((wave) =>
      waveContract(wave, normalizedWebIdentity),
    ),
  });
}

export function planRunDirectory() {
  return join(taskStateDirectory(), "plan-runs");
}

export class PlanRunStoreV1 {
  #directory;
  #fileSystem;
  #makeTemporaryId;

  constructor({
    directory = planRunDirectory(),
    fileSystem = defaultFileSystem,
    makeTemporaryId = randomUUID,
  } = {}) {
    this.#directory = directory;
    this.#fileSystem = fileSystem;
    this.#makeTemporaryId = makeTemporaryId;
  }

  #path(planRunId) {
    return join(this.#directory, `${encodeURIComponent(runId(planRunId))}.json`);
  }

  async read(planRunId) {
    return this.#read(planRunId, new Set());
  }

  async #read(planRunId, lineage) {
    const requestedPlanRunId = runId(planRunId);
    if (lineage.has(requestedPlanRunId)) {
      throw new Error("plan run lineage contains a cycle");
    }
    const nextLineage = new Set(lineage).add(requestedPlanRunId);
    const path = this.#path(requestedPlanRunId);
    try {
      const metadata = await this.#fileSystem.stat(path);
      if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) {
        throw new Error("plan run record is malformed");
      }
      const record = validateRecord(
        JSON.parse(await this.#fileSystem.readFile(path, "utf8")),
      );
      if (record.planRunId !== requestedPlanRunId) {
        throw new Error("plan run identity conflicts with its persisted path");
      }
      if (record.replanGeneration === 1) {
        const parent = await this.#read(record.parentPlanRunId, nextLineage);
        if (
          !parent ||
          parent.replanGeneration !== 0 ||
          parent.rootPlanRunId !== parent.planRunId ||
          record.rootPlanRunId !== parent.planRunId ||
          record.queenThreadId !== parent.queenThreadId
        ) {
          throw new Error(
            "derived plan run does not match its exact persisted root",
          );
        }
      }
      return record;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async create(value) {
    const record = validateRecord(value);
    if (record.replanGeneration === 1) {
      const parent = await this.read(record.parentPlanRunId);
      if (
        !parent ||
        parent.replanGeneration !== 0 ||
        parent.rootPlanRunId !== parent.planRunId ||
        record.rootPlanRunId !== parent.planRunId ||
        record.queenThreadId !== parent.queenThreadId
      ) {
        throw new Error(
          "derived plan run requires its exact persisted root",
        );
      }
    }
    const existing = await this.read(record.planRunId);
    if (existing) {
      if (
        legacyRecordCanAdoptWebIdentity(existing, record) ||
        legacyRecordCanAdoptTitleGrammar(existing, record) ||
        legacyRecordCanAdoptPlanContract(existing, record)
      ) {
        const adopted = {
          ...record,
          verifiedWaveIndexes: existing.verifiedWaveIndexes,
          cleanedWaveIndexes: existing.cleanedWaveIndexes,
        };
        const source = `${JSON.stringify(adopted, null, 2)}\n`;
        if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
          throw new Error("plan run record is oversized");
        }
        const target = this.#path(record.planRunId);
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
        return adopted;
      }
      if (
        existing.webIdentity &&
        record.webIdentity &&
        JSON.stringify(existing.webIdentity) !==
          JSON.stringify(record.webIdentity)
      ) {
        throw new Error(
          "plan run has a conflicting persisted web identity; lineage was not overwritten",
        );
      }
      if (!samePlanRunIntent(existing, record)) {
        throw new Error("plan run identity conflicts with persisted intent");
      }
      return existing;
    }
    const source = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("plan run record is oversized");
    }
    await this.#fileSystem.mkdir(this.#directory, {
      recursive: true,
      mode: 0o700,
    });
    const target = this.#path(record.planRunId);
    const temporary = `${target}.${process.pid}.${this.#makeTemporaryId()}.tmp`;
    try {
      await this.#fileSystem.writeFile(temporary, source, {
        flag: "wx",
        mode: 0o600,
      });
      await this.#fileSystem.rename(temporary, target);
    } catch (error) {
      await this.#fileSystem.rm(temporary, { force: true }).catch(() => {});
      const raced = await this.read(record.planRunId);
      if (raced && JSON.stringify(raced) === JSON.stringify(record)) return raced;
      throw error;
    }
    return record;
  }

  async requireWave({ planRunId, queenThreadId: requestedQueenThreadId, waveIndex, waveDigest }) {
    const record = await this.read(planRunId);
    if (!record) throw new Error("launch batch references an unknown plan run");
    if (record.queenThreadId !== queenThreadId(requestedQueenThreadId)) {
      throw new Error("plan run belongs to a different queen");
    }
    const wave = record.waves.find((candidate) => candidate.waveIndex === waveIndex);
    if (!wave || wave.waveDigest !== waveDigest) {
      throw new Error("launch batch conflicts with its persisted wave contract");
    }
    return { record, wave };
  }

  async markWaveVerified({
    planRunId,
    queenThreadId: requestedQueenThreadId,
    waveIndex,
    waveDigest,
  }) {
    const normalizedPlanRunId = runId(planRunId);
    return withPlanRunLock(normalizedPlanRunId, async () => {
      const { record } = await this.requireWave({
        planRunId: normalizedPlanRunId,
        queenThreadId: requestedQueenThreadId,
        waveIndex,
        waveDigest,
      });
      if (record.verifiedWaveIndexes.includes(waveIndex)) return record;
      const expectedWaveIndex = record.verifiedWaveIndexes.length + 1;
      if (waveIndex !== expectedWaveIndex) {
        throw new Error("plan run waves must verify in dependency order");
      }
      const updated = validateRecord({
        ...record,
        verifiedWaveIndexes: [...record.verifiedWaveIndexes, waveIndex],
      });
      const source = `${JSON.stringify(updated, null, 2)}\n`;
      if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
        throw new Error("plan run record is oversized");
      }
      await this.#fileSystem.mkdir(this.#directory, {
        recursive: true,
        mode: 0o700,
      });
      const target = this.#path(updated.planRunId);
      const temporary =
        `${target}.${process.pid}.${this.#makeTemporaryId()}.tmp`;
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
      return updated;
    });
  }

  async markWaveCleaned({
    planRunId,
    queenThreadId: requestedQueenThreadId,
    waveIndex,
    waveDigest,
  }) {
    const normalizedPlanRunId = runId(planRunId);
    return withPlanRunLock(normalizedPlanRunId, async () => {
      const { record, wave } = await this.requireWave({
        planRunId: normalizedPlanRunId,
        queenThreadId: requestedQueenThreadId,
        waveIndex,
        waveDigest,
      });
      if (record.cleanedWaveIndexes.includes(waveIndex)) return record;
      if (!record.verifiedWaveIndexes.includes(waveIndex)) {
        throw new Error("plan run wave must be verified before cleanup");
      }
      if (!wave.members.some(({ lifecycle }) => lifecycle === "spinoff")) {
        throw new Error("plan run wave has no spin-offs to clean");
      }
      const missingEarlierCleanup = record.waves
        .filter(
          (candidate) =>
            candidate.waveIndex < waveIndex &&
            record.verifiedWaveIndexes.includes(candidate.waveIndex) &&
            candidate.members.some(({ lifecycle }) => lifecycle === "spinoff") &&
            !record.cleanedWaveIndexes.includes(candidate.waveIndex),
        );
      if (missingEarlierCleanup.length > 0) {
        throw new Error("plan run waves must clean in dependency order");
      }
      const updated = validateRecord({
        ...record,
        cleanedWaveIndexes: [...record.cleanedWaveIndexes, waveIndex],
      });
      const source = `${JSON.stringify(updated, null, 2)}\n`;
      if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
        throw new Error("plan run record is oversized");
      }
      await this.#fileSystem.mkdir(this.#directory, {
        recursive: true,
        mode: 0o700,
      });
      const target = this.#path(updated.planRunId);
      const temporary =
        `${target}.${process.pid}.${this.#makeTemporaryId()}.tmp`;
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
      return updated;
    });
  }

  async listForWeb({ webId, queenThreadId: requestedQueenThreadId }) {
    const normalizedWebId = assertWebId(webId);
    const normalizedQueenThreadId = queenThreadId(requestedQueenThreadId);
    let entries;
    try {
      entries = await this.#fileSystem.readdir(this.#directory, {
        withFileTypes: true,
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    if (entries.length > MAX_PLAN_RUN_RECORDS) {
      throw new Error("plan run directory contains too many records");
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const encoded = entry.name.slice(0, -5);
      let planRunId;
      try {
        planRunId = decodeURIComponent(encoded);
      } catch {
        continue;
      }
      if (!RUN_ID.test(planRunId)) continue;
      const path = this.#path(planRunId);
      let candidate;
      try {
        const metadata = await this.#fileSystem.stat(path);
        if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) continue;
        candidate = JSON.parse(
          await this.#fileSystem.readFile(path, "utf8"),
        );
      } catch {
        continue;
      }
      if (
        candidate?.queenThreadId !== normalizedQueenThreadId ||
        candidate?.webIdentity?.webId !== normalizedWebId
      ) {
        continue;
      }
      const record = await this.read(planRunId);
      if (
        record?.queenThreadId === normalizedQueenThreadId &&
        record.webIdentity?.webId === normalizedWebId
      ) {
        records.push(record);
      }
    }
    return records.sort((left, right) => {
      if (left.replanGeneration !== right.replanGeneration) {
        return right.replanGeneration - left.replanGeneration;
      }
      return left.planRunId.localeCompare(right.planRunId);
    });
  }
}
