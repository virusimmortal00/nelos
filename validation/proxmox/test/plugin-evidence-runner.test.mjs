import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { DISTRIBUTION_ENTRIES } from "../../../src/distribution-provenance.mjs";
import { validateEvidenceDocument } from "../scripts/validate-contract.mjs";

import {
  APP_SERVER_CLIENT_NAME,
  GUEST_RECEIPT_SCHEMA_VERSION,
  LANE_SPECS,
  PluginEvidenceRunnerError,
  assertNoNonLoopbackNetworkInterfaces,
  buildIsolatedEnvironment,
  collectPluginEvidence,
  environmentKeyNames,
  lanePaths,
  parseLocalMarketplaceAddResult,
  parseLocalPluginInstallResult,
  parsePluginEvidenceArgs,
  projectEnvironmentPaths,
  sanitizeProcessObservation,
  validateGuestIdentityObservation,
  verifyInstalledLayout,
} from "../scripts/run-plugin-evidence.mjs";

const RUN_ID = `run-${"e".repeat(32)}`;
const CANDIDATE_ROOT = `/var/lib/nelos-validator/runs/${RUN_ID}/candidate`;
const SOURCE_REVISION = "a".repeat(40);
const TREE_SHA256 = "b".repeat(64);
const ARCHIVE_SHA256 = "f".repeat(64);
const CONTRACT_SHA256 = "c".repeat(64);
const LOCK_SHA256 = "d".repeat(64);
const PLUGIN_VERSION = "0.12.12";
const DISTRIBUTION_INTEGRITY = `sha256:${"9".repeat(64)}`;
const AGENT_PLUGIN_DATA_IDENTITY = "a6d40ae7e7d571a8fc605a1061c3f77ec8053b05dbfcc4b1a2f58cb7f684a5e8";
const packageRoot = resolve(import.meta.dirname, "../../..");

async function installedLayoutFixture() {
  const root = await mkdtemp(join(tmpdir(), "nelos-installed-layout-"));
  const codexHome = join(root, "home", ".codex");
  const cacheRoot = join(codexHome, "plugins", "cache");
  const pluginRoot = join(cacheRoot, "nelos-marketplace", "nelos", PLUGIN_VERSION);
  await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  await Promise.all(DISTRIBUTION_ENTRIES.map((entry) =>
    cp(join(packageRoot, entry), join(pluginRoot, entry), { recursive: true })
  ));
  await cp(
    join(packageRoot, "distribution-provenance.json"),
    join(pluginRoot, "distribution-provenance.json"),
  );
  const [manifest, provenance] = await Promise.all([
    readFile(join(packageRoot, ".codex-plugin", "plugin.json"), "utf8").then(JSON.parse),
    readFile(join(packageRoot, "distribution-provenance.json"), "utf8").then(JSON.parse),
  ]);
  return {
    root,
    codexHome,
    pluginRoot,
    candidateIdentity: {
      pluginVersion: manifest.version,
      releaseBuildIdentity: manifest.releaseBuildIdentity,
      distributionIntegrity: provenance.integrity,
    },
  };
}

function contractFixture() {
  return {
    contractVersion: "1.0.0",
    scope: {
      proxmoxVeBaseline: "8.4",
      guest: {
        operatingSystem: "linux",
        distribution: "ubuntu",
        release: "24.04 LTS",
        architecture: "x86_64",
      },
    },
    lanes: {
      "legacy-01446": {
        codexVersion: "0.144.6",
        pluginManifestPath: ".codex-plugin/plugin.json",
        mcpManifestPath: ".mcp.json",
        requiredEnvironment: [
          "HOME",
          "CODEX_HOME",
          "TMPDIR",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "XDG_DATA_HOME",
        ],
      },
      "agent-plugin-01470": {
        codexVersion: "0.147.0",
        pluginManifestPath: "plugin.json",
        mcpManifestPath: "mcp.json",
        requiredEnvironment: [
          "HOME",
          "CODEX_HOME",
          "TMPDIR",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "XDG_DATA_HOME",
          "PLUGIN_ROOT",
          "PLUGIN_DATA",
        ],
      },
    },
    validation: {
      offline: true,
      validationNetwork: "denied",
      marketplaceSelector: "nelos@nelos-marketplace",
      mcpServerId: "nelos",
      sanitization: {
        allowedEnvironmentKeys: [
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
        ],
      },
    },
  };
}

function lockFixture() {
  return {
    artifacts: {
      node: { version: "24.18.0" },
      codexLegacy: { version: "0.144.6", laneId: "legacy-01446" },
      codexAgentPlugin: { version: "0.147.0", laneId: "agent-plugin-01470" },
    },
  };
}

function optionsFixture(overrides = {}) {
  return {
    runId: RUN_ID,
    candidateRoot: CANDIDATE_ROOT,
    sourceRevision: SOURCE_REVISION,
    treeSha256: TREE_SHA256,
    contractSha256: CONTRACT_SHA256,
    toolchainLockSha256: LOCK_SHA256,
    templateVersion: "1.0.0",
    contract: contractFixture(),
    toolchainLock: lockFixture(),
    ...overrides,
  };
}

