import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ProxmoxApiClient, ProxmoxApiError } from "../lib/proxmox-api.mjs";
import {
  buildFinalEvidence,
  createCooperativeInterruptionController,
  DISPOSABLE_VMID_MAX,
  DISPOSABLE_VMID_MIN,
  LiveValidationError,
  LIVE_VALIDATION_HELP,
  PILOT_NODE,
  assertControllerEnvironment,
  parseLiveValidationArgs,
  preflightEvidenceOutput,
  runLiveValidation,
  SOURCE_TEMPLATE_VMID,
} from "../scripts/run-live-validation.mjs";
import {
  createEvidenceProbe,
  validateEvidenceDocument,
} from "../scripts/validate-contract.mjs";

const validationRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(validationRoot, "../..");
const revision = "a".repeat(40);
const runId = `run-${"d".repeat(32)}`;
const ownershipNonce = "1".repeat(32);
const disposableVmid = 9030;
const templateVersion = "1.0.0";
const pluginVersion = "0.12.12";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function makeCandidate() {
  const archive = Buffer.from("deterministic-candidate-archive", "utf8");
  const [contract, evidenceSchema, toolchainLock] = await Promise.all([
    readJson(join(validationRoot, "contract.json")),
    readJson(join(validationRoot, "evidence", "schema.json")),
    readJson(join(validationRoot, "toolchain.lock.json")),
  ]);
  return {
    revision,
    archive,
    treeSha256: "6".repeat(64),
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    distributionIntegrity: `sha256:${"7".repeat(64)}`,
    contract,
    evidenceSchema,
    toolchainLock,
    contractSha256: "b".repeat(64),
    toolchainLockSha256: "c".repeat(64),
    pluginVersion,
  };
}

function options(overrides = {}) {
  return {
    node: PILOT_NODE,
    sourceTemplateVmid: SOURCE_TEMPLATE_VMID,
    disposableVmid,
    candidateRevision: revision,
    templateVersion,
    repositoryRoot: "/unused/in/injected-test",
    guestAgentTimeoutMs: 20,
    guestAgentPollMs: 1,
    ...overrides,
  };
}

function makeGuestEvidence(candidate, overrides = {}) {
  const evidence = createEvidenceProbe(candidate.contract, {
    runId,
    sourceRevision: revision,
    treeSha256: candidate.treeSha256,
    archiveSha256: candidate.archiveSha256,
    distributionIntegrity: candidate.distributionIntegrity,
    pluginVersion,
    contractSha256: candidate.contractSha256,
    toolchainLockSha256: candidate.toolchainLockSha256,
  });
  evidence.schemaVersion = 1;
  delete evidence.lifecycle;
  delete evidence.candidate.archiveSha256;
  evidence.observations = {
    guestIdentityVerified: true,
    networkDeniedDuringValidation: true,
  };
  return Object.assign(evidence, overrides);
}

class FakeProxmoxApi {
  constructor(candidate, behavior = {}) {
    this.candidate = candidate;
    this.behavior = behavior;
    this.events = [];
    this.running = false;
    this.collected = false;
    this.child = null;
    this.childConfig = null;
    this.resources = [
      {
        type: "qemu",
        vmid: SOURCE_TEMPLATE_VMID,
        node: PILOT_NODE,
        name: "nelos-validator-provisional-prox2",
        template: 1,
        status: "stopped",
      },
      ...(behavior.initialResources ?? []),
    ];
  }

  async listClusterVms() {
    this.events.push("list");
    return structuredClone(this.resources);
  }

  async isClusterVmidFree(vmid) {
    const free = !this.resources.some((resource) => Number(resource.vmid) === vmid);
    this.events.push(`vmid-free:${free}`);
    return free;
  }

  async getVersion() {
    this.events.push("version");
    return { version: this.behavior.pveVersion ?? "8.4.19" };
  }

  async getVmConfig(_node, vmid) {
    this.events.push(`config:${vmid}`);
    if (vmid === SOURCE_TEMPLATE_VMID) {
      return { template: 1, agent: 1, onboot: this.behavior.sourceOnboot ?? 0 };
    }
    if (this.behavior.preexistingConfig && !this.child) return structuredClone(this.behavior.preexistingConfig);
    const config = structuredClone(this.childConfig);
    if (
      this.behavior.tamperOwnershipBeforeStart &&
      this.events.includes("update:network") &&
      !this.running
    ) {
      config.description = "operator-owned";
    }
    if (this.collected && this.behavior.tamperOwnershipDuringCleanup) {
      config.description = "operator-owned";
    }
    return config;
  }

