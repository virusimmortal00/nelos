#!/usr/bin/env node

import { startMockAppServer } from "../../test/support/mock-app-server.mjs";

const listenIndex = process.argv.indexOf("--listen");
const listenUrl = listenIndex === -1 ? null : process.argv[listenIndex + 1];
if (process.argv[2] !== "app-server" || !listenUrl?.startsWith("unix://")) {
  process.stderr.write("expected: app-server --listen unix://PATH\n");
  process.exit(64);
}

const socketPath = listenUrl.slice("unix://".length);
const server = await startMockAppServer(socketPath, async ({ method }) => {
  if (method === "initialize") return {};
  throw new Error(`unexpected method: ${method}`);
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.close().catch(() => {});
  process.exit(0);
};

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
