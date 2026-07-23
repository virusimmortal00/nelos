# Development

This document covers desktop-free app-server development and the full
verification suite. For the product overview and install path, see the
[README](../README.md).

## Desktop-free app-server development

The Codex CLI can run its standalone
[app server](https://learn.chatgpt.com/docs/app-server.md) over a Unix socket.
This supports backend development and durable task dogfooding on systems that
cannot run the Codex desktop application, including Intel Macs with a native
Codex CLI build.

Confirm that the CLI is installed and authenticated, then start the server in
the foreground:

```bash
codex --version
codex login status
npm run dev:app-server
```

The launcher can choose its own development socket, but task clients require
that socket through `--socket`, a manually supplied
`CODEX_APP_SERVER_CONTROL_ENDPOINT`, or `CODEX_APP_SERVER_CONTROL_SOCKET`.
Codex does not currently inject the proposed host descriptor.
It performs an app-server initialization handshake before reporting readiness,
refuses to replace an existing or unreachable socket, and stops only the
process that it started. Pass a custom absolute socket or Codex binary
when needed:

```bash
npm run dev:app-server -- --socket /absolute/path/app-server.sock
npm run dev:app-server -- --codex /absolute/path/codex
```

The socket's immediate parent must be a private, user-owned directory (for
example, mode `0700`). Do not place the socket directly in `/tmp` or
`/private/tmp`; create a private subdirectory there first.

In another terminal, use the source CLI or connect the Codex terminal UI to the
same explicitly selected socket:

```bash
node bin/nelos list --all --socket /absolute/path/app-server.sock
codex --remote unix:///absolute/path/app-server.sock
```

The standalone server replaces the desktop backend, not its UI. Never use it as
the transport for tasks expected to appear live in the desktop sidebar. The
app-server interface is experimental, so keep its protocol behind the shared
client and re-run the standalone verifier after Codex CLI upgrades.

## Verifiers

The default standalone-server verifier starts its own temporary Unix socket,
initializes through Nelos, exercises `thread/list`, and removes its
process and temporary state. It does not start a task or make a model call:

```bash
npm run verify:app-server
```

The live verifier is deliberately opt-in. It creates one uniquely named,
read-only task, waits for a model response, starts a second turn on the same
task, reads both results, and requires server-confirmed archival before it
exits:

```bash
npm run verify:app-server:live
npm run verify:app-server:live -- --model MODEL --effort LEVEL
```

This runs two model turns and may consume billed or plan usage. The socket,
workspace, and Nelos registry are temporary, but the task uses the
normal Codex store and remains there as an archived session.

The deterministic golden-loop verifier exercises the product's core gate
without making model calls: upstream completion remains blocked until the queen
records acceptance; restart reconstructs the same pending release; the
dependent recovers on the same durable task; and synthesis uses accepted current
results only. Run the one-pass demo for a quick decide proof or the two-pass
verifier for CI confidence:

```bash
npm run demo:acceptance-gates
npm run verify:golden-loop
```

The model-catalog freshness check compares the reviewed intelligence profile
catalog (`src/intelligence-profile-catalog.mjs`) against the current public
Models and Subagents guidance. It is read-only: it never edits the catalog,
never queries a host account or app server, and any drift it finds requires a
separate, deliberate code change to resolve:

```bash
npm run check:model-catalog
npm run check:model-catalog -- --offline
```

The complete local verification sequence:

```bash
npm test
npm run check
npm run check:model-catalog
npm run verify:app-server
npm run verify:golden-loop
```

`npm test` canonicalizes its fixture-only temporary root before test discovery,
so the bare command is safe on both macOS and Linux. Tests still construct
explicit symlinked ancestry when verifying production path-safety rejection.
The GitHub Actions verification runs from a clean install with an isolated
`CODEX_HOME`; it does not read or update a user's Codex state.

Editing any distributed surface — including `README.md`, `assets/`, `docs/`,
`bin/`, `src/`, `skills/`, `completions/`, `.codex-plugin/`, or `package.json` —
invalidates the `integrity` digest in `distribution-provenance.json`. Update
the record's `integrity` with `computeDistributionIntegrity` from
`src/distribution-provenance.mjs` (and `skillIntegrity` with
`computeFileIntegrity` over the bundled skill's `SKILL.md` when `skills/`
changed), bump the `revision` once for all surfaces, and rerun `npm test`.

The previous MCP/UI prototype is intentionally absent from the source and
distributed plugin. Its host requirements remain documented for future work.
