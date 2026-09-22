const profiles = Object.freeze({
  sol: Object.freeze({
    id: "sol",
    label: "Sol",
    requestedModel: "gpt-6-sol",
    supportedEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  }),
  luna: Object.freeze({
    id: "luna",
    label: "Luna",
    requestedModel: "gpt-6-luna",
    supportedEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  }),
});

/**
 * Reviewed release data, not a live entitlement or availability assertion.
 * The host remains authoritative for whether a requested model can launch.
 *
 * The API model pages confirm low through max, including the literal "xhigh".
 * "ultra" is a Codex launch choice for Sol and remains host-gated.
 */
export const INTELLIGENCE_PROFILE_CATALOG = Object.freeze({
  schemaVersion: 1,
  catalogVersion: "openai-2026-09-22",
  reviewedAt: "2026-09-22",
  sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-sol.md",
  evidence: Object.freeze({
    kind: "verified-openai-docs",
    summary:
      "OpenAI's GPT-6 Sol and Luna model pages confirm their model IDs and supported reasoning efforts; the Codex launch surfaces determine availability at launch.",
  }),
  hostCapabilityEvidence: Object.freeze({
    kind: "current-codex-desktop-capability",
    observedAt: "2026-09-22",
    summary:
      "Current Codex durable-task and joined-subagent launch tools list GPT-6 Sol and Luna; the host remains authoritative for each launch.",
  }),
  policy: Object.freeze({
    kind: "local-reviewed-policy",
    version: 4,
    summary:
      "Nelos routes complex and everyday work to Sol and clear, repeatable work to Luna on either launch surface.",
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
