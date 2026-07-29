export const PROTOCOL_MIGRATION_MAP_V1 = Object.freeze([
  {
    skillClause: "Choose the Planning Path",
    enforcingContract: "semanticInput:genuine-user-supplied-plan-recognition",
    compatibilityAdapter: "planning-lifecycle.mjs",
  },
  {
    skillClause: "launch-planner / verify-route",
    enforcingContract: "action:launch-planner + receipt:native-planner-created",
    compatibilityAdapter: "planning-lifecycle.mjs",
  },
  {
    skillClause: "launch-wave",
    enforcingContract:
      "actions:authorization-required,execution-unavailable,launch-wave + effect:native-authorize-launch + receipt:native-launch-authorization + effect:native-create",
    compatibilityAdapter:
      "launch-execution-gate.mjs + next-action.mjs + mcp-server.mjs + mcp-orchestration.mjs",
  },
  {
    skillClause: "native-wait-wave / native-wait / native-read",
    enforcingContract: "actions:native-wait-wave,native-wait,native-read",
    compatibilityAdapter: "next-action.mjs + mcp-observation.mjs",
  },
  {
    skillClause: "native-set-title",
    enforcingContract: "action:native-set-title + receipt:native-title-observed",
    compatibilityAdapter: "orchestration-observation.mjs",
  },
  {
    skillClause: "decide",
    enforcingContract: "action:decide + semanticInput:result-acceptance-judgment",
    compatibilityAdapter: "mcp-queen-decision.mjs",
  },
  {
    skillClause: "cleanup-spinoffs",
    enforcingContract: "action:cleanup-spinoffs + semanticInput:cleanup-consent-or-preference",
    compatibilityAdapter: "spinoff-lifecycle.mjs",
  },
  {
    skillClause: "attention",
    enforcingContract: "attention + error + recovery-command registry",
    compatibilityAdapter: "all lifecycle adapters",
  },
  {
    skillClause: "complete",
    enforcingContract: "action:complete",
    compatibilityAdapter: "next-action.mjs + mcp-observation.mjs",
  },
  {
    skillClause: "spinoff exact completion wake",
    enforcingContract: "effect:native-send-message + threadId-only host receipt + effect:native-reconcile-send-message",
    compatibilityAdapter: "spinoff-lifecycle.mjs",
  },
  {
    skillClause: "queen selects coordinated work and communicates with user",
    enforcingContract: "semanticInput:coordinated-work-selection,user-facing-communication",
    compatibilityAdapter: "manage-nelos-tasks/SKILL.md",
  },
].map((entry) => Object.freeze(entry)));
