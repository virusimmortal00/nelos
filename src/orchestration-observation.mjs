import { createHash } from "node:crypto";

import {
  MAX_CONSUMED_OBSERVATION_RECEIPTS,
  validateOrchestrationCheckpointV1,
} from "./orchestration-checkpoint-store.mjs";
import { validateResultEnvelopeV1 } from "./work-result.mjs";

export const OBSERVATION_RECEIPT_SCHEMA_VERSION = 1;
export const OBSERVATION_JOIN_SCHEMA_VERSION = 1;
const ID = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const WORK_UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LIFECYCLES = new Set(["waiting", "running", "completed", "failed", "unavailable"]);
const MAX_TITLE_RETRIES = 2;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new Error(`${label} has an incompatible shape`);
  }
  return value;
}

function id(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nullableId(value, label) {
  return value === null ? null : id(value, label);
}

function commonIdentity(value, label) {
  return {
    workUnitId: id(value.workUnitId, `${label} workUnitId`, WORK_UNIT_ID),
    specRevision: positive(value.specRevision, `${label} specRevision`),
    attempt: positive(value.attempt, `${label} attempt`),
    bindingGeneration: positive(value.bindingGeneration, `${label} bindingGeneration`),
    memberThreadId: id(value.memberThreadId, `${label} memberThreadId`),
  };
}

export function validateNativeTitleObservedReceiptV1(value) {
  const receipt = exact(value, [
    "schemaVersion", "type", "actionId", "workUnitId", "specRevision",
    "attempt", "bindingGeneration", "memberThreadId", "requestedTitle",
    "observedTitle",
  ], "native title receipt");
  if (receipt.schemaVersion !== 1 || receipt.type !== "native-title-observed") {
    throw new Error("native title receipt type or schemaVersion is invalid");
  }
  if (
    typeof receipt.requestedTitle !== "string" || !receipt.requestedTitle ||
    receipt.requestedTitle.length > 512 ||
    typeof receipt.observedTitle !== "string" || receipt.observedTitle.length > 512
  ) {
    throw new Error("native title receipt titles are invalid");
  }
  return {
    schemaVersion: 1,
    type: "native-title-observed",
    actionId: id(receipt.actionId, "native title receipt actionId"),
    ...commonIdentity(receipt, "native title receipt"),
    requestedTitle: receipt.requestedTitle,
    observedTitle: receipt.observedTitle,
  };
}

function validateWaitTarget(value) {
  const target = exact(value, [
    "workUnitId", "specRevision", "attempt", "bindingGeneration",
    "memberThreadId", "hostId", "afterCursor", "nextCursor", "lifecycle",
    "latestTurnId", "attentionRequired",
  ], "native wait target");
  if (!LIFECYCLES.has(target.lifecycle) || typeof target.attentionRequired !== "boolean") {
    throw new Error("native wait target lifecycle is invalid");
  }
  const latestTurnId = nullableId(
    target.latestTurnId,
    "native wait target latestTurnId",
  );
  if (
    ["completed", "failed"].includes(target.lifecycle) &&
    latestTurnId === null
  ) {
    throw new Error("native wait target terminal lifecycle requires latestTurnId");
  }
  return {
    workUnitId: id(target.workUnitId, "native wait target workUnitId", WORK_UNIT_ID),
    specRevision: positive(target.specRevision, "native wait target specRevision"),
    attempt: positive(target.attempt, "native wait target attempt"),
    bindingGeneration: positive(target.bindingGeneration, "native wait target bindingGeneration"),
    memberThreadId: id(target.memberThreadId, "native wait target memberThreadId"),
    hostId: nullableId(target.hostId, "native wait target hostId"),
    afterCursor: nullableId(target.afterCursor, "native wait target afterCursor"),
    nextCursor: nullableId(target.nextCursor, "native wait target nextCursor"),
    lifecycle: target.lifecycle,
    latestTurnId,
    attentionRequired: target.attentionRequired,
  };
}

export function validateNativeWaitReceiptV1(value) {
  const receipt = exact(value, [
    "schemaVersion", "type", "actionId", "webId", "queenThreadId",
    "status", "targets",
  ], "native wait receipt");
  if (
    receipt.schemaVersion !== 1 || receipt.type !== "native-wait" ||
    !new Set(["event", "timeout"]).has(receipt.status) ||
    !Array.isArray(receipt.targets) || receipt.targets.length === 0 ||
    receipt.targets.length > 100
  ) {
    throw new Error("native wait receipt is invalid");
  }
  const targets = receipt.targets.map(validateWaitTarget);
  if (new Set(targets.map(({ workUnitId }) => workUnitId)).size !== targets.length) {
    throw new Error("native wait receipt targets are duplicated");
  }
  return {
    schemaVersion: 1,
    type: "native-wait",
    actionId: id(receipt.actionId, "native wait receipt actionId"),
    webId: id(receipt.webId, "native wait receipt webId"),
    queenThreadId: id(receipt.queenThreadId, "native wait receipt queenThreadId"),
    status: receipt.status,
    targets: targets.sort((left, right) => left.workUnitId.localeCompare(right.workUnitId)),
  };
}

export function validateNativeResultReadReceiptV1(value) {
  const receipt = exact(value, [
    "schemaVersion", "type", "actionId", "workUnitId", "specRevision",
    "attempt", "bindingGeneration", "memberThreadId", "requestedTurnId",
    "sourceTurnId", "resultEnvelope",
  ], "native result receipt");
  if (receipt.schemaVersion !== 1 || receipt.type !== "native-result-read") {
    throw new Error("native result receipt type or schemaVersion is invalid");
  }
  let serialized;
  try {
    serialized = JSON.stringify(receipt.resultEnvelope);
  } catch {
    throw new Error("native result receipt envelope is invalid");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    throw new Error("native result receipt envelope is oversized");
  }
  return {
    schemaVersion: 1,
    type: "native-result-read",
    actionId: id(receipt.actionId, "native result receipt actionId"),
    ...commonIdentity(receipt, "native result receipt"),
    requestedTurnId: id(receipt.requestedTurnId, "native result receipt requestedTurnId"),
    sourceTurnId: id(receipt.sourceTurnId, "native result receipt sourceTurnId"),
    resultEnvelope: receipt.resultEnvelope,
  };
}

export function validateNativeFollowUpDeliveredReceiptV1(value) {
  const receipt = exact(value, [
    "schemaVersion", "type", "actionId", "workUnitId", "specRevision",
    "attempt", "bindingGeneration", "memberThreadId", "rejectedSourceTurnId",
    "nextAttempt",
  ], "native follow-up receipt");
  if (
    receipt.schemaVersion !== 1 ||
    receipt.type !== "native-follow-up-delivered"
  ) {
    throw new Error("native follow-up receipt type or schemaVersion is invalid");
  }
  const identity = commonIdentity(receipt, "native follow-up receipt");
  const nextAttempt = positive(
    receipt.nextAttempt,
    "native follow-up receipt nextAttempt",
  );
  if (nextAttempt !== identity.attempt + 1) {
    throw new Error("native follow-up receipt nextAttempt is not contiguous");
  }
  return {
    schemaVersion: 1,
    type: "native-follow-up-delivered",
    actionId: id(receipt.actionId, "native follow-up receipt actionId"),
    ...identity,
    rejectedSourceTurnId: id(
      receipt.rejectedSourceTurnId,
      "native follow-up receipt rejectedSourceTurnId",
    ),
    nextAttempt,
  };
}

export function validateMemberRepairReceiptV1(value) {
  const receipt = exact(value, [
    "schemaVersion", "type", "actionId", "workUnitId", "specRevision",
    "attempt", "bindingGeneration", "memberThreadId", "resolution",
  ], "member repair receipt");
  if (
    receipt.schemaVersion !== 1 ||
    receipt.type !== "orchestration-member-repaired" ||
    receipt.resolution !== "detach"
  ) {
    throw new Error("member repair receipt type, schemaVersion, or resolution is invalid");
  }
  return {
    schemaVersion: 1,
    type: "orchestration-member-repaired",
    actionId: id(receipt.actionId, "member repair receipt actionId"),
    ...commonIdentity(receipt, "member repair receipt"),
    resolution: "detach",
  };
}

export function validateObservationReceiptV1(value) {
  if (value?.type === "native-title-observed") return validateNativeTitleObservedReceiptV1(value);
  if (value?.type === "native-wait") return validateNativeWaitReceiptV1(value);
  if (value?.type === "native-result-read") return validateNativeResultReadReceiptV1(value);
  if (value?.type === "native-follow-up-delivered") {
    return validateNativeFollowUpDeliveredReceiptV1(value);
  }
  if (value?.type === "orchestration-member-repaired") {
    return validateMemberRepairReceiptV1(value);
  }
  throw new Error("observation receipt type is unsupported");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function observationReceiptDigestV1(value) {
  return createHash("sha256").update(canonical(validateObservationReceiptV1(value)), "utf8").digest("hex");
}

function identityToken(member) {
  return [
    encodeURIComponent(member.workUnitId),
    `r${member.specRevision}`,
    `a${member.attempt}`,
    `b${member.bindingGeneration}`,
  ].join("/");
}

export function nativeTitleEffectV1(member) {
  const initialObservation = member.title.retryOrdinal === 0;
  return {
    schemaVersion: 1,
    type: initialObservation ? "native-read-title" : "native-set-title",
    actionId: initialObservation
      ? `observation-v1/title/${identityToken(member)}/observe`
      : `observation-v1/title/${identityToken(member)}/rename-${member.title.retryOrdinal}`,
    workUnitId: member.workUnitId,
    specRevision: member.specRevision,
    attempt: member.attempt,
    bindingGeneration: member.bindingGeneration,
    memberThreadId: member.memberThreadId,
    requestedTitle: member.title.requestedTitle,
  };
}

function waitEffect(checkpoint, members) {
  return {
    schemaVersion: 1,
    type: "native-wait",
    actionId: `observation-v1/wait/${encodeURIComponent(checkpoint.webId)}/${checkpoint.waitGeneration}`,
    webId: checkpoint.webId,
    queenThreadId: checkpoint.queenThreadId,
    targets: members.map((member) => ({
      workUnitId: member.workUnitId,
      specRevision: member.specRevision,
      attempt: member.attempt,
      bindingGeneration: member.bindingGeneration,
      memberThreadId: member.memberThreadId,
      hostId: member.execution.hostId,
      afterCursor: member.execution.cursor,
    })),
  };
}

function readEffect(member) {
  return {
    schemaVersion: 1,
    type: "native-read-result",
    actionId: `observation-v1/result/${identityToken(member)}/${encodeURIComponent(member.execution.latestTurnId)}`,
    workUnitId: member.workUnitId,
    specRevision: member.specRevision,
    attempt: member.attempt,
    bindingGeneration: member.bindingGeneration,
    memberThreadId: member.memberThreadId,
    requestedTurnId: member.execution.latestTurnId,
  };
}

function correctionPrompt(member) {
  return [
    "Correct the result rejected by the queen in this same task.",
    `Preserve workUnitId ${member.workUnitId} and specRevision ${member.specRevision};`,
    `return attempt ${member.attempt + 1}.`,
    "Finish with exactly one valid final nelos-result block and no trailing prose.",
  ].join(" ");
}

function followUpEffect(member) {
  return {
    schemaVersion: 1,
    type: "native-follow-up",
    actionId:
      `observation-v1/correction/${identityToken(member)}` +
      `/${encodeURIComponent(member.result.sourceTurnId)}`,
    workUnitId: member.workUnitId,
    specRevision: member.specRevision,
    attempt: member.attempt,
    bindingGeneration: member.bindingGeneration,
    memberThreadId: member.memberThreadId,
    rejectedSourceTurnId: member.result.sourceTurnId,
    nextAttempt: member.attempt + 1,
    prompt: correctionPrompt(member),
  };
}

function repairEffect(member) {
  return {
    schemaVersion: 1,
    type: "orchestration-repair-member",
    actionId: `observation-v1/repair/${identityToken(member)}/detach`,
    workUnitId: member.workUnitId,
    specRevision: member.specRevision,
    attempt: member.attempt,
    bindingGeneration: member.bindingGeneration,
    memberThreadId: member.memberThreadId,
    problem: "required-result-member-missing-read-result",
    missingCapabilities: ["read-result"],
    supportedResolutions: ["detach"],
  };
}

/** Pure projection: no I/O, time, process, transport, or app-server behavior. */
export function reduceObservationJoinV1(value) {
  const checkpoint = validateOrchestrationCheckpointV1(value);
  const activeRequired = checkpoint.members.filter(
    (member) => member.required && member.coordination.state !== "detached",
  );
  const titleEffects = checkpoint.members
    .filter((member) => member.title.state === "pending")
    .map(nativeTitleEffectV1);
  const waitMembers = activeRequired.filter(
    (member) =>
      !["terminal", "attention"].includes(member.execution.state) &&
      !["accepted", "correction-pending"].includes(member.coordination.state),
  );
  const resultEffects = activeRequired
    .filter(
      (member) =>
        member.execution.state === "terminal" &&
        member.execution.latestTurnId !== null &&
        member.capabilities.includes("read-result") &&
        member.coordination.state !== "correction-pending" &&
        member.result.state !== "current",
    )
    .map(readEffect);
  const correctionMembers = activeRequired.filter(
    (member) =>
      member.coordination.state === "correction-pending" &&
      member.result.state === "current" &&
      member.result.sourceTurnId !== null &&
      member.capabilities.includes("follow-up"),
  );
  const impossibleMembers = activeRequired.filter(
    (member) =>
      member.execution.state === "terminal" &&
      !member.capabilities.includes("read-result"),
  );
  const effects = [
    ...titleEffects,
    ...(waitMembers.length > 0 ? [waitEffect(checkpoint, waitMembers)] : []),
    ...resultEffects,
    ...correctionMembers.map(followUpEffect),
    ...impossibleMembers.map(repairEffect),
  ];

  const hasAttention = activeRequired.some(
    (member) =>
      member.title.state === "attention" ||
      member.execution.state === "attention" ||
      member.execution.attentionRequired ||
      ["stale", "malformed"].includes(member.result.state) ||
      (member.result.state === "current" &&
        member.result.envelope.outcome !== "succeeded"),
  );
  const allCurrentSucceeded = activeRequired.every(
    (member) => member.result.state === "current" && member.result.envelope.outcome === "succeeded",
  );
  const allAccepted = activeRequired.every((member) => member.coordination.state === "accepted");
  const boundary = impossibleMembers.length > 0
    ? {
        type: "attention",
        reason: "member-evidence-requires-review",
        members: impossibleMembers.map((member) => ({
          workUnitId: member.workUnitId,
          problem: "required-result-member-missing-read-result",
          missingCapabilities: ["read-result"],
          supportedActions: ["detach"],
        })),
      }
    : hasAttention
      ? { type: "attention", reason: "member-evidence-requires-review" }
      : correctionMembers.length > 0
        ? {
            type: "action",
            reason: "rejected-results-require-correction",
          }
    : allAccepted
      ? {
          type: "continue",
          reason: "all-required-results-accepted",
          automaticWake: false,
        }
      : allCurrentSucceeded
        ? { type: "decide", reason: "all-required-results-current" }
        : { type: "waiting", reason: "required-members-outstanding" };
  return {
    schemaVersion: OBSERVATION_JOIN_SCHEMA_VERSION,
    checkpointRevision: checkpoint.checkpointRevision,
    effects,
    boundary,
  };
}

function matchingMember(checkpoint, receipt) {
  const member = checkpoint.members.find(({ workUnitId }) => workUnitId === receipt.workUnitId);
  if (!member) throw new Error("observation receipt references an unknown work unit");
  for (const field of ["specRevision", "attempt", "bindingGeneration", "memberThreadId"]) {
    if (member[field] !== receipt[field]) {
      throw new Error(`observation receipt has stale or conflicting ${field}`);
    }
  }
  return member;
}

function assertExpectedEffect(checkpoint, receipt) {
  const effect = reduceObservationJoinV1(checkpoint).effects.find(
    ({ actionId }) => actionId === receipt.actionId,
  );
  if (!effect) throw new Error("observation receipt actionId is stale or unexpected");
  return effect;
}

export function applyObservationReceiptV1(value, rawReceipt) {
  const checkpoint = validateOrchestrationCheckpointV1(value);
  const receipt = validateObservationReceiptV1(rawReceipt);
  const digest = observationReceiptDigestV1(receipt);
  const consumed = checkpoint.consumedReceipts.find(({ actionId }) => actionId === receipt.actionId);
  if (consumed) {
    if (consumed.digest !== digest) throw new Error("observation receipt conflicts with a consumed actionId");
    return { checkpoint, replayed: true };
  }
  const effect = assertExpectedEffect(checkpoint, receipt);
  const members = checkpoint.members.map((member) => ({
    ...member,
    title: { ...member.title },
    execution: { ...member.execution },
    result: { ...member.result },
    coordination: { ...member.coordination },
  }));

  if (receipt.type === "native-title-observed") {
    const member = matchingMember({ ...checkpoint, members }, receipt);
    if (
      receipt.requestedTitle !== member.title.requestedTitle ||
      receipt.requestedTitle !== effect.requestedTitle
    ) {
      throw new Error("native title receipt requestedTitle conflicts with the checkpoint");
    }
    member.title.observedTitle = receipt.observedTitle;
    if (receipt.observedTitle === receipt.requestedTitle) {
      member.title.state = "verified";
    } else if (member.title.retryOrdinal < MAX_TITLE_RETRIES) {
      member.title.retryOrdinal += 1;
    } else {
      member.title.state = "attention";
    }
  } else if (receipt.type === "native-wait") {
    if (receipt.webId !== checkpoint.webId || receipt.queenThreadId !== checkpoint.queenThreadId) {
      throw new Error("native wait receipt has stale web identity");
    }
    const expected = new Map(effect.targets.map((target) => [target.workUnitId, target]));
    if (receipt.targets.length !== expected.size) {
      throw new Error("native wait receipt target set conflicts with the wait action");
    }
    for (const target of receipt.targets) {
      const requested = expected.get(target.workUnitId);
      if (
        !requested ||
        requested.memberThreadId !== target.memberThreadId ||
        requested.specRevision !== target.specRevision ||
        requested.attempt !== target.attempt ||
        requested.bindingGeneration !== target.bindingGeneration ||
        (requested.hostId !== null && requested.hostId !== target.hostId) ||
        requested.afterCursor !== target.afterCursor
      ) {
        throw new Error("native wait receipt has a stale or conflicting cursor target");
      }
      const member = members.find(({ workUnitId }) => workUnitId === target.workUnitId);
      member.execution.hostId = target.hostId;
      member.execution.cursor = target.nextCursor;
      member.execution.latestTurnId = target.latestTurnId;
      const requiresAttention =
        target.attentionRequired ||
        ["failed", "unavailable"].includes(target.lifecycle);
      member.execution.attentionRequired = requiresAttention;
      member.execution.state =
        requiresAttention
          ? "attention"
          : target.lifecycle === "completed"
            ? "terminal"
            : target.lifecycle;
      if (member.coordination.state === "unjoined") member.coordination.state = "waiting";
      if (
        member.result.sourceTurnId !== null &&
        member.result.sourceTurnId !== target.latestTurnId
      ) {
        member.result = {
          state: "stale",
          sourceTurnId: member.result.sourceTurnId,
          envelope: member.result.envelope,
          errorCode: "source_turn_stale",
        };
        member.coordination.state = "waiting";
      }
    }
  } else if (receipt.type === "native-result-read") {
    const member = matchingMember({ ...checkpoint, members }, receipt);
    if (
      receipt.requestedTurnId !== member.execution.latestTurnId ||
      receipt.requestedTurnId !== effect.requestedTurnId
    ) {
      throw new Error("native result receipt requestedTurnId is stale");
    }
    let envelope;
    try {
      envelope = validateResultEnvelopeV1(receipt.resultEnvelope);
    } catch {
      member.result = {
        state: "malformed",
        sourceTurnId: receipt.sourceTurnId,
        envelope: null,
        errorCode: "malformed_envelope",
      };
      member.coordination.state = "waiting";
      envelope = null;
    }
    if (envelope) {
      const identityMatches =
        envelope.workUnitId === member.workUnitId &&
        envelope.specRevision === member.specRevision &&
        envelope.attempt === member.attempt;
      const current =
        receipt.sourceTurnId === member.execution.latestTurnId && identityMatches;
      member.result = {
        state: current ? "current" : "stale",
        sourceTurnId: receipt.sourceTurnId,
        envelope,
        errorCode: current ? null : "result_provenance_stale",
      };
      member.coordination.state = current ? "collected" : "waiting";
    }
  } else if (receipt.type === "native-follow-up-delivered") {
    const member = matchingMember({ ...checkpoint, members }, receipt);
    if (
      member.coordination.state !== "correction-pending" ||
      member.result.state !== "current" ||
      member.result.sourceTurnId !== receipt.rejectedSourceTurnId ||
      receipt.nextAttempt !== member.attempt + 1
    ) {
      throw new Error("native follow-up receipt does not match the rejected result");
    }
    member.attempt = receipt.nextAttempt;
    member.execution.state = "waiting";
    member.execution.attentionRequired = false;
    member.result = {
      state: "absent",
      sourceTurnId: null,
      envelope: null,
      errorCode: null,
    };
    member.coordination.state = "waiting";
  } else {
    const member = matchingMember({ ...checkpoint, members }, receipt);
    member.required = false;
    member.coordination.state = "detached";
    member.execution.attentionRequired = false;
  }

  return {
    checkpoint: {
      ...checkpoint,
      checkpointRevision: checkpoint.checkpointRevision + 1,
      waitGeneration:
        receipt.type === "native-wait"
          ? checkpoint.waitGeneration + 1
          : checkpoint.waitGeneration,
      members,
      consumedReceipts: [
        ...checkpoint.consumedReceipts,
        { actionId: receipt.actionId, digest },
      ].slice(-MAX_CONSUMED_OBSERVATION_RECEIPTS),
    },
    replayed: false,
  };
}
