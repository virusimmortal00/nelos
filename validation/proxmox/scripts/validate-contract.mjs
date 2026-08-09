#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../../..");
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const UBUNTU_APT_SNAPSHOT = /^\d{8}T\d{6}Z$/u;

const EXPECTED_ARTIFACTS = Object.freeze({
  packer: {
    version: "1.15.4",
    fileName: "packer_1.15.4_linux_amd64.zip",
    url: "https://releases.hashicorp.com/packer/1.15.4/packer_1.15.4_linux_amd64.zip",
    sha256: "15f97a6a99645c7d5308c609973b5280837b38e112beac413ccbce80da927cf1",
  },
  packerProxmoxPlugin: {
    version: "1.2.4",
    fileName: "packer-plugin-proxmox_v1.2.4_x5.0_linux_amd64.zip",
    url: "https://github.com/hashicorp/packer-plugin-proxmox/releases/download/v1.2.4/packer-plugin-proxmox_v1.2.4_x5.0_linux_amd64.zip",
    sha256: "84a50e8204180756708671809df0f4ec7bcdde9d702c74c7c4e005d3ce9d89e5",
  },
  ubuntuCloudImage: {
    version: "release-20260801",
    fileName: "ubuntu-24.04-server-cloudimg-amd64.img",
    url: "https://cloud-images.ubuntu.com/releases/noble/release-20260801/ubuntu-24.04-server-cloudimg-amd64.img",
    sha256: "0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe",
  },
  node: {
    version: "24.18.0",
    fileName: "node-v24.18.0-linux-x64.tar.xz",
    url: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz",
    sha256: "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
  },
  codexLegacy: {
    version: "0.144.6",
    fileName: "codex-package-x86_64-unknown-linux-musl.tar.gz",
    url: "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-package-x86_64-unknown-linux-musl.tar.gz",
    sha256: "99ae48e4743da6c530ecd998ab2f7e66572c092f4190c88dca8236c07b06ce1d",
    laneId: "legacy-01446",
  },
  codexAgentPlugin: {
    version: "0.147.0",
    fileName: "codex-package-x86_64-unknown-linux-musl.tar.gz",
    url: "https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
    sha256: "bd758d53d56e41dc65e045f4589df79a038ed197a011adcb52a258e6ad64cfda",
    laneId: "agent-plugin-01470",
  },
});

export class ProxmoxContractError extends Error {
  constructor(path, message) {
    super(`${path || "/"}: ${message}`);
    this.name = "ProxmoxContractError";
    this.path = path;
  }
}

function fail(path, message) {
  throw new ProxmoxContractError(path, message);
}

function pointer(path, segment) {
  const escaped = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertClosedObject(value, fields, path) {
  if (!isObject(value)) fail(path, "must be an object");
  const expected = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) fail(pointer(path, field), "unknown field");
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) fail(pointer(path, field), "required field is missing");
  }
}

function resolveLocalReference(rootSchema, reference, path) {
  if (!reference.startsWith("#/")) fail(path, `only local schema references are allowed: ${reference}`);
  let current = rootSchema;
  for (const encoded of reference.slice(2).split("/")) {
    const field = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !Object.hasOwn(current, field)) {
      fail(path, `schema reference does not resolve: ${reference}`);
    }
    current = current[field];
  }
  return current;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

