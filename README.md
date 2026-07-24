<p align="center">
  <img src="docs/assets/nelos-banner.png" alt="Nelos" width="100%">
</p>

<h1 align="center">Nelos</h1>

<p align="center">
  <strong>Turn one big Codex task into a web of safe, parallel work —<br>
  with the right model and reasoning routed, and verified, for every slice.</strong>
</p>

<p align="center">
  <a href="#what-is-nelos">What it does</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#whats-in-the-box">What's in the box</a> ·
  <a href="docs/webs.md">Docs</a>
</p>

---

## What is Nelos?

Nelos is a plugin for [Codex](https://developers.openai.com/codex) that turns one
big task into a web of parallel, dependency-aware work — and adds three things you
don't get from Codex, its native subagents, or hand-run parallel chats:

- **The right model and reasoning for every slice — verified.** Nelos routes each
  slice to a fit-sized model and effort level, then confirms the task *actually
  ran* on it and stops the moment they don't match. No silent downgrades, no
  burning `max`-effort reasoning on trivial work. [How routing works →](docs/routing.md)
- **Parallel work that respects dependencies.** Slices launch in ordered *waves* —
  a later one only starts once the upstream work it needs has been accepted, not
  fire-and-hope.
- **Durable tasks you can still see and steer.** Spinoffs get their own lifecycle
  and appear right in the Codex desktop sidebar, so you can open, watch, or take
  one over by hand while Nelos coordinates the rest.

## Why "Nelos"?

**Nelos** comes from ***Anelosimus***, a genus of cosmopolitan cobweb spiders —
many of them *social*, cooperating on one shared web. That's the shape of the
tool: many focused agents working a shared **web** of tasks, led by a **queen**,
with durable branches called **spinoffs**.

## Quick start

> **Codex only** · macOS / Linux · Node.js 20+ · Windows not yet supported.

Install the plugin:

```bash
codex plugin marketplace add virusimmortal00/nelos --ref main
codex plugin add nelos@nelos-marketplace
```

Enable its bundled tools — Codex keeps plugin MCP servers off until you opt in —
by adding this to `~/.codex/config.toml`:

```toml
[plugins."nelos@nelos-marketplace".mcp_servers."nelos"]
enabled = true
```

Then restart Codex, open a fresh task, and ask:

```text
Use Nelos to plan this feature into safe parallel slices.
```

No installer, no manual copying, no `PATH` changes.

## What's in the box

Nelos is one Codex plugin with two parts:

- **An MCP server with a scoped Codex app-server bridge.**
  `nelos_plan_slices` plans dependency-safe waves and, when the plan contains
  spinoffs, automatically marks the current task as the queen before returning
  a launch action. Crown synchronization uses the canonical title grammar
  `[🕸️ inbound] [🕷️ outbound] [👑] · base title`, preserving any web-lineage
  markers rather than blindly prepending `👑 ·`. The bridge detects a title
  change during its preflight reads; Codex `0.144.x` has no compare-and-set
  title operation, so a simultaneous manual Desktop rename is not supported.
  `nelos_thread_inspect`
  exposes bounded, read-only
  task metadata; `nelos_thread_inventory` batches known IDs and projects direct
  parent edges; `nelos_thread_wait` performs bounded current-state polling; and
  `nelos_app_server_health` reports content-free compatibility telemetry. The
  intelligence router and verifier remain read-only, while the two callback
  orchestration tools durably journal native task effects. The bridge starts one
  `codex app-server --stdio` child lazily and never exposes prompts, turns, or
  transcripts.
- **A skill** — `manage-nelos-tasks`, the playbook that decides when a slice is a
  quick **subagent** or a durable **spinoff** and executes each tool's next action.

Spinoffs remain ordinary top-level Codex tasks—visible and steerable in the
desktop sidebar while Nelos coordinates. Nelos plans and coordinates; you still
own Git branches, merges, and final review.

## Learn more

- [Model & reasoning routing](docs/routing.md) — how each slice is sized, and verified
- [Native task orchestration](docs/task-orchestration.md) — durable create, title sync, crash-resume
- [Webs and terminology](docs/webs.md) — the queen / spinoff / web model
- [Slice planning](docs/slice-planning.md) — a full worked example
- [Worktree coordination](docs/worktree-coordination.md) — one writer per branch
- [Installation and trust](docs/installation.md) · [Development](docs/development.md)

## Contributing

The `nelos` CLI is a separate surface for contributors and automation. From source
(Node.js 20+):

```bash
npm install
npm run install:distribution
nelos --help
```

Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

<details>
<summary>Upgrading from Fraktik</summary>

Nelos was previously published as **Fraktik** (through 0.2.1). The rename changes
the install identity, so remove the old plugin and delete any
`[plugins."fraktik@fraktik"...]` blocks from `~/.codex/config.toml`, then follow
the [Quick start](#quick-start):

```bash
codex plugin remove fraktik@fraktik
codex plugin marketplace remove fraktik
```
</details>

<details>
<summary>Installing from another marketplace</summary>

Nelos doesn't have to come from its bundled one-plugin marketplace. Add it to any
marketplace's `plugins` array, then install with `nelos@<marketplace-name>`:

```json
{
  "name": "nelos",
  "source": { "source": "url", "url": "https://github.com/virusimmortal00/nelos.git", "ref": "main" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Developer Tools"
}
```
</details>

---

<sub>Independent open-source project — integrates with Codex, not affiliated with
OpenAI. [MIT](LICENSE) © Nelos contributors.</sub>
