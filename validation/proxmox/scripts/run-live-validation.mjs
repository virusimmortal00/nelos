#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ProxmoxApiClient } from "../lib/proxmox-api.mjs";
import {
  createExactCandidateArchive,
  createEvidenceProbe,
  readTrackedCandidateBytes,
  validateEvidenceDocument,
  validateProxmoxContract,
  validateToolchainLock,
} from "./validate-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../../..");

export const PILOT_NODE = "prox2";
export const SOURCE_TEMPLATE_VMID = 9021;
export const DISPOSABLE_VMID_MIN = 9030;
export const DISPOSABLE_VMID_MAX = 9039;
export const VALIDATOR_POOL = "nelos-validator";

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DISTRIBUTION_INTEGRITY = /^sha256:[a-f0-9]{64}$/u;
const OWNERSHIP_NONCE = /^[a-f0-9]{32}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const RUN_ID = /^run-[a-f0-9]{32}$/u;
const NETWORK_KEY = /^net\d+$/u;
const FAILURE_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){1,4}$/u;
const INVENTORY_SETTLEMENT_ATTEMPTS = 5;
const INVENTORY_ABSENCE_READS = 3;
const INVENTORY_SETTLEMENT_POLL_MS = 2_000;

export const LIVE_VALIDATION_HELP = `Usage:
  node validation/proxmox/scripts/run-live-validation.mjs \\
    --disposable-vmid 9030 \\
    --candidate-revision <40-or-64-hex-commit> \\
    --template-version 1.0.0 \\
    [--output /absolute/path/outside/repository/evidence.json]

Fixed pilot scope: node prox2, source template 9021, pool nelos-validator.
Allowed disposable VMIDs: 9030-9039. No VM is selected automatically.
`;

export class LiveValidationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "LiveValidationError";
    this.code = code;
  }
}

export function createCooperativeInterruptionController(emitter = process) {
  let firstSignal = null;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (firstSignal === null) firstSignal = signal;
    };
    handlers.set(signal, handler);
    emitter.on(signal, handler);
  }
  return {
    checkpoint() {
      return firstSignal;
    },
    dispose() {
      for (const [signal, handler] of handlers) emitter.off(signal, handler);
    },
  };
}

function fail(code, message, options) {
  throw new LiveValidationError(code, message, options);
}

function isWithin(root, candidate) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("controller.evidence.invalid-json", `${label} is not valid JSON`, { cause: error });
  }
}

function safeFailureCode(error, fallback) {
  return typeof error?.code === "string" && FAILURE_CODE.test(error.code) ? error.code : fallback;
}

function uniqueFailureCodes(codes) {
  return [...new Set(codes.filter((code) => FAILURE_CODE.test(code)))].slice(0, 100);
}

function assertFixedScope(options) {
  if (options.node !== PILOT_NODE) {
    fail("controller.scope.invalid-node", `live validation is restricted to ${PILOT_NODE}`);
  }
  if (options.sourceTemplateVmid !== SOURCE_TEMPLATE_VMID) {
    fail("controller.scope.invalid-template", `live validation is restricted to template ${SOURCE_TEMPLATE_VMID}`);
  }
  if (
    !Number.isInteger(options.disposableVmid) ||
    options.disposableVmid < DISPOSABLE_VMID_MIN ||
    options.disposableVmid > DISPOSABLE_VMID_MAX
  ) {
    fail(
      "controller.scope.invalid-disposable-vmid",
      `disposable VMID must be explicitly selected from ${DISPOSABLE_VMID_MIN}-${DISPOSABLE_VMID_MAX}`,
    );
  }
  if (!RUN_ID.test(options.runId)) {
    fail("controller.scope.invalid-run-id", "run ID must be an opaque controller-generated identifier");
  }
  if (!GIT_OBJECT_ID.test(options.candidateRevision)) {
    fail("controller.source.invalid-revision", "candidate revision must be an exact lowercase Git object ID");
  }
  if (!SEMVER.test(options.templateVersion)) {
    fail("controller.scope.invalid-template-version", "template version must be an exact semantic version");
  }
}

function assertNotInterrupted(interruption, stage) {
  const signal = interruption?.checkpoint?.(stage);
  if (signal) fail("controller.run.interrupted", `live validation was interrupted at ${stage}`);
}

function ownershipIdentity(runId, disposableVmid, candidateRevision, nonce) {
  if (!OWNERSHIP_NONCE.test(nonce)) {
    fail("controller.ownership.invalid-nonce", "ownership nonce must contain 128 bits of lowercase hexadecimal data");
  }
  return {
    nonce,
    name: `nelos-val-${disposableVmid}-${nonce.slice(0, 12)}`,
    tag: `nelos-validation-${nonce}`,
    description: `nelos-live-validation:${nonce}:${runId}:${candidateRevision}`,
  };
}

function splitTags(value) {
  return typeof value === "string" ? value.split(";").filter(Boolean) : [];
}

function vmidOf(resource) {
  const value = Number(resource?.vmid);
  return Number.isInteger(value) ? value : null;
}

function findVmid(resources, vmid) {
  return resources.filter((resource) => vmidOf(resource) === vmid);
}

function assertClusterPreflight(resources, options) {
  if (!Array.isArray(resources)) fail("controller.preflight.invalid-inventory", "cluster VM inventory is malformed");
  const sourceMatches = findVmid(resources, options.sourceTemplateVmid);
  if (sourceMatches.length !== 1) {
    fail("controller.preflight.source-identity", "source template VMID is not unique in cluster inventory");
  }
  const source = sourceMatches[0];
  if (source.node !== options.node || Number(source.template) !== 1 || source.type !== "qemu") {
    fail("controller.preflight.source-identity", "source VMID is not the expected same-node QEMU template");
  }
  return source;
}

