import { createHash } from "node:crypto";

export class ExecutorContractError extends Error {
  constructor(code) {
    super(`Nelos executor: ${code}`);
    this.name = "ExecutorContractError";
    this.code = code;
  }
}

export function executorExact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) {
    throw new ExecutorContractError("invalid-contract");
  }
  return value;
}

export function executorText(value, maximum = 512) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ExecutorContractError("invalid-contract");
  }
  return value;
}

export function executorInteger(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new ExecutorContractError("invalid-contract");
  return value;
}

export function executorHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new ExecutorContractError("invalid-contract");
  return value;
}

// All digest callers first normalize to a fixed-key-order contract. Never hash
// arbitrary caller JSON as an authorization or idempotency decision.
export function executorDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeExecutorTargetV1(value) {
  executorExact(value, ["hostId", "codexHomeId", "repositoryId", "cwd"]);
  // A target's path belongs to its host. Do not run local resolve/realpath on it.
  return {
    hostId: executorText(value.hostId),
    codexHomeId: executorHash(value.codexHomeId),
    repositoryId: executorHash(value.repositoryId),
    cwd: executorText(value.cwd, 4096),
  };
}

export function normalizeExecutorMemberV1(value) {
  executorExact(value, ["sliceId", "workUnitId", "specRevision", "attempt", "launchSequence",
    "target", "workspaceMode", "model", "reasoningEffort", "permissionProfile",
    "approvalPolicy", "title", "promptDigest"]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.workUnitId ?? "") ||
      !["isolated-write", "shared-read-only"].includes(value.workspaceMode) ||
      !["untrusted", "on-request", "never"].includes(value.approvalPolicy)) {
    throw new ExecutorContractError("invalid-contract");
  }
  return {
    sliceId: executorText(value.sliceId),
    workUnitId: value.workUnitId,
    specRevision: executorInteger(value.specRevision),
    attempt: executorInteger(value.attempt),
    launchSequence: executorInteger(value.launchSequence),
    target: normalizeExecutorTargetV1(value.target),
    workspaceMode: value.workspaceMode,
    model: executorText(value.model),
    reasoningEffort: executorText(value.reasoningEffort),
    permissionProfile: executorText(value.permissionProfile),
    approvalPolicy: value.approvalPolicy,
    title: executorText(value.title),
    promptDigest: executorHash(value.promptDigest),
  };
}

export function normalizeExecutorWaveV1(value) {
  executorExact(value, ["schemaVersion", "backend", "planRunId", "waveIndex", "waveDigest", "members"]);
  if (value.schemaVersion !== 1 || value.backend !== "nelos-app-server" ||
      !/^run:[a-f0-9]{40}$/u.test(value.planRunId ?? "") ||
      !Array.isArray(value.members) || value.members.length < 1 || value.members.length > 16) {
    throw new ExecutorContractError("invalid-contract");
  }
  const members = Array.from(value.members, normalizeExecutorMemberV1);
  for (const key of ["sliceId", "workUnitId"]) {
    if (new Set(members.map((member) => member[key])).size !== members.length) {
      throw new ExecutorContractError("duplicate-member");
    }
  }
  members.sort((a, b) => a.sliceId < b.sliceId ? -1 : a.sliceId > b.sliceId ? 1 : 0);
  return {
    schemaVersion: 1,
    backend: "nelos-app-server",
    planRunId: value.planRunId,
    waveIndex: executorInteger(value.waveIndex),
    waveDigest: executorHash(value.waveDigest),
    members,
  };
}

export function normalizeExecutorContextV1(value) {
  executorExact(value, ["serviceId", "ownerEpoch", "runtimeGeneration", "accountFingerprint",
    "configFingerprint", "certificationId", "scopeDigest", "validUntil"]);
  return {
    serviceId: executorText(value.serviceId),
    ownerEpoch: executorText(value.ownerEpoch),
    runtimeGeneration: executorHash(value.runtimeGeneration),
    accountFingerprint: executorHash(value.accountFingerprint),
    configFingerprint: executorHash(value.configFingerprint),
    certificationId: executorText(value.certificationId),
    scopeDigest: executorHash(value.scopeDigest),
    validUntil: executorInteger(value.validUntil),
  };
}

export function executorContextFingerprintV1(context) {
  const { validUntil, ...identity } = normalizeExecutorContextV1(context);
  return executorDigest(identity);
}
