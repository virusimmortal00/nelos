# Shell Completions for `fraktik`

`completions/` ships hand-written, static completion scripts for Bash, Zsh,
and Fish, covering `fraktik`'s public top-level commands, subcommands
(`title set|get`, `web begin|join|collect`, `plan slices`,
`intelligence route`), and their stable long options. They never start a
fraktik process or an app server; completion is a pure, offline text
match against a fixed list.

## Install

Pick the shell you use. All paths below assume you've installed
`fraktik` from this repository (see the root `README.md`); adjust the
`source`/copy path to wherever your checkout lives.

**Bash** (macOS and Linux):

```bash
echo 'source /absolute/path/to/completions/fraktik.bash' >> ~/.bashrc
```

**Zsh** (macOS and Linux):

```bash
mkdir -p ~/.zsh/completions
cp completions/fraktik.zsh ~/.zsh/completions/_fraktik
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc
echo 'autoload -U compinit && compinit' >> ~/.zshrc
```

**Fish** (macOS and Linux):

```bash
mkdir -p ~/.config/fish/completions
cp completions/fraktik.fish ~/.config/fish/completions/fraktik.fish
```

Restart your shell (or `source` the updated rc file) afterward.

## Regenerating after a CLI change

The three completion files are static and hand-maintained, not generated
from `bin/fraktik` at build time. Whenever `fraktik`'s top-level
`supported` command array, or its `title`/`web`/`plan`/`intelligence`
subcommand lists, change:

1. Update the canonical command/subcommand lists at the top of each of
   `completions/fraktik.bash`, `completions/fraktik.zsh`, and
   `completions/fraktik.fish`.
2. Update the matching option list for the changed command in each file.
3. Run `npm test` (or just `node --import ./scripts/test-bootstrap.mjs
   --test test/cli-completions.test.mjs`).
   `test/cli-completions.test.mjs` parses `bin/fraktik`'s own
   `supported` array and its `title`/`web`/`plan`/`intelligence` subcommand
   checks as ground truth, then asserts each completion file's command and
   subcommand lists are an exact set match — so it fails on a stale name
   left behind after a rename or removal, not just on a missing addition.

This check runs offline and never needs a running app server, matching
this project's read-only, no-live-call verification style elsewhere in
`scripts/`.
