import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath as fsRealpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
import {
  computeDistributionIntegrity,
  DISTRIBUTION_ENTRIES,
} from "../../../src/distribution-provenance.mjs";

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

async function runProcessWithInput(executable, argumentsList, input, { env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argumentsList, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let spawnError;

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      if (spawnError) {
        rejectPromise(spawnError);
        return;
      }
      resolvePromise({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") spawnError = error;
    });
    child.stdin.end(input);
  });
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

function createAgentPluginLayout(pluginManifest) {
  return {
    pluginManifest: {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: pluginManifest.name,
      version: pluginManifest.version,
      description: pluginManifest.description,
      author: pluginManifest.author,
      homepage: pluginManifest.homepage,
      repository: pluginManifest.repository,
      license: pluginManifest.license,
      keywords: pluginManifest.keywords,
    },
    mcpManifest: {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        nelos: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/bin/nelos-mcp"],
          env: {
            NELOS_PLUGIN_VERSION: pluginManifest.version,
            NELOS_RELEASE_BUILD_IDENTITY: pluginManifest.releaseBuildIdentity,
          },
        },
      },
    },
  };
}

async function refreshFixtureDistributionProvenance(fixtureRoot) {
  const pluginManifest = await readJson(join(fixtureRoot, ".codex-plugin", "plugin.json"));
  let distributionProvenance;
  try {
    distributionProvenance = await readJson(join(fixtureRoot, "distribution-provenance.json"));
  } catch {
    distributionProvenance = await readJson(join(root, "distribution-provenance.json"));
  }
  distributionProvenance.revision = pluginManifest.version;
  distributionProvenance.cacheIdentity =
    `https://github.com/virusimmortal00/nelos.git#nelos@${pluginManifest.version}`;
  distributionProvenance.integrity = await computeDistributionIntegrity(fixtureRoot);
  await writeFile(
    join(fixtureRoot, "distribution-provenance.json"),
    `${JSON.stringify(distributionProvenance, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function createCleanRepositoryFixture(context) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "nelos-proxmox-repository-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const fixtureRoot = join(temporaryRoot, "repository");
  await mkdir(join(fixtureRoot, "validation"), { recursive: true });
  await cp(validationRoot, join(fixtureRoot, "validation", "proxmox"), { recursive: true });
  await mkdir(join(fixtureRoot, ".codex-plugin"), { recursive: true });
  await cp(
    join(root, ".codex-plugin", "plugin.json"),
    join(fixtureRoot, ".codex-plugin", "plugin.json"),
  );
  await cp(join(root, ".mcp.json"), join(fixtureRoot, ".mcp.json"));
  const legacyPluginManifest = await readJson(join(fixtureRoot, ".codex-plugin", "plugin.json"));
  const { pluginManifest, mcpManifest } = createAgentPluginLayout(legacyPluginManifest);
  await Promise.all([
    writeFile(join(fixtureRoot, "plugin.json"), `${JSON.stringify(pluginManifest, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(fixtureRoot, "mcp.json"), `${JSON.stringify(mcpManifest, null, 2)}\n`, { mode: 0o600 }),
  ]);
  for (const entry of DISTRIBUTION_ENTRIES) {
    const target = join(fixtureRoot, entry);
    try {
      await lstat(target);
      continue;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const sourceStats = await lstat(join(root, entry));
    if (sourceStats.isDirectory()) {
      await mkdir(target, { recursive: true });
      await writeFile(join(target, ".fixture"), `${entry}\n`, { mode: 0o600 });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${entry}\n`, { mode: 0o600 });
    }
  }
  await refreshFixtureDistributionProvenance(fixtureRoot);
  const env = commitGitEnvironment();
  await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot, env });
  await execFileAsync("git", ["add", "--all"], { cwd: fixtureRoot, env });
  await execFileAsync("git", ["commit", "--quiet", "--message", "contract fixture"], { cwd: fixtureRoot, env });
  return { artifactRoot: temporaryRoot, fixtureRoot };
}

async function runBuildGitPreflight(artifactRoot, fixtureRoot) {
  const canonicalArtifactRoot = await fsRealpath(artifactRoot);
  const attestationDirectory = join(canonicalArtifactRoot, "attestation-ssh");
  const attestationIdentity = join(attestationDirectory, "id_ed25519");
  const attestationKnownHosts = join(attestationDirectory, "known_hosts");
  const attestationBaseline = join(attestationDirectory, "trusted-baseline.json");
  await mkdir(attestationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(attestationIdentity, "test-private-key\n", { mode: 0o600 });
  await writeFile(attestationKnownHosts, "pve.invalid ssh-ed25519 test-host-key\n", { mode: 0o400 });
  await writeFile(attestationBaseline, "{}\n", { mode: 0o600 });
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
  return execFileAsync("/bin/bash", [buildWrapper], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      PATH: `${facadeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PROXMOX_URL: "https://pve.invalid:8006/api2/json",
      PROXMOX_USERNAME: "builder@pve!nelos",
      PROXMOX_TOKEN: "test-token",
      NELOS_PACKER_STATE_DIR: join(artifactRoot, "packer-state"),
      NELOS_BASE_ATTESTATION_SSH_TARGET: "nelos-attester@192.0.2.10",
      NELOS_BASE_ATTESTATION_SSH_IDENTITY_FILE: attestationIdentity,
      NELOS_BASE_ATTESTATION_KNOWN_HOSTS_FILE: attestationKnownHosts,
      NELOS_BASE_ATTESTATION_BASELINE_FILE: attestationBaseline,
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
    assert.notEqual(mode, "120000", "fixture candidates must not contain tracked symlinks");
    assert.notEqual(type, "commit", "fixture candidates must not contain submodules");
    assert.equal(type, "blob");
    assert.ok(["100644", "100755"].includes(mode));
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
    distributionIntegrity: await computeDistributionIntegrity(fixtureRoot),
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
  assert.equal(contract.hardware.network.bridge, "nelosbld");
  assert.equal(contract.hardware.network.addressing, "dhcp");
  assert.deepEqual(contract.validation.buildNetwork, {
    mode: "preconfigured-restricted-vnet",
    bridge: "nelosbld",
    dhcpSource: "restricted-vnet",
    defaultEgressPolicy: "deny",
    dnsPolicy: "restricted-host-allowlist-only",
    allowedTcpPorts: [443],
    allowedGuestHosts: [
      "github.com",
      "nodejs.org",
      "release-assets.githubusercontent.com",
      "snapshot.ubuntu.com",
    ],
  });
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

  assert.deepEqual(contract.isolation.environment, {
    HOME: "${LANE_ROOT}/home",
    CODEX_HOME: "${LANE_ROOT}/home/.codex",
    TMPDIR: "${LANE_ROOT}/tmp",
    XDG_CONFIG_HOME: "${LANE_ROOT}/xdg/config",
    XDG_CACHE_HOME: "${LANE_ROOT}/xdg/cache",
    XDG_DATA_HOME: "${LANE_ROOT}/xdg/data",
  });
  assert.equal(contract.isolation.freshCodexProcessPerVerification, true);
  assert.equal(contract.isolation.sharedMutableState, false);
  assert.equal(contract.validation.offline, true);
  assert.equal(contract.validation.validationNetwork, "denied");
  assert.deepEqual(contract.validation.requiredObservations, ["network-denied-during-validation"]);
  assert.deepEqual(contract.lanes["legacy-01446"].requiredEnvironment, [
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
  ]);
  assert.deepEqual(contract.lanes["agent-plugin-01470"].requiredEnvironment, [
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "PLUGIN_ROOT",
    "PLUGIN_DATA",
  ]);
  assert.deepEqual(contract.validation.sanitization.allowedEnvironmentKeys, [
    "CODEX_HOME",
    "HOME",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "NELOS_PLUGIN_VERSION",
    "NELOS_RELEASE_BUILD_IDENTITY",
    "PLUGIN_DATA",
    "PLUGIN_ROOT",
  ]);
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

  const ordinaryBuildBridge = structuredClone(contract);
  ordinaryBuildBridge.hardware.network.bridge = "vmbr0";
  ordinaryBuildBridge.validation.buildNetwork.bridge = "vmbr0";
  assert.throws(
    () => validateProxmoxContract(ordinaryBuildBridge, contractSchema),
    /\/hardware\/network\/bridge: must equal "nelosbld"/u,
  );

  const openBuildEgress = structuredClone(contract);
  openBuildEgress.validation.buildNetwork.defaultEgressPolicy = "allow";
  assert.throws(
    () => validateProxmoxContract(openBuildEgress, contractSchema),
    /\/validation\/buildNetwork\/defaultEgressPolicy: must equal "deny"/u,
  );

  const extraGuestHost = structuredClone(contract);
  extraGuestHost.validation.buildNetwork.allowedGuestHosts.push("objects.githubusercontent.com");
  assert.throws(
    () => validateProxmoxContract(extraGuestHost, contractSchema),
    /\/validation\/buildNetwork\/allowedGuestHosts/u,
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
  assert.deepEqual(toolchainLock.policy.buildNetwork, contract.validation.buildNetwork);

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

  const ordinaryBridge = structuredClone(toolchainLock);
  ordinaryBridge.policy.buildNetwork.bridge = "vmbr0";
  assert.throws(
    () => validateToolchainLock(ordinaryBridge, contract),
    /\/policy:/u,
  );
});

test("executable recipe matches the immutable lock and guarded contract", async () => {
  const { toolchainLock } = await loadFixture();
  assert.equal(await validateRecipeSources(root, toolchainLock), true);

  const [buildWrapper, bootstrap, diskAttester, provisionGuest, proxmoxSource] = await Promise.all([
    readFile(join(validationRoot, "scripts", "build-template.sh"), "utf8"),
    readFile(join(validationRoot, "scripts", "bootstrap-cloud-image-template.sh"), "utf8"),
    readFile(join(validationRoot, "scripts", "attest-base-template-disks.sh"), "utf8"),
    readFile(join(validationRoot, "scripts", "provision-guest.sh"), "utf8"),
    readFile(join(validationRoot, "packer", "proxmox.pkr.hcl"), "utf8"),
  ]);
  assert.match(buildWrapper, /"\$PACKER_BIN" build -on-error=abort/u);
  assert.match(buildWrapper, /NELOS_PACKER_STATE_DIR/u);
  assert.match(buildWrapper, /EXPECTED_PACKER_SOURCES/u);
  assert.match(buildWrapper, /SEALED_PACKER_DIR/u);
  assert.match(buildWrapper, /materialize_tracked/u);
  assert.match(buildWrapper, /assert_candidate_tree_regular/u);
  assert.match(
    buildWrapper,
    /git_readonly ls-tree -r -z --full-tree "\$SOURCE_REVISION" --/u,
  );
  assert.match(buildWrapper, /\/usr\/bin\/perl -0ne/u);
  assert.match(buildWrapper, /--candidate-revision "\$SOURCE_REVISION"/u);
  assert.match(buildWrapper, /download_verified/u);
  assert.match(buildWrapper, /PATH=\/usr\/bin:\/bin/u);
  assert.match(
    buildWrapper,
    /\[\[ -x \/usr\/bin\/curl && -f \/usr\/bin\/curl && ! -L \/usr\/bin\/curl \]\]/u,
  );
  assert.match(
    buildWrapper,
    /\[\[ -x \/usr\/bin\/env && -f \/usr\/bin\/env && ! -L \/usr\/bin\/env \]\]/u,
  );
  const apiGetFunction = /^api_get\(\) \{\n[\s\S]*?^\}\n/mu.exec(buildWrapper)?.[0];
  assert.notEqual(apiGetFunction, undefined);
  for (const authenticatedApiControl of [
    "command builtin printf",
    "/usr/bin/env -i",
    "PATH=/usr/bin:/bin",
    "LC_ALL=C",
    "HOME=/nonexistent",
    "/usr/bin/curl --disable",
    "--config -",
  ]) {
    assert.equal(apiGetFunction.includes(authenticatedApiControl), true, authenticatedApiControl);
  }
  assert.equal((buildWrapper.match(/PVEAPIToken=/gu) ?? []).length, 1);
  const candidateTreeGateIndex = buildWrapper.indexOf("\nassert_candidate_tree_regular\n");
  const validatorStartIndex = buildWrapper.indexOf(
    'node "${REPOSITORY_ROOT}/validation/proxmox/scripts/validate-contract.mjs"',
  );
  assert.notEqual(candidateTreeGateIndex, -1);
  assert.notEqual(validatorStartIndex, -1);
  assert.ok(candidateTreeGateIndex < validatorStartIndex);
  assert.match(buildWrapper, /GIT_ATTR_NOSYSTEM=1/u);
  assert.match(buildWrapper, /GIT_GRAFT_FILE=\/dev\/null/u);
  assert.match(buildWrapper, /GIT_NO_LAZY_FETCH=1/u);
  assert.match(buildWrapper, /GIT_NO_REPLACE_OBJECTS=1/u);
  assert.match(buildWrapper, /GIT_REF_PARANOIA=1/u);
  assert.match(buildWrapper, /NELOS_BASE_ATTESTATION_BASELINE_FILE/u);
  assert.match(
    buildWrapper,
    /assert_controller_attestation_file "\$BASE_ATTESTATION_KNOWN_HOSTS_FILE" "attestation known_hosts file" 400/u,
  );
  assert.match(buildWrapper, /receiptKind == "trusted-bootstrap-baseline"/u);
  assert.match(buildWrapper, /\.ubuntuImageSha256 == \$ubuntu_sha/u);
  assert.match(buildWrapper, /\.disks == \$baseline\.disks/u);
  assert.doesNotMatch(buildWrapper, /NELOS_BASE_(?:SCSI0|EFIDISK0)_(?:SHA256|SIZE_BYTES)/u);
  assert.match(buildWrapper, /run_base_disk_attestation "\$base_attestation_nonce"/u);

  const hostileCurlRoot = await mkdtemp(join(tmpdir(), "nelos-proxmox-hostile-curl-"));
  try {
    const capturePath = join(hostileCurlRoot, "credential-capture");
    const curlWrapper = join(hostileCurlRoot, "curl");
    await writeFile(
      curlWrapper,
      [
        "#!/bin/sh",
        'printf "%s\\n" wrapper >"${CAPTURE_PATH:?}"',
        "exit 97",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(curlWrapper, 0o700);
    const apiProbe = [
      "set -o pipefail",
      'CAPTURE_PATH="$1"',
      "export CAPTURE_PATH",
      'curl() { command builtin printf "%s\\n" function-curl >"$CAPTURE_PATH"; return 97; }',
      'env() { command builtin printf "%s\\n" function-env >"$CAPTURE_PATH"; return 97; }',
      'printf() { command builtin printf "%s\\n" function-printf >"$CAPTURE_PATH"; return 97; }',
      apiGetFunction,
      'API_ROOT="https://127.0.0.1:9/api2/json"',
      'PROXMOX_USERNAME="builder@pve!nelos"',
      'PROXMOX_TOKEN="test-secret-token"',
      "api_get version",
      "",
    ].join("\n");
    const apiProbeResult = await runProcessWithInput(
      "/bin/bash",
      ["-c", apiProbe, "--", capturePath],
      "",
      { env: { PATH: `${hostileCurlRoot}:${process.env.PATH ?? "/usr/bin:/bin"}` } },
    );
    assert.notEqual(apiProbeResult.code, 0);
    await assert.rejects(
      lstat(capturePath),
      (error) => error?.code === "ENOENT",
    );
    assert.doesNotMatch(apiProbeResult.stdout, /PVEAPIToken|test-secret-token/u);
    assert.doesNotMatch(apiProbeResult.stderr, /PVEAPIToken|test-secret-token/u);
  } finally {
    await rm(hostileCurlRoot, { recursive: true, force: true });
  }

  for (const sshControl of [
    "-F /dev/null",
    "-o BatchMode=yes",
    "-o IdentitiesOnly=yes",
    "-o IdentityAgent=none",
    "-o ProxyCommand=none",
    "-o ProxyJump=none",
    "-o ClearAllForwardings=yes",
    "-o CheckHostIP=no",
    "-o StrictHostKeyChecking=yes",
    "-o UserKnownHostsFile=\"$BASE_ATTESTATION_KNOWN_HOSTS_FILE\"",
  ]) {
    assert.equal(buildWrapper.includes(sshControl), true);
  }
  assert.doesNotMatch(buildWrapper, /-o CheckHostIP=yes/u);
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
  const networkValidationCalls = [
    ...buildWrapper.matchAll(/^"\$SEALED_BUILD_NETWORK_ATTESTATION_VALIDATOR" \\$/gmu),
  ].map((match) => match.index);
  const materializeNetworkValidatorIndex = buildWrapper.indexOf(
    '"validation/proxmox/scripts/validate-build-network-attestation.sh" \\\n  "$SEALED_BUILD_NETWORK_ATTESTATION_VALIDATOR"',
  );
  const cleanlinessIndex = buildWrapper.indexOf(
    "git_readonly status --porcelain=v1 --untracked-files=all",
  );
  const initialNetworkHashIndex = buildWrapper.indexOf(
    'BUILD_NETWORK_ATTESTATION_SHA256="$(hash_build_network_attestation)"',
  );
  const downloadIndex = buildWrapper.indexOf('download_verified "$packer_url"');
  const baseDiskAttestationIndex = buildWrapper.indexOf(
    'run_base_disk_attestation "$base_attestation_nonce"',
  );
  const finalNetworkHashIndex = buildWrapper.lastIndexOf(
    '[[ $(hash_build_network_attestation) == "$BUILD_NETWORK_ATTESTATION_SHA256" ]]',
  );
  const packerBuildIndex = buildWrapper.indexOf('"$PACKER_BIN" build -on-error=abort');
  assert.equal(networkValidationCalls.length, 2);
  assert.ok(cleanlinessIndex < materializeNetworkValidatorIndex);
  assert.ok(materializeNetworkValidatorIndex < networkValidationCalls[0]);
  assert.ok(networkValidationCalls[0] < initialNetworkHashIndex);
  assert.ok(initialNetworkHashIndex < downloadIndex);
  assert.ok(baseDiskAttestationIndex < networkValidationCalls[1]);
  assert.ok(networkValidationCalls[1] < finalNetworkHashIndex);
  assert.ok(finalNetworkHashIndex < packerBuildIndex);
  const finalConfigReadbackIndex = buildWrapper.indexOf(
    'api_get "nodes/${PROXMOX_NODE}/qemu/${OUTPUT_TEMPLATE_VMID}/config?current=1"',
  );
  const finalStatusReadbackIndex = buildWrapper.indexOf(
    'api_get "nodes/${PROXMOX_NODE}/qemu/${OUTPUT_TEMPLATE_VMID}/status/current"',
  );
  assert.ok(packerBuildIndex < finalConfigReadbackIndex);
  assert.ok(finalConfigReadbackIndex < finalStatusReadbackIndex);
  assert.match(buildWrapper, /readonly FINAL_TEMPLATE_NETWORK_JQ='/u);
  assert.match(buildWrapper, /select\(test\("\^net\[0-9\]\+\$"\)\)\] == \["net0"\]/u);
  assert.match(buildWrapper, /select\(\. == "bridge=nelosbld"\)/u);
  assert.match(buildWrapper, /\.data\.status == "stopped"/u);
  assert.doesNotMatch(
    buildWrapper,
    /^"\$\{REPOSITORY_ROOT\}\/validation\/proxmox\/scripts\/validate-build-network-attestation\.sh"/mu,
  );
  assert.equal(
    buildWrapper.includes(
      '($scsiDisk[1:] | sort) == ["discard=on", "iothread=1", "size=64G", "ssd=1"]',
    ),
    true,
  );
  assert.match(bootstrap, /--net0 'virtio,bridge=vmbr0,firewall=1,queues=4'/u);
  assert.doesNotMatch(bootstrap, /nelosbld/u);
  assert.doesNotMatch(bootstrap, /NELOS_BUILD_NETWORK_ATTESTATION_FILE/u);
  assert.match(buildWrapper, /NELOS_BUILD_NETWORK_ATTESTATION_FILE/u);
  assert.match(
    buildWrapper,
    /readonly SEALED_BUILD_NETWORK_ATTESTATION_VALIDATOR="\$\{SEALED_SOURCE\}\/scripts\/validate-build-network-attestation\.sh"/u,
  );
  assert.match(buildWrapper, /\/usr\/bin\/perl -MDigest::SHA/u);
  assert.doesNotMatch(
    buildWrapper,
    /sha256sum "\$BUILD_NETWORK_ATTESTATION_FILE"\s*\|\s*awk/u,
  );
  assert.match(bootstrap, /pre-enrolled-keys=0/u);
  assert.match(bootstrap, /discard=on,iothread=1,ssd=1/u);
  assert.match(bootstrap, /"\$DISK_ATTESTER" local-bootstrap/u);
  const bootstrapStdoutGuard = 'bootstrap_main "$@" >&2';
  const bootstrapReceiptWrite = `printf '%s\\n' "$baseline_receipt"`;
  const bootstrapCreateIndex = bootstrap.indexOf('qm create "$BASE_TEMPLATE_VMID"');
  const bootstrapStdoutGuardIndex = bootstrap.indexOf(bootstrapStdoutGuard);
  const bootstrapReceiptWriteIndex = bootstrap.indexOf(bootstrapReceiptWrite);
  assert.notEqual(bootstrapCreateIndex, -1);
  assert.notEqual(bootstrapStdoutGuardIndex, -1);
  assert.notEqual(bootstrapReceiptWriteIndex, -1);
  assert.ok(bootstrapStdoutGuardIndex > bootstrapCreateIndex);
  assert.ok(bootstrapReceiptWriteIndex > bootstrapStdoutGuardIndex);
  assert.doesNotMatch(bootstrap, /exec 3>&1|>&3/u);

  const stdoutProbe = await runProcessWithInput(
    "/bin/bash",
    [
      "-c",
      [
        "set -Eeuo pipefail",
        "bootstrap_main() {",
        "  qm() {",
        "    printf 'update VM 9024: progress\\n'",
        "    if printf 'child-contamination\\n' 2>/dev/null >&3; then return 97; fi",
        "  }",
        "  qm set",
        `  baseline_receipt='{"receiptKind":"trusted-bootstrap-baseline"}'`,
        "}",
        bootstrapStdoutGuard,
        bootstrapReceiptWrite,
        "",
      ].join("\n"),
    ],
    "",
  );
  assert.equal(stdoutProbe.code, 0);
  assert.equal(stdoutProbe.stdout, '{"receiptKind":"trusted-bootstrap-baseline"}\n');
  assert.equal(stdoutProbe.stderr, "update VM 9024: progress\n");

  const bootstrapCleanupTrap = "trap 'cleanup_on_exit >&2' EXIT";
  assert.notEqual(bootstrap.indexOf(bootstrapCleanupTrap), -1);

  const failureProbe = await runProcessWithInput(
    "/bin/bash",
    [
      "-c",
      [
        "set -Eeuo pipefail",
        "cleanup_on_exit() { printf 'cleanup progress\\n'; }",
        "trap 'cleanup_on_exit >&2' EXIT",
        "bootstrap_main() { printf 'bootstrap failure\\n'; return 42; }",
        bootstrapStdoutGuard,
        bootstrapReceiptWrite,
        "",
      ].join("\n"),
    ],
    "",
  );
  assert.equal(failureProbe.code, 42);
  assert.equal(failureProbe.stdout, "");
  assert.equal(failureProbe.stderr, "bootstrap failure\ncleanup progress\n");
  assert.ok(
    bootstrap.indexOf('qm template "$BASE_TEMPLATE_VMID"') <
      bootstrap.indexOf('"$DISK_ATTESTER" local-bootstrap'),
  );
  assert.match(diskAttester, /ATTESTATION_CONFIG_DEFAULT="\/etc\/nelos-validator\/base-disk-attester\.json"/u);
  assert.match(diskAttester, /^#!\/usr\/bin\/bash$/mu);
  assert.match(diskAttester, /\[\[ -z \$\{SSH_ORIGINAL_COMMAND:-\} \]\]/u);
  assert.match(diskAttester, /my \$count = sysread\(STDIN, my \$chunk, 4096\)/u);
  assert.match(diskAttester, /\/usr\/bin\/flock -n 9/u);
  assert.match(diskAttester, /\/usr\/sbin\/lvm lvchange/u);
  assert.match(diskAttester, /\/usr\/bin\/sha256sum -- "\$canonical"/u);
  assert.match(diskAttester, /written@__base__/u);
  assert.match(diskAttester, /expected_path="\/dev\/\$\{vg\}\/\$\{volume\}"/u);
  assert.match(diskAttester, /expected_path="\/dev\/zvol\/\$\{dataset\}"/u);
  assert.match(diskAttester, /storage identity changed while hashing/u);
  assert.match(diskAttester, /LVM base volume must be an inactive read-only activation-skip thin volume/u);
  assert.doesNotMatch(diskAttester, /ide2/u);
  assert.doesNotMatch(bootstrap, /--(?:destroy-unreferenced-disks|purge|skiplock)/u);
  assert.match(bootstrap, /APT::Snapshot \\"\$\{UBUNTU_APT_SNAPSHOT\}\\";/u);
  assert.match(provisionGuest, /-o APT::Snapshot="\$UBUNTU_APT_SNAPSHOT"/u);
  assert.match(
    provisionGuest,
    /apt-get\s+\\\n\s+--error-on=any\s+\\\n\s+-o DPkg::Lock::Timeout=300\s+\\\n\s+-o Acquire::Retries=3\s+\\\n\s+-o APT::Snapshot="\$UBUNTU_APT_SNAPSHOT"\s+\\\n\s+update/u,
  );
  assert.match(proxmoxSource, /bridge\s*=\s*"nelosbld"/u);
  assert.doesNotMatch(proxmoxSource, /vmbr0/u);
  assert.match(proxmoxSource, /firewall\s*=\s*true/u);
  assert.doesNotMatch(proxmoxSource, /ssh_(?:agent_auth|private_key_file)/u);
});

test("build network readiness receipt is exact, protected, and short lived", {
  skip: process.platform !== "linux",
}, async () => {
  const receiptRoot = await mkdtemp(join(tmpdir(), "nelos-build-network-attestation-"));
  const receiptPath = join(receiptRoot, "readiness.json");
  const validator = join(
    validationRoot,
    "scripts",
    "validate-build-network-attestation.sh",
  );
  const sourceRevision = "a".repeat(40);
  const now = Math.floor(Date.now() / 1000);
  const receipt = {
    schemaVersion: 1,
    kind: "nelos-build-network-readiness",
    node: "prox2",
    sourceRevision,
    validFromEpoch: now - 60,
    validUntilEpoch: now + 300,
    policy: {
      mode: "preconfigured-restricted-vnet",
      bridge: "nelosbld",
      dhcpSource: "restricted-vnet",
      defaultEgressPolicy: "deny",
      dnsPolicy: "restricted-host-allowlist-only",
      allowedTcpPorts: [443],
      allowedGuestHosts: [
        "github.com",
        "nodejs.org",
        "release-assets.githubusercontent.com",
        "snapshot.ubuntu.com",
      ],
    },
    checks: {
      vnetExists: true,
      clusterSpanning: true,
      defaultEgressDenied: true,
      dnsRestrictedToAllowedHosts: true,
      tcp443Only: true,
      dhcpProvidedByRestrictedVnet: true,
      buildGuestVmbr0Excluded: true,
    },
  };
  const writeReceipt = async (value) => {
    await chmod(receiptPath, 0o600).catch(() => {});
    await writeFile(receiptPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(receiptPath, 0o400);
  };
  const validateReceipt = async (value, node = "prox2", revision = sourceRevision) => {
    await writeReceipt(value);
    return runProcessWithInput(
      "/bin/bash",
      [validator, receiptPath, node, revision],
      "",
    );
  };

  try {
    await chmod(receiptRoot, 0o700);
    const accepted = await validateReceipt(receipt);
    assert.equal(accepted.code, 0, accepted.stderr);

    const ordinaryBridge = structuredClone(receipt);
    ordinaryBridge.policy.bridge = "vmbr0";
    const rejectedBridge = await validateReceipt(ordinaryBridge);
    assert.notEqual(rejectedBridge.code, 0);

    const stale = structuredClone(receipt);
    stale.validFromEpoch = now - 90000;
    stale.validUntilEpoch = now - 1;
    const rejectedStale = await validateReceipt(stale);
    assert.notEqual(rejectedStale.code, 0);

    const stringSchemaVersion = structuredClone(receipt);
    stringSchemaVersion.schemaVersion = "1";
    assert.notEqual((await validateReceipt(stringSchemaVersion)).code, 0);

    const stringPort = structuredClone(receipt);
    stringPort.policy.allowedTcpPorts = ["443"];
    assert.notEqual((await validateReceipt(stringPort)).code, 0);

    const commaJoinedHosts = structuredClone(receipt);
    commaJoinedHosts.policy.allowedGuestHosts = [
      "github.com,nodejs.org,release-assets.githubusercontent.com,snapshot.ubuntu.com",
    ];
    assert.notEqual((await validateReceipt(commaJoinedHosts)).code, 0);

    const mergedPolicyKeys = structuredClone(receipt);
    delete mergedPolicyKeys.policy.allowedGuestHosts;
    delete mergedPolicyKeys.policy.allowedTcpPorts;
    mergedPolicyKeys.policy["allowedGuestHosts,allowedTcpPorts"] = [443];
    assert.notEqual((await validateReceipt(mergedPolicyKeys)).code, 0);

    const falseCheck = structuredClone(receipt);
    falseCheck.checks.buildGuestVmbr0Excluded = false;
    assert.notEqual((await validateReceipt(falseCheck)).code, 0);

    const mergedCheckKeys = structuredClone(receipt);
    delete mergedCheckKeys.checks.buildGuestVmbr0Excluded;
    delete mergedCheckKeys.checks.clusterSpanning;
    mergedCheckKeys.checks["buildGuestVmbr0Excluded,clusterSpanning"] = true;
    assert.notEqual((await validateReceipt(mergedCheckKeys)).code, 0);

    const mergedTopLevelKeys = structuredClone(receipt);
    delete mergedTopLevelKeys.kind;
    delete mergedTopLevelKeys.node;
    mergedTopLevelKeys["kind,node"] = "nelos-build-network-readiness";
    assert.notEqual((await validateReceipt(mergedTopLevelKeys)).code, 0);

    assert.notEqual((await validateReceipt(receipt, "prox3")).code, 0);
    assert.notEqual((await validateReceipt(receipt, "prox2", "b".repeat(40))).code, 0);

    await writeReceipt(receipt);
    await chmod(receiptPath, 0o600);
    const writableReceipt = await runProcessWithInput(
      "/bin/bash",
      [validator, receiptPath, "prox2", sourceRevision],
      "",
    );
    assert.notEqual(writableReceipt.code, 0);

    const unsafeDirectory = join(receiptRoot, "unsafe-world-writable");
    const unsafeReceiptPath = join(unsafeDirectory, "readiness.json");
    await mkdir(unsafeDirectory, { mode: 0o777 });
    await chmod(unsafeDirectory, 0o777);
    await writeFile(unsafeReceiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o400 });
    await chmod(unsafeReceiptPath, 0o400);
    const unsafeAncestor = await runProcessWithInput(
      "/bin/bash",
      [validator, unsafeReceiptPath, "prox2", sourceRevision],
      "",
    );
    assert.notEqual(unsafeAncestor.code, 0);
  } finally {
    await rm(receiptRoot, { recursive: true, force: true });
  }
});

test("disk attester closes request framing, serve mode, and activation cleanup", async () => {
  const diskAttester = await readFile(
    join(validationRoot, "scripts", "attest-base-template-disks.sh"),
    "utf8",
  );
  const parserPrefix = `request_fields="$(/usr/bin/perl -MJSON::PP -e '\n`;
  const parserSuffix = `\n')" || die "attestation request is malformed"`;
  const parserStart = diskAttester.indexOf(parserPrefix);
  const parserEnd = diskAttester.indexOf(parserSuffix, parserStart + parserPrefix.length);
  assert.notEqual(parserStart, -1, "production request parser start marker must remain exact");
  assert.notEqual(parserEnd, -1, "production request parser end marker must remain exact");
  assert.equal(
    diskAttester.indexOf(parserPrefix, parserStart + parserPrefix.length),
    -1,
    "production request parser must have one extraction site",
  );
  const requestParser = diskAttester.slice(parserStart + parserPrefix.length, parserEnd);
  const parserEnvironment = {
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    PERL5LIB: "",
    PERL5OPT: "",
  };
  const validRequest = {
    baseTemplateName: "nelos-ubuntu-2404-base",
    baseTemplateVmid: 9020,
    configDigest: "b".repeat(40),
    node: "prox2",
    nonce: `build-${"a".repeat(32)}`,
    schemaVersion: 1,
  };
  const validJson = JSON.stringify(validRequest);
  const runRequestParser = (input) => runProcessWithInput(
    "/usr/bin/perl",
    ["-MJSON::PP", "-e", requestParser],
    input,
    { env: parserEnvironment },
  );
  const assertParserRejects = async (input, errorPattern = undefined) => {
    const result = await runRequestParser(input);
    assert.notEqual(result.code, 0, "malformed request must be rejected");
    assert.equal(result.stdout, "");
    if (errorPattern) assert.match(result.stderr, errorPattern);
  };

  const accepted = await runRequestParser(Buffer.from(`${validJson}\n`, "utf8"));
  assert.equal(accepted.code, 0);
  assert.equal(accepted.stderr, "");
  assert.equal(
    accepted.stdout,
    [
      validRequest.nonce,
      validRequest.node,
      String(validRequest.baseTemplateVmid),
      validRequest.baseTemplateName,
      validRequest.configDigest,
    ].join("\t"),
  );

  await assertParserRejects(Buffer.from(validJson, "utf8"), /framing/u);
  await assertParserRejects(Buffer.from(`${validJson}\n\n`, "utf8"), /framing/u);
  await assertParserRejects(Buffer.from(`${validJson}trailing\n`, "utf8"));
  await assertParserRejects(
    Buffer.concat([Buffer.from(validJson, "utf8"), Buffer.from([0, 10])]),
    /framing/u,
  );
  await assertParserRejects(
    Buffer.concat([Buffer.alloc(2049, 0x20), Buffer.from("\n", "ascii")]),
    /size/u,
  );
  await assertParserRejects(
    Buffer.from(`${JSON.stringify({ ...validRequest, schemaVersion: "1" })}\n`, "utf8"),
    /schema/u,
  );
  await assertParserRejects(
    Buffer.from(`${JSON.stringify({ ...validRequest, baseTemplateVmid: "9020" })}\n`, "utf8"),
    /vmid/u,
  );

  const serveStart = diskAttester.indexOf("  serve)\n");
  const serveGuardMatch = /^    (\[\[ -z \$\{SSH_ORIGINAL_COMMAND:-\} \]\] \|\| die "remote commands are disabled; send one JSON request on standard input")$/mu.exec(
    diskAttester.slice(serveStart),
  );
  assert.notEqual(serveStart, -1);
  assert.notEqual(serveGuardMatch, null, "serve mode must retain the exact forced-command guard");
  const serveGuardIndex = diskAttester.indexOf(serveGuardMatch[1], serveStart);
  const serveConfigIndex = diskAttester.indexOf(
    'readonly attestation_config="$ATTESTATION_CONFIG_DEFAULT"',
    serveStart,
  );
  assert.ok(serveGuardIndex < serveConfigIndex, "forced-command guard must run before config or PVE access");
  const serveGuardProgram = [
    "set -Eeuo pipefail",
    "die() { printf 'error: %s\\n' \"$*\" >&2; exit 1; }",
    serveGuardMatch[1],
  ].join("\n");
  const acceptedServe = await runProcessWithInput(
    "/bin/bash",
    ["-c", serveGuardProgram],
    Buffer.alloc(0),
    { env: { PATH: "/usr/bin:/bin", SSH_ORIGINAL_COMMAND: "" } },
  );
  assert.equal(acceptedServe.code, 0);
  const rejectedServe = await runProcessWithInput(
    "/bin/bash",
    ["-c", serveGuardProgram],
    Buffer.alloc(0),
    { env: { PATH: "/usr/bin:/bin", SSH_ORIGINAL_COMMAND: "qm destroy 9020" } },
  );
  assert.notEqual(rejectedServe.code, 0);
  assert.match(rejectedServe.stderr, /remote commands are disabled/u);

  const activationInventoryIndex = diskAttester.indexOf("ACTIVATED_LVS=()");
  const cleanupTrapIndex = diskAttester.indexOf("trap cleanup_activated_lvs EXIT");
  const hashDispatchIndex = diskAttester.indexOf("while IFS=$'\\t' read -r disk_key");
  assert.notEqual(activationInventoryIndex, -1);
  assert.notEqual(cleanupTrapIndex, -1);
  assert.notEqual(hashDispatchIndex, -1);
  assert.ok(activationInventoryIndex < cleanupTrapIndex);
  assert.ok(cleanupTrapIndex < hashDispatchIndex);
  assert.equal((diskAttester.match(/printf -v HASHED_DISK_ROW/gu) ?? []).length, 2);
  assert.match(
    diskAttester,
    /^      hash_lvmthin "\$disk_key" "\$disk_storage" "\$disk_volume" "\$storage_field_one" "\$storage_field_two"$/mu,
  );
  assert.match(
    diskAttester,
    /^      hash_zfspool "\$disk_key" "\$disk_storage" "\$disk_volume" "\$storage_field_one"$/mu,
  );
  assert.doesNotMatch(diskAttester, /\$\(\s*hash_(?:lvmthin|zfspool)\b/u);
  assert.doesNotMatch(diskAttester, /`\s*hash_(?:lvmthin|zfspool)\b/u);
  assert.match(diskAttester, /trap - EXIT\ncleanup_activated_lvs\n?$/u);
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

  await context.test("regular candidate clears the tree mode gate", async (subcontext) => {
    const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(subcontext);
    await assert.rejects(
      runBuildGitPreflight(artifactRoot, fixtureRoot),
      (error) => {
        assert.equal(error?.code, 1);
        assert.doesNotMatch(
          error?.stderr ?? "",
          /source candidate tree must contain only regular tracked files/u,
        );
        return true;
      },
    );
  });

  await context.test("tracked symlink before validator startup", async (subcontext) => {
    const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(subcontext);
    const pluginManifestPath = join(fixtureRoot, ".codex-plugin", "plugin.json");
    const externalManifestPath = join(artifactRoot, "external-plugin.json");
    await cp(pluginManifestPath, externalManifestPath);
    await rm(pluginManifestPath);
    await symlink(externalManifestPath, pluginManifestPath);
    await execFileAsync("git", ["add", "--all"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: commitGitEnvironment(),
    });
    await execFileAsync("git", ["commit", "--quiet", "--message", "add tracked symlink"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: commitGitEnvironment(),
    });

    await assert.rejects(
      runBuildGitPreflight(artifactRoot, fixtureRoot),
      (error) => {
        assert.equal(error?.code, 1);
        assert.match(
          error?.stderr ?? "",
          /source candidate tree must contain only regular tracked files/u,
        );
        assert.doesNotMatch(error?.stderr ?? "", /repository contract validation failed/u);
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
  assert.match(jqVersionOutput.trim(), /^jq-[0-9]+[.][0-9]+(?:[.][0-9]+)?(?:-[A-Za-z0-9._-]+)?$/u);

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
  assert.match(
    bootstrap,
    /assert_root_owned_nonwritable_file "\$IMAGE_PATH" "cached image"/u,
  );
  assert.match(
    bootstrap,
    /assert_root_owned_nonwritable_directory "\$snippet_root" "snippets storage root"/u,
  );
  assert.match(
    bootstrap,
    /assert_protected_directory_chain "\$IMAGE_CACHE_DIR" "IMAGE_CACHE_DIR"/u,
  );
  assert.match(
    bootstrap,
    /assert_protected_directory_chain "\$snippet_root" "snippets storage root"/u,
  );
  assert.match(
    bootstrap,
    /assert_protected_directory_chain "\$SNIPPET_DIR" "snippets directory"/u,
  );
  assert.match(bootstrap, /\$current == "\/tmp" \|\| \$current == "\/var\/tmp"/u);
  assert.match(bootstrap, /\(permission_bits & 01000\) != 0/u);
  assert.match(bootstrap, /\[\[ \$canonical == "\$path" \]\]/u);
  assert.equal(
    (bootstrap.match(
      /assert_root_owned_nonwritable_directory "\$SNIPPET_DIR" "snippets directory"/gu,
    ) ?? []).length,
    2,
  );
  assert.match(bootstrap, /install -d -o root -g root -m 0755 "\$SNIPPET_DIR"/u);
  assert.match(bootstrap, /\[\[ \$owner == "0" \]\]/u);
  assert.equal(
    (bootstrap.match(/\(\( \(permission_bits & 0022\) == 0 \)\)/gu) ?? []).length,
    2,
  );
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
  const trustedBaselineJq = extractJqProgram("TRUSTED_BASELINE_JQ");
  const baseTemplatePendingConfigJq = extractJqProgram("BASE_TEMPLATE_PENDING_CONFIG_JQ");
  const baseTemplateApprovedConfigValuesJq = extractJqProgram(
    "BASE_TEMPLATE_APPROVED_CONFIG_VALUES_JQ",
  );
  const finalTemplateNetworkJq = extractJqProgram("FINAL_TEMPLATE_NETWORK_JQ");
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
  assert.match(trustedBaselineJq, /\.receiptKind == "trusted-bootstrap-baseline"/u);
  assert.match(trustedBaselineJq, /\.ubuntuImageSha256 == \$ubuntu_sha/u);
  assert.match(trustedBaselineJq, /\.disks\.scsi0\.volumeId == \$scsi0_volume/u);
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
  assert.match(finalTemplateNetworkJq, /bridge=nelosbld/u);
  assert.match(finalTemplateNetworkJq, /\["net0"\]/u);
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
  const acceptsFinalTemplateNetwork = (config) =>
    jqAccepts(
      [
        "--argjson", "config", JSON.stringify(config),
        "--arg", "name", "nelos-validator-provisional-prox2",
        "--arg", "ownership_tag", "nelos-build-12345678-abc",
      ],
      "$config | " + finalTemplateNetworkJq,
    );
  const safeFinalTemplateConfig = {
    data: {
      ipconfig0: "ip=dhcp",
      name: "nelos-validator-provisional-prox2",
      net0: "virtio=BC:24:11:22:33:44,bridge=nelosbld,firewall=1,queues=4",
      tags: "nelos-validator;ubuntu-24-04;packer;nelos-build-12345678-abc",
      template: 1,
    },
  };
  assert.equal(await acceptsFinalTemplateNetwork(safeFinalTemplateConfig), true);
  for (const [label, mutate] of [
    ["ordinary bridge", (value) => { value.data.net0 = value.data.net0.replace("nelosbld", "vmbr0"); }],
    ["extra adapter", (value) => { value.data.net1 = "virtio=BC:24:11:22:33:46,bridge=nelosbld,firewall=1,queues=4"; }],
    ["firewall disabled", (value) => { value.data.net0 = value.data.net0.replace("firewall=1", "firewall=0"); }],
    ["wrong addressing", (value) => { value.data.ipconfig0 = "ip=192.0.2.2/24,gw=192.0.2.1"; }],
    ["not a template", (value) => { value.data.template = 0; }],
    ["missing ownership", (value) => { value.data.tags = "nelos-validator;ubuntu-24-04;packer"; }],
  ]) {
    const driftedFinalTemplate = structuredClone(safeFinalTemplateConfig);
    mutate(driftedFinalTemplate);
    assert.equal(
      await acceptsFinalTemplateNetwork(driftedFinalTemplate),
      false,
      label,
    );
  }
  const safeBaseline = {
    baseTemplateName: "nelos-ubuntu-2404-base",
    baseTemplateVmid: 9020,
    configDigest: "a".repeat(40),
    disks: {
      efidisk0: {
        backend: "lvmthin",
        logicalSizeBytes: 4194304,
        nativeIdentity: "efi-lvm-uuid",
        sha256: "2".repeat(64),
        volumeId: "local-lvm:base-9020-disk-0",
      },
      scsi0: {
        backend: "lvmthin",
        logicalSizeBytes: 68719476736,
        nativeIdentity: "scsi-lvm-uuid",
        sha256: "1".repeat(64),
        volumeId: "local-lvm:base-9020-disk-1",
      },
    },
    node: "prox2",
    nonce: `baseline-${"3".repeat(32)}`,
    receiptKind: "trusted-bootstrap-baseline",
    schemaVersion: 1,
    ubuntuImageSha256: imageDigest,
  };
  const acceptsTrustedBaseline = (receipt) =>
    jqAccepts(
      [
        "--argjson", "receipt", JSON.stringify(receipt),
        "--arg", "node", "prox2",
        "--argjson", "vmid", "9020",
        "--arg", "name", "nelos-ubuntu-2404-base",
        "--arg", "digest", "a".repeat(40),
        "--arg", "ubuntu_sha", imageDigest,
        "--arg", "scsi0_volume", "local-lvm:base-9020-disk-1",
        "--arg", "efidisk0_volume", "local-lvm:base-9020-disk-0",
      ],
      "$receipt | " + trustedBaselineJq,
    );

  assert.equal(await acceptsBaseInventory(safeBaseConfig), true);
  assert.equal(await acceptsTrustedBaseline(safeBaseline), true);
  for (const mutateBaseline of [
    (receipt) => { receipt.receiptKind = "ad-hoc-attestation"; },
    (receipt) => { receipt.ubuntuImageSha256 = "f".repeat(64); },
    (receipt) => { receipt.node = "prox3"; },
    (receipt) => { receipt.baseTemplateVmid = "9020"; },
    (receipt) => { receipt.baseTemplateName = "another-base"; },
    (receipt) => { receipt.configDigest = "b".repeat(40); },
    (receipt) => { receipt.disks.scsi0.volumeId = "local-lvm:base-9020-disk-9"; },
    (receipt) => { receipt.disks.scsi0.backend = "lvm"; },
    (receipt) => { receipt.disks.efidisk0.nativeIdentity = "unsafe:identity"; },
    (receipt) => { receipt.disks.scsi0.sha256 = receipt.disks.efidisk0.sha256; },
    (receipt) => { receipt.disks.scsi0.logicalSizeBytes = "68719476736"; },
    (receipt) => { receipt.unexpected = true; },
  ]) {
    const invalidBaseline = structuredClone(safeBaseline);
    mutateBaseline(invalidBaseline);
    assert.equal(await acceptsTrustedBaseline(invalidBaseline), false, JSON.stringify(invalidBaseline));
  }
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

  const stringMemoryConfig = structuredClone(safeBaseConfig);
  stringMemoryConfig.data.memory = "8192";
  assert.equal(await acceptsApprovedConfigValues(stringMemoryConfig), true);

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
    ["memory", "16384"],
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
    "virtio=BC:24:11:22:33:44,bridge=nelosbld,firewall=1,queues=4",
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
  const { version: pluginVersion } = await readJson(join(root, ".codex-plugin", "plugin.json"));
  const evidence = createEvidenceProbe(contract, { pluginVersion });
  const repositoryIdentity = {
    pluginVersion,
    distributionIntegrity: evidence.candidate.distributionIntegrity,
  };

  validateEvidenceDocument(evidence, evidenceSchema, contract, repositoryIdentity);
  assert.equal(evidence.sanitization.status, "passed");
  assert.equal(evidence.sanitization.credentialsCaptured, false);
  assert.equal(evidence.observations.networkDeniedDuringValidation, true);
  assert.equal(evidence.lanes["legacy-01446"].checks.laneParity, true);
  assert.equal(evidence.lanes["agent-plugin-01470"].checks.laneParity, true);
  const agentLane = evidence.lanes["agent-plugin-01470"];
  const expectedAgentPluginDataIdentity = createHash("sha256")
    .update("nelos-marketplace", "utf8")
    .update(Buffer.from([0]))
    .update("nelos", "utf8")
    .digest("hex");
  assert.equal(
    agentLane.processObservation.observedEnvironmentPaths.PLUGIN_ROOT,
    `${agentLane.codexHome}/plugins/cache/nelos-marketplace/nelos/${pluginVersion}`,
  );
  assert.equal(
    agentLane.processObservation.observedEnvironmentPaths.PLUGIN_DATA,
    `${agentLane.codexHome}/plugins/data/agent-plugins/${expectedAgentPluginDataIdentity}`,
  );
  assert.equal(evidence.lanes["legacy-01446"].processObservation.observedEnvironmentPaths.PLUGIN_ROOT, null);
  assert.equal(evidence.lanes["legacy-01446"].processObservation.observedEnvironmentPaths.PLUGIN_DATA, null);

  const staleTemplateVersion = structuredClone(evidence);
  staleTemplateVersion.template.templateVersion = "9.9.9";
  assert.throws(
    () => validateEvidenceDocument(staleTemplateVersion, evidenceSchema, contract, repositoryIdentity),
    /\/template\/templateVersion: must match the validator contract version/u,
  );

  const stalePluginVersion = structuredClone(evidence);
  stalePluginVersion.lanes["legacy-01446"].pluginVersion = "9.9.9";
  stalePluginVersion.lanes["agent-plugin-01470"].pluginVersion = "9.9.9";
  assert.throws(
    () => validateEvidenceDocument(
      stalePluginVersion,
      evidenceSchema,
      contract,
      repositoryIdentity,
    ),
    /pluginVersion: must match the exact candidate plugin manifest identity/u,
  );

  const staleInstalledDistribution = structuredClone(evidence);
  staleInstalledDistribution.lanes["legacy-01446"].installedDistributionIntegrity =
    `sha256:${"5".repeat(64)}`;
  assert.throws(
    () => validateEvidenceDocument(staleInstalledDistribution, evidenceSchema, contract, repositoryIdentity),
    /installedDistributionIntegrity: must match the exact candidate distribution/u,
  );

  const unboundCandidateDistribution = structuredClone(evidence);
  unboundCandidateDistribution.candidate.distributionIntegrity = `sha256:${"5".repeat(64)}`;
  unboundCandidateDistribution.lanes["legacy-01446"].installedDistributionIntegrity =
    unboundCandidateDistribution.candidate.distributionIntegrity;
  unboundCandidateDistribution.lanes["agent-plugin-01470"].installedDistributionIntegrity =
    unboundCandidateDistribution.candidate.distributionIntegrity;
  assert.throws(
    () => validateEvidenceDocument(unboundCandidateDistribution, evidenceSchema, contract, repositoryIdentity),
    /\/candidate\/distributionIntegrity: must match the exact candidate distribution bytes/u,
  );

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

  for (const laneId of ["legacy-01446", "agent-plugin-01470"]) {
    for (const [environmentKey, suffix] of Object.entries({
      HOME: "home",
      CODEX_HOME: "home/.codex",
      TMPDIR: "tmp",
      XDG_CONFIG_HOME: "xdg/config",
      XDG_CACHE_HOME: "xdg/cache",
      XDG_DATA_HOME: "xdg/data",
    })) {
      const mismatchedObservedPath = structuredClone(evidence);
      mismatchedObservedPath.lanes[laneId].processObservation.observedEnvironmentPaths[environmentKey] =
        `/var/lib/nelos-validator/runs/another-run/${laneId}/${suffix}`;
      assert.throws(
        () => validateEvidenceDocument(mismatchedObservedPath, evidenceSchema, contract),
        new RegExp(`observedEnvironmentPaths/${environmentKey}: must be null or equal the isolated`, "u"),
        `${laneId} ${environmentKey}`,
      );
    }
  }

  for (const laneId of ["legacy-01446", "agent-plugin-01470"]) {
    for (const [environmentKey, field] of Object.entries({
      HOME: "home",
      CODEX_HOME: "codexHome",
      TMPDIR: "tmpDir",
      XDG_CONFIG_HOME: "xdgConfigHome",
      XDG_CACHE_HOME: "xdgCacheHome",
      XDG_DATA_HOME: "xdgDataHome",
    })) {
      const failedWithMissingEnvironment = structuredClone(evidence);
      failedWithMissingEnvironment.lanes[laneId]
        .processObservation.observedEnvironmentPaths[environmentKey] = null;
      failedWithMissingEnvironment.lanes[laneId].processObservation.observedEnvironmentKeys =
        failedWithMissingEnvironment.lanes[laneId].processObservation.observedEnvironmentKeys
          .filter((key) => key !== environmentKey);
      failedWithMissingEnvironment.result = {
        status: "failed",
        failures: [`${laneId}.process.required-environment-missing`],
      };
      validateEvidenceDocument(failedWithMissingEnvironment, evidenceSchema, contract);

      const failedWithMismatchedEnvironment = structuredClone(evidence);
      failedWithMismatchedEnvironment.lanes[laneId]
        .processObservation.observedEnvironmentPaths[environmentKey] = null;
      failedWithMismatchedEnvironment.result = {
        status: "failed",
        failures: [`${laneId}.process.required-environment-mismatch`],
      };
      validateEvidenceDocument(failedWithMismatchedEnvironment, evidenceSchema, contract);

      const failedWithContradictoryEnvironment = structuredClone(failedWithMissingEnvironment);
      failedWithContradictoryEnvironment.lanes[laneId]
        .processObservation.observedEnvironmentPaths[environmentKey] =
          failedWithContradictoryEnvironment.lanes[laneId][field];
      assert.throws(
        () => validateEvidenceDocument(failedWithContradictoryEnvironment, evidenceSchema, contract),
        new RegExp(`observedEnvironmentKeys: must include ${environmentKey} when its isolated path was observed`, "u"),
        `${laneId} ${environmentKey}`,
      );

      const passedWithoutVerifiedEnvironment = structuredClone(evidence);
      passedWithoutVerifiedEnvironment.lanes[laneId]
        .processObservation.observedEnvironmentPaths[environmentKey] = null;
      assert.throws(
        () => validateEvidenceDocument(passedWithoutVerifiedEnvironment, evidenceSchema, contract),
        new RegExp(`observedEnvironmentPaths/${environmentKey}: must equal the isolated ${field} for passed evidence`, "u"),
        `${laneId} ${environmentKey}`,
      );
    }
  }

  for (const laneId of ["legacy-01446", "agent-plugin-01470"]) {
    for (const [field, suffix] of Object.entries({
      tmpDir: "tmp",
      xdgConfigHome: "xdg/config",
      xdgCacheHome: "xdg/cache",
      xdgDataHome: "xdg/data",
    })) {
      const wrongMutableRoot = structuredClone(evidence);
      wrongMutableRoot.lanes[laneId][field] =
        `/var/lib/nelos-validator/runs/another-run/${laneId}/${suffix}`;
      assert.throws(
        () => validateEvidenceDocument(wrongMutableRoot, evidenceSchema, contract),
        /must be isolated beneath this evidence run and lane ID/u,
        `${laneId} ${field}`,
      );
    }
  }

  for (const laneId of ["legacy-01446", "agent-plugin-01470"]) {
    for (const environmentKey of ["TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
      const missingMutableEnvironment = structuredClone(evidence);
      missingMutableEnvironment.lanes[laneId].processObservation.observedEnvironmentKeys =
        missingMutableEnvironment.lanes[laneId].processObservation.observedEnvironmentKeys
          .filter((key) => key !== environmentKey);
      assert.throws(
        () => validateEvidenceDocument(missingMutableEnvironment, evidenceSchema, contract),
        new RegExp(`must include ${environmentKey}`, "u"),
        `${laneId} ${environmentKey}`,
      );
    }
  }

  const passedWithoutObservedNetworkDenial = structuredClone(evidence);
  passedWithoutObservedNetworkDenial.observations.networkDeniedDuringValidation = false;
  assert.throws(
    () => validateEvidenceDocument(passedWithoutObservedNetworkDenial, evidenceSchema, contract),
    /passed evidence requires observed network denial across the validation window/u,
  );

  const failedWithoutObservedNetworkDenial = structuredClone(passedWithoutObservedNetworkDenial);
  failedWithoutObservedNetworkDenial.result = {
    status: "failed",
    failures: ["validation.network-denial-unproven"],
  };
  validateEvidenceDocument(failedWithoutObservedNetworkDenial, evidenceSchema, contract);

  const invalidNetworkObservation = structuredClone(evidence);
  invalidNetworkObservation.observations.networkDeniedDuringValidation = "yes";
  assert.throws(
    () => validateEvidenceDocument(invalidNetworkObservation, evidenceSchema, contract),
    /networkDeniedDuringValidation: must have type boolean/u,
  );

  const missingPluginData = structuredClone(evidence);
  missingPluginData.lanes["agent-plugin-01470"].processObservation.observedEnvironmentKeys =
    missingPluginData.lanes["agent-plugin-01470"].processObservation.observedEnvironmentKeys
      .filter((key) => key !== "PLUGIN_DATA");
  assert.throws(
    () => validateEvidenceDocument(missingPluginData, evidenceSchema, contract),
    /must include PLUGIN_DATA when its exact injected path was observed/u,
  );

  const failedWithMissingPluginData = structuredClone(evidence);
  failedWithMissingPluginData.lanes["agent-plugin-01470"]
    .processObservation.observedEnvironmentPaths.PLUGIN_DATA = null;
  failedWithMissingPluginData.lanes["agent-plugin-01470"].processObservation.observedEnvironmentKeys =
    failedWithMissingPluginData.lanes["agent-plugin-01470"].processObservation.observedEnvironmentKeys
      .filter((key) => key !== "PLUGIN_DATA");
  failedWithMissingPluginData.lanes["agent-plugin-01470"].checks.nelosConfigGet = false;
  failedWithMissingPluginData.lanes["agent-plugin-01470"].checks.laneParity = false;
  failedWithMissingPluginData.lanes["legacy-01446"].checks.laneParity = false;
  failedWithMissingPluginData.result = {
    status: "failed",
    failures: ["agent-plugin.process.required-environment-missing"],
  };
  validateEvidenceDocument(failedWithMissingPluginData, evidenceSchema, contract);

  const failedWithMismatchedPluginRoot = structuredClone(evidence);
  failedWithMismatchedPluginRoot.lanes["agent-plugin-01470"]
    .processObservation.observedEnvironmentPaths.PLUGIN_ROOT = null;
  failedWithMismatchedPluginRoot.lanes["agent-plugin-01470"].checks.nelosConfigGet = false;
  failedWithMismatchedPluginRoot.lanes["agent-plugin-01470"].checks.laneParity = false;
  failedWithMismatchedPluginRoot.lanes["legacy-01446"].checks.laneParity = false;
  failedWithMismatchedPluginRoot.result = {
    status: "failed",
    failures: ["agent-plugin.process.required-environment-mismatch"],
  };
  validateEvidenceDocument(failedWithMismatchedPluginRoot, evidenceSchema, contract);

  for (const [environmentKey, replacement] of [
    [
      "PLUGIN_ROOT",
      `${agentLane.codexHome}/plugins/cache/nelos-marketplace/nelos/9.9.9`,
    ],
    [
      "PLUGIN_DATA",
      `${agentLane.codexHome}/plugins/data/agent-plugins/${"f".repeat(64)}`,
    ],
  ]) {
    const staleInjectedPluginPath = structuredClone(evidence);
    staleInjectedPluginPath.lanes["agent-plugin-01470"]
      .processObservation.observedEnvironmentPaths[environmentKey] = replacement;
    assert.throws(
      () => validateEvidenceDocument(staleInjectedPluginPath, evidenceSchema, contract),
      /must be null or equal the exact injected path derived from the verified installation/u,
      environmentKey,
    );
  }

  const unverifiedPluginRoot = structuredClone(evidence);
  unverifiedPluginRoot.lanes["agent-plugin-01470"].checks.pluginInstall = false;
  unverifiedPluginRoot.lanes["agent-plugin-01470"].installedDistributionIntegrity = null;
  unverifiedPluginRoot.lanes["agent-plugin-01470"].checks.mcpInitialize = false;
  unverifiedPluginRoot.lanes["agent-plugin-01470"].checks.toolsList = false;
  unverifiedPluginRoot.lanes["agent-plugin-01470"].checks.nelosConfigGet = false;
  unverifiedPluginRoot.lanes["agent-plugin-01470"].checks.laneParity = false;
  unverifiedPluginRoot.lanes["agent-plugin-01470"].toolNames = [];
  unverifiedPluginRoot.lanes["legacy-01446"].checks.laneParity = false;
  unverifiedPluginRoot.result = {
    status: "failed",
    failures: ["agent-plugin.plugin.install-failed"],
  };
  assert.throws(
    () => validateEvidenceDocument(unverifiedPluginRoot, evidenceSchema, contract),
    /must be null until exact plugin installation is verified/u,
  );

  const legacyPluginEnvironmentPresent = structuredClone(evidence);
  legacyPluginEnvironmentPresent.lanes["legacy-01446"].processObservation.observedEnvironmentKeys.push(
    "PLUGIN_ROOT",
  );
  assert.throws(
    () => validateEvidenceDocument(legacyPluginEnvironmentPresent, evidenceSchema, contract),
    /must omit forbidden legacy environment key PLUGIN_ROOT/u,
  );
  legacyPluginEnvironmentPresent.lanes["legacy-01446"].checks.laneParity = false;
  legacyPluginEnvironmentPresent.lanes["agent-plugin-01470"].checks.laneParity = false;
  legacyPluginEnvironmentPresent.result = {
    status: "failed",
    failures: ["legacy.process.forbidden-environment-present"],
  };
  validateEvidenceDocument(legacyPluginEnvironmentPresent, evidenceSchema, contract);

  const legacyPluginEnvironmentValue = structuredClone(evidence);
  legacyPluginEnvironmentValue.lanes["legacy-01446"]
    .processObservation.observedEnvironmentPaths.PLUGIN_DATA = "/unsafe/plugin-data";
  assert.throws(
    () => validateEvidenceDocument(legacyPluginEnvironmentValue, evidenceSchema, contract),
    /PLUGIN_DATA: must equal null/u,
  );

  const pluginInstallFailedWithMcpSuccess = structuredClone(evidence);
  pluginInstallFailedWithMcpSuccess.lanes["agent-plugin-01470"].checks.pluginInstall = false;
  pluginInstallFailedWithMcpSuccess.lanes["agent-plugin-01470"].installedDistributionIntegrity = null;
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
  failedBeforeProcessStart.lanes["agent-plugin-01470"].processObservation.observedEnvironmentPaths = {
    HOME: null,
    CODEX_HOME: null,
    TMPDIR: null,
    XDG_CONFIG_HOME: null,
    XDG_CACHE_HOME: null,
    XDG_DATA_HOME: null,
    PLUGIN_DATA: null,
    PLUGIN_ROOT: null,
  };
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

  const failedAfterSuccessfulObservations = structuredClone(evidence);
  failedAfterSuccessfulObservations.result = {
    status: "failed",
    failures: ["candidate.changed-during-validation"],
  };
  validateEvidenceDocument(failedAfterSuccessfulObservations, evidenceSchema, contract);

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

test("repository validation binds the candidate version to its release build identity", async (context) => {
  const { fixtureRoot } = await createCleanRepositoryFixture(context);
  const pluginManifestPath = join(fixtureRoot, ".codex-plugin", "plugin.json");
  const pluginManifest = await readJson(pluginManifestPath);
  pluginManifest.releaseBuildIdentity = "nelos-release-v1:9.9.9";
  await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, { mode: 0o600 });

  await assert.rejects(
    validateRepositoryContract(fixtureRoot),
    /\/candidate\/pluginManifest\/releaseBuildIdentity: must equal nelos-release-v1:/u,
  );
});

test("exact candidate validation binds the requested revision without changing dirty-tree linting", async (context) => {
  const { fixtureRoot } = await createCleanRepositoryFixture(context);
  const { stdout: sourceRevisionOutput } = await execFileAsync(
    gitExecutable,
    [...gitIdentityArguments, "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
    { cwd: fixtureRoot, encoding: "utf8", env: cleanGitEnvironment() },
  );
  const sourceRevision = sourceRevisionOutput.trim();
  await validateRepositoryContract(fixtureRoot, { candidateRevision: sourceRevision });

  const wrongRevision = `${sourceRevision.startsWith("0") ? "1" : "0"}${sourceRevision.slice(1)}`;
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { candidateRevision: wrongRevision }),
    /\/candidate\/sourceRevision: must match the requested exact candidate revision/u,
  );

  const contractPath = join(fixtureRoot, "validation", "proxmox", "contract.json");
  await writeFile(contractPath, `${await readFile(contractPath, "utf8")}\n`, { mode: 0o600 });
  await validateRepositoryContract(fixtureRoot);
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { candidateRevision: sourceRevision }),
    /\/candidate\/dirty: exact candidate validation requires an exactly clean Git checkout/u,
  );
});

test("candidate distribution and passed evidence require the exact Agent Plugins v1 root layout", async (context) => {
  const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(context);
  const fixtureValidationRoot = join(fixtureRoot, "validation", "proxmox");
  const [contractBytes, toolchainLockBytes, contract, pluginManifest, candidateIdentity] = await Promise.all([
    readFile(join(fixtureValidationRoot, "contract.json")),
    readFile(join(fixtureValidationRoot, "toolchain.lock.json")),
    readJson(join(fixtureValidationRoot, "contract.json")),
    readJson(join(fixtureRoot, ".codex-plugin", "plugin.json")),
    readGitCandidateIdentity(fixtureRoot),
  ]);
  const evidence = createEvidenceProbe(contract, {
    contractSha256: createHash("sha256").update(contractBytes).digest("hex"),
    toolchainLockSha256: createHash("sha256").update(toolchainLockBytes).digest("hex"),
    pluginVersion: pluginManifest.version,
    ...candidateIdentity,
  });
  const evidencePath = join(artifactRoot, "agent-layout-evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await validateRepositoryContract(fixtureRoot, { evidencePath });

  const { pluginManifest: agentPluginManifest, mcpManifest } = createAgentPluginLayout(pluginManifest);
  await execFileAsync("git", ["rm", "--quiet", "plugin.json"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await execFileAsync("git", ["commit", "--quiet", "--message", "remove agent plugin manifest"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/distributionIntegrity: candidate distribution entry is missing: plugin\.json/u,
  );

  await writeFile(
    join(fixtureRoot, "plugin.json"),
    `${JSON.stringify(agentPluginManifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  await refreshFixtureDistributionProvenance(fixtureRoot);
  await execFileAsync("git", ["add", "plugin.json", "distribution-provenance.json"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await execFileAsync("git", ["commit", "--quiet", "--message", "restore agent plugin manifest"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  const restoredIdentity = await readGitCandidateIdentity(fixtureRoot);
  Object.assign(evidence.candidate, restoredIdentity);
  evidence.lanes["legacy-01446"].installedDistributionIntegrity = restoredIdentity.distributionIntegrity;
  evidence.lanes["agent-plugin-01470"].installedDistributionIntegrity = restoredIdentity.distributionIntegrity;
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await validateRepositoryContract(fixtureRoot, { evidencePath });

  await execFileAsync("git", ["rm", "--quiet", "mcp.json"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await execFileAsync("git", ["commit", "--quiet", "--message", "remove agent MCP manifest"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/distributionIntegrity: candidate distribution entry is missing: mcp\.json/u,
  );

  mcpManifest.mcpServers.nelos.command = "bash";
  await writeFile(
    join(fixtureRoot, "mcp.json"),
    `${JSON.stringify(mcpManifest, null, 2)}\n`,
      { mode: 0o600 },
  );
  await refreshFixtureDistributionProvenance(fixtureRoot);
  await execFileAsync("git", ["add", "mcp.json", "distribution-provenance.json"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await execFileAsync("git", ["commit", "--quiet", "--message", "add invalid agent MCP manifest"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  const invalidIdentity = await readGitCandidateIdentity(fixtureRoot);
  Object.assign(evidence.candidate, invalidIdentity);
  evidence.lanes["legacy-01446"].installedDistributionIntegrity = invalidIdentity.distributionIntegrity;
  evidence.lanes["agent-plugin-01470"].installedDistributionIntegrity = invalidIdentity.distributionIntegrity;
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/agentPluginLayout\/mcp\.json: must exactly launch the candidate MCP release/u,
  );

  const failedEvidence = structuredClone(evidence);
  const failedAgentLane = failedEvidence.lanes["agent-plugin-01470"];
  failedAgentLane.toolNames = [];
  failedAgentLane.freshProcess = false;
  failedAgentLane.checks.pluginInstall = false;
  failedAgentLane.installedDistributionIntegrity = null;
  failedAgentLane.checks.freshProcessStart = false;
  failedAgentLane.checks.mcpInitialize = false;
  failedAgentLane.checks.toolsList = false;
  failedAgentLane.checks.nelosConfigGet = false;
  failedAgentLane.checks.laneParity = false;
  failedAgentLane.processObservation.observedEnvironmentKeys = [];
  for (const environmentKey of Object.keys(failedAgentLane.processObservation.observedEnvironmentPaths)) {
    failedAgentLane.processObservation.observedEnvironmentPaths[environmentKey] = null;
  }
  failedEvidence.lanes["legacy-01446"].checks.laneParity = false;
  failedEvidence.result = {
    status: "failed",
    failures: ["agent-plugin.layout.invalid"],
  };
  await writeFile(evidencePath, `${JSON.stringify(failedEvidence)}\n`, { mode: 0o600 });
  await validateRepositoryContract(fixtureRoot, { evidencePath });
});

test("passed repository evidence requires the exact tracked legacy MCP layout", async (context) => {
  const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(context);
  const fixtureValidationRoot = join(fixtureRoot, "validation", "proxmox");
  const [contractBytes, toolchainLockBytes, contract, pluginManifest, candidateIdentity] = await Promise.all([
    readFile(join(fixtureValidationRoot, "contract.json")),
    readFile(join(fixtureValidationRoot, "toolchain.lock.json")),
    readJson(join(fixtureValidationRoot, "contract.json")),
    readJson(join(fixtureRoot, ".codex-plugin", "plugin.json")),
    readGitCandidateIdentity(fixtureRoot),
  ]);
  const evidence = createEvidenceProbe(contract, {
    contractSha256: createHash("sha256").update(contractBytes).digest("hex"),
    toolchainLockSha256: createHash("sha256").update(toolchainLockBytes).digest("hex"),
    pluginVersion: pluginManifest.version,
    ...candidateIdentity,
  });
  const evidencePath = join(artifactRoot, "legacy-layout-evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await validateRepositoryContract(fixtureRoot, { evidencePath });

  await execFileAsync("git", ["rm", "--quiet", ".mcp.json"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await execFileAsync("git", ["commit", "--quiet", "--message", "remove legacy MCP manifest"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/distributionIntegrity: candidate distribution entry is missing: \.mcp\.json/u,
  );

  const invalidLegacyMcp = await readJson(join(root, ".mcp.json"));
  invalidLegacyMcp.mcpServers.nelos.command = "bash";
  await writeFile(
    join(fixtureRoot, ".mcp.json"),
    `${JSON.stringify(invalidLegacyMcp, null, 2)}\n`,
    { mode: 0o600 },
  );
  await refreshFixtureDistributionProvenance(fixtureRoot);
  await execFileAsync("git", ["add", ".mcp.json", "distribution-provenance.json"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await execFileAsync("git", ["commit", "--quiet", "--message", "add invalid legacy MCP manifest"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  const invalidIdentity = await readGitCandidateIdentity(fixtureRoot);
  Object.assign(evidence.candidate, invalidIdentity);
  evidence.lanes["legacy-01446"].installedDistributionIntegrity = invalidIdentity.distributionIntegrity;
  evidence.lanes["agent-plugin-01470"].installedDistributionIntegrity = invalidIdentity.distributionIntegrity;
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/legacyPluginLayout\/\.mcp\.json: must exactly match the candidate-generated legacy MCP bootstrap/u,
  );

  const failedEvidence = structuredClone(evidence);
  failedEvidence.lanes["legacy-01446"].toolNames = [];
  failedEvidence.lanes["legacy-01446"].checks.pluginInstall = false;
  failedEvidence.lanes["legacy-01446"].installedDistributionIntegrity = null;
  failedEvidence.lanes["legacy-01446"].checks.mcpInitialize = false;
  failedEvidence.lanes["legacy-01446"].checks.toolsList = false;
  failedEvidence.lanes["legacy-01446"].checks.nelosConfigGet = false;
  failedEvidence.lanes["legacy-01446"].checks.laneParity = false;
  failedEvidence.lanes["agent-plugin-01470"].checks.laneParity = false;
  failedEvidence.result = {
    status: "failed",
    failures: ["legacy.layout.invalid"],
  };
  await writeFile(evidencePath, `${JSON.stringify(failedEvidence)}\n`, { mode: 0o600 });
  await validateRepositoryContract(fixtureRoot, { evidencePath });
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
  const workflowSource = await readFile(join(root, ".github", "workflows", "proxmox-template.yml"), "utf8");
  for (const dependencyPath of [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "distribution-provenance.json",
    "plugin.json",
    "mcp.json",
    "scripts/generate-mcp-config.mjs",
    "src/distribution-provenance.mjs",
  ]) {
    assert.equal(
      workflowSource.split(`- "${dependencyPath}"`).length - 1,
      2,
      `${dependencyPath} must trigger both pull-request and push source validation`,
    );
  }
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
  const [contractBytes, toolchainLockBytes, contract, pluginManifest, candidateIdentity] = await Promise.all([
    readFile(join(fixtureValidationRoot, "contract.json")),
    readFile(join(fixtureValidationRoot, "toolchain.lock.json")),
    readJson(join(fixtureValidationRoot, "contract.json")),
    readJson(join(fixtureRoot, ".codex-plugin", "plugin.json")),
    readGitCandidateIdentity(fixtureRoot),
  ]);
  const contractSha256 = createHash("sha256").update(contractBytes).digest("hex");
  const toolchainLockSha256 = createHash("sha256").update(toolchainLockBytes).digest("hex");
  const tamperDigest = (digest) => `${digest.startsWith("0") ? "1" : "0"}${digest.slice(1)}`;
  const evidence = createEvidenceProbe(contract, {
    contractSha256,
    toolchainLockSha256,
    pluginVersion: pluginManifest.version,
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
  evidence.candidate.distributionIntegrity = `sha256:${"5".repeat(64)}`;
  evidence.lanes["legacy-01446"].installedDistributionIntegrity =
    evidence.candidate.distributionIntegrity;
  evidence.lanes["agent-plugin-01470"].installedDistributionIntegrity =
    evidence.candidate.distributionIntegrity;
  await writeFile(evidencePath, JSON.stringify(evidence) + "\n", { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/distributionIntegrity: must match the exact candidate distribution bytes/u,
  );

  evidence.candidate.distributionIntegrity = candidateIdentity.distributionIntegrity;
  evidence.lanes["legacy-01446"].installedDistributionIntegrity = candidateIdentity.distributionIntegrity;
  evidence.lanes["agent-plugin-01470"].installedDistributionIntegrity = candidateIdentity.distributionIntegrity;
  await writeFile(evidencePath, JSON.stringify(evidence) + "\n", { mode: 0o600 });

  await writeFile(join(fixtureRoot, "README.md"), "changed distribution bytes\n", { mode: 0o600 });
  await runFixtureGit(["add", "README.md"], commitGitEnvironment());
  await runFixtureGit(
    ["commit", "--quiet", "--message", "change distribution without provenance"],
    commitGitEnvironment(),
  );
  const changedDistributionIdentity = await readGitCandidateIdentity(fixtureRoot);
  Object.assign(evidence.candidate, changedDistributionIdentity);
  evidence.lanes["legacy-01446"].installedDistributionIntegrity =
    changedDistributionIdentity.distributionIntegrity;
  evidence.lanes["agent-plugin-01470"].installedDistributionIntegrity =
    changedDistributionIdentity.distributionIntegrity;
  await writeFile(evidencePath, JSON.stringify(evidence) + "\n", { mode: 0o600 });
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/distributionProvenance\/integrity: must match the distribution digest recomputed/u,
  );

  await refreshFixtureDistributionProvenance(fixtureRoot);
  await runFixtureGit(["add", "distribution-provenance.json"], commitGitEnvironment());
  await runFixtureGit(
    ["commit", "--quiet", "--message", "refresh distribution provenance"],
    commitGitEnvironment(),
  );
  const refreshedDistributionIdentity = await readGitCandidateIdentity(fixtureRoot);
  Object.assign(evidence.candidate, refreshedDistributionIdentity);
  evidence.lanes["legacy-01446"].installedDistributionIntegrity =
    refreshedDistributionIdentity.distributionIntegrity;
  evidence.lanes["agent-plugin-01470"].installedDistributionIntegrity =
    refreshedDistributionIdentity.distributionIntegrity;
  await writeFile(evidencePath, JSON.stringify(evidence) + "\n", { mode: 0o600 });
  await validateRepositoryContract(fixtureRoot, { evidencePath });

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
    /\/candidate\/replacements: replacement refs are forbidden for exact candidates/u,
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
    /\/candidate\/dirty: exact candidate validation requires an exactly clean Git checkout/u,
  );
});

test("repository evidence rejects gitlink candidates before accepting their identity", async (context) => {
  const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(context);
  const fixtureValidationRoot = join(fixtureRoot, "validation", "proxmox");
  const [contractBytes, toolchainLockBytes, contract, pluginManifest, candidateIdentity] = await Promise.all([
    readFile(join(fixtureValidationRoot, "contract.json")),
    readFile(join(fixtureValidationRoot, "toolchain.lock.json")),
    readJson(join(fixtureValidationRoot, "contract.json")),
    readJson(join(fixtureRoot, ".codex-plugin", "plugin.json")),
    readGitCandidateIdentity(fixtureRoot),
  ]);
  const evidence = createEvidenceProbe(contract, {
    contractSha256: createHash("sha256").update(contractBytes).digest("hex"),
    toolchainLockSha256: createHash("sha256").update(toolchainLockBytes).digest("hex"),
    pluginVersion: pluginManifest.version,
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
    /\/candidate\/gitlinks: Gitlink and submodule entries are forbidden for exact candidates/u,
  );
});

test("repository evidence rejects tracked symlinks before reading their targets", async (context) => {
  const { artifactRoot, fixtureRoot } = await createCleanRepositoryFixture(context);
  const fixtureValidationRoot = join(fixtureRoot, "validation", "proxmox");
  const [contractBytes, toolchainLockBytes, contract, pluginManifest, candidateIdentity] = await Promise.all([
    readFile(join(fixtureValidationRoot, "contract.json")),
    readFile(join(fixtureValidationRoot, "toolchain.lock.json")),
    readJson(join(fixtureValidationRoot, "contract.json")),
    readJson(join(fixtureRoot, ".codex-plugin", "plugin.json")),
    readGitCandidateIdentity(fixtureRoot),
  ]);
  const evidence = createEvidenceProbe(contract, {
    contractSha256: createHash("sha256").update(contractBytes).digest("hex"),
    toolchainLockSha256: createHash("sha256").update(toolchainLockBytes).digest("hex"),
    pluginVersion: pluginManifest.version,
    ...candidateIdentity,
  });
  const evidencePath = join(artifactRoot, "symlink-evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });

  const pluginManifestPath = join(fixtureRoot, ".codex-plugin", "plugin.json");
  const externalTarget = join(artifactRoot, "invalid-external-plugin.json");
  await writeFile(externalTarget, "not json\n", { mode: 0o600 });
  await rm(pluginManifestPath);
  await symlink(externalTarget, pluginManifestPath);
  await execFileAsync("git", ["add", "--all"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });
  await execFileAsync("git", ["commit", "--quiet", "--message", "add forbidden symlink"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: commitGitEnvironment(),
  });

  const { stdout: symlinkRevisionOutput } = await execFileAsync(
    gitExecutable,
    [...gitIdentityArguments, "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
    { cwd: fixtureRoot, encoding: "utf8", env: cleanGitEnvironment() },
  );
  await assert.rejects(
    validateRepositoryContract(fixtureRoot, {
      candidateRevision: symlinkRevisionOutput.trim(),
    }),
    /\/candidate\/symlinks: Tracked symlink entries are forbidden for exact candidates/u,
  );

  await assert.rejects(
    validateRepositoryContract(fixtureRoot, { evidencePath }),
    /\/candidate\/symlinks: Tracked symlink entries are forbidden for exact candidates/u,
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
