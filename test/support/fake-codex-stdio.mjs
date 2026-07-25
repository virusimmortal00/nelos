#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";

const statePath = process.env.NELOS_FAKE_APP_STATE;
if (statePath && (process.argv[2] !== "app-server" || process.argv[3] !== "--stdio")) {
  process.stderr.write("fake codex requires app-server --stdio and NELOS_FAKE_APP_STATE\n");
  process.exit(2);
}

if (statePath) {
async function state() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function writeState(value) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, statePath);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined || message.id === null) continue;
    try {
      if (message.method === "initialize") {
        send({
          id: message.id,
          result: {
            codexHome: process.env.CODEX_HOME,
            platformFamily: "unix",
            platformOs: "macos",
            userAgent: "codex-cli/0.144.6",
          },
        });
        continue;
      }
      if (message.method === "thread/read") {
        const current = await state();
        const thread = current.threads[message.params.threadId];
        if (!thread) throw new Error("unknown thread");
        send({ id: message.id, result: { thread } });
        continue;
      }
      if (message.method === "thread/name/set") {
        const current = await state();
        const thread = current.threads[message.params.threadId];
        if (!thread) throw new Error("unknown thread");
        thread.name = message.params.name;
        thread.updatedAt += 1;
        await writeState(current);
        send({ id: message.id, result: {} });
        continue;
      }
      send({
        id: message.id,
        error: { code: -32601, message: "method not found" },
      });
    } catch {
      send({
        id: message.id,
        error: { code: -32603, message: "fixture request failed" },
      });
    }
  }
});
}
