import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serveExecutorApprovalUiV1 } from "../src/executor-approval-channel.mjs";
import { ExecutorServiceClientV1 } from "../src/executor-service-channel.mjs";
import { ExecutorApprovalRelayV1 } from "../src/executor-approval-relay.mjs";

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "na-")));
  let owned = true;
  const relay = new ExecutorApprovalRelayV1({ ownsTurn: async () => owned, timeoutMs: 2000 });
  const endpoint = await serveExecutorApprovalUiV1({ directory, service: { attachApprovalChannel: (channel) => relay.attachChannel(channel) } });
  const clients = [];
  const connect = async () => { const c = await ExecutorServiceClientV1.connect(endpoint.descriptorPath); clients.push(c); await c.request("poll"); return c; };
  t.after(async () => { clients.forEach((c) => c.close()); relay.close(); await endpoint.close(); await rm(directory, { recursive: true, force: true }); });
  return { connect, relay, expire: () => { owned = false; },
    request: () => relay.handle({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "item", command: "git status", availableDecisions: ["accept", "decline", "cancel"] }, signal: new AbortController().signal }) };
}
async function pending(client) {
  for (let i = 0; i < 100; i++) { const value = (await client.request("poll")).request; if (value) return value; await delay(5); }
  throw new Error("no pending approval");
}

test("private UI answers one exact live request; stale tokens and unoffered persistent approvals cannot grant access", async (t) => {
  const f = await fixture(t), client = await f.connect();
  for (const decision of ["accept", "decline", "acceptForSession"]) {
    const result = f.request(), request = await pending(client);
    assert.equal((await client.request("answer", { requestToken: "old", response: { decision: "accept" } })).state, "not-pending");
    await client.request("answer", { requestToken: request.requestToken, response: { decision } });
    assert.deepEqual(await result, { decision: decision === "acceptForSession" ? "cancel" : decision });
    assert.equal((await client.request("answer", { requestToken: request.requestToken, response: { decision: "accept" } })).state, "not-pending");
  }
  const result = f.request(), request = await pending(client); f.expire();
  await client.request("answer", { requestToken: request.requestToken, response: { decision: "accept" } });
  assert.deepEqual(await result, { decision: "cancel" });
});

test("UI disconnect cancels pending approval, permits reconnection, and never leaves the request grantable", async (t) => {
  const f = await fixture(t), client = await f.connect();
  const result = f.request(), request = await pending(client); client.close();
  assert.deepEqual(await result, { decision: "cancel" });
  const fresh = await f.connect();
  assert.equal((await fresh.request("poll")).request, null);
  assert.equal((await fresh.request("answer", { requestToken: request.requestToken, response: { decision: "accept" } })).state, "not-pending");
  assert.equal(f.relay.status().pending, 0);
});
