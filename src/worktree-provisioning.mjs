import { execFile as executeFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { assertNoSymlinkComponents } from "./path-safety.mjs";
import {
  taskStateDirectory,
  withRepositoryProvisioningLock,
} from "./task-state.mjs";

const execFile = promisify(executeFile);

export const WORKTREE_RECEIPT_SCHEMA_VERSION = 1;
export const WORKTREE_RECEIPT_STATES = Object.freeze([
  "provisioning",
  "provisioned",
  "attention",
]);

const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ACTION_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_BRANCH_LENGTH = 255;
const ACTION_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const WORK_UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ATTENTION_CODES = new Set([
  "interrupted-provisioning",
  "verification-failed",
  "git-command-failed",
]);

export class WorktreeProvisioningError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "WorktreeProvisioningError";
    this.code = code;
  }
}

function assertNonemptyString(value, field, maximum = MAX_IDENTIFIER_LENGTH) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function assertActionId(value) {
  if (typeof value !== "string" || !ACTION_ID_PATTERN.test(value)) {
    throw new Error("actionId has an invalid format");
  }
  return value;
}

function assertWorkUnitId(value) {
  if (typeof value !== "string" || !WORK_UNIT_ID_PATTERN.test(value)) {
    throw new Error("workUnitId has an invalid format");
  }
  return value;
}