function passedLifecycle() {
  return {
    pilotNode: "prox2",
    sourceTemplateVmid: 9021,
    disposableVmid: 9030,
    clusterWideUnused: true,
    cloneMutationAttempted: true,
    cloneMutationSettlement: "settled-present",
    cloneCreated: true,
    linkedClone: true,
    sameNode: true,
    ownershipReadback: true,
    networkDetachedBeforeStart: true,
    networkDeniedDuringValidation: true,
    guestAgentReady: true,
    guestIdentityVerified: true,
    cloudInitStatus: "done",
    cleanupOutcome: "destroyed",
    clusterAbsentAfterCleanup: true,
  };
}

async function repositoryEvidenceContract() {
  const [contract, evidenceSchema] = await Promise.all([
    readFile(new URL("../contract.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../evidence/schema.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  return { contract, evidenceSchema };
}

function fakeAdapters({
  agentTools = ["nelos_config_get", "nelos_plan_lifecycle"],
  legacyTools = ["nelos_plan_lifecycle", "nelos_config_get"],
  observationOverrides = {},
  initializeUserAgent = ({ version }) =>
    `${APP_SERVER_CLIENT_NAME}/${version} (Ubuntu 24.04; x86_64) codex-terminal`,
  throwAt = null,
} = {}) {
  const calls = [];
  const transports = [];
  let transportSequence = 0;

  function maybeThrow(stage) {
    if (throwAt === stage) {
      throw new Error("SECRET value at /Users/operator/.ssh/id_ed25519 on 192.168.1.246");
    }
  }

  const adapters = {
    async inspectCandidate({ candidateRoot }) {
      calls.push(["inspectCandidate", candidateRoot]);
      maybeThrow("inspectCandidate");
      return {
        pluginVersion: PLUGIN_VERSION,
        releaseBuildIdentity: `nelos-release-v1:${PLUGIN_VERSION}`,
        distributionIntegrity: DISTRIBUTION_INTEGRITY,
        fingerprint: "e".repeat(64),
      };
    },
    async verifyInputDigests(input) {
      calls.push(["verifyInputDigests", input]);
      maybeThrow("inputDigests");
    },
    async verifyGuestIdentity(input) {
      calls.push(["verifyGuestIdentity", input]);
      maybeThrow("guestIdentity");
    },
    async assertCandidateUnchanged(input) {
      calls.push(["assertCandidateUnchanged", input]);
      maybeThrow("candidateChanged");
    },
    async prepareLane(paths) {
      calls.push(["prepareLane", paths.laneRoot]);
      maybeThrow(`prepareLane:${paths.laneRoot.split("/").at(-1)}`);
    },
    async assertNetworkDenied() {
      calls.push(["assertNetworkDenied"]);
      maybeThrow("network");
    },
    async verifyCodexVersion({ expectedVersion, laneId, env }) {
      calls.push(["verifyCodexVersion", laneId, expectedVersion, env]);
      maybeThrow(`version:${laneId}`);
    },
    async addLocalMarketplace({ candidateRoot, expectedName, env }) {
      calls.push(["addLocalMarketplace", expectedName, candidateRoot, env]);
      maybeThrow(`marketplace:${env.CODEX_HOME.includes("agent-plugin") ? "agent" : "legacy"}`);
    },
    async installLocalPlugin({ selector, env }) {
      const laneId = env.CODEX_HOME.includes("agent-plugin")
        ? "agent-plugin-01470"
        : "legacy-01446";
      calls.push(["installLocalPlugin", laneId, selector, env]);
      maybeThrow(`install:${laneId}`);
      return { installedPath: `/private/cache/with-address-192.168.1.246/${laneId}` };
    },
    async verifyInstalledLayout({ codexHome, installation, laneId }) {
      calls.push(["verifyInstalledLayout", laneId, installation.installedPath]);
      maybeThrow(`layout:${laneId}`);
      return {
        pluginRoot: `${codexHome}/plugins/cache/nelos-marketplace/nelos/${PLUGIN_VERSION}`,
        distributionIntegrity: DISTRIBUTION_INTEGRITY,
      };
    },
    async openAppServer({ cwd, env, laneId }) {
      calls.push(["openAppServer", laneId, cwd, env]);
      maybeThrow(`open:${laneId}`);
      const transportId = ++transportSequence;
      const requests = [];
      const toolNames = laneId === "legacy-01446" ? legacyTools : agentTools;
      const transport = {
        transportId,
        laneId,
        requests,
        notifications: [],
        closed: false,
        async request(method, params) {
          requests.push({ method, params });
          maybeThrow(`${method}:${laneId}`);
          if (method === "initialize") {
            const version = laneId === "legacy-01446" ? "0.144.6" : "0.147.0";
            return {
              codexHome: env.CODEX_HOME,
              platformFamily: "unix",
              platformOs: "linux",
              userAgent: initializeUserAgent({ laneId, version }),
            };
          }
          if (method === "mcpServerStatus/list") {
            return {
              data: [{
                name: "nelos",
                authStatus: "unsupported",
                resourceTemplates: [],
                resources: [],
                tools: Object.fromEntries(toolNames.map((name) => [name, {
                  name,
                  inputSchema: { type: "object" },
                }])),
              }],
              nextCursor: null,
            };
          }
          if (method === "thread/start") {
            return { thread: { id: `ephemeral-${transportId}` } };
          }
          if (method === "mcpServer/tool/call") {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  schemaVersion: 1,
                  configPath: `${env.XDG_CONFIG_HOME}/nelos/config.toml`,
                  configFileExists: false,
                  setting: {
                    key: "spinoffs.cleanup_policy",
                    value: "auto",
                    source: "default",
                  },
                  allowedValues: ["auto", "ask", "keep"],
                  migration: null,
                  deliberatelyUnsafeIgnoredField: "OPENAI_API_KEY=secret /Users/operator/private",
                }),
              }],
              isError: false,
            };
          }
          throw new Error(`unexpected fake method ${method}`);
        },
        notify(method, params) {
          this.notifications.push({ method, params });
        },
        async observeNelosProcess() {
          maybeThrow(`observe:${laneId}`);
          const commonPaths = {
            HOME: env.HOME,
            CODEX_HOME: env.CODEX_HOME,
            TMPDIR: env.TMPDIR,
            XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
            XDG_CACHE_HOME: env.XDG_CACHE_HOME,
            XDG_DATA_HOME: env.XDG_DATA_HOME,
          };
          const base = laneId === "legacy-01446"
            ? {
              commandClass: "node-inline-bootstrap",
              cwdClass: "task-workspace",
              observedEnvironmentKeys: [
                "PATH",
                "HOME",
                "CODEX_HOME",
                "TMPDIR",
                "XDG_CACHE_HOME",
                "XDG_CONFIG_HOME",
                "XDG_DATA_HOME",
                "NELOS_PLUGIN_VERSION",
                "NELOS_RELEASE_BUILD_IDENTITY",
              ],
              observedEnvironmentPaths: {
                ...commonPaths,
                PLUGIN_DATA: null,
                PLUGIN_ROOT: null,
              },
              forbiddenEnvironmentKeys: [],
              pid: 9876,
              fullCommand: "node -e /private/path",
            }
            : {
              commandClass: "node-plugin-root-entrypoint",
              cwdClass: "plugin-root",
              observedEnvironmentKeys: [
                "PATH",
                "HOME",
                "CODEX_HOME",
                "TMPDIR",
                "XDG_CACHE_HOME",
                "XDG_CONFIG_HOME",
                "XDG_DATA_HOME",
                "PLUGIN_ROOT",
                "PLUGIN_DATA",
              ],
              observedEnvironmentPaths: {
                ...commonPaths,
                PLUGIN_DATA: `${env.CODEX_HOME}/plugins/data/agent-plugins/${AGENT_PLUGIN_DATA_IDENTITY}`,
                PLUGIN_ROOT: cwd,
              },
              forbiddenEnvironmentKeys: [],
              pid: 6789,
              fullCommand: "node /private/plugin/bin/nelos-mcp",
            };
          return { ...base, ...(observationOverrides[laneId] ?? {}) };
        },
        async close() {
          this.closed = true;
        },
      };
      transports.push(transport);
      return transport;
    },
  };
  return { adapters, calls, transports };
}

