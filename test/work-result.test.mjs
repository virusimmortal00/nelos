import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWorkResult,
  collectWebResults,
  finalAgentMessage,
  formatResultEnvelope,
  parseResultEnvelope,
  preserveWebCollectionEvidence,
  timeoutWebCollection,
} from "../src/work-result.mjs";

function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    workUnitId: "golden-a",
    specRevision: 1,
    attempt: 1,
    outcome: "succeeded",
    summary: "A_RESULT",
    artifacts: [],
    verification: ["fixture assertion"],
    blockers: [],
    recoveryHint: null,
    ...overrides,
  };
}

function completedTurn(id, result, extraItems = []) {
  return {
    id,
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "PRIVATE_PROMPT" }] },
      ...extraItems,
      {
        type: "agentMessage",
        phase: "final_answer",
        text: formatResultEnvelope(result),
      },
    ],
  };
}

test("ResultEnvelopeV1 formatting and parsing preserve bounded work-unit data", () => {
  const value = envelope({
    outcome: "blocked",
    summary: "B_BLOCKED",
    blockers: ["fixtureMode is missing"],
    recoveryHint: "Provide fixtureMode=scripted-no-model",
  });
  const formatted = formatResultEnvelope(value);
  assert.match(formatted, /^```nelos-result/m);
  assert.deepEqual(parseResultEnvelope(formatted), {
    format: "envelope",
    result: value,
    fallbackSummary: null,
    error: null,
  });
  assert.equal(
    parseResultEnvelope(
      formatResultEnvelope(envelope({ summary: "safe\u0000\n  result" })),
    ).result.summary,
    "safe result",
  );
});

test("result parsing uses the latest envelope and safely classifies text fallback", () => {
  const first = formatResultEnvelope(envelope({ summary: "old" }));
  const latestValue = envelope({ attempt: 2, summary: "current" });
  const latest = formatResultEnvelope(latestValue);
  assert.deepEqual(parseResultEnvelope(`${first}\ncommentary\n${latest}`).result, latestValue);

  const fallback = parseResultEnvelope(`Plain result\u0000 ${"x".repeat(2_000)}`);
  assert.equal(fallback.format, "text");
  assert.equal(fallback.fallbackSummary.includes("\u0000"), false);
  assert.equal(fallback.fallbackSummary.length, 1_000);
});

test("result parsing rejects malformed or unbounded envelopes", () => {
  assert.deepEqual(
    parseResultEnvelope("```nelos-result\n{broken}\n```").error,
    { code: "invalid_json", message: "result envelope is not valid JSON" },
  );
  assert.equal(
    parseResultEnvelope("```nelos-result\n{}").error.code,
    "unterminated_envelope",
  );
  assert.throws(
    () =>
      formatResultEnvelope(
        envelope({
          outcome: "blocked",
          blockers: [],
          recoveryHint: "retry",
        }),
      ),
    /blocked results must include/,
  );
  assert.throws(
    () => formatResultEnvelope({ ...envelope(), transcript: "not allowed" }),
    /unknown field: transcript/,
  );
  assert.throws(
    () =>
      formatResultEnvelope({
        ...envelope(),
        contractId: "legacy-contract-id",
        contractRevision: 1,
      }),
    /unknown field: contractId/,
  );
  assert.throws(
    () => formatResultEnvelope(envelope({ workUnitId: "invalid work unit" })),
    /workUnitId has an invalid format/,
  );
  assert.throws(
    () => formatResultEnvelope(envelope({ specRevision: 0 })),
    /specRevision must be a positive integer/,
  );
  for (const field of ["artifacts", "verification", "blockers"]) {
    const sparse = new Array(1);
    assert.throws(
      () =>
        formatResultEnvelope(
          envelope({
            [field]: sparse,
            ...(field === "blockers" ? { outcome: "failed" } : {}),
          }),
        ),
      new RegExp(`${field} must not contain empty slots`),
    );
  }
  assert.throws(
    () =>
      formatResultEnvelope(
        envelope({
          summary: "x".repeat(2_000),
          artifacts: Array.from({ length: 8 }, () => "a".repeat(500)),
          verification: Array.from({ length: 8 }, () => "v".repeat(500)),
        }),
      ),
    /exceeds 8192 bytes/,
  );
  assert.throws(
    () =>
      formatResultEnvelope(
        envelope({
          summary: "🙂".repeat(1_000),
          artifacts: Array.from({ length: 5 }, () => "🙂".repeat(250)),
        }),
      ),
    /exceeds 8192 bytes/,
  );
  const valid = formatResultEnvelope(envelope());
  assert.equal(
    parseResultEnvelope(
      `${valid}\n\`\`\`nelos-result\n{\"schemaVersion\":1}`,
    ).error.code,
    "unterminated_envelope",
  );
  assert.equal(
    parseResultEnvelope(`${valid}\nlate prose`).error.code,
    "nonterminal_envelope",
  );
  assert.equal(
    parseResultEnvelope(`${valid}\n\`\`\`nelos-result\n{broken}\n\`\`\``)
      .error.code,
    "invalid_json",
  );
  assert.equal(
    parseResultEnvelope(
      `${valid}\n\`\`\`nelos-result\n${"x".repeat(8_193)}\n\`\`\``,
    ).error.code,
    "envelope_too_large",
  );
});

