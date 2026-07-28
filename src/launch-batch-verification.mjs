import {
  resolveNativeSubagentThreadsV1,
  verifyRuntimeIntelligenceV1,
} from "./runtime-intelligence-verification.mjs";
import { planRunLaunchActionIdV1 } from "./plan-run-store.mjs";

/**
 * The receipt verifier is deliberately a read-only acceptance gate.  A
 * successful launch call is not enough evidence that a wave is safe to use.
 */
export const LAUNCH_BATCH_VERIFICATION_SCHEMA_VERSION = 1;
export const MAX_LAUNCH_BATCH_MEMBERS = 16;

const MAX_IDENTIFIER_CHARACTERS = 512;
const MAX_SLICE_ID_CHARACTERS = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const AGENT_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*){0,15}$/u;

export const LAUNCH_BATCH_VERIFICATION_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "planRunId",
    "waveIndex",
    "waveDigest",
    "parentThreadId",
    "members",
  ],
  properties: {
    planRunId: { type: "string", pattern: "^run:[a-f0-9]{40}$" },
    waveIndex: { type: "integer", minimum: 1 },
    waveDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    parentThreadId: { type: "string", minLength: 1, maxLength: MAX_IDENTIFIER_CHARACTERS },
    members: {
      type: "array",
      minItems: 1,
      maxItems: MAX_LAUNCH_BATCH_MEMBERS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sliceId", "lifecycle", "turnId"],
        properties: {
          sliceId: { type: "string", minLength: 1, maxLength: MAX_SLICE_ID_CHARACTERS },
          lifecycle: { enum: ["subagent", "spinoff"] },
          // Joined subagents are resolved from these two native launch facts.
          agentPath: { type: "string", minLength: 1, maxLength: MAX_IDENTIFIER_CHARACTERS },
          // Durable spinoffs must provide the native thread ID in their receipt.
          threadId: { type: "string", minLength: 1, maxLength: MAX_IDENTIFIER_CHARACTERS },
          actionId: { type: "string", minLength: 1, maxLength: MAX_IDENTIFIER_CHARACTERS },
          // A launcher may report this for a spinoff.  When it does, it must
          // agree with the app-server observation.
          reportedParentThreadId: {
            anyOf: [
              { type: "string", maxLength: MAX_IDENTIFIER_CHARACTERS },
              { type: "null" },
            ],
          },
          turnId: { type: "string", minLength: 1, maxLength: MAX_IDENTIFIER_CHARACTERS },
        },
      },
    },
  },
});

export const LAUNCH_BATCH_VERIFICATION_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "planRunId",
    "waveIndex",
    "waveDigest",
    "parentThreadId",
    "members",
    "allVerified",
  ],
  properties: {
    schemaVersion: { const: LAUNCH_BATCH_VERIFICATION_SCHEMA_VERSION },
    planRunId: { type: "string" },
    waveIndex: { type: "integer" },
    waveDigest: { type: "string" },
    parentThreadId: { type: "string" },
    allVerified: { type: "boolean" },
    members: {
      type: "array",
      minItems: 1,
      maxItems: MAX_LAUNCH_BATCH_MEMBERS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "sliceId",
          "lifecycle",
          "identityEvidence",
          "threadId",
          "checks",
          "verified",
        ],
        properties: {
          sliceId: { type: "string" },
          lifecycle: { enum: ["subagent", "spinoff"] },
          identityEvidence: { enum: ["agent-path", "native-thread-title"] },
          threadId: { anyOf: [{ type: "string" }, { type: "null" }] },
          verified: { type: "boolean" },
          attentionReason: { type: "string" },
          checks: {
            type: "object",
            additionalProperties: false,
            required: ["identity", "read", "topology", "title", "route"],
            properties: {
              identity: { enum: ["verified", "failed"] },
              read: { enum: ["verified", "failed", "not-attempted"] },
              topology: { enum: ["verified", "failed", "not-attempted"] },
              title: {
                enum: [
                  "verified",
                  "failed",
                  "not-attempted",
                  "not-applicable",
                ],
              },
              route: { enum: ["verified", "failed", "not-attempted"] },
            },
          },
        },
      },
    },
  },
});

