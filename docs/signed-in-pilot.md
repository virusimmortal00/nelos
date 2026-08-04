# Signed-in product-default pilot

Issue #51 begins with a diagnostic repeat-arm calibration of the signed-in Codex product route. This stage is deliberately not the direct-versus-Nelos confirmatory comparison and must not be presented as evidence of Nelos efficiency.

## Sealed design

- Two identical `direct-codex` candidates differ only by repeat-arm label.
- Five starter strata are included: localized repair, cross-cutting feature, multi-module migration, planning, and orchestration restart.
- Two task-seed repetitions produce 20 trials under identical limits.
- The requested route is `model:product-default`, revision `unavailable`, reasoning effort `medium`, with no plugins or user configuration.
- The product route may change behind that stable product label. The Codex JSONL stream does not expose a concrete model revision, so the report must never invent one.

The starter-v1 candidate prompt explicitly defines its output transformation. This is part of the task specification, not hidden-oracle disclosure: candidates are told to copy the visible fixture family and append `:verified`; the grader retains the exact expected bytes and rubric outside the candidate environment.

## Isolation boundary

The worker uses a dedicated Colima ARM64 VM created with host mounts and SSH-agent forwarding disabled. The pinned OCI image in `experiments/signed-in-pilot/Dockerfile` is the acquisition source for Node and `codex-cli 0.146.0`; execution happens directly in the unmounted VM because nested Docker blocks the Linux `bwrap` network namespace used by the Codex workspace sandbox.

The VM contract is:

- no developer home, repository, Codex home, sessions, configuration, or plugin cache is mounted;
- a dedicated `nelos-experiment` user runs every candidate;
- a root-owned worker-only authentication seed is copied into a fresh attempt home, then the entire attempt directory is removed;
- `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and `--sandbox workspace-write` are mandatory;
- the VM enables unprivileged user namespaces by setting `kernel.apparmor_restrict_unprivileged_userns=0`; this change is confined to the disposable VM and does not weaken host file permissions;
- outputs and sanitized event summaries are retained by content digest outside the candidate home; credentials, session IDs, prompts, command text, and raw error text are not retained as telemetry.

The signed-in product route requires control-plane network access. Candidate shell commands remain inside the Codex workspace sandbox, and each sealed task declares no task network access.

## Provision and authenticate

Create the VM and image from a clean host shell:

```sh
brew install colima docker
colima start nelos-pilot --arch aarch64 --vm-type vz --cpus 4 --memory 8 --disk 40 --mount none --ssh-agent=false --ssh-config=false --binfmt=false --vz-rosetta=false --runtime docker
docker build --pull=false --tag nelos-codex-pilot:0.146.0 experiments/signed-in-pilot
```

Authentication must be created by device authorization in the dedicated worker volume. Never copy `~/.codex/auth.json`:

```sh
docker volume create nelos-pilot-auth
docker run --rm --user root --volume nelos-pilot-auth:/experiment/home nelos-codex-pilot:0.146.0 sh -eu -c 'install -d -o 10001 -g 10001 -m 700 /experiment/home/.codex'
docker run --rm --interactive --tty --volume nelos-pilot-auth:/experiment/home nelos-codex-pilot:0.146.0 codex login --device-auth -c cli_auth_credentials_store=file
```

Copy the pinned runtime and worker-only credential into the unmounted VM, create the experiment user, install GNU `time`, and allow the bundled unprivileged sandbox namespace. The exact versioned runtime path and image digest must match the manifest builder constants.

## Build, canary, run, and report

After the harness is committed, bind the manifest to that commit and the acquired image digest:

```sh
node scripts/build-signed-in-pilot.mjs \
  --out /secure/pilot/manifest.json \
  --source-commit "$(git rev-parse HEAD)" \
  --image-digest "$(docker image inspect nelos-codex-pilot:0.146.0 --format '{{.Id}}')" \
  --image nelos-codex-pilot:0.146.0 \
  --evidence-dir /secure/pilot/evidence

node scripts/run-signed-in-pilot-canary.mjs /secure/pilot/manifest.json
node bin/nelos-experiment run --manifest /secure/pilot/manifest.json --store /secure/pilot/store --run-id run:issue-51-signed-in-product-default-v1

node scripts/report-signed-in-pilot.mjs \
  --store /secure/pilot/store \
  --run-id run:issue-51-signed-in-product-default-v1 \
  --generation 1 \
  --out /secure/pilot/report

node bin/nelos-verify-experiment-report \
  /secure/pilot/report/accepted-input.json \
  /secure/pilot/report/report.json
```

The final report is a calibration disposition, not a practical-benefit claim. `inconclusive` means the repeat sample is underpowered; `regression` between identical arms means variance or ordering effects reject the proposed confirmatory design. Missing subscription billing, currency cost, standard-credit conversion, and VM network-byte attribution must remain visible rather than being estimated as zero.

After this pilot, provision a separate API project key for the route-controlled study. Only after product-default and route-controlled calibration should issue #51 proceed to the direct-versus-Nelos task-web comparison with full web accounting.
