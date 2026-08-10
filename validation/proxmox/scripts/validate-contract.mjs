#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../../..");
const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_IDENTITY_ARGUMENTS = Object.freeze([
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
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const GIT_OBJECT_FORMAT_WIDTH = Object.freeze({ sha1: 40, sha256: 64 });
const GIT_TREE_MANIFEST_DOMAIN = "nelos.proxmox.candidate-tree.git-ls-tree.v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const UBUNTU_APT_SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const EVIDENCE_REPOSITORY_INPUTS = Object.freeze([
  ".codex-plugin/plugin.json",
  "validation/proxmox/contract.json",
  "validation/proxmox/contract.schema.json",
  "validation/proxmox/toolchain.lock.json",
  "validation/proxmox/evidence/schema.json",
  "validation/proxmox/packer/versions.pkr.hcl",
  "validation/proxmox/packer/proxmox.pkr.hcl",
  "validation/proxmox/scripts/bootstrap-cloud-image-template.sh",
  "validation/proxmox/scripts/provision-guest.sh",
  "validation/proxmox/scripts/build-template.sh",
  "plugin.json",
  "mcp.json",
]);
const EVIDENCE_REPOSITORY_INPUT_BUFFERS = Object.freeze(
  EVIDENCE_REPOSITORY_INPUTS.map((path) => [path, Buffer.from(path, "ascii")]),
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function gitBuffer(root, argumentsList, maxBuffer = 256 * 1024 * 1024) {
  try {
    const { stdout } = await execFileAsync(GIT_EXECUTABLE, [...GIT_IDENTITY_ARGUMENTS, ...argumentsList], {
      cwd: root,
      encoding: null,
      maxBuffer,
      env: {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_REF_PARANOIA: "1",
      },
    });
    return Buffer.from(stdout);
  } catch {
    fail("/candidate", "exact Git checkout inspection failed");
  }
}

async function gitText(root, argumentsList) {
  return (await gitBuffer(root, argumentsList, 8 * 1024 * 1024)).toString("utf8");
}

async function rejectGitControlFile(root, gitPath, label) {
  const output = await gitText(root, ["rev-parse", "--git-path", gitPath]);
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
  if (lines.length !== 1 || lines[0] === "") {
    fail("/candidate/gitMetadata", `cannot resolve repository-local ${label} exactly`);
  }
  const controlPath = isAbsolute(lines[0]) ? lines[0] : resolve(root, lines[0]);
  let stats;
  try {
    stats = await lstat(controlPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("/candidate/gitMetadata", `cannot inspect repository-local ${label} exactly`);
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== 0) {
    fail("/candidate/gitMetadata", `repository-local ${label} must be absent or an empty regular file`);
  }
}

async function rejectUnsafeGitState(root) {
  // Preserve the archive controls for the future live-runner materialization path,
  // even though evidence identity uses the canonical recursive tree manifest below.
  const configParts = (await gitBuffer(root, [
    "config",
    "--includes",
    "--show-scope",
    "--name-only",
    "--null",
    "--list",
  ], 8 * 1024 * 1024)).toString("utf8").split("\0");
  if (configParts.at(-1) === "") configParts.pop();
  if (configParts.length % 2 !== 0) {
    fail("/candidate/archiveConfig", "cannot inspect repository Git configuration exactly");
  }
  for (let index = 0; index < configParts.length; index += 2) {
    const scope = configParts[index];
    const key = configParts[index + 1].toLowerCase();
    if ((scope === "local" || scope === "worktree") && key.startsWith("tar.")) {
      fail("/candidate/archiveConfig", "repository and worktree tar.* configuration is forbidden");
    }
    if (
      key === "extensions.partialclone"
      || /^remote\..+\.(?:promisor|partialclonefilter)$/u.test(key)
    ) {
      fail("/candidate/objectBackend", "partial-clone and promisor configuration is forbidden");
    }
  }
  await Promise.all([
    rejectGitControlFile(root, "info/attributes", "info/attributes"),
    rejectGitControlFile(root, "info/grafts", "info/grafts"),
    rejectGitControlFile(root, "objects/info/alternates", "objects/info/alternates"),
  ]);
  if (await gitText(root, ["for-each-ref", "--format=%(refname)", "refs/replace/"]) !== "") {
    fail("/candidate/replacements", "replacement refs are forbidden for evidence candidates");
  }
}

function inspectCanonicalGitTreeManifest(treeManifest, objectFormat) {
  const objectIdWidth = GIT_OBJECT_FORMAT_WIDTH[objectFormat];
  if (objectIdWidth === undefined) {
    fail("/candidate/objectFormat", "Git storage object format must be sha1 or sha256");
  }
  let hasGitAttributes = false;
  const trackedInputs = Object.create(null);
  let recordOffset = 0;
  while (recordOffset < treeManifest.length) {
    const recordEnd = treeManifest.indexOf(0, recordOffset);
    if (recordEnd === -1) {
      fail("/candidate/treeManifest", "Git tree manifest must contain complete NUL-delimited records");
    }
    const record = treeManifest.subarray(recordOffset, recordEnd);
    const pathSeparator = record.indexOf(0x09);
    if (pathSeparator <= 0 || pathSeparator === record.length - 1) {
      fail("/candidate/treeManifest", "Git tree manifest record shape is invalid");
    }
    const header = record.subarray(0, pathSeparator).toString("ascii");
    const headerMatch = /^(?<mode>[0-7]{6}) (?<type>blob|commit) (?<objectId>[a-f0-9]+)$/u.exec(header);
    if (headerMatch === null) {
      fail("/candidate/treeManifest", "Git tree manifest header is invalid");
    }
    const { mode, type, objectId } = headerMatch.groups;
    if (mode === "160000" || type === "commit") {
      fail("/candidate/gitlinks", "Gitlink and submodule entries are forbidden for evidence candidates");
    }
    if (mode === "120000") {
      fail("/candidate/symlinks", "Tracked symlink entries are forbidden for evidence candidates");
    }
    if (
      type !== "blob"
      || !["100644", "100755"].includes(mode)
      || objectId.length !== objectIdWidth
    ) {
      fail("/candidate/treeManifest", "Git tree manifest object metadata is invalid");
    }
    const path = record.subarray(pathSeparator + 1);
    for (const [repositoryPath, encodedPath] of EVIDENCE_REPOSITORY_INPUT_BUFFERS) {
      if (path.equals(encodedPath)) {
        trackedInputs[repositoryPath] = Object.freeze({ mode, objectId });
        break;
      }
    }
    const attributesName = Buffer.from(".gitattributes", "ascii");
    if (
      path.equals(attributesName)
      || (
        path.length > attributesName.length
        && path.at(-(attributesName.length + 1)) === 0x2f
        && path.subarray(-attributesName.length).equals(attributesName)
      )
    ) {
      hasGitAttributes = true;
    }
    recordOffset = recordEnd + 1;
  }
  return Object.freeze({
    hasGitAttributes,
    trackedInputs: Object.freeze(trackedInputs),
  });
}

async function inspectEvidenceCandidate(root) {
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    fail("/candidate", "repository root cannot be resolved exactly");
  }
  const discoveredRoot = (await gitText(canonicalRoot, ["rev-parse", "--show-toplevel"])).trim();
  let canonicalDiscoveredRoot;
  try {
    canonicalDiscoveredRoot = await realpath(discoveredRoot);
  } catch {
    fail("/candidate", "Git worktree root cannot be resolved exactly");
  }
  if (canonicalDiscoveredRoot !== canonicalRoot) {
    fail("/candidate", "repository root must be the exact Git worktree root");
  }
  await rejectUnsafeGitState(canonicalRoot);
  const status = await gitText(canonicalRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") fail("/candidate/dirty", "evidence requires an exactly clean Git checkout");
  const sourceRevision = (await gitText(
    canonicalRoot,
    ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
  )).trim();
  const objectFormat = (await gitText(
    canonicalRoot,
    ["rev-parse", "--show-object-format=storage"],
  )).trim();
  const objectIdWidth = GIT_OBJECT_FORMAT_WIDTH[objectFormat];
  if (objectIdWidth === undefined) {
    fail("/candidate/objectFormat", "Git storage object format must be sha1 or sha256");
  }
  if (!GIT_OBJECT_ID.test(sourceRevision) || sourceRevision.length !== objectIdWidth) {
    fail("/candidate/sourceRevision", "Git HEAD must resolve to a full lowercase object ID");
  }
  const treeManifest = await gitBuffer(
    canonicalRoot,
    ["ls-tree", "-r", "-z", "--full-tree", sourceRevision, "--"],
    256 * 1024 * 1024,
  );
  const { hasGitAttributes, trackedInputs } = inspectCanonicalGitTreeManifest(treeManifest, objectFormat);
  if (hasGitAttributes) {
    fail("/candidate/attributes", "tracked .gitattributes files require an explicit archive policy");
  }
  const manifestDomain = Buffer.from(
    `${GIT_TREE_MANIFEST_DOMAIN}\0objectFormat=${objectFormat}\0`,
    "ascii",
  );
  return Object.freeze({
    sourceRevision,
    treeSha256: sha256(Buffer.concat([manifestDomain, treeManifest])),
    trackedInputs,
  });
}

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

export async function validateRecipeSources(root, lock, repositoryIdentity = undefined) {
  const validationRoot = join(resolve(root), "validation", "proxmox");
  const readRecipeSource = async (relativePath, label) => {
    if (repositoryIdentity === undefined) {
      return readFile(join(validationRoot, relativePath), "utf8");
    }
    return (await readTrackedCandidateBytes(
      resolve(root),
      repositoryIdentity,
      `validation/proxmox/${relativePath}`,
      label,
    )).toString("utf8");
  };
  const [versions, proxmox, bootstrap, provisionGuest, buildWrapper] = await Promise.all([
    readRecipeSource("packer/versions.pkr.hcl", "Packer version contract"),
    readRecipeSource("packer/proxmox.pkr.hcl", "Packer Proxmox contract"),
    readRecipeSource("scripts/bootstrap-cloud-image-template.sh", "base template bootstrap"),
    readRecipeSource("scripts/provision-guest.sh", "validator guest provisioner"),
    readRecipeSource("scripts/build-template.sh", "template build wrapper"),
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
    "PATH=/usr/bin:/bin",
    "GIT_ATTR_NOSYSTEM=1",
    "GIT_GRAFT_FILE=/dev/null",
    "GIT_NO_LAZY_FETCH=1",
    "GIT_NO_REPLACE_OBJECTS=1",
    "GIT_REF_PARANOIA=1",
    "/usr/bin/git",
    "--no-replace-objects",
    "--literal-pathspecs",
    "--no-optional-locks",
    "-c core.useReplaceRefs=false",
    "-c core.attributesFile=/dev/null",
    "-c core.commitGraph=false",
    "-c core.multiPackIndex=false",
    "-c core.fsmonitor=false",
    "-c core.untrackedCache=false",
    '${git_common_dir}/info/grafts',
    '${git_common_dir}/objects/info/alternates',
    "extensions.partialclone",
    "remote.*.promisor",
    "remote.*.partialclonefilter",
    "git_readonly for-each-ref --format='%(refname)' refs/replace/",
    "git_readonly rev-parse --show-object-format=storage",
    "git_readonly rev-parse --verify --end-of-options 'HEAD^{commit}'",
    "GIT_OBJECT_ID_WIDTH=40",
    "GIT_OBJECT_ID_WIDTH=64",
    "sealed input must resolve to exactly one tree record",
    "git_readonly status --porcelain=v1 --untracked-files=all",
    'git_readonly hash-object --no-filters -- "$destination"',
  ]) {
    if (!buildWrapper.includes(sealedBuildControl)) {
      fail("/recipe/build-wrapper", `missing sealed build control: ${sealedBuildControl}`);
    }
  }
  return true;
}

export function createEvidenceProbe(contract, repositoryIdentity = {}) {
  const pluginVersion = repositoryIdentity.pluginVersion ?? "0.0.0";
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
      sourceRevision: repositoryIdentity.sourceRevision ?? "0".repeat(40),
      treeSha256: repositoryIdentity.treeSha256 ?? "1".repeat(64),
      dirty: false,
    },
    template: {
      templateVersion: contract.contractVersion,
      proxmoxVeVersion: contract.scope.proxmoxVeBaseline,
      operatingSystem: "ubuntu-24.04-lts",
      architecture: contract.scope.guest.architecture,
      contractSha256: repositoryIdentity.contractSha256 ?? "2".repeat(64),
      toolchainLockSha256: repositoryIdentity.toolchainLockSha256 ?? "3".repeat(64),
    },
    lanes: {
      "legacy-01446": {
        codexVersion: "0.144.6",
        freshProcess: true,
        home: "/var/lib/nelos-validator/runs/contract-probe/legacy-01446/home",
        codexHome: "/var/lib/nelos-validator/runs/contract-probe/legacy-01446/home/.codex",
        pluginVersion,
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
        pluginVersion,
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

export function validateEvidenceDocument(evidence, evidenceSchema, contract, repositoryIdentity = undefined) {
  assertOnlyLocalReferences(evidenceSchema);
  validateAgainstSchema(evidence, evidenceSchema);
  assertNoUserSpecificMaterial(evidence);
  if (evidence.contractVersion !== contract.contractVersion) {
    fail("/contractVersion", "must match the validator contract");
  }
  if (evidence.template.templateVersion !== contract.contractVersion) {
    fail("/template/templateVersion", "must match the validator contract version");
  }
  if (repositoryIdentity !== undefined) {
    for (const [field, repositoryFile] of [
      ["contractSha256", "contract.json"],
      ["toolchainLockSha256", "toolchain.lock.json"],
    ]) {
      if (Object.hasOwn(repositoryIdentity, field) && evidence.template[field] !== repositoryIdentity[field]) {
        fail(`/template/${field}`, `must match the SHA-256 digest of the repository ${repositoryFile} bytes`);
      }
    }
    for (const field of ["sourceRevision", "treeSha256"]) {
      if (Object.hasOwn(repositoryIdentity, field) && evidence.candidate[field] !== repositoryIdentity[field]) {
        fail(`/candidate/${field}`, "must match the exact clean repository checkout");
      }
    }
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
  if (repositoryIdentity !== undefined && Object.hasOwn(repositoryIdentity, "pluginVersion")) {
    for (const [laneId, lane] of Object.entries({
      "legacy-01446": legacy,
      "agent-plugin-01470": agent,
    })) {
      if (lane.pluginVersion !== repositoryIdentity.pluginVersion) {
        fail(`/lanes/${laneId}/pluginVersion`, "must match the exact candidate plugin manifest identity");
      }
    }
  }
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
    if (!lane.checks.marketplaceInstall && lane.checks.pluginInstall) {
      fail(`/lanes/${laneId}/checks/pluginInstall`, "cannot pass before marketplace installation succeeds");
    }
    if (!lane.checks.pluginInstall) {
      for (const downstreamCheck of ["mcpInitialize", "toolsList", "nelosConfigGet", "laneParity"]) {
        if (lane.checks[downstreamCheck]) {
          fail(`/lanes/${laneId}/checks/${downstreamCheck}`, "cannot pass before plugin installation succeeds");
        }
      }
      if (lane.toolNames.length !== 0) {
        fail(`/lanes/${laneId}/toolNames`, "must be empty when plugin installation did not succeed");
      }
    }
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
    if (evidence.result.status === "passed") {
      for (const environmentKey of contract.lanes[laneId].requiredEnvironment) {
        if (!lane.processObservation.observedEnvironmentKeys.includes(environmentKey)) {
          fail(`/lanes/${laneId}/processObservation/observedEnvironmentKeys`, `must include ${environmentKey}`);
        }
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

function parseJsonBytes(bytes, label) {
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail("", `${label} is not valid JSON`);
  }
}

async function readJsonWithBytes(path, label) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    fail("", `cannot read ${label}: ${error.message}`);
  }
  return parseJsonBytes(bytes, label);
}

async function readJson(path, label) {
  return (await readJsonWithBytes(path, label)).value;
}

async function readTrackedCandidateBytes(root, repositoryIdentity, repositoryPath, label) {
  const trackedInput = repositoryIdentity?.trackedInputs?.[repositoryPath];
  if (
    !isObject(trackedInput)
    || !["100644", "100755"].includes(trackedInput.mode)
    || typeof trackedInput.objectId !== "string"
  ) {
    fail(
      `/candidate/trackedInputs/${repositoryPath}`,
      `${label} must be a regular file tracked by the exact candidate revision`,
    );
  }
  return gitBuffer(root, ["cat-file", "blob", trackedInput.objectId], 16 * 1024 * 1024);
}

async function readCandidateJsonWithBytes(root, repositoryIdentity, repositoryPath, label) {
  if (repositoryIdentity === undefined) {
    return readJsonWithBytes(join(root, repositoryPath), label);
  }
  return parseJsonBytes(
    await readTrackedCandidateBytes(root, repositoryIdentity, repositoryPath, label),
    label,
  );
}

function validateCandidatePluginManifest(manifest) {
  if (!isObject(manifest)) fail("/candidate/pluginManifest", "must be an object");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    fail("/candidate/pluginManifest/version", "must be an exact semantic version");
  }
  const expectedBuildIdentity = `nelos-release-v1:${manifest.version}`;
  if (manifest.releaseBuildIdentity !== expectedBuildIdentity) {
    fail(
      "/candidate/pluginManifest/releaseBuildIdentity",
      `must equal ${expectedBuildIdentity}`,
    );
  }
  return Object.freeze({
    pluginVersion: manifest.version,
    releaseBuildIdentity: manifest.releaseBuildIdentity,
  });
}

function validateAgentPluginLayout(pluginManifest, mcpManifest, legacyPluginManifest) {
  const expectedPluginManifest = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: legacyPluginManifest.name,
    version: legacyPluginManifest.version,
    description: legacyPluginManifest.description,
    author: legacyPluginManifest.author,
    homepage: legacyPluginManifest.homepage,
    repository: legacyPluginManifest.repository,
    license: legacyPluginManifest.license,
    keywords: legacyPluginManifest.keywords,
  };
  if (!isDeepStrictEqual(pluginManifest, expectedPluginManifest)) {
    fail(
      "/candidate/agentPluginLayout/plugin.json",
      "must exactly match the candidate legacy plugin identity and Agent Plugins v1 schema",
    );
  }
  const expectedMcpManifest = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      nelos: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/bin/nelos-mcp"],
        env: {
          NELOS_PLUGIN_VERSION: legacyPluginManifest.version,
          NELOS_RELEASE_BUILD_IDENTITY: legacyPluginManifest.releaseBuildIdentity,
        },
      },
    },
  };
  if (!isDeepStrictEqual(mcpManifest, expectedMcpManifest)) {
    fail(
      "/candidate/agentPluginLayout/mcp.json",
      "must exactly launch the candidate MCP release through the Agent Plugins v1 schema",
    );
  }
}