function assertSourceConfig(config) {
  if (config === null || typeof config !== "object" || Number(config.template) !== 1) {
    fail("controller.preflight.source-config", "source VM configuration is not a template");
  }
  if (!/^(?:1|enabled=1)(?:,|$)/u.test(String(config.agent ?? ""))) {
    fail("controller.preflight.source-agent", "source template does not enable QEMU guest agent support");
  }
  if (Number(config.onboot ?? 0) !== 0) {
    fail("controller.preflight.source-onboot", "source template must have onboot disabled before cloning");
  }
}

function assertPve84(version) {
  if (typeof version?.version !== "string" || !/^8\.4(?:[.-]|$)/u.test(version.version)) {
    fail("controller.preflight.pve-version", "pilot requires Proxmox VE 8.4");
  }
  return "8.4";
}

async function awaitMutation(api, node, mutation) {
  const upid = await mutation();
  if (upid !== null && upid !== undefined) await api.waitForTask(node, upid);
  return upid;
}

function assertCloneResource(resources, options, identity) {
  const matches = findVmid(resources, options.disposableVmid);
  if (matches.length !== 1) fail("controller.clone.identity", "clone VMID is not unique after clone completion");
  const resource = matches[0];
  if (resource.type !== "qemu" || resource.node !== options.node || resource.name !== identity.name) {
    fail("controller.clone.identity", "clone resource identity does not match the requested same-node clone");
  }
  return resource;
}

function classifyTargetInventory(resources, options, identity) {
  if (!Array.isArray(resources)) return { state: "invalid" };
  const vmidMatches = findVmid(resources, options.disposableVmid);
  if (vmidMatches.length === 1) {
    const resource = vmidMatches[0];
    if (
      resource.type === "qemu" &&
      Number(resource.template ?? 0) === 0 &&
      resource.node === options.node &&
      resource.name === identity.name
    ) {
      return { state: "present", resource };
    }
  }
  return { state: "conflict" };
}

async function settleTargetInventory(api, options, identity, dependencies) {
  let consecutiveAbsences = 0;
  let observedFailure = false;
  for (let attempt = 0; attempt < dependencies.inventorySettlementAttempts; attempt += 1) {
    try {
      if (await api.isClusterVmidFree(options.disposableVmid)) {
        consecutiveAbsences += 1;
        if (consecutiveAbsences >= dependencies.inventoryAbsenceReads) return { state: "absent" };
        if (attempt + 1 < dependencies.inventorySettlementAttempts) {
          await dependencies.sleep(dependencies.inventorySettlementPollMs);
        }
        continue;
      }
      consecutiveAbsences = 0;
      const classification = classifyTargetInventory(await api.listClusterVms(), options, identity);
      if (classification.state === "present" || classification.state === "conflict") return classification;
      observedFailure = true;
    } catch {
      consecutiveAbsences = 0;
      observedFailure = true;
    }
    if (attempt + 1 < dependencies.inventorySettlementAttempts) {
      await dependencies.sleep(dependencies.inventorySettlementPollMs);
    }
  }
  return { state: "unresolved", observedFailure };
}

function ownsClone(resource, config, options, identity) {
  return (
    resource?.type === "qemu" &&
    Number(resource?.template ?? 0) === 0 &&
    resource?.node === options.node &&
    vmidOf(resource) === options.disposableVmid &&
    resource?.name === identity.name &&
    Number(config?.template ?? 0) === 0 &&
    config?.name === identity.name &&
    config?.description === identity.description &&
    splitTags(config?.tags).includes(identity.tag)
  );
}

function ownsTerminalEarlyClone(resource, config, options, identity) {
  return (
    resource?.type === "qemu" &&
    Number(resource?.template ?? 0) === 0 &&
    resource?.node === options.node &&
    vmidOf(resource) === options.disposableVmid &&
    resource?.name === identity.name &&
    Number(config?.template ?? 0) === 0 &&
    config?.name === identity.name &&
    config?.description === identity.description
  );
}

function requireConfigDigest(config) {
  if (typeof config?.digest !== "string" || config.digest.length === 0) {
    fail("controller.clone.config-digest-missing", "clone configuration has no concurrency digest");
  }
  return config.digest;
}

function assertTerminalEarlyCloneReadback(resource, config, options, identity) {
  if (resource?.status !== "stopped" || !ownsTerminalEarlyClone(resource, config, options, identity)) {
    fail(
      "controller.clone.atomic-identity-readback",
      "clone did not retain its atomic stopped name and description before ownership adoption",
    );
  }
  return requireConfigDigest(config);
}

function assertOwnedCloneReadback(resources, config, options, identity, expectedStatus, code) {
  const resource = assertCloneResource(resources, options, identity);
  if (resource.status !== expectedStatus || !ownsClone(resource, config, options, identity)) {
    fail(code, `clone ownership did not survive ${expectedStatus} state readback`);
  }
  requireConfigDigest(config);
  return resource;
}

function networkKeys(config) {
  return Object.keys(config ?? {}).filter((key) => NETWORK_KEY.test(key)).sort();
}

async function waitForGuestAgent(api, options, dependencies) {
  const deadline = dependencies.now() + (options.guestAgentTimeoutMs ?? 5 * 60_000);
  while (dependencies.now() <= deadline) {
    assertNotInterrupted(dependencies.interruption, "guest-agent-wait");
    try {
      if (await api.pingGuestAgent(options.node, options.disposableVmid)) return;
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        fail("controller.guest-agent.permission-denied", "QEMU guest agent access was denied");
      }
      const retryableStatus = new Set([408, 425, 429, 500, 502, 503, 504, 595, 596, 598, 599]);
      const retryable = error?.code === "api.request-failed" ||
        (error?.code === "api.http-error" && retryableStatus.has(error.status));
      if (!retryable) {
        fail("controller.guest-agent.probe-failed", "QEMU guest agent readiness probe failed unexpectedly");
      }
    }
    await dependencies.sleep(options.guestAgentPollMs ?? 2_000);
  }
  fail("controller.guest-agent.timeout", "QEMU guest agent did not become ready before the deadline");
}

