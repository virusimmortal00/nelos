const TOP_LEVEL_HEX_PATTERN = /^[1-9A-F][0-9A-F]*$/;
const LEGACY_TOP_LEVEL_PATTERN = /^[A-Z][1-9]\d*$/;
const WEB_ID_PATTERN = /^(?:[1-9A-F][0-9A-F]*|[A-Z][1-9]\d*)(?:\.[1-9]\d*)*$/;
const LEGACY_INBOUND_MARKER = "🕸️";
const MEMBER_MARKER = "🕷️";
const QUEEN_MARKER = "👑";
const WEB_ID_SOURCE = "((?:[1-9A-Fa-f][0-9A-Fa-f]*|[A-Za-z][1-9]\\d*)(?:\\.[1-9]\\d*)*)";
const COMPACT_QUEEN_PATTERN = new RegExp(`^${QUEEN_MARKER}${WEB_ID_SOURCE}\\s*`, "u");
const COMPACT_MEMBER_PATTERN = new RegExp(`^${MEMBER_MARKER}${WEB_ID_SOURCE}\\s*`, "u");
const QUEEN_MARKER_PATTERN = new RegExp(
  `^${QUEEN_MARKER}(?:\\s*·)?\\s*`,
  "u",
);
const QUEEN_WITH_WEB_PATTERN = new RegExp(
  `^${QUEEN_MARKER}\\s+${WEB_ID_SOURCE}\\s*`,
  "u",
);
const LEGACY_INBOUND_PATTERN = new RegExp(
  `^${LEGACY_INBOUND_MARKER}\\s+${WEB_ID_SOURCE}\\s*`,
  "u",
);
const MEMBER_PATTERN = new RegExp(
  `^${MEMBER_MARKER}\\s+${WEB_ID_SOURCE}\\s*`,
  "u",
);

export const QUEEN_TITLE_PREFIX = `${QUEEN_MARKER} ·`;
export const CODEX_NATIVE_TITLE_MAX_UTF16_LENGTH = 60;
const CODEX_NATIVE_TITLE_ELLIPSIS = "…";

/**
 * Codex stores overlength task titles as a 60-code-unit display title whose
 * final code unit is an ellipsis. Treat only that exact host normalization as
 * equivalent; arbitrary prefixes and other title changes remain mismatches.
 */
