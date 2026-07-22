import { assertWebId } from "./task-web.mjs";

export const RESULT_ENVELOPE_SCHEMA_VERSION = 1;
export const WEB_COLLECTION_SCHEMA_VERSION = 1;
export const WORK_OUTCOMES = ["unknown", "succeeded", "blocked", "failed"];

const RESULT_MARKER_PATTERN_SOURCE = "fraktik-result";
const RESULT_BLOCK_PATTERN = new RegExp(
  `^\`\`\`${RESULT_MARKER_PATTERN_SOURCE}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`[ \\t]*$`,
  "gimu",
);
const RESULT_MARKER_PATTERN = new RegExp(
  `^\`\`\`${RESULT_MARKER_PATTERN_SOURCE}[ \\t]*$`,
  "gimu",
);
const RESULT_BLOCK_MARKER = "```fraktik-result";
const MAX_RESULT_BYTES = 8 * 1024;
const MAX_SCAN_CHARACTERS = 64 * 1024;
const MAX_SUMMARY_CHARACTERS = 2_000;
const MAX_FALLBACK_CHARACTERS = 1_000;
const MAX_LIST_ITEMS = 8;
const MAX_LIST_ITEM_CHARACTERS = 500;
const MAX_RECOVERY_HINT_CHARACTERS = 1_000;
const MAX_WEB_MEMBERS = 100;
const MAX_CONCURRENT_MEMBER_LOADS = 8;
const MAX_THREAD_ID_CHARACTERS = 256;
const MAX_TITLE_CHARACTERS = 512;
const WORK_UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESULT_FIELDS = new Set([
  "schemaVersion",
  "workUnitId",
  "specRevision",
  "attempt",
  "outcome",
  "summary",
  "artifacts",
  "verification",
  "blockers",
  "recoveryHint",
]);

function compareStrings(left, right) {
  const normalizedLeft = String(left || "");
  const normalizedRight = String(right || "");
  return normalizedLeft < normalizedRight
    ? -1
    : normalizedLeft > normalizedRight
      ? 1
      : 0;
}

function normalizedStatus(value) {
  if (value && typeof value === "object") return normalizedStatus(value.type);
  return String(value || "").replaceAll(/[_\s-]/g, "").toLowerCase();
}

function safeError(code, message) {
  return {
    code,
    message: String(message || "")
      .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
      .replaceAll(/\s+/g, " ")
      .trim()
      .slice(0, 300),
  };
}

function invalid(code, message) {
  return { format: "invalid", result: null, error: safeError(code, message) };
}

function assertBoundedString(value, field, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string${nullable ? " or null" : ""}`);
  }
  const normalized = value
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!normalized) {
    throw new Error(`${field} must contain visible text`);
  }
  if (normalized.length > maximum) {
    throw new Error(`${field} exceeds ${maximum} characters`);
  }
  return normalized;
}

function assertBoundedStringList(value, field) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${field} must contain at most ${MAX_LIST_ITEMS} strings`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(`${field} must not contain empty slots`);
    }
  }
  return value.map((item, index) =>
    assertBoundedString(
      item,
      `${field}[${index}]`,
      MAX_LIST_ITEM_CHARACTERS,
    ),
  );
}

function normalizeResultEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("result envelope must be a JSON object");
  }
  const unknownFields = Object.keys(value).filter((field) => !RESULT_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`result envelope contains unknown field: ${unknownFields[0]}`);
  }
  if (value.schemaVersion !== RESULT_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(
      `schemaVersion must be ${RESULT_ENVELOPE_SCHEMA_VERSION}`,
    );
  }
  if (
    typeof value.workUnitId !== "string" ||
    !WORK_UNIT_ID_PATTERN.test(value.workUnitId)
  ) {
    throw new Error("workUnitId has an invalid format");
  }
  if (!Number.isSafeInteger(value.specRevision) || value.specRevision <= 0) {
    throw new Error("specRevision must be a positive integer");
  }
  if (!Number.isSafeInteger(value.attempt) || value.attempt <= 0) {
    throw new Error("attempt must be a positive integer");
  }
  if (!["succeeded", "blocked", "failed"].includes(value.outcome)) {
    throw new Error("outcome must be succeeded, blocked, or failed");
  }

  const summary = assertBoundedString(
    value.summary,
    "summary",
    MAX_SUMMARY_CHARACTERS,
  );
  const artifacts = assertBoundedStringList(value.artifacts, "artifacts");
  const verification = assertBoundedStringList(value.verification, "verification");
  const blockers = assertBoundedStringList(value.blockers, "blockers");
  const recoveryHint =
    value.recoveryHint === null
      ? null
      : assertBoundedString(
          value.recoveryHint,
          "recoveryHint",
          MAX_RECOVERY_HINT_CHARACTERS,
          { nullable: true },
        );

  if (value.outcome === "succeeded" && blockers.length > 0) {
    throw new Error("succeeded results must not include blockers");
  }
  if (value.outcome === "blocked" && blockers.length === 0) {
    throw new Error("blocked results must include at least one blocker");
  }

  return {
    schemaVersion: RESULT_ENVELOPE_SCHEMA_VERSION,
    workUnitId: value.workUnitId,
    specRevision: value.specRevision,
    attempt: value.attempt,
    outcome: value.outcome,
    summary,
    artifacts,
    verification,
    blockers,
    recoveryHint,
  };
}