test("lane roots and env -i inputs are isolated and contain no ambient credentials", () => {
  const legacy = lanePaths(RUN_ID, "legacy-01446");
  const agent = lanePaths(RUN_ID, "agent-plugin-01470");
  assert.equal(legacy.home, `${CANDIDATE_ROOT.slice(0, -"candidate".length)}legacy-01446/home`);
  assert.equal(legacy.codexHome, `${legacy.home}/.codex`);
  assert.notEqual(legacy.laneRoot, agent.laneRoot);

  const env = buildIsolatedEnvironment(agent);
  assert.deepEqual(Object.keys(env).sort(), [
    "CODEX_HOME",
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]);
  assert.equal(env.HOME, agent.home);
  assert.equal(env.CODEX_HOME, `${env.HOME}/.codex`);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.PLUGIN_ROOT, undefined, "Codex must inject reserved Agent-v1 variables");
});

test("network validation rejects even an unaddressed non-loopback interface", () => {
  assert.equal(assertNoNonLoopbackNetworkInterfaces(["lo"], {
    lo: [{ address: "127.0.0.1", internal: true }],
  }), true);
  assert.throws(
    () => assertNoNonLoopbackNetworkInterfaces(["lo", "ens18"], { ens18: [] }),
    (error) => error instanceof PluginEvidenceRunnerError && error.code === "validation.network-not-denied",
  );
  assert.throws(
    () => assertNoNonLoopbackNetworkInterfaces(["lo"], {
      ens18: [{ address: "192.168.1.100", internal: false }],
    }),
    /validation\.network-not-denied/u,
  );
});