export function nativeTitleMatchesRequested(requestedTitle, observedTitle) {
  if (
    typeof requestedTitle !== "string" ||
    typeof observedTitle !== "string"
  ) {
    return false;
  }
  if (observedTitle === requestedTitle) return true;
  if (requestedTitle.length <= CODEX_NATIVE_TITLE_MAX_UTF16_LENGTH) {
    return false;
  }
  let prefix = requestedTitle.slice(
    0,
    CODEX_NATIVE_TITLE_MAX_UTF16_LENGTH - CODEX_NATIVE_TITLE_ELLIPSIS.length,
  );
  // Do not manufacture an invalid UTF-16 title if the limit intersects a
  // surrogate pair. A host-produced normalized title must preserve the pair.
  if (/\p{Surrogate}$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return observedTitle === `${prefix}${CODEX_NATIVE_TITLE_ELLIPSIS}`;
}

export function assertWebId(webId) {
  const normalized = String(webId || "").trim().toUpperCase();
  const topLevel = normalized.split(".", 1)[0];
  if (
    !WEB_ID_PATTERN.test(normalized) ||
    (TOP_LEVEL_HEX_PATTERN.test(topLevel) &&
      !Number.isSafeInteger(Number.parseInt(topLevel, 16)))
  ) {
    throw new Error("web ID must be a compact uppercase lineage such as B8 or B8.1");
  }
  return normalized;
}

export function parentWebId(webId) {
  const normalized = assertWebId(webId);
  const segments = normalized.split(".");
  return segments.length === 1 ? null : segments.slice(0, -1).join(".");
}

function consumeQueenMarkers(title) {
  let remaining = title.trim();
  let queenMarked = false;
  let delimited = false;
  while (remaining.startsWith(QUEEN_MARKER)) {
    const queen = remaining.match(QUEEN_MARKER_PATTERN);
    queenMarked = true;
    delimited ||= queen[0].includes("·");
    remaining = remaining.slice(queen[0].length).trim();
  }
  return { queenMarked, delimited, remaining };
}

function parseTitleMarkers(title) {
  let remaining = String(title || "").trim();
  let inboundWebId = null;
  let outboundWebId = null;
  let queenMarked = false;
  let legacySpiderOnlyWebId = null;
  let lineageId = null;

  const compactQueen = remaining.match(COMPACT_QUEEN_PATTERN);
  const compactMember = compactQueen ? null : remaining.match(COMPACT_MEMBER_PATTERN);
  if (compactQueen) {
    queenMarked = true;
    lineageId = assertWebId(compactQueen[1]);
    outboundWebId = lineageId;
    inboundWebId = parentWebId(lineageId);
    remaining = remaining.slice(compactQueen[0].length);
  } else if (compactMember) {
    lineageId = assertWebId(compactMember[1]);
    inboundWebId = parentWebId(lineageId) ?? lineageId;
    remaining = remaining.slice(compactMember[0].length);
  } else {
    const canonicalQueen = remaining.match(QUEEN_WITH_WEB_PATTERN);
    if (canonicalQueen) {
    queenMarked = true;
    outboundWebId = assertWebId(canonicalQueen[1]);
    lineageId = outboundWebId;
    remaining = remaining.slice(canonicalQueen[0].length);
    const inboundMember = remaining.match(MEMBER_PATTERN);
    if (inboundMember) {
      inboundWebId = assertWebId(inboundMember[1]);
      remaining = remaining.slice(inboundMember[0].length);
    }
    } else {
    const outerQueen = consumeQueenMarkers(remaining);
    queenMarked = outerQueen.queenMarked;
    remaining = outerQueen.remaining;

    const legacyInbound = remaining.match(LEGACY_INBOUND_PATTERN);
    if (legacyInbound) {
      inboundWebId = assertWebId(legacyInbound[1]);
      lineageId = inboundWebId;
      remaining = remaining.slice(legacyInbound[0].length);
      const legacyOutbound = remaining.match(MEMBER_PATTERN);
      if (legacyOutbound) {
        outboundWebId = assertWebId(legacyOutbound[1]);
        remaining = remaining.slice(legacyOutbound[0].length);
      }
    } else {
      const member = remaining.match(MEMBER_PATTERN);
      if (member) {
        const webId = assertWebId(member[1]);
        remaining = remaining.slice(member[0].length);
        const legacyInnerQueen = consumeQueenMarkers(remaining);
        // Legacy `👑 🕷️ A1 · X` stores A1 as inbound, while
        // `👑 · 🕷️ A1 · X` stores it as outbound; the delimiter marks the
        // outer crown as a distinct queen marker and flips the direction.
        if (
          legacyInnerQueen.queenMarked ||
          (outerQueen.queenMarked && outerQueen.delimited)
        ) {
          queenMarked = true;
          outboundWebId = webId;
          lineageId = webId;
          remaining = legacyInnerQueen.remaining;
        } else if (outerQueen.queenMarked) {
          inboundWebId = webId;
          lineageId = webId;
        } else {
          inboundWebId = webId;
          legacySpiderOnlyWebId = webId;
          lineageId = webId;
        }
      }
    }
  }
  }

  if (inboundWebId || outboundWebId || queenMarked) {
    remaining = remaining.replace(/^·\s*/, "").trim();
  }

  const innerQueen = consumeQueenMarkers(remaining);
  queenMarked ||= innerQueen.queenMarked;
  remaining = innerQueen.remaining;

  return {
    baseTitle: remaining,
    inboundWebId,
    outboundWebId,
    queenMarked,
    legacySpiderOnlyWebId,
    lineageId,
  };
}

export function parseWebTitle(title) {
  const parsed = parseTitleMarkers(title);
  return {
    baseTitle: parsed.baseTitle,
    inboundWebId: parsed.inboundWebId,
    outboundWebId: parsed.outboundWebId,
    queenMarked: parsed.queenMarked,
  };
}

export function titleLineageId(title) {
  return parseTitleMarkers(title).lineageId;
}

export function resolveQueenMarked({
  requestedTitle = "",
  liveTitle = "",
  webRecord = null,
  outboundWebId = null,
} = {}) {
  if (parseTitleMarkers(requestedTitle).queenMarked) return true;
  if (parseTitleMarkers(liveTitle).queenMarked) return true;
  if (outboundWebId) return true;
  if (!webRecord || typeof webRecord !== "object") return false;
  if (webRecord.outboundWebId) return true;
  if (typeof webRecord.queenMarked === "boolean") {
    return webRecord.queenMarked;
  }
  return parseTitleMarkers(
    webRecord.renderedTitle || webRecord.baseTitle || "",
  ).queenMarked;
}

function renderTitleMarkers({
  baseTitle,
  inboundWebId = null,
  outboundWebId = null,
  lineageId = null,
  queenMarked = false,
}) {
  const normalizedBaseTitle = baseTitle.trim();
  if (!normalizedBaseTitle) throw new Error("task title must not be empty");

  if (queenMarked || outboundWebId) {
    const marker = outboundWebId
      ? `${QUEEN_MARKER}${assertWebId(outboundWebId)}`
      : QUEEN_MARKER;
    return `${marker} · ${normalizedBaseTitle}`;
  }
  if (inboundWebId) {
    const memberLineage = assertWebId(lineageId ?? inboundWebId);
    const expectedParent = parentWebId(memberLineage);
    if (expectedParent !== null && expectedParent !== assertWebId(inboundWebId)) {
      throw new Error("member lineage conflicts with its parent web identity");
    }
    return `${MEMBER_MARKER}${memberLineage} · ${normalizedBaseTitle}`;
  }
  return normalizedBaseTitle;
}

export function renderWebTitle({
  baseTitle,
  inboundWebId = null,
  outboundWebId = null,
  lineageId = null,
  queenMarked,
}) {
  if (queenMarked !== undefined && typeof queenMarked !== "boolean") {
    throw new Error("queenMarked must be a boolean");
  }
  const parsed = parseTitleMarkers(baseTitle);
  return renderTitleMarkers({
    baseTitle: parsed.baseTitle,
    inboundWebId,
    outboundWebId,
    lineageId,
    queenMarked: queenMarked ?? parsed.queenMarked,
  });
}

export function renderQueenTitle(title) {
  if (typeof title !== "string" || !title.trim()) {
    throw new Error("task launch title must be a non-empty string");
  }
  const parsed = parseTitleMarkers(title);
  if (!parsed.baseTitle) {
    throw new Error("task launch title must include text after the queen marker");
  }
  return renderTitleMarkers({
    baseTitle: parsed.baseTitle,
    inboundWebId: parsed.legacySpiderOnlyWebId
      ? null
      : parsed.inboundWebId,
    outboundWebId:
      parsed.outboundWebId ?? parsed.legacySpiderOnlyWebId ??
      (parsed.queenMarked ? parsed.lineageId : null),
    queenMarked: true,
  });
}

function assertMatchingMarker(actual, expected, label) {
  if (actual && assertWebId(actual) !== assertWebId(expected)) {
    throw new Error(
      `${label} ${assertWebId(actual)} conflicts with persisted web identity ${assertWebId(expected)}`,
    );
  }
}

/**
 * Decorate the current queen with one permanent compact web identity.
 */
export function renderPersistedQueenWebTitle(title, webId) {
  const normalizedWebId = assertWebId(webId);
  const parsed = parseTitleMarkers(title);
  if (!parsed.baseTitle) {
    throw new Error("current queen task has no settled title");
  }
  const parsedOutboundWebId =
    parsed.outboundWebId ?? parsed.legacySpiderOnlyWebId;
  const parsedInboundWebId = parsed.legacySpiderOnlyWebId
    ? null
    : parsed.inboundWebId;
  assertMatchingMarker(
    parsedOutboundWebId,
    normalizedWebId,
    "queen outbound marker",
  );
  return renderTitleMarkers({
    baseTitle: parsed.baseTitle,
    inboundWebId: parsedInboundWebId,
    outboundWebId: normalizedWebId,
    queenMarked: true,
  });
}

/**
 * Decorate a durable child without discarding a pre-existing nested-queen
 * marker. A conflicting inbound marker is lineage evidence, not a rename hint.
 */
export function renderPersistedDurableChildTitle(title, webId) {
  const normalizedLineageId = assertWebId(webId);
  const normalizedWebId = parentWebId(normalizedLineageId) ?? normalizedLineageId;
  const parsed = parseTitleMarkers(title);
  if (!parsed.baseTitle) {
    throw new Error("durable child title must include visible text");
  }
  if (
    parsed.inboundWebId &&
    parsed.inboundWebId !== normalizedWebId &&
    parsed.inboundWebId !== normalizedLineageId
  ) {
    assertMatchingMarker(parsed.inboundWebId, normalizedWebId, "child inbound marker");
  }
  return renderTitleMarkers({
    baseTitle: parsed.baseTitle,
    inboundWebId: normalizedWebId,
    lineageId: normalizedLineageId,
    outboundWebId: parsed.queenMarked ? normalizedLineageId : null,
    queenMarked: parsed.queenMarked,
  });
}

export const WEB_LINEAGE_STATE_SCHEMA_VERSION = 1;

function legacyTopLevelOrdinal(value) {
  const match = value.match(/^([A-Z])([1-9]\d*)$/u);
  if (!match) return 0;
  const letter = match[1].charCodeAt(0) - 65;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return 0;
  return number <= 9
    ? letter * 9 + number
    : 26 * 9 + (number - 10) * 26 + letter + 1;
}

function topLevelOrdinal(webId) {
  const top = assertWebId(webId).split(".", 1)[0];
  if (TOP_LEVEL_HEX_PATTERN.test(top)) return Number.parseInt(top, 16);
  return legacyTopLevelOrdinal(top);
}

function recognizedIds(records, assignments = {}) {
  const ids = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    try {
      const normalized = assertWebId(candidate);
      const segments = normalized.split(".");
      for (let length = 1; length <= segments.length; length += 1) {
        ids.add(segments.slice(0, length).join("."));
      }
    } catch {
      // Unrecognized legacy text cannot safely influence the allocator.
    }
  };
  for (const record of records ?? []) {
    add(record?.inboundWebId);
    add(record?.outboundWebId);
    add(record?.lineageId);
    add(record?.web?.inboundWebId);
    add(record?.web?.outboundWebId);
    add(record?.web?.lineageId);
    add(titleLineageId(record?.renderedTitle ?? record?.title ?? ""));
  }
  Object.values(assignments).forEach(add);
  return ids;
}