export function validateAgainstSchema(value, schema, options = {}) {
  const rootSchema = options.rootSchema ?? schema;
  const path = options.path ?? "";
  if (typeof schema === "boolean") {
    if (!schema) fail(path, "schema rejects every value");
    return value;
  }
  if (!isObject(schema)) fail(path, "schema must be an object or boolean");
  if (schema.$ref !== undefined) {
    validateAgainstSchema(value, resolveLocalReference(rootSchema, schema.$ref, path), {
      rootSchema,
      path,
    });
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    fail(path, `must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
    fail(path, `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }
  if (schema.type !== undefined) {
    const accepted = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = valueType(value);
    const compatible = accepted.includes(actual) || (actual === "integer" && accepted.includes("number"));
    if (!compatible) fail(path, `must have type ${accepted.join(" or ")}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, "is too short");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, "is too long");
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      fail(path, `must match ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, "has too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, "has too many items");
    if (schema.uniqueItems) {
      for (let index = 0; index < value.length; index += 1) {
        if (value.slice(0, index).some((item) => isDeepStrictEqual(item, value[index]))) {
          fail(pointer(path, index), "must be unique");
        }
      }
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateAgainstSchema(item, schema.items, {
        rootSchema,
        path: pointer(path, index),
      }));
    }
  }
  if (isObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) fail(pointer(path, required), "required field is missing");
    }
    const properties = schema.properties ?? {};
    for (const [field, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, field)) {
        validateAgainstSchema(item, properties[field], { rootSchema, path: pointer(path, field) });
      } else if (schema.additionalProperties === false) {
        fail(pointer(path, field), "unknown field");
      } else if (isObject(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
        validateAgainstSchema(item, schema.additionalProperties, { rootSchema, path: pointer(path, field) });
      }
    }
  }
  return value;
}

function assertOnlyLocalReferences(value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertOnlyLocalReferences(item, pointer(path, index)));
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#/")) {
    fail(pointer(path, "$ref"), "schema references must be local for offline validation");
  }
  for (const [field, item] of Object.entries(value)) {
    assertOnlyLocalReferences(item, pointer(path, field));
  }
}

function assertNoUserSpecificMaterial(value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUserSpecificMaterial(item, pointer(path, index)));
    return;
  }
  if (isObject(value)) {
    for (const [field, item] of Object.entries(value)) {
      assertNoUserSpecificMaterial(item, pointer(path, field));
    }
    return;
  }
  if (typeof value !== "string") return;
  const forbidden = [
    /\/Users\//u,
    /^\/home\/[A-Za-z0-9._-]+(?:\/|$)/u,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
    /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/u,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
    /\.(?:corp|internal|lan|local)\b/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(value))) {
    fail(path, "must not contain user-specific host, address, identity, or home material");
  }
}

function assertExactSet(actual, expected, path) {
  if (!Array.isArray(actual) || actual.length !== expected.length || expected.some((item) => !actual.includes(item))) {
    fail(path, `must contain exactly ${expected.join(", ")}`);
  }
}

export function validateProxmoxContract(contract, contractSchema) {
  assertOnlyLocalReferences(contractSchema);
  validateAgainstSchema(contract, contractSchema);
  assertNoUserSpecificMaterial(contract);
  assertExactSet(contract.scope.supportedProducts, ["codex-cli"], "/scope/supportedProducts");
  assertExactSet(
    contract.scope.excludedSurfaces,
    ["arm64", "codex-desktop", "codex-ide", "macos", "windows"],
    "/scope/excludedSurfaces",
  );
  const environment = contract.isolation.environment;
  if (environment.HOME !== "${LANE_ROOT}/home" || environment.CODEX_HOME !== `${environment.HOME}/.codex`) {
    fail("/isolation/environment/CODEX_HOME", "must resolve to HOME/.codex for the legacy bootstrap");
  }
  if (!contract.isolation.freshCodexProcessPerVerification) {
    fail("/isolation/freshCodexProcessPerVerification", "a fresh Codex process is required");
  }
  if (!contract.validation.offline || contract.validation.validationNetwork !== "denied") {
    fail("/validation", "validation must be offline with network denied");
  }
  if (contract.validation.buildNetwork !== "allowlisted") {
    fail("/validation/buildNetwork", "template build downloads must be allowlisted");
  }
  return contract;
}