function assertCommandSucceeded(result, failureCode, label) {
  if (result?.exitCode !== 0) fail(failureCode, `${label} failed inside the disposable guest`);
  return result;
}

async function stageCandidate(api, options, candidate) {
  const runRoot = `/var/lib/nelos-validator/runs/${options.runId}`;
  const archivePath = `${runRoot}/candidate.tar`;
  const candidateRoot = `${runRoot}/candidate`;
  await api.writeGuestFile(options.node, options.disposableVmid, archivePath, candidate.archive);
  const digestResult = assertCommandSucceeded(
    await api.guestExec(
      options.node,
      options.disposableVmid,
      ["/usr/bin/sha256sum", archivePath],
    ),
    "controller.transfer.digest-command",
    "candidate digest verification",
  );
  const observedDigest = String(digestResult.stdout).trim().split(/\s+/u)[0];
  if (observedDigest !== candidate.archiveSha256) {
    fail("controller.transfer.digest-mismatch", "transferred candidate archive digest does not match");
  }
  assertCommandSucceeded(
    await api.guestExec(
      options.node,
      options.disposableVmid,
      [
        "/bin/sh",
        "-ceu",
        'test ! -e "$1"; install -d -m 0700 "$1"; tar -xf "$2" -C "$1" --no-same-owner --no-same-permissions; test -f "$1/validation/proxmox/scripts/run-plugin-evidence.mjs"; test ! -L "$1/validation/proxmox/scripts/run-plugin-evidence.mjs"',
        "nelos-stage-candidate",
        candidateRoot,
        archivePath,
      ],
    ),
    "controller.transfer.extract-failed",
    "candidate extraction",
  );
  return { runRoot, candidateRoot };
}

function collectorCommand(options, candidate, paths) {
  return [
    "/usr/local/bin/node",
    `${paths.candidateRoot}/validation/proxmox/scripts/run-plugin-evidence.mjs`,
    "--run-id",
    options.runId,
    "--candidate-root",
    paths.candidateRoot,
    "--source-revision",
    candidate.revision,
    "--tree-sha256",
    candidate.treeSha256,
    "--contract",
    `${paths.candidateRoot}/validation/proxmox/contract.json`,
    "--toolchain-lock",
    `${paths.candidateRoot}/validation/proxmox/toolchain.lock.json`,
    "--template-version",
    options.templateVersion,
    "--contract-sha256",
    candidate.contractSha256,
    "--toolchain-lock-sha256",
    candidate.toolchainLockSha256,
  ];
}

function assertGuestEvidence(evidence, options, candidate) {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    fail("controller.evidence.invalid-document", "guest evidence is not an object");
  }
  const assertExactKeys = (value, expected, label) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail("controller.evidence.invalid-shape", `${label} is not an object`);
    }
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
      fail("controller.evidence.invalid-shape", `${label} has an unexpected field set`);
    }
  };
  assertExactKeys(
    evidence,
    [
      "schemaVersion",
      "contractVersion",
      "runId",
      "candidate",
      "template",
      "observations",
      "lanes",
      "sanitization",
      "result",
    ],
    "guest evidence",
  );
  if (evidence.schemaVersion !== 1 || evidence.contractVersion !== candidate.contract.contractVersion) {
    fail("controller.evidence.invalid-version", "guest evidence must use the internal pre-lifecycle schema version");
  }
  assertExactKeys(
    evidence.candidate,
    ["sourceRevision", "treeSha256", "distributionIntegrity", "dirty"],
    "guest candidate evidence",
  );
  assertExactKeys(
    evidence.observations,
    ["guestIdentityVerified", "networkDeniedDuringValidation"],
    "guest observations",
  );
  if (
    typeof evidence.observations.guestIdentityVerified !== "boolean" ||
    typeof evidence.observations.networkDeniedDuringValidation !== "boolean"
  ) {
    fail("controller.evidence.invalid-observations", "guest observations must be exact booleans");
  }
  assertExactKeys(
    evidence.template,
    [
      "templateVersion",
      "proxmoxVeVersion",
      "operatingSystem",
      "architecture",
      "contractSha256",
      "toolchainLockSha256",
    ],
    "guest template evidence",
  );
  assertExactKeys(evidence.lanes, ["legacy-01446", "agent-plugin-01470"], "guest lane evidence");
  for (const laneId of ["legacy-01446", "agent-plugin-01470"]) {
    const lane = evidence.lanes[laneId];
    assertExactKeys(
      lane,
      [
        "codexVersion",
        "freshProcess",
        "home",
        "codexHome",
        "tmpDir",
        "xdgConfigHome",
        "xdgCacheHome",
        "xdgDataHome",
        "pluginVersion",
        "installedDistributionIntegrity",
        "pluginManifestPath",
        "mcpManifestPath",
        "launchMode",
        "processObservation",
        "toolNames",
        "checks",
      ],
      `guest ${laneId} lane evidence`,
    );
    assertExactKeys(
      lane.processObservation,
      [
        "commandClass",
        "cwdClass",
        "observedEnvironmentKeys",
        "observedEnvironmentPaths",
        "fullCommandCaptured",
        "fullEnvironmentCaptured",
      ],
      `guest ${laneId} process observation`,
    );
    assertExactKeys(
      lane.checks,
      [
        "marketplaceInstall",
        "pluginInstall",
        "freshProcessStart",
        "mcpInitialize",
        "toolsList",
        "nelosConfigGet",
        "laneParity",
      ],
      `guest ${laneId} checks`,
    );
  }
  assertExactKeys(
    evidence.sanitization,
    [
      "status",
      "redactionsApplied",
      "credentialsCaptured",
      "fullEnvironmentCaptured",
      "fullConfigurationCaptured",
      "userSpecificIdentifiersCaptured",
      "macStateCaptured",
    ],
    "guest sanitization evidence",
  );
  assertExactKeys(evidence.result, ["status", "failures"], "guest result evidence");
  if (
    evidence.runId !== options.runId ||
    evidence.candidate?.sourceRevision !== candidate.revision ||
    evidence.candidate?.treeSha256 !== candidate.treeSha256 ||
    evidence.candidate?.distributionIntegrity !== candidate.distributionIntegrity ||
    evidence.candidate?.dirty !== false
  ) {
    fail("controller.evidence.candidate-mismatch", "guest evidence candidate identity does not match the transfer");
  }
  if (
    evidence.template?.templateVersion !== options.templateVersion ||
    evidence.template?.proxmoxVeVersion !== "8.4" ||
    evidence.template?.operatingSystem !== "ubuntu-24.04-lts" ||
    evidence.template?.architecture !== "x86_64" ||
    evidence.template?.contractSha256 !== candidate.contractSha256 ||
    evidence.template?.toolchainLockSha256 !== candidate.toolchainLockSha256
  ) {
    fail("controller.evidence.template-mismatch", "guest evidence template identity does not match controller inputs");
  }
  const sanitization = evidence.sanitization;
  if (
    sanitization?.status !== "passed" ||
    sanitization?.redactionsApplied !== true ||
    sanitization?.credentialsCaptured !== false ||
    sanitization?.fullEnvironmentCaptured !== false ||
    sanitization?.fullConfigurationCaptured !== false ||
    sanitization?.userSpecificIdentifiersCaptured !== false ||
    sanitization?.macStateCaptured !== false
  ) {
    fail("controller.evidence.sanitization-failed", "guest evidence did not attest required sanitization");
  }
  return evidence;
}

