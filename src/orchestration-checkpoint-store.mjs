import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { join } from "node:path";

import { taskStateDirectory } from "./task-state.mjs";

export const ORCHESTRATION_CHECKPOINT_SCHEMA_VERSION = 1;
export const MAX_CONSUMED_OBSERVATION_RECEIPTS = 1000;
const MAX_BYTES = 256 * 1024;
const ID = /^[^\s\u0000-\u001f\u007f]{1,256}$/u;
const WORK_UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TITLE_STATES = new Set(["pending", "verified", "attention"]);
const EXECUTION_STATES = new Set(["unknown", "waiting", "running", "terminal", "attention"]);
const RESULT_STATES = new Set(["absent", "current", "stale", "malformed"]);
const COORDINATION_STATES = new Set(["unjoined", "waiting", "collected", "accepted", "detached"]);
const CAPABILITIES = new Set(["observe", "read-result", "follow-up", "archive"]);

function fail(message) {
  throw new Error(`orchestration checkpoint ${message}`);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is malformed`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    fail(`${label} has an incompatible shape`);
  }
  return value;
}

function id(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function integer(value, label, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) fail(`${label} is invalid`);
  return value;
}

function nullableId(value, label) {
  return value === null ? null : id(value, label);
}

function member(value) {
  exact(value, [
    "workUnitId", "specRevision", "attempt", "bindingGeneration",
    "memberThreadId", "capabilities", "required", "title", "execution", "result",
    "coordination",
  ], "member");
  const title = exact(value.title, [
    "state", "requestedTitle", "observedTitle", "retryOrdinal",
  ], "title state");
  const execution = exact(value.execution, [
    "state", "hostId", "cursor", "latestTurnId", "attentionRequired",
  ], "execution state");
  const result = exact(value.result, [
    "state", "sourceTurnId", "envelope", "errorCode",
  ], "result state");
  const coordination = exact(value.coordination, ["state"], "coordination state");
  if (!TITLE_STATES.has(title.state)) fail("title state is invalid");
  if (!EXECUTION_STATES.has(execution.state)) fail("execution state is invalid");
  if (!RESULT_STATES.has(result.state)) fail("result state is invalid");
  if (!COORDINATION_STATES.has(coordination.state)) fail("coordination state is invalid");
  if (typeof title.requestedTitle !== "string" || !title.requestedTitle || title.requestedTitle.length > 512) {
    fail("requested title is invalid");
  }
  if (title.observedTitle !== null && (typeof title.observedTitle !== "string" || title.observedTitle.length > 512)) {
    fail("observed title is invalid");
  }
  if (typeof value.required !== "boolean" || typeof execution.attentionRequired !== "boolean") {
    fail("member flags are invalid");
  }
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length === 0 ||
    value.capabilities.some((capability) => !CAPABILITIES.has(capability)) ||
    new Set(value.capabilities).size !== value.capabilities.length
  ) {
    fail("member capabilities are invalid");
  }
  if (result.errorCode !== null && !/^[a-z][a-z0-9_-]{0,63}$/u.test(result.errorCode)) {
    fail("result error code is invalid");
  }
  return {
    workUnitId: id(value.workUnitId, "workUnitId", WORK_UNIT_ID),
    specRevision: integer(value.specRevision, "specRevision"),
    attempt: integer(value.attempt, "attempt"),
    bindingGeneration: integer(value.bindingGeneration, "bindingGeneration"),
    memberThreadId: id(value.memberThreadId, "memberThreadId"),
    capabilities: [...value.capabilities],
    required: value.required,
    title: {
      state: title.state,
      requestedTitle: title.requestedTitle,
      observedTitle: title.observedTitle,
      retryOrdinal: integer(title.retryOrdinal, "retryOrdinal", { zero: true }),
    },
    execution: {
      state: execution.state,
      hostId: nullableId(execution.hostId, "hostId"),
      cursor: nullableId(execution.cursor, "cursor"),
      latestTurnId: nullableId(execution.latestTurnId, "latestTurnId"),
      attentionRequired: execution.attentionRequired,
    },
    result: {
      state: result.state,
      sourceTurnId: nullableId(result.sourceTurnId, "sourceTurnId"),
      envelope: result.envelope,
      errorCode: result.errorCode,
    },
    coordination: { state: coordination.state },
  };
}

export function validateOrchestrationCheckpointV1(value) {
  exact(value, [
    "schemaVersion", "webId", "queenThreadId", "checkpointRevision",
    "waitGeneration", "members", "consumedReceipts",
  ], "record");
  if (value.schemaVersion !== ORCHESTRATION_CHECKPOINT_SCHEMA_VERSION) fail("schemaVersion is unsupported");
  if (!Array.isArray(value.members) || value.members.length > 100) fail("members are invalid");
  if (
    !Array.isArray(value.consumedReceipts) ||
    value.consumedReceipts.length > MAX_CONSUMED_OBSERVATION_RECEIPTS
  ) {
    fail("receipt history is invalid");
  }
  const members = value.members.map(member);
  const workUnitIds = members.map(({ workUnitId }) => workUnitId);
  if (new Set(workUnitIds).size !== workUnitIds.length) fail("members are duplicated");
  members.sort((left, right) => left.workUnitId.localeCompare(right.workUnitId));
  const consumedReceipts = value.consumedReceipts.map((entry) => {
    exact(entry, ["actionId", "digest"], "receipt history entry");
    if (!/^[a-f0-9]{64}$/u.test(entry.digest)) fail("receipt digest is invalid");
    return { actionId: id(entry.actionId, "actionId"), digest: entry.digest };
  });
  if (new Set(consumedReceipts.map(({ actionId }) => actionId)).size !== consumedReceipts.length) {
    fail("receipt action IDs are duplicated");
  }
  return {
    schemaVersion: ORCHESTRATION_CHECKPOINT_SCHEMA_VERSION,
    webId: id(value.webId, "webId"),
    queenThreadId: id(value.queenThreadId, "queenThreadId"),
    checkpointRevision: integer(value.checkpointRevision, "checkpointRevision", { zero: true }),
    waitGeneration: integer(value.waitGeneration, "waitGeneration", { zero: true }),
    members,
    consumedReceipts,
  };
}

export function orchestrationCheckpointDirectory() {
  return join(taskStateDirectory(), "orchestration-checkpoints");
}

function fileName(webId, queenThreadId) {
  return `${createHash("sha256").update(JSON.stringify([webId, queenThreadId])).digest("hex")}.json`;
}

export class OrchestrationCheckpointStoreV1 {
  #directory;
  #fileSystem;
  #makeTemporaryId;

  constructor({
    directory = orchestrationCheckpointDirectory(),
    fileSystem = defaultFileSystem,
    makeTemporaryId = randomUUID,
  } = {}) {
    this.#directory = directory;
    this.#fileSystem = fileSystem;
    this.#makeTemporaryId = makeTemporaryId;
  }

  async read(webId, queenThreadId) {
    const path = join(this.#directory, fileName(id(webId, "webId"), id(queenThreadId, "queenThreadId")));
    try {
      const metadata = await this.#fileSystem.stat(path);
      if (!metadata.isFile() || metadata.size > MAX_BYTES) fail("record is malformed");
      return validateOrchestrationCheckpointV1(JSON.parse(await this.#fileSystem.readFile(path, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value, { expectedRevision } = {}) {
    const record = validateOrchestrationCheckpointV1(value);
    const current = await this.read(record.webId, record.queenThreadId);
    const actualRevision = current?.checkpointRevision ?? 0;
    if (actualRevision !== expectedRevision || record.checkpointRevision !== actualRevision + 1) {
      fail("revision conflict");
    }
    const source = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(source, "utf8") > MAX_BYTES) fail("record is oversized");
    await this.#fileSystem.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const target = join(this.#directory, fileName(record.webId, record.queenThreadId));
    const temporary = `${target}.${process.pid}.${this.#makeTemporaryId()}.tmp`;
    try {
      await this.#fileSystem.writeFile(temporary, source, { flag: "wx", mode: 0o600 });
      await this.#fileSystem.rename(temporary, target);
    } catch (error) {
      await this.#fileSystem.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return record;
  }
}