export function validateToolchainLock(lock, contract) {
  assertClosedObject(lock, ["schemaVersion", "contractVersion", "platform", "artifacts", "policy"], "");
  if (lock.schemaVersion !== 1) fail("/schemaVersion", "must be 1");
  if (!SEMVER.test(lock.contractVersion) || lock.contractVersion !== contract.contractVersion) {
    fail("/contractVersion", "must match the Proxmox contract version");
  }
  assertClosedObject(lock.platform, ["operatingSystem", "distribution", "release", "architecture"], "/platform");
  if (!isDeepStrictEqual(lock.platform, contract.scope.guest)) {
    fail("/platform", "must match the contract guest platform");
  }
  assertClosedObject(lock.artifacts, Object.keys(EXPECTED_ARTIFACTS), "/artifacts");
  for (const [name, expected] of Object.entries(EXPECTED_ARTIFACTS)) {
    const artifact = lock.artifacts[name];
    assertClosedObject(artifact, Object.keys(expected), `/artifacts/${name}`);
    if (!isDeepStrictEqual(artifact, expected)) fail(`/artifacts/${name}`, "does not match the immutable artifact pin");
    if (!SHA256.test(artifact.sha256)) fail(`/artifacts/${name}/sha256`, "must be a lowercase SHA-256 digest");
    const source = new URL(artifact.url);
    if (source.protocol !== "https:") fail(`/artifacts/${name}/url`, "must use HTTPS");
  }
  assertClosedObject(
    lock.policy,
    ["allowFloatingVersions", "requireSha256", "ubuntuAptSnapshot", "buildNetwork", "validationNetwork"],
    "/policy",
  );
  if (!UBUNTU_APT_SNAPSHOT.test(lock.policy.ubuntuAptSnapshot)) {
    fail("/policy/ubuntuAptSnapshot", "must be an immutable UTC snapshot ID");
  }
  if (
    lock.policy.allowFloatingVersions !== false ||
    lock.policy.requireSha256 !== true ||
    lock.policy.buildNetwork !== contract.validation.buildNetwork ||
    lock.policy.validationNetwork !== contract.validation.validationNetwork
  ) {
    fail("/policy", "must require immutable checksums, allowlisted builds, and offline validation");
  }
  assertNoUserSpecificMaterial(lock);
  return lock;
}