function failedLaneEvidence(contract, runId, pluginVersion) {
  const probe = createEvidenceProbe(contract, { runId, pluginVersion });
  for (const laneId of Object.keys(probe.lanes)) {
    const lane = probe.lanes[laneId];
    lane.freshProcess = false;
    lane.installedDistributionIntegrity = null;
    lane.processObservation.observedEnvironmentKeys = [];
    for (const key of Object.keys(lane.processObservation.observedEnvironmentPaths)) {
      lane.processObservation.observedEnvironmentPaths[key] = null;
    }
    lane.toolNames = [];
    for (const check of Object.keys(lane.checks)) lane.checks[check] = false;
  }
  return probe.lanes;
}

function lifecyclePassed(lifecycle) {
  return (
    lifecycle.clusterWideUnused === true &&
    lifecycle.cloneMutationAttempted === true &&
    lifecycle.cloneMutationSettlement === "settled-present" &&
    lifecycle.cloneCreated === true &&
    lifecycle.linkedClone === true &&
    lifecycle.sameNode === true &&
    lifecycle.ownershipReadback === true &&
    lifecycle.networkDetachedBeforeStart === true &&
    lifecycle.guestIdentityVerified === true &&
    lifecycle.networkDeniedDuringValidation === true &&
    lifecycle.guestAgentReady === true &&
    ["done", "done-with-recoverable-errors"].includes(lifecycle.cloudInitStatus) &&
    lifecycle.cleanupOutcome === "destroyed" &&
    lifecycle.clusterAbsentAfterCleanup === true
  );
}

export function buildFinalEvidence({ guestEvidence, options, candidate, lifecycle, failures }) {
  const base = structuredClone(guestEvidence ?? createEvidenceProbe(candidate.contract, {
    runId: options.runId,
    pluginVersion: candidate.pluginVersion,
    distributionIntegrity: candidate.distributionIntegrity,
  }));
  delete base.observations;
  delete base.lifecycle;
  const laneEvidence = guestEvidence?.lanes ?? failedLaneEvidence(
    candidate.contract,
    options.runId,
    candidate.pluginVersion,
  );
  const guestFailures = Array.isArray(guestEvidence?.result?.failures) ? guestEvidence.result.failures : [];
  const allFailures = uniqueFailureCodes([...guestFailures, ...failures]);
  const passed = guestEvidence?.result?.status === "passed" && allFailures.length === 0 && lifecyclePassed(lifecycle);
  if (!passed && allFailures.length === 0) allFailures.push("controller.lifecycle.incomplete");
  return {
    ...base,
    schemaVersion: 2,
    contractVersion: candidate.contract.contractVersion,
    runId: options.runId,
    candidate: {
      sourceRevision: candidate.revision,
      treeSha256: candidate.treeSha256,
      archiveSha256: candidate.archiveSha256,
      distributionIntegrity: candidate.distributionIntegrity,
      dirty: false,
    },
    template: {
      templateVersion: options.templateVersion,
      proxmoxVeVersion: "8.4",
      operatingSystem: "ubuntu-24.04-lts",
      architecture: "x86_64",
      contractSha256: candidate.contractSha256,
      toolchainLockSha256: candidate.toolchainLockSha256,
    },
    lifecycle: structuredClone(lifecycle),
    lanes: structuredClone(laneEvidence),
    sanitization: {
      status: "passed",
      redactionsApplied: true,
      credentialsCaptured: false,
      fullEnvironmentCaptured: false,
      fullConfigurationCaptured: false,
      userSpecificIdentifiersCaptured: false,
      macStateCaptured: false,
    },
    result: {
      status: passed ? "passed" : "failed",
      failures: passed ? [] : allFailures,
    },
  };
}

