#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonV1, sha256V1, validateGoldenImageReservationV1 } from "./build-golden-image.mjs";
import { createScopedAclBootstrapPlanV2 } from "./prepare-golden-builder.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const TOKEN_VALUE = /^[A-Za-z0-9._~-]{20,512}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PVEUM = "/usr/sbin/pveum";
const PVESH = "/usr/bin/pvesh";
const MAX_COMMAND_OUTPUT = 65_536;
const CLEANUP_RECEIPT_KIND = "nelos-golden-builder-acl-cleanup-receipt";
const CLEANUP_INTENT_KIND = "nelos-golden-builder-acl-cleanup-intent";

export class GoldenBuilderAclBootstrapError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "GoldenBuilderAclBootstrapError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) { throw new GoldenBuilderAclBootstrapError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${label} fields differ from the closed contract`);
  return value;
}

export function validateScopedAclBootstrapPlanV1(value, reservation, { now = Date.now(), allowExpired = false } = {}) {
  const expiry = Date.parse(reservation?.expiresAt);
  const validationNow = allowExpired && Number.isFinite(expiry) && Number.isSafeInteger(reservation?.maxBuildMs)
    ? Math.min(now, expiry - reservation.maxBuildMs - 120_001)
    : now;
  const admitted = validateGoldenImageReservationV1(reservation, { now: validationNow });
  const expected = createScopedAclBootstrapPlanV2(admitted, { now: validationNow });
  if (!plain(value) || canonicalJsonV1(value) !== canonicalJsonV1(expected)) fail("INVALID_CONTRACT", "ACL bootstrap plan differs from its sealed reservation");
  return value;
}

async function privateDirectory(path, expectedUid, label) {
  if (!isAbsolute(path) || resolve(path) !== path) fail("UNSAFE_PATH", `${label} must be an absolute canonical path`);
  const canonical = await realpath(path).catch(() => null);
  const info = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || canonical !== path || !info?.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid || (info.mode & 0o777) !== 0o700) {
    fail("UNSAFE_PATH", `${label} must be one caller-owned mode-0700 canonical directory`);
  }
  return canonical;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(path, bytes, expectedUid, mode = 0o400, { internal = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1_048_576 || !isAbsolute(path) || resolve(path) !== path || (!internal && basename(path).startsWith("."))) {
    fail("UNSAFE_PATH", "ACL bootstrap output path or content is invalid");
  }
  const parent = await privateDirectory(dirname(path), expectedUid, "ACL bootstrap output parent");
  const temporary = join(parent, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(mode); } finally { await handle.close(); }
  try {
    await link(temporary, path);
    await syncDirectory(parent);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function writeSecretExclusive(path, bytes, expectedUid) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1_048_576 || !isAbsolute(path) || resolve(path) !== path || basename(path).startsWith(".")) {
    fail("UNSAFE_PATH", "ACL token output path or content is invalid");
  }
  const parent = await privateDirectory(dirname(path), expectedUid, "ACL token output parent");
  const handle = await open(path, "wx", 0o400);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(0o400); } finally { await handle.close(); }
  await syncDirectory(parent);
}

async function writeAtomic(path, bytes, expectedUid, mode = 0o600, { internal = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1_048_576 || !isAbsolute(path) || resolve(path) !== path || (!internal && basename(path).startsWith("."))) {
    fail("UNSAFE_PATH", "ACL cleanup journal path or content is invalid");
  }
  const parent = await privateDirectory(dirname(path), expectedUid, "ACL cleanup journal parent");
  const temporary = join(parent, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(mode); } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    await syncDirectory(parent);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function readCanonicalInternal(path, expectedUid, label) {
  const canonical = await realpath(path).catch(() => null);
  const info = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || canonical !== path || !info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== expectedUid ||
      !new Set([0o400, 0o600]).has(info.mode & 0o777) || info.size < 2 || info.size > 1_048_576) {
    fail("UNSAFE_PATH", `${label} is not a private canonical regular file`);
  }
  const bytes = await readFile(canonical);
  let value;
  try { value = JSON.parse(bytes); } catch { fail("INVALID_CONTRACT", `${label} is not valid JSON`); }
  if (!bytes.equals(Buffer.from(`${canonicalJsonV1(value)}\n`))) fail("INVALID_CONTRACT", `${label} is not canonical JSON`);
  return value;
}

function defaultRunCommand({ argv, timeoutMs, maxOutputBytes }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    });
    const stdout = []; let stdoutLength = 0; let stderrLength = 0; let overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutLength += chunk.length;
      if (stdoutLength > maxOutputBytes) { overflow = true; child.kill("SIGKILL"); } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      if (stderrLength > maxOutputBytes) { overflow = true; child.kill("SIGKILL"); }
    });
    child.once("error", () => rejectPromise(new GoldenBuilderAclBootstrapError("COMMAND_FAILED", "bounded ACL command could not start")));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return rejectPromise(new GoldenBuilderAclBootstrapError("OUTPUT_LIMIT", "bounded ACL command exceeded its output limit"));
      if (code !== 0) return rejectPromise(new GoldenBuilderAclBootstrapError(signal ? "DEADLINE_EXPIRED" : "COMMAND_FAILED", "bounded ACL command failed"));
      resolvePromise(Buffer.concat(stdout));
    });
  });
}

