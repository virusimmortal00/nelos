// Deliberately includes unrelated account and model metadata. Probe output must
// project only the exact route checks and never return these private fields.
export const probeSelection = Object.freeze({
  cwd: "/workspace/project",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  permissionProfile: "workspace",
  approvalPolicy: "on-request",
});

export function executionProbeResponses() {
  return {
    "account/read": { requiresOpenaiAuth: true, account: {
      type: "chatgpt", email: "private-account@example.invalid", planType: "pro",
    } },
    "model/list": { data: [{
      id: "picker-id", model: probeSelection.model, displayName: "Private display name",
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Private description" }],
      defaultReasoningEffort: "high", hidden: false, isDefault: true, description: "Private model",
    }], nextCursor: null },
    "permissionProfile/list": { data: [{
      id: "workspace", allowed: true, description: "Private filesystem configuration",
    }], nextCursor: null },
    "configRequirements/read": { requirements: {
      allowedApprovalPolicies: ["untrusted", "on-request"],
      additionalDeveloperInstructions: "Private managed instructions",
    } },
  };
}
