# Default recommendation diversity observation

Status: diversity proven from three fresh isolated queens.

This packet joins the existing `shape-sol-medium` observation with two fresh
default recommendation-shape runs. The schema-checked machine-readable bundle
is `live-shape-recommendation-diversity-2026-08-12.json`. Recommendation,
delivery, and route verification are reported independently; result delivery
alone is never treated as route evidence.

## Fresh Terra run

- Evaluation ID: `write-terra-smoke--20260812-diversity-terra-019ff72c`
- Plan identity: `run:75ee65b19932c6d68e8d6ea670204df2b55dce85`, wave 1,
  digest `54d3a6dd39c21e7cec0e48dfaab65070aa3f66b442f13c377ff585ea80068f63`
- Queen / web: `019ff72d-b60f-75b2-a98b-310ab283675d` / `BD`
- Isolated workspace: `worktree-a59a`
  (`/Users/bobby.sayers/.codex/worktrees/a59a/nelos`)
- Launch identity: spinoff task `019ff72f-825f-7102-bc86-4e4607e18d8f`,
  terminal turn `019ff72f-8454-7572-9178-6e21ee84f488`
- Lifecycle: planned -> authorized -> native-created -> bound ->
  launch-batch-verified -> completed -> result-read -> accepted -> archived
- Result delivery: succeeded. The `native-result-read` receipt requested turn
  `019ff72f-8454-7572-9178-6e21ee84f488` and reported the same source turn;
  its work-unit ID, revision 1, attempt 1, binding generation 1, and member task
  all matched the current launch.
- Resolver correlation: the launch batch passed identity, local topology,
  title, read, and exact-route checks. A second runtime intelligence check
  addressed the same member task and terminal turn and observed
  `gpt-5.6-terra/low`.
- Recommendation outcome: `everyday` selected profile `terra`, model and effort
  both `recommended`, requesting `gpt-5.6-terra/low` under route schema 2,
  policy 3, catalog `openai-2026-07-21`.
- Route-verification outcome: pass, `exact-native-route-verified`; observed
  `gpt-5.6-terra/low` from current correlated evidence.
- Terminal disposition: accepted, then archived by governed auto-cleanup.

## Fresh Luna run

- Evaluation ID: `write-luna-fixture--20260812-diversity-luna-019ff72c`
- Plan identity: `run:1606c3c717b2aa9323ca33153578903ab12eaf36`, wave 1,
  digest `ca0cec57140da854b3e035f133a03b08652731b9778f6198cd0e5b29a63f015f`
- Queen / web: `019ff72d-b9a4-7450-8cf8-d5782220b83c` / `BC`
- Isolated workspace: `worktree-db29`
  (`/Users/bobby.sayers/.codex/worktrees/db29/nelos`)
- Launch identity: spinoff task `019ff72e-eadf-7772-9b26-1d19a8f4a410`,
  terminal turn `019ff72e-eccd-7253-a8c7-dd123e820737`
- Lifecycle: planned -> authorized -> native-created -> bound -> title-corrected
  -> launch-batch-verified -> completed -> result-read -> accepted -> archived
- Result delivery: succeeded. The `native-result-read` receipt requested turn
  `019ff72e-eccd-7253-a8c7-dd123e820737` and reported the same source turn;
  its work-unit ID, revision 1, attempt 1, binding generation 1, and member task
  all matched the current launch.
- Resolver correlation: after title correction, the launch batch passed
  identity, local topology, title, read, and exact-route checks. A second
  runtime intelligence check addressed the same member task and terminal turn
  and observed `gpt-5.6-luna/low`.
- Recommendation outcome: `clear/repeatable` selected profile `luna`, model and
  effort both `recommended`, requesting `gpt-5.6-luna/low` under route schema 2,
  policy 3, catalog `openai-2026-07-21`.
- Route-verification outcome: pass, `exact-native-route-verified`; observed
  `gpt-5.6-luna/low` from current correlated evidence.
- Terminal disposition: accepted, then archived by governed auto-cleanup.

## Three-case comparison

| Scenario | Fresh evaluation / queen | Recommendation outcome | Delivery outcome | Route-verification outcome | Terminal disposition |
| --- | --- | --- | --- | --- | --- |
| `shape-sol-medium` | `assess-routing-boundaries--20260812-shape-sol-medium-a` / `019ff718-3c2c-74b0-b767-e47fdb148eb3` | `complex/open-ended` -> recommended `gpt-5.6-sol/medium` | Worker completed; the legacy observation schema records terminal completion but not the detailed result-read receipt | Pass: observed `gpt-5.6-sol/medium`, exact runtime verification | Complete |
| `shape-terra-low` | `write-terra-smoke--20260812-diversity-terra-019ff72c` / `019ff72d-b60f-75b2-a98b-310ab283675d` | `everyday` -> recommended `gpt-5.6-terra/low` | Current terminal-turn result joined; succeeded and accepted | Pass: observed `gpt-5.6-terra/low`, exact runtime verification | Accepted, archived |
| `shape-luna-low` | `write-luna-fixture--20260812-diversity-luna-019ff72c` / `019ff72d-b9a4-7450-8cf8-d5782220b83c` | `clear/repeatable` -> recommended `gpt-5.6-luna/low` | Current terminal-turn result joined; succeeded and accepted | Pass: observed `gpt-5.6-luna/low`, exact runtime verification | Accepted, archived |

## Diversity conclusion

Diversity is proven. All three fresh cases have distinct route-verified default
recommendations: Sol/medium, Terra/low, and Luna/low. This exceeds the decision
rule requiring at least two fresh cases with distinct route-verified
recommendations. No unavailable identity, cross-host resolver state, stale
receipt, planned route, or delivery-only signal contributes to that conclusion.
