# Staging a production Desktop candidate before release

Live pre-release Desktop validation must not run from a dirty checkout or label
uncommitted bytes as a Git release. A maintainer can create a non-publishing
candidate from the current clean commit without creating a tag:

```bash
PRIVATE_PARENT=$(mktemp -d)
chmod 0700 "$PRIVATE_PARENT"
PRIVATE_PARENT=$(cd "$PRIVATE_PARENT" && pwd -P)
node scripts/stage-production-desktop-candidate.mjs \
  --out-dir "$PRIVATE_PARENT/nelos-desktop-candidate" \
  > "$PRIVATE_PARENT/candidate.json"
chmod 0400 "$PRIVATE_PARENT/candidate.json"
```

The command fails unless the source is the canonical root of a completely
clean SHA-1 Git worktree. It invokes the fixed `/usr/bin/git` executable with a
minimal environment, disables replacement objects, reads only committed blobs,
and rejects symlinks, submodules, unsafe paths, or unsupported Git modes. An
ignored build output is never copied into the candidate.

The output parent must already exist, be canonical, caller-owned, and have
exact mode `0700`. The exact output path must not exist. A caller-private lock
serializes competing writers; staging occurs beside the destination on the
same filesystem and is published by one atomic rename. Existing output is
never replaced.

Standard output is canonical JSON: recursively sorted keys, compact separators,
and one final newline. Redirecting it to a private file and changing that file
to mode `0400` therefore produces the candidate manifest accepted directly by
`nelos-prepare-production-run`; no lossy or hand-written translation is needed.
The resulting JSON names:

- `packageRoot`, the external immutable candidate directory;
- `runnerPath`, the candidate's own production Desktop CLI;
- `candidateDigest`, the SHA-256 identity of every provenance-covered file;
- `sourceRevision` and `sourceRevisionType`, which bind those bytes to the
  exact clean Git commit; and
- `provenancePath`, whose record contains the same identities.

Pass that manifest to the production composer. The composer derives
`candidateDigest`, invokes the runner from the staged root so its
package-relative imports and candidate verification resolve the same bytes,
and independently preflights the generated host binding:

```bash
nelos-prepare-production-run \
  --candidate-manifest "$PRIVATE_PARENT/candidate.json" \
  --golden-receipt /absolute/inputs/golden.json \
  --task-intent /absolute/inputs/production-task-intent-SHA256.json \
  --provider /absolute/inputs/provider.json \
  --lease /absolute/inputs/lease.json \
  --reservation /absolute/inputs/reservation.json \
  --scenario /absolute/inputs/scenario.json \
  --output-root /absolute/private/runs/RUN_ID
```

Create that content-addressed intent with
`nelos-prepare-production-guest-task` and use its returned `taskSlotId` as the
scenario task ID. This step creates no controller-local Codex task. The
disposable guest creates and receipts the one real empty task after isolated
device authentication and before any model-submit action.

Composition deliberately leaves declared one-shot benchmark values absent.
After the trusted secret provider stages the exact mode-`0400` files named by
`composition.json.sealedValues`, repeat the command with
`--require-sealed-values`; only then run the candidate's final preflight and
seek live authorization. That readiness check inspects file metadata without
reading or hashing secret bytes.

The staging command does not run lifecycle operations, install a plugin,
create a package archive, create a tag, contact a registry, or publish
anything. Re-running it from the same commit into a different new private
output directory produces the same provenance-covered bytes and digest.

Staging is a maintainer command in the source repository, not an installed
Nelos CLI. It does not invent a Proxmox provider binding, lease/fence
reservation, host identity, or SSH key material. Those operator-controlled
inputs must be prepared and independently attested before the composer creates
the sealed run packet and host binding. Neither staging nor composition
authorizes or performs live mutation.
