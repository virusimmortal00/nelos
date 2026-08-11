# Nelos audit — performance, best practice, and documentation currency

Audited 2026-07-24 against `claude/project-audit-performance-da3615` (base `c1ed734`).
Baseline: `npm test` → **359 pass / 0 fail**, 80 s wall. `npm run check` clean.
`distribution-provenance.json` digests recompute exactly (`integrity` and
`skillIntegrity` both match the tree).

This file is working notes, not a distributed surface. It sits at the repo root
deliberately — `docs/` is inside `DISTRIBUTION_ENTRIES`
([src/distribution-provenance.mjs:49](src/distribution-provenance.mjs:49)), so a
file added there would invalidate the release integrity digest.

Severity is about impact on a user running the shipped plugin, not effort.
Every **Verified** item below was reproduced or measured on this machine; every
**Needs check** item is a claim I could not settle without touching a real Codex
install.

---

## Summary

| # | Area | Finding | Severity | Status |
|---|------|---------|----------|--------|
| 1 | MCP server | One `send()` failure permanently wedges request handling | High | Verified |
| 2 | MCP server | Message-size cap is applied to the stream buffer, not per message | High | Verified |
| 3 | Docs / Codex | `cwd` now resolves against plugin root — the inline bootstrap looks retirable | High | Verified upstream |
| 4 | Docs / Codex | "Bundled MCP servers are disabled by default" is false on the pinned version | High | Confirmed on host |
| 5 | MCP standard | Protocol pinned to `2025-06-18`; current spec revision is `2025-11-25` | Medium | Verified |
| 6 | MCP standard | `initialize` echoes any client-supplied `protocolVersion` unvalidated | Medium | Verified |
| 7 | Performance | Every state-lock acquisition spawns `ps` (6.2 ms measured) | Medium | Measured |
| 8 | Performance | `AppServerClient` re-copies its whole read buffer per socket chunk | Medium | Measured |
| 9 | Performance | `waitForTurn` polls at a flat 2 s with no backoff | Medium | Verified |
| 10 | CI | Only Node 20 is tested, and Node 20 is past EOL | Medium | Verified |
| 11 | CI | CI runs none of the verifiers `docs/development.md` calls the sequence | Medium | Verified |
| 12 | Docs | `.mcp.json` uses the undocumented bare server-map shape | Medium | Verified |
| 13 | Docs | Host observations pinned to `codex-cli 0.144.6`; `0.145.0` is current | Medium | Verified |
| 14 | Docs | `backlog.md` marks implemented, tested work as not started | Medium | Verified |
| 15 | Docs | `backlog.md` "Done" claims CI release gates that CI does not run | Medium | Verified |
| 16 | Performance | Directory scans read records serially | Low | Verified |
| 17 | Performance | Execution-store validates every record twice per write | Low | Verified |
| 18 | MCP standard | No `outputSchema` / `structuredContent` on any tool | Low | Verified |
| 19 | CI | No `concurrency` group, no `timeout-minutes`, `on: push` unfiltered | Low | Verified |
| 20 | Best practice | `npm run check` is a 45-command hand-maintained string | Low | Verified |
| 21 | Docs | Broken anchor: `installation.md` → `README.md#install-in-codex` | Low | Verified |
| 22 | Docs | The `xhigh` effort-string caveat is still unresolved in the catalog | Low | Verified |
| — | Performance | WebSocket per-byte masking — **measured, not worth changing** | — | Dismissed |

---

## Correctness and robustness

### 1. One `send()` failure permanently wedges the MCP server — High

[src/mcp-server.mjs:316](src/mcp-server.mjs:316) chains every inbound message onto a
single promise to preserve response ordering:

```js
processing = processing.then(() => handle(message));
```

There is no `.catch()`. Once `handle` rejects — most plausibly an `EPIPE` from
`output.write` when the host closes the pipe, but any throw does it — `processing`
stays rejected forever, so every later `.then(() => handle(message))` short-circuits
and **no further request is ever handled**. The process stays alive and silent; the
host waits on its own timeout. The same chain feeds `input.on("end")`
([src/mcp-server.mjs:320](src/mcp-server.mjs:320)), so `onExit(0)` never fires either.

Reproduced — first write throws, then two well-formed requests get no response at all:

```
UNHANDLED REJECTION: EPIPE
responses received after the first write failed: 0
[]
```