export function validateResultEnvelopeV1(value) {
  return normalizeResultEnvelope(value);
}

function boundedFallback(text) {
  return String(text || "")
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FALLBACK_CHARACTERS);
}

export function formatResultEnvelope(value) {
  const normalized = normalizeResultEnvelope(value);
  const payload = JSON.stringify(normalized);
  if (Buffer.byteLength(payload, "utf8") > MAX_RESULT_BYTES) {
    throw new Error(`result envelope exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  return [
    RESULT_BLOCK_MARKER,
    payload,
    "```",
  ].join("\n");
}

export function parseResultEnvelope(text) {
  const source = String(text || "");
  const scanned = source.slice(-MAX_SCAN_CHARACTERS);
  const matches = [...scanned.matchAll(RESULT_BLOCK_PATTERN)];
  const markers = [...scanned.matchAll(RESULT_MARKER_PATTERN)];

  if (matches.length === 0) {
    if (markers.length > 0) {
      return invalid("unterminated_envelope", "result envelope fence is incomplete");
    }
    const summary = boundedFallback(scanned);
    return summary
      ? { format: "text", result: null, fallbackSummary: summary, error: null }
      : { format: "missing", result: null, fallbackSummary: null, error: null };
  }

  const latest = matches.at(-1);
  if (markers.at(-1)?.index > latest.index) {
    return invalid("unterminated_envelope", "result envelope fence is incomplete");
  }
  const trailing = scanned.slice(latest.index + latest[0].length).trim();
  if (trailing) {
    return invalid(
      "nonterminal_envelope",
      "result envelope must be the final response block",
    );
  }

  const payload = latest[1].trim();
  if (Buffer.byteLength(payload, "utf8") > MAX_RESULT_BYTES) {
    return invalid(
      "envelope_too_large",
      `result envelope exceeds ${MAX_RESULT_BYTES} bytes`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return invalid("invalid_json", "result envelope is not valid JSON");
  }

  try {
    return {
      format: "envelope",
      result: normalizeResultEnvelope(parsed),
      fallbackSummary: null,
      error: null,
    };
  } catch (error) {
    return invalid("invalid_schema", error.message);
  }
}

export function finalAgentMessage(turn) {
  const messages = (turn?.items || []).filter(
    (item) => item?.type === "agentMessage" && typeof item.text === "string",
  );
  const finalMessages = messages.filter(
    (item) => normalizedStatus(item.phase) === "finalanswer",
  );
  const unphasedMessages = messages.filter((item) => !normalizedStatus(item.phase));
  return (finalMessages.at(-1) || unphasedMessages.at(-1))?.text ?? null;
}

export function classifyWorkResult({ available = true, latestTurn = null } = {}) {
  if (!available) {
    return {
      transportStatus: "unavailable",
      workOutcome: "unknown",
      resultState: "unavailable",
      attentionRequired: true,
      attentionReason: "unavailable",
      result: null,
      fallbackSummary: null,
      resultError: null,
    };
  }

  if (!latestTurn) {
    return {
      transportStatus: "waiting",
      workOutcome: "unknown",
      resultState: "pending",
      attentionRequired: false,
      attentionReason: null,
      result: null,
      fallbackSummary: null,
      resultError: null,
    };
  }

  const status = normalizedStatus(latestTurn.status);
  if (["inprogress", "running", "active", "queued", "pending"].includes(status)) {
    return {
      transportStatus: "running",
      workOutcome: "unknown",
      resultState: "running",
      attentionRequired: false,
      attentionReason: null,
      result: null,
      fallbackSummary: null,
      resultError: null,
    };
  }
  if (["failed", "error", "cancelled", "canceled", "interrupted"].includes(status)) {
    return {
      transportStatus: "failed",
      workOutcome: "unknown",
      resultState: "turn_failed",
      attentionRequired: true,
      attentionReason: "turn_failed",
      result: null,
      fallbackSummary: null,
      resultError: null,
    };
  }
  if (["waiting", "idle"].includes(status)) {
    return {
      transportStatus: "waiting",
      workOutcome: "unknown",
      resultState: "pending",
      attentionRequired: false,
      attentionReason: null,
      result: null,
      fallbackSummary: null,
      resultError: null,
    };
  }
  if (!["completed", "complete", "succeeded"].includes(status)) {
    return {
      transportStatus: "unknown",
      workOutcome: "unknown",
      resultState: "unknown_lifecycle",
      attentionRequired: true,
      attentionReason: "unknown_lifecycle",
      result: null,
      fallbackSummary: null,
      resultError: null,
    };
  }

  const parsed = parseResultEnvelope(finalAgentMessage(latestTurn));
  if (parsed.format === "envelope") {
    const attentionRequired = parsed.result.outcome !== "succeeded";
    return {
      transportStatus: "completed",
      workOutcome: parsed.result.outcome,
      resultState: "valid",
      attentionRequired,
      attentionReason: attentionRequired ? parsed.result.outcome : null,
      result: parsed.result,
      fallbackSummary: null,
      resultError: null,
    };
  }
  if (parsed.format === "text") {
    return {
      transportStatus: "completed",
      workOutcome: "unknown",
      resultState: "text_fallback",
      attentionRequired: true,
      attentionReason: "unstructured_result",
      result: null,
      fallbackSummary: parsed.fallbackSummary,
      resultError: null,
    };
  }
  if (parsed.format === "invalid") {
    return {
      transportStatus: "completed",
      workOutcome: "unknown",
      resultState: "malformed",
      attentionRequired: true,
      attentionReason: "malformed_result",
      result: null,
      fallbackSummary: null,
      resultError: parsed.error,
    };
  }
  return {
    transportStatus: "completed",
    workOutcome: "unknown",
    resultState: "missing",
    attentionRequired: true,
    attentionReason: "missing_result",
    result: null,
    fallbackSummary: null,
    resultError: null,
  };
}

function assertBoundedIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_THREAD_ID_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function boundedPublicText(value) {
  const normalized = String(value || "")
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, MAX_TITLE_CHARACTERS) : null;
}

function optionalWebId(value) {
  if (!value) return null;
  try {
    return assertWebId(value);
  } catch {
    return null;
  }
}

function resolveWeb(records, { webId = null, queenThreadId = null } = {}) {
  const active = records.filter((record) => !record.archivedAt);
  const requestedWebId = webId ? assertWebId(webId) : null;
  const requestedQueenThreadId = queenThreadId
    ? assertBoundedIdentifier(queenThreadId, "queen task ID")
    : null;
  let queen = requestedQueenThreadId
    ? active.find((record) => record.threadId === requestedQueenThreadId)
    : null;

  if (requestedQueenThreadId && !queen) {
    throw new Error(`active queen web not found for task ${requestedQueenThreadId}`);
  }
  if (requestedWebId && queen && queen.outboundWebId !== requestedWebId) {
    throw new Error(
      `task ${requestedQueenThreadId} is not queen of web ${requestedWebId}`,
    );
  }
  const selectedWebId = requestedWebId || queen?.outboundWebId;
  if (!selectedWebId) throw new Error("web collect requires --id or a queen task ID");

  const matchingQueens = active.filter(
    (record) => record.outboundWebId === selectedWebId,
  );
  if (!queen && matchingQueens.length !== 1) {
    throw new Error(
      matchingQueens.length === 0
        ? `active queen not found for web ${selectedWebId}`
        : `multiple active queens found for web ${selectedWebId}`,
    );
  }
  queen ??= matchingQueens[0];
  assertBoundedIdentifier(queen.threadId, "queen task ID");
  if (requestedQueenThreadId && queen.threadId !== requestedQueenThreadId) {
    throw new Error(`task ${requestedQueenThreadId} is not queen of web ${selectedWebId}`);
  }

  const candidateMembers = active.filter(
    (record) =>
      record.threadId !== queen.threadId &&
      record.inboundWebId === selectedWebId,
  );
  const mismatchedMember =
    matchingQueens.length === 1
      ? candidateMembers.find(
          (record) =>
            record.queenThreadId != null &&
            record.queenThreadId !== queen.threadId,
        )
      : null;
  if (mismatchedMember) {
    throw new Error(
      `member ${assertBoundedIdentifier(mismatchedMember.threadId, "member task ID")} ` +
      `does not belong to queen ${queen.threadId}`,
    );
  }
  const directMembers = candidateMembers.filter((record) =>
    record.queenThreadId == null
      ? matchingQueens.length === 1
      : record.queenThreadId === queen.threadId,
  );
  if (directMembers.length > MAX_WEB_MEMBERS) {
    throw new Error(
      `web ${selectedWebId} exceeds the ${MAX_WEB_MEMBERS}-member collection limit`,
    );
  }
  const members = directMembers
    .map((record) => ({
      ...record,
      threadId: assertBoundedIdentifier(record.threadId, "member task ID"),
      collectionBaseTitle: boundedPublicText(
        record.baseTitle || record.renderedTitle || record.threadId,
      ),
    }))
    .sort(
      (left, right) =>
        compareStrings(left.collectionBaseTitle, right.collectionBaseTitle) ||
        compareStrings(left.threadId, right.threadId),
    );
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member.threadId)) {
      throw new Error(`duplicate active member in web ${selectedWebId}: ${member.threadId}`);
    }
    seen.add(member.threadId);
  }

  return { queen, selectedWebId, members };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => worker(),
    ),
  );
  return results;
}

