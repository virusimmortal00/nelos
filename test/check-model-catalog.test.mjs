import assert from "node:assert/strict";
import test from "node:test";

import { collectGuidance } from "../scripts/check-model-catalog.mjs";
import { MODEL_CATALOG_DOCUMENTATION_CONTRACTS_V1 } from "../src/upstream-documentation-contracts.mjs";

test("offline guidance collection performs no network fetch and returns no guidance text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("collectGuidance({ offline: true }) must not call fetch");
  };

  try {
    const guidance = await collectGuidance({ offline: true });
    assert.deepEqual(guidance, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model guidance uses only declared collector contracts and local fixture responses", async () => {
  const requested = [];
  const guidance = await collectGuidance({
    now: () => "2026-07-29T12:00:00.000Z",
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(
        url.includes("subagents")
          ? "Subagents inherit reasoning effort."
          : "gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna low medium high xhigh max ultra",
        { headers: { "content-type": "text/plain" } },
      );
    },
  });

  assert.deepEqual(
    requested,
    MODEL_CATALOG_DOCUMENTATION_CONTRACTS_V1.map(({ requestedUrl }) => requestedUrl),
  );
  assert.match(guidance.modelsGuidanceText, /gpt-5\.6-sol/u);
  assert.match(guidance.subagentsGuidanceText, /Subagents/u);
  assert.equal(guidance.upstreamDocumentation.status, "available");
  assert.equal(guidance.upstreamDocumentation.records.length, 2);
});

test("model guidance infrastructure failures remain reports, not drift text", async () => {
  const guidance = await collectGuidance({
    now: () => "2026-07-29T12:00:00.000Z",
    fetchImpl: async () => {
      throw new Error("fixture network failure");
    },
  });

  assert.equal(guidance.modelsGuidanceText, undefined);
  assert.equal(guidance.subagentsGuidanceText, undefined);
  assert.equal(guidance.upstreamDocumentation.status, "unavailable");
  assert.ok(
    guidance.upstreamDocumentation.records.every(
      ({ countsForCompatibility }) => countsForCompatibility === false,
    ),
  );
});
