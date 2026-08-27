# Desktop GUI scenario driver

`DesktopGuiScenarioDriver` executes predefined UI scenarios through an accessibility-only boundary. The public `nelos/desktop-smoke-contract` allowlists six action types: click, keypress, scroll, menu selection, sealed text entry, and waiting for an opaque condition. It exposes no shell, script, DOM, IPC, or evaluation operation.

Text inputs are referenced by sealed-value IDs. The driver borrows their bytes only for the accessibility call, zeroes them afterward, and supports terminal absence cleanup. Scenario results contain stable action/checkpoint/assertion receipts, not prompt content.

Screenshots require a complete exclusion inventory for the conversation and every visible credential region. The boundary captures only after that geometry validates. The public result retains a digest, byte length, media type, scenario ID, and `sanitized: true`; it does not retain raw pixels.

The included Linux AT-SPI boundary is suitable for a disposable Desktop guest. Provider-specific VM creation, application installation, and teardown belong to the fixed machine-local smoke driver described in [Disposable Desktop smoke lane](disposable-desktop-smoke.md).

For direct guest-side debugging, use:

```sh
nelos-desktop-gui-driver \
  --scenario /private/scenarios/release.json \
  --bindings /private/scenarios/bindings.json \
  --sealed-root /private/sealed-values
```

Those inputs must be created inside the disposable guest. Do not place sealed values or screenshots in the repository or controller plugin cache.
