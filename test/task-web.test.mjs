import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateWebId,
  assertWebId,
  parseWebTitle,
  renderPersistedDurableChildTitle,
  renderPersistedQueenWebTitle,
  renderWebTitle,
  resolveQueenMarked,
} from "../src/task-web.mjs";

test("web titles render queen, spinoff, and nested queen roles", () => {
  assert.equal(
    renderWebTitle({ baseTitle: "Release planning", outboundWebId: "A1" }),
    "👑 A1 · Release planning",
  );
  assert.equal(
    renderWebTitle({ baseTitle: "API changes", inboundWebId: "A1" }),
    "🕷️ A1 · API changes",
  );
  assert.equal(
    renderWebTitle({
      baseTitle: "Contract tests",
      inboundWebId: "A1",
      outboundWebId: "A1.1",
    }),
    "👑 A1.1 🕷️ A1 · Contract tests",
  );
});

test("web title parsing makes rendering idempotent", () => {
  const title = "👑 B2.1 🕷️ B2 · Documentation";
  assert.deepEqual(parseWebTitle(title), {
    baseTitle: "Documentation",
    inboundWebId: "B2",
    outboundWebId: "B2.1",
    queenMarked: true,
  });
  assert.equal(
    renderWebTitle({
      baseTitle: title,
      inboundWebId: "B2",
      outboundWebId: "B2.1",
    }),
    title,
  );
});

test("crown and web markers share one idempotent topology-preserving grammar", () => {
  const title = "👑 · 🕷️ B2.1 · Documentation";
  assert.deepEqual(parseWebTitle(title), {
    baseTitle: "Documentation",
    inboundWebId: null,
    outboundWebId: "B2.1",
    queenMarked: true,
  });
  assert.equal(
    renderWebTitle({
      baseTitle: title,
      outboundWebId: "B2.1",
    }),
    "👑 B2.1 · Documentation",
  );
});

test("legacy outer crowns normalize after web markers without duplication", () => {
  const canonical = "👑 A1.1 🕷️ A1 · Documentation";
  for (const legacy of [
    "👑 · 🕸️ a1 🕷️ a1.1 · Documentation",
    "🕸️ a1 🕷️ a1.1 · 👑 · Documentation",
    "👑 · 👑 · 🕸️ a1 🕷️ a1.1 · 👑 · Documentation",
  ]) {
    assert.deepEqual(parseWebTitle(legacy), {
      baseTitle: "Documentation",
      inboundWebId: "A1",
      outboundWebId: "A1.1",
      queenMarked: true,
    });
    assert.equal(
      renderWebTitle({
        baseTitle: legacy,
        inboundWebId: "a1",
        outboundWebId: "a1.1",
      }),
      canonical,
    );
  }
});

test("outbound web responsibility remains crown-first deterministically", () => {
  assert.equal(
    renderWebTitle({
      baseTitle: "Documentation",
      inboundWebId: "A1",
      outboundWebId: "A1.1",
      queenMarked: true,
    }),
    "👑 A1.1 🕷️ A1 · Documentation",
  );
  assert.equal(
    renderWebTitle({
      baseTitle: "👑 A1.1 🕷️ A1 · Documentation",
      inboundWebId: "A1",
      outboundWebId: "A1.1",
      queenMarked: false,
    }),
    "👑 A1.1 🕷️ A1 · Documentation",
  );
  assert.throws(
    () => renderWebTitle({ baseTitle: "Documentation", queenMarked: "true" }),
    /queenMarked must be a boolean/,
  );
});

test("marker-only titles parse explicitly and cannot be rendered", () => {
  assert.deepEqual(parseWebTitle("🕷️ A1 👑 ·"), {
    baseTitle: "",
    inboundWebId: null,
    outboundWebId: "A1",
    queenMarked: true,
  });
  assert.throws(
    () =>
      renderWebTitle({
        baseTitle: "🕷️ A1 👑 ·",
        outboundWebId: "A1",
      }),
    /task title must not be empty/,
  );
});

