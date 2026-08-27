#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { networkInterfaces } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { computeDistributionIntegrity } from "../../../src/distribution-provenance.mjs";

const execFile = promisify(execFileCallback);

export const RUNS_ROOT = "/var/lib/nelos-validator/runs";
// This is an internal, lifecycle-free guest receipt marker. The controller
// verifies it, adds the reconciled Proxmox lifecycle, and emits schema v2.
export const GUEST_RECEIPT_SCHEMA_VERSION = 1;
export const APP_SERVER_CLIENT_NAME = "nelos_proxmox_plugin_evidence";
export const LANE_IDS = Object.freeze([
  "legacy-01446",
  "agent-plugin-01470",
]);

const RUN_ID_PATTERN = /^run-[a-f0-9]{32}$/u;
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_APP_SERVER_MESSAGE_BYTES = 4 * 1024 * 1024;
const APP_SERVER_TIMEOUT_MS = 20_000;
const SAFE_ENVIRONMENT_KEY_ORDER = Object.freeze([
  "CODEX_HOME",
  "HOME",
  "NELOS_PLUGIN_VERSION",
  "NELOS_RELEASE_BUILD_IDENTITY",
  "PLUGIN_DATA",
  "PLUGIN_ROOT",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);
const OBSERVED_ENVIRONMENT_PATH_KEYS = Object.freeze([
  "HOME",
  "CODEX_HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "PLUGIN_DATA",
  "PLUGIN_ROOT",
]);

export const LANE_SPECS = Object.freeze({
  "legacy-01446": Object.freeze({
    artifactKey: "codexLegacy",
    version: "0.144.6",
    pluginManifestPath: ".codex-plugin/plugin.json",
    mcpManifestPath: ".mcp.json",
    launchMode: "inline-home-cache-bootstrap",
    commandClass: "node-inline-bootstrap",
    cwdClass: "task-workspace",
    failurePrefix: "legacy",
  }),
  "agent-plugin-01470": Object.freeze({
    artifactKey: "codexAgentPlugin",
    version: "0.147.0",
    pluginManifestPath: "plugin.json",
    mcpManifestPath: "mcp.json",
    launchMode: "direct-plugin-root",
    commandClass: "node-plugin-root-entrypoint",
    cwdClass: "plugin-root",
    failurePrefix: "agent-plugin",
  }),
});

export class PluginEvidenceRunnerError extends Error {
  constructor(code) {
    super(code);
    this.name = "PluginEvidenceRunnerError";
    this.code = code;
  }
}

function fail(code) {
  throw new PluginEvidenceRunnerError(code);
}

function stageFailure(code, callback) {
  return Promise.resolve()
    .then(callback)
    .catch(() => fail(code));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, code) {
  if (!isPlainObject(value)) fail(code);
  return value;
}

function assertPattern(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function assertAbsolutePath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    fail(code);
  }
  return resolve(value);
}

function isWithin(root, path) {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function safeJsonParse(text, code) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    fail(code);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function lanePaths(runId, laneId) {
  assertPattern(runId, RUN_ID_PATTERN, "arguments.run-id.invalid");
  if (!LANE_IDS.includes(laneId)) fail("arguments.lane-id.invalid");
  const runRoot = join(RUNS_ROOT, runId);
  const laneRoot = join(runRoot, laneId);
  const home = join(laneRoot, "home");
  return Object.freeze({
    runRoot,
    laneRoot,
    home,
    codexHome: join(home, ".codex"),
    tmp: join(laneRoot, "tmp"),
    xdgConfig: join(laneRoot, "xdg", "config"),
    xdgCache: join(laneRoot, "xdg", "cache"),
    xdgData: join(laneRoot, "xdg", "data"),
    xdgState: join(laneRoot, "xdg", "state"),
  });
}

export function buildIsolatedEnvironment(paths) {
  return Object.freeze({
    HOME: paths.home,
    CODEX_HOME: paths.codexHome,
    TMPDIR: paths.tmp,
    TMP: paths.tmp,
    TEMP: paths.tmp,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_DATA_HOME: paths.xdgData,
    XDG_STATE_HOME: paths.xdgState,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
  });
}

function expectedObservedEnvironmentPaths({ laneId, paths, pluginVersion }) {
  const projected = {
    HOME: paths.home,
    CODEX_HOME: paths.codexHome,
    TMPDIR: paths.tmp,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_DATA_HOME: paths.xdgData,
    PLUGIN_DATA: null,
    PLUGIN_ROOT: null,
  };
  if (laneId === "agent-plugin-01470") {
    const pluginDataIdentity = createHash("sha256")
      .update("nelos-marketplace", "utf8")
      .update(Buffer.from([0]))
      .update("nelos", "utf8")
      .digest("hex");
    projected.PLUGIN_DATA = `${paths.codexHome}/plugins/data/agent-plugins/${pluginDataIdentity}`;
    projected.PLUGIN_ROOT = `${paths.codexHome}/plugins/cache/nelos-marketplace/nelos/${pluginVersion}`;
  }
  return Object.freeze(projected);
}

export function assertNoNonLoopbackNetworkInterfaces(interfaceNames, addresses = {}) {
  if (!Array.isArray(interfaceNames) || interfaceNames.some((name) => typeof name !== "string")) {
    fail("validation.network-observation-failed");
  }
  const nonLoopbackNames = interfaceNames.filter((name) => name !== "lo");
  const externallyAddressed = Object.entries(addresses).some(([name, entries]) =>
    name !== "lo" && Array.isArray(entries) && entries.some((entry) => entry?.internal !== true)
  );
  if (nonLoopbackNames.length !== 0 || externallyAddressed) {
    fail("validation.network-not-denied");
  }
  return true;
}

function blankChecks() {
  return {
    marketplaceInstall: false,
    pluginInstall: false,
    freshProcessStart: false,
    mcpInitialize: false,
    toolsList: false,
    nelosConfigGet: false,
    laneParity: false,
  };
}

function emptyLaneEvidence({ runId, laneId, pluginVersion }) {
  const spec = LANE_SPECS[laneId];
  const paths = lanePaths(runId, laneId);
  return {
    codexVersion: spec.version,
    freshProcess: false,
    home: paths.home,
    codexHome: paths.codexHome,
    tmpDir: paths.tmp,
    xdgConfigHome: paths.xdgConfig,
    xdgCacheHome: paths.xdgCache,
    xdgDataHome: paths.xdgData,
    pluginVersion,
    installedDistributionIntegrity: null,
    pluginManifestPath: spec.pluginManifestPath,
    mcpManifestPath: spec.mcpManifestPath,
    launchMode: spec.launchMode,
    processObservation: {
      commandClass: spec.commandClass,
      cwdClass: spec.cwdClass,
      observedEnvironmentKeys: [],
      observedEnvironmentPaths: Object.fromEntries(
        OBSERVED_ENVIRONMENT_PATH_KEYS.map((key) => [key, null]),
      ),
      fullCommandCaptured: false,
      fullEnvironmentCaptured: false,
    },
    toolNames: [],
    checks: blankChecks(),
  };
}

function normalizedEnvironmentKeys(keys, allowedKeys) {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
    fail("process.observation-invalid");
  }
  const observed = new Set(keys);
  const allowed = new Set(allowedKeys);
  return SAFE_ENVIRONMENT_KEY_ORDER.filter((key) => allowed.has(key) && observed.has(key));
}