test("final result selection prefers the last final-answer message", () => {
  assert.equal(
    finalAgentMessage({
      items: [
        { type: "agentMessage", phase: "final_answer", text: "first" },
        { type: "agentMessage", phase: "commentary", text: "progress" },
        { type: "agentMessage", phase: "final_answer", text: "last" },
      ],
    }),
    "last",
  );
  assert.equal(
    finalAgentMessage({
      items: [
        { type: "agentMessage", phase: null, text: "legacy final" },
        { type: "agentMessage", phase: "commentary", text: "PRIVATE_COMMENTARY" },
      ],
    }),
    "legacy final",
  );
  assert.equal(
    finalAgentMessage({
      items: [
        { type: "agentMessage", phase: "commentary", text: "PRIVATE_COMMENTARY" },
      ],
    }),
    null,
  );
});

test("work classification keeps lifecycle, outcome, and attention separate", () => {
  const succeeded = classifyWorkResult({
    latestTurn: completedTurn("turn-a", envelope()),
  });
  assert.equal(succeeded.transportStatus, "completed");
  assert.equal(succeeded.workOutcome, "succeeded");
  assert.equal(succeeded.attentionRequired, false);

  const blocked = classifyWorkResult({
    latestTurn: completedTurn(
      "turn-b",
      envelope({
        outcome: "blocked",
        summary: "B_BLOCKED",
        blockers: ["missing input"],
        recoveryHint: "provide input",
      }),
    ),
  });
  assert.equal(blocked.transportStatus, "completed");
  assert.equal(blocked.workOutcome, "blocked");
  assert.equal(blocked.attentionReason, "blocked");

  const workFailed = classifyWorkResult({
    latestTurn: completedTurn(
      "turn-work-failed",
      envelope({
        outcome: "failed",
        summary: "The requested verification failed.",
        blockers: ["fixture assertion failed"],
        recoveryHint: "Inspect the fixture mismatch.",
      }),
    ),
  });
  assert.equal(workFailed.transportStatus, "completed");
  assert.equal(workFailed.workOutcome, "failed");
  assert.equal(workFailed.attentionReason, "failed");

  const cases = [
    {
      input: { latestTurn: null },
      expected: ["waiting", "unknown", "pending", false],
    },
    {
      input: {
        latestTurn: {
          id: "running",
          status: { type: "inProgress" },
          items: [
            {
              type: "agentMessage",
              phase: "final_answer",
              text: formatResultEnvelope(envelope()),
            },
          ],
        },
      },
      expected: ["running", "unknown", "running", false],
    },
    {
      input: {
        latestTurn: {
          id: "failed",
          status: "cancelled",
          items: [
            {
              type: "agentMessage",
              phase: "final_answer",
              text: formatResultEnvelope(envelope()),
            },
          ],
        },
      },
      expected: ["failed", "unknown", "turn_failed", true],
    },
    {
      input: { latestTurn: { id: "waiting", status: "waiting", items: [] } },
      expected: ["waiting", "unknown", "pending", false],
    },
    {
      input: {
        latestTurn: {
          id: "future",
          status: "pausedByServer",
          items: [
            {
              type: "agentMessage",
              phase: "final_answer",
              text: formatResultEnvelope(envelope()),
            },
          ],
        },
      },
      expected: ["unknown", "unknown", "unknown_lifecycle", true],
    },
    {
      input: { latestTurn: { id: "missing", status: "completed", items: [] } },
      expected: ["completed", "unknown", "missing", true],
    },
    {
      input: {
        latestTurn: {
          id: "malformed",
          status: "completed",
          items: [
            {
              type: "agentMessage",
              phase: "final_answer",
              text: "```nelos-result\n{}\n```",
            },
          ],
        },
      },
      expected: ["completed", "unknown", "malformed", true],
    },
    {
      input: { available: false },
      expected: ["unavailable", "unknown", "unavailable", true],
    },
  ];
  for (const { input, expected } of cases) {
    const classified = classifyWorkResult(input);
    assert.deepEqual(
      [
        classified.transportStatus,
        classified.workOutcome,
        classified.resultState,
        classified.attentionRequired,
      ],
      expected,
    );
  }
});