async function boundedCommand(runCommand, argv, deadlineAt, { sensitive = false, clock = Date } = {}) {
  const timeoutMs = deadlineAt - clock.now();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) fail("DEADLINE_EXPIRED", "ACL bootstrap deadline expired");
  let output;
  try {
    output = await runCommand({ argv: [...argv], timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT, sensitive });
  } catch (error) {
    // Never propagate command output or provider error text: token creation errors
    // can contain the one-shot secret.
    throw new GoldenBuilderAclBootstrapError(error?.code === "DEADLINE_EXPIRED" ? "DEADLINE_EXPIRED" : "COMMAND_FAILED", "bounded ACL command failed");
  }
  if (!Buffer.isBuffer(output) || output.length > MAX_COMMAND_OUTPUT) fail("COMMAND_FAILED", "bounded ACL command returned an invalid response");
  return output;
}

async function jsonCommand(runCommand, argv, deadlineAt, options) {
  const bytes = await boundedCommand(runCommand, argv, deadlineAt, options);
  try { return { bytes, value: JSON.parse(bytes) }; }
  catch { bytes.fill(0); fail("PROVIDER_RESPONSE_INVALID", "bounded ACL command returned malformed JSON"); }
}

function validateNetworkPreflight(vnets, acls, plan) {
  if (!Array.isArray(vnets) || !Array.isArray(acls)) fail("PROVIDER_RESPONSE_INVALID", "Proxmox VNet or ACL inventory is malformed");
  const matches = vnets.filter((entry) => plain(entry) && entry.vnet === plan.network.vnet);
  const aclMatches = acls.filter((entry) => plain(entry) && entry.path === plan.network.aclPath);
  if (matches.length !== 1 || matches[0].zone !== plan.network.zone || Boolean(matches[0].pending) || aclMatches.length < 1 ||
      plan.network.vnet !== "nelosbld" || plan.network.zone !== "nelosbld" || plan.network.aclPath !== "/sdn/zones/nelosbld/nelosbld") {
    fail("VNET_IDENTITY_MISMATCH", "the exact active nelosbld zone and ACL path were not observed");
  }
  return {
    vnetInventoryDigest: sha256V1(vnets),
    aclInventoryDigest: sha256V1(acls),
  };
}

function expectedAclIdentities(plan) {
  const users = plan.tokenRequests.map(({ user }) => user).sort();
  const tokens = plan.tokenRequests.map(({ tokenId }) => tokenId).sort();
  const roles = plan.setupCommands.filter((argv) => argv.slice(0, 3).join("\0") === `${PVEUM}\0role\0add`).map((argv) => argv[3]).sort();
  const grants = plan.setupCommands.filter((argv) => argv.slice(0, 3).join("\0") === `${PVEUM}\0acl\0modify`).map((argv) => ({
    path: argv[3],
    role: argv[argv.indexOf("--roles") + 1],
    user: argv[argv.indexOf("--users") + 1],
  })).sort((left, right) => canonicalJsonV1(left).localeCompare(canonicalJsonV1(right)));
  if (new Set(users).size !== 2 || new Set(tokens).size !== 2 || roles.length !== 7 || grants.length !== 9 ||
      [...users, ...tokens, ...roles, ...grants.flatMap(({ path, role, user }) => [path, role, user])].some((value) => typeof value !== "string" || value.length < 1)) {
    fail("INVALID_CONTRACT", "ACL cleanup identities cannot be derived exactly from the sealed plan");
  }
  return { grants, roles, tokens, users };
}

function normalizeAclObservation({ users, roles, acls, tokenInventories }, plan) {
  if (!Array.isArray(users) || !Array.isArray(roles) || !Array.isArray(acls) || !plain(tokenInventories)) {
    fail("PROVIDER_RESPONSE_INVALID", "ACL cleanup inventories are malformed");
  }
  const expected = expectedAclIdentities(plan);
  const scopedUsers = expected.users.filter((user) => users.some((entry) => plain(entry) && entry.userid === user));
  const scopedRoles = expected.roles.filter((role) => roles.some((entry) => plain(entry) && entry.roleid === role));
  const scopedGrants = expected.grants.filter((grant) => acls.some((entry) => plain(entry) && entry.path === grant.path &&
    (entry.ugid === grant.user || entry.userid === grant.user || entry.user === grant.user) && entry.roleid === grant.role));
  const scopedTokens = expected.tokens.filter((tokenId) => {
    const separator = tokenId.indexOf("!"); const user = tokenId.slice(0, separator); const tokenName = tokenId.slice(separator + 1);
    const inventory = tokenInventories[user];
    return Array.isArray(inventory) && inventory.some((entry) => plain(entry) && (entry.tokenid === tokenName || entry.tokenid === tokenId || entry["full-tokenid"] === tokenId));
  });
  const content = {
    complete: true,
    grants: scopedGrants,
    roles: scopedRoles,
    tokens: scopedTokens,
    users: scopedUsers,
    inventoryDigest: sha256V1({ acls, roles, tokenInventories, users }),
  };
  return { ...content, observationDigest: sha256V1(content) };
}