export function sanitizeProcessObservation({ raw, spec, allowedKeys, expectedPaths }) {
  assertPlainObject(raw, "process.observation-invalid");
  if (raw.commandClass !== spec.commandClass || raw.cwdClass !== spec.cwdClass) {
    fail("process.classification-mismatch");
  }
  assertPlainObject(raw.observedEnvironmentPaths, "process.observation-invalid");
  const actualPathKeys = Object.keys(raw.observedEnvironmentPaths).sort();
  const expectedPathKeys = [...OBSERVED_ENVIRONMENT_PATH_KEYS].sort();
  if (
    actualPathKeys.length !== expectedPathKeys.length
    || actualPathKeys.some((key, index) => key !== expectedPathKeys[index])
    || !Array.isArray(raw.forbiddenEnvironmentKeys)
    || raw.forbiddenEnvironmentKeys.some((key) => typeof key !== "string")
  ) {
    fail("process.observation-invalid");
  }
  const projectedPaths = {};
  for (const key of OBSERVED_ENVIRONMENT_PATH_KEYS) {
    const expected = expectedPaths[key];
    const observed = raw.observedEnvironmentPaths[key];
    if (observed !== null && observed !== expected) fail("process.observation-invalid");
    projectedPaths[key] = observed;
  }
  return {
    commandClass: spec.commandClass,
    cwdClass: spec.cwdClass,
    observedEnvironmentKeys: normalizedEnvironmentKeys(raw.observedEnvironmentKeys, allowedKeys),
    observedEnvironmentPaths: projectedPaths,
    fullCommandCaptured: false,
    fullEnvironmentCaptured: false,
  };
}

function parseCodexVersion(result) {
  if (typeof result?.userAgent !== "string") return null;
  const match = result.userAgent.match(
    /^([a-z][a-z0-9_]*)\/([0-9]+\.[0-9]+\.[0-9]+)(?:\s|\(|$)/u,
  );
  if (!match || ![APP_SERVER_CLIENT_NAME, "codex_cli_rs"].includes(match[1])) return null;
  return match[2];
}

function parseToolNames(statusResult, serverName) {
  if (!isPlainObject(statusResult) || !Array.isArray(statusResult.data)) {
    fail("mcp.status-invalid");
  }
  const servers = statusResult.data.filter((server) => server?.name === serverName);
  if (servers.length !== 1 || !isPlainObject(servers[0].tools)) {
    fail("mcp.server-missing-or-ambiguous");
  }
  const names = Object.keys(servers[0].tools).sort();
  if (names.length === 0 || names.some((name) => !TOOL_NAME_PATTERN.test(name))) {
    fail("mcp.tools-invalid");
  }
  return names;
}

async function listMcpTools(transport, serverName, threadId) {
  let cursor = null;
  const data = [];
  for (let page = 0; page < 10; page += 1) {
    const result = await transport.request("mcpServerStatus/list", {
      cursor,
      detail: "toolsAndAuthOnly",
      limit: 100,
      threadId,
    });
    if (!isPlainObject(result) || !Array.isArray(result.data)) fail("mcp.status-invalid");
    data.push(...result.data);
    cursor = result.nextCursor ?? null;
    if (cursor === null) return parseToolNames({ data }, serverName);
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4096) {
      fail("mcp.status-invalid");
    }
  }
  fail("mcp.status-pagination-exceeded");
}

function validateConfigGetResult(result, paths) {
  if (!isPlainObject(result) || result.isError === true || !Array.isArray(result.content)) {
    fail("mcp.config-get-invalid");
  }
  const text = result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text;
  const body = safeJsonParse(text, "mcp.config-get-invalid");
  if (
    body?.schemaVersion !== 1 ||
    body?.configPath !== join(paths.xdgConfig, "nelos", "config.toml") ||
    body?.configFileExists !== false ||
    body?.setting?.key !== "spinoffs.cleanup_policy" ||
    body?.setting?.value !== "auto" ||
    body?.setting?.source !== "default" ||
    body?.migration !== null
  ) {
    fail("mcp.config-get-invalid");
  }
  return true;
}