Fix: `processing = processing.then(() => handle(message)).catch(reportAndContinue)`,
and wrap `send` so a transport failure is logged to stderr rather than thrown into
the chain.

### 2. The 256 KiB cap is applied to the stream buffer, not to a message — High

[src/mcp-server.mjs:296](src/mcp-server.mjs:296) checks the accumulated buffer size
*before* draining complete newline-delimited messages out of it. Nothing requires a
host to write one message per `data` event — batching several into a single write is
ordinary. When the batch crosses 256 KiB the server kills itself, reporting a
message-size violation that never happened.

Reproduced with 6 000 individually-legal `ping` messages (43 bytes each) in one write:

```
single chunk size: 262893 bytes; largest single message: 43 bytes
nelos-mcp: message exceeds 262144 bytes; terminating
onExit called with 1
responses: 0 of 6000
```

Fix: drain complete lines first, and bound only the *unterminated remainder*. That
also removes finding 17's repeated re-measurement of the whole buffer.

### 3. `initialize` echoes an unvalidated protocol version — Medium

[src/mcp-server.mjs:250-253](src/mcp-server.mjs:250):

```js
protocolVersion: typeof params?.protocolVersion === "string"
  ? params.protocolVersion
  : MCP_DEFAULT_PROTOCOL_VERSION,
```

The spec requires a server to respond with the client's version **only if it supports
it**, and otherwise to answer with a version it does support so the client can decide
whether to proceed. Echoing an arbitrary string claims support for every revision,
including future ones with incompatible semantics. Fix: keep a supported-versions set,
echo on a hit, return `MCP_DEFAULT_PROTOCOL_VERSION` on a miss.

Minor, same handler: `initialize` replies even when the message carries no `id`. The
`isRequest` guard sits below it ([src/mcp-server.mjs:260](src/mcp-server.mjs:260)) so
a malformed notification draws a response with `id: undefined`.

---

## Performance

Numbers below are from this machine (macOS, Node 24.18.0). Each was measured, not
estimated.

### 7. Every state-lock acquisition spawns `ps` — Medium

`readProcessIdentity` ([src/process-liveness.mjs:76](src/process-liveness.mjs:76))
tries `/proc` first, which does not exist on macOS, then shells out to `ps`:

```
readProcessIdentity: 6.2 ms per call (spawns ps on macOS)
identity: {"ps-start":"Fri Jul 24 14:24:32 2026"}
```

`withOwnedStateLock` ([src/task-state.mjs:164](src/task-state.mjs:164)) pays this once
per acquisition for the caller's *own* pid, and then again for the lock owner on
**every contention retry** — inside a loop that sleeps only 25 ms
([src/task-state.mjs:203](src/task-state.mjs:203)). A contended lock therefore spawns
roughly one process per 31 ms per waiter. macOS is the primary Codex desktop platform,
so this is the common path, and orchestration takes one of these locks per work-unit
decision.

Two cheap fixes, both safe:
- Cache the current process's own identity in a module-level variable. A process's own
  start time cannot change, so this is correctness-neutral and removes one spawn per
  acquisition outright.
- Cache observed identities per pid for the duration of one lock wait, so the retry
  loop stops re-spawning `ps` for the same owner.

### 8. `AppServerClient` re-copies its whole read buffer per chunk — Medium

[src/app-server-client.mjs:136](src/app-server-client.mjs:136) accumulates with
`this.buffer = Buffer.concat([this.buffer, chunk])` on every `data` event. For a
message at the 4 MiB ceiling arriving in 64 KiB socket chunks that copies ~128 MiB:

```
chunks: 64 x 64 KiB = 4 MiB
concat-per-chunk : 10.3 ms  (~128 MiB copied)
accumulate+join  : 0.3 ms
speedup          : 36.6x
```

Fix: keep a `parts[]` array plus a running byte count and `Buffer.concat(parts, bytes)`
once a full frame is present. `nelos web collect` over a large web pays this per
response, so it compounds.

### 9. `waitForTurn` polls flat with no backoff — Medium

[bin/nelos:1565](bin/nelos:1565) polls every `pollMs` (default 2 s,
[bin/nelos:60](bin/nelos:60)) until `maxWaitMs` (default 30 min,
[bin/nelos:61](bin/nelos:61)), and each poll fetches 20 turns to find one. That is up
to ~900 `turn/list` round-trips per wait. Exponential backoff capped at ~15 s cuts
that by roughly an order of magnitude while adding at most a few seconds of detection
latency — a good trade for a 30-minute wait. Keep `--poll-ms` as an explicit override.

