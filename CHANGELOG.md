# Changelog

All notable user-facing changes to Nelos are recorded here. Versions follow the
[release and compatibility policy](docs/release-policy.md).

## Unreleased

## [0.12.20] - 2026-08-25

### User-facing changes

- `nelos desktop-test --candidate PACKAGE_DIRECTORY --scenario-set release`
  now drives the release Desktop smoke lane through one fixed machine-local
  provider adapter.
- The lane verifies an immutable candidate digest, a clean disposable Desktop
  clone and account, the loaded plugin version and worker identity, allowlisted
  UI scenarios, bounded sanitized screenshot and diagnostic metadata, and exact
  clone destruction with an independent absence check.
- Reviewed Desktop scenario driving, developer screen capture, visual-state
  validation, archive-projection convergence, and plan-run-scoped execution-map
  projection are included in the distribution.

### Compatibility requirements

- The reusable Desktop template is no longer pinned to a Proxmox VMID, exact
  historical name, or per-release golden-image receipt. Provider-specific
  cloning and network mechanics live behind the trusted machine-local driver.
- Candidate packages must remain outside the controller's `CODEX_HOME`, and
  the installed and loaded version, digest, and source revision must exactly
  match the staged candidate.
- The Node.js and Codex compatibility requirements remain unchanged from
  `0.12.19`.

### Migrations

- Remove any release automation that invokes the retired protected validation,
  golden-builder, gateway-policy transaction, or one-model-turn contracts.
  Install a root-owned `/usr/local/libexec/nelos-desktop-test-driver` that
  implements the documented minimal operation protocol.

### Security fixes

- Desktop smoke results reject raw prompts, responses, transcripts, pixels,
  credentials, cookies, tokens, sealed values, and environment data. Cleanup
  ambiguity fails closed even when the primary scenario has already failed.

### Known limitations

- Nelos ships the provider-neutral controller and scenario contract. The
  machine-local driver remains an operator-maintained component because VM and
  Desktop automation differs between test farms.

## [0.12.19] - 2026-08-24

### User-facing changes

- Distribution installation now refuses to replace the Nelos plugin cache
  while any live Nelos worker is registered.
- The installer holds worker registration exclusion from runtime inspection
  through the completed cache transaction, closing the check-to-mutation race.
- MCP initialization now reports mixed active versions immediately, and the
  task workflow checks runtime health before every stateful Nelos operation.

### Compatibility requirements

- The distributable plugin identity advances to `0.12.19` for the runtime
  generation guard.
- Upgrades require quitting Codex completely, installing from an external
  terminal, relaunching Codex, and opening a fresh task. Opening a fresh task
  without the full shutdown does not retire sibling MCP workers.
- The Codex and Node.js compatibility requirements remain unchanged from
  `0.12.18`.

### Migrations

- No persisted-state migration is required. Use the full-shutdown upgrade
  sequence above before installing this release.

### Security fixes

- No security fixes.

### Known limitations

- Nelos cannot prevent an external host or third-party process from replacing
  plugin-cache bytes outside its installer. Runtime identity checks and the
  central mutation fence detect that condition and block stateful work until a
  complete restart.

## [0.12.18] - 2026-08-19

### User-facing changes

- Newer well-formed Codex semantic-version identities at or above `0.144.5`,
  including prerelease and build identities, now proceed as compatible but
  untested instead of rejecting otherwise valid completed planner results.
- Strict per-response validation remains in force: malformed identities,
  versions below the minimum, and incompatible response shapes still fail
  closed at the operation boundary.

### Compatibility requirements

- The distributable plugin identity advances to `0.12.18` for the corrected
  Codex app-server compatibility policy.
- The compatibility class was validated with Codex Desktop
  `0.148.0-alpha.9` on macOS and the ChatGPT Desktop Linux preview package
  `26.814.41957`, bundling Codex Desktop `0.148.0-alpha.15`, in an isolated
  disposable VM. These preview identities remain advisory and untested unless
  they are added to the fixture's exact tested-version list.

### Migrations

- No migrations.

### Security fixes

- No security fixes.

### Known limitations

- Compatible-but-untested identities can still encounter protocol drift;
  response validation will reject the affected operation rather than accept
  malformed evidence.

## [0.12.17] - 2026-08-17

### User-facing changes

- Added a versioned isolated-queen routing evaluation suite with fresh-task
  prompts covering Sol, Terra, Luna, low/medium/high/max effort, exact runtime
  verification, unique queen/workspace evidence, eight natural-language
  planning situations, and separately reported semantic challenges for the
  current coupled model/effort policy.
- Routing observations now grade task shape, profile, recommendation-versus-
  override provenance, and route-schema/policy/catalog versions in addition to
  requested-versus-observed model and effort.
- Live prompts bind the fresh task as the orchestration queen, require lazy
  plugin-tool discovery before an unavailable result, and preserve zero-worker
  preflight failures as explicit `attention` observations.
