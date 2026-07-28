# Nelos Full-Angle Dogfood and Stress Test — 2026-07-27

Environment:

- Queen thread: `019fa374-a04d-78b1-854c-a98b1d10c3c2`
- Installed Nelos plugin: `0.4.0+codex.20260726021006`
- Codex app-server: `0.144.6`, ready and compatible
- Repository branch: `fix/mcp-host-owned-effects`
- Baseline commit: `a94655fa6a67caf3d691b4e2edad219f68082d25`
- Worker baseline and final status: clean

This run used the installed Nelos skill and MCP tools plus native Codex
collaboration and task controls. It did not use the optional Nelos CLI.

## Scenario Matrix

| ID | Area | Result | Live evidence |
| --- | --- | --- | --- |
| F1 | Fresh-thread discovery and bridge health | Passed | Plugin skill loaded from the versioned cache; app-server reported ready, compatible, zero failures |
| F2 | Planner interrupted-turn reconciliation | Passed | Three live planners initially appeared `interrupted`; each returned bounded retryable `native-wait-subagent` instead of false failure |
| F3 | Agent-path-only exact-turn resolution | Passed | Resolver accepted only parent plus canonical agent path and derived the exact current launch turn |
| F4 | Single Terra joined-subagent route | Passed | Terra/low launch resolved and batch-verified with `title: not-applicable` |
| F5 | Three-member parallel joined wave | Passed | All three Sol/medium identities, parents, turns, and routes batch-verified atomically |
| F6 | Nested parallel joined identities | Passed | Two child paths remained distinct and exact-turn verification succeeded |
| F7 | Redundant joined parent evidence | Passed rejection | Batch rejected a subagent receipt that reported a member-level parent |
| F8 | Wrong exact turn | Passed rejection | One altered turn made the entire batch fail closed with `route-verification-unavailable` |
| F9 | Duplicate native identity | Passed rejection | Both duplicate members failed identity before read, topology, title, or route checks |
| F10 | Luna joined-subagent route | Passed rejection | Both plan validation and lower-level orchestration rejected Luna before launch |
| F11 | Planner replay and idempotency | Passed | Exact result-receipt replay retained the same bootstrap, plan run, and wave; no duplicate planner |
| F12 | Timeout versus failure | Passed | A native wait timeout remained running/unknown and produced a new cursor-bound wait action |
| F13 | Blocked, failed, unavailable, stale states | Passed | Focused suites kept every state distinct; 40/40 receipt/result tests passed |
| F14 | Durable Luna spinoff creation | Passed | Two real Luna/low isolated-worktree tasks were created and bound by exact thread ID |
| F15 | Durable title at creation | Failed expectation | Codex started tasks as `Run F8.1 durable smoke` and `Run F9.1 durable smoke`; exact spider/web titles required post-launch repair |
| F16 | Durable callback wake | Passed | Both spinoffs called `nelos_spinoff_complete` and delivered a wake to the queen |
| F17 | Missing `read-result` capability | Passed rejection | Observe-only F8.1 stopped at `member-evidence-requires-review`; no result read was fabricated |
| F18 | Durable exact result read | Passed | F9.1 advanced through title, timeout, terminal wait, exact-turn read, and `all-required-results-current` |
| F19 | Queen acceptance persistence | Failed — missing MCP surface | The join returned `decide`, but no exposed Nelos MCP tool can record the queen decision |
| F20 | Cleanup gating | Passed fail-closed behavior | F9.1 cleanup returned `not-ready`; no archive effect was emitted without persisted acceptance |
| F21 | One-generation exception replan | Passed | Typed blocked evidence launched a verified Sol/medium planner and preserved completed slices |
| F22 | Replan reuse of completed agent path | Failed route contract | Reused path resolved the new turn correctly, but the follow-up ran Sol/high instead of required Sol/medium |
| F23 | Repository preservation | Passed | Worker pre/post status and diffs were clean at the baseline commit |

## Live Durable Tasks

### F8.1 — capability-boundary probe