test("guest identity observation binds Ubuntu, architecture, and exact locked Node", () => {
  const context = { contract: contractFixture(), toolchainLock: lockFixture() };
  const observation = {
    platform: "linux",
    arch: "x64",
    nodeVersion: "v24.18.0",
    nodeExecutable: "/opt/nelos-validator/node/24.18.0/bin/node",
    osId: "ubuntu",
    osVersion: "24.04",
    uname: "x86_64",
  };
  assert.equal(validateGuestIdentityObservation(observation, context), true);
  for (const candidate of [
    { ...observation, osId: "debian" },
    { ...observation, uname: "aarch64" },
    { ...observation, nodeVersion: "v24.18.1" },
    { ...observation, nodeExecutable: "/usr/bin/node" },
  ]) {
    assert.throws(
      () => validateGuestIdentityObservation(candidate, context),
      /template\.guest-identity-mismatch/u,
    );
  }
});

test("CLI parsing requires immutable candidate identity and rejects duplicate or relative inputs", () => {
  const argv = [
    "--run-id", RUN_ID,
    "--candidate-root", CANDIDATE_ROOT,
    "--source-revision", SOURCE_REVISION,
    "--tree-sha256", TREE_SHA256,
    "--contract", `${CANDIDATE_ROOT}/validation/proxmox/contract.json`,
    "--toolchain-lock", "/opt/nelos-validator/toolchain.lock.json",
    "--template-version", "1.0.0",
    "--contract-sha256", CONTRACT_SHA256,
    "--toolchain-lock-sha256", LOCK_SHA256,
  ];
  assert.deepEqual(parsePluginEvidenceArgs(argv), {
    runId: RUN_ID,
    candidateRoot: CANDIDATE_ROOT,
    sourceRevision: SOURCE_REVISION,
    treeSha256: TREE_SHA256,
    contractPath: `${CANDIDATE_ROOT}/validation/proxmox/contract.json`,
    toolchainLockPath: "/opt/nelos-validator/toolchain.lock.json",
    templateVersion: "1.0.0",
    contractSha256: CONTRACT_SHA256,
    toolchainLockSha256: LOCK_SHA256,
  });
  assert.equal(
    parsePluginEvidenceArgs(argv.with(5, "f".repeat(64))).sourceRevision,
    "f".repeat(64),
  );
  assert.throws(() => parsePluginEvidenceArgs([...argv, "--run-id", "again"]), /arguments\.invalid/u);
  assert.throws(
    () => parsePluginEvidenceArgs(argv.with(3, "relative/candidate")),
    /arguments\.candidate-root\.invalid/u,
  );
});

test("exact Codex 0.144.6 local marketplace and install JSON shapes are accepted", () => {
  assert.equal(parseLocalMarketplaceAddResult({
    marketplaceName: "nelos-marketplace",
    installedPath: "/isolated/home/.codex/plugins/marketplaces/nelos-marketplace",
  }, "nelos-marketplace"), true);
  assert.deepEqual(parseLocalPluginInstallResult({
    pluginName: "nelos",
    marketplaceName: "nelos-marketplace",
    installedPath: "/isolated/home/.codex/plugins/cache/nelos-marketplace/nelos/0.12.12",
  }), {
    installedPath: "/isolated/home/.codex/plugins/cache/nelos-marketplace/nelos/0.12.12",
  });
  assert.throws(
    () => parseLocalMarketplaceAddResult({ marketplaceName: "remote" }, "nelos-marketplace"),
    /marketplace\.identity-mismatch/u,
  );
  assert.throws(() => parseLocalPluginInstallResult({}), /plugin\.install-result-invalid/u);
});