  async cloneLinkedVm(cloneOptions) {
    this.events.push("clone");
    this.cloneOptions = structuredClone(cloneOptions);
    this.child = {
      type: "qemu",
      vmid: cloneOptions.newVmid,
      node: cloneOptions.node,
      name: cloneOptions.name,
      template: 0,
      status: "stopped",
    };
    this.childConfig = {
      name: cloneOptions.name,
      description: this.behavior.cloneDescriptionOverride ?? cloneOptions.description,
      tags: "nelos-validator;provisional",
      ...(!this.behavior.omitCloneDigest ? { digest: "clone-digest" } : {}),
      net0: "virtio=00:11:22:33:44:55,bridge=vmbr0,firewall=1",
      net7: "virtio=00:11:22:33:44:66,bridge=vmbr0,firewall=1",
    };
    this.resources.push(this.child);
    if (this.behavior.cloneErrorAfterCreate) {
      const error = new Error("ambiguous clone request");
      error.code = "api.request-failed";
      throw error;
    }
    return "upid-clone";
  }

  async updateVmConfig(_node, _vmid, changes) {
    this.events.push(`update:${changes.delete ? "network" : "ownership"}`);
    if (changes.delete) {
      if (!this.behavior.ignoreNetworkDelete) {
        for (const key of changes.delete.split(",")) delete this.childConfig[key];
      }
    } else if (!this.behavior.ignoreOwnershipUpdate) {
      Object.assign(this.childConfig, {
        name: changes.name,
        description: changes.description,
        tags: changes.tags,
      });
    }
    this.childConfig.digest = `${this.childConfig.digest}-next`;
    return this.behavior.configMutationUpid ? `upid-config-${this.events.length}` : null;
  }

  async startVm() {
    this.events.push("start");
    this.running = true;
    this.child.status = "running";
    return "upid-start";
  }

  async stopVm() {
    this.events.push("stop");
    this.running = false;
    this.child.status = "stopped";
    return "upid-stop";
  }

  async destroyVm() {
    this.events.push("destroy");
    this.resources = this.resources.filter((resource) => resource.vmid !== disposableVmid);
    this.child = null;
    return "upid-destroy";
  }

  async waitForTask(_node, upid) {
    this.events.push(`wait:${upid}`);
    if (upid === "upid-clone" && this.behavior.cloneWaitError) {
      const error = new Error("ambiguous clone task wait");
      error.code = "api.request-failed";
      throw error;
    }
    return { status: "stopped", exitstatus: "OK" };
  }

  async getVmStatus() {
    this.events.push("status");
    return { status: this.running ? "running" : "stopped" };
  }

  async pingGuestAgent() {
    this.events.push("qga-ping");
    if (this.behavior.qgaError) throw this.behavior.qgaError;
    return true;
  }

  async writeGuestFile(_node, _vmid, path, content) {
    this.events.push("qga-write");
    this.writtenPath = path;
    this.writtenContent = Buffer.from(content);
    return { bytesWritten: content.length };
  }

  async guestExec(_node, _vmid, command) {
    if (command[0] === "/usr/bin/cloud-init") {
      this.events.push("cloud-init");
      return { exitCode: this.behavior.cloudInitExitCode ?? 0, stdout: "status: done\n", stderr: "" };
    }
    if (command[0] === "/usr/bin/sha256sum") {
      this.events.push("archive-digest");
      return {
        exitCode: 0,
        stdout: `${this.behavior.archiveDigestOverride ?? this.candidate.archiveSha256}  ${command[1]}\n`,
        stderr: "",
      };
    }
    if (command[0] === "/bin/sh") {
      this.events.push("archive-extract");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command[0] === "/usr/local/bin/node") {
      this.events.push("collector");
      this.collectorCommand = structuredClone(command);
      this.collected = true;
      const evidence = makeGuestEvidence(this.candidate);
      if (this.behavior.guestIdentityVerified === false) {
        evidence.observations.guestIdentityVerified = false;
        evidence.result = { status: "failed", failures: ["guest.identity.failed"] };
      }
      if (this.behavior.networkDeniedDuringValidation === false) {
        evidence.observations.networkDeniedDuringValidation = false;
        evidence.result = { status: "failed", failures: ["guest.network.failed"] };
      }
      return {
        exitCode: this.behavior.collectorExitCode ?? 0,
        stdout: `${JSON.stringify(evidence)}\n`,
        stderr: "",
      };
    }
    throw new Error(`unexpected guest command: ${command[0]}`);
  }
}

async function execute(fake, candidate, optionOverrides = {}, injectedOverrides = {}) {
  return runLiveValidation(options(optionOverrides), {
    api: fake,
    prepareCandidate: async () => candidate,
    now: (() => {
      let value = 0;
      return () => value++;
    })(),
    sleep: async () => {},
    testOnly: {
      runId,
      ownershipNonce,
      inventorySettlementPollMs: 0,
      ...injectedOverrides.testOnly,
    },
    interruption: injectedOverrides.interruption,
  });
}