- Thread: `019fa37e-eb41-7fb2-a1fd-1d2ca4f2af96`
- Turn: `019fa37e-ec5f-7580-973d-a01031497ca9`
- Final title: `🕷️F8.1 Durable smoke`
- Route: Luna/low
- Result: succeeded worker turn, but intentionally uncollected because the work
  unit declared only `observe`
- Cleanup: ineligible

### F9.1 — complete durable join probe

- Thread: `019fa381-57b5-7ff1-8aa7-7b05e57b6e68`
- Turn: `019fa381-58c0-7851-8a58-e9afcade681c`
- Final title: `🕷️F9.1 Full durable smoke`
- Route: Luna/low
- Result: current succeeded envelope, coordination state `collected`
- Boundary: `decide` / `all-required-results-current`
- Cleanup: `not-ready` because no MCP acceptance operation is exposed

Neither task was archived. That is intentional: the installed skill forbids
archiving unaccepted work, and the missing MCP acceptance step prevents these
tasks from becoming cleanup-eligible without falling back to the CLI.

## Findings

### D3 — Queen result acceptance is not wrapped by MCP

The implementation contains durable native-result acceptance, but the installed
MCP surface exposes creation, observation, completion, and cleanup without an
accept/reject tool. The real lifecycle therefore stops at:

1. result is exact, current, and succeeded;
2. join returns `decide`;
3. queen judges that acceptance criteria are met;
4. no MCP action can persist that decision;
5. cleanup correctly remains `not-ready`.

This is the most important gap because it makes the documented MCP-only durable
workflow incomplete and pressures agents to discover or use the optional CLI.

### D4 — Replan reuses an agent path without preserving its route

The generation-1 replan reused
`/root/nelos_routing_identity_matrix_62a51576`. A new turn was correctly
resolved—proving the exact-turn fix—but Codex ran the follow-up at Sol/high
instead of the required Sol/medium. Batch verification stopped with
`exact-route-mismatch`.

The replan should either generate a fresh joined-subagent task name or the
native follow-up control must accept and preserve the exact model/effort.

### D5 — Durable tasks do not receive the contract title at creation

The current Codex `create_thread` control has no title argument. A `Task title:`
prompt seed produced a readable auto-title but did not preserve the spider
emoji, full web ID label, or exact requested title. Nelos recovered by observing,
renaming, and verifying the title, but the task did not start with the desired
presentation.

### D6 — Capability omission fails closed as designed

F8.1 declared only `observe`. Terminal evidence therefore produced attention
instead of a result-read effect. This is not a defect; it is useful evidence
that capabilities are enforced and missing authority is never inferred.

## Regression Evidence

- Exact current-turn route verification passed for new launches and for a new
  turn on an existing agent path.
- Joined subagents never used Luna.
- Joined identities stayed `agentPath`-first and were never renamed.
- Durable spinoffs used thread IDs and native task controls.
- Invalid batches blocked atomically before result reads.
- Planner interrupted observations reconciled without false failure.
- Focused receipt and lifecycle suites reported 40/40 and 46/46 passing.
- The final full repository suite passed 508/508.
- The report is stored outside the shipped distribution entries, preserving the
  recorded plugin integrity digest
  `sha256:4023bdf76f932fdd1d741e198b2fe38f26d72382f29deec606df3cfbd8d6350d`.
- No worker changed repository files or contacted external services.

## Remediation and Post-Install Smoke

The remediation commits were integrated and released locally as
`0.4.0+codex.20260727175748`.

- Queen/web title synchronization: integrated.
- MCP queen acceptance: integrated.
- Fresh joined identity on exception replan: integrated.
- Joined routing and capability hardening: integrated.
- Full repository suite: 521/521 passing.
- Distribution, planning lifecycle, app-server, and golden-loop verification:
  passing.

The first post-install task,
`019fa4bd-0e0e-7550-b52d-5b2003450c43`, loaded the new skill version but its
per-thread capability snapshot exposed no Nelos MCP tools. A second turn with
explicit deferred discovery produced the same result. It made no lifecycle or
repository changes.

