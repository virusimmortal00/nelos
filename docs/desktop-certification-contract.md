# Desktop certification contract

An external certification service and the public Nelos repository exchange one provider-neutral receipt. Version 1 is defined by `validation/desktop-smoke/certification-receipt.v1.schema.json` and enforced, including cross-record invariants that JSON Schema cannot express, by `verifyDesktopCertificationReceiptV1` from the `nelos/desktop-certification-contract` export.

## Public boundary

The receipt binds the exact committed inputs that were certified:

- the full Nelos commit SHA and SHA-256 candidate digest;
- the full harness commit SHA and semantic harness version;
- opaque SHA-256 template and evidence identities, which bind immutable private artifacts without naming their provider or location;
- balanced passed, failed, skipped, and total scenario counts plus assertion totals with bounded per-result records; and
- cleanup state proving destruction, independent absence verification, and no surviving test environment.

External verification supplies those six expected identities separately. Receipt validation accepts accurately reported failed or skipped runs, while verification fails closed unless every identity matches, no scenario or assertion failed, all totals agree at receipt, scenario, and assertion levels, cleanup is verified, and every object has exactly the documented fields. A successful verification returns only `schemaVersion`, `outcome`, and a canonical receipt digest.

The receipt is an attestation about an already-built product candidate. It is never an input to the Git commit SHA, distribution integrity digest, package tarball, release manifest, or package checksum. Changing an external service revision, template identity, receipt, or receipt digest therefore cannot change Nelos candidate identity. A changed Nelos product input creates a new candidate first and must then be certified separately.

The scenario boundary exposes only `scenarioId`, `outcome`, and assertion totals. A skipped scenario has no assertion records. The assertion boundary exposes only `assertionId`, `scenarioId`, `outcome`, and a bounded code. Actions, selectors, visible text, screenshots, logs, and raw evidence are not part of this interface.

## Private producer and GitHub check

The private `virusimmortal00/nelos-desktop-lab` repository owns `src/desktop-certification-receipt-producer.mjs`; no producer source or harness test is shipped from public Nelos. The producer projects private run state through explicit allowlists and accepts an opaque digest calculated over the harness-owned evidence bundle. Changing that evidence, harness commit, or harness version changes the receipt identity while leaving the already-built Nelos commit and candidate artifact digest untouched.

The private harness may publish the result directly as a GitHub check using `createDesktopCertificationCheckRequestV1`. The returned request targets `head_sha` at the exact receipt-bound Nelos candidate and declares only `checks: write` plus `metadata: read`. Its summary contains immutable identities and aggregate counts, never raw evidence. Use a GitHub App installation token scoped only to the public Nelos repository. No public workflow needs credentials for, checkout access to, or artifact access from the private repository.

## Excluded data

The public receipt and verification request have no extension fields. Credentials, secrets, controller or service addresses, provider names, host or network topology, VM or clone identifiers, account identifiers, local or guest paths, images, logs, and raw evidence are external-service concerns and must never be copied into the receipt. Opaque template and evidence digests are the only private artifact identities crossing the boundary.

`validation/desktop-smoke/asset-migration.v1.json` is the authoritative extraction manifest. Its public list is limited to scenario and assertion definitions, schemas, fixtures, and verification contracts. Provider, controller, environment lifecycle, capture, raw-evidence, and execution assets are excluded from this repository and its package.