export function normalizeWebLineageState(value, records = []) {
  const source = value ?? {};
  if (
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    Object.keys(source).some(
      (field) => !["schemaVersion", "topLevelHighWater", "childHighWater", "assignments"].includes(field),
    ) ||
    (source.schemaVersion !== undefined && source.schemaVersion !== 1)
  ) {
    throw new Error("web lineage allocation state is invalid");
  }
  const assignments = { ...(source.assignments ?? {}) };
  const forbiddenAssignmentKeys = new Set(["__proto__", "prototype", "constructor"]);
  if (
    Object.keys(assignments).length > 100_000 ||
    Object.entries(assignments).some(([key, webId]) =>
      typeof key !== "string" || key.length === 0 || key.length > 512 ||
      forbiddenAssignmentKeys.has(key) ||
      assertWebId(webId) !== webId)
  ) {
    throw new Error("web lineage assignments are invalid");
  }
  const ids = recognizedIds(records, assignments);
  let topLevelHighWater = source.topLevelHighWater ?? 0;
  if (!Number.isSafeInteger(topLevelHighWater) || topLevelHighWater < 0) {
    throw new Error("web lineage top-level high-water mark is invalid");
  }
  const childHighWater = { ...(source.childHighWater ?? {}) };
  for (const [parent, highWater] of Object.entries(childHighWater)) {
    if (
      assertWebId(parent) !== parent ||
      !Number.isSafeInteger(highWater) ||
      highWater < 0
    ) {
      throw new Error("web lineage child high-water marks are invalid");
    }
  }
  for (const id of ids) {
    topLevelHighWater = Math.max(topLevelHighWater, topLevelOrdinal(id));
    const parent = parentWebId(id);
    if (parent !== null) {
      const suffix = Number(id.slice(parent.length + 1));
      childHighWater[parent] = Math.max(childHighWater[parent] ?? 0, suffix);
    }
  }
  return {
    schemaVersion: WEB_LINEAGE_STATE_SCHEMA_VERSION,
    topLevelHighWater,
    childHighWater,
    assignments,
  };
}

