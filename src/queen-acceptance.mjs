import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { join } from "node:path";

import { validateWorkUnitSpecV1 } from "./execution-store.mjs";
import { taskStateDirectory, withQueenAcceptanceLock } from "./task-state.mjs";
import { assertWebId } from "./task-web.mjs";
import { validateResultEnvelopeV1 } from "./work-result.mjs";

export const QUEEN_ACCEPTANCE_SCHEMA_VERSION = 1;
export const WEB_READINESS_SCHEMA_VERSION = 1;

const MAX_RECORD_BYTES = 32 * 1024;
const MAX_DECISION_SUMMARY = 1_000;
const WORK_UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const THREAD_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,256}$/u;
const DECISION_FIELDS = new Set([
  "schemaVersion",
  "decisionId",
  "webId",
  "queenThreadId",
  "workUnitId",
  "specRevision",
  "attempt",
  "memberThreadId",
  "sourceTurnId",
  "decision",
  "decisionSummary",
  "result",
  "recordedAt",
]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPlainObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !fields.has(key));
  const missing = [...fields].find((key) => !Object.hasOwn(value, key));
  if (unknown || missing) {
    throw new Error(`${label} has an incompatible shape`);
  }
  return value;
}

function assertIdentifier(value, label, pattern = THREAD_ID_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} has an invalid length`);
  }
  return normalized;
}

function assertRecordedAt(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("recordedAt must be an ISO timestamp");
  }
  return new Date(value).toISOString();
}

function sourceFingerprint({ memberThreadId, sourceTurnId }) {
  return createHash("sha256")
    .update(JSON.stringify([memberThreadId, sourceTurnId]), "utf8")
    .digest("base64url");
}

export function queenAcceptanceIdV1({
  webId,
  workUnitId,
  specRevision,
  attempt,
  memberThreadId,
  sourceTurnId,
}) {
  return [
    "queen-acceptance-v1",
    encodeURIComponent(assertWebId(webId)),
    encodeURIComponent(assertIdentifier(workUnitId, "workUnitId", WORK_UNIT_ID_PATTERN)),
    `revision-${assertPositiveInteger(specRevision, "specRevision")}`,
    `attempt-${assertPositiveInteger(attempt, "attempt")}`,
    sourceFingerprint({
      memberThreadId: assertIdentifier(memberThreadId, "memberThreadId"),
      sourceTurnId: assertIdentifier(sourceTurnId, "sourceTurnId"),
    }),
  ].join("/");
}

/**
 * A queen decision is deliberately separate from task completion. It contains
 * the bounded result envelope but never a task transcript or prompt.
 */
export function createQueenAcceptanceV1(value) {
  const input = assertPlainObject(value, DECISION_FIELDS, "queen acceptance");
  if (input.schemaVersion !== QUEEN_ACCEPTANCE_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${QUEEN_ACCEPTANCE_SCHEMA_VERSION}`);
  }
  const webId = assertWebId(input.webId);
  const workUnitId = assertIdentifier(input.workUnitId, "workUnitId", WORK_UNIT_ID_PATTERN);
  const specRevision = assertPositiveInteger(input.specRevision, "specRevision");
  const attempt = assertPositiveInteger(input.attempt, "attempt");
  const memberThreadId = assertIdentifier(input.memberThreadId, "memberThreadId");
  const sourceTurnId = assertIdentifier(input.sourceTurnId, "sourceTurnId");
  const decision = input.decision;
  if (!new Set(["accepted", "rejected"]).has(decision)) {
    throw new Error("decision must be accepted or rejected");
  }
  const result = validateResultEnvelopeV1(input.result);
  if (
    result.workUnitId !== workUnitId ||
    result.specRevision !== specRevision ||
    result.attempt !== attempt
  ) {
    throw new Error("result does not match the accepted work-unit identity");
  }
  if (decision === "accepted" && result.outcome !== "succeeded") {
    throw new Error("only succeeded results may be accepted");
  }
  const decisionId = queenAcceptanceIdV1({
    webId,
    workUnitId,
    specRevision,
    attempt,
    memberThreadId,
    sourceTurnId,
  });
  if (input.decisionId !== decisionId) {
    throw new Error("decisionId does not match the acceptance provenance");
  }
  return {
    schemaVersion: QUEEN_ACCEPTANCE_SCHEMA_VERSION,
    decisionId,
    webId,
    queenThreadId: assertIdentifier(input.queenThreadId, "queenThreadId"),
    workUnitId,
    specRevision,
    attempt,
    memberThreadId,
    sourceTurnId,
    decision,
    decisionSummary: normalizeText(
      input.decisionSummary,
      "decisionSummary",
      MAX_DECISION_SUMMARY,
    ),
    result,
    recordedAt: assertRecordedAt(input.recordedAt),
  };
}