test("hard scope rejects every node, source template, and VMID outside the prox2 pilot", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate);
  for (const invalidOptions of [
    { node: "pve2" },
    { sourceTemplateVmid: 9001 },
    { disposableVmid: DISPOSABLE_VMID_MIN - 1 },
    { disposableVmid: DISPOSABLE_VMID_MAX + 1 },
    { disposableVmid: undefined },
    { templateVersion: "1.0.1" },
    { runId: "human-readable-label" },
  ]) {
    await assert.rejects(
      () => execute(api, candidate, invalidOptions),
      (error) => error instanceof LiveValidationError && error.code.startsWith("controller.scope."),
    );
  }
  assert.deepEqual(api.events, []);
});

test("ownership nonce is cryptographically generated per invocation when no test nonce is injected", async () => {
  const candidate = await makeCandidate();
  const first = new FakeProxmoxApi(candidate);
  const second = new FakeProxmoxApi(candidate);
  await execute(first, candidate, {}, { testOnly: { ownershipNonce: undefined } });
  await execute(second, candidate, {}, { testOnly: { ownershipNonce: undefined } });
  assert.notEqual(first.cloneOptions.name, second.cloneOptions.name);
  assert.notEqual(first.cloneOptions.description, second.cloneOptions.description);
  assert.match(first.cloneOptions.description, /^nelos-live-validation:[a-f0-9]{32}:/u);
});

test("--help is non-mutating and duplicate CLI flags fail closed", () => {
  assert.deepEqual(parseLiveValidationArgs(["--help"]), { help: true });
  assert.throws(
    () => parseLiveValidationArgs(["--help", "--disposable-vmid", "9030"]),
    (error) => error instanceof LiveValidationError && error.code === "controller.arguments.invalid-help",
  );
  assert.throws(
    () => parseLiveValidationArgs([
      "--disposable-vmid", "9030",
      "--disposable-vmid", "9031",
    ]),
    (error) => error instanceof LiveValidationError && error.code === "controller.arguments.duplicate",
  );
  assert.throws(
    () => parseLiveValidationArgs(["--run-id", runId]),
    (error) => error instanceof LiveValidationError && error.code === "controller.arguments.unknown",
  );
  const result = spawnSync(
    process.execPath,
    [join(validationRoot, "scripts", "run-live-validation.mjs"), "--help"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, LIVE_VALIDATION_HELP);
  assert.equal(result.stderr, "");
});

test("CLI rejects invalid output before controller environment, API construction, or mutation", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "nelos-live-output-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const safeParent = join(temporaryRoot, "safe");
  await mkdir(safeParent, { mode: 0o700 });
  const existingDestination = join(safeParent, "existing.json");
  await writeFile(existingDestination, "existing\n", { mode: 0o600 });
  const nonDirectoryParent = join(temporaryRoot, "not-a-directory");
  await writeFile(nonDirectoryParent, "not a directory\n", { mode: 0o600 });

  const commonArguments = [
    join(validationRoot, "scripts", "run-live-validation.mjs"),
    "--disposable-vmid", "9030",
    "--candidate-revision", revision,
    "--template-version", templateVersion,
  ];
  const environment = {
    PATH: process.env.PATH,
    NODE_USE_SYSTEM_CA: "1",
    PROXMOX_URL: "not-a-valid-url",
    PROXMOX_USERNAME: "nelos-template@pve!builder",
    PROXMOX_TOKEN: "test-only-token-value",
  };
  const cases = [
    ["relative-evidence.json", "controller.output.not-absolute"],
    [existingDestination, "controller.output.destination-exists"],
    [join(nonDirectoryParent, "evidence.json"), "controller.output.parent-not-directory"],
  ];

  for (const [outputPath, expectedCode] of cases) {
    const result = spawnSync(
      process.execPath,
      [...commonArguments, "--output", outputPath],
      { encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `run-live-validation: ${expectedCode}\n`);
  }
});

test("output preflight canonicalizes the parent and rejects a symlink escape into the repository", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "nelos-live-output-symlink-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const safeParent = join(temporaryRoot, "safe");
  const safeAlias = join(temporaryRoot, "safe-alias");
  const repositoryAlias = join(temporaryRoot, "repository-alias");
  await mkdir(safeParent, { mode: 0o700 });
  await symlink(safeParent, safeAlias, "dir");
  await symlink(repositoryRoot, repositoryAlias, "dir");

  assert.equal(await preflightEvidenceOutput(), null);
  assert.equal(
    await preflightEvidenceOutput(join(safeAlias, "evidence.json")),
    join(await realpath(safeParent), "evidence.json"),
  );
  await assert.rejects(
    () => preflightEvidenceOutput(join(repositoryAlias, "evidence.json")),
    (error) => error instanceof LiveValidationError &&
      error.code === "controller.output.inside-repository",
  );
});

