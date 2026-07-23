import { parseWebTitle } from "../../src/task-web.mjs";
import { formatResultEnvelope } from "../../src/work-result.mjs";
import { startMockAppServer } from "./mock-app-server.mjs";

const MEMBER_KEYS = new Map([
  ["A member", "a"],
  ["B member", "b"],
  ["C member", "c"],
]);

function mockThread(id, name, cwd) {
  return {
    id,
    sessionId: `session-${id}`,
    name,
    preview: "",
    status: { type: "idle" },
    cwd,
    source: "appServer",
    threadSource: id === "queen-thread" ? "appServer" : "nelos-cli",
    createdAt: 1,
    updatedAt: 2,
  };
}

function resultFor(memberKey, attempt, prompt) {
  const common = {
    schemaVersion: 1,
    workUnitId: `golden-${memberKey}`,
    specRevision: 1,
    attempt,
    artifacts: [],
    verification: ["scripted app-server fixture"],
    blockers: [],
    recoveryHint: null,
  };
  if (memberKey === "a") {
    return { ...common, outcome: "succeeded", summary: "A_RESULT" };
  }
  if (memberKey === "c") {
    return { ...common, outcome: "succeeded", summary: "C_RESULT" };
  }
  if (attempt === 1 || !prompt.includes("fixtureMode=scripted-no-model")) {
    return {
      ...common,
      outcome: "blocked",
      summary: "B_BLOCKED",
      blockers: ["fixtureMode is missing"],
      recoveryHint: "Provide fixtureMode=scripted-no-model",
    };
  }
  return { ...common, outcome: "succeeded", summary: "B_RESULT" };
}

function turnItems(memberKey, attempt, prompt) {
  const result = resultFor(memberKey, attempt, prompt);
  return [
    {
      type: "userMessage",
      content: [
        {
          type: "text",
          text: `PRIVATE_USER_${memberKey.toUpperCase()}_${attempt}: ${prompt}`,
        },
      ],
    },
    {
      type: "agentMessage",
      phase: "commentary",
      text: `PRIVATE_COMMENTARY_${memberKey.toUpperCase()}_${attempt}`,
    },
    {
      type: "agentMessage",
      phase: "final_answer",
      text: `Current bounded result:\n${formatResultEnvelope(result)}`,
    },
  ];
}

function publicTurn(turn, itemsView) {
  return {
    id: turn.id,
    status: turn.status,
    startedAt: 10,
    completedAt: turn.status === "completed" ? 11 : null,
    durationMs: turn.status === "completed" ? 1_000 : null,
    error: null,
    ...(itemsView === "full" ? { items: turn.items } : {}),
  };
}

export async function startGoldenLoopAppServer(socketPath, { cwd = process.cwd() } = {}) {
  const threads = new Map([
    ["queen-thread", mockThread("queen-thread", "Golden loop queen", cwd)],
  ]);
  const turns = new Map();
  const memberKeys = new Map();
  let nextMember = 1;

  const server = await startMockAppServer(
    socketPath,
    async ({ method, params }) => {
      if (method === "initialize") return {};
      if (method === "thread/start") {
        const threadId = `member-${nextMember}`;
        nextMember += 1;
        const thread = mockThread(threadId, null, params.cwd);
        threads.set(threadId, thread);
        turns.set(threadId, []);
        return { thread };
      }
      if (method === "thread/name/set") {
        const thread = threads.get(params.threadId);
        if (!thread) throw new Error(`unknown thread: ${params.threadId}`);
        thread.name = params.name;
        const memberKey = MEMBER_KEYS.get(parseWebTitle(params.name).baseTitle);
        if (memberKey) memberKeys.set(params.threadId, memberKey);
        return {};
      }
      if (method === "thread/read") {
        const thread = threads.get(params.threadId);
        if (!thread) return { thread: null };
        return {
          thread: {
            ...thread,
            ...(params.includeTurns
              ? {
                  turns: (turns.get(params.threadId) || []).map((turn) =>
                    publicTurn(turn, "full"),
                  ),
                }
              : {}),
          },
        };
      }
      if (method === "turn/start") {
        const memberKey = memberKeys.get(params.threadId);
        if (!memberKey) throw new Error(`turn started for non-member: ${params.threadId}`);
        const history = turns.get(params.threadId) || [];
        const attempt = history.length + 1;
        const prompt = params.input
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        const turn = {
          id: `turn-${params.threadId}-${attempt}`,
          status: "inProgress",
          observationPolls: 0,
          items: turnItems(memberKey, attempt, prompt),
        };
        history.unshift(turn);
        turns.set(params.threadId, history);
        return { turn: publicTurn(turn, "summary") };
      }
      if (method === "thread/turns/list") {
        const history = turns.get(params.threadId) || [];
        const latest = history[0];
        if (latest?.status === "inProgress") {
          latest.observationPolls += 1;
          if (latest.observationPolls >= 3) latest.status = "completed";
        }
        return {
          data: history
            .slice(0, params.limit)
            .map((turn) => publicTurn(turn, params.itemsView)),
        };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  );

  return {
    ...server,
    threads,
    turns,
    memberKeys,
  };
}
