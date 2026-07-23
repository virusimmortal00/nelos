# Skill discovery metadata and custom-agent samples

`openai.yaml` in this directory is optional skill UI metadata: a display
name, short description, default prompt, and brand color for hosts that
support richer skill-picker discovery. It has no effect on hosts that don't
read it, and it does not change implicit skill invocation — the
`manage-nelos-tasks` skill still matches on its `SKILL.md` frontmatter
`description` exactly as before.

`samples/` holds documented, opt-in custom-agent files. Nothing here is
installed automatically. To use one, copy it to `~/.codex/agents/` (personal)
or `.codex/agents/` (project-scoped) and rename it if it collides with an
existing agent:

- `samples/web-queen.toml` — a web queen that coordinates a durable
  Nelos web. It inherits the parent session's live model, approval,
  and sandbox settings unchanged; the agent name alone grants no elevated
  write authority over an app server.
- `samples/reviewer-explorer.toml` — a read-only reviewer/explorer that
  narrows its sandbox to `read-only`, a restriction rather than an
  escalation, while still inheriting the parent's live model and approval
  policy.

Both samples assume the `manage-nelos-tasks` skill is installed; see
`../SKILL.md` for the lifecycle and result-envelope contract they follow.