A control attempt from the original queen could discover Nelos tools, but its
live MCP response matched the pre-reinstall server contract: it omitted the
new persisted `webIdentity` and `queenTitleSync.webId`, kept
`👑 · Clarify CLI and MCP roles (6)`, and proposed an undecorated durable child.
The installed cached source at the same time contained the new allocation and
title-sync implementation and was byte-identical to the repository source.
This establishes a stale in-memory MCP process rather than a failure of the
installed source.

No durable child was launched from that control attempt because shared
queen/child lineage had already failed the smoke acceptance gate.

### Remaining live gate

Fully restart Codex, start a fresh thread, and repeat one disposable durable
web. The run passes only if:

1. the queen receives a canonical outbound web ID and crown before launch;
2. the child settles to the matching inbound web ID through read/set/verify;
3. exact route and result-turn evidence verify;
4. `nelos_queen_decide` records acceptance;
5. cleanup emits and records the exact native archive receipt; and
6. the repository remains unchanged.

## Post-Restart Smoke — Web A2

After fully restarting Codex, the new MCP process loaded the rebuilt contract:

- Queen: `019fa4c3-3beb-7821-8d77-389f6e13c34a`
- Queen title: `🕷️ A2 👑 · Clarify CLI and MCP roles (7)`
- Child: `019fa4c6-a4fb-7ef1-9333-ed47e2375b8f`
- Child title: `🕸️ A2 · Run durable read-only smoke`
- Child route: Luna/low
- Launch batch: identity, read, topology, title, and route all verified

This proves the shared queen/child title fix works after a real restart.

The lifecycle then stopped at a new boundary. `launch-wave` told the queen to
create the durable task directly, but did not first return the
`nelos_orchestrate_create` preparation call that registers and binds its durable
work unit. The worker completed read-only inspection, but
`nelos_spinoff_complete` correctly rejected it as unbound. Its earlier attempt
to interpret “create exactly one spin-off” as a grandchild launch also failed
before mutation.

The source and worker worktrees remained unchanged, no CLI fallback ran, and
the blocked child was not archived because it was never accepted.

### Follow-up remediation

- Carry explicit `cleanupIntended` through planning; only `true` grants
  `archive`.
- Add an exact `nelos_orchestrate_create` preparation/bind action to every
  planned durable launch.
- Require the queen to execute that action before native creation and use the
  returned effect prompt/options.
- Tell the worker it is already the durable spin-off and must not create or
  delegate another task.
- Keep failed, unbound, and unaccepted tasks ineligible for cleanup.

## Registration-Before-Create Smoke — Generated Input Mismatch

After installing `0.4.0+codex.20260727182411` and fully restarting Codex, a
fresh queen reached the corrected preparation step before any durable task was
created:

- Queen: `019fa4dc-1a20-78e2-b73f-d7d767fc41a6`
- Queen title: `🕷️ A2 👑 · Clarify CLI and MCP roles (8)`
- Plan run: `run:62deaf1b9213ecfbf96d26b7cdc3b5aad0bd9b90`
- Planned child title: `🕸️ A2 · Verify durable lifecycle handoff`
- Planned route: Luna/low

The exact generated `nelos_orchestrate_create` arguments failed closed because
their `workUnit` contained persisted runtime fields (`binding` and
`replacementHistory`) that the tool's immutable creation-definition input
rejects. No native child was created.

The remediation serializes `workUnitDefinitionV1` into launch actions and adds
a producer-to-consumer regression test that executes the generated arguments
unchanged through `McpOrchestrationAdapterV1`. This protects the exact
machine-generated handoff rather than only checking individual fields.

## Role-First Title Correction

Review of the live A2 title exposed that persistence verification had been
mistaken for visual-contract acceptance. `🕷️ A2 👑 · …` persisted correctly,
but it violated the agreed role-first design because a queen did not begin with
the crown.

The canonical grammar is now:

- queen: `👑 A2 · …`
- spin-off: `🕷️ A2 · …`
- nested spin-off queen: `👑 A2.1 🕷️ A2 · …`