export function allocatePermanentWebId(
  state,
  records,
  { allocationKey, parentWebId: requestedParent = null },
) {
  if (
    typeof allocationKey !== "string" ||
    allocationKey.length === 0 ||
    allocationKey.length > 512 ||
    ["__proto__", "prototype", "constructor"].includes(allocationKey) ||
    /[\u0000-\u001f\u007f]/u.test(allocationKey)
  ) {
    throw new Error("web lineage allocation key is invalid");
  }
  const normalized = normalizeWebLineageState(state, records);
  const existing = normalized.assignments[allocationKey];
  if (existing) {
    const expectedParent = requestedParent === null ? null : assertWebId(requestedParent);
    if (parentWebId(existing) !== expectedParent) {
      throw new Error("web lineage allocation key conflicts with its persisted parent");
    }
    return { state: normalized, webId: existing, reused: true };
  }
  const used = recognizedIds(records, normalized.assignments);
  let webId;
  if (requestedParent !== null) {
    const parent = assertWebId(requestedParent);
    let suffix = normalized.childHighWater[parent] ?? 0;
    do {
      suffix += 1;
      if (!Number.isSafeInteger(suffix)) throw new Error("no child web IDs are available");
      webId = `${parent}.${suffix}`;
    } while (used.has(webId));
    normalized.childHighWater[parent] = suffix;
  } else {
    let counter = normalized.topLevelHighWater;
    do {
      counter += 1;
      if (!Number.isSafeInteger(counter)) throw new Error("no top-level web IDs are available");
      webId = counter.toString(16).toUpperCase();
    } while (used.has(webId));
    normalized.topLevelHighWater = counter;
  }
  normalized.assignments[allocationKey] = webId;
  return { state: normalized, webId, reused: false };
}

/** Compatibility-only in-memory allocation. Durable callers persist the state. */
export function allocateWebId(records, inboundWebId = null) {
  return allocatePermanentWebId(null, records, {
    allocationKey: `ephemeral:${records?.length ?? 0}:${inboundWebId ?? "root"}`,
    parentWebId: inboundWebId,
  }).webId;
}
