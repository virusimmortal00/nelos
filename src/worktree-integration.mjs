import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { validateWorkUnitSpecV1 } from "./execution-store.mjs";
import { assertWebId } from "./task-web.mjs";
import { validateResultEnvelopeV1 } from "./work-result.mjs";
import {
  inspectWorktreeReceiptV1,
  validateWorktreeReceiptV1,
} from "./worktree-provisioning.mjs";

const WORK_UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PATH_LENGTH = 4_096;
const MAX_WORKSPACE_ROOT_LENGTH = 4_096;
const MAX_ARTIFACTS = 8;

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function assertWorkUnitId(value, field = "workUnitId") {
  if (typeof value !== "string" || !WORK_UNIT_ID_PATTERN.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function assertAbsoluteDirectory(value, field) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_WORKSPACE_ROOT_LENGTH ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} must be an absolute path`);
  }
  return resolve(value);
}

function worktreeSlug({ webId, workUnitId, specRevision }) {
  const readable = `${webId}-${workUnitId}-r${specRevision}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$|\.+$/gu, "")
    .slice(0, 56) || "work-unit";
  const digest = createHash("sha256")
    .update(`${webId}\u0000${workUnitId}\u0000${specRevision}`)
    .digest("hex")
    .slice(0, 10);
  return `${readable}-${digest}`;
}

/**
 * Derive collision-resistant, reproducible names without persisting a
 * workspace path in a plan. Callers may still explicitly adopt a path through
 * the lower-level provisioning command when that is intentional.
 */
export function deriveWorktreeTargetV1(value) {
  assertPlainObject(value, "worktree target input");
  const fields = new Set([
    "webId",
    "workUnitId",
    "specRevision",
    "attempt",
    "worktreeRoot",
  ]);
  const unknown = Object.keys(value).filter((field) => !fields.has(field)).sort();
  if (unknown.length) throw new Error(`worktree target input contains unknown field: ${unknown[0]}`);
  const webId = assertWebId(value.webId);
  const workUnitId = assertWorkUnitId(value.workUnitId);
  const specRevision = assertPositiveInteger(value.specRevision, "specRevision");
  const attempt = assertPositiveInteger(value.attempt, "attempt");
  const worktreeRoot = assertAbsoluteDirectory(value.worktreeRoot, "worktreeRoot");
  const slug = worktreeSlug({ webId, workUnitId, specRevision });
  return {
    webId,
    workUnitId,
    specRevision,
    attempt,
    actionId: `launch:${webId}:${workUnitId}:r${specRevision}:a${attempt}`,
    branch: `fraktik/${slug}`,
    worktreePath: resolve(worktreeRoot, slug),
  };
}

function artifactReference(value, index) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    isAbsolute(value)
  ) {
    throw new Error(`artifacts[${index}] must be a relative path`);
  }
  return value;
}

function confinedPath(root, artifact) {
  const candidate = resolve(root, artifact);
  const relativePath = relative(root, candidate);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return { candidate, relativePath };
}

/**
 * Verify only bounded relative result artifacts. Symlink targets must also
 * remain inside the worktree, so an agent cannot turn an allowed-looking path
 * into an out-of-tree read reference.
 */
export async function verifyResultArtifactsV1({ receipt, result } = {}) {
  const owned = validateWorktreeReceiptV1(receipt);
  const envelope = validateResultEnvelopeV1(result);
  if (envelope.artifacts.length > MAX_ARTIFACTS) {
    throw new Error(`artifacts must contain at most ${MAX_ARTIFACTS} entries`);
  }
  const inspection = await inspectWorktreeReceiptV1(owned);
  if (!inspection.valid) {
    return {
      valid: false,
      artifacts: [],
      reasons: ["workspace_unavailable"],
    };
  }

  const artifacts = [];
  const reasons = [];
  for (let index = 0; index < envelope.artifacts.length; index += 1) {
    let reference;
    try {
      reference = artifactReference(envelope.artifacts[index], index);
    } catch {
      reasons.push("artifact_not_relative");
      continue;
    }
    const confined = confinedPath(inspection.worktreePath, reference);
    if (!confined) {
      reasons.push("artifact_outside_worktree");
      continue;
    }
    try {
      const info = await lstat(confined.candidate);
      if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) {
        reasons.push("artifact_unsupported_type");
        continue;
      }
      const canonical = await realpath(confined.candidate);
      const canonicalRelative = relative(inspection.worktreePath, canonical);
      if (
        !canonicalRelative ||
        canonicalRelative === ".." ||
        canonicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(canonicalRelative)
      ) {
        reasons.push("artifact_symlink_escape");
        continue;
      }
      artifacts.push({ path: confined.relativePath, kind: info.isDirectory() ? "directory" : "file" });
    } catch (error) {
      if (error?.code === "ENOENT") reasons.push("artifact_missing");
      else reasons.push("artifact_unavailable");
    }
  }
  return { valid: reasons.length === 0, artifacts, reasons: [...new Set(reasons)].sort() };
}

/**
 * Combine durable workspace ownership, current Git evidence, and a bounded
 * member result into a read-only integration decision. This never accepts,
 * merges, or otherwise mutates a branch.
 */
export async function assessIntegrationReadinessV1({
  receipt,
  workUnit,
  result = null,
} = {}) {
  const owned = validateWorktreeReceiptV1(receipt);
  const spec = validateWorkUnitSpecV1(workUnit);
  const reasons = [];
  if (owned.workUnitId !== spec.workUnitId) reasons.push("work_unit_mismatch");
  if (owned.state !== "provisioned") reasons.push("receipt_not_provisioned");

  const workspace = await inspectWorktreeReceiptV1(owned);
  if (!workspace.valid) {
    reasons.push("workspace_unavailable");
  } else {
    if (!workspace.baseAncestor) reasons.push("base_not_ancestor");
    if (!workspace.clean) reasons.push("worktree_dirty");
    if (workspace.headCommit === owned.baseCommit) reasons.push("no_member_commit");
  }

  let artifacts = null;
  if (result === null) {
    reasons.push("result_missing");
  } else {
    let envelope;
    try {
      envelope = validateResultEnvelopeV1(result);
    } catch {
      reasons.push("result_invalid");
    }
    if (envelope) {
      if (envelope.workUnitId !== spec.workUnitId) reasons.push("result_work_unit_mismatch");
      if (envelope.specRevision !== spec.specRevision) reasons.push("result_revision_mismatch");
      if (envelope.attempt !== spec.attempt) reasons.push("result_attempt_mismatch");
      if (envelope.outcome !== "succeeded") reasons.push("result_not_succeeded");
      artifacts = await verifyResultArtifactsV1({ receipt: owned, result: envelope });
      reasons.push(...artifacts.reasons);
    }
  }

  return {
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    workspace,
    artifacts,
  };
}
