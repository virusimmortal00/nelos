<h1 align="center">Nelos 👑🕷️</h1>

<p align="center">
  <strong>Bring the work. Nelos divvies it up.</strong><br>
  <em>Smarter orchestration. More parallel work. Better use of every credit. Just more better.</em>
</p>

<p align="center">
  <a href="#nelos-in-action">See it work</a> ·
  <a href="#install-nelos">Install</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#whats-in-the-box">What's in the box</a> ·
  <a href="docs/webs.md">Docs</a>
</p>

<p align="center">
  <img
    src="docs/assets/showcase/nelos-web-hero.png"
    alt="A Nelos queen task in Codex receiving a completed spinoff result alongside its visible B1 web of durable tasks"
    width="100%">
</p>

<p align="center"><sub><em>One objective becomes a visible web of focused Codex tasks—and completed work reports back to the coordinator automatically.</em></sub></p>

---

## What is Nelos?

Nelos is a plugin for [Codex](https://developers.openai.com/codex) that combines
a task-management skill, an MCP orchestration server, and a dedicated official
Codex app-server child process for native task control.

## Install Nelos

> **Codex CLI 0.144.5+** · macOS / Linux · Node.js 20+ · Windows not yet supported.

```bash
codex plugin marketplace add virusimmortal00/nelos --ref marketplace/stable
codex plugin add nelos@nelos-marketplace
```

New to Codex, missing Node.js, or using the desktop app? Follow the
[complete installation guide](#installation-guide) for prerequisites, desktop
steps, bundled-tool enablement, upgrades, and rollback.

**A little Nelos vocabulary:**

| Marker | Term | What it means |
| :---: | --- | --- |
| 👑 | **Queen** | The coordinating task that plans, launches, and accepts the work. |
| 🕷️ | **Spinoff** | A durable, focused Codex task that executes one slice of the work. |
| 🕸️ | **Web** | One coordinated group of Codex tasks working toward a shared objective. |
| `B1` | **Web ID** | A short ID shared by the queen and durable spinoff titles that keeps the web recognizable. |

### From a normal task to a Nelos web

1. **Start exactly as you always have.** Open a normal Codex task and describe
   the work.
2. **A dedicated planner decomposes it.** When a web would help, Nelos launches
   one fresh, bounded, read-only **Sol / medium** planning subagent. That route
   is fixed and verified regardless of the model or reasoning level selected
   in the original task, so planning never silently inherits a cheaper starting
   configuration. A task started on Luna or Terra still gets Sol for
   decomposition.
3. **Your original task becomes the queen.** It stays right where it is as the
   coordinator. When the plan uses durable spinoffs, its title receives the 👑
   marker and a permanent web ID; each spinoff receives 🕷️ and a monotonic
   child suffix under that ID.
4. **The orchestrator chooses the workers—not just their prompts.** A plan may
   use only joined Codex subagents for bounded work, durable spinoff tasks for
   work that should remain independently visible and steerable, or a mix of
   both. Subagents report directly within the queen task; spinoffs live in the
   sidebar and report home through Nelos.

**The efficiency play:** Nelos spends consistent high intelligence once on the
plan, then routes every execution slice independently. Straightforward work can
use faster, cheaper models at lower reasoning levels; difficult work still gets
more — reducing time and credit use without weakening the decomposition.

#### Example: mixed intelligence, on purpose

Suppose `Add Codex functionality checker` starts on **Terra / max**. The fixed
Sol / medium planner returns an execution plan with one joined subagent and four
durable spinoffs. Nelos does not copy one setting to every worker:

| Task | Kind | Model / reasoning | Example state |
| --- | --- | --- | --- |
| 👑`B8 · Add Codex functionality checker` | Original task → queen | **Terra / max** | Coordinating Wave 1 |
| `Plan and classify the work` | Dedicated planning subagent | **Sol / medium** | Complete — plan accepted |
| `Inspect the existing plugin surface` | Joined subagent — not shown in the sidebar | **Terra / low** | Running in Wave 1 |
| 🕷️`B8.1 · Collect exact open source evidence` | Durable spinoff | **Luna / low** | Running in Wave 1 |
| 🕷️`B8.2 · Collect bounded documentation evidence` | Durable spinoff | **Terra / medium** | Running in Wave 1 |
| 🕷️`B8.3 · Build the offline deterministic gate` | Durable spinoff | **Sol / high** | Running in Wave 1 |
| 🕷️`B8.4 · Define compatibility contracts` | Durable spinoff | **Terra / high** | Running in Wave 1 |

One objective now uses seven different model/reasoning combinations. Nelos puts
deeper intelligence where judgment matters, uses faster profiles for bounded or
repeatable work, and verifies every launched route before accepting its result.

<p align="center">
  <img
    src="docs/assets/showcase/web-roles-and-ids.png"
    alt="Codex task list showing four spider-marked B1 spinoffs and their crown-marked B1 queen"
    width="880">
</p>

<p align="center"><em>The same B1 web: four durable spinoffs are visible and steerable; its joined subagent stays attached to the queen.</em></p>

Together, those three layers turn work into a web of parallel, dependency-aware
Codex tasks, with capabilities you don't get from Codex alone, its native
subagents, or hand-run parallel chats:

- **Smart Model + Reasoning Router:** The right model and effort for every
  slice — verified after launch. Nelos routes each slice to a fit-sized model
  and reasoning level, then confirms the task *actually ran* with that exact
  route and stops the moment it does not match. No silent downgrades, no
  burning `max`-effort reasoning on trivial work. [How routing works →](docs/routing.md)
- **Dependency-Aware Work Scheduler:** Parallel work that understands
  prerequisites. Slices launch in ordered *waves* — a later one starts only
  after the upstream work it needs has been accepted, not fire-and-hope.
- **Durable Task Orchestrator:** Workers you can still see, steer, and hear
  back from. Spinoffs remain ordinary Codex tasks in the desktop sidebar, and
  completed work reports back to the queen even when it is idle.
- **Native Codex App-Server Bridge:** Native tasks, not a separate task
  universe. The MCP server lazily starts one official
  `codex app-server --stdio` child, uses a narrow version-checked control
  surface, and exposes no prompts or transcripts.
- **Visible Execution Map:** MCP Apps-compatible hosts render an inline receipt
  after planning, dispatch, and spin-off cleanup, showing every task's
  lifecycle, exact model, reasoning level, authorization, launch, and archive
  status in independently collapsible status rollups. Expanded groups use
  compact worker rows, retain their disclosure state across compatible updates,
  and offer a compact active-status bulk toggle; aggregate counts remain in the
  structured receipt for non-UI clients without duplicating the visible roster,
  and protocol tools publish their exact model-visible result schemas.

## Nelos in action

### Dependencies wait for accepted work

Nelos can run independent slices in parallel, but it does not release downstream
work merely because an upstream task stopped. The result must pass the queen's
acceptance gate first, and the orchestration state survives restarts.

<p align="center">
  <img
    src="docs/assets/showcase/acceptance-gates.png"
    alt="Terminal output from the Nelos golden-loop demo showing acceptance, dependency, restart, recovery, collection, and cleanup checks passing"
    width="100%">
</p>

<p align="center"><em>Run the same three-member proof with <code>npm run demo:acceptance-gates</code>.</em></p>

## Why "Nelos"?

**Nelos** comes from ***Anelosimus***, a genus of cosmopolitan cobweb spiders —
many of them *social*, cooperating on one shared web. That behavior inspired
Nelos's name and vocabulary.

## Installation guide

> **Codex only** · macOS / Linux · Node.js 20+ · Windows not yet supported.

### Prerequisites

Nelos requires Codex CLI `0.144.5` or newer, even if you normally use Codex in
the ChatGPT desktop app. The CLI is currently required once to register Nelos's
custom GitHub marketplace source.

Install the [Codex CLI](https://learn.chatgpt.com/docs/codex/cli#getting-started),
verify the installed version, and sign in:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex --version
codex login
```

The official guide also provides npm and Homebrew installation options. Before
continuing, install [Node.js 20 or newer](https://nodejs.org/en/download) and
confirm it is available:

```bash
node --version
```

### Install from the terminal

Register Nelos's stable marketplace channel and install the plugin:

```bash
codex plugin marketplace add virusimmortal00/nelos --ref marketplace/stable
codex plugin add nelos@nelos-marketplace
```

Nelos's GitHub repository is itself a one-plugin marketplace; this does not add
an unrelated catalog. Codex currently installs plugins only from configured
marketplace snapshots: `codex plugin add` accepts `PLUGIN@MARKETPLACE`, not a
GitHub URL. See [Why is a marketplace required?](#why-is-a-marketplace-required).

### Desktop installation

1. Install and sign in to the
   [ChatGPT desktop app](https://chatgpt.com/download/), then select **Codex**.
2. In a terminal, register the source once:

   ```bash
   codex plugin marketplace add virusimmortal00/nelos --ref marketplace/stable
   ```

3. Quit and reopen the desktop app.
4. Open **Plugins**, select the **Nelos Marketplace** source, open **Nelos**,
   and select the plus button to install it.
5. Open **Settings > Configuration > Open config.toml** and add the bundled-tool
   configuration shown below.

Codex does not currently provide a graphical control for adding an arbitrary
Git marketplace. Once that source has been registered, installation and later
uninstallation can be done from the desktop Plugins directory.

### Enable Nelos and finish setup

`marketplace/stable` advances only to a published, validated stable release.
To upgrade later, refresh that marketplace snapshot and reinstall the plugin:

```bash
codex plugin marketplace upgrade nelos-marketplace
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
Exact release tags remain available for reproducible installs and rollback; see
[Installation and distribution trust](docs/installation.md#codex-marketplace-installs-upgrades-and-rollback).

### Why is a marketplace required?

Not because Nelos needs a large third-party catalog. It is a limitation of the
current Codex plugin installer: Git repositories can be registered as
marketplace sources, while individual plugins must be installed by their
`PLUGIN@MARKETPLACE` selector. There is no supported equivalent of
`codex plugin add https://github.com/virusimmortal00/nelos.git` today.

A fully graphical, no-CLI installation becomes possible if Nelos is published
in the universal plugin directory. Until then, the repository's single-plugin
marketplace is the shortest supported GitHub installation path.

## Configuration

Configure Nelos directly in conversation:

```text
Show my Nelos settings.
Set Nelos spin-off cleanup to ask.
Reset my Nelos spin-off cleanup preference.
```

The installed plugin handles those requests through its bundled MCP tools; the
separate contributor CLI is not required. Settings are stored in
`$XDG_CONFIG_HOME/nelos/config.toml`, or `~/.config/nelos/config.toml` when
`XDG_CONFIG_HOME` is unset. `NELOS_CONFIG` can select an explicit absolute file.
Repository-local `.nelos/` settings are intentionally ignored.

Spin-off cleanup defaults to `auto`; users can choose `ask` or `keep`. Valid
manual TOML edits are observed without restarting the plugin. Existing
remembered preferences migrate once into TOML; reset returns to the built-in
default. A cleanup already underway keeps its per-web policy snapshot. See
[Configuration](docs/configuration.md) for the schema and safety behavior.

## Codex compatibility

Nelos is tested against Codex CLI `0.144.5` and Codex Desktop `0.144.6`.
Codex `0.145.x` and later stable versions are allowed but have not yet been
verified against Nelos's full app-server test matrix. The
`nelos_app_server_health` tool reports the observed version, the tested
versions, and whether the current version has been tested.

Nelos requires Codex `0.144.5` or newer. It does not block a newer stable
release merely because that release has not been tested yet; instead, the
bridge continues to validate every app-server response and reports a focused
compatibility error if an operation's actual contract has changed. Prerelease
and custom build version identities are not treated as stable releases.

Pull requests use one required, token-free deterministic compatibility gate.
Run the identical command locally:

```bash
npm run compatibility:required
```

It compares the current `HEAD` with the merge base of
`COMPATIBILITY_BASE_REF`, `GITHUB_BASE_REF`, or `origin/main` (in that order),
removes `OPENAI_API_KEY`, and blocks network access for the gate and every
child test process. Scheduled drift, exact-release evidence, live runtime
smokes, and semantic advice run in separate workflows and cannot replace this
required status.

## What's in the box

Nelos is one Codex plugin with two cooperating parts:

- **An MCP orchestration server** — plans dependency-safe waves, routes and
  verifies every launch, persists replay-safe receipts, advances accepted work,
  coordinates completion and per-web cleanup, composes bounded web inspection,
  and exposes conversational machine-local configuration.
- **A task-management skill** — `manage-nelos-tasks`, the playbook that follows
  the MCP server's machine-generated next actions independently of whichever
  model starts as queen.

Spinoffs remain ordinary top-level Codex tasks—visible and steerable in the
desktop sidebar while Nelos coordinates. Nelos plans and coordinates; you still
own Git branches, merges, and final review.

## Learn more

- [Configuration](docs/configuration.md) — conversational settings, TOML schema, and precedence
- [Experimentation framework](docs/experimentation-framework.md) — contracts,
  isolation, measurement, and reproducibility for validating Nelos, Codex,
  plugin versions, code changes, and efficiency claims
- Experimentation contract API — import `nelos/experimentation-contract` or
  `nelos/experimentation-contract/index.mjs`; both expose the same 94 symbols
- [Experiment evaluation](docs/experimentation-evaluation.md) ·
  [Runtime isolation](docs/experimentation-runtime.md) ·
  [Runner and operations](docs/experimentation-operations.md) ·
  [Implementation roadmap](docs/experimentation-roadmap.md)
- [Model & reasoning routing](docs/routing.md) — how each slice is sized, and verified
- [Native task orchestration](docs/task-orchestration.md) — durable create, title sync, crash-resume
- [App Server compatibility contract](docs/app-server-compatibility-contract.md) —
  minimum and tested-version policy, fallbacks, and hardening gates
- [Webs and terminology](docs/webs.md) — the queen / spinoff / web model
- [Slice planning](docs/slice-planning.md) — a full worked example
- [Worktree coordination](docs/worktree-coordination.md) — one writer per branch
- [Codex capability leverage audit](docs/codex-capability-audit.md) — the ordered,
  evidence-backed review of native Codex features Nelos should adopt, pilot,
  defer, or reject
- [Installation and trust](docs/installation.md) · [Development](docs/development.md)
- [Release and compatibility policy](docs/release-policy.md) · [Changelog](CHANGELOG.md)

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
the [installation guide](#installation-guide):

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
  "source": { "source": "url", "url": "https://github.com/virusimmortal00/nelos.git", "ref": "v0.4.0" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Developer Tools"
}
```
</details>

---

<sub>Independent open-source project — integrates with Codex, not affiliated with
OpenAI. [MIT](LICENSE) © Nelos contributors.</sub>
