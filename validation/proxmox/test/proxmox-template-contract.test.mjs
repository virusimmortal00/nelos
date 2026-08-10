import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createEvidenceProbe,
  validateEvidenceDocument,
  validateProxmoxContract,
  validateRecipeSources,
  validateRepositoryContract,
  validateToolchainLock,
} from "../scripts/validate-contract.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const validationRoot = join(root, "validation", "proxmox");
const execFileAsync = promisify(execFile);
const gitExecutable = "/usr/bin/git";
const gitTreeManifestDomain = "nelos.proxmox.candidate-tree.git-ls-tree.v1";
const gitObjectFormatWidth = Object.freeze({ sha1: 40, sha256: 64 });
const gitIdentityArguments = Object.freeze([
  "--no-replace-objects",
  "--literal-pathspecs",
  "--no-optional-locks",
  "-c", "core.useReplaceRefs=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.autocrlf=false",
  "-c", "core.eol=lf",
  "-c", "core.commitGraph=false",
  "-c", "core.multiPackIndex=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "tar.umask=0002",
]);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadFixture() {
  const [contract, contractSchema, toolchainLock, evidenceSchema] = await Promise.all([
    readJson(join(validationRoot, "contract.json")),
    readJson(join(validationRoot, "contract.schema.json")),
    readJson(join(validationRoot, "toolchain.lock.json")),
    readJson(join(validationRoot, "evidence", "schema.json")),
  ]);
  return { contract, contractSchema, toolchainLock, evidenceSchema };
}

function cleanGitEnvironment() {
  return {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_REF_PARANOIA: "1",
  };
}

function commitGitEnvironment() {
  return {
    ...cleanGitEnvironment(),
    GIT_AUTHOR_NAME: "Nelos Contract Test",
    GIT_AUTHOR_EMAIL: "nelos-contract@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Nelos Contract Test",
    GIT_COMMITTER_EMAIL: "nelos-contract@example.invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
}

async function createCleanRepositoryFixture(context) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "nelos-proxmox-repository-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const fixtureRoot = join(temporaryRoot, "repository");
  await mkdir(join(fixtureRoot, "validation"), { recursive: true });
  await cp(validationRoot, join(fixtureRoot, "validation", "proxmox"), { recursive: true });
  const env = commitGitEnvironment();
  await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot, env });
  await execFileAsync("git", ["add", "--all"], { cwd: fixtureRoot, env });
  await execFileAsync("git", ["commit", "--quiet", "--message", "contract fixture"], { cwd: fixtureRoot, env });
  return { artifactRoot: temporaryRoot, fixtureRoot };
}