function validateAclObservation(value, plan) {
  exact(value, ["complete", "grants", "inventoryDigest", "observationDigest", "roles", "tokens", "users"], "ACL cleanup observation");
  if (value.complete !== true || !SHA256.test(value.inventoryDigest ?? "") || !SHA256.test(value.observationDigest ?? "") ||
      !Array.isArray(value.users) || !Array.isArray(value.tokens) || !Array.isArray(value.roles) || !Array.isArray(value.grants)) {
    fail("PROVIDER_RESPONSE_INVALID", "ACL cleanup observation is incomplete");
  }
  const expected = expectedAclIdentities(plan);
  for (const [key, allowed] of [["users", expected.users], ["tokens", expected.tokens], ["roles", expected.roles]]) {
    if (value[key].some((entry) => typeof entry !== "string" || !allowed.includes(entry)) ||
        value[key].join("\0") !== [...value[key]].sort().join("\0") || new Set(value[key]).size !== value[key].length) {
      fail("PROVIDER_RESPONSE_INVALID", `ACL cleanup ${key} observation is ambiguous`);
    }
  }
  for (const grant of value.grants) {
    exact(grant, ["path", "role", "user"], "ACL cleanup grant");
    if (!expected.grants.some((item) => canonicalJsonV1(item) === canonicalJsonV1(grant))) fail("PROVIDER_RESPONSE_INVALID", "ACL cleanup grant is outside the sealed plan");
  }
  if (value.grants.map(canonicalJsonV1).join("\0") !== [...value.grants].map(canonicalJsonV1).sort().join("\0") ||
      new Set(value.grants.map(canonicalJsonV1)).size !== value.grants.length) fail("PROVIDER_RESPONSE_INVALID", "ACL cleanup grants are ambiguous");
  const { observationDigest, ...content } = value;
  if (observationDigest !== sha256V1(content)) fail("PROVIDER_RESPONSE_INVALID", "ACL cleanup observation digest differs");
  return value;
}

async function defaultObserveAccess({ plan, deadlineAt, clock = Date }) {
  const [usersResult, rolesResult, aclResult] = await Promise.all([
    jsonCommand(defaultRunCommand, [PVESH, "get", "/access/users", "--output-format", "json"], deadlineAt, { clock }),
    jsonCommand(defaultRunCommand, [PVESH, "get", "/access/roles", "--output-format", "json"], deadlineAt, { clock }),
    jsonCommand(defaultRunCommand, [PVESH, "get", "/access/acl", "--output-format", "json"], deadlineAt, { clock }),
  ]);
  const tokenInventories = {};
  try {
    const expected = expectedAclIdentities(plan);
    for (const user of expected.users) {
      if (usersResult.value.some((entry) => plain(entry) && entry.userid === user)) {
        const result = await jsonCommand(defaultRunCommand, [PVESH, "get", `/access/users/${user}/token`, "--output-format", "json"], deadlineAt, { clock });
        try { tokenInventories[user] = result.value; } finally { result.bytes.fill(0); }
      } else tokenInventories[user] = [];
    }
    return normalizeAclObservation({ users: usersResult.value, roles: rolesResult.value, acls: aclResult.value, tokenInventories }, plan);
  } finally {
    usersResult.bytes.fill(0); rolesResult.bytes.fill(0); aclResult.bytes.fill(0);
  }
}

function tokenValue(response, request) {
  exact(response, ["full-tokenid", "info", "value"], "token response");
  if (!plain(response.info) || !new Set(["privsep", "expire\0privsep"]).has(Object.keys(response.info).sort().join("\0")) ||
      response["full-tokenid"] !== request.tokenId || ![1, "1", true].includes(response.info.privsep) ||
      typeof response.value !== "string" || !TOKEN_VALUE.test(response.value)) {
    fail("TOKEN_RESPONSE_INVALID", "Proxmox returned an invalid token identity or value");
  }
  return response.value;
}

function intentFor(plan, startedAt) {
  return {
    schemaVersion: 1,
    kind: "nelos-golden-builder-acl-bootstrap-intent",
    planDigest: plan.planDigest,
    reservationDigest: plan.reservationDigest,
    startedAt,
  };
}