- Live prompt generation scopes durable work-unit IDs to a unique run by
  default, preventing retained execution records from colliding with reruns.
  Structured plans are rewritten directly, while natural-language scenarios
  require every generated action to carry the exact run suffix; `--run-id`
  keeps deliberate reconciliation reproducible.
- Failed-closed observations can retain workers with unavailable runtime routes
  as `null`, while creates that never return an identity remain visibly
  `launch-pending` instead of fabricating worker evidence.
- Joined-subagent launch verification now requires the receipt turn to equal
  the resolver's current native launch turn before accepting route evidence.

### Compatibility requirements

- The distributable plugin identity advances to `0.12.17` for the combined
  routing-evaluation and MCP visual-receipt distribution.

### Migrations

- No migrations.

### Security fixes

- No security fixes.

### Known limitations

- Automatic task-shape routing still selects only Sol/medium, Terra/low, or
  Luna/low. High and max are explicit-route probes until adaptive routing is
  implemented.

## [0.12.16] - 2026-08-15

### User-facing changes

- Orchestration checkpoints now clear a prior transient `Attention` state only
  when they contain affirmative running, completed, or accepted evidence.
  Fresh pending checkpoints preserve the warning until an observation resolves
  it.

### Compatibility requirements

- The distributable plugin identity advances to `0.12.16` for the corrected
  execution-map checkpoint projection.

### Migrations

None.

### Security fixes

None.

### Known limitations

None.

## [0.12.15] - 2026-08-13

### User-facing changes

- Replayed authoritative launch verification now clears transient `Attention`
  without regressing completed or accepted work back to `Running`.

### Compatibility requirements

- The distributable plugin identity advances to `0.12.15` for the corrected
  execution-map lifecycle projection.

### Migrations

None.

### Security fixes

None.

### Known limitations

None.

## [0.12.14] - 2026-08-13

### User-facing changes

- Current execution groups now open with a three-worker preview and an explicit
  `Show more` control for larger groups instead of hiding every non-attention
  worker behind a closed rollup.
- Execution rows use two stable lines: task name, worker kind, and status first;
  model, effort, and a Codex task deep link second. The parent context is now
  labeled `Objective`, and the widget has more outer padding.
- Planner subagents now advance from planning to running and complete with the
  native child lifecycle instead of remaining stale after plan finalization.
  When Codex exposes the child thread name, the execution row preserves and
  displays it across subsequent task-web updates.
- Fresh launch verification, execution refresh, and orchestration checkpoint
  observations can now clear transient `Attention` state at the same work-unit
  revision instead of leaving the visual status out of sync.
- Plan and action widgets now ignore unrelated host-global events, preventing a
  valid accepted/rejected result from being replaced by `Action result
  unavailable` after delivery.

### Compatibility requirements

- The execution-map URI advances to `ui://nelos/execution-map-v17.html` so hosts
  cannot reuse an older widget without the revised layout and native subagent
  name rendering.
- Plan-summary and action-receipt URIs advance to `plan-summary-v2.html` and
  `action-receipt-v3.html` to evict widgets containing the host-event race.

### Migrations

None.

### Security fixes

None.

### Known limitations

None.

## [0.12.13] - 2026-08-11

### User-facing changes

- MCP visuals now use purpose-built compact views: planning actions show a plan
  summary, worker-oriented actions show the execution map, and queen decisions,
  completion, and cleanup show a concise action receipt.
- Successfully dispatched and launch-verified workers render as `Running`
  instead of the less intuitive `Created`; legacy `created` projections remain
  readable.
- Visual loading copy is specific to the action. Delivered but non-renderable
  worker results now show `Worker status unavailable` instead of remaining on a
  misleading loading placeholder.
- Execution receipts keep the parent task visible, render a lone worker as a
  direct status-bearing row, and organize larger maps by user intent. The
  default `Current` view prioritizes `Needs input`, `In progress`, and `Queued`
  workers, while `Done` and `History` remain one click away. Outcome receipts
  explicitly label the affected work unit or cleanup scope.

### Compatibility requirements

- The execution-map URI advances to `ui://nelos/execution-map-v15.html`, and
  planning and outcome tools advertise the new `plan-summary-v1.html` and
  `action-receipt-v2.html` resources so hosts cannot reuse an incompatible
  cached widget.

### Migrations

None.

### Security fixes

None.

### Known limitations

None.

## [0.12.12] - 2026-08-09

### User-facing changes

- Nelos now ships the portable Agent Plugins v1 root layout (`plugin.json` and
  `mcp.json`) alongside the existing Codex plugin layout. Agent Plugins hosts
  launch the same bundled MCP server directly through `${PLUGIN_ROOT}`.
- Release validation and distribution provenance cover both layouts and fail
  when their versions, generated MCP identities, or packaged bytes diverge.

### Compatibility requirements

- The legacy `.codex-plugin/plugin.json` and `.mcp.json` layout remains
  available for codex-cli 0.144.6. The Agent Plugins v1 layout is the separate
  validation lane for codex-cli 0.147.0; this does not add 0.147.0 to Nelos's
  app-server compatibility registry.