function emptyCollectionSummary(total) {
  return {
    total,
    unknown: 0,
    succeeded: 0,
    blocked: 0,
    failed: 0,
    attention: 0,
  };
}

function summarizeCollectionMembers(members) {
  const summary = emptyCollectionSummary(members.length);
  for (const member of members) {
    summary[member.workOutcome] += 1;
    if (member.attentionRequired) summary.attention += 1;
  }
  return summary;
}

function terminalTransportStatus(member) {
  return ["completed", "failed"].includes(member?.transportStatus);
}

function preserveMemberEvidence(member, previousMember) {
  if (member?.transportStatus === "unavailable" && previousMember) {
    return previousMember;
  }
  if (
    terminalTransportStatus(member) ||
    member?.resultState === "valid" ||
    previousMember?.resultState !== "valid" ||
    !previousMember.result
  ) {
    return member;
  }
  return {
    ...member,
    workOutcome: previousMember.workOutcome,
    resultState: "valid",
    sourceTurnId: previousMember.sourceTurnId,
    result: previousMember.result,
    fallbackSummary: null,
    resultError: null,
  };
}

export function preserveWebCollectionEvidence({
  collection,
  previousCollection = null,
} = {}) {
  if (!collection || !Array.isArray(collection.members)) {
    throw new Error("collection must contain a members array");
  }

  const previousMembers =
    previousCollection?.webId === collection.webId &&
    Array.isArray(previousCollection.members)
      ? new Map(previousCollection.members.map((member) => [member.threadId, member]))
      : new Map();
  const members = collection.members.map((member) =>
    preserveMemberEvidence(member, previousMembers.get(member.threadId)),
  );

  return {
    ...collection,
    summary: summarizeCollectionMembers(members),
    members,
  };
}