test("controller requires the trusted Linux system CA mode without CA overrides", () => {
  const environment = {
    NODE_USE_SYSTEM_CA: "1",
    PROXMOX_URL: "https://pve2.sayers.io:8006/api2/json",
    PROXMOX_USERNAME: "nelos-template@pve!builder",
    PROXMOX_TOKEN: "a".repeat(32),
  };
  assert.doesNotThrow(() => assertControllerEnvironment(
    environment,
    { platform: "linux", arch: "x64" },
  ));
  assert.throws(
    () => assertControllerEnvironment(
      { ...environment, NODE_USE_SYSTEM_CA: undefined },
      { platform: "linux", arch: "x64" },
    ),
    (error) => error instanceof LiveValidationError &&
      error.code === "controller.environment.system-ca-required",
  );
  assert.throws(
    () => assertControllerEnvironment(
      { ...environment, NODE_EXTRA_CA_CERTS: "/tmp/ambient-ca.pem" },
      { platform: "linux", arch: "x64" },
    ),
    (error) => error instanceof LiveValidationError &&
      error.code === "controller.environment.ca-override",
  );
});

test("cooperative signal handler records only the first signal and can be disposed", () => {
  const emitter = new EventEmitter();
  const interruption = createCooperativeInterruptionController(emitter);
  emitter.emit("SIGTERM");
  emitter.emit("SIGINT");
  assert.equal(interruption.checkpoint(), "SIGTERM");
  interruption.dispose();
  assert.equal(emitter.listenerCount("SIGTERM"), 0);
  assert.equal(emitter.listenerCount("SIGINT"), 0);
});

test("successful run is a linked same-node clone with detached network and exact cleanup", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { configMutationUpid: true });
  const evidence = await execute(api, candidate);

  assert.equal(evidence.result.status, "passed");
  assert.deepEqual(evidence.result.failures, []);
  assert.deepEqual(evidence.lifecycle, {
    pilotNode: PILOT_NODE,
    sourceTemplateVmid: SOURCE_TEMPLATE_VMID,
    disposableVmid,
    clusterWideUnused: true,
    cloneMutationAttempted: true,
    cloneMutationSettlement: "settled-present",
    cloneCreated: true,
    linkedClone: true,
    sameNode: true,
    ownershipReadback: true,
    networkDetachedBeforeStart: true,
    guestIdentityVerified: true,
    networkDeniedDuringValidation: true,
    guestAgentReady: true,
    cloudInitStatus: "done",
    cleanupOutcome: "destroyed",
    clusterAbsentAfterCleanup: true,
  });
  assert.equal(api.cloneOptions.node, PILOT_NODE);
  assert.equal(api.cloneOptions.sourceVmid, SOURCE_TEMPLATE_VMID);
  assert.equal(api.cloneOptions.newVmid, disposableVmid);
  assert.equal(api.cloneOptions.full, false);
  assert.match(api.cloneOptions.description, /^nelos-live-validation:/u);
  assert.equal(api.cloneOptions.pool, "nelos-validator");
  assert(api.events.indexOf("update:network") < api.events.indexOf("start"));
  assert(api.events.includes("wait:upid-clone"));
  assert(api.events.includes("wait:upid-start"));
  assert(api.events.includes("wait:upid-stop"));
  assert(api.events.includes("wait:upid-destroy"));
  assert.equal(
    api.events.filter((event) => event.startsWith("wait:upid-config-")).length,
    2,
  );
  assert.deepEqual(api.writtenContent, candidate.archive);
  assert.equal(evidence.candidate.treeSha256, candidate.treeSha256);
  assert.equal(evidence.candidate.archiveSha256, candidate.archiveSha256);
  assert.equal(evidence.candidate.distributionIntegrity, candidate.distributionIntegrity);
  assert.notEqual(evidence.candidate.treeSha256, evidence.candidate.archiveSha256);
  assert(api.collectorCommand.includes("--source-revision"));
  assert(api.collectorCommand.includes("--tree-sha256"));
  assert(api.collectorCommand.includes(candidate.treeSha256));
  assert.equal(api.events.filter((event) => event === "vmid-free:true").length, 4);
  assert.equal(Object.hasOwn(evidence, "observations"), false);
  validateEvidenceDocument(evidence, candidate.evidenceSchema, candidate.contract);
});

test("Cloud-Init exit 2 is recorded as recoverable and does not invalidate a passing run", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { cloudInitExitCode: 2 });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "passed");
  assert.equal(evidence.lifecycle.cloudInitStatus, "done-with-recoverable-errors");
});