### Migrations

None. Existing legacy marketplace installs remain supported.

### Security fixes

None.

### Known limitations

- The Agent Plugins layout does not resolve the legacy `${PLUGIN_ROOT}` host
  behavior tracked by issue #8; that layout continues to use its generated
  cache-locating bootstrap.

## [0.12.11] - 2026-08-07

### User-facing changes

- Execution-map members now render in independently collapsible status groups
  such as `Launch pending`, `Running`, `Complete`, and `Archive`, with exact
  per-status counts in every rollup.
- Expanded status groups use compact worker rows that keep lifecycle, model,
  reasoning, and the full native task identity available without letting task
  metadata dominate the receipt.
- Compatible updates in an active execution-map instance preserve expanded
  statuses and keyboard focus. A compact bulk control expands active statuses
  or collapses the full roster, with terminal-only receipts offering
  `Expand all`.
- Collapsed status markers now retain success, archive, and attention semantics
  using MCP Apps host theme tokens when available. Narrow and touch layouts get
  two-line task titles and larger disclosure targets without changing ordinary
  desktop row density.
- Receipt updates use a dedicated screen-reader status message instead of
  replaying the full task tree, and waiting or empty states now use valid
  non-list markup.
- The pinned MCP Apps reference-host runner now starts its sandbox on the
  origin expected by that host, so the documented visual fixtures load without
  a port override.

### Compatibility requirements

- The MCP Apps resource URI advances to `ui://nelos/execution-map-v11.html` so
  hosts do not reuse the first status-rollup widget from cache.

### Migrations

None.

### Security fixes

None.

### Known limitations

- Disclosure state remains local to one active UI instance. A new iframe or a
  receipt for a different task starts folded.

## [0.12.10] - 2026-08-05

### User-facing changes

- Execution-map receipts now keep canonical spider/web task titles after later
  plan updates and omit archived members from routine views.
- Added the read-only `nelos_execution_map_history` tool for explicitly loading
  the complete persisted roster. Current and archived members render in
  independently collapsible sections, with large groups folded initially.

### Compatibility requirements

- The MCP Apps resource URI advances to `ui://nelos/execution-map-v9.html` so
  hosts do not reuse the previous non-collapsible widget from cache.

### Security fixes

- Archived history remains durably persisted and inspectable; the default
  filter changes visibility only and never mutates lifecycle state.

## [0.12.9] - 2026-08-05

### User-facing changes

- Added an offline staged variance-acquisition planner for an insufficient-task
  confirmatory no-go. The first fixed tranche requests two new governed tasks
  per stratum and records exact trial, cost, and cumulative review ceilings.

### Compatibility requirements

- Calibration requirements are non-executable and cannot supersede the sealed
  no-go. Every provider-call tranche requires a separately implemented exact
  corpus schedule and fresh user authorization.

### Security fixes

- Calibration evidence is ineligible for comparative claims, and each tranche
  returns to zero calls before any re-estimation or escalation.

## [0.12.8] - 2026-08-04

### User-facing changes

- Added a create-only offline reducer that independently verifies the signed-in
  pilot report and normalizes it with the API canary's sealed trial evidence for
  the paired task-level confirmatory power gate.
- The power decision CLI can now retain its exact authorization or no-go result
  as an immutable operator artifact.

### Compatibility requirements

- Confirmatory authorization still requires both eligible calibration phases
  and the independently powered task floor in every critical stratum. Repeated
  blocks for one task never count as independent tasks.

### Migrations

- None. Existing experiment stores and research packets remain unchanged.

### Security fixes

- The reducer fails closed on altered signed-in reports, incomplete API trial
  sets, missing provider receipts, duplicate observations, and route mismatch.

## [0.12.7] - 2026-08-04

### User-facing changes

- MCP workers now register PID-reuse-safe cooperative leases with exact runtime
  identity, parent identity, bounded heartbeats, and lifecycle state. Legitimate
  same-generation concurrency remains healthy; mixed live generations are
  reported and fenced without process-name scanning or sibling termination.
- MCP initialization and the task-management skill now require a read-only
  runtime-health preflight before the first stateful operation. Owner clients
  may request `config/mcpServer/reload` and verify their own children closed;
  host-owned siblings still require a full Codex restart and fresh task.
- This first release carrying worker leases cannot retroactively register
  workers loaded from an earlier release. Perform one manual full Codex restart
  after upgrading into this release.

- Added `nelos_runtime_health`, a read-only tool that reports whether the
  loaded Nelos worker is still the installed plugin generation. A marketplace
  upgrade replaces the plugin cache while an already-loaded worker keeps
  serving the JavaScript it imported at startup; this reports that condition
  and names a single recovery action instead of leaving it undetectable.
- Every worker now derives an immutable runtime identity at startup from
  `package.json`, `.codex-plugin/plugin.json`, `.mcp.json`, and
  `distribution-provenance.json`, and reports a disagreement between them
  rather than trusting the self-reported MCP version.