async function reconcileClone(api, options, identity, lifecycle, dependencies) {
  if (lifecycle.cloneMutationSettlement === "unresolved") {
    lifecycle.cleanupOutcome = "manual-reconcile";
    lifecycle.clusterAbsentAfterCleanup = false;
    return "controller.cleanup.clone-settlement-unresolved";
  }

  const settlement = await settleTargetInventory(api, options, identity, dependencies);
  if (settlement.state === "absent") {
    if (lifecycle.cloneMutationSettlement === "settled-present") {
      lifecycle.cleanupOutcome = "manual-reconcile";
      lifecycle.clusterAbsentAfterCleanup = true;
      return "controller.cleanup.clone-disappeared";
    }
    lifecycle.cleanupOutcome = "not-required";
    lifecycle.clusterAbsentAfterCleanup = true;
    return null;
  }
  if (settlement.state === "unresolved") {
    lifecycle.cleanupOutcome = "manual-reconcile";
    lifecycle.clusterAbsentAfterCleanup = false;
    return "controller.cleanup.inventory-unresolved";
  }
  if (settlement.state === "conflict" || lifecycle.cloneMutationSettlement !== "settled-present") {
    lifecycle.cleanupOutcome = "manual-reconcile";
    lifecycle.clusterAbsentAfterCleanup = false;
    return lifecycle.cloneMutationAttempted
      ? "controller.cleanup.identity-ambiguous"
      : "controller.cleanup.preexisting-collision";
  }

  const resource = settlement.resource;
  if (!lifecycle.ownershipReadback && resource.status !== "stopped") {
    lifecycle.cleanupOutcome = "quarantined";
    lifecycle.clusterAbsentAfterCleanup = false;
    return "controller.cleanup.early-clone-not-stopped";
  }
  let config;
  try {
    config = await api.getVmConfig(options.node, options.disposableVmid);
  } catch {
    lifecycle.cleanupOutcome = "quarantined";
    lifecycle.clusterAbsentAfterCleanup = false;
    return "controller.cleanup.readback-failed";
  }
  const fullyOwned = ownsClone(resource, config, options, identity);
  const earlyOwned = !lifecycle.ownershipReadback &&
    ownsTerminalEarlyClone(resource, config, options, identity);
  if (!fullyOwned && !earlyOwned) {
    lifecycle.cleanupOutcome = "quarantined";
    lifecycle.clusterAbsentAfterCleanup = false;
    return "controller.cleanup.ownership-mismatch";
  }
  lifecycle.cloneCreated = true;
  try {
    const status = await api.getVmStatus(options.node, options.disposableVmid);
    if (earlyOwned && status?.status !== "stopped") {
      lifecycle.cleanupOutcome = "quarantined";
      lifecycle.clusterAbsentAfterCleanup = false;
      return "controller.cleanup.early-clone-not-stopped";
    }
    if (status?.status === "running") {
      await awaitMutation(api, options.node, () => api.stopVm(options.node, options.disposableVmid));
    }
    await awaitMutation(api, options.node, () => api.destroyVm(options.node, options.disposableVmid));
    const after = await settleTargetInventory(api, options, identity, dependencies);
    if (after.state !== "absent") {
      lifecycle.cleanupOutcome = "manual-reconcile";
      lifecycle.clusterAbsentAfterCleanup = false;
      return "controller.cleanup.destroy-not-reconciled";
    }
    lifecycle.cleanupOutcome = "destroyed";
    lifecycle.clusterAbsentAfterCleanup = true;
    return null;
  } catch {
    lifecycle.cleanupOutcome = "manual-reconcile";
    lifecycle.clusterAbsentAfterCleanup = false;
    return "controller.cleanup.destroy-failed";
  }
}

export async function prepareCandidateArchive(root, expectedRevision) {
  if (!GIT_OBJECT_ID.test(expectedRevision)) {
    fail("controller.source.invalid-revision", "candidate revision must be an exact lowercase Git object ID");
  }
  const identity = await createExactCandidateArchive(root, expectedRevision);
  const [contractBytes, contractSchemaBytes, schemaBytes, lockBytes, manifestBytes] = await Promise.all([
    readTrackedCandidateBytes(root, identity, "validation/proxmox/contract.json", "candidate contract"),
    readTrackedCandidateBytes(
      root,
      identity,
      "validation/proxmox/contract.schema.json",
      "candidate contract schema",
    ),
    readTrackedCandidateBytes(root, identity, "validation/proxmox/evidence/schema.json", "candidate evidence schema"),
    readTrackedCandidateBytes(root, identity, "validation/proxmox/toolchain.lock.json", "candidate toolchain lock"),
    readTrackedCandidateBytes(root, identity, ".codex-plugin/plugin.json", "candidate plugin manifest"),
  ]);
  const contract = parseJson(contractBytes.toString("utf8"), "candidate contract");
  const evidenceSchema = parseJson(schemaBytes.toString("utf8"), "candidate evidence schema");
  const toolchainLock = parseJson(lockBytes.toString("utf8"), "candidate toolchain lock");
  const pluginManifest = parseJson(manifestBytes.toString("utf8"), "candidate plugin manifest");
  validateProxmoxContract(
    contract,
    parseJson(contractSchemaBytes.toString("utf8"), "candidate contract schema"),
  );
  validateToolchainLock(toolchainLock, contract);
  if (!SEMVER.test(pluginManifest.version)) {
    fail("controller.source.invalid-plugin-version", "candidate package version is not semantic");
  }
  return {
    revision: identity.sourceRevision,
    archive: identity.archive,
    treeSha256: identity.treeSha256,
    archiveSha256: identity.archiveSha256,
    distributionIntegrity: identity.distributionIntegrity,
    contract,
    evidenceSchema,
    toolchainLock,
    contractSha256: sha256(contractBytes),
    toolchainLockSha256: sha256(lockBytes),
    pluginVersion: pluginManifest.version,
  };
}

