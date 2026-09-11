# Codex compatibility check — 2026-09-11

## Installed and available versions

| Component | Installed | Latest available | What was tested here |
| --- | --- | --- | --- |
| Desktop (production, Apple silicon) | 26.903.71938, build 8576 | 26.908.31748, build 8720 | Installed bundle metadata; signed latest archive and its bundled CLI |
| Desktop-bundled CLI | 0.153.4 | 0.154.0-alpha.6.1 in the latest Desktop | Generated schemas and signed-in read-only App Server discovery for both |
| Public standalone CLI | No separate executable found on PATH | 0.154.0 | Isolated official release binary, generated schema, signed-in read-only discovery |

`codex` on PATH resolves to `/Applications/ChatGPT.app/Contents/Resources/codex`.
Despite the app filename, its bundle identifier is `com.openai.codex`. Desktop
version, Desktop build number, Chromium version, and CLI version are separate.
The latest Desktop includes a prerelease CLI; treating its version as public
0.154.0 would lose relevant evidence.

Latest Desktop metadata came from the production [appcast](https://persistent.oaistatic.com/codex-app-prod/appcast.xml)
declared in the installed app's package metadata. Build 8720 was published at
2026-09-11 03:33:04 UTC. The downloaded archive's Ed25519 signature was verified
against the installed Sparkle public key before extracting its CLI. Public CLI
metadata came from the official release API and npm `@openai/codex/latest`, both
reporting 0.154.0; its downloaded asset matched the release's SHA-256 digest.
See [machine-readable observations](codex-compatibility-2026-09-11.json).

The newer binaries were staged in temporary directories. The installed app and
global CLI were not replaced. The latest Desktop UI and remote `m3` host were
not exercised, so this is not Desktop integration or remote-launch certification.
A read-only SSH version check against `m3` timed out connecting to port 22;
its installed version remains unverified. Production-feed availability may differ from an account's staged update offer.

## Astra and protocol evidence

[Official Codex model guidance](https://learn.chatgpt.com/docs/models) recommends
`gpt-6-astra`. All three inspected binaries advertised that exact model through
signed-in `model/list`, with `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.
Account discovery used `refreshToken: false`; reports omit account identifiers
and tokens. Permission-profile and managed-policy reads also succeeded.

Nelos now accepts explicit `astra` / `gpt-6-astra` routing on durable and joined
launches. Ultra still requires explicit native-fan-out permission. Existing
task-shape defaults remain Sol/medium, Terra/low, and Luna/low (Terra/low for
joined repeatable work). The current host also exposes Luna for joined work;
Nelos's narrower joined policy remains deliberate pending routing evaluation.
Codex effort observations must not be substituted for the API's effort schema.

The owned session now accepts the exact reviewed CLI identities 0.152.0,
0.153.4, 0.154.0, and 0.154.0-alpha.6.1. Unlisted versions, suffixes, malformed
identities, and wrong Codex homes still fail closed. These identities permit
internal transport use; they do not confer an execution grant or runtime
certification. Read-only discovery retains provisional checks for newer
versions and reports the exact reviewed schema when one exists.

The generated request shapes used by initialization, discovery, thread creation,
title, reads, turn start, and interrupt are semantically identical across the
three inspected binaries. Fixtures retain complete request-schema reference
closures and source hashes for responses, notifications, and server requests.
Production request payloads are checked against each generated schema, including
an additional guard against silently ignored misspelled parameters.

Between installed 0.153.4 and public 0.154.0, response changes add thread
environment/origin metadata and application/browser requirements. Existing
consumed fields retain their types. Server requests add an elicitation challenge
variant and absolute-path types; the relay supports only its reviewed form/URL
and approval decisions and cannot accept an unsupported challenge. Public CLI
and latest Desktop schemas have the same consumed structures.

No model turns or mutations were used in the live compatibility probes.
Thread/turn mutation traffic remains fixture-tested. App Server is described as
experimental in the [official documentation](https://learn.chatgpt.com/docs/app-server).
Keep production execution gated until the remaining owned-service and remote
canary requirements are met.

## Reproduce

```sh
<absolute-codex> app-server generate-json-schema --experimental --out <schema-directory>
node scripts/capture-owned-execution-schema.mjs <schema-directory> <version> <fixture.json>
node scripts/probe-owned-execution.mjs <absolute-codex> <absolute-cwd> <absolute-codex-home> gpt-6-astra medium
```

The probe reuses the executor's session and requests only account, model,
permission-profile, and managed-policy discovery. It never creates a thread,
starts a turn, changes the selected model, or issues an execution grant.
