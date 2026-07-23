const profiles = Object.freeze({
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
 * The "xhigh" effort string is unverified against a live `model/list` response.
 * https://learn.chatgpt.com/docs/models lists an "Extra high" tier alongside
 * Low/Medium/High/Max/Ultra, but https://learn.chatgpt.com/docs/app-server's
 * own model/list documentation does not enumerate a full reasoningEffort value
 * set to confirm "xhigh" (vs. e.g. "extra_high" or "extraHigh") is the literal
 * wire string. A wrong value would surface as a loud launch-time error rather
 * than silently misbehaving, so this is flagged rather than guessed at.
 */
export const INTELLIGENCE_PROFILE_CATALOG = Object.freeze({
  schemaVersion: 1,
  catalogVersion: "openai-2026-07-21",
  reviewedAt: "2026-07-21",
  sourceUrl: "https://developers.openai.com/api/docs/guides/latest-model",
  evidence: Object.freeze({
    kind: "verified-openai-docs",
    summary:
      "Current OpenAI model guidance identifies Sol, Terra, and Luna as the frontier, balanced, and efficient GPT-5.6 choices and recommends deliberate reasoning selection.",
  }),
  hostCapabilityEvidence: Object.freeze({
    kind: "current-codex-desktop-capability",
    observedAt: "2026-07-21",
    summary:
      "The current Desktop task API exposes model and thinking overrides, including Codex-only Ultra eligibility for Sol and Terra; the host remains authoritative at launch.",
  }),
  policy: Object.freeze({
    kind: "local-reviewed-policy",
    version: 2,
    summary:
      "Nelos independently inherits, recommends, or overrides model and reasoning choices and maps them to native launch options without claiming entitlement.",
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
