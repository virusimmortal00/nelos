# Issue #61 marketplace upgrade verification

Date: 2026-07-31

## Reproducible commands

```bash
npm ci --ignore-scripts
npm run verify:plugin-upgrade
npm run test:plugin-lifecycle
```

`verify:plugin-upgrade` uses the real `codex plugin marketplace add`,
`codex plugin add`, `codex plugin marketplace upgrade`, and `codex app-server`
commands in an isolated home. It serves a local Git marketplace over HTTP so
the Codex Git-upgrade path is exercised without changing the user's configured
marketplaces or using an external network.

## Observed upgrade evidence

- Installed the representative legacy marketplace payload at `0.4.0`.
- Replaced the Git marketplace's `stable` branch with the actual repository
  `0.5.0` candidate plus its metadata-only immutable provenance commit.
- Refreshed the configured marketplace and reinstalled `nelos` through Codex.
- Proved the legacy version cache was removed and an unrelated cache sentinel
  remained byte-identical.
- Started a new Codex app-server process after the upgrade and created a fresh
  ephemeral Codex task. That process reported the installed and enabled
  `nelos@upgrade-fixture` plugin at `0.5.0`.
- In a separate post-upgrade process, matched the installed plugin manifest,
  `.mcp.json`, task-management skill, MCP implementation module, and provenance
  byte-for-byte to the candidate source. The process imported the candidate MCP
  module and verified its `startNelosMcpServer` entrypoint.
- Matched installed and candidate distribution integrity and cache identity.

Representative terminal fields from the passing run:

```json
{
  "verified": true,
  "legacyVersion": "0.4.0",
  "candidateVersion": "0.5.0",
  "processRestarted": true,
  "freshTaskVerified": true,
  "legacyCacheRemoved": true,
  "unrelatedDataPreserved": true,
  "candidateIntegrity": "sha256:c91968ace62f66125c345ea0811a5a43564cc41e6afaeb4dd1691287c9e1a37f",
  "cacheIdentity": "https://github.com/virusimmortal00/nelos.git#nelos@0.5.0"
}
```

`test:plugin-lifecycle` is the canonical focused gate. The recorded run
completed with exactly 83 tests passed, 0 failed, 0 skipped, and 0 cancelled.