export async function runLiveValidation(options, injected = {}) {
  if (options?.runId !== undefined) {
    fail("controller.scope.user-run-id-forbidden", "run IDs are generated by the controller");
  }
  const generatedRunId = injected.testOnly?.runId ?? `run-${randomBytes(16).toString("hex")}`;
  const normalized = {
    node: options?.node ?? PILOT_NODE,
    sourceTemplateVmid: options?.sourceTemplateVmid ?? SOURCE_TEMPLATE_VMID,
    disposableVmid: options?.disposableVmid,
    runId: generatedRunId,
    candidateRevision: options?.candidateRevision,
    templateVersion: options?.templateVersion,
    pool: VALIDATOR_POOL,
    repositoryRoot: options?.repositoryRoot ?? repositoryRoot,
    guestAgentTimeoutMs: options?.guestAgentTimeoutMs,
    guestAgentPollMs: options?.guestAgentPollMs,
  };
  assertFixedScope(normalized);
  const dependencies = {
    prepareCandidate: injected.prepareCandidate ?? prepareCandidateArchive,
    now: injected.now ?? Date.now,
    sleep: injected.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    inventorySettlementAttempts: injected.testOnly?.inventorySettlementAttempts ?? INVENTORY_SETTLEMENT_ATTEMPTS,
    inventoryAbsenceReads: injected.testOnly?.inventoryAbsenceReads ?? INVENTORY_ABSENCE_READS,
    inventorySettlementPollMs: injected.testOnly?.inventorySettlementPollMs ?? INVENTORY_SETTLEMENT_POLL_MS,
    interruption: injected.interruption ?? { checkpoint: () => null },
  };
  if (
    !Number.isInteger(dependencies.inventorySettlementAttempts) ||
    !Number.isInteger(dependencies.inventoryAbsenceReads) ||
    dependencies.inventoryAbsenceReads < 2 ||
    dependencies.inventorySettlementAttempts < dependencies.inventoryAbsenceReads ||
    !Number.isInteger(dependencies.inventorySettlementPollMs) ||
    dependencies.inventorySettlementPollMs < 0
  ) {
    fail("controller.inventory.invalid-settlement-policy", "inventory settlement policy is invalid");
  }
  const api = injected.api;
  if (!api) fail("controller.api.missing", "a Proxmox API adapter is required");
  assertNotInterrupted(dependencies.interruption, "candidate-preparation");
  const candidate = await dependencies.prepareCandidate(normalized.repositoryRoot, normalized.candidateRevision);
  assertNotInterrupted(dependencies.interruption, "candidate-prepared");
  if (
    candidate.revision !== normalized.candidateRevision ||
    !Buffer.isBuffer(candidate.archive) ||
    !SHA256.test(candidate.treeSha256) ||
    !SHA256.test(candidate.archiveSha256) ||
    candidate.archiveSha256 !== sha256(candidate.archive) ||
    !DISTRIBUTION_INTEGRITY.test(candidate.distributionIntegrity)
  ) {
    fail("controller.source.invalid-candidate", "prepared candidate identity is inconsistent");
  }
  validateToolchainLock(candidate.toolchainLock, candidate.contract);
  if (normalized.templateVersion !== candidate.contract.contractVersion) {
    fail("controller.scope.template-version-mismatch", "template version must match the candidate contract version");
  }

  const ownershipNonce = injected.testOnly?.ownershipNonce ?? randomBytes(16).toString("hex");
  const identity = ownershipIdentity(
    normalized.runId,
    normalized.disposableVmid,
    normalized.candidateRevision,
    ownershipNonce,
  );
  const lifecycle = {
    pilotNode: PILOT_NODE,
    sourceTemplateVmid: SOURCE_TEMPLATE_VMID,
    disposableVmid: normalized.disposableVmid,
    clusterWideUnused: false,
    cloneMutationAttempted: false,
    cloneMutationSettlement: "not-attempted",
    cloneCreated: false,
    linkedClone: false,
    sameNode: false,
    ownershipReadback: false,
    networkDetachedBeforeStart: false,
    guestIdentityVerified: false,
    networkDeniedDuringValidation: false,
    guestAgentReady: false,
    cloudInitStatus: "not-started",
    cleanupOutcome: "not-required",
    clusterAbsentAfterCleanup: false,
  };
  const failures = [];
  let guestEvidence = null;

  try {
    assertNotInterrupted(dependencies.interruption, "preflight");
    const [resources, disposableVmidFree] = await Promise.all([
      api.listClusterVms(),
      api.isClusterVmidFree(normalized.disposableVmid),
    ]);
    assertClusterPreflight(resources, normalized);
    if (!disposableVmidFree) {
      fail("controller.preflight.vmid-collision", "disposable VMID is already allocated cluster-wide");
    }
    lifecycle.clusterWideUnused = true;
    const [sourceConfig, version] = await Promise.all([
      api.getVmConfig(normalized.node, normalized.sourceTemplateVmid),
      api.getVersion(),
    ]);
    assertSourceConfig(sourceConfig);
    assertPve84(version);

    assertNotInterrupted(dependencies.interruption, "clone-mutation");
    lifecycle.cloneMutationAttempted = true;
    try {
      await awaitMutation(api, normalized.node, () => api.cloneLinkedVm({
        node: normalized.node,
        sourceVmid: normalized.sourceTemplateVmid,
        newVmid: normalized.disposableVmid,
        name: identity.name,
        description: identity.description,
        pool: normalized.pool,
        full: false,
      }));
    } catch (error) {
      await settleTargetInventory(api, normalized, identity, dependencies);
      lifecycle.cloneMutationSettlement = "unresolved";
      throw error;
    }
    const cloneSettlement = await settleTargetInventory(api, normalized, identity, dependencies);
    if (cloneSettlement.state === "absent") {
      lifecycle.cloneMutationSettlement = "settled-absent";
      fail("controller.clone.settled-absent", "clone task completed but the disposable VMID remained absent");
    }
    if (cloneSettlement.state !== "present") {
      lifecycle.cloneMutationSettlement = "unresolved";
      fail("controller.clone.settlement-unresolved", "clone task could not be reconciled to this invocation");
    }
    lifecycle.cloneMutationSettlement = "settled-present";
    lifecycle.cloneCreated = true;
    lifecycle.linkedClone = true;
    assertCloneResource([cloneSettlement.resource], normalized, identity);
    lifecycle.sameNode = true;
    assertNotInterrupted(dependencies.interruption, "clone-settled");

    let cloneConfig = await api.getVmConfig(normalized.node, normalized.disposableVmid);
    const cloneConfigDigest = assertTerminalEarlyCloneReadback(
      cloneSettlement.resource,
      cloneConfig,
      normalized,
      identity,
    );
    const tags = [...new Set([...splitTags(cloneConfig.tags), identity.tag])].sort().join(";");
    assertNotInterrupted(dependencies.interruption, "ownership-update");
    await awaitMutation(api, normalized.node, () => api.updateVmConfig(normalized.node, normalized.disposableVmid, {
      name: identity.name,
      description: identity.description,
      tags,
      digest: cloneConfigDigest,
    }));
    const ownedResources = await api.listClusterVms();
    cloneConfig = await api.getVmConfig(normalized.node, normalized.disposableVmid);
    assertOwnedCloneReadback(
      ownedResources,
      cloneConfig,
      normalized,
      identity,
      "stopped",
      "controller.clone.ownership-readback",
    );
    lifecycle.ownershipReadback = true;

    const attachedNetworks = networkKeys(cloneConfig);
    if (attachedNetworks.length > 0) {
      assertNotInterrupted(dependencies.interruption, "network-detachment");
      await awaitMutation(api, normalized.node, () => api.updateVmConfig(
        normalized.node,
        normalized.disposableVmid,
        { delete: attachedNetworks.join(","), digest: cloneConfig.digest },
      ));
    }
    const [preStartResources, preStartConfig] = await Promise.all([
      api.listClusterVms(),
      api.getVmConfig(normalized.node, normalized.disposableVmid),
    ]);
    cloneConfig = preStartConfig;
    assertOwnedCloneReadback(
      preStartResources,
      cloneConfig,
      normalized,
      identity,
      "stopped",
      "controller.clone.pre-start-ownership-readback",
    );
    if (networkKeys(cloneConfig).length !== 0) {
      fail("controller.network.detach-readback", "clone still has a virtual network device before start");
    }
    lifecycle.networkDetachedBeforeStart = true;

    assertNotInterrupted(dependencies.interruption, "guest-start");
    await awaitMutation(api, normalized.node, () => api.startVm(normalized.node, normalized.disposableVmid));
    await waitForGuestAgent(api, normalized, dependencies);
    lifecycle.guestAgentReady = true;
    assertNotInterrupted(dependencies.interruption, "guest-agent-ready");

    const cloudInit = await api.guestExec(
      normalized.node,
      normalized.disposableVmid,
      ["/usr/bin/cloud-init", "status", "--wait"],
      { timeoutMs: 10 * 60_000 },
    );
    if (cloudInit.exitCode === 0) lifecycle.cloudInitStatus = "done";
    else if (cloudInit.exitCode === 2) lifecycle.cloudInitStatus = "done-with-recoverable-errors";
    else {
      lifecycle.cloudInitStatus = "failed";
      fail("controller.cloud-init.failed", "Cloud-Init did not reach an accepted terminal state");
    }
    assertNotInterrupted(dependencies.interruption, "cloud-init-complete");

    const [validationResources, validationConfig] = await Promise.all([
      api.listClusterVms(),
      api.getVmConfig(normalized.node, normalized.disposableVmid),
    ]);
    assertOwnedCloneReadback(
      validationResources,
      validationConfig,
      normalized,
      identity,
      "running",
      "controller.clone.pre-validation-ownership-readback",
    );
    if (networkKeys(validationConfig).length !== 0) {
      fail("controller.network.validation-attached", "clone gained a network device before validation");
    }
    assertNotInterrupted(dependencies.interruption, "candidate-transfer");
    const paths = await stageCandidate(api, normalized, candidate);
    assertNotInterrupted(dependencies.interruption, "guest-collector");
    const collection = await api.guestExec(
      normalized.node,
      normalized.disposableVmid,
      collectorCommand(normalized, candidate, paths),
      { timeoutMs: 10 * 60_000 },
    );
    assertNotInterrupted(dependencies.interruption, "guest-collector-complete");
    if (collection.exitCode !== 0 && String(collection.stdout).trim() === "") {
      fail("controller.evidence.collector-failed", "guest evidence collector failed without a receipt");
    }
    if (Buffer.byteLength(String(collection.stdout), "utf8") > 1024 * 1024) {
      fail("controller.evidence.too-large", "guest evidence exceeds the sanitized receipt size limit");
    }
    guestEvidence = assertGuestEvidence(
      parseJson(String(collection.stdout), "guest evidence"),
      normalized,
      candidate,
    );
    lifecycle.guestIdentityVerified = guestEvidence.observations.guestIdentityVerified;
    lifecycle.networkDeniedDuringValidation = guestEvidence.observations.networkDeniedDuringValidation;
    if (collection.exitCode !== 0 && guestEvidence.result?.status !== "failed") {
      fail("controller.evidence.exit-mismatch", "collector exit status conflicts with guest evidence");
    }
  } catch (error) {
    failures.push(safeFailureCode(error, "controller.run.failed"));
  } finally {
    const cleanupFailure = await reconcileClone(api, normalized, identity, lifecycle, dependencies);
    if (cleanupFailure) failures.push(cleanupFailure);
  }
  if (dependencies.interruption.checkpoint?.("cleanup-complete")) {
    failures.push("controller.run.interrupted");
  }

  const evidence = buildFinalEvidence({ guestEvidence, options: normalized, candidate, lifecycle, failures });
  try {
    validateEvidenceDocument(evidence, candidate.evidenceSchema, candidate.contract, {
      sourceRevision: candidate.revision,
      treeSha256: candidate.treeSha256,
      archiveSha256: candidate.archiveSha256,
      distributionIntegrity: candidate.distributionIntegrity,
      contractSha256: candidate.contractSha256,
      toolchainLockSha256: candidate.toolchainLockSha256,
    });
  } catch (error) {
    fail("controller.evidence.self-validation", "controller produced invalid sanitized evidence", { cause: error });
  }
  return evidence;
}