async function runLane({
  adapters,
  allowedEnvironmentKeys,
  candidateIdentity,
  candidateRoot,
  contract,
  laneId,
  runId,
  toolchainLock,
}) {
  const spec = LANE_SPECS[laneId];
  const paths = lanePaths(runId, laneId);
  const evidence = emptyLaneEvidence({ runId, laneId, pluginVersion: candidateIdentity.pluginVersion });
  const failures = [];
  const env = buildIsolatedEnvironment(paths);
  const binary = `/usr/local/bin/codex-${laneId}`;
  let transport;
  let networkDeniedObserved = false;

  try {
    await stageFailure(`${spec.failurePrefix}.state.prepare-failed`, () => adapters.prepareLane(paths));
    await stageFailure(`${spec.failurePrefix}.network.not-denied`, () => adapters.assertNetworkDenied());
    networkDeniedObserved = true;
    await stageFailure(`${spec.failurePrefix}.codex.version-mismatch`, () => adapters.verifyCodexVersion({
      binary,
      env,
      expectedVersion: spec.version,
      laneId,
      toolchainLock,
    }));
    await stageFailure(`${spec.failurePrefix}.marketplace.install-failed`, () => adapters.addLocalMarketplace({
      binary,
      candidateRoot,
      env,
      expectedName: contract.validation.marketplaceSelector.split("@")[1],
    }));
    evidence.checks.marketplaceInstall = true;

    const installation = await stageFailure(`${spec.failurePrefix}.plugin.install-failed`, () => adapters.installLocalPlugin({
      binary,
      env,
      selector: contract.validation.marketplaceSelector,
    }));
    const installed = await stageFailure(`${spec.failurePrefix}.plugin.layout-invalid`, () => adapters.verifyInstalledLayout({
      candidateIdentity,
      codexHome: paths.codexHome,
      installation,
      laneId,
      spec,
    }));
    evidence.checks.pluginInstall = true;
    evidence.installedDistributionIntegrity = installed.distributionIntegrity;

    transport = await stageFailure(`${spec.failurePrefix}.process.start-failed`, () => adapters.openAppServer({
      binary,
      cwd: laneId === "legacy-01446" ? candidateRoot : installed.pluginRoot,
      env,
      laneId,
    }));
    const initialized = await stageFailure(`${spec.failurePrefix}.process.initialize-failed`, () => transport.request("initialize", {
      clientInfo: {
        name: APP_SERVER_CLIENT_NAME,
        title: "Nelos Proxmox Plugin Evidence",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    }));
    if (parseCodexVersion(initialized) !== spec.version || initialized?.codexHome !== paths.codexHome) {
      fail(`${spec.failurePrefix}.process.identity-mismatch`);
    }
    transport.notify("initialized", {});

    const thread = await stageFailure(`${spec.failurePrefix}.mcp.context-failed`, () =>
      transport.request("thread/start", {
        approvalPolicy: "never",
        cwd: laneId === "legacy-01446" ? candidateRoot : installed.pluginRoot,
        ephemeral: true,
        experimentalRawEvents: false,
        sandbox: "read-only",
      })
    );
    const threadId = thread?.thread?.id;
    if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 512) {
      fail(`${spec.failurePrefix}.mcp.context-failed`);
    }
    const toolNames = await stageFailure(`${spec.failurePrefix}.tools-list.failed`, () =>
      listMcpTools(transport, contract.validation.mcpServerId, threadId)
    );
    if (!toolNames.includes("nelos_config_get")) {
      fail(`${spec.failurePrefix}.tools-list.missing-required-tool`);
    }
    const rawObservation = await stageFailure(`${spec.failurePrefix}.process.observation-failed`, () =>
      transport.observeNelosProcess({
        candidateRoot,
        expectedEnvironmentPaths: expectedObservedEnvironmentPaths({
          laneId,
          paths,
          pluginVersion: candidateIdentity.pluginVersion,
        }),
        installedPluginRoot: installed.pluginRoot,
        laneId,
        spec,
      })
    );
    const expectedPaths = expectedObservedEnvironmentPaths({
      laneId,
      paths,
      pluginVersion: candidateIdentity.pluginVersion,
    });
    const processObservation = sanitizeProcessObservation({
      raw: rawObservation,
      spec,
      allowedKeys: allowedEnvironmentKeys,
      expectedPaths,
    });

    evidence.freshProcess = true;
    evidence.checks.freshProcessStart = true;
    evidence.processObservation = processObservation;
    if (Array.isArray(rawObservation.forbiddenEnvironmentKeys) && rawObservation.forbiddenEnvironmentKeys.length !== 0) {
      fail("process.forbidden-environment-observed");
    }
    const observedKeys = new Set(processObservation.observedEnvironmentKeys);
    if (
      laneId === "legacy-01446"
      && (observedKeys.has("PLUGIN_ROOT") || observedKeys.has("PLUGIN_DATA"))
    ) {
      fail("process.unexpected-plugin-environment");
    }
    const requiredEnvironmentVerified = contract.lanes[laneId].requiredEnvironment.every((key) =>
      observedKeys.has(key) && processObservation.observedEnvironmentPaths[key] === expectedPaths[key]
    );
    if (!requiredEnvironmentVerified) fail("process.required-environment-missing");

    // Keep MCP/tool claims conservative until the classified process also
    // proves every required environment path.
    evidence.toolNames = toolNames;
    evidence.checks.mcpInitialize = true;
    evidence.checks.toolsList = true;

    const configResult = await stageFailure(`${spec.failurePrefix}.config-get.call-failed`, () =>
      transport.request("mcpServer/tool/call", {
        server: contract.validation.mcpServerId,
        threadId,
        tool: "nelos_config_get",
        arguments: {},
      })
    );
    validateConfigGetResult(configResult, paths);
    evidence.checks.nelosConfigGet = true;
  } catch (error) {
    const code = error instanceof PluginEvidenceRunnerError
      ? error.code
      : `${spec.failurePrefix}.runner.failed`;
    failures.push(code);
  } finally {
    await transport?.close?.().catch(() => {});
  }

  return { evidence, failures, networkDeniedObserved };
}