### 16. Directory scans read records serially — Low

`ExecutionStoreV1.scan` ([src/execution-store.mjs:654](src/execution-store.mjs:654)),
`listRecords` ([src/task-state.mjs:69](src/task-state.mjs:69)), the queen-acceptance
scan ([src/queen-acceptance.mjs:294](src/queen-acceptance.mjs:294)), and the
worktree-receipt scan ([src/worktree-provisioning.mjs:299](src/worktree-provisioning.mjs:299))
all `await` one file at a time inside a `for` loop.

Worth noting the codebase already has the right helper — `mapWithConcurrency`
([src/work-result.mjs:513](src/work-result.mjs:513)) — it just is not used here.
Reusing it with a bounded limit keeps the existing ordering guarantees (all four sort
after collecting) while overlapping the I/O.

### 17. Every execution-store write validates twice — Low

`#write` ([src/execution-store.mjs:570](src/execution-store.mjs:570)) calls
`validateWorkUnitSpecV1(record)`, then hands the result to
`serializeWorkUnitSpecV1`, which validates it *again*
([src/execution-store.mjs:430](src/execution-store.mjs:430)). `sameRecord`
([src/execution-store.mjs:477](src/execution-store.mjs:477)) serializes — and so
validates — both sides for a single equality test, i.e. four validations per
comparison. Records are small so the wall-clock cost is minor; the reason to fix it is
that "validate" and "serialize" currently cannot be reasoned about independently.

### Dismissed after measuring: WebSocket masking

`encodeClientFrame` ([src/app-server-client.mjs:72](src/app-server-client.mjs:72)) and
the unmask loop ([src/app-server-client.mjs:229](src/app-server-client.mjs:229)) XOR
byte-by-byte with a modulo per byte, which reads like an obvious hot spot. It is not:

```
per-byte XOR + modulo : 9.1 ms for 4 MiB
32-bit word XOR       : 5.6 ms for 4 MiB
speedup               : 1.6x
```

V8 handles the byte loop well. A 1.6x win on ~9 ms is not worth replacing clear code
with typed-array aliasing. **Leave as is.**

---

## Best practice and CI

### 10. Only Node 20 is tested, and Node 20 is past EOL — Medium

`package.json` declares `"node": ">=20"`, and
[.github/workflows/verify.yml:25](.github/workflows/verify.yml:25) tests exactly Node
20 — which reached end-of-life in April 2026. So the single tested version is the one
version no user should still be running, and the range the package claims to support
(22, 24) is never exercised. I ran the suite locally on Node 24.18.0 and it passes, so
widening the matrix to `[20, 22, 24]` should be close to free.

### 11. CI runs none of the verifiers the docs call the verification sequence — Medium

[docs/development.md:102](docs/development.md:102) gives the "complete local
verification sequence" as `npm test`, `npm run check`, `npm run check:model-catalog`,
`npm run verify:app-server`, `npm run verify:golden-loop`. CI runs the first two only.
The golden-loop verifier is the project's own stated proof of the core acceptance gate
and it never runs automatically. `verify:app-server` and `check:model-catalog`
(non-`--offline`) reach the network or a Codex binary, so those need judgement — but
`verify:golden-loop` is deterministic and makes no model calls by design, so it should
be a CI step.

### 19. Workflow hygiene — Low

[.github/workflows/verify.yml](.github/workflows/verify.yml): `on: push` has no branch
filter, so every branch push duplicates the PR run; there is no `concurrency` group
with `cancel-in-progress`, so superseded runs keep burning minutes; and no job sets
`timeout-minutes`, so a hung test can occupy a runner for the 6-hour default.

### 20. `npm run check` is a 45-command hand-maintained string — Low

The `check` script in `package.json` lists every file to `node --check` by name. Adding
a source file and forgetting to append it means it is silently never syntax-checked.
A glob-driven loop over `bin/`, `src/`, and `scripts/` cannot drift.

### Test suite shape — informational

80 s wall for 359 tests. The distribution is very lopsided: twelve worktree tests
account for ~11.5 s (0.3–1.5 s each) because they do real `git` work, and everything
else is sub-10 ms. That is a reasonable trade for testing real Git semantics — worth
knowing rather than fixing, but if CI time becomes a concern that is the only place
with anything to win.

