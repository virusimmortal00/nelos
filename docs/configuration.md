# Configuration

Nelos configuration belongs to the installed plugin's MCP server. Users do not
need to install the separate contributor CLI, learn a slash command, or restart
the MCP process after an edit.

## Configure conversationally

In a Codex task, ask for the setting you want:

```text
Show my Nelos settings.
Set Nelos spin-off cleanup to ask.
Reset my Nelos spin-off cleanup preference.
```

The bundled MCP tool metadata and schemas route these requests directly to
`nelos_config_get`, `nelos_config_set`, and `nelos_config_reset`; the
task-management skill is not required. The get response includes the effective
value, whether it came from TOML or the built-in default, the exact file path in
use, and any one-time migration it performed. Set and reset are valid only when
the user explicitly asks to change the global preference; an agent must not
infer that intent from a one-off cleanup decision.

Codex does not currently provide Nelos with a custom Settings pane. The
conversation is therefore the primary UI, with the TOML file as the transparent
manual-editing surface. No Nelos-specific slash command is required. A custom
MCP settings form is deliberately deferred until Nelos has enough settings to
justify another UI.

## File location

Nelos resolves one user-global file in this order:

1. `NELOS_CONFIG`, when set to a non-empty absolute path;
2. `$XDG_CONFIG_HOME/nelos/config.toml`; or
3. `~/.config/nelos/config.toml`.

This follows the platform configuration convention and keeps user preferences
separate from project source. `XDG_CONFIG_HOME`, when set, must also be
absolute. A repository-local `.nelos/` directory is not consulted, so opening
an untrusted repository cannot silently change a user's cleanup preference.

## Schema

The current schema is deliberately small and strict:

```toml
schema_version = 1

[spinoffs]
cleanup_policy = "auto"
```

`spinoffs.cleanup_policy` accepts:

- `auto` — archive eligible spin-offs after their current results are accepted;
- `ask` — show the exact eligible task names and IDs before archiving; or
- `keep` — preserve eligible spin-offs.

The built-in default is `auto`. On the first configuration read, an exact valid
legacy remembered preference is migrated into TOML under the same
cross-process lock used by writers, then the legacy file is removed. Invalid or
unsafe legacy state fails closed. After that one-time migration, effective
precedence is:

```text
TOML override → built-in auto
```

Reset removes the TOML override and any legacy preference, so reset genuinely
means the built-in `auto` default rather than revealing older hidden state.

The MCP server parses the file with a pinned, standards-compliant TOML parser
on every configuration lookup, so valid manual edits take effect without a
restart. MCP writes preserve ordinary comments and use private atomic file
replacement plus a machine-local interprocess lock. Malformed files, unknown
keys, unsafe file types, and oversized files fail closed with a focused error
instead of silently changing behavior.

Cleanup snapshots the effective policy for the whole web when terminal cleanup
first begins. A later global configuration edit affects future webs, not an
archive or confirmation sequence already underway. Remembering a one-off
cleanup choice globally also requires an explicit user request.

## CLI boundary

The `nelos` CLI in the source distribution remains a contributor and automation
surface. Marketplace installation does not put it on `PATH`, and plugin agents
must never invoke or install it as a fallback for configuration. Installed-user
configuration is fully covered by the bundled MCP tools above.
