import { createEvidenceEvent, assertTokenMeasures, TASK_WEB_ROLES, TOKEN_CATEGORIES } from "./contracts.mjs";
import { evidenceFailure } from "./errors.mjs";

export const COLLECTOR_SOURCES = Object.freeze({
  "codex-jsonl": { eventType: "codex.turn.observed", stream: "measurement" },
  "app-server": { eventType: "app_server.event.observed", stream: "operational" },
  opentelemetry: { eventType: "runtime.span.observed", stream: "operational" },
  "nelos-task-web": { eventType: "task_web.member.terminal", stream: "measurement" },
  grader: { eventType: "grader.invocation.terminal", stream: "measurement" },
  "runtime-resource": { eventType: "runtime.resource.observed", stream: "measurement" },
  artifact: { eventType: "artifact.committed", stream: "audit" },
});

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) evidenceFailure("MALFORMED_SOURCE", `${label} must be an object`);
}

function rejectInlineSensitiveContent(value, path = "/payload") {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (/^(?:prompt|response|stdout|stderr|toolArguments|toolResult|environment|authorization|cookie|privateKey)$/iu.test(key)) {
      evidenceFailure("PRIVACY_VIOLATION", `${key} must be represented by a classified artifact reference`, { path: childPath });
    }
    rejectInlineSensitiveContent(child, childPath);
  }
}

export function collectEvidenceEvent(source, record, context, options = {}) {
  const sourceContract = COLLECTOR_SOURCES[source];
  if (!sourceContract) evidenceFailure("UNSUPPORTED_COLLECTOR", `unsupported collector source ${source}`);
  plainObject(record, "source record");
  plainObject(context, "collector context");
  const payload = { source, sourceVersion: record.sourceVersion ?? 1, ...record.payload };
  rejectInlineSensitiveContent(payload);
  return createEvidenceEvent({
    ...context,
    ...record.identities,
    eventId: record.eventId,
    eventType: record.eventType ?? sourceContract.eventType,
    stream: record.stream ?? sourceContract.stream,
    payloadSchema: record.payloadSchema ?? `nelos://events/${record.eventType ?? sourceContract.eventType}/v1`,
    payload,
    classification: record.classification ?? "internal",
    redaction: record.redaction,
  }, options);
}

function addNullable(total, value) {
  if (value === null || value === undefined) return total;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) evidenceFailure("INVALID_MEASUREMENT", "cost measure is invalid");
  return (total ?? 0) + value;
}

export function accountTaskWeb(events, { rateTable = null, expectedMembers = [] } = {}) {
  if (!Array.isArray(events)) evidenceFailure("INVALID_ACCOUNTING_INPUT", "events must be an array");
  const seenRequests = new Set();
  const seenTurns = new Set();
  const observedMembers = new Map();
  const measuredTokens = Object.fromEntries(TOKEN_CATEGORIES.map((category) => [category, null]));
  let observedBillingCredits = null;
  let observedCurrencyCost = null;
  let corrections = 0;
  let retries = 0;
  let blocked = 0;
  let failures = 0;

  for (const event of events) {
    if (event.rootTrialId !== events[0]?.rootTrialId) evidenceFailure("CROSS_RUN_EVIDENCE", "task-web events cross root trial boundaries");
    const payload = event.payload ?? {};
    if (payload.memberRole) {
      if (!TASK_WEB_ROLES.includes(payload.memberRole) || !event.threadId) evidenceFailure("UNATTRIBUTED_DESCENDANT", "task-web member identity is incomplete");
      const existing = observedMembers.get(event.threadId);
      if (existing && existing !== payload.memberRole) evidenceFailure("INCOMPATIBLE_EVIDENCE", "thread role changed within an attempt");
      observedMembers.set(event.threadId, payload.memberRole);
    }
    if ((payload.measuredTokens || event.modelRequestId || event.turnId) && !payload.memberRole) {
      evidenceFailure("UNATTRIBUTED_DESCENDANT", "usage-bearing task-web evidence requires a member role");
    }
    if (event.turnId) {
      const turnKey = `${event.threadId}:${event.turnId}`;
      if (seenTurns.has(turnKey)) continue;
      seenTurns.add(turnKey);
    }
    if (event.modelRequestId) {
      if (seenRequests.has(event.modelRequestId)) continue;
      seenRequests.add(event.modelRequestId);
    }
    if (payload.measuredTokens) {
      assertTokenMeasures(payload.measuredTokens);
      for (const category of TOKEN_CATEGORIES) {
        if (payload.measuredTokens[category] !== null) measuredTokens[category] = (measuredTokens[category] ?? 0) + payload.measuredTokens[category];
      }
    }
    observedBillingCredits = addNullable(observedBillingCredits, payload.observedBillingCredits);
    observedCurrencyCost = addNullable(observedCurrencyCost, payload.observedCurrencyCost);
    corrections += payload.correction === true ? 1 : 0;
    retries += payload.retry === true ? 1 : 0;
    blocked += payload.outcome === "blocked" ? 1 : 0;
    failures += payload.outcome === "failed" ? 1 : 0;
  }

  const missingMembers = expectedMembers.filter(({ threadId, role }) => observedMembers.get(threadId) !== role);
  if (missingMembers.length > 0) evidenceFailure("UNATTRIBUTED_DESCENDANT", "expected task-web members are missing or misattributed", { missingMembers });

  let estimatedStandardCredits = null;
  let rateTableVersion = null;
  if (rateTable) {
    if (typeof rateTable.version !== "string" || !rateTable.rates || typeof rateTable.rates !== "object") evidenceFailure("INVALID_RATE_TABLE", "rate table is invalid");
    rateTableVersion = rateTable.version;
    estimatedStandardCredits = 0;
    for (const category of TOKEN_CATEGORIES) {
      const tokens = measuredTokens[category];
      const rate = rateTable.rates[category];
      if (tokens === null || typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
        estimatedStandardCredits = null;
        break;
      }
      estimatedStandardCredits += tokens * rate;
    }
  }

  return Object.freeze({
    measuredTokens: Object.freeze(measuredTokens),
    estimatedStandardCredits,
    estimatedStandardCreditsRateTableVersion: rateTableVersion,
    observedBillingCredits,
    observedCurrencyCost,
    taskWeb: Object.freeze({
      members: Object.freeze([...observedMembers].map(([threadId, role]) => Object.freeze({ threadId, role }))),
      modelRequests: seenRequests.size,
      turns: seenTurns.size,
      corrections,
      retries,
      blocked,
      failures,
    }),
  });
}