function assertAbsolutePath(value, field) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_PATH_LENGTH ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} must be an absolute path`);
  }
  return resolve(value);
}

function assertBranch(value) {
  const branch = assertNonemptyString(value, "branch", MAX_BRANCH_LENGTH);
  if (/\s/u.test(branch) || branch.startsWith("-")) {
    throw new Error("branch has an invalid format");
  }
  return branch;
}

function isIsoTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function receiptFileName(actionId) {
  return `${createHash("sha256").update(actionId).digest("hex")}.json`;
}

export function worktreeReceiptDirectory() {
  return resolve(taskStateDirectory(), "worktree-receipts");
}

export function repositoryIdForCommonGitDir(commonGitDir) {
  return createHash("sha256")
    .update(assertAbsolutePath(commonGitDir, "commonGitDir"))
    .digest("hex");
}

function normalizeReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("worktree receipt must be a JSON object");
  }
  const fields = new Set([
    "schemaVersion",
    "actionId",
    "workUnitId",
    "ownerTaskId",
    "repositoryId",
    "commonGitDir",
    "sourceWorktreePath",
    "worktreePath",
    "branch",
    "baseCommit",
    "operation",
    "state",
    "attentionCode",
    "createdAt",
    "updatedAt",
  ]);
  const unknown = Object.keys(value)
    .filter((field) => !fields.has(field))
    .sort(compareStrings);
  if (unknown.length) throw new Error(`worktree receipt contains unknown field: ${unknown[0]}`);
  if (value.schemaVersion !== WORKTREE_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`worktree receipt schemaVersion must be ${WORKTREE_RECEIPT_SCHEMA_VERSION}`);
  }
  const operation = value.operation;
  if (!["create", "adopt"].includes(operation)) {
    throw new Error("worktree receipt operation must be create or adopt");
  }
  if (!WORKTREE_RECEIPT_STATES.includes(value.state)) {
    throw new Error("worktree receipt state is invalid");
  }
  const attentionCode = value.attentionCode;
  if (value.state === "attention") {
    if (!ATTENTION_CODES.has(attentionCode)) {
      throw new Error("attention receipts require a known attentionCode");
    }
  } else if (attentionCode !== null) {
    throw new Error("non-attention receipts must not have attentionCode");
  }
  if (
    typeof value.repositoryId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.repositoryId)
  ) {
    throw new Error("repositoryId has an invalid format");
  }
  if (typeof value.baseCommit !== "string" || !/^[a-f0-9]{40,64}$/u.test(value.baseCommit)) {
    throw new Error("baseCommit has an invalid format");
  }
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) {
    throw new Error("receipt timestamps must be ISO timestamps");
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new Error("receipt updatedAt must not precede createdAt");
  }
  const commonGitDir = assertAbsolutePath(value.commonGitDir, "commonGitDir");
  if (repositoryIdForCommonGitDir(commonGitDir) !== value.repositoryId) {
    throw new Error("repositoryId does not match commonGitDir");
  }
  return {
    schemaVersion: WORKTREE_RECEIPT_SCHEMA_VERSION,
    actionId: assertActionId(value.actionId),
    workUnitId: assertWorkUnitId(value.workUnitId),
    ownerTaskId: assertNonemptyString(value.ownerTaskId, "ownerTaskId"),
    repositoryId: value.repositoryId,
    commonGitDir,
    sourceWorktreePath: assertAbsolutePath(value.sourceWorktreePath, "sourceWorktreePath"),
    worktreePath: assertAbsolutePath(value.worktreePath, "worktreePath"),
    branch: assertBranch(value.branch),
    baseCommit: value.baseCommit,
    operation,
    state: value.state,
    attentionCode,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function validateWorktreeReceiptV1(value) {
  return normalizeReceipt(value);
}

function equalReceiptIntent(left, right) {
  for (const field of [
    "actionId",
    "workUnitId",
    "ownerTaskId",
    "repositoryId",
    "commonGitDir",
    "sourceWorktreePath",
    "worktreePath",
    "branch",
    "baseCommit",
    "operation",
  ]) {
    if (left[field] !== right[field]) return false;
  }
  return true;
}

async function readReceipt(directory, actionId) {
  const path = resolve(directory, receiptFileName(actionId));
  let source;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES) {
      throw new WorktreeProvisioningError("invalid-receipt", "worktree receipt is malformed");
    }
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof WorktreeProvisioningError) throw error;
    throw new WorktreeProvisioningError("unreadable-receipt", "failed to read worktree receipt", { cause: error });
  }
  if (Buffer.byteLength(source, "utf8") > MAX_RECEIPT_BYTES) {
    throw new WorktreeProvisioningError("invalid-receipt", "worktree receipt is malformed");
  }
  try {
    const receipt = normalizeReceipt(JSON.parse(source));
    if (receipt.actionId !== actionId) {
      throw new Error("receipt action ID does not match its filename");
    }
    return receipt;
  } catch (error) {
    if (error instanceof WorktreeProvisioningError) throw error;
    throw new WorktreeProvisioningError("invalid-receipt", "worktree receipt is malformed", { cause: error });
  }
}

async function writeReceipt(directory, value) {
  const receipt = normalizeReceipt(value);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = resolve(directory, receiptFileName(receipt.actionId));
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return receipt;
}

export class WorktreeReceiptStoreV1 {
  #directory;

  constructor({ directory = worktreeReceiptDirectory() } = {}) {
    this.#directory = assertAbsolutePath(directory, "receipt directory");
  }

  get directory() {
    return this.#directory;
  }

  read(actionId) {
    return readReceipt(this.#directory, assertActionId(actionId));
  }

  async list() {
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const receipts = [];
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json")).sort((left, right) => compareStrings(left.name, right.name))) {
      const source = await readFile(resolve(this.#directory, entry.name), "utf8");
      try {
        const receipt = normalizeReceipt(JSON.parse(source));
        if (receiptFileName(receipt.actionId) === entry.name) receipts.push(receipt);
      } catch {
        // Malformed private receipts are intentionally not used for effects.
      }
    }
    return receipts.sort((left, right) => compareStrings(left.actionId, right.actionId));
  }

  write(value) {
    return writeReceipt(this.#directory, value);
  }
}

async function runGit(args, { cwd, commandRunner }) {
  try {
    const result = await commandRunner({ args, cwd });
    return typeof result === "string" ? result : result.stdout ?? "";
  } catch (error) {
    throw new WorktreeProvisioningError(
      "git-command-failed",
      `git ${args[0]} failed`,
      { cause: error },
    );
  }
}

async function defaultCommandRunner({ args, cwd }) {
  const { stdout } = await execFile("git", args, {
    cwd,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function canonicalDirectory(path, label) {
  const absolute = assertAbsolutePath(path, label);
  await assertNoSymlinkComponents(absolute, label, { allowMissing: false });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorktreeProvisioningError("unsafe-path", `${label} must be a real directory`);
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    throw new WorktreeProvisioningError("unsafe-path", `${label} contains a symlinked path component`);
  }
  return canonical;
}

async function absentWorktreePath(path) {
  const absolute = assertAbsolutePath(path, "worktreePath");
  const parent = await canonicalDirectory(dirname(absolute), "worktree parent directory");
  const expected = resolve(parent, relative(dirname(absolute), absolute));
  if (expected !== absolute) {
    throw new WorktreeProvisioningError("unsafe-path", "worktreePath parent must be canonical");
  }
  const info = await lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info) throw new WorktreeProvisioningError("worktree-exists", "worktreePath already exists; use adopt to bind an existing worktree");
  return absolute;
}

function pathsOverlap(left, right) {
  const leftRelative = relative(left, right);
  const rightRelative = relative(right, left);
  return leftRelative === "" || rightRelative === "" ||
    (!leftRelative.startsWith("..") && !isAbsolute(leftRelative)) ||
    (!rightRelative.startsWith("..") && !isAbsolute(rightRelative));
}

async function gitRepository(sourcePath, commandRunner) {
  const sourceWorktreePath = await canonicalDirectory(sourcePath, "sourcePath");
  const root = (await runGit(["rev-parse", "--show-toplevel"], {
    cwd: sourceWorktreePath,
    commandRunner,
  })).trim();
  const sourceRoot = await canonicalDirectory(root, "source repository root");
  const commonGitDirRaw = (await runGit([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ], { cwd: sourceRoot, commandRunner })).trim();
  const commonGitDir = await canonicalDirectory(commonGitDirRaw, "repository common Git directory");
  return {
    sourceWorktreePath: sourceRoot,
    commonGitDir,
    repositoryId: repositoryIdForCommonGitDir(commonGitDir),
  };
}

async function ensureClean(cwd, commandRunner, label) {
  const status = await runGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ], { cwd, commandRunner });
  if (status.trim()) {
    throw new WorktreeProvisioningError("dirty-worktree", `${label} must be clean`);
  }
}

async function resolveBaseCommit(cwd, baseRevision, commandRunner) {
  const reference = assertNonemptyString(baseRevision, "baseRevision", MAX_IDENTIFIER_LENGTH);
  const commit = (await runGit([
    "rev-parse",
    "--verify",
    `${reference}^{commit}`,
  ], { cwd, commandRunner })).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
    throw new WorktreeProvisioningError("invalid-base", "baseRevision did not resolve to a commit");
  }
  return commit;
}

async function assertValidBranch(cwd, branch, commandRunner) {
  const normalized = (await runGit([
    "check-ref-format",
    "--branch",
    branch,
  ], { cwd, commandRunner })).trim();
  if (normalized !== branch) {
    throw new WorktreeProvisioningError("invalid-branch", "branch is not canonical");
  }
}

async function inspectWorktree(
  receipt,
  commandRunner,
  { requirePristineBase = false } = {},
) {
  try {
    const worktreePath = await canonicalDirectory(receipt.worktreePath, "recorded worktreePath");
    const root = (await runGit(["rev-parse", "--show-toplevel"], {
      cwd: worktreePath,
      commandRunner,
    })).trim();
    if (await canonicalDirectory(root, "recorded worktree root") !== worktreePath) {
      return { valid: false, code: "verification-failed" };
    }
    const commonGitDir = (await runGit([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ], { cwd: worktreePath, commandRunner })).trim();
    if (await canonicalDirectory(commonGitDir, "recorded worktree common Git directory") !== receipt.commonGitDir) {
      return { valid: false, code: "verification-failed" };
    }
    const branch = (await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: worktreePath,
      commandRunner,
    })).trim();
    if (branch !== receipt.branch) return { valid: false, code: "verification-failed" };
    const head = (await runGit(["rev-parse", "HEAD"], {
      cwd: worktreePath,
      commandRunner,
    })).trim();
    const mergeBase = (await runGit([
      "merge-base",
      receipt.baseCommit,
      head,
    ], { cwd: worktreePath, commandRunner })).trim();
    const clean = !(await runGit([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ], { cwd: worktreePath, commandRunner })).trim();
    const baseAncestor = mergeBase === receipt.baseCommit;
    if (requirePristineBase && (head !== receipt.baseCommit || !clean)) {
      return {
        valid: false,
        code: clean ? "verification-failed" : "dirty-worktree",
      };
    }
    return {
      valid: true,
      worktreePath,
      branch,
      headCommit: head,
      baseCommit: receipt.baseCommit,
      baseAncestor,
      clean,
    };
  } catch (error) {
    return {
      valid: false,
      code: error instanceof WorktreeProvisioningError
        ? error.code
        : "verification-failed",
    };
  }
}

/**
 * Read the current state of an owned worktree without requiring it to remain at
 * its original base commit. This is the read-only inspection primitive used by
 * the queen's recovery and integration views.
 */
export async function inspectWorktreeReceiptV1(
  value,
  { commandRunner = defaultCommandRunner } = {},
) {
  return inspectWorktree(normalizeReceipt(value), commandRunner);
}

function receiptIntent({
  actionId,
  workUnitId,
  ownerTaskId,
  repository,
  worktreePath,
  branch,
  baseCommit,
  operation,
  now,
}) {
  return {
    schemaVersion: WORKTREE_RECEIPT_SCHEMA_VERSION,
    actionId,
    workUnitId,
    ownerTaskId,
    repositoryId: repository.repositoryId,
    commonGitDir: repository.commonGitDir,
    sourceWorktreePath: repository.sourceWorktreePath,
    worktreePath,
    branch,
    baseCommit,
    operation,
    state: "provisioning",
    attentionCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function withState(receipt, state, attentionCode, now) {
  return {
    ...receipt,
    state,
    attentionCode,
    updatedAt: now,
  };
}

async function assertNoOwnershipConflict(receiptStore, intent) {
  const conflict = (await receiptStore.list()).find(
    (receipt) =>
      receipt.actionId !== intent.actionId &&
      receipt.repositoryId === intent.repositoryId &&
      (receipt.worktreePath === intent.worktreePath ||
        receipt.branch === intent.branch),
  );
  if (conflict) {
    throw new WorktreeProvisioningError(
      "ownership-conflict",
      "requested branch or worktree is already owned by another provisioning receipt",
    );
  }
}

/**
 * Create or explicitly adopt a clean worktree. Effects are serialized per Git
 * common directory and every effect boundary is recorded first. A recovery
 * never guesses after an interrupted provisioning attempt: it verifies the
 * recorded worktree, otherwise marks the receipt for queen attention.
 */
export async function provisionWorktreeV1(input, {
  receiptStore = new WorktreeReceiptStoreV1(),
  commandRunner = defaultCommandRunner,
  withRepositoryLock = withRepositoryProvisioningLock,
  now = () => new Date().toISOString(),
  lockTimeoutMs = 60_000,
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("worktree provisioning input must be a JSON object");
  }
  const fields = new Set([
    "actionId",
    "workUnitId",
    "ownerTaskId",
    "sourcePath",
    "worktreePath",
    "branch",
    "baseRevision",
    "operation",
  ]);
  const unknown = Object.keys(input).filter((field) => !fields.has(field)).sort(compareStrings);
  if (unknown.length) throw new Error(`worktree provisioning input contains unknown field: ${unknown[0]}`);
  const actionId = assertActionId(input.actionId);
  const workUnitId = assertWorkUnitId(input.workUnitId);
  const ownerTaskId = assertNonemptyString(input.ownerTaskId, "ownerTaskId");
  const sourcePath = assertAbsolutePath(input.sourcePath, "sourcePath");
  const requestedWorktreePath = assertAbsolutePath(input.worktreePath, "worktreePath");
  const branch = assertBranch(input.branch);
  const operation = input.operation;
  if (!["create", "adopt"].includes(operation)) {
    throw new Error("operation must be create or adopt");
  }

  const repository = await gitRepository(sourcePath, commandRunner);
  const baseCommit = await resolveBaseCommit(
    repository.sourceWorktreePath,
    input.baseRevision,
    commandRunner,
  );
  await assertValidBranch(repository.sourceWorktreePath, branch, commandRunner);
  if (pathsOverlap(repository.sourceWorktreePath, requestedWorktreePath)) {
    throw new WorktreeProvisioningError("overlapping-worktree", "worktreePath must not overlap sourcePath");
  }

  if (typeof withRepositoryLock !== "function") {
    throw new Error("withRepositoryLock must be a function");
  }

  return withRepositoryLock(
    repository.repositoryId,
    async () => {
      await ensureClean(repository.sourceWorktreePath, commandRunner, "source worktree");
      const existing = await receiptStore.read(actionId);
      const worktreePath = existing
        ? existing.worktreePath
        : operation === "create"
          ? await absentWorktreePath(requestedWorktreePath)
          : await canonicalDirectory(requestedWorktreePath, "worktreePath");
      const intent = receiptIntent({
        actionId,
        workUnitId,
        ownerTaskId,
        repository,
        worktreePath,
        branch,
        baseCommit,
        operation,
        now: now(),
      });
      if (existing) {
        if (requestedWorktreePath !== existing.worktreePath) {
          throw new WorktreeProvisioningError("receipt-conflict", "actionId already belongs to a different worktree path");
        }
        if (!equalReceiptIntent(existing, intent)) {
          throw new WorktreeProvisioningError("receipt-conflict", "actionId already belongs to different worktree provisioning intent");
        }
        if (existing.state === "attention") {
          throw new WorktreeProvisioningError("attention", "worktree provisioning requires queen attention");
        }
        const inspection = await inspectWorktree(existing, commandRunner, {
          requirePristineBase: existing.state === "provisioning",
        });
        if (inspection.valid) {
          const receipt = existing.state === "provisioned"
            ? existing
            : await receiptStore.write(withState(existing, "provisioned", null, now()));
          return { receipt, reused: true, recovered: existing.state !== "provisioned" };
        }
        await receiptStore.write(withState(
          existing,
          "attention",
          ATTENTION_CODES.has(inspection.code) ? inspection.code : "verification-failed",
          now(),
        ));
        throw new WorktreeProvisioningError("attention", "interrupted worktree provisioning requires queen attention");
      }

      await assertNoOwnershipConflict(receiptStore, intent);

      // Adoption has no Git mutation to recover. Refuse an invalid or dirty
      // worktree before creating a durable receipt that would require manual
      // intervention simply because the caller supplied bad evidence.
      if (operation === "adopt") {
        const inspection = await inspectWorktree(intent, commandRunner, {
          requirePristineBase: true,
        });
        if (!inspection.valid) {
          if (inspection.code === "dirty-worktree") {
            throw new WorktreeProvisioningError("dirty-worktree", "worktreePath must be clean to adopt it");
          }
          throw new WorktreeProvisioningError("verification-failed", "worktreePath does not match the requested repository, branch, and base commit");
        }
      }

      const pending = await receiptStore.write(intent);
      try {
        if (operation === "create") {
          await runGit([
            "worktree",
            "add",
            "-b",
            branch,
            worktreePath,
            baseCommit,
          ], { cwd: repository.sourceWorktreePath, commandRunner });
        }
        const inspection = await inspectWorktree(pending, commandRunner, {
          requirePristineBase: true,
        });
        if (!inspection.valid) {
          await receiptStore.write(withState(
            pending,
            "attention",
            ATTENTION_CODES.has(inspection.code) ? inspection.code : "verification-failed",
            now(),
          ));
          throw new WorktreeProvisioningError("verification-failed", "worktree provisioning could not be verified");
        }
        const receipt = await receiptStore.write(withState(pending, "provisioned", null, now()));
        return { receipt, reused: false, recovered: false };
      } catch (error) {
        if (error instanceof WorktreeProvisioningError && error.code === "verification-failed") {
          throw error;
        }
        const inspection = await inspectWorktree(pending, commandRunner, {
          requirePristineBase: true,
        });
        if (inspection.valid) {
          const receipt = await receiptStore.write(withState(pending, "provisioned", null, now()));
          return { receipt, reused: true, recovered: true };
        }
        await receiptStore.write(withState(pending, "attention", "git-command-failed", now()));
        if (error instanceof WorktreeProvisioningError) throw error;
        throw new WorktreeProvisioningError("git-command-failed", "worktree provisioning failed", { cause: error });
      }
    },
    lockTimeoutMs,
  );
}
