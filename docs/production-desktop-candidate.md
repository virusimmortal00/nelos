# Staging a Desktop release candidate

Desktop smoke validation must test committed bytes, not a dirty checkout or a temporary plugin-cache swap. Stage a candidate into a new private directory outside the repository and outside the controller's `CODEX_HOME`:

```sh
mkdir -m 700 /private/operator/nelos-candidates
node scripts/stage-production-desktop-candidate.mjs \
  --out-dir /private/operator/nelos-candidates/0.12.20
```

Staging requires a completely clean Git worktree. It materializes the committed distribution, computes its integrity digest, writes read-only provenance bound to the full source commit, verifies the source stayed unchanged, and atomically publishes the new directory without overwriting an existing path.

Use the returned package root with the minimal disposable lane:

```sh
nelos desktop-test \
  --candidate /private/operator/nelos-candidates/0.12.20 \
  --scenario-set release
```

The smoke command recomputes the candidate digest. The machine-local driver may clone any maintained clean Desktop template; the public contract does not require a provider, VMID, template name, lease, golden-image build, or temporary firewall transaction.

The staged package is not a release publication. Tagging, release assets, and marketplace promotion remain separate repository-policy operations after review, CI, and smoke evidence are accepted.