---

## Documentation currency

This is the part you specifically asked about. I checked the project's recorded claims
against current Codex source and the current MCP specification.

### Codex functionality

**3. `cwd` now resolves against the plugin root — the bootstrap looks retirable (High).**

[docs/mcp-tool-surface.md:70](docs/mcp-tool-surface.md:70) states:

> The server's working directory is the **active task workspace**, not the plugin cache
> root, so plugin-relative paths do not resolve either.

Current Codex source contradicts the conclusion. In
`codex-rs/codex-mcp/src/plugin_config.rs`, `normalize_plugin_mcp_server_value` joins a
relative `cwd` from a plugin-provided `.mcp.json` onto the plugin root:

```rust
if let PluginMcpSource::Host { root } = source
    && let Some(JsonValue::String(cwd)) = object.get("cwd")
    && !Path::new(cwd).is_absolute()
{
    object.insert("cwd".to_string(),
        JsonValue::String(root.join(cwd).display().to_string()));
}
```

That file was last touched 2026-06-25, so the behavior was present when the probe ran
on 2026-07-22 — it simply was not among the things probed. It is independently
confirmed working by a third party on openai/codex#22842 (comment 2026-06-24) and by a
published plugin that ships `"cwd": "."`.

The ADR's empirical findings are individually accurate: `${PLUGIN_ROOT}` really is not
substituted, and no plugin-root environment variable is injected. The conclusion drawn
from them is what is stale, and so is the recorded retirement condition
([docs/mcp-tool-surface.md:100](docs/mcp-tool-surface.md:100)), which waits for
`${PLUGIN_ROOT}` substitution specifically — a mechanism that may never arrive because
a different supported one already exists.

If this holds on a real install, the entire 43-line inline `node -e` bootstrap,
`buildMcpBootstrap` ([scripts/generate-mcp-config.mjs:22](scripts/generate-mcp-config.mjs:22)),
the baked `NELOS_PLUGIN_VERSION` env value, and every assumption about
`~/.codex/plugins/cache/*/nelos/<version>/` collapse to:

```json
{
  "mcpServers": {
    "nelos": { "command": "node", "args": ["./src/mcp-server.mjs"], "cwd": "." }
  }
}
```

That also removes the version-pinning failure mode where `.mcp.json` and the cached
plugin version disagree. **Worth one probe round before anything else on this list** —
it deletes more code and more risk than every other item here combined.

**4. "Bundled MCP servers are disabled by default" — false on the pinned version (High, confirmed).**

This claim is load-bearing: it is the README's headline install step
([README.md:56](README.md:56)), it is in the ADR
([docs/mcp-tool-surface.md:62](docs/mcp-tool-surface.md:62)), and an open backlog item
exists to teach `doctor` about the disabled state
([docs/backlog.md:41](docs/backlog.md:41)).

In current `codex-rs/config/src/types.rs`, both gates default to **enabled**:

```rust
const fn default_enabled() -> bool { true }

pub struct PluginConfig {
    #[serde(default = "default_enabled")] pub enabled: bool,
    pub mcp_servers: HashMap<String, PluginMcpServerConfig>,
}
pub struct PluginMcpServerConfig {
    #[serde(default = "default_enabled")] pub enabled: bool,
    ...
}
```

`Default for PluginMcpServerConfig` also sets `enabled: true`, and `manager.rs` calls
`set_user_plugin_enabled(..., /*enabled*/ true, ...)` on install. Reading
`configured_plugin_states`, the *plugin* must appear in the config stack to count as
enabled — which `codex plugin add` writes for you — but the *per-server*
`mcp_servers."nelos".enabled` sub-block that the README asks users to paste defaults to
`true` and appears to be unnecessary. openai/codex#17360 (April 2026) independently
reports a plugin-bundled server showing as `enabled` in `codex mcp list` with no manual
setup, while the desktop UI still says "Set up in MCP settings".

