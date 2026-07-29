# Codex Capability Leverage Audit

Status: living product audit; initiated 2026-07-28.

This is the ordered register for evaluating every documented Codex capability
that could make Nelos more robust, efficient, observable, safe, or useful.
It complements the implementation backlog: this document decides whether a
capability belongs in the product, while [Product Backlog](backlog.md) breaks an
accepted decision into delivery slices.

The first completed assessment is Codex Goals. The remaining entries are the
exhaustive review queue derived from the current official Codex manual, the
installed CLI and app-server schemas, and Nelos's existing architecture.

## What “exhaustive” means

The audit is complete for a Codex release only when:

1. every capability family below has an explicit `adopt`, `pilot`, `defer`,
   `reject`, `monitor`, or `not applicable` decision;
2. every decision links to current official documentation and records locally
   observed behavior when Nelos depends on a protocol or host detail;
3. adopted capabilities have bounded implementation slices, failure and
   permission contracts, measurements, and rollback criteria in the backlog;
4. rejected or deferred capabilities state why, so they are not repeatedly
   rediscovered; and
5. a fresh manual outline, `codex features list`, CLI help, app-server schema,
   and current-session tool inventory contain no unclassified capability.

Generic ChatGPT features remain in scope only when they are available to Codex
or could materially affect Nelos users. A feature is not adopted merely because
it exists. Native Codex task, turn, goal, approval, and archival state remains
host-owned; Nelos may coordinate or project it, but must not invent a second
authority.

### Evidence order

Use the narrowest authoritative source that answers the question:

