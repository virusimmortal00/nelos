import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

test("Proxmox contract pins the Linux CLI template and two Codex lanes", async () => {
  const { contract, contractSchema, toolchainLock } = await loadFixture();

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
  assert.match(buildWrapper, /git_readonly status --porcelain=v1 --untracked-files=all/u);
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
  assert.deepEqual(await validateRepositoryContract(root), {
    valid: true,
    offline: true,
    contractVersion: "1.0.0",
    lanes: ["legacy-01446", "agent-plugin-01470"],
  });

  const blocker = fileURLToPath(new URL("../../../scripts/offline-network-blocker.cjs", import.meta.url));
  const validator = fileURLToPath(new URL("../scripts/validate-contract.mjs", import.meta.url));
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
