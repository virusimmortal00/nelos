# Skill discovery and scope

The UI name is **Coordinate Work with Nelos**. The stable identifier, directory,
and explicit invocation remain `manage-nelos-tasks` / `$manage-nelos-tasks`.
Changing a display label does not require users to rewrite existing prompts.
Implicit invocation remains enabled by default; no explicit-only policy is set.

The skill helps coordinate independent coding work, order dependencies, verify
joined results, and inspect or resume existing Nelos task webs. It is not a
general task manager for isolated edits, explanations, travel plans, single-task
renaming, or reviews that need only a review tool. Discovery does not authorize
extra workers or external changes beyond the user's request.

## Why these changes

Before loading a skill, a host can expose its name and description without its
body. The previous description emphasized internal mechanics: "dependency-safe
waves", "durable Codex tasks", and "machine-generated next actions". It did not
explicitly cover existing-web status or recovery. The new metadata leads with
the outcome and scope; the opening instructions distinguish execution, resume,
and read-only inspection before presenting the detailed protocol.

This is a clarity improvement, not a diagnosis of every missed invocation.
Host discovery, stale installations, available tools, competing metadata, and
model behavior can also matter. When investigating a miss, first confirm the
actual loaded skill path/version in a fresh task; do not assume source edits
changed an already-running worker or task's skill inventory.

The protocol stays in `SKILL.md`: the skill-only installer copies that file,
not a supporting reference tree. Its identity, authorization, verification,
restart, and stop gates remain in force. Source/plugin packaging must not be
confused with the smaller skill-only installation surface.

## Bounded selection exercise — 2026-09-02

Two fresh independent evaluators received the same twelve requests below and
only selection metadata, not the intended answers, each other's results, or an
explanation of the proposed fix. The first read the metadata from accepted
public commit `d777e6dd702f97a6fcc82f5397fc035aa5205f21`; the second read the
revised metadata. Both also received the installed `code-review` and
`skill-creator` descriptions as competing choices. No tools were executed for
the scenario requests. Evaluators inherited the current agent configuration;
this was not a cross-model or cross-host experiment.

| Request | Baseline selection | Revised selection |
| --- | --- | --- |
| Implement team invitations across the API, web UI, email delivery, and tests. Split independent work and bring the results together. | Nelos | Nelos |
| Coordinate three agents to fix the parser, update its docs, and verify the migration without conflicting edits. | Nelos | Nelos |
| Continue the Nelos task web after restart; inspect completed workers before launching dependent work. | Nelos | Nelos |
| Add a missing semicolon in src/index.js. | None | None |
| Explain what this regular expression matches. | None | None |
| Review this pull request for security problems. | Code review | Code review |
| Use $manage-nelos-tasks to plan this feature. | Nelos | Nelos |
| Create a skill for formatting monthly invoices. | Skill creator | Skill creator |
| Plan a weekend in Boston. | None | None |
| Ship the feature: the storage migration must land before API work, and UI and documentation can proceed together after that. | Nelos | Nelos |
| Show whether my Nelos workers are done; do not change anything. | None | Nelos |
| Rename my Codex task to Update Docs. | None | None |

The sole changed selection was the status-only request. All selected skills
were to be read before action. This supports the narrower status-discovery
correction; it does not establish a general increase in automatic invocation.
The corpus is small, authored, and sampled once per variant. Repeat in actual
supported hosts with fresh tasks and broader prompts before claiming rates.

A separate evaluator read the full revised instructions and assessed five
mock scenarios without executing tools. It reported status without accepting
results; preserved accepted/running slices on resume; stopped on unhealthy
runtime rather than live-upgrading; stopped on `execution-unavailable`; and
selected planner bootstrap rather than inventing a user-supplied plan. Missing
identities or receipts were treated as missing evidence, not fabricated.
This tabletop check does not replace live protocol tests or GUI evidence.

## Maintaining the contract

Keep the stable invocation, default implicit policy, self-contained installer
payload, and UI metadata coherent. Structural tests check those properties;
they do not prove good model selection. Reuse the requests above for blind
comparisons, include negative cases, and report unchanged or worse outcomes
as well as improvements. Do not broaden triggers merely to maximize usage.