test("installed legacy and Agent lanes bind the complete runtime distribution digest", async () => {
  const fixture = await installedLayoutFixture();
  try {
    for (const laneId of ["legacy-01446", "agent-plugin-01470"]) {
      assert.deepEqual(await verifyInstalledLayout({
        candidateIdentity: fixture.candidateIdentity,
        codexHome: fixture.codexHome,
        installation: { installedPath: fixture.pluginRoot },
        spec: LANE_SPECS[laneId],
      }), {
        pluginRoot: await realpath(fixture.pluginRoot),
        distributionIntegrity: fixture.candidateIdentity.distributionIntegrity,
      });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-version cached runtime tampering cannot satisfy candidate identity", async () => {
  const fixture = await installedLayoutFixture();
  try {
    await writeFile(
      join(fixture.pluginRoot, "src", "mcp-server.mjs"),
      "\n// stale same-version cache\n",
      { flag: "a" },
    );
    await assert.rejects(
      () => verifyInstalledLayout({
        candidateIdentity: fixture.candidateIdentity,
        codexHome: fixture.codexHome,
        installation: { installedPath: fixture.pluginRoot },
        spec: LANE_SPECS["legacy-01446"],
      }),
      /plugin\.identity-mismatch/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installed entrypoint and cache symlinks fail closed", async () => {
  const entrypointFixture = await installedLayoutFixture();
  try {
    const entrypoint = join(entrypointFixture.pluginRoot, "bin", "nelos-mcp");
    await rm(entrypoint);
    await symlink(join(packageRoot, "bin", "nelos-mcp"), entrypoint);
    await assert.rejects(
      () => verifyInstalledLayout({
        candidateIdentity: entrypointFixture.candidateIdentity,
        codexHome: entrypointFixture.codexHome,
        installation: { installedPath: entrypointFixture.pluginRoot },
        spec: LANE_SPECS["agent-plugin-01470"],
      }),
      /symlink|entrypoint/u,
    );
  } finally {
    await rm(entrypointFixture.root, { recursive: true, force: true });
  }

  const cacheFixture = await installedLayoutFixture();
  try {
    const linkedPath = join(cacheFixture.pluginRoot, "linked-install");
    await symlink(cacheFixture.pluginRoot, linkedPath);
    await assert.rejects(
      () => verifyInstalledLayout({
        candidateIdentity: cacheFixture.candidateIdentity,
        codexHome: cacheFixture.codexHome,
        installation: { installedPath: linkedPath },
        spec: LANE_SPECS["legacy-01446"],
      }),
      /plugin\.path-invalid/u,
    );
  } finally {
    await rm(cacheFixture.root, { recursive: true, force: true });
  }
});

test("collector uses two fresh exact-version processes and emits sanitized parity evidence", async () => {
  const fixture = fakeAdapters();
  const evidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);

  assert.equal(evidence.result.status, "passed");
  assert.equal(evidence.schemaVersion, GUEST_RECEIPT_SCHEMA_VERSION);
  assert.equal(Object.hasOwn(evidence, "lifecycle"), false);
  assert.deepEqual(evidence.observations, {
    guestIdentityVerified: true,
    networkDeniedDuringValidation: true,
  });
  assert.deepEqual(evidence.result.failures, []);
  assert.deepEqual(evidence.candidate, {
    sourceRevision: SOURCE_REVISION,
    treeSha256: TREE_SHA256,
    distributionIntegrity: DISTRIBUTION_INTEGRITY,
    dirty: false,
  });
  assert.equal(fixture.transports.length, 2);
  assert.notEqual(fixture.transports[0].transportId, fixture.transports[1].transportId);
  assert.equal(fixture.transports.every(({ closed }) => closed), true);

  for (const transport of fixture.transports) {
    assert.deepEqual(transport.requests.map(({ method }) => method), [
      "initialize",
      "thread/start",
      "mcpServerStatus/list",
      "mcpServer/tool/call",
    ]);
    assert.deepEqual(transport.notifications, [{ method: "initialized", params: {} }]);
    assert.equal(
      transport.requests[0].params.clientInfo.name,
      APP_SERVER_CLIENT_NAME,
    );
    assert.equal(transport.requests.some(({ method }) => method.startsWith("turn/")), false);
    const call = transport.requests.at(-1);
    const status = transport.requests.find(({ method }) => method === "mcpServerStatus/list");
    assert.equal(status.params.threadId, call.params.threadId);
    assert.equal(call.params.server, "nelos");
    assert.equal(call.params.tool, "nelos_config_get");
    assert.deepEqual(call.params.arguments, {});
  }

  assert.deepEqual(evidence.lanes["legacy-01446"].toolNames, [
    "nelos_config_get",
    "nelos_plan_lifecycle",
  ]);
  assert.deepEqual(evidence.lanes["agent-plugin-01470"].toolNames, [
    "nelos_config_get",
    "nelos_plan_lifecycle",
  ]);
  assert.equal(evidence.lanes["legacy-01446"].checks.laneParity, true);
  assert.equal(evidence.lanes["agent-plugin-01470"].checks.laneParity, true);
  assert.deepEqual(
    evidence.lanes["agent-plugin-01470"].processObservation.observedEnvironmentKeys,
    [
      "CODEX_HOME",
      "HOME",
      "PLUGIN_DATA",
      "PLUGIN_ROOT",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ],
  );
  assert.deepEqual(
    evidence.lanes["legacy-01446"].processObservation.observedEnvironmentKeys,
    [
      "CODEX_HOME",
      "HOME",
      "NELOS_PLUGIN_VERSION",
      "NELOS_RELEASE_BUILD_IDENTITY",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ],
  );
  for (const lane of Object.values(evidence.lanes)) {
    assert.equal(lane.installedDistributionIntegrity, DISTRIBUTION_INTEGRITY);
    assert.equal(lane.tmpDir.endsWith("/tmp"), true);
    assert.equal(lane.xdgConfigHome.endsWith("/xdg/config"), true);
    assert.equal(lane.xdgCacheHome.endsWith("/xdg/cache"), true);
    assert.equal(lane.xdgDataHome.endsWith("/xdg/data"), true);
  }

  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    "9876",
    "6789",
    "192.168.1.246",
    "/private/",
    "/Users/operator",
    "OPENAI_API_KEY=secret",
    "\"fullCommand\":",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("collector accepts only the pinned Codex app-server user-agent origins", async () => {
  const defaultOriginator = fakeAdapters({
    initializeUserAgent: ({ version }) =>
      `codex_cli_rs/${version} (Ubuntu 24.04; x86_64) codex-terminal`,
  });
  const defaultOriginatorEvidence = await collectPluginEvidence(
    optionsFixture(),
    defaultOriginator.adapters,
  );
  assert.equal(defaultOriginatorEvidence.result.status, "passed");

  const fixture = fakeAdapters({
    initializeUserAgent: ({ version }) => `codex-cli/${version}`,
  });
  const evidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);

  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("legacy.process.identity-mismatch"));
  assert(evidence.result.failures.includes("agent-plugin.process.identity-mismatch"));
  assert.equal(evidence.lanes["legacy-01446"].freshProcess, false);
  assert.equal(evidence.lanes["agent-plugin-01470"].freshProcess, false);
});

test("initialize success followed by tools-list failure remains a conservative schema-valid receipt", async () => {
  const fixture = fakeAdapters({ throwAt: "mcpServerStatus/list:agent-plugin-01470" });
  const evidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);
  const agent = evidence.lanes["agent-plugin-01470"];
  const transport = fixture.transports.find(({ laneId }) => laneId === "agent-plugin-01470");

  assert.deepEqual(transport.requests.map(({ method }) => method), [
    "initialize",
    "thread/start",
    "mcpServerStatus/list",
  ]);
  assert.equal(agent.checks.marketplaceInstall, true);
  assert.equal(agent.checks.pluginInstall, true);
  assert.equal(agent.freshProcess, false);
  assert.equal(agent.checks.freshProcessStart, false);
  assert.equal(agent.checks.mcpInitialize, false);
  assert.equal(agent.checks.toolsList, false);
  assert.equal(agent.checks.nelosConfigGet, false);
  assert.deepEqual(agent.toolNames, []);
  assert.deepEqual(agent.processObservation.observedEnvironmentKeys, []);
  assert(evidence.result.failures.includes("agent-plugin.tools-list.failed"));
  assert(evidence.result.failures.includes("lane.parity-mismatch"));
  const { contract, evidenceSchema } = await repositoryEvidenceContract();
  const { observations: _observations, ...guestReceipt } = evidence;
  const normalized = {
    ...guestReceipt,
    schemaVersion: 2,
    candidate: { ...guestReceipt.candidate, archiveSha256: ARCHIVE_SHA256 },
    lifecycle: passedLifecycle(),
  };
  assert.equal(validateEvidenceDocument(normalized, evidenceSchema, contract), normalized);
});

test("controller-normalized successful receipt satisfies the repository evidence contract", async () => {
  const fixture = fakeAdapters();
  const guestEvidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);
  const { contract, evidenceSchema } = await repositoryEvidenceContract();
  const { observations: _observations, ...guestReceipt } = guestEvidence;
  const evidence = {
    ...guestReceipt,
    schemaVersion: 2,
    candidate: { ...guestReceipt.candidate, archiveSha256: ARCHIVE_SHA256 },
    lifecycle: passedLifecycle(),
  };

  assert.equal(validateEvidenceDocument(evidence, evidenceSchema, contract), evidence);
});

test("guest receipt requires positive network-denial observations across the full validation window", async () => {
  const fixture = fakeAdapters({ throwAt: "network" });
  const evidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);

  assert.equal(evidence.result.status, "failed");
  assert.deepEqual(evidence.observations, {
    guestIdentityVerified: true,
    networkDeniedDuringValidation: false,
  });
  assert(evidence.result.failures.includes("validation.network-not-denied"));
});