function intentPath(tokenRoot, plan) { return join(tokenRoot, `.acl-bootstrap-${plan.planDigest.slice(7)}.intent.json`); }
function cleanupIntentPath(tokenRoot, plan) { return join(tokenRoot, `.acl-cleanup-${plan.planDigest.slice(7)}.intent.json`); }

function cleanupActions(plan, tokenRoot) {
  return [
    ...plan.rollbackCommands.map((argv, index) => ({ kind: "provider", index, argv, actionDigest: sha256V1({ kind: "provider", index, argv }) })),
    ...plan.tokenRequests.map((request, offset) => {
      const index = plan.rollbackCommands.length + offset;
      const path = join(tokenRoot, request.outputName);
      return { kind: "local-token-file", index, path, tokenKind: request.kind, actionDigest: sha256V1({ kind: "local-token-file", index, path, tokenKind: request.kind }) };
    }),
  ];
}

function providerActionPresent(action, observation) {
  const argv = action.argv;
  if (argv.slice(0, 4).join("\0") === `${PVEUM}\0user\0token\0remove`) return observation.tokens.includes(`${argv[4]}!${argv[5]}`);
  if (argv.slice(0, 3).join("\0") === `${PVEUM}\0acl\0delete`) {
    const target = { path: argv[3], role: argv[argv.indexOf("--roles") + 1], user: argv[argv.indexOf("--users") + 1] };
    return observation.grants.some((grant) => canonicalJsonV1(grant) === canonicalJsonV1(target));
  }
  if (argv.slice(0, 3).join("\0") === `${PVEUM}\0user\0delete`) return observation.users.includes(argv[3]);
  if (argv.slice(0, 3).join("\0") === `${PVEUM}\0role\0delete`) return observation.roles.includes(argv[3]);
  fail("INVALID_CONTRACT", "ACL cleanup action is outside the closed command set");
}