test("source onboot drift is rejected before clone mutation", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { sourceOnboot: 1 });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("controller.preflight.source-onboot"));
  assert.equal(evidence.lifecycle.cloneMutationAttempted, false);
  assert.equal(evidence.lifecycle.cloneMutationSettlement, "not-attempted");
  assert.equal(evidence.lifecycle.cleanupOutcome, "not-required");
  assert.equal(evidence.lifecycle.clusterAbsentAfterCleanup, true);
  assert(!api.events.includes("clone"));
  for (const lane of Object.values(evidence.lanes)) {
    assert.equal(lane.installedDistributionIntegrity, null);
    assert.deepEqual(lane.processObservation.observedEnvironmentKeys, []);
    assert.equal(
      Object.values(lane.processObservation.observedEnvironmentPaths).every((value) => value === null),
      true,
    );
  }
});

test("candidate transfer verifies archive bytes independently from canonical tree identity", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { archiveDigestOverride: "8".repeat(64) });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("controller.transfer.digest-mismatch"));
  assert(api.events.includes("archive-digest"));
  assert(!api.events.includes("archive-extract"));
  assert(!api.events.includes("collector"));
  assert.equal(evidence.lifecycle.cleanupOutcome, "destroyed");
});

test("an ambiguous terminal task wait is manual reconciliation and never destructive", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { cloneWaitError: true });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("api.request-failed"));
  assert.equal(evidence.lifecycle.cloneMutationAttempted, true);
  assert.equal(evidence.lifecycle.cloneMutationSettlement, "unresolved");
  assert.equal(evidence.lifecycle.cloneCreated, false);
  assert.equal(evidence.lifecycle.cleanupOutcome, "manual-reconcile");
  assert.equal(evidence.lifecycle.clusterAbsentAfterCleanup, false);
  assert(!api.events.includes("stop"));
  assert(!api.events.includes("destroy"));
});

test("same-options concurrent invocation cannot recognize or destroy the other nonce's clone", async () => {
  const candidate = await makeCandidate();
  const foreignNonce = "2".repeat(32);
  const api = new FakeProxmoxApi(candidate);
  api.cloneLinkedVm = async function cloneForeignDuringRace(cloneOptions) {
    this.events.push("clone");
    this.cloneOptions = structuredClone(cloneOptions);
    const foreignName = `nelos-val-${disposableVmid}-${foreignNonce.slice(0, 12)}`;
    this.child = {
      type: "qemu",
      vmid: disposableVmid,
      node: PILOT_NODE,
      name: foreignName,
      template: 0,
      status: "stopped",
    };
    this.childConfig = {
      name: foreignName,
      description: `nelos-live-validation:${foreignNonce}:${runId}:${revision}`,
      tags: `nelos-validation-${foreignNonce}`,
      digest: "foreign-digest",
    };
    this.resources.push(this.child);
    return "upid-clone";
  };
  const evidence = await execute(api, candidate);
  assert.notEqual(api.cloneOptions.name, api.child.name);
  assert.notEqual(api.cloneOptions.description, api.childConfig.description);
  assert.equal(evidence.lifecycle.cloneMutationSettlement, "unresolved");
  assert.equal(evidence.lifecycle.cleanupOutcome, "manual-reconcile");
  assert(evidence.result.failures.includes("controller.clone.settlement-unresolved"));
  assert(!api.events.includes("stop"));
  assert(!api.events.includes("destroy"));
  assert.equal(api.resources.some((resource) => resource.vmid === disposableVmid), true);
});

test("cooperative interruption stops advancement and still performs exact early cleanup", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate);
  const evidence = await execute(api, candidate, {}, {
    interruption: {
      checkpoint(stage) {
        return stage === "clone-settled" ? "SIGTERM" : null;
      },
    },
  });
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("controller.run.interrupted"));
  assert.equal(evidence.lifecycle.cloneMutationSettlement, "settled-present");
  assert.equal(evidence.lifecycle.ownershipReadback, false);
  assert.equal(evidence.lifecycle.cleanupOutcome, "destroyed");
  assert(api.events.includes("destroy"));
  assert(!api.events.includes("update:ownership"));
  assert(!api.events.includes("start"));
});

test("an interruption observed during cleanup cannot produce a passing receipt", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate);
  const evidence = await execute(api, candidate, {}, {
    interruption: {
      checkpoint(stage) {
        return stage === "cleanup-complete" ? "SIGINT" : null;
      },
    },
  });
  assert.equal(evidence.lifecycle.cleanupOutcome, "destroyed");
  assert.equal(evidence.lifecycle.clusterAbsentAfterCleanup, true);
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("controller.run.interrupted"));
});

test("QGA permission denial fails immediately instead of masquerading as readiness timeout", async () => {
  const candidate = await makeCandidate();
  const permissionError = new ProxmoxApiError("api.http-error", "denied", { status: 403 });
  const api = new FakeProxmoxApi(candidate, { qgaError: permissionError });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("controller.guest-agent.permission-denied"));
  assert.equal(api.events.filter((event) => event === "qga-ping").length, 1);
  assert(!evidence.result.failures.includes("controller.guest-agent.timeout"));
});