async function runBuildGitPreflight(artifactRoot, fixtureRoot) {
  const facadeBin = join(artifactRoot, "linux-facade-bin");
  await mkdir(facadeBin, { recursive: true });
  const unamePath = join(facadeBin, "uname");
  await writeFile(
    unamePath,
    [
      "#!/usr/bin/env bash",
      "case \"${1:-}\" in",
      "  -s) printf '%s\\n' Linux ;;",
      "  -m) printf '%s\\n' x86_64 ;;",
      "  *) exit 64 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(unamePath, 0o700);
  const realpathPath = join(facadeBin, "realpath");
  await writeFile(
    realpathPath,
    [
      "#!/usr/bin/env bash",
      "case \"${1:-}\" in -m|-e) shift ;; esac",
      "if [[ ${1:-} == -- ]]; then shift; fi",
      "node -e 'process.stdout.write(require(\"node:fs\").realpathSync(process.argv[1]) + \"\\n\")' \"${1:?path is required}\"",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(realpathPath, 0o700);
  const buildWrapper = join(
    fixtureRoot,
    "validation",
    "proxmox",
    "scripts",
    "build-template.sh",
  );
  await chmod(buildWrapper, 0o700);
  return execFileAsync(buildWrapper, [], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      PATH: `${facadeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PROXMOX_URL: "https://pve.invalid:8006/api2/json",
      PROXMOX_USERNAME: "builder@pve!nelos",
      PROXMOX_TOKEN: "test-token",
      NELOS_PACKER_STATE_DIR: join(artifactRoot, "packer-state"),
      PKR_VAR_proxmox_node: "prox2",
      PKR_VAR_base_template_vmid: "9020",
      PKR_VAR_base_template_name: "nelos-base",
      PKR_VAR_output_template_vmid: "9021",
      PKR_VAR_output_template_name: "nelos-validator",
      PKR_VAR_cloud_init_storage: "local-lvm",
    },
  });
}

async function readGitCandidateIdentity(fixtureRoot) {
  const env = cleanGitEnvironment();
  const [{ stdout: configOutput }, { stdout: alternatesOutput }] = await Promise.all([
    execFileAsync(gitExecutable, [
      ...gitIdentityArguments,
      "config",
      "--includes",
      "--show-scope",
      "--name-only",
      "--null",
      "--list",
    ], {
      cwd: fixtureRoot,
      encoding: null,
      env,
    }),
    execFileAsync(gitExecutable, [
      ...gitIdentityArguments,
      "rev-parse",
      "--git-path",
      "objects/info/alternates",
    ], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env,
    }),
  ]);
  const configParts = Buffer.from(configOutput).toString("utf8").split("\0");
  if (configParts.at(-1) === "") configParts.pop();
  assert.equal(configParts.length % 2, 0, "fixture Git configuration inventory must be exact");
  for (let index = 0; index < configParts.length; index += 2) {
    const scope = configParts[index];
    const key = configParts[index + 1].toLowerCase();
    assert.equal(
      (scope === "local" || scope === "worktree") && key.startsWith("tar."),
      false,
      "fixture repository and worktree tar.* configuration is forbidden",
    );
    assert.equal(
      key === "extensions.partialclone"
        || /^remote\..+\.(?:promisor|partialclonefilter)$/u.test(key),
      false,
      "fixture partial-clone and promisor configuration is forbidden",
    );
  }
  const alternatesGitPath = alternatesOutput.trim();
  assert.notEqual(alternatesGitPath, "", "fixture object alternates path must resolve exactly");
  const alternatesPath = isAbsolute(alternatesGitPath)
    ? alternatesGitPath
    : resolve(fixtureRoot, alternatesGitPath);
  try {
    const stats = await lstat(alternatesPath);
    assert.equal(stats.isSymbolicLink(), false, "fixture object alternates path must not be a symlink");
    assert.equal(stats.isFile(), true, "fixture object alternates path must be a regular file");
    assert.equal(stats.size, 0, "fixture object alternates path must be empty");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const [{ stdout: revisionOutput }, { stdout: objectFormatOutput }] = await Promise.all([
    execFileAsync(gitExecutable, [
      ...gitIdentityArguments,
      "rev-parse",
      "--verify",
      "--end-of-options",
      "HEAD^{commit}",
    ], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env,
    }),
    execFileAsync(gitExecutable, [
      ...gitIdentityArguments,
      "rev-parse",
      "--show-object-format=storage",
    ], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env,
    }),
  ]);
  const sourceRevision = revisionOutput.trim();
  const objectFormat = objectFormatOutput.trim();
  const objectIdWidth = gitObjectFormatWidth[objectFormat];
  assert.notEqual(objectIdWidth, undefined, "fixture Git object format must be sha1 or sha256");
  assert.equal(sourceRevision.length, objectIdWidth);
  assert.match(sourceRevision, /^[a-f0-9]+$/u);
  const { stdout: treeManifest } = await execFileAsync(
    gitExecutable,
    [...gitIdentityArguments, "ls-tree", "-r", "-z", "--full-tree", sourceRevision, "--"],
    {
      cwd: fixtureRoot,
      encoding: null,
      env,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  let recordOffset = 0;
  while (recordOffset < treeManifest.length) {
    const recordEnd = treeManifest.indexOf(0, recordOffset);
    assert.notEqual(recordEnd, -1, "fixture tree manifest record must be NUL terminated");
    const record = treeManifest.subarray(recordOffset, recordEnd);
    const pathSeparator = record.indexOf(0x09);
    assert.ok(pathSeparator > 0 && pathSeparator < record.length - 1);
    const header = record.subarray(0, pathSeparator).toString("ascii");
    const headerMatch = /^(?<mode>[0-7]{6}) (?<type>blob|commit) (?<objectId>[a-f0-9]+)$/u.exec(header);
    assert.notEqual(headerMatch, null, "fixture tree manifest header must use the documented shape");
    const { mode, type, objectId } = headerMatch.groups;
    assert.notEqual(mode, "160000", "fixture candidates must not contain gitlinks");
    assert.notEqual(type, "commit", "fixture candidates must not contain submodules");
    assert.equal(type, "blob");
    assert.ok(["100644", "100755", "120000"].includes(mode));
    assert.equal(objectId.length, objectIdWidth);
    recordOffset = recordEnd + 1;
  }
  const manifestDomain = Buffer.from(
    `${gitTreeManifestDomain}\0objectFormat=${objectFormat}\0`,
    "ascii",
  );
  return {
    sourceRevision,
    treeSha256: createHash("sha256")
      .update(manifestDomain)
      .update(treeManifest)
      .digest("hex"),
  };
}

test("Proxmox contract pins the Linux CLI template and two Codex lanes", async () => {
  const { contract, contractSchema, toolchainLock, evidenceSchema } = await loadFixture();

  validateProxmoxContract(contract, contractSchema);
  validateToolchainLock(toolchainLock, contract);

  assert.deepEqual(contract.scope, {
    surface: "linux-cli-only",
    proxmoxVeBaseline: "8.4",
    guest: {
      operatingSystem: "linux",
      distribution: "ubuntu",
      release: "24.04 LTS",
      architecture: "x86_64",
    },
    supportedProducts: ["codex-cli"],
    excludedSurfaces: ["arm64", "codex-desktop", "codex-ide", "macos", "windows"],
  });
  assert.deepEqual(contract.hardware.cpu, {
    architecture: "x86_64",
    type: "x86-64-v2-AES",
    sockets: 1,
    cores: 4,
    totalVcpus: 4,
    numa: false,
  });
  assert.deepEqual(contract.hardware.memory, { sizeMiB: 8192, ballooning: false });
  assert.equal(contract.hardware.machine, "q35");
  assert.equal(contract.hardware.firmware, "ovmf");
  assert.equal(contract.hardware.disk.sizeGiB, 64);
  assert.equal(contract.hardware.disk.controller, "virtio-scsi-single");
  assert.equal(
    evidenceSchema.properties.candidate.properties.treeSha256.description,
    "SHA-256 of the bytes nelos.proxmox.candidate-tree.git-ls-tree.v1\\0objectFormat=<sha1|sha256>\\0 followed by the hardened raw git ls-tree -r -z --full-tree sourceRevision -- output.",
  );
  assert.equal(contract.hardware.disk.storageScope, "node-local");
  assert.equal(contract.hardware.network.model, "virtio");
  assert.equal(contract.hardware.network.bridge, "vmbr0");
  assert.equal(contract.hardware.network.addressing, "dhcp");
  assert.deepEqual(contract.retention, {
    activeGeneration: "indefinite",
    replacedGenerationMinimumDays: 30,
    minimumValidatedGenerations: 2,
    disposableArtifacts: "destroy-after-reconciliation",
  });
  assert.deepEqual(contract.hardware.vmIdPolicy, {
    scope: "cluster-wide",
    unique: true,
    allocation: "external",
  });
  assert.equal(contract.lanes["legacy-01446"].codexVersion, "0.144.6");
  assert.equal(contract.lanes["agent-plugin-01470"].codexVersion, "0.147.0");
});

test("contract requires per-run state, a fresh process, and denied validation network", async () => {
  const { contract, contractSchema } = await loadFixture();

  assert.equal(contract.isolation.environment.HOME, "${LANE_ROOT}/home");
  assert.equal(contract.isolation.environment.CODEX_HOME, "${LANE_ROOT}/home/.codex");
  assert.equal(contract.isolation.freshCodexProcessPerVerification, true);
  assert.equal(contract.isolation.sharedMutableState, false);
  assert.equal(contract.validation.offline, true);
  assert.equal(contract.validation.validationNetwork, "denied");
  assert.deepEqual(contract.isolation.forbiddenHostInputs, [
    "mac-authentication-state",
    "mac-codex-config",
    "mac-filesystem-mounts",
    "mac-plugin-cache",
    "ssh-agent-forwarding",
  ]);

  const unknownField = structuredClone(contract);
  unknownField.hardware.network.staticAddress = "disabled";
  assert.throws(
    () => validateProxmoxContract(unknownField, contractSchema),
    /\/hardware\/network\/staticAddress: unknown field/u,
  );

  const reusedProcess = structuredClone(contract);
  reusedProcess.isolation.freshCodexProcessPerVerification = false;
  assert.throws(
    () => validateProxmoxContract(reusedProcess, contractSchema),
    /\/isolation\/freshCodexProcessPerVerification: must equal true/u,
  );
});

test("toolchain lock rejects drift from immutable artifacts and lane IDs", async () => {
  const { contract, toolchainLock } = await loadFixture();

  assert.deepEqual(Object.fromEntries(
    Object.entries(toolchainLock.artifacts).map(([name, artifact]) => [name, artifact.version]),
  ), {
    packer: "1.15.4",
    packerProxmoxPlugin: "1.2.4",
    ubuntuCloudImage: "release-20260801",
    node: "24.18.0",
    codexLegacy: "0.144.6",
    codexAgentPlugin: "0.147.0",
  });
  for (const artifact of Object.values(toolchainLock.artifacts)) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.match(artifact.url, /^https:\/\//u);
  }
  assert.equal(toolchainLock.policy.ubuntuAptSnapshot, "20260801T120000Z");

  const floating = structuredClone(toolchainLock);
  floating.policy.allowFloatingVersions = true;
  assert.throws(() => validateToolchainLock(floating, contract), /\/policy:/u);

  const changedDigest = structuredClone(toolchainLock);
  changedDigest.artifacts.codexAgentPlugin.sha256 = "f".repeat(64);
  assert.throws(
    () => validateToolchainLock(changedDigest, contract),
    /\/artifacts\/codexAgentPlugin: does not match the immutable artifact pin/u,
  );

  const floatingSnapshot = structuredClone(toolchainLock);
  floatingSnapshot.policy.ubuntuAptSnapshot = "latest";
  assert.throws(
    () => validateToolchainLock(floatingSnapshot, contract),
    /\/policy\/ubuntuAptSnapshot: must be an immutable UTC snapshot ID/u,
  );
});

test("executable recipe matches the immutable lock and guarded contract", async () => {
  const { toolchainLock } = await loadFixture();
  assert.equal(await validateRecipeSources(root, toolchainLock), true);

  const [buildWrapper, bootstrap, provisionGuest, proxmoxSource] = await Promise.all([
    readFile(join(validationRoot, "scripts", "build-template.sh"), "utf8"),
    readFile(join(validationRoot, "scripts", "bootstrap-cloud-image-template.sh"), "utf8"),
    readFile(join(validationRoot, "scripts", "provision-guest.sh"), "utf8"),
    readFile(join(validationRoot, "packer", "proxmox.pkr.hcl"), "utf8"),
  ]);
  assert.match(buildWrapper, /"\$PACKER_BIN" build -on-error=abort/u);
  assert.match(buildWrapper, /NELOS_PACKER_STATE_DIR/u);
  assert.match(buildWrapper, /EXPECTED_PACKER_SOURCES/u);
  assert.match(buildWrapper, /SEALED_PACKER_DIR/u);
  assert.match(buildWrapper, /materialize_tracked/u);
  assert.match(buildWrapper, /download_verified/u);
  assert.match(buildWrapper, /PATH=\/usr\/bin:\/bin/u);
  assert.match(buildWrapper, /GIT_ATTR_NOSYSTEM=1/u);
  assert.match(buildWrapper, /GIT_GRAFT_FILE=\/dev\/null/u);
  assert.match(buildWrapper, /GIT_NO_LAZY_FETCH=1/u);
  assert.match(buildWrapper, /GIT_NO_REPLACE_OBJECTS=1/u);
  assert.match(buildWrapper, /GIT_REF_PARANOIA=1/u);
  assert.match(buildWrapper, /\/usr\/bin\/git\s+\\\n\s+--no-replace-objects/u);
  for (const gitControl of [
    "--literal-pathspecs",
    "--no-optional-locks",
    "-c core.useReplaceRefs=false",
    "-c core.attributesFile=/dev/null",
    "-c core.commitGraph=false",
    "-c core.multiPackIndex=false",
    "-c core.fsmonitor=false",
    "-c core.untrackedCache=false",
  ]) {
    assert.equal(buildWrapper.includes(gitControl), true);
  }
  assert.match(buildWrapper, /git_readonly status --porcelain=v1 --untracked-files=all/u);
  const replacementRefGuard = "git_readonly for-each-ref --format='%(refname)' refs/replace/";
  const replacementRefGuardIndex = buildWrapper.indexOf(replacementRefGuard);
  const alternatesGuardIndex = buildWrapper.indexOf(
    'reject_git_backend_file "${git_common_dir}/objects/info/alternates"',
  );
  const partialCloneGuardIndex = buildWrapper.indexOf("extensions.partialclone");
  const sourceRevisionIndex = buildWrapper.indexOf("SOURCE_REVISION=");
  assert.notEqual(replacementRefGuardIndex, -1);
  assert.notEqual(alternatesGuardIndex, -1);
  assert.notEqual(partialCloneGuardIndex, -1);
  assert.ok(replacementRefGuardIndex < sourceRevisionIndex);
  assert.ok(alternatesGuardIndex < sourceRevisionIndex);
  assert.ok(partialCloneGuardIndex < sourceRevisionIndex);
  assert.ok(replacementRefGuardIndex < buildWrapper.indexOf("materialize_tracked()"));
  assert.match(
    buildWrapper,
    /git_readonly rev-parse --verify --end-of-options 'HEAD\^\{commit\}'/u,
  );
  assert.match(buildWrapper, /git_readonly rev-parse --show-object-format=storage/u);
  assert.match(buildWrapper, /GIT_OBJECT_ID_WIDTH=40/u);
  assert.match(buildWrapper, /GIT_OBJECT_ID_WIDTH=64/u);
  assert.match(buildWrapper, /source_record != \*\$'\\n'\*/u);
  const catFileIndex = buildWrapper.indexOf('git_readonly cat-file blob "$source_object" >"$destination"');
  const hashObjectIndex = buildWrapper.indexOf(
    'git_readonly hash-object --no-filters -- "$destination"',
  );
  assert.notEqual(catFileIndex, -1);
  assert.notEqual(hashObjectIndex, -1);
  assert.ok(catFileIndex < hashObjectIndex);
  assert.equal(
    buildWrapper.includes(
      '($scsiDisk[1:] | sort) == ["discard=on", "iothread=1", "size=64G", "ssd=1"]',
    ),
    true,
  );
  assert.match(bootstrap, /--net0 'virtio,bridge=vmbr0,firewall=1,queues=4'/u);
  assert.match(bootstrap, /pre-enrolled-keys=0/u);
  assert.match(bootstrap, /discard=on,iothread=1,ssd=1/u);
  assert.doesNotMatch(bootstrap, /--(?:destroy-unreferenced-disks|purge|skiplock)/u);
  assert.match(bootstrap, /APT::Snapshot \\"\$\{UBUNTU_APT_SNAPSHOT\}\\";/u);
  assert.match(provisionGuest, /-o APT::Snapshot="\$UBUNTU_APT_SNAPSHOT"/u);
  assert.match(
    provisionGuest,
    /apt-get\s+\\\n\s+--error-on=any\s+\\\n\s+-o DPkg::Lock::Timeout=300\s+\\\n\s+-o Acquire::Retries=3\s+\\\n\s+-o APT::Snapshot="\$UBUNTU_APT_SNAPSHOT"\s+\\\n\s+update/u,
  );
  assert.match(proxmoxSource, /bridge\s*=\s*"vmbr0"/u);
  assert.match(proxmoxSource, /firewall\s*=\s*true/u);
  assert.doesNotMatch(proxmoxSource, /ssh_(?:agent_auth|private_key_file)/u);
});

test("build Git preflight rejects packed replacements and nonlocal object backends", async (context) => {
  await context.test("packed replacement refs", async (subcontext) => {
    const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(subcontext);
    const { sourceRevision } = await readGitCandidateIdentity(fixtureRoot);
    const replacementDirectory = join(fixtureRoot, ".git", "refs", "replace");
    await mkdir(replacementDirectory, { recursive: true });
    await writeFile(
      join(replacementDirectory, sourceRevision),
      `${sourceRevision}\n`,
      { mode: 0o600 },
    );
    await execFileAsync("git", ["pack-refs", "--all"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: cleanGitEnvironment(),
    });
    await assert.rejects(
      runBuildGitPreflight(artifactRoot, fixtureRoot),
      (error) => {
        assert.equal(error?.code, 1);
        assert.match(error?.stderr ?? "", /source checkout replacement refs are forbidden/u);
        return true;
      },
    );
  });

  await context.test("object alternates", async (subcontext) => {
    const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(subcontext);
    await writeFile(
      join(fixtureRoot, ".git", "objects", "info", "alternates"),
      `${join(artifactRoot, "external-objects")}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      runBuildGitPreflight(artifactRoot, fixtureRoot),
      (error) => {
        assert.equal(error?.code, 1);
        assert.match(error?.stderr ?? "", /object alternates file must be absent or an empty regular file/u);
        return true;
      },
    );
  });

  await context.test("partial-clone and promisor configuration", async (subcontext) => {
    const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(subcontext);
    await execFileAsync("git", ["config", "remote.origin.promisor", "true"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: cleanGitEnvironment(),
    });
    await assert.rejects(
      runBuildGitPreflight(artifactRoot, fixtureRoot),
      (error) => {
        assert.equal(error?.code, 1);
        assert.match(
          error?.stderr ?? "",
          /source checkout partial-clone and promisor configuration is forbidden/u,
        );
        return true;
      },
    );
  });
});

test("Proxmox preflight closes storage types and base configuration", async () => {
  const [buildWrapper, bootstrap] = await Promise.all([
    readFile(join(validationRoot, "scripts", "build-template.sh"), "utf8"),
    readFile(join(validationRoot, "scripts", "bootstrap-cloud-image-template.sh"), "utf8"),
  ]);
  const { stdout: jqVersionOutput } = await execFileAsync("jq", ["--version"], {
    encoding: "utf8",
  });
  assert.match(jqVersionOutput.trim(), /^jq-[0-9]+[.][0-9]+(?:[.][0-9]+)?$/u);

  const linkedCloneStorageTypeContract = 'readonly LINKED_CLONE_STORAGE_TYPES_CSV="lvmthin,zfspool"';
  const fullCopyStorageTypeContract = 'readonly FULL_COPY_STORAGE_TYPES_CSV="dir,lvm,lvmthin,zfspool"';
  const blockCloudInitStorageTypeContract = 'readonly BLOCK_CLOUD_INIT_STORAGE_TYPES_CSV="lvm,lvmthin,zfspool"';
  assert.equal(buildWrapper.includes(linkedCloneStorageTypeContract), true);
  assert.equal(bootstrap.includes(linkedCloneStorageTypeContract), true);
  assert.equal(buildWrapper.includes(fullCopyStorageTypeContract), true);
  assert.equal(bootstrap.includes(fullCopyStorageTypeContract), true);
  assert.equal(buildWrapper.includes(blockCloudInitStorageTypeContract), true);
  assert.equal(bootstrap.includes('readonly SNIPPET_STORAGE_TYPES_CSV="dir"'), true);
  assert.doesNotMatch(linkedCloneStorageTypeContract, /(?:^|[,="])lvm(?:[,"]|$)/u);
  assert.match(fullCopyStorageTypeContract, /(?:^|[,="])lvm(?:[,"]|$)/u);
  assert.match(bootstrap, /unless \$allowed_types\{\$data->\{type\} \/\/ q\{\}\}/u);
  assert.equal((bootstrap.match(/images "\$LINKED_CLONE_STORAGE_TYPES_CSV"/gu) ?? []).length, 2);
  assert.equal((bootstrap.match(/images "\$FULL_COPY_STORAGE_TYPES_CSV"/gu) ?? []).length, 1);
  assert.match(bootstrap, /snippets "\$SNIPPET_STORAGE_TYPES_CSV"/u);
  assert.match(bootstrap, /pvesh get "\/nodes\/\$\{PROXMOX_NODE\}\/storage\/\$\{storage\}\/status"/u);
  assert.match(bootstrap, /\$data->\{active\} \/\/ 0\) == 1 && \(\$data->\{enabled\} \/\/ 0\) == 1/u);
  assert.equal((buildWrapper.match(/--arg allowed_storage_types/gu) ?? []).length, 1);
  assert.equal((buildWrapper.match(/\(\(\.data\.shared \/\/ 0\) == 0\)/gu) ?? []).length, 1);
  assert.match(buildWrapper, /\[\.data\.scsi0, \.data\.efidisk0\]/u);
  assert.match(buildWrapper, /\.data\.ide2 \| split\(","\)\[0\]/u);
  assert.match(
    buildWrapper,
    /assert_api_storage "\$persistent_disk_storage" "\$LINKED_CLONE_STORAGE_TYPES_CSV"/u,
  );
  assert.match(buildWrapper, /"inherited Cloud-Init" \\\n  "\$inherited_cloud_init_volume"/u);
  assert.match(buildWrapper, /assert_api_storage "\$CLOUD_INIT_STORAGE" "\$FULL_COPY_STORAGE_TYPES_CSV"/u);
  assert.match(buildWrapper, /api_get "nodes\/\$\{PROXMOX_NODE\}\/storage\/\$\{storage\}\/status"/u);
  assert.match(buildWrapper, /\.data\.active == 1 and \.data\.enabled == 1/u);

  assert.match(buildWrapper, /\/config\?current=1/u);
  assert.match(buildWrapper, /qemu\/\$\{BASE_TEMPLATE_VMID\}\/pending/u);
  const requiredConfigKeys = [
    "agent",
    "balloon",
    "bios",
    "boot",
    "citype",
    "ciupgrade",
    "ciuser",
    "cores",
    "cpu",
    "description",
    "efidisk0",
    "ide2",
    "ipconfig0",
    "machine",
    "memory",
    "meta",
    "name",
    "net0",
    "ostype",
    "scsi0",
    "scsihw",
    "serial0",
    "smbios1",
    "sockets",
    "tags",
    "template",
    "vga",
    "vmgenid",
  ];
  const optionalConfigKeys = ["arch", "onboot"];
  const apiMetadataKeys = ["digest"];
  const forbiddenConfigKeys = [
    "amd-sev",
    "args",
    "bootdisk",
    "cdrom",
    "cicustom",
    "cipassword",
    "hookscript",
    "ivshmem",
    "nameserver",
    "runningcpu",
    "runningmachine",
    "searchdomain",
    "spice_enhancements",
    "sshkeys",
    "tablet",
    "vmstate",
    "watchdog",
  ];
  for (const [constantName, keys] of [
    ["BASE_TEMPLATE_REQUIRED_CONFIG_KEYS_JSON", requiredConfigKeys],
    ["BASE_TEMPLATE_OPTIONAL_CONFIG_KEYS_JSON", optionalConfigKeys],
    ["BASE_TEMPLATE_API_METADATA_KEYS_JSON", apiMetadataKeys],
    ["BASE_TEMPLATE_FORBIDDEN_CONFIG_KEYS_JSON", forbiddenConfigKeys],
  ]) {
    assert.equal(
      buildWrapper.includes(`readonly ${constantName}='${JSON.stringify(keys)}'`),
      true,
      constantName,
    );
  }

  const extractJqProgram = (name) => {
    const marker = "readonly " + name + "='";
    const start = buildWrapper.indexOf(marker);
    assert.notEqual(start, -1);
    const bodyStart = start + marker.length;
    const bodyEnd = buildWrapper.indexOf("'\n", bodyStart);
    assert.notEqual(bodyEnd, -1);
    return buildWrapper.slice(bodyStart, bodyEnd);
  };
  const baseTemplateConfigInventoryJq = extractJqProgram("BASE_TEMPLATE_CONFIG_INVENTORY_JQ");
  const baseTemplatePendingConfigJq = extractJqProgram("BASE_TEMPLATE_PENDING_CONFIG_JQ");
  const baseTemplateApprovedConfigValuesJq = extractJqProgram(
    "BASE_TEMPLATE_APPROVED_CONFIG_VALUES_JQ",
  );
  const baseTemplateCloudInitConfigJq = extractJqProgram("BASE_TEMPLATE_CLOUD_INIT_CONFIG_JQ");
  const cloudInitDeviceJq = extractJqProgram("BASE_CLOUD_INIT_DEVICE_JQ");
  const cloudInitStorageJq = extractJqProgram("CLOUD_INIT_STORAGE_VOLUME_JQ");
  assert.match(baseTemplatePendingConfigJq, /\.data \| type == "array"/u);
  assert.match(
    baseTemplatePendingConfigJq,
    /\(has\("pending"\) or has\("delete"\)\) \| not/u,
  );
  assert.match(baseTemplatePendingConfigJq, /\(keys \| sort\) == \["key", "value"\]/u);
  assert.match(
    baseTemplateConfigInventoryJq,
    /\$required_config_keys \+ \$api_metadata_keys\) - \$actualKeys/u,
  );
  assert.match(baseTemplateConfigInventoryJq, /\$actualKeys - \(/u);
  assert.match(baseTemplateConfigInventoryJq, /\$forbidden_config_keys/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /\.data\.balloon == 0/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /\.data\.boot == "order=scsi0"/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /x86-64-v2-AES/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /\.data\.ostype == "l26"/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /\.data\.serial0 == "socket"/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /\.data\.vga == "serial0"/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /\.data\.vmgenid/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /pre-enrolled-keys=0/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /"ssd=1"/u);
  assert.match(baseTemplateApprovedConfigValuesJq, /"queues=4"/u);
  for (const cloudInitKey of ["citype", "ciuser", "ciupgrade", "ipconfig0"]) {
    assert.match(baseTemplateCloudInitConfigJq, new RegExp(`\\.data\\.${cloudInitKey}`, "u"));
  }
  for (const forbiddenCloudInitKey of [
    "cicustom",
    "cipassword",
    "nameserver",
    "searchdomain",
    "sshkeys",
  ]) {
    assert.equal(baseTemplateCloudInitConfigJq.includes(`. == "${forbiddenCloudInitKey}"`), true);
  }
  assert.match(cloudInitDeviceJq, /== \["media=cdrom"\]/u);
  assert.match(cloudInitDeviceJq, /== \["media=cdrom", "size=4M"\]/u);
  assert.match(cloudInitDeviceJq, /vm-" \+ \$vmidString \+ "-cloudinit/u);
  assert.match(cloudInitDeviceJq, /-cloudinit\.qcow2/u);
  assert.match(cloudInitStorageJq, /\$storageType == "dir"/u);
  assert.match(cloudInitStorageJq, /index\(\$storageType\)/u);

  const jqAccepts = async (argumentsList, program) => {
    try {
      await execFileAsync("jq", ["-n", "-e", ...argumentsList, program], { encoding: "utf8" });
      return true;
    } catch (error) {
      if (error?.code === 1) return false;
      throw error;
    }
  };
  assert.equal(await jqAccepts([], "false"), false);
  await assert.rejects(jqAccepts([], "invalid("));
  await assert.rejects(jqAccepts([], 'error("forced jq runtime failure")'));
  const imageDigest = "0".repeat(64);
  const safeBaseConfig = {
    data: {
      agent: "enabled=1,fstrim_cloned_disks=1",
      balloon: 0,
      bios: "ovmf",
      boot: "order=scsi0",
      citype: "nocloud",
      ciupgrade: 0,
      ciuser: "ubuntu",
      cores: 4,
      cpu: "x86-64-v2-AES",
      description: `Nelos validator base; Ubuntu 24.04 release-20260801; ubuntu-sha256:${imageDigest}`,
      digest: "a".repeat(40),
      efidisk0: "local-lvm:base-9020-disk-0,efitype=4m,pre-enrolled-keys=0,size=4M",
      ide2: "local-lvm:vm-9020-cloudinit,media=cdrom",
      ipconfig0: "ip=dhcp",
      machine: "q35",
      memory: 8192,
      meta: "creation-qemu=9.2.0,ctime=1786233600",
      name: "nelos-ubuntu-2404-base",
      net0: "virtio=BC:24:11:22:33:44,bridge=vmbr0,firewall=1,queues=4",
      ostype: "l26",
      scsi0: "local-lvm:base-9020-disk-1,discard=on,iothread=1,size=64G,ssd=1",
      scsihw: "virtio-scsi-single",
      serial0: "socket",
      smbios1: "uuid=b3247ab1-1fe6-428e-965b-08a1b64a8746",
      sockets: 1,
      tags: "nelos-validator-base;ubuntu-24-04;ubuntu-release-20260801",
      template: 1,
      vga: "serial0",
      vmgenid: "7079e97c-50e3-4079-afe7-23e67566b946",
    },
  };
  const acceptsBaseInventory = (config) =>
    jqAccepts(
      [
        "--argjson", "config", JSON.stringify(config),
        "--argjson", "required_config_keys", JSON.stringify(requiredConfigKeys),
        "--argjson", "optional_config_keys", JSON.stringify(optionalConfigKeys),
        "--argjson", "api_metadata_keys", JSON.stringify(apiMetadataKeys),
        "--argjson", "forbidden_config_keys", JSON.stringify(forbiddenConfigKeys),
      ],
      "$config | " + baseTemplateConfigInventoryJq,
    );
  const acceptsPendingConfig = (config) =>
    jqAccepts(
      ["--argjson", "config", JSON.stringify(config)],
      "$config | " + baseTemplatePendingConfigJq,
    );
  const acceptsApprovedConfigValues = (config) =>
    jqAccepts(
      [
        "--argjson", "config", JSON.stringify(config),
        "--arg", "digest", imageDigest,
        "--arg", "name", "nelos-ubuntu-2404-base",
        "--argjson", "vmid", "9020",
      ],
      "$config | " + baseTemplateApprovedConfigValuesJq,
    );
  const acceptsCloudInitConfig = (config) =>
    jqAccepts(
      ["--argjson", "config", JSON.stringify(config)],
      "$config | " + baseTemplateCloudInitConfigJq,
    );

  assert.equal(await acceptsBaseInventory(safeBaseConfig), true);
  const healthyPendingResponse = {
    data: [
      { key: "balloon", value: 0 },
      { key: "boot", value: "order=scsi0" },
      { key: "template", value: 1 },
    ],
  };
  assert.equal(await acceptsPendingConfig(healthyPendingResponse), true);
  for (const invalidPendingResponse of [
    { data: [{ key: "hostpci0", pending: "0000:01:00.0" }] },
    { data: [{ delete: 1, key: "boot", value: "order=scsi0" }] },
    { data: [] },
    { data: {} },
    { data: [{ key: "boot" }] },
    { data: [{ value: "order=scsi0" }] },
    { data: [{ extra: true, key: "boot", value: "order=scsi0" }] },
    { data: [{ key: "boot", value: null }] },
    { data: [{ key: "boot", value: "order=scsi0" }, { key: "boot", value: "order=scsi0" }] },
  ]) {
    assert.equal(
      await acceptsPendingConfig(invalidPendingResponse),
      false,
      JSON.stringify(invalidPendingResponse),
    );
  }
  assert.equal(await acceptsApprovedConfigValues(safeBaseConfig), true);
  assert.equal(await acceptsCloudInitConfig(safeBaseConfig), true);

  for (const forbiddenConfigKey of [...forbiddenConfigKeys, "hostpci0", "future-pve-key"]) {
    const unexpectedConfig = structuredClone(safeBaseConfig);
    unexpectedConfig.data[forbiddenConfigKey] = "unexpected";
    assert.equal(await acceptsBaseInventory(unexpectedConfig), false, forbiddenConfigKey);
  }
  for (const requiredConfigKey of requiredConfigKeys) {
    const incompleteConfig = structuredClone(safeBaseConfig);
    delete incompleteConfig.data[requiredConfigKey];
    assert.equal(await acceptsBaseInventory(incompleteConfig), false, requiredConfigKey);
  }
  for (const apiMetadataKey of apiMetadataKeys) {
    const missingApiMetadata = structuredClone(safeBaseConfig);
    delete missingApiMetadata.data[apiMetadataKey];
    assert.equal(await acceptsBaseInventory(missingApiMetadata), false, apiMetadataKey);
  }
  for (const [optionalConfigKey, value] of [
    ["arch", "x86_64"],
    ["onboot", 0],
  ]) {
    const optionalConfig = structuredClone(safeBaseConfig);
    optionalConfig.data[optionalConfigKey] = value;
    assert.equal(await acceptsBaseInventory(optionalConfig), true, optionalConfigKey);
    assert.equal(await acceptsApprovedConfigValues(optionalConfig), true, optionalConfigKey);
  }

  const reorderedAgentOptions = structuredClone(safeBaseConfig);
  reorderedAgentOptions.data.agent = "fstrim_cloned_disks=1,enabled=1";
  assert.equal(await acceptsApprovedConfigValues(reorderedAgentOptions), true);
  const explicitCpuProperty = structuredClone(safeBaseConfig);
  explicitCpuProperty.data.cpu = "cputype=x86-64-v2-AES";
  assert.equal(await acceptsApprovedConfigValues(explicitCpuProperty), true);
  const lowerCaseMac = structuredClone(safeBaseConfig);
  lowerCaseMac.data.net0 = "queues=4,firewall=1,bridge=vmbr0,virtio=bc:24:11:22:33:44";
  assert.equal(await acceptsApprovedConfigValues(lowerCaseMac), true);
  for (const efiSize of ["528K", "1M", "4M"]) {
    const validEfiVolume = structuredClone(safeBaseConfig);
    validEfiVolume.data.efidisk0 =
      `local-lvm:base-9020-disk-0,size=${efiSize},pre-enrolled-keys=0,efitype=4m`;
    assert.equal(
      await acceptsApprovedConfigValues(validEfiVolume),
      true,
      validEfiVolume.data.efidisk0,
    );
  }
  const reorderedScsiOptions = structuredClone(safeBaseConfig);
  reorderedScsiOptions.data.scsi0 =
    "local-lvm:base-9020-disk-1,ssd=1,size=64G,iothread=1,discard=on";
  assert.equal(await acceptsApprovedConfigValues(reorderedScsiOptions), true);
  const distinctStorageScsi = structuredClone(safeBaseConfig);
  distinctStorageScsi.data.scsi0 =
    "local-zfs:base-9020-disk-0,discard=on,iothread=1,size=64G,ssd=1";
  assert.equal(await acceptsApprovedConfigValues(distinctStorageScsi), true);

  for (const [field, value] of [
    ["agent", "enabled=1"],
    ["agent", "enabled=1,fstrim_cloned_disks=1,type=isa"],
    ["arch", "aarch64"],
    ["balloon", 1],
    ["balloon", "0"],
    ["bios", "seabios"],
    ["boot", "order=ide2;scsi0"],
    ["cores", 8],
    ["cpu", "host"],
    ["cpu", "x86-64-v2-AES,flags=+aes"],
    ["description", `${safeBaseConfig.data.description};unexpected`],
    ["digest", "not-a-sha1"],
    ["machine", "q35,viommu=intel"],
    ["memory", 16384],
    ["meta", "creation-qemu=9.2.0"],
    ["meta", "creation-qemu=9.2.0,ctime=1786233600,unexpected=1"],
    ["name", "another-template"],
    ["onboot", 1],
    ["onboot", "0"],
    ["ostype", "other"],
    ["scsihw", "virtio-scsi-pci"],
    ["serial0", "/dev/ttyS0"],
    ["smbios1", `${safeBaseConfig.data.smbios1},manufacturer=unexpected`],
    ["smbios1", "uuid=00000000-0000-0000-0000-000000000000"],
    ["sockets", 2],
    ["tags", `${safeBaseConfig.data.tags};unexpected`],
    ["template", 0],
    ["vga", "qxl"],
    ["vmgenid", "0"],
    ["vmgenid", "00000000-0000-0000-0000-000000000000"],
    ["vmgenid", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"],
    ["vmgenid", safeBaseConfig.data.smbios1.slice("uuid=".length)],
  ]) {
    const invalidApprovedConfig = structuredClone(safeBaseConfig);
    invalidApprovedConfig.data[field] = value;
    assert.equal(await acceptsApprovedConfigValues(invalidApprovedConfig), false, `${field}=${value}`);
  }

  for (const invalidNetwork of [
    "e1000=BC:24:11:22:33:44,bridge=vmbr0,firewall=1,queues=4",
    "virtio=BD:24:11:22:33:44,bridge=vmbr0,firewall=1,queues=4",
    "virtio=00:00:00:00:00:00,bridge=vmbr0,firewall=1,queues=4",
    "virtio=BC:24:11:22:33:44,bridge=vmbr1,firewall=1,queues=4",
    "virtio=BC:24:11:22:33:44,bridge=vmbr0,firewall=0,queues=4",
    "virtio=BC:24:11:22:33:44,bridge=vmbr0,firewall=1",
    "virtio=BC:24:11:22:33:44,bridge=vmbr0,firewall=1,queues=8",
    "virtio=BC:24:11:22:33:44,bridge=vmbr0,firewall=1,queues=4,tag=10",
    "virtio=BC:24:11:22:33:44,bridge=vmbr0,firewall=1,queues=4,queues=4",
  ]) {
    const invalidNetworkConfig = structuredClone(safeBaseConfig);
    invalidNetworkConfig.data.net0 = invalidNetwork;
    assert.equal(await acceptsApprovedConfigValues(invalidNetworkConfig), false, invalidNetwork);
  }
  for (const invalidEfiDisk of [
    "local-lvm:vm-9020-disk-0,efitype=4m,pre-enrolled-keys=0,size=4M",
    "local-lvm:base-9021-disk-0,efitype=4m,pre-enrolled-keys=0,size=4M",
    "local-lvm:base-9020-disk-1,efitype=4m,pre-enrolled-keys=0,size=4M",
    "local-lvm:base-9020-disk-0,efitype=2m,pre-enrolled-keys=0,size=4M",
    "local-lvm:base-9020-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M",
    "local-lvm:base-9020-disk-0,efitype=4m,pre-enrolled-keys=0,size=8M",
    "local-lvm:base-9020-disk-0,efitype=4m,pre-enrolled-keys=0",
    "local-lvm:base-9020-disk-0,efitype=4m,pre-enrolled-keys=0,size=4M,format=raw",
    "local-lvm:base-9020-disk-0,efitype=4m,efitype=4m,pre-enrolled-keys=0,size=4M",
  ]) {
    const invalidEfiConfig = structuredClone(safeBaseConfig);
    invalidEfiConfig.data.efidisk0 = invalidEfiDisk;
    assert.equal(await acceptsApprovedConfigValues(invalidEfiConfig), false, invalidEfiDisk);
  }
  for (const invalidScsiDisk of [
    "local-lvm:vm-9020-disk-1,discard=on,iothread=1,size=64G,ssd=1",
    "local-lvm:base-9021-disk-1,discard=on,iothread=1,size=64G,ssd=1",
    "local-lvm:base-9020-disk-0,discard=on,iothread=1,size=64G,ssd=1",
    "local-zfs:base-9020-disk-1,discard=on,iothread=1,size=64G,ssd=1",
    "local-zfs:base-9020-disk-2,discard=on,iothread=1,size=64G,ssd=1",
    "local-lvm:base-9020-disk-1,discard=off,iothread=1,size=64G,ssd=1",
    "local-lvm:base-9020-disk-1,discard=on,iothread=0,size=64G,ssd=1",
    "local-lvm:base-9020-disk-1,discard=on,iothread=1,size=32G,ssd=1",
    "local-lvm:base-9020-disk-1,discard=on,iothread=1,size=64G",
    "local-lvm:base-9020-disk-1,discard=on,iothread=1,size=64G,ssd=1,cache=none",
    "local-lvm:base-9020-disk-1,discard=on,iothread=1,size=64G,ssd=1,ssd=1",
  ]) {
    const invalidScsiConfig = structuredClone(safeBaseConfig);
    invalidScsiConfig.data.scsi0 = invalidScsiDisk;
    assert.equal(await acceptsApprovedConfigValues(invalidScsiConfig), false, invalidScsiDisk);
  }

  for (const [field, value] of [
    ["citype", "configdrive2"],
    ["ciupgrade", 1],
    ["ciuser", "root"],
    ["ipconfig0", "ip6=auto,ip=dhcp"],
  ]) {
    const invalidCloudInitConfig = structuredClone(safeBaseConfig);
    invalidCloudInitConfig.data[field] = value;
    assert.equal(await acceptsCloudInitConfig(invalidCloudInitConfig), false, `${field}=${value}`);
  }
  for (const forbiddenCloudInitKey of [
    "cicustom",
    "cipassword",
    "nameserver",
    "searchdomain",
    "sshkeys",
  ]) {
    const inheritedCloudInitValue = structuredClone(safeBaseConfig);
    inheritedCloudInitValue.data[forbiddenCloudInitKey] = "unexpected";
    assert.equal(await acceptsCloudInitConfig(inheritedCloudInitValue), false, forbiddenCloudInitKey);
  }
  const acceptsCloudInitDevice = async (storageType, ide2) => {
    const deviceAccepted = await jqAccepts(
      ["--argjson", "vmid", "9020", "--arg", "ide2", ide2],
      '{"data":{"ide2":$ide2}} | ' + cloudInitDeviceJq,
    );
    if (!deviceAccepted) return false;
    const volumeId = ide2.split(",", 1)[0];
    const separator = volumeId.indexOf(":");
    const volume = separator === -1 ? "" : volumeId.slice(separator + 1);
    return jqAccepts(
      [
        "--argjson", "base_vmid", "9020",
        "--arg", "block_storage_types", "lvm,lvmthin,zfspool",
        "--arg", "cloud_init_volume", volume,
        "--arg", "storage_type", storageType,
      ],
      '{"data":{"type":$storage_type}} | ' + cloudInitStorageJq,
    );
  };

  for (const [storageType, ide2] of [
    ["lvm", "local-lvm:vm-9020-cloudinit,media=cdrom"],
    ["lvmthin", "local-lvm:vm-9020-cloudinit,media=cdrom,size=4M"],
    ["zfspool", "local-zfs:vm-9020-cloudinit,size=4M,media=cdrom"],
    ["dir", "local:9020/vm-9020-cloudinit.qcow2,media=cdrom"],
  ]) {
    assert.equal(await acceptsCloudInitDevice(storageType, ide2), true, ide2);
  }
  for (const [storageType, ide2] of [
    ["dir", "local:iso/ubuntu.iso,media=cdrom"],
    ["lvmthin", "local-lvm:vm-9020-disk-1,media=cdrom"],
    ["lvmthin", "local-lvm:vm-9021-cloudinit,media=cdrom"],
    ["dir", "local:9020/vm-9020-cloudinit.raw,media=cdrom"],
    ["dir", "local:vm-9020-cloudinit,media=cdrom"],
    ["lvmthin", "local-lvm:9020/vm-9020-cloudinit.qcow2,media=cdrom"],
    ["lvmthin", "local-lvm:vm-9020-cloudinit"],
    ["lvmthin", "local-lvm:vm-9020-cloudinit,media=disk"],
    ["lvmthin", "local-lvm:vm-9020-cloudinit,media=cdrom,media=cdrom"],
    ["lvmthin", "local-lvm:vm-9020-cloudinit,media=cdrom,size=4096K"],
    ["lvmthin", "local-lvm:vm-9020-cloudinit,media=cdrom,cache=none"],
  ]) {
    assert.equal(await acceptsCloudInitDevice(storageType, ide2), false, ide2);
  }
});

test("sanitized evidence validates isolated fresh-process lane parity", async () => {
  const { contract, evidenceSchema } = await loadFixture();
  const evidence = createEvidenceProbe(contract);

  validateEvidenceDocument(evidence, evidenceSchema, contract);
  assert.equal(evidence.sanitization.status, "passed");
  assert.equal(evidence.sanitization.credentialsCaptured, false);
  assert.equal(evidence.lanes["legacy-01446"].checks.laneParity, true);
  assert.equal(evidence.lanes["agent-plugin-01470"].checks.laneParity, true);

  const sha256Revision = structuredClone(evidence);
  sha256Revision.candidate.sourceRevision = "a".repeat(64);
  validateEvidenceDocument(sha256Revision, evidenceSchema, contract);

  const incompleteRevision = structuredClone(evidence);
  incompleteRevision.candidate.sourceRevision = "a".repeat(48);
  assert.throws(
    () => validateEvidenceDocument(incompleteRevision, evidenceSchema, contract),
    /sourceRevision: must match/u,
  );

  const wrongRun = structuredClone(evidence);
  wrongRun.runId = "another-run";
  assert.throws(
    () => validateEvidenceDocument(wrongRun, evidenceSchema, contract),
    /must be isolated beneath this evidence run ID/u,
  );

  const missingPluginData = structuredClone(evidence);
  missingPluginData.lanes["agent-plugin-01470"].processObservation.observedEnvironmentKeys = [
    "CODEX_HOME",
    "HOME",
    "PLUGIN_ROOT",
  ];
  assert.throws(
    () => validateEvidenceDocument(missingPluginData, evidenceSchema, contract),
    /must include PLUGIN_DATA/u,
  );

  const failedWithMissingPluginData = structuredClone(missingPluginData);
  failedWithMissingPluginData.lanes["agent-plugin-01470"].checks.nelosConfigGet = false;
  failedWithMissingPluginData.lanes["agent-plugin-01470"].checks.laneParity = false;
  failedWithMissingPluginData.lanes["legacy-01446"].checks.laneParity = false;
  failedWithMissingPluginData.result = {
    status: "failed",
    failures: ["agent-plugin.process.required-environment-missing"],
  };
  validateEvidenceDocument(failedWithMissingPluginData, evidenceSchema, contract);

  const pluginInstallFailedWithMcpSuccess = structuredClone(evidence);
  pluginInstallFailedWithMcpSuccess.lanes["agent-plugin-01470"].checks.pluginInstall = false;
  pluginInstallFailedWithMcpSuccess.result = {
    status: "failed",
    failures: ["agent-plugin.plugin.install-failed"],
  };
  assert.throws(
    () => validateEvidenceDocument(pluginInstallFailedWithMcpSuccess, evidenceSchema, contract),
    /cannot pass before plugin installation succeeds/u,
  );

  const pluginInstallWithoutMarketplace = structuredClone(evidence);
  pluginInstallWithoutMarketplace.lanes["agent-plugin-01470"].checks.marketplaceInstall = false;
  pluginInstallWithoutMarketplace.result = {
    status: "failed",
    failures: ["agent-plugin.marketplace.install-failed"],
  };
  assert.throws(
    () => validateEvidenceDocument(pluginInstallWithoutMarketplace, evidenceSchema, contract),
    /cannot pass before marketplace installation succeeds/u,
  );

  const mismatchedTools = structuredClone(evidence);
  mismatchedTools.lanes["agent-plugin-01470"].toolNames = ["another_tool"];
  assert.throws(
    () => validateEvidenceDocument(mismatchedTools, evidenceSchema, contract),
    /\/lanes\/agent-plugin-01470\/toolNames: must contain exactly nelos_config_get/u,
  );

  const missingRequiredTool = structuredClone(evidence);
  missingRequiredTool.lanes["legacy-01446"].toolNames = ["another_tool"];
  missingRequiredTool.lanes["agent-plugin-01470"].toolNames = ["another_tool"];
  assert.throws(
    () => validateEvidenceDocument(missingRequiredTool, evidenceSchema, contract),
    /must include nelos_config_get/u,
  );

  const failedEvidence = structuredClone(evidence);
  failedEvidence.lanes["agent-plugin-01470"].checks.toolsList = false;
  failedEvidence.lanes["agent-plugin-01470"].checks.nelosConfigGet = false;
  failedEvidence.lanes["agent-plugin-01470"].checks.laneParity = false;
  failedEvidence.lanes["legacy-01446"].checks.laneParity = false;
  failedEvidence.result = {
    status: "failed",
    failures: ["agent-plugin.tools-list.missing-required-tool"],
  };
  validateEvidenceDocument(failedEvidence, evidenceSchema, contract);

  const failedMissingTool = structuredClone(evidence);
  failedMissingTool.lanes["legacy-01446"].toolNames = ["another_tool"];
  failedMissingTool.lanes["legacy-01446"].checks.toolsList = false;
  failedMissingTool.lanes["legacy-01446"].checks.nelosConfigGet = false;
  failedMissingTool.lanes["legacy-01446"].checks.laneParity = false;
  failedMissingTool.lanes["agent-plugin-01470"].checks.laneParity = false;
  failedMissingTool.result = {
    status: "failed",
    failures: ["legacy.tools-list.missing-required-tool"],
  };
  validateEvidenceDocument(failedMissingTool, evidenceSchema, contract);

  const failedBeforeProcessStart = structuredClone(evidence);
  failedBeforeProcessStart.lanes["agent-plugin-01470"].freshProcess = false;
  failedBeforeProcessStart.lanes["agent-plugin-01470"].processObservation.observedEnvironmentKeys = [];
  failedBeforeProcessStart.lanes["agent-plugin-01470"].toolNames = [];
  failedBeforeProcessStart.lanes["agent-plugin-01470"].checks.freshProcessStart = false;
  failedBeforeProcessStart.lanes["agent-plugin-01470"].checks.mcpInitialize = false;
  failedBeforeProcessStart.lanes["agent-plugin-01470"].checks.toolsList = false;
  failedBeforeProcessStart.lanes["agent-plugin-01470"].checks.nelosConfigGet = false;
  failedBeforeProcessStart.lanes["agent-plugin-01470"].checks.laneParity = false;
  failedBeforeProcessStart.lanes["legacy-01446"].checks.laneParity = false;
  failedBeforeProcessStart.result = {
    status: "failed",
    failures: ["agent-plugin.process.start-failed"],
  };
  validateEvidenceDocument(failedBeforeProcessStart, evidenceSchema, contract);

  const inconsistentProcessStart = structuredClone(failedBeforeProcessStart);
  inconsistentProcessStart.lanes["agent-plugin-01470"].freshProcess = true;
  assert.throws(
    () => validateEvidenceDocument(inconsistentProcessStart, evidenceSchema, contract),
    /must match the observed fresh-process start check/u,
  );

  const prelaunchWithDownstreamSuccess = structuredClone(failedBeforeProcessStart);
  prelaunchWithDownstreamSuccess.lanes["agent-plugin-01470"].checks.mcpInitialize = true;
  assert.throws(
    () => validateEvidenceDocument(prelaunchWithDownstreamSuccess, evidenceSchema, contract),
    /cannot pass before a fresh process starts/u,
  );

  const prelaunchWithProcessObservation = structuredClone(failedBeforeProcessStart);
  prelaunchWithProcessObservation.lanes["agent-plugin-01470"].processObservation.observedEnvironmentKeys = ["HOME"];
  assert.throws(
    () => validateEvidenceDocument(prelaunchWithProcessObservation, evidenceSchema, contract),
    /must be empty when no process was observed/u,
  );

  const prelaunchWithToolObservation = structuredClone(failedBeforeProcessStart);
  prelaunchWithToolObservation.lanes["agent-plugin-01470"].toolNames = ["nelos_config_get"];
  assert.throws(
    () => validateEvidenceDocument(prelaunchWithToolObservation, evidenceSchema, contract),
    /must be empty when no fresh process started/u,
  );

  const failedMcpWithToolSuccess = structuredClone(evidence);
  failedMcpWithToolSuccess.lanes["agent-plugin-01470"].checks.mcpInitialize = false;
  failedMcpWithToolSuccess.result = {
    status: "failed",
    failures: ["agent-plugin.mcp.initialize-failed"],
  };
  assert.throws(
    () => validateEvidenceDocument(failedMcpWithToolSuccess, evidenceSchema, contract),
    /tool checks cannot pass before MCP initialization/u,
  );

  const failedMcpInitialization = structuredClone(evidence);
  failedMcpInitialization.lanes["agent-plugin-01470"].toolNames = [];
  failedMcpInitialization.lanes["agent-plugin-01470"].checks.mcpInitialize = false;
  failedMcpInitialization.lanes["agent-plugin-01470"].checks.toolsList = false;
  failedMcpInitialization.lanes["agent-plugin-01470"].checks.nelosConfigGet = false;
  failedMcpInitialization.lanes["agent-plugin-01470"].checks.laneParity = false;
  failedMcpInitialization.lanes["legacy-01446"].checks.laneParity = false;
  failedMcpInitialization.result = {
    status: "failed",
    failures: ["agent-plugin.mcp.initialize-failed"],
  };
  validateEvidenceDocument(failedMcpInitialization, evidenceSchema, contract);

  const failedMcpWithStaleTools = structuredClone(failedMcpInitialization);
  failedMcpWithStaleTools.lanes["agent-plugin-01470"].toolNames = ["nelos_config_get"];
  assert.throws(
    () => validateEvidenceDocument(failedMcpWithStaleTools, evidenceSchema, contract),
    /must be empty before MCP initialization succeeds/u,
  );

  const asymmetricLaneParity = structuredClone(evidence);
  asymmetricLaneParity.lanes["agent-plugin-01470"].checks.laneParity = false;
  asymmetricLaneParity.result = {
    status: "failed",
    failures: ["lane.parity-mismatch"],
  };
  assert.throws(
    () => validateEvidenceDocument(asymmetricLaneParity, evidenceSchema, contract),
    /lane parity must report the same result in both lanes/u,
  );

  const failedWithInvalidToolClaim = structuredClone(evidence);
  failedWithInvalidToolClaim.lanes["legacy-01446"].toolNames = ["another_tool"];
  failedWithInvalidToolClaim.lanes["legacy-01446"].checks.laneParity = false;
  failedWithInvalidToolClaim.lanes["agent-plugin-01470"].checks.laneParity = false;
  failedWithInvalidToolClaim.result = {
    status: "failed",
    failures: ["legacy.tools-list.invalid-tool-claim"],
  };
  assert.throws(
    () => validateEvidenceDocument(failedWithInvalidToolClaim, evidenceSchema, contract),
    /must include nelos_config_get when its check passes/u,
  );

  const passedWithFailedCheck = structuredClone(evidence);
  passedWithFailedCheck.lanes["legacy-01446"].checks.toolsList = false;
  passedWithFailedCheck.lanes["legacy-01446"].checks.nelosConfigGet = false;
  passedWithFailedCheck.lanes["legacy-01446"].checks.laneParity = false;
  passedWithFailedCheck.lanes["agent-plugin-01470"].checks.laneParity = false;
  assert.throws(
    () => validateEvidenceDocument(passedWithFailedCheck, evidenceSchema, contract),
    /passed evidence requires every lane check to pass/u,
  );

  const failedWithAllChecks = structuredClone(evidence);
  failedWithAllChecks.result = {
    status: "failed",
    failures: ["synthetic.failure-without-failed-check"],
  };
  assert.throws(
    () => validateEvidenceDocument(failedWithAllChecks, evidenceSchema, contract),
    /failed evidence requires at least one failed lane check/u,
  );

  const unsafeEvidence = structuredClone(evidence);
  unsafeEvidence.runId = "validator-192.0.2.10";
  unsafeEvidence.lanes["legacy-01446"].home = "/var/lib/nelos-validator/runs/validator-192.0.2.10/legacy-01446/home";
  unsafeEvidence.lanes["legacy-01446"].codexHome = `${unsafeEvidence.lanes["legacy-01446"].home}/.codex`;
  unsafeEvidence.lanes["agent-plugin-01470"].home = "/var/lib/nelos-validator/runs/validator-192.0.2.10/agent-plugin-01470/home";
  unsafeEvidence.lanes["agent-plugin-01470"].codexHome = `${unsafeEvidence.lanes["agent-plugin-01470"].home}/.codex`;
  assert.throws(
    () => validateEvidenceDocument(unsafeEvidence, evidenceSchema, contract),
    /must not contain user-specific host, address, identity, or home material/u,
  );
});

test("repository validator runs with network APIs blocked", async () => {
  assert.equal(gitExecutable, "/usr/bin/git");
  for (const control of [
    "--literal-pathspecs",
    "--no-optional-locks",
    "core.commitGraph=false",
    "core.multiPackIndex=false",
    "core.fsmonitor=false",
    "core.untrackedCache=false",
  ]) {
    assert.equal(gitIdentityArguments.includes(control), true);
  }
  assert.deepEqual(
    {
      PATH: cleanGitEnvironment().PATH,
      GIT_NO_LAZY_FETCH: cleanGitEnvironment().GIT_NO_LAZY_FETCH,
      GIT_REF_PARANOIA: cleanGitEnvironment().GIT_REF_PARANOIA,
    },
    { PATH: "/usr/bin:/bin", GIT_NO_LAZY_FETCH: "1", GIT_REF_PARANOIA: "1" },
  );
  assert.deepEqual(await validateRepositoryContract(root), {
    valid: true,
    offline: true,
    contractVersion: "1.0.0",
    lanes: ["legacy-01446", "agent-plugin-01470"],
  });

  const blocker = fileURLToPath(new URL("../../../scripts/offline-network-blocker.cjs", import.meta.url));
  const validator = fileURLToPath(new URL("../scripts/validate-contract.mjs", import.meta.url));
  const validatorSource = await readFile(validator, "utf8");
  for (const sealedGitControl of [
    'const GIT_EXECUTABLE = "/usr/bin/git"',
    'PATH: "/usr/bin:/bin"',
    'GIT_NO_LAZY_FETCH: "1"',
    'GIT_REF_PARANOIA: "1"',
    '"--literal-pathspecs"',
    '"--no-optional-locks"',
    '"-c", "core.commitGraph=false"',
    '"-c", "core.multiPackIndex=false"',
    '"-c", "core.fsmonitor=false"',
    '"-c", "core.untrackedCache=false"',
    'rejectGitControlFile(root, "objects/info/alternates"',
    'key === "extensions.partialclone"',
    '["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]',
  ]) {
    assert.equal(validatorSource.includes(sealedGitControl), true);
  }
  const unsafeStateGateIndex = validatorSource.indexOf("await rejectUnsafeGitState(canonicalRoot)");
  const statusReadIndex = validatorSource.indexOf(
    '["status", "--porcelain=v1", "--untracked-files=all"]',
  );
  const revisionReadIndex = validatorSource.indexOf(
    '["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]',
  );
  assert.notEqual(unsafeStateGateIndex, -1);
  assert.ok(unsafeStateGateIndex < statusReadIndex);
  assert.ok(unsafeStateGateIndex < revisionReadIndex);
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--require", blocker, validator, "--root", root],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    valid: true,
    offline: true,
    contractVersion: "1.0.0",
    lanes: ["legacy-01446", "agent-plugin-01470"],
  });
});