async function tokenFileState(path, expectedUid) {
  const info = await lstat(path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return "absent";
  const canonical = await realpath(path).catch(() => null);
  if (!canonical || canonical !== path || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== expectedUid || (info.mode & 0o777) !== 0o400) {
    fail("UNSAFE_TOKEN_FILE", "ACL token file identity, ownership, mode, or link count differs");
  }
  return "present";
}

async function observeCleanupState({ actions, plan, observeAccess, deadlineAt, clock, expectedUid }) {
  const access = validateAclObservation(await observeAccess({ plan, deadlineAt, clock }), plan);
  const tokenFiles = [];
  for (const action of actions.filter(({ kind }) => kind === "local-token-file")) {
    tokenFiles.push({ kind: action.tokenKind, path: action.path, state: await tokenFileState(action.path, expectedUid) });
  }
  const state = { access, tokenFiles };
  return { ...state, stateDigest: sha256V1(state) };
}

function cleanupActionPresent(action, state) {
  if (action.kind === "provider") return providerActionPresent(action, state.access);
  return state.tokenFiles.some((entry) => entry.path === action.path && entry.kind === action.tokenKind && entry.state === "present");
}

function cleanupIntent({ plan, receiptPath, startedAt, nextIndex, beforeInventoryDigest, lastStateDigest, pendingAction }) {
  return {
    schemaVersion: 1,
    kind: CLEANUP_INTENT_KIND,
    planDigest: plan.planDigest,
    reservationDigest: plan.reservationDigest,
    receiptPath,
    startedAt,
    nextIndex,
    beforeInventoryDigest,
    lastStateDigest,
    pendingAction,
  };
}

function validateCleanupIntent(value, { plan, receiptPath, actionCount }) {
  exact(value, ["beforeInventoryDigest", "kind", "lastStateDigest", "nextIndex", "pendingAction", "planDigest", "receiptPath", "reservationDigest", "schemaVersion", "startedAt"], "ACL cleanup intent");
  if (value.schemaVersion !== 1 || value.kind !== CLEANUP_INTENT_KIND || value.planDigest !== plan.planDigest || value.reservationDigest !== plan.reservationDigest ||
      value.receiptPath !== receiptPath || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isSafeInteger(value.nextIndex) || value.nextIndex < 0 || value.nextIndex > actionCount ||
      !SHA256.test(value.beforeInventoryDigest ?? "") || !SHA256.test(value.lastStateDigest ?? "")) fail("INVALID_CONTRACT", "ACL cleanup intent differs from the sealed lifecycle");
  if (value.pendingAction !== null) {
    exact(value.pendingAction, ["actionDigest", "index"], "ACL cleanup pending action");
    if (value.pendingAction.index !== value.nextIndex || !SHA256.test(value.pendingAction.actionDigest ?? "")) fail("INVALID_CONTRACT", "ACL cleanup pending action differs");
  }
  return value;
}

function validateCleanupReceipt(value, { plan, receiptPath, actions }) {
  exact(value, ["actionCount", "afterInventoryDigest", "beforeInventoryDigest", "completedAt", "kind", "observer", "planDigest", "receiptDigest", "removedTokenFiles", "reservationDigest", "schemaVersion", "startedAt"], "ACL cleanup receipt");
  if (value.schemaVersion !== 1 || value.kind !== CLEANUP_RECEIPT_KIND || value.planDigest !== plan.planDigest || value.reservationDigest !== plan.reservationDigest ||
      value.actionCount !== actions.length || value.observer !== "independent-root-pvesh-readback-v1" || !Number.isFinite(Date.parse(value.startedAt)) ||
      !Number.isFinite(Date.parse(value.completedAt)) || !SHA256.test(value.beforeInventoryDigest ?? "") || !SHA256.test(value.afterInventoryDigest ?? "")) {
    fail("INVALID_CONTRACT", "ACL cleanup receipt identity differs");
  }
  const expectedFiles = actions.filter(({ kind }) => kind === "local-token-file").map(({ path, tokenKind }) => ({ kind: tokenKind, path }));
  if (canonicalJsonV1(value.removedTokenFiles) !== canonicalJsonV1(expectedFiles)) fail("INVALID_CONTRACT", "ACL cleanup receipt token-file metadata differs");
  const { receiptDigest, ...unsigned } = value;
  if (receiptDigest !== sha256V1(unsigned) || !isAbsolute(receiptPath)) fail("INVALID_CONTRACT", "ACL cleanup receipt digest differs");
  return value;
}

async function readExistingCleanupReceipt(receiptPath, expectedUid, context) {
  const exists = await lstat(receiptPath).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
  if (!exists) return null;
  return validateCleanupReceipt(await readCanonicalInternal(receiptPath, expectedUid, "ACL cleanup receipt"), context);
}

function cleanupIsTerminal(state) {
  return state.access.users.length === 0 && state.access.tokens.length === 0 && state.access.roles.length === 0 && state.access.grants.length === 0 &&
    state.tokenFiles.every(({ state: fileState }) => fileState === "absent");
}

export async function cleanupScopedAclBootstrapV1({ reservation, plan: inputPlan, tokenRoot, receiptPath, authorizePlan }, {
  runCommand = defaultRunCommand, observeAccess = defaultObserveAccess, checkpoint = async () => {}, clock = Date, expectedUid = process.getuid(), operationTimeoutMs = 300_000,
} = {}) {
  if (typeof runCommand !== "function" || typeof observeAccess !== "function" || typeof checkpoint !== "function" || typeof clock?.now !== "function" ||
      !Number.isSafeInteger(expectedUid) || expectedUid < 0 || !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1_000 || operationTimeoutMs > 300_000) {
    fail("INVALID_ADAPTER", "ACL cleanup execution boundaries are invalid");
  }
  const now = clock.now();
  validateGoldenImageReservationV1(reservation, { now, allowExpiredForCleanup: true });
  const plan = validateScopedAclBootstrapPlanV1(inputPlan, reservation, { now, allowExpired: true });
  if (authorizePlan !== plan.planDigest) fail("MUTATION_AUTHORIZATION_REQUIRED", "ACL cleanup requires the exact plan digest");
  const canonicalRoot = await privateDirectory(tokenRoot, expectedUid, "token root");
  if (!isAbsolute(receiptPath) || resolve(receiptPath) !== receiptPath || basename(receiptPath).startsWith(".")) fail("UNSAFE_PATH", "ACL cleanup receipt path must be an explicit absolute path");
  await privateDirectory(dirname(receiptPath), expectedUid, "ACL cleanup receipt parent");
  const actions = cleanupActions(plan, canonicalRoot);
  const path = cleanupIntentPath(canonicalRoot, plan);
  const deadlineAt = Math.min(Date.parse(reservation.cleanupExpiresAt), now + operationTimeoutMs);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= now) fail("DEADLINE_EXPIRED", "ACL cleanup authorization has expired");
  let intent;
  const existingIntent = await lstat(path).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
  if (existingIntent) {
    intent = validateCleanupIntent(await readCanonicalInternal(path, expectedUid, "ACL cleanup intent"), { plan, receiptPath, actionCount: actions.length });
  } else {
    const existingReceipt = await readExistingCleanupReceipt(receiptPath, expectedUid, { plan, receiptPath, actions });
    if (existingReceipt) {
      const terminal = await observeCleanupState({ actions, plan, observeAccess, deadlineAt, clock, expectedUid });
      if (!cleanupIsTerminal(terminal)) fail("ACL_RECONCILIATION_REQUIRED", "ACL cleanup receipt no longer has an independent terminal postcondition");
      return existingReceipt;
    }
    const initial = await observeCleanupState({ actions, plan, observeAccess, deadlineAt, clock, expectedUid });
    intent = cleanupIntent({
      plan, receiptPath, startedAt: new Date(now).toISOString(), nextIndex: 0,
      beforeInventoryDigest: initial.access.inventoryDigest, lastStateDigest: initial.stateDigest, pendingAction: null,
    });
    await writeExclusive(path, Buffer.from(`${canonicalJsonV1(intent)}\n`), expectedUid, 0o600, { internal: true });
  }

  const committedReceipt = await readExistingCleanupReceipt(receiptPath, expectedUid, { plan, receiptPath, actions });
  if (committedReceipt) {
    const terminal = await observeCleanupState({ actions, plan, observeAccess, deadlineAt, clock, expectedUid });
    if (!cleanupIsTerminal(terminal)) fail("ACL_RECONCILIATION_REQUIRED", "committed ACL cleanup lacks its independent terminal postcondition");
    await unlink(path); await syncDirectory(canonicalRoot);
    return committedReceipt;
  }

  for (let index = intent.nextIndex; index < actions.length; index += 1) {
    const action = actions[index];
    if (action.index !== index) fail("INVALID_CONTRACT", "ACL cleanup action sequence differs");
    const before = await observeCleanupState({ actions, plan, observeAccess, deadlineAt, clock, expectedUid });
    intent = cleanupIntent({ ...intent, plan, receiptPath, nextIndex: index, lastStateDigest: before.stateDigest, pendingAction: { index, actionDigest: action.actionDigest } });
    await writeAtomic(path, Buffer.from(`${canonicalJsonV1(intent)}\n`), expectedUid, 0o600, { internal: true });
    await checkpoint({ phase: "action-authorized", index, actionDigest: action.actionDigest });
    if (cleanupActionPresent(action, before)) {
      if (action.kind === "provider") (await boundedCommand(runCommand, action.argv, deadlineAt, { clock })).fill(0);
      else { await unlink(action.path); await syncDirectory(canonicalRoot); }
      await checkpoint({ phase: "effect-returned", index, actionDigest: action.actionDigest });
    }
    const after = await observeCleanupState({ actions, plan, observeAccess, deadlineAt, clock, expectedUid });
    if (cleanupActionPresent(action, after)) fail("ACL_RECONCILIATION_REQUIRED", "ACL cleanup action did not reach its exact absent postcondition");
    intent = cleanupIntent({ ...intent, plan, receiptPath, nextIndex: index + 1, lastStateDigest: after.stateDigest, pendingAction: null });
    await writeAtomic(path, Buffer.from(`${canonicalJsonV1(intent)}\n`), expectedUid, 0o600, { internal: true });
  }

  const terminal = await observeCleanupState({ actions, plan, observeAccess, deadlineAt, clock, expectedUid });
  if (!cleanupIsTerminal(terminal)) fail("ACL_RECONCILIATION_REQUIRED", "scoped ACL identities or local token files remain after cleanup");
  const unsigned = {
    schemaVersion: 1,
    kind: CLEANUP_RECEIPT_KIND,
    planDigest: plan.planDigest,
    reservationDigest: plan.reservationDigest,
    observer: "independent-root-pvesh-readback-v1",
    actionCount: actions.length,
    beforeInventoryDigest: intent.beforeInventoryDigest,
    afterInventoryDigest: terminal.access.inventoryDigest,
    startedAt: intent.startedAt,
    completedAt: new Date(clock.now()).toISOString(),
    removedTokenFiles: actions.filter(({ kind }) => kind === "local-token-file").map(({ path: filePath, tokenKind }) => ({ kind: tokenKind, path: filePath })),
  };
  const receipt = { ...unsigned, receiptDigest: sha256V1(unsigned) };
  await writeExclusive(receiptPath, Buffer.from(`${canonicalJsonV1(receipt)}\n`), expectedUid, 0o400);
  await checkpoint({ phase: "receipt-committed", index: actions.length, actionDigest: receipt.receiptDigest });
  await unlink(path); await syncDirectory(canonicalRoot);
  return receipt;
}