test("guest identity mismatch cannot produce a positive platform observation", async () => {
  const fixture = fakeAdapters({ throwAt: "guestIdentity" });
  const evidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);

  assert.equal(evidence.result.status, "failed");
  assert.deepEqual(evidence.observations, {
    guestIdentityVerified: false,
    networkDeniedDuringValidation: false,
  });
  assert(evidence.result.failures.includes("template.guest-identity-mismatch"));
});

test("collector reports exact tool-set mismatch without preserving raw tool responses", async () => {
  const fixture = fakeAdapters({
    agentTools: ["nelos_config_get", "nelos_agent_only"],
  });
  const evidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);

  assert.equal(evidence.result.status, "failed");
  assert.deepEqual(evidence.result.failures, ["lane.parity-mismatch"]);
  assert.equal(evidence.lanes["legacy-01446"].checks.nelosConfigGet, true);
  assert.equal(evidence.lanes["agent-plugin-01470"].checks.nelosConfigGet, true);
  assert.equal(evidence.lanes["legacy-01446"].checks.laneParity, false);
  assert.equal(evidence.lanes["agent-plugin-01470"].checks.laneParity, false);
  assert.equal(JSON.stringify(evidence).includes("deliberatelyUnsafeIgnoredField"), false);
});

test("forbidden MCP child environment keys fail closed and are never exported", async () => {
  const fixture = fakeAdapters({
    observationOverrides: {
      "agent-plugin-01470": {
        forbiddenEnvironmentKeys: ["OPENAI_API_KEY", "SSH_AUTH_SOCK"],
        observedEnvironmentKeys: [
          "HOME",
          "CODEX_HOME",
          "TMPDIR",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "XDG_DATA_HOME",
          "PLUGIN_ROOT",
          "PLUGIN_DATA",
          "OPENAI_API_KEY",
          "SSH_AUTH_SOCK",
        ],
      },
    },
  });
  const evidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);

  assert.equal(evidence.result.status, "failed");
  assert.deepEqual(evidence.result.failures, [
    "lane.parity-mismatch",
    "process.forbidden-environment-observed",
  ]);
  assert.equal(evidence.lanes["agent-plugin-01470"].freshProcess, true);
  assert.equal(evidence.lanes["agent-plugin-01470"].checks.freshProcessStart, true);
  assert.deepEqual(evidence.lanes["agent-plugin-01470"].toolNames, []);
  assert.deepEqual(
    evidence.lanes["agent-plugin-01470"].processObservation.observedEnvironmentKeys,
    [
      "CODEX_HOME",
      "HOME",
      "PLUGIN_DATA",
      "PLUGIN_ROOT",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ],
  );
  assert.equal(JSON.stringify(evidence).includes("OPENAI_API_KEY"), false);
  assert.equal(JSON.stringify(evidence).includes("SSH_AUTH_SOCK"), false);
  const { contract, evidenceSchema } = await repositoryEvidenceContract();
  const { observations: _observations, ...guestReceipt } = evidence;
  const normalized = {
    ...guestReceipt,
    schemaVersion: 2,
    candidate: { ...guestReceipt.candidate, archiveSha256: ARCHIVE_SHA256 },
    lifecycle: passedLifecycle(),
  };
  assert.equal(validateEvidenceDocument(normalized, evidenceSchema, contract), normalized);
});