export async function validateRepositoryContract(root = repositoryRoot, options = {}) {
  const resolvedRoot = resolve(root);
  const candidateCheckoutIdentity = options.evidencePath
    ? await inspectEvidenceCandidate(resolvedRoot)
    : undefined;
  const externalEvidence = options.evidencePath
    ? await readJson(resolve(options.evidencePath), "evidence")
    : undefined;
  const [
    contractDocument,
    contractSchemaDocument,
    toolchainLockDocument,
    evidenceSchemaDocument,
    pluginManifestDocument,
  ] =
    await Promise.all([
      readCandidateJsonWithBytes(
        resolvedRoot,
        candidateCheckoutIdentity,
        "validation/proxmox/contract.json",
        "contract.json",
      ),
      readCandidateJsonWithBytes(
        resolvedRoot,
        candidateCheckoutIdentity,
        "validation/proxmox/contract.schema.json",
        "contract.schema.json",
      ),
      readCandidateJsonWithBytes(
        resolvedRoot,
        candidateCheckoutIdentity,
        "validation/proxmox/toolchain.lock.json",
        "toolchain.lock.json",
      ),
      readCandidateJsonWithBytes(
        resolvedRoot,
        candidateCheckoutIdentity,
        "validation/proxmox/evidence/schema.json",
        "evidence/schema.json",
      ),
      readCandidateJsonWithBytes(
        resolvedRoot,
        candidateCheckoutIdentity,
        ".codex-plugin/plugin.json",
        ".codex-plugin/plugin.json",
      ),
    ]);
  const contract = contractDocument.value;
  const contractSchema = contractSchemaDocument.value;
  const toolchainLock = toolchainLockDocument.value;
  const evidenceSchema = evidenceSchemaDocument.value;
  const pluginManifest = pluginManifestDocument.value;
  const templateDigests = Object.freeze({
    contractSha256: sha256(contractDocument.bytes),
    toolchainLockSha256: sha256(toolchainLockDocument.bytes),
  });
  const candidatePluginIdentity = validateCandidatePluginManifest(pluginManifest);
  const repositoryInputs = Object.freeze({
    ...templateDigests,
    ...candidatePluginIdentity,
  });
  validateProxmoxContract(contract, contractSchema);
  validateToolchainLock(toolchainLock, contract);
  await validateRecipeSources(resolvedRoot, toolchainLock, candidateCheckoutIdentity);
  validateEvidenceDocument(createEvidenceProbe(contract, repositoryInputs), evidenceSchema, contract, repositoryInputs);
  if (options.evidencePath) {
    if (externalEvidence?.result?.status === "passed") {
      const [agentPluginManifest, agentMcpManifest] = await Promise.all([
        readCandidateJsonWithBytes(
          resolvedRoot,
          candidateCheckoutIdentity,
          "plugin.json",
          "Agent Plugins v1 plugin.json",
        ).then(({ value }) => value),
        readCandidateJsonWithBytes(
          resolvedRoot,
          candidateCheckoutIdentity,
          "mcp.json",
          "Agent Plugins v1 mcp.json",
        ).then(({ value }) => value),
      ]);
      validateAgentPluginLayout(agentPluginManifest, agentMcpManifest, pluginManifest);
    }
    const repositoryIdentity = Object.freeze({
      ...repositoryInputs,
      ...candidateCheckoutIdentity,
    });
    validateEvidenceDocument(
      createEvidenceProbe(contract, repositoryIdentity),
      evidenceSchema,
      contract,
      repositoryIdentity,
    );
    validateEvidenceDocument(
      externalEvidence,
      evidenceSchema,
      contract,
      repositoryIdentity,
    );
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