function assertIdentifier(value, field, maximum = MAX_IDENTIFIER_CHARACTERS) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function normalizeInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("launch batch verification input must be a JSON object");
  }
  const allowed = new Set([
    "planRunId",
    "waveIndex",
    "waveDigest",
    "parentThreadId",
    "members",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`launch batch verification input contains unknown field: ${unknown}`);
  const planRunId =
    typeof value.planRunId === "string" &&
    /^run:[a-f0-9]{40}$/u.test(value.planRunId)
      ? value.planRunId
      : (() => {
          throw new Error("planRunId has an invalid format");
        })();
  if (!Number.isSafeInteger(value.waveIndex) || value.waveIndex < 1) {
    throw new Error("waveIndex must be a positive integer");
  }
  if (typeof value.waveDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.waveDigest)) {
    throw new Error("waveDigest has an invalid format");
  }
  const parentThreadId = assertIdentifier(value.parentThreadId, "parent thread ID");
  if (
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > MAX_LAUNCH_BATCH_MEMBERS
  ) {
    throw new Error(`members must contain between 1 and ${MAX_LAUNCH_BATCH_MEMBERS} launch receipts`);
  }
  const sliceIds = new Set();
  const members = value.members.map((member, index) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw new Error(`members[${index}] must be a JSON object`);
    }
    const allowedMember = new Set([
      "sliceId",
      "lifecycle",
      "agentPath",
      "threadId",
      "actionId",
      "reportedParentThreadId",
      "turnId",
    ]);
    const memberUnknown = Object.keys(member).find((key) => !allowedMember.has(key));
    if (memberUnknown) throw new Error(`members[${index}] contains unknown field: ${memberUnknown}`);
    const sliceId = assertIdentifier(member.sliceId, "slice ID", MAX_SLICE_ID_CHARACTERS);
    if (sliceIds.has(sliceId)) throw new Error(`duplicate slice identity: ${sliceId}`);
    sliceIds.add(sliceId);
    if (!["subagent", "spinoff"].includes(member.lifecycle)) {
      throw new Error(`members[${index}].lifecycle must be subagent or spinoff`);
    }
    const turnId = assertIdentifier(member.turnId, "launch turn ID");
    if (member.lifecycle === "subagent") {
      if (
        member.threadId !== undefined ||
        member.actionId !== undefined ||
        typeof member.agentPath !== "string" ||
        !AGENT_PATH_PATTERN.test(member.agentPath)
      ) {
        throw new Error(`subagent receipt ${sliceId} requires only a valid agentPath`);
      }
      if (member.reportedParentThreadId !== undefined) {
        throw new Error(`subagent receipt ${sliceId} must not report a parent thread ID`);
      }
      return { sliceId, lifecycle: member.lifecycle, agentPath: member.agentPath, turnId };
    }
    if (member.agentPath !== undefined) {
      throw new Error(`spinoff receipt ${sliceId} must not contain agentPath`);
    }
    const threadId = assertIdentifier(member.threadId, "spinoff thread ID");
    const actionId = assertIdentifier(member.actionId, "spinoff launch action ID");
    const reportedParentThreadId =
      member.reportedParentThreadId === undefined || member.reportedParentThreadId === null
        ? null
        : assertIdentifier(member.reportedParentThreadId, "reported parent thread ID");
    return {
      sliceId,
      lifecycle: member.lifecycle,
      threadId,
      actionId,
      reportedParentThreadId,
      turnId,
    };
  });
  return {
    planRunId,
    waveIndex: value.waveIndex,
    waveDigest: value.waveDigest,
    parentThreadId,
    members,
  };
}

function record(member, threadId = null) {
  return {
    sliceId: member.sliceId,
    lifecycle: member.lifecycle,
    identityEvidence:
      member.lifecycle === "subagent"
        ? "agent-path"
        : "native-thread-title",
    threadId,
    checks: {
      identity: "failed",
      read: "not-attempted",
      topology: "not-attempted",
      title: "not-attempted",
      route: "not-attempted",
    },
    reasons: [],
  };
}

function fail(result, code) {
  if (!result.reasons.includes(code)) result.reasons.push(code);
}

function inventoryByThreadId(inventory, threadIds) {
  if (!inventory || typeof inventory !== "object" || !Array.isArray(inventory.items)) {
    throw new Error("app-server batch inspection returned no items");
  }
  const result = new Map();
  for (const item of inventory.items) {
    if (!item || typeof item !== "object" || typeof item.threadId !== "string" || result.has(item.threadId)) {
      throw new Error("app-server batch inspection returned invalid item identities");
    }
    result.set(item.threadId, item);
  }
  if (result.size !== threadIds.length || threadIds.some((threadId) => !result.has(threadId))) {
    throw new Error("app-server batch inspection omitted a requested thread");
  }
  return result;
}