export function parseLiveValidationArgs(argumentsList) {
  if (argumentsList.length === 1 && argumentsList[0] === "--help") return { help: true };
  if (argumentsList.includes("--help")) {
    fail("controller.arguments.invalid-help", "--help cannot be combined with mutation arguments");
  }
  const options = {
    node: PILOT_NODE,
    sourceTemplateVmid: SOURCE_TEMPLATE_VMID,
  };
  const accepted = new Set([
    "--node",
    "--source-template-vmid",
    "--disposable-vmid",
    "--candidate-revision",
    "--template-version",
    "--output",
  ]);
  const seen = new Set();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!accepted.has(argument)) fail("controller.arguments.unknown", `unknown argument: ${argument}`);
    if (seen.has(argument)) fail("controller.arguments.duplicate", `duplicate argument: ${argument}`);
    seen.add(argument);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) fail("controller.arguments.missing-value", `${argument} requires a value`);
    if (argument === "--node") options.node = value;
    else if (argument === "--source-template-vmid") options.sourceTemplateVmid = Number(value);
    else if (argument === "--disposable-vmid") options.disposableVmid = Number(value);
    else if (argument === "--candidate-revision") options.candidateRevision = value;
    else if (argument === "--template-version") options.templateVersion = value;
    else options.outputPath = value;
    index += 1;
  }
  return options;
}