Legacy web, spider, and trailing-crown titles remain parseable and migrate on
an exact plan replay or authorized title synchronization.

## Role-First Live Smoke — Web A3

After reinstalling the role-first build, fully restarting Codex, and starting
a fresh queen:

- Queen: `019fa500-edb2-7123-ad71-1994b924dabc`
- Queen title: `👑 A3 · Clarify CLI and MCP roles (9)`
- Child: `019fa503-7694-7db1-96a8-1a0713a1d54e`
- Child title: `🕷️ A3 · Run disposable durable lifecycle smoke`
- Child route: Luna/low
- Registration-before-create, exact immutable handoff, native title
  read/set/verify, completion callback, bounded wait/result read, and clean
  isolated worktree: verified

An initial batch verification supplied the delegation source as a reported
native parent even though Codex's authoritative task inventory records
`create_thread` tasks as peers with no parent edge. Omitting that unsupported
claim produced a fully verified batch, which matches the Codex task contract.

The lifecycle then exposed a separate MCP boundary bug:
`nelos_queen_decide` rejected the real A3 queen because it compared the queen ID
with `CODEX_THREAD_ID` captured by the long-lived STDIO MCP process. Codex does
not document a per-call task identity for STDIO MCP servers, and the server
process can survive thread navigation or forks. The MCP decision adapter now
authorizes the asserted queen against the persisted web/work-unit binding,
exact consumed current-result receipt, and fresh terminal-turn evidence instead
of stale process-launch context. Queen-only invocation remains explicit in the
skill. The A3 child remains unarchived because the pre-fix server could not
record acceptance and cleanup correctly stayed unavailable.

## Post-Fix Live Smoke — Web A4

After reinstalling the stale-caller and peer-topology fixes, fully restarting
Codex, and starting a fresh queen:

- Queen: `019fa512-adca-72e2-b7fb-93efc460927d`
- Queen title: `👑 A4 · Clarify CLI and MCP roles (cont.)`
- Child: `019fa516-1968-71b2-8376-5aaff22e2704`
- Child title: `🕷️ A4 · Run durable spin-off smoke test`
- Child route: Luna/low
- Registration-before-create and immutable bind: verified
- Launch batch identity, read, peer topology, title, and route: all verified
- Isolated worker worktree: clean

The fresh queen successfully recorded an explicit decision, proving the MCP no
longer rejects the actual queen based on stale process-launch context. The
batch also passed without a fabricated native parent edge.

The completion callback itself exposed the next compatibility gap. Codex
`send_message_to_thread` successfully delivered the wake and returned exactly
`{"threadId":"019fa512-adca-72e2-b7fb-93efc460927d"}`. The worker then enriched
that host result with effect and lifecycle fields, while
`nelos_spinoff_complete` required a different synthesized receipt shape. Its
final result correctly became blocked; the queen independently rejected it,
and cleanup did not archive the unaccepted child.

The initial A4 planner attempt also produced 13 acceptance criteria even though
the plan schema permits at most 8. The second bounded attempt launched
successfully.

Follow-up remediation:

- accept the exact threadId-only Codex send-message result and no enriched
  fields;
- make the generated worker prompt show that exact second-call receipt;
- constrain every planner slice to 1–8 acceptance criteria; and
- retain fail-closed queen rejection and post-acceptance-only archival.

## Final Callback and Cleanup Smoke — Web A5

After reinstalling the exact threadId-only callback build, fully restarting
Codex, and starting a fresh queen:

- Queen: `019fa532-194b-70d2-a728-be867b97a0e9`
- Queen title: `👑 A5 · Clarify CLI and MCP roles (cont pt 2)`
- Child: `019fa538-bdf7-7a03-bb8f-fdc0ad044609`
- Child title: `🕷️ A5 · Final callback smoke test`
- Child route: Luna/low
- Launch batch identity, read, peer topology, title, and route: all verified
- Exact callback receipt: `{"threadId":"019fa532-194b-70d2-a728-be867b97a0e9"}`
- Isolated worker worktree: clean
- Queen decision: accepted from the exact current result receipt
- Cleanup: the accepted A5 child alone was archived by its exact native effect
  and receipt

