import assert from "node:assert/strict";
import { execFile as executeFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  WorktreeProvisioningError,
  WorktreeReceiptStoreV1,
  provisionWorktreeV1,
} from "../src/worktree-provisioning.mjs";

const execFile = promisify(executeFile);

async function git(args, cwd) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(process.cwd(), ".nelos-worktree-"));
  const source = join(root, "source");
  await execFile("git", ["init", "--initial-branch=main", source]);
  await git(["config", "user.email", "tests@example.invalid"], source);
  await git(["config", "user.name", "Nelos Tests"], source);
  await writeFile(join(source, "README.md"), "base\n");
  await git(["add", "README.md"], source);
  await git(["commit", "-m", "base"], source);
  const baseCommit = await git(["rev-parse", "HEAD"], source);
  const receiptStore = new WorktreeReceiptStoreV1({
    directory: join(root, "state", "worktree-receipts"),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source, baseCommit, receiptStore };
}

const noRepositoryLock = async (_repositoryId, callback) => callback();

function request(fixtureValue, overrides = {}) {
  return {
    actionId: "launch-worktree-1",
    workUnitId: "implement-api",
    ownerTaskId: "queen-thread",
    sourcePath: fixtureValue.source,
    worktreePath: join(fixtureValue.root, "member-worktree"),
    branch: "nelos/implement-api",
    baseRevision: "HEAD",
    operation: "create",
    ...overrides,
  };
}

function options(receiptStore) {
  return { receiptStore, withRepositoryLock: noRepositoryLock };
}

test("provisioning creates one clean branch/worktree and a private durable receipt", async (t) => {
  const current = await fixture(t);
  const result = await provisionWorktreeV1(request(current), options(current.receiptStore));

  assert.equal(result.reused, false);
  assert.equal(result.recovered, false);
  assert.equal(result.receipt.state, "provisioned");
  assert.equal(result.receipt.operation, "create");
  assert.equal(result.receipt.worktreePath, join(current.root, "member-worktree"));
  assert.equal(result.receipt.baseCommit, current.baseCommit);
  assert.equal(await git(["branch", "--show-current"], result.receipt.worktreePath), "nelos/implement-api");
  assert.equal(await git(["rev-parse", "HEAD"], result.receipt.worktreePath), current.baseCommit);
  assert.equal(await git(["status", "--porcelain=v1"], result.receipt.worktreePath), "");
  assert.deepEqual(await current.receiptStore.read("launch-worktree-1"), result.receipt);
});

test("replaying a successful provisioning action is verified and idempotent", async (t) => {
  const current = await fixture(t);
  const first = await provisionWorktreeV1(request(current), options(current.receiptStore));
  const replay = await provisionWorktreeV1(request(current), options(current.receiptStore));

  assert.equal(replay.reused, true);
  assert.equal(replay.recovered, false);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal((await git(["worktree", "list", "--porcelain"], current.source)).match(/worktree /g).length, 2);
});

test("replaying an owned worktree after its member commits does not revoke ownership", async (t) => {
  const current = await fixture(t);
  const first = await provisionWorktreeV1(request(current), options(current.receiptStore));
  await writeFile(join(first.receipt.worktreePath, "change.md"), "member change\n");
  await git(["add", "change.md"], first.receipt.worktreePath);
  await git(["commit", "-m", "member change"], first.receipt.worktreePath);

  const replay = await provisionWorktreeV1(request(current), options(current.receiptStore));

  assert.equal(replay.reused, true);
  assert.equal(replay.recovered, false);
  assert.equal(replay.receipt.state, "provisioned");
});

test("a pending receipt recovers only after its recorded worktree verifies", async (t) => {
  const current = await fixture(t);
  const first = await provisionWorktreeV1(request(current), options(current.receiptStore));
  const pending = {
    ...first.receipt,
    state: "provisioning",
    updatedAt: new Date(Date.parse(first.receipt.createdAt) + 1).toISOString(),
  };
  await current.receiptStore.write(pending);

  const recovered = await provisionWorktreeV1(request(current), options(current.receiptStore));

  assert.equal(recovered.reused, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.receipt.state, "provisioned");
  assert.equal(recovered.receipt.attentionCode, null);
});

test("adoption requires the expected repository, branch, base commit, and clean worktree", async (t) => {
  const current = await fixture(t);
  const initial = await provisionWorktreeV1(request(current), options(current.receiptStore));
  const adoptedStore = new WorktreeReceiptStoreV1({
    directory: join(current.root, "state", "adopted-receipts"),
  });
  const adopted = await provisionWorktreeV1(
    request(current, {
      actionId: "adopt-worktree-1",
      operation: "adopt",
    }),
    options(adoptedStore),
  );

  assert.equal(initial.receipt.worktreePath, adopted.receipt.worktreePath);
  assert.equal(adopted.receipt.operation, "adopt");
  assert.equal(adopted.receipt.state, "provisioned");

  await writeFile(join(initial.receipt.worktreePath, "dirty.txt"), "untracked\n");
  await assert.rejects(
    provisionWorktreeV1(
      request(current, {
        actionId: "adopt-dirty-worktree",
        operation: "adopt",
      }),
      options(new WorktreeReceiptStoreV1({ directory: join(current.root, "state", "dirty-receipts") })),
    ),
    (error) => error instanceof WorktreeProvisioningError && error.code === "dirty-worktree",
  );
});

test("a dirty source checkout blocks provisioning before Git worktree effects", async (t) => {
  const current = await fixture(t);
  await writeFile(join(current.source, "dirty.txt"), "untracked\n");

  await assert.rejects(
    provisionWorktreeV1(request(current), options(current.receiptStore)),
    (error) => error instanceof WorktreeProvisioningError && error.code === "dirty-worktree",
  );
  assert.equal(await current.receiptStore.read("launch-worktree-1"), null);
});

test("a worktree receipt cannot be replayed with different ownership or branch intent", async (t) => {
  const current = await fixture(t);
  await provisionWorktreeV1(request(current), options(current.receiptStore));

  await assert.rejects(
    provisionWorktreeV1(
      request(current, { ownerTaskId: "another-queen" }),
      options(current.receiptStore),
    ),
    (error) => error instanceof WorktreeProvisioningError && error.code === "receipt-conflict",
  );
});

test("a separate action cannot claim an already-owned branch", async (t) => {
  const current = await fixture(t);
  await provisionWorktreeV1(request(current), options(current.receiptStore));

  await assert.rejects(
    provisionWorktreeV1(
      request(current, {
        actionId: "launch-api-2",
        workUnitId: "second-api-task",
        ownerTaskId: "another-queen",
        worktreePath: join(current.root, "second-member-worktree"),
      }),
      options(current.receiptStore),
    ),
    (error) => error instanceof WorktreeProvisioningError && error.code === "ownership-conflict",
  );
});
