# Claude Code handoff

`nelos handoff-claude` hands a task from a Codex context to the Claude Code
desktop app. The handed-off session appears in the Claude Code app's session
list with the full handoff prompt waiting as its first message; the user
continues it there with their own Claude authentication.

```bash
nelos handoff-claude \
  --title "Migrate the flaky test harness" \
  --prompt-file handoff-context.md \
  --cwd /absolute/path/to/repo
```

## How it works

Claude Code's desktop app and its CLI keep separate session stores, and the
app does not automatically track CLI-created sessions. The app does, however,
register the `claude://` URL scheme and imports a specific CLI session when it
receives `claude://resume?session=<uuid>` — the same importer behind the app's
manual **Import Claude Code CLI sessions** action.

The handoff therefore has two steps:

1. **Seed.** Write a session transcript in the Claude Code CLI's own on-disk
   format (`<claude-config>/projects/<encoded-cwd>/<session-id>.jsonl`)
   containing the composed handoff prompt as its first user message plus a
   `custom-title` record. No model turn runs on the Codex side, no Claude
   authentication is needed, and an existing transcript for the session ID is
   never overwritten.
2. **Open.** Fire the `claude://resume?session=<uuid>` deep link through the
   platform opener (`open` on macOS, `xdg-open` on Linux). The Claude Code app
   imports the session live — no app restart — and shows it.

Each handoff is recorded in the local registry under
`$XDG_STATE_HOME/nelos/claude-handoffs/` with the session ID, title,
workspace, source task, and resume URL.

## Prompt identity

The app's single-session importer does not read transcript titles (its bulk
importer does), so a freshly imported session may display as an untitled
"general" session until its first in-app turn completes. The composed prompt
therefore leads with the task identity so both the reader and the app's
auto-titling see it immediately:

```text
Nelos handoff — <title>
Source: Codex task <thread-id> (codex://threads/<thread-id>)

<prompt body>
```

`--thread-id` (or `CODEX_THREAD_ID`) supplies the source line; without it the
line is omitted.

## Options

| Option | Meaning |
| --- | --- |
| `--title` | Required single-line task identity; leads the composed prompt |
| `--prompt` / `--prompt-file` | Required handoff body; `--prompt-file -` reads standard input |
| `--cwd` | Workspace the Claude session opens in (default: current directory) |
| `--thread-id` | Source Codex task cited in the prompt (default: `CODEX_THREAD_ID`) |
| `--session-id` | Explicit Claude session UUID (default: generated) |
| `--claude-config-dir` | Claude config directory (default: `CLAUDE_CONFIG_DIR` or `~/.claude`) |
| `--no-open` | Seed only; do not fire the deep link |

## Failure modes and fallbacks

- **The deep link does not open** (Claude Code app not installed, or its
  "Disable claude:// deep-link handling" setting is on). The command still
  succeeds with `"opened": false`, an `openError`, and an `openHint`; the
  session is fully seeded. Opening the printed `taskUrl` later, or using the
  app's manual **Import Claude Code CLI sessions** action, completes the
  handoff.
- **The session ID already has a transcript.** The command fails without
  touching the existing conversation. Omit `--session-id` to generate a fresh
  one.
- **Windows.** The deep link opener supports macOS and Linux, matching the
  distribution's supported platforms; use `--no-open` elsewhere.

The transcript format and the `claude://resume` deep link are Claude Code
implementation surfaces observed against Claude desktop 1.24012.1 with
Claude Code CLI 2.1.217; they are not a documented public contract. The seed
records are the minimal shape the importer requires, and a format change in a
future Claude release would surface as an import failure toast in the app, not
as data loss: the seeded transcript is inert until imported.

## Handing results back

The return direction needs no new machinery: the Claude Code session works in
the same repository and can run this CLI, so its closing step can be
`nelos send <thread-id> --prompt-file result.md` to deliver its outcome to
the originating Codex task.