async function rollback({ plan, tokenRoot, runCommand, deadlineAt, expectedUid, clock }) {
  let complete = true;
  for (const command of plan.rollbackCommands) {
    try { (await boundedCommand(runCommand, command, deadlineAt, { clock })).fill(0); } catch { complete = false; }
  }
  for (const request of plan.tokenRequests) {
    const target = join(tokenRoot, request.outputName);
    try { await unlink(target); } catch (error) { if (error?.code !== "ENOENT") complete = false; }
  }
  try { await syncDirectory(await privateDirectory(tokenRoot, expectedUid, "token root")); } catch { complete = false; }
  return complete;
}

export async function executeScopedAclBootstrapV1({ reservation, plan: inputPlan, tokenRoot, receiptPath, authorizePlan }, {
  runCommand = defaultRunCommand, clock = Date, expectedUid = process.getuid(), operationTimeoutMs = 120_000,
} = {}) {
  if (typeof runCommand !== "function" || typeof clock?.now !== "function" || !Number.isSafeInteger(expectedUid) || expectedUid < 0 ||
      !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1_000 || operationTimeoutMs > 300_000) fail("INVALID_ADAPTER", "ACL bootstrap execution boundary is invalid");
  const now = clock.now();
  const plan = validateScopedAclBootstrapPlanV1(inputPlan, reservation, { now });
  if (authorizePlan !== plan.planDigest) fail("MUTATION_AUTHORIZATION_REQUIRED", "ACL bootstrap requires the exact plan digest");
  const canonicalRoot = await privateDirectory(tokenRoot, expectedUid, "token root");
  if (!isAbsolute(receiptPath) || resolve(receiptPath) !== receiptPath) fail("UNSAFE_PATH", "receipt path must be absolute and canonical");
  await privateDirectory(dirname(receiptPath), expectedUid, "receipt parent");
  const intent = intentPath(canonicalRoot, plan);
  if (await lstat(intent).then(() => true, () => false)) fail("ACL_RECONCILIATION_REQUIRED", "an unfinished ACL bootstrap intent requires explicit reconciliation");
  for (const request of plan.tokenRequests) if (await lstat(join(canonicalRoot, request.outputName)).then(() => true, () => false)) fail("TOKEN_FILE_EXISTS", "a token output already exists");
  const deadlineAt = Math.min(Date.parse(plan.expiresAt), now + operationTimeoutMs);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= now) fail("DEADLINE_EXPIRED", "ACL bootstrap plan has expired");
  const startedAt = new Date(now).toISOString();
  const [vnetResult, aclResult] = await Promise.all([
    jsonCommand(runCommand, [PVESH, "get", "/cluster/sdn/vnets", "--output-format", "json"], deadlineAt, { clock }),
    jsonCommand(runCommand, [PVESH, "get", "/access/acl", "--output-format", "json"], deadlineAt, { clock }),
  ]);
  let network;
  try { network = validateNetworkPreflight(vnetResult.value, aclResult.value, plan); }
  finally { vnetResult.bytes.fill(0); aclResult.bytes.fill(0); }
  await writeExclusive(intent, Buffer.from(`${canonicalJsonV1(intentFor(plan, startedAt))}\n`), expectedUid, 0o400, { internal: true });
  let mutationStarted = false;
  let receiptCommitted = false;
  try {
    mutationStarted = true;
    for (const command of plan.setupCommands) (await boundedCommand(runCommand, command, deadlineAt, { clock })).fill(0);
    const secrets = new Set();
    for (const request of plan.tokenRequests) {
      const result = await jsonCommand(runCommand, [PVEUM, "user", "token", "add", request.user, request.tokenName, "--privsep", "1", "--output-format", "json"], deadlineAt, { sensitive: true, clock });
      let secretBytes;
      try {
        const secret = tokenValue(result.value, request);
        if (secrets.has(secret)) fail("TOKEN_RESPONSE_INVALID", "Proxmox returned duplicate token values");
        secrets.add(secret);
        secretBytes = Buffer.from(`${secret}\n`);
        const target = join(canonicalRoot, request.outputName);
        await writeSecretExclusive(target, secretBytes, expectedUid);
        result.value.value = null;
      } finally {
        result.bytes.fill(0);
        secretBytes?.fill(0);
      }
    }
    const unsigned = {
      schemaVersion: 1,
      kind: "nelos-golden-builder-acl-bootstrap-receipt",
      planDigest: plan.planDigest,
      reservationDigest: plan.reservationDigest,
      vnetInventoryDigest: network.vnetInventoryDigest,
      aclInventoryDigest: network.aclInventoryDigest,
      startedAt,
      completedAt: new Date(clock.now()).toISOString(),
      tokenFiles: plan.tokenRequests.map((request) => ({ kind: request.kind, tokenId: request.tokenId, path: join(canonicalRoot, request.outputName), mode: "0400" })),
    };
    const receipt = { ...unsigned, receiptDigest: sha256V1(unsigned) };
    await writeExclusive(receiptPath, Buffer.from(`${canonicalJsonV1(receipt)}\n`), expectedUid, 0o400);
    receiptCommitted = true;
    await unlink(intent);
    await syncDirectory(canonicalRoot);
    return receipt;
  } catch {
    if (receiptCommitted) throw new GoldenBuilderAclBootstrapError("ACL_RECONCILIATION_REQUIRED", "ACL bootstrap committed but journal finalization is incomplete");
    const restored = mutationStarted && await rollback({ plan, tokenRoot: canonicalRoot, runCommand, deadlineAt, expectedUid, clock });
    if (restored) { await unlink(intent).catch(() => {}); await syncDirectory(canonicalRoot).catch(() => {}); }
    throw new GoldenBuilderAclBootstrapError(restored ? "ACL_BOOTSTRAP_ROLLED_BACK" : "ACL_RECONCILIATION_REQUIRED", restored ? "ACL bootstrap failed and all scoped identities were rolled back" : "ACL bootstrap failed and exact rollback is unproven");
  }
}