function topologyNodes(inventory) {
  if (!inventory?.topology || !Array.isArray(inventory.topology.nodes)) {
    throw new Error("app-server batch inspection returned no topology");
  }
  const nodes = new Map();
  for (const node of inventory.topology.nodes) {
    if (!node || typeof node.threadId !== "string" || nodes.has(node.threadId)) {
      throw new Error("app-server topology contains invalid node identities");
    }
    nodes.set(node.threadId, node);
  }
  return nodes;
}

function sameParent(left, right) {
  return (left ?? null) === (right ?? null);
}

function publicResult(result) {
  const attentionReason = result.reasons[0];
  const checksVerified = Object.values(result.checks).every(
    (value) => value === "verified" || value === "not-applicable",
  );
  return Object.freeze({
    sliceId: result.sliceId,
    lifecycle: result.lifecycle,
    identityEvidence: result.identityEvidence,
    threadId: result.threadId,
    checks: Object.freeze({ ...result.checks }),
    ...(attentionReason ? { attentionReason } : {}),
    verified: result.reasons.length === 0 && checksVerified,
  });
}

/**
 * Verify all receipts from one native launch wave before any result is read or
 * accepted.  Dependency failures are converted into per-member attention
 * results so callers have one deterministic, fail-closed acceptance receipt.
 */