function assertContractAndLock(contract, toolchainLock) {
  assertPlainObject(contract, "contract.invalid");
  assertPlainObject(toolchainLock, "toolchain-lock.invalid");
  if (
    contract.contractVersion !== "1.0.0" ||
    contract.validation?.offline !== true ||
    contract.validation?.validationNetwork !== "denied" ||
    contract.validation?.mcpServerId !== "nelos" ||
    contract.validation?.marketplaceSelector !== "nelos@nelos-marketplace" ||
    contract.scope?.guest?.operatingSystem !== "linux" ||
    contract.scope?.guest?.distribution !== "ubuntu" ||
    contract.scope?.guest?.release !== "24.04 LTS" ||
    contract.scope?.guest?.architecture !== "x86_64" ||
    !SEMVER_PATTERN.test(toolchainLock.artifacts?.node?.version ?? "")
  ) {
    fail("contract.invalid");
  }
  for (const laneId of LANE_IDS) {
    const spec = LANE_SPECS[laneId];
    if (
      contract.lanes?.[laneId]?.codexVersion !== spec.version ||
      contract.lanes?.[laneId]?.pluginManifestPath !== spec.pluginManifestPath ||
      contract.lanes?.[laneId]?.mcpManifestPath !== spec.mcpManifestPath ||
      !Array.isArray(contract.lanes?.[laneId]?.requiredEnvironment) ||
      toolchainLock.artifacts?.[spec.artifactKey]?.version !== spec.version ||
      toolchainLock.artifacts?.[spec.artifactKey]?.laneId !== laneId
    ) {
      fail("contract.lane-mismatch");
    }
  }
  const allowedKeys = contract.validation?.sanitization?.allowedEnvironmentKeys;
  if (!Array.isArray(allowedKeys) || allowedKeys.some((key) => !SAFE_ENVIRONMENT_KEY_ORDER.includes(key))) {
    fail("contract.sanitization-invalid");
  }
  return allowedKeys;
}

function normalizedOptions(options) {
  const runId = assertPattern(options.runId, RUN_ID_PATTERN, "arguments.run-id.invalid");
  const runRoot = lanePaths(runId, LANE_IDS[0]).runRoot;
  const candidateRoot = assertAbsolutePath(options.candidateRoot, "arguments.candidate-root.invalid");
  if (candidateRoot !== join(runRoot, "candidate")) fail("arguments.candidate-root.outside-run");
  return {
    ...options,
    runId,
    runRoot,
    candidateRoot,
    sourceRevision: assertPattern(options.sourceRevision, REVISION_PATTERN, "arguments.source-revision.invalid"),
    treeSha256: assertPattern(options.treeSha256, SHA256_PATTERN, "arguments.tree-sha256.invalid"),
    contractSha256: assertPattern(options.contractSha256, SHA256_PATTERN, "arguments.contract-sha256.invalid"),
    toolchainLockSha256: assertPattern(
      options.toolchainLockSha256,
      SHA256_PATTERN,
      "arguments.toolchain-lock-sha256.invalid",
    ),
    templateVersion: assertPattern(options.templateVersion, SEMVER_PATTERN, "arguments.template-version.invalid"),
  };
}

export async function collectPluginEvidence(options, suppliedAdapters = {}) {
  const normalized = normalizedOptions(options);
  const adapters = { ...createDefaultAdapters(), ...suppliedAdapters };
  const [contract, toolchainLock] = await Promise.all([
    options.contract ?? stageFailure("contract.read-failed", () => adapters.readJson(options.contractPath)),
    options.toolchainLock ?? stageFailure("toolchain-lock.read-failed", () => adapters.readJson(options.toolchainLockPath)),
  ]);
  const allowedEnvironmentKeys = assertContractAndLock(contract, toolchainLock);
  if (normalized.templateVersion !== contract.contractVersion) fail("arguments.template-version.mismatch");
  const candidateIdentity = await stageFailure("candidate.layout-invalid", () => adapters.inspectCandidate({
    candidateRoot: normalized.candidateRoot,
  }));
  if (!SEMVER_PATTERN.test(candidateIdentity?.pluginVersion ?? "")) fail("candidate.version-invalid");
  if (!/^sha256:[a-f0-9]{64}$/u.test(candidateIdentity?.distributionIntegrity ?? "")) {
    fail("candidate.distribution-integrity-invalid");
  }
  await stageFailure("template.input-digest-mismatch", () => adapters.verifyInputDigests({
    contractPath: options.contractPath,
    contractSha256: normalized.contractSha256,
    toolchainLockPath: options.toolchainLockPath,
    toolchainLockSha256: normalized.toolchainLockSha256,
  }));

  const lanes = Object.fromEntries(LANE_IDS.map((laneId) => [
    laneId,
    emptyLaneEvidence({
      runId: normalized.runId,
      laneId,
      pluginVersion: candidateIdentity.pluginVersion,
    }),
  ]));
  const failures = [];
  let guestIdentityVerified = false;
  let initialNetworkDenied = false;
  let finalNetworkDenied = false;
  let laneNetworkObservations = 0;

  try {
    await stageFailure("template.guest-identity-mismatch", () => adapters.verifyGuestIdentity({
      contract,
      toolchainLock,
    }));
    guestIdentityVerified = true;
    await stageFailure("validation.network-not-denied", () => adapters.assertNetworkDenied());
    initialNetworkDenied = true;
    for (const laneId of LANE_IDS) {
      const lane = await runLane({
        adapters,
        allowedEnvironmentKeys,
        candidateIdentity,
        candidateRoot: normalized.candidateRoot,
        contract,
        laneId,
        runId: normalized.runId,
        toolchainLock,
      });
      lanes[laneId] = lane.evidence;
      failures.push(...lane.failures);
      if (lane.networkDeniedObserved) laneNetworkObservations += 1;
    }
    await stageFailure("validation.network-not-denied", () => adapters.assertNetworkDenied());
    finalNetworkDenied = true;
    await stageFailure("candidate.changed-during-validation", () => adapters.assertCandidateUnchanged({
      candidateRoot: normalized.candidateRoot,
      fingerprint: candidateIdentity.fingerprint,
    }));
  } catch (error) {
    failures.push(error instanceof PluginEvidenceRunnerError ? error.code : "validation.runner-failed");
  }

  const legacyTools = lanes["legacy-01446"].toolNames;
  const agentTools = lanes["agent-plugin-01470"].toolNames;
  const parity =
    lanes["legacy-01446"].checks.toolsList &&
    lanes["agent-plugin-01470"].checks.toolsList &&
    legacyTools.length === agentTools.length &&
    legacyTools.every((name, index) => name === agentTools[index]);
  lanes["legacy-01446"].checks.laneParity = parity;
  lanes["agent-plugin-01470"].checks.laneParity = parity;
  if (!parity) failures.push("lane.parity-mismatch");

  const uniqueFailures = [...new Set(failures)].sort();
  const passed = uniqueFailures.length === 0 && Object.values(lanes).every((lane) =>
    Object.values(lane.checks).every((value) => value === true)
  );
  const networkDeniedDuringValidation = initialNetworkDenied &&
    finalNetworkDenied &&
    laneNetworkObservations === LANE_IDS.length;

  return {
    schemaVersion: GUEST_RECEIPT_SCHEMA_VERSION,
    contractVersion: contract.contractVersion,
    runId: normalized.runId,
    candidate: {
      sourceRevision: normalized.sourceRevision,
      treeSha256: normalized.treeSha256,
      distributionIntegrity: candidateIdentity.distributionIntegrity,
      dirty: false,
    },
    template: {
      templateVersion: normalized.templateVersion,
      proxmoxVeVersion: contract.scope.proxmoxVeBaseline,
      operatingSystem: "ubuntu-24.04-lts",
      architecture: contract.scope.guest.architecture,
      contractSha256: normalized.contractSha256,
      toolchainLockSha256: normalized.toolchainLockSha256,
    },
    observations: {
      guestIdentityVerified,
      networkDeniedDuringValidation,
    },
    lanes,
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
      failures: passed ? [] : uniqueFailures,
    },
  };
}