### Compatibility requirements

- Identity comparison uses the exact source revision and distribution
  integrity digest. A release built without a source revision can only report
  `degraded` for an exact-match check, never `healthy`.
- Workers loaded from releases earlier than `0.12.7` do not derive a runtime
  identity and cannot report their generation retroactively. Detecting a stale
  worker from one of those releases still requires restarting Codex.

### Migrations

- Stateful calls are now fenced by runtime identity and cooperative live-worker
  generation. Existing persisted task/web data requires no migration.

### Security fixes

- None.

## [0.12.6] - 2026-08-04

### User-facing changes

- Added the API-controlled direct Codex repeat-arm canary with exact route,
  pricing, grading, and research-packet provenance.
- Added bounded multi-turn Responses support with durable per-exchange receipts,
  zero transport retries, and fail-closed output, request, and cost ceilings.

### Compatibility requirements

- The API pilot is bound to Codex CLI `0.146.0`, `gpt-5.6-sol`, medium
  reasoning, and the standard/default OpenAI service tier.

### Migrations

- None. API canary bundles and run stores use a new versioned identity and must
  be created fresh.

### Security fixes

- Provider exchanges are persisted before completion reaches Codex and retain
  no credentials, authorization headers, request bodies, or hidden grader data.

### Known limitations

- The four-trial repeat-arm canary validates instrumentation only; it does not
  authorize a comparative performance claim or a confirmatory study.

## [0.12.5] - 2026-08-03

### User-facing changes

- Added an isolated signed-in Codex pilot harness with bounded execution,
  correlated telemetry, and sealed report verification for confirmatory
  experiment calibration.
- Clarified the starter corpus candidate contract so every task family defines
  the exact deterministic transformation expected by its hidden grader.

### Compatibility requirements

- The recorded signed-in calibration uses Codex CLI `0.146.0` inside a
  dedicated unmounted ARM64 Linux VM; API-controlled comparisons remain a
  separate follow-up phase.

### Migrations

- None. The regenerated starter corpus release has new content-addressed task,
  package, and release identities.

### Security fixes

- Pilot attempts use fresh homes and workspaces with no development-state
  mounts, and retain fail-closed route, evidence, and contamination checks.

### Known limitations

- The 20-trial signed-in run calibrates the harness only. Fixed arm order and
  two replicates are insufficient for confirmatory product or efficiency
  claims; the next design must counterbalance order and increase sample size.

## [0.12.4] - 2026-08-03

### User-facing changes

- Queen and durable spinoff titles now use permanent compact hexadecimal
  lineage such as `👑B8`, `🕷️B8.1`, and `👑B8.1` for a nested queen.

### Compatibility requirements

- Legacy spaced and dual-marker titles remain readable and normalize during
  authorized synchronization; joined-subagent title behavior is unchanged.

### Migrations

- The first allocation seeds atomic top-level and per-parent high-water marks
  from all recognized historical web and task records without renumbering them.

### Security fixes

- Archived, concurrent, interrupted, and replayed allocations can no longer
  duplicate or reuse a top-level or child lineage ID.

### Known limitations

- Compact IDs are machine-local human-facing labels; native Codex thread IDs
  remain the authoritative global identity.

## [0.12.3] - 2026-08-03

### User-facing changes

- Added public fail-closed RuntimeLock admission, isolated candidate
  preparation, and content-addressed upgrade and rollback approvals.

### Compatibility requirements

- Admission requires an exact recursively immutable active lock, supported
  Codex build, trusted signer identities, immutable references, and one exact
  plugin copy before secrets or writable workspaces can attach.

### Migrations

- None. Existing RuntimeLock v1 fixtures remain valid; callers adopting the
  admission controller must supply closed pre-attachment observations and
  fresh disjoint writable roots.

### Security fixes

- Shallow-frozen locks, mutable references, identity drift, missing or
  duplicate plugin copies, shared candidate state, cross-lock canaries, and
  incompatible rollback state now fail closed.

### Known limitations

- Artifact acquisition and platform-specific attachment remain adapter-owned;
  adapters must return the exact closed receipts verified by the controller.

## [0.12.2] - 2026-08-03

### User-facing changes

- Governed corpus revisions now recompute deterministic exact-prompt and
  near-token duplicate groups for the complete active membership.

### Compatibility requirements

- Task packages and grading admit only sealed tasks. Corpus successors require
  an exact active predecessor, a single contiguous revision, replacement of
  that predecessor, and one successor per predecessor.

### Migrations

- None. Rebuild any locally authored successor release so its duplicate
  analysis and starter-corpus identities reflect the hardened admission rules.

### Security fixes

- Draft, retired, and invalidated tasks can no longer reach packaging or
  grading, and forged revision jumps or stale duplicate evidence fail closed.

### Known limitations

- Near-duplicate analysis is deterministic token Jaccard evidence; semantic
  similarity outside that declared method still requires curator review.

