import { nativeResultReadEffectV1 } from "./orchestration-observation.mjs";

export const MCP_RESULT_COLLECTION_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    webId: { type: "string", minLength: 1, maxLength: 64 },
    queenThreadId: { type: "string", minLength: 1, maxLength: 512 },
  },
  required: ["webId", "queenThreadId"],
  additionalProperties: false,
});

export function resultCollectionActionV1({ webId, queenThreadId }) {
  return {
    schemaVersion: 1, kind: "collect-results", tool: "nelos_orchestrate_collect",
    arguments: { webId, queenThreadId },
  };
}

export function hasHostRecoveryEffectV1(state) {
  return state.join?.effects?.some(({ type }) =>
    type === "native-follow-up" || type === "orchestration-repair-member") === true;
}

function attention(state, reason) {
  return { ...state, nextAction: { schemaVersion: 1, kind: "attention", reason } };
}

function resultReceipt(effect, observed) {
  return { ...effect, type: "native-result-read", ...observed };
}

/**
 * Read native evidence for one verified wave and consume exact generated
 * callbacks. No native task mutation, polling loop, or semantic acceptance.
 * Only the bounded result envelope leaves the bridge; turn content stays there.
 */
export async function collectOrchestrationResultsV1(identity, { joinAdapter, appServerBridge }) {
  const advance = (receipt = null) => joinAdapter.advance({ ...identity, receipt });
  let state = await advance();
  if (hasHostRecoveryEffectV1(state)) return state;
  if (!state.checkpoint.waveScope) return attention(state, "verified-plan-wave-required");
  if (state.nextAction) return state;
  if (state.checkpoint.members.length > 16) throw new Error("result collection exceeds the wave bound");

  // Joined members never receive title effects. Durable titles are observed,
  // and a mismatch returns the existing host-owned synchronization action.
  for (const effect of state.join.effects.filter(({ type }) => type === "native-read-title" || type === "native-set-title")) {
    let observed;
    try {
      observed = await appServerBridge.inspect({ threadId: effect.memberThreadId });
    } catch {
      return attention(state, "member-title-evidence-unavailable");
    }
    if (observed.title !== effect.requestedTitle) {
      return { ...state, nextAction: {
        schemaVersion: 1, kind: "native-set-title", threadId: effect.memberThreadId,
        title: effect.requestedTitle, verify: true, after: "repeat-result-collection",
      } };
    }
    state = await advance({ ...effect, type: "native-title-observed", observedTitle: observed.title });
  }

  const wait = state.join.effects.find(({ type }) => type === "native-wait");
  if (wait) {
    const targets = [];
    // Four concurrent reads at most; mutations remain sequential.
    for (let offset = 0; offset < wait.targets.length; offset += 4) {
      let observations;
      try {
        observations = await Promise.all(wait.targets.slice(offset, offset + 4).map(async (target) => ({
          target, latest: await appServerBridge.latestTurn({ threadId: target.memberThreadId }),
        })));
      } catch {
        return attention(state, "member-turn-evidence-unavailable");
      }
      for (const { target, latest } of observations) {
        if (latest?.status !== "completed" || !latest.turnId) {
          return attention(state, "required-member-result-not-completed");
        }
        targets.push({ ...target, nextCursor: null, lifecycle: "completed",
          latestTurnId: latest.turnId, attentionRequired: false });
      }
    }
    state = await advance({ ...wait, status: "snapshot", targets });
  }

  for (const effect of state.join.effects.filter(({ type }) => type === "native-read-result")) {
    let observed;
    try {
      observed = await appServerBridge.readResult({ threadId: effect.memberThreadId, turnId: effect.requestedTurnId });
    } catch {
      return attention(state, "current-native-result-unavailable");
    }
    if (observed.sourceTurnId !== effect.requestedTurnId ||
        ["workUnitId", "specRevision", "attempt"].some((key) => observed.resultEnvelope?.[key] !== effect[key])) {
      return attention(state, "current-native-result-identity-mismatch");
    }
    state = await advance(resultReceipt(effect, observed));
  }

  if (state.nextAction) return state;
  if (state.join.boundary.type !== "decide") return attention(state, "collected-results-require-attention");
  const member = state.checkpoint.members.find((candidate) =>
    candidate.required && candidate.coordination.state !== "accepted" && candidate.result.state === "current");
  if (!member) return attention(state, "current-result-acceptance-unavailable");
  const receipt = resultReceipt(nativeResultReadEffectV1(member), {
    sourceTurnId: member.result.sourceTurnId, resultEnvelope: member.result.envelope,
  });
  // A replay must reproduce a previously consumed receipt byte-for-byte. This
  // also covers interruption after consumption but before the queen decision.
  state = await advance(receipt);
  return { ...state, nextAction: {
    schemaVersion: 1, kind: "decide-collected-result", tool: "nelos_queen_decide",
    arguments: { schemaVersion: 1, ...identity, receipt },
  } };
}