test("a classified process reports an isolation mismatch as key-present and value-redacted", async () => {
  const paths = lanePaths(RUN_ID, "agent-plugin-01470");
  const fixture = fakeAdapters({
    observationOverrides: {
      "agent-plugin-01470": {
        observedEnvironmentKeys: [
          "HOME",
          "CODEX_HOME",
          "TMPDIR",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "XDG_DATA_HOME",
          "PLUGIN_ROOT",
          "PLUGIN_DATA",
        ],
        observedEnvironmentPaths: {
          HOME: paths.home,
          CODEX_HOME: paths.codexHome,
          TMPDIR: null,
          XDG_CONFIG_HOME: paths.xdgConfig,
          XDG_CACHE_HOME: paths.xdgCache,
          XDG_DATA_HOME: paths.xdgData,
          PLUGIN_DATA: `${paths.codexHome}/plugins/data/agent-plugins/${AGENT_PLUGIN_DATA_IDENTITY}`,
          PLUGIN_ROOT: `${paths.codexHome}/plugins/cache/nelos-marketplace/nelos/${PLUGIN_VERSION}`,
        },
      },
    },
  });
  const evidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);
  const lane = evidence.lanes["agent-plugin-01470"];
  assert.equal(evidence.result.status, "failed");
  assert(evidence.result.failures.includes("process.required-environment-missing"));
  assert.equal(lane.freshProcess, true);
  assert.equal(lane.checks.freshProcessStart, true);
  assert.equal(lane.installedDistributionIntegrity, DISTRIBUTION_INTEGRITY);
  assert(lane.processObservation.observedEnvironmentKeys.includes("TMPDIR"));
  assert.equal(lane.processObservation.observedEnvironmentPaths.TMPDIR, null);
  const { contract, evidenceSchema } = await repositoryEvidenceContract();
  const { observations: _observations, ...guestReceipt } = evidence;
  const normalized = {
    ...guestReceipt,
    schemaVersion: 2,
    candidate: { ...guestReceipt.candidate, archiveSha256: ARCHIVE_SHA256 },
    lifecycle: passedLifecycle(),
  };
  assert.equal(validateEvidenceDocument(normalized, evidenceSchema, contract), normalized);
});