The live planner also exposed four pre-launch or lifecycle contract gaps:

1. One plan incorrectly described the durable peer task as having the queen as
   a native parent.
2. One plan supplied a spider-decorated base title, which would have produced
   duplicate role markers after Nelos decoration.
3. One plan reused the globally persisted work-unit ID
   `durable-lifecycle-smoke`, and durable registration correctly failed closed
   on the conflicting historical definition.
4. The accepted plan assigned queen acceptance and archival evidence to the
   worker. The worker delivered its callback, then waited for queen acceptance
   before returning the result that the queen needed in order to decide,
   creating a circular wait. A bounded queen follow-up allowed the result to
   finish without a duplicate callback.

Remediation now makes planner slice IDs collision-resistant with a
bootstrap-derived suffix, rejects decorated raw slice titles, explicitly
models durable Codex tasks as peers, keeps acceptance and cleanup queen-owned,
and instructs callback workers to return their final result immediately after
the exact callback receipt is acknowledged.

## Fresh Plugin Full Regression — Web A6

After enabling the plugin-owned MCP server, fully restarting Codex, and
starting a fresh queen, the installed skill and MCP completed a mixed live web:

- Queen: `019fa632-db33-7921-a1ac-532c35bcce94`
- Queen title: `👑 A6 · Clarify CLI and MCP roles (cont pt 3)`
- Planner: `/root/nelos_planner_433f4e6e2bcf`, Sol/medium
- Joined worker: `/root/nelos_joined_contracts_433f4e6e2bcf_9ed99b39`,
  Sol/medium
- Durable worker: `019fa64b-ed7a-7e92-a520-a5d0b7d70255`, Sol/medium
- Durable title: `🕷️ A6 · Inspect lifecycle contracts in isolated worktree`
- Durable worktree: clean and detached at `204e2d0`
- Callback: exact thread-ID-only receipt delivered to the queen
- Queen decision: accepted from the exact current terminal result
- Cleanup policy: `ask`
- Cleanup candidate: the accepted A6 durable worker alone
- Cleanup state: confirmed, archived by the exact native effect and receipt

The run exercised and passed:

1. Fresh MCP discovery and app-server health (`0.144.6`, ready, compatible).
2. Reviewed routing for durable and joined surfaces.
3. Fail-closed rejection of Luna on a joined-subagent route.
4. Receipt-driven Sol/medium planning with interrupted-turn reconciliation.
5. Crown-first queen synchronization before wave launch.
6. Registration-before-create and immutable durable binding.
7. Post-bind spider/web title read, repair, and verification.
8. Atomic mixed-wave identity, topology, title, and exact-route verification.
9. Atomic rejection of a redundant joined parent claim before the corrected
   authoritative receipt passed.
10. Independent read-only results from joined and durable workers.
11. Exact durable callback, current-turn result read, and queen acceptance.
12. Replay safety: repeating the acknowledged callback receipt produced no
    second wake.
13. Terminal cleanup gating with one exact named candidate, no archive before
    confirmation, and durable completion after the exact native receipt.

Repository-wide regression evidence:

- Full test suite: 527 passed, 0 failed.
- Planning lifecycle verifier: passed.
- Source syntax checks: passed.
- Model catalog: fresh.
- App-server verifier: passed.
- Two-pass golden-loop verifier: passed.

One legacy verification surface needs follow-up: running
`node bin/nelos-verify-distribution` without a plugin-only profile reports the
optional PATH CLI and legacy user-wide skill as missing, even though the cached
plugin is coherent and the current product contract intentionally relies on
the plugin-owned skill and MCP. The verifier should distinguish plugin-only
installations from the older all-surfaces distribution layout.

The durable worker's first completion call also omitted the schema-required
`receipt` field and was rejected before mutation; it immediately retried with
`receipt: null` and completed correctly. This was safe and self-correcting, but
it is worth tightening the generated prompt example so agents are less likely
to omit the explicit null on their first call.