export async function validateRecipeSources(root, lock) {
  const validationRoot = join(resolve(root), "validation", "proxmox");
  const [versions, proxmox, bootstrap, provisionGuest, buildWrapper] = await Promise.all([
    readFile(join(validationRoot, "packer", "versions.pkr.hcl"), "utf8"),
    readFile(join(validationRoot, "packer", "proxmox.pkr.hcl"), "utf8"),
    readFile(join(validationRoot, "scripts", "bootstrap-cloud-image-template.sh"), "utf8"),
    readFile(join(validationRoot, "scripts", "provision-guest.sh"), "utf8"),
    readFile(join(validationRoot, "scripts", "build-template.sh"), "utf8"),
  ]);
  const packer = lock.artifacts.packer;
  const plugin = lock.artifacts.packerProxmoxPlugin;
  const ubuntu = lock.artifacts.ubuntuCloudImage;
  if (!versions.includes(`required_version = "= ${packer.version}"`)) {
    fail("/recipe/packer", "Packer core version must match the toolchain lock exactly");
  }
  if (!versions.includes(`version = "= ${plugin.version}"`)) {
    fail("/recipe/packer", "Proxmox plugin version must match the toolchain lock exactly");
  }
  if (!versions.includes('source  = "github.com/hashicorp/proxmox"')) {
    fail("/recipe/packer", "Proxmox plugin source must be the expected official namespace");
  }
  if (!bootstrap.includes(`readonly UBUNTU_IMAGE_URL="${ubuntu.url}"`)) {
    fail("/recipe/bootstrap", "Ubuntu image URL must match the toolchain lock");
  }
  if (!bootstrap.includes(`readonly UBUNTU_IMAGE_SHA256="${ubuntu.sha256}"`)) {
    fail("/recipe/bootstrap", "Ubuntu image digest must match the toolchain lock");
  }
  if (!bootstrap.includes(`readonly UBUNTU_APT_SNAPSHOT="${lock.policy.ubuntuAptSnapshot}"`)) {
    fail("/recipe/bootstrap", "Ubuntu APT snapshot must match the toolchain lock");
  }
  if (!bootstrap.includes('APT::Snapshot \\"${UBUNTU_APT_SNAPSHOT}\\";')) {
    fail("/recipe/bootstrap", "base-template packages must come from the immutable Ubuntu snapshot");
  }
  if (!provisionGuest.includes(`readonly UBUNTU_APT_SNAPSHOT="${lock.policy.ubuntuAptSnapshot}"`)) {
    fail("/recipe/provision-guest", "Ubuntu APT snapshot must match the toolchain lock");
  }
  if (!/apt-get\s+\\\n\s+--error-on=any\s+\\\n\s+-o DPkg::Lock::Timeout=300\s+\\\n\s+-o Acquire::Retries=3\s+\\\n\s+-o APT::Snapshot="\$UBUNTU_APT_SNAPSHOT"\s+\\\n\s+update/u.test(provisionGuest)) {
    fail("/recipe/provision-guest", "guest package metadata updates must fail on any fetch error");
  }
  if (!provisionGuest.includes('-o APT::Snapshot="$UBUNTU_APT_SNAPSHOT"')) {
    fail("/recipe/provision-guest", "guest packages must come from the immutable Ubuntu snapshot");
  }
  for (const requiredSource of [
    'machine            = "q35"',
    'bios               = "ovmf"',
    'cpu_type           = "x86-64-v2-AES"',
    'bridge        = "vmbr0"',
    "firewall      = true",
    "insecure_skip_tls_verify  = false",
  ]) {
    if (!proxmox.includes(requiredSource)) fail("/recipe/packer", `missing fixed contract source: ${requiredSource}`);
  }
  for (const forbiddenSource of [
    "--destroy-unreferenced-disks",
    "--purge",
    "--skiplock",
  ]) {
    if (bootstrap.includes(forbiddenSource)) fail("/recipe/bootstrap", `forbidden cleanup option: ${forbiddenSource}`);
  }
  if (!buildWrapper.includes('"$PACKER_BIN" build -on-error=abort')) {
    fail("/recipe/build-wrapper", "Packer failures must stop for operator reconciliation");
  }
  if (!buildWrapper.includes('[[ $(uname -s) == "Linux" ]]')) {
    fail("/recipe/build-wrapper", "build wrapper must enforce the dedicated Linux controller boundary");
  }
  for (const sealedBuildControl of [
    "EXPECTED_PACKER_SOURCES",
    "SEALED_PACKER_DIR",
    "materialize_tracked",
    "download_verified",
    'export PACKER_CONFIG="${RUN_ROOT}/config/packer.json"',
    "git_readonly status --porcelain=v1 --untracked-files=all",
  ]) {
    if (!buildWrapper.includes(sealedBuildControl)) {
      fail("/recipe/build-wrapper", `missing sealed build control: ${sealedBuildControl}`);
    }
  }
  return true;
}

export function createEvidenceProbe(contract) {
  const checks = {
    marketplaceInstall: true,
    pluginInstall: true,
    freshProcessStart: true,
    mcpInitialize: true,
    toolsList: true,
    nelosConfigGet: true,
    laneParity: true,
  };
  return {
    schemaVersion: 1,
    contractVersion: contract.contractVersion,
    runId: "contract-probe",
    candidate: {
      sourceRevision: "0".repeat(40),
      treeSha256: "1".repeat(64),
      dirty: false,
    },
    template: {
      templateVersion: contract.contractVersion,
      proxmoxVeVersion: contract.scope.proxmoxVeBaseline,
      operatingSystem: "ubuntu-24.04-lts",
      architecture: contract.scope.guest.architecture,
      contractSha256: "2".repeat(64),
      toolchainLockSha256: "3".repeat(64),
    },
    lanes: {
      "legacy-01446": {
        codexVersion: "0.144.6",
        freshProcess: true,
        home: "/var/lib/nelos-validator/runs/contract-probe/legacy-01446/home",
        codexHome: "/var/lib/nelos-validator/runs/contract-probe/legacy-01446/home/.codex",
        pluginVersion: "0.0.0",
        pluginManifestPath: ".codex-plugin/plugin.json",
        mcpManifestPath: ".mcp.json",
        launchMode: "inline-home-cache-bootstrap",
        processObservation: {
          commandClass: "node-inline-bootstrap",
          cwdClass: "task-workspace",
          observedEnvironmentKeys: ["CODEX_HOME", "HOME"],
          fullCommandCaptured: false,
          fullEnvironmentCaptured: false,
        },
        toolNames: ["nelos_config_get"],
        checks: structuredClone(checks),
      },
      "agent-plugin-01470": {
        codexVersion: "0.147.0",
        freshProcess: true,
        home: "/var/lib/nelos-validator/runs/contract-probe/agent-plugin-01470/home",
        codexHome: "/var/lib/nelos-validator/runs/contract-probe/agent-plugin-01470/home/.codex",
        pluginVersion: "0.0.0",
        pluginManifestPath: "plugin.json",
        mcpManifestPath: "mcp.json",
        launchMode: "direct-plugin-root",
        processObservation: {
          commandClass: "node-plugin-root-entrypoint",
          cwdClass: "plugin-root",
          observedEnvironmentKeys: ["CODEX_HOME", "HOME", "PLUGIN_DATA", "PLUGIN_ROOT"],
          fullCommandCaptured: false,
          fullEnvironmentCaptured: false,
        },
        toolNames: ["nelos_config_get"],
        checks: structuredClone(checks),
      },
    },
    sanitization: {
      status: "passed",
      redactionsApplied: true,
      credentialsCaptured: false,
      fullEnvironmentCaptured: false,
      fullConfigurationCaptured: false,
      userSpecificIdentifiersCaptured: false,
      macStateCaptured: false,
    },
    result: { status: "passed", failures: [] },
  };
}

