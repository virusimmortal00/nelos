# Desktop certification contract

An external certification service and the public Nelos repository exchange one provider-neutral receipt. Version 1 is defined by `validation/desktop-smoke/certification-receipt.v1.schema.json` and enforced, including cross-record invariants that JSON Schema cannot express, by `verifyDesktopCertificationReceiptV1` from the `nelos/desktop-certification-contract` export.

## Public boundary

The receipt binds the exact committed inputs that were certified:

- the full Nelos commit SHA and SHA-256 candidate digest;
- the full harness commit SHA and semantic harness version;
- an opaque SHA-256 template identity, which identifies template content without naming its provider or location;
- balanced scenario and assertion totals with bounded per-result records; and
- cleanup state proving destruction, independent absence verification, and no surviving test environment.

External verification supplies those five expected identities separately. Verification fails closed unless every identity matches, all scenarios and assertions pass, all totals agree at receipt, scenario, and assertion levels, cleanup is verified, and every object has exactly the documented fields. A successful verification returns only `schemaVersion`, `outcome`, and a canonical receipt digest.

The receipt is an attestation about an already-built product candidate. It is never an input to the Git commit SHA, distribution integrity digest, package tarball, release manifest, or package checksum. Changing an external service revision, template identity, receipt, or receipt digest therefore cannot change Nelos candidate identity. A changed Nelos product input creates a new candidate first and must then be certified separately.

The scenario boundary exposes only `scenarioId`, `outcome`, and assertion totals. The assertion boundary exposes only `assertionId`, `scenarioId`, `outcome`, and a bounded code. Actions, selectors, visible text, screenshots, logs, and raw evidence are not part of this interface.

## Excluded data

The public receipt and verification request have no extension fields. Credentials, secrets, controller or service addresses, provider names, host or network topology, VM or clone identifiers, account identifiers, guest paths, images, logs, and raw evidence are external-service concerns and must never be copied into the receipt. The opaque template digest is the only template identity crossing the boundary.

`validation/desktop-smoke/asset-migration.v1.json` is the authoritative extraction manifest. Its public list is limited to scenario and assertion definitions, schemas, fixtures, and verification contracts. Provider, controller, environment lifecycle, capture, raw-evidence, and execution assets are excluded from this repository and its package.
