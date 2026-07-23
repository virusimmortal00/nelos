# Shell Completions for `nelos`

`completions/` ships hand-written, static completion scripts for Bash, Zsh,
and Fish, covering `nelos`'s public top-level commands, subcommands
(`title set|get`, `web begin|join|collect`, `plan slices`,
`intelligence route`), and their stable long options. They never start a
nelos process or an app server; completion is a pure, offline text
match against a fixed list.

## Install

Pick the shell you use. All paths below assume you've installed
`nelos` from this repository (see the root `README.md`); adjust the
`source`/copy path to wherever your checkout lives.

**Bash** (macOS and Linux):

```bash
echo 'source /absolute/path/to/completions/nelos.bash' >> ~/.bashrc
```

**Zsh** (macOS and Linux):

```bash
mkdir -p ~/.zsh/completions
cp completions/nelos.zsh ~/.zsh/completions/_nelos
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc
echo 'autoload -U compinit && compinit' >> ~/.zshrc
```

**Fish** (macOS and Linux):

```bash
mkdir -p ~/.config/fish/completions
cp completions/nelos.fish ~/.config/fish/completions/nelos.fish
```

Restart your shell (or `source` the updated rc file) afterward.

## Regenerating after a CLI change

The three completion files are static and hand-maintained, not generated
from `bin/nelos` at build time. Whenever `nelos`'s top-level
`supported` command array, or its `title`/`web`/`plan`/`intelligence`
subcommand lists, change:

1. Update the canonical command/subcommand lists at the top of each of
   `completions/nelos.bash`, `completions/nelos.zsh`, and
   `completions/nelos.fish`.
2. Update the matching option list for the changed command in each file.
3. Run `npm test` (or just `node --import ./scripts/test-bootstrap.mjs
   --test test/cli-completions.test.mjs`).
   `test/cli-completions.test.mjs` parses `bin/nelos`'s own
   `supported` array and its `title`/`web`/`plan`/`intelligence` subcommand
   checks as ground truth, then asserts each completion file's command and
   subcommand lists are an exact set match — so it fails on a stale name
   left behind after a rename or removal, not just on a missing addition.

This check runs offline and never needs a running app server, matching
this project's read-only, no-live-call verification style elsewhere in
`scripts/`.