export function validateEvidenceDocument(evidence, evidenceSchema, contract) {
  assertOnlyLocalReferences(evidenceSchema);
  validateAgainstSchema(evidence, evidenceSchema);
  assertNoUserSpecificMaterial(evidence);
  if (evidence.contractVersion !== contract.contractVersion) {
    fail("/contractVersion", "must match the validator contract");
  }
  const legacy = evidence.lanes["legacy-01446"];
  const agent = evidence.lanes["agent-plugin-01470"];
  const expectedRunRoot = `/var/lib/nelos-validator/runs/${evidence.runId}`;
  if (legacy.home !== `${expectedRunRoot}/legacy-01446/home`) {
    fail("/lanes/legacy-01446/home", "must be isolated beneath this evidence run ID");
  }
  if (agent.home !== `${expectedRunRoot}/agent-plugin-01470/home`) {
    fail("/lanes/agent-plugin-01470/home", "must be isolated beneath this evidence run ID");
  }
  if (legacy.codexHome !== `${legacy.home}/.codex`) fail("/lanes/legacy-01446/codexHome", "must equal HOME/.codex");
  if (agent.codexHome !== `${agent.home}/.codex`) fail("/lanes/agent-plugin-01470/codexHome", "must equal HOME/.codex");
  if (legacy.pluginVersion !== agent.pluginVersion) fail("/lanes", "plugin versions must match across lanes");
  if (legacy.checks.laneParity !== agent.checks.laneParity) {
    fail("/lanes", "lane parity must report the same result in both lanes");
  }
  if (legacy.checks.laneParity) {
    assertExactSet(agent.toolNames, legacy.toolNames, "/lanes/agent-plugin-01470/toolNames");
  }
  if (evidence.result.status === "passed") {
    for (const [laneId, lane] of Object.entries({
      "legacy-01446": legacy,
      "agent-plugin-01470": agent,
    })) {
      if (!lane.toolNames.includes("nelos_config_get")) {
        fail(`/lanes/${laneId}/toolNames`, "must include nelos_config_get");
      }
    }
  }
  for (const [laneId, lane] of Object.entries({
    "legacy-01446": legacy,
    "agent-plugin-01470": agent,
  })) {
    if (lane.freshProcess !== lane.checks.freshProcessStart) {
      fail(`/lanes/${laneId}/freshProcess`, "must match the observed fresh-process start check");
    }
    if (!lane.freshProcess) {
      for (const downstreamCheck of ["mcpInitialize", "toolsList", "nelosConfigGet", "laneParity"]) {
        if (lane.checks[downstreamCheck]) {
          fail(`/lanes/${laneId}/checks/${downstreamCheck}`, "cannot pass before a fresh process starts");
        }
      }
      if (lane.toolNames.length !== 0) {
        fail(`/lanes/${laneId}/toolNames`, "must be empty when no fresh process started");
      }
      if (lane.processObservation.observedEnvironmentKeys.length !== 0) {
        fail(`/lanes/${laneId}/processObservation/observedEnvironmentKeys`, "must be empty when no process was observed");
      }
      continue;
    }
    if (!lane.checks.mcpInitialize && (lane.checks.toolsList || lane.checks.nelosConfigGet || lane.checks.laneParity)) {
      fail(`/lanes/${laneId}/checks`, "tool checks cannot pass before MCP initialization");
    }
    if (!lane.checks.mcpInitialize && lane.toolNames.length !== 0) {
      fail(`/lanes/${laneId}/toolNames`, "must be empty before MCP initialization succeeds");
    }
    if (!lane.checks.toolsList && (lane.checks.nelosConfigGet || lane.checks.laneParity)) {
      fail(`/lanes/${laneId}/checks`, "tool-result checks cannot pass before tools/list succeeds");
    }
    if (lane.checks.nelosConfigGet && !lane.toolNames.includes("nelos_config_get")) {
      fail(`/lanes/${laneId}/toolNames`, "must include nelos_config_get when its check passes");
    }
    for (const environmentKey of contract.lanes[laneId].requiredEnvironment) {
      if (!lane.processObservation.observedEnvironmentKeys.includes(environmentKey)) {
        fail(`/lanes/${laneId}/processObservation/observedEnvironmentKeys`, `must include ${environmentKey}`);
      }
    }
  }
  if (evidence.result.status === "passed" && evidence.result.failures.length !== 0) {
    fail("/result/failures", "passed evidence cannot contain failures");
  }
  if (evidence.result.status === "failed" && evidence.result.failures.length === 0) {
    fail("/result/failures", "failed evidence must describe at least one failure");
  }
  const checkValues = [legacy, agent].flatMap((lane) => Object.values(lane.checks));
  if (evidence.result.status === "passed" && checkValues.some((value) => value !== true)) {
    fail("/lanes", "passed evidence requires every lane check to pass");
  }
  if (evidence.result.status === "failed" && checkValues.every((value) => value === true)) {
    fail("/lanes", "failed evidence requires at least one failed lane check");
  }
  return evidence;
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    fail("", `cannot read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("", `${label} is not valid JSON`);
  }
}

export async function validateRepositoryContract(root = repositoryRoot, options = {}) {
  const validationRoot = join(resolve(root), "validation", "proxmox");
  const [contract, contractSchema, toolchainLock, evidenceSchema] = await Promise.all([
    readJson(join(validationRoot, "contract.json"), "contract.json"),
    readJson(join(validationRoot, "contract.schema.json"), "contract.schema.json"),
    readJson(join(validationRoot, "toolchain.lock.json"), "toolchain.lock.json"),
    readJson(join(validationRoot, "evidence", "schema.json"), "evidence/schema.json"),
  ]);
  validateProxmoxContract(contract, contractSchema);
  validateToolchainLock(toolchainLock, contract);
  await validateRecipeSources(root, toolchainLock);
  validateEvidenceDocument(createEvidenceProbe(contract), evidenceSchema, contract);
  if (options.evidencePath) {
    validateEvidenceDocument(await readJson(resolve(options.evidencePath), "evidence"), evidenceSchema, contract);
  }
  return {
    valid: true,
    offline: true,
    contractVersion: contract.contractVersion,
    lanes: Object.keys(contract.lanes),
  };
}

function parseArguments(argumentsList) {
  const options = { root: repositoryRoot };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument !== "--root" && argument !== "--evidence") fail("", `unknown argument: ${argument}`);
    const value = argumentsList[index + 1];
    if (!value) fail("", `${argument} requires a value`);
    if (argument === "--root") options.root = resolve(value);
    else options.evidencePath = resolve(value);
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await validateRepositoryContract(options.root, options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`validate-contract: ${error.message}\n`);
    process.exitCode = 1;
  });
}