1. the current [Codex manual](https://developers.openai.com/codex/codex-manual.md)
   and its linked official product documentation;
2. the installed CLI's feature list, help, and generated app-server schema;
3. the callable capabilities exposed by the current Codex session;
4. the open-source Codex implementation when the public contract points to it;
5. a minimal local probe against the supported Codex versions; and
6. Nelos code, fixtures, tests, and dogfood evidence.

Undocumented behavior may justify a compatibility experiment, never an
unqualified product contract. Each release audit records the manual fetch date,
Codex versions tested, and evidence gaps.

## Ordered capability worklist

| # | Capability family | Initial relevance to Nelos | Decision | Delivery status |
| ---: | --- | --- | --- | --- |
| 1 | Persisted Goals and automatic continuation | Potential execution persistence for queens and durable spinoffs | `pilot` | Assessed; opt-in queen pilot specified |
| 2 | App Server protocol, transports, schemas, notifications, and capability negotiation | Core native integration boundary | `adopt` | Pinned baseline accepted; hardening active |
| 3 | Task lifecycle: start, read, list, resume, fork, rollback, archive, unarchive, title, and history | Core durable-spinoff control | `adopt` | Partially delivered; active Next |
| 4 | Turn lifecycle: start, steer, interrupt, review, approvals, items, and result events | Core execution and correction control | `adopt` | Partially delivered; active Next |
| 5 | Subagents, custom agent roles, collaboration modes, and parallel joins | Core bounded-work path | `adopt` | Core delivered; remaining surface queued |
| 6 | Worktrees, handoff, local environments, remote connections, and cloud environments | Isolation and parallel-write safety | `adopt` | Partially delivered; leading candidate |
| 7 | Models, reasoning effort, speed modes, routing, model availability, and rate limits | Core performance and cost policy | `adopt` | Core routing delivered; calibration queued |
| 8 | Configuration layers, profiles, feature flags, managed configuration, and environment variables | Install reliability and capability detection | `adopt` | Bundled-MCP diagnostics delivered; broader audit queued |
| 9 | Permissions, sandboxing, approvals, rules, automatic approval review, and internet access | Core safety boundary | `adopt` | Partial; permission/audit work active Next |
| 10 | Lifecycle hooks | Enforcement, audit, wake, and validation opportunities | `adopt` | Queued; high-impact |
| 11 | `AGENTS.md`, developer instructions, custom prompts, and project guidance | Durable behavioral correctness | `adopt` | Queued |
| 12 | Skills, skill metadata, scripts, assets, controls, and discovery | Existing Nelos workflow surface | `adopt` | Core delivered; remaining audit queued |
| 13 | Plugins, manifests, marketplaces, packaging, updates, controls, and submission checks | Existing distribution surface | `adopt` | Substantially delivered; first verified release published |
| 14 | MCP tools, resources, prompts, apps/connectors, dynamic tools, authentication, and elicitation | Existing tool and integration surface | `adopt` | Core delivered; broader surface queued |
| 15 | MCP Apps UI, components, metadata, CSP, and host compatibility | Possible inspect/confirm/navigation UI | `defer` | Deferred behind lifecycle foundations |
| 16 | Scheduled tasks, chat automations, thread wakeups, notifications, and attention UX | Recovery and unattended coordination | `pilot` | Partial; continuation experiments active Next |
| 17 | CLI commands, slash commands, `codex exec`, completions, remote TUI, and integrated terminal | Developer, recovery, and automation surfaces | `adopt` | Core delivered; release/clean-install tooling delivered |
| 18 | Codex SDK | Possible programmatic orchestration alternative | `monitor` | Alternative architecture remains queued |
| 19 | GitHub Action, code review, Codex Security, and custom review rules | CI, release, and security quality gates | `pilot` | Generic GitHub/CodeQL coverage partial; Codex-specific audit queued |
| 20 | Codex MCP server and Agents SDK integration | Alternative outer-orchestrator architecture | `defer` | Deferred pending lifecycle foundations |
| 21 | Browser, Chrome extension, Computer Use, and Record & Replay | UI testing and repeatable external workflows | `defer` | Deferred pending a bounded UI-testing use case |
| 22 | Files, image input/generation, web search, visualizations, Sites, and appshots | Rich evidence and operator artifacts | `pilot` | Queued for bounded operator-artifact experiments |
| 23 | Memories, Chronicle, projects, chats, side chats, and context compaction | Continuity without corrupting durable state | `defer` | Deferred pending an authority-safe continuity contract |
| 24 | Authentication, sessions, accounts, usage/spend controls, analytics, telemetry, governance, and admin policy | Operability and enterprise readiness | `adopt` | Governance and diagnostics partially delivered |
| 25 | Open-source components, release notes, feature maturity, diagnostics, and schema-diff monitoring | Continuous compatibility and audit closure | `adopt` | First release/schema gates delivered; continuous monitoring queued |

Items are ordered by architectural dependency, not novelty. App Server and
lifecycle semantics precede conveniences built on them; security and permission
reviews precede any newly automated mutation.

### Rebase review: `origin/main` at `88ceeb2`

Reviewed 2026-07-28 after rebasing from `7250a41` to `88ceeb2`. The upstream
release-readiness change materially advances six families:

| Item | Newly delivered upstream | Remaining scope |
| ---: | --- | --- |
| 8 | Four-state bundled MCP diagnostics distinguish missing, disabled, incompatible, and healthy installations | General config/profile/feature capability negotiation |
| 13 | Release policy, coherent plugin versioning, reproducible artifacts, upgrade/rollback guidance, community packaging controls, and first verified release | Continue plugin-surface audit |
| 17 | Clean-install verification and release-building CLI automation | Broader `codex exec`, remote TUI, slash-command, and recovery comparison |
| 19 | Protected checks, Dependabot, CodeQL, PR/issue templates, and a tag-only GitHub release workflow | Codex GitHub Action, Codex code review, Security scans, and custom review rules |
| 24 | `CODEOWNERS`, contribution/support/conduct policy, integrity diagnostics, and compatibility policy | Account, usage, spend, analytics, telemetry, and managed-admin controls |
| 25 | Changelog, compatibility/schema review gates, deterministic artifacts, checksums, provenance, SBOM, draft-release automation, and first public release evidence | Continuous schema-diff/feature-maturity monitoring |

No capability family is completely closed by this commit because each family is
intentionally broader than one implementation slice. Items 13, 17, 24, and 25
move down the incremental-impact ranking; items 2–4, 9, 10, and 16 remain the
highest-leverage unresolved areas. The new backlog also confirms that host-owned
task-control hardening, synthesis, and automatic continuation remain active
work rather than delivered behavior.

### Manual coverage baseline

The 2026-07-28 manual outline is accounted for as follows:

| Manual area | Worklist coverage |
| --- | --- |
| Surfaces and experiences | 17, 21–23 |
| Execution model and workflows | 1, 3–7, 16, 23 |
| Approvals, sandboxing, and security | 9, 19, 24 |
| Configuration, authentication, and models | 7–9, 24 |
| CLI, IDE, app, cloud, environments, and media behavior | 6, 17, 21–23 |
| Customization, skills, rules, MCP, plugins, and integrations | 10–15, 21, 23 |
| Noninteractive and programmatic interfaces | 2–4, 16–20 |
| Platform, enterprise, governance, and caveats | 24–25 |

ChatGPT-only pricing, consumer voice, and cosmetic experiences are excluded
unless a later audit shows a Codex/Nelos operability effect. Platform-specific
Windows, WSL, macOS, and Linux behavior is included under environment,
permission, and compatibility items. Enterprise controls remain queued even
when they are not available in a personal dogfood environment because they can
constrain the installed product.

## 1. Persisted Goals and automatic continuation

### Decision

**Pilot Goals as an opt-in, host-owned execution aid for a queen task first. Do
not make Goals Nelos's source of truth, do not enable them by default yet, and
do not use them for joined subagents in the initial pilot.**

The likely long-term fit is:

| Concern | Authority |
| --- | --- |
| User outcome, constraints, and verifiable definition of done for one Codex task | Native Codex Goal |
| Slice graph, dependencies, attempts, receipts, acceptance, cleanup, and web lineage | Nelos |
| Task/turn status, goal status, usage, approvals, and archive state | Native Codex/App Server |
| Cross-task synthesis and the decision that a web is complete | Queen plus Nelos acceptance records |

This division uses Goals for what they uniquely add—per-task persistence and
automatic continuation—without asking a single prose objective to replace
Nelos's deterministic orchestration protocol.

### Use-case decisions

| Possible use | Decision | Confidence | Reason |
| --- | --- | --- | --- |
| Keep an eligible queen working toward the accepted web outcome | Pilot | High | Native persistence and continuation directly address premature queen completion, while Nelos retains effect and acceptance safety |
| Give each durable spinoff its bounded work-unit outcome | Defer until the queen pilot passes | Medium | Promising fit, but Desktop creation starts the first turn before a post-bind goal can be safely attached |
| Put joined subagents in Goal mode | Reject for the initial design | High | Their bounded parent-owned lifecycle already supplies continuation and join control |
| Replace the Nelos plan/reducer with one Goal objective | Reject | High | A prose objective has no DAG, attempt, receipt, acceptance, or cleanup contract |
| Use a Goal as the canonical backlog or cross-task web record | Reject | High | Goals are per-chat; the reviewed backlog and persisted plan run retain cross-task ordering and history |
| Treat goal status as orchestration truth | Reject | High | Native goal completion and queen acceptance answer different questions |
| Use goal token/time counters in content-free diagnostics | Defer to a privacy and measurement review | Medium | Counters may help compare routes but do not establish progress or efficiency alone |
| Use native `/goal` inspection, pause, resume, and clear as the pilot operator surface | Adopt for pilots | High | This preserves host ownership and avoids a second Nelos UI |
| Replace or clear a pre-existing user-authored Goal | Reject | High | The schema has no owner, revision, or compare-and-set precondition, and replacement resets usage accounting |
| Set a token budget automatically | Reject unless an explicit user limit or reviewed policy exists | High | Budget exhaustion changes execution behavior and must not be inferred from task shape |

### Verified evidence

- [Long-running work](https://learn.chatgpt.com/docs/long-running-work) documents
  Goal mode in the desktop app, CLI, and IDE extension. A goal is attached to
  one chat, persists as completion criteria, and can be paused, resumed, edited,
  or cleared. Parallel chats have independent goals and should use separate
  worktrees when they write concurrently.
- Goal mode does not expand sandbox or approval authority. It pauses when a
  decision is required.
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  identifies `features.goals` as stable and enabled by default.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) exposes
  `thread/goal/set`, `thread/goal/get`, and `thread/goal/clear`, plus updated and
  cleared notifications. Objectives are non-empty and at most 4,000 characters.
  Replacing the objective resets usage accounting; updating the current
  objective's status or token budget preserves it.
- On 2026-07-28, local `codex-cli 0.144.6` reported `goals stable true`.
  Its experimental generated schema exposed statuses `active`, `paused`,
  `blocked`, `usageLimited`, `budgetLimited`, and `complete`, along with
  `tokenBudget`, `tokensUsed`, and `timeUsedSeconds`.
- Nelos's current App Server minimum/tested-version policy and checked-in
  compact protocol fixture do not include goal operations. Goal support
  therefore requires an explicit compatibility and permission expansion; it
  must not be smuggled through the existing read/title/turn surface.

### Evidence matrix

| Claim | Classification | Evidence | Design consequence |
| --- | --- | --- | --- |
| Goals persist per task and automatically continue work | Documented fact | Long-running-work and App Server docs | Worth a queen-first experiment |
| Goal mode is stable and on by default | Documented fact, locally confirmed | Configuration reference and `codex features list` on 0.144.6 | Feature-detect anyway; users and managed policy may disable it |
| Goal mutations and notifications are programmatically available | Documented fact, locally schema-confirmed | App Server docs and generated experimental schema | A receipt-bound adapter is technically possible |
| Goals do not broaden sandbox or approval authority | Documented fact | Long-running-work docs | Goal integration cannot replace attention handling |
| A queen Goal may reduce manual continuation | Nelos hypothesis | Not yet measured | Requires G2 dogfood before adoption |
| A spinoff Goal may race its already-started first turn | Nelos inference from current launch architecture | `create_thread` launch behavior documented in [Robust Native Task Orchestration](task-orchestration.md) | Defer spinoff pilot until an attach-before-work contract exists |
| Goal writes can race manual edits | Schema-backed inference | No owner, revision, or compare-and-set field in the generated goal schema | Opt-in only; preflight, exact verification, and fail-closed mismatch |

Precise refreshed-manual references are **Execution Model and Workflows →
Long-running work** (start, define done, steer, permissions, and parallel
goals), **Configuration, Authentication, and Models → Configuration Reference
→ Feature flags** (`features.goals`), **CLI, IDE, App, and Cloud Behavior →
Slash commands in Codex CLI → Set or view a task goal with `/goal`**, and
**Noninteractive and Programmatic Interfaces → Codex App Server → API overview
/ Manage a thread goal**. The current-session `get_goal`, `create_goal`, and
terminal `update_goal` tools are narrower, current-task-only agent controls:
their surfaced policy permits creation only on explicit request and terminal
updates only for actual completion or repeatedly demonstrated blocking. That is
current-session evidence, not a public cross-version integration contract.

### Nelos contract map

| Contract | Overlap | Gap and failure mode |
| --- | --- | --- |
| Planning and exception replanning | Goal can summarize outcome, constraints, and verification. | No typed DAG, route, plan digest, generation bound, or completed-slice preservation; objective edits can diverge from the persisted plan. |
| Durable execution | Automatic continuation may reduce manual continuation inside one task. | No action ID, receipt, idempotency key, attempt, worktree owner, or unknown-outcome reconciliation; repeated continuation can replay an effect unless Nelos gates remain authoritative. |
| Queen coordination | A queen Goal may keep the coordinating chat active and operator-visible. | Goal `complete` is task-local; it cannot prove required results are accepted, cleanup is settled, or the web is complete. |
| Canonical backlog | One selected backlog outcome can become a Goal. | [`docs/backlog.md`](backlog.md) remains the ordered, reviewable source of truth; a mutable per-chat objective cannot replace backlog ownership or history. |

Codex therefore owns task, turn, goal, usage, approval, and archive state.
Nelos owns topology, work-unit identity, dependencies, attempts, receipts,
acceptance, cleanup, and lineage. The queen owns evidence-based synthesis.

### Where Goals could help

1. **Queen continuity.** A goal can keep a long-running queen focused on the
   accepted web outcome across automatic continuations and user steering.
   This could reduce premature final responses and manual “continue” turns.
2. **Durable-spinoff continuity.** A bounded goal derived from a work unit could
   help a spinoff continue until its verification criteria are satisfied.
   This is a later experiment because Desktop task creation starts the first
   turn before Nelos can safely attach a goal.
3. **Native operator visibility.** Users can inspect and control a task's goal
   through Codex instead of learning a parallel Nelos-only control.
4. **Content-free usage signals.** Token and elapsed-time counters may improve
   diagnostics and routing evaluation. They are observations, not proof of
   progress or success.

### Where Goals must not be used

- Do not encode the slice DAG, attempt state, receipts, acceptance records, or
  cleanup state in the objective.
- Do not treat `complete` as evidence that a work unit was accepted. Nelos
  still validates the current result and the queen still accepts it.
- Do not infer a token budget. Set one only from an explicit user limit or a
  separately reviewed product policy.
- Do not overwrite a pre-existing, user-authored goal. The current schema has
  no owner field, revision, or compare-and-set precondition.
- Do not let automatic continuation replay host effects. Every create, title,
  steer, send, archive, and goal mutation still needs a durable action identity,
  exact receipt, and uncertain-outcome reconciliation.
- Do not automatically put joined subagents in Goal mode. Their bounded joined
  lifecycle already has parent control, and independent auto-continuation could
  fight the native join contract or waste tokens.
- Do not assume a Goal grants permissions, network access, more context, a
  worktree, or a persistent cross-task subscription.

### Proposed ownership and mutation contract

For an opt-in pilot:

1. Read the existing goal before any mutation.
2. If a different goal exists, stop with attention; never replace it.
3. Render a concise objective from the queen outcome, constraints, and
   verification criteria. Keep detailed plans in Nelos records or checked-in
   files rather than approaching the 4,000-character limit.
4. Persist the expected objective digest and one goal-effect action ID before
   returning a host-owned `native-goal-set` effect.
5. Set without a token budget unless the user explicitly supplied one.
6. Read back the goal and require exact objective/status equality before
   claiming it is attached. A mismatch is attention, not a blind retry.
7. On a requirements-changing replan, propose a new goal only with an explicit
   receipt and disclose that replacing the objective resets native usage
   accounting.
8. Mark the queen goal complete only after all required current results are
   accepted and terminal cleanup policy is settled. Clearing a goal is a
   separate user-visible mutation.

This still leaves a native concurrency window because App Server provides no
goal revision or compare-and-set field. The pilot must document simultaneous
manual goal edits as unsupported and fail closed whenever preflight and
verification disagree.

### Experiments

#### Measurement definitions

Apply these definitions to G2 and to the default-adoption gate:

- An eligible web is a started low-risk web that satisfies the experiment's
  predeclared inclusion criteria. A completed web has every required current
  result accepted and terminal cleanup policy settled.
- One manual continuation is a user or maintainer turn whose sole purpose is to
  say continue, resume, or check again. Requirement changes, approvals,
  corrections, and new work are interventions, not manual continuations.
- Completion rate is `completed eligible webs / started eligible webs`.
  Completion gain is the Goal-cohort rate minus the matched-control rate,
  expressed in percentage points; “20-point” means 20 percentage points.
- Manual-continuation reduction is
  `(control mean per web - Goal mean per web) / control mean per web * 100%`.
  If the control mean is zero, this metric is inapplicable and the completion
  gain must satisfy the benefit gate.
- Token and elapsed-time regression are each
  `(Goal cohort median - control cohort median) / control cohort median * 100%`
  over eligible webs. A zero control median makes the corresponding cost gate
  fail rather than permitting division by zero.
- G2 uses the predeclared five-Goal/five-control matched window below. Default
  adoption uses 30 consecutive eligible Goal-enabled queen webs plus at least
  30 controls matched by slice-plan size, risk bucket, model route, permission
  policy, and release/Codex-version window. Exclusions and matching are fixed
  before outcomes are inspected.

#### G0 — Compatibility and contract

- **Input/procedure:** for every tested Codex binary, generate stable
  and experimental App Server schemas with Goals enabled and disabled into a
  disposable directory; record version and `codex features list`; diff only
  goal methods, types, notifications, and the current Nelos compatibility
  boundary. Send no live request and make no production fixture change.
- **Observable output:** a reproducible version/capability/field/nullability
  matrix plus proposed read/set/clear permission and audit classifications.
- **Pass/reject:** pass when tested versions have reviewed shapes, older or
  non-stable identities follow the minimum-version policy, newer stable
  versions retain strict response validation, and disabling Goals leaves
  existing Nelos tools intact; reject integration if capability negotiation is
  ambiguous or disablement breaks the current flow.

#### G1 — Disposable-task semantics

- **Input/procedure:** use fresh tasks in a temporary credential-free repo with
  `:workspace` or stricter permissions. Preflight/get, set, verify, pause,
  resume, reconnect/restart, resume/fork, archive/unarchive, and clear. Repeat
  with Goals disabled; empty, 4,000-, and 4,001-character objectives; invalid
  budgets; approval blocking; a dropped response; and a manual edit between
  preflight and verification. Never retry a timed-out mutation until readback
  proves it did not commit.
- **Observable output:** request/response/notification traces, validation
  results, counter changes, persistence and fork/archive behavior, and the
  reconciliation decision for every unknown outcome.
- **Safety/pass/reject:** no network, external app, secret, production repo,
  shared writer, or destructive action. Pass only with zero duplicate
  mutations and detected manual conflicts; reject if readback cannot reconcile
  an outcome, a user edit is overwritten, or pause/approval is bypassed.

#### G2 — Opt-in queen dogfood

- **Input/procedure:** run at least 10 matched low-risk webs (5 Goal, 5 control)
  after explicit opt-in. Attach only after the plan settles and before wave 1;
  retain all current receipt, acceptance, cleanup, permission, and one-writer
  gates; exercise pause, approval, and one requirements change; verify rollback
  by pausing/clearing and continuing through the current flow.
- **Observable output:** manual-continuation count, web completion, duplicate
  proposed/committed effects, tokens, elapsed time, attention latency, goal
  conflicts, interventions, and rollback success.
- **Safety/pass/reject:** non-release work, no inferred budget or goal
  replacement. Require zero duplicate committed effects, zero overwritten
  goals or safety violations, 100% rollback, and either at least 30% fewer
  manual continuations or at least a 20-percentage-point completion gain, with
  no more than 20% median token regression and no more than 20% median
  elapsed-time regression. Reject if a safety invariant fails or neither
  benefit threshold is met.

#### G3 — Durable-spinoff dogfood

- **Input/procedure:** only after G2 passes, run at least 6 opt-in isolated-
  worktree spinoffs from exact work-unit criteria through a documented
  race-free attach point; include one corrective follow-up and one rejected
  result.
- **Observable output:** attach timing, continuation count, counters, and
  separate callback/result/acceptance/goal/cleanup transitions.
- **Safety/pass/reject:** no joined agents, shared writers, inferred budgets, or
  cleanup based on goal status. Require zero attach races and duplicate effects
  and independently receipt-backed Nelos transitions; reject if no race-free
  attach point exists or Goal state changes Nelos authority.

### Adoption gates

Goals may become a default for eligible queens only when:

- user-authored goals are never overwritten;
- feature absence or disablement degrades to the current Nelos flow;
- automatic continuation produces zero duplicate native effects in fault and
  restart tests;
- pause, approval, blocked, usage-limited, and budget-limited states stop work
  as Codex specifies;
- requirements changes and usage-account resets are explicit and auditable;
- worktree and one-writer constraints remain enforced;
- dogfood shows a meaningful reduction in manual continuation or incomplete
  webs without an unacceptable token/time regression; and
- the setting has an immediate rollback path.

Default adoption additionally requires G0–G2 to pass, the defined 30-web Goal
window and matched controls, zero duplicate committed effects or
authority/worktree/approval violations, at least 95% verified attachment, 100%
fallback when Goals are absent, disabled, conflicting, or malformed, and the
same G2 benefit/cost thresholds. Reject default adoption if any safety
invariant fails, the benefit threshold is missed in that window, or median
token or elapsed-time regression exceeds 20%.

Until those gates pass, Goals are a promising native accelerator—not a missing
correctness primitive.

## 2. App Server protocol and compatibility

### Decision

**Adopt a narrow, versioned baseline and harden it before adding native
lifecycle operations.**

The accepted
[Codex App Server Compatibility Contract](app-server-compatibility-contract.md)
defines four separate profiles rather than one blanket compatibility claim:

- the strict MCP bridge has minimum Codex version `0.144.5`; one combined
  reduced fixture records `0.144.5`/Desktop `0.144.6` shapes, and the `0.4.0`
  release additionally revalidated the exact CLI npm distributions for both
  versions; newer stable versions are provisionally allowed behind the same
  response validators;
- the broader source CLI remains conditional explicit-development behavior
  until its methods, fields, and shared client receive the same attestation;
- under-development plugin methods are a best-effort installer optimization
  with a restart-required fallback; and
- verifier-only interruption does not enter the product contract.

The contract inventories every App Server method, transport, notification
assumption, and consumed schema-field group currently used by Nelos. It also
defines failure behavior for absent experimental APIs, missing permission
profiles, version/schema mismatch, dropped notifications, reconnects, and
unknown mutation outcomes.

### Adoption boundary

Nelos may retry a transport-failed read once. It may not blindly replay a
mutation after a timeout, disconnect, or malformed response. Current polling
does not become an event subscription, idle does not become result evidence,
and neither native resumable subscriptions nor title compare-and-set may be
claimed until upstream supplies a reviewed protocol.

The next bounded slice is executable contract hardening: per-version and
per-profile fixtures, one shared compatibility descriptor, shared-client
version/response validation, read-only reconnect behavior, error/uncertainty
classification, and negative compatibility tests. Task and turn lifecycle
semantics follow this foundation.

## Audit template for items 3–25

Each queued item should be expanded in place using the same structure:

1. **Decision:** adopt, pilot, defer, reject, monitor, or not applicable.
2. **Current Nelos overlap:** existing code, docs, tests, and known gaps.
3. **Official contract:** stable/experimental maturity, supported surfaces,
   permissions, limits, and citations.
4. **Local evidence:** versions, schema/help output, probes, and contradictions.
5. **Value hypothesis:** the robustness, performance, safety, or UX improvement.
6. **Authority boundary:** Codex-owned state versus Nelos-owned state.
7. **Failure and security model:** unknown outcomes, retries, approvals,
   concurrency, sensitive content, and rollback.
8. **Experiment:** the smallest non-default test with measurable baselines.
9. **Adoption gates:** evidence required before implementation or default use.
10. **Backlog effects:** bounded delivery slices, dependencies, and exclusions.

## Continuous closure

Re-run the inventory when a supported Codex version changes, the official
manual adds or renames a capability family, a current-session tool appears
without a documented classification, or a Nelos architecture decision starts
depending on undocumented host behavior.

The audit is intentionally allowed to say “no.” Exhausting Codex's capability
surface means making every relevant opportunity explicit and evidence-backed,
not making Nelos depend on every available feature.
