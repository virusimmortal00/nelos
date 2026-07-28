import {
  INTELLIGENCE_PROFILE_CATALOG,
  findIntelligenceProfileByModel,
  getIntelligenceProfile,
} from "./intelligence-profile-catalog.mjs";

const ROUTES = Object.freeze({
  "complex/open-ended": Object.freeze({
    profileId: "sol",
    effort: "medium",
    rationale: "Complex or open-ended work benefits from Sol with medium reasoning as the lowest reviewed starting point for sustained judgment.",
  }),
  everyday: Object.freeze({
    profileId: "terra",
    effort: "low",
    rationale: "Everyday work is routed to Terra with low reasoning for a capable, efficient default.",
  }),
  "clear/repeatable": Object.freeze({
    profileId: "luna",
    effort: "low",
    rationale: "Clear, repeatable work is routed to Luna with low reasoning because the task and acceptance criteria are explicit.",
  }),
});

const JOINED_SUBAGENT_ROUTE = Object.freeze({
  profileId: "terra",
  effort: "low",
  rationale:
    "Clear, repeatable joined-subagent work uses Terra with low reasoning because the current native collaboration launcher supports Sol and Terra, not Luna.",
});

const INDEPENDENT_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const LAUNCH_SURFACES = new Set(["durable-task", "joined-subagent"]);

function assertPlainInput(input) {
  if (input === undefined || input === null) return;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("intelligence route input must be an object");
  }
}

/**
 * Returns null when routing is omitted so callers preserve host model and effort
 * defaults. Otherwise returns private launch metadata; callers must not copy it
 * into public task, work-result, or orchestration contracts.
 */
export function routeIntelligenceProfile(input) {
  assertPlainInput(input);
  if (input === undefined || input === null || Object.keys(input).length === 0) return null;
  if (!LAUNCH_SURFACES.has(input.launchSurface)) {
    throw new Error(`unsupported intelligence launch surface: ${input.launchSurface}`);
  }

  const baseRecommendation =
    input.taskShape === undefined ? null : ROUTES[input.taskShape];
  const recommendation =
    input.launchSurface === "joined-subagent" &&
    baseRecommendation?.profileId === "luna"
      ? JOINED_SUBAGENT_ROUTE
      : baseRecommendation;
  if (input.taskShape !== undefined && !recommendation) {
    throw new Error(`unsupported intelligence task shape: ${input.taskShape}`);
  }

  const recommendedProfile = recommendation
    ? getIntelligenceProfile(recommendation.profileId)
    : null;
  const profileOverride =
    input.profileOverride === undefined
      ? null
      : getIntelligenceProfile(input.profileOverride);
  const modelOverride =
    input.modelOverride === undefined
      ? null
      : findIntelligenceProfileByModel(input.modelOverride);
  if (profileOverride && modelOverride && profileOverride.id !== modelOverride.id) {
    throw new Error("explicit intelligence profile and model overrides conflict");
  }
  const selectedProfile = profileOverride ?? modelOverride ?? recommendedProfile;
  const requestedModel = selectedProfile?.requestedModel ?? null;
  const requestedEffort = input.effortOverride ?? recommendation?.effort ?? null;
  if (
    input.launchSurface === "joined-subagent" &&
    requestedModel === "gpt-5.6-luna"
  ) {
    throw new Error(
      "joined-subagent launches do not support gpt-5.6-luna; use Sol or Terra",
    );
  }

  if (
    requestedEffort !== null &&
    selectedProfile &&
    !selectedProfile.supportedEfforts.includes(requestedEffort)
  ) {
    throw new Error(
      `unsupported reasoning effort for ${selectedProfile.id}: ${requestedEffort}`,
    );
  }
  if (
    requestedEffort !== null &&
    !selectedProfile &&
    requestedEffort !== "ultra" &&
    !INDEPENDENT_EFFORTS.includes(requestedEffort)
  ) {
    throw new Error(`unsupported independent reasoning effort: ${requestedEffort}`);
  }
  if (requestedEffort === "ultra") {
    if (!selectedProfile || !["sol", "terra"].includes(selectedProfile.id)) {
      throw new Error("Ultra requires an explicit or recommended Sol or Terra profile");
    }
    if (input.nativeFanoutAllowed !== true) {
      throw new Error("Ultra requires explicit native-fan-out permission");
    }
  }

  const modelSelection =
    profileOverride || modelOverride ? "override" : recommendedProfile ? "recommended" : "inherit";
  const effortSelection =
    input.effortOverride !== undefined
      ? "override"
      : recommendation
        ? "recommended"
        : "inherit";
  const nativeTask = {};
  const standaloneTask = {};
  if (requestedModel !== null) {
    nativeTask.model = requestedModel;
    standaloneTask.model = requestedModel;
  }
  if (requestedEffort !== null) {
    nativeTask.thinking = requestedEffort;
    standaloneTask.effort = requestedEffort;
  }

  let rationale;
  if (recommendation) {
    const overridden = modelSelection === "override" || effortSelection === "override";
    rationale = overridden
      ? `Explicit validated model or reasoning choices take precedence over the ${recommendedProfile.label} recommendation; any unselected dimension uses that recommendation.`
      : recommendation.rationale;
  } else if (modelSelection === "override" && effortSelection === "override") {
    rationale = "Explicit validated model and reasoning choices are ready for task launch.";
  } else if (modelSelection === "override") {
    rationale = "The explicit validated model is ready for task launch while reasoning inherits the host default.";
  } else if (effortSelection === "override") {
    rationale = "The explicit validated reasoning choice is ready for task launch while the model inherits the host default.";
  } else {
    throw new Error("intelligence routing requires a task shape, model, profile, or effort");
  }

  return Object.freeze({
    schemaVersion: 2,
    policyVersion: INTELLIGENCE_PROFILE_CATALOG.policy.version,
    catalogVersion: INTELLIGENCE_PROFILE_CATALOG.catalogVersion,
    taskShape: input.taskShape ?? null,
    profile: selectedProfile?.id ?? null,
    requestedModel,
    requestedEffort,
    modelSelection,
    effortSelection,
    launch: Object.freeze({
      nativeTask: Object.freeze(nativeTask),
      standaloneTask: Object.freeze(standaloneTask),
    }),
    rationale,
    nativeFanoutAllowed: input.nativeFanoutAllowed === true,
  });
}

export const INTELLIGENCE_TASK_SHAPES = Object.freeze(Object.keys(ROUTES));