async function readBoundedJson(path, code) {
  return safeJsonParse((await readBoundedRegularFile(path, code)).toString("utf8"), code);
}

async function readBoundedRegularFile(path, code) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) fail(code);
  return readFile(path);
}

async function readRootedJson(root, relativePath, code) {
  const canonicalRoot = await realpath(root);
  const path = join(canonicalRoot, relativePath);
  const pathInfo = await lstat(path);
  if (pathInfo.isSymbolicLink()) fail(code);
  const canonicalPath = await realpath(path);
  if (!isWithin(canonicalRoot, canonicalPath)) fail(code);
  return readBoundedJson(canonicalPath, code);
}

async function candidateFingerprint(root) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        fail("candidate.unsupported-entry");
      }
      hash.update(info.isDirectory() ? "directory\0" : "file\0");
      hash.update(relativePath);
      hash.update("\0");
      hash.update(String(info.mode & 0o777));
      hash.update("\0");
      if (info.isDirectory()) await visit(path, relativePath);
      else hash.update(await readFile(path));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function inspectCandidate({ candidateRoot }) {
  const canonicalRoot = await realpath(candidateRoot);
  if (canonicalRoot !== candidateRoot) fail("candidate.root-not-canonical");
  const [
    legacyManifest,
    legacyMcp,
    agentManifest,
    agentMcp,
    packageDocument,
    provenance,
    distributionIntegrity,
    fingerprint,
  ] = await Promise.all([
    readRootedJson(canonicalRoot, ".codex-plugin/plugin.json", "candidate.legacy-manifest-invalid"),
    readRootedJson(canonicalRoot, ".mcp.json", "candidate.legacy-mcp-invalid"),
    readRootedJson(canonicalRoot, "plugin.json", "candidate.agent-manifest-invalid"),
    readRootedJson(canonicalRoot, "mcp.json", "candidate.agent-mcp-invalid"),
    readRootedJson(canonicalRoot, "package.json", "candidate.package-invalid"),
    readRootedJson(canonicalRoot, "distribution-provenance.json", "candidate.provenance-invalid"),
    computeDistributionIntegrity(canonicalRoot),
    candidateFingerprint(canonicalRoot),
  ]);
  const pluginVersion = legacyManifest?.version;
  const releaseBuildIdentity = legacyManifest?.releaseBuildIdentity;
  const legacyServer = legacyMcp?.mcpServers?.nelos;
  const agentServer = agentMcp?.mcpServers?.nelos;
  if (
    legacyManifest?.name !== "nelos" ||
    !SEMVER_PATTERN.test(pluginVersion ?? "") ||
    packageDocument?.name !== "nelos" ||
    packageDocument?.version !== pluginVersion ||
    provenance?.revision !== pluginVersion ||
    provenance?.integrity !== distributionIntegrity ||
    typeof releaseBuildIdentity !== "string" ||
    releaseBuildIdentity.length > 160 ||
    agentManifest?.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" ||
    agentManifest?.name !== "nelos" ||
    agentManifest?.version !== pluginVersion ||
    legacyServer?.command !== "node" ||
    !Array.isArray(legacyServer?.args) ||
    legacyServer.env?.NELOS_PLUGIN_VERSION !== pluginVersion ||
    legacyServer.env?.NELOS_RELEASE_BUILD_IDENTITY !== releaseBuildIdentity ||
    agentMcp?.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" ||
    agentServer?.type !== "stdio" ||
    agentServer?.command !== "node" ||
    agentServer?.args?.length !== 1 ||
    agentServer.args[0] !== "${PLUGIN_ROOT}/bin/nelos-mcp" ||
    agentServer.env?.NELOS_PLUGIN_VERSION !== pluginVersion ||
    agentServer.env?.NELOS_RELEASE_BUILD_IDENTITY !== releaseBuildIdentity ||
    Object.hasOwn(agentServer.env ?? {}, "PLUGIN_ROOT") ||
    Object.hasOwn(agentServer.env ?? {}, "PLUGIN_DATA")
  ) {
    fail("candidate.layout-invalid");
  }
  const entrypoint = join(canonicalRoot, "bin", "nelos-mcp");
  const entrypointInfo = await lstat(entrypoint);
  if (!entrypointInfo.isFile() || entrypointInfo.isSymbolicLink()) {
    fail("candidate.agent-entrypoint-invalid");
  }
  await access(entrypoint, fsConstants.X_OK);
  return { pluginVersion, releaseBuildIdentity, distributionIntegrity, fingerprint };
}

async function assertCandidateUnchanged({ candidateRoot, fingerprint }) {
  if (!SHA256_PATTERN.test(fingerprint ?? "") || await candidateFingerprint(candidateRoot) !== fingerprint) {
    fail("candidate.changed-during-validation");
  }
}