test("controller consumes exact guest observations without copying the internal object", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { guestIdentityVerified: false });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert.equal(evidence.lifecycle.guestIdentityVerified, false);
  assert.equal(evidence.lifecycle.networkDeniedDuringValidation, true);
  assert.equal(Object.hasOwn(evidence, "observations"), false);
});

test("cluster-wide collision is rejected before clone and never cleaned up as owned", async () => {
  const candidate = await makeCandidate();
  const matchingName = `nelos-val-${disposableVmid}-${ownershipNonce.slice(0, 12)}`;
  const api = new FakeProxmoxApi(candidate, {
    initialResources: [{
      type: "qemu",
      vmid: disposableVmid,
      node: PILOT_NODE,
      name: matchingName,
      status: "stopped",
    }],
    preexistingConfig: {
      name: matchingName,
      description: `nelos-live-validation:${ownershipNonce}:${runId}:${revision}`,
      tags: `nelos-validation-${ownershipNonce}`,
    },
  });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("controller.preflight.vmid-collision"));
  assert.equal(evidence.lifecycle.cloneMutationAttempted, false);
  assert.equal(evidence.lifecycle.cloneMutationSettlement, "not-attempted");
  assert.equal(evidence.lifecycle.cleanupOutcome, "manual-reconcile");
  assert.equal(evidence.lifecycle.clusterAbsentAfterCleanup, false);
  assert(!api.events.includes("clone"));
  assert(!api.events.includes("destroy"));
  assert(!api.events.includes("stop"));
  assert(!api.events.includes(`config:${disposableVmid}`));
});

test("random clone names are not claimed globally unique and VMID authority remains decisive", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, {
    initialResources: [{
      type: "qemu",
      vmid: 9050,
      node: PILOT_NODE,
      name: `nelos-val-${disposableVmid}-${ownershipNonce.slice(0, 12)}`,
      status: "stopped",
    }],
  });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "passed");
  assert.equal(evidence.lifecycle.clusterWideUnused, true);
  assert.equal(evidence.lifecycle.cleanupOutcome, "destroyed");
  assert.equal(evidence.lifecycle.clusterAbsentAfterCleanup, true);
  assert(api.events.includes("clone"));
  assert(api.events.includes("destroy"));
});

test("network deletion must survive readback before the VM can start", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { ignoreNetworkDelete: true });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("controller.network.detach-readback"));
  assert.equal(evidence.lifecycle.networkDetachedBeforeStart, false);
  assert.equal(evidence.lifecycle.cleanupOutcome, "destroyed");
  assert(!api.events.includes("start"));
  assert(api.events.includes("destroy"));
});

test("ownership adoption requires the atomically cloned description and a config digest", async () => {
  const candidate = await makeCandidate();
  for (const behavior of [
    { cloneDescriptionOverride: "operator-owned" },
    { omitCloneDigest: true },
  ]) {
    const api = new FakeProxmoxApi(candidate, behavior);
    const evidence = await execute(api, candidate);
    assert.equal(evidence.result.status, "failed");
    assert(
      evidence.result.failures.includes("controller.clone.atomic-identity-readback") ||
      evidence.result.failures.includes("controller.clone.config-digest-missing"),
    );
    assert.equal(evidence.lifecycle.ownershipReadback, false);
    assert(!api.events.includes("update:ownership"));
    assert(!api.events.includes("start"));
  }
});

test("ownership drift after network detachment is rejected immediately before start", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { tamperOwnershipBeforeStart: true });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("controller.clone.pre-start-ownership-readback"));
  assert.equal(evidence.lifecycle.networkDetachedBeforeStart, false);
  assert.equal(evidence.lifecycle.cleanupOutcome, "quarantined");
  assert(!api.events.includes("start"));
  assert(!api.events.includes("destroy"));
});

test("cleanup quarantines an ownership-drifted clone and never stops or destroys it", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { tamperOwnershipDuringCleanup: true });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("controller.cleanup.ownership-mismatch"));
  assert.equal(evidence.lifecycle.cleanupOutcome, "quarantined");
  assert.equal(evidence.lifecycle.clusterAbsentAfterCleanup, false);
  assert(!api.events.includes("stop"));
  assert(!api.events.includes("destroy"));
  assert.equal(evidence.lanes["legacy-01446"].checks.toolsList, true);
  assert.equal(evidence.lanes["agent-plugin-01470"].checks.toolsList, true);
  validateEvidenceDocument(evidence, candidate.evidenceSchema, candidate.contract);
});