export function queenAcceptanceDirectory() {
  return join(taskStateDirectory(), "queen-acceptances");
}

function acceptanceFileName(decisionId) {
  return `${createHash("sha256").update(decisionId, "utf8").digest("hex")}.json`;
}

function serialize(record) {
  const source = `${JSON.stringify(createQueenAcceptanceV1(record), null, 2)}\n`;
  if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
    throw new Error(`queen acceptance exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  return source;
}

export class QueenAcceptanceStoreV1 {
  #directory;
  #fileSystem;
  #makeTemporaryId;
  #mutations = new Map();

  constructor({
    directory = queenAcceptanceDirectory(),
    fileSystem = defaultFileSystem,
    makeTemporaryId = randomUUID,
  } = {}) {
    if (typeof directory !== "string" || !directory) {
      throw new Error("queen acceptance directory must be a non-empty string");
    }
    for (const method of ["mkdir", "readFile", "readdir", "rename", "rm", "stat", "writeFile"]) {
      if (typeof fileSystem?.[method] !== "function") {
        throw new Error(`queen acceptance fileSystem must provide ${method}()`);
      }
    }
    this.#directory = directory;
    this.#fileSystem = fileSystem;
    this.#makeTemporaryId = makeTemporaryId;
  }

  get directory() {
    return this.#directory;
  }

  #pathFor(decisionId) {
    return join(this.#directory, acceptanceFileName(decisionId));
  }

  async #readPath(path) {
    const metadata = await this.#fileSystem.stat(path);
    if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) {
      throw new Error("queen acceptance record is malformed");
    }
    const source = await this.#fileSystem.readFile(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("queen acceptance record is malformed");
    }
    return createQueenAcceptanceV1(JSON.parse(source));
  }

  async read(decisionId) {
    if (typeof decisionId !== "string" || !decisionId) {
      throw new Error("decisionId must be a non-empty string");
    }
    try {
      return await this.#readPath(this.#pathFor(decisionId));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async record(value) {
    const record = createQueenAcceptanceV1(value);
    const previous = this.#mutations.get(record.decisionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() =>
      withQueenAcceptanceLock(record.decisionId, async () => {
        const existing = await this.read(record.decisionId);
        if (existing) {
          if (serialize(existing) === serialize(record)) return existing;
          throw new Error("queen acceptance provenance already has a different decision");
        }
        await this.#fileSystem.mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const target = this.#pathFor(record.decisionId);
        const temporary = `${target}.${process.pid}.${this.#makeTemporaryId()}.tmp`;
        try {
          await this.#fileSystem.writeFile(temporary, serialize(record), {
            flag: "wx",
            mode: 0o600,
          });
          await this.#fileSystem.rename(temporary, target);
        } catch (error) {
          await this.#fileSystem.rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
        return record;
      }),
    );
    this.#mutations.set(record.decisionId, current);
    try {
      return await current;
    } finally {
      if (this.#mutations.get(record.decisionId) === current) {
        this.#mutations.delete(record.decisionId);
      }
    }
  }

  async scan() {
    let entries;
    try {
      entries = await this.#fileSystem.readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return { decisions: [], malformedRecords: [] };
      throw error;
    }
    const decisions = [];
    const malformedRecords = [];
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((a, b) => compareStrings(a.name, b.name))) {
      try {
        decisions.push(await this.#readPath(join(this.#directory, entry.name)));
      } catch {
        malformedRecords.push({ fileName: entry.name, reason: "invalid_record" });
      }
    }
    decisions.sort((left, right) =>
      compareStrings(left.workUnitId, right.workUnitId) ||
      left.specRevision - right.specRevision ||
      left.attempt - right.attempt ||
      compareStrings(left.sourceTurnId, right.sourceTurnId),
    );
    return { decisions, malformedRecords };
  }

  async list({ webId = null, queenThreadId = null } = {}) {
    const { decisions } = await this.scan();
    return decisions.filter((decision) =>
      (webId === null || decision.webId === assertWebId(webId)) &&
      (queenThreadId === null || decision.queenThreadId === assertIdentifier(queenThreadId, "queenThreadId")),
    );
  }
}