test("queen-mark resolution shares requested, live, and record precedence", () => {
  assert.equal(resolveQueenMarked(), false);
  assert.equal(
    resolveQueenMarked({ requestedTitle: "👑 · Requested queen" }),
    true,
  );
  assert.equal(
    resolveQueenMarked({ liveTitle: "🕸️ A1 👑 · Live queen" }),
    true,
  );
  assert.equal(
    resolveQueenMarked({ webRecord: { outboundWebId: "A1" } }),
    true,
  );
  assert.equal(
    resolveQueenMarked({ webRecord: { queenMarked: true } }),
    true,
  );
  assert.equal(
    resolveQueenMarked({
      webRecord: { renderedTitle: "👑 · Legacy record queen" },
    }),
    true,
  );
  assert.equal(
    resolveQueenMarked({
      webRecord: {
        queenMarked: false,
        renderedTitle: "👑 · Stale rendered title",
      },
    }),
    false,
  );
  assert.equal(resolveQueenMarked({ outboundWebId: "A1.1" }), true);
});

test("lowercase web IDs normalize without duplicating title markers", () => {
  const title = "👑 a1.1 🕷️ a1 · Documentation";
  assert.deepEqual(parseWebTitle(title), {
    baseTitle: "Documentation",
    inboundWebId: "A1",
    outboundWebId: "A1.1",
    queenMarked: true,
  });
  assert.equal(
    renderWebTitle({
      baseTitle: title,
      inboundWebId: "a1",
      outboundWebId: "a1.1",
    }),
    "👑 A1.1 🕷️ A1 · Documentation",
  );
});

test("web IDs are compact and validated", () => {
  assert.equal(assertWebId(" a1.2 "), "A1.2");
  for (const invalid of ["A0", "A", "AA", "A1.0", "web-1"]) {
    assert.throws(() => assertWebId(invalid), /web ID must look like A1 or A1\.1/);
  }
});

test("web allocation avoids active IDs and nests beneath inbound webs", () => {
  const records = [
    { inboundWebId: null, outboundWebId: "A1", archivedAt: null },
    { inboundWebId: "A1", outboundWebId: "A1.1", archivedAt: null },
    { inboundWebId: null, outboundWebId: "A2", archivedAt: "2026-01-01" },
  ];

  assert.equal(allocateWebId(records), "A2");
  assert.equal(allocateWebId(records, "A1"), "A1.2");
});

test("active descendants keep every ancestor web ID reserved", () => {
  const records = [
    { outboundWebId: "A1", archivedAt: "2026-01-01" },
    { inboundWebId: "A1.1.1", archivedAt: null },
  ];

  assert.equal(allocateWebId(records), "A2");
  assert.equal(allocateWebId(records, "A1"), "A1.2");
});

test("settled but unarchived queens keep normalized web IDs reserved", () => {
  const records = [
    {
      threadId: "settled-queen",
      outboundWebId: "a1",
      status: "completed",
      archivedAt: null,
    },
  ];

  assert.equal(allocateWebId(records), "A2");
  assert.equal(
    allocateWebId([{ ...records[0], outboundWebId: "A1" }]),
    "A2",
  );
});

test("persisted queen and durable child titles converge without duplicate markers", () => {
  assert.equal(
    renderPersistedQueenWebTitle("👑 · 🕷️ a1 · Release", "A1"),
    "👑 A1 · Release",
  );
  assert.equal(
    renderPersistedDurableChildTitle(
      "🕸️ a1 🕷️ a1.1 👑 · Nested delivery",
      "A1",
    ),
    "👑 A1.1 🕷️ A1 · Nested delivery",
  );
  assert.equal(
    renderPersistedDurableChildTitle("👑 · Nested delivery", "A1"),
    "👑 🕷️ A1 · Nested delivery",
  );
});

test("persisted title decoration fails closed on conflicting lineage", () => {
  assert.throws(
    () => renderPersistedQueenWebTitle("🕷️ A2 · Release", "A1"),
    /queen outbound marker A2 conflicts with persisted web identity A1/u,
  );
  assert.throws(
    () => renderPersistedDurableChildTitle("🕸️ A2 · Delivery", "A1"),
    /child inbound marker A2 conflicts with persisted web identity A1/u,
  );
});
