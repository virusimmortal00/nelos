import { randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { join } from "node:path";

import { taskStateDirectory } from "./task-state.mjs";
import { assertWebId } from "./task-web.mjs";
import { normalizeNativeLaunchV1 } from "./launch-contract.mjs";

export const EXECUTION_STORE_SCHEMA_VERSION = 1;
export const WORK_UNIT_SPEC_SCHEMA_VERSION = 1;
export const WORK_UNIT_BINDING_STATES = Object.freeze([
  "unbound",
  "launch-pending",
  "bound",
]);
export const WORK_UNIT_CAPABILITIES = Object.freeze([
  "observe",
  "read-result",
  "follow-up",
  "archive",
]);
export const WORK_UNIT_MEMBER_KINDS = Object.freeze([
  "spinoff",
  "joined-subagent",
]);
export const MAX_WORK_UNIT_TITLE_CHARACTERS = 512;
export const MAX_WORK_UNIT_SUMMARY_CHARACTERS = 2_000;
export const MAX_WORK_UNIT_ACCEPTANCE_CRITERIA_ITEMS = 16;
export const MAX_WORK_UNIT_LIST_ITEM_CHARACTERS = 1_000;

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 10;
const MAX_THREAD_ID_CHARACTERS = 256;
const MAX_LIST_ITEMS = 100;
const WORK_UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const SPEC_FIELDS = new Set([
  "schemaVersion",
  "webId",
  "queenThreadId",
  "workUnitId",
  "specRevision",
  "attempt",
  "binding",
  "replacementHistory",
  "memberKind",
  "capabilities",
  "launch",
  "title",
  "objectiveSummary",
  "deliverable",
  "acceptanceCriteria",
  "dependencies",
  "required",
  "policy",
]);
const CREATE_FIELDS = new Set(
  [...SPEC_FIELDS].filter(
    (field) => !["binding", "replacementHistory"].includes(field),
  ),
);
const BINDING_FIELDS = new Set([
  "state",
  "memberThreadId",
  "launchActionId",
  "generation",
]);
const REPLACEMENT_FIELDS = new Set([
  ...BINDING_FIELDS,
  "replacedByLaunchActionId",
]);
const POLICY_FIELDS = new Set(["maxAttempts", "onBlocked", "onFailure"]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPlainObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknownFields = Object.keys(value)
    .filter((field) => !fields.has(field))
    .sort(compareStrings);
  if (unknownFields.length > 0) {
    throw new Error(`${label} contains unknown field: ${unknownFields[0]}`);
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!normalized) throw new Error(`${field} must contain visible text`);
  if (normalized.length > maximum) {
    throw new Error(`${field} exceeds ${maximum} characters`);
  }
  return normalized;
}

function assertWorkUnitId(value, field = "workUnitId") {
  if (typeof value !== "string" || !WORK_UNIT_ID_PATTERN.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function assertActionId(value, field = "launchActionId") {
  if (typeof value !== "string" || !ACTION_ID_PATTERN.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function assertThreadId(value, field = "memberThreadId") {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > MAX_THREAD_ID_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function normalizeStringList(
  value,
  field,
  {
    maximumItems = MAX_LIST_ITEMS,
    itemMaximum = MAX_WORK_UNIT_LIST_ITEM_CHARACTERS,
  } = {},
) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${field} must contain at most ${maximumItems} strings`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(`${field} must not contain empty slots`);
    }
  }
  return value.map((item, index) =>
    normalizeText(item, `${field}[${index}]`, itemMaximum),
  );
}

function normalizeCapabilities(value, memberKind) {
  const capabilities = normalizeStringList(value, "capabilities", {
    maximumItems: WORK_UNIT_CAPABILITIES.length,
    itemMaximum: 32,
  });
  const unique = new Set(capabilities);
  if (unique.size !== capabilities.length) {
    throw new Error("capabilities must not contain duplicates");
  }
  const unsupported = capabilities.find(
    (capability) => !WORK_UNIT_CAPABILITIES.includes(capability),
  );
  if (unsupported) {
    throw new Error(`unsupported work-unit capability: ${unsupported}`);
  }
  if (!unique.has("observe")) {
    throw new Error("capabilities must include observe");
  }
  if (
    memberKind === "joined-subagent" &&
    unique.has("archive")
  ) {
    throw new Error("joined-subagent capabilities do not include archive");
  }
  return WORK_UNIT_CAPABILITIES.filter((capability) => unique.has(capability));
}

function normalizePolicy(value, attempt) {
  assertPlainObject(value, "policy", POLICY_FIELDS);
  const maxAttempts = assertPositiveInteger(
    value.maxAttempts,
    "policy.maxAttempts",
  );
  if (maxAttempts > MAX_ATTEMPTS) {
    throw new Error(`policy.maxAttempts must not exceed ${MAX_ATTEMPTS}`);
  }
  if (attempt > maxAttempts) {
    throw new Error("attempt must not exceed policy.maxAttempts");
  }
  if (value.onBlocked !== "queen-review") {
    throw new Error("policy.onBlocked must be queen-review");
  }
  if (value.onFailure !== "queen-review") {
    throw new Error("policy.onFailure must be queen-review");
  }
  return {
    maxAttempts,
    onBlocked: "queen-review",
    onFailure: "queen-review",
  };
}

function normalizeBinding(value, { replacement = false } = {}) {
  const label = replacement ? "replacement history entry" : "binding";
  assertPlainObject(
    value,
    label,
    replacement ? REPLACEMENT_FIELDS : BINDING_FIELDS,
  );
  if (!WORK_UNIT_BINDING_STATES.includes(value.state)) {
    throw new Error(`${label}.state has an invalid value`);
  }
  const generation = assertPositiveInteger(
    value.generation,
    `${label}.generation`,
  );

  let memberThreadId = null;
  let launchActionId = null;
  if (value.state === "unbound") {
    if (value.memberThreadId !== null || value.launchActionId !== null) {
      throw new Error("unbound bindings must not identify a task or launch action");
    }
  } else if (value.state === "launch-pending") {
    if (value.memberThreadId !== null) {
      throw new Error("launch-pending bindings must not identify a task");
    }
    launchActionId = assertActionId(value.launchActionId);
  } else {
    memberThreadId = assertThreadId(value.memberThreadId);
    launchActionId = assertActionId(value.launchActionId);
  }

  if (replacement && value.state !== "bound") {
    throw new Error("replacement history entries must preserve bound bindings");
  }

  const normalized = {
    state: value.state,
    memberThreadId,
    launchActionId,
    generation,
  };
  if (replacement) {
    normalized.replacedByLaunchActionId = assertActionId(
      value.replacedByLaunchActionId,
      "replacedByLaunchActionId",
    );
  }
  return normalized;
}

function normalizeReplacementHistory(value, binding) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(
      `replacementHistory must contain at most ${MAX_LIST_ITEMS} entries`,
    );
  }
  const history = value.map((entry, index) => {
    if (!Object.hasOwn(value, index)) {
      throw new Error("replacementHistory must not contain empty slots");
    }
    return normalizeBinding(entry, { replacement: true });
  });

  if (binding.state === "unbound" && history.length > 0) {
    throw new Error("unbound work units must not have replacement history");
  }
  if (binding.generation !== history.length + 1) {
    throw new Error("binding generation does not match replacement history");
  }

  const taskIds = new Set();
  const launchActionIds = new Set();
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (entry.generation !== index + 1) {
      throw new Error("replacement history generations must be contiguous");
    }
    const nextLaunchActionId =
      history[index + 1]?.launchActionId ?? binding.launchActionId;
    if (entry.replacedByLaunchActionId !== nextLaunchActionId) {
      throw new Error("replacement history does not identify the next launch");
    }
    if (taskIds.has(entry.memberThreadId)) {
      throw new Error("replacement history must not repeat member task IDs");
    }
    if (launchActionIds.has(entry.launchActionId)) {
      throw new Error("replacement history must not repeat launch action IDs");
    }
    taskIds.add(entry.memberThreadId);
    launchActionIds.add(entry.launchActionId);
  }
  if (
    binding.memberThreadId !== null &&
    taskIds.has(binding.memberThreadId)
  ) {
    throw new Error("the current binding must identify a new member task");
  }
  if (
    binding.launchActionId !== null &&
    launchActionIds.has(binding.launchActionId)
  ) {
    throw new Error("the current binding must identify a new launch action");
  }
  return history;
}

function normalizeDependencies(value, workUnitId) {
  const dependencies = normalizeStringList(value, "dependencies", {
    maximumItems: MAX_LIST_ITEMS,
    itemMaximum: 128,
  }).map((dependency, index) =>
    assertWorkUnitId(dependency, `dependencies[${index}]`),
  );
  const unique = new Set(dependencies);
  if (unique.size !== dependencies.length) {
    throw new Error("dependencies must not contain duplicates");
  }
  if (unique.has(workUnitId)) {
    throw new Error("a work unit must not depend on itself");
  }
  return [...unique].sort(compareStrings);
}

/**
 * Validate untrusted persisted input and return a canonical JSON-shaped record.
 */
export function validateWorkUnitSpecV1(value) {
  assertPlainObject(value, "work-unit spec", SPEC_FIELDS);
  if (value.schemaVersion !== WORK_UNIT_SPEC_SCHEMA_VERSION) {
    throw new Error(
      `schemaVersion must be ${WORK_UNIT_SPEC_SCHEMA_VERSION}`,
    );
  }
  const webId = assertWebId(value.webId);
  const queenThreadId = assertThreadId(value.queenThreadId, "queenThreadId");
  const workUnitId = assertWorkUnitId(value.workUnitId);
  const specRevision = assertPositiveInteger(
    value.specRevision,
    "specRevision",
  );
  const attempt = assertPositiveInteger(value.attempt, "attempt");
  const memberKind = value.memberKind;
  if (!WORK_UNIT_MEMBER_KINDS.includes(memberKind)) {
    throw new Error("memberKind must be spinoff or joined-subagent");
  }
  const binding = normalizeBinding(value.binding);
  const replacementHistory = normalizeReplacementHistory(
    value.replacementHistory,
    binding,
  );
  if (attempt < binding.generation) {
    throw new Error("attempt must not precede the binding generation");
  }
  const capabilities = normalizeCapabilities(value.capabilities, memberKind);
  const launch = normalizeNativeLaunchV1(value.launch, memberKind);
  const acceptanceCriteria = normalizeStringList(
    value.acceptanceCriteria,
    "acceptanceCriteria",
    { maximumItems: MAX_WORK_UNIT_ACCEPTANCE_CRITERIA_ITEMS },
  );
  const dependencies = normalizeDependencies(value.dependencies, workUnitId);
  if (typeof value.required !== "boolean") {
    throw new Error("required must be a boolean");
  }
  const policy = normalizePolicy(value.policy, attempt);

  return {
    schemaVersion: WORK_UNIT_SPEC_SCHEMA_VERSION,
    webId,
    queenThreadId,
    workUnitId,
    specRevision,
    attempt,
    binding,
    replacementHistory,
    memberKind,
    capabilities,
    launch,
    title: normalizeText(
      value.title,
      "title",
      MAX_WORK_UNIT_TITLE_CHARACTERS,
    ),
    objectiveSummary: normalizeText(
      value.objectiveSummary,
      "objectiveSummary",
      MAX_WORK_UNIT_SUMMARY_CHARACTERS,
    ),
    deliverable: normalizeText(
      value.deliverable,
      "deliverable",
      MAX_WORK_UNIT_SUMMARY_CHARACTERS,
    ),
    acceptanceCriteria,
    dependencies,
    required: value.required,
    policy,
  };
}

/**
 * Construct the only valid pre-launch WorkUnitSpecV1 relationship: unbound.
 */
export function createWorkUnitSpecV1(value) {
  assertPlainObject(value, "work-unit spec input", CREATE_FIELDS);
  const record = validateWorkUnitSpecV1({
    ...value,
    schemaVersion:
      value.schemaVersion === undefined
        ? WORK_UNIT_SPEC_SCHEMA_VERSION
        : value.schemaVersion,
    binding: {
      state: "unbound",
      memberThreadId: null,
      launchActionId: null,
      generation: 1,
    },
    replacementHistory: [],
  });
  assertCreatableWorkUnit(record);
  return record;
}

function assertCreatableWorkUnit(record) {
  if (record.required && !record.capabilities.includes("read-result")) {
    throw new Error(
      "required result-bearing work units must include read-result capability",
    );
  }
}

/**
 * Recover the immutable creation contract from a persisted work unit without
 * asking callers to reconstruct the execution protocol.
 */
export function workUnitDefinitionV1(value) {
  const record = validateWorkUnitSpecV1(value);
  return Object.fromEntries(
    [...CREATE_FIELDS].map((field) => [field, record[field]]),
  );
}

// A named schema constructor keeps the roadmap vocabulary available to callers.
export const WorkUnitSpecV1 = createWorkUnitSpecV1;

export function serializeWorkUnitSpecV1(value) {
  const serialized = `${JSON.stringify(validateWorkUnitSpecV1(value), null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new Error(`work-unit spec exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  return serialized;
}

export function executionStoreDirectory() {
  return join(taskStateDirectory(), "executions");
}

export class ExecutionStoreRecordError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ExecutionStoreRecordError";
    this.code = code;
  }
}

function recordFileName(workUnitId) {
  return `${encodeURIComponent(assertWorkUnitId(workUnitId))}.json`;
}

function assertMutationInput(value, fields) {
  return assertPlainObject(value, "execution-store mutation", new Set(fields));
}

function assertMatchingRevision(record, specRevision) {
  assertPositiveInteger(specRevision, "specRevision");
  if (record.specRevision !== specRevision) {
    throw new ExecutionStoreRecordError(
      "revision_conflict",
      `work unit ${record.workUnitId} is at spec revision ${record.specRevision}`,
    );
  }
}

function assertMatchingAttempt(record, attempt) {
  assertPositiveInteger(attempt, "attempt");
  if (record.attempt !== attempt) {
    throw new ExecutionStoreRecordError(
      "attempt_conflict",
      `work unit ${record.workUnitId} is at attempt ${record.attempt}`,
    );
  }
}

function sameRecord(left, right) {
  return serializeWorkUnitSpecV1(left) === serializeWorkUnitSpecV1(right);
}

/**
 * Private durable contract storage only. This class performs filesystem state
 * transitions; it never starts, reads, messages, or archives app-server tasks.
 */
export class ExecutionStoreV1 {
  #directory;
  #fileSystem;
  #makeTemporaryId;
  #mutations = new Map();

  constructor({
    directory = executionStoreDirectory(),
    fileSystem = defaultFileSystem,
    makeTemporaryId = randomUUID,
  } = {}) {
    if (typeof directory !== "string" || !directory) {
      throw new Error("execution-store directory must be a non-empty string");
    }
    for (const method of ["mkdir", "readFile", "readdir", "rename", "rm", "stat", "writeFile"]) {
      if (typeof fileSystem?.[method] !== "function") {
        throw new Error(`execution-store fileSystem must provide ${method}()`);
      }
    }
    if (typeof makeTemporaryId !== "function") {
      throw new Error("makeTemporaryId must be a function");
    }
    this.#directory = directory;
    this.#fileSystem = fileSystem;
    this.#makeTemporaryId = makeTemporaryId;
  }

  get directory() {
    return this.#directory;
  }

  #pathFor(workUnitId) {
    return join(this.#directory, recordFileName(workUnitId));
  }

  async #loadPath(path, expectedWorkUnitId) {
    const metadata = await this.#fileSystem.stat(path);
    if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) {
      throw new ExecutionStoreRecordError(
        metadata.size > MAX_RECORD_BYTES ? "oversized_record" : "invalid_record",
        `execution record ${recordFileName(expectedWorkUnitId)} is malformed`,
      );
    }
    const source = await this.#fileSystem.readFile(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
      throw new ExecutionStoreRecordError(
        "oversized_record",
        `execution record ${recordFileName(expectedWorkUnitId)} is malformed`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new ExecutionStoreRecordError(
        "invalid_json",
        `execution record ${recordFileName(expectedWorkUnitId)} is malformed`,
        { cause: error },
      );
    }
    if (parsed?.schemaVersion !== WORK_UNIT_SPEC_SCHEMA_VERSION) {
      throw new ExecutionStoreRecordError(
        "unsupported_schema_version",
        `execution record ${recordFileName(expectedWorkUnitId)} has an unsupported schema version`,
      );
    }
    let record;
    try {
      record = validateWorkUnitSpecV1(parsed);
    } catch (error) {
      throw new ExecutionStoreRecordError(
        "invalid_record",
        `execution record ${recordFileName(expectedWorkUnitId)} is malformed`,
        { cause: error },
      );
    }
    if (record.workUnitId !== expectedWorkUnitId) {
      throw new ExecutionStoreRecordError(
        "identity_mismatch",
        `execution record ${recordFileName(expectedWorkUnitId)} has a mismatched work-unit ID`,
      );
    }
    return record;
  }

  async #write(record) {
    const normalized = validateWorkUnitSpecV1(record);
    const source = serializeWorkUnitSpecV1(normalized);
    await this.#fileSystem.mkdir(this.#directory, {
      recursive: true,
      mode: 0o700,
    });
    const target = this.#pathFor(normalized.workUnitId);
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
    return normalized;
  }

  async #mutate(workUnitId, callback) {
    assertWorkUnitId(workUnitId);
    const previous = this.#mutations.get(workUnitId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    this.#mutations.set(workUnitId, current);
    try {
      return await current;
    } finally {
      if (this.#mutations.get(workUnitId) === current) {
        this.#mutations.delete(workUnitId);
      }
    }
  }

  async #required(workUnitId) {
    const record = await this.read(workUnitId);
    if (!record) {
      throw new ExecutionStoreRecordError(
        "not_found",
        `work unit ${workUnitId} does not exist`,
      );
    }
    return record;
  }

  async read(workUnitId) {
    assertWorkUnitId(workUnitId);
    try {
      return await this.#loadPath(this.#pathFor(workUnitId), workUnitId);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof ExecutionStoreRecordError) throw error;
      throw new ExecutionStoreRecordError(
        "unreadable_record",
        `failed to read execution record ${recordFileName(workUnitId)}`,
        { cause: error },
      );
    }
  }

  /**
   * Return healthy records and bounded diagnostics independently. File contents
   * and validation errors are deliberately excluded from diagnostics.
   */
  async scan() {
    let entries;
    try {
      entries = await this.#fileSystem.readdir(this.#directory, {
        withFileTypes: true,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { workUnits: [], malformedRecords: [] };
      }
      throw error;
    }

    const workUnits = [];
    const malformedRecords = [];
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of candidates) {
      const encodedWorkUnitId = entry.name.slice(0, -".json".length);
      let expectedWorkUnitId;
      try {
        expectedWorkUnitId = decodeURIComponent(encodedWorkUnitId);
        assertWorkUnitId(expectedWorkUnitId);
        if (recordFileName(expectedWorkUnitId) !== entry.name) {
          throw new Error("non-canonical record name");
        }
        workUnits.push(
          await this.#loadPath(
            join(this.#directory, entry.name),
            expectedWorkUnitId,
          ),
        );
      } catch (error) {
        malformedRecords.push({
          fileName: entry.name,
          workUnitId: expectedWorkUnitId ?? null,
          reason:
            error instanceof ExecutionStoreRecordError
              ? error.code
              : "invalid_record_name",
        });
      }
    }
    workUnits.sort((left, right) =>
      compareStrings(left.workUnitId, right.workUnitId),
    );
    return { workUnits, malformedRecords };
  }

  async list() {
    return (await this.scan()).workUnits;
  }

  async create(value) {
    const record = validateWorkUnitSpecV1(value);
    assertCreatableWorkUnit(record);
    if (
      record.binding.state !== "unbound" ||
      record.binding.generation !== 1 ||
      record.replacementHistory.length !== 0
    ) {
      throw new Error("new work units must have an unbound initial binding");
    }
    return this.#mutate(record.workUnitId, async () => {
      const existing = await this.read(record.workUnitId);
      if (existing) {
        if (sameRecord(existing, record)) return existing;
        throw new ExecutionStoreRecordError(
          "already_exists",
          `work unit ${record.workUnitId} already exists`,
        );
      }
      return this.#write(record);
    });
  }

  async revise(value, { expectedSpecRevision } = {}) {
    const next = validateWorkUnitSpecV1(value);
    return this.#mutate(next.workUnitId, async () => {
      const current = await this.#required(next.workUnitId);
      assertMatchingRevision(current, expectedSpecRevision);
      if (next.specRevision !== current.specRevision + 1) {
        throw new ExecutionStoreRecordError(
          "revision_conflict",
          "a revised work-unit spec must advance exactly one revision",
        );
      }
      for (const field of ["webId", "queenThreadId", "workUnitId", "memberKind"]) {
        if (next[field] !== current[field]) {
          throw new Error(`${field} is immutable across spec revisions`);
        }
      }
      for (const field of ["attempt", "binding", "replacementHistory"]) {
        if (JSON.stringify(next[field]) !== JSON.stringify(current[field])) {
          throw new Error(`${field} must be changed through an execution-store transition`);
        }
      }
      return this.#write(next);
    });
  }

  async markLaunchPending(value) {
    assertMutationInput(value, ["workUnitId", "specRevision", "launchActionId"]);
    const workUnitId = assertWorkUnitId(value.workUnitId);
    const launchActionId = assertActionId(value.launchActionId);
    return this.#mutate(workUnitId, async () => {
      const current = await this.#required(workUnitId);
      assertMatchingRevision(current, value.specRevision);
      if (
        current.binding.state === "launch-pending" &&
        current.binding.launchActionId === launchActionId
      ) {
        return current;
      }
      if (current.binding.state !== "unbound") {
        throw new ExecutionStoreRecordError(
          "transition_conflict",
          "normal binding can only move from unbound to launch-pending",
        );
      }
      return this.#write({
        ...current,
        binding: {
          state: "launch-pending",
          memberThreadId: null,
          launchActionId,
          generation: current.binding.generation,
        },
      });
    });
  }

  async bind(value) {
    assertMutationInput(value, [
      "workUnitId",
      "specRevision",
      "launchActionId",
      "memberThreadId",
    ]);
    const workUnitId = assertWorkUnitId(value.workUnitId);
    const launchActionId = assertActionId(value.launchActionId);
    const memberThreadId = assertThreadId(value.memberThreadId);
    return this.#mutate(workUnitId, async () => {
      const current = await this.#required(workUnitId);
      assertMatchingRevision(current, value.specRevision);
      if (
        current.binding.state === "bound" &&
        current.binding.launchActionId === launchActionId &&
        current.binding.memberThreadId === memberThreadId
      ) {
        return current;
      }
      if (
        current.binding.state !== "launch-pending" ||
        current.binding.launchActionId !== launchActionId
      ) {
        throw new ExecutionStoreRecordError(
          "transition_conflict",
          "binding requires the matching launch-pending action",
        );
      }
      if (
        current.replacementHistory.some(
          (entry) => entry.memberThreadId === memberThreadId,
        )
      ) {
        throw new Error("a replacement must bind a new member task");
      }
      return this.#write({
        ...current,
        binding: {
          ...current.binding,
          state: "bound",
          memberThreadId,
        },
      });
    });
  }

  async advanceAttempt(value) {
    assertMutationInput(value, ["workUnitId", "specRevision", "attempt"]);
    const workUnitId = assertWorkUnitId(value.workUnitId);
    return this.#mutate(workUnitId, async () => {
      const current = await this.#required(workUnitId);
      assertMatchingRevision(current, value.specRevision);
      assertMatchingAttempt(current, value.attempt);
      if (current.binding.state !== "bound") {
        throw new ExecutionStoreRecordError(
          "transition_conflict",
          "a corrective attempt requires a bound member task",
        );
      }
      if (current.attempt >= current.policy.maxAttempts) {
        throw new ExecutionStoreRecordError(
          "attempt_limit",
          `work unit ${workUnitId} has reached its attempt limit`,
        );
      }
      return this.#write({ ...current, attempt: current.attempt + 1 });
    });
  }

  async detachImpossibleRequiredMember(value) {
    assertMutationInput(value, [
      "workUnitId",
      "specRevision",
      "attempt",
      "memberThreadId",
    ]);
    const workUnitId = assertWorkUnitId(value.workUnitId);
    const memberThreadId = assertThreadId(value.memberThreadId);
    return this.#mutate(workUnitId, async () => {
      const current = await this.#required(workUnitId);
      assertMatchingRevision(current, value.specRevision);
      assertMatchingAttempt(current, value.attempt);
      if (
        current.binding.state !== "bound" ||
        current.binding.memberThreadId !== memberThreadId
      ) {
        throw new ExecutionStoreRecordError(
          "transition_conflict",
          "member repair requires the matching bound task",
        );
      }
      if (!current.required) return current;
      if (current.capabilities.includes("read-result")) {
        throw new ExecutionStoreRecordError(
          "transition_conflict",
          "only a required member missing read-result may be detached by repair",
        );
      }
      return this.#write({ ...current, required: false });
    });
  }

  async beginReplacement(value) {
    assertMutationInput(value, [
      "workUnitId",
      "specRevision",
      "attempt",
      "launchActionId",
    ]);
    const workUnitId = assertWorkUnitId(value.workUnitId);
    const launchActionId = assertActionId(value.launchActionId);
    return this.#mutate(workUnitId, async () => {
      const current = await this.#required(workUnitId);
      assertMatchingRevision(current, value.specRevision);
      if (
        current.binding.state === "launch-pending" &&
        current.binding.generation > 1 &&
        current.binding.launchActionId === launchActionId &&
        current.attempt === value.attempt + 1
      ) {
        return current;
      }
      assertMatchingAttempt(current, value.attempt);
      if (current.binding.state !== "bound") {
        throw new ExecutionStoreRecordError(
          "transition_conflict",
          "task replacement requires a bound member task",
        );
      }
      if (current.attempt >= current.policy.maxAttempts) {
        throw new ExecutionStoreRecordError(
          "attempt_limit",
          `work unit ${workUnitId} has reached its attempt limit`,
        );
      }
      if (current.binding.launchActionId === launchActionId) {
        throw new Error("a replacement must use a new launch action ID");
      }
      const replacementHistory = [
        ...current.replacementHistory,
        {
          ...current.binding,
          replacedByLaunchActionId: launchActionId,
        },
      ];
      return this.#write({
        ...current,
        attempt: current.attempt + 1,
        binding: {
          state: "launch-pending",
          memberThreadId: null,
          launchActionId,
          generation: current.binding.generation + 1,
        },
        replacementHistory,
      });
    });
  }
}
