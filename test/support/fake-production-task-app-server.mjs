#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";

if (process.argv.length > 2) {
  const statePath = process.env.NELOS_FAKE_PRODUCTION_TASK_STATE;
  if (!statePath || process.argv[2] !== "app-server" || process.argv[3] !== "--stdio") {
    process.stderr.write("fake production task app-server requires its sealed test state\n");
    process.exit(2);
  }

async function readState() { return JSON.parse(await readFile(statePath, "utf8")); }
async function writeState(value) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, statePath);
}
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

let buffer = "";
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { queue = queue.then(() => consume(chunk)); });

async function consume(chunk) {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    try {
      const state = await readState();
      state.methods.push(message.method);
      if (message.method === "initialize") {
        await writeState(state);
        send({ id: message.id, result: state.initialize });
        continue;
      }
      if (message.method === "thread/start") {
        const expected = {
          cwd: state.expectedCwd, approvalPolicy: "never", ephemeral: false,
          serviceName: "nelos", threadSource: "nelos-cli", sandbox: "read-only",
        };
        if (JSON.stringify(message.params) !== JSON.stringify(expected)) throw new Error("unexpected start parameters");
        state.startCalls += 1;
        const id = `01a01fff-0000-7000-8000-${String(state.startCalls).padStart(12, "0")}`;
        const thread = {
          id, name: null, createdAt: 1_786_000_000 + state.startCalls, updatedAt: 1_786_000_000 + state.startCalls,
          cwd: state.expectedCwd, status: { type: "notLoaded" }, turns: [],
        };
        state.threads[id] = thread;
        await writeState(state);
        if (state.mode === "ambiguous-start") process.exit(70);
        send({ id: message.id, result: { thread } });
        continue;
      }
      if (message.method === "thread/read") {
        const thread = state.threads[message.params.threadId];
        if (!thread || message.params.includeTurns !== false) throw new Error("unknown task");
        await writeState(state);
        send({ id: message.id, result: { thread } });
        continue;
      }
      if (message.method === "thread/name/set") {
        const thread = state.threads[message.params.threadId];
        if (!thread || typeof message.params.name !== "string") throw new Error("unknown task");
        thread.name = message.params.name; thread.updatedAt += 1;
        await writeState(state);
        send({ id: message.id, result: {} });
        continue;
      }
      if (message.method === "thread/turns/list") {
        const thread = state.threads[message.params.threadId];
        if (!thread || message.params.limit !== 1) throw new Error("unknown task");
        await writeState(state);
        send({ id: message.id, result: { data: thread.turns, nextCursor: null } });
        continue;
      }
      if (message.method === "thread/list") {
        if (message.params.limit !== 100 || message.params.sortKey !== "updated_at" || message.params.sortDirection !== "desc" ||
            !Array.isArray(message.params.sourceKinds) || typeof message.params.archived !== "boolean" || message.params.useStateDbOnly !== true) throw new Error("unexpected inventory parameters");
        const data = message.params.archived ? [] : Object.values(state.threads).sort((left, right) => right.updatedAt - left.updatedAt);
        await writeState(state);
        send({ id: message.id, result: { data, nextCursor: null } });
        continue;
      }
      if (message.method === "account/read") {
        if (message.params.refreshToken !== false || typeof state.accountEmail !== "string") throw new Error("unexpected account parameters");
        await writeState(state);
        send({ id: message.id, result: { account: { email: state.accountEmail, planType: "pro", type: "chatgpt" }, requiresOpenaiAuth: true } });
        continue;
      }
      throw new Error("unsupported method");
    } catch {
      send({ id: message.id, error: { code: -32603, message: "fake app-server request failed" } });
    }
  }
}
}