## [0.12.1] - 2026-08-03

### User-facing changes

- Multi-wave durable plans now continue through the governed cleanup and
  authorization protocol instead of returning to the completed prior wave.

### Compatibility requirements

- Plan-run records accept legacy files without cleanup progress and persist new
  cleaned-wave indexes as ordered, verified, spin-off-only progress.

### Migrations

- Existing plan-run records are normalized with an empty cleaned-wave list on
  read; no manual state migration is required.

### Security fixes

- Next-wave authorization remains bound to the exact plan run, wave index,
  digest, and member set, and stale or partial receipts continue to fail closed.

### Known limitations

- Cleanup authorization replay remains explicit and host-owned; operators must
  execute the returned authorization effect before a dependent wave can launch.

## [0.12.0] - 2026-08-03

### User-facing changes

- Added a durable experiment fleet control plane with exact worker admission,
  bounded weighted-fair queues, quotas, reservations, fenced leases, health
  management, deterministic shard merge, replaceable storage, and recovery
  verification.

### Compatibility requirements

- Fleet scheduling preserves existing experiment, evidence, artifact, and
  result bytes and identities. Shards with mismatched experiment, corpus,
  runtime, collector, grader, or plan provenance fail closed.

### Migrations

- None. Existing single-run and CI-gate entry points remain valid; fleet
  coordination is an additive exported contract.

### Security fixes

- Lease loss now fences new effects and requires reconciliation before retrying
  ambiguous mutations; contaminated or clock-anomalous workers are quarantined.

### Known limitations

- Durable fleet deployments still require operators to provide a shared
  immutable object-store adapter and external worker infrastructure.

## [0.11.0] - 2026-08-03

### User-facing changes

- Added one experiment CI workflow family for offline contracts, pull-request
  smoke, scheduled regression, powered studies, release canaries, and fenced
  dedicated Desktop lifecycle validation.
- Added deterministic gate contracts for sharding, bounded execution, immutable
  caches, terminal evidence retention, and exact release provenance.

### Compatibility requirements

- Pull-request contract tests require neither model credentials nor live
  network; powered lanes use isolated homes and explicit task, repetition,
  concurrency, and start budgets.
- Release canaries bind exact Codex, plugin, source, runtime-lock, schema, and
  compatibility identities. Dedicated Desktop jobs remain limited to labeled
  self-hosted macOS workers.

### Migrations

- Existing dedicated Desktop automation moves from
  `dedicated-desktop-experiment.yml` into the `experiment-ci.yml` workflow
  family without changing its fenced lifecycle runtime.

### Security fixes

- Infrastructure failures, interruptions, and incompatible provenance cannot
  be reported as product success or regression, and budget exhaustion retains
  all terminal evidence collected before new work stops.

### Known limitations

- Powered studies still require explicitly provisioned runtime credentials and
  infrastructure; offline and smoke fixtures do not establish live-model
  quality.

## [0.10.0] - 2026-08-03

### User-facing changes

- Added deterministic experiment metric accounting, paired and task-cluster
  statistical comparisons, sealed promotion decisions, Markdown reports, and a
  standalone exact-recomputation verifier.

### Compatibility requirements

- Reporting consumes the complete digest-bound plan and immutable attempt set;
  duplicate or missing trials, provenance mismatches, asymmetric invalidity,
  contamination, and route mismatch fail closed.

### Security fixes

- Failed, partial, retried, invalid, censored, and timed-out attempts can no
  longer disappear from aggregate accounting or pass decisions.

## [0.9.0] - 2026-08-03

### User-facing changes

- Added a deterministic resumable experiment runner API and
  `nelos-experiment` CLI with stable matrix expansion, seeds, trials, and
  content-addressed run bundles.
- Added direct Codex and Nelos adapter contracts with fenced scheduling,
  cancellation, retry, reconciliation, and generation-based resume.

### Compatibility requirements

- Runner inputs, adapter identities, budgets, and provenance are immutable for
  an existing run identity; conflicting reuse fails closed.
- Resume trusts only verified terminal attempts and schedules unfinished work
  under a new generation without overwriting prior evidence.

### Migrations

- Experiment automation can adopt the `nelos/experiment-runner` export or the
  `nelos-experiment` CLI while keeping existing runtime and evidence adapters.

### Security fixes

- Finalization rejects incomplete, mismatched, partially evidenced, or
  ambiguously dispatched attempts instead of producing a successful bundle.

### Known limitations

- Fleet-scale experiment operations remain a follow-on milestone.

## [0.8.0] - 2026-08-03

### User-facing changes

- Added correlated experiment evidence collectors, append-only stream ledgers,
  complete task-web accounting, and reproducible attempt manifests.
- Added atomic content-addressed artifact storage with classification,
  redaction, access control, and retention policy enforcement.

### Compatibility requirements

- Evidence producers must emit the versioned measurement, operational, or
  audit stream contracts and preserve every required correlation identity.
