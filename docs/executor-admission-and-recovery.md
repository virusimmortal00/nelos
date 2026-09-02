# Executor admission and recovery

Development contract, 2026-09-02. This implements the service-side boundary in
the [owned App Server design](mcp-owned-app-server-execution.md). It does not
enable an MCP execution tool or certify a runtime.

## Scoped grants

`ExecutorGrantAuthorityV1` keeps grants in private service memory. `issue`
accepts only a normalized execution wave; `validate` accepts only that wave and
an opaque grant ID. Neither accepts a host-capability receipt or user-intent
boolean. The gate resolves the ID against the same authority instance. Restart,
revocation, expiry, or changed execution context invalidates it.

An execution wave includes its existing planner identity and a separate digest
over every member's work-unit revision, attempt, launch sequence, host, Codex
home, repository, final cwd, workspace mode, exact model/effort, permission
profile, approval policy, title, and prompt digest. The digest uses the
normalized contract's JSON encoding. Member order and object key order do not
change the normalized digest. The prompt digest is `executorDigest(prompt)`.
Target paths are retained verbatim; the work host must validate their canonical
placement. A source-machine path resolver must not rewrite a foreign path.

The service installs two trusted providers at construction:

- `evaluate(scope, {signal})` verifies placement, the actual adapter and required
  operations, interaction support, live configuration/account identity, and
  a runtime certification record. It returns the exact scope digest, service
  and owner epoch, loaded runtime generation, account/config fingerprints,
  certification ID, freshness deadline, available operations, and interaction
  mode. Discovery alone is insufficient evidence for this provider.
- `authorize(scope, {context, signal})` uses the host's actual authorization
  channel and returns an allowed decision bound to both the scope digest and
  context fingerprint, with its own expiry and decision ID. A missing or
  non-allowing authorizer produces an authorization requirement.

These are dependency interfaces, not claims that Codex currently supplies a
host attestation API. They must never be selected, implemented, or populated
from MCP argument objects. No production providers are installed by this
change. The default authority cannot grant execution.

Context is rechecked after authorization and at every admission. Required
operations are creation, turn start, observation, result reads, and interruption.
Without an interactive channel, the first contract only accepts an explicitly
preauthorized unattended route with an already selected `never` approval policy;
it never changes policy itself. Grant count, outstanding provider callbacks,
provider deadlines, and lifetime are bounded. Providers must honor cancellation;
late callbacks cannot issue a grant after timeout or shutdown.

The authority protects the service API from fabricated JSON claims. It does
not protect against arbitrary code execution inside the service or a compromised
host user. Service-channel access control and runtime certification remain
required before rollout.

## Launch recovery

The next component is a durable journal that records intent before dispatch,
creation and turn identities separately, and conclusive non-dispatch separately
from an unknown outcome. Grants authorize an attempt; they do not themselves
deduplicate effects. The journal will own that responsibility. Existing native
receipts and legacy `launch-pending` records are unchanged by the grant module.