export async function reconcileScopedAclBootstrapV1({ reservation, plan: inputPlan, tokenRoot, authorizePlan }, {
  runCommand = defaultRunCommand, clock = Date, expectedUid = process.getuid(), operationTimeoutMs = 120_000,
} = {}) {
  const now = clock.now();
  const plan = validateScopedAclBootstrapPlanV1(inputPlan, reservation, { now, allowExpired: true });
  if (authorizePlan !== plan.planDigest) fail("MUTATION_AUTHORIZATION_REQUIRED", "ACL reconciliation requires the exact plan digest");
  const canonicalRoot = await privateDirectory(tokenRoot, expectedUid, "token root");
  const intent = intentPath(canonicalRoot, plan);
  if (!(await lstat(intent).then(() => true, () => false))) fail("NO_RECONCILIATION_INTENT", "no matching unfinished ACL bootstrap intent exists");
  const deadlineAt = now + operationTimeoutMs;
  if (!(await rollback({ plan, tokenRoot: canonicalRoot, runCommand, deadlineAt, expectedUid, clock }))) fail("ACL_RECONCILIATION_REQUIRED", "exact ACL rollback remains unproven");
  await unlink(intent); await syncDirectory(canonicalRoot);
  return { schemaVersion: 1, state: "rolled-back", planDigest: plan.planDigest, completedAt: new Date(clock.now()).toISOString() };
}

