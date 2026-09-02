import { randomUUID } from "node:crypto";
import { ExecutorAppServerSessionV1 } from "../../src/executor-app-server-session.mjs";
import { ExecutorAppServerEffectsV1 } from "../../src/executor-app-server-effects.mjs";
import { executorWave } from "./executor-fixture.mjs";
import { mockStdioAppServer } from "./mock-stdio-app-server.mjs";

export async function executorAppServerFixture(t, { overrides = {}, validateTarget = async () => true, dispatcherOptions = {} } = {}) {
  const wave = executorWave();
  const member = wave.members[0];
  const state = { name: null, turns: [] };
  const handlers = {
    initialize: () => ({ userAgent: "codex-cli/0.152.0", codexHome: "/codex", platformFamily: "unix", platformOs: "linux" }),
    "thread/start": ({ params }) => ({ thread: { id: "owned-task", cwd: params.cwd }, model: params.model,
      cwd: params.cwd, approvalPolicy: params.approvalPolicy, activePermissionProfile: { id: params.permissions } }),
    "thread/name/set": ({ params }) => { state.name = params.name; return {}; },
    "thread/read": () => ({ thread: { id: "owned-task", name: state.name, turns: state.turns } }),
    "turn/start": () => ({ turn: { id: "owned-turn", status: "inProgress", items: [] } }),
    "turn/interrupt": () => ({}),
    ...overrides,
  };
  const server = mockStdioAppServer((message, wire) => {
    if (!handlers[message.method]) throw new Error("Unexpected fixture method");
    return handlers[message.method](message, wire);
  });
  const session = new ExecutorAppServerSessionV1({ command: "/bin/codex", cwd: "/workspace", codexHome: "/codex",
    spawnProcess: server.spawnProcess, dispatcherOptions });
  t.after(() => session.close());
  const effects = new ExecutorAppServerEffectsV1({ session, validateTarget });
  await session.open();
  const operationId = `launch:${randomUUID()}`;
  const create = () => effects.createThread({ member, operationId });
  const title = () => effects.setTitle({ threadId: "owned-task", title: member.title });
  const start = () => effects.startTurn({ member, threadId: "owned-task", prompt: "Implement the requested change.",
    clientUserMessageId: `nelos:${operationId}` });
  return { session, effects, state, server, wave, member, operationId, create, title, start };
}
