const WEB_ID_PATTERN = /^[A-Z][1-9]\d*(?:\.[1-9]\d*)*$/;
const INBOUND_MARKER = "🕸️";
const OUTBOUND_MARKER = "🕷️";
const QUEEN_MARKER = "👑";

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
  while (remaining.startsWith(QUEEN_MARKER)) {
    const queen = remaining.match(/^👑(?:\s*·)?\s*/u);
    queenMarked = true;
    remaining = remaining.slice(queen[0].length).trim();
  }
  return { queenMarked, remaining };
}

function parseTitleMarkers(title) {
  let remaining = String(title || "").trim();
  let inboundWebId = null;
  let outboundWebId = null;
  const outerQueen = consumeQueenMarkers(remaining);
  let queenMarked = outerQueen.queenMarked;
  remaining = outerQueen.remaining;

  const inbound = remaining.match(
    /^🕸️\s+([A-Za-z][1-9]\d*(?:\.[1-9]\d*)*)\s*/u,
  );
  if (inbound) {
    inboundWebId = assertWebId(inbound[1]);
    remaining = remaining.slice(inbound[0].length);
  }

  const outbound = remaining.match(
    /^🕷️\s+([A-Za-z][1-9]\d*(?:\.[1-9]\d*)*)\s*/u,
  );
  if (outbound) {
    outboundWebId = assertWebId(outbound[1]);
    remaining = remaining.slice(outbound[0].length);
  }

  if (inboundWebId || outboundWebId) {
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

function renderTitleMarkers({
  baseTitle,
  inboundWebId = null,
  outboundWebId = null,
  queenMarked = false,
}) {
  const normalizedBaseTitle = baseTitle.trim();
  if (!normalizedBaseTitle) throw new Error("task title must not be empty");

  const markers = [];
  if (inboundWebId) markers.push(`${INBOUND_MARKER} ${assertWebId(inboundWebId)}`);
  if (outboundWebId) markers.push(`${OUTBOUND_MARKER} ${assertWebId(outboundWebId)}`);
  if (queenMarked) markers.push(QUEEN_MARKER);
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
    inboundWebId: parsed.inboundWebId,
    outboundWebId: parsed.outboundWebId,
    queenMarked: true,
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
