const WEB_ID_PATTERN = /^[A-Z][1-9]\d*(?:\.[1-9]\d*)*$/;
const LEGACY_INBOUND_MARKER = "🕸️";
const MEMBER_MARKER = "🕷️";
const QUEEN_MARKER = "👑";
const WEB_ID_SOURCE = "([A-Za-z][1-9]\\d*(?:\\.[1-9]\\d*)*)";
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

export function assertWebId(webId) {
  const normalized = String(webId || "").trim().toUpperCase();
  if (!WEB_ID_PATTERN.test(normalized)) {
    throw new Error("web ID must look like A1 or A1.1");
  }
  return normalized;
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

  const canonicalQueen = remaining.match(QUEEN_WITH_WEB_PATTERN);
  if (canonicalQueen) {
    queenMarked = true;
    outboundWebId = assertWebId(canonicalQueen[1]);
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
        if (
          legacyInnerQueen.queenMarked ||
          (outerQueen.queenMarked && outerQueen.delimited)
        ) {
          queenMarked = true;
          outboundWebId = webId;
          remaining = legacyInnerQueen.remaining;
        } else if (outerQueen.queenMarked) {
          inboundWebId = webId;
        } else {
          inboundWebId = webId;
          legacySpiderOnlyWebId = webId;
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
  queenMarked = false,
}) {
  const normalizedBaseTitle = baseTitle.trim();
  if (!normalizedBaseTitle) throw new Error("task title must not be empty");

  const markers = [];
  if (queenMarked || outboundWebId) {
    markers.push(
      outboundWebId
        ? `${QUEEN_MARKER} ${assertWebId(outboundWebId)}`
        : QUEEN_MARKER,
    );
    if (inboundWebId) {
      markers.push(`${MEMBER_MARKER} ${assertWebId(inboundWebId)}`);
    }
  } else if (inboundWebId) {
    markers.push(`${MEMBER_MARKER} ${assertWebId(inboundWebId)}`);
  }
  return markers.length > 0
    ? `${markers.join(" ")} · ${normalizedBaseTitle}`
    : normalizedBaseTitle;
}

export function renderWebTitle({
  baseTitle,
  inboundWebId = null,
  outboundWebId = null,
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
      parsed.outboundWebId ?? parsed.legacySpiderOnlyWebId,
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
 * Decorate the current queen with one already-chosen legacy web identity.
 *
 * Allocation intentionally does not live here. The compatibility registry may
 * supply today's A1-style identity; permanent hexadecimal allocation and
 * migration are owned by GitHub issue #23.
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
  const normalizedWebId = assertWebId(webId);
  const parsed = parseTitleMarkers(title);
  if (!parsed.baseTitle) {
    throw new Error("durable child title must include visible text");
  }
  assertMatchingMarker(parsed.inboundWebId, normalizedWebId, "child inbound marker");
  return renderTitleMarkers({
    baseTitle: parsed.baseTitle,
    inboundWebId: normalizedWebId,
    outboundWebId: parsed.outboundWebId,
    queenMarked: parsed.queenMarked,
  });
}

export function allocateWebId(records, inboundWebId = null) {
  const used = new Set();
  // A compact ID is presentation, not lifecycle, state. Every unarchived
  // reference reserves its web and ancestors; a settled turn does not release it.
  for (const record of records.filter((candidate) => !candidate.archivedAt)) {
    for (const webId of [record.inboundWebId, record.outboundWebId]) {
      if (!webId) continue;
      let normalizedWebId;
      try {
        normalizedWebId = assertWebId(webId);
      } catch {
        // Invalid legacy metadata cannot safely reserve a valid compact ID.
        continue;
      }
      const segments = normalizedWebId.split(".");
      for (let length = 1; length <= segments.length; length += 1) {
        used.add(segments.slice(0, length).join("."));
      }
    }
  }

  if (inboundWebId) {
    const parentWebId = assertWebId(inboundWebId);
    for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
      const candidate = `${parentWebId}.${suffix}`;
      if (!used.has(candidate)) return candidate;
    }
  }

  for (let letter = 0; letter < 26; letter += 1) {
    for (let digit = 1; digit <= 9; digit += 1) {
      const candidate = `${String.fromCharCode(65 + letter)}${digit}`;
      if (!used.has(candidate)) return candidate;
    }
  }

  for (let number = 10; number < Number.MAX_SAFE_INTEGER; number += 1) {
    for (let letter = 0; letter < 26; letter += 1) {
      const candidate = `${String.fromCharCode(65 + letter)}${number}`;
      if (!used.has(candidate)) return candidate;
    }
  }

  throw new Error("no web IDs are available");
}