**Confirmed by read-only observation of this machine's live install** (`codex-cli
0.144.6` — the exact pinned version). The entire nelos block in `~/.codex/config.toml`
is:

```toml
[plugins."nelos@nelos-marketplace"]
enabled = true
```

There is no `[plugins."nelos@nelos-marketplace".mcp_servers."nelos"]` sub-table — the
block the README calls mandatory is absent. `codex mcp list --json` nonetheless reports
`{"name": "nelos", "enabled": true}`. That is the config shape `codex plugin add`
writes by itself, and the server is enabled from it.

So the README's central install instruction is an unnecessary step in the first thing a
new user does, and backlog item [docs/backlog.md:41](docs/backlog.md:41) — teaching
`doctor` to recognize the installed-but-disabled state — is moot as written.

Two limits on this observation, both worth closing in round 4: it does not prove the
tools *function* in a live task (only that the server is enabled), and it cannot rule
out that the sub-block was present earlier and removed. Round 4 settles both on a clean
`CODEX_HOME`. The earlier probe's finding that the bare plugin key was *rejected*
remains a real observation whose cause is still unexplained — it may have been a
launch failure misread as a policy failure.

**12. `.mcp.json` uses the undocumented bare server-map shape (Medium).**

`buildMcpConfig` ([scripts/generate-mcp-config.mjs:73](scripts/generate-mcp-config.mjs:73))
emits `{ "nelos": {...} }` — no `mcpServers` wrapper. Codex's `PluginMcpFile` is an
untagged enum accepting both shapes, so this works today, but it depends on a fallback
variant rather than the documented form, and openai/codex#22105 shows the two shapes
are already a source of confusion. The wrapper is the documented shape and costs
nothing.

**13. Host observations pinned to `0.144.6`; current stable is `0.145.0` (Medium).**

`codex-cli 0.144.6` appears in [docs/mcp-tool-surface.md:4](docs/mcp-tool-surface.md:4),
[docs/host-owned-control.md:32](docs/host-owned-control.md:32),
[docs/backlog.md:24](docs/backlog.md:24),
[src/mcp-server.mjs:20](src/mcp-server.mjs:20),
[scripts/generate-mcp-config.mjs:9](scripts/generate-mcp-config.mjs:9),
[test/mcp-config.test.mjs:41](test/mcp-config.test.mjs:41), and the fixture
`test/fixtures/app-server-permissions-v0.144.6.json`. Stable `0.145.0` shipped
2026-07-21 — a day *before* the recorded observation date of 2026-07-22 — and
`0.146.0-alpha.6` is already out. Whatever comes of findings 3 and 4, re-run the probe
against `0.145.0` and re-pin, since half the ADR's conclusions rest on it.

### The MCP standard

**5. Protocol version is one full revision behind (Medium).**

[src/mcp-server.mjs:24](src/mcp-server.mjs:24) pins
`MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18"`. The current finalized revision is
**2025-11-25**. A `2026-07-28` release candidate also exists — a large one, with a
stateless core, an extensions framework, and a redesigned Tasks extension — but it is
still an RC and explicitly subject to change, so `2025-11-25` is the correct target
today and the RC is something to watch, not adopt.

Nothing in `2025-11-25` breaks this server. The revision is additive for a stdio tools
server: icons on tools, tool-naming guidance, task support (experimental), elicitation
and authorization changes that do not apply here, and JSON Schema 2020-12 formalized as
the default dialect — which the existing schemas already conform to. Two minor items
are directly relevant and easy wins:

- stderr is explicitly sanctioned for *all* logging on stdio, not just errors. The
  server already does this ([src/mcp-server.mjs:297](src/mcp-server.mjs:297)) — now it
  is blessed rather than tolerated.
- input-validation failures should be returned as **tool execution errors**, not
  protocol errors, so the model can self-correct. `callTool` already does the right
  thing for validation failures inside `tool.run`
  ([src/mcp-server.mjs:227-234](src/mcp-server.mjs:227)) — but an unknown tool name
  throws `-32602` ([src/mcp-server.mjs:218](src/mcp-server.mjs:218)), which is a
  protocol error the model cannot recover from. Returning it as an `isError` result
  would let a model that guessed a tool name correct itself.

**18. No `outputSchema` / `structuredContent` (Low).**

Every tool returns `content: [{ type: "text", text: JSON.stringify(body) }]`
([src/mcp-server.mjs:237](src/mcp-server.mjs:237)). Structured tool output has been
available since `2025-06-18` — the revision already pinned — so this is a missed
feature of the *current* target, not only the next one. All five tools return
well-defined, already-validated shapes, which is exactly the case `outputSchema` exists
for. Adding it is backward compatible: the spec expects servers to keep returning the
serialized JSON in `content` alongside `structuredContent`.

