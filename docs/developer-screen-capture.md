# Developer screen capture

`nelos-capture-screen` takes one local-only PNG of either an explicitly numbered
macOS display or one exact application window for development diagnostics. It
does not schedule captures, upload files, or select an output path supplied by
screen content.

```sh
nelos-capture-screen \
  --out-dir /absolute/path/to/local-evidence \
  --display 1 \
  --label codex-state
```

Prefer a window capture when the evidence should contain only Codex. The helper
enumerates windows through a fixed CoreGraphics helper, requires the exact app
bundle identifier, and refuses an ambiguous match. Resolve the window ID from
the read-only catalog, then bind the capture to it:

```sh
/usr/bin/swift src/macos-window-catalog.swift \
  --bundle-id com.openai.codex

nelos-capture-screen \
  --out-dir /absolute/path/to/local-evidence \
  --app-bundle-id com.openai.codex \
  --window-id 4431 \
  --label codex-state
```

`--window-title` may additionally bind the exact catalog title. A bundle-only
request succeeds only when exactly one capturable layer-zero window exists; it
never guesses among multiple windows. Window metadata retains only the bundle,
window/process identifiers, bounds, on-screen state, owner name, and a SHA-256
digest of the title—not the title itself.

The helper uses the fixed system executable `/usr/sbin/screencapture` with
non-interactive flags. It creates a mode-`0600` PNG and adjacent JSON metadata
containing the bounded source identity, byte count, SHA-256 digest, capture
timestamp, and generated filename. The default byte ceiling is 25 MiB and can
only be lowered or raised explicitly with `--max-bytes`. Output directories
must be absolute, cannot be a filesystem root, and cannot themselves be
symlinks.

On macOS, grant Screen & System Audio Recording access to the application or
helper process that launches the command. Computer Use permissions and shell
screen-capture permissions can be separate. A blank image or permission error
should be treated as a failed capture; do not weaken macOS privacy controls.

Full-display and window images can contain notifications, credentials,
conversation text, or unrelated task names. The development helper deliberately
does not claim redaction: `--protected-regions` fails closed. Keep captures in a
dedicated local evidence directory, review them before sharing, and remove them
using the normal evidence-retention procedure. Use the remote Desktop evidence
lane for full-frame-black, allowlist-only task screenshots. The helper never
uploads or transmits the image.

For multi-display systems, `--display 1` means the first macOS display, not
necessarily the display containing the pointer. Choose the display number
explicitly for repeatable validation.

## Compare visible task state with runtime state

After reviewing a capture, record the visible task rows in a closed JSON input
and compare them with the native Codex app-process thread inventory and the
Nelos web inspection returned at the same checkpoint:

```sh
nelos-validate-visual-state \
  --input /absolute/path/to/observations.json \
  --out /absolute/path/to/visual-state-report.json
```

The input has exactly these top-level fields:

```json
{
  "schemaVersion": 1,
  "capture": {
    "imagePath": "/absolute/path/capture.png",
    "metadataPath": "/absolute/path/capture.json"
  },
  "visualSurfaces": [
    {
      "surface": "sidebar",
      "entries": [
        {
          "threadId": "01a01ae1-1dd0-77f1-8cda-e4285c58dd4c",
          "observedName": "Build Proxmox Desktop backe…",
          "nameResolution": "truncated",
          "observedStatus": "active"
        }
      ]
    }
  ],
  "nativeThreads": [
    {
      "threadId": "01a01ae1-1dd0-77f1-8cda-e4285c58dd4c",
      "title": "Build Proxmox Desktop backend",
      "status": "idle"
    }
  ],
  "nelosThreads": [
    {
      "threadId": "01a01ae1-1dd0-77f1-8cda-e4285c58dd4c",
      "title": "Build Proxmox Desktop backend",
      "status": "notLoaded"
    }
  ]
}
```

Supported surfaces are `sidebar`, `createdTasks`, `mcpVisual`, and `taskBody`.
Names must be classified as `exact`, `truncated`, or `generic`; the validator
never guesses the identity of a generic “Created task” row. It verifies the PNG
against its capture metadata before comparison, rejects unknown fields and
duplicates, and compares visual lifecycle only with the native Codex app process
that owns that UI. A separately spawned Nelos/app-server worker can correctly
report `notLoaded` for the same task while the app process reports `active`; its
status is treated as a process-local load-state diagnostic, not a lifecycle
vote. Exact title disagreements and any native or Nelos `systemError` still
fail. The command exits `1` when the comparison finds a defect (`2` means
invalid evidence). Reports are local-only and created without overwriting an
existing output file.
