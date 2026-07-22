import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateWebId,
  assertWebId,
  parseWebTitle,
  renderWebTitle,
} from "../src/task-web.mjs";

test("web titles render queen, spinoff, and nested queen roles", () => {
  assert.equal(
    renderWebTitle({ baseTitle: "Release planning", outboundWebId: "A1" }),
    "🕷️ A1 · Release planning",
  );
  assert.equal(
    renderWebTitle({ baseTitle: "API changes", inboundWebId: "A1" }),
    "🕸️ A1 · API changes",
  );
  assert.equal(
    renderWebTitle({
      baseTitle: "Contract tests",
      inboundWebId: "A1",
      outboundWebId: "A1.1",
    }),
    "🕸️ A1 🕷️ A1.1 · Contract tests",
  );
});

test("web title parsing makes rendering idempotent", () => {
  const title = "🕸️ B2 🕷️ B2.1 · Documentation";
  assert.deepEqual(parseWebTitle(title), {
    baseTitle: "Documentation",
    inboundWebId: "B2",
    outboundWebId: "B2.1",
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

test("lowercase web IDs normalize without duplicating title markers", () => {
  const title = "🕸️ a1 🕷️ a1.1 · Documentation";
  assert.deepEqual(parseWebTitle(title), {
    baseTitle: "Documentation",
    inboundWebId: "A1",
    outboundWebId: "A1.1",
  });
  assert.equal(
    renderWebTitle({
      baseTitle: title,
      inboundWebId: "a1",
      outboundWebId: "a1.1",
    }),
    "🕸️ A1 🕷️ A1.1 · Documentation",
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
