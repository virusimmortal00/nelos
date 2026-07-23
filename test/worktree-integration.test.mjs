import assert from "node:assert/strict";
import { execFile as executeFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createWorkUnitSpecV1 } from "../src/execution-store.mjs";
import {
  assessIntegrationReadinessV1,
  deriveWorktreeTargetV1,
  verifyResultArtifactsV1,
} from "../src/worktree-integration.mjs";
import {
  WorktreeReceiptStoreV1,
  inspectWorktreeReceiptV1,
  provisionWorktreeV1,
} from "../src/worktree-provisioning.mjs";

const execFile = promisify(executeFile);
const noRepositoryLock = async (_repositoryId, callback) => callback();

async function git(args, cwd) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(process.cwd(), ".nelos-integration-"));
  const source = join(root, "source");
  const worktree = join(root, "member-worktree");
  await execFile("git", ["init", "--initial-branch=main", source]);
  await git(["config", "user.email", "tests@example.invalid"], source);
  await git(["config", "user.name", "Nelos Tests"], source);
  await writeFile(join(source, "README.md"), "base\n");
  await git(["add", "README.md"], source);
  await git(["commit", "-m", "base"], source);
  const receiptStore = new WorktreeReceiptStoreV1({
    directory: join(root, "state", "worktree-receipts"),
  });
  const provisioned = await provisionWorktreeV1({
    actionId: "launch:A1:member:r1:a1",
    workUnitId: "member",
    ownerTaskId: "queen-thread",
    sourcePath: source,
    worktreePath: worktree,
    branch: "nelos/member",
    baseRevision: "HEAD",
    operation: "create",
  }, { receiptStore, withRepositoryLock: noRepositoryLock });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source, worktree, receipt: provisioned.receipt };
}

function workUnit() {
  return createWorkUnitSpecV1({
    webId: "A1",
    queenThreadId: "queen-thread",
    workUnitId: "member",
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result", "follow-up", "archive"],
    title: "Member implementation",
    objectiveSummary: "Make the isolated implementation change.",
    deliverable: "A clean committed implementation.",
    acceptanceCriteria: ["Integration checks pass"],
    dependencies: [],
    required: true,
    policy: { maxAttempts: 2, onBlocked: "queen-review", onFailure: "queen-review" },
  });
}

function result(artifacts) {
  return {
    schemaVersion: 1,
    workUnitId: "member",
    specRevision: 1,
    attempt: 1,
    outcome: "succeeded",
    summary: "Member change is committed.",
    artifacts,
    verification: ["Focused tests pass"],
    blockers: [],
    recoveryHint: null,
  };
}

test("deterministic worktree planning derives stable collision-resistant targets", () => {
  const input = {
    webId: "A1",
    workUnitId: "member:api",
    specRevision: 2,
    attempt: 3,
    worktreeRoot: "/workspace/writers",
  };
  const first = deriveWorktreeTargetV1(input);
  const second = deriveWorktreeTargetV1(input);

  assert.deepEqual(first, second);
  assert.equal(first.actionId, "launch:A1:member:api:r2:a3");
  assert.match(first.branch, /^nelos\/a1-member-api-r2-[a-f0-9]{10}$/);
  assert.match(first.worktreePath, /a1-member-api-r2-[a-f0-9]{10}$/);
});

test("owned worktrees remain inspectable after a member commits", async (t) => {
  const current = await fixture(t);
  await writeFile(join(current.worktree, "change.md"), "member change\n");
  await git(["add", "change.md"], current.worktree);
  await git(["commit", "-m", "member change"], current.worktree);

  const inspection = await inspectWorktreeReceiptV1(current.receipt);

  assert.equal(inspection.valid, true);
  assert.equal(inspection.clean, true);
  assert.equal(inspection.baseAncestor, true);
  assert.notEqual(inspection.headCommit, current.receipt.baseCommit);
});

test("integration readiness requires a clean descendant commit and confined artifacts", async (t) => {
  const current = await fixture(t);
  await writeFile(join(current.worktree, "change.md"), "member change\n");
  await git(["add", "change.md"], current.worktree);
  await git(["commit", "-m", "member change"], current.worktree);

  const readiness = await assessIntegrationReadinessV1({
    receipt: current.receipt,
    workUnit: workUnit(),
    result: result(["change.md"]),
  });

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.reasons, []);
  assert.deepEqual(readiness.artifacts.artifacts, [{ path: "change.md", kind: "file" }]);
});

test("artifact verification rejects a symlink that escapes the assigned worktree", async (t) => {
  const current = await fixture(t);
  const outside = join(current.root, "outside.txt");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(current.worktree, "escape"));

  const checked = await verifyResultArtifactsV1({
    receipt: current.receipt,
    result: result(["escape"]),
  });

  assert.equal(checked.valid, false);
  assert.deepEqual(checked.reasons, ["artifact_symlink_escape"]);
});

test("integration readiness reports uncommitted work instead of accepting it", async (t) => {
  const current = await fixture(t);
  await writeFile(join(current.worktree, "change.md"), "uncommitted\n");

  const readiness = await assessIntegrationReadinessV1({
    receipt: current.receipt,
    workUnit: workUnit(),
    result: result([]),
  });

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.reasons, ["no_member_commit", "worktree_dirty"]);
});
