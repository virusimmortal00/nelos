const profiles = Object.freeze({
  astra: Object.freeze({
    id: "astra",
    label: "Astra",
    requestedModel: "gpt-6-astra",
    supportedEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  }),
  sol: Object.freeze({
    id: "sol",
    label: "Sol",
    requestedModel: "gpt-5.6-sol",
    supportedEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  }),
  terra: Object.freeze({
    id: "terra",
    label: "Terra",
    requestedModel: "gpt-5.6-terra",
    supportedEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  }),
  luna: Object.freeze({
    id: "luna",
    label: "Luna",
    requestedModel: "gpt-5.6-luna",
    supportedEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  }),
});

/**
 * Reviewed release data, not a live entitlement or availability assertion.
 * The host remains authoritative for whether a requested model can launch.
 *
 * Astra's literal effort strings were observed through signed-in model/list on
 * 0.153.4, 0.154.0, and Desktop's 0.154.0-alpha.6.1 on 2026-09-11. This is Codex
 * capability evidence, not an assertion about the API's reasoning parameters.
 */
export const INTELLIGENCE_PROFILE_CATALOG = Object.freeze({
  schemaVersion: 1,
  catalogVersion: "openai-2026-09-11",
  reviewedAt: "2026-09-11",
  sourceUrl: "https://learn.chatgpt.com/docs/models",
  evidence: Object.freeze({
    kind: "verified-openai-docs",
    summary:
      "OpenAI Codex guidance recommends GPT-6 Astra; the catalog also retains the reviewed GPT-5.6 Sol, Terra, and Luna profiles. Explicit Astra selection does not change existing task-shape defaults.",
  }),
  hostCapabilityEvidence: Object.freeze({
    kind: "current-codex-desktop-capability",
    observedAt: "2026-09-11",
    summary:
      "The current Desktop durable-task and joined-subagent tools expose Astra, Sol, Terra, and Luna. Signed-in App Server model/list advertises Astra with low, medium, high, xhigh, max, and ultra on all three inspected binaries. Nelos retains its narrower joined-model policy pending separate routing evaluation.",
  }),
  policy: Object.freeze({
    kind: "local-reviewed-policy",
    version: 4,
    summary:
      "Nelos permits explicit Astra on durable tasks and joined subagents, preserves existing task-shape defaults, keeps Luna on durable tasks, and requires explicit native-fan-out permission for Ultra.",
  }),
  profiles,
});

export function getIntelligenceProfile(profileId) {
  const profile = profiles[profileId];
  if (!profile) throw new Error(`unsupported intelligence profile: ${profileId}`);
  return profile;
}

export function findIntelligenceProfileByModel(requestedModel) {
  const profile = Object.values(profiles).find(
    (candidate) => candidate.requestedModel === requestedModel,
  );
  if (!profile) throw new Error(`unsupported intelligence model: ${requestedModel}`);
  return profile;
}