- Attempt verification now fails closed on incomplete, altered, duplicated,
  unauthorized, incompatible, or cross-run evidence.

### Migrations

- Experiment integrations should adopt the `nelos/experimentation-evidence`
  export and store artifacts through the governed artifact interface.

### Security fixes

- Secret-bearing inline collector payloads are rejected, sensitive artifacts
  are redacted or quarantined, and reads require an authorized classification.
- Broken chains, missing terminals, sink loss, clock uncertainty, and excessive
  observer overhead are surfaced as unhealthy evidence.

### Known limitations

- The evidence layer records and verifies attempts; the integrated resumable
  runner and reporting surfaces remain follow-on milestones.

## [0.7.0] - 2026-08-03

### User-facing changes

- Added a hermetic headless worker lane with per-attempt filesystem, process,
  resource, credential, network-phase, cancellation, artifact, and cleanup
  isolation.
- Added a fenced dedicated macOS Desktop worker contract with exact target
  admission, signed golden-image lifecycle operations, quarantine, reimage,
  rollback, and protected automation.

### Compatibility requirements

- Headless infrastructure adapters must attest the exact admitted worker and
  phase policy digests and return fenced cancellation and destruction receipts.
- Desktop lifecycle automation must run on a dedicated registered host, use the
  protected default-branch driver, and match the exact lease, process, socket,
  plugin lock, and signed golden image.

### Migrations

- Runtime-lane deployments must implement the documented headless engine or
  dedicated Desktop adapter contracts before enabling experiments.

### Security fixes

- Developer homes, Codex state, credentials, sessions, sockets, worktrees, and
  mutable caches are rejected from disposable headless attempts.
- Desktop mutations fail closed on development-state reachability, target or
  plugin drift, stale fencing, unexpected tasks, crash loops, and ambiguous
  lifecycle receipts.

### Known limitations

- The repository ships admission and lifecycle contracts; operators still
  provide and harden the underlying OCI, disposable-VM, or dedicated macOS
  infrastructure.

## [0.6.2] - 2026-08-03

### User-facing changes

- Cleanup can archive independently accepted spin-offs even when another
  required member of the same wave remains unaccepted.

### Compatibility requirements

- Cleanup responses can include both archive effects and an exact `pending`
  list; after receipts settle, the state remains `not-ready` for those pending
  members.

### Migrations

- No migration is required. Existing cleanup records remain replayable and
  retain their snapshotted policy.

### Security fixes

- Failed, blocked, detached, stale, unaccepted, and archive-incapable work
  remains ineligible while accepted siblings are cleaned independently.

### Known limitations

- An incomplete wave cannot advance until every required member is accepted;
  this change only prevents accepted task cleanup from being unnecessarily
  coupled to that gate.

## [0.6.1] - 2026-08-03

### User-facing changes

- Aligned structured planning and exception replanning size limits so every
  valid plan up to the 64 KiB plan ceiling can enter the bounded one-generation
  exception workflow.

### Compatibility requirements

- Planning context now accepts up to 128 Ki characters; generated exception
  context remains independently bounded to 128 KiB of UTF-8.

### Migrations

- No migration is required. Existing plan runs retain their exact identities
  and completed-slice preservation rules.

### Security fixes

- Oversized and malformed exception-replanning plans are rejected before any
  planner task can launch.

### Known limitations

- Exception replanning remains limited to one generation.

## [0.6.0] - 2026-08-03

### User-facing changes

- Added immutable governed experiment task packages and a reproducible starter
  corpus spanning ten task families with seven deterministic machine outcomes.
- Added host-isolated hidden grading, contamination controls, semantic corpus
  revision tooling, release locks, and public experimentation-corpus exports.
- Bound grader, task, package, and corpus identities to a recursive manifest of
  the complete shipped grader implementation and its local contract modules.

### Compatibility requirements

- Task packages now fail closed when their grader identity does not match the
  exact installed implementation. Regenerate packages after grader or local
  experimentation-contract module changes.

### Migrations

- Existing development corpus packages must be rebuilt with
  `npm run corpus:build` before grading under `0.6.0`.

### Security fixes

- Candidate-visible and hidden grader assets may not reuse the same digest,
  preventing hidden-oracle bytes from crossing audience boundaries.

### Known limitations

- The bundled corpus is an offline starter release; additional task families
  require the documented governed semantic-revision workflow.

## [0.5.3] - 2026-08-03

### User-facing changes

- Persisted web-backed joined subagents as durable work units so accepted
  review results can satisfy later spin-off dependencies after restart.
- Added an idempotent legacy reconciliation path: successful launch-batch
  verification adopts previously omitted joined members into the execution
  web, while later waves stop with the exact missing dependency IDs until the
  repair is completed.
- Made queen decisions validate the complete dependency graph before writing
  acceptance state, so an unknown dependency cannot partially advance a
  correction attempt.
- Allowed a completed spin-off cleanup call to consume the exact next-wave
  launch authorization receipt it requested.