async function verifyInputDigests({
  contractPath,
  contractSha256,
  toolchainLockPath,
  toolchainLockSha256,
}) {
  const [contractBytes, candidateLockBytes, installedLockBytes] = await Promise.all([
    readBoundedRegularFile(
      assertAbsolutePath(contractPath, "arguments.contract.invalid"),
      "template.contract-file-invalid",
    ),
    readBoundedRegularFile(
      assertAbsolutePath(toolchainLockPath, "arguments.toolchain-lock.invalid"),
      "template.toolchain-lock-file-invalid",
    ),
    readBoundedRegularFile(
      "/opt/nelos-validator/toolchain.lock.json",
      "template.installed-lock-file-invalid",
    ),
  ]);
  if (
    sha256(contractBytes) !== contractSha256 ||
    sha256(candidateLockBytes) !== toolchainLockSha256 ||
    sha256(installedLockBytes) !== toolchainLockSha256
  ) {
    fail("template.input-digest-mismatch");
  }
}

export function validateGuestIdentityObservation(observation, { contract, toolchainLock }) {
  const nodeVersion = toolchainLock?.artifacts?.node?.version;
  if (
    observation?.platform !== "linux" ||
    observation?.arch !== "x64" ||
    !SEMVER_PATTERN.test(nodeVersion ?? "") ||
    observation?.nodeVersion !== `v${nodeVersion}` ||
    observation?.nodeExecutable !== `/opt/nelos-validator/node/${nodeVersion}/bin/node` ||
    observation?.osId !== "ubuntu" ||
    observation?.osVersion !== "24.04" ||
    observation?.uname !== "x86_64" ||
    contract?.scope?.guest?.operatingSystem !== "linux" ||
    contract?.scope?.guest?.distribution !== "ubuntu" ||
    contract?.scope?.guest?.release !== "24.04 LTS" ||
    contract?.scope?.guest?.architecture !== "x86_64"
  ) {
    fail("template.guest-identity-mismatch");
  }
  return true;
}

async function verifyGuestIdentity({ contract, toolchainLock }) {
  const osReleasePath = await realpath("/etc/os-release");
  if (!["/etc/os-release", "/usr/lib/os-release"].includes(osReleasePath)) {
    fail("template.guest-identity-mismatch");
  }
  const osRelease = (await readBoundedRegularFile(
    osReleasePath,
    "template.guest-identity-mismatch",
  )).toString("utf8");
  const fields = new Map(osRelease.split("\n").map((line) => {
    const separator = line.indexOf("=");
    return separator === -1
      ? [line, ""]
      : [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/gu, "")];
  }));
  if (fields.get("ID") !== "ubuntu" || fields.get("VERSION_ID") !== "24.04") {
    fail("template.guest-identity-mismatch");
  }
  const { stdout } = await execFile("/usr/bin/uname", ["-m"], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 5_000,
    windowsHide: true,
  });
  return validateGuestIdentityObservation({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    nodeExecutable: await realpath(process.execPath),
    osId: fields.get("ID"),
    osVersion: fields.get("VERSION_ID"),
    uname: stdout.trim(),
  }, { contract, toolchainLock });
}

async function prepareLane(paths) {
  const canonicalRunRoot = await realpath(paths.runRoot);
  if (canonicalRunRoot !== paths.runRoot) fail("state.run-root-not-canonical");
  await mkdir(paths.laneRoot, { mode: 0o700 });
  await Promise.all([
    mkdir(paths.codexHome, { recursive: true, mode: 0o700 }),
    mkdir(paths.tmp, { recursive: true, mode: 0o700 }),
    mkdir(paths.xdgConfig, { recursive: true, mode: 0o700 }),
    mkdir(paths.xdgCache, { recursive: true, mode: 0o700 }),
    mkdir(paths.xdgData, { recursive: true, mode: 0o700 }),
    mkdir(paths.xdgState, { recursive: true, mode: 0o700 }),
  ]);
}

async function runJsonCommand(command, args, { cwd, env }) {
  const result = await execFile(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: MAX_JSON_BYTES,
    timeout: APP_SERVER_TIMEOUT_MS,
    windowsHide: true,
  });
  return safeJsonParse(result.stdout, "subprocess.json-invalid");
}

async function verifyCodexVersion({ binary, env, expectedVersion, laneId, toolchainLock }) {
  const canonicalBinary = await realpath(binary);
  const expectedRoot = `/opt/nelos-validator/lanes/${laneId}`;
  if (!isWithin(expectedRoot, canonicalBinary)) fail("codex.binary-outside-lane");
  const { stdout } = await execFile(binary, ["--version"], {
    env,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 5_000,
    windowsHide: true,
  });
  if (!stdout.trim().endsWith(expectedVersion)) fail("codex.version-mismatch");
  const artifact = Object.values(toolchainLock.artifacts).find((value) => value?.laneId === laneId);
  if (artifact?.version !== expectedVersion) fail("codex.lock-mismatch");
}

async function addLocalMarketplace({ binary, candidateRoot, env, expectedName }) {
  const result = await runJsonCommand(
    binary,
    ["plugin", "marketplace", "add", candidateRoot, "--json"],
    { cwd: candidateRoot, env },
  );
  parseLocalMarketplaceAddResult(result, expectedName);
}

export function parseLocalMarketplaceAddResult(result, expectedName) {
  if (
    !isPlainObject(result) ||
    typeof expectedName !== "string" ||
    (result.name ?? result.marketplaceName) !== expectedName
  ) {
    fail("marketplace.identity-mismatch");
  }
  return true;
}

export function parseLocalPluginInstallResult(result) {
  if (!isPlainObject(result) || typeof result.installedPath !== "string") {
    fail("plugin.install-result-invalid");
  }
  return { installedPath: result.installedPath };
}

async function installLocalPlugin({ binary, env, selector }) {
  const result = await runJsonCommand(binary, ["plugin", "add", selector, "--json"], {
    cwd: env.HOME,
    env,
  });
  return parseLocalPluginInstallResult(result);
}

