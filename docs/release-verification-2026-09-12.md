# Release verification — 2026-09-12

The owned-executor implementation passes the automated release checks below.
This is unreleased development evidence, recorded on September 12 Eastern time
(September 13 UTC). It does not select or publish a release version.

## Installed and available runtimes

| Component | Installed/tested | Available at this check |
| --- | --- | --- |
| Local Desktop | 26.908.40834, build 8881 | Same production build |
| m3 Desktop | 26.908.40401, build 8837 | Build 8881 |
| Both Desktop-bundled CLIs | 0.154.0-alpha.6.2 | Same CLI in these two installed bundles |
| m3 standalone CLI | 0.154.0 | npm stable 0.154.0 |
| Isolated local/Linux standalone CLI | 0.154.0 | npm stable 0.154.0 |
| Public prerelease channel | Not installed/tested in this slice | npm alpha 0.155.0-alpha.3.10 |

Desktop availability came from the production
[appcast](https://persistent.oaistatic.com/codex-app-prod/appcast.xml).
CLI channels came from `npm view @openai/codex dist-tags --json`.
The local hosting app and m3 services were not restarted during this slice.
The prior [m3 Astra canaries](owned-full-plan-canary-2026-09-11.json) remain the
signed-in execution evidence; these installation and transport checks add no
new claim about model execution or full Desktop UI certification.

## Checks completed

- macOS arm64, Node 20.20.2: 1,220 tests passed; zero failed or skipped.
- Linux arm64, Node 20.20.2: 1,220 tests passed; zero failed or skipped. The
  disposable container used `node:20-bookworm` at digest
  `sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5`.
- Syntax checks, deterministic golden loops, and clean-install gates passed on
  both platforms. The clean-install wrapper also passed on local Node 26.7.0.
- Actual marketplace upgrade from a legacy fixture to the candidate passed in
  isolated homes with CLI 0.154.0 and Desktop-bundled 0.154.0-alpha.6.2.
  Fresh App Server tasks activated the candidate, removed the old cache, and
  preserved unrelated data. This verifies activation after a fresh process;
  it does not claim hot reload of a running Desktop/MCP worker.
- CLI 0.154.0 source, generated schema, and macOS runtime transport formed a
  verified exact-release bundle. Its annotated upstream tag peels to
  `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`. Linux initialization and bounded
  `thread/list` also passed. The reviewed reduced fixture retains its historical
  filename and now records 0.154.0 alongside 0.144.5 and 0.144.6.
- The reduced-schema review checked all seven consumed methods, required and
  optional request keys, response paths, initialization fields, and thread
  status/active-flag enums. The CI schema collector itself checks method presence;
  the checked-in report additionally records this field review and source hashes.
- Development dependency updates to fast-uri 3.1.7, hono 4.13.7, and qs 6.16.0
  cleared the dependency audit: zero reported vulnerabilities.
- CodeRabbit reviewed the implementation diff and raised zero issues. Subsequent
  edits record this evidence and add release-environment setup only.

The first Linux run skipped the marketplace test because no CLI was installed.
The final run installed CLI 0.154.0 and executed it. A separate initial transport
probe failed because its explicit temporary CODEX_HOME did not exist; creating
that isolated directory resolved startup. Neither failure was classified as
runtime incompatibility.

## Release fixes and packaging rehearsal

The release and drift matrices now include exact stable CLI 0.154.0 while
retaining the two historical targets. The release test job installs and checks
Codex after clean-tag validation so the real marketplace upgrade test runs.
These CI pins are reproducible test targets; they do not gate user access.

The clean-install command previously mistook Node 20's skipped-test totals for
failure. It now requires exactly one successful named test, no failures, and
no cancellations. The manifest generator and runtime identity reader also now
accept the documented SemVer prereleases and build metadata, while requiring
all embedded identities to match exactly.

A disposable clone used the synthetic version `0.0.0-rehearsal.20260912` and a
private annotated fixture tag. No tag was added to the working repository or
pushed. Each platform's release builder produced two byte-identical packages
and checksum/SBOM/provenance manifests. Linux and macOS package payloads are
identical after decompression; their compressed bytes differ because their Node
builds use zlib 1.3.1-e00f703 and 1.2.12 respectively. Public release artifacts
continue to be built twice on one Linux toolchain.

The extracted Linux package passed distribution integrity and runtime identity
validation and contains the executor service, preparation and approval commands,
plan service, approval channel, and required-tool checks. Its synthetic version
and commit identify a test fixture, not an installable release candidate.

## Remaining release boundary

Finalize the intended release version and notes, regenerate all identity and
provenance surfaces, then cut an annotated tag only after the final candidate's
checks pass. The tag workflow repeats the macOS/Linux gate and creates a draft
release for explicit publication. These results do not authorize publication or
reuse of the retained 0.13.0 development identity for different released bytes.

Full Desktop UI certification and detached parent wake remain outside these
claims. Durable inbox collection and explicit joins are supported; autonomous
parent resumption is still unavailable. See the
[owned-plan runbook](owned-executor-plan-runbook.md) for operational limits.

[Machine-readable evidence](release-verification-2026-09-12.json) records the
log hashes, tested input digest, schema review, installation results, and
packaging identities. Raw logs and the full exact-release bundle remain local;
this document records their hashes rather than embedding the full logs.
