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

## Compare visible task state with runtime state

After reviewing a capture, record the visible task rows in a closed JSON input
and compare them with the native Codex thread inventory and the Nelos web
inspection returned at the same checkpoint:

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
duplicates, reports semantic lifecycle contradictions, and exits `1` when the
comparison finds a defect (`2` means invalid evidence). Reports are local-only
and created without overwriting an existing output file.