export async function verifyInstalledLayout({ candidateIdentity, codexHome, installation, spec }) {
  const canonicalCodexHome = await realpath(codexHome);
  const expectedCacheRoot = join(canonicalCodexHome, "plugins", "cache");
  const cacheRoot = await realpath(expectedCacheRoot);
  if (cacheRoot !== expectedCacheRoot) fail("plugin.cache-root-not-canonical");
  const installedPath = assertAbsolutePath(installation.installedPath, "plugin.path-invalid");
  const installedInfo = await lstat(installedPath);
  if (!installedInfo.isDirectory() || installedInfo.isSymbolicLink()) fail("plugin.path-invalid");
  const pluginRoot = await realpath(installedPath);
  if (!isWithin(cacheRoot, pluginRoot)) fail("plugin.path-outside-cache");
  const expectedPluginRoot = join(
    canonicalCodexHome,
    "plugins",
    "cache",
    "nelos-marketplace",
    "nelos",
    candidateIdentity.pluginVersion,
  );
  if (pluginRoot !== expectedPluginRoot) fail("plugin.path-identity-mismatch");
  const [manifest, mcp, provenance, installedIntegrity] = await Promise.all([
    readRootedJson(pluginRoot, spec.pluginManifestPath, "plugin.manifest-invalid"),
    readRootedJson(pluginRoot, spec.mcpManifestPath, "plugin.mcp-invalid"),
    readRootedJson(pluginRoot, "distribution-provenance.json", "plugin.provenance-invalid"),
    computeDistributionIntegrity(pluginRoot),
  ]);
  if (
    manifest?.name !== "nelos" ||
    manifest?.version !== candidateIdentity.pluginVersion ||
    provenance?.revision !== candidateIdentity.pluginVersion ||
    provenance?.integrity !== candidateIdentity.distributionIntegrity ||
    installedIntegrity !== candidateIdentity.distributionIntegrity
  ) {
    fail("plugin.identity-mismatch");
  }
  if (spec === LANE_SPECS["legacy-01446"]) {
    if (
      manifest.releaseBuildIdentity !== candidateIdentity.releaseBuildIdentity ||
      mcp?.mcpServers?.nelos?.env?.NELOS_PLUGIN_VERSION !== candidateIdentity.pluginVersion ||
      mcp?.mcpServers?.nelos?.env?.NELOS_RELEASE_BUILD_IDENTITY !== candidateIdentity.releaseBuildIdentity
    ) {
      fail("plugin.identity-mismatch");
    }
  } else if (
    mcp?.mcpServers?.nelos?.type !== "stdio" ||
    mcp?.mcpServers?.nelos?.command !== "node" ||
    mcp?.mcpServers?.nelos?.args?.[0] !== "${PLUGIN_ROOT}/bin/nelos-mcp" ||
    mcp?.mcpServers?.nelos?.env?.NELOS_PLUGIN_VERSION !== candidateIdentity.pluginVersion ||
    mcp?.mcpServers?.nelos?.env?.NELOS_RELEASE_BUILD_IDENTITY !== candidateIdentity.releaseBuildIdentity ||
    Object.hasOwn(mcp?.mcpServers?.nelos?.env ?? {}, "PLUGIN_ROOT") ||
    Object.hasOwn(mcp?.mcpServers?.nelos?.env ?? {}, "PLUGIN_DATA")
  ) {
    fail("plugin.identity-mismatch");
  }
  const entrypoint = join(pluginRoot, "bin", "nelos-mcp");
  const entrypointInfo = await lstat(entrypoint);
  if (!entrypointInfo.isFile() || entrypointInfo.isSymbolicLink()) {
    fail("plugin.entrypoint-invalid");
  }
  const canonicalEntrypoint = await realpath(entrypoint);
  if (!isWithin(pluginRoot, canonicalEntrypoint)) fail("plugin.entrypoint-invalid");
  await access(canonicalEntrypoint, fsConstants.X_OK);
  return { pluginRoot, distributionIntegrity: installedIntegrity };
}

function forbiddenEnvironmentKeys(keys) {
  return keys.filter((key) =>
    /^(?:OPENAI_|ANTHROPIC_|AWS_|AZURE_|GITHUB_TOKEN$|GOOGLE_APPLICATION_CREDENTIALS$|SSH_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/iu.test(key) ||
    /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIALS?)$/iu.test(key)
  );
}

export function environmentKeyNames(environment) {
  const keys = [];
  let start = 0;
  while (start < environment.length) {
    const end = environment.indexOf(0, start);
    const boundedEnd = end === -1 ? environment.length : end;
    const separator = environment.indexOf(0x3d, start);
    if (separator > start && separator < boundedEnd) {
      keys.push(environment.subarray(start, separator).toString("utf8"));
    }
    start = boundedEnd + 1;
  }
  return keys;
}

export function projectEnvironmentPaths(environment, expectedPaths) {
  assertPlainObject(expectedPaths, "process.observation-invalid");
  const projected = Object.fromEntries(OBSERVED_ENVIRONMENT_PATH_KEYS.map((key) => [key, null]));
  const observations = new Map(OBSERVED_ENVIRONMENT_PATH_KEYS.map((key) => [key, []]));
  let start = 0;
  while (start < environment.length) {
    const end = environment.indexOf(0, start);
    const boundedEnd = end === -1 ? environment.length : end;
    const separator = environment.indexOf(0x3d, start);
    if (separator > start && separator < boundedEnd) {
      const key = environment.subarray(start, separator).toString("utf8");
      if (observations.has(key)) observations.get(key).push(environment.subarray(separator + 1, boundedEnd));
    }
    start = boundedEnd + 1;
  }
  for (const key of OBSERVED_ENVIRONMENT_PATH_KEYS) {
    const expected = expectedPaths[key];
    if (expected !== null && typeof expected !== "string") fail("process.observation-invalid");
    const values = observations.get(key);
    if (expected !== null && values.length === 1 && values[0].equals(Buffer.from(expected, "utf8"))) {
      projected[key] = expected;
    }
  }
  return projected;
}

async function procRecords() {
  const entries = await readdir("/proc", { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const statText = await readFile(`/proc/${pid}/stat`, "utf8");
      const afterName = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
      const parentPid = Number(afterName[1]);
      if (Number.isSafeInteger(parentPid)) records.push({ pid, parentPid });
    } catch {
      // Processes may exit while /proc is scanned.
    }
  }
  return records;
}