### Compatibility requirements

- `nelos_launch_verify_batch` is now non-read-only and idempotent because a
  successful call may persist a verified joined-member binding.
- `nelos_spinoff_cleanup` accepts the optional, backward-compatible
  `launchAuthorization` receipt used by its next-wave execution gate.

### Migrations

- Existing webs stopped by `missing-persisted-dependency-work-units` should
  replay exact launch-batch verification for the named joined members. Nelos
  revalidates their native identity and adopts their binding without relaunch.

### Security fixes

- No security fixes.

### Known limitations

- No new known limitations.

## [0.5.2] - 2026-08-03

### User-facing changes

- Reduced state-lock contention overhead by memoizing the current process
  identity for the process lifetime and bounding repeated owner identity
  lookups while preserving stale-lock replacement revalidation.

### Compatibility requirements

- No compatibility changes.

### Migrations

- No migrations.

### Security fixes

- No security fixes.

### Known limitations

- No new known limitations.

## [0.5.1] - 2026-07-31

### User-facing changes

- Published the 0.5 milestone with a fresh plugin version and cache identity
  after correcting the authoritative Codex App Server source mapping from the
  retired `protocol/v2.rs` path to `protocol/v2/mod.rs`.
- Preserved all verified 0.5.0 candidate behavior while ensuring exact-source,
  generated-schema, and runtime-transport release evidence agree on the public
  compatibility contract. The `v0.5.0` candidate tag was never released.

### Migrations

- Upgrade existing `0.4.0` marketplace installs directly to `0.5.1`, restart
  Codex, and create a fresh task before verifying the loaded skill and MCP
  server.

## [0.5.0] - 2026-07-31

### User-facing changes

- Bumped the distributable plugin to `0.5.0` and added deterministic cache
  identity plus exact source-repository, source-revision, and payload-integrity
  provenance to installed copies and release artifacts.
- Added stale-payload validation, legacy-to-candidate upgrade coverage, and a
  source-distribution uninstaller that removes every Nelos-owned historical
  cache, skill, source, launcher, marketplace, and state location.
- Added a real isolated Codex Git-marketplace upgrade gate that installs the
  legacy payload, refreshes and installs `0.5.0`, restarts the app-server,
  creates a fresh task, and verifies candidate skill, MCP, cache, and provenance
  bytes while preserving unrelated data.

- Added a published-release promotion workflow for the
  `marketplace/stable` Codex marketplace channel, with immutable-release
  validation and fast-forward-only updates.
- Added conversational installed-plugin configuration through the bundled
  `nelos_config_get`, `nelos_config_set`, and `nelos_config_reset` MCP tools.
- Added `nelos_web_inspect`, a bounded read-only MCP workflow that combines
  persisted work-unit bindings, orchestration state, paged native task status,
  direct-parent topology, and content-free bridge health without exposing
  prompts, turns, transcripts, result text, or filesystem paths.
- Reduced the bundled skill to task-planning and coordination policy.
  Configuration and web inspection now route directly through MCP tool
  metadata and schemas.
- Added a machine-local TOML configuration file at
  `$XDG_CONFIG_HOME/nelos/config.toml`, falling back to
  `~/.config/nelos/config.toml`. Repository-local `.nelos/` configuration is
  intentionally ignored.
- Changed the built-in spin-off cleanup policy from `ask` to `auto`. Users can
  globally choose `auto`, `ask`, or `keep`; changing or resetting that global
  preference requires an explicit user request.
- Cleanup now snapshots its effective policy for the whole web when terminal
  cleanup begins, so later global changes affect future webs without changing
  an archive or confirmation sequence already underway.
- Added a deterministic execution gate for planned waves. Nelos now emits
  `launch-wave` only after the native host authorizes every exact launcher,
  task kind, workspace mode, model, reasoning route, and task creation.
- Authorization proposals now include a typed host effect backed by the
  `nelos_launch_authorize` receipt producer, preventing installed Desktop flows
  from stopping without a way to complete the authorized replay.
- Added an inline MCP Apps execution map for planning and dispatch receipts.
  It shows each task's lifecycle, exact model, reasoning level, and whether the
  task is planned, launch-pending, or created as an individual worker card.
- Extended the execution map to spin-off cleanup. Outstanding archive effects
  render as `archiving`; accepted native archive receipts produce a terminal
  update with worker identities, model, reasoning level, task ID, and a muted
  archived state. Aggregate counts remain in structured output without being
  duplicated in the visual.
- Refined execution-map semantics and spacing: attention now uses an amber
  review-needed treatment, while the redundant internal header and global phase
  pill are no longer rendered above worker statuses.
- Moved each worker status beside its title, shortened joined-worker lifecycle
  metadata to neutral `Sub-agent`, and added a reduced-motion-safe pulse for
  active work.
- Added an app-server-backed execution-map refresh receipt so a completed
  native turn produces a terminal visual update instead of leaving the latest
  visible worker at launch-pending.