async function sealedJson(path, label) {
  if (!isAbsolute(path) || resolve(path) !== path) fail("UNSAFE_PATH", `${label} path must be absolute and canonical`);
  const canonical = await realpath(path).catch(() => null); const info = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || canonical !== path || !info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !new Set([0o400, 0o440, 0o600, 0o640]).has(info.mode & 0o777)) fail("UNSAFE_PATH", `${label} is not a sealed regular file`);
  const bytes = await readFile(canonical);
  let value;
  try { value = JSON.parse(bytes); } catch { fail("INVALID_CONTRACT", `${label} is not valid JSON`); }
  if (!bytes.equals(Buffer.from(`${canonicalJsonV1(value)}\n`))) fail("INVALID_CONTRACT", `${label} is not canonical JSON`);
  return value;
}

function parseArgs(argv) {
  const options = {}; let reconcile = false; let cleanup = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--reconcile") { reconcile = true; continue; }
    if (argv[index] === "--cleanup") { cleanup = true; continue; }
    const value = argv[index + 1];
    if (!value || !new Set(["--reservation", "--plan", "--token-root", "--receipt", "--authorize-plan"]).has(argv[index]) || options[argv[index]]) fail("INVALID_OPERATION", "ACL bootstrap arguments are invalid");
    options[argv[index]] = value; index += 1;
  }
  if (reconcile && cleanup) fail("INVALID_OPERATION", "ACL reconciliation and successful-run cleanup are distinct operations");
  const required = reconcile ? ["--authorize-plan", "--plan", "--reservation", "--token-root"] : ["--authorize-plan", "--plan", "--receipt", "--reservation", "--token-root"];
  if (Object.keys(options).sort().join("\0") !== required.sort().join("\0")) fail("INVALID_OPERATION", "ACL bootstrap arguments are incomplete");
  return { cleanup, options, reconcile };
}

async function cli() {
  if (process.getuid() !== 0) fail("ROOT_REQUIRED", "ACL bootstrap must run as root on the pinned Proxmox host");
  const { cleanup, options, reconcile } = parseArgs(process.argv.slice(2));
  const [reservation, plan] = await Promise.all([sealedJson(options["--reservation"], "reservation"), sealedJson(options["--plan"], "ACL plan")]);
  const input = { reservation, plan, tokenRoot: options["--token-root"], authorizePlan: options["--authorize-plan"] };
  const result = reconcile ? await reconcileScopedAclBootstrapV1(input) : cleanup ?
    await cleanupScopedAclBootstrapV1({ ...input, receiptPath: options["--receipt"] }) :
    await executeScopedAclBootstrapV1({ ...input, receiptPath: options["--receipt"] });
  process.stdout.write(`${canonicalJsonV1(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) cli().catch((error) => {
  process.stderr.write(`${canonicalJsonV1({ error: error?.code ?? "ACL_BOOTSTRAP_FAILED", message: error?.message ?? "ACL bootstrap failed" })}\n`);
  process.exitCode = 1;
});