export function timeoutWebCollection({
  collection,
  previousCollection = null,
  maxWaitMs,
  elapsedMs,
} = {}) {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs <= 0) {
    throw new Error("maxWaitMs must be a positive integer");
  }
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new Error("elapsedMs must be a non-negative integer");
  }

  const preserved = preserveWebCollectionEvidence({
    collection,
    previousCollection,
  });
  const nonterminalMembers = preserved.members
    .filter((member) => !terminalTransportStatus(member))
    .map((member) => ({
      threadId: member.threadId,
      workUnitId:
        member.resultState === "valid" ? member.result?.workUnitId ?? null : null,
      transportStatus: member.transportStatus,
      workOutcome: member.workOutcome,
      latestTurnId: member.latestTurnId,
      sourceTurnId: member.sourceTurnId,
    }));

  return {
    ...preserved,
    allSucceeded: false,
    wait: {
      status: "timed_out",
      settled: false,
      maxWaitMs,
      elapsedMs,
      mayStillBeRunning: nonterminalMembers.length > 0,
      nonterminalCount: nonterminalMembers.length,
      nonterminalMembers,
    },
  };
}

function completedResultTurn(latestTurn, turns) {
  const latestStatus = normalizedStatus(latestTurn?.status);
  if (["completed", "complete", "succeeded"].includes(latestStatus)) {
    return latestTurn;
  }
  if (!["inprogress", "running", "active", "queued", "pending"].includes(latestStatus)) {
    return null;
  }
  return turns
    .slice(1)
    .find((turn) =>
      ["completed", "complete", "succeeded"].includes(
        normalizedStatus(turn?.status),
      ),
    ) ?? null;
}