test("failed ownership readback destroys only the stopped terminal clone bound by random name and description", async () => {
  const candidate = await makeCandidate();
  const api = new FakeProxmoxApi(candidate, { ignoreOwnershipUpdate: true });
  const evidence = await execute(api, candidate);
  assert.equal(evidence.result.status, "failed");
  assert.equal(evidence.lifecycle.ownershipReadback, false);
  assert.equal(evidence.lifecycle.cleanupOutcome, "destroyed");
  assert.equal(evidence.lanes["legacy-01446"].freshProcess, false);
  assert.equal(evidence.lanes["agent-plugin-01470"].freshProcess, false);
  assert(!api.events.includes("start"));
  assert(api.events.includes("destroy"));
});

test("buildFinalEvidence preserves successful lane truth when only cleanup fails", async () => {
  const candidate = await makeCandidate();
  const guestEvidence = makeGuestEvidence(candidate);
  const lifecycle = {
    pilotNode: PILOT_NODE,
    sourceTemplateVmid: SOURCE_TEMPLATE_VMID,
    disposableVmid,
    clusterWideUnused: true,
    cloneMutationAttempted: true,
    cloneMutationSettlement: "settled-present",
    cloneCreated: true,
    linkedClone: true,
    sameNode: true,
    ownershipReadback: true,
    networkDetachedBeforeStart: true,
    guestIdentityVerified: true,
    networkDeniedDuringValidation: true,
    guestAgentReady: true,
    cloudInitStatus: "done",
    cleanupOutcome: "quarantined",
    clusterAbsentAfterCleanup: false,
  };
  const evidence = buildFinalEvidence({
    guestEvidence,
    options: { ...options(), runId },
    candidate,
    lifecycle,
    failures: ["controller.cleanup.ownership-mismatch"],
  });
  assert.equal(evidence.result.status, "failed");
  assert.equal(evidence.lanes["legacy-01446"].checks.laneParity, true);
  assert.equal(evidence.lanes["agent-plugin-01470"].checks.laneParity, true);
});

test("controller failure remains schema-valid when every lane and lifecycle observation passed", async () => {
  const candidate = await makeCandidate();
  const guestEvidence = makeGuestEvidence(candidate);
  const lifecycle = {
    pilotNode: PILOT_NODE,
    sourceTemplateVmid: SOURCE_TEMPLATE_VMID,
    disposableVmid,
    clusterWideUnused: true,
    cloneMutationAttempted: true,
    cloneMutationSettlement: "settled-present",
    cloneCreated: true,
    linkedClone: true,
    sameNode: true,
    ownershipReadback: true,
    networkDetachedBeforeStart: true,
    guestIdentityVerified: true,
    networkDeniedDuringValidation: true,
    guestAgentReady: true,
    cloudInitStatus: "done",
    cleanupOutcome: "destroyed",
    clusterAbsentAfterCleanup: true,
  };
  const evidence = buildFinalEvidence({
    guestEvidence,
    options: { ...options(), runId },
    candidate,
    lifecycle,
    failures: ["controller.evidence.exit-mismatch"],
  });
  assert.equal(evidence.result.status, "failed");
  assert.deepEqual(evidence.result.failures, ["controller.evidence.exit-mismatch"]);
  validateEvidenceDocument(evidence, candidate.evidenceSchema, candidate.contract);
});