test("repository evidence binds the exact clean candidate and contract bytes", async (context) => {
  const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(context);
  const fixtureValidationRoot = join(fixtureRoot, "validation", "proxmox");
  const [contractBytes, toolchainLockBytes, contract, candidateIdentity] = await Promise.all([
    readFile(join(fixtureValidationRoot, "contract.json")),
    readFile(join(fixtureValidationRoot, "toolchain.lock.json")),
    readJson(join(fixtureValidationRoot, "contract.json")),
    readGitCandidateIdentity(fixtureRoot),
  ]);
  const contractSha256 = createHash("sha256").update(contractBytes).digest("hex");
  const toolchainLockSha256 = createHash("sha256").update(toolchainLockBytes).digest("hex");
  const tamperDigest = (digest) => `${digest.startsWith("0") ? "1" : "0"}${digest.slice(1)}`;
  const evidence = createEvidenceProbe(contract, {
    contractSha256,
    toolchainLockSha256,
    ...candidateIdentity,
  });
  const evidencePath = join(artifactRoot, "evidence.json");
  const runFixtureGit = (argumentsList, env = cleanGitEnvironment()) => execFileAsync(
    "git",
    argumentsList,
    { cwd: fixtureRoot, encoding: "utf8", env },
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });

  await validateRepositoryContract(fixtureRoot, { evidencePath });
  const blocker = fileURLToPath(new URL("../../../scripts/offline-network-blocker.cjs", import.meta.url));
  const validator = fileURLToPath(new URL("../scripts/validate-contract.mjs", import.meta.url));
  const { stderr } = await execFileAsync(
    process.execPath,
    ["--require", blocker, validator, "--root", fixtureRoot, "--evidence", evidencePath],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(stderr, "");

  evidence.template.contractSha256 = tamperDigest(contractSha256);
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/template\/contractSha256: must match the SHA-256 digest of the repository contract\.json bytes/u,
  );

  evidence.template.contractSha256 = contractSha256;
  evidence.template.toolchainLockSha256 = tamperDigest(toolchainLockSha256);
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/template\/toolchainLockSha256: must match the SHA-256 digest of the repository toolchain\.lock\.json bytes/u,
  );

  evidence.template.toolchainLockSha256 = toolchainLockSha256;
  evidence.candidate.sourceRevision = tamperDigest(candidateIdentity.sourceRevision);
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/sourceRevision: must match the exact clean repository checkout/u,
  );

  evidence.candidate.sourceRevision = candidateIdentity.sourceRevision;
  evidence.candidate.treeSha256 = tamperDigest(candidateIdentity.treeSha256);
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/treeSha256: must match the exact clean repository checkout/u,
  );

  evidence.candidate.treeSha256 = candidateIdentity.treeSha256;
  await writeFile(evidencePath, JSON.stringify(evidence) + "\n", { mode: 0o600 });

  await runFixtureGit(["config", "core.autocrlf", "true"]);
  await validateRepositoryContract(fixtureRoot, { evidencePath });
  const externalAttributes = join(artifactRoot, "external-attributes");
  await writeFile(externalAttributes, "* export-ignore\n", { mode: 0o600 });
  await runFixtureGit(["config", "core.attributesFile", externalAttributes]);
  await validateRepositoryContract(fixtureRoot, { evidencePath });
  await runFixtureGit(["config", "--unset-all", "core.autocrlf"]);
  await runFixtureGit(["config", "--unset-all", "core.attributesFile"]);

  const fsmonitorHook = join(artifactRoot, "fsmonitor-hook");
  const fsmonitorSentinel = `${fsmonitorHook}.invoked`;
  await writeFile(
    fsmonitorHook,
    "#!/bin/sh\n: >\"${0}.invoked\"\nprintf '%s\\n' token\n",
    { mode: 0o700 },
  );
  await chmod(fsmonitorHook, 0o700);
  await runFixtureGit(["config", "core.fsmonitor", fsmonitorHook]);
  await runFixtureGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.equal(await readFile(fsmonitorSentinel, "utf8"), "");
  await rm(fsmonitorSentinel, { force: true });
  await validateRepositoryContract(fixtureRoot, { evidencePath });
  await assert.rejects(readFile(fsmonitorSentinel), { code: "ENOENT" });
  await runFixtureGit(["config", "--unset-all", "core.fsmonitor"]);

  const alternates = join(fixtureRoot, ".git", "objects", "info", "alternates");
  await writeFile(alternates, `${join(artifactRoot, "external-objects")}\n`, { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/gitMetadata: repository-local objects\/info\/alternates must be absent or an empty regular file/u,
  );
  await rm(alternates, { force: true });

  const promisorHelper = join(artifactRoot, "promisor-upload-pack");
  const promisorSentinel = `${promisorHelper}.invoked`;
  await writeFile(
    promisorHelper,
    "#!/bin/sh\n: >\"${0}.invoked\"\nexit 1\n",
    { mode: 0o700 },
  );
  await chmod(promisorHelper, 0o700);
  await runFixtureGit(["config", "remote.origin.url", `file://${fixtureRoot}`]);
  await runFixtureGit(["config", "remote.origin.uploadpack", promisorHelper]);
  await runFixtureGit(["config", "remote.origin.promisor", "true"]);
  await runFixtureGit(["config", "remote.origin.partialCloneFilter", "blob:none"]);
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/objectBackend: partial-clone and promisor configuration is forbidden/u,
  );
  await assert.rejects(readFile(promisorSentinel), { code: "ENOENT" });
  for (const key of [
    "remote.origin.partialCloneFilter",
    "remote.origin.promisor",
    "remote.origin.uploadpack",
    "remote.origin.url",
  ]) {
    await runFixtureGit(["config", "--unset-all", key]);
  }
  await validateRepositoryContract(fixtureRoot, { evidencePath });

  await runFixtureGit(["config", "tar.umask", "0077"]);
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/archiveConfig: repository and worktree tar\.\* configuration is forbidden/u,
  );
  await runFixtureGit(["config", "--unset-all", "tar.umask"]);

  await runFixtureGit(["config", "extensions.worktreeConfig", "true"]);
  await runFixtureGit(["config", "--worktree", "tar.tar.command", "cat"]);
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/archiveConfig: repository and worktree tar\.\* configuration is forbidden/u,
  );
  await runFixtureGit(["config", "--worktree", "--unset-all", "tar.tar.command"]);

  const infoAttributes = join(fixtureRoot, ".git", "info", "attributes");
  await writeFile(infoAttributes, "", { mode: 0o600 });
  await validateRepositoryContract(fixtureRoot, { evidencePath });
  await writeFile(infoAttributes, "* export-ignore\n", { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/gitMetadata: repository-local info\/attributes must be absent or an empty regular file/u,
  );
  await rm(infoAttributes, { force: true });
  const symlinkTarget = join(artifactRoot, "empty-attributes-target");
  await writeFile(symlinkTarget, "", { mode: 0o600 });
  await symlink(symlinkTarget, infoAttributes);
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/gitMetadata: repository-local info\/attributes must be absent or an empty regular file/u,
  );
  await rm(infoAttributes, { force: true });

  const grafts = join(fixtureRoot, ".git", "info", "grafts");
  await writeFile(grafts, candidateIdentity.sourceRevision + "\n", { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/gitMetadata: repository-local info\/grafts must be absent or an empty regular file/u,
  );
  await rm(grafts, { force: true });

  const replaceDirectory = join(fixtureRoot, ".git", "refs", "replace");
  await mkdir(replaceDirectory, { recursive: true });
  await writeFile(
    join(replaceDirectory, candidateIdentity.sourceRevision),
    candidateIdentity.sourceRevision + "\n",
    { mode: 0o600 },
  );
  await runFixtureGit(["pack-refs", "--all"]);
  const replaceRefName = `refs/replace/${candidateIdentity.sourceRevision}`;
  const { stdout: packedReplacementRefs } = await runFixtureGit([
    ...gitIdentityArguments,
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace/",
  ]);
  assert.equal(packedReplacementRefs.trim(), replaceRefName);
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/replacements: replacement refs are forbidden for evidence candidates/u,
  );
  await runFixtureGit(["update-ref", "-d", replaceRefName]);
  await rm(replaceDirectory, { recursive: true, force: true });

  await writeFile(join(fixtureRoot, ".gitattributes"), "* export-ignore\n", { mode: 0o600 });
  await runFixtureGit(["add", ".gitattributes"], commitGitEnvironment());
  await runFixtureGit(
    ["commit", "--quiet", "--message", "add archive attributes"],
    commitGitEnvironment(),
  );
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/attributes: tracked \.gitattributes files require an explicit archive policy/u,
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await writeFile(join(fixtureRoot, "untracked-dirty-sentinel"), "dirty\n", { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/dirty: evidence requires an exactly clean Git checkout/u,
  );
});

