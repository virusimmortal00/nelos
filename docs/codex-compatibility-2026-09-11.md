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
global CLI were not replaced. The latest Desktop UI and remote execution were
not exercised, so this is not Desktop integration or remote-launch certification.
The initial `m3` SSH connection timed out; a retry at 16:23 UTC succeeded. Production-feed availability may differ from an account's staged update offer.

## Remote host retry

Read-only SSH checks on `m3` at 2026-09-11 16:23 UTC found:

| Component | Installed on m3 |
| --- | --- |
| Platform | Darwin 25.5.0, arm64 |
| Desktop | 26.715.72359, build 5718 |
| Desktop-bundled CLI | 0.145.0-alpha.30 |
| Standalone CLI | 0.146.0 in `/Users/bobby.sayers/.local/bin/codex` |

The noninteractive SSH PATH does not expose `codex`; absolute paths were used
to verify both installations. Both CLI versions are outside the owned executor
allowlist and older than the 0.152.0 discovery baseline. Connectivity and
installed versions are now verified; remote Astra discovery and execution
remain untested. No remote installation was changed.

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

## Continuation and validation

- `d8784ab`: explicit Astra support, exact reviewed CLI identities, reproducible
  schema snapshots, and live read-only session probes.
- `6b0e722`: bounded journal inventory and a startup admission barrier. Proven
  non-dispatch can be released; saved terminal results are checked against their
  bindings; unfinished operations retain holds and block new waves.
- `bf3aaea`: preserve the specific missing-startup-record error; repair registry
  mappings and the required offline harness. It now uses the normal canonical
  temp setup and permits only Unix sockets listened to by the same test process.
  TCP, foreign Unix sockets, DNS, HTTP, TLS, HTTP/2 and datagrams remain blocked.

The final code passed **1,148 tests, 0 failures**, syntax checks, and
`git diff --check`, using Node 26.7.0, npm 10.9.4 and lockfile dependencies.
`COMPATIBILITY_BASE_REF=a564c04 npm run compatibility:required` exited 0 for the
committed code. All selected deterministic checks passed; the report's overall
status remains **unverified** because runtime certification is a separate lane.

CodeRabbit reviewed the compatibility/startup change and raised **1 minor
issue**, now fixed with a regression test: a missing startup record must retain
its specific error and cannot release its work hold. A follow-up review was
blocked by **“Rate limit exceeded”**. CodeRabbit reported a 31-minute retry wait;
alternatively its provider account needs an assigned review seat. No successful
follow-up review is claimed for the final harness changes.

The installed CLI also exposes managed daemon bootstrap/start and a stdio proxy
to its control socket. The read-only `app-server daemon version` check found no
managed daemon socket in the default Codex home. Before implementing service
deployment, evaluate that upstream facility against Nelos's ownership and
approval-lifetime requirements; it does not itself establish scoped grants or
safe adoption of an old turn. No daemon was bootstrapped or restarted here.

This continuation does not close #125 or enable the owned backend in production.
Private service wiring, active ownership reattachment, parent acceptance/join,
and real remote canaries remain required. The successful `m3` retry establishes its installed versions, but those
versions are outside the reviewed owned-executor profile. Remote runtime
validation remains required.