export function assertControllerEnvironment(
  environment = process.env,
  runtime = { platform: process.platform, arch: process.arch },
) {
  if (runtime.platform !== "linux" || runtime.arch !== "x64") {
    fail("controller.environment.unsupported", "live validation requires a dedicated Linux x86_64 controller");
  }
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    if (environment[name]) fail("controller.environment.proxy-set", "proxy variables are forbidden for live validation");
  }
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    fail("controller.environment.tls-disabled", "TLS verification cannot be disabled");
  }
  if (environment.NODE_USE_SYSTEM_CA !== "1") {
    fail(
      "controller.environment.system-ca-required",
      "Node.js must start with NODE_USE_SYSTEM_CA=1 so the trusted PVE CA is available",
    );
  }
  for (const name of [
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    if (environment[name]) {
      fail(
        "controller.environment.ca-override",
        "ambient Node.js and OpenSSL CA overrides are forbidden for live validation",
      );
    }
  }
  for (const name of ["PROXMOX_URL", "PROXMOX_USERNAME", "PROXMOX_TOKEN"]) {
    if (!environment[name]) fail("controller.environment.missing-secret", `required process variable is missing: ${name}`);
  }
}

export async function preflightEvidenceOutput(outputPath) {
  if (!outputPath) return null;
  if (!isAbsolute(outputPath)) {
    fail("controller.output.not-absolute", "evidence output path must be absolute");
  }

  const lexicalDestination = resolve(outputPath);
  if (isWithin(repositoryRoot, lexicalDestination)) {
    fail("controller.output.inside-repository", "live evidence cannot be written inside the source repository");
  }

  const destinationName = basename(outputPath);
  if (!destinationName || destinationName === "." || destinationName === "..") {
    fail("controller.output.destination-invalid", "evidence output destination must name a new file");
  }
  const lexicalParent = dirname(outputPath);
  let canonicalParent;
  try {
    canonicalParent = await realpath(lexicalParent);
  } catch (error) {
    const code = error?.code === "ENOENT"
      ? "controller.output.parent-missing"
      : "controller.output.parent-invalid";
    fail(code, "evidence output parent must be an existing accessible directory", { cause: error });
  }

  let parentMetadata;
  try {
    parentMetadata = await stat(canonicalParent);
  } catch (error) {
    fail("controller.output.parent-invalid", "evidence output parent cannot be inspected safely", { cause: error });
  }
  if (!parentMetadata.isDirectory()) {
    fail("controller.output.parent-not-directory", "evidence output parent must be a directory");
  }

  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const canonicalDestination = resolve(canonicalParent, destinationName);
  if (isWithin(canonicalRepositoryRoot, canonicalDestination)) {
    fail("controller.output.inside-repository", "live evidence cannot be written inside the source repository");
  }

  let destinationExists = false;
  try {
    await lstat(canonicalDestination);
    destinationExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fail("controller.output.destination-invalid", "evidence output destination cannot be inspected safely", {
        cause: error,
      });
    }
  }
  if (destinationExists) {
    fail("controller.output.destination-exists", "evidence output destination must not already exist");
  }

  try {
    await access(canonicalParent, fsConstants.W_OK | fsConstants.X_OK);
  } catch (error) {
    fail("controller.output.parent-not-writable", "evidence output parent is not writable", { cause: error });
  }
  return canonicalDestination;
}

async function writeEvidenceOutput(evidence, destination) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (!destination) {
    process.stdout.write(serialized);
    return;
  }
  await writeFile(destination, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function main() {
  const options = parseLiveValidationArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(LIVE_VALIDATION_HELP);
    return;
  }
  const outputDestination = await preflightEvidenceOutput(options.outputPath);
  assertControllerEnvironment();
  const api = new ProxmoxApiClient({
    baseUrl: process.env.PROXMOX_URL,
    tokenId: process.env.PROXMOX_USERNAME,
    tokenSecret: process.env.PROXMOX_TOKEN,
  });
  const interruption = createCooperativeInterruptionController();
  let evidence;
  try {
    evidence = await runLiveValidation(options, { api, interruption });
  } finally {
    interruption.dispose();
  }
  await writeEvidenceOutput(evidence, outputDestination);
  if (evidence.result.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    const code = safeFailureCode(error, "controller.run.failed");
    process.stderr.write(`run-live-validation: ${code}\n`);
    process.exitCode = 1;
  });
}
