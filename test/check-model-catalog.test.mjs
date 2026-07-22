import assert from "node:assert/strict";
import test from "node:test";

import { collectGuidance } from "../scripts/check-model-catalog.mjs";

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
