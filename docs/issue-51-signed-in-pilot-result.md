# Issue #51 signed-in pilot result — 2026-08-03

The isolated signed-in product-default calibration completed, and its standalone report verification passed. This result is diagnostic only; it does not compare direct Codex with Nelos and cannot support an efficiency claim.

## Immutable identities

- Harness source: `8db9676b39671d0e1b13053e6124ce322bb018d7`
- Acquisition image: `sha256:adc09c2f664ad8fe7ee5ee7c3aaf918f7eea6c99178f45dd28904e1fd2fc8ae9`
- Manifest: `sha256:11805bf6a291f7943875750292d2db71e47c3e57afe098595474e0f91f8edf89`
- Experiment: `exp:da5ecfe65affcd96214d42240e3f78230d55aefc984ab189b1bde0149ed56937`
- Plan: `sha256:3d7d90c89d8a3820b491b37f49a0a6ca43a7aab49f96dd2a658b403e6d3c99d0`
- Final run: `sha256:67508bbca86f7c7c24ba43ceb3cb3e1d45b196b3c2fb596dfa356cd459498585`
- Accepted report input: `sha256:81356ed54a3ee17806035c93f6e3ff6b4af191fbaf65f8e37d395eb3cea8e9d5`
- Verified report: `sha256:17ed255483b49554707e0b55163ed96f787081f4a3f7c13b7d10e2ccb8d4b903`

## Observed calibration

- 20 of 20 trials were authoritative strict passes.
- There were no retries, timeouts, candidate failures, route mismatches, contamination events, or tool failures.
- Input tokens totaled 776,865: mean 38,843.25, sample standard deviation 7,108.28, range 29,180–45,726.
- Output tokens totaled 5,965: mean 298.25, sample standard deviation 57.31, range 199–394.
- Wall time totaled 360.565 seconds: mean 18.028 seconds, sample standard deviation 3.265 seconds, range 13.296–27.133 seconds.
- Tool calls totaled 33: mean 1.65, range 1–2.
- Subscription billing credits, currency cost, standard-credit conversion, and VM-attributed network bytes were unavailable and remain explicitly missing.

The sealed decision is **regression**, with `critical-stratum-regression` and `insufficient-power` blockers. Because both arms are intentionally identical, this is a study-design rejection rather than a product regression. The second repeat arm showed critical-stratum token increases, including planning input-token means of 43,623.5 versus 36,544.5 and orchestration-restart means of 45,155.5 versus 36,555.5. With only two repetitions per stratum, several other resource intervals also excluded zero.

## Continuation decision

Do not promote this ordering and sample size into the confirmatory comparison. Before evaluating direct Codex against Nelos:

1. Provision a separate API project key for the route-controlled phase, as planned.
2. Counterbalance or randomize arm order within task/seed blocks so product caching and time order cannot align with candidate label.
3. Use the pilot variance to seal a larger per-stratum sample size; the current decision rule requires at least ten paired samples per critical stratum.
4. Keep the product-default and route-controlled results separate.
5. Add the Nelos arm only after calibration passes, with full task-web accounting and the same candidate limits.

Issue #51 remains open until those route-controlled and direct-versus-Nelos phases are complete.