test("web collection returns one current bounded result per direct active member", async () => {
  const records = [
    {
      threadId: "queen",
      baseTitle: "Queen",
      renderedTitle: "👑 A1 · Queen",
      outboundWebId: "A1",
      archivedAt: null,
    },
    {
      threadId: "member-b",
      baseTitle: "B member",
      renderedTitle: "🕷️ A1 · B member",
      inboundWebId: "A1",
      outboundWebId: null,
      queenThreadId: "queen",
      archivedAt: null,
    },
    {
      threadId: "member-a",
      baseTitle: "A member",
      renderedTitle: "👑 A1.1 🕷️ A1 · A member",
      inboundWebId: "A1",
      outboundWebId: "A1.1",
      queenThreadId: "queen",
      archivedAt: null,
    },
    {
      threadId: "nested",
      baseTitle: "Nested",
      inboundWebId: "A1.1",
      queenThreadId: "member-a",
      archivedAt: null,
    },
    {
      threadId: "archived",
      baseTitle: "Archived",
      inboundWebId: "A1",
      queenThreadId: "queen",
      archivedAt: "2026-07-18T00:00:00.000Z",
    },
  ];
  const blockedTurn = completedTurn(
    "turn-b1",
    envelope({
      workUnitId: "b",
      outcome: "blocked",
      summary: "B_BLOCKED",
      blockers: ["missing fixture mode"],
      recoveryHint: "provide fixture mode",
    }),
    [{ type: "agentMessage", phase: "commentary", text: "PRIVATE_COMMENTARY" }],
  );
  const turns = new Map([
    [
      "member-a",
      [completedTurn("turn-a", envelope({ workUnitId: "a", summary: "A_RESULT" }))],
    ],
    ["member-b", [blockedTurn]],
  ]);
  const now = () => new Date("2026-07-18T20:00:00.000Z");
  const collect = () =>
    collectWebResults({
      records,
      queenThreadId: "queen",
      now,
      loadMember: async (threadId) => ({
        thread: { id: threadId, name: `live ${threadId}` },
        turns: turns.get(threadId),
      }),
    });

  const initial = await collect();
  assert.deepEqual(
    initial.members.map((member) => member.threadId),
    ["member-a", "member-b"],
  );
  assert.equal(initial.members[0].role, "member-queen");
  assert.equal(initial.members[1].workOutcome, "blocked");
  assert.equal(initial.members[1].latestTurnId, "turn-b1");
  assert.equal(initial.members[1].sourceTurnId, "turn-b1");
  assert.deepEqual(initial.summary, {
    total: 2,
    unknown: 0,
    succeeded: 1,
    blocked: 1,
    failed: 0,
    attention: 1,
  });
  assert.equal(initial.allSucceeded, false);
  assert.doesNotMatch(JSON.stringify(initial), /PRIVATE_PROMPT|PRIVATE_COMMENTARY|items/);

  const correctingTurn = {
    id: "turn-b2",
    status: "inProgress",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "PRIVATE_RETRY" }] },
      {
        type: "agentMessage",
        phase: "final_answer",
        text: formatResultEnvelope(
          envelope({ workUnitId: "b", attempt: 2, summary: "NOT_TERMINAL" }),
        ),
      },
    ],
  };
  turns.set("member-b", [correctingTurn, blockedTurn]);
  const correcting = await collect();
  assert.equal(correcting.members[1].transportStatus, "running");
  assert.equal(correcting.members[1].workOutcome, "blocked");
  assert.equal(correcting.members[1].resultState, "valid");
  assert.equal(correcting.members[1].latestTurnId, "turn-b2");
  assert.equal(correcting.members[1].sourceTurnId, "turn-b1");
  assert.equal(correcting.members[1].result.summary, "B_BLOCKED");
  assert.equal(correcting.members[1].attentionRequired, false);
  assert.equal(correcting.members[1].attentionReason, null);
  assert.deepEqual(correcting.summary, {
    total: 2,
    unknown: 0,
    succeeded: 1,
    blocked: 1,
    failed: 0,
    attention: 0,
  });
  assert.equal(correcting.allSucceeded, false);
  assert.doesNotMatch(JSON.stringify(correcting), /PRIVATE_RETRY|NOT_TERMINAL/);

  turns.set("member-b", [correctingTurn]);
  const correctingWithoutPriorResult = await collect();
  assert.equal(correctingWithoutPriorResult.members[1].transportStatus, "running");
  assert.equal(correctingWithoutPriorResult.members[1].workOutcome, "unknown");
  assert.equal(correctingWithoutPriorResult.members[1].resultState, "running");
  assert.equal(correctingWithoutPriorResult.members[1].latestTurnId, "turn-b2");
  assert.equal(correctingWithoutPriorResult.members[1].sourceTurnId, null);
  assert.equal(correctingWithoutPriorResult.members[1].result, null);
  assert.equal(correctingWithoutPriorResult.members[1].attentionRequired, false);

  const recoveredTurn = completedTurn(
    "turn-b2",
    envelope({ workUnitId: "b", attempt: 2, summary: "B_RESULT" }),
  );
  turns.set("member-b", [recoveredTurn, blockedTurn]);
  const recovered = await collect();
  assert.equal(recovered.members[1].threadId, "member-b");
  assert.equal(recovered.members[1].latestTurnId, "turn-b2");
  assert.equal(recovered.members[1].sourceTurnId, "turn-b2");
  assert.equal(recovered.members[1].result.attempt, 2);
  assert.equal(recovered.members[1].result.summary, "B_RESULT");
  assert.equal(recovered.allSucceeded, true);
  assert.equal(JSON.stringify(recovered).includes("B_BLOCKED"), false);
  assert.deepEqual(await collect(), recovered);

  turns.set("member-b", [
    {
      id: "turn-b3",
      status: "failed",
      items: [
        {
          type: "agentMessage",
          phase: "final_answer",
          text: "PRIVATE_FAILED_TURN_OUTPUT",
        },
      ],
    },
    recoveredTurn,
  ]);
  const failedAfterSuccess = await collect();
  assert.equal(failedAfterSuccess.members[1].transportStatus, "failed");
  assert.equal(failedAfterSuccess.members[1].workOutcome, "unknown");
  assert.equal(failedAfterSuccess.members[1].resultState, "turn_failed");
  assert.equal(failedAfterSuccess.members[1].latestTurnId, "turn-b3");
  assert.equal(failedAfterSuccess.members[1].sourceTurnId, null);
  assert.equal(failedAfterSuccess.members[1].result, null);
  assert.equal(failedAfterSuccess.members[1].attentionRequired, true);
  assert.equal(failedAfterSuccess.members[1].attentionReason, "turn_failed");
  assert.equal(failedAfterSuccess.allSucceeded, false);
  assert.doesNotMatch(
    JSON.stringify(failedAfterSuccess.members[1]),
    /B_RESULT|PRIVATE_FAILED_TURN_OUTPUT/,
  );
});