function descendantPids(rootPid, records) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (descendants.has(record.parentPid) && !descendants.has(record.pid)) {
        descendants.add(record.pid);
        changed = true;
      }
    }
  }
  descendants.delete(rootPid);
  return [...descendants];
}

async function inspectProcCandidate(
  pid,
  { candidateRoot, expectedEnvironmentPaths, installedPluginRoot, laneId, spec },
) {
  const [environment, command, cwd] = await Promise.all([
    readFile(`/proc/${pid}/environ`),
    readFile(`/proc/${pid}/cmdline`),
    readlink(`/proc/${pid}/cwd`),
  ]);
  // Extract only key names and allowlisted exact-path equality from the raw
  // buffer; mismatched values never become strings, logs, or evidence fields.
  const environmentKeys = environmentKeyNames(environment);
  const argv = command.toString("utf8").split("\0").filter(Boolean);
  const isNode = basename(argv[0] ?? "") === "node";
  const commandMatches = laneId === "legacy-01446"
    ? isNode && argv.includes("-e") && environmentKeys.includes("NELOS_PLUGIN_VERSION")
    : isNode && argv.includes(join(installedPluginRoot, "bin", "nelos-mcp"));
  const expectedCwd = laneId === "legacy-01446" ? candidateRoot : installedPluginRoot;
  if (!commandMatches || cwd !== expectedCwd) return null;
  return {
    commandClass: spec.commandClass,
    cwdClass: spec.cwdClass,
    observedEnvironmentKeys: environmentKeys,
    observedEnvironmentPaths: projectEnvironmentPaths(environment, expectedEnvironmentPaths),
    forbiddenEnvironmentKeys: forbiddenEnvironmentKeys(environmentKeys),
  };
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

class StdioAppServerTransport {
  #buffer = "";
  #child;
  #closed = false;
  #failure = null;
  #nextId = 1;
  #pending = new Map();

  constructor({ binary, cwd, env }) {
    this.#child = spawn(binary, ["app-server", "--stdio"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) => {
      if (!this.#closed) this.#fail(new Error(`app-server-exited:${signal ?? code ?? "unknown"}`));
    });
  }

  #consume(chunk) {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_APP_SERVER_MESSAGE_BYTES) {
      this.#fail(new Error("app-server-message-too-large"));
      return;
    }
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail(new Error("app-server-malformed-json"));
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error("app-server-request-rejected"));
      else pending.resolve(message.result);
    }
  }

  #fail(error) {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  request(method, params) {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("app-server-request-timeout"));
      }, APP_SERVER_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) {
    if (this.#failure) throw this.#failure;
    this.#child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async observeNelosProcess(context) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const records = await procRecords();
      const candidates = [];
      for (const pid of descendantPids(this.#child.pid, records)) {
        try {
          const candidate = await inspectProcCandidate(pid, context);
          if (candidate) candidates.push(candidate);
        } catch {
          // A child may exit while its bounded classifications are read.
        }
      }
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) fail("process.observation-ambiguous");
      await delay(100);
    }
    fail("process.observation-missing");
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => this.#child.once("exit", resolvePromise)),
      delay(2_000),
    ]);
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
    }
  }
}

async function assertNetworkDenied() {
  const names = await readdir("/sys/class/net");
  return assertNoNonLoopbackNetworkInterfaces(names, networkInterfaces());
}

export function createDefaultAdapters() {
  return {
    async readJson(path) {
      return readBoundedJson(assertAbsolutePath(path, "arguments.json-path.invalid"), "json.read-invalid");
    },
    inspectCandidate,
    verifyInputDigests,
    verifyGuestIdentity,
    assertCandidateUnchanged,
    prepareLane,
    assertNetworkDenied,
    verifyCodexVersion,
    addLocalMarketplace,
    installLocalPlugin,
    verifyInstalledLayout,
    async openAppServer(options) {
      return new StdioAppServerTransport(options);
    },
  };
}

const ARGUMENTS = Object.freeze({
  "--run-id": "runId",
  "--candidate-root": "candidateRoot",
  "--source-revision": "sourceRevision",
  "--tree-sha256": "treeSha256",
  "--contract": "contractPath",
  "--toolchain-lock": "toolchainLockPath",
  "--template-version": "templateVersion",
  "--contract-sha256": "contractSha256",
  "--toolchain-lock-sha256": "toolchainLockSha256",
  "--output": "outputPath",
});

export function parsePluginEvidenceArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = ARGUMENTS[flag];
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith("--") || Object.hasOwn(options, key)) {
      fail("arguments.invalid");
    }
    options[key] = value;
  }
  for (const key of Object.values(ARGUMENTS).filter((name) => name !== "outputPath")) {
    if (!Object.hasOwn(options, key)) fail("arguments.missing");
  }
  if (options.outputPath !== undefined) {
    options.outputPath = assertAbsolutePath(options.outputPath, "arguments.output.invalid");
  }
  options.candidateRoot = assertAbsolutePath(
    options.candidateRoot,
    "arguments.candidate-root.invalid",
  );
  options.contractPath = assertAbsolutePath(options.contractPath, "arguments.contract.invalid");
  options.toolchainLockPath = assertAbsolutePath(
    options.toolchainLockPath,
    "arguments.toolchain-lock.invalid",
  );
  return options;
}

export async function runPluginEvidenceCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const options = parsePluginEvidenceArgs(argv);
    if (options.outputPath) {
      const runRoot = lanePaths(options.runId, LANE_IDS[0]).runRoot;
      if (!isWithin(runRoot, options.outputPath)) fail("arguments.output.outside-run");
    }
    const evidence = await collectPluginEvidence(options);
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (options.outputPath) {
      await writeFile(options.outputPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } else {
      stdout.write(serialized);
    }
    return evidence.result.status === "passed" ? 0 : 1;
  } catch (error) {
    const code = error instanceof PluginEvidenceRunnerError ? error.code : "runner.failed";
    stderr.write(`run-plugin-evidence: ${code}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPluginEvidenceCli(process.argv.slice(2));
}