function decisionMatchesCurrentWorkUnit(decision, workUnit) {
  return (
    decision.decision === "accepted" &&
    decision.webId === workUnit.webId &&
    decision.queenThreadId === workUnit.queenThreadId &&
    decision.workUnitId === workUnit.workUnitId &&
    decision.specRevision === workUnit.specRevision &&
    decision.attempt === workUnit.attempt &&
    workUnit.binding.state === "bound" &&
    decision.memberThreadId === workUnit.binding.memberThreadId
  );
}

function validateWebGraph(workUnits) {
  if (!Array.isArray(workUnits) || workUnits.length === 0) {
    throw new Error("workUnits must contain at least one work unit");
  }
  const normalized = workUnits.map((workUnit) => validateWorkUnitSpecV1(workUnit));
  const webId = normalized[0].webId;
  const queenThreadId = normalized[0].queenThreadId;
  const byId = new Map();
  for (const workUnit of normalized) {
    if (workUnit.webId !== webId || workUnit.queenThreadId !== queenThreadId) {
      throw new Error("work units must belong to one web and queen");
    }
    if (byId.has(workUnit.workUnitId)) {
      throw new Error(`duplicate work unit: ${workUnit.workUnitId}`);
    }
    byId.set(workUnit.workUnitId, workUnit);
  }
  for (const workUnit of normalized) {
    for (const dependency of workUnit.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`unknown dependency ${dependency} for ${workUnit.workUnitId}`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (workUnitId) => {
    if (visiting.has(workUnitId)) throw new Error("work-unit dependencies contain a cycle");
    if (visited.has(workUnitId)) return;
    visiting.add(workUnitId);
    for (const dependency of byId.get(workUnitId).dependencies) visit(dependency);
    visiting.delete(workUnitId);
    visited.add(workUnitId);
  };
  for (const workUnitId of [...byId.keys()].sort(compareStrings)) visit(workUnitId);
  return { normalized, webId, queenThreadId, byId };
}

/**
 * Compute the web-owned launch gate. A task finishing successfully is not
 * sufficient: every declared dependency needs a current, recorded queen
 * acceptance before an unbound work unit is ready.
 */
export function deriveWebReadinessV1({ workUnits, decisions = [] } = {}) {
  const { normalized, webId, queenThreadId, byId } = validateWebGraph(workUnits);
  if (!Array.isArray(decisions)) throw new Error("decisions must be an array");
  const acceptedByWorkUnit = new Map();
  for (const decision of decisions.map((item) => createQueenAcceptanceV1(item))) {
    const workUnit = byId.get(decision.workUnitId);
    if (workUnit && decisionMatchesCurrentWorkUnit(decision, workUnit)) {
      acceptedByWorkUnit.set(decision.workUnitId, decision);
    }
  }

  const entries = normalized
    .sort((left, right) => compareStrings(left.workUnitId, right.workUnitId))
    .map((workUnit) => {
      const unacceptedDependencies = workUnit.dependencies
        .filter((dependency) => !acceptedByWorkUnit.has(dependency))
        .sort(compareStrings);
      const launchable =
        workUnit.binding.state === "unbound" && unacceptedDependencies.length === 0;
      return {
        workUnitId: workUnit.workUnitId,
        bindingState: workUnit.binding.state,
        accepted: acceptedByWorkUnit.has(workUnit.workUnitId),
        acceptedDecisionId: acceptedByWorkUnit.get(workUnit.workUnitId)?.decisionId ?? null,
        ready: launchable,
        reason: launchable
          ? "ready"
          : unacceptedDependencies.length > 0
            ? "blocked_by_unaccepted_dependencies"
            : workUnit.binding.state === "launch-pending"
              ? "ambiguous_launch"
              : "already_launched",
        unacceptedDependencies,
      };
    });
  return {
    schemaVersion: WEB_READINESS_SCHEMA_VERSION,
    webId,
    queenThreadId,
    readyWorkUnitIds: entries.filter((entry) => entry.ready).map((entry) => entry.workUnitId),
    entries,
  };
}