function classifyCollectedResult(latestTurn, turns) {
  const lifecycle = classifyWorkResult({ latestTurn });
  if (lifecycle.transportStatus !== "running") return lifecycle;

  const resultTurn = completedResultTurn(latestTurn, turns);
  if (!resultTurn) return lifecycle;
  const completed = classifyWorkResult({ latestTurn: resultTurn });
  return {
    ...completed,
    transportStatus: "running",
    attentionRequired: false,
    attentionReason: null,
  };
}

function validatedCollectedTurns(loaded) {
  const turns = Array.isArray(loaded?.turns)
    ? loaded.turns
    : loaded?.latestTurn
      ? [loaded.latestTurn]
      : [];
  const seen = new Set();
  for (let index = 0; index < turns.length; index += 1) {
    const turnId = assertBoundedIdentifier(
      turns[index]?.id,
      `turn ID at collection index ${index}`,
    );
    if (seen.has(turnId)) {
      throw new Error(`duplicate turn ID in collection: ${turnId}`);
    }
    seen.add(turnId);
  }
  return turns;
}

export async function collectWebResults({
  records,
  loadMember,
  webId = null,
  queenThreadId = null,
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  if (typeof loadMember !== "function") throw new Error("loadMember must be a function");

  const resolved = resolveWeb(records, { webId, queenThreadId });
  const members = await mapWithConcurrency(
    resolved.members,
    MAX_CONCURRENT_MEMBER_LOADS,
    async (record) => {
      let loaded = null;
      let turns = [];
      let classification;
      try {
        loaded = await loadMember(record.threadId);
        turns = validatedCollectedTurns(loaded);
        classification = classifyCollectedResult(turns[0] ?? null, turns);
      } catch {
        turns = [];
        classification = classifyWorkResult({ available: false });
      }

      const latestTurn = turns[0] ?? null;
      const resultTurn = completedResultTurn(latestTurn, turns);
      const outboundWebId = optionalWebId(record.outboundWebId);
      const baseTitle = record.collectionBaseTitle;
      return {
        threadId: record.threadId,
        title:
          boundedPublicText(loaded?.thread?.name) ||
          boundedPublicText(record.renderedTitle) ||
          baseTitle ||
          record.threadId,
        baseTitle,
        role: outboundWebId ? "member-queen" : "member",
        queenThreadId: resolved.queen.threadId,
        inboundWebId: resolved.selectedWebId,
        outboundWebId,
        latestTurnId: latestTurn?.id ?? null,
        sourceTurnId: resultTurn?.id ?? null,
        ...classification,
      };
    },
  );

  return {
    command: "web collect",
    schemaVersion: WEB_COLLECTION_SCHEMA_VERSION,
    webId: resolved.selectedWebId,
    queenThreadId: resolved.queen.threadId,
    collectedAt: now().toISOString(),
    summary: summarizeCollectionMembers(members),
    count: members.length,
    allSucceeded:
      members.length > 0 &&
      members.every(
        (member) =>
          member.transportStatus === "completed" &&
          member.workOutcome === "succeeded" &&
          member.latestTurnId !== null &&
          member.sourceTurnId === member.latestTurnId,
      ),
    members,
  };
}