test("stage errors collapse to safe classifications without leaking exception text", async () => {
  const fixture = fakeAdapters({ throwAt: "install:legacy-01446" });
  const evidence = await collectPluginEvidence(optionsFixture(), fixture.adapters);

  assert.equal(evidence.result.status, "failed");
  assert.deepEqual(evidence.result.failures, [
    "lane.parity-mismatch",
    "legacy.plugin.install-failed",
  ]);
  assert.equal(evidence.lanes["legacy-01446"].checks.marketplaceInstall, true);
  assert.equal(evidence.lanes["legacy-01446"].checks.pluginInstall, false);
  assert.equal(evidence.lanes["legacy-01446"].installedDistributionIntegrity, null);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("id_ed25519"), false);
  assert.equal(serialized.includes("192.168.1.246"), false);
  assert.equal(serialized.includes("SECRET"), false);
});

test("process observation projection allows only classifications and allowlisted key names", () => {
  const expectedPaths = {
    HOME: "/isolated/home",
    CODEX_HOME: "/isolated/home/.codex",
    TMPDIR: "/isolated/tmp",
    XDG_CONFIG_HOME: "/isolated/xdg/config",
    XDG_CACHE_HOME: "/isolated/xdg/cache",
    XDG_DATA_HOME: "/isolated/xdg/data",
    PLUGIN_DATA: "/isolated/plugin-data",
    PLUGIN_ROOT: "/isolated/plugin-root",
  };
  const result = sanitizeProcessObservation({
    raw: {
      commandClass: "node-plugin-root-entrypoint",
      cwdClass: "plugin-root",
      observedEnvironmentKeys: [
        "PATH",
        "HOME",
        "CODEX_HOME",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "PLUGIN_ROOT",
        "PLUGIN_DATA",
        "UNRELATED",
      ],
      observedEnvironmentPaths: expectedPaths,
      forbiddenEnvironmentKeys: [],
      pid: 42,
      cwd: "/private/plugin",
      argv: ["node", "/private/plugin/bin/nelos-mcp"],
    },
    spec: {
      commandClass: "node-plugin-root-entrypoint",
      cwdClass: "plugin-root",
    },
    allowedKeys: [
      "CODEX_HOME",
      "HOME",
      "PLUGIN_DATA",
      "PLUGIN_ROOT",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ],
    expectedPaths,
  });
  assert.deepEqual(result, {
    commandClass: "node-plugin-root-entrypoint",
    cwdClass: "plugin-root",
    observedEnvironmentKeys: [
      "CODEX_HOME",
      "HOME",
      "PLUGIN_DATA",
      "PLUGIN_ROOT",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ],
    observedEnvironmentPaths: expectedPaths,
    fullCommandCaptured: false,
    fullEnvironmentCaptured: false,
  });
  assert.equal(JSON.stringify(result).includes("42"), false);
  assert.equal(JSON.stringify(result).includes("/private/plugin"), false);
});

test("raw proc environment parsing materializes key names but not secret values", () => {
  const keys = environmentKeyNames(Buffer.from(
    "HOME=/isolated/home\0OPENAI_API_KEY=do-not-materialize\0PLUGIN_ROOT=/private/plugin\0",
  ));
  assert.deepEqual(keys, ["HOME", "OPENAI_API_KEY", "PLUGIN_ROOT"]);
  assert.equal(JSON.stringify(keys).includes("do-not-materialize"), false);
  assert.equal(JSON.stringify(keys).includes("/private/plugin"), false);
});

test("raw process path projection records only exact expected values", () => {
  const expectedPaths = {
    HOME: "/isolated/home",
    CODEX_HOME: "/isolated/home/.codex",
    TMPDIR: "/isolated/tmp",
    XDG_CONFIG_HOME: "/isolated/xdg/config",
    XDG_CACHE_HOME: "/isolated/xdg/cache",
    XDG_DATA_HOME: "/isolated/xdg/data",
    PLUGIN_DATA: "/isolated/plugin-data",
    PLUGIN_ROOT: "/isolated/plugin-root",
  };
  const projection = projectEnvironmentPaths(Buffer.from([
    `HOME=${expectedPaths.HOME}`,
    `CODEX_HOME=${expectedPaths.CODEX_HOME}`,
    "TMPDIR=/operator/private/mismatch",
    `XDG_CONFIG_HOME=${expectedPaths.XDG_CONFIG_HOME}`,
    `XDG_CACHE_HOME=${expectedPaths.XDG_CACHE_HOME}`,
    `PLUGIN_DATA=${expectedPaths.PLUGIN_DATA}`,
    `PLUGIN_ROOT=${expectedPaths.PLUGIN_ROOT}`,
  ].join("\0") + "\0"), expectedPaths);
  assert.deepEqual(projection, {
    HOME: expectedPaths.HOME,
    CODEX_HOME: expectedPaths.CODEX_HOME,
    TMPDIR: null,
    XDG_CONFIG_HOME: expectedPaths.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: expectedPaths.XDG_CACHE_HOME,
    XDG_DATA_HOME: null,
    PLUGIN_DATA: expectedPaths.PLUGIN_DATA,
    PLUGIN_ROOT: expectedPaths.PLUGIN_ROOT,
  });
  assert.equal(JSON.stringify(projection).includes("/operator/private/mismatch"), false);
});
