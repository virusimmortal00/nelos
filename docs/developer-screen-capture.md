# Developer screen capture

`nelos-capture-screen` takes one local-only PNG of an explicitly numbered macOS
display for development diagnostics. It does not schedule captures, inspect
windows, upload files, or select an output path supplied by screen content.

```sh
nelos-capture-screen \
  --out-dir /absolute/path/to/local-evidence \
  --display 1 \
  --label codex-state
```

The helper uses the fixed system executable `/usr/sbin/screencapture` with
non-interactive flags. It creates a mode-`0600` PNG and adjacent JSON metadata
containing the display number, byte count, SHA-256 digest, capture timestamp,
and generated filename. The default byte ceiling is 25 MiB and can only be
lowered or raised explicitly with `--max-bytes`. Output directories must be
absolute, cannot be a filesystem root, and cannot themselves be symlinks.

On macOS, grant Screen & System Audio Recording access to the application or
helper process that launches the command. Computer Use permissions and shell
screen-capture permissions can be separate. A blank image or permission error
should be treated as a failed capture; do not weaken macOS privacy controls.

Full-display images may contain notifications, credentials, or unrelated apps.
Keep captures in a dedicated local evidence directory, review them before
sharing, and remove them using the normal evidence-retention procedure. The
helper never uploads or transmits the image.

For multi-display systems, `--display 1` means the first macOS display, not
necessarily the display containing the pointer. Choose the display number
explicitly for repeatable validation.