- Published exact MCP output schemas for every protocol-producing tool,
  including the complete discriminated `nextAction` union, and made nonvisual
  protocol results available as model-visible `structuredContent`.
- Added pinned official MCP Inspector commands for interactive inspection and
  automated capability, app-binding, resource, valid-call, and invalid-input
  verification of the execution map.
- Added a deterministic nine-state visual fixture server and a pinned build of
  the official MCP Apps reference host, giving the component repeatable
  protocol, sandbox-readiness, and connected-browser test lanes.

### Compatibility requirements

- `NELOS_CONFIG` and `XDG_CONFIG_HOME`, when set, must be absolute paths.

### Migrations

- Upgrade existing `0.4.0` marketplace installs by refreshing the marketplace
  and reinstalling `0.5.0`, then restart Codex and create a fresh task. Source
  distribution users may rerun the unified installer; committed upgrades prune
  stale Nelos cache versions without touching other plugins.

- Existing exact-tag marketplace installs remain pinned. Users can opt into
  stable-channel upgrades by removing and re-adding `nelos-marketplace` with
  `--ref marketplace/stable`, then reinstalling the plugin.
- The first configuration read migrates an exact valid legacy remembered
  cleanup preference into TOML and removes the legacy file. Invalid or unsafe
  legacy state fails closed.
- Reset removes both the TOML override and any legacy preference, restoring the
  built-in `auto` default.
- Planning callers should start with `launchAuthorization: null`, then replay
  the unchanged request with the exact `native-launch-authorization` receipt
  returned by the host. Missing or partial evidence no longer permits fallback
  execution.

### Security fixes

- Configuration now uses a pinned standards-compliant TOML parser, strict
  schema validation, bounded regular-file checks, private atomic writes, and a
  machine-local interprocess lock.
- Project-controlled configuration is not consulted for global cleanup
  behavior, preventing an opened repository from silently changing that
  machine-level preference.

### Known limitations

- Nelos does not yet provide a custom Codex Settings pane or MCP settings form.
  Conversation is the primary interface, with TOML available for manual edits;
  no Nelos-specific slash command is provided.
- The execution map renders only in MCP Apps-compatible hosts. Other clients
  continue to receive the complete text/JSON tool result.
- The map is a point-in-time receipt, not a broad live Desktop-state dashboard.

## [0.4.0] - 2026-07-28

### User-facing changes

- Added bounded four-state bundled MCP diagnostics to the doctor and
  distribution verifier.
- Added release and compatibility policy, community-health files, and
  repository contribution templates.
- Added a tag-only workflow that verifies release candidates on macOS and
  Linux, creates reproducible package artifacts with checksums and provenance,
  emits a CycloneDX SBOM, and opens a draft GitHub Release for maintainer
  review.
- Newer stable Codex versions are no longer rejected solely because they have
  not yet been tested. MCP health output distinguishes tested versions from
  provisionally compatible, untested versions.
- Added an ordered audit of 25 Codex capability families, including a bounded
  opt-in pilot contract for native Goals and explicit adoption decisions
  separate from implementation status.
- Added a versioned Codex App Server compatibility contract covering authority,
  profiles, transports, consumed schemas, notifications, privacy boundaries,
  retry behavior, and failure handling.

### Compatibility requirements

- Node.js 20 or newer on macOS or Linux.
- Codex `0.144.5` or newer. Codex `0.144.5` and `0.144.6` are the exact tested
  versions; newer stable versions may proceed provisionally and are reported as
  untested until their protocol surface is reviewed.
- Isolated `codex-cli` `0.144.5` and `0.144.6` release checks generated
  identical schemas for every App Server method Nelos consumes and exercised
  initialization, Unix-socket transport, task creation, two same-task turns,
  readback, archival, and cleanup. This CLI revalidation is additional to the
  recorded Codex Desktop `0.144.6` plugin/MCP dogfood smoke.

### Migrations

- Existing Fraktik installations must remove the `fraktik@fraktik` plugin and
  marketplace before installing `nelos@nelos-marketplace`; the renamed plugin
  identity is not migrated in place.
- Existing Nelos development-snapshot users should install the marketplace at
  Git ref `v0.4.0`, reinstall the plugin, restart Codex when requested, and open
  a fresh task.

### Security fixes

- None.

### Known limitations

- Windows remains unsupported.
- Codex versions newer than `0.144.6` are provisionally compatible but remain
  untested until their consumed App Server surface is reviewed.
- Native Goals integration remains an opt-in pilot proposal, not a default or
  a correctness dependency.

<!--
Release automation should preserve the Unreleased section above and copy this
structure for each release:

## [VERSION] - YYYY-MM-DD

### User-facing changes

- None.

### Compatibility requirements

- Exact supported Codex versions and exercised surfaces.
- Supported operating systems and Node.js requirement.

### Migrations

- None.

### Security fixes

- None.

### Known limitations

- None.

Replace every "None" that applies; keep "None" when there is no entry.
-->
