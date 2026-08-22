# Remote Desktop validation contract v1

This module defines the machine boundary for remote, black-box Codex Desktop validation. It does not authorize provider operations or expose Desktop internals. A controller must validate the run before provisioning or driving a VM, account for usage before every bounded operation, validate the export before release, and validate the terminal receipt before reporting cleanup success.

The public versioned entry point is `nelos/remote-desktop-contract`. The JSON-Schema-compatible wire descriptions are exported as `REMOTE_DESKTOP_SCHEMAS_V1`; the validators are the normative implementation for cross-record constraints that JSON Schema cannot express.

## Run identity and admission

Every v1 run is a closed object bound to all of these identities:

- an immutable Nelos candidate `sha256` digest;
- the Desktop bundle ID, version, and digest;
- the signed golden-image ID and digest;
- provider, physical host, and owned VM IDs;
- the active lease, holder, expiry, and fencing token;
- benchmark-profile ID and digest; and
- scenario-manifest ID and digest.

`admitRemoteDesktopRun` additionally compares the candidate digest to the release candidate selected by the caller and compares every lease and provider/host/VM field with a fresh provider/control-plane lease observation. An expired, inactive, differently fenced, or differently targeted lease is rejected. Candidate names, branches, tags, paths, and mutable booleans are not identity substitutes.

Admission requires explicit ceilings for Desktop tasks, model turns, spend, wall time, screenshots (count and bytes), recording (enabled, duration, and bytes), and diagnostics (count and bytes). `reservedSpendUsd` must pessimistically cover `maxSpendUsd`. A disabled recording has explicit zero limits; an enabled recording has positive duration and byte ceilings. `validateRemoteDesktopUsage` fails closed when a ceiling is reached or exceeded, so callers must check the proposed post-operation usage before performing the operation.

## Scenarios and state machine

Each scenario owns one fresh Desktop task whose `createdForScenario` equals the scenario ID. Task IDs must be unique across the run. Raw automation commands are not accepted. The only v1 user actions are `click`, `keypress`, `scroll`, `select_menu`, `type_text_ref`, and `wait_for`; typed values are opaque benchmark input references rather than inline prompt material.

Checkpoints are limited to accessibility-tree, screenshot, and window-state observations. Assertions and failure-capture triggers are closed allowlists, and every scenario has an explicit deadline. Action, checkpoint, and task references are validated for uniqueness and referential integrity.

The only state transitions are:

```text
draft -> admitted -> running -> cleaning -> succeeded | failed | quarantined
                         |          ^
                         v          |
                 capturing_failure-+
```

An admitted run may move directly to cleaning if execution never starts. Every transition out of `cleaning` requires the exact terminal outcome contract; `succeeded` specifically requires attested destruction, while `quarantined` requires the matching quarantine receipt. Terminal states cannot transition.

## Export and evidence inventory

The export is deliberately metadata-shaped. It may contain only scenario metadata, non-secret run identities, sanitized screenshots or recordings, bounded sanitized diagnostic artifact references, an action timeline, assertion outcomes, and a cleanup attestation. Visual and diagnostic payloads are content-addressed artifacts; raw data cannot be placed inline. Count, duration, and byte totals are checked against the admitted policy.

The following evidence classes are always forbidden: prompts, model responses, tokens, cookies, session databases, environment dumps, and credential material. Closed nested objects also reject extra fields that attempt to embed any of these classes. Sanitization must happen before an artifact enters this contract boundary.

## Terminal machine outcomes

There are exactly two accepted cleanup outcomes:

1. `destroyed`: a committed, attested destruction receipt for the exact provider/host/VM, lease, and fencing token owned by the run.
2. `quarantined`: a committed, attested quarantine receipt for that same VM plus preserved reconciliation identities containing the provider/host/VM, operation, lease, and fence.

An ambiguous, pending, unknown, or identity-mismatched mutation receipt is never success. Controllers must quarantine and reconcile outside this contract if exact destruction cannot be proven.
