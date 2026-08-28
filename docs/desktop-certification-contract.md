# Desktop certification contract

The Desktop harness and the public Nelos repository exchange one provider-neutral receipt. Version 1 is defined by `validation/desktop-smoke/certification-receipt.v1.schema.json` and enforced, including cross-record invariants that JSON Schema cannot express, by `verifyDesktopCertificationReceiptV1` from the `nelos/desktop-certification-contract` export.

## Public boundary

The receipt binds the exact committed inputs that were certified:

- the full Nelos commit SHA and SHA-256 candidate digest;
- the full harness commit SHA and semantic harness version;
- an opaque SHA-256 template identity, which identifies template content without naming its provider or location;
- balanced scenario and assertion totals with bounded per-result records; and
- cleanup state proving destruction, independent absence verification, and no surviving test environment.

External verification supplies those five expected identities separately. Verification fails closed unless every identity matches, all scenarios and assertions pass, all totals agree at receipt, scenario, and assertion levels, cleanup is verified, and every object has exactly the documented fields. A successful verification returns only `schemaVersion`, `outcome`, and a canonical receipt digest.

The scenario boundary exposes only `scenarioId`, `outcome`, and assertion totals. The assertion boundary exposes only `assertionId`, `scenarioId`, `outcome`, and a bounded code. Actions, selectors, visible text, screenshots, logs, and raw evidence are not part of this interface.

## Excluded data

The public receipt and verification request have no extension fields. Credentials, secrets, controller or service addresses, provider names, host or network topology, VM or clone identifiers, account identifiers, guest paths, raw screenshots, logs, and raw evidence are private harness concerns and must never be copied into the receipt. The opaque template digest is the only template identity crossing the boundary.

`validation/desktop-smoke/asset-migration.v1.json` is the authoritative migration manifest. It names every in-scope Desktop testing asset in this candidate and declares whether it stays public, moves to the private harness, or is removed instead of migrated.