export async function verifyLaunchBatchV1(value, {
  appServerBridge,
  waveContract,
  resolveNativeSubagentThread = null,
  resolveNativeSubagentThreads = resolveNativeSubagentThreadsV1,
  verifyRuntimeIntelligence = verifyRuntimeIntelligenceV1,
} = {}) {
  const input = normalizeInput(value);
  const {
    planRunId,
    waveIndex,
    waveDigest,
    parentThreadId,
  } = input;
  if (
    !waveContract ||
    waveContract.waveIndex !== waveIndex ||
    waveContract.waveDigest !== waveDigest ||
    !Array.isArray(waveContract.members) ||
    waveContract.members.length !== input.members.length
  ) {
    throw new Error("launch batch does not match its persisted wave contract");
  }
  const receipts = new Map(
    input.members.map((member) => [member.sliceId, member]),
  );
  const members = waveContract.members.map((expected) => {
    const receipt = receipts.get(expected.sliceId);
    if (!receipt || receipt.lifecycle !== expected.lifecycle) {
      throw new Error("launch batch member set conflicts with its persisted wave");
    }
    for (const field of ["title", "model", "effort"]) {
      if (typeof expected[field] !== "string" || !expected[field]) {
        throw new Error("persisted wave member expectations are invalid");
      }
    }
    return { ...receipt, expected };
  });
  if (!appServerBridge || typeof appServerBridge.inspectMany !== "function") {
    throw new Error("launch batch verification requires appServerBridge.inspectMany()");
  }
  if (
    resolveNativeSubagentThread !== null &&
    typeof resolveNativeSubagentThread !== "function"
  ) {
    throw new Error("launch batch verification requires a valid subagent resolver");
  }
  if (
    resolveNativeSubagentThread === null &&
    typeof resolveNativeSubagentThreads !== "function"
  ) {
    throw new Error("launch batch verification requires resolveNativeSubagentThreads()");
  }
  if (typeof verifyRuntimeIntelligence !== "function") {
    throw new Error("launch batch verification requires verifyRuntimeIntelligence()");
  }

  const results = members.map((member) => record(member, member.threadId ?? null));
  const resolveOne = async (member) => {
    if (resolveNativeSubagentThread !== null) {
      return resolveNativeSubagentThread({
        parentThreadId,
        agentPath: member.agentPath,
      });
    }
    return null;
  };
  const subagents = members
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => member.lifecycle === "subagent");
  let batchResolutions = null;
  if (resolveNativeSubagentThread === null && subagents.length > 0) {
    try {
      batchResolutions = await resolveNativeSubagentThreads({
        parentThreadId,
        agentPaths: subagents.map(({ member }) => member.agentPath),
      });
      if (
        !Array.isArray(batchResolutions) ||
        batchResolutions.length !== subagents.length
      ) {
        throw new Error("subagent batch resolver returned an invalid result set");
      }
    } catch {
      batchResolutions = null;
    }
  }
  await Promise.all(members.map(async (member, index) => {
    const result = results[index];
    if (member.lifecycle === "spinoff") {
      if (
        member.actionId ===
        planRunLaunchActionIdV1({
          planRunId,
          waveIndex,
          sliceId: member.sliceId,
        })
      ) {
        result.checks.identity = "verified";
      } else {
        fail(result, "launch-action-mismatch");
      }
      return;
    }
    try {
      const batchIndex = subagents.findIndex(
        (candidate) => candidate.index === index,
      );
      const resolved =
        batchResolutions?.[batchIndex] ?? (await resolveOne(member));
      if (!resolved) throw new Error("subagent identity resolution unavailable");
      const resolvedThreadId = assertIdentifier(resolved?.threadId, "resolved subagent thread ID");
      if (resolved?.parentThreadId !== parentThreadId || resolved?.agentPath !== member.agentPath) {
        throw new Error("subagent resolver returned a conflicting identity");
      }
      result.threadId = resolvedThreadId;
      result.checks.identity = "verified";
    } catch (error) {
      fail(result, "identity-resolution-unavailable");
    }
  }));

  const identities = new Map();
  for (const result of results) {
    if (!result.threadId) continue;
    const prior = identities.get(result.threadId);
    if (prior) {
      prior.checks.identity = "failed";
      result.checks.identity = "failed";
      fail(prior, "duplicate-thread-identity");
      fail(result, "duplicate-thread-identity");
    } else {
      identities.set(result.threadId, result);
    }
  }

  const inspectable = results.filter((result) => result.checks.identity === "verified" && result.threadId);
  let inspected = null;
  let nodes = null;
  if (inspectable.length > 0) {
    const threadIds = inspectable.map((result) => result.threadId);
    try {
      const inventory = await appServerBridge.inspectMany({
        threadIds,
        includeTopology: true,
      });
      inspected = inventoryByThreadId(inventory, threadIds);
      try {
        nodes = topologyNodes(inventory);
      } catch {
        for (const result of inspectable) {
          result.checks.topology = "failed";
          fail(result, "topology-unavailable");
        }
      }
    } catch (error) {
      // Never retry an injected app-server call: a second observation could
      // hide a transient identity/topology conflict.
      for (const result of inspectable) {
        result.checks.read = "failed";
        result.checks.topology = "failed";
        fail(result, "thread-read-unavailable");
      }
    }
  }

  if (inspected) {
    for (const [index, member] of members.entries()) {
      const result = results[index];
      if (result.checks.identity !== "verified") continue;
      const item = inspected.get(result.threadId);
      const thread = item?.state === "ready" ? item.thread : null;
      if (!thread || thread.threadId !== result.threadId) {
        result.checks.read = "failed";
        result.checks.topology = "failed";
        fail(result, "thread-read-unavailable");
        continue;
      }
      result.checks.read = "verified";
      const node = nodes?.get(result.threadId);
      if (!nodes) {
        // The batch read succeeded, but it did not supply the requested
        // topology projection.  Keep this distinct from a read failure.
      } else if (!node || !sameParent(node.parentThreadId, thread.parentThreadId)) {
        result.checks.topology = "failed";
        fail(result, "topology-unavailable");
      } else if (member.lifecycle === "subagent" && thread.parentThreadId !== parentThreadId) {
        result.checks.topology = "failed";
        fail(result, "parent-thread-mismatch");
      } else if (member.lifecycle === "spinoff" && member.reportedParentThreadId !== null && thread.parentThreadId !== member.reportedParentThreadId) {
        result.checks.topology = "failed";
        fail(result, "reported-parent-conflict");
      } else {
        result.checks.topology = "verified";
      }
      if (member.lifecycle === "subagent") {
        // Joined subagents are controlled by canonical agent path. Current
        // Codex hosts expose no native title mutation contract for them.
        result.checks.title = "not-applicable";
      } else if (thread.title === member.expected.title) {
        result.checks.title = "verified";
      } else {
        result.checks.title = "failed";
        fail(result, "title-mismatch");
      }
    }
  }

  await Promise.all(members.map(async (member, index) => {
    const result = results[index];
    if (result.checks.identity !== "verified" || result.checks.read !== "verified" || !result.threadId) return;
    try {
      const route = await verifyRuntimeIntelligence({
        threadId: result.threadId,
        model: member.expected.model,
        effort: member.expected.effort,
        turnId: member.turnId,
      });
      if (route?.verified === true) {
        result.checks.route = "verified";
      } else {
        result.checks.route = "failed";
        fail(result, "exact-route-mismatch");
      }
    } catch {
      result.checks.route = "failed";
      fail(result, "route-verification-unavailable");
    }
  }));

  const publicMembers = results.map(publicResult);
  return Object.freeze({
    schemaVersion: LAUNCH_BATCH_VERIFICATION_SCHEMA_VERSION,
    planRunId,
    waveIndex,
    waveDigest,
    parentThreadId,
    members: Object.freeze(publicMembers),
    allVerified: publicMembers.every((member) => member.verified),
  });
}