### Internal documentation drift

**14. `backlog.md` marks implemented work as not started (Medium).**

The "Durable execution foundation" delivery slices
([docs/backlog.md:62-71](docs/backlog.md:62)) list five unchecked `[ ]` items —
`ExecutionStoreV1`, `WorkUnitSpecV1`, the pure reducer, action keying with
preconditions, and restart-reconciliation proof. All five are implemented and covered
by passing tests: [src/execution-store.mjs](src/execution-store.mjs),
[src/web-orchestration.mjs](src/web-orchestration.mjs),
[src/execution-reconciliation.mjs](src/execution-reconciliation.mjs), with
`proposedActions` carrying `preconditions`
([src/web-orchestration.mjs:512](src/web-orchestration.mjs:512)). The later `[x]`
entries in the same section describe work built *on top* of these, so the section reads
as if its own foundation is missing.

**15. A "Done" entry claims CI gates that CI does not run (Medium).**

[docs/backlog.md:186](docs/backlog.md:186) lists as Done: "Add hermetic macOS/Linux CI
release gates that package, install, and verify the skill-and-CLI product from clean
environments." The only workflow runs `npm ci`, `npm run check`, `npm test` on two
runners. Nothing packages, installs, or verifies a distribution. Either the workflow
lost steps or the claim was aspirational; either way it should not read as Done. This
is the same gap as finding 11, seen from the other side.

**21. Broken anchor (Low).**

[docs/installation.md:8](docs/installation.md:8) links `../README.md#install-in-codex`.
The README has no such heading — the section is `## Quick start` (`#quick-start`). I
link-checked all 22 markdown files; this is the only broken link.

**22. The `xhigh` caveat is still open (Low).**

[src/intelligence-profile-catalog.mjs:26](src/intelligence-profile-catalog.mjs:26)
records that `"xhigh"` was never confirmed against a live `model/list` response and may
really be `extra_high` or `extraHigh`. The comment reasons that a wrong value fails
loudly at launch rather than silently, which is sound — but the catalog is 3 days old
(`reviewedAt: 2026-07-21`, well inside the 90-day `STALE_AFTER_DAYS` window), so
`npm run check:model-catalog` reports `fresh` and will not resurface this until October.
It is worth resolving while the catalog is being looked at anyway, or the freshness
check will keep saying "no action needed" about a known unknown.

---

## Suggested order

1. **Probe `cwd: "."` and default enablement on a real install** (findings 3, 4). Both
   are cheap to test and both can delete shipped complexity — the bootstrap, the
   version pin, and possibly a required step from the README's quick start. Do this
   before touching anything else, because the outcome changes what is worth fixing.
2. **Fix the two MCP server bugs** (findings 1, 2). Small, self-contained, and both are
   silent-failure modes in the shipped tool surface; each needs a regression test.
3. **Move the protocol pin to `2025-11-25` and validate it** (findings 5, 6), plus the
   unknown-tool error class. Small diff, keeps the server current.
4. **Cache process identity** (finding 7). One-line-ish, removes a subprocess spawn from
   every lock acquisition on the primary platform.
5. **CI: widen the Node matrix, add `verify:golden-loop`, add concurrency and timeouts**
   (findings 10, 11, 19).
6. **Reconcile the backlog and fix the broken anchor** (findings 14, 15, 21) — ideally
   in the same pass as 1, since the probe outcome rewrites those sections anyway.
7. The remaining performance items (8, 9, 16, 17) when the surrounding code is next
   touched. Real, measured, but none is currently hurting a user.

## Sources

- [MCP specification (latest)](https://modelcontextprotocol.io/specification/latest)
- [MCP 2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
- [MCP 2026-07-28 release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [openai/codex#22842 — plugin-root relative paths in plugin `.mcp.json`](https://github.com/openai/codex/issues/22842)
- [openai/codex#17360 — plugin MCP servers register but do not show in settings](https://github.com/openai/codex/issues/17360)
- [openai/codex#22105 — `mcp_servers` vs `mcpServers` in plugin docs](https://github.com/openai/codex/issues/22105)
- [openai/codex releases](https://github.com/openai/codex/releases)
- [Codex plugins documentation](https://learn.chatgpt.com/docs/plugins)