test("guest collector cannot smuggle lifecycle or extra lane fields into final evidence", async () => {
  const candidate = await makeCandidate();
  for (const mutate of [
    (evidence) => { evidence.lifecycle = { cleanupOutcome: "destroyed" }; },
    (evidence) => { evidence.lanes["legacy-01446"].rawEnvironment = { SECRET: "value" }; },
    (evidence) => { evidence.schemaVersion = 2; },
  ]) {
    const api = new FakeProxmoxApi(candidate);
    const originalGuestExec = api.guestExec.bind(api);
    api.guestExec = async (...argumentsList) => {
      const result = await originalGuestExec(...argumentsList);
      if (argumentsList[2][0] !== "/usr/local/bin/node") return result;
      const evidence = JSON.parse(result.stdout);
      mutate(evidence);
      return { ...result, stdout: `${JSON.stringify(evidence)}\n` };
    };
    const finalEvidence = await execute(api, candidate);
    assert.equal(finalEvidence.result.status, "failed");
    assert(finalEvidence.result.failures.some((code) => code.startsWith("controller.evidence.")));
    assert.equal(finalEvidence.lifecycle.cleanupOutcome, "destroyed");
    assert.equal(Object.hasOwn(finalEvidence, "rawEnvironment"), false);
    assert.equal(Object.hasOwn(finalEvidence.lanes["legacy-01446"], "rawEnvironment"), false);
  }
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("real API adapter encodes full=0 same-node clone and polls the returned UPID", async () => {
  const calls = [];
  const upid = "UPID:prox2:00000001:00000002:00000003:qmclone:9021:user@pve:";
  const fetchImpl = async (url, request) => {
    calls.push({ url: String(url), request: structuredClone(request) });
    if (String(url).includes("/clone")) return jsonResponse(upid);
    if (String(url).includes("/tasks/")) return jsonResponse({ status: "stopped", exitstatus: "OK" });
    throw new Error(`unexpected URL: ${url}`);
  };
  const api = new ProxmoxApiClient({
    baseUrl: "https://pve.example.test:8006/api2/json",
    tokenId: "user@pve!builder",
    tokenSecret: "01234567-89ab-cdef-0123-456789abcdef",
    fetchImpl,
    sleep: async () => {},
  });
  const observed = await api.cloneLinkedVm({
    node: PILOT_NODE,
    sourceVmid: SOURCE_TEMPLATE_VMID,
    newVmid: disposableVmid,
    name: "nelos-val-9030-test",
    description: "nelos-live-validation:test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pool: "nelos-validator",
  });
  await api.waitForTask(PILOT_NODE, observed);
  const cloneCall = calls[0];
  const body = new URLSearchParams(cloneCall.request.body);
  assert.equal(body.get("newid"), "9030");
  assert.equal(body.get("full"), "0");
  assert.equal(body.get("target"), PILOT_NODE);
  assert.equal(body.get("pool"), "nelos-validator");
  assert.match(body.get("description"), /^nelos-live-validation:/u);
  assert.match(cloneCall.request.headers.Authorization, /^PVEAPIToken=user@pve!builder=/u);
  assert.equal(calls.length, 2);
});

test("real API adapter rejects a mutation response without a UPID", async () => {
  const api = new ProxmoxApiClient({
    baseUrl: "https://pve.example.test:8006",
    tokenId: "user@pve!builder",
    tokenSecret: "01234567-89ab-cdef-0123-456789abcdef",
    fetchImpl: async () => jsonResponse(null),
  });
  await assert.rejects(
    () => api.startVm(PILOT_NODE, disposableVmid),
    (error) => error instanceof ProxmoxApiError && error.code === "api.mutation-missing-upid",
  );
});

test("VMID authority uses cluster nextid and current VM config is explicitly requested", async () => {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url: new URL(url), request });
    if (String(url).includes("/cluster/nextid")) {
      return new URL(url).searchParams.get("vmid") === "9030"
        ? jsonResponse("9030")
        : jsonResponse(null, 409);
    }
    if (String(url).includes("/config")) return jsonResponse({ name: "current-config" });
    throw new Error(`unexpected URL: ${url}`);
  };
  const api = new ProxmoxApiClient({
    baseUrl: "https://pve.example.test:8006",
    tokenId: "user@pve!builder",
    tokenSecret: "01234567-89ab-cdef-0123-456789abcdef",
    fetchImpl,
  });
  assert.equal(await api.isClusterVmidFree(9030), true);
  assert.equal(await api.isClusterVmidFree(9031), false);
  assert.deepEqual(await api.getVmConfig(PILOT_NODE, disposableVmid), { name: "current-config" });
  assert.equal(calls[0].url.pathname.endsWith("/cluster/nextid"), true);
  assert.equal(calls[0].url.searchParams.get("vmid"), "9030");
  assert.equal(calls[2].url.searchParams.get("current"), "1");
});

test("QGA exec sends argv as repeated form fields and preserves input-data", async () => {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url: String(url), request });
    if (String(url).endsWith("/agent/exec")) return jsonResponse({ pid: 17 });
    if (String(url).includes("/agent/exec-status")) {
      return jsonResponse({ exited: true, exitcode: 0, "out-data": "ok\n", "err-data": "" });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const api = new ProxmoxApiClient({
    baseUrl: "https://pve.example.test:8006",
    tokenId: "user@pve!builder",
    tokenSecret: "01234567-89ab-cdef-0123-456789abcdef",
    fetchImpl,
    sleep: async () => {},
  });
  const command = ["/bin/sh", "-ceu", "printf %s \"$1\"", "qga-test", "hello"];
  const result = await api.guestExec(PILOT_NODE, disposableVmid, command, { inputData: "cGF5bG9hZA==" });
  const body = new URLSearchParams(calls[0].request.body);
  assert.deepEqual(body.getAll("command"), command);
  assert.equal(body.get("input-data"), "cGF5bG9hZA==");
  assert.equal(new URL(calls[1].url).searchParams.get("pid"), "17");
  assert.equal(result.stdout, "ok\n");
});

test("API HTTP errors expose only a safe numeric status", async () => {
  const api = new ProxmoxApiClient({
    baseUrl: "https://pve.example.test:8006",
    tokenId: "user@pve!builder",
    tokenSecret: "01234567-89ab-cdef-0123-456789abcdef",
    fetchImpl: async () => new Response("sensitive response body", { status: 403 }),
  });
  await assert.rejects(
    () => api.getVersion(),
    (error) => {
      assert(error instanceof ProxmoxApiError);
      assert.equal(error.code, "api.http-error");
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, /sensitive/u);
      return true;
    },
  );
});