test("web collection keeps unavailable members visible and unknown", async () => {
  const result = await collectWebResults({
    records: [
      { threadId: "queen", outboundWebId: "A1", archivedAt: null },
      {
        threadId: "member",
        baseTitle: "Member",
        inboundWebId: "A1",
        queenThreadId: "queen",
        archivedAt: null,
      },
    ],
    webId: "A1",
    loadMember: async () => {
      throw new Error("private raw transport error");
    },
  });
  assert.equal(result.members[0].transportStatus, "unavailable");
  assert.equal(result.members[0].workOutcome, "unknown");
  assert.equal(result.members[0].attentionRequired, true);
  assert.doesNotMatch(JSON.stringify(result), /private raw transport error/);
});

test("web timeout checkpoints preserve bounded valid evidence in member order", async () => {
  const records = [
    { threadId: "queen", outboundWebId: "A1", archivedAt: null },
    {
      threadId: "member-b",
      baseTitle: "B member",
      inboundWebId: "A1",
      queenThreadId: "queen",
      archivedAt: null,
    },
    {
      threadId: "member-a",
      baseTitle: "A member",
      inboundWebId: "A1",
      queenThreadId: "queen",
      archivedAt: null,
    },
  ];
  const priorTurns = new Map([
    [
      "member-a",
      [
        { id: "turn-a2", status: "inProgress", items: [] },
        completedTurn(
          "turn-a1",
          envelope({
            workUnitId: "work-a",
            outcome: "blocked",
            summary: "A_BLOCKED",
            blockers: ["dependency pending"],
            recoveryHint: "wait for dependency",
          }),
        ),
      ],
    ],
    [
      "member-b",
      [completedTurn("turn-b1", envelope({ workUnitId: "work-b" }))],
    ],
  ]);
  const previousCollection = await collectWebResults({
    records,
    webId: "A1",
    loadMember: async (threadId) => ({
      thread: { id: threadId, name: threadId },
      turns: priorTurns.get(threadId),
    }),
  });
  const interruptedCollection = await collectWebResults({
    records,
    webId: "A1",
    loadMember: async () => {
      throw new Error("PRIVATE_DEADLINE_TRANSPORT_ERROR");
    },
  });
  const accumulatedCollection = preserveWebCollectionEvidence({
    collection: interruptedCollection,
    previousCollection,
  });

  const checkpoint = timeoutWebCollection({
    collection: interruptedCollection,
    previousCollection: accumulatedCollection,
    maxWaitMs: 45_000,
    elapsedMs: 45_003,
  });

  assert.deepEqual(
    checkpoint.members.map(({ threadId }) => threadId),
    ["member-a", "member-b"],
  );
  assert.deepEqual(
    checkpoint.wait.nonterminalMembers.map(({ threadId, workUnitId }) => ({
      threadId,
      workUnitId,
    })),
    [{ threadId: "member-a", workUnitId: "work-a" }],
  );
  assert.equal(checkpoint.wait.status, "timed_out");
  assert.equal(checkpoint.wait.settled, false);
  assert.equal(checkpoint.wait.maxWaitMs, 45_000);
  assert.equal(checkpoint.wait.elapsedMs, 45_003);
  assert.equal(checkpoint.wait.mayStillBeRunning, true);
  assert.equal(checkpoint.wait.nonterminalCount, 1);
  assert.equal(checkpoint.members[0].transportStatus, "running");
  assert.equal(checkpoint.members[0].workOutcome, "blocked");
  assert.equal(checkpoint.members[0].result.summary, "A_BLOCKED");
  assert.equal(checkpoint.members[0].latestTurnId, "turn-a2");
  assert.equal(checkpoint.members[0].sourceTurnId, "turn-a1");
  assert.equal(checkpoint.members[1].workOutcome, "succeeded");
  assert.deepEqual(checkpoint.summary, {
    total: 2,
    unknown: 0,
    succeeded: 1,
    blocked: 1,
    failed: 0,
    attention: 0,
  });
  assert.equal(checkpoint.allSucceeded, false);
  assert.doesNotMatch(JSON.stringify(checkpoint), /PRIVATE_/);
});

