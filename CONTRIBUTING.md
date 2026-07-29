# Contributing to Nelos

Thanks for improving Nelos. The project is currently maintained by one person,
so focused reports and small, well-tested pull requests are especially useful.

## Before you start

Use Node.js 20 or newer on macOS or Linux. Install dependencies and run the
local checks from the repository root:

```bash
npm install
npm test
npm run check
```

Run the pull-request compatibility gate locally with the same command CI uses:

```bash
npm run compatibility
```

The required entry point compares `HEAD` with the merge base of the first
available base reference: `COMPATIBILITY_BASE_REF`,
`origin/$GITHUB_BASE_REF`, or `origin/main`. For a low-level explicit range,
run `node bin/nelos-compatibility --base REV --head REV`; repeat
`--file PATH` there to check explicit paths instead. The gate is offline: it
does not launch Codex, perform live mutations, make model calls, or consume API
credentials.

For changes that affect routing, lifecycle behavior, the app-server bridge, or
distribution behavior, follow the relevant guidance in
[`docs/development.md`](docs/development.md) and run the applicable verifier.
Do not run the live app-server verifier unless you intend to create billed model
turns. Keep changes scoped, update tests or documentation when behavior changes,
and describe the validation you ran in the pull request.

Compatibility contributors must also follow the ownership, evidence, and
migration rules in
[`docs/compatibility-architecture.md`](docs/compatibility-architecture.md).
Pull requests run only the offline deterministic boundary. Scheduled drift,
release evidence, trusted-live probes, and semantic review are separate
execution boundaries; none may silently edit claims, fixtures, supported
versions, source, or documentation. Include the selected capability report and
any exact-ref, schema, runtime, or advisory artifacts relevant to the claim in
the pull request or release review.

## Issues, support, and security

Use a bug report when you can provide a bounded, reproducible defect in this
repository. Use a feature request to explain a concrete use case and the
outcome it would enable. General setup, usage, and compatibility questions
belong in [SUPPORT.md](SUPPORT.md), not in defect reports.

Never report suspected vulnerabilities publicly. Follow the private reporting
instructions in [SECURITY.md](SECURITY.md). Do not put credentials, tokens,
private task content, raw environment dumps, or exploitable security details in
an issue, pull request, test fixture, or discussion.

## Pull requests

Open one pull request per coherent change. Explain the problem, approach,
tests, and any follow-up work. The maintainer may request changes, defer a
proposal, or merge it when capacity permits; no response or review timeline is
guaranteed.

By contributing, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