test("repository evidence rejects gitlink candidates before accepting their identity", async (context) => {
  const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(context);
  const fixtureValidationRoot = join(fixtureRoot, "validation", "proxmox");
  const [contractBytes, toolchainLockBytes, contract, candidateIdentity] = await Promise.all([
    readFile(join(fixtureValidationRoot, "contract.json")),
    readFile(join(fixtureValidationRoot, "toolchain.lock.json")),
    readJson(join(fixtureValidationRoot, "contract.json")),
    readGitCandidateIdentity(fixtureRoot),
  ]);
  const evidence = createEvidenceProbe(contract, {
    contractSha256: createHash("sha256").update(contractBytes).digest("hex"),
    toolchainLockSha256: createHash("sha256").update(toolchainLockBytes).digest("hex"),
    ...candidateIdentity,
  });
  const evidencePath = join(artifactRoot, "gitlink-evidence.json");
  await execFileAsync(
    "git",
    [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${candidateIdentity.sourceRevision},vendor/plugin`,
    ],
    { cwd: fixtureRoot, encoding: "utf8", env: commitGitEnvironment() },
  );
  await execFileAsync(
    "git",
    ["commit", "--quiet", "--message", "add forbidden gitlink"],
    { cwd: fixtureRoot, encoding: "utf8", env: commitGitEnvironment() },
  );
  await mkdir(join(fixtureRoot, "vendor", "plugin"), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });

  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/gitlinks: Gitlink and submodule entries are forbidden for evidence candidates/u,
  );
});

test("validation contract files contain no user-specific machine material", async () => {
  const files = [
    "contract.json",
    "contract.schema.json",
    "toolchain.lock.json",
    join("evidence", "schema.json"),
  ];
  const contents = (await Promise.all(
    files.map((path) => readFile(join(validationRoot, path), "utf8")),
  )).join("\n");

  assert.doesNotMatch(contents, /\/Users\//u);
  assert.doesNotMatch(contents, /\b(?:\d{1,3}\.){3}\d{1,3}\b/u);
  assert.doesNotMatch(contents, /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/u);
  assert.doesNotMatch(contents, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
  assert.doesNotMatch(contents, /\b(?:bobby|sayers)\b/iu);
});