test("web collection roots duplicate compact IDs to the requested queen", async () => {
  const records = [
    {
      threadId: "old-queen",
      baseTitle: "Old queen",
      outboundWebId: "A1",
      archivedAt: null,
    },
    {
      threadId: "old-member",
      baseTitle: "Old member",
      inboundWebId: "A1",
      queenThreadId: "old-queen",
      archivedAt: null,
    },
    {
      threadId: "fresh-queen",
      baseTitle: "Fresh queen",
      outboundWebId: "A1",
      archivedAt: null,
    },
    {
      threadId: "fresh-member",
      baseTitle: "Fresh member",
      inboundWebId: "A1",
      queenThreadId: "fresh-queen",
      archivedAt: null,
    },
    {
      threadId: "ambiguous-legacy-member",
      baseTitle: "Legacy member",
      inboundWebId: "A1",
      queenThreadId: null,
      archivedAt: null,
    },
  ];
  const loaded = [];
  const result = await collectWebResults({
    records,
    queenThreadId: "fresh-queen",
    loadMember: async (threadId) => {
      loaded.push(threadId);
      return {
        thread: { id: threadId, name: threadId },
        turns: [
          completedTurn(
            `turn-${threadId}`,
            envelope({ workUnitId: "fresh-work" }),
          ),
        ],
      };
    },
  });

  assert.equal(result.queenThreadId, "fresh-queen");
  assert.deepEqual(result.members.map(({ threadId }) => threadId), [
    "fresh-member",
  ]);
  assert.deepEqual(loaded, ["fresh-member"]);
  await assert.rejects(
    collectWebResults({
      records,
      webId: "A1",
      loadMember: async () => {
        throw new Error("must not load ambiguous members");
      },
    }),
    /multiple active queens found for web A1/,
  );
});

