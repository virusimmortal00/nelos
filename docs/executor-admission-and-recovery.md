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

`ExecutorLaunchJournalV1` stores one bounded private record per work unit, with
separate creation and turn identities. It uses the existing process-start-aware
lock protocol in the service's own directory, compare-and-set revisions,
exclusive temporary files, file sync, atomic rename, and directory sync.
The caller must wait for the dispatch transition to finish before calling
App Server. A failed durable write never permits dispatch.

The initial sequence is `prepared → create-dispatched → thread-bound →
turn-dispatched → running → terminal`. Failure after a dispatch transition is
`outcome-unknown`, with its create/turn stage preserved. Reconciliation may bind
an independently verified identity; an empty listing or timeout cannot permit
creation again. This version conservatively treats even post-dispatch RPC
errors as requiring reconciliation rather than assuming they prove non-execution.

Only `prepared` may become `not-executed`. A fresh launch must advance the
sequence by exactly one, use a fresh grant and operation ID, and retain the
closed operation. At most 32 operations and 512 KiB are retained per work unit;
exhaustion requires attention. Prompts are private, bounded to 32 KiB each, and
must match their approved digests. Journal records are service state, never a
tool response or diagnostic transcript.

`proveNotExecuted` produces an in-process opaque proof backed by the persisted
closed operation. `ExecutionStoreV1.releaseUndispatchedLaunch` accepts this
proof, checks the exact pending action, revision, and attempt, and restores the
initial unbound state. A serialized or fabricated proof is rejected. Journal
closure precedes store recovery, so a restart between the two steps can safely
repeat recovery. A late receipt from the old operation cannot bind the new one.
Bound tasks and replacement bindings cannot be reset through this path.

The proof is about the owned executor's recorded dispatch protocol. Legacy
native `launch-pending` records have no such evidence and remain reconciliation
cases. This module does not retrospectively assert that their native tool was
never called. It also does not install a supervisor or start an App Server.