test("web collection fails closed on untrustworthy turn identities", async () => {
  const records = [
    { threadId: "queen", outboundWebId: "A1", archivedAt: null },
    {
      threadId: "member",
      inboundWebId: "A1",
      queenThreadId: "queen",
      archivedAt: null,
    },
  ];
  const runningTurn = (id = "turn-current") => ({
    id,
    status: "inProgress",
    items: [],
  });
  const withoutId = (turn) => {
    const copy = { ...turn };
    delete copy.id;
    return copy;
  };
  const cases = [
    ["missing latest ID", [withoutId(completedTurn("unused", envelope()))]],
    ["invalid latest ID", [completedTurn("bad\u0000id", envelope())]],
    [
      "missing source ID",
      [runningTurn(), withoutId(completedTurn("unused", envelope()))],
    ],
    [
      "invalid source ID",
      [runningTurn(), completedTurn("bad\u0000id", envelope())],
    ],
    [
      "duplicate latest and source IDs",
      [runningTurn("turn-duplicate"), completedTurn("turn-duplicate", envelope())],
    ],
  ];

  for (const [name, turns] of cases) {
    const result = await collectWebResults({
      records,
      queenThreadId: "queen",
      loadMember: async () => ({ turns }),
    });
    assert.equal(result.members[0].transportStatus, "unavailable", name);
    assert.equal(result.members[0].workOutcome, "unknown", name);
    assert.equal(result.members[0].attentionRequired, true, name);
    assert.equal(result.members[0].latestTurnId, null, name);
    assert.equal(result.members[0].sourceTurnId, null, name);
    assert.equal(result.allSucceeded, false, name);
  }
});

test("web collection rejects oversized or inconsistent webs before member reads", async () => {
  let loads = 0;
  const queen = {
    threadId: "queen",
    baseTitle: "Queen",
    outboundWebId: "A1",
    archivedAt: null,
  };
  const member = (index, overrides = {}) => ({
    threadId: `member-${index}`,
    baseTitle: `Member ${String(index).padStart(3, "0")}`,
    inboundWebId: "A1",
    queenThreadId: "queen",
    archivedAt: null,
    ...overrides,
  });
  await assert.rejects(
    collectWebResults({
      records: [queen, ...Array.from({ length: 101 }, (_, index) => member(index))],
      queenThreadId: "queen",
      loadMember: async () => {
        loads += 1;
      },
    }),
    /100-member collection limit/,
  );
  assert.equal(loads, 0);

  await assert.rejects(
    collectWebResults({
      records: [queen, member(1, { queenThreadId: "different-queen" })],
      queenThreadId: "queen",
      loadMember: async () => {
        loads += 1;
      },
    }),
    /does not belong to queen/,
  );
  assert.equal(loads, 0);
});

test("web collection bounds metadata and concurrent member reads", async () => {
  let activeLoads = 0;
  let maximumLoads = 0;
  const records = [
    { threadId: "queen", outboundWebId: "A1", archivedAt: null },
    ...Array.from({ length: 12 }, (_, index) => ({
      threadId: `member-${index}`,
      baseTitle: `Member ${String(index).padStart(2, "0")} ${"x".repeat(600)}`,
      inboundWebId: "A1",
      queenThreadId: "queen",
      archivedAt: null,
    })),
  ];
  const result = await collectWebResults({
    records,
    queenThreadId: "queen",
    loadMember: async (threadId) => {
      activeLoads += 1;
      maximumLoads = Math.max(maximumLoads, activeLoads);
      await new Promise((resolve) => setImmediate(resolve));
      activeLoads -= 1;
      return {
        thread: { id: threadId, name: `live\u0000 ${"y".repeat(600)}` },
        turns: [completedTurn(`turn-${threadId}`, envelope({ workUnitId: threadId }))],
      };
    },
  });
  assert.equal(maximumLoads, 8);
  assert.equal(result.members.length, 12);
  assert.ok(result.members.every(({ title, baseTitle }) => title.length <= 512 && baseTitle.length <= 512));
  assert.doesNotMatch(JSON.stringify(result), /\u0000/);
});
